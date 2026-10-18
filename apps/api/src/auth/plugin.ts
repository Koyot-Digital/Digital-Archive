import fp from "fastify-plugin";
import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import { and, eq, isNull, or, gt } from "drizzle-orm";
import { roleAtLeast, type ApiKeyScope, type UserRole } from "@archive/shared";
import { db } from "../db/client.js";
import { apiKeys } from "../db/schema.js";
import { config } from "../config.js";
import { sha256 } from "../lib/crypto.js";
import { forbidden, unauthorized } from "../lib/errors.js";
import { cached } from "../lib/redis.js";
import { SESSION_COOKIE, ensureDevUser, resolveSession, type SessionUser } from "./session.js";

/**
 * Request identity.
 *
 * Three shapes, resolved once per request in an onRequest hook:
 *   anon    - reaches /health and the auth endpoints, nothing else
 *   user    - a Discord session; carries a role derived from a guild role
 *   api_key - a scraper credential; carries scopes, never a role
 *
 * Keeping scrapers out of the role system is deliberate: an ingest token can
 * write records but can never, for example, change someone's role or read the
 * moderation audit trail unless that exact scope was granted.
 */
export interface AuthContext {
  kind: "anon" | "user" | "api_key";
  user: SessionUser | null;
  role: UserRole | null;
  apiKey: { id: string; name: string; scopes: ApiKeyScope[]; rateLimitPerMin: number } | null;
  /** True when AUTH_ENABLED=false granted this request admin rights. */
  devBypass: boolean;
}

const ANON: AuthContext = {
  kind: "anon",
  user: null,
  role: null,
  apiKey: null,
  devBypass: false,
};

declare module "fastify" {
  interface FastifyRequest {
    auth: AuthContext;
  }
  interface FastifyInstance {
    requireRole(min: UserRole): preHandlerHookHandler;
    requireScope(...scopes: ApiKeyScope[]): preHandlerHookHandler;
    requireWriter(min: UserRole, ...scopes: ApiKeyScope[]): preHandlerHookHandler;
  }
}

/**
 * Paths that answer without a credential.
 *
 * Only two kinds, and both have to be open for the system to work at all:
 * the liveness probe that compose and the tunnel poll, and the auth endpoints
 * themselves - you cannot require a session to obtain one.
 *
 * /auth/me and /auth/verify are included deliberately: both answer
 * "authenticated: false" for an anonymous caller, which is what lets the web
 * app render a login page instead of a stack trace.
 */
function isAlwaysOpen(path: string): boolean {
  if (path === "/health") return true;
  const prefix = config.API_PREFIX;
  return path === `${prefix}/auth` || path.startsWith(`${prefix}/auth/`);
}

/**
 * Paths that exist for machines and carry their own scope guard, so the read
 * gate must not also demand archive:read of them.
 */
function isMachinePath(path: string): boolean {
  const prefix = config.API_PREFIX;
  return path === `${prefix}/ingress` || path.startsWith(`${prefix}/ingress/`);
}

function bearer(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) return header.slice(7).trim() || null;
  const alt = req.headers["x-api-key"];
  if (typeof alt === "string" && alt.trim()) return alt.trim();
  return null;
}

async function resolveApiKey(secret: string): Promise<AuthContext["apiKey"]> {
  const hash = sha256(secret);
  // Short cache: a revoke takes effect within 30s, which is a fair trade for
  // not hitting Postgres on every ingest request.
  return cached(`apikey:${hash}`, 30, async () => {
    const row = await db
      .select({
        id: apiKeys.id,
        name: apiKeys.name,
        scopes: apiKeys.scopes,
        rateLimitPerMin: apiKeys.rateLimitPerMin,
      })
      .from(apiKeys)
      .where(
        and(
          eq(apiKeys.keyHash, hash),
          isNull(apiKeys.revokedAt),
          or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, new Date())),
        ),
      )
      .limit(1)
      .then((r) => r[0] ?? null);
    return row;
  });
}

export const authPlugin = fp(
  async (app) => {
    // Declared with no default: Fastify v5 rejects a shared object/null
    // default, and the onRequest hook below always assigns before any route
    // or later hook runs.
    app.decorateRequest("auth");

    app.addHook("onRequest", async (req) => {
      req.auth = ANON;

      // Development bypass: no cookie, no key, full rights. Guarded by
      // config.ts, which refuses AUTH_ENABLED=false under NODE_ENV=production.
      if (!config.AUTH_ENABLED) {
        const user = await ensureDevUser();
        req.auth = { kind: "user", user, role: user.role, apiKey: null, devBypass: true };
        return;
      }

      const secret = bearer(req);
      if (secret) {
        const key = await resolveApiKey(secret);
        if (!key) throw unauthorized("Invalid or revoked API key");
        req.auth = { kind: "api_key", user: null, role: null, apiKey: key, devBypass: false };
        // Fire-and-forget: last_used_at is diagnostics, not correctness.
        void db
          .update(apiKeys)
          .set({ lastUsedAt: new Date() })
          .where(eq(apiKeys.id, key.id))
          .catch(() => {});
        return;
      }

      const cookie = req.cookies[SESSION_COOKIE];
      if (cookie) {
        const user = await resolveSession(cookie);
        if (user) {
          req.auth = { kind: "user", user, role: user.role, apiKey: null, devBypass: false };
        }
      }
    });

    /**
     * The gate: nothing is readable without a credential.
     *
     * This runs as a hook rather than as a preHandler on each route on
     * purpose. Per-route guards are opt-in, and an archive that is private
     * cannot afford a default of "public unless someone remembered" - a route
     * added next month would ship open, and nothing would fail to tell us.
     * Inverting it means a new route is closed until it is listed below, and
     * the list is short enough to read in one sitting.
     *
     * Registered after the hook above, so `req.auth` is already resolved.
     */
    app.addHook("onRequest", async (req) => {
      // CORS preflight carries no credentials by definition.
      if (req.method === "OPTIONS") return;

      const path = req.url.split("?")[0] ?? "/";
      if (isAlwaysOpen(path)) return;

      if (req.auth.devBypass) return;

      if (req.auth.kind === "user") {
        // Every role outranks or equals viewer, and an account that holds no
        // granting guild role never gets a session in the first place - so
        // reaching here with a user means access was proven. The check stays
        // as the explicit statement of what the gate requires.
        if (!roleAtLeast(req.auth.role, "viewer")) throw forbidden("Requires archive access");
        return;
      }

      if (req.auth.kind === "api_key") {
        // Writes are guarded per route by requireScope/requireWriter. What is
        // left is reads, and a key only reads the archive with archive:read -
        // so an ingest credential that leaks cannot be turned around and used
        // to pull the archive back out.
        const isRead = req.method === "GET" || req.method === "HEAD";
        if (isRead && !isMachinePath(path) && !req.auth.apiKey?.scopes.includes("archive:read")) {
          throw forbidden("API key is missing scope: archive:read");
        }
        return;
      }

      throw unauthorized("Sign in with Discord to view the archive");
    });

    /** Human roles only. An API key never satisfies this. */
    app.decorate("requireRole", (min: UserRole): preHandlerHookHandler => {
      return async (req: FastifyRequest, _reply: FastifyReply) => {
        if (req.auth.kind !== "user") throw unauthorized("Sign in with Discord to continue");
        if (!roleAtLeast(req.auth.role, min)) throw forbidden(`Requires the ${min} role`);
      };
    });

    /** API keys only, and only with every listed scope. */
    app.decorate("requireScope", (...required: ApiKeyScope[]): preHandlerHookHandler => {
      return async (req: FastifyRequest) => {
        const key = req.auth.apiKey;
        if (req.auth.devBypass) return;
        if (!key) throw unauthorized("This endpoint requires an API key");
        const missing = required.filter((s) => !key.scopes.includes(s));
        if (missing.length) throw forbidden(`API key is missing scope(s): ${missing.join(", ")}`);
      };
    });

    /**
     * Either a sufficiently privileged human *or* a key with the scope -
     * used by endpoints both the web UI and the scraper legitimately call.
     */
    app.decorate(
      "requireWriter",
      (min: UserRole, ...required: ApiKeyScope[]): preHandlerHookHandler => {
        return async (req: FastifyRequest) => {
          if (req.auth.devBypass) return;
          if (req.auth.kind === "user") {
            if (!roleAtLeast(req.auth.role, min)) throw forbidden(`Requires the ${min} role`);
            return;
          }
          const key = req.auth.apiKey;
          if (!key) throw unauthorized("Authentication required");
          const missing = required.filter((s) => !key.scopes.includes(s));
          if (missing.length) throw forbidden(`API key is missing scope(s): ${missing.join(", ")}`);
        };
      },
    );
  },
  { name: "archive-auth" },
);

/** Audit-friendly description of whoever made the request. */
export function actorOf(req: FastifyRequest): {
  actorType: "user" | "api_key" | "system";
  actorId: string | null;
  actorLabel: string | null;
} {
  if (req.auth.kind === "user" && req.auth.user) {
    return {
      actorType: "user",
      actorId: req.auth.user.id,
      actorLabel: req.auth.devBypass ? "dev-bypass" : req.auth.user.username,
    };
  }
  if (req.auth.kind === "api_key" && req.auth.apiKey) {
    return { actorType: "api_key", actorId: req.auth.apiKey.id, actorLabel: req.auth.apiKey.name };
  }
  return { actorType: "system", actorId: null, actorLabel: null };
}
