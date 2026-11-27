//! SPIKE: a "locked goal" vault (#94 follow-up). Not production code.
//!
//! Proves, on a real regtest node with a fake clock, that a Taproot vault
//! with two date-locked leaves works end to end:
//!
//!   tr(NUMS, { and_v(v:pk(OWNER), after(T_OWNER)),
//!              and_v(v:pk(HEIR),  after(T_HEIR)) })
//!
//! 1. The descriptor compiles in miniscript and loads in BDK.
//! 2. An owner spend before T_OWNER is refused by the node (non-final).
//! 3. The same signed transaction is accepted once the chain's median
//!    time passes T_OWNER.
//! 4. An heir spend is refused after T_OWNER but before T_HEIR, and
//!    accepted after T_HEIR.
//! 5. Bitcoin Core, given the owner's descriptor, can spend after T_OWNER.
//!
//! Run: cargo test -p ghostkey-core --test locked_spike -- --ignored --nocapture

#![cfg(test)]

use std::collections::BTreeMap;
use std::process::{Child, Command, Stdio};
use std::str::FromStr;
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context, Result};
use bdk_bitcoind_rpc::Emitter;
use bdk_wallet::descriptor::policy::{Policy, SatisfiableItem};
use bdk_wallet::{KeychainKind, SignOptions, Wallet};
use bitcoin::bip32::{DerivationPath, Xpriv, Xpub};
use bitcoin::secp256k1::Secp256k1;
use bitcoin::{Address, Amount, FeeRate, Network};
use bitcoincore_rpc::json::AddressType;
use bitcoincore_rpc::{Auth, Client, RpcApi};
use serde_json::{json, Value};

use ghostkey_core::descriptor::UNSPENDABLE_NUMS_XONLY;

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

struct Keys {
    /// `[fp/86'/1'/0']tprv...` (signing) and `[fp/86'/1'/0']tpub...` (public).
    xprv: String,
    xpub: String,
}

fn account(seed: u8) -> Result<Keys> {
    let secp = Secp256k1::new();
    let m = Xpriv::new_master(Network::Regtest, &[seed; 32])?;
    let fp = m.fingerprint(&secp);
    let path = DerivationPath::from_str("m/86'/1'/0'")?;
    let acct = m.derive_priv(&secp, &path)?;
    let pubk = Xpub::from_priv(&secp, &acct);
    Ok(Keys {
        xprv: format!("[{fp}/86'/1'/0']{acct}"),
        xpub: format!("[{fp}/86'/1'/0']{pubk}"),
    })
}

/// One chain (0 = receive, 1 = change) of the locked-goal descriptor.
fn locked_desc(owner: &str, heir: &str, chain: u32, t_owner: u32, t_heir: u32) -> String {
    format!(
        "tr({UNSPENDABLE_NUMS_XONLY},{{and_v(v:pk({owner}/{chain}/*),after({t_owner})),and_v(v:pk({heir}/{chain}/*),after({t_heir}))}})"
    )
}

fn wallet(ext: String, int: String) -> Result<Wallet> {
    Wallet::create(ext, int)
        .network(Network::Regtest)
        .create_wallet_no_persist()
        .map_err(|e| anyhow!("{e}"))
}

/// The policy path that reaches the leaf this wallet can sign: at every
/// 1-of-n junction, take the child whose subtree holds a signature this
/// wallet contributes to.
fn path_to_my_leaf(policy: &Policy) -> BTreeMap<String, Vec<usize>> {
    fn mine(p: &Policy) -> bool {
        match &p.item {
            SatisfiableItem::SchnorrSignature(_) => !matches!(
                p.contribution,
                bdk_wallet::descriptor::policy::Satisfaction::None
            ),
            SatisfiableItem::Thresh { items, .. } => items.iter().any(mine),
            _ => false,
        }
    }
    fn walk(p: &Policy, out: &mut BTreeMap<String, Vec<usize>>) {
        if let SatisfiableItem::Thresh { items, threshold } = &p.item {
            let chosen: Vec<usize> = if *threshold > 1 {
                (0..items.len()).collect()
            } else {
                (0..items.len())
                    .filter(|&i| mine(&items[i]))
                    .take(1)
                    .collect()
            };
            out.insert(p.id.clone(), chosen.clone());
            for i in chosen {
                walk(&items[i], out);
            }
        }
    }
    let mut out = BTreeMap::new();
    walk(policy, &mut out);
    out
}

/// Build and sign a spend of everything this wallet holds to `to`.
fn signed_sweep(w: &mut Wallet, to: &Address) -> Result<bitcoin::Transaction> {
    let ext = w
        .policies(KeychainKind::External)?
        .ok_or_else(|| anyhow!("no policy"))?;
    let int = w
        .policies(KeychainKind::Internal)?
        .ok_or_else(|| anyhow!("no policy"))?;
    let (pe, pi) = (path_to_my_leaf(&ext), path_to_my_leaf(&int));
    let mut b = w.build_tx();
    b.drain_wallet()
        .drain_to(to.script_pubkey())
        .fee_rate(FeeRate::from_sat_per_vb(2).unwrap())
        .policy_path(pe, KeychainKind::External)
        .policy_path(pi, KeychainKind::Internal);
    let mut psbt = b.finish().map_err(|e| anyhow!("build: {e}"))?;
    println!(
        "  built: nLockTime={} sequence={:?}",
        psbt.unsigned_tx.lock_time,
        psbt.unsigned_tx
            .input
            .iter()
            .map(|i| i.sequence)
            .collect::<Vec<_>>()
    );
    let done = w
        .sign(&mut psbt, SignOptions::default())
        .map_err(|e| anyhow!("sign: {e}"))?;
    if !done {
        bail!("BDK could not finalize the spend");
    }
    let tx = psbt.extract_tx()?;
    println!(
        "  size: {} inputs, {} outputs, {} vB",
        tx.input.len(),
        tx.output.len(),
        tx.vsize()
    );
    Ok(tx)
}

fn broadcast(
    rpc: &Client,
    tx: &bitcoin::Transaction,
) -> std::result::Result<bitcoin::Txid, String> {
    rpc.send_raw_transaction(tx).map_err(|e| e.to_string())
}

fn mtp(rpc: &Client) -> Result<u64> {
    let v: Value = rpc.call("getblockchaininfo", &[])?;
    v["mediantime"]
        .as_u64()
        .ok_or_else(|| anyhow!("no mediantime"))
}

/// Move the node's clock forward a block at a time until the chain's
/// median time is past `t`.
fn advance_past(rpc: &Client, node_wallet: &Client, clock: &mut u64, t: u64) -> Result<()> {
    while mtp(rpc)? <= t {
        *clock += 600;
        let _: Value = rpc.call("setmocktime", &[json!(*clock)])?;
        mine_blocks(node_wallet, 1)?;
    }
    Ok(())
}

fn fund(node_wallet: &Client, addr: &Address, sats: u64) -> Result<()> {
    node_wallet.send_to_address(
        addr,
        Amount::from_sat(sats),
        None,
        None,
        None,
        None,
        None,
        None,
    )?;
    Ok(())
}

#[test]
#[ignore]
fn locked_goal_end_to_end() -> Result<()> {
    let node = Bitcoind::spawn()?;
    let rpc = node.client()?;
    let miner = ensure_node_wallet(&node, "miner")?;
    mine_blocks(&miner, 101)?;

    // A fake clock we control. Block times follow it.
    let mut clock: u64 = mtp(&rpc)? + 3_600;
    let _: Value = rpc.call("setmocktime", &[json!(clock)])?;
    let t_owner = (clock + 6 * 3_600) as u32; // "unlock date"
    let t_heir = (clock + 12 * 3_600) as u32; // unlock date + the wait

    let owner = account(0xA1)?;
    let heir = account(0xB2)?;

    // 1. Compiles and loads: owner's signing wallet, heir's signing wallet.
    let mut ow = wallet(
        locked_desc(&owner.xprv, &heir.xpub, 0, t_owner, t_heir),
        locked_desc(&owner.xprv, &heir.xpub, 1, t_owner, t_heir),
    )?;
    let mut hw = wallet(
        locked_desc(&owner.xpub, &heir.xprv, 0, t_owner, t_heir),
        locked_desc(&owner.xpub, &heir.xprv, 1, t_owner, t_heir),
    )?;
    println!(
        "descriptor: {}",
        locked_desc(&owner.xpub, &heir.xpub, 0, t_owner, t_heir)
    );

    // Fund two separate deposits.
    let a0 = ow.reveal_next_address(KeychainKind::External).address;
    let a1 = ow.reveal_next_address(KeychainKind::External).address;
    let _ = hw.reveal_next_address(KeychainKind::External);
    let _ = hw.reveal_next_address(KeychainKind::External);
    fund(&miner, &a0, 100_000)?;
    fund(&miner, &a1, 60_000)?;
    mine_blocks(&miner, 1)?;
    sync_wallet(&mut ow, &rpc)?;
    sync_wallet(&mut hw, &rpc)?;
    println!(
        "funded: owner wallet sees {} sat",
        ow.balance().confirmed.to_sat()
    );

    let dest = miner
        .get_new_address(None, Some(AddressType::Bech32m))?
        .require_network(Network::Regtest)
        .map_err(|e| anyhow!("{e}"))?;

    // 2. Owner before the date: signed fine, refused by the network.
    println!("owner spend before the unlock date:");
    let early = signed_sweep(&mut ow, &dest)?;
    match broadcast(&rpc, &early) {
        Ok(_) => bail!("an owner spend before the unlock date was ACCEPTED"),
        Err(e) => println!("  refused as expected: {e}"),
    }

    // 3. Past the unlock date: the same transaction goes through.
    advance_past(&rpc, &miner, &mut clock, t_owner as u64)?;
    println!("after the unlock date (mtp {} > {t_owner}):", mtp(&rpc)?);
    let id =
        broadcast(&rpc, &early).map_err(|e| anyhow!("owner spend after unlock refused: {e}"))?;
    println!("  owner spend accepted: {id}");
    mine_blocks(&miner, 1)?;

    // Fresh deposit for the heir test (the owner just swept the others).
    fund(&miner, &a0, 70_000)?;
    mine_blocks(&miner, 1)?;
    sync_wallet(&mut hw, &rpc)?;

    // 4. Heir after the owner's date but before the heir date: refused.
    println!("heir claim before the heir date:");
    let heir_tx = signed_sweep(&mut hw, &dest)?;
    match broadcast(&rpc, &heir_tx) {
        Ok(_) => bail!("an heir claim before the heir date was ACCEPTED"),
        Err(e) => println!("  refused as expected: {e}"),
    }
    advance_past(&rpc, &miner, &mut clock, t_heir as u64)?;
    let id =
        broadcast(&rpc, &heir_tx).map_err(|e| anyhow!("heir claim after its date refused: {e}"))?;
    println!("  heir claim accepted after the heir date: {id}");
    mine_blocks(&miner, 1)?;

    // 5. Bitcoin Core: import the owner's descriptor and spend with it.
    println!("Bitcoin Core:");
    let bare = node.client()?;
    let _: Value = bare.call(
        "createwallet",
        &[
            json!("core_owner"),
            json!(false),
            json!(true),
            json!(""),
            json!(false),
            json!(true),
        ],
    )?;
    let core = Client::new(
        &format!("{}/wallet/core_owner", node.rpc_url()),
        node.auth(),
    )?;
    let mut descs = vec![];
    for (chain, internal) in [(0u32, false), (1u32, true)] {
        let d = locked_desc(&owner.xprv, &heir.xpub, chain, t_owner, t_heir);
        let info: Value = bare.call("getdescriptorinfo", &[json!(d)])?;
        let checksum = info["checksum"].as_str().unwrap().to_string();
        descs.push(json!({
            "desc": format!("{d}#{checksum}"),
            "timestamp": 0, "range": [0, 20], "active": true, "internal": internal,
        }));
    }
    let imported: Value = core.call("importdescriptors", &[Value::Array(descs)])?;
    println!("  importdescriptors: {imported}");
    let core_addr: String = core.call("getnewaddress", &[json!(""), json!("bech32m")])?;
    let core_addr = Address::from_str(&core_addr)?.require_network(Network::Regtest)?;
    // The address Core derives must be one of the vault's own addresses
    // (Core skips the ones it saw used during its rescan).
    let idx = (0..20)
        .find(|&i| ow.peek_address(KeychainKind::External, i).address == core_addr)
        .ok_or_else(|| {
            anyhow!("Bitcoin Core derived an address that isn't the vault's: {core_addr}")
        })?;
    println!("  core's next address {core_addr} is the vault's receive address #{idx}");
    fund(&miner, &core_addr, 80_000)?;
    mine_blocks(&miner, 1)?;
    let bal: Value = core.call("getbalances", &[])?;
    println!("  core balances: {}", bal["mine"]);
    let created: Value = core.call(
        "walletcreatefundedpsbt",
        &[
            json!([]),
            json!([{ dest.to_string(): 0.0005 }]),
            json!(t_owner),
            json!({ "fee_rate": 2 }),
        ],
    )?;
    let processed: Value = core.call("walletprocesspsbt", &[created["psbt"].clone()])?;
    println!("  walletprocesspsbt complete={}", processed["complete"]);
    let fin: Value = core.call("finalizepsbt", &[processed["psbt"].clone()])?;
    if fin["complete"] != json!(true) {
        bail!("Bitcoin Core could not finalize a locked-goal spend: {fin}");
    }
    let txid: Value = core.call("sendrawtransaction", &[fin["hex"].clone()])?;
    println!("  Bitcoin Core spend accepted: {txid}");

    // The alternative heir rule (date AND each deposit's own wait) also
    // compiles, for the record.
    let alt = format!(
        "tr({UNSPENDABLE_NUMS_XONLY},{{and_v(v:pk({o}/0/*),after({t_owner})),and_v(v:pk({h}/0/*),and_v(v:after({t_owner}),older(4320)))}})",
        o = owner.xpub,
        h = heir.xpub
    );
    ghostkey_core::descriptor::parse_descriptor(&alt)
        .map_err(|e| anyhow!("alternative heir rule doesn't compile: {e}"))?;
    println!("alternative heir rule (after + older) compiles too");
    Ok(())
}
