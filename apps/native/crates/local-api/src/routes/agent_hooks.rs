//! Token-authenticated loopback receiver for coding-agent lifecycle hooks.

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
    let is_opencode = hook.harness == harness::HarnessId::OpenCode;
    if is_opencode
        && payload.get("provider").and_then(serde_json::Value::as_str) != Some("opencode")
    {
        return Ok(StatusCode::NO_CONTENT);
    }
    let observation =
        crate::terminal::lifecycle::normalize_hook(&payload).map_err(ApiError::bad_request)?;
    let opencode_delivery = OpenCodeDelivery::from_payload(&payload);
    let db = shared_db(&state)?;

    if hook.harness == harness::HarnessId::ClaudeCode {
        let Some(current) = db
            .rt_get_terminal_session_fenced(&hook.fence, &terminal_session_id)
            .map_err(db_err)?
        else {
            return Ok(StatusCode::NO_CONTENT);
        };
        if !claude_event_matches_root(
            hook.expected_provider_session_id(),
            current.provider_session_id.as_deref(),
            observation.provider_session_id.as_deref(),
        ) {
            tracing::debug!(
                terminal_session_id,
                event_name = observation.event_name,
                "ignored Claude event outside the established root session"
            );
            return Ok(StatusCode::NO_CONTENT);
        }
    }

    if is_opencode {
        let Some(current) = db
            .rt_get_terminal_session_fenced(&hook.fence, &terminal_session_id)
            .map_err(db_err)?
        else {
            return Ok(StatusCode::NO_CONTENT);
        };
        match opencode_root_decision(
            current.provider_session_id.as_deref(),
            hook.expected_provider_session_id(),
            &observation.event_name,
            observation.provider_session_id.as_deref(),
            opencode_delivery.root_session_id,
        ) {
            OpenCodeRootDecision::Accept => {}
            OpenCodeRootDecision::Checkpoint => {
                let provider_session_id = observation
                    .provider_session_id
                    .as_deref()
                    .expect("checkpoint decisions require an observed id");
                match db
                    .rt_checkpoint_terminal_provider_session(
                        &hook.fence,
                        &terminal_session_id,
                        provider_session_id,
                    )
                    .map_err(db_err)?
                {
                    RtTerminalProviderCheckpointOutcome::Stored(_)
                    | RtTerminalProviderCheckpointOutcome::Unchanged(_) => {}
                    RtTerminalProviderCheckpointOutcome::Conflict(_)
                    | RtTerminalProviderCheckpointOutcome::NotLive(_)
                    | RtTerminalProviderCheckpointOutcome::Missing => {
                        tracing::warn!(
                            terminal_session_id,
                            event_name = observation.event_name,
                            "ignored OpenCode event that could not establish its root session"
                        );
                        return Ok(StatusCode::NO_CONTENT);
                    }
                }
            }
            OpenCodeRootDecision::Reject => {
                tracing::debug!(
                    terminal_session_id,
                    event_name = observation.event_name,
                    "ignored OpenCode event outside the established root session"
                );
                return Ok(StatusCode::NO_CONTENT);
            }
        }
    } else if let Some(provider_session_id) = provider_checkpoint_id(
        hook.harness,
        hook.expected_provider_session_id(),
        &observation,
    ) {
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
                if hook.harness == harness::HarnessId::ClaudeCode {
                    return Ok(StatusCode::NO_CONTENT);
                }
            }
            RtTerminalProviderCheckpointOutcome::Stored(_)
            | RtTerminalProviderCheckpointOutcome::Unchanged(_) => {}
            RtTerminalProviderCheckpointOutcome::NotLive(_)
            | RtTerminalProviderCheckpointOutcome::Missing => {
                if hook.harness == harness::HarnessId::ClaudeCode {
                    return Ok(StatusCode::NO_CONTENT);
                }
            }
        }
    }

    let turn_admission = if is_opencode {
        admit_opencode_turn_event(&hook, &observation, opencode_delivery)
    } else {
        OpenCodeTurnAdmission::Allow
    };
    if turn_admission == OpenCodeTurnAdmission::Ignore {
        return Ok(StatusCode::NO_CONTENT);
    }
    if let Some(logical_state) = observation.logical_state {
        if let Err(error) = crate::terminal::lifecycle::transition_logical(
            db,
            &hook.fence,
            &terminal_session_id,
            logical_state,
        ) {
            if let Some(turn_id) = opencode_delivery.turn_id {
                if turn_admission == OpenCodeTurnAdmission::Terminal {
                    hook.restore_opencode_turn(turn_id);
                } else if observation.event_name == "session.status"
                    && observation.logical_state
                        == Some(crate::routes::threads::db::RtTerminalLogicalState::Working)
                {
                    hook.restore_opencode_busy(turn_id);
                }
            }
            return Err(ApiError::internal(error));
        }
        state.agent_sessions.notify_lifecycle(&hook.fence);
    }

    if hook.harness == harness::HarnessId::OpenCode {
        if let Some(title) = observation
            .provider_title
            .as_deref()
            .and_then(normalize_opencode_title)
        {
            match db.rt_retitle_thread_if_unchanged(&hook.fence, DEFAULT_THREAD_TITLE, &title) {
                Ok(true) => {
                    if let Ok(Some(thread)) = db.rt_thread_fenced(&hook.fence) {
                        crate::terminal::lifecycle::emit_thread(&hook.fence, &thread);
                    }
                }
                Ok(false) => {}
                Err(error) => {
                    tracing::warn!(%error, "could not store OpenCode-generated chat title")
                }
            }
        }
    }

    if hook.harness != harness::HarnessId::OpenCode && observation.is_explicit_user_prompt {
        if let Some(prompt) = observation.prompt.as_deref() {
            start_title_generation(db, hook, prompt);
        }
    }
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OpenCodeRootDecision {
    Accept,
    Checkpoint,
    Reject,
}

fn claude_event_matches_root(
    expected_provider_session_id: Option<&str>,
    checkpointed_provider_session_id: Option<&str>,
    observed_provider_session_id: Option<&str>,
) -> bool {
    expected_provider_session_id
        .or(checkpointed_provider_session_id)
        .is_none_or(|root| observed_provider_session_id == Some(root))
}

fn provider_checkpoint_id<'a>(
    harness: harness::HarnessId,
    expected_provider_session_id: Option<&str>,
    observation: &'a crate::terminal::lifecycle::HookObservation,
) -> Option<&'a str> {
    let observed = observation.provider_session_id.as_deref()?;
    if harness != harness::HarnessId::ClaudeCode {
        return Some(observed);
    }

    if expected_provider_session_id.is_some_and(|expected| expected != observed) {
        return None;
    }
    let proves_persisted_conversation = matches!(
        observation.event_name.as_str(),
        "UserPromptSubmit"
            | "PreToolUse"
            | "PostToolUse"
            | "PostToolUseFailure"
            | "PermissionRequest"
            | "Stop"
            | "StopFailure"
    );
    let proves_resumed_conversation =
        observation.event_name == "SessionStart" && expected_provider_session_id == Some(observed);
    (proves_persisted_conversation || proves_resumed_conversation).then_some(observed)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OpenCodeTurnPhase {
    Busy,
    Active,
    Terminal,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct OpenCodeDelivery<'a> {
    root_session_id: Option<&'a str>,
    turn_id: Option<u64>,
    turn_phase: Option<OpenCodeTurnPhase>,
}

impl<'a> OpenCodeDelivery<'a> {
    fn from_payload(payload: &'a serde_json::Value) -> Self {
        let root_session_id = payload
            .get("rootSessionID")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let turn = payload.get("turn").and_then(serde_json::Value::as_object);
        let turn_id = turn
            .and_then(|turn| turn.get("id"))
            .and_then(serde_json::Value::as_u64)
            .filter(|turn_id| *turn_id > 0);
        let turn_phase = turn
            .and_then(|turn| turn.get("phase"))
            .and_then(serde_json::Value::as_str)
            .and_then(|phase| match phase {
                "busy" => Some(OpenCodeTurnPhase::Busy),
                "active" => Some(OpenCodeTurnPhase::Active),
                "terminal" => Some(OpenCodeTurnPhase::Terminal),
                _ => None,
            });
        Self {
            root_session_id,
            turn_id,
            turn_phase,
        }
    }
}

fn opencode_root_decision(
    durable_root: Option<&str>,
    resumed_root: Option<&str>,
    event_name: &str,
    observed: Option<&str>,
    selected_root: Option<&str>,
) -> OpenCodeRootDecision {
    let Some(observed) = observed else {
        return OpenCodeRootDecision::Reject;
    };
    if selected_root.is_some_and(|selected| selected != observed) {
        return OpenCodeRootDecision::Reject;
    }
    if durable_root
        .zip(resumed_root)
        .is_some_and(|(durable, resumed)| durable != resumed)
    {
        return OpenCodeRootDecision::Reject;
    }
    if let Some(root) = durable_root.or(resumed_root) {
        if observed != root {
            return OpenCodeRootDecision::Reject;
        }
        return if durable_root.is_some() {
            OpenCodeRootDecision::Accept
        } else {
            OpenCodeRootDecision::Checkpoint
        };
    }
    if event_name == "session.created" || selected_root == Some(observed) {
        OpenCodeRootDecision::Checkpoint
    } else {
        OpenCodeRootDecision::Reject
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OpenCodeTurnAdmission {
    Allow,
    Terminal,
    Ignore,
}

fn admit_opencode_turn_event(
    hook: &crate::terminal::registry::HookRegistration,
    observation: &crate::terminal::lifecycle::HookObservation,
    delivery: OpenCodeDelivery<'_>,
) -> OpenCodeTurnAdmission {
    use crate::routes::threads::db::RtTerminalLogicalState;

    if observation.event_name == "session.status"
        && observation.logical_state == Some(RtTerminalLogicalState::Working)
    {
        return if delivery.turn_phase == Some(OpenCodeTurnPhase::Busy)
            && delivery
                .turn_id
                .is_some_and(|turn_id| hook.observe_opencode_busy(turn_id))
        {
            OpenCodeTurnAdmission::Allow
        } else {
            OpenCodeTurnAdmission::Ignore
        };
    }
    if matches!(
        observation.logical_state,
        Some(RtTerminalLogicalState::Completed | RtTerminalLogicalState::Failed)
    ) {
        return if delivery.turn_phase == Some(OpenCodeTurnPhase::Terminal)
            && delivery
                .turn_id
                .is_some_and(|turn_id| hook.finish_opencode_turn(turn_id))
        {
            OpenCodeTurnAdmission::Terminal
        } else {
            OpenCodeTurnAdmission::Ignore
        };
    }
    if matches!(
        observation.event_name.as_str(),
        "permission.asked"
            | "permission.replied"
            | "question.asked"
            | "question.replied"
            | "question.rejected"
    ) && !(delivery.turn_phase == Some(OpenCodeTurnPhase::Active)
        && delivery
            .turn_id
            .is_some_and(|turn_id| hook.observe_opencode_active(turn_id)))
    {
        return OpenCodeTurnAdmission::Ignore;
    }
    OpenCodeTurnAdmission::Allow
}

fn normalize_opencode_title(title: &str) -> Option<String> {
    const MAX_TITLE_CHARS: usize = 100;
    let title = title.trim();
    if title.is_empty()
        || title.starts_with("New session - ")
        || title.chars().any(char::is_control)
        || !title.chars().any(char::is_alphanumeric)
    {
        return None;
    }
    Some(title.chars().take(MAX_TITLE_CHARS).collect())
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

    #[test]
    fn claude_checkpoints_only_events_that_prove_a_persisted_conversation() {
        let observation = |event_name: &str, provider_session_id: &str| {
            crate::terminal::lifecycle::HookObservation {
                event_name: event_name.to_string(),
                provider_session_id: Some(provider_session_id.to_string()),
                provider_title: None,
                logical_state: None,
                prompt: None,
                is_explicit_user_prompt: false,
            }
        };

        for event_name in ["SessionStart", "SessionEnd", "Notification"] {
            assert_eq!(
                provider_checkpoint_id(
                    harness::HarnessId::ClaudeCode,
                    None,
                    &observation(event_name, "fresh"),
                ),
                None,
                "{event_name} must not make an empty fresh Claude session resumable"
            );
        }
        for event_name in [
            "UserPromptSubmit",
            "PreToolUse",
            "PostToolUse",
            "PostToolUseFailure",
            "PermissionRequest",
            "Stop",
            "StopFailure",
        ] {
            assert_eq!(
                provider_checkpoint_id(
                    harness::HarnessId::ClaudeCode,
                    None,
                    &observation(event_name, "fresh"),
                ),
                Some("fresh"),
                "{event_name} proves Claude has materialized the conversation"
            );
        }

        assert_eq!(
            provider_checkpoint_id(
                harness::HarnessId::ClaudeCode,
                Some("resume"),
                &observation("SessionStart", "resume"),
            ),
            Some("resume")
        );
        assert_eq!(
            provider_checkpoint_id(
                harness::HarnessId::ClaudeCode,
                Some("resume"),
                &observation("SessionStart", "other"),
            ),
            None
        );
        assert_eq!(
            provider_checkpoint_id(
                harness::HarnessId::ClaudeCode,
                Some("resume"),
                &observation("SessionEnd", "resume"),
            ),
            None
        );
        assert_eq!(
            provider_checkpoint_id(
                harness::HarnessId::Codex,
                None,
                &observation("SessionStart", "codex"),
            ),
            Some("codex")
        );

        assert!(claude_event_matches_root(None, None, Some("fresh")));
        assert!(claude_event_matches_root(
            Some("resume"),
            None,
            Some("resume")
        ));
        assert!(!claude_event_matches_root(
            Some("resume"),
            None,
            Some("other")
        ));
        assert!(!claude_event_matches_root(Some("resume"), None, None));
        assert!(claude_event_matches_root(
            None,
            Some("fresh"),
            Some("fresh")
        ));
        assert!(!claude_event_matches_root(
            None,
            Some("fresh"),
            Some("other")
        ));
    }

    #[test]
    fn opencode_titles_reject_defaults_and_controls_and_truncate_safely() {
        assert_eq!(normalize_opencode_title("New session - 2026-08-01"), None);
        assert_eq!(normalize_opencode_title("title\nwith control"), None);
        assert_eq!(normalize_opencode_title("🙂🙂"), None);
        assert_eq!(
            normalize_opencode_title("  Fix OpenCode resume  ").as_deref(),
            Some("Fix OpenCode resume")
        );
        assert_eq!(
            normalize_opencode_title(&"á".repeat(120))
                .unwrap()
                .chars()
                .count(),
            100
        );
    }

    #[test]
    fn opencode_root_identity_is_fail_closed_and_preserves_exact_resume() {
        use OpenCodeRootDecision::{Accept, Checkpoint, Reject};

        assert_eq!(
            opencode_root_decision(None, None, "session.created", Some("ses_fresh"), None),
            Checkpoint
        );
        assert_eq!(
            opencode_root_decision(None, None, "session.status", Some("ses_unknown"), None),
            Reject
        );
        assert_eq!(
            opencode_root_decision(None, None, "session.error", None, None),
            Reject
        );
        // The plugin selects only a parentless session.created root. Carrying
        // that stable selection lets the next event recover a lost create POST.
        assert_eq!(
            opencode_root_decision(
                None,
                None,
                "session.status",
                Some("ses_fresh"),
                Some("ses_fresh"),
            ),
            Checkpoint
        );
        assert_eq!(
            opencode_root_decision(
                None,
                None,
                "session.status",
                Some("ses_child"),
                Some("ses_root"),
            ),
            Reject
        );
        assert_eq!(
            opencode_root_decision(
                None,
                Some("ses_resume"),
                "session.status",
                Some("ses_resume"),
                Some("ses_resume"),
            ),
            Checkpoint
        );
        assert_eq!(
            opencode_root_decision(
                None,
                Some("ses_resume"),
                "session.created",
                Some("ses_other"),
                Some("ses_other"),
            ),
            Reject
        );
        assert_eq!(
            opencode_root_decision(
                Some("ses_root"),
                Some("ses_root"),
                "session.idle",
                Some("ses_root"),
                Some("ses_root"),
            ),
            Accept
        );
        assert_eq!(
            opencode_root_decision(
                Some("ses_root"),
                Some("ses_other"),
                "session.idle",
                Some("ses_root"),
                Some("ses_root"),
            ),
            Reject
        );
    }

    #[test]
    fn opencode_delivery_parses_stable_root_and_turn_identity() {
        let payload = serde_json::json!({
            "provider": "opencode",
            "rootSessionID": "  ses_root  ",
            "turn": { "id": 7, "phase": "terminal" },
            "event": { "type": "session.idle", "properties": { "sessionID": "ses_root" } },
        });
        assert_eq!(
            OpenCodeDelivery::from_payload(&payload),
            OpenCodeDelivery {
                root_session_id: Some("ses_root"),
                turn_id: Some(7),
                turn_phase: Some(OpenCodeTurnPhase::Terminal),
            }
        );

        let malformed = serde_json::json!({
            "rootSessionID": "",
            "turn": { "id": 0, "phase": "unknown" },
        });
        assert_eq!(
            OpenCodeDelivery::from_payload(&malformed),
            OpenCodeDelivery::default()
        );
    }

    #[test]
    fn opencode_turn_envelopes_recover_lost_busy_and_dedupe_retries() {
        let registry = crate::terminal::registry::AgentSessionRegistry::new();
        let hook = registry.reserve_hook(crate::terminal::registry::HookReservation {
            fence: crate::routes::threads::db::RtThreadFence {
                account_scope: "account".to_string(),
                organization_id: "org".to_string(),
                thread_id: "thread".to_string(),
                generation: "generation".to_string(),
            },
            terminal_session_id: "terminal".to_string(),
            harness: harness::HarnessId::OpenCode,
            cwd: std::path::PathBuf::from("/tmp"),
            token: "hook".to_string(),
            mcp_token: "mcp".to_string(),
            mcp_path: "/mcp".to_string(),
            title_environment: harness::title::TitleEnvironment::default(),
            expected_provider_session_id: None,
        });
        let observation =
            |event_type: &str, properties: serde_json::Value, turn: Option<(u64, &str)>| {
                let payload = serde_json::json!({
                "provider": "opencode",
                "rootSessionID": "ses",
                "turn": turn.map(|(id, phase)| serde_json::json!({ "id": id, "phase": phase })),
                "event": { "type": event_type, "properties": properties },
                });
                let delivery = OpenCodeDelivery {
                    root_session_id: Some("ses"),
                    turn_id: turn.map(|(id, _)| id),
                    turn_phase: turn.and_then(|(_, phase)| match phase {
                        "busy" => Some(OpenCodeTurnPhase::Busy),
                        "active" => Some(OpenCodeTurnPhase::Active),
                        "terminal" => Some(OpenCodeTurnPhase::Terminal),
                        _ => None,
                    }),
                };
                (
                    crate::terminal::lifecycle::normalize_hook(&payload).unwrap(),
                    delivery,
                )
            };

        let (idle_without_turn, no_delivery) = observation(
            "session.idle",
            serde_json::json!({ "sessionID": "ses" }),
            None,
        );
        assert_eq!(
            admit_opencode_turn_event(&hook, &idle_without_turn, no_delivery),
            OpenCodeTurnAdmission::Ignore
        );

        let (busy, busy_delivery) = observation(
            "session.status",
            serde_json::json!({ "sessionID": "ses", "status": { "type": "busy" } }),
            Some((1, "busy")),
        );
        assert_eq!(
            admit_opencode_turn_event(&hook, &busy, busy_delivery),
            OpenCodeTurnAdmission::Allow
        );
        assert_eq!(
            admit_opencode_turn_event(&hook, &busy, busy_delivery),
            OpenCodeTurnAdmission::Ignore
        );
        let (waiting, waiting_delivery) = observation(
            "permission.asked",
            serde_json::json!({ "sessionID": "ses" }),
            Some((1, "active")),
        );
        assert_eq!(
            admit_opencode_turn_event(&hook, &waiting, waiting_delivery),
            OpenCodeTurnAdmission::Allow
        );
        let (idle, idle_delivery) = observation(
            "session.idle",
            serde_json::json!({ "sessionID": "ses" }),
            Some((1, "terminal")),
        );
        assert_eq!(
            admit_opencode_turn_event(&hook, &idle, idle_delivery),
            OpenCodeTurnAdmission::Terminal
        );
        assert_eq!(
            admit_opencode_turn_event(&hook, &idle, idle_delivery),
            OpenCodeTurnAdmission::Ignore
        );

        let (error, error_delivery) = observation(
            "session.error",
            serde_json::json!({ "sessionID": "ses", "error": {} }),
            Some((1, "terminal")),
        );
        assert_eq!(
            admit_opencode_turn_event(&hook, &error, error_delivery),
            OpenCodeTurnAdmission::Ignore
        );

        // Even if both busy attempts were lost, a stable terminal turn id can
        // complete the prompt already claimed by terminal submit admission.
        let (recovered, recovered_delivery) = observation(
            "session.idle",
            serde_json::json!({ "sessionID": "ses" }),
            Some((2, "terminal")),
        );
        assert_eq!(
            admit_opencode_turn_event(&hook, &recovered, recovered_delivery),
            OpenCodeTurnAdmission::Terminal
        );
    }
}
