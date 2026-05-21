use anyhow::Result;
use clap::Args as ClapArgs;
use ghostkey_core::vault::Vault;
use ghostkey_core::wallet::build_watch_only;
use std::path::Path;

use crate::state;

#[derive(Debug, ClapArgs)]
pub struct Args {}

pub fn run(profile_dir: &Path, _args: Args) -> Result<()> {
    let cfg = state::read_vault(profile_dir)?;
    let vault = Vault::from_config(cfg)?;
    let mut w = build_watch_only(&vault)?;
    let addr = w.reveal_next_address(bdk_wallet::KeychainKind::External);
    println!("address : {}", addr.address);
    println!("index   : {}", addr.index);
    println!("keychain: external");
    Ok(())
}
