# GhostKey threat model

This is the threat model in plain prose: who can attack the system,
what they can take or break, which defences we rely on, and which
risks we have decided to accept eyes-open.

It is the *input* to the upcoming external security review, not the
output of one. If you spot something missing, an issue or a PR is
the right place to argue with it.

Related documents:

- [`ARCHITECTURE.md`](../ARCHITECTURE.md) — what each layer does and
  where the security boundaries are.
- [`DESIGN.md`](../DESIGN.md) — why the system is shaped this way.
- [`SECURITY.md`](../SECURITY.md) — how to report a vulnerability,
  the known-limitations list, and accepted supply-chain advisories.

A few framing decisions before the body:

- **Scope.** This model covers attackers against the GhostKey
  binaries (`ghostkey-server`, `ghostkey-cli`), the static web
  bundle (`ghostkey-web`), and the data they touch. It does **not**
  cover attacks against Bitcoin itself (51% mining, breaking
  secp256k1, consensus rewrites), against the operator's underlying
  cloud platform (Fly, Vercel), or against the third-party wallets
  the heir signs with.
- **Style.** Each claim points at the code that makes it true.
  Claims the maintainer has re-verified against the current tree
  carry a checked box `[x]`; unchecked `[ ]` boxes are claims that
  need fresh verification in review.
- **What "the server" means.** "The server" below is *the
  ghostkey-server binary plus the SQLite file it writes plus the
  process environment it reads*. A compromise of any one of those is
  a compromise of the others.

---

## 1. Assets

The things an attacker might want to acquire, modify, or destroy.

### A1. The owner's private key
The 12-word BIP39 mnemonic that derives the owner's Taproot xprv.
Spending control over every vault that owner has set up. There are
two storage shapes today:

- **CLI flow** — written to `.ghostkey/<profile>/mnemonic` (chmod
  600) on the owner's own machine. Source: `crates/ghostkey-cli/`.
- **Password-vault flow** — generated in the browser, never sent in
  plaintext to the server. The server stores only a sealed blob
  (XChaCha20-Poly1305 under an Argon2id-derived KEK). Source:
  `ghostkey-web/src/crypto/sealing.ts`,
  `crates/ghostkey-server/src/db.rs` (column
  `owner_xprv_sealed_ct_b64`).

### A2. The heir's private key
Same shape as A1, owned by the heir.

- **CLI flow** — heir's own machine.
- **Password-vault flow** — sealed in the server's `vaults` row
  under HKDF-SHA256(claim token). The server cannot reproduce the
  KEK; it only stores the claim-token *hash*. Browser unwraps at
  claim time. Source:
  [`crypto/sealing.ts`](../ghostkey-web/src/crypto/sealing.ts) →
  `unsealHeirXprv`, [`psbt_routes.rs`](../crates/ghostkey-server/src/psbt_routes.rs)
  → `get_sealed_heir_xprv`.
- **F2 server-derived flow** — there is no on-disk heir key; it is
  recomputed deterministically from `(GHOSTKEY_MASTER_KEY, heir_email,
  vault_id)` on both sides. Source:
  [`crates/ghostkey-core/src/keys.rs`](../crates/ghostkey-core/src/keys.rs)
  → `derive_heir_seed`,
  [`ghostkey-web/src/crypto/heirKey.ts`](../ghostkey-web/src/crypto/heirKey.ts).

### A3. The server's master key (`GHOSTKEY_MASTER_KEY`)
Process environment variable. Required at startup; the server
refuses to boot without it
(`crypto::ensure_master_key_loaded`,
[`crypto.rs`](../crates/ghostkey-server/src/crypto.rs)).
Two distinct uses with different blast radii:

1. **Contact PII encryption.** Per-vault key derived via HKDF-SHA256
   over the master key + vault id; used to encrypt heir / owner /
   trusted-contact rows at rest with XChaCha20-Poly1305. A leak of
   the master key + the DB exposes all contact PII.
2. **F2 heir-key derivation.** For F2 vaults the master key is also
   the salt for `derive_heir_seed`. A leak of the master key + the
   heir's email + the vault id reconstructs the heir's mnemonic
   for that vault.

The master key is **never** part of the script-path spend, so a
leak does not directly let an attacker spend funds. It does, for F2
vaults, give an attacker everything they need to *be* the heir;
only the on-chain timelock then stands between them and the funds.

### A4. The SQLite database (`ghostkey.sqlite`)
Sealed contacts, sealed password-vault blobs, claim-token hashes,
one-tap-token hashes, owner-token hashes, the descriptor pair per
vault, the deadline + status + event log per vault, the
notification queue, the Lightning-invoice records. Tables listed in
[`ARCHITECTURE.md` → `ghostkey-server`](../ARCHITECTURE.md#ghostkey-server).

A full DB exfiltration *without* the master key reveals which
addresses are vaults, what their script structure is, and the
notification metadata. It does not reveal contact plaintext, owner
xprvs, or heir xprvs (all encrypted to keys the server does not
hold once the master key is rotated out of memory).

### A5. Bearer credentials
Three flavours, all 32 random bytes, stored hash-only with a
constant-time compare path (`auth.rs`):

- **Owner token** — returned exactly once at vault creation. Required
  on owner-mutation endpoints. Persisted on the owner's device
  (`vaultStore.ts`).
- **One-tap check-in token** — minted per period, expires when the
  next deadline rolls; used as `Authorization` for
  `/vaults/:id/checkin-from-link/:token`.
- **Claim token** — minted when a vault enters `alarmed`, sent to
  the heir over email / SMS / WhatsApp. The hash is the CAS gate
  that makes the one-shot heir-claim race-safe
  (`claim_token_used_at IS NULL` predicate in
  [`psbt_routes.rs`](../crates/ghostkey-server/src/psbt_routes.rs)).

### A6. Contact PII
Heir name + email + phone, owner name + email + phone, trusted-
contact PII. XChaCha20-Poly1305 ciphertext at rest. Plaintext only
in process memory while a route handler is decrypting one specific
vault's contact for one specific reason (e.g. enqueuing a
notification).

### A7. The Anthropic budget on `/assist/chat`
Money. The route proxies the Anthropic Messages API on our account.
Each accepted request costs real dollars; a sustained abuse loop
without bounds could rack up a meaningful bill before being noticed.
Per-IP rate limit + per-deploy env-var caps live in
[`rate_limit.rs`](../crates/ghostkey-server/src/rate_limit.rs).

---

## 2. Attackers

Realistic adversaries, roughly in order of how likely they are to
appear in practice.

### Att-1. The opportunistic web attacker
Drive-by scanning, automated tool, no relationship with any
specific user. Hits public endpoints, looks for low-hanging
authentication or injection issues, files them on a bug bounty if
they exist or moves on.

### Att-2. A malicious GhostKey operator
Whoever runs the `ghostkey-server` binary on a deployed host. Reads
the SQLite file, controls the master key (so can decrypt all
contact PII), can pause or skip notifications, can suppress
alarms, can serve a malicious response to a heir's `/claim/:token`
GET. Cannot sign Bitcoin transactions on the owner's behalf.

This is the operator we are usually our own. If GhostKey is
self-hosted by a family, the "operator" is the family member who
runs the VPS — they are not the threat to the owner. In the hosted
case (`ghostkey.fly.dev`), the operator is whoever maintains the
shared deployment.

### Att-3. A malicious hosting provider
The cloud platform underneath the server (Fly, Hetzner, Vercel). Can
read the disk, dump RAM, observe the process environment. From
GhostKey's perspective, indistinguishable from Att-2 in terms of
what they can see; differs in motive.

### Att-4. A compromised heir
An attacker who knows they are named as the heir for some specific
owner — e.g. a scorned relative. They have the heir's contact
details but not the heir's seed phrase.

### Att-5. A compromised owner
The owner's machine is taken over (malware, lost laptop, social
engineering). The attacker has the owner's seed phrase and the
owner token. From the system's perspective they *are* the owner.

### Att-6. A post-mortem adversary with physical access
After the owner's death, someone with physical access to the
owner's papers, hardware wallets, or backup notes. Distinct from
the heir.

### Att-7. The MITM at the network edge
Anyone who can intercept TLS-terminated traffic between an honest
client and the server, before TLS is restored on the inside of the
edge proxy. In practice: a hostile CDN, a hostile DNS provider, or
a misconfigured reverse proxy.

### Att-8. Anyone who finds a leaked claim link
The claim link is a bearer credential. An attacker who reads the
heir's email or SMS history (e.g. an in-house messaging-platform
admin) can replay it.

---

## 3. Defended attacks

What the design actually stops, with a pointer into the code that
does the stopping.

### D1. Att-2 / Att-3 can't move funds in the steady state
The server never holds the owner's xprv or the heir's xprv in
plaintext (outside the one narrow exception below, D2). All script-
path spend paths require a Schnorr signature from a key the server
does not have. Even with full root on the host, a malicious
operator cannot construct a valid `or_d → and_v → pk(HEIR) +
older(N)` witness without either the owner's xprv or the heir's
xprv.

- Lives at:
  [`crates/ghostkey-core/src/descriptor.rs`](../crates/ghostkey-core/src/descriptor.rs)
  (script), [`crates/ghostkey-core/src/psbt.rs`](../crates/ghostkey-core/src/psbt.rs)
  (signing paths), [`crates/ghostkey-cli/`](../crates/ghostkey-cli/)
  (the only place keys are held).
- Verified: [ ] `cargo test -p ghostkey-core` runs the full PSBT
  build and verify path; the server crate has no `Sign` import.

### D2. The password-vault server-signing exception is bounded
The one exception to "server never signs" is
`POST /claim/:token/heir-claim`: the browser unwraps the heir xprv
from the URL-fragment-derived KEK, ships it over TLS, the server
holds it in process memory for the duration of one call, signs and
broadcasts, then drops it. The xprv is never written to disk or
tracing output; it lives in the function-scope variable and goes out
of scope when the handler returns.

Exposure is bounded to the seconds the call takes. The trade-off,
fully visible here so it can be argued with:

- A *compromised* server during that call could redirect the
  matured-timelock UTXO to an attacker-controlled address. The
  on-chain trail is public, so the real heir notices immediately —
  but the funds are gone.
- We chose this trade-off because re-implementing Taproot script-
  path PSBT signing in the browser would add a significant chunk
  of audited Bitcoin code, and at the moment of this call the
  timelock has already matured, so only the heir benefits from
  spending the UTXO.
- Lives at:
  [`crates/ghostkey-server/src/psbt_routes.rs`](../crates/ghostkey-server/src/psbt_routes.rs)
  → `heir_claim`.
- Verified: [ ] `grep -rn "heir_xprv" crates/ghostkey-server/src/`
  produces only the one handler scope; no persistence layer
  references the variable.

### D3. Att-2 / Att-3 with the DB but no master key cannot read contact PII
All heir / owner / trusted-contact rows are XChaCha20-Poly1305
ciphertext at rest, keyed via HKDF-SHA256(master_key, vault_id).
The master key lives only in the process environment; the DB never
contains it. A DB exfiltration without the running process therefore
returns ciphertext + the IV; the attacker still has to mount a
brute-force on the 256-bit XChaCha20 key, which is infeasible.

- Lives at:
  [`crates/ghostkey-server/src/crypto.rs`](../crates/ghostkey-server/src/crypto.rs)
  → `seal_for_vault` / `open_for_vault`.
- Verified: [ ] the migrations show every PII column is `BLOB`
  ciphertext, never a TEXT column.

### D4. Att-4 / Att-8 with a stolen claim link cannot redirect funds
The claim link is a bearer credential against the GhostKey server,
but the on-chain spend still requires a Schnorr signature from the
heir's key. In the CLI / legacy flow, the attacker who steals the
link does not have the heir's xprv. In the password-vault flow,
unwrapping the sealed heir xprv requires the URL *fragment* (after
`#`), which traditional intermediaries (proxies, server logs,
referer headers) typically do not see.

- Lives at:
  [`crates/ghostkey-server/src/psbt_routes.rs`](../crates/ghostkey-server/src/psbt_routes.rs)
  → claim-token verification (`hash_claim_token` + constant-time
  match);
  [`ghostkey-web/src/crypto/sealing.ts`](../ghostkey-web/src/crypto/sealing.ts)
  → `unsealHeirXprv`.
- Verified: [ ] the URL-fragment-only secret is never logged or
  forwarded by the server (`tracing` config in
  [`routes.rs`](../crates/ghostkey-server/src/routes.rs) redacts the
  path component for `/claim/`).

### D5. Att-5 (compromised owner) can spend, but cannot retroactively bypass the timelock
A compromised owner is the owner. They can sweep funds via the
owner branch. They cannot make the heir branch claimable sooner —
the timelock measures from the UTXO's last confirmation, and no
server action can reset that.

- Lives at: BIP68 enforcement in Bitcoin consensus (not in this
  repo).
- Verified: [x] the relative-timelock decision is documented in
  [`DESIGN.md` § 6](../DESIGN.md#relative-timelocks-over-absolute-ones).

### D6. Att-1 cannot enumerate vaults from `/vaults`
`GET /vaults` (the list-all route) requires the optional admin
token (`GHOSTKEY_ADMIN_TOKEN_HASH`). `GET /vaults/find` is a
single-shot lookup keyed on `SHA-256(owner email)` and is rate-
limited per IP; an attacker without the owner's email cannot derive
the right hash.

- Lives at:
  [`crates/ghostkey-server/src/auth.rs`](../crates/ghostkey-server/src/auth.rs)
  → `AdminAuth`,
  [`crates/ghostkey-server/src/routes.rs`](../crates/ghostkey-server/src/routes.rs)
  → `find_vaults_by_email`.

### D7. Att-1 / Att-4 cannot brute-force a 256-bit token at network speed
Owner tokens, one-tap tokens, and claim tokens are 32 random bytes;
the search space is 2^256. Per-IP rate limiting (issue #25,
[`rate_limit.rs`](../crates/ghostkey-server/src/rate_limit.rs))
caps online attempt rate; even without it the search is infeasible
by construction. We rely on the cryptographic margin, not on the
rate limit, for the security of these tokens.

### D8. The "fail closed" startup checks
Two combinations are forbidden at boot:

- `GHOSTKEY_AUTH_DISABLED=1` without `GHOSTKEY_ALLOW_INSECURE=1` —
  the server refuses to boot with an "auth disabled but
  ALLOW_INSECURE not set" error
  ([`main.rs`](../crates/ghostkey-server/src/main.rs)).
- Missing `GHOSTKEY_MASTER_KEY` — the server refuses to boot, so
  there is no window where it might write plaintext contact PII
  ([`crypto.rs`](../crates/ghostkey-server/src/crypto.rs) →
  `ensure_master_key_loaded`).

Demo mode is similarly forbidden in combination with a `bitcoin`
(mainnet) vault.

### D9. The assist endpoint refuses to forward seed-shaped strings
`/assist/chat` filters the user's text for BIP39-shaped phrases
before proxying to Anthropic. A user who pastes their seed phrase
into the help chat doesn't accidentally upload it to a third
party.

- Lives at:
  [`crates/ghostkey-server/src/assist.rs`](../crates/ghostkey-server/src/assist.rs).
- Verified: [ ] the filter covers 12 / 18 / 24-word inputs and is
  whitespace-tolerant.

---

## 4. Accepted risks

The trade-offs we made knowingly. Each one is here so a reviewer can
argue with it.

### R1. Master-key compromise gives an attacker the F2 heir's keys
For vaults created via the F2 server-derived-heir wizard, the heir's
mnemonic is a function of `(GHOSTKEY_MASTER_KEY, heir_email,
vault_id)`. An attacker who simultaneously holds all three can
reconstruct the heir's xprv. The on-chain relative timelock is the
only check between such an attacker and the heir's funds. We accept
this because the alternative — requiring every heir to set up a
Bitcoin wallet before they can be named — defeats the F2 product
intent.

- Mitigation: master-key custody is the load-bearing secret for
  every F2 vault. Use Fly Secrets (or KMS equivalent); never bake
  it into a container image or check-in script. Rotate immediately
  on suspected leak.
- Tracked: rotation runbook is GitHub issue #27.

### R2. Server-side signing window in the password-vault claim
See D2 above. A compromised server during one specific call can
redirect the matured-timelock UTXO. Window is bounded to the seconds
the handler takes. Mitigation: structural — no key persistence; only
the live heir benefits from spending the UTXO post-timelock.

### R3. The notifier can read contact PII while the master key is loaded
The notifier worker decrypts heir / owner contact rows to populate
SMTP / Twilio payloads. While that decryption is in flight, the
plaintext name + email + phone is in process memory. A memory
dump of the running process therefore exposes whatever contact rows
are currently being processed.

- Mitigation: we don't run third-party agents on the host; the
  attack surface is the operator and the hosting provider, who are
  already trusted with the master key (R1).
- Tracked: no immediate work planned.

### R4. The owner sees Bitcoin-rule-text errors in some failure modes
The owner-side check-in flow surfaces some BDK / Esplora messages
verbatim. The heir-side flow is now classified into plain English
(issue #22), but the owner-facing flow has not had the same audit.

- Tracked: subsume into a future "owner UX polish" issue if owners
  start complaining; not currently a blocker.

### R5. Argon2id parameters lean fast, not slow
Password-vault sealing uses Argon2id with `m=64MiB, t=2, p=1`
([`ghostkey-web/src/crypto/sealing.ts`](../ghostkey-web/src/crypto/sealing.ts)).
Tuned for ~2s on a mid-range Android phone — deliberately the
slowest we could justify without user-visible jank in the wizard.
An offline brute-force against a weak password is therefore not
prohibitively expensive: `/vaults/:id/sealed-blobs` is
unauthenticated by design (the sealed blobs are useless without the
password), but does allow an offline grind by anyone who has the
vault id.

- Mitigation: the wizard enforces a password length minimum and
  warns on common passwords. A user who picks a strong password is
  safe; a user who picks `password123` is not.
- Tracked: SECURITY.md "Known limitations" #4.

### R6. No cross-instance shared rate-limit state
The per-IP token-bucket limiter is in-process. Scaling beyond one
machine per region means each machine has its own bucket; effective
rate caps multiply by replica count. We accept this until we
actually scale beyond one Fly machine per region.

- Lives at:
  [`crates/ghostkey-server/src/rate_limit.rs`](../crates/ghostkey-server/src/rate_limit.rs)
  module header.

### R7. No backup of the SQLite file off the host by default
`DEPLOY.md` documents a `cron.daily` snapshot to a local directory
and recommends shipping off-host (e.g. `rclone copy` to S3/B2). The
default install does not automate the off-host hop. A disk loss
loses notification state but not Bitcoin (the on-chain promise is
still intact).

- Tracked: GitHub issue (encrypted off-host backups, README "still
  being built").

### R8. The Lightning sidecar is excluded from the main workspace
By design (`Cargo.toml` workspace excludes
`crates/ghostkey-lightning-breez`). Operators who deploy with
Lightning enabled are responsible for running the sidecar and
auditing its dependency tree separately. `ghostkey-server` falls
back to `NoopProvider` when the sidecar is not configured.

### R9. The CLI does not yet support hardware-wallet PSBTs
Owners signing check-ins must run the CLI on a machine with the
seed-derived xprv. PSBT export / import for air-gapped or hardware
signing is on the roadmap but not built. Until it is, the CLI is
the trust anchor for owners who chose the CLI path.

---

## 5. Open questions

Things this document does not yet resolve. Reviewers, please prioritise
poking at these.

### Q1. Should the password-vault one-shot claim disappear after a mainnet review?
The trade-off in D2 / R2 is defensible for the alpha audience
("heirs who don't own Bitcoin"). It may not be defensible for
mainnet at scale. Should the manual-PSBT legacy path become the
default and the one-shot claim opt-in, or vice versa, after review?

### Q2. Is per-IP keying enough for `/claim/:token/*`?
Issue #25's PR mentions that the claim-flow rate limiter keys on
IP, not on the claim token. In practice a household NAT does not
lock heirs out (burst-20 is generous), but a more rigorous design
might key on the token. Worth a second opinion in review.

### Q3. Should the contact-PII encryption use envelope encryption?
Today every per-vault key derives from the same master key.
Rotating the master key requires re-encrypting every row (issue
#27). An envelope-encryption model (per-vault key wrapped under a
master KEK, only KEK rotates) would make rotation cheap. Is the
implementation cost worth the operational simplicity?

### Q4. Should `/vaults/sealed-blobs` be tightened?
Currently unauthenticated because the blobs are sealed under the
user's password (R5). A weak password makes this an offline
oracle. Options on the table: require a CAPTCHA before serving;
rate-limit much harder; bind the response to a short-lived token
from a prior endpoint. None of these change the fundamental
"password strength is the moat" picture, but they raise the floor.

### Q5. What's the policy for an Esplora swap?
The default Esplora URL is operator-controlled. A hostile operator
could point it at a manipulated indexer that lies about UTXOs. The
heir-claim flow trusts whatever the configured Esplora says. Is the
right answer a multi-source consensus check (Esplora + a second
backend agreeing), or do we accept that the operator's chain view
is part of the trusted compute base?

### Q6. F2 + master-key escrow?
For owners who want F2 vaults but worry about the master-key
single-point-of-failure, is there a shape where the master key is
sharded (Shamir, threshold) across multiple operators? Out of scope
for the alpha; worth keeping as a research question.

---

## 6. Where this document lives next

This is a snapshot. The next maintainer to touch the threat model
should:

- Read each `[ ]` claim and either tick it after re-verifying in
  the tree or open an issue for whatever's drifted.
- Add new entries for any feature that touches a key, a token, the
  master key, or a sealed blob.
- Keep the cross-references current — broken links here are the
  signal that the doc has fallen behind the code.

If a finding from the external mainnet review contradicts a claim
in this document, prefer the finding; this is a working model, not
a fixed contract.
