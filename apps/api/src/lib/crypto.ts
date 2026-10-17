import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";

export function sha256(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** Constant-time compare that tolerates differing lengths. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) {
    // Still burn a comparison so the timing does not advertise the length.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/**
 * Signed, self-describing value: `<payload>.<hmac>`.
 *
 * Used for the OAuth state cookie and the session cookie, so a tampered
 * cookie is rejected before it reaches the database.
 */
export function sign(payload: string, secret = config.SESSION_SECRET): string {
  const mac = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${mac}`;
}

export function unsign(signed: string, secret = config.SESSION_SECRET): string | null {
  const idx = signed.lastIndexOf(".");
  if (idx <= 0) return null;
  const payload = signed.slice(0, idx);
  const mac = signed.slice(idx + 1);
  const expected = createHmac("sha256", secret).update(payload).digest("base64url");
  return safeEqual(mac, expected) ? payload : null;
}

/**
 * Verify an optional `X-Archive-Signature: sha256=<hex>` header over the raw
 * ingress body. Belt-and-braces alongside the API key: it proves the payload
 * was not altered in transit by anything holding only the key.
 */
export function verifyBodySignature(rawBody: string, header: string | undefined): boolean {
  if (!config.INGRESS_HMAC_SECRET) return true; // not configured => not enforced
  if (!header) return false;
  const provided = header.startsWith("sha256=") ? header.slice(7) : header;
  const expected = createHmac("sha256", config.INGRESS_HMAC_SECRET).update(rawBody).digest("hex");
  return safeEqual(provided.toLowerCase(), expected);
}
