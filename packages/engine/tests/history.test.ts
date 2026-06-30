import { describe, expect, it } from "vitest";
import type { CheckResult, SiteHistory } from "@blip/shared";
import {
  appendPoint,
  buildSpark,
  computeStats,
  pointFromResult,
} from "../src/store/history.js";

function result(status: CheckResult["status"], ms: number | null, at: string): CheckResult {
  return { siteId: "s1", status, responseTime: ms, checkedAt: at };
}

const empty: SiteHistory = { id: "s1", points: [], daily: [] };

describe("appendPoint", () => {
  it("appends and caps to maxHistoryPoints (drops oldest)", () => {
    let h = empty;
    for (let i = 0; i < 5; i++) {
      h = appendPoint(h, pointFromResult(result("up", 100, `2026-01-01T00:0${i}:00.000Z`)), 3);
    }
    expect(h.points).toHaveLength(3);
    // oldest dropped — first remaining is minute :02
    expect(h.points[0]!.t).toBe("2026-01-01T00:02:00.000Z");
  });

  it("maintains one daily rollup per UTC day with uptime ratio", () => {
    let h = empty;
    h = appendPoint(h, pointFromResult(result("up", 100, "2026-01-01T01:00:00.000Z")), 100);
    h = appendPoint(h, pointFromResult(result("down", null, "2026-01-01T02:00:00.000Z")), 100);
    h = appendPoint(h, pointFromResult(result("up", 300, "2026-01-02T01:00:00.000Z")), 100);
    expect(h.daily).toHaveLength(2);
    const day1 = h.daily.find((d) => d.d === "2026-01-01")!;
    expect(day1.total).toBe(2);
    expect(day1.up).toBe(1);
    expect(day1.down).toBe(1);
    expect(day1.uptime).toBeCloseTo(0.5);
    expect(day1.avgMs).toBe(100); // only the up point had a time
    const day2 = h.daily.find((d) => d.d === "2026-01-02")!;
    expect(day2.uptime).toBe(1);
    expect(day2.avgMs).toBe(300);
  });

  it("averages response times correctly across multiple points in a day", () => {
    let h = empty;
    h = appendPoint(h, pointFromResult(result("up", 100, "2026-01-01T01:00:00.000Z")), 100);
    h = appendPoint(h, pointFromResult(result("up", 300, "2026-01-01T02:00:00.000Z")), 100);
    const day = h.daily[0]!;
    expect(day.avgMs).toBe(200);
  });
});

describe("computeStats uptime windows", () => {
  it("computes 24h uptime from recent points with degraded weighting", () => {
    const now = Date.parse("2026-06-18T12:00:00.000Z");
    const h: SiteHistory = {
      id: "s1",
      points: [
        pointFromResult(result("up", 100, "2026-06-18T11:00:00.000Z")),
        pointFromResult(result("degraded", 2500, "2026-06-18T11:30:00.000Z")),
      ],
      daily: [],
    };
    const stats = computeStats(h, now);
    // (1 + 0.5) / 2 = 0.75
    expect(stats.uptime24h).toBeCloseTo(0.75);
    // avg over up(100)+degraded(2500) = 1300
    expect(stats.avgResponse24h).toBe(1300);
  });

  it("returns 1.0 (healthy) when there is no data", () => {
    const stats = computeStats(empty, Date.now());
    expect(stats.uptime24h).toBe(1);
    expect(stats.uptime90d).toBe(1);
    expect(stats.avgResponse24h).toBeNull();
  });

  it("falls back to daily rollups for long windows", () => {
    const now = Date.parse("2026-06-18T12:00:00.000Z");
    const h: SiteHistory = {
      id: "s1",
      points: [],
      daily: [
        { d: "2026-05-20", up: 8, down: 2, degraded: 0, total: 10, uptime: 0.8, avgMs: 120 },
      ],
    };
    const stats = computeStats(h, now);
    expect(stats.uptime30d).toBeCloseTo(0.8);
  });
});

describe("buildSpark", () => {
  it("returns empty for no points", () => {
    expect(buildSpark([])).toEqual([]);
  });

  it("caps to the bucket count and surfaces worst status per bucket", () => {
    const pts = Array.from({ length: 90 }, (_v, i) =>
      pointFromResult(result(i === 89 ? "down" : "up", 100, `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z`)),
    );
    const spark = buildSpark(pts, 45);
    expect(spark.length).toBeLessThanOrEqual(45);
    // the last bucket contains the down point
    expect(spark[spark.length - 1]).toBe("down");
  });
});
