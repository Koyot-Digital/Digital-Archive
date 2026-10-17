import type { Metadata } from "next";
import Link from "next/link";
import { PLATFORM_LABELS, SUBJECT_PLATFORMS } from "@archive/shared";
import { api } from "@/lib/api";
import { cx, formatDate, formatNumber } from "@/lib/format";
import { PageHeader } from "@/components/chrome";
import { Pagination } from "@/components/pagination";

export const metadata: Metadata = {
  title: "Subjects",
  description: "Every account the archive holds moderation records for, on either platform.",
};

export const revalidate = 60;

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

const SORTS = [
  { key: "recent", label: "Recently active" },
  { key: "most_logs", label: "Most records" },
  { key: "username", label: "Username" },
] as const;

export default async function SubjectsPage({ searchParams }: Props) {
  const search = await searchParams;
  const page = Math.max(1, Number.parseInt(one(search.page) ?? "1", 10) || 1);
  const q = one(search.q);
  const sort = one(search.sort) ?? "recent";
  const rawPlatform = one(search.platform);
  const platform = SUBJECT_PLATFORMS.find((p) => p === rawPlatform);

  const data = await api.subjects({
    page,
    limit: 50,
    ...(q ? { q } : {}),
    ...(platform ? { platform } : {}),
    sort,
  });

  /** Preserve the other filters when one of them changes. */
  const href = (next: { sort?: string; platform?: string | undefined }) => {
    const params = new URLSearchParams();
    params.set("sort", next.sort ?? sort);
    const nextPlatform = "platform" in next ? next.platform : platform;
    if (nextPlatform) params.set("platform", nextPlatform);
    if (q) params.set("q", q);
    return `/subjects?${params.toString()}`;
  };

  return (
    <div className="animate-fade-up">
      <PageHeader
        breadcrumbs={[{ label: "Archive", href: "/" }, { label: "Subjects" }]}
        title="Subjects"
        description={`${formatNumber(data.total)} account${data.total === 1 ? "" : "s"} with at least one published record.`}
      />

      {/* Platform first: it partitions the list, where sort only reorders it. */}
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        <Pill href={href({ platform: undefined })} active={!platform}>
          All platforms
          <Count n={Object.values(data.platforms).reduce((a, b) => a + b, 0)} />
        </Pill>
        {SUBJECT_PLATFORMS.map((candidate) => (
          <Pill
            key={candidate}
            href={href({ platform: candidate })}
            active={platform === candidate}
          >
            {PLATFORM_LABELS[candidate]}
            <Count n={data.platforms[candidate] ?? 0} />
          </Pill>
        ))}
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-1.5">
        {SORTS.map((option) => (
          <Link
            key={option.key}
            href={href({ sort: option.key })}
            className={cx(
              "rounded-md border px-2.5 py-1 text-xs transition-colors",
              sort === option.key
                ? "border-accent bg-accent/10 font-medium text-accent"
                : "border-line bg-surface text-muted hover:border-line-strong hover:text-fg",
            )}
          >
            {option.label}
          </Link>
        ))}
      </div>

      <div className="card overflow-hidden">
        {data.subjects.length ? (
          <ul className="divide-y divide-line">
            {data.subjects.map((subject) => (
              <li key={subject.id}>
                <Link
                  href={subject.archiveUrl}
                  className="group flex items-center gap-3 px-4 py-3 transition-colors hover:bg-raised/60 sm:px-5"
                >
                  {subject.avatarUrl ? (
                    /* eslint-disable-next-line @next/next/no-img-element */
                    <img
                      src={subject.avatarUrl}
                      alt=""
                      width={32}
                      height={32}
                      loading="lazy"
                      className="h-8 w-8 shrink-0 rounded-full border border-line bg-raised"
                    />
                  ) : (
                    <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full border border-line bg-raised text-2xs font-semibold text-faint">
                      {(subject.username ?? subject.externalId).slice(0, 1).toUpperCase()}
                    </span>
                  )}

                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm link-block font-medium text-fg">
                      {subject.displayName ??
                        subject.username ??
                        `${PLATFORM_LABELS[subject.platform]} ${subject.externalId}`}
                    </p>
                    <p className="truncate text-2xs text-faint">
                      {subject.username ? `@${subject.username} · ` : ""}
                      {PLATFORM_LABELS[subject.platform]} ·{" "}
                      <span className="font-mono">{subject.externalId}</span>
                    </p>
                  </div>

                  <div className="shrink-0 text-right">
                    <p className="text-sm font-medium tabular-nums">
                      {formatNumber(subject.logCount)}
                    </p>
                    <p className="text-2xs text-faint">
                      {subject.lastLogAt ? formatDate(subject.lastLogAt) : "-"}
                    </p>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-5 py-16 text-center text-sm text-muted">
            No subjects are archived yet.
          </p>
        )}

        <Pagination
          page={data.page}
          limit={data.limit}
          total={data.total}
          basePath="/subjects"
          params={{ q, platform, sort: sort === "recent" ? undefined : sort }}
        />
      </div>
    </div>
  );
}

function Pill({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className={cx(
        "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs transition-colors",
        active
          ? "border-accent bg-accent/10 font-medium text-accent"
          : "border-line bg-surface text-muted hover:border-line-strong hover:text-fg",
      )}
    >
      {children}
    </Link>
  );
}

function Count({ n }: { n: number }) {
  return <span className="tabular-nums text-faint">{formatNumber(n)}</span>;
}
