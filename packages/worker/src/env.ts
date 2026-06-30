/** Worker bindings (wrangler.toml) + secrets. */
export interface Env {
  /** D1 database binding (points + kv tables). */
  DB: D1Database;
  /** Static dashboard assets. */
  ASSETS: Fetcher;
  /** How often (hours) to refresh the slow SSL + domain probes. Default 6. */
  SSL_REFRESH_HOURS?: string;
  /** HMAC key for signing session cookies (Worker secret). */
  BLIP_SESSION_SECRET?: string;
  /**
   * Per-principal passwords, as secrets named BLIP_PW_<ID> (uppercased id).
   * Accessed dynamically; declared via index signature.
   */
  [key: string]: unknown;
}
