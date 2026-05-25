# GhostKey — Architecture

How the Bitcoin script works, why it's shaped this way, what each layer owns, and where the security boundaries are.

For the product story and setup instructions: [README](./README.md)  
For how decisions were made over time: [JOURNAL](./JOURNAL.md)  
For what's planned next: [DESIGN](./DESIGN.md)

---

## The on-chain script

Every GhostKey vault is a single Taproot address with two spend paths:

```
or_d(
  pk(OWNER),
  and_v(
    v:pk(HEIR),
    older(N)
  )
)
```

| Path | Requirements | When valid |
|---|---|---|
| Owner | Schnorr signature from owner's key | Any time |
| Heir | Schnorr signature from heir's key + N blocks elapsed since last confirmation | After timelock |

`N` is set at vault creation (1–65535 blocks, roughly 1 week to 15 months).

### Why `or_d` and not the alternatives

`or_d` (dissatisfiable OR) lets the owner spend without revealing anything about the heir's branch. The heir's key and timelock only appear in the transaction witness when the heir actually claims. It's the cheapest combinator with that privacy property.

### Why a relative timelock, not an absolute one

Absolute timelocks (`after(H)`) expire at a fixed block height — the owner has to create a new vault before that date, forever. Relative timelocks (`older(N)`, BIP68) measure from when the UTXO was last confirmed. Checking in — moving the funds to a fresh vault address — automatically resets the countdown. No calendar to race against, no vault expiry.

### Why the internal key is unspendable

Every Taproot address has a keypath that bypasses all scripts — just one key signature, no conditions. We don't want that shortcut to exist. The internal key is set to a NUMS point (Nothing Up My Sleeve — a value with no known discrete log), which is verifiably unspendable. Every spend goes through the explicit script; there are no exceptions.

### What checking in actually does on-chain

The server-side heartbeat button records a deadline reset for reminder purposes. The real on-chain check-in is a Bitcoin transaction (built by the CLI's `check-in` command) that spends the vault UTXO back into a fresh vault address with the same script. That fresh UTXO has a new confirmation count — so the heir's countdown restarts from zero.

---

## Layer boundaries

Each layer has the narrowest possible responsibility. If something goes wrong, the blast radius is contained.

```
ghostkey-core    Pure Bitcoin logic. No I/O of any kind.
      ↑
ghostkey-cli     Holds keys. Signs transactions. Talks to Bitcoin nodes.
      ↑
ghostkey-server  Holds no keys. Watches addresses. Tracks deadlines.
      ↑
ghostkey-web     Browser only. Talks to the server. Cannot touch keys.
```

### ghostkey-core

No network calls, no disk reads, no database. Pure functions in, pure Bitcoin data out.

- Builds vault descriptors from owner xpub + heir xpub + timelock
- Constructs owner check-in PSBTs (owner spend path, no timelock branch revealed)
- Constructs heir claim PSBTs (heir spend path + `nSequence = N` for BIP68)

**The BDK policy path gotcha.** When building a transaction, BDK needs to know which spend path to use. For check-ins: select the owner path, explicitly mark the timelock child as not needed. For claims: select *both* the heir's key child and the timelock child — selecting only the timelock causes BDK's "Not enough items selected" error. This logic is in `ghostkey-core/src/psbt.rs` and should not be changed without running the regtest end-to-end test.

### ghostkey-cli

Holds key material. Owned by whoever runs it — owner or heir.

State lives under `.ghostkey/<profile>/`:
- `mnemonic` — BIP39 seed phrase (`chmod 600`)
- `vault.json` — descriptor pair, network, timelock
- `wallet_state.json` — last synced block height (no file locking yet — see JOURNAL entry 1)

Chain data via `bdk_bitcoind_rpc::Emitter`.

| Command | Who | What |
|---|---|---|
| `init-keys` | Owner / heir | Generate wallet |
| `show-xpub` | Owner / heir | Print xpub to share |
| `make-vault` | Owner / heir | Combine xpubs into vault |
| `address` | Any | Next deposit address |
| `sync` | Any | Pull blocks from node |
| `balance` | Any | UTXO set + sync height |
| `check-in` | Owner | Build, sign, broadcast heartbeat tx |
| `claim` | Heir | Build, sign, broadcast claim tx |

### ghostkey-server

Watch-only. No key material. No signing. The worst it can do is miss an alarm or record a spurious heartbeat — it cannot move funds.

SQLite tables:
- `vaults` — descriptor pair, network, timelock, cadence, deadline, status
- `events` — append-only: `registered` / `checkin` / `warning` / `alarmed` / `timelock_started` / `claimed`

Background scheduler (30s tick) advances vault state as deadlines pass. Vault registration is rejected if the descriptor doesn't parse as a valid inheritance policy.

Auth: each vault has a random 32-byte `owner_token` issued at creation. SHA-256 hash stored; raw value returned once. Required as a Bearer token on all mutation endpoints.

Heir contact (name, email/phone) is encrypted at rest with XChaCha20-Poly1305. Per-vault key derived via HKDF-SHA256 from a server master key loaded at startup. Server refuses to boot without `GHOSTKEY_MASTER_KEY`.

| Route | Method | Purpose |
|---|---|---|
| `/health` | GET | Liveness |
| `/vaults` | POST | Register vault |
| `/vaults` | GET | List vaults |
| `/vaults/:id` | GET | Vault detail |
| `/vaults/:id/checkin` | POST | Record heartbeat |
| `/vaults/:id/events` | GET | Event log |
| `/vaults/from-xpub` | POST | Build descriptor from xpubs server-side |
| `/claim/:token` | GET | Resolve claim token → ClaimView |
| `/claim/:token/build-psbt` | POST | Scan chain, build unsigned claim PSBT |
| `/claim/:token/broadcast` | POST | Finalise, broadcast, mark claimed |

Claim tokens: 32 random bytes, base64 for transport, SHA-256 hash in DB, consumed on successful broadcast (not on first view).

Blocking Esplora calls (`full_scan`, `broadcast`) run in `tokio::task::spawn_blocking` to avoid blocking the async runtime.

### ghostkey-web

React + Vite + TypeScript + Tailwind. Read/write only against the server REST API. No key access.

Owner dashboard: vault cards with live countdown, status pill, check-in button, event log drawer. Polls `/api/vaults` every 5 seconds.

Heir claim page (`/claim/:token`): five states — loading, not found, already used, not ready, claimable. Claimable state drives the full PSBT round trip: address input → unsigned PSBT + fee summary → paste signed PSBT → broadcast → txid + explorer link.

`/api` proxied to `127.0.0.1:8787` in dev. Same-origin in production via reverse proxy.

---

## Threat model

| Compromised | Can do | Cannot do |
|---|---|---|
| GhostKey server | Record false check-ins, suppress alarms | Spend funds — no keys here |
| Web dashboard | Send heartbeat requests | Sign transactions, access keys |
| Heir's key (timelock active) | Nothing useful | Spend — mempool rejects as non-BIP68-final |
| Heir's key (timelock expired, owner gone) | Claim — as intended | — |
| Owner's key | Spend or move funds — as the owner always could | — |
| Network observer | See broadcasts after they're public | See script structure before first spend (Taproot hides it) |

The guarantee everything else rests on:

> The heir cannot move the UTXO sooner than N blocks after its last confirmation. The owner can move it any time.

---

## What isn't built yet

**Notification delivery.** The server records `alarmed` events but sends nothing. Email is in progress (`lettre` + STARTTLS). SMS and WhatsApp are next. Until delivery is live, someone needs to watch the events table or poll `/vaults/:id/events`.

**PSBT export for hardware wallets.** The CLI signs in-process. Adding `--export-psbt` (write unsigned PSBT to disk) and `--sign-psbt` (import signed PSBT, broadcast) would support air-gapped and hardware signers. The PSBTs are already standard — it's a CLI workflow change, not a cryptography change.

**Multiple heirs.** One-line change to the descriptor builder (`thresh(k, pk(HEIR1), pk(HEIR2), ...)` instead of `and_v`). The rest of the stack handles it already. Good first contribution.

**Setup from a plain address.** The wizard requires an xpub. Supporting a single receive address (watches one address, not the full wallet) would remove a barrier for beginners.

**Signet end-to-end test.** The full claim flow is verified on regtest. It has not been smoke-tested on signet with real wallet software signing the heir PSBT. This must happen before any mainnet use. It is the single highest-priority remaining task.

**Key rotation.** No path exists yet to rotate `GHOSTKEY_MASTER_KEY` without decrypting and re-encrypting every vault's contact ciphertext.