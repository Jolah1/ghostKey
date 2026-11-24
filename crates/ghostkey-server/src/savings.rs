//! Savings view and goal (#367).
//!
//! Savings are a view, not a place: one vault, one set of coins. This
//! module reads what has already happened (every confirmed deposit is in
//! `vault_deposits`, receive addresses only, never change from the owner's
//! own sends) and stores one optional goal per vault.
//!
//! Two numbers, on purpose:
//! - `total_saved_sat` is everything ever put aside. It only goes up,
//!   because irregular income is normal and a figure that can drop reads
//!   as being scolded (#367: no streaks, nothing to fail).
//! - Goal progress is measured against the vault's balance, shown by the
//!   web client, because a goal is about what is there when you need it.
//!
//! The goal title is personal ("School fees for Ada"), so it is sealed
//! with the vault key like the contacts. Amount and date are plain: the
//! server already knows the balance.

use std::sync::Arc;

use axum::{extract::State, http::StatusCode, Json};
use chrono::{DateTime, Datelike, Months, NaiveDate, Utc};
use serde::{Deserialize, Serialize};

use crate::auth::OwnerAuth;
use crate::crypto::{open_for_vault, seal_for_vault, SealedContact};
use crate::routes::ApiError;
use crate::AppState;

/// All the bitcoin there will ever be. A goal above it is a typo.
const MAX_SATS: i64 = 21_000_000 * 100_000_000;
/// Longest goal title, in characters.
const MAX_TITLE_CHARS: usize = 60;
/// How many recent deposits the view lists.
const DEPOSITS_LISTED: i64 = 50;

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct DepositView {
    pub amount_sat: i64,
    pub height: i64,
    /// When our scanner first saw it confirmed (not the block time).
    pub seen_at: String,
    /// Whether these coins have since left the vault.
    pub spent: bool,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct GoalView {
    pub title: String,
    pub amount_sat: Option<i64>,
    /// `YYYY-MM-DD`.
    pub target_date: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct SavingsView {
    pub total_saved_sat: i64,
    pub deposit_count: i64,
    /// Most recent first, at most 50.
    pub deposits: Vec<DepositView>,
    pub goal: Option<GoalView>,
    /// "Your year in savings": this calendar year (UTC) so far.
    pub this_year: YearView,
    pub reminder: Option<ReminderView>,
    /// Reminders only go to a confirmed email, so the card says so when
    /// it isn't.
    pub owner_email_confirmed: bool,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct YearView {
    pub year: i32,
    pub total_sat: i64,
    pub deposit_count: i64,
    /// 1 to 12, the month with the most put aside. None with no deposits.
    pub best_month: Option<u32>,
    pub best_month_sat: i64,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct ReminderView {
    /// "weekly" or "monthly".
    pub cadence: String,
    pub amount_sat: Option<i64>,
    /// RFC 3339.
    pub next_at: String,
}

async fn read_savings(db: &sqlx::SqlitePool, id: &str) -> Result<SavingsView, ApiError> {
    type GoalRow = (Option<String>, Option<String>, Option<i64>, Option<String>);
    let goal_row: Option<GoalRow> = sqlx::query_as(
        "SELECT savings_goal_title_ct, savings_goal_title_nonce, savings_goal_sat, \
                savings_goal_date \
           FROM vaults WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    let (ct, nn, goal_sat, goal_date) = goal_row.ok_or(ApiError::NotFound)?;
    let goal = match (ct, nn) {
        (Some(ct), Some(nn)) => {
            let title = String::from_utf8(open_for_vault(
                id,
                &SealedContact {
                    ciphertext_b64: ct,
                    nonce_b64: nn,
                },
            )?)
            .map_err(|_| ApiError::Validation("stored goal is not valid UTF-8".into()))?;
            Some(GoalView {
                title,
                amount_sat: goal_sat,
                target_date: goal_date,
            })
        }
        _ => None,
    };

    let (total, count): (i64, i64) = sqlx::query_as(
        "SELECT COALESCE(SUM(amount_sat), 0), COUNT(*) FROM vault_deposits WHERE vault_id = ?",
    )
    .bind(id)
    .fetch_one(db)
    .await?;

    let rows: Vec<(i64, i64, String, Option<String>)> = sqlx::query_as(
        "SELECT amount_sat, height, seen_at, spent_at FROM vault_deposits \
          WHERE vault_id = ? ORDER BY height DESC, seen_at DESC LIMIT ?",
    )
    .bind(id)
    .bind(DEPOSITS_LISTED)
    .fetch_all(db)
    .await?;

    let this_year = read_year(db, id, Utc::now().year()).await?;

    type ReminderRow = (
        Option<String>,
        Option<i64>,
        Option<String>,
        Option<String>,
        Option<String>,
    );
    let (cadence, rem_sat, next_at, owner_channel, owner_verified): ReminderRow = sqlx::query_as(
        "SELECT savings_reminder_cadence, savings_reminder_sat, savings_reminder_next_at, \
                owner_contact_channel, owner_contact_verified_at \
           FROM vaults WHERE id = ?",
    )
    .bind(id)
    .fetch_one(db)
    .await?;
    let reminder = match (cadence, next_at) {
        (Some(cadence), Some(next_at)) => Some(ReminderView {
            cadence,
            amount_sat: rem_sat,
            next_at,
        }),
        _ => None,
    };
    let owner_email_confirmed =
        owner_channel.as_deref() == Some("email") && owner_verified.is_some();

    Ok(SavingsView {
        total_saved_sat: total,
        deposit_count: count,
        deposits: rows
            .into_iter()
            .map(|(amount_sat, height, seen_at, spent_at)| DepositView {
                amount_sat,
                height,
                seen_at,
                spent: spent_at.is_some(),
            })
            .collect(),
        goal,
        this_year,
        reminder,
        owner_email_confirmed,
    })
}

/// Totals for one calendar year, by when our scanner first saw each
/// deposit confirmed (UTC).
async fn read_year(db: &sqlx::SqlitePool, id: &str, year: i32) -> Result<YearView, ApiError> {
    let prefix = format!("{year:04}-");
    let (total, count): (i64, i64) = sqlx::query_as(
        "SELECT COALESCE(SUM(amount_sat), 0), COUNT(*) FROM vault_deposits \
          WHERE vault_id = ? AND substr(seen_at, 1, 5) = ?",
    )
    .bind(id)
    .bind(&prefix)
    .fetch_one(db)
    .await?;
    let best: Option<(String, i64)> = sqlx::query_as(
        "SELECT substr(seen_at, 6, 2) AS m, SUM(amount_sat) AS s FROM vault_deposits \
          WHERE vault_id = ? AND substr(seen_at, 1, 5) = ? \
          GROUP BY m ORDER BY s DESC, m ASC LIMIT 1",
    )
    .bind(id)
    .bind(&prefix)
    .fetch_optional(db)
    .await?;
    let (best_month, best_month_sat) = match best {
        Some((m, s)) => (m.parse::<u32>().ok().filter(|m| (1..=12).contains(m)), s),
        None => (None, 0),
    };
    Ok(YearView {
        year,
        total_sat: total,
        deposit_count: count,
        best_month,
        best_month_sat,
    })
}

/// `GET /vaults/:id/savings` (owner).
pub async fn get_savings(
    auth: OwnerAuth,
    State(state): State<Arc<AppState>>,
) -> Result<Json<SavingsView>, ApiError> {
    Ok(Json(read_savings(&state.db, &auth.vault_id).await?))
}

/// Check and normalise a goal. The title is required ("What are you
/// saving for?"); amount and date are optional.
fn validate_goal(req: GoalView, today: NaiveDate) -> Result<GoalView, ApiError> {
    let title = req.title.trim().to_string();
    if title.is_empty() {
        return Err(ApiError::Validation(
            "Say what you're saving for, for example \"School fees\".".into(),
        ));
    }
    if title.chars().count() > MAX_TITLE_CHARS {
        return Err(ApiError::Validation(format!(
            "Keep it under {MAX_TITLE_CHARS} characters."
        )));
    }
    if let Some(a) = req.amount_sat {
        if a <= 0 || a > MAX_SATS {
            return Err(ApiError::Validation(
                "The goal amount must be more than zero.".into(),
            ));
        }
    }
    let target_date = match req.target_date.as_deref().map(str::trim) {
        None | Some("") => None,
        Some(s) => {
            let d = NaiveDate::parse_from_str(s, "%Y-%m-%d")
                .map_err(|_| ApiError::Validation("Use a date like 2027-06-30.".into()))?;
            if d <= today {
                return Err(ApiError::Validation("Pick a date after today.".into()));
            }
            Some(d.format("%Y-%m-%d").to_string())
        }
    };
    Ok(GoalView {
        title,
        amount_sat: req.amount_sat,
        target_date,
    })
}

/// `PUT /vaults/:id/savings/goal` (owner): set or replace the goal.
pub async fn put_goal(
    auth: OwnerAuth,
    State(state): State<Arc<AppState>>,
    Json(req): Json<GoalView>,
) -> Result<Json<SavingsView>, ApiError> {
    let id = auth.vault_id;
    let goal = validate_goal(req, Utc::now().date_naive())?;
    let sealed = seal_for_vault(&id, goal.title.as_bytes())?;
    let updated = sqlx::query(
        "UPDATE vaults SET savings_goal_title_ct = ?, savings_goal_title_nonce = ?, \
                           savings_goal_sat = ?, savings_goal_date = ? \
          WHERE id = ?",
    )
    .bind(&sealed.ciphertext_b64)
    .bind(&sealed.nonce_b64)
    .bind(goal.amount_sat)
    .bind(&goal.target_date)
    .bind(&id)
    .execute(&state.db)
    .await?;
    if updated.rows_affected() == 0 {
        return Err(ApiError::NotFound);
    }
    Ok(Json(read_savings(&state.db, &id).await?))
}

/// `DELETE /vaults/:id/savings/goal` (owner): remove the goal. Saving goes
/// on exactly as before; a goal is only ever a view.
pub async fn delete_goal(
    auth: OwnerAuth,
    State(state): State<Arc<AppState>>,
) -> Result<StatusCode, ApiError> {
    let updated = sqlx::query(
        "UPDATE vaults SET savings_goal_title_ct = NULL, savings_goal_title_nonce = NULL, \
                           savings_goal_sat = NULL, savings_goal_date = NULL \
          WHERE id = ?",
    )
    .bind(&auth.vault_id)
    .execute(&state.db)
    .await?;
    if updated.rows_affected() == 0 {
        return Err(ApiError::NotFound);
    }
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Deserialize)]
pub struct ReminderRequest {
    pub cadence: String,
    pub amount_sat: Option<i64>,
}

/// When the reminder after `from` is due.
pub(crate) fn next_reminder_after(cadence: &str, from: DateTime<Utc>) -> Option<DateTime<Utc>> {
    match cadence {
        "weekly" => Some(from + chrono::Duration::days(7)),
        "monthly" => from.checked_add_months(Months::new(1)),
        _ => None,
    }
}

/// `PUT /vaults/:id/savings/reminder` (owner): remind me to save, weekly
/// or monthly, optionally with an amount. The first one is a full period
/// from now.
pub async fn put_reminder(
    auth: OwnerAuth,
    State(state): State<Arc<AppState>>,
    Json(req): Json<ReminderRequest>,
) -> Result<Json<SavingsView>, ApiError> {
    let id = auth.vault_id;
    let next = next_reminder_after(&req.cadence, Utc::now())
        .ok_or_else(|| ApiError::Validation("Choose weekly or monthly.".into()))?;
    if let Some(a) = req.amount_sat {
        if a <= 0 || a > MAX_SATS {
            return Err(ApiError::Validation(
                "The amount must be more than zero.".into(),
            ));
        }
    }
    let updated = sqlx::query(
        "UPDATE vaults SET savings_reminder_cadence = ?, savings_reminder_sat = ?, \
                           savings_reminder_next_at = ? \
          WHERE id = ?",
    )
    .bind(&req.cadence)
    .bind(req.amount_sat)
    .bind(next.to_rfc3339())
    .bind(&id)
    .execute(&state.db)
    .await?;
    if updated.rows_affected() == 0 {
        return Err(ApiError::NotFound);
    }
    Ok(Json(read_savings(&state.db, &id).await?))
}

/// `DELETE /vaults/:id/savings/reminder` (owner): stop the reminders.
pub async fn delete_reminder(
    auth: OwnerAuth,
    State(state): State<Arc<AppState>>,
) -> Result<StatusCode, ApiError> {
    let updated = sqlx::query(
        "UPDATE vaults SET savings_reminder_cadence = NULL, savings_reminder_sat = NULL, \
                           savings_reminder_next_at = NULL \
          WHERE id = ?",
    )
    .bind(&auth.vault_id)
    .execute(&state.db)
    .await?;
    if updated.rows_affected() == 0 {
        return Err(ApiError::NotFound);
    }
    Ok(StatusCode::NO_CONTENT)
}

/// "1,234,567" for emails, where the web formatter isn't available.
pub(crate) fn group_thousands(n: i64) -> String {
    let digits = n.unsigned_abs().to_string();
    // Leading group of 1 to 3 digits, then groups of exactly 3. Written
    // with chunks rather than `is_multiple_of`, which needs Rust 1.87;
    // the Docker image builds with 1.86.
    let first = match digits.len() % 3 {
        0 => 3.min(digits.len()),
        r => r,
    };
    let mut out = digits[..first].to_string();
    for chunk in digits.as_bytes()[first..].chunks(3) {
        out.push(',');
        out.push_str(std::str::from_utf8(chunk).unwrap_or_default());
    }
    if n < 0 {
        format!("-{out}")
    } else {
        out
    }
}

/// The reminder email. It never contains the deposit address: the link
/// opens the dashboard, where the browser checks the address before
/// showing it (#378). An email with an address in it is exactly what a
/// scammer would copy.
pub(crate) fn reminder_email(
    goal_title: Option<&str>,
    amount_sat: Option<i64>,
    base: &str,
) -> (String, String) {
    let subject = match goal_title {
        Some(t) => format!("Time to put something aside for {t}"),
        None => "Time to put something aside".to_string(),
    };
    let goal_line = match goal_title {
        Some(t) => format!(" for {t}"),
        None => String::new(),
    };
    let amount_line = match amount_sat {
        Some(a) => format!(" You planned about {} sats.", group_thousands(a)),
        None => String::new(),
    };
    let body = format!(
        "Hi,\n\n\
         This is the savings reminder you asked for{goal_line}.{amount_line}\n\n\
         Open your dashboard and tap Add to see your vault's address. \
         Your browser checks the address is yours before showing it:\n\n\
         {base}/#/dashboard\n\n\
         No pressure: if this isn't a good time, skip it. Nothing happens \
         if you do, and it has nothing to do with your check-ins.\n\n\
         To change or stop these reminders, open Savings on your dashboard.\n\n\
         From GhostKey\n"
    );
    (subject, body)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn goal(title: &str, amount: Option<i64>, date: Option<&str>) -> GoalView {
        GoalView {
            title: title.into(),
            amount_sat: amount,
            target_date: date.map(str::to_string),
        }
    }

    fn today() -> NaiveDate {
        NaiveDate::from_ymd_opt(2026, 11, 24).unwrap()
    }

    #[test]
    fn thousands_are_grouped() {
        for (n, want) in [
            (0, "0"),
            (999, "999"),
            (1_000, "1,000"),
            (50_000, "50,000"),
            (1_234_567, "1,234,567"),
            (-1_234, "-1,234"),
        ] {
            assert_eq!(group_thousands(n), want);
        }
    }

    #[test]
    fn reminder_dates() {
        let t = chrono::DateTime::parse_from_rfc3339("2027-01-31T09:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        assert_eq!(
            next_reminder_after("weekly", t).unwrap().to_rfc3339(),
            "2027-02-07T09:00:00+00:00"
        );
        // A month after 31 January is the end of February, not March.
        assert_eq!(
            next_reminder_after("monthly", t).unwrap().to_rfc3339(),
            "2027-02-28T09:00:00+00:00"
        );
        assert!(next_reminder_after("daily", t).is_none());
    }

    #[test]
    fn the_reminder_email_links_to_the_dashboard_and_never_carries_an_address() {
        let (subject, body) = reminder_email(
            Some("School fees"),
            Some(50_000),
            "https://www.ghostkeyapp.com",
        );
        assert_eq!(subject, "Time to put something aside for School fees");
        assert!(body.contains("about 50,000 sats"));
        assert!(body.contains("https://www.ghostkeyapp.com/#/dashboard"));
        assert!(body.contains("No pressure"));
        assert!(!body.contains("bc1") && !body.contains("tb1") && !body.contains("bitcoin:"));
        let (subject, body) = reminder_email(None, None, "https://x");
        assert_eq!(subject, "Time to put something aside");
        assert!(!body.contains("planned"));
    }

    #[test]
    fn a_title_alone_is_a_goal() {
        let g = validate_goal(goal("  Rainy day  ", None, None), today()).unwrap();
        assert_eq!(g, goal("Rainy day", None, None));
    }

    #[test]
    fn amount_and_date_are_checked() {
        assert!(validate_goal(goal("House", Some(5_000_000), Some("2027-06-30")), today()).is_ok());
        for bad in [Some(0), Some(-1), Some(MAX_SATS + 1)] {
            assert!(validate_goal(goal("House", bad, None), today()).is_err());
        }
        for bad in ["2026-11-24", "2026-01-01", "30/06/2027", "soon"] {
            assert!(
                validate_goal(goal("House", None, Some(bad)), today()).is_err(),
                "{bad}"
            );
        }
        // Blank date means no date.
        let g = validate_goal(goal("House", None, Some(" ")), today()).unwrap();
        assert_eq!(g.target_date, None);
    }

    #[test]
    fn the_title_is_required_and_short() {
        assert!(validate_goal(goal("   ", None, None), today()).is_err());
        assert!(validate_goal(goal(&"x".repeat(61), None, None), today()).is_err());
        assert!(validate_goal(goal(&"é".repeat(60), None, None), today()).is_ok());
    }
}
