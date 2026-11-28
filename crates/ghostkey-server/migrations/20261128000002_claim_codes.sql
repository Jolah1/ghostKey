-- #393: a code the heir types at the site instead of clicking the link.
-- `*_code_lookup` is a keyed hash of the code (crypto::claim_code_lookup);
-- `*_code_sealed` is the code and its token, sealed under the per-vault key.
ALTER TABLE vaults ADD COLUMN claim_code_lookup TEXT;
ALTER TABLE vaults ADD COLUMN claim_code_sealed TEXT;
ALTER TABLE vaults ADD COLUMN drill_code_lookup TEXT;
ALTER TABLE vaults ADD COLUMN drill_code_sealed TEXT;
CREATE UNIQUE INDEX idx_vaults_claim_code_lookup ON vaults(claim_code_lookup) WHERE claim_code_lookup IS NOT NULL;
CREATE UNIQUE INDEX idx_vaults_drill_code_lookup ON vaults(drill_code_lookup) WHERE drill_code_lookup IS NOT NULL;
