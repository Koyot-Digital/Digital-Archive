import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq, inArray } from "drizzle-orm";
import {
  ID_PATTERN,
  imageFetchSchema,
  imagePatchSchema,
  imageUploadMetaSchema,
  normalizeId,
  subjectArchivePath,
  type SubjectPlatform,
} from "@archive/shared";
import { config } from "../../config.js";
import { db } from "../../db/client.js";
import { images, subjects } from "../../db/schema.js";
import { badRequest, payloadTooLarge, unauthorized } from "../../lib/errors.js";
import { safeEqual } from "../../lib/crypto.js";
import { invalidate } from "../../lib/redis.js";
import { recordAudit } from "../../services/audit.js";
import {
  attachImage,
  attachImageFromUrl,
  attachmentIdentity,
  imageStats,
  removeImage,
  storedAttachmentIdentities,
} from "../../services/images.js";
import { actorOf } from "../../auth/plugin.js";
import { idParam } from "../helpers.js";

/**
 * Image writes.
 *
 * Three ways in:
 *  - multipart upload, for the web UI and for scrapers that hold the bytes
 *  - POST /images/fetch, for a scraper that only has URLs
 *  - POST /internal/images/fetch, called by the text service during ingress
 *
 * All three converge on the same sharp pipeline, so nothing reaches the disk
 * without being re-encoded to WebP.
 */

export async function imageWriteRoutes(app: FastifyInstance): Promise<void> {
  /** Multipart: one or more files plus a `modlogId` field. */
  app.post(
    "/images",
    {
      preHandler: app.requireWriter("moderator", "images:write"),
      config: { rateLimit: { max: config.RATE_LIMIT_UPLOAD_PER_MIN, timeWindow: "1 minute" } },
    },
    async (req, reply) => {
      if (!req.isMultipart()) {
        throw badRequest("Expected a multipart/form-data upload");
      }

      const fields: Record<string, string> = {};
      const uploaded: Awaited<ReturnType<typeof attachImage>>[] = [];
      const errors: { filename: string; message: string }[] = [];

      // Collect fields and files in one pass. @fastify/multipart enforces the
      // byte ceiling itself, so an oversized file never fully buffers.
      for await (const part of req.parts()) {
        if (part.type === "field") {
          if (typeof part.value === "string") fields[part.fieldname] = part.value;
          continue;
        }

        const meta = imageUploadMetaSchema.safeParse(fields);
        if (!meta.success) {
          // Drain the stream so the connection is not left hanging.
          await part.toBuffer().catch(() => {});
          throw badRequest("Send the modlogId field before the file part(s)");
        }

        try {
          const buffer = await part.toBuffer();
          if (part.file.truncated) {
            throw payloadTooLarge(
              `${part.filename} exceeds the ${Math.floor(config.IMAGE_MAX_UPLOAD_BYTES / 1_048_576)}MB limit`,
            );
          }
          const row = await attachImage(buffer, {
            modlogId: meta.data.modlogId,
            caption: meta.data.caption ?? null,
            position: meta.data.position ?? null,
            uploadedBy: req.auth.user?.id ?? null,
            uploadedByKey: req.auth.apiKey?.id ?? null,
          });
          uploaded.push(row);
        } catch (err) {
          errors.push({
            filename: part.filename ?? "unnamed",
            message: err instanceof Error ? err.message : "conversion failed",
          });
        }
      }

      if (!uploaded.length && errors.length) {
        throw badRequest(`No image could be stored: ${errors[0]!.message}`);
      }
      if (!uploaded.length) throw badRequest("No file parts were supplied");

      for (const row of uploaded) {
        await recordAudit({
          ...actorOf(req),
          action: "image.upload",
          targetType: "image",
          targetId: row.id,
          metadata: {
            modlogId: row.modlogId,
            bytes: row.bytes,
            originalBytes: row.originalBytes,
            originalFormat: row.originalFormat,
            dimensions: `${row.width}x${row.height}`,
          },
          ip: req.ip,
          userAgent: req.headers["user-agent"],
        });
      }

      reply.status(201);
      const subjectMap = await subjectsFor(uploaded);
      return {
        images: uploaded.map((row) => serialise(row, subjectMap.get(row.subjectId))),
        errors,
      };
    },
  );

  /** Fetch remote images and attach them. */
  app.post(
    "/images/fetch",
    {
      preHandler: app.requireWriter("moderator", "images:write"),
      config: { rateLimit: { max: config.RATE_LIMIT_UPLOAD_PER_MIN, timeWindow: "1 minute" } },
    },
    async (req, reply) => {
      const input = imageFetchSchema.parse(req.body);
      const result = await fetchMany(input, {
        uploadedBy: req.auth.user?.id ?? null,
        uploadedByKey: req.auth.apiKey?.id ?? null,
      });

      for (const row of result.images) {
        await recordAudit({
          ...actorOf(req),
          action: "image.upload",
          targetType: "image",
          targetId: row.id,
          metadata: { modlogId: row.modlogId, sourceUrl: row.sourceUrl, bytes: row.bytes },
          ip: req.ip,
          userAgent: req.headers["user-agent"],
        });
      }

      reply.status(result.images.length ? 201 : 207);
      const subjectMap = await subjectsFor(result.images);
      return {
        images: result.images.map((row) => serialise(row, subjectMap.get(row.subjectId))),
        errors: result.errors,
      };
    },
  );

  /**
   * Internal: the text service calls this during ingress so image CPU stays
   * on this container. Authenticated by a shared secret rather than an API
   * key, and never exposed through the public tunnel (see the Caddyfile).
   */
  app.post("/internal/images/fetch", async (req, reply) => {
    const token = req.headers["x-internal-token"];
    if (typeof token !== "string" || !safeEqual(token, config.INTERNAL_TOKEN)) {
      throw unauthorized("Invalid internal token");
    }
    const input = imageFetchSchema.parse(req.body);
    const result = await fetchMany(input, { uploadedBy: null, uploadedByKey: null });

    for (const row of result.images) {
      await recordAudit({
        actorType: "system",
        actorLabel: "ingress",
        action: "image.upload",
        targetType: "image",
        targetId: row.id,
        metadata: { modlogId: row.modlogId, sourceUrl: row.sourceUrl, bytes: row.bytes },
      });
    }

    reply.status(200);
    return {
      stored: result.images.length,
      failed: result.errors.length,
      errors: result.errors,
    };
  });

  /* ─────────────────────────── maintenance ─────────────────────────── */

  app.patch("/images/:id", { preHandler: app.requireRole("moderator") }, async (req) => {
    const { id } = idParam.parse(req.params);
    const patch = imagePatchSchema.parse(req.body);

    const updated = await db
      .update(images)
      .set({
        ...(patch.caption !== undefined ? { caption: patch.caption } : {}),
        ...(patch.position !== undefined ? { position: patch.position } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
      })
      .where(eq(images.id, id))
      .returning();
    const row = updated[0];
    if (!row) throw badRequest("Image not found");

    await invalidate(`img:meta:${id}`);
    const subjectMap = await subjectsFor([row]);
    return { image: serialise(row, subjectMap.get(row.subjectId)) };
  });

  /**
   * Remove an image. The row survives as a tombstone so revision history
   * stays coherent, but the bytes leave the disk.
   */
  app.delete("/images/:id", { preHandler: app.requireRole("moderator") }, async (req) => {
    const { id } = idParam.parse(req.params);
    const hard = z
      .object({ purge: z.coerce.boolean().default(false) })
      .parse(req.query).purge;

    await removeImage(id, hard && req.auth.role === "admin");
    await invalidate(`img:meta:${id}`);

    await recordAudit({
      ...actorOf(req),
      action: "image.delete",
      targetType: "image",
      targetId: id,
      metadata: { purged: hard && req.auth.role === "admin" },
      ip: req.ip,
      userAgent: req.headers["user-agent"],
    });
    return { removed: true, id };
  });

  /** Compression report: how much disk the WebP pipeline is saving. */
  app.get("/images/stats", { preHandler: app.requireRole("moderator") }, async (_req, reply) => {
    reply.header("cache-control", "private, no-store");
    return imageStats();
  });
}

/* ─────────────────────────── helpers ─────────────────────────── */

type ImageRow = typeof images.$inferSelect;
interface SubjectIdentity {
  platform: SubjectPlatform;
  externalId: string;
}

/** One query for however many images a response is about to serialise. */
async function subjectsFor(rows: ImageRow[]): Promise<Map<string, SubjectIdentity>> {
  const ids = [...new Set(rows.map((r) => r.subjectId))];
  if (!ids.length) return new Map();
  const found = await db
    .select({ id: subjects.id, platform: subjects.platform, externalId: subjects.externalId })
    .from(subjects)
    .where(inArray(subjects.id, ids));
  return new Map(
    found.map((s) => [s.id, { platform: s.platform, externalId: s.externalId.toString() }]),
  );
}

/**
 * Shape one image for an upload/patch response.
 *
 * `subject` is passed in rather than joined here: the viewer page lives under
 * the subject's platform path, which the image row only knows by surrogate id.
 */
function serialise(row: ImageRow, subject?: SubjectIdentity) {
  return {
    id: row.id,
    modlogId: row.modlogId,
    subjectId: row.subjectId,
    url: config.imageUrl(row.id, "full"),
    thumbUrl: config.imageUrl(row.id, "thumb"),
    pageUrl: subject
      ? `${subjectArchivePath(subject.platform, subject.externalId)}/${row.modlogId}/${row.id}`
      : null,
    width: row.width,
    height: row.height,
    bytes: row.bytes,
    thumbBytes: row.thumbBytes,
    originalBytes: row.originalBytes,
    originalFormat: row.originalFormat,
    compressionRatio: row.originalBytes > 0 ? 1 - row.bytes / row.originalBytes : 0,
    caption: row.caption,
    blurDataUrl: row.blurDataUrl,
    position: row.position,
    status: row.status,
    sourceUrl: row.sourceUrl,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Fetch a list of URLs one at a time.
 *
 * Sequential on purpose: each conversion already uses several libvips
 * threads, and running 24 downloads plus 24 encodes concurrently is how a
 * homeserver ends up swapping.
 */
async function fetchMany(
  input: { modlogId: string; urls: string[]; captions?: string[] | undefined },
  actor: { uploadedBy: string | null; uploadedByKey: string | null },
): Promise<{
  images: ImageRow[];
  skipped: number;
  errors: { url: string; message: string }[];
}> {
  const stored: ImageRow[] = [];
  const errors: { url: string; message: string }[] = [];

  // Attachments already on this record are not fetched again. attachImage
  // would dedupe them on the original bytes' sha256 regardless, but only
  // after paying for the download, and a re-ingest of the same threads is
  // mostly attachments already held. Matching is on the URL path because
  // Discord re-signs its links (ex/is/hm) on every scrape.
  const held = await storedAttachmentIdentities(input.modlogId);
  let skipped = 0;

  for (const [i, url] of input.urls.entries()) {
    const identity = attachmentIdentity(url);
    if (identity && held.has(identity)) {
      skipped += 1;
      continue;
    }
    try {
      const row = await attachImageFromUrl(url, {
        modlogId: input.modlogId,
        caption: input.captions?.[i] ?? null,
        position: i,
        uploadedBy: actor.uploadedBy,
        uploadedByKey: actor.uploadedByKey,
      });
      stored.push(row);
    } catch (err) {
      errors.push({ url, message: err instanceof Error ? err.message : "fetch failed" });
    }
  }
  return { images: stored, skipped, errors };
}

/** Exported for the id validation used by the serve route's sibling checks. */
export const isImageId = (value: string): boolean => ID_PATTERN.test(normalizeId(value));
