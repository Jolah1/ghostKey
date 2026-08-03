-- Distinguish an empty vault from one whose only output is unconfirmed.
-- `chain_unlock_height IS NULL` cannot make that distinction: both states
-- have no confirmed coin anchoring the CSV timelock. The scheduler uses
-- this flag to retire drained vaults without suppressing pending change,
-- and to avoid re-activating an empty `unfunded` vault.
ALTER TABLE vaults ADD COLUMN chain_has_unspent INTEGER;
