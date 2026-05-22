-- Add xpub-based setup support and scaffolding for the heir-link claim
-- flow (step 3 of the xpub-vault-flow plan).
--
-- New columns are all nullable so the existing `descriptor_external` /
-- `descriptor_internal` -only path keeps working unchanged. The
-- `from-xpub` route handler fills both the rendered descriptors AND the
-- new key-fragment + contact columns. The CLI path keeps writing only
-- the legacy columns; that's fine — we just won't be able to re-render
-- those vaults from raw fragments later.

ALTER TABLE vaults ADD COLUMN owner_xpub_fragment_external TEXT;
ALTER TABLE vaults ADD COLUMN owner_xpub_fragment_internal TEXT;
ALTER TABLE vaults ADD COLUMN heir_xpub_fragment_external  TEXT;
ALTER TABLE vaults ADD COLUMN heir_xpub_fragment_internal  TEXT;

-- Heir contact, stored encrypted at rest. Populated by the heir-link
-- flow once the server-side encryption is wired (step 3). Until then
-- the legacy plaintext `heir_contact` column is the source of truth.
--
-- Layout when populated:
--   heir_contact_ciphertext: base64(libsodium sealed_box(JSON))
--   heir_contact_nonce:      base64(24-byte XChaCha20 nonce, if used)
--   heir_contact_channel:    "sms" | "email" | "whatsapp"
ALTER TABLE vaults ADD COLUMN heir_contact_ciphertext TEXT;
ALTER TABLE vaults ADD COLUMN heir_contact_nonce      TEXT;
ALTER TABLE vaults ADD COLUMN heir_contact_channel    TEXT;

-- One-time claim token issued when the alarm fires. The actual link
-- the heir clicks contains the decryption key in the URL fragment;
-- only the hash lives here, so a database leak can't impersonate the
-- heir. NULL until alarm fires.
ALTER TABLE vaults ADD COLUMN claim_token_hash TEXT;
ALTER TABLE vaults ADD COLUMN claim_token_issued_at TEXT;
ALTER TABLE vaults ADD COLUMN claim_token_used_at   TEXT;

CREATE INDEX IF NOT EXISTS idx_vaults_claim_token ON vaults (claim_token_hash);
