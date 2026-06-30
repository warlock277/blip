# Access control (RBAC)

Authentication and authorization are **built into the Worker and enforced
server-side** — the dashboard never receives data a viewer isn't allowed to see.
There are two layers:

1. **Login (authentication).** Each principal has a password. A correct password
   issues an HMAC-signed, HttpOnly session cookie. Anonymous visitors get the
   public set only (when `publicStatusPage` is on).
2. **RBAC (authorization).** The principal's role + scope decide which groups and
   sites appear. `SUPER_ADMIN`/`ADMIN` see everything; `CLIENT`/`VIEWER` are
   scoped. The Worker filters `summary`, `incidents`, and per-site history
   **before** sending the response.

> Because filtering happens in the Worker (not the browser), a `CLIENT` literally
> cannot fetch another tenant's data — there's no `/data/*.json` containing it in
> the first place. This is a real boundary, not a UI convenience.

---

## Roles

| Role          | Sees | Typical user |
|---------------|------|--------------|
| `SUPER_ADMIN` | Everything: all groups, all sites, all incidents, admin views. | Owner / operator. |
| `ADMIN`       | All groups and sites. | Ops team. |
| `CLIENT`      | Only the groups and sites scoped to them. | A customer viewing their own sites. |
| `VIEWER`      | Read-only, scoped to assigned groups/sites. | Stakeholder / read-only teammate. |

`SUPER_ADMIN` and `ADMIN` ignore `groups`/`sites` scoping. `CLIENT` and `VIEWER`
are restricted to whatever you scope them to. Anonymous (no login) sees only
sites marked `public: true`, and only when `access.publicStatusPage` is `true`.

---

## Configuring principals

Access lives under `access:` in `blip.config.yaml`:

```yaml
access:
  publicStatusPage: true        # anyone can view /status (public sites only)
  principals:
    - id: admin
      label: Admin
      role: ADMIN
      password: ${BLIP_PW_ADMIN} # → wrangler secret put BLIP_PW_ADMIN
    - id: acme-client
      label: Acme Inc
      role: CLIENT
      groups: [acme]            # scoped: only the "acme" group's sites
      password: ${BLIP_PW_ACME_CLIENT}
```

### Setting a principal's password (first match wins)

1. **`${ENV_VAR}` ref** (recommended): `password: ${BLIP_PW_ADMIN}`, then
   `wrangler secret put BLIP_PW_ADMIN`.
2. **Inline literal**: `password: "letmein"` — plaintext in the repo, **dev/demo
   only**.
3. **Convention**: omit `password` entirely and set `BLIP_PW_<ID>` (the principal
   id uppercased, non-alphanumerics → `_`, e.g. `acme-client` → `BLIP_PW_ACME_CLIENT`).

The session-cookie signing key is always a secret:
`wrangler secret put BLIP_SESSION_SECRET`. Without it, login is disabled.

### Fields (`principals[]`)

| Field      | Type     | Required | Notes |
|------------|----------|----------|-------|
| `id`       | string   | **yes**  | Stable id; derives the `BLIP_PW_<ID>` secret name. |
| `label`    | string   | **yes**  | Display name after login. |
| `role`     | enum     | **yes**  | `SUPER_ADMIN` \| `ADMIN` \| `CLIENT` \| `VIEWER`. |
| `groups`   | string[] | no       | Group ids the principal may view (for `CLIENT`/`VIEWER`). |
| `sites`    | string[] | no       | Specific site ids the principal may view (in addition to `groups`). |
| `password` | string   | no       | `${ENV_VAR}` ref or literal; omit to use `BLIP_PW_<ID>`. |

> `groups` and `sites` reference ids from `blip.config.yaml`. Site ids are the
> derived slugs (e.g. `acme-website`); group ids are whatever you set under
> `groups:`.

---

## Optional: Cloudflare Access in front

The Worker's own auth is the security boundary, so Cloudflare Access is **not
required**. You may still add it for an extra SSO layer (Google/GitHub/email OTP)
or to gate admin paths separately from a public status page:

1. **Zero Trust → Access → Applications → Add → Self-hosted**, domain = your
   Worker's hostname.
2. Add an identity provider and an Access policy (allow a list, an `@domain`, or
   a group). Optionally scope it to admin paths only so the public page stays open.

Cloudflare Access is also how the Worker reaches **homelab origins** — there it
uses a service token rather than a human login. See
[`deploy/homelab-tunnel/`](../deploy/homelab-tunnel/README.md).

See also: [deployment.md](deployment.md) ·
[configuration.md](configuration.md).
