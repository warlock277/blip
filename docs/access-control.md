# Access control (RBAC)

Pulse has two complementary layers of access control:

1. **Cloudflare Access** — authenticates users at the edge and decides *who can
   open the dashboard at all*. This is the real security boundary.
2. **`permissions.json`** — a role/scope map that decides *what each
   authenticated user sees* inside the dashboard (which groups and sites).

> **Security note (read this).** Client-side role filtering in the SPA is a
> **UX convenience, not a security control** — anyone who can load the
> JavaScript bundle can read the `/data/*.json` it fetches. Real data privacy
> comes from **(a)** keeping the repo **private** so the JSON isn't on the public
> internet, and **(b)** putting **Cloudflare Access in front of the Pages
> deployment** so only authenticated, authorized users reach it. Treat
> `permissions.json` as "which dashboard view to render," not "which data to
> protect."

---

## Roles

There are four roles, from most to least privileged:

| Role          | Sees | Typical user |
|---------------|------|--------------|
| `SUPER_ADMIN` | Everything: all groups, all sites, all incidents, admin views. | Owner / operator. |
| `ADMIN`       | All groups and sites. | Ops team. |
| `CLIENT`      | Only the groups and sites explicitly scoped to them. | A customer viewing their own sites. |
| `VIEWER`     | Read-only, scoped to assigned groups/sites. | Stakeholder / read-only teammate. |

`SUPER_ADMIN` and `ADMIN` ignore `groups`/`sites` scoping — they see all of it.
`CLIENT` and `VIEWER` are restricted to whatever you scope them to.

---

## `permissions.json`

Stored at `data/permissions.json` (committed to the repo, served alongside the
other JSON). A starter lives at
[`config/permissions.example.json`](../config/permissions.example.json) — copy it
to `data/permissions.json` and edit. The seed script also writes a sample one.

The shape matches the `Permissions` type in
[`types.ts`](../packages/shared/src/types.ts):

```json
{
  "users": [
    { "email": "owner@example.com", "role": "SUPER_ADMIN" },
    { "email": "ops@example.com",   "role": "ADMIN" },
    {
      "email": "client@example.com",
      "role": "CLIENT",
      "groups": ["acme"],
      "sites": ["acme-website", "acme-app"]
    },
    {
      "email": "viewer@example.com",
      "role": "VIEWER",
      "groups": ["deps"]
    }
  ]
}
```

### Fields (`users[]`)

| Field    | Type     | Required | Notes |
|----------|----------|----------|-------|
| `email`  | string   | **yes**  | Must match the identity Cloudflare Access provides. |
| `role`   | enum     | **yes**  | `SUPER_ADMIN` \| `ADMIN` \| `CLIENT` \| `VIEWER`. |
| `groups` | string[] | no       | Group ids the user may view. Empty/omitted = all (for ADMIN+). |
| `sites`  | string[] | no       | Specific site ids the user may view (in addition to `groups`). |

> `groups` and `sites` reference the ids from `pulse.config.yaml`. Site ids are
> the derived slugs (e.g. `acme-website`); group ids are whatever you set
> under `groups:`. JSON has no comments — document intent here, not in the file.

---

## Cloudflare Access setup

Cloudflare Access (part of Cloudflare Zero Trust, free for small teams) sits in
front of your Pages deployment and authenticates every request.

1. In the Cloudflare dashboard go to **Zero Trust → Access → Applications →
   Add an application → Self-hosted**.
2. Set the application domain to your Pages URL / custom domain
   (e.g. `status.example.com`).
3. Add an **identity provider**:
   - **Google** or **GitHub** for teams.
   - **One-time PIN (email OTP)** for clients who don't have an SSO account —
     they receive a code by email.
4. Add an **Access policy**, e.g. *Allow* where the email is in a specific list,
   matches a domain (`@example.com`), or is part of a group.
5. (Optional) Make the **public status page** bypass Access while keeping the
   admin views protected — either deploy the public page on a separate
   subdomain, or scope an Access policy to the admin paths only.

When a user authenticates, Cloudflare passes their identity to the app. Pulse
matches that email against `permissions.json` to decide what to render.

### Putting it together

```
User ──▶ Cloudflare Access ──▶ (authenticated email) ──▶ Pulse dashboard
                 │                                              │
        decides WHO gets in                          permissions.json decides
        (the security boundary)                      WHAT they see (UX scope)
```

### Public vs. private decision

| Goal | Repo visibility | Cloudflare Access |
|------|-----------------|-------------------|
| Fully public status page | Public or private | Off (or bypass) |
| Client dashboards / internal | **Private** | **On** |
| Mixed (public page + private admin) | **Private** | On for admin paths, bypass for the public page |

See also: [deployment.md](deployment.md) ·
[configuration.md](configuration.md).
