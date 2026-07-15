# Move 1: make the non-custodial claims true (C0)

Copy-only proposal. No code committed. Goal: keep the marketing strong but stop asserting absolutes that are false for the default no-wallet heir path (Door A), where the server can re-derive the heir key from the master key + vault id + heir email (verified: routes.rs:875-882, heirKey.ts).

What stays true and keeps its punch:
- The OWNER's own key is never on our servers (password-derived). Absolute claims are fine here.
- The heir's own-key setup (Door B / advanced xpub) is fully non-custodial.
- No third party. The server is GhostKey itself (first party), not a third party.

What must change: any blanket "we can never spend your Bitcoin" / "100% non-custodial" that silently includes the Door A heir key.

Verified scope of edits (confirmed by grep across all of ghostkey-web/src + assist.rs): Landing.tsx (2 spots), assist.rs (3 spots), Legal.tsx (2 spots).

Checked and deliberately LEFT ALONE (true as written):
- Landing.tsx:325 "no one can move funds BEFORE the timer runs out. Not us, not them, not anyone.": timelock-scoped and true; this is the honest version of the teeth.
- SetupPortal.tsx:469 "GhostKey never sees your private keys.": the advanced xpub (Door B) screen, where it is fully true.
- Legal.tsx:139/142/259, ClaimPage.tsx:800: all "never hold/store/see," defensible: the server keeps ciphertext and re-derives, it does not hold keys at rest.
- PasswordSetupPortal.tsx:1393 "honestly non-custodial": in context this is the owner's own password/key, where it is true.

---

## 1. Landing.tsx: trust stat row (lines 115-116)

Before:
```
{ strong: "0",        sub: "Third parties" },
{ strong: "100%",     sub: "Non-custodial" },
{ strong: "On-chain", sub: "Guaranteed" },
```

After:
```
{ strong: "0",        sub: "Third parties" },
{ strong: "Your key", sub: "Never stored" },
{ strong: "On-chain", sub: "Guaranteed" },
```

Why: "Your key, never stored" is true without exception (the owner's key is password-derived and never reaches the server). "100% Non-custodial" is the headline that the Door A heir key breaks. "0 Third parties" stays: there is no third party.

---

## 2. Landing.tsx: "Self-custodied keys" card (line 340)

Before:
```
body: "Your private key never sits on our servers. We can never spend your Bitcoin on our own.",
```

After:
```
body: "Your own key never sits on our servers, so no one can move your Bitcoin while you keep checking in. For the strictest setup, give your heir their own key too, and GhostKey holds nothing that can spend it.",
```

Why: drops the false absolute "we can never spend your Bitcoin on our own" (false for Door A), keeps the true and reassuring part (the owner's key is never server-side; the heir branch is timelocked so nothing moves while the owner checks in), and points to Door B as the no-trust option. Honest and still strong.

---

## 3. assist.rs: system prompt fact (line 48)

Before:
```
- The server never holds private keys and can never spend the funds. The recovery file and the independence proof let the owner access funds with no GhostKey involvement at all.
```

After:
```
- GhostKey never stores private keys. The owner's key is derived from their password and never reaches the server. If the owner chose the easiest heir setup (we make the heir a wallet from their email), GhostKey is able to unlock that heir wallet to deliver a claim after the waiting period; it shows on-chain. An owner who wants no company ever able to touch the heir key uses the advanced setup and provides the heir's own public key. The recovery file lets the owner access funds with no GhostKey involvement at all.
```

---

## 4. assist.rs: opening line (line 38)

Before:
```
You are GhostKey AI, the in-app assistant for GhostKey, a non-custodial Bitcoin inheritance tool.
```

After:
```
You are GhostKey AI, the in-app assistant for GhostKey, a Bitcoin inheritance tool built around self-custody: GhostKey never stores keys, and the owner's key is never on our servers.
```

Why: keeps the self-custody identity, drops the unqualified "non-custodial" label the model would otherwise repeat as gospel about the heir path.

---

## 5. assist.rs: hard rule (line 52)

Before:
```
- GhostKey is non-custodial. The server never holds private keys. You must never ask the user to paste their seed phrase, xprv/tprv, mnemonic words, or any private key material. If they do paste one, tell them not to and to treat it as compromised.
```

After:
```
- GhostKey never stores private keys, and the owner's key is never on our servers. Be precise about the one exception: on the easiest heir setup, GhostKey can derive the heir's key to deliver a claim after the waiting period; the advanced setup avoids even that. Do not tell a user it is impossible for GhostKey to ever touch the heir key. You must never ask the user to paste their seed phrase, xprv/tprv, mnemonic words, or any private key material. If they do paste one, tell them not to and to treat it as compromised.
```

Why: this is the grounding fix from A2. It stops the model from confidently repeating the false absolute when a user asks "could GhostKey ever take the money?"

---

## 6. Legal.tsx: ToS summary (lines 96-98)

Before:
```
We never hold your bitcoin, your keys, or your password, so we can't move your money, and we can't recover it for you either.
```

After:
```
We never store your keys or your password, so we can't recover them for you, and we can't touch your funds while you keep checking in. The one exception: on the easy heir setup we can unlock your heir's wallet to deliver a claim after the waiting period, and the advanced setup removes even that.
```

Why: "we can't move your money" is the same false absolute as Landing:340. The rewrite keeps the strong, true promises (never store, can't recover, can't touch while you check in) and names the single exception plainly.

---

## 7. Legal.tsx ("What GhostKey is) and is not" (lines 118-123)

This section is the right home for the scoping. Keep the existing paragraph and add one sentence at the end of it:

Add after "...live on the Bitcoin network, not on our servers." (line 123):
```
One detail to be honest about: if you let us make your heir a wallet from their email, we can unlock that wallet to deliver a claim once your waiting period has passed. If you'd rather we never be able to, use the advanced setup and give us only your heir's public key.
```

Why: the "and is not" section is exactly where the heir-path exception belongs, stated plainly rather than buried.

---

## Done when
- Landing's stat row and "Self-custodied keys" card no longer assert an absolute that the Door A heir key breaks.
- The AI prompt states the one honest exception and is told not to deny it.
- The absolute "no company can ever touch it" language survives only where it is true: the owner's key and the advanced (Door B) heir setup.

Pairs with: setup-custody-copy.md (the two doors), checklist C0 / A1 / A2 / L4 / L6.
