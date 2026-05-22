# GhostKey

> The inheritance layer for Bitcoin.

When you die, your Bitcoin disappears. Not because it's gone — because nobody knows where the keys are, or nobody can use them without you.

GhostKey fixes this. You link your Bitcoin address. You name an heir. Once a month you tap to say you're still here. If you ever stop, your heir gets a notification and can claim everything — automatically, without asking anyone's permission. No lawyer. No exchange. No middleman.

The rules are written into Bitcoin itself. Even if GhostKey shut down tomorrow, your heir could still claim.

---

## How it works

**You set it up once.** Link your Bitcoin wallet by pasting its public key (an "xpub" — most wallets can export one in a few taps, and we'll show you where to find it). Name who inherits. Choose how long to wait before they can claim.

**You tap once a month.** That's the whole job. One tap from the website resets the clock. Email-link and Lightning check-ins are on the roadmap; today the website tap is the only path.

**If you stop tapping,** the countdown begins. When it ends, your heir is sent a one-time link. They open it, follow the steps, and the Bitcoin is theirs — sent directly on Bitcoin, not by us. (Today an operator delivers the link manually; automatic SMS / email / WhatsApp delivery is the next thing being built.)

**You stay in control** for as long as you're tapping. Change your heir, change the timelock, change your mind — it's your Bitcoin.

---

## What GhostKey is not

- Not a savings account. Link Bitcoin you already own; we don't hold it or earn yield on it.
- Not a legal will. Use it alongside a regular will for other assets.
- Not a custodian. We never touch your keys. We watch your address and track your check-ins.

---

## For Nigerian users

Most sats in Nigeria are on Blink, Yellow Card, or an exchange. Those sats are **not inheritable** — the exchange controls them, not you. If you die, that account may be locked forever.

To protect your sats with GhostKey:
1. Move them to a Bitcoin address you control (we'll show you how — takes 5 minutes).
2. Link that address here.
3. Name your heir.

After that, one tap a month is all it takes.

---

## I want to use GhostKey

Go to **[ghostkeyapp.vercel.app](https://ghostkeyapp.vercel.app)** and follow the wizard.

You need: your wallet's extended public key ("xpub"). Most wallets can export one — the wizard tells you exactly where to find it in Sparrow, BlueWallet, Specter, and others. No Bitcoin Core. No command line. No technical setup.

---

## I want to run GhostKey myself or contribute

### Prerequisites

- Rust 1.85+
- Node 20+ (for the web dashboard only)
- No Bitcoin Core required — GhostKey uses Esplora by default

### Build

```bash
cargo build --workspace
cd ghostkey-web && npm install && npm run build && cd ..
```

### Run locally

```bash
# Server (watches vaults, handles check-ins)
cargo run -p ghostkey-server
# → http://127.0.0.1:8787

# Web dashboard (development)
cd ghostkey-web && npm run dev
# → http://127.0.0.1:5173
```

### Test

```bash
# Unit tests
cargo test --workspace

# End-to-end (spawns a real regtest bitcoind, ~5s)
cargo test -p ghostkey-core --test regtest_e2e -- --ignored

# Web type-check + build
cd ghostkey-web && npm run typecheck && npm run build
```

### Repo layout

```
crates/
  ghostkey-core/     Bitcoin logic. I/O-free. Descriptors, PSBTs, CSV timelocks.
  ghostkey-cli/      Owner and heir CLI. Talks to Esplora or bitcoind RPC.
  ghostkey-server/   Axum server. Tracks vaults, check-in deadlines, alarm events.
ghostkey-web/        React dashboard. Vite + TypeScript + Tailwind.
```

### How the on-chain mechanism works

A single Taproot output with two spend paths:

```
or_d( pk(OWNER), and_v( v:pk(HEIR), older(N) ) )
```

- Owner can spend at any time. An on-chain check-in (via the CLI) moves the UTXO to a freshly derived vault address, which resets N. The website's "I'm still here" button is a *server-side* check-in: it only tells our notifier the owner is alive, and does not touch the chain. For real-money mainnet use, the two are combined: light website check-ins most weeks, occasional on-chain re-vaulting to reset the BIP68 timer.
- Heir can spend only after N blocks have elapsed since the UTXO was confirmed (BIP68 / OP_CSV).
- The keypath uses an unspendable NUMS point — both spend paths are explicit scripts.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full threat model and design rationale.

---

## What's not built yet

- **Notification fan-out.** The server records alarm events and generates a one-time claim link, but doesn't yet deliver that link automatically (SMS, email, WhatsApp). Today an operator pulls the link from the events log and forwards it. Automatic delivery is the top priority.
- **Address-only setup.** The wizard requires an xpub today. A bare-address mode (for users who can't easily export an xpub) is planned.
- **Lightning check-in.** Paying 1 sat to a per-vault Lightning address as proof of life. Planned, not yet built.
- **Cold signing.** CLI signs in-process today. PSBT export for hardware wallets is planned.
- **Multiple heirs.** The descriptor builder currently supports one heir.
- **Mainnet checklist.** The cryptography is sound and tested. The operational infrastructure (auth, notifications, key ceremony) is not yet production-ready. Treat this as alpha.

---

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). All contributions welcome — Rust, TypeScript, documentation, translations (Yoruba, Igbo, Hausa especially needed).

Report security issues privately: see [SECURITY.md](./SECURITY.md).

## License

Dual-licensed MIT or Apache-2.0 at your option.
