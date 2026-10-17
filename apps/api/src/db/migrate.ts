import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql, closeDb } from "./client.js";
import { isMainModule } from "../lib/main-module.js";

/**
 * Plain forward-only SQL migrations.
 *
 * Deliberately not drizzle-kit: the schema leans on triggers, partial indexes
 * and a rule, which hand-written SQL expresses exactly and a generator does
 * not. Each file runs once, inside a transaction, under an advisory lock so
 * two containers booting together cannot race.
 */

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "migrations");
const LOCK_KEY = 0x4d4f_444c; // "MODL"

async function ensureLedger(): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS _migrations (
      name       text PRIMARY KEY,
      checksum   char(64)    NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `;
}

export async function migrate(): Promise<void> {
  await sql`SELECT pg_advisory_lock(${LOCK_KEY})`;
  try {
    await ensureLedger();

    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
    const applied = await sql<{ name: string; checksum: string }[]>`
      SELECT name, checksum FROM _migrations
    `;
    const seen = new Map(applied.map((r) => [r.name, r.checksum]));

    let ran = 0;
    for (const name of files) {
      const body = await readFile(join(MIGRATIONS_DIR, name), "utf8");
      const checksum = createHash("sha256").update(body).digest("hex");
      const previous = seen.get(name);

      if (previous) {
        if (previous !== checksum) {
          throw new Error(
            `Migration ${name} was edited after being applied (checksum mismatch). ` +
              `Add a new migration instead of changing history.`,
          );
        }
        continue;
      }

      console.log(`→ applying ${name}`);
      await sql.begin(async (tx) => {
        // Simple protocol: the files contain multiple statements and
        // dollar-quoted function bodies.
        await tx.unsafe(body).simple();
        await tx`
          INSERT INTO _migrations (name, checksum) VALUES (${name}, ${checksum})
        `;
      });
      ran += 1;
    }

    console.log(ran === 0 ? "Database already up to date." : `Applied ${ran} migration(s).`);
  } finally {
    await sql`SELECT pg_advisory_unlock(${LOCK_KEY})`;
  }
}

// Run directly: `pnpm migrate`
if (isMainModule(import.meta.url)) {
  migrate()
    .then(() => closeDb())
    .then(() => process.exit(0))
    .catch(async (err) => {
      console.error("Migration failed:", err instanceof Error ? err.message : err);
      await closeDb().catch(() => {});
      process.exit(1);
    });
}
