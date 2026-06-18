Title: Safety: reconcile the non-custodial claim with heir key derivation; confirm step on claim

Labels: safety, loss-risk, trust, custody, claims-accuracy

## Summary

Reviewing the source (not the live flow, which cannot be exercised on mainnet) surfaced a custody finding that touches the product's core marketing claims, plus the heir-side instance of the missing confirm step, plus two fixes to the otherwise excellent heir claim email. The custody item is the highest-weight finding in the whole review.

## C0. The non-custodial claim and heir key derivation (LOSS, TRUST, L, CONFIRMED in code)

Confirmed server-side, not inferred. At setup, for the heir-derived (F2) path, `crates/ghostkey-server/src/routes.rs:875-882` loads the server master key (`crate::crypto::master_key_bytes()`) and calls `ghostkey_core::keys::derive_heir_seed(email, &id, &master, net)`, which returns the heir's secret seed material. All three inputs persist after setup: the master key (`GHOSTKEY_MASTER_KEY` env, per `crypto.rs:5`), the vault id (DB), and the heir email (stored as the heir contact, per `routes.rs:709`). Because the derivation is deterministic, the server can re-run it at any time and reconstruct the heir xprv. This affects only the heir-derived path; the self-provided xpub path and the owner's own password-derived key are genuinely non-custodial.


`ghostkey-web/src/crypto/heirKey.ts` documents the derivation:

  vault_secret = HKDF(salt = server master_key, IKM = vault_id, info = "ghostkey-heir-v1-secret")
  heir_entropy = HKDF(salt = vault_secret, IKM = heir_email, info = "ghostkey-heir-bip39")
  heir key     = BIP86 account from that

The heir's private key is therefore derivable from the server master key plus the vault id plus the heir email, all of which the server holds or stores. The comment states "the server NEVER sees this xprv", which is true in transit, but the server can recompute it. `ClaimPage.tsx` describes the default new-vault claim as the path where "the server builds + signs + broadcasts in one shot".

Combined with the on-chain timelock (per the recovery file: after 4,320 blocks, about 30 days, without movement, the heir branch becomes spendable), this means: for a heir-derived vault older than about a month with no on-chain spend (the normal state of a savings vault), the server holds the technical ability to sweep the funds via the derived heir key, with no password and without the owner having died.

This tensions with the landing page claims "100% NON-CUSTODIAL", "0 THIRD PARTIES", and "Your private key never sits on our servers. We can never spend your Bitcoin on our own." Those hold for the self-provided xpub path. They do not strictly hold for the heir-derived path, which is the recommended default for non-technical heirs.

This is a capability contingent on master-key misuse or breach, not evidence of wrongdoing, but it is the gap between the promise and the mechanism on a money product.

### Recommended resolution

First, the honest constraint (verified): with a zero-knowledge heir AND no third party AND a gone owner, the server is the only live party that can release the heir's key material at claim, so it is cryptographically capable of obtaining that key. This cannot be eliminated without giving up one of those three. The code already acknowledges it (psbt_routes.rs:549-559: "the same exposure a hardware-wallet signer faces when its host is compromised"). So the goal is not "make the server incapable" (impossible here); it is "make the claims true and shrink the window from forever to an instant."

Move 1 (mandatory, cheap). Make the claims accurate. Replace the absolute "we can never spend your Bitcoin" / "your private key never sits on our servers" / "0 third parties" with the true, still-strong version: GhostKey never stores your keys and only touches the heir key for the single moment of a claim, after the timelock, where any misuse is visible on-chain. Keep the absolute claim only for the self-provided-xpub path. Fix assist.rs:48 so the AI stops asserting the false version.

Move 2 (real hardening, medium). Stop deriving the no-wallet heir key from the server master key (routes.rs:875-882). Instead: generate it randomly at setup, seal it, store only ciphertext; gate the unwrap on the claim token, which already lives in the URL fragment ({base}/#/claim/{token}) and is stored only as a hash (hash_claim_token) so it never reaches the server; have the heir browser sign client-side instead of POSTing the xprv. Net: the server cannot derive the key for the vault's life and never sees it at claim; only a single transient window at token mint remains.

Move 3 (promote trustless paths). Make the self-provided-xpub setup and the heir envelope (block A) the clearly labelled maximum-trust-minimization options, and reserve the absolute non-custodial claim for them.

Tradeoff to decide: Move 2 collides with GhostKey-gone independence for the no-wallet heir (no link, no unwrap). That is exactly why block A exists as a separate distributed file. GhostKey-mediated convenience and GhostKey-gone independence cannot live in the same zero-knowledge package; describe them as different paths.

Not fully verified: the exact key the password-vault SealedSetup heir xprv is sealed under (client keygen not read). Move 2 should replace whatever currently makes the heir key server-recoverable.

Done when: the marketing claims and the AI prompt match the architecture (Move 1 shipped), and either the heir key is no longer server-derivable for the vault's life (Move 2) or the team has explicitly accepted transient-at-claim capability and said so in the copy.

## C1. The claim needs a confirm step (LOSS, M, shares L3 / S1)
The default flow has the heir paste a receive address and the server sends in one shot. Address paste is the catastrophic-error surface, and one-shot send means no playback. Add the same confirm component as the owner Send: validate the address, play back amount and destination, deliberate gesture, before broadcast.
Done when: the heir confirms amount and destination before anything is broadcast.

Keep: the ClaimOpened challenge window (owner gets "your claim has started, one check-in stops it" on first open) and the calm NotReadyState. These are good safeguards.

## Heir claim email (additions to issue 07)

### C2. SMS opener leaks "Bitcoin inheritance" in plaintext (TRUST, privacy, S)
The email deliberately withholds the vault label to avoid leaking identity, but the SMS and WhatsApp opener says "left you a Bitcoin inheritance through GhostKey" in cleartext. SMS shows on lock screens and is the least private channel; announcing an inheritance there is a physical-safety risk for a high risk heir. Make the SMS as label-shy as the email; reveal Bitcoin only behind the link.
Done when: the SMS and WhatsApp body no longer name Bitcoin or inheritance before the link.

### C3. The subject is very vague (TRUST, S, decision)
"A message for you about something someone left you" is privacy-careful but cryptic enough to look like spam and be discarded. Decide deliberately between privacy and deliverability; a slightly warmer subject that still hides specifics may land better.
Done when: a deliberate subject decision is made.

Keep (genuinely excellent): the anti-scam framing ("a message like this can look like a scam... look up GhostKey on your own"), the personal opener with the owner's name and note, "the link works once", "nothing happens until you open the link", and the deliberate withholding of the vault label from the email body.
