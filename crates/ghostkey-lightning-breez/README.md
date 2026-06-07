# ghostkey-lightning-breez

Standalone sidecar that wraps [Breez SDK - Liquid] and exposes a small
HTTP API the main `ghostkey-server` calls to mint Lightning invoices
for owner check-ins.

[Breez SDK - Liquid]: https://github.com/breez/breez-sdk-liquid

## Why this is a separate crate

The Breez SDK pins `reqwest = "=0.12.18"` exactly, which is
incompatible with every other crate in the GhostKey workspace.
Including it as a direct dependency — even an optional one — breaks
`cargo build` on the main repo. The sidecar pattern solves this
cleanly: the Breez SDK lives entirely behind a localhost HTTP
boundary, so its dependency graph never touches `ghostkey-server`.

This is the same shape Lexe and Breez themselves use for their public
SDKs. The trade-off — one extra process to run alongside the main
server — buys a clean main workspace, independent restarts, and the
ability for contributors to clone and build GhostKey without ever
needing a Breez API key.

## Current upstream build status

As of 2026-05-26, `breez-sdk-liquid` tag `0.12.2` (the latest stable;
`0.12.3-dev1` pins the same revs) does **not** compile from a clean
checkout against the current crates.io graph. The failure is in the
transitive `boltz-client` git dependency
(`SatoshiPortal/boltz-rust@d62288f`), which references MuSig types
(`MusigPubNonce`, `MusigAggNonce`, `MusigKeyAggCache`,
`MusigSession`, `MusigTweakErr`, `MusigSignError`, `ParseError`, …)
that no longer exist in the version of `elements::secp256k1_zkp`
resolved transitively. `cargo check` from this directory currently
produces ~16 unresolved-import / type errors inside
`boltz-client`. This is upstream's bug, not ours.

We knowingly accept this for now because:

* The main `ghostkey-server` is completely insulated — it compiles,
  ships, and runs identically whether this sidecar builds or not.
  Without the sidecar URL configured, the server uses
  `NoopProvider` and the Lightning UI hides itself.
* The architectural seam (the `LightningProvider` trait + the
  `HttpProvider` HTTP client + the wire protocol documented below)
  is what we actually wanted to commit. The choice of backend
  binary is replaceable.
* Once Breez ships a tag with a `boltz-client` rev that compiles
  against current `secp256k1_zkp`, bumping the pin in this crate's
  `Cargo.toml` is a one-line change. The wire protocol does not
  move.

If you need Lightning today and don't want to wait for Breez to fix
their upstream, you can implement the same three-route HTTP surface
(see "API" below) against any backend: LND/CLN gRPC, LNbits, BTCPay,
Phoenixd, etc. The main `ghostkey-server` does not care which it is.

## API

All routes require an `Authorization: Bearer <SHARED_SECRET>` header
matching the `GHOSTKEY_LN_SIDECAR_SHARED_SECRET` env var on both sides.
The sidecar binds to `127.0.0.1` by default so it isn't reachable
from outside the host; the bearer is defence in depth.

### `GET /v1/health`
Returns `{ "ok": true, "ready": <bool> }`. `ready` is false during
the SDK warm-up window (typically the first few seconds after start).

### `POST /v1/invoice`
Body: `{ "amount_sat": 1, "description": "ghostkey:checkin:<vault-id>" }`
Returns: `{ "bolt11": "...", "payment_hash": "...", "amount_sat": 1, "expires_at": "RFC3339" }`

### `GET /v1/status/:payment_hash`
Returns: `{ "status": "pending" | "paid" | "failed", "paid_at": "RFC3339" | null }`

## Running

```bash
# From inside this directory (it's NOT a workspace member, so the
# `-p` form from the repo root will NOT find it):
cd crates/ghostkey-lightning-breez

# Required env vars (the sidecar refuses to start without these).
export BREEZ_API_KEY="..."         # free key from breez.technology
export BREEZ_MNEMONIC="word1 ..."  # 12-word BIP39 seed, this server's wallet
export GHOSTKEY_LN_SIDECAR_SHARED_SECRET=$(openssl rand -hex 32)

# Optional.
export BREEZ_NETWORK=testnet                  # mainnet | testnet (default testnet)
export BREEZ_WORKING_DIR=./breez-data         # SDK persistence directory
export GHOSTKEY_LN_BREEZ_BIND=127.0.0.1:8788  # default

cargo run --release
```

Then point the main server at it:

```bash
GHOSTKEY_LN_SIDECAR_URL=http://127.0.0.1:8788 \
GHOSTKEY_LN_SIDECAR_SHARED_SECRET=<same-secret> \
cargo run -p ghostkey-server
```

## Docker

A separate `Dockerfile` lives in this directory. It builds only this
crate, so the multi-stage build does not pull in the main GhostKey
workspace dependencies. See `DEPLOY.md` at the repo root for the
two-process Fly.io deploy pattern.

## What this does NOT do

- It does not move user funds. The only payments it handles are 1-sat
  heartbeats from owners to this server's own wallet.
- It does not custody owner Bitcoin. The vault inheritance logic
  is enforced on the Bitcoin mainnet by the GhostKey on-chain script,
  which has nothing to do with Lightning or Liquid.
- It does not require an internet-facing port. The default bind is
  `127.0.0.1:8788`. Production deploys should keep it that way and
  reach it via a private network / sidecar pattern.
