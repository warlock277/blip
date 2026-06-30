# Configuration reference

Everything Blip does is driven by a single file at the repo root:
**`blip.config.yaml`**. Edit it, then redeploy the Worker (`npm run deploy:cloud`,
or `npm run deploy --workspace @blip/worker`) — `gen-config` embeds the changes
into the bundle at build time.

> A fully-commented, feature-complete copy lives at
> [`config/blip.config.example.yaml`](../config/blip.config.example.yaml).
> Run `npm run setup` to generate a starter config interactively.

**Secrets never live in this file.** Reference them as `${ENV_VAR}` and provide
the values as Worker secrets (`wrangler secret put <NAME>`, or `.env` locally).
Missing variables are left unresolved with a warning — they never crash a run.

Every field below maps 1:1 to the shared type contract in
[`packages/shared/src/types.ts`](../packages/shared/src/types.ts).

## Top-level structure

```yaml
version: 1          # schema marker (number, optional)
brand:    { … }     # appearance
defaults: { … }     # global defaults
groups:   [ … ]     # tenants / products / regions
sites:    [ … ]     # what to monitor  (REQUIRED, ≥1)
channels: [ … ]     # where alerts go
```

| Field      | Type             | Required | Notes |
|------------|------------------|----------|-------|
| `version`  | number           | no       | Schema version marker. Currently `1`. |
| `brand`    | object           | no       | Dashboard + status-page branding. |
| `defaults` | object           | no       | Applied to every site unless overridden. |
| `groups`   | array            | no       | Logical grouping of sites. |
| `sites`    | array            | **yes**  | At least one site is required. |
| `channels` | array            | no       | Notification routing. |

---

## `brand`

Controls the look of the dashboard and the public status page.

| Field          | Type   | Notes |
|----------------|--------|-------|
| `name`         | string | Shown in the header. |
| `tagline`      | string | Marketing line on the public status page. |
| `primaryColor` | string | Hex accent color, e.g. `"#22c55e"`. |
| `logoUrl`      | string | Optional header logo. |
| `faviconUrl`   | string | Optional favicon. |
| `website`      | string | Optional "back to site" link. |
| `supportUrl`   | string | Optional support link. |

```yaml
brand:
  name: Blip
  tagline: Real-time status for everything we run.
  primaryColor: "#22c55e"
  logoUrl: https://example.com/logo.svg
  website: https://example.com
```

---

## `defaults`

Engine-wide defaults. Any site may override `timeoutMs`, `retries`,
`degradedThresholdMs`, and the SSL/domain warn windows.

| Field                 | Type     | Default               | Notes |
|-----------------------|----------|-----------------------|-------|
| `timeoutMs`           | number   | `10000`               | Per-check timeout. |
| `retries`             | number   | `2`                   | Retries before declaring **down**. |
| `degradedThresholdMs` | number   | `2000`                | Responses slower than this → **degraded**. |
| `maxHistoryPoints`    | number   | `2016`                | Raw points kept per site (~7 days @ 5-min). Older data rolls up daily. |
| `sslWarnDays`         | number   | `30`                  | Warn when a cert expires within N days. |
| `domainWarnDays`      | number[] | `[30, 15, 7]`         | Domain-expiry warn thresholds. |
| `userAgent`           | string   | `Blip/0.1 (+…)`      | User-agent for HTTP checks. |

```yaml
defaults:
  timeoutMs: 10000
  retries: 2
  degradedThresholdMs: 2000
  sslWarnDays: 30
  domainWarnDays: [30, 15, 7]
```

---

## `groups`

Groups separate clients, products, or regions. They're used for scoping
permissions (see [access-control.md](access-control.md)) and for organizing the
public status page. A site joins a group via `site.group`.

| Field         | Type   | Required | Notes |
|---------------|--------|----------|-------|
| `id`          | string | **yes**  | Referenced by `site.group` and channel `groups:` filters. |
| `name`        | string | **yes**  | Display name. |
| `description` | string | no       | Optional blurb. |
| `icon`        | string | no       | Emoji/icon shown in the UI. |

```yaml
groups:
  - id: acme
    name: Acme Inc
    icon: "🏢"
  - id: deps
    name: Upstream Services
    icon: "🔌"
```

---

## `sites`

The heart of the config. **Only `name` and `url` are required**; everything else
is optional with sensible defaults. The engine derives a stable `id` (slug) from
the name unless you set one explicitly — that id is used for data filenames and
URLs. Slugs are lowercased, non-alphanumeric runs become `-`, and duplicates get
a numeric suffix (`-2`, `-3`, …).

### Check types (`type`)

| `type`   | What it does |
|----------|--------------|
| `http`   | **(default)** HTTP request; checks status, keyword, JSON assertions, timing. |
| `tcp`    | Opens a raw TCP connection to `host:port`. Up = connection succeeds. |
| `ssl`    | TLS-certificate-expiry check only (no HTTP request). |
| `domain` | Domain-registration-expiry check only (RDAP/WHOIS). |

> `ssl` and `domain` can **also** be layered onto an `http`/`tcp` site via the
> `ssl:` / `domain:` options below — you don't need a separate site unless you
> want a dedicated, independent check.

### Core fields

| Field         | Type     | Default      | Notes |
|---------------|----------|--------------|-------|
| `id`          | string   | from `name`  | Stable slug for filenames/URLs. |
| `name`        | string   | —            | **Required.** Display name. |
| `url`         | string   | —            | **Required.** URL (`http`/`https`) or `host`/`host:port` for tcp. |
| `type`        | enum     | `http`       | `http` \| `tcp` \| `ssl` \| `domain`. |
| `group`       | string   | —            | Group id this site belongs to. |
| `description` | string   | —            | Shown on the status page. |
| `tags`        | string[] | —            | Free-form tags for filtering. |
| `public`      | boolean  | `true`       | Show on the public status page. |
| `paused`      | boolean  | `false`      | Keep in config but stop probing. |
| `notify`      | string[] | —            | Channel ids to notify (overrides global routing). |

### HTTP options (`type: http`)

| Field             | Type                 | Default     | Notes |
|-------------------|----------------------|-------------|-------|
| `method`          | enum                 | `GET`       | `GET`/`HEAD`/`POST`/`PUT`/`PATCH`/`DELETE`/`OPTIONS`. |
| `expectedStatus`  | number \| number[]   | `200–399`   | Acceptable status code(s). |
| `keyword`         | string               | —           | Body **must contain** this substring. |
| `keywordAbsent`   | string               | —           | Body **must NOT contain** this substring. |
| `headers`         | map<string,string>   | —           | Request headers. Values may use `${ENV_VAR}`. |
| `body`            | string               | —           | Request body for POST/PUT/PATCH. |
| `expectJson`      | JsonAssertion[]      | —           | JSON-path assertions (see below). |
| `followRedirects` | boolean              | `true`      | Follow 3xx. |
| `verifyTls`       | boolean              | `true`      | Treat invalid/expired TLS as failure. |

### Thresholds / behavior

| Field                 | Type    | Inherits from `defaults` | Notes |
|-----------------------|---------|--------------------------|-------|
| `timeoutMs`           | number  | yes                      | Per-check timeout. |
| `degradedThresholdMs` | number  | yes                      | Slow → **degraded**. |
| `retries`             | number  | yes                      | Retries before **down**. |

### Extra probes layered on a site

| Field    | Type                              | Notes |
|----------|-----------------------------------|-------|
| `ssl`    | `true` \| `{ warnDays: number }`  | Watch TLS cert expiry. `true` uses `defaults.sslWarnDays`. |
| `domain` | `true` \| `{ warnDays: number[] }`| Watch domain expiry. `true` uses `defaults.domainWarnDays`. |

### TCP options (`type: tcp`)

| Field  | Type   | Notes |
|--------|--------|-------|
| `port` | number | TCP port. May also be embedded in `url` as `host:port`. |

### JSON assertions (`expectJson[]`)

Each entry asserts something about the JSON response body. `path` uses dot/bracket
notation (`db.connected`, `regions[0].name`). Provide **one** of `equals` or
`contains`.

| Field      | Type                                  | Notes |
|------------|---------------------------------------|-------|
| `path`     | string                                | **Required.** Dot/bracket path into the body. |
| `equals`   | string \| number \| boolean \| null   | Strict equality. |
| `contains` | string                                | Substring match. |

### Examples

```yaml
sites:
  # Simplest possible check: HTTP GET expecting 2xx/3xx.
  - name: Acme Website
    url: https://example.com
    group: acme
    ssl: true            # also watch cert expiry
    domain: true         # also watch domain expiry
    tags: [marketing]

  # API health: status + keyword + tighter SLA.
  - name: GitHub API
    url: https://api.github.com
    expectedStatus: 200
    keyword: "current_user_url"
    degradedThresholdMs: 800

  # JSON assertions with an auth header.
  - name: Acme API
    url: https://example.net
    method: POST
    headers:
      Authorization: "Bearer ${ACME_API_TOKEN}"
    expectJson:
      - path: "status"
        equals: "healthy"
      - path: "db.connected"
        equals: true
    public: false

  # Raw TCP port (database, game server, …).
  - name: Acme Database
    url: example.com
    type: tcp
    port: 5432

  # Dedicated SSL-only watch.
  - name: Acme Cert Watch
    url: https://example.org
    type: ssl
    ssl: { warnDays: 21 }
```

---

## `channels`

Where alerts go. Blip supports five channel types. Every channel shares the
same optional **routing filters**; type-specific fields are listed per channel.

### Routing filters (all channels)

| Field            | Type        | Notes |
|------------------|-------------|-------|
| `events`         | EventType[] | Subset of `[down, up, degraded, ssl, domain]`. Default: all. |
| `sites`          | string[]    | Only fire for these site ids. |
| `groups`         | string[]    | Only fire for sites in these groups. |
| `minDownMinutes` | number      | Wait this long before firing a **down** alert (flap suppression). |

> A site's `notify:` list, when present, **overrides** global routing — only the
> listed channels fire for that site. See
> [notifications.md](notifications.md#routing--flapping) for the full routing model.

### `telegram`

| Field      | Type   | Notes |
|------------|--------|-------|
| `type`     | `"telegram"` | |
| `botToken` | string | Usually `${TELEGRAM_BOT_TOKEN}`. |
| `chatId`   | string | Usually `${TELEGRAM_CHAT_ID}`. |

### `email` (Resend)

| Field    | Type     | Notes |
|----------|----------|-------|
| `type`   | `"email"`| |
| `apiKey` | string   | Usually `${RESEND_API_KEY}`. |
| `from`   | string   | e.g. `"Blip <alerts@example.com>"`. |
| `to`     | string[] | Recipients. |

### `discord`

| Field        | Type        | Notes |
|--------------|-------------|-------|
| `type`       | `"discord"` | |
| `webhookUrl` | string      | Usually `${DISCORD_WEBHOOK_URL}`. |

### `slack`

| Field        | Type      | Notes |
|--------------|-----------|-------|
| `type`       | `"slack"` | |
| `webhookUrl` | string    | Incoming webhook URL. |

### `webhook` (generic)

| Field     | Type               | Notes |
|-----------|--------------------|-------|
| `type`    | `"webhook"`        | |
| `url`     | string             | Target URL. |
| `method`  | `"POST"` \| `"PUT"`| Default `POST`. |
| `headers` | map<string,string> | Extra request headers. |

### Examples

```yaml
channels:
  - id: telegram-main
    type: telegram
    botToken: ${TELEGRAM_BOT_TOKEN}
    chatId: ${TELEGRAM_CHAT_ID}
    events: [down, up, ssl, domain]

  - id: email-ops
    type: email
    apiKey: ${RESEND_API_KEY}
    from: "Blip <alerts@example.com>"
    to: ["ops@example.com"]
    minDownMinutes: 5

  - id: discord-eng
    type: discord
    webhookUrl: ${DISCORD_WEBHOOK_URL}
    events: [down, up, degraded]
    groups: [deps]

  - id: webhook-pager
    type: webhook
    url: ${PAGER_WEBHOOK_URL}
    method: POST
    events: [down]
    sites: [acme-api]
```

---

## Status model

A check resolves to one of three statuses, rolled up to a status-page banner:

| Status     | Meaning |
|------------|---------|
| `up`       | Healthy. |
| `degraded` | Reachable but slow (over `degradedThresholdMs`) or partially failing. |
| `down`     | Failed all retries. |

| Overall banner   | When |
|------------------|------|
| `operational`    | No down, no degraded. |
| `degraded`       | Some degraded, none down. |
| `partial_outage` | At least one down, but not all. |
| `major_outage`   | All sites down. |

See also: [deployment.md](deployment.md) ·
[notifications.md](notifications.md) · [access-control.md](access-control.md) ·
[architecture.md](architecture.md).
