//! Encryption-at-rest for heir contacts, and one-time claim tokens.
//!
//! ## Encryption model
//!
//! There is a single server-wide **master key** (32 bytes, base64 in the
//! `GHOSTKEY_MASTER_KEY` env var). For each vault we derive a distinct
//! per-vault key via HKDF-SHA256, using the vault id as the salt and a
//! fixed context string as the info. This means:
//!
//!   - A database-only leak reveals only ciphertexts. The attacker needs
//!     the master key (held in the server process / env / secret store)
//!     to read any heir contact.
//!   - The blast radius of a future key-handling bug is one vault at a
//!     time: per-vault keys never appear outside a single request scope.
//!
//! We are explicitly **not** defending against a fully-compromised
//! running server. An attacker who can run code in the server process
//! has whatever the request handlers can read, by construction.
//!
//! Algorithm: XChaCha20-Poly1305 AEAD with a fresh random 24-byte nonce
//! per encryption. The nonce is stored alongside the ciphertext (base64
//! in the `heir_contact_nonce` column).
//!
//! ## Claim tokens
//!
//! When the scheduler decides it's time to reach the heir, a fresh
//! 32-byte random token is generated. The token itself is sent to the
//! heir in the claim link (in the URL path); only the SHA-256 hash of
//! the token is stored in the database. First successful resolve marks
//! the token consumed via `claim_token_used_at`; subsequent attempts
//! refuse with a clean "already used" error.
//!
//! Tokens are not bound to a session, IP, or device — they are a bearer
//! credential by design. The heir is the only person who has the
//! original token; the server cannot regenerate it from the hash.

use base64::engine::general_purpose::STANDARD_NO_PAD as B64;
use base64::Engine;
use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use hkdf::Hkdf;
use rand::RngCore;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

use std::sync::OnceLock;

/// HKDF "info" context for per-vault contact keys. Distinct value =
/// distinct purpose. Don't reuse the master key for anything else
/// without picking a new info string.
const CONTACT_KEY_INFO: &[u8] = b"ghostkey:contact:v1";

#[derive(Debug, thiserror::Error)]
pub enum CryptoError {
    #[error("server master key missing: set GHOSTKEY_MASTER_KEY (32 bytes, base64)")]
    MasterKeyMissing,
    #[error("server master key malformed: {0}")]
    MasterKeyMalformed(String),
    #[error("encryption failed: {0}")]
    Encrypt(String),
    #[error("decryption failed (wrong key or tampered ciphertext)")]
    Decrypt,
    #[error("malformed ciphertext: {0}")]
    Malformed(String),
}

/// Lazily-loaded process-wide master key.
///
/// We resolve from env once and keep the result so individual requests
/// don't pay env-lookup cost. Tests can override by setting the env var
/// before any handler runs.
static MASTER_KEY: OnceLock<Result<[u8; 32], CryptoError>> = OnceLock::new();

fn master_key() -> Result<&'static [u8; 32], CryptoError> {
    let entry = MASTER_KEY.get_or_init(load_master_key_from_env);
    match entry {
        Ok(k) => Ok(k),
        Err(e) => Err(clone_err(e)),
    }
}

fn load_master_key_from_env() -> Result<[u8; 32], CryptoError> {
    let raw = std::env::var("GHOSTKEY_MASTER_KEY")
        .map_err(|_| CryptoError::MasterKeyMissing)?;
    let bytes = B64
        .decode(raw.trim())
        .map_err(|e| CryptoError::MasterKeyMalformed(format!("not base64: {e}")))?;
    if bytes.len() != 32 {
        return Err(CryptoError::MasterKeyMalformed(format!(
            "expected 32 bytes, got {}",
            bytes.len()
        )));
    }
    let mut out = [0u8; 32];
    out.copy_from_slice(&bytes);
    Ok(out)
}

fn clone_err(e: &CryptoError) -> CryptoError {
    // `thiserror`-derived enums aren't `Clone`. We re-construct rather
    // than depend on a clone derive that would add noise to the public
    // shape of the type.
    match e {
        CryptoError::MasterKeyMissing => CryptoError::MasterKeyMissing,
        CryptoError::MasterKeyMalformed(s) => CryptoError::MasterKeyMalformed(s.clone()),
        CryptoError::Encrypt(s) => CryptoError::Encrypt(s.clone()),
        CryptoError::Decrypt => CryptoError::Decrypt,
        CryptoError::Malformed(s) => CryptoError::Malformed(s.clone()),
    }
}

/// Startup self-check. Called from `main` so misconfiguration is loud
/// and immediate rather than surfacing later as a 500 on the first
/// vault creation.
pub fn ensure_master_key_loaded() -> Result<(), CryptoError> {
    master_key().map(|_| ())
}

/// Derive the per-vault AEAD key from the master key + vault id.
///
/// The vault id is uuid v4 in this codebase; we hash it through HKDF
/// rather than use it raw to defend against any future change in id
/// shape (e.g. shorter ids). HKDF's `salt` doesn't need to be secret —
/// it just needs to differ between vaults, which the uuid guarantees.
fn vault_contact_key(vault_id: &str) -> Result<[u8; 32], CryptoError> {
    let master = master_key()?;
    let hk = Hkdf::<Sha256>::new(Some(vault_id.as_bytes()), master);
    let mut out = [0u8; 32];
    hk.expand(CONTACT_KEY_INFO, &mut out)
        .expect("32 bytes is well within HKDF-SHA256's max output");
    Ok(out)
}

/// Encrypted payload as it lives on the wire / in the DB.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SealedContact {
    /// Base64 (no padding) ciphertext including the 16-byte AEAD tag.
    pub ciphertext_b64: String,
    /// Base64 (no padding) 24-byte XChaCha20 nonce.
    pub nonce_b64: String,
}

/// Encrypt `plaintext` for storage tied to `vault_id`.
///
/// `plaintext` is typically the JSON string of `{name, contact, channel}`
/// produced by the setup wizard. Empty plaintext is allowed and round-
/// trips correctly; callers may use it as a sentinel for "no heir
/// contact provided" rather than skipping encryption entirely (so the
/// column shape is uniform).
pub fn seal_for_vault(vault_id: &str, plaintext: &[u8]) -> Result<SealedContact, CryptoError> {
    let key = vault_contact_key(vault_id)?;
    let cipher = XChaCha20Poly1305::new(&key.into());
    let mut nonce_bytes = [0u8; 24];
    rand::thread_rng().fill_bytes(&mut nonce_bytes);
    let nonce = XNonce::from_slice(&nonce_bytes);
    let ct = cipher
        .encrypt(nonce, plaintext)
        .map_err(|e| CryptoError::Encrypt(e.to_string()))?;
    Ok(SealedContact {
        ciphertext_b64: B64.encode(&ct),
        nonce_b64: B64.encode(nonce_bytes),
    })
}

/// Reverse of [`seal_for_vault`]. Returns the original plaintext bytes
/// or an error that is deliberately non-specific about *why* it failed
/// (wrong key vs tampering vs truncation are all `Decrypt`) to avoid
/// leaking decision bits.
pub fn open_for_vault(
    vault_id: &str,
    sealed: &SealedContact,
) -> Result<Vec<u8>, CryptoError> {
    let key = vault_contact_key(vault_id)?;
    let cipher = XChaCha20Poly1305::new(&key.into());
    let nonce = B64
        .decode(&sealed.nonce_b64)
        .map_err(|e| CryptoError::Malformed(format!("nonce: {e}")))?;
    if nonce.len() != 24 {
        return Err(CryptoError::Malformed(format!(
            "nonce length {} (want 24)",
            nonce.len()
        )));
    }
    let nonce = XNonce::from_slice(&nonce);
    let ct = B64
        .decode(&sealed.ciphertext_b64)
        .map_err(|e| CryptoError::Malformed(format!("ciphertext: {e}")))?;
    cipher.decrypt(nonce, ct.as_ref()).map_err(|_| CryptoError::Decrypt)
}

/* -------------------------------------------------------------------------- *
 *  Claim tokens                                                              *
 * -------------------------------------------------------------------------- */

/// A freshly-issued claim token, in the form that goes into the URL.
///
/// We use base64-url-safe-no-pad for token rendering so it can be
/// embedded directly in a path segment. 32 bytes → 43 chars.
#[derive(Debug)]
pub struct IssuedClaimToken {
    /// The bearer credential the heir sees. Never store this server-side.
    pub token: String,
    /// SHA-256 hex digest of `token`. This is what goes into
    /// `vaults.claim_token_hash`.
    pub hash_hex: String,
}

/// Issue a brand-new claim token. Each call produces a fresh random
/// token; do not call this twice for the same vault unless you mean to
/// invalidate the previous one.
pub fn issue_claim_token() -> IssuedClaimToken {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    let token = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes);
    let hash_hex = hash_claim_token(&token);
    IssuedClaimToken { token, hash_hex }
}

/// Compute the SHA-256 hex of a claim token, for storage and lookup.
///
/// Lookups are by exact-match on the indexed `claim_token_hash` column;
/// the constant-time check happens later, in
/// [`claim_token_matches`].
pub fn hash_claim_token(token: &str) -> String {
    let mut h = Sha256::new();
    h.update(token.as_bytes());
    let digest = h.finalize();
    hex::encode(digest)
}

/// Constant-time comparison of a presented token against a stored hash.
///
/// The DB lookup already found a row by hash, so an attacker who knows
/// the hash already passed the (publicly visible) first hurdle; the
/// purpose of this check is to defend against side-channels at the
/// second hurdle (e.g. an attacker who controls the token but is
/// fishing for hash collisions or DB confusion).
pub fn claim_token_matches(presented: &str, stored_hash_hex: &str) -> bool {
    let presented_hash = hash_claim_token(presented);
    presented_hash.as_bytes().ct_eq(stored_hash_hex.as_bytes()).into()
}

/* -------------------------------------------------------------------------- *
 *  Tests                                                                     *
 * -------------------------------------------------------------------------- */

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// Tests must serialise around the env var because `OnceLock` only
    /// initialises once per process. The first test to run wins; the
    /// rest of the tests in this module ride on the same key.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    fn ensure_test_master_key() {
        let _g = ENV_LOCK.lock().unwrap();
        // 32 zero bytes, base64-no-pad.
        if std::env::var("GHOSTKEY_MASTER_KEY").is_err() {
            // 32 bytes of zeros base64-no-pad = "AAAAAAAA..." x ~43
            let zeros = [0u8; 32];
            let b64 = B64.encode(zeros);
            // SAFETY: we are in tests, before any handler runs.
            unsafe { std::env::set_var("GHOSTKEY_MASTER_KEY", &b64); }
        }
    }

    #[test]
    fn round_trip_seal_and_open() {
        ensure_test_master_key();
        let pt = b"hello sarah, the time has come";
        let sealed = seal_for_vault("vault-abc", pt).expect("seal");
        let opened = open_for_vault("vault-abc", &sealed).expect("open");
        assert_eq!(opened, pt);
    }

    #[test]
    fn different_vault_ids_cannot_open_each_others_ciphertext() {
        ensure_test_master_key();
        let sealed = seal_for_vault("vault-1", b"secret-1").expect("seal");
        let err = open_for_vault("vault-2", &sealed);
        assert!(matches!(err, Err(CryptoError::Decrypt)),
            "wrong-vault open must fail with Decrypt, got {err:?}");
    }

    #[test]
    fn tampered_ciphertext_is_rejected() {
        ensure_test_master_key();
        let mut sealed = seal_for_vault("vault-z", b"do not touch").expect("seal");
        // Flip the first base64 char — produces invalid AEAD tag.
        let mut bytes = sealed.ciphertext_b64.into_bytes();
        bytes[0] = if bytes[0] == b'A' { b'B' } else { b'A' };
        sealed.ciphertext_b64 = String::from_utf8(bytes).unwrap();
        let err = open_for_vault("vault-z", &sealed);
        assert!(matches!(err, Err(CryptoError::Decrypt) | Err(CryptoError::Malformed(_))));
    }

    #[test]
    fn each_seal_produces_a_fresh_nonce() {
        ensure_test_master_key();
        let a = seal_for_vault("vault-q", b"same").expect("seal");
        let b = seal_for_vault("vault-q", b"same").expect("seal");
        assert_ne!(a.nonce_b64, b.nonce_b64, "nonces must be unique");
        assert_ne!(a.ciphertext_b64, b.ciphertext_b64,
            "AEAD output must vary with nonce even for identical plaintexts");
    }

    #[test]
    fn empty_plaintext_round_trips() {
        ensure_test_master_key();
        let sealed = seal_for_vault("vault-empty", b"").expect("seal");
        let opened = open_for_vault("vault-empty", &sealed).expect("open");
        assert!(opened.is_empty());
    }

    #[test]
    fn claim_token_issue_and_match() {
        ensure_test_master_key();
        let t = issue_claim_token();
        // Token is the base64url of 32 bytes → 43 chars no padding.
        assert_eq!(t.token.len(), 43);
        // Hash is SHA-256 hex → 64 chars.
        assert_eq!(t.hash_hex.len(), 64);
        // Correct token matches.
        assert!(claim_token_matches(&t.token, &t.hash_hex));
        // Mutating one character breaks the match.
        let mut bad = t.token.clone();
        let first = bad.remove(0);
        let replacement = if first == 'A' { 'B' } else { 'A' };
        bad.insert(0, replacement);
        assert!(!claim_token_matches(&bad, &t.hash_hex));
    }

    #[test]
    fn claim_tokens_are_unique() {
        let a = issue_claim_token();
        let b = issue_claim_token();
        assert_ne!(a.token, b.token);
        assert_ne!(a.hash_hex, b.hash_hex);
    }
}
