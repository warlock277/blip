/**
 * HTTP/HTTPS check.
 *
 * Performs a `fetch` with an AbortController timeout and retry loop, then
 * validates the response against the site's assertions (status code, keyword
 * presence/absence, JSON-path equality/contains). A successful response that is
 * slower than `degradedThresholdMs` is downgraded to "degraded".
 *
 * Never throws — any error (network, timeout, assertion failure) is captured
 * into a `CheckResult` with `status: "down"` (or "degraded") and an `error`.
 */

import {
  DEFAULT_OK_STATUS_MAX,
  DEFAULT_OK_STATUS_MIN,
  type CheckResult,
  type EngineDefaults,
  type JsonAssertion,
  type Status,
} from "@pulse/shared";
import type { ResolvedSite } from "../config.js";
import { iso } from "../util/time.js";

type RequiredDefaults = Required<EngineDefaults>;

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
 * Returns `undefined` when any segment is missing.
 */
export function resolveJsonPath(root: unknown, path: string): unknown {
  // Tokenize into property names / numeric indices.
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

/** Evaluate one JSON assertion. Returns an error string on failure, or null on pass. */
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

async function attempt(site: ResolvedSite, defaults: RequiredDefaults): Promise<AttemptOutcome> {
  const timeoutMs = site.timeoutMs ?? defaults.timeoutMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
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
      signal: controller.signal,
    };
    if (site.body !== undefined && method !== "GET" && method !== "HEAD") {
      init.body = site.body;
    }

    const res = await fetch(site.url, init);
    const httpStatus = res.status;

    // Decide whether we need the body (keyword / json assertions).
    const needsBody =
      site.keyword !== undefined ||
      site.keywordAbsent !== undefined ||
      (site.expectJson !== undefined && site.expectJson.length > 0);
    let bodyText: string | null = null;
    if (needsBody && method !== "HEAD") {
      bodyText = await res.text();
    } else {
      // Drain/close the body to free the socket.
      await res.arrayBuffer().catch(() => undefined);
    }

    const responseTime = Date.now() - started;

    if (!statusMatches(httpStatus, site.expectedStatus)) {
      return {
        ok: false,
        httpStatus,
        responseTime,
        error: `Unexpected HTTP status ${httpStatus}`,
      };
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
    const message =
      e.name === "AbortError" ? `Request timed out after ${timeoutMs}ms` : e.message || "Request failed";
    return { ok: false, responseTime, error: message };
  } finally {
    clearTimeout(timer);
  }
}

export async function checkHttp(site: ResolvedSite, defaults: RequiredDefaults): Promise<CheckResult> {
  const retries = site.retries ?? defaults.retries;
  const degradedThreshold = site.degradedThresholdMs ?? defaults.degradedThresholdMs;
  const checkedAt = iso();

  let last: AttemptOutcome | null = null;
  for (let i = 0; i <= retries; i++) {
    last = await attempt(site, defaults);
    if (last.ok) break;
  }

  // `last` is always set because the loop runs at least once.
  const outcome = last as AttemptOutcome;

  if (!outcome.ok) {
    const result: CheckResult = {
      siteId: site.id,
      status: "down",
      responseTime: outcome.responseTime ?? null,
      checkedAt,
      error: outcome.error ?? "Check failed",
    };
    if (outcome.httpStatus !== undefined) result.httpStatus = outcome.httpStatus;
    return result;
  }

  const status: Status =
    degradedThreshold > 0 && outcome.responseTime > degradedThreshold ? "degraded" : "up";

  const result: CheckResult = {
    siteId: site.id,
    status,
    responseTime: outcome.responseTime,
    checkedAt,
  };
  if (outcome.httpStatus !== undefined) result.httpStatus = outcome.httpStatus;
  if (status === "degraded") {
    result.error = `Slow response: ${outcome.responseTime}ms > ${degradedThreshold}ms`;
  }
  return result;
}
