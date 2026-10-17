import {
  bigint,
  bigserial,
  boolean,
  char,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type {
  ApiKeyScope,
  ModlogAction,
  ModlogSeverity,
  RecordStatus,
  SubjectRelation,
  ThreadRole,
  UserRole,
} from "@archive/shared";
import type { LinkKind } from "@archive/shared";

/**
 * Drizzle mirrors of the tables created by src/db/migrations/*.sql.
 *
 * The SQL files are the source of truth (they also carry the generated
 * tsvector column, the triggers and the partial indexes that drizzle-kit
 * cannot express cleanly); this module exists so queries are typed.
 */

/** Postgres full-text search vector. Generated in SQL, read-only here. */
const tsvector = customType<{ data: string; driverData: string }>({
  dataType: () => "tsvector",
});

const id16 = (name: string) => char(name, { length: 16 });
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

/* ───────────────────────────── identity ───────────────────────────── */

export const users = pgTable(
  "users",
  {
    id: id16("id").primaryKey(),
    discordId: varchar("discord_id", { length: 32 }).notNull(),
    username: varchar("username", { length: 64 }).notNull(),
    globalName: varchar("global_name", { length: 64 }),
    avatar: varchar("avatar", { length: 128 }),
    role: varchar("role", { length: 16 }).$type<UserRole>().notNull().default("viewer"),
    disabled: boolean("disabled").notNull().default(false),
    createdAt: createdAt(),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  },
  (t) => ({
    discordIdx: uniqueIndex("users_discord_id_key").on(t.discordId),
    roleIdx: index("users_role_idx").on(t.role),
  }),
);

export const sessions = pgTable(
  "sessions",
  {
    /** SHA-256 of the cookie token. The raw token never touches the DB. */
    tokenHash: char("token_hash", { length: 64 }).primaryKey(),
    userId: id16("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    ip: varchar("ip", { length: 64 }),
    userAgent: text("user_agent"),
  },
  (t) => ({
    userIdx: index("sessions_user_idx").on(t.userId),
    expiryIdx: index("sessions_expires_idx").on(t.expiresAt),
  }),
);

export const apiKeys = pgTable(
  "api_keys",
  {
    id: id16("id").primaryKey(),
    name: varchar("name", { length: 64 }).notNull(),
    /** SHA-256 of the full secret. */
    keyHash: char("key_hash", { length: 64 }).notNull(),
    /** First 8 chars of the secret, for display in the admin UI. */
    prefix: varchar("prefix", { length: 12 }).notNull(),
    scopes: text("scopes").array().$type<ApiKeyScope[]>().notNull(),
    rateLimitPerMin: integer("rate_limit_per_min").notNull().default(120),
    createdBy: id16("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => ({
    hashIdx: uniqueIndex("api_keys_key_hash_key").on(t.keyHash),
  }),
);

/* ───────────────────────────── archive ───────────────────────────── */

export const subjects = pgTable(
  "subjects",
  {
    /** Roblox user id. Stored as bigint, exposed as a string everywhere. */
    robloxId: bigint("roblox_id", { mode: "bigint" }).primaryKey(),
    username: varchar("username", { length: 64 }),
    displayName: varchar("display_name", { length: 64 }),
    avatarUrl: varchar("avatar_url", { length: 2048 }),
    /** Denormalised counter maintained by a trigger on modlogs. */
    logCount: integer("log_count").notNull().default(0),
    firstLogAt: timestamp("first_log_at", { withTimezone: true }),
    lastLogAt: timestamp("last_log_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    searchVector: tsvector("search_vector"),
  },
  (t) => ({
    usernameIdx: index("subjects_username_idx").on(t.username),
    lastLogIdx: index("subjects_last_log_idx").on(t.lastLogAt),
    logCountIdx: index("subjects_log_count_idx").on(t.logCount),
  }),
);

export const modlogs = pgTable(
  "modlogs",
  {
    id: id16("id").primaryKey(),
    robloxId: bigint("roblox_id", { mode: "bigint" })
      .notNull()
      .references(() => subjects.robloxId, { onDelete: "cascade" }),

    title: varchar("title", { length: 300 }).notNull(),
    bodyMd: text("body_md").notNull().default(""),
    /** Sanitised HTML, rendered on write so reads never touch a markdown lib. */
    bodyHtml: text("body_html").notNull().default(""),
    action: varchar("action", { length: 32 }).$type<ModlogAction>().notNull().default("other"),
    severity: varchar("severity", { length: 16 })
      .$type<ModlogSeverity>()
      .notNull()
      .default("info"),
    reason: text("reason"),

    occurredAt: timestamp("occurred_at", { withTimezone: true }),
    source: varchar("source", { length: 64 }).notNull(),
    /** Scraper-side identity; with `source` it forms the dedupe key. */
    sourceId: varchar("source_id", { length: 200 }).notNull(),
    sourceUrl: varchar("source_url", { length: 2048 }),

    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    evidence: jsonb("evidence").$type<Record<string, unknown>>().notNull().default({}),

    status: varchar("status", { length: 16 }).$type<RecordStatus>().notNull().default("published"),
    revision: integer("revision").notNull().default(1),
    imageCount: smallint("image_count").notNull().default(0),

    /* Discord forum provenance — null for records from any other source. */
    discordPostId: varchar("discord_post_id", { length: 24 }),
    discordGuildId: varchar("discord_guild_id", { length: 24 }),
    discordForumId: varchar("discord_forum_id", { length: 24 }),
    discordForumName: varchar("discord_forum_name", { length: 128 }),
    /** The moderator who opened the thread. */
    discordAuthorId: varchar("discord_author_id", { length: 24 }).references(
      () => discordUsers.id,
      { onDelete: "set null" },
    ),
    threadReplyCount: integer("thread_reply_count").notNull().default(0),
    threadLastAt: timestamp("thread_last_at", { withTimezone: true }),
    threadArchived: boolean("thread_archived").notNull().default(false),
    threadLocked: boolean("thread_locked").notNull().default(false),
    /** Support ticket reference as written, e.g. `#6066`. */
    ticketRef: varchar("ticket_ref", { length: 32 }),

    createdBy: id16("created_by").references(() => users.id, { onDelete: "set null" }),
    updatedBy: id16("updated_by").references(() => users.id, { onDelete: "set null" }),
    ingestedBy: id16("ingested_by").references(() => apiKeys.id, { onDelete: "set null" }),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
    searchVector: tsvector("search_vector"),
  },
  (t) => ({
    sourceKey: uniqueIndex("modlogs_source_key").on(t.source, t.sourceId),
    discordPostKey: uniqueIndex("modlogs_discord_post_key").on(t.discordPostId),
    ticketIdx: index("modlogs_ticket_idx").on(t.ticketRef),
    subjectIdx: index("modlogs_subject_idx").on(t.robloxId, t.occurredAt),
    createdIdx: index("modlogs_created_idx").on(t.createdAt),
    occurredIdx: index("modlogs_occurred_idx").on(t.occurredAt),
    actionIdx: index("modlogs_action_idx").on(t.action),
    severityIdx: index("modlogs_severity_idx").on(t.severity),
    statusIdx: index("modlogs_status_idx").on(t.status),
  }),
);

export const modlogRevisions = pgTable(
  "modlog_revisions",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    modlogId: id16("modlog_id")
      .notNull()
      .references(() => modlogs.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    /** Full row snapshot taken *before* the change was applied. */
    snapshot: jsonb("snapshot").$type<Record<string, unknown>>().notNull(),
    changeReason: text("change_reason"),
    changedBy: id16("changed_by").references(() => users.id, { onDelete: "set null" }),
    changedByKey: id16("changed_by_key").references(() => apiKeys.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => ({
    revKey: uniqueIndex("modlog_revisions_key").on(t.modlogId, t.revision),
    modlogIdx: index("modlog_revisions_modlog_idx").on(t.modlogId),
  }),
);

export const images = pgTable(
  "images",
  {
    id: id16("id").primaryKey(),
    modlogId: id16("modlog_id")
      .notNull()
      .references(() => modlogs.id, { onDelete: "cascade" }),
    /** Denormalised so /:robloxId/:logId/:imageId validates in one query. */
    robloxId: bigint("roblox_id", { mode: "bigint" }).notNull(),

    position: smallint("position").notNull().default(0),
    caption: text("caption"),

    /** SHA-256 of the *original* bytes: dedupes re-scrapes per modlog. */
    sha256: char("sha256", { length: 64 }).notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    bytes: integer("bytes").notNull(),
    thumbBytes: integer("thumb_bytes").notNull().default(0),
    originalBytes: integer("original_bytes").notNull(),
    originalFormat: varchar("original_format", { length: 16 }).notNull(),
    /** Tiny inline WebP data URI used as a blur placeholder. */
    blurDataUrl: text("blur_data_url"),

    status: varchar("status", { length: 16 }).$type<RecordStatus>().notNull().default("published"),
    uploadedBy: id16("uploaded_by").references(() => users.id, { onDelete: "set null" }),
    uploadedByKey: id16("uploaded_by_key").references(() => apiKeys.id, { onDelete: "set null" }),
    sourceUrl: varchar("source_url", { length: 2048 }),
    createdAt: createdAt(),
  },
  (t) => ({
    dedupeKey: uniqueIndex("images_modlog_sha_key").on(t.modlogId, t.sha256),
    modlogIdx: index("images_modlog_idx").on(t.modlogId, t.position),
    subjectIdx: index("images_subject_idx").on(t.robloxId),
  }),
);

export const links = pgTable(
  "links",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    modlogId: id16("modlog_id")
      .notNull()
      .references(() => modlogs.id, { onDelete: "cascade" }),
    position: smallint("position").notNull().default(0),
    url: varchar("url", { length: 2048 }).notNull(),
    domain: varchar("domain", { length: 253 }).notNull(),
    kind: varchar("kind", { length: 32 }).$type<LinkKind>().notNull().default("generic"),
    ref: varchar("ref", { length: 128 }),

    /** OpenGraph cache, filled by the unfurler. Null until fetched. */
    title: text("title"),
    description: text("description"),
    imageUrl: varchar("image_url", { length: 2048 }),
    siteName: varchar("site_name", { length: 128 }),
    unfurledAt: timestamp("unfurled_at", { withTimezone: true }),
    unfurlFailed: boolean("unfurl_failed").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => ({
    modlogKey: uniqueIndex("links_modlog_url_key").on(t.modlogId, t.url),
    modlogIdx: index("links_modlog_idx").on(t.modlogId, t.position),
    domainIdx: index("links_domain_idx").on(t.domain),
  }),
);

/* ───────────────────────────── discord ───────────────────────────── */

/**
 * Discord identities seen on the archive's source threads.
 *
 * Both a join target and a cache: rows are seeded from whatever the scrape
 * saw, then refreshed from the Discord API, which is why `resolvedFrom` and
 * the failure counter exist. Eighteen moderators wrote five hundred records,
 * so an avatar change should touch one row rather than five hundred.
 */
export const discordUsers = pgTable(
  "discord_users",
  {
    /** Snowflake. Text, because that is what it is everywhere it is used. */
    id: varchar("id", { length: 24 }).primaryKey(),
    username: varchar("username", { length: 64 }),
    globalName: varchar("global_name", { length: 64 }),
    /** Avatar hash, kept so a CDN URL can be rebuilt at any size. */
    avatar: varchar("avatar", { length: 128 }),
    avatarUrl: varchar("avatar_url", { length: 2048 }),
    bot: boolean("bot").notNull().default(false),

    resolvedFrom: varchar("resolved_from", { length: 16 })
      .$type<"scrape" | "discord_api">()
      .notNull()
      .default("scrape"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }),
    fetchFailures: smallint("fetch_failures").notNull().default(0),
    fetchError: text("fetch_error"),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    stalenessIdx: index("discord_users_staleness_idx").on(t.fetchedAt, t.fetchFailures),
  }),
);

/** Who appeared on a record's thread, and how much they said. */
export const modlogParticipants = pgTable(
  "modlog_participants",
  {
    modlogId: id16("modlog_id")
      .notNull()
      .references(() => modlogs.id, { onDelete: "cascade" }),
    discordId: varchar("discord_id", { length: 24 })
      .notNull()
      .references(() => discordUsers.id, { onDelete: "cascade" }),
    role: varchar("role", { length: 16 }).$type<ThreadRole>().notNull().default("commenter"),
    messageCount: integer("message_count").notNull().default(0),
    firstAt: timestamp("first_at", { withTimezone: true }),
    lastAt: timestamp("last_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => ({
    pk: uniqueIndex("modlog_participants_pkey").on(t.modlogId, t.discordId),
    userIdx: index("modlog_participants_user_idx").on(t.discordId, t.role),
  }),
);

/**
 * The discussion that followed a moderation log.
 *
 * Frequently where the appeal, the correction and the second opinion live, so
 * dropping it would lose the part of the record a reader most wants. Stored
 * pre-sanitised: it is user-written text from outside the archive.
 */
export const modlogMessages = pgTable(
  "modlog_messages",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    modlogId: id16("modlog_id")
      .notNull()
      .references(() => modlogs.id, { onDelete: "cascade" }),
    messageId: varchar("message_id", { length: 24 }).notNull(),
    authorId: varchar("author_id", { length: 24 }).references(() => discordUsers.id, {
      onDelete: "set null",
    }),
    position: smallint("position").notNull().default(0),
    contentMd: text("content_md").notNull().default(""),
    contentHtml: text("content_html").notNull().default(""),
    postedAt: timestamp("posted_at", { withTimezone: true }),
    editedAt: timestamp("edited_at", { withTimezone: true }),
    imageCount: smallint("image_count").notNull().default(0),
    status: varchar("status", { length: 16 }).$type<RecordStatus>().notNull().default("published"),
    createdAt: createdAt(),
  },
  (t) => ({
    messageKey: uniqueIndex("modlog_messages_key").on(t.modlogId, t.messageId),
    modlogIdx: index("modlog_messages_modlog_idx").on(t.modlogId, t.position),
  }),
);

/**
 * Alt / rename groupings between Roblox accounts.
 *
 * Both directions are stored, each worded from its own side, so either
 * account's page can show the link without a UNION and without "A moved to B"
 * rendering as "B moved to A".
 */
export const subjectRelations = pgTable(
  "subject_relations",
  {
    robloxId: bigint("roblox_id", { mode: "bigint" })
      .notNull()
      .references(() => subjects.robloxId, { onDelete: "cascade" }),
    relatedRobloxId: bigint("related_roblox_id", { mode: "bigint" })
      .notNull()
      .references(() => subjects.robloxId, { onDelete: "cascade" }),
    relation: varchar("relation", { length: 16 })
      .$type<SubjectRelation>()
      .notNull()
      .default("alt"),
    /** The record that asserted the link, so a reader can check the claim. */
    assertedBy: id16("asserted_by").references(() => modlogs.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => ({
    pk: uniqueIndex("subject_relations_pkey").on(t.robloxId, t.relatedRobloxId),
    relatedIdx: index("subject_relations_related_idx").on(t.relatedRobloxId),
  }),
);

/* ───────────────────────────── oversight ───────────────────────────── */

export const auditLog = pgTable(
  "audit_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    actorType: varchar("actor_type", { length: 16 }).notNull(),
    actorId: varchar("actor_id", { length: 32 }),
    actorLabel: varchar("actor_label", { length: 128 }),
    action: varchar("action", { length: 64 }).notNull(),
    targetType: varchar("target_type", { length: 32 }),
    targetId: varchar("target_id", { length: 64 }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    ip: varchar("ip", { length: 64 }),
    userAgent: text("user_agent"),
    createdAt: createdAt(),
  },
  (t) => ({
    createdIdx: index("audit_log_created_idx").on(t.createdAt),
    actionIdx: index("audit_log_action_idx").on(t.action),
    targetIdx: index("audit_log_target_idx").on(t.targetType, t.targetId),
    actorIdx: index("audit_log_actor_idx").on(t.actorType, t.actorId),
  }),
);

/**
 * Ingress replay guard. Redis holds the hot 24h window; this table is the
 * durable record so a Redis flush cannot cause a double-ingest.
 */
export const ingressBatches = pgTable(
  "ingress_batches",
  {
    batchId: varchar("batch_id", { length: 64 }).primaryKey(),
    apiKeyId: id16("api_key_id").references(() => apiKeys.id, { onDelete: "set null" }),
    result: jsonb("result").$type<Record<string, unknown>>().notNull(),
    recordCount: integer("record_count").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => ({
    createdIdx: index("ingress_batches_created_idx").on(t.createdAt),
  }),
);

export type DbUser = typeof users.$inferSelect;
export type DbApiKey = typeof apiKeys.$inferSelect;
export type DbSubject = typeof subjects.$inferSelect;
export type DbModlog = typeof modlogs.$inferSelect;
export type DbImage = typeof images.$inferSelect;
export type DbLink = typeof links.$inferSelect;
export type DbDiscordUser = typeof discordUsers.$inferSelect;
export type DbModlogMessage = typeof modlogMessages.$inferSelect;
export type DbSubjectRelation = typeof subjectRelations.$inferSelect;
