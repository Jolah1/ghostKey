# OpenSats grant application — GhostKey security audit (draft)

Draft for the OpenSats application (also reusable for Spiral / HRF). Fill
the `<<TODO>>` fields before submitting; everything else is sourced from
the repo. The ask is funding for an **independent security audit** of a
frozen scope (issue #183, tag `audit-candidate-1`).

---

**Project name:** GhostKey

**Website:** https://ghostkeyapp.com
**Repository:** https://github.com/Jolah1/ghostKey
**License:** <<TODO: confirm — e.g. MIT / GPL-3.0; see LICENSE / CONTRIBUTING>>
**Main focus:** Bitcoin (self-custodial inheritance)

**Applicant:** <<TODO: name, one-line bio, relevant background, GitHub>>
**Are you the project lead?** Yes <<TODO: list any other maintainers>>

---

## What is GhostKey?

GhostKey is a free, open-source, self-custodial Bitcoin inheritance tool.
An owner locks funds in a Taproot vault with two on-chain spending paths:
the owner can spend anytime, and a named heir can spend only after the
coins have sat untouched past a relative timelock (BIP68 `older(N)`,
enforced by `OP_CHECKSEQUENCEVERIFY`). The owner proves liveness with a
periodic check-in; if they stop, the heir is emailed a one-time claim
link and can sweep the funds once the timelock matures.

The rules live in Bitcoin script, not in our servers: even if GhostKey
disappeared, an offline recovery kit reconstructs the wallet and builds
the signed sweep with Bitcoin Core alone. The owner's key never sits on
our servers.

## Why it matters

Most people with Bitcoin have no inheritance plan, because the existing
options are too complex (run a node, manage multisig, read script policy),
too expensive, or require trusting a custodian that may not outlive them.
GhostKey packages one well-tested inheritance pattern into a five-minute
phone setup while keeping the user in self-custody. Our primary audience
is non-technical users (initial focus: Nigeria), for whom custodial
exchange "inheritance" is the only current alternative — and that is no
inheritance at all.

## Current status

Live, on-chain-proven alpha: a real mainnet vault, plus check-in, heir
claim, guardian claim, and a mainnet recovery drill have all been
verified. The cryptography is exercised end-to-end on regtest against
Bitcoin Core (7 integration tests covering owner spend, heir+timelock
claim, offline sweep, and guardian vaults). What is missing before we
promote to beta and invite real money at scale is the one thing we can't
do ourselves: an **independent security review**.

## What the funds are for

A third-party security audit of a frozen scope (git tag
`audit-candidate-1`). Full scope in
[`docs/audit-scope.md`](./audit-scope.md); summary:

- **`ghostkey-core`** — the Taproot + miniscript vault descriptor and the
  BIP68 relative-timelock recovery branch; PSBT construction and signing;
  the heir/owner sweep builders.
- **`ghostkey-server`** — the key-handling boundary (`crypto.rs`: master
  key loading, AEAD for contacts, HKDF KEK, at-rest token sealing, the
  Door A heir-key derivation), auth/claim-token gating, and the scheduler
  that drives the claimable transition.
- **`ghostkey-web` crypto** — in-browser key generation and sealing
  (`keygen.ts`, `sealing.ts`, `heirKey.ts`).

"What to attack" priorities: timelock bypass / early or permanently-locked
spends in the descriptor; race conditions or early release in the claim
scheduler; the master-key / custody boundary (including the disclosed Door
A reconstruction trade-off); and auth/token handling.

A current threat model is published at
[`docs/threat-model.md`](./threat-model.md) as input to the review.

## Milestones

1. Freeze scope + tag (`audit-candidate-1`) and finalize audit-readiness
   docs. **Done.**
2. Engage a Bitcoin-literate firm (candidates: Coinspect, Cure53, Trail
   of Bits, Least Authority) against the frozen tag.
3. Run the engagement.
4. Remediate criticals/highs on a private branch; request a fix-review.
5. Publish the report (or a summary) in the repo and promote to beta.

## Budget

- Security audit: <<TODO: insert quote(s) — request fixed-scope quotes
  from the firms above; typical range for a scope this size is
  USD <<TODO>>.>>
- Duration: <<TODO: ~N weeks from engagement to published fixes.>>

## Open-source & prior funding

- Open-source: yes — public repo, CODE_OF_CONDUCT, CONTRIBUTING,
  SECURITY policy, and labelled good-first-issues for contributors.
- Prior funding: <<TODO: none / list any.>>

## Anything else

<<TODO: optional — traction, the Nigeria/Pidgin localization plan, or why
now.>>
