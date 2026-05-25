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
use crate::notifier::{self, parse_heir_contact, Channel, NotificationKind};
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
async fn transition_ok_to_alarmed(state: &AppState, now_iso: &str) -> anyhow::Result<()> {
    let due = sqlx::query_as::<_, (String,)>(
        "SELECT id FROM vaults WHERE status = 'ok' AND next_deadline_at <= ?",
    )
    .bind(now_iso)
    .fetch_all(&state.db)
    .await?;

    for (id,) in due {
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
    }

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
        let state = AppState { db: pool.clone() };
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
        let state = AppState { db: pool.clone() };
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
        let state = AppState { db: pool.clone() };
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
        let state = AppState { db: pool.clone() };
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
        let state = AppState { db: pool.clone() };
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
        let state = AppState { db: pool.clone() };
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
}
