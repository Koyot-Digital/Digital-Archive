import Fastify, { type FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { buildLoggerOptions } from "../lib/logger.js";
import { pingDb } from "../db/client.js";
import { pingRedis } from "../lib/redis.js";
import { errorsPlugin } from "../plugins/errors.js";
import { rateLimitPlugin, securityPlugin } from "../plugins/security.js";
import { authPlugin } from "../auth/plugin.js";
import { imageServeRoutes } from "../routes/images/serve.js";
import { imageWriteRoutes } from "../routes/images/upload.js";
import { ensureStore } from "../services/storage.js";

/**
 * The images API: `api.domain.com/digitalarchive/v1/images/...`
 *
 * Separated from the text API because its traffic profile is the opposite:
 * few, large, highly cacheable responses, plus occasional CPU-heavy uploads.
 * Running it as its own process behind its own tunnel means an ingest burst
 * of a thousand screenshots cannot add latency to an archive page load.
 */
export async function buildImagesApp(): Promise<FastifyInstance> {
  await ensureStore();

  const app = Fastify({
    logger: buildLoggerOptions("api-images"),
    trustProxy: config.TRUST_PROXY,
    bodyLimit: config.IMAGE_MAX_UPLOAD_BYTES + 1_048_576,
    genReqId: (req) =>
      (req.headers["cf-ray"] as string | undefined) ??
      (req.headers["x-request-id"] as string | undefined) ??
      randomUUID(),
  });

  await app.register(errorsPlugin);
  // Images are embedded by the web app on another origin.
  await app.register(securityPlugin, { allowCrossOriginResources: true });
  await app.register(authPlugin);
  await app.register(rateLimitPlugin, {
    service: "images",
    maxRequestsPerMin: config.RATE_LIMIT_PUBLIC_PER_MIN,
  });

  await app.register(multipart, {
    limits: {
      fileSize: config.IMAGE_MAX_UPLOAD_BYTES,
      files: config.IMAGE_MAX_PER_LOG,
      fields: 8,
      fieldSize: 4096,
      headerPairs: 64,
    },
    // Oversized parts are reported via part.file.truncated, which the upload
    // route turns into a 413 naming the offending file.
    throwFileSizeLimit: false,
  });

  app.get("/health", async (_req, reply) => {
    reply.header("cache-control", "no-store");
    const [database, cache] = await Promise.all([pingDb(), pingRedis()]);
    reply.status(database ? 200 : 503);
    return {
      service: "api-images",
      status: database ? "ok" : "degraded",
      database,
      cache,
      storageRoot: config.STORAGE_ROOT,
      limits: {
        maxUploadBytes: config.IMAGE_MAX_UPLOAD_BYTES,
        maxEdge: config.IMAGE_MAX_EDGE,
        webpQuality: config.IMAGE_WEBP_QUALITY,
      },
      uptimeSeconds: Math.round(process.uptime()),
    };
  });

  await app.register(
    async (scope) => {
      await scope.register(imageServeRoutes);
      await scope.register(imageWriteRoutes);
    },
    { prefix: config.API_PREFIX },
  );

  return app;
}
