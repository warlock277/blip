/**
 * Engine event model.
 *
 * Transitions detected during a run are emitted as `EngineEvent`s. These drive
 * BOTH incident reconciliation and notification dispatch, so they carry enough
 * context (site, status, ssl/domain info, timestamps) for both consumers.
 */

import type { DomainInfo, EventType, SslInfo, Status } from "@blip/shared";

export interface EngineEvent {
  type: EventType;
  siteId: string;
  siteName: string;
  url: string;
  group?: string;
  /** Resulting status (for up/down/degraded events). */
  status?: Status;
  /** Human-readable detail (error message or expiry summary). */
  detail?: string;
  /** When the underlying condition started (e.g. downSince) — ISO. */
  since?: string;
  /** Outage/condition duration in ms (for recovery events). */
  durationMs?: number;
  /** Channel ids the site opted into via `notify:` (overrides global routing). */
  notify?: string[];
  ssl?: SslInfo;
  domain?: DomainInfo;
  /** ISO timestamp the event was generated. */
  at: string;
}
