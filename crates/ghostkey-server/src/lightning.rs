//! Lightning check-in subsystem.
//!
//! The owner can confirm liveness in two equivalent ways:
//!
//!   1. **Web heartbeat**  — `POST /vaults/:id/checkin`, authenticated
//!      with the owner bearer token. A click on the dashboard. Trusts
//!      the server to honestly record the timestamp.
//!
//!   2. **Lightning check-in** (this module) — owner pays a 1-sat
//!      BOLT11 invoice the server minted for their vault. Payment is a
//!      cryptographic act the owner does with their own wallet; the
//!      server cannot forge it. On payment the row is marked `paid`
//!      and the vault's check-in deadline is reset, identically to
//!      what option (1) does.
//!
//! Honesty caveat (documented in DESIGN.md): neither option resets
//! the on-chain BIP68 timer. That still requires a CLI re-vault
//! transaction. The Lightning check-in is "stronger than a button"
//! (cryptographic proof of liveness) but "weaker than a re-vault"
//! (does not extend the heir's on-chain claim window).
//!
//! ## Architecture
//!
//! The provider is abstracted behind [`LightningProvider`] so the
//! routes can stay backend-agnostic. Today there are two
//! implementations:
//!
//!   * [`NoopProvider`] — always returns "lightning disabled". Used
//!     when the operator hasn't configured the Breez sidecar.
//!
//!   * [`HttpProvider`] — talks over localhost HTTP to the
//!     `ghostkey-lightning-breez` sidecar binary (a separate crate,
//!     excluded from the root workspace; see its README for the
//!     rationale on why Breez SDK Liquid can't live in-process).
//!     Selected automatically when `GHOSTKEY_LN_BREEZ_URL` and
//!     `GHOSTKEY_LN_BREEZ_SHARED_SECRET` are both set.
//!
//! ## Why pull-poll instead of webhooks
//!
//! Breez SDK exposes an event stream (`add_event_listener`). We
//! consume that AND fall back to a periodic poll for two reasons:
//!
//!   1. Robustness across process restarts. If the server is bounced
//!      while a payment is in flight, we'd miss the event.
//!   2. Tests can drive the poller deterministically without a
//!      running Breez node.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::routes::record_event;
use crate::AppState;

/// Outcome of querying a Lightning provider for an invoice.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InvoiceStatus {
    /// Invoice exists but has not been paid yet.
    Pending,
    /// Invoice has been paid; the provider received the preimage.
    Paid,
    /// Invoice expired without being paid.
    Expired,
    /// Provider rejected the invoice or the payment failed in flight.
    Failed(String),
}

/// What [`LightningProvider::create_invoice`] returns on success.
#[derive(Debug, Clone)]
pub struct CreatedInvoice {
    /// BOLT11 string the payer's wallet consumes.
    pub bolt11: String,
    /// SHA-256 of the preimage, lowercase hex. Stable primary key for
    /// status lookups.
    pub payment_hash: String,
    /// Amount the payer must send, in sats. Echoes the request — but
    /// some providers may round up to a minimum.
    pub amount_sat: u64,
    /// Provider-reported invoice expiry.
    pub expires_at: DateTime<Utc>,
}

#[derive(Debug, thiserror::Error)]
pub enum LightningError {
    #[error("lightning provider not configured")]
    NotConfigured,
    #[error("invalid amount: {0}")]
    InvalidAmount(String),
    #[error("provider error: {0}")]
    Provider(String),
}

/// Anything that can mint invoices and report their status.
///
/// All methods are `&self` and `Send + Sync` so the provider can be
/// stored in an `Arc<dyn LightningProvider>` shared across handler
/// tasks. Implementations should be cheap to clone via `Arc`.
#[async_trait]
pub trait LightningProvider: Send + Sync {
    /// Whether this provider is wired up and ready to serve requests.
    /// The `NoopProvider` always returns false; the real provider
    /// returns true only after a successful SDK connect.
    fn is_enabled(&self) -> bool;

    /// Mint a BOLT11 invoice for the given amount and description.
    /// The description must include the vault id so the poller can
    /// later trace a payment back to the vault that asked for it.
    async fn create_invoice(
        &self,
        amount_sat: u64,
        description: &str,
    ) -> Result<CreatedInvoice, LightningError>;

    /// Look up the current status of an invoice by payment hash.
    async fn invoice_status(&self, payment_hash: &str) -> Result<InvoiceStatus, LightningError>;
}

/// Placeholder provider used when the `lightning` feature is off or
/// when the operator has not supplied Breez credentials. Every method
/// returns [`LightningError::NotConfigured`]. The HTTP routes turn
/// that into a 503 with a clear "set BREEZ_API_KEY / BREEZ_MNEMONIC"
/// message.
pub struct NoopProvider;

#[async_trait]
impl LightningProvider for NoopProvider {
    fn is_enabled(&self) -> bool {
        false
    }
    async fn create_invoice(
        &self,
        _amount_sat: u64,
        _description: &str,
    ) -> Result<CreatedInvoice, LightningError> {
        Err(LightningError::NotConfigured)
    }
    async fn invoice_status(&self, _payment_hash: &str) -> Result<InvoiceStatus, LightningError> {
        Err(LightningError::NotConfigured)
    }
}

/// Convenience helper used at startup.
///
/// Selection rules (first matching rule wins):
///
///   1. If `GHOSTKEY_LN_BREEZ_URL` AND `GHOSTKEY_LN_BREEZ_SHARED_SECRET`
///      are both set in the environment, build an [`HttpProvider`]
///      pointed at the running sidecar. This is the real production
///      path — the sidecar lives in `crates/ghostkey-lightning-breez`
///      and wraps the Breez SDK Liquid.
///
///   2. If the legacy `BREEZ_API_KEY` / `BREEZ_MNEMONIC` env vars are
///      set but the sidecar URL is not, warn loudly: the operator
///      likely forgot to start the sidecar or to point us at it. Fall
///      back to [`NoopProvider`].
///
///   3. Otherwise return [`NoopProvider`] silently.
///
/// Never panics. Always returns *some* provider so handlers can call
/// `is_enabled()` rather than juggling an `Option`.
pub async fn build_provider() -> Arc<dyn LightningProvider> {
    let url = std::env::var("GHOSTKEY_LN_BREEZ_URL").ok();
    let secret = std::env::var("GHOSTKEY_LN_BREEZ_SHARED_SECRET").ok();

    match (url, secret) {
        (Some(url), Some(secret)) if !url.is_empty() && !secret.is_empty() => {
            tracing::info!(url = %url, "lightning: using HTTP sidecar provider");
            match HttpProvider::new(url, secret) {
                Ok(p) => Arc::new(p),
                Err(e) => {
                    tracing::error!(
                        error = ?e,
                        "lightning: failed to build HTTP sidecar client; falling back to NoopProvider"
                    );
                    Arc::new(NoopProvider)
                }
            }
        }
        _ => {
            if std::env::var("BREEZ_API_KEY").is_ok() || std::env::var("BREEZ_MNEMONIC").is_ok() {
                tracing::warn!(
                    "BREEZ_API_KEY/MNEMONIC present but GHOSTKEY_LN_BREEZ_URL / \
                     GHOSTKEY_LN_BREEZ_SHARED_SECRET are not set. The Breez SDK \
                     lives in the ghostkey-lightning-breez sidecar binary; start \
                     it and point us at it via those two env vars. Lightning \
                     check-ins remain disabled."
                );
            }
            Arc::new(NoopProvider)
        }
    }
}

/// Default amount for a "I'm alive" Lightning check-in. One sat is
/// the smallest amount Boltz / most LSPs will route. We expose it as
/// a constant so the routes and tests agree on a value without
/// re-asserting it at every call site.
pub const HEARTBEAT_AMOUNT_SAT: u64 = 1;

/* -------------------------------------------------------------------------- *
 *  Database glue                                                             *
 *                                                                            *
 *  Thin functions to insert / fetch / update rows in `lightning_invoices`.   *
 *  Routes and the poller share these so the SQL is in one place.             *
 * -------------------------------------------------------------------------- */

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct InvoiceRecord {
    pub id: i64,
    pub vault_id: String,
    pub bolt11: String,
    pub payment_hash: String,
    pub amount_sat: i64,
    pub status: String,
    pub created_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    pub paid_at: Option<DateTime<Utc>>,
}

pub async fn insert_invoice(
    db: &sqlx::SqlitePool,
    vault_id: &str,
    invoice: &CreatedInvoice,
) -> Result<InvoiceRecord, sqlx::Error> {
    let now = Utc::now();
    let now_s = now.to_rfc3339();
    let exp_s = invoice.expires_at.to_rfc3339();
    let row: (i64,) = sqlx::query_as(
        r#"INSERT INTO lightning_invoices
               (vault_id, bolt11, payment_hash, amount_sat, status,
                created_at, expires_at)
           VALUES (?, ?, ?, ?, 'pending', ?, ?)
           RETURNING id"#,
    )
    .bind(vault_id)
    .bind(&invoice.bolt11)
    .bind(&invoice.payment_hash)
    .bind(invoice.amount_sat as i64)
    .bind(&now_s)
    .bind(&exp_s)
    .fetch_one(db)
    .await?;

    Ok(InvoiceRecord {
        id: row.0,
        vault_id: vault_id.to_string(),
        bolt11: invoice.bolt11.clone(),
        payment_hash: invoice.payment_hash.clone(),
        amount_sat: invoice.amount_sat as i64,
        status: "pending".into(),
        created_at: now,
        expires_at: invoice.expires_at,
        paid_at: None,
    })
}

pub async fn fetch_invoice_by_hash(
    db: &sqlx::SqlitePool,
    payment_hash: &str,
) -> Result<Option<InvoiceRecord>, sqlx::Error> {
    let row: Option<(
        i64,
        String,
        String,
        String,
        i64,
        String,
        String,
        String,
        Option<String>,
    )> = sqlx::query_as(
        r#"SELECT id, vault_id, bolt11, payment_hash, amount_sat, status,
                  created_at, expires_at, paid_at
             FROM lightning_invoices
            WHERE payment_hash = ?"#,
    )
    .bind(payment_hash)
    .fetch_optional(db)
    .await?;
    Ok(row.map(|r| InvoiceRecord {
        id: r.0,
        vault_id: r.1,
        bolt11: r.2,
        payment_hash: r.3,
        amount_sat: r.4,
        status: r.5,
        created_at: parse_rfc(&r.6),
        expires_at: parse_rfc(&r.7),
        paid_at: r.8.as_deref().map(parse_rfc),
    }))
}

fn parse_rfc(s: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(s)
        .map(|d| d.with_timezone(&Utc))
        .unwrap_or_else(|_| Utc::now())
}

/// Mark an invoice paid and reset the vault's check-in deadlines.
///
/// This is the join point between the Lightning subsystem and the
/// vault state machine. The semantics MUST match what
/// `routes::checkin` does — same SQL columns, same recomputation —
/// so that a Lightning check-in is indistinguishable from a button
/// tap downstream.
pub async fn mark_paid_and_checkin(
    db: &sqlx::SqlitePool,
    payment_hash: &str,
) -> anyhow::Result<()> {
    let now = Utc::now();
    let now_s = now.to_rfc3339();

    let mut tx = db.begin().await?;

    // CAS-style update: only the first observer marks it paid.
    let updated = sqlx::query(
        r#"UPDATE lightning_invoices
              SET status  = 'paid',
                  paid_at = ?
            WHERE payment_hash = ?
              AND status = 'pending'"#,
    )
    .bind(&now_s)
    .bind(payment_hash)
    .execute(&mut *tx)
    .await?;
    if updated.rows_affected() == 0 {
        // Already processed by an earlier tick / another worker. Not
        // an error; we just have nothing to do.
        tx.commit().await?;
        return Ok(());
    }

    // Look up the vault id and its cadence to recompute the deadline.
    let row: Option<(String, i64, i64)> = sqlx::query_as(
        r#"SELECT li.vault_id, v.checkin_period_secs, v.grace_period_secs
             FROM lightning_invoices li
             JOIN vaults v ON v.id = li.vault_id
            WHERE li.payment_hash = ?"#,
    )
    .bind(payment_hash)
    .fetch_optional(&mut *tx)
    .await?;

    let Some((vault_id, checkin_secs, grace_secs)) = row else {
        anyhow::bail!("lightning invoice {payment_hash} has no vault row");
    };

    let next = now + chrono::Duration::seconds(checkin_secs + grace_secs);
    let claim_eligible = next + chrono::Duration::seconds(grace_secs);

    // Same column set the HTTP /checkin route writes. Clearing the
    // claim_token_* trio matters: if the owner was already alarmed
    // and a token had been minted, paying the invoice unwinds that
    // state cleanly. See routes::checkin for the matching SQL.
    sqlx::query(
        r#"UPDATE vaults
              SET last_checkin_at      = ?,
                  next_deadline_at     = ?,
                  status               = 'ok',
                  claim_eligible_at    = ?,
                  claim_token_hash     = NULL,
                  claim_token_issued_at = NULL,
                  claim_token_used_at  = NULL
            WHERE id = ?"#,
    )
    .bind(&now_s)
    .bind(next.to_rfc3339())
    .bind(claim_eligible.to_rfc3339())
    .bind(&vault_id)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    // Record the heartbeat in the audit log so the dashboard event
    // drawer shows it alongside button check-ins. The `source` field
    // lets us tell them apart for analytics.
    record_event(
        db,
        &vault_id,
        "checkin",
        Some(serde_json::json!({
            "source": "lightning",
            "payment_hash": payment_hash,
        })),
    )
    .await?;

    tracing::info!(
        vault_id = %vault_id,
        payment_hash = %payment_hash,
        "lightning check-in confirmed; vault deadline reset"
    );
    Ok(())
}

/// Background poller. Walks every `pending` invoice that hasn't been
/// polled recently and asks the provider for status. Paid invoices
/// go through [`mark_paid_and_checkin`]; expired ones are tombstoned.
pub async fn run_poller(state: Arc<AppState>, tick: Duration) {
    loop {
        if let Err(e) = tick_once(&state).await {
            tracing::error!(error = ?e, "lightning poller tick failed");
        }
        tokio::time::sleep(tick).await;
    }
}

async fn tick_once(state: &AppState) -> anyhow::Result<()> {
    if !state.lightning.is_enabled() {
        return Ok(());
    }

    let now = Utc::now();
    let now_s = now.to_rfc3339();

    // Expire old invoices first so the pending set stays small.
    sqlx::query(
        r#"UPDATE lightning_invoices
              SET status = 'expired'
            WHERE status = 'pending'
              AND expires_at <= ?"#,
    )
    .bind(&now_s)
    .execute(&state.db)
    .await?;

    // Poll remaining pending. We cap the batch so a backlog doesn't
    // starve the runtime; rows we don't get to this tick are picked
    // up next time.
    let rows: Vec<(String,)> = sqlx::query_as(
        r#"SELECT payment_hash
             FROM lightning_invoices
            WHERE status = 'pending'
            ORDER BY COALESCE(last_polled_at, created_at) ASC
            LIMIT 32"#,
    )
    .fetch_all(&state.db)
    .await?;

    for (hash,) in rows {
        sqlx::query("UPDATE lightning_invoices SET last_polled_at = ? WHERE payment_hash = ?")
            .bind(&now_s)
            .bind(&hash)
            .execute(&state.db)
            .await?;

        match state.lightning.invoice_status(&hash).await {
            Ok(InvoiceStatus::Paid) => {
                if let Err(e) = mark_paid_and_checkin(&state.db, &hash).await {
                    tracing::error!(payment_hash = %hash, error = ?e, "mark_paid failed");
                }
            }
            Ok(InvoiceStatus::Expired) => {
                let _ = sqlx::query(
                    "UPDATE lightning_invoices SET status = 'expired' WHERE payment_hash = ?",
                )
                .bind(&hash)
                .execute(&state.db)
                .await;
            }
            Ok(InvoiceStatus::Failed(msg)) => {
                let _ = sqlx::query(
                    "UPDATE lightning_invoices SET status = 'failed', last_error = ? WHERE payment_hash = ?",
                )
                .bind(&msg)
                .bind(&hash)
                .execute(&state.db)
                .await;
            }
            Ok(InvoiceStatus::Pending) => {}
            Err(LightningError::NotConfigured) => {
                // Provider gone away between is_enabled() and the
                // call. Stop polling for this tick.
                return Ok(());
            }
            Err(e) => {
                tracing::warn!(payment_hash = %hash, error = ?e, "invoice status poll failed");
            }
        }
    }
    Ok(())
}

/* -------------------------------------------------------------------------- *
 *  HTTP sidecar backend                                                      *
 *                                                                            *
 *  Talks to the `ghostkey-lightning-breez` sidecar binary over plain HTTP    *
 *  on localhost. The sidecar wraps Breez SDK Liquid; see                     *
 *  `crates/ghostkey-lightning-breez/README.md` for the rationale on why      *
 *  it lives out-of-process (breez-sdk-liquid pins reqwest =0.12.18, ships    *
 *  only via git, and forks several transitive dependencies — keeping it in  *
 *  a separate process keeps the main workspace clean and lets contributors   *
 *  build GhostKey without a Breez API key).                                  *
 *                                                                            *
 *  Wire format mirrored from `crates/ghostkey-lightning-breez/src/main.rs`: *
 *                                                                            *
 *      GET  /v1/health             → { ok, ready, version }                  *
 *      POST /v1/invoice            → { bolt11, payment_hash, amount_sat,     *
 *                                       expires_at }                          *
 *      GET  /v1/status/:hash       → { status, paid_at? }                    *
 *                                                                            *
 *  Auth: `Authorization: Bearer <shared_secret>` on every call except       *
 *  health. Mismatch surfaces as `LightningError::Provider("unauthorized")`. *
 * -------------------------------------------------------------------------- */

/// Lightning provider that delegates to the out-of-process
/// `ghostkey-lightning-breez` sidecar over HTTP.
pub struct HttpProvider {
    /// Base URL without trailing slash, e.g. `http://127.0.0.1:8788`.
    base_url: String,
    shared_secret: String,
    client: reqwest::Client,
}

impl HttpProvider {
    /// Construct a new client. The `base_url` is normalised (trailing
    /// `/` stripped) so callers don't have to care which form they
    /// passed. Returns `Err` only if reqwest itself refuses to build
    /// a client — which in practice means the host's rustls / TLS
    /// config is broken; in that case the operator has bigger problems.
    pub fn new(base_url: String, shared_secret: String) -> anyhow::Result<Self> {
        let base_url = base_url.trim_end_matches('/').to_string();
        let client = reqwest::Client::builder()
            // Keep request timeout short: the sidecar lives on
            // localhost and a slow path almost always means the
            // SDK is wedged. Better to surface a 502 and let the
            // poller retry than to block the request task for 30s.
            .timeout(std::time::Duration::from_secs(10))
            .build()?;
        Ok(Self {
            base_url,
            shared_secret,
            client,
        })
    }

    /// Hit `/v1/health` and return whether the sidecar reports
    /// `ready: true`. Used by `is_enabled()` — except `is_enabled()`
    /// is synchronous and called on every route, so we cannot block
    /// on a network call there. Instead `is_enabled()` returns true
    /// unconditionally once an `HttpProvider` is constructed, and the
    /// HTTP routes will surface the sidecar's NOT-READY response as
    /// a regular Provider error. This matches the semantics callers
    /// expect: "the operator wired up Lightning, so the UI may show
    /// the button; payment-flow failures still bubble up to the user."
    ///
    /// Kept on the impl as a documented building block for an ops
    /// debug endpoint (and to make the wire surface obvious to
    /// readers of this file); not on the trait because the trait
    /// stays minimal.
    #[allow(dead_code)]
    async fn health(&self) -> Result<bool, LightningError> {
        let url = format!("{}/v1/health", self.base_url);
        let resp = self
            .client
            .get(&url)
            .send()
            .await
            .map_err(|e| LightningError::Provider(format!("health: {e}")))?;
        if !resp.status().is_success() {
            return Err(LightningError::Provider(format!(
                "health returned HTTP {}",
                resp.status()
            )));
        }
        #[derive(Deserialize)]
        struct H {
            ready: bool,
        }
        let body: H = resp
            .json()
            .await
            .map_err(|e| LightningError::Provider(format!("health decode: {e}")))?;
        Ok(body.ready)
    }
}

#[derive(Serialize)]
struct WireInvoiceRequest<'a> {
    amount_sat: u64,
    description: &'a str,
}

#[derive(Deserialize)]
struct WireInvoiceResponse {
    bolt11: String,
    payment_hash: String,
    amount_sat: u64,
    expires_at: DateTime<Utc>,
}

#[derive(Deserialize)]
struct WireStatusResponse {
    status: String,
    #[allow(dead_code)]
    paid_at: Option<DateTime<Utc>>,
}

#[async_trait]
impl LightningProvider for HttpProvider {
    fn is_enabled(&self) -> bool {
        // See the note on `health()` above. Construction implies the
        // operator opted in; we report enabled and let per-call errors
        // surface real provider trouble.
        true
    }

    async fn create_invoice(
        &self,
        amount_sat: u64,
        description: &str,
    ) -> Result<CreatedInvoice, LightningError> {
        if amount_sat == 0 {
            return Err(LightningError::InvalidAmount(
                "amount_sat must be > 0".into(),
            ));
        }

        let url = format!("{}/v1/invoice", self.base_url);
        let body = WireInvoiceRequest {
            amount_sat,
            description,
        };
        let resp = self
            .client
            .post(&url)
            .bearer_auth(&self.shared_secret)
            .json(&body)
            .send()
            .await
            .map_err(|e| LightningError::Provider(format!("invoice send: {e}")))?;

        let status = resp.status();
        if !status.is_success() {
            // Best-effort error body; the sidecar always returns
            // `{ "error": "..." }` on failure.
            let msg = resp.text().await.unwrap_or_else(|_| "<no body>".into());
            return Err(LightningError::Provider(format!(
                "invoice returned HTTP {status}: {msg}"
            )));
        }

        let body: WireInvoiceResponse = resp
            .json()
            .await
            .map_err(|e| LightningError::Provider(format!("invoice decode: {e}")))?;

        Ok(CreatedInvoice {
            bolt11: body.bolt11,
            payment_hash: body.payment_hash,
            amount_sat: body.amount_sat,
            expires_at: body.expires_at,
        })
    }

    async fn invoice_status(&self, payment_hash: &str) -> Result<InvoiceStatus, LightningError> {
        if payment_hash.len() != 64 || !payment_hash.chars().all(|c| c.is_ascii_hexdigit()) {
            return Err(LightningError::Provider(format!(
                "invalid payment_hash {payment_hash:?} (expected 64 hex chars)"
            )));
        }

        let url = format!("{}/v1/status/{payment_hash}", self.base_url);
        let resp = self
            .client
            .get(&url)
            .bearer_auth(&self.shared_secret)
            .send()
            .await
            .map_err(|e| LightningError::Provider(format!("status send: {e}")))?;

        let status = resp.status();
        if !status.is_success() {
            let msg = resp.text().await.unwrap_or_else(|_| "<no body>".into());
            return Err(LightningError::Provider(format!(
                "status returned HTTP {status}: {msg}"
            )));
        }

        let body: WireStatusResponse = resp
            .json()
            .await
            .map_err(|e| LightningError::Provider(format!("status decode: {e}")))?;

        // The sidecar speaks the trio { pending | paid | failed }.
        // It never returns `expired` directly — the GhostKey server's
        // own poller demotes pending invoices past their expires_at,
        // so we map any unrecognised value to a defensive Failed().
        Ok(match body.status.as_str() {
            "pending" => InvoiceStatus::Pending,
            "paid" => InvoiceStatus::Paid,
            "failed" => InvoiceStatus::Failed("sidecar reported failed".into()),
            other => InvoiceStatus::Failed(format!("unknown status {other:?}")),
        })
    }
}

/* -------------------------------------------------------------------------- *
 *  Tests                                                                     *
 * -------------------------------------------------------------------------- */

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;
    use sqlx::SqlitePool;

    #[tokio::test]
    async fn noop_provider_reports_disabled() {
        let p = NoopProvider;
        assert!(!p.is_enabled());
        assert!(matches!(
            p.create_invoice(1, "test").await,
            Err(LightningError::NotConfigured)
        ));
        assert!(matches!(
            p.invoice_status("00").await,
            Err(LightningError::NotConfigured)
        ));
    }

    async fn fresh_db() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("connect");
        sqlx::migrate!("./migrations")
            .run(&pool)
            .await
            .expect("migrate");
        pool
    }

    async fn insert_vault(pool: &SqlitePool, id: &str, period: i64, grace: i64) {
        sqlx::query(
            r#"INSERT INTO vaults (
                id, network,
                descriptor_external, descriptor_internal,
                timelock_blocks,
                checkin_period_secs, grace_period_secs,
                created_at, next_deadline_at, status,
                claim_eligible_at,
                owner_token_hash
            ) VALUES (?, 'regtest', ?, ?, 144, ?, ?,
                      '2026-01-01T00:00:00Z',
                      '2026-01-02T00:00:00Z', 'alarmed',
                      '2026-01-03T00:00:00Z',
                      'fake-hash')"#,
        )
        .bind(id)
        .bind(format!("tr(fake/{id}/0/*)"))
        .bind(format!("tr(fake/{id}/1/*)"))
        .bind(period)
        .bind(grace)
        .execute(pool)
        .await
        .expect("insert");
    }

    /// The Lightning check-in MUST reset the vault to `ok` with a
    /// fresh `next_deadline_at` derived from the cadence — same
    /// invariants `routes::checkin` enforces. Regressions in
    /// `mark_paid_and_checkin` would silently leave alarmed vaults
    /// alarmed even after a successful payment, defeating the entire
    /// feature.
    #[tokio::test]
    async fn paid_invoice_resets_vault_state_like_button_checkin() {
        let pool = fresh_db().await;
        insert_vault(&pool, "v1", 14 * 86400, 3 * 86400).await;

        let now = Utc::now();
        // Seed a pending invoice.
        sqlx::query(
            r#"INSERT INTO lightning_invoices
                  (vault_id, bolt11, payment_hash, amount_sat, status, created_at, expires_at)
               VALUES ('v1', 'lnbc1...', 'hash1', 1, 'pending', ?, ?)"#,
        )
        .bind(now.to_rfc3339())
        .bind((now + chrono::Duration::hours(1)).to_rfc3339())
        .execute(&pool)
        .await
        .unwrap();

        mark_paid_and_checkin(&pool, "hash1").await.unwrap();

        // Invoice row flipped to paid.
        let (status,): (String,) =
            sqlx::query_as("SELECT status FROM lightning_invoices WHERE payment_hash = 'hash1'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(status, "paid");

        // Vault returned to `ok` with deadlines pushed into the future
        // and any pending claim-token state cleared.
        let (v_status, claim_hash): (String, Option<String>) =
            sqlx::query_as("SELECT status, claim_token_hash FROM vaults WHERE id = 'v1'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(v_status, "ok");
        assert!(claim_hash.is_none());

        // A `checkin` event was logged with the lightning source tag
        // so analytics can distinguish from button heartbeats.
        let detail: Option<String> = sqlx::query_scalar(
            "SELECT detail FROM events WHERE vault_id = 'v1' AND kind = 'checkin'",
        )
        .fetch_optional(&pool)
        .await
        .unwrap()
        .flatten();
        let detail = detail.expect("checkin event must exist");
        assert!(detail.contains("\"lightning\""), "got: {detail}");
    }

    /// Double-processing the same payment_hash must be a no-op. The
    /// poller can race the synchronous status route — both could try
    /// to claim a paid invoice. Only the first wins; subsequent calls
    /// observe the row is already `paid` and exit silently.
    #[tokio::test]
    async fn mark_paid_is_idempotent() {
        let pool = fresh_db().await;
        insert_vault(&pool, "v2", 14 * 86400, 3 * 86400).await;
        let now = Utc::now();
        sqlx::query(
            r#"INSERT INTO lightning_invoices
                  (vault_id, bolt11, payment_hash, amount_sat, status, created_at, expires_at)
               VALUES ('v2', 'lnbc2...', 'hash2', 1, 'pending', ?, ?)"#,
        )
        .bind(now.to_rfc3339())
        .bind((now + chrono::Duration::hours(1)).to_rfc3339())
        .execute(&pool)
        .await
        .unwrap();

        mark_paid_and_checkin(&pool, "hash2").await.unwrap();
        // Second call must not double-record the event.
        mark_paid_and_checkin(&pool, "hash2").await.unwrap();

        let n: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM events WHERE vault_id = 'v2' AND kind = 'checkin'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(n, 1, "exactly one checkin event per paid invoice");
    }

    /* ---------------------------------------------------------------- *
     *  HttpProvider tests                                              *
     *                                                                  *
     *  These spin up a tiny in-process axum server that mimics the     *
     *  sidecar's wire format and point the real HttpProvider at it.   *
     *  Using a real socket (rather than tower::ServiceExt::oneshot)    *
     *  is intentional: reqwest's connection handling, JSON decoding,  *
     *  and bearer auth header construction are exactly what we want   *
     *  to exercise. The cost — one ephemeral TCP port per test — is    *
     *  negligible on any developer machine or CI runner.              *
     * ---------------------------------------------------------------- */

    use axum::extract::Path as AxPath;
    use axum::http::StatusCode;
    use axum::routing::{get, post};
    use axum::Json;
    use axum::Router;
    use std::net::SocketAddr;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc as StdArc;

    /// Sidecar shape we mimic. Counters let the test assert how many
    /// times each route fired so we catch silent retries or missing
    /// auth headers.
    #[derive(Default)]
    struct MockSidecar {
        invoice_hits: AtomicUsize,
        status_hits: AtomicUsize,
        seen_bearer: std::sync::Mutex<Option<String>>,
    }

    async fn spawn_mock(sidecar: StdArc<MockSidecar>, secret: String) -> String {
        let sidecar_for_invoice = sidecar.clone();
        let secret_for_invoice = secret.clone();
        let sidecar_for_status = sidecar.clone();
        let secret_for_status = secret.clone();

        let app = Router::new()
            .route(
                "/v1/invoice",
                post(move |headers: axum::http::HeaderMap, Json(body): Json<serde_json::Value>| {
                    let sidecar = sidecar_for_invoice.clone();
                    let secret = secret_for_invoice.clone();
                    async move {
                        sidecar.invoice_hits.fetch_add(1, Ordering::SeqCst);
                        let bearer = headers
                            .get(axum::http::header::AUTHORIZATION)
                            .and_then(|v| v.to_str().ok())
                            .map(|s| s.to_string());
                        *sidecar.seen_bearer.lock().unwrap() = bearer.clone();
                        if bearer.as_deref() != Some(&format!("Bearer {secret}")) {
                            return (
                                StatusCode::UNAUTHORIZED,
                                Json(serde_json::json!({"error":"unauthorized"})),
                            );
                        }
                        let amount = body["amount_sat"].as_u64().unwrap_or(0);
                        if amount == 0 {
                            return (
                                StatusCode::BAD_REQUEST,
                                Json(serde_json::json!({"error":"amount_sat must be > 0"})),
                            );
                        }
                        (
                            StatusCode::OK,
                            Json(serde_json::json!({
                                "bolt11": "lnbc10n1mockedinvoice",
                                "payment_hash": "a".repeat(64),
                                "amount_sat": amount,
                                "expires_at": (Utc::now() + chrono::Duration::hours(1)).to_rfc3339(),
                            })),
                        )
                    }
                }),
            )
            .route(
                "/v1/status/:hash",
                get(move |AxPath(hash): AxPath<String>, headers: axum::http::HeaderMap| {
                    let sidecar = sidecar_for_status.clone();
                    let secret = secret_for_status.clone();
                    async move {
                        sidecar.status_hits.fetch_add(1, Ordering::SeqCst);
                        let bearer = headers
                            .get(axum::http::header::AUTHORIZATION)
                            .and_then(|v| v.to_str().ok())
                            .map(|s| s.to_string());
                        if bearer.as_deref() != Some(&format!("Bearer {secret}")) {
                            return (
                                StatusCode::UNAUTHORIZED,
                                Json(serde_json::json!({"error":"unauthorized"})),
                            );
                        }
                        // First hex char encodes the state we want returned.
                        // 'a' -> paid, 'b' -> failed, anything else -> pending.
                        let status = match hash.chars().next() {
                            Some('a') => "paid",
                            Some('b') => "failed",
                            _ => "pending",
                        };
                        (
                            StatusCode::OK,
                            Json(serde_json::json!({
                                "status": status,
                                "paid_at": if status == "paid" {
                                    Some(Utc::now().to_rfc3339())
                                } else {
                                    None
                                },
                            })),
                        )
                    }
                }),
            );

        let listener = tokio::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0)))
            .await
            .expect("bind ephemeral port");
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        format!("http://{addr}")
    }

    /// Happy-path round trip: HttpProvider should serialise the
    /// request body the sidecar expects, attach the bearer header,
    /// and decode the JSON response into the trait's `CreatedInvoice`
    /// shape. Regressions here would silently break every Lightning
    /// check-in.
    #[tokio::test]
    async fn http_provider_create_invoice_round_trips() {
        let sidecar = StdArc::new(MockSidecar::default());
        let secret = "test-secret-token".to_string();
        let url = spawn_mock(sidecar.clone(), secret.clone()).await;

        let provider = HttpProvider::new(url, secret.clone()).unwrap();
        let invoice = provider
            .create_invoice(7, "ghostkey:checkin:v1")
            .await
            .expect("invoice");

        assert_eq!(invoice.amount_sat, 7);
        assert_eq!(invoice.payment_hash.len(), 64);
        assert!(invoice.bolt11.starts_with("lnbc"));
        assert_eq!(sidecar.invoice_hits.load(Ordering::SeqCst), 1);
        assert_eq!(
            sidecar.seen_bearer.lock().unwrap().as_deref(),
            Some(format!("Bearer {secret}").as_str()),
            "bearer header must be presented verbatim"
        );
    }

    /// Mismatched shared secret must bubble up as a Provider error so
    /// the operator notices the configuration drift rather than the
    /// UI silently looking broken.
    #[tokio::test]
    async fn http_provider_rejects_wrong_secret() {
        let sidecar = StdArc::new(MockSidecar::default());
        let url = spawn_mock(sidecar.clone(), "right-secret".into()).await;

        let provider = HttpProvider::new(url, "WRONG-secret".into()).unwrap();
        let err = provider
            .create_invoice(1, "ghostkey:checkin:v1")
            .await
            .expect_err("must fail");
        match err {
            LightningError::Provider(msg) => assert!(msg.contains("401"), "got: {msg}"),
            other => panic!("expected Provider, got {other:?}"),
        }
    }

    /// Zero-amount requests must fail client-side without ever hitting
    /// the network — InvalidAmount, not Provider. Catches a class of
    /// bugs where a UI control accidentally sends 0 and the user sees
    /// a misleading "sidecar error" toast.
    #[tokio::test]
    async fn http_provider_rejects_zero_amount_locally() {
        let provider = HttpProvider::new("http://127.0.0.1:1".into(), "secret".into()).unwrap();
        let err = provider
            .create_invoice(0, "x")
            .await
            .expect_err("must fail");
        assert!(
            matches!(err, LightningError::InvalidAmount(_)),
            "got {err:?}"
        );
    }

    /// Status lookup must map the sidecar's lowercase string into the
    /// trait's enum exactly. The poller dispatches on these variants
    /// to mark paid vs. tombstone — a mis-mapping would corrupt vault
    /// state.
    #[tokio::test]
    async fn http_provider_status_mapping() {
        let sidecar = StdArc::new(MockSidecar::default());
        let secret = "ok".to_string();
        let url = spawn_mock(sidecar.clone(), secret.clone()).await;
        let provider = HttpProvider::new(url, secret).unwrap();

        // Hashes are 64 hex chars; first nibble chooses the mock state.
        let paid_hash = format!("a{}", "0".repeat(63));
        let pend_hash = format!("c{}", "0".repeat(63));
        let fail_hash = format!("b{}", "0".repeat(63));

        assert_eq!(
            provider.invoice_status(&paid_hash).await.unwrap(),
            InvoiceStatus::Paid
        );
        assert_eq!(
            provider.invoice_status(&pend_hash).await.unwrap(),
            InvoiceStatus::Pending
        );
        match provider.invoice_status(&fail_hash).await.unwrap() {
            InvoiceStatus::Failed(_) => {}
            other => panic!("expected Failed, got {other:?}"),
        }
        assert_eq!(sidecar.status_hits.load(Ordering::SeqCst), 3);
    }

    /// Malformed payment_hash must be rejected before we open a
    /// socket. The sidecar would also reject it, but failing fast
    /// keeps the error message clear and saves a round trip.
    #[tokio::test]
    async fn http_provider_rejects_bad_payment_hash() {
        let provider = HttpProvider::new("http://127.0.0.1:1".into(), "secret".into()).unwrap();
        assert!(provider.invoice_status("too-short").await.is_err());
        assert!(provider
            .invoice_status(&"z".repeat(64)) // not hex
            .await
            .is_err());
    }

    /// `is_enabled()` must NOT make a network call. Routes hit it
    /// on every request; a blocking syscall there would be a foot-gun.
    /// We assert by pointing the provider at an unroutable address —
    /// any real I/O would hang or surface as an error.
    #[tokio::test]
    async fn http_provider_is_enabled_is_synchronous_and_cheap() {
        let provider = HttpProvider::new("http://0.0.0.0:1".into(), "secret".into()).unwrap();
        // Repeated calls, fast — if this ever does I/O the test will
        // either hang or take 10s+. CI will surface either.
        for _ in 0..1000 {
            assert!(provider.is_enabled());
        }
    }
}
