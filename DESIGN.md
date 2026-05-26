# GhostKey — Design

The long, plain-English version of why GhostKey is built this way and what we'd build next.

- **[README](./README.md)** — what it is and how to use it
- **[ARCHITECTURE](./ARCHITECTURE.md)** — the technical reference
- **[JOURNAL](./JOURNAL.md)** — how decisions were made over time

If you're contributing and only read one document, read this one.

---

## Table of contents

1. [What problem are we solving](#1-what-problem-are-we-solving)
2. [The design in two sentences](#2-the-design-in-two-sentences)
3. [How a vault works, start to finish](#3-how-a-vault-works-start-to-finish)
4. [What the server can and cannot do](#4-what-the-server-can-and-cannot-do)
5. [The heir's experience](#5-the-heirs-experience)
6. [Security trade-offs](#6-security-trade-offs)
7. [Where AI fits and where it doesn't](#7-where-ai-fits-and-where-it-doesnt)
8. [What we'd build next](#8-what-wed-build-next)

---

## 1. What problem are we solving

Bitcoin is bearer money. If you die without telling anyone how to access your wallet, the coins are gone — not stolen, gone. No bank to call, no probate court that can move them, no recovery email.

The existing answers are all bad:

**Write the seed phrase down and put it in a safe.** Whoever finds it controls everything, today, while you're alive. You have to trust them completely.

**Give the seed to a lawyer.** Same problem, with a stranger who charges by the hour.

**Use a custodial service.** The service holds your coins. If they get hacked, go out of business, or freeze your account, you lose.

**Multisig with a trustee co-signer.** Better, but the co-signer can collude with the heir, block a legitimate spend, or simply lose their key.

GhostKey is a different option: you keep full control of your Bitcoin. Your heir can claim it only after you've been silent for a chosen amount of time. Nobody else can ever touch it. The rule that enforces this lives on the Bitcoin network itself — no third party can override it.

---

## 2. The design in two sentences

Every GhostKey vault is a single Bitcoin address with a rule attached: the owner can spend from it any time; the heir can spend from it only after a chosen number of blocks have passed since the coins last moved.

Everything else — the dashboard, the notifier server, the check-in button, the heir's claim page — is comfort software. It makes the system pleasant to use. It cannot change who controls the coins.

If GhostKey shut down tomorrow, every existing vault would still work. The Bitcoin network does not care whether our servers are up.

---

## 3. How a vault works, start to finish

Let's walk through the life of one vault. The owner is Ada. The heir is Ben.

### Ada and Ben each generate a wallet

Each runs the GhostKey setup wizard or any standard Bitcoin wallet that can export an extended public key (xpub). Out comes a 12-word recovery phrase. Ada keeps hers; Ben keeps his. Neither phrase ever leaves their device.

Each phrase produces an xpub — public information that lets someone watch incoming transactions but not spend them. Ada and Ben exchange xpubs.

### Ada creates the vault

Ada pastes both xpubs into the setup wizard and chooses a timelock — say, 90 days. The wizard sends the xpubs to the server, which computes a Bitcoin address and matching descriptor. Ada funds that address from her regular wallet.

To anyone watching the chain, it looks like a normal payment. The vault's two-branch logic is hidden inside a Taproot address and won't be visible until someone spends from it.

### Ada registers with the notifier

Ada sets her check-in cadence (say, every two weeks) and a grace period (how long after a missed check-in before the alarm fires). She enters Ben's contact info — phone number or email. The server encrypts this at rest; the plain version never touches the database.

The server now knows: a vault exists, here's its descriptor, here's the cadence, here's how to reach Ben if Ada goes quiet. It does not know Ada's seed phrase, Ben's seed phrase, or anything that would let it spend the coins.

### Ada checks in, month after month

Every two weeks Ada opens the dashboard and taps "I'm still here." The server records the timestamp and pushes the deadline forward.

This is a server-side check-in only — it does not touch the chain. For mainnet-grade security, owners should also do periodic on-chain re-vaulting (the CLI's `check-in` command moves the UTXO to a fresh vault address, resetting the BIP68 timer). Most families won't do this weekly, so the web flow uses the cheaper server-only heartbeat, with on-chain re-vaulting as an optional layer.

### Ada stops checking in

Maybe she's travelling. Maybe she's in hospital. Maybe she's died. The server doesn't know and doesn't need to. It only sees that the deadline passed.

The vault moves from `ok` to `alarmed`. Ada gets an alert: "you missed a check-in, tap here to confirm you're OK." If she responds, the alarm clears and Ben hears nothing.

### The eligibility window passes

If Ada stays silent through the grace period, the server generates a one-time claim token — 32 random bytes, base64-encoded. The hash goes into the database; the raw token goes into an event row for the notification worker to pick up and send to Ben via the channel Ada chose.

### Ben receives a link

Ben gets a message:

> Ada set up GhostKey so that if she ever stopped checking in, you'd hear from us. That's what happened. Tap this link to see what she left you.

He taps it. The claim page explains what's happening, who left him the inheritance, the amount, and a step-by-step claim flow. No jargon.

### Ben claims the funds

1. Enter the Bitcoin address where he wants the funds to land.
2. Click "Prepare transaction" — the server scans the chain, builds an unsigned PSBT, shows a summary (amount, fee, destination).
3. Copy the unsigned PSBT into his wallet. His wallet signs it with his key (which has never left his device).
4. Paste the signed PSBT back. The server assembles the timelock-branch witness and broadcasts.
5. Done. The coins move. The vault is marked claimed.

GhostKey never sees Ben's signing key. The server's role is chain scanning, PSBT plumbing, and broadcast — all of which require blockchain access but no private keys.

---

## 4. What the server can and cannot do

This is the most important section in the document. If you read one thing and remember it, make it this.

### The server CAN

- See which Bitcoin descriptor each vault is based on
- Look up the vault's current addresses on-chain
- Track check-in history and deadlines
- Decide a vault is overdue
- Generate a one-time claim token and store its hash
- Build an unsigned PSBT that drains the vault on the heir's branch
- Accept a signed PSBT from the heir and broadcast it
- Send notifications when an alarm fires

### The server CANNOT

- See the owner's seed phrase. Ever.
- See the heir's seed phrase. Ever.
- Sign a Bitcoin transaction
- Move coins on its own — even if every operator turned malicious simultaneously, the on-chain script requires a valid signature from the owner or heir
- Reset the on-chain timelock — Bitcoin blocks cannot be rewound from off-chain
- Decrypt heir contact details if the master key environment variable is absent

### Why this boundary matters

This is not a promise — it is a structural property of the software. The server binary has no code path that touches a private key. Anything that touches keys lives in `ghostkey-core` (descriptors) or `ghostkey-cli` (signing) or the heir's own wallet (the actual signature). If this boundary is ever blurred in a pull request, it should be treated as a security defect.

---

## 5. The heir's experience

The heir is usually the least technical person in the system. They may never have used Bitcoin before. They may be grieving. The claim page assumes nothing.

**No navigation chrome.** The heir doesn't need a "Set up" button or a dashboard. Showing unrelated controls would be confusing. They see one page with one job.

**Greet them by name.** If the owner entered a display name, it's decrypted and used: "Hello Ben." Not "Welcome, user."

**Explain before asking.** The page opens with what happened. It doesn't ask for a wallet address or a PSBT until the heir understands why they're there.

**One decision per step.** Step 1: do you have a wallet? Step 2: paste your address. Step 3: sign this PSBT in your wallet, paste back. Each step unlocks the next.

**No fake successes.** If the chain scan finds no coins — timelock hasn't elapsed, funds already moved, indexer down — the page says so in plain English. It does not pretend the transaction succeeded.

**The link doesn't expire on first view.** The heir will probably open it on their phone, then move to a desktop with Sparrow to sign. The claim token is consumed only on a successful broadcast. Viewing does nothing destructive.

**End with proof.** After a successful broadcast, the page shows the transaction ID and a block explorer link. Not a thank-you screen — a "here's how to watch it confirm" screen. The heir wants proof, not branding.

---

## 6. Security trade-offs

This section lists the trade-offs we made, in plain language, so a future contributor can argue with them if they have a better idea.

### Taproot over legacy multisig

A traditional scheme uses 2-of-3 multisig with the owner, heir, and a notary. Simple to explain, but the notary is a permanent trust dependency, transactions are larger, and a missing third party can block a legitimate recovery.

Taproot lets us encode the same logic in a single output that looks like a normal payment until it's spent. Cheaper on-chain, no notary required.

### Relative timelocks over absolute ones

An absolute timelock (`after(H)`) expires at a fixed block height. If the owner is still alive at that height, they have to migrate the vault before the heir's window opens — forever.

A relative timelock (`older(N)`, BIP68) measures from when the UTXO last moved. Every on-chain check-in resets the heir's timer. No calendar to race against, no vault expiry.

Trade-off: relative timelocks require periodic on-chain re-vaulting for the guarantee to hold. The web check-in only tells the server "I'm alive." Mainnet vaults should combine both.

### Encrypting heir contact, not descriptors

Descriptors are public information by design — anyone who sees the vault address can derive the spending rules. Encrypting them would be theatre.

Heir contact (name, email, phone) is PII. It's encrypted with a per-vault key derived via HKDF from a server-wide master key in an environment variable. If the database is exfiltrated alone, the contacts remain encrypted ciphertext.

### Bearer tokens for claim links, not signed JWTs

A claim token is 32 bytes of random data sent to the heir in a URL. We store only its SHA-256 hash.

The trade-off: anyone who intercepts the URL can act as the heir. We accept this because:
- The link travels via the same channel as any bearer-link system (password resets, Stripe checkout, calendar invites) — no less private
- The heir's wallet still has to sign the PSBT. An attacker who steals the link cannot sign without the heir's seed phrase
- Damage from a stolen link is bounded: they see the heir's display name and the vault's network. They cannot see heir contacts, owner identity, or sign anything

### SQLite over Postgres

The notifier's data fits comfortably in one file on one disk. A busy deployment might serve hundreds of thousands of vaults — SQLite handles that on a $5/month VPS with WAL mode enabled. Postgres adds an operational dependency and failure modes we don't need. If the project ever outgrows SQLite, switching is a small `sqlx` change. We'd rather have the problem first.

### Lightning check-ins vs button heartbeat vs on-chain re-vault

The owner can confirm liveness three ways, each with different guarantees and costs:

| Method | What it proves | What it does to state | Cost |
|---|---|---|---|
| Tap the heartbeat button | Someone with the owner bearer token clicked. Trusts the server's clock. | Resets `next_deadline_at`, `claim_eligible_at`, clears any pending claim token. | Free, one click. |
| Pay a 1-sat Lightning invoice | Cryptographic act the owner performs with their own wallet keys. The server cannot forge it. | Same as button: resets the same database fields via the same code path. | 1 sat + routing fee (typically <1 sat). |
| Run the CLI `check-in` command | Spends the vault UTXO into a fresh vault address, resetting the BIP68 timer on-chain. | Everything the button does, **plus** the heir's claim window genuinely restarts from zero confirmations. | Bitcoin network fee. |

Honest framing: the Lightning check-in is *stronger than the button* (it's cryptographic, not click-based) but *weaker than an on-chain re-vault* (it doesn't move the BIP68 clock). The dashboard surfaces Lightning as a "stronger sign-in" when the operator has wired up a provider, and the CLI re-vault remains the authoritative path for mainnet vaults.

Why we ship the Lightning option at all, given the button does the same database work:

1. **Trust minimisation.** A compromised server could record a fake button check-in. It cannot forge a Lightning payment without spending sats from its own node — the audit trail is on the Lightning network itself.
2. **Anti-grief.** A leaked owner token still costs 1 sat per fake check-in. Sustained griefing has a marginal cost.
3. **Path to better.** Once Lightning is wired we have a notification rail for the owner that doesn't require an email server. (Future work — not in the current build.)

The Lightning backend is intentionally abstracted behind a `LightningProvider` trait (`crates/ghostkey-server/src/lightning.rs`) with a `NoopProvider` default. The intended real implementation uses Breez SDK - Liquid, but is isolated in a planned sibling crate so its heavy / git-only dependency graph (~6 forked transitives, pinned `reqwest =0.12.18`) does not poison the main workspace. Until that crate exists the `/lightning-checkin/*` routes return 503 and the web UI hides the button — gated on `health.lightning_enabled`.

### Check-in cadence and grace period as user choices

Earlier builds hard-coded the check-in cadence to "every 2 weeks or every month" with a fixed 3-day grace. We expanded this to:

- **Cadence:** weekly · 2-weekly (default) · monthly · quarterly
- **Grace period:** 3 days (default) · 1 week · 2 weeks · 1 month

Both are explicit enumerations (`ghostkey-web/src/timing.ts`) rather than free-form numeric inputs, so a careless user can't pick `graceSecs = 60` and lock themselves out of recovery. The presets cover the realistic spectrum, from "I want to be reminded weekly and have a tight 3-day budget" to "quarterly nudge, full month of slack." The owner picks once at setup; changing it later requires recreating the vault (no migration path planned for the alpha).

---

## 7. Where AI fits and where it doesn't

GhostKey is security-critical. The trusted compute surface is small on purpose. Adding a language model to the hot path of moving real money would be a mistake — models hallucinate, network calls fail, output is hard to test deterministically.

That said, there are real places where a model could make the product genuinely better. Here they are, in descending order of clarity and shipping effort.

### Option A — Plain-English error explainers on the heir claim page ✓ Recommended

**What it does.** When the server returns a chain error (no UTXOs, timelock not mined, PSBT malformed, mempool rejection), a model translates the raw message into a plain sentence alongside the original.

Example:
- Raw: `psbt parse: invalid base64 character at position 47`
- Human: "The signed PSBT didn't paste cleanly — part of it may have been cut off. Try copying the entire string again."

**What data it sees.** The error string. Nothing else — no keys, no contacts, no tokens.

**Failure mode.** If the model is down, show the raw message. The heir is no worse off than today.

**Effort.** One day. One server route that proxies a hosted model. A prompt with a dozen example translations. Canned fallbacks for known error classes so the model only handles the long tail.

**Worth it?** Yes. The realistic worst case for a heir is hitting a confusing error and giving up. This fixes that at almost no cost.

### Option B — Setup wizard concierge

**What it does.** A chat sidebar on the setup page where owners ask things like "what's an xpub?", "how do I find this in Sparrow?", "how long should I set the timelock?"

**What data it sees.** Free-text questions. We add a client-side check that refuses to send strings that look like seed phrases.

**Failure mode.** Chat goes offline; a link to the relevant doc section appears instead. The setup flow doesn't depend on it.

**Effort.** About a week. Vector store of our docs, retrieval-augmented prompt, chat UI, abuse protection.

**Worth it?** Maybe — but write better inline documentation first. Add this only if drop-off analytics show people actually get stuck.

### Option C — Commit message assistant for contributors

**What it does.** A small tool in `tools/` that takes a `git diff` and produces a draft commit message matching this repo's style. The contributor edits before committing.

**What data it sees.** The diff. No user data.

**Failure mode.** Contributor writes the message by hand, as today.

**Effort.** A weekend.

**Worth it?** The cheapest AI addition to the project. No runtime dependency, no user-facing risk, helps keep the journal consistent as contributors join.

### Option D — Address sanity check on claim

**What it does.** Before "Prepare transaction", check the heir's destination address against known scam addresses or flagged mixing services.

**What data it sees.** A Bitcoin address. Public information.

**Effort.** Medium-large — the hard part is a good data source. A chain analytics subscription is expensive; building our own is years of work.

**Worth it?** Not yet. Without good source data, the check produces false confidence or false positives. Revisit once the product is mature.

### Option E — Check-in anomaly detection

**What it does.** Flag vaults whose check-in pattern suddenly changes — long pause then flurry of check-ins, new geographic IP, unusual hours. Alert the owner: "someone checked in for you from a new device — was it you?"

**What data it sees.** Server-side check-in logs (timestamps, IPs). No keys.

**Effort.** Large. Needs a training set, inference pipeline, and careful alert UX.

**Worth it?** Eventually. Needs real usage data first — no signal of "normal" without users.

### What we will not use AI for

- Building, signing, or broadcasting Bitcoin transactions. These are deterministic operations. A non-deterministic model has no place here.
- Validating descriptors or addresses. We have a parser; we use the parser.
- Deciding when to fire an alarm. The cadence is set by the owner. The check is a `<=` on a timestamp.
- Security questions in customer support. A model that confidently says "yes, your seed phrase is safe" when it has no way to know that is worse than no support at all.

---

## 8. What we'd build next

In rough priority order. Some are weeks of work; some are afternoons.

### Tier 1 — Before recommending to a real family

**Live signet smoke test.** The PSBT build → sign → broadcast flow passes its unit tests but has never been driven against a live Bitcoin signet node with a real heir wallet. Do this before mainnet:
1. Deploy a signet server instance
2. Create a vault with a 6-block timelock on signet
3. Fund from a signet faucet
4. Wait out the timelock
5. Walk through the claim page using Sparrow on signet
6. Confirm the transaction lands

This is the single highest-value piece of remaining work.

**Real notification delivery.** The scheduler issues claim tokens but sends nothing. Wire at least one channel:
- Email first (SMTP via Postmark, SES, or Resend) — easiest
- SMS next (Twilio, or Africa's Talking for Nigerian numbers) — more useful for our audience
- WhatsApp eventually — highest reach in Nigeria, non-trivial Business API approval

Add a `notifications` table, a worker that polls unsent events and pushes through the configured channel, and a retry policy. Failures should be loud, not silent.

**Owner alarm notifications.** Same fan-out infrastructure, but for the owner. When a vault moves to `alarmed`, the owner should be told immediately and given a window to respond before the heir is contacted.

**Master key rotation.** Tag each ciphertext row with the key version that produced it. Support N versions in memory simultaneously. Add a background re-encryption job for old rows. Do this before the data volume makes it painful.

### Tier 2 — Soon, in any order

**k-of-n heirs.** One-line change in `descriptor.rs` (generalise the heir branch to `thresh(k, pk(HEIR1), pk(HEIR2), ...)`), plus setup UI to accept multiple heir xpubs and a threshold. Good first contribution — about a week.

**Cold signing for owner check-ins.** Add `--export-psbt` (write unsigned PSBT to disk) and `--sign-psbt` (import signed PSBT, broadcast) to the CLI. Owners can then sign on an offline device without the seed phrase ever touching an internet-connected machine. BDK already produces standard PSBTs; this is pure CLI plumbing.

**Setup from a plain Bitcoin address.** The wizard requires an xpub. Many beginners only know their receive address. Supporting single-address vaults (watches one address rather than the full wallet derivation path) lowers onboarding friction significantly.

**Encrypted off-host backups.** The `ghostkey.sqlite` file is the entire notifier state. Encrypt snapshots with `age`, push to S3-compatible storage on a schedule, document a one-line restore procedure.

### Tier 3 — Quality of life

**Operator audit log.** Every state change already produces an event row. Add an operator-facing view filterable by vault, event type, and time range — so a support engineer can answer "what happened to vault X?" without writing SQL.

**Guided wallet import.** Screenshots and step-by-step instructions for the three most common wallets (Sparrow, Blue Wallet, Cake Wallet) on the "find your xpub" step of setup.

**Translations.** All copy is English. Yoruba, Igbo, and Hausa would be high-impact for our primary audience. Mechanical work; no architectural changes needed.

**CLI claim from link.** Add `claim --from-link <url>` so a paranoid heir can complete the claim locally without trusting our Esplora endpoint, using a local Bitcoin node instead.

### Tier 4 — Speculative

**Self-hosted Esplora.** We currently use Blockstream's free public endpoint. For a production product we'd want our own indexer, or an enterprise subscription, so we're not at the mercy of a free service.

**Privacy-preserving check-ins.** A Tor-routed check-in with no IP logging and no account binding, for owners concerned about revealing their activity pattern to the server.

**Multi-server federation.** A single notifier is a single point of failure for reminders. A federation of independent notifiers watching the same vault set would mean the heir gets notified even if one server goes down. Real work — partitioning, deduplication, mutual distrust between notifiers — only worth doing once there's a meaningful user base.