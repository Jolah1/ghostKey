# BlueWallet: export an xpub

BlueWallet is a popular mobile wallet (iOS and Android) widely used
in the West African Bitcoin community. These steps assume
**BlueWallet 6.x or newer**.

Estimated time: 2 minutes.

## Heads-up about Taproot

As of writing, BlueWallet HD wallets export a **Native SegWit**
(`zpub`) extended public key, not a Taproot (`xpub` at
`m/86'/0'/0'`) one. GhostKey will accept the `zpub` and convert it
into the script-compatible form, but the wallet used to sign a
spend on the GhostKey side must still be Taproot-aware. Read the
[wallet guides index](./README.md#what-ghostkey-expects) for the
implications.

If end-to-end Taproot matters more to you than mobile convenience,
prefer [Sparrow](./sparrow.md), [Specter](./specter.md), or
[Coldcard](./coldcard.md).

## What you'll need

- BlueWallet installed.
- A wallet of type **HD SegWit (BIP84 Bech32 Native)** already
  created and backed up. If you don't have one yet, use **Add
  Wallet → Bitcoin → Import wallet** with a fresh BIP39 mnemonic
  you've written down on paper.

## Steps

### 1. Open the wallet's detail screen

On BlueWallet's main screen, tap the wallet you want to use for
GhostKey. From the wallet's transactions view, tap the **gear icon
(⚙)** in the top-right.

[SCREENSHOT 1: wallet view with the gear icon highlighted]

### 2. Open "Show wallet's xpub"

Scroll down inside the wallet details screen until you find the
**Show wallet's xpub** row. Tap it.

[SCREENSHOT 2: wallet details with "Show wallet's xpub" row]

BlueWallet will display the xpub as a QR code and a long string
underneath, starting with `zpub...`.

### 3. Copy the string

Tap the string. BlueWallet copies it to your phone's clipboard and
shows a "Copied" toast.

[SCREENSHOT 3: xpub displayed with copied toast]

### 4. Paste into the GhostKey wizard

Open the GhostKey wizard on the same phone (or send the string to
your computer via your messaging app of choice, but keep in mind
the xpub is a privacy-sensitive blob, so prefer an end-to-end
encrypted channel).

In the wizard's "Connect your wallet" step, paste into the
**Your xpub** field. If the wizard reports the fingerprint is
missing, BlueWallet does not expose it directly. You can leave
it blank for the heir side. For the owner side the wizard will
require a fingerprint; on BlueWallet you can compute it from the
mnemonic with the GhostKey CLI:

```sh
ghostkey show-xpub --profile <name>
```

or any BIP39-aware tool.

## Troubleshooting

- **The string starts with `vpub`.** That's a testnet/signet
  zpub. Make sure the GhostKey wizard is in testnet/signet mode
  (see the top banner) before pasting.
- **The wizard rejects the paste as "not an xpub."** Try copying
  the string again: some Android clipboards trim long strings.
  Pasting into a notes app first to verify the length helps.

## Tell me what changed

BlueWallet's settings menu has moved several times over the years.
If your version's menu doesn't match, please open a PR with the
corrected steps and a fresh screenshot.
