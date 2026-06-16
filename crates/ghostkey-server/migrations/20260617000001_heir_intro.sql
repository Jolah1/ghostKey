-- #98 Part 2 (item 3): a named, personal first contact.
--
-- The owner can optionally give their display name ("Jane set this up
-- for you") and a short note shown to the heir in the claim message.
-- Both name the owner and reveal the relationship, so they are sealed
-- per-vault exactly like the heir/owner contacts (see
-- 20260527000001_owner_contact_sealed.sql).
--
-- Stored as a single sealed JSON blob: {"from_name": ..., "note": ...}.
-- Either field may be null inside the blob; the whole pair is null for
-- legacy vaults and for owners who skip it.
--
--   heir_intro_ciphertext  base64(XChaCha20-Poly1305 sealed JSON)
--   heir_intro_nonce       base64(24-byte nonce)
ALTER TABLE vaults ADD COLUMN heir_intro_ciphertext TEXT;
ALTER TABLE vaults ADD COLUMN heir_intro_nonce      TEXT;
