/**
 * 16-character public identifiers.
 *
 * Crockford-style base32 without the ambiguous letters i / l / o / u, so an ID
 * can be read aloud, pasted out of a Discord message, or typed from a
 * screenshot without collapsing into a different record. 16 chars x 5 bits =
 * 80 bits of entropy: collision risk stays negligible at archive scale while
 * the IDs remain short enough to sit comfortably in a URL path segment.
 */
export const ID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
export const ID_LENGTH = 16;

/** Matches exactly one 16-char public ID. Anchored — safe for route params. */
export const ID_PATTERN = /^[0-9a-hjkmnp-tv-z]{16}$/;

/** Matches a Roblox user id: 1-20 digits, no leading zero. */
export const ROBLOX_ID_PATTERN = /^[1-9][0-9]{0,19}$/;

type RandomBytes = (n: number) => Uint8Array;

let randomBytes: RandomBytes = (n) => {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
};

/** Swap the entropy source (tests only). */
export function setRandomSource(fn: RandomBytes): void {
  randomBytes = fn;
}

/**
 * Generate a 16-char public ID.
 *
 * Each character consumes the low 5 bits of one random byte. Because 256 is
 * not a multiple of 32 we would bias toward the first 8 symbols if we used
 * modulo, so bytes >= 248 are discarded and redrawn instead.
 */
export function newId(length = ID_LENGTH): string {
  let out = "";
  while (out.length < length) {
    const chunk = randomBytes(length * 2);
    for (const byte of chunk) {
      if (byte >= 248) continue; // reject to keep the distribution uniform
      out += ID_ALPHABET[byte & 31];
      if (out.length === length) break;
    }
  }
  return out;
}

export function isId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

/**
 * Normalise user-supplied IDs before lookup: trim, lowercase, and fold the
 * ambiguous characters onto their canonical twins the way Crockford base32
 * does, so `0OIL1` style typos still resolve.
 */
export function normalizeId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[oO]/g, "0")
    .replace(/[il]/g, "1")
    .replace(/u/g, "v");
}

export function isRobloxId(value: unknown): value is string {
  return typeof value === "string" && ROBLOX_ID_PATTERN.test(value);
}

/** Opaque, URL-safe secret (API keys, session tokens, OAuth state). */
export function newSecret(bytes = 32): string {
  const buf = randomBytes(bytes);
  let bin = "";
  for (const b of buf) bin += String.fromCharCode(b);
  // btoa is available in Node >=16 and every browser we target.
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
