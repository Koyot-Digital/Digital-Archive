import { createHash } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, lte, sql as raw, type SQL } from "drizzle-orm";
import {
  newId,
  type IngressRecord,
  type ModlogAction,
  type ModlogSeverity,
  type RecordStatus,
} from "@archive/shared";
import { db } from "../db/client.js";
import { images, links, modlogRevisions, modlogs, subjects } from "../db/schema.js";
import { config } from "../config.js";
import { conflict, notFound } from "../lib/errors.js";
import { renderBody, toExcerpt } from "./render.js";
import { syncLinks } from "./links.js";
import { upsertSubject } from "./subjects.js";
import { toPublicSubject, type PublicSubject } from "./subjects.js";

/**
 * Modlog read + write logic.
 *
 * Reads are shaped for the web app (one request per page, no N+1), writes
 * always leave a revision snapshot behind. Nothing is ever truly deleted by
 * the normal paths: status moves to `removed` and the body stops being served.
 */

/* ───────────────────────────── visibility ───────────────────────────── */

export type Visibility = "public" | "moderator";

/** Which statuses a given viewer may see. */
function statusFilter(visibility: Visibility): SQL {
  return visibility === "public"
    ? eq(modlogs.status, "published")
    : inArray(modlogs.status, ["published", "hidden", "removed"]);
}

/* ───────────────────────────── shaping ───────────────────────────── */

export interface PublicImage {
  id: string;
  url: string;
  thumbUrl: string;
  pageUrl: string;
  width: number;
  height: number;
  bytes: number;
  caption: string | null;
  blurDataUrl: string | null;
  position: number;
  originalFormat: string;
  originalBytes: number;
}

export interface PublicLink {
  url: string;
  domain: string;
  kind: string;
  ref: string | null;
  title: string | null;
  description: string | null;
  imageUrl: string | null;
  siteName: string | null;
}

export interface PublicModlog {
  id: string;
  robloxId: string;
  title: string;
  excerpt: string;
  action: ModlogAction;
  severity: ModlogSeverity;
  reason: string | null;
  occurredAt: string | null;
  source: string;
  sourceUrl: string | null;
  tags: string[];
  status: RecordStatus;
  revision: number;
  imageCount: number;
  createdAt: string;
  updatedAt: string;
  url: string;
  /** Present on detail responses only. */
  body?: { markdown: string; html: string };
  evidence?: Record<string, unknown>;
  images?: PublicImage[];
  linkEmbeds?: PublicLink[];
  subject?: PublicSubject;
  thumbnail?: PublicImage | null;
}

type ModlogRow = typeof modlogs.$inferSelect;

function toPublicImage(row: typeof images.$inferSelect): PublicImage {
  const robloxId = row.robloxId.toString();
  return {
    id: row.id,
    url: config.imageUrl(row.id, "full"),
    thumbUrl: config.imageUrl(row.id, "thumb"),
    pageUrl: `/roblox-modlogs/${robloxId}/${row.modlogId}/${row.id}`,
    width: row.width,
    height: row.height,
    bytes: row.bytes,
    caption: row.caption,
    blurDataUrl: row.blurDataUrl,
    position: row.position,
    originalFormat: row.originalFormat,
    originalBytes: row.originalBytes,
  };
}

function toPublicLink(row: typeof links.$inferSelect): PublicLink {
  return {
    url: row.url,
    domain: row.domain,
    kind: row.kind,
    ref: row.ref,
    title: row.title,
    description: row.description,
    imageUrl: row.imageUrl,
    siteName: row.siteName,
  };
}

function toSummary(row: ModlogRow): PublicModlog {
  const robloxId = row.robloxId.toString();
  return {
    id: row.id,
    robloxId,
    title: row.title,
    // A removed log keeps its shell so links do not 404, but says nothing.
    excerpt: row.status === "removed" ? "" : toExcerpt(row.bodyMd, 220),
    action: row.action,
    severity: row.severity,
    reason: row.status === "removed" ? null : row.reason,
    occurredAt: row.occurredAt?.toISOString() ?? null,
    source: row.source,
    sourceUrl: row.sourceUrl,
    tags: row.tags,
    status: row.status,
    revision: row.revision,
    imageCount: row.imageCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    url: `/roblox-modlogs/${robloxId}/${row.id}`,
  };
}

/* ───────────────────────────── reads ───────────────────────────── */

export interface ListOptions {
  page: number;
  limit: number;
  action?: ModlogAction | undefined;
  severity?: ModlogSeverity | undefined;
  tag?: string | undefined;
  source?: string | undefined;
  status?: RecordStatus | undefined;
  from?: Date | undefined;
  to?: Date | undefined;
  sort: "newest" | "oldest" | "severity";
}

export interface ModlogPage {
  modlogs: PublicModlog[];
  total: number;
  page: number;
  limit: number;
  hasMore: boolean;
}

function buildFilters(opts: Partial<ListOptions>, visibility: Visibility): SQL[] {
  const filters: SQL[] = [];
  // An explicit status filter is only honoured for moderators; the public
  // view is pinned to `published` regardless of what the query string says.
  if (visibility === "moderator" && opts.status) {
    filters.push(eq(modlogs.status, opts.status));
  } else {
    filters.push(statusFilter(visibility));
  }
  if (opts.action) filters.push(eq(modlogs.action, opts.action));
  if (opts.severity) filters.push(eq(modlogs.severity, opts.severity));
  if (opts.source) filters.push(eq(modlogs.source, opts.source));
  if (opts.tag) filters.push(raw`${modlogs.tags} @> ARRAY[${opts.tag}]::text[]`);
  if (opts.from) filters.push(gte(raw`coalesce(${modlogs.occurredAt}, ${modlogs.createdAt})`, opts.from));
  if (opts.to) filters.push(lte(raw`coalesce(${modlogs.occurredAt}, ${modlogs.createdAt})`, opts.to));
  return filters;
}

function buildOrder(sort: ListOptions["sort"]) {
  const effective = raw`coalesce(${modlogs.occurredAt}, ${modlogs.createdAt})`;
  if (sort === "oldest") return [asc(effective), asc(modlogs.id)];
  if (sort === "severity") {
    // Postgres orders varchar alphabetically, which is meaningless here.
    return [
      raw`case ${modlogs.severity}
            when 'critical' then 0 when 'high' then 1 when 'medium' then 2
            when 'low' then 3 else 4 end asc`,
      desc(effective),
    ];
  }
  return [desc(effective), desc(modlogs.id)];
}

/** Attach the first published image of each log, in one extra query. */
async function withThumbnails(rows: PublicModlog[]): Promise<PublicModlog[]> {
  const ids = rows.filter((r) => r.imageCount > 0).map((r) => r.id);
  if (!ids.length) return rows.map((r) => ({ ...r, thumbnail: null }));

  const thumbs = await db
    .select()
    .from(images)
    .where(and(inArray(images.modlogId, ids), eq(images.status, "published")))
    .orderBy(asc(images.modlogId), asc(images.position), asc(images.createdAt));

  const first = new Map<string, PublicImage>();
  for (const row of thumbs) {
    if (!first.has(row.modlogId)) first.set(row.modlogId, toPublicImage(row));
  }
  return rows.map((r) => ({ ...r, thumbnail: first.get(r.id) ?? null }));
}

export async function listModlogsForSubject(
  robloxId: string,
  opts: ListOptions,
  visibility: Visibility,
): Promise<ModlogPage> {
  const filters = [eq(modlogs.robloxId, BigInt(robloxId)), ...buildFilters(opts, visibility)];
  const where = and(...filters);

  const [rows, total] = await Promise.all([
    db
      .select()
      .from(modlogs)
      .where(where)
      .orderBy(...buildOrder(opts.sort))
      .limit(opts.limit)
      .offset((opts.page - 1) * opts.limit),
    db
      .select({ total: raw<number>`count(*)::int` })
      .from(modlogs)
      .where(where)
      .then((r) => r[0]?.total ?? 0),
  ]);

  const summaries = await withThumbnails(rows.map(toSummary));
  return {
    modlogs: summaries,
    total,
    page: opts.page,
    limit: opts.limit,
    hasMore: opts.page * opts.limit < total,
  };
}

export async function listRecentModlogs(
  opts: ListOptions,
  visibility: Visibility,
): Promise<ModlogPage> {
  const where = and(...buildFilters(opts, visibility));
  const [rows, total] = await Promise.all([
    db
      .select()
      .from(modlogs)
      .where(where)
      .orderBy(...buildOrder(opts.sort))
      .limit(opts.limit)
      .offset((opts.page - 1) * opts.limit),
    db
      .select({ total: raw<number>`count(*)::int` })
      .from(modlogs)
      .where(where)
      .then((r) => r[0]?.total ?? 0),
  ]);

  const summaries = await withThumbnails(rows.map(toSummary));
  return {
    modlogs: summaries,
    total,
    page: opts.page,
    limit: opts.limit,
    hasMore: opts.page * opts.limit < total,
  };
}

/**
 * Full-text search.
 *
 * websearch_to_tsquery accepts quoted phrases and `-exclusions` the way a
 * search box user expects, and never throws on malformed input the way
 * to_tsquery does.
 */
export async function searchModlogs(
  opts: { q: string; page: number; limit: number; action?: ModlogAction | undefined; severity?: ModlogSeverity | undefined; tag?: string | undefined },
  visibility: Visibility,
): Promise<ModlogPage & { query: string }> {
  const query = raw`websearch_to_tsquery('english', ${opts.q})`;
  const filters = [
    ...buildFilters(opts, visibility),
    raw`${modlogs.searchVector} @@ ${query}`,
  ];
  const where = and(...filters);
  const rank = raw`ts_rank_cd(${modlogs.searchVector}, ${query}, 32)`;

  const [rows, total] = await Promise.all([
    db
      .select()
      .from(modlogs)
      .where(where)
      .orderBy(desc(rank), desc(modlogs.createdAt))
      .limit(opts.limit)
      .offset((opts.page - 1) * opts.limit),
    db
      .select({ total: raw<number>`count(*)::int` })
      .from(modlogs)
      .where(where)
      .then((r) => r[0]?.total ?? 0),
  ]);

  const summaries = await withThumbnails(rows.map(toSummary));
  return {
    modlogs: summaries,
    total,
    page: opts.page,
    limit: opts.limit,
    hasMore: opts.page * opts.limit < total,
    query: opts.q,
  };
}

/**
 * One modlog with everything the detail page renders.
 *
 * `robloxId` is checked when supplied so /roblox-modlogs/:robloxId/:id cannot
 * be used to render a log under the wrong subject.
 */
export async function getModlog(
  id: string,
  visibility: Visibility,
  expectedRobloxId?: string,
): Promise<PublicModlog> {
  const row = await db
    .select()
    .from(modlogs)
    .where(and(eq(modlogs.id, id), statusFilter(visibility)))
    .limit(1)
    .then((r) => r[0]);
  if (!row) throw notFound("Modlog");
  if (expectedRobloxId && row.robloxId.toString() !== expectedRobloxId) throw notFound("Modlog");

  const [imageRows, linkRows, subjectRow] = await Promise.all([
    db
      .select()
      .from(images)
      .where(
        and(
          eq(images.modlogId, id),
          visibility === "public" ? eq(images.status, "published") : raw`true`,
        ),
      )
      .orderBy(asc(images.position), asc(images.createdAt)),
    db.select().from(links).where(eq(links.modlogId, id)).orderBy(asc(links.position)),
    db
      .select()
      .from(subjects)
      .where(eq(subjects.robloxId, row.robloxId))
      .limit(1)
      .then((r) => r[0]),
  ]);

  const withheld = row.status === "removed" && visibility === "public";
  const summary = toSummary(row);

  return {
    ...summary,
    body: withheld
      ? { markdown: "", html: "" }
      : { markdown: row.bodyMd, html: row.bodyHtml },
    evidence: withheld ? {} : row.evidence,
    images: withheld ? [] : imageRows.map(toPublicImage),
    linkEmbeds: withheld ? [] : linkRows.map(toPublicLink),
    subject: subjectRow ? toPublicSubject(subjectRow) : undefined,
  };
}

export async function getImageForRoute(
  robloxId: string,
  modlogId: string,
  imageId: string,
  visibility: Visibility,
): Promise<{ image: PublicImage; modlog: PublicModlog; siblings: PublicImage[] }> {
  const modlog = await getModlog(modlogId, visibility, robloxId);
  const siblings = modlog.images ?? [];
  const image = siblings.find((i) => i.id === imageId);
  if (!image) throw notFound("Image");
  return { image, modlog, siblings };
}

export async function getRevisions(modlogId: string) {
  return db
    .select({
      revision: modlogRevisions.revision,
      changeReason: modlogRevisions.changeReason,
      changedBy: modlogRevisions.changedBy,
      changedByKey: modlogRevisions.changedByKey,
      createdAt: modlogRevisions.createdAt,
      snapshot: modlogRevisions.snapshot,
    })
    .from(modlogRevisions)
    .where(eq(modlogRevisions.modlogId, modlogId))
    .orderBy(desc(modlogRevisions.revision));
}

/* ───────────────────────────── writes ───────────────────────────── */

export interface Actor {
  userId?: string | null;
  apiKeyId?: string | null;
}

/** Deterministic dedupe key for records a scraper did not identify itself. */
function derivedSourceId(record: { robloxId: string; title: string; body: string; occurredAt?: Date | undefined }): string {
  const digest = createHash("sha256")
    .update(
      [record.robloxId, record.title.trim().toLowerCase(), record.occurredAt?.toISOString() ?? "", record.body.trim()].join(
        "\u0000",
      ),
    )
    .digest("hex");
  return `auto:${digest.slice(0, 40)}`;
}

function snapshotOf(row: ModlogRow): Record<string, unknown> {
  return {
    title: row.title,
    bodyMd: row.bodyMd,
    action: row.action,
    severity: row.severity,
    reason: row.reason,
    occurredAt: row.occurredAt?.toISOString() ?? null,
    sourceUrl: row.sourceUrl,
    tags: row.tags,
    evidence: row.evidence,
    status: row.status,
    revision: row.revision,
  };
}

export interface UpsertOutcome {
  id: string;
  robloxId: string;
  outcome: "created" | "updated" | "skipped";
}

/**
 * Ingest one scraped record.
 *
 * Runs in its own transaction so a malformed record in a 500-record batch
 * fails alone. The conflict policy is the interesting part:
 *
 *   skip    — never touch an existing row
 *   merge   — update, unless a human has edited the row (updated_by is set).
 *             This is the default and it is what keeps a nightly re-scrape
 *             from silently reverting a moderator's correction.
 *   replace — always overwrite, and say so in the revision history
 */
export async function upsertFromIngress(
  record: IngressRecord,
  onConflict: "skip" | "merge" | "replace",
  actor: Actor,
): Promise<UpsertOutcome> {
  const sourceId = record.sourceId ?? derivedSourceId(record);
  const rendered = renderBody(record.body);

  await upsertSubject({
    robloxId: record.robloxId,
    username: record.username,
    displayName: record.displayName,
    avatarUrl: record.avatarUrl,
  });

  const outcome = await db.transaction(async (tx) => {
    const existing = await tx
      .select()
      .from(modlogs)
      .where(and(eq(modlogs.source, record.source), eq(modlogs.sourceId, sourceId)))
      .limit(1)
      .for("update")
      .then((r) => r[0]);

    if (existing) {
      if (onConflict === "skip") {
        return { id: existing.id, robloxId: existing.robloxId.toString(), outcome: "skipped" as const };
      }
      if (onConflict === "merge" && existing.updatedBy) {
        return { id: existing.id, robloxId: existing.robloxId.toString(), outcome: "skipped" as const };
      }

      await tx.insert(modlogRevisions).values({
        modlogId: existing.id,
        revision: existing.revision,
        snapshot: snapshotOf(existing),
        changeReason: `ingress (${record.source}, onConflict=${onConflict})`,
        changedByKey: actor.apiKeyId ?? null,
      });

      await tx
        .update(modlogs)
        .set({
          robloxId: BigInt(record.robloxId),
          title: record.title,
          bodyMd: record.body,
          bodyHtml: rendered.html,
          action: record.action,
          severity: record.severity,
          reason: record.reason ?? null,
          occurredAt: record.occurredAt ?? existing.occurredAt,
          sourceUrl: record.sourceUrl ?? existing.sourceUrl,
          tags: record.tags.length ? record.tags : existing.tags,
          evidence: { ...existing.evidence, ...record.evidence },
          revision: existing.revision + 1,
          ingestedBy: actor.apiKeyId ?? existing.ingestedBy,
        })
        .where(eq(modlogs.id, existing.id));

      return { id: existing.id, robloxId: record.robloxId, outcome: "updated" as const };
    }

    const id = newId();
    await tx.insert(modlogs).values({
      id,
      robloxId: BigInt(record.robloxId),
      title: record.title,
      bodyMd: record.body,
      bodyHtml: rendered.html,
      action: record.action,
      severity: record.severity,
      reason: record.reason ?? null,
      occurredAt: record.occurredAt ?? null,
      source: record.source,
      sourceId,
      sourceUrl: record.sourceUrl ?? null,
      tags: record.tags,
      evidence: record.evidence,
      createdBy: actor.userId ?? null,
      ingestedBy: actor.apiKeyId ?? null,
    });
    return { id, robloxId: record.robloxId, outcome: "created" as const };
  });

  if (outcome.outcome !== "skipped") {
    await syncLinks(outcome.id, rendered.links);
  }
  return outcome;
}

/** Create a modlog by hand, from the web UI. */
export async function createModlog(
  input: {
    robloxId: string;
    username?: string | undefined;
    displayName?: string | undefined;
    avatarUrl?: string | undefined;
    title: string;
    body: string;
    action: ModlogAction;
    severity: ModlogSeverity;
    reason?: string | undefined;
    occurredAt?: Date | undefined;
    source: string;
    sourceId?: string | undefined;
    sourceUrl?: string | undefined;
    tags: string[];
    evidence: Record<string, unknown>;
  },
  actor: Actor,
): Promise<PublicModlog> {
  const rendered = renderBody(input.body);
  const sourceId = input.sourceId ?? derivedSourceId(input);

  await upsertSubject({
    robloxId: input.robloxId,
    username: input.username,
    displayName: input.displayName,
    avatarUrl: input.avatarUrl,
  });

  const id = newId();
  try {
    await db.insert(modlogs).values({
      id,
      robloxId: BigInt(input.robloxId),
      title: input.title,
      bodyMd: input.body,
      bodyHtml: rendered.html,
      action: input.action,
      severity: input.severity,
      reason: input.reason ?? null,
      occurredAt: input.occurredAt ?? null,
      source: input.source,
      sourceId,
      sourceUrl: input.sourceUrl ?? null,
      tags: input.tags,
      evidence: input.evidence,
      createdBy: actor.userId ?? null,
    });
  } catch (err) {
    if (String(err).includes("modlogs_source_key")) {
      throw conflict("A modlog with this source and source id already exists");
    }
    throw err;
  }

  await syncLinks(id, rendered.links);
  return getModlog(id, "moderator");
}

export interface UpdatePatch {
  title?: string;
  body?: string;
  action?: ModlogAction;
  severity?: ModlogSeverity;
  reason?: string | null;
  occurredAt?: Date | null;
  sourceUrl?: string | null;
  tags?: string[];
  evidence?: Record<string, unknown>;
  status?: RecordStatus;
  changeReason: string;
}

/**
 * Edit a modlog, Wikipedia-style: the previous state is snapshotted into
 * `modlog_revisions` before the new state lands, and the change reason is
 * mandatory so the history reads as an explanation rather than a diff.
 */
export async function updateModlog(
  id: string,
  patch: UpdatePatch,
  actor: Actor,
): Promise<PublicModlog> {
  const rendered = patch.body !== undefined ? renderBody(patch.body) : null;

  await db.transaction(async (tx) => {
    const existing = await tx
      .select()
      .from(modlogs)
      .where(eq(modlogs.id, id))
      .limit(1)
      .for("update")
      .then((r) => r[0]);
    if (!existing) throw notFound("Modlog");

    await tx.insert(modlogRevisions).values({
      modlogId: id,
      revision: existing.revision,
      snapshot: snapshotOf(existing),
      changeReason: patch.changeReason,
      changedBy: actor.userId ?? null,
      changedByKey: actor.apiKeyId ?? null,
    });

    await tx
      .update(modlogs)
      .set({
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.body !== undefined ? { bodyMd: patch.body, bodyHtml: rendered!.html } : {}),
        ...(patch.action !== undefined ? { action: patch.action } : {}),
        ...(patch.severity !== undefined ? { severity: patch.severity } : {}),
        ...(patch.reason !== undefined ? { reason: patch.reason } : {}),
        ...(patch.occurredAt !== undefined ? { occurredAt: patch.occurredAt } : {}),
        ...(patch.sourceUrl !== undefined ? { sourceUrl: patch.sourceUrl } : {}),
        ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
        ...(patch.evidence !== undefined ? { evidence: patch.evidence } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        revision: existing.revision + 1,
        updatedBy: actor.userId ?? null,
      })
      .where(eq(modlogs.id, id));
  });

  if (rendered) await syncLinks(id, rendered.links);
  return getModlog(id, "moderator");
}

export async function setStatus(
  id: string,
  status: RecordStatus,
  changeReason: string,
  actor: Actor,
): Promise<PublicModlog> {
  return updateModlog(id, { status, changeReason }, actor);
}

/* ───────────────────────────── stats ───────────────────────────── */

export interface ArchiveStats {
  subjects: number;
  modlogs: number;
  images: number;
  sources: { source: string; count: number }[];
  actions: { action: string; count: number }[];
  latestAt: string | null;
}

export async function archiveStats(): Promise<ArchiveStats> {
  const [counts, sources, actions] = await Promise.all([
    // One round trip for the headline numbers. A scalar-subquery SELECT has
    // no FROM clause, which the query builder cannot express, so this is raw.
    db
      .execute<{ subjects: number; modlogs: number; images: number; latest_at: Date | null }>(raw`
        SELECT
          (SELECT count(*) FROM subjects WHERE log_count > 0)::int          AS subjects,
          (SELECT count(*) FROM modlogs  WHERE status = 'published')::int   AS modlogs,
          (SELECT count(*) FROM images   WHERE status = 'published')::int   AS images,
          (SELECT max(created_at) FROM modlogs WHERE status = 'published')  AS latest_at
      `)
      .then((rows) => rows[0]),
    db
      .select({ source: modlogs.source, count: raw<number>`count(*)::int` })
      .from(modlogs)
      .where(eq(modlogs.status, "published"))
      .groupBy(modlogs.source)
      .orderBy(desc(raw`count(*)`))
      .limit(20),
    db
      .select({ action: modlogs.action, count: raw<number>`count(*)::int` })
      .from(modlogs)
      .where(eq(modlogs.status, "published"))
      .groupBy(modlogs.action)
      .orderBy(desc(raw`count(*)`)),
  ]);

  return {
    subjects: counts?.subjects ?? 0,
    modlogs: counts?.modlogs ?? 0,
    images: counts?.images ?? 0,
    sources,
    actions,
    latestAt: counts?.latest_at ? new Date(counts.latest_at).toISOString() : null,
  };
}
