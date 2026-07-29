//! `POST /_sandbox/bash` — byte-parity target: `daemon/routes/bash.ts`,
//! oracle `daemon.e2e.test.ts` (`bash` describe block).
//!
//! Modes:
//! - `"await"` (default): spawns `bash -c <command>`, waits for it to
//!   finish (or the clamp timeout to expire), returns
//!   `{stdout,stderr,exitCode,timedOut,truncated}`. Owned by an INTERNAL
//!   `state.tasks` entry so request abort and app shutdown can reap it, but
//!   deliberately hidden from task-list/stream wire surfaces to preserve the
//!   daemon contract for await-mode commands.
//! - `"background"`: spawns the same way but returns `{taskId,status}`
//!   immediately; a detached tokio task drains stdout/stderr into
//!   `state.tasks` (both the file-backed retention — see `tasks/registry.rs`'s
//!   `LogStore`-backed `append_output` — AND the `/stream` broadcast channel)
//!   and finalizes the task's terminal status on exit, emitting a `"tasks"`
//!   broadcaster event on every registration and every exit (byte-parity
//!   with `TaskManager`'s `onChange` hook in `entry.ts`).
//!
//! Timeout clamp: default 30s, ceiling 120s (`await`) / 15min
//! (`background`) — byte-parity with `clampTimeout` in
//! `daemon/routes/bash.ts`.
//!
//! Process-group kill: an independent watchdog anchors a new process group per
//! spawn (`ProcessGroupChild::spawn`) and the group is killed via `kill`
//! (`kill -SIG -<pgid>`) rather than a raw `kill(2)` syscall, since this
//! crate has no `libc`/`nix` dependency (`Cargo.toml` is a shared file —
//! see the native module-ownership contract). This kills the whole
//! subprocess tree (e.g. `sleep` spawned by `bash -c "sleep 30"`), matching
//! `daemon/process/task-manager.ts`'s `process.kill(-pgid, signal)`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use axum::body::Bytes;
use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use futures_util::FutureExt;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::process::{ChildStderr, ChildStdout, Command};
use tokio::sync::oneshot;

use crate::error::{ApiError, ApiResult};
use crate::process_group::ProcessGroupChild;
use crate::process_util::{
    classify_status, drive_group_to_exit, emit_tasks_event, exit_status_to_code, CancelOnDrop,
    OutputSink,
};
use crate::state::AppState;
use crate::tasks::{
    now_ms, KillSignal, OutputStream, ProcessController, RingBuffer, TaskEntry, TaskRegistry,
    TaskStatus, TaskSummary,
};

const DEFAULT_TIMEOUT_MS: u64 = 30_000;
const AWAIT_CEILING_MS: u64 = 120_000;
const BACKGROUND_CEILING_MS: u64 = 15 * 60 * 1000;
/// Byte-parity with `RING_BUFFER_BYTES` in `process/task-manager.ts` — caps
/// the `mode:"await"` response the same way a background task's retained
/// output is capped for a replay read (`tasks/registry.rs` reads the same
/// 256KB tail from its `LogStore`-backed files — see
/// `crate::log_store::DEFAULT_TAIL_BYTES`). Await-mode itself is never persisted
/// or replayed (the HTTP response IS the output), so it keeps its own
/// request-scoped, in-RAM `RingBuffer` rather than going through
/// `LogStore` — nothing outside this one request ever needs to read it
/// back.
const OUTPUT_CAP_BYTES: usize = 256 * 1024;
/// How long to wait for a process to actually exit after a `SIGKILL` before
/// giving up on the reap and reporting the timeout anyway. Not part of any
/// pinned contract — just a bound so a truly wedged process (rare: a kernel
/// waiting on uninterruptible I/O) can't hang the request/task forever.
const REAP_GRACE: Duration = Duration::from_secs(2);

#[derive(Deserialize, Default)]
struct BashBody {
    command: Option<String>,
    timeout: Option<i64>,
    cwd: Option<String>,
    env: Option<HashMap<String, String>>,
    mode: Option<String>,
}

pub async fn bash(State(state): State<AppState>, body: Bytes) -> ApiResult<Json<Value>> {
    let body: BashBody = serde_json::from_slice(&body)
        .map_err(|e| ApiError::bad_request(format!("invalid JSON body: {e}")))?;
    let command = match body.command {
        Some(c) if !c.is_empty() => c,
        _ => return Err(ApiError::bad_request("command is required")),
    };
    let background = body.mode.as_deref() == Some("background");
    let timeout_ms = clamp_timeout(body.timeout, background);
    let cwd = body
        .cwd
        .map(PathBuf::from)
        .unwrap_or_else(|| state.repo_dir.clone());

    if background {
        return spawn_background(&state, command, cwd, body.env, timeout_ms).await;
    }

    let result = run_await(&state, &command, &cwd, body.env.as_ref(), timeout_ms).await?;
    Ok(Json(json!({
        "stdout": result.stdout,
        "stderr": result.stderr,
        "exitCode": result.exit_code,
        "timedOut": result.timed_out,
        "truncated": result.truncated,
    })))
}

fn clamp_timeout(raw: Option<i64>, background: bool) -> u64 {
    let requested = match raw {
        Some(v) if v > 0 => v as u64,
        _ => DEFAULT_TIMEOUT_MS,
    };
    let ceiling = if background {
        BACKGROUND_CEILING_MS
    } else {
        AWAIT_CEILING_MS
    };
    requested.min(ceiling)
}

fn build_command(command: &str, cwd: &Path, env: Option<&HashMap<String, String>>) -> Command {
    let mut cmd = Command::new("bash");
    cmd.arg("-c").arg(command);
    cmd.current_dir(cwd);
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    // The detached owner below is the primary lifecycle fence. This is its
    // last-resort backstop: aborting that owner (runtime teardown/panic) kills
    // the immediate shell instead of letting it outlive local-api. The normal
    // shutdown/request-abort path signals the whole process group first.
    cmd.kill_on_drop(true);
    // Byte-parity with `bash.ts`: an explicit `env` REPLACES the inherited
    // environment rather than merging with it (Node's `spawn` semantics
    // when `options.env` is set at all) — `deps.env` is always undefined in
    // the daemon's own wiring, so `body.env` alone determines this.
    if let Some(env) = env {
        cmd.env_clear();
        cmd.envs(env);
    }
    cmd
}

/// Carries dangling bytes of a multi-byte UTF-8 sequence across chunk
/// boundaries so a character split across two pipe reads isn't mangled into
/// replacement characters — byte-parity in spirit with `task-manager.ts`'s
/// use of `node:string_decoder`'s `StringDecoder`.
struct Utf8ChunkDecoder {
    pending: Vec<u8>,
}

impl Utf8ChunkDecoder {
    fn new() -> Self {
        Self {
            pending: Vec::new(),
        }
    }

    /// Feed in newly-read bytes, returning whatever complete UTF-8 text is
    /// now available (dangling trailing bytes are held back for the next
    /// call).
    fn push(&mut self, bytes: &[u8]) -> String {
        self.pending.extend_from_slice(bytes);
        match std::str::from_utf8(&self.pending) {
            Ok(s) => {
                let out = s.to_string();
                self.pending.clear();
                out
            }
            Err(e) => {
                let valid_len = e.valid_up_to();
                let out = String::from_utf8_lossy(&self.pending[..valid_len]).into_owned();
                self.pending.drain(..valid_len);
                // A valid UTF-8 sequence is at most 4 bytes; anything larger
                // still pending can't be "a partial character waiting for
                // more bytes" — it's genuinely invalid. Flush it lossily
                // rather than growing unboundedly.
                if self.pending.len() > 4 {
                    let lossy = String::from_utf8_lossy(&self.pending).into_owned();
                    self.pending.clear();
                    return out + &lossy;
                }
                out
            }
        }
    }

    /// Flush whatever's left at stream end (a genuinely truncated trailing
    /// sequence, decoded lossily rather than silently dropped).
    fn finish(&mut self) -> String {
        if self.pending.is_empty() {
            return String::new();
        }
        let out = String::from_utf8_lossy(&self.pending).into_owned();
        self.pending.clear();
        out
    }
}

struct RunResult {
    stdout: String,
    stderr: String,
    exit_code: i32,
    timed_out: bool,
    truncated: bool,
}

async fn run_await(
    state: &AppState,
    command: &str,
    cwd: &Path,
    env: Option<&HashMap<String, String>>,
    timeout_ms: u64,
) -> ApiResult<RunResult> {
    let Some(admission) = state.shutdown.admit_work().await else {
        return Err(ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "application is shutting down",
        ));
    };

    let mut cmd = build_command(command, cwd, env);
    let mut child =
        match ProcessGroupChild::spawn(&mut cmd, state.tasks.child_lifetime_lock_path()).await {
            Ok(child) => child,
            Err(e) => {
                return Ok(RunResult {
                    stdout: String::new(),
                    stderr: format!("spawn error: {e}\n"),
                    exit_code: -1,
                    timed_out: false,
                    truncated: false,
                });
            }
        };
    // Internal ownership must not consume the public `task<N>` sequence: an
    // await-mode call was never observable in `/tasks`, including indirectly
    // through the id assigned to the next background task.
    let id = format!("internal-bash-{}", uuid::Uuid::new_v4());
    let controller = ProcessController::new();
    let kill_handle = controller.kill_handle();
    state.tasks.insert(TaskEntry::new_internal(
        TaskSummary {
            id: id.clone(),
            command: command.to_string(),
            status: TaskStatus::Running,
            exit_code: None,
            started_at: now_ms(),
            finished_at: None,
            timed_out: false,
            truncated: false,
            log_name: None,
            intentional: None,
        },
        Some(kill_handle.clone()),
    ));

    // Registration is intentionally before these infallible-for-piped-command
    // takes. From the instant `spawn()` succeeds, shutdown can find and signal
    // the owner; there is no spawn -> registry cancellation window.
    let (Some(stdout_pipe), Some(stderr_pipe)) = (child.take_stdout(), child.take_stderr()) else {
        spawn_missing_stdio_cleanup(state.clone(), id, child, false);
        drop(admission);
        return Ok(RunResult {
            stdout: String::new(),
            stderr: "spawn error: missing stdio pipe\n".to_string(),
            exit_code: -1,
            timed_out: false,
            truncated: false,
        });
    };

    let (result_tx, result_rx) = oneshot::channel();
    spawn_process_owner(
        state.clone(),
        id,
        child,
        stdout_pipe,
        stderr_pipe,
        timeout_ms,
        controller,
        Some(result_tx),
        false,
    );
    drop(admission);

    let mut cancel_on_drop = CancelOnDrop::new(kill_handle, KillSignal::Term);
    let result = result_rx
        .await
        .map_err(|_| ApiError::internal("bash process owner stopped unexpectedly"))?;
    cancel_on_drop.disarm();
    Ok(result)
}

async fn spawn_background(
    state: &AppState,
    command: String,
    cwd: PathBuf,
    env: Option<HashMap<String, String>>,
    timeout_ms: u64,
) -> ApiResult<Json<Value>> {
    let Some(admission) = state.shutdown.admit_work().await else {
        return Err(ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "application is shutting down",
        ));
    };
    let mut cmd = build_command(&command, &cwd, env.as_ref());
    let id = state.tasks.next_id();
    let controller = ProcessController::new();
    let kill_handle = controller.kill_handle();

    let mut child =
        match ProcessGroupChild::spawn(&mut cmd, state.tasks.child_lifetime_lock_path()).await {
            Ok(child) => child,
            Err(_) => {
                let started_at = now_ms();
                let summary = TaskSummary {
                    id: id.clone(),
                    command,
                    status: TaskStatus::Failed,
                    exit_code: Some(-1),
                    started_at,
                    finished_at: Some(started_at),
                    timed_out: false,
                    truncated: false,
                    log_name: None,
                    intentional: None,
                };
                state.tasks.insert(TaskEntry::new(summary, None));
                emit_tasks_event(&state.tasks, &state.broadcaster);
                return Ok(Json(json!({"taskId": id, "status": "failed"})));
            }
        };

    let summary = TaskSummary {
        id: id.clone(),
        command,
        status: TaskStatus::Running,
        exit_code: None,
        started_at: now_ms(),
        finished_at: None,
        timed_out: false,
        truncated: false,
        log_name: None,
        intentional: None,
    };
    state
        .tasks
        .insert(TaskEntry::new(summary, Some(kill_handle)));
    emit_tasks_event(&state.tasks, &state.broadcaster);

    let (Some(stdout_pipe), Some(stderr_pipe)) = (child.take_stdout(), child.take_stderr()) else {
        spawn_missing_stdio_cleanup(state.clone(), id.clone(), child, true);
        drop(admission);
        return Ok(Json(json!({"taskId": id, "status": "failed"})));
    };

    spawn_process_owner(
        state.clone(),
        id.clone(),
        child,
        stdout_pipe,
        stderr_pipe,
        timeout_ms,
        controller,
        None,
        true,
    );
    drop(admission);

    Ok(Json(json!({"taskId": id, "status": "running"})))
}

fn spawn_missing_stdio_cleanup(
    state: AppState,
    id: String,
    mut child: ProcessGroupChild,
    visible: bool,
) {
    tokio::spawn(async move {
        child
            .kill_and_reap(REAP_GRACE, "bash missing-stdio cleanup")
            .await;
        state.tasks.finalize(&id, TaskStatus::Failed, -1, false);
        if visible {
            emit_tasks_event(&state.tasks, &state.broadcaster);
        } else {
            let _ = state.tasks.remove(&id).await;
        }
    });
}

#[allow(clippy::too_many_arguments)]
fn spawn_process_owner(
    state: AppState,
    id: String,
    mut child: ProcessGroupChild,
    stdout_pipe: ChildStdout,
    stderr_pipe: ChildStderr,
    timeout_ms: u64,
    controller: ProcessController,
    result_tx: Option<oneshot::Sender<RunResult>>,
    visible: bool,
) {
    tokio::spawn(async move {
        let capture_output = result_tx.is_some();
        let driven = std::panic::AssertUnwindSafe(drive_process(
            state.clone(),
            id.clone(),
            &mut child,
            stdout_pipe,
            stderr_pipe,
            timeout_ms,
            controller,
            capture_output,
        ))
        .catch_unwind()
        .await;

        let result = match driven {
            Ok(result) => result,
            Err(_) => {
                child
                    .kill_and_reap(REAP_GRACE, "bash process-owner panic cleanup")
                    .await;
                RunResult {
                    stdout: String::new(),
                    stderr: "process owner panicked\n".to_string(),
                    exit_code: -1,
                    timed_out: false,
                    truncated: false,
                }
            }
        };
        let status = classify_status(result.timed_out, result.exit_code);
        state
            .tasks
            .finalize(&id, status, result.exit_code, result.timed_out);
        if visible {
            emit_tasks_event(&state.tasks, &state.broadcaster);
        } else {
            let _ = state.tasks.remove(&id).await;
        }
        if let Some(result_tx) = result_tx {
            let _ = result_tx.send(result);
        }
    });
}

/// This family's [`OutputSink`]: decodes UTF-8 across chunk boundaries
/// (unlike the scripts family — see `routes/scripts.rs`'s deviation note),
/// retains into the file-backed registry, and keeps an await-mode
/// request-result copy in RAM. Background output needs no RAM copy; the
/// registry already retains it.
struct BashChunkSink {
    tasks: Arc<TaskRegistry>,
    id: String,
    stdout_decoder: Utf8ChunkDecoder,
    stderr_decoder: Utf8ChunkDecoder,
    stdout_buf: Option<RingBuffer>,
    stderr_buf: Option<RingBuffer>,
}

#[async_trait::async_trait]
impl OutputSink for BashChunkSink {
    async fn write(&mut self, stream: OutputStream, bytes: &[u8]) {
        let (decoder, buf) = match stream {
            OutputStream::Stdout => (&mut self.stdout_decoder, &mut self.stdout_buf),
            OutputStream::Stderr => (&mut self.stderr_decoder, &mut self.stderr_buf),
        };
        let text = decoder.push(bytes);
        if !text.is_empty() {
            if let Some(buf) = buf {
                buf.append(&text);
            }
            self.tasks.append_output(&self.id, stream, &text).await;
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn drive_process(
    state: AppState,
    id: String,
    child: &mut ProcessGroupChild,
    stdout_pipe: ChildStdout,
    stderr_pipe: ChildStderr,
    timeout_ms: u64,
    controller: ProcessController,
    capture_output: bool,
) -> RunResult {
    let mut sink = BashChunkSink {
        tasks: state.tasks.clone(),
        id: id.clone(),
        stdout_decoder: Utf8ChunkDecoder::new(),
        stderr_decoder: Utf8ChunkDecoder::new(),
        stdout_buf: capture_output.then(|| RingBuffer::new(OUTPUT_CAP_BYTES)),
        stderr_buf: capture_output.then(|| RingBuffer::new(OUTPUT_CAP_BYTES)),
    };
    let outcome = drive_group_to_exit(
        child,
        stdout_pipe,
        stderr_pipe,
        Some(Duration::from_millis(timeout_ms)),
        &controller,
        &mut sink,
    )
    .await;

    // Flush any dangling partial-UTF8 tail left in the decoders.
    let so_tail = sink.stdout_decoder.finish();
    if !so_tail.is_empty() {
        if let Some(buf) = &mut sink.stdout_buf {
            buf.append(&so_tail);
        }
        state
            .tasks
            .append_output(&id, OutputStream::Stdout, &so_tail)
            .await;
    }
    let se_tail = sink.stderr_decoder.finish();
    if !se_tail.is_empty() {
        if let Some(buf) = &mut sink.stderr_buf {
            buf.append(&se_tail);
        }
        state
            .tasks
            .append_output(&id, OutputStream::Stderr, &se_tail)
            .await;
    }

    let raw_exit_code = outcome.exit_status.map(exit_status_to_code).unwrap_or(-1);
    let exit_code = if outcome.timed_out { -1 } else { raw_exit_code };
    let (stdout, so_truncated) = sink
        .stdout_buf
        .as_ref()
        .map(RingBuffer::read)
        .unwrap_or_default();
    let (stderr, se_truncated) = sink
        .stderr_buf
        .as_ref()
        .map(RingBuffer::read)
        .unwrap_or_default();
    RunResult {
        stdout,
        stderr,
        exit_code,
        timed_out: outcome.timed_out,
        truncated: so_truncated || se_truncated,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn test_state() -> AppState {
        let app_root = tempfile::tempdir().unwrap().keep();
        let repo_dir = app_root.clone();
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
            token: Arc::from("test-token"),
            boot_id: Arc::from("test-boot"),
            sandbox_manager: crate::sandbox::SandboxManager::new(app_root.clone()),
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
    fn clamp_timeout_defaults_and_ceilings() {
        assert_eq!(clamp_timeout(None, false), DEFAULT_TIMEOUT_MS);
        assert_eq!(clamp_timeout(Some(0), false), DEFAULT_TIMEOUT_MS);
        assert_eq!(clamp_timeout(Some(-5), false), DEFAULT_TIMEOUT_MS);
        assert_eq!(clamp_timeout(Some(999_999), false), AWAIT_CEILING_MS);
        assert_eq!(
            clamp_timeout(Some(999_999_999), true),
            BACKGROUND_CEILING_MS
        );
        assert_eq!(clamp_timeout(Some(1_000), true), 1_000);
    }

    #[test]
    fn utf8_chunk_decoder_carries_split_multibyte_char() {
        let mut decoder = Utf8ChunkDecoder::new();
        // "é" = 0xC3 0xA9 in UTF-8 — split across two chunks.
        let mut out = decoder.push(&[b'a', 0xC3]);
        out.push_str(&decoder.push(&[0xA9, b'b']));
        assert_eq!(out, "aéb");
    }

    #[tokio::test]
    async fn run_await_captures_stdout_and_exit_code() {
        let state = test_state();
        let result = run_await(&state, "echo hi", Path::new("/tmp"), None, 5_000)
            .await
            .unwrap();
        assert_eq!(result.stdout.trim(), "hi");
        assert_eq!(result.exit_code, 0);
        assert!(!result.timed_out);
    }

    #[tokio::test]
    async fn run_await_times_out_and_reports_exit_code_minus_one() {
        let state = test_state();
        let result = run_await(&state, "sleep 30", Path::new("/tmp"), None, 200)
            .await
            .unwrap();
        assert_eq!(result.exit_code, -1);
        assert!(result.timed_out);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn leader_exit_keeps_background_descendant_running_and_enumerable_until_shutdown_reaps_it(
    ) {
        let state = test_state();
        let pid_file = state.app_root.join("detached-same-group.pid");
        let response = spawn_background(
            &state,
            format!(
                "sleep 30 >/dev/null 2>&1 & echo $! > {}",
                pid_file.display()
            ),
            state.repo_dir.clone(),
            None,
            BACKGROUND_CEILING_MS,
        )
        .await
        .expect("spawn background fixture");
        let task_id = response.0["taskId"]
            .as_str()
            .expect("background response task id")
            .to_string();
        let descendant = tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if let Ok(raw) = tokio::fs::read_to_string(&pid_file).await {
                    if let Ok(pid) = raw.trim().parse::<u32>() {
                        break pid;
                    }
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("shell wrote background descendant pid");

        // The shell leader and both output pipes have already exited/closed,
        // but the same-PG descendant is still the task. Never publish End yet.
        tokio::time::sleep(Duration::from_millis(150)).await;
        let summary = state.tasks.get(&task_id).expect("task remains owned");
        assert_eq!(summary.status, TaskStatus::Running);
        assert!(state.tasks.list(None).iter().any(|task| task.id == task_id));

        let shutdown = state
            .tasks
            .kill_all_and_wait(Duration::from_millis(500), Duration::from_secs(2))
            .await;
        assert_eq!(shutdown.initially_running, 1);
        assert!(shutdown.remaining.is_empty());
        assert!(
            state
                .tasks
                .get(&task_id)
                .expect("terminal task retained")
                .status
                .is_terminal(),
            "terminal transition must follow the whole-group reap"
        );
        assert!(!process_alive(descendant));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn aborted_await_request_is_hidden_and_reaps_its_process() {
        let state = test_state();
        let pid_file = state.app_root.join("await-owner.pid");
        let command = format!("echo $$ > {}; sleep 30", pid_file.display());
        let owner_state = state.clone();
        let request = tokio::spawn(async move {
            run_await(&owner_state, &command, Path::new("/tmp"), None, 120_000).await
        });

        let pid = tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                if let Ok(raw) = tokio::fs::read_to_string(&pid_file).await {
                    if let Ok(pid) = raw.trim().parse::<u32>() {
                        break pid;
                    }
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("bash child wrote its pid");

        assert!(
            state.tasks.list(None).is_empty(),
            "await-mode ownership entries are internal and must not change /tasks"
        );
        assert!(
            state.tasks.next_id() == "task1",
            "internal ownership must not consume the public task id sequence"
        );
        request.abort();
        let _ = request.await;

        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let alive = std::process::Command::new("kill")
                    .args(["-0", &pid.to_string()])
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status()
                    .is_ok_and(|status| status.success());
                if !alive {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("aborted await request reaped its child");
    }

    #[cfg(unix)]
    fn process_alive(pid: u32) -> bool {
        std::process::Command::new("kill")
            .args(["-0", &pid.to_string()])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
    }
}
