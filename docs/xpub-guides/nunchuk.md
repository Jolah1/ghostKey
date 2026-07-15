# Nunchuk: export an xpub

Nunchuk is a mobile (iOS/Android) and desktop Bitcoin wallet known for
multisig, but it also does **single-signature Taproot**, which is what
GhostKey wants. The cleanest thing to hand GhostKey from Nunchuk is the
wallet's **descriptor**: it already contains the xpub *and* the
origin tag (`[fingerprint/86'/0'/0']`), so the wizard can read both
pieces from one paste.

These steps assume a recent Nunchuk (2024 or later). Menu labels move
around a little between the mobile and desktop apps; where they differ,
the guide names the action rather than a pixel-exact button.

Estimated time: 4 minutes.

## What you'll need

- Nunchuk installed, with at least one **key** already added (a
  software/hot key you created, or a hardware signer you've paired).

## Steps

### 1. Create a single-sig Taproot wallet

Open **Wallets → Add wallet** (the **+**). Choose:

- **Single sig** (not multisig)
- Address type **Taproot** ← choose this if offered; otherwise pick
  the most modern type available and see Troubleshooting

Select the key you want to use, then create the wallet. Name it
something like `ghostkey-vault`.

[SCREENSHOT 1: the Add wallet screen with Single sig + Taproot]

### 2. Open the wallet's configuration

Open the new wallet, then its **settings** (the gear, or the **⋯ /
More** menu). Look for **Wallet configuration**, **Wallet info**, or
an **Export / Share** action.

[SCREENSHOT 2: the wallet settings with the export/configuration
option]

### 3. Export the descriptor

Choose **Export wallet descriptor** (sometimes shown as **Copy
descriptor** or **Export as descriptor**). Nunchuk gives you a string
that looks like:

```
tr([abcdef12/86'/0'/0']xpub6.../0/*)
```

Copy that whole string. The part in square brackets is the origin tag
(your key's fingerprint + derivation path); the `xpub6...` after it is
the account xpub.

[SCREENSHOT 3: the exported descriptor with the origin tag and xpub]

### 4. Paste into the GhostKey wizard

Back in your browser, return to the GhostKey setup wizard's "Connect
your wallet" step and paste the string into the **Your xpub** field.

You can paste the whole `[abcdef12/86'/0'/0']xpub6...` (the wizard
pulls out the fingerprint for you), or just the `xpub6...` on its own.
If you paste only the xpub and the wizard asks for a fingerprint, it's
the 8 hex characters inside the square brackets.

[SCREENSHOT 4: GhostKey wizard with the pasted key accepted]

## Troubleshooting

- **No Taproot option when creating the wallet.** Update Nunchuk;
  older versions only offered Native SegWit for single-sig. A Native
  SegWit key (its export shows `wpkh(...)` and a `zpub`) still works on
  the heir side: see "What GhostKey expects" in the
  [README](./README.md).
- **The key starts with `tpub` / the descriptor says testnet.** Your
  Nunchuk is on a test network. Switch it to mainnet, or set the
  GhostKey wizard's network to match.
- **You only see a QR code, no text.** Use the **Copy** action rather
  than the QR; GhostKey's wizard needs the text to paste. If only a QR
  is offered, most QR scanners will reveal the descriptor text.

## Tell me what changed

If Nunchuk renames these menus in a future version, please open a PR
fixing the steps and add a fresh screenshot.
