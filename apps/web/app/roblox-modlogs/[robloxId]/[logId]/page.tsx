import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ID_PATTERN, ROBLOX_ID_PATTERN, normalizeId } from "@archive/shared";
import { SITE_NAME, api } from "@/lib/api";
import { formatBytes, formatDateTime, formatNumber } from "@/lib/format";
import { ActionBadge, SeverityBadge, StatusBadge, Tag } from "@/components/badges";
import { PageHeader } from "@/components/chrome";
import { ImageGrid } from "@/components/image-grid";
import { LinkEmbedList } from "@/components/link-embed";
import { RelatedAccounts } from "@/components/related-accounts";
import { RevisionHistory } from "@/components/revision-history";
import { ThreadPanel } from "@/components/thread";
import { DiscordChip } from "@/components/discord-identity";
import {
  IconAccounts,
  IconArchiveClock,
  IconAuthor,
  IconChannel,
  IconClock,
  IconExternal,
  IconImage,
  IconRevision,
  IconTicket,
} from "@/components/icons";

/**
 * archive.domain.com/roblox-modlogs/[robloxId]/[16-char id]
 *
 * One record. The body HTML arrives pre-rendered and pre-sanitised from the
 * API, so this page does no markdown work and no third-party fetching.
 */

interface Props {
  params: Promise<{ robloxId: string; logId: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { robloxId, logId } = await params;
  if (!ROBLOX_ID_PATTERN.test(robloxId) || !ID_PATTERN.test(normalizeId(logId))) {
    return { title: "Not found" };
  }

  const data = await api.modlog(robloxId, normalizeId(logId)).catch(() => null);
  if (!data) return { title: "Record not found" };

  const { modlog } = data;
  const name = modlog.subject?.displayName ?? modlog.subject?.username ?? `Roblox ${robloxId}`;
  return {
    title: modlog.title,
    description: modlog.excerpt || `Archived moderation record for ${name}.`,
    alternates: { canonical: `/roblox-modlogs/${robloxId}/${modlog.id}` },
    openGraph: {
      title: `${modlog.title} · ${SITE_NAME}`,
      description: modlog.excerpt || undefined,
      type: "article",
      publishedTime: modlog.occurredAt ?? modlog.createdAt,
    },
    // A removed record keeps its URL but should leave the index.
    robots: modlog.status === "published" ? undefined : { index: false, follow: false },
  };
}

export default async function ModlogPage({ params }: Props) {
  const { robloxId, logId: rawLogId } = await params;
  const logId = normalizeId(rawLogId);
  if (!ROBLOX_ID_PATTERN.test(robloxId) || !ID_PATTERN.test(logId)) notFound();

  const { modlog } = await api.modlog(robloxId, logId);
  const subjectName =
    modlog.subject?.displayName ?? modlog.subject?.username ?? `Roblox user ${robloxId}`;

  const withheld = modlog.status === "removed" && !modlog.body?.html;

  return (
    <article className="animate-fade-up">
      <PageHeader
        breadcrumbs={[
          { label: "Archive", href: "/" },
          { label: subjectName, href: `/roblox-modlogs/${robloxId}` },
          { label: modlog.id },
        ]}
        title={modlog.title}
        description={
          <div className="flex flex-wrap items-center gap-2">
            <SeverityBadge severity={modlog.severity} />
            <ActionBadge action={modlog.action} />
            <StatusBadge status={modlog.status} />
          </div>
        }
        actions={
          <Link href={`/roblox-modlogs/${robloxId}`} className="btn btn-outline">
            All records for this account
          </Link>
        }
      />

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_17rem]">
        <div className="min-w-0">
          {withheld ? (
            <div className="card border-sev-critical/30 bg-sev-critical/5 p-5">
              <h2 className="text-sm font-semibold text-sev-critical">Record withheld</h2>
              <p className="mt-1.5 text-sm leading-6 text-muted">
                This record was removed by a moderator. Its identifier and history are retained so
                existing links do not break and so the removal itself is auditable, but its
                contents are no longer served.
              </p>
            </div>
          ) : (
            <>
              {modlog.reason ? (
                <div className="card mb-6 p-4">
                  <h2 className="text-2xs font-semibold uppercase tracking-wider text-faint">
                    Stated reason
                  </h2>
                  <p className="mt-1.5 text-sm leading-6 text-fg">{modlog.reason}</p>
                </div>
              ) : null}

              {modlog.body?.html ? (
                <div
                  className="prose-archive"
                  // Sanitised server-side by the API (markdown-it + sanitize-html)
                  // before it was ever stored; see services/render.ts.
                  dangerouslySetInnerHTML={{ __html: modlog.body.html }}
                />
              ) : (
                <p className="text-sm italic text-faint">This record has no written body.</p>
              )}

              <ImageGrid images={modlog.images ?? []} />
              <LinkEmbedList links={modlog.linkEmbeds ?? []} />

              {modlog.evidence && Object.keys(modlog.evidence).length ? (
                <section className="mt-8">
                  <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-faint">
                    Structured evidence
                  </h2>
                  <dl className="grid gap-px overflow-hidden rounded-card border border-line bg-line text-sm sm:grid-cols-2">
                    {Object.entries(modlog.evidence).map(([key, value]) => (
                      <div key={key} className="bg-surface px-3.5 py-2.5">
                        <dt className="text-2xs uppercase tracking-wide text-faint">{key}</dt>
                        <dd className="mt-0.5 break-words font-mono text-[0.8125rem] text-fg">
                          {typeof value === "object" && value !== null
                            ? JSON.stringify(value)
                            : String(value)}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </section>
              ) : null}

              {modlog.relatedAccounts?.length ? (
                <div className="mt-8">
                  <RelatedAccounts
                    accounts={modlog.relatedAccounts}
                    heading="Accounts named on this record"
                  />
                </div>
              ) : null}

              <ThreadPanel thread={modlog.thread} />
            </>
          )}

          <RevisionHistory logId={modlog.id} currentRevision={modlog.revision} />
        </div>

        {/* Provenance sidebar: who said this, when, and where it came from. */}
        <aside className="lg:sticky lg:top-20 lg:self-start">
          <dl className="card divide-y divide-line text-sm">
            {/* The moderator who filed it comes first: on a moderation
                record, "who says so" outranks every other fact here. */}
            {modlog.thread?.author ? (
              <Fact icon={IconAuthor} label="Filed by">
                <DiscordChip user={modlog.thread.author} size="sm" />
              </Fact>
            ) : null}
            <Fact icon={IconClock} label="Occurred">
              {modlog.occurredAt ? formatDateTime(modlog.occurredAt) : "Not recorded"}
            </Fact>
            <Fact icon={IconArchiveClock} label="Archived">
              {formatDateTime(modlog.createdAt)}
            </Fact>
            {modlog.updatedAt !== modlog.createdAt ? (
              <Fact icon={IconRevision} label="Last edited">
                {formatDateTime(modlog.updatedAt)}
              </Fact>
            ) : null}
            <Fact icon={IconExternal} label="Source">
              {modlog.sourceUrl ? (
                <a
                  href={modlog.sourceUrl}
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                  className="link"
                >
                  {modlog.source}
                </a>
              ) : (
                modlog.source
              )}
            </Fact>
            {modlog.ticketRef ? (
              <Fact icon={IconTicket} label="Ticket">
                <span className="select-all font-mono text-xs">{modlog.ticketRef}</span>
              </Fact>
            ) : null}
            {modlog.thread?.forumName ? (
              <Fact icon={IconChannel} label="Channel">
                <span className="break-words">{modlog.thread.forumName}</span>
              </Fact>
            ) : null}
            <Fact icon={IconRevision} label="Revision">
              {formatNumber(modlog.revision)}
            </Fact>
            <Fact icon={IconTicket} label="Record ID">
              <span className="select-all font-mono text-xs">{modlog.id}</span>
            </Fact>
            <Fact icon={IconAccounts} label="Subject">
              <Link href={`/roblox-modlogs/${robloxId}`} className="link font-mono text-xs">
                {robloxId}
              </Link>
            </Fact>
            {modlog.images?.length ? (
              <Fact icon={IconImage} label="Evidence">
                {modlog.images.length} ·{" "}
                {formatBytes(modlog.images.reduce((sum, img) => sum + img.bytes, 0))}
              </Fact>
            ) : null}
          </dl>

          {modlog.tags.length ? (
            <div className="mt-4">
              <h2 className="mb-2 text-2xs font-semibold uppercase tracking-wider text-faint">
                Tags
              </h2>
              <div className="flex flex-wrap gap-1.5">
                {modlog.tags.map((tag) => (
                  <Tag key={tag} label={tag} href={`/roblox-modlogs/${robloxId}?tag=${tag}`} />
                ))}
              </div>
            </div>
          ) : null}
        </aside>
      </div>
    </article>
  );
}

/**
 * One provenance fact.
 *
 * Was a stacked label-above-value pair; eleven of those turned the sidebar
 * into a column of uppercase headings taller than the record it described.
 * The glyph now leads a single line, with the label in the tooltip and in the
 * `dt` for assistive tech — the definition list stays semantically intact,
 * the heading text just stops being drawn.
 */
function Fact({
  icon: Icon,
  label,
  children,
}: {
  icon: (p: { className?: string }) => React.ReactNode;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline gap-2.5 px-4 py-2" title={label}>
      <dt className="shrink-0 text-faint">
        <Icon className="icon" />
        <span className="sr-only">{label}</span>
      </dt>
      <dd className="min-w-0 text-[0.8125rem] text-fg">{children}</dd>
    </div>
  );
}
