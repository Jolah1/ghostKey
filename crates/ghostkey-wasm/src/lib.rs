//! WASM bindings for the GhostKey offline sweep signer (issue #93).
//!
//! The browser recovery kit runs offline and cannot sync a wallet, so it
//! cannot use the server's chain-aware spend path. Instead it gathers the
//! vault's funding transactions from a chain source the user picks (any
//! Esplora, or pasted by hand) and calls [`sign_sweep`] here. All key
//! handling and signing happens locally in the browser; the result is a
//! finished, signed transaction the user broadcasts wherever they like.
//!
//! The actual signing reuses [`ghostkey_core::sweep`], the same audited
//! code verified end-to-end on regtest. This crate is only a thin,
//! JSON-in/JSON-out translation layer over it.

use std::str::FromStr;

use bitcoin::bip32::Xpriv;
use bitcoin::consensus::encode::{deserialize, serialize_hex};
use bitcoin::{Address, FeeRate, Network, Transaction};
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

use ghostkey_core::sweep::{sign_heir_sweep, sign_owner_sweep, ConfirmedTx};
use ghostkey_core::vault::{Vault, VaultConfig, VaultRole};

/// A funding transaction plus the height it confirmed at, as supplied by
/// the kit's chain source.
#[derive(Debug, Deserialize)]
struct FundingInput {
    /// Raw transaction hex (e.g. Esplora `GET /tx/:txid/hex`).
    tx_hex: String,
    /// Block height the transaction confirmed at.
    confirmation_height: u32,
}

/// Everything the signer needs, as one JSON object from the kit.
#[derive(Debug, Deserialize)]
struct SweepRequest {
    /// `"owner"` (spend now) or `"heir"` (spend after the timelock).
    role: String,
    /// The vault's external (receive) descriptor, with checksum.
    descriptor_external: String,
    /// The vault's internal (change) descriptor, with checksum.
    descriptor_internal: String,
    /// The vault's relative timelock in blocks (the `older(N)` value).
    timelock_blocks: u32,
    /// Bitcoin network: `"bitcoin"`, `"testnet"`, `"signet"`, `"regtest"`.
    network: String,
    /// The BIP86 account key (`m/86'/coin'/0'`) the kit unlocked.
    account_xprv: String,
    /// Transactions that funded the vault, with confirmation heights.
    funding: Vec<FundingInput>,
    /// Current best-block height (from the chain source).
    chain_tip_height: u32,
    /// Where to send the coins.
    recipient: String,
    /// Amount in sats, or `null`/absent to drain the whole balance.
    #[serde(default)]
    amount_sat: Option<u64>,
    /// Fee rate in sat/vByte.
    fee_rate_sat_vb: u64,
}

/// The finished, broadcastable result.
#[derive(Debug, Serialize)]
struct SweepResponse {
    /// Raw signed transaction hex — paste into any explorer's broadcast box.
    tx_hex: String,
    txid: String,
    fee_sat: u64,
}

/// Build and fully sign a sweep from a JSON request, returning a JSON
/// response (see [`SweepRequest`] / [`SweepResponse`]).
///
/// Errors come back as a `JsError` whose message is safe to show the user.
#[wasm_bindgen]
pub fn sign_sweep(request_json: &str) -> Result<String, JsError> {
    console_error_panic_hook::set_once();
    let out = run(request_json).map_err(|e| JsError::new(&e))?;
    serde_json::to_string(&out).map_err(|e| JsError::new(&e.to_string()))
}

fn run(request_json: &str) -> Result<SweepResponse, String> {
    let req: SweepRequest = serde_json::from_str(request_json)
        .map_err(|e| format!("could not read the request: {e}"))?;

    let network = parse_network(&req.network)?;

    let role = match req.role.as_str() {
        "owner" => VaultRole::Owner,
        "heir" => VaultRole::Heir,
        other => {
            return Err(format!(
                "unknown role {other:?}; expected \"owner\" or \"heir\""
            ))
        }
    };

    let vault = Vault::from_config(VaultConfig {
        descriptor_external: req.descriptor_external,
        descriptor_internal: req.descriptor_internal,
        timelock_blocks: req.timelock_blocks,
        network,
        role,
        label: None,
    })
    .map_err(|e| format!("invalid vault descriptors: {e}"))?;

    let account_xprv = Xpriv::from_str(req.account_xprv.trim())
        .map_err(|e| format!("invalid account key: {e}"))?;

    let recipient = Address::from_str(req.recipient.trim())
        .map_err(|e| format!("invalid recipient address: {e}"))?
        .require_network(network)
        .map_err(|_| format!("recipient address is not a {network} address"))?;

    let fee_rate = FeeRate::from_sat_per_vb(req.fee_rate_sat_vb)
        .ok_or_else(|| "fee rate is too large".to_string())?;

    let funding = req
        .funding
        .into_iter()
        .map(|f| {
            let bytes = hex_to_bytes(&f.tx_hex)?;
            let tx: Transaction =
                deserialize(&bytes).map_err(|e| format!("bad funding transaction hex: {e}"))?;
            Ok(ConfirmedTx {
                tx,
                confirmation_height: f.confirmation_height,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;

    if funding.is_empty() {
        return Err("no funding transactions supplied — nothing to spend".into());
    }

    let result = match role {
        VaultRole::Owner => sign_owner_sweep(
            &vault,
            &account_xprv,
            funding,
            req.chain_tip_height,
            &recipient,
            req.amount_sat,
            fee_rate,
        ),
        VaultRole::Heir => sign_heir_sweep(
            &vault,
            &account_xprv,
            funding,
            req.chain_tip_height,
            &recipient,
            fee_rate,
        ),
        VaultRole::Watchonly => return Err("watch-only vaults hold no key and cannot sign".into()),
    }
    .map_err(|e| e.to_string())?;

    Ok(SweepResponse {
        tx_hex: serialize_hex(&result.tx),
        txid: result.txid,
        fee_sat: result.fee_sat,
    })
}

fn parse_network(s: &str) -> Result<Network, String> {
    match s {
        "bitcoin" | "mainnet" => Ok(Network::Bitcoin),
        "testnet" => Ok(Network::Testnet),
        "signet" => Ok(Network::Signet),
        "regtest" => Ok(Network::Regtest),
        other => Err(format!("unknown network {other:?}")),
    }
}

fn hex_to_bytes(s: &str) -> Result<Vec<u8>, String> {
    let s = s.trim();
    if !s.len().is_multiple_of(2) {
        return Err("hex has an odd number of characters".into());
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).map_err(|e| format!("bad hex: {e}")))
        .collect()
}
