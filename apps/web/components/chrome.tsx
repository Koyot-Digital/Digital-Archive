import Link from "next/link";
import type { Subject, Viewer } from "@/lib/api";
import { SITE_NAME, loginUrl } from "@/lib/api";
import { cx, formatNumber } from "@/lib/format";
import { SearchBox } from "./search-box";
import { ThemeToggle } from "./theme-toggle";

/** Top bar. Sticky, hairline-bordered, deliberately quiet. */
export function Header({ viewer }: { viewer: Viewer }) {
  const role = viewer.user?.role;
  const isStaff = role === "moderator" || role === "admin";

  return (
    <header className="sticky top-0 z-40 border-b border-line bg-bg/85 backdrop-blur-md">
      <div className="mx-auto flex h-14 max-w-content items-center gap-3 px-4 sm:px-6">
        <Link href="/" className="flex shrink-0 items-center gap-2">
          <span
            aria-hidden
            className="grid h-6 w-6 place-items-center rounded-md bg-accent text-[0.7rem] font-bold text-accent-fg"
          >
            DA
          </span>
          <span className="hidden text-sm font-semibold tracking-tight sm:inline">{SITE_NAME}</span>
        </Link>

        <nav className="hidden items-center gap-1 md:flex">
          <NavLink href="/subjects">Subjects</NavLink>
          <NavLink href="/modlogs">All records</NavLink>
          <NavLink href="/moderators">Moderators</NavLink>
          {isStaff ? <NavLink href="/moderation">Moderation</NavLink> : null}
          <NavLink href="/about">About</NavLink>
        </nav>

        <div className="ml-auto flex items-center gap-2">
          <SearchBox compact />
          <ThemeToggle />
          {viewer.authenticated ? (
            <ViewerChip viewer={viewer} />
          ) : viewer.authEnabled ? (
            <a href={loginUrl("/")} className="btn btn-outline">
              Sign in
            </a>
          ) : null}
        </div>
      </div>

      {viewer.devBypass ? (
        <div className="border-t border-sev-medium/30 bg-sev-medium/10 px-4 py-1 text-center text-2xs font-medium text-sev-medium">
          Authentication is disabled — every visitor has administrator rights. Do not expose this
          instance.
        </div>
      ) : null}
    </header>
  );
}

function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="rounded-md px-2.5 py-1.5 text-sm text-muted transition-colors hover:bg-raised hover:text-fg"
    >
      {children}
    </Link>
  );
}

function ViewerChip({ viewer }: { viewer: Viewer }) {
  const user = viewer.user!;
  return (
    <div className="flex items-center gap-2 rounded-full border border-line bg-surface py-0.5 pl-0.5 pr-2.5">
      {user.avatarUrl ? (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img src={user.avatarUrl} alt="" width={24} height={24} className="h-6 w-6 rounded-full" />
      ) : (
        <span className="grid h-6 w-6 place-items-center rounded-full bg-raised text-2xs font-semibold text-muted">
          {user.displayName.slice(0, 1).toUpperCase()}
        </span>
      )}
      <span className="hidden text-xs font-medium sm:inline">{user.displayName}</span>
      <span
        className={cx(
          "rounded px-1 text-2xs font-semibold uppercase tracking-wide",
          user.role === "admin"
            ? "bg-accent/15 text-accent"
            : user.role === "moderator"
              ? "bg-sev-low/15 text-sev-low"
              : "bg-raised text-faint",
        )}
      >
        {user.role}
      </span>
    </div>
  );
}

export function Footer() {
  return (
    <footer className="mt-20 border-t border-line">
      <div className="mx-auto flex max-w-content flex-col gap-3 px-4 py-8 text-xs text-faint sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <p>
          {SITE_NAME} — a moderation-record archive. Every record carries its source and its full
          edit history.
        </p>
        <nav className="flex gap-4">
          <Link href="/about" className="hover:text-fg">
            About
          </Link>
          <Link href="/about#corrections" className="hover:text-fg">
            Corrections
          </Link>
          <Link href="/api-docs" className="hover:text-fg">
            API
          </Link>
        </nav>
      </div>
    </footer>
  );
}

/** Page heading with an optional breadcrumb trail and right-hand slot. */
export function PageHeader({
  breadcrumbs,
  title,
  description,
  actions,
}: {
  breadcrumbs?: { label: string; href?: string }[];
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="mb-6">
      {breadcrumbs?.length ? (
        <nav aria-label="Breadcrumb" className="mb-2.5 flex flex-wrap items-center gap-1.5 text-xs">
          {breadcrumbs.map((crumb, i) => (
            <span key={`${crumb.label}-${i}`} className="flex items-center gap-1.5">
              {i > 0 ? (
                <span aria-hidden className="text-faint">
                  /
                </span>
              ) : null}
              {crumb.href ? (
                <Link href={crumb.href} className="text-muted hover:text-fg">
                  {crumb.label}
                </Link>
              ) : (
                <span className="text-faint">{crumb.label}</span>
              )}
            </span>
          ))}
        </nav>
      ) : null}

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-balance text-2xl font-semibold tracking-tight">{title}</h1>
          {description ? (
            <div className="mt-1.5 text-sm leading-6 text-muted">{description}</div>
          ) : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </div>
    </div>
  );
}

/** Subject identity panel, shown above that account's records. */
export function SubjectHeader({ subject }: { subject: Subject }) {
  return (
    <div className="card flex flex-wrap items-center gap-4 p-4 sm:p-5">
      {subject.avatarUrl ? (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img
          src={subject.avatarUrl}
          alt=""
          width={56}
          height={56}
          className="h-14 w-14 rounded-full border border-line bg-raised"
        />
      ) : (
        <span className="grid h-14 w-14 place-items-center rounded-full border border-line bg-raised text-lg font-semibold text-faint">
          {(subject.username ?? subject.robloxId).slice(0, 1).toUpperCase()}
        </span>
      )}

      <div className="min-w-0 flex-1">
        <h2 className="truncate text-lg font-semibold tracking-tight">
          {subject.displayName ?? subject.username ?? `Roblox user ${subject.robloxId}`}
        </h2>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
          {subject.username ? <span>@{subject.username}</span> : null}
          <span aria-hidden className="text-faint">
            ·
          </span>
          <span className="font-mono">{subject.robloxId}</span>
          <span aria-hidden className="text-faint">
            ·
          </span>
          <a
            href={subject.profileUrl}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="text-accent hover:underline"
          >
            Roblox profile ↗
          </a>
        </p>
      </div>

      <div className="flex gap-6 text-right">
        <Stat label="Records" value={formatNumber(subject.logCount)} />
      </div>
    </div>
  );
}

export function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div>
      <div className="text-xl font-semibold tabular-nums tracking-tight">{value}</div>
      <div className="text-2xs uppercase tracking-wide text-faint">{label}</div>
      {hint ? <div className="mt-0.5 text-2xs text-faint">{hint}</div> : null}
    </div>
  );
}
