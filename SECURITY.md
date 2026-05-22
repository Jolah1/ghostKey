# Security Policy

## Reporting a vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

GhostKey guards Bitcoin inheritance. A vulnerability disclosed in
public — before a fix is ready — gives attackers time to act before
users can update.

To report a vulnerability, please email:

> **security@ghostkey.app** (also: jokunlade@gmail.com)

Include:

- A description of the issue and its impact.
- Steps to reproduce (or proof-of-concept code).
- The affected versions or commits, if you know them.
- Whether you'd like to be publicly credited when the fix ships.

We'll acknowledge receipt within 72 hours. From there, expect:

1. A first response within one business week confirming the issue
   and giving you a rough timeline.
2. A fix in a private branch, reviewed and tested.
3. A coordinated disclosure: we'll let you know when the fix is
   public, you can publish your write-up, we'll credit you in the
   release notes (unless you prefer to stay anonymous).

If you don't get a response within seven days, please follow up — the
email may have been filtered.

## What counts as a security issue

Yes:

- A way to drain coins from a vault without the owner's or heir's
  signature.
- A way to make the heir's claim fail when the timelock has elapsed
  (i.e., the heir is locked out despite being entitled).
- A way to spoof a check-in for someone else's vault.
- A way to leak the server's master key, decrypt heir contacts at
  rest, or recover claim tokens from stored hashes.
- A way to bypass server authentication once it's added.
- A way to deny service such that legitimate alarms never fire.
- A supply-chain compromise: a malicious dependency, a tampered
  release artefact, a build-time injection.

Maybe (please report anyway, we'll triage):

- A way to mark someone else's check-in as missed when it wasn't.
  (Worst case: their heir is delayed by one cycle. Still bad.)
- A way to make the server log credentials it shouldn't be logging.
- A way to enumerate vaults a caller shouldn't be able to see.

Not really:

- Outdated dependency warnings without a known exploit. Open a
  normal PR for these.
- "The CORS policy is permissive." Yes, we know. See the audit and
  roadmap. Open an issue.
- "There's no rate limiting." Same — known gap, open an issue.

## Scope

Security reports cover:

- The Rust crates in `crates/` (core, cli, server).
- The web dashboard in `ghostkey-web/`.
- The deployed production server at the host the project is
  currently using.

Out of scope:

- Vulnerabilities in third-party services we recommend (Sparrow,
  BlueWallet, Specter, etc.). Report those to the project itself.
- Bugs that require physical access to the user's device.
- The user being tricked into pasting their seed phrase into our
  app. We refuse to accept seed phrases anywhere; if you find a
  way to make the app *ask* for one, that's in scope.

## Threat model

A succinct version of the threat model lives in
[`ARCHITECTURE.md`](./ARCHITECTURE.md#threat-model). The shorter
version:

> The Bitcoin network enforces "owner can spend anytime, heir can
> spend after N blocks of UTXO stillness". Everything off-chain is
> comfort software. Compromising the server delays or denies
> *notifications*; it cannot move coins.

If your finding contradicts that summary — e.g., you've found a way
to move coins by attacking the server — that's a top-priority issue.

## Cryptographic baseline

The server uses:
- XChaCha20-Poly1305 for sealing heir contacts at rest.
- HKDF-SHA256 with a per-vault salt for key derivation.
- SHA-256 for claim-token hashes (with constant-time comparison).
- A 32-byte master key loaded from `GHOSTKEY_MASTER_KEY` at startup.

If any of those choices is wrong, or if our implementation deviates
from the standard, please tell us.

## Known limitations (not vulnerabilities)

These are documented gaps, not findings:

- The server has no authentication on mutation endpoints today.
  Vault UUIDs are treated as bearer credentials. This is being
  fixed; see `CONTRIBUTING.md` and the roadmap.
- CORS is wide open. Same reason.
- No notification fan-out yet — alarms write to the events log;
  operators deliver claim links by hand.
- No rate limiting.
- No on-host backups of the SQLite database beyond what `DEPLOY.md`
  describes.

If you find an unknown limitation, *that* is in scope.

## Credit

We maintain a list of reporters who chose to be credited in the
release notes of the fix and in a `SECURITY-THANKS.md` file. Let us
know how you'd like to be credited (real name, handle, "anonymous").

Thank you for helping keep families' Bitcoin safe.
