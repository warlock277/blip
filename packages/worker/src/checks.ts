/**
 * Probes for the Cloudflare Worker runtime.
 *
 * Reimplements the engine's checks WITHOUT node:fs/tls/net (which don't exist
 * on Workers):
 *   - checkHttp  → fetch() with AbortSignal.timeout
 *   - checkTcp   → cloudflare:sockets connect()
 *   - checkDomain→ RDAP via fetch()
 *   - checkSsl   → BEST-EFFORT via the crt.sh CT-log (Workers cannot read peer
 *                  certs), see the note on checkSsl below.
 *
 * None of these throw — failures become a "down" CheckResult or null.
 */

import { connect } from "cloudflare:sockets";
import {
  DEFAULT_OK_STATUS_MAX,
  DEFAULT_OK_STATUS_MIN,
  type DomainInfo,
  type EngineDefaults,
  type JsonAssertion,
  type SslInfo,
  type Status,
} from "@blip/shared";
import type { ResolvedSite } from "./config-types.js";
import { daysUntil, iso } from "./time.js";

type RequiredDefaults = Required<EngineDefaults>;

/** Slim result — the index handler turns this into a stored point + summary. */
export interface CheckResult {
  status: Status;
  responseTime: number | null;
  httpStatus?: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/** True when `code` satisfies the site's expectedStatus (or the 200–399 default). */
export function statusMatches(code: number, expected: ResolvedSite["expectedStatus"]): boolean {
  if (expected === undefined) {
    return code >= DEFAULT_OK_STATUS_MIN && code <= DEFAULT_OK_STATUS_MAX;
  }
  if (Array.isArray(expected)) return expected.includes(code);
  return code === expected;
}

/**
 * Resolve a dot/bracket JSON path against a parsed value.
 * Supports: `a.b.c`, `a.b[0]`, `a[0].b`, `["weird key"]`.
 */
export function resolveJsonPath(root: unknown, path: string): unknown {
  const tokens: (string | number)[] = [];
  const re = /\[\s*(?:"([^"]*)"|'([^']*)'|(\d+))\s*\]|([^.[\]]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(path)) !== null) {
    if (m[1] !== undefined) tokens.push(m[1]);
    else if (m[2] !== undefined) tokens.push(m[2]);
    else if (m[3] !== undefined) tokens.push(Number(m[3]));
    else if (m[4] !== undefined) tokens.push(m[4]);
  }
  let cur: unknown = root;
  for (const tok of tokens) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof tok === "number") {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[tok];
    } else {
      if (typeof cur !== "object") return undefined;
      cur = (cur as Record<string, unknown>)[tok];
    }
  }
  return cur;
}

/** Evaluate one JSON assertion. Returns an error string on failure, or null. */
export function evalJsonAssertion(root: unknown, a: JsonAssertion): string | null {
  const value = resolveJsonPath(root, a.path);
  if (a.equals !== undefined) {
    if (value !== a.equals) {
      return `JSON ${a.path} expected ${JSON.stringify(a.equals)} but got ${JSON.stringify(value)}`;
    }
  }
  if (a.contains !== undefined) {
    const hay = typeof value === "string" ? value : JSON.stringify(value);
    if (hay === undefined || !hay.includes(a.contains)) {
      return `JSON ${a.path} expected to contain ${JSON.stringify(a.contains)}`;
    }
  }
  return null;
}

interface AttemptOutcome {
  ok: boolean;
  httpStatus?: number;
  responseTime: number;
  error?: string;
}

async function httpAttempt(site: ResolvedSite, defaults: RequiredDefaults): Promise<AttemptOutcome> {
  const timeoutMs = site.timeoutMs ?? defaults.timeoutMs;
  const started = Date.now();
  try {
    const headers: Record<string, string> = {
      "user-agent": defaults.userAgent,
      ...(site.headers ?? {}),
    };
    const method = site.method ?? "GET";
    const init: RequestInit = {
      method,
      headers,
      redirect: site.followRedirects === false ? "manual" : "follow",
      signal: AbortSignal.timeout(timeoutMs),
    };
    if (site.body !== undefined && method !== "GET" && method !== "HEAD") {
      init.body = site.body;
    }

    const res = await fetch(site.url, init);
    const httpStatus = res.status;

    const needsBody =
      site.keyword !== undefined ||
      site.keywordAbsent !== undefined ||
      (site.expectJson !== undefined && site.expectJson.length > 0);
    let bodyText: string | null = null;
    if (needsBody && method !== "HEAD") {
      bodyText = await res.text();
    } else {
      // Drain the body so the connection can be reused/freed.
      await res.arrayBuffer().catch(() => undefined);
    }

    const responseTime = Date.now() - started;

    if (!statusMatches(httpStatus, site.expectedStatus)) {
      return { ok: false, httpStatus, responseTime, error: `Unexpected HTTP status ${httpStatus}` };
    }
    if (site.keyword !== undefined) {
      if (bodyText === null || !bodyText.includes(site.keyword)) {
        return {
          ok: false,
          httpStatus,
          responseTime,
          error: `Keyword "${site.keyword}" not found in response`,
        };
      }
    }
    if (site.keywordAbsent !== undefined) {
      if (bodyText !== null && bodyText.includes(site.keywordAbsent)) {
        return {
          ok: false,
          httpStatus,
          responseTime,
          error: `Forbidden keyword "${site.keywordAbsent}" present in response`,
        };
      }
    }
    if (site.expectJson !== undefined && site.expectJson.length > 0) {
      let json: unknown;
      try {
        json = JSON.parse(bodyText ?? "");
      } catch {
        return { ok: false, httpStatus, responseTime, error: "Response body is not valid JSON" };
      }
      for (const a of site.expectJson) {
        const err = evalJsonAssertion(json, a);
        if (err) return { ok: false, httpStatus, responseTime, error: err };
      }
    }
    return { ok: true, httpStatus, responseTime };
  } catch (err) {
    const responseTime = Date.now() - started;
    const e = err as Error;
    // AbortSignal.timeout aborts with a TimeoutError DOMException.
    const message =
      e.name === "TimeoutError" || e.name === "AbortError"
        ? `Request timed out after ${timeoutMs}ms`
        : e.message || "Request failed";
    return { ok: false, responseTime, error: message };
  }
}

export async function checkHttp(site: ResolvedSite, defaults: RequiredDefaults): Promise<CheckResult> {
  const retries = site.retries ?? defaults.retries;
  const degradedThreshold = site.degradedThresholdMs ?? defaults.degradedThresholdMs;

  let last: AttemptOutcome = { ok: false, responseTime: 0, error: "Check did not run" };
  for (let i = 0; i <= retries; i++) {
    last = await httpAttempt(site, defaults);
    if (last.ok) break;
  }

  if (!last.ok) {
    const result: CheckResult = {
      status: "down",
      responseTime: last.responseTime ?? null,
      error: last.error ?? "Check failed",
    };
    if (last.httpStatus !== undefined) result.httpStatus = last.httpStatus;
    return result;
  }

  const status: Status =
    degradedThreshold > 0 && last.responseTime > degradedThreshold ? "degraded" : "up";
  const result: CheckResult = { status, responseTime: last.responseTime };
  if (last.httpStatus !== undefined) result.httpStatus = last.httpStatus;
  if (status === "degraded") {
    result.error = `Slow response: ${last.responseTime}ms > ${degradedThreshold}ms`;
  }
  return result;
}

// ---------------------------------------------------------------------------
// TCP (cloudflare:sockets)
// ---------------------------------------------------------------------------

/** Parse a host:port target. Falls back to `defaultPort` when no port present. */
export function parseHostPort(
  url: string,
  explicitPort?: number,
  defaultPort = 80,
): { host: string; port: number } {
  let target = url.replace(/^[a-z]+:\/\//i, "");
  const slash = target.indexOf("/");
  if (slash !== -1) target = target.slice(0, slash);

  let host = target;
  let port = explicitPort ?? defaultPort;
  const colon = target.lastIndexOf(":");
  if (colon !== -1) {
    const maybePort = Number(target.slice(colon + 1));
    if (Number.isInteger(maybePort) && maybePort > 0) {
      host = target.slice(0, colon);
      port = explicitPort ?? maybePort;
    }
  }
  return { host, port };
}

/** Open a TCP socket, measure connect time, close. Never throws. */
export async function checkTcp(host: string, port: number, timeoutMs: number): Promise<CheckResult> {
  const started = Date.now();
  let socket: ReturnType<typeof connect> | null = null;
  try {
    socket = connect({ hostname: host, port });
    // `opened` resolves once the connection is established.
    await Promise.race([
      socket.opened,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`TCP connect timed out after ${timeoutMs}ms`)), timeoutMs),
      ),
    ]);
    const responseTime = Date.now() - started;
    return { status: "up", responseTime };
  } catch (err) {
    const e = err as Error;
    return {
      status: "down",
      responseTime: null,
      error: e.message || `TCP connect to ${host}:${port} failed`,
    };
  } finally {
    try {
      await socket?.close();
    } catch {
      // ignore close errors
    }
  }
}

// ---------------------------------------------------------------------------
// Domain expiry (RDAP)
// ---------------------------------------------------------------------------

const RDAP_TIMEOUT_MS = 10_000;

interface RdapEvent {
  eventAction?: string;
  eventDate?: string;
}
interface RdapEntity {
  roles?: string[];
  vcardArray?: unknown;
}
interface RdapResponse {
  events?: RdapEvent[];
  entities?: RdapEntity[];
}

/**
 * Reduce a hostname to its registrable domain (e.g. `api.foo.co.uk` →
 * `foo.co.uk`). Heuristic — covers common two-level public suffixes.
 */
export function registrableDomain(input: string): string {
  let host = input.replace(/^[a-z]+:\/\//i, "");
  const slash = host.indexOf("/");
  if (slash !== -1) host = host.slice(0, slash);
  const colon = host.indexOf(":");
  if (colon !== -1) host = host.slice(0, colon);
  host = host.replace(/\.$/, "").toLowerCase();

  const labels = host.split(".");
  if (labels.length <= 2) return host;

  const twoLevelTlds = new Set([
    "co.uk",
    "org.uk",
    "gov.uk",
    "ac.uk",
    "com.au",
    "net.au",
    "org.au",
    "co.nz",
    "co.jp",
    "com.br",
    "com.cn",
    "co.in",
    "co.za",
  ]);
  const lastTwo = labels.slice(-2).join(".");
  if (twoLevelTlds.has(lastTwo)) return labels.slice(-3).join(".");
  return labels.slice(-2).join(".");
}

function extractRegistrar(entities: RdapEntity[] | undefined): string | undefined {
  if (!entities) return undefined;
  for (const ent of entities) {
    if (!ent.roles?.includes("registrar")) continue;
    const vcard = ent.vcardArray;
    if (Array.isArray(vcard) && vcard.length >= 2 && Array.isArray(vcard[1])) {
      for (const entry of vcard[1] as unknown[]) {
        if (Array.isArray(entry) && entry[0] === "fn" && typeof entry[3] === "string") {
          return entry[3];
        }
      }
    }
  }
  return undefined;
}

/**
 * Authoritative RDAP base per TLD. Hitting the registry directly avoids the
 * rdap.org redirect (which Cloudflare Worker IPs often get rate-limited on).
 * rdap.org is kept as a general fallback for any TLD not listed here.
 */
const TLD_RDAP: Record<string, string> = {
  com: "https://rdap.verisign.com/com/v1/domain/",
  net: "https://rdap.verisign.com/net/v1/domain/",
  org: "https://rdap.publicinterestregistry.org/rdap/domain/",
  io: "https://rdap.identitydigital.services/rdap/domain/",
  co: "https://rdap.nic.co/domain/",
  dev: "https://www.registry.google/rdap/domain/",
  app: "https://www.registry.google/rdap/domain/",
  xyz: "https://rdap.centralnic.com/xyz/domain/",
  ai: "https://rdap.nic.ai/domain/",
  info: "https://rdap.identitydigital.services/rdap/domain/",
};

/** Ordered list of RDAP URLs to try for a registrable domain. */
function rdapCandidates(apex: string): string[] {
  const tld = apex.slice(apex.lastIndexOf(".") + 1);
  const urls: string[] = [];
  const base = TLD_RDAP[tld];
  if (base) urls.push(base + encodeURIComponent(apex));
  urls.push(`https://rdap.org/domain/${encodeURIComponent(apex)}`);
  return urls;
}

function parseRdap(data: RdapResponse, warnDays: number[]): DomainInfo | null {
  const events = Array.isArray(data.events) ? data.events : [];
  const expEvent = events.find(
    (e) => e.eventAction === "expiration" && typeof e.eventDate === "string",
  );
  if (!expEvent?.eventDate) return null;
  const expMs = Date.parse(expEvent.eventDate);
  if (Number.isNaN(expMs)) return null;
  const daysRemaining = daysUntil(expMs);
  const maxWarn = warnDays.length > 0 ? Math.max(...warnDays) : 0;
  const info: DomainInfo = {
    expiresAt: iso(expMs),
    daysRemaining,
    expiringSoon: daysRemaining <= maxWarn,
  };
  const registrar = extractRegistrar(data.entities);
  if (registrar) info.registrar = registrar;
  return info;
}

/** RDAP lookup of domain expiry. Tries authoritative registry first, then
 *  rdap.org. Defensive — returns null only if every candidate fails. */
export async function checkDomain(domain: string, warnDays: number[]): Promise<DomainInfo | null> {
  const apex = registrableDomain(domain);
  for (const url of rdapCandidates(apex)) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(RDAP_TIMEOUT_MS),
        headers: { accept: "application/rdap+json, application/json" },
        redirect: "follow",
      });
      if (!res.ok) continue;
      const info = parseRdap((await res.json()) as RdapResponse, warnDays);
      if (info) return info;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// SSL expiry (BEST-EFFORT via crt.sh)
// ---------------------------------------------------------------------------

const CRTSH_TIMEOUT_MS = 12_000;

interface CrtShEntry {
  not_after?: string;
  issuer_name?: string;
  common_name?: string;
  name_value?: string;
}

/** Does a crt.sh entry cover `host` (exact or wildcard match)? */
function entryMatchesHost(entry: CrtShEntry, host: string): boolean {
  const names = new Set<string>();
  if (entry.common_name) names.add(entry.common_name.toLowerCase());
  if (entry.name_value) {
    for (const n of entry.name_value.split(/\s+/)) {
      if (n) names.add(n.trim().toLowerCase());
    }
  }
  for (const name of names) {
    if (name === host) return true;
    if (name.startsWith("*.")) {
      const suffix = name.slice(1); // ".example.com"
      if (host.endsWith(suffix) && host.split(".").length === name.split(".").length) {
        return true;
      }
    }
  }
  return false;
}

/**
 * BEST-EFFORT SSL expiry via the crt.sh Certificate Transparency log.
 *
 * Cloudflare Workers CANNOT read the peer certificate of a TLS connection
 * (no node:tls, and cloudflare:sockets does not expose cert details), so we
 * approximate cert expiry from CT logs: query crt.sh for certificates issued
 * for `host` and take the latest `not_after` of an entry that covers the host.
 *
 * Caveats: CT logs lag real issuance slightly, list ALL historical certs (we
 * take the max not_after as the "current" cert), and crt.sh is rate-limited.
 * This is a deliberate approximation — swap this function for a real SSL/cert
 * API (or a serverside TLS probe) if you need authoritative cert data.
 *
 * Returns null on any failure (network, timeout, no matching entry).
 */
export async function checkSsl(host: string, warnDays: number): Promise<SslInfo | null> {
  const url = `https://crt.sh/?q=${encodeURIComponent(host)}&output=json`;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(CRTSH_TIMEOUT_MS),
      headers: { accept: "application/json", "user-agent": "Blip/0.1 ssl-check" },
      redirect: "follow",
    });
    if (!res.ok) return null;
    const data = (await res.json()) as CrtShEntry[];
    if (!Array.isArray(data) || data.length === 0) return null;

    let bestMs = Number.NEGATIVE_INFINITY;
    let bestIssuer: string | undefined;
    for (const entry of data) {
      if (!entry.not_after) continue;
      if (!entryMatchesHost(entry, host)) continue;
      const ms = Date.parse(entry.not_after);
      if (Number.isNaN(ms)) continue;
      if (ms > bestMs) {
        bestMs = ms;
        bestIssuer = entry.issuer_name;
      }
    }
    if (bestMs === Number.NEGATIVE_INFINITY) return null;

    const daysRemaining = daysUntil(bestMs);
    const info: SslInfo = {
      validTo: iso(bestMs),
      daysRemaining,
      expiringSoon: daysRemaining <= warnDays,
    };
    if (bestIssuer) info.issuer = bestIssuer;
    return info;
  } catch {
    return null;
  }
}
