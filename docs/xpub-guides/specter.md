# Specter Desktop: export an xpub

Specter Desktop is the go-to wallet for users who want a polished
multisig experience and tight hardware-wallet integration. It has
first-class Taproot support. These steps assume **Specter Desktop
2.0 or newer**.

Estimated time: 3 minutes.

## What you'll need

- Specter Desktop installed and running.
- Either an existing wallet, or a fresh device / seed for a new
  one. Specter speaks to most hardware wallets natively; if you
  don't have one, the **Specter DIY** flow lets you import a
  software wallet by mnemonic.

## Steps

### 1. Open the device that holds the keys

In Specter's left sidebar, click the device whose xpub you want
to export: for example a Coldcard you've already added, or a
"Specter DIY" device.

[SCREENSHOT 1: Specter sidebar with a device selected]

### 2. Add a Taproot key (if you haven't already)

Click **Add new key**. In the dialog, set:

- **Key origin:** the device you just selected.
- **Address type:** *Taproot (single signature)*: this is the
  BIP86 path `m/86'/0'/0'`. If you pick *Native SegWit* by
  mistake the export will be a `zpub` instead.

Specter walks the device through the derivation and adds the new
key under the device.

[SCREENSHOT 2: Add new key dialog with Taproot selected]

### 3. Open the key details

In the device view, click the row for the new Taproot key. Specter
shows the **xpub**, the **fingerprint** (8 hex characters), and
the **derivation path** (`m/86'/0'/0'`).

[SCREENSHOT 3: key details panel showing xpub, fingerprint,
and derivation path]

### 4. Copy the xpub (and fingerprint)

Specter provides copy buttons next to both. Click them in turn
and paste each value into a notes app or directly into the
GhostKey wizard.

The origin-tagged form (useful because it's a single paste) 
looks like:

```
[abcdef12/86'/0'/0']xpub6...
```

You can assemble this manually as `[<fingerprint>/86'/0'/0']<xpub>`
or paste the two fields separately into the wizard's xpub and
fingerprint inputs.

### 5. Paste into the GhostKey wizard

Switch to the GhostKey setup wizard's "Connect your wallet" step.
Paste the xpub (and, if you copied them separately, the
fingerprint).

[SCREENSHOT 4: GhostKey wizard with the paste accepted]

## Troubleshooting

- **The "Address type" dropdown doesn't show Taproot.** Update
  Specter; Taproot was added in 1.10.
- **My device emits a `tpub` instead of an `xpub`.** That's a
  testnet/signet device or session. Set Specter to mainnet (if
  you intend mainnet vaults) by switching the bottom-bar network
  toggle, then re-add the key.

## Tell me what changed

Specter's "Add new key" dialog has been redesigned several times.
If your version doesn't match, please open a PR with the
corrected steps and a fresh screenshot.
