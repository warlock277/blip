/**
 * Incident reconciliation.
 *
 * Given the current check results and the previous engine state, this opens new
 * incidents on a status transition into an unhealthy state (up→down, →degraded,
 * ssl/domain expiring) and resolves them on recovery. State invariants:
 *   - At most one OPEN incident per (siteId, incidentType).
 *   - Incidents are stored newest-first.
 *   - Resolved incidents older than ~90 days are pruned.
 *
 * It returns the updated incident list plus the events to feed notifications,
 * and mutates the per-site state's `openIncidents` / `downSince` bookkeeping.
 */

import { join } from "node:path";
import type {
  CheckResult,
  Incident,
  IncidentType,
  Status,
} from "@blip/shared";
import { readJson, writeJson } from "../util/fs.js";
import type { ResolvedSite } from "../config.js";
import type { EngineState, SiteState } from "./state.js";
import type { EngineEvent } from "../events.js";
import { iso, elapsedMs } from "../util/time.js";

const RESOLVED_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export function incidentsPath(dataDir: string): string {
  return join(dataDir, "incidents.json");
}

export async function readIncidents(dataDir: string): Promise<Incident[]> {
  const loaded = await readJson<Incident[]>(incidentsPath(dataDir), []);
  return Array.isArray(loaded) ? loaded : [];
}

export async function writeIncidents(dataDir: string, incidents: Incident[]): Promise<void> {
  await writeJson(incidentsPath(dataDir), incidents);
}

function newIncidentId(siteId: string, type: IncidentType, at: number): string {
  return `${siteId}-${type}-${at}`;
}

interface ReconcileInput {
  sites: ResolvedSite[];
  results: Map<string, CheckResult>;
  incidents: Incident[];
  state: EngineState;
  now?: number;
}

export interface ReconcileOutput {
  incidents: Incident[];
  events: EngineEvent[];
}

function siteStateFor(state: EngineState, siteId: string): SiteState {
  const existing = state.sites[siteId];
  if (existing) return existing;
  const fresh: SiteState = {};
  state.sites[siteId] = fresh;
  return fresh;
}

function findOpen(incidents: Incident[], siteId: string, type: IncidentType): Incident | undefined {
  return incidents.find((i) => i.siteId === siteId && i.type === type && i.state === "open");
}

/** Map a check status to its incident type (down vs degraded). */
function incidentTypeForStatus(status: Status): IncidentType | null {
  if (status === "down") return "down";
  if (status === "degraded") return "degraded";
  return null;
}

/**
 * Reconcile incidents against the latest results.
 * Mutates `state.sites[*]` (downSince, openIncidents) as a side effect.
 */
export function reconcileIncidents(input: ReconcileInput): ReconcileOutput {
  const now = input.now ?? Date.now();
  const nowIso = iso(now);
  // Work on a copy so the caller can decide whether to persist.
  let incidents = input.incidents.map((i) => ({ ...i }));
  const events: EngineEvent[] = [];

  for (const site of input.sites) {
    if (site.paused) continue;
    const result = input.results.get(site.id);
    if (!result) continue;

    const ss = siteStateFor(input.state, site.id);
    const prevStatus = ss.lastStatus;
    const status = result.status;

    // ---- availability transitions (down / degraded) ----
    const curType = incidentTypeForStatus(status);

    // Resolve any open availability incidents whose condition no longer holds.
    for (const t of ["down", "degraded"] as IncidentType[]) {
      const open = findOpen(incidents, site.id, t);
      if (!open) continue;
      const stillFailing = curType === t;
      if (!stillFailing) {
        // Recovery (or transitioned to a different failure handled below).
        open.state = "resolved";
        open.resolvedAt = nowIso;
        open.durationMs = elapsedMs(open.startedAt, now);
        open.updates = [...(open.updates ?? []), { at: nowIso, message: "Recovered" }];
        if (ss.openIncidents) delete ss.openIncidents[t];
        // Emit an "up" recovery event only when fully recovered to up.
        if (status === "up" && t === "down") {
          events.push({
            type: "up",
            siteId: site.id,
            siteName: site.name,
            url: site.url,
            ...(site.group ? { group: site.group } : {}),
            status: "up",
            detail: "Recovered",
            ...(open.startedAt ? { since: open.startedAt } : {}),
            durationMs: open.durationMs,
            ...(site.notify ? { notify: site.notify } : {}),
            at: nowIso,
          });
        }
      }
    }

    // Open a new incident when entering an unhealthy state.
    if (curType) {
      const existingOpen = findOpen(incidents, site.id, curType);
      const isNewFailure = prevStatus !== status;
      if (!existingOpen) {
        const startedAt = ss.downSince ?? nowIso;
        const incident: Incident = {
          id: newIncidentId(site.id, curType, now),
          siteId: site.id,
          siteName: site.name,
          type: curType,
          state: "open",
          title:
            curType === "down"
              ? `${site.name} is down`
              : `${site.name} is degraded`,
          startedAt,
          ...(result.error ? { detail: result.error } : {}),
          updates: [{ at: nowIso, message: result.error ?? "Detected" }],
        };
        incidents = [incident, ...incidents];
        ss.openIncidents = { ...(ss.openIncidents ?? {}), [curType]: incident.id };
      }
      // Emit notification event on the transition into failure (not every run).
      if (isNewFailure) {
        events.push({
          type: curType === "down" ? "down" : "degraded",
          siteId: site.id,
          siteName: site.name,
          url: site.url,
          ...(site.group ? { group: site.group } : {}),
          status,
          ...(result.error ? { detail: result.error } : {}),
          ...(ss.downSince ? { since: ss.downSince } : {}),
          ...(site.notify ? { notify: site.notify } : {}),
          at: nowIso,
        });
      }
    }

    // ---- track downSince for minDownMinutes gating ----
    if (status === "up") {
      delete ss.downSince;
    } else if (!ss.downSince) {
      ss.downSince = nowIso;
    }

    // ---- ssl expiry transitions ----
    if (result.ssl) {
      reconcileExpiry({
        kind: "ssl",
        site,
        incidents: (next) => (incidents = next),
        getIncidents: () => incidents,
        ss,
        events,
        nowIso,
        now,
        daysRemaining: result.ssl.daysRemaining,
        expiringSoon: result.ssl.expiringSoon,
        sslExpiresAt: result.ssl.validTo,
        sslInfo: result,
      });
    }

    // ---- domain expiry transitions ----
    if (result.domain) {
      reconcileExpiry({
        kind: "domain",
        site,
        incidents: (next) => (incidents = next),
        getIncidents: () => incidents,
        ss,
        events,
        nowIso,
        now,
        daysRemaining: result.domain.daysRemaining,
        expiringSoon: result.domain.expiringSoon,
        sslExpiresAt: result.domain.expiresAt,
        sslInfo: result,
      });
    }

    // ---- record last status for next run ----
    ss.lastStatus = status;
  }

  // Prune old resolved incidents and keep newest-first.
  incidents = pruneIncidents(incidents, now);
  return { incidents, events };
}

interface ExpiryArgs {
  kind: "ssl" | "domain";
  site: ResolvedSite;
  incidents: (next: Incident[]) => void;
  getIncidents: () => Incident[];
  ss: SiteState;
  events: EngineEvent[];
  nowIso: string;
  now: number;
  daysRemaining: number;
  expiringSoon: boolean;
  sslExpiresAt: string;
  sslInfo: CheckResult;
}

/**
 * Open/resolve an ssl/domain-expiring incident and emit one alert per warn
 * threshold crossing (tracked via state's *WarnedDay so we don't re-alert every
 * run while still inside the same window).
 */
function reconcileExpiry(args: ExpiryArgs): void {
  const incidentType: IncidentType = args.kind === "ssl" ? "ssl_expiring" : "domain_expiring";
  const eventType = args.kind === "ssl" ? "ssl" : "domain";
  const open = findOpen(args.getIncidents(), args.site.id, incidentType);

  if (args.expiringSoon) {
    if (!open) {
      const incident: Incident = {
        id: `${args.site.id}-${incidentType}-${args.now}`,
        siteId: args.site.id,
        siteName: args.site.name,
        type: incidentType,
        state: "open",
        title:
          args.kind === "ssl"
            ? `${args.site.name} TLS certificate expiring`
            : `${args.site.name} domain expiring`,
        detail: `Expires in ${args.daysRemaining} days (${args.sslExpiresAt.slice(0, 10)})`,
        startedAt: args.nowIso,
        updates: [{ at: args.nowIso, message: `Expires in ${args.daysRemaining} days` }],
      };
      args.incidents([incident, ...args.getIncidents()]);
      args.ss.openIncidents = { ...(args.ss.openIncidents ?? {}), [incidentType]: incident.id };
    }
    // Emit an alert only when we cross into a tighter threshold than last time.
    const warnedKey = args.kind === "ssl" ? "sslWarnedDay" : "domainWarnedDay";
    const lastWarned = args.ss[warnedKey];
    if (lastWarned === undefined || args.daysRemaining < lastWarned) {
      args.events.push({
        type: eventType,
        siteId: args.site.id,
        siteName: args.site.name,
        url: args.site.url,
        ...(args.site.group ? { group: args.site.group } : {}),
        detail: `${args.kind === "ssl" ? "TLS certificate" : "Domain"} expires in ${args.daysRemaining} days`,
        ...(args.site.notify ? { notify: args.site.notify } : {}),
        ...(args.sslInfo.ssl ? { ssl: args.sslInfo.ssl } : {}),
        ...(args.sslInfo.domain ? { domain: args.sslInfo.domain } : {}),
        at: args.nowIso,
      });
      args.ss[warnedKey] = args.daysRemaining;
    }
  } else {
    // No longer expiring soon (renewed) — resolve and reset the warn marker.
    if (open) {
      open.state = "resolved";
      open.resolvedAt = args.nowIso;
      open.durationMs = elapsedMs(open.startedAt, args.now);
      open.updates = [...(open.updates ?? []), { at: args.nowIso, message: "Renewed" }];
      if (args.ss.openIncidents) delete args.ss.openIncidents[incidentType];
    }
    if (args.kind === "ssl") delete args.ss.sslWarnedDay;
    else delete args.ss.domainWarnedDay;
  }
}

/** Sort newest-first and drop resolved incidents older than the retention window. */
export function pruneIncidents(incidents: Incident[], now: number = Date.now()): Incident[] {
  const cutoff = now - RESOLVED_RETENTION_MS;
  const kept = incidents.filter((i) => {
    if (i.state === "open") return true;
    const resolvedMs = i.resolvedAt ? Date.parse(i.resolvedAt) : Date.parse(i.startedAt);
    return Number.isNaN(resolvedMs) || resolvedMs >= cutoff;
  });
  // Newest-first by startedAt.
  kept.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  return kept;
}
