-- Password-based, non-custodial vault setup.
--
-- Adds in-browser key generation: the owner picks a password, the
-- browser mints owner+heir BIP86 xprvs, seals them with the password
-- (Argon2id) and the claim token (HKDF), and ships only ciphertexts
-- to the server. Nothing on the server can spend a vault during the
-- owner's lifetime.
--
-- ## Why these columns are here
--
-- We need to support the new flow (sealed blobs + email-hash lookup)
-- without breaking the legacy CLI flow that posts pre-rendered
-- descriptors. All new columns are NULL-able. A vault row is in the
-- "password" flow iff `password_salt_b64` IS NOT NULL.
--
-- ## Threat model deltas vs. the xpub flow
--
-- - The server stores `claim_token_at_rest_b64` (the raw claim token
--   used by the browser at setup to wrap the heir xprv). A breach of
--   the at-rest store therefore exposes the ability to decrypt every
--   `heir_xprv_sealed` blob.
-- - That capability is NOT the ability to spend. Even with the heir
--   xprv extracted, an attacker cannot move funds while the on-chain
--   BIP68 timelock is unmatured, and after the timelock matures the
--   legitimate owner can still spend with their own key (which is
--   sealed under the password the attacker does not have).
-- - The window of real exposure is: server breach + owner stops
--   checking in + timelock matures, all without the legitimate heir
--   noticing the broadcast. We surface this in product docs and treat
--   it as the trade for "heir knows nothing until trigger."
-- - A v2 upgrade is to seal `claim_token_at_rest_b64` under an HSM-held
--   wrapping key released only after the scheduler attests the
--   trigger condition. The schema already supports this: rotate the
--   column's contents in place.

-- ----- Owner-side sealed material (Argon2id-wrapped) ------------------
ALTER TABLE vaults ADD COLUMN password_salt_b64        TEXT;
ALTER TABLE vaults ADD COLUMN password_kdf_mem_kib     INTEGER;
ALTER TABLE vaults ADD COLUMN password_kdf_iters       INTEGER;

ALTER TABLE vaults ADD COLUMN owner_xprv_sealed_ct_b64 TEXT;
ALTER TABLE vaults ADD COLUMN owner_xprv_sealed_nonce  TEXT;

ALTER TABLE vaults ADD COLUMN owner_token_sealed_ct_b64 TEXT;
ALTER TABLE vaults ADD COLUMN owner_token_sealed_nonce  TEXT;

-- ----- Heir-side sealed material (claim-token-wrapped) ----------------
ALTER TABLE vaults ADD COLUMN heir_xprv_sealed_ct_b64  TEXT;
ALTER TABLE vaults ADD COLUMN heir_xprv_sealed_nonce   TEXT;

-- The raw claim token, base64. Required at trigger time to construct
-- the heir's notification URL fragment. See the threat-model block
-- above for the exposure this carries.
ALTER TABLE vaults ADD COLUMN claim_token_at_rest_b64  TEXT;

-- ----- Email hash for cross-device owner recovery --------------------
-- SHA-256 hex of the lower-cased, NFKC-normalised owner email. The
-- plaintext email is never stored — only this hash and the encrypted
-- heir contact blob already managed by the existing schema. Lookup is
-- `WHERE owner_email_hash = ?`.
ALTER TABLE vaults ADD COLUMN owner_email_hash TEXT;

CREATE INDEX IF NOT EXISTS idx_vaults_owner_email_hash
    ON vaults (owner_email_hash);
