//! Guarded native terminal routes and WebSocket bridge.

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
use terminal_session::{CommandSpec, SessionEvent, TerminalSize};
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
                            "choose Claude Code or Codex before opening this chat".to_string()
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
    let _guard = start_lock.lock().await;
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
    let hook = state
        .agent_sessions
        .reserve_hook(crate::terminal::registry::HookReservation {
            fence: fence.clone(),
            terminal_session_id: commit.session.id.clone(),
            harness: options.harness,
            cwd: launch.cwd.clone(),
            token: hook_token,
            mcp_token,
            mcp_path: launch.mcp_path.clone(),
            title_environment: launch.title_environment.clone(),
        });
    let key = crate::terminal::AgentSessionRegistry::session_key(fence).map_err(terminal_error)?;
    // Linearize process creation with every sign-out/account replacement.
    // Preparation above may perform network I/O and therefore stays outside
    // this short gate; the account is rechecked before a child can exist.
    let _account_transition = upstream_session.begin_transition().await;
    if let Err(message) = require_current_account(fence).await {
        state.agent_sessions.unregister_hook(&commit.session.id);
        let _ = crate::terminal::lifecycle::mark_exited(
            db,
            fence,
            &commit.session.id,
            None,
            false,
            Some(&message),
        );
        return Err(ApiError::conflict(message));
    }
    let started = state
        .agent_sessions
        .manager()
        .start_or_attach_with_id(key, commit.session.id.clone(), command, options.size)
        .await;
    let started = match started {
        Ok(started) => started,
        Err(error) => {
            state.agent_sessions.unregister_hook(&commit.session.id);
            let message = error.to_string();
            let _ = crate::terminal::lifecycle::mark_exited(
                db,
                fence,
                &commit.session.id,
                None,
                false,
                Some(&message),
            );
            return Err(terminal_error(error));
        }
    };
    let resume_marker_error = if provider_session_id.is_some() {
        match db.rt_mark_terminal_resume_attempted_fenced(fence, &commit.session.id) {
            Ok(true) => None,
            Ok(false) => Some("terminal resume attempt is no longer available".to_string()),
            Err(error) => Some(error.to_string()),
        }
    } else {
        None
    };
    // Register immediately after spawn so logout/account switching cannot
    // miss a child in the gap between process creation and durable pinning.
    let managed =
        state
            .agent_sessions
            .register_terminal(db, fence.clone(), started.session.clone(), hook);
    let account_error = require_current_account(fence).await.err();
    let pin_error = resume_marker_error.or(account_error).or_else(|| {
        match db
            .rt_pin_harness_if_unset_fenced(
                fence,
                options.harness.wire_id(),
                Some(DESKTOP_SANDBOX_PROVIDER),
                None,
            )
            .and_then(|updated| {
                if updated {
                    db.rt_harness_id_fenced(fence)
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
            fence,
            &commit.session.id,
            exit_code,
            requested,
            process_error.or(Some(&error)),
        );
        return Err(ApiError::conflict(error));
    }
    crate::terminal::lifecycle::mark_running(db, fence, &commit.session.id)
        .map_err(ApiError::internal)?;
    state.agent_sessions.notify_lifecycle(fence);
    Ok(managed)
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
    harness::detect::require_supported_version(harness_id, &argv)
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
        _ => Err(ApiError::bad_request(
            "harnessId must be claude-code or codex",
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
    use super::*;

    #[test]
    fn protocol_accepts_canonical_and_legacy_claude_ids() {
        assert_eq!(parse_harness("claude-code").unwrap(), HarnessId::ClaudeCode);
        assert_eq!(parse_harness("claude").unwrap(), HarnessId::ClaudeCode);
        assert_eq!(parse_harness("codex").unwrap(), HarnessId::Codex);
        assert!(parse_harness("decopilot").is_err());
    }

    #[test]
    fn dimensions_are_strictly_bounded() {
        assert!(terminal_size(30, 100).is_ok());
        assert!(terminal_size(1, 100).is_err());
        assert!(terminal_size(30, 1_001).is_err());
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
}
