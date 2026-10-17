import { z } from "zod";
import {
  MODLOG_ACTIONS,
  MODLOG_SEVERITIES,
  RECORD_STATUSES,
  USER_ROLES,
  API_KEY_SCOPES,
} from "./constants.js";
import { ID_PATTERN, ROBLOX_ID_PATTERN } from "./ids.js";

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
export const zRole = z.enum(USER_ROLES);
export const zScope = z.enum(API_KEY_SCOPES);

/* ───────────────────────────── ingress ───────────────────────────── */

/**
 * One scraped moderation record.
 *
 * `source` plus `sourceId` form the dedupe key: re-running a scraper over the
 * same page updates the existing row instead of creating a twin. A record
 * without a `sourceId` falls back to a content hash computed server-side.
 */
export const ingressRecordSchema = z.object({
  robloxId: zRobloxId,
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
});
export type IngressRecord = z.infer<typeof ingressRecordSchema>;

export const ingressBatchSchema = z.object({
  /** Caller-chosen key; replaying the same key is a no-op for 24 hours. */
  batchId: z.string().trim().min(8).max(64).optional(),
  /** skip keeps the stored row, merge fills blanks, replace overwrites. */
  onConflict: z.enum(["skip", "merge", "replace"]).default("merge"),
  dryRun: z.boolean().default(false),
  records: z.array(ingressRecordSchema).min(1).max(500),
});
export type IngressBatch = z.infer<typeof ingressBatchSchema>;

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
  created: z.array(z.object({ id: zId, robloxId: z.string(), url: z.string() })),
  errors: z.array(
    z.object({ index: z.number(), robloxId: z.string().nullable(), message: z.string() }),
  ),
});
export type IngressResult = z.infer<typeof ingressResultSchema>;

/* ───────────────────────── modlog read/write ───────────────────────── */

export const modlogCreateSchema = ingressRecordSchema
  .omit({ source: true, sourceId: true, imageUrls: true })
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
