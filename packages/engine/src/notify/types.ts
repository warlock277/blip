/** Shared types for notification senders. */

import type { ChannelConfig } from "@pulse/shared";
import type { EngineEvent } from "../events.js";

/** Context passed to every sender (timeouts, dry-run flag, etc.). */
export interface NotifyContext {
  /** When true, senders MUST NOT make network calls. */
  dryRun: boolean;
  /** Request timeout in ms. */
  timeoutMs: number;
}

/** Result of attempting to send one notification. */
export interface SendResult {
  ok: boolean;
  channelId: string;
  channelType: ChannelConfig["type"];
  error?: string;
}

export type Sender<C extends ChannelConfig> = (
  channel: C,
  event: EngineEvent,
  ctx: NotifyContext,
) => Promise<SendResult>;

/** POST helper with an AbortController timeout. Returns ok + optional error. */
export async function postJson(
  url: string,
  body: unknown,
  ctx: NotifyContext,
  init: { method?: string; headers?: Record<string, string> } = {},
): Promise<{ ok: boolean; status?: number; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ctx.timeoutMs);
  try {
    const res = await fetch(url, {
      method: init.method ?? "POST",
      headers: { "content-type": "application/json", ...(init.headers ?? {}) },
      body: typeof body === "string" ? body : JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      // Read a short snippet of the error body for context (no secrets here).
      const text = await res.text().catch(() => "");
      return { ok: false, status: res.status, error: `HTTP ${res.status} ${text.slice(0, 200)}`.trim() };
    }
    return { ok: true, status: res.status };
  } catch (err) {
    const e = err as Error;
    return { ok: false, error: e.name === "AbortError" ? "timed out" : e.message };
  } finally {
    clearTimeout(timer);
  }
}
