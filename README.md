# GhostKey

> A dead-man switch for self-custodied Bitcoin.

GhostKey is an open-source tool that helps people who hold their own Bitcoin pass it on to a chosen heir if they ever stop checking in. You keep your keys. We watch your address and run the clock.

The mechanism is one Taproot output with two spend paths. The owner can spend at any time. The heir can spend only after a chosen number of blocks have passed without a check-in. Even if GhostKey shut down, the on-chain script still works — anyone holding the pre-built transaction can broadcast it once the timelock expires.

**Status: alpha, testnet only.** Code is open. Cryptography is tested end-to-end. Operational pieces (notification delivery, mainnet review, backups) are still being built. Don't use this with mainnet funds yet.

---

## How it works for the owner

1. Paste your wallet's extended public key (xpub) into the wizard at [ghostkeyapp.vercel.app](https://ghostkeyapp.vercel.app).
2. Add the heir's email and a friendly name.
3. Pick how many months to wait before the heir can claim.
4. Open the site once a month and tap "I'm still here". That's the whole job.

If you ever stop, a countdown starts. When it ends, the heir gets one email containing a one-time link. They open it in any browser, paste their own Bitcoin address, and the server hands them a pre-built transaction to sign with their own wallet. No account, no app, no GhostKey custody at any point.

---

## What GhostKey is not

- **Not a wallet.** You bring your own — Sparrow, BlueWallet, Cake, Coldcard, anything that can export an xpub.
- **Not a custodian.** The server never holds keys and never holds the heir's signed transaction. It holds a watch-only descriptor and a record of your check-ins.
- **Not a savings product.** Don't move sats here looking for yield. We don't have any. Bring sats you already own and want to pass on.
- **Not a will.** GhostKey covers one thing: on-chain Bitcoin. Everything else — fiat, property, custody of children, debts — needs a regular will written by a regular lawyer.
- **Not useful for sats held on Blink, Yellow Card, Binance, or any exchange.** Those balances belong to the exchange, not to you. GhostKey cannot reach them. If you want those sats to be inheritable, you have to move them to a Bitcoin address you control first.

---

## Why this exists

Most Bitcoin inheritance tooling assumes you can run a full node and read a Miniscript policy. Most users can't, and shouldn't have to. GhostKey is an attempt to package one specific inheritance pattern — owner-or-(heir+timelock) — as something an ordinary person can set up in five minutes from a phone, with no custodial trust required.

It is not the only way to solve this. Multisig with a lawyer holding a key works too, when the lawyer is reachable and trustworthy. A Casa or Unchained vault works too, at their price point. GhostKey is for the case where you want a simple, free, self-custodial fallback that doesn't depend on any specific company existing in 20 years.

---

## How the on-chain script works

A single Taproot output with two leaves:

```
or_d( pk(OWNER), and_v( v:pk(HEIR), older(N) ) )
```

- Owner path: spendable at any time with the owner key.
- Heir path: spendable only after `N` blocks have passed since the UTXO was confirmed (BIP68 / OP_CSV).
- The Taproot internal key is an unspendable NUMS point; there is no hidden keypath spend.

Checking in moves the UTXO to a fresh vault address, which resets the BIP68 timer. The web "I'm still here" tap is a server-side check-in that does *not* touch the chain — it only resets the alarm clock. For real on-chain inheritance you need to occasionally re-vault on-chain too; the CLI does this.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the threat model.

---

## Running it locally

### Prerequisites

- Rust 1.85 or newer
- Node 20 or newer (for the web app)
- For mainnet: an Esplora indexer you control (the server refuses to default to a public host for mainnet, since that would leak every vault's descriptors to a third party)

### Build and run

```bash
cargo build --workspace
cd ghostkey-web && npm install && npm run build && cd ..

# In one terminal: the server
GHOSTKEY_MASTER_KEY=$(openssl rand -base64 32) cargo run -p ghostkey-server

# In another: the web app
cd ghostkey-web && npm run dev
```

The server listens on `127.0.0.1:8787`, the web app on `127.0.0.1:5173`.

### Tests

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings -A clippy::type_complexity
cargo test --workspace --locked

# Regtest end-to-end (spawns a real bitcoind, ~5s). Not in CI.
cargo test -p ghostkey-core --test regtest_e2e -- --ignored

# Frontend
cd ghostkey-web && npm run typecheck && npm run build
```

### Repository layout

```
crates/
  ghostkey-core/     Bitcoin logic. I/O-free. Descriptors, PSBTs, BIP68 timelocks.
  ghostkey-cli/      Owner and heir CLI. Talks to Esplora or a local bitcoind.
  ghostkey-server/   Axum server. Vault registry, scheduler, notifier, claim PSBT broker.
ghostkey-web/        React + Vite dashboard.
```

---

## What works today

- Taproot vault descriptor build with owner/heir xpubs and a chosen timelock.
- Owner check-in (server-side proof of life).
- Scheduler that transitions vaults through `ok → alarmed → timelock_started` as deadlines pass.
- One-time claim tokens, SHA-256-hashed at rest, single-use.
- Per-vault owner-token bearer auth on mutation endpoints.
- Encrypted-at-rest heir contact info (ChaCha20-Poly1305 + per-vault HKDF).
- Heir claim flow end-to-end on testnet: open the link, paste destination address, sign the PSBT in your own wallet, broadcast via the server.
- Email notification delivery when the alarm fires (lettre + STARTTLS). Disabled-soft if SMTP is unset.

## What does not work yet

- SMS and WhatsApp delivery channels.
- Owner check-in reminders.
- Multiple heirs (k-of-n).
- Setup from a bare address instead of an xpub.
- Lightning check-ins.
- Hardware-wallet PSBT export from the CLI.
- Mainnet security review.
- Translations.

---

## Contributing

This is a one-person project. PRs welcome on anything in the "does not work yet" list above, plus bug fixes, accessibility improvements, and translations. See [CONTRIBUTING.md](./CONTRIBUTING.md).

Security issues: see [SECURITY.md](./SECURITY.md). Please report privately first.

## License

Dual-licensed under [MIT](./LICENSE-MIT) or [Apache-2.0](./LICENSE-APACHE) at your option.
