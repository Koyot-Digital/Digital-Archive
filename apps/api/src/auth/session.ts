import { and, eq, gt, lt } from "drizzle-orm";
import { db } from "../db/client.js";
import { sessions, users, type DbUser } from "../db/schema.js";
import { config } from "../config.js";
import { randomToken, sha256, sign, unsign } from "../lib/crypto.js";
import { newId, type UserRole } from "@archive/shared";

export const SESSION_COOKIE = "archive_session";
export const STATE_COOKIE = "archive_oauth_state";

/** Fixed identity used while AUTH_ENABLED=false so audit rows still FK. */
export const DEV_USER_ID = "dev0000000000000";

export interface SessionUser {
  id: string;
  discordId: string;
  username: string;
  globalName: string | null;
  avatar: string | null;
  role: UserRole;
}

function toSessionUser(row: DbUser): SessionUser {
  return {
    id: row.id,
    discordId: row.discordId,
    username: row.username,
    globalName: row.globalName,
    avatar: row.avatar,
    role: row.role,
  };
}

export const cookieOptions = (maxAgeSeconds: number) =>
  ({
    httpOnly: true,
    secure: config.isProd,
    sameSite: "lax" as const,
    path: "/",
    domain: config.cookieDomain,
    maxAge: maxAgeSeconds,
  }) as const;

/**
 * Issue a session.
 *
 * The raw token is returned to the caller for the cookie and never stored;
 * only its SHA-256 lands in Postgres, so a database dump cannot be replayed
 * as a login.
 */
export async function createSession(
  userId: string,
  meta: { ip?: string | undefined; userAgent?: string | undefined },
): Promise<{ cookieValue: string; expiresAt: Date; maxAge: number }> {
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + config.SESSION_TTL_DAYS * 86_400_000);

  await db.insert(sessions).values({
    tokenHash: sha256(token),
    userId,
    expiresAt,
    ip: meta.ip ?? null,
    userAgent: meta.userAgent?.slice(0, 512) ?? null,
  });

  return {
    cookieValue: sign(token),
    expiresAt,
    maxAge: config.SESSION_TTL_DAYS * 86_400,
  };
}

/** Resolve a cookie value to its user, or null for anything invalid. */
export async function resolveSession(cookieValue: string | undefined): Promise<SessionUser | null> {
  if (!cookieValue) return null;
  const token = unsign(cookieValue);
  if (!token) return null;

  const hash = sha256(token);
  const rows = await db
    .select({ user: users, expiresAt: sessions.expiresAt })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, hash), gt(sessions.expiresAt, new Date())))
    .limit(1);

  const row = rows[0];
  if (!row || row.user.disabled) return null;

  // Touch last_seen_at without blocking the request.
  void db
    .update(sessions)
    .set({ lastSeenAt: new Date() })
    .where(eq(sessions.tokenHash, hash))
    .catch(() => {});

  return toSessionUser(row.user);
}

export async function destroySession(cookieValue: string | undefined): Promise<void> {
  if (!cookieValue) return;
  const token = unsign(cookieValue);
  if (!token) return;
  await db.delete(sessions).where(eq(sessions.tokenHash, sha256(token)));
}

export async function destroyAllSessionsFor(userId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.userId, userId));
}

export async function pruneExpiredSessions(): Promise<number> {
  const removed = await db
    .delete(sessions)
    .where(lt(sessions.expiresAt, new Date()))
    .returning({ tokenHash: sessions.tokenHash });
  return removed.length;
}

/**
 * Role for a freshly authenticated Discord account.
 *
 * Driven entirely by env allowlists: there is no in-app path to grant
 * yourself privileges, which is the point - the archive is public to read and
 * closed to write.
 */
export function roleForDiscordId(discordId: string): UserRole {
  if (config.adminIds.has(discordId)) return "admin";
  if (config.moderatorIds.has(discordId)) return "moderator";
  return "viewer";
}

export interface DiscordProfile {
  id: string;
  username: string;
  globalName: string | null;
  avatar: string | null;
}

/**
 * Upsert the Discord account into `users`.
 *
 * An existing user keeps whatever role an admin set by hand *unless* the env
 * allowlist grants a higher one, so promoting someone is a config change and
 * demoting them is an explicit admin action.
 */
export async function upsertDiscordUser(profile: DiscordProfile): Promise<SessionUser> {
  const envRole = roleForDiscordId(profile.id);

  const existing = await db
    .select()
    .from(users)
    .where(eq(users.discordId, profile.id))
    .limit(1)
    .then((r) => r[0]);

  if (existing) {
    const rank = { viewer: 0, moderator: 1, admin: 2 } as const;
    const role = rank[envRole] > rank[existing.role] ? envRole : existing.role;
    const updated = await db
      .update(users)
      .set({
        username: profile.username,
        globalName: profile.globalName,
        avatar: profile.avatar,
        role,
        lastLoginAt: new Date(),
      })
      .where(eq(users.id, existing.id))
      .returning();
    return toSessionUser(updated[0]!);
  }

  const inserted = await db
    .insert(users)
    .values({
      id: newId(),
      discordId: profile.id,
      username: profile.username,
      globalName: profile.globalName,
      avatar: profile.avatar,
      role: envRole,
      lastLoginAt: new Date(),
    })
    .returning();
  return toSessionUser(inserted[0]!);
}

/** Create (once) and return the synthetic development admin. */
export async function ensureDevUser(): Promise<SessionUser> {
  const existing = await db
    .select()
    .from(users)
    .where(eq(users.id, DEV_USER_ID))
    .limit(1)
    .then((r) => r[0]);
  if (existing) return toSessionUser(existing);

  const inserted = await db
    .insert(users)
    .values({
      id: DEV_USER_ID,
      discordId: "dev-local",
      username: "dev",
      globalName: "Development Admin",
      avatar: null,
      role: "admin",
    })
    .onConflictDoNothing()
    .returning();

  if (inserted[0]) return toSessionUser(inserted[0]);
  // Lost the race against another worker - read it back.
  const row = await db
    .select()
    .from(users)
    .where(eq(users.id, DEV_USER_ID))
    .limit(1)
    .then((r) => r[0]!);
  return toSessionUser(row);
}
