//! Setup orchestrator — the clone -> install -> start pipeline.
//!
//! STATUS CORRECTION (see the native parity contract and
//! the desktop migration contract §1.2's "setup:
//! clone|install|start enqueue acks" line): earlier Phase-1 docs
//! (the native local-API contract §C, the native module-ownership contract's "Deliberately out of
//! scope" section) classified the whole setup/clone family as DROPPED,
//! reasoning that desktop only ever opens an *already-checked-out* project
//! folder. That's true for `LOCAL_API_WORKDIR` in the steady state, but it
//! misses how a project FIRST lands on a machine and how its preview dev
//! server starts — both still go through this same clone -> install -> start
//! pipeline (mirroring `packages/sandbox/daemon/setup/orchestrator.ts`), just
//! triggered by a `POST /_sandbox/config` carrying `git.repository.cloneUrl`
//! instead of a cluster-side clone-then-hand-the-daemon-a-workdir flow. This
//! module is the correction: KEPT, not dropped. See the doc updates in the
//! same change for the corrected KEPT/DROPPED classification.
//!
//! ## Scope narrower than the TS daemon (deliberate, documented — not a gap)
//!
//! - No golden-cache fast-path (`setup/golden-cache.ts`) and no deps-cache
//!   env plumbing (`setup/install.ts`'s `depsCacheEnv`/`denoCacheEnv`) — both
//!   are pod/cluster warm-pool optimizations with no desktop-laptop
//!   equivalent (the desktop migration contract: "Dropped in v1: … golden-cache").
//! - No install-fingerprint skip (`install/install-state.ts`) — a desktop
//!   `local-api` process boots once per app launch, not once per warm-pool
//!   claim, so the "already installed for this exact config+HEAD" skip that
//!   exists to avoid re-running `npm install` on every claim has much less
//!   payoff here; every `clone`/`bootstrap` transition just runs install.
//! - No continuous crash-supervision loop (`probe.ts`'s standing
//!   booting/online/offline state machine) — this module's dev-server
//!   confirmation is a single-shot "spawn, sniff the bind announcement,
//!   confirm with one HTTP probe, done" (see `setup/dev.rs`), not a
//!   perpetual poller. A desktop dev server crashing after a confirmed
//!   `running` transition is a real gap (no `crashed` phase is ever
//!   reached), flagged here rather than silently accepted — no test in
//!   either target suite exercises post-running crash recovery.
//! - No org-fs (`ensureGitExclude`) or protected-branch hook installation
//!   during clone — org-fs mounting is a separately DROPPED family (still
//!   correctly dropped, contract doc §C); the protected-branch hook is
//!   belt-and-suspenders for `publish()`'s in-code guard (`routes/git.rs`
//!   already enforces the same list without the hook, since `publish()` runs
//!   `--no-verify` and would skip the hook anyway).
//!
//! ## Log retention is file-backed (`crate::log_store`)
//!
//! `clone`/`install`/`dev` all stream their subprocess output through
//! [`crate::tasks::TaskRegistry::append_log`] rather than buffering it in
//! RAM: each chunk lands in [`crate::log_store::LogStore`] (both a per-task
//! file AND the source's stable, combined `"app/<source>"` transcript — see
//! that module's doc comment) and only THEN fans out live via the
//! broadcaster. Files are the source of truth for anything a late
//! `/_sandbox/events` connect or a `/_sandbox/tasks/:id` query needs to
//! replay; RAM (the broadcaster's subscriber set, a task's `chunks_tx`)
//! holds only the transient live fan-out for whoever is connected RIGHT
//! now.
//!
//! `setup/clone.rs` used to be the one exception: it shelled out via
//! `Command::output()`, which buffers the whole process in memory and
//! returns it only after exit — no `"log"` frame was ever emitted and no
//! task was ever registered, so an in-progress clone was invisible to both
//! `/_sandbox/events` and `/_sandbox/tasks`. That file now streams through
//! the same `append_log` path `install.rs`/`dev.rs` already used — see its
//! own module doc for the fix in detail.

pub mod clone;
pub(crate) mod detect_runtime;
pub mod dev;
pub mod install;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::mpsc;

use crate::config::ConfigStore;
use crate::events::Broadcaster;
use crate::tasks::{KillAllResult, TaskEntry, TaskRegistry};

/// The named entry points into the setup pipeline — byte-parity with the
/// daemon's `Step` union (`setup/orchestrator.ts`). A step always runs
/// forward: `Clone` also runs install + start, `Install` also runs start.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    Clone,
    Install,
    Start,
}

impl Step {
    /// The wire value for `POST /_sandbox/setup/:step`'s `{"enqueued": ...}`
    /// ack — byte-parity with `daemon/routes/setup.ts::makeSetupHandler`.
    pub fn as_str(&self) -> &'static str {
        match self {
            Step::Clone => "clone",
            Step::Install => "install",
            Step::Start => "start",
        }
    }
}

struct Inner {
    /// Current `LifecycleState` phase object, e.g. `{"phase":"idle"}` or
    /// `{"phase":"running","port":3000,"htmlSupport":false}` — byte-parity
    /// shape with `daemon/events/types.ts::LifecycleState`.
    lifecycle: Value,
    /// `None` until the install step has run at least once WITH a package
    /// manager configured (byte-parity with `orchestrator.getDiscoveredScripts()`
    /// staying `null` until `broadcastDiscoveredScripts` first runs — see
    /// `setup/install.rs`'s doc comment on when that happens).
    discovered_scripts: Option<Vec<String>>,
}

/// Drives the setup pipeline in response to config transitions
/// (`handle_transition`) or explicit retry requests (`resume_from`, the
/// `POST /_sandbox/setup/{clone,install,start}` routes). A single background
/// worker task (spawned once in [`SetupOrchestrator::new`]) processes queued
/// steps strictly in order, so an in-flight clone can never race a
/// concurrently-enqueued install.
pub struct SetupOrchestrator {
    pub(crate) repo_dir: PathBuf,
    /// The managed root that owns BOTH `sandboxes/<handle>/repo` (this
    /// orchestrator's `repo_dir`) and the shared `repos/<host>/<owner>/<repo>`
    /// canonical git store the clone step adds worktrees from. Carried
    /// explicitly rather than derived from `repo_dir`, whose depth differs
    /// between the global orchestrator (`<app_root>/repo`) and a per-handle
    /// one (`<app_root>/sandboxes/<handle>/repo`).
    pub(crate) app_root: PathBuf,
    pub(crate) config: Arc<ConfigStore>,
    pub(crate) tasks: Arc<TaskRegistry>,
    pub(crate) broadcaster: Arc<Broadcaster>,
    running: AtomicBool,
    /// Queue depth NOT yet started (decremented the moment a step is popped,
    /// not when it finishes) — matches `GET /health`'s
    /// `orchestrator.pending` / the daemon's `SetupOrchestrator.pendingCount()`.
    pending: AtomicUsize,
    inner: Mutex<Inner>,
    /// Linearizes `close` with task registration. If registration wins, the
    /// task is visible before shutdown snapshots the registry; if close wins,
    /// no child may be spawned for that task.
    task_registration: Mutex<()>,
    /// Identity of the newest dev-server spawn admitted by this orchestrator.
    /// A port probe belongs to the task that discovered that port; retaining
    /// the task id here prevents a slow probe from an older spawn from
    /// publishing `running` after Restart has replaced it.
    active_dev_task: Mutex<Option<String>>,
    tx: Mutex<Option<mpsc::UnboundedSender<Step>>>,
    worker: Mutex<Option<tokio::task::JoinHandle<()>>>,
    closed: AtomicBool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SetupShutdownResult {
    pub worker_stopped: bool,
    pub tasks: KillAllResult,
}

impl SetupOrchestrator {
    pub fn new(
        repo_dir: PathBuf,
        app_root: PathBuf,
        config: Arc<ConfigStore>,
        tasks: Arc<TaskRegistry>,
        broadcaster: Arc<Broadcaster>,
    ) -> Arc<Self> {
        let (tx, rx) = mpsc::unbounded_channel();
        let this = Arc::new(Self {
            repo_dir,
            app_root,
            config,
            tasks,
            broadcaster,
            running: AtomicBool::new(false),
            pending: AtomicUsize::new(0),
            inner: Mutex::new(Inner {
                lifecycle: json!({ "phase": "idle" }),
                discovered_scripts: None,
            }),
            task_registration: Mutex::new(()),
            active_dev_task: Mutex::new(None),
            tx: Mutex::new(Some(tx)),
            worker: Mutex::new(None),
            closed: AtomicBool::new(false),
        });
        // Plain (non-async) unit tests across several families construct a
        // full `AppState` — and therefore a `SetupOrchestrator` — purely as
        // fixture plumbing, with no Tokio runtime available to spawn onto
        // (`tokio::spawn` outside a runtime panics). Those fixtures never
        // exercise the pipeline (no `resume_from`/`handle_transition` call
        // that would actually enqueue a step), so skipping the worker spawn
        // when no runtime is current is safe: `enqueue()`'s `tx.send()`
        // would just find a dropped receiver and no-op, exactly like a
        // caller racing a not-yet-started worker. Every real caller (the
        // `#[tokio::main]` binary, `#[tokio::test]`s that actually drive the
        // pipeline) runs inside a runtime and gets the worker as before.
        if tokio::runtime::Handle::try_current().is_ok() {
            let weak = Arc::downgrade(&this);
            let worker = tokio::spawn(async move { worker_loop(weak, rx).await });
            *this.lock_worker() = Some(worker);
        }
        this
    }

    /// Maps a [`crate::config::classify::Transition`] kind string (the same
    /// strings `ConfigStore::patch`'s `ApplyOutcome.transition` already
    /// returns) onto a pipeline step — byte-parity with
    /// `setup/orchestrator.ts::transitionToStep`. `None`-mapped transitions
    /// (`env-change`, `git-credential-refresh`, `identity-conflict`, `no-op`)
    /// are silently ignored, matching the TS source.
    pub fn handle_transition(&self, transition: &str) {
        let step = match transition {
            "bootstrap" | "branch-change" => Some(Step::Clone),
            "runtime-change" | "pm-change" => Some(Step::Install),
            "port-change" => Some(Step::Start),
            _ => None,
        };
        if let Some(step) = step {
            self.enqueue(step);
        }
    }

    /// `POST /_sandbox/setup/:step` — enqueues regardless of current setup
    /// state until shutdown closes admission. Returns `false` once closed (or
    /// if the worker has ended), so callers never report accepted work that
    /// cannot run.
    pub fn resume_from(&self, step: Step) -> bool {
        self.enqueue(step)
    }

    fn enqueue(&self, step: Step) -> bool {
        let tx = self.lock_tx();
        if self.is_closed() {
            return false;
        }
        let Some(tx) = tx.as_ref() else {
            return false;
        };
        self.pending.fetch_add(1, Ordering::SeqCst);
        if tx.send(step).is_err() {
            decrement(&self.pending);
            return false;
        }
        true
    }

    /// Permanently rejects later setup work and closes the worker's queue.
    /// Synchronous so a shutdown owner can close every orchestrator before it
    /// awaits any one child.
    pub fn close(&self) -> bool {
        let _registration = self.lock_task_registration();
        let first = !self.closed.swap(true, Ordering::SeqCst);
        self.lock_tx().take();
        first
    }

    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }

    /// Registers a setup child under the same close fence used by shutdown.
    /// Callers must do this before spawning; the attached kill controller's
    /// durable signal state handles shutdown landing between registration and
    /// the subsequent `Command::spawn`.
    pub(crate) fn register_task(&self, entry: TaskEntry) -> bool {
        let _registration = self.lock_task_registration();
        if self.is_closed() {
            return false;
        }
        self.tasks.insert(entry);
        true
    }

    /// Makes `task_id` the only dev spawn allowed to publish lifecycle state.
    /// Task ids are boot-unique, so this is also a generation token.
    pub(crate) fn claim_dev_task(&self, task_id: &str) {
        *self.lock_active_dev_task() = Some(task_id.to_string());
    }

    pub(crate) fn is_current_dev_task(&self, task_id: &str) -> bool {
        self.lock_active_dev_task().as_deref() == Some(task_id)
    }

    /// Publishes a dev lifecycle transition under the same generation fence
    /// used by [`Self::claim_dev_task`] and [`Self::finish_dev_task`].
    pub(crate) fn transition_dev_lifecycle(&self, task_id: &str, next: Value) -> bool {
        let active = self.lock_active_dev_task();
        if active.as_deref() != Some(task_id) || self.is_closed() {
            return false;
        }
        self.transition_lifecycle(next);
        true
    }

    /// Invalidates a completed/failed dev task without letting an older task
    /// clear the token belonging to its replacement.
    pub(crate) fn finish_dev_task(&self, task_id: &str) -> bool {
        let mut active = self.lock_active_dev_task();
        if active.as_deref() != Some(task_id) {
            return false;
        }
        active.take();
        true
    }

    /// Closes queue/task admission, reaps every registered child with one
    /// concurrent TERM→KILL budget, then joins (or aborts and joins) the worker.
    /// Idempotent: only the first caller owns the worker `JoinHandle`.
    pub async fn shutdown(
        &self,
        term_grace: Duration,
        kill_grace: Duration,
    ) -> SetupShutdownResult {
        self.close();
        let tasks = self.tasks.kill_all_and_wait(term_grace, kill_grace).await;

        let worker = self.lock_worker().take();
        let worker_stopped = match worker {
            Some(mut worker) => match tokio::time::timeout(kill_grace, &mut worker).await {
                Ok(_) => true,
                Err(_) => {
                    worker.abort();
                    let _ = worker.await;
                    false
                }
            },
            None => true,
        };
        self.running.store(false, Ordering::SeqCst);
        self.pending.store(0, Ordering::SeqCst);
        SetupShutdownResult {
            worker_stopped,
            tasks,
        }
    }

    /// `true` while a step is actively being applied. Surfaced on
    /// `GET /health`'s `orchestrator.running` (and the legacy `setup.running`
    /// alias) — `waitForOrchestratorIdle()` in both e2e helper files polls
    /// this until it's `false` with `pending_count() == 0`.
    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }

    pub fn pending_count(&self) -> usize {
        self.pending.load(Ordering::SeqCst)
    }

    /// `{"running":bool,"pending":usize}` — the exact shape both
    /// `GET /health` and `GET /_sandbox/config` embed under `orchestrator`.
    pub fn orchestrator_json(&self) -> Value {
        json!({ "running": self.is_running(), "pending": self.pending_count() })
    }

    /// Current `LifecycleState` phase object — the `/_sandbox/events`
    /// connect-time snapshot (`routes/events.rs`) wraps this in
    /// `{"state": ...}` to build the `"lifecycle"` SSE frame.
    pub fn lifecycle_snapshot(&self) -> Value {
        self.lock().lifecycle.clone()
    }

    /// `None` until the install step has broadcast a discovered set at least
    /// once — see [`Inner::discovered_scripts`]'s doc comment.
    pub fn discovered_scripts(&self) -> Option<Vec<String>> {
        self.lock().discovered_scripts.clone()
    }

    /// Idempotent — a same-shape transition doesn't re-broadcast (byte-parity
    /// with `LifecycleManager::transition`'s `equal(this.state, next)` guard).
    pub(crate) fn transition_lifecycle(&self, next: Value) {
        let mut guard = self.lock();
        if guard.lifecycle == next {
            return;
        }
        guard.lifecycle = next.clone();
        drop(guard);
        self.broadcaster.emit("lifecycle", json!({ "state": next }));
    }

    /// Byte-parity with `broadcastDiscoveredScripts`: unconditional emit
    /// (not change-detected — unlike `routes/scripts.rs`'s own
    /// `GET /_sandbox/scripts` dedup, which is a DIFFERENT call site with its
    /// own "only on actual change" contract).
    pub(crate) fn mark_discovered_scripts(&self, scripts: Vec<String>) {
        self.lock().discovered_scripts = Some(scripts.clone());
        self.broadcaster
            .emit("scripts", json!({ "scripts": scripts }));
    }

    /// The current merged `TenantConfig` view (git/operator/application —
    /// same shape `ConfigStore::snapshot().config` exposes on the wire,
    /// `env` values excluded). Sufficient for every field the pipeline reads
    /// (`git.repository.{cloneUrl,branch}`, `git.identity`,
    /// `application.packageManager.{name,path}`, `application.port`).
    pub(crate) fn current_config(&self) -> Option<Value> {
        self.config.snapshot().config
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        match self.inner.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    fn lock_task_registration(&self) -> std::sync::MutexGuard<'_, ()> {
        match self.task_registration.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    fn lock_active_dev_task(&self) -> std::sync::MutexGuard<'_, Option<String>> {
        match self.active_dev_task.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    fn lock_tx(&self) -> std::sync::MutexGuard<'_, Option<mpsc::UnboundedSender<Step>>> {
        match self.tx.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    fn lock_worker(&self) -> std::sync::MutexGuard<'_, Option<tokio::task::JoinHandle<()>>> {
        match self.worker.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        }
    }
}

/// The single background consumer — one per `SetupOrchestrator`, spawned
/// once in `new`. Processes steps strictly serially: `run_cascade` is
/// `.await`ed to completion before the next `rx.recv()` resolves, so an
/// install can never observe a half-finished clone.
async fn worker_loop(orch: Weak<SetupOrchestrator>, mut rx: mpsc::UnboundedReceiver<Step>) {
    while let Some(step) = rx.recv().await {
        let Some(orch) = orch.upgrade() else {
            return;
        };
        if orch.is_closed() {
            orch.pending.store(0, Ordering::SeqCst);
            return;
        }
        decrement(&orch.pending);
        orch.running.store(true, Ordering::SeqCst);
        run_cascade(&orch, step).await;
        orch.running.store(false, Ordering::SeqCst);
        if orch.is_closed() {
            orch.pending.store(0, Ordering::SeqCst);
            return;
        }
    }
}

fn decrement(value: &AtomicUsize) {
    let _ = value.fetch_update(Ordering::SeqCst, Ordering::SeqCst, |current| {
        Some(current.saturating_sub(1))
    });
}

/// Byte-parity with `SetupOrchestrator.runStep`: `Clone` cascades into
/// install then start; `Install` cascades into start; `Start` runs alone. A
/// step that fails (clone/install returning `false`) stops the cascade
/// short, same as the TS `if (!(await this.stepX())) return;` chain.
async fn run_cascade(orch: &Arc<SetupOrchestrator>, step: Step) {
    if orch.is_closed() {
        return;
    }
    match step {
        Step::Clone => {
            let Some(config) = orch.current_config() else {
                return;
            };
            if !clone::run(orch, &config).await {
                return;
            }
            if orch.is_closed() {
                return;
            }
            let Some(config) = orch.current_config() else {
                return;
            };
            if !install::run(orch, &config).await {
                return;
            }
            if orch.is_closed() {
                return;
            }
            let Some(config) = orch.current_config() else {
                return;
            };
            dev::run(orch, &config).await;
        }
        Step::Install => {
            let Some(config) = orch.current_config() else {
                return;
            };
            if !install::run(orch, &config).await {
                return;
            }
            if orch.is_closed() {
                return;
            }
            let Some(config) = orch.current_config() else {
                return;
            };
            dev::run(orch, &config).await;
        }
        Step::Start => {
            let Some(config) = orch.current_config() else {
                return;
            };
            dev::run(orch, &config).await;
        }
    }
}

/// `{"phase":"start-failed","error": ...}` — the terminal-failure shape the
/// `install`/`dev` steps construct on their own failure paths; centralized
/// to keep the wire shape consistent.
pub(crate) fn start_failed(error: impl Into<String>) -> Value {
    json!({ "phase": "start-failed", "error": error.into() })
}

/// `{"phase":"clone-failed","error": ...}` — the `clone` step's own
/// terminal-failure shape (byte-parity with `LifecycleState`'s
/// `clone-failed` variant, distinct from `install-failed`/`start-failed`).
pub(crate) fn clone_failed(error: impl Into<String>) -> Value {
    json!({ "phase": "clone-failed", "error": error.into() })
}

/// `{"phase":"install-failed","error": ...}` — the `install` step's own
/// terminal-failure shape.
pub(crate) fn install_failed(error: impl Into<String>) -> Value {
    json!({ "phase": "install-failed", "error": error.into() })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn orch() -> Arc<SetupOrchestrator> {
        // None of these tests set a config, so the pipeline never actually
        // runs (every step no-ops on `current_config() == None`) — no
        // `LogStore` I/O ever happens, so a `"."`-rooted store (never
        // exercised) is safe here, unlike `clone.rs`'s own tests below.
        let logs = Arc::new(crate::log_store::LogStore::new(PathBuf::from(".")));
        SetupOrchestrator::new(
            PathBuf::from("."),
            PathBuf::from("."),
            Arc::new(ConfigStore::new()),
            Arc::new(TaskRegistry::new(logs)),
            Arc::new(Broadcaster::new()),
        )
    }

    #[test]
    fn fresh_orchestrator_is_idle() {
        let o = orch();
        assert!(!o.is_running());
        assert_eq!(o.pending_count(), 0);
        assert_eq!(o.lifecycle_snapshot(), json!({"phase": "idle"}));
        assert!(o.discovered_scripts().is_none());
    }

    #[tokio::test]
    async fn resume_from_drains_to_idle_with_no_config() {
        let o = orch();
        o.resume_from(Step::Clone);
        // Give the worker a beat to pick the step up and finish (no config
        // -> every step no-ops immediately).
        for _ in 0..100 {
            if !o.is_running() && o.pending_count() == 0 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert!(!o.is_running());
        assert_eq!(o.pending_count(), 0);
    }

    #[test]
    fn close_rejects_queued_work_and_child_registration() {
        let o = orch();
        assert!(o.close());
        assert!(!o.close(), "close is idempotent");
        assert!(o.is_closed());
        assert!(!o.resume_from(Step::Clone));
        assert_eq!(o.pending_count(), 0);

        let id = o.tasks.next_id();
        assert!(!o.register_task(TaskEntry::new(
            crate::tasks::TaskSummary {
                id: id.clone(),
                command: "never-spawned".to_string(),
                status: crate::tasks::TaskStatus::Running,
                exit_code: None,
                started_at: 0,
                finished_at: None,
                timed_out: false,
                truncated: false,
                log_name: None,
                intentional: None,
            },
            None,
        )));
        assert!(o.tasks.get(&id).is_none());
    }

    #[tokio::test]
    async fn worker_holds_only_a_weak_orchestrator_reference() {
        let o = orch();
        let weak = Arc::downgrade(&o);
        drop(o);
        tokio::task::yield_now().await;
        assert!(
            weak.upgrade().is_none(),
            "an idle worker must not keep its orchestrator alive"
        );
    }

    #[tokio::test]
    async fn shutdown_closes_and_joins_the_worker() {
        let o = orch();
        assert!(o.resume_from(Step::Clone));
        let result = o
            .shutdown(Duration::from_millis(50), Duration::from_secs(1))
            .await;
        assert!(result.worker_stopped);
        assert_eq!(result.tasks.initially_running, 0);
        assert!(o.is_closed());
        assert!(!o.is_running());
        assert_eq!(o.pending_count(), 0);
        assert!(!o.resume_from(Step::Start));
    }

    #[test]
    fn transition_lifecycle_is_idempotent() {
        let o = orch();
        let mut rx = o.broadcaster.subscribe();
        o.transition_lifecycle(json!({"phase": "idle"}));
        // Same shape as the initial state -> no broadcast.
        assert!(rx.try_recv().is_err());
        o.transition_lifecycle(json!({"phase": "cloning"}));
        let evt = rx.try_recv().expect("changed phase broadcasts");
        assert_eq!(evt.name, "lifecycle");
        assert_eq!(evt.data["state"]["phase"], "cloning");
    }

    #[test]
    fn handle_transition_maps_kinds_to_steps() {
        let o = orch();
        // bootstrap/branch-change/runtime-change/pm-change/port-change all
        // enqueue; env-change/git-credential-refresh/identity-conflict/no-op
        // don't. Exercise via pending_count() deltas (worker hasn't been
        // given a chance to drain a no-config-noop yet in a sync test).
        assert_eq!(o.pending_count(), 0);
        o.handle_transition("no-op");
        assert_eq!(o.pending_count(), 0, "no-op must not enqueue");
        o.handle_transition("env-change");
        assert_eq!(o.pending_count(), 0, "env-change must not enqueue");
    }
}
