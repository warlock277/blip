/**
 * Notification dispatcher.
 *
 * Routes each engine event to the channels that match it, applying:
 *   - `events`  filter (channel only wants certain event types)
 *   - `sites`   filter (channel scoped to specific site ids)
 *   - `groups`  filter (channel scoped to specific groups)
 *   - site-level `notify: [...]` override (when present, ONLY those channels)
 *   - `minDownMinutes` gating for `down` events (suppress flapping)
 *   - de-dup against `state.alerts` so the same (channel,site,event) isn't
 *     re-sent while the condition persists.
 *
 * Updates `state.alerts` in place and returns the list of send results.
 */

import type { ChannelConfig, EventType } from "@pulse/shared";
import type { EngineEvent } from "../events.js";
import type { EngineState } from "../store/state.js";
import { alertKey } from "../store/state.js";
import { elapsedMs } from "../util/time.js";
import { log } from "../util/log.js";
import type { NotifyContext, SendResult } from "./types.js";
import { send as sendTelegram } from "./telegram.js";
import { send as sendEmail } from "./email.js";
import { send as sendDiscord } from "./discord.js";
import { send as sendSlack } from "./slack.js";
import { send as sendWebhook } from "./webhook.js";

/** Does this channel want this event type? (No `events` filter = all types.) */
function channelWantsEvent(channel: ChannelConfig, type: EventType): boolean {
  if (!channel.events || channel.events.length === 0) return true;
  return channel.events.includes(type);
}

/** Does this channel's site/group scope include this event? */
function channelScopeMatches(channel: ChannelConfig, event: EngineEvent): boolean {
  const hasSiteFilter = channel.sites && channel.sites.length > 0;
  const hasGroupFilter = channel.groups && channel.groups.length > 0;
  if (!hasSiteFilter && !hasGroupFilter) return true;
  if (hasSiteFilter && channel.sites!.includes(event.siteId)) return true;
  if (hasGroupFilter && event.group && channel.groups!.includes(event.group)) return true;
  return false;
}

/**
 * Resolve which channels an event should go to. If the site declared an
 * explicit `notify: [...]`, ONLY those channels are eligible (then still
 * filtered by event type). Otherwise all channels are eligible (filtered by
 * event type + site/group scope).
 */
function channelsForEvent(event: EngineEvent, channels: ChannelConfig[]): ChannelConfig[] {
  if (event.notify && event.notify.length > 0) {
    const allow = new Set(event.notify);
    return channels.filter((c) => allow.has(c.id) && channelWantsEvent(c, event.type));
  }
  return channels.filter(
    (c) => channelWantsEvent(c, event.type) && channelScopeMatches(c, event),
  );
}

/**
 * Apply `minDownMinutes`: for a `down` event, suppress until the site has been
 * down at least that long. Uses `event.since` (downSince) when available.
 */
function passesMinDown(channel: ChannelConfig, event: EngineEvent, now: number): boolean {
  const min = channel.minDownMinutes ?? 0;
  if (min <= 0) return true;
  if (event.type !== "down") return true; // only gate outage alerts
  if (!event.since) return true; // can't gate without a start time → allow
  const downMs = elapsedMs(event.since, now);
  return downMs >= min * 60_000;
}

async function dispatchOne(
  channel: ChannelConfig,
  event: EngineEvent,
  ctx: NotifyContext,
): Promise<SendResult> {
  switch (channel.type) {
    case "telegram":
      return sendTelegram(channel, event, ctx);
    case "email":
      return sendEmail(channel, event, ctx);
    case "discord":
      return sendDiscord(channel, event, ctx);
    case "slack":
      return sendSlack(channel, event, ctx);
    case "webhook":
      return sendWebhook(channel, event, ctx);
    default: {
      // Exhaustiveness guard.
      const _never: never = channel;
      return { ok: false, channelId: "", channelType: "webhook", error: `unknown channel ${String(_never)}` };
    }
  }
}

export interface DispatchOutput {
  sent: SendResult[];
  /** Events that were intentionally suppressed (de-dup / minDown / no match). */
  suppressed: number;
}

export async function dispatch(
  events: EngineEvent[],
  channels: ChannelConfig[],
  state: EngineState,
  ctx: NotifyContext,
  now: number = Date.now(),
): Promise<DispatchOutput> {
  const sent: SendResult[] = [];
  let suppressed = 0;

  for (const event of events) {
    const targets = channelsForEvent(event, channels);
    for (const channel of targets) {
      if (!passesMinDown(channel, event, now)) {
        suppressed += 1;
        continue;
      }

      const key = alertKey(channel.id, event.siteId, event.type);
      // De-dup: skip if we've already alerted this exact tuple recently AND the
      // event is a "sticky" condition. Recovery (up) always clears prior down.
      if (event.type === "up") {
        // Clear the matching down ledger entry so a future outage alerts again.
        delete state.alerts[alertKey(channel.id, event.siteId, "down")];
      } else if (state.alerts[key]) {
        // Already alerted for this open condition — suppress duplicate.
        suppressed += 1;
        continue;
      }

      const result = await dispatchOne(channel, event, ctx);
      sent.push(result);

      if (result.ok && !ctx.dryRun) {
        // Record so we don't re-alert the same open condition next run.
        if (event.type !== "up") state.alerts[key] = new Date(now).toISOString();
      }
    }
  }

  if (sent.length > 0) {
    log.info(`notify: dispatched ${sent.filter((s) => s.ok).length}/${sent.length} (suppressed ${suppressed})`);
  }
  return { sent, suppressed };
}
