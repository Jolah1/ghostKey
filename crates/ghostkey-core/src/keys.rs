//! Key material helpers.
//!
//! ghostkey-core only ever generates **deterministic** keys from a BIP39
//! mnemonic or imports an extended public key for the heir. We never persist
//! anything to disk here; that's the host application's job.

use bitcoin::bip32::{ChildNumber, DerivationPath, Xpriv, Xpub};
use bitcoin::secp256k1::Secp256k1;
use bitcoin::Network;
use std::str::FromStr;

use crate::error::{Error, Result};

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
