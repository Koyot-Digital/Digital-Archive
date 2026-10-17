import Link from "next/link";
import { RELATION_LABELS, type SubjectRelation } from "@archive/shared";
import type { RelatedAccount } from "@/lib/api";
import { formatNumber } from "@/lib/format";

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
 * Every link says which record asserted it, so the claim can be checked
 * rather than taken on faith.
 */

/** Relations in the order a reader wants them, not alphabetical. */
const ORDER: SubjectRelation[] = ["successor", "predecessor", "alt", "related"];

const EXPLANATION: Record<SubjectRelation, string> = {
  alt: "Named as an alternate account of this one.",
  successor: "This account was reported as having moved to the following.",
  predecessor: "Reported as the earlier account behind this one.",
  related: "Named alongside this account without the relationship being stated.",
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
      <h2 className="text-xs font-semibold uppercase tracking-wider text-faint">{heading}</h2>

      <div className="mt-3 space-y-4">
        {grouped.map(({ relation, items }) => (
          <div key={relation}>
            <p className="text-2xs uppercase tracking-wide text-muted">
              {RELATION_LABELS[relation]}
            </p>
            <p className="mt-0.5 text-xs text-faint">{EXPLANATION[relation]}</p>

            <ul className="mt-2 flex flex-wrap gap-2">
              {items.map((account) => (
                <li key={account.robloxId}>
                  <Link
                    href={account.archiveUrl}
                    className="flex items-baseline gap-2 rounded-md border border-line bg-surface px-2.5 py-1.5 transition-colors hover:border-line-strong"
                  >
                    <span className="text-sm font-medium text-fg">
                      {account.username ?? `Roblox ${account.robloxId}`}
                    </span>
                    <span className="font-mono text-2xs text-faint">{account.robloxId}</span>
                    <span className="text-2xs text-muted">
                      {account.logCount
                        ? `${formatNumber(account.logCount)} record${account.logCount === 1 ? "" : "s"}`
                        : "no records of its own"}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <p className="mt-4 text-2xs leading-5 text-faint">
        Groupings come from the titles of the source threads and are claims made by moderators, not
        verified identities. A grouped account with no records of its own may still be covered by a
        record filed under another account here.{" "}
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
                  <Link
                    href={`/modlogs/${account.assertedBy}`}
                    className="font-mono text-accent hover:underline"
                  >
                    {account.assertedBy}
                  </Link>
                </span>
              ))}
            .
          </>
        ) : null}
      </p>
    </section>
  );
}
