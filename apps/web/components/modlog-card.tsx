import Link from "next/link";
import type { Modlog } from "@/lib/api";
import { formatDate, formatNumber } from "@/lib/format";
import { ActionBadge, Meta, SeverityBadge, StatusBadge, Tag } from "./badges";
import { IconImage, IconRevision, IconThread, IconTicket } from "./icons";

/**
 * One row in a list of modlogs.
 *
 * Laid out as a dense table-like row rather than a card grid: moderators scan
 * these by the hundred, and a grid would halve how many fit on screen.
 */
export function ModlogCard({ modlog, showSubject = false }: { modlog: Modlog; showSubject?: boolean }) {
  const date = modlog.occurredAt ?? modlog.createdAt;

  return (
    <article className="group relative border-b border-line last:border-0">
      <Link
        href={modlog.url}
        className="flex gap-4 px-4 py-4 transition-colors hover:bg-raised/60 sm:px-5"
      >
        {modlog.thumbnail ? (
          <div className="relative hidden h-16 w-24 shrink-0 overflow-hidden rounded-md border border-line bg-raised sm:block">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={modlog.thumbnail.thumbUrl}
              alt=""
              loading="lazy"
              decoding="async"
              width={96}
              height={64}
              className="h-full w-full object-cover"
              style={
                modlog.thumbnail.blurDataUrl
                  ? {
                      backgroundImage: `url(${modlog.thumbnail.blurDataUrl})`,
                      backgroundSize: "cover",
                    }
                  : undefined
              }
            />
          </div>
        ) : null}

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <SeverityBadge severity={modlog.severity} size="sm" />
            <ActionBadge action={modlog.action} />
            <StatusBadge status={modlog.status} />
            {modlog.imageCount > 0 ? (
              <Meta
                icon={IconImage}
                label={`${formatNumber(modlog.imageCount)} image${modlog.imageCount === 1 ? "" : "s"}`}
              >
                {formatNumber(modlog.imageCount)}
              </Meta>
            ) : null}
            {/* A contested record is worth spotting from the list: a long
                thread usually means an appeal or a disagreement. */}
            {modlog.threadReplyCount > 0 ? (
              <Meta
                icon={IconThread}
                label={`${formatNumber(modlog.threadReplyCount)} ${
                  modlog.threadReplyCount === 1 ? "reply" : "replies"
                } on the source thread`}
              >
                {formatNumber(modlog.threadReplyCount)}
              </Meta>
            ) : null}
            {modlog.ticketRef ? (
              <Meta icon={IconTicket} label={`Ticket ${modlog.ticketRef}`}>
                <span className="font-mono">{modlog.ticketRef.replace(/^#/, "")}</span>
              </Meta>
            ) : null}
          </div>

          <h3 className="link-block mt-2 truncate text-[0.9375rem] font-medium text-fg">
            {modlog.title}
          </h3>

          {showSubject ? (
            <p className="mt-0.5 text-xs text-faint">
              Subject <span className="font-mono">{modlog.robloxId}</span>
            </p>
          ) : null}

          {modlog.excerpt ? (
            <p className="mt-1 line-clamp-2 text-sm leading-6 text-muted">{modlog.excerpt}</p>
          ) : null}

          {/* Provenance. No bullet separators: the icons already divide it. */}
          <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-2xs text-faint">
            <time dateTime={date} className="tabular-nums">
              {formatDate(date)}
            </time>
            <span>{modlog.source}</span>
            {modlog.revision > 1 ? (
              <Meta icon={IconRevision} label={`Revision ${modlog.revision}`}>
                {modlog.revision}
              </Meta>
            ) : null}
            <span className="font-mono">{modlog.id}</span>
          </div>

          {modlog.tags.length ? (
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {modlog.tags.slice(0, 6).map((tag) => (
                <Tag key={tag} label={tag} />
              ))}
              {modlog.tags.length > 6 ? (
                <span className="text-2xs text-faint">+{modlog.tags.length - 6}</span>
              ) : null}
            </div>
          ) : null}
        </div>
      </Link>
    </article>
  );
}

export function ModlogList({
  modlogs,
  showSubject = false,
  empty = "No records found.",
}: {
  modlogs: Modlog[];
  showSubject?: boolean;
  empty?: string;
}) {
  if (!modlogs.length) {
    return (
      <div className="px-5 py-16 text-center">
        <p className="text-sm text-muted">{empty}</p>
      </div>
    );
  }
  return (
    <div className="divide-y divide-line">
      {modlogs.map((modlog) => (
        <ModlogCard key={modlog.id} modlog={modlog} showSubject={showSubject} />
      ))}
    </div>
  );
}
