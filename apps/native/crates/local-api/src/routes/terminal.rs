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
use crate::routes::intercept::thread_tools;
use crate::routes::threads::db::{
    RtAccountScope, RtTerminalLogicalState, RtTerminalPhysicalState, RtTerminalResumeDecision,
    RtTerminalSession, RtTerminalSessionCasOutcome, RtTerminalSessionCreateOutcome, RtThreadFence,
    ThreadsDb,
};
use crate::routes::threads::{db_err, shared_db};
use crate::state::AppState;
use crate::terminal::launch_context::{self, LaunchRequest, PreparedLaunch};
use crate::terminal::registry::{
    generate_hook_token, generate_mcp_token, ManagedTerminal, PromptRequestStatus, WriterLeaseGuard,
};

const MAX_CONTROL_FRAME_BYTES: usize = 256 * 1024;
const TERMINAL_INPUT_BYTES: usize = 64 * 1024;
const BRACKETED_PASTE_OVERHEAD_BYTES: usize = 13;
const MAX_PROMPT_BYTES: usize = TERMINAL_INPUT_BYTES - BRACKETED_PASTE_OVERHEAD_BYTES;
const MAX_REQUEST_ID_BYTES: usize = 512;
const DESKTOP_SANDBOX_PROVIDER: &str = "user-desktop";
const MIN_ROWS: u16 = 2;
const MAX_ROWS: u16 = 500;
const MIN_COLS: u16 = 2;
const MAX_COLS: u16 = 1_000;
const CLAUDE_RESUME_PROBE_TIMEOUT: Duration = Duration::from_secs(5);
const CLAUDE_RESUME_DIAGNOSTIC_MAX_BYTES: u64 = 64 * 1024;

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
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
    rename_all_fields = "camelCase"
)]
enum ClientFrame {
    Start {
        #[serde(alias = "harness_id")]
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
    launch: PreparedLaunch,
    command: CommandSpec,
    key: SessionKey,
    start_guard: tokio::sync::OwnedMutexGuard<()>,
    upstream_session: upstream::UpstreamSession,
}

impl SpawnFenceError {
    fn message(&self) -> &str {
        match self {
            Self::Account(message) | Self::WorkspaceTrust(message) => message,
        }
    }

    fn into_api_error(self) -> ApiError {
        match self {
            Self::Account(message) => ApiError::conflict(message),
            Self::WorkspaceTrust(message) => ApiError::bad_gateway(message),
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

impl From<String> for ClientFrameError {
    fn from(error: String) -> Self {
        Self::Invalid(error)
    }
}

pub async fn get(
    State(state): State<AppState>,
    Path((org, thread_id)): Path<(String, String)>,
) -> ApiResult<Json<Value>> {
    let (db, _scope, fence) = scoped_owned_thread(&state, &org, &thread_id).await?;
    let session = db
        .rt_get_live_terminal_session_fenced(&fence)
        .map_err(db_err)?
        .or(db
            .rt_get_latest_terminal_session_fenced(&fence)
            .map_err(db_err)?);
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
    let parsed: StartTerminalBody =
        crate::http_util::json_body_or_default(&body, "invalid terminal start JSON")?;
    let harness = parse_harness(
        parsed
            .harness_id
            .as_deref()
            .ok_or_else(|| ApiError::bad_request("harnessId is required"))?,
    )?;
    let size = terminal_size(parsed.rows.unwrap_or(30), parsed.cols.unwrap_or(100))?;
    validate_approval_mode(&parsed.approval_mode)?;
    let (db, _scope, fence) = scoped_owned_thread(&state, &org, &thread_id).await?;
    let managed = ensure_session(
        &state,
        db,
        &fence,
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
        .map_err(db_err)?;
    let metadata = metadata_for(&state, db, &fence, row.as_ref())?;
    Ok((StatusCode::CREATED, Json(json!(metadata))).into_response())
}

pub async fn delete(
    State(state): State<AppState>,
    Path((org, thread_id)): Path<(String, String)>,
) -> ApiResult<StatusCode> {
    let (_db, _scope, fence) = scoped_owned_thread(&state, &org, &thread_id).await?;
    let start_lock = state.agent_sessions.start_lock(&fence);
    let _guard = start_lock.lock().await;
    state
        .agent_sessions
        .terminate_fence(&fence)
        .await
        .map_err(|error| {
            ApiError::internal(format!("could not terminate coding agent: {error}"))
        })?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn websocket(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    Path((org, thread_id)): Path<(String, String)>,
) -> ApiResult<Response> {
    let (db, _scope, fence) = scoped_owned_thread(&state, &org, &thread_id).await?;
    Ok(ws
        .max_message_size(MAX_CONTROL_FRAME_BYTES)
        .on_upgrade(move |socket| serve_socket(socket, state, db, fence))
        .into_response())
}

async fn serve_socket(
    mut socket: WebSocket,
    state: AppState,
    db: &'static ThreadsDb,
    fence: RtThreadFence,
) {
    let handshake = match receive_handshake(&mut socket, db, &fence).await {
        Ok(handshake) => handshake,
        Err(error) => {
            let _ = send_error_socket(&mut socket, "invalid_start", &error, false).await;
            return;
        }
    };
    let requested_size = handshake.options.size;
    let managed = match ensure_session(&state, db, &fence, handshake.options).await {
        Ok(managed) => managed,
        Err(error) => {
            let message = error
                .body
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("could not start coding agent");
            let _ = send_error_socket(&mut socket, "start_failed", message, true).await;
            return;
        }
    };

    let mut lifecycle = state.agent_sessions.subscribe_lifecycle();
    let row = match db.rt_get_terminal_session_fenced(&fence, managed.session.id()) {
        Ok(Some(row)) => row,
        Ok(None) => {
            let _ = send_error_socket(
                &mut socket,
                "stale_session",
                "the terminal session is no longer available",
                false,
            )
            .await;
            return;
        }
        Err(error) => {
            let _ = send_error_socket(&mut socket, "storage_error", &error.to_string(), true).await;
            return;
        }
    };
    let writer = match managed.claim_writer_lease().await {
        Ok(writer) => writer,
        Err(error) => {
            let _ = send_error_socket(&mut socket, "writer_unavailable", error, false).await;
            return;
        }
    };
    // Handshake dimensions belong to the new writer. Claim before resizing so
    // an older attachment cannot interleave input after this mutation.
    if let Some(_permit) = writer.mutation_permit().await {
        if let Err(error) = managed.session.resize(requested_size).await {
            let _ = send_error_socket(&mut socket, "resize_failed", &error.to_string(), true).await;
            return;
        }
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
    if send_json(
        &mut socket,
        &json!({
            "type": "ready",
            "sessionId": ready.session_id,
            "generation": ready.generation,
            "harnessId": ready.harness_id,
            "physicalState": ready.physical_state,
            "logicalState": ready.logical_state,
            "lastSeq": ready.last_seq,
        }),
    )
    .await
    .is_err()
    {
        return;
    }

    if let Some(prompt) = handshake.initial_prompt {
        let request_id = handshake
            .request_id
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        match writer.mutation_permit().await {
            Some(permit) => {
                let result =
                    submit_prompt(&state, db, &fence, &managed, &prompt, &request_id).await;
                drop(permit);
                match result {
                    Ok(()) => {
                        let _ = send_json(
                            &mut socket,
                            &json!({ "type": "prompt_accepted", "requestId": request_id }),
                        )
                        .await;
                    }
                    Err(error) => {
                        let _ = send_prompt_error_socket(&mut socket, &request_id, &error).await;
                    }
                }
            }
            None => {
                let _ = send_stale_attachment_socket(&mut socket, Some(&request_id)).await;
            }
        }
    }

    let mut subscription = managed.session.subscribe(handshake.after_seq);
    loop {
        tokio::select! {
            inbound = socket.recv() => {
                let Some(inbound) = inbound else { break; };
                match inbound {
                    Ok(Message::Text(text)) => {
                        if let Err(error) = handle_client_frame(
                            &state,
                            db,
                            &fence,
                            &managed,
                            &writer,
                            &mut socket,
                            &text,
                        ).await {
                            match error {
                                ClientFrameError::Invalid(error) => {
                                    let _ = send_error_socket(&mut socket, "invalid_control", &error, false).await;
                                }
                                ClientFrameError::StaleAttachment { request_id } => {
                                    let _ = send_stale_attachment_socket(&mut socket, request_id.as_deref()).await;
                                }
                            }
                        }
                    }
                    Ok(Message::Binary(data)) => {
                        match writer.mutation_permit().await {
                            Some(_permit) => {
                                if let Err(error) = managed.session.write(data).await {
                                    let _ = send_error_socket(&mut socket, "input_failed", &error.to_string(), true).await;
                                }
                            }
                            None => {
                                let _ = send_stale_attachment_socket(&mut socket, None).await;
                            }
                        }
                    }
                    Ok(Message::Close(_)) | Err(_) => break,
                    Ok(Message::Ping(data)) => {
                        if socket.send(Message::Pong(data)).await.is_err() { break; }
                    }
                    Ok(Message::Pong(_)) => {}
                }
            }
            event = subscription.recv() => {
                let Ok(event) = event else { break; };
                if forward_terminal_event(&mut socket, event, replay_until)
                    .await
                    .is_err()
                {
                    break;
                }
            }
            lifecycle_event = lifecycle.recv() => {
                match lifecycle_event {
                    Ok(changed) if changed == fence => {
                        if send_state(&mut socket, db, &fence, managed.session.id()).await.is_err() {
                            break;
                        }
                    }
                    Ok(_) => {}
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        if send_state(&mut socket, db, &fence, managed.session.id()).await.is_err() {
                            break;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
        }
    }
}

async fn receive_handshake(
    socket: &mut WebSocket,
    db: &'static ThreadsDb,
    fence: &RtThreadFence,
) -> Result<Handshake, String> {
    loop {
        let message = socket
            .recv()
            .await
            .ok_or_else(|| "terminal connection closed before start".to_string())?
            .map_err(|error| error.to_string())?;
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
                        send_error_socket(
                            socket,
                            "start_required",
                            "send start or attach before terminal input",
                            false,
                        )
                        .await
                        .map_err(|error| error.to_string())?;
                    }
                }
            }
            Message::Close(_) => return Err("terminal connection closed before start".to_string()),
            Message::Ping(data) => socket
                .send(Message::Pong(data))
                .await
                .map_err(|error| error.to_string())?,
            Message::Binary(_) | Message::Pong(_) => {}
        }
    }
}

async fn ensure_session(
    state: &AppState,
    db: &'static ThreadsDb,
    fence: &RtThreadFence,
    options: StartOptions,
) -> ApiResult<ManagedTerminal> {
    let start_lock = state.agent_sessions.start_lock(fence);
    let start_guard = start_lock.lock_owned().await;
    let upstream_session = upstream::global();
    let initial_account_transition = upstream_session.begin_transition().await;
    require_current_account(fence)
        .await
        .map_err(ApiError::conflict)?;
    let current_thread = db
        .rt_get_thread_for_fence(fence)
        .map_err(db_err)?
        .ok_or_else(|| ApiError::not_found("thread not found"))?;
    if current_thread.hidden {
        return Err(ApiError::conflict("chat is archived"));
    }
    if db.rt_thread_delete_pending(fence).map_err(db_err)? {
        return Err(ApiError::conflict("chat is being deleted"));
    }
    if let Some(managed) = state.agent_sessions.get(fence).filter(|managed| {
        !managed.session.snapshot().state.is_terminal() && managed.hook.harness == options.harness
    }) {
        return Ok(managed);
    }
    drop(initial_account_transition);

    let pinned = db.rt_harness_id_fenced(fence).map_err(db_err)?.flatten();
    if pinned
        .as_deref()
        .is_some_and(|pinned| pinned != options.harness.wire_id())
    {
        return Err(ApiError::conflict(format!(
            "chat is already using {}",
            pinned.as_deref().unwrap_or_default()
        )));
    }

    // Fail before the durable session transaction pins this harness. The
    // launch-context check repeats at the process boundary to close the
    // executable/version TOCTOU window, but this preflight is what keeps a
    // missing or unsupported selection on the fresh-chat picker.
    require_supported_harness(options.harness).await?;

    let provider_session_id = match db
        .rt_terminal_resume_decision_fenced(fence, options.harness.wire_id())
        .map_err(db_err)?
    {
        RtTerminalResumeDecision::Fresh => None,
        RtTerminalResumeDecision::Resume(provider_session_id) => Some(provider_session_id),
    };
    let terminal_session_id = Uuid::new_v4().to_string();
    let commit = match db
        .rt_create_terminal_session_fenced(fence, &terminal_session_id, options.harness.wire_id())
        .map_err(db_err)?
    {
        RtTerminalSessionCreateOutcome::Created(commit) => commit,
        RtTerminalSessionCreateOutcome::ExistingLive(commit) => {
            // A live durable row without an in-process PTY can only be an
            // interrupted/failed start. Close it before admitting a retry.
            if let Some(managed) = state.agent_sessions.get(fence) {
                if managed.session.id() == commit.session.id
                    && !managed.session.snapshot().state.is_terminal()
                {
                    return Ok(managed);
                }
                if !managed.session.snapshot().state.is_terminal() {
                    return Err(ApiError::conflict(
                        "coding agent process ownership is inconsistent",
                    ));
                }
            }
            crate::terminal::lifecycle::mark_exited(
                db,
                fence,
                &commit.session.id,
                None,
                false,
                Some("terminal process was not present in the current app instance"),
            )
            .map_err(ApiError::internal)?;
            let replacement_id = Uuid::new_v4().to_string();
            match db
                .rt_create_terminal_session_fenced(
                    fence,
                    &replacement_id,
                    options.harness.wire_id(),
                )
                .map_err(db_err)?
            {
                RtTerminalSessionCreateOutcome::Created(commit) => commit,
                RtTerminalSessionCreateOutcome::ExistingLive(_) => {
                    return Err(ApiError::conflict("coding agent is already starting"));
                }
            }
        }
    };
    crate::terminal::lifecycle::emit_thread(fence, &commit.thread);

    let hook_token = generate_hook_token();
    let mcp_token = generate_mcp_token();
    let launch = launch_context::prepare(
        state,
        db,
        LaunchRequest {
            fence,
            terminal_session_id: &commit.session.id,
            harness: options.harness,
            approval_mode: &options.approval_mode,
            plan_mode: options.plan_mode,
            hook_token: &hook_token,
            mcp_token: &mcp_token,
            provider_session_id: provider_session_id.as_deref(),
        },
    )
    .await;
    let launch = match launch {
        Ok(launch) => launch,
        Err(error) => {
            let message = error.to_string();
            let _ = crate::terminal::lifecycle::mark_exited(
                db,
                fence,
                &commit.session.id,
                None,
                false,
                Some(&message),
            );
            return Err(ApiError::bad_gateway(message));
        }
    };
    let command = command_spec(state, &launch);
    let key = crate::terminal::AgentSessionRegistry::session_key(fence).map_err(terminal_error)?;
    run_spawn_owner(
        SessionSpawnOwner {
            state: state.clone(),
            db,
            fence: fence.clone(),
            options,
            terminal_session_id: commit.session.id,
            provider_session_id,
            hook_token,
            mcp_token,
            launch,
            command,
            key,
            start_guard,
            upstream_session,
        }
        .run(),
    )
    .await
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
            mut launch,
            mut command,
            key,
            start_guard: _start_guard,
            upstream_session,
        } = self;
        let mut may_recover_missing_claude_resume =
            options.harness == HarnessId::ClaudeCode && provider_session_id.is_some();

        loop {
            // Linearize process creation with every sign-out/account replacement.
            // Preparation above may perform network I/O and therefore stays outside
            // this short gate; the account is rechecked before trust or a child can
            // exist. Claude's path lock is acquired first so a concurrent config
            // writer never makes logout wait while this request is merely queued.
            let spawn_fences =
                match acquire_spawn_fences(&state, &upstream_session, &fence, &launch).await {
                    Ok(fences) => fences,
                    Err(error) => {
                        let message = error.message().to_string();
                        let _ = crate::terminal::lifecycle::mark_exited(
                            db,
                            &fence,
                            &terminal_session_id,
                            None,
                            false,
                            Some(&message),
                        );
                        return Err(error.into_api_error());
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
                    });
            let started = state
                .agent_sessions
                .manager()
                .start_or_attach_with_id(
                    key.clone(),
                    terminal_session_id.clone(),
                    command,
                    options.size,
                )
                .await;
            let started = match started {
                Ok(started) => started,
                Err(error) => {
                    state.agent_sessions.unregister_hook(&terminal_session_id);
                    let message = error.to_string();
                    let _ = crate::terminal::lifecycle::mark_exited(
                        db,
                        &fence,
                        &terminal_session_id,
                        None,
                        false,
                        Some(&message),
                    );
                    return Err(terminal_error(error));
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
                tracing::info!(
                    terminal_session_id,
                    "Claude resume target was missing; restarting the terminal fresh"
                );

                may_recover_missing_claude_resume = false;
                provider_session_id = None;
                hook_token = generate_hook_token();
                mcp_token = generate_mcp_token();
                launch = match launch_context::prepare(
                    &state,
                    db,
                    LaunchRequest {
                        fence: &fence,
                        terminal_session_id: &terminal_session_id,
                        harness: options.harness,
                        model_id: options.model_id.as_deref(),
                        approval_mode: &options.approval_mode,
                        plan_mode: options.plan_mode,
                        hook_token: &hook_token,
                        mcp_token: &mcp_token,
                        provider_session_id: None,
                    },
                )
                .await
                {
                    Ok(launch) => launch,
                    Err(error) => {
                        let message = error.to_string();
                        let _ = crate::terminal::lifecycle::mark_exited(
                            db,
                            &fence,
                            &terminal_session_id,
                            None,
                            false,
                            Some(&message),
                        );
                        return Err(ApiError::bad_gateway(message));
                    }
                };
                command = command_spec(&state, &launch);
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
            let account_error = require_current_account(&fence).await.err();
            let pin_error = account_error.or_else(|| {
                match db
                    .rt_pin_harness_if_unset_fenced(
                        &fence,
                        options.harness.wire_id(),
                        Some(DESKTOP_SANDBOX_PROVIDER),
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
                    Ok(Some(Some(pinned))) => Some(format!("chat is already using {pinned}")),
                    Ok(_) => Some("thread is no longer available".to_string()),
                    Err(error) => Some(error.to_string()),
                }
            });
            if let Some(error) = pin_error {
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
                    process_error.or(Some(&error)),
                );
                return Err(ApiError::conflict(error));
            }
            crate::terminal::lifecycle::mark_running(db, &fence, &terminal_session_id)
                .map_err(ApiError::internal)?;
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
        Ok(true) => return false,
        Ok(false) => {}
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
            exit = &mut exit => {
                let row = match db.rt_get_terminal_session_fenced(fence, terminal_session_id) {
                    Ok(Some(row)) => row,
                    Ok(None) => return false,
                    Err(error) => {
                        tracing::warn!(%error, terminal_session_id, "could not inspect exited Claude resume");
                        return false;
                    }
                };
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
                if !is_missing_claude_resume_exit(
                    &exit,
                    &replay,
                    expected_provider_session_id,
                ) {
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
            () = &mut timeout => return false,
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
    tokio::spawn(work)
        .await
        .map_err(|error| ApiError::internal(format!("coding agent start owner failed: {error}")))?
}

async fn acquire_spawn_fences(
    state: &AppState,
    upstream_session: &upstream::UpstreamSession,
    fence: &RtThreadFence,
    launch: &PreparedLaunch,
) -> Result<SpawnFences, SpawnFenceError> {
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
    require_current_account(fence)
        .await
        .map_err(SpawnFenceError::Account)?;
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
    let current = thread_tools::current_account_scope_result()
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
    let argv = harness::resolve_checked(harness_id).map_err(|error| {
        ApiError::bad_gateway(format!("the selected agent is unavailable: {error}"))
    })?;
    harness::detect::require_launch_ready(harness_id, &argv)
        .await
        .map_err(|error| {
            ApiError::bad_gateway(format!("the selected agent is unavailable: {error}"))
        })?;
    Ok(())
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
) -> Result<(), String> {
    let prompt = validate_prompt(prompt)?;
    let request_id = validate_request_id(request_id)?;

    // One gate is shared by every WebSocket attached to this process. It
    // makes a reconnect resend idempotent and prevents two otherwise-idle
    // clients from both passing the lifecycle check before either write.
    let mut prompt_ledger = managed.lock_prompt_ledger().await;
    match prompt_ledger.status(request_id, prompt) {
        PromptRequestStatus::Duplicate => return Ok(()),
        PromptRequestStatus::Conflict => {
            return Err("requestId was already accepted with different prompt text".to_string())
        }
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
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "terminal session is no longer available".to_string())?;
        if !matches!(
            row.logical_state,
            RtTerminalLogicalState::Idle
                | RtTerminalLogicalState::Completed
                | RtTerminalLogicalState::Failed
        ) {
            return Err(
                "coding agent is busy; type directly in the terminal to respond".to_string(),
            );
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
            .map_err(|error| error.to_string())?
        {
            RtTerminalSessionCasOutcome::Updated(commit) => {
                crate::terminal::lifecycle::emit_thread(fence, &commit.thread);
                claimed = true;
                break;
            }
            RtTerminalSessionCasOutcome::Stale(_) => continue,
            RtTerminalSessionCasOutcome::Missing => {
                return Err("terminal session is no longer available".to_string())
            }
        }
    }
    if !claimed {
        return Err("terminal state changed too many times while accepting prompt".to_string());
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
        return Err(error.to_string());
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
) -> ApiResult<(&'static ThreadsDb, RtAccountScope, RtThreadFence)> {
    let scope = thread_tools::current_account_scope_result()
        .await
        .map_err(|error| ApiError::internal(format!("session storage unavailable: {error}")))?
        .ok_or_else(ApiError::unauthorized)?;
    let db = shared_db(state)?;
    let thread = db
        .rt_get_thread_in_scope(&scope, org, thread_id)
        .map_err(db_err)?
        .ok_or_else(|| ApiError::not_found("thread not found"))?;
    if thread.created_by != scope.user_id {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "this chat is read-only",
        ));
    }
    if thread.hidden {
        return Err(ApiError::conflict("chat is archived"));
    }
    let fence = db
        .rt_thread_fence_in_scope(&scope, org, thread_id)
        .map_err(db_err)?
        .ok_or_else(|| ApiError::not_found("thread not found"))?;
    Ok((db, scope, fence))
}

fn metadata_for(
    state: &AppState,
    db: &'static ThreadsDb,
    fence: &RtThreadFence,
    session: Option<&RtTerminalSession>,
) -> ApiResult<TerminalMetadata> {
    let thread = db
        .rt_thread_fenced(fence)
        .map_err(db_err)?
        .ok_or_else(|| ApiError::not_found("thread not found"))?;
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
                .map_err(db_err)?,
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

fn parse_harness(value: &str) -> ApiResult<HarnessId> {
    match value {
        "claude" | "claude-code" => Ok(HarnessId::ClaudeCode),
        "codex" => Ok(HarnessId::Codex),
        "opencode" => Ok(HarnessId::OpenCode),
        _ => Err(ApiError::bad_request(
            "harnessId must be claude-code, codex, or opencode",
        )),
    }
}

fn validate_approval_mode(value: &str) -> ApiResult<()> {
    if matches!(value, "default" | "auto" | "readonly") {
        Ok(())
    } else {
        Err(ApiError::bad_request(
            "approvalMode must be default, auto, or readonly",
        ))
    }
}

fn terminal_size(rows: u16, cols: u16) -> ApiResult<TerminalSize> {
    if !(MIN_ROWS..=MAX_ROWS).contains(&rows) || !(MIN_COLS..=MAX_COLS).contains(&cols) {
        return Err(ApiError::bad_request(format!(
            "terminal dimensions must be {MIN_ROWS}..={MAX_ROWS} rows and {MIN_COLS}..={MAX_COLS} columns"
        )));
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

fn terminal_error(error: terminal_session::TerminalError) -> ApiError {
    match error {
        terminal_session::TerminalError::ManagerShuttingDown => {
            ApiError::conflict("the app is shutting down")
        }
        terminal_session::TerminalError::Backpressure { .. } => {
            ApiError::conflict(error.to_string())
        }
        terminal_session::TerminalError::InputTooLarge { .. }
        | terminal_session::TerminalError::InvalidCommand(_)
        | terminal_session::TerminalError::InvalidSessionKey(_)
        | terminal_session::TerminalError::InvalidTerminalSize { .. } => {
            ApiError::bad_request(error.to_string())
        }
        _ => ApiError::bad_gateway(error.to_string()),
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
    message: &str,
) -> Result<(), axum::Error> {
    send_json(
        socket,
        &json!({
            "type": "error",
            "code": "prompt_rejected",
            "message": message,
            "retryable": false,
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
            "message": "this terminal is read-only because a newer attachment owns input",
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

    use super::*;

    #[test]
    fn protocol_accepts_canonical_and_legacy_claude_ids() {
        assert_eq!(parse_harness("claude-code").unwrap(), HarnessId::ClaudeCode);
        assert_eq!(parse_harness("claude").unwrap(), HarnessId::ClaudeCode);
        assert_eq!(parse_harness("codex").unwrap(), HarnessId::Codex);
        assert_eq!(parse_harness("opencode").unwrap(), HarnessId::OpenCode);
        assert!(parse_harness("decopilot").is_err());
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
