import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import type {
  ModlogAction,
  ModlogSeverity,
  RecordStatus,
  UserRole,
} from "@archive/shared";

/**
 * Server-side API client.
 *
 * Reads go to the text service over the docker network (INTERNAL_TEXT_API),
 * never back out through the tunnel, so a page render is one hop. The
 * viewer's session cookie is forwarded so the API applies the same visibility
 * rules it would for a direct call — the web app has no privileges of its own
 * and cannot see a hidden record the viewer could not.
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
  /** Seconds. 0 disables the cache for role-dependent responses. */
  revalidate?: number;
  tags?: string[];
}

async function apiGet<T>(path: string, opts: FetchOptions = {}): Promise<T> {
  const cookieStore = await cookies();
  const cookieHeader = cookieStore.toString();

  // A response that depends on who is asking must never be cached across
  // viewers, so any request carrying a session is fetched fresh.
  const cacheable = opts.revalidate !== 0 && !cookieHeader;

  const res = await fetch(`${INTERNAL_BASE}${path}`, {
    headers: {
      accept: "application/json",
      ...(cookieHeader ? { cookie: cookieHeader } : {}),
    },
    ...(cacheable
      ? { next: { revalidate: opts.revalidate ?? 60, tags: opts.tags ?? [] } }
      : { cache: "no-store" }),
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
  robloxId: string;
  username: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  logCount: number;
  firstLogAt: string | null;
  lastLogAt: string | null;
  profileUrl: string;
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

export interface Modlog {
  id: string;
  robloxId: string;
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
  createdAt: string;
  updatedAt: string;
  url: string;
  body?: { markdown: string; html: string };
  evidence?: Record<string, unknown>;
  images?: ArchiveImage[];
  linkEmbeds?: LinkEmbed[];
  subject?: Subject;
  thumbnail?: ArchiveImage | null;
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

  subjects: (params: { page?: number; limit?: number; q?: string; sort?: string } = {}) =>
    apiGet<{ subjects: Subject[]; total: number; page: number; limit: number }>(
      `/subjects${qs(params)}`,
      { revalidate: 60 },
    ),

  subject: (
    robloxId: string,
    params: { page?: number; limit?: number; action?: string; severity?: string; tag?: string; sort?: string } = {},
  ) =>
    apiGet<Page<Modlog> & { subject: Subject }>(
      `/roblox-modlogs/${robloxId}${qs(params)}`,
      { revalidate: 30 },
    ),

  modlog: (robloxId: string, logId: string) =>
    apiGet<{ modlog: Modlog }>(`/roblox-modlogs/${robloxId}/${logId}`, { revalidate: 60 }),

  /** Flat lookup, for when only the record id is known (audit links). */
  modlogById: (logId: string) =>
    apiGet<{ modlog: Modlog }>(`/modlogs/${logId}`, { revalidate: 60 }),

  image: (robloxId: string, logId: string, imageId: string) =>
    apiGet<{
      image: ArchiveImage;
      siblings: ArchiveImage[];
      modlog: { id: string; robloxId: string; title: string; url: string; subject?: Subject };
    }>(`/roblox-modlogs/${robloxId}/${logId}/${imageId}`, { revalidate: 300 }),

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
        robloxId: string;
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

/** Login URL that returns the viewer to where they were. */
export function loginUrl(returnTo: string): string {
  return `${PUBLIC_API_BASE}/auth/discord?return_to=${encodeURIComponent(returnTo)}`;
}

export function logoutUrl(): string {
  return `${PUBLIC_API_BASE}/auth/logout`;
}
