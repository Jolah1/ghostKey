# GhostKey threat model

This is the threat model in plain prose: who can attack the system,
what they can take or break, which defences we rely on, and which
risks we have decided to accept eyes-open.

It is the *input* to the upcoming external security review, not the
output of one. If you spot something missing, an issue or a PR is
the right place to argue with it.

Related documents:

- [`ARCHITECTURE.md`](../ARCHITECTURE.md): what each layer does and
  where the security boundaries are.
- [`DESIGN.md`](../DESIGN.md): why the system is shaped this way.
- [`SECURITY.md`](../SECURITY.md): how to report a vulnerability,
  the known-limitations list, and accepted supply-chain advisories.

A few framing decisions before the body:

- **Scope.** This model covers attackers against the GhostKey
  binaries (`ghostkey-server`, `ghostkey-cli`), the static web
  bundle (`ghostkey-web`), its build and delivery path, and the data
  they touch. It does **not** cover attacks against Bitcoin itself
  (51% mining, breaking secp256k1, consensus rewrites) or against the
  third-party wallets the heir signs with. Fly and Vercel are explicit
  trusted dependencies, not excluded infrastructure: compromise of
  either has the capabilities described under Att-3.
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

- **CLI flow**: written to `.ghostkey/<profile>/mnemonic` (chmod
  600) on the owner's own machine. Source: `crates/ghostkey-cli/`.
- **Password-vault flow**: generated in the browser, never sent in
  plaintext to the server. The server stores only a sealed blob
  (XChaCha20-Poly1305 under an Argon2id-derived KEK). Source:
  `ghostkey-web/src/crypto/sealing.ts`,
  `crates/ghostkey-server/src/db.rs` (column
  `owner_xprv_sealed_ct_b64`).

### A2. The heir's private key
Same shape as A1, owned by the heir.

- **CLI flow**: heir's own machine.
- **Password-vault Door A flow**: sealed in the server's `vaults` row
  under HKDF-SHA256(claim token). The server stores both a token hash
  for verification and the token reversibly encrypted under
  `GHOSTKEY_MASTER_KEY` for scheduled delivery. DB + master key can
  therefore recover the token and heir xprv now; the CSV timelock
  prevents spending until maturity. Browser unwraps at claim time.
  **Door B** sends only an heir xpub and stores neither an heir-key
  ciphertext nor a setup-time claim token. Source:
  [`crypto/sealing.ts`](../ghostkey-web/src/crypto/sealing.ts) →
  `unsealHeirXprv`, [`psbt_routes.rs`](../crates/ghostkey-server/src/psbt_routes.rs)
  → `get_sealed_heir_xprv`.
- **F2 server-derived flow (legacy vaults only)**: there is no on-disk
  heir key; it is recomputed deterministically from
  `(GHOSTKEY_MASTER_KEY, heir_email, vault_id)` on both sides. **No new
  vault uses this.** #124 stopped opting into server derivation:
  `heir_derivation` is null on every vault created since, in both
  `PasswordSetupPortal` and `AddHeirPortal`, and a no-wallet heir now
  gets a browser-generated key sealed under their claim token (the
  password-vault flow above). The derivation path stays reachable only
  so vaults created before that change can still be claimed. Source:
  [`crates/ghostkey-core/src/keys.rs`](../crates/ghostkey-core/src/keys.rs)
  → `derive_heir_seed`,
  [`ghostkey-web/src/crypto/heirKey.ts`](../ghostkey-web/src/crypto/heirKey.ts).

In a **guardian vault** (for an underage heir) the policy is
`heir AND (g1 OR g2) AND older(N)`, optionally gated by an absolute
`after(H)` unlock height. A claim needs the heir's signature plus
one guardian signature, so no guardian can act alone and loss of one
guardian key does not strand the heir. In the current browser-assisted
enrollment, however, GhostKey stores each sealed claim key and retains
the corresponding claim tokens reversibly under its master key. DB +
master key can reconstruct the claim keys now, although neither branch
is spendable before its timelocks. Independent guardian custody is a
future enrollment improvement, not a current security property.
Source:
[`crates/ghostkey-core/src/descriptor.rs`](../crates/ghostkey-core/src/descriptor.rs)
→ `build_guardian_descriptor_pair`,
[`crates/ghostkey-core/src/psbt.rs`](../crates/ghostkey-core/src/psbt.rs)
→ `build_guardian_claim`.

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
2. **F2 heir-key derivation (legacy vaults only).** For F2 vaults the
   master key is also the salt for `derive_heir_seed`. A leak of the
   master key + the heir's email + the vault id reconstructs the heir's
   mnemonic for that vault. This blast radius is **closed for new
   vaults** and does not grow: since #124 no vault is created with
   `heir_derivation`, so the exposed set is exactly the F2 vaults that
   already existed. Their heir keys are recoverable from one secret,
   which is why that path was removed.

The master key is **never** part of the script itself. Combined with
the DB, however, it can decrypt stored Door A and browser-created
guardian claim tokens, which then decrypt their sealed private keys.
It can also derive legacy F2 heir keys. Reconstruction is immediate;
only the relevant on-chain timelocks then stand between those keys and
the funds. Door B remains outside this capability.

### A4. The SQLite database (`ghostkey.sqlite`)
Sealed contacts, sealed password-vault blobs, claim-token hashes,
reversibly encrypted Door A / guardian claim tokens,
one-tap-token hashes, owner-token hashes, the descriptor pair per
vault, the deadline + status + event log per vault, the
notification queue, the Lightning-invoice records. Tables listed in
[`ARCHITECTURE.md` → `ghostkey-server`](../ARCHITECTURE.md#ghostkey-server).

A full DB exfiltration *without* the master key reveals which
addresses are vaults, what their script structure is, and the
notification metadata. Without the master key it does not reveal
contact plaintext or unwrap the stored private-key blobs. Combined
with the production master key it can recover Door A / guardian claim
tokens and therefore those claim keys. Owner xprvs still require the
owner password; Door B heir private keys are never stored.

### A5. Bearer credentials
Three flavours, all 32 random bytes, with hash verifiers and a
constant-time compare path (`auth.rs`). Door A and browser-created
guardian claim tokens are also retained reversibly encrypted for
scheduled delivery:

- **Owner token**: returned exactly once at vault creation. Required
  on owner-mutation endpoints. Persisted on the owner's device
  (`vaultStore.ts`).
- **One-tap check-in token**: minted per period, expires when the
  next deadline rolls; used as `Authorization` for
  `/vaults/:id/checkin-from-link/:token`.
- **Claim token**: minted when a vault enters `alarmed`, sent to
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
Per-IP rate limits, trusted-proxy client identity and per-process
provider concurrency ceilings live in
[`rate_limit.rs`](../crates/ghostkey-server/src/rate_limit.rs) and
[`concurrency.rs`](../crates/ghostkey-server/src/concurrency.rs).
They bound one replica; distributed limits remain an upstream
operational responsibility.

Owner email hashes are pending assertions until the inbox holder verifies
them. A pending row cannot block setup under another owner key, verification
only propagates across vaults carrying the same owner key, and SQLite enforces
that two different live owner keys cannot both hold a verified binding.
Verification-message cooldowns are keyed by email hash across vaults when that
normalized hash is available. Legacy rows without one fall back to an atomic
per-vault cooldown rather than re-hashing with potentially different
normalization rules.

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
runs the VPS. They are not the threat to the owner. In the hosted
case (`ghostkey.fly.dev`), the operator is whoever maintains the
shared deployment.

Server access alone cannot sign through the owner's branch without the
owner password. If the same operator also controls frontend delivery,
Att-3 applies and malicious JavaScript can capture that password and key
when the owner next uses the site.

### Att-3. A malicious hosting provider
The cloud platform underneath the server (Fly, Hetzner, Vercel). Can
read server disk/RAM and observe the process environment. A frontend
host or compromised deployment account can replace the same-origin
JavaScript and capture passwords, owner keys and claim keys while a
user types, creates or unlocks them. CSP does not prevent replacement
of a script that the origin itself is trusted to serve.

### Att-4. A compromised heir
An attacker who knows they are named as the heir for some specific
owner: e.g. a scorned relative. They have the heir's contact
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

### Att-9. A colluding guardian (guardian vaults)
A guardian who keeps a copy of the underage heir's key, or who can
coerce the heir, after the timelock matures. One guardian plus the
heir's key is a valid claim by design, so this is a trust the owner
places in the guardians they pick, not a flaw the script can remove.
Bounded under [R10](#r10-guardian-collusion-is-bounded-not-eliminated).

---

## 3. Defended attacks

What the design actually stops, with a pointer into the code that
does the stopping.

### D1. Timelocks block spending, not key reconstruction
For current Door A and browser-created guardian vaults, DB + production
master key can reconstruct the relevant claim private keys immediately.
It still cannot use their script branches before CSV (and optional
CLTV) maturity. Door B is stricter: the server has only the heir xpub,
so DB + every production secret remains insufficient to derive the
heir spending key.

Legacy F2 has the same reconstruct-now/spend-after-timelock exposure
through deterministic derivation. The owner's xprv is separately
sealed under an Argon2id KEK from their password, so DB + master key
still needs that password to spend through the owner branch.

- Lives at:
  [`crates/ghostkey-core/src/descriptor.rs`](../crates/ghostkey-core/src/descriptor.rs)
  (script), [`crates/ghostkey-core/src/psbt.rs`](../crates/ghostkey-core/src/psbt.rs)
  (signing paths), [`crates/ghostkey-cli/`](../crates/ghostkey-cli/)
  (offline/manual key tooling).
- Verified: `cargo test -p ghostkey-core` exercises the PSBT paths;
  server and web tests separately lock in the Door A reconstructability
  and Door B no-secret-storage invariants.

### D2. Password-vault signing and custody exposure
The server-signing path is
`POST /claim/:token/heir-claim`: the browser unwraps the heir xprv
from the URL-fragment-derived KEK, ships it over TLS, the server
holds it in process memory for the duration of one call, signs and
broadcasts, then drops it. The xprv is never written to disk or
tracing output; it lives in the function-scope variable and goes out
of scope when the handler returns.

The plaintext submitted during a legitimate call is bounded to that
call. The broader Door A custody exposure is not: DB + master key can
recover the stored token and sealed heir xprv before the call. CSV
controls when that reconstructed key can spend, not when it can be
reconstructed. The trade-off:

- A *compromised* server during that call could redirect the
  matured-timelock UTXO to an attacker-controlled address. The
  on-chain trail is public, so the real heir notices immediately,
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

### D4. A Door A claim link is recovery authority
The fragment keeps the credential out of the initial browser HTTP
request, but the web client subsequently uses that token in GhostKey
API paths. Anyone who obtains a valid Door A link can fetch and unwrap
the sealed heir xprv once the server-side claim gates allow it, then
spend after the Bitcoin timelock matures. Door B is different: its link
authenticates the claim workflow but does not provide the heir private
key, which remains in the heir's wallet.

- Lives at:
  [`crates/ghostkey-server/src/psbt_routes.rs`](../crates/ghostkey-server/src/psbt_routes.rs)
  → claim-token verification (`hash_claim_token` + constant-time
  match);
  [`ghostkey-web/src/crypto/sealing.ts`](../ghostkey-web/src/crypto/sealing.ts)
  → `unsealHeirXprv`.
- Verified: application tracing redacts the claim path in
  [`routes.rs`](../crates/ghostkey-server/src/routes.rs). Upstream proxy
  log behavior still requires deployment verification.

### D5. Att-5 (compromised owner) can spend, but cannot retroactively bypass the timelock
A compromised owner is the owner. They can sweep funds via the
owner branch. They cannot make the heir branch claimable sooner:
the timelock measures from the UTXO's last confirmation, and no
server action can reset that.

- Lives at: BIP68 enforcement in Bitcoin consensus (not in this
  repo).
- Verified: [x] the relative-timelock decision is documented in
  [`DESIGN.md` § 6](../DESIGN.md#relative-timelocks-over-absolute-ones).

### D6. Att-1 cannot enumerate vaults through owner recovery
`GET /vaults` (the list-all route) requires the optional admin
token (`GHOSTKEY_ADMIN_TOKEN_HASH`). `POST /recovery/request` returns
the same accepted body for known and unknown email hashes. Vault
summaries and sealed owner blobs are returned only after atomically
redeeming a 15-minute, single-use link sent to the encrypted owner
email.

- Lives at:
  [`crates/ghostkey-server/src/auth.rs`](../crates/ghostkey-server/src/auth.rs)
  → `AdminAuth`,
  [`crates/ghostkey-server/src/routes.rs`](../crates/ghostkey-server/src/routes.rs)
  → `request_owner_recovery` and `exchange_owner_recovery`.

### D7. Att-1 / Att-4 cannot brute-force a 256-bit token at network speed
Owner tokens, one-tap tokens, and claim tokens are 32 random bytes;
the search space is 2^256. Per-IP rate limiting (issue #25,
[`rate_limit.rs`](../crates/ghostkey-server/src/rate_limit.rs))
caps online attempt rate; even without it the search is infeasible
by construction. We rely on the cryptographic margin, not on the
rate limit, for the security of these tokens.

### D8. The "fail closed" startup checks
Two combinations are forbidden at boot:

- `GHOSTKEY_AUTH_DISABLED=1` without `GHOSTKEY_ALLOW_INSECURE=1`:
the server refuses to boot with an "auth disabled but
  ALLOW_INSECURE not set" error
  ([`main.rs`](../crates/ghostkey-server/src/main.rs)).
- Missing `GHOSTKEY_MASTER_KEY`: the server refuses to boot, so
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
this because the alternative (requiring every heir to set up a
Bitcoin wallet before they can be named) defeats the F2 product
intent.

- Mitigation: master-key custody is the load-bearing secret for
  every F2 vault. Use Fly Secrets (or KMS equivalent); never bake
  it into a container image or check-in script. Rotate immediately
  on suspected leak.
- Tracked: rotation design + runbook in [`master-key-rotation.md`](./master-key-rotation.md);
  implementation (per-row generation tags + background re-encryption +
  owner-facing F2 re-vault) is GitHub issue #27.

### R2. Server-side signing window in the password-vault claim
See D2 above. A compromised server during one specific call can
redirect the matured-timelock UTXO. Window is bounded to the seconds
the handler takes. Mitigation: structural: no key persistence; only
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

### R5. A recovered sealed owner key is offline-crackable with a weak password
Password-vault sealing uses Argon2id with `m=64MiB, t=3, p=1`
([`ghostkey-web/src/crypto/sealing.ts`](../ghostkey-web/src/crypto/sealing.ts)).
Tuned for ~3s on a mid-range Android phone: deliberately the
slowest we could justify without user-visible jank in the wizard.
Sealed blobs are no longer public by vault id. Signed-in tools require
the owner bearer token; blank-browser recovery requires a short-lived
single-use link delivered to the owner email. An attacker who controls
that mailbox/link can still obtain the ciphertext and grind the password
offline at the public KDF cost. Email proof removes bulk harvesting; it
does not make weak passwords safe after mailbox compromise.

- Mitigation: the wizard enforces a length minimum (10) and a zxcvbn
  score floor (≥ 3), refusing common/guessable passwords, so the
  grind starts at ≥ ~10^8 guesses; each guess costs a 64 MiB / t=3
  Argon2id. A user who picks a strong passphrase is safe; a user who
  ignores the meter and picks `password123` is not.
- Mitigation: recovery responses are uniform, links expire after 15
  minutes and are consumed atomically, and authenticated tools require
  the per-vault owner token.
- Tracked: SECURITY.md "Known limitations" #4; internal audit
  2026-07-02.

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

### R10. Guardian collusion is bounded, not eliminated
The guardian policy `heir AND (g1 OR g2) AND older(N)` raises the bar
from one key to two cooperating parties (the heir plus one guardian),
but it cannot stop a guardian who already holds the underage heir's
key from claiming once the timelock matures (Att-9). What the design
does guarantee:

- No single guardian can ever spend alone; the heir's signature and
  one of two guardians are both required.
- The owner can move the funds at any time while alive (the
  `pk(OWNER)` branch is unchanged).
- The optional unlock-year (`after(H)`) holds the funds past a chosen
  block height no matter what the guardians do, so an owner can keep
  the money locked until the child reaches majority.
- Every claim is public on-chain and therefore detectable.

Choosing two guardians who do not trust each other is the
load-bearing user decision here, the same way master-key custody
(R1) is for F2 vaults. Source:
[`descriptor.rs`](../crates/ghostkey-core/src/descriptor.rs),
[`psbt.rs`](../crates/ghostkey-core/src/psbt.rs).

### R11. Recovery-request email abuse
Vault existence is no longer disclosed by the recovery response.
Someone who knows an owner's email hash can still cause recovery emails
to be sent. The endpoint is rate-limited and a database-backed
per-email cooldown permits at most one live-link email per 10 minutes,
including across server instances. Repeated requests preserve the
current link. The message explains how to ignore an unrequested attempt.
Distributed traffic can still generate one message per cooldown window,
so upstream monitoring remains appropriate.

Known-address work can exceed the 200 ms minimum response duration under
load, while unknown-address work usually cannot. The timing pad is a
floor, not a cap or a constant-time guarantee; sophisticated repeated
timing analysis remains a low-severity existence oracle. A fully uniform
asynchronous request queue would close that gap at greater complexity.

### R12. A vault's funding address is readable given the vault id
`/vaults/:id/address` returns the first receive address for a vault
id, unauthenticated (the setup/funding flow needs it before the owner
token round-trip completes). Someone holding a vault id can therefore
correlate it to an on-chain address and watch its balance. On-chain
addresses are public once used, so the marginal leak is the vault-id
→ address linkage.

- Mitigation: behind the `GHOSTKEY_RL_RECOVERY` limiter.
- Accepted: low severity for an on-chain-public tool; funds cannot be
  moved with an address.

### R13. Hosted frontend delivery is a key-handling trust boundary
The password-vault web bundle generates owner keys and later unseals
them with the owner's password. Correct code does not send either to
the backend in plaintext, but the browser must hold them briefly. A
malicious same-origin release, compromised Vercel/deployment account,
or poisoned build dependency can exfiltrate them at that moment.

- Mitigation: all GitHub Actions are pinned to immutable commits; CI
  produces a deterministic web archive, CycloneDX SBOM, SHA-256
  manifest and GitHub build-provenance attestations for `main`.
- Mitigation: the single-file independence kit can be saved and used
  offline, outside the hosted application's availability boundary.
- Operational requirement: protect `main`, require reviewed production
  deployments, and promote the attested CI artifact instead of asking
  the hosting provider to rebuild mutable source independently.
- Accepted residual risk: users of the hosted password flow still trust
  the exact JavaScript their browser receives. CSP cannot remove this
  trust. A signed native/offline owner application or hardware-wallet-
  first flow would reduce it further.

### R14. Historical backups may retain pre-sealing claim tokens
Current startup seals any legacy plaintext Door A or guardian claim token
before serving traffic, and the runtime reader rejects unsealed values. A
backup made by an older release can still contain the raw token. Because the
same token wraps the corresponding heir/guardian key, changing only its hash
or database value would strand recovery.

- Mitigation: encrypt backups, restrict and audit access, test restores under
  the current binary, and expire obsolete pre-migration copies according to a
  documented retention policy.
- Accepted residual risk: a stolen historical plaintext backup can contain a
  still-valid claim credential. Full invalidation requires coordinated
  rewrapping of token-encrypted material or an owner-authorized move to a new
  vault descriptor; that higher-risk migration remains future work.

### R15. A trusted browser profile retains a password-locked owner credential
The browser retains enough password-encrypted material to restore its owner
bearer token locally, so an ordinary return visit does not depend on an email
provider. Email recovery is reserved for new browsers, cleared site data, or
otherwise lost local credentials.

- Mitigation: the token is scoped to owner operations for its vault, CORS and
  frontend supply-chain controls reduce exposure to foreign scripts, and the
  independent recovery kit remains the deeper recovery path.
- Accepted residual risk: someone who can use or extract the same unlocked
  browser profile can act with that stored owner credential. Owners should use
  device login and disk encryption and avoid treating a shared browser as a
  trusted device. Password-enabled vaults apply a non-destructive local lock
  after ten minutes of inactivity: after a one-time password validation proves
  the server's encrypted token matches the live credential, later locks replace
  the usable bearer token with that password-encrypted token blob. The
  normalized hash of the email typed at unlock is compared locally and the
  password opens that blob locally. The form values are not persisted and no
  email message, recovery endpoint, or link is involved. Browser-profile
  extraction exposes only the password-encrypted token after lock; extraction
  while the session is active can still expose the live bearer token. A future
  device passkey could strengthen that boundary further.
- Migration safety: an existing browser's first timeout caches the encrypted
  token but preserves the live token behind the UI until the owner enters the
  password and the two values match. This avoids stranding vaults whose old
  post-setup token re-seal never completed. If the old blob validly opens to
  the historical placeholder, the proven password re-seals the still-live
  token and updates the authenticated server copy before local removal.
  Subsequent timeouts remove the validated live token from storage.

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

### Q4. Should recovery require another factor beyond email?
Sealed blobs now require OwnerAuth or a short-lived, single-use link
sent to the owner email. A compromised mailbox plus a weak password
still exposes the owner key to offline guessing. Hardware-backed owner
keys or an additional recovery factor would raise this floor at a
significant simplicity cost.

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
- Keep the cross-references current: broken links here are the
  signal that the doc has fallen behind the code.

If a finding from the external mainnet review contradicts a claim
in this document, prefer the finding; this is a working model, not
a fixed contract.
