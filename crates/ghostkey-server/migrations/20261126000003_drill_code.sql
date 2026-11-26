-- The practice run tests the heir code: 1 = the heir's code worked,
-- 0 = they said they don't have it, NULL = not tested (no code on this
-- vault, an older app, or no practice since).
ALTER TABLE vaults ADD COLUMN drill_code_ok INTEGER;
