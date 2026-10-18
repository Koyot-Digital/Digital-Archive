import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { PLATFORM_PATHS } from "@archive/shared";
import type {
  ModlogAction,
  ModlogSeverity,
  RecordStatus,
  SubjectPlatform,
  SubjectRelation,
  ThreadRole,
  UserRole,
} from "@archive/shared";

/**
 * Server-side API client.
 *
 * Reads go to the text service over the docker network (INTERNAL_TEXT_API),
 * never back out through the tunnel, so a page render is one hop. The
 * viewer's session cookie is forwarded so the API applies the same visibility
 * rules it would for a direct call - the web app has no privileges of its own
 * and cannot see a hidden record the viewer could not.
 *
 * That last property is what makes the role gate hold on this side: there is
 * no service account here to fall back on, so an unauthenticated render
 * cannot accidentally succeed. It gets a 401 like anyone else.
 */

const INTERNAL_BASE =
  process.env.INTERNAL_TEXT_API ?? "http://127.0.0.1:4001/digitalarchive/v1";

/** Browser-visible base, for links and client-side calls. */
export const PUBLIC_API_BASE =
  process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:4001/digitalarchive/v1";

export const SITE_NAME = process.env.NEXT_PUBLIC_SITE_NAME ?? "Digital Archive";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

interface FetchOptions {
  /**
   * Retained so call sites keep documenting how fresh each read needs to be,
   * and so the API's own cache-control stays meaningful. It no longer selects
   * a Next data-cache entry - see below.
   */
  revalidate?: number;
  tags?: string[];
}

async function apiGet<T>(path: string, opts: FetchOptions = {}): Promise<T> {
  const cookieStore = await cookies();
  const cookieHeader = cookieStore.toString();

  /*
   * Never cached, deliberately.
   *
   * This used to cache any request that carried no cookie, on the reasoning
   * that a cookie-less response is the same for everybody. That held while
   * the archive was public. It does not hold now: a cookie-less request is an
   * unauthenticated one, its response is a 401, and the only thing caching it
   * could achieve is storing an error. Meanwhile every real read carries a
   * session and is therefore specific to one viewer and one role.
   *
   * So there is nothing left that is both shared and cacheable, and keeping
   * the branch would leave a cache whose correctness depended on a cookie
   * check it would be easy to get subtly wrong later.
   */
  const res = await fetch(`${INTERNAL_BASE}${path}`, {
    headers: {
      accept: "application/json",
      ...(cookieHeader ? { cookie: cookieHeader } : {}),
    },
    cache: "no-store",
  });

  if (res.status === 404) notFound();

  if (!res.ok) {
    let code = "http_error";
    let message = `API returned ${res.status}`;
    try {
      const body = (await res.json()) as { error?: { code?: string; message?: string } };
      code = body.error?.code ?? code;
      message = body.error?.message ?? message;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, code, message);
  }

  return (await res.json()) as T;
}

/* ─────────────────────────── response shapes ─────────────────────────── */

export interface Subject {
  /** Surrogate key. Stable across a rename on the platform itself. */
  id: string;
  platform: SubjectPlatform;
  /** The account's id on its own platform. */
  externalId: string;
  username: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  logCount: number;
  firstLogAt: string | null;
  lastLogAt: string | null;
  /** Null for platforms with no addressable public profile, i.e. Discord. */
  profileUrl: string | null;
  archiveUrl: string;
}

export interface ArchiveImage {
  id: string;
  url: string;
  thumbUrl: string;
  pageUrl: string;
  width: number;
  height: number;
  bytes: number;
  caption: string | null;
  blurDataUrl: string | null;
  position: number;
  originalFormat: string;
  originalBytes: number;
}

export interface LinkEmbed {
  url: string;
  domain: string;
  kind: string;
  ref: string | null;
  title: string | null;
  description: string | null;
  imageUrl: string | null;
  siteName: string | null;
}

/**
 * A Discord account the archive knows about.
 *
 * `avatarUrl` is always a usable URL - the API substitutes Discord's own
 * default avatar rather than returning null - so nothing here has to decide
 * what to draw in a gap.
 */
export interface DiscordIdentity {
  id: string;
  username: string | null;
  displayName: string | null;
  avatarUrl: string;
  bot: boolean;
  resolvedFrom: "scrape" | "discord_api";
  fetchedAt: string | null;
}

export interface ThreadParticipant extends DiscordIdentity {
  role: ThreadRole;
  messageCount: number;
}

export interface ThreadMessage {
  messageId: string;
  position: number;
  html: string;
  postedAt: string | null;
  editedAt: string | null;
  imageCount: number;
  author: DiscordIdentity | null;
}

/** The source discussion behind a record. */
export interface Thread {
  postId: string | null;
  guildId: string | null;
  forumName: string | null;
  url: string | null;
  replyCount: number;
  archived: boolean;
  locked: boolean;
  lastMessageAt: string | null;
  author: DiscordIdentity | null;
  participants: ThreadParticipant[];
  messages: ThreadMessage[];
}

/**
 * Another account grouped with this one.
 *
 * Carries its own platform, because these groupings cross platforms: a
 * Discord record routinely names the Roblox account behind the offender.
 */
export interface RelatedAccount {
  subjectId: string;
  platform: SubjectPlatform;
  externalId: string;
  username: string | null;
  relation: SubjectRelation;
  logCount: number;
  archiveUrl: string;
  assertedBy: string | null;
}

export interface Moderator extends DiscordIdentity {
  recordCount: number;
  lastRecordAt: string | null;
}

export interface Modlog {
  id: string;
  subjectId: string;
  platform: SubjectPlatform;
  /** The subject's id on its own platform. */
  externalId: string;
  title: string;
  excerpt: string;
  action: ModlogAction;
  severity: ModlogSeverity;
  reason: string | null;
  occurredAt: string | null;
  source: string;
  sourceUrl: string | null;
  tags: string[];
  status: RecordStatus;
  revision: number;
  imageCount: number;
  ticketRef: string | null;
  threadReplyCount: number;
  createdAt: string;
  updatedAt: string;
  url: string;
  body?: { markdown: string; html: string };
  evidence?: Record<string, unknown>;
  images?: ArchiveImage[];
  linkEmbeds?: LinkEmbed[];
  subject?: Subject;
  thumbnail?: ArchiveImage | null;
  thread?: Thread | null;
  relatedAccounts?: RelatedAccount[];
}

export interface Page<T> {
  total: number;
  page: number;
  limit: number;
  hasMore: boolean;
  modlogs: T[];
}

export interface ArchiveStats {
  archive: {
    subjects: number;
    modlogs: number;
    images: number;
    sources: { source: string; count: number }[];
    actions: { action: string; count: number }[];
    platforms: { platform: SubjectPlatform; subjects: number; modlogs: number }[];
    latestAt: string | null;
  };
  images: {
    count: number;
    storedBytes: number;
    originalBytes: number;
    savedRatio: number;
  };
}

export interface Viewer {
  authenticated: boolean;
  authEnabled: boolean;
  devBypass: boolean;
  user: {
    id: string;
    username: string;
    displayName: string;
    avatarUrl: string | null;
    role: UserRole;
  } | null;
}

export interface Revision {
  revision: number;
  changeReason: string | null;
  changedBy: string | null;
  changedByKey: string | null;
  createdAt: string;
  snapshot: Record<string, unknown>;
}

export interface AuditEntry {
  id: number;
  actorType: string;
  actorId: string | null;
  actorLabel: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

/* ─────────────────────────── queries ─────────────────────────── */

function qs(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") search.set(key, String(value));
  }
  const s = search.toString();
  return s ? `?${s}` : "";
}

export const api = {
  stats: () => apiGet<ArchiveStats>("/stats", { revalidate: 300 }),

  viewer: () => apiGet<Viewer>("/auth/me", { revalidate: 0 }),

  recent: (params: { page?: number; limit?: number; action?: string; severity?: string } = {}) =>
    apiGet<Page<Modlog>>(`/modlogs${qs(params)}`, { revalidate: 30 }),

  subjects: (
    params: { page?: number; limit?: number; q?: string; platform?: string; sort?: string } = {},
  ) =>
    apiGet<{
      subjects: Subject[];
      total: number;
      page: number;
      limit: number;
      platforms: Record<string, number>;
    }>(`/subjects${qs(params)}`, { revalidate: 60 }),

  /**
   * One account's records.
   *
   * The platform is part of the path, not a query parameter, because it is
   * part of the account's identity - the same digits on the other platform
   * are a different subject, and must 404 rather than silently resolve.
   */
  subject: (
    platform: SubjectPlatform,
    accountId: string,
    params: { page?: number; limit?: number; action?: string; severity?: string; tag?: string; sort?: string } = {},
  ) =>
    apiGet<Page<Modlog> & { subject: Subject; relatedAccounts: RelatedAccount[] }>(
      `/${PLATFORM_PATHS[platform]}/${accountId}${qs(params)}`,
      { revalidate: 30 },
    ),

  /** Everyone who has filed a record, derived from the records themselves. */
  moderators: (params: { limit?: number } = {}) =>
    apiGet<{ moderators: Moderator[]; identityRefresh: boolean }>(
      `/moderators${qs(params)}`,
      { revalidate: 3600 },
    ),

  modlog: (platform: SubjectPlatform, accountId: string, logId: string) =>
    apiGet<{ modlog: Modlog }>(`/${PLATFORM_PATHS[platform]}/${accountId}/${logId}`, {
      revalidate: 60,
    }),

  /** Flat lookup, for when only the record id is known (audit links). */
  modlogById: (logId: string) =>
    apiGet<{ modlog: Modlog }>(`/modlogs/${logId}`, { revalidate: 60 }),

  image: (platform: SubjectPlatform, accountId: string, logId: string, imageId: string) =>
    apiGet<{
      image: ArchiveImage;
      siblings: ArchiveImage[];
      modlog: {
        id: string;
        platform: SubjectPlatform;
        externalId: string;
        title: string;
        url: string;
        subject?: Subject;
      };
    }>(`/${PLATFORM_PATHS[platform]}/${accountId}/${logId}/${imageId}`, { revalidate: 300 }),

  revisions: (logId: string) =>
    apiGet<{ modlogId: string; revisions: Revision[] }>(`/modlogs/${logId}/revisions`, {
      revalidate: 0,
    }),

  search: (params: { q: string; page?: number; limit?: number; action?: string; severity?: string }) =>
    apiGet<Page<Modlog> & { query: string }>(`/search${qs(params)}`, { revalidate: 60 }),

  audit: (params: { page?: number; limit?: number; action?: string } = {}) =>
    apiGet<{ entries: AuditEntry[]; total: number; page: number; limit: number }>(
      `/moderation/audit${qs(params)}`,
      { revalidate: 0 },
    ),

  queue: () =>
    apiGet<{
      items: {
        id: string;
        subjectId: string;
        platform: SubjectPlatform;
        externalId: string;
        title: string;
        status: string;
        action: string;
        severity: string;
        source: string;
        revision: number;
        updatedAt: string;
        url: string;
      }[];
    }>("/moderation/queue", { revalidate: 0 }),
};

/**
 * Login URL that returns the viewer to where they were.
 *
 * `reauth` forces Discord's consent screen. The login page sets it when it is
 * already displaying an OAuth error, because the most likely cause is an
 * account that authorised an earlier build and has not granted the scope the
 * role check needs - and retrying with the same quiet prompt would reproduce
 * the same error indefinitely.
 */
export function loginUrl(returnTo: string, reauth = false): string {
  const params = new URLSearchParams({ return_to: returnTo });
  if (reauth) params.set("reauth", "1");
  return `${PUBLIC_API_BASE}/auth/discord?${params.toString()}`;
}

export function logoutUrl(): string {
  return `${PUBLIC_API_BASE}/auth/logout`;
}
