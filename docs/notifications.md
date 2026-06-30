# Notifications

Pulse can alert you over **Telegram, Email (Resend), Discord, Slack, and a
generic webhook**. Channels are declared under `channels:` in
`pulse.config.yaml`; their secrets are provided as `${ENV_VAR}` references and
stored as GitHub Actions secrets.

This page covers how to get each credential, the generic webhook payload, and how
event **routing** and **flapping suppression** work.

> Channel field reference lives in
> [configuration.md → channels](configuration.md#channels).

---

## Telegram

1. Open Telegram and message **[@BotFather](https://t.me/BotFather)**.
2. Send `/newbot`, choose a name and username. BotFather replies with a **bot
   token** like `123456789:ABCdef…` → this is your `TELEGRAM_BOT_TOKEN`.
3. **Get your chat id:**
   - For a personal chat: message your new bot once (say "hi"), then open
     `https://api.telegram.org/bot<TOKEN>/getUpdates` in a browser and read
     `result[].message.chat.id`.
   - For a group: add the bot to the group, post a message, then call
     `getUpdates` the same way. Group ids are negative (e.g. `-1001234567890`).
   - For a channel: add the bot as an admin and use `@channelusername` or the
     numeric id.
4. Save the values as secrets `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`.

```yaml
channels:
  - id: telegram-main
    type: telegram
    botToken: ${TELEGRAM_BOT_TOKEN}
    chatId: ${TELEGRAM_CHAT_ID}
    events: [down, up, ssl, domain]
```

You can route different sites to different chats by adding more channels with
their own chat ids (e.g. a per-client `${ACME_TELEGRAM_CHAT_ID}`) and a `groups:`
or `notify:` filter.

---

## Email (Resend)

[Resend](https://resend.com) has a free tier that comfortably covers monitoring
alerts.

1. Create a Resend account → **API Keys** → create a key. This is `RESEND_API_KEY`.
2. **Verify a sending domain** (Domains → Add Domain) and add the DNS records
   Resend shows you (SPF/DKIM). Unverified domains can only send to your own
   address and may land in spam.
3. Set the `from` to an address on the verified domain.

```yaml
channels:
  - id: email-ops
    type: email
    apiKey: ${RESEND_API_KEY}
    from: "Pulse <alerts@yourdomain.com>"
    to: ["ops@yourdomain.com", "oncall@yourdomain.com"]
    events: [down, up, ssl, domain]
    minDownMinutes: 5
```

> No verified domain yet? You can start with Resend's onboarding/testing sender
> to confirm wiring, then switch to your own domain for production.

---

## Discord

1. In your Discord server: **Server Settings → Integrations → Webhooks → New
   Webhook**.
2. Pick a channel, click **Copy Webhook URL** → this is `DISCORD_WEBHOOK_URL`.

```yaml
channels:
  - id: discord-eng
    type: discord
    webhookUrl: ${DISCORD_WEBHOOK_URL}
    events: [down, up, degraded]
    groups: [deps]
```

---

## Slack

1. Create a Slack app (or use an existing one) and enable **Incoming Webhooks**:
   <https://api.slack.com/messaging/webhooks>.
2. Add a webhook to a channel and copy the URL → `SLACK_WEBHOOK_URL`.

```yaml
channels:
  - id: slack-incidents
    type: slack
    webhookUrl: ${SLACK_WEBHOOK_URL}
    events: [down, up]
    minDownMinutes: 2
```

---

## Generic webhook

The `webhook` channel POSTs (or PUTs) a JSON payload to any URL — perfect for
PagerDuty Events API, n8n, Zapier, or your own automation.

```yaml
channels:
  - id: webhook-pager
    type: webhook
    url: ${PAGER_WEBHOOK_URL}
    method: POST                 # POST (default) or PUT
    headers:
      X-Pulse-Source: "ci"
    events: [down]
    sites: [acme-api]
```

### Payload shape

The webhook body describes the event that triggered it. Fields mirror the shared
types ([`types.ts`](../packages/shared/src/types.ts)): `EventType`, `Status`,
`SslInfo`, `DomainInfo`.

```json
{
  "event": "down",
  "site": {
    "id": "acme-api",
    "name": "Acme API",
    "url": "https://example.net",
    "group": "acme"
  },
  "status": "down",
  "previousStatus": "up",
  "responseTime": null,
  "httpStatus": 503,
  "error": "Connection timed out",
  "checkedAt": "2026-06-18T00:00:00.000Z",
  "ssl": null,
  "domain": null
}
```

`ssl`/`domain` blocks are populated on `ssl`/`domain` events:

```json
{
  "event": "ssl",
  "site": { "id": "acme-website", "name": "Acme Website", "url": "https://example.com" },
  "ssl": {
    "validTo": "2026-07-01T00:00:00.000Z",
    "daysRemaining": 13,
    "issuer": "Let's Encrypt",
    "subject": "example.com",
    "expiringSoon": true
  }
}
```

---

## Routing & flapping

Pulse decides which channels fire for an event using a small set of rules:

1. **Per-site override.** If a site has a `notify: [channelId, …]` list, **only**
   those channels are considered for that site. Global channels are skipped.
2. **Event filter.** A channel only fires for events listed in its `events:`
   array (default: all of `down`, `up`, `degraded`, `ssl`, `domain`).
3. **Scope filter.** If a channel sets `sites:` and/or `groups:`, the site must
   match to be eligible.
4. **Flapping suppression (`minDownMinutes`).** A `down` alert is held until the
   site has been continuously down for at least `minDownMinutes`. If it recovers
   first, no `down` alert is sent — this kills noisy blips. Set `0` (the default)
   for immediate alerting.

### Event types

| Event      | Fires when… |
|------------|-------------|
| `down`     | A site transitions to **down** (after retries + `minDownMinutes`). |
| `up`       | A site recovers from down/degraded to **up**. |
| `degraded` | A site becomes **degraded** (slow or partially failing). |
| `ssl`      | A TLS certificate enters its warn window (`sslWarnDays`). |
| `domain`   | A domain enters a registration-expiry warn threshold (`domainWarnDays`). |

### Recommended setup

- A high-signal channel (Telegram/Slack) for `down`/`up` with a small
  `minDownMinutes` (1–5) to avoid blips.
- An email channel for `ssl`/`domain` so renewals never sneak up on you.
- Per-client channels scoped with `groups:` + `notify:` so customers only ever
  see their own sites.

See also: [configuration.md](configuration.md) ·
[deployment.md](deployment.md).
