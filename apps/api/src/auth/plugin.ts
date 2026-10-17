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
 *   anon    — public reads only
 *   user    — a Discord session; carries a role
 *   api_key — a scraper credential; carries scopes, never a role
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
     * Either a sufficiently privileged human *or* a key with the scope —
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
