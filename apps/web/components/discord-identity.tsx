import type { DiscordIdentity } from "@/lib/api";
import { cx } from "@/lib/format";

/**
 * Discord identities in the archive.
 *
 * Avatars come straight from Discord's CDN as plain `<img>` elements rather
 * than through `next/image`: they are 32-64px, already WebP, already on a
 * global CDN, and routing them through the optimiser would mean proxying
 * third-party images through the homeserver for no gain.
 *
 * Every identity carries where its values came from, and the UI says so. A
 * name captured in a scrape months ago is not the same claim as one resolved
 * from Discord today, and an archive that shows both should not pretend
 * otherwise.
 */

const SIZES = {
  sm: { px: 20, cls: "h-5 w-5", text: "text-[0.6rem]" },
  md: { px: 28, cls: "h-7 w-7", text: "text-2xs" },
  lg: { px: 40, cls: "h-10 w-10", text: "text-xs" },
} as const;

export type AvatarSize = keyof typeof SIZES;

export function DiscordAvatar({
  user,
  size = "md",
}: {
  user: DiscordIdentity;
  size?: AvatarSize;
}) {
  const { px, cls, text } = SIZES[size];
  const name = user.displayName ?? user.username ?? user.id;

  return (
    <span className={cx("relative inline-block shrink-0", cls)}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={user.avatarUrl}
        alt=""
        width={px}
        height={px}
        loading="lazy"
        decoding="async"
        className={cx("rounded-full border border-line bg-raised object-cover", cls)}
      />
      {user.bot ? (
        <span
          title="Bot account"
          className={cx(
            "absolute -bottom-0.5 -right-0.5 grid place-items-center rounded-full bg-accent px-1 font-bold text-accent-fg",
            text,
          )}
        >
          B
        </span>
      ) : null}
      <span className="sr-only">{name}</span>
    </span>
  );
}

/** Avatar plus name, the inline form used in thread headers and lists. */
export function DiscordChip({
  user,
  size = "md",
  subtitle,
}: {
  user: DiscordIdentity;
  size?: AvatarSize;
  subtitle?: React.ReactNode;
}) {
  const name = user.displayName ?? user.username ?? `Discord ${user.id}`;
  const handle = user.username && user.username !== name ? `@${user.username}` : null;

  return (
    <span className="flex min-w-0 items-center gap-2">
      <DiscordAvatar user={user} size={size} />
      <span className="min-w-0">
        <span className="flex flex-wrap items-center gap-x-1.5">
          <span className="truncate text-sm font-medium text-fg">{name}</span>
          {handle ? <span className="truncate text-xs text-faint">{handle}</span> : null}
          <StalenessMark user={user} />
        </span>
        {subtitle ? <span className="block text-xs text-muted">{subtitle}</span> : null}
      </span>
    </span>
  );
}

/**
 * Marks an identity that has never been confirmed against Discord.
 *
 * Deliberately quiet — a dotted underline and a tooltip. It matters for
 * provenance but it is not a warning: the scraped name was accurate when it
 * was captured, and that is most of what an archive promises.
 */
export function StalenessMark({ user }: { user: DiscordIdentity }) {
  if (user.resolvedFrom === "discord_api") return null;
  return (
    <span
      title="Name and avatar as captured when this thread was scraped; not yet confirmed against Discord"
      className="cursor-help text-2xs text-faint underline decoration-dotted underline-offset-2"
    >
      as scraped
    </span>
  );
}
