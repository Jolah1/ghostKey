use anyhow::Result;
use bitcoin::Network;
use clap::Args as ClapArgs;
use ghostkey_core::keys::{account_xpub, descriptor_key_fragment, Chain};
use std::path::Path;

use crate::commands::master_xpriv;
use crate::state;

#[derive(Debug, ClapArgs)]
pub struct Args {
    /// Network the xpub is for.
    #[arg(long, default_value = "regtest")]
    pub network: Network,
}

pub fn run(profile_dir: &Path, args: Args) -> Result<()> {
    let mn = state::read_mnemonic(profile_dir)?;
    let master = master_xpriv(&mn, args.network)?;
    let (fp, path, xpub) = account_xpub(&master, args.network)?;
    let ext = descriptor_key_fragment(fp, &path, &xpub, Chain::External);
    let int_ = descriptor_key_fragment(fp, &path, &xpub, Chain::Internal);

    println!("network        : {:?}", args.network);
    println!("fingerprint    : {}", fp);
    println!("account_path   : m/{}", path);
    println!("account_xpub   : {}", xpub);
    println!();
    println!("Share BOTH fragments below with your counterparty:");
    println!("external (recv): {}", ext);
    println!("internal (chg) : {}", int_);
    Ok(())
}
