/**
 * Pulse — shared type contract.
 *
 * These types are the single source of truth shared between the monitoring
 * `engine` (writes the data) and the `dashboard` (reads the data). The JSON
 * files committed under `/data` conform exactly to the shapes declared here.
 */

// ---------------------------------------------------------------------------
// Core enums
// ---------------------------------------------------------------------------

/** What kind of probe to run against a target. */
export type CheckType = "http" | "ssl" | "domain" | "tcp";

/** Resolved health of a target after a check run. */
export type Status = "up" | "down" | "degraded";

/** Coarse status used by the public status page banner. */
export type OverallStatus = "operational" | "degraded" | "partial_outage" | "major_outage";

/** Events that can trigger a notification. */
export type EventType = "down" | "up" | "degraded" | "ssl" | "domain";

/** Incident classification. */
export type IncidentType = "down" | "degraded" | "ssl_expiring" | "domain_expiring";

/** Lifecycle of an incident. */
export type IncidentState = "open" | "resolved";

/** Access-control roles (least → most privileged for VIEWER/CLIENT/ADMIN/SUPER_ADMIN). */
export type Role = "SUPER_ADMIN" | "ADMIN" | "CLIENT" | "VIEWER";

/** Supported notification channel kinds. */
export type ChannelType = "telegram" | "email" | "discord" | "slack" | "webhook";

// ---------------------------------------------------------------------------
// Configuration (user-authored, parsed from pulse.config.yaml)
// ---------------------------------------------------------------------------

/** JSON-body assertion: the value at `path` (dot/bracket notation) must equal `equals`. */
export interface JsonAssertion {
  path: string;
  equals?: string | number | boolean | null;
  contains?: string;
}

/** SSL certificate monitoring options. `true` enables with defaults. */
export type SslOption = boolean | { warnDays?: number };

/** Domain-expiry monitoring options. `true` enables with defaults. */
export type DomainOption = boolean | { warnDays?: number[] };

/**
 * A single monitored target. Authored by the user under `sites:` in the
 * config file. Only `name` and `url` are required; everything else is optional
 * with sensible defaults applied by the engine's config loader.
 */
export interface SiteConfig {
  /** Stable slug used for data filenames + URLs. Auto-derived from `name` if omitted. */
  id?: string;
  /** Human-friendly display name. */
  name: string;
  /** Target URL (http/https) or host:port for tcp checks. */
  url: string;
  /** Probe type. Defaults to "http". */
  type?: CheckType;
  /** Group / tenant id this site belongs to (see `groups`). */
  group?: string;
  /** Short description shown on the status page. */
  description?: string;

  // --- HTTP options ---
  method?: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS";
  /** Acceptable HTTP status code(s). Defaults to 200–399. */
  expectedStatus?: number | number[];
  /** Response body MUST contain this substring (keyword monitoring). */
  keyword?: string;
  /** Response body MUST NOT contain this substring. */
  keywordAbsent?: string;
  /** Extra request headers. Values may reference secrets via `${ENV_VAR}`. */
  headers?: Record<string, string>;
  /** Request body for POST/PUT/PATCH. */
  body?: string;
  /** JSON-path assertions evaluated against the response body. */
  expectJson?: JsonAssertion[];
  /** Follow 3xx redirects. Defaults to true. */
  followRedirects?: boolean;
  /** Treat insecure/expired TLS as failure for the HTTP check. Defaults to true. */
  verifyTls?: boolean;

  // --- thresholds / behaviour ---
  /** Per-check timeout in ms. Defaults to 10000. */
  timeoutMs?: number;
  /** Response time (ms) above which status becomes "degraded". */
  degradedThresholdMs?: number;
  /** Retries before declaring "down". Defaults to 2. */
  retries?: number;
  /** Pause monitoring without deleting config. */
  paused?: boolean;

  // --- extra probes layered onto an http/tcp site ---
  /** Monitor TLS certificate expiry. */
  ssl?: SslOption;
  /** Monitor domain registration expiry (RDAP/WHOIS). */
  domain?: DomainOption;

  // --- tcp options ---
  /** TCP port for type: "tcp". May also be embedded in `url` as host:port. */
  port?: number;

  // --- presentation / routing ---
  /** Channel ids to notify for this site (overrides global routing). */
  notify?: string[];
  /** Show this site on the public status page. Defaults to true. */
  public?: boolean;
  /** Free-form tags for filtering. */
  tags?: string[];
}

/** A logical grouping of sites — used for tenants, products, or regions. */
export interface GroupConfig {
  id: string;
  name: string;
  description?: string;
  /** Optional emoji/icon shown in the UI. */
  icon?: string;
}

/** Telegram channel config. */
export interface TelegramChannel {
  id: string;
  type: "telegram";
  /** Bot token, typically `${TELEGRAM_BOT_TOKEN}`. */
  botToken: string;
  /** Target chat id, typically `${TELEGRAM_CHAT_ID}`. */
  chatId: string;
  events?: EventType[];
  sites?: string[];
  groups?: string[];
  minDownMinutes?: number;
}

/** Email channel config (Resend by default, or generic SMTP relay via webhook). */
export interface EmailChannel {
  id: string;
  type: "email";
  /** Resend API key, typically `${RESEND_API_KEY}`. */
  apiKey: string;
  from: string;
  to: string[];
  events?: EventType[];
  sites?: string[];
  groups?: string[];
  minDownMinutes?: number;
}

/** Discord webhook channel config. */
export interface DiscordChannel {
  id: string;
  type: "discord";
  webhookUrl: string;
  events?: EventType[];
  sites?: string[];
  groups?: string[];
  minDownMinutes?: number;
}

/** Slack incoming-webhook channel config. */
export interface SlackChannel {
  id: string;
  type: "slack";
  webhookUrl: string;
  events?: EventType[];
  sites?: string[];
  groups?: string[];
  minDownMinutes?: number;
}

/** Generic outbound webhook channel — POSTs a JSON payload. */
export interface WebhookChannel {
  id: string;
  type: "webhook";
  url: string;
  method?: "POST" | "PUT";
  headers?: Record<string, string>;
  events?: EventType[];
  sites?: string[];
  groups?: string[];
  minDownMinutes?: number;
}

export type ChannelConfig =
  | TelegramChannel
  | EmailChannel
  | DiscordChannel
  | SlackChannel
  | WebhookChannel;

/** Branding / appearance for the dashboard + status page. */
export interface BrandConfig {
  name?: string;
  logoUrl?: string;
  faviconUrl?: string;
  /** Primary accent colour (hex). */
  primaryColor?: string;
  /** Marketing tagline for the public status page. */
  tagline?: string;
  supportUrl?: string;
  website?: string;
}

/** Global engine defaults applied to every site unless overridden. */
export interface EngineDefaults {
  timeoutMs?: number;
  retries?: number;
  degradedThresholdMs?: number;
  /** Max raw history points kept per site (older data is rolled up daily). */
  maxHistoryPoints?: number;
  /** SSL warn threshold (days) when a site enables ssl without a value. */
  sslWarnDays?: number;
  /** Domain warn thresholds (days). */
  domainWarnDays?: number[];
  /** User-agent sent with HTTP checks. */
  userAgent?: string;
}

/** The fully-parsed config object. */
export interface PulseConfig {
  /** Schema/version marker. */
  version?: number;
  brand?: BrandConfig;
  defaults?: EngineDefaults;
  groups?: GroupConfig[];
  sites: SiteConfig[];
  channels?: ChannelConfig[];
}

// ---------------------------------------------------------------------------
// Access control (config/permissions.json)
// ---------------------------------------------------------------------------

export interface UserPermission {
  email: string;
  role: Role;
  /** Group ids the user may view (CLIENT/VIEWER scoping). Empty = all (ADMIN+). */
  groups?: string[];
  /** Specific site ids the user may view. */
  sites?: string[];
}

export interface Permissions {
  users: UserPermission[];
}

// ---------------------------------------------------------------------------
// Check results & stored data (engine output under /data)
// ---------------------------------------------------------------------------

/** Raw result of probing a single site once. */
export interface CheckResult {
  siteId: string;
  status: Status;
  /** Round-trip time in ms, or null if the request never completed. */
  responseTime: number | null;
  /** HTTP status code, when applicable. */
  httpStatus?: number;
  /** ISO-8601 timestamp of the check. */
  checkedAt: string;
  /** Human-readable failure reason when status !== "up". */
  error?: string;
  ssl?: SslInfo;
  domain?: DomainInfo;
}

export interface SslInfo {
  /** ISO date the certificate expires. */
  validTo: string;
  daysRemaining: number;
  issuer?: string;
  subject?: string;
  /** True when within the configured warn window. */
  expiringSoon: boolean;
}

export interface DomainInfo {
  /** ISO date the domain registration expires. */
  expiresAt: string;
  daysRemaining: number;
  registrar?: string;
  expiringSoon: boolean;
}

/** Compact history point stored in `data/history/<id>.json`. */
export interface HistoryPoint {
  /** ISO timestamp. */
  t: string;
  /** Status. */
  s: Status;
  /** Response time ms (null = no response). */
  ms: number | null;
  /** HTTP code (omitted when not applicable). */
  c?: number;
  /** Error message (only present when down/degraded). */
  e?: string;
}

/** Per-day rollup for long-range graphs. */
export interface DailyRollup {
  /** YYYY-MM-DD (UTC). */
  d: string;
  up: number;
  down: number;
  degraded: number;
  total: number;
  /** Uptime ratio 0–1. */
  uptime: number;
  /** Average response time ms over the day. */
  avgMs: number | null;
}

/** Contents of `data/history/<id>.json`. */
export interface SiteHistory {
  id: string;
  /** Rolling raw points (newest last), capped at defaults.maxHistoryPoints. */
  points: HistoryPoint[];
  /** Daily rollups, oldest → newest. */
  daily: DailyRollup[];
}

// ---------------------------------------------------------------------------
// Incidents (data/incidents.json)
// ---------------------------------------------------------------------------

export interface IncidentUpdate {
  at: string;
  message: string;
}

export interface Incident {
  id: string;
  siteId: string;
  siteName: string;
  type: IncidentType;
  state: IncidentState;
  title: string;
  detail?: string;
  startedAt: string;
  resolvedAt?: string;
  /** Outage duration in ms (set when resolved). */
  durationMs?: number;
  updates?: IncidentUpdate[];
}

// ---------------------------------------------------------------------------
// Dashboard summary (data/summary.json) — the dashboard's primary fetch
// ---------------------------------------------------------------------------

export interface SiteSummary {
  id: string;
  name: string;
  url: string;
  group?: string;
  description?: string;
  tags?: string[];
  public: boolean;
  status: Status;
  paused?: boolean;
  responseTime: number | null;
  httpStatus?: number;
  lastChecked: string;
  error?: string;
  uptime24h: number;
  uptime7d: number;
  uptime30d: number;
  uptime90d: number;
  /** Average response time (ms) over the last 24h. */
  avgResponse24h: number | null;
  ssl?: SslInfo;
  domain?: DomainInfo;
  /** Last ~45 status buckets for the sparkline/uptime bar (newest last). */
  spark: Status[];
}

export interface GroupSummary {
  id: string;
  name: string;
  description?: string;
  icon?: string;
  status: OverallStatus;
  siteIds: string[];
}

export interface SummaryTotals {
  sites: number;
  up: number;
  down: number;
  degraded: number;
  paused: number;
  /** Overall uptime ratio 0–1 (across all sites, last 24h). */
  uptime: number;
}

export interface Summary {
  /** When this snapshot was generated (ISO). */
  generatedAt: string;
  brand: BrandConfig;
  overall: OverallStatus;
  totals: SummaryTotals;
  groups: GroupSummary[];
  sites: SiteSummary[];
  /** Active + recently-resolved incidents (most recent first). */
  incidents: Incident[];
}
