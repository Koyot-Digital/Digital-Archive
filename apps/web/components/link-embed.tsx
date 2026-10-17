import type { LinkEmbed as LinkEmbedData } from "@/lib/api";
import { prettyUrl } from "@/lib/format";

/**
 * Link embeds.
 *
 * Every URL found in a modlog body gets rendered as a card rather than a bare
 * href: the archive's whole job is to preserve context, and a naked
 * `t.co/xyz` preserves none. The OpenGraph data is fetched server-side by the
 * API and cached, so nothing here calls out to a third party at render time
 * and the viewer's browser never pings the linked host.
 */

function KindIcon({ kind }: { kind: string }) {
  const glyph =
    kind === "youtube" || kind === "video"
      ? "▶"
      : kind === "twitter"
        ? "𝕏"
        : kind === "discord"
          ? "◇"
          : kind.startsWith("roblox")
            ? "◈"
            : kind === "image"
              ? "▣"
              : "↗";
  return (
    <span
      aria-hidden
      className="grid h-8 w-8 shrink-0 place-items-center rounded-md border border-line bg-bg text-xs text-muted"
    >
      {glyph}
    </span>
  );
}

const KIND_LABELS: Record<string, string> = {
  roblox_user: "Roblox profile",
  roblox_game: "Roblox experience",
  roblox_group: "Roblox group",
  roblox_asset: "Roblox asset",
  youtube: "YouTube",
  twitter: "X / Twitter",
  discord: "Discord",
  image: "Image",
  video: "Video",
  generic: "Link",
};

export function LinkEmbedCard({ link }: { link: LinkEmbedData }) {
  const label = KIND_LABELS[link.kind] ?? link.domain;

  return (
    <a
      href={link.url}
      target="_blank"
      rel="noopener noreferrer nofollow ugc"
      className="group flex gap-3 rounded-card border border-line bg-surface p-3 transition-colors hover:border-line-strong hover:bg-raised"
    >
      <KindIcon kind={link.kind} />

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-2xs uppercase tracking-wide text-faint">
          <span>{label}</span>
          {link.siteName ? (
            <>
              <span aria-hidden>·</span>
              <span className="normal-case tracking-normal">{link.siteName}</span>
            </>
          ) : null}
        </div>

        <p className="mt-0.5 truncate text-sm font-medium text-fg group-hover:text-accent">
          {link.title ?? prettyUrl(link.url)}
        </p>

        {link.description ? (
          <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted">{link.description}</p>
        ) : null}

        <p className="mt-1 truncate font-mono text-2xs text-faint">{prettyUrl(link.url, 72)}</p>
      </div>

      {link.imageUrl ? (
        <div className="hidden h-16 w-24 shrink-0 overflow-hidden rounded-md border border-line bg-bg sm:block">
          {/* Remote OG thumbnail: referrer withheld, failures degrade silently. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={link.imageUrl}
            alt=""
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
            className="h-full w-full object-cover"
          />
        </div>
      ) : null}
    </a>
  );
}

export function LinkEmbedList({ links }: { links: LinkEmbedData[] }) {
  if (!links.length) return null;
  return (
    <section className="mt-8">
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-faint">
        Referenced links ({links.length})
      </h2>
      <div className="grid gap-2 sm:grid-cols-2">
        {links.map((link) => (
          <LinkEmbedCard key={link.url} link={link} />
        ))}
      </div>
    </section>
  );
}
