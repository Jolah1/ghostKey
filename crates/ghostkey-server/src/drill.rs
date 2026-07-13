//! Claim fire drill (#223): the heir rehearses the claim while the
//! owner is alive.
//!
//! Inheritance tools fail silently: a wrong email address, a confused
//! heir, or a dead link only surfaces when the owner is gone. A drill
//! converts "trust me" into "watch it work": the owner clicks once,
//! the heir receives a real email with a real link and walks the real
//! claim pages end to end — and nothing can move.
//!
//! Safety comes from construction, not from flag checks: the practice
//! token is stored in `drill_token_hash`, a different column from
//! `claim_token_hash`. Every endpoint that reveals key material or
//! moves coins (sealed-heir, heir-claim, build-psbt, broadcast, the
//! claim video) looks the vault up by `claim_token_hash`, so a drill
//! token is simply never found there. A future refactor cannot arm a
//! drill token without deliberately querying the drill column.
//!
//! Endpoints:
//!   `POST /vaults/:id/drill`            (OwnerAuth) — start a practice run.
//!   `POST /claim/:token/drill-complete` (drill token) — heir finished it.
//!
//! `GET /claim/:token` (routes::resolve_claim) recognises drill tokens
//! and serves the usual `ClaimView` with `drill: true` — without
//! starting the claim-challenge window, alerting the trusted contact,
//! or touching any real claim state.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::Json;
use chrono::{DateTime, Utc};
use serde::Serialize;

use crate::auth::OwnerAuth;
use crate::crypto::{claim_token_matches, hash_claim_token, issue_claim_token};
use crate::notifier::{self, Channel, NotificationKind};
use crate::routes::{record_event, ApiError, ClaimView};
use crate::scheduler::public_base_url;
use crate::AppState;

#[derive(Debug, Serialize)]
pub struct DrillStartResponse {
    pub vault_id: String,
    pub started_at: DateTime<Utc>,
    /// Whether a practice email/SMS was queued for the heir. False when
    /// the vault has no deliverable heir contact — the owner can still
    /// share `claim_url` themselves.
    pub heir_notified: bool,
    /// The practice link. Returning it to the owner adds no capability:
    /// the owner already holds the keys, and a drill token cannot reach
    /// key material or move coins on any endpoint.
    pub claim_url: String,
}

#[derive(Debug, Serialize)]
pub struct DrillCompleteResponse {
    pub completed_at: DateTime<Utc>,
}

/// Start (or restart) a practice claim. Mints a fresh drill token,
/// resets the opened/completed markers, and sends the heir a message
/// that mirrors the real claim contact — explicitly framed as practice
/// so nobody grieves over a rehearsal.
pub async fn start_drill(
    auth: OwnerAuth,
    State(state): State<Arc<AppState>>,
) -> Result<Json<DrillStartResponse>, ApiError> {
    let id = auth.vault_id;
    let row: Option<(String, Option<String>, Option<String>)> = sqlx::query_as(
        r#"SELECT status, heir_contact_ciphertext, heir_contact_nonce
             FROM vaults WHERE id = ?"#,
    )
    .bind(&id)
    .fetch_optional(&state.db)
    .await?;
    let Some((status, heir_ct, heir_nn)) = row else {
        return Err(ApiError::NotFound);
    };
    // A rehearsal makes no sense once the real claim is running or
    // done — and a practice email landing next to a real claim email
    // would confuse the heir at the worst possible moment.
    if matches!(status.as_str(), "claiming" | "claimed") {
        return Err(ApiError::Conflict(
            "a real claim is already underway on this vault".into(),
        ));
    }

    let issued = issue_claim_token();
    let now = Utc::now();
    sqlx::query(
        r#"UPDATE vaults
              SET drill_token_hash   = ?,
                  drill_started_at   = ?,
                  drill_opened_at    = NULL,
                  drill_completed_at = NULL
            WHERE id = ?"#,
    )
    .bind(&issued.hash_hex)
    .bind(now.to_rfc3339())
    .bind(&id)
    .execute(&state.db)
    .await?;

    record_event(&state.db, &id, "drill_started", None).await?;

    let base = public_base_url();
    let claim_url = format!("{base}/#/claim/{}", issued.token);
    let heir_notified = enqueue_drill_invite(&state, &id, heir_ct, heir_nn, &claim_url).await?;

    Ok(Json(DrillStartResponse {
        vault_id: id,
        started_at: now,
        heir_notified,
        claim_url,
    }))
}

/// Queue the practice invitation on the heir's contact channel. Returns
/// whether a delivery was actually queued; a missing or undeliverable
/// contact is not an error (the owner sees `heir_notified: false` and
/// can share the link themselves).
async fn enqueue_drill_invite(
    state: &AppState,
    vault_id: &str,
    heir_ct: Option<String>,
    heir_nn: Option<String>,
    claim_url: &str,
) -> Result<bool, ApiError> {
    let Some(contact) =
        notifier::parse_heir_contact(vault_id, heir_ct.as_deref(), heir_nn.as_deref())?
    else {
        return Ok(false);
    };
    let channel = match contact.channel.as_deref() {
        Some("email") => Channel::Email,
        Some("sms") => Channel::Sms,
        Some("whatsapp") => Channel::Whatsapp,
        _ => return Ok(false),
    };
    let Some(recipient) = contact.contact.as_deref().filter(|c| !c.is_empty()) else {
        return Ok(false);
    };
    // Don't queue into a black hole (#278): if this deployment can't
    // deliver on the heir's channel, say so instead of "Practice sent".
    // The practice card already renders the share-it-yourself path for
    // `heir_notified: false`.
    if !notifier::channel_deliverable(channel) {
        return Ok(false);
    }

    let heir_name = contact.name.as_deref().unwrap_or("there");
    let intro = crate::scheduler::load_heir_intro(state, vault_id).await;
    let from_name = intro
        .as_ref()
        .and_then(|i| i.from_name.as_deref())
        .map(str::trim)
        .filter(|s| !s.is_empty());

    // The real claim contact opens with "that has happened". A practice
    // message must never read like that — the first line says the owner
    // is fine, then explains why this is worth five minutes.
    let opener = match from_name {
        Some(n) => format!("{n} is fine, and nothing has happened"),
        None => "Nothing has happened".to_string(),
    };
    let who = match from_name {
        Some(n) => n.to_string(),
        None => "someone close to you".to_string(),
    };
    let subject = match from_name {
        Some(n) => format!("{n} asked you to try a practice run"),
        None => "A practice run of something set up for you".to_string(),
    };
    // C2 (#123): SMS/WhatsApp previews show on lock screens, so the
    // short form stays label-shy (no "Bitcoin", no "inheritance"),
    // exactly like the real claim contact.
    let body = match channel {
        Channel::Email => format!(
            "Hello {heir_name},\n\n\
             {opener}. {who} set up a Bitcoin inheritance for you with \
             GhostKey, and asked us to send you this practice run while \
             they are here to help, so the real thing is not the first \
             time you see it.\n\n\
             Open this link on any phone or computer and follow the \
             steps. A practice link cannot move any money.\n\n\
             {claim_url}\n\n\
             When you finish, they will see that the practice worked.\n\n\
             From GhostKey\n"
        ),
        _ => format!(
            "Hello {heir_name}, {opener}. {who} set something up for you \
             through GhostKey and asked you to do a quick practice run \
             while they can help. It cannot move any money:\n\n{claim_url}"
        ),
    };

    notifier::enqueue(
        &state.db,
        vault_id,
        NotificationKind::DrillInvite,
        channel,
        recipient,
        &subject,
        &body,
    )
    .await
    .map_err(|e| match e {
        notifier::EnqueueError::Crypto(c) => ApiError::Crypto(c),
        notifier::EnqueueError::Db(d) => ApiError::Db(d),
    })?;
    Ok(true)
}

/// Resolve a drill token into the claim page's view. Called by
/// `routes::resolve_claim` after the real heir and guardian lookups
/// both miss. Marks the first open (abandonment visibility) but never
/// touches claim-challenge or claim-token state.
pub(crate) async fn resolve_drill_claim(
    state: &AppState,
    token: &str,
) -> Result<Json<ClaimView>, ApiError> {
    let hash = hash_claim_token(token);
    type DrillRow = (
        String,         // id
        Option<String>, // label
        String,         // network
        String,         // status
        i64,            // timelock_blocks
        String,         // next_deadline_at
        Option<String>, // drill_token_hash
        Option<String>, // drill_opened_at
        Option<String>, // heir_contact_ciphertext
        Option<String>, // heir_contact_nonce
        Option<String>, // heir_contact_channel
        String,         // vault_kind
    );
    let row: Option<DrillRow> = sqlx::query_as(
        r#"SELECT id, label, network, status, timelock_blocks,
                  next_deadline_at, drill_token_hash, drill_opened_at,
                  heir_contact_ciphertext, heir_contact_nonce,
                  heir_contact_channel, vault_kind
             FROM vaults
            WHERE drill_token_hash = ?"#,
    )
    .bind(&hash)
    .fetch_optional(&state.db)
    .await?;
    let Some((
        vault_id,
        label,
        network,
        status,
        timelock_blocks,
        next_deadline,
        stored_hash,
        opened_at,
        heir_ct,
        heir_nn,
        heir_channel,
        vault_kind,
    )) = row
    else {
        return Err(ApiError::NotFound);
    };

    // Defence-in-depth, mirroring resolve_claim: constant-time compare
    // against the stored hash even though the index already matched.
    let stored_hash = stored_hash.ok_or(ApiError::NotFound)?;
    if !claim_token_matches(token, &stored_hash) {
        return Err(ApiError::NotFound);
    }

    // First open is a fact the owner cares about ("sent but never
    // opened" vs "opened but never finished"). CAS so refreshes don't
    // spam the activity feed — the claim_opened lesson.
    if opened_at.is_none() {
        let marked = sqlx::query(
            "UPDATE vaults SET drill_opened_at = ? \
              WHERE id = ? AND drill_opened_at IS NULL",
        )
        .bind(Utc::now().to_rfc3339())
        .bind(&vault_id)
        .execute(&state.db)
        .await?;
        if marked.rows_affected() > 0 {
            record_event(&state.db, &vault_id, "drill_opened", None).await?;
        }
    }

    let heir_display_name =
        notifier::parse_heir_contact(&vault_id, heir_ct.as_deref(), heir_nn.as_deref())?
            .and_then(|c| c.name);

    Ok(Json(ClaimView {
        vault_id,
        label,
        network,
        status,
        timelock_blocks,
        next_deadline_at: crate::config::parse_rfc(&next_deadline),
        heir_channel,
        heir_display_name,
        // No safety wait in a rehearsal: the page explains the waits
        // instead of imposing them.
        claim_available_at: None,
        vault_kind,
        token_role: "heir".to_string(),
        guardian_slot: None,
        drill: true,
    }))
}

/// The heir finished the walkthrough. Records the permanent fact and
/// tells the owner. Idempotent: repeat calls return the original
/// completion time.
pub async fn complete_drill(
    State(state): State<Arc<AppState>>,
    Path(token): Path<String>,
) -> Result<Json<DrillCompleteResponse>, ApiError> {
    let hash = hash_claim_token(&token);
    type Row = (
        String,         // id
        Option<String>, // drill_token_hash
        Option<String>, // drill_completed_at
        Option<String>, // heir_contact_ciphertext
        Option<String>, // heir_contact_nonce
        Option<String>, // owner_contact_ciphertext
        Option<String>, // owner_contact_nonce
        Option<String>, // owner_contact_channel
    );
    let row: Option<Row> = sqlx::query_as(
        r#"SELECT id, drill_token_hash, drill_completed_at,
                  heir_contact_ciphertext, heir_contact_nonce,
                  owner_contact_ciphertext, owner_contact_nonce,
                  owner_contact_channel
             FROM vaults
            WHERE drill_token_hash = ?"#,
    )
    .bind(&hash)
    .fetch_optional(&state.db)
    .await?;
    let Some((vault_id, stored_hash, completed_at, heir_ct, heir_nn, own_ct, own_nn, own_ch)) = row
    else {
        return Err(ApiError::NotFound);
    };
    let stored_hash = stored_hash.ok_or(ApiError::NotFound)?;
    if !claim_token_matches(&token, &stored_hash) {
        return Err(ApiError::NotFound);
    }

    if let Some(done) = completed_at.as_deref() {
        return Ok(Json(DrillCompleteResponse {
            completed_at: crate::config::parse_rfc(done),
        }));
    }

    let now = Utc::now();
    let marked = sqlx::query(
        "UPDATE vaults SET drill_completed_at = ? \
          WHERE id = ? AND drill_completed_at IS NULL",
    )
    .bind(now.to_rfc3339())
    .bind(&vault_id)
    .execute(&state.db)
    .await?;
    if marked.rows_affected() > 0 {
        record_event(&state.db, &vault_id, "drill_completed", None).await?;
        notify_owner_drill_completed(&state, &vault_id, heir_ct, heir_nn, own_ct, own_nn, own_ch)
            .await;
    }

    Ok(Json(DrillCompleteResponse { completed_at: now }))
}

/// Best-effort "your heir did it" note to the owner. A delivery
/// failure must not fail the heir's completion — the fact is already
/// recorded on the vault.
async fn notify_owner_drill_completed(
    state: &AppState,
    vault_id: &str,
    heir_ct: Option<String>,
    heir_nn: Option<String>,
    own_ct: Option<String>,
    own_nn: Option<String>,
    own_ch: Option<String>,
) {
    let contact = match notifier::parse_owner_contact(
        vault_id,
        own_ct.as_deref(),
        own_nn.as_deref(),
        own_ch.as_deref(),
    ) {
        Ok(Some(c)) => c,
        Ok(None) => return,
        Err(e) => {
            tracing::warn!(vault_id = %vault_id, error = ?e, "drill-completed owner contact unreadable");
            return;
        }
    };
    let heir_name = notifier::parse_heir_contact(vault_id, heir_ct.as_deref(), heir_nn.as_deref())
        .ok()
        .flatten()
        .and_then(|c| c.name)
        .unwrap_or_else(|| "Your heir".to_string());
    let body = format!(
        "Good news. {heir_name} just finished the practice claim you \
         sent.\n\n\
         Nothing moved and your vault is unchanged. The real claim will \
         look exactly like what they walked through today.\n\n\
         From GhostKey\n"
    );
    if let Err(e) = notifier::enqueue(
        &state.db,
        vault_id,
        NotificationKind::DrillCompleted,
        contact.channel,
        &contact.address,
        &format!("{heir_name} completed the practice claim"),
        &body,
    )
    .await
    {
        tracing::warn!(vault_id = %vault_id, error = ?e, "drill-completed owner notice enqueue failed");
    }
}

#[cfg(test)]
mod http_tests {
    use axum::body::Body;
    use axum::http::{header, Request, StatusCode};
    use base64::Engine as _;
    use serde_json::Value;
    use sqlx::sqlite::SqlitePoolOptions;
    use sqlx::SqlitePool;
    use tower::ServiceExt;

    use crate::crypto::ensure_master_key_loaded;
    use crate::routes;

    async fn fresh_state() -> std::sync::Arc<crate::AppState> {
        if std::env::var("GHOSTKEY_MASTER_KEY").is_err() {
            let zeros = [0u8; 32];
            let b64 = base64::engine::general_purpose::STANDARD_NO_PAD.encode(zeros);
            // SAFETY: tests are single-process; the value is fixed.
            unsafe {
                std::env::set_var("GHOSTKEY_MASTER_KEY", &b64);
            }
        }
        let _ = ensure_master_key_loaded();
        unsafe { std::env::remove_var("GHOSTKEY_AUTH_DISABLED") };
        // The drill tests use an email heir and assert the invite was
        // queued (`heir_notified: true`). Since the drill now consults
        // channel capability (#278), email must look deliverable here —
        // which mirrors production, where SMTP is configured. Set it
        // under the shared SMTP env lock so we don't race the
        // SMTP-config unit test that asserts SMTP is unset.
        {
            let _g = crate::notifier::SMTP_ENV_LOCK.lock().unwrap();
            if std::env::var("SMTP_HOST").is_err() {
                // SAFETY: single-process tests; the lock serialises access.
                unsafe {
                    std::env::set_var("SMTP_HOST", "localhost");
                }
            }
        }

        let pool: SqlitePool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("connect sqlite::memory");
        sqlx::migrate!("./migrations")
            .run(&pool)
            .await
            .expect("run migrations");
        std::sync::Arc::new(crate::AppState {
            db: pool,
            lightning: std::sync::Arc::new(crate::lightning::NoopProvider),
        })
    }

    /// A vault with an owner token and a sealed heir email contact —
    /// the shape the password-setup wizard writes, which is what the
    /// drill invite needs to find a recipient.
    async fn insert_vault_with_heir(
        pool: &SqlitePool,
        id: &str,
        owner_token_hash: &str,
        status: &str,
    ) {
        let contact = crate::crypto::seal_for_vault(
            id,
            br#"{"name":"Fola","contact":"heir@example.com","channel":"email"}"#,
        )
        .expect("seal heir contact");
        sqlx::query(
            r#"INSERT INTO vaults (
                id, network,
                descriptor_external, descriptor_internal,
                timelock_blocks,
                checkin_period_secs, grace_period_secs,
                created_at, next_deadline_at, status,
                claim_eligible_at,
                owner_token_hash,
                heir_contact_ciphertext, heir_contact_nonce,
                heir_contact_channel
            ) VALUES (?, 'regtest', ?, ?, 144, 86400, 3600,
                      '2026-01-01T00:00:00Z',
                      '2099-01-01T00:00:00Z', ?,
                      '2099-01-02T00:00:00Z',
                      ?, ?, ?, 'email')"#,
        )
        .bind(id)
        .bind(format!("tr(fake/{id}/0/*)"))
        .bind(format!("tr(fake/{id}/1/*)"))
        .bind(status)
        .bind(owner_token_hash)
        .bind(&contact.ciphertext_b64)
        .bind(&contact.nonce_b64)
        .execute(pool)
        .await
        .expect("insert vault");
    }

    fn post(uri: &str, bearer: Option<&str>, body: Option<Value>) -> Request<Body> {
        let b = Request::builder()
            .method("POST")
            .uri(uri)
            .header(header::CONTENT_TYPE, "application/json");
        let b = match bearer {
            Some(t) => b.header(header::AUTHORIZATION, format!("Bearer {t}")),
            None => b,
        };
        let body = match body {
            Some(v) => Body::from(v.to_string()),
            None => Body::empty(),
        };
        b.body(body).expect("request")
    }

    fn get(uri: &str) -> Request<Body> {
        Request::builder()
            .method("GET")
            .uri(uri)
            .body(Body::empty())
            .expect("request")
    }

    async fn body_json(resp: axum::response::Response) -> Value {
        let bytes = axum::body::to_bytes(resp.into_body(), 1024 * 1024)
            .await
            .expect("body");
        serde_json::from_slice(&bytes).expect("json")
    }

    /// Start a drill over HTTP and hand back the raw practice token.
    async fn start_drill(state: &std::sync::Arc<crate::AppState>, id: &str, owner: &str) -> String {
        let resp = routes::router(state.clone())
            .oneshot(post(&format!("/vaults/{id}/drill"), Some(owner), None))
            .await
            .expect("response");
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        assert_eq!(v["heir_notified"], true);
        let url = v["claim_url"].as_str().expect("claim_url");
        url.rsplit('/').next().expect("token").to_string()
    }

    async fn event_count(pool: &SqlitePool, vault_id: &str, kind: &str) -> i64 {
        sqlx::query_scalar("SELECT COUNT(*) FROM events WHERE vault_id = ? AND kind = ?")
            .bind(vault_id)
            .bind(kind)
            .fetch_one(pool)
            .await
            .expect("count events")
    }

    #[tokio::test]
    async fn start_drill_requires_owner_auth() {
        let state = fresh_state().await;
        let issued = crate::crypto::issue_owner_token();
        insert_vault_with_heir(&state.db, "vault-dr-a", &issued.hash_hex, "ok").await;

        let resp = routes::router(state)
            .oneshot(post("/vaults/vault-dr-a/drill", None, None))
            .await
            .expect("response");
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn start_drill_mints_token_and_leaves_real_state_alone() {
        let state = fresh_state().await;
        let issued = crate::crypto::issue_owner_token();
        insert_vault_with_heir(&state.db, "vault-dr-b", &issued.hash_hex, "ok").await;
        // A real claim token already on file must survive the drill.
        sqlx::query("UPDATE vaults SET claim_token_hash = 'real-hash' WHERE id = 'vault-dr-b'")
            .execute(&state.db)
            .await
            .unwrap();

        let _token = start_drill(&state, "vault-dr-b", &issued.token).await;

        let (status, claim_hash, deadline, drill_hash): (
            String,
            Option<String>,
            String,
            Option<String>,
        ) = sqlx::query_as(
            "SELECT status, claim_token_hash, next_deadline_at, drill_token_hash \
               FROM vaults WHERE id = 'vault-dr-b'",
        )
        .fetch_one(&state.db)
        .await
        .unwrap();
        assert_eq!(status, "ok");
        assert_eq!(claim_hash.as_deref(), Some("real-hash"));
        assert_eq!(deadline, "2099-01-01T00:00:00Z");
        assert!(drill_hash.is_some());
        assert_eq!(
            event_count(&state.db, "vault-dr-b", "drill_started").await,
            1
        );

        let invites: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM notifications WHERE vault_id = 'vault-dr-b' AND kind = 'drill_invite'",
        )
        .fetch_one(&state.db)
        .await
        .unwrap();
        assert_eq!(invites, 1);
    }

    #[tokio::test]
    async fn drill_token_resolves_as_drill_without_starting_a_claim() {
        let state = fresh_state().await;
        let issued = crate::crypto::issue_owner_token();
        insert_vault_with_heir(&state.db, "vault-dr-c", &issued.hash_hex, "ok").await;
        let token = start_drill(&state, "vault-dr-c", &issued.token).await;

        let resp = routes::router(state.clone())
            .oneshot(get(&format!("/claim/{token}")))
            .await
            .expect("response");
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        assert_eq!(v["drill"], true);
        assert_eq!(v["token_role"], "heir");
        assert_eq!(v["heir_display_name"], "Fola");

        // The rehearsal must not start the real claim machinery.
        let (opened, drill_opened): (Option<String>, Option<String>) = sqlx::query_as(
            "SELECT claim_opened_at, drill_opened_at FROM vaults WHERE id = 'vault-dr-c'",
        )
        .fetch_one(&state.db)
        .await
        .unwrap();
        assert!(opened.is_none(), "drill must not open a claim challenge");
        assert!(drill_opened.is_some(), "first open must be recorded");

        // Refreshing the page doesn't spam the activity feed.
        let _ = routes::router(state.clone())
            .oneshot(get(&format!("/claim/{token}")))
            .await
            .expect("response");
        assert_eq!(
            event_count(&state.db, "vault-dr-c", "drill_opened").await,
            1
        );
    }

    #[tokio::test]
    async fn drill_token_cannot_reach_key_material_or_broadcast() {
        let state = fresh_state().await;
        let issued = crate::crypto::issue_owner_token();
        insert_vault_with_heir(
            &state.db,
            "vault-dr-d",
            &issued.hash_hex,
            "timelock_started",
        )
        .await;
        let token = start_drill(&state, "vault-dr-d", &issued.token).await;

        // Every endpoint that could reveal keys or move coins resolves
        // by claim_token_hash, so the drill token must 404 on all of
        // them — refusal by construction.
        let gets = [
            format!("/claim/{token}/sealed-heir"),
            format!("/claim/{token}/heir-derivation-params"),
            format!("/claim/{token}/sealed-guardian"),
            format!("/claim/{token}/video"),
            format!("/claim/{token}/unlock-estimate"),
        ];
        for uri in gets {
            let resp = routes::router(state.clone())
                .oneshot(get(&uri))
                .await
                .expect("response");
            assert_eq!(resp.status(), StatusCode::NOT_FOUND, "GET {uri}");
        }

        let posts = [
            (
                format!("/claim/{token}/build-psbt"),
                serde_json::json!({"destination": "bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080"}),
            ),
            (
                format!("/claim/{token}/broadcast"),
                serde_json::json!({"signed_psbt_b64": "AAAA"}),
            ),
            (
                format!("/claim/{token}/heir-claim"),
                serde_json::json!({
                    "destination": "bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080",
                    "heir_xprv": "tprv-fake"
                }),
            ),
        ];
        for (uri, body) in posts {
            let resp = routes::router(state.clone())
                .oneshot(post(&uri, None, Some(body)))
                .await
                .expect("response");
            assert_eq!(resp.status(), StatusCode::NOT_FOUND, "POST {uri}");
        }
    }

    #[tokio::test]
    async fn drill_complete_records_the_fact_once() {
        let state = fresh_state().await;
        let issued = crate::crypto::issue_owner_token();
        insert_vault_with_heir(&state.db, "vault-dr-e", &issued.hash_hex, "ok").await;
        let token = start_drill(&state, "vault-dr-e", &issued.token).await;

        let resp = routes::router(state.clone())
            .oneshot(post(&format!("/claim/{token}/drill-complete"), None, None))
            .await
            .expect("response");
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        let first = v["completed_at"]
            .as_str()
            .expect("completed_at")
            .to_string();

        // Idempotent: a second tap returns the original completion time
        // and records nothing new.
        let resp = routes::router(state.clone())
            .oneshot(post(&format!("/claim/{token}/drill-complete"), None, None))
            .await
            .expect("response");
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        assert_eq!(v["completed_at"].as_str().unwrap(), first);
        assert_eq!(
            event_count(&state.db, "vault-dr-e", "drill_completed").await,
            1
        );

        // Vault untouched apart from the drill columns.
        let (status, used): (String, Option<String>) = sqlx::query_as(
            "SELECT status, claim_token_used_at FROM vaults WHERE id = 'vault-dr-e'",
        )
        .fetch_one(&state.db)
        .await
        .unwrap();
        assert_eq!(status, "ok");
        assert!(used.is_none());
    }

    #[tokio::test]
    async fn start_drill_refuses_mid_claim() {
        let state = fresh_state().await;
        let issued = crate::crypto::issue_owner_token();
        insert_vault_with_heir(&state.db, "vault-dr-f", &issued.hash_hex, "claiming").await;

        let resp = routes::router(state)
            .oneshot(post("/vaults/vault-dr-f/drill", Some(&issued.token), None))
            .await
            .expect("response");
        assert_eq!(resp.status(), StatusCode::CONFLICT);
    }

    #[tokio::test]
    async fn unknown_drill_token_is_404() {
        let state = fresh_state().await;
        let resp = routes::router(state)
            .oneshot(post("/claim/not-a-real-token/drill-complete", None, None))
            .await
            .expect("response");
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }
}
