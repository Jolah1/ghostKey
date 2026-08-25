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

use std::sync::{Arc, Mutex, OnceLock};
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

/// Cap on the recovery grace granted after a Lightning outage ends. A long
/// outage shouldn't postpone every heir forever; 24h is enough for an owner
/// to notice Lightning is back and check in.
const MAX_RECOVERY_GRACE_SECS: i64 = 24 * 60 * 60;

/// Process-level tracker for Lightning availability. Lets the scheduler
/// pause the heir-contact transitions during our own Lightning outage (an
/// owner who can't pay a check-in must never be treated as gone) and grant
/// a short grace once Lightning recovers. In-memory only: a restart loses
/// the recovery grace but never the core "don't contact during an outage"
/// guarantee, which is recomputed from a live probe every tick.
#[derive(Default)]
struct LnGate {
    unhealthy_since: Option<chrono::DateTime<Utc>>,
    suppress_until: Option<chrono::DateTime<Utc>>,
}

fn ln_gate() -> &'static Mutex<LnGate> {
    static G: OnceLock<Mutex<LnGate>> = OnceLock::new();
    G.get_or_init(|| Mutex::new(LnGate::default()))
}

/// Decide whether the heir-contact transitions should be paused this tick,
/// updating the gate. Returns true to suppress. Time is injected so this is
/// unit-testable without a real clock or Lightning provider.
fn update_ln_gate(
    gate: &mut LnGate,
    ln_healthy: bool,
    now: chrono::DateTime<Utc>,
    max_grace: chrono::Duration,
) -> bool {
    if !ln_healthy {
        if gate.unhealthy_since.is_none() {
            gate.unhealthy_since = Some(now);
        }
        return true;
    }
    // Healthy. Coming out of an outage, grant a recovery grace equal to the
    // outage length (capped) before any heir can be contacted.
    if let Some(since) = gate.unhealthy_since.take() {
        let outage = now - since;
        let grace = if outage < max_grace {
            outage
        } else {
            max_grace
        };
        gate.suppress_until = Some(now + grace);
    }
    match gate.suppress_until {
        Some(until) if now < until => true,
        _ => {
            gate.suppress_until = None;
            false
        }
    }
}

async fn tick_once(state: &AppState) -> anyhow::Result<()> {
    let now = Utc::now().to_rfc3339();
    unfreeze_expired_panics(state, &now).await?;
    activate_funded_vaults(state, &now).await?;
    // Before the reminder and alarm steps, so a vault that was emptied
    // off-server drops out of the clock this tick rather than being
    // nagged (or escalated) about coins that are already gone.
    retire_drained_vaults(state).await?;
    // Same placement, same reason, for the vault that was never funded at
    // all: stop its clock before anything can nag or escalate on it.
    stand_down_never_funded_vaults(state).await?;
    issue_pre_deadline_reminders(state, &now).await?;
    transition_ok_to_alarmed(state, &now).await?;
    send_alarm_escalations(state, &now).await?;

    // Fail-safe: if Lightning is the check-in but our provider is down, an
    // owner can't prove liveness, so we must not advance any vault to
    // claimable (which contacts the heir). Probe with a short timeout and
    // treat a timeout or error as unhealthy. With no Lightning provider
    // (NoopProvider) we're always "healthy" here, because the free
    // check-in still works.
    let ln_healthy = if state.lightning.is_enabled() {
        matches!(
            tokio::time::timeout(Duration::from_secs(5), state.lightning.probe()).await,
            Ok(Ok(true))
        )
    } else {
        true
    };
    let suppress_heir_contact = {
        let mut gate = ln_gate().lock().expect("ln gate poisoned");
        update_ln_gate(
            &mut gate,
            ln_healthy,
            Utc::now(),
            chrono::Duration::seconds(MAX_RECOVERY_GRACE_SECS),
        )
    };

    if suppress_heir_contact {
        tracing::warn!(
            "lightning unavailable or recently recovered; pausing heir-contact \
             transitions this tick"
        );
    } else {
        transition_alarmed_to_claimable(state, &now).await?;
        send_claim_ready_notices(state).await?;
    }
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
        String,         // descriptor_external
        String,         // descriptor_internal
        String,         // network
        i64,            // timelock_blocks
        Option<i64>,    // chain_unlock_height
        Option<i64>,    // chain_tip_height
        Option<String>, // chain_scanned_at
        Option<i64>,    // chain_has_unspent
    );
    let rows: Vec<ReadyRow> = sqlx::query_as(
        r#"SELECT id, claim_opened_at,
                  heir_contact_ciphertext, heir_contact_nonce,
                  claim_token_at_rest_b64,
                  descriptor_external, descriptor_internal,
                  network, timelock_blocks,
                  chain_unlock_height, chain_tip_height, chain_scanned_at,
                  chain_has_unspent
             FROM vaults
            WHERE claim_opened_at IS NOT NULL
              AND claim_ready_notified_at IS NULL
              AND claim_token_hash IS NOT NULL
              AND claim_token_used_at IS NULL"#,
    )
    .fetch_all(&state.db)
    .await?;

    let now = Utc::now();
    for (
        vault_id,
        opened_s,
        heir_ct,
        heir_nn,
        token_at_rest,
        descriptor_external,
        descriptor_internal,
        network,
        timelock_blocks,
        chain_unlock_height,
        chain_tip_height,
        chain_scanned_at,
        chain_has_unspent,
    ) in rows
    {
        let ready_at = crate::config::parse_rfc(&opened_s) + chrono::Duration::seconds(window);
        if now < ready_at {
            continue;
        }

        // Fix A: the safety wait is over, but don't tell the heir "ready"
        // until the on-chain timelock has actually matured. Otherwise the
        // email promises collection the funds can't yet allow.
        let input = crate::psbt_routes::EstimateInput {
            vault_id: vault_id.clone(),
            descriptor_external,
            descriptor_internal,
            network,
            timelock_blocks,
            cached_unlock_height: chain_unlock_height,
            cached_tip_height: chain_tip_height,
            cached_scanned_at: chain_scanned_at,
            cached_has_unspent: chain_has_unspent,
        };
        if !onchain_funds_ready(state, &input, now).await {
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
             The short safety wait on your claim is over. You can now \
             finish receiving what was left for you.\n\n\
             {link_line}\n\n\
             From GhostKey"
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
/// Whether the notifier can actually carry an owner notification on
/// this channel.
///
/// The owner-facing paths used to accept `Channel::Email` and silently
/// return on anything else, so an owner who picked SMS or WhatsApp at
/// setup got no reminder and no escalation — total silence, then their
/// heir got a claim link (#312). The heir path (`enqueue_claim_link`)
/// already handled all three.
///
/// Web push is deliberately excluded: it's a per-browser subscription
/// fan-out with its own enqueue path, not an address we can seal into a
/// contact row.
fn owner_channel_is_deliverable(channel: Channel) -> bool {
    matches!(channel, Channel::Email | Channel::Sms | Channel::Whatsapp)
}

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
    if !owner_channel_is_deliverable(contact.channel) {
        tracing::warn!(
            vault_id = %vault_id,
            channel = ?contact.channel,
            "owner channel not deliverable; escalation not enqueued"
        );
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

    let amount_sat = crate::lightning::heartbeat_amount_sat();
    let one_tap_block = match mint_or_reuse_one_tap_token(state, vault_id, now_iso).await? {
        Some(token) => format!(
            "Tap this link and pay {amount_sat} sats from any Lightning \
             wallet to check in:\n\n\
             {base}/#/checkin-link/{vault_id}/{token}\n\n"
        ),
        None => String::new(),
    };
    // "1 days" reads like a robot wrote it, at the exact moment the
    // email most needs to be taken seriously.
    let days_word = if days_left == 1 { "day" } else { "days" };

    let (subject, lead) = match count_so_far {
        0 => (
            format!("You missed a check-in. {days_left} {days_word} until your heir is notified"),
            "This is the first daily reminder.".to_string(),
        ),
        n if n < 7 => (
            format!("{days_left} {days_word} left to check in before your heir is contacted"),
            format!("You've now missed {} daily reminders.", n + 1),
        ),
        _ => (
            format!(
                "Last few days: {days_left} {days_word} until your heir is notified about {display_label}"
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
         If we don't hear from you within {days_left} {days_word}, your heir \
         will receive a claim link for this vault. You can stop that \
         instantly by checking in.\n\n\
         From GhostKey\n"
    );

    notifier::enqueue(
        &state.db,
        vault_id,
        NotificationKind::AlarmEscalation,
        contact.channel,
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
    let owner_contact = parse_owner_contact(
        vault_id,
        owner.ciphertext_b64,
        owner.nonce_b64,
        owner.channel,
    )?
    .filter(|c| owner_channel_is_deliverable(c.channel));

    let has_push =
        sqlx::query_as::<_, (i64,)>("SELECT COUNT(*) FROM push_subscriptions WHERE vault_id = ?")
            .bind(vault_id)
            .fetch_one(&state.db)
            .await?
            .0
            > 0;

    if owner_contact.is_none() && !has_push {
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
    let amount_sat = crate::lightning::heartbeat_amount_sat();

    if let Some(contact) = &owner_contact {
        let subject = format!("Reminder: {display_label} check-in due {deadline_friendly}");
        let body = format!(
            "Hello,\n\n\
             A quick reminder that {display_label} needs a check-in by \
             {deadline_friendly}. That's about 24 hours from now.\n\n\
             Tap this link and pay {amount_sat} sats from any Lightning \
             wallet. The payment is your proof you're still here, and it \
             resets the countdown.\n\n\
             {one_tap_url}\n\n\
             If you'd rather not pay from this email, open the dashboard \
             on any device and check in there:\n\n\
             {base}/#/checkin\n\n\
             If we don't hear from you by the deadline, we'll keep \
             reminding you every day through the grace period. Only after \
             that would your heir be contacted.\n\n\
             If this email reached you by mistake, you can ignore it.\n\n\
             From GhostKey\n"
        );

        notifier::enqueue(
            &state.db,
            vault_id,
            NotificationKind::PreDeadlineReminder,
            contact.channel,
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
                 Pay {amount_sat} sats from any Lightning wallet to check in."
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
/// Start the check-in clock only once a vault is actually funded.
///
/// New vaults are created `unfunded`: their deadline placeholder is set
/// but no clock-driven step touches them (reminders, the ok->alarmed
/// transition, and escalations all filter `status = 'ok'`), and the
/// check-in routes refuse them. This step scans each `unfunded` vault;
/// the first time coins appear on-chain it flips the vault to `ok` and
/// (re)starts the cadence from now, so the owner gets a full period
/// before the first deadline. Until then we never nag the owner about,
/// or let them pay Lightning to check in on, an empty vault.
///
/// A scan that finds no UTXOs — or fails to reach the chain — just
/// leaves the vault `unfunded` and retries next tick. Demo deployments
/// create vaults already `ok` (there is no real chain to scan), so this
/// is a no-op there.
///
/// # The unverified-owner hold (#326)
///
/// Funding is necessary to start the clock but not sufficient. An owner
/// whose email was never confirmed is an owner we have no evidence we
/// can reach, and this is the whole cascade's entry point: everything
/// downstream — reminders, the ok->alarmed flip, escalations, and
/// finally the heir's claim link — filters on `status = 'ok'`. Letting
/// an unreachable owner in here is how vault `4a7aaf77` ran a reminder,
/// an alarm, three escalations and a claim link on mainnet with every
/// row reading `sent` and nobody ever seeing one of them.
///
/// So a funded vault whose owner email is unconfirmed stays `unfunded`:
/// funded, inert, and shown as such on the dashboard. Failing here is
/// recoverable — the owner confirms and the clock starts. Failing at the
/// deadline is not.
///
/// The hold is only for the `email` channel. There is no verification
/// flow for sms or whatsapp, and none for a vault with no owner contact
/// at all, so holding those would brick a vault permanently rather than
/// prompt anyone.
async fn activate_funded_vaults(state: &AppState, _now_iso: &str) -> anyhow::Result<()> {
    let rows = sqlx::query_as::<
        _,
        (
            String,         // id
            i64,            // checkin_period_secs
            i64,            // grace_period_secs
            String,         // descriptor_external
            String,         // descriptor_internal
            String,         // network
            i64,            // timelock_blocks
            Option<i64>,    // chain_unlock_height
            Option<i64>,    // chain_tip_height
            Option<String>, // chain_scanned_at
            Option<i64>,    // chain_has_unspent
            Option<String>, // owner_contact_channel
            Option<String>, // owner_contact_verified_at
            i64,            // has_owner_contact
        ),
    >(
        r#"SELECT id, checkin_period_secs, grace_period_secs,
                  descriptor_external, descriptor_internal, network, timelock_blocks,
                  chain_unlock_height, chain_tip_height, chain_scanned_at,
                  chain_has_unspent,
                  owner_contact_channel, owner_contact_verified_at,
                  owner_contact_ciphertext IS NOT NULL AS has_owner_contact
             FROM vaults
            WHERE status = 'unfunded'"#,
    )
    .fetch_all(&state.db)
    .await?;

    let now = Utc::now();
    for (
        id,
        checkin_secs,
        grace_secs,
        descriptor_external,
        descriptor_internal,
        network,
        timelock_blocks,
        chain_unlock_height,
        chain_tip_height,
        chain_scanned_at,
        chain_has_unspent,
        owner_contact_channel,
        owner_contact_verified_at,
        has_owner_contact,
    ) in rows
    {
        let input = crate::psbt_routes::EstimateInput {
            vault_id: id.clone(),
            descriptor_external,
            descriptor_internal,
            network,
            timelock_blocks,
            cached_unlock_height: chain_unlock_height,
            cached_tip_height: chain_tip_height,
            cached_scanned_at: chain_scanned_at,
            cached_has_unspent: chain_has_unspent,
        };

        // Funded == the address scan finds at least one UTXO, including a
        // pending one. An empty successful scan is still "not funded";
        // an explorer error is "unknown" and fails safe the same way.
        match crate::psbt_routes::unlock_estimate_with_cache(&state.db, &input, now).await {
            Ok(est) if est.has_unspent => record_chain_scan(true, None, now),
            Ok(_) => {
                record_chain_scan(true, None, now);
                continue;
            }
            Err(e) => {
                record_chain_scan(false, Some(e.to_string()), now);
                continue;
            }
        }

        // Funded, but we may still have no evidence we can reach the
        // owner. See the hold note on this function.
        if owner_email_unconfirmed(
            has_owner_contact == 1,
            &owner_contact_channel,
            &owner_contact_verified_at,
        ) {
            hold_activation(&state.db, &id).await?;
            continue;
        }

        let next = now + chrono::Duration::seconds(checkin_secs + grace_secs);
        let claim_eligible = next + chrono::Duration::seconds(grace_secs);
        // CAS on status so a racing tick can't double-activate.
        let marked = sqlx::query(
            r#"UPDATE vaults
                  SET status            = 'ok',
                      next_deadline_at  = ?,
                      claim_eligible_at = ?
                WHERE id = ? AND status = 'unfunded'"#,
        )
        .bind(next.to_rfc3339())
        .bind(claim_eligible.to_rfc3339())
        .bind(&id)
        .execute(&state.db)
        .await?;
        if marked.rows_affected() == 0 {
            continue;
        }

        record_event(
            &state.db,
            &id,
            "funded",
            Some(serde_json::json!({ "reason": "onchain_funds_detected" })),
        )
        .await?;
        tracing::info!(
            vault_id = %id,
            "funds detected; vault activated (unfunded -> ok), check-in clock started"
        );

        // Tell the owner their vault is live. Once per vault by
        // construction (the CAS above only lets one tick activate),
        // skipped silently while the email is still unverified, and
        // best-effort: mail trouble must not stop the activation loop.
        let base = public_base_url();
        let body = format!(
            "Hi,\n\n\
             Your vault received its first bitcoin \u{2713} Your check-in \
             clock has started: we will remind you at this address before \
             each check-in is due.\n\n\
             The amount and details are on your dashboard: {base}\n\n\
             From GhostKey"
        );
        if let Err(e) = notifier::enqueue_owner_email(
            &state.db,
            &id,
            NotificationKind::Funded,
            "\u{2713} Your vault is funded",
            &body,
        )
        .await
        {
            tracing::warn!(vault_id = %id, error = %e, "could not enqueue funded email");
        }
    }
    Ok(())
}

/// Whether this vault's owner is reachable only through an email
/// address nobody has ever confirmed.
///
/// False for every other channel, and for a vault with no sealed owner
/// contact, because neither has a way to become true. A legacy row with
/// a channel but no ciphertext is one we cannot mail at all, so holding
/// it would brick it rather than prompt anyone. Mirrors the condition
/// behind `VaultView::owner_contact_verified`.
///
/// See the hold note on `activate_funded_vaults`.
pub(crate) fn owner_email_unconfirmed(
    has_owner_contact: bool,
    channel: &Option<String>,
    verified_at: &Option<String>,
) -> bool {
    has_owner_contact && channel.as_deref() == Some("email") && verified_at.is_none()
}

/// Leave a funded vault `unfunded` because its owner's email is
/// unconfirmed, and say so once in its history.
///
/// Once, not once per tick: this runs every scheduler pass for as long
/// as the owner takes to click the link, and an activity feed full of
/// the same line is a feed the owner stops reading.
async fn hold_activation(db: &sqlx::SqlitePool, vault_id: &str) -> anyhow::Result<()> {
    let already: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM events WHERE vault_id = ? AND kind = 'activation_held')",
    )
    .bind(vault_id)
    .fetch_one(db)
    .await?;
    if already {
        return Ok(());
    }
    record_event(
        db,
        vault_id,
        "activation_held",
        Some(serde_json::json!({ "reason": "owner_email_unverified" })),
    )
    .await?;
    tracing::info!(
        vault_id = %vault_id,
        "funds detected but owner email unconfirmed; check-in clock held (#326)"
    );
    Ok(())
}

/// The mirror of `activate_funded_vaults`: stop the check-in clock once
/// a healthy vault has been emptied.
///
/// #338 already retired drained vaults in the grace period, but only
/// those: an `ok` vault whose coins were swept stayed `ok` forever. It
/// kept asking its owner to check in on nothing, and if they ever
/// stopped it would run the whole alarm cascade and hand their heir a
/// claim link to an empty vault. That is the state the offline recovery
/// kit leaves behind, since the server never sees that transaction.
///
/// Empty means a successful scan found no UTXOs at all, pending
/// included, so a send with unconfirmed change doesn't read as a drain.
/// A scan that can't reach the chain is "unknown" and changes nothing.
/// The scan is cached for `MATURITY_CACHE_TTL_SECS`, so this costs at
/// most one Esplora hit per vault per cache window, exactly like the
/// activation sweep it mirrors.
///
/// Only `ok` vaults. `alarmed` belongs to the grace-period path, and
/// `frozen` (panic) and the claim statuses must never be reset here.
async fn retire_drained_vaults(state: &AppState) -> anyhow::Result<()> {
    let rows = sqlx::query_as::<
        _,
        (
            String,         // id
            String,         // descriptor_external
            String,         // descriptor_internal
            String,         // network
            i64,            // timelock_blocks
            Option<i64>,    // chain_unlock_height
            Option<i64>,    // chain_tip_height
            Option<String>, // chain_scanned_at
            Option<i64>,    // chain_has_unspent
        ),
    >(
        // The EXISTS clause is what separates "the coins left" from "coins
        // never arrived". Both look identical to a chain scan — no unspent
        // outputs — but only the first is a drain worth acting on.
        //
        // `vault_deposits` rows are never deleted (a spend stamps
        // `spent_at`), so one row is permanent proof this vault once held
        // money. Without this, demo mode's habit of creating vaults as
        // `ok` before funding meant every new vault was announced as
        // "emptied off-server" seconds after it was created (signet,
        // 2026-08-10).
        r#"SELECT id,
                  descriptor_external, descriptor_internal, network, timelock_blocks,
                  chain_unlock_height, chain_tip_height, chain_scanned_at,
                  chain_has_unspent
             FROM vaults
            WHERE status = 'ok'
              AND EXISTS (SELECT 1 FROM vault_deposits d WHERE d.vault_id = vaults.id)"#,
    )
    .fetch_all(&state.db)
    .await?;

    let now = Utc::now();
    for (
        id,
        descriptor_external,
        descriptor_internal,
        network,
        timelock_blocks,
        chain_unlock_height,
        chain_tip_height,
        chain_scanned_at,
        chain_has_unspent,
    ) in rows
    {
        let input = crate::psbt_routes::EstimateInput {
            vault_id: id.clone(),
            descriptor_external,
            descriptor_internal,
            network,
            timelock_blocks,
            cached_unlock_height: chain_unlock_height,
            cached_tip_height: chain_tip_height,
            cached_scanned_at: chain_scanned_at,
            cached_has_unspent: chain_has_unspent,
        };

        match crate::psbt_routes::unlock_estimate_with_cache(&state.db, &input, now).await {
            Ok(est) if est.has_unspent => {
                record_chain_scan(true, None, now);
                continue;
            }
            Ok(_) => record_chain_scan(true, None, now),
            Err(e) => {
                record_chain_scan(false, Some(e.to_string()), now);
                continue;
            }
        }

        if return_empty_vault_to_unfunded(&state.db, &id, "ok").await? {
            tracing::info!(
                vault_id = %id,
                "vault emptied off-server; check-in clock stopped (ok -> unfunded)"
            );
        }
    }
    Ok(())
}

/// Stop the clock on a vault that is `ok` but was never funded.
///
/// The sweep above deliberately ignores these: with no deposit on record
/// they cannot have been drained, and calling them drained is what
/// announced brand-new vaults as emptied. But they still must not run a
/// check-in clock, or they go overdue and count down to notifying an heir
/// about a vault holding nothing (signet, 2026-08-10).
///
/// So this is the same status change with none of the drain story: no
/// event, no owner mail, just the clock stopped. It exists for vaults
/// created before funding-gated status applied everywhere; once those are
/// drained from the estate it will simply never match a row.
///
/// The chain scan is still what decides. A vault whose deposits were
/// never recorded — nobody loaded its balance — but which does hold coins
/// reads as `has_unspent` and is left alone.
///
/// Covers `alarmed` as well as `ok`. A never-funded vault that had
/// already escalated before this shipped is stuck there: the alarmed
/// reconciliation only rescues it once `claim_eligible_at` passes, so
/// until then the owner reads "your heir will be notified" and collects
/// escalation mail over a vault holding nothing. The heir is never
/// actually contacted — `HeirContactGate::Empty` catches that at
/// eligibility — but the owner should not be living with the warning
/// either.
async fn stand_down_never_funded_vaults(state: &AppState) -> anyhow::Result<()> {
    let rows = sqlx::query_as::<
        _,
        (
            String, // id
            String, // status (CAS'd on, so read rather than assumed)
            String, // descriptor_external
            String, // descriptor_internal
            String, // network
            i64,    // timelock_blocks
            Option<i64>,
            Option<i64>,
            Option<String>,
            Option<i64>,
        ),
    >(
        r#"SELECT id, status,
                  descriptor_external, descriptor_internal, network, timelock_blocks,
                  chain_unlock_height, chain_tip_height, chain_scanned_at,
                  chain_has_unspent
             FROM vaults
            WHERE status IN ('ok', 'alarmed')
              AND NOT EXISTS (SELECT 1 FROM vault_deposits d WHERE d.vault_id = vaults.id)"#,
    )
    .fetch_all(&state.db)
    .await?;

    let now = Utc::now();
    for (
        id,
        status,
        descriptor_external,
        descriptor_internal,
        network,
        timelock_blocks,
        chain_unlock_height,
        chain_tip_height,
        chain_scanned_at,
        chain_has_unspent,
    ) in rows
    {
        let input = crate::psbt_routes::EstimateInput {
            vault_id: id.clone(),
            descriptor_external,
            descriptor_internal,
            network,
            timelock_blocks,
            cached_unlock_height: chain_unlock_height,
            cached_tip_height: chain_tip_height,
            cached_scanned_at: chain_scanned_at,
            cached_has_unspent: chain_has_unspent,
        };

        match crate::psbt_routes::unlock_estimate_with_cache(&state.db, &input, now).await {
            // Holds coins after all: genuinely funded, leave the clock be.
            Ok(est) if est.has_unspent => {
                record_chain_scan(true, None, now);
                continue;
            }
            Ok(_) => record_chain_scan(true, None, now),
            Err(e) => {
                record_chain_scan(false, Some(e.to_string()), now);
                continue;
            }
        }

        // CAS on the status we read, so a vault that escalated between the
        // query and here is left for the next tick rather than silently
        // reset from under a transition that is mid-flight.
        if return_never_funded_vault_to_unfunded(&state.db, &id, &status).await? {
            tracing::info!(
                vault_id = %id,
                from = %status,
                "vault was never funded; check-in clock stopped (-> unfunded)"
            );
        }
    }
    Ok(())
}

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
        //   - owner alarm delivers over the owner's own channel (email,
        //     SMS or WhatsApp) and/or web push; anything else is
        //     skipped with a warning → Ok(None)
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
    let owner_contact = parse_owner_contact(
        vault_id,
        owner.ciphertext_b64,
        owner.nonce_b64,
        owner.channel,
    )?
    .filter(|c| owner_channel_is_deliverable(c.channel));

    let has_push =
        sqlx::query_as::<_, (i64,)>("SELECT COUNT(*) FROM push_subscriptions WHERE vault_id = ?")
            .bind(vault_id)
            .fetch_one(&state.db)
            .await?
            .0
            > 0;

    if owner_contact.is_none() && !has_push {
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

    if let Some(contact) = &owner_contact {
        let amount_sat = crate::lightning::heartbeat_amount_sat();
        let one_tap_block = match &one_tap_url {
            Some(url) => format!(
                "Tap this link and pay {amount_sat} sats from any Lightning \
                 wallet to check in. The payment is your proof you're still \
                 here and resets the clock.\n\n\
                 {url}\n\n"
            ),
            None => String::new(),
        };

        let subject = "You missed your GhostKey check-in".to_string();
        let body = format!(
            "Hello,\n\n\
             {display_label} just missed its check-in deadline. This is the \
             last reminder before the next step.\n\n\
             {one_tap_block}\
             You can also open the dashboard on any device and check in \
             to reset the clock:\n\n\
             {base}/#/checkin\n\n\
             If we don't hear from you by {claim_friendly}, your heir will \
             receive their claim link automatically. You can stop that at \
             any moment up to then by checking in.\n\n\
             If this email reached you by mistake, you can ignore it. \
             Nothing happens until the deadline above.\n\n\
             From GhostKey\n"
        );

        notifier::enqueue(
            &state.db,
            vault_id,
            NotificationKind::AlarmOwner,
            contact.channel,
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

/// On-chain maturity gating for heir contact (Fix A). On by default in
/// production. The scheduler's own unit tests drive the server-clock
/// state machine with fake descriptors and no Esplora, so `fresh_db`
/// flips this off for them; see `disable_onchain_gate_for_test`.
static ONCHAIN_GATE_ENABLED: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(true);

#[cfg(test)]
fn disable_onchain_gate_for_test() {
    ONCHAIN_GATE_ENABLED.store(false, std::sync::atomic::Ordering::Relaxed);
}

/// Health of the on-chain maturity scans that gate heir contact. When
/// Esplora is unreachable these scans fail and heir contact silently
/// pauses (the safe direction), so an operator needs a signal. We track
/// the most recent scheduler scan outcome; `/health` surfaces it.
#[derive(Clone, Default)]
pub struct ChainScanHealth {
    pub last_ok_at: Option<chrono::DateTime<Utc>>,
    pub last_err: Option<String>,
    pub consecutive_failures: u32,
}

/// Consecutive failed scans before `/health` flips `chain_scan_healthy`
/// to false. Scans are cached (~10 min TTL), so this is ~30 min of an
/// unreachable Esplora — past a transient blip, into "go look".
pub const CHAIN_SCAN_UNHEALTHY_THRESHOLD: u32 = 3;

fn chain_scan_health() -> &'static Mutex<ChainScanHealth> {
    static H: OnceLock<Mutex<ChainScanHealth>> = OnceLock::new();
    H.get_or_init(|| Mutex::new(ChainScanHealth::default()))
}

/// Record a scheduler maturity-scan outcome. A success (including a cache
/// hit) clears the failure streak; a failure extends it and keeps the
/// error for `/health`.
fn record_chain_scan(ok: bool, err: Option<String>, now: chrono::DateTime<Utc>) {
    let mut h = chain_scan_health()
        .lock()
        .expect("chain scan health poisoned");
    if ok {
        h.last_ok_at = Some(now);
        h.last_err = None;
        h.consecutive_failures = 0;
    } else {
        h.last_err = err;
        h.consecutive_failures = h.consecutive_failures.saturating_add(1);
    }
}

/// Snapshot the maturity-scan health for `/health`.
pub fn chain_scan_health_snapshot() -> ChainScanHealth {
    chain_scan_health()
        .lock()
        .expect("chain scan health poisoned")
        .clone()
}

/// The on-chain fields a maturity decision needs, pulled alongside the
/// claim-eligibility query so we don't round-trip the DB again.
struct VaultChainRow {
    id: String,
    descriptor_external: String,
    descriptor_internal: String,
    network: String,
    timelock_blocks: i64,
    chain_unlock_height: Option<i64>,
    chain_tip_height: Option<i64>,
    chain_scanned_at: Option<String>,
    chain_has_unspent: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HeirContactGate {
    Ready,
    Waiting,
    Empty,
}

/// Pure decision: are the coins within `lead_blocks` of being spendable?
/// `unlock_height` is `None` when no confirmed UTXO anchors the timelock,
/// which is never ready.
fn issue_ready(unlock_height: Option<u32>, tip_height: u32, lead_blocks: u32) -> bool {
    match unlock_height {
        Some(unlock) => unlock.saturating_sub(tip_height) <= lead_blocks,
        None => false,
    }
}

fn heir_contact_gate(
    est: &crate::psbt_routes::UnlockEstimate,
    lead_blocks: u32,
) -> HeirContactGate {
    if !est.has_unspent {
        HeirContactGate::Empty
    } else if issue_ready(est.unlock_height, est.tip_height, lead_blocks) {
        HeirContactGate::Ready
    } else {
        HeirContactGate::Waiting
    }
}

/// Retire a drained vault without losing its configuration. `unfunded`
/// is intentionally reusable: a later deposit is detected by
/// `activate_funded_vaults`, which starts a fresh check-in clock.
///
/// `from_status` is the status the caller expects to find, and the
/// UPDATE is a compare-and-swap on it, so a racing tick that already
/// moved the vault can't be undone. Two callers: the grace-period path
/// (`alarmed`, which also clears the claim deadline) and the healthy
/// path (`ok`), which is what catches a vault emptied by a wallet the
/// server never saw.
async fn return_empty_vault_to_unfunded(
    db: &sqlx::SqlitePool,
    vault_id: &str,
    from_status: &str,
) -> anyhow::Result<bool> {
    return_empty_vault_to_unfunded_inner(db, vault_id, from_status, true).await
}

/// As above, but silent: the status changes and nothing is written to the
/// activity feed.
///
/// For a vault that was never funded there is no story to tell. Its feed
/// should not gain a "vault is empty" entry describing money that never
/// arrived — the owner would be reading about an event that did not
/// happen.
async fn return_never_funded_vault_to_unfunded(
    db: &sqlx::SqlitePool,
    vault_id: &str,
    from_status: &str,
) -> anyhow::Result<bool> {
    return_empty_vault_to_unfunded_inner(db, vault_id, from_status, false).await
}

async fn return_empty_vault_to_unfunded_inner(
    db: &sqlx::SqlitePool,
    vault_id: &str,
    from_status: &str,
    record: bool,
) -> anyhow::Result<bool> {
    let changed = sqlx::query(
        "UPDATE vaults SET status = 'unfunded', claim_eligible_at = NULL \
         WHERE id = ? AND status = ?",
    )
    .bind(vault_id)
    .bind(from_status)
    .execute(db)
    .await?;
    if changed.rows_affected() == 0 {
        return Ok(false);
    }
    if record {
        record_event(
            db,
            vault_id,
            "vault_empty",
            Some(serde_json::json!({
                "reason": "chain_scan_found_no_unspent_outputs"
            })),
        )
        .await?;
    }
    Ok(true)
}

/// True once the on-chain timelock has fully matured (or the gate is
/// bypassed for tests/demo). Used to hold the heir's "ready to collect"
/// email until the funds can actually move. A chain we can't read is
/// treated as not-ready, so the email waits rather than misleads.
async fn onchain_funds_ready(
    state: &AppState,
    input: &crate::psbt_routes::EstimateInput,
    now: chrono::DateTime<Utc>,
) -> bool {
    if !ONCHAIN_GATE_ENABLED.load(std::sync::atomic::Ordering::Relaxed) || crate::demo::demo_mode()
    {
        return true;
    }
    match crate::psbt_routes::unlock_estimate_with_cache(&state.db, input, now).await {
        // lead_blocks = 0: matured exactly when tip has reached the unlock.
        Ok(est) => {
            record_chain_scan(true, None, now);
            issue_ready(est.unlock_height, est.tip_height, 0)
        }
        Err(e) => {
            record_chain_scan(false, Some(e.to_string()), now);
            false
        }
    }
}

/// Fix A gate: a vault can be server-eligible for a claim long before its
/// on-chain `older(N)` timelock matures. Returns true only once the coins
/// are within the claim-challenge window of being spendable, so the heir
/// is contacted near real maturity and the safety wait runs during the
/// final approach (then the heir can spend the moment it matures).
///
/// Reuses the cached estimate while fresh; otherwise rescans Esplora and
/// refreshes the cache. Any failure to read the chain returns false — we
/// never contact the heir on an unverified chain state.
async fn heir_contact_ready(
    state: &AppState,
    row: &VaultChainRow,
    now: chrono::DateTime<Utc>,
) -> HeirContactGate {
    // Tests and live demos run the server-clock machine without a real
    // chain; let them through unchanged.
    if !ONCHAIN_GATE_ENABLED.load(std::sync::atomic::Ordering::Relaxed) || crate::demo::demo_mode()
    {
        return HeirContactGate::Ready;
    }

    let input = crate::psbt_routes::EstimateInput {
        vault_id: row.id.clone(),
        descriptor_external: row.descriptor_external.clone(),
        descriptor_internal: row.descriptor_internal.clone(),
        network: row.network.clone(),
        timelock_blocks: row.timelock_blocks,
        cached_unlock_height: row.chain_unlock_height,
        cached_tip_height: row.chain_tip_height,
        cached_scanned_at: row.chain_scanned_at.clone(),
        cached_has_unspent: row.chain_has_unspent,
    };
    match crate::psbt_routes::unlock_estimate_with_cache(&state.db, &input, now).await {
        Ok(est) => {
            record_chain_scan(true, None, now);
            let lead_blocks = (crate::config::claim_challenge_window_secs()
                / crate::config::TARGET_BLOCK_SECS)
                .max(0) as u32;
            heir_contact_gate(&est, lead_blocks)
        }
        Err(e) => {
            record_chain_scan(false, Some(e.to_string()), now);
            tracing::warn!(
                vault_id = %row.id, error = %e,
                "on-chain maturity scan failed; not advancing this tick"
            );
            HeirContactGate::Waiting
        }
    }
}

/// Move every vault that has been `alarmed` long enough (past its
/// `claim_eligible_at`) AND whose coins are within reach of on-chain
/// maturity (Fix A) to `timelock_started`, and issue a one-time claim
/// token for the heir.
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
            String,         // descriptor_external
            String,         // descriptor_internal
            String,         // network
            i64,            // timelock_blocks
            Option<i64>,    // chain_unlock_height (cache)
            Option<i64>,    // chain_tip_height (cache)
            Option<String>, // chain_scanned_at (cache)
            Option<i64>,    // chain_has_unspent (cache)
        ),
    >(
        r#"SELECT id, label,
                  heir_contact_ciphertext, heir_contact_nonce,
                  claim_token_at_rest_b64, claim_token_hash,
                  descriptor_external, descriptor_internal,
                  network, timelock_blocks,
                  chain_unlock_height, chain_tip_height, chain_scanned_at,
                  chain_has_unspent
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

    for (
        id,
        label,
        ct,
        nn,
        at_rest,
        existing_hash,
        descriptor_external,
        descriptor_internal,
        network,
        timelock_blocks,
        chain_unlock_height,
        chain_tip_height,
        chain_scanned_at,
        chain_has_unspent,
    ) in due
    {
        // Fix A: server-eligible is not enough. Only contact the heir
        // once the coins are within reach of on-chain maturity. A vault
        // that isn't ready stays `alarmed` and is re-checked next tick.
        let chain_row = VaultChainRow {
            id: id.clone(),
            descriptor_external,
            descriptor_internal,
            network,
            timelock_blocks,
            chain_unlock_height,
            chain_tip_height,
            chain_scanned_at,
            chain_has_unspent,
        };
        match heir_contact_ready(state, &chain_row, Utc::now()).await {
            HeirContactGate::Ready => {}
            HeirContactGate::Waiting => continue,
            HeirContactGate::Empty => {
                if return_empty_vault_to_unfunded(&state.db, &id, "alarmed").await? {
                    tracing::info!(vault_id = %id, "drained vault returned to unfunded state");
                }
                continue;
            }
        }

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

        // Guardian vaults (#81): the heir alone can't claim — at least one
        // of two guardians must co-sign. Send each guardian their own
        // label-shy claim link. A no-op for standard vaults (no rows).
        if let Err(e) = enqueue_guardian_claim_links(state, &id).await {
            tracing::warn!(vault_id = %id, error = ?e, "could not enqueue guardian notifications");
        }
    }

    Ok(())
}

/// Enqueue a claim link for each guardian of a guardian vault (#81).
///
/// Returns `Ok(())` for a standard vault (no `vault_guardian_keys` rows).
/// Each guardian's token was sealed at rest at creation; we decrypt it,
/// resolve the guardian's contact (raw string + channel column, exactly
/// like the owner contact), and enqueue a label-shy message — it names
/// GhostKey so the anti-scam "look it up" advice works, but never
/// "Bitcoin"/"inheritance" before the one-time link (design-review C2).
async fn enqueue_guardian_claim_links(state: &AppState, vault_id: &str) -> anyhow::Result<()> {
    let rows = sqlx::query_as::<
        _,
        (
            i64,            // slot
            Option<String>, // claim_token_at_rest_b64
            Option<String>, // contact_ciphertext
            Option<String>, // contact_nonce
            Option<String>, // contact_channel
        ),
    >(
        r#"SELECT slot, claim_token_at_rest_b64,
                  contact_ciphertext, contact_nonce, contact_channel
             FROM vault_guardian_keys
            WHERE vault_id = ?
            ORDER BY slot"#,
    )
    .bind(vault_id)
    .fetch_all(&state.db)
    .await?;
    if rows.is_empty() {
        return Ok(());
    }

    let intro = load_heir_intro(state, vault_id).await;
    let from_name = intro
        .as_ref()
        .and_then(|i| i.from_name.as_deref())
        .map(str::trim)
        .filter(|s| !s.is_empty());

    let base = public_base_url();
    for (slot, at_rest, ct, nn, channel) in rows {
        let Some(raw) = at_rest.as_ref() else {
            tracing::info!(vault_id = %vault_id, slot, "guardian has no at-rest token; skipping");
            continue;
        };
        let token = crate::crypto::open_claim_token_at_rest(vault_id, raw)?;
        let Some(contact) =
            parse_owner_contact(vault_id, ct.as_deref(), nn.as_deref(), channel.as_deref())?
        else {
            tracing::info!(vault_id = %vault_id, slot, "guardian contact missing/undeliverable; skipping");
            continue;
        };

        let claim_url = format!("{base}/#/claim/{token}");
        if crate::demo::demo_mode() {
            tracing::warn!(vault_id = %vault_id, slot, "DEMO MODE guardian claim link (do not enable in production): {claim_url}");
        }

        let opener = match from_name {
            Some(n) => format!("{n} named you as a guardian through GhostKey"),
            None => "Someone named you as a guardian through GhostKey".to_string(),
        };
        let subject = match from_name {
            Some(n) => format!("{n} asked us to reach you"),
            None => "Someone asked us to reach you".to_string(),
        };
        let body = match contact.channel {
            Channel::Email => format!(
                "Hello,\n\n\
                 {opener}, and asked us to reach you if they ever stopped \
                 checking in. That has happened, and the person they set this \
                 up for needs a guardian's help to receive it.\n\n\
                 Before you open anything: a message like this can look like a \
                 scam, and you are right to be careful. Look up GhostKey on \
                 your own and make sure it is genuine first.\n\n\
                 When you are ready, open this link on any phone or computer \
                 to help:\n\n\
                 {claim_url}\n\n\
                 The link works once. You don't need an account.\n\n\
                 If this reached you by mistake, you can ignore it.\n\n\
                 From GhostKey\n"
            ),
            _ => format!(
                "Hello, {opener} and asked us to reach you to help when the \
                 time came. A message like this can look like a scam, so \
                 please check GhostKey is genuine first. When you're \
                 ready:\n\n{claim_url}\n\nThe link works once."
            ),
        };

        notifier::enqueue(
            &state.db,
            vault_id,
            NotificationKind::ClaimLink,
            contact.channel,
            &contact.address,
            &subject,
            &body,
        )
        .await?;
        tracing::info!(vault_id = %vault_id, slot, "guardian claim-link notification enqueued");
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
    // C2 (#123): SMS and WhatsApp previews show on lock screens, the least
    // private channel there is. Announcing "a Bitcoin inheritance" there is a
    // physical-safety risk for a high-risk heir, so the SMS/WhatsApp opener
    // stays label-shy: it names GhostKey (so the anti-scam "look it up"
    // advice works) but never "Bitcoin" or "inheritance" before the link.
    // The full picture waits behind the one-time link.
    let sms_opener = match from_name {
        Some(n) => format!("{n} set something up for you through GhostKey"),
        None => "someone you knew set something up for you through GhostKey".to_string(),
    };

    // C3 (#123): the old subject ("A message for you about something someone
    // left you") was cryptic enough to read as spam and be discarded. A real
    // name plus "asked us to reach you" is warmer and lands as a genuine
    // personal matter, while still hiding the specifics (no "Bitcoin", no
    // "inheritance") in case the subject surfaces on a lock screen.
    let subject = match from_name {
        Some(n) => format!("{n} asked us to reach you"),
        None => "Someone asked us to reach you".to_string(),
    };
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
             From GhostKey\n"
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
pub(crate) struct HeirIntro {
    pub(crate) from_name: Option<String>,
    note: Option<String>,
}

pub(crate) async fn load_heir_intro(state: &AppState, vault_id: &str) -> Option<HeirIntro> {
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
/// keep this configurable so a deployment serving the dashboard on
/// its own domain can produce links that go there rather than to the
/// API host.
///
/// The fallback is the canonical domain, not the Vercel preview host:
/// if the env var is ever dropped, a heir's one-time claim link still
/// has to land somewhere that works.
pub(crate) fn public_base_url() -> String {
    std::env::var("GHOSTKEY_PUBLIC_BASE_URL")
        .unwrap_or_else(|_| "https://www.ghostkeyapp.com".to_string())
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

    #[test]
    fn chain_scan_health_tracks_failure_streak() {
        let now = Utc::now();
        // Success clears the streak and any error.
        record_chain_scan(true, None, now);
        let h = chain_scan_health_snapshot();
        assert_eq!(h.consecutive_failures, 0);
        assert!(h.last_err.is_none());
        assert!(h.last_ok_at.is_some());
        // Failures accumulate and keep the latest error.
        record_chain_scan(false, Some("esplora down".into()), now);
        record_chain_scan(false, Some("still down".into()), now);
        let h = chain_scan_health_snapshot();
        assert_eq!(h.consecutive_failures, 2);
        assert_eq!(h.last_err.as_deref(), Some("still down"));
        // A success resets again.
        record_chain_scan(true, None, now);
        let h = chain_scan_health_snapshot();
        assert_eq!(h.consecutive_failures, 0);
        assert!(h.last_err.is_none());
    }

    #[test]
    fn issue_ready_gates_on_onchain_maturity() {
        // No confirmed coin to anchor the timelock: never ready.
        assert!(!issue_ready(None, 1000, 288));
        // Unlock far in the future, outside the lead window: not ready.
        assert!(!issue_ready(Some(2000), 1000, 288));
        // Exactly at the lead edge (~48h ≈ 288 blocks out): ready.
        assert!(issue_ready(Some(1288), 1000, 288));
        // Within the lead window: ready.
        assert!(issue_ready(Some(1100), 1000, 288));
        // Tip already past the unlock height (matured): ready.
        assert!(issue_ready(Some(900), 1000, 288));
        // Zero lead (challenge window disabled): only ready at maturity.
        assert!(!issue_ready(Some(1001), 1000, 0));
        assert!(issue_ready(Some(1000), 1000, 0));
    }

    #[test]
    fn heir_contact_gate_distinguishes_empty_from_unconfirmed() {
        let empty = crate::psbt_routes::UnlockEstimate {
            tip_height: 1000,
            unlock_height: None,
            has_unspent: false,
        };
        assert_eq!(heir_contact_gate(&empty, 288), HeirContactGate::Empty);

        let unconfirmed = crate::psbt_routes::UnlockEstimate {
            tip_height: 1000,
            unlock_height: None,
            has_unspent: true,
        };
        assert_eq!(
            heir_contact_gate(&unconfirmed, 288),
            HeirContactGate::Waiting,
            "pending change must not be retired as an empty vault"
        );
    }

    #[test]
    fn ln_gate_pauses_during_outage_and_grants_capped_recovery_grace() {
        let mut gate = LnGate::default();
        let t0 = Utc::now();
        let cap = chrono::Duration::seconds(MAX_RECOVERY_GRACE_SECS);
        let at = |secs: i64| t0 + chrono::Duration::seconds(secs);

        // Healthy from the start: never suppress.
        assert!(!update_ln_gate(&mut gate, true, at(0), cap));

        // Outage: suppress immediately and keep suppressing.
        assert!(update_ln_gate(&mut gate, false, at(10), cap));
        assert!(update_ln_gate(&mut gate, false, at(70), cap));

        // Recovers after a 60s outage (started at t+10): grace ~60s, so
        // heir contact stays paused through the grace window.
        assert!(update_ln_gate(&mut gate, true, at(70), cap));
        assert!(update_ln_gate(&mut gate, true, at(100), cap));

        // Past the grace: resume normal heir-contact transitions.
        assert!(!update_ln_gate(&mut gate, true, at(200), cap));
    }

    #[test]
    fn ln_gate_recovery_grace_is_capped() {
        let mut gate = LnGate::default();
        let t0 = Utc::now();
        let cap = chrono::Duration::seconds(MAX_RECOVERY_GRACE_SECS);
        let at = |secs: i64| t0 + chrono::Duration::seconds(secs);

        // A very long outage (2 days), then recovery.
        assert!(update_ln_gate(&mut gate, false, at(0), cap));
        let recover = at(2 * 24 * 60 * 60);
        assert!(update_ln_gate(&mut gate, true, recover, cap));
        // Still paused 23h after recovery (within the 24h cap)...
        assert!(update_ln_gate(
            &mut gate,
            true,
            recover + chrono::Duration::seconds(23 * 60 * 60),
            cap
        ));
        // ...but resumed 25h after recovery (cap is 24h, not 2 days).
        assert!(!update_ln_gate(
            &mut gate,
            true,
            recover + chrono::Duration::seconds(25 * 60 * 60),
            cap
        ));
    }

    /// Bring up a fresh SQLite in memory with all migrations applied.
    ///
    /// Also disables the Fix-A on-chain maturity gate: these tests drive
    /// the server-clock state machine with fake descriptors and no
    /// Esplora, so the gate (which would fail closed) must be off. Only
    /// the scheduler tests use `fresh_db`, and all of them want it off.
    async fn fresh_db() -> SqlitePool {
        disable_onchain_gate_for_test();
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

    /// Every column a scheduler stage could touch on a vault.
    type VaultLifecycleRow = (
        String,         // status
        String,         // next_deadline_at
        Option<String>, // claim_eligible_at
        Option<String>, // claim_token_hash
        Option<String>, // claim_token_issued_at
        Option<String>, // claim_token_used_at
        Option<String>, // claim_opened_at
        Option<String>, // claim_ready_notified_at
        Option<String>, // pre_deadline_reminder_sent_at
        Option<String>, // last_alarm_reminder_sent_at
        i64,            // alarm_reminder_count
        Option<String>, // panic_frozen_until
    );

    async fn read_lifecycle(pool: &SqlitePool, id: &str) -> VaultLifecycleRow {
        sqlx::query_as::<_, VaultLifecycleRow>(
            r#"SELECT status, next_deadline_at, claim_eligible_at,
                      claim_token_hash, claim_token_issued_at, claim_token_used_at,
                      claim_opened_at, claim_ready_notified_at,
                      pre_deadline_reminder_sent_at, last_alarm_reminder_sent_at,
                      alarm_reminder_count, panic_frozen_until
                 FROM vaults WHERE id = ?"#,
        )
        .bind(id)
        .fetch_one(pool)
        .await
        .expect("read lifecycle")
    }

    /// A claimed vault is done: the coins have moved and no scheduler
    /// stage may touch it again.
    ///
    /// Every stage filters on `status`, so this should hold by
    /// construction — but "by construction" is exactly what was assumed
    /// about the check-in routes before a claimed vault got reset to
    /// `ok` in production and the scheduler started counting down toward
    /// re-alarming it. This pins the behaviour instead of assuming it.
    ///
    /// The row is set up so that EVERY stage would fire if it were not
    /// status-filtered: deadline long past, claim-eligibility long past,
    /// a panic freeze whose expiry has passed, and a claim-challenge
    /// window that has elapsed.
    #[tokio::test]
    async fn scheduler_never_touches_a_claimed_vault() {
        let pool = fresh_db().await;
        let state = AppState {
            db: pool.clone(),
            lightning: std::sync::Arc::new(crate::lightning::NoopProvider),
        };

        let long_past = (Utc::now() - chrono::Duration::days(30)).to_rfc3339();
        insert_vault(
            &pool,
            "vault-claimed",
            "claimed",
            &long_past,
            Some(&long_past),
        )
        .await;
        sqlx::query(
            r#"UPDATE vaults
                  SET claim_token_hash    = 'claimhash',
                      claim_token_used_at = ?,
                      claim_opened_at     = ?,
                      panic_frozen_until  = ?
                WHERE id = 'vault-claimed'"#,
        )
        .bind(&long_past)
        .bind(&long_past)
        .bind(&long_past)
        .execute(&pool)
        .await
        .expect("arm every stage");

        let before = read_lifecycle(&pool, "vault-claimed").await;

        // Several ticks, in case a stage is only reachable on a later
        // pass (escalation counters, dedupe markers).
        for _ in 0..3 {
            tick_once(&state).await.expect("tick");
        }

        let after = read_lifecycle(&pool, "vault-claimed").await;
        assert_eq!(
            before, after,
            "no scheduler stage may modify a claimed vault"
        );

        // And nothing was queued or logged against it.
        let notifications: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM notifications WHERE vault_id = 'vault-claimed'",
        )
        .fetch_one(&pool)
        .await
        .expect("count notifications");
        assert_eq!(notifications, 0, "a claimed vault must not be notified");

        let events: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM events WHERE vault_id = 'vault-claimed'")
                .fetch_one(&pool)
                .await
                .expect("count events");
        assert_eq!(events, 0, "a claimed vault must not generate events");
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
    async fn unfunded_past_deadline_never_alarms() {
        let pool = fresh_db().await;
        let state = AppState {
            db: pool.clone(),
            lightning: std::sync::Arc::new(crate::lightning::NoopProvider),
        };
        // An unfunded vault whose placeholder deadline is long past must
        // NOT start the alarm / heir-contact machinery: the check-in
        // clock only runs once coins are on-chain. We drive the transition
        // directly (a full tick would try a live funding scan on the fake
        // descriptor) to isolate the clock-hold property.
        insert_vault(
            &pool,
            "vault-unfunded",
            "unfunded",
            "2026-04-01T00:00:00Z",
            Some("2030-01-01T00:00:00Z"),
        )
        .await;
        let now = Utc::now().to_rfc3339();
        transition_ok_to_alarmed(&state, &now)
            .await
            .expect("transition");
        send_alarm_escalations(&state, &now)
            .await
            .expect("escalations");
        let (status, _) = read_status_and_token_hash(&pool, "vault-unfunded").await;
        assert_eq!(status, "unfunded", "unfunded vault must never alarm");
    }

    #[tokio::test]
    async fn funded_unfunded_vault_activates_and_starts_clock() {
        let pool = fresh_db().await;
        let state = AppState {
            db: pool.clone(),
            lightning: std::sync::Arc::new(crate::lightning::NoopProvider),
        };
        // Seed an unfunded vault whose maturity cache is fresh and records
        // a tip. That's exactly the state right after a scan finds coins:
        // `unlock_estimate_with_cache` answers Ok straight from cache (no
        // network), which is the "funded" signal `activate_funded_vaults`
        // acts on. The cache is only ever written after a scan that found
        // UTXOs, so Ok-from-cache faithfully stands in for real funding.
        let now = Utc::now();
        // A stale placeholder deadline (far in the past) proves the clock
        // is genuinely (re)started from activation, not left as-is.
        sqlx::query(
            r#"INSERT INTO vaults (
                id, network, descriptor_external, descriptor_internal,
                timelock_blocks, checkin_period_secs, grace_period_secs,
                created_at, next_deadline_at, status, claim_eligible_at,
                chain_unlock_height, chain_tip_height, chain_scanned_at,
                chain_has_unspent
            ) VALUES ('v-fund','regtest','tr(fake/v-fund/0/*)','tr(fake/v-fund/1/*)',
                144, 86400, 3600, '2026-01-01T00:00:00Z',
                '2026-01-01T00:00:00Z', 'unfunded', '2026-01-01T00:00:00Z',
                200, 150, ?, 1)"#,
        )
        .bind(now.to_rfc3339())
        .execute(&pool)
        .await
        .expect("insert");

        activate_funded_vaults(&state, &now.to_rfc3339())
            .await
            .expect("activate");

        let (status, next_deadline): (String, String) =
            sqlx::query_as("SELECT status, next_deadline_at FROM vaults WHERE id = 'v-fund'")
                .fetch_one(&pool)
                .await
                .expect("read");
        assert_eq!(status, "ok", "a funded vault must activate to ok");
        let nd = chrono::DateTime::parse_from_rfc3339(&next_deadline)
            .expect("parse deadline")
            .with_timezone(&Utc);
        assert!(
            nd > now,
            "check-in clock must be (re)started into the future on activation, got {nd}"
        );
    }

    #[tokio::test]
    async fn empty_cached_scan_does_not_reactivate_unfunded_vault() {
        let pool = fresh_db().await;
        let state = AppState {
            db: pool.clone(),
            lightning: std::sync::Arc::new(crate::lightning::NoopProvider),
        };
        let now = Utc::now();
        sqlx::query(
            r#"INSERT INTO vaults (
                id, network, descriptor_external, descriptor_internal,
                timelock_blocks, checkin_period_secs, grace_period_secs,
                created_at, next_deadline_at, status,
                chain_tip_height, chain_scanned_at, chain_has_unspent
            ) VALUES ('v-empty','regtest','tr(fake/v-empty/0/*)','tr(fake/v-empty/1/*)',
                144, 86400, 3600, '2026-01-01T00:00:00Z',
                '2026-01-01T00:00:00Z', 'unfunded', 150, ?, 0)"#,
        )
        .bind(now.to_rfc3339())
        .execute(&pool)
        .await
        .expect("insert");

        activate_funded_vaults(&state, &now.to_rfc3339())
            .await
            .expect("scan empty vault");
        let status: String = sqlx::query_scalar("SELECT status FROM vaults WHERE id = 'v-empty'")
            .fetch_one(&pool)
            .await
            .expect("status");
        assert_eq!(status, "unfunded");
    }

    /// Put a vault's maturity cache into the state a scan that found
    /// coins leaves behind, so `activate_funded_vaults` reads "funded"
    /// straight from cache instead of reaching for a chain.
    async fn mark_funded(pool: &SqlitePool, id: &str, now: chrono::DateTime<Utc>) {
        sqlx::query(
            "UPDATE vaults
                SET chain_unlock_height = 200, chain_tip_height = 150,
                    chain_scanned_at = ?, chain_has_unspent = 1
              WHERE id = ?",
        )
        .bind(now.to_rfc3339())
        .bind(id)
        .execute(pool)
        .await
        .expect("mark funded");
    }

    async fn count_events(pool: &SqlitePool, id: &str, kind: &str) -> i64 {
        sqlx::query_scalar("SELECT COUNT(*) FROM events WHERE vault_id = ? AND kind = ?")
            .bind(id)
            .bind(kind)
            .fetch_one(pool)
            .await
            .expect("count events")
    }

    /// #326. Funding is not enough to start the clock: an owner whose
    /// email nobody ever confirmed is an owner we have no evidence we
    /// can reach, and the clock is the door to the whole cascade —
    /// reminders, alarm, escalations, and the heir's claim link. Mainnet
    /// vault `4a7aaf77` ran all four with every row reading `sent`.
    #[tokio::test]
    async fn funded_vault_with_unverified_owner_email_is_held() {
        let pool = fresh_db().await;
        let state = AppState {
            db: pool.clone(),
            lightning: std::sync::Arc::new(crate::lightning::NoopProvider),
        };
        let now = Utc::now();
        insert_vault_with_sealed_owner(
            &pool,
            "v-held",
            "unfunded",
            "2026-01-01T00:00:00Z",
            "2026-01-01T00:00:00Z",
            "owner@example.com",
        )
        .await;
        mark_funded(&pool, "v-held", now).await;

        activate_funded_vaults(&state, &now.to_rfc3339())
            .await
            .expect("activate");

        let status: String = sqlx::query_scalar("SELECT status FROM vaults WHERE id = 'v-held'")
            .fetch_one(&pool)
            .await
            .expect("status");
        assert_eq!(
            status, "unfunded",
            "a funded vault whose owner email is unconfirmed must not start the clock"
        );
        assert_eq!(
            count_events(&pool, "v-held", "activation_held").await,
            1,
            "the hold must be visible in the vault's history"
        );
        assert_eq!(
            count_events(&pool, "v-held", "funded").await,
            0,
            "a held vault has not been activated, so it must not claim it was"
        );
    }

    /// The other half: confirming the email is what opens the door. The
    /// hold has to be a hold, not a wall.
    #[tokio::test]
    async fn funded_vault_with_verified_owner_email_activates() {
        let pool = fresh_db().await;
        let state = AppState {
            db: pool.clone(),
            lightning: std::sync::Arc::new(crate::lightning::NoopProvider),
        };
        let now = Utc::now();
        insert_vault_with_sealed_owner(
            &pool,
            "v-ok",
            "unfunded",
            "2026-01-01T00:00:00Z",
            "2026-01-01T00:00:00Z",
            "owner@example.com",
        )
        .await;
        mark_funded(&pool, "v-ok", now).await;
        sqlx::query("UPDATE vaults SET owner_contact_verified_at = ? WHERE id = 'v-ok'")
            .bind(now.to_rfc3339())
            .execute(&pool)
            .await
            .expect("verify owner");

        activate_funded_vaults(&state, &now.to_rfc3339())
            .await
            .expect("activate");

        let (status, next_deadline): (String, String) =
            sqlx::query_as("SELECT status, next_deadline_at FROM vaults WHERE id = 'v-ok'")
                .fetch_one(&pool)
                .await
                .expect("read");
        assert_eq!(status, "ok", "a confirmed owner's funded vault activates");
        let nd = chrono::DateTime::parse_from_rfc3339(&next_deadline)
            .expect("parse deadline")
            .with_timezone(&Utc);
        assert!(nd > now, "the clock must start from activation, got {nd}");
        assert_eq!(count_events(&pool, "v-ok", "activation_held").await, 0);
    }

    /// The sweep runs every tick for as long as the owner takes to click
    /// the link. One line in the activity feed, not one per tick.
    #[tokio::test]
    async fn activation_hold_is_recorded_once_not_every_tick() {
        let pool = fresh_db().await;
        let state = AppState {
            db: pool.clone(),
            lightning: std::sync::Arc::new(crate::lightning::NoopProvider),
        };
        let now = Utc::now();
        insert_vault_with_sealed_owner(
            &pool,
            "v-nag",
            "unfunded",
            "2026-01-01T00:00:00Z",
            "2026-01-01T00:00:00Z",
            "owner@example.com",
        )
        .await;
        mark_funded(&pool, "v-nag", now).await;

        for _ in 0..3 {
            activate_funded_vaults(&state, &now.to_rfc3339())
                .await
                .expect("activate");
        }

        assert_eq!(count_events(&pool, "v-nag", "activation_held").await, 1);
    }

    /// A vault with no owner contact at all has no way to become
    /// verified, so holding it would brick it rather than prompt
    /// anyone. It activates on funding as it always did.
    #[tokio::test]
    async fn funded_vault_with_no_owner_contact_still_activates() {
        let pool = fresh_db().await;
        let state = AppState {
            db: pool.clone(),
            lightning: std::sync::Arc::new(crate::lightning::NoopProvider),
        };
        let now = Utc::now();
        insert_vault(
            &pool,
            "v-nocontact",
            "unfunded",
            "2026-01-01T00:00:00Z",
            Some("2026-01-01T00:00:00Z"),
        )
        .await;
        mark_funded(&pool, "v-nocontact", now).await;

        activate_funded_vaults(&state, &now.to_rfc3339())
            .await
            .expect("activate");

        let status: String =
            sqlx::query_scalar("SELECT status FROM vaults WHERE id = 'v-nocontact'")
                .fetch_one(&pool)
                .await
                .expect("status");
        assert_eq!(status, "ok");
    }

    #[tokio::test]
    async fn drained_alarmed_vault_returns_to_unfunded_once() {
        let pool = fresh_db().await;
        insert_vault(
            &pool,
            "v-drained",
            "alarmed",
            "2026-01-01T00:00:00Z",
            Some("2026-01-02T00:00:00Z"),
        )
        .await;

        assert!(
            return_empty_vault_to_unfunded(&pool, "v-drained", "alarmed")
                .await
                .expect("retire")
        );
        assert!(
            !return_empty_vault_to_unfunded(&pool, "v-drained", "alarmed")
                .await
                .expect("idempotent retry")
        );
        let (status, eligible): (String, Option<String>) =
            sqlx::query_as("SELECT status, claim_eligible_at FROM vaults WHERE id = 'v-drained'")
                .fetch_one(&pool)
                .await
                .expect("vault");
        assert_eq!(status, "unfunded");
        assert!(eligible.is_none());
        let events: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM events WHERE vault_id = 'v-drained' AND kind = 'vault_empty'",
        )
        .fetch_one(&pool)
        .await
        .expect("events");
        assert_eq!(events, 1);
    }

    /// The status a caller passes is a compare-and-swap, not a hint: it
    /// must refuse a vault sitting in any other state. This is what
    /// stops the healthy-path sweep from resetting a frozen (panic) or
    /// mid-claim vault if it ever picked one up.
    #[tokio::test]
    async fn retiring_a_vault_refuses_a_status_mismatch() {
        let pool = fresh_db().await;
        insert_vault(
            &pool,
            "v-frozen",
            "frozen",
            "2026-01-01T00:00:00Z",
            Some("2026-01-02T00:00:00Z"),
        )
        .await;

        assert!(
            !return_empty_vault_to_unfunded(&pool, "v-frozen", "ok")
                .await
                .expect("cas"),
            "a frozen vault must not be retired by the ok-path sweep"
        );
        let status: String = sqlx::query_scalar("SELECT status FROM vaults WHERE id = 'v-frozen'")
            .fetch_one(&pool)
            .await
            .expect("status");
        assert_eq!(status, "frozen");
    }

    /// The gap #338 left: a vault emptied while still healthy stayed
    /// `ok` and kept its check-in clock running over nothing. The cache
    /// stands in for a scan that found no UTXOs (`chain_has_unspent`
    /// 0), which is the state the offline recovery kit leaves behind.
    #[tokio::test]
    async fn drained_ok_vault_stops_its_checkin_clock() {
        let pool = fresh_db().await;
        let state = AppState {
            db: pool.clone(),
            lightning: std::sync::Arc::new(crate::lightning::NoopProvider),
        };
        let now = Utc::now();
        sqlx::query(
            r#"INSERT INTO vaults (
                id, network, descriptor_external, descriptor_internal,
                timelock_blocks, checkin_period_secs, grace_period_secs,
                created_at, next_deadline_at, status, claim_eligible_at,
                chain_tip_height, chain_scanned_at, chain_has_unspent
            ) VALUES ('v-swept','regtest','tr(fake/v-swept/0/*)','tr(fake/v-swept/1/*)',
                144, 86400, 3600, '2026-01-01T00:00:00Z',
                '2026-06-01T00:00:00Z', 'ok', '2026-06-02T00:00:00Z',
                150, ?, 0)"#,
        )
        .bind(now.to_rfc3339())
        .execute(&pool)
        .await
        .expect("insert");
        // This vault really was funded once: the sweep only acts on a
        // vault with a deposit on record.
        sqlx::query(
            "INSERT INTO vault_deposits (vault_id, outpoint, amount_sat, height, seen_at)
             VALUES ('v-swept', 'abc:0', 50000, 100, '2026-01-02T00:00:00Z')",
        )
        .execute(&pool)
        .await
        .expect("deposit");

        retire_drained_vaults(&state).await.expect("retire");

        let (status, eligible): (String, Option<String>) =
            sqlx::query_as("SELECT status, claim_eligible_at FROM vaults WHERE id = 'v-swept'")
                .fetch_one(&pool)
                .await
                .expect("vault");
        assert_eq!(status, "unfunded", "a drained ok vault must stop its clock");
        assert!(eligible.is_none());
        let events: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM events WHERE vault_id = 'v-swept' AND kind = 'vault_empty'",
        )
        .fetch_one(&pool)
        .await
        .expect("events");
        assert_eq!(events, 1);

        // Second sweep: the vault is `unfunded` now, so the ok-path CAS
        // finds nothing and no duplicate event lands.
        retire_drained_vaults(&state).await.expect("second sweep");
        let events: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM events WHERE vault_id = 'v-swept' AND kind = 'vault_empty'",
        )
        .fetch_one(&pool)
        .await
        .expect("events");
        assert_eq!(events, 1, "retiring must be once per drain, not per tick");
    }

    /// The other half: a funded vault must survive the same sweep
    /// untouched. Without this the test above would pass on a function
    /// that retires everything.
    #[tokio::test]
    async fn funded_ok_vault_survives_the_drain_sweep() {
        let pool = fresh_db().await;
        let state = AppState {
            db: pool.clone(),
            lightning: std::sync::Arc::new(crate::lightning::NoopProvider),
        };
        let now = Utc::now();
        sqlx::query(
            r#"INSERT INTO vaults (
                id, network, descriptor_external, descriptor_internal,
                timelock_blocks, checkin_period_secs, grace_period_secs,
                created_at, next_deadline_at, status,
                chain_unlock_height, chain_tip_height, chain_scanned_at,
                chain_has_unspent
            ) VALUES ('v-held','regtest','tr(fake/v-held/0/*)','tr(fake/v-held/1/*)',
                144, 86400, 3600, '2026-01-01T00:00:00Z',
                '2026-06-01T00:00:00Z', 'ok', 200, 150, ?, 1)"#,
        )
        .bind(now.to_rfc3339())
        .execute(&pool)
        .await
        .expect("insert");

        retire_drained_vaults(&state).await.expect("retire");

        let status: String = sqlx::query_scalar("SELECT status FROM vaults WHERE id = 'v-held'")
            .fetch_one(&pool)
            .await
            .expect("status");
        assert_eq!(status, "ok", "a funded vault must keep its check-in clock");
    }

    /// A vault that never received a satoshi is empty for the ordinary
    /// reason, and must not be reported as drained.
    ///
    /// Demo mode creates vaults as `ok` before they are funded, so this
    /// sweep announced every brand-new demo vault as "emptied off-server"
    /// within one tick of its creation (signet, 2026-08-10). The chain
    /// scan cannot tell the two cases apart; the deposit ledger can.
    #[tokio::test]
    async fn never_funded_ok_vault_is_not_reported_as_drained() {
        let pool = fresh_db().await;
        let state = AppState {
            db: pool.clone(),
            lightning: std::sync::Arc::new(crate::lightning::NoopProvider),
        };
        let now = Utc::now();
        // Same shape as the drained vault above — status `ok`, scan found
        // nothing — differing only in having no deposit on record.
        sqlx::query(
            r#"INSERT INTO vaults (
                id, network, descriptor_external, descriptor_internal,
                timelock_blocks, checkin_period_secs, grace_period_secs,
                created_at, next_deadline_at, status, claim_eligible_at,
                chain_tip_height, chain_scanned_at, chain_has_unspent
            ) VALUES ('v-fresh','regtest','tr(fake/v-fresh/0/*)','tr(fake/v-fresh/1/*)',
                144, 86400, 3600, '2026-01-01T00:00:00Z',
                '2026-06-01T00:00:00Z', 'ok', '2026-06-02T00:00:00Z',
                150, ?, 0)"#,
        )
        .bind(now.to_rfc3339())
        .execute(&pool)
        .await
        .expect("insert");

        retire_drained_vaults(&state).await.expect("retire");

        let status: String = sqlx::query_scalar("SELECT status FROM vaults WHERE id = 'v-fresh'")
            .fetch_one(&pool)
            .await
            .expect("status");
        assert_eq!(
            status, "ok",
            "a vault that never held coins cannot have been emptied"
        );
        let events: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM events WHERE vault_id = 'v-fresh' AND kind = 'vault_empty'",
        )
        .fetch_one(&pool)
        .await
        .expect("events");
        assert_eq!(events, 0, "and must not claim its money left");
    }

    /// The never-funded vault still has to stop its clock — it just does
    /// so quietly, with no claim that money left.
    #[tokio::test]
    async fn never_funded_ok_vault_stands_down_without_a_drain_story() {
        let pool = fresh_db().await;
        let state = AppState {
            db: pool.clone(),
            lightning: std::sync::Arc::new(crate::lightning::NoopProvider),
        };
        let now = Utc::now();
        sqlx::query(
            r#"INSERT INTO vaults (
                id, network, descriptor_external, descriptor_internal,
                timelock_blocks, checkin_period_secs, grace_period_secs,
                created_at, next_deadline_at, status, claim_eligible_at,
                chain_tip_height, chain_scanned_at, chain_has_unspent
            ) VALUES ('v-idle','regtest','tr(fake/v-idle/0/*)','tr(fake/v-idle/1/*)',
                144, 86400, 3600, '2026-01-01T00:00:00Z',
                '2026-06-01T00:00:00Z', 'ok', '2026-06-02T00:00:00Z',
                150, ?, 0)"#,
        )
        .bind(now.to_rfc3339())
        .execute(&pool)
        .await
        .expect("insert");

        stand_down_never_funded_vaults(&state)
            .await
            .expect("stand down");

        let (status, eligible): (String, Option<String>) =
            sqlx::query_as("SELECT status, claim_eligible_at FROM vaults WHERE id = 'v-idle'")
                .fetch_one(&pool)
                .await
                .expect("vault");
        assert_eq!(status, "unfunded", "an unfunded vault must not run a clock");
        assert!(eligible.is_none());
        // The whole point of splitting this from the drain sweep: no
        // event claiming money left a vault that never had any.
        let events: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM events WHERE vault_id = 'v-idle'")
                .fetch_one(&pool)
                .await
                .expect("events");
        assert_eq!(events, 0, "nothing happened, so nothing may be reported");
    }

    /// A never-funded vault that already escalated is the one the owner
    /// actually sees: "Check-in overdue, your heir will be notified", on a
    /// vault holding nothing. The alarmed reconciliation only rescues it
    /// once claim_eligible_at passes, which can be a whole grace period of
    /// warnings about money that never existed.
    #[tokio::test]
    async fn never_funded_alarmed_vault_also_stands_down() {
        let pool = fresh_db().await;
        let state = AppState {
            db: pool.clone(),
            lightning: std::sync::Arc::new(crate::lightning::NoopProvider),
        };
        let now = Utc::now();
        sqlx::query(
            r#"INSERT INTO vaults (
                id, network, descriptor_external, descriptor_internal,
                timelock_blocks, checkin_period_secs, grace_period_secs,
                created_at, next_deadline_at, status, claim_eligible_at,
                chain_tip_height, chain_scanned_at, chain_has_unspent
            ) VALUES ('v-alarmed-empty','regtest','tr(fake/v-ae/0/*)','tr(fake/v-ae/1/*)',
                144, 86400, 3600, '2026-01-01T00:00:00Z',
                '2026-06-01T00:00:00Z', 'alarmed', '2027-06-02T00:00:00Z',
                150, ?, 0)"#,
        )
        .bind(now.to_rfc3339())
        .execute(&pool)
        .await
        .expect("insert");

        stand_down_never_funded_vaults(&state)
            .await
            .expect("stand down");

        let (status, eligible): (String, Option<String>) = sqlx::query_as(
            "SELECT status, claim_eligible_at FROM vaults WHERE id = 'v-alarmed-empty'",
        )
        .fetch_one(&pool)
        .await
        .expect("vault");
        assert_eq!(
            status, "unfunded",
            "an alarmed vault holding nothing must stand down, not wait out the grace period"
        );
        assert!(
            eligible.is_none(),
            "and must lose its claim eligibility with the alarm"
        );
        let events: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM events WHERE vault_id = 'v-alarmed-empty'")
                .fetch_one(&pool)
                .await
                .expect("events");
        assert_eq!(events, 0, "still nothing to report");
    }

    /// And it must not touch a vault that actually holds coins, even when
    /// no deposit was ever recorded for it.
    #[tokio::test]
    async fn stand_down_leaves_a_funded_vault_alone() {
        let pool = fresh_db().await;
        let state = AppState {
            db: pool.clone(),
            lightning: std::sync::Arc::new(crate::lightning::NoopProvider),
        };
        let now = Utc::now();
        sqlx::query(
            r#"INSERT INTO vaults (
                id, network, descriptor_external, descriptor_internal,
                timelock_blocks, checkin_period_secs, grace_period_secs,
                created_at, next_deadline_at, status,
                chain_unlock_height, chain_tip_height, chain_scanned_at,
                chain_has_unspent
            ) VALUES ('v-quiet','regtest','tr(fake/v-quiet/0/*)','tr(fake/v-quiet/1/*)',
                144, 86400, 3600, '2026-01-01T00:00:00Z',
                '2026-06-01T00:00:00Z', 'ok', 200, 150, ?, 1)"#,
        )
        .bind(now.to_rfc3339())
        .execute(&pool)
        .await
        .expect("insert");

        stand_down_never_funded_vaults(&state)
            .await
            .expect("stand down");

        let status: String = sqlx::query_scalar("SELECT status FROM vaults WHERE id = 'v-quiet'")
            .fetch_one(&pool)
            .await
            .expect("status");
        assert_eq!(
            status, "ok",
            "coins on chain outrank a missing deposit record"
        );
    }

    /// A spent deposit still counts as proof the vault once held coins —
    /// that is the whole drain case. Guards against narrowing the EXISTS
    /// to unspent rows, which would make the sweep never fire.
    #[tokio::test]
    async fn a_fully_spent_deposit_still_retires_the_vault() {
        let pool = fresh_db().await;
        let state = AppState {
            db: pool.clone(),
            lightning: std::sync::Arc::new(crate::lightning::NoopProvider),
        };
        let now = Utc::now();
        sqlx::query(
            r#"INSERT INTO vaults (
                id, network, descriptor_external, descriptor_internal,
                timelock_blocks, checkin_period_secs, grace_period_secs,
                created_at, next_deadline_at, status, claim_eligible_at,
                chain_tip_height, chain_scanned_at, chain_has_unspent
            ) VALUES ('v-spent','regtest','tr(fake/v-spent/0/*)','tr(fake/v-spent/1/*)',
                144, 86400, 3600, '2026-01-01T00:00:00Z',
                '2026-06-01T00:00:00Z', 'ok', '2026-06-02T00:00:00Z',
                150, ?, 0)"#,
        )
        .bind(now.to_rfc3339())
        .execute(&pool)
        .await
        .expect("insert");
        sqlx::query(
            "INSERT INTO vault_deposits (vault_id, outpoint, amount_sat, height, seen_at, spent_at)
             VALUES ('v-spent', 'def:0', 50000, 100, '2026-01-02T00:00:00Z', '2026-02-01T00:00:00Z')",
        )
        .execute(&pool)
        .await
        .expect("deposit");

        retire_drained_vaults(&state).await.expect("retire");

        let status: String = sqlx::query_scalar("SELECT status FROM vaults WHERE id = 'v-spent'")
            .fetch_one(&pool)
            .await
            .expect("status");
        assert_eq!(status, "unfunded");
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
        // Simulate the post-startup representation: the lookup hash is
        // unchanged, while the raw token is sealed under the master key.
        let stored_raw = "raw-token-shipped-by-browser-at-setup";
        let stored_hash = crate::crypto::hash_claim_token(stored_raw);
        let stored_at_rest =
            crate::crypto::seal_claim_token_at_rest("vault-pw", stored_raw).unwrap();
        sqlx::query(
            r#"UPDATE vaults
                  SET claim_token_hash       = ?,
                      claim_token_at_rest_b64 = ?
                WHERE id = ?"#,
        )
        .bind(&stored_hash)
        .bind(stored_at_rest)
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

    #[tokio::test]
    async fn guardian_vault_trigger_enqueues_heir_plus_two_guardian_links() {
        ensure_test_master_key();
        let pool = fresh_db().await;
        let state = AppState {
            db: pool.clone(),
            lightning: std::sync::Arc::new(crate::lightning::NoopProvider),
        };
        let vid = "vault-guardian";

        // Heir uses the existing inline sealed columns, exactly like a
        // standard vault — its claim link is unchanged by #81.
        let heir_token = "heir-token-AAAAAAAAAAAAAAAAAAAA";
        let heir_at_rest =
            crate::crypto::seal_claim_token_at_rest(vid, heir_token).expect("seal heir token");
        let heir_hash = crate::crypto::hash_claim_token(heir_token);
        let heir_json = serde_json::json!({
            "name": "Ada",
            "contact": "ada@example.com",
            "channel": "email"
        })
        .to_string();
        let heir_sealed =
            crate::crypto::seal_for_vault(vid, heir_json.as_bytes()).expect("seal heir contact");

        sqlx::query(
            r#"INSERT INTO vaults (
                id, network, descriptor_external, descriptor_internal,
                timelock_blocks, checkin_period_secs, grace_period_secs,
                created_at, next_deadline_at, status, claim_eligible_at,
                heir_contact_ciphertext, heir_contact_nonce, heir_contact_channel,
                claim_token_at_rest_b64, claim_token_hash, vault_kind
            ) VALUES (?, 'regtest', 'tr(fake/0/*)', 'tr(fake/1/*)',
                      144, 86400, 3600,
                      '2026-01-01T00:00:00Z', '2026-04-01T00:00:00Z', 'alarmed',
                      '2026-04-08T00:00:00Z', ?, ?, 'email', ?, ?, 'guardian')"#,
        )
        .bind(vid)
        .bind(&heir_sealed.ciphertext_b64)
        .bind(&heir_sealed.nonce_b64)
        .bind(&heir_at_rest)
        .bind(&heir_hash)
        .execute(&pool)
        .await
        .expect("insert guardian vault");

        // Two guardians: each with its own sealed-at-rest token and a
        // contact sealed as a raw string (owner-contact shape, not JSON).
        let guardians = [
            (1_i64, "g1-token-BBBBBBBBBBBBBBBBBBBB", "g1@example.com"),
            (2_i64, "g2-token-CCCCCCCCCCCCCCCCCCCC", "g2@example.com"),
        ];
        for (slot, token, contact) in guardians {
            let at_rest =
                crate::crypto::seal_claim_token_at_rest(vid, token).expect("seal guardian token");
            let sealed_contact =
                crate::crypto::seal_for_vault(vid, contact.as_bytes()).expect("seal guardian");
            sqlx::query(
                r#"INSERT INTO vault_guardian_keys (
                    vault_id, slot, xprv_sealed_ct_b64, xprv_sealed_nonce,
                    claim_token_at_rest_b64, claim_token_hash, claim_token_issued_at,
                    contact_ciphertext, contact_nonce, contact_channel,
                    xpub_fragment_external, xpub_fragment_internal, created_at
                ) VALUES (?, ?, 'ct', 'nn', ?, ?, '2026-04-08T00:00:00Z',
                          ?, ?, 'email', 'xpubext', 'xpubint', '2026-01-01T00:00:00Z')"#,
            )
            .bind(vid)
            .bind(slot)
            .bind(&at_rest)
            .bind(crate::crypto::hash_claim_token(token))
            .bind(&sealed_contact.ciphertext_b64)
            .bind(&sealed_contact.nonce_b64)
            .execute(&pool)
            .await
            .expect("insert guardian row");
        }

        tick_once(&state).await.expect("tick");

        // Three claim-link notifications: heir + two guardians.
        let count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM notifications WHERE vault_id = ? AND kind = 'claim_link'",
        )
        .bind(vid)
        .fetch_one(&pool)
        .await
        .expect("count notifications");
        assert_eq!(
            count, 3,
            "guardian vault must enqueue heir + 2 guardian links, got {count}"
        );

        // Each guardian token must reach its own decrypted link; no token
        // leaks the sealed blob, and the guardian copy stays label-shy.
        let bodies: Vec<String> = {
            let raw: Vec<(String, String)> = sqlx::query_as(
                "SELECT body_ciphertext, body_nonce FROM notifications \
                   WHERE vault_id = ? AND kind = 'claim_link'",
            )
            .bind(vid)
            .fetch_all(&pool)
            .await
            .expect("query bodies");
            raw.into_iter()
                .map(|(ct, nonce)| {
                    String::from_utf8(
                        crate::crypto::open_for_vault(
                            vid,
                            &crate::crypto::SealedContact {
                                ciphertext_b64: ct,
                                nonce_b64: nonce,
                            },
                        )
                        .expect("open body"),
                    )
                    .expect("utf8")
                })
                .collect()
        };
        let all = bodies.join("\n----\n");
        for tok in [
            heir_token,
            "g1-token-BBBBBBBBBBBBBBBBBBBB",
            "g2-token-CCCCCCCCCCCCCCCCCCCC",
        ] {
            assert!(all.contains(tok), "token {tok} missing from links");
        }
        assert!(
            !all.contains("gk1."),
            "a sealed at-rest blob leaked into a link"
        );
        // Guardian copy must not name Bitcoin/inheritance before the link
        // (design-review C2). The heir body is allowed to differ; check
        // the two guardian bodies, which name GhostKey but not the asset.
        let guardian_bodies: Vec<&String> =
            bodies.iter().filter(|b| b.contains("guardian")).collect();
        assert_eq!(guardian_bodies.len(), 2, "expected two guardian bodies");
        for b in guardian_bodies {
            let lower = b.to_lowercase();
            assert!(!lower.contains("bitcoin"), "guardian copy leaks 'bitcoin'");
            assert!(
                !lower.contains("inheritance"),
                "guardian copy leaks 'inheritance'"
            );
            assert!(b.contains("GhostKey"), "guardian copy should name GhostKey");
        }
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
        insert_vault_with_sealed_owner_on_channel(
            pool,
            id,
            status,
            next_deadline_at,
            claim_eligible_at,
            owner_email_pt,
            "email",
        )
        .await
    }

    /// Same, but for an owner who chose something other than email.
    #[allow(clippy::too_many_arguments)]
    async fn insert_vault_with_sealed_owner_on_channel(
        pool: &SqlitePool,
        id: &str,
        status: &str,
        next_deadline_at: &str,
        claim_eligible_at: &str,
        owner_contact_pt: &str,
        owner_channel: &str,
    ) {
        let sealed = crate::crypto::seal_for_vault(id, owner_contact_pt.as_bytes())
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
                      ?, ?, ?)"#,
        )
        .bind(id)
        .bind(format!("tr(fake/{id}/0/*)"))
        .bind(format!("tr(fake/{id}/1/*)"))
        .bind(next_deadline_at)
        .bind(status)
        .bind(claim_eligible_at)
        .bind(&sealed.ciphertext_b64)
        .bind(&sealed.nonce_b64)
        .bind(owner_channel)
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

    /* ---------------------------------------------------------------- *
     *  #312: the owner's own channel                                   *
     *                                                                  *
     *  The whole product rests on the owner being told they missed a   *
     *  check-in before the heir is contacted. An owner who picked      *
     *  WhatsApp or SMS at setup used to get total silence, and then    *
     *  their heir got a claim link.                                    *
     * ---------------------------------------------------------------- */

    #[test]
    fn owner_channels_the_notifier_can_carry() {
        assert!(owner_channel_is_deliverable(Channel::Email));
        assert!(owner_channel_is_deliverable(Channel::Sms));
        assert!(owner_channel_is_deliverable(Channel::Whatsapp));
        // Web push is a per-browser subscription fan-out with its own
        // enqueue path, not a sealed contact address.
        assert!(!owner_channel_is_deliverable(Channel::WebPush));
    }

    /// The missed-check-in alarm must reach an owner on WhatsApp.
    #[tokio::test]
    async fn alarm_owner_reaches_an_owner_on_whatsapp() {
        ensure_test_master_key();
        let pool = fresh_db().await;
        let state = AppState {
            db: pool.clone(),
            lightning: std::sync::Arc::new(crate::lightning::NoopProvider),
        };
        insert_vault_with_sealed_owner_on_channel(
            &pool,
            "vault-ow-wa",
            "ok",
            "2026-04-01T00:00:00Z", // deadline in the past
            "2030-01-01T00:00:00Z",
            "+15005550123",
            "whatsapp",
        )
        .await;

        tick_once(&state).await.expect("tick");

        let (channel, ct, nn): (String, String, String) = sqlx::query_as(
            "SELECT channel, recipient_ciphertext, recipient_nonce \
               FROM notifications \
              WHERE vault_id = 'vault-ow-wa' AND kind = 'alarm_owner'",
        )
        .fetch_one(&pool)
        .await
        .expect("an owner on whatsapp must still be alarmed");
        assert_eq!(channel, "whatsapp", "must use the owner's own channel");

        let recipient = String::from_utf8(
            crate::crypto::open_for_vault(
                "vault-ow-wa",
                &crate::crypto::SealedContact {
                    ciphertext_b64: ct,
                    nonce_b64: nn,
                },
            )
            .expect("open recipient"),
        )
        .expect("utf8");
        assert_eq!(recipient, "+15005550123");
    }

    /// And so must the daily escalations that follow it — these are the
    /// last warnings before the heir is contacted.
    #[tokio::test]
    async fn alarm_escalation_reaches_an_owner_on_sms() {
        ensure_test_master_key();
        let pool = fresh_db().await;
        let state = AppState {
            db: pool.clone(),
            lightning: std::sync::Arc::new(crate::lightning::NoopProvider),
        };
        // Already alarmed, still inside the grace window, never
        // escalated: exactly what the escalation query selects.
        insert_vault_with_sealed_owner_on_channel(
            &pool,
            "vault-esc-sms",
            "alarmed",
            "2026-04-01T00:00:00Z",
            "2030-01-01T00:00:00Z",
            "+15005550124",
            "sms",
        )
        .await;

        tick_once(&state).await.expect("tick");

        let channel: String = sqlx::query_scalar(
            "SELECT channel FROM notifications \
              WHERE vault_id = 'vault-esc-sms' AND kind = 'alarm_escalation'",
        )
        .fetch_one(&pool)
        .await
        .expect("escalation must be enqueued for an SMS owner");
        assert_eq!(channel, "sms");
    }

    /// The pre-deadline reminder is the friendly one, 24h out. Same rule.
    #[tokio::test]
    async fn pre_deadline_reminder_reaches_an_owner_on_sms() {
        ensure_test_master_key();
        let pool = fresh_db().await;
        let state = AppState {
            db: pool.clone(),
            lightning: std::sync::Arc::new(crate::lightning::NoopProvider),
        };
        // Deadline inside the reminder window but not yet passed.
        let soon = (Utc::now() + chrono::Duration::hours(12)).to_rfc3339();
        insert_vault_with_sealed_owner_on_channel(
            &pool,
            "vault-pre-sms",
            "ok",
            &soon,
            "2030-01-01T00:00:00Z",
            "+15005550125",
            "sms",
        )
        .await;

        tick_once(&state).await.expect("tick");

        let channel: String = sqlx::query_scalar(
            "SELECT channel FROM notifications \
              WHERE vault_id = 'vault-pre-sms' AND kind = 'pre_deadline_reminder'",
        )
        .fetch_one(&pool)
        .await
        .expect("reminder must be enqueued for an SMS owner");
        assert_eq!(channel, "sms");
    }
}
