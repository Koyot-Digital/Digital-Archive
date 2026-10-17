import { z } from "zod";
import type { ModlogAction, ModlogSeverity, SubjectPlatform } from "./constants.js";

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
 * produces - thread participants, ticket references, alt groupings.
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
 * title - without them there is neither a dedupe key nor a subject.
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

/**
 * Which platform a bare number in a thread title belongs to.
 *
 * Discord snowflakes encode a millisecond timestamp in their high bits, so
 * one minted after 2015 is at least 17 digits and they only grow. Roblox user
 * ids are sequential and sit at 11 digits after two decades. The gap between
 * the two is five orders of magnitude, which makes digit count a reliable
 * discriminator today *and* for as long as Roblox would need to issue 10^6
 * times more accounts than it has.
 *
 * It is still a heuristic, which is why it lives in one named function with
 * this comment rather than being inlined as `length > 16` in three places.
 */
const SNOWFLAKE_MIN_DIGITS = 17;

export function platformForId(id: string): SubjectPlatform {
  return id.length >= SNOWFLAKE_MIN_DIGITS ? "discord" : "roblox";
}

export interface TitleAccount {
  /** The username as written in the title, when one preceded the id. */
  username: string | null;
  /** The account's id on its own platform. */
  externalId: string;
  platform: SubjectPlatform;
}

export interface ParsedModlogTitle {
  raw: string;
  /** The account the record is about: the first id named in the title. */
  primary: TitleAccount | null;
  /** Further accounts named in the title - alts, or a renamed account. */
  others: TitleAccount[];
  /** How the extra accounts relate to the primary one, when stated. */
  relation: "alt" | "successor" | "related" | null;
  /** Support ticket number, without the `#`. */
  ticket: string | null;
  /** The title claimed an appeal, even without a ticket number. */
  appeal: boolean;
}

/**
 * `Username (robloxId)` - the unit every one of these titles is built from.
 *
 * The username half is optional because a handful of titles carry a bare id,
 * and it stops at any bracket, comma or arrow so that `A (1) --> B (2)`
 * yields two clean pairs rather than one with `--> B` glued to the front.
 * Ids are 3+ digits, so a `(2d)` duration or a `(#6066)` ticket can never be
 * mistaken for one.
 */
/*
 * The closing bracket accepts `(` as well as `)`: `vhs_95. (1429202800734375996(`
 * is a real title in the Discord forum, a shift-key slip on the closing
 * paren. The id either side of it is unambiguous, and refusing to read it
 * would drop a genuine moderation record over a typo.
 */
const ACCOUNT_PAIR = /([^\s(),[\]<>|/]{1,48})?\s*\(\s*(\d{3,20})\s*[)(]/g;

/**
 * Ticket references.
 *
 * `(#6066)`, `(Support #6200)`, `(Appeal-#6098)`, `(discord-appeal #66)` all
 * put the number straight after the `#`. The Discord forum also writes
 * `(#discord-appeal-86)`, where the `#` labels the whole slug and the number
 * trails it - hence the optional hyphenated-word run in the middle.
 */
const TICKET = /#\s*(?:[a-z][\w-]*?-)?(\d{2,10})/i;

function dedupeAccounts(accounts: TitleAccount[]): TitleAccount[] {
  const seen = new Set<string>();
  const out: TitleAccount[] = [];
  for (const account of accounts) {
    // Keyed by platform too: the same digits on two platforms are two
    // accounts, even though in practice the ranges do not overlap.
    const key = `${account.platform}:${account.externalId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(account);
  }
  return out;
}

/**
 * Pull the subject - and any alts - out of a forum thread title.
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
    const externalId = match[2]!;
    accounts.push({
      // A leading `-->`, `,` or `[` is punctuation, not a username.
      username: name && /[A-Za-z0-9_]/.test(name) ? name.replace(/^[^\w]+|[^\w]+$/g, "") : null,
      externalId,
      platform: platformForId(externalId),
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
  /** Every command in the body was struck through - nothing was enforced. */
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
 * appears often enough to matter), and a struck-through command - wrapped in
 * `~~` - means the sanction was issued and then undone.
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

  const reason = rest.replace(/^[-–:,.]\s*/, "").trim();

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
 * record and must land - it just does not claim an action it cannot prove.
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

/* ─────────────────── discord-side moderation bodies ─────────────────── */

/**
 * The Discord modlog forum writes prose, not commands.
 *
 * Where the Roblox forum is disciplined about `;tban <user> <dur> <reason>`,
 * this one is a staff channel talking to itself, and the same sanction turns
 * up every one of these ways:
 *
 *   mute 6d toxicity
 *   2 day mute for continuous channel misuse.
 *   ?mute 659450283704844323 1d Instigating drama with staff.
 *   perm ban ban evasion
 *   warn spam and inap
 *   Offensive image mute 4d
 *   1d mute initially was gonna warn but decided they would continue
 *
 * So the parser stops trying to match a grammar and instead looks for the
 * three facts independently, anywhere in the line: which sanction word
 * appears, what duration appears, and what is left over once the bot prefix
 * and the target id are removed. Order carries no meaning here, and assuming
 * it did was what made the first attempt read "1d mute" as a note.
 */

/**
 * Sanction words.
 *
 * Scanned by *position*, not priority: the sanction is the first one the
 * moderator wrote, and the words recur inside reasons. "mute 7d ban evasion"
 * is a mute whose reason mentions banning - picking the highest-priority
 * match instead of the earliest turned every one of those into a ban.
 *
 * `ban` has to cover "banned" and "banning", because `\bban\b` does not:
 * the trailing word boundary fails against the next letter, so "perm banned
 * for attempting to scam" read as a note.
 *
 * Longer forms are listed before the shorter ones they contain, which only
 * matters for resolving a tie at the same offset - `perm ban` and `ban` both
 * start matching inside "perm ban", and the compound is the real sanction.
 */
const DISCORD_ACTIONS: [RegExp, ModlogAction][] = [
  [/\b(?:perma?(?:nent(?:ly)?)?[\s-]*ban(?:ned|ning)?|pban|permban(?:ned)?)\b/i, "ban"],
  // Lifting a sanction is a record, but it is not itself a punishment.
  [/\b(?:unmute[ds]?|unban(?:ned)?)\b/i, "note"],
  [/\b(?:tempban(?:ned)?|tban)\b/i, "temp_ban"],
  // "full exclusion" is this channel's phrasing for removal from the server.
  [/\b(?:exclusion|exclude[ds]?|excluding)\b/i, "ban"],
  [/\bban(?:ned|ning)?\b/i, "ban"],
  [/\b(?:timeout|mute[ds]?|muting)\b/i, "mute"],
  [/\bwarn(?:ing|ed|s)?\b/i, "warning"],
  [/\bkick(?:ed|ing|s)?\b/i, "kick"],
];

/** The earliest sanction word in the text, or null when there is none. */
function firstAction(text: string): { action: ModlogAction; word: string } | null {
  let best: { action: ModlogAction; word: string; at: number; length: number } | null = null;
  for (const [re, action] of DISCORD_ACTIONS) {
    const match = re.exec(text);
    if (!match) continue;
    const at = match.index;
    // Earlier wins; at the same offset the longer match wins, so `perm ban`
    // beats the `ban` sitting inside it.
    if (!best || at < best.at || (at === best.at && match[0].length > best.length)) {
      best = { action, word: match[0].toLowerCase(), at, length: match[0].length };
    }
  }
  return best ? { action: best.action, word: best.word } : null;
}

/**
 * A duration anywhere in the text: `6d`, `7 day`, `2 days`, `12h`, `1 week`.
 *
 * Anchored on the unit rather than the number so `mute 659450283704844323 1d`
 * cannot read the target snowflake as a quantity.
 */
const DISCORD_DURATION =
  /\b(\d{1,3})\s*(?:(d)(?:ays?)?|(h)(?:ours?|rs?)?|(w)(?:eeks?)?|(mo)(?:nths?)?|(y)(?:ears?)?|(m)(?:in(?:ute)?s?))\b/i;

/** `perm`, `permanent`, `indefinite` - a sanction with no end date. */
const PERMANENT = /\b(?:perma?(?:nent(?:ly)?)?|indefinite(?:ly)?|forever)\b/i;

/** A leading bot prefix plus the target id: `?mute 659450283704844323 …`. */
const BOT_PREFIX = /^\s*[?!./;$]\s*/;

/**
 * Severity for a Discord sanction.
 *
 * Scaled separately from the Roblox side because the actions are not
 * comparable: a seven-day mute is a nuisance, a seven-day ban is an
 * exclusion, and flattening both to "high" would make the severity column
 * useless for exactly the records a reader is scanning for.
 */
function discordSeverity(
  action: ModlogAction,
  durationDays: number | null,
  permanent: boolean,
): ModlogSeverity {
  if (action === "ban" && (permanent || durationDays === null)) return "critical";
  if (action === "ban" || action === "temp_ban") {
    if (durationDays === null) return "high";
    if (durationDays >= 7) return "high";
    if (durationDays >= 2) return "medium";
    return "low";
  }
  if (action === "mute") {
    if (durationDays === null) return "low";
    // A week of silence is a real sanction; an hour is a cooldown.
    if (durationDays >= 7) return "medium";
    if (durationDays >= 1) return "low";
    return "info";
  }
  if (action === "kick") return "low";
  if (action === "warning") return "low";
  return "info";
}

/** Strip the markdown a staff channel leaves behind, keeping the words. */
function stripNoise(text: string): string {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // [label](url) -> label
    .replace(/<@!?\d+>/g, "") // mentions
    .replace(/<#\d+>/g, "") // channel links
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[*_~`>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Read a Discord moderation body.
 *
 * Same contract as `parseModAction`: never throws, falls back to `note` when
 * it cannot prove a sanction, and resolves a struck-through line by taking
 * the first that is *not* struck - these moderators correct durations in
 * place exactly as the Roblox ones do.
 */
export function parseDiscordModAction(body: string): ParsedModAction {
  const lines = (body ?? "").split(/\r?\n/).filter((l) => l.trim().length);

  const none: ParsedModAction = {
    action: "note",
    severity: "info",
    command: null,
    durationDays: null,
    duration: null,
    reason: null,
    revoked: false,
    superseded: [],
  };
  if (!lines.length) return none;

  interface Candidate {
    struck: boolean;
    action: ModlogAction;
    word: string;
    durationDays: number | null;
    duration: string | null;
    permanent: boolean;
    reason: string | null;
  }

  const candidates: Candidate[] = [];

  for (const raw of lines) {
    // A line wrapped in ~~ is a withdrawn sanction. A body can hold the
    // struck original and its replacement on the *same* line, so the split
    // below has to look inside the line, not just at its ends.
    for (const [segment, struck] of segmentsOf(raw)) {
      const text = stripNoise(segment.replace(BOT_PREFIX, ""));
      if (!text) continue;

      const hit = firstAction(text);
      if (!hit) continue;
      const { action, word } = hit;

      const durationMatch = DISCORD_DURATION.exec(text);
      let durationDays: number | null = null;
      let duration: string | null = null;
      if (durationMatch) {
        const amount = Number(durationMatch[1]);
        const unit = (
          durationMatch[2] ?? durationMatch[3] ?? durationMatch[4] ??
          durationMatch[5] ?? durationMatch[6] ?? durationMatch[7] ?? "d"
        ).toLowerCase();
        const perDay: Record<string, number> = {
          d: 1, h: 1 / 24, w: 7, mo: 30, y: 365, m: 1 / 1440,
        };
        durationDays = Math.round(amount * (perDay[unit] ?? 1) * 1000) / 1000;
        duration = `${amount}${unit}`;
      }

      const permanent = PERMANENT.test(text);
      // Whatever is left after removing the sanction word, the duration and
      // the target id is the reason the moderator gave. Only the first
      // occurrence of the sanction word goes - a later one is part of the
      // reason ("ban evasion") and deleting it would mangle the sentence.
      const reason = text
        .replace(word, " ")
        .replace(DISCORD_DURATION, " ")
        .replace(PERMANENT, " ")
        .replace(/\b\d{15,24}\b/g, " ")
        .replace(/\s+/g, " ")
        .replace(/^[-–:,.\s]+|[\s,.]+$/g, "")
        .trim();

      candidates.push({
        struck,
        action:
          // "ban 7d" is a suspension; "ban" alone is removal.
          action === "ban" && durationDays !== null && !permanent ? "temp_ban" : action,
        word,
        durationDays,
        duration,
        permanent,
        reason: reason.length ? reason.slice(0, 2000) : null,
      });
    }
  }

  if (!candidates.length) return none;

  const effective = candidates.find((c) => !c.struck);
  const chosen = effective ?? candidates[0]!;
  const revoked = !effective;

  return {
    action: chosen.action,
    severity: revoked
      ? "info"
      : discordSeverity(chosen.action, chosen.durationDays, chosen.permanent),
    command: chosen.word || null,
    durationDays: chosen.durationDays,
    duration: chosen.duration,
    reason: chosen.reason,
    revoked,
    superseded: candidates
      .filter((c) => c !== chosen && c.struck)
      .map((c) => ({ command: c.word, duration: c.duration })),
  };
}

/**
 * Split a line into `~~struck~~` and plain segments.
 *
 * `~~mute 7d reason~~ mute 5d reason` is one line carrying both the
 * withdrawn sanction and the one that replaced it, so a whole-line struck
 * test would mark the correction itself as revoked.
 */
function segmentsOf(line: string): [string, boolean][] {
  const out: [string, boolean][] = [];
  const pattern = /~~([\s\S]*?)~~/g;
  let cursor = 0;
  for (const match of line.matchAll(pattern)) {
    if (match.index! > cursor) out.push([line.slice(cursor, match.index), false]);
    out.push([match[1]!, true]);
    cursor = match.index! + match[0].length;
  }
  if (cursor < line.length) out.push([line.slice(cursor), false]);
  // An unterminated `~~` leaves the whole line plain, which is the safe read.
  return out.length ? out : [[line, false]];
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
