export const MODLOG_ACTIONS = [
  "ban",
  "temp_ban",
  "kick",
  "warning",
  "mute",
  "content_deletion",
  "account_deletion",
  "termination",
  "note",
  "other",
] as const;
export type ModlogAction = (typeof MODLOG_ACTIONS)[number];

export const MODLOG_SEVERITIES = ["info", "low", "medium", "high", "critical"] as const;
export type ModlogSeverity = (typeof MODLOG_SEVERITIES)[number];

/**
 * published — visible to everyone.
 * hidden    — visible to moderators only (under review / disputed).
 * removed   — soft-deleted; body withheld from the public API, row retained so
 *             the audit trail and revision history stay intact.
 */
export const RECORD_STATUSES = ["published", "hidden", "removed"] as const;
export type RecordStatus = (typeof RECORD_STATUSES)[number];

/**
 * How one Roblox account in the archive relates to another.
 *
 * Moderation threads routinely name several accounts at once — a main and its
 * alts, or an account that was abandoned for a new one. The relation is kept
 * so the archive can group them without claiming they are the same row.
 */
export const SUBJECT_RELATIONS = ["alt", "successor", "predecessor", "related"] as const;
export type SubjectRelation = (typeof SUBJECT_RELATIONS)[number];

export const RELATION_LABELS: Record<SubjectRelation, string> = {
  alt: "Alternate account",
  successor: "Moved to",
  predecessor: "Moved from",
  related: "Related account",
};

/**
 * The relation as it reads from the other account's page.
 *
 * Groupings are stored in both directions so either account's page can show
 * the link, and "A moved to B" must not render as "B moved to A".
 */
export const INVERSE_RELATION: Record<SubjectRelation, SubjectRelation> = {
  alt: "alt",
  successor: "predecessor",
  predecessor: "successor",
  related: "related",
};

/** Why a Discord account appears on a record's thread. */
export const THREAD_ROLES = ["author", "commenter"] as const;
export type ThreadRole = (typeof THREAD_ROLES)[number];

export const USER_ROLES = ["viewer", "moderator", "admin"] as const;
export type UserRole = (typeof USER_ROLES)[number];

/** Ascending privilege. Compare with `roleRank(a) >= roleRank(b)`. */
export function roleRank(role: UserRole): number {
  return USER_ROLES.indexOf(role);
}

export function roleAtLeast(role: UserRole | null | undefined, min: UserRole): boolean {
  if (!role) return false;
  return roleRank(role) >= roleRank(min);
}

export const API_KEY_SCOPES = [
  "ingress:write",
  "images:write",
  "archive:read",
  "moderation:read",
] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

export const AUDIT_ACTIONS = [
  "modlog.create",
  "modlog.update",
  "modlog.status_change",
  "modlog.delete",
  "modlog.restore",
  "image.upload",
  "image.delete",
  "subject.update",
  "user.login",
  "user.logout",
  "user.role_change",
  "apikey.create",
  "apikey.revoke",
  "ingress.batch",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export const IMAGE_VARIANTS = ["full", "thumb"] as const;
export type ImageVariant = (typeof IMAGE_VARIANTS)[number];

export const ACCEPTED_IMAGE_MIME = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/avif",
  "image/tiff",
  "image/bmp",
] as const;

/** Human labels, kept next to the enums so web + API never drift. */
export const ACTION_LABELS: Record<ModlogAction, string> = {
  ban: "Ban",
  temp_ban: "Temporary ban",
  kick: "Kick",
  warning: "Warning",
  mute: "Mute",
  content_deletion: "Content deletion",
  account_deletion: "Account deletion",
  termination: "Termination",
  note: "Note",
  other: "Other",
};

export const SEVERITY_LABELS: Record<ModlogSeverity, string> = {
  info: "Info",
  low: "Low",
  medium: "Medium",
  high: "High",
  critical: "Critical",
};
