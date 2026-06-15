# Lightning + QR + deep-link mobile audit checklist

A reusable test plan for the Lightning surfaces in the dashboard.
Use this when validating a Lightning sidecar deploy, after a major
change to `LightningCheckin.tsx` / `Dashboard.tsx`, or quarterly as
a regression sweep. The actual audit needs **real phones and real
wallets** — this document doesn't replace that, it makes the
testing reproducible.

For context on why the QR / deep-link surfaces look the way they do,
see [issue #23] and the QR-rendering comment in
`ghostkey-web/src/LightningCheckin.tsx`.

[issue #23]: https://github.com/Jolah1/ghostKey/issues/23

---

## Pre-flight

Before you start, you need:

1. **A staging deploy with Lightning enabled.** `/health` should
   return `lightning_enabled: true`. If you don't have one, deploy
   the LNbits sidecar from
   [`crates/ghostkey-lightning-lnbits/`](../crates/ghostkey-lightning-lnbits/README.md)
   or the Breez sidecar from
   [`crates/ghostkey-lightning-breez/`](../crates/ghostkey-lightning-breez/README.md).
2. **A test vault on the staging app.** Demo mode is fine; the
   audit isn't time-sensitive.
3. **Two phones if possible** — one iOS, one Android — and at least
   five wallets installed across them (see matrix below).
4. **Testnet sats** on the wallets you're paying *from*. Invoices
   default to 20 sats (`GHOSTKEY_LN_CHECKIN_SAT`); a few thousand
   sats is plenty for the whole audit.
5. **Permission to take screenshots** of the wallets you test.
   Blur preimages, balances, and addresses before attaching them
   to follow-up issues — see [SECURITY.md](../SECURITY.md) on
   what counts as sensitive.

## The three surfaces being tested

| # | Where | What renders | Source |
|---|---|---|---|
| 1 | Lightning check-in modal | BOLT11 QR + "Copy invoice" button | `ghostkey-web/src/LightningCheckin.tsx` (`qrUrl`, the `lightning:` URI in the copy button) |
| 2 | Dashboard LNURL pay card | LNURL string + `lightning:` deep-link | `ghostkey-web/src/Dashboard.tsx::LnurlCard` |
| 3 | Dashboard LNURL panic card | LNURL string + `lightning:` deep-link | `ghostkey-web/src/Dashboard.tsx::PanicCard` |

Test each surface on each wallet/OS combination in the matrix.

## The test matrix

Copy this table into the issue / PR description and fill it in.
Cells use:

- ✅ **works** — invoice paid, vault deadline reset (or panic
  triggered), no friction worth noting.
- ⚠ **works with friction** — payment succeeds but there's a
  rough edge (e.g. user has to long-press copy because the QR
  scanner missed). Add a one-line note in the cell.
- ❌ **broken** — payment cannot be completed. File a follow-up
  issue and link it.
- ➖ **not tested** — couldn't get to this combo this round.

### iOS

| Wallet | Surface 1 (Check-in QR) | Surface 2 (LNURL check-in) | Surface 3 (LNURL panic) |
|---|---|---|---|
| Phoenix |  |  |  |
| BlueWallet |  |  |  |
| Cash App |  |  |  |
| Wallet of Satoshi |  |  |  |
| Muun |  |  |  |

### Android

| Wallet | Surface 1 (Check-in QR) | Surface 2 (LNURL check-in) | Surface 3 (LNURL panic) |
|---|---|---|---|
| Phoenix |  |  |  |
| BlueWallet |  |  |  |
| Wallet of Satoshi |  |  |  |
| Breez |  |  |  |
| Aqua |  |  |  |

## Per-cell procedure

For each cell, run both of these:

### A. QR scan path

1. Open the surface on a **separate device** (the dashboard on a
   laptop, or the staging URL on a second phone).
2. Open the wallet's "scan" / "send" flow on the test phone.
3. Point the camera at the QR.
4. **Expected:** wallet decodes a 20-sat BOLT11 (or an LNURL on
   surfaces 2 / 3) and offers a confirm step.
5. Confirm → pay.
6. **Expected:** within ~3 seconds the dashboard updates
   (deadline resets for check-in; status flips to *frozen* for
   panic).

Record:
- Did the QR decode at all? (If not: ❌, attach a photo of the
  wallet's "couldn't decode" screen.)
- Did the wallet correctly identify the amount and memo?
- Did the dashboard update?

### B. Deep-link tap path

1. Open the surface in the **mobile browser** on the same phone
   that has the wallet installed.
2. Tap the **Pay with wallet** button (surface 1) or the **Open
   in wallet** chip (surfaces 2 / 3).
3. **Expected:** the OS hands the `lightning:` URI to the
   wallet; the wallet opens at the confirm screen.
4. Confirm → pay.
5. **Expected:** dashboard updates the same way.

Record:
- Did the OS know to launch a wallet? (iOS sometimes shows a
  picker; Android usually goes direct.)
- Was the right wallet picked? (If multiple LN wallets are
  installed, the user gets a chooser — log which wallets appear.)
- Did the wallet open at the confirm screen, or did it open at
  its main view and require the user to manually paste?

## When a cell is ❌

Open a follow-up issue with the label `area:lightning` +
`area:web`. The issue body should contain:

- The wallet + OS + version (`Settings → About` in most wallets).
- Which surface broke (1 / 2 / 3).
- Which path broke (QR scan / deep-link tap / both).
- A screenshot of the failure state (preimages, addresses, and
  balances blurred).
- Whether the matching combo on the other OS / sibling wallet
  also breaks. (Often a wallet's iOS and Android builds diverge.)
- Whether copying the raw BOLT11 / LNURL string and pasting it
  into the wallet's "paste invoice" field works as a fallback.
  (If yes: the bug is in the URI handler. If no: the invoice
  itself is malformed.)

Cross-link the issue back to the umbrella audit issue so the
matrix stays discoverable.

## After the audit

Update `LightningCheckin.tsx`'s top-of-file comment with a
**"Tested on"** section listing the wallets confirmed working
(date + version). Future contributors should be able to look at
that list and know which combinations the project actually
supports without re-running the matrix.

Example:

```ts
/**
 * ...existing comment...
 *
 * ## Tested on
 *
 *   Last audit: 2026-06-15
 *   - ✅ iOS Phoenix 2.5.4 (QR + deep-link)
 *   - ✅ Android Phoenix 2.5.5 (QR + deep-link)
 *   - ✅ iOS Wallet of Satoshi 3.1.2 (QR; deep-link untested)
 *   - ⚠ Android BlueWallet 6.5.7 (QR ok; deep-link opens wallet
 *     but fails to parse — issue #XX)
 *   - ❌ iOS Muun 56.7 (QR decodes, "unsupported invoice" —
 *     Muun rejects sub-min amounts; issue #YY)
 */
```

That comment is the durable artefact. The matrix in this doc is
the procedure to produce it.

## Changes since the issue was filed

- The public QR service (`api.qrserver.com`) the issue's
  "Background" quotes is gone: QRs now render locally via
  `qrcode-generator` into a `data:` URL (shipped with the CSP
  work — external image hosts are blocked). The QR *content*
  is unchanged, so the matrix above still applies as written.
- The check-in amount was raised from 1 sat to a 20-sat default
  because several wallets (Bitnob-class) refuse sub-20-sat
  invoices. If a wallet still rejects the invoice on amount,
  note the wallet's minimum in the cell.
