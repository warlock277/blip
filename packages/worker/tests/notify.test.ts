import { describe, expect, it } from "vitest";
import type { ChannelConfig } from "@blip/shared";
import { dispatchNotifications, channelsFor, passesMinDown, type NotifyEvent } from "../src/notify.js";
import type { WorkerState } from "../src/state.js";
import type { Env } from "../src/env.js";

function event(over: Partial<NotifyEvent> = {}): NotifyEvent {
  return {
    type: "down",
    siteId: "acme",
    siteName: "Acme",
    url: "https://acme.example.com",
    group: "prod",
    at: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

const tg = (over: Partial<ChannelConfig> = {}): ChannelConfig => ({
  id: "tg",
  type: "telegram",
  botToken: "${T}",
  chatId: "${C}",
  ...over,
});

describe("channelsFor — routing", () => {
  it("no filters → channel matches every event", () => {
    expect(channelsFor(event(), [tg()]).map((c) => c.id)).toEqual(["tg"]);
  });

  it("events filter excludes unwanted types", () => {
    const c = tg({ events: ["up"] });
    expect(channelsFor(event({ type: "down" }), [c])).toHaveLength(0);
    expect(channelsFor(event({ type: "up" }), [c])).toHaveLength(1);
  });

  it("sites filter scopes to listed site ids", () => {
    const c = tg({ sites: ["other"] });
    expect(channelsFor(event({ siteId: "acme" }), [c])).toHaveLength(0);
    expect(channelsFor(event({ siteId: "other" }), [c])).toHaveLength(1);
  });

  it("groups filter scopes to the event's group", () => {
    const c = tg({ groups: ["prod"] });
    expect(channelsFor(event({ group: "prod" }), [c])).toHaveLength(1);
    expect(channelsFor(event({ group: "staging" }), [c])).toHaveLength(0);
  });

  it("site-level notify override restricts to those channel ids only", () => {
    const a = tg({ id: "a" });
    const b = tg({ id: "b" });
    // Even though both match by scope, only the listed id is eligible.
    expect(channelsFor(event({ notify: ["b"] }), [a, b]).map((c) => c.id)).toEqual(["b"]);
  });
});

describe("passesMinDown — flap gating", () => {
  const now = Date.parse("2026-01-01T01:00:00.000Z");

  it("non-down events are never gated", () => {
    expect(passesMinDown(tg({ minDownMinutes: 30 }), event({ type: "up" }), now)).toBe(true);
  });

  it("down is suppressed before the window, allowed after", () => {
    const c = tg({ minDownMinutes: 30 });
    const recent = event({ since: "2026-01-01T00:45:00.000Z" }); // 15 min ago
    const old = event({ since: "2026-01-01T00:15:00.000Z" }); // 45 min ago
    expect(passesMinDown(c, recent, now)).toBe(false);
    expect(passesMinDown(c, old, now)).toBe(true);
  });

  it("minDownMinutes 0 (or unset) always passes", () => {
    expect(passesMinDown(tg(), event({ since: "2026-01-01T00:59:59.000Z" }), now)).toBe(true);
  });
});

describe("dispatchNotifications — de-dup, recovery, escalation", () => {
  const env = {} as Env;
  // Stub sender that records calls and always succeeds — no network.
  function recorder() {
    const calls: Array<{ id: string; type: string }> = [];
    const send = async (c: ChannelConfig, e: NotifyEvent) => {
      calls.push({ id: c.id, type: e.type });
      return { ok: true as const };
    };
    return { calls, send };
  }
  const T = Date.parse("2026-01-01T00:00:00.000Z");
  const down = (over: Partial<NotifyEvent> = {}): NotifyEvent =>
    event({ type: "down", since: "2026-01-01T00:00:00.000Z", ...over });

  it("a still-open outage alerts ONCE across repeated ticks", async () => {
    const state: WorkerState = { version: 1, sites: {}, alerts: {} };
    const ch = [tg({ events: ["down"] })];
    const r = recorder();
    // three consecutive ticks, site still down
    for (let i = 0; i < 3; i++) await dispatchNotifications([down()], ch, state, env, T, r.send);
    expect(r.calls).toHaveLength(1);
  });

  it("a DOWN-ONLY channel alerts again on the NEXT outage after recovery", async () => {
    const state: WorkerState = { version: 1, sites: {}, alerts: {} };
    const ch = [tg({ id: "d", events: ["down"] })]; // never receives "up"
    const r = recorder();
    await dispatchNotifications([down()], ch, state, env, T, r.send); // outage 1
    // recovery: reconcile clears the ledger for this (site, down) — simulate it
    delete state.alerts!["d:acme:down"];
    await dispatchNotifications([down()], ch, state, env, T, r.send); // outage 2
    expect(r.calls.filter((c) => c.type === "down")).toHaveLength(2);
  });

  it("SSL escalation thresholds each alert (not de-duped)", async () => {
    const state: WorkerState = { version: 1, sites: {}, alerts: {} };
    const ch = [tg({ events: ["ssl"] })];
    const r = recorder();
    // reconcile emits one ssl event per tighter crossing (30 → 15 → 7)
    for (const days of [30, 15, 7]) {
      await dispatchNotifications(
        [event({ type: "ssl", ssl: { daysRemaining: days } as NotifyEvent["ssl"] })],
        ch,
        state,
        env,
        T,
        r.send,
      );
    }
    expect(r.calls.filter((c) => c.type === "ssl")).toHaveLength(3);
  });

  it("minDownMinutes delays then sends exactly once", async () => {
    const state: WorkerState = { version: 1, sites: {}, alerts: {} };
    const ch = [tg({ minDownMinutes: 30 })];
    const r = recorder();
    const t0 = Date.parse("2026-01-01T00:00:00.000Z");
    // tick at +10min: still under window → suppressed
    await dispatchNotifications([down()], ch, state, env, t0 + 10 * 60_000, r.send);
    expect(r.calls).toHaveLength(0);
    // tick at +31min: window passed → sent
    await dispatchNotifications([down()], ch, state, env, t0 + 31 * 60_000, r.send);
    // tick at +36min: already alerted → suppressed
    await dispatchNotifications([down()], ch, state, env, t0 + 36 * 60_000, r.send);
    expect(r.calls).toHaveLength(1);
  });

  it("a throwing channel send never aborts the dispatch", async () => {
    const state: WorkerState = { version: 1, sites: {}, alerts: {} };
    const ch = [tg({ id: "boom" }), tg({ id: "ok" })];
    const calls: string[] = [];
    const send = async (c: ChannelConfig) => {
      if (c.id === "boom") throw new Error("kaboom");
      calls.push(c.id);
      return { ok: true as const };
    };
    const sent = await dispatchNotifications([down()], ch, state, env, T, send);
    expect(calls).toEqual(["ok"]); // the good channel still ran
    expect(sent).toBe(1);
  });
});
