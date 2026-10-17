import Link from "next/link";
import { cx, formatNumber } from "@/lib/format";

/**
 * Server-rendered pagination.
 *
 * Page state lives in the URL rather than in component state, so a moderator
 * can bookmark or share "page 4 of this subject's critical records".
 */
export function Pagination({
  page,
  limit,
  total,
  basePath,
  params = {},
}: {
  page: number;
  limit: number;
  total: number;
  basePath: string;
  params?: Record<string, string | undefined>;
}) {
  const pages = Math.max(1, Math.ceil(total / limit));
  if (pages <= 1) return null;

  const href = (target: number) => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value) search.set(key, value);
    }
    if (target > 1) search.set("page", String(target));
    const qs = search.toString();
    return qs ? `${basePath}?${qs}` : basePath;
  };

  const from = (page - 1) * limit + 1;
  const to = Math.min(page * limit, total);

  // Window of page numbers around the current one, with ellipses.
  const window: (number | "gap")[] = [];
  for (let p = 1; p <= pages; p += 1) {
    if (p === 1 || p === pages || Math.abs(p - page) <= 1) window.push(p);
    else if (window.at(-1) !== "gap") window.push("gap");
  }

  return (
    <nav
      aria-label="Pagination"
      className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-4 py-3 sm:px-5"
    >
      <p className="text-xs text-faint tabular-nums">
        {formatNumber(from)}–{formatNumber(to)} of {formatNumber(total)}
      </p>

      <div className="flex items-center gap-1">
        {page > 1 ? (
          <Link href={href(page - 1)} className="btn btn-outline" rel="prev">
            Previous
          </Link>
        ) : null}

        <div className="hidden items-center gap-1 sm:flex">
          {window.map((entry, i) =>
            entry === "gap" ? (
              <span key={`gap-${i}`} className="px-1 text-xs text-faint">
                …
              </span>
            ) : (
              <Link
                key={entry}
                href={href(entry)}
                aria-current={entry === page ? "page" : undefined}
                className={cx(
                  "grid h-8 min-w-8 place-items-center rounded-md border px-2 text-xs tabular-nums transition-colors",
                  entry === page
                    ? "border-accent bg-accent/10 font-semibold text-accent"
                    : "border-transparent text-muted hover:bg-raised hover:text-fg",
                )}
              >
                {entry}
              </Link>
            ),
          )}
        </div>

        {page < pages ? (
          <Link href={href(page + 1)} className="btn btn-outline" rel="next">
            Next
          </Link>
        ) : null}
      </div>
    </nav>
  );
}
