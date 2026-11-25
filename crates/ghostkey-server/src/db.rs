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
    /// Rows whose stored plaintext no longer agrees with its lookup hash,
    /// left untouched. Counted so the boot log states the damage plainly.
    pub vault_tokens_skipped: usize,
}

/// Seal every historical plaintext at-rest claim token before the server
/// starts serving requests.
///
/// The token itself, its lookup hash and every token-wrapped ciphertext stay
/// unchanged. Only the database representation of the token moves from raw
/// text to `gk1.<nonce>.<ciphertext>`, in one transaction.
///
/// A row whose plaintext disagrees with its own lookup hash is skipped, not
/// fatal. That row is already broken — the hash is what a claim link is
/// checked against, so no heir can redeem it whatever we store beside it —
/// and refusing to boot over it took every healthy vault on the host down
/// with it (signet, 2026-08-10). It is logged per row and counted in the
/// report so it stays visible instead of silent.
///
/// Sealing failures and concurrent modification remain fatal: the first
/// usually means the wrong `GHOSTKEY_MASTER_KEY` and would mis-seal every
/// row, the second means another process is writing the same table.
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

    let mut report = LegacyTokenMigration::default();
    for (vault_id, stored, token_hash) in vault_rows {
        if crate::crypto::claim_token_at_rest_is_sealed(&stored) {
            continue;
        }
        if let Err(err) = verify_legacy_token_hash(&vault_id, &stored, token_hash.as_deref()) {
            tracing::error!(vault_id = %vault_id, error = %err, "skipping unusable legacy claim token");
            report.vault_tokens_skipped += 1;
            continue;
        }
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

    tx.commit().await?;
    Ok(report)
}

fn verify_legacy_token_hash(
    vault_id: &str,
    token: &str,
    expected_hash: Option<&str>,
) -> Result<()> {
    if token.is_empty() {
        bail!("empty legacy claim token for vault {vault_id}");
    }
    if let Some(expected_hash) = expected_hash {
        if !crate::crypto::claim_token_matches(token, expected_hash) {
            bail!("legacy token hash mismatch for vault {vault_id}");
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
    async fn migration_seals_vault_tokens_without_changing_credentials() {
        ensure_test_master_key();
        let pool = fresh_pool().await;
        let vault_token = "legacy-vault-token";
        let vault_hash = crate::crypto::hash_claim_token(vault_token);
        insert_vault(&pool, "legacy", Some(vault_token), Some(&vault_hash)).await;

        let already_sealed =
            crate::crypto::seal_claim_token_at_rest("sealed", "keep-me").expect("seal fixture");
        insert_vault(&pool, "sealed", Some(&already_sealed), None).await;
        insert_vault(&pool, "empty", None, None).await;

        let report = seal_legacy_claim_tokens(&pool).await.expect("migrate");
        assert_eq!(
            report,
            LegacyTokenMigration {
                vault_tokens_sealed: 1,
                vault_tokens_skipped: 0,
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

    /// One row whose plaintext disagrees with its hash must not cost every
    /// other vault its startup. Signet went down this way on 2026-08-10:
    /// a single stale test vault refused the boot for the whole host.
    #[tokio::test]
    async fn hash_mismatch_skips_only_the_offending_row() {
        ensure_test_master_key();
        let pool = fresh_pool().await;
        let good = "good-legacy-token";
        let good_hash = crate::crypto::hash_claim_token(good);
        insert_vault(&pool, "a-good", Some(good), Some(&good_hash)).await;
        insert_vault(&pool, "z-bad", Some("bad-token"), Some("wrong-hash")).await;

        let report = seal_legacy_claim_tokens(&pool)
            .await
            .expect("a broken row must not abort startup");
        assert_eq!(report.vault_tokens_sealed, 1);
        assert_eq!(report.vault_tokens_skipped, 1);

        let rows: Vec<(String, String)> =
            sqlx::query_as("SELECT id, claim_token_at_rest_b64 FROM vaults ORDER BY id")
                .fetch_all(&pool)
                .await
                .expect("read migrated values");
        let good_stored = &rows[0].1;
        assert!(
            crate::crypto::claim_token_at_rest_is_sealed(good_stored),
            "the healthy row must still be sealed"
        );
        assert_eq!(
            crate::crypto::open_claim_token_at_rest("a-good", good_stored).expect("unseal"),
            good,
            "sealing must not change the token itself"
        );
        assert_eq!(
            rows[1].1, "bad-token",
            "the broken row must be left exactly as found, not rewritten"
        );
    }

    /// An empty stored token is the other shape of already-broken data and
    /// takes the same path.
    #[tokio::test]
    async fn empty_legacy_token_is_skipped_not_fatal() {
        ensure_test_master_key();
        let pool = fresh_pool().await;
        insert_vault(&pool, "empty", Some(""), Some("some-hash")).await;

        let report = seal_legacy_claim_tokens(&pool)
            .await
            .expect("must not abort");
        assert_eq!(report.vault_tokens_skipped, 1);
        assert_eq!(report.vault_tokens_sealed, 0);
    }
}
