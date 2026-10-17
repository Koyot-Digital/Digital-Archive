import { cp, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * tsc only emits JavaScript, so the .sql migration files have to be copied
 * into dist by hand. Runs as part of `pnpm build`.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const from = join(root, "src", "db", "migrations");
const to = join(root, "dist", "db", "migrations");

await mkdir(to, { recursive: true });
await cp(from, to, { recursive: true });
console.log(`copied migrations -> ${to}`);
