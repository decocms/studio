//! [`SandboxManager`] — `HashMap<Handle, Arc<Sandbox>>`, plus the
//! `ensure()` entry point that (idempotently, with concurrent-caller
//! coalescing) drives a fresh-or-existing [`Sandbox`]'s clone -> install ->
//! start pipeline. See `sandbox`'s module doc for the overall design.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures::future::join_all;
use serde_json::{json, Map, Value};

use crate::config::ConfigStore;
use crate::events::Broadcaster;
use crate::log_store::LogStore;
use crate::setup::{SetupOrchestrator, SetupShutdownResult, Step};
use crate::tasks::{KillSignal, TaskRegistry, TaskStatus};

const BRANCH_STATUS_POLL_INTERVAL: Duration = Duration::from_secs(3);

/// True if this sandbox has a `dev`/`start` task currently Running. `ensure()`
/// uses it to decide whether a no-op-clone dispatch still needs to (re)start
/// the dev server — e.g. after an app relaunch dropped the previous process's
/// dev child while the worktree stayed on disk.
fn dev_task_running(sandbox: &Sandbox) -> bool {
    sandbox
        .tasks
        .list(Some(&[TaskStatus::Running]))
        .iter()
        .any(|t| matches!(t.log_name.as_deref(), Some("dev") | Some("start")))
}

/// The clone target + workload hints a caller resolved from a dispatch
/// payload (decopilot's `sandbox` block, or the daemon-parity family's
/// `workspace.repo`/`workspace.branch`) — everything [`SandboxManager::ensure`]
/// needs to (re-)apply the per-handle `TenantConfig`.
///
/// `virtual_mcp_id` + `branch` are the ONLY fields that feed
/// [`SandboxManager::compute_handle`] — the rest only affect the config
/// patch applied to whichever [`Sandbox`] that handle resolves to.
///
/// `Serialize`/`Deserialize`: this is also the exact shape persisted to
/// `<app_root>/worktrees/<handle>/sandbox-config.json` (see the `persist`
/// module doc) so a restarted process can RE-`ensure()` a handle it forgot
/// in memory — `compute_handle` is a one-way hash, so this sidecar is the
/// only way back from a bare handle string to "what repo/branch is this".
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct GitSandboxConfig {
    pub virtual_mcp_id: String,
    pub clone_url: String,
    /// `None`/empty defaults to `"main"` — see [`SandboxManager::ensure`].
    pub branch: Option<String>,
    pub runtime: Option<String>,
    pub package_manager: Option<String>,
    pub package_manager_path: Option<String>,
    pub git_user_name: Option<String>,
    pub git_user_email: Option<String>,
    /// Organization slug this sandbox belongs to, for the shared org
    /// filesystem mounts at `<app_root>/orgs/<org_slug>/` (see
    /// `docs/org-fs-plan.md`). The mounts are keyed by org — not by sandbox —
    /// so the slug has to travel with the config rather than staying at the
    /// request layer where it is known.
    ///
    /// `Option` because not every caller knows it: `/_sandbox/dispatch` parses
    /// its config out of a workspace block that carries no org. Such a call
    /// inherits the persisted slug via `merge_durable_config`, so a sandbox
    /// only has to learn its org once.
    #[serde(default)]
    pub org_slug: Option<String>,
}

/// One handle's isolated slice of the sandbox pipeline: its own workdir
/// (`<app_root>/worktrees/<handle>/repo`) and its own
/// config/tasks/broadcaster/orchestrator quadruple — deliberately the SAME
/// four types `crate::lib::start()` wires up for the single global sandbox,
/// just constructed again per handle instead of once per process.
pub struct Sandbox {
    pub handle: String,
    pub workdir: PathBuf,
    pub config: Arc<ConfigStore>,
    pub tasks: Arc<TaskRegistry>,
    pub broadcaster: Arc<Broadcaster>,
    pub setup: Arc<SetupOrchestrator>,
    registry_monitor_started: AtomicBool,
    branch_monitor_started: AtomicBool,
}

/// `HashMap<Handle, Arc<Sandbox>>` plus a per-handle async lock so two
/// concurrent `ensure()` calls for a handle that doesn't exist YET don't
/// both `git clone` into the same not-yet-created directory — see
/// [`SandboxManager::ensure`].
pub struct SandboxManager {
    app_root: PathBuf,
    registry: super::registry::SandboxRegistry,
    closing: AtomicBool,
    sandboxes: Mutex<HashMap<String, Arc<Sandbox>>>,
    /// Operation locks, one per handle currently being (or about to be)
    /// ensured. The lock covers the WHOLE config -> clone/checkout -> cascade
    /// scheduling operation, not just the `Sandbox`'s map insertion: two
    /// callers running git against the same workdir concurrently can leave a
    /// half-created repository even though they share the same `Sandbox` Arc.
    /// Entries are never removed — a handle lives for the process lifetime
    /// once first requested, so the map stays bounded by the number of
    /// DISTINCT (virtualMcpId, branch) pairs a session ever dispatches, not by
    /// call volume.
    locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    /// The handle whose dev server the reverse proxy serves for a plain
    /// (headerless) preview request — see [`SandboxManager::active`]. A
    /// browser iframe navigation cannot attach the `x-decocms-sandbox-handle`
    /// header, so the preview iframe (which loads the local-api origin
    /// directly) relies on this: `ensure()` marks its handle active, so the
    /// most-recently-dispatched thread's sandbox is what the preview shows.
    /// The webview can also set it explicitly on thread focus (see
    /// `POST /_sandbox/preview-handle`) for switching threads without re-running.
    active_handle: Mutex<Option<String>>,
    /// Change feed for `active_handle` — headerless `/_sandbox/events`
    /// streams follow the ACTIVE sandbox across changes (a stream opened
    /// before any sandbox existed would otherwise stay pinned to the
    /// process-global broadcaster forever, rendering a blank drawer —
    /// observed live 2026-07-22). `set_active` publishes; the events route
    /// watches.
    active_watch: tokio::sync::watch::Sender<Option<String>>,
    /// Per-handle process-generation feeds. An explicit xterm/SSE stream must
    /// follow a stopped sandbox when Resume replaces its in-memory `Sandbox`
    /// Arc, independently of whichever other chat is currently active.
    generation_watches: Mutex<HashMap<String, tokio::sync::watch::Sender<Option<Arc<Sandbox>>>>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SandboxShutdownResult {
    pub handle: String,
    pub result: SetupShutdownResult,
}

impl SandboxManager {
    pub fn new(app_root: PathBuf) -> Arc<Self> {
        let registry = super::registry::SandboxRegistry::open(app_root.clone())
            .unwrap_or_else(|error| panic!("native sandbox registry failed to open: {error}"));
        let persisted_active = registry.active_handle().ok().flatten();
        Arc::new(Self {
            app_root,
            registry,
            closing: AtomicBool::new(false),
            sandboxes: Mutex::new(HashMap::new()),
            locks: Mutex::new(HashMap::new()),
            active_handle: Mutex::new(persisted_active.clone()),
            active_watch: tokio::sync::watch::channel(persisted_active).0,
            generation_watches: Mutex::new(HashMap::new()),
        })
    }

    /// The sandbox the reverse proxy serves for a headerless preview request:
    /// the last handle `ensure()`-d, or one explicitly focused by the webview.
    /// `None` until the first git-backed dispatch — the proxy then falls back
    /// to the global (non-git) orchestrator, exactly as before.
    pub fn active(&self) -> Option<Arc<Sandbox>> {
        let handle = self.active_handle.lock().ok()?.clone()?;
        self.get(&handle)
    }

    /// Point the headerless preview at a registered `handle` (idempotent).
    /// Unknown handles are rejected so a frontend-computed identity can never
    /// become a persisted pointer to a sandbox Rust has no config for.
    ///
    /// Also best-effort persists `handle` to disk (see the `persist` module
    /// doc) so a HEADERLESS resolve after a process restart can find its way
    /// back to the last-focused sandbox via [`Self::resurrect_active`] —
    /// `active_handle` above is in-memory only and starts `None` every boot.
    /// Subscribe to active-handle changes (see `active_watch`).
    pub fn watch_active(&self) -> tokio::sync::watch::Receiver<Option<String>> {
        self.active_watch.subscribe()
    }

    /// Subscribe to replacements of one durable handle's in-memory process
    /// generation. Unlike `watch_active`, this is identity-scoped: focusing a
    /// different chat cannot hide a Stop -> Resume replacement from an xterm
    /// that is still following this handle.
    pub fn watch_generation(
        &self,
        handle: &str,
    ) -> tokio::sync::watch::Receiver<Option<Arc<Sandbox>>> {
        let current = self.get(handle);
        let mut watches = self
            .generation_watches
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let sender = watches.entry(handle.to_string()).or_insert_with(|| {
            let (sender, _receiver) = tokio::sync::watch::channel(current.clone());
            sender
        });
        if current.is_some() && sender.borrow().is_none() {
            sender.send_replace(current);
        }
        sender.subscribe()
    }

    fn publish_generation(&self, handle: &str, generation: Option<Arc<Sandbox>>) {
        let mut watches = self
            .generation_watches
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let sender = watches.entry(handle.to_string()).or_insert_with(|| {
            let (sender, _receiver) = tokio::sync::watch::channel(None);
            sender
        });
        sender.send_replace(generation);
    }

    pub fn set_active(&self, handle: &str) -> Result<(), String> {
        self.registry.set_active(handle)?;
        if let Ok(mut guard) = self.active_handle.lock() {
            *guard = Some(handle.to_string());
        }
        // Keep the pre-registry files readable during the migration window.
        super::persist::write_active_handle(&self.app_root, handle);
        let _ = self.active_watch.send(Some(handle.to_string()));
        Ok(())
    }

    /// Whether `handle` has durable config, independently of whether this
    /// process has materialized its live Rust objects yet.
    /// The worktree handle an agent uses for `branch`, via the registry —
    /// the routes the shell calls carry `(virtualMcpId, branch)`, never a
    /// clone URL, and the handle is derived from the repository.
    pub fn handle_for_agent(
        &self,
        virtual_mcp_id: &str,
        branch: &str,
    ) -> Result<Option<String>, String> {
        self.registry.handle_for_agent(virtual_mcp_id, branch)
    }

    pub fn is_registered(&self, handle: &str) -> Result<bool, String> {
        self.registry.contains(handle)
    }

    /// Durable active pointer without materializing or starting its sandbox.
    pub fn registered_active_handle(&self) -> Result<Option<String>, String> {
        self.registry.active_handle()
    }

    /// Returns the durable record for lifecycle/API responses.
    pub(crate) fn registry_record(
        &self,
        handle: &str,
    ) -> Result<Option<super::registry::SandboxRecord>, String> {
        self.registry.record(handle)
    }

    /// `<host>/<owner>/<repo>/<branch>` — the worktree's path under
    /// `worktrees/`, and its identity everywhere else.
    ///
    /// No hash and no `virtualMcpId`: the repository scope already makes this
    /// unique, so the handle can simply BE the branch under its repo. That is
    /// what lets the directory, the local git branch, the remote branch and
    /// the UI carry ONE name — a hashed handle forced a second, different name
    /// into the git layer, and every bug that followed came from the two
    /// disagreeing.
    ///
    /// The branch is slugified, so it is always exactly one path segment:
    /// `feature/foo` becomes `feature-foo` rather than nesting a level.
    ///
    /// One worktree per `(repo, branch)` is the deliberate consequence — two
    /// agents on one branch share it, which is the only honest thing to do
    /// with two working copies of the same branch.
    pub fn compute_handle(clone_url: &str, branch: &str) -> Option<String> {
        let mut scope = super::repo_store::repo_scope(clone_url)?;
        scope.push(slugify_branch(branch));
        Some(scope.join("/"))
    }

    /// Bring up this sandbox's organization filesystem, and say in the
    /// transcript what happened.
    ///
    /// The VIEW is built synchronously: it is a handful of `mkdir`s and
    /// symlinks, and the dispatch path gates the agent's org-filesystem prompt
    /// on that directory existing, so deferring it would let the first turn of
    /// a brand-new sandbox run without knowing the org exists at all.
    ///
    /// The MOUNTS are warmed earlier, when the app first touches the org (see
    /// `org_mount::warm`), so this only WAITS for them — briefly, and usually
    /// not at all. Backgrounding the mount here instead would leave a window
    /// in which the agent reads `org/` before it is attached, sees an empty
    /// directory and concludes the organization is empty; waiting makes the
    /// outcome deterministic, and the timeout keeps a broken mount from
    /// blocking provisioning.
    ///
    /// The `[org-fs]` line exists because the two failure modes are otherwise
    /// indistinguishable to the person reading it: an org with nothing in it
    /// and an org filesystem that never came up BOTH show an empty `org/`.
    /// Silence there would reproduce exactly the class of bug this feature was
    /// built to avoid — an agent reporting "no files" when the truth is "no
    /// filesystem". It is emitted from the background task, once the outcome
    /// is actually known.
    ///
    /// Never fails the caller. A sandbox without an org filesystem still runs.
    async fn ensure_org_filesystem(&self, sandbox: &Sandbox, handle: &str, org_slug: &str) {
        let linked = super::org_view::ensure_org_view(&self.app_root, handle, org_slug).await;
        if !linked {
            self.report_org_fs(
                sandbox,
                format!(
                    "[org-fs] could not build the org/ view for '{org_slug}' — the organization filesystem is unavailable\r\n"
                ),
            )
            .await;
            return;
        }

        let mounted = super::org_mount::wait_ready(&self.app_root, org_slug).await;
        let line = if mounted {
            format!("[org-fs] organization filesystem ready for '{org_slug}'\r\n")
        } else {
            format!(
                "[org-fs] organization filesystem for '{org_slug}' is NOT mounted — org/ will read as empty\r\n"
            )
        };
        self.report_org_fs(sandbox, line).await;
    }

    /// One `[org-fs]` line into this sandbox's setup transcript.
    async fn report_org_fs(&self, sandbox: &Sandbox, line: String) {
        sandbox
            .tasks
            .logs()
            .append(&crate::log_store::app_key("setup"), &line)
            .await;
        sandbox
            .broadcaster
            .emit("log", json!({ "source": "setup", "data": line }));
    }

    /// Where a git-backed run's checkout belongs —
    /// `<app_root>/worktrees/<handle>/repo` — computed from the config alone,
    /// so it is known even when [`Self::ensure`] never succeeded.
    ///
    /// Exists so a failed `ensure` cannot route a git-backed run into the
    /// process-global `state.repo_dir`. That directory is shared by every
    /// thread: falling back to it would let two threads write over each
    /// other's files, and would put the agent somewhere the user's worktree
    /// isn't — writes would silently land outside the branch they belong to.
    /// A git-backed run stays under its own handle or it doesn't run at all.
    pub fn workdir_for(&self, cfg: &GitSandboxConfig) -> PathBuf {
        // An unscopeable clone URL is not a git-backed sandbox; fall back to
        // the global repo dir exactly as a config with no repository does.
        let Some(handle) = Self::compute_handle(&cfg.clone_url, normalized_branch(cfg)) else {
            return self.app_root.join("repo");
        };
        self.app_root
            .join(crate::sandbox::WORKTREES_DIR)
            .join(handle)
            .join("repo")
    }

    /// Looks up an already-created sandbox by handle — used by
    /// `routes/proxy.rs` to resolve the sniffed dev port for a specific
    /// handle. Returns `None` for a handle never `ensure()`-d (never
    /// creates one — that's `ensure()`'s job).
    pub fn get(&self, handle: &str) -> Option<Arc<Sandbox>> {
        self.lock_sandboxes().get(handle).cloned()
    }

    /// Stable `Arc` snapshot used by shutdown. No manager lock is held while
    /// child processes are signaled or awaited.
    pub fn snapshot(&self) -> Vec<Arc<Sandbox>> {
        self.lock_sandboxes().values().cloned().collect()
    }

    pub fn is_closing(&self) -> bool {
        self.closing.load(Ordering::SeqCst)
    }

    /// Synchronous first phase of shutdown: permanently rejects creation and
    /// closes every setup queue before any asynchronous reap begins. Repeated
    /// calls are harmless; `shutdown_all` invokes it too so standalone callers
    /// cannot forget the admission fence.
    pub fn begin_shutdown(&self) {
        self.closing.store(true, Ordering::SeqCst);
        for sandbox in self.snapshot() {
            sandbox.setup.close();
        }
    }

    /// Permanently closes sandbox creation/setup admission, synchronously
    /// closes every known orchestrator, then shuts all of them down concurrently
    /// under shared TERM/KILL grace periods.
    pub async fn shutdown_all(
        &self,
        term_grace: Duration,
        kill_grace: Duration,
    ) -> Vec<SandboxShutdownResult> {
        self.begin_shutdown();
        let sandboxes = self.snapshot();
        join_all(sandboxes.into_iter().map(|sandbox| async move {
            let result = sandbox.setup.shutdown(term_grace, kill_grace).await;
            SandboxShutdownResult {
                handle: sandbox.handle.clone(),
                result,
            }
        }))
        .await
    }

    /// Resolves `handle`, resurrecting it from its persisted
    /// [`GitSandboxConfig`] sidecar (see the `persist` module doc) when it
    /// isn't currently known in memory — the common case after a backend
    /// process restart (a dev-loop rebuild, or the desktop app relaunching):
    /// the in-memory `sandboxes` map above starts empty every boot, but the
    /// workdir + sidecar survive on disk.
    ///
    /// - `Ok(Some(sandbox))` — already known, or successfully resurrected via
    ///   a fresh [`Self::ensure`] call against the persisted config (which
    ///   re-runs the safe `checkout_existing` path against the already-cloned
    ///   workdir — see `setup::clone::run`'s own doc comment — and, since a
    ///   restarted process always starts with a fresh, unconfigured
    ///   `ConfigStore`, unconditionally re-drives the install -> start
    ///   cascade too).
    /// - `Ok(None)` — genuinely unknown: no sidecar was ever written for this
    ///   handle. A real caller/state bug, not a resurrection candidate.
    /// - `Err(_)` — a sidecar exists but resurrection itself failed (e.g. the
    ///   workdir's git remote is no longer reachable) — distinct from
    ///   `Ok(None)` so a caller can surface a more specific error than
    ///   "unknown handle".
    pub async fn resurrect(self: &Arc<Self>, handle: &str) -> Result<Option<Arc<Sandbox>>, String> {
        if let Some(sandbox) = self.get(handle) {
            return Ok(Some(sandbox));
        }
        let cfg = match self.registry.record(handle)? {
            Some(record) => record.config,
            None => match super::persist::read_sidecar(&self.app_root, handle) {
                Some(config) => config,
                None => return Ok(None),
            },
        };
        let sandbox = self.provision(&cfg).await?;
        tracing::info!(
            handle = %handle,
            "sandbox resurrected from its persisted config (in-memory state was lost, likely a backend restart)"
        );
        Ok(Some(sandbox))
    }

    /// Headerless counterpart of [`Self::resurrect`]: consults the persisted
    /// "last active handle" pointer (survives a restart even though the
    /// in-memory `active_handle` field above doesn't — see [`Self::active`])
    /// and resurrects THAT handle. `Ok(None)` when nothing was ever
    /// persisted — a genuinely fresh process, or one that only ever used the
    /// plain non-git path.
    pub async fn resurrect_active(self: &Arc<Self>) -> Result<Option<Arc<Sandbox>>, String> {
        if let Some(sandbox) = self.active() {
            return Ok(Some(sandbox));
        }
        let handle = self
            .registry
            .active_handle()?
            .or_else(|| super::persist::read_active_handle(&self.app_root));
        let Some(handle) = handle else {
            return Ok(None);
        };
        self.resurrect(&handle).await
    }

    /// Materialize only the in-process routing objects for a persisted
    /// sandbox. Unlike [`Self::resurrect`], this never clones, installs, or
    /// starts anything. Observability uses it after a backend restart so an
    /// explicit `events?handle=...` can replay retained files before the user
    /// chooses to resume the sandbox.
    pub async fn adopt(&self, handle: &str) -> Result<Option<Arc<Sandbox>>, String> {
        if let Some(sandbox) = self.get(handle) {
            return Ok(Some(sandbox));
        }
        let Some(record) = self.registry.record(handle)? else {
            return Ok(None);
        };
        let handle_lock = self.handle_lock(handle);
        let _permit = handle_lock.lock().await;
        if let Some(sandbox) = self.get(handle) {
            return Ok(Some(sandbox));
        }
        let sandbox = self.get_or_create_locked(handle)?;
        let branch = normalized_branch(&record.config).to_string();
        if let Err(error) = self.apply_config(&sandbox, &record.config, &branch) {
            self.lock_sandboxes().remove(handle);
            return Err(error);
        }
        Self::monitor_branch_status(&sandbox);
        self.publish_generation(handle, Some(sandbox.clone()));
        tracing::info!(
            handle,
            "adopted persisted sandbox metadata without starting it"
        );
        Ok(Some(sandbox))
    }

    /// Metadata-only counterpart of [`Self::resurrect_active`].
    pub async fn adopt_active(&self) -> Result<Option<Arc<Sandbox>>, String> {
        if let Some(sandbox) = self.active() {
            return Ok(Some(sandbox));
        }
        let Some(handle) = self.registry.active_handle()? else {
            return Ok(None);
        };
        self.adopt(&handle).await
    }

    /// Stop fence for a durable sandbox generation. Closing the current
    /// orchestrator before signaling its setup/dev children guarantees an
    /// in-flight install cannot cascade into Start after Stop returned. The
    /// live object is evicted; a later `ensure`/Start creates a fresh
    /// orchestrator from the durable config, which is the next generation.
    ///
    /// `Ok(None)` means the handle is truly unknown. A registered handle with
    /// no live object is already stopped and returns `Ok(Some(0))` without
    /// materializing it.
    pub async fn stop_registered(&self, handle: &str) -> Result<Option<usize>, String> {
        if !self.registry.contains(handle)? {
            return Ok(None);
        }
        let handle_lock = self.handle_lock(handle);
        let _permit = handle_lock.lock().await;
        let Some(sandbox) = self.get(handle) else {
            let record = self
                .registry
                .record(handle)?
                .ok_or_else(|| format!("unknown sandbox handle: {handle}"))?;
            let observed = if record.sandbox_path.is_dir() {
                "stopped"
            } else {
                "absent"
            };
            self.registry
                .mark_state(handle, "stopped", observed, record.error.as_deref())?;
            return Ok(Some(0));
        };

        // The close flag is the generation fence checked between every
        // clone/install/start cascade step. Set it before signaling children.
        sandbox.setup.close();
        let task_ids: Vec<String> = sandbox
            .tasks
            .list(Some(&[TaskStatus::Running]))
            .into_iter()
            .filter(|task| {
                matches!(
                    task.log_name.as_deref(),
                    Some("setup") | Some("dev") | Some("start")
                )
            })
            .map(|task| task.id)
            .collect();
        let killed = match terminate_task_ids(&sandbox.tasks, &task_ids).await {
            Ok(killed) => killed,
            Err(message) => {
                self.registry
                    .mark_state(handle, "stopped", "failed", Some(&message))?;
                return Err(message);
            }
        };
        sandbox
            .setup
            .transition_lifecycle(json!({ "phase": "idle" }));
        self.lock_sandboxes().remove(handle);
        self.publish_generation(handle, None);
        self.registry
            .mark_state(handle, "stopped", "stopped", None)?;
        Ok(Some(killed))
    }

    /// Restart one live registered generation without closing it. The old
    /// dev process is fully reaped under the per-handle lock before Start is
    /// admitted, preventing old/new servers from racing for the same port.
    pub async fn restart_registered(&self, handle: &str) -> Result<Option<usize>, String> {
        if !self.registry.contains(handle)? {
            return Ok(None);
        }
        let handle_lock = self.handle_lock(handle);
        let _permit = handle_lock.lock().await;
        let Some(sandbox) = self.get(handle) else {
            return Ok(None);
        };
        let task_ids: Vec<String> = sandbox
            .tasks
            .list(Some(&[TaskStatus::Running]))
            .into_iter()
            .filter(|task| matches!(task.log_name.as_deref(), Some("dev") | Some("start")))
            .map(|task| task.id)
            .collect();
        let killed = terminate_task_ids(&sandbox.tasks, &task_ids).await?;
        if !sandbox.setup.resume_from(Step::Start) {
            return Err("setup worker is unavailable".to_string());
        }
        self.registry
            .mark_state(handle, "running", "starting", None)?;
        self.registry
            .mark_observed(handle, "starting", None, Some("start"))?;
        Ok(Some(killed))
    }

    /// UI control-plane entry point. It durably registers and activates the
    /// sandbox, then returns as soon as the serialized setup worker accepts
    /// the appropriate step. Unlike [`Self::ensure`], it does not await git:
    /// the caller can connect `events?handle=...` immediately and watch clone
    /// output live, and Stop can fence/cancel that generation while clone or
    /// install is still running.
    pub async fn provision(
        self: &Arc<Self>,
        cfg: &GitSandboxConfig,
    ) -> Result<Arc<Sandbox>, String> {
        if self.is_closing() {
            return Err("sandbox manager is shutting down".to_string());
        }
        let branch = normalized_branch(cfg).to_string();
        let handle = Self::compute_handle(&cfg.clone_url, &branch)
            .ok_or_else(|| format!("clone URL cannot be scoped: {}", cfg.clone_url))?;
        let handle_lock = self.handle_lock(&handle);
        let _permit = handle_lock.lock().await;
        if self.is_closing() {
            return Err("sandbox manager is shutting down".to_string());
        }

        let was_known = self.get(&handle).is_some();
        let previous_record = self.registry.record(&handle)?;
        let canonical_config = merge_durable_config(cfg, previous_record.as_ref())?;
        let sandbox = self.get_or_create_locked(&handle)?;
        let was_running = dev_task_running(&sandbox);
        let pipeline_in_flight = sandbox.setup.is_running() || sandbox.setup.pending_count() > 0;
        let transition = match self.apply_config(&sandbox, &canonical_config, &branch) {
            Ok(transition) => transition,
            Err(error) => {
                if !was_known {
                    self.lock_sandboxes().remove(&handle);
                }
                return Err(error);
            }
        };
        let sandbox_path = self
            .app_root
            .join(crate::sandbox::WORKTREES_DIR)
            .join(&handle);
        self.registry
            .upsert_config(&handle, &canonical_config, &sandbox_path, &sandbox.workdir)?;
        // The sandbox's view onto the shared org filesystem. Best-effort by
        // design (see `org_view`): a sandbox whose view cannot be built still
        // runs, the agent simply has no org files — the same outcome as a
        // mount that is down.
        if let Some(org_slug) = canonical_config.org_slug.as_deref() {
            self.ensure_org_filesystem(&sandbox, &handle, org_slug)
                .await;
        }
        self.set_active(&handle)?;
        super::persist::write_sidecar(&self.app_root, &handle, &canonical_config);
        self.publish_generation(&handle, Some(sandbox.clone()));
        Self::monitor_branch_status(&sandbox);

        if transition == "no-op" && (was_running || pipeline_in_flight) {
            if sandbox.broadcaster.subscriber_count() > 0 {
                crate::routes::git::emit_branch_event(&sandbox.workdir, &sandbox.broadcaster).await;
            }
            let observed = previous_record
                .as_ref()
                .map(|record| record.observed_status.as_str())
                .unwrap_or(if was_running {
                    "starting"
                } else {
                    "provisioning"
                });
            let error = previous_record
                .as_ref()
                .and_then(|record| record.error.as_deref());
            self.registry
                .mark_state(&handle, "running", observed, error)?;
            return Ok(sandbox);
        }

        self.monitor_registry_lifecycle(&sandbox);

        // A durable, already-checked-out worktree needs only its dev process
        // after an app/manager restart. Runtime/package-manager changes still
        // reinstall; a genuinely new workdir runs the full clone cascade.
        // A fresh process has an empty ConfigStore, so `apply_config` reports
        // `bootstrap` even when the durable workload changed since the prior
        // run. Compare with SQLite as well: a runtime/package-manager/path
        // change must resume at Install, never reuse the old installation and
        // jump straight to Start.
        let durable_workload_changed = previous_record
            .as_ref()
            .is_some_and(|record| workload_differs(&record.config, &canonical_config));
        let runtime_changed = matches!(transition.as_str(), "runtime-change" | "pm-change")
            || durable_workload_changed;
        let repo_valid = if pipeline_in_flight && runtime_changed {
            // The serialized current generation will finish acquiring the
            // repo before it reaches this subsequently queued install.
            true
        } else {
            crate::routes::git::is_git_repo(&sandbox.workdir).await
        };
        if !repo_valid {
            // A cancelled git clone can leave `.git` and object files behind
            // without being a usable repository. `git clone <url> <dir>`
            // refuses that non-empty destination, so clear only this managed
            // workdir before retrying the full Clone step.
            if sandbox.workdir.exists() {
                tokio::fs::remove_dir_all(&sandbox.workdir)
                    .await
                    .map_err(|error| {
                        format!(
                            "failed to clear invalid sandbox workdir {:?}: {error}",
                            sandbox.workdir
                        )
                    })?;
                // This workdir is a worktree of the shared canonical repo (see
                // `sandbox::repo_store`), which still lists it after the
                // directory is gone — and git refuses to re-add a worktree at a
                // path it already knows. Prune so the Clone step below can
                // re-create it.
                super::repo_store::prune_worktrees(&self.app_root, &canonical_config.clone_url)
                    .await;
            }
            tokio::fs::create_dir_all(&sandbox.workdir)
                .await
                .map_err(|error| {
                    format!(
                        "failed to recreate sandbox workdir {:?}: {error}",
                        sandbox.workdir
                    )
                })?;
        }
        let resume_step = previous_record
            .as_ref()
            .map(|record| record.resume_step.as_str())
            .unwrap_or("clone");
        let step = if !repo_valid {
            Step::Clone
        } else if runtime_changed {
            Step::Install
        } else {
            match resume_step {
                "clone" => Step::Clone,
                "install" => Step::Install,
                _ => Step::Start,
            }
        };
        if repo_valid && sandbox.broadcaster.subscriber_count() > 0 {
            crate::routes::git::emit_branch_event(&sandbox.workdir, &sandbox.broadcaster).await;
        }
        if !sandbox.setup.resume_from(step) {
            let message = format!("setup worker rejected the {} step", step.as_str());
            let _ = self
                .registry
                .mark_state(&handle, "running", "failed", Some(&message));
            return Err(format!("sandbox {handle} {message}"));
        }
        let observed = if step == Step::Start {
            "starting"
        } else {
            "provisioning"
        };
        self.registry
            .mark_state(&handle, "running", observed, None)?;
        self.registry
            .mark_observed(&handle, observed, None, Some(step.as_str()))?;
        Ok(sandbox)
    }

    fn monitor_registry_lifecycle(self: &Arc<Self>, sandbox: &Arc<Sandbox>) {
        if sandbox
            .registry_monitor_started
            .swap(true, Ordering::SeqCst)
        {
            return;
        }
        let mut receiver = sandbox.broadcaster.subscribe();
        let manager = Arc::downgrade(self);
        let sandbox_generation = Arc::downgrade(sandbox);
        let handle = sandbox.handle.clone();
        tokio::spawn(async move {
            loop {
                let event = match receiver.recv().await {
                    Ok(event) => event,
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => return,
                };
                if event.name != "lifecycle" {
                    continue;
                }
                let Some(state) = event.data.get("state") else {
                    continue;
                };
                let Some(phase) = state.get("phase").and_then(Value::as_str) else {
                    continue;
                };
                let (observed, error, resume_step) = match phase {
                    "running" => ("running", None, Some("start")),
                    "starting" => ("starting", None, Some("start")),
                    "cloning" | "checking-out" => ("provisioning", None, Some("clone")),
                    "installing" => ("provisioning", None, Some("install")),
                    "clone-failed" => (
                        "failed",
                        state.get("error").and_then(Value::as_str),
                        Some("clone"),
                    ),
                    "install-failed" => (
                        "failed",
                        state.get("error").and_then(Value::as_str),
                        Some("install"),
                    ),
                    "start-failed" => (
                        "failed",
                        state.get("error").and_then(Value::as_str),
                        Some("start"),
                    ),
                    "idle" => ("stopped", None, None),
                    _ => continue,
                };
                let Some(manager) = manager.upgrade() else {
                    return;
                };
                let Some(generation) = sandbox_generation.upgrade() else {
                    return;
                };
                let Some(current) = manager.get(&handle) else {
                    return;
                };
                if !Arc::ptr_eq(&generation, &current) {
                    return;
                }
                if let Err(error) =
                    manager
                        .registry
                        .mark_observed(&handle, observed, error, resume_step)
                {
                    tracing::warn!(handle, %error, "failed to persist sandbox lifecycle observation");
                }
            }
        });
    }

    /// Idempotent, concurrency-safe: (re-)applies `cfg` to whichever
    /// [`Sandbox`] `(cfg.virtual_mcp_id, cfg.branch)` resolves to — creating
    /// its workdir + orchestrator quadruple on first use — then
    /// acquires or repairs the configured checkout before returning. An
    /// unchanged live sandbox uses a single branch probe; creation, config
    /// changes, and drift use the full clone/checkout path. Install + start
    /// continue asynchronously on the sandbox's own orchestrator worker — a
    /// dev server can take much longer to boot than a caller dispatching a
    /// harness run should have to wait.
    pub async fn ensure(self: &Arc<Self>, cfg: &GitSandboxConfig) -> Result<Arc<Sandbox>, String> {
        let sandbox = self.ensure_inner(cfg, std::future::ready(())).await?;
        self.monitor_registry_lifecycle(&sandbox);
        Self::monitor_branch_status(&sandbox);
        Ok(sandbox)
    }

    /// Implementation seam used by the concurrency regression test to pause a
    /// caller immediately AFTER it acquires the per-handle operation lock. In
    /// production `ensure()` passes a ready future, so this adds no behavior;
    /// the seam lets the test prove the second caller cannot enter until the
    /// first has completed the whole git/config operation (rather than merely
    /// waiting for the `Sandbox` map insertion).
    async fn ensure_inner<F>(
        &self,
        cfg: &GitSandboxConfig,
        after_lock: F,
    ) -> Result<Arc<Sandbox>, String>
    where
        F: std::future::Future<Output = ()>,
    {
        if self.is_closing() {
            return Err("sandbox manager is shutting down".to_string());
        }
        let branch = normalized_branch(cfg).to_string();
        let handle = Self::compute_handle(&cfg.clone_url, &branch)
            .ok_or_else(|| format!("clone URL cannot be scoped: {}", cfg.clone_url))?;

        // Serialize the ENTIRE ensure operation for one handle. The previous
        // implementation released this lock immediately after inserting the
        // shared `Sandbox` Arc, which still let both callers race
        // `clone::run()` against the same not-yet-created `.git` directory.
        // That produced intermittent successful `ensure()` results backed by
        // a missing/half-created worktree under the full parallel test suite.
        let handle_lock = self.handle_lock(&handle);
        let _permit = handle_lock.lock().await;
        after_lock.await;

        if self.is_closing() {
            return Err("sandbox manager is shutting down".to_string());
        }

        let previous_record = self.registry.record(&handle)?;
        let canonical_config = merge_durable_config(cfg, previous_record.as_ref())?;
        let sandbox = self.get_or_create_locked(&handle)?;
        let transition = self.apply_config(&sandbox, &canonical_config, &branch)?;
        let sandbox_path = self
            .app_root
            .join(crate::sandbox::WORKTREES_DIR)
            .join(&handle);
        self.registry
            .upsert_config(&handle, &canonical_config, &sandbox_path, &sandbox.workdir)?;
        // The sandbox's view onto the shared org filesystem. Best-effort by
        // design (see `org_view`): a sandbox whose view cannot be built still
        // runs, the agent simply has no org files — the same outcome as a
        // mount that is down.
        if let Some(org_slug) = canonical_config.org_slug.as_deref() {
            self.ensure_org_filesystem(&sandbox, &handle, org_slug)
                .await;
        }
        // This dispatch's sandbox becomes the headerless-preview target only
        // after its complete identity is durably registered.
        self.set_active(&handle)?;
        // Persist the exact config that got this handle here — see the
        // `persist` module doc: `compute_handle` is a one-way hash, so this
        // sidecar is the only way a LATER process (a restarted one that
        // forgot this handle's in-memory `Sandbox`) can `ensure()` it again
        // via [`Self::resurrect`]. Written only after `apply_config` above
        // succeeded, so a rejected/invalid patch never persists a bogus
        // sidecar.
        super::persist::write_sidecar(&self.app_root, &handle, &canonical_config);
        self.publish_generation(&handle, Some(sandbox.clone()));

        // Repeated dispatches dominate this path. For an unchanged live
        // sandbox, one branch probe preserves the checkout guarantee; the
        // full clone/checkout path is reserved for creation, config changes,
        // or a managed workdir that drifted.
        let git_started = Instant::now();
        let (clone_ok, git_path) = match sandbox.setup.current_config() {
            Some(config)
                if transition == "no-op"
                    && crate::setup::clone::checkout_is_current(&sandbox.setup, &config).await =>
            {
                (true, "current-checkout")
            }
            Some(config) => {
                let repaired = crate::setup::clone::run(&sandbox.setup, &config).await;
                let verified = repaired
                    && crate::setup::clone::checkout_is_current(&sandbox.setup, &config).await;
                (verified, "clone-or-checkout")
            }
            None => (true, "no-repository"),
        };
        tracing::info!(
            handle = %handle,
            transition = %transition,
            clone_ok,
            git_path,
            git_elapsed_ms = git_started.elapsed().as_millis(),
            "sandbox ensure: repository ready"
        );
        if !clone_ok {
            let message = "git clone/checkout failed; inspect the setup log";
            let _ = self
                .registry
                .mark_state(&handle, "running", "failed", Some(message));
            let _ = self
                .registry
                .mark_observed(&handle, "failed", Some(message), Some("clone"));
            return Err(format!("sandbox {handle}: {message}"));
        }
        if git_path == "current-checkout" && sandbox.broadcaster.subscriber_count() > 0 {
            crate::routes::git::emit_branch_event(&sandbox.workdir, &sandbox.broadcaster).await;
        }

        if transition != "no-op" {
            // Config changed (first use of this sandbox, or repo/runtime
            // changed) → run the full install → start cascade.
            if !sandbox.setup.resume_from(Step::Install) {
                let message = "setup worker rejected the install/start cascade";
                let _ = self
                    .registry
                    .mark_state(&handle, "running", "failed", Some(message));
                return Err(format!("sandbox {handle} {message}"));
            }
            self.registry
                .mark_state(&handle, "running", "provisioning", None)?;
            self.registry
                .mark_observed(&handle, "provisioning", None, Some("install"))?;
        } else if !dev_task_running(&sandbox) {
            // Config unchanged AND no dev server is running for this
            // sandbox — e.g. a FRESH app process (the previous launch's
            // dev child died with it while the worktree persisted on
            // disk), or the dev server crashed. Bring it back up WITHOUT
            // re-cloning/re-installing (Start only), so the preview isn't
            // stuck on "starting…" forever. Without this, a no-op clone
            // skipped the cascade entirely and the dev server never came
            // back after a relaunch.
            tracing::info!(
                handle = %handle,
                "sandbox ensure: no-op config but no dev server running → resume_from(Start)"
            );
            if !sandbox.setup.resume_from(Step::Start) {
                let message = "setup worker rejected the dev-server restart";
                let _ = self
                    .registry
                    .mark_state(&handle, "running", "failed", Some(message));
                return Err(format!("sandbox {handle} {message}"));
            }
            self.registry
                .mark_state(&handle, "running", "starting", None)?;
            self.registry
                .mark_observed(&handle, "starting", None, Some("start"))?;
        } else {
            self.registry
                .mark_state(&handle, "running", "running", None)?;
            self.registry
                .mark_observed(&handle, "running", None, Some("start"))?;
        }

        Ok(sandbox)
    }

    /// Returns the existing sandbox or constructs it. The caller MUST hold the
    /// corresponding [`Self::handle_lock`] permit; keeping this helper
    /// synchronous makes it impossible to accidentally suspend while a
    /// partially-built value is being inserted.
    fn get_or_create_locked(&self, handle: &str) -> Result<Arc<Sandbox>, String> {
        // One lock acquisition linearizes close-vs-create: if shutdown sets
        // `closing` while an ensure already holds this guard, its insertion is
        // visible to shutdown's later snapshot; if shutdown wins first, no new
        // sandbox can appear behind that snapshot.
        let mut sandboxes = self.lock_sandboxes();
        if self.is_closing() {
            return Err("sandbox manager is shutting down".to_string());
        }
        if let Some(sandbox) = sandboxes.get(handle) {
            return Ok(sandbox.clone());
        }

        let sandbox_root = self
            .app_root
            .join(crate::sandbox::WORKTREES_DIR)
            .join(handle);
        let workdir = sandbox_root.join("repo");
        std::fs::create_dir_all(&workdir)
            .map_err(|e| format!("failed to create sandbox workdir {workdir:?}: {e}"))?;

        let config = Arc::new(ConfigStore::new());
        // `<app_root>/worktrees/<handle>/logs` — a sibling of `repo` above,
        // this handle's OWN durable log home (see the `log_store` module doc).
        // Isolated per handle so two branches of the same repo never share
        // (or race) a "setup"/"dev" transcript.
        let logs = Arc::new(LogStore::new(sandbox_root.join("logs")));
        let tasks = Arc::new(TaskRegistry::new_with_child_lifetime_lock(
            logs,
            self.app_root.join(".decocms").join("child-lifetime.lock"),
        ));
        let broadcaster = Arc::new(Broadcaster::new());
        let setup = SetupOrchestrator::new(
            workdir.clone(),
            self.app_root.clone(),
            config.clone(),
            tasks.clone(),
            broadcaster.clone(),
        );
        let sandbox = Arc::new(Sandbox {
            handle: handle.to_string(),
            workdir,
            config,
            tasks,
            broadcaster,
            setup,
            registry_monitor_started: AtomicBool::new(false),
            branch_monitor_started: AtomicBool::new(false),
        });
        sandboxes.insert(handle.to_string(), sandbox.clone());
        Ok(sandbox)
    }

    /// Keep branch metadata live while this sandbox has an SSE observer.
    ///
    /// The old Bun daemon combined recursive filesystem watches with a
    /// three-second poll fallback. Native uses only the bounded fallback:
    /// one weak-reference task per materialized sandbox, no retained output
    /// buffer, and no Git work while nobody subscribes. The first observed
    /// snapshot is emitted deliberately even though the events handshake also
    /// recomputes one; doing so closes the race where a worktree edit lands
    /// between handshake computation and the poller's first baseline.
    fn monitor_branch_status(sandbox: &Arc<Sandbox>) {
        if sandbox.branch_monitor_started.swap(true, Ordering::SeqCst) {
            return;
        }

        let sandbox = Arc::downgrade(sandbox);
        tokio::spawn(async move {
            let mut poll = tokio::time::interval(BRANCH_STATUS_POLL_INTERVAL);
            poll.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            let mut last = None;

            loop {
                poll.tick().await;
                let Some(sandbox) = sandbox.upgrade() else {
                    return;
                };
                if sandbox.broadcaster.subscriber_count() == 0 {
                    last = None;
                    continue;
                }

                let next = crate::routes::git::branch_snapshot(&sandbox.workdir).await;
                if next == last {
                    continue;
                }
                if let Some(meta) = next.as_ref() {
                    sandbox.broadcaster.emit("branch", json!({ "meta": meta }));
                }
                last = next;
            }
        });
    }

    fn handle_lock(&self, handle: &str) -> Arc<tokio::sync::Mutex<()>> {
        let mut guard = self.lock_locks();
        guard
            .entry(handle.to_string())
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone()
    }

    /// Builds and applies the `TenantConfig` patch for `cfg`/`branch`,
    /// returning the resulting transition kind. Only fields `cfg` actually
    /// carries are included in the patch — `ConfigStore::patch`'s deep-merge
    /// leaves any field a LATER, less-complete `ensure()` call omits
    /// untouched (see `config/merge.rs`'s "field absent -> leave existing"
    /// semantics), so a repeat dispatch that doesn't repeat the workload
    /// hint never erases a runtime/packageManager set by an earlier one.
    fn apply_config(
        &self,
        sandbox: &Sandbox,
        cfg: &GitSandboxConfig,
        branch: &str,
    ) -> Result<String, String> {
        let mut repository = Map::new();
        repository.insert("cloneUrl".to_string(), json!(cfg.clone_url));
        repository.insert("branch".to_string(), json!(branch));
        let mut git = Map::new();
        git.insert("repository".to_string(), Value::Object(repository));
        // `validate_git` rejects an `identity` object missing EITHER field —
        // only attach it when both are present so an incomplete hint never
        // 400s the whole patch.
        if let (Some(name), Some(email)) = (&cfg.git_user_name, &cfg.git_user_email) {
            if !name.is_empty() && !email.is_empty() {
                git.insert(
                    "identity".to_string(),
                    json!({ "userName": name, "userEmail": email }),
                );
            }
        }

        let mut application = Map::new();
        if let Some(runtime) = &cfg.runtime {
            if !runtime.is_empty() {
                application.insert("runtime".to_string(), json!(runtime));
            }
        }
        let mut package_manager = Map::new();
        if let Some(pm) = &cfg.package_manager {
            if !pm.is_empty() {
                package_manager.insert("name".to_string(), json!(pm));
            }
        }
        if let Some(path) = &cfg.package_manager_path {
            if !path.is_empty() {
                package_manager.insert("path".to_string(), json!(path));
            }
        }
        if !package_manager.is_empty() {
            application.insert("packageManager".to_string(), Value::Object(package_manager));
        }

        let mut patch = Map::new();
        patch.insert("git".to_string(), Value::Object(git));
        if !application.is_empty() {
            patch.insert("application".to_string(), Value::Object(application));
        }

        let outcome = sandbox
            .config
            .patch(Value::Object(patch))
            .map_err(|e| format!("sandbox config rejected: {}", e.body))?;
        Ok(outcome.transition.to_string())
    }

    fn lock_sandboxes(&self) -> std::sync::MutexGuard<'_, HashMap<String, Arc<Sandbox>>> {
        match self.sandboxes.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    fn lock_locks(
        &self,
    ) -> std::sync::MutexGuard<'_, HashMap<String, Arc<tokio::sync::Mutex<()>>>> {
        match self.locks.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        }
    }
}

async fn wait_tasks_terminal(tasks: &TaskRegistry, ids: &[String]) {
    loop {
        if ids.iter().all(|id| {
            tasks
                .get(id)
                .is_none_or(|task| task.status != TaskStatus::Running)
        }) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

const TASK_TERM_GRACE: Duration = Duration::from_secs(2);
const TASK_KILL_REAP_WARNING: Duration = Duration::from_secs(2);
/// Final bounded wait after KILL. This is deliberately much longer than the
/// diagnostic threshold: a real Next/Bun process tree was observed publishing
/// its terminal proof just after the old two-second deadline, causing a false
/// 409 followed by an immediately-successful retry. The per-handle lock stays
/// held for this entire budget, so the new server is never admitted early.
const TASK_KILL_REAP_DEADLINE: Duration = Duration::from_secs(15);

async fn terminate_task_ids(tasks: &TaskRegistry, ids: &[String]) -> Result<usize, String> {
    terminate_task_ids_with_timings(
        tasks,
        ids,
        TASK_TERM_GRACE,
        TASK_KILL_REAP_WARNING,
        TASK_KILL_REAP_DEADLINE,
    )
    .await
}

async fn terminate_task_ids_with_timings(
    tasks: &TaskRegistry,
    ids: &[String],
    term_grace: Duration,
    kill_reap_warning: Duration,
    kill_reap_deadline: Duration,
) -> Result<usize, String> {
    let mut killed = 0usize;
    for task_id in ids {
        if tasks.kill(task_id, KillSignal::Term) == Some(true) {
            killed += 1;
        }
    }
    if tokio::time::timeout(term_grace, wait_tasks_terminal(tasks, ids))
        .await
        .is_err()
    {
        let mut unsignalable = Vec::new();
        for task_id in ids {
            if tasks
                .get(task_id)
                .is_some_and(|task| task.status == TaskStatus::Running)
            {
                let signaled = tasks.kill(task_id, KillSignal::Kill) == Some(true);
                if !signaled
                    && tasks
                        .get(task_id)
                        .is_some_and(|task| task.status == TaskStatus::Running)
                {
                    unsignalable.push(task_id.clone());
                }
            }
        }
        if !unsignalable.is_empty() {
            return Err(format!(
                "could not signal process task(s): {}",
                unsignalable.join(", ")
            ));
        }

        let terminal = wait_tasks_terminal(tasks, ids);
        tokio::pin!(terminal);
        let kill_started = tokio::time::Instant::now();
        let warning_after = kill_reap_warning.min(kill_reap_deadline);
        if tokio::time::timeout(warning_after, terminal.as_mut())
            .await
            .is_err()
        {
            if warning_after < kill_reap_deadline {
                tracing::warn!(
                    task_ids = ?ids,
                    "process task reap exceeded its warning threshold; retaining the restart fence"
                );
            }
            // KILL was durably accepted by each live task's ProcessController,
            // but only its detached process owner can prove the entire group
            // gone and finalize the registry entry. Keep the per-handle
            // restart lock until that proof arrives; admitting Start early
            // would race old and new servers for the same port.
            let remaining_budget = kill_reap_deadline.saturating_sub(kill_started.elapsed());
            if tokio::time::timeout(remaining_budget, terminal.as_mut())
                .await
                .is_err()
            {
                let remaining: Vec<String> = ids
                    .iter()
                    .filter(|task_id| {
                        tasks
                            .get(task_id)
                            .is_some_and(|task| task.status == TaskStatus::Running)
                    })
                    .cloned()
                    .collect();
                if remaining.is_empty() {
                    return Ok(killed);
                }
                return Err(format!(
                    "could not reap process task(s): {}",
                    remaining.join(", ")
                ));
            }
        }
    }
    Ok(killed)
}

pub(crate) async fn terminate_tasks_by_log_name(
    tasks: &TaskRegistry,
    log_names: &[&str],
) -> Result<usize, String> {
    let ids: Vec<String> = tasks
        .list(Some(&[TaskStatus::Running]))
        .into_iter()
        .filter(|task| {
            task.log_name
                .as_deref()
                .is_some_and(|name| log_names.contains(&name))
        })
        .map(|task| task.id)
        .collect();
    terminate_task_ids(tasks, &ids).await
}

/// Make the durable registry the canonical source for fields the frontend may
/// omit on a later `ensure` call. A handle intentionally identifies only a
/// virtual MCP + branch, so accepting a different repository URL for an
/// existing handle would silently retarget the worktree. Optional workload and
/// git-identity hints, on the other hand, are merged from the prior record so a
/// sparse control-plane request cannot erase them.
fn merge_durable_config(
    incoming: &GitSandboxConfig,
    previous: Option<&super::registry::SandboxRecord>,
) -> Result<GitSandboxConfig, String> {
    let Some(previous) = previous else {
        return Ok(incoming.clone());
    };
    let persisted = &previous.config;
    if persisted.virtual_mcp_id != incoming.virtual_mcp_id
        || normalized_branch(persisted) != normalized_branch(incoming)
    {
        return Err(format!(
            "sandbox {} identity does not match its durable registry record",
            previous.handle
        ));
    }
    if persisted.clone_url.trim() != incoming.clone_url.trim() {
        return Err(format!(
            "sandbox {} repository is immutable (registered {:?}, requested {:?})",
            previous.handle, persisted.clone_url, incoming.clone_url
        ));
    }

    let mut merged = incoming.clone();
    merged.clone_url = persisted.clone_url.clone();
    merged.branch = prefer_present(&incoming.branch, &persisted.branch);
    merged.org_slug = prefer_present(&incoming.org_slug, &persisted.org_slug);
    merged.runtime = prefer_present(&incoming.runtime, &persisted.runtime);
    merged.package_manager = prefer_present(&incoming.package_manager, &persisted.package_manager);
    merged.package_manager_path = prefer_present(
        &incoming.package_manager_path,
        &persisted.package_manager_path,
    );
    merged.git_user_name = prefer_present(&incoming.git_user_name, &persisted.git_user_name);
    merged.git_user_email = prefer_present(&incoming.git_user_email, &persisted.git_user_email);
    Ok(merged)
}

fn prefer_present(incoming: &Option<String>, persisted: &Option<String>) -> Option<String> {
    incoming
        .as_ref()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| persisted.as_ref().filter(|value| !value.trim().is_empty()))
        .cloned()
}

fn workload_differs(left: &GitSandboxConfig, right: &GitSandboxConfig) -> bool {
    left.runtime != right.runtime
        || left.package_manager != right.package_manager
        || left.package_manager_path != right.package_manager_path
}

fn normalized_branch(config: &GitSandboxConfig) -> &str {
    config
        .branch
        .as_deref()
        .filter(|branch| !branch.is_empty())
        .unwrap_or("main")
}

/// Lowercases, collapses any run of non-alphanumeric characters to a single
/// `-`, trims leading/trailing dashes, and caps length, so a branch name is
/// safe to use as one path segment under `<app_root>/worktrees/<repo scope>/`.
///
/// The repo scope above it is what separates two repositories; this only has
/// to keep two branches OF ONE REPO apart and stay legible to a human reading
/// the directory listing.
fn slugify_branch(branch: &str) -> String {
    const MAX_LEN: usize = 40;
    let mut out = String::with_capacity(branch.len());
    let mut last_dash = false;
    for ch in branch.chars() {
        let lower = ch.to_ascii_lowercase();
        if lower.is_ascii_alphanumeric() {
            out.push(lower);
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    let trimmed = out.trim_matches('-');
    let clipped: String = trimmed.chars().take(MAX_LEN).collect();
    let clipped = clipped.trim_end_matches('-');
    if clipped.is_empty() {
        "branch".to_string()
    } else {
        clipped.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use std::process::Command;

    fn git(dir: &Path, args: &[&str]) {
        let output = Command::new("git")
            .args(args)
            .current_dir(dir)
            .output()
            .expect("git failed to spawn");
        assert!(
            output.status.success(),
            "git {args:?} failed in {dir:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn git_stdout(dir: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .args(args)
            .current_dir(dir)
            .output()
            .expect("git failed to spawn");
        assert!(
            output.status.success(),
            "git {args:?} failed in {dir:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    /// A bare "origin" plus two branches (`main`, `feature`) each with a
    /// distinguishing `BRANCH.txt` marker file, so a test can assert which
    /// branch actually landed in a given clone.
    fn setup_two_branch_repo() -> (tempfile::TempDir, String) {
        let root = tempfile::tempdir().unwrap();
        let bare_dir = root.path().join("origin.git");
        let work_dir = root.path().join("author");
        std::fs::create_dir_all(&bare_dir).unwrap();
        std::fs::create_dir_all(&work_dir).unwrap();
        git(&bare_dir, &["init", "--bare", "-q"]);
        git(&work_dir, &["init", "-q", "-b", "main"]);
        git(&work_dir, &["config", "user.name", "Test User"]);
        git(&work_dir, &["config", "user.email", "test@example.com"]);
        std::fs::write(work_dir.join("BRANCH.txt"), "main\n").unwrap();
        git(&work_dir, &["add", "."]);
        git(&work_dir, &["commit", "-q", "-m", "initial"]);
        let bare_str = bare_dir.to_str().unwrap().to_string();
        git(&work_dir, &["remote", "add", "origin", &bare_str]);
        git(&work_dir, &["push", "-q", "-u", "origin", "main"]);
        git(&bare_dir, &["symbolic-ref", "HEAD", "refs/heads/main"]);

        git(&work_dir, &["checkout", "-q", "-b", "feature"]);
        std::fs::write(work_dir.join("BRANCH.txt"), "feature\n").unwrap();
        git(&work_dir, &["commit", "-q", "-am", "feature commit"]);
        git(&work_dir, &["push", "-q", "-u", "origin", "feature"]);

        (root, bare_str)
    }

    fn task_registry(root: &Path) -> Arc<TaskRegistry> {
        Arc::new(TaskRegistry::new(Arc::new(LogStore::new(
            root.join("logs"),
        ))))
    }

    fn running_task(
        id: &str,
        controller: Option<&crate::tasks::ProcessController>,
    ) -> crate::tasks::TaskEntry {
        crate::tasks::TaskEntry::new(
            crate::tasks::TaskSummary {
                id: id.to_string(),
                command: "bun run dev".to_string(),
                status: TaskStatus::Running,
                exit_code: None,
                started_at: 0,
                finished_at: None,
                timed_out: false,
                truncated: false,
                log_name: Some("dev".to_string()),
                intentional: None,
            },
            controller.map(crate::tasks::ProcessController::kill_handle),
        )
    }

    #[tokio::test]
    async fn restart_waits_for_terminal_proof_after_kill_warning() {
        let root = tempfile::tempdir().unwrap();
        let tasks = task_registry(root.path());
        let controller = crate::tasks::ProcessController::new();
        tasks.insert(running_task("slow-reap", Some(&controller)));

        let owner = {
            let tasks = tasks.clone();
            let controller = controller.clone();
            tokio::spawn(async move {
                assert_eq!(controller.wait_for_change(None).await, KillSignal::Term);
                assert_eq!(
                    controller.wait_for_change(Some(KillSignal::Term)).await,
                    KillSignal::Kill
                );
                // Deliberately outlive the kill warning. The warning is not a
                // correctness deadline: the task owner still holds the old
                // process-group fence and will publish the terminal proof.
                tokio::time::sleep(Duration::from_millis(50)).await;
                tasks.finalize("slow-reap", TaskStatus::Killed, 137, false);
            })
        };

        let ids = vec!["slow-reap".to_string()];
        let killed = tokio::time::timeout(
            Duration::from_secs(1),
            terminate_task_ids_with_timings(
                &tasks,
                &ids,
                Duration::from_millis(5),
                Duration::from_millis(5),
                Duration::from_millis(200),
            ),
        )
        .await
        .expect("restart waits for the owner rather than hanging")
        .expect("a late-but-successful reap is not a conflict");
        owner.await.unwrap();

        assert_eq!(killed, 1);
        assert_eq!(tasks.get("slow-reap").unwrap().status, TaskStatus::Killed);
    }

    #[tokio::test]
    async fn restart_returns_a_bounded_error_when_kill_never_reaps() {
        let root = tempfile::tempdir().unwrap();
        let tasks = task_registry(root.path());
        let controller = crate::tasks::ProcessController::new();
        tasks.insert(running_task("never-reaps", Some(&controller)));

        let owner = {
            let controller = controller.clone();
            tokio::spawn(async move {
                assert_eq!(controller.wait_for_change(None).await, KillSignal::Term);
                assert_eq!(
                    controller.wait_for_change(Some(KillSignal::Term)).await,
                    KillSignal::Kill
                );
                // Model an owner that accepted KILL but cannot prove group
                // quiescence. It deliberately leaves the task Running.
            })
        };

        let ids = vec!["never-reaps".to_string()];
        let error = tokio::time::timeout(
            Duration::from_secs(1),
            terminate_task_ids_with_timings(
                &tasks,
                &ids,
                Duration::from_millis(5),
                Duration::from_millis(5),
                Duration::from_millis(30),
            ),
        )
        .await
        .expect("the final reap deadline bounds the restart request")
        .expect_err("an unproven old process group remains a conflict");
        owner.await.unwrap();

        assert_eq!(error, "could not reap process task(s): never-reaps");
        assert_eq!(
            tasks.get("never-reaps").unwrap().status,
            TaskStatus::Running
        );
    }

    #[tokio::test]
    async fn restart_rejects_a_running_task_without_a_signal_owner() {
        let root = tempfile::tempdir().unwrap();
        let tasks = task_registry(root.path());
        tasks.insert(running_task("unowned", None));

        let ids = vec!["unowned".to_string()];
        let error = terminate_task_ids_with_timings(
            &tasks,
            &ids,
            Duration::from_millis(5),
            Duration::from_millis(5),
            Duration::from_millis(30),
        )
        .await
        .expect_err("a running task with no kill owner cannot make progress");

        assert_eq!(error, "could not signal process task(s): unowned");
        assert_eq!(tasks.get("unowned").unwrap().status, TaskStatus::Running);
    }

    #[test]
    fn compute_handle_is_the_repository_scope_and_branch() {
        let a1 = SandboxManager::compute_handle("https://github.com/acme/repo-1", "main")
            .expect("scopeable clone url");
        let a2 = SandboxManager::compute_handle("https://github.com/acme/repo-1", "main")
            .expect("scopeable clone url");
        assert_eq!(a1, a2, "same inputs must hash identically");

        let b = SandboxManager::compute_handle("https://github.com/acme/repo-1", "feature")
            .expect("scopeable clone url");
        assert_ne!(a1, b, "different branches must produce different handles");

        let c = SandboxManager::compute_handle("https://github.com/acme/repo-2", "main")
            .expect("scopeable clone url");
        assert_ne!(
            a1, c,
            "different repositories must produce different handles"
        );

        // The handle IS `<host>/<owner>/<repo>/<branch>` — that identity is
        // what lets the directory, the git branch and the UI carry one name.
        assert_eq!(a1, "github.com/acme/repo-1/main");
        assert_eq!(b, "github.com/acme/repo-1/feature");
        // A branch with a slash stays ONE segment, so the tree never nests
        // deeper than the scheme promises.
        let nested =
            SandboxManager::compute_handle("https://github.com/acme/repo-1", "feature/foo")
                .expect("scopeable clone url");
        assert_eq!(nested, "github.com/acme/repo-1/feature-foo");
        // A remote this cannot scope is not a git-backed sandbox.
        assert!(SandboxManager::compute_handle("", "main").is_none());
    }

    /// A git-backed run must resolve under its OWN handle even when `ensure`
    /// never ran, so a failed clone can never route it into the shared
    /// process-global repo dir where threads would overwrite each other.
    #[test]
    fn workdir_for_is_per_handle_and_never_the_shared_repo_dir() {
        let root = tempfile::tempdir().expect("tempdir");
        let manager = SandboxManager::new(root.path().to_path_buf());
        let config = |branch: Option<&str>| GitSandboxConfig {
            virtual_mcp_id: "vmcp-1".to_string(),
            clone_url: "https://github.com/acme/site.git".to_string(),
            branch: branch.map(str::to_string),
            ..Default::default()
        };

        let main = manager.workdir_for(&config(Some("main")));
        assert!(
            main.starts_with(root.path().join(crate::sandbox::WORKTREES_DIR))
                && main.ends_with("repo"),
            "expected <app_root>/worktrees/<handle>/repo, got {main:?}"
        );
        // The shared dir every non-git-backed run uses — see `lib.rs`.
        assert_ne!(main, root.path().join("repo"));

        // Same handle inputs agree with `ensure`'s own derivation, including
        // the `None`/empty -> "main" default, so the fallback lands exactly
        // where a later successful ensure will put the checkout.
        assert_eq!(main, manager.workdir_for(&config(None)));
        assert_eq!(main, manager.workdir_for(&config(Some(""))));
        // The handle is now a multi-segment path (`<host>/<owner>/<repo>/<branch>`),
        // so the worktree lives at `<app_root>/worktrees/<handle>/repo`.
        let handle = SandboxManager::compute_handle("https://github.com/acme/site.git", "main")
            .expect("scopeable clone url");
        assert!(
            main.ends_with(std::path::Path::new(&handle).join("repo")),
            "{main:?} should end with {handle}/repo"
        );
        // Two branches of one agent must not share a directory.
        assert_ne!(main, manager.workdir_for(&config(Some("feature"))));
    }

    #[test]
    fn slugify_branch_collapses_unsafe_characters() {
        assert_eq!(slugify_branch("feature/foo_bar"), "feature-foo-bar");
        assert_eq!(slugify_branch("MAIN"), "main");
        assert_eq!(slugify_branch("---"), "branch");
        assert_eq!(slugify_branch(""), "branch");
    }

    #[tokio::test]
    async fn generation_watch_is_scoped_to_one_handle_and_survives_replacement() {
        let app_root = tempfile::tempdir().unwrap();
        let manager = SandboxManager::new(app_root.path().to_path_buf());
        let mut watched = manager.watch_generation("sandbox-a");

        let first = {
            let lock = manager.handle_lock("sandbox-a");
            let _permit = lock.lock().await;
            manager.get_or_create_locked("sandbox-a").unwrap()
        };
        manager.publish_generation("sandbox-a", Some(first.clone()));
        watched.changed().await.unwrap();
        assert!(Arc::ptr_eq(
            watched.borrow_and_update().as_ref().unwrap(),
            &first
        ));

        // Unrelated focus/generation traffic cannot consume or retarget A's
        // notification channel.
        let other = {
            let lock = manager.handle_lock("sandbox-b");
            let _permit = lock.lock().await;
            manager.get_or_create_locked("sandbox-b").unwrap()
        };
        manager.publish_generation("sandbox-b", Some(other));
        assert!(
            tokio::time::timeout(Duration::from_millis(25), watched.changed())
                .await
                .is_err()
        );

        manager.lock_sandboxes().remove("sandbox-a");
        manager.publish_generation("sandbox-a", None);
        watched.changed().await.unwrap();
        assert!(watched.borrow_and_update().is_none());

        let replacement = {
            let lock = manager.handle_lock("sandbox-a");
            let _permit = lock.lock().await;
            manager.get_or_create_locked("sandbox-a").unwrap()
        };
        manager.publish_generation("sandbox-a", Some(replacement.clone()));
        watched.changed().await.unwrap();
        assert!(Arc::ptr_eq(
            watched.borrow_and_update().as_ref().unwrap(),
            &replacement
        ));
        assert!(!Arc::ptr_eq(&first, &replacement));
    }

    #[tokio::test]
    async fn ensure_clones_two_branches_into_independent_directories() {
        let (_root, clone_url) = setup_two_branch_repo();
        let app_root = tempfile::tempdir().unwrap();
        let manager = SandboxManager::new(app_root.path().to_path_buf());

        let sandbox_main = manager
            .ensure(&GitSandboxConfig {
                virtual_mcp_id: "vmcp-1".to_string(),
                clone_url: clone_url.clone(),
                branch: Some("main".to_string()),
                ..Default::default()
            })
            .await
            .expect("ensure(main) succeeds");
        let sandbox_feature = manager
            .ensure(&GitSandboxConfig {
                virtual_mcp_id: "vmcp-1".to_string(),
                clone_url: clone_url.clone(),
                branch: Some("feature".to_string()),
                ..Default::default()
            })
            .await
            .expect("ensure(feature) succeeds");

        assert_ne!(
            sandbox_main.workdir, sandbox_feature.workdir,
            "different branches must land in different workdirs"
        );
        assert_eq!(
            std::fs::read_to_string(sandbox_main.workdir.join("BRANCH.txt"))
                .unwrap()
                .trim(),
            "main"
        );
        assert_eq!(
            std::fs::read_to_string(sandbox_feature.workdir.join("BRANCH.txt"))
                .unwrap()
                .trim(),
            "feature"
        );

        // Writing into the feature workdir must never touch main's.
        std::fs::write(sandbox_feature.workdir.join("only-in-feature.txt"), "x").unwrap();
        assert!(!sandbox_main.workdir.join("only-in-feature.txt").exists());
    }

    #[tokio::test]
    async fn ensure_is_idempotent_for_the_same_handle() {
        let (_root, clone_url) = setup_two_branch_repo();
        let app_root = tempfile::tempdir().unwrap();
        let manager = SandboxManager::new(app_root.path().to_path_buf());

        let cfg = GitSandboxConfig {
            virtual_mcp_id: "vmcp-1".to_string(),
            clone_url,
            branch: Some("main".to_string()),
            ..Default::default()
        };
        let first = manager.ensure(&cfg).await.expect("first ensure succeeds");
        let git_tasks_after_first = first
            .tasks
            .list(None)
            .into_iter()
            .filter(|task| task.command.starts_with("git "))
            .count();
        assert!(
            git_tasks_after_first > 0,
            "the first ensure must acquire the repository"
        );

        let mut events = first.broadcaster.subscribe();
        let second = manager.ensure(&cfg).await.expect("second ensure succeeds");
        assert!(
            Arc::ptr_eq(&first, &second),
            "repeat ensure() for the same handle must return the SAME Sandbox"
        );
        let branch = tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                let event = events
                    .recv()
                    .await
                    .expect("sandbox broadcaster remains open");
                if event.name == "branch" {
                    break event;
                }
            }
        })
        .await
        .expect("a no-op/current-checkout ensure refreshes branch observers");
        assert_eq!(branch.data["meta"]["branch"], "main");
        let git_tasks_after_second = second
            .tasks
            .list(None)
            .into_iter()
            .filter(|task| task.command.starts_with("git "))
            .count();
        assert_eq!(
            git_tasks_after_second, git_tasks_after_first,
            "an unchanged checkout must not rerun the registered clone/checkout path"
        );
    }

    #[tokio::test]
    async fn branch_monitor_emits_working_tree_changes_for_an_observed_sandbox() {
        let (_root, clone_url) = setup_two_branch_repo();
        let app_root = tempfile::tempdir().unwrap();
        let manager = SandboxManager::new(app_root.path().to_path_buf());
        let sandbox = manager
            .ensure(&GitSandboxConfig {
                virtual_mcp_id: "vmcp-live-branch".to_string(),
                clone_url,
                branch: Some("main".to_string()),
                ..Default::default()
            })
            .await
            .expect("ensure succeeds");
        let mut events = sandbox.broadcaster.subscribe();

        let initial = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let event = events.recv().await.expect("branch monitor stays live");
                if event.name == "branch" {
                    break event;
                }
            }
        })
        .await
        .expect("observed sandbox receives the poller's initial snapshot");
        assert_eq!(initial.data["meta"]["workingTreeDirty"], false);

        std::fs::write(sandbox.workdir.join("untracked.txt"), "changed\n").unwrap();
        let changed = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let event = events.recv().await.expect("branch monitor stays live");
                if event.name == "branch"
                    && event.data["meta"]["workingTreeDirty"].as_bool() == Some(true)
                {
                    break event;
                }
            }
        })
        .await
        .expect("working-tree edit reaches the live branch stream");
        assert_eq!(changed.data["meta"]["branch"], "main");
    }

    #[tokio::test]
    async fn ensure_repairs_a_drifted_branch_before_returning() {
        let (_root, clone_url) = setup_two_branch_repo();
        let app_root = tempfile::tempdir().unwrap();
        let manager = SandboxManager::new(app_root.path().to_path_buf());
        let cfg = GitSandboxConfig {
            virtual_mcp_id: "vmcp-drift".to_string(),
            clone_url,
            branch: Some("main".to_string()),
            ..Default::default()
        };

        let sandbox = manager.ensure(&cfg).await.expect("first ensure succeeds");
        git(&sandbox.workdir, &["checkout", "-q", "-b", "drifted"]);
        assert_eq!(
            git_stdout(&sandbox.workdir, &["rev-parse", "--abbrev-ref", "HEAD"]),
            "drifted"
        );

        manager
            .ensure(&cfg)
            .await
            .expect("repeat ensure restores configured branch");
        assert_eq!(
            git_stdout(&sandbox.workdir, &["rev-parse", "--abbrev-ref", "HEAD"]),
            "main",
            "the no-op fast path must fall back to checkout when the workdir drifted"
        );
    }

    #[tokio::test]
    async fn ensure_rejects_a_failed_drift_repair_instead_of_returning_wrong_branch() {
        let (_root, clone_url) = setup_two_branch_repo();
        let app_root = tempfile::tempdir().unwrap();
        let manager = SandboxManager::new(app_root.path().to_path_buf());
        let cfg = GitSandboxConfig {
            virtual_mcp_id: "vmcp-dirty-drift".to_string(),
            clone_url,
            branch: Some("main".to_string()),
            ..Default::default()
        };

        let sandbox = manager.ensure(&cfg).await.expect("first ensure succeeds");
        git(&sandbox.workdir, &["config", "user.name", "Test User"]);
        git(
            &sandbox.workdir,
            &["config", "user.email", "test@example.com"],
        );
        git(&sandbox.workdir, &["checkout", "-q", "-b", "drifted"]);
        std::fs::write(sandbox.workdir.join("BRANCH.txt"), "drifted committed\n").unwrap();
        git(&sandbox.workdir, &["add", "BRANCH.txt"]);
        git(
            &sandbox.workdir,
            &["commit", "-q", "-m", "drift away from main"],
        );
        std::fs::write(sandbox.workdir.join("BRANCH.txt"), "dirty conflict\n").unwrap();

        let error = match manager.ensure(&cfg).await {
            Ok(_) => panic!("a checkout conflict must fail the sandbox ensure"),
            Err(error) => error,
        };
        assert!(
            error.contains("git clone/checkout failed"),
            "the caller must receive a checkout failure, got: {error}"
        );
        assert_eq!(
            git_stdout(&sandbox.workdir, &["rev-parse", "--abbrev-ref", "HEAD"]),
            "drifted",
            "the failed checkout remains on the wrong branch and must never be returned as ready"
        );
    }

    #[tokio::test]
    async fn ensure_coalesces_concurrent_callers_for_a_brand_new_handle() {
        let (_root, clone_url) = setup_two_branch_repo();
        let app_root = tempfile::tempdir().unwrap();
        let manager = SandboxManager::new(app_root.path().to_path_buf());

        let cfg = GitSandboxConfig {
            virtual_mcp_id: "vmcp-1".to_string(),
            clone_url,
            branch: Some("main".to_string()),
            ..Default::default()
        };

        // Pause each caller at a deterministic point immediately after it
        // acquires the per-handle operation lock. While the first is paused,
        // the second must NOT reach that point: this proves the lock covers
        // more than `Sandbox` map insertion. After releasing the first, the
        // second must only enter once the first has cloned and fully returned.
        let (entered_tx, mut entered_rx) = tokio::sync::mpsc::unbounded_channel();
        let permits = Arc::new(tokio::sync::Semaphore::new(0));

        let first_gate = {
            let entered_tx = entered_tx.clone();
            let permits = permits.clone();
            async move {
                entered_tx.send("first").unwrap();
                permits.acquire().await.unwrap().forget();
            }
        };
        let second_gate = {
            let entered_tx = entered_tx.clone();
            let permits = permits.clone();
            async move {
                entered_tx.send("second").unwrap();
                permits.acquire().await.unwrap().forget();
            }
        };
        drop(entered_tx);

        let coordinator = async {
            let first = tokio::time::timeout(std::time::Duration::from_secs(5), entered_rx.recv())
                .await
                .expect("one ensure caller acquires the operation lock")
                .expect("entry channel remains open");
            assert!(
                tokio::time::timeout(std::time::Duration::from_millis(100), entered_rx.recv())
                    .await
                    .is_err(),
                "the second ensure caller entered while the first still held the operation lock"
            );

            permits.add_permits(1);
            let second =
                tokio::time::timeout(std::time::Duration::from_secs(15), entered_rx.recv())
                    .await
                    .expect("second ensure enters after the first fully returns")
                    .expect("entry channel remains open for the second caller");
            assert_ne!(first, second);
            permits.add_permits(1);
        };

        let (a, b, ()) = tokio::join!(
            manager.ensure_inner(&cfg, first_gate),
            manager.ensure_inner(&cfg, second_gate),
            coordinator,
        );
        let a = a.expect("first concurrent ensure succeeds");
        let b = b.expect("second concurrent ensure succeeds");
        assert!(
            Arc::ptr_eq(&a, &b),
            "concurrent ensure() calls for the same not-yet-created handle must coalesce onto one Sandbox"
        );
        assert_eq!(
            std::fs::read_to_string(a.workdir.join("BRANCH.txt"))
                .unwrap()
                .trim(),
            "main"
        );
    }

    #[tokio::test]
    async fn concurrent_provision_calls_coalesce_one_setup_generation() {
        let (_root, clone_url) = setup_two_branch_repo();
        let app_root = tempfile::tempdir().unwrap();
        let manager = SandboxManager::new(app_root.path().to_path_buf());
        let config = GitSandboxConfig {
            virtual_mcp_id: "vmcp-concurrent-provision".to_string(),
            clone_url,
            branch: Some("main".to_string()),
            ..Default::default()
        };

        let (first, second) = tokio::join!(manager.provision(&config), manager.provision(&config));
        let first = first.unwrap();
        let second = second.unwrap();
        assert!(Arc::ptr_eq(&first, &second));

        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                if !first.setup.is_running() && first.setup.pending_count() == 0 {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("the single setup generation drains");
        let clone_tasks = first
            .tasks
            .list(None)
            .into_iter()
            .filter(|task| task.command.starts_with("git clone "))
            .count();
        assert_eq!(
            clone_tasks, 1,
            "repeat provision must not queue Clone twice"
        );
    }

    #[tokio::test]
    async fn provision_discards_partial_git_directory_before_clone_retry() {
        let (_origin, clone_url) = setup_two_branch_repo();
        let app_root = tempfile::tempdir().unwrap();
        let manager = SandboxManager::new(app_root.path().to_path_buf());
        let config = GitSandboxConfig {
            virtual_mcp_id: "vmcp-partial-git".to_string(),
            clone_url,
            branch: Some("main".to_string()),
            ..Default::default()
        };
        // Derived from the config's OWN clone URL — the handle is the
        // repository scope, so a hardcoded URL would name a different worktree.
        let handle =
            SandboxManager::compute_handle(&config.clone_url, "main").expect("scopeable clone url");
        let sandbox_path = app_root
            .path()
            .join(crate::sandbox::WORKTREES_DIR)
            .join(&handle);
        let workdir = sandbox_path.join("repo");
        std::fs::create_dir_all(workdir.join(".git")).unwrap();
        std::fs::write(workdir.join("partial-object"), "incomplete clone").unwrap();
        manager
            .registry
            .upsert_config(&handle, &config, &sandbox_path, &workdir)
            .unwrap();
        manager
            .registry
            .mark_state(&handle, "stopped", "stopped", None)
            .unwrap();

        let sandbox = manager.provision(&config).await.unwrap();
        assert!(
            !sandbox.workdir.join("partial-object").exists(),
            "invalid partial clone is cleared before the retry is queued"
        );
        tokio::time::timeout(Duration::from_secs(10), async {
            while !crate::routes::git::is_git_repo(&sandbox.workdir).await {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("retry produces a valid repository");
    }

    #[tokio::test]
    async fn stale_generation_lifecycle_cannot_overwrite_resumed_generation() {
        let (_origin, clone_url) = setup_two_branch_repo();
        let app_root = tempfile::tempdir().unwrap();
        let manager = SandboxManager::new(app_root.path().to_path_buf());
        let config = GitSandboxConfig {
            virtual_mcp_id: "vmcp-stale-monitor".to_string(),
            clone_url,
            branch: Some("main".to_string()),
            ..Default::default()
        };
        let old = manager.ensure(&config).await.unwrap();
        manager.stop_registered(&old.handle).await.unwrap().unwrap();
        let current = manager.provision(&config).await.unwrap();
        assert!(!Arc::ptr_eq(&old, &current));

        tokio::time::timeout(Duration::from_secs(5), async {
            while current.setup.is_running() || current.setup.pending_count() > 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();

        current.broadcaster.emit(
            "lifecycle",
            json!({"state":{"phase":"running","port":3210,"htmlSupport":true}}),
        );
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if manager
                    .registry_record(&current.handle)
                    .unwrap()
                    .unwrap()
                    .observed_status
                    == "running"
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();

        old.broadcaster.emit(
            "lifecycle",
            json!({"state":{"phase":"clone-failed","error":"stale failure"}}),
        );
        tokio::task::yield_now().await;
        let record = manager.registry_record(&current.handle).unwrap().unwrap();
        assert_eq!(record.observed_status, "running");
        assert_ne!(record.error.as_deref(), Some("stale failure"));
    }

    /// Inverted: a different repository can no longer reach the same handle.
    ///
    /// The handle IS `<host>/<owner>/<repo>/<branch>`, so changing the clone
    /// URL changes the handle by construction — the identity-conflict guard
    /// this used to exercise now protects a state that cannot be reached, and
    /// two repositories simply get two worktrees.
    #[test]
    fn two_repositories_can_never_share_a_handle() {
        let a = SandboxManager::compute_handle("https://github.com/acme/one.git", "main")
            .expect("scopeable clone url");
        let b = SandboxManager::compute_handle("https://github.com/acme/two.git", "main")
            .expect("scopeable clone url");
        assert_ne!(a, b);
        // ...and the same repository reached by a different URL spelling does.
        let ssh = SandboxManager::compute_handle("git@github.com:acme/one.git", "main")
            .expect("scopeable clone url");
        assert_eq!(
            a, ssh,
            "one repository is one worktree, however it is spelled"
        );
    }

    // --- Resurrection (persisted-sidecar self-heal) -------------------------

    #[tokio::test]
    async fn resurrect_returns_none_for_a_handle_with_no_sidecar() {
        let app_root = tempfile::tempdir().unwrap();
        let manager = SandboxManager::new(app_root.path().to_path_buf());
        let result = manager
            .resurrect("never-ensured-handle")
            .await
            .expect("no sidecar is not an error");
        assert!(result.is_none());
    }

    #[tokio::test]
    async fn resurrect_returns_the_in_memory_sandbox_without_touching_disk_when_already_known() {
        let (_root, clone_url) = setup_two_branch_repo();
        let app_root = tempfile::tempdir().unwrap();
        let manager = SandboxManager::new(app_root.path().to_path_buf());
        let sandbox = manager
            .ensure(&GitSandboxConfig {
                virtual_mcp_id: "vmcp-resurrect-known".to_string(),
                clone_url,
                branch: Some("main".to_string()),
                ..Default::default()
            })
            .await
            .expect("ensure succeeds");

        let resurrected = manager
            .resurrect(&sandbox.handle)
            .await
            .expect("resurrect ok")
            .expect("sandbox found");
        assert!(
            Arc::ptr_eq(&sandbox, &resurrected),
            "an already-known handle must return the SAME Sandbox, not re-ensure a new one"
        );
    }

    #[tokio::test]
    async fn resurrect_rebuilds_a_forgotten_handle_from_its_persisted_sidecar_on_a_fresh_manager() {
        // Simulates a backend process restart: the FIRST manager `ensure()`s
        // a handle (writing its sidecar + workdir to disk), then a SECOND,
        // entirely fresh `SandboxManager` over the SAME app_root (empty
        // in-memory `sandboxes` map, exactly like a real relaunch) resolves
        // that same handle via `resurrect()` alone.
        let (_root, clone_url) = setup_two_branch_repo();
        let app_root = tempfile::tempdir().unwrap();

        let manager_a = SandboxManager::new(app_root.path().to_path_buf());
        let original = manager_a
            .ensure(&GitSandboxConfig {
                virtual_mcp_id: "vmcp-resurrect-forgotten".to_string(),
                clone_url,
                branch: Some("main".to_string()),
                ..Default::default()
            })
            .await
            .expect("ensure succeeds");
        let handle = original.handle.clone();
        let workdir = original.workdir.clone();
        drop(manager_a);

        let manager_b = SandboxManager::new(app_root.path().to_path_buf());
        assert!(
            manager_b.get(&handle).is_none(),
            "a fresh manager must start with an empty in-memory map"
        );

        let resurrected = manager_b
            .resurrect(&handle)
            .await
            .expect("resurrect ok")
            .expect("sidecar found and re-ensure succeeded");
        assert_eq!(resurrected.workdir, workdir);
        assert_eq!(
            std::fs::read_to_string(resurrected.workdir.join("BRANCH.txt"))
                .unwrap()
                .trim(),
            "main",
            "resurrection must land on the SAME (already-cloned) workdir, not a fresh clone"
        );
        assert!(
            manager_b.get(&handle).is_some(),
            "a resurrected handle must now be known in memory too"
        );
    }

    #[tokio::test]
    async fn adopt_rebuilds_routing_metadata_without_starting_setup() {
        let (_root, clone_url) = setup_two_branch_repo();
        let app_root = tempfile::tempdir().unwrap();
        let manager_a = SandboxManager::new(app_root.path().to_path_buf());
        let original = manager_a
            .ensure(&GitSandboxConfig {
                virtual_mcp_id: "vmcp-adopt-only".to_string(),
                clone_url,
                branch: Some("main".to_string()),
                ..Default::default()
            })
            .await
            .expect("initial ensure succeeds");
        let handle = original.handle.clone();
        drop(manager_a);

        let manager_b = SandboxManager::new(app_root.path().to_path_buf());
        let adopted = manager_b
            .adopt(&handle)
            .await
            .expect("metadata adoption succeeds")
            .expect("durable record exists");
        assert_eq!(adopted.handle, handle);
        assert!(adopted.tasks.list(None).is_empty());
        assert_eq!(adopted.setup.lifecycle_snapshot()["phase"], "idle");
        let record = manager_b.registry_record(&handle).unwrap().unwrap();
        assert_eq!(record.observed_status, "stopped");
    }

    #[tokio::test]
    async fn stop_during_install_fences_old_cascade_and_preserves_install_checkpoint() {
        let (_root, clone_url) = setup_two_branch_repo();
        let app_root = tempfile::tempdir().unwrap();
        let manager = SandboxManager::new(app_root.path().to_path_buf());
        let config = GitSandboxConfig {
            virtual_mcp_id: "vmcp-stop-install-fence".to_string(),
            clone_url,
            branch: Some("main".to_string()),
            ..Default::default()
        };
        let original = manager.ensure(&config).await.unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            while original.setup.is_running() || original.setup.pending_count() > 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        original
            .broadcaster
            .emit("lifecycle", json!({"state":{"phase":"installing"}}));
        tokio::time::timeout(Duration::from_secs(2), async {
            while manager
                .registry_record(&original.handle)
                .unwrap()
                .unwrap()
                .resume_step
                != "install"
            {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();

        // Deterministically model the install child at the exact boundary
        // Stop must own; unlike a timing-dependent real package manager this
        // cannot finish before the assertion reaches the stop fence.
        let controller = crate::tasks::ProcessController::new();
        original.tasks.insert(crate::tasks::TaskEntry::new(
            crate::tasks::TaskSummary {
                id: "install-in-flight".to_string(),
                command: "bun install".to_string(),
                status: TaskStatus::Running,
                exit_code: None,
                started_at: 0,
                finished_at: None,
                timed_out: false,
                truncated: false,
                log_name: Some("setup".to_string()),
                intentional: None,
            },
            Some(controller.kill_handle()),
        ));
        let task_owner = {
            let tasks = original.tasks.clone();
            let controller = controller.clone();
            tokio::spawn(async move {
                let signal = controller.wait_for_change(None).await;
                tasks.finalize(
                    "install-in-flight",
                    TaskStatus::Killed,
                    signal.exit_code(),
                    false,
                );
            })
        };

        let killed_count = manager
            .stop_registered(&original.handle)
            .await
            .unwrap()
            .unwrap();
        assert!(killed_count >= 1);
        task_owner.await.unwrap();
        assert_eq!(controller.requested(), Some(KillSignal::Term));
        assert!(original.setup.is_closed());
        assert!(
            !original.setup.resume_from(Step::Start),
            "the stopped generation cannot cascade into or enqueue Start"
        );
        assert!(manager.get(&original.handle).is_none());
        assert_eq!(
            manager
                .registry_record(&original.handle)
                .unwrap()
                .unwrap()
                .resume_step,
            "install",
            "Stop preserves the earliest safe step instead of skipping an incomplete install"
        );

        let resumed = manager.provision(&config).await.unwrap();
        assert!(!Arc::ptr_eq(&original, &resumed));
        assert!(!resumed.setup.is_closed());
        assert_eq!(
            manager
                .registry_record(&resumed.handle)
                .unwrap()
                .unwrap()
                .desired_status,
            "running"
        );
    }

    #[tokio::test]
    async fn resurrect_active_returns_none_when_nothing_was_ever_active() {
        let app_root = tempfile::tempdir().unwrap();
        let manager = SandboxManager::new(app_root.path().to_path_buf());
        let result = manager
            .resurrect_active()
            .await
            .expect("no persisted active handle is not an error");
        assert!(result.is_none());
    }

    #[tokio::test]
    async fn resurrect_active_rebuilds_the_last_active_handle_on_a_fresh_manager_after_a_restart() {
        let (_root, clone_url) = setup_two_branch_repo();
        let app_root = tempfile::tempdir().unwrap();

        let manager_a = SandboxManager::new(app_root.path().to_path_buf());
        let original = manager_a
            .ensure(&GitSandboxConfig {
                virtual_mcp_id: "vmcp-resurrect-active".to_string(),
                clone_url,
                branch: Some("main".to_string()),
                ..Default::default()
            })
            .await
            .expect("ensure succeeds (also marks this handle active)");
        let workdir = original.workdir.clone();
        drop(manager_a);

        // Fresh manager, same app_root — `active_handle` is `None` in memory,
        // but the persisted `.active-handle` pointer file survives.
        let manager_b = SandboxManager::new(app_root.path().to_path_buf());
        assert!(manager_b.active().is_none());

        let resurrected = manager_b
            .resurrect_active()
            .await
            .expect("resurrect_active ok")
            .expect("persisted active handle resolved");
        assert_eq!(resurrected.workdir, workdir);
        // The headerless path is now warm too, for a SUBSEQUENT call.
        assert!(manager_b.active().is_some());
    }

    #[tokio::test]
    async fn resurrect_active_prefers_the_in_memory_active_sandbox_over_disk() {
        let (_root, clone_url) = setup_two_branch_repo();
        let app_root = tempfile::tempdir().unwrap();
        let manager = SandboxManager::new(app_root.path().to_path_buf());
        let sandbox = manager
            .ensure(&GitSandboxConfig {
                virtual_mcp_id: "vmcp-resurrect-prefers-memory".to_string(),
                clone_url,
                branch: Some("main".to_string()),
                ..Default::default()
            })
            .await
            .expect("ensure succeeds");

        let resurrected = manager
            .resurrect_active()
            .await
            .expect("resurrect_active ok")
            .expect("active sandbox found");
        assert!(
            Arc::ptr_eq(&sandbox, &resurrected),
            "an already-active in-memory sandbox must be returned directly, no disk read needed"
        );
    }

    #[tokio::test]
    async fn shutdown_all_closes_and_reaps_every_sandbox_concurrently() {
        let app_root = tempfile::tempdir().unwrap();
        let manager = SandboxManager::new(app_root.path().to_path_buf());
        let mut sandboxes = Vec::new();
        for handle in ["one", "two"] {
            let lock = manager.handle_lock(handle);
            let _permit = lock.lock().await;
            sandboxes.push(
                manager
                    .get_or_create_locked(handle)
                    .expect("sandbox construction succeeds"),
            );
        }

        let both_signaled = Arc::new(tokio::sync::Barrier::new(2));
        let mut owners = Vec::new();
        for sandbox in &sandboxes {
            let id = sandbox.tasks.next_id();
            let controller = crate::tasks::ProcessController::new();
            assert!(sandbox.setup.register_task(crate::tasks::TaskEntry::new(
                crate::tasks::TaskSummary {
                    id: id.clone(),
                    command: "test-child".to_string(),
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
            )));
            let tasks = sandbox.tasks.clone();
            let barrier = both_signaled.clone();
            owners.push(tokio::spawn(async move {
                assert_eq!(
                    controller.wait_for_change(None).await,
                    crate::tasks::KillSignal::Term
                );
                barrier.wait().await;
                tasks.finalize(&id, TaskStatus::Killed, 143, false);
            }));
        }

        let results = tokio::time::timeout(
            Duration::from_millis(500),
            manager.shutdown_all(Duration::from_secs(1), Duration::from_secs(1)),
        )
        .await
        .expect("all sandbox shutdowns run concurrently");
        for owner in owners {
            owner.await.unwrap();
        }

        assert_eq!(results.len(), 2);
        assert!(results.iter().all(|result| {
            result.result.tasks.initially_running == 1
                && result.result.tasks.term_signaled == 1
                && result.result.tasks.remaining.is_empty()
        }));
        assert!(sandboxes.iter().all(|sandbox| sandbox.setup.is_closed()));
        assert!(manager.is_closing());
        assert!(manager.ensure(&GitSandboxConfig::default()).await.is_err());
    }
}
