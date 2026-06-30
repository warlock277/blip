import { describe, expect, it } from "vitest";
import { reconcile, type SiteResult } from "../src/incidents.js";
import type { ResolvedSite } from "../src/config-types.js";
import type { WorkerState } from "../src/state.js";

const site = {
  id: "s1",
  name: "S1",
  url: "https://s1.example.com",
  type: "http",
  public: true,
  paused: false,
  ssl: false,
  domain: false,
} as unknown as ResolvedSite;

const results = (status: SiteResult["status"]) =>
  new Map<string, SiteResult>([["s1", { status }]]);

const T = Date.parse("2026-01-01T00:00:00.000Z");

describe("reconcile — notification events", () => {
  it("emits down every tick while failing, then up on recovery, and clears the ledger", () => {
    const state: WorkerState = { version: 1, sites: {}, alerts: {} };

    // tick 1: up→down
    let out = reconcile([], { prevState: state, results: results("down"), sites: [site], now: T });
    expect(out.events.filter((e) => e.type === "down")).toHaveLength(1);
    expect(out.events[0]!.since).toBe("2026-01-01T00:00:00.000Z"); // carries downSince

    // tick 2: still down → STILL emits (so minDownMinutes can be satisfied later)
    out = reconcile(out.incidents, {
      prevState: out.state,
      results: results("down"),
      sites: [site],
      now: T + 300_000,
    });
    expect(out.events.some((e) => e.type === "down")).toBe(true);

    // a prior alert is recorded in the ledger for this outage
    out.state.alerts!["tg:s1:down"] = "2026-01-01T00:05:00.000Z";

    // tick 3: recovery → emits up AND clears the ledger so the next outage alerts
    out = reconcile(out.incidents, {
      prevState: out.state,
      results: results("up"),
      sites: [site],
      now: T + 600_000,
    });
    expect(out.events.some((e) => e.type === "up")).toBe(true);
    expect(out.state.alerts!["tg:s1:down"]).toBeUndefined();
  });

  it("a freshly-seen up site emits nothing", () => {
    const state: WorkerState = { version: 1, sites: {}, alerts: {} };
    const out = reconcile([], { prevState: state, results: results("up"), sites: [site], now: T });
    expect(out.events).toHaveLength(0);
  });
});
