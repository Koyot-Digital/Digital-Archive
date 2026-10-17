import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { eq } from "drizzle-orm";
import type { ParsedLink } from "@archive/shared";
import { db } from "../db/client.js";
import { links } from "../db/schema.js";
import { config } from "../config.js";
import { logger } from "../lib/logger.js";
import { AppError } from "../lib/errors.js";

/**
 * Link storage + OpenGraph unfurling.
 *
 * Unfurling means the homeserver makes outbound requests to URLs that
 * arbitrary scraped content chose, so this module is written defensively:
 * every hop is DNS-resolved and rejected if it lands on a private range,
 * redirects are followed by hand, and only the first 128KB of HTML is read.
 */

const UNFURL_MAX_BYTES = 131_072;
const MAX_REDIRECTS = 3;

/** RFC1918 + loopback + link-local + CGNAT + IPv6 private space. */
function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a = 0, b = 0] = ip.split(".").map(Number);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true; // multicast / reserved
    return false;
  }
  const v6 = ip.toLowerCase();
  if (v6 === "::" || v6 === "::1") return true;
  if (v6.startsWith("fe80") || v6.startsWith("fc") || v6.startsWith("fd")) return true;
  // IPv4-mapped IPv6, e.g. ::ffff:192.168.1.1
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
  if (mapped?.[1]) return isPrivateAddress(mapped[1]);
  return false;
}

async function assertPublicHost(hostname: string): Promise<void> {
  if (isIP(hostname)) {
    if (isPrivateAddress(hostname)) throw new AppError(400, "blocked_host", "Private address");
    return;
  }
  const records = await lookup(hostname, { all: true, verbatim: true });
  if (!records.length) throw new AppError(400, "blocked_host", "Host does not resolve");
  for (const record of records) {
    if (isPrivateAddress(record.address)) {
      throw new AppError(400, "blocked_host", "Host resolves to a private address");
    }
  }
}

/**
 * Fetch a remote resource with SSRF guards. Shared with the image fetcher so
 * both paths get the same protection.
 */
export async function safeFetch(
  rawUrl: string,
  opts: { method?: "GET" | "HEAD"; maxBytes: number; timeoutMs: number; accept?: string } = {
    maxBytes: UNFURL_MAX_BYTES,
    timeoutMs: config.EMBED_UNFURL_TIMEOUT_MS,
  },
): Promise<{ url: string; status: number; contentType: string; body: Buffer }> {
  let current = rawUrl;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const url = new URL(current);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new AppError(400, "blocked_scheme", "Only http(s) URLs may be fetched");
    }
    await assertPublicHost(url.hostname);

    const res = await fetch(url, {
      method: opts.method ?? "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(opts.timeoutMs),
      headers: {
        "user-agent": "DigitalArchiveBot/1.0 (+archive link preview)",
        accept: opts.accept ?? "text/html,application/xhtml+xml",
        "accept-language": "en",
      },
    });

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) throw new AppError(502, "bad_redirect", "Redirect without a Location header");
      current = new URL(location, url).toString();
      continue;
    }

    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > opts.maxBytes) {
      throw new AppError(413, "too_large", `Remote resource exceeds ${opts.maxBytes} bytes`);
    }

    const body = await readCapped(res, opts.maxBytes);
    return {
      url: url.toString(),
      status: res.status,
      contentType: res.headers.get("content-type") ?? "",
      body,
    };
  }

  throw new AppError(502, "too_many_redirects", "Too many redirects");
}

/** Read a response body, aborting as soon as the cap is exceeded. */
async function readCapped(res: Response, maxBytes: number): Promise<Buffer> {
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new AppError(413, "too_large", `Remote resource exceeds ${maxBytes} bytes`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks);
}

/* ─────────────────────────── persistence ─────────────────────────── */

/**
 * Replace the stored link set for a modlog.
 *
 * Existing rows for URLs that survived the edit are preserved so their
 * OpenGraph cache is not thrown away on every body tweak.
 */
export async function syncLinks(modlogId: string, parsed: ParsedLink[]): Promise<void> {
  const existing = await db
    .select({ url: links.url })
    .from(links)
    .where(eq(links.modlogId, modlogId));
  const existingUrls = new Set(existing.map((r) => r.url));
  const incomingUrls = new Set(parsed.map((p) => p.url));

  const stale = [...existingUrls].filter((u) => !incomingUrls.has(u));
  if (stale.length) {
    await db.delete(links).where(eq(links.modlogId, modlogId));
    // Simplest correct path: wipe and reinsert. Link sets are tiny (<= ~30).
    existingUrls.clear();
  }

  const fresh = parsed.filter((p) => !existingUrls.has(p.url));
  if (!fresh.length) return;

  await db
    .insert(links)
    .values(
      fresh.map((p, i) => ({
        modlogId,
        position: i,
        url: p.url,
        domain: p.domain,
        kind: p.kind,
        ref: p.ref,
      })),
    )
    .onConflictDoNothing();
}

const OG_PATTERNS: Record<"title" | "description" | "image" | "site", RegExp[]> = {
  title: [
    /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*)["']/i,
    /<meta[^>]+name=["']twitter:title["'][^>]+content=["']([^"']*)["']/i,
    /<title[^>]*>([^<]*)<\/title>/i,
  ],
  description: [
    /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)["']/i,
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i,
  ],
  image: [
    /<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]+content=["']([^"']*)["']/i,
    /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']*)["']/i,
  ],
  site: [/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']*)["']/i],
};

function firstMatch(html: string, patterns: RegExp[]): string | null {
  for (const re of patterns) {
    const m = re.exec(html);
    if (m?.[1]) return decodeEntities(m[1]).trim().slice(0, 500) || null;
  }
  return null;
}

function decodeEntities(input: string): string {
  return input
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&nbsp;/g, " ");
}

/**
 * Fill the OpenGraph cache for a modlog's links.
 *
 * Runs after the write has already been acknowledged, so a slow or hostile
 * remote host delays nothing the caller is waiting on. Failures are recorded
 * (`unfurl_failed`) so we do not retry a dead domain on every page view.
 */
export async function unfurlLinksFor(modlogId: string): Promise<void> {
  if (!config.EMBED_UNFURL_ENABLED) return;

  const pending = await db
    .select({ id: links.id, url: links.url, kind: links.kind })
    .from(links)
    .where(eq(links.modlogId, modlogId));

  for (const row of pending) {
    // Images and video files have nothing to unfurl.
    if (row.kind === "image" || row.kind === "video") continue;
    try {
      const res = await safeFetch(row.url, {
        method: "GET",
        maxBytes: UNFURL_MAX_BYTES,
        timeoutMs: config.EMBED_UNFURL_TIMEOUT_MS,
      });
      if (!res.contentType.includes("html")) {
        await db
          .update(links)
          .set({ unfurledAt: new Date(), unfurlFailed: false })
          .where(eq(links.id, row.id));
        continue;
      }
      const html = res.body.toString("utf8");
      const image = firstMatch(html, OG_PATTERNS.image);
      await db
        .update(links)
        .set({
          title: firstMatch(html, OG_PATTERNS.title),
          description: firstMatch(html, OG_PATTERNS.description),
          imageUrl: image ? new URL(image, res.url).toString().slice(0, 2048) : null,
          siteName: firstMatch(html, OG_PATTERNS.site),
          unfurledAt: new Date(),
          unfurlFailed: false,
        })
        .where(eq(links.id, row.id));
    } catch (err) {
      logger.debug(
        { url: row.url, err: err instanceof Error ? err.message : err },
        "unfurl failed",
      );
      await db
        .update(links)
        .set({ unfurledAt: new Date(), unfurlFailed: true })
        .where(eq(links.id, row.id))
        .catch(() => {});
    }
  }
}
