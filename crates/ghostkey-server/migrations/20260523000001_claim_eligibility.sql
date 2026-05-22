-- Scheduler claim-issuance gate.
--
-- claim_eligible_at is the wall-clock instant at which the scheduler
-- becomes allowed to issue a claim token + transition the vault to
-- `timelock_started`. It is set at vault creation time to
-- `next_deadline_at + grace_period_secs * 2` (one extra grace window
-- past the initial deadline+grace), giving the owner a real chance
-- to recover after the alarm fires without prematurely notifying the
-- heir.
--
-- Existing rows are backfilled to `next_deadline_at + 7 days` as a
-- conservative default. They were created before this gate existed
-- and have no special urgency.
--
-- The column is non-nullable for new rows but nullable here so the
-- ALTER works on SQLite (which cannot add a NOT NULL column without
-- a default expression). New inserts always populate it.

ALTER TABLE vaults ADD COLUMN claim_eligible_at TEXT;

UPDATE vaults
   SET claim_eligible_at = datetime(next_deadline_at, '+7 days')
 WHERE claim_eligible_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_vaults_claim_eligible
    ON vaults (claim_eligible_at);
