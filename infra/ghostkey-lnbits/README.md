# ghostkey-lnbits — self-hosted Lightning backend for check-ins

A Fly app that runs **phoenixd** (Acinq's headless Lightning node) +
**LNbits** (invoice/API layer) side-by-side in one container, behind
a single Fly volume. The `ghostkey-lightning-lnbits` sidecar in
`crates/ghostkey-lightning-lnbits/` consumes LNbits's API over the
Fly 6PN private network.

This is the "operator runs their own Lightning node" deploy path. It
keeps no third-party in the trust chain for owner heartbeat payments.

## Non-custodial property

This app does **not** hold owner vault funds. Owner vault funds are
locked by the on-chain Taproot inheritance script and are spendable
by the owner (anytime) or the heir (after timelock) without any
GhostKey signature. If this Fly app dies, every vault remains
fully spendable on L1.

What this app *does* hold:

- 1-sat heartbeat payments accumulated from owners checking in.
  These are operator revenue, not assets held in trust.
- A 12-word BIP39 seed for the phoenixd Lightning wallet (stored in
  `/data/phoenix/seed.dat`). Back this up — it's the recovery
  secret for the accumulated heartbeat balance.

## First-time setup

### 1. Provision the Fly app + volume

```sh
fly apps create ghostkey-lnbits --org personal
fly volumes create lnbits_data --region ams --size 1 -a ghostkey-lnbits
```

Region must match the main `ghostkey` app (currently `ams`).

### 2. Build + deploy

From the repo root:

```sh
fly deploy --config infra/ghostkey-lnbits/fly.toml \
           --dockerfile infra/ghostkey-lnbits/Dockerfile
```

First boot takes ~60s: phoenixd generates a seed, derives the
on-chain wallet, and does the LSP handshake with Acinq.

### 3. Back up the phoenixd seed (DO THIS BEFORE FUNDING)

```sh
fly ssh console -a ghostkey-lnbits -C "cat /data/phoenix/seed.dat"
```

Write the 12 words on paper. Store them like any other Bitcoin
seed. Without them, you cannot recover the channel balance if the
Fly volume is lost.

### 4. Fund the on-chain wallet (one-time bootstrap)

Phoenixd uses Acinq's LSP for liquidity. The very first inbound
payment triggers a "splice-in" where Acinq opens a channel and
charges a service fee (typically a few thousand sats minimum).
A 1-sat heartbeat cannot cover that fee — so we bootstrap by
sending BTC to phoenixd's on-chain deposit address, which phoenixd
then auto-uses to open the initial channel.

Get the deposit address:

```sh
fly ssh console -a ghostkey-lnbits -C \
  "phoenix-cli --http-password \"\$(grep ^http-password= /data/phoenix/phoenix.conf | cut -d= -f2-)\" getnewaddress"
```

Send ~$15-30 of BTC to that address. The exact amount sets your
initial inbound + outbound channel capacity; $20 is comfortable
for the heartbeat workload and absorbs Acinq's channel-open fee.

After ~1 confirmation, phoenixd auto-splices and the channel is
ready. Verify:

```sh
fly ssh console -a ghostkey-lnbits -C \
  "phoenix-cli --http-password \"\$(grep ^http-password= /data/phoenix/phoenix.conf | cut -d= -f2-)\" listchannels"
```

Look for a channel in state `Normal`.

### 5. Grab the LNbits invoice key

LNbits auto-creates a default admin wallet on first boot. Fetch the
**invoice key** (NOT the admin key — the sidecar only ever receives):

```sh
fly ssh console -a ghostkey-lnbits -C \
  "sqlite3 /data/lnbits/database.sqlite3 'SELECT inkey FROM accounts LIMIT 1;'"
```

(LNbits also has a web UI on the LNbits port, but it's only
reachable over Fly 6PN. Easiest path is the SQL query above.)

### 6. Wire the sidecar

Deploy the `ghostkey-lightning-lnbits` sidecar (see
`crates/ghostkey-lightning-lnbits/README.md`), pointing it at this
LNbits over 6PN:

```sh
SHARED_SECRET="$(openssl rand -hex 32)"

fly secrets set \
  LNBITS_URL="http://ghostkey-lnbits.internal:5000" \
  LNBITS_INVOICE_KEY="<the inkey from step 5>" \
  GHOSTKEY_LN_SIDECAR_SHARED_SECRET="$SHARED_SECRET" \
  -a ghostkey-lightning-lnbits

fly deploy --config crates/ghostkey-lightning-lnbits/fly.toml \
           --dockerfile crates/ghostkey-lightning-lnbits/Dockerfile

fly secrets set \
  GHOSTKEY_LN_SIDECAR_URL="http://ghostkey-lightning-lnbits.internal:8788" \
  GHOSTKEY_LN_SIDECAR_SHARED_SECRET="$SHARED_SECRET" \
  -a ghostkey
```

### 7. Verify end-to-end

```sh
curl -s https://ghostkey.fly.dev/health | jq .lightning_enabled
# → true

curl -s https://ghostkey.fly.dev/health/lightning
# → {"enabled":true,"ready":true}
```

The dashboard Lightning badge at <https://www.ghostkeyapp.com/> will
turn green within 30s (the badge polls `/health/lightning` on that
interval).

## Ongoing operation

- **Channel close fees.** If/when this Fly app is decommissioned, do
  a clean phoenixd shutdown and `closechannel` the channel to sweep
  the accumulated heartbeats back on-chain. Closes pay a mining fee.
- **Withdrawals.** To sweep accumulated heartbeat sats:
  ```sh
  fly ssh console -a ghostkey-lnbits -C \
    "phoenix-cli --http-password \"\$(grep ^http-password= /data/phoenix/phoenix.conf | cut -d= -f2-)\" sendtoaddress <addr> <sat>"
  ```
- **Upgrades.** Bump `PHOENIXD_VERSION` in the Dockerfile and
  redeploy. Phoenixd is wire-format compatible within a minor; back
  up the seed before any major-version bump.
- **Volume snapshots.** Fly auto-snapshots the volume daily for 5
  days. For longer retention, `fly volumes snapshots create` weekly.

## What if Fly goes down?

- The main `ghostkey` app's `/health` flips `lightning_enabled` to
  `false` (because the sidecar can't reach this LNbits).
- The dashboard Lightning badge hides itself.
- Owners use the regular HTTP check-in path
  (`POST /vaults/:id/checkin`) instead.
- Vault funds remain spendable on L1 regardless. Non-custodial
  property holds.
