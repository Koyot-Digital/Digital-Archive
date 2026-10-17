import { createHash } from "node:crypto";
import { availableParallelism } from "node:os";
import sharp from "sharp";
import { fileTypeFromBuffer } from "file-type";
import { and, eq, sql as raw } from "drizzle-orm";
import { ACCEPTED_IMAGE_MIME, newId } from "@archive/shared";
import { db } from "../db/client.js";
import { images, modlogs, type DbImage } from "../db/schema.js";
import { config } from "../config.js";
import { badRequest, conflict, notFound, payloadTooLarge, unsupportedMedia } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import { deleteImageFiles, writeVariant } from "./storage.js";
import { safeFetch } from "./links.js";

/**
 * Upload pipeline: anything in, WebP out.
 *
 * Everything that enters the archive is re-encoded. That is partly about size
 * - a 4MB screenshot PNG typically lands around 150-350KB as WebP - and
 * partly about safety: re-encoding through sharp discards EXIF (which often
 * carries GPS and device data from screenshots), strips colour profiles and
 * ICC payloads, and guarantees the stored bytes are an image rather than a
 * polyglot file with a payload stapled on.
 */

// Hard ceiling on decoded pixels, independent of file size: a 2KB PNG can
// declare a 50000x50000 canvas and exhaust the box on decode.
const MAX_INPUT_PIXELS = 100_000_000;

// Keep libvips off the box's whole core count: this service shares a
// homeserver with Postgres and the web app, and an ingest burst should not
// starve them.
sharp.cache({ memory: 128, files: 0, items: 128 });
sharp.concurrency(Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2))));

export interface ProcessedImage {
  id: string;
  width: number;
  height: number;
  bytes: number;
  thumbBytes: number;
  originalBytes: number;
  originalFormat: string;
  blurDataUrl: string;
  sha256: string;
}

export interface AttachOptions {
  modlogId: string;
  caption?: string | null;
  position?: number | null;
  sourceUrl?: string | null;
  uploadedBy?: string | null;
  uploadedByKey?: string | null;
}

/** Convert bytes to the stored WebP variants without touching the database. */
export async function convertToWebp(input: Buffer): Promise<ProcessedImage> {
  if (input.byteLength === 0) throw badRequest("Empty upload");
  if (input.byteLength > config.IMAGE_MAX_UPLOAD_BYTES) {
    throw payloadTooLarge(
      `Image exceeds the ${Math.floor(config.IMAGE_MAX_UPLOAD_BYTES / 1_048_576)}MB limit`,
    );
  }

  // Sniff the real type from magic bytes. A declared content-type from a
  // scraper or a browser is a hint, not evidence.
  const sniffed = await fileTypeFromBuffer(input);
  if (!sniffed || !(ACCEPTED_IMAGE_MIME as readonly string[]).includes(sniffed.mime)) {
    throw unsupportedMedia(
      `Unsupported image type${sniffed ? ` (${sniffed.mime})` : ""}. Accepted: ${ACCEPTED_IMAGE_MIME.join(", ")}`,
    );
  }

  const sha256 = createHash("sha256").update(input).digest("hex");

  const pipeline = sharp(input, {
    limitInputPixels: MAX_INPUT_PIXELS,
    sequentialRead: true,
    // Animated GIF/WebP: keep every frame rather than silently losing motion.
    animated: sniffed.mime === "image/gif" || sniffed.mime === "image/webp",
  });

  const meta = await pipeline.metadata();
  if (!meta.width || !meta.height) throw badRequest("Could not read image dimensions");

  const base = () =>
    sharp(input, {
      limitInputPixels: MAX_INPUT_PIXELS,
      sequentialRead: true,
      animated: sniffed.mime === "image/gif" || sniffed.mime === "image/webp",
    })
      // rotate() with no argument applies the EXIF orientation, then the tag
      // is dropped with the rest of the metadata.
      .rotate();

  const [full, thumb, blur] = await Promise.all([
    base()
      .resize({
        width: config.IMAGE_MAX_EDGE,
        height: config.IMAGE_MAX_EDGE,
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({
        quality: config.IMAGE_WEBP_QUALITY,
        effort: 5,
        smartSubsample: true,
        // Screenshots of text are the common case here and they survive
        // near-lossless far better than photographic content.
        nearLossless: false,
      })
      .toBuffer({ resolveWithObject: true }),

    base()
      .resize({
        width: config.IMAGE_THUMB_EDGE,
        height: config.IMAGE_THUMB_EDGE,
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({ quality: config.IMAGE_THUMB_QUALITY, effort: 4, alphaQuality: 80 })
      .toBuffer(),

    // 16px placeholder, inlined as a data URI so the first paint is never blank.
    base().resize(16, 16, { fit: "inside" }).webp({ quality: 35, effort: 2 }).toBuffer(),
  ]);

  const id = newId();
  await Promise.all([writeVariant(id, "full", full.data), writeVariant(id, "thumb", thumb)]);

  return {
    id,
    width: full.info.width,
    height: full.info.height,
    bytes: full.data.byteLength,
    thumbBytes: thumb.byteLength,
    originalBytes: input.byteLength,
    originalFormat: sniffed.ext,
    blurDataUrl: `data:image/webp;base64,${blur.toString("base64")}`,
    sha256,
  };
}

/**
 * Convert, store and attach an image to a modlog.
 *
 * Dedupes on (modlog_id, sha256): re-running a scraper over the same evidence
 * returns the existing row instead of filling the disk with twins.
 */
export async function attachImage(input: Buffer, opts: AttachOptions): Promise<DbImage> {
  const parent = await db
    .select({ id: modlogs.id, subjectId: modlogs.subjectId, imageCount: modlogs.imageCount })
    .from(modlogs)
    .where(eq(modlogs.id, opts.modlogId))
    .limit(1)
    .then((r) => r[0]);
  if (!parent) throw notFound("Modlog");
  if (parent.imageCount >= config.IMAGE_MAX_PER_LOG) {
    throw conflict(`A modlog may hold at most ${config.IMAGE_MAX_PER_LOG} images`);
  }

  // Cheap pre-check before spending CPU on the conversion.
  const digest = createHash("sha256").update(input).digest("hex");
  const duplicate = await db
    .select()
    .from(images)
    .where(and(eq(images.modlogId, opts.modlogId), eq(images.sha256, digest)))
    .limit(1)
    .then((r) => r[0]);
  if (duplicate) return duplicate;

  const processed = await convertToWebp(input);

  const position: number =
    opts.position ??
    (await db
      .select({ next: raw<number>`coalesce(max(${images.position}) + 1, 0)::int` })
      .from(images)
      .where(eq(images.modlogId, opts.modlogId))
      .then((r) => r[0]?.next ?? 0));

  try {
    const inserted = await db
      .insert(images)
      .values({
        id: processed.id,
        modlogId: opts.modlogId,
        // Written for clarity; the images_subject_sync trigger is the thing
        // that guarantees it matches the parent record.
        subjectId: parent.subjectId,
        position,
        caption: opts.caption ?? null,
        sha256: processed.sha256,
        width: processed.width,
        height: processed.height,
        bytes: processed.bytes,
        thumbBytes: processed.thumbBytes,
        originalBytes: processed.originalBytes,
        originalFormat: processed.originalFormat,
        blurDataUrl: processed.blurDataUrl,
        sourceUrl: opts.sourceUrl ?? null,
        uploadedBy: opts.uploadedBy ?? null,
        uploadedByKey: opts.uploadedByKey ?? null,
      })
      .returning();
    return inserted[0]!;
  } catch (err) {
    // Lost a race on the dedupe index, or the insert failed outright. Either
    // way the freshly written files are orphaned, so clean up.
    await deleteImageFiles(processed.id).catch(() => {});
    const existing = await db
      .select()
      .from(images)
      .where(and(eq(images.modlogId, opts.modlogId), eq(images.sha256, digest)))
      .limit(1)
      .then((r) => r[0]);
    if (existing) return existing;
    throw err;
  }
}

/** Download a remote image (SSRF-guarded) and attach it. */
export async function attachImageFromUrl(
  url: string,
  opts: Omit<AttachOptions, "sourceUrl">,
): Promise<DbImage> {
  const res = await safeFetch(url, {
    method: "GET",
    maxBytes: config.IMAGE_MAX_UPLOAD_BYTES,
    timeoutMs: 15_000,
    accept: "image/*",
  });
  if (res.status !== 200) throw badRequest(`Remote image returned HTTP ${res.status}`);
  return attachImage(res.body, { ...opts, sourceUrl: url });
}

/**
 * Soft-delete an image.
 *
 * The row is kept (`status = 'removed'`) so the audit trail and any modlog
 * revision that referenced it stay coherent, but the bytes leave the disk:
 * a takedown should actually remove the content.
 */
export async function removeImage(id: string, hard: boolean): Promise<void> {
  const row = await db.select().from(images).where(eq(images.id, id)).limit(1).then((r) => r[0]);
  if (!row) throw notFound("Image");

  if (hard) {
    await db.delete(images).where(eq(images.id, id));
  } else {
    await db.update(images).set({ status: "removed" }).where(eq(images.id, id));
  }
  await deleteImageFiles(id).catch((err) => {
    logger.error({ id, err: err instanceof Error ? err.message : err }, "image file cleanup failed");
  });
}

/** Aggregate compression statistics, for the admin dashboard. */
export async function imageStats(): Promise<{
  count: number;
  storedBytes: number;
  originalBytes: number;
  savedRatio: number;
}> {
  const row = await db
    .select({
      count: raw<number>`count(*)::int`,
      storedBytes: raw<number>`coalesce(sum(${images.bytes} + ${images.thumbBytes}), 0)::bigint`,
      originalBytes: raw<number>`coalesce(sum(${images.originalBytes}), 0)::bigint`,
    })
    .from(images)
    .where(eq(images.status, "published"))
    .then((r) => r[0]);

  const stored = Number(row?.storedBytes ?? 0);
  const original = Number(row?.originalBytes ?? 0);
  return {
    count: row?.count ?? 0,
    storedBytes: stored,
    originalBytes: original,
    savedRatio: original > 0 ? 1 - stored / original : 0,
  };
}
