import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { config } from "../config.js";
import { logger } from "../lib/logger.js";
import * as schema from "./schema.js";

/**
 * One pool per process. Both entrypoints (text + images) import this module,
 * but they run as separate containers so each gets its own pool.
 */
export const sql = postgres(config.DATABASE_URL, {
  max: config.PG_POOL_MAX,
  idle_timeout: 30,
  connect_timeout: 10,
  // bigint columns come back as JS strings unless we say otherwise; roblox ids
  // exceed Number.MAX_SAFE_INTEGER in theory, so BigInt is the safe choice.
  types: {
    bigint: postgres.BigInt,
  },
  // Notices are almost all "... already exists, skipping" from idempotent
  // DDL. Route them to debug instead of letting postgres.js print them.
  onnotice: (notice) => {
    logger.debug({ pg: notice.message, code: notice.code }, "postgres notice");
  },
  transform: { undefined: null },
});

export const db = drizzle(sql, { schema, logger: false });

export type Database = typeof db;

export async function closeDb(): Promise<void> {
  await sql.end({ timeout: 5 });
}

/** Cheap liveness probe for /health. */
export async function pingDb(): Promise<boolean> {
  try {
    await sql`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}
