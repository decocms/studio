//! Token-authenticated loopback receiver for Claude Code and Codex hooks.

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, StatusCode};

use crate::error::{ApiError, ApiResult};
use crate::routes::threads::db::{RtTerminalProviderCheckpointOutcome, DEFAULT_THREAD_TITLE};
use crate::routes::threads::{db_err, shared_db};
use crate::state::AppState;

const MAX_HOOK_BODY_BYTES: usize = 1024 * 1024;
const FALLBACK_TITLE_MAX_CHARS: usize = 32;

pub async fn receive(
    State(state): State<AppState>,
    Path(terminal_session_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<StatusCode> {
    if body.len() > MAX_HOOK_BODY_BYTES {
        return Err(ApiError::payload_too_large(
            "agent hook payload is too large",
        ));
    }
    let hook = state
        .agent_sessions
        .hook(&terminal_session_id)
        .ok_or_else(ApiError::unauthorized)?;
    let token = bearer_token(&headers).ok_or_else(ApiError::unauthorized)?;
    if !hook.authorizes(token) {
        return Err(ApiError::unauthorized());
    }
    let payload: serde_json::Value = crate::http_util::json_body(&body)?;
    let observation =
        crate::terminal::lifecycle::normalize_hook(&payload).map_err(ApiError::bad_request)?;
    let db = shared_db(&state)?;

    if let Some(provider_session_id) = observation.provider_session_id.as_deref() {
        match db
            .rt_checkpoint_terminal_provider_session(
                &hook.fence,
                &terminal_session_id,
                provider_session_id,
            )
            .map_err(db_err)?
        {
            RtTerminalProviderCheckpointOutcome::Conflict(_) => {
                tracing::warn!(
                    terminal_session_id,
                    "provider tried to replace a terminal session checkpoint"
                );
            }
            RtTerminalProviderCheckpointOutcome::Stored(_)
            | RtTerminalProviderCheckpointOutcome::Unchanged(_)
            | RtTerminalProviderCheckpointOutcome::NotLive(_)
            | RtTerminalProviderCheckpointOutcome::Missing => {}
        }
    }

    if let Some(logical_state) = observation.logical_state {
        crate::terminal::lifecycle::transition_logical(
            db,
            &hook.fence,
            &terminal_session_id,
            logical_state,
        )
        .map_err(ApiError::internal)?;
        state.agent_sessions.notify_lifecycle(&hook.fence);
    }

    if observation.is_explicit_user_prompt {
        if let Some(prompt) = observation.prompt.as_deref() {
            start_title_generation(db, hook, prompt);
        }
    }
    Ok(StatusCode::NO_CONTENT)
}

fn bearer_token(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::AUTHORIZATION)?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")
        .map(str::trim)
        .filter(|token| !token.is_empty())
}

fn start_title_generation(
    db: &'static crate::routes::threads::db::ThreadsDb,
    hook: std::sync::Arc<crate::terminal::registry::HookRegistration>,
    prompt: &str,
) {
    let Some(fallback) = fallback_title(prompt) else {
        return;
    };
    // Malformed/emoji-only hook payloads must not consume the one title
    // attempt. Claim only after a usable first prompt has been identified.
    if !hook.claim_title() {
        return;
    }
    let fallback_stored =
        match db.rt_retitle_thread_if_unchanged(&hook.fence, DEFAULT_THREAD_TITLE, &fallback) {
            Ok(stored) => stored,
            Err(error) => {
                hook.release_title_claim();
                tracing::warn!(%error, "could not store native terminal fallback title");
                return;
            }
        };
    if !fallback_stored {
        return;
    }
    if let Ok(Some(thread)) = db.rt_thread_fenced(&hook.fence) {
        crate::terminal::lifecycle::emit_thread(&hook.fence, &thread);
    }

    let prompt = prompt.to_string();
    tokio::spawn(async move {
        let Some(generated) = harness::title::generate_title(
            hook.harness,
            &hook.cwd,
            &prompt,
            &hook.title_environment,
            harness::title::TITLE_TIMEOUT,
        )
        .await
        else {
            return;
        };
        if generated == fallback {
            return;
        }
        match db.rt_retitle_thread_if_unchanged(&hook.fence, &fallback, &generated) {
            Ok(true) => {
                if let Ok(Some(thread)) = db.rt_thread_fenced(&hook.fence) {
                    crate::terminal::lifecycle::emit_thread(&hook.fence, &thread);
                }
            }
            Ok(false) => {}
            Err(error) => tracing::warn!(%error, "could not store generated native terminal title"),
        }
    });
}

fn fallback_title(prompt: &str) -> Option<String> {
    let candidate = prompt
        .trim()
        .chars()
        .take(FALLBACK_TITLE_MAX_CHARS)
        .collect::<String>()
        .trim()
        .to_string();
    candidate
        .chars()
        .any(char::is_alphanumeric)
        .then_some(candidate)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    #[test]
    fn bearer_parser_is_strict() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_static("Bearer secret"),
        );
        assert_eq!(bearer_token(&headers), Some("secret"));
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_static("Basic secret"),
        );
        assert_eq!(bearer_token(&headers), None);
    }

    #[test]
    fn fallback_title_is_unicode_safe_and_requires_text() {
        assert_eq!(
            fallback_title("  Fix the login screen  ").as_deref(),
            Some("Fix the login screen")
        );
        assert_eq!(fallback_title("🙂🙂"), None);
        assert_eq!(fallback_title(&"á".repeat(80)).unwrap().chars().count(), 32);
    }
}
