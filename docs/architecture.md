# Architecture

Blip is **one Cloudflare Worker**. It has no server to run and no database to
host — the Worker probes your sites on a cron, stores results in Cloudflare D1
(managed SQLite), and serves the dashboard + status page from the same URL.

```
                         blip.config.yaml
                                │  (embedded into the Worker at build time)
                                ▼
        ┌──────────────────────────────────────────────┐
        │              Cloudflare Worker                │
        │                                               │
        │  scheduled()  (cron: */5 * * * *)             │
        │   • probe each site: HTTP / TCP / SSL / domain│
        │   • keyword + JSON assertions                 │
        │   • compute status, rollups, incidents        │
        │   • append to D1 + precompute JSON blobs       │
        │   • send alerts ───────────────┐              │
        │                                │              │
        │  fetch()                       │              │
        │   • /data/*.json  ← from D1     │              │
        │   • /auth/*       login/session│              │
        │   • everything else ← dashboard SPA (ASSETS)  │
        └──────────────┬─────────────────┼─────────────┘
                       │                 ▼
                       ▼          Telegram · Email · Discord
        ┌──────────────────────┐  Slack · generic webhook
        │   Cloudflare D1       │
        │   points (raw)        │
        │   kv  (JSON blobs)    │
        └──────────────────────┘
                       │
                       ▼
        Users · status page · admin dashboard
        (RBAC + password auth, enforced server-side)
```

## The pieces

### 1. Monitoring + serving — `@blip/worker`

A single Cloudflare Worker ([`packages/worker`](../packages/worker/README.md))
with two entry points:

**`scheduled()`** runs on the cron trigger (every 5 minutes). On each tick it:

1. Reads the config embedded at build time (the Worker has no filesystem, so
   `scripts/gen-config.mjs` parses `blip.config.yaml` and writes
   `src/config.generated.ts`; `${ENV_VAR}` refs resolve from Worker secrets at
   runtime).
2. Probes each site: HTTP (status/keyword/JSON/timing), TCP connect, TLS-cert
   expiry, and domain-registration expiry. SSL/domain probes are slow and
   rate-limited, so they refresh only every `SSL_REFRESH_HOURS` (default 6h) and
   are cached between ticks.
3. Resolves each result to `up` / `degraded` / `down`, applying retries and the
   degraded threshold.
4. Appends raw points to D1, rolls older points into daily summaries, opens/closes
   incidents, and precomputes the `summary` / `history:<id>` / `incidents` blobs.
5. Sends notifications for state transitions through the configured channels.

**`fetch()`** serves HTTP. `/data/*.json` is served live from D1, `/auth/*`
handles login/session, and everything else falls through to the static dashboard
SPA. (`run_worker_first` in `wrangler.toml` makes the Worker handle `/data/*` and
`/auth/*` before the static assets, so the JSON API is never shadowed.)

### 2. Data store — Cloudflare D1

No database to host. D1 is Cloudflare's managed SQLite, bound to the Worker as
`DB`. Two tables ([`schema.sql`](../packages/worker/schema.sql)):

| Table    | Purpose |
|----------|---------|
| `points` | Raw per-site history points (capped per site, then rolled up daily). |
| `kv`     | JSON state + precomputed blobs: `summary`, `history:<id>`, `incidents`. |

The `/data/*.json` the dashboard fetches is byte-shape-compatible with the
`Summary`, `SiteHistory`, and `Incident[]` types in
[`packages/shared/src/types.ts`](../packages/shared/src/types.ts), so the
dashboard renders unchanged regardless of where the bytes come from.

### 3. Dashboard — `@blip/dashboard`

A static React + Vite + TypeScript SPA. At runtime it `fetch`es `/data/*.json`
(served by the Worker from D1) and renders the overview, per-site detail
(24h/7d/30d/90d graphs), incident history, and public status page. It is built to
`packages/dashboard/dist` and bundled into the Worker as static assets — there's
no separate hosting step.

## Data flow timing

1. **Every 5 min:** the Worker's `scheduled()` handler probes and writes to D1.
2. **On every request:** `fetch()` serves the dashboard and reads the latest
   blobs from D1 — no rebuild or redeploy needed for data to update.
3. **Clients** can re-poll `summary.json` on an interval (`VITE_REFRESH_MS`).

## Scaling limits

The 5-minute cron and the Worker's per-invocation CPU budget set practical
limits. SSL/domain probes are cached (see above) so a tick is dominated by the
HTTP/TCP checks, which run concurrently.

| Sites | Recommended interval | Notes |
|-------|----------------------|-------|
| ≤ 50  | 5 min                | Comfortable within a single Worker tick. |
| ≤ 100 | 10 min               | Halve the cron frequency. |

To go bigger: raise the interval, or split sites across multiple Workers. The
free tier covers 100k requests/day and 5M D1 rows read/day — far more than a
5-minute cron and a handful of dashboard viewers consume.

## Why a Cloudflare Worker?

- **$0 and zero infrastructure** — no VM, container, or cron host to babysit.
- **External vantage point** — checks run from Cloudflare's edge, so they catch
  outages your own infra can't see itself fail.
- **One thing to deploy** — monitor, API, and dashboard are the same Worker.
- **Reaches your LAN without open ports** — pair with a Cloudflare Tunnel +
  Access service token to probe homelab services. See
  [`deploy/homelab-tunnel/`](../deploy/homelab-tunnel/).

## Blip vs. Upptime

Upptime pioneered the "monitoring via GitHub Actions + static status page"
pattern. Blip moves the same idea onto a single edge Worker and is built for
**agencies, teams, and homelabbers**:

| Capability                         | Upptime | Blip |
|------------------------------------|:------:|:-----:|
| Static status page                 |   ✅   |  ✅  |
| Runs with no server                |   ✅   |  ✅  |
| Monitor LAN/homelab (no open ports)|   ❌   |  ✅  |
| Multi-tenant **groups**            |   ❌   |  ✅  |
| **RBAC** (4 roles, server-side)    |   ❌   |  ✅  |
| Client-scoped dashboards           |   ❌   |  ✅  |
| JSON-body assertions               |  ⚠️   |  ✅  |
| TCP / SSL / domain-expiry checks   |  ⚠️   |  ✅  |
| Per-channel routing + flap suppression |  ⚠️ |  ✅  |
| Single typed config + shared types |   ❌   |  ✅  |

⚠️ = partial / via plugins or workarounds.

> If you just need a single public status page, vanilla Upptime is great. Reach
> for Blip when you need tenants, roles, client-facing dashboards, richer
> assertions, or homelab monitoring.

See also: [configuration.md](configuration.md) ·
[deployment.md](deployment.md) · [access-control.md](access-control.md).
