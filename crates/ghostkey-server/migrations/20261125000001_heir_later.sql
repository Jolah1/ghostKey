-- Inheritance is optional at setup; the owner can choose an heir later.
--
-- A vault is still created with an heir key in its descriptor (the
-- waiting period and the heir branch are written into the address), but
-- until an heir is chosen that key is sealed under the OWNER's password,
-- not under a claim token. The server can't open it and holds no claim
-- token, so nothing it stores can reach the heir branch. Choosing an heir
-- re-seals the key the normal Door A way (in the browser) and clears
-- `heir_pending`.
--
-- While `heir_pending = 1` the vault never leaves 'unfunded': no
-- check-in clock, no reminders, no alarm, nobody to contact. It is just
-- savings only the owner can spend.
ALTER TABLE vaults ADD COLUMN heir_pending INTEGER NOT NULL DEFAULT 0;
ALTER TABLE vaults ADD COLUMN heir_xprv_owner_sealed_ct_b64 TEXT;
ALTER TABLE vaults ADD COLUMN heir_xprv_owner_sealed_nonce TEXT;
