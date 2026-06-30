// Generates realistic demo data under packages/dashboard/public/data for local
// dev + build. In production the deploy step copies the engine's real /data
// over these files; this is only a self-contained fallback so the SPA renders
// out of the box. Run: node scripts/gen-demo-data.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(here, "../public/data");
const HIST = join(OUT, "history");
mkdirSync(HIST, { recursive: true });

const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const day = 86400e3;

// Deterministic PRNG so demo data is stable between runs.
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const brand = {
  name: "Pulse",
  tagline: "Real-time status for everything we run.",
  primaryColor: "#22c55e",
  website: "https://example.com",
  supportUrl: "https://example.com/support",
};

const groups = [
  { id: "acme", name: "Acme Inc", icon: "🏢" },
  { id: "deps", name: "Upstream Services", icon: "🔌" },
];

/** @type {Array<any>} */
const siteDefs = [
  { id: "acme-website", name: "Acme Website", url: "https://example.com", group: "acme", baseMs: 180, rel: 0.999, ssl: 64, domain: 210, tags: ["marketing", "primary"], public: true },
  { id: "acme-app", name: "Acme App", url: "https://example.org", group: "acme", baseMs: 320, rel: 0.985, ssl: 8, down: true, public: true },
  { id: "acme-api", name: "Acme API", url: "https://example.net", group: "acme", baseMs: 140, rel: 0.997, ssl: 19, public: false, degrade: true },
  { id: "acme-database", name: "Acme Database", url: "example.com:443", group: "acme", baseMs: 12, rel: 0.9999, public: false },
  { id: "github-api", name: "GitHub API", url: "https://api.github.com", group: "deps", baseMs: 95, rel: 0.9995, ssl: 70, public: true },
  { id: "wikipedia", name: "Wikipedia", url: "https://www.wikipedia.org", group: "deps", baseMs: 90, rel: 1, ssl: 55, public: true },
  { id: "cloudflare", name: "Cloudflare", url: "https://www.cloudflare.com", group: "deps", baseMs: 45, rel: 0.9992, ssl: 90, domain: 300, public: true, paused: true },
];

function statusFor(rnd, rel, forceDown, forceDegrade) {
  const r = rnd();
  if (forceDown && r < 0.03) return "down";
  if (r > rel) return r > rel + (1 - rel) / 2 ? "down" : "degraded";
  if (forceDegrade && r > rel - 0.01) return "degraded";
  return "up";
}

const summarySites = [];
const allIncidents = [];

for (const def of siteDefs) {
  const rnd = mulberry32(def.id.split("").reduce((a, c) => a + c.charCodeAt(0), 7));

  // --- 5-min raw points for the last 24h ---
  const points = [];
  const step = 5 * 60e3;
  let up24 = 0;
  let total24 = 0;
  let sumMs = 0;
  let msCount = 0;
  for (let t = now - day; t <= now; t += step) {
    let s = statusFor(rnd, def.rel, def.down, def.degrade);
    // Acme storefront has a recent ongoing outage in the last ~40m.
    if (def.down && t > now - 40 * 60e3) s = "down";
    const ms =
      s === "down"
        ? null
        : Math.round(def.baseMs * (s === "degraded" ? 3.2 : 1) * (0.8 + rnd() * 0.5));
    const p = { t: iso(t), s, ms };
    if (s !== "up") p.e = s === "down" ? "Connection timed out" : "Slow response";
    if (def.group !== undefined && def.url.startsWith("http")) p.c = s === "down" ? 0 : s === "degraded" ? 200 : 200;
    points.push(p);
    total24++;
    if (s === "up") up24++;
    if (ms != null) {
      sumMs += ms;
      msCount++;
    }
  }

  // --- 90 daily rollups ---
  const daily = [];
  let up90 = 0;
  let up30 = 0;
  let up7 = 0;
  let n30 = 0;
  let n7 = 0;
  for (let d = 89; d >= 0; d--) {
    const date = new Date(now - d * day);
    const ymd = date.toISOString().slice(0, 10);
    const total = 288;
    // Occasional bad days for sites with lower reliability.
    const dipChance = (1 - def.rel) * 6;
    const bad = rnd() < dipChance;
    const downCount = bad ? Math.floor(rnd() * 30) + 2 : rnd() < 0.1 ? 1 : 0;
    const degradedCount = bad ? Math.floor(rnd() * 20) : Math.floor(rnd() * 4);
    const upCount = Math.max(0, total - downCount - degradedCount);
    const uptime = (upCount + degradedCount * 0.5) / total;
    daily.push({
      d: ymd,
      up: upCount,
      down: downCount,
      degraded: degradedCount,
      total,
      uptime: Math.round(uptime * 10000) / 10000,
      avgMs: Math.round(def.baseMs * (0.9 + rnd() * 0.4)),
    });
    up90 += uptime;
    if (d < 30) {
      up30 += uptime;
      n30++;
    }
    if (d < 7) {
      up7 += uptime;
      n7++;
    }
  }

  writeFileSync(join(HIST, `${def.id}.json`), JSON.stringify({ id: def.id, points, daily }, null, 2));

  // --- summary site ---
  const last = points[points.length - 1];
  const status = def.paused ? "up" : last.s;
  const spark = points.slice(-45).map((p) => p.s);
  const uptime24h = total24 > 0 ? up24 / total24 : 1;

  const siteSummary = {
    id: def.id,
    name: def.name,
    url: def.url,
    group: def.group,
    public: def.public !== false,
    status,
    responseTime: def.paused ? null : last.ms,
    lastChecked: last.t,
    uptime24h: Math.round(uptime24h * 10000) / 10000,
    uptime7d: Math.round((up7 / Math.max(1, n7)) * 10000) / 10000,
    uptime30d: Math.round((up30 / Math.max(1, n30)) * 10000) / 10000,
    uptime90d: Math.round((up90 / 90) * 10000) / 10000,
    avgResponse24h: msCount > 0 ? Math.round(sumMs / msCount) : null,
    spark,
  };
  if (def.paused) siteSummary.paused = true;
  if (def.tags) siteSummary.tags = def.tags;
  if (last.s !== "up" && last.e) siteSummary.error = last.e;
  if (def.url.startsWith("http") && last.c) siteSummary.httpStatus = last.c;
  if (def.ssl != null) {
    siteSummary.ssl = {
      validTo: iso(now + def.ssl * day),
      daysRemaining: def.ssl,
      issuer: "Let's Encrypt",
      subject: def.url.replace(/^https?:\/\//, "").split("/")[0],
      expiringSoon: def.ssl <= 30,
    };
  }
  if (def.domain != null) {
    siteSummary.domain = {
      expiresAt: iso(now + def.domain * day),
      daysRemaining: def.domain,
      registrar: "Cloudflare Registrar",
      expiringSoon: def.domain <= 30,
    };
  }
  summarySites.push(siteSummary);
}

// --- incidents ---
allIncidents.push(
  {
    id: "inc-acme-app-down-1",
    siteId: "acme-app",
    siteName: "Acme App",
    type: "down",
    state: "open",
    title: "Acme App is unreachable",
    detail: "Origin returning connection timeouts from all regions.",
    startedAt: iso(now - 40 * 60e3),
    updates: [
      { at: iso(now - 38 * 60e3), message: "Investigating elevated error rates." },
      { at: iso(now - 20 * 60e3), message: "Identified an upstream provider outage." },
    ],
  },
  {
    id: "inc-acme-app-ssl-1",
    siteId: "acme-app",
    siteName: "Acme App",
    type: "ssl_expiring",
    state: "open",
    title: "TLS certificate expires in 8 days",
    detail: "Renew the certificate to avoid an outage.",
    startedAt: iso(now - 2 * day),
  },
  {
    id: "inc-acme-api-degraded-1",
    siteId: "acme-api",
    siteName: "Acme API",
    type: "degraded",
    state: "resolved",
    title: "Elevated response times on the API",
    startedAt: iso(now - 3 * day),
    resolvedAt: iso(now - 3 * day + 72 * 60e3),
    durationMs: 72 * 60e3,
  },
  {
    id: "inc-acme-website-down-1",
    siteId: "acme-website",
    siteName: "Acme Website",
    type: "down",
    state: "resolved",
    title: "Brief outage during a deploy",
    detail: "A bad release caused 5xx responses; rolled back.",
    startedAt: iso(now - 11 * day),
    resolvedAt: iso(now - 11 * day + 9 * 60e3),
    durationMs: 9 * 60e3,
  },
);

writeFileSync(join(OUT, "incidents.json"), JSON.stringify(allIncidents, null, 2));

// --- groups summary ---
function overall(statuses) {
  if (statuses.length === 0) return "operational";
  const down = statuses.filter((s) => s === "down").length;
  const degraded = statuses.filter((s) => s === "degraded").length;
  if (down === 0 && degraded === 0) return "operational";
  if (down >= statuses.length) return "major_outage";
  if (down > 0) return "partial_outage";
  return "degraded";
}

const groupSummaries = groups.map((g) => {
  const sites = summarySites.filter((s) => s.group === g.id);
  return {
    id: g.id,
    name: g.name,
    icon: g.icon,
    status: overall(sites.filter((s) => !s.paused).map((s) => s.status)),
    siteIds: sites.map((s) => s.id),
  };
});

const active = summarySites.filter((s) => !s.paused);
const totals = {
  sites: summarySites.length,
  up: active.filter((s) => s.status === "up").length,
  down: active.filter((s) => s.status === "down").length,
  degraded: active.filter((s) => s.status === "degraded").length,
  paused: summarySites.filter((s) => s.paused).length,
  uptime:
    Math.round((active.reduce((a, s) => a + s.uptime24h, 0) / Math.max(1, active.length)) * 10000) /
    10000,
};

const summary = {
  generatedAt: iso(now),
  brand,
  overall: overall(active.map((s) => s.status)),
  totals,
  groups: groupSummaries,
  sites: summarySites,
  incidents: allIncidents.slice(0, 6),
};

writeFileSync(join(OUT, "summary.json"), JSON.stringify(summary, null, 2));

// --- permissions (demo) ---
const permissions = {
  users: [
    { email: "owner@example.com", role: "SUPER_ADMIN" },
    { email: "ops@example.com", role: "ADMIN" },
    { email: "client@example.com", role: "CLIENT", groups: ["acme"], sites: ["acme-website", "acme-app"] },
    { email: "viewer@example.com", role: "VIEWER", groups: ["deps"] },
  ],
};
writeFileSync(join(OUT, "permissions.json"), JSON.stringify(permissions, null, 2));

console.log(`Demo data written to ${OUT}`);
