/**
 * Summary + per-site history builders.
 *
 * Produce byte-shape-compatible `SiteHistory` and `Summary` documents (see
 * @pulse/shared) from the D1 `points` table + the cached SSL/domain/status in
 * `state`, so the existing dashboard renders unchanged.
 */

import {
  overallStatus,
  type BrandConfig,
  type GroupSummary,
  type Incident,
  type SiteHistory,
  type SiteSummary,
  type Status,
  type Summary,
  type SummaryTotals,
} from "@pulse/shared";
import type { ResolvedConfig, ResolvedSite } from "./config-types.js";
import type { WorkerState } from "./state.js";
import {
  dailyRollups,
  pointsSince,
  recentSpark,
  windowStats,
} from "./store.js";
import { iso, MS_PER_DAY } from "./time.js";

/**
 * Per-site history blob: raw points for the last 7 days + 90-day daily rollups.
 * Mirrors the engine's history file (points capped at ~7d, daily for long-range).
 */
export async function buildSiteHistory(
  db: D1Database,
  site: ResolvedSite,
  now: number = Date.now(),
): Promise<SiteHistory> {
  const points = await pointsSince(db, site.id, now - 7 * MS_PER_DAY);
  const daily = await dailyRollups(db, site.id, 90);
  return { id: site.id, points, daily };
}

interface SiteStatsResult {
  uptime24h: number;
  uptime7d: number;
  uptime30d: number;
  uptime90d: number;
  avgResponse24h: number | null;
  spark: Status[];
}

async function siteStats(db: D1Database, siteId: string, now: number): Promise<SiteStatsResult> {
  const [w24, w7, w30, w90, spark] = await Promise.all([
    windowStats(db, siteId, now - MS_PER_DAY),
    windowStats(db, siteId, now - 7 * MS_PER_DAY),
    windowStats(db, siteId, now - 30 * MS_PER_DAY),
    windowStats(db, siteId, now - 90 * MS_PER_DAY),
    recentSpark(db, siteId, 45),
  ]);
  return {
    uptime24h: w24.uptime,
    uptime7d: w7.uptime,
    uptime30d: w30.uptime,
    uptime90d: w90.uptime,
    avgResponse24h: w24.avgMs,
    spark,
  };
}

async function buildSiteSummary(
  db: D1Database,
  site: ResolvedSite,
  state: WorkerState,
  now: number,
): Promise<SiteSummary> {
  const ss = state.sites[site.id];
  const stats = site.paused
    ? { uptime24h: 1, uptime7d: 1, uptime30d: 1, uptime90d: 1, avgResponse24h: null, spark: [] as Status[] }
    : await siteStats(db, site.id, now);

  const status: Status = site.paused ? "up" : ss?.lastStatus ?? "down";

  const summary: SiteSummary = {
    id: site.id,
    name: site.name,
    url: site.url,
    public: site.public,
    status,
    responseTime: ss?.responseTime ?? null,
    lastChecked: ss?.lastChecked ?? iso(now),
    uptime24h: stats.uptime24h,
    uptime7d: stats.uptime7d,
    uptime30d: stats.uptime30d,
    uptime90d: stats.uptime90d,
    avgResponse24h: stats.avgResponse24h,
    spark: stats.spark,
  };

  if (site.group) summary.group = site.group;
  if (site.description) summary.description = site.description;
  if (site.tags) summary.tags = site.tags;
  if (site.paused) summary.paused = true;
  if (ss?.httpStatus !== undefined) summary.httpStatus = ss.httpStatus;
  if (ss?.error && ss.error !== "paused") summary.error = ss.error;
  if (ss?.ssl) summary.ssl = ss.ssl;
  if (ss?.domain) summary.domain = ss.domain;

  return summary;
}

export async function buildSummary(
  db: D1Database,
  config: ResolvedConfig,
  state: WorkerState,
  incidents: Incident[],
  now: number = Date.now(),
): Promise<Summary> {
  const siteSummaries: SiteSummary[] = [];
  for (const site of config.sites) {
    siteSummaries.push(await buildSiteSummary(db, site, state, now));
  }

  // ---- totals (paused sites excluded from up/down/degraded tallies) ----
  const totals: SummaryTotals = {
    sites: siteSummaries.length,
    up: 0,
    down: 0,
    degraded: 0,
    paused: 0,
    uptime: 0,
  };
  let uptimeSum = 0;
  let uptimeCount = 0;
  for (const s of siteSummaries) {
    if (s.paused) {
      totals.paused += 1;
      continue;
    }
    if (s.status === "up") totals.up += 1;
    else if (s.status === "down") totals.down += 1;
    else totals.degraded += 1;
    uptimeSum += s.uptime24h;
    uptimeCount += 1;
  }
  totals.uptime = uptimeCount > 0 ? uptimeSum / uptimeCount : 1;

  // ---- groups ----
  const summaryById = new Map(siteSummaries.map((s) => [s.id, s]));
  const groups: GroupSummary[] = config.groups.map((g) => {
    const memberIds = config.sites.filter((s) => s.group === g.id).map((s) => s.id);
    const statuses = memberIds
      .map((id) => summaryById.get(id))
      .filter((s): s is SiteSummary => s !== undefined && !s.paused)
      .map((s) => s.status);
    const gs: GroupSummary = {
      id: g.id,
      name: g.name,
      status: overallStatus(statuses),
      siteIds: memberIds,
    };
    if (g.description) gs.description = g.description;
    if (g.icon) gs.icon = g.icon;
    return gs;
  });

  const overall = overallStatus(siteSummaries.filter((s) => !s.paused).map((s) => s.status));
  const brand: BrandConfig = config.brand ?? {};

  return {
    generatedAt: iso(now),
    brand,
    overall,
    totals,
    groups,
    sites: siteSummaries,
    incidents,
  };
}
