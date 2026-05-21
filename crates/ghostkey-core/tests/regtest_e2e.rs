//! End-to-end regtest integration test.
//!
//! This test is `#[ignore]` and opt-in. Run with:
//!
//! ```sh
//! cargo test -p ghostkey-core --test regtest_e2e -- --ignored --nocapture
//! ```
//!
//! Requires `bitcoind` (v25+) on `PATH`. The test:
//!
//! 1. Spawns bitcoind in regtest in a temp dir on an ephemeral port.
//! 2. Mines 101 blocks to a node-owned address so it has spendable coin.
//! 3. Builds an owner-side `Vault` + signing wallet, reveals a vault
//!    address.
//! 4. Sends 0.5 BTC from the node to the vault address; mines a block.
//! 5. Syncs the watch-only wallet; asserts the vault balance is non-zero.
//! 6. Owner builds + broadcasts a check-in tx; mines a block; asserts
//!    the vault sees the new (fresh) UTXO at a higher height.
//! 7. Builds the heir claim *before* the timelock elapses — must fail
//!    (PSBT not finalizable).
//! 8. Mines `timelock_blocks` extra blocks; heir claim succeeds; tx is
//!    mined; asserts a known recipient address received the funds.

#![cfg(test)]

use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context, Result};
use bdk_bitcoind_rpc::Emitter;
use bdk_wallet::{KeychainKind, Wallet};
use bitcoin::bip32::Xpriv;
use bitcoin::{Address, Amount, FeeRate, Network};
use bitcoincore_rpc::json::AddressType;
use bitcoincore_rpc::{Auth, Client, RpcApi};

use ghostkey_core::keys::{account_xpub, descriptor_key_fragment, Chain};
use ghostkey_core::psbt::{build_check_in, build_heir_claim};
use ghostkey_core::vault::{Vault, VaultRole};
use ghostkey_core::wallet::{build_signing, build_watch_only};

const TIMELOCK_BLOCKS: u32 = 5;
const FEERATE_SAT_VB: u64 = 2;

struct Bitcoind {
    child: Child,
    rpc_port: u16,
    _tmp: tempfile::TempDir,
    user: String,
    pass: String,
}

impl Bitcoind {
    fn spawn() -> Result<Self> {
        let tmp = tempfile::tempdir()?;
        let datadir = tmp.path().to_path_buf();
        // Pick a port unlikely to collide.
        let rpc_port: u16 = pick_port()?;
        let p2p_port: u16 = pick_port()?;
        let user = "ghostkey".to_string();
        let pass = format!("p{}", std::process::id());

        let mut cmd = Command::new("bitcoind");
        cmd.arg(format!("-datadir={}", datadir.display()))
            .arg("-regtest=1")
            .arg("-server=1")
            .arg("-daemon=0")
            .arg("-listen=0")
            .arg("-fallbackfee=0.0002")
            .arg("-deprecatedrpc=create_bdb")
            .arg(format!("-rpcuser={}", user))
            .arg(format!("-rpcpassword={}", pass))
            .arg(format!("-rpcport={}", rpc_port))
            .arg(format!("-port={}", p2p_port))
            // Cut log noise.
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let child = cmd
            .spawn()
            .context("failed to spawn bitcoind; is it on PATH?")?;

        let me = Self {
            child,
            rpc_port,
            _tmp: tmp,
            user,
            pass,
        };
        me.wait_ready()?;
        Ok(me)
    }

    fn rpc_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.rpc_port)
    }

    fn auth(&self) -> Auth {
        Auth::UserPass(self.user.clone(), self.pass.clone())
    }

    fn client(&self) -> Result<Client> {
        Client::new(&self.rpc_url(), self.auth()).context("connecting to test bitcoind")
    }

    /// Wait until the RPC is responsive. Bitcoind on a slow CI can take
    /// several seconds to come up.
    fn wait_ready(&self) -> Result<()> {
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            if let Ok(c) = self.client() {
                if c.get_blockchain_info().is_ok() {
                    return Ok(());
                }
            }
            if Instant::now() > deadline {
                bail!("bitcoind did not become ready within 30s");
            }
            std::thread::sleep(Duration::from_millis(200));
        }
    }
}

impl Drop for Bitcoind {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn pick_port() -> Result<u16> {
    let l = std::net::TcpListener::bind("127.0.0.1:0")?;
    let port = l.local_addr()?.port();
    drop(l);
    Ok(port)
}

/// Connect to a node-managed wallet, creating it if necessary. We need
/// the node to hold spendable coin (it can mine to its own address) so
/// we can send to the vault.
fn ensure_node_wallet(node: &Bitcoind, name: &str) -> Result<Client> {
    // The bare client (no wallet path) is what we use for chain RPCs.
    let bare = node.client()?;
    let wallets: Vec<String> = bare.list_wallets()?;
    if !wallets.iter().any(|w| w == name) {
        // Try createwallet; if it already exists on disk just load.
        let create_res: Result<serde_json::Value, _> = bare.call(
            "createwallet",
            &[
                serde_json::Value::String(name.to_string()),
                serde_json::Value::Bool(false),       // disable_private_keys
                serde_json::Value::Bool(false),       // blank
                serde_json::Value::String(String::new()), // passphrase
                serde_json::Value::Bool(false),       // avoid_reuse
                serde_json::Value::Bool(true),        // descriptors
            ],
        );
        if create_res.is_err() {
            let _: serde_json::Value = bare.call("loadwallet", &[serde_json::Value::String(name.to_string())])?;
        }
    }
    // Return a wallet-scoped RPC client.
    let url = format!("{}/wallet/{}", node.rpc_url(), name);
    Client::new(&url, node.auth()).context("connecting to test wallet")
}

/// Mine `n` blocks to a node-controlled address. Returns the new tip
/// height.
fn mine_blocks(node_wallet: &Client, n: u64) -> Result<u32> {
    let addr = node_wallet
        .get_new_address(None, Some(AddressType::Bech32))?
        .require_network(Network::Regtest)
        .map_err(|e| anyhow!("{e}"))?;
    let _ = node_wallet.generate_to_address(n, &addr)?;
    let tip = node_wallet.get_block_count()? as u32;
    Ok(tip)
}

/// Sync a BDK wallet against the node's full history.
fn sync_wallet(w: &mut Wallet, rpc: &Client) -> Result<u32> {
    let cp = w.latest_checkpoint();
    let mut emitter = Emitter::new(rpc, cp, 0);
    while let Some(ev) = emitter.next_block()? {
        w.apply_block_connected_to(&ev.block, ev.block_height(), ev.connected_to())?;
    }
    let mempool = emitter.mempool()?;
    w.apply_unconfirmed_txs(mempool);
    Ok(w.latest_checkpoint().height())
}

fn build_vault_and_keys() -> Result<(Vault, Xpriv, Xpriv)> {
    let net = Network::Regtest;
    // Deterministic seeds — fine for a regtest test.
    let owner_m = Xpriv::new_master(net, &[0xA1; 32])?;
    let heir_m = Xpriv::new_master(net, &[0xB2; 32])?;
    let (ofp, op, ox) = account_xpub(&owner_m, net)?;
    let (hfp, hp, hx) = account_xpub(&heir_m, net)?;
    let vault = Vault::new(
        &descriptor_key_fragment(ofp, &op, &ox, Chain::External),
        &descriptor_key_fragment(ofp, &op, &ox, Chain::Internal),
        &descriptor_key_fragment(hfp, &hp, &hx, Chain::External),
        &descriptor_key_fragment(hfp, &hp, &hx, Chain::Internal),
        TIMELOCK_BLOCKS,
        net,
        VaultRole::Owner,
        Some("regtest-e2e".into()),
    )?;
    Ok((vault, owner_m, heir_m))
}

fn fee_rate() -> FeeRate {
    FeeRate::from_sat_per_vb(FEERATE_SAT_VB).expect("static fee rate")
}

#[test]
#[ignore]
fn owner_checkin_then_heir_claim() -> Result<()> {
    // 1. Bring up a regtest node and prime it with spendable coin.
    let node = Bitcoind::spawn()?;
    let bare = node.client()?;
    let node_w = ensure_node_wallet(&node, "miner")?;
    mine_blocks(&node_w, 101)?;
    let funded = node_w.get_balance(None, None)?;
    assert!(funded.to_sat() > 0, "node should be funded after 101 blocks");

    // 2. Construct the vault and a watch + owner-signing wallet pair.
    let (vault, owner_m, heir_m) = build_vault_and_keys()?;
    let mut watch = build_watch_only(&vault)?;
    let mut owner_w = build_signing(&vault, &owner_m)?;

    // Both wallets should reveal identical first vault addresses.
    let vault_addr_1 = watch.reveal_next_address(KeychainKind::External).address;
    let mirror = owner_w.reveal_next_address(KeychainKind::External).address;
    assert_eq!(vault_addr_1, mirror, "watch & owner-signing must agree on derivation");
    println!("vault deposit addr = {vault_addr_1}");

    // 3. Fund the vault.
    let deposit = Amount::from_btc(0.5)?;
    let txid_fund = node_w.send_to_address(&vault_addr_1, deposit, None, None, None, None, None, None)?;
    println!("deposit txid = {txid_fund}");
    mine_blocks(&node_w, 1)?;

    // 4. Sync the owner wallet and confirm the vault sees the UTXO.
    let tip = sync_wallet(&mut owner_w, &bare)?;
    println!("synced to tip = {tip}");
    let bal_after_fund = owner_w.balance();
    assert_eq!(
        bal_after_fund.confirmed, deposit,
        "vault should hold exactly the deposit after 1 confirmation"
    );

    // 5. Owner check-in: drain to a fresh vault address, broadcast.
    let built = build_check_in(&mut owner_w, fee_rate())?;
    assert!(built.finalized, "owner check-in PSBT must finalize");
    let checkin_tx = built.psbt.extract_tx()?;
    let checkin_txid = checkin_tx.compute_txid();
    println!("check-in txid = {checkin_txid}");
    broadcast_tx(&bare, &checkin_tx)?;
    mine_blocks(&node_w, 1)?;

    let _ = sync_wallet(&mut owner_w, &bare)?;
    let bal_after_checkin = owner_w.balance();
    assert!(
        bal_after_checkin.confirmed < deposit,
        "fee should have been paid, balance must have dropped"
    );
    assert!(
        bal_after_checkin.confirmed > deposit - Amount::from_sat(10_000),
        "fee should be small at {} sat/vB; got drop {}",
        FEERATE_SAT_VB,
        deposit - bal_after_checkin.confirmed
    );

    // 6. Build heir wallet & try to claim immediately. BDK may happily
    //    *finalize* the PSBT locally (the cryptographic witnesses are
    //    valid), but the chain MUST reject the broadcast: every input's
    //    `nSequence = TIMELOCK_BLOCKS` while the UTXO has only 1
    //    confirmation, so mempool's BIP68 check fails.
    let mut heir_w = build_signing(&vault, &heir_m)?;
    let _ = sync_wallet(&mut heir_w, &bare)?;
    let recipient: Address = node_w
        .get_new_address(Some("heir-payout"), Some(AddressType::Bech32))?
        .require_network(Network::Regtest)
        .map_err(|e| anyhow!("{e}"))?;
    match build_heir_claim(&mut heir_w, &vault, &recipient, fee_rate()) {
        Ok(early) => {
            let early_tx = early.psbt.extract_tx()?;
            let early_res = broadcast_tx(&bare, &early_tx);
            assert!(
                early_res.is_err(),
                "node must reject pre-timelock heir claim, but it accepted {}",
                early_tx.compute_txid()
            );
            println!(
                "early heir claim rejected by node as expected: {}",
                early_res.unwrap_err()
            );
        }
        Err(e) => {
            println!("early heir claim errored locally (also acceptable): {e}");
        }
    }

    // 7. Mine the timelock and try again — this time it must succeed.
    mine_blocks(&node_w, TIMELOCK_BLOCKS.into())?;
    let _ = sync_wallet(&mut heir_w, &bare)?;
    println!("after timelock mine, heir tip = {}", heir_w.latest_checkpoint().height());
    let claim = build_heir_claim(&mut heir_w, &vault, &recipient, fee_rate())?;
    assert!(claim.finalized, "heir claim must finalize after timelock elapses");
    let claim_tx = claim.psbt.extract_tx()?;
    let claim_txid = claim_tx.compute_txid();
    println!("claim txid = {claim_txid}");
    broadcast_tx(&bare, &claim_tx)?;
    mine_blocks(&node_w, 1)?;

    // 8. Recipient must now own the (deposit - fees) on chain.
    let received_total = received_by_address(&node_w, &recipient)?;
    assert!(
        received_total > Amount::from_btc(0.499)?,
        "recipient should have received ~0.5 BTC minus fees, got {received_total}"
    );

    // And the vault must be empty post-claim.
    let _ = sync_wallet(&mut owner_w, &bare)?;
    assert_eq!(
        owner_w.balance().confirmed,
        Amount::ZERO,
        "vault must be fully drained after heir claim"
    );

    Ok(())
}

fn broadcast_tx(rpc: &Client, tx: &bitcoin::Transaction) -> Result<bitcoin::Txid> {
    use bitcoin::consensus::encode::serialize_hex;
    let raw = serialize_hex(tx);
    let txid: bitcoin::Txid = rpc.call(
        "sendrawtransaction",
        &[serde_json::Value::String(raw)],
    )?;
    Ok(txid)
}

fn received_by_address(wallet_rpc: &Client, addr: &Address) -> Result<Amount> {
    // Bitcoin Core v23+: getreceivedbyaddress works for watch-only too.
    let v: serde_json::Value = wallet_rpc.call(
        "getreceivedbyaddress",
        &[
            serde_json::Value::String(addr.to_string()),
            serde_json::Value::Number(0.into()), // minconf
        ],
    )?;
    let btc = v.as_f64().ok_or_else(|| anyhow!("not a number"))?;
    Ok(Amount::from_btc(btc)?)
}
