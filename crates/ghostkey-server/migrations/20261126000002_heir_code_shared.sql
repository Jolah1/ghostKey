-- When the owner confirmed they gave the heir their code. Until then the
-- dashboard keeps asking: an heir without the code can't claim.
ALTER TABLE vaults ADD COLUMN heir_code_shared_at TEXT;
