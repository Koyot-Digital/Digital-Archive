import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { ID_PATTERN, normalizeId, type ImageVariant } from "@archive/shared";
import { db } from "../../db/client.js";
import { images } from "../../db/schema.js";
import { notFound } from "../../lib/errors.js";
import { cached } from "../../lib/redis.js";
import { openVariant, variantStat } from "../../services/storage.js";
import { visibilityOf } from "../helpers.js";

/**
 * Image delivery.
 *
 * An id never changes what it points at - a re-upload produces a new id - so
 * responses are `immutable` with a one-year TTL and Cloudflare serves almost
 * all of this traffic without touching the homeserver at all.
 */

const serveParams = z.object({
  id: z
    .string()
    .transform((v) => normalizeId(v.replace(/\.webp$/i, "")))
    .refine((v) => ID_PATTERN.test(v), "invalid image id"),
});

const serveQuery = z.object({
  v: z.enum(["full", "thumb"]).default("full"),
});

interface CachedMeta {
  id: string;
  status: string;
  width: number;
  height: number;
  bytes: number;
  thumbBytes: number;
  modlogId: string;
  subjectId: string;
  caption: string | null;
  blurDataUrl: string | null;
  createdAt: string;
  originalFormat: string;
  originalBytes: number;
}

/** Row lookup, cached: the hot path must not hit Postgres per image. */
async function metaFor(id: string): Promise<CachedMeta | null> {
  return cached(`img:meta:${id}`, 300, async () => {
    const row = await db
      .select()
      .from(images)
      .where(eq(images.id, id))
      .limit(1)
      .then((r) => r[0]);
    if (!row) return null;
    return {
      id: row.id,
      status: row.status,
      width: row.width,
      height: row.height,
      bytes: row.bytes,
      thumbBytes: row.thumbBytes,
      modlogId: row.modlogId,
      subjectId: row.subjectId,
      caption: row.caption,
      blurDataUrl: row.blurDataUrl,
      createdAt: row.createdAt.toISOString(),
      originalFormat: row.originalFormat,
      originalBytes: row.originalBytes,
    } satisfies CachedMeta;
  });
}

export async function imageServeRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /images/:id        -> WebP bytes
   * GET /images/:id.webp   -> same, for anything that insists on an extension
   * GET /images/:id?v=thumb
   */
  app.get("/images/:id", async (req, reply) => {
    const { id } = serveParams.parse(req.params);
    const { v } = serveQuery.parse(req.query);
    const variant: ImageVariant = v;

    const meta = await metaFor(id);
    if (!meta) throw notFound("Image");
    // Hidden and removed images are visible to moderators only.
    if (meta.status !== "published" && visibilityOf(req) !== "moderator") throw notFound("Image");

    const stat = await variantStat(id, variant);
    if (!stat) throw notFound("Image file");

    // The bytes for a given (id, variant) never change, so the id and size
    // are a sufficient validator.
    const etag = `"${id}-${variant}-${stat.size}"`;
    reply.header("etag", etag);
    reply.header("content-type", "image/webp");
    reply.header("content-length", stat.size);
    reply.header("last-modified", stat.mtime.toUTCString());
    reply.header("accept-ranges", "none");
    reply.header(
      "cache-control",
      meta.status === "published"
        ? "public, max-age=31536000, s-maxage=31536000, immutable"
        : "private, no-store",
    );

    const inm = req.headers["if-none-match"];
    if (inm && inm.split(",").some((tag) => tag.trim() === etag)) {
      reply.status(304);
      return reply.send();
    }

    return reply.send(openVariant(id, variant));
  });

  /** Metadata without the bytes - used by the embed viewer. */
  app.get("/images/:id/meta", async (req, reply) => {
    const { id } = serveParams.parse(req.params);
    const meta = await metaFor(id);
    if (!meta) throw notFound("Image");
    if (meta.status !== "published" && visibilityOf(req) !== "moderator") throw notFound("Image");

    reply.header("cache-control", "public, max-age=60, s-maxage=600");
    return {
      image: {
        ...meta,
        url: `/images/${meta.id}.webp`,
        thumbUrl: `/images/${meta.id}.webp?v=thumb`,
        // The viewer page lives under the subject's platform path. This
        // service holds image bytes and deliberately does not join subjects,
        // so the link is built by the text API, which already has it.
        compressionRatio:
          meta.originalBytes > 0 ? 1 - meta.bytes / meta.originalBytes : 0,
      },
    };
  });
}
