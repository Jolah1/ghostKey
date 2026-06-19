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

use bitcoin::secp256k1::Secp256k1;
use ghostkey_core::keys::{account_xpub, descriptor_key_fragment, vault_account_path, Chain};
use ghostkey_core::psbt::{build_check_in, build_heir_claim};
use ghostkey_core::sweep::{sign_heir_sweep, sign_owner_sweep, ConfirmedTx};
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
                serde_json::Value::Bool(false), // disable_private_keys
                serde_json::Value::Bool(false), // blank
                serde_json::Value::String(String::new()), // passphrase
                serde_json::Value::Bool(false), // avoid_reuse
                serde_json::Value::Bool(true),  // descriptors
            ],
        );
        if create_res.is_err() {
            let _: serde_json::Value =
                bare.call("loadwallet", &[serde_json::Value::String(name.to_string())])?;
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
    assert!(
        funded.to_sat() > 0,
        "node should be funded after 101 blocks"
    );

    // 2. Construct the vault and a watch + owner-signing wallet pair.
    let (vault, owner_m, heir_m) = build_vault_and_keys()?;
    let mut watch = build_watch_only(&vault)?;
    let mut owner_w = build_signing(&vault, &owner_m)?;

    // Both wallets should reveal identical first vault addresses.
    let vault_addr_1 = watch.reveal_next_address(KeychainKind::External).address;
    let mirror = owner_w.reveal_next_address(KeychainKind::External).address;
    assert_eq!(
        vault_addr_1, mirror,
        "watch & owner-signing must agree on derivation"
    );
    println!("vault deposit addr = {vault_addr_1}");

    // 3. Fund the vault.
    let deposit = Amount::from_btc(0.5)?;
    let txid_fund =
        node_w.send_to_address(&vault_addr_1, deposit, None, None, None, None, None, None)?;
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
    println!(
        "after timelock mine, heir tip = {}",
        heir_w.latest_checkpoint().height()
    );
    let claim = build_heir_claim(&mut heir_w, &vault, &recipient, fee_rate())?;
    assert!(
        claim.finalized,
        "heir claim must finalize after timelock elapses"
    );
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

/// Manual-PSBT claim path (the one a Door B / own-key heir lands in):
/// is the unsigned PSBT the server hands out actually self-contained,
/// and can a descriptor-aware signer holding only the heir key finish it?
///
/// The server's `build_claim_psbt` builds from a **watch-only** wallet
/// (no private keys) and returns an unsigned PSBT for the heir to sign
/// in their own wallet. This test reproduces that exact path and then:
///
///  1. asserts the build is **not** finalized (watch-only has no keys),
///  2. decodes the PSBT with bitcoind and asserts the input carries the
///     tapscript leaf (`taproot_scripts`) and the key-origin derivation
///     (`taproot_bip32_derivs`) — i.e. the PSBT is self-contained, so the
///     only thing a signer must bring is the heir key + the ability to
///     satisfy our `or_d(pk,and_v(v:pk,older))` tapscript,
///  3. signs that same unsigned PSBT with a descriptor-aware signer that
///     holds the heir key (the model Bitcoin Core / the in-browser kit
///     follow) and broadcasts it — proving the unsigned PSBT is valid and
///     completable.
///
/// What it deliberately does NOT claim: that a wallet which refuses our
/// descriptor (Sparrow/Liana, per the restore drill) can sign it. The
/// barrier there is signer capability, not missing PSBT data — which is
/// exactly what assertion (2) pins down.
#[test]
#[ignore]
fn manual_psbt_claim_is_self_contained_and_signable() -> Result<()> {
    let net = Network::Regtest;
    let node = Bitcoind::spawn()?;
    let bare = node.client()?;
    let node_w = ensure_node_wallet(&node, "miner")?;
    mine_blocks(&node_w, 101)?;

    let (vault, _owner_m, heir_m) = build_vault_and_keys()?;

    // Fund the vault's first deposit address.
    let mut watch = build_watch_only(&vault)?;
    let deposit_addr = watch.reveal_next_address(KeychainKind::External).address;
    let deposit = Amount::from_btc(0.4)?;
    let _fund =
        node_w.send_to_address(&deposit_addr, deposit, None, None, None, None, None, None)?;
    mine_blocks(&node_w, 1)?;
    // Mature the relative timelock so the heir branch is spendable.
    mine_blocks(&node_w, TIMELOCK_BLOCKS.into())?;

    // ---- Reproduce the server's manual-PSBT build: WATCH-ONLY, no keys ----
    let mut server_watch = build_watch_only(&vault)?;
    let _ = sync_wallet(&mut server_watch, &bare)?;
    let recipient: Address = node_w
        .get_new_address(Some("heir-external"), Some(AddressType::Bech32))?
        .require_network(net)
        .map_err(|e| anyhow!("{e}"))?;
    let built = build_heir_claim(&mut server_watch, &vault, &recipient, fee_rate())?;
    assert!(
        !built.finalized,
        "watch-only server build must be unsigned — the heir's wallet supplies the signature"
    );
    // bitcoin::Psbt's Display impl is base64, matching what the server returns.
    let unsigned_b64 = built.psbt.to_string();

    // ---- (2) The PSBT must be SELF-CONTAINED ----
    let decoded: serde_json::Value = bare.call(
        "decodepsbt",
        &[serde_json::Value::String(unsigned_b64.clone())],
    )?;
    let input0 = &decoded["inputs"][0];
    let has_nonempty_array = |key: &str| -> bool {
        input0
            .get(key)
            .and_then(|v| v.as_array())
            .map(|a| !a.is_empty())
            .unwrap_or(false)
    };
    assert!(
        has_nonempty_array("taproot_scripts"),
        "unsigned PSBT input must carry the tapscript leaf (taproot_scripts); got: {input0}"
    );
    assert!(
        has_nonempty_array("taproot_bip32_derivs"),
        "unsigned PSBT input must carry key-origin derivations (taproot_bip32_derivs); got: {input0}"
    );
    println!("manual-psbt input is self-contained: taproot_scripts + taproot_bip32_derivs present");

    // ---- (3) A descriptor-aware signer holding the heir key finishes it ----
    let mut heir_signer = build_signing(&vault, &heir_m)?;
    let _ = sync_wallet(&mut heir_signer, &bare)?;
    let mut psbt: bitcoin::Psbt = unsigned_b64
        .parse()
        .map_err(|e| anyhow!("re-parse server psbt: {e}"))?;
    let finalized = heir_signer
        .sign(&mut psbt, bdk_wallet::SignOptions::default())
        .map_err(|e| anyhow!("heir sign: {e}"))?;
    assert!(
        finalized,
        "a descriptor-aware signer with the heir key must finalize the server's unsigned PSBT"
    );
    let claim_tx = psbt.extract_tx()?;
    broadcast_tx(&bare, &claim_tx)?;
    mine_blocks(&node_w, 1)?;
    let recv = received_by_address(&node_w, &recipient)?;
    assert!(
        recv > Amount::from_btc(0.399)?,
        "recipient should receive ~0.4 BTC minus fee from the externally-signed claim, got {recv}"
    );

    Ok(())
}

/// Offline sweep (issue #93): prove the recovery kit's signing path.
///
/// This is the same owner-spend and heir-claim as
/// `owner_checkin_then_heir_claim`, but built the way the browser kit
/// must: with **no chain sync**. We hand the signer only the funding
/// transactions (as the kit's JS would, fetched from an explorer), and it
/// must still produce a finished, broadcastable transaction — for the
/// owner branch immediately, and for the heir branch only after the
/// relative timelock has matured.
#[test]
#[ignore]
fn offline_sweep_owner_and_heir() -> Result<()> {
    let net = Network::Regtest;
    let node = Bitcoind::spawn()?;
    let bare = node.client()?;
    let node_w = ensure_node_wallet(&node, "miner")?;
    mine_blocks(&node_w, 101)?;

    let (vault, owner_m, heir_m) = build_vault_and_keys()?;
    let secp = Secp256k1::new();
    // The kit holds the BIP86 *account* key, not the master — derive it.
    let owner_acct = owner_m.derive_priv(&secp, &vault_account_path(net))?;
    let heir_acct = heir_m.derive_priv(&secp, &vault_account_path(net))?;

    // A watch-only wallet just to learn the vault's deposit addresses.
    let mut watch = build_watch_only(&vault)?;

    // ---- Owner offline sweep (spendable immediately) ----
    let deposit_addr = watch.reveal_next_address(KeychainKind::External).address;
    let deposit = Amount::from_btc(0.5)?;
    let fund_txid =
        node_w.send_to_address(&deposit_addr, deposit, None, None, None, None, None, None)?;
    let fund_height = mine_blocks(&node_w, 1)?;
    // The kit's JS would fetch this from an explorer; the node wallet has it.
    let funding_tx: bitcoin::Transaction =
        node_w.get_transaction(&fund_txid, None)?.transaction()?;

    let owner_dest: Address = node_w
        .get_new_address(Some("owner-sweep"), Some(AddressType::Bech32))?
        .require_network(net)
        .map_err(|e| anyhow!("{e}"))?;
    let swept = sign_owner_sweep(
        &vault,
        &owner_acct,
        vec![ConfirmedTx {
            tx: funding_tx,
            confirmation_height: fund_height,
        }],
        fund_height, // chain tip
        &owner_dest,
        None, // drain all
        fee_rate(),
    )?;
    println!(
        "owner offline sweep txid = {} (fee {})",
        swept.txid, swept.fee_sat
    );
    broadcast_tx(&bare, &swept.tx)?;
    mine_blocks(&node_w, 1)?;
    let recv = received_by_address(&node_w, &owner_dest)?;
    assert!(
        recv > Amount::from_btc(0.499)?,
        "owner offline sweep should deliver ~0.5 BTC minus fee, got {recv}"
    );

    // ---- Heir offline sweep (only valid after the timelock) ----
    let heir_vault_addr = watch.reveal_next_address(KeychainKind::External).address;
    let deposit2 = Amount::from_btc(0.3)?;
    let fund2_txid = node_w.send_to_address(
        &heir_vault_addr,
        deposit2,
        None,
        None,
        None,
        None,
        None,
        None,
    )?;
    let fund2_height = mine_blocks(&node_w, 1)?;
    let funding_tx2: bitcoin::Transaction =
        node_w.get_transaction(&fund2_txid, None)?.transaction()?;
    let funding2 = ConfirmedTx {
        tx: funding_tx2,
        confirmation_height: fund2_height,
    };

    let heir_dest: Address = node_w
        .get_new_address(Some("heir-sweep"), Some(AddressType::Bech32))?
        .require_network(net)
        .map_err(|e| anyhow!("{e}"))?;

    // Before maturity (tip == funding height, age 0): the signer may either
    // refuse to satisfy the timelock locally, or build a tx the network
    // rejects as non-BIP68-final. Both outcomes prove it can't be claimed
    // early.
    match sign_heir_sweep(
        &vault,
        &heir_acct,
        vec![funding2.clone()],
        fund2_height,
        &heir_dest,
        fee_rate(),
    ) {
        Ok(early) => {
            let early_res = broadcast_tx(&bare, &early.tx);
            assert!(
                early_res.is_err(),
                "pre-timelock heir sweep must be rejected, node accepted {}",
                early.txid
            );
            println!(
                "early heir offline sweep rejected by node as expected: {}",
                early_res.unwrap_err()
            );
        }
        Err(e) => println!("early heir offline sweep refused locally (also acceptable): {e}"),
    }

    // Age the UTXO past the timelock; now it must confirm.
    let tip = mine_blocks(&node_w, TIMELOCK_BLOCKS.into())?;
    let claim = sign_heir_sweep(
        &vault,
        &heir_acct,
        vec![funding2],
        tip,
        &heir_dest,
        fee_rate(),
    )?;
    println!(
        "heir offline sweep txid = {} (fee {})",
        claim.txid, claim.fee_sat
    );
    broadcast_tx(&bare, &claim.tx)?;
    mine_blocks(&node_w, 1)?;
    let recv2 = received_by_address(&node_w, &heir_dest)?;
    assert!(
        recv2 > Amount::from_btc(0.299)?,
        "heir offline sweep should deliver ~0.3 BTC minus fee, got {recv2}"
    );

    Ok(())
}

/// Emit a deterministic owner-sweep fixture for the wasm runtime test
/// (`ghostkey-wasm`). Run with `--ignored --nocapture` and capture the
/// JSON between the BEGIN/END markers. No node required: the funding tx is
/// fabricated (its inputs are irrelevant — the signer only references its
/// output by txid:vout, and signs against the real vault scriptPubKey).
#[test]
#[ignore]
fn emit_wasm_owner_fixture() -> Result<()> {
    use bitcoin::consensus::encode::serialize_hex;
    use bitcoin::hashes::Hash;
    use bitcoin::{
        transaction, Amount, OutPoint, Sequence, Transaction, TxIn, TxOut, Txid, Witness,
    };

    let net = Network::Regtest;
    let (vault, owner_m, _heir_m) = build_vault_and_keys()?;
    let secp = Secp256k1::new();
    let owner_acct = owner_m.derive_priv(&secp, &vault_account_path(net))?;

    let mut watch = build_watch_only(&vault)?;
    let deposit = watch.reveal_next_address(KeychainKind::External).address;
    let recipient = watch.reveal_next_address(KeychainKind::External).address;

    // Fabricate a funding tx paying the deposit address 100_000 sats.
    let funding = Transaction {
        version: transaction::Version::TWO,
        lock_time: bitcoin::absolute::LockTime::ZERO,
        // A non-null prevout so this isn't mistaken for a coinbase (whose
        // outputs carry a 100-block maturity and would read as unspendable).
        input: vec![TxIn {
            previous_output: OutPoint::new(Txid::from_byte_array([0x11; 32]), 0),
            script_sig: Default::default(),
            sequence: Sequence::ENABLE_RBF_NO_LOCKTIME,
            witness: Witness::new(),
        }],
        output: vec![TxOut {
            value: Amount::from_sat(100_000),
            script_pubkey: deposit.script_pubkey(),
        }],
    };
    let funding_hex = serialize_hex(&funding);

    let req = serde_json::json!({
        "role": "owner",
        "descriptor_external": vault.descriptor_for(Chain::External),
        "descriptor_internal": vault.descriptor_for(Chain::Internal),
        "timelock_blocks": vault.timelock_blocks(),
        "network": "regtest",
        "account_xprv": owner_acct.to_string(),
        "funding": [ { "tx_hex": funding_hex, "confirmation_height": 100u32 } ],
        "chain_tip_height": 105u32,
        "recipient": recipient.to_string(),
        "amount_sat": serde_json::Value::Null,
        "fee_rate_sat_vb": 2u64,
    });
    println!("WASM_FIXTURE_BEGIN");
    println!("{}", serde_json::to_string(&req)?);
    println!("WASM_FIXTURE_END");
    Ok(())
}

fn broadcast_tx(rpc: &Client, tx: &bitcoin::Transaction) -> Result<bitcoin::Txid> {
    use bitcoin::consensus::encode::serialize_hex;
    let raw = serialize_hex(tx);
    let txid: bitcoin::Txid = rpc.call("sendrawtransaction", &[serde_json::Value::String(raw)])?;
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
