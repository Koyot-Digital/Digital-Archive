import { and, asc, desc, eq, ilike, or, sql as raw } from "drizzle-orm";
import { db } from "../db/client.js";
import { subjects } from "../db/schema.js";
import { notFound } from "../lib/errors.js";

/**
 * Subjects are the Roblox accounts the archive holds logs about.
 *
 * Rows are created implicitly by ingest — there is no "add a user" endpoint,
 * because a subject with no logs has no reason to exist.
 */

export interface PublicSubject {
  robloxId: string;
  username: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  logCount: number;
  firstLogAt: string | null;
  lastLogAt: string | null;
  profileUrl: string;
  archiveUrl: string;
}

export function toPublicSubject(row: typeof subjects.$inferSelect): PublicSubject {
  const id = row.robloxId.toString();
  return {
    robloxId: id,
    username: row.username,
    displayName: row.displayName,
    avatarUrl: row.avatarUrl,
    logCount: row.logCount,
    firstLogAt: row.firstLogAt?.toISOString() ?? null,
    lastLogAt: row.lastLogAt?.toISOString() ?? null,
    profileUrl: `https://www.roblox.com/users/${id}/profile`,
    archiveUrl: `/roblox-modlogs/${id}`,
  };
}

export interface SubjectInput {
  robloxId: string;
  username?: string | undefined;
  displayName?: string | undefined;
  avatarUrl?: string | undefined;
}

/**
 * Create or refresh a subject.
 *
 * Scraper payloads are frequently partial — one source has the username, the
 * next only has the id — so a blank field never overwrites a known value.
 */
export async function upsertSubject(input: SubjectInput): Promise<typeof subjects.$inferSelect> {
  const robloxId = BigInt(input.robloxId);

  const rows = await db
    .insert(subjects)
    .values({
      robloxId,
      username: input.username ?? null,
      displayName: input.displayName ?? null,
      avatarUrl: input.avatarUrl ?? null,
    })
    .onConflictDoUpdate({
      target: subjects.robloxId,
      set: {
        username: raw`coalesce(excluded.username, ${subjects.username})`,
        displayName: raw`coalesce(excluded.display_name, ${subjects.displayName})`,
        avatarUrl: raw`coalesce(excluded.avatar_url, ${subjects.avatarUrl})`,
      },
    })
    .returning();

  return rows[0]!;
}

export async function getSubject(robloxId: string): Promise<PublicSubject> {
  const row = await db
    .select()
    .from(subjects)
    .where(eq(subjects.robloxId, BigInt(robloxId)))
    .limit(1)
    .then((r) => r[0]);
  if (!row) throw notFound("Subject");
  return toPublicSubject(row);
}

export async function findSubject(robloxId: string): Promise<PublicSubject | null> {
  const row = await db
    .select()
    .from(subjects)
    .where(eq(subjects.robloxId, BigInt(robloxId)))
    .limit(1)
    .then((r) => r[0]);
  return row ? toPublicSubject(row) : null;
}

export interface ListSubjectsResult {
  subjects: PublicSubject[];
  total: number;
  page: number;
  limit: number;
}

export async function listSubjects(opts: {
  page: number;
  limit: number;
  q?: string | undefined;
  sort: "recent" | "most_logs" | "username";
}): Promise<ListSubjectsResult> {
  const needle = opts.q?.trim();
  const where = needle
    ? or(
        ilike(subjects.username, `%${needle}%`),
        ilike(subjects.displayName, `%${needle}%`),
        // A bare numeric query is almost certainly a Roblox id.
        /^\d+$/.test(needle) ? eq(subjects.robloxId, BigInt(needle)) : undefined,
      )
    : undefined;

  const order =
    opts.sort === "most_logs"
      ? [desc(subjects.logCount), desc(subjects.lastLogAt)]
      : opts.sort === "username"
        ? [asc(subjects.username)]
        : [desc(subjects.lastLogAt)];

  const [rows, total] = await Promise.all([
    db
      .select()
      .from(subjects)
      // Subjects whose every log was hidden or removed should not be listed.
      .where(where ? and(where, raw`${subjects.logCount} > 0`) : raw`${subjects.logCount} > 0`)
      .orderBy(...order)
      .limit(opts.limit)
      .offset((opts.page - 1) * opts.limit),
    db
      .select({ total: raw<number>`count(*)::int` })
      .from(subjects)
      .where(where ? and(where, raw`${subjects.logCount} > 0`) : raw`${subjects.logCount} > 0`)
      .then((r) => r[0]?.total ?? 0),
  ]);

  return {
    subjects: rows.map(toPublicSubject),
    total,
    page: opts.page,
    limit: opts.limit,
  };
}
