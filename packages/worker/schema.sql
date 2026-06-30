-- ============================================================================
--  Pulse Worker — D1 (SQLite) schema
--
--  Two tables:
--    points : raw history, one row per check per site (t = epoch ms).
--    kv     : JSON key/value docs — engine `state`, `incidents`, and the
--             precomputed blobs the dashboard fetches (blob:summary,
--             blob:history:<id>, blob:incidents).
--
--  Apply with:  npm run db:schema
--  (remote:     wrangler d1 execute pulse-db --remote --file=schema.sql)
-- ============================================================================

-- Raw history points. One row per (site, check).
--   site_id : ResolvedSite.id
--   t       : epoch milliseconds (check time)
--   s       : status — 'up' | 'down' | 'degraded'
--   ms      : response time in ms (NULL when no response)
--   c       : HTTP status code (NULL when not applicable)
--   e       : error message (NULL when status = 'up')
CREATE TABLE IF NOT EXISTS points (
  site_id TEXT    NOT NULL,
  t       INTEGER NOT NULL,
  s       TEXT    NOT NULL,
  ms      INTEGER,
  c       INTEGER,
  e       TEXT
);

-- Range/window queries are always (site_id, time-ordered).
CREATE INDEX IF NOT EXISTS idx_points_site_t ON points (site_id, t);

-- JSON document store.
--   k : 'state' | 'incidents' | 'blob:summary' | 'blob:incidents'
--       | 'blob:history:<site_id>'
--   v : serialized JSON
CREATE TABLE IF NOT EXISTS kv (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
