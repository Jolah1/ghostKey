use anyhow::{anyhow, bail, Result};
use bitcoin::{Address, FeeRate};
use clap::Args as ClapArgs;
use ghostkey_core::psbt::build_heir_claim;
use ghostkey_core::vault::{Vault, VaultRole};
use ghostkey_core::wallet::build_signing;
use std::path::Path;
use std::str::FromStr;

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
    /// Destination address controlled by the heir.
    #[arg(long)]
    pub to: String,
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
    if vault.role() != VaultRole::Heir {
        bail!(
            "claim requires the heir profile (this vault is role={:?})",
            vault.role()
        );
    }

    let recipient: Address = Address::from_str(&args.to)
        .map_err(|e| anyhow!("bad address: {e}"))?
        .require_network(vault.network())
        .map_err(|e| anyhow!("address network mismatch: {e}"))?;

    let mn = state::read_mnemonic(profile_dir)?;
    let master = master_xpriv(&mn, vault.network())?;
    let mut w = build_signing(&vault, &master)?;

    let rpc = RpcConfig::new(args.rpc_url, args.rpc_user, args.rpc_pass).connect()?;
    let start = state::read_wallet_state(profile_dir)?
        .map(|s| s.last_synced_height)
        .unwrap_or(0);
    let tip = sync_wallet(&mut w, &rpc, start)?;
    tracing::info!(tip, "synced before claim");

    let fee_rate =
        FeeRate::from_sat_per_vb(args.feerate_sat_vb).ok_or_else(|| anyhow!("bad fee rate"))?;
    let built = build_heir_claim(&mut w, &vault, &recipient, fee_rate)?;
    if !built.finalized {
        bail!("PSBT not fully signed (possibly the timelock hasn't elapsed for every UTXO yet)");
    }

    let tx = built.psbt.extract_tx()?;
    let txid = tx.compute_txid();
    if args.no_broadcast {
        println!("built claim tx {} (not broadcast)", txid);
        return Ok(());
    }
    let broadcast = broadcast_tx(&rpc, &tx)?;
    println!("broadcast claim tx {}", broadcast);
    Ok(())
}
