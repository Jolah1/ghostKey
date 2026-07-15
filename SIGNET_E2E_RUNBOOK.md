# Live signet end-to-end test runbook

The single highest-priority open item from `JOURNAL.md` Entry 9: "watch
real Bitcoin move through a real claim on a public network." Until
this has been done by a human at least once, GhostKey is not ready
for mainnet — there's a class of bug (fee estimation under real
mempool pressure, indexer quirks, BIP68 timer interacting with real
block intervals, web/server network agreement) that only surfaces in
production-shaped runs.

Signet is the right network for this: blocks come every ~10 minutes
deterministically, faucets are stable, no value at risk, and
public Esplora indexers (mempool.space) work without any setup.

This runbook walks you through it. Plan for ~2 hours total, most of
which is waiting for signet blocks to confirm.

---

## Before you start

### Prerequisites

- **The recommended (password-vault) flow needs no wallet at all.**
  GhostKey generates and seals both the owner and heir keys in the
  browser, so neither side installs anything. For that flow, skip the
  xpub steps and use the web `/setup` page (see the note in Phase 1).
- **The legacy xpub script flow below needs two signet xpubs** — one
  for the owner, one for the heir (the server refuses a vault where
  they match). Any BIP86 wallet can export one; Sparrow's File → New
  Wallet → Network: Signet is one easy way. This only *exports* an
  xpub: no consumer wallet — Sparrow or Liana included — can open the
  finished vault, whose Taproot timelock miniscript loads only in
  Bitcoin Core (see the "Heir claim" step and MAINNET_DRY_RUN.md).
- **Two email addresses** — one for the owner (reminders + alarm
  notice), one for the heir (claim link).
- **`curl` and `python3`** on your laptop. Optional: `jq` for
  prettier JSON output.

### A separate Fly app

We do NOT run this against production `ghostkey.fly.dev`. The whole
point is to test on signet without touching the testnet vaults real
users have created. Spin up a sibling app:

```bash
fly apps create ghostkey-signet
fly volumes create ghostkey_signet_data --region ams --size 1 -a ghostkey-signet

# Required: master key for encrypting heir/owner contacts at rest.
fly secrets set \
  GHOSTKEY_MASTER_KEY="$(openssl rand -base64 32)" \
  -a ghostkey-signet

# Required: CORS allowlist for the web frontend you'll point at this.
# If you're testing from the production Vercel build, list it here.
fly secrets set \
  GHOSTKEY_ALLOWED_ORIGINS="https://www.ghostkeyapp.com" \
  -a ghostkey-signet

# THE key env var. Tells the web UI to default new vaults to signet
# instead of testnet, and the alpha banner to name "signet".
fly secrets set GHOSTKEY_DEFAULT_NETWORK=signet -a ghostkey-signet

# Recommended for a short, observable test: demo mode shortens the
# off-chain cadence floors (5s instead of 1h) so you can see the
# alarm fire in real time. The on-chain CSV (timelock_blocks) is
# still real signet block time -- nothing speeds that up.
fly secrets set GHOSTKEY_DEMO_MODE=1 -a ghostkey-signet

# Optional but recommended: SMTP for owner reminder + alarm emails.
#
# CAREFUL with multi-line paste: if the backslash continuations get
# mangled (some terminals eat them), fly will happily store fragments
# of the command text AS the secret values and the notifier will
# "configure" itself with garbage. This happened with the Twilio
# block on 2026-07-08. Safest is one NAME=VALUE per `fly secrets set`
# call, then check `fly logs` after boot: the notifier prints what it
# parsed.
fly secrets set \
  SMTP_HOST="smtp.postmarkapp.com" \
  SMTP_PORT="587" \
  SMTP_FROM="alerts@yourdomain.tld" \
  SMTP_USER="your-postmark-token" \
  SMTP_PASS="your-postmark-token" \
  -a ghostkey-signet

# Deploy. NOTE: CI (deploy-fly.yml) only auto-deploys the mainnet
# `ghostkey` app on merges to main — this signet app is manual-only,
# so re-run this from a clean main checkout after any server merge
# you want live here (found 18 days stale on 2026-07-08).
fly deploy -a ghostkey-signet

# Confirm:
curl https://ghostkey-signet.fly.dev/health
# Expect: { "ok": true, "demo_mode": true, "default_network": "signet", ... }
```

If `default_network` says `signet` and `demo_mode` is `true`, the
server is ready. If either is wrong, fix the secrets and redeploy
before going further — a wrong network value here is the single
most likely way to burn faucet time later.

### Web frontend

Point a browser at the production build
(`www.ghostkeyapp.com`) but with the API origin overridden to
your signet app. The simplest way is via `vercel.json`'s rewrite
rule in a feature branch, OR by running the web dashboard locally:

```bash
cd ghostkey-web
DEV_PROXY_TARGET=https://ghostkey-signet.fly.dev npm run dev
# -> http://localhost:5173
```

(`DEV_PROXY_TARGET` is the variable `vite.config.ts` reads for the
dev-server proxy; it defaults to the local server at 127.0.0.1:8787.
If you see "Reminder service is unreachable" plus ECONNREFUSED
proxy errors in the vite log, the variable didn't take — it must be
on the same line as `npm run dev`. `VITE_API_BASE` is different: it
bakes an absolute API origin into a production build.)

Open that. The top banner should now say:

> Alpha: GhostKey is running on Bitcoin **signet**. Don't use real-money keys yet.

And a second amber banner:

> Demo mode: check-in cadences on this server are measured in seconds...

Both confirm the server is wired up the way you expected.

---

## Phase 1 — Create the vault

You can do this two ways. The runbook uses the script because it's
faster, exits cleanly on misconfiguration, and persists the vault id
+ owner token to a file the other phases need. If you'd rather click
through the wizard manually, the same flow works in the browser.

### Get your xpubs

Only needed for the script flow below — the password-vault flow needs
no xpubs. In your signet wallet (Sparrow shown here), open both
wallets. For each:

- Settings → Keystores → expand → "xpub". Copy the `tpub...` string
  AND the master fingerprint (eight hex characters near the top).
- Or, click the "..." menu → "Show as origin-tagged" if you want
  the wallet to bundle them as `[fingerprint/86'/1'/0']tpub...` — in
  which case the fingerprint comes along for the ride and you don't
  need to copy it separately.

### Drive the script

```bash
export GHOSTKEY_SIGNET_URL=https://ghostkey-signet.fly.dev
export OWNER_XPUB="[<owner-fp>/86'/1'/0']tpub..."
export HEIR_XPUB="[<heir-fp>/86'/1'/0']tpub..."
export HEIR_EMAIL="heir@example.com"
export OWNER_EMAIL="you@example.com"      # for reminders + alarm
export TIMELOCK_BLOCKS=6                   # ~1 hour on signet
export CHECKIN_SECS=30                     # demo mode minimum 5
export GRACE_SECS=15

./scripts/signet_e2e.sh setup
```

The script:

1. Probes `/health` and refuses to continue if `default_network !=
   signet` (the single biggest faucet-burner).
2. Posts to `/vaults/from-xpub`.
3. Fetches the funding address from `/vaults/:id/address`.
4. Persists the vault id, the owner token, and the address to
   `.signet-e2e.json` (mode 0600, gitignored).
5. Prints the next steps.

The script's output ends with the funding address — a `tb1p...`
P2TR address. Signet shares the testnet HRP so it looks identical
to a testnet address; the network is determined by which Esplora
the server queries, not by the address shape.

---

## Phase 2 — Fund the vault from a signet faucet

Pick one of:

- https://signet.bc-2.jp/ — straightforward, ~10000 sats per request
- https://signetfaucet.com/ — alternate, sometimes faster
- https://alt.signetfaucet.com/ — backup

Paste the funding address. Request the smallest amount the faucet
offers; 5000–10000 sats is plenty for the test (the heir's claim
sweeps the whole thing minus fees).

Watch the funding transaction confirm on mempool.space:

```
https://mempool.space/signet/address/<the address>
```

Wait for **1 confirmation**. Signet blocks come every 10 minutes on
average, but in practice the inter-block gap is highly variable —
sometimes seconds, sometimes 30+ minutes. Don't worry about it; this
is just signet acting like a real network.

---

## Phase 3 — Watch the alarm fire

The vault is now in `status='ok'` with the 30-second check-in cadence
demo mode lets us use. If you do nothing, the scheduler will:

1. Move the vault to `alarmed` at `now + checkin + grace` = ~45s.
2. Issue the one-tap check-in token to the owner email (Entry 13).
3. Wait one more grace period (15s) and move to `timelock_started`.
4. Issue the heir's claim token AND send the heir-claim email.

Run:

```bash
./scripts/signet_e2e.sh observe
```

This polls `/vaults/:id` every 10 seconds and prints status
transitions. Within about a minute, you should see:

```
HH:MM:SS status -> ok
HH:MM:SS status -> alarmed
HH:MM:SS status -> timelock_started
```

When `timelock_started` appears, the script exits with the next
steps. Your heir's email should have the claim link.

**At any time** you can run:

```bash
./scripts/signet_e2e.sh diagnose
```

…to dump the current vault state, event log, and a clickable
mempool.space link for the funding address. Useful when something
looks off and you want to compare what the server thinks vs what
the chain shows.

---

## Phase 4 — Heir claims (browser)

Open the claim link from the heir's email in a fresh browser tab.
The URL looks like:

```
https://ghostkey-signet.fly.dev/#/claim/<token>
```

(or `localhost:5173/#/claim/<token>` if you're running the web
frontend locally.)

The page should show one of two flows depending on how the vault was
created:

- **Password-vault flow** (default for new vaults): the heir pastes
  a signet receive address (any `tb1...` from their wallet). The
  browser unwraps the heir xprv locally, posts everything to the
  server, and the server builds + signs + broadcasts in one POST.
  Three clicks total.

- **Manual PSBT flow** (when the vault was created without sealed
  heir material): the page hands the heir an unsigned PSBT to sign in
  a **miniscript-aware** wallet. The vault is a Taproot timelock
  miniscript, so this means **Bitcoin Core** (Sparrow and Liana can't
  open these descriptors — see MAINNET_DRY_RUN.md step 4). The heir
  signs, pastes the signed PSBT back, and the server broadcasts.

For a signet runbook you probably want the password-vault flow
(simpler, no second wallet needed on the heir side). The script
above doesn't use the password-vault setup because that flow
requires the browser; if you want to exercise it, use the web UI's
`/setup` page directly instead of the script's `setup` phase.

### Wait out the CSV timelock

The heir claim transaction is invalid until `timelock_blocks` blocks
after the funding tx confirmed. With `TIMELOCK_BLOCKS=6` and signet's
~10-min block interval, that's about an hour. If you try to broadcast
earlier the network rejects it with a `non-BIP68-final` error —
that's not a GhostKey bug, that's Bitcoin telling you to wait.

While you wait, the heir's page will fail at the broadcast step. The
error surfaces verbatim in the UI. Wait, refresh, try again.

### The successful broadcast

Once the timelock matures and the heir clicks claim, the page shows
a transaction ID and a link to mempool.space:

```
https://mempool.space/signet/tx/<txid>
```

Open that. You should see:
- A taproot witness with the heir's signature
- A single input (the vault UTXO you funded)
- A single output (the heir's destination address)
- A fee of roughly `2 sat/vB × tx-size-in-vB`

Wait for one confirmation. The heir's signet wallet should now show
the swept amount minus the broadcast fee.

**That's the whole test.** Real signet sats moved from the vault
script's heir keypath, signed end-to-end, broadcast end-to-end.

---

## What to check afterwards

Before declaring victory and updating `JOURNAL.md` Entry 15:

1. **Did the pre-deadline reminder fire?** Check the owner email. It
   should land before the alarm-fired email (24h before deadline in
   production; in demo mode the reminder/alarm distinction collapses
   because the lead time exceeds the cadence — both may fire near
   each other on the first cycle).
2. **Does the one-tap link in the reminder/alarm email work?** Tap
   it. The server should reset the cadence and show "you're checked
   in." Then run `./scripts/signet_e2e.sh diagnose` to confirm.
3. **Does the explorer link in the broadcast response point at
   signet?** It should be `mempool.space/signet/tx/...`, not
   `mempool.space/tx/...`. The latter would mean the server's
   `explorer_url` function picked the wrong network branch.
4. **Anything in the server logs?** `fly logs -a ghostkey-signet`
   while the test is running. Look for `warn` or `error` entries —
   the audit flagged the `heir_claim` retry path
   (`psbt_routes.rs:690-706`) as untested against live CSV; if the
   first broadcast attempt returns `finalized=false`, that's worth
   noting in the journal entry.

---

## When something goes wrong

### Vault is `alarmed` but the heir never gets the email

Most likely SMTP is misconfigured. Check `fly logs -a ghostkey-signet`
for `notifier::tick errored` or `smtp send failed`. The notifier
worker logs SMTP config status at startup:

```
notification worker: SMTP configured host=smtp.postmarkapp.com port=587
```

…or:

```
SMTP_HOST unset; notification worker will accept enqueues but every
email-channel send will be Skipped (row stays pending).
```

If the row stayed pending, the heir will get the email the moment
you `fly secrets set SMTP_HOST=...` and redeploy — the queue picks
up on the next tick.

### Heir claim broadcast says "no UTXOs"

Either the funding tx hasn't confirmed yet (check
`mempool.space/signet/address/<addr>`) or the Esplora indexer the
server is using disagrees with mempool.space about its existence.
The default for signet is `https://mempool.space/signet/api`. If
mempool.space has indexing lag, you can override:

```bash
fly secrets set GHOSTKEY_ESPLORA_URL="https://blockstream.info/signet/api" \
    -a ghostkey-signet
fly deploy -a ghostkey-signet
```

### Heir claim says "non-BIP68-final"

The CSV timelock hasn't matured yet. Count blocks between the
funding tx's confirmation height and the current tip:

```
https://mempool.space/signet/blocks/
```

Difference must be ≥ `TIMELOCK_BLOCKS`. Wait, refresh, try again.

### The wrong network silently

If you discover mid-test that the vault was created on testnet
instead of signet (this happens when `default_network` is wrong),
the funding faucet sent real signet sats to a script that the testnet
Esplora can't see. The sats aren't lost — they're still on signet,
in the vault — but you can't drive the heir claim through this
server. Either:

- Throw away the server, redeploy with the correct
  `GHOSTKEY_DEFAULT_NETWORK=signet`, and re-create the vault from
  the same xpubs. The address will be identical (BIP86 derivation
  is deterministic) so the funded UTXOs become visible to the new
  vault automatically.
- Sweep the funds out with `bitcoin-cli` against a signet bitcoind
  and start over.

The script's `phase_check_server` step exists precisely to catch
this BEFORE the faucet step. If you ever see "server reports
default_network=..., expected signet", stop and fix the deployment.

---

## After the test

Write an entry in `JOURNAL.md` (Entry 15, "First live signet claim"):
what worked, what was surprising, how long each phase took, any
warnings or errors in the server logs that need follow-up. The
journal pattern is "what we built / why now / what was hard / what
we left for later."

Then delete `.signet-e2e.json` (it has an owner token; don't keep
it around longer than needed) and `fly apps destroy ghostkey-signet`
if you don't plan to keep the signet server around.

If the test surfaced bugs, file issues with `tracing` log snippets.
The most likely bug class is "the server claimed it finalized but
mempool.space rejected the broadcast" — that needs the raw error
from the broadcast response captured. Save it.

Once Entry 15 lands with a green run, "Live signet end-to-end test"
can be retired from the JOURNAL "what we left for later" lists, and
mainnet review becomes the next gating item.
