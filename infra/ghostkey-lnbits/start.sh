#!/usr/bin/env bash
# infra/ghostkey-lnbits/start.sh
#
# Boots phoenixd in the background, waits for its HTTP socket, reads
# the auto-generated `http-password` from phoenixd's config, exports
# the env vars LNbits needs to talk to phoenixd as its wallet backend,
# then execs LNbits in the foreground so Fly tracks LNbits as the
# main process.
#
# State directories on the Fly volume (/data):
#
#   /data/phoenix   — phoenix.conf (incl. the 12-word seed + http
#                     password), channel state, on-chain wallet.
#   /data/lnbits    — LNbits SQLite DB + superuser key.
#
# On first boot, phoenixd writes a 12-word seed into
# /data/phoenix/seed.dat. BACK THIS UP before sending any non-trivial
# BTC to the on-chain deposit address — it is the only recovery
# secret for the channel balance.

set -euo pipefail

# ----- paths -----------------------------------------------------------------

PHOENIX_DIR="/data/phoenix"
LNBITS_DIR="/data/lnbits"

mkdir -p "$PHOENIX_DIR" "$LNBITS_DIR"

# ----- phoenixd boot ---------------------------------------------------------

# Bind the HTTP API to localhost only. The shared-secret bearer
# enforced by the ghostkey-lightning-lnbits sidecar is the public
# auth layer; phoenixd's own HTTP-basic password is the inner one.
phoenixd \
  --datadir "$PHOENIX_DIR" \
  --http-bind-ip 127.0.0.1 \
  --http-bind-port 9740 \
  --agree-to-terms-of-service \
  --chain mainnet \
  &
PHOENIXD_PID=$!

# Reap phoenixd if it dies — without this, LNbits would keep running
# against a dead wallet backend and silently fail every invoice.
trap 'kill -TERM $PHOENIXD_PID 2>/dev/null || true' EXIT INT TERM

# Wait for phoenixd's HTTP API to be ready. First boot generates the
# seed + on-chain wallet + LSP handshake which can take ~30s.
echo "[start.sh] waiting for phoenixd HTTP socket..."
for i in $(seq 1 120); do
  if nc -z 127.0.0.1 9740; then
    echo "[start.sh] phoenixd up after ${i}s"
    break
  fi
  if ! kill -0 "$PHOENIXD_PID" 2>/dev/null; then
    echo "[start.sh] FATAL: phoenixd exited before HTTP came up" >&2
    exit 1
  fi
  sleep 1
done

if ! nc -z 127.0.0.1 9740; then
  echo "[start.sh] FATAL: phoenixd HTTP socket did not open within 120s" >&2
  exit 1
fi

# Read the auto-generated HTTP password phoenixd wrote to its conf.
# phoenix.conf is single-key=value lines; grep + cut is sufficient
# (no quoting / escaping in this file's format).
if [[ ! -f "$PHOENIX_DIR/phoenix.conf" ]]; then
  echo "[start.sh] FATAL: phoenix.conf missing after phoenixd boot" >&2
  exit 1
fi

PHOENIXD_HTTP_PASSWORD="$(grep '^http-password=' "$PHOENIX_DIR/phoenix.conf" | head -n1 | cut -d= -f2-)"
if [[ -z "$PHOENIXD_HTTP_PASSWORD" ]]; then
  echo "[start.sh] FATAL: could not read http-password from phoenix.conf" >&2
  exit 1
fi

# ----- LNbits env ------------------------------------------------------------

export LNBITS_BACKEND_WALLET_CLASS="PhoenixdWallet"
export PHOENIXD_API_ENDPOINT="http://127.0.0.1:9740"
export PHOENIXD_API_PASSWORD="$PHOENIXD_HTTP_PASSWORD"

export LNBITS_DATA_FOLDER="$LNBITS_DIR"
export LNBITS_HOST="0.0.0.0"
export LNBITS_PORT="5000"

# Keep the LNbits dashboard private — bearer-only auth from the
# ghostkey-lightning-lnbits sidecar inside Fly's 6PN. No public
# users.
export LNBITS_SITE_TITLE="GhostKey LNbits (internal)"
export LNBITS_SITE_TAGLINE="receives 1-sat heartbeats, custodies no user funds"

echo "[start.sh] starting LNbits with PhoenixdWallet backend on :5000"
exec /app/.venv/bin/python -m uvicorn lnbits.__main__:app \
  --host "$LNBITS_HOST" \
  --port "$LNBITS_PORT"
