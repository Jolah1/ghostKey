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
        // SAFETY: tests run in a single process; clear+restore is fine.
        unsafe { std::env::remove_var("GHOSTKEY_ALLOWED_ORIGINS") };
        let v = cors_allowed_origins();
        assert!(v.contains(&"http://localhost:5173".to_string()));
        assert!(v.contains(&"http://127.0.0.1:5173".to_string()));
    }

    #[test]
    fn cors_allowed_origins_parses_csv() {
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
        std::sync::Arc::new(crate::AppState {
            db: pool,
            lightning: std::sync::Arc::new(crate::lightning::NoopProvider),
        })
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
    }
}
