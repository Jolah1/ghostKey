# GhostKey roadmap

*Written 2026-07-02, from a full codebase review. This is the plan from
live-on-mainnet **alpha** to a beta worth telling people about, and the
growth work after that. Tracking issue for the beta gates: [#188](https://github.com/Jolah1/ghostKey/issues/188).*

The ordering rule behind everything below: **protect the users who are
already here, then earn trust, then grow.** Marketing waits for beta;
"founding users, help me test, here's the open code" is the mode until
then.

---

## Where the project actually stands (verified 2026-07-02)

A review of the tree, the issue tracker, and the live surfaces found the
project closer to launch-ready than its own tracking suggested:

- **No secrets in the public repo.** `.env`, SQLite files, and build
  output are ignored and untracked; a pattern scan of every tracked file
  for API keys, xprvs, and private-key material found only false
  positives (a test vector inside the `looks_like_secret` filter tests,
  and the base64-inlined WASM). The public threat model
  ([threat-model.md](./threat-model.md)) is a strength, not a leak — the
  design does not rely on obscurity.
- **The no-Core recovery path already exists.** The recovery kit is a
  self-contained offline HTML file: Argon2id unlock in-page, find coins
  via a public explorer, sign locally in WASM, broadcast. Bitcoin Core
  is correctly framed everywhere as the deepest fallback. What remains
  is validation, not building (#185).
- **The big claim-flow gaps are closed.** The server now waits for real
  on-chain CSV maturity before contacting the heir (#194), and the claim
  page always shows the binding (later) date (#196/#199).
- **Security posture is careful where it counts.** Constant-time token
  compares, hashes at rest, 401-not-404 for unknown vaults, closed-by-
  default admin endpoints, rate limits on every abusable route, and an
  AI chat that refuses pasted key material.
- **Accessibility/performance baseline is good** (skip link,
  `:focus-visible`, `prefers-reduced-motion`, lazy zxcvbn, code-split
  claim page, ~193 KB main bundle) — but nothing in CI guards it yet
  (#225).

Known, accepted, documented risks that stay open-eyed until the audit:
the server *can* reconstruct the easy-setup heir key (Door A, #186), and
the master key lives in Fly secrets with the KMS hook built but not
activated (#184, accepted for beta).

---

## Phase 0 — Launch validation (days, not weeks)

No new features. These validate things already built and protect the
founding users already on mainnet.

### 0.1 Validate the no-Core recovery kit — [#185](https://github.com/Jolah1/ghostKey/issues/185)
The last landing-page promise that hasn't been re-proven on current code.

**Done when:** a recovery file downloaded from a funded signet or
mainnet vault completes Find → Sign → Broadcast on current code; then
one genuinely non-technical person recovers using only the file, with no
help. Every stall becomes a filed issue.

### 0.2 Video-message status + re-record — [#222](https://github.com/Jolah1/ghostKey/issues/222)
Found via a real mainnet claim: the heir saw no video, and the owner had
no way to know. Upload is silent best-effort, the dashboard shows no
status, and there is no record-later path.

**Done when:** dashboard shows attached/not-attached per vault; owner
can record/re-record for an existing vault; setup upload failures are
visible; verified on signet end to end.

### 0.3 Fix signet email (Resend test-mode) — [#226](https://github.com/Jolah1/ghostKey/issues/226)
Signet heirs currently get no mail, which blocks every drill below.

**Done when:** a signet vault with a non-owner heir address delivers the
claim email, verified by receiving it.

### 0.4 Accessibility + performance CI gate, device pass — [#225](https://github.com/Jolah1/ghostKey/issues/225)

**Done when:** axe + Lighthouse budgets run in `web.yml` on the four
core pages (fail on serious violations; perf ≥ 90 mobile on landing and
claim); one recorded pass of setup/check-in/claim on a low-end Android
phone and iPhone Safari.

### 0.5 Docs freshness sweep
Mostly done already (stale "Sparrow works" wording is gone; the recovery
guide is kit-first, Core-fallback).

**Done when:** every unchecked `[ ]` claim in
[threat-model.md](./threat-model.md) is re-verified against the current
tree and checked or corrected; README status matches reality; #202
(claim-link jargon) and #203 (more xpub guides) closed.

### 0.6 Founding-user drill
The one gate nobody can automate.

**Done when:** 3–5 real users complete setup → fund → check-in → a
supervised test claim without hand-holding; every stall point filed.

---

## Phase 1 — Trust (the actual beta gate)

### 1.1 Internal security audit pass (prep for #183)
A structured pass over the whole attack surface by someone who can read
the code closely: descriptor/PSBT construction, the sealing crypto,
every route's auth, token lifecycles, the scheduler state machine.
Cheap bugs get fixed here so the paid external hours go to deep issues.

**Done when:** findings written up, criticals fixed, and the
[audit scope](./) updated to reflect the post-fix tree.

### 1.2 Independent security audit — [#183](https://github.com/Jolah1/ghostKey/issues/183)
The #1 beta blocker. Independence is the point: it must be done by
people who didn't build this. Scope it narrow (crypto core + claim
flow) rather than paying full-repo rates; a targeted firm review or a
bounty aimed at Bitcoin-savvy researchers both work.

**Done when:** external review of the scoped surface is complete, all
critical/high findings remediated and re-tested, and the report (or an
honest summary) is published in this repo. Until then the README keeps
saying "treat real funds as at risk."

### 1.3 Door A custody rescope — [#186](https://github.com/Jolah1/ghostKey/issues/186)

**Done when:** the rescoped decision (what's mitigated, what's accepted)
is written into the threat model and audit findings are folded in. No
copy anywhere claims the server "cannot" access the easy-path heir key.

### 1.4 Claim fire-drill mode — [#223](https://github.com/Jolah1/ghostKey/issues/223)
The highest-trust feature we can ship. Inheritance tools fail silently;
a rehearsal converts "trust me" into "watch it work."

**Done when:** owner triggers a drill in one click; heir completes the
full claim UX (signet twin / dry-run, no mainnet broadcast possible);
the owner dashboard permanently records "your heir completed a practice
claim on [date]"; signet e2e covers the loop.

---

## Phase 2 — Onboarding reach

### 2.1 Address-only setup — [#205](https://github.com/Jolah1/ghostKey/issues/205)
The biggest funnel widener: "paste an address" instead of "paste your
xpub" for the wallets (and people) that can't export one.

**Done when:** a vault can be created from a bare address with its
trade-offs stated plainly; the wizard still steers capable wallets to
xpub; e2e covers the address-only path through claim.

### 2.2 i18n shell + English/Pidgin toggle — [#204](https://github.com/Jolah1/ghostKey/issues/204)

**Done when:** all user-facing strings live in a locale file; PCM
reviewed by a native speaker; the toggle persists; the claim page and
heir emails honor the *heir's* language independently of the owner's.

### 2.3 Deposit activity reconciliation — [#213](https://github.com/Jolah1/ghostKey/issues/213)

**Done when:** incoming deposits appear as feed events and the feed
reconciles with the shown balance.

---

## Phase 3 — Value and revenue

### 3.1 Installable PWA + actionable push check-ins — [#224](https://github.com/Jolah1/ghostKey/issues/224)
The mobile app, done the cheap correct way. The server-side push stack
(`push.rs`) already exists; this is packaging. Native app-store apps
are an explicit non-goal for now.

**Done when:** the app installs to the home screen on Android and iOS;
a pre-deadline push with an "I'm still here" action completes a check-in
on a real device; push failure still falls back to email; the service
worker never serves stale claim/API responses.

### 3.2 Check-in as subscription — [#112](https://github.com/Jolah1/ghostKey/issues/112)
The revenue model that aligns with the product: paying *is* proof of
life.

**Done when:** free base tier unchanged; a paid tier exists with a
defined price; payment failure alone can never advance a vault toward
claimable (fail-safe tested); documented in DESIGN.md.

### 3.3 One-click on-chain re-vault — [#94](https://github.com/Jolah1/ghostKey/issues/94)
Resolves the accepted trade-off of on-chain gating: the CSV timelock
runs from the last coin move, not from check-ins — which also means a
recovery file found early could be used once the timelock has matured.
Re-vaulting resets that clock for high-value vaults.

**Done when:** owner one-clicks a self-spend with the fee shown first;
the dashboard unlock date updates after confirmation; regtest e2e
covers it.

---

## Phase 4 — Scale (load-triggered, not calendar-triggered)

### 4.1 Postgres + web/worker split — [#193](https://github.com/Jolah1/ghostKey/issues/193)
Correctly deferred. **Done when** the documented load threshold is hit
or ops pain forces it — not before.

### 4.2 Cleanups as they come
#201 (clippy type_complexity), and whatever the audit and drills file.

---

## Beta promotion checklist

Promote alpha → beta (and start being loud) when all of these are true:

- [ ] #183 external audit remediated and published
- [ ] #185 non-technical recovery validated on current code
- [ ] #186 Door A rescope written into the threat model
- [ ] #222 video status/re-record shipped (no more silent gaps at claim)
- [ ] #226 signet email delivers (drills work)
- [ ] Founding-user drill: 3–5 real users through the full loop unaided
