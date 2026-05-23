//! Heir claim PSBT flow.
//!
//! Two endpoints, both keyed on the heir's bearer token:
//!
//!   `POST /claim/:token/build-psbt`
//!       Body: `{ destination, fee_rate_sat_per_vb? }`.
//!       Server reconstructs the vault from its stored descriptor pair,
//!       full-scans the chain via Esplora, builds the heir-claim PSBT
//!       (the one that takes the `older(N)` tapscript branch), and
//!       returns it base64-encoded along with a summary the heir can
//!       sanity-check before signing.
//!
//!   `POST /claim/:token/broadcast`
//!       Body: `{ signed_psbt_b64 }`.
//!       Finalises the PSBT, broadcasts the resulting transaction via
//!       Esplora, marks the claim token used + vault status `claimed`.
//!       Returns the txid + a mempool.space link.
//!
//! ## Environmental config
//!
//! The Esplora endpoint comes from `GHOSTKEY_ESPLORA_URL`. If unset we
//! fall back to per-network public Blockstream endpoints. The fallback
//! is fine for testing and small loads; production deployments should
//! point at their own indexer.
//!
//! ## What is and isn't verified end-to-end
//!
//! - PSBT construction reuses `ghostkey_core::psbt::build_heir_claim`,
//!   which is unit-tested in core and integration-tested against
//!   regtest in `crates/ghostkey-core/tests/regtest_e2e.rs`.
//! - The Esplora HTTP integration in this module has unit-test coverage
//!   for input validation and error mapping, but `cargo test` does NOT
//!   exercise a live Esplora endpoint. A signet smoke test is the
//!   responsibility of whoever deploys this.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use bdk_esplora::esplora_client;
use bdk_esplora::EsploraExt;
use bdk_wallet::SignOptions;
use bitcoin::{Address, FeeRate, Network, Psbt};
use chrono::Utc;
use ghostkey_core::psbt::build_heir_claim;
use ghostkey_core::vault::{Vault, VaultConfig, VaultRole};
use serde::{Deserialize, Serialize};

use crate::crypto::claim_token_matches;
use crate::crypto::hash_claim_token;
use crate::routes::{record_event, ApiError};
use crate::AppState;

/// Default Esplora endpoints for use when `GHOSTKEY_ESPLORA_URL` is
/// unset. These public hosts are convenient for testing but they see
/// every script pubkey we ask about — fine for testnet, signet, and
/// regtest, never appropriate for mainnet.
fn default_esplora_url(network: Network) -> Option<&'static str> {
    match network {
        // No default for mainnet: we refuse to leak real vault
        // descriptors to a public indexer. Operators must point
        // `GHOSTKEY_ESPLORA_URL` at an Esplora they control.
        Network::Bitcoin => None,
        Network::Testnet => Some("https://blockstream.info/testnet/api"),
        Network::Signet => Some("https://mempool.space/signet/api"),
        // No public regtest indexer; the operator must set the env var.
        _ => Some("http://127.0.0.1:3002"),
    }
}

/// Resolve the Esplora URL for a network, refusing to start a request
/// we can't service. Mainnet requires `GHOSTKEY_ESPLORA_URL` to be set
/// and to be HTTPS — anything else would leak descriptors or expose
/// requests to a passive attacker.
fn esplora_url(network: Network) -> Result<String, ApiError> {
    if let Ok(url) = std::env::var("GHOSTKEY_ESPLORA_URL") {
        let trimmed = url.trim().to_string();
        if trimmed.is_empty() {
            return Err(ApiError::Validation(
                "GHOSTKEY_ESPLORA_URL is set but empty".into(),
            ));
        }
        if network == Network::Bitcoin && !trimmed.starts_with("https://") {
            return Err(ApiError::Validation(
                "GHOSTKEY_ESPLORA_URL must be HTTPS for mainnet".into(),
            ));
        }
        return Ok(trimmed);
    }
    match default_esplora_url(network) {
        Some(url) => Ok(url.to_string()),
        None => Err(ApiError::Validation(
            "mainnet requires GHOSTKEY_ESPLORA_URL to be set explicitly".into(),
        )),
    }
}

/// `mempool.space` explorer URL for a given txid + network.
fn explorer_url(network: Network, txid: &bitcoin::Txid) -> String {
    let base = match network {
        Network::Bitcoin => "https://mempool.space/tx".to_string(),
        Network::Testnet => "https://mempool.space/testnet/tx".to_string(),
        Network::Signet => "https://mempool.space/signet/tx".to_string(),
        _ => "https://example.invalid/tx".to_string(),
    };
    format!("{base}/{txid}")
}

/* -------------------------------------------------------------------------- *
 *  build-psbt                                                                *
 * -------------------------------------------------------------------------- */

#[derive(Debug, Deserialize)]
pub struct BuildClaimPsbtRequest {
    /// Bitcoin address the heir wants the funds to land at. Must match
    /// the vault's network.
    pub destination: String,
    /// Optional fee rate in sat/vB. We default to 2 sat/vB if missing
    /// (fine for non-urgent inheritance txs on mainnet; the heir can
    /// always bump later).
    #[serde(default)]
    pub fee_rate_sat_per_vb: Option<u64>,
}

#[derive(Debug, Serialize)]
pub struct BuildClaimPsbtResponse {
    pub psbt_b64: String,
    /// Total sats currently held in the vault, as observed during the
    /// pre-build chain scan.
    pub total_input_sats: u64,
    /// Sats that will land at the destination (total minus fee).
    pub output_sats: u64,
    /// Fee amount in sats.
    pub fee_sats: u64,
    /// Network the transaction is built for.
    pub network: String,
    /// Whether the server was able to finalise the PSBT without further
    /// signatures. False is the expected case for a watch-only build:
    /// the heir's wallet still has to sign.
    pub finalized: bool,
}

pub async fn build_claim_psbt(
    State(state): State<Arc<AppState>>,
    Path(token): Path<String>,
    Json(req): Json<BuildClaimPsbtRequest>,
) -> Result<Json<BuildClaimPsbtResponse>, ApiError> {
    let row = load_vault_for_claim_token(&state, &token).await?;

    // ---- Address validation ----
    let dest = req
        .destination
        .trim()
        .parse::<Address<bitcoin::address::NetworkUnchecked>>()
        .map_err(|e| ApiError::Validation(format!("destination: {e}")))?;
    if !dest.is_valid_for_network(row.network) {
        return Err(ApiError::Validation(format!(
            "destination is not a valid {:?} address",
            row.network
        )));
    }
    let dest = dest.assume_checked();
    let dest_str = dest.to_string();

    // ---- Fee rate ----
    // BDK takes a `FeeRate`. Default 2 sat/vB; lower bound 1 to avoid
    // building a sub-relay-fee tx that no one will mine.
    let fee_rate_sat_per_kwu = req.fee_rate_sat_per_vb.unwrap_or(2).max(1) * 250;
    let fee_rate = FeeRate::from_sat_per_kwu(fee_rate_sat_per_kwu);

    // ---- Reconstruct the watch-only Vault + Wallet ----
    let vault_config = VaultConfig {
        descriptor_external: row.descriptor_external.clone(),
        descriptor_internal: row.descriptor_internal.clone(),
        timelock_blocks: row.timelock_blocks as u32,
        network: row.network,
        role: VaultRole::Watchonly,
        label: row.label.clone(),
    };
    let vault = Vault::from_config(vault_config)
        .map_err(|e| ApiError::Validation(format!("stored vault descriptors invalid: {e}")))?;

    // ---- Sync + build in a blocking thread ----
    // `esplora_client` blocking API performs synchronous HTTP. We move
    // it (plus the BDK wallet ops) onto a blocking thread so the axum
    // executor isn't held up.
    let url = esplora_url(row.network)?;
    let network = row.network;
    let total_input_sats;
    let fee_sats;
    let output_sats;
    let finalized;
    let psbt_b64;
    {
        let built = tokio::task::spawn_blocking(move || -> Result<BlockingBuilt, BlockingErr> {
            let mut wallet = ghostkey_core::wallet::build_watch_only(&vault)
                .map_err(|e| BlockingErr::Vault(e.to_string()))?;

            // Esplora client. Blockstream's public endpoints serve over
            // HTTPS; the env-var override may be plain HTTP for local
            // testing.
            let client = esplora_client::Builder::new(&url).build_blocking();

            // Full scan: walk both keychains, stop after 5 unused gap.
            let req = wallet.start_full_scan();
            let update = client
                .full_scan(req, 5, 1)
                .map_err(|e| BlockingErr::Esplora(format!("full_scan: {e}")))?;
            wallet
                .apply_update(update)
                .map_err(|e| BlockingErr::Esplora(format!("apply_update: {e}")))?;

            let total = wallet.balance().total().to_sat();
            if total == 0 {
                return Err(BlockingErr::NoUtxos);
            }

            let built = build_heir_claim(&mut wallet, &vault, &dest, fee_rate)
                .map_err(|e| BlockingErr::Build(e.to_string()))?;

            // BDK reports the fee on the un-built tx via the PSBT's
            // unsigned tx output sum vs the in-wallet UTXOs we drained.
            // For "drain all", fee = total - sum(output).
            let unsigned_tx = built.psbt.unsigned_tx.clone();
            let output_sum: u64 = unsigned_tx.output.iter().map(|o| o.value.to_sat()).sum();
            let fee = total.saturating_sub(output_sum);

            let psbt_b64 = B64.encode(built.psbt.serialize());

            Ok(BlockingBuilt {
                total_input_sats: total,
                output_sats: output_sum,
                fee_sats: fee,
                finalized: built.finalized,
                psbt_b64,
            })
        })
        .await
        .map_err(|e| ApiError::Validation(format!("worker panic: {e}")))??;

        total_input_sats = built.total_input_sats;
        fee_sats = built.fee_sats;
        output_sats = built.output_sats;
        finalized = built.finalized;
        psbt_b64 = built.psbt_b64;
    }

    record_event(
        &state.db,
        &row.id,
        "claim_psbt_built",
        Some(serde_json::json!({
            "destination": dest_str,
            "total_input_sats": total_input_sats,
            "fee_sats": fee_sats,
        })),
    )
    .await?;

    Ok(Json(BuildClaimPsbtResponse {
        psbt_b64,
        total_input_sats,
        output_sats,
        fee_sats,
        network: format!("{:?}", network).to_lowercase(),
        finalized,
    }))
}

/* -------------------------------------------------------------------------- *
 *  broadcast                                                                 *
 * -------------------------------------------------------------------------- */

#[derive(Debug, Deserialize)]
pub struct BroadcastClaimRequest {
    pub signed_psbt_b64: String,
}

#[derive(Debug, Serialize)]
pub struct BroadcastClaimResponse {
    pub txid: String,
    pub explorer_url: String,
}

pub async fn broadcast_claim(
    State(state): State<Arc<AppState>>,
    Path(token): Path<String>,
    Json(req): Json<BroadcastClaimRequest>,
) -> Result<(StatusCode, Json<BroadcastClaimResponse>), ApiError> {
    let row = load_vault_for_claim_token(&state, &token).await?;

    let psbt_bytes = B64
        .decode(req.signed_psbt_b64.trim())
        .map_err(|e| ApiError::Validation(format!("signed_psbt_b64: {e}")))?;
    let mut psbt = Psbt::deserialize(&psbt_bytes)
        .map_err(|e| ApiError::Validation(format!("psbt parse: {e}")))?;

    // Claim the token atomically BEFORE we touch the network. Two
    // parallel broadcast requests against the same token used to be
    // able to both pass the `used_at IS NULL` check in
    // `load_vault_for_claim_token` and race their way to the Esplora
    // submit. We close that window here: only one UPDATE can find
    // `claim_token_used_at IS NULL` and set it; the loser sees zero
    // rows affected and gets a Conflict before any broadcast happens.
    //
    // If the broadcast itself fails after we've claimed the token, we
    // roll the column back to NULL so the heir (or an operator) can
    // retry. A crash between claim and rollback leaves the vault in
    // 'claiming' status — operators can re-enable the token via a
    // manual UPDATE; the on-chain inheritance is unaffected.
    let now_s = Utc::now().to_rfc3339();
    let claimed = sqlx::query(
        r#"UPDATE vaults
              SET status              = 'claiming',
                  claim_token_used_at = ?
            WHERE id = ?
              AND claim_token_used_at IS NULL"#,
    )
    .bind(&now_s)
    .bind(&row.id)
    .execute(&state.db)
    .await?;
    if claimed.rows_affected() != 1 {
        return Err(ApiError::Conflict("claim token already used".into()));
    }

    // Reconstruct a watch-only wallet so BDK can call `finalize` on the
    // PSBT — finalisation walks the descriptor policy to assemble the
    // tapscript witness from the signatures the heir provided.
    let vault_config = VaultConfig {
        descriptor_external: row.descriptor_external.clone(),
        descriptor_internal: row.descriptor_internal.clone(),
        timelock_blocks: row.timelock_blocks as u32,
        network: row.network,
        role: VaultRole::Watchonly,
        label: row.label.clone(),
    };
    let vault = match Vault::from_config(vault_config) {
        Ok(v) => v,
        Err(e) => {
            release_claim_token(&state, &row.id).await;
            return Err(ApiError::Validation(format!("stored vault: {e}")));
        }
    };

    let url = match esplora_url(row.network) {
        Ok(u) => u,
        Err(e) => {
            release_claim_token(&state, &row.id).await;
            return Err(e);
        }
    };
    let network = row.network;
    let txid_result = tokio::task::spawn_blocking(move || -> Result<bitcoin::Txid, BlockingErr> {
        let wallet = ghostkey_core::wallet::build_watch_only(&vault)
            .map_err(|e| BlockingErr::Vault(e.to_string()))?;

        // Finalize PSBT (assemble witnesses; no key material needed —
        // the heir's signatures are already in the PSBT inputs).
        let finalized = wallet
            .finalize_psbt(&mut psbt, SignOptions::default())
            .map_err(|e| BlockingErr::Build(format!("finalize: {e}")))?;
        if !finalized {
            return Err(BlockingErr::Build(
                "PSBT not fully signed; cannot finalize. Sign with the heir's wallet first.".into(),
            ));
        }

        let tx = psbt
            .extract_tx()
            .map_err(|e| BlockingErr::Build(format!("extract_tx: {e}")))?;

        let client = esplora_client::Builder::new(&url).build_blocking();
        client
            .broadcast(&tx)
            .map_err(|e| BlockingErr::Esplora(format!("broadcast: {e}")))?;
        Ok(tx.compute_txid())
    })
    .await;

    let txid = match txid_result {
        Ok(Ok(txid)) => txid,
        Ok(Err(e)) => {
            release_claim_token(&state, &row.id).await;
            return Err(ApiError::from(e));
        }
        Err(e) => {
            release_claim_token(&state, &row.id).await;
            return Err(ApiError::Validation(format!("worker panic: {e}")));
        }
    };

    // Broadcast succeeded — promote 'claiming' to 'claimed'. The
    // `claim_token_used_at` column already records the consumption
    // timestamp from the atomic gate above.
    sqlx::query("UPDATE vaults SET status = 'claimed' WHERE id = ?")
        .bind(&row.id)
        .execute(&state.db)
        .await?;

    record_event(
        &state.db,
        &row.id,
        "claim_broadcast",
        Some(serde_json::json!({
            "txid": txid.to_string(),
        })),
    )
    .await?;

    Ok((
        StatusCode::OK,
        Json(BroadcastClaimResponse {
            txid: txid.to_string(),
            explorer_url: explorer_url(network, &txid),
        }),
    ))
}

/// Undo an atomic claim-token consumption when the broadcast that
/// followed it failed. Best-effort: a DB error here is logged but not
/// propagated, because the caller is already returning an error to the
/// client and we don't want to mask the original cause. If this fails
/// the vault is left in 'claiming' status with `claim_token_used_at`
/// set — an operator can recover via:
///     UPDATE vaults SET status='alarmed', claim_token_used_at=NULL WHERE id=...;
async fn release_claim_token(state: &AppState, vault_id: &str) {
    let res = sqlx::query(
        r#"UPDATE vaults
              SET status              = 'alarmed',
                  claim_token_used_at = NULL
            WHERE id = ?
              AND status = 'claiming'"#,
    )
    .bind(vault_id)
    .execute(&state.db)
    .await;
    if let Err(e) = res {
        tracing::error!(
            vault_id = %vault_id,
            error = ?e,
            "could not release claim token after failed broadcast; manual recovery required"
        );
    }
}

/* -------------------------------------------------------------------------- *
 *  Internals                                                                 *
 * -------------------------------------------------------------------------- */

/// Vault row loaded by claim token. Holds only the fields the PSBT
/// flow actually needs.
struct VaultForClaim {
    id: String,
    label: Option<String>,
    network: Network,
    timelock_blocks: i64,
    descriptor_external: String,
    descriptor_internal: String,
}

/// Look up a vault by claim token. Returns NotFound for unknown tokens,
/// Conflict for already-used tokens. Centralised here so both build and
/// broadcast share the same auth check.
async fn load_vault_for_claim_token(
    state: &AppState,
    token: &str,
) -> Result<VaultForClaim, ApiError> {
    let hash = hash_claim_token(token);

    let row: Option<(
        String,         // id
        Option<String>, // label
        String,         // network
        i64,            // timelock_blocks
        String,         // descriptor_external
        String,         // descriptor_internal
        Option<String>, // claim_token_hash
        Option<String>, // claim_token_used_at
    )> = sqlx::query_as(
        r#"SELECT id, label, network, timelock_blocks,
                  descriptor_external, descriptor_internal,
                  claim_token_hash, claim_token_used_at
             FROM vaults
            WHERE claim_token_hash = ?"#,
    )
    .bind(&hash)
    .fetch_optional(&state.db)
    .await?;

    let row = row.ok_or(ApiError::NotFound)?;
    let (
        id,
        label,
        network_s,
        timelock_blocks,
        descriptor_external,
        descriptor_internal,
        stored_hash,
        used_at,
    ) = row;

    // Defence-in-depth: constant-time compare against the stored hash.
    let stored_hash = stored_hash.ok_or(ApiError::NotFound)?;
    if !claim_token_matches(token, &stored_hash) {
        return Err(ApiError::NotFound);
    }
    if used_at.is_some() {
        return Err(ApiError::Conflict("claim token already used".into()));
    }

    let network = match network_s.as_str() {
        "bitcoin" => Network::Bitcoin,
        "testnet" => Network::Testnet,
        "signet" => Network::Signet,
        "regtest" => Network::Regtest,
        other => {
            return Err(ApiError::Validation(format!(
                "stored vault network {other} is not a known Bitcoin network"
            )))
        }
    };

    Ok(VaultForClaim {
        id,
        label,
        network,
        timelock_blocks,
        descriptor_external,
        descriptor_internal,
    })
}

struct BlockingBuilt {
    total_input_sats: u64,
    output_sats: u64,
    fee_sats: u64,
    finalized: bool,
    psbt_b64: String,
}

/// Error type the blocking workers return. Mapped to `ApiError` at the
/// boundary so the route shape stays clean. `Vault` and `Build` are
/// 400-class (the operator/heir can fix them); `Esplora` and `NoUtxos`
/// are also 400-class but operationally distinct.
#[derive(Debug, thiserror::Error)]
enum BlockingErr {
    #[error("vault: {0}")]
    Vault(String),
    #[error("esplora: {0}")]
    Esplora(String),
    #[error("build: {0}")]
    Build(String),
    #[error("no UTXOs found at vault addresses")]
    NoUtxos,
}

impl From<BlockingErr> for ApiError {
    fn from(e: BlockingErr) -> Self {
        match e {
            BlockingErr::Vault(s) => ApiError::Validation(s),
            BlockingErr::Esplora(s) => ApiError::Validation(s),
            BlockingErr::Build(s) => ApiError::Validation(s),
            BlockingErr::NoUtxos => {
                ApiError::Validation("no UTXOs found at vault addresses".into())
            }
        }
    }
}

/* -------------------------------------------------------------------------- *
 *  Tests                                                                     *
 *  Unit-level only; the blocking-task body that does Esplora I/O is not      *
 *  exercised here.                                                           *
 * -------------------------------------------------------------------------- */

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_esplora_urls_per_network() {
        // Mainnet deliberately has no default: we refuse to leak the
        // descriptor graph to a third-party indexer.
        assert!(default_esplora_url(Network::Bitcoin).is_none());
        assert!(default_esplora_url(Network::Testnet)
            .unwrap()
            .contains("testnet"));
        assert!(default_esplora_url(Network::Signet)
            .unwrap()
            .contains("signet"));
    }

    #[test]
    fn explorer_url_includes_txid() {
        let txid: bitcoin::Txid =
            "0000000000000000000000000000000000000000000000000000000000000001"
                .parse()
                .unwrap();
        let url = explorer_url(Network::Signet, &txid);
        assert!(url.starts_with("https://mempool.space/signet/tx/"));
        assert!(url.ends_with("0000000000000000000000000000000000000000000000000000000000000001"));
    }

    #[test]
    fn esplora_url_respects_env() {
        // SAFETY: this test mutates a process-wide env var. We don't
        // share state with the crypto tests (different module), and
        // both keys are independent — the worst case is an interleave
        // that reads our value briefly, which is harmless.
        unsafe {
            std::env::set_var("GHOSTKEY_ESPLORA_URL", "https://my.indexer/api");
        }
        assert_eq!(
            esplora_url(Network::Bitcoin).unwrap(),
            "https://my.indexer/api"
        );
        unsafe {
            std::env::remove_var("GHOSTKEY_ESPLORA_URL");
        }
        // With the env var cleared, mainnet must refuse rather than
        // fall back to a public indexer.
        assert!(esplora_url(Network::Bitcoin).is_err());
        // Testnet still gets a working default.
        assert!(esplora_url(Network::Testnet).is_ok());
    }

    #[test]
    fn esplora_url_rejects_plain_http_for_mainnet() {
        unsafe {
            std::env::set_var("GHOSTKEY_ESPLORA_URL", "http://my.indexer/api");
        }
        let result = esplora_url(Network::Bitcoin);
        unsafe {
            std::env::remove_var("GHOSTKEY_ESPLORA_URL");
        }
        assert!(result.is_err(), "plain http must be refused for mainnet");
    }
}
