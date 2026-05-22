# GhostKey — Design

This document is the long, plain-English version of "what is this thing,
why is it built this way, and what would we do next". The
[`README`](./README.md) is the short user-facing version. The
[`ARCHITECTURE`](./ARCHITECTURE.md) document is the dense technical
reference for someone who's already comfortable with Bitcoin script and
Rust. This file sits between them.

If you only read one document, read this one.

---

## Table of contents

1. [What problem are we solving?](#1-what-problem-are-we-solving)
2. [The two-sentence design](#2-the-two-sentence-design)
3. [How a vault works, step by step](#3-how-a-vault-works-step-by-step)
4. [Why each piece of software exists](#4-why-each-piece-of-software-exists)
5. [What the server can and cannot do](#5-what-the-server-can-and-cannot-do)
6. [The heir's experience, end to end](#6-the-heirs-experience-end-to-end)
7. [Security choices and their consequences](#7-security-choices-and-their-consequences)
8. [Where AI could fit (and where it shouldn't)](#8-where-ai-could-fit-and-where-it-shouldnt)
9. [What we'd build next](#9-what-wed-build-next)
10. [Glossary](#10-glossary)

---

## 1. What problem are we solving?

Bitcoin is bearer money. If you die without telling anyone how to
access your wallet, the coins are gone. Not stolen — gone. There's no
bank to call, no probate court that can move them, no recovery email.

The traditional answers to this problem are all bad:

- **Write the seed phrase down and put it in a safe.** Whoever finds
  it controls everything. They can spend it today, while you're alive.
  You have to trust them completely.
- **Give the seed to a lawyer.** Same problem, with a stranger.
- **Use a custodial service.** Now the service holds your coins. If
  they get hacked, you lose. If they go out of business, you lose. If
  they freeze your account, you lose.
- **Multi-signature with a "trustee" co-signer.** Better, but the
  co-signer can still collude with the heir, or block a legitimate
  spend, or simply lose their key.

GhostKey is a fourth option:

> **You keep full control of your Bitcoin. Your heir can claim it only
> after you've been silent for a chosen amount of time. Nobody else can
> ever touch it.**

The mechanism that enforces this lives on the Bitcoin network itself,
in a small piece of script every Bitcoin node already knows how to
verify. No third party can override it.

---

## 2. The two-sentence design

Every GhostKey vault is a single Bitcoin address with a rule attached:

1. The owner can spend from it at any time.
2. The heir can spend from it, but only after a chosen number of
   blocks (roughly: hours, days, or weeks) have passed since the coins
   last moved.

Everything else in the project — the dashboard, the notifier, the
check-in button, the heir's claim page — is **comfort software**. It
makes the system pleasant to use. It cannot change who controls the
coins.

If GhostKey the company shut down tomorrow, every existing vault would
still work. The owner could still spend. The heir could still wait out
the timelock and claim. The Bitcoin network does not care whether our
servers are up.

---

## 3. How a vault works, step by step

Let's walk through the life of one vault. We'll call the owner Ada and
the heir Ben.

### Step 1: Ada and Ben each generate a wallet

Each of them runs the GhostKey CLI (or uses any standard Bitcoin
wallet that can export an extended public key, like Sparrow). Out comes
a 12-word recovery phrase. Ada keeps hers; Ben keeps his. **Neither
phrase ever leaves their device.**

Each phrase produces an extended public key (an "xpub"). The xpub is
public information — sharing it lets someone watch your incoming
transactions but not spend them. Ada and Ben exchange xpubs over any
channel they trust.

### Step 2: Ada creates the vault

Ada feeds her xpub and Ben's xpub, plus a timelock (say, 144 blocks —
about 24 hours; for real use you'd pick weeks or months), into the
GhostKey setup wizard. The wizard computes a single Bitcoin address
and a matching "descriptor" — a precise written-down version of the
rule above. Ada saves the descriptor. She funds the address with
Bitcoin from her regular wallet.

The address looks like every other Taproot address (starts with `bc1p`
on mainnet). To anyone watching the chain, it's a normal payment.
There's nothing visibly different about a GhostKey vault until either
Ada or Ben tries to spend from it.

### Step 3: Ada registers the vault with the notifier

The notifier is our small server. Ada visits the GhostKey dashboard,
pastes her descriptor, and sets two numbers:

- **Check-in period**: how often she'll tap "I'm OK". Say, once a week.
- **Grace period**: how long after a missed check-in before the alarm
  fires. Say, 24 hours.

She also enters Ben's contact info (email, SMS, or WhatsApp). The
server encrypts this contact info at rest using a key derived from a
server-wide master key. The plain version of Ben's address never
touches our database.

The server now knows: a vault exists, here's its descriptor (so we can
look up its on-chain address), here's the cadence, here's how to reach
Ben if Ada goes quiet. The server does **not** know Ada's seed phrase,
Ben's seed phrase, or anything that would let it spend the coins.

### Step 4: Ada checks in, week after week

Every week, Ada opens the dashboard and taps the check-in button. The
dashboard calls `POST /vaults/:id/checkin`. The server records the
timestamp and pushes the deadline a week forward.

Ada doesn't have to broadcast a Bitcoin transaction to check in. The
"check-in" is just telling our server "I'm still alive." This is
cheap, fast, and zero-fee.

(There's a more secure variant where check-in is itself a Bitcoin
transaction that moves the vault to a fresh address, resetting the
on-chain timer. The CLI supports this. The web flow uses the cheaper
server-only check-in because real families won't do a weekly on-chain
transaction.)

### Step 5: Ada stops checking in

Maybe she's on holiday with bad reception. Maybe she's in hospital.
Maybe she's died. The server doesn't know which, and it doesn't need
to know. It only sees that the deadline passed.

The server moves the vault from `ok` to `alarmed` and records an event
("missed check-in"). At this point the dashboard would show a warning,
and (in a future version with notification fan-out wired up) Ada would
get an email saying "you missed a check-in, tap here to confirm you're
OK." If Ada wakes up and checks in, the alarm clears.

### Step 6: The eligibility window passes

If Ada stays silent for another grace period after the alarm fires,
the server decides it's time to reach Ben. It generates a one-time
random token (32 bytes, base64-encoded). The token's SHA-256 hash is
stored in the database. The raw token is written into an event row
once, so an operator (or a future notifier) can pick it up and send
it to Ben via the channel Ada chose.

The token is a bearer credential: whoever holds the string can act on
behalf of the heir. We accept this because Ben is the only person who
should ever see the token, and we never store the original — only its
hash. An attacker who gets read access to our database cannot
impersonate Ben.

### Step 7: Ben receives a link

Ben gets an SMS or email like:

> Ada set up GhostKey so that if she ever stopped checking in, you'd
> hear from us. That's what happened. Tap this link to see what she
> left you: https://ghostkey.app/claim/abc123...

He taps the link. The dashboard shows him a calm, family-friendly
page (no jargon, no crypto twitter tone) explaining what's going on:
who left him the inheritance, the amount, and a four-step claim flow.

### Step 8: Ben claims the funds

He needs a Bitcoin wallet that can sign a PSBT — Sparrow on desktop,
or any of several mobile options. The claim page walks him through:

1. Make sure he has a compatible wallet.
2. Paste the Bitcoin address where he wants the funds to land.
3. Click "Prepare transaction". Our server scans the chain for any
   coins sitting at the vault's addresses, builds an unsigned PSBT,
   and shows him a base64 string.
4. Copy the string into his wallet. His wallet derives his signing
   key from his seed phrase (which is on his device, not ours),
   signs the PSBT, and gives him back a signed string.
5. Paste the signed string. Our server finalises it (assembles the
   timelock-branch witness from his signature) and broadcasts the
   transaction.
6. Done. The coins move from the vault address to Ben's address.
   Our server marks the vault as claimed.

GhostKey never sees Ben's signing key. The server's role at this
point is to do the chain scan, the PSBT plumbing, and the broadcast —
work that requires public-blockchain access but no private keys.

---

## 4. Why each piece of software exists

GhostKey is four pieces of software. Each has a single, narrow job.
They are split this way on purpose: a bug in one piece should not be
able to compromise the others.

### `ghostkey-core` (Rust library)

The cryptographic core. No file I/O, no network access. Given two
xpubs and a timelock, it produces:

- the Bitcoin descriptor (the formal rule that lives on chain),
- PSBTs for the two kinds of spend: owner check-in and heir claim.

If we ever rewrite the rest of the project in a different language,
`ghostkey-core` is the part that has to remain exactly correct.

### `ghostkey-cli` (command-line tool)

For people who hold keys: the owner and the heir. It generates seed
phrases, derives xpubs, builds vaults locally, syncs to a Bitcoin Core
node over RPC, and signs check-in / claim transactions.

This is what you'd use if you wanted to set up a vault entirely
offline, or if you want to do real on-chain check-ins (each one is a
small Bitcoin transaction).

### `ghostkey-server` (web service)

The notifier. Holds **no keys**. Persists to a SQLite file.

- Records vault registrations (descriptors only).
- Tracks check-in deadlines.
- Encrypts the heir's contact details at rest.
- Issues one-time claim tokens when the eligibility window passes.
- Builds and broadcasts heir-claim transactions (the heir's signature
  comes from the heir's own wallet — we never see it).

If this server is compromised, the worst an attacker can do is:

- mark people's check-ins missed when they weren't (annoying, but the
  owner will see the alarm and tap "I'm OK"),
- mark people's check-ins as met when they weren't (delays the heir
  for the duration of the next cycle),
- read encrypted heir contacts (useless without the master key, which
  isn't in the database),
- read claim token hashes (useless without the raw token, which we
  don't keep).

They cannot move any coins. The script on the Bitcoin network does
not care about anything the server says.

### `ghostkey-web` (React dashboard)

The browser app. Talks only to the server. No keys, no Bitcoin
network access of its own. Has three audiences:

- **Owners** see their vaults, the countdown to the next deadline,
  and a check-in button.
- **Heirs** see the claim page, which they reach by clicking a
  one-time link.
- **Visitors** see the landing page, which explains the system.

If a malicious browser extension or a compromised dashboard runs
arbitrary code, the worst it can do is call the server's API as the
visitor. That means: spurious check-ins (harmless), or starting a
claim attempt with no signing key to sign with (also harmless).

---

## 5. What the server can and cannot do

This list matters more than any other in the project. If you read one
section and remember it, make it this one.

### The server CAN

- See which Bitcoin descriptor each vault is based on.
- Look up the vault's current address on the chain.
- See how often the owner has checked in.
- Decide that the owner is overdue.
- Generate a one-time token and write its hash into the database.
- Build an unsigned PSBT that drains the vault on the timelock branch.
- Take a signed PSBT and broadcast it to the network.
- Send a notification (in the current version: write the token into
  an event row for an operator or future notifier to pick up).

### The server CANNOT

- See the owner's seed phrase. Ever.
- See the heir's seed phrase. Ever.
- See the master key after startup, except as a `OnceLock` in memory.
- Decrypt the heir's stored contact details on a host where the master
  key environment variable is missing.
- Sign a Bitcoin transaction.
- Move any coins on its own. Even if every operator turned malicious
  simultaneously, the on-chain script would refuse a spend without a
  valid signature from the legitimate owner or heir.
- Reset the on-chain timelock. Time on the Bitcoin network is
  measured in blocks; no off-chain action can rewind it.

### The boundary is real

We separate these two lists carefully in the codebase. Anything in
the first list goes in `ghostkey-server`. Anything in the second list
goes in `ghostkey-core` (descriptors) or `ghostkey-cli` (signing) or
the heir's own wallet (the actual signature). The server's binary has
no code path that touches a private key.

This is why we can claim "no custody, ever". It's not a promise — it's
a structural property of the software.

---

## 6. The heir's experience, end to end

The heir is usually the least technical person in the system. They
might never have used Bitcoin before. They might be grieving. The
claim page has to assume nothing.

We make the following choices:

**No GhostKey navbar.** The heir doesn't need a "Set up" button or a
"Dashboard". They need the one thing the page is for. Showing
unrelated controls would be confusing.

**Greet them by name.** When the owner set up the vault, they
optionally entered the heir's display name. That's decrypted and used
on the claim page: "Hello Ben." Not "Welcome, user," not "Claim your
inheritance." A human greeting.

**Explain what happened first, ask for anything second.** The page
opens with "Someone you knew left you Bitcoin." It doesn't ask for an
address or a wallet until two paragraphs later, after the heir knows
why they're there.

**Step-by-step, with one decision per step.** Step 1 is "do you have
a wallet, yes or no". Step 2 is "paste the address". Step 3 is "sign
this PSBT in your wallet, then paste the result back". Each step
unlocks the next. No giant form.

**No fake successes.** If the chain scan finds no coins, the page
says so, in English, and tells the heir what likely went wrong (the
timelock might not have passed yet, the funds might have been moved
already, the indexer might be down). It does not pretend the
transaction succeeded.

**The link doesn't expire on first view.** The heir will probably
open it on their phone, then walk to a desktop with Sparrow installed
to sign. The token is only consumed when a real broadcast happens.
Viewing the page does nothing destructive.

**Show the txid and a block explorer link at the end.** Not a "thank
you for using GhostKey" page. A "here's the transaction, here's how
to watch it confirm" page. The heir wants proof, not branding.

---

## 7. Security choices and their consequences

This section lists the trade-offs we made, in plain language, so a
future contributor can argue with them if they have a better idea.

### We chose Taproot, not legacy multisig

A traditional inheritance scheme uses 2-of-3 multisig with the owner,
the heir, and a notary. The advantage: simple to explain. The
disadvantages: the notary is a permanent trust dependency, the
transaction is bigger (more fees), and the recovery path always
involves three signatures.

Taproot lets us encode the same logic ("owner alone OR heir-with-delay
alone") in a single output that looks like a normal payment until
it's spent. Cheaper on chain, no notary, no chance of a missing third
party blocking a legitimate recovery.

### We chose relative timelocks, not absolute

An absolute timelock says "the heir can spend after block 1,000,000".
That's a fixed point in calendar time. If the owner is still alive at
that block, they have to migrate the funds to a new vault before the
heir's window opens.

A relative timelock says "the heir can spend N blocks after the
funds last moved". Every time the owner does an on-chain check-in
(spends the vault to a fresh vault address), the heir's timer
resets. The owner can keep the vault alive indefinitely without
ever having to migrate.

The trade-off: relative timelocks require the owner to actually do an
on-chain transaction periodically. The web check-in button is *not*
on-chain — it just tells the server "the owner is still around." A
real-money mainnet vault should mix the two: light "I'm alive"
check-ins to the server most weeks, plus an occasional on-chain
re-vaulting to reset the BIP68 timer.

### We chose to encrypt the heir's contact, not the descriptor

The descriptor is public information by design — anyone who watches
the chain can see the vault address, and anyone who sees the address
plus the descriptor can derive the same on-chain rules. Encrypting it
would be theatre.

The heir's contact (their email, phone number, name) is private and
PII. We encrypt it with a per-vault key derived from a server-wide
master key. The master key lives in an environment variable that the
binary reads at startup. If the database is exfiltrated alone, the
heir contacts are still encrypted ciphertext.

### We chose bearer tokens for claim links, not signed JWTs

A claim token is 32 bytes of pure randomness, sent to the heir in a
URL. We store only its SHA-256 hash. The heir holds the only copy.

Pros: dead-simple to implement, no key rotation, no expiry
calculation.

Cons: anyone who intercepts the link can act as the heir until the
broadcast completes.

We accept the con because:

- The link arrives via the channel the owner chose (email, SMS,
  WhatsApp). Those channels are no less private than any other
  bearer-link system (password reset emails, calendar invites, Stripe
  checkout links).
- The heir's wallet still has to sign the PSBT. An attacker who
  steals the link can prepare a transaction but cannot sign it
  without the heir's seed phrase.
- The damage from a stolen claim link is bounded: the attacker can
  see the heir's display name and the vault's network. They cannot
  see the heir's contact details, the owner's identity, or the
  descriptor.

### We chose SQLite, not Postgres

The notifier server's data fits comfortably in one file on one disk.
A typical deployment serves a few thousand vaults; a busy one
might serve a few hundred thousand. SQLite handles all of that on a
$5/month VPS.

Postgres would be overkill. It would add an operational dependency,
a network hop, and a class of failures (connection pool exhaustion,
replica lag, etc.) we don't need. If the project ever outgrows
SQLite, switching is a small `sqlx` change. We'd rather have the
problem first.

### We chose to verify everything that goes into the database

Every descriptor accepted by `POST /vaults` is parsed with
`ghostkey-core`'s descriptor parser before insertion. Every claim
token is constant-time compared against its stored hash. Every PSBT
is finalised through a watch-only wallet derived from the stored
descriptor, so the server proves to itself that the signed PSBT
matches the vault before it broadcasts.

We do not trust the input from any client, including our own web app.

---

## 8. Where AI could fit (and where it shouldn't)

GhostKey is a security-critical product. The trusted compute surface
is small on purpose. Adding an AI component that runs in the
hot path of moving real money would be a mistake — language models
hallucinate, network calls fail, model output is hard to test
deterministically.

That said, there are real places where a language model could make
the product genuinely better. This section catalogues them, in
descending order of how clearly they help and how easily they ship.

For each option we note: what it does, what data it sees, what
happens when it fails, and roughly how much work it is.

### Option A: Plain-English explainers on the heir's claim page

**What it does.** When the server returns a chain-related error (no
UTXOs at vault addresses, timelock not yet mined, esplora unreachable,
PSBT not fully signed, mempool rejection), the claim page passes the
raw message to a small language model and shows the human-readable
result alongside the original.

Example:
- **Raw**: `psbt parse: invalid base64 character at position 47`
- **Friendly**: "The signed PSBT didn't paste cleanly — it looks
  like part of it got cut off. Try copying it again, making sure to
  grab the entire string from the first character to the last."

**What data it sees.** The error string. Nothing else. No keys, no
descriptors, no contact details, no token.

**Failure mode.** If the model is down or slow, the page falls back
to the raw message (which is what it shows today). The heir is no
worse off than before.

**Work.** Small. One new server route that proxies + rate-limits a
hosted model (OpenAI, Anthropic, or a self-hosted Llama). Add a
prompt with a few example translations. About a day of work,
including writing canned fallbacks for each known error class so
the model is only used for the long tail.

**Worth it?** Yes, probably. The realistic worst case for a heir is
that they hit a confusing error message and give up. Translating the
top dozen errors solves most of that.

### Option B: Setup wizard concierge

**What it does.** A chat sidebar on the SetupPortal where the owner
can ask things like "what's an xpub?", "how do I find this in
Sparrow?", "how long should I set the timelock to?". Answers are
grounded in our own docs (this file, the README, the architecture
doc).

**What data it sees.** The owner's free-text questions. We tell the
owner not to paste seed phrases. We add a client-side regex that
detects 12/24-word strings and refuses to send them.

**Failure mode.** The chat says "I'm offline, here's a link to the
relevant doc section". The setup flow doesn't depend on the chat —
it's purely a side panel.

**Work.** Medium. Need to ingest our docs into a vector store, write
a retrieval-augmented prompt, build the chat UI, add abuse
protection. About a week.

**Worth it?** Maybe. The pain point it solves is real (people get
stuck during setup) but the same problem is solved cheaply by good
inline documentation. We should write better inline docs *first* and
add this only if we see real evidence (support requests, drop-off
analytics) that they aren't enough.

### Option C: Address sanity check on claim

**What it does.** Before the heir clicks "Prepare transaction", we
pass their destination address to a model that checks against a list
of known scam addresses, mixing services flagged by chain analytics
providers, or addresses that look like the heir might have been
phished into using them.

**What data it sees.** A Bitcoin address. Public information.

**Failure mode.** If the check is down, we skip it silently and let
the heir continue.

**Work.** Medium-large. The hard part isn't the model — it's the
data source. We'd need a subscription to a chain analytics feed (or
to build our own, which is years of work). Without good source data,
the check is worse than useless: it would either be too lenient
(false negatives, fails its purpose) or too strict (false positives,
blocks legitimate addresses).

**Worth it?** Not until the rest of the product is mature. Premature
fraud screens annoy users and create false confidence ("the system
said it was safe").

### Option D: Commit message and diff summariser for contributors

**What it does.** A small Rust binary in a hypothetical `tools/`
directory that takes a `git diff` and produces a draft commit message
matching this repo's style (lowercase subject, paragraph body, "what
verified / what NOT verified" section). The contributor edits the
draft before committing.

**What data it sees.** The diff. No user data, no production data.

**Failure mode.** Contributor writes the commit message by hand, as
they do today.

**Work.** Small. A weekend hack.

**Worth it?** This is the cheapest "AI in the project" option. It
doesn't touch user-facing code, doesn't introduce a runtime
dependency, and would mainly help us keep the journal consistent. If
the project grows past a couple of contributors, this is the place
to start.

### Option E: Anomaly detection on check-in patterns

**What it does.** The server watches every owner's check-in cadence
and flags vaults whose pattern suddenly changes — long pause then
flurry of check-ins, check-ins coming from a new geographic IP,
check-ins at unusual hours for that user. The owner is alerted by
email: "someone checked in for you from a new device. Was it you?"

**What data it sees.** Server-side check-in logs (timestamps, IPs).
No keys, no descriptors.

**Failure mode.** False positives annoy the owner. False negatives
mean an attacker who got into the dashboard can keep checking in on
the owner's behalf, preventing the heir from ever claiming. (This is
already true today; the model doesn't make it worse.)

**Work.** Large. Needs a training set, an inference pipeline, and a
careful UX for the alerts so they don't become noise.

**Worth it?** Eventually, maybe. We'd want to see real usage data
first. Without users we have no signal of what "normal" looks like.

### What we explicitly will NOT use AI for

- **Building, signing, or broadcasting Bitcoin transactions.** These
  are deterministic operations with no room for "creativity". Adding
  a model in the path means adding a non-deterministic failure source
  to a flow that has to be perfectly reliable.
- **Validating descriptors or addresses.** Same reason. We have a
  parser; we use the parser; the parser either accepts or rejects.
- **Deciding when to fire an alarm.** The cadence is set by the
  owner. The check is a `<=` on a timestamp. No model needed.
- **Customer support replies that touch security questions.** A model
  that confidently tells a user "yes, your seed phrase is still safe"
  when it has no way to know that, is worse than no support at all.

### Our recommendation

If we add one AI feature, make it **Option A** (heir-side explainer).
It has the clearest user benefit, the smallest blast radius, and a
clean fallback. It also gives us experience operating against a
hosted model before we try anything bigger.

---

## 9. What we'd build next

This is the list of work that would noticeably improve the product
right now, in rough priority order. Some of these are weeks of work,
some are afternoons.

### Tier 1 — Things to do before recommending to a real family

#### Live signet smoke test for the claim pipeline

The PSBT build + sign + broadcast flow compiles and passes its unit
tests, but no one has driven it against a live Bitcoin signet node
with a real heir wallet. We need to do this end-to-end at least once
before mainnet:

1. Deploy a signet instance of the server.
2. Create a vault with a 6-block timelock on signet.
3. Fund it from a signet faucet.
4. Wait out the timelock.
5. Walk through the claim page using Sparrow on signet.
6. Confirm the transaction lands.

If any of those steps fails, we learn something the test suite
couldn't tell us. This is the single highest-value piece of work
remaining on the project.

#### Real notification fan-out

Today, when the scheduler issues a claim token, the raw token goes
into an event row's JSON detail and that's it. An operator has to
read the events log and manually deliver the link. That's fine for
testing but useless in production.

We need to wire at least one delivery channel:
- **Email** is the easy first pick (SMTP via a transactional provider
  like Postmark, AWS SES, or Resend).
- **SMS** is more useful but more expensive and region-dependent
  (Twilio).
- **WhatsApp** would be valuable for our target audience (informal
  family inheritance, often in countries where WhatsApp is the
  default messaging app), but the Business API has a non-trivial
  approval process.

We'd add a `notifications` table, a small worker that polls
unsent claim_issued events and pushes them through the configured
channel, and a retry policy. Failures should be loud, not silent.

#### Owner alarm notifications

Same fan-out infrastructure, but for the owner. When the server
transitions a vault from `ok` to `alarmed`, the owner should get
notified ("you missed a check-in, tap here within 24 hours or your
heir will be told"). This is what gives the owner a real chance to
recover before the heir is contacted.

#### Master key rotation

The server-wide master key is loaded once from
`GHOSTKEY_MASTER_KEY`. If it ever needs to be rotated (key
compromise, operational hygiene), we currently have no path to do
that without re-encrypting every row. We should:

- Tag each ciphertext with the key version that produced it.
- Support N versions in memory simultaneously.
- Add a background re-encryption job for old rows.

This is straightforward but has to be done before we have enough
data that re-encrypting it all is painful.

### Tier 2 — Things to do soon, in any order

#### k-of-n heirs

Today the descriptor builder hard-codes one heir. Real families
often want "any 2 of {wife, son, daughter, brother}". The miniscript
already supports this — the change is in `descriptor.rs`
(generalise the heir branch to a `thresh(k, ...)` over multiple
heir keys) and the setup UI (accept multiple heir xpubs and a
threshold). About a week.

#### Cold signing for owner check-ins

Right now the CLI signs in-process, meaning the owner's seed phrase
has to be on the same machine the check-in runs from. For
mainnet-grade security we should let owners use an offline signer
(Coldcard, Trezor, etc.):

1. CLI builds an unsigned PSBT and writes it to a file.
2. Owner moves the file to the offline machine via SD card or QR.
3. Offline signer signs.
4. Owner moves the signed file back.
5. CLI broadcasts.

This is the standard hardware-wallet workflow. BDK already produces
the PSBTs in the right format; we just need CLI plumbing.

#### Encrypted backups of the SQLite file

The server's `ghostkey.sqlite` file is the entire state of the
notifier. We have a local nightly snapshot script in `DEPLOY.md`,
but it doesn't ship off-host. We should:

- Encrypt the snapshot with `age` (or a similar modern tool).
- Push it to S3-compatible storage on a schedule.
- Have a one-line restore procedure documented.

#### A status page

Heirs and owners both want to know "is GhostKey up right now?". A
public `/status` endpoint plus a small static page (uptime, last
deploy, last scheduler tick) would answer that without a heavy
third-party service.

### Tier 3 — Quality of life

#### Audit log for the operator

Every state change in the server already produces an event. We
should add an operator-facing view of those events — filterable by
vault, by kind, by time range — so a support engineer can answer
"what happened to vault X?" without writing SQL.

#### Better setup UX for non-technical owners

The current `SetupPortal.tsx` is solid but assumes the owner can
find their xpub. A guided import for the top three wallets
(Sparrow, BlueWallet, Specter) with screenshots would lower the
friction. Tier-2 if we get real users complaining about this; tier-3
otherwise.

#### Internationalisation

All user-facing copy is English. Our target audience includes
Nigeria (where many family inheritances are informal and a
WhatsApp-delivered claim link maps naturally to existing habits).
French and Yoruba would be high-impact second languages. Mechanical
work; no architectural changes.

#### CLI parity with the web claim flow

The CLI today supports `claim` for an heir who knows the descriptor
and can run a local `bitcoind`. The web claim flow doesn't require
either. The CLI should grow a `claim --from-link <url>` mode that
mirrors the web flow but signs locally without going through the
server's broadcast path — useful for paranoid heirs who don't want
to trust our Esplora endpoint.

### Tier 4 — Speculative

#### Move from Esplora to a self-hosted indexer

Today the server uses Blockstream's public Esplora endpoint for
chain scanning and broadcast. This is fine for development and
small loads, but for a real product we'd want our own indexer (or
an enterprise Esplora subscription) so we're not at the mercy of a
free public service.

#### Privacy-preserving check-ins

Today, by checking in via our server, the owner reveals to us
"this person is still alive at time T". For someone who's worried
about this, we could offer a check-in that's a Tor-routed POST with
no IP logging and no account binding. The check-in is already
unauthenticated by vault id, so most of the work is operational
(Tor hidden service, logging policy).

#### Multi-server federation

A single notifier server is a single point of failure for *reminders*.
The on-chain coins are safe even if the server vanishes, but the
heir might not learn it's time to claim. A federation of independent
notifiers, each watching the same set of vaults, would harden this.
The owner registers with N notifiers; the heir gets a claim link
from whichever one fires first.

This is a real piece of work — partitioning, deduplication, mutual
distrust between notifiers — and only worth doing once GhostKey has
a noticeable user base.

---

## 10. Glossary

**Address.** A short string starting with `bc1` (mainnet) or `tb1`
(testnet) that you can send Bitcoin to. Different from a wallet — one
wallet can produce thousands of addresses.

**BIP68.** A Bitcoin standard that lets a script require "this coin
must have been confirmed at least N blocks ago before I can be
spent". This is what makes the heir's claim wait out a timer.

**Block.** A bundle of transactions confirmed by the Bitcoin network
roughly every 10 minutes. Time on Bitcoin is usually measured in
blocks: 144 blocks ≈ 1 day, 1008 ≈ 1 week, 4380 ≈ 1 month.

**Descriptor.** A formal written-down version of a Bitcoin spending
rule. Every GhostKey vault has one. It's not a secret — sharing a
descriptor lets someone watch a vault but not spend from it.

**Esplora.** A Bitcoin block-explorer API. The server uses it to
look up the coins sitting at a vault's addresses without running our
own full node. We default to Blockstream's free public endpoint.

**Heir.** The person who would inherit a vault's coins after the
owner stops checking in.

**Master key.** A 32-byte secret loaded from the
`GHOSTKEY_MASTER_KEY` environment variable at server startup. Used
to derive per-vault keys that encrypt heir contact details.

**Notifier.** Our name for the `ghostkey-server` binary. It's a
notifier because its job is to track deadlines and notify, not to
hold money.

**Owner.** The person who creates a vault and checks in regularly to
say they're still alive.

**PSBT.** "Partially Signed Bitcoin Transaction." A standard file
format for a Bitcoin transaction that's been built but not yet fully
signed. Lets one program prepare a transaction and another program
sign it, without either having full information the other needs.

**Seed phrase.** A 12 or 24-word backup of a Bitcoin wallet. Whoever
has the phrase controls the funds. Owner and heir each have their
own; neither ever leaves their device.

**Taproot.** The newest standard format for Bitcoin scripts. Lets us
hide our two-branch logic inside something that looks like an
ordinary payment, and reveals only the branch that's actually used.

**Timelock.** The waiting period before the heir's claim becomes
valid. Measured in blocks. Set once, at vault creation.

**Vault.** A single GhostKey-style Bitcoin output with a check-in
rule on it. One vault holds whatever Bitcoin has been sent to its
address.

**xpub.** "Extended public key." Lets someone receive payments and
watch a wallet's activity, without being able to spend. Owner and
heir share xpubs with each other (and the dashboard); they never
share their seed phrases.
