# 10-minute GhostKey walkthrough

A guided tour of the codebase for a new contributor who has never read
a Bitcoin descriptor in their life. Goal: by the end, you can point at
any file in the repo and have a rough sense of what owns what.

If you are looking for the dense reference, that is
[`ARCHITECTURE.md`](../ARCHITECTURE.md). This file is the on-ramp.

Pre-reqs: skim [`README.md`](../README.md) for the product framing and
[`DESIGN.md`](../DESIGN.md) for the "why this shape" story. You do
**not** need to understand Bitcoin script to read this walkthrough.

---

## 60 seconds — what is GhostKey?

A Bitcoin inheritance vault. The owner picks an heir and a timeout
(say "9 months"). As long as the owner clicks a button every so often
("checking in"), nothing happens. If they stop clicking — they died,
got hit by a bus, lost their phone — the heir can claim the funds
after the timeout elapses.

The product promise:

- **The server never holds your keys** (with one narrow exception we
  explain in the claim section).
- **You cannot lose access if you stay alive and remember your
  password**: checking in is a button tap.
- **Your heir cannot steal early**: a Bitcoin script enforces the
  timer, not the server. If the server vanishes, the heir can still
  claim (a few blocks later, but they can).

That last point is the whole point. Everything else is operational
glue around a single Bitcoin transaction.

---

## 3 minutes — what happens when an owner taps "Check in"

The check-in button is the most common interaction. Trace it once and
you know how the server is wired.

### Step 1 — the click

[`ghostkey-web/src/Dashboard.tsx`](../ghostkey-web/src/Dashboard.tsx)
renders the dashboard. The check-in button issues
`POST /vaults/:id/checkin` with the owner's bearer token (kept in
`localStorage` after vault creation).

### Step 2 — the request hits the server

The router is wired in `crates/ghostkey-server/src/routes.rs` —
look for the `.route("/vaults/:id/checkin", post(checkin))` line.
The handler is `checkin` in the same file. It:

1. Looks up the vault by id.
2. Validates the bearer token against the stored hash (constant-time
   compare — see `auth.rs`).
3. Enforces the once-per-period rule (the server will refuse a second
   check-in inside the configured cadence; this is the "you can't
   spam the button to fake activity" guard).
4. Updates the vault's `last_checkin_at` and `deadline_at`.
5. Appends a `checkin` event to the `events` table.

The one-tap email variant lives in the `checkin_from_link` handler
right below it — same effect, but the token *is* the auth, no
password needed. That is how the "tap the link in the email"
reminder works.

### Step 3 — the scheduler picks up the new deadline

The background scheduler ticks every 30 seconds
(`crates/ghostkey-server/src/scheduler.rs`). On each tick it:

- Finds vaults whose deadline is approaching → enqueues a reminder
  notification.
- Finds vaults whose deadline already passed → marks them `alarmed`,
  enqueues the heir-notification email (with a claim token).
- Finds vaults whose timelock has fully elapsed → marks them
  claimable.

The notifier (a sibling task) drains the `notifications` queue and
actually sends the SMTP / SMS messages.

**Where on-chain comes in:** the heartbeat above is the *off-chain*
check-in (cheap, instant, only resets the server's timer). The
*on-chain* check-in is the CLI's `check-in` command (in
`crates/ghostkey-cli/`). It spends the vault UTXO back into a fresh
vault address with the same script, which resets the BIP68
confirmation counter. The product nudges the owner to do an on-chain
check-in periodically, but the daily / weekly cadence is off-chain.

---

## 5 minutes — what happens during a claim

The hard path. Two flows exist; we'll walk through the
password-vault flow because it's the most surprising.

### Step 1 — the owner has gone silent

The scheduler notices the deadline passed and the owner did not
check in. It:

1. Marks the vault `alarmed`.
2. Generates a random 32-byte claim token (stores only the
   SHA-256 hash; returns the raw token once, in the email).
3. Enqueues the "heir claim" email — the heir gets a link like
   `https://www.ghostkeyapp.com/claim/<token>`.

### Step 2 — the heir opens the link

[`ghostkey-web/src/Claim.tsx`](../ghostkey-web/src/Claim.tsx) (or
the routed claim view) hits `GET /claim/:token` on the server.

The server returns one of five states: loading, not found, already
used, not ready (timelock hasn't elapsed yet), or claimable. The UI
renders accordingly.

If the vault was created via the password wizard (most common for
non-Bitcoiners), the server also has a sealed heir xprv — the
private key encrypted with a KEK derived from the claim token. The
browser will need this in step 3.

### Step 3 — the heir provides a destination address

The heir pastes a Bitcoin address from any wallet they control —
hardware wallet, Sparrow, Cake, whatever. The browser unwraps the
sealed heir xprv using HKDF over the claim token, then ships the
xprv over TLS to the server's `POST /claim/:token/heir-claim`
endpoint along with the destination.

### Step 4 — the server signs and broadcasts

`heir_claim` lives in
[`crates/ghostkey-server/src/psbt_routes.rs`](../crates/ghostkey-server/src/psbt_routes.rs).
It:

1. Reconstructs the heir-side BDK wallet from the stored descriptor.
2. Calls `ghostkey_core::psbt::build_heir_claim` (script-path
   selection, `nSequence = N` for BIP68).
3. Signs in memory with the xprv received in the request.
4. Broadcasts via the configured Esplora endpoint.
5. Atomically marks the claim token consumed (the
   `claim_token_used_at IS NULL` predicate is the CAS gate that
   prevents double-spend races).
6. Drops the xprv when the function returns. It is never written
   to disk or tracing output.

**This is the "narrow server-signing exception" mentioned in the
intro.** During the seconds this call takes, a compromised server
could redirect the funds. We accept this because:

- The timelock has already matured by this point — only the heir
  benefits from spending the UTXO.
- The on-chain trail is public; theft is detectable immediately.
- Re-implementing Taproot script-path PSBT signing in the browser
  is a significant chunk of audited cryptography we didn't want to
  ship before getting the product validated.

A second claim flow — the legacy two-step `build-psbt` +
`broadcast` — exists for heirs who own Bitcoin and want to sign
with their own wallet. It uses the same PSBT machinery without the
server-signing step. CLI-created vaults default to this flow.

---

## 1 minute — what we deliberately don't do

These come up a lot in contributor questions. The answer is "no,
on purpose":

- **No custody.** The server never holds plaintext owner keys in
  steady state. The one exception (above) is bounded to a single
  request scope.
- **No KYC.** No emails or addresses are validated against an
  identity provider. We encrypt the contact at rest and use it
  only to deliver reminders.
- **No recovery if both the check-in and the password are lost.**
  If an owner forgets their password *and* stops checking in, the
  heir's claim flow is the only path to the funds. That is by
  design: a "support recovery" path would be a custody path.
- **No early access for the heir.** The script enforces the
  timelock on the Bitcoin mainnet. Even a fully malicious server
  cannot let the heir claim before `N` blocks elapse — the
  mempool will reject the transaction as non-BIP68-final.
- **No mainnet (yet).** The web UI ships pinned to testnet /
  signet. See [`SIGNET_E2E_RUNBOOK.md`](../SIGNET_E2E_RUNBOOK.md)
  for the live-network smoke test that gates mainnet.

---

## Where to go next

If you want to:

- **Touch the Bitcoin script logic** — start with
  [`crates/ghostkey-core/src/psbt.rs`](../crates/ghostkey-core/src/psbt.rs)
  and the regtest end-to-end test
  (`crates/ghostkey-core/tests/regtest_e2e.rs`). Run it with
  `cargo test --workspace --ignored regtest`.
- **Touch the server** — start with `routes.rs` (the route table at
  the top tells you what handlers exist), then `scheduler.rs` if
  you want to understand the background loops.
- **Touch the dashboard** — start with
  `ghostkey-web/src/Dashboard.tsx`. The wizard for creating a
  vault is `ghostkey-web/src/SetupWizard.tsx`.
- **Touch ops / CI** — `.github/workflows/`, `Dockerfile`,
  `fly.toml`, and the runbooks in this `docs/` directory.

If you find this walkthrough out of date (file moved, function
renamed, flow changed), please open a small PR fixing it. The on-ramp
only works if it stays accurate.
