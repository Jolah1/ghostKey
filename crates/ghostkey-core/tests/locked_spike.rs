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

/// The real code path, not the spike's: a locked goal made with
/// `Vault::new_locked`, spent with `sign_owner_sweep` / `sign_heir_sweep`
/// (what the browser's wasm signer runs). Owner and heir are each refused
/// before their date and accepted after; a partial owner send keeps the
/// change in the vault.
#[test]
#[ignore]
fn locked_goal_through_the_signer() -> Result<()> {
    use ghostkey_core::keys::{account_xpub, descriptor_key_fragment, vault_account_path, Chain};
    use ghostkey_core::sweep::{sign_heir_sweep, sign_owner_sweep, ConfirmedTx};
    use ghostkey_core::vault::{Vault, VaultRole};

    let node = Bitcoind::spawn()?;
    let rpc = node.client()?;
    let miner = ensure_node_wallet(&node, "miner")?;
    mine_blocks(&miner, 101)?;
    let mut clock: u64 = mtp(&rpc)? + 3_600;
    let _: Value = rpc.call("setmocktime", &[json!(clock)])?;
    let t_owner = (clock + 6 * 3_600) as u32;
    let t_heir = (clock + 12 * 3_600) as u32;

    let net = Network::Regtest;
    let secp = Secp256k1::new();
    let owner_m = Xpriv::new_master(net, &[0xC1; 32])?;
    let heir_m = Xpriv::new_master(net, &[0xD2; 32])?;
    let (ofp, op, ox) = account_xpub(&owner_m, net)?;
    let (hfp, hp, hx) = account_xpub(&heir_m, net)?;
    let owner_acct = owner_m.derive_priv(&secp, &vault_account_path(net))?;
    let heir_acct = heir_m.derive_priv(&secp, &vault_account_path(net))?;
    let vault = Vault::new_locked(
        &descriptor_key_fragment(ofp, &op, &ox, Chain::External),
        &descriptor_key_fragment(ofp, &op, &ox, Chain::Internal),
        &descriptor_key_fragment(hfp, &hp, &hx, Chain::External),
        &descriptor_key_fragment(hfp, &hp, &hx, Chain::Internal),
        t_owner,
        t_heir,
        net,
        VaultRole::Owner,
        Some("locked".into()),
    )?;
    assert_eq!(vault.locked_dates(), Some((t_owner, t_heir)));

    let mut watch = ghostkey_core::wallet::build_watch_only(&vault)?;
    let a = watch.reveal_next_address(KeychainKind::External).address;
    let b = watch.reveal_next_address(KeychainKind::External).address;
    let ta = miner.send_to_address(
        &a,
        Amount::from_sat(100_000),
        None,
        None,
        None,
        None,
        None,
        None,
    )?;
    let tb = miner.send_to_address(
        &b,
        Amount::from_sat(60_000),
        None,
        None,
        None,
        None,
        None,
        None,
    )?;
    let h1 = mine_blocks(&miner, 1)?;
    let mut history = vec![
        ConfirmedTx {
            tx: miner.get_transaction(&ta, None)?.transaction()?,
            confirmation_height: h1,
        },
        ConfirmedTx {
            tx: miner.get_transaction(&tb, None)?.transaction()?,
            confirmation_height: h1,
        },
    ];
    let dest = miner
        .get_new_address(None, Some(AddressType::Bech32m))?
        .require_network(net)
        .map_err(|e| anyhow!("{e}"))?;
    let fee = FeeRate::from_sat_per_vb(2).unwrap();

    // Owner, partial send, before the date: signed, but refused.
    let send = sign_owner_sweep(
        &vault,
        &owner_acct,
        history.clone(),
        h1,
        &dest,
        Some(50_000),
        fee,
    )?;
    println!(
        "owner send: fee {} sat, {} outputs",
        send.fee_sat,
        send.tx.output.len()
    );
    assert_eq!(send.tx.output.len(), 2, "change comes back to the vault");
    match broadcast(&rpc, &send.tx) {
        Ok(_) => bail!("an owner send before the unlock date was ACCEPTED"),
        Err(e) => println!("  refused before the date: {e}"),
    }
    advance_past(&rpc, &miner, &mut clock, t_owner as u64)?;
    broadcast(&rpc, &send.tx).map_err(|e| anyhow!("owner send after the date refused: {e}"))?;
    let h2 = mine_blocks(&miner, 1)?;
    history.push(ConfirmedTx {
        tx: send.tx.clone(),
        confirmation_height: h2,
    });
    println!("  owner send accepted after the date");

    // Heir: after the owner's date but before the heir's, refused.
    let claim = sign_heir_sweep(&vault, &heir_acct, history.clone(), h2, &dest, fee)?;
    match broadcast(&rpc, &claim.tx) {
        Ok(_) => bail!("an heir claim before the heir date was ACCEPTED"),
        Err(e) => println!("heir claim refused before its date: {e}"),
    }
    advance_past(&rpc, &miner, &mut clock, t_heir as u64)?;
    broadcast(&rpc, &claim.tx).map_err(|e| anyhow!("heir claim after its date refused: {e}"))?;
    println!(
        "heir claim accepted after its date: {} inputs",
        claim.tx.input.len()
    );
    Ok(())
}

/// #389: a legacy-format vault upgrades to the standard format, one
/// transaction per deposit, signed by the same signer the browser uses;
/// the old addresses end up empty; and the heir, with the same heir key,
/// can still claim from the upgraded vault once the wait has passed (and
/// not before: the upgrade restarts the wait).
#[test]
#[ignore]
fn legacy_vault_upgrades_and_the_heir_can_still_claim() -> Result<()> {
    use ghostkey_core::descriptor::{build_descriptor_pair, upgrade_legacy_pair};
    use ghostkey_core::keys::{account_xpub, descriptor_key_fragment, vault_account_path, Chain};
    use ghostkey_core::sweep::{sign_heir_sweep, sign_owner_sweep, ConfirmedTx};
    use ghostkey_core::vault::{Vault, VaultConfig, VaultRole};

    let node = Bitcoind::spawn()?;
    let rpc = node.client()?;
    let miner = ensure_node_wallet(&node, "miner")?;
    mine_blocks(&miner, 101)?;

    let net = Network::Regtest;
    let secp = Secp256k1::new();
    let owner_m = Xpriv::new_master(net, &[0xE1; 32])?;
    let heir_m = Xpriv::new_master(net, &[0xF2; 32])?;
    let (ofp, op, ox) = account_xpub(&owner_m, net)?;
    let (hfp, hp, hx) = account_xpub(&heir_m, net)?;
    let owner_acct = owner_m.derive_priv(&secp, &vault_account_path(net))?;
    let heir_acct = heir_m.derive_priv(&secp, &vault_account_path(net))?;
    let wait = 5u32;
    let legacy = build_descriptor_pair(
        &descriptor_key_fragment(ofp, &op, &ox, Chain::External),
        &descriptor_key_fragment(ofp, &op, &ox, Chain::Internal),
        &descriptor_key_fragment(hfp, &hp, &hx, Chain::External),
        &descriptor_key_fragment(hfp, &hp, &hx, Chain::Internal),
        wait,
    )?;
    let vault_of = |ext: &str, int: &str| {
        Vault::from_config(VaultConfig {
            descriptor_external: ext.to_string(),
            descriptor_internal: int.to_string(),
            timelock_blocks: wait,
            network: net,
            role: VaultRole::Owner,
            label: None,
        })
    };
    let old = vault_of(&legacy.external, &legacy.internal)?;

    // Two deposits into the legacy vault.
    let mut old_watch = ghostkey_core::wallet::build_watch_only(&old)?;
    let mut deposits = Vec::new();
    for sats in [100_000u64, 60_000] {
        let addr = old_watch
            .reveal_next_address(KeychainKind::External)
            .address;
        deposits.push(miner.send_to_address(
            &addr,
            Amount::from_sat(sats),
            None,
            None,
            None,
            None,
            None,
            None,
        )?);
    }
    let h1 = mine_blocks(&miner, 1)?;

    // The upgrade target: same keys, same wait, standard format.
    let target = upgrade_legacy_pair(&legacy.external, &legacy.internal).expect("a legacy pair");
    let new = vault_of(&target.pair.external, &target.pair.internal)?;
    let new_watch = ghostkey_core::wallet::build_watch_only(&new)?;
    let fee = FeeRate::from_sat_per_vb(2).unwrap();

    // One transaction per deposit, each to its own new change address.
    let mut moved = Vec::new();
    for (i, txid) in deposits.iter().enumerate() {
        let funding = vec![ConfirmedTx {
            tx: miner.get_transaction(txid, None)?.transaction()?,
            confirmation_height: h1,
        }];
        let to = new_watch
            .peek_address(KeychainKind::Internal, i as u32)
            .address;
        let up = sign_owner_sweep(&old, &owner_acct, funding, h1, &to, None, fee)?;
        assert_eq!(up.tx.output.len(), 1, "one coin in, one coin out");
        assert_eq!(up.tx.input.len(), 1, "deposits are not merged");
        broadcast(&rpc, &up.tx).map_err(|e| anyhow!("upgrade tx refused: {e}"))?;
        println!("upgraded deposit {i}: fee {} sat", up.fee_sat);
        moved.push(up.tx);
    }
    let h2 = mine_blocks(&miner, 1)?;

    // The old format is empty; the new one holds both, less fees.
    sync_wallet(&mut old_watch, &rpc)?;
    assert_eq!(
        old_watch.balance().total().to_sat(),
        0,
        "old addresses empty"
    );
    let mut new_sync = ghostkey_core::wallet::build_watch_only(&new)?;
    for i in 0..2 {
        let _ = new_sync.reveal_addresses_to(KeychainKind::Internal, i);
    }
    sync_wallet(&mut new_sync, &rpc)?;
    let held = new_sync.balance().confirmed.to_sat();
    assert!(held > 159_000 && held < 160_000, "new vault holds {held}");

    // The heir, same key: refused before the wait (it restarted at the
    // upgrade), accepted after.
    let history: Vec<ConfirmedTx> = moved
        .iter()
        .map(|tx| ConfirmedTx {
            tx: tx.clone(),
            confirmation_height: h2,
        })
        .collect();
    let dest = miner
        .get_new_address(None, Some(AddressType::Bech32m))?
        .require_network(net)
        .map_err(|e| anyhow!("{e}"))?;
    let early = sign_heir_sweep(&new, &heir_acct, history.clone(), h2, &dest, fee)?;
    match broadcast(&rpc, &early.tx) {
        Ok(_) => bail!("an heir claim before the wait was ACCEPTED"),
        Err(e) => println!("  heir refused before the wait: {e}"),
    }
    let tip = mine_blocks(&miner, wait as u64)?;
    let claim = sign_heir_sweep(&new, &heir_acct, history, tip, &dest, fee)?;
    broadcast(&rpc, &claim.tx).map_err(|e| anyhow!("heir claim after the wait refused: {e}"))?;
    println!("heir claimed the upgraded vault: fee {} sat", claim.fee_sat);
    Ok(())
}

/// #387: what "Use this vault in another wallet" gives Bitcoin Core
/// imports into a watch-only wallet that sees exactly the vault: the same
/// addresses and the same balance. For the standard format and the
/// legacy one. (Liana takes the standard format's multipath descriptor;
/// Core here checks the same keys and script.)
#[test]
#[ignore]
fn the_export_opens_in_bitcoin_core_with_the_same_addresses_and_balance() -> Result<()> {
    use ghostkey_core::descriptor::{
        build_descriptor_pair, build_standard_descriptor_from_fragments, standard_multipath,
        with_checksum,
    };
    use ghostkey_core::keys::{account_xpub, descriptor_key_fragment, Chain};
    use ghostkey_core::vault::{Vault, VaultConfig, VaultRole};

    let node = Bitcoind::spawn()?;
    let rpc = node.client()?;
    let miner = ensure_node_wallet(&node, "miner")?;
    mine_blocks(&miner, 101)?;
    let net = Network::Regtest;
    let frag = |seed: u8, chain| -> Result<String> {
        let m = Xpriv::new_master(net, &[seed; 32])?;
        let (fp, p, x) = account_xpub(&m, net)?;
        Ok(descriptor_key_fragment(fp, &p, &x, chain))
    };
    let (oe, oi) = (frag(0x51, Chain::External)?, frag(0x51, Chain::Internal)?);
    let (he, hi) = (frag(0x52, Chain::External)?, frag(0x52, Chain::Internal)?);
    let standard = build_standard_descriptor_from_fragments(&oe, &oi, &he, &hi, 144)?;
    assert_eq!(
        standard_multipath(&standard.pair.external, &standard.pair.internal).as_deref(),
        Some(standard.multipath.as_str())
    );
    let legacy = build_descriptor_pair(&oe, &oi, &he, &hi, 144)?;

    for (name, pair) in [("standard", &standard.pair), ("legacy", &legacy)] {
        let vault = Vault::from_config(VaultConfig {
            descriptor_external: pair.external.clone(),
            descriptor_internal: pair.internal.clone(),
            timelock_blocks: 144,
            network: net,
            role: VaultRole::Watchonly,
            label: None,
        })?;
        let mut watch = ghostkey_core::wallet::build_watch_only(&vault)?;
        let a0 = watch.reveal_next_address(KeychainKind::External).address;
        let a1 = watch.reveal_next_address(KeychainKind::External).address;
        fund(&miner, &a0, 70_000)?;
        fund(&miner, &a1, 30_000)?;
        mine_blocks(&miner, 1)?;

        // The same JSON the export endpoint builds.
        let import = json!([
            { "desc": with_checksum(&pair.external)?, "timestamp": 0, "active": true, "internal": false, "range": [0, 999] },
            { "desc": with_checksum(&pair.internal)?, "timestamp": 0, "active": true, "internal": true, "range": [0, 999] },
        ]);
        let wallet_name = format!("watch-{name}");
        let _: Value = rpc.call(
            "createwallet",
            &[
                json!(wallet_name),
                json!(true),
                json!(true),
                json!(""),
                json!(false),
                json!(true),
            ],
        )?;
        let w = Client::new(
            &format!("{}/wallet/{}", node.rpc_url(), wallet_name),
            node.auth(),
        )?;
        let res: Value = w.call("importdescriptors", &[import])?;
        assert!(
            res.as_array()
                .unwrap()
                .iter()
                .all(|r| r["success"] == json!(true)),
            "{name}: {res}"
        );
        let bal: Value = w.call("getbalances", &[])?;
        let held = (bal["mine"]["trusted"].as_f64().unwrap() * 1e8).round() as u64;
        assert_eq!(held, 100_000, "{name}: Core sees the vault's balance");
        let first: String = w
            .call(
                "deriveaddresses",
                &[json!(with_checksum(&pair.external)?), json!([0, 1])],
            )
            .map(|v: Value| v[0].as_str().unwrap().to_string())?;
        assert_eq!(
            first,
            a0.to_string(),
            "{name}: Core's first address is the vault's"
        );
        println!("{name}: Core sees {held} sat at {first}");
    }
    Ok(())
}

/// #387 "done when": the descriptor "Use this vault in another wallet"
/// gives Liana opens in a real `lianad` (needs `lianad` and `liana-cli` on
/// PATH, as well as `bitcoind`), which then sees the same coins and the
/// same receive addresses as GhostKey.
#[test]
#[ignore]
fn the_export_opens_in_liana_with_the_same_addresses_and_coins() -> Result<()> {
    use ghostkey_core::descriptor::{build_standard_descriptor_from_fragments, standard_multipath};
    use ghostkey_core::keys::{account_xpub, descriptor_key_fragment, Chain};
    use ghostkey_core::vault::{Vault, VaultConfig, VaultRole};

    struct Kill(Vec<Child>);
    impl Drop for Kill {
        fn drop(&mut self) {
            for c in &mut self.0 {
                let _ = c.kill();
                let _ = c.wait();
            }
        }
    }
    let tmp = tempfile::tempdir()?;
    let btc_dir = tmp.path().join("bitcoind");
    std::fs::create_dir_all(&btc_dir)?;
    let rpc_port = pick_port()?;
    let mut procs = Kill(vec![Command::new("bitcoind")
        .arg(format!("-datadir={}", btc_dir.display()))
        .args([
            "-regtest=1",
            "-server=1",
            "-listen=0",
            "-fallbackfee=0.0002",
        ])
        .arg(format!("-rpcport={rpc_port}"))
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .context("bitcoind on PATH")?]);
    let cookie = btc_dir.join("regtest").join(".cookie");
    let started = Instant::now();
    let rpc = loop {
        if cookie.exists() {
            if let Ok(c) = Client::new(
                &format!("http://127.0.0.1:{rpc_port}"),
                Auth::CookieFile(cookie.clone()),
            ) {
                if c.get_block_count().is_ok() {
                    break c;
                }
            }
        }
        if started.elapsed() > Duration::from_secs(30) {
            bail!("bitcoind didn't start");
        }
        std::thread::sleep(Duration::from_millis(200));
    };
    let _: Value = rpc.call("createwallet", &[json!("miner")])?;
    let miner = Client::new(
        &format!("http://127.0.0.1:{rpc_port}/wallet/miner"),
        Auth::CookieFile(cookie.clone()),
    )?;
    mine_blocks(&miner, 101)?;

    let net = Network::Regtest;
    let frag = |seed: u8, chain| -> Result<String> {
        let m = Xpriv::new_master(net, &[seed; 32])?;
        let (fp, p, x) = account_xpub(&m, net)?;
        Ok(descriptor_key_fragment(fp, &p, &x, chain))
    };
    let std_ = build_standard_descriptor_from_fragments(
        &frag(0x61, Chain::External)?,
        &frag(0x61, Chain::Internal)?,
        &frag(0x62, Chain::External)?,
        &frag(0x62, Chain::Internal)?,
        4320,
    )?;
    // Exactly what the export endpoint hands Liana.
    let multipath = standard_multipath(&std_.pair.external, &std_.pair.internal).expect("standard");
    let vault = Vault::from_config(VaultConfig {
        descriptor_external: std_.pair.external.clone(),
        descriptor_internal: std_.pair.internal.clone(),
        timelock_blocks: 4320,
        network: net,
        role: VaultRole::Watchonly,
        label: None,
    })?;
    let mut watch = ghostkey_core::wallet::build_watch_only(&vault)?;
    let ours: Vec<String> = (0..3)
        .map(|_| {
            watch
                .reveal_next_address(KeychainKind::External)
                .address
                .to_string()
        })
        .collect();
    for (addr, sats) in ours.iter().take(2).zip([70_000u64, 30_000]) {
        let a = Address::from_str(addr)?.require_network(net)?;
        fund(&miner, &a, sats)?;
    }
    mine_blocks(&miner, 1)?;

    let liana_dir = tmp.path().join("liana");
    std::fs::create_dir_all(&liana_dir)?;
    let conf = liana_dir.join("config.toml");
    std::fs::write(
        &conf,
        format!(
            r#"daemon = false
data_dir = "{data}"
log_level = "warn"
main_descriptor = "{multipath}"

[bitcoin_config]
network = "regtest"
poll_interval_secs = 1

[bitcoind_config]
addr = "127.0.0.1:{rpc_port}"
cookie_path = "{cookie}"
"#,
            data = liana_dir.display(),
            cookie = cookie.display(),
        ),
    )?;
    procs.0.push(
        Command::new("lianad")
            .arg("--conf")
            .arg(&conf)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .context("lianad on PATH")?,
    );
    let cli = |args: &[&str]| -> Result<Value> {
        let out = Command::new("liana-cli")
            .arg("--conf")
            .arg(&conf)
            .args(args)
            .output()?;
        let v: Value = serde_json::from_slice(&out.stdout).map_err(|e| {
            anyhow!(
                "liana-cli {args:?}: {e}: {}",
                String::from_utf8_lossy(&out.stderr)
            )
        })?;
        if v.get("error").is_some_and(|e| !e.is_null()) {
            bail!("liana-cli {args:?}: {v}");
        }
        Ok(v["result"].clone())
    };
    let started = Instant::now();
    loop {
        if let Ok(info) = cli(&["getinfo"]) {
            if info["sync"].as_f64() == Some(1.0) && info["block_height"].as_u64() >= Some(102) {
                break;
            }
        }
        if started.elapsed() > Duration::from_secs(90) {
            bail!("lianad didn't sync (did it accept the descriptor?)");
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    let coins = cli(&["listcoins"])?;
    let total: u64 = coins["coins"]
        .as_array()
        .ok_or_else(|| anyhow!("no coins: {coins}"))?
        .iter()
        .map(|c| c["amount"].as_u64().unwrap_or(0))
        .sum();
    assert_eq!(total, 100_000, "Liana sees the vault's coins: {coins}");
    let addrs = cli(&["listaddresses", "0", "3"])?;
    let liana_receive: Vec<String> = addrs["addresses"]
        .as_array()
        .ok_or_else(|| anyhow!("no addresses: {addrs}"))?
        .iter()
        .map(|a| a["receive"].as_str().unwrap_or_default().to_string())
        .collect();
    assert_eq!(
        liana_receive, ours,
        "Liana's receive addresses are GhostKey's"
    );
    println!(
        "Liana sees {total} sat; receive addresses match: {}",
        ours.join(", ")
    );
    Ok(())
}
