# Master key rotation: design

`GHOSTKEY_MASTER_KEY` is the load-bearing server secret. Today it is
set once at startup and never changes. There is no procedure for
rotating it after a suspected leak, and no story for routine
hygiene rotation.

This document proposes a rotation design and a runbook. **It is the
design step of issue #27: no code changes ship with this PR.** The
implementation is the follow-up PR, separated so the model can be
argued with before the migration goes near production data.

Related material:

- [Threat model § R1](./threat-model.md#r1-master-key-compromise-gives-an-attacker-the-f2-heirs-keys): what a master-key leak actually buys an attacker.
- [`crates/ghostkey-server/src/crypto.rs`](../crates/ghostkey-server/src/crypto.rs): current single-key implementation (`master_key()`, `vault_contact_key`, `seal_for_vault`, `open_for_vault`).
- [`crates/ghostkey-core/src/keys.rs`](../crates/ghostkey-core/src/keys.rs) → `derive_heir_seed`, `compute_vault_secret`: the F2 derivation chain.

---

## 1. The two roles of the master key

The master key does two structurally different jobs. Conflating
them is what makes "rotation" feel hard. Split them apart and only
one role is actually tricky.

### Role A: PII encryption at rest

Used by `crypto::seal_for_vault` / `open_for_vault` to encrypt heir,
owner, and trusted-contact rows at rest under per-vault keys
derived via `HKDF-SHA256(salt = vault_id, ikm = master_key, info =
"ghostkey:contact:v1")`.

This role is **purely off-chain**. The ciphertext sits in the
SQLite DB; nothing about the master key appears on Bitcoin. To
rotate, you re-encrypt every row under a new key and throw away
the old key.

### Role B: F2 server-derived heir keys

Used by `ghostkey_core::keys::derive_heir_seed` to deterministically
recompute an F2 heir's BIP86 account xpub from `(heir_email,
vault_id, master_key)`. The resulting xpub is embedded in the
vault's Taproot descriptor and committed on-chain via the vault
address.

This role is **commitment-on-chain**. The descriptor is a hash
target; you cannot change the master key without producing a
different xpub, which produces a different descriptor, which
produces a different Bitcoin address. The UTXOs are locked to the
old descriptor and remain spendable only by the old heir xpub. So
"rotation" for Role B is not actually rotation. It is
"re-vaulting under a new key generation," which moves funds
on-chain.

---

## 2. Design: key generations, indexed per role

We introduce two independent generation counters, one per role:

```
PII generations:   pii_key_v1, pii_key_v2, ...
F2  generations:   f2_key_v1,  f2_key_v2,  ...
```

The server can hold any subset of generations in memory simultaneously.
Exactly one generation per role is the *current* one. That's what
new writes use. Older generations linger as long as there is at
least one row still tagged to them.

### Env var shape

```
GHOSTKEY_PII_KEY_V1=<base64-32-bytes>      # required
GHOSTKEY_PII_KEY_V2=<base64-32-bytes>      # added during rotation
GHOSTKEY_PII_KEY_CURRENT=V2                 # which generation new writes use

GHOSTKEY_F2_KEY_V1=<base64-32-bytes>       # required if any F2 vault exists
GHOSTKEY_F2_KEY_V2=<base64-32-bytes>       # added if F2 rotation is offered
GHOSTKEY_F2_KEY_CURRENT=V1                  # which generation new F2 vaults derive from
```

Boot-time rules:

- The server refuses to boot unless every PII generation tagged in
  the DB has a matching `GHOSTKEY_PII_KEY_<N>` env var present.
- Same for F2.
- The `*_CURRENT` pointer must reference a loaded generation; the
  server refuses to boot otherwise.

### Backwards compatibility

For the first deploy that introduces this design, the operator
will not have set the new env vars yet. We treat the legacy
`GHOSTKEY_MASTER_KEY` as the V1 of *both* roles:

```
fn pii_key_v1() = GHOSTKEY_PII_KEY_V1 or GHOSTKEY_MASTER_KEY
fn f2_key_v1()  = GHOSTKEY_F2_KEY_V1  or GHOSTKEY_MASTER_KEY
```

The legacy variable is the silent default; the new variables, when
present, win. The migration plan in §4 walks an operator from the
single-key world to the split-key world without an outage.

### Schema additions

```sql
ALTER TABLE vaults ADD COLUMN pii_key_gen INTEGER NOT NULL DEFAULT 1;
ALTER TABLE vaults ADD COLUMN f2_key_gen  INTEGER NOT NULL DEFAULT 1; -- meaningful iff heir_derived = 1
```

`heir_contact_ciphertext`, `heir_contact_nonce`, `trusted_contact_*`,
`owner_contact_*` rows are read against `pii_key_gen` for that
vault. F2 derivation, when triggered, uses `f2_key_gen`.

Why per-vault rather than per-row: every PII column on a vault
shares a key (HKDF over `vault_id`), so tagging one column is
ambiguous. Per-vault is the smallest correct granularity.

---

## 3. Rotation workflows

Three flavours, each with a different urgency profile and a
different blast radius.

### Workflow 3A: Routine PII rotation (quarterly)

Goal: limit the lifetime of any single PII key without disrupting
service. Cadence: every 90 days.

Mechanism: a background re-encryption job pulls one vault at a time,
decrypts every PII column with the row's `pii_key_gen`, re-encrypts
under the *current* PII generation, updates `pii_key_gen`. The job
runs at a tunable rate (default ~1 vault/sec) so a large DB doesn't
peg CPU during off-hours.

Operator steps:

1. Generate a new key (`openssl rand -base64 32`).
2. `fly secrets set GHOSTKEY_PII_KEY_V<N+1>="<new>"` and bump
   `GHOSTKEY_PII_KEY_CURRENT=V<N+1>`. Restart.
3. Watch the boot log for `rotation: re-encrypting <count> vaults
   still on V<N>`. The background job logs progress.
4. When the count reaches zero (logged as `rotation: all vaults at
   V<N+1>`), `fly secrets unset GHOSTKEY_PII_KEY_V<N>`. Restart.
5. Confirm the server boots cleanly without the old key (proving
   no row references V<N> any more).

There is **no outage** during any of these steps. The dual-loaded
server can decrypt both generations; the background job catches
the long tail. New vaults created during rotation use the new
generation directly.

### Workflow 3B: Owner-triggered F2 re-vaulting

Goal: rotate Role B for one F2 vault. Cadence: opt-in, owner-
driven, rare.

Mechanism: there is no in-place rotation for F2. The owner taps
"Refresh heir key" on the vault, which:

1. Server adds the vault to a new descriptor under the *current* F2
   generation, producing a fresh vault address.
2. Owner is shown both addresses + a `bitcoin:` URI to sweep funds
   from old → new. They sign with their own wallet (CLI / Sparrow /
   etc.). Server does not touch keys here.
3. After the sweep confirms on-chain, server marks the old vault
   as `superseded` and the new one as the heir-of-record. The old
   vault stays in the DB for audit, but `issue-claim` against it
   returns "superseded: claim against vault <new>".

This is structurally a *new* vault, not a rotated one, but from
the owner's perspective it's "press a button, follow the wallet
prompt, you're done". The cost is one on-chain transaction
(network fee). No heir-side action required if the rotation
completes before the timelock matures.

Edge: if the timelock matured before the owner finished sweeping,
the heir can claim against the old vault. That's by design. We
don't want a rotation that exists to "delay an heir's claim."

### Workflow 3C: Emergency rotation after suspected leak

Goal: minimise the window of exposure after a master-key
compromise. Cadence: as fast as the operator can move.

Trigger: anything that suggests `GHOSTKEY_MASTER_KEY` (or a
generation key) is in unauthorised hands: git history exposure,
container image leak, accidental log line, employee departure
under bad conditions.

Steps within the first hour:

1. Generate `pii_key_v<N+1>` and `f2_key_v<N+1>` (treat both as
   compromised even if only one is suspect).
2. Set the new secrets and bump both `*_CURRENT` pointers. Restart.
3. Force the re-encryption job to run at maximum rate (env knob).
4. Email every owner whose vault still has `f2_key_gen = <N>` with
   "the server signing key was rotated; if your vault is F2 you
   should tap *Refresh heir key* within 24 hours to rotate
   on-chain, or move funds to a new vault under your own heir
   xpub."

Steps within 24 hours:

5. Disclose. SECURITY.md's reporting promise commits to
   coordinated disclosure when the operator finds a vulnerability;
   the same channel applies here.
6. Re-encryption job has now caught the long tail. Audit
   `pii_key_gen` distribution: every row should be at `<N+1>`.
   Remove `GHOSTKEY_PII_KEY_V<N>`. Restart.

Steps within one week:

7. Audit how many F2 vaults still have `f2_key_gen = <N>` (i.e.
   owners who did not act). For those, the timelock + the on-chain
   fact that the funds haven't moved is the only line of defence:
document in the incident write-up and offer in-person help where
   the owner is reachable.
8. Post-mortem in `JOURNAL.md`.

Honest framing: emergency F2 rotation cannot be made transparent
to the owner. The protocol commits to an xpub on-chain; only the
owner can move funds to a new commitment. The best we can do is
notify quickly and reduce friction.

### Workflow 3D: PII-only rotation without touching F2 (reset path)

Goal: rotate the PII secret without doing anything on-chain.
Cadence: any time a contributor needs to swap out the PII key
specifically (e.g. an operator handoff).

Mechanism: identical to 3A but only the `GHOSTKEY_PII_KEY_*`
variables move. `GHOSTKEY_F2_KEY_CURRENT` stays at the previous
generation. No owner action.

This is the **why-split-them-apart** payoff. Without the split, an
operator who simply wants to swap PII keys is forced through the
F2 re-vault workflow, which costs network fees, owner attention,
and a chain footprint.

---

## 4. Migration from today's single-key world

The first deploy that ships this design will see operators with
only `GHOSTKEY_MASTER_KEY` set. The migration is:

1. **Code lands.** Server reads `GHOSTKEY_PII_KEY_V1` and
   `GHOSTKEY_F2_KEY_V1` with `GHOSTKEY_MASTER_KEY` as the fallback
   for both. Existing rows are auto-tagged `pii_key_gen = 1`,
   `f2_key_gen = 1` via a sqlx migration.
2. **First boot.** Logs print:
   `key generation 1 in use for both PII and F2 (legacy
   GHOSTKEY_MASTER_KEY mode)`.
3. **Operator hardens (optional).** Operator can split the legacy
   key by setting `GHOSTKEY_PII_KEY_V1` and `GHOSTKEY_F2_KEY_V1`
   to the same value the legacy var holds, then unsetting
   `GHOSTKEY_MASTER_KEY`. Same key bytes, two env names. This is
   a no-op crypto-wise; it sets up the operator to rotate roles
   independently later.
4. **Operator rotates PII (optional, recommended within 30 days).**
   Workflow 3A.

The migration is opt-in beyond step 1: an operator who never
sets the new vars keeps the existing single-key world working.

---

## 5. What this design deliberately does *not* do

- **Master-key sharding (Shamir, threshold)**. Out of scope; flagged
  as research in [threat model Q6](./threat-model.md#q6-f2-master-key-escrow).
- **HSM / KMS integration**. Out of scope per the issue. The
  env-var shape stays; an HSM would inject the bytes at boot via
  whatever the platform provides (Fly Secrets, AWS Secrets
  Manager, GCP KMS). The crypto code does not care where the
  bytes came from.
- **Online F2 rotation** (rotating without a new on-chain
  commitment). Not possible by design: the heir xpub is part of
  the descriptor. Any future flow that tries to "rotate F2
  in-place" is a bug.
- **Envelope encryption for the PII key.** A future redesign could
  derive per-vault keys from a long-lived "key-encryption key"
  (KEK) wrapped under the current `pii_key`, so rotation only
  re-wraps the wrappers, not every PII row. Worth considering
  before deploying to a DB with millions of vaults. Today's design
  re-encrypts the rows directly, which is fine at alpha scale.

---

## 6. Implementation plan (separate PR)

This document is the design step. The implementation PR should:

1. Add the migration that introduces `pii_key_gen` / `f2_key_gen`
   columns with default 1.
2. Split `master_key()` in `crypto.rs` into `pii_key(gen)` and
   `f2_key(gen)`, each consulting the loaded generation map.
3. Add the env-var loader for `GHOSTKEY_PII_KEY_V<N>` and
   `GHOSTKEY_F2_KEY_V<N>`, with the `GHOSTKEY_MASTER_KEY`
   fallback documented in §4.
4. Update every call-site:
   - `seal_for_vault` / `open_for_vault` accept the generation and
     consult `pii_key(gen)`. Callers pass the vault row's
     `pii_key_gen`.
   - F2 derivation (`derive_heir_seed`) accepts the generation
     and the corresponding `f2_key(gen)` bytes.
5. Background re-encryption worker (new module `rekey.rs`),
   modelled on `notifier.rs` (poll loop, exponential backoff per
   row, rate-limit). Idempotent; safe to crash mid-batch.
6. Owner-facing route `POST /vaults/:id/rotate-f2` that returns
   the new vault address + sweep URI (Workflow 3B). No key
   material in the response.
7. Boot-time validation: refuse to boot if any row references a
   generation the env does not provide.
8. End-to-end test on a fresh fly staging deploy demonstrating
   3A → 3B → 3D in sequence.

The implementation PR should land on a topic branch and bake on
staging for at least one week before merging to main. A buggy
rotation that locks heirs out is worse than no rotation story.
