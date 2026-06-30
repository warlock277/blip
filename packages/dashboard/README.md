# @pulse/dashboard

The Pulse web UI — a static **React + Vite + TypeScript** SPA that reads the
JSON produced by the monitoring engine and renders an admin dashboard plus a
public, branded status page. Designed to deploy to **Cloudflare Pages**.

## Quick start

```bash
npm install            # from the repo root (workspaces)
npm run dev            # → http://localhost:5173
```

`npm run dev` serves seeded demo data so the UI renders immediately:

- In dev, a tiny Vite middleware (`vite.config.ts`) serves `/data/*` from the
  repo-root `/data` directory when it exists (written by the engine / seed
  script). When it doesn't, it falls through to the **bundled demo data** in
  `public/data/` so the app always has something to show.
- Regenerate the bundled demo data with `node scripts/gen-demo-data.mjs`.

In production the deploy step copies the real `/data` into the build output, so
the same `/data/...` fetch paths work unchanged.

## Scripts

| Script             | Description                                  |
| ------------------ | -------------------------------------------- |
| `npm run dev`      | Vite dev server with the `/data` middleware. |
| `npm run build`    | Typecheck (`tsc --noEmit`) then `vite build`.|
| `npm run preview`  | Preview the production build.                |
| `npm run typecheck`| Strict type-check only.                      |

## Data it reads

Base URL = `import.meta.env.VITE_DATA_BASE ?? "/data"`.

| File                       | Type            | Used by                       |
| -------------------------- | --------------- | ----------------------------- |
| `summary.json`             | `Summary`       | Everything (primary fetch).   |
| `history/<siteId>.json`    | `SiteHistory`   | Site-detail charts.           |
| `incidents.json`           | `Incident[]`    | Incidents page.               |
| `permissions.json`         | `Permissions`   | RBAC UX gating (optional).    |

All shapes come from `@pulse/shared`.

## Environment variables

| Variable           | Default   | Purpose                                   |
| ------------------ | --------- | ----------------------------------------- |
| `VITE_DATA_BASE`   | `/data`   | Base URL for the JSON data files.         |
| `VITE_REFRESH_MS`  | `60000`   | Polling interval (ms). `0` disables.      |
| `VITE_DEV_ROLE`    | —         | Dev-only RBAC role override.              |
| `VITE_DEV_EMAIL`   | —         | Dev-only identity override.               |

## Routes

| Path          | Page            | Notes                                    |
| ------------- | --------------- | ---------------------------------------- |
| `/`           | Overview        | Banner, KPIs, searchable site grid.      |
| `/sites`      | Sites           | Dense sortable / filterable table.       |
| `/sites/:id`  | Site detail     | Charts, SSL/domain, incident history.    |
| `/incidents`  | Incidents       | Timeline, open highlighted.              |
| `/status`     | Public status   | Branded, standalone, 90-day uptime bars. |
| `/settings`   | Settings/About  | Read-only brand, channels, roles.        |

## Access control (important)

`src/lib/auth.ts` performs **UX gating only — it is not a security boundary.**
The real boundary is:

1. **Cloudflare Access** at the edge (who can reach the app at all), and
2. a **private data repository** (so unauthorized users can't read the raw JSON).

The dashboard tries to read the signed-in email from
`/cdn-cgi/access/get-identity`, loads `permissions.json`, and resolves a `Role`
plus allowed groups/sites to decide *what to show*. If identity or permissions
are unavailable it degrades gracefully to an open ADMIN-equivalent view (and
public-only for `/status`). No secrets are ever rendered.
