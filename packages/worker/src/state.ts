/**
 * Worker cross-run state (kv key `state`).
 *
 * The Worker is stateless between cron ticks, so all memory used for transition
 * detection (up→down) and for caching the slow SSL/domain probes lives here.
 */

import type { DomainInfo, SslInfo, Status } from "@blip/shared";

/** Per-site state carried between ticks. */
export interface SiteState {
  /** Status at the end of the previous tick. */
  lastStatus?: Status;
  /** ISO timestamp the site first entered its current non-up status. */
  downSince?: string;
  /** Open incident ids keyed by incident type, so we don't double-open. */
  openIncidents?: Partial<Record<string, string>>;
  /** Last SSL warn-day threshold we alerted on. */
  sslWarnedDay?: number;
  /** Last domain warn-day threshold we alerted on. */
  domainWarnedDay?: number;
  /** Cached last SSL probe (refreshed infrequently — crt.sh is slow). */
  ssl?: SslInfo;
  /** Cached last domain probe. */
  domain?: DomainInfo;
  /** Epoch ms of the last successful SSL refresh. */
  sslRefreshedAt?: number;
  /** Epoch ms of the last successful domain refresh. */
  domainRefreshedAt?: number;
  /** Epoch ms / ISO of the last check. */
  lastChecked?: string;
  /** Last response time (ms). */
  responseTime?: number | null;
  /** Last HTTP status. */
  httpStatus?: number;
  /** Last error message. */
  error?: string;
}

/**
 * De-dup ledger for notifications: key `channelId:siteId:eventType` → ISO time
 * last alerted. Prevents re-alerting a still-open condition every tick.
 */
export type AlertLedger = Record<string, string>;

export interface WorkerState {
  version: number;
  sites: Record<string, SiteState>;
  alerts?: AlertLedger;
  updatedAt?: string;
}

export const EMPTY_STATE: WorkerState = { version: 1, sites: {}, alerts: {} };

export function alertKey(channelId: string, siteId: string, eventType: string): string {
  return `${channelId}:${siteId}:${eventType}`;
}

export function siteStateFor(state: WorkerState, siteId: string): SiteState {
  const existing = state.sites[siteId];
  if (existing) return existing;
  const fresh: SiteState = {};
  state.sites[siteId] = fresh;
  return fresh;
}
