import {
  ACTION_LABELS,
  SEVERITY_LABELS,
  type ModlogAction,
  type ModlogSeverity,
  type RecordStatus,
} from "@archive/shared";
import { cx, severityStyles } from "@/lib/format";
import { SeverityMeter, IconLock, IconRevoked } from "./icons";

/**
 * Severity.
 *
 * The old pill spent a coloured dot, a border, a tinted background and the
 * word on a single ordinal value. In a greyscale palette the border and tint
 * cannot carry rank anyway, so this is now the stepped meter plus the word -
 * and on dense list rows, the meter alone, which stays scannable at a glance
 * while giving a 500-row page its horizontal space back. The accessible name
 * is the word in both cases.
 */
export function SeverityBadge({
  severity,
  size = "md",
}: {
  severity: ModlogSeverity;
  /** `sm` drops the word; the meter keeps its label for assistive tech. */
  size?: "sm" | "md";
}) {
  const style = severityStyles[severity];

  if (size === "sm") {
    return <SeverityMeter severity={severity} className={style.text} />;
  }

  return (
    <span className={cx("inline-flex items-center gap-1.5 text-xs font-medium", style.text)}>
      <SeverityMeter severity={severity} />
      {SEVERITY_LABELS[severity]}
    </span>
  );
}

/**
 * The sanction itself.
 *
 * Deliberately *not* an icon. Ten actions - ban, temp ban, kick, mute,
 * content deletion, termination - have no glyph vocabulary a reader would
 * recognise without being taught one, and this is the record's substance
 * rather than its chrome. Icons replace scaffolding here, not meaning.
 */
export function ActionBadge({ action }: { action: ModlogAction }) {
  return (
    <span className="inline-flex items-center rounded-md border border-line bg-raised px-2 py-0.5 text-xs font-medium text-muted">
      {ACTION_LABELS[action]}
    </span>
  );
}

/**
 * Shown only when a record is not published, so moderators can tell at a
 * glance which rows the public cannot see. Keeps its word: a withheld record
 * is exactly the thing that must not be missed.
 */
export function StatusBadge({ status }: { status: RecordStatus }) {
  if (status === "published") return null;
  const hidden = status === "hidden";
  const Icon = hidden ? IconLock : IconRevoked;
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-2xs font-semibold uppercase tracking-wide",
        hidden
          ? "border-line-strong bg-raised text-fg"
          : "border-sev-critical/50 bg-sev-critical/10 text-sev-critical",
      )}
      title={
        hidden
          ? "Visible to moderators only, pending review"
          : "Soft-deleted; the body is withheld from the public API"
      }
    >
      <Icon className="icon-sm" />
      {hidden ? "Hidden" : "Removed"}
    </span>
  );
}

export function Tag({ label, href }: { label: string; href?: string }) {
  const body = <span className="chip hover:border-line-strong hover:text-fg">{label}</span>;
  return href ? <a href={href}>{body}</a> : body;
}

export function Chip({ children }: { children: React.ReactNode }) {
  return <span className="chip">{children}</span>;
}

/**
 * Icon plus value, with the words in the accessible name.
 *
 * The workhorse for record metadata - reply counts, attachment counts, ticket
 * references. One of these is roughly a third the width of the phrase it
 * replaces, which is what lets a list row show provenance without wrapping.
 */
export function Meta({
  icon: Icon,
  label,
  children,
  className,
}: {
  icon: (p: { className?: string }) => React.ReactNode;
  /** Spelled out for assistive tech and on hover, e.g. "21 replies". */
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span className={cx("meta", className)} title={label}>
      <Icon className="icon-sm" />
      <span aria-hidden>{children}</span>
      <span className="sr-only">{label}</span>
    </span>
  );
}
