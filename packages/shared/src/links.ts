/**
 * Link extraction + classification.
 *
 * The archive renders every link it stores as an embed card, so we need to
 * know what a URL *is* before the web app decides how to draw it. Lives in
 * the shared package because the API classifies on write and the web app
 * needs the same vocabulary on read.
 */

export const LINK_KINDS = [
  "roblox_user",
  "roblox_game",
  "roblox_group",
  "roblox_asset",
  "youtube",
  "twitter",
  "discord",
  "image",
  "video",
  "archive_internal",
  "generic",
] as const;
export type LinkKind = (typeof LINK_KINDS)[number];

export interface ParsedLink {
  url: string;
  domain: string;
  kind: LinkKind;
  /** Extracted canonical reference, e.g. a Roblox id or YouTube video id. */
  ref: string | null;
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|tiff?)(?:$|\?)/i;
const VIDEO_EXT = /\.(mp4|webm|mov|m4v)(?:$|\?)/i;

/** Hosts we will never unfurl or linkify — avoids SSRF against the LAN. */
const BLOCKED_HOST = /^(localhost$|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|\[?::1\]?$|.*\.local$|.*\.internal$)/i;

export function isSafeHttpUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  if (BLOCKED_HOST.test(u.hostname)) return false;
  return true;
}

function bareHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./, "");
}

export function classifyLink(raw: string): ParsedLink | null {
  if (!isSafeHttpUrl(raw)) return null;
  const u = new URL(raw);
  const domain = bareHost(u.hostname);
  const path = u.pathname;

  const match = (kind: LinkKind, ref: string | null = null): ParsedLink => ({
    url: u.toString(),
    domain,
    kind,
    ref,
  });

  if (domain === "roblox.com" || domain.endsWith(".roblox.com")) {
    const users = /^\/users\/(\d+)/.exec(path);
    if (users) return match("roblox_user", users[1]!);
    const games = /^\/games\/(\d+)/.exec(path);
    if (games) return match("roblox_game", games[1]!);
    const groups = /^\/groups\/(\d+)/.exec(path);
    if (groups) return match("roblox_group", groups[1]!);
    const asset = /^\/(?:catalog|library)\/(\d+)/.exec(path);
    if (asset) return match("roblox_asset", asset[1]!);
    return match("generic");
  }

  if (domain === "youtube.com" || domain === "m.youtube.com") {
    const v = u.searchParams.get("v");
    if (v) return match("youtube", v);
    const shorts = /^\/shorts\/([\w-]+)/.exec(path);
    if (shorts) return match("youtube", shorts[1]!);
    return match("youtube");
  }
  if (domain === "youtu.be") return match("youtube", path.slice(1) || null);

  if (domain === "twitter.com" || domain === "x.com") {
    const status = /\/status\/(\d+)/.exec(path);
    return match("twitter", status?.[1] ?? null);
  }

  if (domain === "discord.com" || domain === "discord.gg" || domain === "discordapp.com") {
    return match("discord");
  }

  if (IMAGE_EXT.test(path)) return match("image");
  if (VIDEO_EXT.test(path)) return match("video");

  return match("generic");
}

/**
 * Pull every distinct URL out of a markdown body, preserving first-seen order.
 *
 * Covers inline `[text](url)`, autolinks `<url>` and bare `https://...`. Code
 * fences are stripped first so snippets in evidence dumps do not become
 * embeds.
 */
export function extractLinks(markdown: string): ParsedLink[] {
  const withoutCode = markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]*`/g, " ");

  const found = new Map<string, ParsedLink>();
  const push = (candidate: string) => {
    // Markdown often swallows trailing punctuation into the URL.
    const cleaned = candidate.replace(/[)\]}>.,;:'"]+$/, "");
    const parsed = classifyLink(cleaned);
    if (parsed && !found.has(parsed.url)) found.set(parsed.url, parsed);
  };

  for (const m of withoutCode.matchAll(/\[[^\]]*\]\(\s*(<?)(https?:\/\/[^\s)]+)\1\s*(?:"[^"]*")?\)/gi)) {
    push(m[2]!);
  }
  for (const m of withoutCode.matchAll(/<(https?:\/\/[^\s>]+)>/gi)) push(m[1]!);
  for (const m of withoutCode.matchAll(/(?<![("<\w])https?:\/\/[^\s<>"'`)]+/gi)) push(m[0]);

  return [...found.values()];
}
