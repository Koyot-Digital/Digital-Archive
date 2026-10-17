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

export async function ensureStore(): Promise<void> {
  await mkdir(IMG_ROOT, { recursive: true });
  await mkdir(join(ROOT, "tmp"), { recursive: true });
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
  const target = variantPath(id, variant);
  await mkdir(dirname(target), { recursive: true });
  const tmp = join(ROOT, "tmp", `${id}.${variant}.${process.pid}.tmp`);
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
