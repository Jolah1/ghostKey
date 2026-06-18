Title: Safety: owner Send needs a review step before broadcast; verify deposit address privacy

Labels: safety, loss-risk, ux

## Summary

The dashboard Send flow moves Bitcoin out of the vault, which is irreversible, but it currently has no review or confirmation step before broadcast. The only friction is the password, which authenticates but does not confirm intent. This is the same gap as the heir claim (issue 01, L3), and the two should share one confirmation component. The Add (deposit) and Balance views are mostly good, with one privacy item to verify.

## Send (loss risk)

### S1. No review or confirmation before sending (LOSS, M, shared with L3)
The form takes address, amount, and password, then Send broadcasts. Add a deliberate review step that plays back the destination, the amount, and the fee in plain language before anything is signed and sent. Reuse the same confirm component as the heir claim, since both are irreversible outbound actions.
Done when: a review step shows destination, amount, and fee, and the user confirms before broadcast.

### S2. No visible address validation or echo-back (LOSS, M, verify)
Pasting a wrong but valid address sends funds to a stranger forever. There is no "valid mainnet address" signal and no re-display of the address for the user to verify. Validate the address, show its type, and echo it back (first and last characters) at the review step.
Done when: invalid input is caught, and the user verifies the destination at confirm time.

### S3. No network fee shown (LOSS, M)
"Amount (sats)" has no fee and no "what actually arrives". The user cannot tell what they will pay. Clarify how "Send everything" handles the fee.
Done when: the fee and the net amount sent are visible before confirming.

### S4. "Send everything" drains the inheritance with one click (LOSS, M)
The checkbox sits beside the amount with no special treatment, and checking it empties the vault, which is the inheritance. Give it separation and extra friction, and warn plainly that it leaves the heirs nothing.
Done when: sending everything requires deliberate confirmation and warns about the inheritance impact.

### S5. Sats only amount entry invites magnitude errors (TRUST, S)
"e.g. 50000" with no live fiat or BTC equivalent makes an off-by-a-zero mistake easy on an irreversible action. Show the equivalent value as the user types.
Done when: a live local-currency or BTC equivalent appears while entering the amount.

## Add and deposit

### S6. Verify deposit address reuse (TRUST, privacy, S, verify)
The Add view shows a single Taproot address with a QR and Copy. Confirm whether the address is static and reused or freshly derived. A reused address links every deposit on-chain, which matters for privacy focused users. The descriptor pattern (/0/*) allows fresh derivation.
Done when: the team confirms the behaviour and, if reused, either rotates addresses or notes the privacy tradeoff.

Keep: "Send any amount from any wallet or exchange, as often as you like. New funds join the same plan automatically." Good plain reassurance.

## Balance

### S7. Add reassurance to the balance error (POLISH, S)
"Couldn't load your balance. Tap refresh to try again." is calm and actionable. A load failure can still scare people, so add: "Your Bitcoin is safe on the blockchain. This is only a display problem."
Done when: the error state reassures that funds are safe regardless of the display.
