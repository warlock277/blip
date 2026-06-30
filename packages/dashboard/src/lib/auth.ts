import { createContext, useContext } from "react";
import type { Role, SiteSummary, GroupSummary } from "@blip/shared";

/**
 * Client-side auth state for the Blip dashboard.
 *
 * Security note: this module is UX-only. The real boundary is the Cloudflare
 * Worker, which signs an HttpOnly session cookie and filters every `/data/*`
 * and `/auth/*` response server-side. The client never holds a secret — it only
 * forwards the typed password to `POST /auth/login`. The `scope` we receive
 * here merely lets the UI avoid rendering placeholders for data the server has
 * already withheld.
 */

/** Viewer scope as returned by the Worker. `"all"` = unrestricted. */
export type Scope = "all" | { groups: string[]; sites: string[] };

/** Shape of `GET /auth/me` / `POST /auth/login` success responses. */
export interface AuthMe {
  authenticated: boolean;
  role?: Role;
  label?: string;
  scope?: Scope;
  publicStatusPage: boolean;
}

export const ROLE_RANK: Record<Role, number> = {
  VIEWER: 0,
  CLIENT: 1,
  ADMIN: 2,
  SUPER_ADMIN: 3,
};

export const ROLE_LABEL: Record<Role, string> = {
  SUPER_ADMIN: "Super admin",
  ADMIN: "Admin",
  CLIENT: "Client",
  VIEWER: "Viewer",
};

export const ROLE_DESCRIPTION: Record<Role, string> = {
  SUPER_ADMIN: "Full access to every site, group, and configuration surface.",
  ADMIN: "Full read access to all sites and groups across the workspace.",
  CLIENT: "Scoped to their own groups/sites — sees only their tenant's status.",
  VIEWER: "Read-only access to the sites and groups they are granted.",
};

// ---------------------------------------------------------------------------
// Worker auth contract
// ---------------------------------------------------------------------------

/**
 * Dev-only role override. UX-only — it never grants real access (the Worker is
 * the boundary). It is applied solely when `GET /auth/me` 404s or the network
 * fails (i.e. running `vite` with no Worker in front). In every other case the
 * client defaults to unauthenticated.
 */
const DEV_ROLE = import.meta.env.VITE_DEV_ROLE as Role | undefined;

const UNAUTHENTICATED: AuthMe = { authenticated: false, publicStatusPage: false };

/** Fetch the current identity from the Worker. Tolerates the dev no-Worker case. */
export async function fetchMe(): Promise<AuthMe> {
  try {
    const res = await fetch("/auth/me", {
      credentials: "include",
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    // No Worker in local dev → fall back to the optional dev override.
    if (res.status === 404) return devFallback();
    if (!res.ok) return UNAUTHENTICATED;
    return (await res.json()) as AuthMe;
  } catch {
    // Network failure (e.g. bare `vite` dev server) → dev override or anon.
    return devFallback();
  }
}

function devFallback(): AuthMe {
  if (DEV_ROLE) {
    return {
      authenticated: true,
      role: DEV_ROLE,
      label: "Dev user",
      scope: "all",
      publicStatusPage: true,
    };
  }
  return UNAUTHENTICATED;
}

/** Result of a login attempt. `wrongPassword` is set on a 401. */
export interface LoginResult {
  ok: boolean;
  wrongPassword: boolean;
  me?: AuthMe;
}

/** POST the password to the Worker. Returns the refreshed state on success. */
export async function postLogin(password: string): Promise<LoginResult> {
  try {
    const res = await fetch("/auth/login", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      cache: "no-store",
      body: JSON.stringify({ password }),
    });
    if (res.status === 401) return { ok: false, wrongPassword: true };
    if (!res.ok) return { ok: false, wrongPassword: false };
    const me = (await res.json()) as AuthMe;
    return { ok: true, wrongPassword: false, me };
  } catch {
    return { ok: false, wrongPassword: false };
  }
}

/** POST logout. Best-effort — state is reset regardless of the outcome. */
export async function postLogout(): Promise<void> {
  try {
    await fetch("/auth/logout", {
      method: "POST",
      credentials: "include",
      cache: "no-store",
    });
  } catch {
    /* ignore — caller resets local state anyway */
  }
}

// ---------------------------------------------------------------------------
// Scope filtering (UX-only — the server already filters `/data/*`)
// ---------------------------------------------------------------------------

/** Is a given site within the viewer's scope? */
export function siteInScope(
  scope: Scope | undefined,
  site: Pick<SiteSummary, "id" | "group">,
): boolean {
  if (scope == null || scope === "all") return true;
  const byGroup = site.group != null && scope.groups.includes(site.group);
  const bySite = scope.sites.includes(site.id);
  return byGroup || bySite;
}

/** Filter a list of sites down to the viewer's scope. */
export function scopedSites<T extends Pick<SiteSummary, "id" | "group">>(
  scope: Scope | undefined,
  sites: T[],
): T[] {
  if (scope == null || scope === "all") return sites;
  return sites.filter((s) => siteInScope(scope, s));
}

/** Filter groups to those the viewer may see (i.e. that contain a visible site). */
export function scopedGroups(
  scope: Scope | undefined,
  groups: GroupSummary[],
  visibleSiteIds: Set<string>,
): GroupSummary[] {
  if (scope == null || scope === "all") return groups;
  return groups.filter(
    (g) => scope.groups.includes(g.id) || g.siteIds.some((id) => visibleSiteIds.has(id)),
  );
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export interface AuthContextValue {
  authenticated: boolean;
  role?: Role;
  label?: string;
  scope?: Scope;
  publicStatusPage: boolean;
  /** True until the first `GET /auth/me` resolves. */
  loading: boolean;
  /** Attempt a password login; refreshes state on success. */
  login: (password: string) => Promise<LoginResult>;
  /** Log out and reset to the unauthenticated state. */
  logout: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextValue>({
  authenticated: false,
  publicStatusPage: false,
  loading: true,
  login: async () => ({ ok: false, wrongPassword: false }),
  logout: async () => {},
});

export function useAuth(): AuthContextValue {
  return useContext(AuthContext);
}
