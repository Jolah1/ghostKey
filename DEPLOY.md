# Deploying GhostKey

Two parts to put online:

1. **`ghostkey-server`** — Rust binary, listens on a TCP port, persists to a SQLite file. Needs a small Linux host.
2. **`ghostkey-web`** — static SPA. Drop it on any CDN.

There's no CLI to deploy — the CLI lives on each user's own machine, alongside their seed phrase. The website never sees keys.

This guide picks the **smallest, cheapest viable stack**: a $5/mo VPS for the server + a free static host for the web. Total cost: ≤ $5/month.

---

## Recommended setup

| Piece | Where | Cost |
|---|---|---|
| `ghostkey-server` | Hetzner CX11, DigitalOcean Basic, Fly.io 256 MB, Oracle ARM free tier — pick one | $0–$5/mo |
| TLS + reverse proxy | Caddy on the same VPS (auto-renews Let's Encrypt) | free |
| `ghostkey-web` | Cloudflare Pages, Vercel, or Netlify | free |
| Domain | Pick any registrar. Example: `gk.example.com` for the app, `api.example.com` for the server. | ~$10/year |

You can put both on a single VPS behind one domain if you prefer — see "Alternative: single-VPS" at the end.

---

## Part A — server on a VPS

### 1. Provision a Linux host

Anything with ≥ 256 MB RAM, ≥ 1 GB disk, Ubuntu 22.04 / Debian 12. SSH in as a user with sudo.

### 2. Build & ship the binary

On your dev machine, build a release binary for the target arch (most VPSes are `x86_64-unknown-linux-gnu`):

```sh
cargo build --release -p ghostkey-server
# -> target/release/ghostkey-server (single static-ish binary)
scp target/release/ghostkey-server user@host:/tmp/
```

On the VPS:

```sh
sudo mv /tmp/ghostkey-server /usr/local/bin/
sudo chmod +x /usr/local/bin/ghostkey-server

# Dedicated user + data dir.
sudo useradd --system --home /var/lib/ghostkey --create-home ghostkey
sudo install -d -o ghostkey -g ghostkey /var/lib/ghostkey
```

### 3. systemd unit

`/etc/systemd/system/ghostkey-server.service`:

```ini
[Unit]
Description=GhostKey notifier server
After=network.target

[Service]
User=ghostkey
Group=ghostkey
WorkingDirectory=/var/lib/ghostkey
Environment=GHOSTKEY_BIND=127.0.0.1:8787
Environment=DATABASE_URL=sqlite:///var/lib/ghostkey/ghostkey.sqlite?mode=rwc
Environment=GHOSTKEY_TICK_SECS=30
Environment=RUST_LOG=ghostkey_server=info,info
ExecStart=/usr/local/bin/ghostkey-server
Restart=on-failure
RestartSec=3s

# Hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/ghostkey
ProtectKernelTunables=true
ProtectKernelLogs=true
ProtectControlGroups=true
RestrictNamespaces=true
PrivateTmp=true
PrivateDevices=true

[Install]
WantedBy=multi-user.target
```

Then:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now ghostkey-server
sudo systemctl status ghostkey-server
sudo journalctl -u ghostkey-server -n 50 --no-pager
```

The server is now listening on **`127.0.0.1:8787`** (loopback only — we'll put TLS in front of it next).

### 4. TLS + reverse proxy (Caddy)

`Caddy` is the simplest TLS-terminating reverse proxy on Linux. It auto-fetches and renews a Let's Encrypt cert.

```sh
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
```

Point your DNS `A` record for `api.example.com` at the VPS, then drop this in `/etc/caddy/Caddyfile`:

```caddy
api.example.com {
    encode zstd gzip
    reverse_proxy 127.0.0.1:8787

    # CORS for the web app. Replace with your real web host.
    @cors header Origin "https://gk.example.com"
    header @cors Access-Control-Allow-Origin "https://gk.example.com"
    header @cors Access-Control-Allow-Methods "GET, POST, OPTIONS"
    header @cors Access-Control-Allow-Headers "Content-Type"
    @options method OPTIONS
    respond @options 204
}
```

```sh
sudo systemctl reload caddy
curl https://api.example.com/health   # → {"ok":true,"version":"0.1.0"}
```

### 5. Backups (mandatory)

The SQLite file at `/var/lib/ghostkey/ghostkey.sqlite` is the entire state of the notifier. Lose it → every registered vault disappears from the dashboard (the on-chain promise is still intact — but reminders stop firing).

Minimal nightly backup with `sqlite3 .backup`:

```sh
sudo apt install -y sqlite3
sudo tee /etc/cron.daily/ghostkey-backup >/dev/null <<'EOF'
#!/bin/sh
set -e
BACKUP_DIR=/var/lib/ghostkey/backups
mkdir -p "$BACKUP_DIR"
TS=$(date +%Y%m%d-%H%M%S)
sqlite3 /var/lib/ghostkey/ghostkey.sqlite ".backup '$BACKUP_DIR/ghostkey-$TS.sqlite'"
find "$BACKUP_DIR" -type f -mtime +14 -delete
EOF
sudo chmod +x /etc/cron.daily/ghostkey-backup
```

For real users, ship the backup off-host too (e.g. `rclone copy` to S3/B2 nightly).

### 6. Upgrades

```sh
# On dev machine
cargo build --release -p ghostkey-server
scp target/release/ghostkey-server user@host:/tmp/

# On VPS
sudo systemctl stop ghostkey-server
sudo mv /tmp/ghostkey-server /usr/local/bin/
sudo systemctl start ghostkey-server
```

Database migrations are baked into the binary (`sqlx::migrate!`), so they apply automatically at startup.

---

## Part B — web on a static host

The web app is a pure static bundle (`dist/`) after `npm run build`. It talks to the server via `/api/*`.

### 1. Build with a baked-in API origin

Open `ghostkey-web/src/api.ts`:

```ts
const BASE = "/api";
```

That works if the web and the server share a hostname. Since we put them on different hostnames in the recommended setup, change it to a full URL via an env var. The simplest fix — change the line to:

```ts
const BASE = import.meta.env.VITE_API_BASE ?? "/api";
```

Then build:

```sh
cd ghostkey-web
echo 'VITE_API_BASE=https://api.example.com' > .env.production
npm install
npm run build
# -> dist/ is ready to upload
```

### 2. Pick a static host

#### Option a: Cloudflare Pages (free)

1. Create a Pages project at <https://dash.cloudflare.com/>.
2. Connect your GitHub repo OR upload `ghostkey-web/dist` directly.
3. Build settings:
   - Framework preset: **None**
   - Build command: `cd ghostkey-web && npm install && npm run build`
   - Build output directory: `ghostkey-web/dist`
   - Environment variables: `VITE_API_BASE=https://api.example.com`, `NODE_VERSION=20`
4. Add your custom domain `gk.example.com`.

That's it — every push to `main` redeploys.

#### Option b: Vercel / Netlify

Similar story:
- Root directory: `ghostkey-web`
- Build command: `npm run build`
- Output directory: `dist`
- Env: `VITE_API_BASE=https://api.example.com`

#### Option c: nginx on your own server

```nginx
server {
    server_name gk.example.com;
    root /var/www/ghostkey-web;
    index index.html;
    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

Then `scp -r ghostkey-web/dist/* user@host:/var/www/ghostkey-web/`.

### 3. Verify

```sh
curl https://gk.example.com/                  # → HTML shell
curl https://api.example.com/health           # → {"ok":true,...}
```

Open `https://gk.example.com/` in a browser. Network tab should show requests going to `https://api.example.com/...`.

---

## Alternative: single-VPS, single domain

If you don't want a separate static host, put both on the same VPS behind one Caddyfile:

```caddy
gk.example.com {
    encode zstd gzip
    handle /api/* {
        uri strip_prefix /api
        reverse_proxy 127.0.0.1:8787
    }
    handle {
        root * /var/www/ghostkey-web
        try_files {path} /index.html
        file_server
    }
}
```

In this case keep `const BASE = "/api"` in `api.ts` (no env var needed) and `scp -r ghostkey-web/dist/* user@host:/var/www/ghostkey-web/` after each build.

---

## Alternative: Fly.io (recommended for hands-off deploys)

Fly.io builds the image from the `Dockerfile` at the repo root, runs it on
a small VM, and gives you `<app>.fly.dev` + free TLS. Roughly $0–$3/mo
for a single 256 MB shared-CPU machine.

### One-time setup

```sh
# Install flyctl and sign in.
curl -L https://fly.io/install.sh | sh
fly auth signup    # or `fly auth login`

# From the repo root:
fly launch --no-deploy --copy-config --name ghostkey --region ams
# (Picks the app name/region. Already-existing fly.toml is reused.)

# Provision the persistent volume BEFORE the first deploy. SQLite lives
# here and must survive restarts.
fly volumes create ghostkey_data --region ams --size 1   # 1 GB is plenty
```

### Deploy

```sh
fly deploy
fly status
fly logs                      # tail the server log
curl https://ghostkey.fly.dev/health
```

### Field-by-field for the Fly Launcher UI

If you're using the web Launcher (instead of `flyctl`), the screen you
showed maps to these values:

| Field | Value |
|---|---|
| **App name** | `ghostkey` |
| **Branch** | `main` (or whichever branch carries `Dockerfile` + `fly.toml`) |
| **Region** | Any — pick the one closest to your users. `ams` is the example. |
| **Internal port** | `8080` |
| **CPU** | `shared-cpu-1x` |
| **Memory** | `256 MB` (bump to 512 MB if you start running into OOM kills) |
| **Environment variables** | None needed; `fly.toml` sets them. If you must add one in the UI: `GHOSTKEY_BIND=0.0.0.0:8080`. |
| **Managed Postgres** | **OFF** — the server uses SQLite on a volume, not Postgres. |
| **Working directory** | Leave blank (defaults to `./`). |
| **Config path** | Leave blank (defaults to `./fly.toml`). |

After the first deploy, attach a custom domain:

```sh
fly certs add api.example.com
# Then add the A/AAAA records Fly tells you to.
```

### Updating

```sh
git push                  # whatever your normal flow is
fly deploy
```

The image rebuilds, the volume reattaches with the existing SQLite
file, no manual migration step.

### Things to know

- **Region pinned to the volume**. Once you create the volume in `ams`,
  the app machine must run in `ams`. To move regions you'd snapshot the
  volume, create a new one in the target region, and switch over.
- **No horizontal scale**. The volume is local NVMe; you can't run more
  than one machine against the same SQLite file. The server is small
  enough that one machine handles thousands of vaults easily.
- **Auto-stop is on**. `fly.toml` sets `auto_stop_machines = "stop"`,
  which spins the machine down when idle and brings it back on the
  first request (~500 ms cold start). Turn it off (`"off"`) if you want
  a faster first byte.
- **Backups**. Add a cron via `fly machine exec` or a tiny sidecar that
  uploads `/data/ghostkey.sqlite` to S3/B2 nightly. The Fly volume
  itself is single-host SSD with no built-in backups.

---

## Common pitfalls

| Symptom | Cause | Fix |
|---|---|---|
| `502 Bad Gateway` from Caddy | server not running or wrong port | `systemctl status ghostkey-server`; check `GHOSTKEY_BIND` |
| Browser blocks API call with CORS error | server hostname differs from web hostname and CORS isn't set | add the `header @cors …` block in Caddyfile (above) |
| `index.css` returns 500 in dev | Vite cached an old `tailwind.config.js` | restart `npm run dev` after editing the Tailwind config |
| Data loss when the VPS dies | no backups | implement the cron from §A.5 and ship backups off-host |
| Vault count drops to 0 after upgrade | someone deleted `/var/lib/ghostkey/ghostkey.sqlite` during a redeploy | the systemd unit's `ReadWritePaths` keeps that file safe; deploy only replaces the binary |

---

## Mainnet-readiness checklist

Before you point real money at this:

1. **Run the regtest e2e test on the same hardware** as production:
   `cargo test -p ghostkey-core --test regtest_e2e -- --ignored`.
2. **Verify backups restore cleanly**: copy the latest `*.sqlite.bak`, drop it in a scratch dir, start `ghostkey-server` against it, list vaults.
3. **Smoke test the upgrade path**: deploy a new binary, confirm the migrations applied and the existing vaults still resolve.
4. **Bound the blast radius**: the server holds *no keys*. The worst case if it's compromised is a denial-of-service on reminders. Owner keys (and therefore funds) are safe regardless.
5. **Tell your users that this is not a will**. Pair every deployment with a one-pager that says so.
