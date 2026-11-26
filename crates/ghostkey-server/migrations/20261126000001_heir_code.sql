-- Heir code (option a): the heir's key is sealed under a 5-word code that
-- only the owner and the heir know (Argon2id, same scheme as the heir
-- file), not under a claim token the server keeps. The server stores the
-- sealed key in the existing heir_xprv_sealed_* columns plus the KDF
-- parameters below, and nothing that can open it. The claim link is
-- minted at trigger time, hash-only, like a Door B vault.
--
-- heir_code_owner_*: the code itself, sealed under the owner's password
-- KEK, so the owner can show it again. The server can't open it.
--
-- heir_code_check_*: a fixed phrase sealed under a key derived from the
-- code key (domain-separated). Opening it proves a typed code is right
-- without touching the heir's key, so a practice run can test the code.
-- Guessing against it costs the same Argon2id as against the key itself.
ALTER TABLE vaults ADD COLUMN heir_code_salt_b64 TEXT;
ALTER TABLE vaults ADD COLUMN heir_code_kdf_mem_kib INTEGER;
ALTER TABLE vaults ADD COLUMN heir_code_kdf_iters INTEGER;
ALTER TABLE vaults ADD COLUMN heir_code_owner_sealed_ct_b64 TEXT;
ALTER TABLE vaults ADD COLUMN heir_code_owner_sealed_nonce TEXT;
ALTER TABLE vaults ADD COLUMN heir_code_check_ct_b64 TEXT;
ALTER TABLE vaults ADD COLUMN heir_code_check_nonce TEXT;
