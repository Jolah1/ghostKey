<!--
Thanks for opening a PR! A few quick rules:

  - One PR, one logical change.
  - Tests must pass locally before requesting review.
  - If this changes user-facing behaviour, update README / DESIGN / JOURNAL.
  - If this is a security fix, please open the discussion privately
    via SECURITY.md instead.
-->

## What does this PR do?

<!-- A short, plain description. -->

## Why?

<!-- The user-facing or technical motivation. Link to an issue if there is one. -->

## How did you test it?

<!--
Concrete commands you ran. e.g.
  - `cargo test --workspace` -> 24/24 pass
  - `npm run typecheck && npm run build` -> clean
  - Manual: opened the claim page on regtest, walked through the full
    PSBT round-trip, saw the transaction confirm.

If you couldn't test something in your environment, say so under
"What is NOT verified" below.
-->

## Anything you're unsure about?

<!--
Honest questions are welcome. Better to ask in the PR than to discover
a problem post-merge.
-->

## Checklist

- [ ] Branch is named `feat/...`, `fix/...`, `docs/...`, `refactor/...`, `test/...`, or `chore/...`.
- [ ] `cargo fmt --all` is a no-op on this branch.
- [ ] `cargo clippy --workspace --all-targets -- -D warnings` is clean (or only emits the two pre-existing `type_complexity` warnings).
- [ ] `cargo test --workspace` passes locally.
- [ ] If web code changed: `npm run typecheck && npm run build` passes.
- [ ] If user-facing behaviour changed: README / DESIGN / JOURNAL updated.
- [ ] No secrets, seed phrases, or private keys in the diff.

## What is verified

<!-- The things you actually ran. Be specific. -->

## What is NOT verified

<!--
Honest caveats. e.g. "didn't smoke-test on signet", "no live Esplora
exercise". This is mandatory for non-trivial changes — see the commit
message style in JOURNAL.md.
-->
