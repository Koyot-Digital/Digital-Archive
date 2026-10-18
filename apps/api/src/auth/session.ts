import { and, eq, gt, lt } from "drizzle-orm";
import { db } from "../db/client.js";
import { sessions, users, type DbUser } from "../db/schema.js";
import { config } from "../config.js";
import { randomToken, sha256, sign, unsign } from "../lib/crypto.js";
import { forbidden } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import { claimOnce } from "../lib/redis.js";
import { recordAudit } from "../services/audit.js";
import { fetchMemberRolesAsBot } from "./discord.js";
import { NO_ROLE_MESSAGE, roleForMember } from "./roles.js";
import { SESSION_COOKIE_NAME, newId, type UserRole } from "@archive/shared";

export const SESSION_COOKIE = SESSION_COOKIE_NAME;
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

  const verified = await revalidateRoles(row.user);
  if (!verified) return null;

  return toSessionUser(verified);
}

/**
 * Re-ask the guild whether this account still has access.
 *
 * Returns the user with a refreshed role, or null when access has ended - in
 * which case every session they hold is destroyed, not just the one in hand,
 * because losing a role should not leave a second browser signed in.
 *
 * Three properties matter here:
 *
 *  1. **Throttled.** A check is due once per ROLE_RECHECK_MINUTES per
 *     account, so the common case costs an already-loaded column and no
 *     network call. Without it, gating every read on a role would mean a
 *     Discord API call on every read.
 *  2. **Single-flight.** The due check is claimed in Redis, so a page load
 *     firing a dozen parallel requests produces one lookup rather than a
 *     dozen. A request that loses the claim proceeds on the cached role: at
 *     most one interval stale, which is the guarantee the interval states.
 *  3. **Closed on "not a member", open on "Discord is unreachable".** A 404
 *     ends the session. A timeout or a 5xx keeps the cached role and does not
 *     advance rolesCheckedAt, so the check is retried on the next request
 *     instead of being skipped for a whole interval. Treating an outage as
 *     "holds no roles" would sign out every moderator the moment Discord
 *     blipped.
 */
async function revalidateRoles(user: DbUser): Promise<DbUser | null> {
  const dueAt = user.rolesCheckedAt
    ? user.rolesCheckedAt.getTime() + config.roleRecheckSeconds * 1000
    : 0;
  if (Date.now() < dueAt) return user;

  const claimed = await claimOnce(`roles:check:${user.discordId}`, config.roleRecheckSeconds);
  if (!claimed) return user;

  let guildRoles: string[] | null;
  try {
    guildRoles = await fetchMemberRolesAsBot(user.discordId);
  } catch (err) {
    logger.warn(
      { discordId: user.discordId, err: (err as Error).message },
      "guild role re-check failed - keeping the cached role until the next request",
    );
    return user;
  }

  const revoke = async (held: string[], leftGuild: boolean) => {
    logger.info(
      { discordId: user.discordId, leftGuild },
      "archive access revoked - signing the account out everywhere",
    );
    await destroyAllSessionsFor(user.id);
    await db
      .update(users)
      .set({ discordRoles: held, rolesCheckedAt: new Date() })
      .where(eq(users.id, user.id));
    // Losing access is the kind of thing someone will later need to explain,
    // so it goes in the append-only trail and not only in the service log,
    // which rotates. `system` is the honest actor: Discord decided this, and
    // nobody here pressed a button.
    await recordAudit({
      actorType: "system",
      action: "user.access_revoked",
      targetType: "user",
      targetId: user.id,
      metadata: { discordId: user.discordId, leftGuild, previousRole: user.role },
    });
  };

  // No longer in the guild at all.
  if (guildRoles === null) {
    await revoke([], true);
    return null;
  }

  // Still a member, but holds nothing that grants access any more.
  const role = roleForMember(user.discordId, guildRoles);
  if (role === null) {
    await revoke(guildRoles, false);
    return null;
  }

  const updated = await db
    .update(users)
    .set({ role, discordRoles: guildRoles, rolesCheckedAt: new Date() })
    .where(eq(users.id, user.id))
    .returning();
  return updated[0] ?? { ...user, role };
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

export interface DiscordProfile {
  id: string;
  username: string;
  globalName: string | null;
  avatar: string | null;
}

/**
 * Upsert the Discord account into `users` and return its session identity.
 *
 * Throws 403 when the guild roles grant nothing, so a sign-in by someone
 * without a granting role creates no row, issues no session and leaves
 * nothing behind to be promoted later.
 *
 * The role is *overwritten* from the guild on every login rather than kept at
 * its highest-ever value. The high-water mark was right while the role only
 * unlocked the staff tools and a demotion was an admin decision; it is wrong
 * now that Discord is the access list, because it would make a demotion in
 * Discord something the archive quietly ignores.
 */
export async function upsertDiscordUser(
  profile: DiscordProfile,
  guildRoleIds: readonly string[],
): Promise<SessionUser> {
  const role = roleForMember(profile.id, guildRoleIds);
  if (!role) throw forbidden(NO_ROLE_MESSAGE);

  const shared = {
    username: profile.username,
    globalName: profile.globalName,
    avatar: profile.avatar,
    role,
    discordRoles: [...guildRoleIds],
    rolesCheckedAt: new Date(),
    lastLoginAt: new Date(),
  };

  const existing = await db
    .select()
    .from(users)
    .where(eq(users.discordId, profile.id))
    .limit(1)
    .then((r) => r[0]);

  if (existing) {
    // `disabled` is a manual block by an admin and outranks any guild role.
    if (existing.disabled) throw forbidden("This account has been blocked from the archive");
    const updated = await db
      .update(users)
      .set(shared)
      .where(eq(users.id, existing.id))
      .returning();
    return toSessionUser(updated[0]!);
  }

  const inserted = await db
    .insert(users)
    .values({ id: newId(), discordId: profile.id, ...shared })
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
