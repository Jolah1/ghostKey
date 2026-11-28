#!/usr/bin/env bash
# scripts/demo.sh
#
# One command to run GhostKey end-to-end on your own laptop, in demo
# mode, with nothing external required. Starts the server (seconds-scale
# cadences) and the web dashboard, prints the URL, and tears both down
# on Ctrl+C.
#
# What you can see WITHOUT touching Bitcoin (no faucet, no funding):
#   - create a vault (password flow)
#   - download the owner kit + the heir envelope (both built in-browser)
#   - watch the vault alarm in ~45s and issue the claim link
#   - open the claim page and save the block-B heir recovery file
#
# The claim link normally arrives by email/SMS. There's no SMTP/Twilio
# in a local run, so the server PRINTS the claim link to its log in demo
# mode — watch this script's output for a line like:
#   DEMO MODE claim link ...: http://127.0.0.1:5173/#/claim/<token>
# Open that in a fresh tab to play the heir.
#
# Moving real (test) coins: the demo defaults to signet on MUTINYNET,
# a signet with 30-second blocks and a free faucet. Fund a vault address
# from https://faucet.mutinynet.com and it confirms in about 30 seconds,
# so deposits, the owner kit and the heir sweep can all be tried for
# free in minutes. This replaces the hosted ghostkey-signet app, which
# was shut down on 2026-11-24 to save cost. Regtest with a local
# bitcoind also works (see SIGNET_E2E_RUNBOOK.md).
#
# Coins from other signet faucets (e.g. mempool.space/signet) are on a
# different chain and won't show up here. Explorer links in the UI point
# at mempool.space/signet and won't find Mutinynet transactions: use
# https://mutinynet.com to look them up.
#
# Usage:
#   ./scripts/demo.sh                 # signet, demo mode
#   GHOSTKEY_DEFAULT_NETWORK=regtest ./scripts/demo.sh
#   GHOSTKEY_ESPLORA_URL=https://mempool.space/signet/api ./scripts/demo.sh
#                                     # signet, but a different explorer
#
# Prereqs: Rust 1.94+, Node 20+, and `npm install` already run once in
# ghostkey-web (the script does it for you if node_modules is missing).

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

NETWORK="${GHOSTKEY_DEFAULT_NETWORK:-signet}"
if [[ "$NETWORK" == "bitcoin" || "$NETWORK" == "mainnet" ]]; then
    echo "error: demo mode refuses mainnet. Use signet, testnet, or regtest." >&2
    exit 1
fi

# On signet, read the chain from Mutinynet (30s blocks, free faucet)
# unless the caller picked an explorer. Other networks keep the
# server's own default.
ESPLORA_URL="${GHOSTKEY_ESPLORA_URL:-}"
if [[ -z "$ESPLORA_URL" && "$NETWORK" == "signet" ]]; then
    ESPLORA_URL="https://mutinynet.com/api"
fi
if [[ -n "$ESPLORA_URL" ]]; then
    export GHOSTKEY_ESPLORA_URL="$ESPLORA_URL"
fi

# A throwaway master key for the local run. Persisted to a gitignored
# file so vaults created in one demo session still decrypt in the next
# (the master key encrypts heir/owner contacts at rest).
KEY_FILE="$repo_root/.demo-master-key"
if [[ -f "$KEY_FILE" ]]; then
    MASTER_KEY="$(cat "$KEY_FILE")"
else
    MASTER_KEY="$(openssl rand -base64 32)"
    printf '%s' "$MASTER_KEY" >"$KEY_FILE"
    chmod 600 "$KEY_FILE"
fi

echo "=== Building server (debug) ..."
cargo build -p ghostkey-server

if [[ ! -d ghostkey-web/node_modules ]]; then
    echo "=== Installing web deps (first run only) ..."
    (cd ghostkey-web && npm install)
fi

# Refuse to start if a previous demo is still holding either port.
# Otherwise Vite silently jumps to :5174 while an orphaned old Vite
# keeps answering :5173 with no server behind it — which looks exactly
# like "the backend is down" (ECONNREFUSED on /api, /health). Fail
# loudly with the fix instead.
for port in 8787 5173; do
    if (ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null) | grep -qE "[.:]$port "; then
        echo "error: port $port is already in use — a previous demo is probably still running." >&2
        echo "       Stop the strays, then re-run ./scripts/demo.sh :" >&2
        echo "         pkill -f target/debug/ghostkey-server" >&2
        echo "         pkill -f node_modules/.bin/vite" >&2
        exit 1
    fi
done

pids=()
cleanup() {
    echo
    echo "=== Shutting down demo ..."
    for pid in "${pids[@]:-}"; do
        [[ -n "$pid" ]] && kill "$pid" 2>/dev/null || true
    done
    wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "=== Starting server (demo mode, network=$NETWORK) on :8787 ..."
# Point claim/check-in links at the LOCAL dashboard. Without this the
# server falls back to the production URL (ghostkeyapp.vercel.app), so
# the claim link printed below would open the live mainnet site — which
# has never seen your local token and just says "link doesn't work".
GHOSTKEY_DEMO_MODE=1 \
GHOSTKEY_DEFAULT_NETWORK="$NETWORK" \
GHOSTKEY_MASTER_KEY="$MASTER_KEY" \
GHOSTKEY_PUBLIC_BASE_URL="http://127.0.0.1:5173" \
    cargo run -p ghostkey-server &
pids+=($!)

echo "=== Starting web dashboard on :5173 ..."
# Vite dev proxies /api -> 127.0.0.1:8787, so no VITE_API_BASE needed.
(cd ghostkey-web && npm run dev) &
pids+=($!)

cat <<EOF

================================================================
GhostKey demo is starting up.

  Dashboard : http://127.0.0.1:5173
  Server    : http://127.0.0.1:8787  (network=$NETWORK, demo mode)
  Chain     : ${ESPLORA_URL:-server default}

Walk it as a user (see docs/e2e-runbook.md for the full script):

  1. Open the dashboard, create a vault. Pick a short waiting period
     (seconds) — demo mode forces the on-chain timelock to 1 block.
  2. On the funding screen: download the OWNER KIT and the HEIR
     ENVELOPE, and write down the envelope passphrase (shown once).
  3. Do nothing for ~45s. The vault alarms and the server prints a
     line to THIS log:  "DEMO MODE claim link ...: .../#/claim/<token>"
  4. Open that link in a fresh tab to play the heir, then open
     "Advanced: save your own recovery file" to get the block-B kit.

To move test coins: copy a vault's deposit address, get free coins at
https://faucet.mutinynet.com, and they confirm in about 30 seconds.
Look transactions up on https://mutinynet.com.

Press Ctrl+C to stop both processes.
================================================================

EOF

# Wait on the server specifically. If it dies (a panic, or a port it
# couldn't bind), the EXIT trap tears Vite down too — so you never get
# an orphaned dashboard answering with no backend behind it.
server_pid="${pids[0]}"
wait "$server_pid"
echo
echo "=== server process exited — stopping the demo." >&2
