# GhostKey — Architecture

This document explains *why* GhostKey is shaped the way it is. The
[`README`](./README.md) covers *how* to use it.

## Goals

1. **Inheritance without custody.** The heir must be able to claim the
   funds without ever having held them, and without trusting any party
   (us, the notifier server, an oracle, a court).
2. **Owner can change their mind.** Up until the timelock expires the
   owner has unconditional spending power.
3. **No new trust assumptions on top of Bitcoin.** All recovery
   guarantees come from script + BIP68. The off-chain pieces are
   "operational comfort": reminders, dashboards, status pages. They can
   fail or disappear without endangering anyone's coins.

## Non-goals

- Multi-sig coordination of *active* spends (use [BDK Wallet] or
  [Specter] for that).
- A custodial product. We don't hold keys.
- Lightning, sidechains, federations. Mainnet base layer only.

[BDK Wallet]: https://bitcoindevkit.org/
[Specter]: https://specter.solutions/

---

## The script

Every GhostKey vault is a Taproot output with one tapleaf:

```
or_d(
  pk(OWNER),
  and_v(
    v:pk(HEIR),
    older(N)
  )
)
```

In miniscript spelling. Compiled, this becomes:

- a NUMS-keypath internal key (unspendable by construction);
- a single tapleaf with the two branches above.

Spending paths:

| Path  | Witnesses needed                             | When valid |
| ----- | -------------------------------------------- | ---------- |
| Owner | One Schnorr sig from owner's xpub            | Always     |
| Heir  | One Schnorr sig from heir's xpub *AND* the UTXO has accumulated `N` confirmations | After timelock |

`N` is chosen at vault construction (1..=65535 blocks).

### Why a NUMS keypath?

Spending via the keypath would let either party — or anyone who guesses
the discrete log — bypass the script. By committing to a verifiably
unspendable point we force every spend through the explicit script
path, which is what the protocol's safety argument relies on.

### Why `or_d`, not `or_i` or `andor`?

`or_d` (dissatisfiable OR) is the cheapest combinator that lets the
owner sign without revealing the heir's branch. The heir branch is
revealed (in the witness) only when the heir actually claims.

### Why a *relative* timelock, not absolute?

Absolute timelocks (`after(H)`) force the owner to renew before some
calendar height, with no way to extend without minting a new vault.
Relative timelocks (`older(N)`) restart per-UTXO on every confirmation
— which means a check-in is **just a normal Bitcoin transaction** that
spends the vault back to itself. No special on-chain message, no
contract upgrade, no commitment update. The heir's countdown
automatically resets.

---

## Layers

The codebase is intentionally split so that each layer has the
narrowest possible blast radius.

```
+---------------------+   no I/O. pure: descriptors, PSBTs, BDK wallet construction.
| ghostkey-core       |   Used by every other binary in the workspace.
+---------------------+
          ^
          |
+---------------------+   owner/heir CLI. Holds keys.
| ghostkey-cli        |   Talks to bitcoind RPC. Reads/writes ./.ghostkey/<profile>.
+---------------------+
          ^
          |
+---------------------+   watch-only. Holds NO keys. Persists to SQLite.
| ghostkey-server     |   Tracks check-in deadlines, raises alarms, exposes REST.
+---------------------+
          ^
          |
+---------------------+   React dashboard. Owner heartbeats. Heir status.
| ghostkey-web        |   Talks to the server's REST only.
+---------------------+
```

### `ghostkey-core`

I/O-free. The library compiles a [`Vault`] from owner+heir descriptor
fragments plus a timelock, exposes the descriptor pair (external +
internal chains), and builds PSBTs:

- [`build_check_in`] — owner drains the vault to a freshly revealed
  vault address. Uses an explicit `policy_path` that picks the
  owner-signature branch (otherwise BDK refuses to disambiguate the
  `or_d`).
- [`build_heir_claim`] — heir drains the vault to an address they
  control, using the timelock branch. Sets `nSequence = N` on every
  input so mempool's BIP68 check matches the script's `older(N)`.

The PSBT builders use BDK's policy tree to resolve the right
`policy_path`. The heir walker handles threshold-2 Thresh nodes (the
`and_v(v:pk(HEIR), older(N))`) by selecting **both** children — picking
only the timelock child is what BDK reports as "Not enough items
selected." The owner walker uses BDK's per-node `contribution`
annotation and prefers the child whose contribution is
`Complete { csv: None }`, which correctly distinguishes the spendable
tapleaf path from the NUMS keypath.

[`Vault`]: ./crates/ghostkey-core/src/vault.rs
[`build_check_in`]: ./crates/ghostkey-core/src/psbt.rs
[`build_heir_claim`]: ./crates/ghostkey-core/src/psbt.rs

### `ghostkey-cli`

CLI for the parties that *do* hold keys. State lives under
`./.ghostkey/<profile>/`:

- `mnemonic` — BIP39 phrase, `chmod 600`.
- `vault.json` — serialized `VaultConfig` (descriptors, network,
  timelock, role label).
- `wallet_state.json` — last synced block height.

Commands:

| Command       | Role        | What it does |
| ------------- | ----------- | ------------ |
| `init-keys`   | owner, heir | Generate a fresh mnemonic. |
| `show-xpub`   | owner, heir | Print BIP86 account xpub fragments to share. |
| `make-vault`  | owner, heir | Combine local + counterparty fragments into a vault. |
| `address`     | any         | Reveal the next vault deposit address. |
| `sync`        | any         | Walk bitcoind blocks into the watch wallet. |
| `balance`     | any         | UTXO set + last sync height. |
| `check-in`    | owner       | Build, sign, broadcast a heartbeat tx. |
| `claim`       | heir        | Build, sign, broadcast the timelocked sweep. |

Chain access is via `bitcoind`'s JSON-RPC through
[`bdk_bitcoind_rpc::Emitter`].

[`bdk_bitcoind_rpc::Emitter`]: https://docs.rs/bdk_bitcoind_rpc/

### `ghostkey-server`

A small Axum service that records vault registrations (descriptors
only — **never keys**) and tracks proof-of-life deadlines. SQLite via
`sqlx`. Two tables:

- `vaults` — descriptor pair, network, timelock, cadence (check-in
  period + grace), last check-in timestamp, next deadline, status.
- `events` — append-only log of `registered` / `checkin` / `warning` /
  `alarm` transitions.

A background tick (default every 30 s) bumps any vault past its
deadline to `alarmed` and records an event.

| Route                       | Verb | Purpose |
| --------------------------- | ---- | ------- |
| `/health`                   | GET  | Liveness. |
| `/vaults`                   | POST | Register a vault. |
| `/vaults`                   | GET  | List vaults (summary view). |
| `/vaults/:id`               | GET  | Detail view. |
| `/vaults/:id/checkin`       | POST | Record a successful heartbeat. |
| `/vaults/:id/events`        | GET  | Append-only event log. |

The server refuses to accept anything that isn't a parseable
inheritance descriptor (the `parse_descriptor` call in
`ghostkey-core::descriptor` runs on every registration).

### `ghostkey-web`

Vite + React + TypeScript + Tailwind. The dashboard polls
`/api/vaults` every 5 s and renders one card per vault:

- a live countdown to `next_deadline_at`,
- a status pill (`ok` / `warning` / `alarmed` / `timelock_started` /
  `claimed`),
- a "Check in" button that `POST`s `/api/vaults/:id/checkin`,
- a slide-in detail drawer with the full vault view + event log.

`/api` is proxied to `127.0.0.1:8787` in dev. In production the
dashboard expects to be reverse-proxied alongside the server at the
same origin.

The web layer is intentionally **read/write only against the server**.
It has no access to keys; the worst-case impact of a compromised
dashboard is spurious heartbeats. Funds remain safe.

---

## Threat model

| Actor                                  | Capability                                                                                               | What protects the owner | What protects the heir |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------- | ---------------------- |
| Network observer                       | Reads all chain data                                                                                     | Taproot keypath hides script structure until first spend; descriptor never shipped to chain | Same |
| Compromised heir                       | Has heir mnemonic                                                                                        | Can't spend until timelock elapses; owner can move funds at any time before then | n/a |
| Compromised owner                      | Has owner mnemonic                                                                                       | n/a                     | Heir loses the inheritance, but never the principal — owner could have spent anyway |
| Compromised notifier server            | Can mark deadlines as missed/met, drop notifications                                                     | No effect on owner's funds: server holds no keys | Worst case: heir misses the alarm and is late to claim. The on-chain timelock still gates them. |
| Compromised dashboard / hostile JS     | Can call `/api/...` as the visitor                                                                       | At worst calls `/checkin` spuriously (which is desirable behavior); cannot spend | Same |
| Stolen heir mnemonic + missing owner   | Heir attempts early claim                                                                                | n/a                     | Mempool returns `non-BIP68-final` until timelock elapses; heir simply has to wait |

The protocol's recovery guarantees collapse to a single invariant:

> The heir cannot move the UTXO sooner than `N` blocks after its last
> confirmation, and the owner can move it at any time.

Every layer above the chain is a comfort feature.

---

## What's deliberately *not* here yet

- **PSBT export / cold signing.** Right now `check-in` and `claim`
  expect the key material to live in the same process. A future change
  should let owner/heir sign with an offline device by exporting a
  watch-only PSBT and re-importing the signed one.
- **Server-driven notification fan-out.** The server records `alarm`
  events but doesn't yet send email / push / webhook. Hook integration
  is intentionally trivial: poll `/vaults/:id/events`.
- **Multiple heirs / threshold heirs.** The current miniscript hard-codes
  one heir. Extending to k-of-n is a one-line change to the descriptor
  builder; the rest of the stack already works generically.
- **Mainnet checklist.** The CLI and server have only been exercised on
  regtest end-to-end. Before any non-trivial mainnet deployment we want
  a signet integration test with delayed `bitcoind` RPC and a fuzz pass
  on the policy-path resolvers.
