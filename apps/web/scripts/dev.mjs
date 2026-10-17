import { spawn } from "node:child_process";

/**
 * Start `next dev` on the port the project actually configured.
 *
 * Two problems this solves:
 *
 *  1. `next dev` does not read `WEB_PORT`, which `.env.example` has always
 *     advertised - so the setting was decorative.
 *  2. On a clash `next dev` warns once and moves to the next free port. On a
 *     machine running other local stacks that means the archive silently
 *     comes up somewhere nobody is looking, which is worse than failing. Here
 *     the port is stated explicitly, and `--hostname` pins it to one network
 *     stack so it cannot end up sharing a port number with something else on
 *     the other one (localhost resolving to ::1 before 127.0.0.1 makes that
 *     a genuinely confusing failure to diagnose).
 *
 * The env file is loaded by the `--env-file-if-exists` flag in the npm
 * script, so the repo-root `.env` is the single source of truth for both the
 * API and the web app.
 */
const port = process.env.WEB_PORT ?? process.env.PORT ?? "3000";
const hostname = process.env.WEB_HOST ?? "127.0.0.1";

if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
  console.error(`WEB_PORT must be a port number, got: ${port}`);
  process.exit(1);
}

const child = spawn(
  process.execPath,
  [
    // Resolve Next's own CLI rather than relying on a shell to find it, so
    // this behaves the same from pnpm, make, or an IDE run configuration.
    new URL("../node_modules/next/dist/bin/next", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
    "dev",
    "--port",
    port,
    "--hostname",
    hostname,
  ],
  { stdio: "inherit", env: process.env },
);

child.on("exit", (code, signal) => {
  process.exit(signal ? 1 : (code ?? 0));
});
