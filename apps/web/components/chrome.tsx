import Link from "next/link";
import type { Subject, Viewer } from "@/lib/api";
import { PLATFORM_LABELS } from "@archive/shared";
import { SITE_NAME, loginUrl } from "@/lib/api";
import { cx, formatNumber } from "@/lib/format";
import { SearchBox } from "./search-box";
import { ThemeToggle } from "./theme-toggle";
import { IconAccounts, IconExternal, IconRecord } from "./icons";

/** Top bar. Sticky, hairline-bordered, deliberately quiet. */
export function Header({ viewer }: { viewer: Viewer }) {
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

        {/*
          Two tabs only: the archive is browsed by account or by record, and
          everything else - who files records, the API, the staff tools - is a
          destination you go to deliberately rather than one you navigate
          between. Those live in the footer, which has the side benefit of
          being reachable on a phone, where this nav is hidden entirely.
        */}
        <nav className="hidden items-center gap-1 md:flex">
          <NavLink href="/subjects">
            <IconAccounts className="h-3.5 w-3.5" />
            Subjects
          </NavLink>
          <NavLink href="/modlogs">
            <IconRecord className="h-3.5 w-3.5" />
            All records
          </NavLink>
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
          Authentication is disabled - every visitor has administrator rights. Do not expose this
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
      className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm text-muted transition-colors hover:bg-raised hover:text-fg"
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

function FooterLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} className="transition-colors hover:text-fg">
      {children}
    </Link>
  );
}

export function Footer({ viewer }: { viewer: Viewer }) {
  const role = viewer.user?.role;
  const isStaff = role === "moderator" || role === "admin";
  const isAdmin = role === "admin";

  return (
    <footer className="mt-20 border-t border-line">
      <div className="mx-auto flex max-w-content flex-col gap-4 px-4 py-8 text-xs text-faint sm:flex-row sm:items-start sm:justify-between sm:gap-8 sm:px-6">
        <p className="max-w-prose">
          {SITE_NAME} - a moderation-record archive. Every record carries its source and its full
          edit history.
        </p>

        <nav className="flex flex-wrap items-center gap-x-4 gap-y-2 sm:justify-end">
          {/* Mirrors the header on a phone, where that nav is hidden. */}
          <span className="flex gap-x-4 md:hidden">
            <FooterLink href="/subjects">Subjects</FooterLink>
            <FooterLink href="/modlogs">All records</FooterLink>
          </span>
          <FooterLink href="/moderators">Moderators</FooterLink>
          <FooterLink href="/about">About</FooterLink>
          <FooterLink href="/about#corrections">Corrections</FooterLink>
          <FooterLink href="/api-docs">API</FooterLink>

          {isStaff ? (
            <>
              <span aria-hidden className="text-line-strong">
                /
              </span>
              <FooterLink href="/moderation">Moderation</FooterLink>
            </>
          ) : null}
          {isAdmin ? <FooterLink href="/ingest">Ingest</FooterLink> : null}
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
          {(subject.username ?? subject.externalId).slice(0, 1).toUpperCase()}
        </span>
      )}

      <div className="min-w-0 flex-1">
        <h2 className="truncate text-lg font-semibold tracking-tight">
          {subject.displayName ??
            subject.username ??
            `${PLATFORM_LABELS[subject.platform]} ${subject.externalId}`}
        </h2>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
          {subject.username ? <span>@{subject.username}</span> : null}
          <span className="chip">{PLATFORM_LABELS[subject.platform]}</span>
          <span className="font-mono">{subject.externalId}</span>
          {/* Discord has no public profile page for a bare user id, so there
              is nothing honest to link to and the API returns null. */}
          {subject.profileUrl ? (
            <a
              href={subject.profileUrl}
              target="_blank"
              rel="noopener noreferrer nofollow"
              className="link inline-flex items-center gap-1"
              title={`Open this account's ${PLATFORM_LABELS[subject.platform]} profile`}
            >
              {PLATFORM_LABELS[subject.platform]}
              <IconExternal className="icon-sm" />
            </a>
          ) : null}
        </p>
      </div>

      <div className="flex gap-6 text-right">
        <Stat label="Records" value={formatNumber(subject.logCount)} />
      </div>
    </div>
  );
}

export function Stat({
  label,
  value,
  hint,
  icon,
}: {
  label: string;
  value: string;
  hint?: string;
  /** Sits beside the label, never the number - the figure stays the loudest thing here. */
  icon?: React.ReactNode;
}) {
  return (
    <div>
      <div className="text-xl font-semibold tabular-nums tracking-tight">{value}</div>
      <div className="flex items-center gap-1.5 text-2xs uppercase tracking-wide text-faint">
        {icon}
        {label}
      </div>
      {hint ? <div className="mt-0.5 text-2xs text-faint">{hint}</div> : null}
    </div>
  );
}
