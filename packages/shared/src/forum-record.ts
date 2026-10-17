import type { IngressRecord } from "./schemas.js";
import { ingressRecordSchema } from "./schemas.js";
import {
  parseModAction,
  parseModlogTitle,
  type DiscordForumPost,
  type DiscordScrapeAuthor,
  type DiscordScrapeImage,
  type ParsedModAction,
  type ParsedModlogTitle,
} from "./discord.js";

/**
 * Discord forum thread → archive record.
 *
 * One thread is one event, even when it announces a sanction against four alt
 * accounts: the record is filed under the first Roblox id in the title and
 * the rest are stored as related accounts. Splitting them into four records
 * would quadruple the archive's apparent size and make every count wrong.
 *
 * The mapper never throws. A thread it cannot place is returned as a
 * rejection with a reason, so a 500-thread import reports the handful it
 * could not read instead of failing as a whole.
 */

export const FORUM_SOURCE = "discord-forum";

/** Images per record, matching the API's own per-log ceiling. */
const MAX_IMAGES = 24;
/** Replies kept per thread. Long threads are tails of "+1" and emoji. */
const MAX_MESSAGES = 400;
const MAX_TITLE = 300;

export interface ForumMapping {
  record: IngressRecord;
  title: ParsedModlogTitle;
  sanction: ParsedModAction;
  /** Images the mapper had to drop to stay under the per-record ceiling. */
  droppedImages: number;
}

export interface ForumRejection {
  postId: string;
  title: string;
  reason: string;
}

export type ForumMapResult =
  | ({ ok: true } & ForumMapping)
  | ({ ok: false } & ForumRejection);

/* ───────────────────────────── helpers ───────────────────────────── */

/** Prefer the name a human would recognise, fall back to the handle. */
function bestName(author: DiscordScrapeAuthor): string | undefined {
  return (
    author.display_name?.trim() ||
    author.global_name?.trim() ||
    author.username?.trim() ||
    undefined
  );
}

/**
 * Attachment URL to fetch.
 *
 * `cdn.discordapp.com` attachment links carry a signed `ex`/`hm` pair and
 * expire; the `media.discordapp.net` proxy is the longer-lived of the two, so
 * it is tried first and the direct CDN link is the fallback.
 */
function imageUrl(image: DiscordScrapeImage): string | null {
  const candidate = image.proxy_url?.trim() || image.url?.trim();
  if (!candidate) return null;
  return /^https?:\/\//i.test(candidate) ? candidate : null;
}

/**
 * Tag vocabulary.
 *
 * The forum's own tags ("Appealable", "Appeal Denied") are the moderators'
 * language and are kept verbatim apart from casing. The mapper adds only
 * facts it can prove from the body: which command was run, and whether it was
 * struck through.
 */
function tagsFor(post: DiscordForumPost, sanction: ParsedModAction, title: ParsedModlogTitle): string[] {
  const tags = new Set<string>();
  for (const tag of post.tags) {
    const clean = tag.trim().toLowerCase();
    if (clean) tags.add(clean);
  }
  if (sanction.command) tags.add(sanction.command);
  if (sanction.revoked) tags.add("revoked");
  if (title.others.length) tags.add("alt-group");
  // zTags caps at 24; the forum's own tags matter more than the derived ones.
  return [...tags].slice(0, 24);
}

/** Thread participants, author first, deduplicated by id. */
function usersFor(post: DiscordForumPost) {
  const byId = new Map<
    string,
    { id: string; username?: string; displayName?: string; avatarUrl?: string; bot: boolean; role: "author" | "commenter" }
  >();

  const add = (author: DiscordScrapeAuthor | undefined, role: "author" | "commenter") => {
    if (!author?.id) return;
    const existing = byId.get(author.id);
    // The opener stays the opener even if they also replied twenty times.
    const resolvedRole = existing?.role === "author" ? "author" : role;
    const avatar = author.avatar_url?.trim();
    byId.set(author.id, {
      id: author.id,
      ...(bestName(author) ? { displayName: bestName(author)! } : {}),
      ...(author.username?.trim() ? { username: author.username.trim() } : {}),
      ...(avatar && /^https?:\/\//i.test(avatar) ? { avatarUrl: avatar } : {}),
      bot: author.bot ?? false,
      role: resolvedRole,
    });
  };

  add(post.author, "author");
  for (const reply of post.replies) add(reply.author, "commenter");
  return [...byId.values()];
}

/* ───────────────────────────── the mapper ───────────────────────────── */

/**
 * Convert one scraped thread into an ingress record.
 *
 * `onConflict` is the caller's business; this only produces the record. The
 * result is validated through `ingressRecordSchema` before being returned so
 * a mapping bug surfaces here, next to the data that caused it, rather than
 * as a 400 from the API with no context.
 */
export function forumPostToIngressRecord(post: DiscordForumPost): ForumMapResult {
  const title = parseModlogTitle(post.title);
  const sanction = parseModAction(post.body);

  if (!title.primary) {
    return {
      ok: false,
      postId: post.post_id,
      title: post.title,
      reason:
        "no Roblox id in the thread title — the subject cannot be identified, " +
        "so the record has nothing to be filed under",
    };
  }

  /* ── evidence images: the opening post's first, then the discussion's ── */
  const urls: string[] = [];
  const seen = new Set<string>();
  const push = (image: DiscordScrapeImage) => {
    const url = imageUrl(image);
    if (!url || seen.has(url)) return;
    seen.add(url);
    urls.push(url);
  };
  for (const image of post.images) push(image);
  for (const reply of post.replies) for (const image of reply.images) push(image);

  const droppedImages = Math.max(0, urls.length - MAX_IMAGES);

  /* ── the discussion ── */
  const messages = post.replies
    .filter((reply) => reply.message_id)
    .slice(0, MAX_MESSAGES)
    .map((reply) => ({
      messageId: reply.message_id!,
      ...(reply.author?.id ? { authorId: reply.author.id } : {}),
      content: reply.content ?? "",
      ...(reply.posted_at ? { postedAt: reply.posted_at } : {}),
      ...(reply.edited_at ? { editedAt: reply.edited_at } : {}),
      imageUrls: reply.images.map(imageUrl).filter((u): u is string => Boolean(u)).slice(0, 16),
    }));

  const occurredAt = post.posted_at ?? post.created_at;

  const draft = {
    robloxId: title.primary.robloxId,
    ...(title.primary.username ? { username: title.primary.username } : {}),

    title: post.title.slice(0, MAX_TITLE),
    body: post.body ?? "",
    action: sanction.action,
    // A withdrawn sanction is still a record, but it is no longer a live
    // punishment, so it does not keep the severity of one.
    severity: sanction.revoked ? "info" : sanction.severity,
    ...(sanction.reason ? { reason: sanction.reason } : {}),

    ...(occurredAt ? { occurredAt } : {}),
    source: FORUM_SOURCE,
    sourceId: post.post_id,
    ...(post.url && /^https?:\/\//i.test(post.url) ? { sourceUrl: post.url } : {}),

    tags: tagsFor(post, sanction, title),
    evidence: {
      forum: post.forum_name ?? null,
      command: sanction.command,
      duration: sanction.duration,
      durationDays: sanction.durationDays,
      revoked: sanction.revoked,
      superseded: sanction.superseded,
      ticket: title.ticket,
      appeal: title.appeal,
      replyCount: post.reply_count ?? post.replies.length,
      attachments: urls.length,
      scrapedAt: post.scraped_at ?? null,
    },

    imageUrls: urls.slice(0, MAX_IMAGES),
    imageIds: [],

    relatedAccounts: title.others.map((account) => ({
      robloxId: account.robloxId,
      ...(account.username ? { username: account.username } : {}),
      relation: title.relation ?? "related",
    })),
    ...(title.ticket ? { ticketRef: `#${title.ticket}` } : {}),

    thread: {
      ...(post.guild_id ? { guildId: post.guild_id } : {}),
      ...(post.forum_id ? { forumId: post.forum_id } : {}),
      ...(post.forum_name ? { forumName: post.forum_name } : {}),
      postId: post.post_id,
      ...(post.url && /^https?:\/\//i.test(post.url) ? { url: post.url } : {}),
      ...(post.author?.id ?? post.author_id ? { authorId: post.author?.id ?? post.author_id } : {}),
      archived: post.archived ?? false,
      locked: post.locked ?? false,
      pinned: post.pinned ?? false,
      replyCount: post.reply_count ?? post.replies.length,
      ...(post.created_at ? { createdAt: post.created_at } : {}),
      ...(post.last_message_at ? { lastMessageAt: post.last_message_at } : {}),
      ...(post.archived_at ? { archivedAt: post.archived_at } : {}),
      users: usersFor(post),
      messages,
    },
  };

  const parsed = ingressRecordSchema.safeParse(draft);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      postId: post.post_id,
      title: post.title,
      reason: `mapped record failed validation: ${first?.path.join(".") ?? "?"} ${first?.message ?? ""}`.trim(),
    };
  }

  return { ok: true, record: parsed.data, title, sanction, droppedImages };
}
