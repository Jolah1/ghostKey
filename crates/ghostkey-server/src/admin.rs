//! Operator-only read endpoints, gated by `AdminAuth`.
//!
//!   GET /admin/newsletter  -> the decrypted subscriber list
//!   GET /admin/analytics   -> last-30-day aggregate event counts
//!
//! Both require the admin bearer token (its SHA-256 must match
//! `GHOSTKEY_ADMIN_TOKEN_HASH`). With no admin token configured,
//! `AdminAuth` rejects every request, so these endpoints are closed by
//! default — see `auth.rs`.
//!
//! These are deliberately read-only. The newsletter addresses are
//! sealed at rest, so this handler is the one place they're decrypted;
//! keep it behind the admin token and off any public surface.

use std::sync::Arc;

use axum::extract::{Query, State};
use axum::Json;
use serde::{Deserialize, Serialize};

use crate::auth::AdminAuth;
use crate::routes::ApiError;
use crate::AppState;

/// One newsletter subscriber, decrypted for the operator.
#[derive(Debug, Serialize)]
pub struct SubscriberView {
    pub email: String,
    /// Which CTA/page the signup came from, if recorded.
    pub source: Option<String>,
    pub created_at: String,
}

/// GET /admin/newsletter — every subscriber, newest first, decrypted.
pub async fn list_newsletter(
    _admin: AdminAuth,
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<SubscriberView>>, ApiError> {
    let rows = sqlx::query_as::<_, (String, String, Option<String>, String)>(
        "SELECT email_ciphertext, email_nonce, source, created_at \
           FROM newsletter_subscribers ORDER BY created_at DESC",
    )
    .fetch_all(&state.db)
    .await?;

    let out = rows
        .into_iter()
        .map(|(ciphertext_b64, nonce_b64, source, created_at)| {
            // Context stays "waitlist" (see newsletter.rs): it's the
            // fixed key-derivation label every row was sealed under. A
            // row we can't open is surfaced, not silently dropped, so
            // the operator notices a key/data mismatch.
            let email = crate::crypto::open_for_vault(
                "waitlist",
                &crate::crypto::SealedContact {
                    ciphertext_b64,
                    nonce_b64,
                },
            )
            .ok()
            .and_then(|b| String::from_utf8(b).ok())
            .unwrap_or_else(|| "<undecryptable>".to_string());
            SubscriberView {
                email,
                source,
                created_at,
            }
        })
        .collect();

    Ok(Json(out))
}

/// One aggregate analytics bucket: a per-day count for an event/label.
#[derive(Debug, Serialize)]
pub struct AnalyticsRow {
    pub day: String,
    pub event_name: String,
    pub label: String,
    pub count: i64,
}

/// GET /admin/analytics — aggregate counts for the last 30 days.
///
/// This is the by-hand query the analytics migration documents, wrapped
/// behind the admin token. Still aggregate-only: no per-visitor rows
/// exist to return.
pub async fn analytics_summary(
    _admin: AdminAuth,
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<AnalyticsRow>>, ApiError> {
    let rows = sqlx::query_as::<_, (String, String, String, i64)>(
        "SELECT day, event_name, label, count \
           FROM analytics_events \
          WHERE day >= date('now', '-30 days') \
          ORDER BY day DESC, event_name, label",
    )
    .fetch_all(&state.db)
    .await?;

    let out = rows
        .into_iter()
        .map(|(day, event_name, label, count)| AnalyticsRow {
            day,
            event_name,
            label,
            count,
        })
        .collect();

    Ok(Json(out))
}

#[derive(Debug, Deserialize)]
pub struct VerifyAddressParams {
    pub address: String,
}

/// Result of an operator address check.
///
/// `matched` is the only field you strictly need: true means this address
/// derives from a vault this server actually created, so it's safe to fund
/// as part of a testing program. The rest are context (which vault, its
/// status, and which keychain the address came from).
#[derive(Debug, Serialize)]
pub struct VerifyAddressResult {
    pub matched: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vault_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub network: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    /// "external" (a receive/funding address — what a tester would send
    /// you) or "internal" (change). A funding applicant is always external.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub keychain: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub index: Option<u32>,
}

/// GET /admin/verify-address?address=bc1p... — is this address one of ours?
///
/// You can't tell from an address alone that it belongs to a GhostKey
/// vault (an address is just a hash). But this server created and stores
/// every real vault, so it can answer authoritatively: it re-derives each
/// vault's first `GAP` addresses on both keychains and reports whether the
/// given one matches. Built for the founding-user funding program — paste
/// an address someone DM'd you and get a definitive yes/no before funding.
///
/// Admin-gated, and read-only: it derives from public descriptors only,
/// touches no key material, and mutates nothing.
pub async fn verify_address(
    _admin: AdminAuth,
    State(state): State<Arc<AppState>>,
    Query(params): Query<VerifyAddressParams>,
) -> Result<Json<VerifyAddressResult>, ApiError> {
    let target = params.address.trim();
    if target.is_empty() {
        return Err(ApiError::Validation(
            "address query parameter is required".into(),
        ));
    }

    // A tester funds address #0, but revealing a few per keychain covers
    // anyone who tapped "new address" a handful of times before funding.
    const GAP: u32 = 20;

    let rows = sqlx::query_as::<_, (String, String, String, String, i64, String)>(
        "SELECT id, network, descriptor_external, descriptor_internal, \
                timelock_blocks, status \
           FROM vaults",
    )
    .fetch_all(&state.db)
    .await?;

    for (id, network_str, ext, int_, timelock, status) in rows {
        // A vault we can't parse/derive can't match — skip it rather than
        // failing the whole check on one bad legacy row.
        let Ok(network) = crate::config::parse_network(&network_str) else {
            continue;
        };
        let cfg = ghostkey_core::vault::VaultConfig {
            descriptor_external: ext,
            descriptor_internal: int_,
            timelock_blocks: timelock as u32,
            network,
            role: ghostkey_core::vault::VaultRole::Watchonly,
            label: None,
        };
        let Ok(vault) = ghostkey_core::vault::Vault::from_config(cfg) else {
            continue;
        };
        let Ok((externals, internals)) = ghostkey_core::wallet::peek_addresses(&vault, GAP) else {
            continue;
        };

        if let Some(i) = externals.iter().position(|a| a == target) {
            return Ok(Json(VerifyAddressResult {
                matched: true,
                vault_id: Some(id),
                network: Some(network_str),
                status: Some(status),
                keychain: Some("external".into()),
                index: Some(i as u32),
            }));
        }
        if let Some(i) = internals.iter().position(|a| a == target) {
            return Ok(Json(VerifyAddressResult {
                matched: true,
                vault_id: Some(id),
                network: Some(network_str),
                status: Some(status),
                keychain: Some("internal".into()),
                index: Some(i as u32),
            }));
        }
    }

    Ok(Json(VerifyAddressResult {
        matched: false,
        vault_id: None,
        network: None,
        status: None,
        keychain: None,
        index: None,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::extract::State;

    fn ensure_test_master_key() {
        use base64::Engine;
        if std::env::var("GHOSTKEY_MASTER_KEY").is_err() {
            let b64 = base64::engine::general_purpose::STANDARD_NO_PAD.encode([0u8; 32]);
            // SAFETY: tests are single-process; the value is fixed.
            unsafe {
                std::env::set_var("GHOSTKEY_MASTER_KEY", b64);
            }
        }
    }

    async fn fresh_state() -> Arc<AppState> {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("connect sqlite::memory");
        sqlx::migrate!("./migrations")
            .run(&pool)
            .await
            .expect("run migrations");
        Arc::new(AppState {
            db: pool,
            lightning: Arc::new(crate::lightning::NoopProvider),
        })
    }

    #[tokio::test]
    async fn newsletter_export_round_trips_the_sealed_email() {
        ensure_test_master_key();
        let state = fresh_state().await;

        // Seed a subscriber through the real subscribe handler so the
        // seal context matches production exactly.
        crate::newsletter::subscribe(
            State(state.clone()),
            Json(crate::newsletter::SubscribeRequest {
                email: "sarah@example.com".into(),
                source: Some("footer".into()),
            }),
        )
        .await
        .expect("subscribe");

        // The admin export decrypts it back to plaintext.
        let Json(list) = list_newsletter(AdminAuth, State(state.clone()))
            .await
            .expect("export");
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].email, "sarah@example.com");
        assert_eq!(list[0].source.as_deref(), Some("footer"));
    }

    #[tokio::test]
    async fn verify_address_matches_a_real_vault_and_rejects_a_stranger() {
        use bitcoin::bip32::Xpriv;
        use bitcoin::Network;
        use ghostkey_core::keys::{account_xpub, descriptor_key_fragment, Chain};
        use ghostkey_core::vault::{Vault, VaultRole};

        ensure_test_master_key();
        let state = fresh_state().await;

        // Build a real vault exactly like production does.
        let net = Network::Signet;
        let owner_m = Xpriv::new_master(net, &[0x33; 32]).unwrap();
        let heir_m = Xpriv::new_master(net, &[0x44; 32]).unwrap();
        let (ofp, op, ox) = account_xpub(&owner_m, net).unwrap();
        let (hfp, hp, hx) = account_xpub(&heir_m, net).unwrap();
        let vault = Vault::new(
            &descriptor_key_fragment(ofp, &op, &ox, Chain::External),
            &descriptor_key_fragment(ofp, &op, &ox, Chain::Internal),
            &descriptor_key_fragment(hfp, &hp, &hx, Chain::External),
            &descriptor_key_fragment(hfp, &hp, &hx, Chain::Internal),
            144,
            net,
            VaultRole::Watchonly,
            None,
        )
        .unwrap();
        let pair = vault.descriptor_pair();

        // The deposit address an applicant would DM us (external #0).
        let (externals, _) = ghostkey_core::wallet::peek_addresses(&vault, 5).unwrap();
        let funding_addr = externals[0].clone();

        // Seed the vault the way create_vault stores it.
        let ts = chrono::Utc::now().to_rfc3339();
        sqlx::query(
            "INSERT INTO vaults \
                 (id, network, descriptor_external, descriptor_internal, timelock_blocks, \
                  checkin_period_secs, grace_period_secs, created_at, next_deadline_at, status) \
             VALUES ('v-verify', 'signet', ?, ?, 144, 3600, 3600, ?, ?, 'ok')",
        )
        .bind(&pair.external)
        .bind(&pair.internal)
        .bind(&ts)
        .bind(&ts)
        .execute(&state.db)
        .await
        .expect("seed vault");

        // A genuine vault address matches, and tells us which vault.
        let Json(hit) = verify_address(
            AdminAuth,
            State(state.clone()),
            Query(VerifyAddressParams {
                address: funding_addr.clone(),
            }),
        )
        .await
        .expect("verify");
        assert!(hit.matched, "genuine vault address should match");
        assert_eq!(hit.vault_id.as_deref(), Some("v-verify"));
        assert_eq!(hit.keychain.as_deref(), Some("external"));
        assert_eq!(hit.index, Some(0));

        // A stranger's address (a different, unseeded vault) does not.
        let other_m = Xpriv::new_master(net, &[0x55; 32]).unwrap();
        let (fp2, p2, x2) = account_xpub(&other_m, net).unwrap();
        let other = Vault::new(
            &descriptor_key_fragment(fp2, &p2, &x2, Chain::External),
            &descriptor_key_fragment(fp2, &p2, &x2, Chain::Internal),
            &descriptor_key_fragment(hfp, &hp, &hx, Chain::External),
            &descriptor_key_fragment(hfp, &hp, &hx, Chain::Internal),
            144,
            net,
            VaultRole::Watchonly,
            None,
        )
        .unwrap();
        let (other_ext, _) = ghostkey_core::wallet::peek_addresses(&other, 1).unwrap();

        let Json(miss) = verify_address(
            AdminAuth,
            State(state.clone()),
            Query(VerifyAddressParams {
                address: other_ext[0].clone(),
            }),
        )
        .await
        .expect("verify");
        assert!(!miss.matched, "an address we never issued must not match");
        assert!(miss.vault_id.is_none());
    }
}
