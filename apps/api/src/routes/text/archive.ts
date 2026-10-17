import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  listModlogsQuerySchema,
  listSubjectsQuerySchema,
  searchQuerySchema,
  modlogCreateSchema,
  modlogUpdateSchema,
  statusChangeSchema,
} from "@archive/shared";
import { notFound } from "../../lib/errors.js";
import { recordAudit } from "../../services/audit.js";
import { imageStats } from "../../services/images.js";
import { unfurlLinksFor } from "../../services/links.js";
import {
  archiveStats,
  createModlog,
  getImageForRoute,
  getModlog,
  getRevisions,
  listModlogsForSubject,
  listRecentModlogs,
  searchModlogs,
  setStatus,
  updateModlog,
} from "../../services/modlogs.js";
import { getSubject, listSubjects } from "../../services/subjects.js";
import { getRelatedAccounts } from "../../services/threads.js";
import {
  getDiscordUser,
  hasBotToken,
  listModerators,
  refreshStaleDiscordUsers,
} from "../../services/discord-users.js";
import { actorOf } from "../../auth/plugin.js";
import {
  actorFor,
  idParam,
  imageParams,
  logParams,
  robloxIdParam,
  setReadCache,
  visibilityOf,
} from "../helpers.js";

/**
 * The raw-text archive API.
 *
 * Read routes mirror the public web URLs one-for-one
 * (`/roblox-modlogs/:robloxId/:logId/:imageId`) so the web app's server
 * components can fetch exactly the page they are rendering, and so the API is
 * explorable by hand without reading a spec first.
 */
export async function archiveRoutes(app: FastifyInstance): Promise<void> {
  /* ─────────────────────────── public reads ─────────────────────────── */

  app.get("/stats", async (_req, reply) => {
    setReadCache(reply, "public", 300);
    const [archive, images] = await Promise.all([archiveStats(), imageStats()]);
    return { archive, images };
  });

  app.get("/subjects", async (req, reply) => {
    const query = listSubjectsQuerySchema.parse(req.query);
    setReadCache(reply, visibilityOf(req), 60);
    return listSubjects(query);
  });

  app.get("/modlogs", async (req, reply) => {
    const query = listModlogsQuerySchema.parse(req.query);
    const visibility = visibilityOf(req);
    setReadCache(reply, visibility, 60);
    return listRecentModlogs(query, visibility);
  });

  app.get("/search", async (req, reply) => {
    const query = searchQuerySchema.parse(req.query);
    const visibility = visibilityOf(req);
    setReadCache(reply, visibility, 120);
    return searchModlogs(query, visibility);
  });

  /**
   * Everything the archive holds about one Roblox account.
   *
   * `relatedAccounts` is part of this response rather than a separate call:
   * an alt grouping is the first thing a reader needs in order to trust a
   * page that says "no records" — the sanction may be filed under the main.
   */
  app.get("/roblox-modlogs/:robloxId", async (req, reply) => {
    const { robloxId } = robloxIdParam.parse(req.params);
    const query = listModlogsQuerySchema.parse(req.query);
    const visibility = visibilityOf(req);

    const [subject, page, relatedAccounts] = await Promise.all([
      getSubject(robloxId),
      listModlogsForSubject(robloxId, query, visibility),
      getRelatedAccounts(robloxId),
    ]);

    setReadCache(reply, visibility, 60);
    return { subject, relatedAccounts, ...page };
  });

  /** One modlog, with images, link embeds and the subject inlined. */
  app.get("/roblox-modlogs/:robloxId/:logId", async (req, reply) => {
    const { robloxId, logId } = logParams.parse(req.params);
    const visibility = visibilityOf(req);
    const modlog = await getModlog(logId, visibility, robloxId);
    setReadCache(reply, visibility, 120);
    return { modlog };
  });

  /**
   * Metadata for one embedded image, plus its siblings so the viewer can
   * page through the evidence without another round trip. The bytes
   * themselves come from the images service.
   */
  app.get("/roblox-modlogs/:robloxId/:logId/:imageId", async (req, reply) => {
    const { robloxId, logId, imageId } = imageParams.parse(req.params);
    const visibility = visibilityOf(req);
    const { image, modlog, siblings } = await getImageForRoute(
      robloxId,
      logId,
      imageId,
      visibility,
    );
    setReadCache(reply, visibility, 300);
    return {
      image,
      siblings,
      modlog: {
        id: modlog.id,
        robloxId: modlog.robloxId,
        title: modlog.title,
        url: modlog.url,
        subject: modlog.subject,
      },
    };
  });

  /** Flat id lookup, for when the caller does not know the subject. */
  app.get("/modlogs/:id", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const visibility = visibilityOf(req);
    const modlog = await getModlog(id, visibility);
    setReadCache(reply, visibility, 120);
    return { modlog };
  });

  /** Wikipedia-style edit history. */
  app.get("/modlogs/:id/revisions", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const visibility = visibilityOf(req);
    // Confirms existence and applies the visibility rules.
    await getModlog(id, visibility);
    setReadCache(reply, visibility, 60);
    const revisions = await getRevisions(id);
    return {
      modlogId: id,
      revisions: revisions.map((r) => ({
        ...r,
        createdAt: r.createdAt.toISOString(),
      })),
    };
  });

  /* ─────────────────────── discord identities ─────────────────────── */

  /**
   * Who files records here, derived from the records themselves.
   *
   * Not a configured staff list: it is a fact about what is in the archive,
   * so it cannot fall out of step with it. Cached for an hour — the set of
   * people writing moderation logs changes on the scale of months.
   */
  app.get("/moderators", async (req, reply) => {
    const { limit } = z
      .object({ limit: z.coerce.number().int().min(1).max(500).default(100) })
      .parse(req.query);
    setReadCache(reply, visibilityOf(req), 3600);
    const moderators = await listModerators(limit);
    return { moderators, identityRefresh: hasBotToken() };
  });

  /** One Discord identity, as the archive currently holds it. */
  app.get("/discord-users/:discordId", async (req, reply) => {
    const { discordId } = z
      .object({ discordId: z.string().regex(/^[0-9]{15,24}$/, "invalid Discord id") })
      .parse(req.params);

    const user = await getDiscordUser(discordId);
    if (!user) throw notFound("Discord user");
    setReadCache(reply, visibilityOf(req), 3600);
    return { user };
  });

  /**
   * Re-resolve the stalest identities against the Discord API.
   *
   * Admin-only and deliberately manual. Avatars and display names drift
   * whether or not anything is being ingested, and the archive should be able
   * to catch up without re-importing a scrape.
   */
  app.post(
    "/discord-users/refresh",
    { preHandler: app.requireRole("admin") },
    async (req, reply) => {
      const { limit } = z
        .object({ limit: z.coerce.number().int().min(1).max(200).default(50) })
        .parse(req.query);

      const summary = await refreshStaleDiscordUsers(limit);
      if (summary.tokenMissing) {
        reply.status(503);
        return {
          error: {
            code: "discord_token_missing",
            message:
              "DISCORD_BOT_TOKEN is not configured; the archive is using the " +
              "usernames and avatars captured at scrape time",
          },
          summary,
        };
      }

      await recordAudit({
        ...actorOf(req),
        action: "subject.update",
        targetType: "discord_users",
        targetId: "refresh",
        metadata: { ...summary },
        ip: req.ip,
        userAgent: req.headers["user-agent"],
      });
      return { summary };
    },
  );

  /* ─────────────────────────── writes ─────────────────────────── */

  app.post(
    "/modlogs",
    { preHandler: app.requireWriter("moderator", "ingress:write") },
    async (req, reply) => {
      const input = modlogCreateSchema.parse(req.body);
      const modlog = await createModlog(
        {
          ...input,
          occurredAt: input.occurredAt,
        },
        actorFor(req),
      );

      await recordAudit({
        ...actorOf(req),
        action: "modlog.create",
        targetType: "modlog",
        targetId: modlog.id,
        metadata: { robloxId: modlog.robloxId, source: modlog.source, title: modlog.title },
        ip: req.ip,
        userAgent: req.headers["user-agent"],
      });

      // Link previews are a nicety; never make the writer wait on them.
      void unfurlLinksFor(modlog.id).catch(() => {});

      reply.status(201);
      return { modlog };
    },
  );

  app.patch(
    "/modlogs/:id",
    { preHandler: app.requireRole("moderator") },
    async (req) => {
      const { id } = idParam.parse(req.params);
      const patch = modlogUpdateSchema.parse(req.body);
      const before = await getModlog(id, "moderator");

      const modlog = await updateModlog(id, patch, actorFor(req));

      await recordAudit({
        ...actorOf(req),
        action: "modlog.update",
        targetType: "modlog",
        targetId: id,
        metadata: {
          changeReason: patch.changeReason,
          fields: Object.keys(patch).filter((k) => k !== "changeReason"),
          fromRevision: before.revision,
          toRevision: modlog.revision,
        },
        ip: req.ip,
        userAgent: req.headers["user-agent"],
      });

      if (patch.body !== undefined) void unfurlLinksFor(id).catch(() => {});
      return { modlog };
    },
  );

  /**
   * Status transitions are their own endpoint rather than a PATCH field: a
   * takedown is an action with a reason, and giving it a URL makes it
   * obvious in the audit trail.
   */
  app.post(
    "/modlogs/:id/status",
    { preHandler: app.requireRole("moderator") },
    async (req) => {
      const { id } = idParam.parse(req.params);
      const { status, changeReason } = statusChangeSchema.parse(req.body);
      const before = await getModlog(id, "moderator");

      const modlog = await setStatus(id, status, changeReason, actorFor(req));

      await recordAudit({
        ...actorOf(req),
        action: "modlog.status_change",
        targetType: "modlog",
        targetId: id,
        metadata: { from: before.status, to: status, changeReason },
        ip: req.ip,
        userAgent: req.headers["user-agent"],
      });
      return { modlog };
    },
  );

  /**
   * DELETE is a soft delete. Purging a record outright would break the audit
   * trail that this archive exists to keep, so the row stays and the body
   * stops being served.
   */
  app.delete(
    "/modlogs/:id",
    { preHandler: app.requireRole("admin") },
    async (req) => {
      const { id } = idParam.parse(req.params);
      const reason = z
        .object({ changeReason: z.string().trim().min(3).max(500) })
        .parse(req.body ?? {}).changeReason;

      const modlog = await setStatus(id, "removed", reason, actorFor(req));

      await recordAudit({
        ...actorOf(req),
        action: "modlog.delete",
        targetType: "modlog",
        targetId: id,
        metadata: { changeReason: reason },
        ip: req.ip,
        userAgent: req.headers["user-agent"],
      });
      return { modlog, removed: true };
    },
  );
}
