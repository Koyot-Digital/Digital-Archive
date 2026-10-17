import { ACTION_LABELS, SEVERITY_LABELS, type ModlogAction, type ModlogSeverity, type RecordStatus } from "@archive/shared";
import { cx, severityStyles } from "@/lib/format";

/**
 * Severity is the single most scanned value on a list page, so it gets a
 * coloured dot plus a label rather than colour alone — colour is never the
 * only carrier of meaning.
 */
export function SeverityBadge({
  severity,
  size = "md",
}: {
  severity: ModlogSeverity;
  size?: "sm" | "md";
}) {
  const style = severityStyles[severity];
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1.5 rounded-full border font-medium",
        style.border,
        style.bg,
        style.text,
        size === "sm" ? "px-1.5 py-0.5 text-2xs" : "px-2 py-0.5 text-xs",
      )}
    >
      <span className={cx("h-1.5 w-1.5 rounded-full", style.dot)} aria-hidden />
      {SEVERITY_LABELS[severity]}
    </span>
  );
}

export function ActionBadge({ action }: { action: ModlogAction }) {
  return (
    <span className="inline-flex items-center rounded-md border border-line bg-raised px-2 py-0.5 text-xs font-medium text-muted">
      {ACTION_LABELS[action]}
    </span>
  );
}

/**
 * Shown only when a record is not published, so moderators can tell at a
 * glance which rows the public cannot see.
 */
export function StatusBadge({ status }: { status: RecordStatus }) {
  if (status === "published") return null;
  const label = status === "hidden" ? "Hidden" : "Removed";
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-semibold uppercase tracking-wide",
        status === "hidden"
          ? "border-sev-medium/40 bg-sev-medium/10 text-sev-medium"
          : "border-sev-critical/40 bg-sev-critical/10 text-sev-critical",
      )}
      title={
        status === "hidden"
          ? "Visible to moderators only, pending review"
          : "Soft-deleted; the body is withheld from the public API"
      }
    >
      {label}
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
