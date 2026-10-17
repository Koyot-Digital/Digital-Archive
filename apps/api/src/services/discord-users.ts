import { inArray, lt, or, isNull, and, sql as raw, eq } from "drizzle-orm";
import {
  discordAvatarUrl,
  discordDefaultAvatarUrl,
  DISCORD_SNOWFLAKE_PATTERN,
  type DiscordUserHint,
} from "@archive/shared";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { discordUsers } from "../db/schema.js";
import { logger } from "../lib/logger.js";

/**
 * Discord identity resolution.
 *
 * The scraper records the username and avatar it saw at scrape time. Those
 * are a starting point, not the answer: display names and avatars change, and
 * a scrape from August is already stale. So identities are stored once,
 * seeded from the scrape so nothing ever renders blank, and then refreshed
 * from `GET /users/{id}` — the authoritative source — in the background.
 *
 * Two constraints shape everything here:
 *
 *  1. **Ingest must not depend on Discord being up.** Resolution happens
 *     after the ingress response is sent, and a failure leaves the seeded
 *     values in place rather than nulling a name out.
 *  2. **The rate limit is shared with nothing.** `/users/{id}` is a global
 *     bucket, so requests are serialised with a small delay, 429s are obeyed
 *     to the millisecond, and a repeatedly-failing id is backed off rather
 *     than retried on every import.
 */

const API_BASE = "https://discord.com/api/v10";
const TIMEOUT_MS = 8_000;

/** Pause between calls. Discord's global limit is ~50 req/s; this is far under. */
const PACE_MS = 120;
/** Give up on a batch rather than block a background task indefinitely. */
const MAX_WAIT_MS = 30_000;
/** After this many consecutive failures an id is left alone (deleted account). */
const MAX_FAILURES = 4;

export interface DiscordIdentity {
  id: string;
  username: string | null;
  displayName: string | null;
  avatarUrl: string;
  bot: boolean;
  /** Whether these values came from the Discord API or from the scrape. */
  resolvedFrom: "scrape" | "discord_api";
  fetchedAt: string | null;
}

/**
 * Shape one row for the API.
 *
 * `avatarUrl` is never null: an account with no avatar gets the same default
 * face Discord itself renders, so the web app never has to decide what to
 * draw in a gap.
 */
export function toDiscordIdentity(row: typeof discordUsers.$inferSelect): DiscordIdentity {
  return {
    id: row.id,
    username: row.username,
    displayName: row.globalName ?? row.username,
    avatarUrl:
      row.avatarUrl ??
      discordAvatarUrl(row.id, row.avatar) ??
      discordDefaultAvatarUrl(row.id),
    bot: row.bot,
    resolvedFrom: row.resolvedFrom,
    fetchedAt: row.fetchedAt?.toISOString() ?? null,
  };
}

export function hasBotToken(): boolean {
  return Boolean(config.DISCORD_BOT_TOKEN);
}

/* ───────────────────────────── seeding ───────────────────────────── */

/**
 * Recover the avatar hash from a scraped CDN URL.
 *
 * Worth doing even without a bot token: a scrape hands over whatever size it
 * happened to capture — usually `?size=1024` — and the archive renders
 * avatars at 20-40px. Keeping the hash means every size is reconstructible,
 * so a 28px slot fetches 128px of image instead of a megapixel of it.
 */
function avatarHashFrom(url: string | undefined): string | null {
  if (!url) return null;
  const match = /\/avatars\/\d{15,24}\/([a-zA-Z0-9_]{1,128})\.(?:webp|png|jpe?g|gif)/.exec(url);
  return match?.[1] ?? null;
}

/**
 * Store the identities a scrape observed.
 *
 * `coalesce(excluded.x, existing.x)` throughout: a partial hint must never
 * blank a field that is already known. A row already resolved through the API
 * keeps that provenance — a stale scrape does not get to overwrite a fresh
 * API answer, though it may still fill a field the API left null.
 */
export async function seedDiscordUsers(hints: DiscordUserHint[]): Promise<number> {
  const unique = new Map<string, DiscordUserHint>();
  for (const hint of hints) {
    if (!DISCORD_SNOWFLAKE_PATTERN.test(hint.id)) continue;
    unique.set(hint.id, { ...unique.get(hint.id), ...hint });
  }
  if (!unique.size) return 0;

  const rows = await db
    .insert(discordUsers)
    .values(
      [...unique.values()].map((hint) => {
        const avatar = avatarHashFrom(hint.avatarUrl);
        return {
          id: hint.id,
          username: hint.username ?? null,
          globalName: hint.displayName ?? null,
          avatar,
          // Prefer a URL rebuilt at a sane size over the scrape's own.
          avatarUrl: discordAvatarUrl(hint.id, avatar) ?? hint.avatarUrl ?? null,
          bot: hint.bot,
        };
      }),
    )
    .onConflictDoUpdate({
      target: discordUsers.id,
      set: {
        username: raw`coalesce(${discordUsers.username}, excluded.username)`,
        globalName: raw`coalesce(${discordUsers.globalName}, excluded.global_name)`,
        avatar: raw`case when ${discordUsers.resolvedFrom} = 'discord_api'
                         then coalesce(${discordUsers.avatar}, excluded.avatar)
                         else coalesce(excluded.avatar, ${discordUsers.avatar}) end`,
        avatarUrl: raw`case when ${discordUsers.resolvedFrom} = 'discord_api'
                            then coalesce(${discordUsers.avatarUrl}, excluded.avatar_url)
                            else coalesce(excluded.avatar_url, ${discordUsers.avatarUrl}) end`,
        bot: raw`${discordUsers.bot} or excluded.bot`,
      },
    })
    .returning({ id: discordUsers.id });

  return rows.length;
}

/* ───────────────────────────── the Discord call ───────────────────────────── */

interface DiscordUserResponse {
  id: string;
  username: string;
  global_name: string | null;
  discriminator: string | null;
  avatar: string | null;
  bot?: boolean;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type FetchOutcome =
  | { kind: "ok"; user: DiscordUserResponse }
  | { kind: "missing" }
  | { kind: "retry"; afterMs: number; reason: string }
  | { kind: "error"; reason: string };

/**
 * One `GET /users/{id}`.
 *
 * A bot token is required — the `identify` OAuth scope only ever describes
 * the signed-in user, and the archive needs to look up accounts that have
 * never visited it. 404 is a real answer (the account is gone), so it is
 * distinguished from a transport failure: one should stop us retrying, the
 * other should not.
 */
async function fetchDiscordUser(id: string): Promise<FetchOutcome> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/users/${id}`, {
      headers: {
        authorization: `Bot ${config.DISCORD_BOT_TOKEN}`,
        "user-agent": `DigitalArchive (${config.WEB_ORIGIN}, 1.0)`,
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    return { kind: "error", reason: err instanceof Error ? err.message : "fetch failed" };
  }

  if (res.status === 429) {
    // Discord answers in seconds, as a float, and is authoritative about it.
    const retryAfter = Number(res.headers.get("retry-after") ?? "1");
    return {
      kind: "retry",
      afterMs: Math.min(Number.isFinite(retryAfter) ? retryAfter * 1000 : 1000, 10_000),
      reason: "rate limited",
    };
  }
  if (res.status === 404) return { kind: "missing" };
  if (res.status === 401 || res.status === 403) {
    return { kind: "error", reason: `bot token rejected (${res.status})` };
  }
  if (!res.ok) return { kind: "error", reason: `discord returned ${res.status}` };

  try {
    return { kind: "ok", user: (await res.json()) as DiscordUserResponse };
  } catch {
    return { kind: "error", reason: "discord returned a non-JSON body" };
  }
}

async function storeResolved(user: DiscordUserResponse): Promise<void> {
  const avatarUrl =
    discordAvatarUrl(user.id, user.avatar, 256) ??
    discordDefaultAvatarUrl(user.id, user.discriminator);

  await db
    .insert(discordUsers)
    .values({
      id: user.id,
      username: user.username,
      globalName: user.global_name,
      avatar: user.avatar,
      avatarUrl,
      bot: user.bot ?? false,
      resolvedFrom: "discord_api",
      fetchedAt: new Date(),
      fetchFailures: 0,
      fetchError: null,
    })
    .onConflictDoUpdate({
      target: discordUsers.id,
      set: {
        username: raw`excluded.username`,
        globalName: raw`excluded.global_name`,
        avatar: raw`excluded.avatar`,
        avatarUrl: raw`excluded.avatar_url`,
        bot: raw`excluded.bot`,
        resolvedFrom: raw`'discord_api'`,
        fetchedAt: raw`now()`,
        fetchFailures: raw`0`,
        fetchError: raw`null`,
      },
    });
}

async function recordFailure(id: string, reason: string): Promise<void> {
  await db
    .update(discordUsers)
    .set({
      fetchFailures: raw`${discordUsers.fetchFailures} + 1`,
      fetchError: reason.slice(0, 500),
      // Stamped even on failure so the staleness sweep moves on instead of
      // spinning on the same unreachable id.
      fetchedAt: new Date(),
    })
    .where(eq(discordUsers.id, id));
}

/* ───────────────────────────── resolution ───────────────────────────── */

export interface ResolveSummary {
  requested: number;
  resolved: number;
  missing: number;
  failed: number;
  skipped: number;
  /** Set when no bot token is configured: scraped values are all we have. */
  tokenMissing?: boolean;
}

/**
 * Refresh a set of identities from the Discord API.
 *
 * Serial by design. Parallelising would gain nothing — the limit is Discord's
 * global bucket, not our concurrency — and would turn a 429 into a burst of
 * them. The whole batch is bounded by `MAX_WAIT_MS` so a background refresh
 * can never pin a worker.
 */
export async function resolveDiscordUsers(ids: string[]): Promise<ResolveSummary> {
  const wanted = [...new Set(ids.filter((id) => DISCORD_SNOWFLAKE_PATTERN.test(id)))];
  const summary: ResolveSummary = {
    requested: wanted.length,
    resolved: 0,
    missing: 0,
    failed: 0,
    skipped: 0,
  };
  if (!wanted.length) return summary;

  if (!hasBotToken()) {
    // Not an error: the archive runs fine on scraped identities, it just
    // cannot refresh them. Said once per batch, not once per id.
    logger.debug(
      { count: wanted.length },
      "DISCORD_BOT_TOKEN not set — keeping scraped usernames and avatars",
    );
    return { ...summary, skipped: wanted.length, tokenMissing: true };
  }

  const staleBefore = new Date(Date.now() - config.DISCORD_USER_TTL_HOURS * 3_600_000);
  // Only ids that are actually due: a 500-record import mentions the same
  // eighteen moderators over and over.
  const due = await db
    .select({ id: discordUsers.id })
    .from(discordUsers)
    .where(
      and(
        inArray(discordUsers.id, wanted),
        lt(discordUsers.fetchFailures, MAX_FAILURES),
        or(
          isNull(discordUsers.fetchedAt),
          lt(discordUsers.fetchedAt, staleBefore),
          eq(discordUsers.resolvedFrom, "scrape"),
        ),
      ),
    )
    .then((rows) => rows.map((r) => r.id));

  summary.skipped = wanted.length - due.length;
  const deadline = Date.now() + MAX_WAIT_MS;

  for (const id of due) {
    if (Date.now() > deadline) {
      summary.skipped += 1;
      continue;
    }

    let outcome = await fetchDiscordUser(id);
    if (outcome.kind === "retry") {
      await sleep(outcome.afterMs);
      outcome = await fetchDiscordUser(id);
    }

    switch (outcome.kind) {
      case "ok":
        await storeResolved(outcome.user);
        summary.resolved += 1;
        break;
      case "missing":
        // A deleted account. Counted as a failure so the backoff eventually
        // stops asking, but it is not an error worth logging.
        await recordFailure(id, "account not found (404)");
        summary.missing += 1;
        break;
      default:
        await recordFailure(id, outcome.reason);
        summary.failed += 1;
        logger.warn({ discordId: id, reason: outcome.reason }, "discord user lookup failed");
        break;
    }

    await sleep(PACE_MS);
  }

  return summary;
}

/**
 * Refresh whatever is most stale.
 *
 * Exposed for an admin-triggered sweep: identities drift whether or not
 * anything is being ingested, and the archive should be able to catch up
 * without re-importing.
 */
export async function refreshStaleDiscordUsers(limit = 50): Promise<ResolveSummary> {
  if (!hasBotToken()) {
    return { requested: 0, resolved: 0, missing: 0, failed: 0, skipped: 0, tokenMissing: true };
  }
  const staleBefore = new Date(Date.now() - config.DISCORD_USER_TTL_HOURS * 3_600_000);
  const rows = await db
    .select({ id: discordUsers.id })
    .from(discordUsers)
    .where(
      and(
        lt(discordUsers.fetchFailures, MAX_FAILURES),
        or(isNull(discordUsers.fetchedAt), lt(discordUsers.fetchedAt, staleBefore)),
      ),
    )
    // A never-resolved row is infinitely stale, so it goes first.
    .orderBy(raw`${discordUsers.fetchedAt} asc nulls first`)
    .limit(Math.min(limit, 200));

  return resolveDiscordUsers(rows.map((r) => r.id));
}

/* ───────────────────────────── reads ───────────────────────────── */

export async function getDiscordUsers(ids: string[]): Promise<Map<string, DiscordIdentity>> {
  const unique = [...new Set(ids.filter((id) => DISCORD_SNOWFLAKE_PATTERN.test(id)))];
  if (!unique.length) return new Map();
  const rows = await db.select().from(discordUsers).where(inArray(discordUsers.id, unique));
  return new Map(rows.map((row) => [row.id, toDiscordIdentity(row)]));
}

export async function getDiscordUser(id: string): Promise<DiscordIdentity | null> {
  if (!DISCORD_SNOWFLAKE_PATTERN.test(id)) return null;
  const row = await db
    .select()
    .from(discordUsers)
    .where(eq(discordUsers.id, id))
    .limit(1)
    .then((r) => r[0]);
  return row ? toDiscordIdentity(row) : null;
}

/**
 * Everyone who has written a moderation log, with how many they wrote.
 *
 * The archive's own staff list, derived rather than configured: it is a fact
 * about the records, so it cannot fall out of step with them.
 */
export async function listModerators(limit = 100): Promise<
  (DiscordIdentity & { recordCount: number; lastRecordAt: string | null })[]
> {
  const rows = await db.execute<{
    id: string;
    username: string | null;
    global_name: string | null;
    avatar: string | null;
    avatar_url: string | null;
    bot: boolean;
    resolved_from: "scrape" | "discord_api";
    fetched_at: Date | null;
    record_count: number;
    last_record_at: Date | null;
  }>(raw`
    SELECT d.id, d.username, d.global_name, d.avatar, d.avatar_url, d.bot,
           d.resolved_from, d.fetched_at,
           count(m.id)::int                                 AS record_count,
           max(coalesce(m.occurred_at, m.created_at))        AS last_record_at
      FROM discord_users d
      JOIN modlogs m ON m.discord_author_id = d.id AND m.status = 'published'
     GROUP BY d.id
     ORDER BY count(m.id) DESC, d.username ASC
     LIMIT ${Math.min(limit, 500)}
  `);

  return rows.map((row) => ({
    id: row.id,
    username: row.username,
    displayName: row.global_name ?? row.username,
    avatarUrl:
      row.avatar_url ?? discordAvatarUrl(row.id, row.avatar) ?? discordDefaultAvatarUrl(row.id),
    bot: row.bot,
    resolvedFrom: row.resolved_from,
    fetchedAt: row.fetched_at ? new Date(row.fetched_at).toISOString() : null,
    recordCount: row.record_count,
    lastRecordAt: row.last_record_at ? new Date(row.last_record_at).toISOString() : null,
  }));
}
