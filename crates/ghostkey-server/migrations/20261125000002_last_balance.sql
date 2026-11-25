-- The vault's balance from its last successful chain scan, so Home can
-- show a number at once while a fresh lookup runs, and keep showing it
-- (marked with its age) when every block explorer is slow.
--
-- Written by the background chain refresher and by every live balance
-- lookup. NULL until the first successful scan. Nothing here is new to
-- the server: it can already work the balance out from the descriptors.
ALTER TABLE vaults ADD COLUMN balance_confirmed_sat INTEGER;
ALTER TABLE vaults ADD COLUMN balance_unconfirmed_sat INTEGER;
ALTER TABLE vaults ADD COLUMN balance_checked_at TEXT;
