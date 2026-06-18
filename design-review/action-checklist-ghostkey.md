# GhostKey UX action checklist

The working version of the review. The prose review (ux-review-ghostkey.md) is the "why"; this is the "what to do." One row per discrete change, each tagged so the team can triage and route.

## Legend

Severity: LOSS (can cause permanent, unintended loss of funds) / TRUST (erodes confidence or credibility) / POLISH (quality, not risk)
Effort: S (copy or CSS, under an hour) / M (component or state work, hours) / L (flow, design, or backend with a test)
Confidence: CONFIRMED (seen in the live UI) / VERIFY (inferred, needs a code or product check before acting)
Owner: BACKEND / FRONTEND / DESIGN / COPY

## Fix first (the four that matter most)

1. LOSS+TRUST. Reconcile the non-custodial claims with heir key derivation. The heir key is derivable from the server master key (heirKey.ts), so for the heir-derived default path the server can in principle sweep funds after the on-chain timelock; this tensions with "100% non-custodial" and "we can never spend your Bitcoin". Fix the derivation, qualify the claims, or disclose, and confirm with the team. (C0)
2. LOSS. Guarantee network and timelock agree end to end, with a test that fails the build if a sub day waiting period can ever render. (L1)
3. TRUST. Fix the owner dashboard live state: the "Ready to claim" badge, the dev banner, the doubled words, the raw event codes, the truncated name. (T1 to T5)
4. LOSS. Raise the email confirmation warning to a blocking-prominent state, because it is the guard against an accidental inheritance trigger. (T6 / L5)

---

## Safety and correctness (ship with tests)

| ID | Severity | Effort | Confidence | Owner | Item | Done when |
|----|----------|--------|------------|-------|------|-----------|
| L1 | LOSS | L | VERIFY | BACKEND | Network shown, network in descriptor, and timelock value always agree; production cannot render a sub day waiting period in any owner or heir copy | A regression test asserts the invariant and fails the build on violation; latest mainnet build re-verified |
| L2 | LOSS | M | VERIFY | FRONTEND | "Create vault" disabled until password equals confirm AND "I have saved my password" is checked | Button cannot be triggered with the box unchecked or passwords mismatched; covered by a test |
| L3 | LOSS | L | CONFIRMED | DESIGN+FRONTEND | Both irreversible outbound actions (the heir claim AND the owner Send) get one shared deliberate confirm: plays back amount, destination, and fee in plain words, uses an accessible non-accidental gesture, not a single tap and not a slide | A shared confirm screen exists for claim and send; gesture tested with an older or low-dexterity user in mind |
| L4 | LOSS | M | RESOLVED in code | BACKEND+DESIGN | Heir wallet derives from server master_key + vault_id + heir email (heirKey.ts), so the server CAN reconstruct it. See C0 (issue 08). Reframe the no-wallet checkbox vs advanced-xpub link as the two honest custody doors (copy in setup-custody-copy.md) | Covered by C0; the two doors carry honest custody copy |
| C0 | LOSS+TRUST | L | CONFIRMED in code | BACKEND | Heir-derived path: server holds all three inputs (GHOSTKEY_MASTER_KEY, vault_id, heir email) and runs derive_heir_seed itself (routes.rs:875-882), so it can reconstruct the heir key; after the older(4320) timelock matures it can spend. Collides with "100% non-custodial" / "we can never spend your Bitcoin". Fix the crypto (salt vault_secret with owner-password material) or qualify the claims | Server cannot derive heir keys, OR the claims are made accurate for the heir-derived path (issue 08) |
| L5 | LOSS | M | CONFIRMED | FRONTEND | Email confirmation drives the reminder safety net; set the expectation at setup and enforce visibly on the dashboard | See T6; setup step 2 says a confirmation link is coming |
| L6 | LOSS | M | CONFIRMED in code | DESIGN+FRONTEND | No-wallet (Door A) heir key lives only on the server, so if GhostKey is ever gone the heir recovers ONLY via the heir envelope (Block A). It is built at setup (PasswordSetupPortal.tsx:685) but must not be skippable: make download + save-attestation a prominent, near-required step for Door A, store-with-papers not with the heir. Door B (heir holds key) does not have this dependency. Copy drafted in setup-custody-copy.md | Door A setup blocks continue until the heir backup file is downloaded and its save is attested |

## Owner dashboard trust

| ID | Severity | Effort | Confidence | Owner | Item | Done when |
|----|----------|--------|------------|-------|------|-----------|
| T1 | TRUST | M | CONFIRMED | FRONTEND | Heir chip "Ready to claim" while owner is active is false; show the true state ("Standing by") and do not colour it like a success state | Badge reflects real vault state; green reserved for genuinely claimable |
| T2 | TRUST | S | CONFIRMED | FRONTEND+COPY | Remove or rewrite the dev mainnet banner ("Real money is in scope. Confirm your security review is complete.") | Banner gone from owner and heir flows, or replaced with one calm confidence line |
| T3 | TRUST | S | CONFIRMED | FRONTEND+COPY | Fix doubled "in in"; label the two countdowns (next check in vs next reminder) so they stop appearing to disagree | No doubled words; each timer labelled |
| T4 | TRUST | S | CONFIRMED | FRONTEND | Map raw event codes to plain language ("owner_send", "lightning_invoice_issued") | Activity feed reads in plain English |
| T5 | TRUST | S | CONFIRMED | FRONTEND | Render heir name fully and consistently everywhere ("F..." on the dashboard, "saf" in setup and plan summary) | Full name shows in chip, plan summary, and video copy |
| T6 | LOSS | M | CONFIRMED | FRONTEND | Raise email-confirm from a quiet strip to a prominent banner that persists until confirmed, with the stakes named | Banner stays until confirmed; copy explains why |
| T7 | TRUST | M | CONFIRMED | DESIGN+FRONTEND | Replace the disabled "Locked until next period" hero button with a calm positive resting state | Resting dashboard reads "You are all set"; tappable heartbeat shows only when actionable |
| T8 | POLISH | S | CONFIRMED | FRONTEND | Optional local-currency value beside "6,660 sat" | Owner can see an approximate fiat value |

## Setup, step 2 (password)

| ID | Severity | Effort | Confidence | Owner | Item | Done when |
|----|----------|--------|------------|-------|------|-----------|
| P1 | TRUST | S | CONFIRMED | DESIGN | Move the "Save this password now" attestation to sit immediately above "Create vault" (currently buried above optional fields and an FAQ) | Attestation is the last thing before the button |
| P2 | TRUST | M | VERIFY | FRONTEND | Add a password reveal toggle and basic strength or word-count feedback | User can show the password and gets a strength signal |
| P3 | POLISH | S | CONFIRMED | DESIGN+COPY | Collapse the panic-stop trusted contact behind an "Advanced" disclosure; lead with the outcome, not the invoice mechanic | Mechanic hidden by default; plain outcome shown first |
| P4 | TRUST | S | CONFIRMED | COPY | Add a storage and encryption line by the video Record button (where it lives, encrypted like the keys, released only to the heir on claim) | One plain line at the point of capture |

## Send and funding (dashboard)

| ID | Severity | Effort | Confidence | Owner | Item | Done when |
|----|----------|--------|------------|-------|------|-----------|
| S1 | LOSS | M | CONFIRMED | DESIGN+FRONTEND | Owner Send has no review step; add a confirm playing back destination, amount, and fee before broadcast (shares the L3 component) | A review step precedes every send |
| S2 | LOSS | M | VERIFY | FRONTEND | Validate the Bitcoin address and echo it back for verification at confirm time | Invalid input caught; destination verified before send |
| S3 | LOSS | M | CONFIRMED | FRONTEND | Show network fee and net amount sent; clarify how "Send everything" handles the fee | Fee and net amount visible before confirming |
| S4 | LOSS | M | CONFIRMED | DESIGN+FRONTEND | "Send everything" drains the inheritance with one click beside the amount; add separation, friction, and a plain warning | Draining requires deliberate confirmation and warns about heirs |
| S5 | TRUST | S | CONFIRMED | FRONTEND | Show a live fiat or BTC equivalent while entering a sats amount, to prevent magnitude errors | Equivalent value updates as the user types |
| S6 | TRUST | S | VERIFY | BACKEND | Confirm whether the deposit address is reused; reused addresses link deposits on-chain (privacy) | Behaviour confirmed; addresses rotated or the tradeoff noted |
| S7 | POLISH | S | CONFIRMED | COPY | Add reassurance to the balance load error ("Your Bitcoin is safe on the blockchain. This is only a display problem.") | Error state reassures funds are safe |

## Heir flow

| ID | Severity | Effort | Confidence | Owner | Item | Done when |
|----|----------|--------|------------|-------|------|-----------|
| H1 | TRUST | S | CONFIRMED | COPY | Warm human opening line on the Inherit entry page; soften the title so it does not read as "you did something wrong" | Page leads with reassurance before mechanics |
| H2 | TRUST | S | CONFIRMED | COPY | Drop token vocabulary and the raw URL ("one-time access token", "the bit after /claim/") | Link described as private and single use, no token language |
| H3 | TRUST | M | CONFIRMED | DESIGN | Split the emergency recovery file into a calm heir layer (password and Unlock) and a clearly separated, collapsed expert layer (descriptors, Bitcoin Core) | Heir sees only password and Unlock by default; expert content collapsed |
| H6 | TRUST | S | CONFIRMED | COPY | SMS/WhatsApp claim opener leaks "Bitcoin inheritance" in plaintext while the email hides the label; make SMS label-shy (issue 08, C2) | SMS body names nothing sensitive before the link |
| H7 | LOSS | M | CONFIRMED | DESIGN+FRONTEND | Heir claim default path sends "in one shot" after an address paste; add the shared confirm step (issue 08, C1, shares L3) | Heir confirms amount and destination before broadcast |
| H4 | POLISH | M | VERIFY | DESIGN | Consider defaulting the heir flow to the lighter, calmer theme regardless of the owner setting | A decision is made and documented |
| H5 | LOSS | - | - | - | The claim confirmation lives in L3 | See L3 |

## AI widget and emails

| ID | Severity | Effort | Confidence | Owner | Item | Done when |
|----|----------|--------|------------|-------|------|-----------|
| A1 | LOSS | S | CONFIRMED | COPY | AI anti-leak warning omits the password (the actual GhostKey key); add it: "Never paste your password, seed phrase, or private key here" | The warning names the password |
| A2 | LOSS | M | VERIFY | BACKEND | AI must be grounded in real docs, cannot misstate waiting periods or claim mechanics, and cannot perform actions | Grounding and action boundary verified and stated |
| A3 | TRUST | S | CONFIRMED | COPY | Note that questions are processed by an AI service | One privacy line on the widget |
| A4 | TRUST | S | VERIFY | BACKEND | Confirm-email URL embeds the vault UUID, which leaks via mail providers; verify sensitivity and link expiry | Vault id confirmed safe or removed; expiry confirmed |
| A5 | POLISH | S | CONFIRMED | COPY | "nudge you here" to "remind you here" in the confirm email | Plain wording |

## Copy and plain language (batch, low effort)

| ID | Severity | Effort | Confidence | Owner | Replace | With |
|----|----------|--------|------------|-------|---------|------|
| C1 | TRUST | S | CONFIRMED | COPY | "Real money is in scope. Confirm your security review is complete." | "You are on the live Bitcoin network. Your funds are real." |
| C2 | TRUST | S | CONFIRMED | COPY | "NON-CUSTODIAL", "On-chain GUARANTEED" | "We never hold your keys", "No company can freeze it" |
| C3 | POLISH | S | CONFIRMED | COPY | "no terminal commands" | "nothing technical to install" |
| C4 | TRUST | S | CONFIRMED | COPY | "the channel you pick" | "the way you choose to reach them" |
| C5 | TRUST | S | CONFIRMED | COPY | "Slack if you miss one", "Extra slack" | "Extra time", "Grace period" |
| C6 | TRUST | S | CONFIRMED | COPY | "the alarm fires", "enters its alarm state" | "if you stop checking in", "before the countdown to inheritance begins" |
| C7 | POLISH | S | CONFIRMED | COPY | "A quiet heads-up now" | "A quiet word now" |
| C8 | TRUST | S | CONFIRMED | COPY | "We unwrap your keys in this tab" | "We unlock your vault right here on your device" |
| C9 | POLISH | S | CONFIRMED | COPY | "Read the docs" | "How it works" |
| C10 | TRUST | S | CONFIRMED | COPY | "programmable self-custody continuity for Bitcoin" | "a way to make sure your family can reach your Bitcoin if you are gone" |
| C11 | POLISH | S | CONFIRMED | COPY | panic-stop: "pay a tiny invoice from any wallet to freeze" | lead with "freeze this vault for 90 days from any device", invoice detail secondary |

## Privacy (high risk users)

| ID | Severity | Effort | Confidence | Owner | Item |
|----|----------|--------|------------|-------|------|
| PR1 | TRUST | S | CONFIRMED | COPY | Note that SMS is the least private heir channel, so a careful user can choose well |
| PR2 | TRUST | S | CONFIRMED | COPY | Video message storage and encryption line at capture (same as P4) |
| PR3 | TRUST | S | CONFIRMED | COPY | Recovery kit storage advice should lead with offline options, name email as least private |
| PR4 | POLISH | S | CONFIRMED | COPY | Note the offline or watch only path for checking funds, since a public explorer leaks the address |

## From the initial review, previously untracked (reconciliation 2026-06-18)

These were in the Stage 1 review (ux-review-ghostkey.md) but never made it into a row. Mostly small. Two earlier suspects were checked and one is resolved: the "STEP 1 OF 3 too heavy" finding is fixed (the live PasswordSetupPortal now uses Heir / Password / Fund, funding is its own step); the comparison headline was NOT fixed by the #113 reframe and stays below as R2.

| ID | Severity | Effort | Confidence | Owner | Item | Done when |
|----|----------|--------|------------|-------|------|-----------|
| R1 | POLISH | S | CONFIRMED | COPY | Vault lifecycle copy still says "on-chain"; plainer: "once the waiting time has fully passed" | The lifecycle section avoids "on-chain" jargon |
| R2 | TRUST | S | CONFIRMED | COPY | Comparison headline "Nothing else comes close" (Landing.tsx:402-404) is louder than the calm voice and reads as overclaim on a money product; soften to "How GhostKey compares" and let the table talk | Headline is calm; the table carries the claim |
| R3 | TRUST | S | CONFIRMED | DESIGN | "Why Bitcoin" puts OP_CSV / Taproot / PSBT at the same visual level as plain marketing; add a "For the technically curious" heading so beginners know they can skip it | The deep block is clearly signposted as optional/technical |
| R4 | POLISH | S | CONFIRMED | COPY | Recovery kit download has no loop-close; after download confirm it worked and restate why ("Saved. Keep this somewhere you will still have in years to come") | A confirmation line appears after the kit downloads |
| R5 | POLISH | S | CONFIRMED | COPY | The emergency recovery file uses em-dashes in its own copy, against the house no-em-dash style | The recovery file copy uses no em-dashes |
| R6 | TRUST | S | CONFIRMED | DESIGN | The no-wallet checkbox collides with the next label ("A short note for them") with no spacing, reads as a layout bug; give it breathing room and more prominence (custody framing is separately tracked in L4/L6 and setup-custody-copy.md) | The checkbox has clear spacing and prominence |

---

## Pages not yet reviewed (request before sign off)

These are either unseen or only seen secondhand. Several are higher stakes than anything reviewed so far.

1. Setup step 3 of 3, the initial funding step (distinct from the dashboard Add tab, which is now reviewed). The first deposit during onboarding is high stakes and unseen.
2. The real in-app heir claim flow after opening the link (verify, choose wallet, confirm, success). Only the entry page and the emergency file have been seen; the live claim is the single most important flow and is the home of L3 and S1.
1. The advanced xpub paste flow (self-provided key; the genuinely non-custodial path).
2. The vault-created success or confirmation screen.
3. The sign-in failure path (see the note added in the merged review).

Reviewed from source (could not be exercised on mainnet): the heir claim-notification email (excellent anti-scam framing; see issue 08), the heir key derivation (heirKey.ts; see C0), and the claim flow (ClaimPage.tsx; see C1).
Now reviewed from screenshots: the dashboard Add and Send flows (issue 06); the GhostKey AI widget and the reminder confirmation email (issue 07).
