//! Process-wide concurrency ceilings for expensive external work.
//!
//! Per-IP rate limits do not bound a distributed burst. These semaphores
//! cap simultaneous provider calls on one server instance. Notification
//! delivery is already serial in `notifier::tick_once`, so email has an
//! effective concurrency ceiling of one without another semaphore.

use std::sync::{Arc, OnceLock};

use tokio::sync::{OwnedSemaphorePermit, Semaphore};

static AI_GATE: OnceLock<Arc<Semaphore>> = OnceLock::new();
static ESPLORA_GATE: OnceLock<Arc<Semaphore>> = OnceLock::new();

fn configured_gate(
    cell: &'static OnceLock<Arc<Semaphore>>,
    env: &str,
    default: usize,
) -> Arc<Semaphore> {
    cell.get_or_init(|| {
        let permits = match std::env::var(env) {
            Ok(raw) => match raw.parse::<usize>() {
                Ok(value) if value > 0 => value,
                _ => {
                    tracing::warn!(
                        env_var = env,
                        value = %raw,
                        default,
                        "invalid external concurrency limit; using default"
                    );
                    default
                }
            },
            Err(_) => default,
        };
        tracing::info!(env_var = env, permits, "external concurrency limit");
        Arc::new(Semaphore::new(permits))
    })
    .clone()
}

pub async fn acquire_ai() -> OwnedSemaphorePermit {
    configured_gate(&AI_GATE, "GHOSTKEY_MAX_AI_CONCURRENCY", 4)
        .acquire_owned()
        .await
        .expect("process-wide AI semaphore is never closed")
}

pub async fn acquire_esplora() -> OwnedSemaphorePermit {
    configured_gate(&ESPLORA_GATE, "GHOSTKEY_MAX_ESPLORA_CONCURRENCY", 4)
        .acquire_owned()
        .await
        .expect("process-wide Esplora semaphore is never closed")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn semaphore_blocks_work_above_the_limit() {
        let gate = Arc::new(Semaphore::new(1));
        let first = gate.clone().acquire_owned().await.unwrap();
        assert!(gate.clone().try_acquire_owned().is_err());
        drop(first);
        assert!(gate.try_acquire_owned().is_ok());
    }
}
