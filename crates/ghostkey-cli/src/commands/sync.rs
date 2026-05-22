use anyhow::Result;
use clap::Args as ClapArgs;
use ghostkey_core::vault::Vault;
use ghostkey_core::wallet::build_watch_only;
use std::path::Path;

use crate::chain::{sync_wallet, RpcConfig};
use crate::state;

#[derive(Debug, ClapArgs)]
pub struct Args {
    /// bitcoind RPC URL (e.g. http://127.0.0.1:18443 for regtest).
    #[arg(long, env = "BITCOIND_RPC_URL")]
    pub rpc_url: String,
    /// RPC user.
    #[arg(long, env = "BITCOIND_RPC_USER")]
    pub rpc_user: String,
    /// RPC password.
    #[arg(long, env = "BITCOIND_RPC_PASS")]
    pub rpc_pass: String,
    /// Height to start emitting blocks from on a fresh sync.
    #[arg(long, default_value_t = 0)]
    pub start_height: u32,
}

pub fn run(profile_dir: &Path, args: Args) -> Result<()> {
    let cfg = state::read_vault(profile_dir)?;
    let vault = Vault::from_config(cfg)?;
    let mut w = build_watch_only(&vault)?;

    let rpc = RpcConfig::new(args.rpc_url, args.rpc_user, args.rpc_pass).connect()?;

    let prev = state::read_wallet_state(profile_dir)?;
    let start = prev
        .as_ref()
        .map(|s| s.last_synced_height)
        .unwrap_or(args.start_height);

    let tip = sync_wallet(&mut w, &rpc, start)?;

    let best = w.latest_checkpoint().hash();
    state::write_wallet_state(
        profile_dir,
        &state::WalletState {
            last_synced_height: tip,
            best_block_hash: best,
            network: vault.network(),
        },
    )?;
    println!("synced to height {} ({})", tip, best);
    Ok(())
}
