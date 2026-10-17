import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * True when `moduleUrl` is the file node was launched with.
 *
 * `import.meta.main` is not available across the Node versions and the tsx
 * loader we run, and naive string comparison breaks on Windows (drive-letter
 * casing, backslashes) so resolve both sides to a real path first.
 */
export function isMainModule(moduleUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(entry);
  } catch {
    return false;
  }
}
