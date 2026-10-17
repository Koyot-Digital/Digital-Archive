import fp from "fastify-plugin";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import underPressure from "@fastify/under-pressure";
import { config } from "../config.js";
import { redis } from "../lib/redis.js";

/**
 * The shared security stack, in two halves.
 *
 * Fastify runs onRequest hooks in registration order, and the rate limiter
 * needs to know *who* is calling before it picks a bucket. So the app
 * registers `securityPlugin` (cookies, headers, CORS) -> `authPlugin` ->
 * `rateLimitPlugin`, and the limiter can read `req.auth`.
 */

export interface SecurityOptions {
  /** Images are served cross-origin into the web app, so CORP must be lax. */
  allowCrossOriginResources?: boolean;
}

export const securityPlugin = fp<SecurityOptions>(
  async (app, opts) => {
    // We sign cookie values with our own HMAC, so no secret here.
    await app.register(cookie, { parseOptions: { path: "/" } });

    await app.register(helmet, {
      contentSecurityPolicy: false, // responses are JSON or images, never HTML
      crossOriginResourcePolicy: opts.allowCrossOriginResources
        ? { policy: "cross-origin" }
        : { policy: "same-site" },
      crossOriginEmbedderPolicy: false,
      referrerPolicy: { policy: "no-referrer" },
      hsts: config.isProd ? { maxAge: 31_536_000, includeSubDomains: true } : false,
    });

    const allowedOrigins = new Set(
      [
        config.WEB_ORIGIN,
        ...(config.isProd
          ? []
          : ["http://localhost:3000", "http://127.0.0.1:3000", "http://localhost:3001"]),
      ].filter(Boolean),
    );

    await app.register(cors, {
      credentials: true,
      maxAge: 86_400,
      methods: ["GET", "HEAD", "POST", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: [
        "content-type",
        "authorization",
        "x-api-key",
        "x-archive-signature",
        "x-idempotency-key",
      ],
      exposedHeaders: [
        "x-request-id",
        "x-ratelimit-limit",
        "x-ratelimit-remaining",
        "retry-after",
      ],
      origin(origin, cb) {
        // Same-origin and non-browser clients (scrapers, curl) send no Origin.
        if (!origin) return cb(null, true);
        cb(null, allowedOrigins.has(origin));
      },
    });

    // Correlation id on every response, so "it 500'd" is findable in the logs.
    app.addHook("onSend", async (req, reply) => {
      reply.header("x-request-id", req.id);
    });
  },
  { name: "archive-security" },
);

export interface RateLimitOptions {
  /** Namespaces the Redis counters per service. */
  service: "text" | "images";
  maxRequestsPerMin: number;
}

export const rateLimitPlugin = fp<RateLimitOptions>(
  async (app, opts) => {
    await app.register(rateLimit, {
      global: true,
      // An API key carries its own budget so one scraper cannot eat another's.
      max: (req) => req.auth?.apiKey?.rateLimitPerMin ?? opts.maxRequestsPerMin,
      timeWindow: "1 minute",
      redis,
      // A dead Redis must not lock the archive out; fall back to in-memory.
      skipOnError: true,
      nameSpace: `rl:${opts.service}:`,
      continueExceeding: false,
      keyGenerator(req) {
        if (req.auth?.apiKey) return `key:${req.auth.apiKey.id}`;
        if (req.auth?.user) return `user:${req.auth.user.id}`;
        return `ip:${req.ip}`;
      },
      allowList: (req) => req.method === "OPTIONS",
      errorResponseBuilder(req, context) {
        return {
          error: {
            code: "rate_limited",
            message: `Rate limit exceeded: ${context.max} requests per ${context.after}`,
            requestId: req.id,
            retryAfterMs: context.ttl,
          },
        };
      },
    });

    // Shed load rather than let the event loop collapse under an ingest burst.
    await app.register(underPressure, {
      maxEventLoopDelay: 2_000,
      maxEventLoopUtilization: 0.98,
      retryAfter: 15,
      message: "Server is under heavy load, retry shortly",
      exposeStatusRoute: false,
    });
  },
  { name: "archive-rate-limit" },
);
