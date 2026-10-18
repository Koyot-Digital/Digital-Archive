import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { ID_PATTERN, normalizeId, roleAtLeast } from "@archive/shared";
import { badRequest } from "../lib/errors.js";
import type { Visibility } from "../services/modlogs.js";

/** Parse with a schema, letting the error plugin format any ZodError. */
export function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  return schema.parse(value);
}

/**
 * Route params.
 *
 * Public ids are normalised (lowercased, ambiguous characters folded) before
 * validation, so an id transcribed from a screenshot still resolves.
 */
/**
 * An account id in a URL path.
 *
 * Shared by both platforms: a Roblox user id and a Discord snowflake are both
 * bare positive integers, and which namespace a given path segment belongs to
 * is decided by the route it arrived on, not by its shape. Validating the
 * digits here and the platform there keeps the one real check - does this
 * account exist on *this* platform - in a single place.
 */
const zAccountIdPath = z
  .string()
  .regex(/^[1-9][0-9]{0,19}$/, "invalid account id");

export const accountIdParam = z.object({ accountId: zAccountIdPath });

export const accountLogParams = z.object({
  accountId: zAccountIdPath,
  logId: z.string().transform(normalizeId).refine((v) => ID_PATTERN.test(v), "invalid modlog id"),
});

export const accountImageParams = accountLogParams.extend({
  imageId: z
    .string()
    // Accept both /:imageId and /:imageId.webp
    .transform((v) => normalizeId(v.replace(/\.webp$/i, "")))
    .refine((v) => ID_PATTERN.test(v), "invalid image id"),
});

export const idParam = z.object({
  id: z.string().transform(normalizeId).refine((v) => ID_PATTERN.test(v), "invalid id"),
});

/**
 * What this viewer is allowed to see.
 *
 * Moderators see hidden and removed records; everyone else - including every
 * API key without `moderation:read` - sees only published ones.
 */
export function visibilityOf(req: FastifyRequest): Visibility {
  if (req.auth.kind === "user" && roleAtLeast(req.auth.role, "moderator")) return "moderator";
  if (req.auth.kind === "api_key" && req.auth.apiKey?.scopes.includes("moderation:read")) {
    return "moderator";
  }
  return "public";
}

export function actorFor(req: FastifyRequest): { userId?: string | null; apiKeyId?: string | null } {
  return {
    userId: req.auth.user?.id ?? null,
    apiKeyId: req.auth.apiKey?.id ?? null,
  };
}

/**
 * Cache headers.
 *
 * Every response is `private`, and the `s-maxage` that used to let Cloudflare
 * serve archive reads from its edge is gone. That was correct while reading
 * was public; it is a hole now that it is not, because a shared cache keyed on
 * URL alone would happily hand a stored copy to the next caller - who may have
 * no session at all. `Vary: Cookie` is not a defence worth betting the archive
 * on: it is advisory, trivially mishandled by intermediaries, and a cache that
 * ignores it fails silently and in the wrong direction.
 *
 * `private, max-age` still lets the viewer's *own* browser cache, which is
 * where most of the benefit was anyway. Anything a moderator can see is
 * no-store, because the same URL returns a different body per role.
 */
export function setReadCache(
  reply: FastifyReply,
  visibility: Visibility,
  seconds: number,
): void {
  reply.header(
    "cache-control",
    visibility === "moderator" ? "private, no-store" : `private, max-age=${Math.min(seconds, 60)}`,
  );
  reply.header("vary", "Cookie, Authorization, Origin");
}

/** Reject a body that is not an object, before schema parsing. */
export function requireJsonObject(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw badRequest("Request body must be a JSON object");
  }
  return body as Record<string, unknown>;
}
