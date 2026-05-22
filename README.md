# GhostKey

> **Bitcoin savings your family can inherit — no lawyer needed.**

GhostKey lets you set aside Bitcoin for the people you love. Every so
often (you choose how often) you tap a button to say you're still
around. If you ever stop tapping, the people you nominated can claim
the money on their own — automatically, without anyone's permission.

The rules live on Bitcoin itself, not on our website. Even if this
project disappeared tomorrow, your family's promise is still safe.

---

## For families

### What it does

- **You put aside Bitcoin** in a special savings account.
- **You pick who would inherit** — usually a partner, child, or sibling.
- **You tap "I'm OK" on a schedule you set.** Could be every week,
  every month, every quarter. Whatever feels right.
- **If you ever stop tapping**, a waiting period begins. When it ends,
  the people you named can claim the money themselves through a
  one-time link we send them.
- **You can change your mind any time.** While you're tapping, you
  have complete control. You can move the money, change who inherits,
  or close the vault.

### What you need

- A Bitcoin wallet (you probably have one already — anything that
  can show you an "xpub" works; Sparrow, BlueWallet, Specter,
  Coldcard).
- About 10 minutes to set up the first time.
- One tap, on the schedule you chose, after that.

### What it costs

- The software is free and open-source.
- When you set up the vault and when the inheritance is eventually
  claimed, you pay whatever the Bitcoin network charges to send a
  transaction. Roughly the cost of a postage stamp.
- Tapping "I'm OK" on our website is free.

### What we **don't** do

- We don't hold your money. Ever.
- We don't see your password or your seed phrase.
- We can't change your inheritance setup.
- We can't stop you from changing your mind.
- We can't unlock the money for your heir before the waiting period
  ends, even if we wanted to. The Bitcoin network enforces the wait,
  not us.
- This is **not a legal will** — it's a programmable way to leave
  Bitcoin to family. Most people use it alongside a regular will.

### Try it out without real money

Before you put real Bitcoin in, you can practice with fake "regtest"
or "testnet" Bitcoin. Same buttons, zero risk. See the developer
section below for setup, or ask the person who built this for you to
walk you through it.

---

## For developers

GhostKey is a small Bitcoin protocol implemented in Rust, plus a
React dashboard. The on-chain mechanism is a single-leaf Taproot
output:

```
or_d( pk(OWNER), and_v( v:pk(HEIR), older(N) ) )
```

- **Owner** can spend at any time.
- **Heir** can spend only after `N` blocks have elapsed since the
  UTXO was confirmed (BIP68 / `OP_CSV`).
- "Checking in" on the website is a server-side timer reset. There's
  also an optional on-chain check-in (the owner moving the UTXO to a
  freshly derived vault address) that resets the heir's countdown for
  real.

The keypath uses an unspendable NUMS internal key, so the only way to
spend is via one of the two explicit script paths.

### Where to read next

- [`DESIGN.md`](./DESIGN.md) — long-form, plain-English design doc.
  Why each piece exists, the threat model, where AI could fit, and
  what we'd build next. **Read this first if you're new.**
- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — dense technical reference.
  Per-layer breakdown, script details, threat model table. For
  someone who's already comfortable with Bitcoin script and Rust.
- [`JOURNAL.md`](./JOURNAL.md) — chronological log of what shipped
  when and why. Useful when you want to understand a piece of code
  that doesn't make sense in isolation.
- [`DEPLOY.md`](./DEPLOY.md) — how to put the server and the web
  dashboard online.

### Repo layout

```
crates/
  ghostkey-core/      Cryptographic core. I/O-free. Descriptors, PSBTs,
                      BDK wallet construction. The piece that has to
                      remain exactly correct.
  ghostkey-cli/       Owner/heir CLI. Holds keys. Talks to bitcoind RPC.
                      Generates seeds, signs check-ins and claims.
  ghostkey-server/    Watch-only notifier. Holds NO keys. Tracks
                      check-in deadlines, encrypts heir contacts at
                      rest, issues one-time claim tokens, builds and
                      broadcasts heir-claim PSBTs.
ghostkey-web/         React dashboard. Vite + TypeScript + Tailwind.
                      Talks to the server's REST API only.
```

### Prerequisites

- Rust 1.85+
- [`bitcoind`](https://bitcoincore.org/) v25 or newer on `PATH`
  (only needed for the CLI's on-chain operations and the regtest
  integration test).
- Node 20+ (only for the web dashboard).

### Build everything

```sh
cargo build --workspace
cd ghostkey-web && npm install && cd ..
```

### Quickstart on regtest

This is the fastest way to see the whole system end to end. It uses
fake Bitcoin so you can experiment without risk.

```sh
# 1. Mnemonics + vault construction (CLI, two profiles for owner/heir)
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

# 3. Owner check-in (on-chain) and heir claim
./target/debug/ghostkey --profile owner check-in \
  --rpc-url http://127.0.0.1:18443 --rpc-user u --rpc-pass p
./target/debug/ghostkey --profile heir claim \
  --rpc-url http://127.0.0.1:18443 --rpc-user u --rpc-pass p \
  --to <heir-controlled-address>
```

### Run the notifier server + dashboard

The notifier server is needed for the web dashboard's check-in flow
(server-side timer reset, no on-chain transaction) and for the
heir's claim page (which needs a server to do chain scanning and to
broadcast the heir's signed PSBT).

```sh
# 1. Pick a 32-byte master key. This encrypts heir contacts at rest.
#    Do NOT lose it; it cannot be recovered. Keep it out of git.
export GHOSTKEY_MASTER_KEY="$(openssl rand -base64 32)"

# 2. Notifier server (watch-only; persists to ./ghostkey.sqlite)
cargo run -p ghostkey-server
# -> listens on 127.0.0.1:8787

# 3. Dashboard (proxies /api -> the server above)
cd ghostkey-web
npm run dev
# -> http://127.0.0.1:5173
```

Open the dashboard in your browser. The setup wizard walks you
through creating a vault using two xpubs (yours and your heir's).

### Register a vault from the command line

Most people will use the dashboard's setup wizard. If you'd rather
register a vault directly:

```sh
curl -X POST http://127.0.0.1:8787/vaults/from-xpub \
  -H 'content-type: application/json' \
  -d '{
    "label": "Family rainy day fund",
    "network": "regtest",
    "owner": {"xpub": "[<owner-fp>/86'\''/1'\''/0'\'']tpub..."},
    "heir":  {"xpub": "[<heir-fp>/86'\''/1'\''/0'\'']tpub..."},
    "timelock_blocks": 144,
    "checkin_period_secs": 86400,
    "grace_period_secs": 3600,
    "heir_contact": "{\"name\":\"Ben\",\"contact\":\"+234...\",\"channel\":\"whatsapp\"}",
    "heir_contact_channel": "whatsapp"
  }'
```

### The heir's flow

When the owner stops checking in, the server eventually decides
it's time to reach the heir. The flow:

1. The scheduler detects an `alarmed` vault past its eligibility
   window, generates a one-time token, transitions the vault to
   `timelock_started`, and writes the raw token into an event
   row. (See the "left for later" notes — automatic notification
   delivery is the next big piece of operational work.)
2. The token (or, with notifier delivery wired up, a link
   containing the token) reaches the heir via the channel the
   owner chose: SMS, email, or WhatsApp.
3. The heir opens `https://your-instance/#claim/<token>` and sees
   the claim page. The page is calm, family-friendly, and walks
   them through:
   - making sure they have a PSBT-capable wallet (Sparrow on
     desktop is the easiest);
   - pasting the destination address;
   - clicking "Prepare transaction" — server scans the chain and
     returns an unsigned PSBT;
   - copying the PSBT into their wallet, signing it offline,
     pasting the signed result back;
   - clicking "Broadcast transaction" — server finalises and
     broadcasts.
4. The heir gets a txid and a mempool.space link to watch the
   transaction confirm.

The server never sees the heir's signing key. It just does the
chain scanning, PSBT plumbing, and broadcast.

### Tests

```sh
# Unit tests in all crates.
cargo test --workspace

# End-to-end against a real regtest bitcoind. The test spawns and
# tears down its own bitcoind in a tempdir. ~5 s.
cargo test -p ghostkey-core --test regtest_e2e -- --ignored

# Web type-check + production bundle.
cd ghostkey-web && npm run typecheck && npm run build
```

The regtest e2e is `#[ignore]` so CI without `bitcoind` stays green.
It exercises the full owner-funds → check-in → early heir claim
(rejected by node as `non-BIP68-final`) → mine timelock → heir
claim succeeds flow.

### What's deliberately *not* here yet

The full list and reasoning lives in
[`DESIGN.md`](./DESIGN.md) § 9. Highlights:

- **Live signet smoke test of the heir claim pipeline.** The PSBT
  build + sign + broadcast flow compiles and passes unit tests,
  but nobody has driven it against a live signet node end-to-end
  with a real heir wallet. This needs to happen before mainnet.
- **Automatic notification delivery.** Today the raw claim token
  gets written to an event row; an operator delivers it by hand.
  Email / SMS / WhatsApp fan-out is the next big operational
  feature.
- **Cold signing for owner check-ins.** The CLI signs in-process.
  Hardware-wallet workflows are documented but not implemented.
- **k-of-n heirs.** The descriptor builder hard-codes one heir.
- **AI-assisted error explainers on the heir page.** Proposed as
  Option A in [`DESIGN.md`](./DESIGN.md) § 8.

### License

Dual-licensed under MIT or Apache-2.0 at your option.
