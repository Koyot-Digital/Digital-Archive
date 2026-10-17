import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ID_PATTERN, ROBLOX_ID_PATTERN, normalizeId } from "@archive/shared";
import { SITE_NAME, api } from "@/lib/api";
import { cx } from "@/lib/format";
import { ImageFacts } from "@/components/image-grid";
import { PageHeader } from "@/components/chrome";

/**
 * archive.domain.com/roblox-modlogs/[robloxId]/[logId]/[imageId]
 *
 * A single piece of evidence, embedded on its own page.
 *
 * This is a real server-rendered route rather than a modal so each screenshot
 * has a permanent URL that can be cited in a dispute, and so previous/next
 * navigation works with the browser's own history.
 */

interface Props {
  params: Promise<{ robloxId: string; logId: string; imageId: string }>;
}

function clean(value: string): string {
  return normalizeId(value.replace(/\.webp$/i, ""));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const raw = await params;
  const logId = clean(raw.logId);
  const imageId = clean(raw.imageId);
  if (!ROBLOX_ID_PATTERN.test(raw.robloxId) || !ID_PATTERN.test(logId) || !ID_PATTERN.test(imageId)) {
    return { title: "Not found" };
  }

  const data = await api.image(raw.robloxId, logId, imageId).catch(() => null);
  if (!data) return { title: "Image not found" };

  return {
    title: data.image.caption ?? `Evidence · ${data.modlog.title}`,
    description: data.image.caption ?? `Archived evidence image from "${data.modlog.title}".`,
    alternates: { canonical: `/roblox-modlogs/${raw.robloxId}/${logId}/${imageId}` },
    openGraph: {
      title: `${data.image.caption ?? "Evidence"} · ${SITE_NAME}`,
      type: "article",
      images: [{ url: data.image.url, width: data.image.width, height: data.image.height }],
    },
    // Evidence should be reachable by link, not surfaced in image search.
    robots: { index: false, follow: true },
  };
}

export default async function ImagePage({ params }: Props) {
  const raw = await params;
  const logId = clean(raw.logId);
  const imageId = clean(raw.imageId);
  if (!ROBLOX_ID_PATTERN.test(raw.robloxId) || !ID_PATTERN.test(logId) || !ID_PATTERN.test(imageId)) {
    notFound();
  }

  const { image, siblings, modlog } = await api.image(raw.robloxId, logId, imageId);
  const index = siblings.findIndex((s) => s.id === image.id);
  const previous = index > 0 ? siblings[index - 1] : undefined;
  const next = index >= 0 && index < siblings.length - 1 ? siblings[index + 1] : undefined;
  const subjectName =
    modlog.subject?.displayName ?? modlog.subject?.username ?? `Roblox user ${raw.robloxId}`;

  return (
    <div className="animate-fade-up">
      <PageHeader
        breadcrumbs={[
          { label: "Archive", href: "/" },
          { label: subjectName, href: `/roblox-modlogs/${raw.robloxId}` },
          { label: modlog.title, href: modlog.url },
          { label: "Evidence" },
        ]}
        title={image.caption ?? `Evidence ${index + 1} of ${siblings.length}`}
        description={
          <>
            From{" "}
            <Link href={modlog.url} className="link">
              {modlog.title}
            </Link>
          </>
        }
        actions={
          <a href={image.url} download className="btn btn-outline">
            Download WebP
          </a>
        }
      />

      {/* Checkerboard behind the image so transparent PNG screenshots read correctly. */}
      <figure className="overflow-hidden rounded-card border border-line bg-raised">
        <div
          className="flex max-h-[76vh] items-center justify-center"
          style={{
            backgroundImage:
              "linear-gradient(45deg, rgb(var(--line) / 0.6) 25%, transparent 25%, transparent 75%, rgb(var(--line) / 0.6) 75%), linear-gradient(45deg, rgb(var(--line) / 0.6) 25%, transparent 25%, transparent 75%, rgb(var(--line) / 0.6) 75%)",
            backgroundSize: "16px 16px",
            backgroundPosition: "0 0, 8px 8px",
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={image.url}
            alt={image.caption ?? `Evidence image ${index + 1}`}
            width={image.width}
            height={image.height}
            className="max-h-[76vh] w-auto max-w-full object-contain"
          />
        </div>
        {image.caption ? (
          <figcaption className="border-t border-line px-4 py-2.5 text-sm text-muted">
            {image.caption}
          </figcaption>
        ) : null}
      </figure>

      {siblings.length > 1 ? (
        <nav className="mt-4 flex items-center justify-between gap-3">
          {previous ? (
            <Link href={previous.pageUrl} rel="prev" className="btn btn-outline">
              ← Previous
            </Link>
          ) : (
            <span />
          )}

          <div className="flex flex-wrap items-center justify-center gap-1.5">
            {siblings.map((sibling, i) => (
              <Link
                key={sibling.id}
                href={sibling.pageUrl}
                aria-label={`Evidence ${i + 1}`}
                aria-current={sibling.id === image.id ? "page" : undefined}
                className={cx(
                  "h-10 w-14 overflow-hidden rounded border transition-colors",
                  sibling.id === image.id
                    ? "border-accent ring-1 ring-accent"
                    : "border-line opacity-60 hover:opacity-100",
                )}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={sibling.thumbUrl}
                  alt=""
                  loading="lazy"
                  decoding="async"
                  className="h-full w-full object-cover"
                />
              </Link>
            ))}
          </div>

          {next ? (
            <Link href={next.pageUrl} rel="next" className="btn btn-outline">
              Next →
            </Link>
          ) : (
            <span />
          )}
        </nav>
      ) : null}

      <div className="mt-6">
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-faint">
          Image details
        </h2>
        <ImageFacts image={image} />
      </div>
    </div>
  );
}
