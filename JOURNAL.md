# GhostKey — Build Journal

This is the story of how GhostKey got built.

One entry per feature. Each one explains what we added, why we added it when we did, what gave us trouble, and what we left for the next person. If you're reading the code and wondering why something exists, the answer is probably here.

New contributors: start here before reading the code. It'll save you hours.

---

## Entry 1 — The thing that had to work first

The Bitcoin core — the part that actually moves money. Three Rust crates:

- **ghostkey-core** — the cryptographic engine. Builds vault addresses, constructs transactions, handles key derivation. No network calls, no database, no side effects. Just Bitcoin math.
- **ghostkey-cli** — a command-line tool for owners and heirs. Generates wallets, builds vaults, signs transactions, talks to a Bitcoin node.
- **ghostkey-server** — an empty stub. Just a `main.rs` so the workspace compiles.

We also wrote one end-to-end test that runs on a real local Bitcoin network (regtest): owner sets up a vault, heir tries to claim early (fails — timelock hasn't expired), we mine enough blocks to expire the timelock, heir claims again (succeeds). If this test passes, the fundamental promise of GhostKey works.

### Why this first

The on-chain script is the one piece we cannot change later without breaking existing vaults. Everything else — the website, the server, the emails — can be rewritten, redesigned, or thrown away. The vault construction cannot. So we built it first, tested it thoroughly, and then left it alone.

### What was hard

**Telling BDK which spend path to use.** Our vault address has two ways to spend it: the owner's way (spendable any time) and the heir's way (spendable only after the countdown expires). When we asked BDK to build a transaction, it couldn't decide which path we meant — both looked valid to it. We had to explicitly tell it "use the owner path for check-ins, use the heir path for claims." The fix is a small piece of code in `ghostkey-core/src/psbt.rs`, but it took most of an afternoon to understand the problem.

**The unspendable key.** Every Taproot address has a "master key" that can spend it without going through any script. We don't want that — we want every spend to go through either the owner script or the heir script, with no shortcuts. So we set the master key to a mathematically unspendable value (called a NUMS point). This is a standard Bitcoin technique, but it looks strange in the code to someone who hasn't seen it before. That's what those odd bytes in the descriptor are.

### What we left for later

Everything user-facing. The server was an empty file. There was no website, no emails, no way for a non-developer to use any of this. That was intentional — get the math right first.

---

## Entry 2 — Something you could actually open in a browser


A working server and a first version of the dashboard:

- **Server** — an Axum web server with a SQLite database. Stores vaults and tracks check-in events. Has routes for creating vaults, listing them, checking in, and viewing history.
- **Background scheduler** — checks every 30 seconds whether any vault owner has missed their deadline. If they have, it marks the vault as alarmed.
- **React dashboard** — one card per vault, a countdown showing how long until the heir could claim, and a "Check in" button. Clicking it resets the clock.
- **README and ARCHITECTURE docs** — the first written explanation of how GhostKey works.

### Why now

We wanted to see the full owner experience working before building anything for heirs. Once you could create a vault in a browser and tap a button to keep it alive, we had something real to show people and get feedback on.

### What was hard

**Connecting the development frontend to the server.** In development, the React app runs on one port and the server runs on another. Getting them to talk to each other — and getting error messages to make sense when they didn't — took a few iterations. The final setup uses Vite's proxy feature, which forwards `/api/*` requests from the browser to the server.

**Status colours.** The vault card needed to show at a glance whether everything was fine, a deadline was approaching, or an alarm had fired. We ended up with a small set of named states (`ok`, `warning`, `alarmed`) with consistent colours across the app. Simple in the end, but we went through several versions before it felt right.

### What we left for later

- The heir experience entirely.
- Real authentication — at this point, knowing a vault's ID was enough to interact with it.
- Deployment to a real server.

---

## Entry 3 — Rewriting it for humans

A language and design pass across the whole app. The interface stayed structurally the same, but every piece of copy was rewritten to use plain words instead of technical ones. "Send heartbeat" became "Check in." "This descriptor" became "your vault." The accessibility pass added proper labels for screen readers, visible focus indicators for keyboard users, and a reduced-motion mode for the animated countdown.

We also created `vocab.ts` — a single file that stores every user-facing phrase as a named constant. When we want to change what the app calls something, we change it in one place.

### Why now

The first version was visibly built by engineers for engineers. Before adding more features, we needed to fix the foundation — because every new screen would have inherited the wrong language. Doing the copy pass early meant every subsequent feature started from the right vocabulary.

### What was hard

**Deciding what to simplify and what to keep.** Some Bitcoin terms have no good plain-language equivalent — "address" is already the simplest way to say what an address is. Others ("UTXO," "BIP68," "policy path") can disappear entirely from anything a user sees. Drawing that line took judgment calls on every screen.

### What we left for later

- Everything is still in English. Pidgin is the first translation we plan to ship; Yoruba, Igbo, and Hausa follow.
- There was still no landing page — the app opened directly into the dashboard.

---

## Entry 4 — Different pages for different people

Separate pages for each audience instead of one page trying to do everything:

- **Landing page** — for someone who has never heard of GhostKey. Explains the problem, the solution, how it works, and why to trust it. No login required.
- **Setup wizard** — for an owner creating a new vault. Step by step, one decision at a time.
- **Check-in page** — for an active owner doing their monthly tap.
- **Heir page** — a placeholder at this point; the real heir flow came later.
- **Dashboard** — the existing vault view, now reachable from proper navigation.

We also built a navigation bar and a shared Brand component so the header looks the same everywhere.

### Why now

A single page that was simultaneously a homepage, a setup tool, and a check-in button for returning users was confusing. Splitting by audience meant each page could focus entirely on one job.

### What was hard

**Writing the landing page without sounding like a chatbot.** The hero copy went through at least six rewrites. Phrases like "robust, secure, and seamless" got cut every time. The version that shipped uses specific, human language — what the problem actually feels like, what the product actually does — rather than adjectives that could describe anything.

**Routing without a routing library.** Rather than adding React Router (which would have increased the bundle size), we built a small typed router in `App.tsx` using a discriminated union — a list of every possible page state, each with its own data. Every new page needs a new entry in that union, which is a small tax, but the bundle stayed lean.

### What we left for later

- The actual heir flow.
- Deployment to a public URL.

---

## Entry 5 — Putting it on the internet

The infrastructure to run GhostKey somewhere other than a developer's laptop:

- **Docker image** — packages the server binary into a small container.
- **Fly.io configuration** — one command to deploy the server to a real machine with a persistent database and automatic TLS.
- **DEPLOY.md** — written documentation for three deployment paths: Fly.io (the simplest), a single VPS with Caddy (for self-hosters), and split hosting with Cloudflare Pages (for contributors who want a free tier).
- **Nightly backup instructions** — how to snapshot the SQLite database automatically so a server failure doesn't lose vault records.

### Why now

Until this point, the only people who could test GhostKey were people willing to run both the server and the frontend locally. Deploying to a real URL meant we could share it, get feedback, and catch issues that only appear in production.

### What was hard

**SQLite on Fly.io.** SQLite stores its database in a file, and Fly.io machines don't keep files between restarts unless you attach a persistent volume. The volume has to be created before the first deployment — if you deploy first and create the volume later, you end up with two mismatched states. This is now documented clearly in DEPLOY.md with the exact commands in the right order.

### What we left for later

- A status page or monitoring endpoint. Right now you find out the server is down when someone reports it.
- TLS under Caddy is documented but the production deployment uses Fly's built-in certificates, which is simpler.

---

## Entry 6 — Owners no longer need to use the command line
### What we built

A new server route that accepts an extended public key (xpub) from the owner and builds the vault address automatically. Before this, the owner had to run a command-line tool to generate a vault descriptor, then paste that descriptor into the website. That was two steps when there should be one.

Now the setup wizard collects the xpub (which any wallet can export), sends it to the server, and the server does the rest. The owner never sees a descriptor string.

We also added support for all the different xpub formats that real wallets export — some include derivation path information, some don't, some use different prefixes for testnet. GhostKey now accepts all of them.

### Why now

The original flow required owners to have already used the command-line tool. That made the web app useless as a standalone product — it was just a dashboard for CLI users. This change made the web app the actual entry point.

### What was hard

**Wallets don't agree on format.** Sparrow exports one thing, BlueWallet exports another, Coldcard exports a third. Some include the derivation path, some don't. Some use `xpub`, some use `tpub` for testnet. We handle all of these now, with a clear error message when something doesn't match what we expect.

**Catching mismatches.** If someone pastes a mainnet xpub into a testnet vault, that's a bug we want to catch loudly, not silently accept. The code now checks that the xpub's network matches the vault's network and rejects the combination if they don't agree.

### What we left for later

- Setting up a vault from a plain Bitcoin address (without needing an xpub at all). This is simpler for beginners but gives less flexibility.
- Multiple heirs.

---

## Entry 7 — Heir contact stored securely, claim tokens introduced


Two things that had to ship together:

**Encrypted heir contact.** The heir's name and contact details are personal information. Storing them in plaintext in the database would be a problem if the database were ever leaked. Now every vault has its heir contact encrypted with a key derived from a server master secret. The server refuses to start if the master key is not set — we'd rather crash loudly than run with unprotected data.

**One-time claim tokens.** When a vault alarm fires and it's time for the heir to claim, we need a way to give them access without creating an account. The answer is a one-time token — a random string that works exactly once, sent to the heir and stored (as a hash, not the raw value) in the database. The heir's link contains this token. Once they successfully claim, the token is consumed and the link stops working.

### Why now

We were about to build the heir's page — the thing they see when they follow the claim link. That page would handle personal information and a sensitive access token. Getting the security properties in place before writing the page meant the heir feature could ship without a "we'll add encryption later" note.

### What was hard

**Where to keep the master key.** The key has to be loaded once at startup, be available to any part of the code that needs it, and never leave the server. We use a Rust `OnceLock` — a value that can only be set once and then never changed. If the environment variable is missing or malformed at startup, the server exits with a clear error message.

**What to encrypt and what not to.** We considered encrypting the vault descriptors too. We decided against it — descriptors are public information (anyone watching the blockchain can see the vault's address), so encrypting them would be security theatre. Personal information gets encrypted; protocol data doesn't.

### What we left for later

- The heir-side page (next entry).
- A real way to deliver the token to the heir. At this point it was still sitting in the database waiting for an operator to copy it out manually.

---

## Entry 8 — The first thing an heir sees

### What we built

The page someone sees when they follow a claim link — possibly while grieving, possibly while confused about what Bitcoin is, definitely without any prior GhostKey knowledge.

The page handles five situations:

- **Loading** — while the server looks up the token.
- **Link not found** — the token is wrong or expired.
- **Already used** — someone has already claimed with this link.
- **Not ready yet** — the countdown hasn't finished (shouldn't normally happen, but handled gracefully).
- **Ready to claim** — the main path. Step-by-step instructions.

At this point the page ended honestly: "we can't transfer the funds automatically yet — here's what to do next." The actual transfer mechanism came in the next entry.

### Why now

With encryption and tokens in place, we could finally build the heir experience. We shipped the page without the transfer mechanism deliberately — we wanted to test the language and the layout with real people before adding technical complexity.

### What was hard

**The tone.** This is probably the hardest copy problem in the project. The heir might be grieving. They've probably never used Bitcoin. They've received a message from a dead person. Every word on this page matters. We rewrote it twice. The opening line became: "Someone you knew left you Bitcoin." Simple. True. Not cheerful, not clinical.

**Hiding the navigation.** Every other page shows the GhostKey header with links to other parts of the app. The heir doesn't need any of that — they have one thing to do. We detect the claim route in `App.tsx` and render a minimal version of the page without the standard navigation.

### What we left for later

- The actual transfer. The page told heirs what to do but couldn't do it for them.

---

## Entry 9 — The full transfer, end to end

### What we built

The piece that makes GhostKey a finished product rather than a prototype: the heir can now receive their Bitcoin without needing technical help.

**On the server side:**
- The scheduler now automatically issues a claim token when a vault's countdown expires. The heir gets access at the right moment without anyone having to press a button.
- A new route builds an unsigned transaction and returns it to the heir's browser. The server scans the blockchain to find the vault's current funds, calculates fees, and prepares a transaction sending everything to the heir's chosen address.
- Another new route accepts a signed transaction from the heir and broadcasts it to the Bitcoin network, then marks the vault as claimed.

**On the heir's page:**
- Step 1: enter a Bitcoin address to receive the funds.
- Step 2: review the transaction summary (how much is coming, what the fee is) and copy the unsigned transaction.
- Step 3: sign the transaction in a Bitcoin wallet and paste it back.
- Step 4: the server broadcasts it. The heir sees a confirmation and a link to track it on the blockchain.

### Why now

Without this, the heir's experience ended with "find someone who knows Bitcoin to help you finish." That's not good enough. This closed the loop.

### What was hard

**Mixing blocking and async code.** The library we use to read the blockchain (esplora_client) is blocking — it waits for a response before continuing. Our server is async — it handles many requests at once without waiting. You can't call blocking code directly from async code without freezing the server. The solution is `tokio::task::spawn_blocking`, which runs the blocking code in a separate thread pool. Every blockchain call goes through this wrapper.

**Finalising the transaction.** When the heir signs a transaction with their wallet, their signature goes into the transaction file. The server then needs to assemble that signature into a valid broadcast transaction. This process (called "finalisation") needs to know which Bitcoin script to satisfy — in our case, the heir's spend path in the vault script. We use the stored vault descriptor to reconstruct the right script path and assemble the witness.

**A bug with one-time tokens.** We found halfway through that our original design consumed the claim token on the heir's first page visit — meaning every subsequent step (build transaction, broadcast) would fail with "link already used." The fix was to only consume the token on a successful broadcast, not on first view. The lesson: "single-use" means single successful use, not single view.

### What we verified

All tests pass. The JavaScript bundle is 221 KB compressed — about 25 KB more than before, which is the cost of the transaction-building UI.

### What has NOT been verified

The live path — signing an actual transaction on a real test network and broadcasting it — has not been tested end to end. The code is correct by construction (the logic is well-tested) but we haven't watched real money move through a real claim. **This is the most important remaining task before GhostKey can be used with real funds.**

### What we left for later

- The live test on signet (see above — highest priority).
- Notifications: email, SMS, WhatsApp. The heir currently has to be told about the link some other way.
- Multiple heirs.
- Translations: Pidgin first (highest-impact for the Nigerian audience, single language so the i18n shell stays simple), then Yoruba, Igbo, Hausa.
- Key rotation for the server master secret.

---

## Entry 10 — Lightning check-ins and a sidecar that can be replaced

A second way for the owner to prove they're still alive: pay a one-sat Lightning invoice that the server mints for them. Tapping the dashboard button trusts the server's clock; paying a real Lightning invoice is a cryptographic act the server cannot forge. We call it "stronger than a button, weaker than an on-chain re-vault."

What we built:

- A `LightningProvider` trait in `crates/ghostkey-server/src/lightning.rs` with two implementations: `NoopProvider` (the default; routes return 503 and the web UI hides the button) and `HttpProvider` (talks JSON over localhost to a backend binary).
- A standalone crate, `crates/ghostkey-lightning-breez`, that wraps Breez SDK Liquid and exposes three routes (`POST /v1/invoice`, `GET /v1/status/:hash`, `GET /v1/health`). It's explicitly excluded from the root workspace; it lives in its own single-crate workspace so its dependencies don't poison the main build.
- Server-side plumbing: a `lightning_invoices` table, a background poller, a state machine that marks invoices `paid` / `expired` / `failed` and resets the vault's check-in deadlines on payment exactly the way the dashboard button does.
- Tests for the HTTP wire surface: happy path, wrong-secret 401, zero-amount client-side rejection, status-string mapping, malformed payment hash, and a proof that `is_enabled()` never does I/O.

### Why a sidecar instead of a direct dependency

Breez SDK Liquid pins `reqwest = "=0.12.18"` exactly. That collides with every other crate in the GhostKey workspace. The crate is also only on git, not on crates.io, and pulls in roughly six forked transitive deps. We tried adding it as an optional feature and the build broke immediately.

The sidecar pattern is what Lexe and Breez themselves use for their public SDKs. The trade-off — one extra process to run — buys us a clean main build, independent restarts, and the ability for any contributor to clone GhostKey and `cargo build` without ever needing a Breez API key.

### What was hard

**Breez itself doesn't currently compile.** Tag `0.12.2` (the latest stable as of writing) fails on its transitive `boltz-client` git revision, which references MuSig types absent from the resolved `secp256k1_zkp`. Tag `0.12.3-dev1` pins the same boltz-client and breaks identically. None of this is our code. We documented the failure in three places (the sidecar's README, its Cargo.toml header, and DESIGN.md) and noted that *any* Lightning backend implementing the same three-route HTTP surface will work: LND, CLN, LNbits, BTCPay, Phoenixd. The wire protocol is the long-lived contract; Breez is the first implementation, not the only one.

**The server has to stay completely insulated.** Whether the sidecar builds or not, whether it runs or not, the main `ghostkey-server` must compile, ship, and serve real traffic. We enforced this by selecting between providers via env vars (`GHOSTKEY_LN_BREEZ_URL` + `GHOSTKEY_LN_BREEZ_SHARED_SECRET`); unset means `NoopProvider` and the `/lightning-checkin/*` routes return 503 with a clear message.

### What we left for later

- An ops endpoint that surfaces the sidecar's `/v1/health` readiness on the main server's `/health` (currently we only report `lightning_enabled` as a binary).
- Webhooks. We poll every three seconds (one second in demo mode). Adding the SDK's event stream would be lower-latency.
- A second backend implementing the wire surface against LND or CLN, useful for any operator who can't run Liquid.

---

## Entry 11 — Demo mode

Real GhostKey cadences are measured in days. That makes the product impossible to show on a video call: you'd have to fake-forward the clock or wait a fortnight to demonstrate the alarm → claim-token → heir-page transition. Demo mode trades safety for showability, but only on a deployment where the operator explicitly opts in.

What we built:

- `GHOSTKEY_DEMO_MODE=1` env flag in a new `crates/ghostkey-server/src/demo.rs` module. Cached in a `OnceLock`, logs a loud warning on first read so an accidental production toggle is unmissable in the boot log.
- Two cadence floors: 1 hour / 60 seconds in production, 5 seconds / 3 seconds in demo. A `validate_periods()` helper applies the right floor and is called from both creation routes; adding a third creation path later inherits the gate for free.
- Network safety: `ensure_demo_safe_for_network()` refuses to create a `"bitcoin"` (mainnet) vault when demo mode is on. The flag is forbidden in that combination; signet/testnet/regtest only.
- Scheduler tick and Lightning poller tick automatically drop to one second when demo mode is on, regardless of what the operator passed on the CLI. We log the override so a stale `GHOSTKEY_TICK_SECS=30` carried over from production doesn't silently kill the demo.
- `/health` now returns `demo_mode: bool` alongside `lightning_enabled`.
- Web: `timing.ts` exposes `DEMO_CADENCE_PRESETS` (10 s / 30 s / 2 min) and `DEMO_GRACE_PRESETS` (5 s / 15 s / 1 min). Both setup portals fetch `demo_mode` from `/health` on mount and swap their pickers. `App.tsx` renders a persistent amber "Demo mode" banner directly under the alpha banner on every non-claim page.
- Compile-time `const _: () = assert!(...)` in `demo.rs` guarantees the demo floors stay strictly below the production floors — a future contributor who narrows one without the other gets a build error.

### Why now

The Lightning + sidecar work in Entry 10 unlocked a new way to demonstrate liveness, but the rest of the flow — set up vault → miss check-in → alarm → claim — still takes weeks at realistic cadences. We can now walk a person through the whole story in under a minute, which makes the project actually showable.

### What was hard

**Drawing the line between "loose" and "dangerous".** Demo mode loosens cadence validation but does not loosen any cryptographic check: owner tokens, master-key encryption, claim-token single-use enforcement — all unchanged. It also refuses mainnet vaults outright. Even with those guards, "I made this server unsafe for demos" is the kind of mistake that's easy to forget about in production, so we settled on three independent signals: a startup warning, a persistent UI banner, and a per-creation-step inline note next to the cadence picker.

**Test isolation.** `demo_mode()` is cached in a `OnceLock`, so a test that flipped the env var would pollute every later test in the same process. The unit tests therefore exercise `validate_periods()` directly with both branches rather than trying to toggle the global flag.

### What we left for later

- A `/demo` landing page that scripts the full walkthrough (set up → check in → wait → alarm → claim) with narration. Right now the operator drives it manually.
- A signet integration so demos can include the on-chain claim. The off-chain state machine is now demoable; the on-chain part still needs blocks.

---

## Entry 12 — The owner finds out before the heir does

Before this entry, the owner only learned they missed a check-in when their heir's claim window opened — that is, after the system had already started the inheritance process. Too late. They needed a real nudge at the moment the alarm fired, with one last chance to come back.

What we built:

- A small migration (`20260527000001_owner_contact_sealed.sql`) adding three nullable columns: `owner_contact_ciphertext`, `owner_contact_nonce`, `owner_contact_channel`. Same encryption story as the heir's contact — sealed per-vault with a key derived from the server master secret, plaintext never lands in SQLite.
- A new `OwnerContact` helper and `parse_owner_contact()` function in `notifier.rs`, mirroring the shape of the existing heir-contact helper.
- The scheduler's `transition_ok_to_alarmed()` now decrypts the owner contact (when present) and enqueues an `AlarmOwner` email through the same worker that already delivers heir claim links. The `NotificationKind::AlarmOwner` enum variant had been sitting `#[allow(dead_code)]` since the notifier was built — we removed the lint and the comment, and the worker has nothing to add because it didn't care about the kind in the first place.
- Both setup portals (`PasswordSetupPortal`, `SetupPortal`) now capture an owner email and send it as `owner_contact` + `owner_contact_channel: "email"` to the server. The password portal already had `ownerEmail` for the password-vault sign-in; the legacy portal needed a new optional field on the Wallet step.
- Three new scheduler tests pinning the contract: a vault with sealed owner contact enqueues exactly one notification on alarm, a legacy vault without one transitions silently, and a follow-on tick doesn't re-enqueue.

### Why now

The notifier was already capable of sending the email — only the scheduler trigger and the storage shape were missing. The product had a credibility hole until this shipped: an owner who set up a vault, then forgot about it for a few weeks, would discover the problem when their heir got an email that they (the owner) never got first. With this change there's always a hop in between, and that hop happens at the exact moment the owner can still act.

### What was hard

**Where to put the channel column.** The heir's contact is a JSON blob with name + address + channel inside the ciphertext. We considered the same shape for the owner. We ended up with a separate `owner_contact_channel` plaintext column because the owner contact is much simpler — there's no name to display, no list of secondary contacts — and the channel itself is not a secret. Keeping it out of the ciphertext lets us filter on it in SQL later (e.g. "fetch every vault whose owner is reachable via SMS") without a per-row decrypt.

**Avoiding double-sends.** A naïve scheduler tick that re-checked every `alarmed` vault would re-enqueue an "you missed your check-in" email every 30 seconds. The fix is implicit: the `transition_ok_to_alarmed()` query already filters `WHERE status = 'ok'`, so the second tick sees an empty result set. A new test (`alarm_does_not_re_enqueue_on_subsequent_ticks`) pins this against an accidental refactor that broadens the predicate.

**The legacy plaintext column.** `owner_contact TEXT` from the original schema is still there. We considered dropping it; we decided not to, because some operator might have written into it through a non-UI path (the legacy CLI route, an admin script). New code reads the sealed columns first; the legacy column is now write-NULL from the xpub route and stays untouched for everything else.

### What we left for later

- A pre-deadline reminder ("your check-in is due in 24h"). We deliberately shipped only the alarm-fired notice this round to avoid a new column and migration; the pre-deadline version needs a `last_reminder_at` field to avoid re-sending every tick. — *Shipped in Entry 13.*
- SMS and WhatsApp delivery rails. The data model now carries the channel; the worker still only knows how to talk SMTP. — *Shipped in Entry 14.*
- An owner-side "I got your email, here's my check-in" deep link that takes the bearer token from the email and reduces the dashboard to a single tap. — *Shipped in Entry 13.*
- A live signet end-to-end run. This remains Entry 9's highest-priority open item.

---

## Entry 13 — Tap once from the email

Closes two gaps that had been on the "what we left for later" list since Entry 12. The owner now gets:

1. A pre-deadline reminder 24 hours before their next check-in is due.
2. A one-tap link in BOTH that reminder AND the alarm-fired email. Tapping it checks them in directly — no password, no dashboard, no friction.

What we built:

- **Migration `20260528000001_pre_deadline_and_one_tap.sql`** — four new nullable columns on `vaults`: `pre_deadline_reminder_sent_at` (the per-cycle marker), and `checkin_link_token_{hash,issued_at,used_at}` (the one-tap token, stored hashed at rest). An index on the hash column for the lookup.
- **New scheduler step `issue_pre_deadline_reminders()`** — runs every tick before the existing `transition_ok_to_alarmed`. Finds vaults where the deadline is within 24h (configurable via the `PRE_DEADLINE_REMINDER_LEAD_SECS` constant), has a sealed owner contact, and hasn't been reminded this cycle. Enqueues a `NotificationKind::PreDeadlineReminder` and sets the marker.
- **`mint_or_reuse_one_tap_token()` helper** — mints a fresh token if there isn't a live one, OR returns `None` if a live token already exists (so a follow-on reminder doesn't invalidate the URL we already mailed). The alarm email reuses the same helper, so the link from the reminder keeps working when the alarm hits.
- **New HTTP route `POST /vaults/:id/checkin-from-link/:token`** — no `OwnerAuth` extractor, the token IS the auth. Constant-time hash compare, single-use (consumed on first POST), same SQL reset as the bearer-auth `checkin` route.
- **All three check-in paths now clear the per-cycle markers** (the existing button/lightning routes plus the new one-tap route). Without this, a successful check-in would leave a "we already reminded you" marker on the row and the next cycle would skip.
- **Web `OneTapCheckinPage.tsx`** — three states (checking-in, ok, expired), no navbar (came-from-email pattern), React 18 strict-mode guard against the double-fire that would otherwise flash "expired" on every dev page load.
- **9 new tests** — 6 in scheduler covering the pre-deadline lifecycle (fires inside window, doesn't fire outside, single-shot per cycle, skips without sealed contact, re-eligible after check-in, token reused across reminder + alarm), and 4 in auth's `http_tests` covering the new route (success + markers cleared, wrong token, wrong vault, double-tap).

### Why now

Two parts of the same story. Entry 12 added the alarm-fired email but the owner still had to remember their password and dashboard URL to act on it. The realistic failure mode was: the owner sees the email on their phone, taps the link out of curiosity, lands on a sign-in page they don't remember the password for, closes the tab. Without the one-tap link, the alarm email was almost decorative. With it, the email becomes a real call to action — and the pre-deadline reminder gives them a chance to act *before* the alarm even fires.

### What was hard

**Reusing the token across emails.** The naive design mints a token in the pre-deadline reminder, then the alarm step a few hours later mints another one and stores a different hash — silently breaking the link in the reminder email the owner might tap any moment. The fix is `mint_or_reuse_one_tap_token`: if there's a live token on the row, return `None` (caller skips the new mint) so the alarm email reuses the existing URL. The CAS-style `UPDATE ... WHERE checkin_link_token_hash IS NULL` clause guards against two concurrent ticks producing two tokens.

**React 18 strict-mode double-fire.** The one-tap page POSTs on mount. In strict mode (dev only), `useEffect` runs twice; the second run would land after the first scrubbed the token, and the user would see "expired" half a second after tapping. Standard fix: a `useRef` guard checked + set inside the effect. The production runtime doesn't double-mount, so the guard is no-op there.

**The deploy was secretly broken for weeks.** While building this, we discovered the Fly deploy job had been silently failing on every push since Entry 10 — the workflow exited in 5 seconds because `FLY_API_TOKEN` was expired/revoked, but the failure looked like a no-op success because the older `flyctl-actions@master` didn't always propagate exit codes. Hardened the workflow to: pin `flyctl` to `v0.4.55`, probe `flyctl auth whoami` BEFORE the deploy with a clear `::error::` annotation when auth fails, and pass `--verbose` to the deploy itself.

### What we left for later

- User-configurable pre-deadline lead time (instead of the hardcoded 24h). Would need a new column + UI picker; deferred until someone asks.
- An "and you can also stop the heir email" deep link, distinct from the regular check-in (e.g. for the owner who wants to pause the system without resetting the cadence).
- A live signet end-to-end run. Still Entry 9's highest-priority open item.

---

## Entry 14 — SMS and WhatsApp, the same way Twilio sends both

The notifier worker only spoke SMTP. The data model carried `Channel::Sms` and `Channel::Whatsapp` since Entry 12, and every vault wizard step lets the user pick a channel — but enqueueing a notification on either of those channels meant the row sat in `pending` forever. This entry closes that loop.

What we built:

- **`Channel::Sms` and `Channel::Whatsapp` are now real variants** — they were strings the wizard accepted; now they're enum members with `from_str` / `as_str` round-trips.
- **`TwilioConfig::from_env()`** — reads `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_SMS_FROM`, `TWILIO_WHATSAPP_FROM`. All four required together; a partial config logs a loud warning listing the missing names and stays disabled. An optional `TWILIO_API_BASE_URL` override exists for tests (defaults to `https://api.twilio.com`).
- **`send_twilio()`** — one POST to Twilio's Programmable Messaging endpoint, HTTP Basic auth with SID:AUTH_TOKEN, form-encoded body. WhatsApp gets the `whatsapp:` prefix on both `From` and `To` (Twilio routes by prefix). Same endpoint for both channels.
- **`dispatch_send()` helper** — small switch that takes a `Channel` and the right backend config, and returns one of: `None` (no backend configured for this channel, leave the row pending), `Some(Ok(()))` (delivered, flip to `sent`), `Some(Err(e))` (retry or permanent per the existing backoff). Keeps the worker loop's bookkeeping in one place.
- **`Backends` struct** — bundles the optional SMTP + optional Twilio configs so a future provider (Phoenixd, MessageBird, Africa's Talking, …) is a one-field addition rather than a function-signature change.
- **8 new tests** — config loading (happy path + unset + partial + base-URL override), HTTP round-trip (SMS with bare E.164, WhatsApp with prefix, Twilio refusing the Email channel as a defensive guard, 4xx body surfaced as `SendError::Twilio`).

### Why Twilio

The earlier design question was "Twilio, Termii, or a full provider abstraction." Twilio wins for now because:

1. **Same API for SMS and WhatsApp.** One config, one code path, one set of credentials. Adding a separate provider per channel would have meant two config-loading helpers, two HTTP clients, two retry-policy decisions. Twilio collapses those into one.
2. **Available in Nigeria.** Both SMS and WhatsApp work in Nigeria via Twilio. Delivery rates aren't as good as Termii (which is Nigeria-native), but the difference is "92% vs 98%" not "works vs doesn't" — fine for alpha, and the abstraction we built lets us add a second backend later without touching the worker loop.
3. **Free tier for development.** New Twilio accounts get a sandbox WhatsApp number and a small SMS credit, which is enough to test the whole flow end-to-end without a credit card.

### What was hard

**Different opaque future types in the dispatch match.** The first cut of `dispatch_send` looked like `Some(send_email(...))` in one arm and `Some(send_twilio(...))` in the other, then `.await`-ed the outer Option. Doesn't compile — each `async fn` produces a distinct opaque type, and `match` arms have to agree on their output type. The fix is to `await` inside each arm and only THEN wrap in `Some`, which is also what a reader would write without thinking; the cleverness was a mistake.

**`twilio` crate vs raw `reqwest`.** The official Twilio Rust crate exists but pulls in its own HTTP stack and a much wider surface than we need. We already have `reqwest` for the Lightning HTTP provider, and the Twilio API surface we touch is one POST — adding a crate would have meant another dependency without saving any code.

**Doc comment lint.** Clippy's `doc_list_item_overindented` lint started catching the four-space continuation lines I used for the env-var docs. Reformatted to single-line item descriptions; the file's prettier for it.

### What we left for later

- A second backend (Termii for Nigeria-native delivery, or LNbits for a non-Twilio WhatsApp path). The `Backends` struct already supports this — `tick_once` would learn one more `match` arm, no scheduler changes.
- A delivery-status webhook from Twilio. Today we know we "sent" the message; we don't know if it was actually delivered to the device. Twilio POSTs a status callback if you give it a URL; we'd need to add one route to the server and update the `notifications.status` based on it.
- A live signet end-to-end run. Still Entry 9's highest-priority open item.

---

## How to use this journal

**Read it front to back once** when you join the project. Then use it as a reference when you encounter something confusing in the code.

**The "What was hard" sections** are the most useful. They tell you where the traps are.

**The "What we left for later" sections** tell you what to build next. If something appears in multiple entries, it's been on the list a while and probably matters.

**When you merge a feature branch, add an entry.** Same format. If your work finishes something from a previous "left for later" list, add a small note to that entry pointing at yours. Don't rewrite old entries — add corrections in new ones.

The goal is that anyone who reads this file can understand every major decision in the codebase without having to ask the original author.