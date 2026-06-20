-- Guardian vaults for underage heirs (issue #81).
--
-- A guardian vault's claim branch is `heir AND (g1 OR g2) AND older(N)`:
-- the heir plus at least one of two guardians must co-sign. The heir keeps
-- using the existing inline sealed columns on `vaults` (heir_xprv_sealed_*,
-- claim_token_*), so the entire heir sealed-key / claim-token / scheduler
-- machinery is reused unchanged. Only the two guardians are new, and they
-- live in their own table so the wide `vaults` row isn't bloated for the
-- common standard vault.
--
-- Custody note (post-#124): like the heir key, each guardian key is
-- generated and sealed in the owner's browser at setup; the server only
-- ever stores ciphertext, gated on the per-party claim token. No
-- server-side master-key derivation.

-- Marks a vault as a guardian vault. 'standard' = the existing single-heir
-- shape; 'guardian' = heir + two guardians. Inferring from the descriptor
-- is possible but a column keeps queries (scheduler, claim) cheap and clear.
ALTER TABLE vaults ADD COLUMN vault_kind TEXT NOT NULL DEFAULT 'standard';

CREATE TABLE vault_guardian_keys (
    vault_id    TEXT    NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
    -- 1 or 2. Maps to G1 / G2 in the descriptor's `or_b(pk(G1), s:pk(G2))`.
    slot        INTEGER NOT NULL,

    -- The guardian's xprv, sealed in the browser under this guardian's
    -- claim token (same scheme as the heir's sealed xprv).
    xprv_sealed_ct_b64 TEXT NOT NULL,
    xprv_sealed_nonce  TEXT NOT NULL,

    -- Claim token, sealed at rest under the per-vault AEAD (the scheduler
    -- embeds the raw token in this guardian's link once the owner is gone),
    -- plus its plaintext SHA-256 hash for the /claim/:token lookup.
    claim_token_at_rest_b64 TEXT,
    claim_token_hash        TEXT,
    claim_token_issued_at   TEXT,

    -- This guardian's contact, sealed at rest like the heir/owner contacts.
    contact_ciphertext TEXT,
    contact_nonce      TEXT,
    contact_channel    TEXT,

    -- The guardian's descriptor key fragments, kept so the watch-only /
    -- claim machinery can identify which slot a guardian token belongs to.
    xpub_fragment_external TEXT NOT NULL,
    xpub_fragment_internal TEXT NOT NULL,

    created_at TEXT NOT NULL,

    PRIMARY KEY (vault_id, slot)
);

-- The /claim/:token resolver looks a token hash up across heir (inline) and
-- guardian (here) parties; index the guardian hash for that path.
CREATE INDEX idx_guardian_keys_token_hash
    ON vault_guardian_keys(claim_token_hash);
