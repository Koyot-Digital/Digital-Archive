import { z } from "zod";
import type { ModlogAction, ModlogSeverity } from "./constants.js";

/**
 * Discord forum scrapes.
 *
 * The upstream scraper walks a Discord forum channel and emits one JSON
 * object per thread. Those objects are *not* archive records: the subject of
 * the log is encoded in the thread title, the action is encoded in a bot
 * command inside the first message, and the evidence is spread across the
 * thread's attachments and its replies.
 *
 * Everything needed to turn one into an archive record lives here rather than
 * in the API, because the web app renders the same vocabulary the parser
 * produces — thread participants, ticket references, alt groupings.
 */

/* ───────────────────────────── primitives ───────────────────────────── */

/** A Discord snowflake: 17-19 digits in practice, bounded here at 24. */
export const DISCORD_SNOWFLAKE_PATTERN = /^[0-9]{15,24}$/;

export const zSnowflake = z
  .union([z.string(), z.number().int().positive()])
  .transform((v) => String(v))
  .refine((v) => DISCORD_SNOWFLAKE_PATTERN.test(v), "must be a Discord snowflake");

export function isSnowflake(value: unknown): value is string {
  return typeof value === "string" && DISCORD_SNOWFLAKE_PATTERN.test(value);
}

/**
 * CDN avatar URL for a user, or null when the account has no custom avatar.
 *
 * Animated avatar hashes are prefixed `a_`; asking for `.webp` on one yields
 * a still frame, which is what an archive wants.
 */
export function discordAvatarUrl(
  userId: string,
  avatar: string | null | undefined,
  size = 128,
): string | null {
  if (!avatar) return null;
  return `https://cdn.discordapp.com/avatars/${userId}/${avatar}.webp?size=${size}`;
}

/**
 * The default avatar Discord serves for an account with no custom one.
 *
 * Post-migration usernames index on `(id >> 22) % 6`; legacy discriminated
 * accounts used `discriminator % 5`. Both are deterministic, so a user with
 * no avatar still renders as the same face they have in Discord.
 */
export function discordDefaultAvatarUrl(userId: string, discriminator?: string | null): string {
  const legacy = discriminator && discriminator !== "0" ? Number(discriminator) % 5 : null;
  const index = legacy ?? Number((BigInt(userId) >> 22n) % 6n);
  return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
}

/** The timestamp embedded in a snowflake. Discord's epoch is 2015-01-01. */
export function snowflakeToDate(id: string): Date | null {
  if (!DISCORD_SNOWFLAKE_PATTERN.test(id)) return null;
  return new Date(Number((BigInt(id) >> 22n) + 1_420_070_400_000n));
}

/* ───────────────────────── raw scrape shapes ───────────────────────── */

/**
 * Deliberately lenient.
 *
 * A scraper that gains a field should not start failing ingest, so unknown
 * keys pass through and everything the parser does not strictly need is
 * optional. The two things that must be present are the post id and the
 * title — without them there is neither a dedupe key nor a subject.
 */
export const discordAuthorSchema = z
  .object({
    id: zSnowflake,
    username: z.string().trim().max(64).optional(),
    display_name: z.string().trim().max(64).nullable().optional(),
    global_name: z.string().trim().max(64).nullable().optional(),
    discriminator: z.string().trim().max(8).nullable().optional(),
    bot: z.boolean().optional(),
    avatar: z.string().trim().max(128).nullable().optional(),
    avatar_url: z.string().trim().max(2048).nullable().optional(),
  })
  .passthrough();

export const discordImageSchema = z
  .object({
    source: z.string().trim().max(32).optional(),
    message_id: zSnowflake.optional(),
    url: z.string().trim().max(2048),
    proxy_url: z.string().trim().max(2048).optional(),
    attachment_id: zSnowflake.optional(),
    filename: z.string().trim().max(256).optional(),
    content_type: z.string().trim().max(128).optional(),
    size_bytes: z.number().int().nonnegative().optional(),
    width: z.number().int().nonnegative().optional(),
    height: z.number().int().nonnegative().optional(),
  })
  .passthrough();

export const discordReplySchema = z
  .object({
    message_id: zSnowflake.optional(),
    author: discordAuthorSchema.optional(),
    posted_at: z.string().trim().max(64).optional(),
    edited_at: z.string().trim().max(64).nullable().optional(),
    content: z.string().max(8000).default(""),
    images: z.array(discordImageSchema).max(64).default([]),
  })
  .passthrough();

export const discordForumPostSchema = z
  .object({
    schema: z.number().int().optional(),
    scraped_at: z.string().trim().max(64).optional(),
    guild_id: zSnowflake.optional(),
    forum_id: zSnowflake.optional(),
    forum_name: z.string().trim().max(128).optional(),
    post_id: zSnowflake,
    title: z.string().trim().min(1).max(600),
    url: z.string().trim().max(2048).optional(),
    author_id: zSnowflake.optional(),
    author: discordAuthorSchema.optional(),
    created_at: z.string().trim().max(64).optional(),
    posted_at: z.string().trim().max(64).optional(),
    edited_at: z.string().trim().max(64).nullable().optional(),
    last_message_at: z.string().trim().max(64).nullable().optional(),
    archived_at: z.string().trim().max(64).nullable().optional(),
    archived: z.boolean().optional(),
    locked: z.boolean().optional(),
    pinned: z.boolean().optional(),
    tags: z.array(z.string().trim().max(64)).max(32).default([]),
    reply_count: z.number().int().nonnegative().optional(),
    body: z.string().max(100_000).default(""),
    images: z.array(discordImageSchema).max(128).default([]),
    replies: z.array(discordReplySchema).max(1000).default([]),
  })
  .passthrough();

export type DiscordForumPost = z.infer<typeof discordForumPostSchema>;
export type DiscordScrapeAuthor = z.infer<typeof discordAuthorSchema>;
export type DiscordScrapeImage = z.infer<typeof discordImageSchema>;

/* ───────────────────────────── title parsing ───────────────────────────── */

export interface TitleAccount {
  /** The Roblox username as written in the title, when one preceded the id. */
  username: string | null;
  robloxId: string;
}

export interface ParsedModlogTitle {
  raw: string;
  /** The account the record is about: the first id named in the title. */
  primary: TitleAccount | null;
  /** Further accounts named in the title — alts, or a renamed account. */
  others: TitleAccount[];
  /** How the extra accounts relate to the primary one, when stated. */
  relation: "alt" | "successor" | "related" | null;
  /** Support ticket number, without the `#`. */
  ticket: string | null;
  /** The title claimed an appeal, even without a ticket number. */
  appeal: boolean;
}

/**
 * `Username (robloxId)` — the unit every one of these titles is built from.
 *
 * The username half is optional because a handful of titles carry a bare id,
 * and it stops at any bracket, comma or arrow so that `A (1) --> B (2)`
 * yields two clean pairs rather than one with `--> B` glued to the front.
 * Ids are 3+ digits, so a `(2d)` duration or a `(#6066)` ticket can never be
 * mistaken for one.
 */
const ACCOUNT_PAIR = /([^\s(),[\]<>|/]{1,48})?\s*\(\s*(\d{3,20})\s*\)/g;

/** Ticket references: `(#6066)`, `(Support #6200)`, `(Appeal-#6098)`. */
const TICKET = /#\s*(\d{2,10})/;

function dedupeAccounts(accounts: TitleAccount[]): TitleAccount[] {
  const seen = new Set<string>();
  const out: TitleAccount[] = [];
  for (const account of accounts) {
    if (seen.has(account.robloxId)) continue;
    seen.add(account.robloxId);
    out.push(account);
  }
  return out;
}

/**
 * Pull the subject — and any alts — out of a forum thread title.
 *
 * The moderators writing these titles are consistent about `Name (id)` and
 * inconsistent about everything else, so the parser leans entirely on that
 * pair and treats the rest of the title as commentary:
 *
 *   wojtek3441 (2555684412) (#6066)
 *   Thyhood01 (6184378662) --> Red_regret4132 (1390518961) (Support #6200)
 *   Roveen80 (2352644898) [roveen1984 (1972201936) Roveen300 (3436398439)]
 *   MRLAZY295 (5394995325) mrlazy296 (7511229161) All Alts
 *   dap123francais (all alt accounts) (Appeal-#6098)   ← no id at all
 */
export function parseModlogTitle(raw: string): ParsedModlogTitle {
  const title = raw.trim();
  const accounts: TitleAccount[] = [];

  for (const match of title.matchAll(ACCOUNT_PAIR)) {
    const name = match[1]?.trim();
    accounts.push({
      // A leading `-->`, `,` or `[` is punctuation, not a username.
      username: name && /[A-Za-z0-9_]/.test(name) ? name.replace(/^[^\w]+|[^\w]+$/g, "") : null,
      robloxId: match[2]!,
    });
  }

  const unique = dedupeAccounts(accounts);
  const [primary, ...others] = unique;

  const ticketMatch = TICKET.exec(title);
  const lower = title.toLowerCase();

  const relation: ParsedModlogTitle["relation"] =
    others.length === 0
      ? null
      : /-+>|→/.test(title)
        ? "successor"
        : /\balts?\b|\[|,/.test(lower)
          ? "alt"
          : "related";

  return {
    raw: title,
    primary: primary ?? null,
    others,
    relation,
    ticket: ticketMatch?.[1] ?? null,
    appeal: /\bappeal/.test(lower),
  };
}

/* ───────────────────────────── body parsing ───────────────────────────── */

export interface ParsedModAction {
  action: ModlogAction;
  severity: ModlogSeverity;
  /** The bot command issued, e.g. `tban`. Null when the body is prose. */
  command: string | null;
  /** Ban length in days, when the command carried one. */
  durationDays: number | null;
  /** The duration exactly as written, e.g. `3d`. */
  duration: string | null;
  /** The reason text that followed the command, when there was one. */
  reason: string | null;
  /** Every command in the body was struck through — nothing was enforced. */
  revoked: boolean;
  /**
   * Commands that were struck through before this one stuck.
   *
   * A thread that reads `~~;tban 3d~~` then `;pban` is an escalation, not two
   * events: the permanent ban is the record, and the withdrawn suspension is
   * the history behind it.
   */
  superseded: { command: string; duration: string | null }[];
}

/**
 * `;tban Username 3d Intentional disruption of gameplay`
 *
 * The prefix varies (`;` is the bot's, but `:` is one key to its left and
 * appears often enough to matter), and a struck-through command — wrapped in
 * `~~` — means the sanction was issued and then undone.
 */
const COMMAND = /^\s*(~~)?\s*[;:!.]?\s*([a-z]+)\b[ \t]*(.*)$/i;

/** `2d`, `10 d`, `1w`, `12h`, `3mo`. */
const DURATION = /^(\d+(?:\.\d+)?)\s*(mo|[dhwmy])\b/i;

const DURATION_DAYS: Record<string, number> = {
  h: 1 / 24,
  d: 1,
  w: 7,
  mo: 30,
  m: 30,
  y: 365,
};

const COMMAND_ACTIONS: Record<string, ModlogAction> = {
  tban: "temp_ban",
  tempban: "temp_ban",
  pban: "ban",
  ban: "ban",
  permban: "ban",
  kick: "kick",
  warn: "warning",
  warning: "warning",
  mute: "mute",
  unban: "note",
  note: "note",
  watchlist: "note",
  points: "note",
};

/**
 * Severity from the shape of the sanction.
 *
 * A permanent ban is the archive's ceiling; a temporary one scales with its
 * length, because one day and thirty days are not the same event and a
 * reader scanning a subject's history needs to see that at a glance.
 */
function severityFor(action: ModlogAction, durationDays: number | null): ModlogSeverity {
  if (action === "ban" || action === "termination" || action === "account_deletion") {
    return "critical";
  }
  if (action === "temp_ban") {
    if (durationDays === null) return "medium";
    if (durationDays >= 7) return "high";
    if (durationDays >= 2) return "medium";
    return "low";
  }
  if (action === "kick" || action === "mute" || action === "warning") return "low";
  if (action === "content_deletion") return "medium";
  return "info";
}

interface CommandLine {
  struck: boolean;
  command: string;
  action: ModlogAction;
  durationDays: number | null;
  duration: string | null;
  reason: string | null;
}

/** Parse one line as `[~~][;]command <target> [duration] [reason][~~]`. */
function parseCommandLine(line: string): CommandLine | null {
  const match = COMMAND.exec(line);
  if (!match) return null;

  const command = match[2]!.toLowerCase();
  const action = COMMAND_ACTIONS[command];
  // A leading word that is not a known command means the line is prose.
  if (!action) return null;

  // Everything after the command is `<target> [duration] [reason]`. The
  // target is the Roblox username, which the title already gave us.
  // Strike-through markers have already been read off the raw line, so they
  // are stripped here rather than left to show up inside a reason string.
  let rest = (match[3] ?? "").replace(/~~/g, " ").replace(/\s+/g, " ").trim();
  const spaceIdx = rest.indexOf(" ");
  rest = spaceIdx === -1 ? "" : rest.slice(spaceIdx + 1).trim();

  const durationMatch = DURATION.exec(rest);
  let durationDays: number | null = null;
  let duration: string | null = null;
  if (durationMatch) {
    const amount = Number(durationMatch[1]);
    const unit = durationMatch[2]!.toLowerCase();
    durationDays = Math.round(amount * (DURATION_DAYS[unit] ?? 1) * 100) / 100;
    duration = durationMatch[0].replace(/\s+/g, "");
    rest = rest.slice(durationMatch[0].length).trim();
  }

  const reason = rest.replace(/^[-–—:,.]\s*/, "").trim();

  return {
    struck: Boolean(match[1]) || /~~\s*$/.test(line.trim()),
    command,
    action,
    durationDays,
    duration,
    reason: reason.length ? reason.slice(0, 2000) : null,
  };
}

/**
 * Read the sanction out of a moderator's opening message.
 *
 * A body can hold several commands, because moderators edit these posts in
 * place: a suspension gets struck through and replaced with a permanent ban,
 * or a duration gets corrected. The *effective* sanction is the first command
 * that is not struck through; anything struck before it is history. When
 * every command is struck the sanction was withdrawn outright, and the record
 * keeps the action for searchability but drops to `info` severity, because
 * nothing was enforced.
 *
 * Falls back to `note`/`info` rather than guessing: a thread whose body is
 * prose ("verbally warned, ban him if he joins again") is still a real
 * record and must land — it just does not claim an action it cannot prove.
 */
export function parseModAction(body: string): ParsedModAction {
  const lines = (body ?? "").split(/\r?\n/).filter((l) => l.trim().length);
  const commands: CommandLine[] = [];
  for (const line of lines) {
    const parsed = parseCommandLine(line);
    if (parsed) commands.push(parsed);
  }

  if (!commands.length) {
    return {
      action: "note",
      severity: "info",
      command: null,
      durationDays: null,
      duration: null,
      reason: null,
      // A body of prose with a struck-through sentence is still just prose.
      revoked: false,
      superseded: [],
    };
  }

  const effective = commands.find((c) => !c.struck);
  const chosen = effective ?? commands[0]!;
  const revoked = !effective;
  const superseded = commands
    .filter((c) => c !== chosen && c.struck)
    .map((c) => ({ command: c.command, duration: c.duration }));

  return {
    action: chosen.action,
    severity: revoked ? "info" : severityFor(chosen.action, chosen.durationDays),
    command: chosen.command,
    durationDays: chosen.durationDays,
    duration: chosen.duration,
    reason: chosen.reason,
    revoked,
    superseded,
  };
}

/* ───────────────────────────── mentions ───────────────────────────── */

const MENTION = /<@!?(\d{15,24})>/g;

/** Every user id mentioned in a message body. */
export function mentionedUserIds(content: string): string[] {
  const out = new Set<string>();
  for (const match of (content ?? "").matchAll(MENTION)) out.add(match[1]!);
  return [...out];
}

/**
 * Rewrite `<@1234>` into a readable name.
 *
 * Thread replies are full of raw mentions, which render as noise. The archive
 * resolves the ids it knows and leaves the rest as `@unknown` rather than
 * printing a bare snowflake at the reader.
 */
export function renderMentions(content: string, names: Map<string, string>): string {
  return (content ?? "").replace(MENTION, (_whole, id: string) => `@${names.get(id) ?? "unknown"}`);
}
