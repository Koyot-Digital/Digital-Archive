import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { and, eq, inArray } from "drizzle-orm";
import { ingressBatchSchema, type IngressResult } from "@archive/shared";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { images, ingressBatches, modlogs } from "../db/schema.js";
import { verifyBodySignature } from "../lib/crypto.js";
import { forbidden, unauthorized } from "../lib/errors.js";
import { claimOnce } from "../lib/redis.js";
import { recordAudit, recordAuditMany } from "../services/audit.js";
import { unfurlLinksFor } from "../services/links.js";
import { upsertFromIngress } from "../services/modlogs.js";
import { actorOf } from "../auth/plugin.js";

/**
 * The ingress endpoint — where the scraper's JSON lands.
 *
 * Design goals, in order:
 *  1. Idempotent. A cron that retries after a timeout must not double-write.
 *  2. Partial success. One malformed record out of 500 fails alone and is
 *     reported by index, so the scraper can fix and resubmit just that one.
 *  3. Cheap to call often. Everything slow — image conversion, link
 *     unfurling — happens after the response is sent.
 */

const BATCH_REPLAY_TTL_SECONDS = 86_400;

/** Stable batch id when the caller did not supply one. */
function fingerprint(raw: string): string {
  return `auto-${createHash("sha256").update(raw).digest("hex").slice(0, 32)}`;
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
    .select({ robloxId: modlogs.robloxId })
    .from(modlogs)
    .where(eq(modlogs.id, modlogId))
    .limit(1)
    .then((r) => r[0]);
  if (!parent) return 0;

  const moved = await db
    .update(images)
    .set({ modlogId })
    .where(and(inArray(images.id, imageIds), eq(images.robloxId, parent.robloxId)))
    .returning({ id: images.id });
  return moved.length;
}

export async function ingressRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/ingress",
    {
      preHandler: app.requireScope("ingress:write"),
      config: { rateLimit: { max: config.RATE_LIMIT_INGRESS_PER_MIN, timeWindow: "1 minute" } },
      bodyLimit: 8 * 1024 * 1024,
    },
    async (req, reply) => {
      // Optional payload signature, in addition to the API key.
      if (config.INGRESS_HMAC_SECRET) {
        // The signature covers the exact bytes sent, which the custom JSON
        // parser kept on req.rawBody.
        const raw = req.rawBody ?? "";
        const header = req.headers["x-archive-signature"];
        if (!verifyBodySignature(raw, typeof header === "string" ? header : undefined)) {
          throw unauthorized("Invalid or missing X-Archive-Signature");
        }
      }

      const batch = ingressBatchSchema.parse(req.body);
      const batchId =
        batch.batchId ??
        (typeof req.headers["x-idempotency-key"] === "string"
          ? req.headers["x-idempotency-key"].slice(0, 64)
          : fingerprint(JSON.stringify(batch.records)));

      const actor = actorOf(req);
      const apiKeyId = req.auth.apiKey?.id ?? null;

      /* ── replay guard ── */
      if (!batch.dryRun) {
        const fresh = await claimOnce(`ingress:batch:${batchId}`, BATCH_REPLAY_TTL_SECONDS);
        if (!fresh) {
          const stored = await db
            .select({ result: ingressBatches.result })
            .from(ingressBatches)
            .where(eq(ingressBatches.batchId, batchId))
            .limit(1)
            .then((r) => r[0]);
          reply.status(200);
          return {
            ...(stored?.result as IngressResult | undefined),
            batchId,
            replayed: true,
          };
        }
        // Durable guard: survives a Redis flush.
        const durable = await db
          .insert(ingressBatches)
          .values({ batchId, apiKeyId, result: {}, recordCount: batch.records.length })
          .onConflictDoNothing()
          .returning({ batchId: ingressBatches.batchId });
        if (!durable.length) {
          const stored = await db
            .select({ result: ingressBatches.result })
            .from(ingressBatches)
            .where(eq(ingressBatches.batchId, batchId))
            .limit(1)
            .then((r) => r[0]);
          return { ...(stored?.result as IngressResult | undefined), batchId, replayed: true };
        }
      }

      /* ── apply ── */
      const result: IngressResult = {
        batchId,
        dryRun: batch.dryRun,
        replayed: false,
        counts: {
          received: batch.records.length,
          created: 0,
          updated: 0,
          skipped: 0,
          failed: 0,
          imagesQueued: 0,
        },
        created: [],
        errors: [],
      };

      const followUps: { modlogId: string; imageUrls: string[] }[] = [];

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
              robloxId: outcome.robloxId,
              url: config.modlogUrl(outcome.robloxId, outcome.id),
            });
          } else if (outcome.outcome === "updated") {
            result.counts.updated += 1;
          } else {
            result.counts.skipped += 1;
          }

          if (outcome.outcome !== "skipped") {
            if (record.imageIds.length) {
              result.counts.imagesQueued += await adoptImages(outcome.id, record.imageIds);
            }
            if (record.imageUrls.length) {
              followUps.push({ modlogId: outcome.id, imageUrls: record.imageUrls });
              result.counts.imagesQueued += record.imageUrls.length;
            }
          }
        } catch (err) {
          result.counts.failed += 1;
          result.errors.push({
            index,
            robloxId: record.robloxId ?? null,
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
          .where(eq(ingressBatches.batchId, batchId));

        await recordAudit({
          ...actor,
          action: "ingress.batch",
          targetType: "batch",
          targetId: batchId,
          metadata: {
            onConflict: batch.onConflict,
            ...result.counts,
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
              metadata: { robloxId: c.robloxId, batchId },
              ip: req.ip,
              userAgent: req.headers["user-agent"],
            })),
          );
        }
      }

      /* ── after the response: images and link previews ── */
      if (followUps.length || result.created.length) {
        reply.raw.on("finish", () => {
          void (async () => {
            for (const job of followUps) {
              await queueRemoteImages(job.modlogId, job.imageUrls, app.log);
            }
            for (const created of result.created) {
              await unfurlLinksFor(created.id).catch(() => {});
            }
          })();
        });
      }

      reply.status(result.counts.failed && !result.counts.created ? 207 : 200);
      return result;
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
      limits: {
        maxRecordsPerBatch: 500,
        maxBodyBytes: 8 * 1024 * 1024,
        maxImagesPerRecord: 24,
      },
    };
  });
}
