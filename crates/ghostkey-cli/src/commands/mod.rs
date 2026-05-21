pub mod address;
pub mod balance;
pub mod check_in;
pub mod claim;
pub mod init_keys;
pub mod make_vault;
pub mod show_xpub;
pub mod sync;

use anyhow::{anyhow, Result};
use bip39::Mnemonic;
use bitcoin::bip32::Xpriv;
use bitcoin::Network;
use std::str::FromStr;

/// Derive a BIP32 master xpriv from a stored mnemonic.
pub fn master_xpriv(mnemonic: &str, network: Network) -> Result<Xpriv> {
    let mn = Mnemonic::from_str(mnemonic).map_err(|e| anyhow!("bad mnemonic: {e}"))?;
    let seed = mn.to_seed("");
    Xpriv::new_master(network, &seed).map_err(|e| anyhow!("xpriv derivation: {e}"))
}
