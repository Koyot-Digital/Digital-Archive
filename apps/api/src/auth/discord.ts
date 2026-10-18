import { config } from "../config.js";
import { AppError, forbidden, unauthorized } from "../lib/errors.js";
import type { DiscordProfile } from "./session.js";

/**
 * Minimal Discord OAuth2 client.
 *
 * Two scopes and no more: `identify` to know who you are, and
 * `guilds.members.read` to read which roles you hold in the one guild that
 * gates this archive. No message scopes, no email, no guild list.
 */

const API = "https://discord.com/api/v10";
const TIMEOUT_MS = 8_000;

export function scopes(): string[] {
  // Both are always requested. Access is decided by a guild role, so a token
  // that cannot read the caller's roles is of no use to us.
  return ["identify", "guilds.members.read"];
}

/**
 * The authorize URL.
 *
 * `prompt=none` skips Discord's consent screen for an account that has
 * already granted these scopes, which is the right default - a moderator
 * signing in twice a day should not have to re-approve anything.
 *
 * It is the wrong behaviour in one case, which is why this is a parameter.
 * The archive now always asks for `guilds.members.read`, and an account that
 * authorised an earlier build granted only `identify`. Asking for a scope it
 * has not granted while also telling Discord not to prompt is a contradiction,
 * and the user ends up back at /login holding an OAuth error they cannot act
 * on - clicking the button again produces the same error forever. So the
 * login page offers a retry that passes `forceConsent`, which drops the
 * restriction and lets Discord ask the question it needs to ask.
 */
export function authorizeUrl(state: string, forceConsent = false): string {
  const params = new URLSearchParams({
    client_id: config.DISCORD_CLIENT_ID,
    redirect_uri: config.DISCORD_REDIRECT_URI,
    response_type: "code",
    scope: scopes().join(" "),
    state,
    prompt: forceConsent ? "consent" : "none",
  });
  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}

async function call<T>(path: string, init: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new AppError(502, "discord_error", `Discord ${path} returned ${res.status}`, {
      expose: false,
      details: body.slice(0, 500),
    });
  }
  return (await res.json()) as T;
}

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
}

export async function exchangeCode(code: string): Promise<string> {
  const body = new URLSearchParams({
    client_id: config.DISCORD_CLIENT_ID,
    client_secret: config.DISCORD_CLIENT_SECRET,
    grant_type: "authorization_code",
    code,
    redirect_uri: config.DISCORD_REDIRECT_URI,
  });
  const token = await call<TokenResponse>("/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!token.access_token) throw unauthorized("Discord did not return an access token");
  return token.access_token;
}

interface DiscordUserResponse {
  id: string;
  username: string;
  global_name: string | null;
  avatar: string | null;
}

export async function fetchProfile(accessToken: string): Promise<DiscordProfile> {
  const me = await call<DiscordUserResponse>("/users/@me", {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  return {
    id: me.id,
    username: me.username,
    globalName: me.global_name,
    avatar: me.avatar,
  };
}

interface GuildMemberResponse {
  roles?: string[];
}

/**
 * The roles the signing-in account holds in the gating guild.
 *
 * Discord answers 404 for "not a member", which becomes a plain 403 rather
 * than leaking whether the guild exists. Anything else that is not a 200 is a
 * 502: a Discord outage must read as "we could not check", never as "you have
 * no roles", because the second one would quietly fail *open* for an endpoint
 * whose entire job is to decide access.
 */
export async function fetchMemberRoles(accessToken: string): Promise<string[]> {
  const guildId = config.DISCORD_REQUIRED_GUILD_ID;

  const res = await fetch(`${API}/users/@me/guilds/${guildId}/member`, {
    headers: { authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (res.status === 404 || res.status === 403) {
    throw forbidden("You must be a member of the archive Discord to sign in");
  }
  if (!res.ok) {
    throw new AppError(502, "discord_error", "Could not verify guild membership", {
      expose: false,
    });
  }

  const member = (await res.json()) as GuildMemberResponse;
  return member.roles ?? [];
}

/**
 * The same lookup with the bot token, for re-checking a session whose owner
 * is not standing in front of an OAuth prompt.
 *
 * Returns null when the account is no longer in the guild, and throws when
 * Discord could not be reached - the caller decides what a failed check means,
 * because "left the guild" and "Discord is down" must not collapse into one
 * value.
 */
export async function fetchMemberRolesAsBot(discordId: string): Promise<string[] | null> {
  const guildId = config.DISCORD_REQUIRED_GUILD_ID;
  if (!config.DISCORD_BOT_TOKEN) {
    throw new AppError(503, "discord_error", "No bot token: cannot re-verify guild roles", {
      expose: false,
    });
  }

  const res = await fetch(`${API}/guilds/${guildId}/members/${discordId}`, {
    headers: { authorization: `Bot ${config.DISCORD_BOT_TOKEN}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (res.status === 404) return null; // no longer a member
  if (!res.ok) {
    throw new AppError(502, "discord_error", `Discord member lookup returned ${res.status}`, {
      expose: false,
    });
  }

  const member = (await res.json()) as GuildMemberResponse;
  return member.roles ?? [];
}

/** CDN avatar URL, or null when the account uses a default avatar. */
export function avatarUrl(discordId: string, avatar: string | null, size = 64): string | null {
  if (!avatar) return null;
  const ext = avatar.startsWith("a_") ? "gif" : "webp";
  return `https://cdn.discordapp.com/avatars/${discordId}/${avatar}.${ext}?size=${size}`;
}
