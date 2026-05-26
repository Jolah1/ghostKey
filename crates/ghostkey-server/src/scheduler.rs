//! Background scheduler. Periodically:
//!
//! 1. Finds vaults whose `next_deadline_at` is in the past and bumps them
//!    out of `ok` to `alarmed`.
//! 2. Finds `alarmed` vaults whose `claim_eligible_at` has elapsed and
//!    transitions them to `timelock_started`, issuing a one-time claim
//!    token in the same transaction. The token's raw value lives only
//!    in this function's stack frame and goes into an event row's
//!    detail JSON so the operator can deliver it manually (or, later, a
//!    notifier integration can pick it up and SMS/email it).
//! 3. Records events that callers (or external notifier integrations) can
//!    use to send emails, push notifications, etc.
//!
//! This scheduler does NOT yet watch the chain — that integration plugs
//! in via the CLI's chain sync today, and will live in this crate behind
//! a `chain-sync` feature.

use std::sync::Arc;
use std::time::Duration;

use chrono::Utc;

use crate::crypto::issue_claim_token;
use crate::notifier::{self, parse_heir_contact, parse_owner_contact, Channel, NotificationKind};
use crate::routes::record_event;
use crate::AppState;

pub async fn run(state: Arc<AppState>, tick: Duration) {
    loop {
        if let Err(e) = tick_once(&state).await {
            tracing::error!(error = ?e, "scheduler tick failed");
        }
        tokio::time::sleep(tick).await;
    }
}

async fn tick_once(state: &AppState) -> anyhow::Result<()> {
    let now = Utc::now().to_rfc3339();
    transition_ok_to_alarmed(state, &now).await?;
    transition_alarmed_to_claimable(state, &now).await?;
    Ok(())
}

/// Move every vault past its `next_deadline_at` from `ok` to `alarmed`.
/// Records an `alarm` event so operators / notifier integrations can
/// surface "missed check-in" to the owner.
///
/// Also: when the vault has a sealed owner contact (set by the web
/// wizard), enqueue an `AlarmOwner` email so the owner gets a real
/// nudge rather than learning about the missed check-in only when
/// their heir starts asking questions. The enqueue is best-effort —
/// a failure here logs and continues; the status transition has
/// already committed, and the next scheduler tick won't re-issue
/// because the row's status is no longer `ok`.
async fn transition_ok_to_alarmed(state: &AppState, now_iso: &str) -> anyhow::Result<()> {
    let due = sqlx::query_as::<
        _,
        (
            String,         // id
            Option<String>, // label
            Option<String>, // owner_contact_ciphertext
            Option<String>, // owner_contact_nonce
            Option<String>, // owner_contact_channel
            i64,            // checkin_period_secs
            i64,            // grace_period_secs
            String,         // claim_eligible_at
        ),
    >(
        r#"SELECT id, label,
                  owner_contact_ciphertext, owner_contact_nonce, owner_contact_channel,
                  checkin_period_secs, grace_period_secs,
                  claim_eligible_at
             FROM vaults
            WHERE status = 'ok'
              AND next_deadline_at <= ?"#,
    )
    .bind(now_iso)
    .fetch_all(&state.db)
    .await?;

    for (id, label, ow_ct, ow_nn, ow_ch, _checkin_s, _grace_s, claim_eligible_at) in due {
        tracing::warn!(vault_id = %id, "deadline missed; transitioning ok -> alarmed");
        sqlx::query("UPDATE vaults SET status = 'alarmed' WHERE id = ?")
            .bind(&id)
            .execute(&state.db)
            .await?;
        record_event(
            &state.db,
            &id,
            "alarm",
            Some(serde_json::json!({ "reason": "checkin_missed" })),
        )
        .await?;

        // Owner notification. Skips are silent and not errors:
        //   - vault has no sealed owner contact (legacy row, or owner
        //     declined to provide one at setup) → Ok(None)
        //   - channel column holds a value the notifier can't deliver
        //     to today (sms, whatsapp) → Ok(None) with a debug log
        //   - decryption failed (corrupt row, master key rotated)
        //     → tracing::warn and continue
        if let Err(e) = enqueue_alarm_owner(
            state,
            &id,
            label.as_deref(),
            ow_ct.as_deref(),
            ow_nn.as_deref(),
            ow_ch.as_deref(),
            &claim_eligible_at,
        )
        .await
        {
            tracing::warn!(vault_id = %id, error = ?e, "could not enqueue owner alarm notification");
        }
    }

    Ok(())
}

/// Build the "you missed your check-in" message and enqueue it via
/// the notifier. Returns `Ok(())` even when the row has no contact
/// or the channel isn't deliverable — those are routine skips, not
/// errors the caller should retry.
async fn enqueue_alarm_owner(
    state: &AppState,
    vault_id: &str,
    label: Option<&str>,
    ow_ct: Option<&str>,
    ow_nn: Option<&str>,
    ow_ch: Option<&str>,
    claim_eligible_at_iso: &str,
) -> anyhow::Result<()> {
    let Some(contact) = parse_owner_contact(vault_id, ow_ct, ow_nn, ow_ch)? else {
        tracing::info!(vault_id = %vault_id, "no sealed owner contact; skipping owner alarm notification");
        return Ok(());
    };

    // The notifier only delivers Channel::Email today. parse_owner_contact
    // already returns None for unsupported channels (with a log), so by
    // the time we get here we know we can deliver — but match
    // explicitly so the warning is unambiguous if a new channel is
    // added to the enum and not to the worker.
    if !matches!(contact.channel, Channel::Email) {
        tracing::info!(
            vault_id = %vault_id,
            channel = ?contact.channel,
            "owner channel known but not yet supported by worker; skipping"
        );
        return Ok(());
    }

    // Build a friendly deadline string. The claim_eligible_at is in
    // RFC3339 with a `T` separator; truncate the seconds and zone
    // so the email reads like a human picked the moment, not a
    // database column. If parsing fails we fall back to the raw
    // string — better than the email failing to enqueue.
    let claim_friendly = chrono::DateTime::parse_from_rfc3339(claim_eligible_at_iso)
        .ok()
        .map(|d| {
            d.with_timezone(&chrono::Utc)
                .format("%Y-%m-%d %H:%M UTC")
                .to_string()
        })
        .unwrap_or_else(|| claim_eligible_at_iso.to_string());

    let base = public_base_url();
    let checkin_url = format!("{base}/#/checkin");
    let display_label = label.unwrap_or("your GhostKey vault");

    let subject = "You missed your GhostKey check-in".to_string();
    let body = format!(
        "Hello,\n\n\
         {display_label} just missed its check-in deadline. We'd usually \
         remind you sooner — this is the last reminder before the next \
         step.\n\n\
         If you're still around: open this link on any device and tap \
         \"I'm still here\" to reset the clock. Nothing else changes.\n\n\
         {checkin_url}\n\n\
         If we don't hear from you by {claim_friendly}, your heir will \
         receive their claim link automatically. You can stop that at \
         any moment up to then by checking in.\n\n\
         If this email reached you by mistake, you can ignore it. \
         Nothing happens until the deadline above.\n\n\
         — GhostKey\n"
    );

    notifier::enqueue(
        &state.db,
        vault_id,
        NotificationKind::AlarmOwner,
        Channel::Email,
        &contact.address,
        &subject,
        &body,
    )
    .await?;
    tracing::info!(vault_id = %vault_id, "owner alarm notification enqueued");
    Ok(())
}

/// Move every vault that has been `alarmed` long enough (past its
/// `claim_eligible_at`) to `timelock_started`, and issue a one-time
/// claim token for the heir.
///
/// Idempotent: a row that already has a `claim_token_hash` is skipped.
/// This means a follow-on owner check-in that fails to clear the row's
/// hash for some reason won't cause a token reset; the operator can
/// explicitly call POST /vaults/:id/issue-claim to force re-issue.
async fn transition_alarmed_to_claimable(state: &AppState, now_iso: &str) -> anyhow::Result<()> {
    // Two distinct "due" populations on every tick:
    //
    //   - Legacy vaults: no claim_token_hash, no claim_token_at_rest_b64.
    //     Mint a fresh token, store its hash, deliver the raw value.
    //
    //   - Password vaults: hash + raw token were both written at
    //     creation time (see CreateVaultFromXpubRequest.sealed). The
    //     heir's xprv ciphertext is bound to that *specific* token via
    //     HKDF, so re-issuing would invalidate the seal. We must reuse
    //     the at-rest value as-is.
    //
    // We pull both sets in one query and branch per row. The heir
    // contact (encrypted) and label come along so we can enqueue
    // notifications without a second round trip.
    let due = sqlx::query_as::<
        _,
        (
            String,         // id
            Option<String>, // label
            Option<String>, // heir_contact_ciphertext
            Option<String>, // heir_contact_nonce
            Option<String>, // claim_token_at_rest_b64 (password vaults only)
            Option<String>, // claim_token_hash (already set on password vaults)
        ),
    >(
        r#"SELECT id, label,
                  heir_contact_ciphertext, heir_contact_nonce,
                  claim_token_at_rest_b64, claim_token_hash
             FROM vaults
            WHERE status = 'alarmed'
              AND claim_eligible_at IS NOT NULL
              AND claim_eligible_at <= ?
              AND (
                    -- Legacy: no token has been issued yet.
                    claim_token_hash IS NULL
                    OR
                    -- Password vault: token was minted at creation,
                    -- but the status hasn't yet been advanced.
                    claim_token_at_rest_b64 IS NOT NULL
                  )"#,
    )
    .bind(now_iso)
    .fetch_all(&state.db)
    .await?;

    for (id, label, ct, nn, at_rest, existing_hash) in due {
        // Decide whether this is a password vault or a legacy row.
        // For password vaults, reuse the existing token; for legacy,
        // mint a fresh one.
        let (raw_token, token_hash, reused) =
            if let (Some(raw), Some(hash)) = (at_rest.as_ref(), existing_hash.as_ref()) {
                (raw.clone(), hash.clone(), true)
            } else {
                let t = issue_claim_token();
                (t.token, t.hash_hex, false)
            };

        tracing::warn!(
            vault_id = %id,
            reused_token = reused,
            "alarmed past eligibility; transitioning to timelock_started"
        );

        // Wrap the status update in a transaction. For legacy rows we
        // also bind the freshly-minted hash; for password vaults the
        // hash is already on disk and we only advance the status +
        // issued_at timestamp. An observer must never see a row in
        // `timelock_started` without a matching `claim_token_hash`.
        let mut tx = state.db.begin().await?;
        if reused {
            sqlx::query(
                r#"UPDATE vaults
                      SET status                = 'timelock_started',
                          claim_token_issued_at = ?,
                          claim_token_used_at   = NULL
                    WHERE id = ?
                      AND status = 'alarmed'"#,
            )
            .bind(now_iso)
            .bind(&id)
            .execute(&mut *tx)
            .await?;
        } else {
            sqlx::query(
                r#"UPDATE vaults
                      SET status                = 'timelock_started',
                          claim_token_hash      = ?,
                          claim_token_issued_at = ?,
                          claim_token_used_at   = NULL
                    WHERE id = ?
                      AND status = 'alarmed'
                      AND claim_token_hash IS NULL"#,
            )
            .bind(&token_hash)
            .bind(now_iso)
            .bind(&id)
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await?;

        // Only the SHA-256 hash of the token is recorded here. The
        // raw token is a bearer credential and must never sit in
        // event logs (anyone with read access to the events table or
        // a SQLite backup could claim the inheritance). If the
        // notifier is down and an operator needs to re-deliver, they
        // can mint a fresh token via `POST /vaults/:id/issue-claim`.
        record_event(
            &state.db,
            &id,
            "claim_issued",
            Some(serde_json::json!({
                "token_hash": token_hash,
                "reason": if reused {
                    "scheduler:eligibility_reached:reused_password_vault_token"
                } else {
                    "scheduler:eligibility_reached"
                },
            })),
        )
        .await?;

        // Try to enqueue a notification for the heir. We only know
        // how to deliver via email today; sms / whatsapp channels
        // get logged and skipped. A vault with no encrypted heir
        // contact (legacy, or owner declined to provide one) also
        // skips here. None of those skips block the status
        // transition above.
        if let Err(e) = enqueue_claim_link(
            state,
            &id,
            label.as_deref(),
            ct.as_deref(),
            nn.as_deref(),
            &raw_token,
        )
        .await
        {
            tracing::warn!(vault_id = %id, error = ?e, "could not enqueue claim notification");
        }
    }

    Ok(())
}

/// Build a claim URL and enqueue a delivery for the heir. Returns
/// `Ok(())` whether or not the enqueue actually happened -- a skip
/// (no contact, wrong channel) is not an error.
async fn enqueue_claim_link(
    state: &AppState,
    vault_id: &str,
    label: Option<&str>,
    contact_ct: Option<&str>,
    contact_nn: Option<&str>,
    token: &str,
) -> anyhow::Result<()> {
    let Some(contact) = parse_heir_contact(vault_id, contact_ct, contact_nn)? else {
        tracing::info!(vault_id = %vault_id, "no heir contact on file; skipping notification");
        return Ok(());
    };

    let channel = match contact.channel.as_deref() {
        Some("email") => Channel::Email,
        Some(other) => {
            tracing::info!(vault_id = %vault_id, channel = %other, "heir channel not yet supported; skipping notification");
            return Ok(());
        }
        None => {
            tracing::info!(vault_id = %vault_id, "heir channel missing; skipping notification");
            return Ok(());
        }
    };

    let recipient = match contact.contact.as_deref() {
        Some(c) if !c.is_empty() => c.to_string(),
        _ => {
            tracing::info!(vault_id = %vault_id, "heir contact address empty; skipping notification");
            return Ok(());
        }
    };

    let base = public_base_url();
    let claim_url = format!("{base}/#/claim/{token}");

    let display_label = label.unwrap_or("a Bitcoin inheritance");
    let heir_name = contact.name.as_deref().unwrap_or("there");
    let subject = "A message for you about something someone left you".to_string();
    let body = format!(
        "Hello {heir_name},\n\n\
         Someone you knew set up a Bitcoin inheritance with GhostKey, and \
         asked us to reach out to you if they ever stopped checking in. \
         That has happened.\n\n\
         Open this link on any phone or computer to see what they left you \
         and the next steps:\n\n\
         {claim_url}\n\n\
         The link works once. You don't need an account.\n\n\
         What's being passed on: {display_label}.\n\n\
         If this message reached you by mistake, you can ignore it -- \
         nothing happens until you open the link.\n\n\
         — GhostKey\n"
    );

    notifier::enqueue(
        &state.db,
        vault_id,
        NotificationKind::ClaimLink,
        channel,
        &recipient,
        &subject,
        &body,
    )
    .await?;
    tracing::info!(vault_id = %vault_id, "claim-link notification enqueued");
    Ok(())
}

/// The public base URL the heir's claim link should point at. We
/// keep this configurable so a deployment serving the dashboard at
/// e.g. `ghostkeyapp.vercel.app` can produce links that go there
/// rather than to the API host.
fn public_base_url() -> String {
    std::env::var("GHOSTKEY_PUBLIC_BASE_URL")
        .unwrap_or_else(|_| "https://ghostkeyapp.vercel.app".to_string())
}

/* -------------------------------------------------------------------------- *
 *  Tests                                                                     *
 *                                                                            *
 *  These exercise the SQL transition logic against an in-memory SQLite       *
 *  database loaded with the same migrations the production server uses.      *
 *  They cover the trigger thresholds and the idempotence guarantee.          *
 * -------------------------------------------------------------------------- */

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;
    use sqlx::SqlitePool;

    /// Bring up a fresh SQLite in memory with all migrations applied.
    async fn fresh_db() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
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

    /// Insert a minimal vault row directly (bypassing the route handler)
    /// with knobs the tests need: status, next deadline, claim eligibility.
    async fn insert_vault(
        pool: &SqlitePool,
        id: &str,
        status: &str,
        next_deadline_at: &str,
        claim_eligible_at: Option<&str>,
    ) {
        sqlx::query(
            r#"INSERT INTO vaults (
                id, network,
                descriptor_external, descriptor_internal,
                timelock_blocks,
                checkin_period_secs, grace_period_secs,
                created_at, next_deadline_at, status,
                claim_eligible_at
            ) VALUES (?, 'regtest', ?, ?, 144, 86400, 3600,
                      '2026-01-01T00:00:00Z', ?, ?, ?)"#,
        )
        .bind(id)
        // descriptor_external is UNIQUE; tag it with the id so each row
        // can coexist in the same test db.
        .bind(format!("tr(fake/{id}/0/*)"))
        .bind(format!("tr(fake/{id}/1/*)"))
        .bind(next_deadline_at)
        .bind(status)
        .bind(claim_eligible_at)
        .execute(pool)
        .await
        .expect("insert");
    }

    async fn read_status_and_token_hash(pool: &SqlitePool, id: &str) -> (String, Option<String>) {
        sqlx::query_as::<_, (String, Option<String>)>(
            "SELECT status, claim_token_hash FROM vaults WHERE id = ?",
        )
        .bind(id)
        .fetch_one(pool)
        .await
        .expect("read")
    }

    #[tokio::test]
    async fn ok_past_deadline_transitions_to_alarmed() {
        let pool = fresh_db().await;
        let state = AppState {
            db: pool.clone(),
            lightning: std::sync::Arc::new(crate::lightning::NoopProvider),
        };
        // Deadline 1 hour in the past.
        insert_vault(
            &pool,
            "vault-a",
            "ok",
            "2026-04-01T00:00:00Z",
            Some("2030-01-01T00:00:00Z"),
        )
        .await;
        tick_once(&state).await.expect("tick");
        let (status, _) = read_status_and_token_hash(&pool, "vault-a").await;
        assert_eq!(status, "alarmed");
    }

    #[tokio::test]
    async fn alarmed_past_eligibility_transitions_and_issues_token() {
        let pool = fresh_db().await;
        let state = AppState {
            db: pool.clone(),
            lightning: std::sync::Arc::new(crate::lightning::NoopProvider),
        };
        // Already alarmed; eligibility in the past.
        insert_vault(
            &pool,
            "vault-b",
            "alarmed",
            "2026-04-01T00:00:00Z",
            Some("2026-04-08T00:00:00Z"),
        )
        .await;
        tick_once(&state).await.expect("tick");
        let (status, hash) = read_status_and_token_hash(&pool, "vault-b").await;
        assert_eq!(status, "timelock_started");
        assert!(hash.is_some(), "claim token hash must be set");
    }

    #[tokio::test]
    async fn alarmed_before_eligibility_does_not_transition() {
        let pool = fresh_db().await;
        let state = AppState {
            db: pool.clone(),
            lightning: std::sync::Arc::new(crate::lightning::NoopProvider),
        };
        // Eligibility in the far future.
        insert_vault(
            &pool,
            "vault-c",
            "alarmed",
            "2026-04-01T00:00:00Z",
            Some("2099-01-01T00:00:00Z"),
        )
        .await;
        tick_once(&state).await.expect("tick");
        let (status, hash) = read_status_and_token_hash(&pool, "vault-c").await;
        assert_eq!(status, "alarmed");
        assert!(hash.is_none(), "no token before eligibility");
    }

    #[tokio::test]
    async fn does_not_reissue_token_for_vault_with_existing_hash() {
        let pool = fresh_db().await;
        let state = AppState {
            db: pool.clone(),
            lightning: std::sync::Arc::new(crate::lightning::NoopProvider),
        };
        insert_vault(
            &pool,
            "vault-d",
            "alarmed",
            "2026-04-01T00:00:00Z",
            Some("2026-04-08T00:00:00Z"),
        )
        .await;
        // Pre-seed a token hash. Even though eligibility is past, the
        // scheduler must skip this row to avoid clobbering the heir's
        // existing link.
        sqlx::query("UPDATE vaults SET claim_token_hash = 'preexisting-hash' WHERE id = ?")
            .bind("vault-d")
            .execute(&pool)
            .await
            .unwrap();
        tick_once(&state).await.expect("tick");
        let (status, hash) = read_status_and_token_hash(&pool, "vault-d").await;
        assert_eq!(
            status, "alarmed",
            "status untouched when token already issued"
        );
        assert_eq!(hash.as_deref(), Some("preexisting-hash"));
    }

    /// The raw claim token is a bearer credential and must never end
    /// up in `events.detail`. Earlier versions of the scheduler stored
    /// it there as a fallback for operators; this test pins the fix.
    #[tokio::test]
    async fn claim_issued_event_does_not_contain_raw_token() {
        let pool = fresh_db().await;
        let state = AppState {
            db: pool.clone(),
            lightning: std::sync::Arc::new(crate::lightning::NoopProvider),
        };
        insert_vault(
            &pool,
            "vault-e",
            "alarmed",
            "2026-04-01T00:00:00Z",
            Some("2026-04-08T00:00:00Z"),
        )
        .await;
        tick_once(&state).await.expect("tick");

        let (_, hash) = read_status_and_token_hash(&pool, "vault-e").await;
        let hash = hash.expect("scheduler should have minted a token hash");

        let detail: Option<String> = sqlx::query_scalar(
            "SELECT detail FROM events WHERE vault_id = ? AND kind = 'claim_issued'",
        )
        .bind("vault-e")
        .fetch_optional(&pool)
        .await
        .expect("query")
        .flatten();
        let detail = detail.expect("claim_issued event must exist");

        assert!(
            detail.contains(&hash),
            "event detail should record the token hash for operator triage"
        );
        assert!(
            !detail.contains("\"token\""),
            "event detail must not contain a raw 'token' field; found: {detail}"
        );
    }

    /// Password vaults pre-seed `claim_token_hash` AND `claim_token_at_rest_b64`
    /// at creation time, because the heir's xprv ciphertext is sealed
    /// under a KEK derived from that exact token (HKDF-SHA256). When
    /// the scheduler fires, it must reuse the stored token rather than
    /// re-minting — otherwise the heir's URL fragment would no longer
    /// unwrap the sealed blob.
    #[tokio::test]
    async fn password_vault_reuses_at_rest_token_on_trigger() {
        let pool = fresh_db().await;
        let state = AppState {
            db: pool.clone(),
            lightning: std::sync::Arc::new(crate::lightning::NoopProvider),
        };
        insert_vault(
            &pool,
            "vault-pw",
            "alarmed",
            "2026-04-01T00:00:00Z",
            Some("2026-04-08T00:00:00Z"),
        )
        .await;
        // Simulate the create-time write: both hash + raw token on disk.
        let stored_hash = "deadbeef".repeat(8); // 64 hex chars
        let stored_raw = "raw-token-shipped-by-browser-at-setup";
        sqlx::query(
            r#"UPDATE vaults
                  SET claim_token_hash       = ?,
                      claim_token_at_rest_b64 = ?
                WHERE id = ?"#,
        )
        .bind(&stored_hash)
        .bind(stored_raw)
        .bind("vault-pw")
        .execute(&pool)
        .await
        .unwrap();

        tick_once(&state).await.expect("tick");

        let (status, hash) = read_status_and_token_hash(&pool, "vault-pw").await;
        assert_eq!(
            status, "timelock_started",
            "password vaults must advance to timelock_started"
        );
        assert_eq!(
            hash.as_deref(),
            Some(stored_hash.as_str()),
            "claim_token_hash must NOT be overwritten for password vaults"
        );

        // The reused reason should appear in the event detail so
        // operators can distinguish password-vault triggers from
        // legacy ones.
        let detail: Option<String> = sqlx::query_scalar(
            "SELECT detail FROM events WHERE vault_id = ? AND kind = 'claim_issued'",
        )
        .bind("vault-pw")
        .fetch_optional(&pool)
        .await
        .expect("query")
        .flatten();
        let detail = detail.expect("claim_issued event must exist");
        assert!(
            detail.contains("reused_password_vault_token"),
            "event detail should record the reused-token reason; got: {detail}"
        );
    }

    /* ---------------------------------------------------------------- *
     *  Owner-alarm notification tests                                  *
     *                                                                  *
     *  Wired in 20260527. Pin the contract:                            *
     *    - vault with sealed owner contact enqueues a notification     *
     *      the first time it goes ok -> alarmed,                       *
     *    - vault without one transitions silently (no enqueue), so     *
     *      legacy rows from before the migration still alarm cleanly.  *
     * ---------------------------------------------------------------- */

    /// Tests in this file talk to `crypto::seal_for_vault`, which
    /// requires GHOSTKEY_MASTER_KEY to be set in the process env.
    /// We default to 32 zero bytes (base64) and let `OnceLock` pin
    /// the value on first call. Same pattern as `crypto::tests` and
    /// `auth::http_tests`.
    fn ensure_test_master_key() {
        use base64::Engine;
        if std::env::var("GHOSTKEY_MASTER_KEY").is_err() {
            let zeros = [0u8; 32];
            let b64 = base64::engine::general_purpose::STANDARD_NO_PAD.encode(zeros);
            // SAFETY: tests are single-process; the value is fixed.
            unsafe {
                std::env::set_var("GHOSTKEY_MASTER_KEY", &b64);
            }
        }
        let _ = crate::crypto::ensure_master_key_loaded();
    }

    /// Insert a vault row with a sealed owner-contact pair so the
    /// scheduler's enqueue path has something to encrypt to.
    async fn insert_vault_with_sealed_owner(
        pool: &SqlitePool,
        id: &str,
        status: &str,
        next_deadline_at: &str,
        claim_eligible_at: &str,
        owner_email_pt: &str,
    ) {
        let sealed = crate::crypto::seal_for_vault(id, owner_email_pt.as_bytes())
            .expect("seal owner contact");
        sqlx::query(
            r#"INSERT INTO vaults (
                id, network,
                descriptor_external, descriptor_internal,
                timelock_blocks,
                checkin_period_secs, grace_period_secs,
                created_at, next_deadline_at, status,
                claim_eligible_at,
                owner_contact_ciphertext, owner_contact_nonce, owner_contact_channel
            ) VALUES (?, 'regtest', ?, ?, 144, 86400, 3600,
                      '2026-01-01T00:00:00Z', ?, ?, ?,
                      ?, ?, 'email')"#,
        )
        .bind(id)
        .bind(format!("tr(fake/{id}/0/*)"))
        .bind(format!("tr(fake/{id}/1/*)"))
        .bind(next_deadline_at)
        .bind(status)
        .bind(claim_eligible_at)
        .bind(&sealed.ciphertext_b64)
        .bind(&sealed.nonce_b64)
        .execute(pool)
        .await
        .expect("insert vault with sealed owner contact");
    }

    /// Vault with sealed owner contact: alarm enqueues exactly one
    /// `alarm_owner` notification. Channel is email; recipient is
    /// the plaintext we sealed at insert time.
    #[tokio::test]
    async fn alarm_enqueues_owner_notification_when_sealed_contact_present() {
        ensure_test_master_key();
        let pool = fresh_db().await;
        let state = AppState {
            db: pool.clone(),
            lightning: std::sync::Arc::new(crate::lightning::NoopProvider),
        };
        insert_vault_with_sealed_owner(
            &pool,
            "vault-ow1",
            "ok",
            "2026-04-01T00:00:00Z", // deadline in the past
            "2030-01-01T00:00:00Z",
            "alice@example.test",
        )
        .await;

        tick_once(&state).await.expect("tick");

        // Status transitioned.
        let (status, _) = read_status_and_token_hash(&pool, "vault-ow1").await;
        assert_eq!(status, "alarmed");

        // Exactly one alarm_owner row queued.
        let (kind, channel, status_n, ct, nn): (String, String, String, String, String) =
            sqlx::query_as(
                "SELECT kind, channel, status, recipient_ciphertext, recipient_nonce \
                 FROM notifications WHERE vault_id = 'vault-ow1'",
            )
            .fetch_one(&pool)
            .await
            .expect("notification row");
        assert_eq!(kind, "alarm_owner");
        assert_eq!(channel, "email");
        assert_eq!(status_n, "pending");

        // Recipient ciphertext decrypts back to the plaintext we sealed.
        let opened = crate::crypto::open_for_vault(
            "vault-ow1",
            &crate::crypto::SealedContact {
                ciphertext_b64: ct,
                nonce_b64: nn,
            },
        )
        .expect("decrypt recipient");
        assert_eq!(opened, b"alice@example.test");
    }

    /// Legacy / no-owner-contact vault: alarm still transitions, but
    /// no notification is enqueued. This is the "skip is not an
    /// error" path; regressions here would either crash the
    /// scheduler on every legacy row or enqueue empty emails.
    #[tokio::test]
    async fn alarm_skips_owner_notification_when_no_sealed_contact() {
        ensure_test_master_key();
        let pool = fresh_db().await;
        let state = AppState {
            db: pool.clone(),
            lightning: std::sync::Arc::new(crate::lightning::NoopProvider),
        };
        // Use the existing helper (no sealed columns populated).
        insert_vault(
            &pool,
            "vault-ow2",
            "ok",
            "2026-04-01T00:00:00Z",
            Some("2030-01-01T00:00:00Z"),
        )
        .await;

        tick_once(&state).await.expect("tick");

        let (status, _) = read_status_and_token_hash(&pool, "vault-ow2").await;
        assert_eq!(status, "alarmed");

        let n: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM notifications WHERE vault_id = 'vault-ow2'")
                .fetch_one(&pool)
                .await
                .expect("count");
        assert_eq!(
            n, 0,
            "no owner notification should be enqueued for legacy rows"
        );
    }

    /// A second tick after the transition must NOT enqueue another
    /// owner notification. The `WHERE status = 'ok'` predicate in
    /// `transition_ok_to_alarmed` is what guarantees this; the test
    /// pins that guarantee against an accidental switch to e.g.
    /// `status IN ('ok','alarmed')`.
    #[tokio::test]
    async fn alarm_does_not_re_enqueue_on_subsequent_ticks() {
        ensure_test_master_key();
        let pool = fresh_db().await;
        let state = AppState {
            db: pool.clone(),
            lightning: std::sync::Arc::new(crate::lightning::NoopProvider),
        };
        insert_vault_with_sealed_owner(
            &pool,
            "vault-ow3",
            "ok",
            "2026-04-01T00:00:00Z",
            "2030-01-01T00:00:00Z",
            "bob@example.test",
        )
        .await;

        tick_once(&state).await.expect("first tick");
        tick_once(&state).await.expect("second tick");
        tick_once(&state).await.expect("third tick");

        let n: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM notifications WHERE vault_id = 'vault-ow3' AND kind = 'alarm_owner'",
        )
        .fetch_one(&pool)
        .await
        .expect("count");
        assert_eq!(
            n, 1,
            "exactly one alarm_owner notification per ok->alarmed transition"
        );
    }
}
