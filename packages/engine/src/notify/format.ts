/**
 * Shared message formatting for notifications.
 *
 * Produces clear, emoji-tagged one-liners + an optional longer body. No secret
 * values are ever included (only public site name/url + status detail).
 */

import type { EngineEvent } from "../events.js";
import { humanizeMs } from "../util/time.js";

export interface FormattedMessage {
  /** Short single-line title, e.g. `🔴 example.com is DOWN`. */
  title: string;
  /** Optional extra context line(s). */
  body: string;
}

const EMOJI: Record<EngineEvent["type"], string> = {
  down: "🔴",
  up: "✅",
  degraded: "🟡",
  ssl: "🔐",
  domain: "🌐",
};

export function formatEvent(event: EngineEvent): FormattedMessage {
  const emoji = EMOJI[event.type];
  let title: string;
  const lines: string[] = [];

  switch (event.type) {
    case "down":
      title = `${emoji} ${event.siteName} is DOWN`;
      if (event.detail) lines.push(event.detail);
      lines.push(event.url);
      break;
    case "up": {
      const dur = event.durationMs !== undefined ? ` after ${humanizeMs(event.durationMs)}` : "";
      title = `${emoji} ${event.siteName} recovered${dur}`;
      lines.push(event.url);
      break;
    }
    case "degraded":
      title = `${emoji} ${event.siteName} is DEGRADED`;
      if (event.detail) lines.push(event.detail);
      lines.push(event.url);
      break;
    case "ssl": {
      const days = event.ssl?.daysRemaining;
      title = `${emoji} ${event.siteName} — TLS certificate expires in ${days ?? "?"} days`;
      if (event.ssl?.validTo) lines.push(`Valid until ${event.ssl.validTo.slice(0, 10)}`);
      lines.push(event.url);
      break;
    }
    case "domain": {
      const days = event.domain?.daysRemaining;
      title = `${emoji} ${event.siteName} — domain expires in ${days ?? "?"} days`;
      if (event.domain?.expiresAt) lines.push(`Expires ${event.domain.expiresAt.slice(0, 10)}`);
      lines.push(event.url);
      break;
    }
    default:
      title = `${event.siteName}`;
  }

  return { title, body: lines.join("\n") };
}

/** Combine into a single plain-text blob (for channels without rich structure). */
export function plainText(event: EngineEvent): string {
  const f = formatEvent(event);
  return f.body ? `${f.title}\n${f.body}` : f.title;
}
