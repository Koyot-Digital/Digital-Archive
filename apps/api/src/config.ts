import { z } from "zod";
import { subjectArchivePath, type SubjectPlatform } from "@archive/shared";

/**
 * Environment parsing.
 *
 * Every knob the services read lives here and is validated once at boot: a
 * missing secret or a malformed URL should stop the process immediately
 * rather than surface as a 500 three hours into an ingest run.
 */

const bool = (def: boolean) =>
  z
    .union([z.boolean(), z.string()])
    .default(def)
    .transform((v) => (typeof v === "boolean" ? v : /^(1|true|yes|on)$/i.test(v.trim())));

const csv = z
  .string()
  .default("")
  .transform((v) =>
    v
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),

    ROOT_DOMAIN: z.string().min(1).default("localhost"),
    WEB_ORIGIN: z.string().url().default("http://localhost:3000"),
    API_ORIGIN: z.string().url().default("http://localhost:4001"),
    API_PREFIX: z
      .string()
      .default("/digitalarchive/v1")
      .transform((v) => (v.startsWith("/") ? v : `/${v}`))
      .transform((v) => v.replace(/\/+$/, "")),

    TEXT_PORT: z.coerce.number().int().min(1).max(65535).default(4001),
    IMAGES_PORT: z.coerce.number().int().min(1).max(65535).default(4002),
    HOST: z.string().default("0.0.0.0"),

    DATABASE_URL: z.string().min(1),
    PG_POOL_MAX: z.coerce.number().int().min(1).max(200).default(16),
    REDIS_URL: z.string().min(1).default("redis://127.0.0.1:6379"),

    SESSION_SECRET: z.string().min(16),
    INGRESS_HMAC_SECRET: z.string().min(16).optional(),
    /** Shared secret for text -> images service calls on the docker network. */
    INTERNAL_TOKEN: z.string().min(16),
    /** Where the text service reaches the images service internally. */
    IMAGES_INTERNAL_URL: z.string().url().default("http://127.0.0.1:4002"),

    AUTH_ENABLED: bool(true),
    DISCORD_CLIENT_ID: z.string().default(""),
    DISCORD_CLIENT_SECRET: z.string().default(""),
    DISCORD_REDIRECT_URI: z.string().default(""),
    /**
     * The guild whose roles decide access. Mandatory under AUTH_ENABLED:
     * every app role is derived from a role in *this* guild, so without it
     * there is nothing to derive from.
     */
    DISCORD_REQUIRED_GUILD_ID: z.string().default(""),

    /**
     * Guild role snowflakes that grant each app role, highest wins.
     *
     * These are the access control list. Holding none of them means no
     * account is created and nothing is served - not even a record listing.
     */
    ADMIN_DISCORD_ROLE_IDS: csv,
    MODERATOR_DISCORD_ROLE_IDS: csv,
    VIEWER_DISCORD_ROLE_IDS: csv,

    /**
     * Per-account overrides, by Discord user id. Kept because an owner has to
     * be able to reach the admin tools without depending on a guild role
     * being intact - but they are overrides, not the primary mechanism, and
     * they cannot grant access to someone who has left the guild.
     */
    ADMIN_DISCORD_IDS: csv,
    MODERATOR_DISCORD_IDS: csv,

    SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(14),
    /**
     * How long a session is trusted before the viewer's guild roles are
     * re-fetched. A role removed in Discord takes at most this long to end
     * the session, which is why a 14-day cookie is not a 14-day grant.
     */
    ROLE_RECHECK_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),

    /**
     * Bot token used to resolve the Discord accounts that appear on scraped
     * records - the moderator who filed a log, and whoever argued about it.
     *
     * Separate from the OAuth credentials above and genuinely optional: the
     * scrape already carries the usernames and avatars it saw, so without a
     * token the archive renders those and simply never refreshes them. The
     * `identify` OAuth scope cannot stand in for this, because it only ever
     * describes the signed-in user, never a third party.
     */
    DISCORD_BOT_TOKEN: z.string().default(""),
    /** How long a resolved Discord identity is trusted before re-fetching. */
    DISCORD_USER_TTL_HOURS: z.coerce.number().int().min(1).max(8760).default(168),

    STORAGE_ROOT: z.string().default("./storage"),
    IMAGE_MAX_UPLOAD_BYTES: z.coerce.number().int().min(1024).default(26_214_400),
    IMAGE_MAX_EDGE: z.coerce.number().int().min(320).max(8192).default(2400),
    IMAGE_WEBP_QUALITY: z.coerce.number().int().min(1).max(100).default(72),
    IMAGE_THUMB_EDGE: z.coerce.number().int().min(64).max(2048).default(480),
    IMAGE_THUMB_QUALITY: z.coerce.number().int().min(1).max(100).default(58),
    IMAGE_MAX_PER_LOG: z.coerce.number().int().min(1).max(200).default(24),

    RATE_LIMIT_PUBLIC_PER_MIN: z.coerce.number().int().min(1).default(240),
    RATE_LIMIT_INGRESS_PER_MIN: z.coerce.number().int().min(1).default(120),
    RATE_LIMIT_UPLOAD_PER_MIN: z.coerce.number().int().min(1).default(60),

    EMBED_UNFURL_ENABLED: bool(true),
    EMBED_UNFURL_TIMEOUT_MS: z.coerce.number().int().min(250).max(30_000).default(4000),

    /** Trust X-Forwarded-For. True behind Caddy + cloudflared, which is the
     *  only supported topology, but overridable for bare-metal runs. */
    TRUST_PROXY: bool(true),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === "production" && !env.AUTH_ENABLED) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "AUTH_ENABLED=false is a development-only bypass and is refused when NODE_ENV=production",
      });
    }
    if (env.AUTH_ENABLED) {
      for (const key of [
        "DISCORD_CLIENT_ID",
        "DISCORD_CLIENT_SECRET",
        "DISCORD_REDIRECT_URI",
        // The whole archive is role-gated, so the guild is not optional.
        "DISCORD_REQUIRED_GUILD_ID",
        // Roles are re-checked mid-session with a bot token. Without one a
        // removed role would keep working until the cookie expired, which
        // turns a 15-minute revocation into a two-week one.
        "DISCORD_BOT_TOKEN",
      ] as const) {
        if (!env[key]) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `${key} is required when AUTH_ENABLED=true`,
          });
        }
      }

      // Fail at boot rather than serve a site nobody can get into.
      const grants =
        env.ADMIN_DISCORD_ROLE_IDS.length +
        env.MODERATOR_DISCORD_ROLE_IDS.length +
        env.VIEWER_DISCORD_ROLE_IDS.length +
        env.ADMIN_DISCORD_IDS.length +
        env.MODERATOR_DISCORD_IDS.length;
      if (grants === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "No access is granted to anyone: set at least one of " +
            "ADMIN_DISCORD_ROLE_IDS, MODERATOR_DISCORD_ROLE_IDS, " +
            "VIEWER_DISCORD_ROLE_IDS, ADMIN_DISCORD_IDS or MODERATOR_DISCORD_IDS",
        });
      }
    }
  });

function load() {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join(".") || "env"}: ${i.message}`);
    // Deliberately bypassing the logger: it needs config to exist.
    console.error(`Invalid environment:\n${lines.join("\n")}`);
    process.exit(1);
  }
  return parsed.data;
}

const env = load();

export const config = {
  ...env,
  isProd: env.NODE_ENV === "production",
  isDev: env.NODE_ENV === "development",

  /** Cookie domain shared by archive.* and api.* so one session covers both. */
  cookieDomain: env.ROOT_DOMAIN === "localhost" ? undefined : `.${env.ROOT_DOMAIN}`,

  adminIds: new Set(env.ADMIN_DISCORD_IDS),
  moderatorIds: new Set(env.MODERATOR_DISCORD_IDS),

  adminRoleIds: new Set(env.ADMIN_DISCORD_ROLE_IDS),
  moderatorRoleIds: new Set(env.MODERATOR_DISCORD_ROLE_IDS),
  viewerRoleIds: new Set(env.VIEWER_DISCORD_ROLE_IDS),

  roleRecheckSeconds: env.ROLE_RECHECK_MINUTES * 60,

  /** Public URL for a stored image variant. */
  imageUrl(id: string, variant: "full" | "thumb" = "full"): string {
    const suffix = variant === "thumb" ? "?v=thumb" : "";
    return `${env.API_ORIGIN}${env.API_PREFIX}/images/${id}.webp${suffix}`;
  },

  /** Canonical web URL for a modlog, under its subject's platform path. */
  modlogUrl(platform: SubjectPlatform, externalId: string, id: string): string {
    return `${env.WEB_ORIGIN}${subjectArchivePath(platform, externalId)}/${id}`;
  },

  /** Base URL for internal text -> images calls. */
  imagesInternalBase(): string {
    return `${env.IMAGES_INTERNAL_URL.replace(/\/+$/, "")}${env.API_PREFIX}`;
  },
} as const;

export type Config = typeof config;
