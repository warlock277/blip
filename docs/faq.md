# FAQ

### Is it really free?

Yes — Pulse is designed to run entirely on free tiers: GitHub Actions (monitoring
+ data store), Cloudflare Pages (hosting), Telegram (alerts), and Resend's free
tier (email). No database, no servers, **$0/month** for typical usage. The only
thing you might pay for is a domain name, which is optional.

### How many sites can I monitor, and how often?

The 5-minute cron and free GitHub runners set the practical ceiling. Rough
guidance:

| Sites | Interval |
|-------|----------|
| ≤ 20  | 5 min    |
| ≤ 50  | 10 min   |
| ≤ 100 | 15 min   |

To scale further, increase the interval, split sites across multiple
repos/workflows, or use a self-hosted runner. See
[architecture.md → scaling limits](architecture.md#scaling-limits).

### Should my repo be public or private?

- **Public:** anyone can read the committed `/data/*.json`. Fine for a fully
  public status page with no sensitive endpoints. Bonus: GitHub Actions minutes
  are unlimited on public repos.
- **Private:** required if any monitored URL, response detail, or client data
  should stay confidential, or if you use RBAC.

Client-side role filtering is **UX only** — real privacy comes from a private
repo plus Cloudflare Access. See [access-control.md](access-control.md).

### Can I run multiple status pages?

Yes, a few ways:

- **One deployment, many groups.** Use `groups:` to separate tenants and scope
  who sees what with `permissions.json` + Cloudflare Access.
- **Separate public + private surfaces.** Keep a public status page open while
  gating admin/client views behind Cloudflare Access (separate subdomain or a
  path-scoped Access policy).
- **Fully separate pages.** Run multiple repos/deployments — one per brand or
  client — each with its own config and Cloudflare Pages project.

### Can I use a custom domain?

Yes. Add it in your Cloudflare Pages project's **Custom domains** tab (e.g.
`status.yourdomain.com`); TLS is provisioned automatically. See
[deployment.md → custom domain](deployment.md#6-custom-domain).

### How do I remove the "Pulse" branding / white-label it?

Set your own values under `brand:` in `pulse.config.yaml` — `name`, `tagline`,
`primaryColor`, `logoUrl`, `faviconUrl`, `website`, `supportUrl`. That rebrands
the dashboard and public status page. The project is MIT-licensed, so you're free
to white-label it for clients. (A small attribution link back to the project is
appreciated but not required.)

### Does monitoring run from inside my infrastructure?

No — checks run from GitHub's network, giving you a genuine **external** vantage
point. That's a feature: it catches outages your own infra can't observe itself
failing.

### What check types are supported?

HTTP (status codes, keyword present/absent, JSON-body assertions, response
timing), raw **TCP** port checks, **TLS certificate** expiry, and **domain
registration** expiry. SSL and domain watches can also be layered onto an
HTTP/TCP site. See [configuration.md](configuration.md#sites).

### How do I test changes before going live?

```bash
npm run seed         # demo data for local preview
npm run dev          # run the dashboard locally
npm run monitor:dry  # validate the real config; no alerts, no commits
```

### What does an incident look like / how are they detected?

The engine tracks each site's status across runs. A transition to `down`/`degraded`
opens an `Incident`; recovery resolves it (recording `durationMs`). SSL/domain
warn windows open `ssl_expiring` / `domain_expiring` incidents. They're stored in
`data/incidents.json` and surfaced on the dashboard.

### Why GitHub Actions instead of a cron VM?

Free, zero-maintenance, external vantage point, built-in secrets + scheduler, and
Git gives you a diffable audit trail of every status change. See
[architecture.md → why GitHub Actions](architecture.md#why-github-actions).

### How is this different from Upptime or Uptime Kuma?

Pulse keeps Upptime's "Actions + static page" model but adds multi-tenant groups,
RBAC, client-scoped dashboards, Cloudflare Access auth, and richer assertions.
Unlike Uptime Kuma, it needs **no server** to run. Full comparison in the
[README](../README.md#-pulse-vs-upptime-vs-uptime-kuma) and
[architecture.md](architecture.md#pulse-vs-vanilla-upptime).

---

Didn't find your answer? Open a
[discussion](https://github.com/pulse/pulse/discussions) or read the rest of the
[docs](.).
