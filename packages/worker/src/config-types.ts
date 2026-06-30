/**
 * Resolved-config shapes for the Worker.
 *
 * `config.generated.ts` (produced by scripts/gen-config.mjs) is typed against
 * these. They mirror the engine's ResolvedConfig but flatten ssl/domain into
 * concrete warn windows so the runtime never re-derives defaults.
 */

import type {
  BrandConfig,
  ChannelConfig,
  CheckType,
  EngineDefaults,
  GroupConfig,
  Role,
  SiteConfig,
} from "@blip/shared";

/**
 * A login principal. The password is NOT embedded — it is read at runtime from
 * the Worker secret `BLIP_PW_<ID>` (uppercased id). Scope (groups/sites) only
 * applies to CLIENT/VIEWER; SUPER_ADMIN/ADMIN always see everything.
 */
export interface Principal {
  id: string;
  label: string;
  role: Role;
  groups?: string[];
  sites?: string[];
  /**
   * Optional password spec. Resolution order (first that yields a value wins):
   *   1. an `${ENV_VAR}` reference here  → read from the Worker env at runtime
   *   2. a literal string here           → used as-is (plaintext, lives in repo)
   *   3. (this field absent)             → the `BLIP_PW_<ID>` Worker secret
   */
  password?: string;
}

export interface AccessConfig {
  /** Is /status (public-only sites) viewable without logging in? */
  publicStatusPage: boolean;
  /**
   * Is the FULL dashboard (overview/sites/incidents) viewable without logging in,
   * read-only and scoped to public sites only? Great for a public demo. Settings
   * still require a login. Defaults to false.
   */
  publicDashboard: boolean;
  principals: Principal[];
}

/** A site with guaranteed id/type/public/paused and concrete probe windows. */
export interface ResolvedSite extends SiteConfig {
  id: string;
  type: CheckType;
  public: boolean;
  paused: boolean;
  /** ssl/domain are reduced to booleans ("enabled?"); the windows live below. */
  ssl: boolean;
  domain: boolean;
  /** Concrete SSL warn threshold (days). Present only when ssl is enabled. */
  sslWarnDays?: number;
  /** Concrete domain warn thresholds (days). Present only when domain is enabled. */
  domainWarnDays?: number[];
}

/** The embedded, fully-resolved config. */
export interface ResolvedConfig {
  brand: BrandConfig;
  defaults: Required<EngineDefaults>;
  groups: GroupConfig[];
  sites: ResolvedSite[];
  access: AccessConfig;
  /** Notification channels. Secrets stay as `${ENV_VAR}` refs, resolved at runtime. */
  channels: ChannelConfig[];
}
