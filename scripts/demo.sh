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
# What needs a real chain (optional): actually moving coins. The owner
# kit's "find coins / sign / broadcast" and the heir sweep need a funded
# UTXO. For that, run on signet and fund the address from a faucet (see
# SIGNET_E2E_RUNBOOK.md), or use regtest with a local bitcoind. The demo
# defaults to signet so the addresses it shows are fundable if you want
# to go that far.
#
# Usage:
#   ./scripts/demo.sh                 # signet, demo mode
#   GHOSTKEY_DEFAULT_NETWORK=regtest ./scripts/demo.sh
#
# Prereqs: Rust 1.85+, Node 20+, and `npm install` already run once in
# ghostkey-web (the script does it for you if node_modules is missing).

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

NETWORK="${GHOSTKEY_DEFAULT_NETWORK:-signet}"
if [[ "$NETWORK" == "bitcoin" || "$NETWORK" == "mainnet" ]]; then
    echo "error: demo mode refuses mainnet. Use signet, testnet, or regtest." >&2
    exit 1
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
GHOSTKEY_DEMO_MODE=1 \
GHOSTKEY_DEFAULT_NETWORK="$NETWORK" \
GHOSTKEY_MASTER_KEY="$MASTER_KEY" \
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

Walk it as a user (see docs/e2e-runbook.md for the full script):

  1. Open the dashboard, create a vault. Pick a short waiting period
     (seconds) — demo mode forces the on-chain timelock to 1 block.
  2. On the funding screen: download the OWNER KIT and the HEIR
     ENVELOPE, and write down the envelope passphrase (shown once).
  3. Do nothing for ~45s. The vault alarms and the server prints a
     line to THIS log:  "DEMO MODE claim link ...: .../#/claim/<token>"
  4. Open that link in a fresh tab to play the heir, then open
     "Advanced: save your own recovery file" to get the block-B kit.

To actually move coins (owner kit / heir sweep), run on signet and
fund the address from a faucet — see SIGNET_E2E_RUNBOOK.md.

Press Ctrl+C to stop both processes.
================================================================

EOF

wait
