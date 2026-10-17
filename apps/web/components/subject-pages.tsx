import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  ACTION_LABELS,
  ID_PATTERN,
  MODLOG_ACTIONS,
  PLATFORM_LABELS,
  normalizeId,
  type ModlogAction,
  type SubjectPlatform,
} from "@archive/shared";
import { SITE_NAME, api } from "@/lib/api";
import { cx, formatBytes, formatDate, formatDateTime, formatNumber } from "@/lib/format";
import { ActionBadge, SeverityBadge, StatusBadge, Tag } from "@/components/badges";
import { PageHeader, SubjectHeader } from "@/components/chrome";
import { DiscordChip } from "@/components/discord-identity";
import {
  IconAccounts,
  IconArchiveClock,
  IconAuthor,
  IconChannel,
  IconChevronLeft,
  IconChevronRight,
  IconClock,
  IconExternal,
  IconImage,
  IconRevision,
  IconTicket,
} from "@/components/icons";
import { ImageFacts } from "@/components/image-grid";
import { ImageGrid } from "@/components/image-grid";
import { LinkEmbedList } from "@/components/link-embed";
import { ModlogList } from "@/components/modlog-card";
import { Pagination } from "@/components/pagination";
import { RelatedAccounts } from "@/components/related-accounts";
import { RevisionHistory } from "@/components/revision-history";
import { ThreadPanel } from "@/components/thread";

/**
 * The subject-facing pages, written once and mounted per platform.
 *
 * `/roblox-modlogs/<id>` and `/discord-modlogs/<id>` are the same three pages
 * over a different platform. Next cannot express that as one route - a
 * partial dynamic segment like `[platform]-modlogs` is not a thing, and a
 * fully dynamic `[segment]` would greedily swallow every other top-level
 * path - so the routes are two thin folders of wrappers around these
 * functions. The duplication is six files of three lines each; the
 * alternative was two divergent copies of three real pages.
 */

const LIMIT = 25;

/** An account id in a URL: digits only, either platform. */
const ACCOUNT_ID = /^[1-9][0-9]{0,19}$/;

function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function clean(value: string): string {
  return normalizeId(value.replace(/\.webp$/i, ""));
}

/** How to name a subject when it has no username on record. */
function fallbackName(platform: SubjectPlatform, accountId: string): string {
  return `${PLATFORM_LABELS[platform]} ${accountId}`;
}

/* ─────────────────────────── subject index ─────────────────────────── */

export interface SubjectPageProps {
  params: Promise<{ accountId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export async function subjectMetadata(
  platform: SubjectPlatform,
  { params }: SubjectPageProps,
): Promise<Metadata> {
  const { accountId } = await params;
  if (!ACCOUNT_ID.test(accountId)) return { title: "Not found" };

  const data = await api.subject(platform, accountId, { limit: 1 }).catch(() => null);
  if (!data) return { title: fallbackName(platform, accountId) };

  const name =
    data.subject.displayName ?? data.subject.username ?? fallbackName(platform, accountId);
  return {
    title: `${name} - moderation records`,
    description: `${formatNumber(data.total)} archived moderation record(s) for ${name} (${PLATFORM_LABELS[platform]} ID ${accountId}).`,
    alternates: { canonical: data.subject.archiveUrl },
    openGraph: {
      title: `${name} · ${SITE_NAME}`,
      description: `${formatNumber(data.total)} archived moderation record(s).`,
    },
  };
}

export async function SubjectPage({
  platform,
  params,
  searchParams,
}: SubjectPageProps & { platform: SubjectPlatform }) {
  const { accountId } = await params;
  // Reject anything that is not a plausible account id before touching the API.
  if (!ACCOUNT_ID.test(accountId)) notFound();

  const search = await searchParams;
  const page = Math.max(1, Number.parseInt(one(search.page) ?? "1", 10) || 1);
  const action = one(search.action);
  const severity = one(search.severity);
  const tag = one(search.tag);
  const sort = one(search.sort) ?? "newest";

  const data = await api.subject(platform, accountId, {
    page,
    limit: LIMIT,
    ...(action ? { action } : {}),
    ...(severity ? { severity } : {}),
    ...(tag ? { tag } : {}),
    sort,
  });

  const { subject } = data;
  const name = subject.displayName ?? subject.username ?? fallbackName(platform, accountId);
  const filtered = Boolean(action || severity || tag);
  const base = subject.archiveUrl;

  return (
    <div className="animate-fade-up">
      <PageHeader
        breadcrumbs={[
          { label: "Archive", href: "/" },
          { label: "Subjects", href: "/subjects" },
          { label: accountId },
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

      <div className="mb-6 space-y-4">
        <SubjectHeader subject={subject} />
        {/* Before the record list, not after: on an alt's page this panel is
            the explanation for why the list below may be empty. */}
        <RelatedAccounts accounts={data.relatedAccounts} />
      </div>

      {/* Filters are plain links so the whole page works without JavaScript. */}
      <div className="mb-4 flex flex-wrap items-center gap-1.5">
        <FilterLink base={base} active={!action} label="All actions" />
        {MODLOG_ACTIONS.map((candidate) => (
          <FilterLink
            key={candidate}
            base={base}
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
              : data.relatedAccounts.length
                ? "No records are filed under this account - see the grouped accounts above."
                : "No records are archived for this account."
          }
        />
        <Pagination
          page={data.page}
          limit={data.limit}
          total={data.total}
          basePath={base}
          params={{ action, severity, tag, sort: sort === "newest" ? undefined : sort }}
        />
      </div>

      <p className="mt-4 text-xs text-faint">
        Something inaccurate?{" "}
        <Link href="/about#corrections" className="link">
          How corrections work
        </Link>
        .
      </p>
    </div>
  );
}

function FilterLink({
  base,
  action,
  active,
  label,
}: {
  base: string;
  action?: ModlogAction;
  active: boolean;
  label: string;
}) {
  return (
    <Link
      href={action ? `${base}?action=${action}` : base}
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

/* ─────────────────────────── one record ─────────────────────────── */

export interface RecordPageProps {
  params: Promise<{ accountId: string; logId: string }>;
}

export async function recordMetadata(
  platform: SubjectPlatform,
  { params }: RecordPageProps,
): Promise<Metadata> {
  const { accountId, logId: rawLogId } = await params;
  const logId = normalizeId(rawLogId);
  if (!ACCOUNT_ID.test(accountId) || !ID_PATTERN.test(logId)) return { title: "Not found" };

  const data = await api.modlog(platform, accountId, logId).catch(() => null);
  if (!data) return { title: "Record not found" };

  const { modlog } = data;
  const name =
    modlog.subject?.displayName ??
    modlog.subject?.username ??
    fallbackName(platform, accountId);
  return {
    title: modlog.title,
    description: modlog.excerpt || `Archived moderation record for ${name}.`,
    alternates: { canonical: modlog.url },
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

export async function RecordPage({
  platform,
  params,
}: RecordPageProps & { platform: SubjectPlatform }) {
  const { accountId, logId: rawLogId } = await params;
  const logId = normalizeId(rawLogId);
  if (!ACCOUNT_ID.test(accountId) || !ID_PATTERN.test(logId)) notFound();

  const { modlog } = await api.modlog(platform, accountId, logId);
  const subjectName =
    modlog.subject?.displayName ??
    modlog.subject?.username ??
    fallbackName(platform, accountId);
  const subjectUrl = modlog.subject?.archiveUrl ?? "/subjects";

  const withheld = modlog.status === "removed" && !modlog.body?.html;

  return (
    <article className="animate-fade-up">
      <PageHeader
        breadcrumbs={[
          { label: "Archive", href: "/" },
          { label: subjectName, href: subjectUrl },
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
          <Link href={subjectUrl} className="btn btn-outline">
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
            <Fact icon={IconAccounts} label={`Subject (${PLATFORM_LABELS[modlog.platform]})`}>
              <Link href={subjectUrl} className="link font-mono text-xs">
                {modlog.externalId}
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
                  <Tag key={tag} label={tag} href={`${subjectUrl}?tag=${tag}`} />
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
 * `dt` for assistive tech - the definition list stays semantically intact,
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

/* ─────────────────────────── one image ─────────────────────────── */

export interface ImagePageProps {
  params: Promise<{ accountId: string; logId: string; imageId: string }>;
}

export async function imageMetadata(
  platform: SubjectPlatform,
  { params }: ImagePageProps,
): Promise<Metadata> {
  const raw = await params;
  const logId = clean(raw.logId);
  const imageId = clean(raw.imageId);
  if (!ACCOUNT_ID.test(raw.accountId) || !ID_PATTERN.test(logId) || !ID_PATTERN.test(imageId)) {
    return { title: "Not found" };
  }

  const data = await api.image(platform, raw.accountId, logId, imageId).catch(() => null);
  if (!data) return { title: "Image not found" };

  return {
    title: data.image.caption ?? `Evidence · ${data.modlog.title}`,
    description: data.image.caption ?? `Archived evidence image from "${data.modlog.title}".`,
    alternates: { canonical: data.image.pageUrl },
    openGraph: {
      title: `${data.image.caption ?? "Evidence"} · ${SITE_NAME}`,
      type: "article",
      images: [{ url: data.image.url, width: data.image.width, height: data.image.height }],
    },
    // Evidence should be reachable by link, not surfaced in image search.
    robots: { index: false, follow: true },
  };
}

export async function ImagePage({
  platform,
  params,
}: ImagePageProps & { platform: SubjectPlatform }) {
  const raw = await params;
  const logId = clean(raw.logId);
  const imageId = clean(raw.imageId);
  if (!ACCOUNT_ID.test(raw.accountId) || !ID_PATTERN.test(logId) || !ID_PATTERN.test(imageId)) {
    notFound();
  }

  const { image, siblings, modlog } = await api.image(platform, raw.accountId, logId, imageId);
  const index = siblings.findIndex((s) => s.id === image.id);
  const previous = index > 0 ? siblings[index - 1] : undefined;
  const next = index >= 0 && index < siblings.length - 1 ? siblings[index + 1] : undefined;
  const subjectName =
    modlog.subject?.displayName ??
    modlog.subject?.username ??
    fallbackName(platform, raw.accountId);

  return (
    <div className="animate-fade-up">
      <PageHeader
        breadcrumbs={[
          { label: "Archive", href: "/" },
          { label: subjectName, href: modlog.subject?.archiveUrl ?? "/subjects" },
          { label: modlog.title, href: modlog.url },
          { label: "Evidence" },
        ]}
        title={image.caption ?? `Evidence ${index + 1} of ${siblings.length}`}
        description={
          <>
            From{" "}
            <Link href={modlog.url} className="link">
              {modlog.title}
            </Link>
          </>
        }
        actions={
          <a href={image.url} download className="btn btn-outline">
            Download WebP
          </a>
        }
      />

      {/* Checkerboard behind the image so transparent PNG screenshots read correctly. */}
      <figure className="overflow-hidden rounded-card border border-line bg-raised">
        <div
          className="flex max-h-[76vh] items-center justify-center"
          style={{
            backgroundImage:
              "linear-gradient(45deg, rgb(var(--line) / 0.6) 25%, transparent 25%, transparent 75%, rgb(var(--line) / 0.6) 75%), linear-gradient(45deg, rgb(var(--line) / 0.6) 25%, transparent 25%, transparent 75%, rgb(var(--line) / 0.6) 75%)",
            backgroundSize: "16px 16px",
            backgroundPosition: "0 0, 8px 8px",
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={image.url}
            alt={image.caption ?? `Evidence image ${index + 1}`}
            width={image.width}
            height={image.height}
            className="max-h-[76vh] w-auto max-w-full object-contain"
          />
        </div>
        {image.caption ? (
          <figcaption className="border-t border-line px-4 py-2.5 text-sm text-muted">
            {image.caption}
          </figcaption>
        ) : null}
      </figure>

      {siblings.length > 1 ? (
        <nav className="mt-4 flex items-center justify-between gap-3">
          {previous ? (
            <Link
              href={previous.pageUrl}
              rel="prev"
              className="btn btn-outline"
              title="Previous evidence image"
              aria-label="Previous evidence image"
            >
              <IconChevronLeft className="icon" />
            </Link>
          ) : (
            <span />
          )}

          <div className="flex flex-wrap items-center justify-center gap-1.5">
            {siblings.map((sibling, i) => (
              <Link
                key={sibling.id}
                href={sibling.pageUrl}
                aria-label={`Evidence ${i + 1}`}
                aria-current={sibling.id === image.id ? "page" : undefined}
                className={cx(
                  "h-10 w-14 overflow-hidden rounded border transition-colors",
                  sibling.id === image.id
                    ? "border-accent ring-1 ring-accent"
                    : "border-line opacity-60 hover:opacity-100",
                )}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={sibling.thumbUrl}
                  alt=""
                  loading="lazy"
                  decoding="async"
                  className="h-full w-full object-cover"
                />
              </Link>
            ))}
          </div>

          {next ? (
            <Link
              href={next.pageUrl}
              rel="next"
              className="btn btn-outline"
              title="Next evidence image"
              aria-label="Next evidence image"
            >
              <IconChevronRight className="icon" />
            </Link>
          ) : (
            <span />
          )}
        </nav>
      ) : null}

      <div className="mt-6">
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-faint">
          Image details
        </h2>
        <ImageFacts image={image} />
      </div>
    </div>
  );
}
