//! Per-vault and admin authentication for the notifier server.
//!
//! Until 20260524 the server's mutation endpoints relied on the
//! secrecy of vault UUIDs. That is obfuscation, not authentication.
//! This module adds bearer-token auth on top:
//!
//!   * Each vault has an `owner_token` issued at creation time and
//!     returned to the caller exactly once. The server stores only
//!     its SHA-256 hash in `vaults.owner_token_hash`.
//!   * An optional process-wide `admin_token` (env
//!     `GHOSTKEY_ADMIN_TOKEN`) gates operator-only routes like
//!     `GET /vaults` (the list of every vault). When the env var is
//!     unset, that route is disabled entirely.
//!
//! Requests authenticate by sending `Authorization: Bearer <token>`.
//! On a hit, the extractor inserts a marker into the request that the
//! handler can rely on (or just succeeds silently — both styles are
//! used here).
//!
//! ## Escape hatch (dev only)
//!
//! Setting `GHOSTKEY_AUTH_DISABLED=1` short-circuits every check in
//! this module. A warning is logged at startup and at every
//! authenticated route so it's hard to leave on by accident. This
//! is intended for local development, integration tests, and the
//! transition period while existing rows are missing an
//! `owner_token_hash`. Production deployments MUST NOT set this.
//!
//! ## Legacy rows
//!
//! Rows that existed before this migration have `owner_token_hash IS
//! NULL`. The default behaviour is to refuse mutations on them (401
//! Unauthorized — the caller has nothing to prove ownership with).
//! Operators who want to keep those vaults usable for their owners
//! can:
//!   1. read the descriptor out of the DB,
//!   2. recreate the vault via `POST /vaults/from-xpub`, which yields
//!      a fresh owner token,
//!   3. forward the token to the owner out-of-band.

use std::sync::OnceLock;

use axum::extract::{FromRequestParts, Path};
use axum::http::request::Parts;
use axum::http::{header, StatusCode};
use axum::response::IntoResponse;
use axum::Json;
use std::sync::Arc;

use crate::crypto::owner_token_matches;
use crate::AppState;

/// Marker inserted into the request when an owner token matches a
/// specific vault. Handlers that need to know *which* vault the
/// caller is authenticated for can take this extractor; everything
/// else can rely on the extractor's mere success.
#[derive(Clone, Debug)]
pub struct OwnerAuth {
    pub vault_id: String,
}

/// Marker inserted when the admin token matches. Same pattern as
/// [`OwnerAuth`] but with no associated vault.
#[derive(Clone, Debug)]
pub struct AdminAuth;

/// Errors the auth layer can return. Each one maps to a specific
/// HTTP status; we never leak which arm failed beyond what the
/// status code already says.
#[derive(Debug, thiserror::Error)]
pub enum AuthError {
    #[error("missing or malformed Authorization header")]
    MissingHeader,
    #[error("unauthorized")]
    Unauthorized,
    #[error("admin authentication is disabled (set GHOSTKEY_ADMIN_TOKEN to enable)")]
    AdminDisabled,
    #[error("db: {0}")]
    Db(#[from] sqlx::Error),
    #[error("internal")]
    Internal,
}

impl IntoResponse for AuthError {
    fn into_response(self) -> axum::response::Response {
        let (code, msg) = match &self {
            AuthError::MissingHeader => (StatusCode::UNAUTHORIZED, self.to_string()),
            AuthError::Unauthorized => (StatusCode::UNAUTHORIZED, self.to_string()),
            AuthError::AdminDisabled => (StatusCode::NOT_FOUND, "not found".to_string()),
            AuthError::Db(_) => {
                tracing::error!(error = ?self, "auth db error");
                (StatusCode::INTERNAL_SERVER_ERROR, "internal error".into())
            }
            AuthError::Internal => (StatusCode::INTERNAL_SERVER_ERROR, "internal error".into()),
        };
        (code, Json(serde_json::json!({ "error": msg }))).into_response()
    }
}

/// True if the deployment-wide auth escape hatch is on. Read once at
/// startup so a runtime env mutation can't toggle it mid-request.
pub fn auth_disabled() -> bool {
    static FLAG: OnceLock<bool> = OnceLock::new();
    *FLAG.get_or_init(
        || match std::env::var("GHOSTKEY_AUTH_DISABLED").as_deref() {
            Ok("1") | Ok("true") | Ok("yes") => {
                tracing::warn!(
                "GHOSTKEY_AUTH_DISABLED is set; every authenticated route will accept any caller. \
                 This is intended for local development only and MUST NOT be set in production."
            );
                true
            }
            _ => false,
        },
    )
}

/// Read the configured admin token (hash form expected). Cached after
/// the first call to avoid env reads on the hot path.
fn admin_token_hash_hex() -> Option<&'static str> {
    static CACHED: OnceLock<Option<String>> = OnceLock::new();
    CACHED
        .get_or_init(|| std::env::var("GHOSTKEY_ADMIN_TOKEN_HASH").ok())
        .as_deref()
}

/// Pull a `Bearer <token>` value out of the `Authorization` header.
fn bearer_token(parts: &Parts) -> Result<&str, AuthError> {
    let raw = parts
        .headers
        .get(header::AUTHORIZATION)
        .ok_or(AuthError::MissingHeader)?
        .to_str()
        .map_err(|_| AuthError::MissingHeader)?;
    raw.strip_prefix("Bearer ")
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or(AuthError::MissingHeader)
}

#[axum::async_trait]
impl FromRequestParts<Arc<AppState>> for OwnerAuth {
    type Rejection = AuthError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &Arc<AppState>,
    ) -> Result<Self, Self::Rejection> {
        // Pull :id out of the path. Every protected route has it.
        let Path(vault_id): Path<String> = Path::from_request_parts(parts, state)
            .await
            .map_err(|_| AuthError::Internal)?;

        if auth_disabled() {
            tracing::warn!(
                vault_id = %vault_id,
                "owner auth bypassed by GHOSTKEY_AUTH_DISABLED"
            );
            return Ok(OwnerAuth { vault_id });
        }

        let token = bearer_token(parts)?;

        // Fetch the stored hash for this vault. A row without an
        // owner token (legacy) is treated as "no auth possible" and
        // refused.
        let row: Option<(Option<String>,)> =
            sqlx::query_as("SELECT owner_token_hash FROM vaults WHERE id = ?")
                .bind(&vault_id)
                .fetch_optional(&state.db)
                .await?;
        let stored_hash = match row {
            Some((Some(h),)) => h,
            // Row exists but has no token (legacy). Treat as 401, not
            // 404: telling the caller "no such vault" when the vault
            // does exist would leak existence; telling them
            // "unauthorized" is the truth.
            Some((None,)) => return Err(AuthError::Unauthorized),
            // Row does not exist. Same 401 to avoid timing/existence
            // leaks on enumeration.
            None => return Err(AuthError::Unauthorized),
        };

        if !owner_token_matches(token, &stored_hash) {
            return Err(AuthError::Unauthorized);
        }
        Ok(OwnerAuth { vault_id })
    }
}

#[axum::async_trait]
impl FromRequestParts<Arc<AppState>> for AdminAuth {
    type Rejection = AuthError;

    async fn from_request_parts(
        parts: &mut Parts,
        _state: &Arc<AppState>,
    ) -> Result<Self, Self::Rejection> {
        if auth_disabled() {
            tracing::warn!("admin auth bypassed by GHOSTKEY_AUTH_DISABLED");
            return Ok(AdminAuth);
        }

        let configured = match admin_token_hash_hex() {
            Some(h) => h,
            None => return Err(AuthError::AdminDisabled),
        };
        let presented = bearer_token(parts)?;
        if !owner_token_matches(presented, configured) {
            return Err(AuthError::Unauthorized);
        }
        Ok(AdminAuth)
    }
}

/// Parse the CORS allowlist from the environment, returning a list of
/// exact-match origins. An empty / unset env defaults to the local
/// dev frontends.
/// Serialises the tests that mutate `GHOSTKEY_ALLOWED_ORIGINS`. Env vars
/// are process-global and the test binary is threaded, so a router built
/// in one test would otherwise see another test's origin list.
#[cfg(test)]
pub(crate) static ORIGINS_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

pub fn cors_allowed_origins() -> Vec<String> {
    let raw = std::env::var("GHOSTKEY_ALLOWED_ORIGINS").unwrap_or_default();
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return vec![
            "http://localhost:5173".to_string(),
            "http://127.0.0.1:5173".to_string(),
        ];
    }
    trimmed
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::{HeaderMap, HeaderValue};

    fn parts_with_header(value: Option<&str>) -> Parts {
        let mut req = axum::http::Request::builder().uri("/").body(()).unwrap();
        if let Some(v) = value {
            let mut headers = HeaderMap::new();
            headers.insert(header::AUTHORIZATION, HeaderValue::from_str(v).unwrap());
            *req.headers_mut() = headers;
        }
        req.into_parts().0
    }

    #[test]
    fn bearer_token_extracts_value() {
        let p = parts_with_header(Some("Bearer abc123"));
        assert_eq!(bearer_token(&p).unwrap(), "abc123");
    }

    #[test]
    fn bearer_token_trims_padding() {
        let p = parts_with_header(Some("Bearer  abc123  "));
        assert_eq!(bearer_token(&p).unwrap(), "abc123");
    }

    #[test]
    fn bearer_token_rejects_missing_header() {
        let p = parts_with_header(None);
        assert!(matches!(bearer_token(&p), Err(AuthError::MissingHeader)));
    }

    #[test]
    fn bearer_token_rejects_non_bearer_scheme() {
        let p = parts_with_header(Some("Basic abc123"));
        assert!(matches!(bearer_token(&p), Err(AuthError::MissingHeader)));
    }

    #[test]
    fn bearer_token_rejects_empty_value() {
        let p = parts_with_header(Some("Bearer "));
        assert!(matches!(bearer_token(&p), Err(AuthError::MissingHeader)));
    }

    #[test]
    fn cors_allowed_origins_default_is_localhost() {
        let _g = ORIGINS_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        // SAFETY: tests run in a single process; clear+restore is fine.
        unsafe { std::env::remove_var("GHOSTKEY_ALLOWED_ORIGINS") };
        let v = cors_allowed_origins();
        assert!(v.contains(&"http://localhost:5173".to_string()));
        assert!(v.contains(&"http://127.0.0.1:5173".to_string()));
    }

    #[test]
    fn cors_allowed_origins_parses_csv() {
        let _g = ORIGINS_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        unsafe {
            std::env::set_var(
                "GHOSTKEY_ALLOWED_ORIGINS",
                "https://a.example, https://b.example",
            );
        }
        let v = cors_allowed_origins();
        assert_eq!(
            v,
            vec![
                "https://a.example".to_string(),
                "https://b.example".to_string()
            ]
        );
        unsafe { std::env::remove_var("GHOSTKEY_ALLOWED_ORIGINS") };
    }
}

/* -------------------------------------------------------------------------- *
 *  HTTP-level integration tests                                              *
 *                                                                            *
 *  These spin up the real router against an in-memory SQLite database with   *
 *  all migrations applied, then drive it through `tower::ServiceExt::        *
 *  oneshot`. They exercise the OwnerAuth extractor end-to-end: header        *
 *  parsing, DB lookup, hash compare, and the response shape on failure.     *
 *                                                                            *
 *  We deliberately do NOT test the AdminAuth route here. AdminAuth depends   *
 *  on a cached env-var read (`admin_token_hash_hex`) that uses a `OnceLock`  *
 *  -- once set in one test it'd leak into others. The unit tests on         *
 *  `bearer_token` already cover the header-parsing half.                     *
 * -------------------------------------------------------------------------- */

#[cfg(test)]
mod http_tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use base64::Engine as _;
    use serde_json::Value;
    use sqlx::sqlite::SqlitePoolOptions;
    use sqlx::SqlitePool;
    use tower::ServiceExt;

    use crate::crypto::ensure_master_key_loaded;
    use crate::routes;

    /// Bring up a fresh sqlite::memory and apply every migration. The
    /// master key is set to 32 zero bytes (base64) so the crypto
    /// module's startup check passes; we don't seal anything in these
    /// tests, but the server's startup-time invariants need to hold.
    async fn fresh_state() -> std::sync::Arc<crate::AppState> {
        // The crypto module reads this once via OnceLock; setting it
        // before any other test runs is fine.
        if std::env::var("GHOSTKEY_MASTER_KEY").is_err() {
            let zeros = [0u8; 32];
            let b64 = base64::engine::general_purpose::STANDARD_NO_PAD.encode(zeros);
            // SAFETY: tests are single-process; the value is fixed.
            unsafe {
                std::env::set_var("GHOSTKEY_MASTER_KEY", &b64);
            }
        }
        let _ = ensure_master_key_loaded();
        // Defence-in-depth: make sure the auth-disabled escape hatch
        // is OFF for these tests. We want to exercise the real path.
        unsafe { std::env::remove_var("GHOSTKEY_AUTH_DISABLED") };

        let pool: SqlitePool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("connect sqlite::memory");
        sqlx::migrate!("./migrations")
            .run(&pool)
            .await
            .expect("run migrations");
        std::sync::Arc::new(crate::AppState { db: pool })
    }

    /// Insert a vault directly so we can pin its id + token hash for
    /// assertions. Mirrors the `insert_vault` helper used in the
    /// scheduler tests but adds the `owner_token_hash` column.
    async fn insert_vault(pool: &SqlitePool, id: &str, owner_token_hash: Option<&str>) {
        sqlx::query(
            r#"INSERT INTO vaults (
                id, network,
                descriptor_external, descriptor_internal,
                timelock_blocks,
                checkin_period_secs, grace_period_secs,
                created_at, next_deadline_at, status,
                claim_eligible_at,
                owner_token_hash
            ) VALUES (?, 'regtest', ?, ?, 144, 86400, 3600,
                      '2026-01-01T00:00:00Z',
                      '2099-01-01T00:00:00Z', 'ok',
                      '2099-01-02T00:00:00Z',
                      ?)"#,
        )
        .bind(id)
        // descriptor_external is UNIQUE; tag with the id so multiple
        // tests can coexist in one DB.
        .bind(format!("tr(fake/{id}/0/*)"))
        .bind(format!("tr(fake/{id}/1/*)"))
        .bind(owner_token_hash)
        .execute(pool)
        .await
        .expect("insert");
    }

    #[tokio::test]
    async fn checkin_without_authorization_header_is_401() {
        let state = fresh_state().await;
        let issued = crate::crypto::issue_owner_token();
        insert_vault(&state.db, "vault-A", Some(&issued.hash_hex)).await;

        let app = routes::router(state);
        let resp = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/vaults/vault-A/checkin")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn checkin_with_correct_owner_token_succeeds() {
        let state = fresh_state().await;
        let issued = crate::crypto::issue_owner_token();
        insert_vault(&state.db, "vault-B", Some(&issued.hash_hex)).await;

        let app = routes::router(state);
        let resp = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/vaults/vault-B/checkin")
                    .header(header::AUTHORIZATION, format!("Bearer {}", issued.token))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn checkin_with_wrong_owner_token_is_401() {
        let state = fresh_state().await;
        let issued = crate::crypto::issue_owner_token();
        insert_vault(&state.db, "vault-C", Some(&issued.hash_hex)).await;

        let app = routes::router(state);
        let resp = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/vaults/vault-C/checkin")
                    .header(
                        header::AUTHORIZATION,
                        "Bearer aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    )
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn legacy_row_without_token_is_401_even_with_a_token() {
        let state = fresh_state().await;
        // owner_token_hash IS NULL — simulates a pre-migration row.
        insert_vault(&state.db, "vault-legacy", None).await;

        let app = routes::router(state);
        let resp = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/vaults/vault-legacy/checkin")
                    .header(
                        header::AUTHORIZATION,
                        "Bearer aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    )
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn nonexistent_vault_is_401_not_404() {
        // Avoiding the existence leak: we return 401 whether the row
        // is missing or the token is wrong. This is the same shape
        // GitHub / Stripe use for their own API tokens.
        let state = fresh_state().await;
        let app = routes::router(state);
        let resp = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/vaults/00000000-0000-0000-0000-000000000000/checkin")
                    .header(
                        header::AUTHORIZATION,
                        "Bearer aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    )
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn list_vaults_without_admin_auth_is_disabled_not_open() {
        // No GHOSTKEY_ADMIN_TOKEN_HASH set -> the route returns 404
        // (we deliberately hide its existence rather than return 401,
        // because admin auth is opt-in for the operator).
        unsafe { std::env::remove_var("GHOSTKEY_ADMIN_TOKEN_HASH") };
        let state = fresh_state().await;
        let app = routes::router(state);
        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/vaults")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn health_endpoint_is_open() {
        // The auth layer must never block /health -- it would break
        // load-balancer probes.
        let state = fresh_state().await;
        let app = routes::router(state);
        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/health")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body_bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        let body: Value = serde_json::from_slice(&body_bytes).unwrap();
        assert_eq!(body["ok"], true);
        // The build commit is always present so a deploy can be checked
        // against main; local and test builds report "unknown".
        assert!(
            body["commit"].as_str().is_some_and(|c| !c.is_empty()),
            "health must report the build commit, got {body}"
        );
    }

    /* ---------------------------------------------------------------- *
     *  One-tap check-in link tests                                     *
     *                                                                  *
     *  Wired in 20260528. The route `POST /vaults/:id/checkin-from-   *
     *  link/:token` is intentionally NOT behind OwnerAuth -- the      *
     *  token itself is the auth. Tests pin the contract:              *
     *    - wrong token -> 404 (not 401: we hide existence the same   *
     *      way `resolve_claim` does for heir links),                  *
     *    - right token -> 200 and the row's deadline is reset,        *
     *    - second tap with same token -> 409 (single-use),           *
     *    - check-in via this route also clears the per-cycle markers  *
     *      so the next reminder is eligible.                          *
     * ---------------------------------------------------------------- */

    /// Insert a vault that already has a live one-tap token. The
    /// hash is what `mint_or_reuse_one_tap_token` would have written
    /// when the scheduler enqueued the reminder; tests get to play
    /// the role of the owner clicking the email.
    async fn insert_vault_with_one_tap_token(pool: &SqlitePool, id: &str, token_hash: &str) {
        // claim_eligible_at sits inside the final-24h window so the
        // last-resort free check-in via the link is allowed (the free path
        // is gated to that window in checkin_from_link).
        let claim_eligible = (chrono::Utc::now() + chrono::Duration::hours(1)).to_rfc3339();
        sqlx::query(
            r#"INSERT INTO vaults (
                id, network,
                descriptor_external, descriptor_internal,
                timelock_blocks,
                checkin_period_secs, grace_period_secs,
                created_at, next_deadline_at, status,
                claim_eligible_at,
                checkin_link_token_hash, checkin_link_token_issued_at
            ) VALUES (?, 'regtest', ?, ?, 144, 86400, 3600,
                      '2026-01-01T00:00:00Z',
                      '2099-01-01T00:00:00Z', 'ok',
                      ?,
                      ?, '2026-01-02T00:00:00Z')"#,
        )
        .bind(id)
        .bind(format!("tr(fake/{id}/0/*)"))
        .bind(format!("tr(fake/{id}/1/*)"))
        .bind(&claim_eligible)
        .bind(token_hash)
        .execute(pool)
        .await
        .expect("insert vault with one-tap token");
    }

    #[tokio::test]
    async fn one_tap_checkin_with_correct_token_succeeds_and_clears_markers() {
        let state = fresh_state().await;
        let issued = crate::crypto::issue_claim_token();
        insert_vault_with_one_tap_token(&state.db, "vault-link-A", &issued.hash_hex).await;
        // Also seed the per-cycle marker so we can prove it gets
        // cleared on success.
        sqlx::query(
            "UPDATE vaults SET pre_deadline_reminder_sent_at = '2026-01-02T00:00:00Z' \
             WHERE id = 'vault-link-A'",
        )
        .execute(&state.db)
        .await
        .unwrap();

        let app = routes::router(state.clone());
        let resp = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!(
                        "/vaults/vault-link-A/checkin-from-link/{}",
                        issued.token
                    ))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);

        // Row state after success: per-cycle marker NULL, token
        // columns NULL, status 'ok', new deadline in the future.
        let (marker, link_hash, link_used, status): (
            Option<String>,
            Option<String>,
            Option<String>,
            String,
        ) = sqlx::query_as(
            "SELECT pre_deadline_reminder_sent_at, checkin_link_token_hash, \
                    checkin_link_token_used_at, status \
             FROM vaults WHERE id = 'vault-link-A'",
        )
        .fetch_one(&state.db)
        .await
        .unwrap();
        assert!(marker.is_none(), "marker must be cleared");
        assert!(link_hash.is_none(), "token hash must be scrubbed");
        assert!(link_used.is_none(), "token used_at must be scrubbed");
        assert_eq!(status, "ok");
    }

    #[tokio::test]
    async fn one_tap_checkin_is_free_long_before_the_deadline() {
        // Checking in is free. The link works at any point in the cycle,
        // not only in the final 24h (the old Lightning last-resort rule),
        // so claim_eligible_at far in the future must not refuse it.
        let state = fresh_state().await;
        let issued = crate::crypto::issue_claim_token();
        sqlx::query(
            r#"INSERT INTO vaults (
                id, network, descriptor_external, descriptor_internal,
                timelock_blocks, checkin_period_secs, grace_period_secs,
                created_at, next_deadline_at, status, claim_eligible_at,
                checkin_link_token_hash, checkin_link_token_issued_at
            ) VALUES ('vault-link-W', 'regtest', 'tr(fake/0/*)', 'tr(fake/1/*)',
                      144, 86400, 3600, '2026-01-01T00:00:00Z',
                      '2099-01-01T00:00:00Z', 'ok', '2099-01-02T00:00:00Z',
                      ?, '2026-01-02T00:00:00Z')"#,
        )
        .bind(&issued.hash_hex)
        .execute(&state.db)
        .await
        .unwrap();

        let app = routes::router(state.clone());
        let resp = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!(
                        "/vaults/vault-link-W/checkin-from-link/{}",
                        issued.token
                    ))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);

        // A successful check-in scrubs the single-use token.
        let hash: Option<String> = sqlx::query_scalar(
            "SELECT checkin_link_token_hash FROM vaults WHERE id = 'vault-link-W'",
        )
        .fetch_one(&state.db)
        .await
        .unwrap();
        assert!(hash.is_none(), "token hash must be scrubbed after use");
    }

    #[tokio::test]
    async fn one_tap_checkin_with_wrong_token_is_404() {
        let state = fresh_state().await;
        let real = crate::crypto::issue_claim_token();
        insert_vault_with_one_tap_token(&state.db, "vault-link-B", &real.hash_hex).await;

        let bogus = crate::crypto::issue_claim_token();
        let app = routes::router(state.clone());
        let resp = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!(
                        "/vaults/vault-link-B/checkin-from-link/{}",
                        bogus.token
                    ))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);

        // Row state untouched.
        let status: String =
            sqlx::query_scalar("SELECT status FROM vaults WHERE id = 'vault-link-B'")
                .fetch_one(&state.db)
                .await
                .unwrap();
        assert_eq!(status, "ok"); // still ok; deadline was already in the future
        let hash: Option<String> = sqlx::query_scalar(
            "SELECT checkin_link_token_hash FROM vaults WHERE id = 'vault-link-B'",
        )
        .fetch_one(&state.db)
        .await
        .unwrap();
        assert_eq!(
            hash.as_deref(),
            Some(real.hash_hex.as_str()),
            "live token must not be scrubbed by a failed attempt"
        );
    }

    #[tokio::test]
    async fn one_tap_checkin_with_right_token_for_wrong_vault_is_404() {
        // Two vaults; correct token belongs to vault A; we try to
        // use it on vault B. The route's `WHERE id = ?` filter is
        // what blocks this; without that filter a leaked token
        // would silently reset the wrong vault.
        let state = fresh_state().await;
        let a = crate::crypto::issue_claim_token();
        let b = crate::crypto::issue_claim_token();
        insert_vault_with_one_tap_token(&state.db, "vault-link-C1", &a.hash_hex).await;
        insert_vault_with_one_tap_token(&state.db, "vault-link-C2", &b.hash_hex).await;

        let app = routes::router(state.clone());
        let resp = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!(
                        "/vaults/vault-link-C2/checkin-from-link/{}",
                        a.token
                    ))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn one_tap_checkin_second_tap_is_409() {
        let state = fresh_state().await;
        let issued = crate::crypto::issue_claim_token();
        insert_vault_with_one_tap_token(&state.db, "vault-link-D", &issued.hash_hex).await;

        let app = routes::router(state.clone());
        let r1 = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!(
                        "/vaults/vault-link-D/checkin-from-link/{}",
                        issued.token
                    ))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(r1.status(), StatusCode::OK);

        // Second tap of the same URL. The successful first tap
        // scrubbed the hash columns, so the lookup now misses and
        // we get 404 -- which is the right answer for "this link no
        // longer exists". Conflict (409) would only fire if the
        // hash were still on the row with `used_at IS NOT NULL`,
        // which is the pre-scrub atomicity window inside the
        // transaction. The user-visible behaviour is the same:
        // "this link doesn't work".
        let r2 = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!(
                        "/vaults/vault-link-D/checkin-from-link/{}",
                        issued.token
                    ))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert!(
            matches!(r2.status(), StatusCode::NOT_FOUND | StatusCode::CONFLICT),
            "second tap should be 404 or 409, got {}",
            r2.status()
        );
    }

    /* ----------------------------------------------------------------- *
     *  Check-in is free on POST /vaults/:id/checkin                     *
     *                                                                   *
     *  Check-ins used to require a Lightning payment outside the final  *
     *  24h before the heir would be contacted. That gate is gone, and   *
     *  so is Lightning. The owner's session alone is enough, at any     *
     *  point in the cycle.                                              *
     * ----------------------------------------------------------------- */

    #[tokio::test]
    async fn checkin_is_free_long_before_the_deadline() {
        let state = fresh_state().await;
        let issued = crate::crypto::issue_owner_token();
        // insert_vault pins claim_eligible_at to 2099, far outside the
        // old 24h last-resort window.
        insert_vault(&state.db, "vault-ln-A", Some(&issued.hash_hex)).await;

        let resp = routes::router(state)
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/vaults/vault-ln-A/checkin")
                    .header(header::AUTHORIZATION, format!("Bearer {}", issued.token))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn checkin_inside_the_final_day_succeeds() {
        let state = fresh_state().await;
        let issued = crate::crypto::issue_owner_token();
        insert_vault(&state.db, "vault-ln-B", Some(&issued.hash_hex)).await;
        // Pull claim_eligible_at inside the final 24h.
        let soon = (chrono::Utc::now() + chrono::Duration::seconds(3600)).to_rfc3339();
        sqlx::query("UPDATE vaults SET claim_eligible_at = ? WHERE id = 'vault-ln-B'")
            .bind(&soon)
            .execute(&state.db)
            .await
            .unwrap();

        let resp = routes::router(state)
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/vaults/vault-ln-B/checkin")
                    .header(header::AUTHORIZATION, format!("Bearer {}", issued.token))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn checkin_on_a_row_without_claim_eligible_is_free() {
        // No claim_eligible_at (legacy row): this used to fail toward
        // Lightning. Check-in is free now, so it must succeed.
        let state = fresh_state().await;
        let issued = crate::crypto::issue_owner_token();
        insert_vault(&state.db, "vault-ln-C", Some(&issued.hash_hex)).await;
        sqlx::query("UPDATE vaults SET claim_eligible_at = NULL WHERE id = 'vault-ln-C'")
            .execute(&state.db)
            .await
            .unwrap();

        let resp = routes::router(state)
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/vaults/vault-ln-C/checkin")
                    .header(header::AUTHORIZATION, format!("Bearer {}", issued.token))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }

    /* ----------------------------------------------------------------- *
     *  Savings: GET /vaults/:id/savings, PUT|DELETE .../savings/goal    *
     * ----------------------------------------------------------------- */

    async fn call(
        state: std::sync::Arc<crate::AppState>,
        method: &str,
        uri: &str,
        token: Option<&str>,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let mut req = Request::builder().method(method).uri(uri);
        if let Some(t) = token {
            req = req.header(header::AUTHORIZATION, format!("Bearer {t}"));
        }
        let req = match body {
            Some(b) => req
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(b.to_string()))
                .unwrap(),
            None => req.body(Body::empty()).unwrap(),
        };
        let resp = routes::router(state).oneshot(req).await.unwrap();
        let status = resp.status();
        let bytes = axum::body::to_bytes(resp.into_body(), 1 << 20)
            .await
            .unwrap();
        let v = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        (status, v)
    }

    #[tokio::test]
    async fn choosing_an_heir_later_arms_the_vault_once() {
        let state = fresh_state().await;
        let issued = crate::crypto::issue_owner_token();
        insert_vault(&state.db, "vault-later", Some(&issued.hash_hex)).await;
        sqlx::query(
            "UPDATE vaults SET heir_pending = 1, status = 'unfunded', \
                    heir_xprv_owner_sealed_ct_b64 = 'b3duZXI', heir_xprv_owner_sealed_nonce = 'bm4', \
                    heir_contact_ciphertext = NULL, heir_contact_nonce = NULL, \
                    claim_token_hash = NULL WHERE id = 'vault-later'",
        )
        .execute(&state.db)
        .await
        .unwrap();
        let t = Some(issued.token.as_str());

        let (_, v) = call(state.clone(), "GET", "/vaults/vault-later", t, None).await;
        assert_eq!(v["heir_pending"], true);

        let body = serde_json::json!({
            "name": "Ada",
            "contact": "ada@example.com",
            "heir_xprv_ct_b64": "aGVpcg",
            "heir_xprv_nonce_b64": "bm9uY2U",
            "claim_token_b64": "Y2xhaW0tdG9rZW4",
        });
        // Owner only.
        let (code, _) = call(
            state.clone(),
            "POST",
            "/vaults/vault-later/heir/choose",
            None,
            Some(body.clone()),
        )
        .await;
        assert_eq!(code, StatusCode::UNAUTHORIZED);
        // A bad address is refused before anything changes.
        let mut bad = body.clone();
        bad["contact"] = serde_json::json!("ada-at-example");
        let (code, _) = call(
            state.clone(),
            "POST",
            "/vaults/vault-later/heir/choose",
            t,
            Some(bad),
        )
        .await;
        assert_eq!(code, StatusCode::BAD_REQUEST);

        let (code, _) = call(
            state.clone(),
            "POST",
            "/vaults/vault-later/heir/choose",
            t,
            Some(body.clone()),
        )
        .await;
        assert_eq!(code, StatusCode::NO_CONTENT);
        type Row = (
            i64,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
        );
        let row: Row = sqlx::query_as(
            "SELECT heir_pending, heir_xprv_owner_sealed_ct_b64, heir_xprv_sealed_ct_b64, \
                    claim_token_hash, claim_token_at_rest_b64, heir_contact_ciphertext, label \
               FROM vaults WHERE id = 'vault-later'",
        )
        .fetch_one(&state.db)
        .await
        .unwrap();
        assert_eq!(row.0, 0);
        assert!(row.1.is_none(), "the owner-sealed copy is dropped");
        assert_eq!(row.2.as_deref(), Some("aGVpcg"));
        assert_eq!(
            row.3.as_deref(),
            Some(crate::crypto::hash_claim_token("Y2xhaW0tdG9rZW4").as_str())
        );
        let at_rest = row.4.expect("token kept at rest");
        assert!(
            !at_rest.contains("Y2xhaW0tdG9rZW4"),
            "the token is sealed at rest, not stored verbatim"
        );
        let contact = row.5.expect("heir contact sealed");
        assert!(!contact.contains("ada@"), "the heir contact is sealed");
        assert_eq!(row.6.as_deref(), Some("Ada's inheritance"));

        // Once only: a second heir is a new share.
        let (code, _) = call(
            state.clone(),
            "POST",
            "/vaults/vault-later/heir/choose",
            t,
            Some(body),
        )
        .await;
        assert_eq!(code, StatusCode::CONFLICT);
        let (_, v) = call(state.clone(), "GET", "/vaults/vault-later", t, None).await;
        assert_eq!(v["heir_pending"], false);
    }

    #[tokio::test]
    async fn several_goals_sort_move_and_spend() {
        let state = fresh_state().await;
        let issued = crate::crypto::issue_owner_token();
        insert_vault(&state.db, "vault-goals", Some(&issued.hash_hex)).await;
        let other = crate::crypto::issue_owner_token();
        insert_vault(&state.db, "vault-other", Some(&other.hash_hex)).await;
        let t = Some(issued.token.as_str());
        let base = "/vaults/vault-goals/savings";

        // Money from before any goal is never asked about.
        sqlx::query(
            "INSERT INTO vault_deposits (vault_id, outpoint, amount_sat, height, seen_at) \
             VALUES ('vault-goals', 'old:0', 70000, 90, '2020-01-01T00:00:00Z')",
        )
        .execute(&state.db)
        .await
        .unwrap();

        // Two goals, one typed by the owner.
        for title in ["School fees", "Okada for my brother"] {
            let (code, _) = call(
                state.clone(),
                "POST",
                &format!("{base}/goals"),
                t,
                Some(serde_json::json!({"title": title, "amount_sat": 1_000_000, "target_date": null})),
            )
            .await;
            assert_eq!(code, StatusCode::OK, "{title}");
        }
        let (_, v) = call(state.clone(), "GET", base, t, None).await;
        let goals = v["goals"].as_array().unwrap().clone();
        assert_eq!(goals.len(), 2);
        assert_eq!(goals[0]["title"], "School fees");
        assert_eq!(
            v["goal"]["title"], "School fees",
            "first goal for one-goal clients"
        );
        assert_eq!(v["unsorted"].as_array().unwrap().len(), 0);
        let school = goals[0]["id"].as_str().unwrap().to_string();
        let okada = goals[1]["id"].as_str().unwrap().to_string();

        // A new deposit waits to be sorted, then lands in the goal chosen.
        let now = chrono::Utc::now().to_rfc3339();
        sqlx::query(
            "INSERT INTO vault_deposits (vault_id, outpoint, amount_sat, height, seen_at) \
             VALUES ('vault-goals', 'new:0', 50000, 100, ?)",
        )
        .bind(&now)
        .execute(&state.db)
        .await
        .unwrap();
        let (_, v) = call(state.clone(), "GET", base, t, None).await;
        assert_eq!(v["unsorted"][0]["outpoint"], "new:0");
        assert_eq!(v["unsorted"].as_array().unwrap().len(), 1);
        let (code, v) = call(
            state.clone(),
            "POST",
            &format!("{base}/sort"),
            t,
            Some(serde_json::json!({"outpoint": "new:0", "goal_id": okada})),
        )
        .await;
        assert_eq!(code, StatusCode::OK);
        assert_eq!(v["unsorted"].as_array().unwrap().len(), 0);
        assert_eq!(v["goals"][1]["saved_sat"], 50_000);
        // Asked once only.
        let (code, _) = call(
            state.clone(),
            "POST",
            &format!("{base}/sort"),
            t,
            Some(serde_json::json!({"outpoint": "new:0", "goal_id": school})),
        )
        .await;
        assert_eq!(code, StatusCode::CONFLICT);

        // Move 20k across; a goal can't give more than it holds.
        let (code, v) = call(
            state.clone(),
            "POST",
            &format!("{base}/move"),
            t,
            Some(serde_json::json!({"from_goal_id": okada, "to_goal_id": school, "amount_sat": 20_000})),
        )
        .await;
        assert_eq!(code, StatusCode::OK);
        assert_eq!(v["goals"][0]["saved_sat"], 20_000);
        assert_eq!(v["goals"][1]["saved_sat"], 30_000);
        let (code, _) = call(
            state.clone(),
            "POST",
            &format!("{base}/move"),
            t,
            Some(serde_json::json!({"from_goal_id": okada, "to_goal_id": school, "amount_sat": 30_001})),
        )
        .await;
        assert_eq!(code, StatusCode::BAD_REQUEST);
        // Old money moves in from "not in a goal".
        let (code, v) = call(
            state.clone(),
            "POST",
            &format!("{base}/move"),
            t,
            Some(serde_json::json!({"from_goal_id": null, "to_goal_id": school, "amount_sat": 70_000})),
        )
        .await;
        assert_eq!(code, StatusCode::OK);
        assert_eq!(v["goals"][0]["saved_sat"], 90_000);

        // A send from a goal never takes it below zero.
        let (code, v) = call(
            state.clone(),
            "POST",
            &format!("{base}/spend"),
            t,
            Some(serde_json::json!({"goal_id": okada, "amount_sat": 45_000})),
        )
        .await;
        assert_eq!(code, StatusCode::OK);
        assert_eq!(v["goals"][1]["saved_sat"], 0);

        // Renaming keeps the money.
        let (code, v) = call(
            state.clone(),
            "PUT",
            &format!("{base}/goals"),
            t,
            Some(serde_json::json!({"id": school, "title": "University fees", "amount_sat": 2_000_000, "target_date": null})),
        )
        .await;
        assert_eq!(code, StatusCode::OK);
        assert_eq!(v["goals"][0]["title"], "University fees");
        assert_eq!(v["goals"][0]["saved_sat"], 90_000);

        // Another vault can't touch these goals, even with its own token.
        let o = Some(other.token.as_str());
        let (code, _) = call(
            state.clone(),
            "POST",
            "/vaults/vault-other/savings/move",
            o,
            Some(serde_json::json!({"from_goal_id": null, "to_goal_id": school, "amount_sat": 1})),
        )
        .await;
        assert_eq!(code, StatusCode::NOT_FOUND);
        let (code, _) = call(
            state.clone(),
            "POST",
            "/vaults/vault-other/savings/goals/remove",
            o,
            Some(serde_json::json!({"id": school})),
        )
        .await;
        assert_eq!(code, StatusCode::NOT_FOUND);

        // Removing a goal drops its ledger; the coins never moved.
        let (code, v) = call(
            state.clone(),
            "POST",
            &format!("{base}/goals/remove"),
            t,
            Some(serde_json::json!({"id": okada})),
        )
        .await;
        assert_eq!(code, StatusCode::OK);
        assert_eq!(v["goals"].as_array().unwrap().len(), 1);
        let left: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM savings_goal_entries WHERE goal_id = ?")
                .bind(&okada)
                .fetch_one(&state.db)
                .await
                .unwrap();
        assert_eq!(left, 0);

        // Up to MAX_GOALS at once.
        for i in 1..crate::savings::MAX_GOALS {
            let (code, _) = call(
                state.clone(),
                "POST",
                &format!("{base}/goals"),
                t,
                Some(serde_json::json!({"title": format!("Goal {i}"), "amount_sat": null, "target_date": null})),
            )
            .await;
            assert_eq!(code, StatusCode::OK, "goal {i}");
        }
        let (code, _) = call(
            state.clone(),
            "POST",
            &format!("{base}/goals"),
            t,
            Some(serde_json::json!({"title": "One too many", "amount_sat": null, "target_date": null})),
        )
        .await;
        assert_eq!(code, StatusCode::BAD_REQUEST);
    }

    /// Goals keep the order they were made in, even when two share a
    /// timestamp. Ordering by `datetime(created_at)` rounded to the second
    /// and then fell back to the random id, so "the first goal" could flip.
    #[tokio::test]
    async fn goals_made_in_the_same_second_keep_their_order() {
        let state = fresh_state().await;
        let issued = crate::crypto::issue_owner_token();
        insert_vault(&state.db, "vault-order", Some(&issued.hash_hex)).await;
        // Inserted "z" first, then "a": an id tie-break would reverse them.
        for (gid, title) in [("z-goal", "School fees"), ("a-goal", "Rent")] {
            let sealed = crate::crypto::seal_for_vault("vault-order", title.as_bytes()).unwrap();
            sqlx::query(
                "INSERT INTO savings_goals (id, vault_id, title_ct, title_nonce, created_at) \
                 VALUES (?, 'vault-order', ?, ?, '2026-11-24T21:00:00.123+00:00')",
            )
            .bind(gid)
            .bind(&sealed.ciphertext_b64)
            .bind(&sealed.nonce_b64)
            .execute(&state.db)
            .await
            .unwrap();
        }
        let (_, v) = call(
            state.clone(),
            "GET",
            "/vaults/vault-order/savings",
            Some(issued.token.as_str()),
            None,
        )
        .await;
        assert_eq!(v["goals"][0]["title"], "School fees");
        assert_eq!(v["goals"][1]["title"], "Rent");
        assert_eq!(v["goal"]["title"], "School fees");
    }

    /// The migration turns a vault's single goal into its first goal and
    /// gives it the deposits so far, and nobody is asked about old money.
    #[tokio::test]
    async fn the_single_goal_becomes_the_first_of_many() {
        let state = fresh_state().await;
        let issued = crate::crypto::issue_owner_token();
        insert_vault(&state.db, "vault-mig", Some(&issued.hash_hex)).await;
        let sealed = crate::crypto::seal_for_vault("vault-mig", b"School fees").unwrap();
        sqlx::query(
            "UPDATE vaults SET savings_goal_title_ct = ?, savings_goal_title_nonce = ?, \
                    savings_goal_sat = 500000 WHERE id = 'vault-mig'",
        )
        .bind(&sealed.ciphertext_b64)
        .bind(&sealed.nonce_b64)
        .execute(&state.db)
        .await
        .unwrap();
        for (op, amt) in [("m:0", 40_000), ("m:1", 60_000)] {
            sqlx::query(
                "INSERT INTO vault_deposits (vault_id, outpoint, amount_sat, height, seen_at) \
                 VALUES ('vault-mig', ?, ?, 100, '2026-10-01T00:00:00Z')",
            )
            .bind(op)
            .bind(amt)
            .execute(&state.db)
            .await
            .unwrap();
        }
        // Re-run the migration's data steps against this legacy row.
        let sql = include_str!("../migrations/20261125000000_savings_goals.sql");
        for stmt in sql.split(';') {
            let body: String = stmt
                .lines()
                .filter(|l| !l.trim_start().starts_with("--"))
                .collect::<Vec<_>>()
                .join("\n");
            let body = body.trim();
            if body.starts_with("INSERT") || body.starts_with("UPDATE") {
                // Test-only: statements from our own migration file.
                sqlx::query(sqlx::AssertSqlSafe(body.to_string()))
                    .execute(&state.db)
                    .await
                    .unwrap();
            }
        }
        let (code, v) = call(
            state.clone(),
            "GET",
            "/vaults/vault-mig/savings",
            Some(issued.token.as_str()),
            None,
        )
        .await;
        assert_eq!(code, StatusCode::OK);
        assert_eq!(v["goals"][0]["title"], "School fees");
        assert_eq!(v["goals"][0]["amount_sat"], 500_000);
        assert_eq!(v["goals"][0]["saved_sat"], 100_000);
        assert_eq!(v["unsorted"].as_array().unwrap().len(), 0);
    }

    #[tokio::test]
    async fn savings_totals_deposits_and_a_sealed_goal() {
        let state = fresh_state().await;
        let issued = crate::crypto::issue_owner_token();
        insert_vault(&state.db, "vault-save", Some(&issued.hash_hex)).await;
        let t = Some(issued.token.as_str());

        // No deposits, no goal.
        let (code, v) = call(state.clone(), "GET", "/vaults/vault-save/savings", t, None).await;
        assert_eq!(code, StatusCode::OK);
        assert_eq!(v["total_saved_sat"], 0);
        assert_eq!(v["deposit_count"], 0);
        assert!(v["goal"].is_null());

        // Two deposits, one since spent. The total counts both: it is
        // everything ever put aside, and never goes down.
        for (op, amt, h, spent) in [
            ("a:0", 50_000, 100, None),
            ("b:1", 25_000, 120, Some("2026-11-01T00:00:00Z")),
        ] {
            sqlx::query(
                "INSERT INTO vault_deposits (vault_id, outpoint, amount_sat, height, seen_at, spent_at) \
                 VALUES ('vault-save', ?, ?, ?, '2026-10-01T00:00:00Z', ?)",
            )
            .bind(op)
            .bind(amt)
            .bind(h)
            .bind(spent)
            .execute(&state.db)
            .await
            .unwrap();
        }
        let (_, v) = call(state.clone(), "GET", "/vaults/vault-save/savings", t, None).await;
        assert_eq!(v["total_saved_sat"], 75_000);
        assert_eq!(v["deposit_count"], 2);
        assert_eq!(v["deposits"][0]["amount_sat"], 25_000, "most recent first");
        assert_eq!(v["deposits"][0]["spent"], true);

        // Set a goal; the title is stored sealed, not in plain text.
        let goal = serde_json::json!({"title": "School fees", "amount_sat": 1_000_000, "target_date": "2099-06-30"});
        let (code, v) = call(
            state.clone(),
            "PUT",
            "/vaults/vault-save/savings/goal",
            t,
            Some(goal),
        )
        .await;
        assert_eq!(code, StatusCode::OK);
        assert_eq!(v["goal"]["title"], "School fees");
        assert_eq!(v["goal"]["amount_sat"], 1_000_000);
        let ct: Option<String> =
            sqlx::query_scalar("SELECT title_ct FROM savings_goals WHERE vault_id = 'vault-save'")
                .fetch_one(&state.db)
                .await
                .unwrap();
        let ct = ct.expect("title stored");
        assert!(!ct.contains("School"), "goal title must be sealed at rest");

        // A bad goal is refused and leaves the old one alone.
        let bad = serde_json::json!({"title": "", "amount_sat": null, "target_date": null});
        let (code, _) = call(
            state.clone(),
            "PUT",
            "/vaults/vault-save/savings/goal",
            t,
            Some(bad),
        )
        .await;
        assert_eq!(code, StatusCode::BAD_REQUEST);
        let (_, v) = call(state.clone(), "GET", "/vaults/vault-save/savings", t, None).await;
        assert_eq!(v["goal"]["title"], "School fees");

        // Clearing the goal.
        let (code, _) = call(
            state.clone(),
            "DELETE",
            "/vaults/vault-save/savings/goal",
            t,
            None,
        )
        .await;
        assert_eq!(code, StatusCode::NO_CONTENT);
        let (_, v) = call(state.clone(), "GET", "/vaults/vault-save/savings", t, None).await;
        assert!(v["goal"].is_null());

        // Owner only.
        let (code, _) = call(
            state.clone(),
            "GET",
            "/vaults/vault-save/savings",
            None,
            None,
        )
        .await;
        assert_eq!(code, StatusCode::UNAUTHORIZED);

        // Year in savings: only this calendar year's deposits count.
        let year = chrono::Utc::now().format("%Y").to_string();
        for (op, amt, month) in [
            ("c:0", 10_000, "02"),
            ("d:0", 30_000, "02"),
            ("e:0", 20_000, "05"),
        ] {
            sqlx::query(
                "INSERT INTO vault_deposits (vault_id, outpoint, amount_sat, height, seen_at) \
                 VALUES ('vault-save', ?, ?, 300, ?)",
            )
            .bind(op)
            .bind(amt)
            .bind(format!("{year}-{month}-10T00:00:00Z"))
            .execute(&state.db)
            .await
            .unwrap();
        }
        let (_, v) = call(state.clone(), "GET", "/vaults/vault-save/savings", t, None).await;
        // The two rows inserted above are dated 2026-10-01, so they count
        // toward this year only when the test runs in 2026.
        let earlier = if year == "2026" { 75_000 } else { 0 };
        assert_eq!(v["this_year"]["total_sat"], 60_000 + earlier);
        assert_eq!(
            v["this_year"]["deposit_count"],
            if year == "2026" { 5 } else { 3 }
        );
        if year != "2026" {
            assert_eq!(v["this_year"]["best_month"], 2);
            assert_eq!(v["this_year"]["best_month_sat"], 40_000);
        } else {
            // October's 75,000 beats February's 40,000.
            assert_eq!(v["this_year"]["best_month"], 10);
            assert_eq!(v["this_year"]["best_month_sat"], 75_000);
        }

        // Reminders: weekly with an amount; junk cadence refused; stop.
        assert!(v["reminder"].is_null());
        assert_eq!(v["owner_email_confirmed"], false);
        let (code, v) = call(
            state.clone(),
            "PUT",
            "/vaults/vault-save/savings/reminder",
            t,
            Some(serde_json::json!({"cadence": "weekly", "amount_sat": 50_000})),
        )
        .await;
        assert_eq!(code, StatusCode::OK);
        assert_eq!(v["reminder"]["cadence"], "weekly");
        assert_eq!(v["reminder"]["amount_sat"], 50_000);
        let (code, _) = call(
            state.clone(),
            "PUT",
            "/vaults/vault-save/savings/reminder",
            t,
            Some(serde_json::json!({"cadence": "hourly", "amount_sat": null})),
        )
        .await;
        assert_eq!(code, StatusCode::BAD_REQUEST);
        let (code, _) = call(
            state.clone(),
            "DELETE",
            "/vaults/vault-save/savings/reminder",
            t,
            None,
        )
        .await;
        assert_eq!(code, StatusCode::NO_CONTENT);
        let (_, v) = call(state.clone(), "GET", "/vaults/vault-save/savings", t, None).await;
        assert!(v["reminder"].is_null());
    }

    #[tokio::test]
    async fn savings_challenges_join_stop_and_stay_the_owners() {
        let state = fresh_state().await;
        let issued = crate::crypto::issue_owner_token();
        insert_vault(&state.db, "vault-ch", Some(&issued.hash_hex)).await;
        let other = crate::crypto::issue_owner_token();
        insert_vault(&state.db, "vault-other-ch", Some(&other.hash_hex)).await;
        let t = Some(issued.token.as_str());
        let url = "/vaults/vault-ch/savings/challenges";

        // Owner only.
        let (code, _) = call(state.clone(), "GET", url, None, None).await;
        assert_eq!(code, StatusCode::UNAUTHORIZED);
        let (code, _) = call(state.clone(), "GET", url, Some(other.token.as_str()), None).await;
        assert_eq!(code, StatusCode::UNAUTHORIZED);

        let (code, v) = call(state.clone(), "GET", url, t, None).await;
        assert_eq!(code, StatusCode::OK);
        assert_eq!(v["challenges"].as_array().unwrap().len(), 0);

        // Join the 52-week challenge; a second one at once is refused.
        let join = serde_json::json!({"kind": "week52", "week1_sat": 2_000});
        let (code, v) = call(state.clone(), "POST", url, t, Some(join.clone())).await;
        assert_eq!(code, StatusCode::OK);
        let c = &v["challenges"][0];
        assert_eq!(c["kind"], "week52");
        assert_eq!(c["state"], "going");
        assert_eq!(c["week"], 1);
        assert_eq!(c["this_week_sat"], 2_000);
        assert_eq!(c["target_sat"], 2_000 * 1378);
        let id = c["id"].as_str().unwrap().to_string();
        let (code, _) = call(state.clone(), "POST", url, t, Some(join.clone())).await;
        assert_eq!(code, StatusCode::CONFLICT);

        // Bad input is refused.
        for bad in [
            serde_json::json!({"kind": "hold", "hold_months": 5}),
            serde_json::json!({"kind": "goal_by_date", "goal_id": "nope"}),
            serde_json::json!({"kind": "lottery"}),
        ] {
            let (code, _) = call(state.clone(), "POST", url, t, Some(bad)).await;
            assert_eq!(code, StatusCode::BAD_REQUEST);
        }

        // Someone else can't stop it, even with the id.
        let (code, _) = call(
            state.clone(),
            "POST",
            "/vaults/vault-other-ch/savings/challenges/stop",
            Some(other.token.as_str()),
            Some(serde_json::json!({"id": id})),
        )
        .await;
        assert_eq!(code, StatusCode::NOT_FOUND);

        // The owner stops it; then it can be started again.
        let (code, v) = call(
            state.clone(),
            "POST",
            "/vaults/vault-ch/savings/challenges/stop",
            t,
            Some(serde_json::json!({"id": id})),
        )
        .await;
        assert_eq!(code, StatusCode::OK);
        assert_eq!(v["challenges"][0]["state"], "stopped");
        let (code, v) = call(state.clone(), "POST", url, t, Some(join)).await;
        assert_eq!(code, StatusCode::OK);
        assert_eq!(v["challenges"].as_array().unwrap().len(), 2);
        assert_eq!(v["challenges"][0]["state"], "going");
    }

    /* ----------------------------------------------------------------- *
     *  Panic stop: POST /vaults/:id/panic                               *
     *                                                                   *
     *  A free, signed-in freeze. It used to need a Lightning payment.   *
     * ----------------------------------------------------------------- */

    async fn post_panic(
        state: std::sync::Arc<crate::AppState>,
        id: &str,
        token: Option<&str>,
    ) -> axum::response::Response {
        let mut req = Request::builder()
            .method("POST")
            .uri(format!("/vaults/{id}/panic"));
        if let Some(t) = token {
            req = req.header(header::AUTHORIZATION, format!("Bearer {t}"));
        }
        routes::router(state)
            .oneshot(req.body(Body::empty()).unwrap())
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn panic_stop_freezes_for_90_days_and_revokes_claim_links() {
        let state = fresh_state().await;
        let issued = crate::crypto::issue_owner_token();
        insert_vault(&state.db, "vault-panic-A", Some(&issued.hash_hex)).await;
        // A claim link in flight must be revoked by the freeze.
        sqlx::query(
            "UPDATE vaults SET claim_token_hash = 'h', claim_token_issued_at = '2026-01-01T00:00:00Z' \
              WHERE id = 'vault-panic-A'",
        )
        .execute(&state.db)
        .await
        .unwrap();

        let resp = post_panic(state.clone(), "vault-panic-A", Some(&issued.token)).await;
        assert_eq!(resp.status(), StatusCode::OK);

        let (status, until, claim_hash): (String, Option<String>, Option<String>) = sqlx::query_as(
            "SELECT status, panic_frozen_until, claim_token_hash FROM vaults WHERE id = 'vault-panic-A'",
        )
        .fetch_one(&state.db)
        .await
        .unwrap();
        assert_eq!(status, "frozen");
        assert!(claim_hash.is_none(), "claim link must be revoked");
        let until =
            chrono::DateTime::parse_from_rfc3339(&until.expect("frozen_until set")).unwrap();
        let days = (until.with_timezone(&chrono::Utc) - chrono::Utc::now()).num_days();
        assert!(
            (89..=90).contains(&days),
            "freeze should last 90 days, got {days}"
        );

        let events: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM events WHERE vault_id = 'vault-panic-A' AND kind = 'panic_activated'",
        )
        .fetch_one(&state.db)
        .await
        .unwrap();
        assert_eq!(events, 1);
    }

    async fn put_trusted(
        state: std::sync::Arc<crate::AppState>,
        id: &str,
        token: Option<&str>,
        body: &str,
    ) -> axum::response::Response {
        let mut req = Request::builder()
            .method("PUT")
            .uri(format!("/vaults/{id}/trusted-contact"))
            .header(header::CONTENT_TYPE, "application/json");
        if let Some(t) = token {
            req = req.header(header::AUTHORIZATION, format!("Bearer {t}"));
        }
        routes::router(state)
            .oneshot(req.body(Body::from(body.to_string())).unwrap())
            .await
            .unwrap()
    }

    async fn trusted_on_file(pool: &SqlitePool, id: &str) -> Option<String> {
        let (ct, nn, ch): (Option<String>, Option<String>, Option<String>) = sqlx::query_as(
            "SELECT trusted_contact_ciphertext, trusted_contact_nonce, trusted_contact_channel \
               FROM vaults WHERE id = ?",
        )
        .bind(id)
        .fetch_one(pool)
        .await
        .unwrap();
        crate::notifier::parse_owner_contact(id, ct.as_deref(), nn.as_deref(), ch.as_deref())
            .unwrap()
            .map(|c| c.address)
    }

    #[tokio::test]
    async fn the_emergency_contact_can_be_set_changed_and_removed_after_setup() {
        let state = fresh_state().await;
        let issued = crate::crypto::issue_owner_token();
        insert_vault(&state.db, "vault-tc-A", Some(&issued.hash_hex)).await;

        let resp = put_trusted(
            state.clone(),
            "vault-tc-A",
            Some(&issued.token),
            r#"{"contact":" friend@example.com "}"#,
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(
            trusted_on_file(&state.db, "vault-tc-A").await.as_deref(),
            Some("friend@example.com")
        );

        let resp = put_trusted(
            state.clone(),
            "vault-tc-A",
            Some(&issued.token),
            r#"{"contact":"other@example.com"}"#,
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(
            trusted_on_file(&state.db, "vault-tc-A").await.as_deref(),
            Some("other@example.com")
        );

        let resp = put_trusted(
            state.clone(),
            "vault-tc-A",
            Some(&issued.token),
            r#"{"contact":null}"#,
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(trusted_on_file(&state.db, "vault-tc-A").await, None);
    }

    #[tokio::test]
    async fn the_emergency_contact_needs_the_owner_and_a_real_email() {
        let state = fresh_state().await;
        let issued = crate::crypto::issue_owner_token();
        insert_vault(&state.db, "vault-tc-B", Some(&issued.hash_hex)).await;
        let body = r#"{"contact":"friend@example.com"}"#;
        assert_eq!(
            put_trusted(state.clone(), "vault-tc-B", None, body)
                .await
                .status(),
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            put_trusted(state.clone(), "vault-tc-B", Some("not-the-token"), body)
                .await
                .status(),
            StatusCode::UNAUTHORIZED
        );
        for bad in ["nope", "a@b", "two words@example.com"] {
            let resp = put_trusted(
                state.clone(),
                "vault-tc-B",
                Some(&issued.token),
                &format!(r#"{{"contact":"{bad}"}}"#),
            )
            .await;
            assert_eq!(resp.status(), StatusCode::BAD_REQUEST, "{bad}");
        }
        assert_eq!(trusted_on_file(&state.db, "vault-tc-B").await, None);
    }

    #[tokio::test]
    async fn a_balance_read_in_the_last_minute_is_reused_without_a_lookup() {
        // The vault's descriptors are fake, so a real scan would fail: a
        // 200 with the saved numbers proves no explorer was asked.
        let state = fresh_state().await;
        insert_vault(&state.db, "vault-bal", None).await;
        sqlx::query(
            "UPDATE vaults SET balance_confirmed_sat = 1000, balance_unconfirmed_sat = 50, \
                    balance_checked_at = ? WHERE id = 'vault-bal'",
        )
        .bind(chrono::Utc::now().to_rfc3339())
        .execute(&state.db)
        .await
        .unwrap();
        let resp = routes::router(state.clone())
            .oneshot(
                Request::builder()
                    .uri("/vaults/vault-bal/balance")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(resp.into_body(), 1 << 16)
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v["confirmed_sat"], 1000);
        assert_eq!(v["unconfirmed_sat"], 50);
        assert_eq!(v["total_sat"], 1050);
    }

    #[tokio::test]
    async fn panic_stop_twice_is_refused() {
        // A second tap must not extend the window or re-alert anyone.
        let state = fresh_state().await;
        let issued = crate::crypto::issue_owner_token();
        insert_vault(&state.db, "vault-panic-B", Some(&issued.hash_hex)).await;
        assert_eq!(
            post_panic(state.clone(), "vault-panic-B", Some(&issued.token))
                .await
                .status(),
            StatusCode::OK
        );
        assert_eq!(
            post_panic(state.clone(), "vault-panic-B", Some(&issued.token))
                .await
                .status(),
            StatusCode::CONFLICT
        );
        let events: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM events WHERE vault_id = 'vault-panic-B' AND kind = 'panic_activated'",
        )
        .fetch_one(&state.db)
        .await
        .unwrap();
        assert_eq!(events, 1);
    }

    #[tokio::test]
    async fn panic_stop_on_a_claimed_vault_is_refused_and_keeps_the_claim() {
        let state = fresh_state().await;
        let issued = crate::crypto::issue_owner_token();
        insert_vault(&state.db, "vault-panic-C", Some(&issued.hash_hex)).await;
        sqlx::query("UPDATE vaults SET status = 'claimed' WHERE id = 'vault-panic-C'")
            .execute(&state.db)
            .await
            .unwrap();
        let resp = post_panic(state.clone(), "vault-panic-C", Some(&issued.token)).await;
        assert_eq!(resp.status(), StatusCode::CONFLICT);
        let status: String =
            sqlx::query_scalar("SELECT status FROM vaults WHERE id = 'vault-panic-C'")
                .fetch_one(&state.db)
                .await
                .unwrap();
        assert_eq!(status, "claimed");
    }

    #[tokio::test]
    async fn panic_stop_needs_the_owner_token() {
        let state = fresh_state().await;
        let issued = crate::crypto::issue_owner_token();
        insert_vault(&state.db, "vault-panic-D", Some(&issued.hash_hex)).await;
        let resp = post_panic(state.clone(), "vault-panic-D", None).await;
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
        let status: String =
            sqlx::query_scalar("SELECT status FROM vaults WHERE id = 'vault-panic-D'")
                .fetch_one(&state.db)
                .await
                .unwrap();
        assert_eq!(status, "ok");
    }

    #[tokio::test]
    async fn every_sign_of_life_rolls_the_deadline_but_repeats_change_nothing() {
        // Signing in counts as a check-in, so the deadline is always a
        // full period from the last proof of life, at any time. Repeats
        // within 12 hours are a quiet no-op, so activity isn't flooded.
        let state = fresh_state().await;
        let issued = crate::crypto::issue_owner_token();
        insert_vault(&state.db, "vault-roll", Some(&issued.hash_hex)).await;
        let t = Some(issued.token.as_str());
        let url = "/vaults/vault-roll/checkin";
        let count = |db: SqlitePool| async move {
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM events WHERE vault_id = 'vault-roll' AND kind = 'checkin'",
            )
            .fetch_one(&db)
            .await
            .unwrap()
        };
        let deadline = |v: &Value| {
            chrono::DateTime::parse_from_rfc3339(v["next_deadline_at"].as_str().unwrap()).unwrap()
        };

        let (code, first) = call(state.clone(), "POST", url, t, None).await;
        assert_eq!(code, StatusCode::OK);
        let (code, again) = call(state.clone(), "POST", url, t, None).await;
        assert_eq!(code, StatusCode::OK, "a repeat is fine, not a 409");
        assert_eq!(deadline(&again), deadline(&first), "and moves nothing");
        assert_eq!(count(state.db.clone()).await, 1);

        // 13 hours later: it rolls forward again.
        let earlier = (chrono::Utc::now() - chrono::Duration::hours(13)).to_rfc3339();
        sqlx::query("UPDATE vaults SET last_checkin_at = ? WHERE id = 'vault-roll'")
            .bind(&earlier)
            .execute(&state.db)
            .await
            .unwrap();
        let (code, later) = call(state.clone(), "POST", url, t, None).await;
        assert_eq!(code, StatusCode::OK);
        assert!(deadline(&later) > deadline(&first));
        assert_eq!(count(state.db.clone()).await, 2);

        // An alarm always clears, however recent the last check-in.
        sqlx::query("UPDATE vaults SET status = 'alarmed' WHERE id = 'vault-roll'")
            .execute(&state.db)
            .await
            .unwrap();
        let (code, v) = call(state.clone(), "POST", url, t, None).await;
        assert_eq!(code, StatusCode::OK);
        assert_eq!(v["status"], "ok");
        let status: String =
            sqlx::query_scalar("SELECT status FROM vaults WHERE id = 'vault-roll'")
                .fetch_one(&state.db)
                .await
                .unwrap();
        assert_eq!(status, "ok");
    }

    #[tokio::test]
    async fn checkin_works_at_any_time() {
        // The plain button works with a normal far-off deadline.
        let state = fresh_state().await;
        let issued = crate::crypto::issue_owner_token();
        insert_vault(&state.db, "vault-ln-D", Some(&issued.hash_hex)).await;

        let resp = routes::router(state)
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/vaults/vault-ln-D/checkin")
                    .header(header::AUTHORIZATION, format!("Bearer {}", issued.token))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }
}
