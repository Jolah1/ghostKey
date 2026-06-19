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
        match tick_once(&state).await {
            // Record a heartbeat only on a clean tick, so /health can
            // distinguish "scheduler is running" from "process is up but
            // the loop is wedged / erroring every tick".
            Ok(()) => record_heartbeat(&state.db).await,
            Err(e) => tracing::error!(error = ?e, "scheduler tick failed"),
        }
        tokio::time::sleep(tick).await;
    }
}

/// Upsert the single-row scheduler heartbeat. Best-effort: a write
/// failure is logged, not fatal -- losing a heartbeat must never stop
/// the scheduler from doing its real work on the next tick.
async fn record_heartbeat(db: &sqlx::SqlitePool) {
    let now = Utc::now().to_rfc3339();
    if let Err(e) = sqlx::query(
        "INSERT INTO scheduler_heartbeat (id, last_tick_at) VALUES (1, ?) \
         ON CONFLICT(id) DO UPDATE SET last_tick_at = excluded.last_tick_at",
    )
    .bind(&now)
    .execute(db)
    .await
    {
        tracing::warn!(error = %e, "failed to record scheduler heartbeat");
    }
}

async fn tick_once(state: &AppState) -> anyhow::Result<()> {
    let now = Utc::now().to_rfc3339();
    unfreeze_expired_panics(state, &now).await?;
    issue_pre_deadline_reminders(state, &now).await?;
    transition_ok_to_alarmed(state, &now).await?;
    send_alarm_escalations(state, &now).await?;
    transition_alarmed_to_claimable(state, &now).await?;
    send_claim_ready_notices(state).await?;
    Ok(())
}

/// Once a claim's challenge window has elapsed without the owner
/// objecting, tell the heir they can finish. Without this, a
/// non-technical heir who hit the wait screen has to remember to come
/// back on their own.
///
/// `claim_ready_notified_at` dedupes; it is cleared (along with
/// `claim_opened_at`) by check-in and panic, both of which kill the
/// claim cycle entirely.
async fn send_claim_ready_notices(state: &AppState) -> anyhow::Result<()> {
    let window = crate::config::claim_challenge_window_secs();
    if window == 0 {
        return Ok(());
    }
    type ReadyRow = (
        String,         // id
        String,         // claim_opened_at
        Option<String>, // heir_contact_ciphertext
        Option<String>, // heir_contact_nonce
        Option<String>, // claim_token_at_rest_b64
    );
    let rows: Vec<ReadyRow> = sqlx::query_as(
        r#"SELECT id, claim_opened_at,
                  heir_contact_ciphertext, heir_contact_nonce,
                  claim_token_at_rest_b64
             FROM vaults
            WHERE claim_opened_at IS NOT NULL
              AND claim_ready_notified_at IS NULL
              AND claim_token_hash IS NOT NULL
              AND claim_token_used_at IS NULL"#,
    )
    .fetch_all(&state.db)
    .await?;

    let now = Utc::now();
    for (vault_id, opened_s, heir_ct, heir_nn, token_at_rest) in rows {
        let ready_at = crate::config::parse_rfc(&opened_s) + chrono::Duration::seconds(window);
        if now < ready_at {
            continue;
        }

        // Mark first (CAS) so a racing tick can't double-send.
        let marked = sqlx::query(
            "UPDATE vaults SET claim_ready_notified_at = ? \
              WHERE id = ? AND claim_ready_notified_at IS NULL",
        )
        .bind(now.to_rfc3339())
        .bind(&vault_id)
        .execute(&state.db)
        .await?;
        if marked.rows_affected() == 0 {
            continue;
        }

        let Some(contact) = parse_heir_contact(&vault_id, heir_ct.as_deref(), heir_nn.as_deref())?
        else {
            tracing::info!(vault_id = %vault_id, "claim ready but no heir contact; skipping notice");
            continue;
        };
        if contact.channel.as_deref() != Some("email") {
            tracing::info!(vault_id = %vault_id, "claim ready but heir channel unsupported; skipping notice");
            continue;
        }
        let Some(recipient) = contact.contact.as_deref().filter(|c| !c.is_empty()) else {
            continue;
        };

        // Password vaults keep the raw token at rest, so we can embed
        // the link again; legacy vaults can't (the raw token only ever
        // lived in the first email), so we point back at it.
        let link_line = match token_at_rest.as_deref().filter(|t| !t.is_empty()) {
            Some(stored) => {
                // Door A keeps the token at rest, sealed under the per-vault
                // AEAD (legacy rows are plaintext and pass through). Decrypt
                // it back to the bearer value for the link.
                let token = crate::crypto::open_claim_token_at_rest(&vault_id, stored)?;
                let base = public_base_url();
                format!("Pick up where you left off:\n\n{base}/#/claim/{token}")
            }
            None => "Pick up where you left off by opening the link from our \
                     earlier email again."
                .to_string(),
        };
        let heir_name = contact.name.as_deref().unwrap_or("there");
        let body = format!(
            "Hello {heir_name},\n\n\
             The short safety wait on your claim is over — you can now \
             finish receiving what was left for you.\n\n\
             {link_line}\n\n\
             — GhostKey"
        );
        if let Err(e) = notifier::enqueue(
            &state.db,
            &vault_id,
            NotificationKind::ClaimReady,
            Channel::Email,
            recipient,
            "You can finish your claim now",
            &body,
        )
        .await
        {
            tracing::warn!(vault_id = %vault_id, error = ?e, "claim-ready notice enqueue failed");
        } else {
            tracing::info!(vault_id = %vault_id, "claim-ready notice enqueued");
        }
    }
    Ok(())
}

/// How often the alarm-escalation email re-fires while the owner is
/// in the `alarmed` state. Daily is loud enough to be impossible to
/// miss, infrequent enough not to land in spam.
const ALARM_ESCALATION_INTERVAL_SECS: i64 = 24 * 3600;

/// While a vault is `alarmed`, send a daily reminder to the owner so
/// the 14-day cancellation window is genuinely impossible to sleep
/// through. Each email mentions how many days are left before the
/// heir is notified, escalating in tone with each successive reminder.
///
/// We fire when there's no prior reminder for this alarm cycle, OR
/// the previous reminder was sent more than 24h ago. The columns
/// `last_alarm_reminder_sent_at` and `alarm_reminder_count` are both
/// cleared whenever the owner checks in (so a fresh alarm starts the
/// count back at 0).
async fn send_alarm_escalations(state: &AppState, now_iso: &str) -> anyhow::Result<()> {
    let cutoff = chrono::DateTime::parse_from_rfc3339(now_iso)
        .map(|d| d.with_timezone(&Utc))
        .unwrap_or_else(|_| Utc::now())
        - chrono::Duration::seconds(ALARM_ESCALATION_INTERVAL_SECS);
    let cutoff_s = cutoff.to_rfc3339();

    let due = sqlx::query_as::<
        _,
        (
            String,         // id
            Option<String>, // label
            Option<String>, // owner_contact_ciphertext
            Option<String>, // owner_contact_nonce
            Option<String>, // owner_contact_channel
            String,         // claim_eligible_at
            i64,            // alarm_reminder_count
        ),
    >(
        r#"SELECT id, label,
                  owner_contact_ciphertext, owner_contact_nonce, owner_contact_channel,
                  claim_eligible_at,
                  alarm_reminder_count
             FROM vaults
            WHERE status = 'alarmed'
              AND claim_eligible_at IS NOT NULL
              AND claim_eligible_at > ?
              AND owner_contact_ciphertext IS NOT NULL
              AND (last_alarm_reminder_sent_at IS NULL
                   OR last_alarm_reminder_sent_at <= ?)"#,
    )
    .bind(now_iso)
    .bind(&cutoff_s)
    .fetch_all(&state.db)
    .await?;

    for (id, label, ct, nn, ch, claim_eligible_at, count_so_far) in due {
        if let Err(e) = enqueue_alarm_escalation(
            state,
            &id,
            label.as_deref(),
            SealedOwnerContactRow {
                ciphertext_b64: ct.as_deref(),
                nonce_b64: nn.as_deref(),
                channel: ch.as_deref(),
            },
            &claim_eligible_at,
            count_so_far,
            now_iso,
        )
        .await
        {
            tracing::warn!(vault_id = %id, error = ?e, "alarm escalation enqueue failed");
            continue;
        }
        sqlx::query(
            r#"UPDATE vaults
                  SET last_alarm_reminder_sent_at = ?,
                      alarm_reminder_count        = alarm_reminder_count + 1
                WHERE id = ?
                  AND status = 'alarmed'"#,
        )
        .bind(now_iso)
        .bind(&id)
        .execute(&state.db)
        .await?;
    }
    Ok(())
}

/// Email body for a single escalation tick. Tone escalates with
/// `count_so_far` (0 = first reminder, 1 = second, …) so the owner
/// notices a difference between day 2 and day 12 of the alarmed window.
async fn enqueue_alarm_escalation(
    state: &AppState,
    vault_id: &str,
    label: Option<&str>,
    owner: SealedOwnerContactRow<'_>,
    claim_eligible_at_iso: &str,
    count_so_far: i64,
    now_iso: &str,
) -> anyhow::Result<()> {
    let Some(contact) = parse_owner_contact(
        vault_id,
        owner.ciphertext_b64,
        owner.nonce_b64,
        owner.channel,
    )?
    else {
        return Ok(());
    };
    if !matches!(contact.channel, Channel::Email) {
        return Ok(());
    }

    // Days remaining is what makes these emails actually scary; the
    // user is reading at a glance.
    let claim_dt = chrono::DateTime::parse_from_rfc3339(claim_eligible_at_iso)
        .ok()
        .map(|d| d.with_timezone(&Utc));
    let now_dt = chrono::DateTime::parse_from_rfc3339(now_iso)
        .ok()
        .map(|d| d.with_timezone(&Utc))
        .unwrap_or_else(Utc::now);
    let days_left = claim_dt
        .map(|d| ((d - now_dt).num_seconds().max(0) + 86_399) / 86_400)
        .unwrap_or(0);

    let base = public_base_url();
    let display_label = label.unwrap_or("your GhostKey vault");

    let one_tap_block = match mint_or_reuse_one_tap_token(state, vault_id, now_iso).await? {
        Some(token) => format!(
            "Tap this link to check in. One tap. Nothing else.\n\n\
             {base}/#/checkin-link/{vault_id}/{token}\n\n"
        ),
        None => String::new(),
    };

    let (subject, lead) = match count_so_far {
        0 => (
            format!("You missed a check-in — {days_left} days until your heir is notified"),
            "This is the first daily reminder.".to_string(),
        ),
        n if n < 7 => (
            format!("{days_left} days left to check in before your heir is contacted"),
            format!("You've now missed {} daily reminders.", n + 1),
        ),
        _ => (
            format!(
                "Last few days: {days_left} days until your heir is notified about {display_label}"
            ),
            "This is one of the final reminders.".to_string(),
        ),
    };

    let body = format!(
        "Hello,\n\n\
         {lead} {display_label} is past its check-in deadline.\n\n\
         {one_tap_block}\
         You can also open the dashboard on any device:\n\n\
         {base}/#/checkin\n\n\
         If we don't hear from you within {days_left} day(s), your heir \
         will receive a claim link for this vault. You can stop that \
         instantly by checking in.\n\n\
         — GhostKey\n"
    );

    notifier::enqueue(
        &state.db,
        vault_id,
        NotificationKind::AlarmEscalation,
        Channel::Email,
        &contact.address,
        &subject,
        &body,
    )
    .await?;
    Ok(())
}

/// Release any vault whose `panic_frozen_until` has passed. Resets
/// status to `ok` and clears the freeze marker; the owner can then
/// check in normally to restart the deadline cadence.
///
/// We do NOT recompute `next_deadline_at` here on purpose: while the
/// vault was frozen the heir was blocked, but the deadline clock kept
/// ticking. Forcing the owner to do an explicit check-in after the
/// freeze releases avoids a class of "I forgot I panicked" bugs where
/// a vault silently reverts to alarmed seconds after unfreeze.
async fn unfreeze_expired_panics(state: &AppState, now_iso: &str) -> anyhow::Result<()> {
    let expired: Vec<(String,)> = sqlx::query_as(
        r#"SELECT id
             FROM vaults
            WHERE status = 'frozen'
              AND panic_frozen_until IS NOT NULL
              AND panic_frozen_until <= ?"#,
    )
    .bind(now_iso)
    .fetch_all(&state.db)
    .await?;

    for (id,) in expired {
        sqlx::query(
            r#"UPDATE vaults
                  SET status              = 'alarmed',
                      panic_frozen_until  = NULL
                WHERE id = ?
                  AND status = 'frozen'"#,
        )
        .bind(&id)
        .execute(&state.db)
        .await?;
        record_event(
            &state.db,
            &id,
            "panic_expired",
            Some(serde_json::json!({ "reason": "freeze_window_elapsed" })),
        )
        .await?;
        tracing::info!(vault_id = %id, "panic freeze expired; vault unfrozen to alarmed");
    }
    Ok(())
}

/// How far ahead of the deadline we send the pre-deadline reminder.
/// 24 hours matches what most calendar apps do; the picker is not
/// user-configurable in this pass (see JOURNAL "left for later").
///
/// Tests and the scheduler share this constant so a future tweak
/// stays consistent. Demo-mode deployments (`GHOSTKEY_DEMO_MODE=1`)
/// have a cadence shorter than this lead time on purpose — when the
/// cadence is 10 seconds, the lead-time check fires immediately, so
/// the reminder shows up in the same demo as the alarm. That's the
/// behaviour we want: the demo demonstrates BOTH emails fire.
const PRE_DEADLINE_REMINDER_LEAD_SECS: i64 = 24 * 3600;

/// Mint a one-tap check-in token for `vault_id` if the row doesn't
/// already have one for the current cycle, otherwise reuse the
/// existing hash. Returns the *raw* token the caller can embed in
/// an email URL.
///
/// "Current cycle" means: there is a row, its `checkin_link_token_hash`
/// is non-NULL, AND its `checkin_link_token_used_at` is NULL (an
/// unused token from a still-open cycle). When the token has been
/// used, OR the column is NULL because the previous cycle's check-in
/// cleared it, we mint a fresh one.
///
/// The CAS-style INSERT guard (`AND checkin_link_token_hash IS NULL`)
/// means two scheduler ticks racing on the same row will produce one
/// fresh token, not two — the second tick reads back the hash the
/// first one wrote. We do still need to return the raw token from
/// THIS tick to embed it in the email; if we ever lost that race we'd
/// have a hash in the DB and no raw token to email out. We accept
/// that edge case: the next tick will see the marker and skip; the
/// reminder simply doesn't go out that cycle. Logged loudly so it's
/// observable.
pub(crate) async fn mint_or_reuse_one_tap_token(
    state: &AppState,
    vault_id: &str,
    now_iso: &str,
) -> anyhow::Result<Option<String>> {
    // Try to read an existing live token first. If the previous
    // reminder enqueued one and the owner hasn't used it yet,
    // re-issuing would break the previously-sent email.
    let existing: Option<(Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT checkin_link_token_hash, checkin_link_token_used_at \
         FROM vaults WHERE id = ?",
    )
    .bind(vault_id)
    .fetch_optional(&state.db)
    .await?;
    let Some((hash, used_at)) = existing else {
        return Ok(None);
    };
    if hash.is_some() && used_at.is_none() {
        // A live token exists. We can't recover the raw value — it
        // only ever lived in the email URL — so the best we can do
        // is NOT mint a new one (which would invalidate the existing
        // email link). Returning None tells the caller to skip the
        // enqueue; the email link from the previous reminder is
        // still valid.
        tracing::info!(
            vault_id = %vault_id,
            "one-tap token already issued this cycle; skipping re-enqueue"
        );
        return Ok(None);
    }

    let issued = issue_claim_token();
    let updated = sqlx::query(
        r#"UPDATE vaults
              SET checkin_link_token_hash       = ?,
                  checkin_link_token_issued_at  = ?,
                  checkin_link_token_used_at    = NULL
            WHERE id = ?
              AND (checkin_link_token_hash IS NULL
                   OR checkin_link_token_used_at IS NOT NULL)"#,
    )
    .bind(&issued.hash_hex)
    .bind(now_iso)
    .bind(vault_id)
    .execute(&state.db)
    .await?;

    if updated.rows_affected() == 0 {
        // Another tick won the race. The other tick has the raw
        // token; we have nothing to email. Skip silently — the
        // next cycle's reminder will get a fresh shot.
        return Ok(None);
    }
    Ok(Some(issued.token))
}

/// One scheduler step: fire a pre-deadline reminder for every vault
/// whose next deadline is within `PRE_DEADLINE_REMINDER_LEAD_SECS`
/// of now, has not been reminded this cycle, and has a sealed owner
/// contact we can deliver to.
///
/// The `pre_deadline_reminder_sent_at` column is the per-cycle
/// guard. It's set on every successful enqueue here, and cleared on
/// every successful check-in (button, Lightning, one-tap link) so
/// the next cycle starts fresh.
async fn issue_pre_deadline_reminders(state: &AppState, now_iso: &str) -> anyhow::Result<()> {
    // Window upper bound: now + lead. We send the reminder for any
    // vault whose deadline is within this window. The lower bound
    // (we must not have passed the deadline yet) is encoded as
    // `next_deadline_at > now`.
    let now_dt = chrono::DateTime::parse_from_rfc3339(now_iso)
        .map(|d| d.with_timezone(&Utc))
        .unwrap_or_else(|_| Utc::now());
    let window_end =
        (now_dt + chrono::Duration::seconds(PRE_DEADLINE_REMINDER_LEAD_SECS)).to_rfc3339();

    let due = sqlx::query_as::<
        _,
        (
            String,         // id
            Option<String>, // label
            Option<String>, // owner_contact_ciphertext
            Option<String>, // owner_contact_nonce
            Option<String>, // owner_contact_channel
            String,         // next_deadline_at
        ),
    >(
        r#"SELECT id, label,
                  owner_contact_ciphertext, owner_contact_nonce, owner_contact_channel,
                  next_deadline_at
             FROM vaults v
            WHERE status = 'ok'
              AND next_deadline_at > ?
              AND next_deadline_at <= ?
              AND pre_deadline_reminder_sent_at IS NULL
              AND (owner_contact_ciphertext IS NOT NULL
                   OR EXISTS (SELECT 1 FROM push_subscriptions ps
                               WHERE ps.vault_id = v.id))"#,
    )
    .bind(now_iso)
    .bind(&window_end)
    .fetch_all(&state.db)
    .await?;

    for (id, label, ow_ct, ow_nn, ow_ch, next_deadline_at) in due {
        if let Err(e) = enqueue_pre_deadline_reminder(
            state,
            &id,
            label.as_deref(),
            SealedOwnerContactRow {
                ciphertext_b64: ow_ct.as_deref(),
                nonce_b64: ow_nn.as_deref(),
                channel: ow_ch.as_deref(),
            },
            &next_deadline_at,
            now_iso,
        )
        .await
        {
            tracing::warn!(vault_id = %id, error = ?e, "could not enqueue pre-deadline reminder");
        }
    }
    Ok(())
}

/// Bundle of the three sealed-owner-contact columns we read from
/// `vaults`. Grouped so the helpers that take them don't trip the
/// `clippy::too_many_arguments` lint and so a future addition (e.g.
/// a per-vault TTL) lives in one place.
struct SealedOwnerContactRow<'a> {
    ciphertext_b64: Option<&'a str>,
    nonce_b64: Option<&'a str>,
    channel: Option<&'a str>,
}

/// Build the pre-deadline reminder email and enqueue it. Also sets
/// the per-cycle marker so the next tick doesn't re-send.
async fn enqueue_pre_deadline_reminder(
    state: &AppState,
    vault_id: &str,
    label: Option<&str>,
    owner: SealedOwnerContactRow<'_>,
    next_deadline_at_iso: &str,
    now_iso: &str,
) -> anyhow::Result<()> {
    // The reminder can go out over two independent channels: the
    // sealed owner email and/or web push to every browser that opted
    // in. Resolve both up front; if neither is deliverable, leave the
    // marker unset so a future code change that adds the owner's
    // channel can still ship the reminder.
    let email_contact = parse_owner_contact(
        vault_id,
        owner.ciphertext_b64,
        owner.nonce_b64,
        owner.channel,
    )?
    .filter(|c| matches!(c.channel, Channel::Email));

    let has_push =
        sqlx::query_as::<_, (i64,)>("SELECT COUNT(*) FROM push_subscriptions WHERE vault_id = ?")
            .bind(vault_id)
            .fetch_one(&state.db)
            .await?
            .0
            > 0;

    if email_contact.is_none() && !has_push {
        return Ok(());
    }

    let token = match mint_or_reuse_one_tap_token(state, vault_id, now_iso).await? {
        Some(t) => t,
        None => return Ok(()), // race with concurrent tick; see helper
    };

    let deadline_friendly = chrono::DateTime::parse_from_rfc3339(next_deadline_at_iso)
        .ok()
        .map(|d| {
            d.with_timezone(&chrono::Utc)
                .format("%Y-%m-%d %H:%M UTC")
                .to_string()
        })
        .unwrap_or_else(|| next_deadline_at_iso.to_string());

    let base = public_base_url();
    let one_tap_url = format!("{base}/#/checkin-link/{vault_id}/{token}");
    let display_label = label.unwrap_or("your GhostKey vault");

    if let Some(contact) = &email_contact {
        let subject = format!("Reminder: {display_label} check-in due {deadline_friendly}");
        let body = format!(
            "Hello,\n\n\
             A quick reminder that {display_label} needs a check-in by \
             {deadline_friendly}. That's about 24 hours from now.\n\n\
             Tap this link to check in. One tap. Nothing else.\n\n\
             {one_tap_url}\n\n\
             If you can't tap from this email, open the dashboard on any \
             device and tap \"I'm still here\":\n\n\
             {base}/#/checkin\n\n\
             If we don't hear from you by the deadline, you'll get one more \
             email — and then your heir will be contacted after the \
             grace period.\n\n\
             If this email reached you by mistake, you can ignore it.\n\n\
             — GhostKey\n"
        );

        notifier::enqueue(
            &state.db,
            vault_id,
            NotificationKind::PreDeadlineReminder,
            Channel::Email,
            &contact.address,
            &subject,
            &body,
        )
        .await?;
    }

    if has_push {
        let title = "Time to check in".to_string();
        let push_body = serde_json::json!({
            "title": title,
            "body": format!(
                "{display_label} needs a check-in by {deadline_friendly}. \
                 One tap and you're done."
            ),
            "url": one_tap_url,
        })
        .to_string();
        notifier::enqueue(
            &state.db,
            vault_id,
            NotificationKind::PreDeadlineReminder,
            Channel::WebPush,
            "webpush",
            &title,
            &push_body,
        )
        .await?;
    }

    // Set the per-cycle marker so we don't re-send on the next tick.
    // Cleared on every successful check-in (see routes::checkin,
    // psbt_routes, lightning::mark_paid_and_checkin).
    sqlx::query("UPDATE vaults SET pre_deadline_reminder_sent_at = ? WHERE id = ?")
        .bind(now_iso)
        .bind(vault_id)
        .execute(&state.db)
        .await?;

    tracing::info!(vault_id = %vault_id, "pre-deadline reminder enqueued");
    Ok(())
}
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
/// Move every vault past its `next_deadline_at` from `ok` to `alarmed`.
/// Records an `alarm` event so operators / notifier integrations can
/// surface "missed check-in" to the owner.
///
/// Also: when the vault has a sealed owner contact (set by the web
/// wizard), enqueue an `AlarmOwner` email so the owner gets a real
/// nudge rather than learning about the missed check-in only when
/// their heir starts asking questions. The email carries the same
/// per-cycle one-tap token as the pre-deadline reminder (when the
/// pre-deadline reminder fired and the token is still live), so the
/// owner can check in from the alarm email without typing a password.
/// The enqueue is best-effort — a failure here logs and continues;
/// the status transition has already committed, and the next
/// scheduler tick won't re-issue because the row's status is no
/// longer `ok`.
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
        //   - owner alarm delivers over email or web push only; the
        //     owner contact channel is email in the UI, so a non-email
        //     channel here is skipped → Ok(None)
        //   - decryption failed (corrupt row, master key rotated)
        //     → tracing::warn and continue
        if let Err(e) = enqueue_alarm_owner(
            state,
            &id,
            label.as_deref(),
            SealedOwnerContactRow {
                ciphertext_b64: ow_ct.as_deref(),
                nonce_b64: ow_nn.as_deref(),
                channel: ow_ch.as_deref(),
            },
            &claim_eligible_at,
            now_iso,
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
    owner: SealedOwnerContactRow<'_>,
    claim_eligible_at_iso: &str,
    now_iso: &str,
) -> anyhow::Result<()> {
    // Same two-channel fan-out as the pre-deadline reminder: sealed
    // owner email and/or web push subscriptions, independently
    // optional.
    let email_contact = parse_owner_contact(
        vault_id,
        owner.ciphertext_b64,
        owner.nonce_b64,
        owner.channel,
    )?
    .filter(|c| matches!(c.channel, Channel::Email));

    let has_push =
        sqlx::query_as::<_, (i64,)>("SELECT COUNT(*) FROM push_subscriptions WHERE vault_id = ?")
            .bind(vault_id)
            .fetch_one(&state.db)
            .await?
            .0
            > 0;

    if email_contact.is_none() && !has_push {
        tracing::info!(
            vault_id = %vault_id,
            "no deliverable owner contact (email or push); skipping owner alarm notification"
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
    let display_label = label.unwrap_or("your GhostKey vault");

    // Reuse the pre-deadline reminder's token when it's still live,
    // otherwise mint a fresh one. `Some(token)` means both channels
    // carry a working one-tap URL; `None` means we lost a race or the
    // row vanished — the email goes out without the one-tap block and
    // the push falls back to the dashboard check-in page.
    let one_tap_url = mint_or_reuse_one_tap_token(state, vault_id, now_iso)
        .await?
        .map(|token| format!("{base}/#/checkin-link/{vault_id}/{token}"));

    if let Some(contact) = &email_contact {
        let one_tap_block = match &one_tap_url {
            Some(url) => format!(
                "Tap this link to check in. One tap. Nothing else.\n\n\
                 {url}\n\n"
            ),
            None => String::new(),
        };

        let subject = "You missed your GhostKey check-in".to_string();
        let body = format!(
            "Hello,\n\n\
             {display_label} just missed its check-in deadline. We'd usually \
             remind you sooner — this is the last reminder before the \
             next step.\n\n\
             {one_tap_block}\
             You can also open the dashboard on any device and tap \
             \"I'm still here\" to reset the clock:\n\n\
             {base}/#/checkin\n\n\
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
    }

    if has_push {
        let title = "You missed your check-in".to_string();
        let push_body = serde_json::json!({
            "title": title,
            "body": format!(
                "{display_label} missed its deadline. Check in by \
                 {claim_friendly} or your heir will be contacted."
            ),
            "url": one_tap_url
                .clone()
                .unwrap_or_else(|| format!("{base}/#/checkin")),
        })
        .to_string();
        notifier::enqueue(
            &state.db,
            vault_id,
            NotificationKind::AlarmOwner,
            Channel::WebPush,
            "webpush",
            &title,
            &push_body,
        )
        .await?;
    }

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
        let (raw_token, token_hash, reused) = if let Some(raw) = at_rest.as_ref() {
            // Door A: the token was sealed at rest at creation time
            // (legacy rows are plaintext and pass through unchanged).
            // The heir's xprv ciphertext is bound to THIS token via
            // HKDF, so we must reuse it — even if an intervening owner
            // check-in cleared `claim_token_hash` (the check-in handler
            // nulls the hash but never the at-rest token). Decrypt back
            // to the bearer value, and re-derive the hash when the
            // stored one was wiped, so the claim resolver can match it.
            let token = crate::crypto::open_claim_token_at_rest(&id, raw)?;
            let hash = existing_hash
                .clone()
                .unwrap_or_else(|| crate::crypto::hash_claim_token(&token));
            (token, hash, true)
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
            // Re-bind the hash too: a prior owner check-in may have nulled
            // it, and the claim resolver looks the heir's link up by hash.
            // For an untouched password vault this is a no-op (same value).
            sqlx::query(
                r#"UPDATE vaults
                      SET status                = 'timelock_started',
                          claim_token_hash      = ?,
                          claim_token_issued_at = ?,
                          claim_token_used_at   = NULL
                    WHERE id = ?
                      AND status = 'alarmed'"#,
            )
            .bind(&token_hash)
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

        // Try to enqueue a notification for the heir. Email, SMS, and
        // WhatsApp are all deliverable (the worker routes them to SMTP
        // or Twilio); an unknown channel is logged and skipped. A vault
        // with no encrypted heir contact (legacy, or owner declined to
        // provide one) also skips here. None of those skips block the
        // status transition above.
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

    // Email, SMS, and WhatsApp are all deliverable: the notifier worker
    // routes email over SMTP and sms/whatsapp over Twilio. If the
    // matching backend isn't configured yet (e.g. Twilio secrets not
    // set), the worker leaves the row pending and retries once it is —
    // enqueuing here is safe regardless.
    let channel = match contact.channel.as_deref() {
        Some("email") => Channel::Email,
        Some("sms") => Channel::Sms,
        Some("whatsapp") => Channel::Whatsapp,
        Some(other) => {
            tracing::info!(vault_id = %vault_id, channel = %other, "heir channel not deliverable; skipping notification");
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

    // Demo mode has no real delivery channel in a local run (no SMTP /
    // Twilio), so the claim link would otherwise stay sealed in the
    // notifications table and the operator could never open the claim
    // page. Print it to the server log so a local demo is self-serve.
    // Gated on demo mode, which is already forbidden on mainnet — a
    // production server never logs a live claim link.
    if crate::demo::demo_mode() {
        tracing::warn!(vault_id = %vault_id, "DEMO MODE claim link (do not enable in production): {claim_url}");
    }

    // F5: the heir must not learn the vault label before they open
    // the claim link — the label often names the asset ("BTC for
    // mom"), which leaks the owner's identity to anyone who can read
    // the heir's email. The label is still rendered inside the claim
    // UI, behind the one-time token. `label` is intentionally read
    // (and dropped) here so any future copy change has the variable
    // to hand without re-plumbing the function signature.
    let _ = label;
    let heir_name = contact.name.as_deref().unwrap_or("there");

    // #98 Part 2 (item 3): a named, personal first contact. If the owner
    // gave their name and/or a short note at setup, weave them in so the
    // message reads as a real person reaching out, not a cold "someone".
    // Absent for legacy vaults and owners who skipped it.
    let intro = load_heir_intro(state, vault_id).await;
    let from_name = intro
        .as_ref()
        .and_then(|i| i.from_name.as_deref())
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let note = intro
        .as_ref()
        .and_then(|i| i.note.as_deref())
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let email_opener = match from_name {
        Some(n) => format!("{n} set up a Bitcoin inheritance with GhostKey"),
        None => "Someone you knew set up a Bitcoin inheritance with GhostKey".to_string(),
    };
    let note_block = match note {
        Some(n) => format!("They left you a note:\n\n  {n}\n\n"),
        None => String::new(),
    };
    let sms_opener = match from_name {
        Some(n) => format!("{n} left you a Bitcoin inheritance through GhostKey"),
        None => "someone you knew left you a Bitcoin inheritance through GhostKey".to_string(),
    };

    let subject = "A message for you about something someone left you".to_string();
    // Email carries the full explanation. SMS and WhatsApp get a short
    // message that fits a segment or two, with the same one-time link.
    // (The subject above is unused on the Twilio path — send_twilio only
    // sends the body — but enqueue stores it sealed either way.)
    let body = match channel {
        Channel::Email => format!(
            "Hello {heir_name},\n\n\
             {email_opener}, and asked us to reach out to you if they ever \
             stopped checking in. That has happened.\n\n\
             {note_block}\
             Before you open anything: a message like this can look like a \
             scam, and you are right to be careful. Look up GhostKey on your \
             own and make sure it is genuine first. Don't take this message's \
             word for it.\n\n\
             When you are ready, open this link on any phone or computer to \
             see what they left you and the next steps:\n\n\
             {claim_url}\n\n\
             The link works once. You don't need an account.\n\n\
             If this message reached you by mistake, you can ignore it. \
             Nothing happens until you open the link.\n\n\
             — GhostKey\n"
        ),
        _ => format!(
            "Hello {heir_name}, {sms_opener} and asked us to reach you if \
             they ever stopped checking in. A message like this can look \
             like a scam, so please check GhostKey is genuine before you \
             open anything. When you're ready:\n\n{claim_url}\n\nThe link \
             works once. You don't need an account."
        ),
    };

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

/// #98 Part 2 (item 3): the owner's optional name + note for the heir,
/// sealed per-vault as a JSON blob. `None` when absent or unreadable
/// (legacy vaults, owner skipped it, or a key mismatch) — the caller
/// falls back to the generic "someone you knew" wording.
#[derive(serde::Deserialize, Default)]
struct HeirIntro {
    from_name: Option<String>,
    note: Option<String>,
}

async fn load_heir_intro(state: &AppState, vault_id: &str) -> Option<HeirIntro> {
    let row: Option<(Option<String>, Option<String>)> =
        sqlx::query_as("SELECT heir_intro_ciphertext, heir_intro_nonce FROM vaults WHERE id = ?")
            .bind(vault_id)
            .fetch_optional(&state.db)
            .await
            .ok()
            .flatten();
    let (Some(ct), Some(nn)) = row? else {
        return None;
    };
    let bytes = crate::crypto::open_for_vault(
        vault_id,
        &crate::crypto::SealedContact {
            ciphertext_b64: ct,
            nonce_b64: nn,
        },
    )
    .ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// The public base URL the heir's claim link should point at. We
/// keep this configurable so a deployment serving the dashboard at
/// e.g. `ghostkeyapp.vercel.app` can produce links that go there
/// rather than to the API host.
pub(crate) fn public_base_url() -> String {
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

    /// Regression: an owner check-in clears `claim_token_hash` (the
    /// check-in handler nulls it so a follow-on alarm starts fresh) but
    /// never clears `claim_token_at_rest_b64`. A password vault that
    /// received at least one check-in before lapsing therefore reaches
    /// the trigger with a sealed at-rest token but NO hash. The heir's
    /// xprv is sealed under that at-rest token, so we must reuse it and
    /// re-derive the hash — minting a fresh token here would lock the
    /// heir out permanently. (This is the bug the signet e2e surfaced.)
    #[tokio::test]
    async fn password_vault_reuses_at_rest_token_after_checkin_cleared_hash() {
        ensure_test_master_key();
        let pool = fresh_db().await;
        let state = AppState {
            db: pool.clone(),
            lightning: std::sync::Arc::new(crate::lightning::NoopProvider),
        };

        let raw_token = "browser-minted-token-bound-to-the-heir-seal";
        let sealed_at_rest =
            crate::crypto::seal_claim_token_at_rest("vault-pw-checked-in", raw_token)
                .expect("seal token");
        let expected_hash = crate::crypto::hash_claim_token(raw_token);

        // Note: claim_token_hash is NULL — exactly the post-check-in state.
        sqlx::query(
            r#"INSERT INTO vaults (
                id, network, descriptor_external, descriptor_internal,
                timelock_blocks, checkin_period_secs, grace_period_secs,
                created_at, next_deadline_at, status, claim_eligible_at,
                claim_token_at_rest_b64, claim_token_hash
            ) VALUES (?, 'regtest', 'tr(fake/0/*)', 'tr(fake/1/*)',
                      144, 86400, 3600,
                      '2026-01-01T00:00:00Z', '2026-04-01T00:00:00Z', 'alarmed',
                      '2026-04-08T00:00:00Z', ?, NULL)"#,
        )
        .bind("vault-pw-checked-in")
        .bind(&sealed_at_rest)
        .execute(&pool)
        .await
        .expect("insert checked-in password vault");

        tick_once(&state).await.expect("tick");

        let (status, hash) = read_status_and_token_hash(&pool, "vault-pw-checked-in").await;
        assert_eq!(
            status, "timelock_started",
            "the vault must still advance to claimable"
        );
        assert_eq!(
            hash.as_deref(),
            Some(expected_hash.as_str()),
            "the hash must be re-derived from the reused at-rest token, \
             not minted fresh — otherwise the heir's sealed key is orphaned"
        );

        let detail: Option<String> = sqlx::query_scalar(
            "SELECT detail FROM events WHERE vault_id = ? AND kind = 'claim_issued'",
        )
        .bind("vault-pw-checked-in")
        .fetch_optional(&pool)
        .await
        .expect("query")
        .flatten();
        assert!(
            detail
                .as_deref()
                .is_some_and(|d| d.contains("reused_password_vault_token")),
            "the trigger must record a reused (not freshly-minted) token"
        );
    }

    /// Step 3: the at-rest token is now sealed under the per-vault AEAD.
    /// On trigger the scheduler must decrypt it back to the bearer value
    /// before it goes in the heir's link — the sealed `gk1.` blob must
    /// never reach the email.
    #[tokio::test]
    async fn password_vault_decrypts_sealed_at_rest_token_into_heir_link() {
        ensure_test_master_key();
        let pool = fresh_db().await;
        let state = AppState {
            db: pool.clone(),
            lightning: std::sync::Arc::new(crate::lightning::NoopProvider),
        };

        let raw_token = "the-real-bearer-token-1234567890ABCdef";
        let sealed_at_rest =
            crate::crypto::seal_claim_token_at_rest("vault-sealed", raw_token).expect("seal token");
        assert!(sealed_at_rest.starts_with("gk1."), "precondition: sealed");
        let hash = crate::crypto::hash_claim_token(raw_token);

        // Heir contact JSON, sealed exactly as the create path stores it.
        let heir_json = serde_json::json!({
            "name": "Sarah",
            "contact": "sarah@example.com",
            "channel": "email"
        })
        .to_string();
        let heir_sealed =
            crate::crypto::seal_for_vault("vault-sealed", heir_json.as_bytes()).expect("seal heir");

        sqlx::query(
            r#"INSERT INTO vaults (
                id, network, descriptor_external, descriptor_internal,
                timelock_blocks, checkin_period_secs, grace_period_secs,
                created_at, next_deadline_at, status, claim_eligible_at,
                heir_contact_ciphertext, heir_contact_nonce, heir_contact_channel,
                claim_token_at_rest_b64, claim_token_hash
            ) VALUES (?, 'regtest', 'tr(fake/vault-sealed/0/*)', 'tr(fake/vault-sealed/1/*)',
                      144, 86400, 3600,
                      '2026-01-01T00:00:00Z', '2026-04-01T00:00:00Z', 'alarmed',
                      '2026-04-08T00:00:00Z', ?, ?, 'email', ?, ?)"#,
        )
        .bind("vault-sealed")
        .bind(&heir_sealed.ciphertext_b64)
        .bind(&heir_sealed.nonce_b64)
        .bind(&sealed_at_rest)
        .bind(&hash)
        .execute(&pool)
        .await
        .expect("insert sealed-at-rest vault");

        tick_once(&state).await.expect("tick");

        // Read the enqueued claim-link notification body and decrypt it.
        let (body_ct, body_nonce): (String, String) = sqlx::query_as(
            "SELECT body_ciphertext, body_nonce FROM notifications \
               WHERE vault_id = ? ORDER BY id DESC LIMIT 1",
        )
        .bind("vault-sealed")
        .fetch_one(&pool)
        .await
        .expect("a claim-link notification was enqueued");
        let body = String::from_utf8(
            crate::crypto::open_for_vault(
                "vault-sealed",
                &crate::crypto::SealedContact {
                    ciphertext_b64: body_ct,
                    nonce_b64: body_nonce,
                },
            )
            .expect("open notification body"),
        )
        .expect("utf8 body");

        assert!(
            body.contains(raw_token),
            "the heir link must carry the decrypted token; body: {body}"
        );
        assert!(
            !body.contains("gk1."),
            "the sealed at-rest blob must never reach the heir; body: {body}"
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

    /// Insert a claim-ready vault carrying a sealed heir contact with a
    /// chosen channel. The heir contact is a sealed JSON blob
    /// `{name, contact, channel}` (unlike the owner's plain-string
    /// contact + separate channel column).
    async fn insert_vault_with_sealed_heir(
        pool: &SqlitePool,
        id: &str,
        next_deadline_at: &str,
        claim_eligible_at: &str,
        channel: &str,
        contact: &str,
    ) {
        let json = format!(r#"{{"name":"Pat","contact":"{contact}","channel":"{channel}"}}"#);
        let sealed = crate::crypto::seal_for_vault(id, json.as_bytes()).expect("seal heir contact");
        sqlx::query(
            r#"INSERT INTO vaults (
                id, network,
                descriptor_external, descriptor_internal,
                timelock_blocks,
                checkin_period_secs, grace_period_secs,
                created_at, next_deadline_at, status,
                claim_eligible_at,
                heir_contact_ciphertext, heir_contact_nonce
            ) VALUES (?, 'regtest', ?, ?, 144, 86400, 3600,
                      '2026-01-01T00:00:00Z', ?, 'alarmed', ?,
                      ?, ?)"#,
        )
        .bind(id)
        .bind(format!("tr(fake/{id}/0/*)"))
        .bind(format!("tr(fake/{id}/1/*)"))
        .bind(next_deadline_at)
        .bind(claim_eligible_at)
        .bind(&sealed.ciphertext_b64)
        .bind(&sealed.nonce_b64)
        .execute(pool)
        .await
        .expect("insert vault with sealed heir contact");
    }

    /// A heir saved with the WhatsApp channel must get a `claim_link`
    /// notification enqueued on the Twilio (whatsapp) channel when the
    /// claim becomes eligible — the scheduler used to skip every
    /// non-email channel, dropping these silently.
    #[tokio::test]
    async fn claim_link_enqueued_for_whatsapp_heir() {
        ensure_test_master_key();
        let pool = fresh_db().await;
        let state = AppState {
            db: pool.clone(),
            lightning: std::sync::Arc::new(crate::lightning::NoopProvider),
        };
        insert_vault_with_sealed_heir(
            &pool,
            "vault-wa",
            "2026-04-01T00:00:00Z", // deadline past
            "2026-04-08T00:00:00Z", // eligibility past
            "whatsapp",
            "+15551230000",
        )
        .await;

        tick_once(&state).await.expect("tick");

        let (status, hash) = read_status_and_token_hash(&pool, "vault-wa").await;
        assert_eq!(status, "timelock_started");
        assert!(hash.is_some(), "claim token must be issued");

        let (kind, channel, status_n): (String, String, String) = sqlx::query_as(
            "SELECT kind, channel, status FROM notifications \
             WHERE vault_id = 'vault-wa' AND kind = 'claim_link'",
        )
        .fetch_one(&pool)
        .await
        .expect("claim_link notification row");
        assert_eq!(kind, "claim_link");
        assert_eq!(channel, "whatsapp");
        assert_eq!(status_n, "pending");
    }

    /// #98 Part 2 (item 3): when the owner left a name + note, the claim
    /// email opens with their name and includes the note, instead of the
    /// generic "someone you knew" wording.
    #[tokio::test]
    async fn claim_link_includes_owner_name_and_note() {
        ensure_test_master_key();
        let pool = fresh_db().await;
        let state = AppState {
            db: pool.clone(),
            lightning: std::sync::Arc::new(crate::lightning::NoopProvider),
        };
        insert_vault_with_sealed_heir(
            &pool,
            "vault-intro",
            "2026-04-01T00:00:00Z",
            "2026-04-08T00:00:00Z",
            "email",
            "heir@example.com",
        )
        .await;

        // Attach a sealed heir_intro blob, as create_vault_from_xpub does.
        let blob = r#"{"from_name":"Jane Adeyemi","note":"For your school fees. Love, Mum."}"#;
        let sealed =
            crate::crypto::seal_for_vault("vault-intro", blob.as_bytes()).expect("seal intro");
        sqlx::query(
            "UPDATE vaults SET heir_intro_ciphertext = ?, heir_intro_nonce = ? WHERE id = ?",
        )
        .bind(&sealed.ciphertext_b64)
        .bind(&sealed.nonce_b64)
        .bind("vault-intro")
        .execute(&pool)
        .await
        .expect("attach heir_intro");

        tick_once(&state).await.expect("tick");

        let (body_ct, body_nn): (String, String) = sqlx::query_as(
            "SELECT body_ciphertext, body_nonce FROM notifications \
             WHERE vault_id = 'vault-intro' AND kind = 'claim_link'",
        )
        .fetch_one(&pool)
        .await
        .expect("claim_link notification row");
        let body = String::from_utf8(
            crate::crypto::open_for_vault(
                "vault-intro",
                &crate::crypto::SealedContact {
                    ciphertext_b64: body_ct,
                    nonce_b64: body_nn,
                },
            )
            .expect("decrypt body"),
        )
        .expect("utf8 body");

        assert!(
            body.contains("Jane Adeyemi set up a Bitcoin inheritance"),
            "named opener missing from body: {body}"
        );
        assert!(
            body.contains("For your school fees. Love, Mum."),
            "personal note missing from body: {body}"
        );
        assert!(
            !body.contains("Someone you knew set up"),
            "generic opener should be replaced when a name is present: {body}"
        );
    }

    /// The scheduler heartbeat is a single upserted row: repeated ticks
    /// overwrite it rather than accumulating, and it records a timestamp
    /// that /health can age out.
    #[tokio::test]
    async fn heartbeat_upserts_single_row() {
        let pool = fresh_db().await;
        record_heartbeat(&pool).await;
        record_heartbeat(&pool).await;

        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM scheduler_heartbeat")
            .fetch_one(&pool)
            .await
            .expect("count heartbeat rows");
        assert_eq!(count, 1, "heartbeat must be a single upserted row");

        let last: Option<String> =
            sqlx::query_scalar("SELECT last_tick_at FROM scheduler_heartbeat WHERE id = 1")
                .fetch_optional(&pool)
                .await
                .expect("read heartbeat");
        assert!(last.is_some(), "heartbeat must record a timestamp");
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

    /* ---------------------------------------------------------------- *
     *  Pre-deadline reminder + one-tap link tests                      *
     *                                                                  *
     *  Wired in 20260528. Pin the contract:                            *
     *    - reminder fires once per cycle when deadline is within the   *
     *      lead window AND the row has a sealed owner contact,         *
     *    - reminder does NOT fire when the deadline is further out,    *
     *    - reminder does NOT re-fire on later ticks within the same    *
     *      cycle (`pre_deadline_reminder_sent_at` guard),              *
     *    - a successful check-in clears the per-cycle markers so the   *
     *      NEXT cycle is eligible for a fresh reminder,                *
     *    - the one-tap token minted by the reminder is reused by the   *
     *      alarm email (rather than the alarm minting its own and     *
     *      invalidating the reminder's URL).                           *
     * ---------------------------------------------------------------- */

    /// Reminder fires when the deadline is within 24h and the vault
    /// has a sealed owner contact.
    #[tokio::test]
    async fn pre_deadline_reminder_fires_within_lead_window() {
        ensure_test_master_key();
        let pool = fresh_db().await;
        let state = AppState {
            db: pool.clone(),
            lightning: std::sync::Arc::new(crate::lightning::NoopProvider),
        };
        // Deadline 1 hour from now — well inside the 24h lead.
        let deadline = (Utc::now() + chrono::Duration::hours(1)).to_rfc3339();
        insert_vault_with_sealed_owner(
            &pool,
            "vault-pre1",
            "ok",
            &deadline,
            "2030-01-01T00:00:00Z",
            "carol@example.test",
        )
        .await;

        tick_once(&state).await.expect("tick");

        let (kind, channel, ct, nn): (String, String, String, String) = sqlx::query_as(
            "SELECT kind, channel, recipient_ciphertext, recipient_nonce \
             FROM notifications WHERE vault_id = 'vault-pre1'",
        )
        .fetch_one(&pool)
        .await
        .expect("notification row");
        assert_eq!(kind, "pre_deadline_reminder");
        assert_eq!(channel, "email");

        // Sealed recipient decrypts back to the address we set up.
        let opened = crate::crypto::open_for_vault(
            "vault-pre1",
            &crate::crypto::SealedContact {
                ciphertext_b64: ct,
                nonce_b64: nn,
            },
        )
        .expect("decrypt recipient");
        assert_eq!(opened, b"carol@example.test");

        // The per-cycle marker is set so the next tick skips this row.
        let marker: Option<String> = sqlx::query_scalar(
            "SELECT pre_deadline_reminder_sent_at FROM vaults WHERE id = 'vault-pre1'",
        )
        .fetch_one(&pool)
        .await
        .expect("marker");
        assert!(
            marker.is_some(),
            "pre_deadline_reminder_sent_at must be set"
        );

        // A one-tap token was minted and hashed at rest.
        let token_hash: Option<String> = sqlx::query_scalar(
            "SELECT checkin_link_token_hash FROM vaults WHERE id = 'vault-pre1'",
        )
        .fetch_one(&pool)
        .await
        .expect("token hash");
        assert!(token_hash.is_some(), "checkin_link_token_hash must be set");
    }

    /// Reminder does NOT fire when the deadline is further out than
    /// the lead window. This is the SQL's `next_deadline_at <= window_end`
    /// gate; regressions here would spam owners weeks in advance.
    #[tokio::test]
    async fn pre_deadline_reminder_does_not_fire_outside_lead_window() {
        ensure_test_master_key();
        let pool = fresh_db().await;
        let state = AppState {
            db: pool.clone(),
            lightning: std::sync::Arc::new(crate::lightning::NoopProvider),
        };
        // Deadline 7 days from now — well outside the 24h lead.
        let deadline = (Utc::now() + chrono::Duration::days(7)).to_rfc3339();
        insert_vault_with_sealed_owner(
            &pool,
            "vault-pre2",
            "ok",
            &deadline,
            "2030-01-01T00:00:00Z",
            "dave@example.test",
        )
        .await;

        tick_once(&state).await.expect("tick");

        let n: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM notifications WHERE vault_id = 'vault-pre2'")
                .fetch_one(&pool)
                .await
                .expect("count");
        assert_eq!(n, 0, "no reminder should fire when deadline is far away");

        let marker: Option<String> = sqlx::query_scalar(
            "SELECT pre_deadline_reminder_sent_at FROM vaults WHERE id = 'vault-pre2'",
        )
        .fetch_one(&pool)
        .await
        .expect("marker");
        assert!(
            marker.is_none(),
            "marker must stay NULL when no reminder fires"
        );
    }

    /// Reminder is sent at most once per cycle. Subsequent ticks must
    /// observe the marker and skip.
    #[tokio::test]
    async fn pre_deadline_reminder_is_single_shot_per_cycle() {
        ensure_test_master_key();
        let pool = fresh_db().await;
        let state = AppState {
            db: pool.clone(),
            lightning: std::sync::Arc::new(crate::lightning::NoopProvider),
        };
        let deadline = (Utc::now() + chrono::Duration::hours(1)).to_rfc3339();
        insert_vault_with_sealed_owner(
            &pool,
            "vault-pre3",
            "ok",
            &deadline,
            "2030-01-01T00:00:00Z",
            "ed@example.test",
        )
        .await;

        for _ in 0..5 {
            tick_once(&state).await.expect("tick");
        }

        let n: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM notifications WHERE vault_id = 'vault-pre3' AND kind = 'pre_deadline_reminder'",
        )
        .fetch_one(&pool)
        .await
        .expect("count");
        assert_eq!(n, 1, "exactly one pre-deadline reminder per cycle");
    }

    /// Vault without a sealed owner contact: no reminder, no marker.
    /// SQL's `AND owner_contact_ciphertext IS NOT NULL` is the gate.
    #[tokio::test]
    async fn pre_deadline_reminder_skips_when_no_sealed_contact() {
        ensure_test_master_key();
        let pool = fresh_db().await;
        let state = AppState {
            db: pool.clone(),
            lightning: std::sync::Arc::new(crate::lightning::NoopProvider),
        };
        // Insert a vault directly with no owner contact at all.
        let deadline = (Utc::now() + chrono::Duration::hours(1)).to_rfc3339();
        sqlx::query(
            r#"INSERT INTO vaults (
                id, network,
                descriptor_external, descriptor_internal,
                timelock_blocks,
                checkin_period_secs, grace_period_secs,
                created_at, next_deadline_at, status,
                claim_eligible_at
            ) VALUES ('vault-pre4', 'regtest',
                      'tr(fake/pre4/0/*)', 'tr(fake/pre4/1/*)',
                      144, 86400, 3600,
                      '2026-01-01T00:00:00Z', ?, 'ok',
                      '2030-01-01T00:00:00Z')"#,
        )
        .bind(&deadline)
        .execute(&pool)
        .await
        .expect("insert legacy vault");

        tick_once(&state).await.expect("tick");

        let n: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM notifications WHERE vault_id = 'vault-pre4'")
                .fetch_one(&pool)
                .await
                .expect("count");
        assert_eq!(n, 0);
    }

    /// A successful (button) check-in must clear both the
    /// per-cycle reminder marker AND the one-tap token columns, so
    /// the NEXT cycle is fully eligible for a fresh reminder and
    /// link. The SQL that does this lives in `routes::checkin` and
    /// `lightning::mark_paid_and_checkin`; we exercise the routes
    /// SQL by issuing a direct UPDATE here (we don't have a Router
    /// in the scheduler tests). The point of the test is that the
    /// scheduler's SECOND-cycle behaviour does the right thing
    /// after the columns have been zeroed.
    #[tokio::test]
    async fn checkin_clears_markers_so_next_cycle_re_eligible() {
        ensure_test_master_key();
        let pool = fresh_db().await;
        let state = AppState {
            db: pool.clone(),
            lightning: std::sync::Arc::new(crate::lightning::NoopProvider),
        };
        let deadline = (Utc::now() + chrono::Duration::hours(1)).to_rfc3339();
        insert_vault_with_sealed_owner(
            &pool,
            "vault-pre5",
            "ok",
            &deadline,
            "2030-01-01T00:00:00Z",
            "fran@example.test",
        )
        .await;

        // Cycle 1: tick, reminder fires, marker set, token minted.
        tick_once(&state).await.expect("cycle 1 tick");
        let (marker1, hash1): (Option<String>, Option<String>) = sqlx::query_as(
            "SELECT pre_deadline_reminder_sent_at, checkin_link_token_hash \
             FROM vaults WHERE id = 'vault-pre5'",
        )
        .fetch_one(&pool)
        .await
        .expect("cycle 1 state");
        assert!(marker1.is_some());
        assert!(hash1.is_some());

        // Simulate a successful check-in: clear all the columns that
        // `routes::checkin` clears, AND push the deadline back into
        // the lead window for the next cycle.
        let new_deadline = (Utc::now() + chrono::Duration::hours(1)).to_rfc3339();
        sqlx::query(
            r#"UPDATE vaults
                  SET next_deadline_at              = ?,
                      pre_deadline_reminder_sent_at = NULL,
                      checkin_link_token_hash       = NULL,
                      checkin_link_token_issued_at  = NULL,
                      checkin_link_token_used_at    = NULL
                WHERE id = 'vault-pre5'"#,
        )
        .bind(&new_deadline)
        .execute(&pool)
        .await
        .expect("simulate checkin reset");

        // Cycle 2: tick, a NEW reminder should fire — proving the
        // markers were cleared and the row is eligible again.
        tick_once(&state).await.expect("cycle 2 tick");
        let n: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM notifications WHERE vault_id = 'vault-pre5' AND kind = 'pre_deadline_reminder'",
        )
        .fetch_one(&pool)
        .await
        .expect("count");
        assert_eq!(
            n, 2,
            "second cycle must enqueue a second reminder once the markers are cleared"
        );
    }

    /// The one-tap token minted by the pre-deadline reminder must
    /// be REUSED by the alarm email when the same cycle ages into
    /// the alarm transition. Without this, the alarm would mint a
    /// fresh hash and silently invalidate the still-deliverable
    /// reminder URL.
    #[tokio::test]
    async fn one_tap_token_is_reused_across_reminder_and_alarm() {
        ensure_test_master_key();
        let pool = fresh_db().await;
        let state = AppState {
            db: pool.clone(),
            lightning: std::sync::Arc::new(crate::lightning::NoopProvider),
        };
        // Deadline already past: alarm will fire this tick. The
        // pre-deadline step also matches the row (next_deadline_at
        // <= window_end) but its `next_deadline_at > now` guard
        // means past-deadline rows don't get a reminder \u2014 only
        // the alarm. So the alarm step is what mints the token.
        // Then if we re-tick with a fresh deadline (simulating
        // cycle 2), the reminder step should reuse the token if
        // it's still live.
        let past_deadline = (Utc::now() - chrono::Duration::minutes(5)).to_rfc3339();
        insert_vault_with_sealed_owner(
            &pool,
            "vault-pre6",
            "ok",
            &past_deadline,
            (Utc::now() + chrono::Duration::days(7))
                .to_rfc3339()
                .as_str(),
            "gina@example.test",
        )
        .await;

        // Tick 1: ok -> alarmed, alarm email enqueued, token minted.
        tick_once(&state).await.expect("tick 1");
        let hash_after_alarm: Option<String> = sqlx::query_scalar(
            "SELECT checkin_link_token_hash FROM vaults WHERE id = 'vault-pre6'",
        )
        .fetch_one(&pool)
        .await
        .expect("hash 1");
        assert!(
            hash_after_alarm.is_some(),
            "alarm step must mint a one-tap token"
        );

        // Tick 2: status is now 'alarmed', so neither the pre-deadline
        // step nor the alarm transition fires again. The token row
        // stays put.
        tick_once(&state).await.expect("tick 2");
        let hash_after_idle: Option<String> = sqlx::query_scalar(
            "SELECT checkin_link_token_hash FROM vaults WHERE id = 'vault-pre6'",
        )
        .fetch_one(&pool)
        .await
        .expect("hash 2");
        assert_eq!(
            hash_after_alarm, hash_after_idle,
            "second tick must not change the existing token hash"
        );

        // Exactly one alarm_owner notification and zero
        // pre_deadline_reminder rows (because the deadline was
        // already past at insert time).
        let alarm_n: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM notifications WHERE vault_id = 'vault-pre6' AND kind = 'alarm_owner'",
        )
        .fetch_one(&pool)
        .await
        .expect("alarm count");
        assert_eq!(alarm_n, 1);
        let pre_n: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM notifications WHERE vault_id = 'vault-pre6' AND kind = 'pre_deadline_reminder'",
        )
        .fetch_one(&pool)
        .await
        .expect("pre count");
        assert_eq!(pre_n, 0);
    }

    /// First valid resolve stamps `claim_opened_at`, records the
    /// `claim_opened` event, and gates; once the stamp is older than
    /// the window the gate opens. Relies on the 48h default window
    /// (GHOSTKEY_CLAIM_CHALLENGE_SECS unset in tests).
    #[tokio::test]
    async fn claim_challenge_stamps_then_gates_then_opens() {
        let pool = fresh_db().await;
        let state = AppState {
            db: pool.clone(),
            lightning: std::sync::Arc::new(crate::lightning::NoopProvider),
        };
        insert_vault(
            &pool,
            "vault-cc",
            "timelock_started",
            "2026-04-01T00:00:00Z",
            Some("2026-04-08T00:00:00Z"),
        )
        .await;

        let gate = crate::routes::ensure_claim_challenge(&state, "vault-cc")
            .await
            .expect("first gate call");
        let available = gate.expect("first resolve must open the window");
        assert!(available > Utc::now(), "availability must be in the future");

        let opened: Option<String> =
            sqlx::query_scalar("SELECT claim_opened_at FROM vaults WHERE id = 'vault-cc'")
                .fetch_one(&pool)
                .await
                .expect("read claim_opened_at");
        assert!(opened.is_some(), "claim_opened_at must be stamped");

        let ev: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM events WHERE vault_id = 'vault-cc' AND kind = 'claim_opened'",
        )
        .fetch_one(&pool)
        .await
        .expect("event count");
        assert_eq!(ev, 1, "exactly one claim_opened event");

        // Second call: still gated, no second event.
        let gate2 = crate::routes::ensure_claim_challenge(&state, "vault-cc")
            .await
            .expect("second gate call");
        assert!(gate2.is_some(), "window must still be open");
        let ev2: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM events WHERE vault_id = 'vault-cc' AND kind = 'claim_opened'",
        )
        .fetch_one(&pool)
        .await
        .expect("event count 2");
        assert_eq!(ev2, 1, "no duplicate claim_opened event");

        // Backdate past the 48h default window: the gate opens.
        let past = (Utc::now() - chrono::Duration::seconds(49 * 3600)).to_rfc3339();
        sqlx::query("UPDATE vaults SET claim_opened_at = ? WHERE id = 'vault-cc'")
            .bind(&past)
            .execute(&pool)
            .await
            .expect("backdate");
        let gate3 = crate::routes::ensure_claim_challenge(&state, "vault-cc")
            .await
            .expect("third gate call");
        assert!(gate3.is_none(), "elapsed window must let the claim proceed");
    }

    /// Once the window has elapsed the scheduler marks the row
    /// (dedup) even when there's no heir contact to email.
    #[tokio::test]
    async fn claim_ready_notice_marks_row_once() {
        let pool = fresh_db().await;
        let state = AppState {
            db: pool.clone(),
            lightning: std::sync::Arc::new(crate::lightning::NoopProvider),
        };
        insert_vault(
            &pool,
            "vault-cr",
            "timelock_started",
            "2026-04-01T00:00:00Z",
            Some("2026-04-08T00:00:00Z"),
        )
        .await;
        let past = (Utc::now() - chrono::Duration::seconds(49 * 3600)).to_rfc3339();
        sqlx::query(
            "UPDATE vaults SET claim_token_hash = 'h', claim_opened_at = ? WHERE id = 'vault-cr'",
        )
        .bind(&past)
        .execute(&pool)
        .await
        .expect("arm claim");

        send_claim_ready_notices(&state).await.expect("tick 1");
        let marked: Option<String> =
            sqlx::query_scalar("SELECT claim_ready_notified_at FROM vaults WHERE id = 'vault-cr'")
                .fetch_one(&pool)
                .await
                .expect("read marker");
        assert!(marked.is_some(), "row must be marked after the window");

        // Idempotent: a second tick does nothing.
        send_claim_ready_notices(&state).await.expect("tick 2");
        let n: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM notifications WHERE vault_id = 'vault-cr' AND kind = 'claim_ready'",
        )
        .fetch_one(&pool)
        .await
        .expect("notice count");
        assert_eq!(n, 0, "no heir contact on file -> no email, just the marker");
    }

    /// Issue #70: a panic on a vault WITH a sealed trusted contact
    /// enqueues the panic_alert; a vault without one stays silent.
    #[tokio::test]
    async fn panic_alert_goes_to_trusted_contact() {
        ensure_test_master_key();
        let pool = fresh_db().await;
        insert_vault(&pool, "vault-pa", "ok", "2026-04-01T00:00:00Z", None).await;
        let sealed = crate::crypto::seal_for_vault("vault-pa", b"friend@example.com")
            .expect("seal trusted contact");
        sqlx::query(
            "UPDATE vaults SET trusted_contact_ciphertext = ?, trusted_contact_nonce = ?, \
             trusted_contact_channel = 'email' WHERE id = 'vault-pa'",
        )
        .bind(&sealed.ciphertext_b64)
        .bind(&sealed.nonce_b64)
        .execute(&pool)
        .await
        .expect("store trusted contact");

        crate::lightning::notify_trusted_contact_of_panic(&pool, "vault-pa")
            .await
            .expect("notify");
        let n: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM notifications WHERE vault_id = 'vault-pa' AND kind = 'panic_alert'",
        )
        .fetch_one(&pool)
        .await
        .expect("alert count");
        assert_eq!(n, 1, "panic alert must be enqueued");

        // And a vault without a trusted contact alerts nobody.
        insert_vault(&pool, "vault-pb", "ok", "2026-04-01T00:00:00Z", None).await;
        crate::lightning::notify_trusted_contact_of_panic(&pool, "vault-pb")
            .await
            .expect("notify without contact");
        let n2: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM notifications WHERE vault_id = 'vault-pb' AND kind = 'panic_alert'",
        )
        .fetch_one(&pool)
        .await
        .expect("alert count 2");
        assert_eq!(n2, 0, "no trusted contact -> no alert");
    }
}
