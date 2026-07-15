# Wallet xpub export guides

GhostKey's setup wizard asks for an **xpub**: an extended public key
from your Bitcoin wallet. The xpub lets GhostKey watch the addresses
your wallet generates and build the inheritance script around them.
It **cannot** move your funds; only your wallet's private key can.

These guides walk through getting an xpub out of the wallets the
GhostKey audience uses most. Each guide is 3–5 steps long and is
written for someone who has used the wallet for normal sending and
receiving but has never exported an xpub before.

## Pick your wallet

| Wallet | Type | Guide | Taproot xpub? |
|---|---|---|---|
| [Cake Wallet](./cake.md) | Mobile (iOS/Android) | [cake.md](./cake.md) | No (exports a single SegWit-class public key |
| [BlueWallet](./bluewallet.md) | Mobile (iOS/Android) | [bluewallet.md](./bluewallet.md) | Limited) see guide |
| [Nunchuk](./nunchuk.md) | Mobile + Desktop | [nunchuk.md](./nunchuk.md) | Yes (single-sig) |
| [Sparrow](./sparrow.md) | Desktop (Linux/macOS/Windows) | [sparrow.md](./sparrow.md) | Yes |
| [Specter Desktop](./specter.md) | Desktop (multisig-friendly) | [specter.md](./specter.md) | Yes |
| [Coldcard](./coldcard.md) | Hardware | [coldcard.md](./coldcard.md) | Yes (firmware 5.x+) |
| [Trezor Suite](./trezor.md) | Hardware (Model T / Safe 3 / Safe 5) | [trezor.md](./trezor.md) | Yes, not Model One |

## What GhostKey expects

The vault wraps a **Taproot** script (`tr(...)`), and the wizard
prefers a **BIP86** Taproot xpub at the derivation path
`m/86'/0'/0'` (mainnet) or `m/86'/1'/0'` (testnet/signet).

If your wallet does not support Taproot / BIP86, GhostKey will still
accept a non-Taproot xpub for the heir side and use it as the public
key in the script. The signing wallet on the heir's side must then
produce a Schnorr signature over the Taproot witness, which means
the wallet has to be Taproot-aware *at signing time* even if it
exported a non-Taproot xpub. In practice, prefer wallets that
support Taproot end-to-end (Sparrow, Specter, Coldcard).

## Privacy implications

An xpub is a public key. It cannot spend your funds. But it does let
anyone who holds it:

- Derive **every** address your wallet has generated and will ever
  generate from that account.
- Watch all those addresses on-chain and see their full balance and
  transaction history.

GhostKey's server holds the xpub in order to compute the inheritance
descriptor and watch the vault address for activity. The server
stores no plaintext keys other than the xpub, and the xpub it holds
is the **vault** xpub (the account dedicated to GhostKey) not your
main spending wallet. Keep them separate: use a fresh wallet (or a
new account inside your existing wallet) for the GhostKey vault.

## Contributing a screenshot

These guides use `[SCREENSHOT N]` markers because the maintainer who
wrote the text doesn't have all five wallets installed. If you have
the wallet open and can produce screenshots:

1. Take the shot. Blur out any real addresses, balances, or
   identifying info.
2. Save it as a PNG ≤ 200 KB under `docs/xpub-guides/img/`,
   named `<wallet>-step-<N>.png` (e.g. `sparrow-step-2.png`).
3. Replace the `[SCREENSHOT N]` line with
   `![Description](./img/<wallet>-step-<N>.png)`.
4. Open a PR. Add `area:docs` and `good first issue` labels.

If a step in any of these guides is wrong because the wallet UI
moved between versions, that's also a great first PR: fix the
text in the same PR as the new screenshot.

## When in doubt

The setup wizard accepts a paste; if your xpub starts with `xpub`,
`tpub`, `vpub`, `upub`, `ypub`, or `zpub`, the wizard will parse it.
It also accepts the origin-tagged form `[fingerprint/path]xpub...`.
If the wizard rejects the string, the in-page error tells you what
shape it expected. That error is the fastest way to debug a paste.
