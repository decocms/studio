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
use crate::mutation::{MutationCoordinator, MutationShutdownOutcome};
use crate::routes::threads::db::RtAccountScope;
use crate::setup::{SetupOrchestrator, SetupShutdownResult, Step};
use crate::tasks::{KillSignal, TaskRegistry, TaskStatus};

use super::account_storage::AccountStorage;

const BRANCH_STATUS_POLL_INTERVAL: Duration = Duration::from_secs(3);
const ACCOUNT_TRANSITION_MATERIALIZATION_DRAIN_TIMEOUT: Duration = Duration::from_secs(15);
const STALE_ACCOUNT_EPOCH: &str = "sandbox request belongs to a stale account epoch";

/// Opaque proof that an account-scoped request was admitted while the
/// upstream account-transition lock was held. The counter is deliberately
/// private: callers can carry and compare tickets, but cannot manufacture an
/// account selector from a wire value.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) struct AccountEpoch(u64);

impl AccountEpoch {
    #[cfg(test)]
    pub(crate) const fn for_test() -> Self {
        Self(0)
    }
}

/// Complete proof of the authenticated account authorized to touch managed
/// sandbox state. The opaque epoch fences delayed work, while the verified
/// storage root binds every durable path and registry operation to the exact
/// upstream issuer + subject.
#[derive(Clone)]
pub(crate) struct SandboxAccount {
    epoch: AccountEpoch,
    storage_key: Arc<str>,
    storage: AccountStorage,
    gate: Arc<MaterializationGate>,
}

impl SandboxAccount {
    pub(crate) fn epoch(&self) -> AccountEpoch {
        self.epoch
    }

    pub(crate) fn storage_key(&self) -> &str {
        &self.storage_key
    }

    pub(crate) fn storage(&self) -> &AccountStorage {
        &self.storage
    }

    /// Revalidate both the ephemeral transition ticket and durable marker.
    /// Long-lived org mounts/WebDAV calls use this immediately before every
    /// admission so a retired account object cannot recreate resources.
    pub(crate) fn validate(&self) -> Result<(), String> {
        self.storage.verify()?;
        self.gate.validate_binding(self.epoch, &self.storage_key)
    }

    /// Cleanup-only durable proof retained by a transition after normal
    /// admission has closed. This verifies the exact marker but deliberately
    /// does not reopen or claim current-account authority.
    pub(crate) fn verify_retired_storage(&self) -> Result<(), String> {
        self.storage.verify()
    }
}

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
    /// `Option` because workspace setup can happen before an organization is
    /// known. Later org-scoped calls merge and persist the slug, so a sandbox
    /// only has to learn its organization once.
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
    pub mutations: Arc<MutationCoordinator>,
    account: SandboxAccount,
    registry_monitor_started: AtomicBool,
    branch_monitor_started: AtomicBool,
    /// Last `[org-fs]` outcome announced for this sandbox, so `ensure` — which
    /// runs on every dispatch — reports only transitions.
    org_fs_announced: Mutex<Option<bool>>,
}

/// `HashMap<Handle, Arc<Sandbox>>` plus a per-handle async lock so two
/// concurrent `ensure()` calls for a handle that doesn't exist YET don't
/// both `git clone` into the same not-yet-created directory — see
/// [`SandboxManager::ensure`].
pub struct SandboxManager {
    app_root: PathBuf,
    registry: super::registry::SandboxRegistry,
    closing: AtomicBool,
    sandboxes: Mutex<HashMap<SandboxKey, Arc<Sandbox>>>,
    /// Operation locks, one per handle currently being (or about to be)
    /// ensured. The lock covers the WHOLE config -> clone/checkout -> cascade
    /// scheduling operation, not just the `Sandbox`'s map insertion: two
    /// callers running git against the same workdir concurrently can leave a
    /// half-created repository even though they share the same `Sandbox` Arc.
    /// Entries are never removed — a handle lives for the process lifetime
    /// once first requested, so the map stays bounded by the number of
    /// DISTINCT (virtualMcpId, branch) pairs a session ever dispatches, not by
    /// call volume.
    locks: Mutex<HashMap<SandboxKey, Arc<tokio::sync::Mutex<()>>>>,
    /// `preview_label(handle) → handle`, lazily built from the registry and
    /// dropped whenever a registry row changes. The preview proxy resolves a
    /// label on EVERY asset request; without this it walked `worktrees/`
    /// recursively and hashed every handle per request.
    preview_labels: std::sync::RwLock<HashMap<String, HashMap<String, String>>>,
    /// The handle whose dev server the reverse proxy serves for a plain
    /// (headerless) preview request — see [`SandboxManager::active`]. A
    /// browser iframe navigation cannot attach the `x-decocms-sandbox-handle`
    /// header, so the preview iframe (which loads the local-api origin
    /// directly) relies on this: `ensure()` marks its handle active, so the
    /// most-recently-dispatched thread's sandbox is what the preview shows.
    /// The webview can also set it explicitly on thread focus (see
    /// `POST /_sandbox/preview-handle`) for switching threads without re-running.
    /// Account-scoped active-handle feeds. Durable values live in
    /// `sandbox_active`; these senders are only live fan-out.
    active_watches: Mutex<HashMap<String, tokio::sync::watch::Sender<Option<String>>>>,
    /// Per-handle process-generation feeds. An explicit xterm/SSE stream must
    /// follow a stopped sandbox when Resume replaces its in-memory `Sandbox`
    /// Arc, independently of whichever other chat is currently active.
    generation_watches: Mutex<GenerationWatchMap>,
    org_mounts: super::org_mount::OrgMountManager,
    materialization_gate: Arc<MaterializationGate>,
    account_transition_lock: Arc<tokio::sync::Mutex<()>>,
}

type GenerationWatchMap =
    HashMap<(String, AccountEpoch, String), tokio::sync::watch::Sender<Option<Arc<Sandbox>>>>;
type SandboxKey = (String, String);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SandboxShutdownResult {
    pub account_id: String,
    pub handle: String,
    pub mutations: MutationShutdownOutcome,
    pub result: SetupShutdownResult,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum TerminalEnsureError {
    Canceled,
    Failed(String),
}

const TERMINAL_ENSURE_CANCELED: &str = "terminal sandbox preparation canceled";

struct TerminalEnsureControl {
    canceled: Arc<AtomicBool>,
    cancel: tokio::sync::watch::Receiver<bool>,
    materialized: tokio::sync::oneshot::Sender<TerminalEnsureMaterialized>,
}

struct TerminalEnsureMaterialized {
    sandbox: Arc<Sandbox>,
    resume: tokio::sync::oneshot::Sender<()>,
}

#[derive(Default)]
struct MaterializationState {
    boundary: AccountBoundary,
    active: usize,
    epoch: u64,
    storage_key: Option<Arc<str>>,
    bound_epoch: Option<AccountEpoch>,
}

#[derive(Default, Clone, Copy, PartialEq, Eq)]
enum AccountBoundary {
    #[default]
    Open,
    Transitioning,
    Poisoned,
}

struct MaterializationGate {
    state: Mutex<MaterializationState>,
    changed: tokio::sync::Notify,
    epoch_watch: tokio::sync::watch::Sender<AccountEpoch>,
}

struct MaterializationAdmission {
    gate: Arc<MaterializationGate>,
}

struct MaterializationClosure {
    gate: Arc<MaterializationGate>,
    completed: bool,
}

type RetiredAccountBinding = Option<(AccountEpoch, Arc<str>)>;

/// Owns the native half of an account transition. Acquisition advances the
/// account epoch and closes sandbox publication atomically. The caller keeps
/// this guard through terminal cancellation and artifact cleanup. Publication
/// reopens only through [`SandboxAccountTransitionGuard::complete`]; dropping
/// an incomplete guard poisons the boundary so a replacement identity cannot
/// inherit partially reaped state.
#[must_use = "an account transition must be explicitly completed"]
pub(crate) struct SandboxAccountTransitionGuard {
    manager: Arc<SandboxManager>,
    _transition: tokio::sync::OwnedMutexGuard<()>,
    closure: MaterializationClosure,
    retired: Option<SandboxAccount>,
}

impl MaterializationGate {
    fn account_epoch(&self) -> AccountEpoch {
        AccountEpoch(
            self.state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .epoch,
        )
    }

    fn validate(&self, epoch: AccountEpoch) -> Result<(), String> {
        let state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        match state.boundary {
            AccountBoundary::Open => {}
            AccountBoundary::Transitioning => {
                return Err("sandbox account transition is in progress".to_string());
            }
            AccountBoundary::Poisoned => {
                return Err("sandbox account transition is poisoned".to_string());
            }
        }
        if state.epoch != epoch.0 {
            return Err(STALE_ACCOUNT_EPOCH.to_string());
        }
        Ok(())
    }

    fn bind(&self, epoch: AccountEpoch, storage_key: Arc<str>) -> Result<(), String> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        match state.boundary {
            AccountBoundary::Open => {}
            AccountBoundary::Transitioning => {
                return Err("sandbox account transition is in progress".to_string());
            }
            AccountBoundary::Poisoned => {
                return Err("sandbox account transition is poisoned".to_string());
            }
        }
        if state.epoch != epoch.0 {
            return Err(STALE_ACCOUNT_EPOCH.to_string());
        }
        match &state.storage_key {
            Some(current) if current.as_ref() != storage_key.as_ref() => {
                return Err("sandbox account scope changed without a completed transition".into());
            }
            Some(_) => {}
            None => {
                state.storage_key = Some(storage_key);
                state.bound_epoch = Some(epoch);
            }
        }
        Ok(())
    }

    fn validate_binding(&self, epoch: AccountEpoch, storage_key: &str) -> Result<(), String> {
        let state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        match state.boundary {
            AccountBoundary::Open => {}
            AccountBoundary::Transitioning => {
                return Err("sandbox account transition is in progress".to_string());
            }
            AccountBoundary::Poisoned => {
                return Err("sandbox account transition is poisoned".to_string());
            }
        }
        if state.epoch != epoch.0 {
            return Err(STALE_ACCOUNT_EPOCH.to_string());
        }
        if state.storage_key.as_deref() != Some(storage_key) || state.bound_epoch != Some(epoch) {
            return Err("sandbox account is not the current bound scope".to_string());
        }
        Ok(())
    }

    fn watch_account_epoch(
        &self,
        epoch: AccountEpoch,
    ) -> Result<tokio::sync::watch::Receiver<AccountEpoch>, String> {
        let state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if state.boundary != AccountBoundary::Open {
            return Err(match state.boundary {
                AccountBoundary::Poisoned => "sandbox account transition is poisoned",
                _ => "sandbox account transition is in progress",
            }
            .to_string());
        }
        if state.epoch != epoch.0 {
            return Err(STALE_ACCOUNT_EPOCH.to_string());
        }
        // Subscribe while holding the same state lock that advances the
        // epoch. A transition therefore cannot land between validation and
        // receiver creation.
        Ok(self.epoch_watch.subscribe())
    }

    fn admit(self: &Arc<Self>, epoch: AccountEpoch) -> Result<MaterializationAdmission, String> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if state.boundary != AccountBoundary::Open {
            return Err(match state.boundary {
                AccountBoundary::Poisoned => "sandbox account transition is poisoned",
                _ => "sandbox account transition is in progress",
            }
            .to_string());
        }
        if state.epoch != epoch.0 {
            return Err(STALE_ACCOUNT_EPOCH.to_string());
        }
        state.active += 1;
        Ok(MaterializationAdmission { gate: self.clone() })
    }

    fn advance_and_close(
        self: &Arc<Self>,
    ) -> Result<(MaterializationClosure, RetiredAccountBinding), String> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let retired = state.storage_key.clone().map(|storage_key| {
            (
                state.bound_epoch.unwrap_or(AccountEpoch(state.epoch)),
                storage_key,
            )
        });
        match state.boundary {
            AccountBoundary::Transitioning => {
                return Err("sandbox account transition is already in progress".to_string());
            }
            AccountBoundary::Poisoned => {
                // A later transition is an explicit retry of the same cleanup.
                // The poisoned epoch already invalidated every old ticket.
                state.boundary = AccountBoundary::Transitioning;
            }
            AccountBoundary::Open => {
                let Some(next_epoch) = state.epoch.checked_add(1) else {
                    state.boundary = AccountBoundary::Poisoned;
                    self.epoch_watch.send_replace(AccountEpoch(state.epoch));
                    return Err("sandbox account epoch exhausted".to_string());
                };
                state.epoch = next_epoch;
                state.boundary = AccountBoundary::Transitioning;
                self.epoch_watch.send_replace(AccountEpoch(next_epoch));
            }
        }
        Ok((
            MaterializationClosure {
                gate: self.clone(),
                completed: false,
            },
            retired,
        ))
    }
}

impl Default for MaterializationGate {
    fn default() -> Self {
        Self {
            state: Mutex::new(MaterializationState::default()),
            changed: tokio::sync::Notify::new(),
            epoch_watch: tokio::sync::watch::channel(AccountEpoch(0)).0,
        }
    }
}

impl Drop for MaterializationAdmission {
    fn drop(&mut self) {
        let quiescent = {
            let mut state = self
                .gate
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            debug_assert!(state.active > 0, "materialization admission underflow");
            state.active = state.active.saturating_sub(1);
            state.active == 0
        };
        if quiescent {
            self.gate.changed.notify_waiters();
        }
    }
}

impl MaterializationClosure {
    async fn drain(&self) {
        loop {
            let changed = self.gate.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            if self
                .gate
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .active
                == 0
            {
                return;
            }
            changed.await;
        }
    }

    fn complete(&mut self) -> Result<(), String> {
        let mut state = self
            .gate
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if state.boundary != AccountBoundary::Transitioning {
            return Err("sandbox account transition is not active".to_string());
        }
        if state.active != 0 {
            return Err("sandbox materialization is still active".to_string());
        }
        state.storage_key = None;
        state.bound_epoch = None;
        state.boundary = AccountBoundary::Open;
        self.completed = true;
        self.gate.changed.notify_waiters();
        Ok(())
    }
}

impl Drop for MaterializationClosure {
    fn drop(&mut self) {
        if self.completed {
            return;
        }
        let mut state = self
            .gate
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if state.boundary == AccountBoundary::Transitioning {
            state.boundary = AccountBoundary::Poisoned;
        }
        self.gate.changed.notify_waiters();
    }
}

impl SandboxAccountTransitionGuard {
    pub(crate) fn retired_account(&self) -> Option<&SandboxAccount> {
        self.retired.as_ref()
    }
    /// Wait only for the short in-memory insertion + durable registration
    /// commit section, then stop every generation visible in the snapshot.
    /// A timeout returns before the snapshot, so callers never receive a
    /// misleading partial stop result.
    pub(crate) async fn drain_and_stop_live(&self) -> Result<usize, String> {
        self.drain_and_stop_live_with_timeout(ACCOUNT_TRANSITION_MATERIALIZATION_DRAIN_TIMEOUT)
            .await
    }

    /// Reopen account admission only after every cleanup phase owned by the
    /// caller has succeeded. Any early return drops an incomplete closure and
    /// leaves the boundary poisoned for an explicit retry.
    pub(crate) fn complete(mut self) -> Result<(), String> {
        self.closure.complete()
    }

    async fn drain_and_stop_live_with_timeout(&self, timeout: Duration) -> Result<usize, String> {
        tokio::time::timeout(timeout, self.closure.drain())
            .await
            .map_err(|_| {
                format!(
                    "timed out after {}ms waiting for sandbox materialization to drain",
                    timeout.as_millis()
                )
            })?;

        let Some(retired) = self.retired_account() else {
            if self.manager.lock_sandboxes().is_empty() {
                return Ok(0);
            }
            return Err(
                "sandbox account transition has live generations but no retired account identity"
                    .to_string(),
            );
        };
        retired.verify_retired_storage()?;
        let handles = self
            .manager
            .lock_sandboxes()
            .iter()
            .filter(|((scope, _), sandbox)| {
                scope == retired.storage_key() && sandbox.account.epoch() == retired.epoch()
            })
            .map(|((_, handle), _)| handle.clone())
            .collect::<Vec<_>>();
        let mut stopped = 0;
        let mut failures = Vec::new();
        for handle in handles {
            match self
                .manager
                .stop_registered_generation(retired, &handle)
                .await
            {
                Ok(Some(_)) => stopped += 1,
                Ok(None) => {}
                Err(error) => failures.push(format!("{handle}: {error}")),
            }
        }
        self.manager
            .generation_watches
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .retain(|(scope, epoch, _), _| {
                scope != retired.storage_key() || *epoch != retired.epoch()
            });
        if failures.is_empty() {
            self.manager
                .active_watches
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .remove(retired.storage_key());
            self.manager
                .preview_labels
                .write()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .remove(retired.storage_key());
            self.manager
                .locks
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .retain(|(scope, _), _| scope != retired.storage_key());
            Ok(stopped)
        } else {
            Err(format!(
                "could not stop sandbox(es) for account transition: {}",
                failures.join("; ")
            ))
        }
    }
}

async fn wait_terminal_cancellation(cancel: &mut tokio::sync::watch::Receiver<bool>) {
    loop {
        if *cancel.borrow() {
            return;
        }
        if cancel.changed().await.is_err() {
            // Dropping the preparation owner is cancellation too. Treating a
            // closed false-valued watch as "keep waiting" would strand this
            // manager-owned coordinator if its caller unwound unexpectedly.
            return;
        }
    }
}

fn map_terminal_ensure_result(
    result: Result<Result<Arc<Sandbox>, String>, tokio::task::JoinError>,
) -> Result<Arc<Sandbox>, TerminalEnsureError> {
    match result {
        Ok(Ok(sandbox)) => Ok(sandbox),
        Ok(Err(error)) if error == TERMINAL_ENSURE_CANCELED => Err(TerminalEnsureError::Canceled),
        Ok(Err(error)) => Err(TerminalEnsureError::Failed(error)),
        Err(error) => Err(TerminalEnsureError::Failed(format!(
            "terminal sandbox preparation owner failed: {error}"
        ))),
    }
}

impl SandboxManager {
    pub fn new(app_root: PathBuf) -> Arc<Self> {
        let registry = super::registry::SandboxRegistry::open(app_root.clone())
            .unwrap_or_else(|error| panic!("native sandbox registry failed to open: {error}"));
        Arc::new(Self {
            org_mounts: super::org_mount::OrgMountManager::new(app_root.clone()),
            app_root,
            registry,
            closing: AtomicBool::new(false),
            sandboxes: Mutex::new(HashMap::new()),
            locks: Mutex::new(HashMap::new()),
            preview_labels: std::sync::RwLock::new(HashMap::new()),
            active_watches: Mutex::new(HashMap::new()),
            generation_watches: Mutex::new(HashMap::new()),
            materialization_gate: Arc::new(MaterializationGate::default()),
            account_transition_lock: Arc::new(tokio::sync::Mutex::new(())),
        })
    }

    #[cfg(test)]
    pub(crate) fn test_account(&self) -> Result<SandboxAccount, String> {
        let scope = RtAccountScope::new("test.invalid", "local-desktop-user")
            .expect("valid test account scope");
        self.test_account_for_scope(&scope)
    }

    #[cfg(test)]
    pub(crate) fn test_account_for_scope(
        &self,
        scope: &RtAccountScope,
    ) -> Result<SandboxAccount, String> {
        self.sandbox_account(self.account_epoch(), scope)
    }

    /// The sandbox the reverse proxy serves for a headerless preview request:
    /// the last handle `ensure()`-d, or one explicitly focused by the webview.
    /// `None` until the first git-backed dispatch — the proxy then falls back
    /// to the global (non-git) orchestrator, exactly as before.
    #[cfg(test)]
    fn active(&self) -> Option<Arc<Sandbox>> {
        let account = self.test_account().ok()?;
        self.active_for_account(&account).ok().flatten()
    }

    pub(crate) fn active_for_account(
        &self,
        account: &SandboxAccount,
    ) -> Result<Option<Arc<Sandbox>>, String> {
        self.validate_sandbox_account(account)?;
        let handle = self.registry.active_handle_for_account(account.storage())?;
        let resolved = match handle {
            Some(handle) => self.get_for_account(account, &handle)?,
            None => None,
        };
        self.validate_sandbox_account(account)?;
        Ok(resolved)
    }

    /// Point the headerless preview at a registered `handle` (idempotent).
    /// Unknown handles are rejected so a frontend-computed identity can never
    /// become a persisted pointer to a sandbox Rust has no config for.
    ///
    /// Also best-effort persists `handle` to disk (see the `persist` module
    /// doc) so a HEADERLESS resolve after a process restart can find its way
    /// back to the last-focused sandbox via [`Self::resurrect_active_for_account`] —
    /// `active_handle` above is in-memory only and starts `None` every boot.
    /// Subscribe to active-handle changes (see `active_watch`).
    pub(crate) fn watch_active_for_account(
        &self,
        account: &SandboxAccount,
    ) -> Result<tokio::sync::watch::Receiver<Option<String>>, String> {
        self.validate_sandbox_account(account)?;
        let current = self.registry.active_handle_for_account(account.storage())?;
        let mut watches = self
            .active_watches
            .lock()
            .map_err(|_| "sandbox active watch lock poisoned".to_string())?;
        let sender = watches
            .entry(account.storage_key().to_string())
            .or_insert_with(|| tokio::sync::watch::channel(current.clone()).0);
        if *sender.borrow() != current {
            sender.send_replace(current);
        }
        let receiver = sender.subscribe();
        self.validate_sandbox_account(account)?;
        Ok(receiver)
    }

    /// Subscribe to replacements of one durable handle's in-memory process
    /// generation. Unlike `watch_active`, this is identity-scoped: focusing a
    /// different chat cannot hide a Stop -> Resume replacement from an xterm
    /// that is still following this handle.
    fn watch_generation(
        &self,
        account: &SandboxAccount,
        handle: &str,
    ) -> tokio::sync::watch::Receiver<Option<Arc<Sandbox>>> {
        let current = self
            .get(account, handle)
            .filter(|sandbox| sandbox.account.epoch() == account.epoch());
        let mut watches = self
            .generation_watches
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let sender = watches
            .entry((
                account.storage_key().to_string(),
                account.epoch(),
                handle.to_string(),
            ))
            .or_insert_with(|| {
                let (sender, _receiver) = tokio::sync::watch::channel(current.clone());
                sender
            });
        if current.is_some() && sender.borrow().is_none() {
            sender.send_replace(current);
        }
        sender.subscribe()
    }

    pub(crate) fn watch_generation_for_account(
        &self,
        account: &SandboxAccount,
        handle: &str,
    ) -> Result<tokio::sync::watch::Receiver<Option<Arc<Sandbox>>>, String> {
        self.validate_sandbox_account(account)?;
        let receiver = self.watch_generation(account, handle);
        self.validate_sandbox_account(account)?;
        Ok(receiver)
    }

    fn publish_generation(
        &self,
        account: &SandboxAccount,
        handle: &str,
        generation: Option<Arc<Sandbox>>,
    ) {
        debug_assert!(
            generation.as_ref().is_none_or(|sandbox| {
                sandbox.account.epoch() == account.epoch()
                    && sandbox.account.storage_key() == account.storage_key()
            }),
            "generation published to the wrong account epoch"
        );
        let mut watches = self
            .generation_watches
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let sender = watches
            .entry((
                account.storage_key().to_string(),
                account.epoch(),
                handle.to_string(),
            ))
            .or_insert_with(|| {
                let (sender, _receiver) = tokio::sync::watch::channel(None);
                sender
            });
        sender.send_replace(generation);
    }

    fn set_active_at(&self, account: &SandboxAccount, handle: &str) -> Result<(), String> {
        self.validate_sandbox_account(account)?;
        let _admission = self.admit_materialization(account.epoch())?;
        self.registry
            .set_active_for_account(account.storage(), handle)?;
        if let Some(sender) = self
            .active_watches
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(account.storage_key())
        {
            sender.send_replace(Some(handle.to_string()));
        }
        Ok(())
    }

    pub(crate) fn set_active_for_account(
        &self,
        account: &SandboxAccount,
        handle: &str,
    ) -> Result<(), String> {
        self.set_active_at(account, handle)
    }

    /// The worktree handle a virtual MCP uses for `branch`, via the registry —
    /// the routes the shell calls carry `(virtualMcpId, branch)`, never a
    /// clone URL, and the handle is derived from the repository.
    pub(crate) fn handle_for_virtual_mcp_for_account(
        &self,
        account: &SandboxAccount,
        virtual_mcp_id: &str,
        branch: &str,
    ) -> Result<Option<String>, String> {
        self.validate_sandbox_account(account)?;
        let handle = self.registry.handle_for_virtual_mcp_for_account(
            account.storage(),
            virtual_mcp_id,
            super::normalize_branch(Some(branch)),
        )?;
        self.validate_sandbox_account(account)?;
        Ok(handle)
    }

    /// Whether `handle` has durable config, independently of whether this
    /// process has materialized its live Rust objects yet.
    pub(crate) fn is_registered_for_account(
        &self,
        account: &SandboxAccount,
        handle: &str,
    ) -> Result<bool, String> {
        self.validate_sandbox_account(account)?;
        let registered = self
            .registry
            .contains_for_account(account.storage(), handle)?;
        self.validate_sandbox_account(account)?;
        Ok(registered)
    }

    /// Durable active pointer without materializing or starting its sandbox.
    pub(crate) fn registered_active_handle_for_account(
        &self,
        account: &SandboxAccount,
    ) -> Result<Option<String>, String> {
        self.validate_sandbox_account(account)?;
        let handle = self.registry.active_handle_for_account(account.storage())?;
        self.validate_sandbox_account(account)?;
        Ok(handle)
    }

    /// Returns the durable record for lifecycle/API responses.
    pub(crate) fn registry_record_for_account(
        &self,
        account: &SandboxAccount,
        handle: &str,
    ) -> Result<Option<super::registry::SandboxRecord>, String> {
        self.validate_sandbox_account(account)?;
        let record = self
            .registry
            .record_for_account(account.storage(), handle)?;
        self.validate_sandbox_account(account)?;
        Ok(record)
    }

    /// Every durable sandbox this virtual MCP has claimed — the registry-backed
    /// replacement for walking `worktrees/` and reading sidecars on request
    /// paths.
    pub(crate) fn records_for_virtual_mcp_for_account(
        &self,
        account: &SandboxAccount,
        virtual_mcp_id: &str,
    ) -> Result<Vec<super::registry::SandboxRecord>, String> {
        self.validate_sandbox_account(account)?;
        let records = self
            .registry
            .records_for_virtual_mcp_for_account(account.storage(), virtual_mcp_id)?;
        self.validate_sandbox_account(account)?;
        Ok(records)
    }

    /// The handle whose preview label matches `label`, if any.
    ///
    /// Served from an in-memory map so the preview proxy's per-asset lookups
    /// never touch the filesystem or the database; the map is rebuilt from
    /// the registry after any registration change.
    fn handle_for_preview_label(&self, account: &SandboxAccount, label: &str) -> Option<String> {
        if let Some(cached) = self.preview_labels.read().ok()?.get(account.storage_key()) {
            return cached.get(label).cloned();
        }
        let handles = self.registry.handles_for_account(account.storage()).ok()?;
        let map: HashMap<String, String> = handles
            .into_iter()
            .map(|handle| {
                (
                    super::preview_label_for_scope(account.storage_key(), &handle),
                    handle,
                )
            })
            .collect();
        let found = map.get(label).cloned();
        self.preview_labels
            .write()
            .ok()?
            .insert(account.storage_key().to_string(), map);
        found
    }

    pub(crate) fn handle_for_preview_label_for_account(
        &self,
        account: &SandboxAccount,
        label: &str,
    ) -> Result<Option<String>, String> {
        self.validate_sandbox_account(account)?;
        let handle = self.handle_for_preview_label(account, label);
        self.validate_sandbox_account(account)?;
        Ok(handle)
    }

    /// Register a handle with the minimum a preview lookup needs, WITHOUT
    /// cloning anything. Test-only — production registration always goes
    /// through `provision`, which needs a real repository on disk; the preview
    /// Host fence needs only the registry row.
    #[cfg(test)]
    pub(crate) fn register_for_test(&self, clone_url: &str, branch: &str) -> String {
        let account = self.test_account().expect("test account");
        self.register_for_test_account(&account, clone_url, branch)
    }

    #[cfg(test)]
    pub(crate) fn register_for_test_account(
        &self,
        account: &SandboxAccount,
        clone_url: &str,
        branch: &str,
    ) -> String {
        let config = super::GitSandboxConfig {
            clone_url: clone_url.to_string(),
            branch: Some(branch.to_string()),
            virtual_mcp_id: "test-agent".to_string(),
            ..Default::default()
        };
        let handle = self
            .resolve_handle_for_config(account, &config, normalized_branch(&config))
            .expect("scopeable clone url");
        self.registry
            .upsert_config_for_account(account.storage(), &handle, &config)
            .expect("register test sandbox");
        self.invalidate_preview_labels(account);
        handle
    }

    /// Drop the label map so the next lookup rebuilds it. Called wherever a
    /// registry row is created or replaced.
    fn invalidate_preview_labels(&self, account: &SandboxAccount) {
        self.preview_labels
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(account.storage_key());
    }

    /// `<host>/<owner>/<repo>/<branch>` — the worktree's path under
    /// `worktrees/`, and its identity everywhere else.
    ///
    /// No `virtualMcpId`: the repository scope plus the FULL normalized branch
    /// identifies a worktree shared by every agent using that branch.
    ///
    /// The branch is slugified into one readable path segment. Whenever that
    /// transform changes or truncates the branch, a SHA-256 suffix of the full
    /// branch carries the identity that slugging would otherwise discard.
    /// Thus `feature/foo` and `feature-foo`, and two thread branches that only
    /// differ after the readable prefix, cannot silently share a worktree.
    ///
    /// One worktree per `(repo, branch)` is the deliberate consequence — two
    /// agents on one branch share it, which is the only honest thing to do
    /// with two working copies of the same branch.
    pub fn compute_handle(clone_url: &str, branch: &str) -> Option<String> {
        let branch = super::normalize_branch(Some(branch));
        let mut scope = super::repo_store::repo_scope(clone_url)?;
        scope.push(branch_handle_component(branch));
        Some(scope.join("/"))
    }

    /// Pre-hash identity accepted only when opening durable rows/sidecars
    /// written by an older build. New materializations always use
    /// [`Self::compute_handle`], while `resolve_handle_for_config` reuses an
    /// existing matching row so upgrades do not orphan a user's worktree.
    pub(crate) fn legacy_compute_handle(clone_url: &str, branch: &str) -> Option<String> {
        let branch = super::normalize_branch(Some(branch));
        let mut scope = super::repo_store::repo_scope(clone_url)?;
        scope.push(slugify_branch(branch));
        Some(scope.join("/"))
    }

    /// Collision escape for a readable component that was safe on its own but
    /// is already occupied by a legacy lossy branch row (for example an old
    /// `feature/foo` row at `feature-foo`).
    pub(crate) fn hashed_compute_handle(clone_url: &str, branch: &str) -> Option<String> {
        let branch = super::normalize_branch(Some(branch));
        let mut scope = super::repo_store::repo_scope(clone_url)?;
        scope.push(hashed_branch_handle_component(branch));
        Some(scope.join("/"))
    }

    fn resolve_handle_for_config(
        &self,
        account: &SandboxAccount,
        cfg: &GitSandboxConfig,
        branch: &str,
    ) -> Result<String, String> {
        let branch = super::normalize_branch(Some(branch));
        let expected = Self::compute_handle(&cfg.clone_url, branch)
            .ok_or_else(|| format!("clone URL cannot be scoped: {}", cfg.clone_url))?;
        let expected_scope = super::repo_store::repo_scope(&cfg.clone_url);
        let matches_config = |record: &super::registry::SandboxRecord| {
            normalized_branch(&record.config) == branch
                && super::repo_store::repo_scope(&record.config.clone_url) == expected_scope
        };
        let existing = self
            .registry
            .records_for_virtual_mcp_for_account(account.storage(), &cfg.virtual_mcp_id)?
            .into_iter()
            .filter(|record| matches_config(record))
            .max_by_key(|record| (record.handle == expected, record.last_seen_at));
        if let Some(existing) = existing {
            return Ok(existing.handle);
        }

        let expected_record = self
            .registry
            .record_for_account(account.storage(), &expected)?;
        if expected_record.as_ref().is_some_and(matches_config) {
            return Ok(expected);
        }
        let expected_sidecar =
            super::persist::read_sidecar_for_account(account.storage(), &expected)?;
        if expected_sidecar.as_ref().is_some_and(|config| {
            normalized_branch(config) == branch
                && super::repo_store::repo_scope(&config.clone_url) == expected_scope
        }) {
            return Ok(expected);
        }
        if expected_record.is_none() && expected_sidecar.is_none() {
            return Ok(expected);
        }

        let fallback = Self::hashed_compute_handle(&cfg.clone_url, branch)
            .ok_or_else(|| format!("clone URL cannot be scoped: {}", cfg.clone_url))?;
        if fallback == expected {
            return Err(format!(
                "sandbox handle {expected} is already occupied by a different branch"
            ));
        }
        let fallback_record = self
            .registry
            .record_for_account(account.storage(), &fallback)?;
        let fallback_sidecar =
            super::persist::read_sidecar_for_account(account.storage(), &fallback)?;
        let fallback_sidecar_mismatch = fallback_sidecar.as_ref().is_some_and(|config| {
            normalized_branch(config) != branch
                || super::repo_store::repo_scope(&config.clone_url) != expected_scope
        });
        if fallback_record
            .as_ref()
            .is_some_and(|record| !matches_config(record))
            || fallback_sidecar_mismatch
        {
            return Err(format!(
                "sandbox handle {fallback} is already occupied by a different branch"
            ));
        }
        Ok(fallback)
    }

    /// Bring up this sandbox's organization filesystem, and say in the
    /// transcript what happened.
    ///
    /// The VIEW is built synchronously: it is a handful of `mkdir`s and
    /// symlinks, and terminal launch gates the agent's org-filesystem prompt on
    /// that directory existing, so deferring it would let the first turn of
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
        let account = &sandbox.account;
        if let Err(error) = self.validate_sandbox_account(account) {
            self.report_org_fs(
                sandbox,
                format!(
                    "[org-fs] account authorization expired before building the org/ view for '{org_slug}': {error}\r\n"
                ),
            )
            .await;
            return;
        }
        let linked = super::org_view::ensure_org_view(account.storage(), handle, org_slug).await;
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

        let mounted = match self.wait_org_mount_ready(account, org_slug).await {
            Ok(mounted) => mounted,
            Err(error) => {
                tracing::warn!(
                    account_id = account.storage().id(),
                    org_slug,
                    %error,
                    "failed to wait for account-scoped org filesystem"
                );
                false
            }
        };
        // Announce only when the answer CHANGES for this sandbox. `ensure`
        // runs on every dispatch, and each run re-announced — so a chat with
        // ten turns printed ten identical `ready` lines into the setup
        // transcript. The line exists to disambiguate "empty org" from "no
        // org filesystem"; repeating it says nothing new.
        {
            let mut last = sandbox
                .org_fs_announced
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if *last == Some(mounted) {
                return;
            }
            *last = Some(mounted);
        }
        let line = if mounted {
            format!("[org-fs] organization filesystem ready for '{org_slug}'\r\n")
        } else {
            format!(
                "[org-fs] organization filesystem for '{org_slug}' is NOT mounted — org/ will read as empty\r\n"
            )
        };
        self.report_org_fs(sandbox, line).await;
    }

    /// Begin warming one organization's mounts under the exact authenticated
    /// sandbox account. The mount manager remains private so routes cannot
    /// bypass the account proof.
    pub(crate) fn warm_org_mount(
        &self,
        account: &SandboxAccount,
        org_slug: &str,
    ) -> Result<(), String> {
        self.validate_sandbox_account(account)?;
        self.org_mounts.warm(account, org_slug)
    }

    pub(crate) async fn wait_org_mount_ready(
        &self,
        account: &SandboxAccount,
        org_slug: &str,
    ) -> Result<bool, String> {
        self.validate_sandbox_account(account)?;
        self.org_mounts.wait_ready(account, org_slug).await
    }

    /// Cleanup-only transition path. `drain_account` accepts the retained
    /// retired identity after normal admission has closed and leaves a
    /// tombstone until cleanup has positively completed.
    pub(crate) async fn retire_org_mounts(&self, account: &SandboxAccount) -> Result<(), String> {
        account.verify_retired_storage()?;
        self.org_mounts.drain_account(account).await
    }

    pub(crate) async fn shutdown_org_mounts(&self) -> Result<(), String> {
        self.org_mounts.drain_all().await
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
    /// so it is known even when [`Self::ensure_for_account`] never succeeded.
    ///
    /// Exists so a failed `ensure` cannot route a git-backed run into the
    /// process-global `state.repo_dir`. That directory is shared by every
    /// thread: falling back to it would let two threads write over each
    /// other's files, and would put the agent somewhere the user's worktree
    /// isn't — writes would silently land outside the branch they belong to.
    /// A git-backed run stays under its own handle or it doesn't run at all.
    #[cfg(test)]
    fn workdir_for(&self, cfg: &GitSandboxConfig) -> PathBuf {
        let account = self.test_account().expect("test account");
        // An unscopeable clone URL is not a git-backed sandbox; fall back to
        // the global repo dir exactly as a config with no repository does.
        let Some(handle) = self
            .resolve_handle_for_config(&account, cfg, normalized_branch(cfg))
            .ok()
            .or_else(|| Self::compute_handle(&cfg.clone_url, normalized_branch(cfg)))
        else {
            return self.app_root.join("repo");
        };
        account
            .storage()
            .workdir(&handle)
            .expect("safe test handle")
    }

    /// Looks up an already-created sandbox by handle — used by
    /// `routes/proxy.rs` to resolve the sniffed dev port for a specific
    /// handle. Returns `None` for a handle never `ensure()`-d (never
    /// creates one — that's `ensure()`'s job).
    fn get(&self, account: &SandboxAccount, handle: &str) -> Option<Arc<Sandbox>> {
        self.lock_sandboxes()
            .get(&(account.storage_key().to_string(), handle.to_string()))
            .cloned()
    }

    pub(crate) fn get_for_account(
        &self,
        account: &SandboxAccount,
        handle: &str,
    ) -> Result<Option<Arc<Sandbox>>, String> {
        self.validate_sandbox_account(account)?;
        let sandbox = self.get(account, handle);
        if sandbox.as_ref().is_some_and(|sandbox| {
            sandbox.account.epoch() != account.epoch()
                || sandbox.account.storage_key() != account.storage_key()
        }) {
            return Err(STALE_ACCOUNT_EPOCH.to_string());
        }
        self.validate_sandbox_account(account)?;
        Ok(sandbox)
    }

    /// Stable `Arc` snapshot used by shutdown. No manager lock is held while
    /// child processes are signaled or awaited.
    fn snapshot(&self) -> Vec<Arc<Sandbox>> {
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
            // `begin_shutdown` closes admission and signals owners before it
            // constructs the returned future. Dropping that first-phase
            // future is intentional here; `shutdown_all` owns the bounded
            // quiescence wait after every sandbox has been fenced.
            drop(sandbox.mutations.begin_shutdown(TASK_TERM_GRACE));
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
            let mutations = sandbox.mutations.begin_shutdown(term_grace).await;
            let result = sandbox.setup.shutdown(term_grace, kill_grace).await;
            SandboxShutdownResult {
                account_id: sandbox.account.storage().id().to_string(),
                handle: sandbox.handle.clone(),
                mutations,
                result,
            }
        }))
        .await
    }

    /// Capture the current account epoch while the caller holds the upstream
    /// account-transition lock. The opaque ticket must accompany every later
    /// account-derived sandbox resolution or materialization.
    pub(crate) fn account_epoch(&self) -> AccountEpoch {
        self.materialization_gate.account_epoch()
    }

    /// Mint the complete managed-sandbox account proof while the caller holds
    /// the upstream session transition guard. Opening the private storage root
    /// happens between two epoch checks; a concurrent transition may leave an
    /// empty account directory, but can never publish it as the current scope.
    pub(crate) fn sandbox_account(
        &self,
        epoch: AccountEpoch,
        scope: &RtAccountScope,
    ) -> Result<SandboxAccount, String> {
        self.materialization_gate.validate(epoch)?;
        let storage_key: Arc<str> = Arc::from(scope.storage_key());
        let storage = AccountStorage::open(&self.app_root, &storage_key)?;
        self.materialization_gate.bind(epoch, storage_key.clone())?;
        storage.verify()?;
        Ok(SandboxAccount {
            epoch,
            storage_key,
            storage,
            gate: self.materialization_gate.clone(),
        })
    }

    pub(crate) fn validate_sandbox_account(&self, account: &SandboxAccount) -> Result<(), String> {
        account.validate()
    }

    /// Revalidate a ticket immediately before an account-derived side effect.
    /// Launch preparation uses this for phases that do not materialize a git
    /// sandbox (for example org directories and managed harness artifacts).
    pub(crate) fn validate_account_epoch(&self, epoch: AccountEpoch) -> Result<(), String> {
        self.materialization_gate.validate(epoch)
    }

    /// Subscribe to account replacement without a validate/subscribe gap.
    /// Long-lived streams exit when the receiver differs from their ticket or
    /// reports a change.
    pub(crate) fn watch_account_epoch(
        &self,
        epoch: AccountEpoch,
    ) -> Result<tokio::sync::watch::Receiver<AccountEpoch>, String> {
        self.materialization_gate.watch_account_epoch(epoch)
    }

    pub(crate) fn with_sandbox_account<T>(
        &self,
        account: &SandboxAccount,
        commit: impl FnOnce() -> T,
    ) -> Result<T, String> {
        self.validate_sandbox_account(account)?;
        let _admission = self.admit_materialization(account.epoch)?;
        account.storage.verify()?;
        Ok(commit())
    }

    fn admit_materialization(
        &self,
        epoch: AccountEpoch,
    ) -> Result<MaterializationAdmission, String> {
        self.materialization_gate.admit(epoch)
    }

    /// Begin the native half of an account/logout transition. Epoch advance
    /// and publication close are one synchronous state-lock operation, so an
    /// old request either already owns a short materialization admission (and
    /// will be drained) or can never publish behind the later sweep snapshot.
    pub(crate) async fn begin_account_transition(
        self: &Arc<Self>,
    ) -> Result<SandboxAccountTransitionGuard, String> {
        let transition = self.account_transition_lock.clone().lock_owned().await;
        let (closure, retired) = self.materialization_gate.advance_and_close()?;
        let retired = match retired {
            Some((epoch, storage_key)) => {
                let storage = AccountStorage::open(&self.app_root, &storage_key)?;
                Some(SandboxAccount {
                    epoch,
                    storage_key,
                    storage,
                    gate: self.materialization_gate.clone(),
                })
            }
            None => None,
        };
        Ok(SandboxAccountTransitionGuard {
            manager: self.clone(),
            _transition: transition,
            closure,
            retired,
        })
    }

    /// Resolves `handle`, resurrecting it from its persisted
    /// [`GitSandboxConfig`] sidecar (see the `persist` module doc) when it
    /// isn't currently known in memory — the common case after a backend
    /// process restart (a dev-loop rebuild, or the desktop app relaunching):
    /// the in-memory `sandboxes` map above starts empty every boot, but the
    /// workdir + sidecar survive on disk.
    ///
    /// - `Ok(Some(sandbox))` — already known, or successfully resurrected via
    ///   a fresh [`Self::ensure_for_account`] call against the persisted config (which
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
    #[cfg(test)]
    async fn resurrect(self: &Arc<Self>, handle: &str) -> Result<Option<Arc<Sandbox>>, String> {
        self.resurrect_at(&self.test_account()?, handle).await
    }

    pub(crate) async fn resurrect_for_account(
        self: &Arc<Self>,
        account: &SandboxAccount,
        handle: &str,
    ) -> Result<Option<Arc<Sandbox>>, String> {
        self.resurrect_at(account, handle).await
    }

    async fn resurrect_at(
        self: &Arc<Self>,
        account: &SandboxAccount,
        handle: &str,
    ) -> Result<Option<Arc<Sandbox>>, String> {
        self.validate_sandbox_account(account)?;
        if let Some(sandbox) = self.get_for_account(account, handle)? {
            if !sandbox.tasks.is_admission_closed() {
                return Ok(Some(sandbox));
            }
        }
        let cfg = match self
            .registry
            .record_for_account(account.storage(), handle)?
        {
            Some(record) => record.config,
            None => match super::persist::read_sidecar_for_account(account.storage(), handle)? {
                Some(config) => config,
                None => {
                    self.validate_sandbox_account(account)?;
                    return Ok(None);
                }
            },
        };
        let sandbox = self.provision_at(account, &cfg).await?;
        tracing::info!(
            handle = %handle,
            "sandbox resurrected from its persisted config (in-memory state was lost, likely a backend restart)"
        );
        Ok(Some(sandbox))
    }

    /// Headerless counterpart of [`Self::resurrect_for_account`]: consults the persisted
    /// "last active handle" pointer (survives a restart even though the
    /// in-memory `active_handle` field above doesn't — see [`Self::active_for_account`])
    /// and resurrects THAT handle. `Ok(None)` when nothing was ever
    /// persisted — a genuinely fresh process, or one that only ever used the
    /// plain non-git path.
    #[cfg(test)]
    async fn resurrect_active(self: &Arc<Self>) -> Result<Option<Arc<Sandbox>>, String> {
        self.resurrect_active_at(&self.test_account()?).await
    }

    pub(crate) async fn resurrect_active_for_account(
        self: &Arc<Self>,
        account: &SandboxAccount,
    ) -> Result<Option<Arc<Sandbox>>, String> {
        self.resurrect_active_at(account).await
    }

    async fn resurrect_active_at(
        self: &Arc<Self>,
        account: &SandboxAccount,
    ) -> Result<Option<Arc<Sandbox>>, String> {
        if let Some(sandbox) = self.active_for_account(account)? {
            if !sandbox.tasks.is_admission_closed() {
                return Ok(Some(sandbox));
            }
        }
        let handle = self.registry.active_handle_for_account(account.storage())?;
        self.validate_sandbox_account(account)?;
        let Some(handle) = handle else {
            return Ok(None);
        };
        self.resurrect_at(account, &handle).await
    }

    /// Materialize only the in-process routing objects for a persisted
    /// sandbox. Unlike [`Self::resurrect_for_account`], this never clones, installs, or
    /// starts anything. Observability uses it after a backend restart so an
    /// explicit `events?handle=...` can replay retained files before the user
    /// chooses to resume the sandbox.
    #[cfg(test)]
    async fn adopt(&self, handle: &str) -> Result<Option<Arc<Sandbox>>, String> {
        self.adopt_at(&self.test_account()?, handle).await
    }

    pub(crate) async fn adopt_for_account(
        &self,
        account: &SandboxAccount,
        handle: &str,
    ) -> Result<Option<Arc<Sandbox>>, String> {
        self.adopt_at(account, handle).await
    }

    async fn adopt_at(
        &self,
        account: &SandboxAccount,
        handle: &str,
    ) -> Result<Option<Arc<Sandbox>>, String> {
        self.validate_sandbox_account(account)?;
        if let Some(sandbox) = self.get_for_account(account, handle)? {
            return Ok(Some(sandbox));
        }
        let handle_lock = self.handle_lock(account, handle);
        let _permit = handle_lock.lock().await;
        if let Some(sandbox) = self.get_for_account(account, handle)? {
            return Ok(Some(sandbox));
        }
        let materialization = self.admit_materialization(account.epoch())?;
        // Re-read durable state only after winning the same handle lock used
        // by Stop. Reading before the lock can capture desired=running, wait
        // behind Stop, then accidentally reopen a generation after Stop has
        // durably changed the row to desired=stopped.
        let Some(record) = self
            .registry
            .record_for_account(account.storage(), handle)?
        else {
            return Ok(None);
        };
        crate::routes::fs::recover_mutation_stages(
            &account.storage().mutation_root(handle)?,
            &account.storage().workdir(handle)?,
        )
        .await
        .map_err(|error| format!("failed to recover sandbox mutations: {error}"))?;
        let stopped = record.desired_status == "stopped";
        let sandbox = if stopped {
            self.get_or_create_stopped_locked(account, handle)?
        } else {
            self.get_or_create_locked(account, handle)?
        };
        let branch = normalized_branch(&record.config).to_string();
        if let Err(error) = self.apply_config(&sandbox, &record.config, &branch) {
            self.lock_sandboxes()
                .remove(&(account.storage_key().to_string(), handle.to_string()));
            return Err(error);
        }
        drop(materialization);
        self.validate_sandbox_account(account)?;
        Self::monitor_branch_status(&sandbox);
        self.publish_generation(account, handle, Some(sandbox.clone()));
        tracing::info!(
            handle,
            "adopted persisted sandbox metadata without starting it"
        );
        Ok(Some(sandbox))
    }

    /// Stop fence for a durable sandbox generation. The first phase snapshots
    /// the live generation without waiting for its operation lock, closes
    /// setup admission, and reaps every task in that generation. That lets Stop
    /// preempt an `ensure` that is itself waiting on clone/checkout while it
    /// holds the operation lock. The second phase acquires that lock and
    /// evicts only when the snapshot is still current; a stale Stop can never
    /// remove or mark stopped a replacement generation. A stopped registered
    /// sandbox has no surviving child processes, including arbitrary execs.
    ///
    /// `Ok(None)` means the handle is truly unknown. A registered handle with
    /// no live object is already stopped and returns `Ok(Some(0))` without
    /// materializing it.
    #[cfg(test)]
    async fn stop_registered(&self, handle: &str) -> Result<Option<usize>, String> {
        self.stop_registered_generation(&self.test_account()?, handle)
            .await
    }

    pub(crate) async fn stop_registered_for_account(
        &self,
        account: &SandboxAccount,
        handle: &str,
    ) -> Result<Option<usize>, String> {
        self.stop_registered_generation(account, handle).await
    }

    /// Intent-named alias for callers deleting the whole sandbox generation.
    /// Registered Stop already guarantees full process quiescence, so delete
    /// deliberately shares the exact same fence and result contract. Durable
    /// registry metadata and the worktree remain available for lifecycle
    /// reporting or a later resume.
    #[cfg(test)]
    async fn delete_registered(&self, handle: &str) -> Result<Option<usize>, String> {
        self.stop_registered_generation(&self.test_account()?, handle)
            .await
    }

    pub(crate) async fn delete_registered_for_account(
        &self,
        account: &SandboxAccount,
        handle: &str,
    ) -> Result<Option<usize>, String> {
        self.stop_registered_generation(account, handle).await
    }

    /// Quiesce only live synthetic sandboxes owned by one exact Studio agent
    /// and thread. Account replacement calls this after terminal preparation
    /// drains: at that point a completed preparation may no longer have an
    /// active cancellation waiter, but its `thread:<id>` generation must not
    /// survive the account fence.
    ///
    /// Each durable identity is checked while holding the handle operation
    /// lock, then that exact live generation is closed and removed under the
    /// same lock. A concurrent provision therefore cannot replace the record
    /// with a real/shared branch between filtering and deletion.
    #[cfg(test)]
    async fn delete_live_thread_sandboxes(
        &self,
        virtual_mcp_id: &str,
        thread_id: &str,
    ) -> Result<usize, String> {
        self.delete_live_thread_sandboxes_at(&self.test_account()?, virtual_mcp_id, thread_id)
            .await
    }

    pub(crate) async fn delete_live_thread_sandboxes_for_account(
        &self,
        account: &SandboxAccount,
        virtual_mcp_id: &str,
        thread_id: &str,
    ) -> Result<usize, String> {
        self.delete_live_thread_sandboxes_at(account, virtual_mcp_id, thread_id)
            .await
    }

    async fn delete_live_thread_sandboxes_at(
        &self,
        account: &SandboxAccount,
        virtual_mcp_id: &str,
        thread_id: &str,
    ) -> Result<usize, String> {
        self.validate_sandbox_account(account)?;
        if virtual_mcp_id.is_empty() || thread_id.is_empty() {
            return Ok(0);
        }
        let handles = self
            .lock_sandboxes()
            .keys()
            .filter(|(scope, _)| scope == account.storage_key())
            .map(|(_, handle)| handle.clone())
            .collect::<Vec<_>>();
        let mut deleted = 0;
        let mut failures = Vec::new();
        for handle in handles {
            match self
                .delete_live_thread_sandbox(account, &handle, virtual_mcp_id, thread_id)
                .await
            {
                Ok(true) => deleted += 1,
                Ok(false) => {}
                Err(error) => failures.push(format!("{handle}: {error}")),
            }
        }
        if failures.is_empty() {
            Ok(deleted)
        } else {
            Err(format!(
                "could not delete synthetic thread sandbox(es): {}",
                failures.join("; ")
            ))
        }
    }

    async fn delete_live_thread_sandbox(
        &self,
        account: &SandboxAccount,
        handle: &str,
        virtual_mcp_id: &str,
        thread_id: &str,
    ) -> Result<bool, String> {
        let handle_lock = self.handle_lock(account, handle);
        let _permit = handle_lock.lock().await;
        self.validate_sandbox_account(account)?;
        let Some(record) = self
            .registry
            .record_for_account(account.storage(), handle)?
        else {
            return Ok(false);
        };
        if record.config.virtual_mcp_id != virtual_mcp_id
            || !matches!(
                super::synthetic_thread_id(normalized_branch(&record.config)),
                Ok(Some(record_thread_id)) if record_thread_id == thread_id
            )
        {
            return Ok(false);
        }
        let Some(sandbox) = self.get(account, handle) else {
            return Ok(false);
        };
        if sandbox.account.epoch() != account.epoch() {
            return Err(STALE_ACCOUNT_EPOCH.to_string());
        }

        let killed = match close_and_reap_generation(&sandbox).await {
            Ok(killed) => killed,
            Err(message) => {
                self.registry.mark_state_for_account(
                    account.storage(),
                    handle,
                    "stopped",
                    "failed",
                    Some(&message),
                )?;
                return Err(message);
            }
        };
        let still_current = self
            .get(account, handle)
            .is_some_and(|current| Arc::ptr_eq(&current, &sandbox));
        if !still_current {
            return Ok(false);
        }
        sandbox
            .setup
            .transition_lifecycle(json!({ "phase": "idle" }));
        self.lock_sandboxes()
            .remove(&(account.storage_key().to_string(), handle.to_string()));
        self.publish_generation(account, handle, None);
        self.registry.mark_state_for_account(
            account.storage(),
            handle,
            "stopped",
            "stopped",
            None,
        )?;
        tracing::info!(
            handle,
            virtual_mcp_id,
            thread_id,
            killed,
            "deleted live synthetic thread sandbox"
        );
        Ok(true)
    }

    async fn stop_registered_generation(
        &self,
        account: &SandboxAccount,
        handle: &str,
    ) -> Result<Option<usize>, String> {
        account.verify_retired_storage()?;
        if !self
            .registry
            .contains_for_account(account.storage(), handle)?
        {
            return Ok(None);
        }

        loop {
            let Some(sandbox) = self.get(account, handle) else {
                let handle_lock = self.handle_lock(account, handle);
                let _permit = handle_lock.lock().await;
                account.verify_retired_storage()?;
                // A concurrent ensure may have inserted the generation before
                // releasing the lock we just acquired. Restart the preemption
                // phase so it is closed and reaped outside this lock too.
                if self.get(account, handle).is_some() {
                    continue;
                }
                let record = self
                    .registry
                    .record_for_account(account.storage(), handle)?
                    .ok_or_else(|| format!("unknown sandbox handle: {handle}"))?;
                let observed = if record.sandbox_path.is_dir() {
                    "stopped"
                } else {
                    "absent"
                };
                self.registry.mark_state_for_account(
                    account.storage(),
                    handle,
                    "stopped",
                    observed,
                    record.error.as_deref(),
                )?;
                return Ok(Some(0));
            };
            if sandbox.account.epoch() != account.epoch()
                || sandbox.account.storage_key() != account.storage_key()
            {
                return Err(STALE_ACCOUNT_EPOCH.to_string());
            }

            let termination = close_and_reap_generation(&sandbox).await;

            let handle_lock = self.handle_lock(account, handle);
            let _permit = handle_lock.lock().await;
            account.verify_retired_storage()?;
            let still_current = self
                .get(account, handle)
                .is_some_and(|current| Arc::ptr_eq(&current, &sandbox));
            if !still_current {
                // Another stop already evicted this snapshot and a later
                // provision installed a replacement. Its lifecycle and
                // durable state belong to that newer generation.
                return termination.map(Some);
            }

            let killed = match termination {
                Ok(killed) => killed,
                Err(message) => {
                    self.registry.mark_state_for_account(
                        account.storage(),
                        handle,
                        "stopped",
                        "failed",
                        Some(&message),
                    )?;
                    return Err(message);
                }
            };
            sandbox
                .setup
                .transition_lifecycle(json!({ "phase": "idle" }));
            self.lock_sandboxes()
                .remove(&(account.storage_key().to_string(), handle.to_string()));
            self.publish_generation(account, handle, None);
            self.registry.mark_state_for_account(
                account.storage(),
                handle,
                "stopped",
                "stopped",
                None,
            )?;
            return Ok(Some(killed));
        }
    }

    /// Reclaim a durable sandbox after the caller has explicitly confirmed
    /// that its worktree may be removed. Unlike Stop, this deletes the local
    /// worktree and durable registry row so the branch can later be recreated.
    #[cfg(test)]
    async fn remove_registered(&self, handle: &str) -> Result<Option<usize>, String> {
        self.remove_registered_at(&self.test_account()?, handle)
            .await
    }

    pub(crate) async fn remove_registered_for_account(
        &self,
        account: &SandboxAccount,
        handle: &str,
    ) -> Result<Option<usize>, String> {
        self.remove_registered_at(account, handle).await
    }

    async fn remove_registered_at(
        &self,
        account: &SandboxAccount,
        handle: &str,
    ) -> Result<Option<usize>, String> {
        account.verify_retired_storage()?;
        if !self
            .registry
            .contains_for_account(account.storage(), handle)?
        {
            return Ok(None);
        }

        let mut killed = 0usize;
        loop {
            let Some(stopped) = self.stop_registered_generation(account, handle).await? else {
                return Ok(None);
            };
            killed = killed.saturating_add(stopped);

            let handle_lock = self.handle_lock(account, handle);
            let _permit = handle_lock.lock().await;
            account.verify_retired_storage()?;

            // A provision can win the gap after Stop releases the operation
            // lock. Preempt that replacement before deleting the directory;
            // once this lock is held with no live generation, provision and
            // git mutations are fenced until reclamation is complete.
            if self.get(account, handle).is_some() {
                continue;
            }
            let Some(record) = self
                .registry
                .record_for_account(account.storage(), handle)?
            else {
                return Ok(None);
            };

            let root = account.storage().worktree_root(handle)?;
            match tokio::fs::remove_dir_all(&root).await {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    return Err(format!(
                        "failed to remove sandbox worktree {root:?}: {error}"
                    ));
                }
            }

            // Removing the directory is not enough: the shared canonical repo
            // still records it as a git worktree until it is pruned.
            if let Some(canonical) = account
                .storage()
                .canonical_repo_dir(&record.config.clone_url)?
            {
                super::repo_store::prune_canonical_repo(&canonical).await;
            }

            self.registry
                .remove_for_account(account.storage(), handle)?;
            self.invalidate_preview_labels(account);
            let active = self.registry.active_handle_for_account(account.storage())?;
            if let Some(sender) = self
                .active_watches
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .get(account.storage_key())
            {
                sender.send_replace(active);
            }
            tracing::info!(
                account = account.storage().id(),
                handle,
                killed,
                "sandbox reclaimed: worktree removed"
            );
            return Ok(Some(killed));
        }
    }

    /// Close exactly one in-memory process generation. This is used by the
    /// terminal cancellation owner, which already holds the Arc it created;
    /// resolving by handle again could otherwise let a delayed account-A
    /// cancellation stop account B's replacement generation.
    async fn stop_exact_generation(&self, sandbox: &Arc<Sandbox>) -> Result<Option<usize>, String> {
        let termination = close_and_reap_generation(sandbox).await;
        let handle_lock = self.handle_lock(&sandbox.account, &sandbox.handle);
        let _permit = handle_lock.lock().await;
        let still_current = self
            .get(&sandbox.account, &sandbox.handle)
            .is_some_and(|current| Arc::ptr_eq(&current, sandbox));
        if !still_current {
            return termination.map(Some);
        }
        let killed = match termination {
            Ok(killed) => killed,
            Err(message) => {
                self.registry.mark_state_for_account(
                    sandbox.account.storage(),
                    &sandbox.handle,
                    "stopped",
                    "failed",
                    Some(&message),
                )?;
                return Err(message);
            }
        };
        sandbox
            .setup
            .transition_lifecycle(json!({ "phase": "idle" }));
        self.lock_sandboxes().remove(&(
            sandbox.account.storage_key().to_string(),
            sandbox.handle.clone(),
        ));
        self.publish_generation(&sandbox.account, &sandbox.handle, None);
        self.registry.mark_state_for_account(
            sandbox.account.storage(),
            &sandbox.handle,
            "stopped",
            "stopped",
            None,
        )?;
        Ok(Some(killed))
    }

    /// Restart one live registered generation without closing it. The old
    /// dev process is fully reaped under the per-handle lock before Start is
    /// admitted, preventing old/new servers from racing for the same port.
    pub(crate) async fn restart_registered_for_account(
        &self,
        account: &SandboxAccount,
        handle: &str,
    ) -> Result<Option<usize>, String> {
        self.restart_registered_at(account, handle).await
    }

    async fn restart_registered_at(
        &self,
        account: &SandboxAccount,
        handle: &str,
    ) -> Result<Option<usize>, String> {
        self.validate_sandbox_account(account)?;
        if !self
            .registry
            .contains_for_account(account.storage(), handle)?
        {
            return Ok(None);
        }
        let handle_lock = self.handle_lock(account, handle);
        let _permit = handle_lock.lock().await;
        self.validate_sandbox_account(account)?;
        let Some(sandbox) = self.get(account, handle) else {
            return Ok(None);
        };
        if sandbox.account.epoch() != account.epoch() {
            return Err(STALE_ACCOUNT_EPOCH.to_string());
        }
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
        self.registry.mark_state_for_account(
            account.storage(),
            handle,
            "running",
            "starting",
            None,
        )?;
        self.registry.mark_observed_for_account(
            account.storage(),
            handle,
            "starting",
            None,
            Some("start"),
        )?;
        Ok(Some(killed))
    }

    /// UI control-plane entry point. It durably registers and activates the
    /// sandbox, then returns as soon as the serialized setup worker accepts
    /// the appropriate step. Unlike [`Self::ensure_for_account`], it does not await git:
    /// the caller can connect `events?handle=...` immediately and watch clone
    /// output live, and Stop can fence/cancel that generation while clone or
    /// install is still running.
    #[cfg(test)]
    async fn provision(self: &Arc<Self>, cfg: &GitSandboxConfig) -> Result<Arc<Sandbox>, String> {
        self.provision_at(&self.test_account()?, cfg).await
    }

    pub(crate) async fn provision_for_account(
        self: &Arc<Self>,
        account: &SandboxAccount,
        cfg: &GitSandboxConfig,
    ) -> Result<Arc<Sandbox>, String> {
        self.provision_at(account, cfg).await
    }

    async fn provision_at(
        self: &Arc<Self>,
        account: &SandboxAccount,
        cfg: &GitSandboxConfig,
    ) -> Result<Arc<Sandbox>, String> {
        self.validate_sandbox_account(account)?;
        if self.is_closing() {
            return Err("sandbox manager is shutting down".to_string());
        }
        let branch = normalized_branch(cfg).to_string();
        let handle = self.resolve_handle_for_config(account, cfg, &branch)?;
        let handle_lock = self.handle_lock(account, &handle);
        let _permit = handle_lock.lock().await;
        self.provision_locked(account, cfg, &handle, &branch).await
    }

    /// Fail-fast control-plane variant for callers that already retain a
    /// higher-level lifecycle fence. `Ok(None)` means another ensure/provision
    /// owns this handle's operation lock; the caller must surface Busy instead
    /// of queuing behind a potentially stalled clone while holding its fence.
    #[cfg(test)]
    async fn try_provision(
        self: &Arc<Self>,
        cfg: &GitSandboxConfig,
    ) -> Result<Option<Arc<Sandbox>>, String> {
        self.try_provision_at(&self.test_account()?, cfg).await
    }

    pub(crate) async fn try_provision_for_account(
        self: &Arc<Self>,
        account: &SandboxAccount,
        cfg: &GitSandboxConfig,
    ) -> Result<Option<Arc<Sandbox>>, String> {
        self.try_provision_at(account, cfg).await
    }

    async fn try_provision_at(
        self: &Arc<Self>,
        account: &SandboxAccount,
        cfg: &GitSandboxConfig,
    ) -> Result<Option<Arc<Sandbox>>, String> {
        self.validate_sandbox_account(account)?;
        if self.is_closing() {
            return Err("sandbox manager is shutting down".to_string());
        }
        let branch = normalized_branch(cfg).to_string();
        let handle = self.resolve_handle_for_config(account, cfg, &branch)?;
        let handle_lock = self.handle_lock(account, &handle);
        let Ok(_permit) = handle_lock.try_lock_owned() else {
            return Ok(None);
        };
        self.provision_locked(account, cfg, &handle, &branch)
            .await
            .map(Some)
    }

    async fn provision_locked(
        self: &Arc<Self>,
        account: &SandboxAccount,
        cfg: &GitSandboxConfig,
        handle: &str,
        branch: &str,
    ) -> Result<Arc<Sandbox>, String> {
        if self.is_closing() {
            return Err("sandbox manager is shutting down".to_string());
        }

        self.validate_sandbox_account(account)?;
        let materialization = self.admit_materialization(account.epoch())?;
        self.evict_closed_generation_locked(account, handle);
        let was_known = self.get(account, handle).is_some();
        let previous_record = self
            .registry
            .record_for_account(account.storage(), handle)?;
        let canonical_config = merge_durable_config(cfg, previous_record.as_ref())?;
        crate::routes::fs::recover_mutation_stages(
            &account.storage().mutation_root(handle)?,
            &account.storage().workdir(handle)?,
        )
        .await
        .map_err(|error| format!("failed to recover sandbox mutations: {error}"))?;
        let sandbox = self.get_or_create_locked(account, handle)?;
        let was_running = dev_task_running(&sandbox);
        let pipeline_in_flight = sandbox.setup.is_running() || sandbox.setup.pending_count() > 0;
        let transition = match self.apply_config(&sandbox, &canonical_config, branch) {
            Ok(transition) => transition,
            Err(error) => {
                if !was_known {
                    self.lock_sandboxes()
                        .remove(&(account.storage_key().to_string(), handle.to_string()));
                }
                return Err(error);
            }
        };
        self.registry
            .upsert_config_for_account(account.storage(), handle, &canonical_config)?;
        // This is the complete materialization commit: the Arc is visible in
        // `sandboxes` and its durable row makes it addressable by Stop. Keep
        // the manager-wide account-transition drain independent of org I/O,
        // sidecars, monitors, checkout, and setup.
        drop(materialization);
        self.invalidate_preview_labels(account);
        // The sandbox's view onto the shared org filesystem. Best-effort by
        // design (see `org_view`): a sandbox whose view cannot be built still
        // runs, the agent simply has no org files — the same outcome as a
        // mount that is down.
        if let Some(org_slug) = canonical_config.org_slug.as_deref() {
            self.ensure_org_filesystem(&sandbox, handle, org_slug).await;
        }
        self.set_active_at(account, handle)?;
        super::persist::write_sidecar_for_account(account.storage(), handle, &canonical_config)?;
        self.validate_sandbox_account(account)?;
        self.publish_generation(account, handle, Some(sandbox.clone()));
        Self::monitor_branch_status(&sandbox);

        if transition == "no-op" && (was_running || pipeline_in_flight) {
            if sandbox.broadcaster.subscriber_count() > 0 {
                crate::routes::git::emit_branch_event(
                    sandbox.tasks.clone(),
                    &sandbox.workdir,
                    &sandbox.broadcaster,
                )
                .await;
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
            self.registry.mark_state_for_account(
                account.storage(),
                handle,
                "running",
                observed,
                error,
            )?;
            self.validate_sandbox_account(account)?;
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
            crate::routes::git::owned_is_git_repo(sandbox.tasks.clone(), sandbox.workdir.clone())
                .await?
        };
        if !repo_valid {
            repair_invalid_workdir_owned(
                &sandbox,
                account.storage().clone(),
                canonical_config.clone_url.clone(),
            )
            .await?;
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
            crate::routes::git::emit_branch_event(
                sandbox.tasks.clone(),
                &sandbox.workdir,
                &sandbox.broadcaster,
            )
            .await;
        }
        if !sandbox.setup.resume_from(step) {
            let message = format!("setup worker rejected the {} step", step.as_str());
            let _ = self.registry.mark_state_for_account(
                account.storage(),
                handle,
                "running",
                "failed",
                Some(&message),
            );
            return Err(format!("sandbox {handle} {message}"));
        }
        let observed = if step == Step::Start {
            "starting"
        } else {
            "provisioning"
        };
        self.registry.mark_state_for_account(
            account.storage(),
            handle,
            "running",
            observed,
            None,
        )?;
        self.registry.mark_observed_for_account(
            account.storage(),
            handle,
            observed,
            None,
            Some(step.as_str()),
        )?;
        self.validate_sandbox_account(account)?;
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
        let account = sandbox.account.clone();
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
                if account.validate().is_err() {
                    return;
                }
                let Some(current) = manager.get(&account, &handle) else {
                    return;
                };
                if !Arc::ptr_eq(&generation, &current) {
                    return;
                }
                if let Err(error) = manager.registry.mark_observed_for_account(
                    account.storage(),
                    &handle,
                    observed,
                    error,
                    resume_step,
                ) {
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
    #[cfg(test)]
    pub(crate) async fn ensure(
        self: &Arc<Self>,
        cfg: &GitSandboxConfig,
    ) -> Result<Arc<Sandbox>, String> {
        self.ensure_at(&self.test_account()?, cfg).await
    }

    #[cfg(test)]
    pub(crate) async fn ensure_for_account(
        self: &Arc<Self>,
        account: &SandboxAccount,
        cfg: &GitSandboxConfig,
    ) -> Result<Arc<Sandbox>, String> {
        self.ensure_at(account, cfg).await
    }

    #[cfg(test)]
    async fn ensure_at(
        self: &Arc<Self>,
        account: &SandboxAccount,
        cfg: &GitSandboxConfig,
    ) -> Result<Arc<Sandbox>, String> {
        let sandbox = self
            .ensure_inner_at(account, cfg, std::future::ready(()))
            .await?;
        self.monitor_registry_lifecycle(&sandbox);
        Self::monitor_branch_status(&sandbox);
        Ok(sandbox)
    }

    /// Account-scoped terminal preparation with a lifecycle
    /// cancellation owner that outlives the caller's future. Before the
    /// generation is materialized, cancellation prevents any sandbox from
    /// being created. Afterwards, a synthetic per-thread branch is torn down
    /// through the normal Stop fence, while a real shared branch transfers
    /// the in-flight ensure to the manager-owned coordinator.
    pub(crate) async fn ensure_for_terminal(
        self: &Arc<Self>,
        account: &SandboxAccount,
        cfg: &GitSandboxConfig,
        cancel: tokio::sync::watch::Receiver<bool>,
        teardown_on_cancel: bool,
    ) -> Result<Arc<Sandbox>, TerminalEnsureError> {
        let manager = self.clone();
        let account = account.clone();
        let config = cfg.clone();
        tokio::spawn(async move {
            manager
                .ensure_for_terminal_owned(account, &config, cancel, teardown_on_cancel)
                .await
        })
        .await
        .map_err(|error| {
            TerminalEnsureError::Failed(format!(
                "terminal sandbox preparation coordinator failed: {error}"
            ))
        })?
    }

    async fn ensure_for_terminal_owned(
        self: &Arc<Self>,
        account: SandboxAccount,
        cfg: &GitSandboxConfig,
        mut cancel: tokio::sync::watch::Receiver<bool>,
        teardown_on_cancel: bool,
    ) -> Result<Arc<Sandbox>, TerminalEnsureError> {
        if *cancel.borrow() {
            return Err(TerminalEnsureError::Canceled);
        }

        let canceled = Arc::new(AtomicBool::new(false));
        let (materialized_tx, mut materialized_rx) = tokio::sync::oneshot::channel();
        let control = TerminalEnsureControl {
            canceled: canceled.clone(),
            cancel: cancel.clone(),
            materialized: materialized_tx,
        };
        let manager = self.clone();
        let config = cfg.clone();
        let mut ensure_task = tokio::spawn(async move {
            let sandbox = manager
                .ensure_inner_with_control(&account, &config, std::future::ready(()), Some(control))
                .await?;
            manager.monitor_registry_lifecycle(&sandbox);
            Self::monitor_branch_status(&sandbox);
            Ok::<_, String>(sandbox)
        });

        // Cancellation and materialization form one linearized race. If the
        // cancellation observer wins, the core owner either exits before
        // creating anything or reports the exact generation it created; it
        // cannot publish or spawn clone/setup work between those outcomes.
        let mut cancellation_seen = false;
        let materialized = loop {
            if cancellation_seen {
                tokio::select! {
                    materialized = &mut materialized_rx => match materialized {
                        Ok(materialized) => break materialized,
                        Err(_) => return map_terminal_ensure_result(ensure_task.await),
                    },
                    result = &mut ensure_task => return map_terminal_ensure_result(result),
                }
            } else {
                tokio::select! {
                    biased;
                    _ = wait_terminal_cancellation(&mut cancel) => {
                        canceled.store(true, Ordering::SeqCst);
                        cancellation_seen = true;
                    }
                    materialized = &mut materialized_rx => match materialized {
                        Ok(materialized) => break materialized,
                        Err(_) => return map_terminal_ensure_result(ensure_task.await),
                    },
                    result = &mut ensure_task => return map_terminal_ensure_result(result),
                }
            }
        };

        let sandbox = materialized.sandbox;
        // Never leave the core ensure holding the per-handle operation lock
        // behind this coordination latch. Stop can now close the materialized
        // generation before it queues for that same lock.
        let _ = materialized.resume.send(());

        if cancellation_seen || *cancel.borrow() {
            canceled.store(true, Ordering::SeqCst);
            return self
                .finish_terminal_ensure_cancellation(sandbox, teardown_on_cancel, ensure_task)
                .await;
        }

        tokio::select! {
            biased;
            _ = wait_terminal_cancellation(&mut cancel) => {
                canceled.store(true, Ordering::SeqCst);
                self.finish_terminal_ensure_cancellation(
                    sandbox,
                    teardown_on_cancel,
                    ensure_task,
                ).await
            }
            result = &mut ensure_task => map_terminal_ensure_result(result),
        }
    }

    async fn finish_terminal_ensure_cancellation(
        self: &Arc<Self>,
        sandbox: Arc<Sandbox>,
        teardown_on_cancel: bool,
        ensure_task: tokio::task::JoinHandle<Result<Arc<Sandbox>, String>>,
    ) -> Result<Arc<Sandbox>, TerminalEnsureError> {
        if !teardown_on_cancel {
            // Dropping a Tokio JoinHandle detaches the manager-owned owner;
            // the shared branch remains valid for other terminals/threads.
            drop(ensure_task);
            return Err(TerminalEnsureError::Canceled);
        }

        // `delete_registered` snapshots and closes this generation before it
        // waits for the handle lock held by ensure. If a later provision wins
        // that lock first, its pointer check preserves the replacement.
        let teardown = self.stop_exact_generation(&sandbox).await;
        let _ = ensure_task.await;
        match teardown {
            Ok(Some(_)) => Err(TerminalEnsureError::Canceled),
            Ok(None) => Err(TerminalEnsureError::Failed(format!(
                "materialized terminal sandbox disappeared before teardown: {}",
                sandbox.handle
            ))),
            Err(error) => Err(TerminalEnsureError::Failed(format!(
                "could not tear down canceled terminal sandbox {}: {error}",
                sandbox.handle
            ))),
        }
    }

    /// Implementation seam used by the concurrency regression test to pause a
    /// caller immediately AFTER it acquires the per-handle operation lock. In
    /// production `ensure()` passes a ready future, so this adds no behavior;
    /// the seam lets the test prove the second caller cannot enter until the
    /// first has completed the whole git/config operation (rather than merely
    /// waiting for the `Sandbox` map insertion).
    #[cfg(test)]
    async fn ensure_inner<F>(
        &self,
        cfg: &GitSandboxConfig,
        after_lock: F,
    ) -> Result<Arc<Sandbox>, String>
    where
        F: std::future::Future<Output = ()>,
    {
        self.ensure_inner_at(&self.test_account()?, cfg, after_lock)
            .await
    }

    #[cfg(test)]
    async fn ensure_inner_at<F>(
        &self,
        account: &SandboxAccount,
        cfg: &GitSandboxConfig,
        after_lock: F,
    ) -> Result<Arc<Sandbox>, String>
    where
        F: std::future::Future<Output = ()>,
    {
        self.ensure_inner_with_control(account, cfg, after_lock, None)
            .await
    }

    async fn ensure_inner_with_control<F>(
        &self,
        account: &SandboxAccount,
        cfg: &GitSandboxConfig,
        after_lock: F,
        mut terminal_control: Option<TerminalEnsureControl>,
    ) -> Result<Arc<Sandbox>, String>
    where
        F: std::future::Future<Output = ()>,
    {
        self.validate_sandbox_account(account)?;
        if self.is_closing() {
            return Err("sandbox manager is shutting down".to_string());
        }
        let branch = normalized_branch(cfg).to_string();
        let handle = self.resolve_handle_for_config(account, cfg, &branch)?;

        // Serialize the ENTIRE ensure operation for one handle. The previous
        // implementation released this lock immediately after inserting the
        // shared `Sandbox` Arc, which still let both callers race
        // `clone::run()` against the same not-yet-created `.git` directory.
        // That produced intermittent successful `ensure()` results backed by
        // a missing/half-created worktree under the full parallel test suite.
        let handle_lock = self.handle_lock(account, &handle);
        let _permit = if let Some(control) = terminal_control.as_mut() {
            tokio::select! {
                biased;
                _ = wait_terminal_cancellation(&mut control.cancel) => {
                    return Err(TERMINAL_ENSURE_CANCELED.to_string());
                }
                permit = handle_lock.lock() => permit,
            }
        } else {
            handle_lock.lock().await
        };
        // Stop deliberately closes a live generation before waiting for this
        // operation lock. Remember the generation visible on entry so a
        // concurrent Stop cannot turn this in-flight owner into an implicit
        // restart after `after_lock` releases its process.
        let generation_at_entry = self.get(account, &handle);
        after_lock.await;

        if generation_at_entry
            .as_ref()
            .is_some_and(|sandbox| sandbox.tasks.is_admission_closed())
        {
            // A metadata generation that was already durably stopped before
            // this ensure won the handle lock may be explicitly resumed. A
            // concurrent Stop has only closed task admission at this point;
            // it cannot mark the durable row stopped until we release this
            // same lock, so reject it here even if the close raced the entry
            // snapshot above.
            let was_durably_stopped = self
                .registry
                .record_for_account(account.storage(), &handle)?
                .is_some_and(|record| record.desired_status == "stopped");
            if !was_durably_stopped {
                return Err("sandbox generation stopped during ensure".to_string());
            }
        }

        if self.is_closing() {
            return Err("sandbox manager is shutting down".to_string());
        }
        if terminal_control
            .as_ref()
            .is_some_and(|control| control.canceled.load(Ordering::SeqCst))
        {
            return Err(TERMINAL_ENSURE_CANCELED.to_string());
        }

        let materialization = self.admit_materialization(account.epoch())?;
        self.evict_closed_generation_locked(account, &handle);
        let previous_record = self
            .registry
            .record_for_account(account.storage(), &handle)?;
        let canonical_config = merge_durable_config(cfg, previous_record.as_ref())?;
        crate::routes::fs::recover_mutation_stages(
            &account.storage().mutation_root(&handle)?,
            &account.storage().workdir(&handle)?,
        )
        .await
        .map_err(|error| format!("failed to recover sandbox mutations: {error}"))?;
        let sandbox = self.get_or_create_locked(account, &handle)?;
        let transition = self.apply_config(&sandbox, &canonical_config, &branch)?;
        self.registry
            .upsert_config_for_account(account.storage(), &handle, &canonical_config)?;
        // The Arc and durable row are now one Stop-addressable generation.
        // Terminal coordination and all repository/setup work happen outside
        // the manager-wide drain lease.
        drop(materialization);
        if let Some(control) = terminal_control.take() {
            // This is the exact materialization latch: the generation is now
            // both present in-memory and durably addressable by Stop, while
            // no clone/setup process has started yet. Terminal cancellation
            // decides whether this owner resumes or is torn down.
            let (resume, resumed) = tokio::sync::oneshot::channel();
            if let Err(materialized) = control.materialized.send(TerminalEnsureMaterialized {
                sandbox: sandbox.clone(),
                resume,
            }) {
                // The public future may itself have been dropped. Its
                // manager-owned coordinator normally remains alive, but if
                // that coordinator was aborted too, completing ensure is
                // safer than stranding a half-materialized open generation.
                let _ = materialized.resume.send(());
            } else if resumed.await.is_err() {
                return Err(TERMINAL_ENSURE_CANCELED.to_string());
            }
        }
        self.invalidate_preview_labels(account);
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
        self.set_active_at(account, &handle)?;
        // Persist the exact config that got this handle here — see the
        // `persist` module doc: `compute_handle` is a one-way hash, so this
        // sidecar is the only way a LATER process (a restarted one that
        // forgot this handle's in-memory `Sandbox`) can `ensure()` it again
        // via [`Self::resurrect_for_account`]. Written only after `apply_config` above
        // succeeded, so a rejected/invalid patch never persists a bogus
        // sidecar.
        super::persist::write_sidecar_for_account(account.storage(), &handle, &canonical_config)?;
        self.validate_sandbox_account(account)?;
        self.publish_generation(account, &handle, Some(sandbox.clone()));

        // Repeated dispatches dominate this path. For an unchanged live
        // sandbox, one branch probe preserves the checkout guarantee; the
        // full clone/checkout path is reserved for creation, config changes,
        // or a managed workdir that drifted.
        let git_started = Instant::now();
        let (clone_ok, git_path) = match sandbox.setup.current_config() {
            Some(config)
                if transition == "no-op"
                    && checkout_is_current_owned(&sandbox, config.clone()).await? =>
            {
                (true, "current-checkout")
            }
            Some(config) => {
                let repaired = crate::setup::clone::run(&sandbox.setup, &config).await;
                let verified = repaired && checkout_is_current_owned(&sandbox, config).await?;
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
            let message = "git clone/checkout failed; inspect the setup log, then verify the repository exists and this machine's Git credentials can access it";
            let _ = self.registry.mark_state_for_account(
                account.storage(),
                &handle,
                "running",
                "failed",
                Some(message),
            );
            let _ = self.registry.mark_observed_for_account(
                account.storage(),
                &handle,
                "failed",
                Some(message),
                Some("clone"),
            );
            return Err(format!("sandbox {handle}: {message}"));
        }
        if git_path == "current-checkout" && sandbox.broadcaster.subscriber_count() > 0 {
            crate::routes::git::emit_branch_event(
                sandbox.tasks.clone(),
                &sandbox.workdir,
                &sandbox.broadcaster,
            )
            .await;
        }

        if transition != "no-op" {
            // Config changed (first use of this sandbox, or repo/runtime
            // changed) → run the full install → start cascade.
            if !sandbox.setup.resume_from(Step::Install) {
                let message = "setup worker rejected the install/start cascade";
                let _ = self.registry.mark_state_for_account(
                    account.storage(),
                    &handle,
                    "running",
                    "failed",
                    Some(message),
                );
                return Err(format!("sandbox {handle} {message}"));
            }
            self.registry.mark_state_for_account(
                account.storage(),
                &handle,
                "running",
                "provisioning",
                None,
            )?;
            self.registry.mark_observed_for_account(
                account.storage(),
                &handle,
                "provisioning",
                None,
                Some("install"),
            )?;
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
                let _ = self.registry.mark_state_for_account(
                    account.storage(),
                    &handle,
                    "running",
                    "failed",
                    Some(message),
                );
                return Err(format!("sandbox {handle} {message}"));
            }
            self.registry.mark_state_for_account(
                account.storage(),
                &handle,
                "running",
                "starting",
                None,
            )?;
            self.registry.mark_observed_for_account(
                account.storage(),
                &handle,
                "starting",
                None,
                Some("start"),
            )?;
        } else {
            self.registry.mark_state_for_account(
                account.storage(),
                &handle,
                "running",
                "running",
                None,
            )?;
            self.registry.mark_observed_for_account(
                account.storage(),
                &handle,
                "running",
                None,
                Some("start"),
            )?;
        }

        self.validate_sandbox_account(account)?;
        Ok(sandbox)
    }

    /// Returns the existing sandbox or constructs it. The caller MUST hold the
    /// corresponding [`Self::handle_lock`] permit; keeping this helper
    /// synchronous makes it impossible to accidentally suspend while a
    /// partially-built value is being inserted.
    fn get_or_create_locked(
        &self,
        account: &SandboxAccount,
        handle: &str,
    ) -> Result<Arc<Sandbox>, String> {
        self.get_or_create_locked_with_state(account, handle, false)
    }

    fn get_or_create_stopped_locked(
        &self,
        account: &SandboxAccount,
        handle: &str,
    ) -> Result<Arc<Sandbox>, String> {
        self.get_or_create_locked_with_state(account, handle, true)
    }

    fn get_or_create_locked_with_state(
        &self,
        account: &SandboxAccount,
        handle: &str,
        stopped: bool,
    ) -> Result<Arc<Sandbox>, String> {
        self.validate_sandbox_account(account)?;
        // One lock acquisition linearizes close-vs-create: if shutdown sets
        // `closing` while an ensure already holds this guard, its insertion is
        // visible to shutdown's later snapshot; if shutdown wins first, no new
        // sandbox can appear behind that snapshot.
        let mut sandboxes = self.lock_sandboxes();
        if self.is_closing() {
            return Err("sandbox manager is shutting down".to_string());
        }
        let key = (account.storage_key().to_string(), handle.to_string());
        if let Some(sandbox) = sandboxes.get(&key) {
            if sandbox.account.epoch() != account.epoch() {
                return Err(STALE_ACCOUNT_EPOCH.to_string());
            }
            return Ok(sandbox.clone());
        }

        let workdir = account.storage().workdir(handle)?;

        let config = Arc::new(ConfigStore::new());
        // `<app_root>/worktrees/<handle>/logs` — a sibling of `repo` above,
        // this handle's OWN durable log home (see the `log_store` module doc).
        // Isolated per handle so two branches of the same repo never share
        // (or race) a "setup"/"dev" transcript.
        let logs = Arc::new(LogStore::new(account.storage().logs_dir(handle)?));
        let child_lifetime_lock = self.app_root.join(".decocms").join("child-lifetime.lock");
        let tasks = Arc::new(if stopped {
            TaskRegistry::new_closed_with_child_lifetime_lock(logs, child_lifetime_lock)
        } else {
            TaskRegistry::new_with_child_lifetime_lock(logs, child_lifetime_lock)
        });
        let broadcaster = Arc::new(Broadcaster::new());
        let setup = SetupOrchestrator::new_for_sandbox(
            workdir.clone(),
            account.storage().clone(),
            config.clone(),
            tasks.clone(),
            broadcaster.clone(),
        );
        if stopped {
            setup.close();
        }
        let sandbox = Arc::new(Sandbox {
            handle: handle.to_string(),
            workdir,
            config,
            tasks,
            broadcaster,
            setup,
            mutations: Arc::new(MutationCoordinator::new()),
            account: account.clone(),
            registry_monitor_started: AtomicBool::new(false),
            branch_monitor_started: AtomicBool::new(false),
            org_fs_announced: Mutex::new(None),
        });
        sandboxes.insert(key, sandbox.clone());
        Ok(sandbox)
    }

    /// Explicit Start/provisioning replaces a metadata-only stopped
    /// generation instead of trying to reopen its permanent close fence.
    /// The caller holds this handle's async operation lock, so no two resume
    /// paths can install competing replacements.
    fn evict_closed_generation_locked(&self, account: &SandboxAccount, handle: &str) -> bool {
        let mut sandboxes = self.lock_sandboxes();
        let key = (account.storage_key().to_string(), handle.to_string());
        let closed = sandboxes
            .get(&key)
            .is_some_and(|sandbox| sandbox.tasks.is_admission_closed());
        if closed {
            sandboxes.remove(&key);
        }
        closed
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
        if sandbox.tasks.is_admission_closed() {
            return;
        }
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

                let next = crate::routes::git::owned_branch_snapshot(
                    sandbox.tasks.clone(),
                    sandbox.workdir.clone(),
                )
                .await;
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

    /// The per-handle operation lock also taken by `stop_registered` and
    /// `remove_registered`. Exposed so a caller that runs a git mutation
    /// directly against a sandbox's worktree (bypassing this manager) can
    /// serialize against a concurrent stop/reclaim of the SAME handle — see
    /// `intercept::sandbox_ops::route`'s `git/publish|discard|rebase` arms.
    pub(crate) fn handle_lock(
        &self,
        account: &SandboxAccount,
        handle: &str,
    ) -> Arc<tokio::sync::Mutex<()>> {
        let mut guard = self.lock_locks();
        guard
            .entry((account.storage_key().to_string(), handle.to_string()))
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

    fn lock_sandboxes(&self) -> std::sync::MutexGuard<'_, HashMap<SandboxKey, Arc<Sandbox>>> {
        match self.sandboxes.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    fn lock_locks(
        &self,
    ) -> std::sync::MutexGuard<'_, HashMap<SandboxKey, Arc<tokio::sync::Mutex<()>>>> {
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

async fn checkout_is_current_owned(sandbox: &Arc<Sandbox>, config: Value) -> Result<bool, String> {
    let setup = sandbox.setup.clone();
    let generation = sandbox.tasks.clone();
    let is_current = crate::routes::git::run_owned_git_probe(
        sandbox.tasks.clone(),
        "git checkout-current probe",
        async move { crate::setup::clone::checkout_is_current(&setup, &config).await },
    )
    .await?;
    if generation.is_admission_closed() {
        return Err("sandbox generation stopped during checkout-current probe".to_string());
    }
    Ok(is_current)
}

async fn repair_invalid_workdir_owned(
    sandbox: &Arc<Sandbox>,
    storage: AccountStorage,
    clone_url: String,
) -> Result<(), String> {
    let workdir = sandbox.workdir.clone();
    let canonical = storage.canonical_repo_dir(&clone_url)?;
    let generation = sandbox.tasks.clone();
    let operation_generation = generation.clone();
    crate::routes::git::run_owned_git_probe(
        sandbox.tasks.clone(),
        "repair invalid git worktree",
        async move {
            // A cancelled clone can leave an unusable non-empty destination.
            // The complete clear -> canonical prune -> recreate transaction is
            // a hidden generation task, so Stop cannot return while any part
            // of this repair is still mutating the worktree.
            let existed = tokio::fs::symlink_metadata(&workdir).await.is_ok();
            if existed {
                tokio::fs::remove_dir_all(&workdir).await.map_err(|error| {
                    format!("failed to clear invalid sandbox workdir {workdir:?}: {error}")
                })?;
                if let Some(canonical) = canonical.as_deref() {
                    // Best-effort for ordinary Git failures, as before. A
                    // lifecycle cancellation is detected from the generation
                    // fence after the directory has been restored below.
                    let _ = crate::routes::git::prune_worktree_registrations(canonical).await;
                }
            }
            tokio::fs::create_dir_all(&workdir).await.map_err(|error| {
                format!("failed to recreate sandbox workdir {workdir:?}: {error}")
            })?;
            if operation_generation.is_admission_closed() {
                return Err("sandbox generation stopped during worktree repair".to_string());
            }
            Ok(())
        },
    )
    .await??;
    if generation.is_admission_closed() {
        return Err("sandbox generation stopped during worktree repair".to_string());
    }
    Ok(())
}

/// Closes one generation's setup admission, then boundedly TERM/KILLs and
/// reaps every task registered to that generation.
///
/// This helper signals task owners through [`TaskRegistry`]; it does not own
/// or abort their futures. A caller cancelling a directly-driven setup future
/// (such as `clone::run`) must keep that owner polled concurrently until it
/// publishes terminal state. That is what makes the registry's terminal proof
/// trustworthy instead of dropping an owner and stranding its entry Running.
async fn close_and_reap_generation(sandbox: &Sandbox) -> Result<usize, String> {
    // Close both admission paths before awaiting either one. Filesystem
    // mutation owners and commit permits must quiesce before process reap can
    // certify this generation stopped; otherwise a detached write could land
    // in the worktree after Stop returned.
    sandbox.setup.close();
    let mutations = sandbox.mutations.begin_shutdown(TASK_TERM_GRACE).await;
    let result = sandbox
        .tasks
        .close_and_kill_all_and_wait(TASK_TERM_GRACE, TASK_KILL_REAP_DEADLINE)
        .await;
    if mutations.is_quiescent() && result.remaining.is_empty() {
        return Ok(result.term_signaled);
    }
    let mut failures = Vec::new();
    if !mutations.is_quiescent() {
        failures.push(format!(
            "filesystem mutations did not quiesce (owners_remaining={}, commit_quiescent={})",
            mutations.owners_remaining, mutations.commit_quiescent
        ));
    }
    if !result.remaining.is_empty() {
        failures.push(format!(
            "could not reap process task(s): {}",
            result.remaining.join(", ")
        ));
    }
    Err(failures.join("; "))
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
/// omit on a later `ensure` call. A handle identifies a repository + branch, so
/// accepting a different repository URL for an existing handle would silently
/// retarget the worktree. Optional workload and git-identity hints, on the
/// other hand, are merged from the prior record so a sparse control-plane
/// request cannot erase them.
///
/// The AGENT is deliberately not part of this check. A handle carries no agent
/// identity, so two agents on one repo+branch share the sandbox by design —
/// rejecting the second as an "identity mismatch" was a leftover from when a
/// handle was `(virtualMcpId, branch)`, and it made a perfectly ordinary
/// second agent fail with a 409. Both are recorded in `sandbox_agents`.
fn merge_durable_config(
    incoming: &GitSandboxConfig,
    previous: Option<&super::registry::SandboxRecord>,
) -> Result<GitSandboxConfig, String> {
    let Some(previous) = previous else {
        return Ok(incoming.clone());
    };
    let persisted = &previous.config;
    if normalized_branch(persisted) != normalized_branch(incoming) {
        return Err(format!(
            "sandbox {} branch does not match its durable registry record",
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
    super::normalize_branch(config.branch.as_deref())
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

fn branch_handle_component(branch: &str) -> String {
    let slug = slugify_branch(branch);
    if slug == branch {
        return slug;
    }
    hashed_branch_handle_component(branch)
}

fn hashed_branch_handle_component(branch: &str) -> String {
    use sha2::{Digest, Sha256};

    let slug = slugify_branch(branch);
    let digest = Sha256::digest(branch.as_bytes());
    let hash = digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("{slug}--{hash}")
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
        git(&work_dir, &["init", "-q", "-b", "work"]);
        git(&work_dir, &["config", "user.name", "Test User"]);
        git(&work_dir, &["config", "user.email", "test@example.com"]);
        std::fs::write(work_dir.join("BRANCH.txt"), "main\n").unwrap();
        git(&work_dir, &["add", "."]);
        git(&work_dir, &["commit", "-q", "-m", "initial"]);
        let bare_str = bare_dir.to_str().unwrap().to_string();
        git(&work_dir, &["remote", "add", "origin", &bare_str]);
        git(&work_dir, &["push", "-q", "-u", "origin", "work"]);
        git(&bare_dir, &["symbolic-ref", "HEAD", "refs/heads/work"]);

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
        running_task_with_log_name(id, controller, "dev")
    }

    fn running_task_with_log_name(
        id: &str,
        controller: Option<&crate::tasks::ProcessController>,
        log_name: &str,
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
                log_name: Some(log_name.to_string()),
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
        let a1 = SandboxManager::compute_handle("https://github.com/acme/repo-1", "work")
            .expect("scopeable clone url");
        let a2 = SandboxManager::compute_handle("https://github.com/acme/repo-1", "work")
            .expect("scopeable clone url");
        assert_eq!(a1, a2, "same inputs must hash identically");

        let b = SandboxManager::compute_handle("https://github.com/acme/repo-1", "feature")
            .expect("scopeable clone url");
        assert_ne!(a1, b, "different branches must produce different handles");

        let c = SandboxManager::compute_handle("https://github.com/acme/repo-2", "work")
            .expect("scopeable clone url");
        assert_ne!(
            a1, c,
            "different repositories must produce different handles"
        );

        // The handle IS `<owner>/<repo>/<branch>` — that identity is what lets
        // the directory, the git branch and the UI carry one name. No host
        // segment: GitHub is the only provider, so `github.com` in the middle
        // of every path carried no information.
        assert_eq!(a1, "acme/repo-1/work");
        assert_eq!(b, "acme/repo-1/feature");
        // A different host with the same owner/repo is the same repository
        // under a single provider — and scp-style spells it the same way.
        assert_eq!(
            SandboxManager::compute_handle("git@github.com:acme/repo-1.git", "work").as_deref(),
            Some("acme/repo-1/work")
        );
        // A branch with a slash stays ONE segment, so the tree never nests
        // deeper than the scheme promises. Its full-branch digest keeps it
        // distinct from the already-safe `feature-foo` branch.
        let nested =
            SandboxManager::compute_handle("https://github.com/acme/repo-1", "feature/foo")
                .expect("scopeable clone url");
        let dashed =
            SandboxManager::compute_handle("https://github.com/acme/repo-1", "feature-foo")
                .expect("scopeable clone url");
        assert!(nested.starts_with("acme/repo-1/feature-foo--"));
        assert_eq!(dashed, "acme/repo-1/feature-foo");
        assert_ne!(nested, dashed);
        // A remote this cannot scope is not a git-backed sandbox.
        assert!(SandboxManager::compute_handle("", "work").is_none());
    }

    #[test]
    fn compute_handle_hashes_every_lossy_or_truncated_branch_identity() {
        let clone_url = "https://github.com/acme/repo-1";
        let slash = SandboxManager::compute_handle(clone_url, "feature/foo").unwrap();
        let dash = SandboxManager::compute_handle(clone_url, "feature-foo").unwrap();
        assert_ne!(slash, dash);
        assert_eq!(
            SandboxManager::legacy_compute_handle(clone_url, "feature/foo"),
            SandboxManager::legacy_compute_handle(clone_url, "feature-foo")
        );

        let thread_id = "thread:01234567890123456789012345678901234567890123456789";
        let first =
            SandboxManager::compute_handle(clone_url, &format!("{thread_id}/connection-one"))
                .unwrap();
        let second =
            SandboxManager::compute_handle(clone_url, &format!("{thread_id}/connection-two"))
                .unwrap();
        assert_ne!(first, second);
        assert_eq!(
            SandboxManager::legacy_compute_handle(
                clone_url,
                &format!("{thread_id}/connection-one")
            ),
            SandboxManager::legacy_compute_handle(
                clone_url,
                &format!("{thread_id}/connection-two")
            )
        );
    }

    #[test]
    fn persisted_legacy_handle_is_reused_after_hash_upgrade() {
        let app_root = tempfile::tempdir().unwrap();
        let manager = SandboxManager::new(app_root.path().to_path_buf());
        let account = manager.test_account().unwrap();
        let config = GitSandboxConfig {
            virtual_mcp_id: "vmcp-legacy-handle".to_string(),
            clone_url: "https://github.com/acme/legacy-handle.git".to_string(),
            branch: Some("feature/foo".to_string()),
            ..Default::default()
        };
        let branch = normalized_branch(&config);
        let legacy = SandboxManager::legacy_compute_handle(&config.clone_url, branch).unwrap();
        let current = SandboxManager::compute_handle(&config.clone_url, branch).unwrap();
        assert_ne!(legacy, current);
        manager
            .registry
            .upsert_config_for_account(account.storage(), &legacy, &config)
            .unwrap();
        let workdir = account.storage().workdir(&legacy).unwrap();

        assert_eq!(
            manager
                .resolve_handle_for_config(&account, &config, branch)
                .unwrap(),
            legacy
        );
        assert_eq!(manager.workdir_for(&config), workdir);

        let mut formerly_colliding = config.clone();
        formerly_colliding.branch = Some("feature-foo".to_string());
        let collision_safe = manager
            .resolve_handle_for_config(&account, &formerly_colliding, "feature-foo")
            .unwrap();
        assert_eq!(
            collision_safe,
            SandboxManager::hashed_compute_handle(&config.clone_url, "feature-foo").unwrap()
        );
        assert_ne!(collision_safe, legacy);
        assert_ne!(collision_safe, current);
        manager
            .registry
            .upsert_config_for_account(account.storage(), &collision_safe, &formerly_colliding)
            .unwrap();
    }

    /// A git-backed run must resolve under its OWN handle even when `ensure`
    /// never ran, so a failed clone can never route it into the shared
    /// process-global repo dir where threads would overwrite each other.
    #[test]
    fn workdir_for_is_per_handle_and_never_the_shared_repo_dir() {
        let root = tempfile::tempdir().expect("tempdir");
        let manager = SandboxManager::new(root.path().to_path_buf());
        let account = manager.test_account().unwrap();
        let config = |branch: Option<&str>| GitSandboxConfig {
            virtual_mcp_id: "vmcp-1".to_string(),
            clone_url: "https://github.com/acme/site.git".to_string(),
            branch: branch.map(str::to_string),
            ..Default::default()
        };

        let main = manager.workdir_for(&config(Some("work")));
        assert!(
            main.starts_with(account.storage().worktrees_root().unwrap()) && main.ends_with("repo"),
            "expected <account_root>/worktrees/<handle>/repo, got {main:?}"
        );
        // The shared dir every non-git-backed run uses — see `lib.rs`.
        assert_ne!(main, root.path().join("repo"));

        // Same handle inputs agree with `ensure`'s own derivation, including
        // the `None`/empty -> staging default (never-on-main), so the
        // fallback lands exactly where a later successful ensure will put
        // the checkout.
        let staging = account.storage().workdir("acme/site/staging").unwrap();
        assert_eq!(staging, manager.workdir_for(&config(None)));
        assert_eq!(staging, manager.workdir_for(&config(Some(""))));
        // The handle is now a multi-segment path (`<host>/<owner>/<repo>/<branch>`),
        // so the worktree lives at `<app_root>/worktrees/<handle>/repo`.
        let handle = SandboxManager::compute_handle("https://github.com/acme/site.git", "work")
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
        // slugify is CASE-folding only — the never-on-main normalization
        // lives in `normalize_branch`, upstream of it.
        assert_eq!(slugify_branch("MAIN"), "main");
        assert_eq!(slugify_branch("---"), "branch");
        assert_eq!(slugify_branch(""), "branch");
    }

    #[tokio::test]
    async fn generation_watch_is_scoped_to_one_handle_and_survives_replacement() {
        let app_root = tempfile::tempdir().unwrap();
        let manager = SandboxManager::new(app_root.path().to_path_buf());
        let account = manager.test_account().unwrap();
        let mut watched = manager.watch_generation(&account, "sandbox-a");

        let first = {
            let lock = manager.handle_lock(&account, "sandbox-a");
            let _permit = lock.lock().await;
            manager.get_or_create_locked(&account, "sandbox-a").unwrap()
        };
        manager.publish_generation(&account, "sandbox-a", Some(first.clone()));
        watched.changed().await.unwrap();
        assert!(Arc::ptr_eq(
            watched.borrow_and_update().as_ref().unwrap(),
            &first
        ));

        // Unrelated focus/generation traffic cannot consume or retarget A's
        // notification channel.
        let other = {
            let lock = manager.handle_lock(&account, "sandbox-b");
            let _permit = lock.lock().await;
            manager.get_or_create_locked(&account, "sandbox-b").unwrap()
        };
        manager.publish_generation(&account, "sandbox-b", Some(other));
        assert!(
            tokio::time::timeout(Duration::from_millis(25), watched.changed())
                .await
                .is_err()
        );

        manager
            .lock_sandboxes()
            .remove(&(account.storage_key().to_string(), "sandbox-a".to_string()));
        manager.publish_generation(&account, "sandbox-a", None);
        watched.changed().await.unwrap();
        assert!(watched.borrow_and_update().is_none());

        let replacement = {
            let lock = manager.handle_lock(&account, "sandbox-a");
            let _permit = lock.lock().await;
            manager.get_or_create_locked(&account, "sandbox-a").unwrap()
        };
        manager.publish_generation(&account, "sandbox-a", Some(replacement.clone()));
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
                branch: Some("work".to_string()),
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
            branch: Some("work".to_string()),
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
        assert_eq!(branch.data["meta"]["branch"], "work");
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

    /// Reclaim removes the worktree from disk, drops the registry row, clears
    /// the active pointer — and leaves the canonical repo able to cut the SAME
    /// branch again. That last assertion is the `prune_worktrees` regression:
    /// git keeps listing a worktree whose directory is gone and refuses to
    /// re-add one at that path, so without the prune the branch could never be
    /// re-created.
    #[tokio::test]
    async fn remove_registered_reclaims_the_worktree_and_lets_the_branch_be_recreated() {
        let (_root, clone_url) = setup_two_branch_repo();
        let app_root = tempfile::tempdir().unwrap();
        let manager = SandboxManager::new(app_root.path().to_path_buf());
        let account = manager.test_account().unwrap();
        let cfg = GitSandboxConfig {
            virtual_mcp_id: "vmcp-reclaim".to_string(),
            clone_url: clone_url.clone(),
            branch: Some("work".to_string()),
            ..Default::default()
        };

        let sandbox = manager.ensure(&cfg).await.expect("ensure succeeds");
        let handle = sandbox.handle.clone();
        let worktree = account.storage().worktree_root(&handle).unwrap();
        // Let the queued install/start cascade settle, so the removal below is
        // not racing a setup child that is still writing into the workdir.
        tokio::time::timeout(Duration::from_secs(10), async {
            while sandbox.setup.is_running() || sandbox.setup.pending_count() > 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("the setup pipeline settles");
        assert!(worktree.is_dir());
        assert!(sandbox.workdir.join("BRANCH.txt").is_file());
        // Uncommitted work is NOT a veto — the primitive removes it anyway.
        std::fs::write(sandbox.workdir.join("uncommitted.txt"), "unsaved\n").unwrap();
        assert_eq!(
            manager
                .registered_active_handle_for_account(&account)
                .unwrap()
                .as_deref(),
            Some(handle.as_str()),
            "ensure activates the handle it provisioned"
        );
        drop(sandbox);

        manager
            .remove_registered(&handle)
            .await
            .expect("reclaim succeeds whatever the worktree contains")
            .expect("a registered handle is not unknown");

        assert!(!worktree.exists(), "the worktree directory must be gone");
        assert!(!manager
            .is_registered_for_account(&account, &handle)
            .unwrap());
        assert!(manager
            .registry_record_for_account(&account, &handle)
            .unwrap()
            .is_none());
        assert!(manager
            .registered_active_handle_for_account(&account)
            .unwrap()
            .is_none());
        assert!(manager.active().is_none());
        assert!(manager.get(&account, &handle).is_none());
        assert!(manager
            .handle_for_virtual_mcp_for_account(&account, &cfg.virtual_mcp_id, "work")
            .unwrap()
            .is_none());

        let canonical = account
            .storage()
            .canonical_repo_dir(&clone_url)
            .unwrap()
            .expect("keyable clone url");
        let listed = git_stdout(&canonical, &["worktree", "list"]);
        assert!(
            !listed.contains(worktree.to_str().unwrap()),
            "the removed worktree must not stay registered: {listed}"
        );

        // The whole point: the branch can be started again.
        let again = manager
            .ensure(&cfg)
            .await
            .expect("the same branch can be provisioned again after a reclaim");
        assert_eq!(again.handle, handle);
        assert_eq!(
            std::fs::read_to_string(again.workdir.join("BRANCH.txt"))
                .unwrap()
                .trim(),
            "main"
        );
        assert!(
            !again.workdir.join("uncommitted.txt").exists(),
            "a reclaim is a delete, not a stash"
        );
    }

    /// `intercept::sandbox_ops::route` takes this same lock around
    /// `git/publish|discard|rebase` before touching the worktree, precisely so
    /// a reclaim can't `rm -rf` the directory out from under an in-flight git
    /// mutation. Simulate that holder directly: while it holds the lock,
    /// `remove_registered` must not have removed the worktree yet.
    #[tokio::test]
    async fn remove_registered_waits_for_a_concurrent_git_op_holding_the_same_handle_lock() {
        let (_root, clone_url) = setup_two_branch_repo();
        let app_root = tempfile::tempdir().unwrap();
        let manager = Arc::new(SandboxManager::new(app_root.path().to_path_buf()));
        let account = manager.test_account().unwrap();
        let cfg = GitSandboxConfig {
            virtual_mcp_id: "vmcp-race".to_string(),
            clone_url,
            branch: Some("work".to_string()),
            ..Default::default()
        };

        let sandbox = manager.ensure(&cfg).await.expect("ensure succeeds");
        let handle = sandbox.handle.clone();
        let worktree = account.storage().worktree_root(&handle).unwrap();
        tokio::time::timeout(Duration::from_secs(10), async {
            while sandbox.setup.is_running() || sandbox.setup.pending_count() > 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("the setup pipeline settles");
        drop(sandbox);

        // Stand in for `sandbox_ops::route`'s git-op guard: a "publish" in
        // flight, holding the handle lock for as long as its git command runs.
        let git_op_lock = manager.handle_lock(&account, &handle);
        let git_op_guard = git_op_lock.lock().await;

        let reclaim = tokio::spawn({
            let manager = manager.clone();
            let handle = handle.clone();
            async move { manager.remove_registered(&handle).await }
        });

        // The reclaim is blocked behind the lock the simulated git op holds —
        // give it every chance to (wrongly) race ahead before asserting.
        for _ in 0..50 {
            tokio::task::yield_now().await;
        }
        assert!(
            worktree.is_dir(),
            "reclaim must not touch the worktree while a git op holds the handle lock"
        );

        drop(git_op_guard);
        reclaim
            .await
            .expect("reclaim task doesn't panic")
            .expect("reclaim succeeds")
            .expect("a registered handle is not unknown");
        assert!(
            !worktree.exists(),
            "reclaim proceeds once the git op releases the lock"
        );
    }

    /// Mirrors `stop_registered`: nothing registered means nothing to reclaim,
    /// which is a success, not an error.
    #[tokio::test]
    async fn remove_registered_reports_an_unknown_handle_as_unknown() {
        let app_root = tempfile::tempdir().unwrap();
        let manager = SandboxManager::new(app_root.path().to_path_buf());
        assert_eq!(manager.remove_registered("acme/repo/nope").await, Ok(None));
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
                branch: Some("work".to_string()),
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
        let changed = tokio::time::timeout(Duration::from_secs(15), async {
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
        assert_eq!(changed.data["meta"]["branch"], "work");
    }

    #[tokio::test]
    async fn ensure_repairs_a_drifted_branch_before_returning() {
        let (_root, clone_url) = setup_two_branch_repo();
        let app_root = tempfile::tempdir().unwrap();
        let manager = SandboxManager::new(app_root.path().to_path_buf());
        let cfg = GitSandboxConfig {
            virtual_mcp_id: "vmcp-drift".to_string(),
            clone_url,
            branch: Some("work".to_string()),
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
            "work",
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
            branch: Some("work".to_string()),
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
        assert!(
            error.contains("this machine's Git credentials"),
            "the caller must receive actionable credential guidance, got: {error}"
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
            branch: Some("work".to_string()),
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
    async fn stop_preempts_an_ensure_holding_the_handle_lock() {
        let (_origin, clone_url) = setup_two_branch_repo();
        let app_root = tempfile::tempdir().unwrap();
        let manager = SandboxManager::new(app_root.path().to_path_buf());
        let account = manager.test_account().unwrap();
        let handle = manager.register_for_test(&clone_url, "work");
        let sandbox = manager.adopt(&handle).await.unwrap().unwrap();
        let config = manager
            .registry_record_for_account(&account, &handle)
            .unwrap()
            .unwrap()
            .config;

        let controller = crate::tasks::ProcessController::new();
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let gate_sandbox = sandbox.clone();
        let gate_controller = controller.clone();
        let after_lock = async move {
            gate_sandbox.tasks.insert(running_task_with_log_name(
                "ensure-clone-in-flight",
                Some(&gate_controller),
                "setup",
            ));
            entered_tx.send(()).unwrap();
            let signal = gate_controller.wait_for_change(None).await;
            gate_sandbox.tasks.finalize(
                "ensure-clone-in-flight",
                TaskStatus::Killed,
                signal.exit_code(),
                false,
            );
        };
        let ensure_manager = manager.clone();
        let ensure =
            tokio::spawn(async move { ensure_manager.ensure_inner(&config, after_lock).await });
        entered_rx
            .await
            .expect("ensure holds the operation lock with a visible setup task");

        let killed = tokio::time::timeout(Duration::from_secs(5), manager.stop_registered(&handle))
            .await
            .expect("Stop preempts the clone task instead of waiting behind ensure")
            .unwrap()
            .unwrap();
        assert_eq!(killed, 1);
        assert_eq!(controller.requested(), Some(KillSignal::Term));
        assert!(
            ensure.await.unwrap().is_err(),
            "the closed generation cannot finish ensure successfully"
        );
        assert!(manager.get(&account, &handle).is_none());
    }

    #[tokio::test]
    async fn stop_preempts_an_in_flight_provision_clone() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (accepted_tx, accepted_rx) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let (_socket, _) = listener.accept().await.unwrap();
            accepted_tx.send(()).unwrap();
            std::future::pending::<()>().await;
        });

        let app_root = tempfile::tempdir().unwrap();
        let manager = SandboxManager::new(app_root.path().to_path_buf());
        let account = manager.test_account().unwrap();
        let config = GitSandboxConfig {
            virtual_mcp_id: "vmcp-preempt-provision".to_string(),
            clone_url: format!("http://{address}/acme/repo.git"),
            branch: Some("work".to_string()),
            ..Default::default()
        };
        let sandbox = manager.provision(&config).await.unwrap();
        tokio::time::timeout(Duration::from_secs(5), accepted_rx)
            .await
            .expect("the provisioned clone reaches the deliberately stalled remote")
            .expect("the stalled remote remains available");

        let killed = tokio::time::timeout(
            Duration::from_secs(5),
            manager.stop_registered(&sandbox.handle),
        )
        .await
        .expect("Stop cancels the provisioned clone without waiting for its remote")
        .unwrap()
        .unwrap();
        server.abort();

        assert_eq!(killed, 1);
        assert!(sandbox.setup.is_closed());
        assert!(manager.get(&account, &sandbox.handle).is_none());
    }

    #[tokio::test]
    async fn stop_during_owned_repo_probe_prevents_late_workdir_repair() {
        let (_origin, clone_url) = setup_two_branch_repo();
        let app_root = tempfile::tempdir().unwrap();
        let manager = SandboxManager::new(app_root.path().to_path_buf());
        let account = manager.test_account().unwrap();
        let handle = manager.register_for_test(&clone_url, "probe-stop");
        let sandbox = manager.adopt(&handle).await.unwrap().unwrap();
        let marker = sandbox.workdir.join("must-survive-stop.txt");
        tokio::fs::write(&marker, b"owned before stop")
            .await
            .unwrap();
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let flow_sandbox = sandbox.clone();
        let flow_storage = account.storage().clone();
        let flow_clone_url = clone_url.clone();
        let probe_then_repair = tokio::spawn(async move {
            let probe_generation = flow_sandbox.tasks.clone();
            let observed_generation = probe_generation.clone();
            let repo_valid = crate::routes::git::run_owned_git_probe(
                probe_generation,
                "git stopped repository probe",
                async move {
                    entered_tx.send(()).unwrap();
                    while !observed_generation.is_admission_closed() {
                        tokio::task::yield_now().await;
                    }
                    false
                },
            )
            .await?;
            if !repo_valid {
                repair_invalid_workdir_owned(&flow_sandbox, flow_storage, flow_clone_url).await?;
            }
            Ok::<(), String>(())
        });
        entered_rx.await.expect("repository probe is registered");

        assert_eq!(manager.stop_registered(&handle).await.unwrap(), Some(1));
        assert!(
            probe_then_repair.await.unwrap().is_err(),
            "a stopped observation cannot flow into invalid-workdir repair"
        );
        assert_eq!(
            tokio::fs::read(&marker).await.unwrap(),
            b"owned before stop",
            "Stop must not be followed by remove/recreate from a canceled false probe"
        );
    }

    #[tokio::test]
    async fn terminal_cancellation_before_materialization_creates_no_generation() {
        let app_root = tempfile::tempdir().unwrap();
        let manager = SandboxManager::new(app_root.path().to_path_buf());
        let account = manager.test_account().unwrap();
        let config = GitSandboxConfig {
            virtual_mcp_id: "vmcp-terminal-pre-materialization".to_string(),
            clone_url: "https://github.com/acme/terminal-pre-materialization.git".to_string(),
            branch: Some("thread:before-materialization".to_string()),
            ..Default::default()
        };
        let handle =
            SandboxManager::compute_handle(&config.clone_url, normalized_branch(&config)).unwrap();
        let permit = manager.handle_lock(&account, &handle).lock_owned().await;
        let (cancel_tx, cancel_rx) = tokio::sync::watch::channel(false);
        let ensure_manager = manager.clone();
        let ensure_account = account.clone();
        let mut ensure = tokio::spawn(async move {
            ensure_manager
                .ensure_for_terminal(&ensure_account, &config, cancel_rx, true)
                .await
        });

        assert!(
            tokio::time::timeout(Duration::from_millis(25), &mut ensure)
                .await
                .is_err(),
            "the held operation lock keeps terminal ensure before materialization"
        );
        cancel_tx.send(true).unwrap();
        let result = tokio::time::timeout(Duration::from_secs(1), ensure)
            .await
            .expect("pre-materialization cancellation does not wait for the handle lock")
            .unwrap();
        assert!(matches!(result, Err(TerminalEnsureError::Canceled)));
        assert!(manager.get(&account, &handle).is_none());
        assert!(!manager
            .is_registered_for_account(&account, &handle)
            .unwrap());

        drop(permit);
        tokio::task::yield_now().await;
        assert!(
            manager.get(&account, &handle).is_none(),
            "the canceled manager-owned ensure cannot create a delayed generation"
        );
    }

    #[tokio::test]
    async fn terminal_cancellation_reaps_a_materialized_synthetic_generation() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (accepted_tx, accepted_rx) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let (_socket, _) = listener.accept().await.unwrap();
            accepted_tx.send(()).unwrap();
            std::future::pending::<()>().await;
        });
        let app_root = tempfile::tempdir().unwrap();
        let manager = SandboxManager::new(app_root.path().to_path_buf());
        let account = manager.test_account().unwrap();
        let config = GitSandboxConfig {
            virtual_mcp_id: "vmcp-terminal-synthetic".to_string(),
            clone_url: format!("http://{address}/acme/terminal-synthetic.git"),
            branch: Some("thread:synthetic".to_string()),
            ..Default::default()
        };
        let handle =
            SandboxManager::compute_handle(&config.clone_url, normalized_branch(&config)).unwrap();
        let (cancel_tx, cancel_rx) = tokio::sync::watch::channel(false);
        let ensure_manager = manager.clone();
        let ensure_account = account.clone();
        let ensure = tokio::spawn(async move {
            ensure_manager
                .ensure_for_terminal(&ensure_account, &config, cancel_rx, true)
                .await
        });
        tokio::time::timeout(Duration::from_secs(5), accepted_rx)
            .await
            .expect("terminal ensure reaches the deliberately stalled remote")
            .expect("stalled remote remains available");
        let materialized = manager
            .get(&account, &handle)
            .expect("clone starts only after the generation is materialized");

        cancel_tx.send(true).unwrap();
        let result = tokio::time::timeout(Duration::from_secs(5), ensure)
            .await
            .expect("synthetic cancellation preempts and reaps the clone")
            .unwrap();
        server.abort();

        assert!(matches!(result, Err(TerminalEnsureError::Canceled)));
        assert!(materialized.tasks.is_admission_closed());
        assert!(manager.get(&account, &handle).is_none());
        assert_eq!(
            manager
                .registry_record_for_account(&account, &handle)
                .unwrap()
                .unwrap()
                .desired_status,
            "stopped"
        );
    }

    #[tokio::test]
    async fn terminal_cancellation_transfers_a_materialized_shared_generation() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (accepted_tx, accepted_rx) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let (_socket, _) = listener.accept().await.unwrap();
            accepted_tx.send(()).unwrap();
            std::future::pending::<()>().await;
        });
        let app_root = tempfile::tempdir().unwrap();
        let manager = SandboxManager::new(app_root.path().to_path_buf());
        let account = manager.test_account().unwrap();
        let config = GitSandboxConfig {
            virtual_mcp_id: "vmcp-terminal-shared".to_string(),
            clone_url: format!("http://{address}/acme/terminal-shared.git"),
            branch: Some("shared-branch".to_string()),
            ..Default::default()
        };
        let handle =
            SandboxManager::compute_handle(&config.clone_url, normalized_branch(&config)).unwrap();
        let (cancel_tx, cancel_rx) = tokio::sync::watch::channel(false);
        let ensure_manager = manager.clone();
        let ensure_account = account.clone();
        let ensure = tokio::spawn(async move {
            ensure_manager
                .ensure_for_terminal(&ensure_account, &config, cancel_rx, false)
                .await
        });
        tokio::time::timeout(Duration::from_secs(5), accepted_rx)
            .await
            .expect("terminal ensure reaches the deliberately stalled remote")
            .expect("stalled remote remains available");
        let materialized = manager
            .get(&account, &handle)
            .expect("clone starts only after the generation is materialized");

        cancel_tx.send(true).unwrap();
        let result = tokio::time::timeout(Duration::from_secs(1), ensure)
            .await
            .expect("shared cancellation transfers ownership without waiting for clone")
            .unwrap();
        assert!(matches!(result, Err(TerminalEnsureError::Canceled)));
        assert!(
            manager
                .get(&account, &handle)
                .is_some_and(|current| Arc::ptr_eq(&current, &materialized)),
            "a shared branch remains manager-owned after this terminal leaves"
        );
        assert!(!materialized.tasks.is_admission_closed());

        tokio::time::timeout(Duration::from_secs(5), manager.delete_registered(&handle))
            .await
            .expect("test cleanup reaps the transferred clone")
            .unwrap()
            .unwrap();
        server.abort();
    }

    #[tokio::test]
    async fn thread_cleanup_matches_exact_agent_and_synthetic_thread_identity() {
        let (_origin, clone_url) = setup_two_branch_repo();
        let app_root = tempfile::tempdir().unwrap();
        let manager = SandboxManager::new(app_root.path().to_path_buf());
        let account = manager.test_account().unwrap();
        let exact = manager.register_for_test(&clone_url, "thread:thread-1");
        let suffix = manager.register_for_test(&clone_url, "thread:thread-1/retry-2");
        let prefix_collision = manager.register_for_test(&clone_url, "thread:thread-10");
        let shared = manager.register_for_test(&clone_url, "feature/thread-1");
        for handle in [&exact, &suffix, &prefix_collision, &shared] {
            manager
                .adopt(handle)
                .await
                .unwrap()
                .expect("registered fixture is live");
        }

        assert_eq!(
            manager
                .delete_live_thread_sandboxes("another-agent", "thread-1")
                .await
                .unwrap(),
            0,
            "a reused thread id cannot cross the virtual-MCP fence"
        );
        assert!(manager.get(&account, &exact).is_some());
        assert!(manager.get(&account, &suffix).is_some());

        assert_eq!(
            manager
                .delete_live_thread_sandboxes("test-agent", "thread-1")
                .await
                .unwrap(),
            2
        );
        assert!(manager.get(&account, &exact).is_none());
        assert!(manager.get(&account, &suffix).is_none());
        for handle in [&prefix_collision, &shared] {
            let sandbox = manager
                .get(&account, handle)
                .expect("prefix collisions and real branches remain live");
            assert!(!sandbox.tasks.is_admission_closed());
        }
        assert_eq!(
            manager
                .registry_record_for_account(&account, &exact)
                .unwrap()
                .unwrap()
                .desired_status,
            "stopped"
        );
        assert_eq!(
            manager
                .registry_record_for_account(&account, &prefix_collision)
                .unwrap()
                .unwrap()
                .desired_status,
            "running"
        );
    }

    #[tokio::test]
    async fn account_transition_drains_materialization_stops_all_and_reopens_start() {
        let (_origin, clone_url) = setup_two_branch_repo();
        let app_root = tempfile::tempdir().unwrap();
        let manager = SandboxManager::new(app_root.path().to_path_buf());
        let account = manager.test_account().unwrap();
        let real = manager.register_for_test_account(&account, &clone_url, "feature/shared");
        let synthetic =
            manager.register_for_test_account(&account, &clone_url, "thread:thread-1/retry");
        let malformed = manager.register_for_test_account(&account, &clone_url, "thread:");
        let inside =
            manager.register_for_test_account(&account, &clone_url, "thread:inside-transition");
        let mut old_generations = Vec::new();
        for handle in [&real, &synthetic, &malformed] {
            old_generations.push(
                manager
                    .adopt_for_account(&account, handle)
                    .await
                    .unwrap()
                    .unwrap(),
            );
        }

        // Model an old-account operation already inside the short
        // Arc-insertion/durable-registration section.
        let inside_admission = manager
            .materialization_gate
            .admit(account.epoch())
            .expect("account gate starts open");
        let inside_generation = {
            let handle_lock = manager.handle_lock(&account, &inside);
            let _permit = handle_lock.lock().await;
            manager.get_or_create_locked(&account, &inside).unwrap()
        };
        manager.publish_generation(&account, &inside, Some(inside_generation.clone()));
        old_generations.push(inside_generation);
        let transition_guard = manager.begin_account_transition().await.unwrap();
        let mut transition = Box::pin(transition_guard.drain_and_stop_live());
        assert!(
            tokio::time::timeout(Duration::from_millis(25), &mut transition)
                .await
                .is_err(),
            "snapshot waits for an operation already inside materialization"
        );

        let before_config = GitSandboxConfig {
            virtual_mcp_id: "test-agent".to_string(),
            clone_url: clone_url.clone(),
            branch: Some("must-not-materialize".to_string()),
            ..Default::default()
        };
        let before_handle = SandboxManager::compute_handle(
            &before_config.clone_url,
            normalized_branch(&before_config),
        )
        .unwrap();
        assert!(manager
            .provision_for_account(&account, &before_config)
            .await
            .is_err());
        assert!(!manager
            .registry
            .contains_for_account(account.storage(), &before_handle)
            .unwrap());
        drop(inside_admission);

        assert_eq!(
            tokio::time::timeout(Duration::from_secs(5), &mut transition)
                .await
                .expect("transition drains and sweeps every materialized generation")
                .unwrap(),
            4
        );
        drop(transition);
        assert!(
            manager
                .provision_for_account(&account, &before_config)
                .await
                .is_err(),
            "the guard keeps publication closed after the sweep"
        );
        for generation in &old_generations {
            assert!(generation.tasks.is_admission_closed());
            assert!(manager.get(&account, &generation.handle).is_none());
            assert!(generation.workdir.is_dir(), "worktree is retained");
            assert_eq!(
                manager
                    .registry
                    .record_for_account(account.storage(), &generation.handle)
                    .unwrap()
                    .unwrap()
                    .desired_status,
                "stopped"
            );
        }

        let config = manager
            .registry
            .record_for_account(account.storage(), &real)
            .unwrap()
            .unwrap()
            .config;
        transition_guard.complete().unwrap();
        let next_account = manager.test_account().unwrap();
        let resumed = manager
            .provision_for_account(&next_account, &config)
            .await
            .expect("materialization reopens after the account sweep");
        assert!(!resumed.tasks.is_admission_closed());
        assert_eq!(resumed.account.epoch(), next_account.epoch());
        assert!(!Arc::ptr_eq(&resumed, &old_generations[0]));
    }

    #[tokio::test]
    async fn account_transition_drain_timeout_does_not_snapshot_or_stop() {
        let app_root = tempfile::tempdir().unwrap();
        let manager = SandboxManager::new(app_root.path().to_path_buf());
        let account = manager.test_account().unwrap();
        let handle = manager.register_for_test(
            "https://github.com/acme/materialization-timeout.git",
            "feature/account-a",
        );
        let sandbox = manager.adopt(&handle).await.unwrap().unwrap();
        let stuck = manager
            .materialization_gate
            .admit(account.epoch())
            .expect("materialization starts admitted");
        let guard = manager.begin_account_transition().await.unwrap();

        let error = guard
            .drain_and_stop_live_with_timeout(Duration::from_millis(10))
            .await
            .expect_err("a stuck commit section must hit the named deadline");
        assert!(error.contains("timed out after 10ms"), "{error}");
        assert!(
            manager
                .get(&account, &handle)
                .is_some_and(|current| Arc::ptr_eq(&current, &sandbox)),
            "timeout returns before taking the stop snapshot"
        );
        assert!(!sandbox.tasks.is_admission_closed());
        assert_eq!(
            manager
                .registry
                .record_for_account(account.storage(), &handle)
                .unwrap()
                .unwrap()
                .desired_status,
            "running"
        );

        drop(stuck);
        assert_eq!(
            guard
                .drain_and_stop_live()
                .await
                .expect("a retry snapshots after the stuck admission quiesces"),
            1
        );
        assert!(manager.get(&account, &handle).is_none());
        assert!(sandbox.tasks.is_admission_closed());
        assert_eq!(
            manager
                .registry
                .record_for_account(account.storage(), &handle)
                .unwrap()
                .unwrap()
                .desired_status,
            "stopped"
        );
        guard.complete().unwrap();
        manager
            .test_account()
            .expect("explicit completion reopens account publication");
    }

    #[tokio::test]
    async fn exhausted_account_epoch_fails_permanently_closed() {
        let app_root = tempfile::tempdir().unwrap();
        let manager = SandboxManager::new(app_root.path().to_path_buf());
        manager
            .materialization_gate
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .epoch = u64::MAX;
        manager
            .materialization_gate
            .epoch_watch
            .send_replace(AccountEpoch(u64::MAX));
        let mut watch = manager.watch_account_epoch(AccountEpoch(u64::MAX)).unwrap();

        assert_eq!(
            manager
                .begin_account_transition()
                .await
                .err()
                .expect("epoch exhaustion rejects the transition"),
            "sandbox account epoch exhausted"
        );
        tokio::time::timeout(Duration::from_secs(1), watch.changed())
            .await
            .expect("fail-closed exhaustion terminates epoch watchers")
            .unwrap();
        assert!(manager
            .validate_account_epoch(AccountEpoch(u64::MAX))
            .is_err());
        assert!(
            manager
                .materialization_gate
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .boundary
                == AccountBoundary::Poisoned
        );
    }

    #[tokio::test]
    async fn account_epoch_watch_cannot_miss_transition_advance() {
        let app_root = tempfile::tempdir().unwrap();
        let manager = SandboxManager::new(app_root.path().to_path_buf());
        let old_epoch = manager.account_epoch();
        let mut watch = manager.watch_account_epoch(old_epoch).unwrap();

        let transition = manager.begin_account_transition().await.unwrap();
        tokio::time::timeout(Duration::from_secs(1), watch.changed())
            .await
            .expect("epoch watcher is notified synchronously with close")
            .unwrap();
        let next_epoch = *watch.borrow_and_update();
        assert_ne!(old_epoch, next_epoch);
        assert!(manager.watch_account_epoch(old_epoch).is_err());

        transition.complete().unwrap();
        assert_eq!(manager.account_epoch(), next_epoch);
        assert!(manager.watch_account_epoch(next_epoch).is_ok());
    }

    #[tokio::test]
    async fn stale_account_ticket_cannot_target_the_replacement_generation() {
        let (_origin, clone_url) = setup_two_branch_repo();
        let app_root = tempfile::tempdir().unwrap();
        let manager = SandboxManager::new(app_root.path().to_path_buf());
        let old_scope = RtAccountScope::new("account-a.invalid", "user-a").unwrap();
        let old_account = manager.test_account_for_scope(&old_scope).unwrap();
        let config = GitSandboxConfig {
            virtual_mcp_id: "vmcp-account-epoch".to_string(),
            clone_url,
            branch: Some("work".to_string()),
            ..Default::default()
        };
        let (resume_stale_tx, resume_stale_rx) = tokio::sync::oneshot::channel();
        let stale_manager = manager.clone();
        let stale_config = config.clone();
        let stale_account = old_account.clone();
        let stale = tokio::spawn(async move {
            resume_stale_rx.await.unwrap();
            stale_manager
                .try_provision_for_account(&stale_account, &stale_config)
                .await
        });

        let transition = manager.begin_account_transition().await.unwrap();
        assert_eq!(transition.drain_and_stop_live().await.unwrap(), 0);
        transition.complete().unwrap();

        let next_scope = RtAccountScope::new("account-b.invalid", "user-b").unwrap();
        let next_account = manager.test_account_for_scope(&next_scope).unwrap();
        let replacement = manager
            .provision_for_account(&next_account, &config)
            .await
            .expect("account B materializes after publication reopens");
        resume_stale_tx.send(()).unwrap();
        match stale.await.unwrap() {
            Err(error) => assert_eq!(error, STALE_ACCOUNT_EPOCH),
            Ok(_) => panic!("account A's paused request targeted account B's generation"),
        }
        let resolved = manager
            .get_for_account(&next_account, &replacement.handle)
            .unwrap()
            .unwrap();
        assert!(Arc::ptr_eq(&resolved, &replacement));
        assert_eq!(
            replacement.account.storage_key(),
            next_account.storage_key()
        );
        assert!(manager
            .get_for_account(&old_account, &replacement.handle)
            .is_err());
    }

    #[tokio::test]
    async fn stop_and_delete_both_reap_arbitrary_execs() {
        let (_origin, clone_url) = setup_two_branch_repo();
        let app_root = tempfile::tempdir().unwrap();
        let manager = SandboxManager::new(app_root.path().to_path_buf());
        let account = manager.test_account().unwrap();

        let stop_handle = manager.register_for_test(&clone_url, "stop-scope");
        let stop_sandbox = manager.adopt(&stop_handle).await.unwrap().unwrap();
        let stop_controller = crate::tasks::ProcessController::new();
        stop_sandbox.tasks.insert(running_task_with_log_name(
            "stop-scope-exec",
            Some(&stop_controller),
            "arbitrary-exec",
        ));
        let stop_owner = {
            let tasks = stop_sandbox.tasks.clone();
            let controller = stop_controller.clone();
            tokio::spawn(async move {
                let signal = controller.wait_for_change(None).await;
                tasks.finalize(
                    "stop-scope-exec",
                    TaskStatus::Killed,
                    signal.exit_code(),
                    false,
                );
            })
        };
        assert_eq!(
            manager.stop_registered(&stop_handle).await.unwrap(),
            Some(1)
        );
        stop_owner.await.unwrap();
        assert_eq!(stop_controller.requested(), Some(KillSignal::Term));
        assert!(manager.get(&account, &stop_handle).is_none());

        let delete_handle = manager.register_for_test(&clone_url, "delete-scope");
        let delete_sandbox = manager.adopt(&delete_handle).await.unwrap().unwrap();
        let delete_controller = crate::tasks::ProcessController::new();
        delete_sandbox.tasks.insert(running_task_with_log_name(
            "delete-scope-exec",
            Some(&delete_controller),
            "arbitrary-exec",
        ));
        let delete_owner = {
            let tasks = delete_sandbox.tasks.clone();
            let controller = delete_controller.clone();
            tokio::spawn(async move {
                let signal = controller.wait_for_change(None).await;
                tasks.finalize(
                    "delete-scope-exec",
                    TaskStatus::Killed,
                    signal.exit_code(),
                    false,
                );
            })
        };
        assert_eq!(
            manager.delete_registered(&delete_handle).await.unwrap(),
            Some(1)
        );
        delete_owner.await.unwrap();
        assert_eq!(delete_controller.requested(), Some(KillSignal::Term));
        assert!(manager.get(&account, &delete_handle).is_none());
    }

    #[tokio::test]
    async fn stop_reaps_internal_generation_tasks_hidden_from_public_lists() {
        let (_origin, clone_url) = setup_two_branch_repo();
        let app_root = tempfile::tempdir().unwrap();
        let manager = SandboxManager::new(app_root.path().to_path_buf());
        let account = manager.test_account().unwrap();
        let handle = manager.register_for_test(&clone_url, "internal-task");
        let sandbox = manager.adopt(&handle).await.unwrap().unwrap();
        let controller = crate::tasks::ProcessController::new();
        sandbox.tasks.insert(crate::tasks::TaskEntry::new_internal(
            crate::tasks::TaskSummary {
                id: "hidden-git-owner".to_string(),
                command: "git status --porcelain".to_string(),
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
        assert!(
            sandbox.tasks.list(None).is_empty(),
            "the fixture must exercise a task omitted from public task lists"
        );
        let owner = {
            let tasks = sandbox.tasks.clone();
            let controller = controller.clone();
            tokio::spawn(async move {
                let signal = controller.wait_for_change(None).await;
                tasks.finalize(
                    "hidden-git-owner",
                    TaskStatus::Killed,
                    signal.exit_code(),
                    false,
                );
            })
        };

        assert_eq!(manager.stop_registered(&handle).await.unwrap(), Some(1));
        owner.await.unwrap();
        assert_eq!(controller.requested(), Some(KillSignal::Term));
        assert!(manager.get(&account, &handle).is_none());
    }

    #[tokio::test]
    async fn stop_waits_for_an_admitted_pure_mutation_and_rejects_late_commits() {
        let (_origin, clone_url) = setup_two_branch_repo();
        let app_root = tempfile::tempdir().unwrap();
        let manager = SandboxManager::new(app_root.path().to_path_buf());
        let handle = manager.register_for_test(&clone_url, "mutation-fence");
        let sandbox = manager.adopt(&handle).await.unwrap().unwrap();
        let admission = sandbox.tasks.admit().expect("generation is open");
        let committed_path = sandbox.workdir.join("committed-before-stop.txt");
        let late_path = sandbox.workdir.join("must-not-commit-after-stop.txt");
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        let (committed_tx, committed_rx) = tokio::sync::oneshot::channel();
        let mutation = tokio::spawn(async move {
            release_rx.await.unwrap();
            tokio::fs::write(&committed_path, b"owned mutation")
                .await
                .unwrap();
            drop(admission);
            committed_tx.send(()).unwrap();
        });

        let stop_manager = manager.clone();
        let stop_handle = handle.clone();
        let stop = tokio::spawn(async move { stop_manager.stop_registered(&stop_handle).await });
        tokio::time::timeout(Duration::from_secs(1), async {
            while !sandbox.tasks.is_admission_closed() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("Stop closes generation admission");
        assert!(
            !stop.is_finished(),
            "Stop must wait for the admitted mutation before its reap snapshot"
        );

        release_tx.send(()).unwrap();
        committed_rx.await.unwrap();
        assert_eq!(stop.await.unwrap().unwrap(), Some(0));
        mutation.await.unwrap();
        assert!(sandbox.workdir.join("committed-before-stop.txt").is_file());

        if let Some(_late_admission) = sandbox.tasks.admit() {
            tokio::fs::write(&late_path, b"late mutation")
                .await
                .unwrap();
        }
        assert!(
            !late_path.exists(),
            "a route resolved before Stop must not commit after Stop returns"
        );
    }

    #[tokio::test]
    async fn stale_delete_cannot_evict_or_mark_a_replacement_generation_stopped() {
        let (_origin, clone_url) = setup_two_branch_repo();
        let app_root = tempfile::tempdir().unwrap();
        let manager = SandboxManager::new(app_root.path().to_path_buf());
        let account = manager.test_account().unwrap();
        let handle = manager.register_for_test(&clone_url, "work");
        let old = manager.adopt(&handle).await.unwrap().unwrap();
        let config = manager
            .registry_record_for_account(&account, &handle)
            .unwrap()
            .unwrap()
            .config;
        let controller = crate::tasks::ProcessController::new();
        old.tasks.insert(running_task_with_log_name(
            "old-setup",
            Some(&controller),
            "arbitrary-exec",
        ));

        // Hold the operation lock only to deterministically install a new
        // generation after Stop has completed its preemptive first phase but
        // before it can perform the generation-checked eviction phase.
        let handle_lock = manager.handle_lock(&account, &handle);
        let permit = handle_lock.lock().await;
        let stop_manager = manager.clone();
        let stop_handle = handle.clone();
        let stop = tokio::spawn(async move { stop_manager.delete_registered(&stop_handle).await });
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(1), controller.wait_for_change(None))
                .await
                .expect("Stop signals the old generation before waiting for the operation lock"),
            KillSignal::Term
        );
        old.tasks
            .finalize("old-setup", TaskStatus::Killed, 143, false);

        manager
            .lock_sandboxes()
            .remove(&(account.storage_key().to_string(), handle.clone()));
        let replacement = manager.get_or_create_locked(&account, &handle).unwrap();
        manager
            .apply_config(&replacement, &config, normalized_branch(&config))
            .unwrap();
        manager.publish_generation(&account, &handle, Some(replacement.clone()));
        manager
            .registry
            .mark_state_for_account(account.storage(), &handle, "running", "running", None)
            .unwrap();
        drop(permit);

        assert_eq!(
            tokio::time::timeout(Duration::from_secs(2), stop)
                .await
                .expect("the stale Stop finishes once the operation lock is released")
                .unwrap()
                .unwrap(),
            Some(1)
        );
        let current = manager
            .get(&account, &handle)
            .expect("replacement remains live");
        assert!(Arc::ptr_eq(&current, &replacement));
        assert!(!replacement.setup.is_closed());
        let record = manager
            .registry_record_for_account(&account, &handle)
            .unwrap()
            .unwrap();
        assert_eq!(record.desired_status, "running");
        assert_eq!(record.observed_status, "running");
    }

    #[tokio::test]
    async fn stale_account_reclaim_cannot_remove_a_replacement_worktree_or_row() {
        let (_origin, clone_url) = setup_two_branch_repo();
        let app_root = tempfile::tempdir().unwrap();
        let manager = SandboxManager::new(app_root.path().to_path_buf());
        let old_account = manager.test_account().unwrap();
        let handle = manager.register_for_test_account(&old_account, &clone_url, "work");
        let worktree = old_account.storage().worktree_root(&handle).unwrap();
        std::fs::create_dir_all(worktree.join("repo")).unwrap();
        std::fs::write(worktree.join("account-b-marker"), b"keep").unwrap();
        let old = manager
            .adopt_for_account(&old_account, &handle)
            .await
            .unwrap()
            .unwrap();
        let config = manager
            .registry_record_for_account(&old_account, &handle)
            .unwrap()
            .unwrap()
            .config;

        // Pause reclaim after it snapshots and closes account A's generation,
        // but before it can take the operation lock for filesystem removal.
        let handle_lock = manager.handle_lock(&old_account, &handle);
        let permit = handle_lock.lock().await;
        let reclaim_manager = manager.clone();
        let reclaim_account = old_account.clone();
        let reclaim_handle = handle.clone();
        let reclaim = tokio::spawn(async move {
            reclaim_manager
                .remove_registered_for_account(&reclaim_account, &reclaim_handle)
                .await
        });
        tokio::time::timeout(Duration::from_secs(1), async {
            while !old.setup.is_closed() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("reclaim closes the old generation before waiting for the lock");

        // Advance the account fence and re-bind the same durable account at a
        // new epoch while reclaim is paused. The storage key is intentionally
        // unchanged: the generation fence, not path separation, must prevent
        // the stale request from deleting its replacement.
        let transition = manager.begin_account_transition().await.unwrap();
        manager
            .lock_sandboxes()
            .remove(&(old_account.storage_key().to_string(), handle.clone()));
        transition.complete().unwrap();
        let next_account = manager.test_account().unwrap();
        let replacement = manager
            .get_or_create_locked(&next_account, &handle)
            .unwrap();
        manager
            .apply_config(&replacement, &config, normalized_branch(&config))
            .unwrap();
        manager.publish_generation(&next_account, &handle, Some(replacement.clone()));
        manager
            .registry
            .mark_state_for_account(next_account.storage(), &handle, "running", "running", None)
            .unwrap();
        drop(permit);

        let error = tokio::time::timeout(Duration::from_secs(2), reclaim)
            .await
            .expect("stale reclaim finishes after the operation lock is released")
            .unwrap()
            .unwrap_err();
        assert_eq!(error, STALE_ACCOUNT_EPOCH);
        assert!(worktree.join("account-b-marker").is_file());
        assert!(manager
            .registry_record_for_account(&next_account, &handle)
            .unwrap()
            .is_some());
        let current = manager
            .get(&next_account, &handle)
            .expect("replacement remains live");
        assert!(Arc::ptr_eq(&current, &replacement));
        assert_eq!(replacement.account.epoch(), next_account.epoch());
        let record = manager
            .registry_record_for_account(&next_account, &handle)
            .unwrap()
            .unwrap();
        assert_eq!(record.desired_status, "running");
        assert_eq!(record.observed_status, "running");
    }

    #[tokio::test]
    async fn concurrent_provision_calls_coalesce_one_setup_generation() {
        let (_root, clone_url) = setup_two_branch_repo();
        let app_root = tempfile::tempdir().unwrap();
        let manager = SandboxManager::new(app_root.path().to_path_buf());
        let config = GitSandboxConfig {
            virtual_mcp_id: "vmcp-concurrent-provision".to_string(),
            clone_url,
            branch: Some("work".to_string()),
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
    async fn try_provision_fails_fast_while_the_handle_lock_is_owned() {
        let app_root = tempfile::tempdir().unwrap();
        let manager = SandboxManager::new(app_root.path().to_path_buf());
        let account = manager.test_account().unwrap();
        let config = GitSandboxConfig {
            virtual_mcp_id: "vmcp-busy-start".to_string(),
            clone_url: "https://github.com/acme/busy-start.git".to_string(),
            branch: Some("work".to_string()),
            ..Default::default()
        };
        let handle = SandboxManager::compute_handle(&config.clone_url, "work").unwrap();
        let permit = manager.handle_lock(&account, &handle).lock_owned().await;

        let attempted =
            tokio::time::timeout(Duration::from_millis(100), manager.try_provision(&config))
                .await
                .expect("try_provision must not queue behind a held handle lock")
                .expect("busy is not an internal error");
        assert!(attempted.is_none(), "held handle lock reports Busy");
        drop(permit);
    }

    #[tokio::test]
    async fn provision_discards_partial_git_directory_before_clone_retry() {
        let (_origin, clone_url) = setup_two_branch_repo();
        let app_root = tempfile::tempdir().unwrap();
        let manager = SandboxManager::new(app_root.path().to_path_buf());
        let account = manager.test_account().unwrap();
        let config = GitSandboxConfig {
            virtual_mcp_id: "vmcp-partial-git".to_string(),
            clone_url,
            branch: Some("work".to_string()),
            ..Default::default()
        };
        // Derived from the config's OWN clone URL — the handle is the
        // repository scope, so a hardcoded URL would name a different worktree.
        let handle =
            SandboxManager::compute_handle(&config.clone_url, "work").expect("scopeable clone url");
        let workdir = account.storage().workdir(&handle).unwrap();
        std::fs::create_dir_all(workdir.join(".git")).unwrap();
        std::fs::write(workdir.join("partial-object"), "incomplete clone").unwrap();
        manager
            .registry
            .upsert_config_for_account(account.storage(), &handle, &config)
            .unwrap();
        manager
            .registry
            .mark_state_for_account(account.storage(), &handle, "stopped", "stopped", None)
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
        let account = manager.test_account().unwrap();
        let config = GitSandboxConfig {
            virtual_mcp_id: "vmcp-stale-monitor".to_string(),
            clone_url,
            branch: Some("work".to_string()),
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
                    .registry_record_for_account(&account, &current.handle)
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
        let record = manager
            .registry_record_for_account(&account, &current.handle)
            .unwrap()
            .unwrap();
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
        let a = SandboxManager::compute_handle("https://github.com/acme/one.git", "work")
            .expect("scopeable clone url");
        let b = SandboxManager::compute_handle("https://github.com/acme/two.git", "work")
            .expect("scopeable clone url");
        assert_ne!(a, b);
        // ...and the same repository reached by a different URL spelling does.
        let ssh = SandboxManager::compute_handle("git@github.com:acme/one.git", "work")
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
                branch: Some("work".to_string()),
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
                branch: Some("work".to_string()),
                ..Default::default()
            })
            .await
            .expect("ensure succeeds");
        let handle = original.handle.clone();
        let workdir = original.workdir.clone();
        drop(manager_a);

        let manager_b = SandboxManager::new(app_root.path().to_path_buf());
        let account_b = manager_b.test_account().unwrap();
        assert!(
            manager_b.get(&account_b, &handle).is_none(),
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
            manager_b.get(&account_b, &handle).is_some(),
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
                branch: Some("work".to_string()),
                ..Default::default()
            })
            .await
            .expect("initial ensure succeeds");
        let handle = original.handle.clone();
        manager_a
            .stop_registered(&handle)
            .await
            .expect("pre-restart sandbox stop succeeds")
            .expect("sandbox remains registered");
        drop(manager_a);

        let manager_b = SandboxManager::new(app_root.path().to_path_buf());
        let account_b = manager_b.test_account().unwrap();
        let adopted = manager_b
            .adopt(&handle)
            .await
            .expect("metadata adoption succeeds")
            .expect("durable record exists");
        assert_eq!(adopted.handle, handle);
        assert!(adopted.tasks.list(None).is_empty());
        assert_eq!(adopted.setup.lifecycle_snapshot()["phase"], "idle");
        let record = manager_b
            .registry_record_for_account(&account_b, &handle)
            .unwrap()
            .unwrap();
        assert_eq!(record.observed_status, "stopped");
    }

    #[tokio::test]
    async fn stop_during_install_fences_old_cascade_and_preserves_install_checkpoint() {
        let (_root, clone_url) = setup_two_branch_repo();
        let app_root = tempfile::tempdir().unwrap();
        let manager = SandboxManager::new(app_root.path().to_path_buf());
        let account = manager.test_account().unwrap();
        let config = GitSandboxConfig {
            virtual_mcp_id: "vmcp-stop-install-fence".to_string(),
            clone_url,
            branch: Some("work".to_string()),
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
                .registry_record_for_account(&account, &original.handle)
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
        assert!(manager.get(&account, &original.handle).is_none());
        assert_eq!(
            manager
                .registry_record_for_account(&account, &original.handle)
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
                .registry_record_for_account(&account, &resumed.handle)
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
                branch: Some("work".to_string()),
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
                branch: Some("work".to_string()),
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
        let account = manager.test_account().unwrap();
        let mut sandboxes = Vec::new();
        for handle in ["one", "two"] {
            let lock = manager.handle_lock(&account, handle);
            let _permit = lock.lock().await;
            sandboxes.push(
                manager
                    .get_or_create_locked(&account, handle)
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
