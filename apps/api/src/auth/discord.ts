import { config } from "../config.js";
import { AppError, forbidden, unauthorized } from "../lib/errors.js";
import type { DiscordProfile } from "./session.js";

/**
 * Minimal Discord OAuth2 client.
 *
 * Only `identify` (plus `guilds.members.read` when a guild gate is
 * configured) is requested: the archive needs to know who you are, nothing
 * more. No bot token, no message scopes.
 */

const API = "https://discord.com/api/v10";
const TIMEOUT_MS = 8_000;

export function scopes(): string[] {
  return config.DISCORD_REQUIRED_GUILD_ID
    ? ["identify", "guilds.members.read"]
    : ["identify"];
}

export function authorizeUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: config.DISCORD_CLIENT_ID,
    redirect_uri: config.DISCORD_REDIRECT_URI,
    response_type: "code",
    scope: scopes().join(" "),
    state,
    prompt: "none",
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

/**
 * Enforce the optional guild gate.
 *
 * Discord answers 404 for "not a member", which we translate into a plain
 * 403 rather than leaking whether the guild exists.
 */
export async function assertGuildMembership(accessToken: string): Promise<void> {
  const guildId = config.DISCORD_REQUIRED_GUILD_ID;
  if (!guildId) return;

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
}

/** CDN avatar URL, or null when the account uses a default avatar. */
export function avatarUrl(discordId: string, avatar: string | null, size = 64): string | null {
  if (!avatar) return null;
  const ext = avatar.startsWith("a_") ? "gif" : "webp";
  return `https://cdn.discordapp.com/avatars/${discordId}/${avatar}.${ext}?size=${size}`;
}
