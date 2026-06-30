/** Telegram notifier — Bot API sendMessage. Never throws. */

import type { TelegramChannel } from "@pulse/shared";
import type { EngineEvent } from "../events.js";
import { plainText } from "./format.js";
import type { NotifyContext, SendResult } from "./types.js";
import { postJson } from "./types.js";
import { log } from "../util/log.js";

export async function send(
  channel: TelegramChannel,
  event: EngineEvent,
  ctx: NotifyContext,
): Promise<SendResult> {
  const base: SendResult = { ok: true, channelId: channel.id, channelType: "telegram" };
  if (ctx.dryRun) {
    log.info(`[dry-run] telegram(${channel.id}) ← ${event.type} ${event.siteId}`);
    return base;
  }
  if (!channel.botToken || channel.botToken.includes("${")) {
    log.warn(`telegram(${channel.id}): missing/unresolved bot token — skipping`);
    return { ...base, ok: false, error: "missing bot token" };
  }
  const url = `https://api.telegram.org/bot${channel.botToken}/sendMessage`;
  const result = await postJson(
    url,
    { chat_id: channel.chatId, text: plainText(event), disable_web_page_preview: true },
    ctx,
  );
  if (!result.ok) {
    log.warn(`telegram(${channel.id}): send failed — ${result.error ?? "unknown"}`);
    return { ...base, ok: false, ...(result.error ? { error: result.error } : {}) };
  }
  return base;
}
