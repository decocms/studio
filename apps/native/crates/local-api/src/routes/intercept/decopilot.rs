//! `/api/:org/decopilot/*` — chat dispatch + streaming. Wire contract:
//! the native interception contract §3.2. This ENTIRE
//! family is intercepted, 100% of the time (see `routes/intercept/mod.rs`'s
//! module doc for why) — [`dispatch`] never returns `None`.
//!
//! Routes:
//! - `POST threads/:threadId/messages` → [`send_message`]: `202 {taskId}`,
//!   enqueues the turn on a durable SQLite per-thread FIFO (with a process-local
//!   cancellation mirror). Different threads can run concurrently, but a thread
//!   has exactly one active harness. A queued turn is not mirrored onto SSE
//!   until it becomes the head, matching the production thread-gate contract.
//! - `GET threads/:threadId/stream` → [`stream`]: SSE `event: message` /
//!   `data: <UIMessageChunk>` frames — replays whatever's already happened
//!   for this thread's current turn, then tails live until the turn ends.
//!   A thread with no dispatch YET holds the connection open (matching the
//!   real backend's "persistent connection stays open across runs" model,
//!   `apps/api/src/api/routes/decopilot/routes.ts`'s stream handler) rather
//!   than `204`ing — the real client (`thread-connection.ts`'s
//!   `runSseLoop`) treats `204` as terminal ("nothing will ever come here,
//!   stop reconnecting"), which is only correct for the real backend's own
//!   degraded-JetStream case, never for an ordinary idle thread. `204` only
//!   fires here for a genuinely-impossible state (see [`DecopilotRun`]'s
//!   doc comment).
//! - `POST cancel/:threadId` → [`cancel`]: best-effort abort, `202`.
//! - `GET queue/:threadId` → [`queue_list`]: the running head + queued tail in
//!   production's `QueueItemDTO` wire shape.
//! - `POST queue/:threadId/cancel/:workflowId` → [`queue_cancel`]: cancels an
//!   active harness or removes a queued turn; `404` when the workflow is not
//!   pending for this thread.
//! - anything else under this prefix → local `404`, never forwarded (the
//!   100%-intercepted backstop).
//!
//! ## Chunk translation: (almost) none needed
//!
//! `harness::run::RunEvent::Chunk` payloads are ALREADY AI-SDK
//! `UIMessageChunk`-shaped JSON (`{"type":"start"}`, `{"type":"text-delta",
//! ...}`, `{"type":"finish",...}`, ...) — see `crates/harness/src/events/
//! {claude,codex}.rs`. This module's ENTIRE translation job is: (1) wrap
//! each chunk in `event: message\ndata: <chunk>\n\n` framing (decopilot's
//! real SSE framing, map §3.2 — NOT dispatch's data-only framing), (2)
//! prepend one `data-user-message` chunk mirroring the just-sent turn (map
//! §3.2's "other viewers see it live" note — best-effort shape, not
//! byte-pinned anywhere this crate can verify), and (3) turn a
//! [`harness::run::RunEvent::FatalError`] into an AI-SDK-shaped `error`
//! chunk followed by a synthetic `finish` (mirrors `routes/dispatch.rs`'s
//! own `harness_crashed` handling, adapted to this family's chunk-shaped
//! error convention instead of dispatch's `{"type":"error","code":...}`
//! envelope).

use std::collections::{HashMap, HashSet, VecDeque};
use std::convert::Infallible;
#[cfg(test)]
use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use upstream::poison::MutexExt;

use axum::body::{Body, Bytes};
use axum::http::{Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use futures::future::join_all;
use futures::stream;
use regex::Regex;
use serde_json::{json, Value};
use tokio::sync::{Mutex as AsyncMutex, Notify};

use crate::error::ApiError;
use crate::routes::intercept::run_spool::{RunSpool, RunSubscription, StagedFrame};
use crate::routes::intercept::watch;
use crate::routes::threads::db::DEFAULT_THREAD_TITLE;
use crate::routes::threads::db::{
    is_native_assistant_message_id, legacy_native_assistant_message_id, DbError, RtAccountScope,
    RtOrphanedTurn, RtThreadFence, RtTurnBeginOutcome, RtTurnCancelOutcome, RtTurnClaimOutcome,
    RtTurnEnqueueInput, RtTurnEnqueueOutcome, RtTurnQueueItem, RtTurnQueueState,
    RtTurnTerminalOutcome, RtTurnTerminalStatus, ThreadsDb, NATIVE_ASSISTANT_MESSAGE_ID_PREFIX,
};
use crate::routes::threads::shared_db;
use crate::state::AppState;

/// Opaque `virtual_mcp_id` stamped on a thread implicitly created by a
/// desktop dispatch (no prior `COLLECTION_THREADS_CREATE` call) — never
/// validated against a real virtual-MCP registry, see `routes/intercept/
/// mod.rs`'s module doc's "`:org` is opaque" note. Mirrors the SHAPE of
/// `getWellKnownDecopilotVirtualMCP(orgId).id` (map §3.1) closely enough to
/// read as "the org's default agent" in a debugger, without importing any
/// TS constant.
fn implicit_virtual_mcp_id(org: &str) -> String {
    format!("i:{org}:decopilot")
}

/// `state.repo_dir` (today's plain-dir behavior, unchanged) unless the
/// dispatch body carries a `sandbox` block — see
/// the native Git-sandbox contract. The real UI already resolves
/// the virtual MCP's GitHub repo (owner/name/runtime) client-side before
/// sending a chat message; a git-backed thread includes it here as
/// `{ virtualMcpId, repo: { cloneUrl, branch }, workload?: { runtime,
/// packageManager, packageManagerPath } }` so this route never needs to
/// re-fetch it. A missing `sandbox` block does NOT mean "not git-backed" —
/// the webview also omits it while its lifecycle context is still attaching —
/// so it falls through to [`sandbox_config_from_thread`], and only a thread
/// whose agent really has no repository reaches the plain `repo_dir`. Ensure
/// failure (bad repo/branch, offline, ...) keeps the run in its OWN
/// `<app_root>/sandboxes/<handle>/repo` — never the shared `repo_dir`, see
/// [`crate::sandbox::SandboxManager::workdir_for`] — rather than failing the
/// dispatch outright: the clone/install failure is independently observable
/// via the sandbox's own `SetupOrchestrator` lifecycle, not this route's SSE
/// error frame.
async fn resolve_send_message_cwd(
    state: &AppState,
    input: &Value,
    fence: &RtThreadFence,
    db: &'static ThreadsDb,
) -> std::path::PathBuf {
    let git_cfg = match git_sandbox_config_from_input(input) {
        Some(mut cfg) => {
            // The block names the repo but not the organization, and the org
            // is what the shared org-filesystem mounts are keyed by.
            cfg.org_slug
                .get_or_insert_with(|| fence.organization_id.clone());
            Some(cfg)
        }
        None => sandbox_config_from_thread(fence, db).await,
    };
    let Some(git_cfg) = git_cfg else {
        // A gitless agent has no repository to sit in, so it runs INSIDE the
        // organization filesystem: `<app_root>/orgs/<slug>` is the directory
        // whose children are the mounted volumes. That gives it `home`,
        // `public`, `uploads` and `outputs` with no symlink indirection —
        // and replaces the previous behavior, where EVERY gitless agent ran
        // in one shared `state.repo_dir` and could see every other's files.
        //
        // Scoped per organization rather than per agent because the content
        // is org-wide: two agents in one org would see identical volumes
        // anyway, and cross-ORG is the boundary that actually matters.
        let org_dir =
            crate::sandbox::org_view::org_mount_root(&state.app_root, &fence.organization_id);
        if let Some(org_dir) = org_dir {
            crate::sandbox::org_mount::warm(&state.app_root, &fence.organization_id);
            if tokio::fs::create_dir_all(&org_dir).await.is_ok() {
                tracing::info!(
                    org = %fence.organization_id,
                    dir = %org_dir.display(),
                    "send_message: gitless agent runs in the organization filesystem"
                );
                return org_dir;
            }
        }
        tracing::warn!(
            "send_message: could not prepare the organization directory → plain repo_dir"
        );
        return state.repo_dir.clone();
    };
    tracing::info!(
        virtual_mcp_id = %git_cfg.virtual_mcp_id,
        branch = ?git_cfg.branch,
        "send_message: sandbox block present → SandboxManager::ensure"
    );
    match state.sandbox_manager.ensure(&git_cfg).await {
        Ok(sandbox) => sandbox.workdir.clone(),
        Err(err) => {
            let workdir = state.sandbox_manager.workdir_for(&git_cfg);
            tracing::warn!(
                error = %err,
                workdir = %workdir.display(),
                "git sandbox ensure failed for decopilot send_message; staying in the sandbox workdir"
            );
            let _ = tokio::fs::create_dir_all(&workdir).await;
            workdir
        }
    }
}

/// The thread's own git config, recovered from the local thread store plus
/// upstream, for a dispatch that carried no `sandbox` block.
///
/// The webview omits that block whenever its sandbox lifecycle context has
/// not attached yet — a fresh thread, or a reload mid-provision. Treating
/// that window as "not git-backed" sent the agent, and every file it wrote,
/// into the shared `state.repo_dir` instead of the user's worktree: work
/// silently landed outside the branch it belonged to, in a directory every
/// other thread also writes. Nothing here needs the client's help — the
/// thread row already names its agent and the agent's metadata already names
/// its repository, so the desktop resolves it the same way `SANDBOX_START`
/// does.
///
/// `None` only for a thread whose agent genuinely has no repository, which is
/// the one case where the plain repo dir is correct.
async fn sandbox_config_from_thread(
    fence: &RtThreadFence,
    db: &'static ThreadsDb,
) -> Option<crate::sandbox::GitSandboxConfig> {
    let thread = db.rt_get_thread_for_fence(fence).ok().flatten()?;
    let virtual_mcp = crate::routes::upstream::call_org_tool(
        &fence.organization_id,
        "COLLECTION_VIRTUAL_MCP_GET",
        &json!({ "id": thread.virtual_mcp_id }),
    )
    .await
    .map_err(|error| {
        tracing::warn!(
            %error,
            thread_id = %fence.thread_id,
            "could not resolve the thread's agent repository"
        );
    })
    .ok()?;
    // `COLLECTION_VIRTUAL_MCP_GET` answers `{ item: … }`; tolerate a bare
    // entity too, matching `sandbox_lifecycle::start`.
    let entity = virtual_mcp.get("item").unwrap_or(&virtual_mcp);
    let config = super::sandbox_lifecycle::config_from_virtual_mcp(
        &thread.virtual_mcp_id,
        thread.branch.as_deref(),
        entity.get("metadata")?,
        Some(&fence.organization_id),
    )?;
    tracing::info!(
        thread_id = %fence.thread_id,
        virtual_mcp_id = %thread.virtual_mcp_id,
        "send_message: no sandbox block → recovered the thread's repository from upstream"
    );
    Some(config)
}

/// Parses the `sandbox` block (see [`resolve_send_message_cwd`]'s doc
/// comment for the shape) — `None` when absent, or missing either required
/// field (`virtualMcpId`, `repo.cloneUrl`), which is treated exactly like
/// "not git-backed" rather than an error: this endpoint has no dedicated
/// `sandbox`-shape validation gate (unlike `routes/dispatch.rs`'s
/// `harnessStreamInputSchema` port), so a malformed block degrades to the
/// plain-dir default instead of failing the whole chat send.
fn git_sandbox_config_from_input(input: &Value) -> Option<crate::sandbox::GitSandboxConfig> {
    let sandbox = input.get("sandbox")?;
    let virtual_mcp_id = sandbox
        .get("virtualMcpId")
        .and_then(Value::as_str)?
        .to_string();
    let repo = sandbox.get("repo")?;
    let clone_url = repo.get("cloneUrl").and_then(Value::as_str)?.to_string();
    let branch = repo
        .get("branch")
        .and_then(Value::as_str)
        .map(str::to_string);
    let workload = sandbox.get("workload");
    let runtime = workload
        .and_then(|w| w.get("runtime"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let package_manager = workload
        .and_then(|w| w.get("packageManager"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let package_manager_path = workload
        .and_then(|w| w.get("packageManagerPath"))
        .and_then(Value::as_str)
        .map(str::to_string);
    Some(crate::sandbox::GitSandboxConfig {
        // The webview's sandbox block carries no org; `resolve_send_message_cwd`
        // fills it from the turn's fence, which always has one.
        org_slug: None,
        virtual_mcp_id,
        clone_url,
        branch,
        runtime,
        package_manager,
        package_manager_path,
        git_user_name: None,
        git_user_email: None,
    })
}

/// One in-flight-or-just-finished chat turn's SSE frames, keyed by the
/// organization/thread pair in the process-wide [`registry`]. Replay bytes
/// live in a bounded 0600 disk spool; RAM contains only bounded live fan-out.
///
/// ## Idle placeholder (GET arrives before any dispatch)
///
/// [`stream`] eagerly creates (rather than 204ing) a registry entry for a
/// thread_id it's never seen — an empty spool, a live sender, zero
/// frames. [`send_message`] REUSES that same instance (see
/// [`Self::is_idle_placeholder`]) instead of unconditionally replacing it,
/// so the frame it pushes reaches the subscriber that GET already
/// registered, live — rather than orphaning that subscriber against a
/// channel nothing ever writes to. Once a dispatch has actually pushed
/// frames (or a later dispatch starts a genuinely new turn), the NEXT
/// dispatch replaces the entry outright (only the FIFO head is ever current;
/// later turns stay in the per-thread queue, map §3.2).
///
/// Idle placeholders expire after ten minutes. Finished spools get a five
/// minute reconnect grace period, then their registry slot and file are
/// removed even if no client consumed the terminal stream.
///
/// ## Replay policy (a stated simplification, not the real backend's exact
/// behavior)
///
/// Every [`stream`] call replays the FULL disk spool from the start, then (if
/// the run is still live) tails new frames. The entry is removed from the
/// registry only once some consumer has read the stream through to its
/// natural end (see `stream`'s cleanup). For a single-viewer desktop
/// webview this is unobservable in practice (there's only ever one tab
/// tailing a thread); a multi-viewer scenario would see a full replay on
/// every reconnect instead of a true incremental tail, which map §3.2's
/// real contract doesn't need for desktop v1.
struct DecopilotRun {
    key: ThreadKey,
    spool: Arc<RunSpool>,
    has_frames: AtomicBool,
    finished: AtomicBool,
    finish_lock: AsyncMutex<()>,
}

impl DecopilotRun {
    async fn open(state: &AppState, key: ThreadKey) -> Result<Arc<Self>, String> {
        let path = state
            .app_root
            .join(".decocms")
            .join("run-streams")
            .join(format!("{}.sse", uuid::Uuid::new_v4()));
        let spool = RunSpool::open(path)
            .await
            .map_err(|error| error.to_string())?;
        let run = Arc::new(Self {
            key,
            spool,
            has_frames: AtomicBool::new(false),
            finished: AtomicBool::new(false),
            finish_lock: AsyncMutex::new(()),
        });
        Ok(run)
    }

    async fn push(&self, frame: Bytes) -> Result<(), String> {
        self.spool
            .append(frame)
            .await
            .map_err(|error| error.to_string())?;
        self.has_frames.store(true, Ordering::SeqCst);
        Ok(())
    }

    async fn stage_terminal(&self, frame: Bytes) -> Result<StagedFrame, String> {
        self.spool
            .stage(frame)
            .await
            .map_err(|error| error.to_string())
    }

    async fn commit_terminal(&self, staged: StagedFrame) -> Result<(), String> {
        self.spool
            .commit_staged(staged)
            .await
            .map_err(|error| error.to_string())?;
        self.has_frames.store(true, Ordering::SeqCst);
        Ok(())
    }

    async fn rollback_terminal(&self, staged: StagedFrame) -> Result<(), String> {
        self.spool
            .rollback_staged(staged)
            .await
            .map_err(|error| error.to_string())
    }

    async fn finish(self: &Arc<Self>) {
        let guard = self.finish_lock.lock().await;
        if self.finished.load(Ordering::SeqCst) {
            return;
        }
        if let Err(error) = self.spool.finish().await {
            tracing::warn!(%error, "failed to finish native chat run spool");
            // Keep the run retryable: setting `finished` before durable spool
            // closure would make every later caller falsely believe the live
            // sender was closed.
            return;
        }
        self.finished.store(true, Ordering::SeqCst);
        drop(guard);
        let run = self.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(5 * 60)).await;
            cleanup_run(&run).await;
        });
    }

    async fn subscribe(&self) -> Result<RunSubscription, String> {
        self.spool
            .subscribe()
            .await
            .map_err(|error| error.to_string())
    }

    /// True only for a [`stream`]-created placeholder that no dispatch has
    /// touched yet (empty spool, live sender still active) — see this struct's
    /// "Idle placeholder" doc section. `send_message` reuses `self` rather
    /// than replacing it exactly when this is true.
    fn is_idle_placeholder(&self) -> bool {
        !self.has_frames.load(Ordering::SeqCst) && !self.finished.load(Ordering::SeqCst)
    }

    fn schedule_idle_cleanup(self: &Arc<Self>) {
        let run = self.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(10 * 60)).await;
            if run.is_idle_placeholder() {
                cleanup_run(&run).await;
            }
        });
    }
}

/// Registry ownership and file ownership are deliberately separate. An old
/// response may finish after a newer turn replaced its registry slot: identity
/// fencing protects that newer slot, but the old run still owns (and must
/// delete) its unique spool file.
async fn cleanup_run(run: &Arc<DecopilotRun>) {
    remove_run_if_current(&run.key, run);
    if let Err(error) = run.spool.remove().await {
        tracing::warn!(%error, "failed to remove native chat run spool");
    }
}

/// Cancellation exists before a turn has a child process: cancelling a head
/// while it is resolving its sandbox/CLI must prevent that child from ever
/// escaping. Installing a handle and requesting cancellation are race-safe in
/// both orders (the installer re-checks `requested` after publishing it).
struct TurnCancellation {
    requested: AtomicBool,
    handle: Mutex<Option<harness::run::CancelHandle>>,
}

impl TurnCancellation {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            requested: AtomicBool::new(false),
            handle: Mutex::new(None),
        })
    }

    fn is_requested(&self) -> bool {
        self.requested.load(Ordering::SeqCst)
    }

    fn install(&self, handle: harness::run::CancelHandle) -> bool {
        *self.handle.lock_ok() = Some(handle);
        self.is_requested()
    }

    async fn request(&self) {
        self.requested.store(true, Ordering::SeqCst);
        let handle = self.handle.lock_ok().clone();
        if let Some(handle) = handle {
            handle.cancel().await;
        }
    }
}

#[derive(Clone)]
struct QueuedTurn {
    key: ThreadKey,
    fence: RtThreadFence,
    workflow_id: String,
    message_id: String,
    input: Value,
    user_message: Value,
    #[cfg(test)]
    enqueued_at: u64,
    #[cfg(test)]
    text: String,
    #[cfg(test)]
    has_attachments: bool,
    cancellation: Arc<TurnCancellation>,
}

impl QueuedTurn {
    fn from_durable(item: RtTurnQueueItem) -> Self {
        let user_message = item.user_message;
        Self {
            key: ThreadKey {
                account_scope: item.fence.account_scope.clone(),
                org: item.fence.organization_id.clone(),
                thread_id: item.fence.thread_id.clone(),
            },
            fence: item.fence,
            workflow_id: item.workflow_id,
            message_id: item.message_id,
            input: item.normalized_input,
            #[cfg(test)]
            text: queue_text(&user_message),
            #[cfg(test)]
            has_attachments: has_attachments(&user_message),
            user_message,
            #[cfg(test)]
            enqueued_at: item.enqueued_at,
            cancellation: TurnCancellation::new(),
        }
    }
}

/// Runtime registries are tenant-scoped even though the production workflow id
/// string is not: two organizations may legitimately reuse a local thread id,
/// and neither SSE replay nor cancellation may cross that boundary.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct ThreadKey {
    account_scope: String,
    org: String,
    thread_id: String,
}

impl ThreadKey {
    fn scoped(scope: &RtAccountScope, org: &str, thread_id: &str) -> Self {
        Self {
            account_scope: scope.storage_key(),
            org: org.to_string(),
            thread_id: thread_id.to_string(),
        }
    }

    fn from_fence(fence: &RtThreadFence) -> Self {
        Self {
            account_scope: fence.account_scope.clone(),
            org: fence.organization_id.clone(),
            thread_id: fence.thread_id.clone(),
        }
    }

    #[cfg(test)]
    fn new(org: &str, thread_id: &str) -> Self {
        Self::scoped(
            &RtAccountScope::new("test.invalid", "local-desktop-user").unwrap(),
            org,
            thread_id,
        )
    }
}

struct ThreadQueueInner {
    /// The front is the running/resolving head whenever `worker_running` is
    /// true. Keeping the head in this deque until *all* persistence and the
    /// terminal SSE publish complete makes LIST/cancel atomic and truthful.
    items: VecDeque<QueuedTurn>,
    worker_running: bool,
    /// Set by thread deletion or app shutdown. The current head may finish
    /// its cancellation path, but it must never promote another queued turn.
    stop_after_current: bool,
    /// Sticky process-lifetime evidence that a harness stopped without its
    /// terminal SQLite transaction committing. Shutdown must not report a
    /// clean reap merely because the process-local worker is no longer alive:
    /// the durable head still needs boot recovery.
    durable_terminal_failed: bool,
}

struct ThreadQueue {
    inner: Mutex<ThreadQueueInner>,
    changed: Notify,
}

enum EnqueueOutcome {
    Duplicate,
    Enqueued { first: Option<Box<QueuedTurn>> },
}

type DurableClaimAdmission = (
    Result<Option<RtTurnClaimOutcome>, DbError>,
    Option<QueuedTurn>,
);

#[cfg(test)]
enum QueueCancelOutcome {
    Active(Arc<TurnCancellation>),
    Queued,
    NotFound,
}

impl ThreadQueue {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            inner: Mutex::new(ThreadQueueInner {
                items: VecDeque::new(),
                worker_running: false,
                stop_after_current: false,
                durable_terminal_failed: false,
            }),
            changed: Notify::new(),
        })
    }

    /// Atomically dedupes against both the active head and queued tail. The
    /// returned `first` is an ownership token: exactly its recipient may start
    /// a drain worker, so two concurrent POSTs can never both launch a harness.
    fn enqueue(&self, turn: QueuedTurn) -> EnqueueOutcome {
        let mut inner = self.inner.lock_ok();
        if inner
            .items
            .iter()
            .any(|item| item.message_id == turn.message_id)
        {
            return EnqueueOutcome::Duplicate;
        }

        inner.items.push_back(turn);
        let first = if inner.worker_running {
            None
        } else {
            inner.stop_after_current = false;
            inner.worker_running = true;
            inner.items.front().cloned().map(Box::new)
        };
        self.changed.notify_waiters();
        EnqueueOutcome::Enqueued { first }
    }

    /// Claims process-local worker ownership for a durable queue discovered
    /// from SQLite. Recovery deliberately does not pre-decode every queued
    /// payload into this RAM mirror: the worker claims and parses one raw FIFO
    /// head at a time, so a malformed tail cannot fail account recovery.
    fn start_worker_if_idle(&self) -> bool {
        let mut inner = self.inner.lock_ok();
        if inner.worker_running {
            return false;
        }
        inner.stop_after_current = false;
        inner.worker_running = true;
        self.changed.notify_waiters();
        true
    }

    /// Completes exactly the head the worker just executed and atomically
    /// hands it the next item while retaining worker ownership. If empty, the
    /// worker relinquishes ownership before returning; a concurrent enqueue
    /// then receives a fresh `first` token and starts the next worker.
    #[cfg(test)]
    fn complete_and_next(&self, workflow_id: &str) -> Option<QueuedTurn> {
        let mut inner = self.inner.lock_ok();
        if inner.items.front().map(|item| item.workflow_id.as_str()) != Some(workflow_id) {
            tracing::error!(
                workflow_id,
                "decopilot queue worker attempted to complete a non-head turn"
            );
            inner.worker_running = false;
            return None;
        }
        inner.items.pop_front();
        if inner.stop_after_current {
            inner.worker_running = false;
            self.changed.notify_waiters();
            return None;
        }
        let next = inner.items.front().cloned();
        if next.is_none() {
            inner.worker_running = false;
        }
        self.changed.notify_waiters();
        next
    }

    #[cfg(test)]
    fn list(&self) -> Vec<Value> {
        let inner = self.inner.lock_ok();
        inner
            .items
            .iter()
            .enumerate()
            .map(|(index, item)| {
                json!({
                    "workflowId": item.workflow_id,
                    "messageId": item.message_id,
                    "status": if index == 0 && inner.worker_running { "running" } else { "queued" },
                    "enqueuedAt": item.enqueued_at,
                    "source": "user-message",
                    "text": item.text,
                    "hasAttachments": item.has_attachments,
                })
            })
            .collect()
    }

    #[cfg(test)]
    fn cancel_workflow(&self, workflow_id: &str) -> QueueCancelOutcome {
        let mut inner = self.inner.lock_ok();
        let Some(index) = inner
            .items
            .iter()
            .position(|item| item.workflow_id == workflow_id)
        else {
            return QueueCancelOutcome::NotFound;
        };
        if index == 0 && inner.worker_running {
            return QueueCancelOutcome::Active(inner.items[0].cancellation.clone());
        }
        inner.items.remove(index);
        self.changed.notify_waiters();
        QueueCancelOutcome::Queued
    }

    /// Reconciles the process-local cancellation handle with SQLite's claimed
    /// head while the worker retains the queue admission mutex across its stop
    /// check, durable claim, and cancellation-handle installation.
    /// That single critical section prevents shutdown from observing an empty
    /// recovered RAM mirror after the durable head was already claimed.
    fn activate_claimed_locked(
        &self,
        inner: &mut ThreadQueueInner,
        item: RtTurnQueueItem,
    ) -> QueuedTurn {
        let position = inner
            .items
            .iter()
            .position(|turn| turn.workflow_id == item.workflow_id);
        let cancellation = position
            .and_then(|index| inner.items.get(index))
            .map(|turn| turn.cancellation.clone())
            .unwrap_or_else(TurnCancellation::new);
        if let Some(index) = position {
            if index > 0 {
                tracing::warn!(
                    workflow_id = item.workflow_id,
                    stale_items = index,
                    "dropping stale in-memory queue entries before durable head"
                );
                inner.items.drain(..index);
            }
            inner.items.pop_front();
        }
        let mut turn = QueuedTurn::from_durable(item);
        turn.cancellation = cancellation;
        inner.items.push_front(turn.clone());
        self.changed.notify_waiters();
        turn
    }

    /// Returns `None` when shutdown/delete won admission. Otherwise the SQLite
    /// claim result and (for a ready head) its already-installed RAM mirror are
    /// returned after releasing the non-async mutex, keeping the drain future
    /// `Send` while preserving the atomic stop-vs-claim boundary.
    fn claim_durable_head(
        &self,
        db: &ThreadsDb,
        fence: &RtThreadFence,
    ) -> Option<DurableClaimAdmission> {
        let mut inner = self.inner.lock_ok();
        if inner.stop_after_current {
            inner.items.clear();
            inner.worker_running = false;
            self.changed.notify_waiters();
            return None;
        }
        let claim_result = db.rt_claim_turn_queue_head_fenced(fence);
        let activated = match &claim_result {
            Ok(Some(RtTurnClaimOutcome::Ready(item))) => {
                Some(self.activate_claimed_locked(&mut inner, item.clone()))
            }
            _ => None,
        };
        Some((claim_result, activated))
    }

    /// Removes a completed claimed head while retaining worker ownership. The
    /// worker itself performs the next SQLite claim under the lifecycle gate;
    /// relinquishing ownership merely because the RAM mirror is momentarily
    /// empty would let a concurrent sender start a second worker.
    fn complete_claimed(&self, workflow_id: &str) -> bool {
        let mut inner = self.inner.lock_ok();
        if let Some(index) = inner
            .items
            .iter()
            .position(|turn| turn.workflow_id == workflow_id)
        {
            inner.items.remove(index);
        }
        let stop = inner.stop_after_current;
        if stop {
            inner.worker_running = false;
        }
        self.changed.notify_waiters();
        stop
    }

    fn stop_worker(&self) {
        let mut inner = self.inner.lock_ok();
        inner.worker_running = false;
        self.changed.notify_waiters();
    }

    /// Records a lost durable completion fence before releasing worker
    /// ownership. This flag is intentionally never cleared on this queue: a
    /// later in-process enqueue/reap cannot prove the failed transaction was
    /// recovered, while the next process boot owns durable recovery.
    fn stop_worker_after_durable_terminal_failure(&self) {
        let mut inner = self.inner.lock_ok();
        inner.durable_terminal_failed = true;
        inner.worker_running = false;
        self.changed.notify_waiters();
    }

    fn durable_terminal_failed(&self) -> bool {
        self.inner.lock_ok().durable_terminal_failed
    }

    fn cancellation_for(&self, workflow_id: &str) -> Option<Arc<TurnCancellation>> {
        self.inner
            .lock_ok()
            .items
            .iter()
            .find(|turn| turn.workflow_id == workflow_id)
            .map(|turn| turn.cancellation.clone())
    }

    fn remove_mirror(&self, workflow_id: &str) {
        let mut inner = self.inner.lock_ok();
        if let Some(index) = inner
            .items
            .iter()
            .position(|turn| turn.workflow_id == workflow_id)
        {
            inner.items.remove(index);
            self.changed.notify_waiters();
        }
    }

    /// Prevents any queued tail from being promoted, removes that tail from
    /// the process-local mirror, and returns the active head's cancellation
    /// handle plus the removed workflow ids. Durable queue rows are mutated by
    /// the caller while holding the same thread lifecycle gate.
    fn stop_and_drain_tail(&self) -> (Option<Arc<TurnCancellation>>, Vec<String>) {
        let mut inner = self.inner.lock_ok();
        inner.stop_after_current = true;
        let active = inner
            .worker_running
            .then(|| inner.items.front().map(|turn| turn.cancellation.clone()))
            .flatten();
        let keep = usize::from(active.is_some());
        let removed = inner
            .items
            .drain(keep..)
            .map(|turn| turn.workflow_id)
            .collect();
        // A recovered worker may be alive but not yet have mirrored its first
        // durable claim. Empty RAM therefore does not prove there is no worker;
        // the worker relinquishes ownership at its claim-admission boundary.
        self.changed.notify_waiters();
        (active, removed)
    }

    async fn wait_worker_stopped(&self) {
        loop {
            let changed = self.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            if !self.inner.lock_ok().worker_running {
                return;
            }
            changed.await;
        }
    }

    fn is_idle(&self) -> bool {
        let inner = self.inner.lock_ok();
        !inner.worker_running && inner.items.is_empty() && !inner.durable_terminal_failed
    }
}

fn registry() -> &'static Mutex<HashMap<ThreadKey, Arc<DecopilotRun>>> {
    static REGISTRY: OnceLock<Mutex<HashMap<ThreadKey, Arc<DecopilotRun>>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

fn thread_queues() -> &'static Mutex<HashMap<ThreadKey, Arc<ThreadQueue>>> {
    static QUEUES: OnceLock<Mutex<HashMap<ThreadKey, Arc<ThreadQueue>>>> = OnceLock::new();
    QUEUES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn lifecycle_gates() -> &'static Mutex<HashMap<ThreadKey, Arc<AsyncMutex<()>>>> {
    static GATES: OnceLock<Mutex<HashMap<ThreadKey, Arc<AsyncMutex<()>>>>> = OnceLock::new();
    GATES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn recovery_gates() -> &'static Mutex<HashMap<String, Arc<AsyncMutex<()>>>> {
    static GATES: OnceLock<Mutex<HashMap<String, Arc<AsyncMutex<()>>>>> = OnceLock::new();
    GATES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn recovered_accounts() -> &'static Mutex<HashSet<String>> {
    static RECOVERED: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    RECOVERED.get_or_init(|| Mutex::new(HashSet::new()))
}

fn closing_threads() -> &'static Mutex<HashSet<ThreadKey>> {
    static CLOSING: OnceLock<Mutex<HashSet<ThreadKey>>> = OnceLock::new();
    CLOSING.get_or_init(|| Mutex::new(HashSet::new()))
}

pub(crate) fn mark_thread_closing(scope: &RtAccountScope, org: &str, thread_id: &str) {
    closing_threads()
        .lock_ok()
        .insert(ThreadKey::scoped(scope, org, thread_id));
}

pub(crate) fn clear_thread_closing(scope: &RtAccountScope, org: &str, thread_id: &str) {
    closing_threads()
        .lock_ok()
        .remove(&ThreadKey::scoped(scope, org, thread_id));
}

pub(crate) fn thread_is_closing(scope: &RtAccountScope, org: &str, thread_id: &str) -> bool {
    closing_threads()
        .lock_ok()
        .contains(&ThreadKey::scoped(scope, org, thread_id))
}

/// Serializes the accept/delete boundary for one tenant-scoped thread. A send
/// must not return `202` while deletion is cancelling the old generation, and
/// a recreated thread id must not become visible until that worker is gone.
pub(crate) fn thread_lifecycle_gate(
    scope: &RtAccountScope,
    org: &str,
    thread_id: &str,
) -> Arc<AsyncMutex<()>> {
    thread_lifecycle_gate_for_key(&ThreadKey::scoped(scope, org, thread_id))
}

fn thread_lifecycle_gate_for_key(key: &ThreadKey) -> Arc<AsyncMutex<()>> {
    lifecycle_gates()
        .lock_ok()
        .entry(key.clone())
        .or_insert_with(|| Arc::new(AsyncMutex::new(())))
        .clone()
}

fn enqueue_thread_turn(key: &ThreadKey, turn: QueuedTurn) -> (Arc<ThreadQueue>, EnqueueOutcome) {
    // Keep the registry lock through `enqueue`: this pairs with
    // `remove_queue_if_idle` and prevents a sender from retaining an idle queue
    // just as cleanup removes it, then enqueueing onto an orphan Arc.
    let mut queues = thread_queues().lock_ok();
    let queue = queues
        .entry(key.clone())
        .or_insert_with(ThreadQueue::new)
        .clone();
    let outcome = queue.enqueue(turn);
    (queue, outcome)
}

fn start_recovered_thread_queue(key: &ThreadKey) -> (Arc<ThreadQueue>, bool) {
    let mut queues = thread_queues().lock_ok();
    let queue = queues
        .entry(key.clone())
        .or_insert_with(ThreadQueue::new)
        .clone();
    let started = queue.start_worker_if_idle();
    (queue, started)
}

fn remove_queue_if_idle(key: &ThreadKey, expected: &Arc<ThreadQueue>) -> bool {
    let mut queues = thread_queues().lock_ok();
    let is_current = queues
        .get(key)
        .is_some_and(|current| Arc::ptr_eq(current, expected));
    if is_current && expected.is_idle() {
        queues.remove(key);
        return true;
    }
    false
}

fn epoch_millis() -> u64 {
    // The registry's canonical clock; clamped because this caller's wire
    // shape is unsigned.
    u64::try_from(crate::tasks::now_ms()).unwrap_or(0)
}

fn queue_text(user_message: &Value) -> String {
    user_message
        .get("parts")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|part| part.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|part| part.get("text").and_then(Value::as_str))
        .collect::<String>()
        .trim()
        .to_string()
}

/// How much of the first message becomes the title. Byte-parity with
/// `FALLBACK_TITLE_MAX_CHARS` in `packages/harness/src/title-generator.ts`.
const AUTO_TITLE_MAX_CHARS: usize = 32;

/// The thread title derived from its first user message, or `None` when the
/// message has nothing nameable in it (attachments only, whitespace, emoji).
///
/// Port of `genTitle`'s `fallbackTitle`: the literal first 32 CHARACTERS —
/// not bytes, so a multi-byte first message is neither truncated mid-scalar
/// nor cut shorter than the cluster would cut it — trimmed, and kept only if
/// it contains a letter or a digit (`hasUsableText`'s `/[\p{L}\p{N}]/u`).
/// `None` leaves the thread at its default name, exactly as the cluster does.
fn auto_thread_title(user_message: &Value) -> Option<String> {
    let text = queue_text(user_message);
    let candidate = text
        .chars()
        .take(AUTO_TITLE_MAX_CHARS)
        .collect::<String>()
        .trim()
        .to_string();
    candidate
        .chars()
        .any(|c| c.is_alphanumeric())
        .then_some(candidate)
}

fn has_attachments(user_message: &Value) -> bool {
    user_message
        .get("parts")
        .and_then(Value::as_array)
        .is_some_and(|parts| {
            parts
                .iter()
                .any(|part| part.get("type").and_then(Value::as_str) == Some("file"))
        })
}

/// Retains only fields the local harness execution path consumes. HTTP auth
/// lives in headers and never reaches this value, but an explicit allowlist
/// also prevents future request-only secrets from silently becoming durable
/// SQLite data. The user message is stored separately by the queue row.
fn normalized_execution_input(input: &Value) -> Value {
    const KEYS: &[&str] = &[
        "harnessId",
        "tier",
        "mode",
        "toolApprovalLevel",
        "branch",
        "sandboxProviderKind",
        "sandbox",
    ];
    let mut normalized = serde_json::Map::new();
    for key in KEYS {
        if let Some(value) = input.get(*key) {
            normalized.insert((*key).to_string(), value.clone());
        }
    }
    Value::Object(normalized)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HarnessSelection {
    Pinned(harness::HarnessId),
    Requested(harness::HarnessId),
    Detect,
}

fn harness_selection(
    pinned_harness_id: Option<&str>,
    requested_harness_id: Option<&str>,
) -> Result<HarnessSelection, String> {
    if let Some(pinned_harness_id) = pinned_harness_id {
        return harness::HarnessId::from_wire_id(pinned_harness_id)
            .map(HarnessSelection::Pinned)
            .ok_or_else(|| {
                format!("thread is pinned to unsupported local harness {pinned_harness_id:?}")
            });
    }
    Ok(
        match requested_harness_id.and_then(harness::HarnessId::from_wire_id) {
            Some(harness_id) => HarnessSelection::Requested(harness_id),
            None => HarnessSelection::Detect,
        },
    )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NativeRunStatusStage {
    StartingRun,
    GatheringContext,
    PreparingTools,
    StartingAssistant,
}

impl NativeRunStatusStage {
    const fn wire_id(self) -> &'static str {
        match self {
            Self::StartingRun => "starting-run",
            Self::GatheringContext => "gathering-context",
            Self::PreparingTools => "preparing-tools",
            Self::StartingAssistant => "starting-assistant",
        }
    }
}

fn run_status_chunk(stage: NativeRunStatusStage) -> Value {
    json!({
        "type": "data-run-status",
        "id": "run-status",
        "data": {"stage": stage.wire_id()},
    })
}

fn assistant_start_chunk(claimed: &RtTurnQueueItem) -> Value {
    json!({
        "type": "start",
        "messageId": reserved_assistant_message_id(claimed),
    })
}

async fn publish_run_status(run: &DecopilotRun, stage: NativeRunStatusStage) -> Result<(), String> {
    run.push(frame(&run_status_chunk(stage))).await
}

fn elapsed_millis(started: Instant) -> u64 {
    u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)
}

fn is_meaningful_harness_chunk(chunk: &Value) -> bool {
    !matches!(
        chunk.get("type").and_then(Value::as_str),
        None | Some("start") | Some("start-step") | Some("finish-step")
    )
}

fn reserved_assistant_message_id(turn: &RtTurnQueueItem) -> String {
    turn.assistant_message_id
        .clone()
        .unwrap_or_else(|| legacy_native_assistant_message_id(&turn.message_id))
}

fn malformed_reserved_assistant_message_id(
    turn: &crate::routes::threads::db::RtMalformedOrphanedTurn,
) -> String {
    turn.assistant_message_id
        .clone()
        .unwrap_or_else(|| legacy_native_assistant_message_id(&turn.message_id))
}

const INTERRUPTED_RESPONSE: &str =
    "This response was interrupted because the desktop app stopped. Send your message again to retry.";

fn recovered_assistant_payload(
    db: &ThreadsDb,
    fence: &RtThreadFence,
    assistant_id: &str,
    workflow_id: &str,
) -> Result<(Value, Option<Value>), String> {
    let Some(assistant) = db
        .rt_get_message_fenced(fence, assistant_id)
        .map_err(|error| error.to_string())?
    else {
        return Ok((
            json!([{"type": "text", "text": INTERRUPTED_RESPONSE}]),
            Some(json!({"interrupted": true})),
        ));
    };
    if assistant.thread_id != fence.thread_id || assistant.role != "assistant" {
        return Err(format!(
            "assistant completion fence {assistant_id} conflicts with interrupted workflow {workflow_id}"
        ));
    }
    // Older native builds could commit the assistant before crashing prior to
    // queue cleanup. Reuse its exact payload so the new exact-idempotent
    // terminal transaction can adopt and close that legacy split boundary.
    Ok((assistant.parts, assistant.metadata))
}

fn finalize_orphaned_turn(db: &ThreadsDb, turn: &RtTurnQueueItem) -> Result<(), String> {
    match db
        .rt_begin_claimed_turn(turn)
        .map_err(|error| error.to_string())?
    {
        RtTurnBeginOutcome::Begun(_) | RtTurnBeginOutcome::CancelRequested => {}
        RtTurnBeginOutcome::Stale => return Ok(()),
    }
    let assistant_id = reserved_assistant_message_id(turn);
    let (parts, metadata) =
        recovered_assistant_payload(db, &turn.fence, &assistant_id, &turn.workflow_id)?;
    match db
        .rt_finalize_claimed_turn(
            turn,
            &parts,
            metadata.as_ref(),
            RtTurnTerminalStatus::Failed,
        )
        .map_err(|error| error.to_string())?
    {
        RtTurnTerminalOutcome::Completed { .. }
        | RtTurnTerminalOutcome::Quarantined
        | RtTurnTerminalOutcome::Stale => Ok(()),
    }
}

fn finalize_malformed_orphan(
    db: &ThreadsDb,
    orphan: &crate::routes::threads::db::RtMalformedOrphanedTurn,
) -> Result<(), String> {
    let (parts, metadata) = if orphan.canonical_user.is_some() {
        let assistant_id = malformed_reserved_assistant_message_id(orphan);
        recovered_assistant_payload(db, &orphan.fence, &assistant_id, &orphan.workflow_id)?
    } else {
        // The DB ignores this payload for unsafe quarantines. Avoid reading an
        // assistant id that may deliberately belong to another legacy turn.
        (Value::Array(Vec::new()), None)
    };
    match db
        .rt_finalize_malformed_orphan(orphan, &parts, metadata.as_ref())
        .map_err(|error| error.to_string())?
    {
        RtTurnTerminalOutcome::Completed { .. }
        | RtTurnTerminalOutcome::Quarantined
        | RtTurnTerminalOutcome::Stale => Ok(()),
    }
}

fn finalize_active_malformed_orphan(
    db: &ThreadsDb,
    orphan: &crate::routes::threads::db::RtMalformedOrphanedTurn,
) -> Result<(), String> {
    finalize_malformed_orphan(db, orphan)?;
    emit_committed_thread_status_fenced(
        db,
        &orphan.fence,
        &orphan.workflow_id,
        watch::ThreadStatus::Failed,
        None,
    );
    Ok(())
}

/// Reconciles the durable queue before either HTTP listener starts serving.
/// Previously-running turns are explicitly failed rather than rerun because a
/// CLI may already have performed non-idempotent filesystem/network actions;
/// untouched queued tails are safe to resume automatically.
pub(crate) async fn recover_durable_queue(state: &AppState) -> Result<(), String> {
    cleanup_stale_run_spools(state).await?;
    let Some(scope) = super::thread_tools::current_account_scope().await else {
        tracing::debug!("signed out at startup; native chat queue recovery deferred");
        return Ok(());
    };
    ensure_account_recovered(state, &scope).await
}

/// Runs queue recovery once for an authenticated upstream+user scope. Startup
/// calls this when a Keychain session is already available; the interception
/// router calls it lazily on the first scoped request so signing in after a
/// signed-out boot does not require another app restart.
pub(crate) async fn ensure_account_recovered(
    state: &AppState,
    scope: &RtAccountScope,
) -> Result<(), String> {
    let recovery_key = format!("{}\0{}", state.app_root.display(), scope.storage_key());
    if recovered_accounts().lock_ok().contains(&recovery_key) {
        return Ok(());
    }
    let gate = recovery_gates()
        .lock_ok()
        .entry(recovery_key.clone())
        .or_insert_with(|| Arc::new(AsyncMutex::new(())))
        .clone();
    let _guard = gate.lock().await;
    if recovered_accounts().lock_ok().contains(&recovery_key) {
        return Ok(());
    }
    recover_durable_queue_for_scope(state, scope).await?;
    recovered_accounts().lock_ok().insert(recovery_key);
    Ok(())
}

async fn recover_durable_queue_for_scope(
    state: &AppState,
    scope: &RtAccountScope,
) -> Result<(), String> {
    let db = shared_db(state).map_err(|error| format!("{:?}", error.body))?;
    db.prepare_account_scope(scope)
        .map_err(|error| error.to_string())?;
    let mut finalization_errors = Vec::new();
    for orphan in db
        .rt_list_orphaned_active_turns_scoped(scope)
        .map_err(|error| error.to_string())?
    {
        let (fence, workflow_id, result) = match &orphan {
            RtOrphanedTurn::Ready(turn) => (
                &turn.fence,
                turn.workflow_id.as_str(),
                finalize_orphaned_turn(db, turn),
            ),
            RtOrphanedTurn::Malformed(turn) => (
                &turn.fence,
                turn.workflow_id.as_str(),
                finalize_malformed_orphan(db, turn),
            ),
        };
        if let Err(error) = result {
            tracing::error!(
                %error,
                workflow_id,
                org = fence.organization_id,
                thread_id = fence.thread_id,
                "failed to isolate and finalize orphaned native chat turn"
            );
            finalization_errors.push(format!(
                "{}/{}@{} workflow {}: {}",
                fence.organization_id, fence.thread_id, fence.generation, workflow_id, error
            ));
        }
    }

    // Fail the entire account closed before launching any untouched queued
    // work. Startup propagates this error and drops its server/instance-lock;
    // spawning a harness first would let paid side effects outlive a failed
    // boot and overlap the next process that acquires the app root.
    if !finalization_errors.is_empty() {
        return Err(format!(
            "native chat recovery left {} orphaned turn(s) retryable: {}",
            finalization_errors.len(),
            finalization_errors.join("; ")
        ));
    }

    for fence in db
        .rt_list_recoverable_turn_queues_scoped(scope)
        .map_err(|error| error.to_string())?
    {
        let key = ThreadKey::from_fence(&fence);
        let (queue, started) = start_recovered_thread_queue(&key);
        if started {
            spawn_durable_thread_worker(state.clone(), db, key, fence, queue);
        }
    }
    Ok(())
}

/// Run registry entries are intentionally process-local, so a hard crash can
/// leave random-name spool files that no future process could associate with a
/// thread. Clear only regular `.sse` files directly inside the app-owned spool
/// directory before queue recovery starts; unrelated files and nested paths
/// are never touched.
async fn cleanup_stale_run_spools(state: &AppState) -> Result<(), String> {
    let directory = state.app_root.join(".decocms").join("run-streams");
    let mut entries = match tokio::fs::read_dir(&directory).await {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(format!(
                "failed to inspect stale native chat run spools at {directory:?}: {error}"
            ));
        }
    };
    while let Some(entry) = entries
        .next_entry()
        .await
        .map_err(|error| format!("failed to enumerate {directory:?}: {error}"))?
    {
        let path = entry.path();
        let is_regular_file = entry
            .file_type()
            .await
            .map_err(|error| format!("failed to inspect stale run spool {path:?}: {error}"))?
            .is_file();
        if is_regular_file && path.extension().and_then(|value| value.to_str()) == Some("sse") {
            tokio::fs::remove_file(&path)
                .await
                .map_err(|error| format!("failed to remove stale run spool {path:?}: {error}"))?;
        }
    }
    Ok(())
}

/// Direct, idempotent Decopilot reap phase used by `ServerHandle::shutdown`.
/// Queued tails stay in SQLite for the next boot; active heads are cancelled
/// concurrently and every queue worker is joined before setup/git shutdown
/// advances. Repeated calls simply observe already-stopped queues.
pub(crate) async fn shutdown_all(budget: Duration) -> bool {
    let queues: Vec<Arc<ThreadQueue>> = thread_queues().lock_ok().values().cloned().collect();
    stop_thread_queues(queues, budget).await
}

/// Stops every process-local chat queue under one wall-clock budget. All active
/// cancellations start together, then every worker is joined together; neither
/// phase multiplies latency by the number of threads.
async fn stop_thread_queues(queues: Vec<Arc<ThreadQueue>>, budget: Duration) -> bool {
    let cancellations: Vec<Arc<TurnCancellation>> = queues
        .iter()
        .filter_map(|queue| queue.stop_and_drain_tail().0)
        .collect();
    let stopped = tokio::time::timeout(budget, async {
        join_all(cancellations.iter().map(|active| active.request())).await;
        join_all(queues.iter().map(|queue| queue.wait_worker_stopped())).await;
    })
    .await
    .is_ok();
    if !stopped {
        tracing::error!(
            queue_count = queues.len(),
            ?budget,
            "timed out waiting for native chat harnesses to stop during shutdown"
        );
    }
    let durable_terminal_failure_count = queues
        .iter()
        .filter(|queue| queue.durable_terminal_failed())
        .count();
    if durable_terminal_failure_count > 0 {
        tracing::error!(
            queue_count = queues.len(),
            durable_terminal_failure_count,
            "native chat harnesses stopped without committing every durable terminal transaction"
        );
    }
    stopped && durable_terminal_failure_count == 0
}

/// Cancels one thread generation and waits until its worker has reaped the
/// harness. The caller marks the thread closing before entering and performs
/// the final generation-fenced thread delete afterwards.
pub(crate) async fn quiesce_thread_for_delete(
    state: &AppState,
    fence: &RtThreadFence,
) -> Result<(), ApiError> {
    quiesce_thread_for_delete_with_timeout(state, fence, Duration::from_secs(15)).await
}

async fn quiesce_thread_for_delete_with_timeout(
    state: &AppState,
    fence: &RtThreadFence,
    stop_budget: Duration,
) -> Result<(), ApiError> {
    let db = shared_db(state)?;
    db.rt_cancel_all_turns_in_org(fence)
        .map_err(|error| ApiError::internal(format!("thread queue database error: {error}")))?;
    let key = ThreadKey::from_fence(fence);
    let queue = thread_queues().lock_ok().get(&key).cloned();
    if let Some(queue) = &queue {
        let (active, _) = queue.stop_and_drain_tail();
        if let Some(active) = active {
            active.request().await;
        }
        tokio::time::timeout(stop_budget, queue.wait_worker_stopped())
            .await
            .map_err(|_| ApiError::conflict("thread agent is still stopping"))?;
    }

    let run = registry().lock_ok().remove(&key);
    if let Some(run) = run {
        run.finish().await;
        // Deletion has no reconnect grace period: the parent thread and all of
        // its durable messages are about to disappear, so its replay file must
        // disappear in the same lifecycle when possible. It is not part of the
        // database consistency boundary, however: a transient filesystem error
        // must not fail DELETE after every harness is already quiescent and
        // strand its accepted queued tails behind a half-torn-down RAM state.
        if let Err(error) = run.spool.remove().await {
            tracing::warn!(%error, "failed to remove deleted thread run spool");
        }
    }
    thread_queues().lock_ok().remove(&key);
    Ok(())
}

fn frame(chunk: &Value) -> Bytes {
    Bytes::from(format!(
        "event: message\ndata: {}\n\n",
        serde_json::to_string(chunk).unwrap_or_else(|_| "null".to_string())
    ))
}

pub async fn dispatch(
    state: &AppState,
    scope: &RtAccountScope,
    org: &str,
    method: &Method,
    rest: &[&str],
    body: &Bytes,
) -> Response {
    match rest {
        ["threads", thread_id, "messages"] if *method == Method::POST => {
            send_message(state, scope, org, thread_id, body).await
        }
        ["threads", thread_id, "stream"] if *method == Method::GET => {
            stream(state, scope, org, thread_id).await
        }
        ["cancel", thread_id] if *method == Method::POST => {
            cancel(state, scope, org, thread_id).await
        }
        ["queue", thread_id] if *method == Method::GET => queue_list(state, scope, org, thread_id),
        ["queue", thread_id, "cancel", workflow_id] if *method == Method::POST => {
            let workflow_id = match urlencoding::decode(workflow_id) {
                Ok(decoded) => decoded,
                Err(error) => {
                    return ApiError::bad_request(format!(
                        "invalid percent-encoded workflow id: {error}"
                    ))
                    .into_response();
                }
            };
            queue_cancel(state, scope, org, thread_id, &workflow_id).await
        }
        _ => ApiError::not_found(format!(
            "Not found: /decopilot/{} (desktop local-api intercepts the entire /decopilot/* \
             family and does not forward it upstream — see routes/intercept/mod.rs)",
            rest.join("/")
        ))
        .into_response(),
    }
}

fn queue_list(state: &AppState, scope: &RtAccountScope, org: &str, thread_id: &str) -> Response {
    let db = match shared_db(state) {
        Ok(db) => db,
        Err(error) => return error.into_response(),
    };
    let items: Vec<Value> = match db.rt_list_turn_queue_scoped(scope, org, thread_id) {
        Ok(items) => items
            .into_iter()
            .map(|item| {
                json!({
                    "workflowId": item.workflow_id,
                    "messageId": item.message_id,
                    "status": match item.state {
                        RtTurnQueueState::Queued => "queued",
                        RtTurnQueueState::Running | RtTurnQueueState::CancelRequested => "running",
                    },
                    "enqueuedAt": item.enqueued_at,
                    "source": "user-message",
                    "text": queue_text(&item.user_message),
                    "hasAttachments": has_attachments(&item.user_message),
                })
            })
            .collect(),
        Err(error) => {
            return ApiError::internal(format!("thread queue database error: {error}"))
                .into_response();
        }
    };
    Json(json!({ "items": items })).into_response()
}

async fn queue_cancel(
    state: &AppState,
    scope: &RtAccountScope,
    org: &str,
    thread_id: &str,
    workflow_id: &str,
) -> Response {
    let key = ThreadKey::scoped(scope, org, thread_id);
    let lifecycle_gate = thread_lifecycle_gate(scope, org, thread_id);
    let _lifecycle_guard = lifecycle_gate.lock().await;
    if thread_is_closing(scope, org, thread_id) {
        return ApiError::conflict("thread is being deleted").into_response();
    }
    let db = match shared_db(state) {
        Ok(db) => db,
        Err(error) => return error.into_response(),
    };
    let queue = thread_queues().lock_ok().get(&key).cloned();
    match db.rt_cancel_turn_scoped(scope, org, thread_id, workflow_id) {
        Ok(RtTurnCancelOutcome::QueuedDeleted(_)) => {
            if let Some(queue) = queue {
                queue.remove_mirror(workflow_id);
            }
        }
        Ok(RtTurnCancelOutcome::ActiveCancelRequested(_)) => {
            if let Some(cancellation) = queue.and_then(|queue| queue.cancellation_for(workflow_id))
            {
                cancellation.request().await;
            }
        }
        Ok(RtTurnCancelOutcome::NotFound) => return StatusCode::NOT_FOUND.into_response(),
        Err(error) => {
            return ApiError::internal(format!("thread queue database error: {error}"))
                .into_response();
        }
    }
    (StatusCode::ACCEPTED, Json(json!({ "cancelled": true }))).into_response()
}

async fn cancel(state: &AppState, scope: &RtAccountScope, org: &str, thread_id: &str) -> Response {
    let key = ThreadKey::scoped(scope, org, thread_id);
    let db = match shared_db(state) {
        Ok(db) => db,
        Err(error) => return error.into_response(),
    };
    let active = match db.rt_list_turn_queue_scoped(scope, org, thread_id) {
        Ok(items) => items.into_iter().find(|item| {
            matches!(
                item.state,
                RtTurnQueueState::Running | RtTurnQueueState::CancelRequested
            )
        }),
        Err(error) => {
            return ApiError::internal(format!("thread queue database error: {error}"))
                .into_response();
        }
    };
    if let Some(active) = active {
        if let Err(error) = db.rt_cancel_turn_scoped(scope, org, thread_id, &active.workflow_id) {
            return ApiError::internal(format!("thread queue database error: {error}"))
                .into_response();
        }
        let cancellation = thread_queues()
            .lock_ok()
            .get(&key)
            .and_then(|queue| queue.cancellation_for(&active.workflow_id));
        if let Some(cancellation) = cancellation {
            cancellation.request().await;
        }
    }
    (
        StatusCode::ACCEPTED,
        Json(json!({ "cancelled": true, "async": true })),
    )
        .into_response()
}

async fn stream(state: &AppState, scope: &RtAccountScope, org: &str, thread_id: &str) -> Response {
    let key = ThreadKey::scoped(scope, org, thread_id);
    // Eagerly create (not 204) a placeholder for a thread_id never seen
    // before — see `DecopilotRun`'s "Idle placeholder" doc section for why:
    // the real client treats 204 as "never reconnect", which is only
    // correct for a genuinely-impossible state here, not an ordinary idle
    // thread awaiting its first dispatch.
    let run = match run_for_stream(state, &key).await {
        Ok(run) => run,
        Err(error) => {
            return ApiError::internal(format!("could not open native chat replay: {error}"))
                .into_response();
        }
    };
    let mut subscription = match run.subscribe().await {
        Ok(subscription) => subscription,
        Err(error) => {
            return ApiError::internal(format!("could not read native chat replay: {error}"))
                .into_response();
        }
    };
    let replay = subscription.take_replay();
    if replay.is_empty() && run.finished.load(Ordering::SeqCst) {
        // Genuinely impossible in practice (a placeholder is never
        // `finish()`-ed without a frame having been pushed first — see
        // `send_message`), kept as a defensive fallback rather than an
        // `unreachable!()`.
        return StatusCode::NO_CONTENT.into_response();
    }

    let replay = (!replay.is_empty()).then_some(replay);
    let cleanup_target = run.clone();
    let body_stream = stream::unfold(
        (replay, subscription, Some(cleanup_target)),
        |(mut replay, mut subscription, mut cleanup)| async move {
            if let Some(bytes) = replay.take() {
                return Some((Ok::<_, Infallible>(bytes), (replay, subscription, cleanup)));
            }
            match subscription.recv().await {
                Ok(Some(bytes)) => {
                    return Some((Ok::<_, Infallible>(bytes), (replay, subscription, cleanup)));
                }
                Err(error) => {
                    // A lagged response must terminate visibly so the browser's
                    // SSE loop reconnects. Keep the identity-fenced registry
                    // slot and disk file: the next GET replays the complete
                    // transcript rather than silently skipping the gap.
                    tracing::warn!(%error, "native chat SSE subscriber lagged; reconnect required");
                    cleanup.take();
                    return None;
                }
                Ok(None) => {}
            }
            // Clean terminal consumption needs no reconnect grace period.
            // `cleanup_run` identity-fences the registry slot but ALWAYS
            // deletes this Arc's own unique file, even if a newer turn won.
            if let Some(run) = cleanup.take() {
                cleanup_run(&run).await;
            }
            None
        },
    );

    let mut response = Response::new(Body::from_stream(body_stream));
    for (name, value) in crate::http_util::dispatch_sse_headers() {
        response.headers_mut().insert(name, value);
    }
    response
}

async fn run_for_stream(state: &AppState, key: &ThreadKey) -> Result<Arc<DecopilotRun>, String> {
    if let Some(existing) = registry().lock_ok().get(key).cloned() {
        return Ok(existing);
    }

    let candidate = DecopilotRun::open(state, key.clone()).await?;
    let (selected, inserted) = {
        let mut runs = registry().lock_ok();
        match runs.get(key) {
            Some(existing) => (existing.clone(), false),
            None => {
                runs.insert(key.clone(), candidate.clone());
                (candidate.clone(), true)
            }
        }
    };
    if inserted {
        selected.schedule_idle_cleanup();
    } else if let Err(error) = candidate.spool.remove().await {
        tracing::warn!(%error, "failed to remove raced native chat placeholder spool");
    }
    Ok(selected)
}

/// An old response body may finish after the queue has already installed the
/// next turn's run under the same thread id. Only the stream that still owns
/// the registry slot may clear it; blindly removing by key loses the new run's
/// replay and was the source of intermittent missing/duplicated turns.
fn remove_run_if_current(key: &ThreadKey, expected: &Arc<DecopilotRun>) -> bool {
    let mut runs = registry().lock_ok();
    let is_current = runs
        .get(key)
        .is_some_and(|current| Arc::ptr_eq(current, expected));
    if is_current {
        runs.remove(key);
    }
    is_current
}

async fn send_message(
    state: &AppState,
    scope: &RtAccountScope,
    org: &str,
    thread_id: &str,
    body: &Bytes,
) -> Response {
    let request_started = Instant::now();
    let input: Value = match crate::http_util::json_body(body) {
        Ok(v) => v,
        Err(e) => return e.into_response(),
    };
    let Some(messages) = input.get("messages").and_then(Value::as_array) else {
        return ApiError::bad_request("messages must include exactly one user message")
            .into_response();
    };
    let mut non_system = messages
        .iter()
        .filter(|message| message.get("role").and_then(Value::as_str) != Some("system"));
    let Some(mut user_message) = non_system.next().cloned() else {
        return ApiError::bad_request("messages must include exactly one user message")
            .into_response();
    };
    if non_system.next().is_some() {
        return ApiError::bad_request("messages must include exactly one non-system message")
            .into_response();
    }
    if user_message.get("role").and_then(Value::as_str) != Some("user") {
        return ApiError::bad_request(
            "native chat only supports a user message; assistant/tool continuations are not supported",
        )
        .into_response();
    }
    let user_message_id = user_message
        .get("id")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("msg-{}-user", uuid::Uuid::new_v4()));
    if is_native_assistant_message_id(&user_message_id) {
        return ApiError::bad_request(format!(
            "message id uses reserved namespace {NATIVE_ASSISTANT_MESSAGE_ID_PREFIX}"
        ))
        .into_response();
    }
    // The generated id is part of the durable/idempotency contract, not just
    // a database key. Mirror it back into the queued/SSE message so the
    // optimistic, streamed, and persisted copies all dedupe by the same id.
    if let Some(message) = user_message.as_object_mut() {
        message.insert("id".to_string(), Value::String(user_message_id.clone()));
    }
    let lifecycle_gate = thread_lifecycle_gate(scope, org, thread_id);
    let _lifecycle_guard = lifecycle_gate.lock().await;
    if thread_is_closing(scope, org, thread_id) {
        return ApiError::conflict("thread is being deleted").into_response();
    }
    // Do not hold shutdown's admission guard while awaiting a per-thread
    // lifecycle operation (delete can legitimately take seconds). Once the
    // thread gate is ours, this section is synchronous through durable enqueue
    // and worker launch, so shutdown's write barrier has a tight bound.
    let Some(_shutdown_admission) = state.shutdown.admit_work().await else {
        return ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "application is shutting down",
        )
        .into_response();
    };
    let db = match shared_db(state) {
        Ok(d) => d,
        Err(e) => return e.into_response(),
    };

    let branch = input.get("branch").and_then(Value::as_str);

    // Check ownership before the idempotent create: an existing id from
    // another account/upstream/org scope must be a tenant-scoped 404, not an
    // idempotency-conflict 500.
    match db.rt_get_thread_in_scope(scope, org, thread_id) {
        Ok(Some(_)) => {}
        Ok(None) => {
            // Implicit create on first dispatch — same convention
            // `routes/dispatch.rs` uses for the daemon-parity family.
            if let Err(error) = db.rt_create_thread_scoped(
                scope,
                Some(thread_id),
                org,
                "",
                None,
                &implicit_virtual_mcp_id(org),
                branch,
                &scope.user_id,
            ) {
                // A request minted before DELETE may arrive only after the
                // deletion committed. It must not implicitly resurrect the
                // public id and enqueue work into a new incarnation.
                if matches!(&error, DbError::RetiredThreadId { .. }) {
                    return ApiError::gone("thread was deleted").into_response();
                }
                if matches!(db.rt_get_thread_in_scope(scope, org, thread_id), Ok(None)) {
                    return ApiError::not_found(format!("thread not found: {thread_id}"))
                        .into_response();
                }
                return ApiError::internal(format!("thread database error: {error}"))
                    .into_response();
            }
        }
        Err(error) => {
            return ApiError::internal(format!("thread database error: {error}")).into_response();
        }
    }

    // Production returns the thread id as `taskId`; each turn's durable
    // identity lives in `messageId` / `workflowId` instead.
    let task_id = thread_id.to_string();
    let workflow_id = format!("thread-run:{thread_id}:{user_message_id}");
    let key = ThreadKey::scoped(scope, org, thread_id);
    let enqueue = RtTurnEnqueueInput {
        message_id: user_message_id,
        workflow_id,
        task_id: task_id.clone(),
        normalized_input: normalized_execution_input(&input),
        user_message,
        enqueued_at: epoch_millis(),
    };
    let durable = match db.rt_enqueue_turn_scoped(scope, org, thread_id, &enqueue) {
        Ok(RtTurnEnqueueOutcome::Inserted(item) | RtTurnEnqueueOutcome::Existing(item)) => item,
        Ok(RtTurnEnqueueOutcome::Completed) => {
            tracing::info!(
                target: "decocms.native.chat.latency",
                organization_id = org,
                thread_id,
                request_to_accepted_ms = elapsed_millis(request_started),
                outcome = "already_completed",
                "native chat request accepted"
            );
            return (StatusCode::ACCEPTED, Json(json!({ "taskId": task_id }))).into_response();
        }
        Err(DbError::IdempotencyConflict { .. }) => {
            return (
                StatusCode::CONFLICT,
                Json(json!({"error": format!(
                    "message id {} already exists with different content",
                    enqueue.message_id
                )})),
            )
                .into_response();
        }
        Err(DbError::ThreadDeletePending { .. }) => {
            return ApiError::conflict("thread is being deleted").into_response();
        }
        Err(DbError::InvalidQueueData(error))
            if error.contains(NATIVE_ASSISTANT_MESSAGE_ID_PREFIX) =>
        {
            return ApiError::bad_request(error).into_response();
        }
        Err(error) => {
            return ApiError::internal(format!("thread queue database error: {error}"))
                .into_response();
        }
    };
    let task_id = durable.task_id.clone();
    let turn = QueuedTurn::from_durable(durable);
    let fence = turn.fence.clone();

    let (queue, outcome) = enqueue_thread_turn(&key, turn);
    match outcome {
        EnqueueOutcome::Duplicate => {}
        EnqueueOutcome::Enqueued { first } => {
            if first.is_some() {
                spawn_durable_thread_worker(state.clone(), db, key, fence, queue);
            }
        }
    }

    tracing::info!(
        target: "decocms.native.chat.latency",
        organization_id = org,
        thread_id,
        request_to_accepted_ms = elapsed_millis(request_started),
        outcome = "enqueued",
        "native chat request accepted"
    );
    (StatusCode::ACCEPTED, Json(json!({ "taskId": task_id }))).into_response()
}

fn spawn_durable_thread_worker(
    state: AppState,
    db: &'static ThreadsDb,
    key: ThreadKey,
    fence: RtThreadFence,
    queue: Arc<ThreadQueue>,
) {
    tokio::spawn(async move {
        let mut panic_guard = WorkerPanicGuard::new(key.clone(), queue.clone());
        drain_durable_thread_queue(&state, db, key, fence, queue).await;
        panic_guard.disarm();
    });
}

/// Tokio catches a task panic at the join boundary, which otherwise skips every
/// normal drain epilogue and leaves `worker_running=true` forever. This sync
/// drop guard relinquishes that process-local latch on panic/abort. It does not
/// rerun the claimed durable turn: boot recovery remains the only safe policy
/// for a possibly-side-effecting generation interrupted at an unknown point.
struct WorkerPanicGuard {
    key: ThreadKey,
    queue: Arc<ThreadQueue>,
    armed: bool,
}

impl WorkerPanicGuard {
    fn new(key: ThreadKey, queue: Arc<ThreadQueue>) -> Self {
        Self {
            key,
            queue,
            armed: true,
        }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for WorkerPanicGuard {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        tracing::error!(
            org = %self.key.org,
            thread_id = %self.key.thread_id,
            "native chat queue worker aborted unexpectedly; durable head left for restart recovery"
        );
        // A panic/abort can happen after the CLI was spawned but before the
        // durable assistant/status transaction committed. Treating that as a
        // clean worker stop makes graceful shutdown falsely publish Git state
        // while detached process teardown may still be running. Latch the
        // missing terminal fence exactly like the explicit persistence-error
        // path; only next-boot recovery may classify the claimed head.
        self.queue.stop_worker_after_durable_terminal_failure();
        remove_queue_if_idle(&self.key, &self.queue);
    }
}

/// Drains SQLite's tenant/thread FIFO. The lifecycle gate closes the only
/// dangerous transition: a sender cannot insert after a worker observes an
/// empty durable queue but before that worker relinquishes ownership.
async fn drain_durable_thread_queue(
    state: &AppState,
    db: &'static ThreadsDb,
    key: ThreadKey,
    fence: RtThreadFence,
    queue: Arc<ThreadQueue>,
) {
    loop {
        let lifecycle_gate = thread_lifecycle_gate_for_key(&key);
        let lifecycle_guard = lifecycle_gate.lock().await;
        // Queue admission and the durable claim are one critical section.
        // Shutdown/delete set `stop_after_current` under this same mutex; once
        // they win, a recovered worker with an empty RAM mirror cannot claim a
        // SQLite tail. Once the worker wins, it installs the cancellation
        // handle in the mirror before shutdown can inspect it.
        let Some((claim_result, activated)) = queue.claim_durable_head(db, &fence) else {
            drop(lifecycle_guard);
            remove_queue_if_idle(&key, &queue);
            return;
        };
        let claimed = match claim_result {
            Ok(Some(RtTurnClaimOutcome::Ready(item))) => item,
            Ok(Some(RtTurnClaimOutcome::Malformed(orphan))) => {
                let workflow_id = orphan.workflow_id.clone();
                match finalize_active_malformed_orphan(db, &orphan) {
                    Ok(()) => {
                        let stop = queue.complete_claimed(&workflow_id);
                        if stop {
                            remove_queue_if_idle(&key, &queue);
                            return;
                        }
                        drop(lifecycle_guard);
                        continue;
                    }
                    Err(error) => {
                        tracing::error!(
                            %error,
                            workflow_id,
                            org = key.org,
                            thread_id = key.thread_id,
                            "failed to quarantine malformed durable chat FIFO head"
                        );
                        queue.stop_worker();
                        return;
                    }
                }
            }
            Ok(Some(RtTurnClaimOutcome::Completed { workflow_id })) => {
                let stop = queue.complete_claimed(&workflow_id);
                if stop {
                    remove_queue_if_idle(&key, &queue);
                    return;
                }
                drop(lifecycle_guard);
                continue;
            }
            Ok(None) => {
                queue.stop_worker();
                remove_queue_if_idle(&key, &queue);
                return;
            }
            Err(error) => {
                tracing::error!(%error, org = key.org, thread_id = key.thread_id, "failed to claim durable chat turn");
                queue.stop_worker();
                return;
            }
        };
        // `claim_durable_head` builds `activated` from the same `Ready` arm
        // `claimed` came from, so this is dead — but the two travel as
        // separate tuple fields, so nothing but that convention enforces it.
        // Stop the worker like the sibling claim-failure arms above rather
        // than taking the process down: the row stays claimed and is
        // recovered on the next boot.
        let Some(turn) = activated else {
            tracing::error!(
                org = key.org,
                thread_id = key.thread_id,
                "durable claim reported Ready without its cancellation mirror"
            );
            queue.stop_worker();
            return;
        };
        let begin = db.rt_begin_claimed_turn(&claimed);
        drop(lifecycle_guard);

        let persisted_terminal = match begin {
            Ok(RtTurnBeginOutcome::Begun(_)) => {
                emit_committed_thread_status(
                    db,
                    &claimed,
                    watch::ThreadStatus::InProgress,
                    Some(&claimed.message_id),
                );
                execute_turn(state, db, turn.clone(), claimed.clone()).await
            }
            Ok(RtTurnBeginOutcome::CancelRequested) => {
                finalize_cancelled_before_start(db, &claimed)
            }
            Ok(RtTurnBeginOutcome::Stale) => {
                tracing::warn!(
                    workflow_id = claimed.workflow_id,
                    "durable chat turn lost its claim before begin"
                );
                false
            }
            Err(error) => {
                tracing::error!(
                    %error,
                    workflow_id = claimed.workflow_id,
                    "failed to atomically begin durable chat turn"
                );
                false
            }
        };

        let lifecycle_guard = lifecycle_gate.lock().await;
        if !persisted_terminal {
            // Never promote a tail after losing its durable completion fence.
            // A subsequent boot will classify this claimed head as interrupted
            // rather than rerunning a potentially side-effecting CLI.
            queue.stop_worker_after_durable_terminal_failure();
            tracing::error!(
                workflow_id = claimed.workflow_id,
                "durable chat turn did not reach a terminal persistence fence; tail left queued for recovery"
            );
            return;
        }
        // `rt_finalize_claimed_turn` already deleted this exact claimed row in
        // the same transaction as assistant + terminal status. The RAM mirror
        // is the only cleanup remaining; a second DB delete here would reopen
        // the split completion window this worker is designed to eliminate.
        let stop = queue.complete_claimed(&claimed.workflow_id);
        if stop {
            remove_queue_if_idle(&key, &queue);
            return;
        }
        drop(lifecycle_guard);
    }
}

/// Runs exactly one callback at a time for this thread. The callback abstraction
/// gives unit tests a controllable latch without spawning a real paid CLI.
#[cfg(test)]
async fn drain_thread_queue<F, Fut>(queue: Arc<ThreadQueue>, first: QueuedTurn, mut execute: F)
where
    F: FnMut(QueuedTurn) -> Fut,
    Fut: Future<Output = ()>,
{
    let mut current = first;
    loop {
        execute(current.clone()).await;
        let Some(next) = queue.complete_and_next(&current.workflow_id) else {
            remove_queue_if_idle(&current.key, &queue);
            return;
        };
        current = next;
    }
}

async fn run_for_turn(state: &AppState, key: &ThreadKey) -> Result<Arc<DecopilotRun>, String> {
    if let Some(placeholder) = registry()
        .lock_ok()
        .get(key)
        .filter(|existing| existing.is_idle_placeholder())
        .cloned()
    {
        return Ok(placeholder);
    }

    let candidate = DecopilotRun::open(state, key.clone()).await?;
    let (selected, installed) = {
        let mut runs = registry().lock_ok();
        if let Some(placeholder) = runs
            .get(key)
            .filter(|existing| existing.is_idle_placeholder())
            .cloned()
        {
            (placeholder, false)
        } else {
            runs.insert(key.clone(), candidate.clone());
            (candidate.clone(), true)
        }
    };
    if !installed {
        if let Err(error) = candidate.spool.remove().await {
            tracing::warn!(%error, "failed to remove raced native chat run spool");
        }
    }
    Ok(selected)
}

const STREAM_FAILURE_RESPONSE: &str =
    "The local response stream could not retain more output. Send your message again to retry.";

fn emit_committed_thread_status(
    db: &ThreadsDb,
    claimed: &RtTurnQueueItem,
    status: watch::ThreadStatus,
    message_id: Option<&str>,
) {
    emit_committed_thread_status_fenced(
        db,
        &claimed.fence,
        &claimed.workflow_id,
        status,
        message_id,
    );
}

fn emit_committed_thread_status_fenced(
    db: &ThreadsDb,
    fence: &RtThreadFence,
    workflow_id: &str,
    status: watch::ThreadStatus,
    message_id: Option<&str>,
) {
    match db.rt_thread_fenced(fence) {
        Ok(Some(thread)) if thread.status == status.as_str() => {
            watch::emit_thread_status(fence, status, &thread, message_id);
        }
        Ok(Some(thread)) => {
            tracing::error!(
                workflow_id,
                expected_status = status.as_str(),
                actual_status = thread.status,
                "native thread status changed unexpectedly before watch publication"
            );
        }
        Ok(None) => {
            tracing::warn!(
                workflow_id,
                "native thread disappeared before watch publication"
            );
        }
        Err(error) => {
            tracing::error!(
                %error,
                workflow_id,
                "failed to read committed native thread status for watch publication"
            );
        }
    }
}

fn finalize_claimed_result(
    db: &ThreadsDb,
    claimed: &RtTurnQueueItem,
    assistant_parts: &Value,
    assistant_metadata: Option<&Value>,
    status: RtTurnTerminalStatus,
) -> bool {
    match db.rt_finalize_claimed_turn(claimed, assistant_parts, assistant_metadata, status) {
        Ok(RtTurnTerminalOutcome::Completed {
            terminal_written, ..
        }) => {
            // Nothing to announce when the queue held another turn: the thread
            // is still `in_progress`, and the claim loop's next iteration
            // emits that for the turn it begins. Publishing a terminal here
            // would be announcing a status the row does not have.
            if terminal_written {
                let watch_status = match status {
                    RtTurnTerminalStatus::Completed => watch::ThreadStatus::Completed,
                    RtTurnTerminalStatus::RequiresAction => watch::ThreadStatus::RequiresAction,
                    RtTurnTerminalStatus::Failed => watch::ThreadStatus::Failed,
                };
                emit_committed_thread_status(db, claimed, watch_status, None);
            }
            true
        }
        Ok(RtTurnTerminalOutcome::Quarantined) => {
            tracing::error!(
                workflow_id = claimed.workflow_id,
                "healthy durable chat turn was unexpectedly quarantined"
            );
            false
        }
        Ok(RtTurnTerminalOutcome::Stale) => {
            tracing::error!(
                workflow_id = claimed.workflow_id,
                "durable chat terminal transaction lost its claim fence"
            );
            false
        }
        Err(error) => {
            tracing::error!(
                %error,
                workflow_id = claimed.workflow_id,
                "durable chat terminal transaction failed"
            );
            false
        }
    }
}

fn finalize_cancelled_before_start(db: &ThreadsDb, claimed: &RtTurnQueueItem) -> bool {
    let metadata = json!({"cancelled": true});
    finalize_claimed_result(
        db,
        claimed,
        &json!([]),
        Some(&metadata),
        RtTurnTerminalStatus::Failed,
    )
}

/// Makes a spool failure durable even though the SSE channel itself can no
/// longer be trusted. Assistant + failed status + claimed queue deletion are
/// one SQLite transaction; no tail may be promoted if it loses that fence.
fn persist_stream_failure(db: &ThreadsDb, claimed: &RtTurnQueueItem, cause: &str) -> bool {
    tracing::error!(error = cause, "native chat run spool failed");
    let metadata = json!({"failed": true, "errorCode": "local_stream_failure"});
    finalize_claimed_result(
        db,
        claimed,
        &json!([{"type": "text", "text": STREAM_FAILURE_RESPONSE}]),
        Some(&metadata),
        RtTurnTerminalStatus::Failed,
    )
}

async fn terminate_for_spool_failure(
    run: &Arc<DecopilotRun>,
    db: &ThreadsDb,
    claimed: &RtTurnQueueItem,
    cancellation: &Arc<TurnCancellation>,
    cause: &str,
) -> bool {
    cancellation.request().await;
    let persisted = persist_stream_failure(db, claimed, cause);
    run.finish().await;
    persisted
}

/// Flushes a terminal frame privately, atomically commits assistant + thread
/// status + queue deletion, then publishes the already-durable frame. A DB
/// failure truncates the hidden bytes, so reconnects can never observe a
/// terminal SSE frame for storage that did not commit.
async fn finalize_with_terminal_frame(
    run: &Arc<DecopilotRun>,
    db: &ThreadsDb,
    claimed: &RtTurnQueueItem,
    assistant_parts: &Value,
    assistant_metadata: Option<&Value>,
    status: RtTurnTerminalStatus,
    terminal_frame: Bytes,
) -> bool {
    let staged = match run.stage_terminal(terminal_frame).await {
        Ok(staged) => staged,
        Err(error) => {
            let persisted = persist_stream_failure(db, claimed, &error);
            run.finish().await;
            return persisted;
        }
    };
    if !finalize_claimed_result(db, claimed, assistant_parts, assistant_metadata, status) {
        if let Err(error) = run.rollback_terminal(staged).await {
            tracing::error!(%error, "failed to roll back unpublished native chat terminal frame");
        }
        run.finish().await;
        return false;
    }
    if let Err(error) = run.commit_terminal(staged).await {
        // The terminal transaction is already durable. `commit_terminal` has
        // no filesystem work and its opaque token came from this same spool,
        // so this can only be an internal lifecycle invariant violation.
        tracing::error!(%error, "SQLite terminal committed but staged SSE publication failed");
    }
    run.finish().await;
    true
}

/// Terminal path after `rt_begin_claimed_turn` committed the user row but
/// before a harness could produce parts.
async fn finish_after_user(
    run: &Arc<DecopilotRun>,
    db: &ThreadsDb,
    claimed: &RtTurnQueueItem,
    cancellation: &Arc<TurnCancellation>,
    error: Option<String>,
) -> bool {
    if let Some(error) = error {
        if let Err(spool_error) = run
            .push(frame(&json!({"type": "error", "errorText": error})))
            .await
        {
            return terminate_for_spool_failure(run, db, claimed, cancellation, &spool_error).await;
        }
    }
    let metadata = json!({"finishReason": "error"});
    finalize_with_terminal_frame(
        run,
        db,
        claimed,
        &json!([]),
        Some(&metadata),
        RtTurnTerminalStatus::Failed,
        frame(&json!({
            "type": "finish",
            "finishReason": "error",
        })),
    )
    .await
}

fn terminal_finish_reason(terminal_chunks: &[Value]) -> Option<&str> {
    terminal_chunks.iter().rev().find_map(|chunk| {
        (chunk.get("type").and_then(Value::as_str) == Some("finish"))
            .then(|| chunk.get("finishReason").and_then(Value::as_str))
            .flatten()
    })
}

#[expect(
    clippy::expect_used,
    reason = "the pattern is a literal in this file, so `Regex::new` can only fail \
              if THIS SOURCE is wrong — a compile-time mistake a test catches, \
              not a runtime input. `static_regexes_compile` forces every one."
)]
fn response_url_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r"https?://[^\s)>\]]+").expect("response URL regex must compile")
    })
}

/// Native equivalent of the production `resolveThreadStatus` policy. Keeping
/// this decision next to the persisted assistant parts makes SQLite and the
/// local `/watch` event agree on one authoritative terminal state.
fn resolve_terminal_status(
    finish_reason: Option<&str>,
    response_parts: &[Value],
) -> RtTurnTerminalStatus {
    match finish_reason {
        Some("stop") => {
            let text = response_parts
                .iter()
                .filter(|part| part.get("type").and_then(Value::as_str) == Some("text"))
                .filter_map(|part| part.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n");
            if response_url_pattern().replace_all(&text, "").contains('?') {
                RtTurnTerminalStatus::RequiresAction
            } else {
                RtTurnTerminalStatus::Completed
            }
        }
        Some("tool-calls") => {
            let requires_action = response_parts.iter().any(|part| {
                let part_type = part.get("type").and_then(Value::as_str);
                let state = part.get("state").and_then(Value::as_str);
                (part_type == Some("tool-user_ask") && state == Some("input-available"))
                    || state == Some("approval-requested")
            });
            if requires_action {
                RtTurnTerminalStatus::RequiresAction
            } else {
                RtTurnTerminalStatus::Completed
            }
        }
        _ => RtTurnTerminalStatus::Failed,
    }
}

fn assistant_finish_metadata(terminal_chunks: &[Value], status: RtTurnTerminalStatus) -> Value {
    let finish_reason = terminal_finish_reason(terminal_chunks).unwrap_or(
        if status == RtTurnTerminalStatus::Failed {
            "error"
        } else {
            "stop"
        },
    );
    json!({"finishReason": finish_reason})
}

async fn execute_turn(
    state: &AppState,
    db: &'static ThreadsDb,
    turn: QueuedTurn,
    claimed: RtTurnQueueItem,
) -> bool {
    let queue_wait_ms = epoch_millis().saturating_sub(claimed.enqueued_at);
    tracing::info!(
        target: "decocms.native.chat.latency",
        workflow_id = claimed.workflow_id,
        organization_id = claimed.fence.organization_id,
        thread_id = claimed.fence.thread_id,
        queue_wait_ms,
        "native chat turn started"
    );
    // The durable begin already committed. A cancellation winning immediately
    // after that boundary still needs the atomic failed terminal transaction.
    if turn.cancellation.is_requested() {
        return finalize_cancelled_before_start(db, &claimed);
    }

    let fence = turn.fence.clone();
    let run = match run_for_turn(state, &turn.key).await {
        Ok(run) => run,
        Err(spool_error) => {
            // No SSE transport exists, but the accepted durable turn still
            // needs an explicit terminal result instead of becoming an
            // eternally-running queue row.
            turn.cancellation.request().await;
            return persist_stream_failure(db, &claimed, &spool_error);
        }
    };
    if turn.cancellation.is_requested() {
        return finish_after_user(&run, db, &claimed, &turn.cancellation, None).await;
    }
    if let Err(spool_error) = run
        .push(frame(&json!({
            "type": "data-user-message",
            "data": turn.user_message,
        })))
        .await
    {
        return terminate_for_spool_failure(&run, db, &claimed, &turn.cancellation, &spool_error)
            .await;
    }
    // Name the thread from its first message, before the model runs.
    //
    // On the cluster the harness generates this with a fast model and the
    // cluster's title interceptor persists it; the desktop runs the CLIs
    // directly, so neither exists here and every thread stayed "New chat"
    // forever. This is the SAME deterministic fallback `genTitle` uses when
    // its model errors or times out — no model call, so the title lands the
    // instant the turn is accepted rather than seconds later.
    let auto_title = auto_thread_title(&turn.user_message);
    // The title this process is allowed to replace when the model's arrives:
    // the deterministic one if it landed, else the default it never left.
    // `None` means the user has named the thread and nothing may touch it.
    let mut replaceable_title = Some(DEFAULT_THREAD_TITLE.to_string());
    if let Some(title) = auto_title {
        match db.rt_retitle_thread_if_unchanged(&fence, DEFAULT_THREAD_TITLE, &title) {
            // Only broadcast a title that was actually stored. There is no
            // `thread.title` event on `/events` — this chunk is the sole path
            // by which an open client learns the new name (see the web
            // client's chat-context observer).
            Ok(true) => {
                replaceable_title = Some(title.clone());
                if let Err(spool_error) = run
                    .push(frame(&json!({
                        "type": "data-thread-title",
                        "data": {"title": title},
                    })))
                    .await
                {
                    return terminate_for_spool_failure(
                        &run,
                        db,
                        &claimed,
                        &turn.cancellation,
                        &spool_error,
                    )
                    .await;
                }
            }
            // The user renamed it first; their name is final.
            Ok(false) => replaceable_title = None,
            // A thread that keeps its default name is a cosmetic loss; it must
            // never cost the user their turn.
            Err(error) => {
                replaceable_title = None;
                tracing::warn!(%error, thread_id = %fence.thread_id, "could not auto-title thread")
            }
        }
    }
    if let Err(spool_error) = run.push(frame(&assistant_start_chunk(&claimed))).await {
        return terminate_for_spool_failure(&run, db, &claimed, &turn.cancellation, &spool_error)
            .await;
    }
    if let Err(spool_error) = publish_run_status(&run, NativeRunStatusStage::StartingRun).await {
        return terminate_for_spool_failure(&run, db, &claimed, &turn.cancellation, &spool_error)
            .await;
    }

    if turn.cancellation.is_requested() {
        return finish_after_user(&run, db, &claimed, &turn.cancellation, None).await;
    }

    if let Err(spool_error) = publish_run_status(&run, NativeRunStatusStage::GatheringContext).await
    {
        return terminate_for_spool_failure(&run, db, &claimed, &turn.cancellation, &spool_error)
            .await;
    }
    let harness_resolution_started = Instant::now();
    let explicit_harness_id = turn.input.get("harnessId").and_then(Value::as_str);
    let pinned_harness_id = match db.rt_harness_id_fenced(&fence) {
        Ok(Some(harness_id)) => harness_id,
        Ok(None) => {
            tracing::warn!(
                workflow_id = claimed.workflow_id,
                "native chat turn lost its thread generation before harness resolution"
            );
            return false;
        }
        Err(error) => {
            return finish_after_user(
                &run,
                db,
                &claimed,
                &turn.cancellation,
                Some(format!(
                    "could not read the thread's local harness: {error}"
                )),
            )
            .await;
        }
    };
    let selection = match harness_selection(pinned_harness_id.as_deref(), explicit_harness_id) {
        Ok(selection) => selection,
        Err(error) => {
            return finish_after_user(&run, db, &claimed, &turn.cancellation, Some(error)).await;
        }
    };
    let proposed_harness_id = match selection {
        HarnessSelection::Pinned(harness) | HarnessSelection::Requested(harness) => Some(harness),
        HarnessSelection::Detect => {
            let cache = harness::detect::ensure_detected().await;
            if cache.get(harness::HarnessId::ClaudeCode) {
                Some(harness::HarnessId::ClaudeCode)
            } else if cache.get(harness::HarnessId::Codex) {
                Some(harness::HarnessId::Codex)
            } else {
                None
            }
        }
    };
    let Some(proposed_harness_id) = proposed_harness_id else {
        return finish_after_user(
            &run,
            db,
            &claimed,
            &turn.cancellation,
            Some("no local Claude Code or Codex CLI was detected on this machine".to_string()),
        )
        .await;
    };

    let branch = turn.input.get("branch").and_then(Value::as_str);
    let sandbox_provider_kind = turn
        .input
        .get("sandboxProviderKind")
        .and_then(Value::as_str);
    match db.rt_pin_harness_if_unset_fenced(
        &fence,
        proposed_harness_id.wire_id(),
        sandbox_provider_kind,
        branch,
    ) {
        Ok(true) => {}
        Ok(false) => {
            tracing::warn!(
                workflow_id = claimed.workflow_id,
                "native chat turn lost its thread generation while pinning its harness"
            );
            return false;
        }
        Err(error) => {
            return finish_after_user(
                &run,
                db,
                &claimed,
                &turn.cancellation,
                Some(format!("could not pin the thread's local harness: {error}")),
            )
            .await;
        }
    }
    let effective_harness_id = match db.rt_harness_id_fenced(&fence) {
        Ok(Some(Some(harness_id))) => harness_id,
        Ok(Some(None)) => {
            return finish_after_user(
                &run,
                db,
                &claimed,
                &turn.cancellation,
                Some("the thread's local harness could not be pinned".to_string()),
            )
            .await;
        }
        Ok(None) => {
            tracing::warn!(
                workflow_id = claimed.workflow_id,
                "native chat turn lost its thread generation after harness pinning"
            );
            return false;
        }
        Err(error) => {
            return finish_after_user(
                &run,
                db,
                &claimed,
                &turn.cancellation,
                Some(format!(
                    "could not verify the thread's local harness: {error}"
                )),
            )
            .await;
        }
    };
    let Some(harness_id) = harness::HarnessId::from_wire_id(&effective_harness_id) else {
        return finish_after_user(
            &run,
            db,
            &claimed,
            &turn.cancellation,
            Some(format!(
                "thread is pinned to unsupported local harness {effective_harness_id:?}"
            )),
        )
        .await;
    };
    tracing::info!(
        target: "decocms.native.chat.latency",
        workflow_id = claimed.workflow_id,
        organization_id = claimed.fence.organization_id,
        thread_id = claimed.fence.thread_id,
        harness_id = harness_id.wire_id(),
        selection = ?selection,
        harness_resolution_ms = elapsed_millis(harness_resolution_started),
        "native chat harness resolved"
    );
    if pinned_harness_id
        .as_deref()
        .is_some_and(|pinned| explicit_harness_id.is_some_and(|requested| requested != pinned))
    {
        tracing::info!(
            workflow_id = claimed.workflow_id,
            pinned_harness_id = effective_harness_id,
            requested_harness_id = explicit_harness_id,
            "ignored a harness override for an already-locked native thread"
        );
    }
    let resume_session_id = match db.rt_last_assistant_session_fenced(&fence, harness_id.wire_id())
    {
        Ok(Some((_, session_id))) => Some(session_id),
        Ok(None) => None,
        Err(error) => {
            return finish_after_user(
                &run,
                db,
                &claimed,
                &turn.cancellation,
                Some(format!(
                    "could not read the thread's local harness session: {error}"
                )),
            )
            .await;
        }
    };
    if let Err(spool_error) = publish_run_status(&run, NativeRunStatusStage::PreparingTools).await {
        return terminate_for_spool_failure(&run, db, &claimed, &turn.cancellation, &spool_error)
            .await;
    }
    let sandbox_ensure_started = Instant::now();
    let cwd = resolve_send_message_cwd(state, &turn.input, &claimed.fence, db).await;
    tracing::info!(
        target: "decocms.native.chat.latency",
        workflow_id = claimed.workflow_id,
        organization_id = claimed.fence.organization_id,
        thread_id = claimed.fence.thread_id,
        sandbox_ensure_ms = elapsed_millis(sandbox_ensure_started),
        "native chat sandbox resolved"
    );
    if turn.cancellation.is_requested() {
        return finish_after_user(&run, db, &claimed, &turn.cancellation, None).await;
    }
    // Tell the agent where the organization filesystem is — nothing else
    // does, since the desktop CLIs get no system prompt of their own. Gated on
    // the view directory actually EXISTING: naming a path that is not there is
    // the failure this whole plan exists to avoid, and a sandbox whose org
    // could not be resolved or mounted simply has no `org` sibling.
    // One read serves both the org-filesystem prompt (which names the user's
    // memory file) and the agent MCP (which is keyed by the agent, not the
    // thread).
    // Upgrade the deterministic name to a real one, off the turn's critical
    // path. The CLI's own cheapest model writes it (see `harness::title`), so
    // this costs no Studio credits and needs no cluster round trip — and
    // because a name is already on screen, a slow or failed call simply leaves
    // the better one unwritten instead of stranding the thread on "New chat"
    // the way the cluster's blocking-until-timeout shape can.
    //
    // FIRST user message only. The unchanged-title guard alone would already
    // stop a second call once a title exists, but it would still spend one on
    // every later turn of a thread that never got named (an opening message
    // with nothing nameable in it, or a title model that was down). A thread
    // resuming a harness session is by definition not on its first message.
    if let Some(previous_title) = replaceable_title.filter(|_| resume_session_id.is_none()) {
        let title_run = run.clone();
        let title_fence = fence.clone();
        let title_cwd = cwd.clone();
        let title_text = queue_text(&turn.user_message);
        let cancellation = turn.cancellation.clone();
        tokio::spawn(async move {
            let Some(title) = harness::title::generate_title(
                harness_id,
                &title_cwd,
                &title_text,
                harness::title::TITLE_TIMEOUT,
            )
            .await
            else {
                return;
            };
            // Do not name a run the user stopped — the cluster's title path
            // emits nothing on a parent abort, for the same reason.
            if cancellation.is_requested() || title == previous_title {
                return;
            }
            match db.rt_retitle_thread_if_unchanged(&title_fence, &previous_title, &title) {
                Ok(true) => {
                    let _ = title_run
                        .push(frame(&json!({
                            "type": "data-thread-title",
                            "data": {"title": title},
                        })))
                        .await;
                }
                Ok(false) => {}
                Err(error) => {
                    tracing::warn!(%error, thread_id = %title_fence.thread_id, "could not store the generated thread title")
                }
            }
        });
    }
    let thread_row = db.rt_get_thread_for_fence(&claimed.fence).ok().flatten();
    // Where the org filesystem sits relative to this run: a git-backed agent
    // has it BESIDE its worktree, while a gitless agent is already standing
    // in it.
    let org_dir = if crate::sandbox::org_view::org_mount_root(
        &state.app_root,
        &claimed.fence.organization_id,
    )
    .is_some_and(|root| root == cwd)
    {
        Some(cwd.clone())
    } else {
        cwd.parent().map(|sandbox| sandbox.join("org"))
    };
    let append_system_prompt = match org_dir {
        Some(org_dir) if tokio::fs::metadata(&org_dir).await.is_ok() => {
            Some(crate::sandbox::org_prompt::build(
                &org_dir,
                &claimed.fence.thread_id,
                thread_row.as_ref().map(|thread| thread.created_by.as_str()),
            ))
        }
        _ => None,
    };
    // The agent's own MCP, so the CLI can call the agent's tools. Points at
    // THIS process — `/mcp/*` proxies upstream with the Keychain-backed token
    // — so nothing has to be minted per run. The embedded guard wants the
    // control cookie AND the exact Origin, so both travel with it.
    let mcp = thread_row
        .as_ref()
        .zip(crate::sandbox::org_mount::local_credentials())
        .map(|(thread, creds)| harness::run::McpEndpoint {
            // ORG-SCOPED, not the cluster's `<base>/mcp/virtual-mcp/<id>`.
            // That legacy shape works upstream only because the per-run key
            // minted there carries the organization; this request
            // authenticates with the session cookie, which does not, so the
            // server answers `400 Organization context is required`. The
            // `/api/:org/...` form is also the one new code is required to
            // use.
            url: format!(
                "{}/api/{}/mcp/{}",
                creds.base_url, claimed.fence.organization_id, thread.virtual_mcp_id
            ),
            cookie: creds.cookie.clone(),
            origin: creds.origin.clone(),
            ca_cert: creds.ca_cert.clone(),
        });
    match mcp.as_ref() {
        Some(endpoint) => tracing::info!(
            target: "decocms.native.mcp",
            url = %endpoint.url,
            harness = ?harness_id,
            "agent MCP wired into the harness"
        ),
        None => tracing::warn!(
            target: "decocms.native.mcp",
            has_thread = thread_row.is_some(),
            has_credentials = crate::sandbox::org_mount::local_credentials().is_some(),
            "agent MCP NOT wired — the CLI will have no agent tools"
        ),
    }
    let spec = harness::run::RunSpec {
        harness: harness_id,
        cwd: Some(cwd),
        append_system_prompt,
        mcp,
        prompt: harness::run::extract_user_text(&turn.user_message),
        resume_session_id,
        model_id: model_id_for(harness_id, turn.input.get("tier").and_then(Value::as_str)),
        tool_approval: harness::run::ToolApproval::from_wire(
            turn.input
                .get("toolApprovalLevel")
                .and_then(Value::as_str)
                .unwrap_or("auto"),
        ),
        plan_mode: turn.input.get("mode").and_then(Value::as_str) == Some("plan"),
    };
    let argv = match harness::run::build_argv(&spec) {
        Ok(argv) => argv,
        Err(error) => {
            return finish_after_user(
                &run,
                db,
                &claimed,
                &turn.cancellation,
                Some(format!("could not start {}: {error}", harness_id.wire_id())),
            )
            .await;
        }
    };
    if let Err(spool_error) =
        publish_run_status(&run, NativeRunStatusStage::StartingAssistant).await
    {
        return terminate_for_spool_failure(&run, db, &claimed, &turn.cancellation, &spool_error)
            .await;
    }
    run_harness_and_stream(
        run,
        db,
        HarnessRunRequest {
            claimed,
            harness_id,
            spec,
            argv,
            child_lifetime_lock_path: state.tasks.child_lifetime_lock_path().to_path_buf(),
            cancellation: turn.cancellation,
        },
    )
    .await
}

/// `tier` (`SimpleModeTier`: `"fast"|"smart"|"thinking"|"image"|
/// "web_search"|"deep_research"`) → the composite model id
/// `harness::tiers::tiers_for` resolves for `harness_id`. Only the first
/// three map onto this crate's fast/smart/thinking tier table (map §3.4 —
/// tier LABELS are client-side, no network call, so exact fidelity here
/// only matters for which CLI model flag gets used); the other three
/// (image/web_search/deep_research — cloud-only modes with no local-CLI
/// equivalent in v1) fall back to `"smart"` rather than erroring, since an
/// unresolvable id should reach the CLI's own `--model` validation instead
/// of crashing this resolver (same philosophy as `tiers.rs`'s own
/// passthrough-on-unknown doc comment).
fn model_id_for(harness_id: harness::HarnessId, tier: Option<&str>) -> String {
    let idx = match tier {
        Some("fast") => 0,
        Some("thinking") => 2,
        _ => 1,
    };
    let tiers = harness::tiers::tiers_for(harness_id);
    // Fall back to the default tier rather than panicking on a harness whose
    // tier table is shorter than the index — same passthrough-on-unknown
    // philosophy as `tiers.rs` itself.
    tiers
        .get(idx)
        .or_else(|| tiers.first())
        .map_or_else(String::new, |tier| tier.id.to_string())
}

struct HarnessRunRequest {
    claimed: RtTurnQueueItem,
    harness_id: harness::HarnessId,
    spec: harness::run::RunSpec,
    argv: Vec<String>,
    child_lifetime_lock_path: std::path::PathBuf,
    cancellation: Arc<TurnCancellation>,
}

async fn run_harness_and_stream(
    run: Arc<DecopilotRun>,
    db: &'static ThreadsDb,
    request: HarnessRunRequest,
) -> bool {
    let HarnessRunRequest {
        claimed,
        harness_id,
        spec,
        argv,
        child_lifetime_lock_path,
        cancellation,
    } = request;
    let spawn_started = Instant::now();
    let mut handle =
        harness::run::start_with_child_lifetime_lock(argv, &spec, child_lifetime_lock_path).await;
    if cancellation.install(handle.cancel_handle()) {
        // Cancellation may have won during `start`; installing the detached
        // handle closes that race before we read a single event.
        handle.cancel().await;
    }

    let mut accumulator = harness::parts::PartsAccumulator::new();
    let mut error_message: Option<String> = None;
    let mut spool_failure: Option<String> = None;
    // A finish chunk is the UI's permission to reconcile/refetch. Publishing
    // it before the assistant row commits creates exactly the transient
    // duplicate/reordering bug this queue fixes, so every terminal chunk waits
    // below until persistence + status are complete.
    let mut terminal_chunks = Vec::new();
    let mut observed_meaningful_event = false;
    while let Some(event) = handle.recv().await {
        match event {
            harness::run::RunEvent::SessionId { session_id } => {
                match db.rt_checkpoint_claimed_turn_session(
                    &claimed,
                    harness_id.wire_id(),
                    &session_id,
                ) {
                    Ok(true) => {}
                    Ok(false) => {
                        error_message = Some(
                            "the chat turn lost its durable session checkpoint fence".to_string(),
                        );
                    }
                    Err(error) => {
                        error_message = Some(format!(
                            "could not checkpoint the local harness session: {error}"
                        ));
                    }
                }
                if let Some(message) = &error_message {
                    if let Err(error) = run
                        .push(frame(&json!({"type": "error", "errorText": message})))
                        .await
                    {
                        spool_failure = Some(error);
                    }
                    cancellation.request().await;
                    while handle.recv().await.is_some() {}
                    break;
                }
            }
            harness::run::RunEvent::Chunk(chunk) => {
                if !observed_meaningful_event && is_meaningful_harness_chunk(&chunk) {
                    observed_meaningful_event = true;
                    tracing::info!(
                        target: "decocms.native.chat.latency",
                        workflow_id = claimed.workflow_id,
                        organization_id = claimed.fence.organization_id,
                        thread_id = claimed.fence.thread_id,
                        harness_id = harness_id.wire_id(),
                        event_type = chunk
                            .get("type")
                            .and_then(|value| value.as_str())
                            .unwrap_or("unknown"),
                        spawn_to_first_stream_event_ms = elapsed_millis(spawn_started),
                        "native chat received its first meaningful harness event"
                    );
                }
                // The server already opened this assistant turn before any
                // fallible pre-harness work. A second harness-owned `start`
                // would create another assistant substream and could replace
                // the stable id reserved by SQLite.
                if chunk.get("type").and_then(Value::as_str) == Some("start") {
                    continue;
                }
                accumulator.feed(&chunk);
                if chunk.get("type").and_then(Value::as_str) == Some("finish") {
                    terminal_chunks.push(chunk);
                } else if let Err(error) = run.push(frame(&chunk)).await {
                    spool_failure = Some(error);
                    // Retention is part of the protocol contract. Continuing a
                    // paid, side-effecting harness after its output can no
                    // longer be replayed would silently lose the generation.
                    cancellation.request().await;
                    break;
                }
            }
            harness::run::RunEvent::FatalError { message } => {
                if !observed_meaningful_event {
                    observed_meaningful_event = true;
                    tracing::info!(
                        target: "decocms.native.chat.latency",
                        workflow_id = claimed.workflow_id,
                        organization_id = claimed.fence.organization_id,
                        thread_id = claimed.fence.thread_id,
                        harness_id = harness_id.wire_id(),
                        event_type = "fatal-error",
                        spawn_to_first_stream_event_ms = elapsed_millis(spawn_started),
                        "native chat received its first meaningful harness event"
                    );
                }
                error_message = Some(message.clone());
                if let Err(error) = run
                    .push(frame(&json!({"type": "error", "errorText": message})))
                    .await
                {
                    spool_failure = Some(error);
                }
                // A fatal wire frame is terminal from the UI's perspective, but
                // a buggy CLI can emit it and keep running. Reap that process
                // group before committing/promoting the queued successor: these
                // harnesses can perform non-idempotent filesystem actions, so a
                // one-second overlap is still data loss territory.
                cancellation.request().await;
                while handle.recv().await.is_some() {}
                break;
            }
        }
    }
    if !observed_meaningful_event {
        tracing::warn!(
            target: "decocms.native.chat.latency",
            workflow_id = claimed.workflow_id,
            organization_id = claimed.fence.organization_id,
            thread_id = claimed.fence.thread_id,
            harness_id = harness_id.wire_id(),
            harness_lifetime_ms = elapsed_millis(spawn_started),
            "native chat harness exited without a meaningful stream event"
        );
    }
    if let Some(error) = spool_failure.as_deref() {
        // Reap the cancelled process before returning the thread's dispatch
        // slot. Otherwise a spool failure could overlap this side-effecting
        // generation with the queued successor.
        while handle.recv().await.is_some() {}
        return terminate_for_spool_failure(&run, db, &claimed, &cancellation, error).await;
    }
    let cancelled = cancellation.is_requested();
    let session_id = handle.session_id().await.and_then(|session_id| {
        let session_id = session_id.trim();
        (!session_id.is_empty()).then(|| session_id.to_string())
    });
    if error_message.is_none() && !cancelled && session_id.is_none() {
        let message = format!(
            "{} completed without reporting a resumable session id",
            harness_id.wire_id()
        );
        if let Err(error) = run
            .push(frame(&json!({"type": "error", "errorText": message})))
            .await
        {
            return terminate_for_spool_failure(&run, db, &claimed, &cancellation, &error).await;
        }
        error_message = Some(message);
    }
    if error_message.is_some() || cancelled {
        // An error/cancellation can race a nominal finish from the harness.
        // Normalize the reason before resolving status so the SSE terminal,
        // assistant metadata, SQLite row, and watch event cannot disagree.
        terminal_chunks.clear();
        terminal_chunks.push(json!({"type": "finish", "finishReason": "error"}));
    }

    let assistant_parts =
        accumulator.finish(session_id.as_deref().map(|sid| (harness_id.wire_id(), sid)));

    if terminal_chunks.is_empty() {
        terminal_chunks.push(json!({"type": "finish", "finishReason": "stop"}));
    }
    let status =
        resolve_terminal_status(terminal_finish_reason(&terminal_chunks), &assistant_parts);
    let assistant_metadata = assistant_finish_metadata(&terminal_chunks, status);
    let mut terminal_frame = Vec::new();
    for chunk in terminal_chunks {
        terminal_frame.extend_from_slice(&frame(&chunk));
    }
    finalize_with_terminal_frame(
        &run,
        db,
        &claimed,
        &Value::Array(assistant_parts),
        Some(&assistant_metadata),
        status,
        Bytes::from(terminal_frame),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::routes::intercept::test_state;
    use axum::http::header;
    use futures::StreamExt;
    use tokio::sync::{mpsc, Semaphore};

    fn test_scope() -> RtAccountScope {
        RtAccountScope::new("test.invalid", "local-desktop-user").unwrap()
    }

    fn text_message(text: &str) -> Value {
        json!({"role": "user", "parts": [{"type": "text", "text": text}]})
    }

    /// Ports `genTitle`'s `fallbackTitle`, which is what the cluster shows
    /// whenever its title model errors or times out — so a desktop title reads
    /// the same as a degraded cluster one rather than as a third behaviour.
    #[test]
    fn the_auto_title_is_the_first_32_characters_of_the_first_message() {
        assert_eq!(
            auto_thread_title(&text_message("  Fix the login bug  ")).as_deref(),
            Some("Fix the login bug")
        );
        // Exactly 32 characters survive; the 33rd does not.
        let long = "abcdefghijklmnopqrstuvwxyz012345XXXX";
        assert_eq!(
            auto_thread_title(&text_message(long)).as_deref(),
            Some("abcdefghijklmnopqrstuvwxyz012345")
        );
        // Truncation is by CHARACTER, so a multi-byte message is neither cut
        // mid-scalar (which would not compile as a String) nor cut shorter
        // than the cluster cuts it.
        let accented = "áéíóúáéíóúáéíóúáéíóúáéíóúáéíóúàà";
        assert_eq!(
            auto_thread_title(&text_message(accented)).as_deref(),
            Some(accented)
        );
        // Nothing nameable — the thread keeps its default name.
        for empty in ["", "   ", "🙂🙂", "...!!!"] {
            assert_eq!(auto_thread_title(&text_message(empty)), None, "{empty:?}");
        }
        // A file-only message has no text parts to name it after.
        assert_eq!(
            auto_thread_title(&json!({"role": "user", "parts": [{"type": "file"}]})),
            None
        );
    }

    /// The user's own name always wins: renaming mid-turn must not be undone
    /// when the auto-title lands, and a second turn must not re-title.
    #[tokio::test]
    async fn auto_titling_only_ever_replaces_the_default_name() {
        let root = tempfile::tempdir().unwrap();
        let state = test_state(root.path());
        let db = shared_db(&state).unwrap();
        let scope = test_scope();
        let thread = db
            .rt_create_thread_scoped(
                &scope,
                None,
                "org",
                DEFAULT_THREAD_TITLE,
                None,
                "vmcp",
                None,
                "user",
            )
            .unwrap();
        let fence = db
            .rt_thread_fence_in_scope(&scope, "org", &thread.id)
            .unwrap()
            .unwrap();

        assert!(db
            .rt_retitle_thread_if_unchanged(&fence, DEFAULT_THREAD_TITLE, "Fix the login bug")
            .unwrap());
        assert_eq!(
            db.rt_get_thread_for_fence(&fence).unwrap().unwrap().title,
            "Fix the login bug"
        );
        // Already named — a later turn leaves it alone.
        assert!(!db
            .rt_retitle_thread_if_unchanged(&fence, DEFAULT_THREAD_TITLE, "Something else")
            .unwrap());
        assert_eq!(
            db.rt_get_thread_for_fence(&fence).unwrap().unwrap().title,
            "Fix the login bug"
        );

        // The model's title replaces the deterministic one this process wrote,
        // because it names that exact string as what it expects to find.
        assert!(db
            .rt_retitle_thread_if_unchanged(
                &fence,
                "Fix the login bug",
                "Fix unresponsive mobile login"
            )
            .unwrap());
        assert_eq!(
            db.rt_get_thread_for_fence(&fence).unwrap().unwrap().title,
            "Fix unresponsive mobile login"
        );

        // …but a user rename in that same window is final: the model's title
        // arrives expecting the deterministic name and finds the user's.
        db.rt_retitle_thread_if_unchanged(&fence, "Fix unresponsive mobile login", "My own name")
            .unwrap();
        assert!(!db
            .rt_retitle_thread_if_unchanged(
                &fence,
                "Fix unresponsive mobile login",
                "Generated too late"
            )
            .unwrap());
        assert_eq!(
            db.rt_get_thread_for_fence(&fence).unwrap().unwrap().title,
            "My own name"
        );
    }

    fn queued_turn(org: &str, thread_id: &str, message_id: &str, at: u64) -> QueuedTurn {
        let user_message = json!({
            "id": message_id,
            "role": "user",
            "parts": [{"type": "text", "text": format!("text-{message_id}")}],
        });
        QueuedTurn {
            key: ThreadKey::new(org, thread_id),
            fence: RtThreadFence {
                account_scope: test_scope().storage_key(),
                organization_id: org.to_string(),
                thread_id: thread_id.to_string(),
                generation: "test-generation".to_string(),
            },
            workflow_id: format!("thread-run:{thread_id}:{message_id}"),
            message_id: message_id.to_string(),
            input: json!({}),
            text: queue_text(&user_message),
            has_attachments: false,
            user_message,
            enqueued_at: at,
            cancellation: TurnCancellation::new(),
        }
    }

    #[test]
    fn model_id_for_maps_known_tiers() {
        let h = harness::HarnessId::ClaudeCode;
        assert_eq!(model_id_for(h, Some("fast")), "claude-code:haiku");
        assert_eq!(model_id_for(h, Some("smart")), "claude-code:sonnet");
        assert_eq!(model_id_for(h, Some("thinking")), "claude-code:opus-1m");
        // Cloud-only modes fall back to "smart" rather than erroring.
        assert_eq!(model_id_for(h, Some("image")), "claude-code:sonnet");
        assert_eq!(model_id_for(h, None), "claude-code:sonnet");
    }

    #[test]
    fn durable_harness_pin_wins_over_a_later_request_override() {
        assert_eq!(
            harness_selection(Some("codex"), Some("claude-code")).unwrap(),
            HarnessSelection::Pinned(harness::HarnessId::Codex)
        );
        assert_eq!(
            harness_selection(None, Some("claude-code")).unwrap(),
            HarnessSelection::Requested(harness::HarnessId::ClaudeCode)
        );
        assert_eq!(
            harness_selection(None, Some("decopilot")).unwrap(),
            HarnessSelection::Detect
        );
        assert!(harness_selection(Some("decopilot"), Some("codex")).is_err());
    }

    #[test]
    fn native_run_status_chunks_match_the_hosted_control_shape() {
        for (stage, wire_id) in [
            (NativeRunStatusStage::StartingRun, "starting-run"),
            (NativeRunStatusStage::GatheringContext, "gathering-context"),
            (NativeRunStatusStage::PreparingTools, "preparing-tools"),
            (
                NativeRunStatusStage::StartingAssistant,
                "starting-assistant",
            ),
        ] {
            assert_eq!(
                run_status_chunk(stage),
                json!({
                    "type": "data-run-status",
                    "id": "run-status",
                    "data": {"stage": wire_id},
                })
            );
        }
    }

    #[tokio::test]
    async fn pre_harness_failure_opens_the_reserved_assistant_before_status_and_error() {
        let dir = tempfile::tempdir().unwrap();
        let db = ThreadsDb::open_in_memory().unwrap();
        let thread_id = format!("pre-harness-failure-{}", uuid::Uuid::new_v4());
        let message_id = "pre-harness-user";
        let user_message = json!({
            "id": message_id,
            "role": "user",
            "parts": [{"type": "text", "text": "hello"}],
        });
        db.rt_create_thread(Some(&thread_id), "acme", "", None, "vm", None, "user")
            .unwrap();
        let fence = db
            .rt_thread_fence_in_org("acme", &thread_id)
            .unwrap()
            .unwrap();
        db.rt_enqueue_turn_in_org(
            "acme",
            &thread_id,
            &RtTurnEnqueueInput {
                message_id: message_id.to_string(),
                workflow_id: "pre-harness-workflow".to_string(),
                task_id: "pre-harness-task".to_string(),
                normalized_input: json!({}),
                user_message: user_message.clone(),
                enqueued_at: 1,
            },
        )
        .unwrap();
        let claimed = match db.rt_claim_turn_queue_head_fenced(&fence).unwrap().unwrap() {
            RtTurnClaimOutcome::Ready(claimed) => claimed,
            RtTurnClaimOutcome::Malformed(error) => panic!("unexpected malformed claim: {error:?}"),
            RtTurnClaimOutcome::Completed { workflow_id } => {
                panic!("unexpected completed claim: {workflow_id}")
            }
        };
        assert!(matches!(
            db.rt_begin_claimed_turn(&claimed).unwrap(),
            RtTurnBeginOutcome::Begun(_)
        ));
        let run = Arc::new(DecopilotRun {
            key: ThreadKey::new("acme", &thread_id),
            spool: RunSpool::open(dir.path().join("early-failure.sse"))
                .await
                .unwrap(),
            has_frames: AtomicBool::new(false),
            finished: AtomicBool::new(false),
            finish_lock: AsyncMutex::new(()),
        });
        let cancellation = TurnCancellation::new();

        run.push(frame(&json!({
            "type": "data-user-message",
            "data": user_message,
        })))
        .await
        .unwrap();
        run.push(frame(&assistant_start_chunk(&claimed)))
            .await
            .unwrap();
        publish_run_status(&run, NativeRunStatusStage::StartingRun)
            .await
            .unwrap();
        assert!(
            finish_after_user(
                &run,
                &db,
                &claimed,
                &cancellation,
                Some("synthetic pre-harness failure".to_string()),
            )
            .await
        );

        let mut subscription = run.subscribe().await.unwrap();
        let replay = String::from_utf8(subscription.take_replay().to_vec()).unwrap();
        let chunks = replay
            .split("\n\n")
            .filter_map(|wire_frame| {
                wire_frame
                    .lines()
                    .find_map(|line| line.strip_prefix("data: "))
                    .map(|data| serde_json::from_str::<Value>(data).unwrap())
            })
            .collect::<Vec<_>>();
        assert_eq!(
            chunks
                .iter()
                .filter_map(|chunk| chunk.get("type").and_then(Value::as_str))
                .collect::<Vec<_>>(),
            vec![
                "data-user-message",
                "start",
                "data-run-status",
                "error",
                "finish",
            ]
        );
        assert_eq!(
            chunks[1]["messageId"],
            reserved_assistant_message_id(&claimed)
        );
        assert_eq!(chunks[3]["errorText"], "synthetic pre-harness failure");
        assert_eq!(chunks[4]["finishReason"], "error");
        cleanup_run(&run).await;
    }

    #[tokio::test]
    async fn run_status_spool_failure_is_returned_to_the_dispatcher() {
        let dir = tempfile::tempdir().unwrap();
        let run = Arc::new(DecopilotRun {
            key: ThreadKey::new("acme", "status-spool-failure"),
            spool: RunSpool::open_with_cap(dir.path().join("status-failure.sse"), 1)
                .await
                .unwrap(),
            has_frames: AtomicBool::new(false),
            finished: AtomicBool::new(false),
            finish_lock: AsyncMutex::new(()),
        });
        run.push(Bytes::from_static(b"x")).await.unwrap();

        let error = publish_run_status(&run, NativeRunStatusStage::StartingAssistant)
            .await
            .expect_err("status retention failure must abort before spawning the harness");
        assert!(error.contains("capacity exceeded"), "{error}");
        cleanup_run(&run).await;
    }

    #[test]
    fn meaningful_stream_timing_skips_only_protocol_bookkeeping() {
        for chunk_type in ["start", "start-step", "finish-step"] {
            assert!(!is_meaningful_harness_chunk(&json!({"type": chunk_type})));
        }
        for chunk_type in ["text-delta", "reasoning-delta", "finish"] {
            assert!(is_meaningful_harness_chunk(&json!({"type": chunk_type})));
        }
    }

    #[test]
    fn assistant_metadata_preserves_the_actual_final_finish_reason() {
        assert_eq!(
            assistant_finish_metadata(
                &[
                    json!({"type": "finish", "finishReason": "stop"}),
                    json!({"type": "finish", "finishReason": "length"}),
                ],
                RtTurnTerminalStatus::Completed,
            ),
            json!({"finishReason": "length"})
        );
        assert_eq!(
            assistant_finish_metadata(&[], RtTurnTerminalStatus::Failed),
            json!({"finishReason": "error"})
        );
        assert_eq!(
            assistant_finish_metadata(&[], RtTurnTerminalStatus::RequiresAction),
            json!({"finishReason": "stop"})
        );
    }

    #[test]
    fn terminal_status_matches_production_finish_reason_and_parts_policy() {
        assert_eq!(
            resolve_terminal_status(Some("stop"), &[]),
            RtTurnTerminalStatus::Completed
        );
        assert_eq!(
            resolve_terminal_status(
                Some("stop"),
                &[json!({"type": "text", "text": "Do you want another change?"})],
            ),
            RtTurnTerminalStatus::RequiresAction
        );
        assert_eq!(
            resolve_terminal_status(
                Some("stop"),
                &[json!({
                    "type": "text",
                    "text": "See https://example.com/page?q=1 for details."
                })],
            ),
            RtTurnTerminalStatus::Completed,
            "a URL query string is not a question"
        );
        assert_eq!(
            resolve_terminal_status(
                Some("stop"),
                &[json!({
                    "type": "text",
                    "text": "See https://example.com/page?q=1 — does that help?"
                })],
            ),
            RtTurnTerminalStatus::RequiresAction
        );
        assert_eq!(
            resolve_terminal_status(
                Some("tool-calls"),
                &[json!({
                    "type": "tool-user_ask",
                    "state": "input-available"
                })],
            ),
            RtTurnTerminalStatus::RequiresAction
        );
        assert_eq!(
            resolve_terminal_status(
                Some("tool-calls"),
                &[json!({"type": "tool-Bash", "state": "approval-requested"})],
            ),
            RtTurnTerminalStatus::RequiresAction
        );
        assert_eq!(
            resolve_terminal_status(
                Some("tool-calls"),
                &[json!({"type": "tool-user_ask", "state": "output-available"})],
            ),
            RtTurnTerminalStatus::Completed
        );
        for reason in [Some("length"), Some("error"), None] {
            assert_eq!(
                resolve_terminal_status(reason, &[]),
                RtTurnTerminalStatus::Failed
            );
        }
    }

    // -- git_sandbox_config_from_input ---------------------------------------

    #[test]
    fn no_sandbox_block_is_not_git_backed() {
        let input = json!({"messages": []});
        assert!(git_sandbox_config_from_input(&input).is_none());
    }

    #[test]
    fn sandbox_block_without_clone_url_is_not_git_backed() {
        let input = json!({"sandbox": {"virtualMcpId": "vm1", "repo": {}}});
        assert!(git_sandbox_config_from_input(&input).is_none());
    }

    #[test]
    fn full_sandbox_block_parses_repo_and_workload() {
        let input = json!({
            "sandbox": {
                "virtualMcpId": "vm1",
                "repo": {"cloneUrl": "https://github.com/acme/widgets.git", "branch": "feature-x"},
                "workload": {"runtime": "node", "packageManager": "npm", "packageManagerPath": "apps/web"},
            },
        });
        let cfg = git_sandbox_config_from_input(&input).expect("git-backed");
        assert_eq!(cfg.virtual_mcp_id, "vm1");
        assert_eq!(cfg.clone_url, "https://github.com/acme/widgets.git");
        assert_eq!(cfg.branch.as_deref(), Some("feature-x"));
        assert_eq!(cfg.runtime.as_deref(), Some("node"));
        assert_eq!(cfg.package_manager.as_deref(), Some("npm"));
        assert_eq!(cfg.package_manager_path.as_deref(), Some("apps/web"));
    }

    #[test]
    fn sandbox_block_without_workload_omits_it() {
        let input = json!({
            "sandbox": {
                "virtualMcpId": "vm1",
                "repo": {"cloneUrl": "https://github.com/acme/widgets.git"},
            },
        });
        let cfg = git_sandbox_config_from_input(&input).expect("git-backed");
        assert!(cfg.branch.is_none());
        assert!(cfg.runtime.is_none());
        assert!(cfg.package_manager.is_none());
    }

    #[test]
    fn queue_is_fifo_dedupes_message_ids_and_matches_production_list_shape() {
        let queue = ThreadQueue::new();
        let first = queued_turn("acme", "fifo-thread", "m1", 10);
        let second = queued_turn("acme", "fifo-thread", "m2", 20);

        let EnqueueOutcome::Enqueued { first: start } = queue.enqueue(first.clone()) else {
            panic!("first enqueue must be new");
        };
        assert_eq!(start.unwrap().message_id, "m1");
        let EnqueueOutcome::Enqueued { first: start } = queue.enqueue(second) else {
            panic!("second enqueue must be new");
        };
        assert!(start.is_none(), "only the head may receive a worker token");
        let EnqueueOutcome::Duplicate = queue.enqueue(first) else {
            panic!("same active/queued message id must dedupe");
        };

        assert_eq!(
            queue.list(),
            vec![
                json!({
                    "workflowId": "thread-run:fifo-thread:m1",
                    "messageId": "m1",
                    "status": "running",
                    "enqueuedAt": 10,
                    "source": "user-message",
                    "text": "text-m1",
                    "hasAttachments": false,
                }),
                json!({
                    "workflowId": "thread-run:fifo-thread:m2",
                    "messageId": "m2",
                    "status": "queued",
                    "enqueuedAt": 20,
                    "source": "user-message",
                    "text": "text-m2",
                    "hasAttachments": false,
                }),
            ]
        );
    }

    #[tokio::test]
    async fn drain_never_executes_second_turn_until_first_has_fully_returned() {
        let queue = ThreadQueue::new();
        let EnqueueOutcome::Enqueued { first: Some(first) } =
            queue.enqueue(queued_turn("acme", "serialized", "m1", 1))
        else {
            panic!("first turn must own worker token");
        };
        assert!(matches!(
            queue.enqueue(queued_turn("acme", "serialized", "m2", 2)),
            EnqueueOutcome::Enqueued { first: None }
        ));

        let (started_tx, mut started_rx) = mpsc::unbounded_channel();
        let release_first = Arc::new(Semaphore::new(0));
        let release_for_worker = release_first.clone();
        let queue_for_worker = queue.clone();
        let worker = tokio::spawn(async move {
            drain_thread_queue(queue_for_worker, *first, move |turn| {
                let started_tx = started_tx.clone();
                let release = release_for_worker.clone();
                async move {
                    started_tx.send(turn.message_id.clone()).unwrap();
                    if turn.message_id == "m1" {
                        release.acquire().await.unwrap().forget();
                    }
                }
            })
            .await;
        });

        assert_eq!(started_rx.recv().await.as_deref(), Some("m1"));
        assert!(
            started_rx.try_recv().is_err(),
            "queued turn started while head callback was still blocked"
        );
        assert_eq!(queue.list()[1]["status"], "queued");
        release_first.add_permits(1);
        assert_eq!(started_rx.recv().await.as_deref(), Some("m2"));
        worker.await.unwrap();
        assert!(queue.is_idle());
    }

    #[tokio::test]
    async fn queue_cancel_removes_queued_and_requests_active_cancellation() {
        let queue = ThreadQueue::new();
        let first = queued_turn("acme", "cancel-thread", "m1", 1);
        let active_cancel = first.cancellation.clone();
        queue.enqueue(first);
        queue.enqueue(queued_turn("acme", "cancel-thread", "m2", 2));

        assert!(matches!(
            queue.cancel_workflow("thread-run:cancel-thread:m2"),
            QueueCancelOutcome::Queued
        ));
        assert_eq!(queue.list().len(), 1);
        let QueueCancelOutcome::Active(cancellation) =
            queue.cancel_workflow("thread-run:cancel-thread:m1")
        else {
            panic!("head cancellation must target active controller");
        };
        cancellation.request().await;
        assert!(active_cancel.is_requested());
        assert!(matches!(
            queue.cancel_workflow("thread-run:cancel-thread:missing"),
            QueueCancelOutcome::NotFound
        ));
    }

    #[tokio::test]
    async fn shutdown_uses_one_deadline_for_every_thread_queue() {
        let first = ThreadQueue::new();
        let second = ThreadQueue::new();
        assert!(matches!(
            first.enqueue(queued_turn("shutdown", "first", "m1", 1)),
            EnqueueOutcome::Enqueued { first: Some(_) }
        ));
        assert!(matches!(
            second.enqueue(queued_turn("shutdown", "second", "m2", 2)),
            EnqueueOutcome::Enqueued { first: Some(_) }
        ));

        // Neither synthetic worker will call `stop_worker`, so both waits are
        // intentionally stuck. Two per-queue timeouts would take roughly twice
        // this budget; the production helper must return after one shared bound.
        let started = tokio::time::Instant::now();
        assert!(
            !stop_thread_queues(vec![first, second], std::time::Duration::from_millis(30)).await
        );
        assert!(
            started.elapsed() < std::time::Duration::from_millis(100),
            "shutdown deadline was multiplied by the number of queues"
        );
    }

    #[tokio::test]
    async fn shutdown_fails_for_a_reaped_worker_with_no_durable_terminal_commit() {
        let queue = ThreadQueue::new();
        assert!(matches!(
            queue.enqueue(queued_turn("shutdown-terminal-failure", "thread", "m1", 1,)),
            EnqueueOutcome::Enqueued { first: Some(_) }
        ));

        // Models the exact production branch after the harness has been reaped
        // but `rt_finalize_claimed_turn` did not commit.
        queue.stop_worker_after_durable_terminal_failure();
        assert!(!queue.inner.lock_ok().worker_running);
        assert!(queue.durable_terminal_failed());
        assert!(
            !stop_thread_queues(vec![queue], Duration::from_secs(1)).await,
            "a stopped process is not a clean shutdown when its durable terminal fence was lost"
        );
    }

    #[test]
    fn durable_terminal_failure_latch_survives_later_worker_state_changes() {
        let queue = ThreadQueue::new();
        queue.stop_worker_after_durable_terminal_failure();

        assert!(queue.start_worker_if_idle());
        queue.stop_worker();
        let _ = queue.stop_and_drain_tail();

        assert!(
            queue.durable_terminal_failed(),
            "only next-boot durable recovery may retire this process-lifetime failure evidence"
        );
        assert!(
            !queue.is_idle(),
            "registry cleanup must retain the sticky failure for shutdown reporting"
        );
    }

    #[tokio::test]
    async fn shutdown_stops_recovered_worker_before_it_claims_a_durable_tail() {
        let dir = tempfile::tempdir().unwrap();
        let state = test_state(dir.path());
        let db: &'static ThreadsDb = Box::leak(Box::new(ThreadsDb::open_in_memory().unwrap()));
        let org = "recovered-stop-org";
        let thread_id = format!("recovered-stop-{}", uuid::Uuid::new_v4());
        db.rt_create_thread(Some(&thread_id), org, "", None, "vm", None, "user")
            .unwrap();
        db.rt_enqueue_turn_in_org(
            org,
            &thread_id,
            &RtTurnEnqueueInput {
                message_id: "recovered-tail".to_string(),
                workflow_id: "recovered-tail-workflow".to_string(),
                task_id: thread_id.clone(),
                normalized_input: json!({}),
                user_message: json!({
                    "id": "recovered-tail",
                    "role": "user",
                    "parts": [],
                }),
                enqueued_at: 1,
            },
        )
        .unwrap();
        let fence = db.rt_thread_fence_in_org(org, &thread_id).unwrap().unwrap();
        let key = ThreadKey::from_fence(&fence);
        let lifecycle_gate = thread_lifecycle_gate_for_key(&key);
        let lifecycle_guard = lifecycle_gate.lock().await;
        let queue = ThreadQueue::new();
        assert!(queue.start_worker_if_idle());

        let worker = {
            let state = state.clone();
            let key = key.clone();
            let fence = fence.clone();
            let queue = queue.clone();
            tokio::spawn(async move {
                drain_durable_thread_queue(&state, db, key, fence, queue).await;
            })
        };
        tokio::task::yield_now().await;

        let (active, removed) = queue.stop_and_drain_tail();
        assert!(active.is_none(), "no durable claim has been mirrored yet");
        assert!(removed.is_empty(), "the recovered RAM mirror starts empty");
        assert!(
            queue.inner.lock_ok().worker_running,
            "empty RAM must not falsely mark a recovered worker stopped"
        );
        let waiter = {
            let queue = queue.clone();
            tokio::spawn(async move { queue.wait_worker_stopped().await })
        };

        drop(lifecycle_guard);
        tokio::time::timeout(Duration::from_secs(1), worker)
            .await
            .expect("worker must observe the stop fence before claiming")
            .unwrap();
        tokio::time::timeout(Duration::from_secs(1), waiter)
            .await
            .expect("waiter must not lose the worker-stopped notification")
            .unwrap();

        let durable = db.rt_list_turn_queue_in_org(org, &thread_id).unwrap();
        assert_eq!(durable.len(), 1);
        assert_eq!(durable[0].state, RtTurnQueueState::Queued);
        assert!(durable[0].claim_token.is_none());
        assert!(db
            .rt_list_messages_in_org(org, &thread_id, 100, 0, false)
            .unwrap()
            .0
            .is_empty());
    }

    #[tokio::test]
    async fn queue_registry_is_tenant_scoped_and_evicts_after_drain() {
        let thread_id = "same-local-thread-id";
        let acme = ThreadKey::new("queue-tenant-acme", thread_id);
        let other = ThreadKey::new("queue-tenant-other", thread_id);
        let (queue, outcome) =
            enqueue_thread_turn(&acme, queued_turn(&acme.org, thread_id, "tenant-m1", 1));
        let EnqueueOutcome::Enqueued { first: Some(first) } = outcome else {
            panic!("first turn must own worker token");
        };

        assert!(
            !thread_queues().lock_ok().contains_key(&other),
            "another organization must not resolve the same thread id's runtime queue"
        );
        assert_eq!(
            queue.list().len(),
            1,
            "other org must not mutate acme queue"
        );

        drain_thread_queue(queue, *first, |_| async {}).await;
        assert!(
            !thread_queues().lock_ok().contains_key(&acme),
            "empty per-thread queue entries must be evicted"
        );
    }

    #[tokio::test]
    async fn worker_panic_guard_latches_durable_failure_and_blocks_clean_shutdown() {
        let key = ThreadKey::new("panic-org", "panic-thread");
        let queue = ThreadQueue::new();
        assert!(matches!(
            queue.enqueue(queued_turn(&key.org, &key.thread_id, "panic-message", 1)),
            EnqueueOutcome::Enqueued { first: Some(_) }
        ));

        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe({
            let key = key.clone();
            let queue = queue.clone();
            move || {
                let _guard = WorkerPanicGuard::new(key, queue);
                panic!("synthetic worker panic");
            }
        }));

        assert!(result.is_err());
        assert!(!queue.inner.lock_ok().worker_running);
        assert!(queue.durable_terminal_failed());
        assert!(
            !stop_thread_queues(vec![queue], Duration::from_secs(1)).await,
            "panic without a durable terminal commit must fail shutdown quiescence"
        );
    }

    #[tokio::test]
    async fn stream_holds_open_for_a_thread_that_was_never_dispatched() {
        let dir = tempfile::tempdir().unwrap();
        let state = test_state(dir.path());
        // Inverted from this test's old name/assertion
        // (`stream_is_204_for_a_thread_that_was_never_dispatched`): 204 here
        // used to mean "nothing will ever arrive, stop reconnecting" to the
        // real client's `runSseLoop` — correct for the real backend's
        // degraded-JetStream case, wrong for this desktop reimplementation's
        // ordinary "no dispatch yet" idle thread. See `DecopilotRun`'s "Idle
        // placeholder" doc section.
        let key = ThreadKey::new("acme", "never-dispatched");
        let res = stream(&state, &test_scope(), &key.org, &key.thread_id).await;
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(
            res.headers().get(header::CONTENT_TYPE).unwrap(),
            "text/event-stream"
        );
        drop(res);
        let run = registry().lock_ok().remove(&key).unwrap();
        cleanup_run(&run).await;
    }

    #[tokio::test]
    async fn a_later_dispatch_reuses_the_idle_placeholder_a_stream_call_created() {
        let thread_id = "idle-placeholder-reuse";
        let key = ThreadKey::new("acme", thread_id);
        let dir = tempfile::tempdir().unwrap();
        let state = test_state(dir.path());
        // Simulates the GET .../stream call that arrives before any dispatch.
        let _res = stream(&state, &test_scope(), "acme", thread_id).await;
        let placeholder = registry().lock_ok().get(&key).cloned().unwrap();
        assert!(placeholder.is_idle_placeholder());

        // Simulates `send_message`'s run-selection logic directly rather
        // than calling `send_message` itself, which would reach
        // `harness::detect::ensure_detected()` — a real subprocess probe,
        // unsafe for a unit test (see this module's other tests' notes on
        // why the full dispatch path is E2E-only).
        let selected = run_for_turn(&state, &key).await.unwrap();
        assert!(
            Arc::ptr_eq(&placeholder, &selected),
            "expected the same Arc so the GET .../stream subscriber sees this turn's frames live"
        );
        registry().lock_ok().remove(&key);
        cleanup_run(&placeholder).await;
    }

    #[tokio::test]
    async fn lagged_stream_keeps_registry_and_reconnect_replays_every_frame() {
        let dir = tempfile::tempdir().unwrap();
        let state = test_state(dir.path());
        let key = ThreadKey::new("acme", "lag-reconnect");
        let spool = RunSpool::open_with_test_limits(dir.path().join("lag-reconnect.sse"), 1024, 1)
            .await
            .unwrap();
        let run = Arc::new(DecopilotRun {
            key: key.clone(),
            spool,
            has_frames: AtomicBool::new(false),
            finished: AtomicBool::new(false),
            finish_lock: AsyncMutex::new(()),
        });
        registry().lock_ok().insert(key.clone(), run.clone());

        // `stream` subscribes synchronously before returning its body. Do not
        // poll that body until two frames have crossed a capacity-one channel:
        // its first recv must report lag and terminate without registry cleanup.
        let lagged = stream(&state, &test_scope(), &key.org, &key.thread_id).await;
        let first = frame(&json!({"type": "text-delta", "delta": "one"}));
        let second = frame(&json!({"type": "text-delta", "delta": "two"}));
        run.push(first.clone()).await.unwrap();
        run.push(second.clone()).await.unwrap();
        let lagged_body = axum::body::to_bytes(lagged.into_body(), 1024)
            .await
            .unwrap();
        assert!(lagged_body.is_empty());
        assert!(Arc::ptr_eq(registry().lock_ok().get(&key).unwrap(), &run));

        run.finish().await;
        let replayed = stream(&state, &test_scope(), &key.org, &key.thread_id).await;
        let replayed_body = axum::body::to_bytes(replayed.into_body(), 4096)
            .await
            .unwrap();
        let mut expected = first.to_vec();
        expected.extend_from_slice(&second);
        assert_eq!(replayed_body.as_ref(), expected);
        assert!(!registry().lock_ok().contains_key(&key));
    }

    #[tokio::test]
    async fn cancel_is_idempotent_for_an_unknown_thread() {
        let dir = tempfile::tempdir().unwrap();
        let state = test_state(dir.path());
        let res = cancel(&state, &test_scope(), "acme", "never-dispatched-either").await;
        assert_eq!(res.status(), StatusCode::ACCEPTED);
    }

    #[tokio::test]
    async fn old_stream_cleanup_keeps_new_registry_run_but_removes_old_spool() {
        let dir = tempfile::tempdir().unwrap();
        let state = test_state(dir.path());
        let acme = ThreadKey::new("acme", "shared-id");
        let other = ThreadKey::new("other", "shared-id");
        let old = DecopilotRun::open(&state, acme.clone()).await.unwrap();
        let current = DecopilotRun::open(&state, acme.clone()).await.unwrap();
        let other_run = DecopilotRun::open(&state, other.clone()).await.unwrap();
        let old_path = old.spool.path().to_path_buf();
        {
            let mut runs = registry().lock_ok();
            runs.insert(acme.clone(), current.clone());
            runs.insert(other.clone(), other_run.clone());
        }

        cleanup_run(&old).await;
        assert_eq!(
            tokio::fs::metadata(old_path).await.unwrap_err().kind(),
            std::io::ErrorKind::NotFound
        );
        assert!(Arc::ptr_eq(
            registry().lock_ok().get(&acme).unwrap(),
            &current
        ));
        cleanup_run(&current).await;
        assert!(Arc::ptr_eq(
            registry().lock_ok().get(&other).unwrap(),
            &other_run
        ));
        cleanup_run(&other_run).await;
    }

    #[tokio::test]
    async fn startup_cleanup_removes_only_direct_owned_sse_spools() {
        let dir = tempfile::tempdir().unwrap();
        let state = test_state(dir.path());
        let spool_dir = dir.path().join(".decocms/run-streams");
        let nested = spool_dir.join("nested");
        tokio::fs::create_dir_all(&nested).await.unwrap();
        let stale = spool_dir.join("stale.sse");
        let unrelated = spool_dir.join("keep.txt");
        let nested_sse = nested.join("keep.sse");
        tokio::fs::write(&stale, b"stale").await.unwrap();
        tokio::fs::write(&unrelated, b"keep").await.unwrap();
        tokio::fs::write(&nested_sse, b"keep").await.unwrap();

        cleanup_stale_run_spools(&state).await.unwrap();

        assert_eq!(
            tokio::fs::metadata(stale).await.unwrap_err().kind(),
            std::io::ErrorKind::NotFound
        );
        assert!(tokio::fs::metadata(unrelated).await.is_ok());
        assert!(tokio::fs::metadata(nested_sse).await.is_ok());
    }

    #[tokio::test]
    async fn spool_capacity_failure_cancels_and_persists_failed_terminal() {
        let dir = tempfile::tempdir().unwrap();
        let db = ThreadsDb::open_in_memory().unwrap();
        let thread_id = format!("spool-failure-{}", uuid::Uuid::new_v4());
        let message_id = "spool-user";
        db.rt_create_thread(Some(&thread_id), "acme", "", None, "vm", None, "user")
            .unwrap();
        let fence = db
            .rt_thread_fence_in_org("acme", &thread_id)
            .unwrap()
            .unwrap();
        db.rt_enqueue_turn_in_org(
            "acme",
            &thread_id,
            &RtTurnEnqueueInput {
                message_id: message_id.to_string(),
                workflow_id: "spool-workflow".to_string(),
                task_id: "spool-task".to_string(),
                normalized_input: json!({}),
                user_message: json!({
                    "id": message_id,
                    "role": "user",
                    "parts": [{"type": "text", "text": "hello"}],
                }),
                enqueued_at: 1,
            },
        )
        .unwrap();
        let claimed = match db.rt_claim_turn_queue_head_fenced(&fence).unwrap().unwrap() {
            RtTurnClaimOutcome::Ready(claimed) => claimed,
            RtTurnClaimOutcome::Malformed(error) => panic!("unexpected malformed claim: {error:?}"),
            RtTurnClaimOutcome::Completed { workflow_id } => {
                panic!("unexpected completed claim: {workflow_id}")
            }
        };
        assert!(matches!(
            db.rt_begin_claimed_turn(&claimed).unwrap(),
            RtTurnBeginOutcome::Begun(_)
        ));
        let key = ThreadKey::new("acme", &thread_id);
        let spool = RunSpool::open_with_cap(dir.path().join("bounded.sse"), 4)
            .await
            .unwrap();
        let run = Arc::new(DecopilotRun {
            key,
            spool,
            has_frames: AtomicBool::new(false),
            finished: AtomicBool::new(false),
            finish_lock: AsyncMutex::new(()),
        });
        run.push(Bytes::from_static(b"1234")).await.unwrap();
        let error = run.push(Bytes::from_static(b"5")).await.unwrap_err();
        let cancellation = TurnCancellation::new();

        assert!(terminate_for_spool_failure(&run, &db, &claimed, &cancellation, &error).await);

        assert!(cancellation.is_requested());
        let assistant = db
            .rt_get_message_in_org("acme", &reserved_assistant_message_id(&claimed))
            .unwrap()
            .unwrap();
        assert_eq!(assistant.role, "assistant");
        assert_eq!(assistant.parts[0]["text"], STREAM_FAILURE_RESPONSE);
        assert_eq!(
            assistant.metadata.as_ref().unwrap()["errorCode"],
            "local_stream_failure"
        );
        assert_eq!(
            db.rt_get_thread_in_org("acme", &thread_id)
                .unwrap()
                .unwrap()
                .status,
            "failed"
        );
        assert!(db
            .rt_list_turn_queue_in_org("acme", &thread_id)
            .unwrap()
            .is_empty());
        cleanup_run(&run).await;
    }

    #[tokio::test]
    async fn active_malformed_head_publishes_the_committed_failed_thread() {
        let db = ThreadsDb::open_in_memory().unwrap();
        let account = test_scope();
        let org = format!("malformed-watch-org-{}", uuid::Uuid::new_v4());
        let thread_id = format!("malformed-watch-thread-{}", uuid::Uuid::new_v4());
        db.rt_create_thread_scoped(
            &account,
            Some(&thread_id),
            &org,
            "Malformed local thread",
            None,
            "vir_local",
            Some("feature/native"),
            &account.user_id,
        )
        .unwrap();
        db.rt_enqueue_turn_scoped(
            &account,
            &org,
            &thread_id,
            &RtTurnEnqueueInput {
                message_id: "malformed-watch-message".to_string(),
                workflow_id: "malformed-watch-workflow".to_string(),
                task_id: thread_id.clone(),
                normalized_input: json!({"messages": []}),
                user_message: json!({
                    "id": "malformed-watch-message",
                    "role": "user",
                    "parts": [{"type": "text", "text": "accepted"}],
                }),
                enqueued_at: 1,
            },
        )
        .unwrap();
        db.execute_batch_for_test(
            "UPDATE native_scoped_turn_queue SET normalized_input_json = '{' \
             WHERE workflow_id = 'malformed-watch-workflow'",
        )
        .unwrap();
        let fence = db
            .rt_thread_fence_in_scope(&account, &org, &thread_id)
            .unwrap()
            .unwrap();
        let malformed = match db.rt_claim_turn_queue_head_fenced(&fence).unwrap().unwrap() {
            RtTurnClaimOutcome::Malformed(orphan) => orphan,
            other => panic!("expected malformed head, got {other:?}"),
        };

        let response = watch::get(&account, &org, Some("types=decopilot.thread.status"));
        let mut stream = response.into_body().into_data_stream();
        let connected = tokio::time::timeout(Duration::from_secs(1), stream.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(String::from_utf8_lossy(&connected).contains("event: connected"));

        finalize_active_malformed_orphan(&db, &malformed).unwrap();

        let status = tokio::time::timeout(Duration::from_secs(1), stream.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let status = String::from_utf8(status.to_vec()).unwrap();
        let data = status
            .lines()
            .find_map(|line| line.strip_prefix("data: "))
            .unwrap();
        let event: Value = serde_json::from_str(data).unwrap();
        assert_eq!(event["subject"], thread_id);
        assert_eq!(event["data"]["status"], "failed");
        assert_eq!(event["data"]["title"], "Malformed local thread");
        assert_eq!(event["data"]["virtual_mcp_id"], "vir_local");
        assert_eq!(event["data"]["created_by"], account.user_id);
        assert_eq!(event["data"]["branch"], "feature/native");
        assert!(event["data"].get("message_id").is_none());
    }

    #[tokio::test]
    async fn send_rejects_a_thread_already_inside_delete_lifecycle() {
        let dir = tempfile::tempdir().unwrap();
        let state = test_state(dir.path());
        let thread_id = format!("closing-{}", uuid::Uuid::new_v4());
        let scope = test_scope();
        mark_thread_closing(&scope, "acme", &thread_id);
        let body = Bytes::from(
            serde_json::to_vec(&json!({
                "messages": [{
                    "id": "closing-message",
                    "role": "user",
                    "parts": [{"type": "text", "text": "must not enqueue"}],
                }],
            }))
            .unwrap(),
        );

        let response = send_message(&state, &scope, "acme", &thread_id, &body).await;
        clear_thread_closing(&scope, "acme", &thread_id);

        assert_eq!(response.status(), StatusCode::CONFLICT);
        assert!(shared_db(&state)
            .unwrap()
            .rt_get_thread_in_org("acme", &thread_id)
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn send_rejects_reserved_assistant_namespace_before_implicit_create() {
        let dir = tempfile::tempdir().unwrap();
        let state = test_state(dir.path());
        let scope = test_scope();
        let thread_id = format!("reserved-id-{}", uuid::Uuid::new_v4());
        let body = Bytes::from(
            serde_json::to_vec(&json!({
                "messages": [{
                    "id": "native-assistant:v99:caller-controlled",
                    "role": "user",
                    "parts": [{"type": "text", "text": "must be rejected"}],
                }],
            }))
            .unwrap(),
        );

        let response = send_message(&state, &scope, "acme", &thread_id, &body).await;

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert!(shared_db(&state)
            .unwrap()
            .rt_get_thread_in_scope(&scope, "acme", &thread_id)
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn delete_quiesce_timeout_keeps_durable_tail_closed_and_resumable() {
        let dir = tempfile::tempdir().unwrap();
        let state = test_state(dir.path());
        let scope = test_scope();
        let org = "delete-timeout-org";
        let thread_id = format!("delete-timeout-{}", uuid::Uuid::new_v4());
        let database = shared_db(&state).unwrap();
        database
            .rt_create_thread_scoped(
                &scope,
                Some(&thread_id),
                org,
                "",
                None,
                "vmcp",
                None,
                &scope.user_id,
            )
            .unwrap();
        let mut durable_items = Vec::new();
        for (message_id, at) in [("timeout-head", 1), ("timeout-tail", 2)] {
            let input = RtTurnEnqueueInput {
                message_id: message_id.to_string(),
                workflow_id: format!("workflow-{message_id}"),
                task_id: thread_id.clone(),
                normalized_input: json!({}),
                user_message: json!({
                    "id": message_id,
                    "role": "user",
                    "parts": [{"type": "text", "text": message_id}],
                }),
                enqueued_at: at,
            };
            let item = match database
                .rt_enqueue_turn_scoped(&scope, org, &thread_id, &input)
                .unwrap()
            {
                RtTurnEnqueueOutcome::Inserted(item) => item,
                other => panic!("expected insertion, got {other:?}"),
            };
            durable_items.push(item);
        }
        let fence = database
            .rt_thread_fence_in_scope(&scope, org, &thread_id)
            .unwrap()
            .unwrap();
        assert!(database.rt_mark_thread_delete_pending(&fence).unwrap());
        mark_thread_closing(&scope, org, &thread_id);
        let key = ThreadKey::from_fence(&fence);
        for item in durable_items {
            let _ = enqueue_thread_turn(&key, QueuedTurn::from_durable(item));
        }

        let error = quiesce_thread_for_delete_with_timeout(&state, &fence, Duration::ZERO)
            .await
            .unwrap_err();
        assert_eq!(error.status, StatusCode::CONFLICT);
        assert!(database.rt_thread_delete_pending(&fence).unwrap());
        assert_eq!(
            database
                .rt_list_turn_queue_scoped(&scope, org, &thread_id)
                .unwrap()
                .len(),
            2,
            "timeout must not discard either already-accepted row"
        );
        assert!(database
            .rt_claim_turn_queue_head_fenced(&fence)
            .unwrap()
            .is_none());

        if let Some(queue) = thread_queues().lock_ok().remove(&key) {
            queue.stop_worker();
        }
        clear_thread_closing(&scope, org, &thread_id);
    }

    #[tokio::test]
    async fn orphan_finalization_failure_keeps_account_recovery_retryable() {
        let dir = tempfile::tempdir().unwrap();
        let state = test_state(dir.path());
        let scope = RtAccountScope::new(
            "retryable-recovery.invalid",
            format!("recovery-user-{}", uuid::Uuid::new_v4()),
        )
        .unwrap();
        let org = "retryable-recovery-org";
        let thread_id = format!("retryable-recovery-{}", uuid::Uuid::new_v4());
        let database = shared_db(&state).unwrap();
        database
            .rt_create_thread_scoped(
                &scope,
                Some(&thread_id),
                org,
                "retryable recovery",
                None,
                "vmcp",
                None,
                &scope.user_id,
            )
            .unwrap();
        let input = RtTurnEnqueueInput {
            message_id: "retryable-user".to_string(),
            workflow_id: "retryable-workflow".to_string(),
            task_id: thread_id.clone(),
            normalized_input: json!({}),
            user_message: json!({
                "id": "retryable-user",
                "role": "user",
                "parts": [{"type": "text", "text": "accepted"}],
            }),
            enqueued_at: 1,
        };
        database
            .rt_enqueue_turn_scoped(&scope, org, &thread_id, &input)
            .unwrap();
        let fence = database
            .rt_thread_fence_in_scope(&scope, org, &thread_id)
            .unwrap()
            .unwrap();
        database
            .rt_claim_turn_queue_head_fenced(&fence)
            .unwrap()
            .unwrap();
        let untouched_thread = format!("untouched-recovery-{}", uuid::Uuid::new_v4());
        database
            .rt_create_thread_scoped(
                &scope,
                Some(&untouched_thread),
                org,
                "must not launch on failed recovery",
                None,
                "vmcp",
                None,
                &scope.user_id,
            )
            .unwrap();
        database
            .rt_enqueue_turn_scoped(
                &scope,
                org,
                &untouched_thread,
                &RtTurnEnqueueInput {
                    message_id: "untouched-user".to_string(),
                    workflow_id: "untouched-workflow".to_string(),
                    task_id: untouched_thread.clone(),
                    normalized_input: json!({}),
                    user_message: json!({
                        "id": "untouched-user",
                        "role": "user",
                        "parts": [{"type": "text", "text": "do not launch"}],
                    }),
                    enqueued_at: 2,
                },
            )
            .unwrap();
        let untouched_fence = database
            .rt_thread_fence_in_scope(&scope, org, &untouched_thread)
            .unwrap()
            .unwrap();

        database
            .execute_batch_for_test(
                "CREATE TRIGGER fail_orphan_cleanup \
                 BEFORE DELETE ON native_scoped_turn_queue \
                 WHEN OLD.workflow_id = 'retryable-workflow' \
                 BEGIN SELECT RAISE(ABORT, 'fail once'); END",
            )
            .unwrap();
        let first = ensure_account_recovered(&state, &scope).await.unwrap_err();
        assert!(first.contains("left 1 orphaned turn(s) retryable"));
        let recovery_key = format!("{}\0{}", state.app_root.display(), scope.storage_key());
        assert!(!recovered_accounts().lock_ok().contains(&recovery_key));
        assert!(
            !thread_queues()
                .lock_ok()
                .contains_key(&ThreadKey::from_fence(&untouched_fence)),
            "failed recovery must not launch an unrelated queued harness"
        );
        assert!(matches!(
            database
                .rt_cancel_turn_scoped(&scope, org, &untouched_thread, "untouched-workflow",)
                .unwrap(),
            RtTurnCancelOutcome::QueuedDeleted(_)
        ));

        database
            .execute_batch_for_test("DROP TRIGGER fail_orphan_cleanup")
            .unwrap();
        ensure_account_recovered(&state, &scope).await.unwrap();
        ensure_account_recovered(&state, &scope).await.unwrap();
        assert!(database
            .rt_list_turn_queue_scoped(&scope, org, &thread_id)
            .unwrap()
            .is_empty());
        let messages = database
            .rt_list_messages_in_scope(&scope, org, &thread_id, 100, 0, false)
            .unwrap()
            .0;
        assert_eq!(
            messages
                .iter()
                .map(|message| message.role.as_str())
                .collect::<Vec<_>>(),
            ["user", "assistant"]
        );
    }

    #[tokio::test]
    async fn send_waiting_on_thread_gate_is_rejected_when_shutdown_wins() {
        let dir = tempfile::tempdir().unwrap();
        let state = test_state(dir.path());
        let scope = test_scope();
        let org = "shutdown-admission-org";
        let thread_id = "shutdown-admission-thread";
        let lifecycle_gate = thread_lifecycle_gate(&scope, org, thread_id);
        let lifecycle_guard = lifecycle_gate.lock().await;
        let body = Bytes::from(
            serde_json::to_vec(&json!({
                "messages": [{
                    "id": "must-not-enqueue",
                    "role": "user",
                    "parts": [{"type": "text", "text": "too late"}],
                }],
            }))
            .unwrap(),
        );
        let sender = {
            let state = state.clone();
            let scope = scope.clone();
            let body = body.clone();
            tokio::spawn(async move { send_message(&state, &scope, org, thread_id, &body).await })
        };
        tokio::task::yield_now().await;

        state.shutdown.begin_shutdown().await;
        drop(lifecycle_guard);
        let response = sender.await.unwrap();

        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert!(shared_db(&state)
            .unwrap()
            .rt_get_thread_in_scope(&scope, org, thread_id)
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn delayed_send_to_a_retired_thread_is_gone_and_never_enqueues() {
        let dir = tempfile::tempdir().unwrap();
        let state = test_state(dir.path());
        let scope = test_scope();
        let org = "retired-send-org";
        let thread_id = format!("retired-send-{}", uuid::Uuid::new_v4());
        let database = shared_db(&state).unwrap();
        database
            .rt_create_thread_scoped(
                &scope,
                Some(&thread_id),
                org,
                "deleted",
                None,
                "vmcp",
                None,
                &scope.user_id,
            )
            .unwrap();
        let fence = database
            .rt_thread_fence_in_scope(&scope, org, &thread_id)
            .unwrap()
            .unwrap();
        assert!(database
            .rt_delete_thread_in_org_if_generation(&fence)
            .unwrap());
        let body = Bytes::from(
            serde_json::to_vec(&json!({
                "messages": [{
                    "id": "delayed-old-message",
                    "role": "user",
                    "parts": [{"type": "text", "text": "must not resurrect"}],
                }],
            }))
            .unwrap(),
        );

        let response = send_message(&state, &scope, org, &thread_id, &body).await;

        assert_eq!(response.status(), StatusCode::GONE);
        assert!(database
            .rt_list_turn_queue_scoped(&scope, org, &thread_id)
            .unwrap()
            .is_empty());
        assert!(database
            .rt_get_thread_in_scope(&scope, org, &thread_id)
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn send_rejects_multiple_non_system_messages() {
        let dir = tempfile::tempdir().unwrap();
        let state = test_state(dir.path());
        let body = Bytes::from(
            serde_json::to_vec(&json!({
                "messages": [
                    {"role": "user", "parts": [{"type": "text", "text": "one"}]},
                    {"role": "user", "parts": [{"type": "text", "text": "two"}]},
                ],
            }))
            .unwrap(),
        );

        let response = send_message(&state, &test_scope(), "acme", "multi-user", &body).await;

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn send_rejects_assistant_only_continuation() {
        let dir = tempfile::tempdir().unwrap();
        let state = test_state(dir.path());
        let body = Bytes::from(
            serde_json::to_vec(&json!({
                "messages": [{
                    "role": "assistant",
                    "parts": [{"type": "text", "text": "continue"}],
                }],
            }))
            .unwrap(),
        );

        let response = send_message(&state, &test_scope(), "acme", "assistant-only", &body).await;

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn unrecognized_decopilot_subpaths_404_locally() {
        let dir = tempfile::tempdir().unwrap();
        let state = test_state(dir.path());
        let res = dispatch(
            &state,
            &test_scope(),
            "acme",
            &Method::GET,
            &["some", "future", "route"],
            &Bytes::new(),
        )
        .await;
        assert_eq!(res.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn send_message_rejects_a_body_with_no_user_message() {
        // Safe at the unit tier: this returns before `send_message` ever
        // reaches `harness::detect`/spawn — see this file's
        // `run_harness_and_stream`'s sibling coverage note below for why
        // the full happy path is deliberately NOT unit-tested here.
        let dir = tempfile::tempdir().unwrap();
        let state = test_state(dir.path());
        let body = Bytes::from(json!({"messages": []}).to_string());
        let res = send_message(&state, &test_scope(), "acme", "t1", &body).await;
        assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    }

    // `send_message`'s full happy path (202 + background harness spawn +
    // SSE stream + persistence) is deliberately NOT unit-tested in this
    // file: it calls `harness::detect::ensure_detected()`, which does a
    // REAL `PATH` lookup (and, absent an env override, a real `claude`/
    // `codex` subprocess probe) — on a developer machine that actually has
    // either CLI installed, a plain `cargo test` run would detect it and
    // then `harness::run::start` would spawn the REAL binary with a
    // synthetic prompt, an unpredictable (and potentially costly/hanging)
    // side effect for a unit test. This is exactly why
    // `apps/native/crates/harness`'s own module doc keeps `routes/
    // dispatch.rs`'s real-harness streaming as E2E-only (`LOCAL_API_CLAUDE_BIN`
    // pointed at the deterministic stub, spawned as a SEPARATE OS process
    // with a controlled environment) rather than unit-tested — this
    // family's real-dispatch coverage follows the same pattern: see
    // `apps/native/e2e/real-ui-interception.e2e.test.ts`.
}
