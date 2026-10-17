import type { Metadata } from "next";
import Link from "next/link";
import { api } from "@/lib/api";
import { cx, formatDate, formatNumber } from "@/lib/format";
import { PageHeader } from "@/components/chrome";
import { Pagination } from "@/components/pagination";

export const metadata: Metadata = {
  title: "Subjects",
  description: "Every Roblox account the archive holds moderation records for.",
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

  const data = await api.subjects({ page, limit: 50, ...(q ? { q } : {}), sort });

  return (
    <div className="animate-fade-up">
      <PageHeader
        breadcrumbs={[{ label: "Archive", href: "/" }, { label: "Subjects" }]}
        title="Subjects"
        description={`${formatNumber(data.total)} account${data.total === 1 ? "" : "s"} with at least one published record.`}
      />

      <div className="mb-4 flex flex-wrap items-center gap-1.5">
        {SORTS.map((option) => (
          <Link
            key={option.key}
            href={`/subjects?sort=${option.key}${q ? `&q=${encodeURIComponent(q)}` : ""}`}
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
              <li key={subject.robloxId}>
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
                      {(subject.username ?? subject.robloxId).slice(0, 1).toUpperCase()}
                    </span>
                  )}

                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-fg group-hover:text-accent">
                      {subject.displayName ?? subject.username ?? `Roblox user ${subject.robloxId}`}
                    </p>
                    <p className="truncate text-2xs text-faint">
                      {subject.username ? `@${subject.username} · ` : ""}
                      <span className="font-mono">{subject.robloxId}</span>
                    </p>
                  </div>

                  <div className="shrink-0 text-right">
                    <p className="text-sm font-medium tabular-nums">
                      {formatNumber(subject.logCount)}
                    </p>
                    <p className="text-2xs text-faint">
                      {subject.lastLogAt ? formatDate(subject.lastLogAt) : "—"}
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
          params={{ q, sort: sort === "recent" ? undefined : sort }}
        />
      </div>
    </div>
  );
}
