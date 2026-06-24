# Beta-readiness checklists

Operator checklists for the remaining beta gates. These are the
hands-on steps that code can't do for you. See #188 for the full gate
list.

- [#187 — operational hardening](#187--operational-hardening)
- [#185 — heir recovery validation](#185--heir-recovery-validation)

---

## #187 — operational hardening

The architecture today (verified): one `shared-1x` / 512 MB Fly machine
in `ams`, a single SQLite file on a local NVMe volume, WAL mode, pool of
8 connections (sqlx default 5s `busy_timeout`), the scheduler / notifier
/ Lightning poller / Litestream sidecar all in-process. Not replicated.
`min_machines_running = 1`, `auto_stop_machines = off` (must stay off,
or alarms never fire).

### A. Backup restore drill (do this first)
A backup you've never restored is not a backup.
- [ ] Confirm Litestream is actually replicating: `fly logs -a ghostkey`
      shows replication, and the object store shows recent generations.
- [ ] On a scratch machine (or locally), restore the DB from the
      replica only: `litestream restore -config /etc/litestream.yml
      /tmp/restore.sqlite`. Do not use the live file.
- [ ] Open the restored file and sanity-check row counts:
      `sqlite3 /tmp/restore.sqlite "SELECT count(*) FROM vaults;"` and
      spot-check a vault's `status` / `next_deadline_at`.
- [ ] Time it: how long from "volume lost" to "server back up on a
      restored DB"? Write the number in `DEPLOY.md` as the RTO.
- [ ] Document the exact restore command sequence in `DEPLOY.md` so a
      half-asleep operator can follow it.

### B. Load test (turns "falls over somewhere" into a number)
Goal: find the real ceiling of the current box before users do.
- [ ] Pick a tool (`oha`, `k6`, or `wrk`). Test against signet/staging,
      never mainnet prod.
- [ ] Read path: ramp concurrent `GET /health` and a typical dashboard
      read. Record req/s and p99 latency where it stays healthy.
- [ ] Write path (the real limit): ramp concurrent check-ins. Watch for
      `database is locked` / 5xx and rising latency — this is the single
      SQLite writer saturating. Record the concurrency where check-ins
      start failing. **A failed check-in is a safety event.**
- [ ] Memory: drive a few concurrent heir claims (each does a BDK full
      scan) and watch `fly status` / memory. Confirm 512 MB holds; note
      where it gets tight.
- [ ] Write the measured ceiling in `DEPLOY.md`. Decide the trigger
      point for "bump the VM" and for "start the Postgres migration."

### C. Uptime + health monitoring
- [ ] Point an external monitor (UptimeRobot, Better Stack, or a Fly
      check) at `GET /health` with alerting to a channel you actually
      watch.
- [ ] `/health` now surfaces notifier-queue health (#189) — alert on a
      stuck/growing queue, not just HTTP 200, since a wedged notifier
      means heirs aren't being told.
- [ ] Add a dead-man's-switch alert: if the scheduler heartbeat stops
      advancing (see the `scheduler_heartbeat` migration), page yourself.
      A silently stopped scheduler is the worst-case failure.

### D. Second maintainer / bus factor
- [ ] Grant a trusted second person Fly access and GitHub admin.
- [ ] Make sure the master key, Litestream creds, and domain/DNS are
      recoverable by someone other than you (sealed runbook).
- [ ] Write a one-page "if I'm unavailable" runbook: how to restore,
      where secrets live, how to reach users.

### Done when
Restore drill passed and timed, load ceiling measured and written down,
external `/health` + scheduler-heartbeat alerting live, and a second
person can operate the service.

---

## #185 — heir recovery validation

The no-Core recovery tool (`src/kit/`) is built and compiles. What's
unproven: that a real non-technical heir can actually get the money out,
and that it still works against a live funded vault.

### A. Live re-verify on a funded vault
- [ ] Fund a small real (or signet) vault and let it reach the
      claimable state through the normal flow (owner stops checking in →
      grace → timelock).
- [ ] Run the recovery tool end to end: unlock → find funds → sign →
      broadcast. Confirm the sweep tx confirms on-chain.
- [ ] Confirm the recovery kit's instructions match what the tool
      actually does, step for step (no stale screenshots / commands).

### B. Real non-technical-user test (the real gate)
- [ ] Recruit someone who is NOT technical and did NOT build this.
- [ ] Hand them only the recovery kit + claim materials, the way a real
      heir would receive them. No hints from you.
- [ ] Watch silently. Note every place they hesitate, misread, or get
      stuck. Those are the bugs.
- [ ] They succeed when funds land in a wallet they control, without
      you touching the keyboard.
- [ ] Fold the friction points back into the kit copy and the tool.
      (Honor the farmer-friendly rules: no txid lookups, no hash
      comparisons, no pre-shared technical facts.)

### Done when
A non-technical tester recovered funds unaided on a live funded vault,
and the kit copy reflects what tripped them up.
