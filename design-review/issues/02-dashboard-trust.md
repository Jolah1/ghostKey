Title: UX: owner dashboard, correct the live state signals

Labels: ux, trust, frontend

## Summary

The dashboard is the screen owners see most, and a few signals on it currently say the wrong thing or look careless. Each fix raises trust on a money screen. Most are small.

## Items

### T1. Heir badge says "Ready to claim" while the owner is alive and checked in (LOSS-adjacent, M)
This implies the heir can take the funds right now, which is false and frightening. Show the true state, for example "Standing by" or "Will be notified if you stop checking in", and do not colour it with the green used for healthy or success states. Reserve "Ready to claim" and green for the genuinely claimable state.
Done when: the badge reflects real vault state and green is semantic.

### T2. The dev mainnet banner reached production (TRUST, S)
"Mainnet: GhostKey is running on Bitcoin mainnet. Real money is in scope. Confirm your security review is complete." reads as an internal staging message and tells owners the app is not finished. Remove it from owner and heir flows or replace it with one calm line: "You are on the live Bitcoin network. Your funds are real."
Done when: the engineering banner no longer appears to end users.

### T3. Doubled words and two countdowns that appear to disagree (TRUST, S)
"Next reminder in in 4 days" and "The next one opens in in 1 day" both have a doubled "in". The 1 day and 4 day countdowns measure different things but are not labelled, so they look contradictory. Fix the typo and label each timer (next check in available, next reminder).
Done when: no doubled words and each timer is labelled.

### T4. Raw event codes in the activity feed (TRUST, S)
"owner_send" and "lightning_invoice_issued" are database labels. Map every event to plain language, for example "You sent Bitcoin" and "Reminder check in paid".
Done when: the activity feed reads in plain English.

### T5. The heir name renders broken and inconsistently (TRUST, S)
The dashboard chip shows "F..." and setup shows "saf" in two places, while other screens use full names. Render the heir name fully and consistently everywhere it is echoed back.
Done when: the full name shows in the chip, the plan summary, and the video message copy.

### T6. The email-confirm warning is far too quiet (LOSS, M)
"Confirm your email so reminders reach you" sits as a strip near the bottom, yet it guards the one mechanism that prevents an accidental, irreversible trigger. Raise it to a prominent banner that persists until confirmed, with the stakes named: "Until you confirm your email, we cannot remind you to check in."
Done when: the banner persists until confirmed and explains why it matters.

### T7. The hero action is a dead button (TRUST, M)
"Locked until next period" with "in 4 days before countdown begins" makes the main action a disabled button and mixes calm with anxiety. Replace the resting state with a calm positive, for example "You are all set. Next check in opens in 4 days", and show the tappable heartbeat only when it does something.
Done when: the resting dashboard reads as reassuring, not blocked.

### T8. Sats only balance (POLISH, S)
"6,660 sat" has no fiat reference. An optional local-currency value would help owners sense what is at stake.
Done when: an approximate fiat value can be shown.
