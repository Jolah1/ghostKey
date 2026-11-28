-- Locked goals: a vault whose owner can spend from `locked_until` and
-- whose heir can claim from `heir_unlock_at` (Unix seconds), enforced by
-- its own script. NULL on every other vault.
ALTER TABLE vaults ADD COLUMN locked_until INTEGER;
ALTER TABLE vaults ADD COLUMN heir_unlock_at INTEGER;
-- When the "your savings unlocked" email went out.
ALTER TABLE vaults ADD COLUMN unlocked_notified_at TEXT;
-- When the "lock it again or take it out before the heir's date" email
-- went out.
ALTER TABLE vaults ADD COLUMN heir_date_reminder_at TEXT;
