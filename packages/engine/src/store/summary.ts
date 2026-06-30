/**
 * Summary builder — assembles `data/summary.json`, the dashboard's primary
 * fetch. Combines config (brand/groups), the latest check results, computed
 * history stats, and current incidents into per-site, per-group, and overall
 * rollups.
 */

import { join } from "node:path";
import {
  overallStatus,
  type BrandConfig,
  type CheckResult,
  type GroupSummary,
  type Incident,
  type SiteHistory,
  type SiteSummary,
  type Status,
  type Summary,
  type SummaryTotals,
} from "@pulse/shared";
import { writeJson } from "../util/fs.js";
import { computeStats } from "./history.js";
import type { ResolvedConfig, ResolvedSite } from "../config.js";
import { iso } from "../util/time.js";

export function summaryPath(dataDir: string): string {
  return join(dataDir, "summary.json");
}

export interface BuildSummaryInput {
  config: ResolvedConfig;
  results: Map<string, CheckResult>;
  histories: Map<string, SiteHistory>;
  incidents: Incident[];
  now?: number;
}

function buildSiteSummary(
  site: ResolvedSite,
  result: CheckResult | undefined,
  history: SiteHistory | undefined,
  now: number,
): SiteSummary {
  const stats = history
    ? computeStats(history, now)
    : { uptime24h: 1, uptime7d: 1, uptime30d: 1, uptime90d: 1, avgResponse24h: null, spark: [] as Status[] };

  const status: Status = site.paused ? "up" : result?.status ?? "down";

  const summary: SiteSummary = {
    id: site.id,
    name: site.name,
    url: site.url,
    public: site.public,
    status,
    responseTime: result?.responseTime ?? null,
    lastChecked: result?.checkedAt ?? iso(now),
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
  if (result?.httpStatus !== undefined) summary.httpStatus = result.httpStatus;
  // Don't surface the synthetic "paused" error.
  if (result?.error && result.error !== "paused") summary.error = result.error;
  if (result?.ssl) summary.ssl = result.ssl;
  if (result?.domain) summary.domain = result.domain;

  return summary;
}

export function buildSummary(input: BuildSummaryInput): Summary {
  const now = input.now ?? Date.now();
  const { config } = input;

  const siteSummaries: SiteSummary[] = config.sites.map((site) =>
    buildSiteSummary(site, input.results.get(site.id), input.histories.get(site.id), now),
  );

  // ---- totals (paused sites excluded from up/down/degraded tallies) ----
  const totals: SummaryTotals = { sites: siteSummaries.length, up: 0, down: 0, degraded: 0, paused: 0, uptime: 0 };
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
  const groups: GroupSummary[] = (config.groups ?? []).map((g) => {
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

  // ---- overall banner (over non-paused sites) ----
  const overall = overallStatus(siteSummaries.filter((s) => !s.paused).map((s) => s.status));

  const brand: BrandConfig = config.config.brand ?? {};

  return {
    generatedAt: iso(now),
    brand,
    overall,
    totals,
    groups,
    sites: siteSummaries,
    // incidents already newest-first from reconciliation.
    incidents: input.incidents,
  };
}

export async function writeSummary(dataDir: string, summary: Summary): Promise<void> {
  await writeJson(summaryPath(dataDir), summary);
}
