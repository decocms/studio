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
//! 3. **`dev`/`start` own the dev lifecycle**: for the two names
//!    `setup::dev::is_well_known_starter` recognizes, this route does what
//!    the daemon's `exec.go` does — an ATOMIC spawn-unless-already-running
//!    (`{taskId, status, alreadyRunning: true}` instead of a rival dev
//!    server) plus a `starting` nudge gated on `idle|start-failed|crashed`
//!    — and then one thing the daemon does NOT do: it takes the
//!    orchestrator's dev token and arms `setup::dev::confirm_running`.
//!    That last step has no Go counterpart because the daemon runs a
//!    standing prober (`daemon-go/internal/probe/probe.go`) which owns
//!    `running` no matter who spawned the server, while this crate
//!    deliberately has only the single-shot probe tied to the dev-task
//!    claim (see the `setup` module doc). Without it the dedupe would
//!    answer `alreadyRunning: true` over a sandbox whose phase can never
//!    advance — the bug this exists to fix.
//!
//!    What this deliberately does NOT copy from `setup/dev.rs::run`: it
//!    never reaps the previously persisted dev group and never writes
//!    `dev-process.json`. Reaping is keyed on a record, not on a script
//!    name, so a `start` click would TERM a healthy `dev` server; and a
//!    second writer of that record breaks the 1 Hz identity refresher's
//!    pid/pgid/started_at equality guard. The daemon's exec route reaps
//!    nothing either. The cost is unchanged from today: a server started
//!    from this route stays invisible to the next pipeline reap.
//!
//! 4. **UTF-8 chunk boundaries**: unlike `routes/bash.rs`'s
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

/// Resolve the per-handle [`SandboxTarget`] from the request's
/// `x-decocms-sandbox-handle` header (absent/unknown -> active/global) so a
/// script runs in — and its logs/tasks are observed on — the RIGHT sandbox's
/// workdir + orchestrator quadruple. See [`AppState::resolve_sandbox_target`].
fn resolve(state: &AppState, headers: &HeaderMap) -> SandboxTarget {
    state.resolve_sandbox_target(crate::sandbox::handle_from_headers(headers))
}

// --- GET /_sandbox/scripts ---------------------------------------------------

pub async fn list(State(state): State<AppState>, headers: HeaderMap) -> Json<Value> {
    let target = resolve(&state, &headers);
    let snapshot = target.config.snapshot();
    let pm = pm_name(&snapshot.config);
    // An unresolvable `packageManager.path` discovers nothing rather than
    // falling back to the repository root: the root's `package.json` belongs
    // to a different workspace than the one the config names, and reporting
    // ITS scripts is how the drawer ends up offering a script `exec` will
    // then refuse. This route is infallible by contract (byte-parity with
    // `daemon/routes/scripts.ts`), so the empty set is the only honest answer.
    let cwd = match resolve_script_root(&snapshot.config, &target.repo_dir).await {
        Ok(cwd) => cwd,
        Err(_) => return Json(json!({ "scripts": [] })),
    };
    let scripts = discover_scripts(&cwd, pm.as_deref());
    emit_if_changed(&target.broadcaster, &cwd, &scripts);
    Json(json!({ "scripts": scripts }))
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
    let target = resolve(&state, &headers);
    let snapshot = target.config.snapshot();
    let Some(pm) = pm_name(&snapshot.config) else {
        return Err(ApiError::conflict(
            "no application configured; POST /config first",
        ));
    };
    let run_prefix = run_prefix_for(&pm)
        .ok_or_else(|| ApiError::internal(format!("unknown package manager: {pm}")))?;

    let cwd = resolve_script_root(&snapshot.config, &target.repo_dir)
        .await
        .map_err(ApiError::conflict)?;
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

    // Everything from here runs against the RESOLVED sandbox's registry +
    // broadcaster (cheap `Arc` clones), so the spawned drain task can outlive
    // this handler without borrowing `target`.
    let tasks = target.tasks.clone();
    let broadcaster = target.broadcaster.clone();

    // A `dev`/`start` script IS this sandbox's dev server — the same command
    // the pipeline's own start step spawns — and only the task holding the
    // orchestrator's dev token may publish `running`. So this route owns the
    // lifecycle for those two names; see this module's doc for the split.
    let starter = crate::setup::dev::is_well_known_starter(&name);

    let controller = ProcessController::new();
    let kill_handle = controller.kill_handle();
    let id = tasks.next_id();
    let entry = TaskEntry::new(
        TaskSummary {
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
        },
        Some(kill_handle.clone()),
    );

    // A starter claims its `log_name` slot BEFORE the spawn: two concurrent
    // clicks that both spawn is the race `insert_unless_log_name_running`
    // exists to close. Non-starters keep the historical spawn-then-register
    // order, so a failed spawn still leaves no task row behind.
    let deferred_entry = if starter {
        match tasks.insert_unless_log_name_running(entry) {
            // Already serving. Never start a rival — hand back the running
            // task and adopt it into the lifecycle instead.
            Some(existing) => {
                adopt_running_dev(&target.setup, &existing, default_port);
                return Ok(Json(json!({
                    "taskId": existing.id,
                    "status": existing.status.as_str(),
                    "alreadyRunning": true,
                }))
                .into_response());
            }
            None => {
                emit_tasks_event(&tasks, &broadcaster);
                None
            }
        }
    } else {
        Some(entry)
    };

    let Some(admission) = state.shutdown.admit_work().await else {
        release_reservation(starter, &tasks, &broadcaster, &id);
        return Err(ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "application is shutting down",
        ));
    };

    let mut cmd = build_command(&command, &cwd, &env);
    let mut child = match ProcessGroupChild::spawn(&mut cmd, tasks.child_lifetime_lock_path()).await
    {
        Ok(child) => child,
        Err(err) => {
            release_reservation(starter, &tasks, &broadcaster, &id);
            drop(admission);
            return Err(ApiError::internal(format!("spawn error: {err}")));
        }
    };

    if let Some(entry) = deferred_entry {
        tasks.insert(entry);
        emit_tasks_event(&tasks, &broadcaster);
    }

    // Registration deliberately precedes these takes. Once spawn succeeds,
    // shutdown can always find a durable controller; there is no await or
    // cancellation point between process creation and TaskRegistry ownership.
    let (Some(stdout_pipe), Some(stderr_pipe)) = (child.take_stdout(), child.take_stderr()) else {
        spawn_missing_stdio_cleanup(tasks, broadcaster, id, child);
        drop(admission);
        return Err(ApiError::internal("spawn error: missing stdio pipe"));
    };

    let dev = starter.then(|| {
        own_dev_lifecycle(&target.setup, &id, default_port);
        DevOwnership {
            setup: target.setup.clone(),
            starter: name.clone(),
        }
    });

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
        dev,
        completion_tx,
    );
    drop(admission);

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
) -> Json<Value> {
    let target = resolve(&state, &headers);
    let matching: Vec<String> = target
        .tasks
        .list(Some(&[TaskStatus::Running]))
        .into_iter()
        .filter(|s| s.log_name.as_deref() == Some(name.as_str()))
        .map(|s| s.id)
        .collect();

    let killed = matching
        .iter()
        .filter(|id| matches!(target.tasks.kill(id, KillSignal::Term), Some(true)))
        .count();

    Json(json!({ "killed": killed }))
}

// --- dev lifecycle ownership --------------------------------------------------

/// Finalize a starter's pre-spawn reservation when the spawn never happened.
///
/// The reservation is what makes the dedupe atomic, but it publishes a
/// `Running` row before there is a process to back it. An un-finalized row
/// would make every later `POST /_sandbox/exec/dev` adopt a task that never
/// had a process — and `TaskRegistry::kill` reports success for it while
/// leaving it `Running`, so nothing could ever clear it. No-op for
/// non-starters, which are still registered only after a successful spawn.
fn release_reservation(
    starter: bool,
    tasks: &Arc<TaskRegistry>,
    broadcaster: &Arc<Broadcaster>,
    id: &str,
) {
    if !starter {
        return;
    }
    tasks.finalize(id, TaskStatus::Failed, -1, false);
    emit_tasks_event(tasks, broadcaster);
}

/// Carried by a starter's process owner so the child's exit reports the same
/// terminal phase `setup/dev.rs`'s own watcher would have reported.
struct DevOwnership {
    setup: Arc<crate::setup::SetupOrchestrator>,
    /// The script name, for the `start-failed` message's wording.
    starter: String,
}

/// Make a freshly spawned starter the lifecycle's dev server: take the dev
/// token, raise `starting` if the phase is behind, and arm the readiness
/// probe that publishes `running`.
///
/// The claim is unconditional, exactly as `setup/dev.rs::run` claims: the
/// newest dev process IS the dev server, and the token is a generation
/// marker. Reaching this function at all means no `Running` task held the
/// `dev`/`start` slot, so the only claim this can displace belongs to a
/// pipeline spawn still inside its pre-registration window (its reap runs
/// before it registers). That window can already produce two dev servers
/// today; this narrows the exec-vs-exec case to zero and leaves the
/// exec-vs-pipeline case exactly as it was, with the newest spawn owning the
/// token — the same rule the pipeline itself applies.
fn own_dev_lifecycle(
    setup: &Arc<crate::setup::SetupOrchestrator>,
    task_id: &str,
    port: Option<u16>,
) {
    setup.claim_dev_task(task_id);

    // Gate the way the daemon gates it (`daemon-go/internal/routes/exec.go`
    // `:138-141`): `starting` re-raises the full-canvas boot overlay, so a
    // phase that is already past it — `running` over a live preview, or a
    // clone/install still in flight — must never be dragged backwards. The
    // probe below is what moves a healthy server forward from here.
    let phase = setup.lifecycle_snapshot();
    let phase = phase.get("phase").and_then(Value::as_str);
    if matches!(
        phase,
        None | Some("idle") | Some("start-failed") | Some("crashed")
    ) {
        setup.transition_lifecycle(json!({ "phase": "starting" }));
    }

    arm_readiness_probe(setup, task_id, port);
}

/// Point the dev token at an ALREADY-RUNNING starter task and re-arm its
/// readiness probe.
///
/// This is the whole fix for the reported bug: a dev server relaunched from
/// the run button used to serve traffic while the phase stayed wherever the
/// last pipeline run left it, because nothing re-armed a probe and nothing
/// held the token that lets one publish. Adopting is deliberately *additive*
/// — it never transitions the phase itself, and the only transition it can
/// cause is `confirm_running`'s `running`. So a click can move a stuck
/// sandbox forward and can never drag a working preview back under the boot
/// overlay.
///
/// Deliberate deviation from the daemon (documented, not hidden): Go's exec
/// route returns `alreadyRunning` and stops there
/// (`daemon-go/internal/routes/exec.go:126-133`), because a standing prober
/// (`daemon-go/internal/probe/probe.go`) owns `running` for it regardless of
/// who spawned the server. This crate deliberately has no standing prober
/// (see the `setup` module doc), so without this re-arm the dedupe would
/// answer `alreadyRunning: true` and leave the phase stuck forever.
fn adopt_running_dev(
    setup: &Arc<crate::setup::SetupOrchestrator>,
    existing: &TaskSummary,
    port: Option<u16>,
) {
    // Never steal from a live owner: a pipeline spawn that is mid-boot owns
    // both its probe and its exit reporter through this token.
    if !setup.claim_dev_task_if_available(&existing.id) {
        return;
    }
    arm_readiness_probe(setup, &existing.id, port);
}

/// Spawn the same eager probe `setup/dev.rs::run` spawns. Detached and
/// self-cancelling: `confirm_running` re-checks `is_current_dev_task` every
/// iteration, so it stops the moment this task exits or is replaced, and its
/// only possible write is `{"phase":"running", port, htmlSupport}`.
fn arm_readiness_probe(
    setup: &Arc<crate::setup::SetupOrchestrator>,
    task_id: &str,
    port: Option<u16>,
) {
    // No allocation means no address to probe; the stdout port-sniffer that
    // would rescue this case lives in the pipeline's watcher, not here.
    let Some(port) = port else {
        return;
    };
    let setup = setup.clone();
    let task_id = task_id.to_string();
    tokio::spawn(async move {
        crate::setup::dev::confirm_running(
            setup,
            task_id,
            port,
            crate::setup::dev::BOOT_PROBE_ATTEMPTS,
        )
        .await;
    });
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
    dev: Option<DevOwnership>,
    completion_tx: oneshot::Sender<()>,
) {
    tokio::spawn(async move {
        // A panicking owner must still release the dev token, or the sandbox
        // keeps a claim no live task backs and every later adopt refuses it.
        let panic_dev = dev.as_ref().map(|dev| dev.setup.clone());
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
            dev,
        ))
        .catch_unwind()
        .await;
        if driven.is_err() {
            child
                .kill_and_reap(Duration::from_secs(2), "script process-owner panic cleanup")
                .await;
            if let Some(setup) = panic_dev {
                if setup.finish_dev_task(&id) && !setup.is_closed() {
                    setup.transition_lifecycle(crate::setup::start_failed(
                        "dev process owner panicked",
                    ));
                }
            }
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
/// note #4 on the UTF-8 chunk-boundary gap this deliberately accepts.
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
    dev: Option<DevOwnership>,
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

    // Byte-parity with `setup/dev.rs`'s own terminal block, down to the
    // ordering: read `intentional`, release the token, THEN finalize — so a
    // concurrent adopt never sees a token backed by a task that is already
    // gone. A kill sets `intentional`, which is what keeps `POST
    // /exec/dev/kill` from painting a failure the user asked for.
    let released = dev.as_ref().map(|dev| {
        let intentional = tasks
            .get(&id)
            .and_then(|summary| summary.intentional)
            .unwrap_or(false);
        (dev, dev.setup.finish_dev_task(&id), intentional)
    });

    tasks.finalize(&id, status, raw_exit_code, outcome.timed_out);
    emit_tasks_event(&tasks, &broadcaster);

    if let Some((dev, was_current, intentional)) = released {
        if was_current && !dev.setup.is_closed() && !intentional && raw_exit_code != 0 {
            dev.setup
                .transition_lifecycle(crate::setup::start_failed(format!(
                    "{} script exited with code {raw_exit_code}",
                    dev.starter
                )));
        }
    }
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

/// The directory a script runs in: `repo_dir`, or the validated
/// `application.packageManager.path` beneath it.
///
/// Delegates to [`crate::setup::install::pm_root`] — the same resolver the
/// setup pipeline's install/start steps use — so `POST /exec/dev` and the
/// pipeline's own start step land in the same workspace. This file used to
/// read `packageManager.path` on its own and hand the RAW value to
/// `Command::current_dir`; since `validate_package_manager_path`
/// (`config/validate.rs:152`) requires that value to be *relative to the
/// repository*, the effect was a path resolved against local-api's own
/// process cwd — so on any monorepo, script discovery read the wrong
/// `package.json` and `exec` 404'd a script that plainly exists.
///
/// Deliberate deviation from the daemon (documented, not hidden): Go's
/// `paths.ResolvePmRoot` (`daemon-go/internal/paths/paths.go:22`) is a bare
/// join with no existence or containment check, so a bad path there degrades
/// to an empty script set. This crate resolves through `pm_root`, which
/// canonicalizes and re-checks containment, and surfaces the failure — the
/// same strictness `setup/install.rs` and `setup/dev.rs` already chose for
/// the pipeline.
async fn resolve_script_root(config: &Option<Value>, repo_dir: &Path) -> Result<PathBuf, String> {
    let Some(config) = config.as_ref() else {
        return Ok(repo_dir.to_path_buf());
    };
    crate::setup::install::pm_root(config, repo_dir).await
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
    fn pm_name_extraction() {
        let cfg = Some(json!({
            "application": { "packageManager": { "name": "npm", "path": "apps/web" } }
        }));
        assert_eq!(pm_name(&cfg), Some("npm".to_string()));

        let empty: Option<Value> = None;
        assert_eq!(pm_name(&empty), None);
    }

    /// Inverts the old `pm_name_and_path_extraction`, which asserted this
    /// file's own `pm_path` handed back `packageManager.path` VERBATIM (and
    /// used an absolute `/tmp/app` that `validate_package_manager_path`
    /// rejects outright). A relative path — the only kind config validation
    /// accepts — must be joined onto the repository, exactly as the setup
    /// pipeline's start step resolves it, or the run button discovers and
    /// runs a different workspace's scripts than the pipeline does.
    #[tokio::test]
    async fn script_root_joins_a_relative_pm_path_onto_the_repository() {
        let repo = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(repo.path().join("apps/web")).unwrap();
        let cfg = Some(json!({
            "application": { "packageManager": { "name": "npm", "path": "apps/web" } }
        }));

        let root = resolve_script_root(&cfg, repo.path()).await.unwrap();

        assert_eq!(
            root,
            std::fs::canonicalize(repo.path().join("apps/web")).unwrap()
        );
    }

    #[tokio::test]
    async fn script_root_is_the_repository_when_no_pm_path_is_configured() {
        let repo = tempfile::tempdir().unwrap();

        assert_eq!(
            resolve_script_root(&None, repo.path()).await.unwrap(),
            repo.path()
        );

        let cfg = Some(json!({ "application": { "packageManager": { "name": "npm" } } }));
        assert_eq!(
            resolve_script_root(&cfg, repo.path()).await.unwrap(),
            repo.path()
        );
    }

    /// The strictness this crate chose for the pipeline now also covers the
    /// run button: an absolute path is refused by config validation, and a
    /// path naming a directory that isn't there fails to canonicalize. Either
    /// way `exec` reports the misconfiguration instead of silently spawning
    /// in whatever directory the process happens to be sitting in.
    #[tokio::test]
    async fn script_root_rejects_an_escaping_or_missing_pm_path() {
        let repo = tempfile::tempdir().unwrap();

        let absolute = Some(json!({
            "application": { "packageManager": { "name": "npm", "path": "/tmp/app" } }
        }));
        assert!(resolve_script_root(&absolute, repo.path()).await.is_err());

        let escaping = Some(json!({
            "application": { "packageManager": { "name": "npm", "path": "../elsewhere" } }
        }));
        assert!(resolve_script_root(&escaping, repo.path()).await.is_err());

        let missing = Some(json!({
            "application": { "packageManager": { "name": "npm", "path": "apps/nope" } }
        }));
        assert!(resolve_script_root(&missing, repo.path()).await.is_err());
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
            None,
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
            None,
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
            None,
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
            None,
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
            None,
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

    // --- dev lifecycle ownership ---------------------------------------------

    /// A real listener on a real port. `confirm_running` accepts any HTTP
    /// response, so this is exactly as much server as a dev server needs to
    /// be to count as "up" — no mock, no injected client.
    async fn serve_until_aborted() -> (u16, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                use tokio::io::AsyncWriteExt;
                let _ = stream
                    .write_all(
                        b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 2\r\n\r\nhi",
                    )
                    .await;
                let _ = stream.shutdown().await;
            }
        });
        (port, handle)
    }

    fn running_dev(id: &str) -> TaskEntry {
        TaskEntry::new(
            TaskSummary {
                id: id.to_string(),
                command: "npm run dev".to_string(),
                status: TaskStatus::Running,
                exit_code: None,
                started_at: now_ms(),
                finished_at: None,
                timed_out: false,
                truncated: false,
                log_name: Some("dev".to_string()),
                intentional: None,
            },
            None,
        )
    }

    async fn await_phase(setup: &Arc<crate::setup::SetupOrchestrator>, phase: &str) -> Value {
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            let snapshot = setup.lifecycle_snapshot();
            if snapshot.get("phase").and_then(Value::as_str) == Some(phase) {
                return snapshot;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "lifecycle never reached {phase}: {snapshot}"
            );
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }

    /// THE regression test for the reported bug. A dev server relaunched from
    /// the run button served traffic while the phase stayed pinned at
    /// `starting` forever, because nothing held the dev token and so nothing
    /// could ever publish `running`. Adopting the running task must move a
    /// stuck sandbox forward on its own.
    #[tokio::test]
    async fn adopting_a_running_dev_server_publishes_running() {
        let (port, server) = serve_until_aborted().await;
        let state = test_state(Arc::new(crate::events::Broadcaster::new()));
        state.tasks.insert(running_dev("t1"));
        state
            .setup
            .transition_lifecycle(json!({ "phase": "starting" }));
        let existing = state.tasks.get("t1").unwrap();

        adopt_running_dev(&state.setup, &existing, Some(port));

        let snapshot = await_phase(&state.setup, "running").await;
        assert_eq!(snapshot.get("port"), Some(&json!(port)));
        assert_eq!(snapshot.get("htmlSupport"), Some(&json!(true)));
        assert!(state.setup.is_current_dev_task("t1"));
        server.abort();
    }

    /// Adopting must never disarm the pipeline's own in-flight spawn: that
    /// silences its probe AND its exit reporter, which is how a healthy
    /// server ends up under a permanent boot overlay.
    #[tokio::test]
    async fn adopting_does_not_steal_a_live_pipeline_claim() {
        let (port, server) = serve_until_aborted().await;
        let state = test_state(Arc::new(crate::events::Broadcaster::new()));
        state.tasks.insert(running_dev("pipeline-task"));
        state.setup.claim_dev_task("pipeline-task");
        state
            .setup
            .transition_lifecycle(json!({ "phase": "starting" }));
        state.tasks.insert(running_dev("exec-task"));
        let existing = state.tasks.get("exec-task").unwrap();

        adopt_running_dev(&state.setup, &existing, Some(port));
        tokio::time::sleep(Duration::from_millis(300)).await;

        assert!(state.setup.is_current_dev_task("pipeline-task"));
        assert_eq!(
            state.setup.lifecycle_snapshot(),
            json!({ "phase": "starting" }),
            "an adopt that lost the claim must publish nothing"
        );
        server.abort();
    }

    /// A spawn from the run button raises the boot overlay only from a phase
    /// that is behind it. Dragging `running` back to `starting` would blank a
    /// preview that is already serving — the hazard
    /// `sandbox-lifecycle-context.test.ts` exists for — and is why the daemon
    /// gates the same transition on `idle|start-failed|crashed`.
    #[tokio::test]
    async fn owning_the_lifecycle_never_drags_a_live_preview_back_to_starting() {
        let state = test_state(Arc::new(crate::events::Broadcaster::new()));
        let serving = json!({ "phase": "running", "port": 4000, "htmlSupport": true });
        state.setup.transition_lifecycle(serving.clone());

        own_dev_lifecycle(&state.setup, "exec-task", None);

        assert_eq!(state.setup.lifecycle_snapshot(), serving);
        assert!(
            state.setup.is_current_dev_task("exec-task"),
            "the newest dev spawn still owns the token"
        );
    }

    #[tokio::test]
    async fn owning_the_lifecycle_raises_starting_from_a_terminal_phase() {
        for behind in [
            json!({ "phase": "idle" }),
            crate::setup::start_failed("boom"),
            json!({ "phase": "crashed" }),
        ] {
            let state = test_state(Arc::new(crate::events::Broadcaster::new()));
            state.setup.transition_lifecycle(behind.clone());

            own_dev_lifecycle(&state.setup, "exec-task", None);

            assert_eq!(
                state.setup.lifecycle_snapshot(),
                json!({ "phase": "starting" }),
                "a run-button spawn must clear the stale phase {behind}"
            );
        }
    }

    /// A starter whose spawn never happened must not leave a `Running` row
    /// behind: it would make every later `POST /exec/dev` adopt a task with
    /// no process, and `TaskRegistry::kill` reports success without clearing
    /// it, so the run button would be dead for the life of the process.
    #[test]
    fn a_released_reservation_cannot_be_adopted() {
        let state = test_state(Arc::new(crate::events::Broadcaster::new()));
        state.tasks.insert(running_dev("t1"));

        release_reservation(true, &state.tasks, &state.broadcaster, "t1");

        assert_eq!(state.tasks.get("t1").unwrap().status, TaskStatus::Failed);
        assert!(
            state
                .tasks
                .insert_unless_log_name_running(running_dev("t2"))
                .is_none(),
            "a released reservation must not block the next start"
        );
    }
}
