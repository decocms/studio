//! Start step — spawns the discovered `dev`/`start` script, sniffs its bind
//! announcement from stdout, confirms with one HTTP probe, then transitions
//! `lifecycle` to `running` and emits `reload:{}`. Byte-parity in spirit
//! with `daemon/entry.ts`'s port-sniffer + probe wiring
//! (`process/port-sniffer.ts` + `probe.ts`), collapsed into a single-shot
//! "spawn, sniff, confirm-once, done" sequence rather than a standing
//! supervisor — see the `setup` module doc's "Scope narrower than the TS
//! daemon" section for what that drops (continuous crash detection,
//! dirty-baseline arming).
//!
//! The spawned process is registered in the SAME `state.tasks` registry the
//! bash/tasks/scripts families use (`TaskRegistry::next_id`/`insert`/
//! `append_output`/`finalize`), so it shows up in `GET /_sandbox/tasks` and
//! streams via `/_sandbox/tasks/:id/stream` like any other task — reuses
//! `routes/scripts.rs`'s `build_command`/`run_prefix_for`/`discover_scripts`
//! and the shared `crate::process_util` lifecycle helpers
//! (`kill_group`/`exit_status_to_code`/`classify_status`/`emit_tasks_event`)
//! rather than re-deriving the same process-spawn plumbing a third time in
//! this crate.

use std::future::Future;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use futures_util::FutureExt;
use regex::Regex;
use serde_json::{json, Value};
use tokio::io::AsyncReadExt;

use super::install::{manifest_present, pm_root};
use super::SetupOrchestrator;
use crate::process_group::ProcessGroupChild;
use crate::process_util::{classify_status, emit_tasks_event, exit_status_to_code, kill_group};
use crate::routes::scripts::{build_command, discover_scripts, run_prefix_for};
use crate::sandbox::persist::{DevProcessIdentity, DevProcessRecord};
use crate::tasks::{
    now_ms, KillSignal, OutputStream, ProcessController, TaskEntry, TaskStatus, TaskSummary,
};

const WELL_KNOWN_STARTERS: [&str; 2] = ["dev", "start"];
/// 40 attempts * 250ms = 10s — generous enough for a freshly `npm install`-ed
/// dev server to finish booting AFTER it has already announced its bind port
/// (the announcement itself means the listener is up, so this is mostly
/// slack for a loaded CI box), bounded so a script that lies about being
/// ready can't hang the pipeline forever.
const PROBE_ATTEMPTS: u32 = 40;
/// The budget for the probe that starts at SPAWN, before anything has been
/// announced — see [`run`]'s eager `confirm_running`.
///
/// [`PROBE_ATTEMPTS`] is sized for the window after a listener exists and is
/// far too short here: this one has to outlast the whole build, and a starter
/// like `bun run generate && next dev` spends minutes there before it binds
/// anything. It is not really a timeout at all — [`confirm_running`] rechecks
/// `is_current_dev_task` every iteration, so it stops the moment the dev task
/// exits or is replaced. The count only bounds a process that stays alive
/// forever without ever listening.
const BOOT_PROBE_ATTEMPTS: u32 = 4 * 60 * 20;
const PROBE_INTERVAL: Duration = Duration::from_millis(250);
const IDENTITY_CAPTURE_ATTEMPTS: u32 = 20;
const IDENTITY_CAPTURE_INTERVAL: Duration = Duration::from_millis(25);
const IDENTITY_REFRESH_INTERVAL: Duration = Duration::from_secs(1);
const STALE_TERM_GRACE: Duration = Duration::from_millis(800);
const STALE_KILL_GRACE: Duration = Duration::from_secs(1);

#[derive(Debug, PartialEq, Eq)]
enum GroupIdentityMatch {
    Gone,
    Verified(Vec<DevProcessIdentity>),
    Unverifiable,
}

fn match_group_identity(
    recorded: &[DevProcessIdentity],
    current: Vec<DevProcessIdentity>,
) -> GroupIdentityMatch {
    if current.is_empty() {
        return GroupIdentityMatch::Gone;
    }
    if recorded.is_empty() {
        return GroupIdentityMatch::Unverifiable;
    }
    if current.iter().any(|candidate| recorded.contains(candidate)) {
        GroupIdentityMatch::Verified(current)
    } else {
        GroupIdentityMatch::Unverifiable
    }
}

fn port_pattern() -> &'static Regex {
    static RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| {
        // Byte-parity target: `process/port-sniffer.ts::URL_PATTERN`.
        Regex::new(
            r"(?:Local:|Listening on)[^\n]*?https?://(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d+)",
        )
        .expect("static port-sniff regex is valid")
    })
}

use crate::config::get_str;

/// Discovers a starter script and spawns it; on failure to find one,
/// transitions `lifecycle` to `start-failed` with a diagnostic message
/// (byte-parity with `diagnoseNoStartCommand`) and returns without spawning
/// anything.
pub(super) async fn run(orch: &Arc<SetupOrchestrator>, config: &Value) {
    // A Start-only resume (no-op config transition) skips Install, so a
    // repository whose package manager was never configured arrives here
    // undetected. Fill the absence from the checkout, and when that is what
    // named the manager, run the skipped install before starting — the
    // detected manager's dependencies were never fetched.
    let had_pm = get_str(config, &["application", "packageManager", "name"])
        .filter(|s| !s.is_empty())
        .is_some();
    let enriched = super::detect_runtime::ensure_package_manager(orch, config).await;
    if !had_pm
        && get_str(&enriched, &["application", "packageManager", "name"])
            .filter(|s| !s.is_empty())
            .is_some()
        && !super::install::run(orch, &enriched).await
    {
        return;
    }
    let config = &enriched;
    let Some(pm) =
        get_str(config, &["application", "packageManager", "name"]).filter(|s| !s.is_empty())
    else {
        orch.transition_lifecycle(super::start_failed(
            "no package manager configured and none detected in the repository — update the VM config to enable a dev server",
        ));
        return;
    };
    let Some(run_prefix) = run_prefix_for(pm) else {
        orch.transition_lifecycle(super::start_failed(format!(
            "unknown package manager: {pm}"
        )));
        return;
    };

    let root = match pm_root(config, &orch.repo_dir).await {
        Ok(root) => root,
        Err(error) => {
            orch.transition_lifecycle(super::start_failed(error));
            return;
        }
    };
    let scripts = discover_and_mark_scripts(orch, &root, pm);
    let Some(starter) = WELL_KNOWN_STARTERS
        .iter()
        .find(|s| scripts.iter().any(|x| x == *s))
    else {
        orch.transition_lifecycle(super::start_failed(diagnose_no_start_command(
            pm, &root, &scripts,
        )));
        return;
    };

    let id = orch.tasks.next_id();
    orch.claim_dev_task(&id);
    orch.transition_lifecycle(json!({ "phase": "starting" }));

    // Reap any dev child a PREVIOUS spawn left behind — either an orphan
    // from a killed local-api process or the current live child when this is
    // a user-driven reboot. A numeric PGID is not identity: after every old
    // member exits, the kernel may reuse it for an unrelated group. Signals
    // are authorized only by an exact member birth identity persisted while
    // local-api owned the group. Legacy/unreadable observations fail closed.
    let sandbox_root = crate::sandbox::dev_port::sandbox_root_for(&orch.repo_dir);
    let previous = crate::sandbox::persist::read_dev_process(&sandbox_root);
    let previous_port = previous.as_ref().and_then(|record| record.port);
    if let Some(record) = previous {
        if let Err(error) = reap_persisted_dev_group(&record).await {
            tracing::warn!(
                pid = record.pid,
                pgid = record.pgid,
                %error,
                "refusing to signal an unverified persisted dev process group"
            );
            orch.transition_lifecycle(super::start_failed(format!(
                "cannot safely identify the previous dev server: {error}"
            )));
            orch.finish_dev_task(&id);
            return;
        }
        crate::sandbox::persist::clear_dev_process(&sandbox_root);
    }

    let command = format!("{run_prefix} {starter}");
    let mut env = std::collections::HashMap::new();
    env.insert("HOST".to_string(), "0.0.0.0".to_string());
    env.insert("HOSTNAME".to_string(), "0.0.0.0".to_string());
    // Every sandbox gets its OWN port, chosen here and imposed through `PORT`.
    //
    // This used to set `PORT` only when `application.port` was configured, and
    // otherwise let the dev server pick — which meant the port was whatever it
    // happened to land on, learned only by scraping a URL out of its stdout.
    // With several sandboxes of one repository running at once that is exactly
    // the worst case: they all default to the same port, collide, and drift
    // (3000, 3001, 3002…), so which sandbox owns which port depends on start
    // order. Deciding the port here makes the mapping ours instead of a race's,
    // and the reverse proxy knows the answer the instant the process starts
    // rather than whenever a matching line happens to be printed.
    let allocated_port = crate::sandbox::dev_port::resolve(
        &sandbox_root,
        previous_port.or(crate::sandbox::dev_port::configured_port(config)),
    );
    if let Some(port) = allocated_port {
        env.insert("PORT".to_string(), port.to_string());
    }

    let controller = ProcessController::new();
    let summary = TaskSummary {
        id: id.clone(),
        command: command.clone(),
        status: TaskStatus::Running,
        exit_code: None,
        started_at: now_ms(),
        finished_at: None,
        timed_out: false,
        truncated: false,
        log_name: Some((*starter).to_string()),
        intentional: None,
    };
    if !orch.register_task(TaskEntry::new(summary, Some(controller.kill_handle()))) {
        orch.finish_dev_task(&id);
        return;
    }
    if let Some(signal) = controller.requested() {
        orch.tasks
            .finalize(&id, TaskStatus::Killed, signal.exit_code(), false);
        emit_tasks_event(&orch.tasks, &orch.broadcaster);
        orch.finish_dev_task(&id);
        return;
    }

    let mut cmd = build_command(&command, &root, &env);
    cmd.kill_on_drop(true);
    let mut child =
        match ProcessGroupChild::spawn(&mut cmd, orch.tasks.child_lifetime_lock_path()).await {
            Ok(child) => child,
            Err(e) => {
                orch.tasks.finalize(&id, TaskStatus::Failed, -1, false);
                emit_tasks_event(&orch.tasks, &orch.broadcaster);
                if orch.finish_dev_task(&id) {
                    orch.transition_lifecycle(super::start_failed(format!("spawn error: {e}")));
                }
                return;
            }
        };
    let pid = child.id();
    let (Some(stdout_pipe), Some(stderr_pipe)) = (child.take_stdout(), child.take_stderr()) else {
        child.signal(crate::tasks::KillSignal::Kill).await;
        let _ = child.wait().await;
        orch.tasks.finalize(&id, TaskStatus::Failed, -1, false);
        emit_tasks_event(&orch.tasks, &orch.broadcaster);
        if orch.finish_dev_task(&id) {
            orch.transition_lifecycle(super::start_failed("spawn error: missing stdio pipe"));
        }
        return;
    };
    emit_tasks_event(&orch.tasks, &orch.broadcaster);
    let Some(pid) = pid else {
        child
            .kill_and_reap(STALE_KILL_GRACE, "dev process missing pid cleanup")
            .await;
        orch.tasks.finalize(&id, TaskStatus::Failed, -1, false);
        emit_tasks_event(&orch.tasks, &orch.broadcaster);
        if orch.finish_dev_task(&id) {
            orch.transition_lifecycle(super::start_failed(
                "cannot safely capture dev process identity: spawned process has no pid",
            ));
        }
        return;
    };
    let record_started_at = now_ms() as u64;
    let identities = match capture_process_group_identity(
        || observe_process_group(pid),
        IDENTITY_CAPTURE_ATTEMPTS,
        IDENTITY_CAPTURE_INTERVAL,
    )
    .await
    {
        Ok(identities) => identities,
        Err(error) => {
            tracing::error!(pid, %error, "could not capture initial dev process identity");
            child
                .kill_and_reap(STALE_KILL_GRACE, "unidentifiable dev process cleanup")
                .await;
            orch.tasks.finalize(&id, TaskStatus::Failed, -1, false);
            emit_tasks_event(&orch.tasks, &orch.broadcaster);
            if orch.finish_dev_task(&id) {
                orch.transition_lifecycle(super::start_failed(format!(
                    "cannot safely capture dev process identity: {error}"
                )));
            }
            return;
        }
    };
    crate::sandbox::persist::write_dev_process(
        &sandbox_root,
        &DevProcessRecord {
            pid,
            pgid: pid,
            command: command.clone(),
            started_at: record_started_at,
            port: allocated_port,
            identities,
        },
    );

    // Probe the port we IMPOSED, straight away. The reverse proxy learns the
    // dev server's address from the lifecycle, and this is what puts it there
    // — so a sandbox becomes previewable as soon as its server answers,
    // whether or not it ever prints a recognizable line.
    if let Some(port) = allocated_port {
        let attempts = BOOT_PROBE_ATTEMPTS;
        let confirm_orch = orch.clone();
        let confirm_task_id = id.clone();
        tokio::spawn(async move {
            confirm_running(confirm_orch, confirm_task_id, port, attempts).await;
        });
    }

    let watch_orch = orch.clone();
    let panic_orch = orch.clone();
    let panic_id = id.clone();
    let starter_owned = (*starter).to_string();
    tokio::spawn(async move {
        let watched = std::panic::AssertUnwindSafe(drain_and_watch(
            watch_orch,
            id,
            &mut child,
            stdout_pipe,
            stderr_pipe,
            Some(pid),
            starter_owned,
            controller,
            sandbox_root,
            Some(record_started_at),
            allocated_port,
        ))
        .catch_unwind()
        .await;
        if watched.is_err() {
            child
                .kill_and_reap(STALE_KILL_GRACE, "dev process-owner panic cleanup")
                .await;
            panic_orch
                .tasks
                .finalize(&panic_id, TaskStatus::Failed, -1, false);
            emit_tasks_event(&panic_orch.tasks, &panic_orch.broadcaster);
            if panic_orch.finish_dev_task(&panic_id) && !panic_orch.is_closed() {
                panic_orch.transition_lifecycle(super::start_failed("dev process owner panicked"));
            }
        }
    });
}

fn discover_and_mark_scripts(
    orch: &SetupOrchestrator,
    root: &Path,
    package_manager: &str,
) -> Vec<String> {
    let scripts = discover_scripts(root, Some(package_manager));
    orch.mark_discovered_scripts(scripts.clone());
    scripts
}

/// `pub(super)`: shared diagnostic text builder — byte-parity in spirit with
/// `orchestrator.ts::diagnoseNoStartCommand` (exact wording isn't pinned by
/// either e2e oracle, only `typeof lifecycle.state.error === "string"`).
fn diagnose_no_start_command(pm: &str, root: &Path, scripts: &[String]) -> String {
    if scripts.is_empty() {
        if !manifest_present(pm, root) {
            let manifest = if pm == "deno" {
                "deno.json or deno.jsonc"
            } else {
                "package.json"
            };
            return format!(
                "no package manifest ({manifest}) found at {} — update the VM config if a dev server should run",
                root.display()
            );
        }
        return format!(
            "no scripts defined in {}/package.json — update the VM config if a dev server should run",
            root.display()
        );
    }
    format!(
        "no 'dev' or 'start' script found (available: {}) — update the VM config to set the correct start script",
        scripts.join(", ")
    )
}

#[allow(clippy::too_many_arguments)]
async fn drain_and_watch(
    orch: Arc<SetupOrchestrator>,
    id: String,
    child: &mut ProcessGroupChild,
    mut stdout_pipe: tokio::process::ChildStdout,
    mut stderr_pipe: tokio::process::ChildStderr,
    pid: Option<u32>,
    starter: String,
    controller: ProcessController,
    sandbox_root: std::path::PathBuf,
    record_started_at: Option<u64>,
    allocated_port: Option<u16>,
) {
    let mut stdout_open = true;
    let mut stderr_open = true;
    let mut exited = false;
    let mut exit_status: Option<std::process::ExitStatus> = None;
    let mut sniffed = false;
    let mut observed_signal = None;

    let mut so_chunk = [0u8; 8192];
    let mut se_chunk = [0u8; 8192];
    let mut identity_refresh = tokio::time::interval(IDENTITY_REFRESH_INTERVAL);
    identity_refresh.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    // `interval`'s first tick is immediate. The initial identity was already
    // captured synchronously after spawn, so consume it before the select.
    identity_refresh.tick().await;

    loop {
        if exited && !stdout_open && !stderr_open {
            break;
        }
        tokio::select! {
            res = stdout_pipe.read(&mut so_chunk), if stdout_open => {
                match res {
                    Ok(0) | Err(_) => stdout_open = false,
                    Ok(n) => {
                        let text = String::from_utf8_lossy(&so_chunk[..n]).into_owned();
                        // Both this task's own file AND the stable
                        // `"app/<starter>"` transcript (`routes/events.rs`
                        // replays the latter), then a live `log` SSE frame so
                        // the dev server's stdout renders in the preview
                        // terminal's `dev`/`start` tab. RAW text — the
                        // frontend normalizes `\r\n`.
                        orch.tasks
                            .append_log(&id, &starter, OutputStream::Stdout, &text, &orch.broadcaster)
                            .await;
                        // The announcement is the one moment a listener is
                        // KNOWN to exist, so it always confirms — even when it
                        // names the port we imposed, which is the normal case.
                        // (Skipping the matching case left a server that took
                        // longer to build than the eager probe's budget stuck
                        // on "starting" forever, with nothing left to retry.)
                        // A port that CONTRADICTS ours means the dev server
                        // ignored `PORT` or drifted; then it, not our
                        // allocation, is the truth.
                        if !sniffed {
                            if let Some(port) = sniff_port(&text) {
                                sniffed = true;
                                if Some(port) != allocated_port {
                                    tracing::warn!(
                                        announced = port,
                                        allocated = ?allocated_port,
                                        "dev server did not bind the port it was given"
                                    );
                                }
                                let probe_orch = orch.clone();
                                let probe_task_id = id.clone();
                                tokio::spawn(async move {
                                    confirm_running(probe_orch, probe_task_id, port, PROBE_ATTEMPTS)
                                        .await;
                                });
                            }
                        }
                    }
                }
            }
            res = stderr_pipe.read(&mut se_chunk), if stderr_open => {
                match res {
                    Ok(0) | Err(_) => stderr_open = false,
                    Ok(n) => {
                        let text = String::from_utf8_lossy(&se_chunk[..n]).into_owned();
                        orch.tasks
                            .append_log(&id, &starter, OutputStream::Stderr, &text, &orch.broadcaster)
                            .await;
                    }
                }
            }
            // Keep the leader unreaped while descendants hold inherited
            // output pipes. That pins the PGID, so shutdown signals cannot
            // ever target a recycled group and double-forked dev children
            // remain controllable until their streams close.
            status = child.wait(), if !exited && !stdout_open && !stderr_open => {
                exited = true;
                exit_status = status.ok();
            }
            sig = controller.wait_for_change(observed_signal), if !exited => {
                observed_signal = Some(sig);
                child.signal(sig).await;
            }
            _ = identity_refresh.tick() => {
                if let (Some(pid), Some(started_at)) = (pid, record_started_at) {
                    refresh_persisted_group_identities(
                        &sandbox_root,
                        pid,
                        started_at,
                    ).await;
                }
            }
        }
    }

    let raw_exit = exit_status.map(exit_status_to_code).unwrap_or(-1);
    let status = classify_status(false, raw_exit);
    let intentional = orch
        .tasks
        .get(&id)
        .and_then(|s| s.intentional)
        .unwrap_or(false);
    let was_current = orch.finish_dev_task(&id);
    orch.tasks.finalize(&id, status, raw_exit, false);
    emit_tasks_event(&orch.tasks, &orch.broadcaster);

    // Byte-parity with `SetupOrchestrator`'s `taskManager.onTaskExit` hook:
    // an unexpected (non-intentional, non-zero) exit of the dev script
    // surfaces a terminal `start-failed` so the UI shows a retry affordance
    // instead of sitting on the boot animation forever.
    if was_current && !orch.is_closed() && !intentional && raw_exit != 0 {
        orch.transition_lifecycle(super::start_failed(format!(
            "{starter} script exited with code {raw_exit}"
        )));
    }
}

fn sniff_port(text: &str) -> Option<u16> {
    let caps = port_pattern().captures(text)?;
    caps.get(1)?.as_str().parse::<u16>().ok()
}

/// One-shot confirm: HEAD/GET the sniffed port until it answers (or attempts
/// run out), then transition `lifecycle` to `running` and emit `reload:{}`
/// if the pipeline wasn't already there — byte-parity in spirit with
/// `probe.ts`'s booting -> online transition + `entry.ts`'s
/// `if (wasDown) broadcaster.emit("reload", {})`.
async fn confirm_running(orch: Arc<SetupOrchestrator>, task_id: String, port: u16, attempts: u32) {
    if orch.is_closed() || !orch.is_current_dev_task(&task_id) {
        return;
    }
    let Ok(client) = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
    else {
        return;
    };
    for _ in 0..attempts {
        if orch.is_closed() || !orch.is_current_dev_task(&task_id) {
            return;
        }
        match client.get(format!("http://127.0.0.1:{port}/")).send().await {
            Ok(res) => {
                if orch.is_closed() || !orch.is_current_dev_task(&task_id) {
                    return;
                }
                let html_support = res
                    .headers()
                    .get(reqwest::header::CONTENT_TYPE)
                    .and_then(|v| v.to_str().ok())
                    .map(|s| s.to_ascii_lowercase().contains("text/html"))
                    .unwrap_or(false);
                let was_down = orch.lifecycle_snapshot()["phase"].as_str() != Some("running");
                if !orch.transition_dev_lifecycle(
                    &task_id,
                    json!({
                        "phase": "running",
                        "port": port,
                        "htmlSupport": html_support,
                    }),
                ) {
                    return;
                }
                if was_down && orch.is_current_dev_task(&task_id) {
                    orch.broadcaster.emit("reload", json!({}));
                }
                return;
            }
            Err(_) => {
                if orch.is_closed() || !orch.is_current_dev_task(&task_id) {
                    return;
                }
                tokio::time::sleep(PROBE_INTERVAL).await;
            }
        }
    }
}

async fn reap_persisted_dev_group(record: &DevProcessRecord) -> Result<(), String> {
    let current = observe_process_group(record.pgid).await?;
    let authorized = match match_group_identity(&record.identities, current) {
        GroupIdentityMatch::Gone => return Ok(()),
        GroupIdentityMatch::Verified(current) => current,
        GroupIdentityMatch::Unverifiable => {
            return Err("persisted process identities do not match the current group".to_string())
        }
    };

    tracing::info!(
        pid = record.pid,
        pgid = record.pgid,
        "stopping previous dev server before start"
    );
    kill_group(record.pgid, KillSignal::Term).await;
    tokio::time::sleep(STALE_TERM_GRACE).await;

    let after_term = observe_process_group(record.pgid).await?;
    match match_group_identity(&authorized, after_term) {
        GroupIdentityMatch::Gone => Ok(()),
        GroupIdentityMatch::Unverifiable => {
            Err("process group identity changed after TERM; refusing KILL".to_string())
        }
        GroupIdentityMatch::Verified(survivors) => {
            kill_group(record.pgid, KillSignal::Kill).await;
            let deadline = tokio::time::Instant::now() + STALE_KILL_GRACE;
            loop {
                tokio::time::sleep(Duration::from_millis(50)).await;
                let after_kill = observe_process_group(record.pgid).await?;
                match match_group_identity(&survivors, after_kill) {
                    GroupIdentityMatch::Gone => return Ok(()),
                    GroupIdentityMatch::Unverifiable => {
                        return Err(
                            "process group identity changed after KILL; refusing another signal"
                                .to_string(),
                        )
                    }
                    GroupIdentityMatch::Verified(_) => {
                        if tokio::time::Instant::now() >= deadline {
                            return Err(
                                "verified previous dev process group survived KILL".to_string()
                            );
                        }
                    }
                }
            }
        }
    }
}

async fn capture_process_group_identity<F, Fut>(
    mut observe: F,
    attempts: u32,
    interval: Duration,
) -> Result<Vec<DevProcessIdentity>, String>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<Vec<DevProcessIdentity>, String>>,
{
    let attempts = attempts.max(1);
    let mut last_error = "process group has no observable members".to_string();
    for attempt in 0..attempts {
        match observe().await {
            Ok(identities) if !identities.is_empty() => return Ok(identities),
            Ok(_) => {
                last_error = "process group has no observable members".to_string();
            }
            Err(error) => last_error = error,
        }
        if attempt + 1 < attempts {
            tokio::time::sleep(interval).await;
        }
    }
    Err(format!(
        "{last_error} after {attempts} observation attempt(s)"
    ))
}

async fn refresh_persisted_group_identities(sandbox_root: &Path, pid: u32, started_at: u64) {
    let identities = match observe_process_group(pid).await {
        Ok(identities) if !identities.is_empty() => identities,
        Ok(_) => return,
        Err(error) => {
            tracing::debug!(pid, %error, "could not refresh dev process identities");
            return;
        }
    };

    // Re-read AFTER the asynchronous observation. A user-driven restart may
    // have replaced the record while `ps` was running; an old watcher must
    // never overwrite the new process's identity metadata.
    let Some(mut record) = crate::sandbox::persist::read_dev_process(sandbox_root) else {
        return;
    };
    if record.pid != pid || record.pgid != pid || record.started_at != started_at {
        return;
    }
    record.identities = identities;
    crate::sandbox::persist::write_dev_process(sandbox_root, &record);
}

#[cfg(unix)]
async fn observe_process_group(pgid: u32) -> Result<Vec<DevProcessIdentity>, String> {
    let group = tokio::process::Command::new("pgrep")
        .args(["-g", &pgid.to_string()])
        .output()
        .await
        .map_err(|error| format!("cannot enumerate process group {pgid}: {error}"))?;
    if !group.status.success() {
        if group.status.code() == Some(1) {
            return Ok(Vec::new());
        }
        return Err(format!(
            "cannot enumerate process group {pgid}: pgrep exited {:?}",
            group.status.code()
        ));
    }

    let pids = String::from_utf8(group.stdout)
        .map_err(|error| format!("pgrep returned non-UTF-8 output: {error}"))?;
    let mut identities = Vec::new();
    for raw_pid in pids.lines().filter(|line| !line.trim().is_empty()) {
        let pid = raw_pid
            .trim()
            .parse::<u32>()
            .map_err(|error| format!("pgrep returned invalid pid {raw_pid:?}: {error}"))?;
        if let Some(identity) = observe_process_identity(pid, pgid).await? {
            identities.push(identity);
        }
    }
    identities.sort_by_key(|identity| identity.pid);
    Ok(identities)
}

#[cfg(unix)]
async fn observe_process_identity(
    pid: u32,
    expected_pgid: u32,
) -> Result<Option<DevProcessIdentity>, String> {
    let process = tokio::process::Command::new("ps")
        .args([
            "-ww",
            "-p",
            &pid.to_string(),
            "-o",
            "pid=",
            "-o",
            "pgid=",
            "-o",
            "state=",
            "-o",
            "lstart=",
            "-o",
            "comm=",
        ])
        .output()
        .await
        .map_err(|error| format!("cannot inspect process {pid}: {error}"))?;
    if !process.status.success() {
        if process.status.code() == Some(1) {
            return Ok(None);
        }
        return Err(format!(
            "cannot inspect process {pid}: ps exited {:?}",
            process.status.code()
        ));
    }
    let output = String::from_utf8(process.stdout)
        .map_err(|error| format!("ps returned non-UTF-8 output for {pid}: {error}"))?;
    let fields: Vec<&str> = output.split_whitespace().collect();
    if fields.len() < 9 {
        return Err(format!("cannot parse process identity for {pid}"));
    }
    let observed_pid = fields[0]
        .parse::<u32>()
        .map_err(|error| format!("cannot parse observed pid for {pid}: {error}"))?;
    let observed_pgid = fields[1]
        .parse::<u32>()
        .map_err(|error| format!("cannot parse observed pgid for {pid}: {error}"))?;
    if observed_pid != pid || observed_pgid != expected_pgid {
        return Err(format!(
            "process {pid} no longer belongs to group {expected_pgid}"
        ));
    }
    if fields[2].starts_with('Z') {
        return Ok(None);
    }

    Ok(Some(DevProcessIdentity {
        pid,
        birth: fields[3..8].join(" "),
        executable: resolve_executable(pid, fields[8..].join(" ")),
    }))
}

/// The executable identity to persist for `pid`. `ps_name` is the `ps comm`
/// value: argv stays excluded on every platform so a child's secrets are
/// never copied into the sidecar (`sandbox::persist::DevProcessIdentity`).
///
/// Linux upgrades that to the full `/proc/<pid>/exe` path, which is also
/// argv-free but survives comm's 15-byte truncation. The kernel appends
/// " (deleted)" when the binary was replaced or unlinked since exec; that is
/// not a stable identity to compare a later boot against, so it falls back to
/// the `ps` value. A record that still fails to match yields
/// `GroupIdentityMatch::Unverifiable`, which withholds the signal — an
/// unrecognized process is never killed.
#[cfg(unix)]
#[cfg_attr(not(target_os = "linux"), allow(unused_variables))]
fn resolve_executable(pid: u32, ps_name: String) -> String {
    #[cfg(target_os = "linux")]
    {
        if let Ok(target) = std::fs::read_link(format!("/proc/{pid}/exe")) {
            if let Some(path) = target
                .to_str()
                .filter(|path| !path.is_empty() && !path.ends_with(" (deleted)"))
            {
                return path.to_string();
            }
        }
    }
    ps_name
}

#[cfg(not(unix))]
async fn observe_process_group(_pgid: u32) -> Result<Vec<DevProcessIdentity>, String> {
    Err("durable process-group identity is unavailable on this platform".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn identity(pid: u32, birth: &str, executable: &str) -> DevProcessIdentity {
        DevProcessIdentity {
            pid,
            birth: birth.to_string(),
            executable: executable.to_string(),
        }
    }

    #[test]
    fn sniff_port_matches_local_announcement() {
        let text = "Local:   http://localhost:5174/\n";
        assert_eq!(sniff_port(text), Some(5174));
    }

    #[test]
    fn sniff_port_matches_listening_on_announcement() {
        let text = "Listening on http://0.0.0.0:3000\n";
        assert_eq!(sniff_port(text), Some(3000));
    }

    #[test]
    fn sniff_port_ignores_unrelated_urls() {
        let text = "fetched https://example.com:9999/ ok\n";
        assert_eq!(sniff_port(text), None);
    }

    #[test]
    fn diagnose_reports_missing_manifest() {
        let dir = tempfile::tempdir().unwrap();
        let msg = diagnose_no_start_command("npm", dir.path(), &[]);
        assert!(msg.contains("package.json"));
    }

    #[test]
    fn diagnose_reports_missing_starter_script() {
        let msg = diagnose_no_start_command(
            "npm",
            Path::new("/tmp"),
            &["build".to_string(), "test".to_string()],
        );
        assert!(msg.contains("build"));
        assert!(msg.contains("test"));
    }

    #[tokio::test]
    async fn start_only_resume_detects_installs_then_diagnoses_the_missing_starter() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        // Detectable (package-lock -> npm) but with NO dev/start script: the
        // Start-only path must detect, run the Install it skipped, and then
        // fail with the missing-STARTER diagnostic — never the
        // missing-package-manager one this change retires for detectable
        // repos. No dev server spawns, so the test stays deterministic.
        std::fs::write(repo.join("package.json"), r#"{"name":"x"}"#).unwrap();
        std::fs::write(repo.join("package-lock.json"), "{}").unwrap();
        let logs = Arc::new(crate::log_store::LogStore::new(dir.path().join("logs")));
        let orch = SetupOrchestrator::new(
            repo.clone(),
            repo.clone(),
            Arc::new(crate::config::ConfigStore::new()),
            Arc::new(crate::tasks::TaskRegistry::new(logs)),
            Arc::new(crate::events::Broadcaster::new()),
        );
        orch.config
            .patch(serde_json::json!({
                "git": { "repository": { "cloneUrl": "https://example.com/r.git" } }
            }))
            .unwrap();
        let config = orch.current_config().unwrap();

        run(&orch, &config).await;

        let lifecycle = orch.lifecycle_snapshot();
        assert_eq!(lifecycle["phase"], "start-failed", "{lifecycle:?}");
        let error = lifecycle["error"].as_str().unwrap();
        assert!(
            !error.contains("no package manager configured"),
            "a detectable repo must get past the package-manager gate: {error:?}"
        );
        assert_eq!(
            get_str(
                &orch.current_config().unwrap(),
                &["application", "packageManager", "name"]
            ),
            Some("npm"),
            "detection ran on the Start-only path"
        );
    }

    #[test]
    fn start_only_discovery_restores_the_scripts_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        std::fs::write(
            repo.join("package.json"),
            r#"{"scripts":{"dev":"next dev","test":"bun test"}}"#,
        )
        .unwrap();
        let logs = Arc::new(crate::log_store::LogStore::new(dir.path().join("logs")));
        let broadcaster = Arc::new(crate::events::Broadcaster::new());
        let mut events = broadcaster.subscribe();
        let orch = SetupOrchestrator::new(
            repo.clone(),
            repo.clone(),
            Arc::new(crate::config::ConfigStore::new()),
            Arc::new(crate::tasks::TaskRegistry::new(logs)),
            broadcaster,
        );

        let scripts = discover_and_mark_scripts(&orch, &repo, "bun");

        assert_eq!(scripts, vec!["dev", "test"]);
        assert_eq!(orch.discovered_scripts(), Some(scripts.clone()));
        let event = events.try_recv().unwrap();
        assert_eq!(event.name, "scripts");
        assert_eq!(event.data, json!({ "scripts": scripts }));
    }

    #[test]
    fn recycled_pid_and_pgid_do_not_authorize_a_signal() {
        let recorded = vec![identity(42, "Wed Jul 22 11:00:00 2026", "next-server")];
        let reused = vec![identity(42, "Wed Jul 22 12:00:00 2026", "next-server")];
        assert_eq!(
            match_group_identity(&recorded, reused),
            GroupIdentityMatch::Unverifiable
        );
    }

    #[test]
    fn legacy_or_unverifiable_metadata_does_not_authorize_a_signal() {
        let current = vec![identity(42, "Wed Jul 22 11:00:00 2026", "next-server")];
        assert_eq!(
            match_group_identity(&[], current),
            GroupIdentityMatch::Unverifiable
        );
    }

    #[test]
    fn recorded_surviving_child_keeps_orphan_cleanup_authorized() {
        let child = identity(43, "Wed Jul 22 11:00:01 2026", "next-server");
        let recorded = vec![
            identity(42, "Wed Jul 22 11:00:00 2026", "sh -c bun run dev"),
            child.clone(),
        ];
        assert_eq!(
            match_group_identity(&recorded, vec![child.clone()]),
            GroupIdentityMatch::Verified(vec![child])
        );
    }

    #[cfg(unix)]
    #[test]
    fn unresolvable_executable_falls_back_to_the_ps_name() {
        // No live process can hold the maximum pid, so the Linux
        // /proc/<pid>/exe lookup is guaranteed to miss on every platform.
        assert_eq!(
            resolve_executable(u32::MAX, "next-server".to_string()),
            "next-server"
        );
    }

    #[test]
    fn empty_observation_means_the_recorded_group_is_gone() {
        let recorded = vec![identity(42, "Wed Jul 22 11:00:00 2026", "next-server")];
        assert_eq!(
            match_group_identity(&recorded, Vec::new()),
            GroupIdentityMatch::Gone
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn observes_a_real_spawned_process_group_identity() {
        let dir = tempfile::tempdir().unwrap();
        let mut command = build_command("sleep 30", dir.path(), &std::collections::HashMap::new());
        // Production uses `ProcessGroupChild::spawn`, which supplies an
        // independent anchored PGID. This test intentionally exercises the
        // persisted-orphan observer without that owner, so create a dedicated
        // group explicitly before dropping to the raw child handle.
        command.process_group(0);
        let mut child = command.spawn().unwrap();
        let pid = child.id().unwrap();
        let observed = capture_process_group_identity(
            || observe_process_group(pid),
            IDENTITY_CAPTURE_ATTEMPTS,
            IDENTITY_CAPTURE_INTERVAL,
        )
        .await;
        kill_group(pid, KillSignal::Kill).await;
        let _ = child.wait().await;

        let identities = observed.unwrap();
        assert!(identities.iter().any(|identity| identity.pid == pid));
        assert!(identities.iter().all(|identity| !identity.birth.is_empty()));
        assert!(identities
            .iter()
            .all(|identity| !identity.executable.is_empty()));
        // Linux resolves /proc/<pid>/exe, so every live member reports an
        // absolute path rather than the truncated `ps comm` name.
        #[cfg(target_os = "linux")]
        assert!(identities
            .iter()
            .all(|identity| identity.executable.starts_with('/')));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn reaps_a_verified_orphan_after_its_group_leader_exits() {
        let dir = tempfile::tempdir().unwrap();
        let mut command = build_command(
            "sleep 30 </dev/null >/dev/null 2>&1 &",
            dir.path(),
            &std::collections::HashMap::new(),
        );
        command.process_group(0);
        let mut leader = command.spawn().unwrap();
        let pgid = leader.id().unwrap();
        let _ = leader.wait().await;

        let identities = observe_process_group(pgid).await.unwrap();
        assert!(
            !identities.is_empty(),
            "the background child must survive its group leader"
        );
        let record = DevProcessRecord {
            pid: pgid,
            pgid,
            command: "sleep 30 &".to_string(),
            started_at: 1,
            port: None,
            identities,
        };
        let reaped = reap_persisted_dev_group(&record).await;
        if reaped.is_err() {
            // Exact group created by this test; cleanup must not leak it even
            // if the assertion below reports an observation regression.
            kill_group(pgid, KillSignal::Kill).await;
        }

        reaped.unwrap();
        assert!(observe_process_group(pgid).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn closed_orchestrator_rejects_late_probe_transition() {
        let dir = tempfile::tempdir().unwrap();
        let logs = Arc::new(crate::log_store::LogStore::new(dir.path().join("logs")));
        let orch = SetupOrchestrator::new(
            dir.path().join("repo"),
            dir.path().join("repo"),
            Arc::new(crate::config::ConfigStore::new()),
            Arc::new(crate::tasks::TaskRegistry::new(logs)),
            Arc::new(crate::events::Broadcaster::new()),
        );
        orch.claim_dev_task("dev-task");
        orch.close();

        confirm_running(orch.clone(), "dev-task".to_string(), 1, PROBE_ATTEMPTS).await;

        assert_eq!(orch.lifecycle_snapshot(), json!({ "phase": "idle" }));
    }

    #[tokio::test]
    async fn replaced_dev_task_rejects_late_probe_transition() {
        let dir = tempfile::tempdir().unwrap();
        let logs = Arc::new(crate::log_store::LogStore::new(dir.path().join("logs")));
        let orch = SetupOrchestrator::new(
            dir.path().join("repo"),
            dir.path().join("repo"),
            Arc::new(crate::config::ConfigStore::new()),
            Arc::new(crate::tasks::TaskRegistry::new(logs)),
            Arc::new(crate::events::Broadcaster::new()),
        );
        orch.claim_dev_task("old-dev-task");
        orch.transition_lifecycle(json!({ "phase": "starting" }));
        orch.claim_dev_task("replacement-dev-task");

        confirm_running(orch.clone(), "old-dev-task".to_string(), 1, PROBE_ATTEMPTS).await;

        assert_eq!(
            orch.lifecycle_snapshot(),
            json!({ "phase": "starting" }),
            "a probe owned by the replaced spawn must not publish running"
        );
        assert!(
            !orch.finish_dev_task("old-dev-task"),
            "the replaced watcher must not clear its replacement's token"
        );
        assert!(orch.is_current_dev_task("replacement-dev-task"));
    }

    #[tokio::test]
    async fn process_identity_capture_retries_empty_observations() {
        let attempts = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let observed_attempts = attempts.clone();
        let captured = capture_process_group_identity(
            move || {
                let attempt = observed_attempts.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                async move {
                    if attempt < 2 {
                        Ok(Vec::new())
                    } else {
                        Ok(vec![identity(42, "Wed Jul 22 11:00:00 2026", "dev")])
                    }
                }
            },
            3,
            Duration::ZERO,
        )
        .await
        .unwrap();

        assert_eq!(attempts.load(std::sync::atomic::Ordering::SeqCst), 3);
        assert_eq!(captured.len(), 1);
    }

    #[tokio::test]
    async fn process_identity_capture_fails_after_bounded_empty_observations() {
        let attempts = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let observed_attempts = attempts.clone();
        let error = capture_process_group_identity(
            move || {
                observed_attempts.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                async { Ok(Vec::new()) }
            },
            3,
            Duration::ZERO,
        )
        .await
        .unwrap_err();

        assert_eq!(attempts.load(std::sync::atomic::Ordering::SeqCst), 3);
        assert!(error.contains("after 3 observation attempt(s)"));
    }
}
