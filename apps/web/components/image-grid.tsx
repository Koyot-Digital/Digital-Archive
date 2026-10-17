import Link from "next/link";
import type { ArchiveImage } from "@/lib/api";
import { formatBytes, formatPercent } from "@/lib/format";

/**
 * Evidence gallery.
 *
 * Each tile links to the image's own page
 * (`/roblox-modlogs/:robloxId/:logId/:imageId`) rather than opening a JS
 * lightbox, so every screenshot in the archive has a stable, shareable,
 * server-rendered URL - which is the whole reason that route exists.
 */
export function ImageGrid({ images }: { images: ArchiveImage[] }) {
  if (!images.length) return null;

  return (
    <section className="mt-8">
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-faint">
        Evidence ({images.length})
      </h2>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {images.map((image, index) => (
          <Link
            key={image.id}
            href={image.pageUrl}
            className="group relative block overflow-hidden rounded-card border border-line bg-raised transition-colors hover:border-accent/60"
            aria-label={image.caption ?? `Evidence image ${index + 1}`}
          >
            <div className="relative aspect-[4/3] overflow-hidden">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={image.thumbUrl}
                alt={image.caption ?? `Evidence image ${index + 1}`}
                width={image.width}
                height={image.height}
                loading={index < 3 ? "eager" : "lazy"}
                decoding="async"
                className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.02]"
                style={
                  image.blurDataUrl
                    ? { backgroundImage: `url(${image.blurDataUrl})`, backgroundSize: "cover" }
                    : undefined
                }
              />
            </div>

            <div className="flex items-center justify-between gap-2 border-t border-line px-2.5 py-1.5">
              <span className="truncate text-2xs text-muted">
                {image.caption ?? `${image.width}×${image.height}`}
              </span>
              <span className="shrink-0 font-mono text-2xs text-faint">
                {formatBytes(image.bytes)}
              </span>
            </div>
          </Link>
        ))}
      </div>
    </section>
  );
}

/** The single-image page's metadata panel. */
export function ImageFacts({ image }: { image: ArchiveImage }) {
  const ratio = image.originalBytes > 0 ? 1 - image.bytes / image.originalBytes : 0;

  const facts: [string, string][] = [
    ["Dimensions", `${image.width} × ${image.height}`],
    ["Stored", `${formatBytes(image.bytes)} WebP`],
    ["Original", `${formatBytes(image.originalBytes)} ${image.originalFormat.toUpperCase()}`],
    ["Reduction", ratio > 0 ? formatPercent(ratio) : "-"],
    ["Image ID", image.id],
  ];

  return (
    <dl className="grid gap-px overflow-hidden rounded-card border border-line bg-line text-sm sm:grid-cols-2">
      {facts.map(([label, value]) => (
        <div key={label} className="bg-surface px-3.5 py-2.5">
          <dt className="text-2xs uppercase tracking-wide text-faint">{label}</dt>
          <dd className="mt-0.5 font-mono text-[0.8125rem] text-fg">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
