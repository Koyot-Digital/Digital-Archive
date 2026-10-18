import { createInterface } from "node:readline";
import { createReadStream } from "node:fs";
import { basename } from "node:path";
import {
  discordForumPostSchema,
  forumPostToIngressRecord,
  subjectOf,
  type DiscordForumPost,
  type ForumRejection,
  type IngressRecord,
} from "@archive/shared";
import { closeDb } from "../db/client.js";
import { closeRedis } from "../lib/redis.js";
import { isMainModule } from "../lib/main-module.js";
import { upsertFromIngress } from "../services/modlogs.js";
import {
  attachImageFromUrl,
  attachmentIdentity,
  storedAttachmentIdentities,
} from "../services/images.js";
import { hasBotToken, resolveDiscordUsers } from "../services/discord-users.js";

/**
 * Import a Discord forum scrape from a `.jsonl` file.
 *
 * Runs against the database directly rather than through `POST /ingress`,
 * because a 500-thread file is 1.5MB of JSON carrying every reply - a size
 * that has no business travelling over HTTP when the process can read the
 * file. The parsing, mapping and persistence are the exact same code paths
 * the endpoint uses, so an import and a live ingest cannot diverge.
 *
 *   pnpm --filter @archive/api import -- <file.jsonl> [--conflict merge]
 *                                                     [--limit 50]
 *                                                     [--dry-run]
 *                                                     [--images]
 *
 * Image fetching is off by default: Discord's CDN links carry a signed,
 * expiring token, so a scrape more than a few hours old will mostly 404 and
 * the attempt costs a network round trip per attachment. Pass `--images` when
 * the scrape is fresh.
 */

interface Options {
  file: string;
  onConflict: "skip" | "merge" | "replace";
  limit: number;
  dryRun: boolean;
  fetchImages: boolean;
}

function usage(message?: string): never {
  if (message) console.error(`Error: ${message}\n`);
  console.error(
    [
      "Usage: import-forum-scrape <file.jsonl> [options]",
      "",
      "  --conflict <skip|merge|replace>  how to treat a thread already archived (default merge)",
      "  --limit <n>                      stop after n threads",
      "  --dry-run                        parse and report, write nothing",
      "  --images                         also fetch attachments (needs a fresh scrape)",
    ].join("\n"),
  );
  process.exit(message ? 1 : 0);
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    file: "",
    onConflict: "merge",
    limit: Number.POSITIVE_INFINITY,
    dryRun: false,
    fetchImages: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    switch (arg) {
      case "--help":
      case "-h":
        usage();
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--images":
        options.fetchImages = true;
        break;
      case "--conflict": {
        const value = argv[++i];
        if (value !== "skip" && value !== "merge" && value !== "replace") {
          usage(`--conflict must be skip, merge or replace (got ${value ?? "nothing"})`);
        }
        options.onConflict = value;
        break;
      }
      case "--limit": {
        const value = Number(argv[++i]);
        if (!Number.isInteger(value) || value < 1) usage("--limit must be a positive integer");
        options.limit = value;
        break;
      }
      case "--":
        // `pnpm run x -- file` forwards the separator itself.
        break;
      default:
        if (arg.startsWith("-")) usage(`unknown flag ${arg}`);
        if (options.file) usage("only one input file at a time");
        options.file = arg;
    }
  }

  if (!options.file) usage("no input file given");
  return options;
}

/* ───────────────────────────── reading ───────────────────────────── */

interface ReadResult {
  posts: DiscordForumPost[];
  /** Lines that were not valid JSON, or not a forum post. */
  malformed: { line: number; reason: string }[];
}

/**
 * Stream the file a line at a time.
 *
 * JSONL exists so a 1.5MB file - or a 1.5GB one - does not have to be a
 * single JSON value held in memory, and a malformed line in the middle costs
 * one record rather than the whole import.
 */
async function readScrape(file: string, limit: number): Promise<ReadResult> {
  const posts: DiscordForumPost[] = [];
  const malformed: ReadResult["malformed"] = [];

  const reader = createInterface({
    input: createReadStream(file, { encoding: "utf8" }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });

  let lineNumber = 0;
  for await (const line of reader) {
    lineNumber += 1;
    if (posts.length >= limit) break;
    const trimmed = line.trim();
    if (!trimmed) continue;

    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      malformed.push({ line: lineNumber, reason: "not valid JSON" });
      continue;
    }

    const parsed = discordForumPostSchema.safeParse(value);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      malformed.push({
        line: lineNumber,
        reason: `${issue?.path.join(".") || "root"}: ${issue?.message ?? "invalid"}`,
      });
      continue;
    }
    posts.push(parsed.data);
  }

  reader.close();
  return { posts, malformed };
}

/* ───────────────────────────── importing ───────────────────────────── */

/** `discord:4999…` - short enough for a progress line, precise enough to grep. */
function subjectLabel(record: IngressRecord): string {
  const subject = subjectOf(record);
  return subject ? `${subject.platform}:${subject.externalId}` : "(no subject)";
}

function progress(done: number, total: number, label: string): void {
  // One rewritten line rather than 500 of them.
  const pct = Math.round((done / total) * 100);
  process.stdout.write(`\r  ${String(pct).padStart(3)}%  ${done}/${total}  ${label}`.padEnd(78));
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const started = Date.now();

  console.log(`Reading ${basename(options.file)}…`);
  const { posts, malformed } = await readScrape(options.file, options.limit);
  console.log(`  ${posts.length} thread(s) read, ${malformed.length} unreadable line(s)`);
  for (const bad of malformed.slice(0, 10)) {
    console.log(`    line ${bad.line}: ${bad.reason}`);
  }
  if (!posts.length) {
    console.log("Nothing to import.");
    return;
  }

  /* ── map ── */
  const records: IngressRecord[] = [];
  const rejected: ForumRejection[] = [];
  let droppedImages = 0;
  for (const post of posts) {
    const mapped = forumPostToIngressRecord(post);
    if (mapped.ok) {
      records.push(mapped.record);
      droppedImages += mapped.droppedImages;
    } else {
      rejected.push(mapped);
    }
  }

  console.log(`\nMapped ${records.length} record(s); ${rejected.length} could not be placed:`);
  for (const bad of rejected) {
    console.log(`  ${bad.postId}  ${bad.title}`);
    console.log(`    ${bad.reason}`);
  }
  if (droppedImages) {
    console.log(`  ${droppedImages} attachment(s) over the per-record cap were dropped`);
  }

  const subjects = new Set(
    records.map((r) => `${r.subject?.platform ?? "roblox"}:${r.subject?.externalId ?? r.robloxId}`),
  );
  const alts = new Set(
    records.flatMap((r) => r.relatedAccounts.map((a) => `${a.platform}:${a.externalId}`)),
  );
  const discordIds = new Set(records.flatMap((r) => r.thread?.users.map((u) => u.id) ?? []));
  const attachments = records.reduce((sum, r) => sum + r.imageUrls.length, 0);
  const replies = records.reduce((sum, r) => sum + (r.thread?.messages.length ?? 0), 0);

  console.log(
    [
      "",
      `  subjects          ${subjects.size}`,
      `  related accounts  ${alts.size}`,
      `  discord accounts  ${discordIds.size}`,
      `  thread replies    ${replies}`,
      `  attachments       ${attachments}${options.fetchImages ? "" : " (not fetched; pass --images)"}`,
      "",
    ].join("\n"),
  );

  if (options.dryRun) {
    console.log("--dry-run: nothing was written.");
    return;
  }

  /* ── write ── */
  console.log(`Importing with onConflict=${options.onConflict}…`);
  const counts = { created: 0, updated: 0, skipped: 0, failed: 0 };
  const failures: { subject: string; message: string }[] = [];
  const touchedDiscordIds = new Set<string>();
  const imageCounts = { attached: 0, present: 0, failed: 0 };

  for (const [index, record] of records.entries()) {
    try {
      const outcome = await upsertFromIngress(record, options.onConflict, {
        apiKeyId: null,
        userId: null,
      });
      counts[outcome.outcome] += 1;
      for (const id of outcome.discordIds) touchedDiscordIds.add(id);

      // Deliberately not gated on the record outcome. The conflict policy
      // governs the record's *text*; --images governs its evidence, and a
      // missing attachment is a gap to fill whoever owns the prose. It
      // matters most for the case the policy skips: a moderator-edited
      // record whose images 404'd first time round would otherwise stay
      // unfillable forever, short of --conflict replace reverting the edit.
      if (options.fetchImages && record.imageUrls.length) {
        // Attachments already held are not re-fetched. attachImage dedupes
        // them on the original bytes' sha256 regardless, but only after
        // paying for the download - and a re-scrape is mostly images we hold.
        const held = await storedAttachmentIdentities(outcome.id);

        for (const [position, url] of record.imageUrls.entries()) {
          const identity = attachmentIdentity(url);
          if (identity && held.has(identity)) {
            imageCounts.present += 1;
            continue;
          }
          try {
            await attachImageFromUrl(url, { modlogId: outcome.id, position });
            imageCounts.attached += 1;
          } catch {
            // An expired CDN token is the overwhelmingly common case and is
            // not worth a line of output per attachment.
            imageCounts.failed += 1;
          }
        }
      }
    } catch (err) {
      counts.failed += 1;
      failures.push({
        subject: subjectLabel(record),
        message: err instanceof Error ? err.message : String(err),
      });
    }
    if (index % 10 === 0 || index === records.length - 1) {
      progress(index + 1, records.length, subjectLabel(record));
    }
  }
  process.stdout.write("\n");

  if (failures.length) {
    console.log(`\n${failures.length} record(s) failed:`);
    for (const failure of failures.slice(0, 20)) {
      console.log(`  ${failure.subject}: ${failure.message}`);
    }
  }

  if (options.fetchImages) {
    console.log(
      `\nAttachments: ${imageCounts.attached} converted, ` +
        `${imageCounts.present} already held, ${imageCounts.failed} unreachable` +
        (imageCounts.failed
          ? " (Discord attachment links expire - a stale scrape mostly 404s)"
          : ""),
    );
  }

  /* ── identities ── */
  if (touchedDiscordIds.size) {
    if (hasBotToken()) {
      console.log(`\nResolving ${touchedDiscordIds.size} Discord identity/identities…`);
      const summary = await resolveDiscordUsers([...touchedDiscordIds]);
      console.log(
        `  resolved ${summary.resolved}, unchanged ${summary.skipped}, ` +
          `missing ${summary.missing}, failed ${summary.failed}`,
      );
    } else {
      console.log(
        `\n${touchedDiscordIds.size} Discord identity/identities stored from the scrape.\n` +
          "  Set DISCORD_BOT_TOKEN to refresh usernames and avatars from the Discord API,\n" +
          "  then run: curl -X POST .../digitalarchive/v1/discord-users/refresh",
      );
    }
  }

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(
    `\nDone in ${seconds}s - created ${counts.created}, updated ${counts.updated}, ` +
      `skipped ${counts.skipped}, failed ${counts.failed}.`,
  );
}

if (isMainModule(import.meta.url)) {
  main()
    .then(async () => {
      await closeRedis().catch(() => {});
      await closeDb();
      process.exit(0);
    })
    .catch(async (err) => {
      console.error("\nImport failed:", err instanceof Error ? err.message : err);
      await closeRedis().catch(() => {});
      await closeDb().catch(() => {});
      process.exit(1);
    });
}
