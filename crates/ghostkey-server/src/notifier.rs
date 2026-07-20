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
    /// a reminder that they missed the check-in and that the heir
    /// will be contacted after `claim_eligible_at` unless they act.
    ///
    /// Wired into [`crate::scheduler::transition_ok_to_alarmed`] as
    /// of 20260527: every vault that has an `owner_contact_*` sealed
    /// pair (set by the web setup wizard) gets one of these enqueued
    /// the first time it transitions from `ok` to `alarmed`. Vaults
    /// created before that migration (or via the legacy `POST /vaults`
    /// CLI route, which writes the plaintext column) don't have a
    /// sealed contact and skip silently.
    AlarmOwner,
    /// Owner-side, BEFORE the deadline: "your check-in is due in 24h".
    /// Friendly nudge that lands while the owner still has a full
    /// day of slack to act. Wired into
    /// [`crate::scheduler::issue_pre_deadline_reminders`] (20260528).
    /// At most one per check-in cycle; the scheduler tracks this via
    /// `vaults.pre_deadline_reminder_sent_at`, which is cleared on
    /// every successful check-in.
    PreDeadlineReminder,
    /// Owner-side, RECURRING during the alarmed window: "you have N
    /// days left to check in before your heir is notified". Fired
    /// daily by [`crate::scheduler::send_alarm_escalations`]; the
    /// `last_alarm_reminder_sent_at` column gates re-fire and is
    /// cleared on every successful check-in.
    AlarmEscalation,
    /// Owner-side, once at vault creation (and on owner-requested
    /// resend): "tap to confirm this address receives our mail."
    /// Closing the loop sets `vaults.owner_contact_verified_at`;
    /// see the 20260610000002 migration for why this matters.
    ContactVerification,
    /// Owner-side (and trusted-contact-side), the moment anyone first
    /// opens the claim link: "a claim on your vault has started; if
    /// you're alive, one check-in stops it." Fired from
    /// [`crate::routes::ensure_claim_challenge`]; `vaults.claim_opened_at`
    /// guarantees at-most-once per claim cycle.
    ClaimOpened,
    /// Trusted-contact-side, when the owner triggers a panic stop:
    /// "someone you know froze their account — check on them." Fired
    /// from [`crate::lightning::mark_panic_paid`]. This is the alert
    /// the dashboard has promised since F4; see issue #70.
    PanicAlert,
    /// Heir-side, once the claim-challenge window has elapsed without
    /// the owner objecting: "you can finish your claim now." Fired by
    /// the scheduler; `vaults.claim_ready_notified_at` dedupes.
    ClaimReady,
    /// Heir-side, when the owner starts a claim fire drill (#223):
    /// "nothing has happened — this is a practice run." Fired from
    /// [`crate::drill::start_drill`].
    DrillInvite,
    /// Owner-side, when the heir finishes the practice claim: "the
    /// rehearsal worked, nothing moved." Fired from
    /// [`crate::drill::complete_drill`]; `vaults.drill_completed_at`
    /// dedupes.
    DrillCompleted,
    /// Owner-side, once, the moment the owner confirms their email:
    /// "welcome, here is what happens next." Includes the fund-your-
    /// vault next step while the vault is still unfunded. Fired from
    /// the verify-contact route; at most once because a vault only
    /// transitions to verified once (siblings inherit the flag
    /// without re-verifying, so they never fire it).
    Welcome,
    /// Owner-side, once, when the chain scan first finds coins and
    /// the scheduler flips the vault unfunded -> ok: "your check-in
    /// clock has started." Fired from
    /// [`crate::scheduler`]'s `activate_funded_vaults`.
    Funded,
    /// Owner-side, when a chain scan finds a NEW confirmed deposit
    /// after the first (the first is covered by [`Self::Funded`]).
    /// Deliberately amount-free: the dashboard has the numbers, and
    /// email is the least private place to put them.
    Received,
    /// Owner-side, right after an owner send is broadcast. Doubles
    /// as a theft alarm: a send the owner didn't make means the
    /// vault password has leaked.
    OwnerSend,
    /// Owner-side, on a cross-device sign-in request. The link contains
    /// a short-lived, single-use recovery challenge; no vault metadata
    /// is returned until that challenge is redeemed.
    OwnerRecovery,
}

impl NotificationKind {
    fn as_str(self) -> &'static str {
        match self {
            NotificationKind::ClaimLink => "claim_link",
            NotificationKind::AlarmOwner => "alarm_owner",
            NotificationKind::PreDeadlineReminder => "pre_deadline_reminder",
            NotificationKind::AlarmEscalation => "alarm_escalation",
            NotificationKind::ContactVerification => "contact_verification",
            NotificationKind::ClaimOpened => "claim_opened",
            NotificationKind::PanicAlert => "panic_alert",
            NotificationKind::ClaimReady => "claim_ready",
            NotificationKind::DrillInvite => "drill_invite",
            NotificationKind::DrillCompleted => "drill_completed",
            NotificationKind::Welcome => "welcome",
            NotificationKind::Funded => "funded",
            NotificationKind::Received => "received",
            NotificationKind::OwnerSend => "owner_send",
            NotificationKind::OwnerRecovery => "owner_recovery",
        }
    }
}

/// What channel a recipient address belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Channel {
    Email,
    /// Plain SMS over Twilio's Programmable Messaging API.
    Sms,
    /// WhatsApp message via Twilio's WhatsApp Business API (the
    /// `whatsapp:+...` prefix on the wire). Same auth, same
    /// endpoint, different `From` shape; see `send_twilio`.
    Whatsapp,
    /// Browser web push (RFC 8030/8291/8292) via `crate::push`.
    /// Unlike the other channels the `recipient` column is not an
    /// address — delivery fans out to every row in
    /// `push_subscriptions` for the vault, so the enqueuer stores
    /// the literal string "webpush" there. The `body` is a JSON
    /// `{title, body, url}` blob the service worker renders.
    WebPush,
}

impl Channel {
    fn as_str(self) -> &'static str {
        match self {
            Channel::Email => "email",
            Channel::Sms => "sms",
            Channel::Whatsapp => "whatsapp",
            Channel::WebPush => "webpush",
        }
    }
    fn from_str(s: &str) -> Option<Self> {
        match s {
            "email" => Some(Channel::Email),
            "sms" => Some(Channel::Sms),
            "whatsapp" => Some(Channel::Whatsapp),
            "webpush" => Some(Channel::WebPush),
            _ => None,
        }
    }
}

/// SMTP configuration, read once from env at startup.
///
/// We accept a few common shapes:
/// - `SMTP_HOST` + `SMTP_PORT` (e.g. localhost:1025 for MailHog,
///   smtp.postmarkapp.com:587 in production).
/// - `SMTP_USER` + `SMTP_PASS` for auth (`SMTP_USERNAME` /
///   `SMTP_PASSWORD` are accepted as aliases).
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
        // Both naming conventions are widespread (SMTP_USER/SMTP_PASS
        // and SMTP_USERNAME/SMTP_PASSWORD); silently ignoring the
        // longer pair cost a production debugging session — creds were
        // set, mail still bounced 530 unauthenticated. Accept either.
        let env_first = |names: [&str; 2]| {
            names
                .iter()
                .find_map(|n| std::env::var(n).ok().filter(|s| !s.is_empty()))
        };
        let user = env_first(["SMTP_USER", "SMTP_USERNAME"]);
        let pass = env_first(["SMTP_PASS", "SMTP_PASSWORD"]);
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

/// Twilio configuration for SMS and WhatsApp delivery.
///
/// We accept four env vars, all required when SMS or WhatsApp is to
/// be enabled:
///
///   - `TWILIO_ACCOUNT_SID`: `ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`
///   - `TWILIO_AUTH_TOKEN`: the API secret; treat like a password
///   - `TWILIO_SMS_FROM`: `+15551234567` in E.164. Must be a number
///     Twilio has provisioned for you.
///   - `TWILIO_WHATSAPP_FROM`: `+15551234567`. The Twilio sandbox
///     number `+14155238886` works during dev. We prefix `whatsapp:`
///     ourselves on the wire so set this as plain E.164.
///
/// All four must be set to enable delivery on either channel. Setting
/// only some (e.g. SID + auth but no `TWILIO_SMS_FROM`) returns `None`
/// at load time: a partial config is almost always an operator
/// mistake and we'd rather refuse to enable than send half the
/// messages with a NULL `From`.
///
/// This crate uses Twilio's Programmable Messaging REST API
/// (https://www.twilio.com/docs/messaging/api/message-resource).
/// We don't pull in the official twilio crate — the surface we need
/// is a single POST with form-encoded body and HTTP Basic auth, and
/// we already depend on reqwest for the Lightning HttpProvider.
/// Adding a crate would buy us nothing and pin another set of
/// transitive deps.
#[derive(Debug, Clone)]
pub struct TwilioConfig {
    pub account_sid: String,
    pub auth_token: String,
    pub sms_from: String,
    pub whatsapp_from: String,
    /// API base URL. Defaults to `https://api.twilio.com` in prod;
    /// tests override via `TWILIO_API_BASE_URL` to point at an
    /// in-process mock server. Real deployments should never set
    /// this — there's no reason to talk to anything other than the
    /// real Twilio endpoint.
    pub api_base_url: String,
}

impl TwilioConfig {
    /// Load from env. Returns `None` when ANY of the four required
    /// vars is unset/empty, with a single warning enumerating what's
    /// missing so the operator can fix the config in one pass.
    pub fn from_env() -> Option<Self> {
        let sid = std::env::var("TWILIO_ACCOUNT_SID")
            .ok()
            .filter(|s| !s.is_empty());
        let tok = std::env::var("TWILIO_AUTH_TOKEN")
            .ok()
            .filter(|s| !s.is_empty());
        let sms = std::env::var("TWILIO_SMS_FROM")
            .ok()
            .filter(|s| !s.is_empty());
        let wa = std::env::var("TWILIO_WHATSAPP_FROM")
            .ok()
            .filter(|s| !s.is_empty());

        match (sid, tok, sms, wa) {
            (Some(sid), Some(tok), Some(sms), Some(wa)) => Some(TwilioConfig {
                account_sid: sid,
                auth_token: tok,
                sms_from: sms,
                whatsapp_from: wa,
                api_base_url: std::env::var("TWILIO_API_BASE_URL")
                    .unwrap_or_else(|_| "https://api.twilio.com".to_string()),
            }),
            (sid, tok, sms, wa) => {
                // If ALL four are unset we stay silent (this is the
                // normal "Twilio not configured" path). If SOME are
                // set, that's a partial config -- warn loudly because
                // it's almost certainly a deployment mistake.
                let any_set = sid.is_some() || tok.is_some() || sms.is_some() || wa.is_some();
                if any_set {
                    let mut missing: Vec<&str> = Vec::new();
                    if sid.is_none() {
                        missing.push("TWILIO_ACCOUNT_SID");
                    }
                    if tok.is_none() {
                        missing.push("TWILIO_AUTH_TOKEN");
                    }
                    if sms.is_none() {
                        missing.push("TWILIO_SMS_FROM");
                    }
                    if wa.is_none() {
                        missing.push("TWILIO_WHATSAPP_FROM");
                    }
                    tracing::warn!(
                        missing = ?missing,
                        "TWILIO_* env vars are partially set; SMS/WhatsApp \
                         delivery is DISABLED until all four are supplied. \
                         Set the missing vars or unset every TWILIO_* var to \
                         silence this warning."
                    );
                }
                None
            }
        }
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
    // A local demo run usually has no delivery backend at all (no
    // SMTP, no Twilio), so this message would be sealed into the
    // notifications table and never seen — the operator concludes
    // "nothing arrived". Print it so a local demo is self-serve: every
    // contact-verification link and reminder shows up in the server
    // log. The claim link is already logged at issue time in the
    // scheduler (and the docs point at that line), so skip it here to
    // avoid a duplicate. Gated on demo mode, which is forbidden on
    // mainnet — a production server never logs a recipient or link.
    if crate::demo::demo_mode() && !matches!(kind, NotificationKind::ClaimLink) {
        tracing::warn!(
            vault_id = %vault_id,
            kind = %kind.as_str(),
            channel = %channel.as_str(),
            "DEMO MODE notification (no real delivery): to={recipient} | {subject} | {body}"
        );
    }

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
    /// No backend configured for this channel; the row was failed
    /// with a clear `last_error` so the gap is visible (#278).
    Skip,
}

/// Long-lived background worker. Polls the queue every `tick` and
/// processes one batch of due rows. Designed to be `tokio::spawn`ed
/// alongside the scheduler.
/// Delivery configuration bundle. One per worker process. Each
/// inner Option is independent — operators can wire SMTP without
/// Twilio (or vice versa) and the worker just skips rows whose
/// channel has no backend configured.
/// Whether this deployment can actually deliver on `channel`, judged
/// from the same env config the worker's backends are built from.
/// Consulted by `/health` — so the setup UI never offers a channel the
/// server would drop (#277) — and by enqueue-and-report endpoints like
/// the practice drill's `heir_notified` (#278).
pub fn channel_deliverable(channel: Channel) -> bool {
    match channel {
        Channel::Email => SmtpConfig::from_env().is_some(),
        Channel::Sms | Channel::Whatsapp => TwilioConfig::from_env().is_some(),
        Channel::WebPush => crate::push::VapidConfig::from_env().is_some(),
    }
}

/// Operator-facing reason a channel can't deliver, recorded as the
/// row's `last_error` so `notifications_failed` tells the real story.
fn undeliverable_reason(channel: Channel) -> &'static str {
    match channel {
        Channel::Email => "SMTP not configured; email undeliverable",
        Channel::Sms => "Twilio not configured; sms undeliverable",
        Channel::Whatsapp => "Twilio not configured; whatsapp undeliverable",
        Channel::WebPush => "VAPID keys not configured; web push undeliverable",
    }
}

struct Backends {
    smtp: Option<SmtpConfig>,
    twilio: Option<TwilioConfig>,
    vapid: Option<crate::push::VapidConfig>,
    /// Shared HTTP client for web push. Unlike Twilio (one POST per
    /// rare notification, client built per send), a single webpush
    /// row can fan out to several push-service POSTs, so connection
    /// reuse pays for the lifecycle here.
    http: reqwest::Client,
}

pub async fn run(pool: SqlitePool, tick: Duration) {
    let backends = Backends {
        smtp: SmtpConfig::from_env(),
        twilio: TwilioConfig::from_env(),
        vapid: crate::push::VapidConfig::from_env(),
        http: reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .build()
            .expect("reqwest client construction only fails on broken TLS backends"),
    };
    match &backends.smtp {
        None => tracing::warn!(
            "SMTP_HOST unset; notification worker will accept enqueues but \
             every email-channel send will FAIL with an undeliverable error. \
             Configure SMTP_HOST / SMTP_PORT / SMTP_FROM (and SMTP_USER/PASS \
             if needed) to enable delivery."
        ),
        Some(cfg) => tracing::info!(
            host = %cfg.host,
            port = cfg.port,
            "notification worker: SMTP configured"
        ),
    }
    match &backends.twilio {
        None => tracing::info!(
            "TWILIO_* not configured; sms/whatsapp notifications will FAIL \
             with an undeliverable error. Configure TWILIO_ACCOUNT_SID + \
             TWILIO_AUTH_TOKEN + TWILIO_SMS_FROM + TWILIO_WHATSAPP_FROM to \
             enable delivery."
        ),
        Some(cfg) => tracing::info!(
            sid_prefix = %cfg.account_sid.chars().take(6).collect::<String>(),
            sms_from = %cfg.sms_from,
            wa_from = %cfg.whatsapp_from,
            "notification worker: Twilio configured"
        ),
    }
    match &backends.vapid {
        None => tracing::info!(
            "GHOSTKEY_VAPID_PRIVATE_KEY unset; webpush notifications will \
             FAIL with an undeliverable error. Generate a keypair with \
             `npx web-push generate-vapid-keys` and set \
             GHOSTKEY_VAPID_PRIVATE_KEY + GHOSTKEY_VAPID_SUBJECT to \
             enable delivery."
        ),
        Some(cfg) => tracing::info!(
            subject = %cfg.subject,
            "notification worker: web push (VAPID) configured"
        ),
    }
    let backends = Arc::new(backends);

    loop {
        if let Err(e) = tick_once(&pool, backends.clone()).await {
            tracing::error!(error = ?e, "notifier tick errored");
        }
        tokio::time::sleep(tick).await;
    }
}

/// One iteration: claim up to N pending+due rows and process them.
/// We deliberately keep batch size small so a backlog doesn't hog
/// the worker for too long; the next tick picks up where this left
/// off.
async fn tick_once(pool: &SqlitePool, backends: Arc<Backends>) -> anyhow::Result<()> {
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
        let Some(channel) = channel else {
            tracing::error!(notif_id = id, channel = %channel_s, "unknown channel");
            mark_permanent(pool, id, "unknown channel").await?;
            continue;
        };

        // Dispatch to the right backend. `None` means "no backend
        // configured for this channel". This used to leave the row
        // pending "for a future deployment", which in practice was a
        // silent black hole (#278): /health degraded forever, the UI
        // told the owner the message went out, and no operator signal
        // ever fired. Fail it loudly instead — if the backend is
        // configured later, the sender can re-enqueue.
        let dispatch = dispatch_send(pool, &backends, channel, &vault_id, &draft).await;
        let outcome = match dispatch {
            None => {
                let reason = undeliverable_reason(channel);
                tracing::warn!(
                    notif_id = id,
                    kind = %kind,
                    channel = ?channel,
                    reason,
                    "channel has no configured backend; failing notification"
                );
                mark_permanent(pool, id, reason).await?;
                WorkerOutcome::Skip
            }
            Some(Ok(())) => WorkerOutcome::Sent,
            Some(Err(e)) => {
                tracing::warn!(
                    notif_id = id,
                    kind = %kind,
                    channel = ?channel,
                    error = %e,
                    "send failed"
                );
                if attempts + 1 >= MAX_ATTEMPTS {
                    mark_permanent(pool, id, &format!("{e}")).await?;
                    WorkerOutcome::Permanent
                } else {
                    let delay = backoff_secs(attempts + 1);
                    reschedule(pool, id, attempts + 1, delay, &format!("{e}")).await?;
                    WorkerOutcome::Retry
                }
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
            tracing::info!(notif_id = id, vault_id = %vault_id, kind = %kind, channel = ?channel, "notification sent");
        }
    }
    Ok(())
}

/// Route a draft to the right backend.
///
/// Return values:
///   - `None`: no backend configured for this channel; the caller
///     fails the row with a clear error (#278).
///   - `Some(Ok)`: delivered. Caller flips to `sent`.
///   - `Some(Err)`: backend rejected or timed out. Caller decides
///     retry vs. permanent.
///
/// This split keeps the worker loop's success/skip/retry bookkeeping
/// in one place and the per-channel transport details out of it.
async fn dispatch_send(
    pool: &SqlitePool,
    backends: &Backends,
    channel: Channel,
    vault_id: &str,
    draft: &DraftPayload,
) -> Option<Result<(), SendError>> {
    // Each arm awaits a different `async fn`, which produces a
    // different opaque future type. We resolve each future to a
    // `Result` inside its own arm and only THEN wrap in Some/None,
    // which keeps the match-arm types compatible without boxing.
    match channel {
        Channel::Email => {
            let cfg = backends.smtp.as_ref()?;
            Some(send_email(cfg, draft).await)
        }
        Channel::Sms | Channel::Whatsapp => {
            let cfg = backends.twilio.as_ref()?;
            Some(send_twilio(cfg, channel, draft).await)
        }
        Channel::WebPush => {
            let cfg = backends.vapid.as_ref()?;
            Some(send_webpush(pool, &backends.http, cfg, vault_id, draft).await)
        }
    }
}

/// Deliver one webpush notification row by fanning out to every
/// subscription stored for the vault.
///
/// Per-subscription outcomes are folded into ONE worker outcome:
///
///   - `Gone` (push service says 404/410): the browser revoked the
///     subscription. Delete the row and treat that endpoint as
///     settled — pruning IS the correct delivery outcome for it.
///   - zero subscriptions, or every endpoint delivered-or-pruned:
///     `Ok`. A user who turned reminders off after the enqueue
///     shouldn't produce a permanently-failed row.
///   - otherwise (at least one endpoint failed and none delivered):
///     `Err`, so the worker's backoff retries the whole row. Already
///     -delivered endpoints would get a duplicate on retry, but the
///     service worker dedupes via the notification `tag`, so we
///     prefer retrying over silently dropping the failed endpoint.
async fn send_webpush(
    pool: &SqlitePool,
    http: &reqwest::Client,
    cfg: &crate::push::VapidConfig,
    vault_id: &str,
    draft: &DraftPayload,
) -> Result<(), SendError> {
    let subs = sqlx::query_as::<_, (i64, String, String, String)>(
        "SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE vault_id = ?",
    )
    .bind(vault_id)
    .fetch_all(pool)
    .await
    .map_err(|e| SendError::WebPush(format!("load subscriptions: {e}")))?;

    if subs.is_empty() {
        return Ok(());
    }

    let mut delivered = 0usize;
    let mut last_err: Option<String> = None;
    for (sub_id, endpoint, p256dh, auth) in &subs {
        let sub = crate::push::Subscription {
            endpoint,
            p256dh_b64: p256dh,
            auth_b64: auth,
        };
        match crate::push::send(http, cfg, &sub, draft.body.as_bytes()).await {
            Ok(()) => delivered += 1,
            Err(crate::push::PushError::Gone) => {
                tracing::info!(
                    vault_id = %vault_id,
                    sub_id,
                    "push subscription gone; pruning"
                );
                if let Err(e) = sqlx::query("DELETE FROM push_subscriptions WHERE id = ?")
                    .bind(sub_id)
                    .execute(pool)
                    .await
                {
                    tracing::warn!(sub_id, error = %e, "failed to prune dead push subscription");
                }
            }
            Err(e) => {
                tracing::warn!(
                    vault_id = %vault_id,
                    sub_id,
                    error = %e,
                    "web push send failed"
                );
                last_err = Some(e.to_string());
            }
        }
    }

    match (delivered, last_err) {
        (0, Some(err)) => Err(SendError::WebPush(err)),
        _ => Ok(()),
    }
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
    /// Twilio HTTP error or non-2xx response. Carries the body
    /// snippet so the operator can read the API's complaint.
    #[error("twilio: {0}")]
    Twilio(String),
    /// Web push fan-out failed for every (non-pruned) subscription.
    /// Carries the last per-endpoint error.
    #[error("webpush: {0}")]
    WebPush(String),
}

/// Deliver a Draft via Twilio's Programmable Messaging API.
///
/// One POST per send:
///
///   POST https://api.twilio.com/2010-04-01/Accounts/{SID}/Messages.json
///   Authorization: Basic base64(SID:AUTH_TOKEN)
///   Content-Type: application/x-www-form-urlencoded
///
///   From={E.164 or whatsapp:+E.164}
///   To={E.164 or whatsapp:+E.164}
///   Body={url-encoded message}
///
/// The same endpoint handles both SMS and WhatsApp. The only wire
/// difference is the `whatsapp:` prefix on `From`/`To` for the
/// WhatsApp channel — Twilio routes by prefix.
///
/// Body is the email body verbatim. SMS has a 1600-char SMS limit
/// (Twilio handles concatenation behind the scenes); WhatsApp has
/// no practical length limit. The "subject" field is dropped on
/// purpose — SMS has no subject concept and WhatsApp doesn't either.
/// We embed the URL in the body itself, which is what `enqueue_*`
/// already does for the email path.
///
/// Returns `Err` on:
///   - HTTP/network failure (Twilio's API down, DNS lookup failed),
///   - Twilio rejection (4xx/5xx with body containing the reason).
///
/// The worker's existing retry/backoff logic handles both.
async fn send_twilio(
    cfg: &TwilioConfig,
    channel: Channel,
    draft: &DraftPayload,
) -> Result<(), SendError> {
    // Build the per-channel From/To shapes. WhatsApp on Twilio needs
    // the `whatsapp:` URI scheme on both sides; SMS uses bare E.164.
    let (from, to) = match channel {
        Channel::Sms => (cfg.sms_from.clone(), draft.recipient.clone()),
        Channel::Whatsapp => (
            format!("whatsapp:{}", cfg.whatsapp_from),
            format!("whatsapp:{}", draft.recipient),
        ),
        Channel::Email | Channel::WebPush => {
            // Defensive: send_twilio should only ever be called for
            // sms/whatsapp. If a caller routes Email or WebPush here
            // it's a bug; surface it loudly rather than silently
            // sending the body over SMS to a recipient that isn't a
            // phone number.
            return Err(SendError::Twilio(format!(
                "send_twilio called with {channel:?}; this is a bug"
            )));
        }
    };

    let url = format!(
        "{}/2010-04-01/Accounts/{}/Messages.json",
        cfg.api_base_url, cfg.account_sid
    );

    // Keep the client local: notifications are infrequent and the
    // worker is single-threaded. Sharing a long-lived client would
    // save micros and add a lifecycle to manage.
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| SendError::Twilio(format!("client build: {e}")))?;

    let form = [
        ("From", from.as_str()),
        ("To", to.as_str()),
        ("Body", draft.body.as_str()),
    ];

    let resp = client
        .post(&url)
        .basic_auth(&cfg.account_sid, Some(&cfg.auth_token))
        .form(&form)
        .send()
        .await
        .map_err(|e| SendError::Twilio(format!("send: {e}")))?;

    let status = resp.status();
    if !status.is_success() {
        // Twilio puts a structured error body on 4xx/5xx; we don't
        // parse it (the field names are documented but stable enough
        // to read by eye). Truncate to 500 chars so a log explosion
        // doesn't fill the disk.
        let body = resp.text().await.unwrap_or_else(|_| "<no body>".into());
        let snippet: String = body.chars().take(500).collect();
        return Err(SendError::Twilio(format!("HTTP {status}: {snippet}")));
    }
    Ok(())
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

/* -------------------------------------------------------------------------- *
 *  Owner-contact helpers                                                     *
 *                                                                            *
 *  Unlike the heir, the owner contact is stored as a plain UTF-8 string     *
 *  (no JSON, no name field). The channel lives in its own column            *
 *  (`owner_contact_channel`) rather than inside the ciphertext. This is     *
 *  intentional: the owner's contact is a much simpler thing — it's their   *
 *  own email/phone, set once at setup, never displayed to them again —      *
 *  so the wrapper JSON the heir flow uses would just be overhead.          *
 * -------------------------------------------------------------------------- */

/// Decrypted owner contact pulled from `owner_contact_ciphertext` +
/// `owner_contact_nonce`. The channel comes from the separate
/// `owner_contact_channel` column and is passed in by the caller —
/// the helper just owns the decryption, not the SQL.
#[derive(Debug, Clone)]
pub struct OwnerContact {
    pub address: String,
    pub channel: Channel,
}

/// Decrypt the owner-contact ciphertext for a vault. Returns
/// `Ok(None)` when either of the two ciphertext columns is NULL
/// (the owner didn't supply one at setup, or the row pre-dates the
/// 20260527 sealed-owner-contact migration). Returns `Ok(None)` and
/// logs a single `tracing::info` when the channel column holds a
/// value we don't know how to deliver to — better than failing the
/// caller, since the caller (the scheduler) doesn't need to know
/// the difference between "no contact" and "contact on a channel we
/// can't deliver" — both mean "skip".
pub fn parse_owner_contact(
    vault_id: &str,
    ciphertext_b64: Option<&str>,
    nonce_b64: Option<&str>,
    channel: Option<&str>,
) -> Result<Option<OwnerContact>, CryptoError> {
    let (ct, nn) = match (ciphertext_b64, nonce_b64) {
        (Some(c), Some(n)) => (c, n),
        _ => return Ok(None),
    };
    // Default to email when the channel column was somehow left NULL
    // — the routes always populate it for sealed rows, but defending
    // against a hand-edited DB row is cheap.
    let ch_str = channel.unwrap_or("email");
    let Some(channel) = Channel::from_str(ch_str) else {
        tracing::info!(
            vault_id = %vault_id,
            channel = %ch_str,
            "owner channel not yet supported; skipping owner notification"
        );
        return Ok(None);
    };
    let bytes = open_for_vault(
        vault_id,
        &SealedContact {
            ciphertext_b64: ct.to_string(),
            nonce_b64: nn.to_string(),
        },
    )?;
    let address = String::from_utf8(bytes).map_err(|_| CryptoError::Decrypt)?;
    if address.trim().is_empty() {
        return Ok(None);
    }
    Ok(Some(OwnerContact { address, channel }))
}

/// Enqueue an email to the vault owner, but only when the owner has a
/// CONFIRMED email contact. Returns `Ok(false)` when the vault has no
/// owner contact, the contact is not an email address, or the address
/// was never verified. Lifecycle mail (welcome / funded / received /
/// sent) must never go to an address nobody has proven they own — see
/// the 20260610000002 migration for why that matters.
pub async fn enqueue_owner_email(
    pool: &SqlitePool,
    vault_id: &str,
    kind: NotificationKind,
    subject: &str,
    body: &str,
) -> Result<bool, EnqueueError> {
    type Row = (
        Option<String>, // owner_contact_ciphertext
        Option<String>, // owner_contact_nonce
        Option<String>, // owner_contact_channel
        Option<String>, // owner_contact_verified_at
    );
    let row: Option<Row> = sqlx::query_as(
        "SELECT owner_contact_ciphertext, owner_contact_nonce, \
                owner_contact_channel, owner_contact_verified_at \
           FROM vaults WHERE id = ?",
    )
    .bind(vault_id)
    .fetch_optional(pool)
    .await?;
    let Some((ct, nn, ch, verified_at)) = row else {
        return Ok(false);
    };
    if verified_at.is_none() {
        return Ok(false);
    }
    let Some(contact) = parse_owner_contact(vault_id, ct.as_deref(), nn.as_deref(), ch.as_deref())?
    else {
        return Ok(false);
    };
    if contact.channel != Channel::Email {
        return Ok(false);
    }
    enqueue(
        pool,
        vault_id,
        kind,
        Channel::Email,
        &contact.address,
        subject,
        body,
    )
    .await?;
    Ok(true)
}

/// Serialises every test that reads or writes `SMTP_*` env, so a test
/// that asserts SMTP is unset can't race a concurrent setter. Lives at
/// module scope (not inside `mod tests`) so the drill tests, which set
/// `SMTP_HOST` to make an email heir look deliverable, share the exact
/// same lock as the SMTP-config unit test here. Mirrors the existing
/// `TWILIO_ENV_LOCK` pattern.
#[cfg(test)]
pub(crate) static SMTP_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

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
        assert_eq!(Channel::from_str("sms"), Some(Channel::Sms));
        assert_eq!(Channel::from_str("whatsapp"), Some(Channel::Whatsapp));
        assert_eq!(Channel::from_str("webpush"), Some(Channel::WebPush));
        assert_eq!(Channel::from_str("telegram"), None);
        assert_eq!(Channel::Email.as_str(), "email");
        assert_eq!(Channel::Sms.as_str(), "sms");
        assert_eq!(Channel::Whatsapp.as_str(), "whatsapp");
        assert_eq!(Channel::WebPush.as_str(), "webpush");
    }

    #[test]
    fn smtp_config_defaults_when_only_host_set() {
        // Hold the shared SMTP env lock so the remove→is_none() check
        // below can't race a concurrent setter (e.g. the drill tests).
        let _g = SMTP_ENV_LOCK.lock().unwrap();
        // SAFETY: tests run in one process; the lock serialises access.
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

    /* ---------------------------------------------------------------- *
     *  Twilio (SMS + WhatsApp) tests                                   *
     *                                                                  *
     *  We isolate env access behind a Mutex per the same pattern used  *
     *  in crypto::tests: TwilioConfig::from_env() reads the process    *
     *  env, so two parallel tests would race. The config tests also    *
     *  scrub every TWILIO_* var on entry so a previous test's state    *
     *  doesn't leak.                                                   *
     * ---------------------------------------------------------------- */

    static TWILIO_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn clear_twilio_env() {
        for k in [
            "TWILIO_ACCOUNT_SID",
            "TWILIO_AUTH_TOKEN",
            "TWILIO_SMS_FROM",
            "TWILIO_WHATSAPP_FROM",
            "TWILIO_API_BASE_URL",
        ] {
            // SAFETY: tests are single-process; the lock serialises access.
            unsafe { std::env::remove_var(k) };
        }
    }

    #[test]
    fn twilio_config_unset_returns_none_silently() {
        let _g = TWILIO_ENV_LOCK.lock().unwrap();
        clear_twilio_env();
        assert!(TwilioConfig::from_env().is_none());
    }

    #[test]
    fn twilio_config_loads_when_all_four_vars_set() {
        let _g = TWILIO_ENV_LOCK.lock().unwrap();
        clear_twilio_env();
        unsafe {
            std::env::set_var("TWILIO_ACCOUNT_SID", "ACtestsid");
            std::env::set_var("TWILIO_AUTH_TOKEN", "secrettoken");
            std::env::set_var("TWILIO_SMS_FROM", "+15550000001");
            std::env::set_var("TWILIO_WHATSAPP_FROM", "+15550000002");
        }
        let cfg = TwilioConfig::from_env().expect("with all four set");
        assert_eq!(cfg.account_sid, "ACtestsid");
        assert_eq!(cfg.auth_token, "secrettoken");
        assert_eq!(cfg.sms_from, "+15550000001");
        assert_eq!(cfg.whatsapp_from, "+15550000002");
        assert_eq!(cfg.api_base_url, "https://api.twilio.com");
        clear_twilio_env();
    }

    /// Partial config is an operator mistake. We refuse to load
    /// (returns None) so SMS/WhatsApp stay disabled; a warning in
    /// the log (which we don't assert on here) names which vars
    /// are missing.
    #[test]
    fn twilio_config_partial_returns_none() {
        let _g = TWILIO_ENV_LOCK.lock().unwrap();
        clear_twilio_env();
        unsafe {
            std::env::set_var("TWILIO_ACCOUNT_SID", "ACtestsid");
            std::env::set_var("TWILIO_AUTH_TOKEN", "secrettoken");
            // TWILIO_SMS_FROM + TWILIO_WHATSAPP_FROM deliberately unset.
        }
        assert!(
            TwilioConfig::from_env().is_none(),
            "partial config must NOT load"
        );
        clear_twilio_env();
    }

    /// API-base override picked up from env so the mock-server test
    /// below can point us at 127.0.0.1.
    #[test]
    fn twilio_config_honours_api_base_override() {
        let _g = TWILIO_ENV_LOCK.lock().unwrap();
        clear_twilio_env();
        unsafe {
            std::env::set_var("TWILIO_ACCOUNT_SID", "ACtestsid");
            std::env::set_var("TWILIO_AUTH_TOKEN", "secrettoken");
            std::env::set_var("TWILIO_SMS_FROM", "+15550000001");
            std::env::set_var("TWILIO_WHATSAPP_FROM", "+15550000002");
            std::env::set_var("TWILIO_API_BASE_URL", "http://127.0.0.1:1");
        }
        let cfg = TwilioConfig::from_env().expect("config loads");
        assert_eq!(cfg.api_base_url, "http://127.0.0.1:1");
        clear_twilio_env();
    }

    /* ---------------------------------------------------------------- *
     *  Twilio HTTP round-trip                                          *
     *                                                                  *
     *  Spin up a tiny in-process axum server that mimics Twilio's     *
     *  POST /2010-04-01/Accounts/{SID}/Messages.json shape, point     *
     *  send_twilio at it, and assert we sent the right From/To/Body  *
     *  + the right Authorization header. The mock is generous about  *
     *  what it accepts (we're testing the client, not Twilio).       *
     * ---------------------------------------------------------------- */

    use axum::extract::{Form, Path as AxPath, State as AxState};
    use axum::http::HeaderMap as AxHeaderMap;
    use axum::http::StatusCode as AxStatusCode;
    use axum::routing::post as ax_post;
    use axum::Router;
    use base64::Engine as _;
    use std::collections::HashMap;
    use std::net::SocketAddr;
    use std::sync::Mutex;

    /// Recorded shape of a single inbound request. The mock pushes
    /// one of these per call so tests can assert on the body the
    /// real Twilio API would have received.
    #[derive(Debug, Default, Clone)]
    struct CapturedCall {
        sid_in_path: String,
        authorization: Option<String>,
        form: HashMap<String, String>,
    }

    #[derive(Default)]
    struct MockTwilio {
        calls: Mutex<Vec<CapturedCall>>,
    }

    async fn spawn_mock_twilio() -> (Arc<MockTwilio>, String) {
        let mock = Arc::new(MockTwilio::default());
        let mock_for_handler = mock.clone();
        let app = Router::new()
            .route(
                "/2010-04-01/Accounts/:sid/Messages.json",
                ax_post(
                    |AxState(mock): AxState<Arc<MockTwilio>>,
                     AxPath(sid): AxPath<String>,
                     headers: AxHeaderMap,
                     Form(form): Form<HashMap<String, String>>| async move {
                        mock.calls.lock().unwrap().push(CapturedCall {
                            sid_in_path: sid,
                            authorization: headers
                                .get(axum::http::header::AUTHORIZATION)
                                .and_then(|v| v.to_str().ok())
                                .map(str::to_string),
                            form,
                        });
                        // Twilio returns 201 on a successful create.
                        AxStatusCode::CREATED
                    },
                ),
            )
            .with_state(mock_for_handler);

        let listener = tokio::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0)))
            .await
            .expect("bind");
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        (mock, format!("http://{addr}"))
    }

    /// Build a minimal config pointing at the mock. We bypass
    /// `from_env` here because the env-loading tests above already
    /// pin that surface; this test is about the wire shape.
    fn mock_cfg(api_base: String) -> TwilioConfig {
        TwilioConfig {
            account_sid: "ACtestsid".into(),
            auth_token: "secrettoken".into(),
            sms_from: "+15550000001".into(),
            whatsapp_from: "+15550000002".into(),
            api_base_url: api_base,
        }
    }

    fn dummy_draft(recipient: &str) -> DraftPayload {
        DraftPayload {
            recipient: recipient.to_string(),
            subject: String::new(),
            body: "Hi from GhostKey tests.".to_string(),
        }
    }

    /// SMS round-trip: From is bare E.164, To is bare E.164, the
    /// Authorization header is HTTP Basic with SID:AUTH_TOKEN.
    #[tokio::test]
    async fn twilio_sms_round_trips() {
        let (mock, url) = spawn_mock_twilio().await;
        let cfg = mock_cfg(url);
        let draft = dummy_draft("+15558675309");

        send_twilio(&cfg, Channel::Sms, &draft).await.expect("send");

        let calls = mock.calls.lock().unwrap();
        assert_eq!(calls.len(), 1);
        let c = &calls[0];
        assert_eq!(c.sid_in_path, "ACtestsid");
        assert_eq!(c.form["From"], "+15550000001");
        assert_eq!(c.form["To"], "+15558675309");
        assert_eq!(c.form["Body"], "Hi from GhostKey tests.");
        let expected_basic = format!(
            "Basic {}",
            base64::engine::general_purpose::STANDARD.encode("ACtestsid:secrettoken")
        );
        assert_eq!(c.authorization.as_deref(), Some(expected_basic.as_str()));
    }

    /// WhatsApp round-trip: the `whatsapp:` prefix is added to BOTH
    /// From and To. Recipient comes in as bare E.164 from
    /// owner_contact; we add the scheme on the wire.
    #[tokio::test]
    async fn twilio_whatsapp_prefixes_both_sides() {
        let (mock, url) = spawn_mock_twilio().await;
        let cfg = mock_cfg(url);
        let draft = dummy_draft("+15558675309");

        send_twilio(&cfg, Channel::Whatsapp, &draft)
            .await
            .expect("send");

        let c = mock.calls.lock().unwrap().pop().unwrap();
        assert_eq!(c.form["From"], "whatsapp:+15550000002");
        assert_eq!(c.form["To"], "whatsapp:+15558675309");
        assert_eq!(c.form["Body"], "Hi from GhostKey tests.");
    }

    /// send_twilio refuses Channel::Email loudly. The worker should
    /// never route Email here \u2014 dispatch_send routes Email to
    /// send_email \u2014 but a regression in the router would silently
    /// send the email body over SMS to a phone number that doesn't
    /// exist. This test pins the guard.
    #[tokio::test]
    async fn twilio_refuses_email_channel() {
        let (_mock, url) = spawn_mock_twilio().await;
        let cfg = mock_cfg(url);
        let draft = dummy_draft("user@example.test");
        let err = send_twilio(&cfg, Channel::Email, &draft)
            .await
            .expect_err("must refuse");
        assert!(matches!(err, SendError::Twilio(_)), "got: {err:?}");
    }

    /// 4xx from Twilio surfaces as a SendError::Twilio carrying the
    /// status. The worker's existing retry/permanent logic decides
    /// what to do with it.
    #[tokio::test]
    async fn twilio_http_4xx_surfaces_as_send_error() {
        // Spin up a mock that ALWAYS 400s so the failure path is
        // exercised. Using a fresh router rather than the shared
        // mock to keep the assertions tight.
        let app = Router::new().route(
            "/2010-04-01/Accounts/:sid/Messages.json",
            ax_post(|| async {
                (
                    AxStatusCode::BAD_REQUEST,
                    r#"{"code":21211,"message":"Invalid To number"}"#,
                )
            }),
        );
        let listener = tokio::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0)))
            .await
            .expect("bind");
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        let cfg = mock_cfg(format!("http://{addr}"));
        let draft = dummy_draft("+15550001234");

        let err = send_twilio(&cfg, Channel::Sms, &draft)
            .await
            .expect_err("must fail");
        match err {
            SendError::Twilio(msg) => {
                assert!(msg.contains("400"), "should include status: {msg}");
                assert!(msg.contains("21211"), "should include Twilio body: {msg}");
            }
            other => panic!("expected Twilio error, got {other:?}"),
        }
    }

    /// A row whose channel has no configured backend must FAIL with a
    /// clear `last_error`, not sit pending forever (#278). The eternal
    /// pending row was observed live: a WhatsApp drill invite waited 5
    /// days with 0 attempts while /health degraded and the owner was
    /// told "Practice sent".
    #[tokio::test]
    async fn unconfigured_channel_fails_row_with_reason() {
        if std::env::var("GHOSTKEY_MASTER_KEY").is_err() {
            let zeros = [0u8; 32];
            let b64 = base64::engine::general_purpose::STANDARD_NO_PAD.encode(zeros);
            // SAFETY: tests are single-process; the value is fixed.
            unsafe {
                std::env::set_var("GHOSTKEY_MASTER_KEY", &b64);
            }
        }
        let _ = crate::crypto::ensure_master_key_loaded();

        let pool: SqlitePool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("connect sqlite::memory");
        sqlx::migrate!("./migrations")
            .run(&pool)
            .await
            .expect("run migrations");
        // Minimal vault row so the notifications FK holds.
        sqlx::query(
            r#"INSERT INTO vaults (id, network, descriptor_external, descriptor_internal,
                    timelock_blocks, checkin_period_secs, grace_period_secs,
                    created_at, next_deadline_at, status)
               VALUES ('v-notif-1','regtest','d-ext-notif','d-int-notif',
                    144, 86400, 3600,
                    '2026-01-01T00:00:00Z','2026-01-02T00:00:00Z','ok')"#,
        )
        .execute(&pool)
        .await
        .expect("insert vault");

        let sms_id = enqueue(
            &pool,
            "v-notif-1",
            NotificationKind::DrillInvite,
            Channel::Whatsapp,
            "+15558675309",
            "practice",
            "hello",
        )
        .await
        .expect("enqueue whatsapp");

        // Worker with NO backends at all — the signet/dev shape.
        let backends = Arc::new(Backends {
            smtp: None,
            twilio: None,
            vapid: None,
            http: reqwest::Client::new(),
        });
        tick_once(&pool, backends).await.expect("tick");

        let (status, last_error): (String, Option<String>) =
            sqlx::query_as("SELECT status, last_error FROM notifications WHERE id = ?")
                .bind(sms_id)
                .fetch_one(&pool)
                .await
                .expect("row");
        assert_eq!(status, "failed_permanent");
        let err = last_error.expect("must carry a reason");
        assert!(err.contains("Twilio"), "reason names the config: {err}");
        assert!(err.contains("whatsapp"), "reason names the channel: {err}");
    }
}
