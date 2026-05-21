use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::{DateTime, Duration, Utc};
use ghostkey_core::descriptor::parse_descriptor;
use serde::{Deserialize, Serialize};
use tower_http::cors::{Any, CorsLayer};
use tower_http::trace::TraceLayer;
use uuid::Uuid;

use crate::AppState;

pub fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/vaults", post(create_vault).get(list_vaults))
        .route("/vaults/:id", get(get_vault))
        .route("/vaults/:id/checkin", post(checkin))
        .route("/vaults/:id/events", get(list_events))
        .layer(TraceLayer::new_for_http())
        .layer(
            CorsLayer::new()
                .allow_origin(Any)
                .allow_methods(Any)
                .allow_headers(Any),
        )
        .with_state(state)
}

#[derive(Debug, Serialize)]
struct Health {
    ok: bool,
    version: &'static str,
}

async fn health() -> Json<Health> {
    Json(Health { ok: true, version: env!("CARGO_PKG_VERSION") })
}

#[derive(Debug, Deserialize)]
pub struct CreateVaultRequest {
    pub label: Option<String>,
    pub network: String,
    pub descriptor_external: String,
    pub descriptor_internal: String,
    pub timelock_blocks: u32,
    pub checkin_period_secs: i64,
    pub grace_period_secs: i64,
    pub owner_contact: Option<String>,
    pub heir_contact: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct VaultView {
    pub id: String,
    pub label: Option<String>,
    pub network: String,
    pub timelock_blocks: i64,
    pub checkin_period_secs: i64,
    pub grace_period_secs: i64,
    pub status: String,
    pub created_at: DateTime<Utc>,
    pub last_checkin_at: Option<DateTime<Utc>>,
    pub next_deadline_at: DateTime<Utc>,
}

#[derive(Debug, thiserror::Error)]
pub enum ApiError {
    #[error("not found")]
    NotFound,
    #[error("validation: {0}")]
    Validation(String),
    #[error("db: {0}")]
    Db(#[from] sqlx::Error),
}

impl IntoResponse for ApiError {
    fn into_response(self) -> axum::response::Response {
        let (code, msg) = match &self {
            ApiError::NotFound => (StatusCode::NOT_FOUND, self.to_string()),
            ApiError::Validation(_) => (StatusCode::BAD_REQUEST, self.to_string()),
            ApiError::Db(_) => {
                tracing::error!(error = ?self, "db error");
                (StatusCode::INTERNAL_SERVER_ERROR, "internal error".into())
            }
        };
        (code, Json(serde_json::json!({"error": msg}))).into_response()
    }
}

async fn create_vault(
    State(state): State<Arc<AppState>>,
    Json(req): Json<CreateVaultRequest>,
) -> Result<(StatusCode, Json<VaultView>), ApiError> {
    if req.checkin_period_secs <= 0 || req.grace_period_secs < 0 {
        return Err(ApiError::Validation("non-positive period".into()));
    }
    if req.timelock_blocks == 0 || req.timelock_blocks > 0xFFFF {
        return Err(ApiError::Validation(format!(
            "timelock_blocks {} out of range 1..=65535",
            req.timelock_blocks
        )));
    }
    // Refuse to store anything that isn't a parseable inheritance descriptor.
    parse_descriptor(&req.descriptor_external)
        .map_err(|e| ApiError::Validation(format!("descriptor_external: {e}")))?;
    parse_descriptor(&req.descriptor_internal)
        .map_err(|e| ApiError::Validation(format!("descriptor_internal: {e}")))?;
    match req.network.as_str() {
        "bitcoin" | "testnet" | "signet" | "regtest" => {}
        other => return Err(ApiError::Validation(format!("unknown network {other}"))),
    }

    let id = Uuid::new_v4().to_string();
    let now = Utc::now();
    let next_deadline =
        now + Duration::seconds(req.checkin_period_secs + req.grace_period_secs);
    let now_s = now.to_rfc3339();
    let next_s = next_deadline.to_rfc3339();
    let timelock = req.timelock_blocks as i64;

    sqlx::query(
        r#"INSERT INTO vaults (
            id, label, network,
            descriptor_external, descriptor_internal,
            timelock_blocks,
            checkin_period_secs, grace_period_secs,
            owner_contact, heir_contact,
            created_at, next_deadline_at, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ok')"#,
    )
    .bind(&id)
    .bind(&req.label)
    .bind(&req.network)
    .bind(&req.descriptor_external)
    .bind(&req.descriptor_internal)
    .bind(timelock)
    .bind(req.checkin_period_secs)
    .bind(req.grace_period_secs)
    .bind(&req.owner_contact)
    .bind(&req.heir_contact)
    .bind(&now_s)
    .bind(&next_s)
    .execute(&state.db)
    .await?;

    record_event(&state.db, &id, "registered", None).await?;

    Ok((
        StatusCode::CREATED,
        Json(VaultView {
            id,
            label: req.label,
            network: req.network,
            timelock_blocks: timelock,
            checkin_period_secs: req.checkin_period_secs,
            grace_period_secs: req.grace_period_secs,
            status: "ok".into(),
            created_at: now,
            last_checkin_at: None,
            next_deadline_at: next_deadline,
        }),
    ))
}

#[derive(Debug, Serialize)]
pub struct VaultListItem {
    pub id: String,
    pub label: Option<String>,
    pub status: String,
    pub next_deadline_at: DateTime<Utc>,
}

async fn list_vaults(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<VaultListItem>>, ApiError> {
    let rows = sqlx::query_as::<_, (String, Option<String>, String, String)>(
        "SELECT id, label, status, next_deadline_at FROM vaults ORDER BY created_at DESC",
    )
    .fetch_all(&state.db)
    .await?;
    let out = rows
        .into_iter()
        .map(|(id, label, status, dl)| VaultListItem {
            id,
            label,
            status,
            next_deadline_at: DateTime::parse_from_rfc3339(&dl)
                .map(|d| d.with_timezone(&Utc))
                .unwrap_or_else(|_| Utc::now()),
        })
        .collect();
    Ok(Json(out))
}

async fn get_vault(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<VaultView>, ApiError> {
    let row = sqlx::query_as::<
        _,
        (
            String,         // id
            Option<String>, // label
            String,         // network
            i64,            // timelock_blocks
            i64,            // checkin_period_secs
            i64,            // grace_period_secs
            String,         // status
            String,         // created_at
            Option<String>, // last_checkin_at
            String,         // next_deadline_at
        ),
    >(
        r#"SELECT id, label, network, timelock_blocks,
                  checkin_period_secs, grace_period_secs,
                  status, created_at, last_checkin_at, next_deadline_at
           FROM vaults WHERE id = ?"#,
    )
    .bind(&id)
    .fetch_optional(&state.db)
    .await?
    .ok_or(ApiError::NotFound)?;

    Ok(Json(VaultView {
        id: row.0,
        label: row.1,
        network: row.2,
        timelock_blocks: row.3,
        checkin_period_secs: row.4,
        grace_period_secs: row.5,
        status: row.6,
        created_at: parse_rfc(&row.7),
        last_checkin_at: row.8.as_deref().map(parse_rfc),
        next_deadline_at: parse_rfc(&row.9),
    }))
}

#[derive(Debug, Serialize)]
pub struct CheckinResponse {
    pub vault_id: String,
    pub last_checkin_at: DateTime<Utc>,
    pub next_deadline_at: DateTime<Utc>,
    pub status: String,
}

async fn checkin(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<CheckinResponse>, ApiError> {
    // Fetch the cadence to recompute the deadline.
    let row = sqlx::query_as::<_, (i64, i64)>(
        "SELECT checkin_period_secs, grace_period_secs FROM vaults WHERE id = ?",
    )
    .bind(&id)
    .fetch_optional(&state.db)
    .await?
    .ok_or(ApiError::NotFound)?;

    let now = Utc::now();
    let next = now + Duration::seconds(row.0 + row.1);
    let now_s = now.to_rfc3339();
    let next_s = next.to_rfc3339();

    sqlx::query(
        r#"UPDATE vaults
              SET last_checkin_at = ?,
                  next_deadline_at = ?,
                  status = 'ok'
            WHERE id = ?"#,
    )
    .bind(&now_s)
    .bind(&next_s)
    .bind(&id)
    .execute(&state.db)
    .await?;

    record_event(&state.db, &id, "checkin", None).await?;

    Ok(Json(CheckinResponse {
        vault_id: id,
        last_checkin_at: now,
        next_deadline_at: next,
        status: "ok".into(),
    }))
}

#[derive(Debug, Serialize)]
pub struct EventView {
    pub id: i64,
    pub vault_id: String,
    pub kind: String,
    pub detail: Option<serde_json::Value>,
    pub created_at: DateTime<Utc>,
}

async fn list_events(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<Vec<EventView>>, ApiError> {
    let rows = sqlx::query_as::<_, (i64, String, String, Option<String>, String)>(
        "SELECT id, vault_id, kind, detail, created_at FROM events WHERE vault_id = ? ORDER BY id ASC",
    )
    .bind(&id)
    .fetch_all(&state.db)
    .await?;
    let out = rows
        .into_iter()
        .map(|(eid, vid, kind, detail, created)| EventView {
            id: eid,
            vault_id: vid,
            kind,
            detail: detail.and_then(|s| serde_json::from_str(&s).ok()),
            created_at: parse_rfc(&created),
        })
        .collect();
    Ok(Json(out))
}

pub(crate) async fn record_event(
    db: &sqlx::SqlitePool,
    vault_id: &str,
    kind: &str,
    detail: Option<serde_json::Value>,
) -> Result<(), sqlx::Error> {
    let detail_s = detail.map(|v| v.to_string());
    let now_s = Utc::now().to_rfc3339();
    sqlx::query("INSERT INTO events (vault_id, kind, detail, created_at) VALUES (?, ?, ?, ?)")
        .bind(vault_id)
        .bind(kind)
        .bind(detail_s)
        .bind(now_s)
        .execute(db)
        .await?;
    Ok(())
}

fn parse_rfc(s: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(s)
        .map(|d| d.with_timezone(&Utc))
        .unwrap_or_else(|_| Utc::now())
}
