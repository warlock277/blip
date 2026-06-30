import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULTS } from "@blip/shared";
import {
  checkHttp,
  evalJsonAssertion,
  resolveJsonPath,
  statusMatches,
} from "../src/checks/http.js";
import type { ResolvedSite } from "../src/config.js";

function site(partial: Partial<ResolvedSite>): ResolvedSite {
  return {
    id: "s1",
    name: "S1",
    url: "https://example.com",
    type: "http",
    public: true,
    paused: false,
    retries: 0, // keep tests fast — no retries
    ...partial,
  };
}

function mockFetch(status: number, body = "", delayMs = 0): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      return {
        status,
        text: async () => body,
        arrayBuffer: async () => new ArrayBuffer(0),
      } as unknown as Response;
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("statusMatches", () => {
  it("uses 200-399 by default", () => {
    expect(statusMatches(200, undefined)).toBe(true);
    expect(statusMatches(399, undefined)).toBe(true);
    expect(statusMatches(404, undefined)).toBe(false);
  });
  it("matches a single expected code", () => {
    expect(statusMatches(204, 204)).toBe(true);
    expect(statusMatches(200, 204)).toBe(false);
  });
  it("matches an array of codes", () => {
    expect(statusMatches(201, [200, 201])).toBe(true);
    expect(statusMatches(202, [200, 201])).toBe(false);
  });
});

describe("resolveJsonPath", () => {
  const obj = { a: { b: [{ c: "ok" }] }, "weird key": 5 };
  it("resolves dot paths", () => {
    expect(resolveJsonPath(obj, "a.b[0].c")).toBe("ok");
  });
  it("resolves bracket quoted keys", () => {
    expect(resolveJsonPath(obj, '["weird key"]')).toBe(5);
  });
  it("returns undefined for missing paths", () => {
    expect(resolveJsonPath(obj, "a.x.y")).toBeUndefined();
  });
});

describe("evalJsonAssertion", () => {
  const root = { status: "healthy", db: { connected: true }, msg: "all good" };
  it("passes on equals match", () => {
    expect(evalJsonAssertion(root, { path: "status", equals: "healthy" })).toBeNull();
    expect(evalJsonAssertion(root, { path: "db.connected", equals: true })).toBeNull();
  });
  it("fails on equals mismatch", () => {
    expect(evalJsonAssertion(root, { path: "status", equals: "down" })).toMatch(/expected/);
  });
  it("handles contains", () => {
    expect(evalJsonAssertion(root, { path: "msg", contains: "good" })).toBeNull();
    expect(evalJsonAssertion(root, { path: "msg", contains: "bad" })).toMatch(/contain/);
  });
});

describe("checkHttp", () => {
  it("returns up on a 200", async () => {
    mockFetch(200);
    const r = await checkHttp(site({}), DEFAULTS);
    expect(r.status).toBe("up");
    expect(r.httpStatus).toBe(200);
  });

  it("returns down on unexpected status", async () => {
    mockFetch(500);
    const r = await checkHttp(site({}), DEFAULTS);
    expect(r.status).toBe("down");
    expect(r.httpStatus).toBe(500);
    expect(r.error).toMatch(/500/);
  });

  it("fails when required keyword absent", async () => {
    mockFetch(200, "hello world");
    const r = await checkHttp(site({ keyword: "MISSING" }), DEFAULTS);
    expect(r.status).toBe("down");
    expect(r.error).toMatch(/Keyword/);
  });

  it("passes when keyword present", async () => {
    mockFetch(200, "status: ok");
    const r = await checkHttp(site({ keyword: "ok" }), DEFAULTS);
    expect(r.status).toBe("up");
  });

  it("fails keywordAbsent when forbidden string present", async () => {
    mockFetch(200, "ERROR: boom");
    const r = await checkHttp(site({ keywordAbsent: "ERROR" }), DEFAULTS);
    expect(r.status).toBe("down");
  });

  it("evaluates JSON assertions", async () => {
    mockFetch(200, JSON.stringify({ status: "healthy", db: { connected: true } }));
    const ok = await checkHttp(
      site({ expectJson: [{ path: "status", equals: "healthy" }, { path: "db.connected", equals: true }] }),
      DEFAULTS,
    );
    expect(ok.status).toBe("up");

    mockFetch(200, JSON.stringify({ status: "down" }));
    const bad = await checkHttp(site({ expectJson: [{ path: "status", equals: "healthy" }] }), DEFAULTS);
    expect(bad.status).toBe("down");
  });

  it("marks slow-but-ok responses as degraded", async () => {
    mockFetch(200, "", 30);
    const r = await checkHttp(site({ degradedThresholdMs: 1 }), DEFAULTS);
    expect(r.status).toBe("degraded");
    expect(r.error).toMatch(/Slow/);
  });

  it("never throws on network error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    const r = await checkHttp(site({}), DEFAULTS);
    expect(r.status).toBe("down");
    expect(r.error).toMatch(/ECONNREFUSED/);
    expect(r.responseTime).toBeNull;
  });
});
