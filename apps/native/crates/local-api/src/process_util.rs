//! Shared process-lifecycle helpers for every family that spawns a child
//! through [`ProcessGroupChild`] and registers it in a [`TaskRegistry`]
//! (`routes/bash.rs`, `routes/scripts.rs`, the `setup` pipeline, and the
//! internal Git/grep owners).
//!
//! Why this module exists: these helpers define wire- and registry-visible
//! contracts — the `128 + signal` exit-code convention, the
//! exit-code→[`TaskStatus`] classification, the `"tasks"` SSE payload shape,
//! and the TERM→KILL escalation window. They were once duplicated per family
//! (each `routes/*` file owns its route, per the native module-ownership
//! contract) with an explicit note to hoist them into a shared `process`
//! helper module once a third family needed the same shape; the setup
//! pipeline became that third family. One copy here means a change to any of
//! these contracts is a single, reviewable edit instead of a silent drift
//! between families that must stay byte-identical on the wire.

use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::AsyncReadExt;
use tokio::process::{ChildStderr, ChildStdout};

use crate::events::Broadcaster;
use crate::process_group::ProcessGroupChild;
use crate::tasks::{
    KillHandle, KillSignal, OutputStream, ProcessController, TaskRegistry, TaskStatus,
};

/// Byte-parity with `killWithEscalation`'s 3s TERM->KILL escalation window
/// in `process/task-manager.ts`.
const ESCALATE_AFTER: Duration = Duration::from_secs(3);

/// Shell convention (`128 + signal` for a signal death, otherwise the plain
/// exit code) — byte-parity with the
/// `signal ? 128 + SIGNAL_NUMBERS[signal] : (code ?? 1)` mapping in
/// `task-manager.ts`'s `child.on("close", ...)`.
#[cfg(unix)]
pub(crate) fn exit_status_to_code(status: std::process::ExitStatus) -> i32 {
    use std::os::unix::process::ExitStatusExt;
    match status.signal() {
        Some(sig) => 128 + sig,
        None => status.code().unwrap_or(1),
    }
}

#[cfg(not(unix))]
pub(crate) fn exit_status_to_code(status: std::process::ExitStatus) -> i32 {
    status.code().unwrap_or(1)
}

/// Exit-code→[`TaskStatus`] classification — byte-parity with
/// `TaskManager`'s finalize logic. Tracks process *lifecycle*, not success:
/// a clean nonzero exit is still `Exited`; only the `-1` spawn-failure
/// sentinel or a `>128` signal-death code map away from it.
pub(crate) fn classify_status(timed_out: bool, exit_code: i32) -> TaskStatus {
    if timed_out {
        TaskStatus::Timeout
    } else if exit_code == 0 {
        TaskStatus::Exited
    } else if exit_code == -1 {
        TaskStatus::Failed
    } else if exit_code > 128 {
        TaskStatus::Killed
    } else {
        TaskStatus::Exited
    }
}

/// `{"active": [{id, command, logName?}]}` — byte-parity with
/// `getActiveTasks()` in `entry.ts`, broadcast under the `"tasks"` name on
/// every registration and every exit. Every family emits through this one
/// copy so `GET /_sandbox/tasks` stream consumers see one payload shape no
/// matter which family spawned the task. Callers pass the RESOLVED sandbox's
/// registry + broadcaster so a per-handle task list fans out on the RIGHT
/// stream.
pub(crate) fn emit_tasks_event(tasks: &TaskRegistry, broadcaster: &Broadcaster) {
    let active: Vec<Value> = tasks
        .list(Some(&[TaskStatus::Running]))
        .into_iter()
        .map(|t| {
            let mut obj = json!({"id": t.id, "command": t.command});
            if let Some(name) = t.log_name {
                obj["logName"] = json!(name);
            }
            obj
        })
        .collect();
    broadcaster.emit("tasks", json!({"active": active}));
}

/// Signals the whole process group `pid` leads via an external
/// `kill -SIG -<pgid>` (`taskkill /T` off-Unix) — this crate has no
/// `libc`/`nix` dependency, so no raw `kill(2)` syscall. Reaches the group's
/// descendants too, matching `task-manager.ts`'s `process.kill(-pgid,
/// signal)`. For anchored groups prefer [`ProcessGroupChild::signal`], which
/// spares the anchor; this raw variant backs the setup family's
/// persisted-orphan reaping, where no live owner exists.
#[cfg(all(test, unix))]
pub(crate) async fn kill_group(pid: u32, signal: KillSignal) {
    let _ = tokio::process::Command::new("kill")
        .arg(signal.flag())
        .arg(format!("-{pid}"))
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .status()
        .await;
}

#[cfg(all(test, not(unix)))]
pub(crate) async fn kill_group(pid: u32, _signal: KillSignal) {
    let _ = tokio::process::Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .status()
        .await;
}

/// Synchronous cancellation bridge for an HTTP request whose child lives in
/// a detached, registry-visible owner. Axum may drop a handler future when
/// the client disconnects; dropping this guard requests the configured
/// signal through the task's [`KillHandle`] instead of either leaking the
/// child or tying process ownership to the socket future. The detached owner
/// remains responsible for escalation, the complete process-group reap, and
/// the terminal registry transition.
pub(crate) struct CancelOnDrop {
    kill: Option<KillHandle>,
    signal: KillSignal,
}

impl CancelOnDrop {
    pub(crate) fn new(kill: KillHandle, signal: KillSignal) -> Self {
        Self {
            kill: Some(kill),
            signal,
        }
    }

    pub(crate) fn disarm(&mut self) {
        self.kill = None;
    }
}

impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        if let Some(kill) = self.kill.take() {
            let _ = kill(self.signal);
        }
    }
}

/// Where each drained chunk goes. Families differ ONLY here: bash decodes
/// UTF-8 across chunk boundaries into registry output (+ an await-mode RAM
/// copy); scripts/setup append per-chunk lossy text to the task's log files
/// and `log` SSE frames. The drain/kill/escalation loop itself is one copy —
/// [`drive_group_to_exit`].
#[async_trait::async_trait]
pub(crate) trait OutputSink: Send {
    async fn write(&mut self, stream: OutputStream, bytes: &[u8]);
}

/// What the drain loop proved: the leader's exit status (`None` when it was
/// never observed, the `-1` sentinel case) and whether the configured
/// timeout fired. Callers map this through [`exit_status_to_code`] /
/// [`classify_status`] and finalize their own registry entry.
pub(crate) struct DriveOutcome {
    pub(crate) exit_status: Option<std::process::ExitStatus>,
    pub(crate) timed_out: bool,
}

/// The one drain/kill/escalation loop: drains stdout/stderr into `sink`,
/// honors an optional timeout (KILL on expiry) and durable
/// [`ProcessController`] signals (escalating TERM to KILL after
/// [`ESCALATE_AFTER`], byte-parity with `killWithEscalation`), and keeps the
/// group leader unreaped until every inherited output writer has closed —
/// its unreaped PID pins the process-group identity, so timeout/controller
/// signals can never target a recycled PGID.
pub(crate) async fn drive_group_to_exit<S: OutputSink>(
    child: &mut ProcessGroupChild,
    mut stdout_pipe: ChildStdout,
    mut stderr_pipe: ChildStderr,
    timeout: Option<Duration>,
    controller: &ProcessController,
    sink: &mut S,
) -> DriveOutcome {
    // No timeout configured: use a far-future deadline instead of
    // `Option<Pin<Box<dyn Future>>>` bookkeeping. Guarded out of the
    // `select!` below via `timer_active` so it's never actually polled in
    // that case. 100 years comfortably avoids `Instant` overflow while
    // being "never" for any real call.
    let sleep_duration = timeout.unwrap_or(Duration::from_secs(60 * 60 * 24 * 365 * 100));
    let sleep = tokio::time::sleep(sleep_duration);
    tokio::pin!(sleep);
    let escalation = tokio::time::sleep(ESCALATE_AFTER);
    tokio::pin!(escalation);

    let mut stdout_open = true;
    let mut stderr_open = true;
    let mut exited = false;
    let mut exit_status: Option<std::process::ExitStatus> = None;
    let mut timed_out = false;
    let mut timer_active = timeout.is_some();
    let mut observed_signal = None;
    let mut escalation_active = false;

    let mut so_chunk = [0u8; 8192];
    let mut se_chunk = [0u8; 8192];

    loop {
        if exited && !stdout_open && !stderr_open {
            break;
        }
        tokio::select! {
            res = stdout_pipe.read(&mut so_chunk), if stdout_open => {
                match res {
                    Ok(0) | Err(_) => stdout_open = false,
                    Ok(n) => sink.write(OutputStream::Stdout, &so_chunk[..n]).await,
                }
            }
            res = stderr_pipe.read(&mut se_chunk), if stderr_open => {
                match res {
                    Ok(0) | Err(_) => stderr_open = false,
                    Ok(n) => sink.write(OutputStream::Stderr, &se_chunk[..n]).await,
                }
            }
            // Do not reap the group leader while descendants may still own an
            // inherited pipe. Keeping the leader unreaped pins its PID/PGID,
            // so every timeout/controller signal remains ownership-safe.
            status = child.wait(), if !exited && !stdout_open && !stderr_open => {
                exited = true;
                timer_active = false;
                escalation_active = false;
                exit_status = status.ok();
            }
            _ = &mut sleep, if timer_active && !exited => {
                timer_active = false;
                escalation_active = false;
                timed_out = true;
                child.signal(KillSignal::Kill).await;
            }
            sig = controller.wait_for_change(observed_signal), if !exited => {
                observed_signal = Some(sig);
                if child.signal(sig).await {
                    if matches!(sig, KillSignal::Term) {
                        escalation.as_mut().reset(tokio::time::Instant::now() + ESCALATE_AFTER);
                        escalation_active = true;
                    } else {
                        escalation_active = false;
                    }
                }
            }
            _ = &mut escalation, if escalation_active && !exited => {
                escalation_active = false;
                child.signal(KillSignal::Kill).await;
            }
        }
    }

    DriveOutcome {
        exit_status,
        timed_out,
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::*;
    use crate::tasks::{now_ms, TaskEntry, TaskSummary};

    #[test]
    fn classify_status_matches_task_manager_finalize() {
        assert_eq!(classify_status(true, 0), TaskStatus::Timeout);
        assert_eq!(classify_status(false, 0), TaskStatus::Exited);
        assert_eq!(classify_status(false, -1), TaskStatus::Failed);
        assert_eq!(classify_status(false, 137), TaskStatus::Killed);
        assert_eq!(classify_status(false, 1), TaskStatus::Exited);
    }

    #[cfg(unix)]
    #[test]
    fn exit_status_to_code_follows_the_128_plus_signal_shell_convention() {
        use std::os::unix::process::ExitStatusExt;
        use std::process::ExitStatus;
        // Raw wait statuses: low byte = signal, next byte = exit code.
        assert_eq!(exit_status_to_code(ExitStatus::from_raw(0)), 0);
        assert_eq!(exit_status_to_code(ExitStatus::from_raw(3 << 8)), 3);
        assert_eq!(exit_status_to_code(ExitStatus::from_raw(9)), 137); // SIGKILL
        assert_eq!(exit_status_to_code(ExitStatus::from_raw(15)), 143); // SIGTERM
    }

    fn summary(id: &str, command: &str, status: TaskStatus, log_name: Option<&str>) -> TaskSummary {
        TaskSummary {
            id: id.to_string(),
            command: command.to_string(),
            status,
            exit_code: None,
            started_at: now_ms(),
            finished_at: None,
            timed_out: false,
            truncated: false,
            log_name: log_name.map(str::to_string),
            intentional: None,
        }
    }

    /// Pins the `"tasks"` SSE payload shape every family now emits through
    /// the one shared copy: running tasks only, `logName` present only when
    /// the task has one.
    #[test]
    fn tasks_event_payload_shape_is_pinned() {
        let dir = tempfile::tempdir().unwrap();
        let logs = Arc::new(crate::log_store::LogStore::new(dir.path().join("logs")));
        let tasks = TaskRegistry::new(logs);
        let broadcaster = Broadcaster::new();
        let mut rx = broadcaster.subscribe();

        tasks.insert(TaskEntry::new(
            summary("task1", "npm run dev", TaskStatus::Running, Some("dev")),
            None,
        ));
        tasks.insert(TaskEntry::new(
            summary("task2", "echo done", TaskStatus::Exited, None),
            None,
        ));

        emit_tasks_event(&tasks, &broadcaster);
        let event = rx.try_recv().expect("tasks event emitted");
        assert_eq!(event.name, "tasks");
        assert_eq!(
            event.data,
            json!({
                "active": [{ "id": "task1", "command": "npm run dev", "logName": "dev" }],
            })
        );
    }

    #[test]
    fn cancel_on_drop_fires_its_configured_signal_unless_disarmed() {
        let fired: Arc<Mutex<Vec<KillSignal>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = fired.clone();
        let handle: KillHandle = Arc::new(move |signal| {
            sink.lock().unwrap().push(signal);
            true
        });

        {
            let mut guard = CancelOnDrop::new(handle.clone(), KillSignal::Term);
            guard.disarm();
        }
        assert!(fired.lock().unwrap().is_empty(), "disarmed guard is inert");

        drop(CancelOnDrop::new(handle, KillSignal::Kill));
        assert_eq!(*fired.lock().unwrap(), vec![KillSignal::Kill]);
    }
}
