import type { DiscordIdentity } from "@/lib/api";
import { cx } from "@/lib/format";
import { IconBot, IconUnverified } from "./icons";

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

/**
 * An avatar on its own is decorative.
 *
 * Every place the archive draws one, the account's name is already next to it
 * in text, so the image carries no information a reader would otherwise miss:
 * `alt=""` and no screen-reader label, or assistive tech announces the same
 * name twice in a row. The bot marker is the exception — it is a fact about
 * the account that appears nowhere else, so it gets read out.
 */
export function DiscordAvatar({
  user,
  size = "md",
}: {
  user: DiscordIdentity;
  size?: AvatarSize;
}) {
  const { px, cls, text } = SIZES[size];

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
          role="img"
          aria-label="Bot account"
          className={cx(
            "absolute -bottom-1 -right-1 grid place-items-center rounded-full border border-bg bg-accent p-[1.5px] text-accent-fg",
            text,
          )}
        >
          {/* Overlays the avatar, so it stays a step below `.icon-sm`: any
              larger and it covers the face it is annotating. */}
          <IconBot className="h-3 w-3" strokeWidth={2.5} />
        </span>
      ) : null}
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
 * A dashed shield, repeated next to every one of these names — so it has to
 * be small. It matters for provenance but it is not a warning: the scraped
 * name was accurate when it was captured, and that is most of what an archive
 * promises. The sentence it replaces is in the tooltip and the accessible
 * name, and the /moderators page states it once in full for the whole set.
 */
export function StalenessMark({ user }: { user: DiscordIdentity }) {
  if (user.resolvedFrom === "discord_api") return null;
  const label =
    "Name and avatar as captured when this thread was scraped; not yet confirmed against Discord";
  return (
    <span className="cursor-help text-faint" title={label} role="img" aria-label={label}>
      <IconUnverified className="icon-sm" />
    </span>
  );
}
