Title: UX: setup step 2 (password), keep the strength, fix the ordering and a few gaps

Labels: ux, trust, setup

## Summary

This step is close to best-in-class non-custodial onboarding. The house-key metaphor, "we never see it and can never reset it", the save-attestation checkbox, and the "What exactly happens when I click Create vault?" accordion are all worth keeping. The fixes below are about ordering, two missing affordances, and one privacy line. The funding choice being a separate step also resolves the earlier worry that step one carried too much.

## Items

### P1. The critical attestation is buried mid-page (TRUST, S)
"Save this password now, before you go on" with its checkbox sits between Confirm Password and the optional Trusted Contact field, followed by an FAQ and the video recorder, then "Create vault". The one attestation that protects against permanent loss is no longer the last thing before the button. Move it (or re-affirm it) immediately above "Create vault".
Done when: the save-password attestation is the last thing the user sees before creating the vault.

### P2. No password reveal toggle or strength feedback (TRUST, M, verify)
For a password that can never be reset, add a show/hide toggle and a basic strength or word-count signal. The "three or four unrelated words" guidance is excellent; pair it with feedback.
Done when: the user can reveal the password and gets a strength signal.

### P3. Panic-stop is advanced and inline (POLISH, S)
"Pay a tiny panic stop invoice from any wallet to freeze this vault for 90 days" is dense Lightning mechanics in the main flow. It is optional and "leave blank to skip" is good. Collapse it behind an "Advanced" disclosure and lead with the outcome ("freeze this vault for 90 days from any device").
Done when: the mechanic is hidden by default and the outcome leads.

### P4. The video recorder has no storage line at capture (TRUST, S, privacy)
A recorded video of the owner's face and voice is the most identifying data in the product and a serious exposure for a high risk user if the service is ever breached or compelled. Add one plain line by the Record button: where it is stored, that it is encrypted like the rest of the vault, and that it is released only to the named heir on claim.
Done when: a clear storage and encryption line appears at the point of recording.

## Keep

- The "What exactly happens when I click Create vault?" accordion (in-context education at the right moment).
- The house-key metaphor and the "we never see it, can never reset it" framing.
- "We never email your heir from it" and "we never email you anything except check-in reminders" (good privacy promises).
- The video message feature itself (excellent anti-scam design), with P4 added.
