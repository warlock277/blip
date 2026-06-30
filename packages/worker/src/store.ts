/**
 * D1 storage helpers over the `points` + `kv` tables (see schema.sql).
 *
 *   points : raw history (one row per check). t = epoch ms.
 *   kv     : JSON docs — `state`, `incidents`, and precomputed blobs.
 *
 * Uptime math mirrors the engine: each point contributes STATUS_WEIGHT
 * (up=1, degraded=0.5, down=0); a window ratio is the mean weight of points
 * inside it. Computed in JS from fetched rows.
 */

import { STATUS_WEIGHT, type DailyRollup, type HistoryPoint, type Status } from "@blip/shared";
import { dayKey, MS_PER_DAY } from "./time.js";

/** Raw point passed to appendPoint (epoch-ms timestamped, D1-row shaped). */
export interface PointInput {
  t: number;
  s: Status;
  ms: number | null;
  c?: number | undefined;
  e?: string | undefined;
}

interface PointRow {
  t: number;
  s: string;
  ms: number | null;
  c: number | null;
  e: string | null;
}

function asStatus(s: string): Status {
  return s === "down" || s === "degraded" ? s : "up";
}

// ---------------------------------------------------------------------------
// kv
// ---------------------------------------------------------------------------

export async function getKv<T>(db: D1Database, key: string): Promise<T | null> {
  const row = await db.prepare("SELECT v FROM kv WHERE k = ?").bind(key).first<{ v: string }>();
  if (!row) return null;
  try {
    return JSON.parse(row.v) as T;
  } catch {
    return null;
  }
}

export async function setKv(db: D1Database, key: string, value: unknown): Promise<void> {
  await db
    .prepare("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v")
    .bind(key, JSON.stringify(value))
    .run();
}

// ---------------------------------------------------------------------------
// points
// ---------------------------------------------------------------------------

export async function appendPoint(db: D1Database, siteId: string, point: PointInput): Promise<void> {
  await db
    .prepare("INSERT INTO points (site_id, t, s, ms, c, e) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(siteId, point.t, point.s, point.ms, point.c ?? null, point.e ?? null)
    .run();
}

/** Drop raw points older than `beforeMs` (90-day retention). */
export async function prunePoints(db: D1Database, beforeMs: number): Promise<void> {
  await db.prepare("DELETE FROM points WHERE t < ?").bind(beforeMs).run();
}

async function rowsSince(db: D1Database, siteId: string, sinceMs: number): Promise<PointRow[]> {
  const res = await db
    .prepare("SELECT t, s, ms, c, e FROM points WHERE site_id = ? AND t >= ? ORDER BY t ASC")
    .bind(siteId, sinceMs)
    .all<PointRow>();
  return res.results ?? [];
}

/** Uptime ratio (STATUS_WEIGHT mean) + avg response over a window. */
export async function windowStats(
  db: D1Database,
  siteId: string,
  sinceMs: number,
): Promise<{ uptime: number; avgMs: number | null }> {
  const rows = await rowsSince(db, siteId, sinceMs);
  if (rows.length === 0) {
    // No data → treat as healthy so a brand-new site isn't shown as 0%.
    return { uptime: 1, avgMs: null };
  }
  let weight = 0;
  let msSum = 0;
  let msCount = 0;
  for (const r of rows) {
    weight += STATUS_WEIGHT[asStatus(r.s)];
    if (r.ms !== null) {
      msSum += r.ms;
      msCount += 1;
    }
  }
  return {
    uptime: weight / rows.length,
    avgMs: msCount > 0 ? Math.round(msSum / msCount) : null,
  };
}

/** Latest `n` statuses (newest last) for the sparkline. */
export async function recentSpark(db: D1Database, siteId: string, n = 45): Promise<Status[]> {
  const res = await db
    .prepare("SELECT s FROM points WHERE site_id = ? ORDER BY t DESC LIMIT ?")
    .bind(siteId, n)
    .all<{ s: string }>();
  const rows = res.results ?? [];
  // Fetched newest-first; reverse to newest-last for the bar.
  return rows.map((r) => asStatus(r.s)).reverse();
}

/** HistoryPoint[] for a site since `sinceMs` (oldest → newest). */
export async function pointsSince(
  db: D1Database,
  siteId: string,
  sinceMs: number,
): Promise<HistoryPoint[]> {
  const rows = await rowsSince(db, siteId, sinceMs);
  return rows.map((r) => {
    const p: HistoryPoint = { t: new Date(r.t).toISOString(), s: asStatus(r.s), ms: r.ms };
    if (r.c !== null) p.c = r.c;
    if (r.e !== null && p.s !== "up") p.e = r.e;
    return p;
  });
}

/** Daily rollups aggregated by UTC day over the last `days` days (oldest→newest). */
export async function dailyRollups(db: D1Database, siteId: string, days = 90): Promise<DailyRollup[]> {
  const sinceMs = Date.now() - days * MS_PER_DAY;
  const rows = await rowsSince(db, siteId, sinceMs);
  const byDay = new Map<string, DailyRollup>();
  // Track response-time sums separately so avgMs is exact.
  const msAgg = new Map<string, { sum: number; count: number }>();

  for (const r of rows) {
    const day = dayKey(r.t);
    let entry = byDay.get(day);
    if (!entry) {
      entry = { d: day, up: 0, down: 0, degraded: 0, total: 0, uptime: 0, avgMs: null };
      byDay.set(day, entry);
      msAgg.set(day, { sum: 0, count: 0 });
    }
    const status = asStatus(r.s);
    entry.total += 1;
    if (status === "up") entry.up += 1;
    else if (status === "down") entry.down += 1;
    else entry.degraded += 1;
    if (r.ms !== null) {
      const agg = msAgg.get(day)!;
      agg.sum += r.ms;
      agg.count += 1;
    }
  }

  const out: DailyRollup[] = [];
  for (const [day, entry] of byDay) {
    const weightSum = entry.up * 1 + entry.degraded * 0.5;
    entry.uptime = entry.total > 0 ? weightSum / entry.total : 0;
    const agg = msAgg.get(day)!;
    entry.avgMs = agg.count > 0 ? Math.round(agg.sum / agg.count) : null;
    out.push(entry);
  }
  out.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
  return out;
}
