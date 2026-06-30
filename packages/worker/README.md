# @blip/worker — Cloudflare-native monitoring mode

A single **Cloudflare Worker** that replaces the GitHub-Actions engine. It is an
alternative monitoring backend for [Blip](../../README.md): instead of a CI job
committing JSON to a repo, **one Worker** does everything.

## What it does

- **Runs checks on a Cron Trigger** (every 5 minutes) — HTTP, TCP, plus
  best-effort SSL + domain-expiry probes.
- **Stores results in D1** (Cloudflare's SQLite): raw history in `points`, and
  JSON state + precomputed blobs in `kv`.
- **Serves the dashboard** (static assets) **and the `/data/*.json` API** the
  dashboard fetches — all from the same Worker.

```
                 ┌──────────────────────── Cloudflare Worker ───────────────────────┐
  cron (*/5) ──▶ │ scheduled(): probe sites → append points → reconcile incidents →  │
                 │              precompute blob:summary / blob:history:* / blob:incidents
                 │                                   │                                │
   browser ────▶ │ fetch(): /data/*.json ───────────┘  (served from D1 kv)           │
                 │          everything else ─────────▶ ASSETS (static dashboard SPA)  │
                 └───────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
                              D1 (blip-db): points + kv
```

The output of `/data/summary.json`, `/data/history/<id>.json` and
`/data/incidents.json` is byte-shape-compatible with `@blip/shared`'s `Summary`,
`SiteHistory` and `Incident[]`, so the existing dashboard renders unchanged.

## Setup & deploy

```bash
# 1. Create the D1 database, then paste the printed id into wrangler.toml
#    ([[d1_databases]].database_id, replacing PLACEHOLDER_SET_AT_DEPLOY).
npx wrangler d1 create blip-db

# 2. Apply the schema (creates points + kv).
npm run db:schema            # add --remote for the production DB

# 3. Build the dashboard so its static assets exist at ../dashboard/dist.
npm run build --workspace @blip/dashboard

# 4. Generate the embedded config from ../../blip.config.yaml, then deploy.
npm run deploy               # = gen-config + wrangler deploy
```

Local development: `npm run dev` (runs `gen-config` then `wrangler dev`).

### Config embedding

The Worker has no filesystem, so `blip.config.yaml` cannot be read at runtime.
`scripts/gen-config.mjs` parses it at build time, applies `DEFAULTS`, derives
site ids, normalizes `ssl`/`domain` to concrete warn windows, and writes
`src/config.generated.ts`. That file is **generated** (gitignored) and rebuilt by
every `build`/`deploy`/`dev`.

## SSL / crt.sh caveat

Cloudflare Workers **cannot read the peer certificate** of a TLS connection
(there is no `node:tls`, and `cloudflare:sockets` does not expose cert details).
So the SSL-expiry check is a **best-effort approximation via the
[crt.sh](https://crt.sh) Certificate Transparency log**: it queries crt.sh for
certs issued for the host and takes the latest `not_after` of a matching entry.

Caveats: CT logs lag real issuance slightly, list all historical certs, and
crt.sh is rate-limited. It is intentionally swappable — replace `checkSsl()` in
`src/checks.ts` with a real SSL/cert API if you need authoritative data. Because
SSL **and** domain (RDAP) probes are slow/rate-limited, they refresh only every
`SSL_REFRESH_HOURS` (default 6h) and are cached in `state` between ticks.

## Files

| File | Purpose |
| --- | --- |
| `wrangler.toml` | Worker config: cron, D1 binding, static assets. |
| `schema.sql` | D1 tables `points` + `kv`. |
| `scripts/gen-config.mjs` | Embeds the resolved config → `src/config.generated.ts`. |
| `src/index.ts` | `scheduled` + `fetch` entry point. |
| `src/checks.ts` | HTTP / TCP / domain (RDAP) / SSL (crt.sh) probes. |
| `src/store.ts` | D1 helpers over `points` + `kv`. |
| `src/summary.ts` | Builds `Summary` + per-site `SiteHistory`. |
| `src/incidents.ts` | Incident reconciliation. |
| `src/state.ts` | Cross-run state (kv key `state`). |
