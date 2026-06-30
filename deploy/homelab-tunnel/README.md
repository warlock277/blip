# Homelab monitoring — Cloudflare Tunnel + Access

Monitor **LAN-only homelab services with no exposed ports.** This bridges Blip
(a Cloudflare Worker running at the edge) to private services on your LAN. One
`cloudflared` tunnel on any Docker host publishes each service as a public
`*.example.com` hostname, and a Cloudflare Access **service token** ensures only
the Worker — never the public internet — can reach the origin.

```
Worker --fetch+service-token--> <svc>.example.com --tunnel--> Docker host --LAN--> origin
```

## Example hostnames

Map your own services here (and in `config.yml`):

| Hostname | Origin |
|----------|--------|
| pve.example.com | https://192.168.1.10:8006 |
| npm.example.com | http://192.168.1.20:81 |
| app.example.com | http://192.168.1.30:8090 |

---

## 1. Create the tunnel (on your Docker host)

```bash
ssh root@<docker-host>
mkdir -p /opt/homelab-tunnel/etc && cd /opt/homelab-tunnel
# copy config.yml + docker-compose.yml from this dir into /opt/homelab-tunnel/

# NOTE: -e TUNNEL_ORIGIN_CERT forces cert.pem into the MOUNTED dir. Without it
# login writes to the container's ~/.cloudflared and --rm deletes it, so the
# next `tunnel create` fails with "Cannot determine default origin certificate".

# auth this machine to your CF account (opens a browser URL — paste into any browser)
docker run -it --rm -e TUNNEL_ORIGIN_CERT=/etc/cloudflared/cert.pem \
  -v /opt/homelab-tunnel/etc:/etc/cloudflared \
  cloudflare/cloudflared:latest tunnel login

# create the tunnel (writes etc/<TUNNEL_ID>.json, prints the id)
docker run -it --rm -e TUNNEL_ORIGIN_CERT=/etc/cloudflared/cert.pem \
  -v /opt/homelab-tunnel/etc:/etc/cloudflared \
  cloudflare/cloudflared:latest tunnel create homelab
```

Put the printed `<TUNNEL_ID>` into **both** `tunnel:` and `credentials-file:`
lines in `config.yml`.

## 2. DNS routes (CNAME per hostname → tunnel)

```bash
for h in pve npm app; do
  docker run -it --rm -e TUNNEL_ORIGIN_CERT=/etc/cloudflared/cert.pem \
    -v /opt/homelab-tunnel/etc:/etc/cloudflared \
    cloudflare/cloudflared:latest tunnel route dns homelab $h.example.com
done
```

> `tunnel route dns` creates the CNAMEs with the tunnel's own creds — no extra
> API token needed. If it errors on permissions, create them manually in the CF
> dashboard: each is a CNAME `<h>.example.com` → `<TUNNEL_ID>.cfargotunnel.com` (proxied).

## 3. Start the tunnel

```bash
cd /opt/homelab-tunnel && docker compose up -d && docker compose logs -f
```

## 4. Cloudflare Access — service token + policy

Dashboard → **Zero Trust → Access**:

1. **Service Auth → Service Tokens → Create** → name `blip-monitor`.
   Copy the **Client ID** and **Client Secret** (shown once).
2. **Applications → Add → Self-hosted**, one app covering all your hosts
   (use subdomain `*` / or add each host). Domain: `example.com`.
3. Policy: **action = Service Auth**, include **Service Token = blip-monitor**.
   (No other allow policy → humans are blocked, only the token passes.)

## 5. Wire secrets into the Worker (from repo root)

```bash
cd packages/worker
echo -n '<CLIENT_ID>'     | npx wrangler secret put CF_ACCESS_CLIENT_ID
echo -n '<CLIENT_SECRET>' | npx wrangler secret put CF_ACCESS_CLIENT_SECRET
npm run deploy
```

Your homelab sites reference these via `headers:` in `blip.config.yaml`. After
deploy, the next cron tick (≤5 min) populates them; check
`https://status.example.com/data/summary.json`.

## Verify a hostname manually

```bash
curl -sI https://pve.example.com \
  -H "CF-Access-Client-Id: <CLIENT_ID>" \
  -H "CF-Access-Client-Secret: <CLIENT_SECRET>"   # expect 200, not an Access redirect
```
