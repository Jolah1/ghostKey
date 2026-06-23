//! Encryption-at-rest for heir contacts, and one-time claim tokens.
//!
//! ## Encryption model
//!
//! There is a single server-wide **master key** (32 bytes, base64).
//! It is resolved at boot from the first configured source: a command
//! (`GHOSTKEY_MASTER_KEY_CMD`, for decrypting it from a KMS / fetching
//! from a secrets manager), a file (`GHOSTKEY_MASTER_KEY_FILE`), or
//! directly in the env (`GHOSTKEY_MASTER_KEY`). For each vault we derive a
//! distinct
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
//! the token is stored in the database. The token is consumed via
//! `claim_token_used_at` only when the heir successfully broadcasts
//! their claim transaction (`POST /claim/:token/broadcast`); resolving
//! the link to display the page does not burn it, because the heir
//! typically revisits the URL while signing their PSBT offline.
//! Subsequent attempts after a successful broadcast refuse with a
//! clean "already used" error.
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
    #[error(
        "server master key missing: set GHOSTKEY_MASTER_KEY (32 bytes, base64), \
         or GHOSTKEY_MASTER_KEY_FILE / GHOSTKEY_MASTER_KEY_CMD to load it from a \
         file or KMS at boot"
    )]
    MasterKeyMissing,
    #[error("server master key malformed: {0}")]
    MasterKeyMalformed(String),
    /// The configured key source (file or command) could not be read or
    /// run. Distinct from `MasterKeyMalformed`: the source failed, not the
    /// contents. The message never contains key material.
    #[error("server master key source failed: {0}")]
    MasterKeyUnavailable(String),
    #[error("encryption failed: {0}")]
    Encrypt(String),
    #[error("decryption failed (wrong key or tampered ciphertext)")]
    Decrypt,
    #[error("malformed ciphertext: {0}")]
    Malformed(String),
}

/// Lazily-loaded process-wide master key.
///
/// We resolve from the configured source once and keep the result so
/// individual requests don't pay the lookup cost. Tests can override by
/// setting `GHOSTKEY_MASTER_KEY` before any handler runs.
static MASTER_KEY: OnceLock<Result<[u8; 32], CryptoError>> = OnceLock::new();

fn master_key() -> Result<&'static [u8; 32], CryptoError> {
    let entry = MASTER_KEY.get_or_init(load_master_key);
    match entry {
        Ok(k) => Ok(k),
        Err(e) => Err(clone_err(e)),
    }
}

/// Resolve the master key from the first configured source, in priority
/// order, fail-closed: if a higher-priority source is configured but
/// fails, we error rather than silently fall through to a different key.
///
///   1. `GHOSTKEY_MASTER_KEY_CMD` — a shell command whose stdout is the
///      key. This is the KMS/secrets-manager hook: point it at
///      `aws kms decrypt ...`, a Vault read, `op read ...`, etc., so the
///      plaintext key is fetched/decrypted at boot and never has to live
///      in the process environment.
///   2. `GHOSTKEY_MASTER_KEY_FILE` — a path whose contents are the key
///      (e.g. a mounted secret or a KMS sidecar's output file).
///   3. `GHOSTKEY_MASTER_KEY` — the key directly in the environment
///      (simplest; fine for dev, weakest for prod).
fn load_master_key() -> Result<[u8; 32], CryptoError> {
    if let Some(cmd) = non_empty_env("GHOSTKEY_MASTER_KEY_CMD") {
        return load_master_key_from_cmd(&cmd);
    }
    if let Some(path) = non_empty_env("GHOSTKEY_MASTER_KEY_FILE") {
        let raw = std::fs::read_to_string(&path).map_err(|e| {
            // Never include the file contents; the path is safe to show.
            CryptoError::MasterKeyUnavailable(format!("reading {path}: {e}"))
        })?;
        return parse_master_key(&raw);
    }
    let raw = std::env::var("GHOSTKEY_MASTER_KEY").map_err(|_| CryptoError::MasterKeyMissing)?;
    parse_master_key(&raw)
}

fn non_empty_env(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

/// Run the configured command via `sh -c` and parse its stdout as the
/// master key. Used to decrypt the key from a KMS / fetch it from a
/// secrets manager at boot. Errors carry the exit status and stderr but
/// never stdout, so key material can't leak into logs.
fn load_master_key_from_cmd(cmd: &str) -> Result<[u8; 32], CryptoError> {
    let output = std::process::Command::new("sh")
        .arg("-c")
        .arg(cmd)
        .output()
        .map_err(|e| CryptoError::MasterKeyUnavailable(format!("spawning key command: {e}")))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(CryptoError::MasterKeyUnavailable(format!(
            "key command exited with {}: {}",
            output.status,
            stderr.trim()
        )));
    }
    let raw = String::from_utf8(output.stdout).map_err(|_| {
        CryptoError::MasterKeyUnavailable("key command output was not UTF-8".into())
    })?;
    parse_master_key(&raw)
}

fn parse_master_key(raw: &str) -> Result<[u8; 32], CryptoError> {
    // `openssl rand -base64 32` (the command every doc suggests) emits
    // padded base64; accept it by stripping trailing '=' before the
    // no-pad decode.
    let bytes = B64
        .decode(raw.trim().trim_end_matches('='))
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
        CryptoError::MasterKeyUnavailable(s) => CryptoError::MasterKeyUnavailable(s.clone()),
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

/// Return a heap-allocated copy of the 32-byte master key.
///
/// Used by heir-key-derivation paths (F2) that have to hand the master
/// secret to `ghostkey-core::keys::derive_heir_seed`, which lives outside
/// this crate and cannot reach the `'static` reference behind `master_key`.
/// Callers should drop the `Vec` as soon as derivation is done.
pub fn master_key_bytes() -> Result<Vec<u8>, CryptoError> {
    master_key().map(|k| k.to_vec())
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
pub fn open_for_vault(vault_id: &str, sealed: &SealedContact) -> Result<Vec<u8>, CryptoError> {
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
    cipher
        .decrypt(nonce, ct.as_ref())
        .map_err(|_| CryptoError::Decrypt)
}

/// Marker prefixing an at-rest claim token that has been encrypted with
/// the per-vault AEAD. The raw claim token is base64-**url**-safe-no-pad
/// (`[A-Za-z0-9_-]`, see [`issue_claim_token`]), so it can never contain
/// a `.`; this prefix therefore can't collide with a legacy plaintext
/// row, which lets the reader tell sealed from legacy by inspection.
const SEALED_TOKEN_PREFIX: &str = "gk1.";

/// Encrypt a claim token for storage in `vaults.claim_token_at_rest_b64`.
///
/// Door A (password) vaults must keep the heir's claim token at rest so
/// the scheduler can put it in the heir's link when the owner is gone.
/// We seal it under the per-vault AEAD rather than storing it verbatim,
/// so a DB-only dump (a leaked backup, a stolen SQLite file) doesn't
/// hand over the bearer credential. This does **not** defend against a
/// running-server or master-key compromise: the server must be able to
/// decrypt to deliver the link, by construction. See the plan / PR.
///
/// The nonce and ciphertext are packed into the single existing column
/// as `gk1.<nonce_b64>.<ciphertext_b64>` so no schema migration is
/// needed; [`open_claim_token_at_rest`] reverses it and transparently
/// passes through legacy plaintext rows.
pub fn seal_claim_token_at_rest(vault_id: &str, token: &str) -> Result<String, CryptoError> {
    let sealed = seal_for_vault(vault_id, token.as_bytes())?;
    Ok(format!(
        "{SEALED_TOKEN_PREFIX}{}.{}",
        sealed.nonce_b64, sealed.ciphertext_b64
    ))
}

/// Reverse of [`seal_claim_token_at_rest`], with backward compatibility.
///
/// Rows written before this change hold the raw token verbatim (no
/// prefix); we return those unchanged. Rows with the `gk1.` prefix are
/// AEAD-sealed and get decrypted with the per-vault key.
pub fn open_claim_token_at_rest(vault_id: &str, stored: &str) -> Result<String, CryptoError> {
    let Some(rest) = stored.strip_prefix(SEALED_TOKEN_PREFIX) else {
        // Legacy plaintext token, stored before at-rest sealing landed.
        return Ok(stored.to_string());
    };
    let (nonce_b64, ciphertext_b64) = rest
        .split_once('.')
        .ok_or_else(|| CryptoError::Malformed("at-rest token: missing nonce separator".into()))?;
    let pt = open_for_vault(
        vault_id,
        &SealedContact {
            ciphertext_b64: ciphertext_b64.to_string(),
            nonce_b64: nonce_b64.to_string(),
        },
    )?;
    String::from_utf8(pt).map_err(|e| CryptoError::Malformed(format!("at-rest token utf8: {e}")))
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
    let (token, hash_hex) = mint_bearer_token();
    IssuedClaimToken { token, hash_hex }
}

/// Compute the SHA-256 hex of a claim token, for storage and lookup.
///
/// Lookups are by exact-match on the indexed `claim_token_hash` column;
/// the constant-time check happens later, in
/// [`claim_token_matches`].
pub fn hash_claim_token(token: &str) -> String {
    hash_token(token)
}

/// Constant-time comparison of a presented token against a stored hash.
///
/// The DB lookup already found a row by hash, so an attacker who knows
/// the hash already passed the (publicly visible) first hurdle; the
/// purpose of this check is to defend against side-channels at the
/// second hurdle (e.g. an attacker who controls the token but is
/// fishing for hash collisions or DB confusion).
pub fn claim_token_matches(presented: &str, stored_hash_hex: &str) -> bool {
    token_matches(presented, stored_hash_hex)
}

/* -------------------------------------------------------------------------- *
 *  Owner tokens                                                              *
 *                                                                            *
 *  Same shape as claim tokens (32 bytes, base64-url-no-pad, SHA-256 hex)     *
 *  but with a distinct type so the compiler refuses to mix them up. An       *
 *  owner token authenticates a request as "the owner of vault X"; a claim    *
 *  token authenticates a request as "the heir of vault X who clicked the     *
 *  one-time link". They are not interchangeable.                             *
 * -------------------------------------------------------------------------- */

/// A freshly-issued owner token, returned once at vault creation.
///
/// Mirrors [`IssuedClaimToken`] structurally. We keep the type separate so
/// that a future refactor can't silently swap one for the other.
#[derive(Debug)]
pub struct IssuedOwnerToken {
    /// The bearer credential the owner sees. Returned in the create-vault
    /// response body exactly once. The server only ever stores `hash_hex`.
    pub token: String,
    /// SHA-256 hex digest of `token`, for `vaults.owner_token_hash`.
    pub hash_hex: String,
}

/// Issue a fresh owner token. Call once per vault, at creation.
pub fn issue_owner_token() -> IssuedOwnerToken {
    let (token, hash_hex) = mint_bearer_token();
    IssuedOwnerToken { token, hash_hex }
}

/// Hash an owner token for storage / lookup. Alias of [`hash_token`].
//
// Mirrors `hash_claim_token`. Currently only used in tests and from
// the `auth` module via `owner_token_matches`; expose it publicly so
// the symmetry with claim tokens stays obvious.
#[allow(dead_code)]
pub fn hash_owner_token(token: &str) -> String {
    hash_token(token)
}

/// Constant-time comparison of a presented owner token against a stored
/// hash. See [`claim_token_matches`] for the rationale.
pub fn owner_token_matches(presented: &str, stored_hash_hex: &str) -> bool {
    token_matches(presented, stored_hash_hex)
}

/* -------------------------------------------------------------------------- *
 *  Shared token primitives                                                   *
 * -------------------------------------------------------------------------- */

/// Mint a 32-byte random bearer token (base64-url-no-pad) and return it
/// alongside its SHA-256 hex digest. Used for both claim and owner tokens.
fn mint_bearer_token() -> (String, String) {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    let token = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes);
    let hash_hex = hash_token(&token);
    (token, hash_hex)
}

/// SHA-256 hex of an arbitrary token string. Same hash function for
/// claim and owner tokens so DB lookups all share one code path.
fn hash_token(token: &str) -> String {
    let mut h = Sha256::new();
    h.update(token.as_bytes());
    let digest = h.finalize();
    hex::encode(digest)
}

/// Constant-time comparison of a presented token against a stored hash.
fn token_matches(presented: &str, stored_hash_hex: &str) -> bool {
    let presented_hash = hash_token(presented);
    presented_hash
        .as_bytes()
        .ct_eq(stored_hash_hex.as_bytes())
        .into()
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
            unsafe {
                std::env::set_var("GHOSTKEY_MASTER_KEY", &b64);
            }
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
    fn at_rest_token_round_trips_and_is_not_plaintext() {
        ensure_test_master_key();
        let token = "raw-bearer-token-the-heir-sees-0xCAFE";
        let sealed = seal_claim_token_at_rest("vault-pw", token).expect("seal token");
        assert!(
            sealed.starts_with("gk1."),
            "sealed at-rest token must carry the format marker: {sealed}"
        );
        assert!(
            !sealed.contains(token),
            "the raw token must not appear in the at-rest value: {sealed}"
        );
        let opened = open_claim_token_at_rest("vault-pw", &sealed).expect("open token");
        assert_eq!(opened, token);
    }

    #[test]
    fn at_rest_token_passes_through_legacy_plaintext_rows() {
        ensure_test_master_key();
        // Rows written before sealing landed hold the raw token verbatim
        // (base64url, no `gk1.` prefix). They must round-trip unchanged.
        let legacy = "OldRawToken_with-url-safe-chars1234567890AbC";
        let opened = open_claim_token_at_rest("vault-legacy", legacy).expect("legacy open");
        assert_eq!(opened, legacy);
    }

    #[test]
    fn at_rest_token_sealed_for_one_vault_will_not_open_for_another() {
        ensure_test_master_key();
        let sealed = seal_claim_token_at_rest("vault-A", "tok").expect("seal");
        let err = open_claim_token_at_rest("vault-B", &sealed);
        assert!(
            matches!(err, Err(CryptoError::Decrypt)),
            "cross-vault at-rest open must fail with Decrypt, got {err:?}"
        );
    }

    #[test]
    fn different_vault_ids_cannot_open_each_others_ciphertext() {
        ensure_test_master_key();
        let sealed = seal_for_vault("vault-1", b"secret-1").expect("seal");
        let err = open_for_vault("vault-2", &sealed);
        assert!(
            matches!(err, Err(CryptoError::Decrypt)),
            "wrong-vault open must fail with Decrypt, got {err:?}"
        );
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
        assert!(matches!(
            err,
            Err(CryptoError::Decrypt) | Err(CryptoError::Malformed(_))
        ));
    }

    #[test]
    fn master_key_accepts_padded_and_unpadded_base64() {
        let key = [7u8; 32];
        let unpadded = B64.encode(key);
        let padded = base64::engine::general_purpose::STANDARD.encode(key);
        assert!(
            padded.ends_with('='),
            "32 bytes must pad in standard base64"
        );
        assert_eq!(parse_master_key(&unpadded).expect("unpadded"), key);
        assert_eq!(parse_master_key(&padded).expect("padded"), key);
        assert_eq!(
            parse_master_key(&format!("  {padded}\n")).expect("whitespace"),
            key
        );
        assert!(matches!(
            parse_master_key("too-short"),
            Err(CryptoError::MasterKeyMalformed(_))
        ));
    }

    #[test]
    fn master_key_from_cmd_runs_and_parses_stdout() {
        // The KMS hook: a command whose stdout is the key. `printf` keeps
        // it to the exact bytes (no trailing newline to worry about).
        let key = [9u8; 32];
        let b64 = B64.encode(key);
        let got = load_master_key_from_cmd(&format!("printf %s {b64}")).expect("cmd key");
        assert_eq!(got, key);
    }

    #[test]
    fn master_key_from_cmd_fails_closed_on_nonzero_exit() {
        let err = load_master_key_from_cmd("exit 3").expect_err("nonzero exit must fail");
        assert!(matches!(err, CryptoError::MasterKeyUnavailable(_)));
    }

    #[test]
    fn master_key_from_cmd_rejects_malformed_output() {
        let err =
            load_master_key_from_cmd("printf not-a-valid-key").expect_err("bad output must fail");
        assert!(matches!(err, CryptoError::MasterKeyMalformed(_)));
    }

    #[test]
    fn each_seal_produces_a_fresh_nonce() {
        ensure_test_master_key();
        let a = seal_for_vault("vault-q", b"same").expect("seal");
        let b = seal_for_vault("vault-q", b"same").expect("seal");
        assert_ne!(a.nonce_b64, b.nonce_b64, "nonces must be unique");
        assert_ne!(
            a.ciphertext_b64, b.ciphertext_b64,
            "AEAD output must vary with nonce even for identical plaintexts"
        );
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

    #[test]
    fn owner_token_issue_and_match() {
        let t = issue_owner_token();
        assert_eq!(t.token.len(), 43, "32 bytes base64-url-no-pad");
        assert_eq!(t.hash_hex.len(), 64, "sha-256 hex");
        assert!(owner_token_matches(&t.token, &t.hash_hex));
        let mut bad = t.token.clone();
        let first = bad.remove(0);
        let replacement = if first == 'A' { 'B' } else { 'A' };
        bad.insert(0, replacement);
        assert!(!owner_token_matches(&bad, &t.hash_hex));
    }

    #[test]
    fn owner_tokens_are_unique() {
        let a = issue_owner_token();
        let b = issue_owner_token();
        assert_ne!(a.token, b.token);
        assert_ne!(a.hash_hex, b.hash_hex);
    }

    /// Defense-in-depth: an owner token must not match a claim-token
    /// hash and vice versa. They share an algorithm but live in
    /// different columns and are used in different routes; mixing
    /// them up would be a security regression. The strong property
    /// here is that both column lookups index by hash, so an owner
    /// token whose hash happens to equal a claim-token hash would
    /// only "succeed" against the wrong route by colliding SHA-256 —
    /// which is the inverse of "preimage resistance". This test just
    /// asserts the engineering contract: an issued owner token's
    /// hash is overwhelmingly unlikely to match an issued claim
    /// token's hash.
    #[test]
    fn owner_and_claim_token_namespaces_do_not_overlap() {
        let o = issue_owner_token();
        let c = issue_claim_token();
        assert_ne!(o.hash_hex, c.hash_hex);
        // And the inputs themselves differ.
        assert_ne!(o.token, c.token);
    }
}
