# Security Policy

## Reporting a vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

GhostKey guards Bitcoin inheritance. A vulnerability disclosed in
public (before a fix is ready) gives attackers time to act before
users can update.

To report a vulnerability, use GitHub's **private vulnerability
reporting**: the "Report a vulnerability" button under this
repository's **Security** tab
([github.com/Jolah1/ghostKey/security](https://github.com/Jolah1/ghostKey/security)).
It opens a private channel with the maintainers; nothing is public until
a fix ships, and you don't need anyone's email.

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

If you don't get a response within seven days, please follow up on the
report; it may have been missed.

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

If your finding contradicts that summary (e.g., you've found a way
to move coins by attacking the server) that's a top-priority issue.



## Known limitations (not vulnerabilities)

These are documented gaps, not findings:

- The server has authentication on mutation endpoints (Bearer-token,
  per vault, hashed at rest) and on the admin list route. CORS is now
  an allowlist driven by `GHOSTKEY_ALLOWED_ORIGINS`. A dev escape
  hatch (`GHOSTKEY_AUTH_DISABLED=1`) exists and must not be set in
  production; the server refuses to boot with it set unless
  `GHOSTKEY_ALLOW_INSECURE=1` is also set.
- Notification fan-out is live (SMTP + Twilio SMS/WhatsApp) but has
  no rate limiting. A burst of vault creations could mint a burst of
  pending sends; the worker drains them serially with exponential
  backoff per row.
- No per-IP rate limiting on `/assist/chat`, `/vaults/from-xpub`,
  `/vaults/find`, or `/claim/:token/*`. Brute-forcing a 256-bit
  claim token at network speed is infeasible by construction, but
  the assist endpoint can burn a configured Anthropic budget if
  abused.
- `/vaults/:id/sealed-blobs` is unauthenticated by design (the
  blobs are useless without the user's password), but does allow
  an offline Argon2id brute-force against weak passwords once the
  vault UUID is known. KDF parameters are `m=64MiB, t=2, p=1`:
tuned for ~2s on a mid-range phone, deliberately the slowest we
  could justify without user-visible jank.
- The F2 server-derived-heir flow ties the heir's mnemonic to
  `(GHOSTKEY_MASTER_KEY, heir_email, vault_id)`. An attacker who
  holds all three can reconstruct the heir's key. The on-chain
  relative timelock is the only check between such an attacker and
  the heir's funds. See [ARCHITECTURE.md → F2 server-derived
  heirs](./ARCHITECTURE.md#f2-server-derived-heirs).
- `POST /claim/:token/heir-claim` briefly holds the heir xprv in
  process memory to sign the claim transaction. The xprv is never
  written to disk or logs and is dropped at function exit, but a
  compromised server during that call could redirect the
  matured-timelock UTXO. See [ARCHITECTURE.md → Server-side
  signing exception](./ARCHITECTURE.md#server-side-signing-exception).
- No on-host backups of the SQLite database beyond what `DEPLOY.md`
  describes.

If you find an unknown limitation, *that* is in scope.

## Accepted supply-chain advisories

`cargo audit` runs in CI on every push to `main` and nightly. Five
advisories are listed in [`.cargo/audit.toml`](./.cargo/audit.toml)
with explicit per-advisory reasoning rather than a blanket ignore.
The TL;DR:

| Advisory | Crate | Why we accept it |
|---|---|---|
| RUSTSEC-2023-0071 | `rsa` | We use no RSA. The crate is pulled in transitively by `sqlx-mysql` features we never instantiate (we use SQLite). The vulnerable code path is unreachable. |
| RUSTSEC-2026-0098 / 0099 / 0104 | `rustls-webpki 0.101` | Pulled in via `bdk_esplora 0.20 → esplora-client 0.11 → minreq 2.x → rustls 0.21`. Fixing the chain requires a semver-incompatible `bdk_esplora` bump (0.20 → 0.22), which is its own multi-day migration. The vulnerable surface is TLS certificate validation in `minreq`, used only to talk to an operator-configured Esplora URL (default Blockstream). All three CVEs require a malicious server certificate path; we do not accept user-supplied URLs at this layer. |
| RUSTSEC-2025-0134 | `rustls-pemfile 1.x` | Unmaintained notice (not a CVE). Same dep chain as above; resolves the day we bump the BDK family. |

`npm audit` also reports two **moderate** dev-only advisories
(`esbuild ≤0.24.2`, `vite ≤6.4.1`). These affect the local
`npm run dev` server only: the production bundle on Vercel is the
output of `npm run build`, which doesn't ship the affected code. The
fix is `vite@8`, which is a major-version jump with breaking changes
to our build config; we'll bundle it with the next planned Vite
upgrade rather than chase a green badge for a non-issue.

Genuine new advisories (anything not in the table above) will fail
the `audit` job and block the next merge.

## Credit

We maintain a list of reporters who chose to be credited in the
release notes of the fix and in a `SECURITY-THANKS.md` file. Let us
know how you'd like to be credited (real name, handle, "anonymous").

Thank you for helping keep families' Bitcoin safe.
