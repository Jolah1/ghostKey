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

/// Provider statuses, reduced to the ones that mean something to us.
///
/// `queued` / `sending` / `sent` are progress updates, not verdicts —
/// worth recording so an operator can see how far a message got, but
/// they are not evidence of arrival. `delivered` is arrival. `read` is
/// WhatsApp-only and stronger than delivered. The negative ones are
/// what matter: the message is not coming, and somebody needs to know.
///
/// `bounced`, `complained` and `suppressed` are the email side of the
/// same idea. They are listed here rather than only in the email
/// module because the alarm has to fire on the shared path — a status
/// this function doesn't recognise is recorded silently, which is the
/// exact failure mode #311 exists to close.
pub(crate) fn is_negative_verdict(status: &str) -> bool {
    matches!(
        status,
        "undelivered" | "failed" | "bounced" | "complained" | "suppressed"
    )
}

/// How far along a status is, for deciding whether a late callback may
/// overwrite what we already recorded.
///
/// Callbacks are not ordered. Twilio can deliver `sent` after
/// `delivered`, and Resend's Svix retries can land an `email.sent` from
/// three minutes ago on top of a bounce that arrived first. Without a
/// rule, the last writer wins and a bounce quietly turns back into a
/// success.
///
/// The rule: a verdict may only move forward. Negative outranks
/// positive at the same terminality, because "did not arrive" is the
/// answer an owner has to act on and a stale success must never bury
/// it.
fn delivery_rank(status: &str) -> u8 {
    match status {
        "queued" | "accepted" | "scheduled" => 1,
        "sending" | "sent" | "delayed" | "delivery_delayed" => 2,
        "delivered" => 3,
        "read" => 4,
        // Terminal negatives. All equal: whichever arrives first is the
        // reason recorded, and no later callback may soften it.
        s if is_negative_verdict(s) => 5,
        // Something new from the provider. Rank it as progress so it is
        // recorded when nothing better is known, but can never
        // overwrite a real verdict.
        _ => 1,
    }
}

/// One delivery callback, normalised across providers.
pub(crate) struct DeliveryEvent<'a> {
    /// `"twilio"` or `"resend"`. Namespaces `event_id`, since the two
    /// providers mint ids in completely different shapes.
    pub provider: &'a str,
    /// Stable across the provider's own retries, distinct between real
    /// events. This is the replay guard; see the migration.
    pub event_id: String,
    /// What we stored at handoff, and what this callback is about.
    pub provider_message_id: &'a str,
    /// Normalised status, one of the values `delivery_rank` knows.
    pub status: &'a str,
    /// Provider's reason for a negative verdict, verbatim.
    pub detail: Option<&'a str>,
}

/// What `record_delivery` did, so the caller can log honestly.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Recorded {
    /// First time we've seen this event, and it moved the verdict on.
    Applied,
    /// Seen before. Nothing was touched.
    Duplicate,
    /// New event, but it would have moved the verdict backwards.
    Stale,
    /// New event for a message we never sent.
    UnknownMessage,
}

/// Constant-time-ish comparison of two base64 signatures.
///
/// `subtle` is already a dependency for the crypto module; use it so a
/// signature check can't be turned into a timing oracle.
pub(crate) fn signatures_match(a: &str, b: &str) -> bool {
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

    // Twilio sends no per-callback id, so the replay key is the pair it
    // does repeat verbatim on a retry: which message, which transition.
    let ev = DeliveryEvent {
        provider: "twilio",
        event_id: format!("{sid}:{status}"),
        provider_message_id: sid,
        status,
        detail: error_code,
    };

    match record_delivery(&state.db, &ev).await {
        Ok(_) => StatusCode::NO_CONTENT,
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
///
/// Two things this guards, both of which bit the version shipped in
/// #311:
///
///   - **Replay.** The event id goes in first, under a primary key. If
///     the insert is not new, the callback is a retry and we stop. That
///     is what stops one failed message writing two `notification_undelivered`
///     entries into the owner's activity feed.
///   - **Ordering.** A verdict only moves forward (`delivery_rank`), so
///     a late `sent` cannot overwrite a `bounced`.
pub(crate) async fn record_delivery(
    db: &sqlx::SqlitePool,
    ev: &DeliveryEvent<'_>,
) -> Result<Recorded, sqlx::Error> {
    let now = chrono::Utc::now().to_rfc3339();

    let row: Option<(i64, String, String, Option<String>)> = sqlx::query_as(
        "SELECT id, vault_id, kind, delivery_status
           FROM notifications WHERE provider_message_id = ?",
    )
    .bind(ev.provider_message_id)
    .fetch_optional(db)
    .await?;

    // Claim the event id BEFORE acting on it. `INSERT OR IGNORE` on the
    // primary key is the whole replay guard: zero rows affected means
    // another copy of this callback already did the work.
    let claimed = sqlx::query(
        "INSERT OR IGNORE INTO notification_delivery_events
             (provider, event_id, notification_id, status, received_at)
         VALUES (?, ?, ?, ?, ?)",
    )
    .bind(ev.provider)
    .bind(&ev.event_id)
    .bind(row.as_ref().map(|(id, _, _, _)| *id))
    .bind(ev.status)
    .bind(&now)
    .execute(db)
    .await?
    .rows_affected();

    if claimed == 0 {
        tracing::debug!(
            provider = ev.provider,
            event_id = %ev.event_id,
            status = ev.status,
            "duplicate delivery callback; already recorded"
        );
        return Ok(Recorded::Duplicate);
    }

    let Some((id, vault_id, kind, previous)) = row else {
        tracing::info!(
            provider_message_id = ev.provider_message_id,
            status = ev.status,
            "delivery status for an unknown message; ignoring"
        );
        return Ok(Recorded::UnknownMessage);
    };

    // Out-of-order arrival: record nothing rather than walk the verdict
    // backwards. The event row above still remembers we saw it.
    let previous_rank = previous.as_deref().map(delivery_rank).unwrap_or(0);
    if delivery_rank(ev.status) <= previous_rank {
        tracing::info!(
            notif_id = id,
            status = ev.status,
            previous = previous.as_deref().unwrap_or("-"),
            "delivery callback arrived out of order; keeping the stronger verdict"
        );
        return Ok(Recorded::Stale);
    }

    sqlx::query(
        "UPDATE notifications
            SET delivery_status = ?, delivery_detail = ?, delivery_updated_at = ?
          WHERE id = ?",
    )
    .bind(ev.status)
    .bind(ev.detail)
    .bind(&now)
    .bind(id)
    .execute(db)
    .await?;

    let status = ev.status;
    let detail = ev.detail;
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

    Ok(Recorded::Applied)
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

    /// A Twilio-shaped callback, with the same replay key the handler
    /// builds.
    fn twilio_event<'a>(
        sid: &'a str,
        status: &'a str,
        detail: Option<&'a str>,
    ) -> DeliveryEvent<'a> {
        DeliveryEvent {
            provider: "twilio",
            event_id: format!("{sid}:{status}"),
            provider_message_id: sid,
            status,
            detail,
        }
    }

    async fn undelivered_events(pool: &sqlx::SqlitePool) -> i64 {
        sqlx::query_scalar("SELECT COUNT(*) FROM events WHERE kind='notification_undelivered'")
            .fetch_one(pool)
            .await
            .expect("count")
    }

    async fn delivery_status(pool: &sqlx::SqlitePool, id: i64) -> Option<String> {
        sqlx::query_scalar("SELECT delivery_status FROM notifications WHERE id=?")
            .bind(id)
            .fetch_one(pool)
            .await
            .expect("row")
    }

    /// The failure this whole module exists for: Twilio accepted a
    /// claim link, then reported 63016. The row must stop claiming
    /// success, and the owner must be able to SEE it — a log line is
    /// not a signal.
    #[tokio::test]
    async fn undelivered_claim_link_is_recorded_and_surfaced() {
        let (pool, id) = db_with_sent_notification("SM-undelivered").await;

        record_delivery(
            &pool,
            &twilio_event("SM-undelivered", "undelivered", Some("63016")),
        )
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

        record_delivery(&pool, &twilio_event("SM-ok", "delivered", None))
            .await
            .expect("record");

        assert_eq!(
            delivery_status(&pool, id).await.as_deref(),
            Some("delivered")
        );
        assert_eq!(
            undelivered_events(&pool).await,
            0,
            "a delivered message is not an incident"
        );
    }

    /// A callback for a SID we never sent is ignored, not an error. The
    /// Twilio account may be shared with another deployment, and a
    /// non-2xx here would make Twilio retry forever.
    #[tokio::test]
    async fn unknown_message_id_is_ignored() {
        let (pool, _) = db_with_sent_notification("SM-known").await;
        let got = record_delivery(
            &pool,
            &twilio_event("SM-never-seen", "failed", Some("30008")),
        )
        .await
        .expect("must not error");
        assert_eq!(got, Recorded::UnknownMessage);
        let events: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM events")
            .fetch_one(&pool)
            .await
            .expect("count");
        assert_eq!(events, 0);
    }

    /// Delivery callbacks are at-least-once. Twilio retries any
    /// callback it didn't get a clean 2xx for, and Svix does the same
    /// for Resend. The first version of this module acted on every
    /// copy, so one failed claim link wrote the owner's activity feed
    /// twice.
    #[tokio::test]
    async fn a_replayed_callback_does_not_alarm_twice() {
        let (pool, id) = db_with_sent_notification("SM-replay").await;
        let ev = twilio_event("SM-replay", "undelivered", Some("63016"));

        assert_eq!(
            record_delivery(&pool, &ev).await.expect("first"),
            Recorded::Applied
        );
        assert_eq!(
            record_delivery(&pool, &ev).await.expect("replay"),
            Recorded::Duplicate,
        );
        assert_eq!(
            record_delivery(&pool, &ev).await.expect("replay again"),
            Recorded::Duplicate,
        );

        assert_eq!(
            undelivered_events(&pool).await,
            1,
            "one failed message is one incident, however many times the provider tells us"
        );
        assert_eq!(
            delivery_status(&pool, id).await.as_deref(),
            Some("undelivered")
        );
    }

    /// A replay of an UNKNOWN message must also be deduplicated. The
    /// event row is claimed before the lookup precisely so this path
    /// can't be used to hammer the DB with repeated work.
    #[tokio::test]
    async fn a_replayed_callback_for_an_unknown_message_is_also_deduplicated() {
        let (pool, _) = db_with_sent_notification("SM-known").await;
        let ev = twilio_event("SM-stranger", "failed", None);
        assert_eq!(
            record_delivery(&pool, &ev).await.expect("first"),
            Recorded::UnknownMessage
        );
        assert_eq!(
            record_delivery(&pool, &ev).await.expect("second"),
            Recorded::Duplicate
        );
    }

    /// The one that actually costs money: a bounce arrives, then a
    /// stale `sent` from the provider's retry queue lands on top. If
    /// the later write wins, the owner's dashboard says the message
    /// went out and the heir is quietly unreachable again.
    #[tokio::test]
    async fn a_late_positive_callback_cannot_bury_a_negative_verdict() {
        let (pool, id) = db_with_sent_notification("SM-order").await;

        record_delivery(
            &pool,
            &twilio_event("SM-order", "undelivered", Some("63016")),
        )
        .await
        .expect("bounce");
        let got = record_delivery(&pool, &twilio_event("SM-order", "delivered", None))
            .await
            .expect("late delivered");

        assert_eq!(got, Recorded::Stale);
        assert_eq!(
            delivery_status(&pool, id).await.as_deref(),
            Some("undelivered"),
            "a late success must not overwrite a recorded failure"
        );
        let detail: Option<String> =
            sqlx::query_scalar("SELECT delivery_detail FROM notifications WHERE id=?")
                .bind(id)
                .fetch_one(&pool)
                .await
                .expect("row");
        assert_eq!(detail.as_deref(), Some("63016"), "the reason survives too");
    }

    /// Progress updates arriving after arrival are equally stale.
    #[tokio::test]
    async fn progress_after_delivery_is_ignored() {
        let (pool, id) = db_with_sent_notification("SM-prog").await;
        record_delivery(&pool, &twilio_event("SM-prog", "delivered", None))
            .await
            .expect("delivered");
        for late in ["queued", "sending", "sent"] {
            assert_eq!(
                record_delivery(&pool, &twilio_event("SM-prog", late, None))
                    .await
                    .expect("late"),
                Recorded::Stale,
                "{late} arrived after delivery"
            );
        }
        assert_eq!(
            delivery_status(&pool, id).await.as_deref(),
            Some("delivered")
        );
    }

    /// Forward progress still works: the normal queued -> sent ->
    /// delivered sequence must each be recorded.
    #[tokio::test]
    async fn a_verdict_still_moves_forward_in_order() {
        let (pool, id) = db_with_sent_notification("SM-fwd").await;
        for s in ["queued", "sent", "delivered"] {
            assert_eq!(
                record_delivery(&pool, &twilio_event("SM-fwd", s, None))
                    .await
                    .expect("record"),
                Recorded::Applied,
                "{s} should advance the verdict"
            );
            assert_eq!(delivery_status(&pool, id).await.as_deref(), Some(s));
        }
        assert_eq!(undelivered_events(&pool).await, 0);
    }

    /// The email verdicts. Recorded through the same shared path, and
    /// they must alarm — a hard bounce means the address is dead, and
    /// Resend then suppresses it account-wide so every later send is
    /// silently dropped.
    #[tokio::test]
    async fn email_verdicts_alarm_the_owner_too() {
        for status in ["bounced", "complained", "suppressed"] {
            let (pool, id) = db_with_sent_notification("MSG-email").await;
            record_delivery(
                &pool,
                &DeliveryEvent {
                    provider: "resend",
                    event_id: format!("evt-{status}"),
                    provider_message_id: "MSG-email",
                    status,
                    detail: Some("mailbox does not exist"),
                },
            )
            .await
            .expect("record");

            assert_eq!(delivery_status(&pool, id).await.as_deref(), Some(status));
            assert_eq!(
                undelivered_events(&pool).await,
                1,
                "{status} must reach the owner's activity feed"
            );
        }
    }

    #[test]
    fn negative_verdicts_cover_both_providers() {
        for s in [
            "undelivered",
            "failed",
            "bounced",
            "complained",
            "suppressed",
        ] {
            assert!(is_negative_verdict(s), "{s} is a negative verdict");
        }
        // Progress, not arrival — and crucially not a reason to alarm
        // the owner.
        for s in [
            "queued",
            "sending",
            "sent",
            "delivered",
            "read",
            "delayed",
            "unknown",
        ] {
            assert!(!is_negative_verdict(s), "{s} is not a negative verdict");
        }
    }

    /// The precedence rule in one place, so changing a rank has to be
    /// deliberate.
    #[test]
    fn negative_verdicts_outrank_everything_else() {
        for bad in ["undelivered", "failed", "bounced", "complained"] {
            for ok in ["queued", "sending", "sent", "delivered", "read", "unknown"] {
                assert!(
                    delivery_rank(bad) > delivery_rank(ok),
                    "{bad} must outrank {ok}"
                );
            }
        }
        assert!(delivery_rank("delivered") > delivery_rank("sent"));
        assert!(delivery_rank("sent") > delivery_rank("queued"));
        // An unrecognised status ranks as bare progress: recorded when
        // nothing is known, never able to overwrite a verdict.
        assert!(delivery_rank("something-new") < delivery_rank("delivered"));
    }
}
