#!/usr/bin/env node
/**
 * Blip — demo data seeder.
 *
 * Generates realistic, type-correct sample data under the repo-root `/data` so
 * that `npm run dev` shows a live-looking dashboard immediately.
 *
 *   node scripts/seed-demo.mjs    (or: npm run seed)
 *
 * It reads `blip.config.yaml` (using the `yaml` package, hoisted to the root
 * node_modules after `npm install`). If the config can't be read/parsed, it
 * falls back to a small built-in set of demo sites.
 *
 * Output (all conforming to packages/shared/src/types.ts):
 *   data/summary.json          → Summary
 *   data/history/<id>.json     → SiteHistory  (one per site)
 *   data/incidents.json        → Incident[]
 *   data/permissions.json      → Permissions  (sample)
 *
 * Generation is deterministic (seeded PRNG) so output is stable across runs.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const CONFIG_PATH = join(ROOT, "blip.config.yaml");
const DATA_DIR = join(ROOT, "data");
const HISTORY_DIR = join(DATA_DIR, "history");

// ── constants mirrored from packages/shared ─────────────────────────────────
const MAX_HISTORY_POINTS = 2016; // ~7 days @ 5-min, matches DEFAULTS.maxHistoryPoints
const INTERVAL_MS = 5 * 60 * 1000;
const DAYS = 90;

// ── slugify (mirror of packages/shared/src/constants.ts) ────────────────────
function slugify(input) {
  return (
    String(input)
      .toLowerCase()
      .trim()
      .replace(/^https?:\/\//, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "site"
  );
}

// ── overallStatus (mirror of packages/shared/src/constants.ts) ──────────────
function overallStatus(statuses) {
  if (statuses.length === 0) return "operational";
  const down = statuses.filter((s) => s === "down").length;
  const degraded = statuses.filter((s) => s === "degraded").length;
  if (down === 0 && degraded === 0) return "operational";
  if (down >= statuses.length) return "major_outage";
  if (down > 0) return "partial_outage";
  return "degraded";
}

// ── deterministic PRNG (mulberry32) ─────────────────────────────────────────
function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// ── load sites from config, or fall back ────────────────────────────────────
async function loadSites() {
  try {
    if (!existsSync(CONFIG_PATH)) throw new Error("no config file");
    const { parse } = await import("yaml");
    const raw = await readFile(CONFIG_PATH, "utf8");
    // Strip ${ENV_VAR} so unparsed secrets never break things or leak.
    const cfg = parse(raw.replace(/\$\{[A-Z0-9_]+\}/gi, "REDACTED"));
    if (!cfg?.sites?.length) throw new Error("config has no sites");

    const usedIds = new Set();
    const groups = cfg.groups ?? [];
    const sites = cfg.sites.map((s) => {
      let id = (s.id?.trim() || slugify(s.name));
      if (usedIds.has(id)) {
        let n = 2;
        while (usedIds.has(`${id}-${n}`)) n++;
        id = `${id}-${n}`;
      }
      usedIds.add(id);
      return {
        id,
        name: s.name,
        url: s.url,
        group: s.group,
        description: s.description,
        tags: s.tags,
        public: s.public ?? true,
        paused: s.paused ?? false,
        ssl: Boolean(s.ssl),
        domain: Boolean(s.domain),
      };
    });
    return {
      brand: cfg.brand ?? { name: "Blip", tagline: "Real-time status.", primaryColor: "#22c55e" },
      groups,
      sites,
    };
  } catch (err) {
    process.stdout.write(`  (config unavailable: ${err.message} — using built-in demo sites)\n`);
    return fallback();
  }
}

function fallback() {
  return {
    brand: { name: "Blip", tagline: "Real-time status for everything we run.", primaryColor: "#22c55e" },
    groups: [
      { id: "acme", name: "Acme Inc", icon: "🏢" },
      { id: "deps", name: "Upstream Services", icon: "🔌" },
    ],
    sites: [
      { id: "acme-website", name: "Acme Website", url: "https://example.com", group: "acme", public: true, paused: false, ssl: true, domain: true, tags: ["marketing"] },
      { id: "acme-app", name: "Acme App", url: "https://example.org", group: "acme", public: true, paused: false, ssl: true, domain: false },
      { id: "acme-api", name: "Acme API", url: "https://example.net", group: "acme", public: false, paused: false, ssl: true, domain: false },
      { id: "acme-database", name: "Acme Database", url: "example.com:443", group: "acme", public: false, paused: false, ssl: false, domain: false },
      { id: "github-api", name: "GitHub API", url: "https://api.github.com", group: "deps", public: true, paused: false, ssl: true, domain: false },
      { id: "wikipedia", name: "Wikipedia", url: "https://www.wikipedia.org", group: "deps", public: true, paused: false, ssl: true, domain: false },
      { id: "cloudflare", name: "Cloudflare", url: "https://www.cloudflare.com", group: "deps", public: true, paused: false, ssl: true, domain: true },
    ],
  };
}

// ── synthesize a status for a given moment, biased mostly-up ────────────────
// Returns "up" | "degraded" | "down".
function rollStatus(rng, downBias, degradedBias) {
  const r = rng();
  if (r < downBias) return "down";
  if (r < downBias + degradedBias) return "degraded";
  return "up";
}

function round(n) {
  return Math.round(n);
}

function iso(ts) {
  return new Date(ts).toISOString();
}

// ── build history (points + daily) for one site ─────────────────────────────
function buildHistory(site, now) {
  const rng = makeRng(hashSeed(site.id));
  const baseMs = 80 + Math.floor(rng() * 260); // typical response time baseline
  const paused = site.paused;

  // Per-site reliability: most sites are very healthy.
  const downBias = paused ? 0 : 0.004 + rng() * 0.01; // ~0.4%–1.4%
  const degradedBias = paused ? 0 : 0.015 + rng() * 0.03; // ~1.5%–4.5%

  // ── recent raw points (last MAX_HISTORY_POINTS @ 5-min) ──
  const points = [];
  const startMs = now - (MAX_HISTORY_POINTS - 1) * INTERVAL_MS;
  // Inject one contiguous outage window for visual interest (skip paused).
  const outageStart = paused ? -1 : Math.floor(MAX_HISTORY_POINTS * (0.2 + rng() * 0.5));
  const outageLen = paused ? 0 : 3 + Math.floor(rng() * 6);

  for (let i = 0; i < MAX_HISTORY_POINTS; i++) {
    const t = startMs + i * INTERVAL_MS;
    let s;
    if (paused) {
      s = "up"; // a paused site keeps its last-known state; treat as up for demo
    } else if (i >= outageStart && i < outageStart + outageLen) {
      s = i === outageStart || i === outageStart + outageLen - 1 ? "degraded" : "down";
    } else {
      s = rollStatus(rng, downBias, degradedBias);
    }

    const point = { t: iso(t), s, ms: null };
    if (s === "down") {
      point.ms = null;
      point.c = rng() < 0.5 ? 503 : 502;
      point.e = "Connection timed out";
    } else {
      const jitter = (rng() - 0.5) * baseMs * 0.5;
      const slow = s === "degraded" ? baseMs * (2 + rng() * 2) : 0;
      point.ms = Math.max(8, round(baseMs + jitter + slow));
      point.c = 200;
      if (s === "degraded") point.e = "Slow response";
    }
    points.push(point);
  }

  // ── 90 days of daily rollups (oldest → newest) ──
  const daily = [];
  const today = new Date(now);
  for (let d = DAYS - 1; d >= 0; d--) {
    const day = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - d));
    const dayKey = day.toISOString().slice(0, 10);
    const drng = makeRng(hashSeed(`${site.id}:${dayKey}`));
    const total = 288; // checks per day @ 5-min
    let down = 0;
    let degraded = 0;
    if (!paused) {
      // Occasional bad day.
      const badDay = drng() < 0.06;
      down = badDay ? 2 + Math.floor(drng() * 20) : Math.floor(drng() * 2);
      degraded = Math.floor(drng() * (badDay ? 25 : 8));
    }
    down = Math.min(down, total);
    degraded = Math.min(degraded, total - down);
    const up = total - down - degraded;
    const uptime = round1((up + degraded * 0.5) / total);
    const avgMs = paused ? null : round(baseMs + (drng() - 0.5) * baseMs * 0.3 + degraded * 4);
    daily.push({ d: dayKey, up, down, degraded, total, uptime, avgMs });
  }

  return { history: { id: site.id, points, daily }, baseMs };
}

function round1(n) {
  return Math.round(n * 1000) / 1000;
}

// ── uptime over the last N days from daily rollups ──────────────────────────
function uptimeOverDays(daily, n) {
  const slice = daily.slice(-n);
  let up = 0;
  let total = 0;
  for (const d of slice) {
    up += d.up + d.degraded * 0.5;
    total += d.total;
  }
  return total ? round1(up / total) : 1;
}

// ── build SSL / domain info ─────────────────────────────────────────────────
function buildSsl(site, now) {
  if (!site.ssl) return undefined;
  const rng = makeRng(hashSeed(`${site.id}:ssl`));
  // Mostly healthy; one site is "expiring soon" for demo.
  const days = site.id.endsWith("storefront") ? 12 : 40 + Math.floor(rng() * 300);
  const validTo = iso(now + days * 86400000);
  return {
    validTo,
    daysRemaining: days,
    issuer: "Let's Encrypt",
    subject: site.url.replace(/^https?:\/\//, "").split("/")[0],
    expiringSoon: days <= 30,
  };
}

function buildDomain(site, now) {
  if (!site.domain) return undefined;
  const rng = makeRng(hashSeed(`${site.id}:domain`));
  const days = 60 + Math.floor(rng() * 600);
  return {
    expiresAt: iso(now + days * 86400000),
    daysRemaining: days,
    registrar: "Cloudflare, Inc.",
    expiringSoon: days <= 30,
  };
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  process.stdout.write("⚡ Blip — seeding demo data\n");
  const { brand, groups, sites } = await loadSites();
  const now = Date.now();

  // Fresh /data tree.
  if (existsSync(DATA_DIR)) await rm(DATA_DIR, { recursive: true, force: true });
  await mkdir(HISTORY_DIR, { recursive: true });

  const siteSummaries = [];
  const incidents = [];
  let incCounter = 0;

  for (const site of sites) {
    const { history } = buildHistory(site, now);
    await writeFile(join(HISTORY_DIR, `${site.id}.json`), JSON.stringify(history, null, 2) + "\n", "utf8");

    const points = history.points;
    const last = points[points.length - 1];
    const status = site.paused ? "up" : last.s;

    // 24h average response.
    const last24 = points.slice(-288).map((p) => p.ms).filter((m) => m != null);
    const avgResponse24h = last24.length ? round(last24.reduce((a, b) => a + b, 0) / last24.length) : null;

    // Sparkline: last 45 buckets.
    const spark = points.slice(-45).map((p) => p.s);

    const ssl = buildSsl(site, now);
    const domain = buildDomain(site, now);

    siteSummaries.push({
      id: site.id,
      name: site.name,
      url: site.url,
      group: site.group,
      description: site.description,
      tags: site.tags,
      public: site.public,
      status,
      paused: site.paused || undefined,
      responseTime: status === "down" ? null : last.ms,
      httpStatus: last.c,
      lastChecked: last.t,
      error: status !== "up" ? last.e : undefined,
      uptime24h: uptimeOverDays(history.daily, 1),
      uptime7d: uptimeOverDays(history.daily, 7),
      uptime30d: uptimeOverDays(history.daily, 30),
      uptime90d: uptimeOverDays(history.daily, 90),
      avgResponse24h,
      ssl,
      domain,
      spark,
    });

    // ── synthesize incidents ──
    // A couple of resolved incidents from history's bad days.
    const badDays = history.daily.filter((d) => d.down > 5).slice(-2);
    for (const bd of badDays) {
      const startedAt = `${bd.d}T09:${String(10 + (incCounter % 40)).padStart(2, "0")}:00.000Z`;
      const durationMs = (15 + (incCounter % 6) * 10) * 60000;
      incidents.push({
        id: `inc-${++incCounter}`,
        siteId: site.id,
        siteName: site.name,
        type: "down",
        state: "resolved",
        title: `${site.name} was unreachable`,
        detail: "Upstream returned 5xx / connection timeouts.",
        startedAt,
        resolvedAt: iso(Date.parse(startedAt) + durationMs),
        durationMs,
        updates: [
          { at: startedAt, message: "Investigating elevated error rates." },
          { at: iso(Date.parse(startedAt) + durationMs), message: "Recovered — all checks green." },
        ],
      });
    }
  }

  // One active SSL-expiring incident for the site we made expire soon.
  const expiring = siteSummaries.find((s) => s.ssl?.expiringSoon);
  if (expiring) {
    incidents.unshift({
      id: `inc-${++incCounter}`,
      siteId: expiring.id,
      siteName: expiring.name,
      type: "ssl_expiring",
      state: "open",
      title: `TLS certificate for ${expiring.name} expires soon`,
      detail: `Certificate expires in ${expiring.ssl.daysRemaining} days. Renew before ${expiring.ssl.validTo.slice(0, 10)}.`,
      startedAt: iso(now - 3 * 3600000),
      updates: [{ at: iso(now - 3 * 3600000), message: "Renewal recommended." }],
    });
  }

  // One active "down" incident if any site is currently down; else degrade one for realism.
  const downNow = siteSummaries.find((s) => s.status === "down");
  if (downNow) {
    incidents.unshift({
      id: `inc-${++incCounter}`,
      siteId: downNow.id,
      siteName: downNow.name,
      type: "down",
      state: "open",
      title: `${downNow.name} is down`,
      detail: downNow.error ?? "Health check failing.",
      startedAt: iso(now - 12 * 60000),
      updates: [{ at: iso(now - 12 * 60000), message: "Outage detected; investigating." }],
    });
  }

  // Sort incidents most-recent first.
  incidents.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));

  // ── group summaries ──
  const groupSummaries = (groups.length ? groups : inferGroups(siteSummaries)).map((g) => {
    const members = siteSummaries.filter((s) => s.group === g.id);
    return {
      id: g.id,
      name: g.name,
      description: g.description,
      icon: g.icon,
      status: overallStatus(members.map((s) => s.status)),
      siteIds: members.map((s) => s.id),
    };
  });

  // ── totals ──
  const up = siteSummaries.filter((s) => s.status === "up" && !s.paused).length;
  const down = siteSummaries.filter((s) => s.status === "down").length;
  const degraded = siteSummaries.filter((s) => s.status === "degraded").length;
  const paused = siteSummaries.filter((s) => s.paused).length;
  const totals = {
    sites: siteSummaries.length,
    up,
    down,
    degraded,
    paused,
    uptime: round1(
      siteSummaries.reduce((acc, s) => acc + s.uptime24h, 0) / Math.max(1, siteSummaries.length),
    ),
  };

  const summary = {
    generatedAt: iso(now),
    brand,
    overall: overallStatus(siteSummaries.filter((s) => !s.paused).map((s) => s.status)),
    totals,
    groups: groupSummaries,
    sites: siteSummaries,
    // Active + recently resolved, most recent first (cap for payload size).
    incidents: incidents.slice(0, 20),
  };

  // ── permissions sample ──
  const firstGroup = groupSummaries[0]?.id;
  const clientSite = siteSummaries.find((s) => s.group === groupSummaries[1]?.id)?.id;
  const permissions = {
    users: [
      { email: "owner@example.com", role: "SUPER_ADMIN" },
      { email: "ops@example.com", role: "ADMIN" },
      {
        email: "client@example.com",
        role: "CLIENT",
        groups: groupSummaries[1] ? [groupSummaries[1].id] : [],
        sites: clientSite ? [clientSite] : [],
      },
      { email: "viewer@example.com", role: "VIEWER", groups: firstGroup ? [firstGroup] : [] },
    ],
  };

  await writeFile(join(DATA_DIR, "summary.json"), JSON.stringify(summary, null, 2) + "\n", "utf8");
  await writeFile(join(DATA_DIR, "incidents.json"), JSON.stringify(incidents, null, 2) + "\n", "utf8");
  await writeFile(join(DATA_DIR, "permissions.json"), JSON.stringify(permissions, null, 2) + "\n", "utf8");

  // ── report ──
  process.stdout.write("\n✓ Demo data written to /data:\n");
  process.stdout.write(`  • summary.json        ${siteSummaries.length} sites, ${groupSummaries.length} groups, overall "${summary.overall}"\n`);
  process.stdout.write(`  • history/*.json      ${siteSummaries.length} files (${MAX_HISTORY_POINTS} points + ${DAYS} daily rollups each)\n`);
  process.stdout.write(`  • incidents.json      ${incidents.length} incidents (${incidents.filter((i) => i.state === "open").length} active)\n`);
  process.stdout.write(`  • permissions.json    ${permissions.users.length} sample users\n`);
  process.stdout.write("\nRun `npm run dev` to view the dashboard.\n");
}

function inferGroups(siteSummaries) {
  const ids = [...new Set(siteSummaries.map((s) => s.group).filter(Boolean))];
  return ids.map((id) => ({ id, name: id }));
}

main().catch((err) => {
  process.stderr.write(`\nSeed failed: ${err?.stack ?? err}\n`);
  process.exit(1);
});
