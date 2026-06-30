# Homelab monitoring — Cloudflare Tunnel + Access

Bridges Pulse (Cloudflare Worker, runs at the edge) to LAN-only homelab services
on `192.168.0.0/24`. One `cloudflared` tunnel on **CT 106 (192.168.0.220)**
publishes six services as `*.akashghuri.xyz` hostnames, each protected by a
Cloudflare Access **service token** so only the Worker reaches the origin.

```
Worker --fetch+service-token--> <svc>.akashghuri.xyz --tunnel--> CT 106 --LAN--> origin
```

## Hostnames

| Hostname | Origin |
|----------|--------|
| pve1.akashghuri.xyz | https://192.168.0.158:8006 |
| pve2.akashghuri.xyz | https://192.168.0.114:8006 |
| npm.akashghuri.xyz | http://192.168.0.170:81 |
| openclaw.akashghuri.xyz | http://192.168.0.220:18789 (path /health) |
| beszel-a.akashghuri.xyz | http://192.168.0.220:8090 |
| beszel-b.akashghuri.xyz | http://192.168.0.158:8090 |

---

## 1. Create the tunnel (on CT 106)

```bash
ssh root@192.168.0.220
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
for h in pve1 pve2 npm openclaw beszel-a beszel-b; do
  docker run -it --rm -e TUNNEL_ORIGIN_CERT=/etc/cloudflared/cert.pem \
    -v /opt/homelab-tunnel/etc:/etc/cloudflared \
    cloudflare/cloudflared:latest tunnel route dns homelab $h.akashghuri.xyz
done
```

> `tunnel route dns` creates the CNAMEs with the tunnel's own creds — no extra
> API token needed. If it errors on permissions, create them manually in the CF
> dashboard: each is a CNAME `<h>.akashghuri.xyz` → `<TUNNEL_ID>.cfargotunnel.com` (proxied).

## 3. Start the tunnel

```bash
cd /opt/homelab-tunnel && docker compose up -d && docker compose logs -f
```

## 4. Cloudflare Access — service token + policy

Dashboard → **Zero Trust → Access**:

1. **Service Auth → Service Tokens → Create** → name `pulse-monitor`.
   Copy the **Client ID** and **Client Secret** (shown once).
2. **Applications → Add → Self-hosted**, one app covering all six hosts
   (use subdomain `*` / or add each host). Domain: `akashghuri.xyz`.
3. Policy: **action = Service Auth**, include **Service Token = pulse-monitor**.
   (No other allow policy → humans are blocked, only the token passes.)

## 5. Wire secrets into the Worker (from repo root)

```bash
cd packages/worker
echo -n '<CLIENT_ID>'     | npx wrangler secret put CF_ACCESS_CLIENT_ID
echo -n '<CLIENT_SECRET>' | npx wrangler secret put CF_ACCESS_CLIENT_SECRET
npm run deploy
```

The six homelab sites already reference these via `headers:` in
`pulse.config.yaml`. After deploy, the next cron tick (≤5 min) populates them;
check `https://pulse.akashghuri.xyz/data/summary.json`.

## Verify a hostname manually

```bash
curl -sI https://pve1.akashghuri.xyz \
  -H "CF-Access-Client-Id: <CLIENT_ID>" \
  -H "CF-Access-Client-Secret: <CLIENT_SECRET>"   # expect 200, not an Access redirect
```
