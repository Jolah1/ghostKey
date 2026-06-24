# GhostKey — Security Audit Scope

Draft for issue #183. Hand this to a firm with the frozen commit (see
"Audit target" below). Companion reading: `ARCHITECTURE.md`, `DESIGN.md`,
`docs/threat-model.md`.

## What GhostKey is

A non-custodial Bitcoin inheritance app. An owner locks funds into a
Taproot vault with a timelocked recovery path. If the owner stops
checking in, an heir can claim the funds after the timelock. Two heir
setups:

- **Door A / F2 (easy setup, default):** the heir has no wallet. The
  server derives and seals the heir's key under a claim token. The
  server *can* reconstruct this key (master key -> open at-rest token ->
  HKDF KEK -> unseal xprv). This is documented and inherent, not a bug.
- **Door B (opt-in):** the heir holds their own xpub. Fully
  non-custodial; the server never holds heir key material.

The single most load-bearing secret is the server **master key**: it
gates every Door A heir key and all contact PII.

## Audit target (freeze before quoting)

- Repo: `Jolah1/ghostKey`
- Tag a commit `audit-candidate-1` so the firm reviews a fixed target.
- Build/run: `DEPLOY.md` (server), `ARCHITECTURE.md` (workspace layout).
- Toolchain: Rust 1.86 (see `Dockerfile`), Node/Vite for `ghostkey-web`.

## In scope

### 1. Bitcoin protocol layer — `crates/ghostkey-core` (~1.9k LoC)
The part where a bug means lost or stealable funds.
- `descriptor.rs` (407) — Taproot + miniscript vault descriptor, the
  BIP68 relative-timelock recovery branch. **Top priority.**
- `psbt.rs` (581) — PSBT construction and signing.
- `sweep.rs` (216) — heir sweep / claim transaction building.
- `keys.rs` (238), `vault.rs` (204), `wallet.rs` (257) — key
  derivation, vault model, address derivation.

### 2. Server — `crates/ghostkey-server` (~11.5k LoC)
Custody boundary, auth, and the claim state machine.
- `crypto.rs` (683) — master key loading (env / file / `_CMD`),
  AEAD for contacts, HKDF KEK, at-rest token sealing, Door A heir-key
  reconstruction. **Top priority — the key-handling boundary.**
- `auth.rs` (830) — session/token auth, claim-token gating.
- `routes.rs` (4961) — all HTTP handlers incl. check-in and claim.
- `scheduler.rs` (2994) — deadline/grace logic, claimable transition,
  LN health gate, notifier. A bug here can release funds early or lock
  an heir out (see the Door A lockout regression, fixed in #125).
- `psbt_routes.rs` (1989), `lnurl.rs` (100) — server-side PSBT and
  Lightning check-in endpoints.

### 3. Browser crypto — `ghostkey-web/src/crypto`
Runs client-side; a flaw means key material mishandled in the browser.
- `keygen.ts`, `sealing.ts`, `heirKey.ts` (and the existing
  `*.test.ts`).

## What to attack (one-page note for the firm)

1. **The descriptor.** Can the timelock be bypassed, the recovery
   branch spent early, or funds locked permanently? Miniscript
   correctness vs. our intended spending policy. (Note: only Bitcoin
   Core opens these vaults; Sparrow and Liana refuse the descriptor
   shape — see `docs` and finding notes.)
2. **The claim flow / scheduler.** Can an heir claim before the
   deadline+grace? Can a legitimate heir be locked out? Race conditions
   in the claimable transition. Token replay or forgery on claim/LN
   routes.
3. **The key-handling boundary (`crypto.rs`).** Master key loading
   (incl. the `_CMD` shell hook — command injection, stdout leak in
   logs), AEAD nonce reuse, HKDF salt/info correctness, at-rest token
   sealing, and the Door A reconstruction path. Confirm the custody
   claim made to users is *exactly* what the code does, no weaker.
4. **Auth.** Session and claim-token issuance, scoping, expiry, and the
   rate limiting in `rate_limit.rs`.

## Out of scope (state explicitly to bound the quote)

- Fly.io platform / infra hardening (separate ops track, #187).
- Litestream backup integrity (covered by the restore drill in #187).
- Lightning provider internals (lnbits/breez); only our call sites.
- Marketing site copy and non-crypto UI.

## Firms (Bitcoin + miniscript literate)

Coinspect, Cure53, Trail of Bits, Least Authority. Get quotes against
the frozen tag.

## Funding

Apply to OpenSats and/or Spiral / HRF grants for the audit. Attach this
scope and `docs/threat-model.md`.

## Done when

A reputable third party has reviewed the frozen scope, criticals and
highs are fixed and re-checked on a private branch, and the report (or a
summary) is published in the repo.
