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
    let w = build_watch_only(&vault)?;

    let bal = w.balance();
    println!("network         : {:?}", vault.network());
    println!("timelock_blocks : {}", vault.timelock_blocks());
    println!("confirmed       : {} sat", bal.confirmed.to_sat());
    println!("trusted_pending : {} sat", bal.trusted_pending.to_sat());
    println!("untrusted_pend. : {} sat", bal.untrusted_pending.to_sat());
    println!("immature        : {} sat", bal.immature.to_sat());
    println!("total           : {} sat", bal.total().to_sat());

    if let Some(s) = state::read_wallet_state(profile_dir)? {
        println!("last_sync_height: {}", s.last_synced_height);
    }
    Ok(())
}
