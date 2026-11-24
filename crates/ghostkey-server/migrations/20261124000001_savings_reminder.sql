-- Optional savings reminder per vault (#367): the honest version of
-- PiggyVest's autosave. Bitcoin can't be pulled from anyone, so instead
-- of deducting we email the owner on the schedule they chose, with a link
-- to their dashboard (where the browser checks the deposit address).
-- Skipping one changes nothing; it never touches the check-in clock.
ALTER TABLE vaults ADD COLUMN savings_reminder_cadence TEXT;    -- 'weekly' | 'monthly'
ALTER TABLE vaults ADD COLUMN savings_reminder_sat     INTEGER; -- optional planned amount
ALTER TABLE vaults ADD COLUMN savings_reminder_next_at TEXT;    -- RFC 3339
