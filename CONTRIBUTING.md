# Contributing to GhostKey

Thank you for considering a contribution. GhostKey is open-source by
design — the whole point is that the protocol survives the project. The
more eyes on the code, the better.

This document covers:

1. [Before you start](#before-you-start)
2. [Setting up your environment](#setting-up-your-environment)
3. [How to propose a change](#how-to-propose-a-change)
4. [Code style](#code-style)
5. [Testing your changes](#testing-your-changes)
6. [Writing commit messages](#writing-commit-messages)
7. [Documentation expectations](#documentation-expectations)
8. [What we especially need help with](#what-we-especially-need-help-with)

For security issues, **do not open a public issue.** See
[`SECURITY.md`](./SECURITY.md).

---

## Before you start

- **Read [`DESIGN.md`](./DESIGN.md) first.** It's the plain-English
  explanation of why the project is shaped the way it is. Most
  arguments about what should change boil down to "the design doc
  already addresses this" or "the design doc is wrong about this" —
  both are valuable, but only after you've read it.
- **Skim [`JOURNAL.md`](./JOURNAL.md)** for context on past decisions.
  A change that contradicts a past decision is fine, but you should
  know which decision you're overturning.
- **Open an issue for non-trivial work** before writing code. We'd
  rather discuss the approach with you for ten minutes than have you
  spend a weekend on a PR we can't accept. Trivial fixes (typos,
  obvious bug fixes, doc improvements) can go straight to a PR.

## Setting up your environment

Prerequisites:
- Rust 1.85 or newer (`rustup install stable`)
- Node 20 or newer (`nvm install 20`)
- Optional: `bitcoind` v25+ on `PATH` for the regtest end-to-end test

Build everything:

```sh
cargo build --workspace
cd ghostkey-web && npm install && cd ..
```

Run the test suite (no Bitcoin node needed):

```sh
cargo test --workspace
cd ghostkey-web && npm run typecheck && npm run build
```

Run the full end-to-end test (spawns its own `bitcoind` in a tempdir):

```sh
cargo test -p ghostkey-core --test regtest_e2e -- --ignored
```

For local development of the dashboard:

```sh
# Terminal 1
export GHOSTKEY_MASTER_KEY="$(openssl rand -base64 32)"
cargo run -p ghostkey-server

# Terminal 2
cd ghostkey-web && npm run dev
```

The dashboard runs on `http://127.0.0.1:5173` and proxies `/api` to
the server on `127.0.0.1:8787`.

## How to propose a change

1. **Fork the repo** and create a branch off `main`:
   ```sh
   git checkout -b feat/short-description
   ```
   Branch names: `feat/...`, `fix/...`, `docs/...`, `refactor/...`,
   `test/...`, `chore/...`. Keep them short.

2. **Make your changes.** Keep PRs focused — one branch, one logical
   change. If you find yourself wanting to fix five unrelated things,
   open five branches.

3. **Run the test suite locally.** A PR with failing tests will be
   bounced back to you. CI runs the same commands; see
   `.github/workflows/`.

4. **Open a PR** against `main`. The PR description should answer:
   - What does this change do?
   - Why is it needed?
   - How did you test it?
   - Anything you're unsure about or want feedback on?

5. **Expect review.** A maintainer will read the diff. Reviews are not
   personal — they're about the code. Push back if you disagree.

## Code style

### Rust

- Run `cargo fmt --all` before committing. We use the default
  `rustfmt` configuration.
- Run `cargo clippy --workspace --all-targets -- -D warnings` and fix
  anything new. We accept the two pre-existing
  `clippy::type_complexity` warnings on the `query_as` tuples in
  `routes.rs` and `psbt_routes.rs`; do not add more.
- Prefer `thiserror` enums for library crate errors (see
  `crates/ghostkey-core/src/error.rs`). Use `anyhow` only in binaries.
- Public APIs need doc comments. Internal helpers don't, unless their
  purpose isn't obvious from the name.
- Don't `unwrap()` in production code paths. Tests are fine.

### TypeScript / React

- Run `npm run typecheck` before committing.
- Prefer named exports.
- All API calls go through `src/api.ts`. Don't call `fetch` directly
  from components.
- Loading and error states are not optional — every data-fetching
  component needs both. See `ClaimPage.tsx` for the pattern.
- Accessibility: every interactive element needs a meaningful
  accessible name. Animations need a `prefers-reduced-motion`
  fallback.

### Markdown

- Wrap prose at ~76 characters where reasonable.
- Use sentence case for headings.
- Don't use emoji in headings or code comments.

## Testing your changes

- **Unit tests** belong next to the code they test, in a
  `#[cfg(test)] mod tests` block at the bottom of the file.
- **Integration tests** for `ghostkey-core` live in
  `crates/ghostkey-core/tests/`. The regtest e2e test is `#[ignore]`
  so CI without `bitcoind` stays green.
- **Web tests** — currently we rely on TypeScript and Vite's build to
  catch regressions. Component tests are welcome but not required.
- **Manual testing** for anything user-facing: run the dashboard
  locally and walk through your change. If a change touches the heir
  claim flow, exercise it end-to-end on regtest with the CLI.

A change that "works on my machine" is not enough. CI must pass
before merge.

### Triaging a `cargo audit` failure

CI runs `cargo audit --deny warnings` on every PR, every push to
`main`, and once a day at 04:17 UTC. The daily run is what catches a
freshly-disclosed CVE in a transitive dep that hasn't been touched
in months. When the job goes red, work through the advisory IDs it
prints in this order:

1. **Is there an upstream fix?** Check the advisory page for the
   fixed-version range, then `cargo update -p <crate>` (or bump the
   pin in `Cargo.toml`). Land the bump in its own commit so the
   audit-fix history is easy to read.

2. **Is it a transitive we can't bump yet?** If pulling the fix in
   would require a major version bump of a parent crate we control
   (e.g. a BDK upgrade), add a per-advisory entry to
   `.cargo/audit.toml`. Each ignore needs:
   - the dependency chain that drags the vulnerable crate in,
   - why the vulnerable code path is unreachable or low-impact in
     GhostKey's threat model,
   - the upstream condition that would let us drop the ignore.

   Match the level of detail in the existing entries — a bare
   `ignore` line with no reasoning will be sent back in review.

3. **Is the vulnerable code path actually reachable in our
   binaries?** If yes, and there's no upstream fix, file a
   `priority:high` issue under `area:security` and pause the
   affected feature until it's resolved. Do not ship a release with
   a known-exploitable advisory.

## Writing commit messages

We follow the format established in the repo's history. Look at
recent commits with `git log --oneline -10` for examples.

Structure:

```
short subject in lowercase, no trailing period

A paragraph explaining what changed and why. Wrap at 76 characters.
Use plain English. No buzzwords.

If the change has multiple parts, use sub-headings:

Section name
  - bullet point
  - another bullet point

What is verified
  - the thing you actually ran to test this

What is NOT verified
  - the thing you couldn't test in your environment
```

The "verified / not verified" footer is mandatory for non-trivial
changes. It's how we keep CHANGELOG-style transparency without a
separate file.

## Documentation expectations

- **README.md** is the project's front door. Keep it short and true.
  Don't add aspirational features to it; if a feature isn't shipped,
  it goes in "What's not built yet".
- **DESIGN.md** explains *why*. Update it when you change the *why*.
- **JOURNAL.md** is the chronological log. Add a new entry for any
  PR that introduces a feature or makes a non-trivial decision.
- **ARCHITECTURE.md** is the technical reference. Update it when
  protocol-relevant code changes.

If your change makes any of these documents inaccurate, your PR
fixes the document too. We don't merge code that contradicts the
docs.

## What we especially need help with

If you want to contribute but don't know where to start, these are
the highest-impact open areas. See the "What's not built yet" section
of [`README.md`](./README.md) for the full list.

### Engineering
- **Notification fan-out** (email first via Postmark / Resend / AWS
  SES; SMS via Twilio; WhatsApp via the Business API). The server
  already generates claim tokens — we just need to deliver them.
- **Address-only setup.** A wizard mode that accepts a bare Bitcoin
  address instead of an xpub, for users who can't easily export an
  xpub. Requires backend work to track a single address as a vault.
- **Lightning check-in.** A `/lnurlp/<vault-id>` endpoint that
  generates a 1-sat invoice, with payment received recorded as a
  check-in.
- **k-of-n heirs.** The descriptor builder hard-codes one heir. The
  miniscript already supports a `thresh(k, ...)` over multiple heirs;
  this is a generalisation of the existing builder.

### Translations
- **Pidgin (planned first).** GhostKey's primary audience is
  Nigerian, and Pidgin is the single language with the widest reach
  across the country. We've scoped a small i18n shell + an EN/PCM
  toggle (auto-detecting `*-NG` browser locales) as the first
  translation milestone — see the JOURNAL "left for later" lists.
  Help reviewing draft Pidgin copy for tone and accuracy will be
  the gating step; the engineering side is straightforward.
- **Yoruba, Igbo, Hausa.** Family-inheritance conversations happen
  in the family's first language, not English. Once the Pidgin
  shell ships, adding more locales is a `vocab/<lang>.ts` file plus
  a toggle option — mechanical work. We need native speakers to
  translate user-facing copy (the landing page, the setup wizard,
  the claim page) without losing the calm, plain-English tone of
  the original. See `ghostkey-web/src/vocab.ts` for centralised
  brand strings today; the i18n shell will expand that surface.
- **French.** Useful for Francophone West Africa. Same shape as the
  three above.

### Documentation
- **Wallet-specific xpub guides.** Step-by-step screenshots for
  Sparrow, BlueWallet, Specter, Coldcard, and Cake — where in each
  wallet to find the xpub. Today these live as one-line hints in the
  setup wizard; full guides with screenshots would lower the
  friction for non-technical owners.
- **A signet smoke-test playbook.** End-to-end manual test on
  Bitcoin signet, from vault creation to a successful heir claim
  with a real signed PSBT. This is the highest-priority piece of
  pre-mainnet verification.

### Operations
- **CI improvements.** The current workflow runs tests on every PR.
  We'd benefit from cross-platform builds (Linux + macOS) and a
  reproducible-Docker check.
- **Encrypted off-host backups** for the SQLite file, automated and
  documented in `DEPLOY.md`.

---

## License

By contributing, you agree your work will be licensed under the same
terms as the project: MIT or Apache-2.0 at the user's option.
