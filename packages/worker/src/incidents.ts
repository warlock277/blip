/**
 * Incident reconciliation for the Worker.
 *
 * Opens/resolves incidents and derives notification events on transitions:
 *   - open an incident on a transition into an unhealthy state (up→down,
 *     →degraded) or when ssl/domain becomes expiringSoon,
 *   - resolve on recovery, stamping resolvedAt + durationMs,
 *   - at most one OPEN incident per (siteId, incidentType),
 *   - incidents stored newest-first,
 *   - resolved incidents older than ~90 days are pruned.
 *
 * Also derives the notification events for each transition (down/up/degraded,
 * ssl/domain threshold crossings) — these feed dispatchNotifications().
 */

import type { Incident, IncidentType, SslInfo, DomainInfo, Status } from "@blip/shared";
import type { ResolvedSite } from "./config-types.js";
import type { NotifyEvent } from "./notify.js";
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
  events: NotifyEvent[];
}

function newIncidentId(siteId: string, type: IncidentType, at: number): string {
  return `${siteId}-${type}-${at}`;
}

/**
 * Drop notify de-dup entries for one (site, eventType) across every channel, so
 * the next occurrence of that condition alerts again. Ledger keys are
 * `channelId:siteId:eventType` (see state.alertKey).
 */
function clearAlertLedger(state: WorkerState, siteId: string, eventType: string): void {
  if (!state.alerts) return;
  const suffix = `:${siteId}:${eventType}`;
  for (const k of Object.keys(state.alerts)) {
    if (k.endsWith(suffix)) delete state.alerts[k];
  }
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
  const events: NotifyEvent[] = [];

  for (const site of input.sites) {
    if (site.paused) continue;
    const result = input.results.get(site.id);
    if (!result) continue;

    const ss = siteStateFor(state, site.id);
    const status = result.status;
    const curType = incidentTypeForStatus(status);

    // Track the outage start up front so emitted down/degraded events carry
    // `since` (minDownMinutes gates on it on the transition tick too).
    if (status === "up") delete ss.downSince;
    else if (!ss.downSince) ss.downSince = nowIso;

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
        // Reset the notify de-dup for this (site, condition) across ALL channels
        // so the NEXT occurrence alerts again (not just channels that get the up).
        clearAlertLedger(state, site.id, t);
        // Emit a recovery event only on full recovery to "up" from a down.
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
            ...(open.durationMs !== undefined ? { durationMs: open.durationMs } : {}),
            ...(site.notify ? { notify: site.notify } : {}),
            at: nowIso,
          });
        }
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
      // Emit every tick while failing; dispatch de-dups via the ledger so the
      // alert is sent ONCE per outage (after minDownMinutes), and re-armed by
      // clearAlertLedger() on recovery. Emitting only on the transition tick
      // would make minDownMinutes unsatisfiable (the alert would be dropped).
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

    // SSL / domain expiry transitions.
    if (result.ssl) {
      reconcileExpiry({
        kind: "ssl",
        site,
        ss,
        events,
        nowIso,
        now,
        daysRemaining: result.ssl.daysRemaining,
        expiringSoon: result.ssl.expiringSoon,
        expiresAt: result.ssl.validTo,
        ssl: result.ssl,
        get: () => incidents,
        set: (next) => (incidents = next),
      });
    }
    if (result.domain) {
      reconcileExpiry({
        kind: "domain",
        site,
        ss,
        events,
        nowIso,
        now,
        daysRemaining: result.domain.daysRemaining,
        expiringSoon: result.domain.expiringSoon,
        expiresAt: result.domain.expiresAt,
        domain: result.domain,
        get: () => incidents,
        set: (next) => (incidents = next),
      });
    }

    ss.lastStatus = status;
  }

  incidents = pruneIncidents(incidents, now);
  state.updatedAt = nowIso;
  return { incidents, state, events };
}

interface ExpiryArgs {
  kind: "ssl" | "domain";
  site: ResolvedSite;
  ss: SiteState;
  events: NotifyEvent[];
  nowIso: string;
  now: number;
  daysRemaining: number;
  expiringSoon: boolean;
  expiresAt: string;
  ssl?: SslInfo;
  domain?: DomainInfo;
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
    // Emit an alert only when crossing into a tighter window than last alerted.
    const warnedKey = args.kind === "ssl" ? "sslWarnedDay" : "domainWarnedDay";
    const lastWarned = args.ss[warnedKey];
    if (lastWarned === undefined || args.daysRemaining < lastWarned) {
      args.events.push({
        type: args.kind === "ssl" ? "ssl" : "domain",
        siteId: args.site.id,
        siteName: args.site.name,
        url: args.site.url,
        ...(args.site.group ? { group: args.site.group } : {}),
        detail: `${args.kind === "ssl" ? "TLS certificate" : "Domain"} expires in ${args.daysRemaining} days`,
        ...(args.ssl ? { ssl: args.ssl } : {}),
        ...(args.domain ? { domain: args.domain } : {}),
        ...(args.site.notify ? { notify: args.site.notify } : {}),
        at: args.nowIso,
      });
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
