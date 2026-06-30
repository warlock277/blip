/**
 * Worker-side notifications.
 *
 * Ports packages/engine/src/notify/* to run inside the Cron Worker. Events are
 * produced by reconcile(); this module routes each to the matching channels,
 * applies `events`/`sites`/`groups` filters + `minDownMinutes` flap gating +
 * de-dup against `state.alerts`, and sends via the platform `fetch()`.
 *
 * Channel secrets are embedded as `${ENV_VAR}` refs (gen-config never inlines
 * values), so they are resolved from the Worker env here, at send time.
 */

import type {
  ChannelConfig,
  DomainInfo,
  EventType,
  SslInfo,
  Status,
} from "@blip/shared";
import type { Env } from "./env.js";
import { alertKey, type WorkerState } from "./state.js";
import { iso } from "./time.js";

/** A transition worth notifying about. Mirrors the engine's EngineEvent. */
export interface NotifyEvent {
  type: EventType;
  siteId: string;
  siteName: string;
  url: string;
  group?: string;
  status?: Status;
  detail?: string;
  /** When the condition started (downSince) — gates minDownMinutes. */
  since?: string;
  durationMs?: number;
  /** Site-level `notify:` override — when set, ONLY these channel ids. */
  notify?: string[];
  ssl?: SslInfo;
  domain?: DomainInfo;
  at: string;
}

const NOTIFY_TIMEOUT_MS = 10_000;

// --- message formatting (mirror engine/src/notify/format.ts) ----------------

const EMOJI: Record<EventType, string> = {
  down: "🔴",
  up: "✅",
  degraded: "🟡",
  ssl: "🔐",
  domain: "🌐",
};

function humanizeMs(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function plainText(e: NotifyEvent): string {
  const emoji = EMOJI[e.type];
  const lines: string[] = [];
  let title: string;
  switch (e.type) {
    case "down":
      title = `${emoji} ${e.siteName} is DOWN`;
      if (e.detail) lines.push(e.detail);
      lines.push(e.url);
      break;
    case "up": {
      const dur = e.durationMs !== undefined ? ` after ${humanizeMs(e.durationMs)}` : "";
      title = `${emoji} ${e.siteName} recovered${dur}`;
      lines.push(e.url);
      break;
    }
    case "degraded":
      title = `${emoji} ${e.siteName} is DEGRADED`;
      if (e.detail) lines.push(e.detail);
      lines.push(e.url);
      break;
    case "ssl":
      title = `${emoji} ${e.siteName} — TLS certificate expires in ${e.ssl?.daysRemaining ?? "?"} days`;
      lines.push(e.url);
      break;
    case "domain":
      title = `${emoji} ${e.siteName} — domain expires in ${e.domain?.daysRemaining ?? "?"} days`;
      lines.push(e.url);
      break;
    default:
      title = e.siteName;
  }
  return lines.length ? `${title}\n${lines.join("\n")}` : title;
}

// --- secret-ref resolution --------------------------------------------------

function resolveRef(value: string | undefined, env: Env): string {
  if (typeof value !== "string") return "";
  return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_m, name) => {
    const v = env[name];
    return typeof v === "string" ? v : "";
  });
}

/** A still-templated or empty value means the secret wasn't set — skip the send. */
function unresolved(value: string): boolean {
  return value.includes("${") || value.trim() === "";
}

// --- transport --------------------------------------------------------------

async function post(
  url: string,
  body: unknown,
  init: { method?: string; headers?: Record<string, string> } = {},
): Promise<{ ok: boolean; error?: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), NOTIFY_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: init.method ?? "POST",
      headers: { "content-type": "application/json", ...(init.headers ?? {}) },
      body: typeof body === "string" ? body : JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, error: `HTTP ${res.status} ${text.slice(0, 150)}`.trim() };
    }
    return { ok: true };
  } catch (err) {
    const e = err as Error;
    return { ok: false, error: e.name === "AbortError" ? "timed out" : e.message };
  } finally {
    clearTimeout(timer);
  }
}

async function sendChannel(
  channel: ChannelConfig,
  event: NotifyEvent,
  env: Env,
): Promise<{ ok: boolean; error?: string }> {
  const text = plainText(event);
  switch (channel.type) {
    case "telegram": {
      const token = resolveRef(channel.botToken, env);
      const chatId = resolveRef(channel.chatId, env);
      if (unresolved(token) || unresolved(chatId)) return { ok: false, error: "missing telegram token/chat id" };
      return post(`https://api.telegram.org/bot${token}/sendMessage`, {
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
      });
    }
    case "slack": {
      const url = resolveRef(channel.webhookUrl, env);
      if (unresolved(url)) return { ok: false, error: "missing slack webhook url" };
      return post(url, { text });
    }
    case "discord": {
      const url = resolveRef(channel.webhookUrl, env);
      if (unresolved(url)) return { ok: false, error: "missing discord webhook url" };
      return post(url, { content: text });
    }
    case "email": {
      const key = resolveRef(channel.apiKey, env);
      if (unresolved(key)) return { ok: false, error: "missing resend api key" };
      const subject = text.split("\n")[0] ?? "Blip alert";
      return post(
        "https://api.resend.com/emails",
        { from: channel.from, to: channel.to, subject, text },
        { headers: { authorization: `Bearer ${key}` } },
      );
    }
    case "webhook": {
      const url = resolveRef(channel.url, env);
      if (unresolved(url)) return { ok: false, error: "missing webhook url" };
      const headers = channel.headers
        ? Object.fromEntries(Object.entries(channel.headers).map(([k, v]) => [k, resolveRef(v, env)]))
        : undefined;
      return post(url, event, { method: channel.method ?? "POST", ...(headers ? { headers } : {}) });
    }
    default: {
      const _never: never = channel;
      return { ok: false, error: `unknown channel ${String(_never)}` };
    }
  }
}

// --- routing (mirror engine/src/notify/index.ts) ----------------------------

function wantsEvent(c: ChannelConfig, t: EventType): boolean {
  return !c.events || c.events.length === 0 || c.events.includes(t);
}

function scopeMatches(c: ChannelConfig, e: NotifyEvent): boolean {
  const hasSite = c.sites && c.sites.length > 0;
  const hasGroup = c.groups && c.groups.length > 0;
  if (!hasSite && !hasGroup) return true;
  if (hasSite && c.sites!.includes(e.siteId)) return true;
  if (hasGroup && e.group && c.groups!.includes(e.group)) return true;
  return false;
}

export function channelsFor(e: NotifyEvent, channels: ChannelConfig[]): ChannelConfig[] {
  if (e.notify && e.notify.length > 0) {
    const allow = new Set(e.notify);
    return channels.filter((c) => allow.has(c.id) && wantsEvent(c, e.type));
  }
  return channels.filter((c) => wantsEvent(c, e.type) && scopeMatches(c, e));
}

/** Gate `down` alerts until the site has been down at least minDownMinutes. */
export function passesMinDown(c: ChannelConfig, e: NotifyEvent, now: number): boolean {
  const min = c.minDownMinutes ?? 0;
  if (min <= 0 || e.type !== "down" || !e.since) return true;
  return now - Date.parse(e.since) >= min * 60_000;
}

/** Conditions whose down/degraded alert must fire at most once per occurrence. */
function isDeduped(type: NotifyEvent["type"]): boolean {
  return type === "down" || type === "degraded";
}

/**
 * Send notifications for this tick's events. `down`/`degraded` are emitted every
 * tick while failing, so they're de-duped here via `state.alerts` (sent once per
 * outage, after minDownMinutes); reconcile clears those ledger keys on recovery
 * so the next outage alerts again. `up`/`ssl`/`domain` are already emitted once
 * by reconcile (per transition / warn-threshold crossing) and send directly.
 *
 * Never throws — each channel send is isolated, so a malformed channel can't
 * abort the caller's D1 writes. Returns the count actually sent. `send` is
 * injectable for tests.
 */
export async function dispatchNotifications(
  events: NotifyEvent[],
  channels: ChannelConfig[] | undefined,
  state: WorkerState,
  env: Env,
  now: number,
  send: (c: ChannelConfig, e: NotifyEvent, env: Env) => Promise<{ ok: boolean; error?: string }> = sendChannel,
): Promise<number> {
  if (!channels || channels.length === 0 || events.length === 0) return 0;
  if (!state.alerts) state.alerts = {};
  const ledger = state.alerts;
  let sent = 0;

  for (const event of events) {
    for (const channel of channelsFor(event, channels)) {
      try {
        if (!passesMinDown(channel, event, now)) continue;

        const deduped = isDeduped(event.type);
        const key = alertKey(channel.id, event.siteId, event.type);
        // Already alerted for this still-open outage — suppress the duplicate.
        if (deduped && ledger[key]) continue;

        const res = await send(channel, event, env);
        if (res.ok) {
          sent += 1;
          if (deduped) ledger[key] = iso(now);
        } else {
          console.warn(`notify ${channel.type}(${channel.id}) failed: ${res.error}`);
        }
      } catch (err) {
        // Isolate a throwing/malformed channel so it can't abort the tick.
        console.warn(`notify ${channel.type}(${channel.id}) threw: ${(err as Error).message}`);
      }
    }
  }
  return sent;
}
