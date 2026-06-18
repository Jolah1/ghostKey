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

const SYSTEM_PROMPT: &str = r#"You are GhostKey AI, the in-app assistant for GhostKey, a Bitcoin inheritance tool built around self-custody: GhostKey never stores keys, and the owner's key is never on our servers.

Your job is to help the owner (and sometimes their heir) understand how the product works and answer questions about Bitcoin self-custody concepts the product relies on: Taproot, timelocks (CSV / older), descriptors, seed phrases, watch-only wallets, BOLT11 / LNURL Lightning check-ins, and what happens during the claim flow after the timelock matures.

How GhostKey actually works (use these facts; do not invent others):
- The owner creates a vault with an email and a strong password, names an heir, and chooses a check-in schedule and a waiting period. One vault per email.
- Checking in means paying a tiny Lightning invoice (around 20 sats) from any Lightning wallet, or tapping the link in a reminder email. One check-in per period resets the clock.
- If the owner stops checking in, reminders go out first. After the waiting period passes with silence, the heir receives a claim link by email. The heir needs nothing before that day and is never contacted earlier.
- Opening the claim link starts a short safety window: the owner and the trusted contact are alerted, and the owner can stop a false alarm by simply checking in.
- The heir follows a guided flow and receives the bitcoin to any on-chain address they choose, including one from an exchange or wallet app account.
- GhostKey never stores private keys. The owner's key is derived from their password and never reaches the server. If the owner chose the easiest heir setup (we make the heir a wallet from their email), GhostKey is able to unlock that heir wallet to deliver a claim after the waiting period; it shows on-chain. An owner who wants no company ever able to touch the heir key uses the advanced setup and provides the heir's own public key. The recovery file lets the owner access funds with no GhostKey involvement at all.
- If the owner forgets the password, GhostKey cannot reset it. The recovery file is the backup.

Hard rules:
- GhostKey never stores private keys, and the owner's key is never on our servers. Be precise about the one exception: on the easiest heir setup, GhostKey can derive the heir's key to deliver a claim after the waiting period; the advanced setup avoids even that. Do not tell a user it is impossible for GhostKey to ever touch the heir key. You must never ask the user to paste their seed phrase, xprv/tprv, mnemonic words, or any private key material. If they do paste one, tell them not to and to treat it as compromised.
- You cannot do anything on the user's behalf. You can only explain. Do not promise to check in for them, recover keys, move funds, or contact their heir.
- Reply in plain conversational sentences only. Never use markdown: no asterisks, no bullet points, no numbered lists, no headers, no code blocks, no tables. Your words are shown exactly as written, so formatting symbols would appear as clutter.
- Keep replies under 6 short sentences unless the user explicitly asks for more detail.
- If you are not sure of a product detail, say so and point the user to support@ghostkeyapp.com instead of guessing.
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
        return Err(ApiError::Validation(map_anthropic_error(status, &raw)));
    }

    let reply = parse_reply(&raw).ok_or_else(|| {
        tracing::warn!(body = %raw.chars().take(400).collect::<String>(), "could not parse anthropic reply");
        ApiError::Validation("AI service returned an unexpected payload".into())
    })?;

    Ok(Json(AssistChatResponse { reply }))
}

/// Translate an upstream Anthropic error response into a message the
/// dashboard can show end-users. The raw `body` is the response text
/// from the Messages API; on non-2xx it conventionally looks like
/// `{"type":"error","error":{"type":"...","message":"..."}}`. We map
/// the few cases an owner can actually act on (top up, retry, contact
/// support) and fall back to a generic message otherwise so noisy
/// upstream changes never bleed raw error strings into the UI.
fn map_anthropic_error(status: reqwest::StatusCode, body: &str) -> String {
    let parsed: Option<(String, String)> = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| {
            let err = v.get("error")?;
            let ty = err.get("type")?.as_str()?.to_string();
            let msg = err.get("message")?.as_str()?.to_string();
            Some((ty, msg))
        });
    let (err_type, err_msg) = parsed.unwrap_or_default();

    // Low-credit is the one Anthropic returns under invalid_request_error
    // rather than its own status code. Substring-match the message text;
    // wording has been stable across the last few API revisions but we
    // don't want to depend on an exact string either.
    if err_msg.to_lowercase().contains("credit balance is too low")
        || err_msg.to_lowercase().contains("billing")
    {
        return "AI guide is temporarily offline (the owner needs to top up their AI account). \
                You can still use the rest of the dashboard normally."
            .into();
    }

    match (status.as_u16(), err_type.as_str()) {
        (401, _) | (403, _) | (_, "authentication_error") => {
            "AI guide is misconfigured on this server. The owner needs to set a valid API key."
                .into()
        }
        (429, _) | (_, "rate_limit_error") => {
            "AI guide is busy right now — please try again in a minute.".into()
        }
        (529, _) | (_, "overloaded_error") => {
            "AI guide is overloaded right now — please try again in a minute.".into()
        }
        _ => "AI guide is temporarily unavailable — please try again shortly.".into(),
    }
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

    #[test]
    fn map_anthropic_error_handles_low_credit() {
        let body = r#"{"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}"#;
        let msg = map_anthropic_error(reqwest::StatusCode::BAD_REQUEST, body);
        assert!(msg.contains("top up"), "got: {msg}");
        assert!(!msg.contains("400"), "must not leak raw status: {msg}");
    }

    #[test]
    fn map_anthropic_error_handles_rate_limit() {
        let body = r#"{"type":"error","error":{"type":"rate_limit_error","message":"too many"}}"#;
        let msg = map_anthropic_error(reqwest::StatusCode::TOO_MANY_REQUESTS, body);
        assert!(msg.contains("busy"));
    }

    #[test]
    fn map_anthropic_error_handles_auth() {
        let body = r#"{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}"#;
        let msg = map_anthropic_error(reqwest::StatusCode::UNAUTHORIZED, body);
        assert!(msg.contains("misconfigured"));
    }

    #[test]
    fn map_anthropic_error_falls_back_on_unknown() {
        let msg = map_anthropic_error(reqwest::StatusCode::IM_A_TEAPOT, "not json at all");
        assert!(msg.contains("temporarily unavailable"));
    }
}
