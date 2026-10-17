import type { Metadata } from "next";
import { api } from "@/lib/api";
import { formatNumber } from "@/lib/format";
import { PageHeader } from "@/components/chrome";
import { ModlogList } from "@/components/modlog-card";
import { Pagination } from "@/components/pagination";
import { SearchBox } from "@/components/search-box";

export const metadata: Metadata = {
  title: "Search",
  robots: { index: false, follow: true },
};

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function SearchPage({ searchParams }: Props) {
  const search = await searchParams;
  const q = (one(search.q) ?? "").trim();
  const page = Math.max(1, Number.parseInt(one(search.page) ?? "1", 10) || 1);

  // Postgres full-text needs something to work with; one character is noise.
  const tooShort = q.length > 0 && q.length < 2;
  const results = q.length >= 2 ? await api.search({ q, page, limit: 25 }).catch(() => null) : null;

  return (
    <div className="animate-fade-up">
      <PageHeader
        breadcrumbs={[{ label: "Archive", href: "/" }, { label: "Search" }]}
        title={q ? `Results for “${q}”` : "Search the archive"}
        description={
          results
            ? `${formatNumber(results.total)} record${results.total === 1 ? "" : "s"} matched.`
            : "Search record titles, bodies, reasons, tags, usernames and Roblox IDs."
        }
      />

      <div className="mb-6 max-w-xl">
        <SearchBox defaultValue={q} />
        <p className="mt-2 text-xs text-faint">
          Quote a phrase for an exact match (<code className="font-mono">&quot;filter bypass&quot;</code>),
          or prefix a word with <code className="font-mono">-</code> to exclude it.
        </p>
      </div>

      {tooShort ? (
        <p className="text-sm text-muted">Enter at least two characters.</p>
      ) : !q ? null : (
        <div className="card overflow-hidden">
          <ModlogList
            modlogs={results?.modlogs ?? []}
            showSubject
            empty={
              results
                ? `Nothing in the archive matches “${q}”.`
                : "Search is temporarily unavailable."
            }
          />
          {results ? (
            <Pagination
              page={results.page}
              limit={results.limit}
              total={results.total}
              basePath="/search"
              params={{ q }}
            />
          ) : null}
        </div>
      )}
    </div>
  );
}
