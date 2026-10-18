import type { UserRole } from "@archive/shared";
import { config } from "../config.js";

/**
 * Access control.
 *
 * The archive is private: every page and every read is gated, and the gate is
 * a role in one Discord guild. This module is the only place that decides
 * what a set of guild roles entitles someone to, so there is exactly one
 * answer to "why can this person see this" and it is auditable.
 *
 * Guild roles are authoritative, not advisory. A role removed in Discord
 * removes access here - which is the point of deriving from them rather than
 * copying them into a database column once at signup and trusting it for a
 * fortnight.
 */

/** Non-null when `guildRoleIds` entitles this account to reach the archive. */
export function roleForMember(discordId: string, guildRoleIds: readonly string[]): UserRole | null {
  const held = new Set(guildRoleIds);
  const holdsAny = (allowed: ReadonlySet<string>) => {
    for (const roleId of held) if (allowed.has(roleId)) return true;
    return false;
  };

  // Highest wins, and the per-account overrides sit alongside the role that
  // grants the same rank rather than above every role: an override is there
  // so an owner keeps the admin tools, not so it can bypass the guild gate.
  // Reaching this function at all already means guild membership was proven.
  if (config.adminIds.has(discordId) || holdsAny(config.adminRoleIds)) return "admin";
  if (config.moderatorIds.has(discordId) || holdsAny(config.moderatorRoleIds)) return "moderator";
  if (holdsAny(config.viewerRoleIds)) return "viewer";
  return null;
}

/**
 * Human-readable reason a sign-in was refused, for the login page.
 *
 * Deliberately vague about *which* roles would work: the archive's access
 * list is not something an unauthorised visitor should be able to enumerate.
 */
export const NO_ROLE_MESSAGE =
  "Your Discord account does not hold a role that grants access to this archive";
