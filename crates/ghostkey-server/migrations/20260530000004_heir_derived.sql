-- Heir key derivation: when heir_derived=1 the server derived the heir's xpub
-- deterministically from the heir_email + master_key + vault_id. The heir's
-- browser re-derives the xprv from vault_secret returned after email auth.
ALTER TABLE vaults ADD COLUMN heir_derived INTEGER NOT NULL DEFAULT 0;
