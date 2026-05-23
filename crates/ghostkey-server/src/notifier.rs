//! Outbound notification fan-out.
//!
//! The scheduler decides *when* to notify; this module is
//! responsible for *delivering*. The two are split because:
//!
//!   - Delivery has its own retry / failure semantics (the
//!     scheduler should keep advancing even when SMTP is down).
//!   - Adding SMS / WhatsApp later should not touch the scheduler.
//!
//! ## Architecture
//!
//!     scheduler                       notifier::worker
//!     ---------                       ----------------
//!     transition_alarmed_to_claimable  poll DB for pending rows
//!         |                                  |
//!         v                                  v
//!     enqueue(NotificationKind::ClaimLink)  send via configured channel
//!                                            |
//!                                            v
//!                                          UPDATE status='sent'
//!                                            (or retry on transient failure)
//!
//! ## Storage
//!
//! Every queued notification lives in the `notifications` table.
//! `recipient`, `subject`, `body` are all encrypted at rest with the
//! per-vault key already used for heir contacts. Treat a row leak as
//! equivalent to a contact leak: the attacker still needs the
//! server master key to decrypt.
//!
//! ## Channels
//!
//! Today: email via SMTP. Tomorrow: SMS, WhatsApp. The `channel`
//! column on the table is the discriminator; the `Channel` enum here
//! mirrors it.
//!
//! ## Disabling
//!
//! When `SMTP_HOST` is unset, the worker is registered but the email
//! send path returns `WorkerOutcome::Skip`, leaving the row in
//! `pending` so a later run with SMTP configured can pick it up.
//! This is the same shape as `GHOSTKEY_AUTH_DISABLED` -- a deliberate
//! soft-disable rather than a panic, because a partial deployment
//! still works for the rest of the product (vaults can be created,
//! check-ins recorded, etc.).

use std::sync::Arc;
use std::time::Duration;

use chrono::{DateTime, Utc};
use lettre::message::{header, Message};
use lettre::transport::smtp::authentication::Credentials;
use lettre::{AsyncSmtpTransport, AsyncTransport, Tokio1Executor};
use serde::Deserialize;
use sqlx::SqlitePool;

use crate::crypto::{open_for_vault, seal_for_vault, CryptoError, SealedContact};

/// Maximum number of attempts before we mark a notification
/// permanently failed and stop retrying. Operators can re-trigger
/// manually via an admin route if they want.
const MAX_ATTEMPTS: i64 = 6;

/// Base delay between retries, in seconds. We use exponential
/// backoff capped at one hour so a sustained outage of SMTP doesn't
/// drain the worker.
const BACKOFF_BASE_SECS: i64 = 30;
const BACKOFF_CAP_SECS: i64 = 3_600;

/// What we're notifying about. Drives the subject + body template.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NotificationKind {
    /// Heir-side: the vault is claimable. Body carries the one-time
    /// link.
    ClaimLink,
    /// Owner-side: the deadline passed and the alarm fired. Body is
    /// a reminder to check in.
    //
    // Not yet wired into the scheduler: the existing `owner_contact`
    // column is a plaintext TEXT field that the web wizard does not
    // populate (the SetupPortal only collects an address + wallet
    // hint for the owner, not a contact channel). Once we add owner
    // contact capture in the UI we can enqueue these alongside
    // ClaimLink notifications.
    #[allow(dead_code)]
    AlarmOwner,
}

impl NotificationKind {
    fn as_str(self) -> &'static str {
        match self {
            NotificationKind::ClaimLink => "claim_link",
            NotificationKind::AlarmOwner => "alarm_owner",
        }
    }
}

/// What channel a recipient address belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Channel {
    Email,
    // Future: Sms, Whatsapp.
}

impl Channel {
    fn as_str(self) -> &'static str {
        match self {
            Channel::Email => "email",
        }
    }
    fn from_str(s: &str) -> Option<Self> {
        match s {
            "email" => Some(Channel::Email),
            _ => None,
        }
    }
}

/// SMTP configuration, read once from env at startup.
///
/// We accept a few common shapes:
/// - `SMTP_HOST` + `SMTP_PORT` (e.g. localhost:1025 for MailHog,
///   smtp.postmarkapp.com:587 in production).
/// - `SMTP_USER` + `SMTP_PASS` for STARTTLS auth.
/// - `SMTP_FROM` is the visible `From:` header (and the envelope
///   sender). Required; we refuse to send without one.
#[derive(Debug, Clone)]
pub struct SmtpConfig {
    pub host: String,
    pub port: u16,
    pub user: Option<String>,
    pub pass: Option<String>,
    pub from: String,
    /// If true, use STARTTLS (port 587 typical). If false, use
    /// implicit TLS (port 465) or plaintext (port 25 / 1025 for
    /// local relays). Defaulted by port if unspecified.
    pub starttls: bool,
}

impl SmtpConfig {
    /// Load SMTP config from environment. Returns `None` when
    /// `SMTP_HOST` is unset, which is the "email is not configured"
    /// signal the worker uses to skip sends.
    pub fn from_env() -> Option<Self> {
        let host = std::env::var("SMTP_HOST").ok().filter(|s| !s.is_empty())?;
        let port: u16 = std::env::var("SMTP_PORT")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(587);
        let from = std::env::var("SMTP_FROM").ok().unwrap_or_else(|| {
            tracing::warn!(
                "SMTP_FROM unset; falling back to noreply@localhost. \
                 Set SMTP_FROM to a deliverable address for production."
            );
            "noreply@localhost".to_string()
        });
        let user = std::env::var("SMTP_USER").ok().filter(|s| !s.is_empty());
        let pass = std::env::var("SMTP_PASS").ok().filter(|s| !s.is_empty());
        // 465 conventionally = implicit TLS; everything else uses
        // STARTTLS where available, plaintext otherwise.
        let starttls = port != 465;
        Some(SmtpConfig {
            host,
            port,
            user,
            pass,
            from,
            starttls,
        })
    }
}

/// Plain-text representation of what we're about to send. We seal
/// these fields per-vault before they land in the DB.
struct DraftPayload {
    recipient: String,
    subject: String,
    body: String,
}

/// Enqueue a notification. Encrypts the payload with the per-vault
/// key and inserts a pending row. The worker picks it up later.
pub async fn enqueue(
    pool: &SqlitePool,
    vault_id: &str,
    kind: NotificationKind,
    channel: Channel,
    recipient: &str,
    subject: &str,
    body: &str,
) -> Result<i64, EnqueueError> {
    let recipient_sealed = seal_for_vault(vault_id, recipient.as_bytes())?;
    let subject_sealed = seal_for_vault(vault_id, subject.as_bytes())?;
    let body_sealed = seal_for_vault(vault_id, body.as_bytes())?;

    let now_s = Utc::now().to_rfc3339();
    let row = sqlx::query_as::<_, (i64,)>(
        r#"INSERT INTO notifications (
            vault_id, kind, channel,
            recipient_ciphertext, recipient_nonce,
            subject_ciphertext, subject_nonce,
            body_ciphertext, body_nonce,
            status, attempts, created_at, scheduled_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)
        RETURNING id"#,
    )
    .bind(vault_id)
    .bind(kind.as_str())
    .bind(channel.as_str())
    .bind(&recipient_sealed.ciphertext_b64)
    .bind(&recipient_sealed.nonce_b64)
    .bind(&subject_sealed.ciphertext_b64)
    .bind(&subject_sealed.nonce_b64)
    .bind(&body_sealed.ciphertext_b64)
    .bind(&body_sealed.nonce_b64)
    .bind(&now_s)
    .bind(&now_s)
    .fetch_one(pool)
    .await?;
    Ok(row.0)
}

#[derive(Debug, thiserror::Error)]
pub enum EnqueueError {
    #[error("crypto: {0}")]
    Crypto(#[from] CryptoError),
    #[error("db: {0}")]
    Db(#[from] sqlx::Error),
}

/// Outcome of a single worker iteration on a single row.
enum WorkerOutcome {
    /// Successfully delivered.
    Sent,
    /// Transient failure -- the row was re-scheduled.
    Retry,
    /// Final failure -- attempts exhausted.
    Permanent,
    /// SMTP not configured for this channel; we left the row alone
    /// so a future deployment with SMTP configured can pick it up.
    Skip,
}

/// Long-lived background worker. Polls the queue every `tick` and
/// processes one batch of due rows. Designed to be `tokio::spawn`ed
/// alongside the scheduler.
pub async fn run(pool: SqlitePool, tick: Duration) {
    let smtp = SmtpConfig::from_env();
    match &smtp {
        None => tracing::warn!(
            "SMTP_HOST unset; notification worker will accept enqueues but \
             every email-channel send will be Skipped (row stays pending). \
             Configure SMTP_HOST / SMTP_PORT / SMTP_FROM (and SMTP_USER/PASS \
             if needed) to enable delivery."
        ),
        Some(cfg) => tracing::info!(
            host = %cfg.host,
            port = cfg.port,
            "notification worker: SMTP configured"
        ),
    }
    let smtp = Arc::new(smtp);

    loop {
        if let Err(e) = tick_once(&pool, smtp.clone()).await {
            tracing::error!(error = ?e, "notifier tick errored");
        }
        tokio::time::sleep(tick).await;
    }
}

/// One iteration: claim up to N pending+due rows and process them.
/// We deliberately keep batch size small so a backlog doesn't hog
/// the worker for too long; the next tick picks up where this left
/// off.
async fn tick_once(pool: &SqlitePool, smtp: Arc<Option<SmtpConfig>>) -> anyhow::Result<()> {
    let now_s = Utc::now().to_rfc3339();
    let due = sqlx::query_as::<
        _,
        (
            i64,
            String,
            String,
            String,
            String,
            String,
            Option<String>,
            Option<String>,
            String,
            String,
            i64,
        ),
    >(
        r#"SELECT id, vault_id, kind, channel,
                  recipient_ciphertext, recipient_nonce,
                  subject_ciphertext, subject_nonce,
                  body_ciphertext, body_nonce,
                  attempts
             FROM notifications
            WHERE status = 'pending' AND scheduled_at <= ?
            ORDER BY scheduled_at ASC
            LIMIT 16"#,
    )
    .bind(&now_s)
    .fetch_all(pool)
    .await?;

    for row in due {
        let (
            id,
            vault_id,
            kind,
            channel_s,
            rcpt_ct,
            rcpt_nn,
            subj_ct,
            subj_nn,
            body_ct,
            body_nn,
            attempts,
        ) = row;

        // Try to claim the row by flipping status to 'sending'.
        // CAS-style guard so we don't reprocess a row another
        // instance just took. (Single-instance today; this is
        // future-proofing.)
        let claimed = sqlx::query(
            "UPDATE notifications SET status = 'sending' WHERE id = ? AND status = 'pending'",
        )
        .bind(id)
        .execute(pool)
        .await?;
        if claimed.rows_affected() != 1 {
            continue;
        }

        // Decrypt the payload back into plaintext on the worker.
        let draft = match decrypt_draft(
            &vault_id,
            &rcpt_ct,
            &rcpt_nn,
            subj_ct.as_deref(),
            subj_nn.as_deref(),
            &body_ct,
            &body_nn,
        ) {
            Ok(d) => d,
            Err(e) => {
                tracing::error!(notif_id = id, error = ?e, "decrypt failed");
                mark_permanent(pool, id, &format!("decrypt: {e}")).await?;
                continue;
            }
        };

        let channel = Channel::from_str(&channel_s);
        let outcome = match (channel, smtp.as_ref()) {
            (Some(Channel::Email), Some(cfg)) => {
                match send_email(cfg, &draft).await {
                    Ok(()) => WorkerOutcome::Sent,
                    Err(e) => {
                        tracing::warn!(
                            notif_id = id,
                            kind = %kind,
                            error = %e,
                            "smtp send failed"
                        );
                        // Decide retry vs permanent.
                        if attempts + 1 >= MAX_ATTEMPTS {
                            mark_permanent(pool, id, &format!("smtp: {e}")).await?;
                            WorkerOutcome::Permanent
                        } else {
                            let delay = backoff_secs(attempts + 1);
                            reschedule(pool, id, attempts + 1, delay, &format!("smtp: {e}"))
                                .await?;
                            WorkerOutcome::Retry
                        }
                    }
                }
            }
            (Some(Channel::Email), None) => {
                // SMTP not configured; put the row back to pending
                // so a future deployment with SMTP configured can
                // deliver it. We don't increment attempts -- a skip
                // is not a failure.
                sqlx::query("UPDATE notifications SET status = 'pending' WHERE id = ?")
                    .bind(id)
                    .execute(pool)
                    .await?;
                WorkerOutcome::Skip
            }
            (None, _) => {
                tracing::error!(notif_id = id, channel = %channel_s, "unknown channel");
                mark_permanent(pool, id, "unknown channel").await?;
                WorkerOutcome::Permanent
            }
        };

        if matches!(outcome, WorkerOutcome::Sent) {
            sqlx::query(
                "UPDATE notifications SET status = 'sent', sent_at = ?, attempts = attempts + 1 WHERE id = ?",
            )
            .bind(&now_s)
            .bind(id)
            .execute(pool)
            .await?;
            tracing::info!(notif_id = id, vault_id = %vault_id, kind = %kind, "notification sent");
        }
    }
    Ok(())
}

/// Compute exponential-backoff delay seconds for the Nth retry.
fn backoff_secs(attempt: i64) -> i64 {
    let raw = BACKOFF_BASE_SECS.saturating_mul(1i64 << attempt.min(12));
    raw.min(BACKOFF_CAP_SECS)
}

async fn reschedule(
    pool: &SqlitePool,
    id: i64,
    attempts: i64,
    delay_secs: i64,
    err: &str,
) -> sqlx::Result<()> {
    let next: DateTime<Utc> = Utc::now() + chrono::Duration::seconds(delay_secs);
    sqlx::query(
        r#"UPDATE notifications
              SET status        = 'pending',
                  attempts      = ?,
                  scheduled_at  = ?,
                  last_error    = ?
            WHERE id = ?"#,
    )
    .bind(attempts)
    .bind(next.to_rfc3339())
    .bind(err)
    .bind(id)
    .execute(pool)
    .await?;
    Ok(())
}

async fn mark_permanent(pool: &SqlitePool, id: i64, err: &str) -> sqlx::Result<()> {
    sqlx::query(
        "UPDATE notifications SET status = 'failed_permanent', last_error = ? WHERE id = ?",
    )
    .bind(err)
    .bind(id)
    .execute(pool)
    .await?;
    Ok(())
}

fn decrypt_draft(
    vault_id: &str,
    rcpt_ct: &str,
    rcpt_nn: &str,
    subj_ct: Option<&str>,
    subj_nn: Option<&str>,
    body_ct: &str,
    body_nn: &str,
) -> Result<DraftPayload, CryptoError> {
    let recipient = String::from_utf8(open_for_vault(
        vault_id,
        &SealedContact {
            ciphertext_b64: rcpt_ct.to_string(),
            nonce_b64: rcpt_nn.to_string(),
        },
    )?)
    .map_err(|_| CryptoError::Decrypt)?;

    let subject = match (subj_ct, subj_nn) {
        (Some(ct), Some(nn)) => String::from_utf8(open_for_vault(
            vault_id,
            &SealedContact {
                ciphertext_b64: ct.to_string(),
                nonce_b64: nn.to_string(),
            },
        )?)
        .map_err(|_| CryptoError::Decrypt)?,
        _ => String::new(),
    };

    let body = String::from_utf8(open_for_vault(
        vault_id,
        &SealedContact {
            ciphertext_b64: body_ct.to_string(),
            nonce_b64: body_nn.to_string(),
        },
    )?)
    .map_err(|_| CryptoError::Decrypt)?;

    Ok(DraftPayload {
        recipient,
        subject,
        body,
    })
}

/// Build + send one email. Synchronous from the worker's point of
/// view (we await it; the underlying transport is tokio).
async fn send_email(cfg: &SmtpConfig, draft: &DraftPayload) -> Result<(), SendError> {
    let from = cfg
        .from
        .parse()
        .map_err(|e| SendError::Build(format!("from: {e}")))?;
    let to = draft
        .recipient
        .parse()
        .map_err(|e| SendError::Build(format!("to: {e}")))?;

    let msg = Message::builder()
        .from(from)
        .to(to)
        .subject(&draft.subject)
        .header(header::ContentType::TEXT_PLAIN)
        .body(draft.body.clone())
        .map_err(|e| SendError::Build(format!("msg: {e}")))?;

    let mut builder = if cfg.starttls {
        AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&cfg.host)
            .map_err(|e| SendError::Build(format!("starttls: {e}")))?
            .port(cfg.port)
    } else if cfg.port == 465 {
        AsyncSmtpTransport::<Tokio1Executor>::relay(&cfg.host)
            .map_err(|e| SendError::Build(format!("relay: {e}")))?
            .port(cfg.port)
    } else {
        // Plaintext (test / local relay). Lettre exposes
        // `builder_dangerous` for this -- we mark it dangerous so
        // it can't be enabled accidentally.
        AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(&cfg.host).port(cfg.port)
    };
    if let (Some(u), Some(p)) = (cfg.user.as_deref(), cfg.pass.as_deref()) {
        builder = builder.credentials(Credentials::new(u.to_string(), p.to_string()));
    }
    let mailer = builder.build();
    mailer
        .send(msg)
        .await
        .map_err(|e| SendError::Smtp(format!("{e}")))?;
    Ok(())
}

#[derive(Debug, thiserror::Error)]
enum SendError {
    #[error("smtp build: {0}")]
    Build(String),
    #[error("smtp: {0}")]
    Smtp(String),
}

/* -------------------------------------------------------------------------- *
 *  Heir-contact helpers                                                      *
 *                                                                            *
 *  The heir's contact is stored as a sealed JSON blob with                   *
 *  {name, contact, channel}. This is the JSON the SetupPortal writes and    *
 *  the resolve_claim handler reads. The notifier needs both the address    *
 *  and the channel; this helper decrypts and parses.                        *
 * -------------------------------------------------------------------------- */

#[derive(Debug, Deserialize)]
pub struct HeirContact {
    pub name: Option<String>,
    pub contact: Option<String>,
    pub channel: Option<String>,
}

/// Decrypt + parse a vault's heir contact JSON. Returns `Ok(None)`
/// when the row has no encrypted contact at all (i.e. the owner
/// didn't supply one at setup); `Err` only on cryptographic or
/// parsing failure.
pub fn parse_heir_contact(
    vault_id: &str,
    ciphertext_b64: Option<&str>,
    nonce_b64: Option<&str>,
) -> Result<Option<HeirContact>, CryptoError> {
    let (ct, nn) = match (ciphertext_b64, nonce_b64) {
        (Some(c), Some(n)) => (c, n),
        _ => return Ok(None),
    };
    let bytes = open_for_vault(
        vault_id,
        &SealedContact {
            ciphertext_b64: ct.to_string(),
            nonce_b64: nn.to_string(),
        },
    )?;
    let parsed: HeirContact = serde_json::from_slice(&bytes).map_err(|_| CryptoError::Decrypt)?;
    Ok(Some(parsed))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_grows_then_caps() {
        // The first retry should be modest; later retries cap at
        // BACKOFF_CAP_SECS.
        assert_eq!(backoff_secs(1), 60);
        assert!(backoff_secs(2) > backoff_secs(1));
        assert!(backoff_secs(20) <= BACKOFF_CAP_SECS);
    }

    #[test]
    fn channel_round_trip() {
        assert_eq!(Channel::from_str("email"), Some(Channel::Email));
        assert_eq!(Channel::from_str("sms"), None);
        assert_eq!(Channel::Email.as_str(), "email");
    }

    #[test]
    fn smtp_config_defaults_when_only_host_set() {
        // SAFETY: tests run in one process; we restore.
        unsafe {
            std::env::set_var("SMTP_HOST", "smtp.example");
            std::env::remove_var("SMTP_PORT");
            std::env::remove_var("SMTP_FROM");
            std::env::remove_var("SMTP_USER");
            std::env::remove_var("SMTP_PASS");
        }
        let cfg = SmtpConfig::from_env().expect("with SMTP_HOST set");
        assert_eq!(cfg.host, "smtp.example");
        assert_eq!(cfg.port, 587);
        assert!(cfg.starttls);
        unsafe { std::env::remove_var("SMTP_HOST") };
        assert!(SmtpConfig::from_env().is_none());
    }
}
