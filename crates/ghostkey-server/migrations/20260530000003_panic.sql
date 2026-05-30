-- Panic payment: owner pays a second LNURL to freeze the vault for 90 days
-- and alert a trusted contact.
ALTER TABLE vaults ADD COLUMN trusted_contact_ciphertext TEXT;
ALTER TABLE vaults ADD COLUMN trusted_contact_nonce       TEXT;
ALTER TABLE vaults ADD COLUMN trusted_contact_channel     TEXT DEFAULT 'email';
ALTER TABLE vaults ADD COLUMN panic_frozen_until          TEXT;
