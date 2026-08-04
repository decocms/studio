//! Lifecycle of the shared org-filesystem NFS mounts.
//!
//! The volumes are mounted once per account organization under
//! `<app_root>/accounts/v1/<account-id>/orgs/<slug>` and each sandbox in that
//! account links into them (see [`super::org_view`]). This module owns the
//! mounts themselves; P2 of `apps/native/docs/org-fs-plan.md`.
//!
//! ## Why a boot sweep exists at all
//!
//! An NFS mount outlives the process that served it. When the app is SIGKILLed
//! — which happens routinely during development, and to any app the user force
//! quits — rclone dies but the kernel keeps the mount in its table, backed by
//! nothing. The directory is then unusable: the first access blocks for about
//! eight seconds and every later one fails instantly with `ETIMEDOUT`, so the
//! sandbox that owns it can never be re-provisioned at the same path.
//!
//! This is not theoretical. Before this module existed, a development machine
//! had accumulated **21** such ghosts from the previous TS `link` daemon, with
//! no `rclone` process alive to back any of them.
//!
//! `umount -f` reclaims one instantly, and exits non-zero harmlessly when the
//! path is not a mount — so the sweep can run unconditionally at boot without
//! first proving anything about each entry.
//!
//! ## Why entries are keyed by mountpoint, never by source
//!
//! rclone derives its NFS export name from the remote plus a config hash, so
//! several distinct mounts share one source string: three different mountpoints
//! were observed all reporting `localhost:/wd{KnsWa}`. Only the mountpoint
//! identifies a mount, so only the mountpoint decides what this sweeps.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::ExitStatus;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tokio::sync::watch;
use tokio::task::JoinHandle;

use crate::process_group::{ProcessGroupChild, ProcessGroupControl};
use crate::tasks::KillSignal;

use super::account_storage::AccountStorage;
use super::manager::{AccountEpoch, SandboxAccount};
use super::org_view::ORG_VOLUMES;

const ACCOUNT_DRAIN_TIMEOUT: Duration = Duration::from_secs(12);

/// What a non-browser client in this process needs to satisfy local-api's own
/// guard.
///
/// A bearer is NOT sufficient: the shipped app runs embedded, where the guard
/// wants the exact `Host`, the exact `Origin` on unsafe methods (and
/// `PROPFIND` is unsafe — rclone sends no `Origin` by default), and a
/// credential. Without all three, listing fails with
/// `couldn't list files: forbidden origin: 403`.
///
/// `rclone` gets [`Self::mount_token`], which the guard accepts on
/// `/_sandbox/orgfs/*` and nowhere else. Agent terminals mint their own
/// per-session MCP capabilities and use this structure only to discover the
/// local endpoint and CA certificate.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MountCredentials {
    /// `http://<exact expected host>` — the host string must match what the
    /// guard compares against, byte for byte, or every request is rejected.
    pub base_url: String,
    pub origin: String,
    /// The org-filesystem-only credential — see
    /// [`crate::client_auth::MOUNT_TOKEN_HEADER`].
    pub mount_token: String,
    /// The root [`Self::base_url`]'s certificate chains to, when the listener
    /// serves TLS. Consumers whose runtime verifies against the macOS
    /// keychain (rclone via Go, codex via rustls-platform-verifier) never
    /// need it; the claude CLI is Bun/BoringSSL, reads neither the keychain
    /// nor anything but its bundled Mozilla roots, and without this file its
    /// MCP connection to `base_url` fails TLS outright.
    pub ca_cert: Option<PathBuf>,
}

/// Account identifier repeated by rclone on every WebDAV request. The value
/// is the opaque 64-hex [`AccountStorage::id`], never the authenticated
/// storage key. The WebDAV handler exact-compares both this header and its URL
/// segment with the currently authorized account.
pub(crate) const MOUNT_ACCOUNT_HEADER: &str = "x-decocms-mount-account";

fn credentials_cell() -> &'static OnceLock<MountCredentials> {
    static CREDENTIALS: OnceLock<MountCredentials> = OnceLock::new();
    &CREDENTIALS
}

/// The published endpoint and mount credential for loopback child processes.
pub fn local_credentials() -> Option<&'static MountCredentials> {
    credentials_cell().get()
}

/// Publish the credentials once at boot. Mirrors the process-global
/// `set_preview_port` convention rather than adding an `AppState` field,
/// which this module family may not do.
pub fn set_credentials(credentials: MountCredentials) {
    let _ = credentials_cell().set(credentials);
}

/// Account-scoped owner of every mount attempt and live `rclone` child.
///
/// The map key is the complete authenticated storage key. It is never logged,
/// put in a URL, or used as a path; [`AccountStorage::id`] is the opaque path
/// and protocol identifier. Keeping the complete key here prevents two
/// deployments with the same subject from sharing lifecycle state.
#[derive(Clone)]
pub(crate) struct OrgMountManager {
    inner: Arc<OrgMountManagerInner>,
}

struct OrgMountManagerInner {
    app_root: PathBuf,
    state: Mutex<ManagerState>,
}

#[derive(Default)]
struct ManagerState {
    next_attempt_id: u64,
    accounts: HashMap<String, AccountMounts>,
}

struct AccountMounts {
    epoch: AccountEpoch,
    account_id: String,
    orgs_root: PathBuf,
    lifecycle: AccountMountLifecycle,
    orgs: HashMap<String, MountState>,
    /// Retained on purpose: dropping a child tears down the mount it serves.
    children: HashMap<PathBuf, Arc<MountChildSlot>>,
    /// Children that reached the account after their attempt stopped owning
    /// the mountpoint (for example, retirement won the spawn/register race).
    /// They cannot be published as the live child, but their process owners
    /// must remain reachable until a bounded cleanup turn actually joins
    /// them.
    stray_children: Vec<Arc<MountChildSlot>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AccountMountLifecycle {
    Active,
    Retiring,
    Retired,
    Poisoned,
}

impl AccountMounts {
    fn new(account: &SandboxAccount) -> Result<Self, String> {
        Ok(Self {
            epoch: account.epoch(),
            account_id: account.storage().id().to_string(),
            orgs_root: account.storage().orgs_root()?,
            lifecycle: AccountMountLifecycle::Active,
            orgs: HashMap::new(),
            children: HashMap::new(),
            stray_children: Vec::new(),
        })
    }
}

struct DrainingAccount {
    storage_key: String,
    epoch: AccountEpoch,
    account_id: String,
    orgs_root: PathBuf,
    joins: Vec<Arc<tokio::sync::Mutex<Option<JoinHandle<()>>>>>,
}

struct MountChild {
    control: ProcessGroupControl,
    join: JoinHandle<ExitStatus>,
    owner_failure: Option<String>,
}

struct MountChildSlot {
    finished: Arc<AtomicBool>,
    child: tokio::sync::Mutex<Option<MountChild>>,
}

impl MountChildSlot {
    fn new(mut child: ProcessGroupChild) -> Arc<Self> {
        let control = child.control();
        let finished = Arc::new(AtomicBool::new(false));
        let task_finished = Arc::clone(&finished);
        let join = tokio::spawn(async move {
            loop {
                match child.wait().await {
                    Ok(status) => {
                        task_finished.store(true, Ordering::Release);
                        return status;
                    }
                    Err(error) => {
                        tracing::error!(%error, "org-fs process-group wait failed; retaining ownership");
                        tokio::time::sleep(Duration::from_millis(20)).await;
                    }
                }
            }
        });
        Arc::new(Self {
            finished,
            child: tokio::sync::Mutex::new(Some(MountChild {
                control,
                join,
                owner_failure: None,
            })),
        })
    }

    fn is_finished(&self) -> bool {
        self.finished.load(Ordering::Acquire)
    }

    async fn terminate_turn(&self, context: &'static str) -> Result<bool, String> {
        let mut slot = self.child.lock().await;
        let Some(child) = slot.as_mut() else {
            return Ok(true);
        };
        if let Some(error) = &child.owner_failure {
            return Err(error.clone());
        }
        // The monitor owns `wait(2)` and sets this only after the process was
        // reaped. Never signal a saved process-group id after that point: the
        // OS is then free to reuse it for an unrelated process.
        if self.is_finished() {
            return match tokio::time::timeout(Duration::from_secs(2), &mut child.join).await {
                Ok(Ok(_)) => {
                    *slot = None;
                    Ok(true)
                }
                Ok(Err(error)) => {
                    let error = format!("{context} process owner failed: {error}");
                    child.owner_failure = Some(error.clone());
                    Err(error)
                }
                Err(_) => Ok(false),
            };
        }
        let _ = child.control.signal(KillSignal::Term).await;
        match tokio::time::timeout(Duration::from_secs(2), &mut child.join).await {
            Ok(Ok(_)) => {
                *slot = None;
                return Ok(true);
            }
            Ok(Err(error)) => {
                let error = format!("{context} process owner failed: {error}");
                child.owner_failure = Some(error.clone());
                return Err(error);
            }
            Err(_) => {}
        }
        let _ = child.control.signal(KillSignal::Kill).await;
        match tokio::time::timeout(Duration::from_secs(5), &mut child.join).await {
            Ok(Ok(_)) => {
                *slot = None;
                Ok(true)
            }
            Ok(Err(error)) => {
                let error = format!("{context} process owner failed: {error}");
                child.owner_failure = Some(error.clone());
                Err(error)
            }
            Err(_) => Ok(false),
        }
    }
}

/// What [`mount_all`] must do for one volume, given who owns what.
///
/// "Owned" is OUR live [`ProcessGroupChild`] for the mountpoint; "attached"
/// is the kernel mount table. The two agree only in the healthy case, and
/// every disagreement has a distinct repair:
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MountPlan {
    /// Ours and attached — leave it alone.
    Keep,
    /// Attached but NOT ours: a ghost from another app generation. Its
    /// backing server (if any) holds credentials from a dead boot, so every
    /// call it proxies fails; trusting the table here is how a volume ends
    /// up unmounted-in-practice while marked mounted. Reclaim the path,
    /// then spawn fresh.
    ReclaimGhostThenSpawn,
    /// Ours but NOT attached: the child died or its mount was pulled from
    /// under it. Reap what is left, then spawn fresh.
    ReapOwnThenSpawn,
    /// Neither — plain spawn.
    Spawn,
}

fn mount_plan(owned: bool, attached: bool) -> MountPlan {
    match (owned, attached) {
        (true, true) => MountPlan::Keep,
        (false, true) => MountPlan::ReclaimGhostThenSpawn,
        (true, false) => MountPlan::ReapOwnThenSpawn,
        (false, false) => MountPlan::Spawn,
    }
}

/// Per-org mount state.
///
/// The mounts are warmed when the app first touches an organization (see
/// [`warm`]), so by the time a sandbox needs them they are already up. That
/// means this state is consulted from a HOT path — every org-scoped request —
/// so every transition has to be a lock and a map lookup, never work.
enum MountState {
    /// A mount attempt is running. Its task and cancellation sender stay
    /// owned here so an account transition can cancel AND join it.
    InFlight {
        attempt_id: u64,
        cancel: watch::Sender<bool>,
        join: Arc<tokio::sync::Mutex<Option<JoinHandle<()>>>>,
    },
    /// Every volume is attached.
    Ready,
    /// The last attempt failed; refuse new ones until this passes.
    ///
    /// Without a cooldown a failing org would be retried by EVERY org-scoped
    /// request the webview makes — a spawn storm against an upstream that is
    /// already unhappy (the usual cause is simply that the user has not
    /// finished signing in).
    Failed { until: Instant },
}

fn can_claim(state: Option<&MountState>, now: Instant) -> bool {
    match state {
        Some(MountState::Ready) | Some(MountState::InFlight { .. }) => false,
        Some(MountState::Failed { until }) if now < *until => false,
        None | Some(MountState::Failed { .. }) => true,
    }
}

/// How long a failed org is left alone before another attempt.
const FAILURE_COOLDOWN: Duration = Duration::from_secs(30);

/// How long [`wait_ready`] blocks a sandbox ensure on a mount that is not up
/// yet. Short on purpose: with warm mounts this never elapses, so it only
/// matters when something is broken — exactly when blocking provisioning is
/// the wrong trade. The sandbox proceeds with an empty view and says so.
pub const READY_TIMEOUT: Duration = Duration::from_secs(2);

impl OrgMountManager {
    pub(crate) fn new(app_root: PathBuf) -> Self {
        Self {
            inner: Arc::new(OrgMountManagerInner {
                app_root,
                state: Mutex::new(ManagerState::default()),
            }),
        }
    }

    fn lock_state(&self) -> std::sync::MutexGuard<'_, ManagerState> {
        self.inner
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Start mounting an organization's volumes without waiting for them.
    ///
    /// Claim, spawn, and join-handle publication happen under one short
    /// in-memory lock. Account drain therefore sees either no attempt or a
    /// fully cancellable and joinable one; there is no detached-task window.
    pub(crate) fn warm(&self, account: &SandboxAccount, org_slug: &str) -> Result<(), String> {
        if let Err(error) = account.validate() {
            self.invalidate_ready(account, org_slug);
            return Err(error);
        }
        if super::org_view::org_mount_root(account.storage(), org_slug).is_none() {
            self.invalidate_ready(account, org_slug);
            return Err("org-fs mount path is unsafe or unverified".to_string());
        }

        let storage_key = account.storage_key().to_string();
        let account_id = account.storage().id().to_string();
        let replacement = AccountMounts::new(account)?;
        let task_account = account.clone();
        let org = org_slug.to_string();
        let mut state = self.lock_state();
        match state.accounts.get(&storage_key) {
            Some(existing) if existing.epoch == account.epoch() => {
                if existing.lifecycle != AccountMountLifecycle::Active {
                    return Err(format!(
                        "org-fs account {} is not open for mount admission",
                        existing.account_id
                    ));
                }
            }
            Some(existing) if existing.lifecycle != AccountMountLifecycle::Retired => {
                return Err(format!(
                    "org-fs account {} has not completed retirement",
                    existing.account_id
                ));
            }
            Some(_) => {
                state.accounts.insert(storage_key.clone(), replacement);
            }
            None => {
                state.accounts.insert(storage_key.clone(), replacement);
            }
        }
        let claimable = can_claim(
            state
                .accounts
                .get(&storage_key)
                .and_then(|account| account.orgs.get(&org)),
            Instant::now(),
        );
        if !claimable {
            return Ok(());
        }

        let Some(next_attempt_id) = state.next_attempt_id.checked_add(1) else {
            tracing::error!(
                account_id,
                org_slug,
                "org-fs mount attempt counter exhausted"
            );
            return Err("org-fs mount attempt counter exhausted".to_string());
        };
        state.next_attempt_id = next_attempt_id;
        let attempt_id = state.next_attempt_id;
        let (cancel, cancel_rx) = watch::channel(false);
        let manager = self.clone();
        let task_key = storage_key.clone();
        let task_org = org.clone();
        // Spawning while holding this lock is intentional: the task may begin,
        // but it cannot settle/register a child until its JoinHandle is stored.
        let join = tokio::spawn(async move {
            let ok = manager
                .mount_all(&task_account, &task_org, attempt_id, cancel_rx)
                .await;
            manager.settle(&task_key, &task_org, attempt_id, ok);
        });
        let account = state
            .accounts
            .get_mut(&storage_key)
            .expect("account mount state inserted before task spawn");
        debug_assert_eq!(account.account_id, account_id);
        account.orgs.insert(
            org,
            MountState::InFlight {
                attempt_id,
                cancel,
                join: Arc::new(tokio::sync::Mutex::new(Some(join))),
            },
        );
        Ok(())
    }

    fn settle(&self, storage_key: &str, org_slug: &str, attempt_id: u64, ok: bool) -> bool {
        let mut state = self.lock_state();
        let Some(account) = state.accounts.get_mut(storage_key) else {
            return false;
        };
        if account.lifecycle != AccountMountLifecycle::Active {
            return false;
        }
        if !matches!(
            account.orgs.get(org_slug),
            Some(MountState::InFlight {
                attempt_id: current,
                ..
            }) if *current == attempt_id
        ) {
            return false;
        }
        let outcome = if ok {
            MountState::Ready
        } else {
            MountState::Failed {
                until: Instant::now() + FAILURE_COOLDOWN,
            }
        };
        // Dropping this task's own JoinHandle only detaches an already
        // completing task; it does not cancel it.
        account.orgs.insert(org_slug.to_string(), outcome);
        true
    }

    /// Wait for one account organization's volumes, up to [`READY_TIMEOUT`].
    pub(crate) async fn wait_ready(
        &self,
        account: &SandboxAccount,
        org_slug: &str,
    ) -> Result<bool, String> {
        self.warm(account, org_slug)?;
        let storage_key = account.storage_key();
        let epoch = account.epoch();
        let deadline = Instant::now() + READY_TIMEOUT;
        loop {
            let outcome = {
                let state = self.lock_state();
                match state
                    .accounts
                    .get(storage_key)
                    .filter(|mounts| {
                        mounts.epoch == epoch && mounts.lifecycle == AccountMountLifecycle::Active
                    })
                    .and_then(|mounts| mounts.orgs.get(org_slug))
                {
                    Some(MountState::Ready) => Some(true),
                    Some(MountState::Failed { .. }) => Some(false),
                    None | Some(MountState::InFlight { .. }) => None,
                }
            };
            if let Some(ready) = outcome {
                if !ready {
                    return Ok(false);
                }
                match self.ready_is_healthy(account, org_slug).await {
                    Ok(true) => return Ok(true),
                    Ok(false) => {}
                    Err(error) => {
                        self.invalidate_ready(account, org_slug);
                        return Err(error);
                    }
                }
                self.invalidate_ready(account, org_slug);
                self.warm(account, org_slug)?;
            }
            if Instant::now() >= deadline {
                return Ok(false);
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    async fn ready_is_healthy(
        &self,
        owner: &SandboxAccount,
        org_slug: &str,
    ) -> Result<bool, String> {
        owner.validate()?;
        let root = super::org_view::org_mount_root(owner.storage(), org_slug)
            .ok_or_else(|| "org-fs mount root no longer verifies".to_string())?;
        let mounted = try_mounted_paths().await?;
        let state = self.lock_state();
        let Some(account) = state.accounts.get(owner.storage_key()) else {
            return Ok(false);
        };
        if account.epoch != owner.epoch() || account.lifecycle != AccountMountLifecycle::Active {
            return Ok(false);
        }
        Ok(ORG_VOLUMES.iter().all(|volume| {
            let mountpoint = root.join(volume);
            mounted.contains(&mountpoint)
                && account
                    .children
                    .get(&mountpoint)
                    .is_some_and(|child| !child.is_finished())
        }))
    }

    fn invalidate_ready(&self, owner: &SandboxAccount, org_slug: &str) {
        let mut state = self.lock_state();
        let Some(account) = state.accounts.get_mut(owner.storage_key()) else {
            return;
        };
        if account.epoch == owner.epoch()
            && account.lifecycle == AccountMountLifecycle::Active
            && matches!(account.orgs.get(org_slug), Some(MountState::Ready))
        {
            account.orgs.insert(
                org_slug.to_string(),
                MountState::Failed {
                    until: Instant::now(),
                },
            );
        }
    }

    /// Cancel and join every in-flight attempt for one authenticated account,
    /// reap its rclone children, unmount its account-root paths, and purge its
    /// junk shadow. No account storage is deleted.
    pub(crate) async fn drain_account(&self, account: &SandboxAccount) -> Result<(), String> {
        let draining = self.begin_retire(account)?;
        let result = self.finish_drain(draining).await;
        let tombstone =
            self.complete_retire(account.storage_key(), account.epoch(), result.is_ok());
        match (result, tombstone) {
            (Ok(()), Ok(())) => Ok(()),
            (Err(cleanup), Ok(())) => Err(cleanup),
            (Ok(()), Err(tombstone)) => Err(tombstone),
            (Err(cleanup), Err(tombstone)) => Err(format!("{cleanup}; {tombstone}")),
        }
    }

    /// Drain all accounts during process shutdown.
    pub(crate) async fn drain_all(&self) -> Result<(), String> {
        let accounts = {
            let mut state = self.lock_state();
            let mut draining = Vec::new();
            for (storage_key, account) in &mut state.accounts {
                // Shutdown first aborts and joins the identity reaper. A
                // Retiring entry therefore has no live drain owner; its
                // retained joins and child slots are exactly the work this
                // final owner must resume.
                account.lifecycle = AccountMountLifecycle::Retiring;
                draining.push(take_draining_account(storage_key, account));
            }
            draining
        };
        let results = futures::future::join_all(accounts.into_iter().map(|account| async move {
            let storage_key = account.storage_key.clone();
            let epoch = account.epoch;
            let result = self.finish_drain(account).await;
            let tombstone = self.complete_retire(&storage_key, epoch, result.is_ok());
            (result, tombstone)
        }))
        .await;
        let mut failures = Vec::new();
        for (result, tombstone) in results {
            if let Err(error) = result {
                failures.push(error);
            }
            if let Err(error) = tombstone {
                failures.push(error);
            }
        }
        if failures.is_empty() {
            Ok(())
        } else {
            Err(failures.join("; "))
        }
    }

    fn begin_retire(&self, account: &SandboxAccount) -> Result<DrainingAccount, String> {
        let replacement = AccountMounts::new(account)?;
        let mut state = self.lock_state();
        let mounts = state
            .accounts
            .entry(account.storage_key().to_string())
            .or_insert(replacement);
        if mounts.epoch != account.epoch() {
            return Err(format!(
                "org-fs account {} drain used a stale epoch",
                mounts.account_id
            ));
        }
        if mounts.lifecycle == AccountMountLifecycle::Retiring {
            return Err(format!(
                "org-fs account {} drain is already in progress",
                mounts.account_id
            ));
        }
        mounts.lifecycle = AccountMountLifecycle::Retiring;
        Ok(take_draining_account(account.storage_key(), mounts))
    }

    fn complete_retire(
        &self,
        storage_key: &str,
        epoch: AccountEpoch,
        success: bool,
    ) -> Result<(), String> {
        let mut state = self.lock_state();
        let Some(account) = state.accounts.get_mut(storage_key) else {
            return Err("org-fs retirement tombstone disappeared".to_string());
        };
        if account.epoch != epoch || account.lifecycle != AccountMountLifecycle::Retiring {
            return Err(format!(
                "org-fs account {} retirement tombstone changed",
                account.account_id
            ));
        }
        account.lifecycle = if success {
            AccountMountLifecycle::Retired
        } else {
            AccountMountLifecycle::Poisoned
        };
        if success {
            account.orgs.clear();
            account.children.clear();
            account.stray_children.clear();
        }
        Ok(())
    }

    async fn finish_drain(&self, mut account: DrainingAccount) -> Result<(), String> {
        let deadline = tokio::time::Instant::now() + ACCOUNT_DRAIN_TIMEOUT;
        let mut failures = Vec::new();
        // Attempts go first. A task that already crossed cancellation may
        // still spawn and register a child under the Retiring tombstone. Once
        // every attempt has joined, the child snapshot below is complete.
        let account_id = account.account_id.clone();
        let joins = futures::future::join_all(account.joins.drain(..).map(|join_slot| {
            let account_id = account_id.clone();
            async move {
                let mut slot = join_slot.lock().await;
                let Some(join) = slot.as_mut() else {
                    return Ok(());
                };
                match join.await {
                    Ok(()) => {
                        *slot = None;
                        Ok(())
                    }
                    Err(error) => {
                        *slot = None;
                        Err(format!(
                            "org-fs account {account_id} mount attempt failed to join: {error}"
                        ))
                    }
                }
            }
        }));
        match tokio::time::timeout_at(deadline, joins).await {
            Ok(results) => failures.extend(results.into_iter().filter_map(Result::err)),
            Err(_) => failures.push(format!(
                "org-fs account {} mount attempts are still quiescing",
                account.account_id
            )),
        }

        if !failures.is_empty() {
            return Err(failures.join("; "));
        }

        let children = self.retiring_children(&account)?;
        let child_results = futures::future::join_all(
            children
                .into_iter()
                .map(|child| async move { child.terminate_turn("org-fs account drain").await }),
        );
        match tokio::time::timeout_at(deadline, child_results).await {
            Ok(results) => {
                for result in results {
                    match result {
                        Ok(true) => {}
                        Ok(false) => failures.push(format!(
                            "org-fs account {} child is still quiescing",
                            account.account_id
                        )),
                        Err(error) => failures.push(error),
                    }
                }
            }
            Err(_) => failures.push(format!(
                "org-fs account {} children are still quiescing",
                account.account_id
            )),
        }
        if !failures.is_empty() {
            return Err(failures.join("; "));
        }

        let mut unmount_failures = Vec::new();
        match tokio::time::timeout_at(deadline, try_mounted_paths()).await {
            Ok(Ok(paths)) => {
                let unmounts = futures::future::join_all(
                    paths
                        .into_iter()
                        .filter(|path| is_exact_org_mountpoint(path, &account.orgs_root))
                        .map(|mountpoint| async move { force_unmount(&mountpoint).await }),
                );
                match tokio::time::timeout_at(deadline, unmounts).await {
                    Ok(results) => {
                        unmount_failures.extend(results.into_iter().filter_map(Result::err));
                    }
                    Err(_) => unmount_failures.push(format!(
                        "org-fs account {} unmounts exceeded the drain deadline",
                        account.account_id
                    )),
                }
            }
            Ok(Err(error)) => failures.push(error),
            Err(_) => failures.push(format!(
                "org-fs account {} mount-table inspection exceeded the drain deadline",
                account.account_id
            )),
        }
        match tokio::time::timeout_at(deadline, try_mounted_paths()).await {
            Ok(Ok(paths)) => {
                let remaining: Vec<_> = paths
                    .into_iter()
                    .filter(|path| is_exact_org_mountpoint(path, &account.orgs_root))
                    .collect();
                if !remaining.is_empty() {
                    failures.push(format!(
                        "org-fs account {} still has attached mounts: {remaining:?}; {}",
                        account.account_id,
                        unmount_failures.join("; ")
                    ));
                }
            }
            Ok(Err(error)) => failures.push(error),
            Err(_) => failures.push(format!(
                "org-fs account {} final mount-table inspection exceeded the drain deadline",
                account.account_id
            )),
        }
        super::super::routes::webdav::purge_junk_account(&account.account_id);
        if failures.is_empty() {
            Ok(())
        } else {
            Err(failures.join("; "))
        }
    }

    fn retiring_children(
        &self,
        draining: &DrainingAccount,
    ) -> Result<Vec<Arc<MountChildSlot>>, String> {
        let state = self.lock_state();
        let account = state
            .accounts
            .get(&draining.storage_key)
            .ok_or_else(|| "org-fs retirement tombstone disappeared".to_string())?;
        if account.epoch != draining.epoch || account.lifecycle != AccountMountLifecycle::Retiring {
            return Err(format!(
                "org-fs account {} retirement tombstone changed",
                account.account_id
            ));
        }
        Ok(account
            .children
            .values()
            .chain(account.stray_children.iter())
            .cloned()
            .collect())
    }
}

fn take_draining_account(storage_key: &str, account: &mut AccountMounts) -> DrainingAccount {
    let mut joins = Vec::new();
    for mount in account.orgs.values_mut() {
        if let MountState::InFlight { cancel, join, .. } = mount {
            let _ = cancel.send(true);
            joins.push(Arc::clone(join));
        }
    }
    DrainingAccount {
        storage_key: storage_key.to_string(),
        epoch: account.epoch,
        account_id: account.account_id.clone(),
        orgs_root: account.orgs_root.clone(),
        joins,
    }
}

/// The bundled rclone.
///
/// Tauri strips the host triple when copying an `externalBin` into
/// `<App>.app/Contents/MacOS/`, so the packaged binary sits beside the app
/// executable. The triple-suffixed path is the `tauri dev` fallback, where
/// nothing has been copied yet.
fn rclone_binary() -> Option<PathBuf> {
    #[cfg(feature = "e2e-runner")]
    if std::env::var_os("LOCAL_API_E2E_DISABLE_ORG_MOUNTS").as_deref()
        == Some(std::ffi::OsStr::new("1"))
    {
        return None;
    }
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let bundled = dir.join("rclone");
    if bundled.is_file() {
        return Some(bundled);
    }
    // `<arch>-apple-darwin` matches both the Rust host triple `fetch-rclone.sh`
    // names its output with, and `std::env::consts::ARCH` (`aarch64`/`x86_64`).
    let dev = dir.join(format!("rclone-{}-apple-darwin", std::env::consts::ARCH));
    dev.is_file().then_some(dev)
}

/// Mount every volume of `org_slug` that is not already mounted.
///
/// Idempotent: a volume whose mountpoint already appears in the mount table is
/// left alone, so a second sandbox in the same org reuses the first one's
/// mounts instead of spawning a duplicate rclone.
///
/// Best-effort — a failure leaves the volume unmounted, which reads as an
/// empty directory through the sandbox's view rather than as an error.
impl OrgMountManager {
    async fn mount_all(
        &self,
        account: &SandboxAccount,
        org_slug: &str,
        attempt_id: u64,
        mut cancel: watch::Receiver<bool>,
    ) -> bool {
        if account.validate().is_err() {
            return false;
        }
        let storage = account.storage();
        let (Some(root), Some(creds), Some(bin)) = (
            super::org_view::org_mount_root(storage, org_slug),
            credentials_cell().get(),
            rclone_binary(),
        ) else {
            tracing::debug!(
                account_id = storage.id(),
                org_slug,
                "org-fs mount skipped: not configured"
            );
            return false;
        };
        let Some(root_ready) =
            cancel_or(&mut cancel, super::org_view::ensure_real_directory(&root)).await
        else {
            return false;
        };
        if let Err(error) = root_ready {
            tracing::warn!(%error, ?root, "org-fs mount root is not a real directory");
            return false;
        }
        let Some(mounted) = cancel_or(&mut cancel, try_mounted_paths()).await else {
            return false;
        };
        let mounted = match mounted {
            Ok(mounted) => mounted,
            Err(error) => {
                tracing::warn!(%error, "org-fs mount attempt could not inspect attachments");
                return false;
            }
        };
        let lock_path = crate::shared_child_lifetime_lock_path(&self.inner.app_root);
        let mut all = true;
        for volume in ORG_VOLUMES {
            if is_cancelled(&cancel) || account.validate().is_err() {
                return false;
            }
            let mountpoint = root.join(volume);
            let owned = self.owns_child(account, &mountpoint);
            match mount_plan(owned, mounted.contains(&mountpoint)) {
                MountPlan::Keep => continue,
                MountPlan::ReclaimGhostThenSpawn => {
                    tracing::warn!(
                        account_id = storage.id(),
                        ?mountpoint,
                        "reclaiming an org mount this process does not own"
                    );
                    match cancel_or(&mut cancel, force_unmount_until_absent(&mountpoint)).await {
                        None => return false,
                        Some(Ok(())) => {}
                        Some(Err(error)) => {
                            tracing::warn!(%error, ?mountpoint, "could not reclaim org mount");
                            all = false;
                            continue;
                        }
                    }
                }
                MountPlan::ReapOwnThenSpawn => {
                    if let Some(child) = self.take_child(account, &mountpoint) {
                        self.retain_child(account, mountpoint.clone(), Arc::clone(&child));
                        tracing::warn!(
                            account_id = storage.id(),
                            ?mountpoint,
                            "org mount lost its attachment; replacing it"
                        );
                        match child.terminate_turn("org-fs mount replace").await {
                            Ok(true) => {
                                self.remove_child_if_same(account, &mountpoint, &child);
                            }
                            Ok(false) => {
                                self.retain_child(account, mountpoint.clone(), Arc::clone(&child));
                                return false;
                            }
                            Err(error) => {
                                self.retain_child(account, mountpoint.clone(), Arc::clone(&child));
                                tracing::error!(%error, ?mountpoint, "could not reap lost org mount");
                                return false;
                            }
                        }
                    }
                }
                MountPlan::Spawn => {}
            }
            let Some(created) = cancel_or(
                &mut cancel,
                super::org_view::ensure_real_directory(&mountpoint),
            )
            .await
            else {
                return false;
            };
            if let Err(error) = created {
                tracing::warn!(%error, ?mountpoint, "could not create org mountpoint");
                all = false;
                continue;
            }
            let Some(config) = cancel_or(
                &mut cancel,
                write_rclone_config(storage, org_slug, volume, creds),
            )
            .await
            else {
                return false;
            };
            let config = match config {
                Ok(config) => config,
                Err(error) => {
                    tracing::warn!(%error, org_slug, volume, "could not write rclone config");
                    all = false;
                    continue;
                }
            };
            if account.validate().is_err() {
                return false;
            }
            match spawn_mount(&bin, &config, &mountpoint, volume, &lock_path).await {
                Ok(child) => {
                    let child = MountChildSlot::new(child);
                    // Always pass through registration, even if cancellation
                    // just won. The Retiring tombstone retains this owner so
                    // a timed-out TERM/KILL turn can be retried safely.
                    let registered = self.register_child(
                        account,
                        org_slug,
                        attempt_id,
                        mountpoint.clone(),
                        child,
                    );
                    if let Err(child) = registered {
                        match child.terminate_turn("stale org-fs mount").await {
                            Ok(true) => self.remove_stray_child_if_same(account, &child),
                            Ok(false) => tracing::error!(
                                ?mountpoint,
                                "stale org mount is still quiescing; retirement retains it"
                            ),
                            Err(error) => {
                                tracing::error!(%error, ?mountpoint, "could not reap stale org mount");
                            }
                        }
                        return false;
                    }
                    match wait_until_mounted(&mountpoint, &mut cancel).await {
                        Ok(true) => {}
                        Ok(false) => {
                            if is_cancelled(&cancel) {
                                return false;
                            }
                            tracing::warn!(?mountpoint, "org volume did not attach in time");
                            all = false;
                        }
                        Err(error) => {
                            tracing::warn!(%error, ?mountpoint, "could not verify org mount attachment");
                            return false;
                        }
                    }
                }
                Err(error) => {
                    tracing::warn!(%error, ?mountpoint, "failed to spawn rclone");
                    all = false;
                }
            }
        }
        all && !is_cancelled(&cancel) && account.validate().is_ok()
    }

    fn owns_child(&self, owner: &SandboxAccount, mountpoint: &Path) -> bool {
        self.lock_state()
            .accounts
            .get(owner.storage_key())
            .is_some_and(|account| {
                account.epoch == owner.epoch()
                    && account.lifecycle == AccountMountLifecycle::Active
                    && account
                        .children
                        .get(mountpoint)
                        .is_some_and(|child| !child.is_finished())
            })
    }

    fn take_child(&self, owner: &SandboxAccount, mountpoint: &Path) -> Option<Arc<MountChildSlot>> {
        let mut state = self.lock_state();
        let account = state.accounts.get_mut(owner.storage_key())?;
        if account.epoch != owner.epoch() || account.lifecycle != AccountMountLifecycle::Active {
            return None;
        }
        account.children.remove(mountpoint)
    }

    fn retain_child(
        &self,
        owner: &SandboxAccount,
        mountpoint: PathBuf,
        child: Arc<MountChildSlot>,
    ) {
        let mut state = self.lock_state();
        if let Some(account) = state.accounts.get_mut(owner.storage_key()) {
            account.children.entry(mountpoint).or_insert(child);
        }
    }

    fn remove_stray_child_if_same(&self, owner: &SandboxAccount, child: &Arc<MountChildSlot>) {
        let mut state = self.lock_state();
        let Some(account) = state.accounts.get_mut(owner.storage_key()) else {
            return;
        };
        if account.epoch != owner.epoch() {
            return;
        }
        account
            .stray_children
            .retain(|current| !Arc::ptr_eq(current, child));
    }

    fn remove_child_if_same(
        &self,
        owner: &SandboxAccount,
        mountpoint: &Path,
        child: &Arc<MountChildSlot>,
    ) {
        let mut state = self.lock_state();
        let Some(account) = state.accounts.get_mut(owner.storage_key()) else {
            return;
        };
        if account
            .children
            .get(mountpoint)
            .is_some_and(|current| Arc::ptr_eq(current, child))
        {
            account.children.remove(mountpoint);
        }
    }

    fn register_child(
        &self,
        owner: &SandboxAccount,
        org_slug: &str,
        attempt_id: u64,
        mountpoint: PathBuf,
        child: Arc<MountChildSlot>,
    ) -> Result<(), Arc<MountChildSlot>> {
        let owner_valid = owner.validate().is_ok();
        let mut state = self.lock_state();
        let Some(account) = state.accounts.get_mut(owner.storage_key()) else {
            return Err(child);
        };
        if account.epoch != owner.epoch() {
            return Err(child);
        }
        if !owner_valid || account.lifecycle != AccountMountLifecycle::Active {
            account.stray_children.push(Arc::clone(&child));
            return Err(child);
        }
        if !matches!(
            account.orgs.get(org_slug),
            Some(MountState::InFlight {
                attempt_id: current,
                ..
            }) if *current == attempt_id
        ) {
            account.stray_children.push(Arc::clone(&child));
            return Err(child);
        }
        if let Some(previous) = account.children.insert(mountpoint, child) {
            // A duplicate should be unreachable because admission is
            // per-org, but retaining it is safer than letting an unexpected
            // overlap detach a process owner.
            account.stray_children.push(previous);
        }
        Ok(())
    }
}

/// The rclone remote definition for one volume, written to a private file.
///
/// NOT the environment and NOT argv. `ps -Eww` prints another process's
/// environment to any process with the same uid on macOS — and every sandbox
/// harness this app spawns runs as that uid — so an env var is no more private
/// than argv here. A `0600` file the caller owns is the narrowest channel
/// available to a child that can only be configured by file or env.
///
/// The remote's URL is not secret and could stay on the command line; keeping
/// it in the same file just means one shape to reason about.
async fn write_rclone_config(
    storage: &AccountStorage,
    org: &str,
    volume: &str,
    creds: &MountCredentials,
) -> std::io::Result<PathBuf> {
    storage.verify().map_err(std::io::Error::other)?;
    if super::org_view::org_mount_root(storage, org).is_none() || !ORG_VOLUMES.contains(&volume) {
        return Err(std::io::Error::other("unsafe rclone config path"));
    }
    let config_root = storage
        .rclone_config_root()
        .map_err(std::io::Error::other)?;
    let dir = config_root.join(org);
    if !dir.starts_with(storage.root()) {
        return Err(std::io::Error::other(
            "rclone config escaped the verified account root",
        ));
    }
    let config_parent = config_root
        .parent()
        .ok_or_else(|| std::io::Error::other("rclone config root has no parent"))?;
    for directory in [config_parent, config_root.as_path(), dir.as_path()] {
        ensure_private_real_directory(directory).await?;
    }
    let path = dir.join(format!("{volume}.conf"));
    let body = format!(
        "[wd]\ntype = webdav\nurl = {}/_sandbox/orgfs/{account_id}/{org}/{volume}\nvendor = other\nheaders = Origin,{},{account_header},{account_id},{token_header},{}\n",
        creds.base_url,
        creds.origin,
        creds.mount_token,
        account_id = storage.id(),
        org = urlencoding::encode(org),
        volume = urlencoding::encode(volume),
        account_header = MOUNT_ACCOUNT_HEADER,
        token_header = crate::client_auth::MOUNT_TOKEN_HEADER,
    );
    for _ in 0..8 {
        let temporary = dir.join(format!(".{volume}.conf.tmp-{}", uuid::Uuid::new_v4()));
        let mut options = tokio::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        options.mode(0o600);
        let opened = options.open(&temporary).await;
        let mut file = match opened {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        };
        let published = async {
            // The temporary file is empty until its mode is private. The
            // complete config is then synced and atomically replaces any old
            // regular file or symlink; the live path is never truncated.
            restrict(&temporary, 0o600).await?;
            file.write_all(body.as_bytes()).await?;
            file.sync_all().await?;
            drop(file);
            storage.verify().map_err(std::io::Error::other)?;
            verify_private_real_directory(&dir).await?;
            tokio::fs::rename(&temporary, &path).await
        }
        .await;
        if let Err(error) = published {
            let _ = tokio::fs::remove_file(&temporary).await;
            return Err(error);
        }
        return Ok(path);
    }
    Err(std::io::Error::other(
        "could not allocate a temporary rclone config",
    ))
}

fn is_safe_config_segment(segment: &str) -> bool {
    !segment.is_empty()
        && segment != "."
        && segment != ".."
        && !segment.contains('/')
        && !segment.contains('\\')
}

async fn ensure_private_real_directory(path: &Path) -> std::io::Result<()> {
    match tokio::fs::symlink_metadata(path).await {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            match tokio::fs::create_dir(path).await {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(error),
            }
        }
        Err(error) => return Err(error),
    }
    verify_real_directory_type(path).await?;
    restrict(path, 0o700).await?;
    verify_private_real_directory(path).await
}

async fn verify_real_directory_type(path: &Path) -> std::io::Result<()> {
    let metadata = tokio::fs::symlink_metadata(path).await?;
    if !metadata.file_type().is_dir() || metadata.file_type().is_symlink() {
        return Err(std::io::Error::other(format!(
            "rclone config directory is not a real directory: {path:?}"
        )));
    }
    Ok(())
}

async fn verify_private_real_directory(path: &Path) -> std::io::Result<()> {
    let metadata = tokio::fs::symlink_metadata(path).await?;
    verify_real_directory_type(path).await?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err(std::io::Error::other(format!(
                "rclone config directory is not private: {path:?}"
            )));
        }
    }
    Ok(())
}

#[cfg(unix)]
async fn restrict(path: &Path, mode: u32) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    tokio::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).await
}

#[cfg(not(unix))]
async fn restrict(_path: &Path, _mode: u32) -> std::io::Result<()> {
    Ok(())
}

/// Spawn a supervised `rclone nfsmount` for one volume.
///
/// Foreground, never `--daemon`: `nfsmount --daemon --rc` is broken in rclone
/// (it exits 1 rather than attaching), so the child has to be supervised here.
///
/// Nothing secret is passed here at all — see [`write_rclone_config`].
async fn spawn_mount(
    bin: &Path,
    config: &Path,
    mountpoint: &Path,
    volume: &str,
    lifetime_lock: &Path,
) -> std::io::Result<ProcessGroupChild> {
    let mut cmd = Command::new(bin);
    cmd.arg("--config")
        .arg(config)
        .arg("nfsmount")
        .arg("wd:")
        .arg(mountpoint)
        .args([
            "--option",
            "actimeo=1,locallocks,soft,timeo=100,retrans=2,nobrowse",
        ])
        .args(["--vfs-cache-mode", "full"])
        .args(["--vfs-write-back", "1s"])
        .args(["--dir-cache-time", "10s"])
        // rclone's DEFAULTS are unusable here: its VFS downloader retries to a
        // hard-coded 10-error limit, so `--timeout` x `--low-level-retries` x
        // 11 is the worst-case block when the backing server stops answering
        // — about NINE HOURS at the defaults. On loopback a request is either
        // instant or dead, so bound it aggressively.
        .args(["--timeout", "5s"])
        .args(["--contimeout", "3s"])
        .args(["--low-level-retries", "1"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    // One more layer under the WebDAV surface's own write refusal — the
    // shared predicate lives beside `ORG_VOLUMES` so the two layers cannot
    // disagree about which volumes those are.
    if super::org_view::is_read_only_volume(volume) {
        cmd.arg("--read-only");
    }
    // Anchored to the app-wide fence like every other spawned child:
    // `kill_on_drop` never fires for a SIGKILLed parent (or for a static the
    // process never drops), and an orphaned rclone is worse than most orphans
    // — it keeps a mount alive that authenticates with a dead boot's rotated
    // token, so the mount LOOKS attached while every operation through it
    // fails.
    ProcessGroupChild::spawn(&mut cmd, lifetime_lock).await
}

fn is_cancelled(cancel: &watch::Receiver<bool>) -> bool {
    *cancel.borrow()
}

/// Await one mount step, but give account retirement priority whenever both
/// become ready together. A closed sender also means the owning attempt was
/// retired.
async fn cancel_or<T>(
    cancel: &mut watch::Receiver<bool>,
    future: impl std::future::Future<Output = T>,
) -> Option<T> {
    if is_cancelled(cancel) {
        return None;
    }
    tokio::select! {
        biased;
        _ = cancel.changed() => None,
        output = future => Some(output),
    }
}

/// Wait for the kernel to actually attach the mount.
///
/// The mount TABLE is the authoritative signal. rclone's `rc` API reports
/// ready about 36 ms before the kernel attaches, so trusting it would hand
/// out a path that is not yet a mount.
async fn wait_until_mounted(
    mountpoint: &Path,
    cancel: &mut watch::Receiver<bool>,
) -> Result<bool, String> {
    for _ in 0..40 {
        let Some(mounted) = cancel_or(cancel, try_mounted_paths()).await else {
            return Ok(false);
        };
        let mounted = mounted?;
        if mounted.contains(&mountpoint.to_path_buf()) {
            return Ok(true);
        }
        if cancel_or(cancel, tokio::time::sleep(Duration::from_millis(100)))
            .await
            .is_none()
        {
            return Ok(false);
        }
    }
    Ok(false)
}

/// Every NFS mountpoint currently attached.
async fn try_mounted_paths() -> Result<Vec<PathBuf>, String> {
    let output = Command::new("mount")
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true)
        .output()
        .await
        .map_err(|error| format!("failed to inspect the mount table: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "mount-table command exited with status {}",
            output.status
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(parse_mount_line)
        .filter(|(_, fstype)| fstype == "nfs")
        .map(|(mountpoint, _)| mountpoint)
        .collect())
}

/// Reclaim every stale org mount left behind by a previous run.
///
/// Best-effort and unconditional: a path that is not actually mounted simply
/// fails to unmount, which costs one process and nothing else. Scoped to
/// a verified account-layout `orgs/` root so it can never touch a mount this
/// app does not own.
pub async fn prune_stale_mounts(app_root: &Path) {
    if !cfg!(target_os = "macos") {
        return;
    }
    let Ok(output) = tokio::process::Command::new("mount")
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true)
        .output()
        .await
    else {
        return;
    };
    let table = String::from_utf8_lossy(&output.stdout);
    let stale = stale_mountpoints(&table, app_root);

    // Kill the servers BEFORE reclaiming their mountpoints: an orphan still
    // answering NFS can keep a mount busy, and once its path is unmounted it
    // has nothing left to serve anyway.
    kill_orphaned_servers(&stale).await;

    for mountpoint in stale {
        let _ = force_unmount(&mountpoint).await;
    }
}

/// `umount -f` one path. Best-effort: a path that is not actually mounted
/// simply fails to unmount, which costs one process and nothing else.
async fn force_unmount(mountpoint: &Path) -> Result<(), String> {
    let path = mountpoint.to_string_lossy().into_owned();
    let result = tokio::process::Command::new("umount")
        .args(["-f", &path])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .status()
        .await;
    let success = match result {
        Ok(status) if status.success() => {
            tracing::info!(mountpoint = %path, "reclaimed a stale org mount");
            true
        }
        Ok(status) => {
            tracing::warn!(mountpoint = %path, %status, "org mount did not unmount");
            false
        }
        Err(error) => {
            return Err(format!("failed to run umount for {path}: {error}"));
        }
    };
    unmount_exit_result(mountpoint, success)
}

fn unmount_exit_result(mountpoint: &Path, success: bool) -> Result<(), String> {
    if success {
        Ok(())
    } else {
        Err(format!("umount failed for org-fs path: {mountpoint:?}"))
    }
}

/// A non-zero `umount` is not by itself proof that the attachment remains: a
/// concurrent kernel/rclone teardown may have won the race. Re-read the
/// authoritative table before suppressing a replacement spawn.
async fn force_unmount_until_absent(mountpoint: &Path) -> Result<(), String> {
    let unmount_error = match force_unmount(mountpoint).await {
        Ok(()) => return Ok(()),
        Err(error) => error,
    };
    let mounted = try_mounted_paths().await?;
    if mounted.contains(&mountpoint.to_path_buf()) {
        Err(unmount_error)
    } else {
        Ok(())
    }
}

/// Kill `rclone` processes left over from a previous run of this app.
///
/// `kill_on_drop` only fires when the `Child` is DROPPED. A hard exit — a
/// SIGKILL, or the restart a dev loop performs on every rebuild — runs no
/// destructors, so the children survive, get reparented to init, and leak. One
/// development session accumulated EIGHT of them, each serving a mountpoint
/// that had already been reclaimed.
///
/// Safe to run unconditionally at boot precisely because it runs at boot: this
/// process has not spawned any mounts yet, so every match is somebody else's
/// corpse. Matching is scoped to argv that references this app root's `orgs/`
/// directory, so an rclone the user runs for their own purposes is untouched.
async fn kill_orphaned_servers(mountpoints: &[PathBuf]) {
    if mountpoints.is_empty() {
        return;
    }
    let Ok(output) = Command::new("ps")
        .args(["-eo", "pid=,command="])
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true)
        .output()
        .await
    else {
        return;
    };
    for pid in orphaned_rclone_pids(&String::from_utf8_lossy(&output.stdout), mountpoints) {
        let _ = Command::new("kill")
            .args(["-9", &pid.to_string()])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true)
            .status()
            .await;
        tracing::info!(pid, "killed an orphaned org-fs mount server");
    }
}

/// PIDs of `rclone` processes whose argv names one marker-verified mountpoint.
///
/// Pure so the matching — the part that decides what gets SIGKILLed — is
/// testable without spawning anything.
fn orphaned_rclone_pids(ps_output: &str, mountpoints: &[PathBuf]) -> Vec<i32> {
    ps_output
        .lines()
        .filter_map(|line| {
            let (pid, command) = take_word(line)?;
            let (executable, arguments) = take_word(command)?;
            if Path::new(executable).file_name()?.to_str()? != "rclone" {
                return None;
            }
            let arguments = arguments.trim_start();
            let addresses_mount = mountpoints.iter().any(|mountpoint| {
                let Some(expected) = expected_rclone_argv_prefix(mountpoint) else {
                    return false;
                };
                arguments.strip_prefix(&expected).is_some_and(|tail| {
                    tail.is_empty() || tail.chars().next().is_some_and(char::is_whitespace)
                })
            });
            addresses_mount.then(|| pid.parse::<i32>().ok()).flatten()
        })
        .collect()
}

/// The exact argv prefix emitted by [`spawn_mount`] for one verified
/// mountpoint. Deriving the private config path from the mount shape keeps a
/// process that merely mentions the path from matching the boot-time SIGKILL
/// sweep, while still handling spaces in either absolute path.
fn expected_rclone_argv_prefix(mountpoint: &Path) -> Option<String> {
    let volume = mountpoint.file_name()?.to_str()?;
    let org_root = mountpoint.parent()?;
    let org = org_root.file_name()?.to_str()?;
    let orgs_root = org_root.parent()?;
    if orgs_root.file_name()?.to_str()? != "orgs" || !ORG_VOLUMES.contains(&volume) {
        return None;
    }
    let account_root = orgs_root.parent()?;
    let config = account_root
        .join(".decocms/rclone")
        .join(org)
        .join(format!("{volume}.conf"));
    Some(format!(
        "--config {} nfsmount wd: {}",
        config.display(),
        mountpoint.display()
    ))
}

fn take_word(input: &str) -> Option<(&str, &str)> {
    let input = input.trim_start();
    let end = input.find(char::is_whitespace).unwrap_or(input.len());
    (!input.is_empty()).then(|| (&input[..end], &input[end..]))
}

/// The NFS mountpoints under an opaque account's `orgs/` directory named in a
/// `mount` table.
///
/// Kept pure so the parsing — the part that can silently sweep the wrong path
/// — is testable without mounting anything.
fn stale_mountpoints(table: &str, app_root: &Path) -> Vec<PathBuf> {
    table
        .lines()
        .filter_map(parse_mount_line)
        .filter(|(mountpoint, fstype)| {
            fstype == "nfs" && verified_mount_storage(app_root, mountpoint).is_some()
        })
        .map(|(mountpoint, _)| mountpoint)
        .collect()
}

fn mount_account_id<'a>(mountpoint: &'a Path, accounts_root: &Path) -> Option<&'a str> {
    let Ok(relative) = mountpoint.strip_prefix(accounts_root) else {
        return None;
    };
    let components: Vec<_> = relative.components().collect();
    if components.len() != 4 {
        return None;
    }
    let std::path::Component::Normal(account_id) = components[0] else {
        return None;
    };
    let account_id = account_id.to_str()?;
    let std::path::Component::Normal(org) = components[2] else {
        return None;
    };
    let org = org.to_str()?;
    let std::path::Component::Normal(volume) = components[3] else {
        return None;
    };
    let volume = volume.to_str()?;
    (account_id.len() == 64
        && account_id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        && components[1].as_os_str() == "orgs"
        && is_safe_config_segment(org)
        && ORG_VOLUMES.contains(&volume))
    .then_some(account_id)
}

fn is_exact_org_mountpoint(mountpoint: &Path, orgs_root: &Path) -> bool {
    let Ok(relative) = mountpoint.strip_prefix(orgs_root) else {
        return false;
    };
    let mut components = relative.components();
    let (Some(std::path::Component::Normal(org)), Some(std::path::Component::Normal(volume))) =
        (components.next(), components.next())
    else {
        return false;
    };
    components.next().is_none()
        && org.to_str().is_some_and(is_safe_config_segment)
        && volume
            .to_str()
            .is_some_and(|volume| ORG_VOLUMES.contains(&volume))
}

/// Re-open the account marker through AccountStorage before trusting a boot
/// sweep candidate. A path that merely LOOKS like the account layout is not
/// enough authority to SIGKILL its server and force-unmount it.
fn verified_mount_storage(app_root: &Path, mountpoint: &Path) -> Option<AccountStorage> {
    let accounts_root = app_root.join("accounts").join("v1");
    let account_id = mount_account_id(mountpoint, &accounts_root)?;
    let account_root = accounts_root.join(account_id);
    let marker = account_root.join(".account-scope-v1");
    let metadata = std::fs::symlink_metadata(&marker).ok()?;
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
        return None;
    }
    let storage_key = read_bounded_regular_file(&marker, 8 * 1024)?;
    let storage = AccountStorage::open(app_root, &storage_key).ok()?;
    let orgs_root = storage.orgs_root().ok()?;
    (storage.id() == account_id
        && storage.root() == account_root
        && mountpoint.starts_with(orgs_root))
    .then_some(storage)
}

/// Read at most `limit` bytes even if the marker changes after metadata was
/// inspected. The later [`AccountStorage::open`] re-verifies the marker and
/// account digest; this bound prevents the boot sweep from allocating an
/// attacker-controlled file size before that verification.
fn read_bounded_regular_file(path: &Path, limit: usize) -> Option<String> {
    use std::io::Read;

    let file = std::fs::File::open(path).ok()?;
    let metadata = file.metadata().ok()?;
    if !metadata.file_type().is_file() || metadata.len() > limit as u64 {
        return None;
    }
    let mut body = Vec::with_capacity(metadata.len() as usize);
    file.take(limit as u64 + 1).read_to_end(&mut body).ok()?;
    if body.len() > limit {
        return None;
    }
    String::from_utf8(body).ok()
}

/// `<source> on <mountpoint> (<fstype>, <opts>…)` — the BSD `mount` format.
///
/// Split on the literal separators rather than on whitespace: a mountpoint may
/// contain spaces, and the source is discarded anyway (see this module's doc on
/// why sources cannot identify a mount).
fn parse_mount_line(line: &str) -> Option<(PathBuf, String)> {
    let (_, rest) = line.split_once(" on ")?;
    let (mountpoint, tail) = rest.rsplit_once(" (")?;
    let fstype = tail.split(',').next()?.trim_end_matches(')').trim();
    Some((PathBuf::from(mountpoint), fstype.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn storage(app_root: &Path, storage_key: &str) -> AccountStorage {
        AccountStorage::open(app_root, storage_key).expect("account storage")
    }

    /// Real `mount` output captured on macOS, including the ghosts this sweep
    /// exists for.
    fn mount_table(a: &AccountStorage, b: &AccountStorage) -> String {
        let a_root = a.orgs_root().expect("account A org root");
        let b_root = b.orgs_root().expect("account B org root");
        format!(
            "/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)\n\
             devfs on /dev (devfs, local, nobrowse)\n\
             localhost:/wd{{rkiaF}} on {}/acme/home (nfs, nodev, nosuid, nobrowse, mounted by gimenes)\n\
             localhost:/wd{{rkiaF}} on {}/acme/uploads (nfs, nodev, nosuid, nobrowse)\n\
             localhost:/wd{{other}} on {}/other-org/public (nfs, nodev, nosuid)\n\
             map auto_home on /System/Volumes/Data/home (autofs, automounted, nobrowse)\n",
            a_root.display(),
            a_root.display(),
            b_root.display(),
        )
    }

    #[test]
    fn sweeps_every_nfs_mount_under_the_orgs_root() {
        let root = tempfile::tempdir().expect("tempdir");
        let a = storage(root.path(), "https://studio-a.example\0subject");
        let b = storage(root.path(), "https://studio-b.example\0subject");
        let found = stale_mountpoints(&mount_table(&a, &b), root.path());
        let a_root = a.orgs_root().expect("account A org root");
        let b_root = b.orgs_root().expect("account B org root");
        assert_eq!(
            found,
            vec![
                a_root.join("acme/home"),
                a_root.join("acme/uploads"),
                b_root.join("other-org/public"),
            ]
        );
    }

    /// The sweep force-unmounts, so scoping is the only thing standing between
    /// it and someone else's filesystem.
    #[test]
    fn never_touches_a_mount_outside_the_orgs_root() {
        let table = concat!(
            "localhost:/wd{x} on /app/sandboxes/h1/repo (nfs, nodev)\n",
            "server:/export on /Volumes/work (nfs, nodev)\n",
            "localhost:/wd{y} on /other-app/orgs/acme/home (nfs, nodev)\n",
            "localhost:/wd{z} on /app/accounts/v1/not-a-digest/orgs/acme/home (nfs, nodev)\n",
            "localhost:/wd{m} on /app/accounts/v1/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/orgs/acme/home (nfs, nodev)\n",
            "localhost:/wd{q} on /app/accounts/v1/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/worktrees/h1/org/home (nfs, nodev)\n",
        );
        assert!(stale_mountpoints(table, Path::new("/app")).is_empty());
    }

    #[test]
    fn ignores_non_nfs_filesystems_at_the_same_paths() {
        let table = concat!(
            "/dev/disk5 on /app/accounts/v1/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/orgs/acme/home (apfs, local)\n",
            "devfs on /app/accounts/v1/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/orgs/acme/uploads (devfs, local, nobrowse)\n",
        );
        assert!(stale_mountpoints(table, Path::new("/app")).is_empty());
    }

    /// A mountpoint may contain spaces — splitting the line on whitespace
    /// would truncate the path and unmount something else, or nothing.
    #[test]
    fn handles_mountpoints_containing_spaces() {
        let root = tempfile::tempdir().expect("tempdir");
        let account = storage(root.path(), "https://studio.example\0subject-spaces");
        let mountpoint = account
            .orgs_root()
            .expect("account org root")
            .join("my org/home");
        let table = format!(
            "localhost:/wd{{z}} on {} (nfs, nodev)\n",
            mountpoint.display()
        );
        assert_eq!(stale_mountpoints(&table, root.path()), vec![mountpoint]);
    }

    #[test]
    fn boot_sweep_rejects_unknown_volumes_and_tampered_account_markers() {
        let root = tempfile::tempdir().expect("tempdir");
        let account = storage(root.path(), "https://studio.example\0subject-sweep");
        let orgs = account.orgs_root().expect("orgs root");
        let unknown = format!(
            "localhost:/wd{{z}} on {} (nfs, nodev)\n",
            orgs.join("acme/skills").display()
        );
        assert!(stale_mountpoints(&unknown, root.path()).is_empty());

        let known = format!(
            "localhost:/wd{{z}} on {} (nfs, nodev)\n",
            orgs.join("acme/home").display()
        );
        std::fs::write(
            account.root().join(".account-scope-v1"),
            b"replacement-account",
        )
        .expect("tamper marker");
        assert!(stale_mountpoints(&known, root.path()).is_empty());
    }

    #[test]
    fn boot_marker_reads_are_bounded_by_actual_bytes() {
        let root = tempfile::tempdir().expect("tempdir");
        let marker = root.path().join("marker");
        std::fs::write(&marker, b"small").expect("small marker");
        assert_eq!(
            read_bounded_regular_file(&marker, 8).as_deref(),
            Some("small")
        );
        std::fs::write(&marker, vec![b'x'; 9]).expect("oversized marker");
        assert!(read_bounded_regular_file(&marker, 8).is_none());
    }

    /// `public` holds the org's curated shared skill sets. The WebDAV surface
    /// already refuses writes to it; mounting it read-only is the second layer,
    /// so a bug in either one alone cannot corrupt shared content.
    /// The leak this exists for: `kill_on_drop` never fires on a hard exit, so
    /// rclone children outlive the app and pile up across restarts.
    #[test]
    fn finds_orphaned_rclone_servers_by_our_own_orgs_path() {
        let mounts = vec![
            PathBuf::from("/data/accounts/v1/aaa/orgs/deco/home"),
            PathBuf::from("/data/accounts/v1/bbb/orgs/acme/uploads"),
        ];
        let ps = concat!(
            " 100 /App.app/Contents/MacOS/rclone --config /data/accounts/v1/aaa/.decocms/rclone/deco/home.conf nfsmount wd: /data/accounts/v1/aaa/orgs/deco/home --option x\n",
            " 101 /App.app/Contents/MacOS/rclone --config /data/accounts/v1/bbb/.decocms/rclone/acme/uploads.conf nfsmount wd: /data/accounts/v1/bbb/orgs/acme/uploads\n",
        );
        assert_eq!(orphaned_rclone_pids(ps, &mounts), vec![100, 101]);
    }

    /// This SIGKILLs what it matches, so everything it must NOT match is the
    /// part worth pinning.
    #[test]
    fn never_kills_a_process_that_is_not_ours() {
        let mounts = vec![PathBuf::from("/data/accounts/v1/aaa/orgs/deco/home")];
        let ps = concat!(
            // The user's own rclone, serving their own backup.
            " 102 /usr/local/bin/rclone mount remote: /Users/me/backup\n",
            // Our app itself.
            " 103 /App.app/Contents/MacOS/deco\n",
            // Something merely MENTIONING the path — a grep, an editor.
            " 104 grep -r rclone /data/accounts/v1\n",
            // Another app's org mounts, same layout, different root.
            " 105 /Other.app/Contents/MacOS/rclone --config /elsewhere/.decocms/rclone/deco/home.conf nfsmount wd: /elsewhere/orgs/deco/home\n",
            // Right mountpoint but not the exact account-scoped config path.
            " 106 /App.app/Contents/MacOS/rclone --config /tmp/home.conf nfsmount wd: /data/accounts/v1/aaa/orgs/deco/home\n",
        );
        assert!(orphaned_rclone_pids(ps, &mounts).is_empty());
    }

    #[tokio::test]
    async fn rclone_config_is_account_scoped_atomic_and_rejects_symlinked_ancestors() {
        let root = tempfile::tempdir().expect("tempdir");
        let a_key = "https://studio-a.example\0same-subject";
        let b_key = "https://studio-b.example\0same-subject";
        let a = storage(root.path(), a_key);
        let b = storage(root.path(), b_key);
        let credentials = MountCredentials {
            base_url: "https://127.0.0.1:4000".to_string(),
            origin: "https://studio.localhost".to_string(),
            mount_token: "mount-secret".to_string(),
            ca_cert: None,
        };

        let a_config = write_rclone_config(&a, "acme", "home", &credentials)
            .await
            .expect("account A config");
        let b_config = write_rclone_config(&b, "acme", "home", &credentials)
            .await
            .expect("account B config");
        assert_ne!(a_config, b_config);
        assert!(a_config.starts_with(a.rclone_config_root().expect("A config root")));
        assert!(b_config.starts_with(b.rclone_config_root().expect("B config root")));
        let a_body = std::fs::read_to_string(&a_config).expect("read A config");
        assert!(a_body.contains(&format!("/_sandbox/orgfs/{}/acme/home", a.id())));
        assert!(a_body.contains(&format!("{MOUNT_ACCOUNT_HEADER},{}", a.id())));
        assert!(!a_body.contains(a_key));

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::symlink_metadata(&a_config)
                    .expect("config metadata")
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }

        let c = storage(root.path(), "https://studio-c.example\0subject");
        let outside = tempfile::tempdir().expect("outside");
        std::os::unix::fs::symlink(outside.path(), c.root().join(".decocms"))
            .expect("config parent symlink");
        assert!(write_rclone_config(&c, "acme", "home", &credentials)
            .await
            .is_err());
        assert!(std::fs::read_dir(outside.path())
            .expect("outside listing")
            .next()
            .is_none());
    }

    /// Concurrency: an in-flight or ready org cannot admit a second attempt.
    #[test]
    fn only_one_mount_attempt_per_org_can_be_in_flight() {
        let (cancel, _cancel_rx) = watch::channel(false);
        let in_flight = MountState::InFlight {
            attempt_id: 1,
            cancel,
            join: Arc::new(tokio::sync::Mutex::new(None)),
        };
        assert!(!can_claim(Some(&in_flight), Instant::now()));
        assert!(!can_claim(Some(&MountState::Ready), Instant::now()));
        assert!(can_claim(None, Instant::now()));
    }

    /// The trap that made the request hook viable: this runs on EVERY
    /// org-scoped request, so a failing org must not be retried by each one —
    /// that is a spawn storm against an upstream that is already unhappy.
    #[test]
    fn a_failed_org_is_left_alone_until_its_cooldown_expires() {
        let now = Instant::now();
        let cooling = MountState::Failed {
            until: now + Duration::from_secs(1),
        };
        let expired = MountState::Failed {
            until: now - Duration::from_secs(1),
        };
        assert!(!can_claim(Some(&cooling), now));
        assert!(can_claim(Some(&expired), now));
    }

    #[tokio::test]
    async fn stale_account_tickets_and_poisoned_tombstones_reject_new_mounts() {
        let root = tempfile::tempdir().expect("tempdir");
        let sandbox_manager = super::super::manager::SandboxManager::new(root.path().to_path_buf());
        let scope =
            crate::routes::threads::db::RtAccountScope::new("studio.example", "org-fs-account")
                .expect("valid account scope");
        let account = sandbox_manager
            .test_account_for_scope(&scope)
            .expect("bound sandbox account");
        let mounts = OrgMountManager::new(root.path().to_path_buf());

        let mut tombstone = AccountMounts::new(&account).expect("account mounts");
        tombstone.lifecycle = AccountMountLifecycle::Poisoned;
        tombstone.orgs.insert("acme".to_string(), MountState::Ready);
        mounts
            .lock_state()
            .accounts
            .insert(account.storage_key().to_string(), tombstone);
        assert!(mounts.warm(&account, "acme").is_err());

        let draining = mounts.begin_retire(&account).expect("retry poisoned drain");
        assert_eq!(draining.epoch, account.epoch());
        mounts
            .complete_retire(account.storage_key(), account.epoch(), false)
            .expect("poison failed retirement");
        {
            let state = mounts.lock_state();
            let retained = state
                .accounts
                .get(account.storage_key())
                .expect("retained tombstone");
            assert_eq!(retained.lifecycle, AccountMountLifecycle::Poisoned);
            assert!(matches!(retained.orgs.get("acme"), Some(MountState::Ready)));
        }

        let transition = sandbox_manager
            .begin_account_transition()
            .await
            .expect("begin account transition");
        assert!(mounts.warm(&account, "other").is_err());
        transition.complete().expect("complete account transition");
        assert!(mounts.warm(&account, "other").is_err());
    }

    #[tokio::test]
    async fn shutdown_resumes_an_abandoned_retiring_tombstone() {
        let root = tempfile::tempdir().expect("tempdir");
        let sandbox_manager = super::super::manager::SandboxManager::new(root.path().to_path_buf());
        let account = sandbox_manager.test_account().expect("bound account");
        let mounts = OrgMountManager::new(root.path().to_path_buf());
        let mut tombstone = AccountMounts::new(&account).expect("account mounts");
        tombstone.lifecycle = AccountMountLifecycle::Retiring;
        mounts
            .lock_state()
            .accounts
            .insert(account.storage_key().to_string(), tombstone);

        mounts.drain_all().await.expect("shutdown drain");

        let state = mounts.lock_state();
        let retired = state
            .accounts
            .get(account.storage_key())
            .expect("retirement tombstone retained");
        assert_eq!(retired.lifecycle, AccountMountLifecycle::Retired);
    }

    /// Every disagreement between "we own a child" and "the kernel shows a
    /// mount" is a repair, not a skip. Trusting the table alone let a ghost
    /// mount from a dead app generation suppress the respawn, so the volume
    /// stayed broken and writes fell through to the raw directory.
    #[test]
    fn only_an_owned_and_attached_mount_is_kept() {
        assert_eq!(mount_plan(true, true), MountPlan::Keep);
        assert_eq!(mount_plan(false, true), MountPlan::ReclaimGhostThenSpawn);
        assert_eq!(mount_plan(true, false), MountPlan::ReapOwnThenSpawn);
        assert_eq!(mount_plan(false, false), MountPlan::Spawn);
    }

    #[test]
    fn tolerates_lines_that_are_not_mount_entries() {
        for line in ["", "garbage", "no-separator (nfs)", "x on y"] {
            assert!(
                stale_mountpoints(line, Path::new("/app")).is_empty(),
                "{line:?}"
            );
        }
    }

    #[test]
    fn a_failed_unmount_is_a_retirement_error_until_absence_is_proven() {
        let mountpoint = Path::new("/account/orgs/acme/home");
        assert!(unmount_exit_result(mountpoint, true).is_ok());
        assert!(unmount_exit_result(mountpoint, false)
            .unwrap_err()
            .contains("umount failed"));
    }
}
