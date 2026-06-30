/** Small time helpers — all UTC, all pure. Mirrors engine/src/util/time.ts. */

export const MS_PER_HOUR = 60 * 60 * 1000;
export const MS_PER_DAY = 24 * MS_PER_HOUR;

/** Current (or given) instant as an ISO-8601 string. */
export function iso(date: Date | number = Date.now()): string {
  return new Date(date).toISOString();
}

/** UTC day key in `YYYY-MM-DD` form. */
export function dayKey(date: Date | number | string = Date.now()): string {
  return new Date(date).toISOString().slice(0, 10);
}

/** Days remaining from `from` until `target` (negative if past). Floor, UTC. */
export function daysUntil(target: Date | number | string, from: number = Date.now()): number {
  const t = new Date(target).getTime();
  return Math.floor((t - from) / MS_PER_DAY);
}

/** Milliseconds elapsed since `since` until `until`. */
export function elapsedMs(since: Date | number | string, until: number = Date.now()): number {
  return until - new Date(since).getTime();
}
