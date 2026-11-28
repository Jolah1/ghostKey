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
use ghostkey_core::psbt::build_heir_claim;
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

/// The Esplora endpoints for one network, in fallback order. Carries the
/// network so [`try_each_esplora`] can refuse an endpoint that serves a
/// different chain (see [`explorer_on_network`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Explorers {
    pub urls: Vec<String>,
    pub network: Network,
}

/// Resolve the ordered Esplora endpoint list for a network, refusing to
/// start a request we can't service. `GHOSTKEY_ESPLORA_URL` accepts a
/// single URL or a comma-separated fallback list, tried left to right.
/// Mainnet requires the env var to be set and every entry to be HTTPS —
/// anything else would leak descriptors or expose requests to a passive
/// attacker.
///
/// `GHOSTKEY_ESPLORA_URL` describes ONE chain, so it applies only to the
/// server's own network (`GHOSTKEY_DEFAULT_NETWORK`) and to mainnet,
/// which has no public default. A test-network vault on a mainnet
/// server uses that network's public explorers. Before this, the mainnet
/// indexer was used for every vault, and scanning a testnet vault
/// against it made bdk_esplora panic on the genesis mismatch, on every
/// scheduler tick, forever.
fn esplora_urls(network: Network) -> Result<Explorers, ApiError> {
    let env = std::env::var("GHOSTKEY_ESPLORA_URL").ok();
    let server_network = crate::config::parse_network(crate::config::default_network()).ok();
    esplora_urls_for(network, env.as_deref(), server_network)
}

/// Env-independent core of [`esplora_urls`].
fn esplora_urls_for(
    network: Network,
    env: Option<&str>,
    server_network: Option<Network>,
) -> Result<Explorers, ApiError> {
    let env_applies = network == Network::Bitcoin || server_network == Some(network);
    let urls = match env {
        Some(raw) if env_applies => parse_esplora_urls(raw, network)?,
        _ => {
            let defaults = default_esplora_urls(network);
            if defaults.is_empty() {
                return Err(ApiError::Validation(
                    "mainnet requires GHOSTKEY_ESPLORA_URL to be set explicitly".into(),
                ));
            }
            defaults.iter().map(|s| s.to_string()).collect()
        }
    };
    Ok(Explorers { urls, network })
}

/// Endpoints already confirmed to serve a given network's chain, so the
/// genesis check costs one request per endpoint per process, not one per
/// scan.
fn verified_explorers() -> &'static std::sync::Mutex<std::collections::HashSet<(String, Network)>> {
    static V: std::sync::OnceLock<std::sync::Mutex<std::collections::HashSet<(String, Network)>>> =
        std::sync::OnceLock::new();
    V.get_or_init(Default::default)
}

/// Confirm an endpoint serves `network` by comparing its block 0 with
/// that network's genesis. bdk_esplora PANICS ("remote esplora should
/// have same genesis block") when they differ, so this runs before any
/// scan. A mismatch is an explorer problem, so the caller fails over to
/// the next endpoint.
///
/// Only a definite mismatch refuses the endpoint. If the check itself
/// can't get an answer (timeout, 429), the scan goes ahead: on
/// 2026-11-24 blockstream.info served `block-height/0` in ~16s, past our
/// 15s timeout, while serving the scan fine, so a strict check blocked
/// every mainnet scan. The real guard is that [`esplora_urls`] never
/// pairs a network with another network's explorer; this is a backstop,
/// and a panic during the scan is still caught by the scan worker.
fn explorer_on_network(
    client: &esplora_client::BlockingClient,
    url: &str,
    network: Network,
) -> Result<(), BlockingErr> {
    let key = (url.to_string(), network);
    if verified_explorers()
        .lock()
        .map(|v| v.contains(&key))
        .unwrap_or(false)
    {
        return Ok(());
    }
    let remote = match client.get_block_hash(0) {
        Ok(hash) => hash,
        Err(e) => {
            tracing::debug!(
                endpoint = %url,
                error = %clean_esplora_err("genesis check", &e),
                "genesis check got no answer; scanning anyway"
            );
            return Ok(());
        }
    };
    let expected = bitcoin::constants::genesis_block(network).block_hash();
    if remote != expected {
        return Err(BlockingErr::Esplora(format!(
            "{url} serves a different chain than {network}"
        )));
    }
    if let Ok(mut v) = verified_explorers().lock() {
        v.insert(key);
    }
    Ok(())
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

/// How long an explorer that just failed is asked last.
const EXPLORER_COOLDOWN: std::time::Duration = std::time::Duration::from_secs(300);

/// Retries on a 429/5xx for the last explorer in line. Earlier ones get
/// none: the next explorer is a better bet than waiting on this one.
const LAST_EXPLORER_RETRIES: usize = 2;

/// When each explorer last failed, by URL.
fn explorer_cooldowns(
) -> &'static std::sync::Mutex<std::collections::HashMap<String, std::time::Instant>> {
    static C: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashMap<String, std::time::Instant>>,
    > = std::sync::OnceLock::new();
    C.get_or_init(Default::default)
}

/// The endpoints in the order to ask them: any that failed in the last
/// [`EXPLORER_COOLDOWN`] go to the back, otherwise the configured order
/// holds. Nothing is dropped, so if every explorer is struggling they
/// are all still tried.
fn explorer_try_order(urls: &[String]) -> Vec<&String> {
    let now = std::time::Instant::now();
    let cooling = explorer_cooldowns()
        .lock()
        .map(|c| {
            urls.iter()
                .map(|u| {
                    c.get(u)
                        .is_some_and(|t| now.duration_since(*t) < EXPLORER_COOLDOWN)
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_else(|_| vec![false; urls.len()]);
    let mut order: Vec<(bool, &String)> = cooling.into_iter().zip(urls).collect();
    // Stable: ties keep the configured order.
    order.sort_by_key(|(cool, _)| *cool);
    order.into_iter().map(|(_, u)| u).collect()
}

fn explorer_failed(url: &str) {
    if let Ok(mut c) = explorer_cooldowns().lock() {
        c.insert(url.to_string(), std::time::Instant::now());
    }
}

fn explorer_ok(url: &str) {
    if let Ok(mut c) = explorer_cooldowns().lock() {
        c.remove(url);
    }
}

/// Run an Esplora operation against each endpoint in turn, returning
/// the first success. Only explorer-side failures (`BlockingErr::Esplora`)
/// trigger failover — wallet/build errors would fail identically against
/// every endpoint, so they abort immediately. Returns the last endpoint's
/// error when all of them fail.
///
/// A rate-limited explorer must not hold the request up: on 2026-11-25
/// blockstream answered everything with 429, and the client's own six
/// retries spent ~20s there before the next explorer was asked, longer
/// than Home waits for a balance. So only the last explorer in line
/// retries, and one that just failed is asked last for a while (see
/// [`explorer_try_order`]).
///
/// The closure is handed a freshly built client per attempt; anything it
/// needs mutable access to (the BDK wallet, the PSBT) is captured by the
/// `FnMut`.
fn try_each_esplora<T, F>(explorers: &Explorers, mut op: F) -> Result<T, BlockingErr>
where
    F: FnMut(&esplora_client::BlockingClient) -> Result<T, BlockingErr>,
{
    let urls = explorer_try_order(&explorers.urls);
    let mut last_err = BlockingErr::Esplora("no esplora endpoints configured".into());
    for (i, url) in urls.iter().enumerate() {
        let is_last = i + 1 == urls.len();
        // Per-request socket timeout. The default is unbounded, so a
        // slow/throttling public explorer (mempool.space rate-limits
        // hard) could hang the whole scan past the gateway's 60s cap.
        // Bounding each request lets a stuck endpoint fail over to the
        // next one quickly instead.
        let client = esplora_client::Builder::new(url)
            .timeout(15)
            .max_retries(if is_last { LAST_EXPLORER_RETRIES } else { 0 })
            .build_blocking();
        match explorer_on_network(&client, url, explorers.network).and_then(|()| op(&client)) {
            Ok(v) => {
                explorer_ok(url);
                return Ok(v);
            }
            Err(e @ BlockingErr::Esplora(_)) => {
                explorer_failed(url);
                if !is_last {
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
        let _concurrency_permit = crate::concurrency::acquire_esplora().await;
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
    let _concurrency_permit = crate::concurrency::acquire_esplora().await;
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
 *  Sealed heir key                                                           *
 *                                                                            *
 *    GET /claim/:token/sealed-heir                                           *
 *        Returns the heir's locked account key plus the vault network,       *
 *        timelock and descriptors. The heir's browser opens it (with the     *
 *        heir code on heir-code vaults), builds and signs the claim itself,  *
 *        and sends only the signed transaction to                            *
 *        `POST /claim/:token/claim-signed`. The server never sees the        *
 *        heir's key.                                                         *
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
    /// Present when the key is sealed under an heir code (option a): the
    /// heir types the code and the browser re-derives the key with these
    /// parameters. Absent when the key is sealed under the claim token.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub heir_code: Option<HeirCodeKdf>,
}

/// How to turn the heir code into the key that opens the heir's xprv
/// (Argon2id, the same scheme as the heir file).
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct HeirCodeKdf {
    pub salt_b64: String,
    pub kdf_mem_kib: i64,
    pub kdf_iters: i64,
    /// The check phrase sealed under the code's check key: a typed code
    /// that opens it is right. Costs a guesser the same Argon2id as the
    /// heir's key, and opens nothing else.
    pub check_ct_b64: String,
    pub check_nonce_b64: String,
}

/// The heir-code parameters for a vault, if its heir key is sealed
/// under a code.
pub(crate) async fn heir_code_kdf(
    db: &sqlx::SqlitePool,
    vault_id: &str,
) -> Result<Option<HeirCodeKdf>, ApiError> {
    type Row = (
        Option<String>,
        Option<i64>,
        Option<i64>,
        Option<String>,
        Option<String>,
    );
    let row: Option<Row> = sqlx::query_as(
        "SELECT heir_code_salt_b64, heir_code_kdf_mem_kib, heir_code_kdf_iters, \
                heir_code_check_ct_b64, heir_code_check_nonce \
           FROM vaults WHERE id = ?",
    )
    .bind(vault_id)
    .fetch_optional(db)
    .await?;
    Ok(match row {
        Some((
            Some(salt_b64),
            Some(kdf_mem_kib),
            Some(kdf_iters),
            Some(check_ct_b64),
            Some(check_nonce_b64),
        )) => Some(HeirCodeKdf {
            salt_b64,
            kdf_mem_kib,
            kdf_iters,
            check_ct_b64,
            check_nonce_b64,
        }),
        _ => None,
    })
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
        Option<i64>,    // chain_has_unspent
    );
    let row: Option<Row> = sqlx::query_as(
        r#"SELECT id, network, timelock_blocks,
                  claim_token_hash, claim_token_used_at,
                  descriptor_external, descriptor_internal,
                  chain_unlock_height, chain_tip_height, chain_scanned_at,
                  chain_has_unspent
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
        cached_has_unspent: row.10,
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
        Option<i64>,    // chain_has_unspent
    );
    let row: Option<Row> = sqlx::query_as(
        r#"SELECT id, network, timelock_blocks,
                  claim_token_hash, claim_token_used_at,
                  heir_xprv_sealed_ct_b64, heir_xprv_sealed_nonce,
                  descriptor_external, descriptor_internal,
                  chain_unlock_height, chain_tip_height, chain_scanned_at,
                  chain_has_unspent
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
            cached_has_unspent: row.12,
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
    let heir_code = heir_code_kdf(&state.db, &row.0).await?;
    Ok(Json(SealedHeirView {
        vault_id: row.0,
        network: row.1,
        timelock_blocks: row.2,
        heir_xprv_ct_b64: ct,
        heir_xprv_nonce_b64: nonce,
        descriptor_external: row.7,
        descriptor_internal: row.8,
        heir_code,
    }))
}

/// What an owner's send reports back to the browser.
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

/// A send that's on the network: what it spent and where it went.
struct SentTx {
    txid: bitcoin::Txid,
    destination: String,
    total_in: u64,
    sent_sat: u64,
    fee_sat: u64,
    remaining_sat: u64,
}

/// Everything after an owner's send is on the network, whichever path
/// signed it: the activity entry, "vault empty" on a full drain, and the
/// emailed receipt that doubles as a theft alarm.
async fn finish_owner_send(
    state: &AppState,
    id: &str,
    network: Network,
    sent: SentTx,
) -> Result<OwnerSendResponse, ApiError> {
    let SentTx {
        txid,
        destination: dest_str,
        total_in,
        sent_sat,
        fee_sat,
        remaining_sat,
    } = sent;
    // The cached chain data predates this send: rescan on the next
    // refresher pass instead of acting on it for up to an hour.
    if let Err(e) = sqlx::query("UPDATE vaults SET chain_scanned_at = NULL WHERE id = ?")
        .bind(id)
        .execute(&state.db)
        .await
    {
        tracing::warn!(vault_id = %id, error = ?e, "could not mark vault for rescan");
    }
    record_event(
        &state.db,
        id,
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

    // A full drain leaves no inheritance to monitor. Move active/grace
    // states back to `unfunded` immediately; the scheduler will reactivate
    // the vault if a later deposit appears. Do not rewrite a live/final
    // heir claim here: those states have their own receipt semantics.
    if remaining_sat == 0 {
        let changed = sqlx::query(
            "UPDATE vaults SET status = 'unfunded', claim_eligible_at = NULL \
             WHERE id = ? AND status IN ('ok', 'warning', 'alarmed', 'frozen')",
        )
        .bind(id)
        .execute(&state.db)
        .await?;
        if changed.rows_affected() == 1 {
            record_event(
                &state.db,
                id,
                "vault_empty",
                Some(serde_json::json!({ "reason": "owner_full_drain" })),
            )
            .await?;
        }
    }

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
            id,
            crate::notifier::NotificationKind::OwnerSend,
            "\u{2713} Your send is on its way",
            &body,
        )
        .await
        {
            tracing::warn!(vault_id = %id, error = %e, "could not enqueue send email");
        }
    }

    Ok(OwnerSendResponse {
        txid: txid.to_string(),
        explorer_url: explorer_url(network, &txid),
        sent_sat,
        fee_sat,
        remaining_sat,
    })
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
    // time to object. Covers build-psbt, broadcast, coins and claim-signed in
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
    /// We skipped the explorer on purpose: it failed recently and we are
    /// waiting out the pause before asking again. See [`ExplorerBackoff`].
    #[error("block explorer is busy; trying again in {0}s")]
    BackingOff(i64),
    /// The scheduler reads chain data from the cache only, and this
    /// vault's cache is missing or stale. The background chain refresher
    /// (`scheduler::run_chain_refresher`) will fill it; until then the
    /// vault waits, exactly as it would after a failed scan.
    #[error("waiting for the background chain scan")]
    NotScannedYet,
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
            e @ BlockingErr::BackingOff(_) => ApiError::Validation(e.to_string()),
            e @ BlockingErr::NotScannedYet => ApiError::Validation(e.to_string()),
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
                "The Bitcoin network lookup is busy right now (HTTP {status} on {op}). Try again in a minute."
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
    /// True when the scan found any unspent output, confirmed or pending.
    /// An unconfirmed change output exists but has no unlock height yet.
    pub has_unspent: bool,
}

/// Write down what one scan learned: the last known balance, deposits
/// that came in, and coins that left. The live balance lookup and the
/// background refresher both call this, so they can't drift apart.
pub(crate) async fn record_scan(
    db: &sqlx::SqlitePool,
    vault_id: &str,
    balance: ScanBalance,
    deposits: &[ConfirmedDeposit],
    still_unspent: &[String],
    now: chrono::DateTime<Utc>,
) {
    save_last_balance(db, vault_id, balance, now).await;
    record_new_deposits(db, vault_id, deposits, now).await;
    record_spent_deposits(db, vault_id, still_unspent, now).await;
}

/// Everything one background scan learns about a vault.
pub(crate) struct ScanOutput {
    pub estimate: UnlockEstimate,
    pub balance: ScanBalance,
    pub deposits: Vec<ConfirmedDeposit>,
    pub still_unspent: Vec<String>,
}

/// A vault's balance as one chain scan saw it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ScanBalance {
    pub confirmed_sat: u64,
    pub unconfirmed_sat: u64,
}

/// Remember `balance` as the vault's last known balance, for
/// `GET /vaults/:id/balance/last`. Best effort: a failed write only means
/// Home waits for the live lookup, as it did before.
pub(crate) async fn save_last_balance(
    db: &sqlx::SqlitePool,
    vault_id: &str,
    balance: ScanBalance,
    now: chrono::DateTime<Utc>,
) {
    if let Err(e) = sqlx::query(
        "UPDATE vaults SET balance_confirmed_sat = ?, balance_unconfirmed_sat = ?, \
                balance_checked_at = ? WHERE id = ?",
    )
    .bind(balance.confirmed_sat as i64)
    .bind(balance.unconfirmed_sat as i64)
    .bind(now.to_rfc3339())
    .bind(vault_id)
    .execute(db)
    .await
    {
        tracing::warn!(vault_id = %vault_id, error = ?e, "could not save last balance");
    }
}

/// Bitcoin checks a date lock against the median time of the last 11
/// blocks, which runs about an hour behind the clock. Two hours of margin
/// keeps "ready" from coming before the chain agrees.
pub(crate) const LOCKED_MTP_MARGIN_SECS: i64 = 2 * 3_600;

/// The block height a locked goal's heir date maps to, from the current
/// tip, at one block per ten minutes: the tip itself once the date (plus
/// the margin) has passed, so "matured" (tip >= unlock height) is exact on
/// the safe side and an estimate before it.
pub(crate) fn locked_unlock_height(tip_height: u32, heir_after: u32, now: i64) -> u32 {
    let left = heir_after as i64 + LOCKED_MTP_MARGIN_SECS - now;
    if left <= 0 {
        tip_height
    } else {
        tip_height.saturating_add(((left + 599) / 600) as u32)
    }
}

/// Scan a vault's addresses via Esplora and compute its on-chain
/// unlock-maturity estimate, plus the balance the same scan saw. Blocking BDK + HTTP work runs on a
/// dedicated thread. Esplora failures surface as `BlockingErr::Esplora`
/// so callers can treat "couldn't reach the chain" as "not ready yet".
pub(crate) async fn scan_unlock_estimate(
    descriptor_external: String,
    descriptor_internal: String,
    network: Network,
    timelock_blocks: u32,
    label: Option<String>,
) -> Result<ScanOutput, BlockingErr> {
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

    let _concurrency_permit = crate::concurrency::acquire_esplora().await;
    tokio::task::spawn_blocking(move || -> Result<ScanOutput, BlockingErr> {
        let mut wallet = ghostkey_core::wallet::build_watch_only(&vault)
            .map_err(|e| BlockingErr::Vault(e.to_string()))?;

        let update = try_each_esplora(&urls, |client| {
            client
                .full_scan(wallet.start_full_scan(), 5, 1)
                .map_err(|e| clean_esplora_err("full_scan", &e))
        })?;
        wallet
            .apply_update(update)
            // Our wallet choked on what the explorer sent. That's this
            // vault's problem, not the explorer's, so it must not pause
            // scans for everyone else.
            .map_err(|e| BlockingErr::Vault(format!("apply_update: {e}")))?;

        let tip_height = wallet.latest_checkpoint().height();
        let csv = vault.timelock_blocks();

        // The youngest confirmed coin gates a full drain. Unconfirmed
        // coins have no started timelock, so they don't lower the unlock
        // height (issuing the link slightly early is harmless — the heir
        // still can't spend until the chain matures).
        let mut youngest_conf: Option<u32> = None;
        let mut has_unspent = false;
        for utxo in wallet.list_unspent() {
            has_unspent = true;
            if let bdk_wallet::chain::ChainPosition::Confirmed { anchor, .. } = utxo.chain_position
            {
                let h = anchor.block_id.height;
                youngest_conf = Some(youngest_conf.map_or(h, |y| y.max(h)));
            }
        }

        let unlock_height = match ghostkey_core::descriptor::locked_dates(
            vault.descriptor_for(ghostkey_core::keys::Chain::External),
        ) {
            // A locked goal's heir waits for a date, not a deposit's age.
            Some((_, heir_after)) => youngest_conf
                .map(|_| locked_unlock_height(tip_height, heir_after, Utc::now().timestamp())),
            None => youngest_conf.map(|h| h.saturating_add(csv)),
        };
        let bal = wallet.balance();
        let (deposits, still_unspent) = deposits_and_unspent(&wallet);

        Ok(ScanOutput {
            estimate: UnlockEstimate {
                tip_height,
                unlock_height,
                has_unspent,
            },
            balance: ScanBalance {
                confirmed_sat: bal.confirmed.to_sat(),
                unconfirmed_sat: (bal.trusted_pending + bal.untrusted_pending).to_sat(),
            },
            deposits,
            still_unspent,
        })
    })
    .await
    .map_err(|e| BlockingErr::Vault(format!("scan worker panic: {e}")))?
}

/// How long a cached on-chain maturity estimate stays usable before a
/// rescan (~1 block): finer granularity is wasted when the chain only
/// advances every ~10 min, and it caps Esplora load per waiting vault.
pub(crate) const MATURITY_CACHE_TTL_SECS: i64 = 600;

/// First pause after the block explorer fails. Each further failure in a
/// row doubles it, up to [`EXPLORER_BACKOFF_MAX_SECS`].
const EXPLORER_BACKOFF_BASE_SECS: i64 = 60;
/// Longest pause: one cache lifetime, about a block. Past that a waiting
/// vault would be scanned less often than a healthy one.
const EXPLORER_BACKOFF_MAX_SECS: i64 = MATURITY_CACHE_TTL_SECS;

/// Pause on maturity scans after a network's block explorer fails.
///
/// A failed scan writes nothing to the vault's cache, so without this the
/// next tick rescans the same vault 30 seconds later. When the explorer
/// is rate limiting us, every waiting vault then retries every tick, and
/// we answer a 429 by asking twenty times harder. The pause covers every
/// vault on that network rather than one vault, because a rate limit or
/// an outage is about the explorer, not about any one vault: once one
/// scan fails, the rest of the tick would fail the same way.
///
/// It is kept PER NETWORK because each network has its own explorers
/// (see [`esplora_urls`]). A rate-limited public testnet explorer must
/// never pause mainnet scans: when the pause was global, one 429 from
/// a test vault's explorer stopped heir contact for every real vault.
///
/// Only explorer errors trip it. A bad descriptor fails the same on every
/// endpoint and must not stall every other vault.
#[derive(Debug, Default)]
pub(crate) struct ExplorerBackoff {
    failures: u32,
    retry_at: Option<chrono::DateTime<Utc>>,
}

impl ExplorerBackoff {
    /// Seconds left in the current pause, or `None` when a scan may go
    /// ahead.
    fn remaining_secs(&self, now: chrono::DateTime<Utc>) -> Option<i64> {
        let left = (self.retry_at? - now).num_seconds();
        (left > 0).then_some(left)
    }

    fn record_failure(&mut self, now: chrono::DateTime<Utc>) {
        self.failures = self.failures.saturating_add(1);
        let doublings = (self.failures - 1).min(16);
        let secs = EXPLORER_BACKOFF_BASE_SECS
            .saturating_mul(1_i64 << doublings)
            .min(EXPLORER_BACKOFF_MAX_SECS);
        self.retry_at = Some(now + chrono::Duration::seconds(secs));
    }

    fn record_success(&mut self) {
        *self = Self::default();
    }
}

/// Only the explorer's own failures pause scans. Anything else is about
/// one vault and would fail the same on every retry, so pausing everyone
/// for it would let one broken vault stall the rest.
fn trips_backoff(e: &BlockingErr) -> bool {
    matches!(e, BlockingErr::Esplora(_))
}

type BackoffByNetwork = std::collections::HashMap<Network, ExplorerBackoff>;

fn explorer_backoff() -> &'static std::sync::Mutex<BackoffByNetwork> {
    static B: std::sync::OnceLock<std::sync::Mutex<BackoffByNetwork>> = std::sync::OnceLock::new();
    B.get_or_init(Default::default)
}

/// Seconds left in `network`'s explorer pause, or `None` when its scans
/// may go ahead. Other networks' pauses don't count.
fn backoff_remaining(network: Network, now: chrono::DateTime<Utc>) -> Option<i64> {
    explorer_backoff()
        .lock()
        .expect("explorer backoff poisoned")
        .get(&network)
        .and_then(|b| b.remaining_secs(now))
}

/// Feed a scan's outcome into `network`'s pause.
fn backoff_record<T>(
    network: Network,
    scanned: &Result<T, BlockingErr>,
    now: chrono::DateTime<Utc>,
) {
    let mut all = explorer_backoff()
        .lock()
        .expect("explorer backoff poisoned");
    let backoff = all.entry(network).or_default();
    match scanned {
        Ok(_) => backoff.record_success(),
        Err(e) if trips_backoff(e) => backoff.record_failure(now),
        Err(_) => {}
    }
}

/// When maturity scans on the server's own network may resume, or `None`
/// if they aren't paused. For `/health`.
pub(crate) fn explorer_retry_at(now: chrono::DateTime<Utc>) -> Option<chrono::DateTime<Utc>> {
    let net = crate::config::parse_network(crate::config::default_network()).ok()?;
    let all = explorer_backoff()
        .lock()
        .expect("explorer backoff poisoned");
    let b = all.get(&net)?;
    b.remaining_secs(now).and(b.retry_at)
}

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
    pub cached_has_unspent: Option<i64>,
}

/// Return the vault's unlock estimate, reusing the cached value while it
/// is fresh and otherwise rescanning Esplora and writing the cache back.
/// Shared by the scheduler's heir-contact gate and the heir-facing
/// `/claim/:token/unlock-estimate` endpoint so both see one source.
/// The cached estimate, if it is fresh (younger than
/// [`MATURITY_CACHE_TTL_SECS`]) and complete. A fresh row with no tip
/// means we have never scanned, so it doesn't count.
fn fresh_cached_estimate(
    input: &EstimateInput,
    now: chrono::DateTime<Utc>,
) -> Option<UnlockEstimate> {
    let fresh = input
        .cached_scanned_at
        .as_deref()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|t| (now - t.with_timezone(&Utc)).num_seconds() < MATURITY_CACHE_TTL_SECS)
        .unwrap_or(false);
    if !fresh {
        return None;
    }
    match (input.cached_tip_height, input.cached_has_unspent) {
        (Some(tip), Some(has_unspent)) => Some(UnlockEstimate {
            tip_height: tip as u32,
            unlock_height: input.cached_unlock_height.map(|h| h as u32),
            has_unspent: has_unspent != 0,
        }),
        _ => None,
    }
}

/// The scheduler's read: the fresh cached estimate, never a network
/// call. Slow or rate-limited explorers used to stretch one scheduler
/// tick to minutes, delaying reminders and alarms for every vault. Now
/// the background refresher does the scanning, and a vault without a
/// fresh estimate simply waits (`NotScannedYet`).
pub(crate) fn cached_unlock_estimate(
    input: &EstimateInput,
    now: chrono::DateTime<Utc>,
) -> Result<UnlockEstimate, BlockingErr> {
    fresh_cached_estimate(input, now).ok_or(BlockingErr::NotScannedYet)
}

pub(crate) async fn unlock_estimate_with_cache(
    db: &sqlx::SqlitePool,
    input: &EstimateInput,
    now: chrono::DateTime<Utc>,
) -> Result<UnlockEstimate, BlockingErr> {
    if let Some(est) = fresh_cached_estimate(input, now) {
        return Ok(est);
    }
    Ok(scan_and_cache(db, input, now).await?.estimate)
}

/// Scan the vault now and save everything the scan saw: the balance, new
/// and spent deposits, and the maturity cache the scheduler reads. One
/// explorer lookup serves the owner's balance and the scheduler alike.
pub(crate) async fn scan_and_cache(
    db: &sqlx::SqlitePool,
    input: &EstimateInput,
    now: chrono::DateTime<Utc>,
) -> Result<ScanOutput, BlockingErr> {
    let net = crate::config::parse_network(&input.network)
        .map_err(|e| BlockingErr::Vault(format!("unknown vault network: {e}")))?;

    // The explorer failed recently. Fail this one without asking, the
    // same way a failed scan would, so nothing advances on a chain we
    // couldn't read.
    if let Some(secs) = backoff_remaining(net, now) {
        return Err(BlockingErr::BackingOff(secs));
    }

    let scanned = scan_unlock_estimate(
        input.descriptor_external.clone(),
        input.descriptor_internal.clone(),
        net,
        input.timelock_blocks.max(0) as u32,
        None,
    )
    .await;
    backoff_record(net, &scanned, now);
    let out = scanned?;
    // Record what came in and what left now, not when the owner next
    // opens the app, so deposits land in the right week.
    record_scan(
        db,
        &input.vault_id,
        out.balance,
        &out.deposits,
        &out.still_unspent,
        now,
    )
    .await;

    let est = out.estimate.clone();
    if let Err(e) = sqlx::query(
        r#"UPDATE vaults
              SET chain_unlock_height = ?,
                  chain_tip_height    = ?,
                  chain_scanned_at    = ?,
                  chain_has_unspent   = ?
            WHERE id = ?"#,
    )
    .bind(est.unlock_height.map(|h| h as i64))
    .bind(est.tip_height as i64)
    .bind(now.to_rfc3339())
    .bind(i64::from(est.has_unspent))
    .bind(&input.vault_id)
    .execute(db)
    .await
    {
        tracing::warn!(vault_id = %input.vault_id, error = ?e,
            "could not cache on-chain maturity estimate");
    }
    Ok(out)
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

/// What one scan says came in and what is still there, for
/// [`record_new_deposits`] and [`record_spent_deposits`]. Used by the live
/// balance lookup and the background chain refresher, so a deposit is
/// recorded within minutes of confirming whether or not the owner opens
/// the app (streaks and challenges count it in the right week).
///
/// `deposits` are confirmed receives: external keychain only, since the
/// internal keychain is owner-send change, not a deposit (#213).
///
/// `still_unspent` is the same walk without either filter: every outpoint
/// the wallet can still spend, change and unconfirmed included. What's
/// missing from it is what left the vault. Keeping unconfirmed entries in
/// is what makes a reorg safe: a deposit whose confirmation is rolled back
/// reappears here as pending, so it reads as present, not spent.
fn deposits_and_unspent(wallet: &bdk_wallet::Wallet) -> (Vec<ConfirmedDeposit>, Vec<String>) {
    let mut deposits = Vec::new();
    let mut still_unspent = Vec::new();
    for utxo in wallet.list_unspent() {
        still_unspent.push(utxo.outpoint.to_string());
        if utxo.keychain != bdk_wallet::KeychainKind::External {
            continue;
        }
        if let bdk_wallet::chain::ChainPosition::Confirmed { anchor, .. } = utxo.chain_position {
            deposits.push(ConfirmedDeposit {
                outpoint: utxo.outpoint.to_string(),
                amount_sat: utxo.txout.value.to_sat() as i64,
                height: anchor.block_id.height,
            });
        }
    }
    (deposits, still_unspent)
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

/// The mirror of `record_new_deposits`: log money that has *left*.
///
/// `owner_send` and `claim_broadcast` already cover spends the server
/// itself built. Nothing covered the rest — an owner spending from the
/// offline recovery kit, or from a wallet they imported the descriptor
/// into, emptied the vault and the feed stayed silent. The dashboard
/// showed a zero balance with no line explaining where it went.
///
/// `still_unspent` is every outpoint the scan can still spend. Any
/// recorded deposit missing from it is gone, so we stamp `spent_at` and
/// emit one `funds_spent` event. The stamp does for spends what the
/// primary key does for receives: the UPDATE only touches rows where
/// `spent_at IS NULL`, so a later scan of the same vault is a no-op.
///
/// Spends the server *did* build are stamped but stay silent, because
/// `owner_send` and `claim_broadcast` already tell that story with the
/// destination and txid this function cannot know. The test is whether
/// the deposit was seen before the vault's most recent server-built
/// spend: if it was, that spend consumed it. Only external-keychain
/// deposits are in this table (change from a send lands on the internal
/// keychain and is never recorded), so a partial send consumes every
/// row that predates it and leaves nothing to misattribute. A deposit
/// that arrives afterwards has a later `seen_at` and still reports.
///
/// Deliberately narrow when it does speak. It says the coin left; it
/// does not say where or why, because a chain scan cannot tell an
/// owner's move from a theft. Naming a cause we can't verify would be
/// worse than the silence this replaces.
///
/// Best-effort, like its sibling: a logging failure must never fail the
/// balance read that triggered it.
pub(crate) async fn record_spent_deposits(
    db: &sqlx::SqlitePool,
    vault_id: &str,
    still_unspent: &[String],
    now: chrono::DateTime<Utc>,
) {
    let recorded: Vec<(String, i64, String)> = match sqlx::query_as(
        "SELECT outpoint, amount_sat, seen_at FROM vault_deposits \
          WHERE vault_id = ? AND spent_at IS NULL",
    )
    .bind(vault_id)
    .fetch_all(db)
    .await
    {
        Ok(rows) => rows,
        Err(e) => {
            tracing::warn!(error = %e, vault_id, "could not read deposits to check for spends");
            return;
        }
    };
    if recorded.is_empty() {
        return;
    }

    // Timestamps are RFC3339 written by this process, so they compare
    // lexicographically. An error here reads as "no server-built spend",
    // which errs toward reporting rather than staying quiet.
    let last_server_spend: Option<String> = sqlx::query_scalar(
        "SELECT MAX(created_at) FROM events \
          WHERE vault_id = ? AND kind IN ('owner_send', 'claim_broadcast', 'coins_refreshed', 'vault_upgraded')",
    )
    .bind(vault_id)
    .fetch_one(db)
    .await
    .unwrap_or(None);

    let live: std::collections::HashSet<&str> = still_unspent.iter().map(String::as_str).collect();
    // An upgrade transaction still waiting to reach the network (#389):
    // its deposit has been carried to a coin the scan can't see yet. Not
    // spent, just not there yet.
    let waiting: std::collections::HashSet<String> = sqlx::query_scalar(
        "SELECT txid FROM vault_upgrade_txs WHERE vault_id = ? AND broadcast_at IS NULL",
    )
    .bind(vault_id)
    .fetch_all(db)
    .await
    .unwrap_or_default()
    .into_iter()
    .collect();

    for (outpoint, amount_sat, seen_at) in recorded {
        if live.contains(outpoint.as_str()) {
            continue;
        }
        if outpoint
            .split_once(':')
            .is_some_and(|(txid, _)| waiting.contains(txid))
        {
            continue;
        }
        // CAS on spent_at: whichever concurrent scan wins gets the row,
        // the loser sees 0 rows and stays quiet.
        let stamped = sqlx::query(
            "UPDATE vault_deposits SET spent_at = ? \
              WHERE vault_id = ? AND outpoint = ? AND spent_at IS NULL",
        )
        .bind(now.to_rfc3339())
        .bind(vault_id)
        .bind(&outpoint)
        .execute(db)
        .await;

        match stamped {
            Ok(res) if res.rows_affected() == 1 => {}
            Ok(_) => continue, // another scan already claimed it
            Err(e) => {
                tracing::warn!(error = %e, vault_id, "failed to stamp spent deposit");
                continue;
            }
        }

        if last_server_spend
            .as_deref()
            .is_some_and(|t| seen_at.as_str() <= t)
        {
            continue; // already reported as an owner send or a claim
        }

        if let Err(e) = crate::routes::record_event(
            db,
            vault_id,
            "funds_spent",
            Some(serde_json::json!({
                "amount_sat": amount_sat,
                "outpoint": outpoint,
            })),
        )
        .await
        {
            tracing::warn!(error = %e, vault_id, "failed to record funds_spent event");
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
    type Row = (
        String,         // network
        String,         // descriptor_external
        String,         // descriptor_internal
        i64,            // timelock_blocks
        Option<i64>,    // balance_confirmed_sat
        Option<i64>,    // balance_unconfirmed_sat
        Option<String>, // balance_checked_at
    );
    let row: Option<Row> = sqlx::query_as(
        r#"SELECT network, descriptor_external, descriptor_internal, timelock_blocks,
                  balance_confirmed_sat, balance_unconfirmed_sat, balance_checked_at
             FROM vaults WHERE id = ?"#,
    )
    .bind(&id)
    .fetch_optional(&state.db)
    .await?;
    let (network_s, ext, int_, timelock, saved_conf, saved_unconf, saved_at) =
        row.ok_or(ApiError::NotFound)?;
    crate::config::parse_network(&network_s).map_err(|name| {
        ApiError::Validation(format!(
            "stored vault network {name} is not a known Bitcoin network"
        ))
    })?;

    // A balance read in the last minute is still the balance: a reload or
    // a second tab doesn't cost the public explorers another lookup.
    let now = Utc::now();
    if let (Some(c), Some(u), Some(at)) = (saved_conf, saved_unconf, saved_at.as_deref()) {
        let fresh = chrono::DateTime::parse_from_rfc3339(at)
            .map(|t| (now - t.with_timezone(&Utc)).num_seconds() < BALANCE_REUSE_SECS)
            .unwrap_or(false);
        if fresh {
            let (c, u) = (c.max(0) as u64, u.max(0) as u64);
            return Ok(Json(VaultBalanceView {
                vault_id: id,
                network: network_s,
                confirmed_sat: c,
                unconfirmed_sat: u,
                total_sat: c + u,
            }));
        }
    }

    // One scan for both the owner's balance and the scheduler's cache, so
    // opening the app also brings the vault's chain data up to date.
    let input = EstimateInput {
        vault_id: id.clone(),
        descriptor_external: ext,
        descriptor_internal: int_,
        network: network_s.clone(),
        timelock_blocks: timelock,
        cached_unlock_height: None,
        cached_tip_height: None,
        cached_scanned_at: None,
        cached_has_unspent: None,
    };
    let out = scan_and_cache(&state.db, &input, now).await?;
    let (confirmed_sat, unconfirmed_sat) = (out.balance.confirmed_sat, out.balance.unconfirmed_sat);
    Ok(Json(VaultBalanceView {
        vault_id: id,
        network: network_s,
        confirmed_sat,
        unconfirmed_sat,
        total_sat: confirmed_sat + unconfirmed_sat,
    }))
}

/// How long a balance read stays good enough to hand back without asking
/// the explorer again.
const BALANCE_REUSE_SECS: i64 = 60;

/// Response from `GET /vaults/:id/balance/last`.
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct LastBalanceView {
    pub vault_id: String,
    pub network: String,
    pub confirmed_sat: u64,
    pub unconfirmed_sat: u64,
    pub total_sat: u64,
    /// When the scan that saw this balance finished (RFC3339).
    pub checked_at: String,
}

/// The balance from the vault's last successful scan, straight from the
/// database, so Home has a number at once. No chain call. 404 until the
/// first scan has finished. Public, like `GET /vaults/:id/balance`, which
/// tells anyone with the id the same thing, live.
pub async fn get_last_balance(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<LastBalanceView>, ApiError> {
    last_balance(&state.db, &id)
        .await?
        .map(Json)
        .ok_or(ApiError::NotFound)
}

async fn last_balance(
    db: &sqlx::SqlitePool,
    id: &str,
) -> Result<Option<LastBalanceView>, ApiError> {
    type Row = (String, Option<i64>, Option<i64>, Option<String>);
    let row: Option<Row> = sqlx::query_as(
        "SELECT network, balance_confirmed_sat, balance_unconfirmed_sat, balance_checked_at \
           FROM vaults WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    let Some((network, Some(confirmed), Some(unconfirmed), Some(checked_at))) = row else {
        return Ok(None);
    };
    let confirmed_sat = confirmed.max(0) as u64;
    let unconfirmed_sat = unconfirmed.max(0) as u64;
    Ok(Some(LastBalanceView {
        vault_id: id.to_string(),
        network,
        confirmed_sat,
        unconfirmed_sat,
        total_sat: confirmed_sat + unconfirmed_sat,
        checked_at,
    }))
}

/* -------------------------------------------------------------------------- *
 *  Owner sends signed in the browser (#442)                                  *
 *                                                                            *
 *  The browser asks for the vault's confirmed history, builds and signs the  *
 *  send itself with the recovery kit's signer (ghostkey-wasm, the same      *
 *  audited ghostkey-core code), and hands back only the finished            *
 *  transaction. The owner's key never leaves the browser.                    *
 * -------------------------------------------------------------------------- */

#[derive(Debug, Serialize)]
pub struct FundingTxView {
    pub tx_hex: String,
    pub confirmation_height: u32,
}

#[derive(Debug, Serialize)]
pub struct SpendCoinsView {
    pub network: String,
    pub chain_tip_height: u32,
    /// Every confirmed transaction touching the vault: deposits AND the
    /// spends of them, so the browser's signer works out exactly the
    /// coins that are still unspent.
    pub funding: Vec<FundingTxView>,
    /// Coins the browser can spend (confirmed).
    pub confirmed_sat: u64,
    /// Coins still waiting for a confirmation; not spendable this way yet.
    pub unconfirmed_sat: u64,
    /// Suggested fee rate, sat/vB.
    pub fee_rate_sat_per_vb: u64,
    /// Each coin still in the vault, for "Keep it protected" (#94).
    pub coins: Vec<CoinView>,
    /// A fresh change address to refresh coins into, with its index so the
    /// browser checks it against its own copy of the descriptors (#378).
    /// Only on the owner's view.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refresh_address: Option<IndexedAddressView>,
}

#[derive(Debug, Serialize)]
pub struct CoinView {
    pub outpoint: String,
    pub value_sat: u64,
    /// The block it confirmed in; `None` while it waits for one.
    pub confirmation_height: Option<u32>,
}

#[derive(Debug, Serialize)]
pub struct IndexedAddressView {
    pub address: String,
    pub index: u32,
}

/// Fee rate to suggest: the explorers' estimate for about two hours
/// (12 blocks), never below 2 sat/vB so a send doesn't sit for days, and
/// 2 sat/vB if they don't answer. Savings sends and heir claims are not
/// urgent, and on small sends the hour estimate can eat half the amount.
fn suggested_fee_rate(estimates: Option<std::collections::HashMap<u16, f64>>) -> u64 {
    estimates
        .and_then(|m| {
            m.get(&12)
                .or_else(|| m.get(&6))
                .or_else(|| m.get(&3))
                .copied()
        })
        .map(|r| r.ceil() as u64)
        .unwrap_or(2)
        .clamp(2, 500)
}

/// What stays in the vault after a send: everything it held, less the
/// coins this send spent, plus any change it pays back. The change alone
/// is not enough: a send that spends one coin leaves the others, and
/// counting only the change called a vault empty that still held money.
fn left_after_send(vault_total: u64, spent_in: u64, change: u64) -> u64 {
    vault_total.saturating_sub(spent_in) + change
}

/// Scan a vault and return what a browser needs to sign a spend of it
/// itself: every confirmed transaction (deposits and spends), the tip,
/// balances and a fee suggestion. Blocking (explorer calls). Shared by
/// the owner's send and the heir's claim.
fn scan_spend_coins(
    vault: &Vault,
    network: Network,
    urls: &Explorers,
) -> Result<SpendCoinsView, BlockingErr> {
    let mut wallet = ghostkey_core::wallet::build_watch_only(vault)
        .map_err(|e| BlockingErr::Vault(e.to_string()))?;
    let estimates = std::cell::RefCell::new(None);
    let update = try_each_esplora(urls, |client| {
        let u = client
            .full_scan(wallet.start_full_scan(), 5, 1)
            .map_err(|e| clean_esplora_err("full_scan", &e))?;
        *estimates.borrow_mut() = client.get_fee_estimates().ok();
        Ok(u)
    })?;
    wallet
        .apply_update(update)
        .map_err(|e| BlockingErr::Esplora(format!("apply_update: {e}")))?;
    let funding = wallet
        .transactions()
        .filter_map(|t| match t.chain_position {
            bdk_wallet::chain::ChainPosition::Confirmed { anchor, .. } => Some(FundingTxView {
                tx_hex: bitcoin::consensus::encode::serialize_hex(t.tx_node.tx.as_ref()),
                confirmation_height: anchor.block_id.height,
            }),
            _ => None,
        })
        .collect();
    let bal = wallet.balance();
    let coins = wallet
        .list_unspent()
        .map(|u| CoinView {
            outpoint: u.outpoint.to_string(),
            value_sat: u.txout.value.to_sat(),
            confirmation_height: match u.chain_position {
                bdk_wallet::chain::ChainPosition::Confirmed { anchor, .. } => {
                    Some(anchor.block_id.height)
                }
                _ => None,
            },
        })
        .collect();
    let change = wallet.next_unused_address(bdk_wallet::KeychainKind::Internal);
    Ok(SpendCoinsView {
        network: network.to_string(),
        chain_tip_height: wallet.latest_checkpoint().height(),
        funding,
        confirmed_sat: bal.confirmed.to_sat(),
        unconfirmed_sat: (bal.trusted_pending + bal.untrusted_pending).to_sat(),
        fee_rate_sat_per_vb: suggested_fee_rate(estimates.into_inner()),
        coins,
        refresh_address: Some(IndexedAddressView {
            address: change.address.to_string(),
            index: change.index,
        }),
    })
}

/// `GET /vaults/:id/coins` (owner): what the browser needs to build and
/// sign a send itself. Holds no keys.
pub async fn get_spend_coins(
    auth: crate::auth::OwnerAuth,
    State(state): State<Arc<AppState>>,
) -> Result<Json<SpendCoinsView>, ApiError> {
    let (vault, network) = load_vault_watch(&state, &auth.vault_id).await?;
    let urls = esplora_urls(network)?;
    let _permit = crate::concurrency::acquire_esplora().await;
    let view = tokio::task::spawn_blocking(move || scan_spend_coins(&vault, network, &urls))
        .await
        .map_err(|e| ApiError::Validation(format!("worker panic: {e}")))??;
    Ok(Json(view))
}

#[derive(Debug, Deserialize)]
pub struct SignedSendRequest {
    /// The finished, signed transaction, as hex.
    pub tx_hex: String,
    /// Where the owner said to send it (for the receipt and the check).
    pub destination: String,
}

/// What a signed send does, from the vault's point of view. Pure, so
/// it's tested without the network.
#[derive(Debug, PartialEq, Eq)]
struct SignedSendSummary {
    total_in: u64,
    sent_sat: u64,
    fee_sat: u64,
    remaining_sat: u64,
}

/// Check a browser-signed send against the vault: every input must be a
/// vault coin that is still unspent (`prevout_value` answers that), and
/// every output must pay the destination or come back to the vault.
fn summarize_signed_send(
    tx: &bitcoin::Transaction,
    dest_spk: &bitcoin::ScriptBuf,
    prevout_value: impl Fn(&bitcoin::OutPoint) -> Option<u64>,
    is_vault: impl Fn(&bitcoin::ScriptBuf) -> bool,
) -> Result<SignedSendSummary, String> {
    if tx.input.is_empty() {
        return Err("That transaction spends nothing.".into());
    }
    let mut total_in = 0u64;
    for input in &tx.input {
        total_in += prevout_value(&input.previous_output).ok_or_else(|| {
            "That transaction spends coins that aren't in this vault, or are already spent."
                .to_string()
        })?;
    }
    let mut sent = 0u64;
    let mut out_sum = 0u64;
    for o in &tx.output {
        let v = o.value.to_sat();
        out_sum += v;
        if &o.script_pubkey == dest_spk {
            sent += v;
        } else if !is_vault(&o.script_pubkey) {
            return Err("That transaction pays someone other than the address you entered.".into());
        }
    }
    if sent == 0 {
        return Err("That transaction doesn't pay the address you entered.".into());
    }
    let fee = total_in
        .checked_sub(out_sum)
        .ok_or_else(|| "That transaction pays out more than it spends.".to_string())?;
    Ok(SignedSendSummary {
        total_in,
        sent_sat: sent,
        fee_sat: fee,
        remaining_sat: out_sum - sent,
    })
}

/// `POST /vaults/:id/send/signed` (owner): broadcast a send the owner's
/// browser built and signed. Checked against the vault first; then the
/// same receipt, activity entry and theft-alarm email as any send.
pub async fn owner_send_signed(
    auth: crate::auth::OwnerAuth,
    State(state): State<Arc<AppState>>,
    Json(req): Json<SignedSendRequest>,
) -> Result<(StatusCode, Json<OwnerSendResponse>), ApiError> {
    let id = auth.vault_id;
    let raw = hex::decode(req.tx_hex.trim())
        .map_err(|_| ApiError::Validation("That isn't a transaction.".into()))?;
    if raw.len() > 100_000 {
        return Err(ApiError::Validation("That transaction is too big.".into()));
    }
    let tx: bitcoin::Transaction = bitcoin::consensus::deserialize(&raw)
        .map_err(|_| ApiError::Validation("That isn't a transaction.".into()))?;
    let (vault, network) = load_vault_watch(&state, &id).await?;
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
    let dest_spk = dest.script_pubkey();
    let urls = esplora_urls(network)?;
    let _permit = crate::concurrency::acquire_esplora().await;
    let (txid, summary) = tokio::task::spawn_blocking(
        move || -> Result<(bitcoin::Txid, SignedSendSummary), BlockingErr> {
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
            let mut summary = summarize_signed_send(
                &tx,
                &dest_spk,
                |op| wallet.get_utxo(*op).map(|u| u.txout.value.to_sat()),
                |spk| wallet.is_mine(spk.clone()),
            )
            .map_err(BlockingErr::Build)?;
            summary.remaining_sat = left_after_send(
                wallet.balance().total().to_sat(),
                summary.total_in,
                summary.remaining_sat,
            );
            try_each_esplora(&urls, |client| {
                client
                    .broadcast(&tx)
                    .map_err(|e| clean_esplora_err("broadcast", &e))
            })?;
            Ok((tx.compute_txid(), summary))
        },
    )
    .await
    .map_err(|e| ApiError::Validation(format!("worker panic: {e}")))??;
    let resp = finish_owner_send(
        &state,
        &id,
        network,
        SentTx {
            txid,
            destination: dest_str,
            total_in: summary.total_in,
            sent_sat: summary.sent_sat,
            fee_sat: summary.fee_sat,
            remaining_sat: summary.remaining_sat,
        },
    )
    .await?;
    Ok((StatusCode::OK, Json(resp)))
}

/* -------------------------------------------------------------------------- *
 *  Refreshing coins (#94)                                                    *
 *                                                                            *
 *  Bitcoin's own lock on a coin (`older(N)`) counts from the block the coin  *
 *  confirmed in. Once it has passed, only GhostKey's check-in stands between *
 *  that coin and the heir's key. A refresh spends the coin back into the     *
 *  vault, so its lock starts again. The browser builds and signs it with    *
 *  the owner key; the server checks it stays in the vault and broadcasts.   *
 * -------------------------------------------------------------------------- */

#[derive(Debug, Deserialize)]
pub struct SignedRefreshRequest {
    pub tx_hex: String,
}

#[derive(Debug, Serialize)]
pub struct RefreshView {
    pub txid: String,
    pub fee_sat: u64,
}

/// What a refresh does, checked without the network: every input is a
/// vault coin, every output pays the vault, and the fee is sane.
#[derive(Debug, PartialEq, Eq)]
struct RefreshSummary {
    spent: Vec<bitcoin::OutPoint>,
    /// The vault output the coins land in (the first, if somehow several).
    landed: bitcoin::OutPoint,
    total_in: u64,
    fee_sat: u64,
}

fn summarize_refresh(
    tx: &bitcoin::Transaction,
    prevout_value: impl Fn(&bitcoin::OutPoint) -> Option<u64>,
    is_vault: impl Fn(&bitcoin::ScriptBuf) -> bool,
) -> Result<RefreshSummary, String> {
    if tx.input.is_empty() || tx.output.is_empty() {
        return Err("That transaction doesn't refresh anything.".into());
    }
    let mut total_in = 0u64;
    let mut spent = Vec::new();
    for input in &tx.input {
        total_in += prevout_value(&input.previous_output).ok_or_else(|| {
            "That transaction spends coins that aren't in this vault, or are already spent."
                .to_string()
        })?;
        spent.push(input.previous_output);
    }
    let mut out_sum = 0u64;
    for o in &tx.output {
        if !is_vault(&o.script_pubkey) {
            return Err("A refresh must pay back into this vault, and this one doesn't.".into());
        }
        out_sum += o.value.to_sat();
    }
    let fee = total_in
        .checked_sub(out_sum)
        .ok_or_else(|| "That transaction pays out more than it spends.".to_string())?;
    // A refresh moves money from the vault to the vault: anything close
    // to half of it going to fees is a mistake, not a refresh.
    if fee * 2 > total_in {
        return Err("The fee would be more than half of what you're refreshing.".into());
    }
    Ok(RefreshSummary {
        spent,
        landed: bitcoin::OutPoint {
            txid: tx.compute_txid(),
            vout: 0,
        },
        total_in,
        fee_sat: fee,
    })
}

/// Carry the refreshed deposits' history over to the coin they became, so
/// the savings total, streak and "keep it" challenges see the same savings,
/// less the fee, instead of a withdrawal and a new deposit. Several coins
/// refreshed together become one row, dated from the earliest.
async fn carry_deposits_over(
    db: &sqlx::SqlitePool,
    vault_id: &str,
    summary: &RefreshSummary,
) -> Result<(), sqlx::Error> {
    let mut tx = db.begin().await?;
    let mut rows: Vec<(String, i64, String)> = Vec::new();
    for op in &summary.spent {
        let row: Option<(String, i64, String)> = sqlx::query_as(
            "SELECT outpoint, amount_sat, seen_at FROM vault_deposits \
              WHERE vault_id = ? AND outpoint = ? AND spent_at IS NULL",
        )
        .bind(vault_id)
        .bind(op.to_string())
        .fetch_optional(&mut *tx)
        .await?;
        rows.extend(row);
    }
    if rows.is_empty() {
        return tx.commit().await; // change from a send: no deposit to carry
    }
    rows.sort_by(|a, b| a.2.cmp(&b.2));
    let total: i64 = rows.iter().map(|r| r.1).sum();
    let keep = rows[0].0.clone();
    for (op, ..) in rows.iter().skip(1) {
        sqlx::query("DELETE FROM vault_deposits WHERE vault_id = ? AND outpoint = ?")
            .bind(vault_id)
            .bind(op)
            .execute(&mut *tx)
            .await?;
    }
    sqlx::query(
        "UPDATE vault_deposits SET outpoint = ?, amount_sat = ? \
          WHERE vault_id = ? AND outpoint = ?",
    )
    .bind(summary.landed.to_string())
    .bind((total - summary.fee_sat as i64).max(0))
    .bind(vault_id)
    .bind(&keep)
    .execute(&mut *tx)
    .await?;
    tx.commit().await
}

/// `POST /vaults/:id/refresh/signed` (owner): broadcast a refresh the
/// owner's browser signed. No email: nothing left the vault.
pub async fn owner_refresh_signed(
    auth: crate::auth::OwnerAuth,
    State(state): State<Arc<AppState>>,
    Json(req): Json<SignedRefreshRequest>,
) -> Result<(StatusCode, Json<RefreshView>), ApiError> {
    let id = auth.vault_id;
    let raw = hex::decode(req.tx_hex.trim())
        .map_err(|_| ApiError::Validation("That isn't a transaction.".into()))?;
    if raw.len() > 100_000 {
        return Err(ApiError::Validation("That transaction is too big.".into()));
    }
    let tx: bitcoin::Transaction = bitcoin::consensus::deserialize(&raw)
        .map_err(|_| ApiError::Validation("That isn't a transaction.".into()))?;
    let (vault, network) = load_vault_watch(&state, &id).await?;
    let urls = esplora_urls(network)?;
    let _permit = crate::concurrency::acquire_esplora().await;
    let summary = tokio::task::spawn_blocking(move || -> Result<RefreshSummary, BlockingErr> {
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
        let summary = summarize_refresh(
            &tx,
            |op| wallet.get_utxo(*op).map(|u| u.txout.value.to_sat()),
            |spk| wallet.is_mine(spk.clone()),
        )
        .map_err(BlockingErr::Build)?;
        try_each_esplora(&urls, |client| {
            client
                .broadcast(&tx)
                .map_err(|e| clean_esplora_err("broadcast", &e))
        })?;
        Ok(summary)
    })
    .await
    .map_err(|e| ApiError::Validation(format!("worker panic: {e}")))??;

    // The event first: a scan that runs before the deposits are carried
    // over then reads the vanished coin as the owner's own move, not an
    // unexplained spend (record_spent_deposits).
    crate::routes::record_event(
        &state.db,
        &id,
        "coins_refreshed",
        Some(serde_json::json!({
            "txid": summary.landed.txid.to_string(),
            "coins": summary.spent.len(),
            "total_input_sats": summary.total_in,
            "fee_sats": summary.fee_sat,
        })),
    )
    .await?;
    if let Err(e) = carry_deposits_over(&state.db, &id, &summary).await {
        tracing::warn!(vault_id = %id, error = ?e, "could not carry deposits over a refresh");
    }
    if let Err(e) = sqlx::query("UPDATE vaults SET chain_scanned_at = NULL WHERE id = ?")
        .bind(&id)
        .execute(&state.db)
        .await
    {
        tracing::warn!(vault_id = %id, error = ?e, "could not mark vault for rescan");
    }
    Ok((
        StatusCode::OK,
        Json(RefreshView {
            txid: summary.landed.txid.to_string(),
            fee_sat: summary.fee_sat,
        }),
    ))
}

/* -------------------------------------------------------------------------- *
 *  Using the vault in another wallet (#387)                                  *
 *                                                                            *
 *  The vault's public descriptors, in the forms other wallets import: one   *
 *  multipath descriptor for Liana (standard format only) and an             *
 *  `importdescriptors` command for Bitcoin Core (any format). They let a    *
 *  wallet see the money and its addresses; spending still needs the key.    *
 * -------------------------------------------------------------------------- */

#[derive(Debug, Serialize)]
pub struct ExportView {
    /// "standard" (Liana and Core), "legacy" (Core only; can move to the
    /// standard format, #389), "locked" (a locked goal; Core only).
    pub format: &'static str,
    pub network: String,
    pub descriptor_external: String,
    pub descriptor_internal: String,
    /// The one descriptor Liana imports, when the vault is standard.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub liana_descriptor: Option<String>,
    /// The JSON for Bitcoin Core's `importdescriptors`.
    pub core_import: String,
}

/// `GET /vaults/:id/export` (owner).
pub async fn get_export(
    auth: crate::auth::OwnerAuth,
    State(state): State<Arc<AppState>>,
) -> Result<Json<ExportView>, ApiError> {
    let (ext, int_, net, created): (String, String, String, String) = sqlx::query_as(
        "SELECT descriptor_external, descriptor_internal, network, created_at FROM vaults WHERE id = ?",
    )
    .bind(&auth.vault_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or(ApiError::NotFound)?;
    Ok(Json(build_export(&ext, &int_, net, &created)?))
}

/// The export for a stored vault; pure, so it's tested without a server.
fn build_export(ext: &str, int_: &str, net: String, created: &str) -> Result<ExportView, ApiError> {
    use ghostkey_core::descriptor::{
        locked_dates, standard_multipath, upgrade_legacy_pair, with_checksum,
    };
    let liana = standard_multipath(ext, int_);
    let format = if liana.is_some() {
        "standard"
    } else if upgrade_legacy_pair(ext, int_).is_some() {
        "legacy"
    } else if locked_dates(ext).is_some() {
        "locked"
    } else {
        return Err(ApiError::Conflict("This vault can't be exported.".into()));
    };
    let bad = |e: ghostkey_core::Error| {
        ApiError::Validation(format!("stored vault descriptors invalid: {e}"))
    };
    let ext_c = with_checksum(ext).map_err(bad)?;
    let int_c = with_checksum(int_).map_err(bad)?;
    // Core rescans from here: a day before the vault existed, to be safe.
    let since = crate::config::parse_rfc(created).timestamp() - 86_400;
    let core_import = serde_json::json!([
        { "desc": ext_c, "timestamp": since, "active": true, "internal": false, "range": [0, 999] },
        { "desc": int_c, "timestamp": since, "active": true, "internal": true, "range": [0, 999] },
    ])
    .to_string();
    Ok(ExportView {
        format,
        network: net,
        descriptor_external: ext_c,
        descriptor_internal: int_c,
        liana_descriptor: liana,
        core_import,
    })
}

/* -------------------------------------------------------------------------- *
 *  Upgrading a legacy vault to the standard format (#389)                    *
 *                                                                            *
 *  Same owner key, heir key and wait; only the script's shape changes, so    *
 *  other wallets (Liana) can open it and owner sends are cheaper. Coins      *
 *  can't change format in place, so each deposit moves, in its own           *
 *  transaction (no merging them on-chain), signed in the owner's browser,    *
 *  to the new format's change addresses. The server checks every old coin    *
 *  is covered and every output pays the new format, broadcasts, then         *
 *  switches the vault to the new descriptors and keeps the old on record.    *
 *  A transaction that failed to broadcast is kept and retried by the         *
 *  scheduler (`rebroadcast_upgrade_txs`) until it is on the network.         *
 * -------------------------------------------------------------------------- */

/// The standard pair a vault would upgrade to, when it can: a legacy
/// standard vault (not a locked goal or guardian vault) with no claim
/// running.
pub(crate) fn upgrade_target(
    external: &str,
    internal: &str,
    vault_kind: &str,
    status: &str,
) -> Option<ghostkey_core::descriptor::StandardDescriptor> {
    if vault_kind != "standard" || matches!(status, "timelock_started" | "claiming" | "claimed") {
        return None;
    }
    ghostkey_core::descriptor::upgrade_legacy_pair(external, internal)
}

#[derive(Debug, Serialize)]
pub struct UpgradeView {
    pub available: bool,
    /// The new pair, for the browser to check against what it derives
    /// itself from the descriptors it pinned.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub descriptor_external: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub descriptor_internal: Option<String>,
}

async fn load_upgrade(
    state: &AppState,
    id: &str,
) -> Result<
    (
        String,
        String,
        Option<ghostkey_core::descriptor::StandardDescriptor>,
        Network,
        i64,
    ),
    ApiError,
> {
    type Row = (String, String, String, String, String, i64);
    let (ext, int_, kind, status, net, timelock): Row = sqlx::query_as(
        "SELECT descriptor_external, descriptor_internal, vault_kind, status, network, timelock_blocks \
           FROM vaults WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(&state.db)
    .await?
    .ok_or(ApiError::NotFound)?;
    let network = crate::config::parse_network(&net)
        .map_err(|name| ApiError::Validation(format!("unknown network {name}")))?;
    let target = upgrade_target(&ext, &int_, &kind, &status);
    Ok((ext, int_, target, network, timelock))
}

/// `GET /vaults/:id/upgrade` (owner).
pub async fn get_upgrade(
    auth: crate::auth::OwnerAuth,
    State(state): State<Arc<AppState>>,
) -> Result<Json<UpgradeView>, ApiError> {
    let (_, _, target, _, _) = load_upgrade(&state, &auth.vault_id).await?;
    Ok(Json(UpgradeView {
        available: target.is_some(),
        descriptor_external: target.as_ref().map(|t| t.pair.external.clone()),
        descriptor_internal: target.as_ref().map(|t| t.pair.internal.clone()),
    }))
}

#[derive(Debug, Deserialize)]
pub struct SignedUpgradeRequest {
    /// One signed transaction per deposit.
    pub txs: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct UpgradeResultView {
    /// Transactions on the network now.
    pub moved: usize,
    /// Transactions that will be retried until they are.
    pub pending: usize,
    pub fee_sat: u64,
}

/// What the network said about each upgrade transaction.
struct UpgradeOutcome {
    summaries: Vec<RefreshSummary>,
    txs: Vec<(bitcoin::Txid, String)>,
    sent: Vec<bool>,
    first_error: Option<String>,
}

/// Is `tx` known to the network (in the mempool or a block)? Used after a
/// broadcast error: "already known" is success.
fn network_has(client: &esplora_client::BlockingClient, txid: &bitcoin::Txid) -> bool {
    matches!(client.get_tx(txid), Ok(Some(_)))
}

/// Check a set of upgrade transactions without the network: each moves
/// only old-vault coins, pays only the new format, with a sane fee; no
/// coin is spent twice; and every old coin moves, so nothing is left in
/// a format the vault no longer watches.
fn plan_upgrade(
    txs: &[bitcoin::Transaction],
    utxos: &std::collections::HashMap<bitcoin::OutPoint, u64>,
    is_new: impl Fn(&bitcoin::ScriptBuf) -> bool,
) -> Result<Vec<RefreshSummary>, String> {
    let mut summaries = Vec::with_capacity(txs.len());
    let mut covered = std::collections::HashSet::new();
    for tx in txs {
        let summary = summarize_refresh(tx, |op| utxos.get(op).copied(), &is_new)
            .map_err(|e| e.replace("pay back into this vault", "pay the new vault"))?;
        for op in &summary.spent {
            if !covered.insert(*op) {
                return Err("Two transactions spend the same deposit.".into());
            }
        }
        summaries.push(summary);
    }
    if utxos.keys().any(|op| !covered.contains(op)) {
        return Err("Every deposit has to move. Go back, then try again.".into());
    }
    Ok(summaries)
}

/// `POST /vaults/:id/upgrade/signed` (owner).
pub async fn owner_upgrade_signed(
    auth: crate::auth::OwnerAuth,
    State(state): State<Arc<AppState>>,
    Json(req): Json<SignedUpgradeRequest>,
) -> Result<(StatusCode, Json<UpgradeResultView>), ApiError> {
    let id = auth.vault_id;
    let (old_ext, old_int, target, network, timelock) = load_upgrade(&state, &id).await?;
    let Some(target) = target else {
        return Err(ApiError::Conflict(
            "This vault is already in the new format.".into(),
        ));
    };
    // None for an empty vault: nothing to move, only the format changes.
    // `plan_upgrade` refuses an empty list for a vault that holds coins.
    if req.txs.len() > 100 {
        return Err(ApiError::Validation(
            "Send one transaction per deposit.".into(),
        ));
    }
    let mut txs = Vec::with_capacity(req.txs.len());
    for hex_tx in &req.txs {
        let raw = hex::decode(hex_tx.trim())
            .map_err(|_| ApiError::Validation("That isn't a transaction.".into()))?;
        if raw.len() > 100_000 {
            return Err(ApiError::Validation("That transaction is too big.".into()));
        }
        let tx: bitcoin::Transaction = bitcoin::consensus::deserialize(&raw)
            .map_err(|_| ApiError::Validation("That isn't a transaction.".into()))?;
        txs.push(tx);
    }
    let old = Vault::from_config(VaultConfig {
        descriptor_external: old_ext.clone(),
        descriptor_internal: old_int.clone(),
        timelock_blocks: timelock as u32,
        network,
        role: VaultRole::Watchonly,
        label: None,
    })
    .map_err(|e| ApiError::Validation(format!("stored vault descriptors invalid: {e}")))?;
    let new = Vault::from_config(VaultConfig {
        descriptor_external: target.pair.external.clone(),
        descriptor_internal: target.pair.internal.clone(),
        timelock_blocks: timelock as u32,
        network,
        role: VaultRole::Watchonly,
        label: None,
    })
    .map_err(|e| ApiError::Validation(format!("new vault descriptors invalid: {e}")))?;
    let urls = esplora_urls(network)?;
    let _permit = crate::concurrency::acquire_esplora().await;
    let outcome = tokio::task::spawn_blocking(move || -> Result<UpgradeOutcome, BlockingErr> {
        let mut wallet = ghostkey_core::wallet::build_watch_only(&old)
            .map_err(|e| BlockingErr::Vault(e.to_string()))?;
        let update = try_each_esplora(&urls, |client| {
            client
                .full_scan(wallet.start_full_scan(), 5, 1)
                .map_err(|e| clean_esplora_err("full_scan", &e))
        })?;
        wallet
            .apply_update(update)
            .map_err(|e| BlockingErr::Esplora(format!("apply_update: {e}")))?;
        let coins: Vec<_> = wallet.list_unspent().collect();
        if coins.iter().any(|u| {
            !matches!(
                u.chain_position,
                bdk_wallet::chain::ChainPosition::Confirmed { .. }
            )
        }) {
            return Err(BlockingErr::Build(
                "A deposit is still confirming. Wait about 10 minutes, then upgrade.".into(),
            ));
        }
        // The new format's scripts, far enough ahead for one per deposit.
        let new_wallet = ghostkey_core::wallet::build_watch_only(&new)
            .map_err(|e| BlockingErr::Vault(e.to_string()))?;
        let reach = (txs.len() as u32) + 25;
        let mut new_spks = std::collections::HashSet::new();
        for keychain in [
            bdk_wallet::KeychainKind::External,
            bdk_wallet::KeychainKind::Internal,
        ] {
            for i in 0..reach {
                new_spks.insert(new_wallet.peek_address(keychain, i).address.script_pubkey());
            }
        }
        let utxos: std::collections::HashMap<bitcoin::OutPoint, u64> = coins
            .iter()
            .map(|u| (u.outpoint, u.txout.value.to_sat()))
            .collect();
        let summaries =
            plan_upgrade(&txs, &utxos, |spk| new_spks.contains(spk)).map_err(BlockingErr::Build)?;
        let mut sent = Vec::with_capacity(txs.len());
        let mut first_error = None;
        for tx in &txs {
            let txid = tx.compute_txid();
            let r = try_each_esplora(&urls, |client| match client.broadcast(tx) {
                Ok(()) => Ok(()),
                Err(_) if network_has(client, &txid) => Ok(()),
                Err(e) => Err(clean_esplora_err("broadcast", &e)),
            });
            if let Err(e) = &r {
                first_error.get_or_insert_with(|| e.to_string());
            }
            sent.push(r.is_ok());
        }
        Ok(UpgradeOutcome {
            summaries,
            txs: txs
                .iter()
                .map(|t| {
                    (
                        t.compute_txid(),
                        bitcoin::consensus::encode::serialize_hex(t),
                    )
                })
                .collect(),
            sent,
            first_error,
        })
    })
    .await
    .map_err(|e| ApiError::Validation(format!("worker panic: {e}")))??;

    let moved = outcome.sent.iter().filter(|s| **s).count();
    if moved == 0 && !outcome.txs.is_empty() {
        // Nothing reached the network: nothing changed.
        return Err(ApiError::Validation(format!(
            "Couldn't send the upgrade to the Bitcoin network. Nothing moved. {}",
            outcome.first_error.unwrap_or_default()
        )));
    }
    let fee_sat: u64 = outcome.summaries.iter().map(|s| s.fee_sat).sum();
    let now = Utc::now().to_rfc3339();

    // The switch, and the record of every transaction (sent or still to
    // send), together.
    let mut db = state.db.begin().await?;
    let switched = sqlx::query(
        "UPDATE vaults SET descriptor_external = ?, descriptor_internal = ?, \
                legacy_descriptor_external = ?, legacy_descriptor_internal = ?, \
                upgraded_at = ?, chain_scanned_at = NULL \
          WHERE id = ? AND descriptor_external = ?",
    )
    .bind(&target.pair.external)
    .bind(&target.pair.internal)
    .bind(&old_ext)
    .bind(&old_int)
    .bind(&now)
    .bind(&id)
    .bind(&old_ext)
    .execute(&mut *db)
    .await?;
    if switched.rows_affected() != 1 {
        return Err(ApiError::Conflict(
            "This vault changed while upgrading. Refresh and look again.".into(),
        ));
    }
    for ((txid, hex_tx), sent) in outcome.txs.iter().zip(&outcome.sent) {
        sqlx::query(
            "INSERT OR REPLACE INTO vault_upgrade_txs (vault_id, txid, tx_hex, created_at, broadcast_at, attempts) \
             VALUES (?, ?, ?, ?, ?, 1)",
        )
        .bind(&id)
        .bind(txid.to_string())
        .bind(hex_tx)
        .bind(&now)
        .bind(sent.then_some(&now))
        .execute(&mut *db)
        .await?;
    }
    db.commit().await?;

    // The event first, so a scan in between reads the vanished coins as
    // the owner's own move (record_spent_deposits).
    crate::routes::record_event(
        &state.db,
        &id,
        "vault_upgraded",
        Some(serde_json::json!({
            "coins": outcome.summaries.iter().map(|s| s.spent.len()).sum::<usize>(),
            "transactions": outcome.txs.len(),
            "pending": outcome.txs.len() - moved,
            "fee_sats": fee_sat,
        })),
    )
    .await?;
    for summary in &outcome.summaries {
        if let Err(e) = carry_deposits_over(&state.db, &id, summary).await {
            tracing::warn!(vault_id = %id, error = ?e, "could not carry deposits over an upgrade");
        }
    }
    Ok((
        StatusCode::OK,
        Json(UpgradeResultView {
            moved,
            pending: outcome.txs.len() - moved,
            fee_sat,
        }),
    ))
}

/// Retry upgrade transactions that didn't reach the network. They are
/// fully signed, so this needs nothing from the owner. Called from the
/// scheduler; best effort, one pass.
pub(crate) async fn rebroadcast_upgrade_txs(db: &sqlx::SqlitePool) -> anyhow::Result<()> {
    type Row = (String, String, String, String);
    let rows: Vec<Row> = sqlx::query_as(
        "SELECT u.vault_id, u.txid, u.tx_hex, v.network \
           FROM vault_upgrade_txs u JOIN vaults v ON v.id = u.vault_id \
          WHERE u.broadcast_at IS NULL AND u.attempts < 200",
    )
    .fetch_all(db)
    .await?;
    for (vault_id, txid_s, hex_tx, net) in rows {
        let Ok(network) = crate::config::parse_network(&net) else {
            continue;
        };
        let Ok(urls) = esplora_urls(network) else {
            continue;
        };
        let tx: bitcoin::Transaction = match bitcoin::consensus::encode::deserialize_hex(&hex_tx) {
            Ok(t) => t,
            Err(_) => continue,
        };
        let _permit = crate::concurrency::acquire_esplora().await;
        let result = tokio::task::spawn_blocking(move || {
            let txid = tx.compute_txid();
            try_each_esplora(&urls, |client| match client.broadcast(&tx) {
                Ok(()) => Ok(()),
                Err(_) if network_has(client, &txid) => Ok(()),
                Err(e) => Err(clean_esplora_err("broadcast", &e)),
            })
        })
        .await;
        let now = Utc::now().to_rfc3339();
        match result {
            Ok(Ok(())) => {
                sqlx::query(
                    "UPDATE vault_upgrade_txs SET broadcast_at = ?, attempts = attempts + 1, last_error = NULL \
                      WHERE vault_id = ? AND txid = ?",
                )
                .bind(&now)
                .bind(&vault_id)
                .bind(&txid_s)
                .execute(db)
                .await?;
                sqlx::query("UPDATE vaults SET chain_scanned_at = NULL WHERE id = ?")
                    .bind(&vault_id)
                    .execute(db)
                    .await?;
                tracing::info!(vault_id = %vault_id, txid = %txid_s, "upgrade transaction sent on retry");
            }
            Ok(Err(e)) => {
                sqlx::query(
                    "UPDATE vault_upgrade_txs SET attempts = attempts + 1, last_error = ? \
                      WHERE vault_id = ? AND txid = ?",
                )
                .bind(e.to_string())
                .bind(&vault_id)
                .bind(&txid_s)
                .execute(db)
                .await?;
                tracing::warn!(vault_id = %vault_id, txid = %txid_s, error = %e, "upgrade transaction still not sent");
            }
            Err(e) => tracing::warn!(error = %e, "upgrade rebroadcast worker failed"),
        }
    }
    Ok(())
}

/* -------------------------------------------------------------------------- *
 *  Heir claims signed in the browser (#390)                                  *
 *                                                                            *
 *  Same shape as the owner's browser-signed send: the claim page gets the    *
 *  vault's history, signs the claim itself with the heir key it unlocked     *
 *  from the link (ghostkey-core in wasm), and posts only the finished       *
 *  transaction. Every claim-link guard (valid, unused, past the challenge   *
 *  window) still applies, and the link is consumed atomically before the    *
 *  broadcast and released if it fails.                                      *
 * -------------------------------------------------------------------------- */

fn vault_from_claim_row(row: &VaultForClaim) -> Result<Vault, ApiError> {
    Vault::from_config(VaultConfig {
        descriptor_external: row.descriptor_external.clone(),
        descriptor_internal: row.descriptor_internal.clone(),
        timelock_blocks: row.timelock_blocks as u32,
        network: row.network,
        role: VaultRole::Watchonly,
        label: row.label.clone(),
    })
    .map_err(|e| ApiError::Validation(format!("stored vault: {e}")))
}

/// `GET /claim/:token/coins`: what the heir's browser needs to sign the
/// claim itself. Holds no keys.
pub async fn claim_coins(
    State(state): State<Arc<AppState>>,
    Path(token): Path<String>,
) -> Result<Json<SpendCoinsView>, ApiError> {
    let row = load_vault_for_claim_token(&state, &token).await?;
    let vault = vault_from_claim_row(&row)?;
    let network = row.network;
    let urls = esplora_urls(network)?;
    let _permit = crate::concurrency::acquire_esplora().await;
    let mut view = tokio::task::spawn_blocking(move || scan_spend_coins(&vault, network, &urls))
        .await
        .map_err(|e| ApiError::Validation(format!("worker panic: {e}")))??;
    view.refresh_address = None;
    Ok(Json(view))
}

#[derive(Debug, Deserialize)]
pub struct SignedClaimRequest {
    pub tx_hex: String,
    pub destination: String,
}

/// `POST /claim/:token/claim-signed`: broadcast a claim the heir's
/// browser signed. It must spend only this vault's coins and pay only the
/// heir's address. The server never sees the heir's key.
pub async fn heir_claim_signed(
    State(state): State<Arc<AppState>>,
    Path(token): Path<String>,
    Json(req): Json<SignedClaimRequest>,
) -> Result<(StatusCode, Json<BroadcastClaimResponse>), ApiError> {
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
    let dest_spk = dest.script_pubkey();
    let raw = hex::decode(req.tx_hex.trim())
        .map_err(|_| ApiError::Validation("That isn't a transaction.".into()))?;
    if raw.len() > 100_000 {
        return Err(ApiError::Validation("That transaction is too big.".into()));
    }
    let tx: bitcoin::Transaction = bitcoin::consensus::deserialize(&raw)
        .map_err(|_| ApiError::Validation("That isn't a transaction.".into()))?;
    let vault = vault_from_claim_row(&row)?;
    let urls = esplora_urls(row.network)?;
    let network = row.network;

    // Consume the link atomically before anything touches the network;
    // released below if the broadcast fails, so the heir can retry.
    let claimed = sqlx::query(
        r#"UPDATE vaults
              SET status              = 'claiming',
                  claim_token_used_at = ?
            WHERE id = ?
              AND claim_token_used_at IS NULL"#,
    )
    .bind(Utc::now().to_rfc3339())
    .bind(&row.id)
    .execute(&state.db)
    .await?;
    if claimed.rows_affected() != 1 {
        return Err(ApiError::Conflict("claim token already used".into()));
    }

    let vault_id = row.id.clone();
    let _permit = crate::concurrency::acquire_esplora().await;
    let result = tokio::task::spawn_blocking(
        move || -> Result<(bitcoin::Txid, SignedSendSummary), BlockingErr> {
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
            // A claim takes everything: nothing comes back to the vault.
            let summary = summarize_signed_send(
                &tx,
                &dest_spk,
                |op| wallet.get_utxo(*op).map(|u| u.txout.value.to_sat()),
                |_| false,
            )
            .map_err(BlockingErr::Build)?;
            try_each_esplora(&urls, |client| {
                client
                    .broadcast(&tx)
                    .map_err(|e| clean_esplora_err("broadcast", &e))
            })?;
            Ok((tx.compute_txid(), summary))
        },
    )
    .await;
    let (txid, summary) = match result {
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
            "total_input_sats": summary.total_in,
            "fee_sats": summary.fee_sat,
            "flow": "heir-claim-browser-signed",
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
 *  Lightning deposits: the two things the browser asks our server            *
 *                                                                            *
 *  A Lightning deposit is a swap the owner's browser runs with an            *
 *  independent provider (ghostkey-web/src/lightning/reverseSwap.ts). Our     *
 *  server holds no keys and never sees the money. The browser asks it two    *
 *  things, so it doesn't have to take the provider's word for them:          *
 *                                                                            *
 *  - has the provider's lockup transaction really confirmed?                 *
 *  - please also broadcast our claim (in case the provider won't), which     *
 *    we only do for a transaction whose every output pays this vault.        *
 * -------------------------------------------------------------------------- */

/// Largest claim transaction we'll relay: a swap claim is ~200 bytes.
const MAX_RELAY_TX_BYTES: usize = 10_000;

#[derive(Debug, Serialize)]
pub struct TxConfirmedView {
    pub confirmed: bool,
}

async fn load_vault_watch(state: &AppState, id: &str) -> Result<(Vault, Network), ApiError> {
    type Row = (String, String, String, i64);
    let row: Option<Row> = sqlx::query_as(
        "SELECT network, descriptor_external, descriptor_internal, timelock_blocks \
           FROM vaults WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(&state.db)
    .await?;
    let (network_s, ext, int_, timelock) = row.ok_or(ApiError::NotFound)?;
    let network = crate::config::parse_network(&network_s)
        .map_err(|name| ApiError::Validation(format!("unknown network {name}")))?;
    let vault = Vault::from_config(VaultConfig {
        descriptor_external: ext,
        descriptor_internal: int_,
        timelock_blocks: timelock as u32,
        network,
        role: VaultRole::Watchonly,
        label: None,
    })
    .map_err(|e| ApiError::Validation(format!("stored vault descriptors invalid: {e}")))?;
    Ok((vault, network))
}

/// `GET /vaults/:id/tx/:txid/confirmed` (public): whether a transaction
/// has at least one confirmation, on this vault's network.
pub async fn tx_confirmed(
    State(state): State<Arc<AppState>>,
    Path((id, txid)): Path<(String, String)>,
) -> Result<Json<TxConfirmedView>, ApiError> {
    let txid = bitcoin::Txid::from_str(txid.trim())
        .map_err(|_| ApiError::Validation("That isn't a transaction id.".into()))?;
    let (_, network) = load_vault_watch(&state, &id).await?;
    let urls = esplora_urls(network)?;
    let _permit = crate::concurrency::acquire_esplora().await;
    let status = tokio::task::spawn_blocking(move || {
        try_each_esplora(&urls, |client| {
            client
                .get_tx_status(&txid)
                .map_err(|e| clean_esplora_err("tx status", &e))
        })
    })
    .await
    .map_err(|e| ApiError::Validation(format!("worker panic: {e}")))??;
    Ok(Json(TxConfirmedView {
        confirmed: status.confirmed,
    }))
}

/// Whether every output of `tx` pays this vault (and there is at least
/// one). Only such transactions are relayed: our server is not a general
/// broadcast service.
pub(crate) fn pays_only_vault(vault: &Vault, tx: &bitcoin::Transaction) -> Result<bool, ApiError> {
    let wallet = ghostkey_core::wallet::build_watch_only(vault)
        .map_err(|e| ApiError::Validation(format!("vault: {e}")))?;
    Ok(!tx.output.is_empty()
        && tx
            .output
            .iter()
            .all(|o| wallet.is_mine(o.script_pubkey.clone())))
}

#[derive(Debug, Deserialize)]
pub struct RelayRequest {
    pub hex: String,
}

#[derive(Debug, Serialize)]
pub struct RelayResponse {
    pub txid: String,
}

/// `POST /vaults/:id/lightning/broadcast` (public): broadcast a
/// transaction that pays only this vault, e.g. a Lightning deposit's
/// claim. Holds no keys; the transaction is already signed.
pub async fn relay_vault_deposit(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(req): Json<RelayRequest>,
) -> Result<Json<RelayResponse>, ApiError> {
    let raw = hex::decode(req.hex.trim())
        .map_err(|_| ApiError::Validation("That isn't a transaction.".into()))?;
    if raw.len() > MAX_RELAY_TX_BYTES {
        return Err(ApiError::Validation("That transaction is too big.".into()));
    }
    let tx: bitcoin::Transaction = bitcoin::consensus::deserialize(&raw)
        .map_err(|_| ApiError::Validation("That isn't a transaction.".into()))?;
    let (vault, network) = load_vault_watch(&state, &id).await?;
    if !pays_only_vault(&vault, &tx)? {
        return Err(ApiError::Validation(
            "We only send transactions that pay into this vault.".into(),
        ));
    }
    let urls = esplora_urls(network)?;
    let _permit = crate::concurrency::acquire_esplora().await;
    let txid = tx.compute_txid();
    tokio::task::spawn_blocking(move || {
        try_each_esplora(&urls, |client| {
            client
                .broadcast(&tx)
                .map_err(|e| clean_esplora_err("broadcast", &e))
        })
    })
    .await
    .map_err(|e| ApiError::Validation(format!("worker panic: {e}")))??;
    Ok(Json(RelayResponse {
        txid: txid.to_string(),
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
            esplora_urls(Network::Bitcoin).unwrap().urls,
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

    fn estimate_input(scanned_secs_ago: Option<i64>, tip: Option<i64>) -> EstimateInput {
        EstimateInput {
            vault_id: "v".into(),
            descriptor_external: "tr(x)".into(),
            descriptor_internal: "tr(y)".into(),
            network: "bitcoin".into(),
            timelock_blocks: 144,
            cached_unlock_height: Some(1_000),
            cached_tip_height: tip,
            cached_scanned_at: scanned_secs_ago
                .map(|s| (Utc::now() - chrono::Duration::seconds(s)).to_rfc3339()),
            cached_has_unspent: Some(1),
        }
    }

    #[test]
    fn the_scheduler_reads_the_cache_and_never_the_network() {
        let now = Utc::now();
        // Fresh and complete: answered from the cache.
        let est = cached_unlock_estimate(&estimate_input(Some(60), Some(900)), now).unwrap();
        assert_eq!((est.tip_height, est.unlock_height), (900, Some(1_000)));
        // Stale, never scanned, or scanned without a tip: the vault waits
        // for the background refresher instead of calling an explorer.
        for input in [
            estimate_input(Some(MATURITY_CACHE_TTL_SECS + 5), Some(900)),
            estimate_input(None, None),
            estimate_input(Some(60), None),
        ] {
            assert!(matches!(
                cached_unlock_estimate(&input, now),
                Err(BlockingErr::NotScannedYet)
            ));
        }
    }

    #[test]
    fn a_testnet_explorer_pause_never_pauses_mainnet() {
        // Regression: one 429 from a public testnet explorer (scanning a
        // test vault on the mainnet server) paused every mainnet scan,
        // which stopped heir contact for real vaults.
        let now = Utc::now();
        let err: Result<(), BlockingErr> = Err(BlockingErr::Esplora("HTTP 429".into()));
        backoff_record(Network::Testnet, &err, now);
        assert!(backoff_remaining(Network::Testnet, now).is_some());
        assert_eq!(
            backoff_remaining(Network::Bitcoin, now),
            None,
            "mainnet must not inherit testnet's pause"
        );
        // A testnet success lifts only testnet's pause.
        backoff_record::<()>(Network::Testnet, &Ok(()), now);
        assert_eq!(backoff_remaining(Network::Testnet, now), None);
    }

    #[test]
    fn explorer_backoff_starts_open() {
        let b = ExplorerBackoff::default();
        assert_eq!(b.remaining_secs(Utc::now()), None);
    }

    #[test]
    fn explorer_backoff_doubles_and_caps_at_one_cache_lifetime() {
        let now = Utc::now();
        let mut b = ExplorerBackoff::default();
        let mut pauses = Vec::new();
        for _ in 0..8 {
            b.record_failure(now);
            pauses.push(b.remaining_secs(now).expect("paused after a failure"));
        }
        assert_eq!(pauses, vec![60, 120, 240, 480, 600, 600, 600, 600]);
    }

    #[test]
    fn explorer_backoff_lifts_when_the_pause_runs_out() {
        let now = Utc::now();
        let mut b = ExplorerBackoff::default();
        b.record_failure(now);
        assert_eq!(
            b.remaining_secs(now + chrono::Duration::seconds(59)),
            Some(1)
        );
        assert_eq!(b.remaining_secs(now + chrono::Duration::seconds(60)), None);
        // The streak outlives the pause: failing again straight after it
        // lifts waits longer, not back at the start.
        let later = now + chrono::Duration::seconds(60);
        b.record_failure(later);
        assert_eq!(b.remaining_secs(later), Some(120));
    }

    #[test]
    fn only_explorer_errors_pause_scans() {
        assert!(trips_backoff(&BlockingErr::Esplora("HTTP 429".into())));
        assert!(!trips_backoff(&BlockingErr::Vault(
            "scan worker panic".into()
        )));
        assert!(!trips_backoff(&BlockingErr::Build("fee".into())));
        assert!(!trips_backoff(&BlockingErr::NoUtxos));
        // Our own skip must not extend the pause it came from.
        assert!(!trips_backoff(&BlockingErr::BackingOff(60)));
    }

    #[test]
    fn explorer_backoff_resets_on_a_real_scan() {
        let now = Utc::now();
        let mut b = ExplorerBackoff::default();
        b.record_failure(now);
        b.record_failure(now);
        b.record_success();
        assert_eq!(b.remaining_secs(now), None);
        b.record_failure(now);
        assert_eq!(b.remaining_secs(now), Some(60), "streak starts over");
    }

    #[test]
    fn try_each_esplora_fails_over_only_on_esplora_errors() {
        let urls = Explorers {
            urls: vec![
                "http://127.0.0.1:1/api".to_string(),
                "http://127.0.0.1:2/api".to_string(),
            ],
            network: Network::Regtest,
        };
        // These endpoints don't exist; mark them as already on the right
        // chain so the genesis check doesn't stop the test before `op`.
        for u in &urls.urls {
            verified_explorers()
                .lock()
                .unwrap()
                .insert((u.clone(), Network::Regtest));
        }

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

    /// Answer every request with `status` and `body`, counting hits.
    fn counting_explorer(
        status: &'static str,
        body: &'static str,
    ) -> (String, Arc<std::sync::atomic::AtomicUsize>) {
        use std::io::{Read, Write};
        let hits = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let seen = hits.clone();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            for mut stream in listener.incoming().flatten() {
                let mut buf = [0u8; 1024];
                let _ = stream.read(&mut buf);
                seen.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let _ = write!(
                    stream,
                    "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
            }
        });
        (format!("http://{addr}"), hits)
    }

    #[test]
    fn a_rate_limited_explorer_hands_over_at_once_and_goes_to_the_back() {
        // Regression: blockstream answered every request with 429, and the
        // client's built-in retries (6, with doubling sleeps) spent ~20s
        // on it before trying the next explorer. Home gives up at 20s, so
        // the owner never saw a balance though the next explorer was fine.
        use std::sync::atomic::Ordering;
        let (limited, limited_hits) = counting_explorer("429 Too Many Requests", "slow down");
        let (healthy, healthy_hits) = counting_explorer("200 OK", "900000");
        let explorers = Explorers {
            urls: vec![limited.clone(), healthy.clone()],
            network: Network::Regtest,
        };
        for u in &explorers.urls {
            verified_explorers()
                .lock()
                .unwrap()
                .insert((u.clone(), Network::Regtest));
        }
        let height = |c: &esplora_client::BlockingClient| {
            c.get_height()
                .map_err(|e| clean_esplora_err("get_height", &e))
        };

        let started = std::time::Instant::now();
        assert_eq!(try_each_esplora(&explorers, height).unwrap(), 900_000);
        assert_eq!(
            limited_hits.load(Ordering::SeqCst),
            1,
            "a 429 must hand over, not retry, while another explorer is left"
        );
        assert!(
            started.elapsed() < std::time::Duration::from_secs(3),
            "took {:?}",
            started.elapsed()
        );

        // Straight after, the explorer that just turned us away is asked
        // last, so the next request doesn't pay for it again.
        assert_eq!(try_each_esplora(&explorers, height).unwrap(), 900_000);
        assert_eq!(limited_hits.load(Ordering::SeqCst), 1);
        assert_eq!(healthy_hits.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn a_cooling_explorer_is_still_tried_when_it_is_the_only_hope() {
        // Moving a failed explorer to the back never drops it: if every
        // other one fails too, it is still asked.
        let explorers = Explorers {
            urls: vec![
                "http://127.0.0.1:3/api".to_string(),
                "http://127.0.0.1:4/api".to_string(),
            ],
            network: Network::Regtest,
        };
        let mut asked = Vec::new();
        let _: Result<(), _> = try_each_esplora(&explorers, |c| {
            asked.push(c.url().to_string());
            Err(BlockingErr::Esplora("down".into()))
        });
        let mut asked_again = Vec::new();
        let _: Result<(), _> = try_each_esplora(&explorers, |c| {
            asked_again.push(c.url().to_string());
            Err(BlockingErr::Esplora("down".into()))
        });
        assert_eq!(asked.len(), 2);
        assert_eq!(asked_again.len(), 2, "both still tried: {asked_again:?}");
    }

    #[test]
    fn a_genesis_check_with_no_answer_does_not_block_the_scan() {
        // Regression: blockstream answered block-height/0 slower than our
        // timeout, and the strict check stopped every mainnet scan.
        let url = "http://127.0.0.1:1/api";
        let client = esplora_client::Builder::new(url)
            .timeout(2)
            .build_blocking();
        assert!(explorer_on_network(&client, url, Network::Bitcoin).is_ok());
        // ...and it is not cached as verified, so a later answer still counts.
        assert!(!verified_explorers()
            .lock()
            .unwrap()
            .contains(&(url.to_string(), Network::Bitcoin)));
    }

    #[test]
    fn the_configured_explorer_only_serves_its_own_network() {
        let env = Some("https://mainnet.indexer/api");
        // Mainnet server: the indexer serves mainnet vaults...
        assert_eq!(
            esplora_urls_for(Network::Bitcoin, env, Some(Network::Bitcoin))
                .unwrap()
                .urls,
            vec!["https://mainnet.indexer/api".to_string()]
        );
        // ...but a testnet vault on it gets the public testnet explorers,
        // never the mainnet indexer (the bug: bdk panicked on the genesis
        // mismatch every tick).
        let t = esplora_urls_for(Network::Testnet, env, Some(Network::Bitcoin)).unwrap();
        assert_eq!(t.network, Network::Testnet);
        assert!(t.urls.iter().all(|u| u.contains("testnet")), "{:?}", t.urls);
        // A signet server (Mutinynet) still uses its indexer for signet.
        let m = Some("https://mutinynet.com/api");
        assert_eq!(
            esplora_urls_for(Network::Signet, m, Some(Network::Signet))
                .unwrap()
                .urls,
            vec!["https://mutinynet.com/api".to_string()]
        );
        // Mainnet with no indexer still refuses rather than leak to a
        // public one.
        assert!(esplora_urls_for(Network::Bitcoin, None, Some(Network::Testnet)).is_err());
    }

    /// Serve one fixed genesis hash at `/block-height/0`, the endpoint
    /// `get_block_hash(0)` calls, and return the base URL.
    fn fake_explorer(genesis: bitcoin::BlockHash) -> String {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let mut stream = stream;
                let mut buf = [0u8; 1024];
                let _ = stream.read(&mut buf);
                let body = genesis.to_string();
                let _ = write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
            }
        });
        format!("http://{addr}")
    }

    #[test]
    fn an_explorer_on_another_chain_is_refused_not_panicked_on() {
        let testnet_genesis = bitcoin::constants::genesis_block(Network::Testnet).block_hash();
        let url = fake_explorer(testnet_genesis);
        let client = esplora_client::Builder::new(&url)
            .timeout(5)
            .build_blocking();

        // Asked to serve mainnet, a testnet explorer is a clean, failover-
        // able Esplora error, not a bdk panic.
        match explorer_on_network(&client, &url, Network::Bitcoin) {
            Err(BlockingErr::Esplora(msg)) => assert!(msg.contains("different chain"), "{msg}"),
            other => panic!("expected an Esplora error, got {other:?}"),
        }
        // The same explorer is fine for testnet, and the scan runs.
        assert!(explorer_on_network(&client, &url, Network::Testnet).is_ok());
        let explorers = Explorers {
            urls: vec![url.clone()],
            network: Network::Bitcoin,
        };
        let mut ran = false;
        let r: Result<(), _> = try_each_esplora(&explorers, |_c| {
            ran = true;
            Ok(())
        });
        assert!(
            r.is_err() && !ran,
            "a wrong-chain explorer must never reach the scan"
        );
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
        assert!(msg.contains("busy right now"), "should be friendly: {msg}");
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

    fn real_vault(seed: u8) -> Vault {
        use bitcoin::bip32::Xpriv;
        use ghostkey_core::keys::{account_xpub, descriptor_key_fragment, Chain};
        let net = Network::Signet;
        let o = Xpriv::new_master(net, &[seed; 32]).unwrap();
        let h = Xpriv::new_master(net, &[seed.wrapping_add(1); 32]).unwrap();
        let (ofp, op, ox) = account_xpub(&o, net).unwrap();
        let (hfp, hp, hx) = account_xpub(&h, net).unwrap();
        Vault::new(
            &descriptor_key_fragment(ofp, &op, &ox, Chain::External),
            &descriptor_key_fragment(ofp, &op, &ox, Chain::Internal),
            &descriptor_key_fragment(hfp, &hp, &hx, Chain::External),
            &descriptor_key_fragment(hfp, &hp, &hx, Chain::Internal),
            144,
            net,
            VaultRole::Watchonly,
            None,
        )
        .unwrap()
    }

    fn paying(addrs: &[&str]) -> bitcoin::Transaction {
        bitcoin::Transaction {
            version: bitcoin::transaction::Version::TWO,
            lock_time: bitcoin::absolute::LockTime::ZERO,
            input: vec![],
            output: addrs
                .iter()
                .map(|a| bitcoin::TxOut {
                    value: bitcoin::Amount::from_sat(5_000),
                    script_pubkey: Address::from_str(a)
                        .unwrap()
                        .assume_checked()
                        .script_pubkey(),
                })
                .collect(),
        }
    }

    #[test]
    fn a_browser_signed_send_is_checked_against_the_vault() {
        use bitcoin::hashes::Hash;
        use bitcoin::{Amount, OutPoint, ScriptBuf, TxIn, TxOut, Txid};
        let dest = ScriptBuf::from_bytes(vec![0x51, 0x20, 1, 2, 3]);
        let change = ScriptBuf::from_bytes(vec![0x51, 0x20, 9, 9, 9]);
        let stranger = ScriptBuf::from_bytes(vec![0x51, 0x20, 7, 7, 7]);
        let coin = OutPoint::new(Txid::from_byte_array([1; 32]), 0);
        let spent = OutPoint::new(Txid::from_byte_array([2; 32]), 0);
        let tx = |outs: Vec<(ScriptBuf, u64)>, ins: Vec<OutPoint>| bitcoin::Transaction {
            version: bitcoin::transaction::Version::TWO,
            lock_time: bitcoin::absolute::LockTime::ZERO,
            input: ins
                .into_iter()
                .map(|previous_output| TxIn {
                    previous_output,
                    ..Default::default()
                })
                .collect(),
            output: outs
                .into_iter()
                .map(|(script_pubkey, v)| TxOut {
                    value: Amount::from_sat(v),
                    script_pubkey,
                })
                .collect(),
        };
        // The vault's only unspent coin is `coin`, worth 100,000.
        let prevout = |op: &OutPoint| (*op == coin).then_some(100_000);
        let is_vault = |spk: &ScriptBuf| *spk == change;

        let ok = summarize_signed_send(
            &tx(
                vec![(dest.clone(), 30_000), (change.clone(), 69_500)],
                vec![coin],
            ),
            &dest,
            prevout,
            is_vault,
        )
        .unwrap();
        assert_eq!(
            ok,
            SignedSendSummary {
                total_in: 100_000,
                sent_sat: 30_000,
                fee_sat: 500,
                remaining_sat: 69_500
            }
        );

        for (bad, why) in [
            (
                tx(vec![(dest.clone(), 10_000)], vec![spent]),
                "aren't in this vault",
            ),
            (
                tx(
                    vec![(dest.clone(), 10_000), (stranger.clone(), 80_000)],
                    vec![coin],
                ),
                "someone other than",
            ),
            (
                tx(vec![(change.clone(), 99_000)], vec![coin]),
                "doesn't pay the address",
            ),
            (
                tx(vec![(dest.clone(), 200_000)], vec![coin]),
                "more than it spends",
            ),
            (tx(vec![(dest.clone(), 1)], vec![]), "spends nothing"),
        ] {
            let err = summarize_signed_send(&bad, &dest, prevout, is_vault).unwrap_err();
            assert!(err.contains(why), "{err}");
        }
    }

    fn refresh_tx(
        outs: Vec<(bitcoin::ScriptBuf, u64)>,
        ins: Vec<bitcoin::OutPoint>,
    ) -> bitcoin::Transaction {
        use bitcoin::{Amount, TxIn, TxOut};
        bitcoin::Transaction {
            version: bitcoin::transaction::Version::TWO,
            lock_time: bitcoin::absolute::LockTime::ZERO,
            input: ins
                .into_iter()
                .map(|previous_output| TxIn {
                    previous_output,
                    ..Default::default()
                })
                .collect(),
            output: outs
                .into_iter()
                .map(|(script_pubkey, v)| TxOut {
                    value: Amount::from_sat(v),
                    script_pubkey,
                })
                .collect(),
        }
    }

    #[test]
    fn a_refresh_must_stay_in_the_vault_with_a_sane_fee() {
        use bitcoin::hashes::Hash;
        use bitcoin::{OutPoint, ScriptBuf, Txid};
        let vault = ScriptBuf::from_bytes(vec![0x51, 0x20, 9, 9, 9]);
        let stranger = ScriptBuf::from_bytes(vec![0x51, 0x20, 7, 7, 7]);
        let a = OutPoint::new(Txid::from_byte_array([1; 32]), 0);
        let b = OutPoint::new(Txid::from_byte_array([3; 32]), 1);
        let gone = OutPoint::new(Txid::from_byte_array([2; 32]), 0);
        let prevout = |op: &OutPoint| (*op == a || *op == b).then_some(50_000);
        let is_vault = |spk: &ScriptBuf| *spk == vault;

        let t = refresh_tx(vec![(vault.clone(), 99_700)], vec![a, b]);
        let ok = summarize_refresh(&t, prevout, is_vault).unwrap();
        assert_eq!(ok.spent, vec![a, b]);
        assert_eq!(ok.total_in, 100_000);
        assert_eq!(ok.fee_sat, 300);
        assert_eq!(ok.landed, OutPoint::new(t.compute_txid(), 0));

        for (bad, why) in [
            (
                refresh_tx(vec![(stranger.clone(), 49_000)], vec![a]),
                "pay back into this vault",
            ),
            (
                refresh_tx(
                    vec![(vault.clone(), 30_000), (stranger.clone(), 19_000)],
                    vec![a],
                ),
                "pay back into this vault",
            ),
            (
                refresh_tx(vec![(vault.clone(), 49_000)], vec![gone]),
                "aren't in this vault",
            ),
            (
                refresh_tx(vec![(vault.clone(), 20_000)], vec![a]),
                "more than half",
            ),
            (
                refresh_tx(vec![(vault.clone(), 60_000)], vec![a]),
                "more than it spends",
            ),
            (refresh_tx(vec![], vec![a]), "doesn't refresh anything"),
        ] {
            let err = summarize_refresh(&bad, prevout, is_vault).unwrap_err();
            assert!(err.contains(why), "{err}");
        }
    }

    #[tokio::test]
    async fn a_refresh_carries_the_deposits_over_less_the_fee() {
        use bitcoin::hashes::Hash;
        use bitcoin::{OutPoint, Txid};
        let pool = memory_db().await;
        seed_vault(&pool, "vault-r").await;
        let a = OutPoint::new(Txid::from_byte_array([1; 32]), 0);
        let b = OutPoint::new(Txid::from_byte_array([3; 32]), 1);
        let other = OutPoint::new(Txid::from_byte_array([4; 32]), 0);
        for (op, amt, seen) in [
            (a, 30_000, "2026-03-01T00:00:00+00:00"),
            (b, 20_000, "2026-01-01T00:00:00+00:00"),
            (other, 5_000, "2026-02-01T00:00:00+00:00"),
        ] {
            sqlx::query(
                "INSERT INTO vault_deposits (vault_id, outpoint, amount_sat, height, seen_at) \
                 VALUES ('vault-r', ?, ?, 100, ?)",
            )
            .bind(op.to_string())
            .bind(amt)
            .bind(seen)
            .execute(&pool)
            .await
            .unwrap();
        }
        let landed = OutPoint::new(Txid::from_byte_array([9; 32]), 0);
        let summary = RefreshSummary {
            spent: vec![a, b],
            landed,
            total_in: 50_000,
            fee_sat: 400,
        };
        carry_deposits_over(&pool, "vault-r", &summary)
            .await
            .unwrap();
        let rows: Vec<(String, i64, String, Option<String>)> = sqlx::query_as(
            "SELECT outpoint, amount_sat, seen_at, spent_at FROM vault_deposits \
              WHERE vault_id = 'vault-r' ORDER BY seen_at",
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        // One row for the refreshed pair, dated from the earlier deposit,
        // worth what they held less the fee; the untouched one as it was.
        assert_eq!(
            rows,
            vec![
                (
                    landed.to_string(),
                    49_600,
                    "2026-01-01T00:00:00+00:00".into(),
                    None
                ),
                (
                    other.to_string(),
                    5_000,
                    "2026-02-01T00:00:00+00:00".into(),
                    None
                ),
            ]
        );
    }

    #[test]
    fn a_locked_goal_is_ready_only_after_the_heir_date_and_a_margin() {
        let heir_after = 2_000_000_000u32;
        let at = |now: i64| locked_unlock_height(900_000, heir_after, now);
        // Long before: in the future, at about one block per ten minutes.
        assert_eq!(
            at(heir_after as i64 - 6_000),
            900_000 + (6_000 + LOCKED_MTP_MARGIN_SECS as u32) / 600
        );
        // At the date but inside the margin: still not ready.
        assert!(at(heir_after as i64) > 900_000);
        // Past the date and the margin: ready now (the tip itself).
        assert_eq!(at(heir_after as i64 + LOCKED_MTP_MARGIN_SECS + 1), 900_000);
    }

    #[test]
    fn the_suggested_fee_is_the_two_hour_estimate_within_bounds() {
        let m = |pairs: &[(u16, f64)]| Some(pairs.iter().copied().collect());
        // The 12-block estimate wins when there is one.
        assert_eq!(suggested_fee_rate(m(&[(12, 2.4), (6, 5.3), (3, 9.0)])), 3);
        assert_eq!(suggested_fee_rate(m(&[(6, 3.2), (3, 9.0)])), 4);
        // Never below 2 sat/vB, however quiet the network.
        assert_eq!(suggested_fee_rate(m(&[(12, 0.12)])), 2);
        assert_eq!(suggested_fee_rate(m(&[(6, 9000.0)])), 500);
        assert_eq!(suggested_fee_rate(None), 2);
    }

    #[test]
    fn a_send_that_spends_one_coin_leaves_the_others() {
        // Two coins, 5,000 + 1,000. A send spends the 5,000 coin with no
        // change: the 1,000 coin is still there.
        assert_eq!(left_after_send(6_000, 5_000, 0), 1_000);
        // Change comes back on top.
        assert_eq!(left_after_send(6_000, 5_000, 700), 1_700);
        // Spending everything leaves nothing.
        assert_eq!(left_after_send(6_000, 6_000, 0), 0);
    }

    #[test]
    fn only_a_transaction_paying_this_vault_is_relayed() {
        // A Lightning deposit's claim pays the vault's first address. Our
        // server relays that, and nothing that pays anyone else.
        let vault = real_vault(0x51);
        let other = real_vault(0x61);
        let (mine, _) = ghostkey_core::wallet::peek_addresses(&vault, 2).unwrap();
        let (theirs, _) = ghostkey_core::wallet::peek_addresses(&other, 1).unwrap();
        assert!(pays_only_vault(&vault, &paying(&[&mine[0]])).unwrap());
        assert!(pays_only_vault(&vault, &paying(&[&mine[0], &mine[1]])).unwrap());
        assert!(!pays_only_vault(&vault, &paying(&[&theirs[0]])).unwrap());
        assert!(
            !pays_only_vault(&vault, &paying(&[&mine[0], &theirs[0]])).unwrap(),
            "one foreign output is enough to refuse"
        );
        assert!(!pays_only_vault(&vault, &paying(&[])).unwrap());
    }

    #[tokio::test]
    async fn one_scan_records_the_balance_what_came_in_and_what_left() {
        // What the background refresher now does every few minutes, so a
        // deposit lands in the week it arrived, not the week the owner
        // next opened the app.
        let pool = memory_db().await;
        seed_vault(&pool, "vault-1").await;
        let t1 = Utc::now() - chrono::Duration::days(3);
        record_scan(
            &pool,
            "vault-1",
            ScanBalance {
                confirmed_sat: 150_000,
                unconfirmed_sat: 0,
            },
            &[
                deposit("aaaa:0", 100_000, 900_000),
                deposit("bbbb:0", 50_000, 900_010),
            ],
            &["aaaa:0".into(), "bbbb:0".into()],
            t1,
        )
        .await;
        let seen: Vec<(String, String)> = sqlx::query_as(
            "SELECT outpoint, seen_at FROM vault_deposits WHERE vault_id = 'vault-1' ORDER BY outpoint",
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        assert_eq!(
            seen,
            vec![
                ("aaaa:0".to_string(), t1.to_rfc3339()),
                ("bbbb:0".to_string(), t1.to_rfc3339())
            ]
        );
        assert_eq!(received_count(&pool, "vault-1").await, 2);

        // Later, one coin has left. The first deposit keeps its date.
        let t2 = Utc::now();
        record_scan(
            &pool,
            "vault-1",
            ScanBalance {
                confirmed_sat: 50_000,
                unconfirmed_sat: 0,
            },
            &[deposit("bbbb:0", 50_000, 900_010)],
            &["bbbb:0".into()],
            t2,
        )
        .await;
        let spent: Vec<(String, Option<String>)> = sqlx::query_as(
            "SELECT outpoint, spent_at FROM vault_deposits WHERE vault_id = 'vault-1' ORDER BY outpoint",
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        assert_eq!(
            spent,
            vec![
                ("aaaa:0".to_string(), Some(t2.to_rfc3339())),
                ("bbbb:0".to_string(), None)
            ]
        );
        assert_eq!(received_count(&pool, "vault-1").await, 2, "no repeat");
        let last = last_balance(&pool, "vault-1").await.unwrap().unwrap();
        assert_eq!((last.total_sat, last.checked_at), (50_000, t2.to_rfc3339()));
    }

    #[tokio::test]
    async fn the_last_balance_is_what_the_last_scan_saw() {
        let pool = memory_db().await;
        seed_vault(&pool, "vault-1").await;
        seed_vault(&pool, "vault-2").await;

        // Never scanned: nothing to show, rather than a misleading zero.
        assert_eq!(last_balance(&pool, "vault-1").await.unwrap(), None);
        assert_eq!(last_balance(&pool, "no-such-vault").await.unwrap(), None);

        let first = Utc::now() - chrono::Duration::minutes(10);
        save_last_balance(
            &pool,
            "vault-1",
            ScanBalance {
                confirmed_sat: 2_000,
                unconfirmed_sat: 629,
            },
            first,
        )
        .await;
        let got = last_balance(&pool, "vault-1").await.unwrap().unwrap();
        assert_eq!(
            got,
            LastBalanceView {
                vault_id: "vault-1".into(),
                network: "signet".into(),
                confirmed_sat: 2_000,
                unconfirmed_sat: 629,
                total_sat: 2_629,
                checked_at: first.to_rfc3339(),
            }
        );

        // A later scan replaces it, including a drop to zero.
        let later = Utc::now();
        save_last_balance(
            &pool,
            "vault-1",
            ScanBalance {
                confirmed_sat: 0,
                unconfirmed_sat: 0,
            },
            later,
        )
        .await;
        let got = last_balance(&pool, "vault-1").await.unwrap().unwrap();
        assert_eq!((got.total_sat, got.checked_at), (0, later.to_rfc3339()));

        // Other vaults are untouched.
        assert_eq!(last_balance(&pool, "vault-2").await.unwrap(), None);
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

    async fn spent_count(pool: &sqlx::SqlitePool, vault_id: &str) -> i64 {
        sqlx::query_scalar(
            "SELECT COUNT(*) FROM events WHERE vault_id = ? AND kind = 'funds_spent'",
        )
        .bind(vault_id)
        .fetch_one(pool)
        .await
        .expect("count funds_spent events")
    }

    #[test]
    fn an_upgrade_moves_every_deposit_into_the_new_format_and_nothing_else() {
        use bitcoin::hashes::Hash;
        use bitcoin::{OutPoint, ScriptBuf, Txid};
        let new = ScriptBuf::from_bytes(vec![0x51, 0x20, 8, 8, 8]);
        let old = ScriptBuf::from_bytes(vec![0x51, 0x20, 9, 9, 9]);
        let a = OutPoint::new(Txid::from_byte_array([1; 32]), 0);
        let b = OutPoint::new(Txid::from_byte_array([2; 32]), 0);
        let utxos: std::collections::HashMap<OutPoint, u64> =
            [(a, 50_000), (b, 30_000)].into_iter().collect();
        let is_new = |spk: &ScriptBuf| *spk == new;

        // One transaction per deposit: fine.
        let per_coin = [
            refresh_tx(vec![(new.clone(), 49_800)], vec![a]),
            refresh_tx(vec![(new.clone(), 29_800)], vec![b]),
        ];
        let plan = plan_upgrade(&per_coin, &utxos, is_new).unwrap();
        assert_eq!(plan.iter().map(|s| s.fee_sat).sum::<u64>(), 400);
        // An empty vault moves nothing and only changes format; a vault
        // with coins can't skip them.
        assert!(plan_upgrade(&[], &std::collections::HashMap::new(), is_new)
            .unwrap()
            .is_empty());
        assert!(plan_upgrade(&[], &utxos, is_new).is_err());

        for (txs, why) in [
            // A deposit left behind in the old format.
            (
                vec![refresh_tx(vec![(new.clone(), 49_800)], vec![a])],
                "Every deposit has to move",
            ),
            // The same deposit twice.
            (
                vec![
                    refresh_tx(vec![(new.clone(), 49_800)], vec![a]),
                    refresh_tx(vec![(new.clone(), 79_000)], vec![a, b]),
                ],
                "same deposit",
            ),
            // Back into the old format, not the new one.
            (
                vec![
                    refresh_tx(vec![(old.clone(), 49_800)], vec![a]),
                    refresh_tx(vec![(new.clone(), 29_800)], vec![b]),
                ],
                "pay the new vault",
            ),
        ] {
            let err = plan_upgrade(&txs, &utxos, is_new).expect_err(why);
            assert!(err.contains(why), "{err}");
        }
    }

    #[test]
    fn the_export_gives_liana_the_standard_format_and_core_every_format() {
        use bitcoin::bip32::Xpriv;
        use ghostkey_core::descriptor::{
            build_descriptor_pair, build_locked_descriptor_pair,
            build_standard_descriptor_from_fragments,
        };
        use ghostkey_core::keys::{account_xpub, descriptor_key_fragment, Chain};
        let net = Network::Regtest;
        let frag = |seed: u8, chain| {
            let m = Xpriv::new_master(net, &[seed; 32]).unwrap();
            let (fp, path, x) = account_xpub(&m, net).unwrap();
            descriptor_key_fragment(fp, &path, &x, chain)
        };
        let (oe, oi, he, hi) = (
            frag(1, Chain::External),
            frag(1, Chain::Internal),
            frag(2, Chain::External),
            frag(2, Chain::Internal),
        );
        let created = "2026-11-01T00:00:00+00:00";

        let std_ = build_standard_descriptor_from_fragments(&oe, &oi, &he, &hi, 4320).unwrap();
        let x = build_export(
            &std_.pair.external,
            &std_.pair.internal,
            "regtest".into(),
            created,
        )
        .unwrap();
        assert_eq!(x.format, "standard");
        assert_eq!(x.liana_descriptor.as_deref(), Some(std_.multipath.as_str()));
        let core: serde_json::Value = serde_json::from_str(&x.core_import).unwrap();
        assert_eq!(core[0]["desc"], x.descriptor_external.as_str());
        assert_eq!(core[1]["internal"], true);
        assert_eq!(core[0]["timestamp"], 1_793_491_200 - 86_400); // 2026-11-01, a day early
        assert!(x.descriptor_external.contains('#'));

        let legacy = build_descriptor_pair(&oe, &oi, &he, &hi, 4320).unwrap();
        let x = build_export(
            &legacy.external,
            &legacy.internal,
            "regtest".into(),
            created,
        )
        .unwrap();
        assert_eq!((x.format, x.liana_descriptor.is_none()), ("legacy", true));

        let locked =
            build_locked_descriptor_pair(&oe, &oi, &he, &hi, 1_800_000_000, 1_808_000_000).unwrap();
        let x = build_export(
            &locked.external,
            &locked.internal,
            "regtest".into(),
            created,
        )
        .unwrap();
        assert_eq!((x.format, x.liana_descriptor.is_none()), ("locked", true));
    }

    #[test]
    fn only_a_legacy_standard_vault_without_a_claim_can_upgrade() {
        use bitcoin::bip32::Xpriv;
        use ghostkey_core::keys::{account_xpub, descriptor_key_fragment, Chain};
        let net = Network::Regtest;
        let frag = |seed: u8, chain| {
            let m = Xpriv::new_master(net, &[seed; 32]).unwrap();
            let (fp, path, x) = account_xpub(&m, net).unwrap();
            descriptor_key_fragment(fp, &path, &x, chain)
        };
        let legacy = ghostkey_core::descriptor::build_descriptor_pair(
            &frag(1, Chain::External),
            &frag(1, Chain::Internal),
            &frag(2, Chain::External),
            &frag(2, Chain::Internal),
            4320,
        )
        .unwrap();
        let (e, i) = (&legacy.external, &legacy.internal);
        assert!(upgrade_target(e, i, "standard", "ok").is_some());
        assert!(upgrade_target(e, i, "standard", "unfunded").is_some());
        assert!(upgrade_target(e, i, "guardian", "ok").is_none());
        for claim in ["timelock_started", "claiming", "claimed"] {
            assert!(upgrade_target(e, i, "standard", claim).is_none(), "{claim}");
        }
        let up = upgrade_target(e, i, "standard", "ok").unwrap();
        assert!(upgrade_target(&up.pair.external, &up.pair.internal, "standard", "ok").is_none());
    }

    #[tokio::test]
    async fn a_deposit_whose_upgrade_is_still_waiting_is_not_reported_spent() {
        let pool = memory_db().await;
        seed_vault(&pool, "vault-up").await;
        let now = Utc::now();
        let waiting_txid = "ab".repeat(32);
        let sent_txid = "cd".repeat(32);
        // Two deposits already carried over to their upgrade outputs: one
        // whose transaction is on the network, one still being retried.
        record_new_deposits(
            &pool,
            "vault-up",
            &[
                deposit(&format!("{waiting_txid}:0"), 10_000, 800_000),
                deposit(&format!("{sent_txid}:0"), 20_000, 800_001),
            ],
            now,
        )
        .await;
        sqlx::query(
            "INSERT INTO vault_upgrade_txs (vault_id, txid, tx_hex, created_at, broadcast_at) \
             VALUES ('vault-up', ?, '00', ?, NULL), ('vault-up', ?, '00', ?, ?)",
        )
        .bind(&waiting_txid)
        .bind(now.to_rfc3339())
        .bind(&sent_txid)
        .bind(now.to_rfc3339())
        .bind(now.to_rfc3339())
        .execute(&pool)
        .await
        .unwrap();
        // The scan sees neither yet.
        record_spent_deposits(&pool, "vault-up", &[], now).await;
        let spent: Vec<String> = sqlx::query_scalar(
            "SELECT outpoint FROM vault_deposits WHERE vault_id = 'vault-up' AND spent_at IS NOT NULL",
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        // Only the one whose transaction is out and still missing counts.
        assert_eq!(spent, vec![format!("{sent_txid}:0")]);
    }

    #[tokio::test]
    async fn record_spent_deposits_emits_once_per_outpoint() {
        let pool = memory_db().await;
        seed_vault(&pool, "vault-1").await;
        seed_vault(&pool, "vault-2").await;
        let now = Utc::now();
        let vault = "vault-1";

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

        // Both still on-chain: nothing left, nothing logged.
        record_spent_deposits(
            &pool,
            vault,
            &["aaaa:0".to_string(), "bbbb:1".to_string()],
            now,
        )
        .await;
        assert_eq!(spent_count(&pool, vault).await, 0);

        // One swept off-server. The scan still sees the other, plus a
        // change output we never recorded as a deposit — which must not
        // confuse the comparison.
        record_spent_deposits(
            &pool,
            vault,
            &["bbbb:1".to_string(), "dddd:0".to_string()],
            now,
        )
        .await;
        assert_eq!(spent_count(&pool, vault).await, 1);

        // The dashboard reloads and rescans: the same gone outpoint must
        // not log a second time.
        record_spent_deposits(&pool, vault, &["bbbb:1".to_string()], now).await;
        assert_eq!(
            spent_count(&pool, vault).await,
            1,
            "a re-scan must not double-log a spend"
        );

        // The vault is emptied: only the remaining deposit logs.
        record_spent_deposits(&pool, vault, &[], now).await;
        assert_eq!(spent_count(&pool, vault).await, 2);

        // Spends are scoped per vault; vault-2 has its own ledger and is
        // untouched by any of the above.
        assert_eq!(spent_count(&pool, "vault-2").await, 0);
    }

    /// An owner send already says where the money went. The scan that
    /// follows must stamp those deposits without adding a second, vaguer
    /// line about the same coins — but a deposit that arrives *after*
    /// the send is not covered by it and must still report.
    #[tokio::test]
    async fn a_server_built_send_suppresses_the_duplicate_line() {
        let pool = memory_db().await;
        seed_vault(&pool, "vault-send").await;
        let vault = "vault-send";

        let before = Utc::now() - chrono::Duration::seconds(60);
        record_new_deposits(&pool, vault, &[deposit("aaaa:0", 100_000, 800_000)], before).await;

        crate::routes::record_event(&pool, vault, "owner_send", None)
            .await
            .expect("owner send");

        // A deposit that landed after the send; the send cannot have
        // spent it.
        let after = Utc::now() + chrono::Duration::seconds(60);
        record_new_deposits(&pool, vault, &[deposit("bbbb:1", 30_000, 800_010)], after).await;

        // The scan finds the vault empty: both deposits are gone.
        record_spent_deposits(&pool, vault, &[], Utc::now()).await;
        assert_eq!(
            spent_count(&pool, vault).await,
            1,
            "only the deposit the owner send could not explain reports"
        );

        // Both rows are stamped even so, or the pre-send deposit would be
        // re-evaluated on every future scan.
        let unstamped: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM vault_deposits WHERE vault_id = ? AND spent_at IS NULL",
        )
        .bind(vault)
        .fetch_one(&pool)
        .await
        .expect("count unstamped");
        assert_eq!(unstamped, 0);
    }

    /// A vault with no recorded deposits (never scanned, or created
    /// before the deposit ledger shipped) must stay silent, not read an
    /// empty scan as everything having been spent.
    #[tokio::test]
    async fn record_spent_deposits_is_silent_without_a_ledger() {
        let pool = memory_db().await;
        seed_vault(&pool, "vault-bare").await;

        record_spent_deposits(&pool, "vault-bare", &[], Utc::now()).await;
        assert_eq!(spent_count(&pool, "vault-bare").await, 0);
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
