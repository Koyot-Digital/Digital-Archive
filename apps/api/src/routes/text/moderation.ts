import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { desc, eq, inArray } from "drizzle-orm";
import {
  apiKeyCreateSchema,
  auditQuerySchema,
  roleChangeSchema,
  subjectArchivePath,
} from "@archive/shared";
import { db } from "../../db/client.js";
import { modlogs, subjects, users } from "../../db/schema.js";
import { listAudit, recordAudit } from "../../services/audit.js";
import { createApiKey, listApiKeys, revokeApiKey } from "../../services/apikeys.js";
import { destroyAllSessionsFor } from "../../auth/session.js";
import { actorOf } from "../../auth/plugin.js";
import { badRequest, forbidden, notFound } from "../../lib/errors.js";
import { idParam } from "../helpers.js";

/**
 * Moderation surface: the audit trail, the review queue, credentials and
 * roles. Everything here is private - `no-store` on every response - and
 * every mutation writes its own audit row.
 */
export async function moderationRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("onSend", async (req, reply) => {
    if (req.url.includes("/moderation/")) reply.header("cache-control", "private, no-store");
  });

  /**
   * The moderation log.
   *
   * Readable by moderators, and by an API key holding `moderation:read` so
   * the trail can be shipped to an external SIEM or a Discord webhook relay.
   */
  app.get(
    "/moderation/audit",
    { preHandler: app.requireWriter("moderator", "moderation:read") },
    async (req) => {
      const query = auditQuerySchema.parse(req.query);
      const page = await listAudit(query);
      return {
        ...page,
        entries: page.entries.map((e) => ({ ...e, createdAt: e.createdAt.toISOString() })),
      };
    },
  );

  /** Records awaiting a decision: hidden, plus anything soft-removed. */
  app.get(
    "/moderation/queue",
    { preHandler: app.requireRole("moderator") },
    async (req) => {
      const { limit, page } = z
        .object({
          limit: z.coerce.number().int().min(1).max(100).default(50),
          page: z.coerce.number().int().min(1).default(1),
        })
        .parse(req.query);

      const rows = await db
        .select({
          id: modlogs.id,
          subjectId: modlogs.subjectId,
          platform: subjects.platform,
          externalId: subjects.externalId,
          title: modlogs.title,
          status: modlogs.status,
          action: modlogs.action,
          severity: modlogs.severity,
          source: modlogs.source,
          revision: modlogs.revision,
          updatedAt: modlogs.updatedAt,
        })
        .from(modlogs)
        .innerJoin(subjects, eq(subjects.id, modlogs.subjectId))
        .where(inArray(modlogs.status, ["hidden", "removed"]))
        .orderBy(desc(modlogs.updatedAt))
        .limit(limit)
        .offset((page - 1) * limit);

      return {
        items: rows.map((r) => ({
          ...r,
          externalId: r.externalId.toString(),
          updatedAt: r.updatedAt.toISOString(),
          url: `${subjectArchivePath(r.platform, r.externalId.toString())}/${r.id}`,
        })),
        page,
        limit,
      };
    },
  );

  /* ─────────────────────────── people ─────────────────────────── */

  app.get("/moderation/users", { preHandler: app.requireRole("admin") }, async () => {
    const rows = await db
      .select({
        id: users.id,
        discordId: users.discordId,
        username: users.username,
        globalName: users.globalName,
        role: users.role,
        disabled: users.disabled,
        createdAt: users.createdAt,
        lastLoginAt: users.lastLoginAt,
      })
      .from(users)
      .orderBy(desc(users.createdAt));

    return {
      users: rows.map((r) => ({
        ...r,
        createdAt: r.createdAt.toISOString(),
        lastLoginAt: r.lastLoginAt?.toISOString() ?? null,
      })),
    };
  });

  /**
   * Change someone's role.
   *
   * An admin cannot demote themselves - that is the one guardrail that stops
   * a mis-click leaving the archive with no administrator at all.
   */
  app.post(
    "/moderation/users/:id/role",
    { preHandler: app.requireRole("admin") },
    async (req) => {
      const { id } = idParam.parse(req.params);
      const { role, reason } = roleChangeSchema.parse(req.body);

      if (req.auth.user?.id === id && role !== "admin") {
        throw badRequest("You cannot remove your own admin role");
      }

      const target = await db
        .select()
        .from(users)
        .where(eq(users.id, id))
        .limit(1)
        .then((r) => r[0]);
      if (!target) throw notFound("User");

      await db.update(users).set({ role }).where(eq(users.id, id));
      // A demotion must take effect now, not when the cookie expires.
      if (role === "viewer") await destroyAllSessionsFor(id);

      await recordAudit({
        ...actorOf(req),
        action: "user.role_change",
        targetType: "user",
        targetId: id,
        metadata: { from: target.role, to: role, reason, username: target.username },
        ip: req.ip,
        userAgent: req.headers["user-agent"],
      });

      return { user: { id, role } };
    },
  );

  /* ─────────────────────────── credentials ─────────────────────────── */

  app.get("/moderation/api-keys", { preHandler: app.requireRole("admin") }, async () => {
    return { keys: await listApiKeys() };
  });

  /**
   * Mint a scraper credential. The secret in this response is the only copy
   * that will ever exist.
   */
  app.post(
    "/moderation/api-keys",
    { preHandler: app.requireRole("admin") },
    async (req, reply) => {
      const input = apiKeyCreateSchema.parse(req.body);
      const key = await createApiKey({ ...input, createdBy: req.auth.user?.id ?? null });

      await recordAudit({
        ...actorOf(req),
        action: "apikey.create",
        targetType: "api_key",
        targetId: key.id,
        metadata: { name: key.name, scopes: key.scopes, rateLimitPerMin: key.rateLimitPerMin },
        ip: req.ip,
        userAgent: req.headers["user-agent"],
      });

      reply.status(201);
      return {
        key,
        notice: "Store this secret now. It cannot be retrieved again.",
      };
    },
  );

  app.delete(
    "/moderation/api-keys/:id",
    { preHandler: app.requireRole("admin") },
    async (req) => {
      const { id } = idParam.parse(req.params);
      // A key must not be able to revoke the credential it is using.
      if (req.auth.apiKey?.id === id) throw forbidden("A key cannot revoke itself");

      const revoked = await revokeApiKey(id);
      await recordAudit({
        ...actorOf(req),
        action: "apikey.revoke",
        targetType: "api_key",
        targetId: id,
        metadata: { name: revoked.name },
        ip: req.ip,
        userAgent: req.headers["user-agent"],
      });
      return { revoked: true, id };
    },
  );
}
