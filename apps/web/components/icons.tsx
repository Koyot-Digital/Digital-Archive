import type { ModlogSeverity } from "@archive/shared";
import { SEVERITY_LABELS } from "@archive/shared";
import { cx } from "@/lib/format";

/**
 * The archive's icon set.
 *
 * Hand-written inline SVG rather than an icon package: there are two dozen
 * glyphs here, they ship as part of the server-rendered HTML with no extra
 * request and no client JavaScript, and a dependency would weigh more than
 * the whole set. Every path is stroked in `currentColor` on a 24-unit grid,
 * so one glyph works at any size and in either theme.
 *
 * Accessibility rule for everything in this file: an icon is `aria-hidden`,
 * and the element that wraps it supplies the words. An icon standing in for
 * text must carry a `title` *and* an `sr-only` label — a tooltip is not
 * readable by a screen reader and is unreachable by touch.
 */

interface IconProps {
  className?: string;
  /** Overrides the default 1.75 stroke for large or very small renderings. */
  strokeWidth?: number;
}

function Svg({
  className,
  strokeWidth = 1.75,
  children,
}: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable="false"
      className={cx("icon", className)}
    >
      {children}
    </svg>
  );
}

/* ───────────────────────────── records ───────────────────────────── */

/** A thread of discussion. */
export function IconThread(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M20 11.5a7.5 7.5 0 0 1-10.9 6.7L4 19.5l1.4-4.1A7.5 7.5 0 1 1 20 11.5Z" />
    </Svg>
  );
}

/** One reply. */
export function IconReply(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h8a8 8 0 0 1 8 8v3" />
    </Svg>
  );
}

/** An attachment — evidence hanging off a record. */
export function IconAttachment(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M21.4 11.1 12.3 20a5.5 5.5 0 0 1-7.8-7.8l8.4-8.4a3.7 3.7 0 0 1 5.2 5.2l-8.4 8.4a1.8 1.8 0 0 1-2.6-2.6l7.8-7.7" />
    </Svg>
  );
}

/** Stored image evidence. */
export function IconImage(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <circle cx="8.75" cy="9.75" r="1.6" />
      <path d="M21 16.5 16.5 12 7 20" />
    </Svg>
  );
}

/** A support ticket reference. */
export function IconTicket(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M4 9.5V7a1.5 1.5 0 0 1 1.5-1.5h13A1.5 1.5 0 0 1 20 7v2.5a2.5 2.5 0 0 0 0 5V17a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17v-2.5a2.5 2.5 0 0 0 0-5Z" />
      <path d="M12 9v6" strokeDasharray="1.5 2" />
    </Svg>
  );
}

/** Edit history / revisions. */
export function IconRevision(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1" />
      <path d="M3.2 4.6v4.2h4.2" />
      <path d="M12 8v4.4l3 1.8" />
    </Svg>
  );
}

/* ───────────────────────────── identity ───────────────────────────── */

/** The moderator who filed a record. */
export function IconAuthor(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M18.4 3.6a2 2 0 0 1 2.8 2.8L9.6 18H6.5v-3.1Z" />
      <path d="M3.5 21h17" />
    </Svg>
  );
}

/** Grouped accounts — alts, or a rename. */
export function IconAccounts(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="9.5" cy="8" r="3.3" />
      <path d="M3.5 20a6 6 0 0 1 12 0" />
      <path d="M16.5 5.2a3.3 3.3 0 0 1 0 6.3" />
      <path d="M18.3 14.4A6 6 0 0 1 21.5 20" />
    </Svg>
  );
}

/** This account moved to another. */
export function IconMovedTo(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M4 12h15" />
      <path d="M13.5 6.5 20 12l-6.5 5.5" />
    </Svg>
  );
}

/** This account came from another. */
export function IconMovedFrom(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M20 12H5" />
      <path d="M10.5 6.5 4 12l6.5 5.5" />
    </Svg>
  );
}

/** Named together, relationship unstated. */
export function IconRelated(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M9.5 14.5 14.5 9.5" />
      <path d="M13 5.9l1.3-1.3a4 4 0 0 1 5.7 5.7l-1.3 1.3" />
      <path d="M11 18.1l-1.3 1.3a4 4 0 0 1-5.7-5.7l1.3-1.3" />
    </Svg>
  );
}

/** A bot account. */
export function IconBot(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="4" y="8" width="16" height="11" rx="3" />
      <path d="M12 8V4.5" />
      <circle cx="9" cy="13.5" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="15" cy="13.5" r="1.1" fill="currentColor" stroke="none" />
    </Svg>
  );
}

/* ───────────────────────────── provenance ───────────────────────────── */

/** A locked thread. */
export function IconLock(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="4.5" y="10.5" width="15" height="9.5" rx="2.2" />
      <path d="M8 10.5V7.8a4 4 0 0 1 8 0v2.7" />
    </Svg>
  );
}

/** An archived thread. */
export function IconArchived(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M3.5 7.5h17V19a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 19Z" />
      <path d="M2.5 4h19v3.5h-19Z" />
      <path d="M10 12h4" />
    </Svg>
  );
}

/** Leaves the archive. */
export function IconExternal(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M13.5 4.5H19.5V10.5" />
      <path d="M19.5 4.5 11 13" />
      <path d="M19 14.5V18a2 2 0 0 1-2 2H6.5a2 2 0 0 1-2-2V7.5a2 2 0 0 1 2-2H10" />
    </Svg>
  );
}

/** The source channel a record was scraped from. */
export function IconChannel(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M9.5 3.5 7.5 20.5" />
      <path d="M16.5 3.5 14.5 20.5" />
      <path d="M4 9h16.5" />
      <path d="M3.5 15H20" />
    </Svg>
  );
}

/** When the sanction happened. */
export function IconClock(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.2V12l3.2 2" />
    </Svg>
  );
}

/** When the archive captured it. */
export function IconArchiveClock(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M3.5 8.5h17" />
      <path d="M4.5 8.5V19A1.5 1.5 0 0 0 6 20.5h7" />
      <path d="M19.5 8.5v3" />
      <path d="M3 4.5h18" />
      <circle cx="17" cy="17" r="4.2" />
      <path d="M17 15.2V17l1.4.9" />
    </Svg>
  );
}

/** Ban duration. */
export function IconDuration(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M8 2.5h8" />
      <path d="M8 21.5h8" />
      <path d="M9 2.5v4.1c0 1 .5 2 1.4 2.6L12 10.4l1.6-1.2A3.2 3.2 0 0 0 15 6.6V2.5" />
      <path d="M9 21.5v-4.1c0-1 .5-2 1.4-2.6L12 13.6l1.6 1.2a3.2 3.2 0 0 1 1.4 2.6v4.1" />
    </Svg>
  );
}

/** A withdrawn or superseded sanction. */
export function IconRevoked(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M6.2 17.8 17.8 6.2" />
    </Svg>
  );
}

/** Something the reader should know but need not act on. */
export function IconInfo(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11v5.2" />
      <circle cx="12" cy="7.9" r="1" fill="currentColor" stroke="none" />
    </Svg>
  );
}

/** An identity the archive has not confirmed against Discord. */
export function IconUnverified(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M12 3.2 20 6v6c0 4.2-3.2 7.6-8 8.8-4.8-1.2-8-4.6-8-8.8V6Z" strokeDasharray="2.5 2" />
      <path d="M12 8.5v4" />
      <circle cx="12" cy="15.6" r=".9" fill="currentColor" stroke="none" />
    </Svg>
  );
}

/* ───────────────────────────── navigation ───────────────────────────── */

export function IconChevronLeft(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M14.5 5.5 8 12l6.5 6.5" />
    </Svg>
  );
}

export function IconChevronRight(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M9.5 5.5 16 12l-6.5 6.5" />
    </Svg>
  );
}

/* ───────────────────────── link kinds ───────────────────────── */

/*
 * These replace the Unicode glyphs the embed cards used to draw (▶ 𝕏 ◇ ◈ ▣).
 * Those were at the mercy of whichever font resolved them — 𝕏 in particular
 * is a mathematical symbol that falls back to a box on plenty of systems — and
 * they could not inherit stroke weight from the rest of the set. No brand
 * marks: a neutral shape saying what a link *is* travels better than a logo
 * drawn from memory, and does not go stale when a company rebrands.
 */

/** Video. */
export function IconPlay(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M10.2 8.9l5 3.1-5 3.1Z" fill="currentColor" />
    </Svg>
  );
}

/** A Roblox experience. */
export function IconGame(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="2.5" y="7" width="19" height="10" rx="4.5" />
      <path d="M7 10.5v3" />
      <path d="M5.5 12h3" />
      <circle cx="16" cy="11.2" r="1" fill="currentColor" stroke="none" />
      <circle cx="18.2" cy="13.4" r="1" fill="currentColor" stroke="none" />
    </Svg>
  );
}

/** A Roblox asset. */
export function IconCube(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M12 2.8l8 4.3v9.8l-8 4.3-8-4.3V7.1Z" />
      <path d="M4 7.1 12 11.5l8-4.4" />
      <path d="M12 11.5v9.7" />
    </Svg>
  );
}

/** A single account. */
export function IconUser(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 20a7 7 0 0 1 14 0" />
    </Svg>
  );
}

/* ───────────────────────────── severity ───────────────────────────── */

const SEVERITY_STEP: Record<ModlogSeverity, number> = {
  info: 1,
  low: 2,
  medium: 3,
  high: 4,
  critical: 5,
};

/**
 * Severity as a stepped meter.
 *
 * The palette is greyscale, so severity has no hue to live in — and five
 * greys are hard to rank by eye and impossible to rank reliably for a reader
 * with low contrast sensitivity. Counting filled bars works regardless: the
 * glyph encodes the rank in *quantity*, with value as reinforcement rather
 * than as the signal. The accessible name is always the severity word, so
 * nothing here depends on seeing it at all.
 */
export function SeverityMeter({
  severity,
  className,
  bars = 5,
}: {
  severity: ModlogSeverity;
  className?: string;
  bars?: number;
}) {
  const filled = SEVERITY_STEP[severity];
  return (
    <span
      className={cx("inline-flex items-end gap-[2.5px] align-[-0.125em]", className)}
      title={`Severity: ${SEVERITY_LABELS[severity]}`}
      role="img"
      aria-label={`Severity: ${SEVERITY_LABELS[severity]}`}
    >
      {Array.from({ length: bars }, (_, i) => (
        <span
          key={i}
          aria-hidden
          className={cx(
            "w-[3px] rounded-[1px]",
            i < filled ? "bg-current" : "bg-current opacity-20",
          )}
          // Ascending heights make the glyph legible even at one bar filled.
          // Topping out at 14px keeps the meter inside the 18px icon step, so
          // a row of severities and a row of glyph metadata sit on one rhythm.
          style={{ height: `${6 + i * 2}px` }}
        />
      ))}
    </span>
  );
}
