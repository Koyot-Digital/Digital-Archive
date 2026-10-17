import Link from "next/link";
import { RELATION_LABELS, type SubjectRelation } from "@archive/shared";
import type { RelatedAccount } from "@/lib/api";
import { formatNumber } from "@/lib/format";
import { IconAccounts, IconInfo, IconMovedFrom, IconMovedTo, IconRelated } from "./icons";

/**
 * Accounts grouped with this one.
 *
 * This is the panel that keeps the archive honest about alts. One sanction
 * announced against four accounts is filed as one record, under the first
 * account named — which means the other three have pages showing zero
 * records. Without this panel those pages would read as "nothing archived"
 * when the truth is "the record is filed next door", and that is precisely
 * the misreading an archive must not invite.
 *
 * The relation used to be spelled out twice per group — a heading and a
 * sentence of explanation. Now the glyph carries it: an arrow out for an
 * account that moved on, an arrow in for the one it came from, two figures
 * for alts, a broken link for an unstated association. Each row's tooltip and
 * accessible name still say it in words, because an arrow is a reminder of a
 * meaning rather than a substitute for learning it.
 */

/** Relations in the order a reader wants them, not alphabetical. */
const ORDER: SubjectRelation[] = ["successor", "predecessor", "alt", "related"];

const RELATION_ICON: Record<SubjectRelation, (p: { className?: string }) => React.ReactNode> = {
  alt: IconAccounts,
  successor: IconMovedTo,
  predecessor: IconMovedFrom,
  related: IconRelated,
};

export function RelatedAccounts({
  accounts,
  heading = "Grouped accounts",
}: {
  accounts: RelatedAccount[] | undefined;
  heading?: string;
}) {
  if (!accounts?.length) return null;

  const grouped = ORDER.map((relation) => ({
    relation,
    items: accounts.filter((account) => account.relation === relation),
  })).filter((group) => group.items.length > 0);

  return (
    <section className="card p-4 sm:p-5">
      <h2 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-faint">
        <IconAccounts className="icon" />
        {heading}
      </h2>

      <div className="mt-3 space-y-2">
        {grouped.map(({ relation, items }) => {
          const Icon = RELATION_ICON[relation];
          return (
            <div key={relation} className="flex flex-wrap items-center gap-2">
              <span
                className="flex items-center gap-1.5 text-2xs uppercase tracking-wide text-muted"
                title={RELATION_LABELS[relation]}
              >
                <Icon className="icon" />
                {RELATION_LABELS[relation]}
              </span>

              <ul className="flex flex-wrap gap-1.5">
                {items.map((account) => (
                  <li key={account.robloxId}>
                    <Link
                      href={account.archiveUrl}
                      className="group flex items-baseline gap-2 rounded-md border border-line bg-surface px-2.5 py-1 transition-colors hover:border-line-strong"
                      title={`${account.username ?? "Unnamed account"} (${account.robloxId}) — ${
                        account.logCount
                          ? `${formatNumber(account.logCount)} record${account.logCount === 1 ? "" : "s"} of its own`
                          : "no records of its own"
                      }`}
                    >
                      <span className="link-block text-sm font-medium text-fg">
                        {account.username ?? `Roblox ${account.robloxId}`}
                      </span>
                      <span className="font-mono text-2xs text-faint">{account.robloxId}</span>
                      {/* A bare count, because the tooltip spells it out and a
                          zero here is the whole point of the panel. */}
                      <span className="text-2xs tabular-nums text-muted">
                        {formatNumber(account.logCount)}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>

      <p className="mt-3 flex gap-1.5 text-2xs leading-5 text-faint">
        <IconInfo className="icon-sm mt-[0.1rem]" />
        <span>
          Claims made by moderators in the source thread titles, not verified identities. The
          number is each account&apos;s own records — a zero may still be covered by a record filed
          here.{" "}
          {accounts.some((a) => a.assertedBy) ? (
            <>
              Asserted by{" "}
              {accounts
                .filter((a) => a.assertedBy)
                .slice(0, 3)
                .map((account, index) => (
                  <span key={account.robloxId}>
                    {index > 0 ? ", " : ""}
                    {/* Flat id route: the asserting record is filed under the
                        primary account, which is not necessarily this page. */}
                    <Link href={`/modlogs/${account.assertedBy}`} className="link font-mono">
                      {account.assertedBy}
                    </Link>
                  </span>
                ))}
              .
            </>
          ) : null}
        </span>
      </p>
    </section>
  );
}
