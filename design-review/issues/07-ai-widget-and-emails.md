Title: UX and safety: AI widget anti-leak wording and grounding; confirm-email privacy

Labels: ux, safety, privacy, ai

## Summary

The GhostKey AI helper and the reminder confirmation email are both well built, with strong anti-phishing instincts. Two fixes matter: the AI warning omits the one secret the owner actually holds (their password), and the AI's accuracy must be grounded because wrong guidance on an irreversible product is worse than none. The confirm email is good, with one privacy item to verify.

## GhostKey AI widget

### A1. The anti-leak warning omits "password" (LOSS-adjacent, S)
The widget warns "Never paste your seed phrase or private key here", but everywhere else in GhostKey the key is a password, a concept the owner actually has, while seed phrase and private key are concepts they never met in the flow. Name the real one: "Never paste your password, seed phrase, or private key here."
Done when: the warning explicitly includes the password.

### A2. Accuracy must be grounded (LOSS, M, verify)
An AI answering questions like "what happens if I lose my password" on an irreversible money product must answer from accurate GhostKey content, not free-generate. Verify it is retrieval-grounded, cannot give wrong guidance about waiting periods or claim mechanics, and has a hard boundary that it cannot perform actions (cannot check in or move funds).
Done when: responses are grounded in real docs and the action boundary is enforced and stated.

### A3. Privacy of questions (TRUST, S)
Questions are processed by an AI service via the server, which is a metadata path for high-risk users. Add one plain line: "Your questions are processed by an AI assistant."
Done when: the widget states that questions go to an AI service.

Keep: "It will never ask for your seed", the scoped expectations, and the meta-aware suggested questions.

## Reminder confirmation email

### A4. The verify URL embeds the vault UUID (TRUST, privacy, S, verify)
The link is .../verify-email/a3755b6e-dac4-4045-a8e1-8473b346a748/<token>, where the UUID is the same vault reference shown on the emergency recovery file. Email is stored, scanned, and forwarded, so this identifier leaks to the mail provider and anyone with inbox access. Verify whether the vault id is sensitive and whether the token alone can carry verification without exposing it. Confirm the link expires, and consider stating the expiry.
Done when: the team confirms the vault id is safe to expose or removes it; expiry behaviour is confirmed.

### A5. "nudge" wording (POLISH, S)
"GhostKey will nudge you here before every check-in is due" uses mild idiom. Plainer: "GhostKey will remind you here before each check-in is due."
Done when: the wording is plain.

Keep: the calm tone, the single action, and "if you didn't set up a GhostKey vault, you can ignore this email, nothing is linked to your address until you tap."

## Still unseen and higher stakes

The heir claim-notification email is the critical one and remains unreviewed. An unexpected "you have inherited Bitcoin, open this link" message looks exactly like a scam, so it needs the strongest anti-scam framing in the product (the owner's name, the video message, the advance-warning context). Review before sign-off.
