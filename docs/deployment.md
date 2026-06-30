# Deployment

Get a fully working uptime monitor + status page running for **$0/month** on a
single Cloudflare Worker backed by D1. No server, no separate hosting step.

## Deploy in 5 minutes ✅

1. **Use the template / fork** this repo, then `npm install`.
2. **`npm run setup`** — the wizard writes your `blip.config.yaml`.
3. **Create the D1 database** and paste its id into `packages/worker/wrangler.toml`.
4. **Set your Worker secrets** (`wrangler secret put …`) for channels + auth.
5. **`npm run deploy --workspace @blip/worker`** — you're live.

The rest of this page expands each step.

---

## 1. Get the repo

Click **Use this template → Create a new repository** (or fork).

```bash
git clone https://github.com/<you>/<your-repo>.git
cd <your-repo>
npm install
```

> Use Node 20+ (the version in `.nvmrc` is used in CI). You'll also use
> [`wrangler`](https://developers.cloudflare.com/workers/wrangler/), which is
> already a dev dependency — invoke it with `npx wrangler …`.

## 2. Configure what to monitor

Run the interactive wizard:

```bash
npm run setup
```

It asks for branding, your sites, and which notification channels to enable, then
writes `blip.config.yaml` (backing up any existing one to `.bak`). Prefer to edit
by hand? Copy [`config/blip.config.example.yaml`](../config/blip.config.example.yaml)
and trim it down. Full field reference: [configuration.md](configuration.md).

Preview locally with demo data — no Cloudflare account needed:

```bash
npm run seed      # generates realistic sample data in /data
npm run dev       # http://localhost:5173
```

## 3. Create the D1 database

```bash
cd packages/worker
npx wrangler d1 create blip-db
```

Copy the printed `database_id` into the `[[d1_databases]]` block of
`packages/worker/wrangler.toml` (replace `PLACEHOLDER_SET_AT_DEPLOY`). Then apply
the schema:

```bash
npm run db:schema              # local; append --remote for the production DB:
npx wrangler d1 execute blip-db --remote --file=schema.sql
```

## 4. Set your secrets

The Worker reads secrets at runtime; set each one with `wrangler secret put`
(run from `packages/worker`). Add only what you use:

| Secret | Needed for |
|--------|-----------|
| `BLIP_SESSION_SECRET` | **Required** — signs login session cookies (any long random string). |
| `BLIP_PW_<ID>` | Password for a principal in `access:` (e.g. `BLIP_PW_ADMIN`). See [access-control.md](access-control.md). |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Telegram alerts |
| `RESEND_API_KEY` | Email alerts |
| `DISCORD_WEBHOOK_URL` | Discord alerts |
| `SLACK_WEBHOOK_URL` | Slack alerts |
| `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET` | Probing homelab origins behind Cloudflare Access ([guide](../deploy/homelab-tunnel/README.md)). |

```bash
echo -n 'a-long-random-string' | npx wrangler secret put BLIP_SESSION_SECRET
echo -n 'choose-a-password'     | npx wrangler secret put BLIP_PW_ADMIN
# …repeat for each channel/principal you reference in blip.config.yaml
```

How to obtain each notification credential: [notifications.md](notifications.md).

## 5. Deploy

```bash
# from packages/worker (or use --workspace @blip/worker from the repo root)
npm run deploy
```

This runs `gen-config` (embeds your `blip.config.yaml` into the Worker), builds
the dashboard assets, and `wrangler deploy`s the Worker. The cron starts on its
5-minute schedule; the next tick (≤5 min) populates D1. Check
`https://<your-worker>.workers.dev/data/summary.json`.

## 6. Custom domain

In `wrangler.toml`, point the route at your hostname:

```toml
routes = [
  { pattern = "status.yourdomain.com", custom_domain = true }
]
```

Cloudflare creates the DNS record + TLS cert automatically (the zone must be on
Cloudflare). Redeploy with `npm run deploy`.

## 7. Lock it down

Authentication and RBAC are built into the Worker — anonymous visitors see only
public sites (when `publicStatusPage: true`); everything else requires a login.
Set up principals and passwords, and optionally layer Cloudflare Access in front
of the admin paths, in [access-control.md](access-control.md).

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Deploy fails: invalid `database_id` | You didn't paste the real id from `wrangler d1 create` into `wrangler.toml`. |
| `/data/summary.json` is empty | Wait for the first cron tick (≤5 min), or trigger one with `npx wrangler dev` locally; confirm the schema was applied (`npm run db:schema --remote`). |
| Can't log in | `BLIP_SESSION_SECRET` and the relevant `BLIP_PW_<ID>` secret must both be set; the `<ID>` is the principal id uppercased (`admin` → `BLIP_PW_ADMIN`). |
| Dashboard loads but is empty | The build didn't bundle the dashboard assets — run `npm run build --workspace @blip/dashboard` then redeploy. |
| Homelab sites all `down` | Service token not set, or the Access policy doesn't allow it — see [homelab-tunnel](../deploy/homelab-tunnel/README.md). |

See also: [configuration.md](configuration.md) ·
[notifications.md](notifications.md) · [architecture.md](architecture.md) ·
[faq.md](faq.md).
