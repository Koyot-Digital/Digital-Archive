import { API_KEY_SCOPES, type ApiKeyScope } from "@archive/shared";
import { closeDb } from "../db/client.js";
import { createApiKey } from "../services/apikeys.js";
import { recordAudit } from "../services/audit.js";
import { migrate } from "../db/migrate.js";

/**
 * Mint a scraper credential from the command line.
 *
 *   pnpm apikey "nightly scraper" ingress:write,images:write [ratePerMin] [expiresDays]
 *
 * The secret is printed once. There is no way to recover it afterwards, by
 * design — only its hash is stored.
 */

const [, , nameArg, scopesArg, rateArg, daysArg] = process.argv;

function usage(message: string): never {
  console.error(`\n${message}\n`);
  console.error('Usage: pnpm apikey "<name>" <scope,scope> [ratePerMin] [expiresInDays]');
  console.error(`Scopes: ${API_KEY_SCOPES.join(", ")}\n`);
  process.exit(1);
}

const name = nameArg?.trim();
if (!name || name.length < 3) usage("A name of at least 3 characters is required.");

const scopes = (scopesArg ?? "ingress:write")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean) as ApiKeyScope[];

const invalid = scopes.filter((s) => !(API_KEY_SCOPES as readonly string[]).includes(s));
if (invalid.length) usage(`Unknown scope(s): ${invalid.join(", ")}`);

const rateLimitPerMin = rateArg ? Number.parseInt(rateArg, 10) : 120;
if (!Number.isFinite(rateLimitPerMin) || rateLimitPerMin < 1) usage("ratePerMin must be a positive integer.");

const expiresInDays = daysArg ? Number.parseInt(daysArg, 10) : undefined;
if (daysArg && (!Number.isFinite(expiresInDays!) || expiresInDays! < 1)) {
  usage("expiresInDays must be a positive integer.");
}

try {
  // A fresh homeserver may not have the tables yet.
  await migrate();

  const key = await createApiKey({ name, scopes, rateLimitPerMin, expiresInDays });
  await recordAudit({
    actorType: "system",
    actorLabel: "cli",
    action: "apikey.create",
    targetType: "api_key",
    targetId: key.id,
    metadata: { name, scopes, rateLimitPerMin, via: "cli" },
  });

  console.log(`
┌─ API key created ──────────────────────────────────────────────
│ name    ${key.name}
│ id      ${key.id}
│ scopes  ${key.scopes.join(", ")}
│ rate    ${key.rateLimitPerMin}/min
│ expires ${key.expiresAt ?? "never"}
├─ secret (shown once) ──────────────────────────────────────────
│ ${key.secret}
└────────────────────────────────────────────────────────────────

Use it as either header:
  Authorization: Bearer ${key.secret}
  X-API-Key: ${key.secret}
`);
} catch (err) {
  console.error("Failed to create API key:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await closeDb().catch(() => {});
  // Redis is connected eagerly by the config import chain.
  const { closeRedis } = await import("../lib/redis.js");
  await closeRedis().catch(() => {});
}
