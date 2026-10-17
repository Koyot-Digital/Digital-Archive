import type { Metadata } from "next";
import Link from "next/link";
import { ACTION_LABELS, MODLOG_ACTIONS, MODLOG_SEVERITIES, SEVERITY_LABELS } from "@archive/shared";
import { api } from "@/lib/api";
import { cx, formatNumber } from "@/lib/format";
import { PageHeader } from "@/components/chrome";
import { ModlogList } from "@/components/modlog-card";
import { Pagination } from "@/components/pagination";

export const metadata: Metadata = {
  title: "All records",
  description: "Every published moderation record in the archive, newest first.",
};

export const revalidate = 30;

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function AllRecordsPage({ searchParams }: Props) {
  const search = await searchParams;
  const page = Math.max(1, Number.parseInt(one(search.page) ?? "1", 10) || 1);
  const action = one(search.action);
  const severity = one(search.severity);

  const data = await api.recent({
    page,
    limit: 30,
    ...(action ? { action } : {}),
    ...(severity ? { severity } : {}),
  });

  const base = (overrides: Record<string, string | undefined>) => {
    const params = new URLSearchParams();
    const merged = { action, severity, ...overrides };
    for (const [key, value] of Object.entries(merged)) {
      if (value) params.set(key, value);
    }
    const qs = params.toString();
    return qs ? `/modlogs?${qs}` : "/modlogs";
  };

  return (
    <div className="animate-fade-up">
      <PageHeader
        breadcrumbs={[{ label: "Archive", href: "/" }, { label: "All records" }]}
        title="All records"
        description={`${formatNumber(data.total)} published record${data.total === 1 ? "" : "s"}.`}
      />

      <div className="mb-4 space-y-2">
        <FilterRow label="Action">
          <Chip href={base({ action: undefined })} active={!action}>
            Any
          </Chip>
          {MODLOG_ACTIONS.map((value) => (
            <Chip key={value} href={base({ action: value })} active={action === value}>
              {ACTION_LABELS[value]}
            </Chip>
          ))}
        </FilterRow>

        <FilterRow label="Severity">
          <Chip href={base({ severity: undefined })} active={!severity}>
            Any
          </Chip>
          {MODLOG_SEVERITIES.map((value) => (
            <Chip key={value} href={base({ severity: value })} active={severity === value}>
              {SEVERITY_LABELS[value]}
            </Chip>
          ))}
        </FilterRow>
      </div>

      <div className="card overflow-hidden">
        <ModlogList
          modlogs={data.modlogs}
          showSubject
          empty={
            action || severity ? "No records match these filters." : "The archive is empty."
          }
        />
        <Pagination
          page={data.page}
          limit={data.limit}
          total={data.total}
          basePath="/modlogs"
          params={{ action, severity }}
        />
      </div>
    </div>
  );
}

function FilterRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="mr-1 w-14 shrink-0 text-2xs uppercase tracking-wide text-faint">
        {label}
      </span>
      {children}
    </div>
  );
}

function Chip({
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
        "rounded-md border px-2.5 py-1 text-xs transition-colors",
        active
          ? "border-accent bg-accent/10 font-medium text-accent"
          : "border-line bg-surface text-muted hover:border-line-strong hover:text-fg",
      )}
    >
      {children}
    </Link>
  );
}
