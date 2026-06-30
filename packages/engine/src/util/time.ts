/** Small time helpers — all UTC, all pure. */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Current (or given) instant as an ISO-8601 string. */
export function iso(date: Date | number = Date.now()): string {
  return new Date(date).toISOString();
}

/** UTC day key in `YYYY-MM-DD` form. */
export function dayKey(date: Date | number | string = Date.now()): string {
  const d = typeof date === "string" ? new Date(date) : new Date(date);
  // toISOString() is always UTC; slice off the date portion.
  const part = d.toISOString().slice(0, 10);
  return part;
}

/** Whole-day difference `a - b` (positive when `a` is later), based on UTC midnight. */
export function dayDiff(a: Date | number | string, b: Date | number | string): number {
  const ta = new Date(a).getTime();
  const tb = new Date(b).getTime();
  return Math.floor((ta - tb) / MS_PER_DAY);
}

/** Days remaining from now until the given target date (can be negative if past). */
export function daysUntil(target: Date | number | string, from: number = Date.now()): number {
  const t = new Date(target).getTime();
  return Math.floor((t - from) / MS_PER_DAY);
}

/** Milliseconds since `since` until now. */
export function elapsedMs(since: Date | number | string, until: number = Date.now()): number {
  return until - new Date(since).getTime();
}

/** Human-friendly duration like `12m`, `3h 4m`, `2d 1h`. */
export function humanizeMs(ms: number): string {
  if (ms < 0) ms = 0;
  const totalSec = Math.floor(ms / 1000);
  const days = Math.floor(totalSec / 86_400);
  const hours = Math.floor((totalSec % 86_400) / 3_600);
  const mins = Math.floor((totalSec % 3_600) / 60);
  const secs = totalSec % 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  if (mins > 0) return `${mins}m`;
  return `${secs}s`;
}

export { MS_PER_DAY };
