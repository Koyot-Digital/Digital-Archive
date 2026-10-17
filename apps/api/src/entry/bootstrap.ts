import type { FastifyInstance } from "fastify";
import { closeDb } from "../db/client.js";
import { closeRedis } from "../lib/redis.js";
import { migrate } from "../db/migrate.js";
import { config } from "../config.js";

/**
 * Shared process lifecycle for both services.
 *
 * Migrations run at boot behind an advisory lock, so bringing the stack up
 * with `docker compose up` is the only step required on a fresh homeserver.
 */
export async function serve(
  app: FastifyInstance,
  opts: { port: number; name: string; runMigrations?: boolean },
): Promise<void> {
  if (opts.runMigrations) {
    app.log.info("running migrations");
    try {
      await migrate();
    } catch (err) {
      // A dependency that is not up yet is the single most common failure on
      // a cold homeserver boot. Say so in one line instead of a stack trace.
      const message = err instanceof Error ? err.message : String(err);
      app.log.fatal(
        { err: message },
        /ECONNREFUSED|ENOTFOUND|ETIMEDOUT/.test(message)
          ? "cannot reach Postgres — check DATABASE_URL and that the database is running"
          : "migrations failed",
      );
      await closeDb().catch(() => {});
      await closeRedis().catch(() => {});
      process.exit(1);
    }
  }

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, "shutting down");
    // Stop accepting connections first, then let in-flight work finish.
    const timer = setTimeout(() => {
      app.log.error("graceful shutdown timed out, forcing exit");
      process.exit(1);
    }, 15_000);
    timer.unref();
    try {
      await app.close();
      await Promise.allSettled([closeDb(), closeRedis()]);
      clearTimeout(timer);
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, "error during shutdown");
      process.exit(1);
    }
  };

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => void shutdown(signal));
  }
  process.on("unhandledRejection", (reason) => {
    app.log.error({ reason }, "unhandled promise rejection");
  });
  process.on("uncaughtException", (err) => {
    app.log.fatal({ err }, "uncaught exception — exiting");
    void shutdown("uncaughtException");
  });

  try {
    await app.listen({ port: opts.port, host: config.HOST });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    app.log.fatal(
      { err: message, port: opts.port },
      message.includes("EADDRINUSE")
        ? `port ${opts.port} is already in use`
        : "could not bind the listener",
    );
    process.exit(1);
  }

  app.log.info(
    {
      service: opts.name,
      port: opts.port,
      prefix: config.API_PREFIX,
      authEnabled: config.AUTH_ENABLED,
      env: config.NODE_ENV,
    },
    config.AUTH_ENABLED
      ? "listening"
      : "listening — AUTH IS DISABLED, every caller is treated as an admin",
  );
}
