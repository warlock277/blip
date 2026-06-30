/**
 * Blip Worker entry point.
 *
 *   scheduled(): runs every cron tick — probes each site, appends raw points to
 *     D1, refreshes the slow SSL/domain probes infrequently, reconciles
 *     incidents, and precomputes the dashboard blobs (summary/history/incidents)
 *     into the kv table.
 *
 *   fetch(): serves /data/*.json from the precomputed blobs and everything else
 *     from the static dashboard assets (SPA fallback handled by assets config).
 */

import type { Incident, Summary } from "@blip/shared";
import { CONFIG } from "./config.js";
import {
  clearCookie,
  filterIncidents,
  filterSummary,
  getSession,
  historyAllowed,
  jsonAuth,
  loginResponse,
  matchPrincipal,
  meBody,
  scopeFor,
  type Scope,
} from "./auth.js";
import {
  checkDomain,
  checkHttp,
  checkSsl,
  checkTcp,
  parseHostPort,
  type CheckResult,
} from "./checks.js";
import type { Env } from "./env.js";
import { reconcile, type SiteResult } from "./incidents.js";
import { dispatchNotifications } from "./notify.js";
import { EMPTY_STATE, siteStateFor, type WorkerState } from "./state.js";
import { appendPoint, getKv, prunePoints, setKv } from "./store.js";
import { buildSiteHistory, buildSummary } from "./summary.js";
import { iso, MS_PER_DAY, MS_PER_HOUR } from "./time.js";

const POINTS_RETENTION_MS = 90 * MS_PER_DAY;
const DEFAULT_SSL_REFRESH_HOURS = 6;

// ---------------------------------------------------------------------------
// scheduled
// ---------------------------------------------------------------------------

/**
 * Resolve `${ENV_VAR}` references inside a site's request headers against the
 * Worker env (secrets). gen-config embeds header values literally, so secret
 * refs like the Cloudflare Access service-token must be substituted at runtime.
 * Returns the site unchanged when it has no headers; missing vars resolve to "".
 */
function resolveSiteHeaders<T extends { headers?: Record<string, string> }>(site: T, env: Env): T {
  if (!site.headers) return site;
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(site.headers)) {
    headers[k] = v.replace(/\$\{([A-Z0-9_]+)\}/g, (_m, name) => {
      const val = env[name];
      return typeof val === "string" ? val : "";
    });
  }
  return { ...site, headers };
}

async function runChecks(env: Env, now: number): Promise<void> {
  const db = env.DB;
  const config = CONFIG;

  const refreshHours = Number(env.SSL_REFRESH_HOURS);
  const sslRefreshMs =
    (Number.isFinite(refreshHours) && refreshHours > 0 ? refreshHours : DEFAULT_SSL_REFRESH_HOURS) *
    MS_PER_HOUR;

  // 1. Load cross-run state.
  const loaded = await getKv<WorkerState>(db, "state");
  const state: WorkerState = loaded
    ? {
        version: loaded.version ?? 1,
        sites: loaded.sites ?? {},
        alerts: loaded.alerts ?? {},
        ...(loaded.updatedAt ? { updatedAt: loaded.updatedAt } : {}),
      }
    : { ...EMPTY_STATE, sites: {}, alerts: {} };

  const results = new Map<string, SiteResult>();

  // 2. Probe each site. Wrap each in try/catch so one bad site never aborts the tick.
  for (const site of config.sites) {
    if (site.paused) continue;
    try {
      const ss = siteStateFor(state, site.id);

      // --- primary availability probe ---
      let result: CheckResult;
      if (site.type === "tcp") {
        const { host, port } = parseHostPort(site.url, site.port, 80);
        result = await checkTcp(host, port, site.timeoutMs ?? config.defaults.timeoutMs);
      } else {
        result = await checkHttp(resolveSiteHeaders(site, env), config.defaults);
      }

      // Append the raw point.
      await appendPoint(db, site.id, {
        t: now,
        s: result.status,
        ms: result.responseTime,
        c: result.httpStatus,
        e: result.status === "up" ? undefined : result.error,
      });

      // Record latest snapshot into state (the summary reads from here).
      ss.lastChecked = iso(now);
      ss.responseTime = result.responseTime;
      if (result.httpStatus !== undefined) ss.httpStatus = result.httpStatus;
      else delete ss.httpStatus;
      if (result.error) ss.error = result.error;
      else delete ss.error;

      // --- slow probes: refresh only on an infrequent cadence, else reuse cache ---
      if (site.ssl) {
        const due = (ss.sslRefreshedAt ?? 0) + sslRefreshMs <= now;
        if (due) {
          const host = parseHostPort(site.url, undefined, 443).host;
          const ssl = await checkSsl(host, site.sslWarnDays ?? config.defaults.sslWarnDays);
          if (ssl) {
            ss.ssl = ssl;
            ss.sslRefreshedAt = now;
          }
        }
      } else {
        delete ss.ssl;
      }

      if (site.domain) {
        const due = (ss.domainRefreshedAt ?? 0) + sslRefreshMs <= now;
        if (due) {
          const domain = await checkDomain(
            site.url,
            site.domainWarnDays ?? config.defaults.domainWarnDays,
          );
          if (domain) {
            ss.domain = domain;
            ss.domainRefreshedAt = now;
          }
        }
      } else {
        delete ss.domain;
      }

      results.set(site.id, {
        status: result.status,
        error: result.error,
        ssl: ss.ssl,
        domain: ss.domain,
      });
    } catch (err) {
      // Defensive: record a synthetic down point so the site doesn't silently stall.
      const message = (err as Error).message || "Check crashed";
      try {
        await appendPoint(db, site.id, { t: now, s: "down", ms: null, e: message });
        const ss = siteStateFor(state, site.id);
        ss.lastChecked = iso(now);
        ss.responseTime = null;
        ss.error = message;
        results.set(site.id, { status: "down", error: message, ssl: ss.ssl, domain: ss.domain });
      } catch {
        // give up on this site for this tick
      }
    }
  }

  // 3. Prune raw points older than 90 days.
  await prunePoints(db, now - POINTS_RETENTION_MS);

  // 4. Reconcile incidents (also derives the notification events).
  const prevIncidents = (await getKv<Incident[]>(db, "incidents")) ?? [];
  const { incidents, state: nextState, events } = reconcile(prevIncidents, {
    prevState: state,
    results,
    sites: [...config.sites],
    now,
  });
  await setKv(db, "incidents", incidents);

  // 4b. Send notifications for this tick's transitions. Mutates nextState.alerts
  // for de-dup; never throws (each channel send is caught), so a failing channel
  // can't abort the blob writes below.
  const sent = await dispatchNotifications(events, config.channels, nextState, env, now);
  if (sent > 0) console.log(`notify: sent ${sent} alert(s) across ${events.length} event(s)`);

  // 5. Build precomputed blobs.
  const summary = await buildSummary(db, config, nextState, incidents, now);
  await setKv(db, "blob:summary", summary);
  await setKv(db, "blob:incidents", incidents);
  for (const site of config.sites) {
    const history = await buildSiteHistory(db, site, now);
    await setKv(db, `blob:history:${site.id}`, history);
  }

  // 6. Persist state.
  nextState.updatedAt = iso(now);
  await setKv(db, "state", nextState);
}

// ---------------------------------------------------------------------------
// fetch (/data API + static assets)
// ---------------------------------------------------------------------------

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    },
  });
}

async function serveData(path: string, env: Env, scope: Scope): Promise<Response | null> {
  const db = env.DB;
  const summary = await getKv<Summary>(db, "blob:summary");

  if (path === "/data/summary.json") {
    // Empty object 200 keeps the dashboard happy before the first cron tick.
    if (!summary) return jsonResponse({});
    return jsonResponse(filterSummary(summary, scope));
  }

  if (path === "/data/incidents.json") {
    const incidents = (await getKv<Incident[]>(db, "blob:incidents")) ?? [];
    if (!summary) return jsonResponse(scope === "all" ? incidents : []);
    return jsonResponse(filterIncidents(incidents, summary, scope));
  }

  const historyMatch = /^\/data\/history\/([^/]+)\.json$/.exec(path);
  if (historyMatch) {
    const id = decodeURIComponent(historyMatch[1]!);
    if (summary && !historyAllowed(id, summary, scope)) {
      return jsonResponse({ error: "forbidden" }, 403);
    }
    const raw = await getKv<unknown>(db, `blob:history:${id}`);
    if (raw) return jsonResponse(raw);
    // Unknown id → empty history (same shape) rather than a 404 so the SPA renders.
    return jsonResponse({ id, points: [], daily: [] });
  }

  if (path === "/data/permissions.json") {
    // No permissions model in the Worker mode — dashboard tolerates 404.
    return jsonResponse({ error: "not found" }, 404);
  }

  return null;
}

export default {
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // Never throw out of scheduled — wrap the whole run.
    ctx.waitUntil(
      runChecks(env, Date.now()).catch((err) => {
        console.error("scheduled run failed:", (err as Error).message);
      }),
    );
  },

  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const access = CONFIG.access;

    // --- auth endpoints ---
    if (path === "/auth/me") {
      const session = await getSession(request, env);
      return jsonAuth(meBody(session, access.publicStatusPage, access.publicDashboard));
    }
    if (path === "/auth/login") {
      if (request.method !== "POST") return jsonAuth({ error: "method not allowed" }, 405);
      let password = "";
      try {
        const body = (await request.json()) as { password?: string };
        password = typeof body.password === "string" ? body.password : "";
      } catch {
        // empty password → 401 below
      }
      const principal = password ? matchPrincipal(password, env, access) : null;
      if (!principal) {
        return jsonAuth(
          { authenticated: false, error: "invalid password", publicStatusPage: access.publicStatusPage },
          401,
        );
      }
      return loginResponse(principal, env);
    }
    if (path === "/auth/logout") {
      const res = jsonAuth({ authenticated: false });
      res.headers.append("set-cookie", clearCookie());
      return res;
    }

    // --- data API (RBAC-filtered) ---
    if (path.startsWith("/data/")) {
      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: {
            "access-control-allow-origin": "*",
            "access-control-allow-methods": "GET, OPTIONS",
            "access-control-allow-headers": "*",
          },
        });
      }
      const session = await getSession(request, env);
      // Anonymous access (public scope) is allowed when either a public status
      // page or a public read-only dashboard is enabled.
      if (!session && !access.publicStatusPage && !access.publicDashboard) {
        return jsonResponse({ error: "unauthorized" }, 401);
      }
      const scope = scopeFor(session, access);
      const res = await serveData(path, env, scope);
      if (res) return res;
      return jsonResponse({ error: "not found" }, 404);
    }

    // Everything else → static dashboard (SPA fallback from assets config).
    return env.ASSETS.fetch(request);
  },
};
