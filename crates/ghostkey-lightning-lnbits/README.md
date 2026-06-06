# ghostkey-lightning-lnbits

Drop-in alternative to `ghostkey-lightning-breez` that implements the
exact same three-route HTTP wire protocol the main `ghostkey-server`
calls, but backed by an [LNbits] instance instead of Breez SDK Liquid.

[LNbits]: https://lnbits.com

## Why this exists

The Breez sidecar's `breez-sdk-liquid` 0.12.2 dep does not compile
from a clean checkout as of 2026-05-26 — see the breez crate's
README, "Current upstream build status". Until Breez fixes their
transitive `boltz-client` / `secp256k1_zkp` skew, this sidecar lets
an operator get Lightning check-ins working in production today.

The main `ghostkey-server` is provider-agnostic: point its
`GHOSTKEY_LN_BREEZ_URL` env var at either sidecar and the dashboard
renders the check-in button. The env var name keeps the `BREEZ`
prefix for backwards compatibility — same wire protocol, same
shared-secret bearer, swappable backend.

## API

Identical to the Breez sidecar:

### `GET /v1/health`

`{ "ok": true, "ready": <bool>, "version": "..." }`. `ready` is
false until the first successful probe of LNbits' `/api/v1/wallet`
endpoint.

### `POST /v1/invoice`

Body: `{ "amount_sat": 1, "description": "ghostkey:checkin:<vault-id>" }`
Returns: `{ "bolt11": "...", "payment_hash": "...", "amount_sat": 1, "expires_at": "RFC3339" }`

`expires_at` is `now + 1h` because LNbits' create-invoice response
doesn't include the BOLT11 expiry timestamp directly and we ask
for `expiry=3600`. The main server treats `expires_at` as advisory.

### `GET /v1/status/:payment_hash`

Returns: `{ "status": "pending" | "paid" | "failed", "paid_at": "RFC3339" | null }`.

`paid_at` is sourced from LNbits' `time` field; the sidecar coerces
seconds vs. milliseconds defensively so it works across LNbits
versions.

All routes (except `/v1/health`) require
`Authorization: Bearer <SHARED_SECRET>` matching
`GHOSTKEY_LN_BREEZ_SHARED_SECRET` on both sides. Constant-time
compare.

## Running

```bash
# From inside this directory (the crate is workspace-excluded; the
# -p form from the repo root will NOT find it):
cd crates/ghostkey-lightning-lnbits

# Required env vars (the sidecar refuses to start without these).
export LNBITS_URL="https://lnbits.example.com"      # your instance
export LNBITS_INVOICE_KEY="..."                     # invoice key (read+receive)
export GHOSTKEY_LN_BREEZ_SHARED_SECRET=$(openssl rand -hex 32)

# Optional.
export GHOSTKEY_LN_LNBITS_BIND=127.0.0.1:8788       # default
export LNBITS_TIMEOUT_SECS=15                       # default

cargo run --release
```

Then point the main server at it:

```bash
GHOSTKEY_LN_BREEZ_URL=http://127.0.0.1:8788 \
GHOSTKEY_LN_BREEZ_SHARED_SECRET=<same-secret> \
cargo run -p ghostkey-server
```

`curl http://127.0.0.1:8787/health | jq .lightning_enabled` should
return `true` once both sides see each other.

## LNbits setup

You need an LNbits instance with:

- A funded wallet (any amount is fine; this sidecar only ever
  *receives*).
- The **invoice key** for that wallet. Do not pass the admin key —
  this sidecar never sends, so the lower-privilege key is correct.

Three ways to get an LNbits instance, in order of operational
complexity:

1. **Self-host the official Docker image** — recommended for prod.
   See <https://docs.lnbits.org/guide/installation.html>.
2. **Use a managed LNbits provider** (e.g. <https://my.lnbits.com>).
   Convenient, but introduces a third-party dependency.
3. **Public demo instance** (`legend.lnbits.com`). Fine for
   testing on signet/testnet; never depend on it for production.

The LNbits instance is the actual Lightning node; this sidecar is
just a translator. Back up the LNbits wallet exactly as you would
back up any other Lightning wallet.

## Docker

A separate `Dockerfile` lives in this directory. It only builds
this crate; the multi-stage build does not pull in the main GhostKey
workspace dependencies. See `DEPLOY.md` at the repo root for the
two-process Fly.io deploy pattern.

## What this does NOT do

- Does not move user funds. The only payments it observes are 1-sat
  heartbeats from owners to the LNbits wallet.
- Does not custody owner Bitcoin. The vault inheritance logic is
  enforced on the Bitcoin mainnet by the GhostKey on-chain script,
  which has nothing to do with Lightning.
- Does not need internet-facing ports. Default bind is
  `127.0.0.1:8788`. Production deploys should keep it that way and
  reach it via a private network / sidecar pattern.
- Does not need an admin key. Reception only; the invoice key is
  sufficient.
