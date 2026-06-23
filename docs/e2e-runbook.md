# End-to-end runbook: test GhostKey as a user

This walks the whole product the way a real owner and heir would,
including the parts added since the original signet runbook: the
password-vault setup, the owner recovery kit, the heir envelope, the
claim-time heir recovery file, and SMS/WhatsApp claim links.

Three ways to run it, easiest first:

| Path | Proves | Cost | Where |
|---|---|---|---|
| Local demo | the full off-chain flow + both kits, no Bitcoin | free, ~2 min | `scripts/demo.sh` |
| Signet | the same flow plus real coins actually moving | free, ~1–2 h | `SIGNET_E2E_RUNBOOK.md` |
| Mainnet smoke | owner can move real funds | a few sats | manual, owner side only |

Don't make mainnet the first test. The heir branch only opens after a
real on-chain timelock matures (real blocks, ~10 min each on signet,
longer on mainnet), so a full heir test on mainnet costs both coins and
days. Prove everything on the local demo, then signet, then do a tiny
owner-only smoke on mainnet.

---

## Path 1 — Local demo (start here)

One command brings up the server (demo mode) and the dashboard:

```bash
./scripts/demo.sh
```

This runs on signet by default with seconds-scale cadences and forces
the on-chain timelock to 1 block, so the whole state machine finishes in
under a minute. No SMTP, no Twilio, no faucet needed for the off-chain
flow.

Then, in the dashboard at `http://127.0.0.1:5173`:

1. **Owner setup.** Create a vault. Pick a short waiting period
   (seconds). Heir contact can be any email — delivery is faked locally
   (see step 3).
2. **Download both artifacts.** On the funding screen, download the
   **owner kit** and the **heir envelope**, and write down the envelope
   passphrase (shown once). These are two separate files with two
   separate audiences: the owner kit unlocks the owner branch (spend
   anytime — never hand it to anyone); the heir envelope unlocks only
   the timelocked heir branch.
3. **Watch the alarm fire.** Do nothing for ~45s. The vault moves
   `ok → alarmed → timelock_started`. Because there's no real delivery
   channel locally, the server **prints the claim link to its log** (the
   `scripts/demo.sh` output) as:

   ```
   DEMO MODE claim link ...: http://127.0.0.1:5173/#/claim/<token>
   ```

   This line only appears in demo mode, which is forbidden on mainnet.
4. **Play the heir.** Open that link in a fresh tab. Walk the claim.
   Then open **"Advanced: save your own recovery file"** to get the
   block-B heir recovery file (re-seals the heir key under a password
   you choose — durable, GhostKey-independent from claim onward).

What this path does NOT exercise: actually moving coins. The owner kit's
"find coins / sign / broadcast" and the heir sweep need a funded UTXO and
a real chain. For that, use path 2.

---

## Path 2 — Signet (real coins move)

Use this to prove money actually moves on a real network, for free. The
deep mechanics (deploying the `ghostkey-signet` app, faucets, waiting out
the on-chain timelock, the xpub/PSBT path, troubleshooting) are in
**`SIGNET_E2E_RUNBOOK.md`** — follow that for the on-chain parts. The
notes below cover only what's new on top of it.

Two gotchas baked into the steps:

- **Signet email is test-mode** — only the operator's own verified test
  address actually receives mail. Use that address for both owner and heir so you see the
  claim link land.
- **SMS/WhatsApp won't send** until `TWILIO_*` secrets are set. Until
  then those rows sit `pending` (no failure, just no send). Use email for
  the first pass.

The new flows to verify on signet, in order:

1. **Owner setup + fund + check-in.** Create the vault in **demo mode**
   so the timelock is 1 block (matures in ~10 min, not hours). Download
   the owner kit and heir envelope on the funding screen. Fund the
   address from a faucet, wait 1 conf, then do a check-in from the
   dashboard and confirm the deadline moves out — this proves GhostKey is
   the check-in interface.
2. **Owner kit recovery (GhostKey-independent owner path).** Open the
   downloaded owner kit HTML in a browser. Unlock with the owner
   password → paste the signet Esplora URL → Find coins → Sign →
   Broadcast. This is the path the in-browser e2e automates, here against
   the live signet explorer with real coins.
3. **Heir claim (window 1 — GhostKey alive).** Let the grace window
   lapse; the scheduler emails the claim link. Open it, walk the claim,
   then open **"Advanced: save your own recovery file"** (block B) and
   download it.
4. **Heir envelope (window 2 — GhostKey gone before claim).** Open the
   heir envelope from step 1 in a fresh browser. Unlock with its
   passphrase → Find coins → Sign → Broadcast. Works only once the vault
   has aged past the timelock with no owner movement (demo mode's 1-block
   timelock makes that immediate). This is the proof the heir reaches
   funds with GhostKey fully gone.
5. **SMS/WhatsApp (after Twilio).** Once `TWILIO_*` is set
   (`fly secrets set ... -a ghostkey-signet`), repeat 1–3 with a
   phone/WhatsApp heir contact. Confirm the claim link arrives on that
   channel and the notification row flips from `pending` to sent.

---

## Path 3 — Mainnet smoke (owner only, last)

After signet passes:

- Create a real vault, fund it with a **tiny** amount.
- Do one check-in.
- Recover via the **owner kit** (unlock → find → sign → broadcast) to
  move the coins back to yourself.

Don't run the heir path on mainnet unless you're willing to wait out a
real timelock and spend real coins. The owner smoke proves the mainnet
money path; the heir path is already covered by signet + the in-browser
e2e (`cd ghostkey-web && npm run e2e`).

---

## What the automated tests already cover

You don't need to re-prove these by hand:

- `cargo test --workspace` — server state machine, claim broker, notifier
  routing (incl. the SMS/WhatsApp claim-link enqueue).
- `cd ghostkey-web && npm run e2e` — the recovery kit driven in real
  headless Chrome: unlock → find coins → sign in wasm → broadcast, with a
  mocked Esplora. Same DOM + wasm wiring the owner kit and heir envelope
  use.
