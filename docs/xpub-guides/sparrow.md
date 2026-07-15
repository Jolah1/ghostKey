# Sparrow Wallet: export an xpub

Sparrow is the easiest wallet to export a Taproot (BIP86) xpub from.
It supports Taproot end-to-end: the export, the signing, and the
broadcast can all happen inside Sparrow if you want. These steps
assume **Sparrow 1.9.0 or newer** on Linux, macOS, or Windows.

Estimated time: 3 minutes.

## What you'll need

- Sparrow installed and running.
- Either a wallet you've already created (in which case skip to
  step 2), or a fresh seed if you're making a brand-new GhostKey
  vault wallet.

## Steps

### 1. Create or open a Taproot wallet

In Sparrow, choose **File → New Wallet**, name it (e.g.
`ghostkey-vault`), and click **Create Wallet**.

In the Settings panel that opens, set:

- **Policy Type:** *Single Signature*
- **Script Type:** *Taproot (P2TR)* ← important; the default may
  be Native SegWit

Then click **New or Imported Software Wallet** (or your hardware
wallet device row). Generate a new seed phrase or import the
existing one. **Write the seed down on paper**: Sparrow will not
let you proceed without confirming you've recorded it.

[SCREENSHOT 1: the Wallet Settings dialog with Script Type set to
Taproot (P2TR)]

### 2. Open the wallet's settings

Click the **Settings** cog in the bottom-left, or **Wallet →
Settings** in the menu bar.

[SCREENSHOT 2: Sparrow main window with the Settings tab open]

### 3. Find the xpub on the Keystores tab

In Settings, click the **Keystores** tab. There will be one
keystore row showing your wallet's master fingerprint and
derivation path. For a Taproot wallet the path is
`m/86'/0'/0'` (mainnet) or `m/86'/1'/0'` (testnet/signet).

The xpub is in the **xpub** field. Click the copy icon next to it.

[SCREENSHOT 3: the Keystores tab with the xpub field and copy
button highlighted]

### 4. (Optional) Copy the origin-tagged form

Sparrow also exposes the descriptor for this wallet under the
**Descriptor** tab. The Taproot descriptor will look like:

```
tr([abcdef12/86'/0'/0']xpub6...)
```

The bit in square brackets is the **origin info**: your wallet's
master fingerprint plus the derivation path. GhostKey accepts the
xpub on its own (the wizard will ask for the fingerprint as a
separate field), or you can paste the entire `[abcdef12/86'/0'/0']xpub6...`
string and the wizard will parse out both pieces.

### 5. Paste into the GhostKey wizard

In your browser, return to the GhostKey setup wizard's "Connect
your wallet" step. Paste the xpub into the **Your xpub** field.
If the wizard reports the fingerprint is missing, paste it from
Sparrow's Settings → Keystores tab (the 8 hex characters next to
the derivation path).

[SCREENSHOT 4: GhostKey wizard with the pasted xpub and a green
"looks good" indicator]

## Troubleshooting

- **The xpub starts with `tpub` and the wizard complains about
  network.** You used a testnet/signet wallet but the wizard is
  set to mainnet. Either switch the wizard to signet/testnet
  (top banner), or create a mainnet wallet in Sparrow with
  Script Type Taproot.
- **The Keystores tab shows a `zpub` or `ypub`.** That's a Native
  SegWit or Wrapped SegWit wallet, not Taproot. Go back to
  step 1 and check the Script Type.

## Tell me what changed

If Sparrow moves the export button to somewhere else in a future
version, please open a PR fixing the steps and a fresh screenshot.
