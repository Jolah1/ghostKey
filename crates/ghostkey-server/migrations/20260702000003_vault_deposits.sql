-- Dedupe ledger for incoming on-chain deposits (#213).
--
-- The dashboard reads the balance live from the chain but the activity
-- feed never logged money coming IN, so a funded vault showed a balance
-- with no matching "Received" entry. We now record one "received" event
-- per new confirmed deposit; this table is what makes that idempotent.
--
-- One row per (vault, outpoint). Re-seeing an outpoint on a later scan is
-- a no-op (INSERT OR IGNORE on the primary key), so a deposit is logged
-- exactly once and reorg re-confirmations don't double-emit. Only
-- confirmed, external-keychain outputs are inserted here (change from an
-- owner send lands on the internal keychain and is deliberately skipped).
CREATE TABLE IF NOT EXISTS vault_deposits (
    vault_id   TEXT    NOT NULL,
    outpoint   TEXT    NOT NULL,
    amount_sat INTEGER NOT NULL,
    height     INTEGER NOT NULL,
    seen_at    TEXT    NOT NULL,
    PRIMARY KEY (vault_id, outpoint)
);
