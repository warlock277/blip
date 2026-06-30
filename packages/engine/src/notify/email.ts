/** Email notifier — Resend REST API. Never throws. */

import type { EmailChannel } from "@pulse/shared";
import type { EngineEvent } from "../events.js";
import { formatEvent } from "./format.js";
import type { NotifyContext, SendResult } from "./types.js";
import { postJson } from "./types.js";
import { log } from "../util/log.js";

const RESEND_URL = "https://api.resend.com/emails";

export async function send(
  channel: EmailChannel,
  event: EngineEvent,
  ctx: NotifyContext,
): Promise<SendResult> {
  const base: SendResult = { ok: true, channelId: channel.id, channelType: "email" };
  if (ctx.dryRun) {
    log.info(`[dry-run] email(${channel.id}) ← ${event.type} ${event.siteId}`);
    return base;
  }
  if (!channel.apiKey || channel.apiKey.includes("${")) {
    log.warn(`email(${channel.id}): missing/unresolved API key — skipping`);
    return { ...base, ok: false, error: "missing api key" };
  }
  const { title, body } = formatEvent(event);
  const html = `<h2>${escapeHtml(title)}</h2>${body ? `<pre>${escapeHtml(body)}</pre>` : ""}`;
  const result = await postJson(
    RESEND_URL,
    { from: channel.from, to: channel.to, subject: title, html, text: `${title}\n${body}` },
    ctx,
    { headers: { authorization: `Bearer ${channel.apiKey}` } },
  );
  if (!result.ok) {
    log.warn(`email(${channel.id}): send failed — ${result.error ?? "unknown"}`);
    return { ...base, ok: false, ...(result.error ? { error: result.error } : {}) };
  }
  return base;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
