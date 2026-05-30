//! Key material helpers.
//!
//! ghostkey-core only ever generates **deterministic** keys from a BIP39
//! mnemonic or imports an extended public key for the heir. We never persist
//! anything to disk here; that's the host application's job.

use bip39::Mnemonic;
use bitcoin::bip32::{ChildNumber, DerivationPath, Xpriv, Xpub};
use bitcoin::secp256k1::Secp256k1;
use bitcoin::Network;
use hkdf::Hkdf;
use sha2::Sha256;
use std::str::FromStr;

use crate::error::{Error, Result};

/// HKDF "info" label for the per-vault secret. Bumping this label is
/// the only way to invalidate every existing heir derivation.
const VAULT_SECRET_INFO: &[u8] = b"ghostkey-heir-v1-secret";

/// HKDF "info" label for the heir BIP39 entropy.
const HEIR_BIP39_INFO: &[u8] = b"ghostkey-heir-bip39";

/// BIP86-style derivation path for taproot vault keys.
///
/// We use a dedicated purpose (`86'`) to keep vault keys separate from any
/// existing wallet's spending keys. The coin type follows BIP44.
///
/// Mainnet:  `m/86'/0'/0'`
/// Test/Sig: `m/86'/1'/0'`
pub fn vault_account_path(network: Network) -> DerivationPath {
    let coin = match network {
        Network::Bitcoin => 0,
        _ => 1,
    };
    DerivationPath::from(vec![
        ChildNumber::from_hardened_idx(86).unwrap(),
        ChildNumber::from_hardened_idx(coin).unwrap(),
        ChildNumber::from_hardened_idx(0).unwrap(),
    ])
}

/// Derive an account-level xpub from a master xpriv, suitable for embedding
/// in a vault descriptor as `[fingerprint/86'/coin'/0']xpub.../<0;1>/*`.
pub fn account_xpub(
    master: &Xpriv,
    network: Network,
) -> Result<(bitcoin::bip32::Fingerprint, DerivationPath, Xpub)> {
    let secp = Secp256k1::new();
    let path = vault_account_path(network);
    let fingerprint = master.fingerprint(&secp);
    let account_xpriv = master.derive_priv(&secp, &path)?;
    let xpub = Xpub::from_priv(&secp, &account_xpriv);
    Ok((fingerprint, path, xpub))
}

/// Parse an externally provided xpub string (typically the heir's).
pub fn parse_xpub(s: &str) -> Result<Xpub> {
    Xpub::from_str(s).map_err(|e| Error::InvalidXpub(e.to_string()))
}

/// Per-vault root secret: `HKDF-SHA256(salt = master_key, IKM = vault_id, info = "ghostkey-heir-v1-secret")`.
///
/// This is the value the heir's browser receives (after email auth) and
/// re-uses to re-derive the heir's BIP39 mnemonic. The server itself
/// only stores `master_key` and `vault_id`; vault_secret is recomputed
/// on demand.
pub fn compute_vault_secret(vault_id: &str, master_key: &[u8]) -> Result<[u8; 32]> {
    let hk = Hkdf::<Sha256>::new(Some(master_key), vault_id.as_bytes());
    let mut out = [0u8; 32];
    hk.expand(VAULT_SECRET_INFO, &mut out)
        .map_err(|e| Error::Hkdf(format!("vault_secret expand: {e}")))?;
    Ok(out)
}

/// Normalize an email for use as derivation input.
///
/// Lowercased + trimmed so a heir who types `  Alice@Example.COM` during
/// setup and `alice@example.com` at claim time gets the same key. Must
/// match the browser-side normalization in `crypto/heirKey.ts` exactly.
pub fn normalize_heir_email(email: &str) -> String {
    email.trim().to_ascii_lowercase()
}

/// Derive the heir's BIP39 entropy + account xpub deterministically from
/// the heir's email, the vault id, and the server master key.
///
/// Scheme (must stay byte-for-byte identical to `crypto/heirKey.ts`):
///
/// ```text
/// vault_secret = HKDF-SHA256(salt = master_key,   IKM = vault_id,   info = "ghostkey-heir-v1-secret")
/// heir_okm     = HKDF-SHA256(salt = vault_secret, IKM = email_norm, info = "ghostkey-heir-bip39")
/// entropy      = heir_okm[..16]                       (128 bits → 12-word mnemonic)
/// mnemonic     = BIP39(entropy)
/// seed         = PBKDF2(mnemonic_phrase, "mnemonic", 2048, SHA512)
/// account_xpub = BIP32(seed).derive("m/86'/coin'/0'")
/// ```
///
/// Returns `(entropy, account_xpub)`. The server only ever stores the
/// xpub (inside the descriptor); the entropy is reconstructed on the
/// client at claim time.
pub fn derive_heir_seed(
    heir_email: &str,
    vault_id: &str,
    master_key: &[u8],
    network: Network,
) -> Result<([u8; 16], Xpub)> {
    let vault_secret = compute_vault_secret(vault_id, master_key)?;
    let normalized = normalize_heir_email(heir_email);

    let hk = Hkdf::<Sha256>::new(Some(&vault_secret), normalized.as_bytes());
    let mut okm = [0u8; 32];
    hk.expand(HEIR_BIP39_INFO, &mut okm)
        .map_err(|e| Error::Hkdf(format!("heir entropy expand: {e}")))?;

    let mut entropy = [0u8; 16];
    entropy.copy_from_slice(&okm[..16]);

    let mnemonic =
        Mnemonic::from_entropy(&entropy).map_err(|e| Error::Bip39(format!("from_entropy: {e}")))?;
    let seed = mnemonic.to_seed_normalized("");

    let master = Xpriv::new_master(network, &seed)?;
    let (_fp, _path, xpub) = account_xpub(&master, network)?;

    Ok((entropy, xpub))
}

/// Which chain (receive vs change) a descriptor key fragment is for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Chain {
    /// External / receive chain. `.../0/*`
    External,
    /// Internal / change chain. `.../1/*`
    Internal,
}

impl Chain {
    pub fn index(self) -> u32 {
        match self {
            Chain::External => 0,
            Chain::Internal => 1,
        }
    }
}

/// Format a descriptor key fragment with full origin information so that
/// signing devices can find their path during PSBT signing.
///
/// Output: `[fingerprint/86'/coin'/0']xpub.../{0,1}/*`
///
/// We render one chain at a time because miniscript 12 does not accept
/// multipath descriptors (`<0;1>/*`) inside tapscript leaves.
pub fn descriptor_key_fragment(
    fingerprint: bitcoin::bip32::Fingerprint,
    path: &DerivationPath,
    xpub: &Xpub,
    chain: Chain,
) -> String {
    // bitcoin 0.32 DerivationPath::Display does not emit a leading "m/".
    let path_str = path.to_string();
    let path_str = path_str.strip_prefix("m/").unwrap_or(&path_str);
    format!("[{}/{}]{}/{}/*", fingerprint, path_str, xpub, chain.index())
}

#[cfg(test)]
mod tests {
    use super::*;
    use bitcoin::bip32::Xpriv;

    fn test_xpriv() -> Xpriv {
        // deterministic seed, do NOT use in production
        let seed = [0x11u8; 32];
        Xpriv::new_master(Network::Regtest, &seed).unwrap()
    }

    #[test]
    fn heir_derivation_is_deterministic_and_email_normalized() {
        let master_key = [0xABu8; 32];
        let vault_id = "11111111-2222-3333-4444-555555555555";
        let (e1, x1) =
            derive_heir_seed("alice@example.com", vault_id, &master_key, Network::Regtest).unwrap();
        let (e2, x2) = derive_heir_seed(
            "  Alice@Example.COM ",
            vault_id,
            &master_key,
            Network::Regtest,
        )
        .unwrap();
        assert_eq!(
            e1, e2,
            "email normalization must collapse case + whitespace"
        );
        assert_eq!(x1, x2);

        // Changing the vault id changes the entropy.
        let (e3, _) = derive_heir_seed(
            "alice@example.com",
            "different-vault-id",
            &master_key,
            Network::Regtest,
        )
        .unwrap();
        assert_ne!(e1, e3);

        // Changing the master key changes the entropy.
        let (e4, _) = derive_heir_seed(
            "alice@example.com",
            vault_id,
            &[0xCDu8; 32],
            Network::Regtest,
        )
        .unwrap();
        assert_ne!(e1, e4);
    }

    #[test]
    fn vault_secret_changes_per_vault() {
        let mk = [0x11u8; 32];
        let a = compute_vault_secret("vault-a", &mk).unwrap();
        let b = compute_vault_secret("vault-b", &mk).unwrap();
        assert_ne!(a, b);
    }

    #[test]
    fn derives_account_xpub() {
        let m = test_xpriv();
        let (fp, path, xpub) = account_xpub(&m, Network::Regtest).unwrap();
        // bitcoin 0.32 DerivationPath::Display emits without a leading "m/".
        assert_eq!(path.to_string(), "86'/1'/0'");
        let frag = descriptor_key_fragment(fp, &path, &xpub, Chain::External);
        assert!(frag.starts_with('['));
        assert!(frag.contains("/86'/1'/0']"));
        assert!(frag.ends_with("/0/*"));
        let internal = descriptor_key_fragment(fp, &path, &xpub, Chain::Internal);
        assert!(internal.ends_with("/1/*"));
    }
}
