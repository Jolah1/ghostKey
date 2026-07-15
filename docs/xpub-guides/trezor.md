# Trezor Suite: export an xpub

Trezor Suite is the desktop and web app for Trezor hardware wallets.
It can create a **Taproot (BIP86)** account and show you its xpub in a
few clicks. These steps assume a recent Trezor Suite (2023 or later)
and a device that supports Taproot: **Trezor Model T, Safe 3, or
Safe 5**. The older **Model One does not support Taproot**: see
Troubleshooting if that's your device.

Estimated time: 3 minutes.

## What you'll need

- Trezor Suite installed (desktop), or open at suite.trezor.io/web.
- Your Trezor plugged in and unlocked (PIN entered).

## Steps

### 1. Open your Bitcoin wallet

On the Suite dashboard, select **Bitcoin** in the left-hand coin
list. If you have no Bitcoin account yet, Suite offers to create one.

[SCREENSHOT 1: Trezor Suite dashboard with Bitcoin selected]

### 2. Add a Taproot account

Trezor keeps a separate account per address type. Click the account
dropdown (or **+ Add account**) and choose the account **type**:

- **Taproot** ← choose this; the default is usually Native SegWit

Give it a moment to sync. The account label will then read
**Taproot**.

[SCREENSHOT 2: the Add account dialog with Taproot selected]

### 3. Open Account details

With the Taproot account selected, click the **• • •** menu near the
account name and choose **Account details**, then **Show public key
(XPUB)**. Trezor asks you to **confirm on the device** that you want
to reveal the public key: press the checkmark on the Trezor itself.

[SCREENSHOT 3: the Show public key (XPUB) panel]

### 4. Copy the xpub

The panel shows a QR code and the xpub as text. Click **Copy** (or
select the whole string). A Taproot mainnet xpub starts with `xpub`.
This is the account key at `m/86'/0'/0'`.

### 5. Paste into the GhostKey wizard

Back in your browser, return to the GhostKey setup wizard's "Connect
your wallet" step and paste the xpub into the **Your xpub** field.

If the wizard also asks for a **fingerprint**, that's your device's
master fingerprint (8 hex characters). Trezor Suite doesn't show it in
the XPUB panel, so leave it blank if you don't have it to hand:
GhostKey accepts the xpub on its own.

[SCREENSHOT 4: GhostKey wizard with the pasted xpub accepted]

## Troubleshooting

- **No "Taproot" account type offered.** Your device is likely a
  **Model One**, which has no Taproot support. You can still export a
  **Native SegWit** account (its key starts with `zpub`) and use it on
  the heir side, but read "What GhostKey expects" in the
  [README](./README.md): the heir's signing wallet must be
  Taproot-aware at claim time regardless.
- **The xpub starts with `tpub` or `vpub`.** Suite is in **testnet**
  mode (Settings → Coins). Switch back to mainnet, or set the GhostKey
  wizard's network to testnet/signet to match.
- **You don't see "Show public key (XPUB)".** Update Trezor Suite;
  older versions tuck it inside **Account details** under an **XPUB**
  tab.

## Tell me what changed

If Trezor Suite moves these menus in a future version, please open a
PR fixing the steps and add a fresh screenshot.
