//! Offline sweep: build + sign a spend from explicitly-provided UTXOs,
//! with **no chain access**.
//!
//! This is the engine behind the browser recovery kit (issue #93). The
//! kit runs offline, so it cannot sync a wallet. Instead the surrounding
//! code (JS in the kit, or a test harness here) hands us the *funding
//! transactions* that paid the vault — fetched from whatever Esplora the
//! user chose, or pasted in by hand for a fully offline run — together
//! with the height each was confirmed at and the current chain tip. This
//! module turns that plus the key into a finished, signed transaction the
//! user can broadcast anywhere.
//!
//! The signing itself reuses the audited [`crate::psbt`] builders, so the
//! delicate parts (selecting the owner vs heir+timelock tapscript branch,
//! setting the CSV `nSequence`) are exactly the code already exercised by
//! the regtest end-to-end test. The only new behaviour here is feeding
//! BDK its UTXOs from memory rather than from a node.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use bdk_wallet::chain::tx_graph::TxUpdate;
use bdk_wallet::chain::{BlockId, ConfirmationBlockTime};
use bdk_wallet::{KeychainKind, Update, Wallet};
use bitcoin::hashes::Hash;
use bitcoin::{Address, BlockHash, FeeRate, Transaction};

use crate::error::{Error, Result};
use crate::psbt::{build_guardian_claim, build_heir_claim, build_owner_send, BuiltPsbt};
use crate::vault::Vault;
use crate::wallet::{build_signing_from_account, build_signing_guardian};

/// How many addresses to reveal on each keychain before matching UTXOs.
///
/// GhostKey vault flows only ever advance one index per check-in or send,
/// so a coin can realistically only live at a low index. A generous buffer
/// covers any plausible history while staying cheap (a few hundred key
/// derivations).
const REVEAL_BUFFER: u32 = 200;

/// A transaction that funded the vault, with the block height it confirmed
/// at. The kit's chain source (an Esplora, or the user) supplies both.
#[derive(Debug, Clone)]
pub struct ConfirmedTx {
    pub tx: Transaction,
    pub confirmation_height: u32,
}

/// A finished, fully-signed sweep ready to broadcast.
#[derive(Debug, Clone)]
pub struct SweepResult {
    /// The signed transaction.
    pub tx: Transaction,
    /// Its txid, as a convenience for callers/UI.
    pub txid: String,
    /// Fee paid, in satoshis.
    pub fee_sat: u64,
}

/// Build and fully sign a sweep using the **owner** branch (spendable at
/// any time, no timelock).
///
/// `account_xpriv` is the BIP86 account key (`m/86'/coin'/0'`) for the
/// owner — the same key the recovery kit unlocks. `funding` must contain
/// every transaction that paid a vault address you want to spend, with its
/// confirmation height. `chain_tip_height` is the current best-block
/// height. `amount_sat` of `None` drains the whole balance to `recipient`.
pub fn sign_owner_sweep(
    vault: &Vault,
    account_xpriv: &bitcoin::bip32::Xpriv,
    funding: Vec<ConfirmedTx>,
    chain_tip_height: u32,
    recipient: &Address,
    amount_sat: Option<u64>,
    fee_rate: FeeRate,
) -> Result<SweepResult> {
    let mut w = build_signing_from_account(vault, account_xpriv)?;
    load_utxos(&mut w, funding, chain_tip_height)?;
    let built = build_owner_send(&mut w, vault, recipient, amount_sat, fee_rate)?;
    finalize(built)
}

/// Build and fully sign a sweep using the **heir + timelock** branch.
///
/// The resulting transaction is only valid once each input has aged past
/// the vault's `older(N)` relative timelock; broadcasting earlier is
/// rejected by the network as non-BIP68-final. Always drains the full
/// balance to `recipient`.
pub fn sign_heir_sweep(
    vault: &Vault,
    account_xpriv: &bitcoin::bip32::Xpriv,
    funding: Vec<ConfirmedTx>,
    chain_tip_height: u32,
    recipient: &Address,
    fee_rate: FeeRate,
) -> Result<SweepResult> {
    let mut w = build_signing_from_account(vault, account_xpriv)?;
    load_utxos(&mut w, funding, chain_tip_height)?;
    let built = build_heir_claim(&mut w, vault, recipient, fee_rate)?;
    finalize(built)
}

/// Build and fully sign a sweep using the **guardian-vault claim** branch
/// (issue #81): `heir AND (g1 OR g2) AND older(N)`.
///
/// Requires the heir's account xprv plus **one** guardian's account xprv.
/// Like [`sign_heir_sweep`], the transaction is only valid once each input
/// has aged past the vault's relative timelock. Always drains the full
/// balance to `recipient`.
#[allow(clippy::too_many_arguments)]
pub fn sign_guardian_sweep(
    vault: &Vault,
    heir_account_xpriv: &bitcoin::bip32::Xpriv,
    guardian_account_xpriv: &bitcoin::bip32::Xpriv,
    funding: Vec<ConfirmedTx>,
    chain_tip_height: u32,
    recipient: &Address,
    fee_rate: FeeRate,
) -> Result<SweepResult> {
    let mut w = build_signing_guardian(vault, heir_account_xpriv, guardian_account_xpriv)?;
    load_utxos(&mut w, funding, chain_tip_height)?;
    let built = build_guardian_claim(&mut w, vault, recipient, fee_rate)?;
    finalize(built)
}

/// Reveal a buffer of addresses on both keychains, then feed BDK the
/// funding transactions as **confirmed** so it sees the vault's UTXOs.
///
/// We build a minimal chain update: a checkpoint at each funding height
/// plus the current tip, all sharing the wallet's genesis so the update
/// connects. The block hashes are placeholders — for spending, the local
/// chain only needs heights, and real relative-timelock maturity is
/// enforced by consensus at broadcast, not here.
#[allow(clippy::field_reassign_with_default)] // TxUpdate is #[non_exhaustive]
fn load_utxos(w: &mut Wallet, funding: Vec<ConfirmedTx>, chain_tip_height: u32) -> Result<()> {
    for keychain in [KeychainKind::External, KeychainKind::Internal] {
        for _ in 0..REVEAL_BUFFER {
            let _ = w.reveal_next_address(keychain);
        }
    }

    let mut cp = w.latest_checkpoint();
    let mut anchors = BTreeSet::new();
    let mut txs = Vec::with_capacity(funding.len());
    for ConfirmedTx {
        tx,
        confirmation_height,
    } in funding
    {
        let block_id = BlockId {
            height: confirmation_height,
            hash: BlockHash::all_zeros(),
        };
        cp = cp.insert(block_id);
        let txid = tx.compute_txid();
        anchors.insert((
            ConfirmationBlockTime {
                block_id,
                confirmation_time: 0,
            },
            txid,
        ));
        txs.push(Arc::new(tx));
    }
    cp = cp.insert(BlockId {
        height: chain_tip_height,
        hash: BlockHash::all_zeros(),
    });

    // `TxUpdate` is `#[non_exhaustive]`, so we can't name its fields in a
    // struct literal from this crate — default then assign is the only way.
    let mut tx_update = TxUpdate::default();
    tx_update.txs = txs;
    tx_update.anchors = anchors;

    // `apply_update_at` with an explicit timestamp, not `apply_update`,
    // because the latter calls `SystemTime::now()` which panics on
    // wasm32-unknown-unknown (where this runs, inside the recovery kit).
    // Our transactions are confirmed (anchored), so the seen-at value is
    // irrelevant; 0 is fine.
    w.apply_update_at(
        Update {
            last_active_indices: BTreeMap::new(),
            tx_update,
            chain: Some(cp),
        },
        0,
    )
    .map_err(|e| Error::Psbt(format!("could not load vault history: {e}")))?;
    Ok(())
}

/// Require a fully-signed PSBT and extract the broadcastable transaction.
fn finalize(built: BuiltPsbt) -> Result<SweepResult> {
    if !built.finalized {
        return Err(Error::Psbt(
            "could not fully sign the sweep — check the key matches this vault and that the \
             funding transactions cover its coins"
                .into(),
        ));
    }
    let fee_sat = built
        .psbt
        .fee()
        .map_err(|e| Error::Psbt(format!("could not compute fee: {e}")))?
        .to_sat();
    let tx = built
        .psbt
        .extract_tx()
        .map_err(|e| Error::Psbt(format!("could not extract signed transaction: {e}")))?;
    Ok(SweepResult {
        txid: tx.compute_txid().to_string(),
        tx,
        fee_sat,
    })
}
