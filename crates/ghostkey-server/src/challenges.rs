//! Savings challenges: opt-in goals with a finish line. No penalty and
//! nobody is told: stopping one, or missing it, just ends it. Finishing
//! one earns a badge and a congratulations email.
//!
//!   hold          "Don't touch it": no coins leave the vault for 3, 6 or
//!                 12 months.
//!   goal_by_date  Reach a goal's amount by its date.
//!   every_month   Add something every month from the month you join to
//!                 December. Earlier months don't count, so it can always
//!                 still be won when you join.
//!   week52        Week k saves k x the week-1 amount, with catch-up: on
//!                 track while everything saved since starting covers the
//!                 weeks so far.
//!
//! Only what was joined, and when, is stored. Progress is worked out on
//! every read from the deposits, spends and goals already on file, so it
//! can't disagree with them. A challenge that finishes or runs out is
//! settled (stamped) the first time anyone looks, by the owner's page or
//! the scheduler, and then shown as it stood at that moment.

use std::collections::HashMap;
use std::sync::Arc;

use axum::{extract::State, Json};
use chrono::{DateTime, Datelike, Months, NaiveDate, Utc};
use serde::{Deserialize, Serialize};

use crate::auth::OwnerAuth;
use crate::routes::ApiError;
use crate::AppState;

/// "Don't touch it" lengths on offer.
const HOLD_MONTHS: [i64; 3] = [3, 6, 12];
const WEEK1_MIN_SAT: i64 = 100;
const WEEK1_MAX_SAT: i64 = 10_000_000;
/// 1 + 2 + ... + 52: the 52-week total in week-1 amounts.
const WEEK52_UNITS: i64 = 52 * 53 / 2;
/// Challenges listed, newest first.
const LISTED: i64 = 50;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Hold,
    GoalByDate,
    EveryMonth,
    Week52,
}

impl Kind {
    fn as_str(self) -> &'static str {
        match self {
            Kind::Hold => "hold",
            Kind::GoalByDate => "goal_by_date",
            Kind::EveryMonth => "every_month",
            Kind::Week52 => "week52",
        }
    }

    fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "hold" => Kind::Hold,
            "goal_by_date" => Kind::GoalByDate,
            "every_month" => Kind::EveryMonth,
            "week52" => Kind::Week52,
            _ => return None,
        })
    }
}

/// One joined challenge as stored.
#[derive(Debug, Clone)]
struct Row {
    id: String,
    kind: Kind,
    started_at: DateTime<Utc>,
    hold_months: Option<i64>,
    goal_id: Option<String>,
    year: Option<i32>,
    week1_sat: Option<i64>,
    ended_at: Option<DateTime<Utc>>,
    end_reason: Option<String>,
    completed_at: Option<DateTime<Utc>>,
}

impl Row {
    fn running(&self) -> bool {
        self.ended_at.is_none() && self.completed_at.is_none()
    }

    /// The moment to show it as of: when it was settled, or now.
    fn as_of(&self, now: DateTime<Utc>) -> DateTime<Utc> {
        self.completed_at.or(self.ended_at).unwrap_or(now)
    }
}

#[derive(Debug, Clone, Copy, Default)]
struct GoalFacts {
    saved_sat: i64,
    amount_sat: Option<i64>,
    target_date: Option<NaiveDate>,
}

/// What the server already knows about a vault, read once per request.
#[derive(Debug, Default)]
struct Facts {
    /// (seen_at, amount_sat, spent_at)
    deposits: Vec<(DateTime<Utc>, i64, Option<DateTime<Utc>>)>,
    /// Sends and claims the server broadcast.
    sends: Vec<DateTime<Utc>>,
    /// When a chain scan last finished for this vault.
    balance_checked_at: Option<DateTime<Utc>>,
    goals: HashMap<String, GoalFacts>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Outcome {
    Going,
    Done,
    Over,
}

/// One challenge as the owner's page shows it. Fields that don't apply
/// to a kind are null.
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct ChallengeView {
    pub id: String,
    pub kind: Kind,
    /// "going", "done", "over" or "stopped".
    pub state: String,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub completed_at: Option<String>,
    /// 0 to 100.
    pub pct: u32,
    /// On pace (goal_by_date, week52).
    pub on_track: Option<bool>,
    /// Money so far and the finish line (goal_by_date, week52).
    pub saved_sat: Option<i64>,
    pub target_sat: Option<i64>,
    // hold
    pub hold_months: Option<i64>,
    pub ends_at: Option<String>,
    // goal_by_date
    pub goal_id: Option<String>,
    pub target_date: Option<String>,
    /// About how much a week from here to reach the goal on time.
    pub per_week_sat: Option<i64>,
    // every_month
    pub year: Option<i32>,
    /// 1 to 12: the first month that counts.
    pub from_month: Option<u32>,
    /// January to December: whether anything was added that month.
    pub months: Option<Vec<bool>>,
    // week52
    pub week1_sat: Option<i64>,
    /// 1 to 52.
    pub week: Option<i64>,
    /// What the weeks so far add up to.
    pub due_so_far_sat: Option<i64>,
    /// This week's amount.
    pub this_week_sat: Option<i64>,
}

#[derive(Debug, Serialize)]
pub struct ChallengesView {
    /// Newest first.
    pub challenges: Vec<ChallengeView>,
}

fn blank(row: &Row) -> ChallengeView {
    ChallengeView {
        id: row.id.clone(),
        kind: row.kind,
        state: String::new(),
        started_at: row.started_at.to_rfc3339(),
        ended_at: row.ended_at.map(|t| t.to_rfc3339()),
        completed_at: row.completed_at.map(|t| t.to_rfc3339()),
        pct: 0,
        on_track: None,
        saved_sat: None,
        target_sat: None,
        hold_months: None,
        ends_at: None,
        goal_id: None,
        target_date: None,
        per_week_sat: None,
        year: None,
        from_month: None,
        months: None,
        week1_sat: None,
        week: None,
        due_so_far_sat: None,
        this_week_sat: None,
    }
}

fn pct(part: i64, whole: i64) -> u32 {
    if whole <= 0 {
        return 0;
    }
    (part.max(0).saturating_mul(100) / whole).clamp(0, 100) as u32
}

/// Midnight UTC at the start of the day after `d`.
fn end_of_day(d: NaiveDate) -> DateTime<Utc> {
    (d + chrono::Duration::days(1))
        .and_hms_opt(0, 0, 0)
        .unwrap()
        .and_utc()
}

/// Work out where a challenge stands as of `row.as_of(now)`.
fn evaluate(row: &Row, f: &Facts, now: DateTime<Utc>) -> (ChallengeView, Outcome) {
    let at = row.as_of(now);
    let start = row.started_at;
    let mut v = blank(row);
    let outcome = match row.kind {
        Kind::Hold => {
            let months = row.hold_months.unwrap_or(0).max(0) as u32;
            let ends = start
                .checked_add_months(Months::new(months))
                .unwrap_or(start);
            v.hold_months = row.hold_months;
            v.ends_at = Some(ends.to_rfc3339());
            v.pct = pct((at - start).num_seconds(), (ends - start).num_seconds());
            let left = |t: &DateTime<Utc>| *t > start && *t <= at;
            let touched = f
                .deposits
                .iter()
                .any(|(_, _, spent)| spent.as_ref().is_some_and(left))
                || f.sends.iter().any(left);
            // Finished only once a scan AFTER the end date confirmed
            // nothing left; a spend we hadn't seen yet must not earn it.
            let confirmed = f.balance_checked_at.is_some_and(|t| t >= ends);
            if touched {
                Outcome::Over
            } else if at >= ends && confirmed {
                v.pct = 100;
                Outcome::Done
            } else {
                Outcome::Going
            }
        }
        Kind::GoalByDate => {
            v.goal_id = row.goal_id.clone();
            let goal = row.goal_id.as_ref().and_then(|g| f.goals.get(g));
            match goal.and_then(|g| Some((g.saved_sat.max(0), g.amount_sat?, g.target_date?))) {
                // Removed, or its amount or date taken away.
                None => Outcome::Over,
                Some((saved, amount, date)) => {
                    let deadline = end_of_day(date);
                    v.saved_sat = Some(saved);
                    v.target_sat = Some(amount);
                    v.target_date = Some(date.to_string());
                    v.pct = pct(saved, amount);
                    let span = (deadline - start).num_seconds().max(1);
                    let gone = (at - start).num_seconds().clamp(0, span);
                    let expected = (amount as i128 * gone as i128 / span as i128) as i64;
                    v.on_track = Some(saved >= expected);
                    let weeks_left =
                        ((deadline - at).num_seconds().max(0) + 7 * 86_400 - 1) / (7 * 86_400);
                    v.per_week_sat = Some((amount - saved).max(0) / weeks_left.max(1));
                    if saved >= amount {
                        Outcome::Done
                    } else if at >= deadline {
                        Outcome::Over
                    } else {
                        Outcome::Going
                    }
                }
            }
        }
        Kind::EveryMonth => {
            let year = row.year.unwrap_or(start.year());
            let from = if start.year() == year {
                start.month()
            } else {
                1
            };
            let mut months = vec![false; 12];
            for (seen, _, _) in &f.deposits {
                if *seen <= at && seen.year() == year {
                    months[seen.month0() as usize] = true;
                }
            }
            let required: Vec<u32> = (from..=12).collect();
            let ticked = required
                .iter()
                .filter(|m| months[(**m - 1) as usize])
                .count();
            // A required month that has ended with nothing in it.
            let missed = required.iter().any(|m| {
                let first = NaiveDate::from_ymd_opt(year, *m, 1).unwrap();
                let end = first
                    .checked_add_months(Months::new(1))
                    .unwrap()
                    .and_hms_opt(0, 0, 0)
                    .unwrap()
                    .and_utc();
                end <= at && !months[(*m - 1) as usize]
            });
            v.year = Some(year);
            v.from_month = Some(from);
            v.months = Some(months);
            v.pct = pct(ticked as i64, required.len() as i64);
            if ticked == required.len() {
                Outcome::Done
            } else if missed {
                Outcome::Over
            } else {
                Outcome::Going
            }
        }
        Kind::Week52 => {
            let w1 = row.week1_sat.unwrap_or(0).max(0);
            let week = ((at - start).num_days().max(0) / 7 + 1).clamp(1, 52);
            let saved: i64 = f
                .deposits
                .iter()
                .filter(|(seen, _, _)| *seen >= start && *seen <= at)
                .map(|(_, amount, _)| *amount)
                .sum();
            let total = w1 * WEEK52_UNITS;
            let due = w1 * week * (week + 1) / 2;
            v.week1_sat = Some(w1);
            v.week = Some(week);
            v.saved_sat = Some(saved);
            v.target_sat = Some(total);
            v.due_so_far_sat = Some(due);
            v.this_week_sat = Some(w1 * week);
            v.on_track = Some(saved >= due);
            v.pct = pct(saved, total);
            if saved >= total {
                Outcome::Done
            } else if at >= start + chrono::Duration::days(52 * 7) {
                Outcome::Over
            } else {
                Outcome::Going
            }
        }
    };
    v.state = if row.completed_at.is_some() {
        "done".into()
    } else if row.ended_at.is_some() {
        row.end_reason.clone().unwrap_or_else(|| "over".into())
    } else {
        match outcome {
            Outcome::Going => "going",
            Outcome::Done => "done",
            Outcome::Over => "over",
        }
        .into()
    };
    (v, outcome)
}

fn parse_time(s: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|t| t.with_timezone(&Utc))
}

async fn load_rows(db: &sqlx::SqlitePool, vault_id: &str) -> Result<Vec<Row>, ApiError> {
    type R = (
        String,
        String,
        String,
        Option<i64>,
        Option<String>,
        Option<i64>,
        Option<i64>,
        Option<String>,
        Option<String>,
        Option<String>,
    );
    let rows: Vec<R> = sqlx::query_as(
        "SELECT id, kind, started_at, hold_months, goal_id, year, week1_sat, \
                ended_at, end_reason, completed_at \
           FROM savings_challenges WHERE vault_id = ? \
          ORDER BY rowid DESC LIMIT ?",
    )
    .bind(vault_id)
    .bind(LISTED)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .filter_map(
            |(id, kind, started, hold, goal, year, w1, ended, reason, done)| {
                Some(Row {
                    id,
                    kind: Kind::parse(&kind)?,
                    started_at: parse_time(&started)?,
                    hold_months: hold,
                    goal_id: goal,
                    year: year.map(|y| y as i32),
                    week1_sat: w1,
                    ended_at: ended.as_deref().and_then(parse_time),
                    end_reason: reason,
                    completed_at: done.as_deref().and_then(parse_time),
                })
            },
        )
        .collect())
}

async fn load_facts(db: &sqlx::SqlitePool, vault_id: &str) -> Result<Facts, ApiError> {
    let deposits: Vec<(String, i64, Option<String>)> = sqlx::query_as(
        "SELECT seen_at, amount_sat, spent_at FROM vault_deposits WHERE vault_id = ?",
    )
    .bind(vault_id)
    .fetch_all(db)
    .await?;
    let sends: Vec<(String,)> = sqlx::query_as(
        "SELECT created_at FROM events \
          WHERE vault_id = ? AND kind IN ('owner_send', 'claim_broadcast')",
    )
    .bind(vault_id)
    .fetch_all(db)
    .await?;
    let checked: Option<(Option<String>,)> =
        sqlx::query_as("SELECT balance_checked_at FROM vaults WHERE id = ?")
            .bind(vault_id)
            .fetch_optional(db)
            .await?;
    let goals: Vec<(String, Option<i64>, Option<String>, i64)> = sqlx::query_as(
        "SELECT g.id, g.amount_sat, g.target_date, \
                COALESCE((SELECT SUM(e.amount_sat) FROM savings_goal_entries e \
                           WHERE e.goal_id = g.id AND e.vault_id = g.vault_id), 0) \
           FROM savings_goals g WHERE g.vault_id = ?",
    )
    .bind(vault_id)
    .fetch_all(db)
    .await?;
    Ok(Facts {
        deposits: deposits
            .iter()
            .filter_map(|(seen, amount, spent)| {
                Some((
                    parse_time(seen)?,
                    *amount,
                    spent.as_deref().and_then(parse_time),
                ))
            })
            .collect(),
        sends: sends.iter().filter_map(|(t,)| parse_time(t)).collect(),
        balance_checked_at: checked.and_then(|(t,)| t).as_deref().and_then(parse_time),
        goals: goals
            .into_iter()
            .map(|(id, amount, date, saved)| {
                (
                    id,
                    GoalFacts {
                        saved_sat: saved,
                        amount_sat: amount,
                        target_date: date.and_then(|d| d.parse().ok()),
                    },
                )
            })
            .collect(),
    })
}

/// Stamp any running challenge that has finished or run out, then return
/// every challenge as the owner sees it. Stamps are compare-and-set, so a
/// page load and a scheduler tick at once settle a challenge once.
pub(crate) async fn settle(
    db: &sqlx::SqlitePool,
    vault_id: &str,
    now: DateTime<Utc>,
) -> Result<Vec<ChallengeView>, ApiError> {
    let mut rows = load_rows(db, vault_id).await?;
    let facts = load_facts(db, vault_id).await?;
    for row in rows.iter_mut().filter(|r| r.running()) {
        let (_, outcome) = evaluate(row, &facts, now);
        let stamp = match outcome {
            Outcome::Going => continue,
            Outcome::Done => {
                "UPDATE savings_challenges SET completed_at = ? \
                  WHERE id = ? AND completed_at IS NULL AND ended_at IS NULL"
            }
            Outcome::Over => {
                "UPDATE savings_challenges SET ended_at = ?, end_reason = 'over' \
                  WHERE id = ? AND completed_at IS NULL AND ended_at IS NULL"
            }
        };
        let done = sqlx::query(stamp)
            .bind(now.to_rfc3339())
            .bind(&row.id)
            .execute(db)
            .await?;
        if done.rows_affected() == 1 {
            match outcome {
                Outcome::Done => row.completed_at = Some(now),
                _ => {
                    row.ended_at = Some(now);
                    row.end_reason = Some("over".into());
                }
            }
        }
    }
    Ok(rows.iter().map(|r| evaluate(r, &facts, now).0).collect())
}

/// `GET /vaults/:id/savings/challenges` (owner).
pub async fn get_challenges(
    auth: OwnerAuth,
    State(state): State<Arc<AppState>>,
) -> Result<Json<ChallengesView>, ApiError> {
    let challenges = settle(&state.db, &auth.vault_id, Utc::now()).await?;
    Ok(Json(ChallengesView { challenges }))
}

#[derive(Debug, Deserialize)]
pub struct JoinRequest {
    pub kind: String,
    pub hold_months: Option<i64>,
    pub goal_id: Option<String>,
    pub week1_sat: Option<i64>,
}

/// What a join will store, once checked.
#[derive(Debug, PartialEq, Eq)]
struct Join {
    kind: Kind,
    hold_months: Option<i64>,
    goal_id: Option<String>,
    year: Option<i32>,
    week1_sat: Option<i64>,
}

fn validate_join(
    req: JoinRequest,
    goals: &HashMap<String, GoalFacts>,
    now: DateTime<Utc>,
) -> Result<Join, ApiError> {
    let bad = |m: &str| ApiError::Validation(m.into());
    let kind = Kind::parse(&req.kind).ok_or_else(|| bad("Pick a challenge."))?;
    let mut join = Join {
        kind,
        hold_months: None,
        goal_id: None,
        year: None,
        week1_sat: None,
    };
    match kind {
        Kind::Hold => {
            let m = req.hold_months.unwrap_or(0);
            if !HOLD_MONTHS.contains(&m) {
                return Err(bad("Choose 3, 6 or 12 months."));
            }
            join.hold_months = Some(m);
        }
        Kind::GoalByDate => {
            let id = req.goal_id.unwrap_or_default();
            let ok = goals.get(&id).is_some_and(|g| {
                g.amount_sat.is_some() && g.target_date.is_some_and(|d| d >= now.date_naive())
            });
            if !ok {
                return Err(bad(
                    "Pick a goal that has an amount and a date that hasn't passed.",
                ));
            }
            join.goal_id = Some(id);
        }
        Kind::EveryMonth => join.year = Some(now.year()),
        Kind::Week52 => {
            let w1 = req.week1_sat.unwrap_or(0);
            if !(WEEK1_MIN_SAT..=WEEK1_MAX_SAT).contains(&w1) {
                return Err(bad("Week 1 must be between 100 and 10,000,000 sats."));
            }
            join.week1_sat = Some(w1);
        }
    }
    Ok(join)
}

/// `POST /vaults/:id/savings/challenges` (owner): join a challenge.
pub async fn join_challenge(
    auth: OwnerAuth,
    State(state): State<Arc<AppState>>,
    Json(req): Json<JoinRequest>,
) -> Result<Json<ChallengesView>, ApiError> {
    let id = auth.vault_id;
    let now = Utc::now();
    // Settle first, so one that just finished or ran out doesn't block
    // starting it again.
    settle(&state.db, &id, now).await?;
    let facts = load_facts(&state.db, &id).await?;
    let join = validate_join(req, &facts.goals, now)?;
    let inserted = sqlx::query(
        "INSERT INTO savings_challenges \
             (id, vault_id, kind, started_at, hold_months, goal_id, year, week1_sat) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(uuid::Uuid::new_v4().to_string())
    .bind(&id)
    .bind(join.kind.as_str())
    .bind(now.to_rfc3339())
    .bind(join.hold_months)
    .bind(&join.goal_id)
    .bind(join.year)
    .bind(join.week1_sat)
    .execute(&state.db)
    .await;
    match inserted {
        Ok(_) => {}
        // The one-running-per-kind index.
        Err(sqlx::Error::Database(e)) if e.is_unique_violation() => {
            return Err(ApiError::Conflict(
                "That challenge is already going.".into(),
            ))
        }
        Err(e) => return Err(e.into()),
    }
    let challenges = settle(&state.db, &id, now).await?;
    Ok(Json(ChallengesView { challenges }))
}

#[derive(Debug, Deserialize)]
pub struct StopRequest {
    pub id: String,
}

/// `POST /vaults/:id/savings/challenges/stop` (owner): stop one. Nothing
/// happens to the money and nobody is told.
pub async fn stop_challenge(
    auth: OwnerAuth,
    State(state): State<Arc<AppState>>,
    Json(req): Json<StopRequest>,
) -> Result<Json<ChallengesView>, ApiError> {
    let now = Utc::now();
    let exists: Option<(String,)> =
        sqlx::query_as("SELECT id FROM savings_challenges WHERE id = ? AND vault_id = ?")
            .bind(&req.id)
            .bind(&auth.vault_id)
            .fetch_optional(&state.db)
            .await?;
    if exists.is_none() {
        return Err(ApiError::NotFound);
    }
    // Already over or done: leave it as it is.
    sqlx::query(
        "UPDATE savings_challenges SET ended_at = ?, end_reason = 'stopped' \
          WHERE id = ? AND vault_id = ? AND ended_at IS NULL AND completed_at IS NULL",
    )
    .bind(now.to_rfc3339())
    .bind(&req.id)
    .bind(&auth.vault_id)
    .execute(&state.db)
    .await?;
    let challenges = settle(&state.db, &auth.vault_id, now).await?;
    Ok(Json(ChallengesView { challenges }))
}

/// The challenge's name, as the email says it.
fn challenge_name(kind: Kind, hold_months: Option<i64>, year: Option<i32>) -> String {
    match kind {
        Kind::Hold => format!(
            "Don't touch it for {} months",
            hold_months.unwrap_or_default()
        ),
        Kind::GoalByDate => "Hit your goal by its date".into(),
        Kind::EveryMonth => match year {
            Some(y) => format!("Save every month of {y}"),
            None => "Save every month this year".into(),
        },
        Kind::Week52 => "The 52-week challenge".into(),
    }
}

/// The congratulations email. No amounts: email is the least private
/// place to put them, and the page has the numbers.
pub(crate) fn completion_email(
    kind: Kind,
    hold_months: Option<i64>,
    year: Option<i32>,
    base: &str,
) -> (String, String) {
    let name = challenge_name(kind, hold_months, year);
    let subject = format!("You did it: {name}");
    let body = format!(
        "Hi,\n\n\
         You finished a savings challenge: {name}. Well done.\n\n\
         Your badge is waiting on your Challenges page:\n\n\
         {base}/#/challenges\n\n\
         Keep stacking. Every sat you save is yours, and if you ever stop \
         showing up, it goes to the person you chose.\n\n\
         From GhostKey\n"
    );
    (subject, body)
}

/// Scheduler step: settle every running challenge, then send each newly
/// finished one its congratulations email, once.
pub(crate) async fn send_completion_emails(
    state: &AppState,
    now: DateTime<Utc>,
) -> anyhow::Result<()> {
    let vaults: Vec<(String,)> = sqlx::query_as(
        "SELECT DISTINCT c.vault_id FROM savings_challenges c \
           JOIN vaults v ON v.id = c.vault_id \
          WHERE c.ended_at IS NULL AND c.completed_at IS NULL \
            AND v.status != 'claimed'",
    )
    .fetch_all(&state.db)
    .await?;
    for (vault_id,) in vaults {
        if let Err(e) = settle(&state.db, &vault_id, now).await {
            tracing::warn!(vault_id = %vault_id, error = ?e, "could not settle challenges");
        }
    }

    type Due = (String, String, String, Option<i64>, Option<i64>);
    let due: Vec<Due> = sqlx::query_as(
        "SELECT id, vault_id, kind, hold_months, year FROM savings_challenges \
          WHERE completed_at IS NOT NULL AND completion_emailed_at IS NULL",
    )
    .fetch_all(&state.db)
    .await?;
    let base = crate::scheduler::public_base_url();
    for (id, vault_id, kind, hold_months, year) in due {
        // Claim it first: whoever wins sends it, and it never goes twice.
        let claimed = sqlx::query(
            "UPDATE savings_challenges SET completion_emailed_at = ? \
              WHERE id = ? AND completion_emailed_at IS NULL",
        )
        .bind(now.to_rfc3339())
        .bind(&id)
        .execute(&state.db)
        .await?;
        if claimed.rows_affected() == 0 {
            continue;
        }
        let Some(kind) = Kind::parse(&kind) else {
            continue;
        };
        let (subject, body) = completion_email(kind, hold_months, year.map(|y| y as i32), &base);
        match crate::notifier::enqueue_owner_email(
            &state.db,
            &vault_id,
            crate::notifier::NotificationKind::ChallengeDone,
            &subject,
            &body,
        )
        .await
        {
            Ok(true) => tracing::info!(vault_id = %vault_id, "challenge email enqueued"),
            Ok(false) => tracing::info!(
                vault_id = %vault_id,
                "challenge email skipped: no confirmed owner email"
            ),
            Err(e) => {
                tracing::warn!(vault_id = %vault_id, error = ?e, "challenge email not enqueued")
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(s: &str) -> DateTime<Utc> {
        parse_time(s).unwrap()
    }

    fn row(kind: Kind, started: &str) -> Row {
        Row {
            id: "c1".into(),
            kind,
            started_at: at(started),
            hold_months: None,
            goal_id: None,
            year: None,
            week1_sat: None,
            ended_at: None,
            end_reason: None,
            completed_at: None,
        }
    }

    fn deposit(seen: &str, sat: i64) -> (DateTime<Utc>, i64, Option<DateTime<Utc>>) {
        (at(seen), sat, None)
    }

    const START: &str = "2026-01-15T10:00:00Z";

    // ---- Don't touch it ----

    fn hold() -> Row {
        Row {
            hold_months: Some(3),
            ..row(Kind::Hold, START)
        }
    }

    #[test]
    fn hold_counts_down_and_finishes_only_after_a_scan_past_the_end() {
        let mut f = Facts {
            deposits: vec![deposit("2026-01-01T00:00:00Z", 50_000)],
            balance_checked_at: Some(at("2026-03-01T00:00:00Z")),
            ..Facts::default()
        };
        let (v, o) = evaluate(&hold(), &f, at("2026-02-15T10:00:00Z"));
        assert_eq!(o, Outcome::Going);
        assert_eq!(v.ends_at.as_deref(), Some("2026-04-15T10:00:00+00:00"));
        assert!((30..=36).contains(&v.pct), "{}", v.pct);

        // Past the end, but no scan since: a spend we haven't seen yet
        // must not earn the badge.
        let after = at("2026-04-15T11:00:00Z");
        assert_eq!(evaluate(&hold(), &f, after).1, Outcome::Going);
        f.balance_checked_at = Some(at("2026-04-15T10:30:00Z"));
        let (v, o) = evaluate(&hold(), &f, after);
        assert_eq!((o, v.pct), (Outcome::Done, 100));
    }

    #[test]
    fn hold_ends_when_a_coin_leaves_by_any_route() {
        // Spent outside GhostKey, noticed by a scan.
        let f = Facts {
            deposits: vec![(
                at("2026-01-01T00:00:00Z"),
                50_000,
                Some(at("2026-02-01T00:00:00Z")),
            )],
            ..Facts::default()
        };
        assert_eq!(
            evaluate(&hold(), &f, at("2026-02-15T00:00:00Z")).1,
            Outcome::Over
        );
        // Sent from GhostKey.
        let f = Facts {
            sends: vec![at("2026-03-01T00:00:00Z")],
            ..Facts::default()
        };
        assert_eq!(
            evaluate(&hold(), &f, at("2026-03-02T00:00:00Z")).1,
            Outcome::Over
        );
        // A spend from before joining doesn't count.
        let f = Facts {
            sends: vec![at("2026-01-10T00:00:00Z")],
            ..Facts::default()
        };
        assert_eq!(
            evaluate(&hold(), &f, at("2026-02-01T00:00:00Z")).1,
            Outcome::Going
        );
    }

    #[test]
    fn a_settled_challenge_is_shown_as_it_stood() {
        // Finished on 15 April; a spend in May doesn't take it back.
        let done = Row {
            completed_at: Some(at("2026-04-15T12:00:00Z")),
            ..hold()
        };
        let f = Facts {
            sends: vec![at("2026-05-01T00:00:00Z")],
            balance_checked_at: Some(at("2026-04-15T11:00:00Z")),
            ..Facts::default()
        };
        let (v, _) = evaluate(&done, &f, at("2026-06-01T00:00:00Z"));
        assert_eq!((v.state.as_str(), v.pct), ("done", 100));
    }

    // ---- Hit a goal by its date ----

    fn goal_facts(saved: i64, amount: Option<i64>, date: Option<&str>) -> Facts {
        let mut goals = HashMap::new();
        goals.insert(
            "g1".to_string(),
            GoalFacts {
                saved_sat: saved,
                amount_sat: amount,
                target_date: date.map(|d| d.parse().unwrap()),
            },
        );
        Facts {
            goals,
            ..Facts::default()
        }
    }

    fn by_date() -> Row {
        Row {
            goal_id: Some("g1".into()),
            ..row(Kind::GoalByDate, "2026-01-01T00:00:00Z")
        }
    }

    #[test]
    fn goal_by_date_paces_and_finishes() {
        // Halfway through the year with a quarter saved: behind, and says
        // how much a week would get there.
        let f = goal_facts(250_000, Some(1_000_000), Some("2026-12-31"));
        let (v, o) = evaluate(&by_date(), &f, at("2026-07-02T12:00:00Z"));
        assert_eq!(o, Outcome::Going);
        assert_eq!((v.pct, v.on_track), (25, Some(false)));
        assert_eq!(v.per_week_sat, Some(750_000 / 27));

        let f = goal_facts(1_000_000, Some(1_000_000), Some("2026-12-31"));
        assert_eq!(
            evaluate(&by_date(), &f, at("2026-07-02T12:00:00Z")).1,
            Outcome::Done
        );
    }

    #[test]
    fn goal_by_date_runs_out_after_the_whole_last_day() {
        let f = goal_facts(10, Some(1_000_000), Some("2026-12-31"));
        assert_eq!(
            evaluate(&by_date(), &f, at("2026-12-31T23:59:00Z")).1,
            Outcome::Going
        );
        assert_eq!(
            evaluate(&by_date(), &f, at("2027-01-01T00:00:00Z")).1,
            Outcome::Over
        );
    }

    #[test]
    fn goal_by_date_ends_if_the_goal_goes() {
        assert_eq!(
            evaluate(&by_date(), &Facts::default(), at("2026-03-01T00:00:00Z")).1,
            Outcome::Over
        );
        let f = goal_facts(10, None, Some("2026-12-31"));
        assert_eq!(
            evaluate(&by_date(), &f, at("2026-03-01T00:00:00Z")).1,
            Outcome::Over
        );
    }

    // ---- Save every month this year ----

    fn every_month(started: &str) -> Row {
        Row {
            year: Some(2026),
            ..row(Kind::EveryMonth, started)
        }
    }

    #[test]
    fn every_month_counts_from_the_join_month() {
        // Joined in November: only November and December count, even
        // though nothing came in earlier in the year.
        let f = Facts {
            deposits: vec![
                deposit("2026-03-05T00:00:00Z", 1),
                deposit("2026-11-20T00:00:00Z", 1),
            ],
            ..Facts::default()
        };
        let r = every_month("2026-11-10T00:00:00Z");
        let (v, o) = evaluate(&r, &f, at("2026-11-25T00:00:00Z"));
        assert_eq!(o, Outcome::Going);
        assert_eq!(v.from_month, Some(11));
        assert_eq!(v.pct, 50);
        let months = v.months.unwrap();
        assert!(months[2] && months[10] && !months[11]);

        let mut f = f;
        f.deposits.push(deposit("2026-12-31T23:00:00Z", 1));
        assert_eq!(
            evaluate(&r, &f, at("2026-12-31T23:30:00Z")).1,
            Outcome::Done
        );
    }

    #[test]
    fn every_month_is_over_once_a_month_ends_empty() {
        let r = every_month("2026-10-01T00:00:00Z");
        let f = Facts {
            deposits: vec![deposit("2026-10-03T00:00:00Z", 1)],
            ..Facts::default()
        };
        // November is still open.
        assert_eq!(
            evaluate(&r, &f, at("2026-11-30T23:00:00Z")).1,
            Outcome::Going
        );
        // November ended with nothing.
        assert_eq!(
            evaluate(&r, &f, at("2026-12-01T00:00:00Z")).1,
            Outcome::Over
        );
    }

    // ---- 52-week challenge ----

    fn week52() -> Row {
        Row {
            week1_sat: Some(1_000),
            ..row(Kind::Week52, START)
        }
    }

    #[test]
    fn week52_allows_catch_up() {
        // Week 3: due 1,000 + 2,000 + 3,000. One deposit covers it.
        let f = Facts {
            deposits: vec![
                deposit("2026-01-01T00:00:00Z", 999_999), // before joining
                deposit("2026-01-30T00:00:00Z", 6_000),
            ],
            ..Facts::default()
        };
        let (v, o) = evaluate(&week52(), &f, at("2026-01-30T12:00:00Z"));
        assert_eq!(o, Outcome::Going);
        assert_eq!(v.week, Some(3));
        assert_eq!(v.due_so_far_sat, Some(6_000));
        assert_eq!(v.this_week_sat, Some(3_000));
        assert_eq!(v.saved_sat, Some(6_000));
        assert_eq!(v.on_track, Some(true));
        assert_eq!(v.target_sat, Some(1_378_000));

        // A week later with nothing more: behind, but still going.
        let (v, _) = evaluate(&week52(), &f, at("2026-02-06T12:00:00Z"));
        assert_eq!((v.week, v.on_track), (Some(4), Some(false)));
    }

    #[test]
    fn week52_finishes_on_the_total_and_runs_out_after_a_year() {
        let f = Facts {
            deposits: vec![deposit("2026-06-01T00:00:00Z", 1_378_000)],
            ..Facts::default()
        };
        assert_eq!(
            evaluate(&week52(), &f, at("2026-06-02T00:00:00Z")).1,
            Outcome::Done
        );
        let f = Facts {
            deposits: vec![deposit("2026-06-01T00:00:00Z", 1_000)],
            ..Facts::default()
        };
        assert_eq!(
            evaluate(&week52(), &f, at("2027-01-14T00:00:00Z")).1,
            Outcome::Going
        );
        assert_eq!(
            evaluate(&week52(), &f, at("2027-01-14T10:00:00Z")).1,
            Outcome::Over
        );
    }

    // ---- joining ----

    #[test]
    fn joins_are_checked() {
        let now = at("2026-11-25T00:00:00Z");
        let goals = goal_facts(0, Some(1), Some("2026-12-31")).goals;
        let req = |kind: &str| JoinRequest {
            kind: kind.into(),
            hold_months: None,
            goal_id: None,
            week1_sat: None,
        };
        assert!(validate_join(req("nope"), &goals, now).is_err());
        assert!(validate_join(req("hold"), &goals, now).is_err());
        assert_eq!(
            validate_join(
                JoinRequest {
                    hold_months: Some(6),
                    ..req("hold")
                },
                &goals,
                now
            )
            .unwrap()
            .hold_months,
            Some(6)
        );
        assert!(validate_join(
            JoinRequest {
                hold_months: Some(5),
                ..req("hold")
            },
            &goals,
            now
        )
        .is_err());
        assert!(validate_join(
            JoinRequest {
                goal_id: Some("g1".into()),
                ..req("goal_by_date")
            },
            &goals,
            now
        )
        .is_ok());
        // A goal whose date has passed can't be a challenge.
        let past = goal_facts(0, Some(1), Some("2026-11-24")).goals;
        assert!(validate_join(
            JoinRequest {
                goal_id: Some("g1".into()),
                ..req("goal_by_date")
            },
            &past,
            now
        )
        .is_err());
        assert_eq!(
            validate_join(req("every_month"), &goals, now).unwrap().year,
            Some(2026)
        );
        assert!(validate_join(
            JoinRequest {
                week1_sat: Some(99),
                ..req("week52")
            },
            &goals,
            now
        )
        .is_err());
    }

    #[test]
    fn the_email_names_the_challenge_and_no_amounts() {
        let (subject, body) =
            completion_email(Kind::Hold, Some(6), None, "https://ghostkeyapp.com");
        assert_eq!(subject, "You did it: Don't touch it for 6 months");
        assert!(body.contains("https://ghostkeyapp.com/#/challenges"));
        assert!(!body.contains("sats"));
    }

    // ---- with the database ----

    async fn db() -> sqlx::SqlitePool {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        let ts = Utc::now().to_rfc3339();
        sqlx::query(
            "INSERT INTO vaults (id, network, descriptor_external, descriptor_internal, \
                 timelock_blocks, checkin_period_secs, grace_period_secs, created_at, \
                 next_deadline_at) VALUES ('v1', 'signet', 'e', 'i', 144, 3600, 3600, ?, ?)",
        )
        .bind(&ts)
        .bind(&ts)
        .execute(&pool)
        .await
        .unwrap();
        pool
    }

    async fn insert(pool: &sqlx::SqlitePool, id: &str, kind: &str, started: &str) {
        sqlx::query(
            "INSERT INTO savings_challenges (id, vault_id, kind, started_at, week1_sat) \
             VALUES (?, 'v1', ?, ?, 1000)",
        )
        .bind(id)
        .bind(kind)
        .bind(started)
        .execute(pool)
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn only_one_of_each_kind_runs_at_a_time() {
        let pool = db().await;
        insert(&pool, "a", "week52", START).await;
        let again = sqlx::query(
            "INSERT INTO savings_challenges (id, vault_id, kind, started_at) \
             VALUES ('b', 'v1', 'week52', ?)",
        )
        .bind(START)
        .execute(&pool)
        .await;
        assert!(matches!(again, Err(sqlx::Error::Database(e)) if e.is_unique_violation()));
        // Once it has ended, a new one can start.
        sqlx::query("UPDATE savings_challenges SET ended_at = ? WHERE id = 'a'")
            .bind(START)
            .execute(&pool)
            .await
            .unwrap();
        insert(&pool, "b", "week52", START).await;
    }

    #[tokio::test]
    async fn settling_stamps_a_finish_once() {
        let pool = db().await;
        insert(&pool, "a", "week52", "2026-01-01T00:00:00Z").await;
        sqlx::query(
            "INSERT INTO vault_deposits (vault_id, outpoint, amount_sat, height, seen_at) \
             VALUES ('v1', 'x:0', 1378000, 1, '2026-02-01T00:00:00+00:00')",
        )
        .execute(&pool)
        .await
        .unwrap();
        let t = at("2026-02-02T00:00:00Z");
        let views = settle(&pool, "v1", t).await.unwrap();
        assert_eq!(views[0].state, "done");
        assert_eq!(
            views[0].completed_at.as_deref(),
            Some(t.to_rfc3339().as_str())
        );
        // A later look keeps the first stamp.
        let views = settle(&pool, "v1", at("2026-03-01T00:00:00Z"))
            .await
            .unwrap();
        assert_eq!(
            views[0].completed_at.as_deref(),
            Some(t.to_rfc3339().as_str())
        );
    }
}
