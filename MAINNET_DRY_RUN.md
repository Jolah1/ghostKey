# Mainnet dry-run runbook

The last gate before telling anyone to put real money in: one vault,
**5,000 sats of your own**, on production, on mainnet, exercised
end-to-end and drained back out. The claim path is deliberately *not*
part of this run — it was proven on a real chain by the signet e2e
(`SIGNET_E2E_RUNBOOK.md`) and through the web UI by the demo-mode
lifecycle test (2026-06-12, which is what caught the #77 claim bug).
A mainnet claim would also require waiting out a real one-month
timelock, and demo mode is forbidden on mainnet by design.

What this run *does* prove, which nothing else can:

- the production server creates and watches a **mainnet** vault
  (network agreement between web wizard, server, and descriptors);
- the balance card and claim machinery talk to **your chosen Esplora
  endpoints** (mainnet has no public default — see pre-flight);
- owner **Send** estimates fees against the real mempool and
  broadcasts a real transaction;
- the **independence proof** actually recovers the wallet in Bitcoin
  Core with no GhostKey involvement — the non-custodial promise,
  observed with real sats (Sparrow and Liana **cannot** open these
  vaults; see step 4);
- Lightning check-in (20 sats) works against the production sidecar.

Plan ~1–2 hours, most of it waiting for confirmations. Total cost:
on-chain fees for two transactions (deposit + drain) plus 20 sats per
Lightning check-in. The 5,000 sats themselves come back to you.

---

## Pre-flight (operator, ~15 minutes)

Run these from your own terminal. As always: secrets are set with
`fly secrets set` directly, never pasted into a chat.

### 1. Choose and set Esplora endpoints — REQUIRED

Mainnet deliberately ships with **no default block explorer**: every
explorer you query sees every address it is asked about, which over
time leaks the vault descriptor graph. You have two options:

- **Public explorers** (`https://mempool.space/api` +
  `https://blockstream.info/api`): zero setup, fine for this dry-run
  and acceptable at launch *if* you consciously accept the privacy
  trade-off (the explorers can correlate your users' addresses).
- **Your own Esplora/electrs instance** first in the list, public ones
  as availability fallbacks: the right end-state, but not required to
  run this drill.

```sh
fly secrets set --stage \
  GHOSTKEY_ESPLORA_URL="https://mempool.space/api,https://blockstream.info/api" \
  -a ghostkey
```

Without this, mainnet claims refuse to start and the balance card has
nothing to query.

### 2. Set the public base URL

As of 2026-06-13 this is unset in production, so claim links and
email-verification links in outgoing mail point at
`ghostkeyapp.vercel.app` instead of the canonical domain:

```sh
fly secrets set --stage GHOSTKEY_PUBLIC_BASE_URL="https://www.ghostkeyapp.com" -a ghostkey
```

### 3. Flip the default network to mainnet

```sh
fly secrets set --stage GHOSTKEY_DEFAULT_NETWORK=bitcoin -a ghostkey
```

This changes which network **new** vaults are created on. Existing
testnet vaults are untouched — network is stored per vault and every
existing vault keeps working exactly as before.

This is also the real go-live switch. If the drill below fails in a
way that needs investigation, flip it back
(`fly secrets set GHOSTKEY_DEFAULT_NETWORK=testnet -a ghostkey`)
while you debug.

### 4. Deploy the staged secrets in one restart

`--stage` above means nothing has restarted yet. Release all three at
once:

```sh
fly deploy -a ghostkey   # OR: fly machine restart, OR merge any PR and let CI deploy
```

> CI auto-deploys `main` on merge. Only deploy manually if no CI
> deploy is in flight, and only from an up-to-date `main` checkout —
> concurrent deploys contend for machine leases and have hit live
> traffic before. If a merge to main is imminent anyway, just let
> CI's deploy pick the staged secrets up.

### 5. Verify the flip

```sh
curl -s https://ghostkey.fly.dev/health | python3 -m json.tool
```

Expect `"default_network": "bitcoin"` and `"demo_mode": false`. Then
check the boot log — the server prints an unmissable warning when it
boots with mainnet as the default, and must NOT print any demo-mode
warning:

```sh
fly logs -a ghostkey | head -50
```

Confirm the web banner at https://www.ghostkeyapp.com now names
mainnet, not testnet.

### 6. Confirm backups are current

```sh
fly logs -a ghostkey | grep -i "snapshot written" | tail -3
```

For a password vault, the database holds the sealed heir key and the
claim-token hash — if the DB is lost, the *owner* can still recover
funds from the recovery file or independence proof, but a future
*heir claim through GhostKey* depends on the Litestream replica
restoring. The restore fire-drill (DEPLOY.md, "Restoring from
backup") is still pending; do it before inviting real users, even if
you don't do it today.

---

## The drill

### 1. Create the vault (~10 min)

At https://www.ghostkeyapp.com, run the normal setup wizard as a real
user:

- Heir: a second email address you control.
- Waiting period: **1 month** (the minimum — you will delete the
  vault at the end, so it never fires).
- Cadence: **weekly**, so a reminder lands while the vault exists and
  you can exercise one-tap check-in.
- Trusted contact: optional but recommended (a third address you
  control) so the claim-challenge copy paths render.
- A strong password you save in your password manager.

Verify on the dashboard: the deposit address starts with `bc1` (a
`tb1` address means the network flip didn't take — stop and recheck
pre-flight step 5), and download both the recovery file and the
independence proof now.

### 2. Fund it (~30 min, mostly confirmation wait)

Send **5,000 sats** from your own wallet to the vault address — scan
the Receive card's QR and confirm the address it encodes matches the
one displayed. After ~1 confirmation the dashboard balance card must
show 5,000 sats. While you wait, check `fly logs` for any Esplora
failover warnings: with two endpoints configured, failovers are
logged and worth noticing now rather than during a real claim.

### 3. Check in over Lightning (~5 min)

Do one Lightning check-in (20 sats) from a real wallet on your phone.
Confirm the dashboard deadline advances. This is the same flow your
users will run monthly, now on the production app with the mainnet
default.

### 4. Prove independence (~15 min)

The vault is a Taproot timelock miniscript. **Sparrow, Electrum, and
mobile wallets cannot open it** (no miniscript support), and **Liana
cannot either** — Liana only accepts its own descriptor shape and
refuses ours ("invalid or incompatible with network"), verified
2026-06-14. The one tool that reads these vaults is **Bitcoin Core
26+**. This was confirmed on mainnet on 2026-06-14.

Open the independence-proof HTML **offline** (turn off wifi, open the
file) and unlock it with the vault password to reveal the two
watch-only descriptors (receive + change). Then, with Bitcoin Core:

**Lightweight proof (no blockchain sync needed).** `deriveaddresses`
is pure computation, so it works the instant `bitcoind` starts:

```bash
bitcoind -daemon
bitcoin-cli deriveaddresses "<RECEIVE_DESCRIPTOR_WITH_CHECKSUM>" "[0,5]"
```

The first address must match the deposit address GhostKey gave you to
fund the vault. Look it up on a block explorer and you'll see the
5,000 sats — GhostKey nowhere in the loop. If Bitcoin Core derives
your funded address from the kit alone, recovery is proven.

**Full balance proof (needs a synced, non-pruned node).** Import both
descriptors into a blank watch-only wallet and read the balance off
the chain. Write the request to a file to avoid shell-quoting issues
(the `tr()` apostrophes break inline JSON):

```bash
bitcoin-cli createwallet "ghostkey_check" true true "" false true
# Put both descriptors (with their #checksums) in a JSON file, then:
bitcoin-cli -rpcwallet=ghostkey_check importdescriptors "$(cat import.json)"
bitcoin-cli -rpcwallet=ghostkey_check getbalances
```

This is the "if GhostKey is down, funds are still accessible"
guarantee — observe it with real money once before asking users to
trust it. (Note: Bitcoin Core is a technical tool; the recovery kit
tells a non-technical heir to get a Bitcoin-savvy helper, and the
file is self-contained so no password is needed just to *see* the
funds. The friendlier-GUI recovery path is tracked in issue #84.)

### 5. Drain it back (~30 min, mostly confirmation wait)

Use the dashboard Send card with **send-all** to drain the vault back
to your own wallet. This exercises Argon2id unseal in the browser,
real fee estimation, and a real broadcast. Record the fee paid and
follow the explorer link to watch it confirm. Balance card should
drop to zero.

### 6. Clean up

Either keep the vault as your own genuine first mainnet vault (fund
it properly and keep checking in weekly — it's real now), or delete
it from the dashboard. If you keep it, consider re-creating it with a
cadence you'll actually sustain.

---

## Record the results

Note in the issue/journal: date, fees paid on each transaction,
time-to-confirm, which Esplora endpoint served the requests, and
anything that surprised you. If every step above passed, mainnet
stays the default and GhostKey is live for real deposits.

## Known-good as of this writing (2026-06-13)

- Full lifecycle (miss → alarm → claim link → claim-challenge →
  claim flow) verified via demo mode locally, 2026-06-12.
- Claim with real on-chain funds + BIP68 timelock verified on signet
  (`SIGNET_E2E_RUNBOOK.md`).
- Email (Resend), web push, Lightning check-ins, Litestream backups
  all verified working in production.
- Web claim-probe bug (#77) fixed and deployed — heirs of password
  vaults reach the guided claim flow.
