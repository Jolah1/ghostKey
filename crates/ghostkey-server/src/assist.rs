//! Heir-onboarding guide chat.
//!
//! A thin proxy in front of the Anthropic Messages API. Lets the
//! browser ask plain-English questions about how GhostKey works
//! ("what does my heir need to do", "is my heir's email safe",
//! "what's a Taproot timelock") without us shipping an API key to the
//! client.
//!
//! Non-custody guarantees:
//!   - The handler refuses to forward anything that looks like a
//!     mnemonic, xprv/tprv, BIP39 word run, or hex-blob of >= 32 bytes.
//!     Education only — the model never needs to see secrets.
//!   - We pin a system prompt so the model stays in the "explain
//!     GhostKey concepts" lane and refuses to roleplay as a custodian.
//!   - No vault id, owner email, or descriptor ever crosses this
//!     endpoint from the server side. The browser may include the
//!     user's free-text question; that's it.
//!
//! Enabled iff `ANTHROPIC_API_KEY` is set. When unset, the route
//! returns 503 so the UI can hide the chat affordance gracefully.

use std::sync::Arc;

use axum::extract::State;
use axum::Json;
use serde::{Deserialize, Serialize};

use crate::routes::ApiError;
use crate::AppState;

const ANTHROPIC_URL: &str = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION: &str = "2023-06-01";
const MODEL: &str = "claude-haiku-4-5-20251001";
const MAX_TOKENS: u32 = 600;
const MAX_USER_CHARS: usize = 4000;
const MAX_HISTORY_MESSAGES: usize = 12;

const SYSTEM_PROMPT: &str = r#"You are the in-app onboarding guide for GhostKey, a non-custodial Bitcoin inheritance tool.

Your job is to help the owner (and sometimes their heir) understand how the product works and answer questions about Bitcoin self-custody concepts the product relies on: Taproot, timelocks (CSV / older), descriptors, seed phrases, watch-only wallets, BOLT11 / LNURL Lightning check-ins, and what happens during the claim flow after the timelock matures.

Hard rules:
- GhostKey is non-custodial. The server never holds private keys. You must never ask the user to paste their seed phrase, xprv/tprv, mnemonic words, or any private key material. If they do paste one, tell them not to and to treat it as compromised.
- You cannot do anything on the user's behalf — you can only explain. Do not promise to check in for them, recover keys, move funds, or contact their heir.
- Keep replies under 6 short sentences unless the user explicitly asks for more detail.
- If a question is outside GhostKey / Bitcoin self-custody (e.g. price predictions, trading advice, unrelated coding help), say it's out of scope and redirect.

Tone: calm, practical, plain English. Assume the reader is a smart adult who is not a Bitcoin expert."#;

/* ---------- request / response shapes ---------- */

#[derive(Debug, Deserialize)]
pub struct AssistChatRequest {
    pub messages: Vec<ChatMessage>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Serialize)]
pub struct AssistChatResponse {
    pub reply: String,
}

/* ---------- handler ---------- */

pub async fn assist_chat(
    State(_state): State<Arc<AppState>>,
    Json(req): Json<AssistChatRequest>,
) -> Result<Json<AssistChatResponse>, ApiError> {
    let api_key = std::env::var("ANTHROPIC_API_KEY")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| {
            ApiError::Validation(
                "AI guide is not configured on this server (ANTHROPIC_API_KEY unset)".into(),
            )
        })?;

    if req.messages.is_empty() {
        return Err(ApiError::Validation("messages: must not be empty".into()));
    }
    if req.messages.len() > MAX_HISTORY_MESSAGES {
        return Err(ApiError::Validation(format!(
            "messages: at most {MAX_HISTORY_MESSAGES} entries allowed"
        )));
    }

    let mut clean = Vec::with_capacity(req.messages.len());
    for m in req.messages {
        let role = match m.role.as_str() {
            "user" => "user",
            "assistant" => "assistant",
            other => {
                return Err(ApiError::Validation(format!(
                    "messages[].role must be 'user' or 'assistant' (got {other:?})"
                )))
            }
        };
        let content = m.content.trim();
        if content.is_empty() {
            return Err(ApiError::Validation(
                "messages[].content must not be blank".into(),
            ));
        }
        if content.chars().count() > MAX_USER_CHARS {
            return Err(ApiError::Validation(format!(
                "messages[].content too long (limit {MAX_USER_CHARS} chars)"
            )));
        }
        if looks_like_secret(content) {
            return Err(ApiError::Validation(
                "that message looks like a private key or seed phrase; \
                 the guide chat will not forward secrets. \
                 Treat anything you pasted as compromised."
                    .into(),
            ));
        }
        clean.push(ChatMessage {
            role: role.into(),
            content: content.into(),
        });
    }

    // Anthropic requires the conversation to start with a user turn.
    if clean.first().map(|m| m.role.as_str()) != Some("user") {
        return Err(ApiError::Validation(
            "messages: first message must be from the user".into(),
        ));
    }

    let body = serde_json::json!({
        "model": MODEL,
        "max_tokens": MAX_TOKENS,
        "system": SYSTEM_PROMPT,
        "messages": clean,
    });

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| ApiError::Validation(format!("http client: {e}")))?;

    let resp = client
        .post(ANTHROPIC_URL)
        .header("x-api-key", api_key)
        .header("anthropic-version", ANTHROPIC_VERSION)
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| {
            tracing::warn!(error = %e, "anthropic call failed");
            ApiError::Validation("upstream AI service unreachable".into())
        })?;

    let status = resp.status();
    let raw = resp
        .text()
        .await
        .map_err(|e| ApiError::Validation(format!("upstream read: {e}")))?;

    if !status.is_success() {
        tracing::warn!(
            status = %status,
            body = %raw.chars().take(400).collect::<String>(),
            "anthropic returned non-success"
        );
        return Err(ApiError::Validation(format!(
            "AI service returned {status}"
        )));
    }

    let reply = parse_reply(&raw).ok_or_else(|| {
        tracing::warn!(body = %raw.chars().take(400).collect::<String>(), "could not parse anthropic reply");
        ApiError::Validation("AI service returned an unexpected payload".into())
    })?;

    Ok(Json(AssistChatResponse { reply }))
}

/// Extract the first text block from a Messages-API response.
fn parse_reply(raw: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(raw).ok()?;
    let arr = v.get("content")?.as_array()?;
    for block in arr {
        if block.get("type").and_then(|t| t.as_str()) == Some("text") {
            if let Some(t) = block.get("text").and_then(|t| t.as_str()) {
                let trimmed = t.trim();
                if !trimmed.is_empty() {
                    return Some(trimmed.to_string());
                }
            }
        }
    }
    None
}

/// Heuristic guard against accidentally forwarding key material.
/// We err on the side of refusing; the AI guide never needs secrets.
fn looks_like_secret(s: &str) -> bool {
    let lc = s.to_lowercase();

    // xprv / tprv / yprv / zprv extended private keys (and the upper-case forms).
    for needle in ["xprv", "tprv", "yprv", "zprv", "uprv", "vprv"] {
        if lc.contains(needle) {
            return true;
        }
    }

    // Long contiguous hex / base58 blob — likely a key or signature.
    let longest_alnum_run = s
        .split(|c: char| !c.is_ascii_alphanumeric())
        .map(|tok| tok.len())
        .max()
        .unwrap_or(0);
    if longest_alnum_run >= 60 {
        return true;
    }

    // BIP39 mnemonic: 12 / 15 / 18 / 21 / 24 short whitespace-separated
    // lowercase words. We don't bother checking against the wordlist —
    // the shape is distinctive enough on its own.
    let words: Vec<&str> = s.split_whitespace().collect();
    if matches!(words.len(), 12 | 15 | 18 | 21 | 24) {
        let all_wordy = words.iter().all(|w| {
            let len = w.chars().count();
            (3..=8).contains(&len) && w.chars().all(|c| c.is_ascii_alphabetic())
        });
        if all_wordy {
            return true;
        }
    }

    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_extended_private_keys() {
        assert!(looks_like_secret(
            "xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi"
        ));
        assert!(looks_like_secret("here is my tprv8...payload"));
    }

    #[test]
    fn rejects_bip39_mnemonics() {
        assert!(looks_like_secret(
            "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
        ));
    }

    #[test]
    fn allows_ordinary_questions() {
        assert!(!looks_like_secret(
            "what does my heir need to do once the timelock matures?"
        ));
        assert!(!looks_like_secret("can I check in from a phone?"));
    }
}
