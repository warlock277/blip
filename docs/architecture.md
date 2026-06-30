# Architecture

Pulse has no servers and no database. It's three small pieces wired together by
GitHub and Cloudflare's free tiers.

```
                         pulse.config.yaml
                                │
                                ▼
        ┌──────────────────────────────────────────────┐
        │  GitHub Actions  (cron: */5 * * * *)          │
        │  @pulse/engine — probes every site            │
        │   • HTTP / TCP / SSL / domain checks          │
        │   • keyword + JSON assertions                 │
        │   • computes status, rollups, incidents       │
        └───────────────┬──────────────────┬───────────┘
                        │                  │
              writes & commits        sends alerts
                        │                  │
                        ▼                  ▼
        ┌───────────────────────┐   Telegram · Email
        │  /data  (JSON in repo) │   Discord · Slack
        │   summary.json         │   generic webhook
        │   history/<id>.json    │
        │   incidents.json       │
        │   state.json           │
        │   permissions.json     │
        └───────────┬───────────┘
                    │ push to main triggers deploy
                    ▼
        ┌───────────────────────────────────────────┐
        │  GitHub Actions  (deploy.yml)              │
        │  build @pulse/dashboard → copy /data in    │
        │  → deploy to Cloudflare Pages              │
        └───────────────┬───────────────────────────┘
                        ▼
              Cloudflare Pages (static SPA)
                        │
                        ▼
              Cloudflare Access (auth at the edge)
                        │
                        ▼
              Users · status page · admin dashboard
```

## The pieces

### 1. Monitoring engine — `@pulse/engine`

A TypeScript program run with `tsx` on GitHub Actions every 5 minutes
([`monitor.yml`](../.github/workflows/monitor.yml)). On each run it:

1. Loads and validates `pulse.config.yaml` (zod schema, `${ENV_VAR}`
   interpolation, derives site ids via `slugify`).
2. Probes each site concurrently: HTTP (status/keyword/JSON/timing), TCP
   connect, TLS-cert expiry, and domain-registration expiry.
3. Resolves each result to `up` / `degraded` / `down`, applying retries and the
   degraded threshold.
4. Appends to history, rolls older points up into per-day summaries, opens/closes
   incidents, and rebuilds `summary.json`.
5. Sends notifications for state transitions through the configured channels.
6. Commits the changed JSON back to the repo (`[skip ci]` so it doesn't trigger
   CI), guarded by `git diff --quiet` so empty runs don't create commits.

### 2. Data store — `/data` (JSON in Git)

No database. The committed JSON files **are** the database. Their shapes are
defined once in [`packages/shared/src/types.ts`](../packages/shared/src/types.ts)
and shared by both the engine (writer) and dashboard (reader).

| File                     | Type           | Purpose |
|--------------------------|----------------|---------|
| `data/summary.json`      | `Summary`      | The dashboard's primary fetch: totals, groups, per-site status + uptime, recent incidents. |
| `data/history/<id>.json` | `SiteHistory`  | Per-site raw points (capped at `maxHistoryPoints`) + daily rollups for long-range graphs. |
| `data/incidents.json`    | `Incident[]`   | Full incident log. |
| `data/state.json`        | engine-internal| Cross-run state (last status, open incidents, flapping timers). |
| `data/permissions.json`  | `Permissions`  | RBAC map consumed by the dashboard. |

Using Git as the store gives you a free, append-only **audit trail** — every
status change is a commit you can diff and revert.

### 3. Dashboard — `@pulse/dashboard`

A static React + Vite + TypeScript SPA. At runtime it `fetch`es the `/data/*.json`
files and renders the overview, per-site detail (24h/7d/30d/90d graphs), incident
history, and public status page. There's no backend — the deploy step copies
`/data` into the build output so the SPA can serve it as static files.

## Data flow timing

1. **Every 5 min:** `monitor.yml` runs, probes, and (if anything changed) commits
   to `main`.
2. **On that commit:** `deploy.yml` triggers (it watches `data/**` and the
   dashboard packages), rebuilds, and ships to Cloudflare Pages.
3. **Users** load the freshly-deployed static site. The SPA can also re-poll
   `summary.json` on an interval (`VITE_REFRESH_MS`) within a single deploy.

## Scaling limits

GitHub-hosted runners and the 5-minute cron impose practical limits. Each run has
to finish well inside its interval (checkout + `npm ci` + probes + commit).
Rough guidance from the project plan:

| Sites | Recommended interval | Notes |
|-------|----------------------|-------|
| ≤ 20  | 5 min                | Comfortable on free runners. |
| ≤ 50  | 10 min               | Halve the cron frequency. |
| ≤ 100 | 15 min               | Probes run concurrently; commit dominates. |

To go bigger: increase the interval, split sites across multiple repos/workflows,
or run the engine on a beefier self-hosted runner. GitHub Actions free minutes are
**unlimited for public repositories** and generous for private ones.

## Why GitHub Actions?

- **$0 and zero infrastructure** — no VM, container, or cron host to babysit.
- **External vantage point** — checks run from GitHub's network, so they catch
  outages your own infra can't see itself fail.
- **Built-in scheduler, secrets, and audit log.**
- **Git as the database** — diffable, revertible, no backups to manage.

## Pulse vs. vanilla Upptime

Upptime pioneered the "monitoring via GitHub Actions + static status page"
pattern, and it's excellent. Pulse keeps that core idea but is built for
**agencies and multi-tenant use**:

| Capability                         | Upptime | Pulse |
|------------------------------------|:------:|:-----:|
| GitHub Actions monitoring          |   ✅   |  ✅  |
| Static status page                 |   ✅   |  ✅  |
| Multi-tenant **groups**            |   ❌   |  ✅  |
| **RBAC** (4 roles)                 |   ❌   |  ✅  |
| Client-scoped dashboards           |   ❌   |  ✅  |
| Cloudflare **Access** auth         |   ❌   |  ✅  |
| JSON-body assertions               |  ⚠️   |  ✅  |
| TCP / SSL / domain-expiry checks   |  ⚠️   |  ✅  |
| Per-channel routing + flap suppression |  ⚠️ |  ✅  |
| Single typed config + shared types |   ❌   |  ✅  |

⚠️ = partial / via plugins or workarounds.

> If you just need a single public status page, vanilla Upptime is great. Reach
> for Pulse when you need tenants, roles, client-facing dashboards, or richer
> assertions.

See also: [configuration.md](configuration.md) ·
[deployment.md](deployment.md) · [access-control.md](access-control.md).
