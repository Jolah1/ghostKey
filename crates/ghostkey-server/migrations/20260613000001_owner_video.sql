-- Owner video message (proof-of-life / anti-scam) for heirs. See #85.
--
-- The owner optionally records a short clip while alive. The heir plays
-- it at claim time to confirm the claim is genuine — a face and a voice,
-- the trust primitive a non-technical heir actually understands.
--
-- Threat model:
--   * Confidentiality: the clip is sealed client-side under the
--     claim-token KEK (deriveClaimKek) — the same gate as
--     heir_xprv_sealed. The server stores only ciphertext and can
--     neither view it nor hand a useful copy to anyone without the
--     claim token. A scam link carries an attacker-chosen token, so it
--     can never decrypt the real clip.
--   * Integrity / anti-deepfake: the owner signs sha256(plaintext clip)
--     with the vault owner key. The heir's browser verifies that
--     signature against the owner xpub embedded in the public descriptor
--     before playing. A substituted clip (even an AI deepfake) fails
--     verification — the heir is shown it is NOT authentic.
--
-- Kept in its own table so the multi-MB ciphertext never bloats the hot
-- `vaults` row. Cascade-deletes with the vault.
CREATE TABLE IF NOT EXISTS vault_videos (
    vault_id          TEXT PRIMARY KEY
                        REFERENCES vaults(id) ON DELETE CASCADE,

    -- XChaCha20-Poly1305 ciphertext + 24-byte nonce, both base64.
    video_ct_b64      TEXT NOT NULL,
    video_nonce_b64   TEXT NOT NULL,

    -- Container MIME (e.g. "video/webm") and clip length for the UI.
    mime              TEXT NOT NULL,
    duration_ms       INTEGER,

    -- Tamper seal: owner's signature over the signed digest below, made
    -- with the vault owner key (the account key whose xpub is in the
    -- descriptor). base64. Heir verifies with the owner xpub.
    owner_sig_b64     TEXT NOT NULL,
    -- Hex sha256 the signature commits to (of the plaintext clip).
    -- Stored for transparency / independent verification.
    signed_sha256_hex TEXT NOT NULL,

    created_at        TEXT NOT NULL
);
