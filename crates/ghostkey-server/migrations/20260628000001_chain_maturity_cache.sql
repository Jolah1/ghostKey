-- On-chain unlock-maturity cache (Fix A: gate heir contact on the
-- on-chain CSV timelock, not just the server's check-in clock).
--
-- The heir spends via the `older(N)` branch, so every vault UTXO must
-- be at least `timelock_blocks` deep before the network will accept the
-- claim. The scheduler computes that from a chain scan and caches the
-- result here so it (and, in a later phase, the heir's claim page) don't
-- rescan Esplora on every 30s tick during the weeks-long timelock wait.
--
--   chain_unlock_height : max(utxo confirmation height) + timelock_blocks,
--                         the block height at/after which the heir can
--                         spend. NULL when there are no confirmed UTXOs.
--   chain_tip_height    : the chain tip height observed during the scan.
--   chain_scanned_at    : when this estimate was computed (RFC3339), used
--                         as a freshness TTL so we don't rescan every tick.
ALTER TABLE vaults ADD COLUMN chain_unlock_height INTEGER;
ALTER TABLE vaults ADD COLUMN chain_tip_height INTEGER;
ALTER TABLE vaults ADD COLUMN chain_scanned_at TEXT;
