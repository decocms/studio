//! `/_sandbox/tasks*` — byte-parity target: `daemon/routes/tasks.ts` (the
//! `TaskSummary` shape lives in `tasks/registry.rs`, ported from
//! `process/task-manager.ts`), oracle `daemon.e2e.test.ts` (`tasks`
//! describe block) + `daemon.sse-shapes.e2e.test.ts` (the `"tasks"` SSE
//! event shape, pinned by `crate::process_util`'s shared `emit_tasks_event`
//! and its payload-shape test — this file only serves the
//! query/kill/delete/stream surface below).
//!
//! All six handlers below operate purely against the resolved target's
//! `TaskRegistry` — they never spawn a process themselves; that's the
//! `bash`/`scripts` families' job (whichever spawned the task calls
//! `TaskRegistry::insert`/kill-handle wiring).

use axum::body::Bytes as BodyBytes;
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, HeaderName, HeaderValue};
use axum::response::Response;
use axum::Json;
use futures_util::stream::{self, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::broadcast;

use crate::error::{ApiError, ApiResult};
use crate::sandbox::SandboxTarget;
use crate::state::AppState;
use crate::tasks::{KillSignal, OutputStream, StreamEvent, TaskStatus};

/// Resolve a task target without ever degrading an explicit sandbox identity
/// to the process-global registry. After a backend restart a known durable
/// handle is metadata-adopted (no process spawn); a genuinely unknown handle
/// is a truthful 404. Only an absent handle uses active/global compatibility.
async fn resolve(state: &AppState, handle: Option<&str>) -> ApiResult<SandboxTarget> {
    let Some(handle) = handle.filter(|handle| !handle.is_empty()) else {
        return Ok(state.resolve_sandbox_target(None));
    };
    match state.sandbox_manager.adopt(handle).await {
        Ok(Some(sandbox)) => Ok(SandboxTarget::from_sandbox(&sandbox)),
        Ok(None) => Err(ApiError::not_found(format!(
            "unknown sandbox handle: {handle}"
        ))),
        Err(error) => Err(ApiError::internal(format!(
            "failed to resolve sandbox handle {handle}: {error}"
        ))),
    }
}

async fn resolve_headers(state: &AppState, headers: &HeaderMap) -> ApiResult<SandboxTarget> {
    resolve(state, crate::sandbox::handle_from_headers(headers)).await
}

#[derive(Deserialize)]
pub struct StatusQuery {
    status: Option<String>,
}

/// Optional `?handle=` for the SSE `stream` route (a native `EventSource`
/// can't set the handle header) — the header still wins when both are present.
#[derive(Deserialize)]
pub struct HandleQuery {
    handle: Option<String>,
}

/// `GET /_sandbox/tasks?status=a,b`. Byte-parity quirk carried over from
/// `tasks.ts`: if `status` is present but every comma-separated token is
/// unrecognized, the filter degrades to "no filter" (list everything)
/// rather than "match nothing".
pub async fn list(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<StatusQuery>,
) -> ApiResult<Json<Value>> {
    let parsed: Option<Vec<TaskStatus>> = q
        .status
        .as_deref()
        .map(|s| s.split(',').filter_map(TaskStatus::parse).collect());
    let filter: Option<&[TaskStatus]> = match &parsed {
        Some(v) if !v.is_empty() => Some(v.as_slice()),
        _ => None,
    };
    let tasks = resolve_headers(&state, &headers).await?.tasks.list(filter);
    Ok(Json(json!({ "tasks": tasks })))
}

/// `GET /_sandbox/tasks/:id` — `TaskSummary & {stdout,stderr,truncated}`.
pub async fn get(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    let target = resolve_headers(&state, &headers).await?;
    let summary = target
        .tasks
        .get_exposed(&id)
        .ok_or_else(|| ApiError::not_found("task not found"))?;
    let (stdout, stderr, truncated) = target.tasks.output_exposed(&id).await.unwrap_or_default();
    let mut value = serde_json::to_value(&summary).unwrap_or_else(|_| json!({}));
    if let Value::Object(map) = &mut value {
        map.insert("stdout".to_string(), json!(stdout));
        map.insert("stderr".to_string(), json!(stderr));
        map.insert("truncated".to_string(), json!(truncated));
    }
    Ok(Json(value))
}

#[derive(Deserialize)]
pub struct SignalQuery {
    signal: Option<String>,
}

/// `POST /_sandbox/tasks/:id/kill?signal=SIGTERM|SIGKILL`. Byte-parity with
/// `tasks.ts`: an unknown id and a known-but-not-running id both surface as
/// `400 {"error":"task not running"}` — there is no 404 branch here.
pub async fn kill(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Query(q): Query<SignalQuery>,
) -> ApiResult<Json<Value>> {
    let signal = match q.signal.as_deref() {
        Some("SIGKILL") => KillSignal::Kill,
        _ => KillSignal::Term,
    };
    match resolve_headers(&state, &headers)
        .await?
        .tasks
        .kill_exposed(&id, signal)
    {
        Some(true) => Ok(Json(json!({"ok": true}))),
        _ => Err(ApiError::bad_request("task not running")),
    }
}

/// `POST /_sandbox/tasks/kill-all`.
pub async fn kill_all(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    let killed = resolve_headers(&state, &headers)
        .await?
        .tasks
        .kill_all(KillSignal::Term);
    Ok(Json(json!({"ok": true, "killed": killed})))
}

/// `DELETE /_sandbox/tasks/:id`. Byte-parity with `tasks.ts`: unknown id
/// and still-running id both surface as
/// `400 {"error":"task not found or still running"}`.
pub async fn delete(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    match resolve_headers(&state, &headers)
        .await?
        .tasks
        .remove_exposed(&id)
        .await
    {
        Some(true) => Ok(Json(json!({"ok": true}))),
        _ => Err(ApiError::bad_request("task not found or still running")),
    }
}

/// SSE: replays buffered stdout/stderr events, then live, then `end` and
/// closes. Byte-parity framing: `the native local-API contract
/// #sse-framing` (`event: <name>\ndata: <json>\n\n`, verbatim with
/// `sseFormat()`).
pub async fn stream(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Query(q): Query<HandleQuery>,
) -> Result<Response, ApiError> {
    // Handle from the header (fetch/`FetchEventSource`) OR `?handle=` (native
    // `EventSource`), header winning. An explicit unknown handle is never
    // allowed to fall through to active/global.
    let handle = crate::sandbox::handle_from_headers(&headers)
        .map(str::to_string)
        .or(q.handle);
    let target = resolve(&state, handle.as_deref()).await?;

    // Subscribe BEFORE reading the summary/output snapshot: if the task is
    // still running at that snapshot, this subscription is guaranteed to
    // see the eventual `StreamEvent::End` (finalize() sends it under the
    // same lock as the terminal status flip — see `tasks/registry.rs`), no
    // matter how the two events interleave with our check below.
    let Some(rx) = target.tasks.subscribe_output_exposed(&id) else {
        return Err(ApiError::not_found("task not found"));
    };
    let Some(summary) = target.tasks.get_exposed(&id) else {
        return Err(ApiError::not_found("task not found"));
    };
    let (stdout, stderr, _truncated) = target.tasks.output_exposed(&id).await.unwrap_or_default();

    let mut frames: Vec<BodyBytes> = Vec::new();
    if !stdout.is_empty() {
        frames.push(sse_bytes(
            OutputStream::Stdout.as_str(),
            &json!({"data": stdout}),
        ));
    }
    if !stderr.is_empty() {
        frames.push(sse_bytes(
            OutputStream::Stderr.as_str(),
            &json!({"data": stderr}),
        ));
    }

    let body_stream: futures_util::stream::BoxStream<
        'static,
        Result<BodyBytes, std::convert::Infallible>,
    > = if summary.status.is_terminal() {
        frames.push(end_frame(
            summary.status,
            summary.exit_code,
            summary.timed_out,
        ));
        Box::pin(stream::iter(frames.into_iter().map(Ok)))
    } else {
        let live = stream::unfold(LiveState::Recv(rx), live_step);
        Box::pin(stream::iter(frames.into_iter().map(Ok)).chain(live))
    };

    let mut response = Response::new(axum::body::Body::from_stream(body_stream));
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/event-stream"),
    );
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    headers.insert(header::CONNECTION, HeaderValue::from_static("keep-alive"));
    headers.insert(
        HeaderName::from_static("x-accel-buffering"),
        HeaderValue::from_static("no"),
    );
    Ok(response)
}

enum LiveState {
    Recv(broadcast::Receiver<StreamEvent>),
    Done,
}

async fn live_step(
    state: LiveState,
) -> Option<(Result<BodyBytes, std::convert::Infallible>, LiveState)> {
    let mut rx = match state {
        LiveState::Done => return None,
        LiveState::Recv(rx) => rx,
    };
    loop {
        match rx.recv().await {
            Ok(StreamEvent::Chunk { stream, data }) => {
                return Some((
                    Ok(sse_bytes(stream.as_str(), &json!({"data": data}))),
                    LiveState::Recv(rx),
                ));
            }
            Ok(StreamEvent::End {
                status,
                exit_code,
                timed_out,
            }) => {
                return Some((Ok(end_frame(status, exit_code, timed_out)), LiveState::Done));
            }
            Err(broadcast::error::RecvError::Lagged(_)) => continue,
            Err(broadcast::error::RecvError::Closed) => return None,
        }
    }
}

fn end_frame(status: TaskStatus, exit_code: Option<i32>, timed_out: bool) -> BodyBytes {
    sse_bytes(
        "end",
        &json!({"status": status.as_str(), "exitCode": exit_code, "timedOut": timed_out}),
    )
}

/// `event: <name>\ndata: <json>\n\n` — byte-parity verbatim with
/// `sseFormat()` in `daemon/events/sse-format.ts`.
fn sse_bytes(event: &str, data: &Value) -> BodyBytes {
    let payload = serde_json::to_string(data).unwrap_or_else(|_| "null".to_string());
    BodyBytes::from(format!("event: {event}\ndata: {payload}\n\n"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn test_state() -> AppState {
        let app_root = tempfile::tempdir().unwrap().keep();
        let repo_dir = app_root.join("repo");
        let config = Arc::new(crate::config::ConfigStore::new());
        let logs = Arc::new(crate::log_store::LogStore::new(app_root.join("logs")));
        let tasks = Arc::new(crate::tasks::TaskRegistry::new(logs));
        let broadcaster = Arc::new(crate::events::Broadcaster::new());
        let setup = crate::setup::SetupOrchestrator::new(
            repo_dir.clone(),
            repo_dir.clone(),
            config.clone(),
            tasks.clone(),
            broadcaster.clone(),
        );
        AppState {
            update: None,
            token: Arc::from("test-token"),
            boot_id: Arc::from("test-boot"),
            sandbox_manager: crate::sandbox::SandboxManager::new(app_root.clone()),
            agent_sessions: crate::terminal::AgentSessionRegistry::new(),
            app_root,
            repo_dir,
            mode: crate::state::ApiMode::Strict,
            config,
            tasks,
            broadcaster,
            shutdown: Arc::new(crate::shutdown::ShutdownCoordinator::new()),
            setup,
        }
    }

    #[test]
    fn sse_bytes_matches_daemon_frame_format() {
        let bytes = sse_bytes("stdout", &json!({"data": "hi"}));
        assert_eq!(
            std::str::from_utf8(&bytes).expect("utf8"),
            "event: stdout\ndata: {\"data\":\"hi\"}\n\n"
        );
    }

    #[test]
    fn end_frame_matches_daemon_frame_format() {
        let bytes = end_frame(TaskStatus::Exited, Some(0), false);
        assert_eq!(
            std::str::from_utf8(&bytes).expect("utf8"),
            "event: end\ndata: {\"exitCode\":0,\"status\":\"exited\",\"timedOut\":false}\n\n"
        );
    }

    #[tokio::test]
    async fn internal_shutdown_task_is_invisible_and_uncontrollable_over_routes() {
        let state = test_state();
        let controller = crate::tasks::ProcessController::new();
        state.tasks.insert(crate::tasks::TaskEntry::new_internal(
            crate::tasks::TaskSummary {
                id: "internal".to_string(),
                command: "request-owned".to_string(),
                status: TaskStatus::Running,
                exit_code: None,
                started_at: 0,
                finished_at: None,
                timed_out: false,
                truncated: false,
                log_name: None,
                intentional: None,
            },
            Some(controller.kill_handle()),
        ));

        let Json(listed) = list(
            State(state.clone()),
            HeaderMap::new(),
            Query(StatusQuery { status: None }),
        )
        .await
        .expect("global task list resolves");
        assert_eq!(listed, json!({"tasks": []}));

        let get_error = get(
            State(state.clone()),
            HeaderMap::new(),
            Path("internal".to_string()),
        )
        .await
        .expect_err("internal task id behaves as unknown");
        assert_eq!(get_error.status, axum::http::StatusCode::NOT_FOUND);

        let stream_error = stream(
            State(state.clone()),
            HeaderMap::new(),
            Path("internal".to_string()),
            Query(HandleQuery { handle: None }),
        )
        .await
        .expect_err("internal task stream behaves as unknown");
        assert_eq!(stream_error.status, axum::http::StatusCode::NOT_FOUND);

        let kill_error = kill(
            State(state.clone()),
            HeaderMap::new(),
            Path("internal".to_string()),
            Query(SignalQuery { signal: None }),
        )
        .await
        .expect_err("internal task cannot be killed by guessed id");
        assert_eq!(kill_error.status, axum::http::StatusCode::BAD_REQUEST);
        let Json(killed) = kill_all(State(state.clone()), HeaderMap::new())
            .await
            .expect("global task registry resolves");
        assert_eq!(killed, json!({"ok": true, "killed": 0}));
        assert_eq!(controller.requested(), None);

        let shutdown = state
            .tasks
            .kill_all_and_wait(std::time::Duration::ZERO, std::time::Duration::ZERO)
            .await;
        assert_eq!(shutdown.initially_running, 1);
        assert_eq!(controller.requested(), Some(KillSignal::Kill));
    }

    #[tokio::test]
    async fn explicit_unknown_handle_never_falls_through_to_global_tasks() {
        let state = test_state();
        let controller = crate::tasks::ProcessController::new();
        state.tasks.insert(crate::tasks::TaskEntry::new(
            crate::tasks::TaskSummary {
                id: "global-task".to_string(),
                command: "must-not-be-touched".to_string(),
                status: TaskStatus::Running,
                exit_code: None,
                started_at: 0,
                finished_at: None,
                timed_out: false,
                truncated: false,
                log_name: Some("dev".to_string()),
                intentional: None,
            },
            Some(controller.kill_handle()),
        ));
        let mut headers = HeaderMap::new();
        headers.insert(
            crate::sandbox::SANDBOX_HANDLE_HEADER,
            HeaderValue::from_static("unknown-handle"),
        );

        let list_error = list(
            State(state.clone()),
            headers.clone(),
            Query(StatusQuery { status: None }),
        )
        .await
        .expect_err("unknown explicit sandbox must be rejected");
        assert_eq!(list_error.status, axum::http::StatusCode::NOT_FOUND);

        let kill_error = kill_all(State(state), headers)
            .await
            .expect_err("unknown explicit sandbox must not kill global tasks");
        assert_eq!(kill_error.status, axum::http::StatusCode::NOT_FOUND);
        assert_eq!(controller.requested(), None);
    }
}
