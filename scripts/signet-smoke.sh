#!/usr/bin/env bash
#
# scripts/signet-smoke.sh
#
# Nightly smoke check against the deployed signet staging app. Exercises
# the owner-facing surface (vault create, check-in, events, cleanup)
# without touching the on-chain claim flow — broadcasting a real claim
# transaction needs faucet funds and waits 1-2 signet blocks, neither
# of which fits a daily cron loop. The weekly manual walk of
# SIGNET_E2E_RUNBOOK.md is what covers the on-chain side.
#
# Required env vars (set as GitHub Actions secrets):
#
#   GHOSTKEY_SIGNET_URL          e.g. https://ghostkey-signet.fly.dev
#   SIGNET_OWNER_XPUB            Taproot (BIP86) tpub for the owner
#   SIGNET_OWNER_FINGERPRINT     8-hex-char master fingerprint
#   SIGNET_HEIR_XPUB             Taproot (BIP86) tpub for the heir
#   SIGNET_HEIR_FINGERPRINT      8-hex-char master fingerprint
#
# Optional:
#   SIGNET_NIGHTLY_LABEL_PREFIX  default "ci-smoke" — labels the vault
#                                so a human reviewer can tell smoke
#                                vaults apart from real ones.
#
# Exits 0 on success, 1 on any failed assertion. Prints PASS / FAIL on
# every step so the GitHub Actions log is self-explaining.

set -euo pipefail

# ----- helpers ------------------------------------------------------

REQUIRE_VAR() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    echo "FAIL: required env var $name is unset" >&2
    exit 1
  fi
}

pass() { echo "PASS: $*"; }
fail() { echo "FAIL: $*" >&2; exit 1; }

# Wrap curl so any non-2xx response is surfaced loudly with the body.
# Usage: hcurl <method> <path> [<body>]
hcurl() {
  local method="$1"
  local path="$2"
  local body="${3:-}"
  local url="${GHOSTKEY_SIGNET_URL}${path}"
  local tmp
  tmp="$(mktemp)"
  local code
  if [[ -n "$body" ]]; then
    code=$(curl -sS -o "$tmp" -w "%{http_code}" \
      -X "$method" "$url" \
      -H "Content-Type: application/json" \
      ${OWNER_TOKEN:+-H "Authorization: Bearer ${OWNER_TOKEN}"} \
      --data "$body")
  else
    code=$(curl -sS -o "$tmp" -w "%{http_code}" \
      -X "$method" "$url" \
      ${OWNER_TOKEN:+-H "Authorization: Bearer ${OWNER_TOKEN}"})
  fi
  if [[ "$code" -ge 200 && "$code" -lt 300 ]]; then
    cat "$tmp"
    rm -f "$tmp"
    return 0
  fi
  echo "FAIL: $method $path returned HTTP $code" >&2
  cat "$tmp" >&2
  rm -f "$tmp"
  exit 1
}

# ----- preflight ----------------------------------------------------

REQUIRE_VAR GHOSTKEY_SIGNET_URL
REQUIRE_VAR SIGNET_OWNER_XPUB
REQUIRE_VAR SIGNET_OWNER_FINGERPRINT
REQUIRE_VAR SIGNET_HEIR_XPUB
REQUIRE_VAR SIGNET_HEIR_FINGERPRINT

LABEL_PREFIX="${SIGNET_NIGHTLY_LABEL_PREFIX:-ci-smoke}"
LABEL="${LABEL_PREFIX}-$(date -u +%Y%m%dT%H%M%SZ)"

# ----- 1. /health ---------------------------------------------------

health_body="$(hcurl GET /health)"
echo "$health_body" | jq -e '.ok == true' >/dev/null \
  || fail "/health did not return ok:true (body: $health_body)"
default_network="$(echo "$health_body" | jq -r '.default_network // empty')"
if [[ "$default_network" != "signet" ]]; then
  fail "/health.default_network is '$default_network', expected 'signet'"
fi
pass "/health ok, default_network=signet"

# ----- 2. POST /vaults/from-xpub ------------------------------------

# Demo-mode-friendly cadence so the server accepts seconds-scale values
# without complaining. The signet staging app runs with
# GHOSTKEY_DEMO_MODE=1; see SIGNET_E2E_RUNBOOK.md.
create_body=$(cat <<JSON
{
  "label": "$LABEL",
  "network": "signet",
  "owner": {
    "xpub": "$SIGNET_OWNER_XPUB",
    "fingerprint": "$SIGNET_OWNER_FINGERPRINT"
  },
  "heir": {
    "xpub": "$SIGNET_HEIR_XPUB",
    "fingerprint": "$SIGNET_HEIR_FINGERPRINT"
  },
  "timelock_blocks": 6,
  "checkin_period_secs": 60,
  "grace_period_secs": 30
}
JSON
)

created="$(hcurl POST /vaults/from-xpub "$create_body")"
VAULT_ID="$(echo "$created" | jq -r '.id')"
OWNER_TOKEN="$(echo "$created" | jq -r '.owner_token')"

if [[ -z "$VAULT_ID" || "$VAULT_ID" == "null" ]]; then
  fail "create_vault did not return an id (body: $created)"
fi
if [[ -z "$OWNER_TOKEN" || "$OWNER_TOKEN" == "null" ]]; then
  fail "create_vault did not return owner_token (body: $created)"
fi
pass "POST /vaults/from-xpub created $VAULT_ID"

# ----- 3. POST /vaults/:id/checkin ----------------------------------

hcurl POST "/vaults/${VAULT_ID}/checkin" '{}' >/dev/null
pass "POST /vaults/:id/checkin accepted"

# ----- 4. GET /vaults/:id/events ------------------------------------

events="$(hcurl GET "/vaults/${VAULT_ID}/events")"
has_register="$(echo "$events" | jq '[.[] | select(.kind == "registered")] | length')"
has_checkin="$(echo "$events" | jq '[.[] | select(.kind == "checkin")] | length')"

if [[ "$has_register" -lt 1 ]]; then
  fail "events log missing 'registered' (body: $events)"
fi
if [[ "$has_checkin" -lt 1 ]]; then
  fail "events log missing 'checkin' (body: $events)"
fi
pass "events log contains registered + checkin"

# ----- 5. DELETE /vaults/:id (cleanup) ------------------------------

hcurl DELETE "/vaults/${VAULT_ID}" >/dev/null
pass "DELETE /vaults/:id (cleanup)"

# Verify it's actually gone.
gone_code=$(curl -sS -o /dev/null -w "%{http_code}" \
  -H "Authorization: Bearer ${OWNER_TOKEN}" \
  "${GHOSTKEY_SIGNET_URL}/vaults/${VAULT_ID}")
if [[ "$gone_code" != "404" ]]; then
  fail "vault $VAULT_ID still resolvable after DELETE (HTTP $gone_code)"
fi
pass "vault $VAULT_ID confirmed deleted"

echo
echo "ALL OK — signet smoke succeeded against $GHOSTKEY_SIGNET_URL"
