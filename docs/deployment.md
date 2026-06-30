# Deployment

Get a fully working uptime monitor + status page running for **$0/month**. The
monitoring engine runs on GitHub Actions; the dashboard is served from Cloudflare
Pages.

## Deploy in 5 minutes ✅

1. **Use the template / fork** this repo into your own GitHub account.
2. **`npm install`** then **`npm run setup`** — the wizard writes your
   `pulse.config.yaml`.
3. **Add GitHub secrets** for the channels you enabled (and Cloudflare).
4. **Enable GitHub Actions** so the `monitor` workflow starts on its 5-min cron.
5. **Connect Cloudflare Pages** (build `npm run build`, output
   `packages/dashboard/dist`, copy `/data` in). Push and you're live.

The rest of this page expands each step.

---

## 1. Get the repo

Click **Use this template → Create a new repository** (or fork). A **private**
repo is recommended if any site is non-public or you'll use RBAC — see
[access-control.md](access-control.md).

```bash
git clone https://github.com/<you>/<your-repo>.git
cd <your-repo>
npm install
```

> Use Node 20+ (Node 22 is pinned in `.nvmrc` and used in CI).

## 2. Configure what to monitor

Run the interactive wizard:

```bash
npm run setup
```

It asks for branding, your sites, and which notification channels to enable, then
writes `pulse.config.yaml` (backing up any existing one to `.bak`). Prefer to edit
by hand? Copy [`config/pulse.config.example.yaml`](../config/pulse.config.example.yaml)
and trim it down. Full field reference: [configuration.md](configuration.md).

Preview locally with demo data:

```bash
npm run seed      # generates realistic sample data in /data
npm run dev       # http://localhost:5173
```

Validate your real config without sending alerts or committing:

```bash
npm run monitor:dry
```

## 3. Set GitHub secrets

**Settings → Secrets and variables → Actions → New repository secret.** Add only
what you use:

| Secret | Needed for |
|--------|-----------|
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Telegram alerts |
| `RESEND_API_KEY` | Email alerts |
| `DISCORD_WEBHOOK_URL` | Discord alerts |
| `SLACK_WEBHOOK_URL` | Slack alerts |
| `PAGER_WEBHOOK_URL` | Generic webhook (example name) |
| `ACME_API_TOKEN` | Authenticated probes (example name) |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | Cloudflare Pages deploy |

How to obtain each notification credential: [notifications.md](notifications.md).

## 4. Enable Actions & start monitoring

1. Open the **Actions** tab and enable workflows if prompted.
2. The **`monitor`** workflow runs every 5 minutes on its cron. To run it
   immediately, open it → **Run workflow** (`workflow_dispatch`).
3. It needs **write** permission to commit `/data`. The workflow already declares
   `permissions: contents: write`; also confirm **Settings → Actions → General →
   Workflow permissions** is set to **Read and write permissions**.

After the first successful run you'll see commits like
`chore(data): update monitoring snapshot [skip ci]` and JSON appearing under
`/data`.

## 5. Connect Cloudflare Pages

You have two options.

### Option A — deploy from GitHub Actions (recommended, in this repo)

The included [`deploy.yml`](../.github/workflows/deploy.yml) builds the dashboard,
copies `/data` into the output, and deploys with `cloudflare/wrangler-action`.

1. **Create a Pages project:** Cloudflare dashboard → **Workers & Pages → Create →
   Pages → "Direct Upload"**. Name it (e.g. `pulse`).
2. **Create an API token:** My Profile → **API Tokens → Create Token** → use the
   *Edit Cloudflare Workers* template (or scope to *Account › Cloudflare Pages ›
   Edit*).
3. **Find your Account ID:** Workers & Pages → right sidebar.
4. Add GitHub secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
5. Set `PROJECT_NAME` in `deploy.yml` to match step 1.
6. Push to `main` (or run the workflow manually). The deploy triggers on changes
   to `packages/dashboard/**`, `packages/shared/**`, or `data/**`.

### Option B — Cloudflare Git integration

Connect the repo directly in the Cloudflare dashboard (**Workers & Pages → Create
→ Pages → Connect to Git**):

- **Build command:** `npm run build`
- **Build output directory:** `packages/dashboard/dist`
- **Important — copy the data:** the SPA fetches `/data/*.json`, so the build
  output must contain a `data/` folder. Either keep using `deploy.yml`'s copy
  step, or add a postbuild copy in the dashboard package that copies repo-root
  `/data` into `dist/data`. (Cloudflare's own deploy won't run the workflow's
  copy step, so make sure the data ends up in `dist`.)

## 6. Custom domain

1. Cloudflare **Pages project → Custom domains → Set up a domain** (e.g.
   `status.yourdomain.com`).
2. Cloudflare creates the DNS record automatically if the zone is on Cloudflare;
   otherwise add the shown `CNAME`.
3. TLS is provisioned automatically.

## 7. Lock it down (optional but recommended)

Put **Cloudflare Access** in front of the deployment so only authorized users can
open the dashboard, and keep the repo private. Full walkthrough:
[access-control.md](access-control.md).

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `monitor` run fails to push | Set **Workflow permissions** to *Read and write* (Settings → Actions → General). |
| No `/data` after a run | Check the `monitor` logs — `npm run monitor:dry` locally to validate the config. |
| Dashboard loads but is empty | The build output is missing `data/` — verify the copy step (Option B note above). |
| Cloudflare deploy fails auth | Re-check `CLOUDFLARE_API_TOKEN` scope and `CLOUDFLARE_ACCOUNT_ID`; confirm `PROJECT_NAME` matches the Pages project. |
| Scheduled runs are late/skipped | GitHub may delay/skip cron under load; this is expected on free runners. |

See also: [configuration.md](configuration.md) ·
[notifications.md](notifications.md) · [architecture.md](architecture.md) ·
[faq.md](faq.md).
