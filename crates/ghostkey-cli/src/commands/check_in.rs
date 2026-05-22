use anyhow::{bail, Result};
use bitcoin::FeeRate;
use clap::Args as ClapArgs;
use ghostkey_core::psbt::build_check_in;
use ghostkey_core::vault::{Vault, VaultRole};
use ghostkey_core::wallet::build_signing;
use std::path::Path;

use crate::chain::{broadcast_tx, sync_wallet, RpcConfig};
use crate::commands::master_xpriv;
use crate::state;

#[derive(Debug, ClapArgs)]
pub struct Args {
    #[arg(long, env = "BITCOIND_RPC_URL")]
    pub rpc_url: String,
    #[arg(long, env = "BITCOIND_RPC_USER")]
    pub rpc_user: String,
    #[arg(long, env = "BITCOIND_RPC_PASS")]
    pub rpc_pass: String,
    /// Fee rate in sat/vB.
    #[arg(long, default_value_t = 2)]
    pub feerate_sat_vb: u64,
    /// Only build/sign the PSBT; do not broadcast.
    #[arg(long)]
    pub no_broadcast: bool,
}

pub fn run(profile_dir: &Path, args: Args) -> Result<()> {
    let cfg = state::read_vault(profile_dir)?;
    let vault = Vault::from_config(cfg)?;
    if vault.role() != VaultRole::Owner {
        bail!(
            "check-in requires the owner profile (this vault is role={:?})",
            vault.role()
        );
    }

    let mn = state::read_mnemonic(profile_dir)?;
    let master = master_xpriv(&mn, vault.network())?;
    let mut w = build_signing(&vault, &master)?;

    let rpc = RpcConfig::new(args.rpc_url, args.rpc_user, args.rpc_pass).connect()?;
    let start = state::read_wallet_state(profile_dir)?
        .map(|s| s.last_synced_height)
        .unwrap_or(0);
    let tip = sync_wallet(&mut w, &rpc, start)?;
    tracing::info!(tip, "synced before check-in");

    let fee_rate = FeeRate::from_sat_per_vb(args.feerate_sat_vb)
        .ok_or_else(|| anyhow::anyhow!("bad fee rate"))?;
    let built = build_check_in(&mut w, fee_rate)?;
    if !built.finalized {
        bail!("PSBT not fully signed; aborting check-in");
    }

    let tx = built.psbt.extract_tx()?;
    let txid = tx.compute_txid();
    if args.no_broadcast {
        println!("built check-in tx {} (not broadcast)", txid);
        return Ok(());
    }
    let broadcast = broadcast_tx(&rpc, &tx)?;
    println!("broadcast check-in tx {}", broadcast);
    Ok(())
}
