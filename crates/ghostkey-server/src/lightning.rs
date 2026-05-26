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
//!     when the server is built without the `lightning` cargo feature,
//!     or when the operator hasn't configured Breez credentials.
//!
//!   * `BreezLiquidProvider` — wraps `breez-sdk-liquid`. Behind the
//!     `lightning` feature flag because the SDK isn't on crates.io
//!     and pulls in a large Liquid/Boltz/LSP dependency graph.
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

/// Convenience helper used at startup. Today this always returns
/// [`NoopProvider`]; the Breez SDK Liquid backend lives in a planned
/// sibling crate (see Cargo.toml for the rationale on why it isn't
/// pulled in here directly). When that crate exists, this function
/// will read env vars (`BREEZ_API_KEY`, `BREEZ_MNEMONIC`,
/// `BREEZ_NETWORK`, `BREEZ_WORKING_DIR`) and dispatch to the right
/// backend.
///
/// Never panics. Always returns *some* provider so handlers can call
/// `is_enabled()` rather than juggling an `Option`.
pub async fn build_provider() -> Arc<dyn LightningProvider> {
    if std::env::var("BREEZ_API_KEY").is_ok() && std::env::var("BREEZ_MNEMONIC").is_ok() {
        tracing::warn!(
            "BREEZ_API_KEY/MNEMONIC present but the Breez SDK Liquid backend is not \
             compiled in. Lightning check-ins remain disabled. See \
             crates/ghostkey-server/Cargo.toml for the integration plan."
        );
    }
    Arc::new(NoopProvider)
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
 *  Breez SDK Liquid backend                                                  *
 *                                                                            *
 *  Lives in a sibling crate (planned: `crates/ghostkey-lightning-breez`).    *
 *  See Cargo.toml for the long-form rationale on why the SDK isn't a         *
 *  direct workspace dependency. Briefly: it pins reqwest =0.12.18 exactly,   *
 *  ships only via git, and forks ~6 transitive dependencies that would       *
 *  poison the rest of the workspace.                                         *
 *                                                                            *
 *  The integration shape, when the sibling crate exists, is:                 *
 *                                                                            *
 *      use breez_sdk_liquid::sdk::LiquidSdk;                                 *
 *      use breez_sdk_liquid::model::{                                        *
 *          ConnectRequest, LiquidNetwork, PaymentMethod,                     *
 *          PrepareReceiveRequest, ReceivePaymentRequest                      *
 *      };                                                                    *
 *                                                                            *
 *      // 1. config = LiquidSdk::default_config(network, Some(api_key))      *
 *      // 2. sdk     = LiquidSdk::connect(ConnectRequest{ mnemonic, config }) *
 *      // 3. on create_invoice():                                            *
 *      //      prep = sdk.prepare_receive_payment(PrepareReceiveRequest {    *
 *      //                payment_method: PaymentMethod::Lightning,           *
 *      //                amount: Some(ReceiveAmount::Bitcoin{ payer_amount   *
 *      //                  _sat })})                                         *
 *      //      resp = sdk.receive_payment(ReceivePaymentRequest {            *
 *      //                prepare_response: prep,                             *
 *      //                description: Some(desc), ... })                     *
 *      //      → resp.destination is the BOLT11 invoice                      *
 *      //      → parse_invoice(&bolt11) gives payment_hash + expiry          *
 *      // 4. on invoice_status(): list_payments + filter by payment_hash     *
 *                                                                            *
 *  The sibling crate provides a function returning                          *
 *  `Arc<dyn LightningProvider>` which `build_provider()` above can pick      *
 *  up when the relevant env vars are set.                                    *
 * -------------------------------------------------------------------------- */

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
}
