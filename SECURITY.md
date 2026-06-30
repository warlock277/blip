# Security Policy

## Reporting a vulnerability

If you discover a security issue, please **do not open a public issue**.
Instead, use GitHub's [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
("Report a vulnerability" under the repository **Security** tab), or contact a
maintainer directly. We aim to acknowledge reports within 72 hours.

## Handling secrets

Blip never stores secrets in the repository. Tokens and API keys are referenced
in `blip.config.yaml` as `${ENV_VAR}` placeholders and supplied at runtime as
**Worker secrets** (`wrangler secret put <NAME>`). The Worker never logs secret
values and skips any channel whose `${...}` placeholders are unresolved. Keep
your repo **private** if any monitored endpoint or header is sensitive.

## Data privacy & access control

Authentication and RBAC are enforced **server-side in the Worker**: a `CLIENT` or
`VIEWER` only ever receives their scoped sites, and anonymous visitors see only
`public: true` sites (when `publicStatusPage` is on). This is a real boundary —
the filtered `/data/*.json` never contains another tenant's data. Set the cookie
signing key (`BLIP_SESSION_SECRET`) and each principal's password as secrets.
Optionally add Cloudflare Access for an extra SSO layer.

See [`docs/access-control.md`](docs/access-control.md) for the full model.

## Dependency advisories

`npm audit` may report findings in **development-only** tooling — specifically
the Vite dev server and its bundled `esbuild` (advisories that apply only when
`vite dev` is run on an untrusted network). These tools are **not** part of the
production build: the dashboard ships inside the Worker as pre-built static
assets with no dev server. Production runtime dependencies are kept advisory-free.
