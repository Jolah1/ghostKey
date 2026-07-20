# GhostKey internal security audit

Date: 2026-07-20
Reviewer: OpenAI Codex (repository-level internal review)
Commit reviewed: `df0a801`
Status: Preliminary internal audit; not a substitute for an independent professional audit

Remediation status: GK-01 documentation and invariant tests implemented; GK-04
application-log redaction implemented (upstream proxy logging remains to verify);
GK-08 HSTS implemented. GK-03 is implemented on the
`security/email-verified-recovery` branch pending review. Other findings remain open.

## Executive summary

GhostKey has stronger security documentation and defensive test coverage than most
early-stage applications. The Taproot policy is compact, key material is generally
handled deliberately, bearer tokens have high entropy, authenticated encryption is
used correctly at the primitive level, owner mutations are token-gated, and the
project has explicit recovery and deployment runbooks.

However, the default browser-generated heir flow does not provide the custody
boundary still claimed by the README, architecture document and central threat
model. This is an existing, deliberately disclosed Door A trade-off in the setup
UI, not a newly introduced regression in the security property. What regressed is
the accuracy and consistency of the written security claims. The old direct
derivation of the heir key from
`(master_key, email, vault_id)` **was removed by #124**. That correction is real and
reduces the exposure of a master-key-only leak. It does not make the current default
flow reconstruction-proof: the database contains the heir xprv ciphertext and a
copy of the raw claim token encrypted under the server master key. A
running-server compromise, or possession of the database and master key, therefore
provides both inputs needed to recover the heir xprv.

This is a high-severity trust-model/documentation failure because several current documents say the
server stores only the token hash and cannot open the heir key blob. The setup UI and
`PasswordSetupPortal.tsx:59-78,1820-1839` already disclose the remaining Door A
trade-off accurately, and the server code accurately notes that the master key can
decrypt the at-rest token. The correction therefore exists in part of the product,
but has not been propagated consistently into the canonical security documents.

Recommended release posture:

1. Correct the false hash-only/cannot-open claims immediately.
2. Describe Door A consistently as server-assisted and preserve Door B
   (heir-supplied xpub) as the clearly non-custodial option.
3. Treat any change to Door A custody as a separate product and architecture
   project, with external review before mainnet migration.
4. If that design changes, provide existing users with an explicit
   migration/re-vault path and an honest explanation of its cost and limits.

## Scope

Reviewed:

- `ghostkey-core`: descriptors, Taproot policies, PSBT construction and sweep paths
- `ghostkey-server`: authentication, token handling, public routes, claims,
  scheduler, encryption, rate limiting, push SSRF controls and deployment settings
- `ghostkey-web`: key generation, secret sealing, password controls, local storage,
  claim routing, CSP and PWA delivery
- Threat model, architecture, security, recovery and deployment documentation
- CI workflows and available unit/static checks

Not performed:

- Live production penetration testing
- Cloud account, Fly, Vercel, SMTP, Twilio, Anthropic or DNS configuration review
- Dynamic fuzzing, formal Miniscript verification, side-channel measurement or
  cryptographic implementation review of third-party libraries
- Mainnet transaction execution
- Social engineering, mobile device or physical recovery testing

## Severity model

- Critical: credible loss of funds or systemic compromise with a realistic trust
  boundary failure
- High: loss of funds or private keys requiring an additional significant condition
- Medium: meaningful confidentiality, integrity or availability impact
- Low: hardening weakness or limited-impact information exposure

## Findings

### GK-01 — High — Door A is reconstructable but canonical docs claim otherwise

Re-verification status: confirmed after a second end-to-end review prompted by the
maintainer. This finding does **not** rely on the removed F2 direct-derivation path.
The reconstruction property was already known and is accurately disclosed in the
setup UI. The newly actionable defect is documentation drift back to absolute
non-custody claims.

Affected:

- `crates/ghostkey-server/src/routes.rs:1326-1347`
- `crates/ghostkey-server/src/crypto.rs:285-327`
- `crates/ghostkey-server/src/scheduler.rs:1455`
- `ghostkey-web/src/crypto/sealing.ts:12-25`
- `docs/threat-model.md:56-67`
- `README.md:83-89`
- `ARCHITECTURE.md:120`

The browser encrypts the heir xprv under `HKDF(raw_claim_token)`. During vault
creation it sends both the xprv ciphertext and raw claim token to the server. The
server stores the ciphertext and stores the raw token encrypted with a per-vault key
derived from `GHOSTKEY_MASTER_KEY`.

The earlier implementation derived the heir key directly from the master key, email
and vault id. Issue #124 removed that derivation for new vaults. The current two-step
recovery path is distinct:

`open_claim_token_at_rest()` explicitly decrypts that token. Consequently an actor
with the running server, or the database plus master key, can:

1. Decrypt `claim_token_at_rest_b64`.
2. Derive the heir xprv KEK using the public HKDF construction.
3. Decrypt `heir_xprv_sealed_ct_b64`.
4. Wait for the vault UTXO's relative timelock to mature.
5. Sign an heir-path spend to an attacker address.

Reconstruction is not an instant drain. Bitcoin's CSV relative timelock still
prevents the heir branch from spending until the relevant vault UTXO has aged by
`timelock_blocks`. An on-chain owner check-in that moves the UTXO into a fresh vault
output resets that age. A server compromise can recover the key immediately but
cannot bypass Bitcoin consensus to spend an immature output. Once the output
matures, the 48-hour application challenge does not protect against this attacker
because it is enforced by the compromised server, while the recovered key can be
used outside GhostKey.

The same structural issue applies to server-recoverable guardian claim tokens paired
with guardian xprv ciphertexts.

The setup portal comments and visible setup copy already state this accurately.
README, ARCHITECTURE, `crypto/sealing.ts` and the central threat model still contain
the contradictory hash-only/cannot-open claims. Encryption of both halves under keys
available to the same trust domain provides database-at-rest protection, not
non-custody.

Evidence chain:

1. Door A is still the default:
   `PasswordSetupPortal.tsx:59-75,864-889`.
2. The browser seals the heir xprv under the raw token:
   `crypto/sealing.ts:204-219,245-268`.
3. The same raw bytes are base64-encoded into `claim_token_b64`:
   `PasswordSetupPortal.tsx:887-889`.
4. The server stores that token reversibly under its master-derived per-vault key:
   `routes.rs:1338-1347`, `crypto.rs:207-219,285-327`.
5. The server's own unit test proves the stored token opens back to the original:
   `crypto.rs:489-504`.
6. The scheduler routinely performs that decryption:
   `scheduler.rs:1443-1459`.
7. The heir browser base64-decodes the recovered string to the original bytes and
   uses the same HKDF to decrypt the xprv:
   `ClaimPage.tsx:1218-1229`, `crypto/sealing.ts:350-360`.

Remediation options:

- Immediate (implemented): correct the false statements in README, ARCHITECTURE,
  `crypto/sealing.ts` and the central threat model. Describe Door A as the
  server-assisted recovery trade-off already disclosed by the setup UI.
- Near-term: steer wallet-capable users toward Door B without pretending it meets
  the no-wallet/no-prior-heir-knowledge product goal.
- Architecture option A: have the heir or owner retain an offline unlock secret.
  This is simple to audit and can survive GhostKey disappearing, but it
  reintroduces long-term secret custody, loss, discovery and fire risks. It should
  be an explicit product choice, not silently assumed to be the default.
- Architecture option B: split recovery capability across genuinely independent
  trust domains using secret sharing or threshold signing. This is a legitimate
  design and may better preserve the easy-setup goal. Its costs are protocol
  complexity, collusion assumptions, provider independence, decade-scale service
  survivability and a materially larger external-audit scope.
- Architecture option C: require the heir to contribute a public key (Door B).
  This satisfies the non-custody invariant most cleanly but requires prior heir
  preparation.
- Re-vault existing Door A and guardian vaults only if the architecture changes.
  Deleting the stored token alone would make future delivery impossible and is not
  a migration.
- Add a regression test asserting that a fixture containing every server-side
  persisted value plus every server secret cannot derive any spend key.

Funded-vault migration constraint: the descriptor already commits on-chain to the
current heir key. Repair therefore requires an owner-authorized Bitcoin transaction
to a new descriptor, costs network fees, and can happen only while the owner is
alive, has their signing key and cooperates. Unfunded vaults can simply be recreated.

### GK-02 — High — Hosted frontend delivery can capture owner keys and passwords

Affected:

- `ghostkey-web/src/crypto/keygen.ts`
- `ghostkey-web/src/crypto/sealing.ts`
- `ghostkey-web/src/SignInPortal.tsx`
- `vercel.json`
- Threat-model scope statement

Owner keys and passwords are created or unsealed by JavaScript delivered by the
hosted frontend. A compromised Vercel account, deployment credential, DNS/CDN
control plane, dependency/build pipeline or malicious frontend release can replace
that JavaScript and exfiltrate passwords and xprvs during setup or sign-in.

The CSP does not address trusted same-origin script replacement. This is inherent to
a hosted web wallet, but the current threat model excludes the hosting platform and
product language can be read as protecting against the operator.

Remediation:

- State clearly that the hosted frontend is a trusted component capable of stealing
  keys when used.
- Offer a reproducible, signed, downloadable owner application or offline recovery
  kit whose digest/signature users can verify independently.
- Use protected production branches, artifact promotion, build provenance and
  two-person approval for frontend deployments.
- Pin GitHub Actions by immutable commit SHA and generate an SBOM/provenance
  statement for release artifacts.
- Consider a hardware-wallet-first mode in which browser JavaScript never receives
  an owner private key.

### GK-03 — High — Email enumeration leads directly to offline owner-key cracking

Remediation status: implemented on `security/email-verified-recovery`. Recovery
responses are uniform; a 15-minute single-use email challenge now gates vault
summaries and sealed blobs; signed-in blob reads require OwnerAuth. A database-backed
10-minute per-email cooldown suppresses duplicate mail across instances, and
expired/old-used challenge rows are pruned opportunistically. The 200 ms timing pad
is explicitly treated as a best-effort floor, not a constant-time guarantee.

Affected:

- `crates/ghostkey-server/src/routes.rs:124-140`
- `crates/ghostkey-server/src/routes.rs:3858-3887`
- `crates/ghostkey-server/src/routes.rs:3893-3968`
- `ghostkey-web/src/crypto/sealing.ts:41-49`

`POST /vaults/find` accepts an unsalted SHA-256 hash of an email address and returns
vault identifiers, labels, statuses and deadlines. Email addresses are low-entropy
identifiers; hashing does not make them secret. Anyone who knows or guesses an email
can compute the lookup value.

The returned UUID can immediately be used with unauthenticated
`GET /vaults/:id/sealed-blobs`, which returns the owner xprv ciphertext, salt and
Argon2 parameters. The attacker can then perform an unlimited offline password
attack. Argon2id at 64 MiB and three iterations is useful mitigation, but cannot
repair human-selected weak or reused passwords.

This also leaks sensitive relationship metadata: that the person uses GhostKey, the
vault label, lifecycle status and next deadline.

Remediation:

- Replace email-hash discovery with proof of email control: send a short-lived,
  single-use recovery link and return no vault metadata before it is redeemed.
- Bind recovery to a high-entropy recovery identifier supplied in the owner's saved
  kit where possible.
- Return uniform responses to discovery requests.
- Do not expose the encrypted owner key until the recovery challenge succeeds.
- Treat the password as one factor protecting an encrypted backup, not as sufficient
  authentication for public retrieval.

### GK-04 — Medium — Claim/check-in/verification bearer tokens leak into request logs

Affected:

- `crates/ghostkey-server/src/routes.rs:306-319`
- Routes containing `checkin-from-link`, `checkin-link` and `verify-contact`

The custom trace span redacts only paths beginning with `/claim/`. One-tap check-in,
Lightning-from-link and contact-verification bearer tokens are also embedded in URL
paths, but their raw paths enter tracing.

A log reader can replay a still-valid check-in token to postpone inheritance, create
or inspect link-authenticated Lightning operations, or consume a verification token.
Upstream Fly/Vercel proxy logs may also capture path credentials.

Remediation status: application tracing now redacts the known token-bearing route
families and has a regression test. Moving credentials out of URL paths and
verifying upstream Fly/Vercel log behavior remain open.

Remediation:

- Redact every token-bearing route using route templates rather than prefix-specific
  string logic.
- Prefer URL fragments for browser-delivered secrets and send the token in an
  `Authorization` header when calling the API.
- Set short expirations, rotate after use and audit upstream access-log retention.
- Add tests enumerating all routes and asserting that known sample secrets never
  appear in spans.

### GK-05 — Medium — Client-controlled forwarding headers can bypass rate limits

**Status: remediated on `security/trusted-proxy-rate-limits`.**

Affected:

- `crates/ghostkey-server/src/rate_limit.rs:200-273`
- Public create, find, recovery, claim, analytics and AI routes

The limiter trusts `Fly-Client-IP`, then the first `X-Forwarded-For` value, without
checking that the direct peer is a trusted proxy. This is safe only if the service is
impossible to reach except through a proxy that overwrites those headers. The
assumption is deployment-specific and easy to invalidate when self-hosting.

If a client can supply either header, it can choose a new bucket for every request.
That enables AI-cost abuse, email enumeration, encrypted-key harvesting, database
growth and expensive Esplora scans.

Remediation:

- Trust forwarding headers only when the socket peer belongs to an explicit trusted
  proxy CIDR; otherwise key on the peer address.
- Strip incoming forwarding headers at the edge and document/test the exact proxy
  behavior.
- Put cost-bearing and storage-creating endpoints behind an upstream distributed
  limiter and global quotas.
- Add global concurrency limits for Esplora scans and message-provider calls.

Implemented controls bind forwarding-header trust to explicit
`GHOSTKEY_TRUSTED_PROXY_CIDRS`, parse `Fly-Client-IP` as an address and walk XFF
right-to-left while removing trusted hops. Process-wide semaphores cap Anthropic
and Esplora work; the notification worker is already serial. The remaining
multi-replica/distributed-rate risk is operational and still requires an upstream
shared limiter or provider quota.

### GK-06 — Medium — Unauthenticated vault creation permits email squatting

Affected:

- `crates/ghostkey-server/src/routes.rs:115-122`
- `crates/ghostkey-server/src/routes.rs:1030-1100`
- `reject_conflicting_owner_email`

The client supplies `owner_email_hash`, and creation does not require proof that the
caller controls that email. The conflict rule allows only one owner key per active
email. An attacker who knows a victim's email can pre-register its hash with an
attacker-controlled owner key. A later legitimate setup using the same email and a
different owner key is rejected.

This is a targeted availability attack and can also trigger unwanted verification
messages.

Remediation:

- Verify email ownership before making an email/key binding authoritative.
- Permit an unverified pending row to expire without blocking verified setup.
- Rate-limit by more than client IP and cap pending creations per email/domain.

### GK-07 — Medium — Legacy plaintext claim-token compatibility retains bearer secrets

Affected:

- `crates/ghostkey-server/src/crypto.rs:307-315`
- Historical database rows and backups

`open_claim_token_at_rest()` accepts unprefixed legacy values as raw bearer tokens.
That maintains availability but means older databases and retained backups may
contain directly usable claim credentials. Encrypting current rows does not remove
those copies.

Remediation:

- Inventory and migrate every live legacy row.
- Rotate affected claim tokens and invalidate their hashes.
- Apply backup retention/deletion policy to historical plaintext copies.
- Remove plaintext fallback after a documented migration deadline.

### GK-08 — Low — HSTS is absent from the frontend response policy

Affected:

- `vercel.json`

Fly forces HTTPS and the frontend has a good CSP, frame protection, MIME sniffing
protection and referrer policy. The frontend policy does not set
`Strict-Transport-Security`.

Remediation status: implemented in `vercel.json`; deployment verification remains.

Remediation:

- Add `Strict-Transport-Security: max-age=31536000; includeSubDomains` after
  confirming that every current and future subdomain supports HTTPS. Add `preload`
  only after satisfying browser preload requirements and accepting the operational
  commitment.

## Positive controls observed

- Compact Taproot/Miniscript policy with an unspendable internal key
- Network-aware address validation and tests
- High-entropy bearer-token generation with hash comparison
- AEAD for contacts and sealed blobs; random nonces and domain-separated KDFs
- Argon2id owner-key wrapping and password-strength gating
- Owner authorization on mutation endpoints
- Atomic claim-token consumption and explicit failure release paths
- Claim challenge and chain-maturity checks before releasing sealed keys
- SSRF defenses on web-push endpoints, including DNS rebinding re-checks
- Exact-origin CORS allowlist
- Strong script CSP (`script-src 'self'`) and `frame-ancestors 'none'`
- Dependency audit jobs, Rust formatting/lint/test CI, browser tests and accessibility
  checks
- Backup, restore and master-key rotation documentation
- No obvious committed API keys or private-key PEM material found by pattern scan

## Verification performed

- `npm run typecheck`: passed
- `npm test -- --run`: 12 files, 64 tests passed
- `npm audit --offline --omit=dev`: 0 known production dependency vulnerabilities
- Re-verification of GK-01: the server Door A master-key recovery test and browser
  claim-token/xprv recovery test passed.
- `cargo test -p ghostkey-server`: 201 tests passed
- `cargo fmt --all -- --check`: passed
- `npm run build`: passed
- Secret-pattern scan: no obvious committed live secrets found; the inlined WASM
  base64 artifact produced noisy false-positive search output

## Fix order

1. GK-01 immediate: correct false custody claims and name Door A consistently
2. GK-03: require email proof before vault discovery or encrypted-key retrieval
3. GK-02: harden and accurately document the hosted frontend trust boundary
4. GK-04: eliminate bearer credentials from logs and paths
5. GK-06: prevent unverified email/key squatting
6. GK-05: bind forwarding-header trust to known proxies and add global quotas
7. GK-07: migrate and rotate legacy plaintext tokens
8. GK-08: add HSTS after deployment validation

Separately, make any Door A redesign a product decision rather than an emergency
patch: compare offline-envelope, independent split-recovery and threshold-signing
designs against the no-prior-heir-knowledge goal, then obtain external review before
deploying or migrating mainnet vaults.

After remediation, run an independent review focused on descriptor correctness,
transaction construction, migration safety, browser key delivery, recovery under
service disappearance, and production cloud controls.
