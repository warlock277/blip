/**
 * Per-site history store.
 *
 * Persists a rolling window of raw `HistoryPoint`s (capped at
 * `maxHistoryPoints`) plus one `DailyRollup` per UTC day for long-range graphs.
 * Also derives the aggregate stats the summary needs: uptime ratios over
 * 24h/7d/30d/90d windows, average response time over 24h, and a compact
 * ~45-bucket sparkline.
 *
 * Uptime math: each point contributes its STATUS_WEIGHT (up=1, degraded=0.5,
 * down=0). The window ratio is the mean weight of points whose timestamp falls
 * inside the window. For windows longer than the raw retention, we fall back to
 * the daily rollups so long-range numbers survive point pruning.
 */

import { join } from "node:path";
import {
  STATUS_WEIGHT,
  type CheckResult,
  type DailyRollup,
  type HistoryPoint,
  type SiteHistory,
  type Status,
} from "@blip/shared";
import { readJson, writeJson } from "../util/fs.js";
import { dayKey } from "../util/time.js";

const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_DAY = 24 * MS_PER_HOUR;
const SPARK_BUCKETS = 45;

export function historyPath(dataDir: string, siteId: string): string {
  return join(dataDir, "history", `${siteId}.json`);
}

export async function readHistory(dataDir: string, siteId: string): Promise<SiteHistory> {
  const fallback: SiteHistory = { id: siteId, points: [], daily: [] };
  const loaded = await readJson<SiteHistory>(historyPath(dataDir, siteId), fallback);
  // Defensive: ensure arrays exist even if the file was partially valid.
  return {
    id: loaded.id || siteId,
    points: Array.isArray(loaded.points) ? loaded.points : [],
    daily: Array.isArray(loaded.daily) ? loaded.daily : [],
  };
}

export async function writeHistory(dataDir: string, history: SiteHistory): Promise<void> {
  await writeJson(historyPath(dataDir, history.id), history);
}

/** Build a `HistoryPoint` from a check result. */
export function pointFromResult(r: CheckResult): HistoryPoint {
  const p: HistoryPoint = { t: r.checkedAt, s: r.status, ms: r.responseTime };
  if (r.httpStatus !== undefined) p.c = r.httpStatus;
  if (r.error !== undefined && r.status !== "up") p.e = r.error;
  return p;
}

/**
 * Append a point to the history, refreshing the daily rollup for that point's
 * UTC day, and capping raw points to `maxHistoryPoints`. Returns a new object
 * (does not mutate the input).
 */
export function appendPoint(
  history: SiteHistory,
  point: HistoryPoint,
  maxHistoryPoints: number,
): SiteHistory {
  const points = [...history.points, point];
  // Cap from the front (drop oldest) so the newest data is preserved.
  const capped = points.length > maxHistoryPoints ? points.slice(points.length - maxHistoryPoints) : points;

  const daily = upsertDaily(history.daily, point);

  return { id: history.id, points: capped, daily };
}

/** Insert/update the daily rollup for the point's day, keeping daily sorted oldest→newest. */
function upsertDaily(daily: DailyRollup[], point: HistoryPoint): DailyRollup[] {
  const day = dayKey(point.t);
  const out = daily.map((d) => ({ ...d }));
  let entry = out.find((d) => d.d === day);
  if (!entry) {
    entry = { d: day, up: 0, down: 0, degraded: 0, total: 0, uptime: 0, avgMs: null };
    out.push(entry);
    out.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
  }

  // Incrementally fold this point in. We track a running response-time average
  // by reconstructing the prior sum from avgMs * (#timed responses so far).
  // To keep that exact we store enough info: we recompute avg using a counter.
  const priorTimed = entry.avgMs === null ? 0 : countTimed(entry);
  const priorSum = entry.avgMs === null ? 0 : entry.avgMs * priorTimed;

  entry.total += 1;
  if (point.s === "up") entry.up += 1;
  else if (point.s === "down") entry.down += 1;
  else entry.degraded += 1;

  const weightSum = entry.up * 1 + entry.degraded * 0.5;
  entry.uptime = entry.total > 0 ? weightSum / entry.total : 0;

  if (point.ms !== null) {
    const newCount = priorTimed + 1;
    entry.avgMs = Math.round((priorSum + point.ms) / newCount);
  }

  return out;
}

/** Estimate how many timed responses contributed to a rollup's avgMs (up + degraded). */
function countTimed(entry: DailyRollup): number {
  // avgMs is only over responses that returned a time; down points are null.
  // We approximate the timed count as up + degraded (down rarely returns a time).
  return entry.up + entry.degraded;
}

/** Mean STATUS_WEIGHT of points within `windowMs` of `now`. Null when no points. */
function uptimeFromPoints(points: HistoryPoint[], windowMs: number, now: number): number | null {
  const since = now - windowMs;
  let sum = 0;
  let count = 0;
  for (const p of points) {
    const t = Date.parse(p.t);
    if (Number.isNaN(t) || t < since) continue;
    sum += STATUS_WEIGHT[p.s];
    count += 1;
  }
  return count > 0 ? sum / count : null;
}

/** Mean uptime from daily rollups within the last `days` days. Null when none. */
function uptimeFromDaily(daily: DailyRollup[], days: number, now: number): number | null {
  const sinceDay = dayKey(now - days * MS_PER_DAY);
  let weight = 0;
  let total = 0;
  for (const d of daily) {
    if (d.d < sinceDay) continue;
    weight += d.up * 1 + d.degraded * 0.5;
    total += d.total;
  }
  return total > 0 ? weight / total : null;
}

/**
 * Uptime ratio for a window. Prefer raw points (more precise/recent); fall back
 * to daily rollups for long windows where points have been pruned. Returns 1
 * (treated as "no data = healthy") when neither source has data, so a brand-new
 * site doesn't show 0% uptime.
 */
function uptimeWindow(history: SiteHistory, windowMs: number, now: number): number {
  const fromPoints = uptimeFromPoints(history.points, windowMs, now);
  const days = Math.round(windowMs / MS_PER_DAY);
  const fromDaily = uptimeFromDaily(history.daily, days, now);
  // If the window extends beyond raw retention, daily is more complete.
  const oldestPoint = history.points.length > 0 ? Date.parse(history.points[0]!.t) : now;
  const pointsCoverWindow = oldestPoint <= now - windowMs;

  if (pointsCoverWindow && fromPoints !== null) return fromPoints;
  if (fromDaily !== null) return fromDaily;
  if (fromPoints !== null) return fromPoints;
  return 1;
}

export interface HistoryStats {
  uptime24h: number;
  uptime7d: number;
  uptime30d: number;
  uptime90d: number;
  avgResponse24h: number | null;
  spark: Status[];
}

/** Average response time (ms) over the last 24h from raw points. */
function avgResponse24h(points: HistoryPoint[], now: number): number | null {
  const since = now - MS_PER_DAY;
  let sum = 0;
  let count = 0;
  for (const p of points) {
    if (p.ms === null) continue;
    const t = Date.parse(p.t);
    if (Number.isNaN(t) || t < since) continue;
    sum += p.ms;
    count += 1;
  }
  return count > 0 ? Math.round(sum / count) : null;
}

/**
 * Build a ~45-element sparkline (newest last) summarizing recent status. We
 * take the most recent points and bucket them so the array length is stable
 * regardless of how many points exist; each bucket's status is the worst
 * status within it (down > degraded > up) to surface outages.
 */
export function buildSpark(points: HistoryPoint[], buckets = SPARK_BUCKETS): Status[] {
  if (points.length === 0) return [];
  // Use at most the last (buckets * some factor) points so old data doesn't
  // dominate; here we simply bucket across all available points.
  const n = points.length;
  const size = Math.ceil(n / buckets);
  const out: Status[] = [];
  for (let start = 0; start < n; start += size) {
    const slice = points.slice(start, start + size);
    out.push(worstStatus(slice));
  }
  // Keep only the last `buckets` entries (newest).
  return out.slice(Math.max(0, out.length - buckets));
}

function worstStatus(points: HistoryPoint[]): Status {
  let worst: Status = "up";
  for (const p of points) {
    if (p.s === "down") return "down";
    if (p.s === "degraded") worst = "degraded";
  }
  return worst;
}

/** Compute all summary-facing stats for a site's history. */
export function computeStats(history: SiteHistory, now: number = Date.now()): HistoryStats {
  return {
    uptime24h: uptimeWindow(history, MS_PER_DAY, now),
    uptime7d: uptimeWindow(history, 7 * MS_PER_DAY, now),
    uptime30d: uptimeWindow(history, 30 * MS_PER_DAY, now),
    uptime90d: uptimeWindow(history, 90 * MS_PER_DAY, now),
    avgResponse24h: avgResponse24h(history.points, now),
    spark: buildSpark(history.points),
  };
}

/** Prune daily rollups older than `keepDays` to bound file growth. */
export function pruneDaily(history: SiteHistory, keepDays = 400, now: number = Date.now()): SiteHistory {
  const cutoff = dayKey(now - keepDays * MS_PER_DAY);
  return { ...history, daily: history.daily.filter((d) => d.d >= cutoff) };
}
