//! Guarded native terminal routes and WebSocket bridge.

use std::future::Future;
use std::time::Duration;

use axum::body::Bytes;
use axum::extract::ws::{Message, WebSocket};
use axum::extract::{Path, State, WebSocketUpgrade};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use base64::Engine;
use harness::HarnessId;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use terminal_session::{
    CommandSpec, ReplaySnapshot, SessionEvent, SessionExit, SessionKey, TerminalSession,
    TerminalSize,
};
use uuid::Uuid;

use crate::error::{ApiError, ApiResult};
use crate::routes::threads::authority::{self, ThreadAccess};
use crate::routes::threads::db::{
    RtTerminalLogicalState, RtTerminalPhysicalState, RtTerminalResumeDecision, RtTerminalSession,
    RtTerminalSessionCasOutcome, RtTerminalSessionCreateOutcome, RtThreadFence, ThreadsDb,
    DESKTOP_SANDBOX_PROVIDER_KIND,
};
use crate::state::AppState;
use crate::terminal::launch_context::{self, LaunchRequest, PreparedLaunch};
use crate::terminal::registry::{
    generate_hook_token, generate_mcp_token, ManagedTerminal, PreparationReservation,
    PromptRequestStatus, WriterLeaseGuard,
};

const MAX_CONTROL_FRAME_BYTES: usize = 256 * 1024;
const TERMINAL_INPUT_BYTES: usize = 64 * 1024;
const BRACKETED_PASTE_OVERHEAD_BYTES: usize = 13;
const MAX_PROMPT_BYTES: usize = TERMINAL_INPUT_BYTES - BRACKETED_PASTE_OVERHEAD_BYTES;
const MAX_REQUEST_ID_BYTES: usize = 512;
const MIN_ROWS: u16 = 2;
const MAX_ROWS: u16 = 500;
const MIN_COLS: u16 = 2;
const MAX_COLS: u16 = 1_000;
const CLAUDE_RESUME_PROBE_TIMEOUT: Duration = Duration::from_secs(5);
const CLAUDE_RESUME_DIAGNOSTIC_MAX_BYTES: u64 = 64 * 1024;

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StartTerminalBody {
    pub harness_id: Option<String>,
    #[serde(default = "default_approval_mode")]
    pub approval_mode: String,
    #[serde(default)]
    pub plan_mode: bool,
    pub cols: Option<u16>,
    pub rows: Option<u16>,
}

fn default_approval_mode() -> String {
    "default".to_string()
}

#[derive(Debug, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum ClientFrame {
    Start {
        harness_id: String,
        #[serde(default = "default_approval_mode")]
        approval_mode: String,
        #[serde(default)]
        plan_mode: bool,
        rows: u16,
        cols: u16,
        #[serde(default)]
        initial_prompt: Option<String>,
        #[serde(default)]
        request_id: Option<String>,
    },
    Attach {
        #[serde(default)]
        after_seq: Option<u64>,
        rows: u16,
        cols: u16,
    },
    Input {
        data: String,
    },
    Resize {
        rows: u16,
        cols: u16,
    },
    Interrupt,
    Terminate,
    SubmitPrompt {
        text: String,
        request_id: String,
    },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalMetadata {
    session_id: Option<String>,
    generation: String,
    harness_id: Option<String>,
    physical_state: String,
    logical_state: String,
    thread_status: String,
    last_seq: u64,
    provider_session_available: bool,
}

#[derive(Debug)]
struct StartOptions {
    harness: HarnessId,
    approval_mode: String,
    plan_mode: bool,
    size: TerminalSize,
}

struct SpawnFences {
    _account: upstream::SessionTransitionGuard,
    _claude_state: Option<tokio::sync::OwnedMutexGuard<()>>,
}

struct SpawnAdmissionFences {
    account: upstream::SessionTransitionGuard,
    claude_state: Option<tokio::sync::OwnedMutexGuard<()>>,
}

enum SpawnFenceError {
    Account(String),
    WorkspaceTrust(String),
}

struct SessionSpawnOwner {
    state: AppState,
    db: &'static ThreadsDb,
    fence: RtThreadFence,
    options: StartOptions,
    terminal_session_id: String,
    provider_session_id: Option<String>,
    hook_token: String,
    mcp_token: String,
    key: SessionKey,
    preparation: PreparationReservation,
    upstream_session: upstream::UpstreamSession,
    account: crate::sandbox::manager::SandboxAccount,
    identity_generation: u64,
}

impl SpawnFenceError {
    fn message(&self) -> &str {
        match self {
            Self::Account(message) | Self::WorkspaceTrust(message) => message,
        }
    }
}

#[derive(Debug)]
struct Handshake {
    options: StartOptions,
    after_seq: u64,
    initial_prompt: Option<String>,
    request_id: Option<String>,
}

#[derive(Debug)]
enum ClientFrameError {
    Invalid(String),
    StaleAttachment { request_id: Option<String> },
}

#[derive(Debug)]
enum HandshakeError {
    AccountChanged,
    Invalid(String),
}

impl From<String> for HandshakeError {
    fn from(error: String) -> Self {
        Self::Invalid(error)
    }
}

#[derive(Debug)]
enum PromptError {
    Invalid(String),
    RequestConflict,
    Busy,
    SessionUnavailable,
    Storage(String),
    Contended,
    Terminal(terminal_session::TerminalError),
}

impl PromptError {
    fn code(&self) -> &'static str {
        match self {
            Self::Busy
            | Self::Contended
            | Self::Terminal(terminal_session::TerminalError::Backpressure { .. }) => "agent_busy",
            _ => "prompt_rejected",
        }
    }

    fn message(&self) -> &'static str {
        match self {
            Self::Invalid(_) => {
                "We couldn't send this message. Refresh the chat and try again."
            }
            Self::RequestConflict => {
                "We couldn't safely retry this message. Refresh the chat and try again."
            }
            Self::Busy | Self::Contended => {
                "The coding agent is busy. Wait for it to finish, or respond directly in the terminal."
            }
            Self::SessionUnavailable => {
                "The coding agent is no longer available. Reopen the chat and try again."
            }
            Self::Storage(_) => "We couldn't send your message right now. Try again.",
            Self::Terminal(terminal_session::TerminalError::Backpressure { .. }) => {
                "The coding agent is busy. Wait a moment and try again."
            }
            Self::Terminal(terminal_session::TerminalError::InputTooLarge { .. }) => {
                "This message is too large to send. Shorten it and try again."
            }
            Self::Terminal(terminal_session::TerminalError::SessionClosed) => {
                "The coding agent is no longer available. Reopen the chat and try again."
            }
            Self::Terminal(_) => {
                "We couldn't send your message to the coding agent. Reopen the chat and try again."
            }
        }
    }

    fn retryable(&self) -> bool {
        matches!(
            self,
            Self::Busy
                | Self::Storage(_)
                | Self::Contended
                | Self::Terminal(terminal_session::TerminalError::Backpressure { .. })
        )
    }

    fn log(&self) {
        match self {
            Self::Storage(error) => {
                tracing::warn!(%error, "could not persist coding agent prompt state")
            }
            Self::Terminal(error) => {
                tracing::warn!(%error, "could not write prompt to coding agent terminal")
            }
            Self::Invalid(error) => {
                tracing::debug!(%error, "coding agent prompt validation failed")
            }
            Self::RequestConflict | Self::Busy | Self::SessionUnavailable | Self::Contended => {}
        }
    }
}

impl From<String> for ClientFrameError {
    fn from(error: String) -> Self {
        Self::Invalid(error)
    }
}

pub async fn get(
    State(state): State<AppState>,
    Path((org, thread_id)): Path<(String, String)>,
) -> ApiResult<Json<Value>> {
    let upstream_session = upstream::global();
    let _account_transition = upstream_session.begin_transition().await;
    let (db, fence) = scoped_owned_thread(&state, &org, &thread_id).await?;
    let session = db
        .rt_get_live_terminal_session_fenced(&fence)
        .map_err(|error| terminal_storage_error("load live coding agent session", error))?
        .or(db
            .rt_get_latest_terminal_session_fenced(&fence)
            .map_err(|error| terminal_storage_error("load latest coding agent session", error))?);
    Ok(Json(json!(metadata_for(
        &state,
        db,
        &fence,
        session.as_ref()
    )?)))
}

pub async fn start(
    State(state): State<AppState>,
    Path((org, thread_id)): Path<(String, String)>,
    body: Bytes,
) -> ApiResult<Response> {
    let parsed: StartTerminalBody = crate::http_util::json_body_or_default(
        &body,
        "could not read coding agent request",
    )
    .map_err(|error| {
        tracing::warn!(error = %api_error_message(error), "invalid coding agent start request");
        ApiError::bad_request(
            "We couldn't read this coding agent request. Refresh Studio and try again.",
        )
    })?;
    let harness = parse_harness(parsed.harness_id.as_deref().ok_or_else(|| {
        ApiError::bad_request("Choose a coding agent before starting this chat.")
    })?)?;
    let size = terminal_size(parsed.rows.unwrap_or(30), parsed.cols.unwrap_or(100))?;
    validate_approval_mode(&parsed.approval_mode)?;
    let scope = authority::current_account_scope().await?;
    let account_guard = authority::lock_account_scope(&scope).await?;
    let resolved = authority::resolve_scoped_thread(
        &state,
        scope.clone(),
        &org,
        &thread_id,
        ThreadAccess::ActiveOwner,
    )?;
    let account = super::sandbox_account::admit_scope(&state, &scope)?;
    drop(account_guard);
    let db = resolved.db;
    let fence = resolved.fence;
    let managed = ensure_session(
        &state,
        db,
        &fence,
        &account,
        StartOptions {
            harness,
            approval_mode: parsed.approval_mode,
            plan_mode: parsed.plan_mode,
            size,
        },
    )
    .await?;
    let row = db
        .rt_get_terminal_session_fenced(&fence, managed.session.id())
        .map_err(|error| terminal_storage_error("load started coding agent session", error))?;
    let metadata = metadata_for(&state, db, &fence, row.as_ref())?;
    Ok((StatusCode::CREATED, Json(json!(metadata))).into_response())
}

pub async fn delete(
    State(state): State<AppState>,
    Path((org, thread_id)): Path<(String, String)>,
) -> ApiResult<StatusCode> {
    // Resolve once to choose the lifecycle lock, then resolve the exact same
    // incarnation again after winning it under the account-transition fence.
    // An account switch can therefore never terminate the prior account's PTY.
    let initial =
        authority::resolve_current_thread(&state, &org, &thread_id, ThreadAccess::Owner).await?;
    let db = initial.db;
    let fence = initial.fence;
    let start_lock = state.agent_sessions.start_lock(&fence);
    let _start_guard = start_lock.lock().await;
    let upstream_session = upstream::global();
    let _account_transition = upstream_session.begin_transition().await;
    let current =
        authority::resolve_current_thread(&state, &org, &thread_id, ThreadAccess::Owner).await?;
    if current.fence != fence {
        return Err(ApiError::conflict(
            "This chat changed while the coding agent was closing. Try again.",
        ));
    }

    let preparation = state.agent_sessions.cancel_preparation(&fence);
    let cleanup_fences = preparation.fences();
    preparation.wait().await.map_err(|error| {
        tracing::warn!(%error, thread_id = %fence.thread_id, "coding agent preparation did not stop before close");
        ApiError::internal(
            "We couldn't close the coding agent preparation. Restart Studio and try again.",
        )
    })?;
    for cleanup_fence in cleanup_fences {
        launch_context::cleanup_managed_state(&state.app_root, &cleanup_fence)
            .await
            .map_err(|error| {
                tracing::warn!(%error, thread_id = %fence.thread_id, "could not clean canceled coding agent preparation");
                ApiError::internal(
                    "We couldn't clean up the canceled coding agent preparation. Restart Studio and try again.",
                )
            })?;
        state
            .agent_sessions
            .complete_managed_cleanup(&cleanup_fence);
    }
    if let Some(session) = db
        .rt_get_live_terminal_session_fenced(&fence)
        .map_err(|error| terminal_storage_error("load closing coding agent session", error))?
        .filter(|session| session.physical_state == RtTerminalPhysicalState::Starting)
    {
        mark_starting_session_exited_if_present(
            db,
            &fence,
            &session.id,
            "coding agent start was canceled before process creation",
            true,
        );
    }
    state
        .agent_sessions
        .terminate_fence(&fence)
        .await
        .map_err(|error| {
            tracing::warn!(%error, "could not terminate coding agent");
            ApiError::internal("We couldn't close the coding agent. Restart Studio and try again.")
        })?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn websocket(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    Path((org, thread_id)): Path<(String, String)>,
) -> ApiResult<Response> {
    let scope = authority::current_account_scope().await?;
    let account_guard = authority::lock_account_scope(&scope).await?;
    let resolved = authority::resolve_scoped_thread(
        &state,
        scope.clone(),
        &org,
        &thread_id,
        ThreadAccess::ActiveOwner,
    )?;
    let account = super::sandbox_account::admit_scope(&state, &scope)?;
    let account_epoch = account.epoch();
    let account_epoch_rx = state
        .sandbox_manager
        .watch_account_epoch(account_epoch)
        .map_err(ApiError::conflict)?;
    drop(account_guard);
    let db = resolved.db;
    let fence = resolved.fence;
    Ok(ws
        .max_message_size(MAX_CONTROL_FRAME_BYTES)
        .on_upgrade(move |socket| serve_socket(socket, state, db, fence, account, account_epoch_rx))
        .into_response())
}

async fn serve_socket(
    mut socket: WebSocket,
    state: AppState,
    db: &'static ThreadsDb,
    fence: RtThreadFence,
    account: crate::sandbox::manager::SandboxAccount,
    mut account_epoch_rx: tokio::sync::watch::Receiver<crate::sandbox::manager::AccountEpoch>,
) {
    let handshake = match receive_handshake(&mut socket, db, &fence, &mut account_epoch_rx).await {
        Ok(handshake) => handshake,
        Err(HandshakeError::AccountChanged) => return,
        Err(HandshakeError::Invalid(error)) => {
            tracing::warn!(%error, "coding agent terminal handshake failed");
            let _ = until_account_change(
                &mut account_epoch_rx,
                send_error_socket(
                    &mut socket,
                    "invalid_start",
                    "We couldn't open this coding agent. Refresh the chat and try again.",
                    false,
                ),
            )
            .await;
            return;
        }
    };
    let requested_size = handshake.options.size;
    let Some(managed_result) = until_account_change(
        &mut account_epoch_rx,
        ensure_session(&state, db, &fence, &account, handshake.options),
    )
    .await
    else {
        return;
    };
    let managed = match managed_result {
        Ok(managed) => managed,
        Err(error) => {
            let retryable = error
                .body
                .get("retryable")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let message = error
                .body
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("We couldn't start the coding agent. Restart Studio and try again.");
            let _ = until_account_change(
                &mut account_epoch_rx,
                send_error_socket(&mut socket, "start_failed", message, retryable),
            )
            .await;
            return;
        }
    };
    if account_epoch_changed(&account_epoch_rx) {
        return;
    }

    let mut lifecycle = state.agent_sessions.subscribe_lifecycle();
    let row = match db.rt_get_terminal_session_fenced(&fence, managed.session.id()) {
        Ok(Some(row)) => row,
        Ok(None) => {
            let _ = until_account_change(
                &mut account_epoch_rx,
                send_error_socket(
                    &mut socket,
                    "stale_session",
                    "This coding agent is no longer available. Reopen the chat and try again.",
                    false,
                ),
            )
            .await;
            return;
        }
        Err(error) => {
            tracing::warn!(%error, "could not load coding agent terminal state");
            let _ = until_account_change(
                &mut account_epoch_rx,
                send_error_socket(
                    &mut socket,
                    "storage_error",
                    "We couldn't load this chat right now. Try again.",
                    true,
                ),
            )
            .await;
            return;
        }
    };
    if account_epoch_changed(&account_epoch_rx) {
        return;
    }
    let Some(writer_result) =
        until_account_change(&mut account_epoch_rx, managed.claim_writer_lease()).await
    else {
        return;
    };
    let writer = match writer_result {
        Ok(writer) => writer,
        Err(error) => {
            tracing::warn!(%error, "could not claim coding agent terminal input ownership");
            let _ = until_account_change(
                &mut account_epoch_rx,
                send_error_socket(
                    &mut socket,
                    "writer_unavailable",
                    "We couldn't open the coding agent terminal. Restart Studio and try again.",
                    false,
                ),
            )
            .await;
            return;
        }
    };
    // Handshake dimensions belong to the new writer. Claim before resizing so
    // an older attachment cannot interleave input after this mutation.
    let Some(mutation_permit) =
        until_account_change(&mut account_epoch_rx, writer.mutation_permit()).await
    else {
        return;
    };
    if let Some(_permit) = mutation_permit {
        let Some(resize_result) = until_account_change(
            &mut account_epoch_rx,
            managed.session.resize(requested_size),
        )
        .await
        else {
            return;
        };
        if let Err(error) = resize_result {
            tracing::warn!(%error, "could not set coding agent terminal size");
            let _ = until_account_change(
                &mut account_epoch_rx,
                send_error_socket(
                    &mut socket,
                    "resize_failed",
                    "We couldn't open the coding agent terminal. Reopen the chat and try again.",
                    true,
                ),
            )
            .await;
            return;
        }
    }
    if account_epoch_changed(&account_epoch_rx) {
        return;
    }
    let initial_snapshot = managed.session.snapshot();
    let replay_until = initial_snapshot.next_offset;
    let ready = metadata_for(&state, db, &fence, Some(&row)).unwrap_or(TerminalMetadata {
        session_id: Some(managed.session.id().to_string()),
        generation: fence.generation.clone(),
        harness_id: Some(row.harness_id.clone()),
        physical_state: physical_wire(row.physical_state).to_string(),
        logical_state: logical_wire(row.logical_state).to_string(),
        thread_status: "completed".to_string(),
        last_seq: replay_until,
        provider_session_available: row.provider_session_id.is_some(),
    });
    let ready_frame = json!({
        "type": "ready",
        "sessionId": ready.session_id,
        "generation": ready.generation,
        "harnessId": ready.harness_id,
        "physicalState": ready.physical_state,
        "logicalState": ready.logical_state,
        "lastSeq": ready.last_seq,
    });
    let Some(ready_result) =
        until_account_change(&mut account_epoch_rx, send_json(&mut socket, &ready_frame)).await
    else {
        return;
    };
    if ready_result.is_err() {
        return;
    }

    if let Some(prompt) = handshake.initial_prompt {
        let request_id = handshake
            .request_id
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let Some(mutation_permit) =
            until_account_change(&mut account_epoch_rx, writer.mutation_permit()).await
        else {
            return;
        };
        match mutation_permit {
            Some(permit) => {
                let Some(result) = until_account_change(
                    &mut account_epoch_rx,
                    submit_prompt(&state, db, &fence, &managed, &prompt, &request_id),
                )
                .await
                else {
                    return;
                };
                drop(permit);
                match result {
                    Ok(()) => {
                        let frame = json!({ "type": "prompt_accepted", "requestId": request_id });
                        if until_account_change(
                            &mut account_epoch_rx,
                            send_json(&mut socket, &frame),
                        )
                        .await
                        .is_none()
                        {
                            return;
                        }
                    }
                    Err(error) => {
                        if until_account_change(
                            &mut account_epoch_rx,
                            send_prompt_error_socket(&mut socket, &request_id, &error),
                        )
                        .await
                        .is_none()
                        {
                            return;
                        }
                    }
                }
            }
            None => {
                if until_account_change(
                    &mut account_epoch_rx,
                    send_stale_attachment_socket(&mut socket, Some(&request_id)),
                )
                .await
                .is_none()
                {
                    return;
                }
            }
        }
    }

    let mut subscription = managed.session.subscribe(handshake.after_seq);
    loop {
        tokio::select! {
            biased;
            _ = account_epoch_rx.changed() => break,
            inbound = socket.recv() => {
                let Some(inbound) = inbound else { break; };
                match inbound {
                    Ok(Message::Text(text)) => {
                        let Some(frame_result) = until_account_change(
                            &mut account_epoch_rx,
                            handle_client_frame(
                                &state,
                                db,
                                &fence,
                                &managed,
                                &writer,
                                &mut socket,
                                &text,
                            ),
                        ).await else { break; };
                        if let Err(error) = frame_result {
                            match error {
                                ClientFrameError::Invalid(error) => {
                                    tracing::warn!(%error, "coding agent terminal command failed");
                                    if until_account_change(
                                        &mut account_epoch_rx,
                                        send_error_socket(
                                            &mut socket,
                                            "invalid_control",
                                            "We couldn't complete that terminal action. Reopen the chat and try again.",
                                            false,
                                        ),
                                    ).await.is_none() { break; }
                                }
                                ClientFrameError::StaleAttachment { request_id } => {
                                    if until_account_change(
                                        &mut account_epoch_rx,
                                        send_stale_attachment_socket(&mut socket, request_id.as_deref()),
                                    ).await.is_none() { break; }
                                }
                            }
                        }
                    }
                    Ok(Message::Binary(data)) => {
                        let Some(mutation_permit) = until_account_change(
                            &mut account_epoch_rx,
                            writer.mutation_permit(),
                        ).await else { break; };
                        match mutation_permit {
                            Some(_permit) => {
                                let Some(write_result) = until_account_change(
                                    &mut account_epoch_rx,
                                    managed.session.write(data),
                                ).await else { break; };
                                if let Err(error) = write_result {
                                    tracing::warn!(%error, "could not write coding agent terminal input");
                                    if until_account_change(
                                        &mut account_epoch_rx,
                                        send_error_socket(
                                            &mut socket,
                                            "input_failed",
                                            "We couldn't send input to the coding agent. Reopen the chat and try again.",
                                            true,
                                        ),
                                    ).await.is_none() { break; }
                                }
                            }
                            None => {
                                if until_account_change(
                                    &mut account_epoch_rx,
                                    send_stale_attachment_socket(&mut socket, None),
                                ).await.is_none() { break; }
                            }
                        }
                    }
                    Ok(Message::Close(_)) | Err(_) => break,
                    Ok(Message::Ping(data)) => {
                        let Some(result) = until_account_change(
                            &mut account_epoch_rx,
                            socket.send(Message::Pong(data)),
                        ).await else { break; };
                        if result.is_err() { break; }
                    }
                    Ok(Message::Pong(_)) => {}
                }
            }
            event = subscription.recv() => {
                let Ok(event) = event else { break; };
                let Some(result) = until_account_change(
                    &mut account_epoch_rx,
                    forward_terminal_event(&mut socket, event, replay_until),
                ).await else { break; };
                if result.is_err() {
                    break;
                }
            }
            lifecycle_event = lifecycle.recv() => {
                match lifecycle_event {
                    Ok(changed) if changed == fence => {
                        let Some(result) = until_account_change(
                            &mut account_epoch_rx,
                            send_state(&mut socket, db, &fence, managed.session.id()),
                        ).await else { break; };
                        if result.is_err() {
                            break;
                        }
                    }
                    Ok(_) => {}
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        let Some(result) = until_account_change(
                            &mut account_epoch_rx,
                            send_state(&mut socket, db, &fence, managed.session.id()),
                        ).await else { break; };
                        if result.is_err() {
                            break;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
        }
    }
}

fn account_epoch_changed(
    account_epoch_rx: &tokio::sync::watch::Receiver<crate::sandbox::manager::AccountEpoch>,
) -> bool {
    account_epoch_rx.has_changed().unwrap_or(true)
}

/// Await one potentially-stalled socket or terminal operation, but let an
/// account transition win whenever both outcomes are ready. This is the
/// common fence for pre-handshake waits, replay/live output, and control
/// replies; a retained account-A socket can never resume sending under B.
async fn until_account_change<T>(
    account_epoch_rx: &mut tokio::sync::watch::Receiver<crate::sandbox::manager::AccountEpoch>,
    future: impl Future<Output = T>,
) -> Option<T> {
    tokio::select! {
        biased;
        _ = account_epoch_rx.changed() => None,
        output = future => Some(output),
    }
}

async fn receive_handshake(
    socket: &mut WebSocket,
    db: &'static ThreadsDb,
    fence: &RtThreadFence,
    account_epoch_rx: &mut tokio::sync::watch::Receiver<crate::sandbox::manager::AccountEpoch>,
) -> Result<Handshake, HandshakeError> {
    loop {
        let message = tokio::select! {
            biased;
            _ = account_epoch_rx.changed() => return Err(HandshakeError::AccountChanged),
            message = socket.recv() => message
                .ok_or_else(|| "terminal connection closed before start".to_string())?
                .map_err(|error| error.to_string())?,
        };
        match message {
            Message::Text(text) => {
                let frame = parse_client_frame(&text)?;
                match frame {
                    ClientFrame::Start {
                        harness_id,
                        approval_mode,
                        plan_mode,
                        rows,
                        cols,
                        initial_prompt,
                        request_id,
                    } => {
                        let harness = parse_harness(&harness_id).map_err(api_error_message)?;
                        validate_approval_mode(&approval_mode).map_err(api_error_message)?;
                        if let Some(prompt) = initial_prompt.as_deref() {
                            validate_prompt(prompt)?;
                        }
                        if let Some(request_id) = request_id.as_deref() {
                            validate_request_id(request_id)?;
                        }
                        return Ok(Handshake {
                            options: StartOptions {
                                harness,
                                approval_mode,
                                plan_mode,
                                size: terminal_size(rows, cols).map_err(api_error_message)?,
                            },
                            after_seq: 0,
                            initial_prompt,
                            request_id,
                        });
                    }
                    ClientFrame::Attach {
                        after_seq,
                        rows,
                        cols,
                    } => {
                        let thread = db
                            .rt_get_thread_for_fence(fence)
                            .map_err(|error| error.to_string())?
                            .ok_or_else(|| "thread is no longer available".to_string())?;
                        let harness_id = thread.harness_id.ok_or_else(|| {
                            "choose Claude Code, Codex, or OpenCode before opening this chat"
                                .to_string()
                        })?;
                        return Ok(Handshake {
                            options: StartOptions {
                                harness: parse_harness(&harness_id).map_err(api_error_message)?,
                                approval_mode: "default".to_string(),
                                plan_mode: false,
                                size: terminal_size(rows, cols).map_err(api_error_message)?,
                            },
                            after_seq: after_seq.unwrap_or_default(),
                            initial_prompt: None,
                            request_id: None,
                        });
                    }
                    _ => {
                        let Some(result) = until_account_change(
                            account_epoch_rx,
                            send_error_socket(
                                socket,
                                "start_required",
                                "Choose a coding agent before using the terminal.",
                                false,
                            ),
                        )
                        .await
                        else {
                            return Err(HandshakeError::AccountChanged);
                        };
                        result.map_err(|error| error.to_string())?;
                    }
                }
            }
            Message::Close(_) => {
                return Err(HandshakeError::Invalid(
                    "terminal connection closed before start".to_string(),
                ))
            }
            Message::Ping(data) => {
                let Some(result) =
                    until_account_change(account_epoch_rx, socket.send(Message::Pong(data))).await
                else {
                    return Err(HandshakeError::AccountChanged);
                };
                result.map_err(|error| error.to_string())?;
            }
            Message::Binary(_) | Message::Pong(_) => {}
        }
    }
}

async fn ensure_session(
    state: &AppState,
    db: &'static ThreadsDb,
    fence: &RtThreadFence,
    account: &crate::sandbox::manager::SandboxAccount,
    options: StartOptions,
) -> ApiResult<ManagedTerminal> {
    let start_lock = state.agent_sessions.start_lock(fence);
    let upstream_session = upstream::global();
    {
        let _start_guard = start_lock.clone().lock_owned().await;
        let _account_transition = upstream_session.begin_transition().await;
        validate_initial_start_admission(db, fence, options.harness).await?;
        state
            .sandbox_manager
            .validate_sandbox_account(account)
            .map_err(|error| account_start_error(options.harness, error))?;
        if let Some(managed) = reusable_managed_session(state, fence, options.harness) {
            reconcile_registered_session(db, fence, managed.session.id(), options.harness)?;
            state.agent_sessions.notify_lifecycle(fence);
            return Ok(managed);
        }
    }

    // CLI readiness may invoke a bounded subprocess, so it runs without the
    // per-thread lifecycle lock. Admission is repeated afterward before any
    // durable row is reserved.
    require_supported_harness(options.harness).await?;

    let start_guard = start_lock.lock_owned().await;
    let initial_account_transition = upstream_session.begin_transition().await;
    validate_initial_start_admission(db, fence, options.harness).await?;
    state
        .sandbox_manager
        .validate_sandbox_account(account)
        .map_err(|error| account_start_error(options.harness, error))?;
    if let Some(managed) = reusable_managed_session(state, fence, options.harness) {
        reconcile_registered_session(db, fence, managed.session.id(), options.harness)?;
        state.agent_sessions.notify_lifecycle(fence);
        return Ok(managed);
    }

    let pinned = db
        .rt_harness_id_fenced(fence)
        .map_err(|error| {
            agent_start_internal_error(options.harness, "load chat coding agent", error)
        })?
        .flatten();
    if pinned
        .as_deref()
        .is_some_and(|pinned| pinned != options.harness.wire_id())
    {
        let pinned_agent = pinned
            .as_deref()
            .and_then(HarnessId::from_wire_id)
            .map(agent_display_name)
            .unwrap_or("another coding agent");
        return Err(ApiError::conflict(format!(
            "This chat is already using {pinned_agent}."
        )));
    }

    let provider_session_id = match db
        .rt_terminal_resume_decision_fenced(fence, options.harness.wire_id())
        .map_err(|error| {
            agent_start_internal_error(options.harness, "load coding agent resume state", error)
        })? {
        RtTerminalResumeDecision::Fresh => None,
        RtTerminalResumeDecision::Resume(provider_session_id) => Some(provider_session_id),
    };
    let key = crate::terminal::AgentSessionRegistry::session_key(fence)
        .map_err(|error| terminal_start_error(options.harness, error))?;
    let (terminal_session_id, preparation) =
        reserve_durable_start(&state.agent_sessions, db, fence, options.harness)?;
    let identity_generation = initial_account_transition.generation();
    drop(initial_account_transition);
    drop(start_guard);

    // Once the durable reservation exists, a detached owner performs every
    // preparation and finalizes or exits that exact row even if its HTTP or
    // WebSocket waiter disconnects.
    run_spawn_owner(
        SessionSpawnOwner {
            state: state.clone(),
            db,
            fence: fence.clone(),
            options,
            terminal_session_id,
            provider_session_id,
            hook_token: generate_hook_token(),
            mcp_token: generate_mcp_token(),
            key,
            preparation,
            upstream_session,
            account: account.clone(),
            identity_generation,
        }
        .run(),
    )
    .await
}

async fn validate_initial_start_admission(
    db: &'static ThreadsDb,
    fence: &RtThreadFence,
    harness: HarnessId,
) -> ApiResult<()> {
    require_current_account(fence)
        .await
        .map_err(|error| account_start_error(harness, error))?;
    let current_thread = db
        .rt_get_thread_for_fence(fence)
        .map_err(|error| agent_start_internal_error(harness, "load chat before start", error))?
        .ok_or_else(|| {
            ApiError::not_found("This chat is no longer available. Refresh Studio and try again.")
        })?;
    if current_thread.hidden {
        return Err(ApiError::conflict(
            "This chat is archived. Restore it before starting a coding agent.",
        ));
    }
    if db
        .rt_thread_delete_pending(fence)
        .map_err(|error| agent_start_internal_error(harness, "check chat deletion state", error))?
    {
        return Err(ApiError::conflict(
            "This chat is being deleted and can't start a coding agent.",
        ));
    }
    Ok(())
}

fn reusable_managed_session(
    state: &AppState,
    fence: &RtThreadFence,
    harness: HarnessId,
) -> Option<ManagedTerminal> {
    state.agent_sessions.get(fence).filter(|managed| {
        !managed.session.snapshot().state.is_terminal() && managed.hook.harness == harness
    })
}

fn reserve_durable_start(
    registry: &std::sync::Arc<crate::terminal::AgentSessionRegistry>,
    db: &'static ThreadsDb,
    fence: &RtThreadFence,
    harness: HarnessId,
) -> ApiResult<(String, PreparationReservation)> {
    if let Some(existing) = db
        .rt_get_live_terminal_session_fenced(fence)
        .map_err(|error| agent_start_internal_error(harness, "load live coding agent", error))?
    {
        if registry.is_preparing(fence, &existing.id) {
            return Err(retryable_start_error(ApiError::conflict(format!(
                "{} is already starting. Try again in a moment.",
                agent_display_name(harness)
            ))));
        }
        if registry
            .get(fence)
            .is_some_and(|managed| !managed.session.snapshot().state.is_terminal())
        {
            return Err(ApiError::conflict(format!(
                "We couldn't safely reopen {}. Restart Studio and try again.",
                agent_display_name(harness)
            )));
        }

        // No process-local preparation or PTY owns this live durable row, so
        // it is stale state left by a previous app process. Close the orphan;
        // the replacement reservation still has to match the thread's
        // atomically pinned harness.
        crate::terminal::lifecycle::mark_exited(
            db,
            fence,
            &existing.id,
            None,
            false,
            Some("terminal process was not present in the current app instance"),
        )
        .map_err(|error| {
            agent_start_internal_error(harness, "close interrupted coding agent session", error)
        })?;
    }

    let terminal_session_id = Uuid::new_v4().to_string();
    let commit = match db
        .rt_create_terminal_session_fenced(fence, &terminal_session_id, harness.wire_id())
        .map_err(|error| {
            agent_start_internal_error(harness, "create coding agent session", error)
        })? {
        RtTerminalSessionCreateOutcome::Created(commit) => commit,
        RtTerminalSessionCreateOutcome::ExistingLive(_) => {
            return Err(retryable_start_error(ApiError::conflict(format!(
                "{} is already starting. Try again in a moment.",
                agent_display_name(harness)
            ))));
        }
    };
    let terminal_session_id = commit.session.id.clone();
    let preparation = registry
        .reserve_preparation(fence.clone(), terminal_session_id.clone())
        .ok_or_else(|| {
            retryable_start_error(ApiError::conflict(format!(
                "{} is already starting. Try again in a moment.",
                agent_display_name(harness)
            )))
        })?;
    crate::terminal::lifecycle::emit_thread(fence, &commit.thread);
    Ok((terminal_session_id, preparation))
}

fn fail_launch_preparation(
    db: &'static ThreadsDb,
    fence: &RtThreadFence,
    terminal_session_id: &str,
    harness: HarnessId,
    error: &launch_context::LaunchContextError,
    context: &'static str,
) {
    let diagnostic = error.to_string();
    tracing::warn!(
        harness = harness.wire_id(),
        error = %diagnostic,
        "{context}"
    );
    mark_starting_session_exited_if_present(
        db,
        fence,
        terminal_session_id,
        &diagnostic,
        matches!(error, launch_context::LaunchContextError::Canceled),
    );
}

async fn validate_final_start_admission(
    state: &AppState,
    db: &'static ThreadsDb,
    fence: &RtThreadFence,
    terminal_session_id: &str,
    preparation: &PreparationReservation,
) -> ApiResult<()> {
    if !preparation.is_active() {
        return Err(ApiError::conflict(
            "This coding agent start was canceled. Reopen the chat and try again.",
        ));
    }
    let resolved = authority::resolve_current_thread(
        state,
        &fence.organization_id,
        &fence.thread_id,
        ThreadAccess::ActiveOwner,
    )
    .await?;
    if resolved.fence != *fence {
        return Err(ApiError::conflict(
            "This chat changed while the coding agent was preparing. Try again.",
        ));
    }
    validate_exact_durable_start(db, fence, terminal_session_id, preparation)
}

fn validate_exact_durable_start(
    db: &'static ThreadsDb,
    fence: &RtThreadFence,
    terminal_session_id: &str,
    preparation: &PreparationReservation,
) -> ApiResult<()> {
    if !preparation.is_active() {
        return Err(ApiError::conflict(
            "This coding agent start was canceled. Reopen the chat and try again.",
        ));
    }
    let thread = db
        .rt_get_thread_for_fence(fence)
        .map_err(|error| terminal_storage_error("recheck coding agent chat", error))?
        .ok_or_else(|| {
            ApiError::not_found("This chat is no longer available. Refresh Studio and try again.")
        })?;
    if thread.hidden {
        return Err(ApiError::conflict(
            "This chat is archived. Restore it before starting a coding agent.",
        ));
    }
    if db
        .rt_thread_delete_pending(fence)
        .map_err(|error| terminal_storage_error("recheck coding agent deletion state", error))?
    {
        return Err(ApiError::conflict(
            "This chat is being deleted and can't start a coding agent.",
        ));
    }
    let live = db
        .rt_get_live_terminal_session_fenced(fence)
        .map_err(|error| terminal_storage_error("recheck coding agent start", error))?;
    if !live.is_some_and(|session| {
        session.id == terminal_session_id
            && session.physical_state == RtTerminalPhysicalState::Starting
    }) {
        return Err(ApiError::conflict(
            "This coding agent start is no longer current. Reopen the chat and try again.",
        ));
    }
    Ok(())
}

pub(crate) fn mark_starting_session_exited_if_present(
    db: &'static ThreadsDb,
    fence: &RtThreadFence,
    terminal_session_id: &str,
    diagnostic: &str,
    requested: bool,
) {
    let row = match db.rt_get_terminal_session_fenced(fence, terminal_session_id) {
        Ok(row) => row,
        Err(error) => {
            tracing::warn!(%error, terminal_session_id, "could not inspect canceled coding agent start");
            return;
        }
    };
    if !row.is_some_and(|row| row.physical_state == RtTerminalPhysicalState::Starting) {
        return;
    }
    if let Err(error) = crate::terminal::lifecycle::mark_exited(
        db,
        fence,
        terminal_session_id,
        None,
        requested,
        Some(diagnostic),
    ) {
        tracing::warn!(%error, terminal_session_id, "could not close canceled coding agent start");
    }
}

impl SessionSpawnOwner {
    async fn run(self) -> ApiResult<ManagedTerminal> {
        let Self {
            state,
            db,
            fence,
            options,
            terminal_session_id,
            mut provider_session_id,
            mut hook_token,
            mut mcp_token,
            key,
            preparation,
            upstream_session,
            account,
            identity_generation,
        } = self;
        let mut may_recover_missing_claude_resume =
            options.harness == HarnessId::ClaudeCode && provider_session_id.is_some();
        let Some(preparation_phase) = preparation.begin_phase() else {
            mark_starting_session_exited_if_present(
                db,
                &fence,
                &terminal_session_id,
                "coding agent preparation was canceled before it began",
                true,
            );
            return Err(ApiError::conflict(
                "This coding agent start was canceled. Reopen the chat and try again.",
            ));
        };
        let cancellation = preparation_phase.cancellation();
        let launch_result = launch_context::prepare(
            &state,
            db,
            LaunchRequest {
                fence: &fence,
                terminal_session_id: &terminal_session_id,
                harness: options.harness,
                approval_mode: &options.approval_mode,
                plan_mode: options.plan_mode,
                hook_token: &hook_token,
                mcp_token: &mcp_token,
                provider_session_id: provider_session_id.as_deref(),
                cancellation: &cancellation,
                account: &account,
                identity_generation,
            },
        )
        .await;
        drop(preparation_phase);
        let mut launch = match launch_result {
            Ok(launch) => launch,
            Err(error) => {
                fail_launch_preparation(
                    db,
                    &fence,
                    &terminal_session_id,
                    options.harness,
                    &error,
                    "coding agent launch preparation failed",
                );
                return Err(launch_preparation_api_error(options.harness, &error));
            }
        };

        loop {
            let start_guard = state.agent_sessions.start_lock(&fence).lock_owned().await;
            // Linearize process creation with every sign-out/account replacement.
            // Both initial and Claude recovery preparation stay outside this
            // short gate. The exact durable reservation and owner are rechecked
            // before a hook or child process can exist.
            let admission_fences = match acquire_spawn_admission_fences(
                &state,
                &upstream_session,
                &fence,
                &launch,
                &account,
                identity_generation,
            )
            .await
            {
                Ok(fences) => fences,
                Err(error) => {
                    let diagnostic = error.message().to_string();
                    tracing::warn!(
                        harness = options.harness.wire_id(),
                        error = %diagnostic,
                        "coding agent account or workspace preparation failed"
                    );
                    let message = spawn_fence_message(options.harness, &error);
                    let _ = crate::terminal::lifecycle::mark_exited(
                        db,
                        &fence,
                        &terminal_session_id,
                        None,
                        false,
                        Some(&diagnostic),
                    );
                    return Err(match error {
                        SpawnFenceError::Account(_) => ApiError::conflict(message),
                        SpawnFenceError::WorkspaceTrust(_) => ApiError::bad_gateway(message),
                    });
                }
            };
            if let Err(error) = validate_final_start_admission(
                &state,
                db,
                &fence,
                &terminal_session_id,
                &preparation,
            )
            .await
            {
                let requested = !preparation.is_active();
                tracing::warn!(
                    harness = options.harness.wire_id(),
                    terminal_session_id,
                    "coding agent start admission changed during preparation"
                );
                mark_starting_session_exited_if_present(
                    db,
                    &fence,
                    &terminal_session_id,
                    "coding agent start admission changed during preparation",
                    requested,
                );
                return Err(error);
            }
            let spawn_fences =
                match establish_spawn_trust(&state, &fence, &launch, admission_fences).await {
                    Ok(fences) => fences,
                    Err(error) => {
                        let diagnostic = error.message().to_string();
                        tracing::warn!(
                            harness = options.harness.wire_id(),
                            error = %diagnostic,
                            "coding agent workspace preparation failed"
                        );
                        let message = spawn_fence_message(options.harness, &error);
                        mark_starting_session_exited_if_present(
                            db,
                            &fence,
                            &terminal_session_id,
                            &diagnostic,
                            false,
                        );
                        return Err(ApiError::bad_gateway(message));
                    }
                };
            let mut lifecycle = state.agent_sessions.subscribe_lifecycle();
            let hook =
                state
                    .agent_sessions
                    .reserve_hook(crate::terminal::registry::HookReservation {
                        fence: fence.clone(),
                        terminal_session_id: terminal_session_id.clone(),
                        harness: options.harness,
                        cwd: launch.cwd.clone(),
                        token: hook_token,
                        mcp_token,
                        mcp_path: launch.mcp_path.clone(),
                        title_environment: launch.title_environment.clone(),
                        expected_provider_session_id: provider_session_id.clone(),
                        account_epoch: account.epoch(),
                        identity_generation,
                    });
            let started = state
                .agent_sessions
                .manager()
                .start_or_attach_with_id(
                    key.clone(),
                    terminal_session_id.clone(),
                    command_spec(&state, &launch),
                    options.size,
                )
                .await;
            let started = match started {
                Ok(started) => started,
                Err(error) => {
                    state.agent_sessions.unregister_hook(&terminal_session_id);
                    let diagnostic = error.to_string();
                    let _ = crate::terminal::lifecycle::mark_exited(
                        db,
                        &fence,
                        &terminal_session_id,
                        None,
                        false,
                        Some(&diagnostic),
                    );
                    return Err(terminal_start_error(options.harness, error));
                }
            };
            let recover_fresh = if may_recover_missing_claude_resume {
                probe_missing_claude_resume(
                    db,
                    &fence,
                    &terminal_session_id,
                    provider_session_id.as_deref().unwrap_or_default(),
                    &started.session,
                    &mut lifecycle,
                )
                .await
            } else {
                false
            };
            if recover_fresh {
                state.agent_sessions.unregister_hook(&terminal_session_id);
                drop(hook);
                drop(spawn_fences);
                drop(start_guard);
                tracing::info!(
                    terminal_session_id,
                    "Claude resume target was missing; restarting the terminal fresh"
                );

                may_recover_missing_claude_resume = false;
                provider_session_id = None;
                hook_token = generate_hook_token();
                mcp_token = generate_mcp_token();
                let Some(preparation_phase) = preparation.begin_phase() else {
                    mark_starting_session_exited_if_present(
                        db,
                        &fence,
                        &terminal_session_id,
                        "coding agent recovery preparation was canceled before it began",
                        true,
                    );
                    return Err(ApiError::conflict(
                        "This coding agent start was canceled. Reopen the chat and try again.",
                    ));
                };
                let cancellation = preparation_phase.cancellation();
                let launch_result = launch_context::prepare(
                    &state,
                    db,
                    LaunchRequest {
                        fence: &fence,
                        terminal_session_id: &terminal_session_id,
                        harness: options.harness,
                        approval_mode: &options.approval_mode,
                        plan_mode: options.plan_mode,
                        hook_token: &hook_token,
                        mcp_token: &mcp_token,
                        provider_session_id: None,
                        cancellation: &cancellation,
                        account: &account,
                        identity_generation,
                    },
                )
                .await;
                drop(preparation_phase);
                launch = match launch_result {
                    Ok(launch) => launch,
                    Err(error) => {
                        fail_launch_preparation(
                            db,
                            &fence,
                            &terminal_session_id,
                            options.harness,
                            &error,
                            "coding agent fresh-session recovery preparation failed",
                        );
                        return Err(launch_preparation_api_error(options.harness, &error));
                    }
                };
                continue;
            }

            // A resumed Claude process stays provisional only while its local
            // checkpoint is validated. The manager owns that bounded window,
            // and the account/Claude-state fences prevent logout or config
            // replacement from missing the child. Every other process is
            // registered immediately after spawn as before.
            let managed = state.agent_sessions.register_terminal(
                db,
                fence.clone(),
                started.session.clone(),
                hook,
            );
            let pin_error = match db
                .rt_pin_harness_if_unset_fenced(
                    &fence,
                    options.harness.wire_id(),
                    Some(DESKTOP_SANDBOX_PROVIDER_KIND),
                    None,
                )
                .and_then(|updated| {
                    if updated {
                        db.rt_harness_id_fenced(&fence)
                    } else {
                        Ok(None)
                    }
                }) {
                Ok(Some(Some(ref pinned))) if pinned == options.harness.wire_id() => None,
                Ok(Some(Some(pinned))) => {
                    let pinned_agent = HarnessId::from_wire_id(&pinned)
                        .map(agent_display_name)
                        .unwrap_or("another coding agent");
                    Some((
                        format!("chat is already using {pinned}"),
                        format!("This chat is already using {pinned_agent}."),
                        false,
                    ))
                }
                Ok(_) => Some((
                    "thread is no longer available".to_string(),
                    "This chat is no longer available. Refresh Studio and try again.".to_string(),
                    false,
                )),
                Err(error) => {
                    tracing::warn!(
                        harness = options.harness.wire_id(),
                        %error,
                        "could not pin coding agent to chat"
                    );
                    Some((
                        error.to_string(),
                        format!(
                            "We couldn't finish starting {}. Try again.",
                            agent_display_name(options.harness)
                        ),
                        true,
                    ))
                }
            };
            if let Some((diagnostic, message, retryable)) = pin_error {
                let exit = started
                    .session
                    .terminate(crate::terminal::registry::termination_policy())
                    .await;
                let (exit_code, requested, process_error) = match &exit {
                    Ok(exit) => (
                        i32::try_from(exit.code).ok(),
                        exit.requested,
                        exit.error.as_deref(),
                    ),
                    Err(terminate_error) => {
                        tracing::warn!(%terminate_error, "could not reap coding agent after harness pin failure");
                        (None, false, None)
                    }
                };
                let _ = crate::terminal::lifecycle::mark_exited(
                    db,
                    &fence,
                    &terminal_session_id,
                    exit_code,
                    requested,
                    process_error.or(Some(&diagnostic)),
                );
                let api_error = ApiError::conflict(message);
                return Err(if retryable {
                    retryable_start_error(api_error)
                } else {
                    api_error
                });
            }
            // Keep the registered PTY alive if this local write fails. A
            // retry enters the managed-session fast path above and repairs
            // Starting -> Running instead of spawning a second process.
            reconcile_registered_session(db, &fence, &terminal_session_id, options.harness)?;
            state.agent_sessions.notify_lifecycle(&fence);
            return Ok(managed);
        }
    }
}

async fn probe_missing_claude_resume(
    db: &'static ThreadsDb,
    fence: &RtThreadFence,
    terminal_session_id: &str,
    expected_provider_session_id: &str,
    session: &TerminalSession,
    lifecycle: &mut tokio::sync::broadcast::Receiver<RtThreadFence>,
) -> bool {
    tracing::debug!(
        terminal_session_id,
        "probing a provisional Claude resume checkpoint"
    );
    let checkpoint_is_valid = || {
        db.rt_get_terminal_session_fenced(fence, terminal_session_id)
            .map(|row| {
                row.is_some_and(|row| {
                    row.provider_session_id.as_deref() == Some(expected_provider_session_id)
                        && !row.blocks_prior_provider_resume
                })
            })
    };
    match checkpoint_is_valid() {
        Ok(true) => {
            tracing::debug!(
                terminal_session_id,
                "provisional Claude resume already produced a valid checkpoint"
            );
            return false;
        }
        Ok(false) => {
            tracing::debug!(
                terminal_session_id,
                "provisional Claude resume has not produced a checkpoint"
            );
        }
        Err(error) => {
            tracing::warn!(%error, terminal_session_id, "could not validate Claude resume checkpoint");
            return false;
        }
    }

    let exit = session.wait();
    tokio::pin!(exit);
    let timeout = tokio::time::sleep(CLAUDE_RESUME_PROBE_TIMEOUT);
    tokio::pin!(timeout);
    loop {
        tokio::select! {
            biased;
            exit = &mut exit => {
                let row = match db.rt_get_terminal_session_fenced(fence, terminal_session_id) {
                    Ok(Some(row)) => row,
                    Ok(None) => return false,
                    Err(error) => {
                        tracing::warn!(%error, terminal_session_id, "could not inspect exited Claude resume");
                        return false;
                    }
                };
                tracing::debug!(
                    terminal_session_id,
                    provider_session_present = row.provider_session_id.is_some(),
                    provider_session_matches = row.provider_session_id.as_deref()
                        == Some(expected_provider_session_id),
                    blocks_prior_provider_resume = row.blocks_prior_provider_resume,
                    rejected_provider_session_matches = row.rejected_provider_session_id.as_deref()
                        == Some(expected_provider_session_id),
                    "inspecting an exited provisional Claude resume"
                );
                if row.provider_session_id.as_deref() == Some(expected_provider_session_id)
                    && !row.blocks_prior_provider_resume
                {
                    return false;
                }
                if row.provider_session_id.is_some() {
                    return false;
                }
                if row.blocks_prior_provider_resume {
                    return row.rejected_provider_session_id.as_deref()
                        == Some(expected_provider_session_id);
                }
                let replay = session.replay_from(0);
                let missing_resume = is_missing_claude_resume_exit(
                    &exit,
                    &replay,
                    expected_provider_session_id,
                );
                tracing::debug!(
                    terminal_session_id,
                    exit_code = exit.code,
                    exit_requested = exit.requested,
                    output_complete = exit.output_complete,
                    process_error = exit.error.is_some(),
                    replay_requested_from = replay.requested_from,
                    replay_available_from = replay.available_from,
                    replay_next_offset = replay.next_offset,
                    replay_truncated = replay.truncated,
                    missing_resume,
                    "classified an exited provisional Claude resume"
                );
                if !missing_resume {
                    return false;
                }
                match db.rt_confirm_terminal_resume_rejected_fenced(
                    fence,
                    terminal_session_id,
                    expected_provider_session_id,
                ) {
                    Ok(confirmed) => return confirmed,
                    Err(error) => {
                        tracing::warn!(
                            %error,
                            terminal_session_id,
                            "could not persist rejected Claude resume checkpoint"
                        );
                        return false;
                    }
                }
            }
            notification = lifecycle.recv() => {
                match notification {
                    Ok(_) | Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        match checkpoint_is_valid() {
                            Ok(true) => return false,
                            Ok(false) => {}
                            Err(error) => {
                                tracing::warn!(%error, terminal_session_id, "could not validate Claude resume checkpoint");
                                return false;
                            }
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => return false,
                }
            }
            () = &mut timeout => {
                tracing::debug!(
                    terminal_session_id,
                    session_state = ?session.snapshot().state,
                    "provisional Claude resume exceeded its recovery probe"
                );
                return false;
            },
        }
    }
}

fn is_missing_claude_resume_exit(
    exit: &SessionExit,
    replay: &ReplaySnapshot,
    expected_provider_session_id: &str,
) -> bool {
    if exit.code != 1
        || exit.signal.is_some()
        || exit.requested
        || !exit.output_complete
        || exit.error.is_some()
        || replay.requested_from != 0
        || replay.available_from != 0
        || replay.truncated
        || replay.next_offset > CLAUDE_RESUME_DIAGNOSTIC_MAX_BYTES
        || expected_provider_session_id.is_empty()
        || expected_provider_session_id.len() > 128
        || !expected_provider_session_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return false;
    }

    let mut raw = Vec::with_capacity(replay.next_offset as usize);
    for chunk in &replay.chunks {
        if raw.len().saturating_add(chunk.data.len()) > CLAUDE_RESUME_DIAGNOSTIC_MAX_BYTES as usize
        {
            return false;
        }
        raw.extend_from_slice(&chunk.data);
    }
    let Some(visible) = compact_terminal_ascii(&raw) else {
        return false;
    };
    let expected = format!("NoconversationfoundwithsessionID:{expected_provider_session_id}");
    visible
        .windows(expected.len())
        .any(|window| window == expected.as_bytes())
}

fn compact_terminal_ascii(input: &[u8]) -> Option<Vec<u8>> {
    #[derive(Clone, Copy)]
    enum State {
        Ground,
        Escape,
        EscapeIntermediate,
        Csi,
        Osc,
        OscEscape,
    }

    let mut state = State::Ground;
    let mut visible = Vec::with_capacity(input.len());
    for &byte in input {
        state = match state {
            State::Ground if byte == 0x1b => State::Escape,
            State::Ground => {
                if byte.is_ascii_graphic() {
                    visible.push(byte);
                }
                State::Ground
            }
            State::Escape if byte == b'[' => State::Csi,
            State::Escape if byte == b']' => State::Osc,
            State::Escape if (0x20..=0x2f).contains(&byte) => State::EscapeIntermediate,
            State::Escape if (0x30..=0x7e).contains(&byte) => State::Ground,
            State::Escape => return None,
            State::EscapeIntermediate if (0x20..=0x2f).contains(&byte) => State::EscapeIntermediate,
            State::EscapeIntermediate if (0x30..=0x7e).contains(&byte) => State::Ground,
            State::EscapeIntermediate => return None,
            State::Csi if (0x40..=0x7e).contains(&byte) => State::Ground,
            State::Csi if (0x20..=0x3f).contains(&byte) => State::Csi,
            State::Csi => return None,
            State::Osc if byte == 0x07 => State::Ground,
            State::Osc if byte == 0x1b => State::OscEscape,
            State::Osc => State::Osc,
            State::OscEscape if byte == b'\\' => State::Ground,
            State::OscEscape => return None,
        };
    }
    matches!(state, State::Ground).then_some(visible)
}

async fn run_spawn_owner<F, T>(work: F) -> ApiResult<T>
where
    F: Future<Output = ApiResult<T>> + Send + 'static,
    T: Send + 'static,
{
    tokio::spawn(work).await.map_err(|error| {
        tracing::error!(%error, "coding agent start owner failed");
        ApiError::internal(
            "We couldn't finish starting the coding agent. Restart Studio and try again.",
        )
    })?
}

async fn acquire_spawn_admission_fences(
    state: &AppState,
    upstream_session: &upstream::UpstreamSession,
    fence: &RtThreadFence,
    launch: &PreparedLaunch,
    sandbox_account: &crate::sandbox::manager::SandboxAccount,
    identity_generation: u64,
) -> Result<SpawnAdmissionFences, SpawnFenceError> {
    let claude_state = match launch.claude_state_path() {
        Some(path) => Some(
            state
                .agent_sessions
                .claude_state_lock(path)
                .lock_owned()
                .await,
        ),
        None => None,
    };
    let account = upstream_session.begin_transition().await;
    if account.generation() != identity_generation {
        return Err(SpawnFenceError::Account(
            "the upstream account changed while starting the coding agent".to_string(),
        ));
    }
    require_current_account(fence)
        .await
        .map_err(SpawnFenceError::Account)?;
    state
        .sandbox_manager
        .validate_sandbox_account(sandbox_account)
        .map_err(SpawnFenceError::Account)?;
    Ok(SpawnAdmissionFences {
        account,
        claude_state,
    })
}

async fn establish_spawn_trust(
    state: &AppState,
    fence: &RtThreadFence,
    launch: &PreparedLaunch,
    admission: SpawnAdmissionFences,
) -> Result<SpawnFences, SpawnFenceError> {
    let SpawnAdmissionFences {
        account,
        claude_state,
    } = admission;
    let account = launch
        .establish_managed_codex_hook_trust(state, &fence.account_scope, account)
        .await
        .map_err(|error| SpawnFenceError::WorkspaceTrust(error.to_string()))?;

    if claude_state.is_none() {
        return Ok(SpawnFences {
            _account: account,
            _claude_state: None,
        });
    }

    let launch = launch.clone();
    let joined = tokio::task::spawn_blocking(move || {
        let result = launch.ensure_workspace_trusted_blocking();
        (result, account, claude_state)
    })
    .await
    .map_err(|error| {
        SpawnFenceError::WorkspaceTrust(format!(
            "could not prepare Claude workspace trust: {error}"
        ))
    })?;
    let (result, account, claude_state) = joined;
    result.map_err(|error| SpawnFenceError::WorkspaceTrust(error.to_string()))?;
    Ok(SpawnFences {
        _account: account,
        _claude_state: claude_state,
    })
}

async fn require_current_account(fence: &RtThreadFence) -> Result<(), String> {
    let current = authority::current_account_scope_result()
        .await
        .map_err(|error| format!("session storage unavailable: {error}"))?
        .ok_or_else(|| {
            "the upstream account signed out while starting the coding agent".to_string()
        })?;
    if current.storage_key() != fence.account_scope {
        return Err("the upstream account changed while starting the coding agent".to_string());
    }
    Ok(())
}

async fn require_supported_harness(harness_id: HarnessId) -> ApiResult<()> {
    let argv = harness::resolve_checked(harness_id)
        .map_err(|error| harness_unavailable_error(harness_id, error))?;
    harness::detect::require_launch_ready(harness_id, &argv)
        .await
        .map_err(|error| harness_unavailable_error(harness_id, error))?;
    Ok(())
}

fn agent_display_name(harness_id: HarnessId) -> &'static str {
    match harness_id {
        HarnessId::ClaudeCode => "Claude Code",
        HarnessId::Codex => "Codex",
        HarnessId::OpenCode => "OpenCode",
    }
}

fn harness_unavailable_error(harness_id: HarnessId, error: harness::ResolveError) -> ApiError {
    tracing::warn!(
        harness = harness_id.wire_id(),
        %error,
        "coding agent launch readiness check failed"
    );
    ApiError::bad_gateway(harness_unavailable_message(harness_id, &error))
}

fn harness_unavailable_message(harness_id: HarnessId, error: &harness::ResolveError) -> String {
    let agent = agent_display_name(harness_id);
    match error {
        harness::ResolveError::NotFound(_) => {
            format!(
                "Make sure {agent} is installed on this computer, then restart Studio and try again."
            )
        }
        harness::ResolveError::UnsupportedVersion { .. } => format!(
            "{agent} needs an update to work with Studio. Update {agent}, then try again."
        ),
        harness::ResolveError::RuntimeCheckFailed(_) => format!(
            "We couldn't start {agent}. Open {agent} once to make sure it works, then try again. If the problem continues, update {agent}."
        ),
        harness::ResolveError::VersionCheckFailed(_)
        | harness::ResolveError::UnrecognizedVersion { .. } => format!(
            "We couldn't confirm that {agent} is ready. Open {agent} once to make sure it works, then try again. If the problem continues, update {agent}."
        ),
        harness::ResolveError::InvalidOverride(_) => format!(
            "We couldn't use your {agent} setup. Restart Studio and try again."
        ),
    }
}

fn launch_preparation_message(
    harness_id: HarnessId,
    error: &launch_context::LaunchContextError,
) -> String {
    let agent = agent_display_name(harness_id);
    match error {
        launch_context::LaunchContextError::Canceled => {
            "This coding agent start was canceled. Reopen the chat and try again.".to_string()
        }
        launch_context::LaunchContextError::StaleThread => {
            "This chat is no longer available. Refresh Studio and try again.".to_string()
        }
        launch_context::LaunchContextError::Harness(error) => {
            harness_unavailable_message(harness_id, error)
        }
        launch_context::LaunchContextError::VirtualMcp(_) => {
            "We couldn't load the coding agent for this chat. Refresh Studio and try again."
                .to_string()
        }
        launch_context::LaunchContextError::LocalEndpointUnavailable => {
            "Studio is still getting your coding agent ready. Try again in a moment.".to_string()
        }
        launch_context::LaunchContextError::Storage(_) => {
            "We couldn't load this chat right now. Try again.".to_string()
        }
        launch_context::LaunchContextError::Sandbox(_) => {
            format!("We couldn't prepare this workspace for {agent}. Try again in a moment.")
        }
        launch_context::LaunchContextError::Workspace(_) => {
            format!("We couldn't prepare this workspace for {agent}. Restart Studio and try again.")
        }
        launch_context::LaunchContextError::Artifacts(_)
        | launch_context::LaunchContextError::Json(_) => {
            format!("We couldn't finish preparing {agent}. Restart Studio and try again.")
        }
    }
}

fn launch_preparation_is_retryable(error: &launch_context::LaunchContextError) -> bool {
    matches!(
        error,
        launch_context::LaunchContextError::VirtualMcp(_)
            | launch_context::LaunchContextError::LocalEndpointUnavailable
            | launch_context::LaunchContextError::Storage(_)
            | launch_context::LaunchContextError::Sandbox(_)
    )
}

fn launch_preparation_api_error(
    harness_id: HarnessId,
    error: &launch_context::LaunchContextError,
) -> ApiError {
    let message = launch_preparation_message(harness_id, error);
    let api_error = match error {
        launch_context::LaunchContextError::Canceled => ApiError::conflict(message),
        launch_context::LaunchContextError::StaleThread => ApiError::not_found(message),
        launch_context::LaunchContextError::Storage(_)
        | launch_context::LaunchContextError::Workspace(_)
        | launch_context::LaunchContextError::Artifacts(_)
        | launch_context::LaunchContextError::Json(_) => ApiError::internal(message),
        launch_context::LaunchContextError::Harness(_)
        | launch_context::LaunchContextError::VirtualMcp(_)
        | launch_context::LaunchContextError::LocalEndpointUnavailable
        | launch_context::LaunchContextError::Sandbox(_) => ApiError::bad_gateway(message),
    };
    if launch_preparation_is_retryable(error) {
        retryable_start_error(api_error)
    } else {
        api_error
    }
}

fn reconcile_registered_session(
    db: &'static ThreadsDb,
    fence: &RtThreadFence,
    terminal_session_id: &str,
    harness_id: HarnessId,
) -> ApiResult<()> {
    crate::terminal::lifecycle::mark_running(db, fence, terminal_session_id).map_err(|error| {
        agent_start_internal_error(harness_id, "persist running coding agent state", error)
    })?;
    Ok(())
}

fn spawn_fence_message(harness_id: HarnessId, error: &SpawnFenceError) -> String {
    let agent = agent_display_name(harness_id);
    match error {
        SpawnFenceError::Account(_) => format!(
            "We couldn't confirm your Studio account while starting {agent}. Restart Studio and try again; if needed, sign in again."
        ),
        SpawnFenceError::WorkspaceTrust(_) => {
            format!("We couldn't finish preparing {agent}. Restart Studio and try again.")
        }
    }
}

fn account_start_message(harness_id: HarnessId) -> String {
    format!(
        "We couldn't confirm your Studio account while starting {}. Restart Studio and try again; if needed, sign in again.",
        agent_display_name(harness_id)
    )
}

fn account_start_error(harness_id: HarnessId, error: String) -> ApiError {
    tracing::warn!(
        harness = harness_id.wire_id(),
        %error,
        "could not confirm Studio account before coding agent start"
    );
    ApiError::conflict(account_start_message(harness_id))
}

fn agent_start_internal_error(
    harness_id: HarnessId,
    context: &'static str,
    error: impl std::fmt::Display,
) -> ApiError {
    tracing::warn!(
        harness = harness_id.wire_id(),
        %error,
        context,
        "coding agent start persistence failed"
    );
    retryable_start_error(ApiError::internal(format!(
        "We couldn't prepare this chat for {}. Try again.",
        agent_display_name(harness_id)
    )))
}

fn retryable_start_error(mut error: ApiError) -> ApiError {
    if let Some(body) = error.body.as_object_mut() {
        body.insert("retryable".to_string(), Value::Bool(true));
    }
    error
}

fn terminal_start_error(harness_id: HarnessId, error: terminal_session::TerminalError) -> ApiError {
    tracing::warn!(
        harness = harness_id.wire_id(),
        %error,
        "coding agent terminal process failed to start"
    );
    match error {
        terminal_session::TerminalError::ManagerShuttingDown => {
            ApiError::conflict("Studio is closing. Reopen it and try again.")
        }
        terminal_session::TerminalError::Backpressure { .. } => {
            retryable_start_error(ApiError::conflict(
                "Studio is busy starting another coding agent. Try again in a moment.",
            ))
        }
        terminal_session::TerminalError::Spawn(_)
        | terminal_session::TerminalError::WorkerStart(_)
        | terminal_session::TerminalError::Operation(_) => ApiError::bad_gateway(format!(
            "We couldn't start {}. Restart Studio and try again.",
            agent_display_name(harness_id)
        )),
        terminal_session::TerminalError::InvalidSessionKey(_)
        | terminal_session::TerminalError::InvalidTerminalSize { .. }
        | terminal_session::TerminalError::InvalidCommand(_)
        | terminal_session::TerminalError::SessionIdConflict { .. }
        | terminal_session::TerminalError::SessionClosed
        | terminal_session::TerminalError::InputTooLarge { .. }
        | terminal_session::TerminalError::TerminationTimeout { .. } => {
            ApiError::conflict(format!(
                "We couldn't safely start {}. Restart Studio and try again.",
                agent_display_name(harness_id)
            ))
        }
    }
}

fn command_spec(state: &AppState, launch: &PreparedLaunch) -> CommandSpec {
    let mut command = CommandSpec::new(&launch.program)
        .args(&launch.args)
        .cwd(&launch.cwd)
        .lifetime_lock_path(crate::shared_child_lifetime_lock_path(&state.app_root));
    for (key, value) in &launch.env {
        command = command.env(key, value);
    }
    command
}

async fn handle_client_frame(
    state: &AppState,
    db: &'static ThreadsDb,
    fence: &RtThreadFence,
    managed: &ManagedTerminal,
    writer: &WriterLeaseGuard,
    socket: &mut WebSocket,
    raw: &str,
) -> Result<(), ClientFrameError> {
    let frame = parse_client_frame(raw)?;
    let request_id = match &frame {
        ClientFrame::SubmitPrompt { request_id, .. } => Some(request_id.clone()),
        _ => None,
    };
    let Some(permit) = writer.mutation_permit().await else {
        return Err(ClientFrameError::StaleAttachment { request_id });
    };
    match frame {
        ClientFrame::Input { data } => {
            managed
                .session
                .write(Bytes::from(data.clone()))
                .await
                .map_err(|error| error.to_string())?;
            if data.contains(['\r', '\n']) {
                if let Ok(Some(row)) =
                    db.rt_get_terminal_session_fenced(fence, managed.session.id())
                {
                    if row.logical_state == RtTerminalLogicalState::WaitingInput {
                        let _ = crate::terminal::lifecycle::transition_logical(
                            db,
                            fence,
                            managed.session.id(),
                            RtTerminalLogicalState::Working,
                        );
                        state.agent_sessions.notify_lifecycle(fence);
                    }
                }
            }
        }
        ClientFrame::Resize { rows, cols } | ClientFrame::Attach { rows, cols, .. } => {
            managed
                .session
                .resize(terminal_size(rows, cols).map_err(api_error_message)?)
                .await
                .map_err(|error| error.to_string())?;
        }
        ClientFrame::Interrupt => managed
            .session
            .interrupt()
            .await
            .map_err(|error| error.to_string())?,
        ClientFrame::Terminate => {
            managed
                .session
                .terminate(crate::terminal::registry::termination_policy())
                .await
                .map_err(|error| error.to_string())?;
        }
        ClientFrame::SubmitPrompt { text, request_id } => {
            let result = submit_prompt(state, db, fence, managed, &text, &request_id).await;
            drop(permit);
            match result {
                Ok(()) => send_json(
                    socket,
                    &json!({ "type": "prompt_accepted", "requestId": request_id }),
                )
                .await
                .map_err(|error| error.to_string())?,
                Err(error) => send_prompt_error_socket(socket, &request_id, &error)
                    .await
                    .map_err(|error| error.to_string())?,
            }
        }
        ClientFrame::Start { .. } => {
            return Err(ClientFrameError::Invalid(
                "terminal session is already started".to_string(),
            ))
        }
    }
    Ok(())
}

async fn submit_prompt(
    state: &AppState,
    db: &'static ThreadsDb,
    fence: &RtThreadFence,
    managed: &ManagedTerminal,
    prompt: &str,
    request_id: &str,
) -> Result<(), PromptError> {
    let prompt = validate_prompt(prompt).map_err(PromptError::Invalid)?;
    let request_id = validate_request_id(request_id).map_err(PromptError::Invalid)?;

    // One gate is shared by every WebSocket attached to this process. It
    // makes a reconnect resend idempotent and prevents two otherwise-idle
    // clients from both passing the lifecycle check before either write.
    let mut prompt_ledger = managed.lock_prompt_ledger().await;
    match prompt_ledger.status(request_id, prompt) {
        PromptRequestStatus::Duplicate => return Ok(()),
        PromptRequestStatus::Conflict => return Err(PromptError::RequestConflict),
        PromptRequestStatus::New => {}
    }

    // Claim the logical turn before enqueueing bytes to the PTY. The revision
    // CAS is the side-effect fence: a concurrent hook checkpoint may make the
    // revision stale and retryable, while another accepted turn makes the
    // logical state busy and closes admission.
    let mut claimed = false;
    for _ in 0..8 {
        let row = db
            .rt_get_terminal_session_fenced(fence, managed.session.id())
            .map_err(|error| PromptError::Storage(error.to_string()))?
            .ok_or(PromptError::SessionUnavailable)?;
        if !matches!(
            row.logical_state,
            RtTerminalLogicalState::Idle
                | RtTerminalLogicalState::Completed
                | RtTerminalLogicalState::Failed
        ) {
            return Err(PromptError::Busy);
        }
        match db
            .rt_compare_and_set_terminal_session_state(
                fence,
                managed.session.id(),
                row.revision,
                row.physical_state,
                RtTerminalLogicalState::Working,
                None,
                None,
            )
            .map_err(|error| PromptError::Storage(error.to_string()))?
        {
            RtTerminalSessionCasOutcome::Updated(commit) => {
                crate::terminal::lifecycle::emit_thread(fence, &commit.thread);
                claimed = true;
                break;
            }
            RtTerminalSessionCasOutcome::Stale(_) => continue,
            RtTerminalSessionCasOutcome::Missing => return Err(PromptError::SessionUnavailable),
        }
    }
    if !claimed {
        return Err(PromptError::Contended);
    }
    state.agent_sessions.notify_lifecycle(fence);

    let input = format!("\u{1b}[200~{prompt}\u{1b}[201~\r");
    if let Err(error) = managed.session.write(Bytes::from(input)).await {
        let _ = crate::terminal::lifecycle::transition_logical(
            db,
            fence,
            managed.session.id(),
            RtTerminalLogicalState::Failed,
        );
        state.agent_sessions.notify_lifecycle(fence);
        return Err(PromptError::Terminal(error));
    }
    prompt_ledger.remember(request_id, prompt);
    Ok(())
}

fn validate_prompt(prompt: &str) -> Result<&str, String> {
    if prompt.trim().is_empty() {
        return Err("prompt must not be empty".to_string());
    }
    if prompt.len() > MAX_PROMPT_BYTES {
        return Err(format!("prompt exceeds {MAX_PROMPT_BYTES} bytes"));
    }
    Ok(prompt)
}

fn validate_request_id(request_id: &str) -> Result<&str, String> {
    if request_id.trim().is_empty() || request_id.len() > MAX_REQUEST_ID_BYTES {
        return Err(format!(
            "requestId must be 1..={MAX_REQUEST_ID_BYTES} bytes"
        ));
    }
    Ok(request_id)
}

async fn forward_terminal_event(
    socket: &mut WebSocket,
    event: SessionEvent,
    replay_until: u64,
) -> Result<(), axum::Error> {
    match event {
        SessionEvent::Output(chunk) => {
            send_json(
                socket,
                &json!({
                    "type": "output",
                    "seq": chunk.end,
                    "dataBase64": base64::engine::general_purpose::STANDARD.encode(&chunk.data),
                    "replay": chunk.end <= replay_until,
                }),
            )
            .await
        }
        // The subscription queues every retained chunk immediately after the
        // gap marker. Reset at the first available byte and let those chunks
        // refill the renderer exactly once instead of re-snapshotting and
        // sending the same (up to 4 MiB) tail twice.
        SessionEvent::ReplayGap { available, .. } => {
            send_json(
                socket,
                &json!({
                    "type": "reset",
                    "seq": available,
                    "dataBase64": "",
                }),
            )
            .await
        }
        SessionEvent::Exited(exit) => {
            send_json(
                socket,
                &json!({
                    "type": "exit",
                    "code": exit.code,
                    "signal": exit.signal,
                    "expected": exit.requested,
                }),
            )
            .await
        }
        SessionEvent::Resized(_) | SessionEvent::StateChanged(_) => Ok(()),
    }
}

async fn send_state(
    socket: &mut WebSocket,
    db: &'static ThreadsDb,
    fence: &RtThreadFence,
    terminal_session_id: &str,
) -> Result<(), axum::Error> {
    let Ok(Some(session)) = db.rt_get_terminal_session_fenced(fence, terminal_session_id) else {
        return Ok(());
    };
    let Ok(Some(thread)) = db.rt_thread_fenced(fence) else {
        return Ok(());
    };
    send_json(
        socket,
        &json!({
            "type": "state",
            "physicalState": physical_wire(session.physical_state),
            "logicalState": logical_wire(session.logical_state),
            "threadStatus": thread.status,
            "harnessId": session.harness_id,
        }),
    )
    .await
}

async fn scoped_owned_thread(
    state: &AppState,
    org: &str,
    thread_id: &str,
) -> ApiResult<(&'static ThreadsDb, RtThreadFence)> {
    let resolved =
        authority::resolve_current_thread(state, org, thread_id, ThreadAccess::ActiveOwner).await?;
    Ok((resolved.db, resolved.fence))
}

fn metadata_for(
    state: &AppState,
    db: &'static ThreadsDb,
    fence: &RtThreadFence,
    session: Option<&RtTerminalSession>,
) -> ApiResult<TerminalMetadata> {
    let thread = db
        .rt_thread_fenced(fence)
        .map_err(|error| terminal_storage_error("load coding agent chat metadata", error))?
        .ok_or_else(|| {
            ApiError::not_found("This chat is no longer available. Refresh Studio and try again.")
        })?;
    let live_snapshot = state
        .agent_sessions
        .get(fence)
        .map(|managed| managed.session.snapshot());
    let harness_id = session
        .map(|session| session.harness_id.clone())
        .or_else(|| thread.harness_id.clone());
    let provider_session_available = match harness_id.as_deref() {
        Some(harness_id) => matches!(
            db.rt_terminal_resume_decision_fenced(fence, harness_id)
                .map_err(|error| {
                    terminal_storage_error("load coding agent resume metadata", error)
                })?,
            RtTerminalResumeDecision::Resume(_)
        ),
        None => false,
    };
    Ok(TerminalMetadata {
        session_id: session.map(|session| session.id.clone()),
        generation: fence.generation.clone(),
        harness_id,
        physical_state: session
            .map(|session| physical_wire(session.physical_state).to_string())
            .unwrap_or_else(|| "exited".to_string()),
        logical_state: session
            .map(|session| logical_wire(session.logical_state).to_string())
            .unwrap_or_else(|| "completed".to_string()),
        thread_status: thread.status,
        last_seq: live_snapshot.map_or(0, |snapshot| snapshot.next_offset),
        provider_session_available,
    })
}

fn terminal_storage_error(context: &'static str, error: impl std::fmt::Display) -> ApiError {
    tracing::warn!(%error, context, "coding agent storage request failed");
    ApiError::internal("We couldn't load this chat right now. Try again.")
}

fn parse_harness(value: &str) -> ApiResult<HarnessId> {
    match value {
        "claude-code" => Ok(HarnessId::ClaudeCode),
        "codex" => Ok(HarnessId::Codex),
        "opencode" => Ok(HarnessId::OpenCode),
        _ => Err(ApiError::bad_request(
            "Choose Claude Code, Codex, or OpenCode.",
        )),
    }
}

fn validate_approval_mode(value: &str) -> ApiResult<()> {
    if matches!(value, "default" | "auto" | "readonly") {
        Ok(())
    } else {
        Err(ApiError::bad_request(
            "Choose a supported coding-agent access mode and try again.",
        ))
    }
}

fn terminal_size(rows: u16, cols: u16) -> ApiResult<TerminalSize> {
    if !(MIN_ROWS..=MAX_ROWS).contains(&rows) || !(MIN_COLS..=MAX_COLS).contains(&cols) {
        return Err(ApiError::bad_request(
            "We couldn't fit the terminal to this window. Resize it and try again.",
        ));
    }
    Ok(TerminalSize::new(rows, cols))
}

fn parse_client_frame(raw: &str) -> Result<ClientFrame, String> {
    if raw.len() > MAX_CONTROL_FRAME_BYTES {
        return Err("terminal control frame is too large".to_string());
    }
    serde_json::from_str(raw).map_err(|error| format!("invalid terminal control frame: {error}"))
}

fn physical_wire(state: RtTerminalPhysicalState) -> &'static str {
    match state {
        RtTerminalPhysicalState::Starting => "starting",
        RtTerminalPhysicalState::Running => "running",
        RtTerminalPhysicalState::Exited => "exited",
    }
}

fn logical_wire(state: RtTerminalLogicalState) -> &'static str {
    match state {
        RtTerminalLogicalState::Idle => "idle",
        RtTerminalLogicalState::Working => "working",
        RtTerminalLogicalState::WaitingInput => "waiting_input",
        RtTerminalLogicalState::Completed => "completed",
        RtTerminalLogicalState::Failed => "failed",
        RtTerminalLogicalState::Interrupted => "interrupted",
    }
}

fn api_error_message(error: ApiError) -> String {
    error
        .body
        .get("error")
        .and_then(Value::as_str)
        .unwrap_or("invalid terminal request")
        .to_string()
}

async fn send_json(socket: &mut WebSocket, value: &Value) -> Result<(), axum::Error> {
    socket.send(Message::Text(value.to_string())).await
}

async fn send_error_socket(
    socket: &mut WebSocket,
    code: &str,
    message: &str,
    retryable: bool,
) -> Result<(), axum::Error> {
    send_json(
        socket,
        &json!({
            "type": "error",
            "code": code,
            "message": message,
            "retryable": retryable,
        }),
    )
    .await
}

async fn send_prompt_error_socket(
    socket: &mut WebSocket,
    request_id: &str,
    error: &PromptError,
) -> Result<(), axum::Error> {
    error.log();
    send_json(
        socket,
        &json!({
            "type": "error",
            "code": error.code(),
            "message": error.message(),
            "retryable": error.retryable(),
            "requestId": request_id,
        }),
    )
    .await
}

async fn send_stale_attachment_socket(
    socket: &mut WebSocket,
    request_id: Option<&str>,
) -> Result<(), axum::Error> {
    send_json(
        socket,
        &json!({
            "type": "error",
            "code": "stale_attachment",
            "message": "This chat is being controlled from another Studio window.",
            "retryable": false,
            "requestId": request_id,
        }),
    )
    .await
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::Duration;

    use crate::routes::threads::db::RtThreadPatch;

    use super::*;

    fn terminal_preparation_fixture(
        thread_id: &str,
    ) -> (
        &'static ThreadsDb,
        RtThreadFence,
        Arc<crate::terminal::AgentSessionRegistry>,
    ) {
        let db = Box::leak(Box::new(ThreadsDb::open_in_memory().unwrap()));
        db.rt_create_thread(
            Some(thread_id),
            "org",
            "",
            None,
            "vmcp",
            None,
            "local-desktop-user",
        )
        .unwrap();
        let fence = db
            .rt_thread_fence_in_org("org", thread_id)
            .unwrap()
            .unwrap();
        (db, fence, crate::terminal::AgentSessionRegistry::new())
    }

    #[tokio::test]
    async fn account_epoch_preempts_stalled_and_ready_terminal_delivery() {
        let root = tempfile::tempdir().unwrap();
        let manager = crate::sandbox::SandboxManager::new(root.path().to_path_buf());

        let epoch = manager.account_epoch();
        let mut stalled_rx = manager.watch_account_epoch(epoch).unwrap();
        let stalled = tokio::spawn(async move {
            until_account_change(&mut stalled_rx, std::future::pending::<()>()).await
        });
        tokio::task::yield_now().await;
        let transition = manager.begin_account_transition().await.unwrap();
        assert!(tokio::time::timeout(Duration::from_secs(1), stalled)
            .await
            .expect("stalled terminal wait must be canceled promptly")
            .unwrap()
            .is_none());
        transition.complete().unwrap();

        let epoch = manager.account_epoch();
        let mut ready_rx = manager.watch_account_epoch(epoch).unwrap();
        let transition = manager.begin_account_transition().await.unwrap();
        assert_eq!(
            until_account_change(&mut ready_rx, std::future::ready("account-a-bytes")).await,
            None,
            "an epoch change must win over an already-ready sensitive frame"
        );
        transition.complete().unwrap();
    }

    #[test]
    fn protocol_accepts_only_canonical_harness_ids() {
        assert_eq!(parse_harness("claude-code").unwrap(), HarnessId::ClaudeCode);
        assert_eq!(parse_harness("codex").unwrap(), HarnessId::Codex);
        assert_eq!(parse_harness("opencode").unwrap(), HarnessId::OpenCode);
        assert!(parse_harness("claude").is_err());
        assert!(parse_harness("decopilot").is_err());
    }

    #[test]
    fn readiness_errors_are_actionable_without_exposing_cli_diagnostics() {
        let cases = [
            (
                HarnessId::ClaudeCode,
                harness::ResolveError::NotFound(
                    "claude-code CLI not found at /private/path".to_string(),
                ),
                "Make sure Claude Code is installed on this computer, then restart Studio and try again.",
            ),
            (
                HarnessId::Codex,
                harness::ResolveError::VersionCheckFailed(
                    "`codex --version` timed out after 5 seconds".to_string(),
                ),
                "We couldn't confirm that Codex is ready. Open Codex once to make sure it works, then try again. If the problem continues, update Codex.",
            ),
            (
                HarnessId::OpenCode,
                harness::ResolveError::RuntimeCheckFailed(
                    "plugin-free database probe failed for SELECT 1".to_string(),
                ),
                "We couldn't start OpenCode. Open OpenCode once to make sure it works, then try again. If the problem continues, update OpenCode.",
            ),
            (
                HarnessId::OpenCode,
                harness::ResolveError::InvalidOverride(
                    "LOCAL_API_OPENCODE_BIN contains invalid JSON".to_string(),
                ),
                "We couldn't use your OpenCode setup. Restart Studio and try again.",
            ),
        ];

        for (harness_id, error, expected) in cases {
            let message = harness_unavailable_message(harness_id, &error);
            assert_eq!(message, expected);
            assert!(!message.contains("SELECT 1"));
            assert!(!message.contains("--version"));
            assert!(!message.contains("LOCAL_API_"));
            assert!(!message.contains("/private/path"));
        }

        let unsupported = harness::resolve::require_supported_version(
            HarnessId::ClaudeCode,
            "2.1.217 (Claude Code)\n",
        )
        .unwrap_err();
        assert_eq!(
            harness_unavailable_message(HarnessId::ClaudeCode, &unsupported),
            "Claude Code needs an update to work with Studio. Update Claude Code, then try again."
        );

        let unrecognized = harness::resolve::require_supported_version(
            HarnessId::Codex,
            "Codex version unknown\n",
        )
        .unwrap_err();
        assert_eq!(
            harness_unavailable_message(HarnessId::Codex, &unrecognized),
            "We couldn't confirm that Codex is ready. Open Codex once to make sure it works, then try again. If the problem continues, update Codex."
        );
    }

    #[test]
    fn prompt_errors_are_actionable_without_exposing_internal_diagnostics() {
        let storage = PromptError::Storage(
            "SQLite error near SELECT * FROM terminal_sessions at /private/studio.db".to_string(),
        );
        assert_eq!(storage.code(), "prompt_rejected");
        assert_eq!(
            storage.message(),
            "We couldn't send your message right now. Try again."
        );
        assert!(storage.retryable());

        let terminal = PromptError::Terminal(terminal_session::TerminalError::Operation(
            "PTY write failed for process 4812".to_string(),
        ));
        assert_eq!(terminal.code(), "prompt_rejected");
        assert_eq!(
            terminal.message(),
            "We couldn't send your message to the coding agent. Reopen the chat and try again."
        );
        assert!(!terminal.retryable());

        let backpressure = PromptError::Terminal(terminal_session::TerminalError::Backpressure {
            channel: "input",
        });
        assert_eq!(backpressure.code(), "agent_busy");
        assert_eq!(
            backpressure.message(),
            "The coding agent is busy. Wait a moment and try again."
        );
        assert!(backpressure.retryable());

        let invalid = PromptError::Invalid("requestId must be 1..=512 bytes".to_string());
        assert_eq!(invalid.code(), "prompt_rejected");
        assert_eq!(
            invalid.message(),
            "We couldn't send this message. Refresh the chat and try again."
        );
        assert!(!invalid.retryable());

        let conflict = PromptError::RequestConflict;
        assert_eq!(conflict.code(), "prompt_rejected");
        assert!(!conflict.retryable());

        let busy = PromptError::Busy;
        assert_eq!(busy.code(), "agent_busy");
        assert!(busy.retryable());

        for message in [storage.message(), terminal.message(), invalid.message()] {
            assert!(!message.contains("SQLite"));
            assert!(!message.contains("SELECT"));
            assert!(!message.contains("/private"));
            assert!(!message.contains("PTY"));
            assert!(!message.contains("4812"));
            assert!(!message.contains("requestId"));
        }
    }

    #[test]
    fn terminal_start_retryability_matches_the_failure_kind() {
        let permanent = terminal_start_error(
            HarnessId::OpenCode,
            terminal_session::TerminalError::Spawn(
                "operation not permitted at /private/bin/opencode".to_string(),
            ),
        );
        assert_eq!(permanent.body.get("retryable"), None);
        assert_eq!(
            api_error_message(permanent),
            "We couldn't start OpenCode. Restart Studio and try again."
        );

        let transient = terminal_start_error(
            HarnessId::Codex,
            terminal_session::TerminalError::Backpressure { channel: "start" },
        );
        assert_eq!(
            transient.body.get("retryable").and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(
            transient.body.get("error").and_then(Value::as_str),
            Some("Studio is busy starting another coding agent. Try again in a moment.")
        );
    }

    #[test]
    fn terminal_storage_errors_keep_database_details_out_of_responses() {
        let error = terminal_storage_error(
            "load coding agent chat metadata",
            "database is locked at /private/studio.db",
        );
        let message = api_error_message(error);
        assert_eq!(message, "We couldn't load this chat right now. Try again.");
        assert!(!message.contains("database"));
        assert!(!message.contains("/private"));
    }

    #[test]
    fn launch_preparation_status_matches_the_failure_boundary() {
        let storage = launch_context::LaunchContextError::Storage(
            "database is locked at /private/studio.db".to_string(),
        );
        let storage_error = launch_preparation_api_error(HarnessId::Codex, &storage);
        assert_eq!(storage_error.status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(
            storage_error.body.get("retryable").and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(
            storage_error.body.get("error").and_then(Value::as_str),
            Some("We couldn't load this chat right now. Try again.")
        );

        let stale = launch_context::LaunchContextError::StaleThread;
        let stale_error = launch_preparation_api_error(HarnessId::Codex, &stale);
        assert_eq!(stale_error.status, StatusCode::NOT_FOUND);
        assert_eq!(stale_error.body.get("retryable"), None);

        let canceled = launch_context::LaunchContextError::Canceled;
        let canceled_error = launch_preparation_api_error(HarnessId::Codex, &canceled);
        assert_eq!(canceled_error.status, StatusCode::CONFLICT);
        assert_eq!(canceled_error.body.get("retryable"), None);
    }

    #[test]
    fn registered_starting_session_is_reconciled_before_reuse() {
        let db = Box::leak(Box::new(ThreadsDb::open_in_memory().unwrap()));
        db.rt_create_thread(Some("thread"), "org", "", None, "vmcp", None, "user")
            .unwrap();
        let fence = db.rt_thread_fence_in_org("org", "thread").unwrap().unwrap();
        let session_id = "registered-starting-session";
        assert!(matches!(
            db.rt_create_terminal_session_fenced(&fence, session_id, "codex")
                .unwrap(),
            RtTerminalSessionCreateOutcome::Created(_)
        ));
        assert_eq!(
            db.rt_get_terminal_session_fenced(&fence, session_id)
                .unwrap()
                .unwrap()
                .physical_state,
            RtTerminalPhysicalState::Starting
        );

        reconcile_registered_session(db, &fence, session_id, HarnessId::Codex).unwrap();
        assert_eq!(
            db.rt_get_terminal_session_fenced(&fence, session_id)
                .unwrap()
                .unwrap()
                .physical_state,
            RtTerminalPhysicalState::Running
        );

        // Reusing an already-running session remains idempotent.
        reconcile_registered_session(db, &fence, session_id, HarnessId::Codex).unwrap();
    }

    #[tokio::test]
    async fn archive_can_win_while_terminal_preparation_is_blocked() {
        let (db, fence, registry) = terminal_preparation_fixture("preparing-archive");
        let start_lock = registry.start_lock(&fence);
        let admission = start_lock.clone().lock_owned().await;
        let (session_id, preparation) =
            reserve_durable_start(&registry, db, &fence, HarnessId::Codex).unwrap();
        drop(admission);

        let (blocked_tx, blocked_rx) = tokio::sync::oneshot::channel();
        let task_fence = fence.clone();
        let task_session_id = session_id.clone();
        let task_lock = start_lock.clone();
        let prepared = tokio::spawn(async move {
            let phase = preparation.begin_phase().unwrap();
            let cancellation = phase.cancellation();
            blocked_tx.send(()).unwrap();
            cancellation.cancelled().await;
            drop(phase);
            let _spawn_guard = task_lock.lock_owned().await;
            let result =
                validate_exact_durable_start(db, &task_fence, &task_session_id, &preparation);
            if result.is_err() {
                mark_starting_session_exited_if_present(
                    db,
                    &task_fence,
                    &task_session_id,
                    "archive won terminal preparation",
                    false,
                );
            }
            result
        });
        blocked_rx.await.unwrap();

        let archive_guard = tokio::time::timeout(Duration::from_secs(1), start_lock.lock_owned())
            .await
            .expect("preparation must not retain the thread lifecycle lock");
        db.rt_update_thread_in_org(
            "org",
            "preparing-archive",
            "local-desktop-user",
            &RtThreadPatch {
                hidden: Some(true),
                ..RtThreadPatch::default()
            },
        )
        .unwrap()
        .unwrap();
        registry.cancel_preparation(&fence).wait().await.unwrap();
        drop(archive_guard);

        assert_eq!(
            prepared.await.unwrap().unwrap_err().status,
            StatusCode::CONFLICT
        );
        let row = db
            .rt_get_terminal_session_fenced(&fence, &session_id)
            .unwrap()
            .unwrap();
        assert_eq!(row.physical_state, RtTerminalPhysicalState::Exited);
        assert!(db.rt_get_thread_for_fence(&fence).unwrap().unwrap().hidden);
    }

    #[tokio::test]
    async fn delete_can_win_while_terminal_preparation_is_blocked() {
        let (db, fence, registry) = terminal_preparation_fixture("preparing-delete");
        let start_lock = registry.start_lock(&fence);
        let admission = start_lock.clone().lock_owned().await;
        let (session_id, preparation) =
            reserve_durable_start(&registry, db, &fence, HarnessId::Codex).unwrap();
        drop(admission);

        let (blocked_tx, blocked_rx) = tokio::sync::oneshot::channel();
        let task_fence = fence.clone();
        let task_session_id = session_id.clone();
        let task_lock = start_lock.clone();
        let prepared = tokio::spawn(async move {
            let phase = preparation.begin_phase().unwrap();
            let cancellation = phase.cancellation();
            blocked_tx.send(()).unwrap();
            cancellation.cancelled().await;
            drop(phase);
            let _spawn_guard = task_lock.lock_owned().await;
            let result =
                validate_exact_durable_start(db, &task_fence, &task_session_id, &preparation);
            if result.is_err() {
                mark_starting_session_exited_if_present(
                    db,
                    &task_fence,
                    &task_session_id,
                    "delete won terminal preparation",
                    true,
                );
            }
            result
        });
        blocked_rx.await.unwrap();

        let delete_guard = tokio::time::timeout(Duration::from_secs(1), start_lock.lock_owned())
            .await
            .expect("preparation must not retain the thread lifecycle lock");
        registry.cancel_preparation(&fence).wait().await.unwrap();
        assert!(db.rt_delete_thread_in_org_if_generation(&fence).unwrap());
        drop(delete_guard);

        assert!(prepared.await.unwrap().is_err());
        assert!(db
            .rt_get_terminal_session_fenced(&fence, &session_id)
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn account_replacement_cancels_a_blocked_terminal_preparation() {
        let (db, fence, registry) = terminal_preparation_fixture("preparing-account-switch");
        let start_lock = registry.start_lock(&fence);
        let admission = start_lock.clone().lock_owned().await;
        let (session_id, preparation) =
            reserve_durable_start(&registry, db, &fence, HarnessId::Codex).unwrap();
        drop(admission);

        let (blocked_tx, blocked_rx) = tokio::sync::oneshot::channel();
        let task_fence = fence.clone();
        let task_session_id = session_id.clone();
        let task_lock = start_lock.clone();
        let prepared = tokio::spawn(async move {
            let phase = preparation.begin_phase().unwrap();
            let cancellation = phase.cancellation();
            blocked_tx.send(()).unwrap();
            cancellation.cancelled().await;
            drop(phase);
            let _spawn_guard = task_lock.lock_owned().await;
            let result =
                validate_exact_durable_start(db, &task_fence, &task_session_id, &preparation);
            if result.is_err() {
                mark_starting_session_exited_if_present(
                    db,
                    &task_fence,
                    &task_session_id,
                    "account changed during terminal preparation",
                    false,
                );
            }
            result
        });
        blocked_rx.await.unwrap();

        assert!(registry.terminate_all().await.is_empty());

        assert_eq!(
            prepared.await.unwrap().unwrap_err().status,
            StatusCode::CONFLICT
        );
        assert_eq!(
            db.rt_get_terminal_session_fenced(&fence, &session_id)
                .unwrap()
                .unwrap()
                .physical_state,
            RtTerminalPhysicalState::Exited
        );
    }

    #[tokio::test]
    async fn concurrent_start_keeps_the_exact_in_process_preparation() {
        let (db, fence, registry) = terminal_preparation_fixture("preparing-concurrent");
        let _admission = registry.start_lock(&fence).lock_owned().await;
        let (session_id, _preparation) =
            reserve_durable_start(&registry, db, &fence, HarnessId::Codex).unwrap();

        let error = match reserve_durable_start(&registry, db, &fence, HarnessId::Codex) {
            Ok(_) => panic!("a concurrent start replaced an active preparation"),
            Err(error) => error,
        };
        assert_eq!(error.status, StatusCode::CONFLICT);
        let live = db
            .rt_get_live_terminal_session_fenced(&fence)
            .unwrap()
            .unwrap();
        assert_eq!(live.id, session_id);
        assert_eq!(live.physical_state, RtTerminalPhysicalState::Starting);
    }

    #[test]
    fn stale_starting_row_preserves_the_pin_and_self_heals_for_the_same_harness() {
        let (db, fence, registry) = terminal_preparation_fixture("preparing-stale-restart");
        db.rt_create_terminal_session_fenced(&fence, "stale-session", "claude-code")
            .unwrap();

        assert!(reserve_durable_start(&registry, db, &fence, HarnessId::Codex).is_err());
        assert_eq!(
            db.rt_harness_id_fenced(&fence)
                .unwrap()
                .flatten()
                .as_deref(),
            Some("claude-code")
        );

        let (replacement_id, _preparation) =
            reserve_durable_start(&registry, db, &fence, HarnessId::ClaudeCode).unwrap();

        assert_ne!(replacement_id, "stale-session");
        assert_eq!(
            db.rt_get_terminal_session_fenced(&fence, "stale-session")
                .unwrap()
                .unwrap()
                .physical_state,
            RtTerminalPhysicalState::Exited
        );
        assert_eq!(
            db.rt_get_terminal_session_fenced(&fence, &replacement_id)
                .unwrap()
                .unwrap()
                .physical_state,
            RtTerminalPhysicalState::Starting
        );
    }

    #[test]
    fn dimensions_are_strictly_bounded() {
        assert!(terminal_size(30, 100).is_ok());
        assert!(terminal_size(1, 100).is_err());
        assert!(terminal_size(30, 1_001).is_err());
    }

    #[test]
    fn missing_claude_resume_matcher_is_exact_bounded_and_ansi_aware() {
        let provider_session_id = "72441189-b8e2-4825-91bc-492889ff2374";
        let output = format!(
            "\u{1b}7\u{1b}[r\u{1b}8\u{1b}(B\u{1b}[2J\u{1b}[1;1HNo\u{1b}[4Gconversation\u{1b}[17Gfound\u{1b}[23Gwith\u{1b}[28Gsession\u{1b}[36GID:\u{1b}[40G{provider_session_id}\r\n"
        );
        let split = output.len() / 2;
        let replay = ReplaySnapshot {
            requested_from: 0,
            available_from: 0,
            next_offset: output.len() as u64,
            truncated: false,
            chunks: vec![
                terminal_session::OutputChunk {
                    start: 0,
                    end: split as u64,
                    data: Bytes::copy_from_slice(&output.as_bytes()[..split]),
                },
                terminal_session::OutputChunk {
                    start: split as u64,
                    end: output.len() as u64,
                    data: Bytes::copy_from_slice(&output.as_bytes()[split..]),
                },
            ],
        };
        let exit = SessionExit {
            code: 1,
            signal: None,
            requested: false,
            output_complete: true,
            error: None,
        };

        assert!(is_missing_claude_resume_exit(
            &exit,
            &replay,
            provider_session_id
        ));
        assert!(!is_missing_claude_resume_exit(
            &exit,
            &replay,
            "72441189-b8e2-4825-91bc-492889ff2375"
        ));

        let mut truncated = replay.clone();
        truncated.truncated = true;
        assert!(!is_missing_claude_resume_exit(
            &exit,
            &truncated,
            provider_session_id
        ));
        let mut oversized = replay.clone();
        oversized.next_offset = CLAUDE_RESUME_DIAGNOSTIC_MAX_BYTES + 1;
        assert!(!is_missing_claude_resume_exit(
            &exit,
            &oversized,
            provider_session_id
        ));
        let mut requested = exit.clone();
        requested.requested = true;
        assert!(!is_missing_claude_resume_exit(
            &requested,
            &replay,
            provider_session_id
        ));
        let mut incomplete = exit.clone();
        incomplete.output_complete = false;
        assert!(!is_missing_claude_resume_exit(
            &incomplete,
            &replay,
            provider_session_id
        ));
        let mut process_error = exit.clone();
        process_error.error = Some("reader failed".to_string());
        assert!(!is_missing_claude_resume_exit(
            &process_error,
            &replay,
            provider_session_id
        ));
        let mut success = exit;
        success.code = 0;
        assert!(!is_missing_claude_resume_exit(
            &success,
            &replay,
            provider_session_id
        ));
    }

    #[test]
    fn client_frame_uses_the_frontend_camel_case_contract() {
        let frame = parse_client_frame(
            r#"{"type":"start","harnessId":"codex","rows":30,"cols":100,"initialPrompt":"hello","requestId":"r1"}"#,
        )
        .unwrap();
        assert!(matches!(
            frame,
            ClientFrame::Start {
                harness_id,
                initial_prompt: Some(prompt),
                ..
            } if harness_id == "codex" && prompt == "hello"
        ));
        assert!(parse_client_frame(
            r#"{"type":"start","harness_id":"codex","rows":30,"cols":100}"#,
        )
        .is_err());
    }

    #[test]
    fn terminal_protocol_rejects_mixed_canonical_and_retired_fields() {
        assert!(serde_json::from_value::<StartTerminalBody>(json!({
            "harnessId": "codex",
            "harness_id": "claude-code",
        }))
        .is_err());
        assert!(parse_client_frame(
            r#"{"type":"start","harnessId":"codex","harness_id":"claude-code","rows":30,"cols":100}"#,
        )
        .is_err());
        assert!(parse_client_frame(
            r#"{"type":"attach","afterSeq":7,"after_seq":0,"rows":30,"cols":100}"#,
        )
        .is_err());
    }

    #[test]
    fn secrets_are_binary_output_not_control_metadata() {
        let bytes = b"\x1b[31mhello\xff";
        let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(encoded)
                .unwrap(),
            bytes
        );
    }

    #[test]
    fn prompt_limit_reserves_the_bracketed_paste_envelope() {
        let maximum = "x".repeat(MAX_PROMPT_BYTES);
        assert_eq!(validate_prompt(&maximum).unwrap().len(), MAX_PROMPT_BYTES);
        assert_eq!(
            format!("\u{1b}[200~{maximum}\u{1b}[201~\r").len(),
            TERMINAL_INPUT_BYTES
        );
        assert!(validate_prompt(&(maximum + "x")).is_err());
        assert_eq!(
            validate_prompt("  preserve me  ").unwrap(),
            "  preserve me  "
        );
        assert_eq!(
            validate_request_id("  opaque-id  ").unwrap(),
            "  opaque-id  "
        );
    }

    #[tokio::test]
    async fn spawn_owner_keeps_fences_alive_after_waiter_cancellation() {
        struct DropProbe {
            dropped: Arc<AtomicUsize>,
            changed: Arc<tokio::sync::Notify>,
        }

        impl Drop for DropProbe {
            fn drop(&mut self) {
                self.dropped.fetch_add(1, Ordering::SeqCst);
                self.changed.notify_one();
            }
        }

        let dropped = Arc::new(AtomicUsize::new(0));
        let changed = Arc::new(tokio::sync::Notify::new());
        let account_fence = DropProbe {
            dropped: dropped.clone(),
            changed: changed.clone(),
        };
        let start_fence = DropProbe {
            dropped: dropped.clone(),
            changed: changed.clone(),
        };
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        let waiter = tokio::spawn(run_spawn_owner(async move {
            let _account_fence = account_fence;
            let _start_fence = start_fence;
            let _ = started_tx.send(());
            let _ = release_rx.await;
            Ok(())
        }));

        started_rx.await.unwrap();
        waiter.abort();
        assert!(waiter.await.unwrap_err().is_cancelled());
        assert_eq!(dropped.load(Ordering::SeqCst), 0);

        release_tx.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if dropped.load(Ordering::SeqCst) == 2 {
                    break;
                }
                changed.notified().await;
            }
        })
        .await
        .unwrap();
    }
}
