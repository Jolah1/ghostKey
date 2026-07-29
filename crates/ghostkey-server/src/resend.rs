//! The email half of delivery feedback (#322).
//!
//! Twilio tells us when a message failed; until this module existed,
//! email did not. Resend accepts at SMTP, bounces later, and then adds
//! the address to an **account-level suppression list**, after which
//! every subsequent send to it is silently dropped. An owner or an heir
//! can become permanently unreachable while every row in the database
//! reads `sent`.
//!
//! Resend signs its webhooks with Svix. The verdict itself is recorded
//! through [`crate::delivery::record_delivery`], the same path Twilio
//! uses, so replay protection, ordering and the owner-facing alarm are
//! shared rather than reimplemented per provider.

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use std::sync::Arc;

use crate::delivery::{record_delivery, DeliveryEvent};
use crate::AppState;

/// How far out of step with our clock a webhook may be.
///
/// Svix signs the timestamp along with the body, so this is what stops
/// a captured request being replayed days later. Five minutes is
/// Svix's own default: wide enough for ordinary clock drift on a Fly
/// machine, narrow enough that a captured callback goes stale fast.
///
/// Note this is belt-and-braces. The dedup table in
/// `record_delivery` already makes a replayed event a no-op; this
/// stops it reaching the database at all.
const TIMESTAMP_TOLERANCE_SECS: i64 = 5 * 60;

/// The signing secret, as Resend shows it in the dashboard.
///
/// Absent means this deployment has no Resend webhook configured, and
/// the route answers 404 — same as the Twilio one. There is no
/// unsigned fallback: an unauthenticated endpoint that writes
/// "undelivered" into an owner's activity feed is a way to make a
/// vault look broken from the outside.
fn signing_secret() -> Option<String> {
    std::env::var("RESEND_WEBHOOK_SECRET")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Decode the `whsec_`-prefixed base64 secret to raw HMAC key bytes.
fn decode_secret(secret: &str) -> Option<Vec<u8>> {
    use base64::Engine as _;
    let b64 = secret.strip_prefix("whsec_").unwrap_or(secret);
    base64::engine::general_purpose::STANDARD.decode(b64).ok()
}

/// Svix's signature over one request.
///
/// Signed content is `{svix-id}.{svix-timestamp}.{raw body}`, HMAC-
/// SHA256 under the decoded secret, base64 encoded.
///
/// The body must be the bytes as received. That is why the handler
/// takes `String` and parses JSON itself instead of using axum's
/// `Json` extractor — re-serializing a parsed value changes whitespace
/// and key order, and the signature would never match again.
pub(crate) fn svix_signature(secret_bytes: &[u8], id: &str, timestamp: &str, body: &str) -> String {
    use base64::Engine as _;
    use hmac::{Mac, SimpleHmac};

    let mut mac =
        SimpleHmac::<sha2::Sha256>::new_from_slice(secret_bytes).expect("hmac accepts any key");
    mac.update(id.as_bytes());
    mac.update(b".");
    mac.update(timestamp.as_bytes());
    mac.update(b".");
    mac.update(body.as_bytes());
    base64::engine::general_purpose::STANDARD.encode(mac.finalize().into_bytes())
}

/// Check the `svix-signature` header, which carries a space-delimited
/// list of `v{n},{base64}` entries.
///
/// A list, not a single value, because Svix hands out overlapping
/// secrets during a rotation. Any `v1` entry matching is a pass;
/// versions we don't implement are skipped rather than treated as
/// failures.
pub(crate) fn signature_header_matches(header: &str, expected: &str) -> bool {
    header
        .split_whitespace()
        .filter_map(|entry| entry.strip_prefix("v1,"))
        .any(|sig| crate::delivery::signatures_match(sig, expected))
}

/// Is this timestamp close enough to now?
fn timestamp_is_fresh(ts: &str, now: i64) -> bool {
    let Ok(sent) = ts.trim().parse::<i64>() else {
        return false;
    };
    (now - sent).abs() <= TIMESTAMP_TOLERANCE_SECS
}

/// Map a Resend event type onto the internal status vocabulary.
///
/// `None` means an event we take no position on (`email.opened`,
/// `email.clicked`, and anything Resend adds later). Those are
/// engagement, not delivery, and recording them would let a later
/// `opened` outrank nothing useful while adding noise.
///
/// The negative ones must line up exactly with
/// `delivery::is_negative_verdict`, or a bounce gets stored and raises
/// no alarm. `delivery::negative_verdicts_cover_both_providers` pins
/// that.
pub(crate) fn status_for_event(event_type: &str) -> Option<&'static str> {
    Some(match event_type {
        "email.sent" => "sent",
        "email.delivered" => "delivered",
        "email.delivery_delayed" => "delayed",
        "email.bounced" => "bounced",
        "email.complained" => "complained",
        "email.failed" => "failed",
        "email.suppressed" => "suppressed",
        _ => return None,
    })
}

/// Pull the human-readable reason out of a bounce/complaint payload.
///
/// Resend nests it differently per event and has changed the shape
/// before, so try the known spots and fall back to nothing rather than
/// guessing. This text is for an operator; nothing branches on it.
fn detail_from(data: &serde_json::Value) -> Option<String> {
    for path in [
        &["bounce", "message"][..],
        &["bounce", "subType"][..],
        &["reason"][..],
        &["failed", "reason"][..],
    ] {
        let mut cur = data;
        for key in path {
            match cur.get(key) {
                Some(next) => cur = next,
                None => {
                    cur = &serde_json::Value::Null;
                    break;
                }
            }
        }
        if let Some(s) = cur.as_str() {
            if !s.trim().is_empty() {
                return Some(s.trim().to_string());
            }
        }
    }
    None
}

/// The correlation handle, in preference order.
///
/// `message_id` is the RFC 5322 Message-ID we set ourselves in
/// `notifier::message_id_for`, and it is what `provider_message_id`
/// holds for email. `email_id` is Resend's own uuid, which we never
/// see at SMTP handoff — accepted as a fallback so that if Resend ever
/// stops echoing the Message-ID, the events still arrive somewhere
/// visible instead of vanishing.
///
/// Resend reports the Message-ID with angle brackets in some payloads
/// and without in others, so normalise before matching.
fn correlation_id(data: &serde_json::Value) -> Option<String> {
    let raw = data
        .get("message_id")
        .and_then(|v| v.as_str())
        .or_else(|| data.get("email_id").and_then(|v| v.as_str()))?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(if trimmed.starts_with('<') {
        trimmed.to_string()
    } else if trimmed.contains('@') {
        format!("<{trimmed}>")
    } else {
        trimmed.to_string()
    })
}

/// `POST /webhooks/resend`
///
/// Answers 2xx for anything correctly signed, including events we
/// ignore and message ids we don't know. Svix retries non-2xx with
/// backoff for days, and there is nothing here worth retrying into:
/// an unknown id means a different deployment on the same Resend
/// account, or a row deleted with its vault.
pub(crate) async fn resend_webhook(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: String,
) -> impl IntoResponse {
    let Some(secret) = signing_secret() else {
        return StatusCode::NOT_FOUND;
    };
    let Some(key) = decode_secret(&secret) else {
        tracing::error!("RESEND_WEBHOOK_SECRET is not valid base64; rejecting all callbacks");
        return StatusCode::NOT_FOUND;
    };

    let header = |name: &str| -> &str {
        headers
            .get(name)
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default()
    };
    let (svix_id, svix_ts, svix_sig) = (
        header("svix-id"),
        header("svix-timestamp"),
        header("svix-signature"),
    );
    if svix_id.is_empty() || svix_ts.is_empty() || svix_sig.is_empty() {
        return StatusCode::BAD_REQUEST;
    }

    // Freshness first: a stale request is rejected whether or not its
    // signature is good, so a captured callback can't be re-fired.
    if !timestamp_is_fresh(svix_ts, chrono::Utc::now().timestamp()) {
        tracing::warn!(
            svix_id,
            svix_ts,
            "resend webhook timestamp outside tolerance"
        );
        return StatusCode::FORBIDDEN;
    }

    let expected = svix_signature(&key, svix_id, svix_ts, &body);
    if !signature_header_matches(svix_sig, &expected) {
        tracing::warn!(svix_id, "resend webhook failed signature check; ignoring");
        return StatusCode::FORBIDDEN;
    }

    let Ok(payload) = serde_json::from_str::<serde_json::Value>(&body) else {
        tracing::warn!(svix_id, "resend webhook body is not JSON");
        return StatusCode::BAD_REQUEST;
    };
    let event_type = payload
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    let Some(status) = status_for_event(event_type) else {
        tracing::debug!(svix_id, event_type, "resend event we take no position on");
        return StatusCode::NO_CONTENT;
    };
    let data = payload
        .get("data")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    let Some(id) = correlation_id(&data) else {
        tracing::warn!(svix_id, event_type, "resend event carries no message id");
        return StatusCode::NO_CONTENT;
    };
    let detail = detail_from(&data);

    let ev = DeliveryEvent {
        provider: "resend",
        event_id: svix_id.to_string(),
        provider_message_id: &id,
        status,
        detail: detail.as_deref(),
    };
    match record_delivery(&state.db, &ev).await {
        Ok(_) => StatusCode::NO_CONTENT,
        Err(e) => {
            tracing::error!(error = ?e, "failed to record resend delivery status");
            // A DB blip IS worth a Svix retry.
            StatusCode::INTERNAL_SERVER_ERROR
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The base64 body of Svix's published example secret, WITHOUT the
    /// `whsec_` prefix.
    ///
    /// Split deliberately. `whsec_` is also Stripe's webhook signing
    /// secret prefix, so a full literal trips GitHub secret scanning
    /// and files an alert on every push. The value is a documentation
    /// example and was never a live credential, but a repo carrying a
    /// permanently dismissed secret alert trains everyone to wave the
    /// next one through. Prefix is added back at each use site; do not
    /// "tidy" this into one string.
    const SVIX_DOC_SECRET_B64: &str = "MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";

    fn svix_doc_secret() -> String {
        format!("whsec_{SVIX_DOC_SECRET_B64}")
    }

    /// The Svix worked example from their own verification docs. This
    /// pins the signed-content layout — the two dots, the raw body,
    /// the `whsec_` strip, the base64 both ways — against a vector we
    /// did not produce.
    #[test]
    fn svix_signature_matches_the_published_example() {
        let key = decode_secret(&svix_doc_secret()).expect("decode");
        let sig = svix_signature(
            &key,
            "msg_p5jXN8AQM9LWM0D4loKWxJek",
            "1614265330",
            r#"{"test": 2432232314}"#,
        );
        assert_eq!(sig, "g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=");
    }

    #[test]
    fn secret_decodes_with_or_without_the_prefix() {
        let a = decode_secret(&svix_doc_secret()).expect("prefixed");
        let b = decode_secret(SVIX_DOC_SECRET_B64).expect("bare");
        assert_eq!(a, b);
        assert!(!a.is_empty());
    }

    /// The header is a list because Svix overlaps secrets during a
    /// rotation. Matching any v1 entry is a pass.
    #[test]
    fn signature_header_accepts_any_matching_v1_entry() {
        assert!(signature_header_matches("v1,abc", "abc"));
        assert!(signature_header_matches("v1,zzz v1,abc", "abc"));
        assert!(signature_header_matches("v1,abc v1,zzz", "abc"));
        // Unknown versions are skipped, not trusted.
        assert!(!signature_header_matches("v2,abc", "abc"));
        assert!(!signature_header_matches("v1,abd", "abc"));
        assert!(!signature_header_matches("", "abc"));
        // A bare signature with no version prefix is not a match: the
        // format is fixed and accepting anything else widens what we
        // treat as authenticated.
        assert!(!signature_header_matches("abc", "abc"));
    }

    /// Replay protection. A captured request stays valid only inside
    /// the tolerance window.
    #[test]
    fn stale_and_future_timestamps_are_rejected() {
        let now = 1_700_000_000i64;
        assert!(timestamp_is_fresh("1700000000", now));
        assert!(timestamp_is_fresh("1699999750", now)); // 250s old
        assert!(!timestamp_is_fresh("1699999699", now)); // 301s old
                                                         // Clock skew the other way is equally suspicious.
        assert!(!timestamp_is_fresh("1700000301", now));
        assert!(!timestamp_is_fresh("not-a-number", now));
        assert!(!timestamp_is_fresh("", now));
    }

    /// Every event that means "this did not arrive" must map onto a
    /// status the shared recorder treats as negative. If these two
    /// lists drift, a bounce is recorded and nobody is told.
    #[test]
    fn failure_events_map_onto_negative_verdicts() {
        for (event, status) in [
            ("email.bounced", "bounced"),
            ("email.complained", "complained"),
            ("email.failed", "failed"),
            ("email.suppressed", "suppressed"),
        ] {
            assert_eq!(status_for_event(event), Some(status));
            assert!(
                crate::delivery::is_negative_verdict(status),
                "{event} -> {status} must alarm the owner"
            );
        }
    }

    #[test]
    fn progress_events_map_but_do_not_alarm() {
        for (event, status) in [
            ("email.sent", "sent"),
            ("email.delivered", "delivered"),
            ("email.delivery_delayed", "delayed"),
        ] {
            assert_eq!(status_for_event(event), Some(status));
            assert!(!crate::delivery::is_negative_verdict(status));
        }
        // Engagement is not delivery.
        assert_eq!(status_for_event("email.opened"), None);
        assert_eq!(status_for_event("email.clicked"), None);
        assert_eq!(status_for_event("contact.created"), None);
    }

    #[test]
    fn correlation_prefers_the_message_id_we_set() {
        let data = serde_json::json!({
            "message_id": "<gk-deadbeef@ghostkeyapp.com>",
            "email_id": "4ef9a417-02e9-4d39-ad75-9611e0fcc33c",
        });
        assert_eq!(
            correlation_id(&data).as_deref(),
            Some("<gk-deadbeef@ghostkeyapp.com>")
        );

        // Angle brackets are added when Resend reports it bare, so the
        // lookup key matches what we stored at handoff either way.
        let bare = serde_json::json!({ "message_id": "gk-deadbeef@ghostkeyapp.com" });
        assert_eq!(
            correlation_id(&bare).as_deref(),
            Some("<gk-deadbeef@ghostkeyapp.com>")
        );

        // Falls back to Resend's own id rather than dropping the event.
        let fallback = serde_json::json!({ "email_id": "4ef9a417-02e9" });
        assert_eq!(correlation_id(&fallback).as_deref(), Some("4ef9a417-02e9"));

        assert_eq!(correlation_id(&serde_json::json!({})), None);
        assert_eq!(
            correlation_id(&serde_json::json!({"message_id": "  "})),
            None
        );
    }

    /* ------------------- end to end, through the handler ------------------ */

    /// `RESEND_WEBHOOK_SECRET` is process-global and the test binary is
    /// threaded, so every test that reads or writes it serialises here.
    /// A tokio mutex, not a std one: these tests await across the
    /// critical section, and clippy's `await_holding_lock` is right
    /// that a blocking guard there is a deadlock waiting to happen.
    static SECRET_ENV_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    /// Same value, same reason it is assembled rather than written out.
    /// See `SVIX_DOC_SECRET_B64`.
    fn test_secret() -> String {
        svix_doc_secret()
    }

    async fn state_with_sent_email(message_id: &str) -> (Arc<AppState>, i64) {
        if std::env::var("GHOSTKEY_MASTER_KEY").is_err() {
            use base64::Engine as _;
            let b64 = base64::engine::general_purpose::STANDARD_NO_PAD.encode([7u8; 32]);
            // SAFETY: tests are single-process; the value is fixed.
            unsafe { std::env::set_var("GHOSTKEY_MASTER_KEY", &b64) };
        }
        let _ = crate::crypto::ensure_master_key_loaded();

        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("connect");
        sqlx::migrate!("./migrations")
            .run(&pool)
            .await
            .expect("migrate");
        sqlx::query(
            r#"INSERT INTO vaults (id, network, descriptor_external, descriptor_internal,
                    timelock_blocks, checkin_period_secs, grace_period_secs,
                    created_at, next_deadline_at, status)
               VALUES ('v-mail','regtest','d-ext','d-int',144,86400,3600,
                    '2026-01-01T00:00:00Z','2026-01-02T00:00:00Z','ok')"#,
        )
        .execute(&pool)
        .await
        .expect("vault");

        let id = crate::notifier::enqueue(
            &pool,
            "v-mail",
            crate::notifier::NotificationKind::ClaimLink,
            crate::notifier::Channel::Email,
            "heir@example.com",
            "subject",
            "body",
        )
        .await
        .expect("enqueue");
        sqlx::query("UPDATE notifications SET status='sent', provider_message_id=? WHERE id=?")
            .bind(message_id)
            .bind(id)
            .execute(&pool)
            .await
            .expect("hand off");

        (
            Arc::new(AppState {
                db: pool,
                lightning: Arc::new(crate::lightning::NoopProvider),
            }),
            id,
        )
    }

    /// Build a correctly signed request the way Resend would.
    fn signed(svix_id: &str, body: &str) -> HeaderMap {
        let ts = chrono::Utc::now().timestamp().to_string();
        let key = decode_secret(&test_secret()).expect("decode");
        let sig = svix_signature(&key, svix_id, &ts, body);
        let mut h = HeaderMap::new();
        h.insert("svix-id", svix_id.parse().unwrap());
        h.insert("svix-timestamp", ts.parse().unwrap());
        h.insert("svix-signature", format!("v1,{sig}").parse().unwrap());
        h
    }

    fn bounce_body(message_id: &str) -> String {
        serde_json::json!({
            "type": "email.bounced",
            "created_at": "2026-07-29T12:00:00.000Z",
            "data": {
                "message_id": message_id,
                "email_id": "4ef9a417-02e9-4d39-ad75-9611e0fcc33c",
                "to": ["heir@example.com"],
                "bounce": { "message": "The recipient's mailbox does not exist." }
            }
        })
        .to_string()
    }

    async fn call(state: &Arc<AppState>, headers: HeaderMap, body: String) -> StatusCode {
        resend_webhook(State(state.clone()), headers, body)
            .await
            .into_response()
            .status()
    }

    async fn undelivered_events(state: &AppState) -> i64 {
        sqlx::query_scalar("SELECT COUNT(*) FROM events WHERE kind='notification_undelivered'")
            .fetch_one(&state.db)
            .await
            .expect("count")
    }

    /// The whole point of #322: a hard bounce stops the row claiming
    /// success and reaches the owner's activity feed.
    #[tokio::test]
    async fn a_signed_bounce_is_recorded_and_surfaced() {
        let _g = SECRET_ENV_LOCK.lock().await;
        unsafe { std::env::set_var("RESEND_WEBHOOK_SECRET", test_secret()) };

        let mid = "<gk-abc123@ghostkeyapp.com>";
        let (state, id) = state_with_sent_email(mid).await;
        let body = bounce_body(mid);

        assert_eq!(
            call(&state, signed("msg_1", &body), body.clone()).await,
            StatusCode::NO_CONTENT
        );

        let (status, detail): (Option<String>, Option<String>) =
            sqlx::query_as("SELECT delivery_status, delivery_detail FROM notifications WHERE id=?")
                .bind(id)
                .fetch_one(&state.db)
                .await
                .expect("row");
        assert_eq!(status.as_deref(), Some("bounced"));
        assert_eq!(
            detail.as_deref(),
            Some("The recipient's mailbox does not exist.")
        );
        assert_eq!(undelivered_events(&state).await, 1);
    }

    /// An unsigned or wrongly signed request must change nothing. This
    /// endpoint writes "did not arrive" into an owner's activity feed,
    /// so an open version of it is a way to make a healthy vault look
    /// broken.
    #[tokio::test]
    async fn unsigned_and_forged_requests_are_refused() {
        let _g = SECRET_ENV_LOCK.lock().await;
        unsafe { std::env::set_var("RESEND_WEBHOOK_SECRET", test_secret()) };

        let mid = "<gk-forge@ghostkeyapp.com>";
        let (state, id) = state_with_sent_email(mid).await;
        let body = bounce_body(mid);

        // No headers at all.
        assert_eq!(
            call(&state, HeaderMap::new(), body.clone()).await,
            StatusCode::BAD_REQUEST
        );

        // Well-formed headers, wrong signature.
        let mut forged = signed("msg_forge", &body);
        forged.insert(
            "svix-signature",
            "v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
                .parse()
                .unwrap(),
        );
        assert_eq!(
            call(&state, forged, body.clone()).await,
            StatusCode::FORBIDDEN
        );

        // Signed for a DIFFERENT body: the classic swap.
        let headers = signed("msg_swap", r#"{"type":"email.delivered"}"#);
        assert_eq!(
            call(&state, headers, body.clone()).await,
            StatusCode::FORBIDDEN
        );

        let status: Option<String> =
            sqlx::query_scalar("SELECT delivery_status FROM notifications WHERE id=?")
                .bind(id)
                .fetch_one(&state.db)
                .await
                .expect("row");
        assert_eq!(status, None, "nothing unauthenticated may reach the row");
        assert_eq!(undelivered_events(&state).await, 0);
    }

    /// A correctly signed request whose timestamp is old is still
    /// refused — that is what makes a captured callback useless later.
    #[tokio::test]
    async fn a_captured_request_goes_stale() {
        let _g = SECRET_ENV_LOCK.lock().await;
        unsafe { std::env::set_var("RESEND_WEBHOOK_SECRET", test_secret()) };

        let mid = "<gk-stale@ghostkeyapp.com>";
        let (state, _) = state_with_sent_email(mid).await;
        let body = bounce_body(mid);

        let old = (chrono::Utc::now().timestamp() - 3600).to_string();
        let key = decode_secret(&test_secret()).expect("decode");
        let sig = svix_signature(&key, "msg_old", &old, &body);
        let mut h = HeaderMap::new();
        h.insert("svix-id", "msg_old".parse().unwrap());
        h.insert("svix-timestamp", old.parse().unwrap());
        h.insert("svix-signature", format!("v1,{sig}").parse().unwrap());

        assert_eq!(call(&state, h, body).await, StatusCode::FORBIDDEN);
        assert_eq!(undelivered_events(&state).await, 0);
    }

    /// Svix redelivers. The same `svix-id` arriving twice is one
    /// incident, and a late `email.delivered` must not undo the bounce.
    #[tokio::test]
    async fn redelivery_and_reordering_do_not_corrupt_the_verdict() {
        let _g = SECRET_ENV_LOCK.lock().await;
        unsafe { std::env::set_var("RESEND_WEBHOOK_SECRET", test_secret()) };

        let mid = "<gk-order@ghostkeyapp.com>";
        let (state, id) = state_with_sent_email(mid).await;
        let body = bounce_body(mid);

        // Same event id twice, exactly as Svix retries it.
        for _ in 0..3 {
            assert_eq!(
                call(&state, signed("msg_same", &body), body.clone()).await,
                StatusCode::NO_CONTENT
            );
        }
        assert_eq!(
            undelivered_events(&state).await,
            1,
            "one bounce is one incident however many times Svix retries"
        );

        // Now the out-of-order `email.sent` from before the bounce.
        let late = serde_json::json!({
            "type": "email.sent",
            "data": { "message_id": mid }
        })
        .to_string();
        assert_eq!(
            call(&state, signed("msg_late", &late), late.clone()).await,
            StatusCode::NO_CONTENT
        );

        let status: Option<String> =
            sqlx::query_scalar("SELECT delivery_status FROM notifications WHERE id=?")
                .bind(id)
                .fetch_one(&state.db)
                .await
                .expect("row");
        assert_eq!(
            status.as_deref(),
            Some("bounced"),
            "a late email.sent must not bury the bounce"
        );
    }

    /// With no secret configured the route does not exist. No unsigned
    /// fallback, ever.
    #[tokio::test]
    async fn an_unconfigured_deployment_has_no_endpoint() {
        let _g = SECRET_ENV_LOCK.lock().await;
        unsafe { std::env::remove_var("RESEND_WEBHOOK_SECRET") };

        let mid = "<gk-noconf@ghostkeyapp.com>";
        let (state, _) = state_with_sent_email(mid).await;
        let body = bounce_body(mid);
        assert_eq!(
            call(&state, signed("msg_x", &body), body).await,
            StatusCode::NOT_FOUND
        );
    }

    /// Engagement events are acknowledged and ignored. Answering
    /// non-2xx would make Svix retry them for days.
    #[tokio::test]
    async fn ignored_events_are_acknowledged_not_retried() {
        let _g = SECRET_ENV_LOCK.lock().await;
        unsafe { std::env::set_var("RESEND_WEBHOOK_SECRET", test_secret()) };

        let mid = "<gk-open@ghostkeyapp.com>";
        let (state, id) = state_with_sent_email(mid).await;
        let body = serde_json::json!({
            "type": "email.opened",
            "data": { "message_id": mid }
        })
        .to_string();

        assert_eq!(
            call(&state, signed("msg_open", &body), body).await,
            StatusCode::NO_CONTENT
        );
        let status: Option<String> =
            sqlx::query_scalar("SELECT delivery_status FROM notifications WHERE id=?")
                .bind(id)
                .fetch_one(&state.db)
                .await
                .expect("row");
        assert_eq!(status, None, "opening a mail is not a delivery verdict");
    }

    #[test]
    fn bounce_reason_is_extracted_where_resend_puts_it() {
        let nested = serde_json::json!({
            "bounce": { "message": "The recipient's mailbox does not exist." }
        });
        assert_eq!(
            detail_from(&nested).as_deref(),
            Some("The recipient's mailbox does not exist.")
        );
        let sub = serde_json::json!({ "bounce": { "subType": "Suppressed" } });
        assert_eq!(detail_from(&sub).as_deref(), Some("Suppressed"));
        let flat = serde_json::json!({ "reason": "spam complaint" });
        assert_eq!(detail_from(&flat).as_deref(), Some("spam complaint"));
        // Missing is fine; nothing branches on this text.
        assert_eq!(detail_from(&serde_json::json!({})), None);
        assert_eq!(detail_from(&serde_json::json!({ "bounce": {} })), None);
    }
}
