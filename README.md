# GhostKey

> **Bitcoin savings your family can inherit — no lawyer needed.**

GhostKey lets you set aside Bitcoin for the people you love. Once a week (or however often you choose) you tap a button to say you're still around. If you ever stop tapping, the people you nominated can claim the money on their own — automatically, without anyone's permission.

The rules live on Bitcoin itself, not on our website. Even if this project disappeared tomorrow, your family's promise is still safe.

---

## For families

### What it does

- **You put aside Bitcoin** in a special savings account.
- **You pick who would inherit** — usually a partner, child, or sibling.
- **Once a week, you tap "I'm OK."** That's all.
- **If you ever stop tapping**, a waiting period begins. When it ends, the people you named can claim the money themselves.
- **You can change your mind any time.** While you're tapping, you have complete control.

### What you need

- A computer with Bitcoin Core installed (we'll help you get this).
- About 10 minutes to set up the first time.
- One tap, once a week, after that.

### What it costs

- The software is free and open-source.
- Whatever the Bitcoin network charges to send a transaction. Roughly the cost of a postage stamp.

### What we **don't** do

- We don't hold your money. Ever.
- We don't see your password.
- We can't change your inheritance setup.
- We can't stop you from changing your mind.
- This is **not a legal will** — it's a programmable way to leave Bitcoin to family. Most people use it alongside a regular will.

### Try it out without real money

Before you put real Bitcoin in, you can practice with fake "regtest" or "testnet" Bitcoin. Same buttons, zero risk. See the developer section below for setup, or ask the person who built this for you to walk you through it.

---

## For developers

GhostKey is a small Bitcoin protocol implemented in Rust + a React dashboard. The on-chain mechanism is a single-leaf Taproot output:

```
or_d( pk(OWNER), and_v( v:pk(HEIR), older(N) ) )
```

- **Owner** can spend at any time.
- **Heir** can spend only after `N` blocks have elapsed since the UTXO was confirmed (BIP68 / `OP_CSV`).
- "Checking in" is the owner moving the UTXO to a freshly derived vault address, which resets the heir's countdown.

The keypath uses an unspendable NUMS internal key, so the only way to spend is via one of the two explicit script paths.

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the threat model, full per-layer breakdown, and design rationale.

### Repo layout

```
crates/
  ghostkey-core/      Cryptographic core. I/O-free. Descriptors, PSBT flows.
  ghostkey-cli/       Owner/heir CLI. Talks to bitcoind RPC.
  ghostkey-server/    Watch-only notifier. Tracks check-in deadlines.
ghostkey-web/         React dashboard. Vite + TypeScript + Tailwind + lucide.
```

### Prerequisites

- Rust 1.75+
- [`bitcoind`](https://bitcoincore.org/) v25 or newer on `PATH`
- Node 20+ (only for the web dashboard)

### Build everything

```sh
cargo build --workspace
cd ghostkey-web && npm install && cd ..
```

### Quickstart (regtest)

```sh
# 1. Mnemonics + vault construction (CLI)
./target/debug/ghostkey --profile owner init-keys
./target/debug/ghostkey --profile heir  init-keys
./target/debug/ghostkey --profile heir  show-xpub --network regtest

./target/debug/ghostkey --profile owner make-vault \
  --role owner --timelock-blocks 144 \
  --counterparty-external "[<heir-fp>/86'/1'/0']tpub.../0/*" \
  --counterparty-internal "[<heir-fp>/86'/1'/0']tpub.../1/*" \
  --label "my-vault"

# 2. Fund the vault (separate terminal: `bitcoind -regtest ...`)
./target/debug/ghostkey --profile owner address --network regtest
bitcoin-cli -regtest -rpcuser=u -rpcpassword=p generatetoaddress 101 <miner-addr>
bitcoin-cli -regtest -rpcuser=u -rpcpassword=p sendtoaddress <vault-addr> 0.5

# 3. Check in / claim
./target/debug/ghostkey --profile owner check-in \
  --rpc-url http://127.0.0.1:18443 --rpc-user u --rpc-pass p
./target/debug/ghostkey --profile heir claim \
  --rpc-url http://127.0.0.1:18443 --rpc-user u --rpc-pass p \
  --to <heir-controlled-address>
```

### Run the notifier server + dashboard

```sh
# Notifier server (watch-only; persists to ./ghostkey.sqlite)
cargo run -p ghostkey-server
# -> listens on 127.0.0.1:8787

# Dashboard (proxies /api -> the server above)
cd ghostkey-web
npm run dev
# -> http://127.0.0.1:5173
```

Register a vault with the dashboard's wizard (paste `descriptor_external` and `descriptor_internal` from your `vault.json`), or via curl:

```sh
curl -X POST http://127.0.0.1:8787/vaults \
  -H 'content-type: application/json' \
  -d '{
    "label": "Family rainy day fund",
    "network": "regtest",
    "descriptor_external": "tr(...)",
    "descriptor_internal": "tr(...)",
    "timelock_blocks": 144,
    "checkin_period_secs": 86400,
    "grace_period_secs": 3600
  }'
```

### Tests

```sh
# Unit tests in all crates.
cargo test --workspace

# End-to-end against a real regtest bitcoind. The test spawns and tears
# down its own bitcoind in a tempdir. ~5 s.
cargo test -p ghostkey-core --test regtest_e2e -- --ignored

# Web type-check + production bundle.
cd ghostkey-web && npm run typecheck && npm run build
```

The regtest e2e is `#[ignore]` so CI without `bitcoind` stays green. It exercises the full owner-funds → check-in → early heir claim (rejected by node as `non-BIP68-final`) → mine timelock → heir claim succeeds flow.

### What's deliberately *not* here yet

- **Cold signing.** CLI signs in-process today; future versions should export PSBTs for offline signers.
- **Notifier fan-out.** The server records `alarm` events but doesn't yet email/webhook anyone.
- **k-of-n heirs.** The descriptor builder hard-codes one heir.
- **Mainnet checklist.** Treat this as alpha. The on-chain part is sound and tested; the operational pieces aren't yet.

### License

Dual-licensed under MIT or Apache-2.0 at your option.
