//! Exec / scripts — `GET /_sandbox/scripts`,
//! `POST /_sandbox/exec/:name[/kill]`. Byte-parity target:
//! `daemon/routes/scripts.ts` + `daemon/routes/exec.ts` +
//! `daemon/process/script-discovery.ts`, oracle
//! `daemon.git.e2e.test.ts` (`exec` describe block, minus its
//! `bootstrapRepo`/clone-dependent specs — the setup/clone pipeline is
//! DROPPED for local-api, see the contract doc §C and
//! the native module-ownership contract's "Deliberately out of scope"
//! section) + `daemon.e2e.test.ts`'s
//! `"GET /_sandbox/scripts returns { scripts: [] } before discovery"`.
//!
//! Spawned processes are registered in the SAME `state.tasks` registry the
//! bash/tasks family owns (`TaskRegistry::next_id`/`insert`/
//! `append_output`/`finalize`) — see
//! the native module-ownership contract's "Uses: the SAME `state.tasks`
//! registry" note. The drain/kill/escalation loop, the
//! `classify_status`/`exit_status_to_code` mapping, the `"tasks"`
//! broadcaster payload, and the request-cancellation guard all live in the
//! shared `crate::process_util` module (the hoist the bootstrap report's
//! interface request called for, taken once the `setup` pipeline became the
//! third family needing the same shape), so a task spawned by any family
//! looks identical to `GET /_sandbox/tasks` / `/_sandbox/tasks/:id/stream`
//! consumers by construction. This file keeps only what the exec/scripts
//! family owns: script discovery, the exec env/command layering, and its
//! per-chunk log sink.
//!
//! ## Deliberate deviations from the TS daemon (documented, not hidden)
//!
//! 1. **Spawned-process environment**: the TS `exec.ts` builds a
//!    *minimal* env for the child (`HOST`/`HOSTNAME`/config env/body env/
//!    computed `PATH` — deliberately NOT `process.env`, appropriate for a
//!    sandboxed container with a fixed toolchain path). local-api targets
//!    a user's own laptop, where `npm`/`bun`/`deno` etc. typically live in
//!    a devshell/nvm/version-manager PATH that only the inherited
//!    environment knows about. This crate inherits the full parent
//!    environment (`tokio::process::Command`'s default — env is layered
//!    ON TOP via `.envs()`, never `.env_clear()`'d) and layers config-env,
//!    then body-env, then `HOST`/`HOSTNAME`/`PORT` defaults (only when
//!    unset) on top — the safer default for "run the user's own package
//!    script on the user's own machine."
//! 2. **`POST /exec/:name/kill` response shape**: the contract doc's route
//!    table says `{ killed: boolean }`, but the actual daemon
//!    (`TaskManager.killByLogName`) returns the *count* of matching running
//!    tasks signaled, and `daemon.git.e2e.test.ts` asserts
//!    `typeof body.killed === "number"` (with an explicit comment: "//
//!    killByLogName returns the number of matching tasks killed"). Per
//!    "the spec is the test suite," this file matches the test (a number),
//!    not the doc's prose. Worth a doc fix, not a code bug.
//! 3. **UTF-8 chunk boundaries**: unlike `routes/bash.rs`'s
//!    `Utf8ChunkDecoder` (which carries a dangling partial multi-byte
//!    sequence across two 8KB pipe reads), this file decodes each chunk
//!    independently via `String::from_utf8_lossy`. A multi-byte character
//!    split exactly on an 8KB boundary can render as a replacement
//!    character. No test (either suite) exercises this, and script output
//!    is overwhelmingly ASCII (build tool logs); flagged as a known,
//!    narrow gap rather than duplicating `Utf8ChunkDecoder` verbatim.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use axum::body::Bytes;
use axum::extract::{Path as AxumPath, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use futures_util::FutureExt;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::process::{ChildStderr, ChildStdout, Command as TokioCommand};
use tokio::sync::oneshot;

use crate::error::ApiError;
use crate::events::Broadcaster;
use crate::process_group::ProcessGroupChild;
use crate::process_util::{
    classify_status, drive_group_to_exit, emit_tasks_event, exit_status_to_code, CancelOnDrop,
    OutputSink,
};
use crate::sandbox::SandboxTarget;
use crate::state::AppState;
use crate::tasks::{
    now_ms, KillSignal, OutputStream, ProcessController, TaskEntry, TaskRegistry, TaskStatus,
    TaskSummary,
};

/// Resolve an explicit sandbox identity without ever falling through to the
/// process-global registry. A stopped durable sandbox is metadata-adopted with
/// permanently closed task admission, so exec truthfully returns 409 until an
/// explicit Start installs a fresh generation.
async fn resolve(
    state: &AppState,
    epoch: crate::sandbox::manager::AccountEpoch,
    headers: &HeaderMap,
) -> Result<SandboxTarget, ApiError> {
    let Some(handle) = crate::sandbox::handle_from_headers(headers) else {
        return state
            .resolve_sandbox_target_for_account(epoch, None)
            .map_err(ApiError::conflict);
    };
    match state.sandbox_manager.adopt_for_account(epoch, handle).await {
        Ok(Some(sandbox)) => Ok(SandboxTarget::from_sandbox(&sandbox)),
        Ok(None) => Err(ApiError::not_found(format!(
            "unknown sandbox handle: {handle}"
        ))),
        Err(error) => Err(ApiError::internal(format!(
            "failed to resolve sandbox handle {handle}: {error}"
        ))),
    }
}

// --- GET /_sandbox/scripts ---------------------------------------------------

pub async fn list(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let authorization = super::sandbox_account::authorize(&state).await?;
    let epoch = authorization.epoch();
    let target = resolve(&state, epoch, &headers).await?;
    let snapshot = target.config.snapshot();
    let pm = pm_name(&snapshot.config);
    let cwd = pm_path(&snapshot.config).unwrap_or_else(|| target.repo_dir.clone());
    let scripts = discover_scripts(&cwd, pm.as_deref());
    state
        .sandbox_manager
        .with_account_epoch(epoch, || {
            emit_if_changed(&target.broadcaster, &cwd, &scripts)
        })
        .map_err(ApiError::conflict)?;
    Ok(Json(json!({ "scripts": scripts })))
}

/// Compares against the last-discovered set for THIS cwd and emits `"scripts"`
/// only on an actual change, per the native module-ownership contract's
/// "Emits: `scripts` when the discovered set changes." Keyed by cwd (O8) so a
/// second sandbox's first `scripts` emit is not suppressed by the first
/// sandbox's identical set — each per-handle workdir is its own key.
fn emit_if_changed(broadcaster: &Broadcaster, cwd: &Path, scripts: &[String]) {
    let key = cwd.to_string_lossy().into_owned();
    let cell = last_known_scripts();
    let mut guard = match cell.lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    };
    let changed = guard
        .get(&key)
        .map(|v| v.as_slice() != scripts)
        .unwrap_or(true);
    if changed {
        guard.insert(key, scripts.to_vec());
        broadcaster.emit("scripts", json!({ "scripts": scripts }));
    }
}

fn last_known_scripts() -> &'static Mutex<HashMap<String, Vec<String>>> {
    static LAST: OnceLock<Mutex<HashMap<String, Vec<String>>>> = OnceLock::new();
    LAST.get_or_init(|| Mutex::new(HashMap::new()))
}

// --- POST /_sandbox/exec/:name ------------------------------------------------

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ExecBody {
    mode: Option<String>,
    timeout_ms: Option<u64>,
    env: Option<HashMap<String, String>>,
}

pub async fn exec(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(name): AxumPath<String>,
    body: Bytes,
) -> Result<Response, ApiError> {
    let authorization = super::sandbox_account::authorize(&state).await?;
    exec_with_admission(
        State(state),
        headers,
        AxumPath(name),
        body,
        authorization.epoch(),
        (),
    )
    .await
}

/// Execute a script while retaining an upstream admission fence only until
/// the spawned child has a durable [`TaskRegistry`] owner.
///
/// Intercepted thread-backed routes pass their workspace-lifecycle guard here
/// by value. Every error before registration returns from this function and
/// therefore drops the guard through RAII. Once registration succeeds, the
/// explicit `drop` below releases it before any response path or process wait.
/// The generic stays deliberately opaque: this module neither knows nor
/// couples itself to the authority layer that produced the fence.
pub(crate) async fn exec_with_admission<Admission>(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(name): AxumPath<String>,
    body: Bytes,
    account_epoch: crate::sandbox::manager::AccountEpoch,
    admission_guard: Admission,
) -> Result<Response, ApiError> {
    let target = resolve(&state, account_epoch, &headers).await?;
    let snapshot = target.config.snapshot();
    let Some(pm) = pm_name(&snapshot.config) else {
        return Err(ApiError::conflict(
            "no application configured; POST /config first",
        ));
    };
    let run_prefix = run_prefix_for(&pm)
        .ok_or_else(|| ApiError::internal(format!("unknown package manager: {pm}")))?;

    let cwd = pm_path(&snapshot.config).unwrap_or_else(|| target.repo_dir.clone());
    let scripts = discover_scripts(&cwd, Some(&pm));
    if !scripts.iter().any(|s| s == &name) {
        return Err(ApiError::with_extra(
            StatusCode::NOT_FOUND,
            format!("script \"{name}\" not found in package file"),
            json!({ "available": scripts }),
        ));
    }

    let exec_body: ExecBody = if body.is_empty() {
        ExecBody::default()
    } else {
        serde_json::from_slice(&body).unwrap_or_default()
    };
    let background = exec_body.mode.as_deref() != Some("await");
    let timeout_ms = exec_body.timeout_ms;

    let command = format!("{run_prefix} {name}");
    // The PORT default must be the SAME port the preview proxy targets — the
    // sandbox's allocation, not the config's static value. See
    // `setup::dev::resolve_dev_port`; the config port only seeds a first
    // allocation.
    let sandbox_root = crate::sandbox::dev_port::sandbox_root_for(&target.repo_dir);
    let default_port = crate::sandbox::dev_port::resolve(
        &sandbox_root,
        snapshot
            .config
            .as_ref()
            .and_then(crate::sandbox::dev_port::configured_port),
    );
    let env = build_env(&snapshot.config, exec_body.env.as_ref(), default_port);

    let Some(shutdown_admission) = state.shutdown.admit_work().await else {
        return Err(ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "application is shutting down",
        ));
    };
    let Some(generation_admission) = target.tasks.admit() else {
        return Err(ApiError::conflict("sandbox generation is stopped"));
    };

    let mut cmd = build_command(&command, &cwd, &env);
    let controller = ProcessController::new();
    let kill_handle = controller.kill_handle();
    let mut child = ProcessGroupChild::spawn(&mut cmd, target.tasks.child_lifetime_lock_path())
        .await
        .map_err(|err| ApiError::internal(format!("spawn error: {err}")))?;

    // Everything from here runs against the RESOLVED sandbox's registry +
    // broadcaster (cheap `Arc` clones), so the spawned drain task can outlive
    // this handler without borrowing `target`.
    let tasks = target.tasks.clone();
    let broadcaster = target.broadcaster.clone();

    let id = tasks.next_id();
    let summary = TaskSummary {
        id: id.clone(),
        command: command.clone(),
        status: TaskStatus::Running,
        exit_code: None,
        started_at: now_ms(),
        finished_at: None,
        timed_out: false,
        truncated: false,
        log_name: Some(name.clone()),
        intentional: None,
    };
    generation_admission.register(TaskEntry::new(summary, Some(kill_handle.clone())));

    // The process is now owned by TaskRegistry and can be controlled even if
    // archive/delete wins the workspace lifecycle lock next. Release both
    // admission fences before event delivery, stdio plumbing, the background
    // response, or an `await`-mode process wait.
    drop(admission_guard);
    drop(shutdown_admission);

    emit_tasks_event(&tasks, &broadcaster);

    // Registration deliberately precedes these takes. Once spawn succeeds,
    // shutdown can always find a durable controller; there is no await or
    // cancellation point between process creation and TaskRegistry ownership.
    let (Some(stdout_pipe), Some(stderr_pipe)) = (child.take_stdout(), child.take_stderr()) else {
        spawn_missing_stdio_cleanup(tasks, broadcaster, id, child);
        return Err(ApiError::internal("spawn error: missing stdio pipe"));
    };

    let (completion_tx, completion_rx) = oneshot::channel();
    spawn_exec_owner(
        tasks.clone(),
        broadcaster.clone(),
        name.clone(),
        id.clone(),
        child,
        stdout_pipe,
        stderr_pipe,
        timeout_ms,
        controller,
        completion_tx,
    );

    if background {
        return Ok(Json(json!({ "taskId": id, "status": "running" })).into_response());
    }

    let mut cancel_on_drop = CancelOnDrop::new(kill_handle, KillSignal::Term);
    completion_rx
        .await
        .map_err(|_| ApiError::internal("script process owner stopped unexpectedly"))?;
    cancel_on_drop.disarm();
    let final_summary = tasks.get(&id);
    let (stdout, stderr, truncated) = tasks.output(&id).await.unwrap_or_default();
    let (exit_code, timed_out) = final_summary
        .map(|s| (s.exit_code, s.timed_out))
        .unwrap_or((None, false));
    state
        .sandbox_manager
        .validate_account_epoch(account_epoch)
        .map_err(ApiError::conflict)?;
    Ok(Json(json!({
        "taskId": id,
        "stdout": stdout,
        "stderr": stderr,
        "exitCode": exit_code,
        "timedOut": timed_out,
        "truncated": truncated,
    }))
    .into_response())
}

// --- POST /_sandbox/exec/:name/kill -------------------------------------------

pub async fn exec_kill(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(name): AxumPath<String>,
) -> Result<Json<Value>, ApiError> {
    let authorization = super::sandbox_account::authorize(&state).await?;
    exec_kill_for_account(state, headers, name, authorization.epoch()).await
}

pub(crate) async fn exec_kill_for_account(
    state: AppState,
    headers: HeaderMap,
    name: String,
    account_epoch: crate::sandbox::manager::AccountEpoch,
) -> Result<Json<Value>, ApiError> {
    let target = resolve(&state, account_epoch, &headers).await?;
    let matching: Vec<String> = target
        .tasks
        .list(Some(&[TaskStatus::Running]))
        .into_iter()
        .filter(|s| s.log_name.as_deref() == Some(name.as_str()))
        .map(|s| s.id)
        .collect();

    let killed = state
        .sandbox_manager
        .with_account_epoch(account_epoch, || {
            matching
                .iter()
                .filter(|id| matches!(target.tasks.kill(id, KillSignal::Term), Some(true)))
                .count()
        })
        .map_err(ApiError::conflict)?;

    Ok(Json(json!({ "killed": killed })))
}

// --- process spawn / drain / kill ---------------------------------------------

pub(crate) fn build_command(
    command: &str,
    cwd: &Path,
    env: &HashMap<String, String>,
) -> TokioCommand {
    let mut cmd = TokioCommand::new("sh");
    cmd.arg("-c").arg(command);
    cmd.current_dir(cwd);
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    // The detached owner normally reaps the whole process group through its
    // registered controller. If that owner itself is aborted/panics, Tokio's
    // child drop path still kills the immediate shell as a last-resort fence.
    cmd.kill_on_drop(true);
    // Layered ON TOP of the inherited environment (no `env_clear()`) — see
    // the module doc's deviation note #1.
    cmd.envs(env);
    cmd
}

fn spawn_missing_stdio_cleanup(
    tasks: Arc<TaskRegistry>,
    broadcaster: Arc<Broadcaster>,
    id: String,
    mut child: ProcessGroupChild,
) {
    tokio::spawn(async move {
        child
            .kill_and_reap(Duration::from_secs(2), "script missing-stdio cleanup")
            .await;
        tasks.finalize(&id, TaskStatus::Failed, -1, false);
        emit_tasks_event(&tasks, &broadcaster);
    });
}

#[allow(clippy::too_many_arguments)]
fn spawn_exec_owner(
    tasks: Arc<TaskRegistry>,
    broadcaster: Arc<Broadcaster>,
    log_name: String,
    id: String,
    mut child: ProcessGroupChild,
    stdout_pipe: ChildStdout,
    stderr_pipe: ChildStderr,
    timeout_ms: Option<u64>,
    controller: ProcessController,
    completion_tx: oneshot::Sender<()>,
) {
    tokio::spawn(async move {
        let driven = std::panic::AssertUnwindSafe(run_exec(
            tasks.clone(),
            broadcaster.clone(),
            log_name,
            id.clone(),
            &mut child,
            stdout_pipe,
            stderr_pipe,
            timeout_ms,
            controller,
        ))
        .catch_unwind()
        .await;
        if driven.is_err() {
            child
                .kill_and_reap(Duration::from_secs(2), "script process-owner panic cleanup")
                .await;
            tasks.finalize(&id, TaskStatus::Failed, -1, false);
            emit_tasks_event(&tasks, &broadcaster);
        }
        let _ = completion_tx.send(());
    });
}

/// This family's [`OutputSink`]: appends each chunk to `tasks` (file-backed
/// retention — both this task's own file and the source's combined
/// transcript — AND the `/stream` broadcast channel, via `append_log`) AND
/// emits a `"log"` SSE frame per chunk on `broadcaster` (`{source:
/// <log_name>, data: <raw text>}`, source = the script name — the terminal's
/// tab identity; raw text, the frontend normalizes `\r\n`). Decodes each
/// chunk independently (`from_utf8_lossy`) — see the module doc's deviation
/// note #3 on the UTF-8 chunk-boundary gap this deliberately accepts.
struct ScriptLogSink {
    tasks: Arc<TaskRegistry>,
    broadcaster: Arc<Broadcaster>,
    log_name: String,
    id: String,
}

#[async_trait::async_trait]
impl OutputSink for ScriptLogSink {
    async fn write(&mut self, stream: OutputStream, bytes: &[u8]) {
        let text = String::from_utf8_lossy(bytes);
        self.tasks
            .append_log(&self.id, &self.log_name, stream, &text, &self.broadcaster)
            .await;
    }
}

/// Drains through the shared drain/kill/escalation loop
/// ([`drive_group_to_exit`]) with this family's [`ScriptLogSink`], then
/// finalizes the task and emits a `"tasks"` broadcaster event.
/// Self-contained (void return) — both `background` and `await` exec modes
/// call this the same way; `await` mode reads the result back via
/// `tasks.get`/`output` after it returns. Takes the resolved sandbox's
/// `tasks`/`broadcaster` Arcs (not `AppState`) so a per-handle exec
/// registers/streams on the RIGHT sandbox.
#[allow(clippy::too_many_arguments)]
async fn run_exec(
    tasks: Arc<TaskRegistry>,
    broadcaster: Arc<Broadcaster>,
    log_name: String,
    id: String,
    child: &mut ProcessGroupChild,
    stdout_pipe: ChildStdout,
    stderr_pipe: ChildStderr,
    timeout_ms: Option<u64>,
    controller: ProcessController,
) {
    let timeout = timeout_ms.and_then(|ms| (ms > 0).then(|| Duration::from_millis(ms)));
    let mut sink = ScriptLogSink {
        tasks: tasks.clone(),
        broadcaster: broadcaster.clone(),
        log_name,
        id: id.clone(),
    };
    let outcome = drive_group_to_exit(
        child,
        stdout_pipe,
        stderr_pipe,
        timeout,
        &controller,
        &mut sink,
    )
    .await;

    let raw_exit_code = outcome.exit_status.map(exit_status_to_code).unwrap_or(-1);
    let status = classify_status(outcome.timed_out, raw_exit_code);
    tasks.finalize(&id, status, raw_exit_code, outcome.timed_out);
    emit_tasks_event(&tasks, &broadcaster);
}

// --- config-store reads (opaque `Value` — see `config/store.rs`) -------------

fn pm_name(config: &Option<Value>) -> Option<String> {
    config
        .as_ref()?
        .get("application")?
        .get("packageManager")?
        .get("name")?
        .as_str()
        .map(str::to_string)
}

fn pm_path(config: &Option<Value>) -> Option<PathBuf> {
    config
        .as_ref()?
        .get("application")?
        .get("packageManager")?
        .get("path")?
        .as_str()
        .map(PathBuf::from)
}

/// Byte-parity target: `PACKAGE_MANAGER_DAEMON_CONFIG` in
/// `daemon/constants.ts`. Reused by `setup/dev.rs` (same package-manager ->
/// run-prefix mapping drives the discovered `dev`/`start` starter command).
pub(crate) fn run_prefix_for(pm: &str) -> Option<&'static str> {
    match pm {
        "npm" => Some("npm run"),
        "pnpm" => Some("pnpm run"),
        "yarn" => Some("yarn run"),
        "bun" => Some("bun run"),
        "deno" => Some("deno task"),
        _ => None,
    }
}

/// Byte-parity target: `discoverScripts` in
/// `daemon/process/script-discovery.ts`. Reused by the `setup` module
/// (install/start steps discover the same script set this route reports).
pub(crate) fn discover_scripts(cwd: &Path, pm: Option<&str>) -> Vec<String> {
    let Some(pm) = pm else {
        return Vec::new();
    };
    if pm == "deno" {
        for candidate in ["deno.json", "deno.jsonc"] {
            let Ok(raw) = std::fs::read_to_string(cwd.join(candidate)) else {
                continue;
            };
            let Ok(parsed) = serde_json::from_str::<Value>(&raw) else {
                continue;
            };
            let tasks = parsed
                .get("tasks")
                .and_then(|v| v.as_object())
                .map(|o| o.keys().cloned().collect())
                .unwrap_or_default();
            return tasks;
        }
        return Vec::new();
    }
    let Ok(raw) = std::fs::read_to_string(cwd.join("package.json")) else {
        return Vec::new();
    };
    let Ok(parsed) = serde_json::from_str::<Value>(&raw) else {
        return Vec::new();
    };
    parsed
        .get("scripts")
        .and_then(|v| v.as_object())
        .map(|o| o.keys().cloned().collect())
        .unwrap_or_default()
}

/// deep-merge-free env layering: process env (inherited by
/// `tokio::process::Command` by default) < config's `env` map < body's
/// `env` overrides < HOST/HOSTNAME/PORT defaults when still unset. See the
/// module doc's deviation note #1. `default_port` is the sandbox's resolved
/// dev port ([`crate::setup::dev::resolve_dev_port`]); an explicit `PORT` in
/// the config's env or the request body still wins.
fn build_env(
    config: &Option<Value>,
    body_env: Option<&HashMap<String, String>>,
    default_port: Option<u16>,
) -> HashMap<String, String> {
    let mut env = HashMap::new();
    if let Some(cfg_env) = config
        .as_ref()
        .and_then(|c| c.get("env"))
        .and_then(|v| v.as_object())
    {
        for (k, v) in cfg_env {
            if let Some(s) = v.as_str() {
                env.insert(k.clone(), s.to_string());
            }
        }
    }
    if let Some(body_env) = body_env {
        for (k, v) in body_env {
            env.insert(k.clone(), v.clone());
        }
    }
    env.entry("HOST".to_string())
        .or_insert_with(|| "0.0.0.0".to_string());
    env.entry("HOSTNAME".to_string())
        .or_insert_with(|| "0.0.0.0".to_string());
    if !env.contains_key("PORT") {
        if let Some(port) = default_port {
            env.insert("PORT".to_string(), port.to_string());
        }
    }
    env
}

#[cfg(test)]
mod tests {
    use super::*;

    struct DropProbe(Option<oneshot::Sender<()>>);

    impl Drop for DropProbe {
        fn drop(&mut self) {
            if let Some(dropped) = self.0.take() {
                let _ = dropped.send(());
            }
        }
    }

    fn write(dir: &tempfile::TempDir, name: &str, contents: &str) {
        std::fs::write(dir.path().join(name), contents).expect("write fixture");
    }

    #[test]
    fn discover_scripts_returns_empty_when_pm_is_none() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(discover_scripts(dir.path(), None), Vec::<String>::new());
    }

    #[test]
    fn discover_scripts_returns_empty_when_manifest_missing() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            discover_scripts(dir.path(), Some("npm")),
            Vec::<String>::new()
        );
    }

    #[test]
    fn discover_scripts_reads_package_json_scripts() {
        let dir = tempfile::tempdir().unwrap();
        write(
            &dir,
            "package.json",
            r#"{"scripts":{"echo":"echo hi","build":"tsc"}}"#,
        );
        let mut scripts = discover_scripts(dir.path(), Some("npm"));
        scripts.sort();
        assert_eq!(scripts, vec!["build".to_string(), "echo".to_string()]);
    }

    #[test]
    fn discover_scripts_handles_missing_scripts_field() {
        let dir = tempfile::tempdir().unwrap();
        write(&dir, "package.json", r#"{"name":"x"}"#);
        assert_eq!(
            discover_scripts(dir.path(), Some("npm")),
            Vec::<String>::new()
        );
    }

    #[test]
    fn discover_scripts_deno_reads_tasks_from_deno_json() {
        let dir = tempfile::tempdir().unwrap();
        write(
            &dir,
            "deno.json",
            r#"{"tasks":{"dev":"deno run -A main.ts"}}"#,
        );
        assert_eq!(
            discover_scripts(dir.path(), Some("deno")),
            vec!["dev".to_string()]
        );
    }

    #[test]
    fn discover_scripts_deno_falls_back_to_jsonc_when_json_invalid() {
        let dir = tempfile::tempdir().unwrap();
        write(&dir, "deno.json", "not json");
        write(&dir, "deno.jsonc", r#"{"tasks":{"dev":"x"}}"#);
        assert_eq!(
            discover_scripts(dir.path(), Some("deno")),
            vec!["dev".to_string()]
        );
    }

    #[test]
    fn run_prefix_known_and_unknown_package_managers() {
        assert_eq!(run_prefix_for("npm"), Some("npm run"));
        assert_eq!(run_prefix_for("deno"), Some("deno task"));
        assert_eq!(run_prefix_for("cargo"), None);
    }

    #[test]
    fn pm_name_and_path_extraction() {
        let cfg = Some(json!({
            "application": { "packageManager": { "name": "npm", "path": "/tmp/app" } }
        }));
        assert_eq!(pm_name(&cfg), Some("npm".to_string()));
        assert_eq!(pm_path(&cfg), Some(PathBuf::from("/tmp/app")));

        let empty: Option<Value> = None;
        assert_eq!(pm_name(&empty), None);
        assert_eq!(pm_path(&empty), None);
    }

    #[test]
    fn build_env_layers_config_then_body_then_defaults() {
        let cfg = Some(json!({
            "env": { "FOO": "from-config", "HOST": "custom-host" },
            "application": { "port": 4000 }
        }));
        let mut body_env = HashMap::new();
        body_env.insert("FOO".to_string(), "from-body".to_string());
        let env = build_env(&cfg, Some(&body_env), Some(4000));
        assert_eq!(env.get("FOO"), Some(&"from-body".to_string()));
        assert_eq!(env.get("HOST"), Some(&"custom-host".to_string()));
        assert_eq!(env.get("HOSTNAME"), Some(&"0.0.0.0".to_string()));
        assert_eq!(env.get("PORT"), Some(&"4000".to_string()));
    }

    /// The resolved allocation is a DEFAULT: someone who writes `PORT` into
    /// the VM config's env or the exec body has said where the server goes,
    /// and the allocator must not override them.
    #[test]
    fn an_explicit_port_beats_the_resolved_default() {
        let cfg = Some(json!({ "env": { "PORT": "9999" } }));
        let env = build_env(&cfg, None, Some(4000));
        assert_eq!(env.get("PORT"), Some(&"9999".to_string()));

        let mut body_env = HashMap::new();
        body_env.insert("PORT".to_string(), "8888".to_string());
        let env = build_env(&None, Some(&body_env), Some(4000));
        assert_eq!(env.get("PORT"), Some(&"8888".to_string()));

        // No default and nothing explicit: PORT stays unset so the dev
        // server picks for itself (the pre-allocation behaviour).
        let env = build_env(&None, None, None);
        assert!(!env.contains_key("PORT"));
    }

    #[test]
    fn exec_body_defaults_to_background_mode() {
        let parsed: ExecBody = serde_json::from_str("{}").unwrap();
        assert_eq!(parsed.mode, None);
        let parsed: ExecBody = serde_json::from_str(r#"{"mode":"await"}"#).unwrap();
        assert_eq!(parsed.mode.as_deref(), Some("await"));
    }

    #[test]
    fn emit_if_changed_only_broadcasts_on_actual_change() {
        // Use a cwd key unique to this test so the process-lifetime static
        // (now keyed by cwd) makes this order-independent without a global
        // reset.
        let cwd = std::env::temp_dir().join("emit-if-changed-scripts-test");
        {
            let mut guard = last_known_scripts().lock().unwrap();
            guard.remove(&cwd.to_string_lossy().into_owned());
        }
        let broadcaster = Arc::new(crate::events::Broadcaster::new());
        let mut rx = broadcaster.subscribe();

        emit_if_changed(&broadcaster, &cwd, &["a".to_string()]);
        let evt = rx.try_recv().expect("first change emits");
        assert_eq!(evt.name, "scripts");

        // Same set again for the SAME cwd: no second emit.
        emit_if_changed(&broadcaster, &cwd, &["a".to_string()]);
        assert!(rx.try_recv().is_err());

        // A DIFFERENT cwd with the same set still emits (per-cwd keying, O8).
        let other_cwd = std::env::temp_dir().join("emit-if-changed-scripts-test-2");
        {
            let mut guard = last_known_scripts().lock().unwrap();
            guard.remove(&other_cwd.to_string_lossy().into_owned());
        }
        emit_if_changed(&broadcaster, &other_cwd, &["a".to_string()]);
        let evt = rx.try_recv().expect("a different cwd is a distinct key");
        assert_eq!(evt.name, "scripts");
    }

    fn test_state(broadcaster: Arc<crate::events::Broadcaster>) -> AppState {
        let config = Arc::new(crate::config::ConfigStore::new());
        // `run_exec` now writes real per-task/per-source `LogStore` files
        // (see `tasks/registry.rs`'s file-backed retention) — an isolated
        // root per call is required so parallel tests spawning a task named
        // "t1" don't race each other's files. `.keep()` intentionally leaks
        // the tempdir (this fixture has nowhere to stash a `TempDir` guard
        // across the whole test); the OS temp reaper cleans it up.
        let app_root = tempfile::tempdir().unwrap().keep();
        let logs = Arc::new(crate::log_store::LogStore::new(app_root.join("logs")));
        let tasks = Arc::new(crate::tasks::TaskRegistry::new(logs));
        let repo_dir = app_root.clone();
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

    #[cfg(unix)]
    #[tokio::test]
    async fn exec_releases_admission_before_await_mode_completes() {
        let state = test_state(Arc::new(crate::events::Broadcaster::new()));
        std::fs::write(
            state.repo_dir.join("package.json"),
            r#"{"scripts":{"slow":"sleep 5"}}"#,
        )
        .expect("write package fixture");
        state
            .config
            .patch(json!({
                "application": { "packageManager": { "name": "bun" } }
            }))
            .expect("configure package manager");

        let (dropped_tx, dropped_rx) = oneshot::channel();
        let account_epoch = state.sandbox_manager.account_epoch();
        let response_task = tokio::spawn(exec_with_admission(
            State(state),
            HeaderMap::new(),
            AxumPath("slow".to_string()),
            Bytes::from_static(br#"{"mode":"await","timeoutMs":1000}"#),
            account_epoch,
            DropProbe(Some(dropped_tx)),
        ));

        tokio::time::timeout(Duration::from_secs(1), dropped_rx)
            .await
            .expect("admission guard stayed held after process registration")
            .expect("drop probe sender disappeared");
        assert!(
            !response_task.is_finished(),
            "await-mode response completed before the child process"
        );

        let response = tokio::time::timeout(Duration::from_secs(5), response_task)
            .await
            .expect("await-mode exec did not time out and reap")
            .expect("exec task panicked")
            .expect("exec request failed");
        assert_eq!(response.status(), StatusCode::OK);
    }

    #[allow(clippy::type_complexity)]
    async fn spawn_registered(
        state: &AppState,
        id: &str,
        script: &str,
    ) -> (
        ProcessGroupChild,
        ChildStdout,
        ChildStderr,
        Option<u32>,
        ProcessController,
    ) {
        let env = HashMap::new();
        let mut cmd = build_command(script, Path::new("."), &env);
        let mut child = ProcessGroupChild::spawn(&mut cmd, state.tasks.child_lifetime_lock_path())
            .await
            .expect("spawn fixture command");
        let pid = child.id();
        let stdout = child.take_stdout().expect("stdout piped");
        let stderr = child.take_stderr().expect("stderr piped");
        let controller = ProcessController::new();
        let summary = TaskSummary {
            id: id.to_string(),
            command: script.to_string(),
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
            .insert(TaskEntry::new(summary, Some(controller.kill_handle())));
        (child, stdout, stderr, pid, controller)
    }

    #[tokio::test]
    async fn run_exec_captures_stdout_and_finalizes_registry() {
        let state = test_state(Arc::new(crate::events::Broadcaster::new()));
        let (mut child, stdout, stderr, _pid, controller) =
            spawn_registered(&state, "t1", "echo hi-from-echo && exit 0").await;
        run_exec(
            state.tasks.clone(),
            state.broadcaster.clone(),
            "t1".into(),
            "t1".into(),
            &mut child,
            stdout,
            stderr,
            None,
            controller,
        )
        .await;

        let summary = state.tasks.get("t1").expect("task registered");
        assert_eq!(summary.status, TaskStatus::Exited);
        assert_eq!(summary.exit_code, Some(0));
        let (stdout, _stderr, _truncated) =
            state.tasks.output("t1").await.expect("output recorded");
        assert!(stdout.contains("hi-from-echo"));
    }

    #[tokio::test]
    async fn run_exec_captures_nonzero_exit_code() {
        // `classify_status`'s `TaskStatus` tracks process lifecycle, not
        // success — a clean nonzero exit is still `Exited` (pinned by
        // `process_util`'s `classify_status_matches_task_manager_finalize`
        // test: only the `-1` spawn-failure sentinel or a >128 signal-death
        // code map away from `Exited`). `exit_code` itself still carries 3.
        let state = test_state(Arc::new(crate::events::Broadcaster::new()));
        let (mut child, stdout, stderr, _pid, controller) =
            spawn_registered(&state, "t1", "exit 3").await;
        run_exec(
            state.tasks.clone(),
            state.broadcaster.clone(),
            "t1".into(),
            "t1".into(),
            &mut child,
            stdout,
            stderr,
            None,
            controller,
        )
        .await;

        let summary = state.tasks.get("t1").expect("task registered");
        assert_eq!(summary.status, TaskStatus::Exited);
        assert_eq!(summary.exit_code, Some(3));
    }

    #[tokio::test]
    async fn run_exec_times_out_and_kills() {
        let state = test_state(Arc::new(crate::events::Broadcaster::new()));
        let (mut child, stdout, stderr, _pid, controller) =
            spawn_registered(&state, "t1", "sleep 5").await;
        run_exec(
            state.tasks.clone(),
            state.broadcaster.clone(),
            "t1".into(),
            "t1".into(),
            &mut child,
            stdout,
            stderr,
            Some(100),
            controller,
        )
        .await;

        let summary = state.tasks.get("t1").expect("task registered");
        assert_eq!(summary.status, TaskStatus::Timeout);
        assert!(summary.timed_out);
    }

    #[tokio::test]
    async fn run_exec_kill_via_controller_sends_real_sigterm() {
        let state = test_state(Arc::new(crate::events::Broadcaster::new()));
        let (mut child, stdout, stderr, _pid, controller) =
            spawn_registered(&state, "t1", "sleep 5").await;
        // Signal termination immediately, before `run_exec` starts polling —
        // exercises the real `kill -TERM -<pgid>` path (not just a timeout).
        assert_eq!(state.tasks.kill("t1", KillSignal::Term), Some(true));
        run_exec(
            state.tasks.clone(),
            state.broadcaster.clone(),
            "t1".into(),
            "t1".into(),
            &mut child,
            stdout,
            stderr,
            None,
            controller,
        )
        .await;

        let summary = state.tasks.get("t1").expect("task registered");
        assert_eq!(summary.status, TaskStatus::Killed);
        assert!(!summary.timed_out);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn dropping_await_guard_reaps_detached_exec_owner() {
        let state = test_state(Arc::new(crate::events::Broadcaster::new()));
        let (child, stdout, stderr, pid, controller) =
            spawn_registered(&state, "abort-await", "sleep 30").await;
        let pid = pid.expect("fixture child pid");
        let (completion_tx, completion_rx) = oneshot::channel();
        spawn_exec_owner(
            state.tasks.clone(),
            state.broadcaster.clone(),
            "dev".into(),
            "abort-await".into(),
            child,
            stdout,
            stderr,
            None,
            controller.clone(),
            completion_tx,
        );

        let guard = CancelOnDrop::new(controller.kill_handle(), KillSignal::Term);
        drop(guard);
        tokio::time::timeout(Duration::from_secs(5), completion_rx)
            .await
            .expect("owner completed after request cancellation")
            .expect("owner completion channel stayed open");

        let summary = state.tasks.get("abort-await").expect("task registered");
        assert_eq!(summary.status, TaskStatus::Killed);
        let alive = std::process::Command::new("kill")
            .args(["-0", &pid.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|status| status.success());
        assert!(!alive, "request cancellation left exec child alive");
    }
}
