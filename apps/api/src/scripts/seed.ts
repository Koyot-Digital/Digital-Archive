import { closeDb } from "../db/client.js";
import { closeRedis } from "../lib/redis.js";
import { migrate } from "../db/migrate.js";
import { upsertFromIngress } from "../services/modlogs.js";
import { ingressRecordSchema } from "@archive/shared";
import { ensureDevUser } from "../auth/session.js";
import { createApiKey } from "../services/apikeys.js";
import { config } from "../config.js";

/**
 * Development seed: a handful of subjects and logs so the web UI has
 * something to render, plus a dev API key for testing ingress.
 *
 * Refuses to run against production.
 */

if (config.isProd) {
  console.error("Refusing to seed a production database.");
  process.exit(1);
}

const samples = [
  {
    robloxId: "1",
    username: "Roblox",
    displayName: "Roblox",
    title: "Account flagged by automated filter",
    body: `The automated content filter flagged three uploads in quick succession.

Reviewed manually and **cleared** - the filter matched on a false positive in the
asset description. Reference: https://www.roblox.com/users/1/profile

See also the original report thread: https://devforum.roblox.com/`,
    action: "note" as const,
    severity: "info" as const,
    reason: "Automated filter false positive",
    source: "seed",
    sourceId: "seed-1",
    tags: ["false-positive", "automated"],
    occurredAt: "2026-02-11T14:03:00Z",
    evidence: { filterVersion: "2026.1", matches: 3 },
  },
  {
    robloxId: "156",
    username: "builderman",
    displayName: "builderman",
    title: "7-day suspension - harassment in experience chat",
    body: `Multiple reports of targeted harassment in the chat of a public experience.

### Timeline
- 09:12 - first report filed
- 09:48 - second and third reports, same reporter group
- 10:30 - logs reviewed, suspension applied

Chat excerpts are attached as evidence. The account has one prior warning on
file from 2025.`,
    action: "temp_ban" as const,
    severity: "high" as const,
    reason: "Harassment - repeated targeting after warning",
    source: "seed",
    sourceId: "seed-2",
    tags: ["harassment", "chat", "repeat"],
    occurredAt: "2026-03-02T10:30:00Z",
    evidence: { priorWarnings: 1, durationDays: 7, reportCount: 3 },
  },
  {
    robloxId: "156",
    username: "builderman",
    title: "Prior warning - mild profanity",
    body: "Single instance of filtered profanity bypass. Warning issued, no further action.",
    action: "warning" as const,
    severity: "low" as const,
    reason: "Filter bypass",
    source: "seed",
    sourceId: "seed-3",
    tags: ["profanity"],
    occurredAt: "2025-11-19T18:22:00Z",
    evidence: {},
  },
  {
    robloxId: "261",
    username: "Shedletsky",
    displayName: "Shedletsky",
    title: "Content deletion - asset reuploaded without licence",
    body: `Asset was a direct reupload of a third-party model. Removed under the
DMCA process. Original author contacted and confirmed the claim.

Takedown notice: https://www.roblox.com/info/dmca`,
    action: "content_deletion" as const,
    severity: "medium" as const,
    reason: "Copyright - unlicensed reupload",
    source: "seed",
    sourceId: "seed-4",
    tags: ["dmca", "copyright", "asset"],
    occurredAt: "2026-01-07T08:00:00Z",
    evidence: { assetId: 1818, claimant: "redacted" },
  },
];

try {
  await migrate();
  await ensureDevUser();

  let created = 0;
  for (const sample of samples) {
    const record = ingressRecordSchema.parse(sample);
    const outcome = await upsertFromIngress(record, "merge", { apiKeyId: null, userId: null });
    if (outcome.outcome === "created") created += 1;
    console.log(`  ${outcome.outcome.padEnd(8)} ${outcome.id}  ${sample.title}`);
  }

  const key = await createApiKey({
    name: "seed dev key",
    scopes: ["ingress:write", "images:write", "archive:read"],
    rateLimitPerMin: 600,
  });

  console.log(`
Seeded ${samples.length} record(s) (${created} new).

Dev ingress key (also works while AUTH_ENABLED=false, which ignores it):
  ${key.secret}

Try:
  curl ${config.API_ORIGIN}${config.API_PREFIX}/roblox-modlogs/156
`);
} catch (err) {
  console.error("Seed failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await closeDb().catch(() => {});
  await closeRedis().catch(() => {});
}
