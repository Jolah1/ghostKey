# Cake Wallet — export an xpub

Cake Wallet is a multi-asset mobile wallet (iOS and Android) with
sizeable reach in the GhostKey audience. These steps assume the
**Cake Wallet 4.x Bitcoin account flow**.

Estimated time: 2 minutes.

## Heads-up about Taproot

Cake Wallet's Bitcoin support is primarily **Native SegWit**. As
of writing, exporting a BIP86 Taproot xpub from Cake is not a
first-class flow — Cake exposes the wallet's public material as a
single string (the "Public key" in Show Keys), which is a Native
SegWit-class extended public key on the BIP84 path.

GhostKey will accept the exported xpub, but as with BlueWallet,
the Taproot script-path signing has to happen with a Taproot-aware
signer when an heir claims. Read the
[wallet guides index](./README.md#what-ghostkey-expects) for the
implications. For end-to-end Taproot, prefer
[Sparrow](./sparrow.md), [Specter](./specter.md), or
[Coldcard](./coldcard.md).

## What you'll need

- Cake Wallet installed with a Bitcoin wallet created. (Cake
  prompts you to create wallets per coin; pick **Bitcoin**.)
- Your Cake Wallet PIN or biometric unlock — you'll be prompted
  before keys are shown.

## Steps

### 1. Switch to your Bitcoin wallet

If you have multiple wallets (e.g. Monero + Bitcoin), open the
**Wallets** screen from the hamburger menu and tap the Bitcoin
wallet so it becomes the active one.

[SCREENSHOT 1 — Wallets list with the Bitcoin wallet selected]

### 2. Open "Show keys"

From the active Bitcoin wallet, open the hamburger menu (☰), tap
**Security and backup**, then **Show keys**. Authenticate with
your PIN / biometrics when prompted.

[SCREENSHOT 2 — Security and backup screen with Show keys row]

### 3. Copy the public key

Cake displays several fields. The one GhostKey wants is the
**Public key** field — that's the extended public key Cake derived
for the Bitcoin account.

Tap the copy icon next to it.

[SCREENSHOT 3 — Show keys screen with Public key field and copy
button]

**Do not paste the private key, the seed phrase, or the mnemonic
into the GhostKey wizard.** Those are spending secrets. The only
field GhostKey needs is the public key.

### 4. Paste into the GhostKey wizard

On the same phone, open the GhostKey wizard. In the "Connect your
wallet" step, paste into the **Your xpub** field.

If the wizard rejects the paste, Cake may have exported a string
starting with a non-`xpub` prefix; the wizard's inline error tells
you what it expected.

## Troubleshooting

- **"Show keys" is missing from the menu.** Older Cake versions
  put it under Settings → Privacy. Upgrade the app or check that
  menu.
- **The wizard asks for a fingerprint.** Cake does not expose the
  Bitcoin wallet's BIP32 fingerprint directly. For the heir side,
  this is optional. For the owner side, either derive the
  fingerprint via the GhostKey CLI (`ghostkey show-xpub
  --profile <name>` with the same mnemonic) or use a Taproot
  wallet from this list that does expose it.

## Tell me what changed

Cake's menu layout changes between major versions. If the steps
here are stale, please open a PR with the corrected steps and
a fresh screenshot.
