/**
 * Incident reconciliation for the Worker.
 *
 * Mirrors packages/engine/src/store/incidents.ts:
 *   - open an incident on a transition into an unhealthy state (up→down,
 *     →degraded) or when ssl/domain becomes expiringSoon,
 *   - resolve on recovery, stamping resolvedAt + durationMs,
 *   - at most one OPEN incident per (siteId, incidentType),
 *   - incidents stored newest-first,
 *   - resolved incidents older than ~90 days are pruned.
 *
 * Notifications are out of scope for this Worker (no channels), so this only
 * returns the reconciled incident list plus the mutated state.
 */

import type { Incident, IncidentType, SslInfo, DomainInfo, Status } from "@pulse/shared";
import type { ResolvedSite } from "./config-types.js";
import { siteStateFor, type SiteState, type WorkerState } from "./state.js";
import { elapsedMs, iso } from "./time.js";

const RESOLVED_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/** Per-site reconciliation input — the latest probe outcome for one site. */
export interface SiteResult {
  status: Status;
  error?: string | undefined;
  ssl?: SslInfo | undefined;
  domain?: DomainInfo | undefined;
}

export interface ReconcileInput {
  prevState: WorkerState;
  results: Map<string, SiteResult>;
  sites: ResolvedSite[];
  now?: number;
}

export interface ReconcileOutput {
  incidents: Incident[];
  state: WorkerState;
}

function newIncidentId(siteId: string, type: IncidentType, at: number): string {
  return `${siteId}-${type}-${at}`;
}

function findOpen(incidents: Incident[], siteId: string, type: IncidentType): Incident | undefined {
  return incidents.find((i) => i.siteId === siteId && i.type === type && i.state === "open");
}

function incidentTypeForStatus(status: Status): IncidentType | null {
  if (status === "down") return "down";
  if (status === "degraded") return "degraded";
  return null;
}

export function reconcile(
  prevIncidents: Incident[],
  input: ReconcileInput,
): ReconcileOutput {
  const now = input.now ?? Date.now();
  const nowIso = iso(now);
  const state = input.prevState;
  let incidents = prevIncidents.map((i) => ({ ...i }));

  for (const site of input.sites) {
    if (site.paused) continue;
    const result = input.results.get(site.id);
    if (!result) continue;

    const ss = siteStateFor(state, site.id);
    const status = result.status;
    const curType = incidentTypeForStatus(status);

    // Resolve open availability incidents whose condition no longer holds.
    for (const t of ["down", "degraded"] as IncidentType[]) {
      const open = findOpen(incidents, site.id, t);
      if (!open) continue;
      if (curType !== t) {
        open.state = "resolved";
        open.resolvedAt = nowIso;
        open.durationMs = elapsedMs(open.startedAt, now);
        open.updates = [...(open.updates ?? []), { at: nowIso, message: "Recovered" }];
        if (ss.openIncidents) delete ss.openIncidents[t];
      }
    }

    // Open a new incident when entering an unhealthy state.
    if (curType) {
      const existingOpen = findOpen(incidents, site.id, curType);
      if (!existingOpen) {
        const startedAt = ss.downSince ?? nowIso;
        const incident: Incident = {
          id: newIncidentId(site.id, curType, now),
          siteId: site.id,
          siteName: site.name,
          type: curType,
          state: "open",
          title: curType === "down" ? `${site.name} is down` : `${site.name} is degraded`,
          startedAt,
          ...(result.error ? { detail: result.error } : {}),
          updates: [{ at: nowIso, message: result.error ?? "Detected" }],
        };
        incidents = [incident, ...incidents];
        ss.openIncidents = { ...(ss.openIncidents ?? {}), [curType]: incident.id };
      }
    }

    // Track downSince.
    if (status === "up") {
      delete ss.downSince;
    } else if (!ss.downSince) {
      ss.downSince = nowIso;
    }

    // SSL / domain expiry transitions.
    if (result.ssl) {
      reconcileExpiry({
        kind: "ssl",
        site,
        ss,
        nowIso,
        now,
        daysRemaining: result.ssl.daysRemaining,
        expiringSoon: result.ssl.expiringSoon,
        expiresAt: result.ssl.validTo,
        get: () => incidents,
        set: (next) => (incidents = next),
      });
    }
    if (result.domain) {
      reconcileExpiry({
        kind: "domain",
        site,
        ss,
        nowIso,
        now,
        daysRemaining: result.domain.daysRemaining,
        expiringSoon: result.domain.expiringSoon,
        expiresAt: result.domain.expiresAt,
        get: () => incidents,
        set: (next) => (incidents = next),
      });
    }

    ss.lastStatus = status;
  }

  incidents = pruneIncidents(incidents, now);
  state.updatedAt = nowIso;
  return { incidents, state };
}

interface ExpiryArgs {
  kind: "ssl" | "domain";
  site: ResolvedSite;
  ss: SiteState;
  nowIso: string;
  now: number;
  daysRemaining: number;
  expiringSoon: boolean;
  expiresAt: string;
  get: () => Incident[];
  set: (next: Incident[]) => void;
}

function reconcileExpiry(args: ExpiryArgs): void {
  const incidentType: IncidentType = args.kind === "ssl" ? "ssl_expiring" : "domain_expiring";
  const open = findOpen(args.get(), args.site.id, incidentType);

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
        detail: `Expires in ${args.daysRemaining} days (${args.expiresAt.slice(0, 10)})`,
        startedAt: args.nowIso,
        updates: [{ at: args.nowIso, message: `Expires in ${args.daysRemaining} days` }],
      };
      args.set([incident, ...args.get()]);
      args.ss.openIncidents = { ...(args.ss.openIncidents ?? {}), [incidentType]: incident.id };
    }
    const warnedKey = args.kind === "ssl" ? "sslWarnedDay" : "domainWarnedDay";
    const lastWarned = args.ss[warnedKey];
    if (lastWarned === undefined || args.daysRemaining < lastWarned) {
      args.ss[warnedKey] = args.daysRemaining;
    }
  } else {
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
  kept.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  return kept;
}
