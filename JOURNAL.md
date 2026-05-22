# GhostKey — Journal

A log of how this project got built. One entry per merged feature
branch, in the order it happened. Each entry says what we built, why
we built it then, what was hard, and what we left for later.

The point of this file is to give a new contributor (or future-you)
enough context to read the codebase without confusion. If you ever
look at a piece of code and wonder "why on earth is this here?", the
answer is probably in this file.

The dated format is loose by design — the focus is on the *reasoning*
that led to each change, not the timestamps.

---

## Entry 1 — Bootstrap the protocol core
**Date:** 2026-05-21  
**Branch:** initial commit on `main` (`d13a7a3`)

### What we built
The base Rust workspace. Three crates:

- `ghostkey-core` — the cryptographic library. Descriptor builder,
  vault construction, PSBT helpers, key derivation. No I/O.
- `ghostkey-cli` — the command-line tool for the owner and the heir.
  Generates seed phrases, derives xpubs, builds vaults, signs
  check-in and claim transactions, talks to a local Bitcoin Core
  node.
- `ghostkey-server` skeleton — at this point just a `main.rs` stub.

Plus a regtest end-to-end integration test in `crates/ghostkey-core`
that spins up its own `bitcoind`, runs a full owner check-in / early
heir claim (which must fail) / mine the timelock / heir claim again
(which must succeed) cycle.

### Why first
The on-chain mechanism is the only part of GhostKey that has to be
bulletproof. Everything else can change later; the script and the
PSBT builders cannot. We wrote them first, got them passing the
regtest test, and then never touched them again unless we had to.

### Hard parts
- **BDK's policy path resolver doesn't always pick the right branch.**
  Our descriptor is `or_d(pk(OWNER), and_v(v:pk(HEIR), older(N)))`.
  When the owner signs a check-in, BDK couldn't tell which side of
  the `or_d` we meant — both were syntactically signable. We had to
  use BDK's per-node `contribution` annotation and explicitly prefer
  the owner branch (`Complete { csv: None }`) over the heir branch.
  For the heir's claim, the threshold inside `and_v` (the heir's key
  *and* the timelock) needed both children selected, not just the
  timelock. The fix is a small walker in `ghostkey-core/src/psbt.rs`
  but it took an afternoon to figure out.
- **NUMS internal key.** Taproot outputs always have a keypath spend
  available. We don't want anyone — including the heir — to bypass
  the script via the keypath, so we commit to an unspendable
  ("NUMS") point as the internal key. This is standard but worth
  documenting because anyone reading the descriptor will see
  unfamiliar bytes there.

### What we left for later
- Anything web-facing.
- A real notifier; the server was just a stub.
- Anything beyond regtest.

---

## Entry 2 — The first web layer
**Date:** 2026-05-21  
**Branch:** `feat/web-and-docs` (merged in `cad6307`)

### What we built
- A working `ghostkey-server` Axum service. SQLite via `sqlx`. Two
  tables: `vaults` and `events`. Routes for register / list / get /
  check-in / events / health.
- A background scheduler that ticks every 30 seconds and moves
  overdue vaults from `ok` to `alarmed`.
- The first React dashboard (`ghostkey-web`). One card per vault,
  live countdown, "Check in" button, slide-in detail drawer with
  the event log.
- `README.md` and `ARCHITECTURE.md`. The README aimed at users; the
  architecture doc aimed at developers.

### Why now
We wanted to see the full owner-side loop working end to end before
adding any heir-side complexity. Once an owner could register a
vault and tap a button to keep it healthy, we had something
demonstrable.

### Hard parts
- **Dev proxy.** The Vite dev server proxies `/api/*` to
  `127.0.0.1:8787`. Getting CORS, error messages, and the proxy
  config to play nicely with the production single-origin deployment
  took a couple of iterations.
- **Status pill colours.** The dashboard needed a clear, accessible
  status pill for each vault state (`ok`, `warning`, `alarmed`, etc.).
  We picked a small palette with `Tone = "ok" | "warning" | "alarm" |
  "neutral"` and applied it consistently.

### What we left for later
- Anything heir-side.
- Real authentication (we punted: every vault is identified by its
  UUID, and you need the UUID to interact with it).
- Production deploy automation.

---

## Entry 3 — Family-friendly UI
**Date:** 2026-05-21  
**Branch:** `feat/family-friendly-ui` (merged in `ba8b1df`)

### What we built
A redesign of the dashboard with non-technical owners in mind. The
language across the app got simpler ("check in" instead of "send
heartbeat", "your vault" instead of "this descriptor"). The
accessibility pass added proper ARIA roles, focus rings, and a
no-motion fallback for the animated countdown.

### Why now
The first dashboard was visibly built by engineers, for engineers.
GhostKey's target user isn't an engineer. We wanted to fix the tone
before adding more features, because every new feature would have
inherited the wrong vocabulary.

### Hard parts
- **The vocabulary tension.** Some Bitcoin terms have to stay —
  "address" can't easily become anything else without confusing
  users who have used Bitcoin before. But "UTXO", "policy path",
  "BIP68" can all disappear from user-facing copy. We added a
  `vocab.ts` module to centralise the brand strings so future
  copy changes are one-file edits.

### What we left for later
- Internationalisation (everything is English).
- A landing page (the app jumped straight into the dashboard).

---

## Entry 4 — Bitcoin-themed portals
**Date:** 2026-05-21  
**Branch:** `feat/bitcoin-themed-portals` (merged in `4a97709`)

### What we built
Distinct portal pages for the three audiences:

- **Landing** (`Landing.tsx`) — explains GhostKey to a first-time
  visitor. Hero, "how it works", lifecycle, FAQ, comparison table.
- **SetupPortal** — the wizard an owner uses to create a new vault.
- **CheckinPortal** — the page an active owner sees to tap "I'm OK".
- **InheritPortal** — placeholder for the heir-side flow (the real
  thing came in entry 7).
- **Dashboard** — the existing per-vault view, now reachable from
  the navigation.
- **NavBar** + **Brand** components for consistent header treatment.

### Why now
A single dashboard that tried to be a homepage and a setup wizard
and a heir landing all at once was confusing. Splitting into
purpose-built pages let each one optimise for its audience.

### Hard parts
- **Routing without a router library.** We use a hash-based
  discriminated-union router (see `App.tsx`) instead of pulling in
  `react-router`. This keeps the bundle small and the navigation
  state typed. The catch: every route addition needs a new variant
  in the `Route` union and a handler in `App.tsx`. Worth it for the
  size win.
- **Landing page tone.** We rewrote the hero copy at least six
  times to get rid of the "ChatGPT voice" — phrases like "robust,
  secure, and seamless" that mean nothing. The final copy uses
  emotional, plain words ("Your money. Their future.") and
  earns trust through specifics, not adjectives.

### What we left for later
- The actual heir flow.
- Deployment.

---

## Entry 5 — Deployment infrastructure
**Date:** 2026-05-21  
**Branch:** deploy workflow (`8a54a23`)

### What we built
- A `Dockerfile` that produces a small image with the
  `ghostkey-server` binary.
- `fly.toml` for one-command deployment to Fly.io.
- `DEPLOY.md` documenting three deployment paths: Fly.io,
  single-VPS + Caddy, and split-host with Cloudflare Pages.
- A nightly SQLite backup cron in the docs.

### Why now
The web app could only be tested by people running both halves
locally. Putting the server on Fly.io and the web on a static host
let us share working URLs and start collecting real feedback.

### Hard parts
- **Volume / region pinning on Fly.** SQLite needs a persistent
  volume, and Fly volumes are local to a region. Getting the
  startup order right (volume created *before* first deploy) is a
  one-time gotcha that's now in `DEPLOY.md`.
- **CORS.** Split-host deployment means the web app makes
  cross-origin calls to the server. The Caddy configuration in
  `DEPLOY.md` handles this; the alternative is a single-origin
  reverse-proxy setup that's simpler but less flexible.

### What we left for later
- TLS automation under Caddy is documented but the production
  Fly.io deploy uses Fly's built-in certs.
- A real monitoring story (no Prometheus endpoint, no status page
  yet).

---

## Entry 6 — Transaction flow redesign
**Date:** 2026-05-22  
**Branch:** `feat/xpub-vault-flow` (merged in `833adfc`, with the
preparatory `249db76`)

### What we built
A new server route `POST /vaults/from-xpub` that takes two xpubs
(owner and heir, optionally origin-tagged) plus a timelock and
builds the descriptor pair server-side. The browser doesn't have to
deal with descriptor strings any more — the setup wizard collects
xpubs, the server renders the descriptors.

This came with a major rewrite of `SetupPortal.tsx`, support for
both bare xpubs (with a separate fingerprint field) and the
`[fp/path]xpub...` origin-tagged form that Sparrow, BlueWallet
desktop, Specter, and Coldcard all export.

### Why now
The original setup flow had the owner paste two pre-rendered
descriptor strings into the dashboard. That meant they'd already
had to run the CLI's `make-vault` command, which defeated the
whole point of the web app. Moving descriptor construction to the
server made the dashboard the actual entry point.

### Hard parts
- **xpub formats are inconsistent.** Different wallets export
  different things. Some give you `xpub...`, some give you
  `[fingerprint/path]xpub...`, some give you `tpub...` for
  testnet. We accept all of them and convert internally.
- **Fingerprint validation.** When the xpub is origin-tagged and
  the caller *also* provides a separate fingerprint, both must
  match. We reject mismatches with a clear error rather than
  silently picking one.
- **Network coupling.** A mainnet xpub in a testnet vault is a
  bug we want to catch loudly. The code re-derives the canonical
  `m/86'/coin'/0'` path from the network parameter and ignores
  whatever path is in the xpub's origin tag (which is
  informational only).

### What we left for later
- Cold signing for the owner's check-in (still in-process).
- k-of-n heirs.

---

## Entry 7 — Encrypted heir contact + one-time claim tokens
**Date:** 2026-05-22  
**Branch:** `feat/encrypted-heir-contact` (merged in `03d4252`)

### What we built
- A `crypto` module in `ghostkey-server` that:
  - Loads a 32-byte server-wide master key from
    `GHOSTKEY_MASTER_KEY` at startup. Refuses to boot if it's
    missing or malformed. We'd rather refuse than silently store
    plaintext.
  - Derives a per-vault contact key with HKDF-SHA256 using the
    vault UUID as salt and a fixed `"ghostkey:contact:v1"` info
    string.
  - Seals heir contact JSON with XChaCha20-Poly1305 (24-byte
    nonce per message, stored alongside the ciphertext).
- A schema migration adding `heir_contact_ciphertext`,
  `heir_contact_nonce`, and `heir_contact_channel` columns. The
  legacy plaintext `heir_contact` column stays nullable for
  backward compatibility but new inserts always go to the
  encrypted columns.
- Claim tokens: 32 random bytes, base64-encoded for transport.
  SHA-256 hash in the database, raw value only in the response
  body of `POST /vaults/:id/issue-claim`. Constant-time compare on
  lookup. First successful resolve marks the token consumed (this
  later changed — see entry 9).
- A new `GET /claim/:token` route that resolves a token to a
  `ClaimView`, decrypts the heir contact, returns a clean
  data shape for the heir's page.

### Why now
We were about to build the heir-side page. The page would receive
PII (the heir's name) and a sensitive bearer token. If we wrote
the page first and bolted encryption on later we'd have a window
where unencrypted contacts were in the database. Doing it in this
order meant the heir-side feature shipped with the security
properties already in place.

### Hard parts
- **Master key storage.** We needed a way to load the key once,
  fail loudly if it's missing, and not have to thread it through
  every database call. A `OnceLock<Vec<u8>>` in `crypto::ensure_…`
  does this. The key never leaves that module.
- **Token uniqueness.** A 32-byte random value has negligible
  collision probability, but we still set a uniqueness expectation
  in the SHA-256 column at the DB level so a bug in the RNG path
  would surface as a duplicate-key error rather than silently
  overwriting a previous heir's token.
- **What to encrypt.** We considered encrypting the descriptors
  too. We decided not to: descriptors are public information by
  design (anyone who watches the chain can derive the on-chain
  address from them), and encrypting public data is theatre. PII
  gets encrypted; protocol data doesn't.

### Tests
13 server tests at this point: 7 crypto, 6 routes. Crypto coverage
included round-trip, cross-vault rejection, tamper detection,
nonce uniqueness, claim-token match. The token uniqueness test
generates a few thousand tokens and asserts no collisions.

### What we left for later
- The heir-side page (next entry).
- Real notification delivery (the raw token still has to be
  pulled out of an event row by an operator).
- Key rotation.

---

## Entry 8 — Heir claim page
**Date:** 2026-05-22  
**Branch:** `feat/heir-claim-page` (merged in `796b918`)

### What we built
`ClaimPage.tsx`, the page someone sees when they click a one-time
link. Five possible states:

- **Loading** — quiet, accessible spinner.
- **Not found** — "this link doesn't work, ask for a new one."
- **Already used** — "someone has been here before."
- **Not ready** — "the person who set this up is still active."
  Reached if an operator issues a claim link prematurely.
- **Claimable** — the happy path, with a step-by-step claim flow.

The claimable state at this point ended with an honest "we can't
broadcast for you yet" message. We told the heir what their saved
address was and that they (or a helper) could complete the
transfer with the descriptor in a few minutes.

Routing in `App.tsx` grew a discriminated union so a route could
carry a token parameter.

### Why now
With encryption and token issuance done, we could finally surface
the heir's experience. We deliberately shipped a not-fully-functional
page rather than blocking on the broadcast flow, because we wanted
to test the language, the layout, and the wallet-recommendation copy
in front of users before adding the PSBT plumbing.

### Hard parts
- **Bypassing the navbar.** Every other page has the GhostKey
  navigation. The heir doesn't need it — they have one thing to
  do. `App.tsx` swaps the chrome out when the route is `claim`.
- **Tone.** The heir might be grieving. We rewrote the copy twice
  to get rid of marketing language. The version that shipped opens
  with "Someone you knew left you Bitcoin."
- **Wallet recommendations.** Without the broadcast flow, the only
  guidance we could give was "show this page to someone who knows
  Bitcoin." We listed Blink, Wallet of Satoshi, and Cake as
  beginner wallets. (Later, when the broadcast flow shipped, we
  had to revise this — Wallet of Satoshi can't sign a PSBT, so the
  list changed to PSBT-capable wallets.)

### What we left for later
- The actual broadcast. This was the obvious next branch.

---

## Entry 9 — The claim pipeline
**Date:** 2026-05-22  
**Branch:** `feat/claim-pipeline` (merged in `657df47`)

### What we built
The piece that turns GhostKey from "we'll tell you when it's time"
into "we'll help you actually move the coins":

- **Scheduler auto-issue.** A new `claim_eligible_at` timestamp
  on every vault (set at creation to `next_deadline_at +
  grace_period_secs`). When the scheduler sees an `alarmed`
  vault past its eligibility timestamp with no claim token yet,
  it transitions the vault to `timelock_started` and issues a
  one-time token in the same database transaction. The raw token
  goes into an event row's JSON detail so an operator (or a
  future notifier) can pick it up. The schema change is
  `migrations/20260523000001_claim_eligibility.sql`.
- **`POST /claim/:token/build-psbt`.** Server reconstructs the
  vault from its stored descriptors, runs a full chain scan via
  Esplora (default endpoint is Blockstream's free public service;
  override with `GHOSTKEY_ESPLORA_URL`), and returns an unsigned
  PSBT plus a sat-level summary (total in, fee, output to the
  heir's destination, network).
- **`POST /claim/:token/broadcast`.** Server takes a signed PSBT,
  finalises it through a watch-only wallet (no keys needed — the
  witness comes from the heir's signatures), broadcasts via
  Esplora, marks the token used and vault claimed in one
  transaction. Returns the txid and a mempool.space link.
- **Frontend wiring.** `api.ts` gained `buildClaimPsbt` and
  `broadcastClaim` client methods plus their types. `ClaimPage`
  step 3 was rewritten to drive the full PSBT round trip: address
  input + optional fee rate → "Prepare transaction" → summary
  card + base64 PSBT with a Copy button → paste signed PSBT →
  "Broadcast transaction" → success view with txid and explorer
  link. Error messages from the server are surfaced verbatim with
  explanatory notes on the realistic causes (no UTXOs, timelock
  not mined, indexer down).
- **Token semantics change.** Previously, `GET /claim/:token`
  marked the token consumed on first view. With the build/broadcast
  flow, the heir needs to visit the URL repeatedly while signing
  offline, so consumption moved to a successful broadcast. The
  doc comments in `crypto.rs` and `routes.rs` were updated.

### Why now
Without this branch, the heir's experience ended with "find
someone who knows Bitcoin to help you finish the transfer." That's
honest, but it's not a finished product. Wiring the PSBT round
trip closed the gap.

### Hard parts
- **What `esplora_client` calls block.** The blocking `esplora_client`
  is the easiest to reason about and the most stable across BDK
  versions, but it can't be called from an async handler directly.
  We wrap each chain-touching call in `tokio::task::spawn_blocking`
  and translate the result back into our `ApiError` type.
- **BDK 0.20 bump.** `bdk_esplora` 0.20 changed enough surface area
  that we couldn't stay on 0.19. The change was mostly mechanical
  but had to land at the same time as the new routes.
- **PSBT finalisation.** Finalising a PSBT signed under our
  timelock branch needs the descriptor to walk the policy and pick
  the right tapscript path. We use the same descriptor the server
  has stored, build a watch-only `bdk_wallet::Wallet` from it, and
  call `finalize_psbt`. No private key material is needed —
  finalisation only assembles witnesses from signatures that are
  already in the PSBT inputs.
- **The single-use bug.** We caught a sequencing bug halfway
  through: the original `resolve_claim` route consumed the token
  on first view, which would have made every second call (build
  PSBT, broadcast) fail with 409. Moved consumption to a
  successful broadcast.

### What was verified
- All 20 `cargo test -p ghostkey-server` tests pass, including 4
  new scheduler tests (covering: ok→alarmed transition, alarmed→
  timelock_started transition, alarmed-before-eligibility doesn't
  transition, idempotent re-issue) and 3 new psbt_routes unit
  tests (URL helpers, env override).
- `cargo test --workspace` is green.
- `cargo clippy -p ghostkey-server --tests` is clean except for
  two pre-existing type-complexity warnings on the `query_as`
  tuples.
- `tsc --noEmit` is clean. `vite build` produces a 221 KB JS
  bundle (66 KB gzip), about 25 KB more than the previous heir
  page.

### What is NOT verified
- No live Esplora endpoint is exercised by `cargo test`. The
  blocking body that does `full_scan` / `broadcast` is structurally
  tested via unit coverage on URL helpers and env override only.
- No signed-PSBT round trip on signet. Verifying that the
  timelock-branch witness assembled by `finalize_psbt` actually
  satisfies the on-chain script needs a live deploy plus a real
  heir wallet. This is the chunk that has to be smoke-tested by
  hand before mainnet. **This is the single highest-priority
  piece of remaining work.**

### What we left for later
- The live signet smoke test (see above).
- A real notification delivery channel (email, SMS, WhatsApp).
- An operator dashboard for the events log.
- Key rotation.
- k-of-n heirs.
- Cold signing for owner check-ins.

See [`DESIGN.md`](./DESIGN.md) § 9 for the full prioritised list.

---

## How to read this file

- **One section per merged feature branch.** If a branch shipped
  multiple features, the section breaks them down.
- **Dates are when the branch merged**, not when work started.
- **"Why now" matters.** Every entry tries to justify the ordering,
  not just the change. If you're considering doing something out of
  order, this is where you'd find evidence for or against.
- **"Hard parts" and "What we left for later" are the most useful
  parts** for a future contributor. They tell you where the
  landmines are and what the next obvious step is.

## How to add a new entry

When you merge a feature branch:

1. Add a new section at the bottom.
2. Use the same template as the entries above.
3. If "What we left for later" includes something a previous entry
   listed, edit the previous entry to mark it done (in a small
   `> done in entry N` note, not by deleting the original).
4. Don't rewrite history. If you got something wrong, add a
   correction in a later entry rather than editing an old one.
