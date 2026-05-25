//! BDK wallet construction from a [`Vault`].
//!
//! For watch-only operation we feed BDK the descriptor with **xpubs** (the
//! same string stored in [`crate::vault::VaultConfig`]). For owner/heir
//! signing, the host must supply an xpriv that BDK will use to derive the
//! corresponding signing key — we splice it into the descriptor in place of
//! the xpub.

use bdk_wallet::{KeychainKind, Wallet};
use bitcoin::bip32::Xpriv;
use bitcoin::secp256k1::Secp256k1;
use std::str::FromStr;

use crate::error::{Error, Result};
use crate::keys::{vault_account_path, Chain};
use crate::vault::Vault;

/// Build a watch-only BDK wallet from a vault.
pub fn build_watch_only(vault: &Vault) -> Result<Wallet> {
    let ext = vault.descriptor_for(Chain::External).to_string();
    let int_ = vault.descriptor_for(Chain::Internal).to_string();
    Wallet::create(ext, int_)
        .network(vault.network())
        .create_wallet_no_persist()
        .map_err(|e| Error::InvalidDescriptor(e.to_string()))
}

/// Splice an xpriv into the vault descriptors in place of the matching xpub,
/// returning a wallet that can sign for the holder of `signer_master`.
///
/// `signer_master` must be the master key whose BIP86 account xpub
/// (`m/86'/coin'/0'`) appears in the descriptor as the owner or heir.
pub fn build_signing(vault: &Vault, signer_master: &Xpriv) -> Result<Wallet> {
    let secp = Secp256k1::new();
    let path = vault_account_path(vault.network());
    let account = signer_master.derive_priv(&secp, &path)?;
    let fp = signer_master.fingerprint(&secp);
    let xpriv_str = account.to_string();

    // The fragment we wrote into the descriptor was:
    //   [fp/86'/coin'/0']xpub.../{0,1}/*
    // We want to replace the bracketed-origin+xpub portion with the xpriv,
    // while keeping the same `[origin]` and chain suffix. BDK accepts:
    //   [fp/86'/coin'/0']tprv.../0/*
    // and will produce identical pubkeys.
    let ext = splice_xpriv(vault.descriptor_for(Chain::External), fp, &path, &xpriv_str)?;
    let int_ = splice_xpriv(vault.descriptor_for(Chain::Internal), fp, &path, &xpriv_str)?;

    Wallet::create(ext, int_)
        .network(vault.network())
        .create_wallet_no_persist()
        .map_err(|e| Error::InvalidDescriptor(e.to_string()))
}

/// Replace the xpub immediately following a specific `[fp/path]` origin
/// with the provided xpriv string.
///
/// We deliberately match on the *origin* prefix (fingerprint + derivation
/// path) so that splicing only affects the intended key fragment — the
/// other party's xpub is left untouched.
fn splice_xpriv(
    descriptor: &str,
    fp: bitcoin::bip32::Fingerprint,
    path: &bitcoin::bip32::DerivationPath,
    xpriv_str: &str,
) -> Result<String> {
    let path_str = path.to_string();
    let path_str = path_str.strip_prefix("m/").unwrap_or(&path_str);
    let origin = format!("[{}/{}]", fp, path_str);

    let start = descriptor
        .find(&origin)
        .ok_or_else(|| Error::InvalidDescriptor(format!("origin {} not found", origin)))?;
    let after_origin = start + origin.len();

    // The xpub runs until the next '/' (which begins `/0/*` or `/1/*`).
    let suffix_off = descriptor[after_origin..].find('/').ok_or_else(|| {
        Error::InvalidDescriptor("malformed key fragment: no chain suffix".into())
    })?;
    let xpub_end = after_origin + suffix_off;

    let mut out = String::with_capacity(descriptor.len() + xpriv_str.len());
    out.push_str(&descriptor[..after_origin]);
    out.push_str(xpriv_str);
    out.push_str(&descriptor[xpub_end..]);
    Ok(out)
}

/// Convenience: reveal the next receive address for a vault wallet.
pub fn next_receive_address(w: &mut Wallet) -> bitcoin::Address {
    w.reveal_next_address(KeychainKind::External).address
}

/// Same as [`build_signing`] but takes an already-derived BIP86
/// account xprv (the key at `m/86'/coin'/0'`) instead of a master
/// xprv. Used by the browser-side password-vault flow where the
/// browser has the account xprv but never has the master.
///
/// We splice the account xprv into the descriptor in place of the
/// matching xpub. BDK accepts a tprv/xprv at the same origin as the
/// xpub it replaces, and produces identical pubkeys.
pub fn build_signing_from_account(vault: &Vault, account_xpriv: &Xpriv) -> Result<Wallet> {
    let path = vault_account_path(vault.network());
    // The account xprv carries no parent fingerprint of its own (it's
    // the root of its own subtree from BDK's perspective). We need
    // the *original* fingerprint that was baked into the descriptor
    // origin tag at vault creation. We recover it by parsing the
    // descriptor and locating the bracketed origin whose xpub matches
    // the one this xprv neuters into.
    let neutered = account_xpriv.to_priv().public_key(&Secp256k1::new());
    // The xpub embedded in the descriptor is the account xpub; we
    // derive it locally so we can find it textually.
    let account_xpub_str =
        bitcoin::bip32::Xpub::from_priv(&Secp256k1::new(), account_xpriv).to_string();
    let _ = neutered; // silence unused warning; we kept it for documentation

    let fp =
        find_origin_fingerprint_for_xpub(vault.descriptor_for(Chain::External), &account_xpub_str)?;

    let xpriv_str = account_xpriv.to_string();
    let ext = splice_xpriv(vault.descriptor_for(Chain::External), fp, &path, &xpriv_str)?;
    let int_ = splice_xpriv(vault.descriptor_for(Chain::Internal), fp, &path, &xpriv_str)?;

    Wallet::create(ext, int_)
        .network(vault.network())
        .create_wallet_no_persist()
        .map_err(|e| Error::InvalidDescriptor(e.to_string()))
}

/// Find the origin fingerprint that precedes the given xpub in a
/// descriptor string. Returns an error if the xpub doesn't appear,
/// or if it appears without a bracketed origin tag (which would mean
/// the descriptor was built outside the expected pipeline).
fn find_origin_fingerprint_for_xpub(
    descriptor: &str,
    xpub_str: &str,
) -> Result<bitcoin::bip32::Fingerprint> {
    let xpub_idx = descriptor
        .find(xpub_str)
        .ok_or_else(|| Error::InvalidDescriptor("xpub not present in descriptor".into()))?;
    // Walk backwards to the nearest '['; the FP is the 8 hex chars
    // following the '['.
    let prefix = &descriptor[..xpub_idx];
    let bracket_open = prefix
        .rfind('[')
        .ok_or_else(|| Error::InvalidDescriptor("xpub has no origin tag in descriptor".into()))?;
    let inside = &descriptor[bracket_open + 1..xpub_idx];
    let fp_part = inside.split('/').next().unwrap_or(inside);
    bitcoin::bip32::Fingerprint::from_str(fp_part)
        .map_err(|e| Error::InvalidDescriptor(format!("bad fingerprint in origin: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keys::{account_xpub, descriptor_key_fragment};
    use crate::vault::{Vault, VaultRole};
    use bitcoin::Network;

    fn mk_vault() -> (Vault, Xpriv, Xpriv) {
        let net = Network::Regtest;
        let owner_m = Xpriv::new_master(net, &[0x11; 32]).unwrap();
        let heir_m = Xpriv::new_master(net, &[0x22; 32]).unwrap();
        let (ofp, op, ox) = account_xpub(&owner_m, net).unwrap();
        let (hfp, hp, hx) = account_xpub(&heir_m, net).unwrap();
        let v = Vault::new(
            &descriptor_key_fragment(ofp, &op, &ox, Chain::External),
            &descriptor_key_fragment(ofp, &op, &ox, Chain::Internal),
            &descriptor_key_fragment(hfp, &hp, &hx, Chain::External),
            &descriptor_key_fragment(hfp, &hp, &hx, Chain::Internal),
            144,
            net,
            VaultRole::Owner,
            None,
        )
        .unwrap();
        (v, owner_m, heir_m)
    }

    #[test]
    fn build_watch_only_works_and_reveals_address() {
        let (v, _, _) = mk_vault();
        let mut w = build_watch_only(&v).unwrap();
        let addr = next_receive_address(&mut w);
        // Taproot regtest addresses start with bcrt1p.
        assert!(addr.to_string().starts_with("bcrt1p"), "got {}", addr);
    }

    #[test]
    fn build_owner_signing_wallet_matches_watch_only_addresses() {
        let (v, owner_m, _heir_m) = mk_vault();
        let mut watch = build_watch_only(&v).unwrap();
        let mut signing = build_signing(&v, &owner_m).unwrap();
        for _ in 0..3 {
            let a = watch.reveal_next_address(KeychainKind::External).address;
            let b = signing.reveal_next_address(KeychainKind::External).address;
            assert_eq!(a, b, "signing & watch-only must derive identical addresses");
        }
    }

    #[test]
    fn build_heir_signing_wallet_matches_watch_only_addresses() {
        let (v, _owner_m, heir_m) = mk_vault();
        let mut watch = build_watch_only(&v).unwrap();
        let mut signing = build_signing(&v, &heir_m).unwrap();
        for _ in 0..3 {
            let a = watch.reveal_next_address(KeychainKind::External).address;
            let b = signing.reveal_next_address(KeychainKind::External).address;
            assert_eq!(a, b);
        }
    }
}
