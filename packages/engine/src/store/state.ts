/**
 * Engine-internal persisted state (`data/state.json`).
 *
 * Not consumed by the dashboard. Drives transition detection (up→down, etc.)
 * and alert de-duplication across runs (each GitHub Action run is a fresh
 * process, so all cross-run memory lives here).
 */

import { join } from "node:path";
import type { Status } from "@pulse/shared";
import { readJson, writeJson } from "../util/fs.js";

/** Per-site state carried between runs. */
export interface SiteState {
  /** Status at the end of the previous run. */
  lastStatus?: Status;
  /** ISO timestamp the site first entered its current non-up status (for minDownMinutes). */
  downSince?: string;
  /** Open incident ids keyed by incident type, so we don't double-open. */
  openIncidents?: Partial<Record<string, string>>;
  /** Last SSL warn-day threshold we alerted on (so we alert once per threshold crossing). */
  sslWarnedDay?: number;
  /** Last domain warn-day threshold we alerted on. */
  domainWarnedDay?: number;
}

/** Map of `${channelId}:${siteId}:${eventType}` → ISO timestamp of last alert sent. */
export type AlertLedger = Record<string, string>;

export interface EngineState {
  version: number;
  /** Keyed by siteId. */
  sites: Record<string, SiteState>;
  /** Alert de-dup ledger. */
  alerts: AlertLedger;
  /** When the state was last written. */
  updatedAt?: string;
}

const EMPTY_STATE: EngineState = { version: 1, sites: {}, alerts: {} };

export function statePath(dataDir: string): string {
  return join(dataDir, "state.json");
}

export async function readState(dataDir: string): Promise<EngineState> {
  const loaded = await readJson<EngineState>(statePath(dataDir), EMPTY_STATE);
  return {
    version: loaded.version ?? 1,
    sites: loaded.sites ?? {},
    alerts: loaded.alerts ?? {},
    ...(loaded.updatedAt ? { updatedAt: loaded.updatedAt } : {}),
  };
}

export async function writeState(dataDir: string, state: EngineState): Promise<void> {
  await writeJson(statePath(dataDir), { ...state, updatedAt: new Date().toISOString() });
}

/** Build an alert-ledger key. */
export function alertKey(channelId: string, siteId: string, eventType: string): string {
  return `${channelId}:${siteId}:${eventType}`;
}
