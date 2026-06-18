Title: Safety: guarantee no path can cause permanent, unintended loss

Labels: safety, loss-risk, needs-test

## Summary

A small group of findings sit above copy and design because they touch the chance of permanent, unintended loss of funds. GhostKey's own first principle is that mistakes cannot be undone, so these need standing guarantees backed by tests, not one time checks. None of these are blocked on visual design.

## Items

### L1. Network and timelock must always agree (BACKEND, needs test)
The network shown to the user, the network encoded in the descriptor, and the timelock value must always agree, and the production build must be unable to render a sub day waiting period in any owner or heir facing copy. An earlier build showed a mainnet banner above a recovery file reading "signet" with a timelock of "1 blocks (about 0 days)". The latest mainnet screenshots look consistent (bitcoin network, 4,320 blocks, about 30 days). Because a disagreement here can let an heir key become spendable far sooner than the owner intended, this needs a regression test.
Done when: a test asserts the invariant and fails the build on violation.

### L2. "Create vault" must be gated (FRONTEND, needs test)
On setup step 2, the "Save this password now" attestation checkbox ("I have saved my password somewhere I can get it back") and the password and confirm fields must gate creation. Verify whether "Create vault" is currently clickable with the box unchecked or the passwords mismatched.
Done when: the button cannot be triggered unless the box is checked and password equals confirm; covered by a test.

### L3. The claim is the one irreversible action and is currently the least guided (DESIGN+FRONTEND)
The moment the heir moves the Bitcoin to themselves cannot be undone, yet it has the least friction in the product. It deserves its own deliberate confirmation step that plays back the amount and the destination in plain language and uses a clear, accessible, non-accidental gesture. Prefer a deliberate two-tap confirm over a slide, because heirs skew older and a slide is the least accessible confirm pattern.
Done when: a dedicated confirm screen exists showing amount and destination, with a gesture validated for low-dexterity and older users.

### L4. Heir key derivation from the owner-typed email (BACKEND+DESIGN)
Deriving the heir's wallet from an owner typed email is a key custody and threat model decision: it determines how the heir's keys come to exist and who could reconstruct them. Confirm the model, then explain it in one plain line at the point of selection so the owner decides knowingly.
Done when: the threat model is documented and one plain line appears at the no-wallet checkbox.

### L5. The email confirmation is load bearing (FRONTEND)
If reminders never arrive because the email was never confirmed, the owner can miss check ins and trigger inheritance by accident. Set the expectation at setup step 2 (a confirmation link is coming) and enforce it visibly on the dashboard (see issue 02, T6).
Done when: setup sets the expectation and the dashboard makes an unconfirmed email impossible to miss.
