import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { api, loginUrl } from "@/lib/api";
import { cx, formatDateTime, formatNumber, formatRelative } from "@/lib/format";
import { PageHeader } from "@/components/chrome";
import { Pagination } from "@/components/pagination";

export const metadata: Metadata = {
  title: "Moderation log",
  robots: { index: false, follow: false },
};

/** Role-dependent and private: never cache, never prerender. */
export const dynamic = "force-dynamic";

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Actions get a colour family so the log is scannable by kind. */
const ACTION_TONE: Record<string, string> = {
  "modlog.create": "text-sev-low",
  "modlog.update": "text-sev-medium",
  "modlog.status_change": "text-sev-medium",
  "modlog.delete": "text-sev-critical",
  "modlog.restore": "text-sev-low",
  "image.upload": "text-sev-low",
  "image.delete": "text-sev-critical",
  "user.login": "text-faint",
  "user.logout": "text-faint",
  "user.role_change": "text-sev-high",
  "apikey.create": "text-sev-high",
  "apikey.revoke": "text-sev-critical",
  "ingress.batch": "text-muted",
};

export default async function ModerationPage({ searchParams }: Props) {
  const viewer = await api.viewer().catch(() => null);
  const role = viewer?.user?.role;

  if (!viewer?.authenticated) {
    if (viewer?.authEnabled) redirect(loginUrl("/moderation"));
    redirect("/");
  }
  if (role !== "moderator" && role !== "admin") {
    return (
      <div className="mx-auto max-w-prose py-16 text-center">
        <h1 className="text-xl font-semibold">Moderators only</h1>
        <p className="mt-2 text-sm text-muted">
          Your account is signed in but does not hold the moderator role.
        </p>
        <Link href="/" className="btn btn-outline mt-6">
          Back to the archive
        </Link>
      </div>
    );
  }

  const search = await searchParams;
  const page = Math.max(1, Number.parseInt(one(search.page) ?? "1", 10) || 1);
  const actionFilter = one(search.action);

  const [audit, queue] = await Promise.all([
    api.audit({ page, limit: 50, ...(actionFilter ? { action: actionFilter } : {}) }).catch(() => null),
    api.queue().catch(() => null),
  ]);

  return (
    <div className="animate-fade-up">
      <PageHeader
        breadcrumbs={[{ label: "Archive", href: "/" }, { label: "Moderation" }]}
        title="Moderation log"
        description="Every write to the archive, append-only. Entries cannot be edited or removed, including by administrators."
      />

      {queue?.items.length ? (
        <section className="mb-8">
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-faint">
            Needs review ({queue.items.length})
          </h2>
          <div className="card divide-y divide-line overflow-hidden">
            {queue.items.map((item) => (
              <Link
                key={item.id}
                href={item.url}
                className="flex items-center gap-3 px-4 py-2.5 text-sm transition-colors hover:bg-raised/60"
              >
                <span
                  className={cx(
                    "shrink-0 rounded px-1.5 py-0.5 text-2xs font-semibold uppercase",
                    item.status === "hidden"
                      ? "bg-sev-medium/15 text-sev-medium"
                      : "bg-sev-critical/15 text-sev-critical",
                  )}
                >
                  {item.status}
                </span>
                <span className="min-w-0 flex-1 truncate text-fg">{item.title}</span>
                <span className="shrink-0 text-2xs text-faint">
                  {formatRelative(item.updatedAt)}
                </span>
              </Link>
            ))}
          </div>
        </section>
      ) : null}

      <section>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-faint">
            Audit trail
          </h2>
          {actionFilter ? (
            <Link href="/moderation" className="link text-xs">
              Clear filter ({actionFilter})
            </Link>
          ) : null}
        </div>

        <div className="card overflow-hidden">
          {audit?.entries.length ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line bg-raised text-2xs uppercase tracking-wide text-faint">
                    <th className="px-4 py-2 text-left font-medium">When</th>
                    <th className="px-4 py-2 text-left font-medium">Action</th>
                    <th className="px-4 py-2 text-left font-medium">Actor</th>
                    <th className="px-4 py-2 text-left font-medium">Target</th>
                    <th className="px-4 py-2 text-left font-medium">Detail</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {audit.entries.map((entry) => (
                    <tr key={entry.id} className="align-top hover:bg-raised/40">
                      <td className="whitespace-nowrap px-4 py-2.5 text-2xs tabular-nums text-faint">
                        {formatDateTime(entry.createdAt)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5">
                        <Link
                          href={`/moderation?action=${entry.action}`}
                          className={cx(
                            "font-mono text-xs hover:underline",
                            ACTION_TONE[entry.action] ?? "text-muted",
                          )}
                        >
                          {entry.action}
                        </Link>
                      </td>
                      <td className="px-4 py-2.5 text-xs">
                        <span className="text-fg">{entry.actorLabel ?? "-"}</span>
                        <span className="ml-1.5 text-2xs text-faint">{entry.actorType}</span>
                      </td>
                      <td className="px-4 py-2.5 font-mono text-2xs text-muted">
                        {entry.targetId ? (
                          entry.targetType === "modlog" ? (
                            <Link
                              href={`/modlogs/${entry.targetId}`}
                              className="link"
                            >
                              {entry.targetId}
                            </Link>
                          ) : (
                            entry.targetId
                          )
                        ) : (
                          "-"
                        )}
                      </td>
                      <td className="max-w-md px-4 py-2.5">
                        <MetadataCell metadata={entry.metadata} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="px-5 py-16 text-center text-sm text-muted">
              {audit ? "No audit entries yet." : "Could not load the audit trail."}
            </p>
          )}

          {audit ? (
            <Pagination
              page={audit.page}
              limit={audit.limit}
              total={audit.total}
              basePath="/moderation"
              params={{ action: actionFilter }}
            />
          ) : null}
        </div>

        {audit ? (
          <p className="mt-3 text-2xs text-faint">
            {formatNumber(audit.total)} entries recorded.
          </p>
        ) : null}
      </section>
    </div>
  );
}

/** Compact key=value rendering; long values are truncated, not hidden. */
function MetadataCell({ metadata }: { metadata: Record<string, unknown> }) {
  const entries = Object.entries(metadata).filter(([, value]) => value !== null && value !== "");
  if (!entries.length) return <span className="text-2xs text-faint">-</span>;

  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1">
      {entries.slice(0, 6).map(([key, value]) => {
        const text = typeof value === "object" ? JSON.stringify(value) : String(value);
        return (
          <span key={key} className="text-2xs">
            <span className="text-faint">{key}=</span>
            <span className="font-mono text-muted" title={text}>
              {text.length > 36 ? `${text.slice(0, 35)}…` : text}
            </span>
          </span>
        );
      })}
      {entries.length > 6 ? (
        <span className="text-2xs text-faint">+{entries.length - 6} more</span>
      ) : null}
    </div>
  );
}
