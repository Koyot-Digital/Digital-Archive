import { z } from "zod";
import {
  MODLOG_ACTIONS,
  MODLOG_SEVERITIES,
  RECORD_STATUSES,
  SUBJECT_PLATFORMS,
  SUBJECT_RELATIONS,
  THREAD_ROLES,
  USER_ROLES,
  API_KEY_SCOPES,
} from "./constants.js";
import { ID_PATTERN, ROBLOX_ID_PATTERN } from "./ids.js";
import { discordForumPostSchema, zSnowflake } from "./discord.js";

/* ───────────────────────────── primitives ───────────────────────────── */

export const zId = z.string().regex(ID_PATTERN, "must be a 16-character archive id");

/** Roblox ids arrive as numbers or strings depending on the scraper. */
export const zRobloxId = z
  .union([z.string(), z.number().int().positive()])
  .transform((v) => String(v))
  .refine((v) => ROBLOX_ID_PATTERN.test(v), "must be a positive Roblox user id");

/** Accepts ISO-8601, epoch seconds and epoch milliseconds. */
export const zTimestamp = z
  .union([z.string().datetime({ offset: true }), z.string(), z.number()])
  .transform((v, ctx) => {
    if (typeof v === "number") {
      // Heuristic: a value below 1e11 is seconds, not milliseconds.
      const ms = v < 1e11 ? v * 1000 : v;
      const d = new Date(ms);
      if (Number.isNaN(d.getTime())) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "invalid timestamp" });
        return z.NEVER;
      }
      return d;
    }
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "invalid timestamp" });
      return z.NEVER;
    }
    return d;
  });

const zTag = z
  .string()
  .trim()
  .min(1)
  .max(48)
  .regex(/^[\w][\w .+#/-]*$/, "tags may not contain control characters")
  .transform((s) => s.toLowerCase());

export const zTags = z.array(zTag).max(24).default([]);

/**
 * Scraper evidence blobs: arbitrary JSON, but bounded so one bad run cannot
 * push multi-megabyte rows into Postgres.
 */
export const zEvidence = z
  .record(z.unknown())
  .refine((v) => JSON.stringify(v).length <= 64_000, "evidence must be <= 64KB serialised")
  .default({});

export const zAction = z.enum(MODLOG_ACTIONS);
export const zSeverity = z.enum(MODLOG_SEVERITIES);
export const zStatus = z.enum(RECORD_STATUSES);
export const zRelation = z.enum(SUBJECT_RELATIONS);
export const zThreadRole = z.enum(THREAD_ROLES);
export const zRole = z.enum(USER_ROLES);
export const zScope = z.enum(API_KEY_SCOPES);

/* ──────────────────────── discord thread context ──────────────────────── */

/**
 * A Discord account seen on a record's thread.
 *
 * The scraper already knows the username and avatar it saw, but those are a
 * *hint*, not the truth: a display name changes, an avatar is replaced, and a
 * scrape from August is stale by October. The API stores them so a record is
 * never blank, then refreshes them from the Discord API, which is why every
 * field but the id is optional here.
 */
export const discordUserHintSchema = z.object({
  id: zSnowflake,
  username: z.string().trim().min(1).max(64).optional(),
  displayName: z.string().trim().min(1).max(64).optional(),
  avatarUrl: z.string().url().max(2048).optional(),
  bot: z.boolean().default(false),
  role: zThreadRole.default("commenter"),
});
export type DiscordUserHint = z.infer<typeof discordUserHintSchema>;

/** One message in the discussion that followed a moderation log. */
export const threadMessageSchema = z.object({
  messageId: zSnowflake,
  authorId: zSnowflake.optional(),
  content: z.string().max(8000).default(""),
  postedAt: zTimestamp.optional(),
  editedAt: zTimestamp.optional(),
  /** Attachments on this message, fetched and converted like any evidence. */
  imageUrls: z.array(z.string().url().max(2048)).max(16).default([]),
});
export type ThreadMessage = z.infer<typeof threadMessageSchema>;

/**
 * Where a record came from, when the source was a Discord forum thread.
 *
 * Kept as its own object rather than flattened into the record so that
 * `source: "discord-forum"` records carry provenance a reader can follow back
 * to the original thread, while records from other scrapers simply omit it.
 */
export const discordThreadSchema = z.object({
  guildId: zSnowflake.optional(),
  forumId: zSnowflake.optional(),
  forumName: z.string().trim().max(128).optional(),
  postId: zSnowflake,
  url: z.string().url().max(2048).optional(),
  /** The moderator who opened the thread. */
  authorId: zSnowflake.optional(),
  archived: z.boolean().default(false),
  locked: z.boolean().default(false),
  pinned: z.boolean().default(false),
  replyCount: z.number().int().nonnegative().max(100_000).default(0),
  createdAt: zTimestamp.optional(),
  lastMessageAt: zTimestamp.optional(),
  archivedAt: zTimestamp.optional(),
  users: z.array(discordUserHintSchema).max(200).default([]),
  messages: z.array(threadMessageSchema).max(400).default([]),
});
export type DiscordThread = z.infer<typeof discordThreadSchema>;

/* ───────────────────────────── subjects ───────────────────────────── */

export const zPlatform = z.enum(SUBJECT_PLATFORMS);

/**
 * An account id on some platform.
 *
 * Deliberately not validated against a per-platform pattern beyond "positive
 * integer that fits in a bigint": Roblox ids and Discord snowflakes are both
 * sequential-ish integers, and a stricter rule here would start rejecting
 * real accounts the day either platform changes its allocation.
 */
export const zExternalId = z
  .union([z.string(), z.number().int().positive()])
  .transform((v) => String(v))
  .refine((v) => /^[1-9][0-9]{0,19}$/.test(v), "must be a positive account id");

/** The account a record is about, or one grouped with it. */
export const subjectRefSchema = z.object({
  platform: zPlatform.default("roblox"),
  externalId: zExternalId,
  username: z.string().trim().min(1).max(64).optional(),
  displayName: z.string().trim().min(1).max(64).optional(),
  avatarUrl: z.string().url().max(2048).optional(),
});
export type SubjectRef = z.infer<typeof subjectRefSchema>;

/**
 * Another account named on the same record.
 *
 * Carries its own platform, because these groupings cross platforms: the
 * Discord forum routinely names a Discord account and the Roblox account
 * behind it in one title.
 */
export const relatedAccountSchema = z.object({
  platform: zPlatform.default("roblox"),
  externalId: zExternalId,
  username: z.string().trim().min(1).max(64).optional(),
  relation: zRelation.default("alt"),
});
export type RelatedAccount = z.infer<typeof relatedAccountSchema>;

/* ───────────────────────────── ingress ───────────────────────────── */

/**
 * One scraped moderation record.
 *
 * `source` plus `sourceId` form the dedupe key: re-running a scraper over the
 * same page updates the existing row instead of creating a twin. A record
 * without a `sourceId` falls back to a content hash computed server-side.
 */
export const ingressRecordSchema = z.object({
  /**
   * The account the record is about.
   *
   * Two spellings are accepted, and exactly one must be present:
   *
   *   robloxId: 156                                  (the original form)
   *   subject:  { platform: "discord", externalId: "4999…" }
   *
   * `robloxId` is kept because it is the documented field every existing
   * scraper sends, and silently breaking a nightly cron to tidy up a schema
   * would be the wrong trade. `subjectOf()` below resolves either into one
   * shape so nothing downstream has to care which arrived.
   */
  robloxId: zRobloxId.optional(),
  subject: subjectRefSchema.optional(),
  /** Legacy, applied to the subject above. Superseded by `subject.*`. */
  username: z.string().trim().min(1).max(64).optional(),
  displayName: z.string().trim().min(1).max(64).optional(),
  avatarUrl: z.string().url().max(2048).optional(),

  title: z.string().trim().min(1).max(300),
  body: z.string().max(100_000).default(""),
  action: zAction.default("other"),
  severity: zSeverity.default("info"),
  reason: z.string().trim().max(2000).optional(),

  occurredAt: zTimestamp.optional(),
  source: z.string().trim().min(1).max(64),
  sourceId: z.string().trim().min(1).max(200).optional(),
  sourceUrl: z.string().url().max(2048).optional(),

  tags: zTags,
  evidence: zEvidence,

  /** Remote images to fetch, convert to WebP and attach. */
  imageUrls: z.array(z.string().url().max(2048)).max(24).default([]),
  /** IDs of images already uploaded through the images API. */
  imageIds: z.array(zId).max(24).default([]),

  /**
   * Other accounts named on the same record - alts, or a successor account.
   *
   * These are deliberately *not* extra records: one sanction announced for
   * four alts is one event. The archive stores the grouping so every alt's
   * page can point at it, and leaves the record itself filed under the
   * primary account.
   */
  relatedAccounts: z.array(relatedAccountSchema).max(24).default([]),
  /** Support-ticket reference, when the source named one. */
  ticketRef: z.string().trim().max(32).optional(),
  /** Discord provenance, for records scraped out of a forum channel. */
  thread: discordThreadSchema.optional(),
});
export type IngressRecord = z.infer<typeof ingressRecordSchema>;

/**
 * Resolve either subject spelling into one shape.
 *
 * Returns null when neither was supplied, which the batch schema rejects by
 * index so the scraper learns which record was wrong rather than getting a
 * blanket 422.
 */
export function subjectOf(record: {
  robloxId?: string | undefined;
  subject?: SubjectRef | undefined;
  username?: string | undefined;
  displayName?: string | undefined;
  avatarUrl?: string | undefined;
}): SubjectRef | null {
  if (record.subject) {
    // An explicit subject wins, but still inherits the legacy display fields
    // when it did not carry its own.
    return {
      ...record.subject,
      username: record.subject.username ?? record.username,
      displayName: record.subject.displayName ?? record.displayName,
      avatarUrl: record.subject.avatarUrl ?? record.avatarUrl,
    };
  }
  if (record.robloxId) {
    return {
      platform: "roblox",
      externalId: record.robloxId,
      username: record.username,
      displayName: record.displayName,
      avatarUrl: record.avatarUrl,
    };
  }
  return null;
}

export const ingressBatchSchema = z.object({
  /** Caller-chosen key; replaying the same key is a no-op for 24 hours. */
  batchId: z.string().trim().min(8).max(64).optional(),
  /** skip keeps the stored row, merge fills blanks, replace overwrites. */
  onConflict: z.enum(["skip", "merge", "replace"]).default("merge"),
  dryRun: z.boolean().default(false),
  records: z.array(ingressRecordSchema).min(1).max(500),
});
export type IngressBatch = z.infer<typeof ingressBatchSchema>;

/**
 * The raw-scrape entry point.
 *
 * Takes Discord forum threads exactly as the scraper emits them and maps them
 * server-side. The alternative - making the scraper build archive records -
 * would put the title-parsing and command-parsing rules in a second codebase
 * and guarantee the two drift apart.
 */
export const forumIngressBatchSchema = z.object({
  batchId: z.string().trim().min(8).max(64).optional(),
  onConflict: z.enum(["skip", "merge", "replace"]).default("merge"),
  dryRun: z.boolean().default(false),
  posts: z.array(discordForumPostSchema).min(1).max(500),
});
export type ForumIngressBatch = z.infer<typeof forumIngressBatchSchema>;

export const ingressResultSchema = z.object({
  batchId: z.string(),
  dryRun: z.boolean(),
  replayed: z.boolean(),
  counts: z.object({
    received: z.number(),
    created: z.number(),
    updated: z.number(),
    skipped: z.number(),
    failed: z.number(),
    imagesQueued: z.number(),
  }),
  created: z.array(
    z.object({
      id: zId,
      platform: zPlatform,
      externalId: z.string(),
      url: z.string(),
    }),
  ),
  errors: z.array(
    z.object({ index: z.number(), subject: z.string().nullable(), message: z.string() }),
  ),
  /**
   * Threads the mapper could not place - almost always a title with no Roblox
   * id in it. Reported rather than silently dropped so the scrape can be
   * corrected at the source.
   */
  unmapped: z
    .array(z.object({ index: z.number(), sourceId: z.string(), title: z.string(), reason: z.string() }))
    .default([]),
});
export type IngressResult = z.infer<typeof ingressResultSchema>;

/* ───────────────────────── modlog read/write ───────────────────────── */

export const modlogCreateSchema = ingressRecordSchema
  .omit({ source: true, sourceId: true, imageUrls: true, thread: true })
  .extend({
    source: z.string().trim().min(1).max(64).default("manual"),
    sourceId: z.string().trim().min(1).max(200).optional(),
  });

export const modlogUpdateSchema = z
  .object({
    title: z.string().trim().min(1).max(300),
    body: z.string().max(100_000),
    action: zAction,
    severity: zSeverity,
    reason: z.string().trim().max(2000).nullable(),
    occurredAt: zTimestamp.nullable(),
    sourceUrl: z.string().url().max(2048).nullable(),
    tags: z.array(zTag).max(24),
    evidence: z.record(z.unknown()),
    status: zStatus,
    /** Surfaced in the revision history, so history stays readable. */
    changeReason: z.string().trim().min(3).max(500),
  })
  .partial()
  .required({ changeReason: true })
  .refine(
    (v) => Object.keys(v).length > 1,
    "supply at least one field to change alongside changeReason",
  );

export const statusChangeSchema = z.object({
  status: zStatus,
  changeReason: z.string().trim().min(3).max(500),
});

/* ───────────────────────────── queries ───────────────────────────── */

const zPage = z.coerce.number().int().min(1).max(10_000).default(1);
const zLimit = z.coerce.number().int().min(1).max(100).default(25);

export const listModlogsQuerySchema = z.object({
  page: zPage,
  limit: zLimit,
  action: zAction.optional(),
  severity: zSeverity.optional(),
  tag: zTag.optional(),
  source: z.string().trim().max(64).optional(),
  status: zStatus.optional(),
  from: zTimestamp.optional(),
  to: zTimestamp.optional(),
  sort: z.enum(["newest", "oldest", "severity"]).default("newest"),
});

export const searchQuerySchema = z.object({
  q: z.string().trim().min(2).max(200),
  page: zPage,
  limit: zLimit,
  action: zAction.optional(),
  severity: zSeverity.optional(),
  tag: zTag.optional(),
});

export const listSubjectsQuerySchema = z.object({
  page: zPage,
  limit: zLimit,
  q: z.string().trim().max(64).optional(),
  /** Omitted lists every platform's subjects together. */
  platform: zPlatform.optional(),
  sort: z.enum(["recent", "most_logs", "username"]).default("recent"),
});

export const auditQuerySchema = z.object({
  page: zPage,
  limit: zLimit,
  action: z.string().trim().max(64).optional(),
  actorId: z.string().trim().max(64).optional(),
  targetId: z.string().trim().max(64).optional(),
});

/* ───────────────────────────── images ───────────────────────────── */

export const imageUploadMetaSchema = z.object({
  modlogId: zId,
  caption: z.string().trim().max(500).optional(),
  position: z.coerce.number().int().min(0).max(999).optional(),
});

export const imageFetchSchema = z.object({
  modlogId: zId,
  urls: z.array(z.string().url().max(2048)).min(1).max(24),
  captions: z.array(z.string().max(500)).max(24).optional(),
});

export const imagePatchSchema = z
  .object({
    caption: z.string().trim().max(500).nullable(),
    position: z.coerce.number().int().min(0).max(999),
    status: zStatus,
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, "no changes supplied");

/* ───────────────────────────── api keys ───────────────────────────── */

export const apiKeyCreateSchema = z.object({
  name: z.string().trim().min(3).max(64),
  scopes: z.array(zScope).min(1),
  rateLimitPerMin: z.coerce.number().int().min(1).max(10_000).default(120),
  expiresInDays: z.coerce.number().int().min(1).max(3650).optional(),
});

export const roleChangeSchema = z.object({
  role: zRole,
  reason: z.string().trim().min(3).max(500),
});
