//! Delivery outcomes: what the provider says happened AFTER it took the
//! message off our hands.
//!
//! `notifications.status = 'sent'` has only ever meant "the provider's
//! API returned 2xx". That is a handoff receipt, not a delivery receipt,
//! and the gap between the two is where this product fails worst:
//!
//!   - Twilio answers `201 queued` and then fails the message
//!     asynchronously — 63007 (sender not a known channel), 63016
//!     (free-form message outside the 24h WhatsApp session window),
//!     30034 (US long code not registered for A2P 10DLC).
//!   - SMTP relays accept at submission and hard-bounce later.
//!
//! Neither ever reached us. A heir's practice-drill invite read `sent`
//! for six days having never existed (mainnet notification id 40), and
//! `/health` reported the notifier healthy throughout.
//!
//! This module owns the inbound half: Twilio POSTs a status callback per
//! message, we authenticate it, and we record the verdict against the
//! row. A negative verdict also writes an `event`, so it surfaces in the
//! owner's activity feed rather than only in a log line nobody reads.

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use std::collections::BTreeMap;
use std::sync::Arc;

use crate::AppState;

/// Twilio's `MessageStatus` values, reduced to the ones that mean
/// something to us.
///
/// `queued` / `sending` / `sent` are progress updates, not verdicts —
/// worth recording so an operator can see how far a message got, but
/// they are not evidence of arrival. `delivered` is arrival. `read` is
/// WhatsApp-only and stronger than delivered. `undelivered` and
/// `failed` are the ones that matter: the message is not coming, and
/// somebody needs to know.
fn is_negative_verdict(status: &str) -> bool {
    matches!(status, "undelivered" | "failed")
}

/// Constant-time-ish comparison of two base64 signatures.
///
/// `subtle` is already a dependency for the crypto module; use it so a
/// signature check can't be turned into a timing oracle.
fn signatures_match(a: &str, b: &str) -> bool {
    use subtle::ConstantTimeEq;
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.ct_eq(b).into()
}

/// Twilio's request signature.
///
/// Documented algorithm: take the full URL the request was sent to,
/// append every POST parameter as `key + value` in lexicographic key
/// order, HMAC-SHA1 it with the account auth token, base64 the result.
///
/// The URL has to be byte-identical to what Twilio called. We do NOT
/// reconstruct it from request headers — `Host` and `X-Forwarded-Proto`
/// are attacker-influenced, and getting that wrong turns the whole
/// check into decoration. Instead we rebuild it from the same
/// `status_callback_url()` the sender put on the message.
pub(crate) fn twilio_signature(
    auth_token: &str,
    url: &str,
    params: &BTreeMap<String, String>,
) -> String {
    use base64::Engine as _;
    use hmac::{Mac, SimpleHmac};

    let mut payload = String::from(url);
    for (k, v) in params {
        payload.push_str(k);
        payload.push_str(v);
    }

    let mut mac = SimpleHmac::<sha1::Sha1>::new_from_slice(auth_token.as_bytes())
        .expect("hmac accepts any key length");
    mac.update(payload.as_bytes());
    base64::engine::general_purpose::STANDARD.encode(mac.finalize().into_bytes())
}

/// `POST /webhooks/twilio/status`
///
/// Twilio calls this once per status transition for every message we
/// sent with a `StatusCallback`. Unauthenticated by URL — the signature
/// is the authentication, so it is checked before anything is read out
/// of the body.
///
/// Always answers 2xx once the signature passes, including for a SID we
/// don't recognise. Twilio retries non-2xx, and there is nothing to
/// retry into: an unknown SID is a message from a different deployment
/// sharing the account, or one whose row was deleted with its vault.
pub(crate) async fn twilio_status_webhook(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: String,
) -> impl IntoResponse {
    let Some(cfg) = crate::notifier::TwilioConfig::from_env() else {
        // No Twilio on this deployment: nobody legitimate is calling.
        return StatusCode::NOT_FOUND;
    };
    let Some(url) = crate::notifier::status_callback_url() else {
        return StatusCode::NOT_FOUND;
    };

    // Parse the form body ourselves so the exact same map feeds both the
    // signature check and the lookup below.
    let params: BTreeMap<String, String> = form_urlencoded::parse(body.as_bytes())
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();

    let provided = headers
        .get("X-Twilio-Signature")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default();
    let expected = twilio_signature(&cfg.auth_token, &url, &params);
    if !signatures_match(provided, &expected) {
        tracing::warn!("twilio status callback failed signature check; ignoring");
        return StatusCode::FORBIDDEN;
    }

    let Some(sid) = params.get("MessageSid").or_else(|| params.get("SmsSid")) else {
        tracing::warn!("twilio status callback with no MessageSid");
        return StatusCode::NO_CONTENT;
    };
    let status = params
        .get("MessageStatus")
        .or_else(|| params.get("SmsStatus"))
        .map(String::as_str)
        .unwrap_or("unknown");
    let error_code = params.get("ErrorCode").map(String::as_str);

    match record_delivery(&state.db, sid, status, error_code).await {
        Ok(()) => StatusCode::NO_CONTENT,
        Err(e) => {
            tracing::error!(error = ?e, "failed to record twilio delivery status");
            // Twilio will retry, and a DB blip is worth retrying into.
            StatusCode::INTERNAL_SERVER_ERROR
        }
    }
}

/// Write a provider verdict against the notification it belongs to.
///
/// Kept separate from the HTTP handler so the interesting behaviour is
/// testable without a signature or a socket.
pub(crate) async fn record_delivery(
    db: &sqlx::SqlitePool,
    provider_message_id: &str,
    status: &str,
    detail: Option<&str>,
) -> Result<(), sqlx::Error> {
    let now = chrono::Utc::now().to_rfc3339();

    let row: Option<(i64, String, String)> = sqlx::query_as(
        "SELECT id, vault_id, kind FROM notifications WHERE provider_message_id = ?",
    )
    .bind(provider_message_id)
    .fetch_optional(db)
    .await?;

    let Some((id, vault_id, kind)) = row else {
        tracing::info!(
            provider_message_id,
            status,
            "delivery status for an unknown message; ignoring"
        );
        return Ok(());
    };

    sqlx::query(
        "UPDATE notifications
            SET delivery_status = ?, delivery_detail = ?, delivery_updated_at = ?
          WHERE id = ?",
    )
    .bind(status)
    .bind(detail)
    .bind(&now)
    .bind(id)
    .execute(db)
    .await?;

    if is_negative_verdict(status) {
        // This is the whole point of the exercise: a claim link or an
        // alarm that did not arrive must not be a log-only signal. The
        // event lands in the vault's activity feed, which the owner's
        // dashboard already renders.
        tracing::error!(
            notif_id = id,
            vault_id = %vault_id,
            kind = %kind,
            status,
            detail = detail.unwrap_or("-"),
            "notification was NOT delivered"
        );
        crate::routes::record_event(
            db,
            &vault_id,
            "notification_undelivered",
            Some(serde_json::json!({
                "notification_kind": kind,
                "status": status,
                "error_code": detail,
            })),
        )
        .await?;
    } else {
        tracing::info!(
            notif_id = id,
            vault_id = %vault_id,
            kind = %kind,
            status,
            "delivery status recorded"
        );
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The HMAC-SHA1 primitive and its base64 wrapping, pinned against
    /// RFC 2202 test case 1. If this passes and the payload assembly is
    /// right, the signature is right — so this is the half that proves
    /// we're not, say, hashing with the wrong digest.
    #[test]
    fn hmac_sha1_matches_rfc_2202() {
        use base64::Engine as _;
        use hmac::{Mac, SimpleHmac};
        let mut mac = SimpleHmac::<sha1::Sha1>::new_from_slice(&[0x0b; 20]).expect("key");
        mac.update(b"Hi There");
        let got = mac.finalize().into_bytes();
        assert_eq!(hex::encode(got), "b617318655057264e28bc0b6fb378c8ef146be00",);
        // And the base64 step the signature actually ships.
        assert_eq!(
            base64::engine::general_purpose::STANDARD.encode(got),
            "thcxhlUFcmTii8C2+zeMjvFGvgA=",
        );
    }

    /// Full worked example: URL with a query string, five parameters
    /// folded in key order. The expected value was computed
    /// independently (Python `hmac`/`hashlib`) rather than copied from
    /// this implementation, so it pins the payload assembly — ordering,
    /// separators, the fact that the query string stays on the URL —
    /// and not merely today's behaviour.
    #[test]
    fn twilio_signature_worked_example() {
        let mut params = BTreeMap::new();
        params.insert("CallSid".to_string(), "CA1234567890ABCDE".to_string());
        params.insert("Caller".to_string(), "+14158675309".to_string());
        params.insert("Digits".to_string(), "1234".to_string());
        params.insert("From".to_string(), "+14158675309".to_string());
        params.insert("To".to_string(), "+18005551212".to_string());

        let sig = twilio_signature(
            "12345678901234567890123456789012",
            "https://mycompany.com/myapp.php?foo=1&bar=2",
            &params,
        );
        assert_eq!(sig, "GcktA2Mwo5ZdznWKqivG1r6lyMU=");
    }

    /// Params are folded in key order, not arrival order.
    #[test]
    fn signature_is_independent_of_parameter_order() {
        let mut a = BTreeMap::new();
        a.insert("B".to_string(), "2".to_string());
        a.insert("A".to_string(), "1".to_string());
        let mut b = BTreeMap::new();
        b.insert("A".to_string(), "1".to_string());
        b.insert("B".to_string(), "2".to_string());
        assert_eq!(
            twilio_signature("tok", "https://x/y", &a),
            twilio_signature("tok", "https://x/y", &b),
        );
    }

    /// A different token must not produce the same signature — the
    /// check has to actually depend on the secret.
    #[test]
    fn signature_depends_on_the_auth_token() {
        let params = BTreeMap::new();
        assert_ne!(
            twilio_signature("token-a", "https://x/y", &params),
            twilio_signature("token-b", "https://x/y", &params),
        );
    }

    #[test]
    fn signature_comparison_rejects_mismatches() {
        assert!(signatures_match("abc", "abc"));
        assert!(!signatures_match("abc", "abd"));
        assert!(!signatures_match("abc", "ab"));
        assert!(!signatures_match("", "x"));
    }

    /// In-memory DB with one vault and one already-handed-off
    /// notification carrying a provider id.
    async fn db_with_sent_notification(sid: &str) -> (sqlx::SqlitePool, i64) {
        if std::env::var("GHOSTKEY_MASTER_KEY").is_err() {
            use base64::Engine as _;
            let b64 = base64::engine::general_purpose::STANDARD_NO_PAD.encode([0u8; 32]);
            // SAFETY: tests are single-process; the value is fixed.
            unsafe { std::env::set_var("GHOSTKEY_MASTER_KEY", &b64) };
        }
        let _ = crate::crypto::ensure_master_key_loaded();

        let pool: sqlx::SqlitePool = sqlx::sqlite::SqlitePoolOptions::new()
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
               VALUES ('v-del','regtest','d-ext','d-int',144,86400,3600,
                    '2026-01-01T00:00:00Z','2026-01-02T00:00:00Z','ok')"#,
        )
        .execute(&pool)
        .await
        .expect("vault");

        let id = crate::notifier::enqueue(
            &pool,
            "v-del",
            crate::notifier::NotificationKind::ClaimLink,
            crate::notifier::Channel::Whatsapp,
            "+15005550009",
            "subject",
            "body",
        )
        .await
        .expect("enqueue");
        sqlx::query("UPDATE notifications SET status='sent', provider_message_id=? WHERE id=?")
            .bind(sid)
            .bind(id)
            .execute(&pool)
            .await
            .expect("hand off");
        (pool, id)
    }

    /// The failure this whole module exists for: Twilio accepted a
    /// claim link, then reported 63016. The row must stop claiming
    /// success, and the owner must be able to SEE it — a log line is
    /// not a signal.
    #[tokio::test]
    async fn undelivered_claim_link_is_recorded_and_surfaced() {
        let (pool, id) = db_with_sent_notification("SM-undelivered").await;

        record_delivery(&pool, "SM-undelivered", "undelivered", Some("63016"))
            .await
            .expect("record");

        let (status, detail): (Option<String>, Option<String>) =
            sqlx::query_as("SELECT delivery_status, delivery_detail FROM notifications WHERE id=?")
                .bind(id)
                .fetch_one(&pool)
                .await
                .expect("row");
        assert_eq!(status.as_deref(), Some("undelivered"));
        assert_eq!(detail.as_deref(), Some("63016"));

        let (kind, event_detail): (String, Option<String>) = sqlx::query_as(
            "SELECT kind, detail FROM events WHERE vault_id='v-del' AND kind='notification_undelivered'",
        )
        .fetch_one(&pool)
        .await
        .expect("an undelivered claim link must reach the activity feed");
        assert_eq!(kind, "notification_undelivered");
        let d = event_detail.expect("detail");
        assert!(d.contains("claim_link"), "names what didn't arrive: {d}");
        assert!(d.contains("63016"), "carries the provider's reason: {d}");
    }

    /// A `delivered` verdict is recorded but must NOT alarm anyone.
    #[tokio::test]
    async fn delivered_is_recorded_without_an_event() {
        let (pool, id) = db_with_sent_notification("SM-ok").await;

        record_delivery(&pool, "SM-ok", "delivered", None)
            .await
            .expect("record");

        let status: Option<String> =
            sqlx::query_scalar("SELECT delivery_status FROM notifications WHERE id=?")
                .bind(id)
                .fetch_one(&pool)
                .await
                .expect("row");
        assert_eq!(status.as_deref(), Some("delivered"));

        let events: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM events WHERE kind='notification_undelivered'")
                .fetch_one(&pool)
                .await
                .expect("count");
        assert_eq!(events, 0, "a delivered message is not an incident");
    }

    /// A callback for a SID we never sent is ignored, not an error. The
    /// Twilio account may be shared with another deployment, and a
    /// non-2xx here would make Twilio retry forever.
    #[tokio::test]
    async fn unknown_message_id_is_ignored() {
        let (pool, _) = db_with_sent_notification("SM-known").await;
        record_delivery(&pool, "SM-never-seen", "failed", Some("30008"))
            .await
            .expect("must not error");
        let events: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM events")
            .fetch_one(&pool)
            .await
            .expect("count");
        assert_eq!(events, 0);
    }

    #[test]
    fn only_undelivered_and_failed_are_verdicts() {
        assert!(is_negative_verdict("undelivered"));
        assert!(is_negative_verdict("failed"));
        // Progress, not arrival — and crucially not a reason to alarm
        // the owner.
        for s in ["queued", "sending", "sent", "delivered", "read", "unknown"] {
            assert!(!is_negative_verdict(s), "{s} is not a negative verdict");
        }
    }
}
