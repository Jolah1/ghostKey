# Setup: the two custody doors, written honestly

A copy proposal for the heir setup step. It does two jobs the current UI does not:
1. Reframes the existing no-wallet checkbox vs advanced-xpub link as a deliberate custody and responsibility choice, not a "does your heir own Bitcoin" convenience question.
2. Makes saving the heir recovery file (Block A) a prominent step for the no-wallet path, because that file is the only thing that lets a no-wallet heir recover if GhostKey is ever gone.

Voice follows the house-key style already in the flow: short, plain, no jargon, no em-dashes. All claims here are honest about today's architecture (the heir-derived key is derivable from the server master key, per heirKey.ts and C0). If the Move 2 hardening in issue 08 ships (heir key no longer server-derivable for the vault's life), Door A's "is able to unlock" line can tighten to "only at the moment of a claim". Until then, this is the truthful version.

---

## The choice, framed as two doors

Heading: **How should your heir's wallet work?**

Sub: One choice. You can change it before you create the vault.

### Door A (default): We set up the wallet for them

Label: **We set up the wallet (easiest)**

Body:
> Choose this if your heir doesn't use Bitcoin. We make a wallet for them from their email. They set up nothing and don't need to know about it until the day they claim.
>
> The trade: this is the convenient path, not the strictest one. So claiming can be one tap, GhostKey is able to unlock this wallet. We only ever do that for a real claim, after the waiting period, and it shows on the public blockchain. If you'd rather no company could ever touch it, pick the other door.

### Door B: Your heir holds their own key

Label: **Your heir holds the key (most private)**

Body:
> Choose this if your heir already has a Bitcoin wallet, or you can set one up for them. You paste their public key. GhostKey never holds anything that could spend their Bitcoin, not even during a claim.
>
> The trade: someone has to keep that wallet's recovery words safe, your heir or you on their behalf.

Note on the dropped third idea: "just give us an address to send to" is not a third door. An address can only receive, so GhostKey would have to be the one that signs and sends every claim. That is more custodial than Door A, not less. It is left out on purpose.

---

## The step that protects Door A: save the recovery file

Show this prominently right after the vault is created when Door A was chosen. It is built at setup already (the heir envelope, Block A, in PasswordSetupPortal.tsx). The job here is to stop it being skippable, because for a no-wallet heir it is the only lifeline if GhostKey is gone.

Heading: **Save your heir's backup file**

Body:
> This one file is your heir's safety net if GhostKey is ever unavailable. It lets them claim with no app and no internet. Without it, the easy-wallet option leans on GhostKey still being around.
>
> 1. Download the file.
> 2. Write down the one-time passphrase below. Keep it somewhere separate from the file.
> 3. Store both with your will or important papers. Not with your heir. They don't need it until the day they claim.

Buttons:
- **Download backup file**
- **I've saved the file and the passphrase** (the continue control stays disabled until this is checked, same pattern as the password attestation, P1)

Why "with your papers, not with your heir": it keeps the heir knowing nothing until claim (your pillar) while still giving the no-wallet path a GhostKey-gone escape. The estate holds the file; the heir holds nothing.

---

## Two axes, kept separate (so the copy stays honest)

- Custody (can GhostKey unlock it?): Door A yes, Door B no. True all the time, not an edge case. This is why Door A's copy admits "is able to unlock".
- Availability (can the heir recover if GhostKey vanishes?): both are covered by the recovery file, but Door A only if Block A was saved. This is the genuine rare case, and the step above is what closes it.

Conflating these two is what produced the original "100% non-custodial" claim. The copy above keeps them apart on purpose.
