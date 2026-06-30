# FAQ

### Is it really free?

Yes — Blip runs entirely on free tiers: one Cloudflare Worker (monitoring + API +
dashboard), Cloudflare D1 (storage), Telegram (alerts), and Resend's free tier
(email). No server, no VM, **$0/month** for typical usage. The only thing you
might pay for is a domain name, which is optional.

### How many sites can I monitor, and how often?

The 5-minute cron and the Worker's per-tick CPU budget set the practical ceiling.
SSL/domain probes are cached and refreshed only every few hours, so a tick is
dominated by the fast HTTP/TCP checks. Rough guidance:

| Sites | Interval |
|-------|----------|
| ≤ 50  | 5 min    |
| ≤ 100 | 10 min   |

To scale further, raise the interval or split sites across multiple Workers. See
[architecture.md → scaling limits](architecture.md#scaling-limits).

### Who can see my data?

Authentication and RBAC are enforced **server-side in the Worker**:

- **Public status page:** with `access.publicStatusPage: true`, anyone can view
  sites marked `public: true` — and only those — without logging in.
- **Everything else** requires a login. `CLIENT`/`VIEWER` principals only ever
  receive their scoped groups/sites; the Worker never sends them another tenant's
  data. See [access-control.md](access-control.md).

There's no public JSON dump to leak — `/data/*.json` is filtered per request.

### Can I run multiple status pages?

Yes, a few ways:

- **One deployment, many groups.** Use `groups:` to separate tenants and scope
  who sees what with `access.principals` (roles + groups/sites).
- **Separate public + private surfaces.** Keep the public status page open while
  every other view requires a login — all from the same Worker.
- **Fully separate pages.** Deploy multiple Workers — one per brand or client —
  each with its own config and custom domain.

### Can I use a custom domain?

Yes. Point the `routes` entry in `packages/worker/wrangler.toml` at your hostname
(e.g. `status.yourdomain.com`) and redeploy; Cloudflare provisions DNS + TLS
automatically. See [deployment.md → custom domain](deployment.md#6-custom-domain).

### Can I monitor services on my home network / LAN?

Yes — and without exposing any ports. Run a Cloudflare Tunnel on your LAN and give
the Worker a Cloudflare Access **service token**, so only the Worker (never the
public internet) reaches the origin. Full walkthrough:
[`deploy/homelab-tunnel/`](../deploy/homelab-tunnel/README.md).

### How do I remove the "Blip" branding / white-label it?

Set your own values under `brand:` in `blip.config.yaml` — `name`, `tagline`,
`primaryColor`, `logoUrl`, `faviconUrl`, `website`, `supportUrl`. That rebrands
the dashboard and public status page. The project is MIT-licensed, so you're free
to white-label it for clients. (A small attribution link back to the project is
appreciated but not required.)

### Does monitoring run from inside my infrastructure?

No — checks run from Cloudflare's edge, giving you a genuine **external** vantage
point. That's a feature: it catches outages your own infra can't observe itself
failing. (LAN/homelab origins are the exception — those are reached deliberately
through a tunnel.)

### What check types are supported?

HTTP (status codes, keyword present/absent, JSON-body assertions, response
timing), raw **TCP** port checks, **TLS certificate** expiry, and **domain
registration** expiry. SSL and domain watches can also be layered onto an
HTTP/TCP site. See [configuration.md](configuration.md#sites).

### How do I test changes before going live?

```bash
npm run seed   # demo data for local preview
npm run dev    # run the dashboard locally against it
```

For the Worker itself, `npm run dev --workspace @blip/worker` runs it under
`wrangler dev` against a local D1.

### What does an incident look like / how are they detected?

The Worker tracks each site's status across ticks. A transition to `down`/`degraded`
opens an `Incident`; recovery resolves it (recording `durationMs`). SSL/domain
warn windows open `ssl_expiring` / `domain_expiring` incidents. They're stored in
D1 and surfaced on the dashboard.

### Why a Cloudflare Worker instead of a cron VM?

Free, zero-maintenance, external vantage point, built-in scheduler + secrets, and
one thing to deploy (monitor + API + dashboard). See
[architecture.md → why a Cloudflare Worker](architecture.md#why-a-cloudflare-worker).

### How is this different from Upptime or Uptime Kuma?

Blip keeps Upptime's "no server, static status page" model but moves it onto one
edge Worker and adds multi-tenant groups, server-side RBAC, client-scoped
dashboards, richer assertions, and homelab monitoring. Unlike Uptime Kuma, it
needs **no server** to run. Full comparison in the
[README](../README.md#-blip-vs-upptime-vs-uptime-kuma) and
[architecture.md](architecture.md#blip-vs-upptime).

---

Didn't find your answer? Open a discussion on your repo or read the rest of the
[docs](.).
