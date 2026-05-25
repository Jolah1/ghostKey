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

- Everything is still in English. Yoruba, Igbo, and Hausa translations are on the list.
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
- Translations into Yoruba, Igbo, Hausa.
- Key rotation for the server master secret.

---

## How to use this journal

**Read it front to back once** when you join the project. Then use it as a reference when you encounter something confusing in the code.

**The "What was hard" sections** are the most useful. They tell you where the traps are.

**The "What we left for later" sections** tell you what to build next. If something appears in multiple entries, it's been on the list a while and probably matters.

**When you merge a feature branch, add an entry.** Same format. If your work finishes something from a previous "left for later" list, add a small note to that entry pointing at yours. Don't rewrite old entries — add corrections in new ones.

The goal is that anyone who reads this file can understand every major decision in the codebase without having to ask the original author.