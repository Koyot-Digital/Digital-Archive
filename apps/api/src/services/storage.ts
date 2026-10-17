import { createReadStream } from "node:fs";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { ImageVariant } from "@archive/shared";
import { config } from "../config.js";
import { ID_PATTERN } from "@archive/shared";
import { AppError } from "../lib/errors.js";

/**
 * Content store on the homeserver's filesystem.
 *
 * Files are sharded two levels deep by the first four characters of the id
 * (1024 leaf directories) so no single directory ever holds a pathological
 * number of entries, which matters once the archive is in the hundreds of
 * thousands of images.
 *
 *   <STORAGE_ROOT>/img/<c0c1>/<c2c3>/<id>.webp
 *   <STORAGE_ROOT>/img/<c0c1>/<c2c3>/<id>.thumb.webp
 */

const ROOT = resolve(config.STORAGE_ROOT);
const IMG_ROOT = join(ROOT, "img");

export function variantPath(id: string, variant: ImageVariant = "full"): string {
  // Defence in depth: ids come from validated routes, but a path built from
  // user input should never be able to escape the store.
  if (!ID_PATTERN.test(id)) throw new AppError(400, "bad_request", "Malformed image id");
  const suffix = variant === "thumb" ? ".thumb.webp" : ".webp";
  const path = join(IMG_ROOT, id.slice(0, 2), id.slice(2, 4), `${id}${suffix}`);
  if (!path.startsWith(IMG_ROOT)) throw new AppError(400, "bad_request", "Malformed image id");
  return path;
}

const TMP_ROOT = join(ROOT, "tmp");

export async function ensureStore(): Promise<void> {
  await mkdir(IMG_ROOT, { recursive: true });
  await mkdir(TMP_ROOT, { recursive: true });
}

/**
 * Create the store at most once per process.
 *
 * The images service calls `ensureStore()` at boot, but it is not the only
 * writer - an import script or a one-off backfill writes through the same
 * path, and those have no boot sequence. Memoised rather than called on every
 * write: an import converting a thousand attachments should not issue a
 * thousand redundant mkdirs.
 */
let storeReady: Promise<void> | null = null;
function ensureStoreOnce(): Promise<void> {
  storeReady ??= ensureStore().catch((err) => {
    // Do not cache a failure: a transient permissions problem should be
    // retried by the next write rather than poisoning the process.
    storeReady = null;
    throw err;
  });
  return storeReady;
}

/**
 * Write a variant atomically: a half-written file must never be servable,
 * because the serve path trusts the database row's existence.
 */
export async function writeVariant(
  id: string,
  variant: ImageVariant,
  data: Buffer,
): Promise<string> {
  await ensureStoreOnce();
  const target = variantPath(id, variant);
  await mkdir(dirname(target), { recursive: true });
  // Same filesystem as the target, so the rename below is a true atomic
  // replace rather than a copy that can be observed half-done.
  const tmp = join(TMP_ROOT, `${id}.${variant}.${process.pid}.tmp`);
  await writeFile(tmp, data, { flag: "w" });
  await rename(tmp, target);
  return target;
}

export function openVariant(id: string, variant: ImageVariant) {
  return createReadStream(variantPath(id, variant));
}

export async function variantStat(
  id: string,
  variant: ImageVariant,
): Promise<{ size: number; mtime: Date } | null> {
  try {
    const s = await stat(variantPath(id, variant));
    return { size: s.size, mtime: s.mtime };
  } catch {
    return null;
  }
}

/** Remove every variant of an image. Missing files are not an error. */
export async function deleteImageFiles(id: string): Promise<void> {
  await Promise.all([
    rm(variantPath(id, "full"), { force: true }),
    rm(variantPath(id, "thumb"), { force: true }),
  ]);
}

export async function storeUsage(): Promise<{ root: string }> {
  return { root: ROOT };
}
