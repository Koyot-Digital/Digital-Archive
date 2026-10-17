import type { Metadata } from "next";
import { SITE_NAME, api } from "@/lib/api";
import { formatDate, formatNumber } from "@/lib/format";
import { PageHeader } from "@/components/chrome";
import { DiscordAvatar, StalenessMark } from "@/components/discord-identity";
import { IconClock, IconUnverified } from "@/components/icons";

/**
 * archive.domain.com/moderators
 *
 * Who files records here, derived from the records rather than configured.
 * A staff list kept by hand drifts; this one cannot, because it *is* a
 * count of the archive's contents.
 *
 * Worth having its own page for a reason beyond completeness: a reader
 * judging whether to trust a sanction wants to know whether it came from
 * someone who has filed four hundred of them or their first.
 */

export const metadata: Metadata = {
  title: "Moderators",
  description: `Discord accounts that have filed moderation records in ${SITE_NAME}.`,
  alternates: { canonical: "/moderators" },
};

export default async function ModeratorsPage() {
  const { moderators, identityRefresh } = await api.moderators({ limit: 200 });
  const total = moderators.reduce((sum, m) => sum + m.recordCount, 0);

  return (
    <div className="animate-fade-up">
      <PageHeader
        breadcrumbs={[{ label: "Archive", href: "/" }, { label: "Moderators" }]}
        title="Moderators"
        description={
          <>
            {formatNumber(moderators.length)} Discord account
            {moderators.length === 1 ? "" : "s"} filed {formatNumber(total)} archived record
            {total === 1 ? "" : "s"} between them. Counted from the records themselves, not kept as
            a configured list.
          </>
        }
      />

      {/*
       * Said once here, in full, for the whole set — which is what lets every
       * individual name carry only the small dashed-shield glyph instead of
       * repeating "as scraped" sixteen times down the page.
       */}
      {!identityRefresh ? (
        <p className="card mb-4 flex gap-2.5 p-4 text-sm leading-6 text-muted">
          <IconUnverified className="icon mt-0.5 shrink-0 text-faint" />
          <span>
            <strong className="font-semibold text-fg">Identities are as scraped.</strong>{" "}
            <code className="rounded border border-line bg-raised px-1 py-0.5 font-mono text-xs">
              DISCORD_BOT_TOKEN
            </code>{" "}
            is not configured, so names and avatars are the ones captured when each thread was
            scraped and are not being refreshed from Discord.
          </span>
        </p>
      ) : null}

      {moderators.length ? (
        <ul className="card divide-y divide-line">
          {moderators.map((moderator) => (
            <li key={moderator.id} className="flex items-center gap-3 p-4">
              <DiscordAvatar user={moderator} size="lg" />

              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-x-2">
                  <span className="truncate font-medium text-fg">
                    {moderator.displayName ?? moderator.username ?? `Discord ${moderator.id}`}
                  </span>
                  {moderator.username && moderator.username !== moderator.displayName ? (
                    <span className="truncate text-xs text-faint">@{moderator.username}</span>
                  ) : null}
                  <StalenessMark user={moderator} />
                </p>
                <p className="mt-0.5 flex flex-wrap items-center gap-x-2.5 text-xs text-muted">
                  <span className="font-mono text-faint">{moderator.id}</span>
                  {moderator.lastRecordAt ? (
                    <span
                      className="meta"
                      title={`Most recent record ${formatDate(moderator.lastRecordAt)}`}
                    >
                      <IconClock className="icon-sm" />
                      <span aria-hidden>{formatDate(moderator.lastRecordAt)}</span>
                      <span className="sr-only">
                        most recent record {formatDate(moderator.lastRecordAt)}
                      </span>
                    </span>
                  ) : null}
                </p>
              </div>

              {/* The count is the column — the word "records" is the header's
                  job, and repeating it on every row said nothing new. */}
              <p
                className="shrink-0 text-lg font-semibold tabular-nums"
                title={`${formatNumber(moderator.recordCount)} record${
                  moderator.recordCount === 1 ? "" : "s"
                } filed`}
              >
                <span aria-hidden>{formatNumber(moderator.recordCount)}</span>
                <span className="sr-only">
                  {formatNumber(moderator.recordCount)} record
                  {moderator.recordCount === 1 ? "" : "s"} filed
                </span>
              </p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="card p-8 text-center text-sm text-muted">
          No records carry a Discord author yet. Import a forum scrape through{" "}
          <code className="rounded border border-line bg-raised px-1 py-0.5 font-mono text-xs">
            POST /ingress/discord-forum
          </code>
          .
        </p>
      )}
    </div>
  );
}
