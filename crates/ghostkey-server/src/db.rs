use anyhow::{bail, Context, Result};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::SqlitePool;
use std::str::FromStr;

pub async fn connect(url: &str) -> Result<SqlitePool> {
    let opts = SqliteConnectOptions::from_str(url)?
        .create_if_missing(true)
        .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
        .foreign_keys(true);

    let pool = SqlitePoolOptions::new()
        .max_connections(8)
        .connect_with(opts)
        .await?;

    // Apply migrations from the `migrations/` directory at compile time.
    sqlx::migrate!("./migrations").run(&pool).await?;
    Ok(pool)
}

/// Result of the mandatory legacy claim-token data migration.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct LegacyTokenMigration {
    pub vault_tokens_sealed: usize,
    pub guardian_tokens_sealed: usize,
}

/// Seal every historical plaintext at-rest claim token before the server
/// starts serving requests.
///
/// The token itself, its lookup hash and every token-wrapped ciphertext stay
/// unchanged. Only the database representation of the token moves from raw
/// text to `gk1.<nonce>.<ciphertext>`. Both vault and guardian tables are
/// updated in one transaction; any validation or write failure rolls back the
/// entire batch and startup aborts.
pub async fn seal_legacy_claim_tokens(pool: &SqlitePool) -> Result<LegacyTokenMigration> {
    let mut tx = pool.begin().await?;

    // Take SQLite's single-writer reservation before taking the inventory so two
    // simultaneously starting processes cannot migrate the same plaintext.
    let lock =
        sqlx::query("UPDATE startup_migration_locks SET touched_at = touched_at WHERE name = ?")
            .bind("legacy-claim-token-sealing")
            .execute(&mut *tx)
            .await?;
    anyhow::ensure!(
        lock.rows_affected() == 1,
        "legacy claim-token migration lock row is missing"
    );

    let vault_rows: Vec<(String, String, Option<String>)> = sqlx::query_as(
        "SELECT id, claim_token_at_rest_b64, claim_token_hash \
           FROM vaults WHERE claim_token_at_rest_b64 IS NOT NULL",
    )
    .fetch_all(&mut *tx)
    .await?;
    let guardian_rows: Vec<(String, i64, String, Option<String>)> = sqlx::query_as(
        "SELECT vault_id, slot, claim_token_at_rest_b64, claim_token_hash \
           FROM vault_guardian_keys WHERE claim_token_at_rest_b64 IS NOT NULL",
    )
    .fetch_all(&mut *tx)
    .await?;

    let mut report = LegacyTokenMigration::default();
    for (vault_id, stored, token_hash) in vault_rows {
        if crate::crypto::claim_token_at_rest_is_sealed(&stored) {
            continue;
        }
        verify_legacy_token_hash(&vault_id, None, &stored, token_hash.as_deref())?;
        let sealed = seal_and_verify(&vault_id, &stored)?;
        let updated = sqlx::query(
            "UPDATE vaults SET claim_token_at_rest_b64 = ? \
              WHERE id = ? AND claim_token_at_rest_b64 = ?",
        )
        .bind(sealed)
        .bind(&vault_id)
        .bind(&stored)
        .execute(&mut *tx)
        .await?;
        if updated.rows_affected() != 1 {
            bail!("legacy token changed during migration for vault {vault_id}");
        }
        report.vault_tokens_sealed += 1;
    }

    for (vault_id, slot, stored, token_hash) in guardian_rows {
        if crate::crypto::claim_token_at_rest_is_sealed(&stored) {
            continue;
        }
        verify_legacy_token_hash(&vault_id, Some(slot), &stored, token_hash.as_deref())?;
        let sealed = seal_and_verify(&vault_id, &stored)?;
        let updated = sqlx::query(
            "UPDATE vault_guardian_keys SET claim_token_at_rest_b64 = ? \
              WHERE vault_id = ? AND slot = ? AND claim_token_at_rest_b64 = ?",
        )
        .bind(sealed)
        .bind(&vault_id)
        .bind(slot)
        .bind(&stored)
        .execute(&mut *tx)
        .await?;
        if updated.rows_affected() != 1 {
            bail!(
                "legacy guardian token changed during migration for vault {vault_id}, slot {slot}"
            );
        }
        report.guardian_tokens_sealed += 1;
    }

    tx.commit().await?;
    Ok(report)
}

fn verify_legacy_token_hash(
    vault_id: &str,
    guardian_slot: Option<i64>,
    token: &str,
    expected_hash: Option<&str>,
) -> Result<()> {
    if token.is_empty() {
        bail!("empty legacy claim token for vault {vault_id}");
    }
    if let Some(expected_hash) = expected_hash {
        if !crate::crypto::claim_token_matches(token, expected_hash) {
            match guardian_slot {
                Some(slot) => {
                    bail!("legacy guardian token hash mismatch for vault {vault_id}, slot {slot}")
                }
                None => bail!("legacy token hash mismatch for vault {vault_id}"),
            }
        }
    }
    Ok(())
}

fn seal_and_verify(vault_id: &str, token: &str) -> Result<String> {
    let sealed = crate::crypto::seal_claim_token_at_rest(vault_id, token)
        .with_context(|| format!("seal legacy claim token for vault {vault_id}"))?;
    let reopened = crate::crypto::open_claim_token_at_rest(vault_id, &sealed)
        .with_context(|| format!("verify sealed claim token for vault {vault_id}"))?;
    if reopened != token {
        bail!("sealed claim token verification mismatch for vault {vault_id}");
    }
    Ok(sealed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    fn ensure_test_master_key() {
        if std::env::var("GHOSTKEY_MASTER_KEY").is_err() {
            // 32 zero bytes in unpadded base64.
            unsafe { std::env::set_var("GHOSTKEY_MASTER_KEY", "A".repeat(43)) };
        }
        crate::crypto::ensure_master_key_loaded().expect("test master key");
    }

    async fn fresh_pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("in-memory sqlite");
        sqlx::migrate!("./migrations")
            .run(&pool)
            .await
            .expect("run migrations");
        pool
    }

    async fn insert_vault(pool: &SqlitePool, id: &str, token: Option<&str>, hash: Option<&str>) {
        sqlx::query(
            r#"INSERT INTO vaults (
                  id, network, descriptor_external, descriptor_internal,
                  timelock_blocks, checkin_period_secs, grace_period_secs,
                  created_at, next_deadline_at, status,
                  claim_token_at_rest_b64, claim_token_hash
               ) VALUES (?, 'regtest', ?, ?, 144, 86400, 3600,
                         '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z', 'ok', ?, ?)"#,
        )
        .bind(id)
        .bind(format!("tr(fake-{id}/0/*)"))
        .bind(format!("tr(fake-{id}/1/*)"))
        .bind(token)
        .bind(hash)
        .execute(pool)
        .await
        .expect("insert vault");
    }

    #[tokio::test]
    async fn migration_seals_vault_and_guardian_tokens_without_changing_credentials() {
        ensure_test_master_key();
        let pool = fresh_pool().await;
        let vault_token = "legacy-vault-token";
        let guardian_token = "legacy-guardian-token";
        let vault_hash = crate::crypto::hash_claim_token(vault_token);
        let guardian_hash = crate::crypto::hash_claim_token(guardian_token);
        insert_vault(&pool, "legacy", Some(vault_token), Some(&vault_hash)).await;

        sqlx::query(
            r#"INSERT INTO vault_guardian_keys (
                   vault_id, slot, xprv_sealed_ct_b64, xprv_sealed_nonce,
                   claim_token_at_rest_b64, claim_token_hash,
                   xpub_fragment_external, xpub_fragment_internal, created_at
               ) VALUES ('legacy', 1, 'wrapped-key', 'nonce', ?, ?,
                         'guardian/0/*', 'guardian/1/*', '2026-01-01T00:00:00Z')"#,
        )
        .bind(guardian_token)
        .bind(&guardian_hash)
        .execute(&pool)
        .await
        .expect("insert guardian");

        let already_sealed =
            crate::crypto::seal_claim_token_at_rest("sealed", "keep-me").expect("seal fixture");
        insert_vault(&pool, "sealed", Some(&already_sealed), None).await;
        insert_vault(&pool, "empty", None, None).await;

        let report = seal_legacy_claim_tokens(&pool).await.expect("migrate");
        assert_eq!(
            report,
            LegacyTokenMigration {
                vault_tokens_sealed: 1,
                guardian_tokens_sealed: 1,
            }
        );

        let (vault_stored, vault_hash_after): (String, Option<String>) = sqlx::query_as(
            "SELECT claim_token_at_rest_b64, claim_token_hash FROM vaults WHERE id = 'legacy'",
        )
        .fetch_one(&pool)
        .await
        .expect("read vault token");
        assert!(crate::crypto::claim_token_at_rest_is_sealed(&vault_stored));
        assert_eq!(vault_hash_after.as_deref(), Some(vault_hash.as_str()));
        assert_eq!(
            crate::crypto::open_claim_token_at_rest("legacy", &vault_stored).unwrap(),
            vault_token
        );

        let (guardian_stored, guardian_hash_after): (String, Option<String>) = sqlx::query_as(
            "SELECT claim_token_at_rest_b64, claim_token_hash \
               FROM vault_guardian_keys WHERE vault_id = 'legacy' AND slot = 1",
        )
        .fetch_one(&pool)
        .await
        .expect("read guardian token");
        assert!(crate::crypto::claim_token_at_rest_is_sealed(
            &guardian_stored
        ));
        assert_eq!(guardian_hash_after.as_deref(), Some(guardian_hash.as_str()));
        assert_eq!(
            crate::crypto::open_claim_token_at_rest("legacy", &guardian_stored).unwrap(),
            guardian_token
        );

        let sealed_after: String =
            sqlx::query_scalar("SELECT claim_token_at_rest_b64 FROM vaults WHERE id = 'sealed'")
                .fetch_one(&pool)
                .await
                .expect("read sealed fixture");
        assert_eq!(sealed_after, already_sealed, "sealed rows are untouched");

        assert_eq!(
            seal_legacy_claim_tokens(&pool).await.expect("rerun"),
            LegacyTokenMigration::default(),
            "migration must be idempotent"
        );
    }

    #[tokio::test]
    async fn hash_mismatch_rolls_back_the_entire_batch() {
        ensure_test_master_key();
        let pool = fresh_pool().await;
        let good = "good-legacy-token";
        let good_hash = crate::crypto::hash_claim_token(good);
        insert_vault(&pool, "a-good", Some(good), Some(&good_hash)).await;
        insert_vault(&pool, "z-bad", Some("bad-token"), Some("wrong-hash")).await;

        let error = seal_legacy_claim_tokens(&pool)
            .await
            .expect_err("mismatched hash must abort");
        assert!(error.to_string().contains("hash mismatch"));

        let rows: Vec<(String, String)> =
            sqlx::query_as("SELECT id, claim_token_at_rest_b64 FROM vaults ORDER BY id")
                .fetch_all(&pool)
                .await
                .expect("read rolled-back values");
        assert_eq!(
            rows,
            vec![
                ("a-good".to_string(), good.to_string()),
                ("z-bad".to_string(), "bad-token".to_string()),
            ],
            "no partial sealing may survive a failed batch"
        );
    }
}
