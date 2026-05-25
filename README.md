# GhostKey

**Your Bitcoin should outlive you.**

Most people with Bitcoin have no plan for what happens when they die. Not because they don't care — because the tools are too complicated, too expensive, or require trusting a company that might not exist in 20 years.

GhostKey is a free, open-source way to make sure your Bitcoin reaches the people you love. You keep your keys. You stay in control. If you ever stop checking in, a countdown begins — and when it ends, your heir can claim what you left them. No lawyer. No middleman. No permission needed from anyone.

[**Try it → ghostkeyapp.vercel.app**](https://ghostkeyapp.vercel.app)

---

## The short version

1. Paste your wallet's extended public key (xpub) into the setup wizard
2. Enter your heir's email and a name for the vault
3. Choose how long to wait before they can claim (e.g. 3 months)
4. Open the site once a month and tap **I'm still here**

That's the whole job. One tap a month.

If you stop tapping, a countdown starts. When it ends, your heir gets one email with a link. They open it in any browser, paste their Bitcoin address, and receive a transaction they sign with their own wallet. No account. No app. No one holds their funds at any point.

---

## Before you start

**GhostKey works with Bitcoin you actually control.**

If your sats are on Blink, Yellow Card, Binance, or any exchange — those sats belong to the exchange, not to you. GhostKey cannot reach them. If you want them to be inheritable, move them to a wallet where you hold the keys first (Cake Wallet, Blue Wallet, Sparrow, or a hardware wallet). We'll show you how.


---

## What makes this different

Most inheritance tools assume you can run a full node, read a script policy, and manage a multisig setup. Most people can't, and shouldn't have to.

GhostKey packages one specific, well-tested Bitcoin inheritance pattern into something you can set up in five minutes from your phone. The rules are written into Bitcoin itself — even if GhostKey shut down tomorrow, the on-chain script would still work. Anyone holding the pre-built transaction can broadcast it once the timelock expires.

---

## How the guarantee works (plain version)

Your Bitcoin sits in a special address with two keys:

- **Your key** — you can spend it any time
- **Your heir's key** — they can spend it only after your countdown has expired

Tapping "I'm still here" resets the countdown. Stop tapping long enough, and the countdown reaches zero — at which point only your heir's key works.

No one at GhostKey can touch the funds. The rules are enforced by Bitcoin, not by this website.

---

## Status

**Alpha — testnet only.** The cryptography is tested end-to-end. Do not use this with mainnet funds yet.

What works today:
- Full vault setup from xpub
- Monthly check-in with owner authentication
- Scheduler that tracks deadlines and transitions vault state
- Encrypted heir contact storage
- Email notification when the alarm fires
- One-time claim link and PSBT signing flow for heirs

What's still being built:
- SMS and WhatsApp notifications
- Setup from a plain Bitcoin address (without needing an xpub)
- Lightning check-ins (pay 1 sat to confirm you're alive)
- Check-in reminders for owners
- Multiple heirs
- Hardware wallet PSBT export
- Translations — Yoruba, Igbo, Hausa especially needed
- Mainnet security review

---

## Stack

Built with Rust (ghostkey-core, ghostkey-cli, ghostkey-server) and React (ghostkey-web).

### Run locally

```bash
# Prerequisites: Rust 1.85+, Node 20+

cargo build --workspace
cd ghostkey-web && npm install && npm run build && cd ..

# Server (one terminal)
GHOSTKEY_MASTER_KEY=$(openssl rand -base64 32) cargo run -p ghostkey-server
# → http://127.0.0.1:8787

# Web app (another terminal)
cd ghostkey-web && npm run dev
# → http://127.0.0.1:5173
```

### Tests

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace --locked

# End-to-end on real regtest bitcoind (~5s, not in CI)
cargo test -p ghostkey-core --test regtest_e2e -- --ignored

cd ghostkey-web && npm run typecheck && npm run build
```

### Repo layout

```
crates/
  ghostkey-core/    Bitcoin logic. I/O-free. Descriptors, PSBTs, BIP68 timelocks.
  ghostkey-cli/     Owner and heir CLI. Talks to Esplora or local bitcoind.
  ghostkey-server/  Axum server. Vault registry, scheduler, notifier, claim broker.
ghostkey-web/       React + Vite dashboard.
```

The on-chain script, threat model, and design decisions are in [ARCHITECTURE.md](./ARCHITECTURE.md).

---

## Contributing

PRs welcome — especially on anything in the "still being built" list above, plus bug fixes, accessibility improvements, and translations. See [CONTRIBUTING.md](./CONTRIBUTING.md).

Security issues: [SECURITY.md](./SECURITY.md) — please report privately first.


**License:** MIT License.