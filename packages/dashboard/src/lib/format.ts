import { formatDistanceToNowStrict, format, formatDuration, intervalToDuration } from "date-fns";
import type { Status, OverallStatus, SiteSummary } from "@blip/shared";

// ---------------------------------------------------------------------------
// Status presentation maps
// ---------------------------------------------------------------------------

export type DisplayStatus = Status | "paused";

/** Resolve the status we actually render for a site (paused beats raw status). */
export function siteDisplayStatus(site: Pick<SiteSummary, "status" | "paused">): DisplayStatus {
  return site.paused ? "paused" : site.status;
}

export const STATUS_LABEL: Record<DisplayStatus, string> = {
  up: "Operational",
  degraded: "Degraded",
  down: "Down",
  paused: "Paused",
};

/** Tailwind text color class per status. */
export const STATUS_TEXT: Record<DisplayStatus, string> = {
  up: "text-up",
  degraded: "text-degraded",
  down: "text-down",
  paused: "text-paused",
};

/** Tailwind solid background class per status (for dots / bars). */
export const STATUS_BG: Record<DisplayStatus, string> = {
  up: "bg-up",
  degraded: "bg-degraded",
  down: "bg-down",
  paused: "bg-paused",
};

/** Soft badge background + text per status. */
export const STATUS_SOFT: Record<DisplayStatus, string> = {
  up: "bg-up-soft text-up",
  degraded: "bg-degraded-soft text-degraded",
  down: "bg-down-soft text-down",
  paused: "bg-paused-soft text-paused",
};

export const OVERALL_TEXT: Record<OverallStatus, string> = {
  operational: "text-up",
  degraded: "text-degraded",
  partial_outage: "text-degraded",
  major_outage: "text-down",
};

export const OVERALL_DISPLAY_STATUS: Record<OverallStatus, DisplayStatus> = {
  operational: "up",
  degraded: "degraded",
  partial_outage: "degraded",
  major_outage: "down",
};

// ---------------------------------------------------------------------------
// Numbers & ratios
// ---------------------------------------------------------------------------

/** Format an uptime ratio (0–1) as a percentage string. */
export function uptimePct(ratio: number | null | undefined, digits = 2): string {
  if (ratio == null || Number.isNaN(ratio)) return "—";
  const pct = ratio * 100;
  // Avoid showing "100.00%" for anything < 100; round down near-perfect values.
  const value = pct >= 100 ? 100 : pct;
  return `${value.toFixed(digits)}%`;
}

/** Color class for an uptime ratio, SLA-style thresholds. */
export function uptimeColor(ratio: number | null | undefined): string {
  if (ratio == null) return "text-muted-foreground";
  if (ratio >= 0.999) return "text-up";
  if (ratio >= 0.99) return "text-degraded";
  return "text-down";
}

/** Format a response time in ms. */
export function responseMs(ms: number | null | undefined): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

/** "3 minutes ago" — safe against bad/empty dates. */
export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${formatDistanceToNowStrict(d)} ago`;
}

/** Absolute, human date-time. */
export function dateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return format(d, "MMM d, yyyy HH:mm");
}

/** Short date for chart axes / tooltips. */
export function shortDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return format(d, "MMM d");
}

/** Compact clock label (e.g. "14:05") for intraday axes. */
export function clockLabel(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return format(d, "HH:mm");
}

/** Humanize a duration in ms (e.g. "1h 12m"). */
export function durationLabel(ms: number | null | undefined): string {
  if (ms == null || ms <= 0) return "—";
  const dur = intervalToDuration({ start: 0, end: ms });
  const text = formatDuration(dur, {
    format: ["days", "hours", "minutes", "seconds"],
    delimiter: " ",
  });
  // Compact: "2 hours 3 minutes" -> "2h 3m".
  return (
    text
      .replace(/ days?/, "d")
      .replace(/ hours?/, "h")
      .replace(/ minutes?/, "m")
      .replace(/ seconds?/, "s") || "—"
  );
}

// ---------------------------------------------------------------------------
// SSL / domain expiry chips
// ---------------------------------------------------------------------------

export interface ExpiryChip {
  label: string;
  /** Tailwind classes for the chip. */
  tone: string;
  expiringSoon: boolean;
}

/** Build a chip for an N-day expiry (SSL cert or domain registration). */
export function expiryChip(daysRemaining: number, expiringSoon: boolean): ExpiryChip {
  let tone: string;
  if (daysRemaining <= 0) {
    tone = "bg-down-soft text-down";
  } else if (expiringSoon || daysRemaining <= 14) {
    tone = "bg-degraded-soft text-degraded";
  } else {
    tone = "bg-secondary text-muted-foreground";
  }
  const label =
    daysRemaining <= 0 ? "Expired" : `${daysRemaining}d`;
  return { label, tone, expiringSoon: expiringSoon || daysRemaining <= 14 };
}

// ---------------------------------------------------------------------------
// Incident type badges
// ---------------------------------------------------------------------------

export const INCIDENT_TYPE_LABEL: Record<string, string> = {
  down: "Outage",
  degraded: "Degraded",
  ssl_expiring: "SSL expiring",
  domain_expiring: "Domain expiring",
};

export const INCIDENT_TYPE_TONE: Record<string, string> = {
  down: "bg-down-soft text-down",
  degraded: "bg-degraded-soft text-degraded",
  ssl_expiring: "bg-degraded-soft text-degraded",
  domain_expiring: "bg-degraded-soft text-degraded",
};
