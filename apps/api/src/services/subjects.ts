import { and, asc, desc, eq, ilike, or, sql as raw } from "drizzle-orm";
import {
  newId,
  platformProfileUrl,
  subjectArchivePath,
  type SubjectPlatform,
  type SubjectRef,
} from "@archive/shared";
import { db } from "../db/client.js";
import { subjects } from "../db/schema.js";
import { notFound } from "../lib/errors.js";

/**
 * Subjects are the accounts the archive holds logs about.
 *
 * Identity is `(platform, externalId)` - a Roblox user id or a Discord
 * snowflake - behind a 16-char surrogate key that the rest of the schema
 * joins on. Rows are created implicitly by ingest; there is no "add a user"
 * endpoint, because a subject with no logs and no grouping has no reason to
 * exist.
 */

export interface PublicSubject {
  /** Surrogate key. Stable, and what every other row references. */
  id: string;
  platform: SubjectPlatform;
  externalId: string;
  username: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  logCount: number;
  firstLogAt: string | null;
  lastLogAt: string | null;
  /** The account's page on its own platform, where one is addressable. */
  profileUrl: string | null;
  archiveUrl: string;
}

export function toPublicSubject(row: typeof subjects.$inferSelect): PublicSubject {
  const externalId = row.externalId.toString();
  return {
    id: row.id,
    platform: row.platform,
    externalId,
    username: row.username,
    displayName: row.displayName,
    avatarUrl: row.avatarUrl,
    logCount: row.logCount,
    firstLogAt: row.firstLogAt?.toISOString() ?? null,
    lastLogAt: row.lastLogAt?.toISOString() ?? null,
    profileUrl: platformProfileUrl(row.platform, externalId),
    archiveUrl: subjectArchivePath(row.platform, externalId),
  };
}

/**
 * Create or refresh a subject, returning its surrogate id.
 *
 * Scraper payloads are frequently partial - one source has the username, the
 * next only has the id - so a blank field never overwrites a known value.
 * The insert is keyed on `(platform, external_id)`, which is what makes a
 * re-scrape idempotent without a lookup first.
 */
export async function upsertSubject(input: SubjectRef): Promise<typeof subjects.$inferSelect> {
  const rows = await db
    .insert(subjects)
    .values({
      id: newId(),
      platform: input.platform,
      externalId: BigInt(input.externalId),
      username: input.username ?? null,
      displayName: input.displayName ?? null,
      avatarUrl: input.avatarUrl ?? null,
    })
    .onConflictDoUpdate({
      target: [subjects.platform, subjects.externalId],
      set: {
        username: raw`coalesce(excluded.username, ${subjects.username})`,
        displayName: raw`coalesce(excluded.display_name, ${subjects.displayName})`,
        avatarUrl: raw`coalesce(excluded.avatar_url, ${subjects.avatarUrl})`,
      },
    })
    .returning();

  return rows[0]!;
}

/** Resolve a subject by its platform identity. */
export async function findSubjectByPlatform(
  platform: SubjectPlatform,
  externalId: string,
): Promise<typeof subjects.$inferSelect | null> {
  const row = await db
    .select()
    .from(subjects)
    .where(and(eq(subjects.platform, platform), eq(subjects.externalId, BigInt(externalId))))
    .limit(1)
    .then((r) => r[0]);
  return row ?? null;
}

export async function getSubject(
  platform: SubjectPlatform,
  externalId: string,
): Promise<PublicSubject> {
  const row = await findSubjectByPlatform(platform, externalId);
  if (!row) throw notFound("Subject");
  return toPublicSubject(row);
}

export async function findSubject(
  platform: SubjectPlatform,
  externalId: string,
): Promise<PublicSubject | null> {
  const row = await findSubjectByPlatform(platform, externalId);
  return row ? toPublicSubject(row) : null;
}

export async function getSubjectById(id: string): Promise<PublicSubject | null> {
  const row = await db
    .select()
    .from(subjects)
    .where(eq(subjects.id, id))
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
  platform?: SubjectPlatform | undefined;
  sort: "recent" | "most_logs" | "username";
}): Promise<ListSubjectsResult> {
  const needle = opts.q?.trim();
  const search = needle
    ? or(
        ilike(subjects.username, `%${needle}%`),
        ilike(subjects.displayName, `%${needle}%`),
        // A bare numeric query is almost certainly an account id.
        /^\d+$/.test(needle) ? eq(subjects.externalId, BigInt(needle)) : undefined,
      )
    : undefined;

  const order =
    opts.sort === "most_logs"
      ? [desc(subjects.logCount), desc(subjects.lastLogAt)]
      : opts.sort === "username"
        ? [asc(subjects.username)]
        : [desc(subjects.lastLogAt)];

  // Subjects whose every log was hidden or removed should not be listed, and
  // neither should a bare grouping row created only to hold an alt link.
  const filters = [raw`${subjects.logCount} > 0`];
  if (search) filters.push(search);
  if (opts.platform) filters.push(eq(subjects.platform, opts.platform));
  const where = and(...filters);

  const [rows, total] = await Promise.all([
    db
      .select()
      .from(subjects)
      .where(where)
      .orderBy(...order)
      .limit(opts.limit)
      .offset((opts.page - 1) * opts.limit),
    db
      .select({ total: raw<number>`count(*)::int` })
      .from(subjects)
      .where(where)
      .then((r) => r[0]?.total ?? 0),
  ]);

  return {
    subjects: rows.map(toPublicSubject),
    total,
    page: opts.page,
    limit: opts.limit,
  };
}

/** Per-platform subject counts, for the subjects page's filter tabs. */
export async function subjectPlatformCounts(): Promise<Record<string, number>> {
  const rows = await db
    .select({ platform: subjects.platform, count: raw<number>`count(*)::int` })
    .from(subjects)
    .where(raw`${subjects.logCount} > 0`)
    .groupBy(subjects.platform);
  return Object.fromEntries(rows.map((r) => [r.platform, r.count]));
}
