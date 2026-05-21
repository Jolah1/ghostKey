# GhostKey

> Bitcoin-native inheritance vaults. Custody never leaves the owner; the
> heir's claim is gated on the chain itself.

GhostKey is a small protocol and a reference implementation for
designating a **Bitcoin inheritor** without trusting a third party. The
owner spends normally; if they stop spending for `N` blocks, an heir
they nominated can claim the funds — and only then.

The on-chain mechanism is a single-leaf Taproot script:

```
or_d( pk(OWNER), and_v( v:pk(HEIR), older(N) ) )
```

- **Owner** can spend at any time.
- **Heir** can spend only after `N` blocks have elapsed since the UTXO
  was confirmed (BIP68 / `OP_CSV`).
- "Checking in" is the owner moving the UTXO to a freshly derived
  vault address, which resets the heir's countdown.

The keypath uses an unspendable NUMS internal key, so the only way to
spend is via one of the two explicit script paths above.

---

## Repository layout

```
crates/
  ghostkey-core/      Cryptographic core. I/O-free. Descriptors, PSBT flows.
  ghostkey-cli/       Owner/heir CLI. Talks to bitcoind RPC.
  ghostkey-server/    Watch-only notifier. Tracks check-in deadlines.
ghostkey-web/         React dashboard. Owner heartbeats; heir status.
```

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for design rationale, threat
model, and a per-layer responsibility breakdown.

---

## Quickstart (regtest)

You need:

- Rust 1.75+
- [`bitcoind`](https://bitcoincore.org/) v25 or newer on `PATH`
- Node 20+ (only for the web dashboard)

### 1. Build the workspace

```sh
cargo build --workspace
```

### 2. Create owner + heir mnemonics

```sh
./target/debug/ghostkey --profile owner init-keys
./target/debug/ghostkey --profile heir  init-keys

# Heir hands these strings to the owner:
./target/debug/ghostkey --profile heir show-xpub --network regtest
```

### 3. Build a vault on the owner's side

```sh
./target/debug/ghostkey --profile owner make-vault \
  --role owner --timelock-blocks 144 \
  --counterparty-external "[<heir-fp>/86'/1'/0']tpub.../0/*" \
  --counterparty-internal "[<heir-fp>/86'/1'/0']tpub.../1/*" \
  --label "my-vault"
```

The vault config is written to `./.ghostkey/owner/vault.json`. Build the
mirror config on the heir side with `--role heir` and the owner's
fragments.

### 4. Spin up bitcoind in regtest, fund the vault

```sh
bitcoind -regtest -rpcuser=u -rpcpassword=p -fallbackfee=0.0002 &
./target/debug/ghostkey --profile owner address --network regtest      # -> bcrt1p...
bitcoin-cli -regtest -rpcuser=u -rpcpassword=p generatetoaddress 101 <miner-addr>
bitcoin-cli -regtest -rpcuser=u -rpcpassword=p sendtoaddress <vault-addr> 0.5
```

### 5. Owner check-in / heir claim

```sh
# Owner heartbeat (resets the timelock on every UTXO).
./target/debug/ghostkey --profile owner check-in \
  --rpc-url http://127.0.0.1:18443 --rpc-user u --rpc-pass p

# After the timelock has elapsed, heir sweeps.
./target/debug/ghostkey --profile heir claim \
  --rpc-url http://127.0.0.1:18443 --rpc-user u --rpc-pass p \
  --to <heir-controlled-address>
```

### 6. (Optional) Run the notifier server

```sh
cargo run -p ghostkey-server
# -> listens on 127.0.0.1:8787, persists to ./ghostkey.sqlite
```

Register a vault (descriptors only — never keys):

```sh
curl -X POST http://127.0.0.1:8787/vaults \
  -H 'content-type: application/json' \
  -d @register.json
```

### 7. (Optional) Run the dashboard

```sh
cd ghostkey-web
npm install
npm run dev
# -> http://127.0.0.1:5173, proxies /api to the server above
```

---

## Tests

```sh
# Unit tests in all crates.
cargo test --workspace

# End-to-end on a real regtest bitcoind:
cargo test -p ghostkey-core --test regtest_e2e -- --ignored
```

The regtest e2e is `#[ignore]` so CI without `bitcoind` stays green; it
exercises the full owner-funds → check-in → early heir claim (rejected
by node as `non-BIP68-final`) → mine timelock → heir claim succeeds
flow.

---

## License

Dual-licensed under MIT or Apache-2.0 at your option.
