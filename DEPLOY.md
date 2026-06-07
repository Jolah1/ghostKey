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

### Required secrets

The server **will not boot** without `GHOSTKEY_MASTER_KEY`, and CORS
preflight will reject every browser request unless `GHOSTKEY_ALLOWED_ORIGINS`
includes your frontend origin. Set both before the first deploy:

```sh
# 1. Server master key — encrypts heir-contact rows at rest.
#    Generate ONE fresh 32-byte key, save a copy to your password
#    manager, then set it:
KEY=$(openssl rand 32 | base64 | tr -d '=\n')
echo "$KEY"       # <-- save this somewhere safe BEFORE pasting it into Fly
fly secrets set GHOSTKEY_MASTER_KEY="$KEY" -a ghostkey

# 2. CORS allowlist — comma-separated exact-match origins.
#    Default (when unset) is localhost:5173 only, which is correct for
#    `cargo run` but breaks every browser pointed at the live frontend.
fly secrets set GHOSTKEY_ALLOWED_ORIGINS="https://ghostkeyapp.vercel.app" -a ghostkey
```

**About `GHOSTKEY_MASTER_KEY`:** lose it and every heir-contact row
already in the database becomes unrecoverable. The heir's *Bitcoin* is
still safe (the on-chain script enforces inheritance independently),
but the server can no longer email the heir when the alarm fires. Treat
it the way you'd treat your database backup key — back it up to a
second location.

**About `GHOSTKEY_ALLOWED_ORIGINS`:** add new origins as a
comma-separated list (`fly secrets set GHOSTKEY_ALLOWED_ORIGINS="a,b,c"`).
The list is exact-match; subdomain wildcards are not supported. If you
add a custom domain, list both `https://yourdomain.tld` and any
`www.` variant you'll serve from.

Both are stored encrypted in Fly's secret store and survive restarts,
deploys, and machine upgrades. You only need to re-run the commands
above if you deliberately rotate (see "Rotating the master key" below
for the design + procedure).

### Rotating the master key

`GHOSTKEY_MASTER_KEY` plays two structurally different roles —
encrypting heir-contact PII at rest, and deriving F2 server-derived
heir keys whose xpubs are committed on-chain. The rotation design
splits those roles so you can rotate the off-chain one without doing
anything on-chain. Read [`docs/master-key-rotation.md`](./docs/master-key-rotation.md)
for the full design (key generations, schema columns, what happens
to existing vaults). What follows is the operator runbook only.

> **Implementation status.** The design has landed; the implementation
> (the `pii_key_gen` / `f2_key_gen` schema columns, the
> `GHOSTKEY_PII_KEY_V<N>` / `GHOSTKEY_F2_KEY_V<N>` env vars, the
> background re-encryption worker, the owner-facing
> `POST /vaults/:id/rotate-f2` route) is tracked under #27 and will
> land in a follow-up PR. Until that PR ships, the procedures below
> tell you what *will* be possible; today, a rotation still requires
> a manual `sqlite3` re-encryption pass (see §6 of the design doc).

#### Suspected leak: emergency procedure

Within the **first hour:**

```sh
# 1. Generate fresh keys for BOTH roles. Treat both as compromised
#    even if you only suspect one — the cost is low.
PII_NEW=$(openssl rand 32 | base64 | tr -d '=\n')
F2_NEW=$(openssl rand 32 | base64 | tr -d '=\n')

# 2. Set the new generations and flip the CURRENT pointers.
fly secrets set GHOSTKEY_PII_KEY_V2="$PII_NEW" GHOSTKEY_PII_KEY_CURRENT=V2 \
                GHOSTKEY_F2_KEY_V2="$F2_NEW"  GHOSTKEY_F2_KEY_CURRENT=V2 \
                -a ghostkey
fly deploy -a ghostkey                           # forces restart

# 3. Watch the boot log for "rotation: re-encrypting <N> vaults still
#    on V1". The background worker drains the long tail at the rate
#    set by GHOSTKEY_REKEY_PER_SEC (default 1/sec; raise during an
#    emergency).
fly logs -a ghostkey | grep rotation
```

Within the **first 24 hours:**

- Notify the owners of every vault still tagged `f2_key_gen = 1`
  (i.e. F2 vaults). Their on-chain commitment is unchanged; tell
  them to tap **Refresh heir key** on the dashboard within 24
  hours. The email template is in `templates/leak-notice.txt` (to
  be added with the implementation PR).
- Disclose per [`SECURITY.md`](../SECURITY.md). Coordinated
  disclosure applies to leaks we discover, not only to reports.

Within **one week:**

- Audit `pii_key_gen` distribution — every row should be at `V2`.
- Remove the compromised generation:
  ```sh
  fly secrets unset GHOSTKEY_PII_KEY_V1 GHOSTKEY_F2_KEY_V1 -a ghostkey
  fly deploy -a ghostkey
  ```
  If the server refuses to boot, a row still references V1; fix the
  row, then retry. **Do not** force-remove the env var while rows
  reference it — those vaults become permanently un-decryptable.
- Post-mortem entry in [`JOURNAL.md`](../JOURNAL.md).

#### Routine rotation: quarterly

Same shape as the emergency procedure, but you pace yourself:

```sh
# Once a quarter, generate a fresh PII key only — F2 rotation is the
# owner's call, not yours (see the design doc § 1).
PII_NEW=$(openssl rand 32 | base64 | tr -d '=\n')
fly secrets set GHOSTKEY_PII_KEY_V<N+1>="$PII_NEW" GHOSTKEY_PII_KEY_CURRENT=V<N+1> -a ghostkey
fly deploy -a ghostkey

# Let the background worker drain the long tail over a week. Then:
fly secrets unset GHOSTKEY_PII_KEY_V<N> -a ghostkey
fly deploy -a ghostkey
```

There is no outage at any step — the dual-loaded server can decrypt
both generations during the overlap.

#### Audit checklist (run before declaring rotation complete)

Both flavours of rotation are "done" only when *all four* are true:

- [ ] `fly logs` shows `rotation: all vaults at V<N+1>` (or the
      pending count is zero).
- [ ] `fly secrets list` shows no entry for the retired generation.
- [ ] `sqlite3 ghostkey.sqlite 'SELECT COUNT(*) FROM vaults WHERE
      pii_key_gen = <N>;'` returns 0.
- [ ] The server boots cleanly without the retired key (proves no
      row references it).

#### Why split PII rotation from F2 rotation

The F2 heir's xpub is a function of `(master_key, heir_email,
vault_id)` and is committed on-chain via the vault's Taproot
descriptor. Rotating the master key changes the derived xpub —
which is fine for a *new* vault, but breaks the existing UTXO's
claimability. You cannot rotate Role B (heir derivation) without
moving funds on-chain to a fresh vault under the new generation.

That's why the design separates the two env-var prefixes
(`GHOSTKEY_PII_KEY_V<N>` vs `GHOSTKEY_F2_KEY_V<N>`). An operator
who simply wants to rotate the PII key for hygiene reasons can do
so without any on-chain effect.

If both roles still share a single secret (the legacy single-key
deployment), `GHOSTKEY_MASTER_KEY` continues to act as the V1 key
for both. The migration from single-key to split-key is documented
in [`docs/master-key-rotation.md`](./docs/master-key-rotation.md)
§4.

### Optional: notification delivery

The notifier worker accepts enqueues on any channel and skips delivery
when the backend for that channel is not configured. A vault with a
sealed owner contact on a channel without a backend stays `pending`
until a deployment with the backend wired comes up — no data is lost,
no row is dropped.

#### Email (SMTP)

```sh
fly secrets set \
  SMTP_HOST="smtp.postmarkapp.com" \
  SMTP_PORT="587" \
  SMTP_FROM="alerts@yourdomain.tld" \
  SMTP_USER="postmark-server-token" \
  SMTP_PASS="postmark-server-token" \
  -a ghostkey
```

`SMTP_USER` and `SMTP_PASS` are optional. `SMTP_FROM` defaults to
`noreply@localhost` with a startup warning if you don't set it; that's
fine for local testing and wrong for production.

#### SMS + WhatsApp (Twilio)

A single Twilio account does both. Get the SID + auth token from
https://console.twilio.com/, and provision a phone number (Twilio
Trial gives you one for free). For WhatsApp during dev, use the
shared sandbox number `+14155238886` after running the join command
documented at https://www.twilio.com/docs/whatsapp/sandbox.

```sh
fly secrets set \
  TWILIO_ACCOUNT_SID="ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" \
  TWILIO_AUTH_TOKEN="your-secret-token" \
  TWILIO_SMS_FROM="+15551234567" \
  TWILIO_WHATSAPP_FROM="+14155238886" \
  -a ghostkey
```

All four are required together — setting some but not others puts the
worker in a partial state and logs a loud warning. Set every
`TWILIO_*` var or none.

If `TWILIO_*` is unset, SMS and WhatsApp notifications stay queued
(`status='pending'` in the `notifications` table) until a deployment
with Twilio configured picks them up. A future deployment that adds
Twilio will deliver the backlog automatically on its first tick.

### Rate-limit budgets

The unauthenticated endpoints (`/assist/chat`, `/vaults`,
`/vaults/from-xpub`, `/vaults/find`, `/claim/:token/*`) are protected
by an in-process per-IP token-bucket limiter. Buckets refill
continuously; on exhaustion the server returns `429 Too Many Requests`
with a `Retry-After` header and a `tracing::info` line tagged
`limiter=<name>` for monitoring.

Defaults are tuned for the threat model in `crates/ghostkey-server/src/routes.rs`
(see the comment on `router()`). You almost never need to change
them, but every budget is overridable per-deploy via two env vars:

| Surface | Routes covered | `BURST` default | `PER_SEC` default | Steady-state |
|---|---|---|---|---|
| `GHOSTKEY_RL_ASSIST_*` | `POST /assist/chat` | 3 | 0.2 | ~12/min |
| `GHOSTKEY_RL_CREATE_*` | `POST /vaults`, `POST /vaults/from-xpub` | 3 | 0.05 | ~3/min |
| `GHOSTKEY_RL_FIND_*` | `POST /vaults/find` | 30 | 0.5 | ~30/min |
| `GHOSTKEY_RL_CLAIM_*` | `GET/POST /claim/:token/*` | 20 | 0.333 | ~20/min |

`BURST` is the worst-legitimate-burst size (a u32). `PER_SEC` is the
steady-state allowance in tokens per second (a float). A value that
is unparseable or out of range (`BURST < 1` or `PER_SEC <= 0`) logs a
warning at boot and falls back to the default — a fat-fingered env
var doesn't take the server offline.

Example: an operator running an open demo where chat traffic is the
draw might want to loosen `/assist/chat`:

```sh
fly secrets set GHOSTKEY_RL_ASSIST_BURST=10 GHOSTKEY_RL_ASSIST_PER_SEC=0.5 -a ghostkey-demo
```

Caveats:

- Per-IP keying uses `Fly-Client-IP` → `X-Forwarded-For` → TCP peer
  in that order. Behind any other reverse proxy, audit the header
  semantics before trusting the bucket.
- The limiter is in-process. Horizontal scale-out across multiple
  Fly machines means each machine has its own bucket — limits scale
  with replica count. If you scale past one replica per region,
  revisit whether shared-state limiting (Redis, CDN-level) is needed.
- `/health` and the LNURL endpoints are deliberately not rate-limited;
  see the same code comment for the rationale.

### Picking which Bitcoin network the UI defaults to

The web UI defaults new vaults to **testnet**. The server-side
allow-list accepts all four — `bitcoin`, `testnet`, `signet`,
`regtest` — but the wizards POST whichever the server reports on
`GET /health.default_network`. This means: a single web bundle on
Vercel can serve testnet on `ghostkey.fly.dev`, signet on
`ghostkey-signet.fly.dev`, etc., with no per-deployment rebuild.

```sh
# Default (when unset) is testnet.
fly secrets set GHOSTKEY_DEFAULT_NETWORK=signet -a ghostkey-signet
```

Valid values are `bitcoin`, `testnet`, `signet`, `regtest`. Any
other string falls back to `testnet` with an error logged at boot.
Setting `GHOSTKEY_DEFAULT_NETWORK=bitcoin` (mainnet) is permitted
and logs a startup warning so the choice is unmissable in the boot
log.

The alpha banner on the web UI reads the same value and names the
network it's on, so a user landing on the signet test deployment
sees "Alpha: GhostKey is running on Bitcoin signet" instead of the
historical hard-coded "testnet". For the live signet end-to-end
test runbook see `SIGNET_E2E_RUNBOOK.md` at the repo root.

### Demo mode (do NOT enable in production)

`GHOSTKEY_DEMO_MODE=1` loosens the cadence/grace validation to seconds
so the entire owner-misses-check-in → alarm → claim flow can be
demonstrated live in under a minute. It also drops the scheduler tick
to one second and surfaces an amber "Demo mode" banner in the web UI.

Use it for sandbox deployments (a `ghostkey-demo.fly.dev` you point
at conference attendees, a local laptop for screen recordings) and
nowhere else. The flag is forbidden in combination with mainnet
vault creation — the server refuses to create a `"bitcoin"` vault
when demo mode is on — but a careless owner who tapped through a
demo signup with a 10-second cadence would still be locked out of
recovery the moment they closed the tab. Keep demo and production
deployments on different fly apps / different `GHOSTKEY_BIND` ports
to avoid mixing them up.

To run a demo on Fly:

```sh
fly apps create ghostkey-demo
fly secrets set GHOSTKEY_DEMO_MODE=1 -a ghostkey-demo
fly secrets set GHOSTKEY_MASTER_KEY="$(openssl rand -base64 32)" -a ghostkey-demo
fly secrets set GHOSTKEY_ALLOWED_ORIGINS="https://ghostkey-demo.example.com" -a ghostkey-demo
fly deploy -a ghostkey-demo
```

Audit your logs after the first boot: the server prints a `tracing::warn`
the first time it observes the flag is on, plus an `info` line every
time the demo override clamps the scheduler tick. Both should appear
exactly once at startup; if they appear on a server you didn't mean to
make a demo, unset the env var and redeploy immediately.

### Deploy

```sh
fly deploy
fly status
fly logs                      # tail the server log
curl https://ghostkey.fly.dev/health
```

### Continuous deploy from GitHub Actions

`.github/workflows/deploy-fly.yml` re-deploys the server on every push
to `main` that touches `crates/`, `Cargo.*`, `Dockerfile`, or
`fly.toml`. This avoids the "stale binary in production" trap where
the code on `main` and the binary at `ghostkey.fly.dev` drift apart
for weeks until someone notices a 4xx.

**One-time setup:**

1. Create a deploy-scoped Fly token (don't use your personal one):
   ```sh
   fly tokens create deploy --app ghostkey --expiry 8760h
   # 1 year; rotate annually
   ```
2. Add it as a repository secret named `FLY_API_TOKEN`:
   GitHub → Settings → Secrets and variables → Actions → New
   repository secret.
3. The workflow's next push to `main` (or `workflow_dispatch` from
   the Actions tab) will deploy.

Manual `fly deploy` from your laptop still works any time you want
to ship a hotfix without going through `main`.

**If the deploy starts failing:** the workflow probes
`flyctl auth whoami` before attempting `flyctl deploy`, so an
expired or revoked `FLY_API_TOKEN` produces an explicit error
annotation in the GitHub Action log (rather than a silent 5-second
exit-1 from `flyctl deploy` itself, which was the failure mode
before we hardened the workflow in commit `48ce916`'s follow-up).
If you see "FLY_API_TOKEN is missing, expired, or revoked" in the
action log, regenerate the token with the command above and update
the GitHub secret.

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

### Backups (mandatory)

The Fly volume is single-host. A corrupted block, an accidental
`fly volumes destroy`, or a long region outage takes the only copy
of the database with it. Bitcoin custody software cannot live on a
single-copy database.

A small helper script lives at `scripts/backup-fly-db.sh`. It pulls
`/data/ghostkey.sqlite` off the volume, verifies the file is actually
a SQLite database (and not e.g. an HTML error page), and keeps the
12 most recent backups in a cloud-synced folder of your choice.

One-time setup:

```sh
# Point BACKUP_DIR at a folder that's synced to a second physical
# location: Google Drive, OneDrive, Dropbox, iCloud Drive, etc.
# A backup that only lives on the same laptop as the laptop you
# might lose tomorrow is not a backup.
echo 'export BACKUP_DIR="/mnt/c/Users/you/OneDrive/ghostkey-backups"' \
  >> ~/.bashrc
source ~/.bashrc
```

Routine:

```sh
./scripts/backup-fly-db.sh
```

Frequency: monthly while traffic is low (set a calendar reminder —
don't trust your memory). Bump to weekly once you have real users.
For mainnet you'll want a server-side cron pushing to S3-class
storage; the manual script is the bridge until then.

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

## Lightning sidecar (two-process deploy)

The Lightning check-in flow is gated on a feature probe: the dashboard
only renders the "Check in with Lightning" button when the server's
`/health` returns `lightning_enabled: true`. The server returns `true`
only when both `GHOSTKEY_LN_SIDECAR_URL` and
`GHOSTKEY_LN_SIDECAR_SHARED_SECRET` are configured, pointing at a running
sidecar. With either missing, the server runs with `NoopProvider` and
the UI shows the fallback hint instead (see issue #15).

> **Upgrading from `GHOSTKEY_LN_BREEZ_*`.** The env vars used to be
> `GHOSTKEY_LN_BREEZ_URL` / `GHOSTKEY_LN_BREEZ_SHARED_SECRET` back
> when Breez was the only backend. Both the main server and both
> sidecars still honour the legacy names with a deprecation warning;
> no urgent action needed. To upgrade quietly: read the existing
> value (`fly secrets list` shows the keys), then re-`fly secrets
> set` it under the new name and remove the old one.

The sidecar lives at `crates/ghostkey-lightning-breez/`. It's a
**separate Fly app** in the same Fly organisation as the main
`ghostkey` app — they reach each other over the 6PN private network.

> **Upstream status.** As of 2026-05-26, `breez-sdk-liquid` 0.12.2
> does not compile from a clean checkout (transitive `boltz-client` /
> `secp256k1_zkp` skew). Until Breez ships a tag whose `boltz-client`
> rev compiles against current `secp256k1_zkp`, `fly deploy` for this
> sidecar will fail during the Rust build. The fly.toml, Dockerfile,
> and DEPLOY.md plumbing below are committed anyway so the deploy is
> one command away the moment upstream is green; alternatively, the
> sidecar's three-route HTTP surface (see
> `crates/ghostkey-lightning-breez/README.md` "API") is small enough
> to re-implement against a different backend (LNbits, Phoenixd, LND)
> as a drop-in.

### 1. Provision the sidecar app

```sh
fly apps create ghostkey-lightning-breez
fly volumes create breez_data --region ams --size 1 \
  -a ghostkey-lightning-breez
```

Use the **same region** as the main app. The 6PN private network is
flat across regions, so cross-region works, but co-locating shaves
~tens of ms off every invoice mint.

### 2. Set the sidecar's secrets

The sidecar refuses to start without `BREEZ_API_KEY`, `BREEZ_MNEMONIC`,
and `GHOSTKEY_LN_SIDECAR_SHARED_SECRET`. The Breez API key is free from
<https://breez.technology>. The mnemonic is a 12-word BIP39 seed —
**this is the sidecar's own Lightning wallet**, not anyone's vault
key. Generate a fresh seed; do not reuse one.

```sh
fly secrets set \
  BREEZ_API_KEY="your-breez-api-key" \
  BREEZ_MNEMONIC="word1 word2 ... word12" \
  GHOSTKEY_LN_SIDECAR_SHARED_SECRET="$(openssl rand -hex 32)" \
  -a ghostkey-lightning-breez
```

Copy the shared secret somewhere safe — you need to set the same value
on the main app in step 4.

### 3. Deploy the sidecar

```sh
fly deploy --config crates/ghostkey-lightning-breez/fly.toml
```

This builds `crates/ghostkey-lightning-breez/Dockerfile` and pushes the
image. The Dockerfile only sees the crate dir (not the workspace), so
the build is isolated from the main `ghostkey` workspace.

Confirm the sidecar is reachable from inside the Fly network — open an
SSH session on the **main** app's machine and curl the sidecar's health
endpoint:

```sh
fly ssh console -a ghostkey
# inside the main app's machine:
apt-get update && apt-get install -y curl
curl -H "Authorization: Bearer <shared-secret>" \
  http://ghostkey-lightning-breez.internal:8788/v1/health
# expect: {"ok":true,"ready":true}
```

`ready` may be `false` for the first ~30 seconds while the Breez SDK
warms up. That's expected and the readiness check tolerates it.

### 4. Wire the main app at the sidecar

```sh
fly secrets set \
  GHOSTKEY_LN_SIDECAR_URL="http://ghostkey-lightning-breez.internal:8788" \
  GHOSTKEY_LN_SIDECAR_SHARED_SECRET="<same hex string as step 2>" \
  -a ghostkey
```

Setting either secret triggers a redeploy of the main app. After it
finishes:

```sh
curl https://ghostkey.fly.dev/health \
  | jq '.lightning_enabled'
# expect: true
```

If `lightning_enabled` is still `false`, check the main app's logs for
the line `lightning provider: noop (LN env missing)` vs.
`lightning provider: HttpProvider` (see
`crates/ghostkey-server/src/lightning.rs::build_provider`). The Noop
line means one of the two env vars on the main app is missing or
empty.

### 5. Rotating the shared secret

The shared secret is a HMAC-of-rest bearer token shipped on every
sidecar request. Rotate it by setting the **new** value on both apps
in the order: sidecar first, then main. There is a brief window
(seconds) during which invoice mints will 401 — that's acceptable;
the failed POST surfaces in the dashboard as "Lightning check-in
failed, try again."

```sh
NEW=$(openssl rand -hex 32)
fly secrets set GHOSTKEY_LN_SIDECAR_SHARED_SECRET="$NEW" \
  -a ghostkey-lightning-breez
fly secrets set GHOSTKEY_LN_SIDECAR_SHARED_SECRET="$NEW" \
  -a ghostkey
```

The Breez wallet seed (`BREEZ_MNEMONIC`) **cannot** be rotated without
moving the sidecar's on-chain Liquid balance. That balance is only ever
1-sat-per-heartbeat in normal operation, so the easy path is "drain the
wallet, regenerate the mnemonic, redeploy." Persist the volume's
`/data/breez` content if you want to swap mnemonics without losing
balance.
## Signet nightly smoke

A scheduled GitHub Action (`.github/workflows/signet-nightly.yml`)
exercises the deployed signet staging app every night at 06:00 UTC.
It runs `scripts/signet-smoke.sh`, which:

1. Probes `/health` and asserts `default_network == signet`.
2. Creates a fresh vault via `POST /vaults/from-xpub`.
3. Posts an owner check-in.
4. Reads `/vaults/:id/events` and asserts both `registered` and
   `checkin` rows are present.
5. Deletes the vault and confirms a follow-up GET returns 404.

What it does **not** do: build, sign, or broadcast an on-chain
claim transaction. That path needs signet faucet funds and 1-2
signet blocks (~10-20 minutes) per run, which is too flaky for a
daily cron. The on-chain side is covered by the weekly manual
walk of [`SIGNET_E2E_RUNBOOK.md`](./SIGNET_E2E_RUNBOOK.md).

### Required GitHub Actions secrets

| Secret | What it is |
|---|---|
| `GHOSTKEY_SIGNET_URL` | Base URL of the signet staging app, e.g. `https://ghostkey-signet.fly.dev` |
| `SIGNET_OWNER_XPUB` | BIP86 Taproot tpub for the smoke vault's owner |
| `SIGNET_OWNER_FINGERPRINT` | 8 hex chars (the BIP32 fingerprint) |
| `SIGNET_HEIR_XPUB` | BIP86 Taproot tpub for the smoke vault's heir |
| `SIGNET_HEIR_FINGERPRINT` | 8 hex chars |
| `SIGNET_NIGHTLY_WEBHOOK` (optional) | Discord/Slack webhook for failure notifications |

The xpubs are watch-only — they cannot move funds — but they
should still come from a fresh, non-production wallet so the
smoke vault never holds real value.

### Reading a failed run

The script prints `PASS:` / `FAIL:` per step. A failure means:

- **/health failed** — staging signet app is down. Check
  `fly status -a ghostkey-signet` and recent `fly logs`.
- **POST /vaults/from-xpub failed** — server is up but rejecting
  the create. Most likely cause: a recent migration changed the
  validation surface. The body printed by the script will say
  which field is wrong.
- **/checkin failed** — the owner-token bearer header isn't being
  accepted. Most likely cause: a route auth refactor.
- **events log missing rows** — the SQLite write path didn't
  commit. Investigate the scheduler / database tier.
- **DELETE failed** — cascade delete regression; inspect the
  cascade trigger in the latest migration.

This job is a **smoke signal, not a merge gate**. It runs on
schedule only and does not block PRs.
## Lightning sidecar — LNbits alternative

If the Breez sidecar build is broken on your toolchain (see the
upstream-status note in `crates/ghostkey-lightning-breez/README.md`),
the sibling crate `crates/ghostkey-lightning-lnbits/` implements the
**same three-route HTTP wire protocol** against an LNbits instance.
The main `ghostkey-server` is provider-agnostic; point its
`GHOSTKEY_LN_SIDECAR_URL` env var at whichever sidecar you deployed and
the dashboard renders the check-in button either way.

Deploy is the same shape as the Breez sidecar — see the Breez
section above for the verify/wire/rotate steps — with these
substitutions:

```sh
# Provision
fly apps create ghostkey-lightning-lnbits

# Secrets (no BREEZ_API_KEY or BREEZ_MNEMONIC; the LNbits instance
# is the actual Lightning node, this sidecar is a thin translator).
fly secrets set \
  LNBITS_URL="https://lnbits.example.com" \
  LNBITS_INVOICE_KEY="..." \
  GHOSTKEY_LN_SIDECAR_SHARED_SECRET="$(openssl rand -hex 32)" \
  -a ghostkey-lightning-lnbits

# Deploy
fly deploy --config crates/ghostkey-lightning-lnbits/fly.toml

# Wire the main app
fly secrets set \
  GHOSTKEY_LN_SIDECAR_URL="http://ghostkey-lightning-lnbits.internal:8788" \
  GHOSTKEY_LN_SIDECAR_SHARED_SECRET="<the same hex>" \
  -a ghostkey
```

Use the LNbits wallet's **invoice key** (receive-only), not the
admin key. This sidecar never sends — it only mints inbound invoices
for the 1-sat check-in heartbeats and polls their status — so the
lower-privilege key is the right choice.

The sidecar holds no on-disk state; the LNbits instance owns the
Lightning wallet. Back up the LNbits instance the way you would
back up any other Lightning wallet, and treat the LNbits
`adminkey` as the recovery secret of last resort.

For the LNbits setup itself (self-host vs. managed vs. demo
instance) see `crates/ghostkey-lightning-lnbits/README.md`.

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
