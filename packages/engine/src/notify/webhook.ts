/** Generic webhook notifier — POSTs the raw JSON event. Never throws. */

import type { WebhookChannel } from "@blip/shared";
import type { EngineEvent } from "../events.js";
import type { NotifyContext, SendResult } from "./types.js";
import { postJson } from "./types.js";
import { log } from "../util/log.js";

export async function send(
  channel: WebhookChannel,
  event: EngineEvent,
  ctx: NotifyContext,
): Promise<SendResult> {
  const base: SendResult = { ok: true, channelId: channel.id, channelType: "webhook" };
  if (ctx.dryRun) {
    log.info(`[dry-run] webhook(${channel.id}) ← ${event.type} ${event.siteId}`);
    return base;
  }
  if (!channel.url || channel.url.includes("${")) {
    log.warn(`webhook(${channel.id}): missing/unresolved URL — skipping`);
    return { ...base, ok: false, error: "missing url" };
  }
  const result = await postJson(channel.url, event, ctx, {
    method: channel.method ?? "POST",
    ...(channel.headers ? { headers: channel.headers } : {}),
  });
  if (!result.ok) {
    log.warn(`webhook(${channel.id}): send failed — ${result.error ?? "unknown"}`);
    return { ...base, ok: false, ...(result.error ? { error: result.error } : {}) };
  }
  return base;
}
