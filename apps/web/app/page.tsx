import Link from "next/link";
import { ACTION_LABELS, PLATFORM_LABELS, type ModlogAction } from "@archive/shared";
import { api } from "@/lib/api";
import { formatBytes, formatNumber, formatPercent, formatRelative } from "@/lib/format";
import { ModlogList } from "@/components/modlog-card";
import { SearchBox } from "@/components/search-box";
import { Stat } from "@/components/chrome";
import {
  IconAccounts,
  IconArchiveClock,
  IconChevronRight,
  IconImage,
  IconRecord,
  PlatformIcon,
} from "@/components/icons";

export const revalidate = 60;

/**
 * Landing page.
 *
 * Built around the search box, because almost every visit starts with "what
 * does the archive have on this account?" - the recent feed is there so the
 * page is never empty and so the ingest cadence is visible at a glance.
 */
export default async function HomePage() {
  const [stats, recent] = await Promise.all([
    api.stats().catch(() => null),
    api.recent({ limit: 12 }).catch(() => null),
  ]);

  return (
    <div className="animate-fade-up">
      <section className="mx-auto max-w-prose py-10 text-center sm:py-16">
        <h1 className="text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
          Moderation records, kept honestly.
        </h1>
        <p className="mx-auto mt-3 max-w-[38rem] text-pretty text-[0.9375rem] leading-7 text-muted">
          Every record in this archive names its source, keeps its evidence as compressed WebP, and
          carries the full history of every edit made to it.
        </p>

        <div className="mx-auto mt-7 max-w-xl">
          <SearchBox />
          <p className="mt-2 text-xs text-faint">
            Search by username, display name, Roblox or Discord ID, or any text in a record.
          </p>
        </div>
      </section>

      {stats ? (
        <section className="mb-10 grid gap-px overflow-hidden rounded-card border border-line bg-line sm:grid-cols-4">
          <div className="bg-surface px-4 py-4">
            <Stat
              label="Subjects"
              value={formatNumber(stats.archive.subjects)}
              icon={<IconAccounts className="h-3 w-3" />}
            />
          </div>
          <div className="bg-surface px-4 py-4">
            <Stat
              label="Records"
              value={formatNumber(stats.archive.modlogs)}
              icon={<IconRecord className="h-3 w-3" />}
            />
          </div>
          <div className="bg-surface px-4 py-4">
            <Stat
              label="Evidence images"
              icon={<IconImage className="h-3 w-3" />}
              value={formatNumber(stats.archive.images)}
              hint={
                stats.images.originalBytes > 0
                  ? `${formatPercent(stats.images.savedRatio)} smaller as WebP · ${formatBytes(stats.images.storedBytes)} on disk`
                  : undefined
              }
            />
          </div>
          <div className="bg-surface px-4 py-4">
            <Stat
              label="Last ingest"
              value={formatRelative(stats.archive.latestAt)}
              icon={<IconArchiveClock className="h-3 w-3" />}
            />
          </div>
        </section>
      ) : null}

      {/* What the archive actually covers. Two platforms is a fact a reader
          needs before they trust a subject page that says "no records". */}
      {stats?.archive.platforms.length ? (
        <section className="mb-10 flex flex-wrap gap-2">
          {stats.archive.platforms.map(({ platform, subjects, modlogs }) => (
            <Link
              key={platform}
              href={`/subjects?platform=${platform}`}
              className="card flex items-center gap-2 px-3.5 py-2 text-sm transition-colors hover:border-line-strong"
            >
              <PlatformIcon platform={platform} className="h-4 w-4 text-muted" />
              <span className="font-medium">{PLATFORM_LABELS[platform]}</span>
              <span className="tabular-nums text-muted">
                {formatNumber(modlogs)} record{modlogs === 1 ? "" : "s"}
              </span>
              <span className="text-2xs tabular-nums text-faint">
                {formatNumber(subjects)} account{subjects === 1 ? "" : "s"}
              </span>
            </Link>
          ))}
        </section>
      ) : null}

      {stats?.archive.actions.length ? (
        <section className="mb-10">
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-faint">
            Browse by action
          </h2>
          <div className="flex flex-wrap gap-2">
            {stats.archive.actions.map(({ action, count }) => (
              <Link
                key={action}
                href={`/modlogs?action=${action}`}
                className="group inline-flex items-center gap-2 rounded-md border border-line bg-surface px-3 py-1.5 text-sm transition-colors hover:border-line-strong hover:bg-raised"
              >
                <span className="link-block text-fg">
                  {ACTION_LABELS[action as ModlogAction] ?? action}
                </span>
                <span className="font-mono text-2xs tabular-nums text-faint">
                  {formatNumber(count)}
                </span>
              </Link>
            ))}
          </div>
        </section>
      ) : null}

      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-faint">
            Recently archived
          </h2>
          <Link href="/modlogs" className="link inline-flex items-center gap-0.5 text-xs">
            View all
            <IconChevronRight className="h-3 w-3" />
          </Link>
        </div>

        <div className="card overflow-hidden">
          <ModlogList
            modlogs={recent?.modlogs ?? []}
            showSubject
            empty={
              recent
                ? "The archive is empty. Run the scraper, or POST a batch to /ingress to get started."
                : "Could not reach the archive API."
            }
          />
        </div>
      </section>
    </div>
  );
}
