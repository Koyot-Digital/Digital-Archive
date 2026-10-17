import { desc, eq, isNull } from "drizzle-orm";
import { newId, type ApiKeyScope } from "@archive/shared";
import { db } from "../db/client.js";
import { apiKeys } from "../db/schema.js";
import { randomToken, sha256 } from "../lib/crypto.js";
import { notFound } from "../lib/errors.js";
import { invalidate } from "../lib/redis.js";

/**
 * Scraper credentials.
 *
 * The secret is shown exactly once, at creation. Only its SHA-256 is stored,
 * so a database compromise yields no usable ingest tokens.
 */

const PREFIX = "da_";

export interface CreatedKey {
  id: string;
  name: string;
  /** Full secret. Never retrievable again. */
  secret: string;
  prefix: string;
  scopes: ApiKeyScope[];
  rateLimitPerMin: number;
  expiresAt: string | null;
}

export async function createApiKey(input: {
  name: string;
  scopes: ApiKeyScope[];
  rateLimitPerMin: number;
  expiresInDays?: number | undefined;
  createdBy?: string | null;
}): Promise<CreatedKey> {
  const secret = `${PREFIX}${randomToken(32)}`;
  const id = newId();
  const expiresAt = input.expiresInDays
    ? new Date(Date.now() + input.expiresInDays * 86_400_000)
    : null;

  await db.insert(apiKeys).values({
    id,
    name: input.name,
    keyHash: sha256(secret),
    // Enough to recognise a key in a list, far too little to use it.
    prefix: secret.slice(0, 11),
    scopes: input.scopes,
    rateLimitPerMin: input.rateLimitPerMin,
    createdBy: input.createdBy ?? null,
    expiresAt,
  });

  return {
    id,
    name: input.name,
    secret,
    prefix: secret.slice(0, 11),
    scopes: input.scopes,
    rateLimitPerMin: input.rateLimitPerMin,
    expiresAt: expiresAt?.toISOString() ?? null,
  };
}

export async function listApiKeys() {
  const rows = await db
    .select({
      id: apiKeys.id,
      name: apiKeys.name,
      prefix: apiKeys.prefix,
      scopes: apiKeys.scopes,
      rateLimitPerMin: apiKeys.rateLimitPerMin,
      createdAt: apiKeys.createdAt,
      lastUsedAt: apiKeys.lastUsedAt,
      expiresAt: apiKeys.expiresAt,
      revokedAt: apiKeys.revokedAt,
    })
    .from(apiKeys)
    .orderBy(desc(apiKeys.createdAt));

  return rows.map((r) => ({
    ...r,
    createdAt: r.createdAt.toISOString(),
    lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
    expiresAt: r.expiresAt?.toISOString() ?? null,
    revokedAt: r.revokedAt?.toISOString() ?? null,
    active: !r.revokedAt && (!r.expiresAt || r.expiresAt > new Date()),
  }));
}

export async function revokeApiKey(id: string): Promise<{ id: string; name: string }> {
  const rows = await db
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(eq(apiKeys.id, id))
    .returning({ id: apiKeys.id, name: apiKeys.name, keyHash: apiKeys.keyHash });
  const row = rows[0];
  if (!row) throw notFound("API key");

  // Drop the 30s auth cache so the revoke is immediate rather than eventual.
  await invalidate(`apikey:${row.keyHash}`);
  return { id: row.id, name: row.name };
}

export async function countActiveKeys(): Promise<number> {
  const rows = await db
    .select({ id: apiKeys.id })
    .from(apiKeys)
    .where(isNull(apiKeys.revokedAt));
  return rows.length;
}
