/** Discord notifier — incoming webhook POST. Never throws. */

import type { DiscordChannel } from "@blip/shared";
import type { EngineEvent } from "../events.js";
import { plainText } from "./format.js";
import type { NotifyContext, SendResult } from "./types.js";
import { postJson } from "./types.js";
import { log } from "../util/log.js";

export async function send(
  channel: DiscordChannel,
  event: EngineEvent,
  ctx: NotifyContext,
): Promise<SendResult> {
  const base: SendResult = { ok: true, channelId: channel.id, channelType: "discord" };
  if (ctx.dryRun) {
    log.info(`[dry-run] discord(${channel.id}) ← ${event.type} ${event.siteId}`);
    return base;
  }
  if (!channel.webhookUrl || channel.webhookUrl.includes("${")) {
    log.warn(`discord(${channel.id}): missing/unresolved webhook URL — skipping`);
    return { ...base, ok: false, error: "missing webhook url" };
  }
  const result = await postJson(channel.webhookUrl, { content: plainText(event) }, ctx);
  if (!result.ok) {
    log.warn(`discord(${channel.id}): send failed — ${result.error ?? "unknown"}`);
    return { ...base, ok: false, ...(result.error ? { error: result.error } : {}) };
  }
  return base;
}
