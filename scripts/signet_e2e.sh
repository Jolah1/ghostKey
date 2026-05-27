#!/usr/bin/env bash
# scripts/signet_e2e.sh
#
# Curl harness for the Live Signet End-to-End test. Drives every
# server endpoint the full owner-setup -> alarm -> heir-claim flow
# touches, prints state at each step, and refuses to advance if
# something doesn't match what we expect.
#
# Why this exists:
#   The interactive parts of a signet test (funding from a faucet,
#   waiting for blocks to mine, copying the claim link into a fresh
#   browser session) are unavoidable. Everything ELSE -- vault
#   creation, address derivation, status polling, claim broadcast --
#   can be scripted. This script removes ~30 minutes of curl
#   commands and -d 'json...' typing from the runbook, and catches
#   common failures (wrong network, missing demo mode, mempool
#   indexer disagreement) earlier than you would by clicking.
#
# Usage:
#   The script is split into phases. Run them in order, with the
#   human bits in between:
#
#   ./scripts/signet_e2e.sh setup     # create vault, print address
#   #     <fund the address from a signet faucet>
#   #     <wait for the funding tx to confirm, ~10 min>
#   ./scripts/signet_e2e.sh observe   # poll vault state until alarm fires
#   #     <copy claim link from the printed alarm email body>
#   ./scripts/signet_e2e.sh diagnose  # one-shot status snapshot any time
#
# Required env (set in your shell or pass on the command line):
#   GHOSTKEY_SIGNET_URL    — e.g. https://ghostkey-signet.fly.dev
#                            The server you're testing. MUST have
#                            GHOSTKEY_DEFAULT_NETWORK=signet on it.
#   OWNER_XPUB             — origin-tagged or bare, signet/testnet (tpub)
#   OWNER_FINGERPRINT      — required if OWNER_XPUB is not origin-tagged
#   HEIR_XPUB              — same
#   HEIR_FINGERPRINT       — same
#   OWNER_EMAIL            — where the alarm-fired and pre-deadline
#                            reminder emails go. Optional but needed
#                            to exercise the new owner-notification
#                            path end-to-end.
#   HEIR_EMAIL             — the claim-link email recipient.
#
# Optional env:
#   TIMELOCK_BLOCKS        — default 6 (about an hour on signet).
#                            The server accepts 1..=65535.
#   CHECKIN_SECS           — default 30 (demo-mode minimum is 5).
#                            Only kicks in when the SERVER has
#                            GHOSTKEY_DEMO_MODE=1; otherwise the
#                            server-side floor (1h) applies and this
#                            value is silently ignored.
#   GRACE_SECS             — default 15.
#   STATE_FILE             — where to persist vault id + owner token
#                            between phases. Default ./.signet-e2e.json
#                            (gitignored). Lose this file and you lose
#                            access to the vault you just created.

set -euo pipefail

SERVER_URL="${GHOSTKEY_SIGNET_URL:-}"
STATE_FILE="${STATE_FILE:-./.signet-e2e.json}"
TIMELOCK_BLOCKS="${TIMELOCK_BLOCKS:-6}"
CHECKIN_SECS="${CHECKIN_SECS:-30}"
GRACE_SECS="${GRACE_SECS:-15}"

# ---- Helpers ----------------------------------------------------------------

die() {
    echo "error: $*" >&2
    exit 1
}

require_env() {
    local name="$1"
    if [[ -z "${!name:-}" ]]; then
        die "$name is not set. See script header for required env."
    fi
}

require_cmd() {
    command -v "$1" >/dev/null 2>&1 || die "missing command: $1"
}

# Tiny JSON probe so we don't drag in jq as a required dep. We expect
# `python3` to be on every Linux box, mac, and WSL setup.
json_get() {
    # json_get '<json>' '<dotted.path>'
    python3 -c '
import json, sys
data = json.loads(sys.argv[1])
for key in sys.argv[2].split("."):
    if isinstance(data, list):
        data = data[int(key)]
    else:
        data = data[key]
print(data if not isinstance(data, (dict, list)) else json.dumps(data))
' "$1" "$2"
}

# Pretty-print a JSON response if jq is available, otherwise dump raw.
pretty() {
    if command -v jq >/dev/null 2>&1; then
        jq . <<<"$1"
    else
        echo "$1"
    fi
}

# ---- Phases -----------------------------------------------------------------

phase_check_server() {
    require_env GHOSTKEY_SIGNET_URL
    echo "=== Probing $SERVER_URL/health"
    local health
    health=$(curl -fsS "$SERVER_URL/health") || die "/health unreachable"
    pretty "$health"

    local default_network
    default_network=$(json_get "$health" "default_network")
    if [[ "$default_network" != "signet" ]]; then
        die "server reports default_network=$default_network; expected signet. \
Set GHOSTKEY_DEFAULT_NETWORK=signet on the server and redeploy."
    fi

    local demo_mode
    demo_mode=$(json_get "$health" "demo_mode")
    if [[ "$demo_mode" != "True" && "$demo_mode" != "true" ]]; then
        echo "WARNING: demo_mode is off. The off-chain timer floor is 1h" >&2
        echo "         (CHECKIN_SECS=$CHECKIN_SECS will be rejected). For a" >&2
        echo "         realistic short-cycle test, set GHOSTKEY_DEMO_MODE=1." >&2
    fi
    echo
}

phase_setup() {
    require_env GHOSTKEY_SIGNET_URL
    require_env OWNER_XPUB
    require_env HEIR_XPUB
    require_env HEIR_EMAIL
    require_cmd curl
    require_cmd python3

    phase_check_server

    if [[ -e "$STATE_FILE" ]]; then
        die "$STATE_FILE already exists. This phase creates a fresh vault; \
remove the file (or set STATE_FILE=./somewhere-else.json) to continue."
    fi

    echo "=== Creating vault via POST /vaults/from-xpub"
    # Build the JSON body. We embed the heir contact as a JSON blob
    # the same way the web wizard does so the claim flow can decode
    # `name` and `channel` on the way out.
    local body
    body=$(python3 -c '
import json, os
heir_contact = json.dumps({
    "name": "Signet Heir",
    "contact": os.environ["HEIR_EMAIL"],
    "channel": "email",
})
owner = {"xpub": os.environ["OWNER_XPUB"]}
if os.environ.get("OWNER_FINGERPRINT"):
    owner["fingerprint"] = os.environ["OWNER_FINGERPRINT"]
heir = {"xpub": os.environ["HEIR_XPUB"]}
if os.environ.get("HEIR_FINGERPRINT"):
    heir["fingerprint"] = os.environ["HEIR_FINGERPRINT"]
body = {
    "label": "Signet E2E " + os.popen("date -u +%Y-%m-%dT%H:%M:%SZ").read().strip(),
    "network": "signet",
    "owner": owner,
    "heir": heir,
    "timelock_blocks": int(os.environ["TIMELOCK_BLOCKS"]),
    "checkin_period_secs": int(os.environ["CHECKIN_SECS"]),
    "grace_period_secs": int(os.environ["GRACE_SECS"]),
    "heir_contact": heir_contact,
    "heir_contact_channel": "email",
}
if os.environ.get("OWNER_EMAIL"):
    body["owner_contact"] = os.environ["OWNER_EMAIL"]
    body["owner_contact_channel"] = "email"
print(json.dumps(body))
')

    local resp
    resp=$(curl -fsS \
        -H "Content-Type: application/json" \
        -X POST \
        -d "$body" \
        "$SERVER_URL/vaults/from-xpub") || die "vault creation failed"
    pretty "$resp"

    local vault_id owner_token network
    vault_id=$(json_get "$resp" "id")
    owner_token=$(json_get "$resp" "owner_token")
    network=$(json_get "$resp" "network")
    if [[ "$network" != "signet" ]]; then
        die "vault was created with network=$network, not signet. \
Investigate before funding."
    fi

    echo
    echo "=== Fetching the funding address"
    local addr_resp
    addr_resp=$(curl -fsS \
        -H "Authorization: Bearer $owner_token" \
        "$SERVER_URL/vaults/$vault_id/address") || die "address fetch failed"
    pretty "$addr_resp"

    local addr
    addr=$(json_get "$addr_resp" "address")

    # Persist state for the observe/diagnose phases.
    python3 -c "
import json
with open('$STATE_FILE', 'w') as f:
    json.dump({
        'vault_id': '$vault_id',
        'owner_token': '$owner_token',
        'address': '$addr',
        'network': '$network',
    }, f, indent=2)
"
    chmod 600 "$STATE_FILE"

    cat <<EOF

================================================================
SETUP COMPLETE.

  Vault id    : $vault_id
  Network     : $network
  Funding addr: $addr

  State saved to $STATE_FILE (chmod 600).

NEXT STEPS (interactive, not scripted):

  1. Open a signet faucet:
       https://signet.bc-2.jp/
       https://signetfaucet.com/
       https://alt.signetfaucet.com/

  2. Paste the address above. Request a small amount (the faucet's
     minimum is usually 1000-10000 sats; that's plenty).

  3. Watch the funding tx confirm on mempool.space/signet:
       https://mempool.space/signet/address/$addr

  4. Once confirmed (1 block is fine for signet demos), run:

       ./scripts/signet_e2e.sh observe

     That phase polls the vault state until the alarm fires and
     the claim token is issued. Demo mode on the server keeps
     this short.

  5. Check your heir's email ($HEIR_EMAIL) for the claim link.
     Open it in a fresh browser tab; from there the heir flow is
     entirely browser-driven (no more script).

EOF
}

# Load state file and export vault_id + owner_token to the env so
# phase_observe / phase_diagnose can use them.
load_state() {
    [[ -e "$STATE_FILE" ]] || die "$STATE_FILE missing. Run 'setup' first."
    VAULT_ID=$(python3 -c "import json; print(json.load(open('$STATE_FILE'))['vault_id'])")
    OWNER_TOKEN=$(python3 -c "import json; print(json.load(open('$STATE_FILE'))['owner_token'])")
    ADDRESS=$(python3 -c "import json; print(json.load(open('$STATE_FILE'))['address'])")
}

phase_diagnose() {
    require_env GHOSTKEY_SIGNET_URL
    require_cmd curl
    require_cmd python3
    load_state

    echo "=== /vaults/$VAULT_ID (vault status)"
    local v
    v=$(curl -fsS \
        -H "Authorization: Bearer $OWNER_TOKEN" \
        "$SERVER_URL/vaults/$VAULT_ID") || die "vault fetch failed"
    pretty "$v"

    echo
    echo "=== /vaults/$VAULT_ID/events (event log)"
    local e
    e=$(curl -fsS \
        -H "Authorization: Bearer $OWNER_TOKEN" \
        "$SERVER_URL/vaults/$VAULT_ID/events") || die "events fetch failed"
    pretty "$e"

    echo
    echo "=== Funding address on mempool.space:"
    echo "  https://mempool.space/signet/address/$ADDRESS"
}

phase_observe() {
    require_env GHOSTKEY_SIGNET_URL
    require_cmd curl
    require_cmd python3
    load_state

    echo "Polling /vaults/$VAULT_ID every 10s. Ctrl+C to stop."
    echo "Watching for status to transition: ok -> alarmed -> timelock_started"
    echo

    local last_status=""
    while true; do
        local v status
        v=$(curl -fsS \
            -H "Authorization: Bearer $OWNER_TOKEN" \
            "$SERVER_URL/vaults/$VAULT_ID" 2>/dev/null) || {
            echo "$(date -u +%T) poll failed; retrying"
            sleep 10
            continue
        }
        status=$(json_get "$v" "status")
        if [[ "$status" != "$last_status" ]]; then
            echo "$(date -u +%T) status -> $status"
            last_status="$status"
            if [[ "$status" == "timelock_started" ]]; then
                cat <<EOF

================================================================
ALARM FIRED. Heir claim flow is now active.

The heir should have received an email at the address you set.
The link in that email looks like:

   $SERVER_URL/#/claim/<token>

Open it in a fresh browser tab and walk through the heir flow.
The vault funds are claimable from the heir keypath after
$TIMELOCK_BLOCKS signet blocks (~$((TIMELOCK_BLOCKS * 10)) minutes)
from the funding tx confirmation.

While you wait, run './scripts/signet_e2e.sh diagnose' to
inspect the vault and event log at any time.
================================================================

EOF
                exit 0
            fi
        fi
        sleep 10
    done
}

# ---- Main -------------------------------------------------------------------

usage() {
    cat <<EOF
Usage: $0 <phase>

Phases:
  setup      Create a new signet vault, print the funding address.
  observe    Poll vault state until the alarm fires.
  diagnose   One-shot snapshot of vault state + event log.

See the script header for required env vars and the runbook
(SIGNET_E2E_RUNBOOK.md) for prose context.
EOF
    exit 1
}

case "${1:-}" in
    setup)    phase_setup ;;
    observe)  phase_observe ;;
    diagnose) phase_diagnose ;;
    *)        usage ;;
esac
