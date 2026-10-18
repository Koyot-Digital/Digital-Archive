import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { config } from "../config.js";
import { AppError, badRequest, unauthorized } from "../lib/errors.js";
import { randomToken, sign, unsign } from "../lib/crypto.js";
import { recordAudit } from "../services/audit.js";
import { actorOf } from "./plugin.js";
import * as discord from "./discord.js";
import {
  SESSION_COOKIE,
  STATE_COOKIE,
  cookieOptions,
  createSession,
  destroySession,
  resolveSession,
} from "./session.js";

/**
 * Discord OAuth2 endpoints.
 *
 * The state cookie is HMAC-signed and carries the post-login redirect, so a
 * forged callback cannot bounce a signed-in moderator to an attacker's site.
 */

const callbackQuery = z.object({
  code: z.string().min(1).max(512).optional(),
  state: z.string().min(1).max(512).optional(),
  error: z.string().max(128).optional(),
  error_description: z.string().max(512).optional(),
});

/**
 * Send a refused sign-in back to the web app's login page.
 *
 * A bare 403 here would leave the visitor staring at a JSON body on
 * api.<domain>, with no way back and no explanation. The two refusals that
 * are the viewer's own business - not in the guild, or in it without a
 * granting role - are the common case now that the whole archive is gated, so
 * they get a page rather than a status code.
 */
function denied(reason: "not_member" | "no_role"): string {
  return `${config.WEB_ORIGIN}/login?denied=${reason}`;
}

/** Only allow redirects back into our own web origin. */
function safeReturnTo(raw: string | undefined): string {
  if (!raw) return config.WEB_ORIGIN;
  try {
    const url = new URL(raw, config.WEB_ORIGIN);
    const allowed = new URL(config.WEB_ORIGIN);
    if (url.origin !== allowed.origin) return config.WEB_ORIGIN;
    return url.toString();
  } catch {
    return config.WEB_ORIGIN;
  }
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  /** Who am I? The web app calls this on every page load. */
  app.get("/auth/me", async (req, reply) => {
    reply.header("cache-control", "private, no-store");
    if (req.auth.kind === "user" && req.auth.user) {
      return {
        authenticated: true,
        authEnabled: config.AUTH_ENABLED,
        devBypass: req.auth.devBypass,
        user: {
          id: req.auth.user.id,
          username: req.auth.user.username,
          displayName: req.auth.user.globalName ?? req.auth.user.username,
          avatarUrl: discord.avatarUrl(req.auth.user.discordId, req.auth.user.avatar),
          role: req.auth.user.role,
        },
      };
    }
    return {
      authenticated: false,
      authEnabled: config.AUTH_ENABLED,
      devBypass: false,
      user: null,
    };
  });

  app.get("/auth/discord", async (req, reply) => {
    if (!config.AUTH_ENABLED) {
      // Nothing to log into; the bypass already grants admin.
      return reply.redirect(safeReturnTo((req.query as { return_to?: string }).return_to), 302);
    }

    const query = req.query as { return_to?: string; reauth?: string };
    const returnTo = safeReturnTo(query.return_to);
    const nonce = randomToken(16);
    const state = sign(`${nonce}|${Buffer.from(returnTo).toString("base64url")}`);

    reply.setCookie(STATE_COOKIE, state, {
      ...cookieOptions(600),
      // The callback is a top-level cross-site GET from discord.com.
      sameSite: "lax",
    });
    // `reauth=1` is the login page's escape hatch out of an OAuth error - see
    // authorizeUrl(). It only ever relaxes Discord's prompt behaviour; it
    // grants nothing and skips no check on this side.
    const forceConsent = query.reauth === "1";
    return reply.redirect(discord.authorizeUrl(state, forceConsent), 302);
  });

  app.get("/auth/discord/callback", async (req, reply) => {
    if (!config.AUTH_ENABLED) return reply.redirect(config.WEB_ORIGIN, 302);

    const parsed = callbackQuery.safeParse(req.query);
    if (!parsed.success) throw badRequest("Malformed OAuth callback");
    const { code, state, error, error_description } = parsed.data;

    if (error) {
      req.log.info({ error, error_description }, "discord oauth declined");
      return reply.redirect(`${config.WEB_ORIGIN}/login?error=${encodeURIComponent(error)}`, 302);
    }
    if (!code || !state) throw badRequest("Missing OAuth code or state");

    const cookieState = req.cookies[STATE_COOKIE];
    reply.clearCookie(STATE_COOKIE, { path: "/", domain: config.cookieDomain });

    // Double-submit: the state must match the cookie *and* verify its HMAC.
    if (!cookieState || cookieState !== state) throw unauthorized("OAuth state mismatch");
    const payload = unsign(state);
    if (!payload) throw unauthorized("OAuth state failed verification");

    const encodedReturn = payload.split("|")[1] ?? "";
    const returnTo = safeReturnTo(
      encodedReturn ? Buffer.from(encodedReturn, "base64url").toString("utf8") : undefined,
    );

    const accessToken = await discord.exchangeCode(code);

    // Roles first, profile second: there is no reason to learn anything about
    // an account that is not getting in.
    let guildRoles: string[];
    try {
      guildRoles = await discord.fetchMemberRoles(accessToken);
    } catch (err) {
      if (err instanceof AppError && err.statusCode === 403) {
        return reply.redirect(denied("not_member"), 302);
      }
      throw err;
    }

    const profile = await discord.fetchProfile(accessToken);

    const { upsertDiscordUser } = await import("./session.js");
    let user;
    try {
      user = await upsertDiscordUser(profile, guildRoles);
    } catch (err) {
      if (err instanceof AppError && err.statusCode === 403) {
        req.log.info(
          { discordId: profile.id, roles: guildRoles.length },
          "sign-in refused: no granting guild role",
        );
        return reply.redirect(denied("no_role"), 302);
      }
      throw err;
    }

    const session = await createSession(user.id, {
      ip: req.ip,
      userAgent: req.headers["user-agent"],
    });
    reply.setCookie(SESSION_COOKIE, session.cookieValue, cookieOptions(session.maxAge));

    await recordAudit({
      actorType: "user",
      actorId: user.id,
      actorLabel: user.username,
      action: "user.login",
      targetType: "user",
      targetId: user.id,
      metadata: { role: user.role },
      ip: req.ip,
      userAgent: req.headers["user-agent"],
    });

    return reply.redirect(returnTo, 302);
  });

  app.post("/auth/logout", async (req, reply) => {
    const cookie = req.cookies[SESSION_COOKIE];
    const user = req.auth.kind === "user" ? req.auth.user : null;

    await destroySession(cookie);
    reply.clearCookie(SESSION_COOKIE, { path: "/", domain: config.cookieDomain });

    if (user && !req.auth.devBypass) {
      await recordAudit({
        ...actorOf(req),
        action: "user.logout",
        targetType: "user",
        targetId: user.id,
        ip: req.ip,
        userAgent: req.headers["user-agent"],
      });
    }
    return { ok: true };
  });

  /**
   * Session handoff for the web app's server components: Next.js forwards the
   * cookie here so RSC renders know the viewer's role without re-reading the
   * cookie secret itself.
   */
  app.get("/auth/verify", async (req, reply) => {
    reply.header("cache-control", "private, no-store");
    if (!config.AUTH_ENABLED) return { valid: true, role: "admin" as const };
    const user = await resolveSession(req.cookies[SESSION_COOKIE]);
    if (!user) return { valid: false, role: null };
    return { valid: true, role: user.role };
  });
}
