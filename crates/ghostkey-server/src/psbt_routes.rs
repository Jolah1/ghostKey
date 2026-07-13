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
//! The Esplora endpoints come from `GHOSTKEY_ESPLORA_URL` — a single
//! URL or an ordered, comma-separated fallback list; each request tries
//! the entries in turn and fails over on explorer-side errors. If unset
//! we fall back to per-network public endpoints. The defaults are fine
//! for testing and small loads; production deployments should point at
//! their own indexer (and may list public ones after it as fallbacks,
//! accepting the descriptor-privacy trade-off).
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

use std::str::FromStr;
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
use ghostkey_core::psbt::{build_guardian_claim, build_heir_claim};
use ghostkey_core::vault::{Vault, VaultConfig, VaultRole};
use serde::{Deserialize, Serialize};

use crate::crypto::claim_token_matches;
use crate::crypto::hash_claim_token;
use crate::routes::{record_event, ApiError};
use crate::AppState;

/// Default Esplora endpoints for use when `GHOSTKEY_ESPLORA_URL` is
/// unset, in fallback order. These public hosts are convenient for
/// testing but they see every script pubkey we ask about — fine for
/// testnet, signet, and regtest, never appropriate for mainnet.
fn default_esplora_urls(network: Network) -> &'static [&'static str] {
    match network {
        // No default for mainnet: we refuse to leak real vault
        // descriptors to a public indexer. Operators must point
        // `GHOSTKEY_ESPLORA_URL` at an Esplora they control.
        Network::Bitcoin => &[],
        Network::Testnet => &[
            "https://blockstream.info/testnet/api",
            "https://mempool.space/testnet/api",
        ],
        Network::Signet => &[
            "https://mempool.space/signet/api",
            "https://blockstream.info/signet/api",
        ],
        // No public regtest indexer; the operator must set the env var.
        _ => &["http://127.0.0.1:3002"],
    }
}

/// Resolve the ordered Esplora endpoint list for a network, refusing to
/// start a request we can't service. `GHOSTKEY_ESPLORA_URL` accepts a
/// single URL or a comma-separated fallback list, tried left to right.
/// Mainnet requires the env var to be set and every entry to be HTTPS —
/// anything else would leak descriptors or expose requests to a passive
/// attacker.
fn esplora_urls(network: Network) -> Result<Vec<String>, ApiError> {
    match std::env::var("GHOSTKEY_ESPLORA_URL") {
        Ok(raw) => parse_esplora_urls(&raw, network),
        Err(_) => {
            let defaults = default_esplora_urls(network);
            if defaults.is_empty() {
                return Err(ApiError::Validation(
                    "mainnet requires GHOSTKEY_ESPLORA_URL to be set explicitly".into(),
                ));
            }
            Ok(defaults.iter().map(|s| s.to_string()).collect())
        }
    }
}

/// Env-independent core of [`esplora_urls`], split out so tests don't
/// have to mutate process-wide state.
fn parse_esplora_urls(raw: &str, network: Network) -> Result<Vec<String>, ApiError> {
    let urls: Vec<String> = raw
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect();
    if urls.is_empty() {
        return Err(ApiError::Validation(
            "GHOSTKEY_ESPLORA_URL is set but empty".into(),
        ));
    }
    if network == Network::Bitcoin {
        if let Some(bad) = urls.iter().find(|u| !u.starts_with("https://")) {
            return Err(ApiError::Validation(format!(
                "GHOSTKEY_ESPLORA_URL entries must be HTTPS for mainnet; got {bad}"
            )));
        }
    }
    Ok(urls)
}

/// Run an Esplora operation against each endpoint in order, returning
/// the first success. Only explorer-side failures (`BlockingErr::Esplora`)
/// trigger failover — wallet/build errors would fail identically against
/// every endpoint, so they abort immediately. Returns the last endpoint's
/// error when all of them fail.
///
/// The closure is handed a freshly built client per attempt; anything it
/// needs mutable access to (the BDK wallet, the PSBT) is captured by the
/// `FnMut`.
fn try_each_esplora<T, F>(urls: &[String], mut op: F) -> Result<T, BlockingErr>
where
    F: FnMut(&esplora_client::BlockingClient) -> Result<T, BlockingErr>,
{
    let mut last_err = BlockingErr::Esplora("no esplora endpoints configured".into());
    for (i, url) in urls.iter().enumerate() {
        // Per-request socket timeout. The default is unbounded, so a
        // slow/throttling public explorer (mempool.space rate-limits
        // hard) could hang the whole scan past the gateway's 60s cap.
        // Bounding each request lets a stuck endpoint fail over to the
        // next one quickly instead.
        let client = esplora_client::Builder::new(url)
            .timeout(15)
            .build_blocking();
        match op(&client) {
            Ok(v) => return Ok(v),
            Err(e @ BlockingErr::Esplora(_)) => {
                if i + 1 < urls.len() {
                    tracing::warn!(
                        endpoint = %url,
                        error = %e,
                        "esplora endpoint failed; trying next fallback"
                    );
                }
                last_err = e;
            }
            // Not an explorer problem — retrying elsewhere can't help.
            Err(e) => return Err(e),
        }
    }
    Err(last_err)
}

/// Block-explorer URL for a given txid, following whatever indexer the
/// server actually uses. Reads `GHOSTKEY_ESPLORA_URL` so a custom indexer
/// (mutinynet, a self-hosted Esplora) gets a link that resolves, instead of
/// always pointing at mempool.space (#152).
pub(crate) fn explorer_url(network: Network, txid: &bitcoin::Txid) -> String {
    let esplora = std::env::var("GHOSTKEY_ESPLORA_URL").ok();
    format!("{}/{txid}", explorer_base(esplora.as_deref(), network))
}

/// Env-independent core of [`explorer_url`], split out so tests don't have
/// to mutate process-wide state.
///
/// An Esplora indexer's web explorer almost always lives at the same host
/// with the `/api` suffix dropped (`https://mutinynet.com/api` →
/// `https://mutinynet.com`), so when an explicit indexer is configured we
/// derive the explorer base from it. With no indexer set we keep the
/// per-network `mempool.space` defaults, so production is unchanged.
fn explorer_base(esplora_url: Option<&str>, network: Network) -> String {
    if let Some(raw) = esplora_url {
        // A comma-separated fallback list is allowed; the first entry is the
        // primary indexer, so base the link on it.
        if let Some(first) = raw.split(',').map(str::trim).find(|s| !s.is_empty()) {
            let base = first.trim_end_matches('/');
            let base = base.strip_suffix("/api").unwrap_or(base);
            let base = base.trim_end_matches('/');
            return format!("{base}/tx");
        }
    }
    match network {
        Network::Bitcoin => "https://mempool.space/tx".to_string(),
        Network::Testnet => "https://mempool.space/testnet/tx".to_string(),
        Network::Signet => "https://mempool.space/signet/tx".to_string(),
        _ => "https://example.invalid/tx".to_string(),
    }
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
    let urls = esplora_urls(row.network)?;
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

            // Full scan: walk both keychains, stop after 5 unused gap.
            // Failover walks the endpoint list; the scan request is
            // rebuilt per attempt because `full_scan` consumes it.
            let update = try_each_esplora(&urls, |client| {
                client
                    .full_scan(wallet.start_full_scan(), 5, 1)
                    .map_err(|e| clean_esplora_err("full_scan", &e))
            })?;
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

    let urls = match esplora_urls(row.network) {
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

        // Broadcasting the same tx twice is idempotent, so failing over
        // mid-broadcast (first endpoint accepted it but errored on the
        // response) is harmless.
        try_each_esplora(&urls, |client| {
            client
                .broadcast(&tx)
                .map_err(|e| clean_esplora_err("broadcast", &e))
        })?;
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
///     UPDATE vaults SET status='timelock_started', claim_token_used_at=NULL WHERE id=...;
///
/// We revert to `timelock_started` (not `alarmed`) on purpose: the heir
/// has the claim link already and can retry it. Going back to `alarmed`
/// would re-match the scheduler's `transition_alarmed_to_claimable`
/// filter on every tick — for password-vault rows the second clause
/// `claim_token_at_rest_b64 IS NOT NULL` keeps re-issuing the same
/// notification, spamming the heir.
async fn release_claim_token(state: &AppState, vault_id: &str) {
    let res = sqlx::query(
        r#"UPDATE vaults
              SET status              = 'timelock_started',
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
 *  Sealed-heir-xprv resolver + one-shot heir claim                           *
 *                                                                            *
 *  These two endpoints implement the password-vault claim flow:              *
 *                                                                            *
 *    GET /claim/:token/sealed-heir                                           *
 *        Returns the heir's xprv ciphertext + nonce + the vault              *
 *        network and timelock. The browser unwraps the ciphertext            *
 *        locally using HKDF(claim_token) — the same KEK the setup            *
 *        browser used to seal it. The server cannot open this blob.          *
 *                                                                            *
 *    POST /claim/:token/heir-claim                                           *
 *        Body: { destination, fee_rate_sat_per_vb?, heir_xprv }              *
 *        The browser ships the just-unwrapped heir xprv over TLS in          *
 *        the request body. The server builds the heir-claim PSBT             *
 *        (BDK script-path selection), signs it with the supplied             *
 *        xprv in-memory only, broadcasts, marks the claim consumed,          *
 *        and discards the xprv. The xprv is never written to disk or         *
 *        logs.                                                               *
 *                                                                            *
 *  Why is this not "custodial"? At the moment of this call:                  *
 *    - the on-chain timelock has matured (otherwise the broadcast fails)     *
 *    - only the heir's key can spend the funds                               *
 *    - the request must arrive over TLS from the holder of the claim token   *
 *    - the server signs, broadcasts, and discards in a single function       *
 *      scope; no persistence                                                  *
 *  An attacker who briefly compromises the server during this call could     *
 *  redirect funds *to themselves*, but only to a Bitcoin address that        *
 *  Bitcoin's UTXO set then records publicly. The legitimate heir would       *
 *  detect this immediately via mempool.space. This is the same exposure      *
 *  a hardware-wallet signer faces when its host is compromised.              *
 * -------------------------------------------------------------------------- */

#[derive(Debug, Serialize)]
pub struct SealedHeirView {
    pub vault_id: String,
    pub network: String,
    pub timelock_blocks: i64,
    pub heir_xprv_ct_b64: String,
    pub heir_xprv_nonce_b64: String,
    /// Public watch-only descriptor pair. Returned so the heir's
    /// browser can build a self-contained recovery file (block B):
    /// it needs the owner xpub (which only the descriptor carries) to
    /// derive the vault's addresses and sign the timelocked branch
    /// offline. No private material — safe for any valid claim token.
    pub descriptor_external: String,
    pub descriptor_internal: String,
}

/// Friendly, plain-text wait message for a not-yet-matured claim. The
/// claim page renders its own dated screen from the estimate; this is the
/// backstop for anyone (or any tooling) hitting the API directly.
fn unlock_wait_message(view: &UnlockEstimateView) -> String {
    match &view.unlock_eta {
        Some(eta) => format!(
            "These funds unlock on the Bitcoin network around {eta}. \
             Come back then — we'll email you when it's ready."
        ),
        None => "We're still confirming your funds on the Bitcoin network. \
             Check back shortly."
            .into(),
    }
}

/// GET /claim/:token/unlock-estimate
///
/// Heir-facing: when can these funds actually move? The claim page reads
/// this once past the safety window so it can show an honest "unlocks
/// around <date>" screen instead of letting the heir hit a dead-end
/// broadcast. Token-gated like the other claim routes; no key material.
pub async fn claim_unlock_estimate(
    State(state): State<Arc<AppState>>,
    Path(token): Path<String>,
) -> Result<Json<UnlockEstimateView>, ApiError> {
    let hash = hash_claim_token(&token);
    type Row = (
        String,         // id
        String,         // network
        i64,            // timelock_blocks
        Option<String>, // claim_token_hash
        Option<String>, // claim_token_used_at
        String,         // descriptor_external
        String,         // descriptor_internal
        Option<i64>,    // chain_unlock_height
        Option<i64>,    // chain_tip_height
        Option<String>, // chain_scanned_at
    );
    let row: Option<Row> = sqlx::query_as(
        r#"SELECT id, network, timelock_blocks,
                  claim_token_hash, claim_token_used_at,
                  descriptor_external, descriptor_internal,
                  chain_unlock_height, chain_tip_height, chain_scanned_at
             FROM vaults
            WHERE claim_token_hash = ?"#,
    )
    .bind(&hash)
    .fetch_optional(&state.db)
    .await?;
    let row = row.ok_or(ApiError::NotFound)?;
    let stored_hash = row.3.clone().ok_or(ApiError::NotFound)?;
    if !claim_token_matches(&token, &stored_hash) {
        return Err(ApiError::NotFound);
    }
    if row.4.is_some() {
        return Err(ApiError::Conflict("claim token already used".into()));
    }
    let now = Utc::now();
    let input = EstimateInput {
        vault_id: row.0,
        descriptor_external: row.5,
        descriptor_internal: row.6,
        network: row.1,
        timelock_blocks: row.2,
        cached_unlock_height: row.7,
        cached_tip_height: row.8,
        cached_scanned_at: row.9,
    };
    let est = unlock_estimate_with_cache(&state.db, &input, now).await?;
    Ok(Json(UnlockEstimateView::from_estimate(&est, now)))
}

pub async fn get_sealed_heir_xprv(
    State(state): State<Arc<AppState>>,
    Path(token): Path<String>,
) -> Result<Json<SealedHeirView>, ApiError> {
    let hash = hash_claim_token(&token);
    type Row = (
        String,         // id
        String,         // network
        i64,            // timelock
        Option<String>, // claim_token_hash
        Option<String>, // claim_token_used_at
        Option<String>, // heir_xprv_ct
        Option<String>, // heir_xprv_nonce
        String,         // descriptor_external
        String,         // descriptor_internal
        Option<i64>,    // chain_unlock_height
        Option<i64>,    // chain_tip_height
        Option<String>, // chain_scanned_at
    );
    let row: Option<Row> = sqlx::query_as(
        r#"SELECT id, network, timelock_blocks,
                  claim_token_hash, claim_token_used_at,
                  heir_xprv_sealed_ct_b64, heir_xprv_sealed_nonce,
                  descriptor_external, descriptor_internal,
                  chain_unlock_height, chain_tip_height, chain_scanned_at
             FROM vaults
            WHERE claim_token_hash = ?"#,
    )
    .bind(&hash)
    .fetch_optional(&state.db)
    .await?;
    let row = row.ok_or(ApiError::NotFound)?;
    let stored_hash = row.3.ok_or(ApiError::NotFound)?;
    if !claim_token_matches(&token, &stored_hash) {
        return Err(ApiError::NotFound);
    }
    if row.4.is_some() {
        return Err(ApiError::Conflict("claim token already used".into()));
    }
    // Claim-challenge window: the sealed xprv is the vault. Handing it
    // out before the window closes would let a hijacked claim link
    // bypass the server-side gates entirely (the holder could sign and
    // broadcast on their own once the on-chain timelock matures).
    if let Some(available) = crate::routes::ensure_claim_challenge(&state, &row.0).await? {
        return Err(ApiError::Conflict(format!(
            "safety waiting period — this claim can be completed after {}",
            available.to_rfc3339()
        )));
    }
    // On-chain maturity (Fix A): even past the challenge window the funds
    // can't move until the CSV timelock matures. Don't release the key
    // on a false "go" — return the real unlock date instead. If the chain
    // can't be reached, withhold the key rather than guess.
    {
        let now = Utc::now();
        let input = EstimateInput {
            vault_id: row.0.clone(),
            descriptor_external: row.7.clone(),
            descriptor_internal: row.8.clone(),
            network: row.1.clone(),
            timelock_blocks: row.2,
            cached_unlock_height: row.9,
            cached_tip_height: row.10,
            cached_scanned_at: row.11.clone(),
        };
        match unlock_estimate_with_cache(&state.db, &input, now).await {
            Ok(est) => {
                let view = UnlockEstimateView::from_estimate(&est, now);
                if !view.matured {
                    return Err(ApiError::Conflict(unlock_wait_message(&view)));
                }
            }
            Err(e) => {
                return Err(ApiError::Validation(format!(
                    "couldn't reach the Bitcoin network to check the timelock; \
                     please try again shortly ({e})"
                )));
            }
        }
    }
    let ct = row.5.ok_or_else(|| {
        ApiError::Validation(
            "this vault was not created with a password and has no sealed heir key".into(),
        )
    })?;
    let nonce = row.6.ok_or_else(|| {
        ApiError::Validation("vault has heir_xprv_sealed_ct without nonce".into())
    })?;
    Ok(Json(SealedHeirView {
        vault_id: row.0,
        network: row.1,
        timelock_blocks: row.2,
        heir_xprv_ct_b64: ct,
        heir_xprv_nonce_b64: nonce,
        descriptor_external: row.7,
        descriptor_internal: row.8,
    }))
}

/* -------------------------------------------------------------------------- *
 *  One-shot heir claim: build + sign + broadcast in one call.                *
 *                                                                            *
 *  This is the password-vault counterpart to the existing two-step           *
 *  `build-psbt` + `broadcast` flow. Today's flow assumes the heir holds      *
 *  their own xprv in a hardware/desktop wallet — the server hands them       *
 *  an unsigned PSBT, they sign in Sparrow/etc, paste back. For users         *
 *  who don't own Bitcoin yet, that's a non-starter. With the password        *
 *  vault, the heir's xprv is wrapped server-side and the browser unwraps     *
 *  it via the URL fragment. Once unwrapped, the simplest path is to          *
 *  ship the xprv over TLS to the server, which BDK-signs and broadcasts.    *
 *                                                                            *
 *  Why not sign client-side? The PSBT-script-path signing for the Taproot   *
 *  heir branch (with policy_path selecting the timelock leaf, BIP371        *
 *  tap_scripts metadata, etc.) is fiddly. We have a tested server-side      *
 *  signer (`build_heir_claim` + BDK + signing wallet). Re-implementing      *
 *  that in the browser would add ~40 KB of audited Bitcoin code AND        *
 *  novel script-path signing logic. For the moment of signing, the         *
 *  on-chain timelock has already matured — even if an attacker were         *
 *  watching the TLS request, the only key in scope is one only the         *
 *  heir benefits from spending.                                             *
 * -------------------------------------------------------------------------- */

// No `Debug` derive on purpose: this carries an unsealed private key
// (`heir_xprv`). Deriving Debug would let a stray `?req` log leak it.
#[derive(Deserialize)]
pub struct HeirClaimRequest {
    /// Bitcoin address the heir wants the funds to land at.
    pub destination: String,
    /// Optional fee rate in sat/vB. Defaults to 2 sat/vB.
    #[serde(default)]
    pub fee_rate_sat_per_vb: Option<u64>,
    /// Heir account xprv, base58 (`tprv...` on testnet/signet/regtest,
    /// `xprv...` on mainnet). The browser unwraps this from the
    /// sealed blob using the claim token in the URL fragment, then
    /// sends it here over TLS. Held in memory only for the duration
    /// of this call.
    pub heir_xprv: String,
}

pub async fn heir_claim(
    State(state): State<Arc<AppState>>,
    Path(token): Path<String>,
    Json(req): Json<HeirClaimRequest>,
) -> Result<(StatusCode, Json<BroadcastClaimResponse>), ApiError> {
    let row = load_vault_for_claim_token(&state, &token).await?;

    // Parse destination address up-front so we fail fast on user typos.
    let dest = req
        .destination
        .trim()
        .parse::<Address<bitcoin::address::NetworkUnchecked>>()
        .map_err(|e| ApiError::Validation(format!("destination: {e}")))?;
    if !dest.is_valid_for_network(row.network) {
        return Err(ApiError::Validation(format!(
            "destination is not valid for {:?}",
            row.network
        )));
    }
    let dest = dest.assume_checked();
    let dest_str = dest.to_string();

    let fee_rate_sat_per_kwu = req.fee_rate_sat_per_vb.unwrap_or(2).max(1) * 250;
    let fee_rate = FeeRate::from_sat_per_kwu(fee_rate_sat_per_kwu);

    // Parse the heir xprv. `from_str` rejects anything that isn't a
    // valid base58 BIP32 xprv on the parameter's network.
    let heir_xprv = bitcoin::bip32::Xpriv::from_str(req.heir_xprv.trim())
        .map_err(|e| ApiError::Validation(format!("heir_xprv: {e}")))?;
    // Sanity: the xprv's network must match the vault.
    if heir_xprv.network != row.network.into() {
        return Err(ApiError::Validation(format!(
            "heir_xprv is for network {:?}, vault is for {:?}",
            heir_xprv.network, row.network
        )));
    }

    // Atomic claim-token consumption (same gate as the two-step flow).
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

    // Construct the heir-side signing wallet. The browser ships the
    // *account* xprv (m/86'/coin'/0'), which is what BDK splices into
    // the descriptor at `build_signing`'s call site. But that helper
    // wants the *master* xprv — and we just received an account xprv.
    // The account xprv at m/86'/coin'/0' is itself a valid Xpriv that
    // BDK can use, provided we splice it in at the matching origin.
    // We pass it through a thin adapter that produces the same wallet
    // shape as if we had the master.
    let vault_config = VaultConfig {
        descriptor_external: row.descriptor_external.clone(),
        descriptor_internal: row.descriptor_internal.clone(),
        timelock_blocks: row.timelock_blocks as u32,
        network: row.network,
        role: VaultRole::Heir,
        label: row.label.clone(),
    };
    let vault = match Vault::from_config(vault_config) {
        Ok(v) => v,
        Err(e) => {
            release_claim_token(&state, &row.id).await;
            return Err(ApiError::Validation(format!("stored vault: {e}")));
        }
    };

    let urls = match esplora_urls(row.network) {
        Ok(u) => u,
        Err(e) => {
            release_claim_token(&state, &row.id).await;
            return Err(e);
        }
    };
    let network = row.network;

    let vault_id = row.id.clone();
    let result =
        tokio::task::spawn_blocking(move || -> Result<(bitcoin::Txid, u64, u64), BlockingErr> {
            let mut wallet = ghostkey_core::wallet::build_signing_from_account(&vault, &heir_xprv)
                .map_err(|e| BlockingErr::Vault(e.to_string()))?;

            let update = try_each_esplora(&urls, |client| {
                client
                    .full_scan(wallet.start_full_scan(), 5, 1)
                    .map_err(|e| clean_esplora_err("full_scan", &e))
            })?;
            wallet
                .apply_update(update)
                .map_err(|e| BlockingErr::Esplora(format!("apply_update: {e}")))?;

            let total = wallet.balance().total().to_sat();
            if total == 0 {
                return Err(BlockingErr::NoUtxos);
            }

            let mut built =
                ghostkey_core::psbt::build_heir_claim(&mut wallet, &vault, &dest, fee_rate)
                    .map_err(|e| BlockingErr::Build(e.to_string()))?;
            if !built.finalized {
                // Try one more sign pass with SignOptions tuned for
                // script-path Taproot. BDK occasionally returns
                // finalized=false on the first call when CSV gating
                // requires a specific nSequence already on the PSBT.
                let _ = wallet
                    .sign(&mut built.psbt, SignOptions::default())
                    .map_err(|e| BlockingErr::Build(format!("re-sign: {e}")))?;
                let fin = wallet
                    .finalize_psbt(&mut built.psbt, SignOptions::default())
                    .map_err(|e| BlockingErr::Build(format!("finalize: {e}")))?;
                if !fin {
                    return Err(BlockingErr::Build(
                        "PSBT could not be finalised; the timelock may not have matured yet".into(),
                    ));
                }
            }
            let tx = built
                .psbt
                .extract_tx()
                .map_err(|e| BlockingErr::Build(format!("extract_tx: {e}")))?;
            try_each_esplora(&urls, |client| {
                client
                    .broadcast(&tx)
                    .map_err(|e| clean_esplora_err("broadcast", &e))
            })?;
            let txid = tx.compute_txid();
            let out_sats: u64 = tx.output.iter().map(|o| o.value.to_sat()).sum();
            let fee = total.saturating_sub(out_sats);
            Ok((txid, total, fee))
        })
        .await;

    let (txid, total_in, fee) = match result {
        Ok(Ok(v)) => v,
        Ok(Err(e)) => {
            release_claim_token(&state, &vault_id).await;
            return Err(ApiError::from(e));
        }
        Err(e) => {
            release_claim_token(&state, &vault_id).await;
            return Err(ApiError::Validation(format!("worker panic: {e}")));
        }
    };

    sqlx::query("UPDATE vaults SET status = 'claimed' WHERE id = ?")
        .bind(&vault_id)
        .execute(&state.db)
        .await?;

    record_event(
        &state.db,
        &vault_id,
        "claim_broadcast",
        Some(serde_json::json!({
            "txid": txid.to_string(),
            "destination": dest_str,
            "total_input_sats": total_in,
            "fee_sats": fee,
            "flow": "heir-claim-one-shot",
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

/* -------------------------------------------------------------------------- *
 *  Guardian vault claim (#81)                                                 *
 *                                                                            *
 *  A guardian vault's spend branch is `heir AND (g1 OR g2)`. Completing it    *
 *  needs TWO keys: the heir's and one guardian's. Each party's key is         *
 *  sealed under its own claim token (the heir's inline on `vaults`, each      *
 *  guardian's in `vault_guardian_keys`).                                      *
 *                                                                            *
 *    GET  /claim/:token/sealed-guardian                                       *
 *        :token is a GUARDIAN token. Returns that guardian's sealed xprv      *
 *        ct/nonce (the browser unwraps it locally with the token, like the    *
 *        heir's sealed-heir) plus the watch-only descriptors. Gated on the    *
 *        vault's claim-token-used flag and the challenge window.              *
 *                                                                            *
 *    POST /claim/:token/guardian-claim                                        *
 *        :token is the HEIR token (the vault's inline claim token, which      *
 *        this call consumes). Body carries BOTH unwrapped account xprvs.      *
 *        The server splices both into the descriptor (`build_signing_guardian`*
 *        + `build_guardian_claim`), signs, broadcasts, and discards. Same     *
 *        in-memory-only key contract as the one-shot heir claim above.        *
 * -------------------------------------------------------------------------- */

#[derive(Debug, Serialize)]
pub struct SealedGuardianView {
    pub vault_id: String,
    /// Which guardian slot (1 or 2) this token belongs to.
    pub slot: i64,
    pub network: String,
    pub timelock_blocks: i64,
    pub guardian_xprv_ct_b64: String,
    pub guardian_xprv_nonce_b64: String,
    pub descriptor_external: String,
    pub descriptor_internal: String,
}

pub async fn get_sealed_guardian_xprv(
    State(state): State<Arc<AppState>>,
    Path(token): Path<String>,
) -> Result<Json<SealedGuardianView>, ApiError> {
    let hash = hash_claim_token(&token);
    // Join the guardian row to its vault: we need the guardian's sealed
    // key + slot, and the vault's descriptors/network/timelock plus its
    // claim-consumption flag (the whole claim is gated on the inline
    // heir token, so once the vault claim lands no guardian key is handed
    // out either).
    type Row = (
        String,         // vault_id
        i64,            // slot
        Option<String>, // g.claim_token_hash
        String,         // g.xprv_sealed_ct_b64
        String,         // g.xprv_sealed_nonce
        String,         // v.network
        i64,            // v.timelock_blocks
        String,         // v.descriptor_external
        String,         // v.descriptor_internal
        Option<String>, // v.claim_token_used_at
    );
    let row: Option<Row> = sqlx::query_as(
        r#"SELECT g.vault_id, g.slot, g.claim_token_hash,
                  g.xprv_sealed_ct_b64, g.xprv_sealed_nonce,
                  v.network, v.timelock_blocks,
                  v.descriptor_external, v.descriptor_internal,
                  v.claim_token_used_at
             FROM vault_guardian_keys g
             JOIN vaults v ON v.id = g.vault_id
            WHERE g.claim_token_hash = ?"#,
    )
    .bind(&hash)
    .fetch_optional(&state.db)
    .await?;
    let row = row.ok_or(ApiError::NotFound)?;
    let stored_hash = row.2.ok_or(ApiError::NotFound)?;
    if !claim_token_matches(&token, &stored_hash) {
        return Err(ApiError::NotFound);
    }
    if row.9.is_some() {
        return Err(ApiError::Conflict("claim already completed".into()));
    }
    // Same challenge-window gate as the heir's sealed-key endpoint: the
    // sealed xprv is half the vault; don't hand it out before the owner's
    // objection window closes.
    if let Some(available) = crate::routes::ensure_claim_challenge(&state, &row.0).await? {
        return Err(ApiError::Conflict(format!(
            "safety waiting period — this claim can be completed after {}",
            available.to_rfc3339()
        )));
    }
    Ok(Json(SealedGuardianView {
        vault_id: row.0,
        slot: row.1,
        network: row.5,
        timelock_blocks: row.6,
        guardian_xprv_ct_b64: row.3,
        guardian_xprv_nonce_b64: row.4,
        descriptor_external: row.7,
        descriptor_internal: row.8,
    }))
}

// No `Debug` derive on purpose: this carries two unsealed private keys
// (`heir_xprv`, `guardian_xprv`). Deriving Debug would risk leaking them.
#[derive(Deserialize)]
pub struct GuardianClaimRequest {
    /// Bitcoin address the funds should land at.
    pub destination: String,
    /// Optional fee rate in sat/vB. Defaults to 2 sat/vB.
    #[serde(default)]
    pub fee_rate_sat_per_vb: Option<u64>,
    /// Heir account xprv, unwrapped by the browser from the sealed-heir
    /// blob via the heir's claim token. Memory-only.
    pub heir_xprv: String,
    /// One guardian's account xprv, unwrapped by the browser from the
    /// sealed-guardian blob via that guardian's claim token. Memory-only.
    pub guardian_xprv: String,
}

pub async fn guardian_claim(
    State(state): State<Arc<AppState>>,
    Path(token): Path<String>,
    Json(req): Json<GuardianClaimRequest>,
) -> Result<(StatusCode, Json<BroadcastClaimResponse>), ApiError> {
    // :token is the heir (inline) token — the vault's primary claim token.
    let row = load_vault_for_claim_token(&state, &token).await?;

    let dest = req
        .destination
        .trim()
        .parse::<Address<bitcoin::address::NetworkUnchecked>>()
        .map_err(|e| ApiError::Validation(format!("destination: {e}")))?;
    if !dest.is_valid_for_network(row.network) {
        return Err(ApiError::Validation(format!(
            "destination is not valid for {:?}",
            row.network
        )));
    }
    let dest = dest.assume_checked();
    let dest_str = dest.to_string();

    let fee_rate_sat_per_kwu = req.fee_rate_sat_per_vb.unwrap_or(2).max(1) * 250;
    let fee_rate = FeeRate::from_sat_per_kwu(fee_rate_sat_per_kwu);

    // Parse both account xprvs. Both must match the vault network.
    let heir_xprv = bitcoin::bip32::Xpriv::from_str(req.heir_xprv.trim())
        .map_err(|e| ApiError::Validation(format!("heir_xprv: {e}")))?;
    let guardian_xprv = bitcoin::bip32::Xpriv::from_str(req.guardian_xprv.trim())
        .map_err(|e| ApiError::Validation(format!("guardian_xprv: {e}")))?;
    if heir_xprv.network != row.network.into() {
        return Err(ApiError::Validation(format!(
            "heir_xprv is for network {:?}, vault is for {:?}",
            heir_xprv.network, row.network
        )));
    }
    if guardian_xprv.network != row.network.into() {
        return Err(ApiError::Validation(format!(
            "guardian_xprv is for network {:?}, vault is for {:?}",
            guardian_xprv.network, row.network
        )));
    }

    // Atomic claim-token consumption — same gate as the heir flow. The
    // guardian keys live under the same vault, so consuming the inline
    // token closes the whole claim (including the sealed-guardian route).
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

    let vault_config = VaultConfig {
        descriptor_external: row.descriptor_external.clone(),
        descriptor_internal: row.descriptor_internal.clone(),
        timelock_blocks: row.timelock_blocks as u32,
        network: row.network,
        role: VaultRole::Heir,
        label: row.label.clone(),
    };
    let vault = match Vault::from_config(vault_config) {
        Ok(v) => v,
        Err(e) => {
            release_claim_token(&state, &row.id).await;
            return Err(ApiError::Validation(format!("stored vault: {e}")));
        }
    };

    let urls = match esplora_urls(row.network) {
        Ok(u) => u,
        Err(e) => {
            release_claim_token(&state, &row.id).await;
            return Err(e);
        }
    };
    let network = row.network;
    let vault_id = row.id.clone();

    let result =
        tokio::task::spawn_blocking(move || -> Result<(bitcoin::Txid, u64, u64), BlockingErr> {
            // Both keys spliced in → the loaded-key satisfier picks the
            // heir + this-guardian path automatically (same as the offline
            // two-key recovery flow).
            let mut wallet =
                ghostkey_core::wallet::build_signing_guardian(&vault, &heir_xprv, &guardian_xprv)
                    .map_err(|e| BlockingErr::Vault(e.to_string()))?;

            let update = try_each_esplora(&urls, |client| {
                client
                    .full_scan(wallet.start_full_scan(), 5, 1)
                    .map_err(|e| clean_esplora_err("full_scan", &e))
            })?;
            wallet
                .apply_update(update)
                .map_err(|e| BlockingErr::Esplora(format!("apply_update: {e}")))?;

            let total = wallet.balance().total().to_sat();
            if total == 0 {
                return Err(BlockingErr::NoUtxos);
            }

            let mut built = build_guardian_claim(&mut wallet, &vault, &dest, fee_rate)
                .map_err(|e| BlockingErr::Build(e.to_string()))?;
            if !built.finalized {
                let _ = wallet
                    .sign(&mut built.psbt, SignOptions::default())
                    .map_err(|e| BlockingErr::Build(format!("re-sign: {e}")))?;
                let fin = wallet
                    .finalize_psbt(&mut built.psbt, SignOptions::default())
                    .map_err(|e| BlockingErr::Build(format!("finalize: {e}")))?;
                if !fin {
                    return Err(BlockingErr::Build(
                        "PSBT could not be finalised; the timelock may not have matured yet".into(),
                    ));
                }
            }
            let tx = built
                .psbt
                .extract_tx()
                .map_err(|e| BlockingErr::Build(format!("extract_tx: {e}")))?;
            try_each_esplora(&urls, |client| {
                client
                    .broadcast(&tx)
                    .map_err(|e| clean_esplora_err("broadcast", &e))
            })?;
            let txid = tx.compute_txid();
            let out_sats: u64 = tx.output.iter().map(|o| o.value.to_sat()).sum();
            let fee = total.saturating_sub(out_sats);
            Ok((txid, total, fee))
        })
        .await;

    let (txid, total_in, fee) = match result {
        Ok(Ok(v)) => v,
        Ok(Err(e)) => {
            release_claim_token(&state, &vault_id).await;
            return Err(ApiError::from(e));
        }
        Err(e) => {
            release_claim_token(&state, &vault_id).await;
            return Err(ApiError::Validation(format!("worker panic: {e}")));
        }
    };

    sqlx::query("UPDATE vaults SET status = 'claimed' WHERE id = ?")
        .bind(&vault_id)
        .execute(&state.db)
        .await?;

    record_event(
        &state.db,
        &vault_id,
        "claim_broadcast",
        Some(serde_json::json!({
            "txid": txid.to_string(),
            "destination": dest_str,
            "total_input_sats": total_in,
            "fee_sats": fee,
            "flow": "guardian-claim-two-key",
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

/* -------------------------------------------------------------------------- *
 *  POST /vaults/:id/send — owner spends from the vault                       *
 *                                                                            *
 *  The owner-side counterpart to the one-shot heir claim above, with the     *
 *  same key-handling contract: the browser unseals the owner's account       *
 *  xprv locally (password → Argon2id KEK → XChaCha20 open), ships it over    *
 *  TLS in the request body, and the server signs in memory, broadcasts,      *
 *  and discards. Nothing is persisted; the xprv never reaches disk or        *
 *  logs. See the heir-claim block comment for why this transit is the       *
 *  pragmatic choice over browser-side Taproot script-path signing.          *
 *                                                                            *
 *  Unlike the heir flow there is no timelock to lean on — the owner          *
 *  branch is spendable immediately — but the request is OwnerAuth-gated      *
 *  AND requires the password (to unseal the xprv client-side), so a          *
 *  stolen bearer token alone cannot move funds.                              *
 *                                                                            *
 *  Partial sends route change back to the vault's internal keychain:        *
 *  the remainder stays under the same inheritance descriptor and its        *
 *  heir countdown restarts at the new confirmation, like a check-in.        *
 * -------------------------------------------------------------------------- */

// No `Debug` derive on purpose: this carries an unsealed private key
// (`owner_xprv`). Deriving Debug would let a stray `?req` log leak it.
#[derive(Deserialize)]
pub struct OwnerSendRequest {
    /// Bitcoin address to pay. Must match the vault's network.
    pub destination: String,
    /// Amount in sats. Absent/null = send everything (drain).
    #[serde(default)]
    pub amount_sat: Option<u64>,
    /// Optional fee rate in sat/vB. Defaults to 2 sat/vB.
    #[serde(default)]
    pub fee_rate_sat_per_vb: Option<u64>,
    /// Owner account xprv, unsealed by the browser. Memory-only.
    pub owner_xprv: String,
}

#[derive(Debug, Serialize)]
pub struct OwnerSendResponse {
    pub txid: String,
    pub explorer_url: String,
    /// Sats that landed at the destination.
    pub sent_sat: u64,
    pub fee_sat: u64,
    /// Sats returned to the vault as change (0 on a full drain).
    pub remaining_sat: u64,
}

pub async fn owner_send(
    auth: crate::auth::OwnerAuth,
    State(state): State<Arc<AppState>>,
    Json(req): Json<OwnerSendRequest>,
) -> Result<(StatusCode, Json<OwnerSendResponse>), ApiError> {
    let id = auth.vault_id;

    type Row = (Option<String>, String, i64, String, String); // label, network, timelock, ext, int
    let row: Option<Row> = sqlx::query_as(
        r#"SELECT label, network, timelock_blocks,
                  descriptor_external, descriptor_internal
             FROM vaults WHERE id = ?"#,
    )
    .bind(&id)
    .fetch_optional(&state.db)
    .await?;
    let (label, network_s, timelock_blocks, descriptor_external, descriptor_internal) =
        row.ok_or(ApiError::NotFound)?;
    let network = crate::config::parse_network(&network_s).map_err(|name| {
        ApiError::Validation(format!(
            "stored vault network {name} is not a known Bitcoin network"
        ))
    })?;

    let dest = req
        .destination
        .trim()
        .parse::<Address<bitcoin::address::NetworkUnchecked>>()
        .map_err(|e| ApiError::Validation(format!("destination: {e}")))?;
    if !dest.is_valid_for_network(network) {
        return Err(ApiError::Validation(format!(
            "destination is not valid for {network:?}"
        )));
    }
    let dest = dest.assume_checked();
    let dest_str = dest.to_string();

    if req.amount_sat == Some(0) {
        return Err(ApiError::Validation("amount_sat must be at least 1".into()));
    }
    let amount_sat = req.amount_sat;

    let fee_rate_sat_per_kwu = req.fee_rate_sat_per_vb.unwrap_or(2).max(1) * 250;
    let fee_rate = FeeRate::from_sat_per_kwu(fee_rate_sat_per_kwu);

    let owner_xprv = bitcoin::bip32::Xpriv::from_str(req.owner_xprv.trim())
        .map_err(|e| ApiError::Validation(format!("owner_xprv: {e}")))?;
    if owner_xprv.network != network.into() {
        return Err(ApiError::Validation(format!(
            "owner_xprv is for network {:?}, vault is for {network:?}",
            owner_xprv.network
        )));
    }

    let vault_config = VaultConfig {
        descriptor_external,
        descriptor_internal,
        timelock_blocks: timelock_blocks as u32,
        network,
        role: VaultRole::Owner,
        label,
    };
    let vault = Vault::from_config(vault_config)
        .map_err(|e| ApiError::Validation(format!("stored vault: {e}")))?;

    let urls = esplora_urls(network)?;
    let dest_spk = dest.script_pubkey();

    let (txid, total_in, sent_sat, fee_sat, remaining_sat) = tokio::task::spawn_blocking(
        move || -> Result<(bitcoin::Txid, u64, u64, u64, u64), BlockingErr> {
            let mut wallet = ghostkey_core::wallet::build_signing_from_account(&vault, &owner_xprv)
                .map_err(|e| BlockingErr::Vault(e.to_string()))?;

            let update = try_each_esplora(&urls, |client| {
                client
                    .full_scan(wallet.start_full_scan(), 5, 1)
                    .map_err(|e| clean_esplora_err("full_scan", &e))
            })?;
            wallet
                .apply_update(update)
                .map_err(|e| BlockingErr::Esplora(format!("apply_update: {e}")))?;

            let total = wallet.balance().total().to_sat();
            if total == 0 {
                return Err(BlockingErr::NoUtxos);
            }

            let mut built = ghostkey_core::psbt::build_owner_send(
                &mut wallet,
                &vault,
                &dest,
                amount_sat,
                fee_rate,
            )
            .map_err(|e| BlockingErr::Build(e.to_string()))?;
            if !built.finalized {
                // Same belt-and-braces pass as the heir claim: BDK can
                // report finalized=false on the first sign call for
                // Taproot script-path spends.
                let _ = wallet
                    .sign(&mut built.psbt, SignOptions::default())
                    .map_err(|e| BlockingErr::Build(format!("re-sign: {e}")))?;
                let fin = wallet
                    .finalize_psbt(&mut built.psbt, SignOptions::default())
                    .map_err(|e| BlockingErr::Build(format!("finalize: {e}")))?;
                if !fin {
                    return Err(BlockingErr::Build(
                        "PSBT could not be finalised; the supplied key may not match this vault"
                            .into(),
                    ));
                }
            }
            let tx = built
                .psbt
                .extract_tx()
                .map_err(|e| BlockingErr::Build(format!("extract_tx: {e}")))?;
            try_each_esplora(&urls, |client| {
                client
                    .broadcast(&tx)
                    .map_err(|e| clean_esplora_err("broadcast", &e))
            })?;
            let txid = tx.compute_txid();
            let sent: u64 = tx
                .output
                .iter()
                .filter(|o| o.script_pubkey == dest_spk)
                .map(|o| o.value.to_sat())
                .sum();
            let out_sum: u64 = tx.output.iter().map(|o| o.value.to_sat()).sum();
            let fee = total.saturating_sub(out_sum);
            let remaining = out_sum.saturating_sub(sent);
            Ok((txid, total, sent, fee, remaining))
        },
    )
    .await
    .map_err(|e| ApiError::Validation(format!("worker panic: {e}")))??;

    record_event(
        &state.db,
        &id,
        "owner_send",
        Some(serde_json::json!({
            "txid": txid.to_string(),
            "destination": dest_str,
            "total_input_sats": total_in,
            "sent_sat": sent_sat,
            "fee_sats": fee_sat,
            "remaining_sat": remaining_sat,
        })),
    )
    .await?;

    // Emailed receipt, and a theft alarm in disguise: a send the owner
    // didn't make means the vault password has leaked. No amounts or
    // destination in email; the dashboard activity feed has both.
    // Best-effort — the coins are already broadcast, so a mail hiccup
    // must not turn this response into an error.
    {
        let base = crate::scheduler::public_base_url();
        let body = format!(
            "Hi,\n\n\
             Your vault just sent bitcoin \u{2713} The transaction is on \
             its way to the Bitcoin network. The amount and details are \
             in your dashboard activity: {base}\n\n\
             If you did not make this send, act now: whoever did has \
             your vault password. Move your remaining funds to a fresh \
             wallet.\n\n\
             From GhostKey"
        );
        if let Err(e) = crate::notifier::enqueue_owner_email(
            &state.db,
            &id,
            crate::notifier::NotificationKind::OwnerSend,
            "\u{2713} Your send is on its way",
            &body,
        )
        .await
        {
            tracing::warn!(vault_id = %id, error = %e, "could not enqueue send email");
        }
    }

    Ok((
        StatusCode::OK,
        Json(OwnerSendResponse {
            txid: txid.to_string(),
            explorer_url: explorer_url(network, &txid),
            sent_sat,
            fee_sat,
            remaining_sat,
        }),
    ))
}

/* -------------------------------------------------------------------------- *
 *  Helpers                                                                   *
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

    type Row = (
        String,         // id
        Option<String>, // label
        String,         // network
        i64,            // timelock_blocks
        String,         // descriptor_external
        String,         // descriptor_internal
        Option<String>, // claim_token_hash
        Option<String>, // claim_token_used_at
    );
    let row: Option<Row> = sqlx::query_as(
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

    // Claim-challenge window: nothing moves while the owner still has
    // time to object. Covers build-psbt, broadcast, and heir-claim in
    // one place because they all load through here.
    if let Some(available) = crate::routes::ensure_claim_challenge(state, &id).await? {
        return Err(ApiError::Conflict(format!(
            "safety waiting period — this claim can be completed after {}",
            available.to_rfc3339()
        )));
    }

    let network = crate::config::parse_network(&network_s).map_err(|name| {
        ApiError::Validation(format!(
            "stored vault network {name} is not a known Bitcoin network"
        ))
    })?;

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
pub(crate) enum BlockingErr {
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

// `esplora_client::Error::Display` is `{:?}` (debug-formatted), which for
// `HttpResponse { status, message }` dumps the entire upstream body —
// including the openresty 504 HTML the dashboard's balance card was
// rendering verbatim. Map gateway-class statuses to a short, plain-text
// hint and crush whitespace / clip length on the rest so we never echo
// a multi-kilobyte HTML page back to the browser.
fn clean_esplora_err(op: &str, e: &esplora_client::Error) -> BlockingErr {
    use esplora_client::Error as E;
    let msg = match e {
        // 5xx + 429 (rate-limit) are upstream-load problems on the
        // public explorer, not anything the caller can fix by editing
        // the request. The dashboard has a Refresh button — point them at it.
        E::HttpResponse { status, .. } if (500..=599).contains(status) || *status == 429 => {
            format!(
                "block explorer is temporarily unavailable (HTTP {status}); please try {op} again in a moment"
            )
        }
        E::HttpResponse { status, message } => {
            format!(
                "block explorer returned HTTP {status} for {op}: {}",
                truncate_explorer_msg(message, 200)
            )
        }
        other => format!("{op}: {other:?}"),
    };
    BlockingErr::Esplora(msg)
}

fn truncate_explorer_msg(s: &str, max_chars: usize) -> String {
    let cleaned: String = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if cleaned.chars().count() <= max_chars {
        cleaned
    } else {
        let mut out: String = cleaned.chars().take(max_chars).collect();
        out.push('…');
        out
    }
}

/* -------------------------------------------------------------------------- *
 *  On-chain unlock-maturity estimate                                          *
 *                                                                            *
 *  The heir spends the vault via the `older(N)` (OP_CSV) branch, so every    *
 *  vault UTXO must be at least `timelock_blocks` deep before the network     *
 *  accepts the claim. A full drain is gated by the *youngest* coin:          *
 *                                                                            *
 *      unlock_height = max(utxo.confirmation_height) + timelock_blocks       *
 *                                                                            *
 *  This is the on-chain truth the server must respect before contacting the  *
 *  heir (Fix A) — the server's own check-in clock is independent of it.      *
 * -------------------------------------------------------------------------- */

/// Result of scanning a vault's UTXOs to find when the heir can spend.
///
/// Phase 1 needs only the tip and the unlock height; the richer
/// heir-facing fields (matured / unconfirmed / blocks remaining) land in
/// Phase 2 when the claim page consumes them.
#[derive(Debug, Clone)]
pub(crate) struct UnlockEstimate {
    /// Chain tip height observed during the scan.
    pub tip_height: u32,
    /// Block height at/after which the heir's `older(N)` spend becomes
    /// valid, or `None` when there are no confirmed UTXOs to anchor the
    /// timelock yet. Based on the youngest *confirmed* coin.
    pub unlock_height: Option<u32>,
}

/// Scan a vault's addresses via Esplora and compute its on-chain
/// unlock-maturity estimate. Blocking BDK + HTTP work runs on a
/// dedicated thread. Esplora failures surface as `BlockingErr::Esplora`
/// so callers can treat "couldn't reach the chain" as "not ready yet".
pub(crate) async fn scan_unlock_estimate(
    descriptor_external: String,
    descriptor_internal: String,
    network: Network,
    timelock_blocks: u32,
    label: Option<String>,
) -> Result<UnlockEstimate, BlockingErr> {
    let urls = esplora_urls(network).map_err(|e| match e {
        ApiError::Validation(s) => BlockingErr::Esplora(s),
        _ => BlockingErr::Esplora("esplora endpoints unavailable".into()),
    })?;

    let vault_config = VaultConfig {
        descriptor_external,
        descriptor_internal,
        timelock_blocks,
        network,
        role: VaultRole::Watchonly,
        label,
    };
    let vault = Vault::from_config(vault_config).map_err(|e| BlockingErr::Vault(e.to_string()))?;

    tokio::task::spawn_blocking(move || -> Result<UnlockEstimate, BlockingErr> {
        let mut wallet = ghostkey_core::wallet::build_watch_only(&vault)
            .map_err(|e| BlockingErr::Vault(e.to_string()))?;

        let update = try_each_esplora(&urls, |client| {
            client
                .full_scan(wallet.start_full_scan(), 5, 1)
                .map_err(|e| clean_esplora_err("full_scan", &e))
        })?;
        wallet
            .apply_update(update)
            .map_err(|e| BlockingErr::Esplora(format!("apply_update: {e}")))?;

        let tip_height = wallet.latest_checkpoint().height();
        let csv = vault.timelock_blocks();

        // The youngest confirmed coin gates a full drain. Unconfirmed
        // coins have no started timelock, so they don't lower the unlock
        // height (issuing the link slightly early is harmless — the heir
        // still can't spend until the chain matures).
        let mut youngest_conf: Option<u32> = None;
        for utxo in wallet.list_unspent() {
            if let bdk_wallet::chain::ChainPosition::Confirmed { anchor, .. } = utxo.chain_position
            {
                let h = anchor.block_id.height;
                youngest_conf = Some(youngest_conf.map_or(h, |y| y.max(h)));
            }
        }

        let unlock_height = youngest_conf.map(|h| h.saturating_add(csv));

        Ok(UnlockEstimate {
            tip_height,
            unlock_height,
        })
    })
    .await
    .map_err(|e| BlockingErr::Esplora(format!("scan worker panic: {e}")))?
}

/// How long a cached on-chain maturity estimate stays usable before a
/// rescan (~1 block): finer granularity is wasted when the chain only
/// advances every ~10 min, and it caps Esplora load per waiting vault.
pub(crate) const MATURITY_CACHE_TTL_SECS: i64 = 600;

/// A vault's descriptors plus whatever maturity estimate is already
/// cached on its row — enough to answer "when can the heir spend?"
/// without always hitting Esplora.
pub(crate) struct EstimateInput {
    pub vault_id: String,
    pub descriptor_external: String,
    pub descriptor_internal: String,
    pub network: String,
    pub timelock_blocks: i64,
    pub cached_unlock_height: Option<i64>,
    pub cached_tip_height: Option<i64>,
    pub cached_scanned_at: Option<String>,
}

/// Return the vault's unlock estimate, reusing the cached value while it
/// is fresh and otherwise rescanning Esplora and writing the cache back.
/// Shared by the scheduler's heir-contact gate and the heir-facing
/// `/claim/:token/unlock-estimate` endpoint so both see one source.
pub(crate) async fn unlock_estimate_with_cache(
    db: &sqlx::SqlitePool,
    input: &EstimateInput,
    now: chrono::DateTime<Utc>,
) -> Result<UnlockEstimate, BlockingErr> {
    let cache_fresh = input
        .cached_scanned_at
        .as_deref()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|t| (now - t.with_timezone(&Utc)).num_seconds() < MATURITY_CACHE_TTL_SECS)
        .unwrap_or(false);

    // A fresh cache with a recorded tip answers directly. A fresh row
    // with no tip means we have never scanned; fall through and do so.
    if cache_fresh {
        if let Some(tip) = input.cached_tip_height {
            return Ok(UnlockEstimate {
                tip_height: tip as u32,
                unlock_height: input.cached_unlock_height.map(|h| h as u32),
            });
        }
    }

    let net = crate::config::parse_network(&input.network)
        .map_err(|e| BlockingErr::Vault(format!("unknown vault network: {e}")))?;
    let est = scan_unlock_estimate(
        input.descriptor_external.clone(),
        input.descriptor_internal.clone(),
        net,
        input.timelock_blocks.max(0) as u32,
        None,
    )
    .await?;

    if let Err(e) = sqlx::query(
        r#"UPDATE vaults
              SET chain_unlock_height = ?,
                  chain_tip_height    = ?,
                  chain_scanned_at    = ?
            WHERE id = ?"#,
    )
    .bind(est.unlock_height.map(|h| h as i64))
    .bind(est.tip_height as i64)
    .bind(now.to_rfc3339())
    .bind(&input.vault_id)
    .execute(db)
    .await
    {
        tracing::warn!(vault_id = %input.vault_id, error = ?e,
            "could not cache on-chain maturity estimate");
    }
    Ok(est)
}

/// Heir-facing view of `UnlockEstimate`: the derived fields the claim
/// page needs to render an honest "funds unlock around <date>" screen.
#[derive(Debug, Serialize)]
pub struct UnlockEstimateView {
    /// True once the funds are confirmed and the timelock has elapsed —
    /// the heir can complete the claim now.
    pub matured: bool,
    /// Chain tip height at the estimate.
    pub tip_height: u32,
    /// Block height at/after which the heir can spend, or null when no
    /// confirmed coin yet anchors the timelock.
    pub unlock_height: Option<u32>,
    /// Blocks left until the timelock matures (0 once reached).
    pub blocks_remaining: u32,
    /// Rough wall-clock unlock time (RFC3339), or null when matured or
    /// not yet anchored. "Around": block spacing drifts.
    pub unlock_eta: Option<String>,
}

impl UnlockEstimateView {
    pub(crate) fn from_estimate(est: &UnlockEstimate, now: chrono::DateTime<Utc>) -> Self {
        match est.unlock_height {
            Some(unlock) => {
                let blocks_remaining = unlock.saturating_sub(est.tip_height);
                let matured = blocks_remaining == 0;
                let unlock_eta = (blocks_remaining > 0).then(|| {
                    (now + chrono::Duration::seconds(
                        blocks_remaining as i64 * crate::config::TARGET_BLOCK_SECS,
                    ))
                    .to_rfc3339()
                });
                UnlockEstimateView {
                    matured,
                    tip_height: est.tip_height,
                    unlock_height: Some(unlock),
                    blocks_remaining,
                    unlock_eta,
                }
            }
            // No confirmed coin to anchor the timelock yet.
            None => UnlockEstimateView {
                matured: false,
                tip_height: est.tip_height,
                unlock_height: None,
                blocks_remaining: 0,
                unlock_eta: None,
            },
        }
    }
}

/* -------------------------------------------------------------------------- *
 *  GET /claim/:token/heir-derivation-params  (F2)                             *
 *                                                                            *
 *  Returns the material a server-derived heir's browser needs to recompute   *
 *  its mnemonic + xprv: `vault_secret` (32 bytes of HKDF output) and the     *
 *  heir's own email (which was used as the second derivation input). The    *
 *  browser then re-runs `derive_heir_seed` locally and feeds the resulting   *
 *  xprv into the heir-claim flow.                                            *
 *                                                                            *
 *  Why hand back the email at all? The browser already typed it in to       *
 *  authenticate at the start of the claim flow. We echo it back from the    *
 *  sealed column so the browser is using the exact byte sequence the server *
 *  used to derive — heir_derived rows are byte-sensitive to the email and    *
 *  silent mis-derivation (wrong xpub → can't sweep funds) would be a horror. *
 * -------------------------------------------------------------------------- */

#[derive(Debug, Serialize)]
pub struct HeirDerivationParamsView {
    pub vault_id: String,
    pub network: String,
    pub timelock_blocks: i64,
    /// 32 bytes of HKDF output, hex-encoded. The browser HKDFs again with
    /// the heir's email as IKM to reach the 16-byte BIP39 entropy.
    pub vault_secret_hex: String,
    /// The heir email this vault was derived against. Plaintext on this
    /// hop only — the heir is already authenticated by holding the claim
    /// token. Should be displayed for confirmation, not stored.
    pub heir_email: String,
    /// Public watch-only descriptor pair, for the same block-B recovery
    /// file as [`SealedHeirView`]. No private material.
    pub descriptor_external: String,
    pub descriptor_internal: String,
}

pub async fn get_heir_derivation_params(
    State(state): State<Arc<AppState>>,
    Path(token): Path<String>,
) -> Result<Json<HeirDerivationParamsView>, ApiError> {
    let hash = hash_claim_token(&token);
    type Row = (
        String,         // id
        String,         // network
        i64,            // timelock_blocks
        Option<String>, // claim_token_hash
        Option<String>, // claim_token_used_at
        i64,            // heir_derived
        Option<String>, // heir_contact_ciphertext
        Option<String>, // heir_contact_nonce
        String,         // descriptor_external
        String,         // descriptor_internal
    );
    let row: Option<Row> = sqlx::query_as(
        r#"SELECT id, network, timelock_blocks,
                  claim_token_hash, claim_token_used_at,
                  heir_derived,
                  heir_contact_ciphertext, heir_contact_nonce,
                  descriptor_external, descriptor_internal
             FROM vaults
            WHERE claim_token_hash = ?"#,
    )
    .bind(&hash)
    .fetch_optional(&state.db)
    .await?;
    let row = row.ok_or(ApiError::NotFound)?;
    let stored_hash = row.3.ok_or(ApiError::NotFound)?;
    if !claim_token_matches(&token, &stored_hash) {
        return Err(ApiError::NotFound);
    }
    if row.4.is_some() {
        return Err(ApiError::Conflict("claim token already used".into()));
    }
    if row.5 == 0 {
        return Err(ApiError::Validation(
            "this vault was not created with heir_derivation; the heir has their own xpub".into(),
        ));
    }
    // Claim-challenge window: derivation params + the heir's email
    // reproduce the heir key, so they're as sensitive as the sealed
    // xprv above.
    if let Some(available) = crate::routes::ensure_claim_challenge(&state, &row.0).await? {
        return Err(ApiError::Conflict(format!(
            "safety waiting period — this claim can be completed after {}",
            available.to_rfc3339()
        )));
    }
    // The sealed contact stores a JSON object `{name, contact, channel}`,
    // not a bare email string. The heir's browser feeds this value
    // into `deriveHeirKey` as the derivation input, which must be
    // byte-for-byte identical to whatever `create_vault_from_xpub`
    // hashed in at vault creation time — and that was `hd.email`,
    // i.e. just the contact field. Sending the whole JSON blob would
    // produce a different mnemonic in the browser and a descriptor-
    // lookup failure later on.
    let contact = crate::notifier::parse_heir_contact(&row.0, row.6.as_deref(), row.7.as_deref())?
        .ok_or_else(|| {
            ApiError::Validation(
                "heir_derived=1 but no sealed heir contact on file (server inconsistency)".into(),
            )
        })?;
    let heir_email = contact
        .contact
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| {
            ApiError::Validation("heir_derived=1 but the sealed heir contact has no email".into())
        })?;

    let master = crate::crypto::master_key_bytes()?;
    let vault_secret = ghostkey_core::keys::compute_vault_secret(&row.0, &master)
        .map_err(|e| ApiError::Validation(format!("vault_secret derivation: {e}")))?;
    let vault_secret_hex = hex::encode(vault_secret);

    Ok(Json(HeirDerivationParamsView {
        vault_id: row.0,
        network: row.1,
        timelock_blocks: row.2,
        vault_secret_hex,
        heir_email,
        descriptor_external: row.8,
        descriptor_internal: row.9,
    }))
}

/* -------------------------------------------------------------------------- *
 *  GET /vaults/:id/balance                                                   *
 *                                                                            *
 *  Public (no auth): the vault's descriptors are stored in the watch-only    *
 *  form already, the address is published unauthenticated via                *
 *  /vaults/:id/address, and the chain itself is public. We just sync the     *
 *  watch-only wallet against Esplora and return the aggregate.               *
 *                                                                            *
 *  Owners hit this from the dashboard right after funding to confirm the    *
 *  sats landed. Heirs do NOT need it — they only ever see this number as    *
 *  `total_input_sats` inside the claim PSBT response.                       *
 * -------------------------------------------------------------------------- */

/// One confirmed incoming deposit surfaced by a chain scan: a genuine
/// receive (external keychain), not owner-send change (internal keychain).
/// Used to log "received" activity events so the feed reconciles with the
/// balance (#213).
pub(crate) struct ConfirmedDeposit {
    pub outpoint: String,
    pub amount_sat: i64,
    pub height: u32,
}

/// Record any newly-seen deposits as "received" activity events, exactly
/// once each. `vault_deposits` dedupes on (vault, outpoint): INSERT OR
/// IGNORE means a repeat outpoint (a later scan, or a reorg re-confirming
/// the same UTXO) is a silent no-op, so only genuinely new deposits emit
/// an event. Best-effort: a logging failure must never fail the caller
/// (e.g. the balance read), so errors are warned and swallowed.
///
/// Note: the first scan of a vault that was already funded before this
/// shipped will emit one "received" per existing unspent deposit — a
/// one-time catch-up so the feed matches the balance.
///
/// New deposits also email the owner (verified email only, no amount),
/// EXCEPT when the vault had no recorded deposits before this scan:
/// the very first deposit is announced by the scheduler's "funded"
/// email, and the catch-up scan of an old vault described above should
/// backfill the feed silently, not fire a burst of stale mail.
pub(crate) async fn record_new_deposits(
    db: &sqlx::SqlitePool,
    vault_id: &str,
    deposits: &[ConfirmedDeposit],
    now: chrono::DateTime<Utc>,
) {
    // Read before inserting; an error here still records events as
    // usual but skips the email (None = "don't know" = stay quiet).
    let prior: Option<i64> =
        sqlx::query_scalar("SELECT COUNT(*) FROM vault_deposits WHERE vault_id = ?")
            .bind(vault_id)
            .fetch_one(db)
            .await
            .ok();
    let mut newly_recorded = 0;
    for d in deposits {
        let inserted = sqlx::query(
            "INSERT OR IGNORE INTO vault_deposits \
                 (vault_id, outpoint, amount_sat, height, seen_at) \
             VALUES (?, ?, ?, ?, ?)",
        )
        .bind(vault_id)
        .bind(&d.outpoint)
        .bind(d.amount_sat)
        .bind(d.height as i64)
        .bind(now.to_rfc3339())
        .execute(db)
        .await;

        match inserted {
            Ok(res) if res.rows_affected() == 1 => {
                newly_recorded += 1;
                if let Err(e) = crate::routes::record_event(
                    db,
                    vault_id,
                    "received",
                    Some(serde_json::json!({
                        "amount_sat": d.amount_sat,
                        "outpoint": d.outpoint,
                        "height": d.height,
                    })),
                )
                .await
                {
                    tracing::warn!(error = %e, vault_id, "failed to record received event");
                }
            }
            Ok(_) => {} // already recorded on a previous scan
            Err(e) => {
                tracing::warn!(error = %e, vault_id, "failed to dedupe deposit");
            }
        }
    }

    // One email per scan, however many deposits it found; the feed
    // has the per-deposit rows. Skipped for the vault's first-ever
    // deposits (see the doc comment) and for unverified contacts.
    if newly_recorded > 0 && prior.is_some_and(|n| n > 0) {
        let base = crate::scheduler::public_base_url();
        let body = format!(
            "Hi,\n\n\
             New bitcoin arrived in your vault \u{2713} The amount and \
             details are on your dashboard: {base}\n\n\
             Nothing to do. Your vault keeps working as before.\n\n\
             From GhostKey"
        );
        if let Err(e) = crate::notifier::enqueue_owner_email(
            db,
            vault_id,
            crate::notifier::NotificationKind::Received,
            "\u{2713} Your vault received bitcoin",
            &body,
        )
        .await
        {
            tracing::warn!(error = %e, vault_id, "could not enqueue received email");
        }
    }
}

#[derive(Debug, Serialize)]
pub struct VaultBalanceView {
    pub vault_id: String,
    pub network: String,
    pub confirmed_sat: u64,
    pub unconfirmed_sat: u64,
    pub total_sat: u64,
}

pub async fn get_vault_balance(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<VaultBalanceView>, ApiError> {
    type Row = (String, String, String, i64); // network, ext, int, timelock
    let row: Option<Row> = sqlx::query_as(
        r#"SELECT network, descriptor_external, descriptor_internal, timelock_blocks
             FROM vaults WHERE id = ?"#,
    )
    .bind(&id)
    .fetch_optional(&state.db)
    .await?;
    let (network_s, ext, int_, timelock) = row.ok_or(ApiError::NotFound)?;

    let network = crate::config::parse_network(&network_s).map_err(|name| {
        ApiError::Validation(format!(
            "stored vault network {name} is not a known Bitcoin network"
        ))
    })?;

    let vault_config = VaultConfig {
        descriptor_external: ext,
        descriptor_internal: int_,
        timelock_blocks: timelock as u32,
        network,
        role: VaultRole::Watchonly,
        label: None,
    };
    let vault = Vault::from_config(vault_config)
        .map_err(|e| ApiError::Validation(format!("stored vault descriptors invalid: {e}")))?;

    let urls = esplora_urls(network)?;
    let id_for_resp = id.clone();
    type ScanResult = (u64, u64, u64, Vec<ConfirmedDeposit>);
    let (confirmed_sat, unconfirmed_sat, total_sat, deposits) =
        tokio::task::spawn_blocking(move || -> Result<ScanResult, BlockingErr> {
            let mut wallet = ghostkey_core::wallet::build_watch_only(&vault)
                .map_err(|e| BlockingErr::Vault(e.to_string()))?;
            let update = try_each_esplora(&urls, |client| {
                client
                    .full_scan(wallet.start_full_scan(), 5, 1)
                    .map_err(|e| clean_esplora_err("full_scan", &e))
            })?;
            wallet
                .apply_update(update)
                .map_err(|e| BlockingErr::Esplora(format!("apply_update: {e}")))?;
            let bal = wallet.balance();
            let confirmed = bal.confirmed.to_sat();
            let unconfirmed = bal.trusted_pending.to_sat() + bal.untrusted_pending.to_sat();
            let total = bal.total().to_sat();

            // Collect confirmed receives off this same scan (no extra chain
            // poll). External keychain only: internal is owner-send change,
            // not a deposit (#213).
            let mut deposits = Vec::new();
            for utxo in wallet.list_unspent() {
                if utxo.keychain != bdk_wallet::KeychainKind::External {
                    continue;
                }
                if let bdk_wallet::chain::ChainPosition::Confirmed { anchor, .. } =
                    utxo.chain_position
                {
                    deposits.push(ConfirmedDeposit {
                        outpoint: utxo.outpoint.to_string(),
                        amount_sat: utxo.txout.value.to_sat() as i64,
                        height: anchor.block_id.height,
                    });
                }
            }
            Ok((confirmed, unconfirmed, total, deposits))
        })
        .await
        .map_err(|e| ApiError::Validation(format!("worker panic: {e}")))??;

    record_new_deposits(&state.db, &id, &deposits, Utc::now()).await;

    Ok(Json(VaultBalanceView {
        vault_id: id_for_resp,
        network: network_s,
        confirmed_sat,
        unconfirmed_sat,
        total_sat,
    }))
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
        assert!(default_esplora_urls(Network::Bitcoin).is_empty());
        // The test networks each get at least two independent public
        // explorers so one being down doesn't strand a claim.
        let testnet = default_esplora_urls(Network::Testnet);
        assert!(testnet.len() >= 2);
        assert!(testnet.iter().all(|u| u.contains("testnet")));
        let signet = default_esplora_urls(Network::Signet);
        assert!(signet.len() >= 2);
        assert!(signet.iter().all(|u| u.contains("signet")));
    }

    #[test]
    fn explorer_base_follows_configured_indexer() {
        // No indexer configured → per-network mempool.space defaults.
        assert_eq!(
            explorer_base(None, Network::Bitcoin),
            "https://mempool.space/tx"
        );
        assert_eq!(
            explorer_base(None, Network::Signet),
            "https://mempool.space/signet/tx"
        );
        // A custom indexer → explorer derived from it (#152): drop `/api`.
        assert_eq!(
            explorer_base(Some("https://mutinynet.com/api"), Network::Signet),
            "https://mutinynet.com/tx"
        );
        // Trailing slash + a fallback list: use the first entry.
        assert_eq!(
            explorer_base(
                Some("https://my.indexer/api/ , https://backup/api"),
                Network::Bitcoin
            ),
            "https://my.indexer/tx"
        );
        // An indexer URL without an `/api` suffix still yields a host link.
        assert_eq!(
            explorer_base(Some("http://127.0.0.1:3002"), Network::Regtest),
            "http://127.0.0.1:3002/tx"
        );
        // An empty/whitespace value falls back to the network default.
        assert_eq!(
            explorer_base(Some("   "), Network::Signet),
            "https://mempool.space/signet/tx"
        );
    }

    #[test]
    fn explorer_url_includes_txid() {
        let txid: bitcoin::Txid =
            "0000000000000000000000000000000000000000000000000000000000000001"
                .parse()
                .unwrap();
        // Use the env-independent core so this can't race the env-mutating
        // `esplora_urls_respects_env` test running in parallel.
        let url = format!("{}/{txid}", explorer_base(None, Network::Signet));
        assert!(url.starts_with("https://mempool.space/signet/tx/"));
        assert!(url.ends_with("0000000000000000000000000000000000000000000000000000000000000001"));
    }

    #[test]
    fn esplora_urls_respects_env() {
        // SAFETY: this test mutates a process-wide env var. We don't
        // share state with the crypto tests (different module), and
        // both keys are independent — the worst case is an interleave
        // that reads our value briefly, which is harmless.
        unsafe {
            std::env::set_var("GHOSTKEY_ESPLORA_URL", "https://my.indexer/api");
        }
        assert_eq!(
            esplora_urls(Network::Bitcoin).unwrap(),
            vec!["https://my.indexer/api".to_string()]
        );
        unsafe {
            std::env::remove_var("GHOSTKEY_ESPLORA_URL");
        }
        // With the env var cleared, mainnet must refuse rather than
        // fall back to a public indexer.
        assert!(esplora_urls(Network::Bitcoin).is_err());
        // Testnet still gets working defaults.
        assert!(esplora_urls(Network::Testnet).is_ok());
    }

    #[test]
    fn parse_esplora_urls_splits_fallback_list() {
        let urls = parse_esplora_urls(
            " https://primary.indexer/api , https://secondary.indexer/api,",
            Network::Bitcoin,
        )
        .unwrap();
        assert_eq!(
            urls,
            vec![
                "https://primary.indexer/api".to_string(),
                "https://secondary.indexer/api".to_string(),
            ]
        );
    }

    #[test]
    fn parse_esplora_urls_rejects_plain_http_for_mainnet() {
        // A single plain-http entry poisons the whole list: silently
        // dropping it would hide a misconfiguration until the https
        // entries were all down.
        let result = parse_esplora_urls(
            "https://primary.indexer/api,http://sneaky.indexer/api",
            Network::Bitcoin,
        );
        assert!(result.is_err(), "plain http must be refused for mainnet");
        // The same list is fine on signet, where http is allowed for
        // local indexers.
        assert!(parse_esplora_urls(
            "https://primary.indexer/api,http://sneaky.indexer/api",
            Network::Signet
        )
        .is_ok());
    }

    #[test]
    fn parse_esplora_urls_rejects_empty() {
        assert!(parse_esplora_urls("", Network::Signet).is_err());
        assert!(parse_esplora_urls(" , ,", Network::Signet).is_err());
    }

    #[test]
    fn try_each_esplora_fails_over_only_on_esplora_errors() {
        let urls = vec![
            "http://127.0.0.1:1/api".to_string(),
            "http://127.0.0.1:2/api".to_string(),
        ];

        // Esplora errors fall through to the next endpoint; the helper
        // returns the last one when every endpoint fails.
        let mut attempts = 0;
        let result: Result<(), _> = try_each_esplora(&urls, |_client| {
            attempts += 1;
            Err(BlockingErr::Esplora(format!("down #{attempts}")))
        });
        assert_eq!(attempts, 2, "both endpoints should be tried");
        match result {
            Err(BlockingErr::Esplora(msg)) => assert_eq!(msg, "down #2"),
            other => panic!("expected last esplora error, got {other:?}"),
        }

        // The second endpoint succeeding rescues the call.
        let mut attempts = 0;
        let result = try_each_esplora(&urls, |_client| {
            attempts += 1;
            if attempts == 1 {
                Err(BlockingErr::Esplora("down".into()))
            } else {
                Ok(42)
            }
        });
        assert_eq!(result.unwrap(), 42);
        assert_eq!(attempts, 2);

        // Non-esplora errors abort immediately — no point retrying a
        // wallet/build failure against a different explorer.
        let mut attempts = 0;
        let result: Result<(), _> = try_each_esplora(&urls, |_client| {
            attempts += 1;
            Err(BlockingErr::NoUtxos)
        });
        assert_eq!(attempts, 1, "must not fail over on non-esplora errors");
        assert!(matches!(result, Err(BlockingErr::NoUtxos)));
    }

    #[test]
    fn clean_esplora_err_504_does_not_echo_html_body() {
        // The exact shape the dashboard was rendering verbatim: an
        // openresty 504 page from the public explorer.
        let html = "<html>\r\n<head><title>504 Gateway Time-out</title></head>\r\n<body>\r\n<center><h1>504 Gateway Time-out</h1></center>\r\n<hr><center>openresty</center>\r\n</body>\r\n</html>".to_string();
        let err = esplora_client::Error::HttpResponse {
            status: 504,
            message: html,
        };
        let BlockingErr::Esplora(msg) = clean_esplora_err("full_scan", &err) else {
            panic!("expected Esplora variant");
        };
        assert!(msg.contains("504"), "should mention the status: {msg}");
        assert!(
            msg.contains("temporarily unavailable"),
            "should be friendly: {msg}"
        );
        assert!(!msg.contains("<html"), "must not echo HTML body: {msg}");
        assert!(!msg.contains("openresty"), "must not leak upstream: {msg}");
    }

    #[test]
    fn clean_esplora_err_4xx_includes_short_message() {
        let err = esplora_client::Error::HttpResponse {
            status: 400,
            message: "bad address format".to_string(),
        };
        let BlockingErr::Esplora(msg) = clean_esplora_err("broadcast", &err) else {
            panic!("expected Esplora variant");
        };
        assert!(msg.contains("400"));
        assert!(msg.contains("bad address format"));
    }

    async fn memory_db() -> sqlx::SqlitePool {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("connect sqlite::memory");
        sqlx::migrate!("./migrations")
            .run(&pool)
            .await
            .expect("run migrations");
        pool
    }

    async fn received_count(pool: &sqlx::SqlitePool, vault_id: &str) -> i64 {
        sqlx::query_scalar("SELECT COUNT(*) FROM events WHERE vault_id = ? AND kind = 'received'")
            .bind(vault_id)
            .fetch_one(pool)
            .await
            .expect("count received events")
    }

    fn deposit(outpoint: &str, sat: i64, height: u32) -> ConfirmedDeposit {
        ConfirmedDeposit {
            outpoint: outpoint.to_string(),
            amount_sat: sat,
            height,
        }
    }

    // Minimal vault row so the events FK (events.vault_id -> vaults.id) is
    // satisfied; foreign keys are on by default in sqlx.
    async fn seed_vault(pool: &sqlx::SqlitePool, id: &str) {
        let ts = Utc::now().to_rfc3339();
        sqlx::query(
            "INSERT INTO vaults \
                 (id, network, descriptor_external, descriptor_internal, timelock_blocks, \
                  checkin_period_secs, grace_period_secs, created_at, next_deadline_at) \
             VALUES (?, 'signet', ?, ?, 144, 3600, 3600, ?, ?)",
        )
        .bind(id)
        .bind(format!("desc-ext-{id}")) // descriptor_external is UNIQUE
        .bind(format!("desc-int-{id}"))
        .bind(&ts)
        .bind(&ts)
        .execute(pool)
        .await
        .expect("seed vault");
    }

    #[tokio::test]
    async fn record_new_deposits_emits_once_per_outpoint() {
        let pool = memory_db().await;
        seed_vault(&pool, "vault-1").await;
        seed_vault(&pool, "vault-2").await;
        let now = Utc::now();
        let vault = "vault-1";

        // First scan: two brand-new deposits -> two "received" events.
        record_new_deposits(
            &pool,
            vault,
            &[
                deposit("aaaa:0", 100_000, 800_000),
                deposit("bbbb:1", 50_000, 800_001),
            ],
            now,
        )
        .await;
        assert_eq!(received_count(&pool, vault).await, 2);

        // A later dashboard load re-scans and sees the SAME outpoints (plus
        // the first one again): nothing new is logged.
        record_new_deposits(
            &pool,
            vault,
            &[
                deposit("aaaa:0", 100_000, 800_000),
                deposit("bbbb:1", 50_000, 800_001),
            ],
            now,
        )
        .await;
        assert_eq!(
            received_count(&pool, vault).await,
            2,
            "re-seen outpoints must not double-log"
        );

        // A genuinely new deposit alongside the old ones: exactly one more.
        record_new_deposits(
            &pool,
            vault,
            &[
                deposit("aaaa:0", 100_000, 800_000),
                deposit("cccc:2", 25_000, 800_005),
            ],
            now,
        )
        .await;
        assert_eq!(
            received_count(&pool, vault).await,
            3,
            "only the new outpoint logs"
        );

        // Deposits are scoped per vault: the same outpoint on another vault
        // is its own first-seen.
        record_new_deposits(
            &pool,
            "vault-2",
            &[deposit("aaaa:0", 100_000, 800_000)],
            now,
        )
        .await;
        assert_eq!(received_count(&pool, "vault-2").await, 1);
    }

    /// Give the vault the sealed + verified owner email the setup
    /// wizard would have written, so `enqueue_owner_email` fires.
    async fn attach_verified_owner_email(pool: &sqlx::SqlitePool, id: &str) {
        use base64::Engine as _;
        if std::env::var("GHOSTKEY_MASTER_KEY").is_err() {
            let zeros = [0u8; 32];
            let b64 = base64::engine::general_purpose::STANDARD_NO_PAD.encode(zeros);
            // SAFETY: tests are single-process; the value is fixed.
            unsafe {
                std::env::set_var("GHOSTKEY_MASTER_KEY", &b64);
            }
        }
        let sealed =
            crate::crypto::seal_for_vault(id, b"owner@example.com").expect("seal owner contact");
        sqlx::query(
            "UPDATE vaults \
                SET owner_contact_ciphertext = ?, owner_contact_nonce = ?, \
                    owner_contact_channel = 'email', owner_contact_verified_at = ? \
              WHERE id = ?",
        )
        .bind(&sealed.ciphertext_b64)
        .bind(&sealed.nonce_b64)
        .bind(Utc::now().to_rfc3339())
        .bind(id)
        .execute(pool)
        .await
        .expect("attach owner email");
    }

    async fn received_email_count(pool: &sqlx::SqlitePool, vault_id: &str) -> i64 {
        sqlx::query_scalar(
            "SELECT COUNT(*) FROM notifications WHERE vault_id = ? AND kind = 'received'",
        )
        .bind(vault_id)
        .fetch_one(pool)
        .await
        .expect("count received notifications")
    }

    #[tokio::test]
    async fn received_email_skips_first_deposit_then_fires_once_per_scan() {
        let pool = memory_db().await;
        seed_vault(&pool, "vault-mail").await;
        attach_verified_owner_email(&pool, "vault-mail").await;
        let now = Utc::now();

        // First-ever deposits: feed rows, but the "funded" email owns
        // this moment — no received email.
        record_new_deposits(
            &pool,
            "vault-mail",
            &[deposit("aaaa:0", 100_000, 800_000)],
            now,
        )
        .await;
        assert_eq!(received_count(&pool, "vault-mail").await, 1);
        assert_eq!(
            received_email_count(&pool, "vault-mail").await,
            0,
            "first deposit must not email; the funded email covers it"
        );

        // Later scan finds TWO new deposits: one email, not two.
        record_new_deposits(
            &pool,
            "vault-mail",
            &[
                deposit("aaaa:0", 100_000, 800_000),
                deposit("bbbb:1", 50_000, 800_010),
                deposit("cccc:2", 25_000, 800_010),
            ],
            now,
        )
        .await;
        assert_eq!(received_count(&pool, "vault-mail").await, 3);
        assert_eq!(
            received_email_count(&pool, "vault-mail").await,
            1,
            "one email per scan, however many deposits it found"
        );

        // Re-scanning the same outpoints: nothing new, no email.
        record_new_deposits(
            &pool,
            "vault-mail",
            &[
                deposit("bbbb:1", 50_000, 800_010),
                deposit("cccc:2", 25_000, 800_010),
            ],
            now,
        )
        .await;
        assert_eq!(received_email_count(&pool, "vault-mail").await, 1);
    }

    #[tokio::test]
    async fn received_email_requires_verified_owner_contact() {
        let pool = memory_db().await;
        seed_vault(&pool, "vault-quiet").await;
        let now = Utc::now();

        // No owner contact at all: events recorded, nothing mailed,
        // even past the first deposit.
        record_new_deposits(
            &pool,
            "vault-quiet",
            &[deposit("aaaa:0", 100_000, 800_000)],
            now,
        )
        .await;
        record_new_deposits(
            &pool,
            "vault-quiet",
            &[deposit("bbbb:1", 50_000, 800_010)],
            now,
        )
        .await;
        assert_eq!(received_count(&pool, "vault-quiet").await, 2);
        assert_eq!(received_email_count(&pool, "vault-quiet").await, 0);

        // Sealed contact but never verified: still silent.
        attach_verified_owner_email(&pool, "vault-quiet").await;
        sqlx::query("UPDATE vaults SET owner_contact_verified_at = NULL WHERE id = 'vault-quiet'")
            .execute(&pool)
            .await
            .expect("unverify");
        record_new_deposits(
            &pool,
            "vault-quiet",
            &[deposit("cccc:2", 25_000, 800_020)],
            now,
        )
        .await;
        assert_eq!(
            received_email_count(&pool, "vault-quiet").await,
            0,
            "unverified addresses must never get lifecycle mail"
        );

        // Verified but on a non-email channel: lifecycle mail is
        // email-only, so still silent.
        sqlx::query(
            "UPDATE vaults SET owner_contact_verified_at = ?, owner_contact_channel = 'sms' \
              WHERE id = 'vault-quiet'",
        )
        .bind(Utc::now().to_rfc3339())
        .execute(&pool)
        .await
        .expect("switch to sms");
        record_new_deposits(
            &pool,
            "vault-quiet",
            &[deposit("dddd:3", 10_000, 800_030)],
            now,
        )
        .await;
        assert_eq!(received_email_count(&pool, "vault-quiet").await, 0);
    }
}
