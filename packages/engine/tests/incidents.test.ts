import { describe, expect, it } from "vitest";
import type { CheckResult, Incident } from "@blip/shared";
import { reconcileIncidents } from "../src/store/incidents.js";
import type { EngineState } from "../src/store/state.js";
import type { ResolvedSite } from "../src/config.js";

function site(partial: Partial<ResolvedSite> = {}): ResolvedSite {
  return {
    id: "s1",
    name: "Site 1",
    url: "https://s1.example.com",
    type: "http",
    public: true,
    paused: false,
    ...partial,
  };
}

function result(status: CheckResult["status"], opts: Partial<CheckResult> = {}): CheckResult {
  return {
    siteId: "s1",
    status,
    responseTime: status === "down" ? null : 100,
    checkedAt: "2026-06-18T12:00:00.000Z",
    ...opts,
  };
}

function freshState(): EngineState {
  return { version: 1, sites: {}, alerts: {} };
}

const NOW = Date.parse("2026-06-18T12:00:00.000Z");

describe("reconcileIncidents", () => {
  it("opens an incident and emits a down event on up→down", () => {
    const state = freshState();
    state.sites["s1"] = { lastStatus: "up" };
    const results = new Map([["s1", result("down", { error: "HTTP 500" })]]);
    const out = reconcileIncidents({ sites: [site()], results, incidents: [], state, now: NOW });

    expect(out.incidents).toHaveLength(1);
    expect(out.incidents[0]!.state).toBe("open");
    expect(out.incidents[0]!.type).toBe("down");
    const down = out.events.find((e) => e.type === "down");
    expect(down).toBeTruthy();
    expect(state.sites["s1"]!.lastStatus).toBe("down");
    expect(state.sites["s1"]!.downSince).toBe("2026-06-18T12:00:00.000Z");
  });

  it("does not re-open or re-emit while still down", () => {
    const state = freshState();
    state.sites["s1"] = { lastStatus: "down", downSince: "2026-06-18T11:00:00.000Z" };
    const existing: Incident = {
      id: "s1-down-1",
      siteId: "s1",
      siteName: "Site 1",
      type: "down",
      state: "open",
      title: "Site 1 is down",
      startedAt: "2026-06-18T11:00:00.000Z",
    };
    const results = new Map([["s1", result("down")]]);
    const out = reconcileIncidents({
      sites: [site()],
      results,
      incidents: [existing],
      state,
      now: NOW,
    });
    expect(out.incidents.filter((i) => i.state === "open")).toHaveLength(1);
    // no new "down" event because status didn't change
    expect(out.events.find((e) => e.type === "down")).toBeUndefined();
  });

  it("resolves the incident and emits an up event on recovery", () => {
    const state = freshState();
    state.sites["s1"] = { lastStatus: "down", downSince: "2026-06-18T11:00:00.000Z" };
    const existing: Incident = {
      id: "s1-down-1",
      siteId: "s1",
      siteName: "Site 1",
      type: "down",
      state: "open",
      title: "Site 1 is down",
      startedAt: "2026-06-18T11:00:00.000Z",
    };
    const results = new Map([["s1", result("up")]]);
    const out = reconcileIncidents({
      sites: [site()],
      results,
      incidents: [existing],
      state,
      now: NOW,
    });
    const resolved = out.incidents.find((i) => i.id === "s1-down-1")!;
    expect(resolved.state).toBe("resolved");
    expect(resolved.resolvedAt).toBe("2026-06-18T12:00:00.000Z");
    expect(resolved.durationMs).toBe(60 * 60 * 1000); // 1 hour
    const up = out.events.find((e) => e.type === "up");
    expect(up).toBeTruthy();
    expect(up!.durationMs).toBe(60 * 60 * 1000);
    expect(state.sites["s1"]!.downSince).toBeUndefined();
  });

  it("opens an ssl_expiring incident and emits an ssl event when expiring soon", () => {
    const state = freshState();
    state.sites["s1"] = { lastStatus: "up" };
    const results = new Map([
      [
        "s1",
        result("up", {
          ssl: { validTo: "2026-07-01T00:00:00.000Z", daysRemaining: 13, expiringSoon: true },
        }),
      ],
    ]);
    const out = reconcileIncidents({ sites: [site()], results, incidents: [], state, now: NOW });
    expect(out.incidents.find((i) => i.type === "ssl_expiring")).toBeTruthy();
    expect(out.events.find((e) => e.type === "ssl")).toBeTruthy();
    expect(state.sites["s1"]!.sslWarnedDay).toBe(13);
  });

  it("does not re-emit ssl alert at the same threshold but does on a tighter one", () => {
    const state = freshState();
    state.sites["s1"] = { lastStatus: "up", sslWarnedDay: 13 };
    const incidents: Incident[] = [
      {
        id: "s1-ssl_expiring-1",
        siteId: "s1",
        siteName: "Site 1",
        type: "ssl_expiring",
        state: "open",
        title: "Site 1 TLS certificate expiring",
        startedAt: "2026-06-18T11:00:00.000Z",
      },
    ];
    // Same daysRemaining (13) -> no new alert.
    let out = reconcileIncidents({
      sites: [site()],
      results: new Map([
        ["s1", result("up", { ssl: { validTo: "x", daysRemaining: 13, expiringSoon: true } })],
      ]),
      incidents,
      state,
      now: NOW,
    });
    expect(out.events.find((e) => e.type === "ssl")).toBeUndefined();

    // Crossing to 6 days -> new alert.
    out = reconcileIncidents({
      sites: [site()],
      results: new Map([
        ["s1", result("up", { ssl: { validTo: "x", daysRemaining: 6, expiringSoon: true } })],
      ]),
      incidents: out.incidents,
      state,
      now: NOW,
    });
    expect(out.events.find((e) => e.type === "ssl")).toBeTruthy();
    expect(state.sites["s1"]!.sslWarnedDay).toBe(6);
  });

  it("skips paused sites entirely", () => {
    const state = freshState();
    const results = new Map([["s1", result("down")]]);
    const out = reconcileIncidents({
      sites: [site({ paused: true })],
      results,
      incidents: [],
      state,
      now: NOW,
    });
    expect(out.incidents).toHaveLength(0);
    expect(out.events).toHaveLength(0);
  });
});
