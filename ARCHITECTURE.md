# GhostKey Architecture

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

Absolute timelocks (`after(H)`) expire at a fixed block height, so the owner has to create a new vault before that date, forever. Relative timelocks (`older(N)`, BIP68) measure from when the UTXO was last confirmed. Checking in, which moves the funds to a fresh vault address, automatically resets the countdown. No calendar to race against, no vault expiry.

### Why the internal key is unspendable

Every Taproot address has a keypath that bypasses all scripts: just one key signature, no conditions. We don't want that shortcut to exist. The internal key is set to a NUMS point (Nothing Up My Sleeve: a value with no known discrete log), which is verifiably unspendable. Every spend goes through the explicit script; there are no exceptions.

### What checking in actually does on-chain

The server-side heartbeat button records a deadline reset for reminder purposes. The real on-chain check-in is a Bitcoin transaction (built by the CLI's `check-in` command) that spends the vault UTXO back into a fresh vault address with the same script. That fresh UTXO has a new confirmation count, so the heir's countdown restarts from zero.

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

**The BDK policy path gotcha.** When building a transaction, BDK needs to know which spend path to use. For check-ins: select the owner path, explicitly mark the timelock child as not needed. For claims: select *both* the heir's key child and the timelock child. Selecting only the timelock causes BDK's "Not enough items selected" error. This logic is in `ghostkey-core/src/psbt.rs` and should not be changed without running the regtest end-to-end test.

### ghostkey-cli

Holds key material. Owned by whoever runs it, owner or heir.

State lives under `.ghostkey/<profile>/`:
- `mnemonic`: BIP39 seed phrase (`chmod 600`)
- `vault.json`: descriptor pair, network, timelock
- `wallet_state.json`: last synced block height (no file locking yet, see JOURNAL entry 1)

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

Watch-only **for the vast majority of operations**. The server stores no
long-term key material and cannot move funds in the steady state. There
is one narrow exception, the password-vault heir-claim flow, covered
in detail under [Threat model](#threat-model) below.

SQLite tables:
- `vaults`: descriptor pair, network, timelock, cadence, deadline, status, sealed contacts, sealed (password-wrapped) owner/heir key material, claim tokens, one-tap check-in tokens, panic-freeze state.
- `events`: append-only: `registered` / `checkin` / `warning` / `alarmed` / `timelock_started` / `claimed` / `claim_resolved` / `claim_broadcast` / `lightning_invoice_issued` / etc.
- `notifications`: outbound notification queue (subject/body sealed at rest).
- `lightning_invoices`: per-vault Lightning invoice records for check-in and panic flows.

Background workers:
- Scheduler (30s default tick) advances vault state, issues claim tokens, mints per-cycle one-tap tokens, enqueues notifications.
- Notifier (15s default tick) drains the `notifications` queue via SMTP (`lettre` + STARTTLS) or Twilio (SMS / WhatsApp), with exponential backoff and a 6-attempt cap.
- Lightning poller (3s default tick) reconciles invoice status from the optional Breez sidecar.

Vault registration is rejected if the descriptor doesn't parse as a valid inheritance policy.

Auth: each vault has a random 32-byte `owner_token` issued at creation. SHA-256 hash stored; raw value returned once. Required as a Bearer token on owner-side mutation endpoints. An optional process-wide admin token (`GHOSTKEY_ADMIN_TOKEN_HASH`) gates `GET /vaults`.

Heir / owner / trusted contacts are encrypted at rest with XChaCha20-Poly1305. Per-vault key derived via HKDF-SHA256 from `GHOSTKEY_MASTER_KEY` (loaded at startup). Server refuses to boot without it.

**Password-vault material** (added 20260525): when a user creates a vault through the in-browser password flow, the server stores three ciphertexts the browser produced: the owner xprv (wrapped under an Argon2id-derived KEK), the owner token (same KEK), and, for Door A, the heir xprv (wrapped under HKDF(claim_token)). The owner blobs require the user's password. Door A also stores the claim token encrypted under `GHOSTKEY_MASTER_KEY` for scheduled delivery, so DB + master key can reconstruct the heir xprv immediately; CSV still blocks spending until maturity. Door B stores only the heir xpub and no heir ciphertext or setup-time claim token.

| Route | Method | Purpose |
|---|---|---|
| `/health` | GET | Liveness, Lightning / AI / demo flags, default network |
| `/assist/chat` | POST | Proxied Claude Messages API for the in-app onboarding guide. Strips seed-shaped strings. |
| `/vaults` | POST | Register vault from pre-rendered descriptors (CLI flow) |
| `/vaults` | GET | List all vaults (admin only) |
| `/vaults/from-xpub` | POST | Register vault from xpubs + (optional) sealed password-vault blobs |
| `/recovery/request` | POST | Uniformly accept an email-hash recovery request and, on a match, enqueue a one-time link |
| `/recovery/exchange` | POST | Atomically consume a 15-minute recovery link and return matching summaries + password-wrapped blobs |
| `/vaults/:id` | GET / DELETE | Vault detail / owner-initiated removal (cascades) |
| `/vaults/:id/address` | GET | First external receive address |
| `/vaults/:id/balance` | GET | Confirmed + unconfirmed sats via Esplora scan |
| `/vaults/:id/heir` | GET / PUT | Read the sealed heir profile (name/contact/channel); PUT re-seals a new contact + channel (owner-auth). Rejects a contact that doesn't fit the channel; on F2 vaults both address and channel are locked to email. |
| `/vaults/:id/sealed-blobs` | GET | Owner-authenticated password-wrapped owner xprv + owner-token ciphertexts for signed-in tools |
| `/vaults/:id/seal-owner-token` | POST | Re-seal owner token after creation (owner-auth) |
| `/vaults/:id/checkin` | POST | Record heartbeat (owner-auth, once-per-period) |
| `/vaults/:id/checkin-from-link/:token` | POST | One-tap check-in from email link (token IS the auth) |
| `/vaults/:id/events` | GET | Event log (owner-auth) |
| `/vaults/:id/issue-claim` | POST | Manually issue a claim token (owner-auth) |

Recovery requests use a database-backed 10-minute per-email cooldown: repeated
requests preserve the current live link and do not enqueue another message. Expired
rows and used rows older than 24 hours are pruned opportunistically. The uniform
response has a 200 ms minimum duration to reduce coarse timing differences; this is
a floor, not a constant-time guarantee under load.
| `/vaults/:id/lightning-checkin/invoice` | POST | Mint a 1-sat Lightning check-in invoice (owner-auth) |
| `/vaults/:id/lightning-checkin/status/:hash` | GET | Poll invoice status (owner-auth) |
| `/lnurlp/:vault_id`, `/lnurlp/:vault_id/cb` | GET | LNURL-pay endpoints (LUD-06) for static QR check-in |
| `/lnurlp/:vault_id/panic`, `/lnurlp/:vault_id/panic/cb` | GET | LNURL-pay endpoints for panic-freeze |
| `/claim/:token` | GET | Resolve claim token → ClaimView |
| `/claim/:token/sealed-heir` | GET | Heir xprv ciphertext (browser unwraps with HKDF(token)) |
| `/claim/:token/heir-derivation-params` | GET | F2 server-derived heirs: vault_secret + heir email |
| `/claim/:token/build-psbt` | POST | Scan chain, build unsigned claim PSBT (legacy heir flow) |
| `/claim/:token/broadcast` | POST | Finalise + broadcast a signed claim PSBT (legacy heir flow) |
| `/claim/:token/heir-claim` | POST | One-shot password-vault claim: server signs in-memory with heir xprv |

Claim tokens: 32 random bytes, base64-url-no-pad for transport, with a SHA-256 verifier in DB, consumed atomically on successful broadcast (not on first view). Door A and browser-created guardian flows additionally keep the raw token reversibly encrypted under the server master key so the scheduler can deliver it. The `claim_token_used_at IS NULL` predicate is the CAS gate that makes the broadcast race-safe.

Owner / one-tap tokens follow the same shape (random 32 bytes, hash-only at rest, constant-time compare).

Blocking Esplora calls (`full_scan`, `broadcast`) run in `tokio::task::spawn_blocking` to avoid blocking the async runtime.

### ghostkey-web

React + Vite + TypeScript + Tailwind. The setup and claim flows generate, seal, unseal, and briefly hold keys in browser memory; the dashboard otherwise uses the server REST API.

Owner dashboard: vault cards with live countdown, status pill, check-in button, event log drawer. Polls `/api/vaults` every 5 seconds.

Heir claim page (`/claim/:token`): five states: loading, not found, already used, not ready, claimable. Claimable state drives the full PSBT round trip: address input → unsigned PSBT + fee summary → paste signed PSBT → broadcast → txid + explorer link.

`/api` proxied to `127.0.0.1:8787` in dev. Same-origin in production via reverse proxy.

---

## Threat model

| Compromised | Can do | Cannot do |
|---|---|---|
| GhostKey server + production master key | Record false check-ins, suppress alarms, decrypt contacts, and reconstruct current Door A / browser-created guardian claim keys now | Spend through a timelocked branch before CSV maturity; reconstruct a Door B heir key |
| GhostKey server (during a password-vault heir claim) | Briefly hold the heir xprv in process memory for the duration of one `POST /claim/:token/heir-claim` call | Persist the xprv: never touches disk or logs; dropped at end of scope. See [Server-side signing exception](#server-side-signing-exception). |
| GhostKey master key (`GHOSTKEY_MASTER_KEY`) + DB leak | Decrypt every sealed contact; recover stored Door A / guardian claim tokens and their sealed keys; recompute legacy F2 heir keys | Touch funds through those branches before the on-chain timelock matures; derive a Door B heir key |
| Web dashboard XSS | Send heartbeat requests; read the owner token from localStorage | Sign transactions client-side, decrypt sealed material without the user's password |
| Heir's key (timelock active) | Nothing useful | Spend: mempool rejects as non-BIP68-final |
| Heir's key (timelock expired, owner gone) | Claim, as intended | — |
| Owner's key | Spend or move funds, as the owner always could | — |
| A colluding guardian (guardian vaults) | Co-sign a claim together with the child-heir's key once the timelock matures | Claim alone (the policy requires the heir's signature and only one of two guardians); act while the timelock is active or before the optional `after(H)` unlock height |
| Network observer | See broadcasts after they're public | See script structure before first spend (Taproot hides it) |

The guarantee everything else rests on:

> The heir cannot move the UTXO sooner than N blocks after its last confirmation. The owner can move it any time.

### Guardian vaults

A guardian vault is a second descriptor shape for an heir too young to hold a key alone. The single-heir leaf `and_v(v:pk(HEIR),older(N))` is replaced by:

```
or_d(pk(OWNER),and_v(v:pk(HEIR),and_v(v:older(N),or_b(pk(G1),s:pk(G2)))))
```

A claim spend therefore needs the heir's signature plus exactly one of the two guardian signatures, after the relative timelock `older(N)`. No single guardian can spend, and either guardian can stand in for the other, so losing one guardian key does not strand the heir. The owner branch (`pk(OWNER)`) is unchanged, so the owner can still move funds at any time.

An optional unlock-year wraps the guardian quorum in an absolute timelock:

```
or_d(pk(OWNER),and_v(v:pk(HEIR),and_v(v:older(N),and_v(v:after(H),or_b(pk(G1),s:pk(G2))))))
```

Here `after(H)` is a `nLockTime` block-height CLTV (validated below `MAX_CLTV_HEIGHT` = 500,000,000 so it is always read as a height, never a timestamp). The claim PSBT sets `nLockTime` to the current tip height. Both descriptors live in `crates/ghostkey-core/src/descriptor.rs` (`build_guardian_descriptor_string` / `build_guardian_descriptor_pair`); the two-signature claim path is in `crates/ghostkey-core/src/psbt.rs` (`build_guardian_claim`). The server creates these vaults via `POST /vaults/guardian` and, on trigger, the scheduler delivers three claim links: one to the heir and one to each guardian.

The new trust surface is guardian collusion, covered in the threat model (asset A2, attacker Att-9, accepted risk R10).

### Server-side signing exception

The original spec was "server never signs." The password-vault flow
relaxes that in exactly one place: `POST /claim/:token/heir-claim`. When
an heir who never owned Bitcoin opens their claim link, their browser
unwraps the heir xprv from the sealed blob using the claim-token KEK.
Door A stores that token reversibly under the server master key so it
can deliver the link; DB + master key can therefore perform the same
unwrap before the claim. The browser then ships the
xprv over TLS to the server, which:

1. Reconstructs the heir-side BDK wallet from the stored descriptor.
2. Calls `build_heir_claim` (script-path selection, `nSequence = N`).
3. Signs in memory, broadcasts via Esplora, atomically marks the claim
   token consumed.
4. Drops the xprv at function exit. It is never written to disk or
   tracing output.

This is a real trust transfer. An attacker who compromises the server
mid-call could redirect funds to an address they control. The on-chain
trail is public, so the legitimate heir notices immediately, but the
funds are gone. The exposure window is bounded to the seconds the call
takes. We chose this trade-off because re-implementing Taproot
script-path PSBT signing in the browser would add a significant chunk
of audited Bitcoin code, and at the moment of the call the timelock has
already matured: only the heir benefits from spending the UTXO.

The legacy two-step heir flow (`build-psbt` + `broadcast`) still exists
for heirs who own Bitcoin and want to sign with their own wallet. It is
the default for vaults created via the CLI rather than the password
wizard.

### F2 server-derived heirs

For heirs who do not own Bitcoin, the wizard offers a flow where the
server derives the heir's BIP86 account key deterministically from
`(heir_email, vault_id, master_key)` via HKDF-SHA256 → 16 bytes of BIP39
entropy → 12-word mnemonic → BIP32 → `m/86'/coin'/0'`. The browser
recomputes this on the claim side using the same scheme (mirror in
`ghostkey-web/src/crypto/heirKey.ts`).

Consequence: anyone who simultaneously holds **the server master key,
the heir's email, and the vault id** can reconstruct the heir's
mnemonic. The on-chain timelock is the only check between such an
attacker and the heir's funds. Operationally that means:

- Master-key custody is the load-bearing secret for every F2 vault.
  Use Fly Secrets (or your platform's KMS equivalent); never bake it
  into a container image or check-in script.
- A master-key leak should trigger an immediate owner-side rotation:
  the owner's funds are safe (they still control their own keys), but
  they should move the UTXOs to a fresh vault under a rotated master
  key before the timelock matures.

---

## What isn't built yet

**Rate limiting.** Cost-bearing public routes use per-IP buckets. Recovery requests are uniformly answered and rate-limited to bound email abuse; vault metadata and sealed owner blobs are released only by a short-lived one-time email challenge.

**PSBT export for hardware wallets.** The CLI signs in-process. Adding `--export-psbt` (write unsigned PSBT to disk) and `--sign-psbt` (import signed PSBT, broadcast) would support air-gapped and hardware signers. The PSBTs are already standard, so it's a CLI workflow change, not a cryptography change.

**Setup from a plain address.** The wizard requires an xpub. Supporting a single receive address (watches one address, not the full wallet) would remove a barrier for beginners.

**Signet end-to-end test.** The full claim flow is verified on regtest. It has not been smoke-tested on signet with real wallet software signing the heir PSBT. This must happen before any mainnet use. It is the single highest-priority remaining task.

**Key rotation.** Design + operator runbook landed in [`docs/master-key-rotation.md`](./docs/master-key-rotation.md) and [`DEPLOY.md` § "Rotating the master key"](./DEPLOY.md). The implementation (per-row generation tags, dual-loaded keys, background re-encryption worker, owner-facing F2 re-vault) is tracked under #27.
