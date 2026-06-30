/** Shared defaults + small pure helpers used by both engine and dashboard. */

import type { EngineDefaults, Status, OverallStatus } from "./types.js";

export const DEFAULTS: Required<EngineDefaults> = {
  timeoutMs: 10_000,
  retries: 2,
  degradedThresholdMs: 2_000,
  maxHistoryPoints: 2_016, // ~7 days at 5-minute interval
  sslWarnDays: 30,
  domainWarnDays: [30, 15, 7],
  userAgent: "Pulse/0.1 (+https://github.com/pulse/pulse)",
};

/** Default acceptable HTTP status range when none is specified. */
export const DEFAULT_OK_STATUS_MIN = 200;
export const DEFAULT_OK_STATUS_MAX = 399;

/** Status → numeric weight for sparkline / uptime math (up = healthy). */
export const STATUS_WEIGHT: Record<Status, number> = {
  up: 1,
  degraded: 0.5,
  down: 0,
};

/** Convert an arbitrary name into a stable, filename-safe slug. */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "site";
}

/** Roll a set of site statuses up into a single status-page banner level. */
export function overallStatus(statuses: Status[]): OverallStatus {
  if (statuses.length === 0) return "operational";
  const down = statuses.filter((s) => s === "down").length;
  const degraded = statuses.filter((s) => s === "degraded").length;
  if (down === 0 && degraded === 0) return "operational";
  if (down >= statuses.length) return "major_outage";
  if (down > 0) return "partial_outage";
  return "degraded";
}

/** Human label for an overall status. */
export const OVERALL_LABEL: Record<OverallStatus, string> = {
  operational: "All systems operational",
  degraded: "Degraded performance",
  partial_outage: "Partial outage",
  major_outage: "Major outage",
};
