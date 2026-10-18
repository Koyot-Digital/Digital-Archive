import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, eq, inArray } from "drizzle-orm";
import {
  FORUM_SOURCE,
  subjectOf,
  forumIngressBatchSchema,
  forumPostToIngressRecord,
  ingressBatchSchema,
  type IngressRecord,
  type IngressResult,
} from "@archive/shared";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { images, ingressBatches, modlogs } from "../db/schema.js";
import { verifyBodySignature } from "../lib/crypto.js";
import { forbidden, unauthorized } from "../lib/errors.js";
import { claimOnce } from "../lib/redis.js";
import { recordAudit, recordAuditMany } from "../services/audit.js";
import { unfurlLinksFor } from "../services/links.js";
import { upsertFromIngress } from "../services/modlogs.js";
import { hasBotToken, resolveDiscordUsers } from "../services/discord-users.js";
import { actorOf } from "../auth/plugin.js";

/**
 * The ingress endpoints - where the scraper's JSON lands.
 *
 * Design goals, in order:
 *  1. Idempotent. A cron that retries after a timeout must not double-write.
 *  2. Partial success. One malformed record out of 500 fails alone and is
 *     reported by index, so the scraper can fix and resubmit just that one.
 *  3. Cheap to call often. Everything slow - image conversion, link
 *     unfurling, Discord identity lookups - happens after the response is
 *     sent.
 *
 * There are two entry points over one implementation. `/ingress` takes
 * archive records, for a scraper that already knows the archive's shape.
 * `/ingress/discord-forum` takes Discord forum threads verbatim and maps them
 * server-side, which keeps the rules for reading a thread title and a bot
 * command in exactly one codebase instead of two that drift.
 */

const BATCH_REPLAY_TTL_SECONDS = 86_400;

/** Stable batch id when the caller did not supply one. */
function fingerprint(raw: string): string {
  return `auto-${createHash("sha256").update(raw).digest("hex").slice(0, 32)}`;
}

/**
 * Optional payload signature, in addition to the API key.
 *
 * The signature covers the exact bytes sent, which the custom JSON parser
 * kept on req.rawBody - re-serialising the parsed object would reorder keys
 * and change whitespace, so it would never match.
 */
function assertSignature(req: FastifyRequest): void {
  if (!config.INGRESS_HMAC_SECRET) return;
  const raw = req.rawBody ?? "";
  const header = req.headers["x-archive-signature"];
  if (!verifyBodySignature(raw, typeof header === "string" ? header : undefined)) {
    throw unauthorized("Invalid or missing X-Archive-Signature");
  }
}

/**
 * Hand remote image URLs to the images service.
 *
 * Fire-and-forget over the docker network: image conversion is CPU-bound and
 * belongs on the images container, which is exactly why the two run behind
 * separate tunnels.
 */
async function queueRemoteImages(
  modlogId: string,
  urls: string[],
  log: FastifyInstance["log"],
): Promise<void> {
  if (!urls.length) return;
  try {
    const res = await fetch(`${config.imagesInternalBase()}/internal/images/fetch`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-token": config.INTERNAL_TOKEN,
      },
      body: JSON.stringify({ modlogId, urls }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) {
      log.warn({ modlogId, status: res.status }, "images service rejected a fetch batch");
    }
  } catch (err) {
    log.warn(
      { modlogId, err: err instanceof Error ? err.message : err },
      "could not reach images service",
    );
  }
}

/**
 * Re-parent images that were uploaded before the modlog existed.
 *
 * Only images that are still attached to a log owned by the *same* subject
 * may move, so a credential cannot graft someone else's evidence onto an
 * unrelated record.
 */
async function adoptImages(modlogId: string, imageIds: string[]): Promise<number> {
  if (!imageIds.length) return 0;
  const parent = await db
    .select({ subjectId: modlogs.subjectId })
    .from(modlogs)
    .where(eq(modlogs.id, modlogId))
    .limit(1)
    .then((r) => r[0]);
  if (!parent) return 0;

  const moved = await db
    .update(images)
    .set({ modlogId })
    .where(and(inArray(images.id, imageIds), eq(images.subjectId, parent.subjectId)))
    .returning({ id: images.id });
  return moved.length;
}

/* ───────────────────────────── the shared path ───────────────────────────── */

interface PreparedBatch {
  batchId: string;
  onConflict: "skip" | "merge" | "replace";
  dryRun: boolean;
  /** Whether to hand this batch's attachment URLs to the images service. */
  fetchImages: boolean;
  records: IngressRecord[];
  /**
   * Inputs that never became records at all - a forum thread whose title
   * holds no Roblox id, for instance. Reported rather than dropped, so the
   * scrape can be fixed at the source.
   */
  unmapped: { index: number; sourceId: string; title: string; reason: string }[];
}

/**
 * Apply a prepared batch.
 *
 * Shared by both entry points so the replay guard, the audit trail and the
 * after-response work behave identically no matter which shape came in.
 */
async function applyBatch(
  app: FastifyInstance,
  req: FastifyRequest,
  reply: FastifyReply,
  batch: PreparedBatch,
): Promise<IngressResult> {
  const actor = actorOf(req);
  const apiKeyId = req.auth.apiKey?.id ?? null;

  /* ── replay guard ── */
  if (!batch.dryRun) {
    const fresh = await claimOnce(`ingress:batch:${batch.batchId}`, BATCH_REPLAY_TTL_SECONDS);
    if (!fresh) {
      const stored = await db
        .select({ result: ingressBatches.result })
        .from(ingressBatches)
        .where(eq(ingressBatches.batchId, batch.batchId))
        .limit(1)
        .then((r) => r[0]);
      reply.status(200);
      return {
        ...(stored?.result as IngressResult | undefined),
        batchId: batch.batchId,
        replayed: true,
      } as IngressResult;
    }
    // Durable guard: survives a Redis flush.
    const durable = await db
      .insert(ingressBatches)
      .values({
        batchId: batch.batchId,
        apiKeyId,
        result: {},
        recordCount: batch.records.length,
      })
      .onConflictDoNothing()
      .returning({ batchId: ingressBatches.batchId });
    if (!durable.length) {
      const stored = await db
        .select({ result: ingressBatches.result })
        .from(ingressBatches)
        .where(eq(ingressBatches.batchId, batch.batchId))
        .limit(1)
        .then((r) => r[0]);
      return {
        ...(stored?.result as IngressResult | undefined),
        batchId: batch.batchId,
        replayed: true,
      } as IngressResult;
    }
  }

  /* ── apply ── */
  const result: IngressResult = {
    batchId: batch.batchId,
    dryRun: batch.dryRun,
    replayed: false,
    counts: {
      // Everything the caller sent, mapped or not, so the number matches
      // what they posted.
      received: batch.records.length + batch.unmapped.length,
      created: 0,
      updated: 0,
      skipped: 0,
      failed: batch.unmapped.length,
      imagesQueued: 0,
    },
    created: [],
    errors: [],
    unmapped: batch.unmapped,
  };

  const followUps: { modlogId: string; imageUrls: string[] }[] = [];
  const discordIds = new Set<string>();

  for (const [index, record] of batch.records.entries()) {
    if (batch.dryRun) {
      // Schema validation already happened; nothing else to verify safely
      // without writing.
      result.counts.skipped += 1;
      continue;
    }
    try {
      const outcome = await upsertFromIngress(record, batch.onConflict, {
        apiKeyId,
        userId: req.auth.user?.id ?? null,
      });

      if (outcome.outcome === "created") {
        result.counts.created += 1;
        result.created.push({
          id: outcome.id,
          platform: outcome.platform,
          externalId: outcome.externalId,
          url: config.modlogUrl(outcome.platform, outcome.externalId, outcome.id),
        });
      } else if (outcome.outcome === "updated") {
        result.counts.updated += 1;
      } else {
        result.counts.skipped += 1;
      }

      for (const id of outcome.discordIds) discordIds.add(id);

      if (outcome.outcome !== "skipped") {
        if (record.imageIds.length) {
          result.counts.imagesQueued += await adoptImages(outcome.id, record.imageIds);
        }
        if (batch.fetchImages && record.imageUrls.length) {
          followUps.push({ modlogId: outcome.id, imageUrls: record.imageUrls });
          result.counts.imagesQueued += record.imageUrls.length;
        }
      }
    } catch (err) {
      result.counts.failed += 1;
      result.errors.push({
        index,
        subject: subjectOf(record)?.externalId ?? null,
        message: err instanceof Error ? err.message : "unknown error",
      });
      req.log.warn(
        { index, err: err instanceof Error ? err.message : err },
        "ingress record failed",
      );
    }
  }

  /* ── record the outcome ── */
  if (!batch.dryRun) {
    await db
      .update(ingressBatches)
      .set({ result: result as unknown as Record<string, unknown> })
      .where(eq(ingressBatches.batchId, batch.batchId));

    await recordAudit({
      ...actor,
      action: "ingress.batch",
      targetType: "batch",
      targetId: batch.batchId,
      metadata: {
        onConflict: batch.onConflict,
        ...result.counts,
        unmapped: batch.unmapped.length,
      },
      ip: req.ip,
      userAgent: req.headers["user-agent"],
    });

    if (result.created.length) {
      await recordAuditMany(
        result.created.map((c) => ({
          ...actor,
          action: "modlog.create",
          targetType: "modlog",
          targetId: c.id,
          metadata: {
            platform: c.platform,
            externalId: c.externalId,
            batchId: batch.batchId,
          },
          ip: req.ip,
          userAgent: req.headers["user-agent"],
        })),
      );
    }
  }

  /* ── after the response: images, link previews, Discord identities ── */
  if (followUps.length || result.created.length || discordIds.size) {
    reply.raw.on("finish", () => {
      void (async () => {
        for (const job of followUps) {
          await queueRemoteImages(job.modlogId, job.imageUrls, app.log);
        }
        for (const created of result.created) {
          await unfurlLinksFor(created.id).catch(() => {});
        }
        // Identities are seeded synchronously during ingest from what the
        // scrape saw, so a record always renders. This is the refresh pass
        // against the Discord API, and it must never delay a scraper.
        if (discordIds.size) {
          const summary = await resolveDiscordUsers([...discordIds]).catch((err) => {
            app.log.warn(
              { err: err instanceof Error ? err.message : err },
              "discord identity refresh failed",
            );
            return null;
          });
          if (summary) app.log.info({ batchId: batch.batchId, ...summary }, "discord identities");
        }
      })();
    });
  }

  /**
   * 207 means "nothing landed", not "something failed".
   *
   * Written as created-or-updated rather than created alone: a re-scrape
   * legitimately creates nothing, and a batch that refreshed 499 records
   * alongside one unreadable thread title has not partially failed in any
   * sense a caller should alert on.
   */
  const landed = result.counts.created + result.counts.updated;
  reply.status(result.counts.failed && !landed ? 207 : 200);
  return result;
}

/* ───────────────────────────── routes ───────────────────────────── */

export async function ingressRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/ingress",
    {
      preHandler: app.requireScope("ingress:write"),
      config: { rateLimit: { max: config.RATE_LIMIT_INGRESS_PER_MIN, timeWindow: "1 minute" } },
      bodyLimit: 8 * 1024 * 1024,
    },
    async (req, reply) => {
      assertSignature(req);

      const batch = ingressBatchSchema.parse(req.body);
      const batchId =
        batch.batchId ??
        (typeof req.headers["x-idempotency-key"] === "string"
          ? req.headers["x-idempotency-key"].slice(0, 64)
          : fingerprint(JSON.stringify(batch.records)));

      return applyBatch(app, req, reply, {
        batchId,
        onConflict: batch.onConflict,
        dryRun: batch.dryRun,
        // The record-level endpoint has no flag of its own; images named in a
        // record have always been fetched and callers depend on that.
        fetchImages: true,
        records: batch.records,
        unmapped: [],
      });
    },
  );

  /**
   * Raw Discord forum threads, exactly as the scraper emits them.
   *
   * The mapping - which Roblox account the thread is about, what sanction the
   * body records, which other accounts it groups - happens here rather than
   * in the scraper. Those rules are the archive's interpretation of its own
   * source, and they change: putting them in the scraper would mean a
   * re-parse required a scraper deploy, and would let the two readings of the
   * same title diverge silently.
   *
   * A thread the mapper cannot place does not fail the batch. It comes back
   * under `unmapped` with the reason, which is almost always a title that
   * names no Roblox id.
   */
  app.post(
    "/ingress/discord-forum",
    {
      preHandler: app.requireScope("ingress:write"),
      config: { rateLimit: { max: config.RATE_LIMIT_INGRESS_PER_MIN, timeWindow: "1 minute" } },
      // Threads carry their whole reply history, so a batch of 500 is large.
      bodyLimit: 64 * 1024 * 1024,
    },
    async (req, reply) => {
      assertSignature(req);

      const batch = forumIngressBatchSchema.parse(req.body);
      const records: IngressRecord[] = [];
      const unmapped: PreparedBatch["unmapped"] = [];

      for (const [index, post] of batch.posts.entries()) {
        const mapped = forumPostToIngressRecord(post);
        if (mapped.ok) {
          records.push(mapped.record);
        } else {
          unmapped.push({
            index,
            sourceId: mapped.postId,
            title: mapped.title,
            reason: mapped.reason,
          });
        }
      }

      const batchId =
        batch.batchId ??
        (typeof req.headers["x-idempotency-key"] === "string"
          ? req.headers["x-idempotency-key"].slice(0, 64)
          : fingerprint(batch.posts.map((p) => p.post_id).join(",")));

      // Nothing mappable at all is a client error, not a 200 with zero work.
      if (!records.length) {
        reply.status(422);
        return {
          batchId,
          error: {
            code: "nothing_mappable",
            message: `None of the ${batch.posts.length} thread(s) named a Roblox id in their title`,
          },
          unmapped,
        };
      }

      return applyBatch(app, req, reply, {
        batchId,
        onConflict: batch.onConflict,
        dryRun: batch.dryRun,
        fetchImages: batch.fetchImages,
        records,
        unmapped,
      });
    },
  );

  /**
   * Scraper self-check: confirms the credential, its scopes and its budget
   * without writing anything. Point the cron's health check at this.
   */
  app.get("/ingress/whoami", { preHandler: app.requireScope("ingress:write") }, async (req) => {
    const key = req.auth.apiKey;
    if (!key && !req.auth.devBypass) throw forbidden("API key required");
    return {
      ok: true,
      authEnabled: config.AUTH_ENABLED,
      key: key
        ? { id: key.id, name: key.name, scopes: key.scopes, rateLimitPerMin: key.rateLimitPerMin }
        : { id: "dev", name: "dev-bypass", scopes: ["*"], rateLimitPerMin: 0 },
      signatureRequired: Boolean(config.INGRESS_HMAC_SECRET),
      endpoints: {
        records: "POST /ingress",
        discordForum: "POST /ingress/discord-forum",
      },
      discord: {
        /** False means scraped usernames and avatars are kept as-is. */
        identityRefresh: hasBotToken(),
        forumSource: FORUM_SOURCE,
      },
      limits: {
        maxRecordsPerBatch: 500,
        maxBodyBytes: 8 * 1024 * 1024,
        maxForumBodyBytes: 64 * 1024 * 1024,
        maxImagesPerRecord: 24,
      },
    };
  });
}
