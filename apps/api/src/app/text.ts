import Fastify, { type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { buildLoggerOptions } from "../lib/logger.js";
import { pingDb } from "../db/client.js";
import { pingRedis } from "../lib/redis.js";
import { errorsPlugin } from "../plugins/errors.js";
import { rateLimitPlugin, securityPlugin } from "../plugins/security.js";
import { authPlugin } from "../auth/plugin.js";
import { authRoutes } from "../auth/routes.js";
import { archiveRoutes } from "../routes/text/archive.js";
import { moderationRoutes } from "../routes/text/moderation.js";
import { ingressRoutes } from "../routes/ingress.js";
import { badRequest } from "../lib/errors.js";

declare module "fastify" {
  interface FastifyRequest {
    /** Raw JSON body, retained so the ingress HMAC can be verified. */
    rawBody?: string;
  }
}

/**
 * The raw-text data API: `api.domain.com/digitalarchive/v1/...`
 *
 * Everything that is JSON lives here — the archive itself, search, the
 * moderation trail, auth and ingress. Image bytes are a separate service
 * behind a separate tunnel so a flood of image traffic cannot starve the
 * archive's reads, and so the two can be scaled, cached and restarted
 * independently.
 */
export async function buildTextApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: buildLoggerOptions("api-text"),
    trustProxy: config.TRUST_PROXY,
    bodyLimit: 8 * 1024 * 1024,
    // Reuse Cloudflare's ray id when present so a trace spans the tunnel.
    genReqId: (req) =>
      (req.headers["cf-ray"] as string | undefined) ??
      (req.headers["x-request-id"] as string | undefined) ??
      randomUUID(),
    ajv: { customOptions: { removeAdditional: false } },
  });

  /**
   * Keep the raw body alongside the parsed one.
   *
   * The ingress signature is computed over the exact bytes the scraper sent;
   * re-serialising the parsed object would reorder keys and change
   * whitespace, so the signature would never match.
   */
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string", bodyLimit: 8 * 1024 * 1024 },
    (req, body, done) => {
      const raw = body as string;
      req.rawBody = raw;
      if (!raw.length) return done(null, undefined);
      try {
        done(null, JSON.parse(raw));
      } catch {
        done(badRequest("Body is not valid JSON"), undefined);
      }
    },
  );

  await app.register(errorsPlugin);
  await app.register(securityPlugin, { allowCrossOriginResources: false });
  await app.register(authPlugin);
  await app.register(rateLimitPlugin, {
    service: "text",
    maxRequestsPerMin: config.RATE_LIMIT_PUBLIC_PER_MIN,
  });

  // Liveness, outside the versioned prefix so the compose healthcheck and the
  // tunnel's probe do not depend on the API's shape.
  app.get("/health", async (_req, reply) => {
    reply.header("cache-control", "no-store");
    const [database, cache] = await Promise.all([pingDb(), pingRedis()]);
    const healthy = database; // Redis is optional; Postgres is not.
    reply.status(healthy ? 200 : 503);
    return {
      service: "api-text",
      status: healthy ? "ok" : "degraded",
      database,
      cache,
      authEnabled: config.AUTH_ENABLED,
      version: 1,
      uptimeSeconds: Math.round(process.uptime()),
    };
  });

  await app.register(
    async (scope) => {
      await scope.register(authRoutes);
      await scope.register(archiveRoutes);
      await scope.register(moderationRoutes);
      await scope.register(ingressRoutes);

      scope.get("/", async (_req, reply) => {
        reply.header("cache-control", "public, max-age=3600");
        return {
          service: "digital-archive",
          api: "text",
          version: 1,
          endpoints: {
            stats: "GET /stats",
            subjects: "GET /subjects",
            subject: "GET /roblox-modlogs/:robloxId",
            modlog: "GET /roblox-modlogs/:robloxId/:logId",
            image: "GET /roblox-modlogs/:robloxId/:logId/:imageId",
            search: "GET /search?q=",
            revisions: "GET /modlogs/:id/revisions",
            moderators: "GET /moderators",
            discordUser: "GET /discord-users/:discordId",
            ingress: "POST /ingress",
            ingressForum: "POST /ingress/discord-forum",
            ingressCheck: "GET /ingress/whoami",
            auth: "GET /auth/me",
            audit: "GET /moderation/audit",
          },
          imagesApi: `${config.API_ORIGIN}${config.API_PREFIX}/images/`,
        };
      });
    },
    { prefix: config.API_PREFIX },
  );

  return app;
}
