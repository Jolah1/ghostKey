//! Chain sync via bitcoind JSON-RPC.

use anyhow::{Context, Result};
use bdk_bitcoind_rpc::Emitter;
use bdk_wallet::Wallet;
use bitcoincore_rpc::{Auth, Client, RpcApi};

#[derive(Debug, Clone)]
pub struct RpcConfig {
    pub url: String,
    pub user: String,
    pub pass: String,
}

impl RpcConfig {
    pub fn new(url: String, user: String, pass: String) -> Self {
        Self { url, user, pass }
    }

    pub fn connect(&self) -> Result<Client> {
        Client::new(&self.url, Auth::UserPass(self.user.clone(), self.pass.clone()))
            .with_context(|| format!("connecting to bitcoind at {}", self.url))
    }
}

/// Sync `wallet` against `rpc` from `start_height`. Returns the new tip
/// height the wallet has been advanced to.
///
/// We always re-emit mempool at the end so that an in-flight check-in or
/// claim tx is visible in `wallet.balance()` immediately.
pub fn sync_wallet(wallet: &mut Wallet, rpc: &Client, start_height: u32) -> Result<u32> {
    // Sanity: refuse to mix networks. `chain_info.chain` is `bitcoin::Network`.
    let chain_info = rpc.get_blockchain_info()?;
    let expected = wallet.network();
    let actual = chain_info.chain;
    if expected != actual {
        anyhow::bail!(
            "wallet network {:?} does not match bitcoind chain {:?}",
            expected,
            actual
        );
    }

    let cp = wallet.latest_checkpoint();
    let mut emitter = Emitter::new(rpc, cp, start_height);

    while let Some(ev) = emitter.next_block()? {
        wallet
            .apply_block_connected_to(&ev.block, ev.block_height(), ev.connected_to())
            .context("apply_block_connected_to")?;
    }

    let mempool = emitter.mempool()?;
    wallet.apply_unconfirmed_txs(mempool.into_iter().map(|(t, ts)| (t, ts)));

    let tip = wallet.latest_checkpoint().height();
    Ok(tip)
}

pub fn broadcast_tx(rpc: &Client, tx: &bitcoin::Transaction) -> Result<bitcoin::Txid> {
    use bitcoin::consensus::encode::serialize_hex;
    let raw = serialize_hex(tx);
    let txid: bitcoin::Txid = rpc
        .call("sendrawtransaction", &[serde_json::Value::String(raw)])
        .context("sendrawtransaction")?;
    Ok(txid)
}
