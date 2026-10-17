import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ROBLOX_ID_PATTERN, ACTION_LABELS, MODLOG_ACTIONS, type ModlogAction } from "@archive/shared";
import { SITE_NAME, api } from "@/lib/api";
import { cx, formatDate, formatNumber } from "@/lib/format";
import { PageHeader, SubjectHeader } from "@/components/chrome";
import { ModlogList } from "@/components/modlog-card";
import { Pagination } from "@/components/pagination";

/**
 * archive.domain.com/roblox-modlogs/[robloxId]
 *
 * Everything the archive holds about one Roblox account, newest first, with
 * filters that stay in the URL so any view is shareable.
 */

interface Props {
  params: Promise<{ robloxId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const LIMIT = 25;

function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { robloxId } = await params;
  if (!ROBLOX_ID_PATTERN.test(robloxId)) return { title: "Not found" };

  const data = await api.subject(robloxId, { limit: 1 }).catch(() => null);
  if (!data) return { title: `Roblox user ${robloxId}` };

  const name = data.subject.displayName ?? data.subject.username ?? `Roblox user ${robloxId}`;
  return {
    title: `${name} — moderation records`,
    description: `${formatNumber(data.total)} archived moderation record(s) for ${name} (Roblox ID ${robloxId}).`,
    alternates: { canonical: `/roblox-modlogs/${robloxId}` },
    openGraph: {
      title: `${name} · ${SITE_NAME}`,
      description: `${formatNumber(data.total)} archived moderation record(s).`,
    },
  };
}

export default async function SubjectPage({ params, searchParams }: Props) {
  const { robloxId } = await params;
  // Reject anything that is not a plausible Roblox id before touching the API.
  if (!ROBLOX_ID_PATTERN.test(robloxId)) notFound();

  const search = await searchParams;
  const page = Math.max(1, Number.parseInt(one(search.page) ?? "1", 10) || 1);
  const action = one(search.action);
  const severity = one(search.severity);
  const tag = one(search.tag);
  const sort = one(search.sort) ?? "newest";

  const data = await api.subject(robloxId, {
    page,
    limit: LIMIT,
    ...(action ? { action } : {}),
    ...(severity ? { severity } : {}),
    ...(tag ? { tag } : {}),
    sort,
  });

  const { subject } = data;
  const name = subject.displayName ?? subject.username ?? `Roblox user ${robloxId}`;
  const filtered = Boolean(action || severity || tag);

  return (
    <div className="animate-fade-up">
      <PageHeader
        breadcrumbs={[
          { label: "Archive", href: "/" },
          { label: "Subjects", href: "/subjects" },
          { label: robloxId },
        ]}
        title={name}
        description={
          <>
            {formatNumber(data.total)} record{data.total === 1 ? "" : "s"}
            {subject.firstLogAt ? (
              <>
                {" "}
                spanning {formatDate(subject.firstLogAt)} – {formatDate(subject.lastLogAt)}
              </>
            ) : null}
            {filtered ? " (filtered)" : null}
          </>
        }
      />

      <div className="mb-6">
        <SubjectHeader subject={subject} />
      </div>

      {/* Filters are plain links so the whole page works without JavaScript. */}
      <div className="mb-4 flex flex-wrap items-center gap-1.5">
        <FilterLink robloxId={robloxId} active={!action} label="All actions" />
        {MODLOG_ACTIONS.map((candidate) => (
          <FilterLink
            key={candidate}
            robloxId={robloxId}
            action={candidate}
            active={action === candidate}
            label={ACTION_LABELS[candidate]}
          />
        ))}
      </div>

      <div className="card overflow-hidden">
        <ModlogList
          modlogs={data.modlogs}
          empty={
            filtered
              ? "No records match these filters."
              : "No records are archived for this account."
          }
        />
        <Pagination
          page={data.page}
          limit={data.limit}
          total={data.total}
          basePath={`/roblox-modlogs/${robloxId}`}
          params={{ action, severity, tag, sort: sort === "newest" ? undefined : sort }}
        />
      </div>

      <p className="mt-4 text-xs text-faint">
        Something inaccurate?{" "}
        <Link href="/about#corrections" className="text-accent hover:underline">
          How corrections work
        </Link>
        .
      </p>
    </div>
  );
}

function FilterLink({
  robloxId,
  action,
  active,
  label,
}: {
  robloxId: string;
  action?: ModlogAction;
  active: boolean;
  label: string;
}) {
  return (
    <Link
      href={action ? `/roblox-modlogs/${robloxId}?action=${action}` : `/roblox-modlogs/${robloxId}`}
      className={cx(
        "rounded-md border px-2.5 py-1 text-xs transition-colors",
        active
          ? "border-accent bg-accent/10 font-medium text-accent"
          : "border-line bg-surface text-muted hover:border-line-strong hover:text-fg",
      )}
    >
      {label}
    </Link>
  );
}
