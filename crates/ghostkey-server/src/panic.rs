//! Panic stop: freeze a vault for [`PANIC_FREEZE_DAYS`].
//!
//! The owner uses this when they think a password, device or wallet has
//! been compromised. While frozen, no claim can proceed: any claim link
//! in flight is revoked and the reminder cycle is cleared. The freeze
//! lifts by itself after the window (see the scheduler), and the trusted
//! contact, if one is on file, is told to check on the owner.
//!
//! It used to be triggered by paying a Lightning invoice. It is now a
//! plain signed-in action (`POST /vaults/:id/panic`), free like the
//! check-in. The freeze itself lives here so every trigger does exactly
//! the same thing.

use std::sync::Arc;

use axum::{extract::State, Json};
use chrono::{DateTime, Utc};
use serde::Serialize;

use crate::auth::OwnerAuth;
use crate::routes::{record_event, ApiError};
use crate::AppState;

/// How long a panic stop keeps the vault frozen.
pub const PANIC_FREEZE_DAYS: i64 = 90;

/// Freeze the vault inside the caller's transaction. Returns false when
/// nothing was frozen because the heir already claimed: the coins are
/// gone, and freezing would erase the claim record.
pub(crate) async fn freeze_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    vault_id: &str,
    frozen_until: &str,
) -> sqlx::Result<bool> {
    let frozen = sqlx::query(
        r#"UPDATE vaults
              SET status                       = 'frozen',
                  panic_frozen_until           = ?,
                  claim_token_hash             = NULL,
                  claim_token_issued_at        = NULL,
                  claim_token_used_at          = NULL,
                  claim_opened_at              = NULL,
                  claim_ready_notified_at      = NULL,
                  pre_deadline_reminder_sent_at = NULL,
                  last_alarm_reminder_sent_at  = NULL,
                  alarm_reminder_count          = 0,
                  checkin_link_token_hash      = NULL,
                  checkin_link_token_issued_at = NULL,
                  checkin_link_token_used_at   = NULL
            WHERE id = ?
              AND status != 'claimed'"#,
    )
    .bind(frozen_until)
    .bind(vault_id)
    .execute(&mut **tx)
    .await?;
    Ok(frozen.rows_affected() > 0)
}

/// Everything that follows a committed freeze: the audit event and the
/// trusted-contact alert. The alert is best-effort, because the freeze
/// has already happened and must not be undone by a notifier error.
pub(crate) async fn after_freeze(
    db: &sqlx::SqlitePool,
    vault_id: &str,
    frozen_until: &str,
    source: &str,
) -> Result<(), sqlx::Error> {
    record_event(
        db,
        vault_id,
        "panic_activated",
        Some(serde_json::json!({
            "source": source,
            "frozen_until": frozen_until,
        })),
    )
    .await?;
    tracing::warn!(
        vault_id = %vault_id,
        frozen_until = %frozen_until,
        source = %source,
        "panic stop: vault frozen"
    );
    if let Err(e) = notify_trusted_contact_of_panic(db, vault_id).await {
        tracing::warn!(
            vault_id = %vault_id,
            error = ?e,
            "panic alert to trusted contact could not be enqueued"
        );
    }
    Ok(())
}

/// Enqueue the panic alert promised by the dashboard's emergency-stop
/// copy. The trusted contact learns nothing about the vault (no label,
/// no amounts), only that someone they know hit the alarm.
pub(crate) async fn notify_trusted_contact_of_panic(
    db: &sqlx::SqlitePool,
    vault_id: &str,
) -> anyhow::Result<()> {
    let row: Option<(Option<String>, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT trusted_contact_ciphertext, trusted_contact_nonce, trusted_contact_channel \
           FROM vaults WHERE id = ?",
    )
    .bind(vault_id)
    .fetch_optional(db)
    .await?;
    let Some((ct, nn, ch)) = row else {
        return Ok(());
    };
    let Some(trusted) = crate::notifier::parse_owner_contact(
        vault_id,
        ct.as_deref(),
        nn.as_deref(),
        ch.as_deref(),
    )?
    else {
        tracing::info!(vault_id = %vault_id, "no trusted contact on file; panic alert skipped");
        return Ok(());
    };
    let body = "Someone you know named you as their emergency contact on \
                GhostKey, a service that protects their Bitcoin.\n\n\
                They just triggered an emergency freeze on their account. \
                People usually do this when they think a password or device \
                of theirs has been compromised, or when something feels \
                wrong.\n\n\
                Please check on them.\n\n\
                From GhostKey";
    crate::notifier::enqueue(
        db,
        vault_id,
        crate::notifier::NotificationKind::PanicAlert,
        trusted.channel,
        &trusted.address,
        "Someone named you as their emergency contact. Please check on them",
        body,
    )
    .await?;
    tracing::info!(vault_id = %vault_id, "panic alert to trusted contact enqueued");
    Ok(())
}

#[derive(Debug, Serialize)]
pub struct PanicResponse {
    pub vault_id: String,
    pub status: String,
    pub frozen_until: DateTime<Utc>,
}

/// `POST /vaults/:id/panic`: the owner freezes their own vault.
///
/// Refused when the heir already claimed (nothing left to protect) and
/// when the vault is already frozen (a second tap must not quietly
/// extend the window or alert the trusted contact twice).
pub async fn panic_stop(
    auth: OwnerAuth,
    State(state): State<Arc<AppState>>,
) -> Result<Json<PanicResponse>, ApiError> {
    let id = auth.vault_id;
    let status: Option<String> = sqlx::query_scalar("SELECT status FROM vaults WHERE id = ?")
        .bind(&id)
        .fetch_optional(&state.db)
        .await?;
    let status = status.ok_or(ApiError::NotFound)?;
    match status.as_str() {
        "claimed" => {
            return Err(ApiError::Conflict(
                "This share has already been claimed, so there is nothing left to freeze.".into(),
            ))
        }
        "frozen" => return Err(ApiError::Conflict("This share is already frozen.".into())),
        _ => {}
    }

    let frozen_until = Utc::now() + chrono::Duration::days(PANIC_FREEZE_DAYS);
    let frozen_until_s = frozen_until.to_rfc3339();
    let mut tx = state.db.begin().await?;
    let frozen = freeze_in_tx(&mut tx, &id, &frozen_until_s).await?;
    tx.commit().await?;
    if !frozen {
        // The heir claimed between our read and the update.
        return Err(ApiError::Conflict(
            "This share has already been claimed, so there is nothing left to freeze.".into(),
        ));
    }
    after_freeze(&state.db, &id, &frozen_until_s, "owner").await?;

    Ok(Json(PanicResponse {
        vault_id: id,
        status: "frozen".into(),
        frozen_until,
    }))
}

/* -------------------------------------------------------------------------- *
 *  PUT /vaults/:id/trusted-contact                                           *
 *                                                                            *
 *  Add, change or remove the emergency contact: the one person told when the *
 *  owner triggers a panic stop. Setup no longer asks for it, so this is the  *
 *  only way to set it. Sealed at rest like every other contact; email only,  *
 *  the one channel that delivers.                                            *
 * -------------------------------------------------------------------------- */

#[derive(Debug, serde::Deserialize)]
pub struct TrustedContactRequest {
    /// The contact's email. Empty or absent removes it.
    #[serde(default)]
    pub contact: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct TrustedContactView {
    pub has_trusted_contact: bool,
}

pub async fn put_trusted_contact(
    auth: OwnerAuth,
    State(state): State<Arc<AppState>>,
    Json(req): Json<TrustedContactRequest>,
) -> Result<Json<TrustedContactView>, ApiError> {
    let id = auth.vault_id;
    let contact = req
        .contact
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    match contact {
        Some(c) => {
            let shaped = c.chars().count() <= 254
                && c.split_once('@')
                    .is_some_and(|(user, host)| !user.is_empty() && host.contains('.'))
                && !c.chars().any(char::is_whitespace);
            if !shaped {
                return Err(ApiError::Validation(
                    "That email looks off. Double-check it.".into(),
                ));
            }
            let sealed = crate::crypto::seal_for_vault(&id, c.as_bytes())?;
            sqlx::query(
                "UPDATE vaults SET trusted_contact_ciphertext = ?, trusted_contact_nonce = ?, \
                        trusted_contact_channel = 'email' WHERE id = ?",
            )
            .bind(&sealed.ciphertext_b64)
            .bind(&sealed.nonce_b64)
            .bind(&id)
            .execute(&state.db)
            .await?;
            record_event(&state.db, &id, "trusted_contact_set", None).await?;
        }
        None => {
            sqlx::query(
                "UPDATE vaults SET trusted_contact_ciphertext = NULL, trusted_contact_nonce = NULL, \
                        trusted_contact_channel = NULL WHERE id = ?",
            )
            .bind(&id)
            .execute(&state.db)
            .await?;
            record_event(&state.db, &id, "trusted_contact_removed", None).await?;
        }
    }
    Ok(Json(TrustedContactView {
        has_trusted_contact: contact.is_some(),
    }))
}
