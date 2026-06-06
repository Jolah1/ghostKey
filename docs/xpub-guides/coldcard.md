# Coldcard — export an xpub

Coldcard is an air-gapped hardware wallet. The xpub export happens
on the device itself and travels to your computer by SD card or
QR (Mk4). These steps assume **Coldcard Mk4 with firmware 5.x or
newer**, where Taproot (BIP86) is supported.

Estimated time: 4 minutes.

## What you'll need

- A Coldcard you've already initialised (set up with a seed and
  PIN).
- A microSD card formatted FAT32 (any size; the file Coldcard
  writes is < 5 KB), OR — on Mk4 — a QR-capable scanner you can
  point at the screen.

## Steps

### 1. Unlock the Coldcard

Enter your PIN on the device. You should end up on the home
screen.

[SCREENSHOT 1 — Coldcard home screen after PIN entry]

### 2. Navigate to "Export Wallet → Generic JSON"

From the home screen:

```
Advanced/Tools → Export Wallet → Generic JSON
```

If you don't see *Generic JSON* in the export menu, your firmware
predates Taproot support. Upgrade via
**Advanced/Tools → Upgrade Firmware** with a firmware file on the
microSD card.

[SCREENSHOT 2 — Coldcard menu showing Generic JSON export option]

### 3. Insert the microSD card and confirm

Coldcard writes the export to the SD card as a file named like
`coldcard-export.json`. Confirm the prompt to write the file, then
remove the SD card and read it on your computer.

[SCREENSHOT 3 — Coldcard "Saved as coldcard-export.json" screen]

### 4. Find the `bip86` entry

Open the JSON file in any text editor. It contains derivations for
several address types. The Taproot one is keyed `bip86`:

```json
{
  "chain": "BTC",
  "xfp": "ABCDEF12",
  "bip86": {
    "name": "p2tr",
    "xpub": "xpub6...",
    "deriv": "m/86'/0'/0'",
    "first": "bc1p..."
  }
}
```

The fields GhostKey needs:

- `bip86.xpub` → the **Your xpub** field in the wizard.
- `xfp` → the **fingerprint** field in the wizard.

[SCREENSHOT 4 — JSON file open with the bip86 object highlighted]

### 5. Paste into the GhostKey wizard

Switch to the GhostKey wizard's "Connect your wallet" step. Paste
the `xpub` and the `xfp` (master fingerprint).

[SCREENSHOT 5 — GhostKey wizard with the paste accepted]

## QR variant (Mk4 only)

If you have a Mk4 and don't want to use the SD card:

1. Use **Advanced/Tools → Export Wallet → Descriptor** instead of
   Generic JSON.
2. Pick *Taproot (BIP86)* in the prompt.
3. Coldcard displays the descriptor as a sequence of QR codes.
   Scan with any descriptor-aware tool (e.g. Sparrow) and the
   xpub will be visible alongside the descriptor.

This is more steps than the SD-card path; the SD-card path is the
default for a reason.

## Troubleshooting

- **`bip86` is missing from the JSON.** Firmware is too old.
  Upgrade to firmware 5.x or newer.
- **`chain` says `XTN`.** That's testnet/signet. Make sure the
  GhostKey wizard is in testnet/signet mode before pasting.
- **The wizard says the fingerprint is malformed.** Coldcard
  prints the `xfp` in uppercase; GhostKey lowercases it
  automatically, but if you have a mix of characters, retype
  it as 8 hex digits (0-9, a-f).

## Tell me what changed

The Coldcard menu wording changes between firmware versions —
"Export Wallet" used to be under a different parent menu. If your
firmware doesn't match, please open a PR with the corrected steps
and a fresh screenshot.
