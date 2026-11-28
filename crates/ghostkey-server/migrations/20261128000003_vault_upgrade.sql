-- #389: moving a legacy-format vault to the standard format.
-- The old descriptors stay on record after the switch.
ALTER TABLE vaults ADD COLUMN legacy_descriptor_external TEXT;
ALTER TABLE vaults ADD COLUMN legacy_descriptor_internal TEXT;
ALTER TABLE vaults ADD COLUMN upgraded_at TEXT;

-- Every signed upgrade transaction, kept until it is on the network, so
-- one that failed to broadcast is retried without the owner coming back.
CREATE TABLE vault_upgrade_txs (
    vault_id     TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
    txid         TEXT NOT NULL,
    tx_hex       TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    broadcast_at TEXT,
    attempts     INTEGER NOT NULL DEFAULT 0,
    last_error   TEXT,
    PRIMARY KEY (vault_id, txid)
);
CREATE INDEX idx_vault_upgrade_txs_pending ON vault_upgrade_txs(broadcast_at) WHERE broadcast_at IS NULL;
