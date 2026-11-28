-- #94: the on-chain lock end (chain_unlock_height) the owner was last
-- reminded to refresh, so each lock end is emailed about once.
ALTER TABLE vaults ADD COLUMN refresh_reminded_height INTEGER;
