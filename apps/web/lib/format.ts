import type { ModlogSeverity } from "@archive/shared";

/** Absolute, unambiguous, sortable. An archive should not say "3 days ago". */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "Unknown";
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "Unknown";
  return new Date(iso).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  });
}

/** Relative time for the "last updated" line, where recency is the point. */
export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return "never";
  const diff = Date.now() - new Date(iso).getTime();
  const units: [number, Intl.RelativeTimeFormatUnit][] = [
    [31_536_000_000, "year"],
    [2_592_000_000, "month"],
    [604_800_000, "week"],
    [86_400_000, "day"],
    [3_600_000, "hour"],
    [60_000, "minute"],
  ];
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  for (const [ms, unit] of units) {
    if (Math.abs(diff) >= ms) return rtf.format(-Math.round(diff / ms), unit);
  }
  return "just now";
}

export function formatBytes(bytes: number): string {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exp;
  return `${value.toFixed(value >= 100 || exp === 0 ? 0 : 1)} ${units[exp]}`;
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-GB").format(value);
}

export function formatPercent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

/** Tailwind classes per severity, kept in one place. */
export const severityStyles: Record<ModlogSeverity, { dot: string; text: string; border: string; bg: string }> = {
  info: { dot: "bg-sev-info", text: "text-sev-info", border: "border-sev-info/30", bg: "bg-sev-info/10" },
  low: { dot: "bg-sev-low", text: "text-sev-low", border: "border-sev-low/30", bg: "bg-sev-low/10" },
  medium: {
    dot: "bg-sev-medium",
    text: "text-sev-medium",
    border: "border-sev-medium/30",
    bg: "bg-sev-medium/10",
  },
  high: { dot: "bg-sev-high", text: "text-sev-high", border: "border-sev-high/30", bg: "bg-sev-high/10" },
  critical: {
    dot: "bg-sev-critical",
    text: "text-sev-critical",
    border: "border-sev-critical/40",
    bg: "bg-sev-critical/10",
  },
};

/** Join class names, dropping falsy entries. */
export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

/** Shorten a URL for display without losing what it points at. */
export function prettyUrl(raw: string, max = 56): string {
  try {
    const url = new URL(raw);
    const shown = `${url.hostname.replace(/^www\./, "")}${url.pathname === "/" ? "" : url.pathname}`;
    return shown.length > max ? `${shown.slice(0, max - 1)}…` : shown;
  } catch {
    return raw.slice(0, max);
  }
}
