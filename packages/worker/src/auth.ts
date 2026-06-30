/**
 * Worker-side access control for Blip.
 *
 * - Authentication: a password (per principal) is checked against the Worker
 *   secret BLIP_PW_<ID>. On match we issue an HMAC-signed, HttpOnly session
 *   cookie (signed with BLIP_SESSION_SECRET).
 * - Authorization (RBAC): SUPER_ADMIN/ADMIN see everything; CLIENT/VIEWER are
 *   scoped to their groups/sites. Anonymous viewers (when publicStatusPage is
 *   on) see only public sites. ALL filtering happens server-side here.
 */

import {
  overallStatus,
  type GroupSummary,
  type Incident,
  type OverallStatus,
  type Role,
  type Summary,
  type SummaryTotals,
} from "@blip/shared";
import type { AccessConfig, Principal } from "./config-types.js";
import type { Env } from "./env.js";

const COOKIE_NAME = "blip_session";
const SESSION_TTL_SEC = 12 * 60 * 60; // 12h

export interface Session {
  pid: string;
  role: Role;
  label: string;
  groups: string[];
  sites: string[];
  exp: number; // epoch seconds
}

/** "all" → unrestricted; "public" → only public sites; otherwise scoped ids. */
export type Scope = "all" | "public" | { groups: Set<string>; sites: Set<string> };

// ---------------------------------------------------------------------------
// base64url + HMAC (Web Crypto)
// ---------------------------------------------------------------------------

const enc = new TextEncoder();

function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/** Constant-time-ish string compare. */
function safeEqual(a: string, b: string): boolean {
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i]! ^ bb[i]!;
  return diff === 0;
}

// ---------------------------------------------------------------------------
// Session token
// ---------------------------------------------------------------------------

async function signSession(payload: Session, secret: string): Promise<string> {
  const body = b64urlEncode(enc.encode(JSON.stringify(payload)));
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  return `${body}.${b64urlEncode(new Uint8Array(sig))}`;
}

async function verifyToken(token: string, secret: string): Promise<Session | null> {
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const key = await hmacKey(secret);
  let ok: boolean;
  try {
    ok = await crypto.subtle.verify("HMAC", key, b64urlDecode(sig), enc.encode(body));
  } catch {
    return null;
  }
  if (!ok) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(body))) as Session;
    if (typeof payload.exp !== "number" || payload.exp * 1000 < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

export async function getSession(request: Request, env: Env): Promise<Session | null> {
  const secret = env.BLIP_SESSION_SECRET;
  if (!secret) return null;
  const token = readCookie(request, COOKIE_NAME);
  if (!token) return null;
  return verifyToken(token, secret);
}

function sessionCookie(token: string, maxAgeSec: number): string {
  return [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${maxAgeSec}`,
  ].join("; ");
}

export function clearCookie(): string {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

function passwordEnvKey(principalId: string): string {
  return `BLIP_PW_${principalId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

const ENV_REF = /^\$\{([A-Z0-9_]+)\}$/;

/**
 * Resolve a principal's expected password. Order:
 *   1. config `password: ${ENV_VAR}` → env[ENV_VAR]
 *   2. config `password: "literal"`  → the literal
 *   3. no config password            → env BLIP_PW_<ID>
 * Returns undefined when no password is configured (principal can't log in).
 */
function resolvePassword(p: Principal, env: Env): string | undefined {
  if (typeof p.password === "string" && p.password.length > 0) {
    const ref = ENV_REF.exec(p.password.trim());
    if (ref) {
      const v = env[ref[1]!];
      return typeof v === "string" && v.length > 0 ? v : undefined;
    }
    return p.password; // literal from config
  }
  const v = env[passwordEnvKey(p.id)];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** Find the principal whose resolved password matches. Constant-time over all. */
export function matchPrincipal(
  password: string,
  env: Env,
  access: AccessConfig,
): Principal | null {
  let matched: Principal | null = null;
  for (const p of access.principals) {
    const expected = resolvePassword(p, env);
    if (expected !== undefined && safeEqual(password, expected)) {
      matched = p; // keep looping to avoid early-exit timing signal
    }
  }
  return matched;
}

export async function loginResponse(principal: Principal, env: Env): Promise<Response> {
  const secret = env.BLIP_SESSION_SECRET;
  if (!secret) return jsonAuth({ authenticated: false, error: "server misconfigured" }, 500);
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SEC;
  const session: Session = {
    pid: principal.id,
    role: principal.role,
    label: principal.label,
    groups: principal.groups ?? [],
    sites: principal.sites ?? [],
    exp,
  };
  const token = await signSession(session, secret);
  const res = jsonAuth(meBody(session, true));
  res.headers.append("set-cookie", sessionCookie(token, SESSION_TTL_SEC));
  return res;
}

// ---------------------------------------------------------------------------
// /auth/me + scope
// ---------------------------------------------------------------------------

export function jsonAuth(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export function meBody(session: Session | null, publicStatusPage: boolean): Record<string, unknown> {
  if (!session) return { authenticated: false, publicStatusPage };
  const scope =
    session.role === "SUPER_ADMIN" || session.role === "ADMIN"
      ? "all"
      : { groups: session.groups, sites: session.sites };
  return {
    authenticated: true,
    role: session.role,
    label: session.label,
    scope,
    publicStatusPage,
  };
}

export function scopeFor(session: Session | null, access: AccessConfig): Scope {
  if (!session) return access.publicStatusPage ? "public" : "public"; // anon always = public set
  if (session.role === "SUPER_ADMIN" || session.role === "ADMIN") return "all";
  return { groups: new Set(session.groups), sites: new Set(session.sites) };
}

/** Can a site (by id/group/public) be seen under this scope? */
export function siteVisible(
  scope: Scope,
  site: { id: string; group?: string; public: boolean },
): boolean {
  if (scope === "all") return true;
  if (scope === "public") return site.public === true;
  if (site.group !== undefined && scope.groups.has(site.group)) return true;
  return scope.sites.has(site.id);
}

// ---------------------------------------------------------------------------
// Data filtering (RBAC applied to the precomputed summary/incidents)
// ---------------------------------------------------------------------------

export function filterSummary(summary: Summary, scope: Scope): Summary {
  if (scope === "all") return summary;
  const sites = summary.sites.filter((s) => siteVisible(scope, s));
  const visibleIds = new Set(sites.map((s) => s.id));
  const active = sites.filter((s) => !s.paused);
  const totals: SummaryTotals = {
    sites: sites.length,
    up: active.filter((s) => s.status === "up").length,
    down: active.filter((s) => s.status === "down").length,
    degraded: active.filter((s) => s.status === "degraded").length,
    paused: sites.filter((s) => s.paused).length,
    // Mean of each site's rolling 24h uptime — must match buildSummary so the
    // headline number is identical for a scoped viewer and an admin.
    uptime:
      active.length === 0 ? 1 : active.reduce((a, s) => a + s.uptime24h, 0) / active.length,
  };
  const groups: GroupSummary[] = summary.groups
    .map((g) => {
      const ids = g.siteIds.filter((id) => visibleIds.has(id));
      const statuses = active.filter((s) => ids.includes(s.id)).map((s) => s.status);
      const status: OverallStatus = overallStatus(statuses);
      return { ...g, siteIds: ids, status };
    })
    .filter((g) => g.siteIds.length > 0);
  const overall: OverallStatus = overallStatus(active.map((s) => s.status));
  const incidents = summary.incidents.filter((i) => visibleIds.has(i.siteId));
  return { ...summary, sites, totals, groups, overall, incidents };
}

export function filterIncidents(incidents: Incident[], summary: Summary, scope: Scope): Incident[] {
  if (scope === "all") return incidents;
  const visible = new Set(summary.sites.filter((s) => siteVisible(scope, s)).map((s) => s.id));
  return incidents.filter((i) => visible.has(i.siteId));
}

export function historyAllowed(id: string, summary: Summary, scope: Scope): boolean {
  if (scope === "all") return true;
  const site = summary.sites.find((s) => s.id === id);
  if (!site) return false;
  return siteVisible(scope, site);
}
