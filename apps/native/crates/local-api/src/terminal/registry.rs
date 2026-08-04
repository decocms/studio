//! Process-local ownership for interactive coding-agent terminals.

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use harness::HarnessId;
use rand::RngCore;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use terminal_session::{
    ManagerConfig, SessionExit, SessionKey, TerminalSession, TerminalSessionManager,
    TerminationPolicy,
};
use tokio::sync::{watch, Mutex as AsyncMutex, Notify, OwnedMutexGuard};

use crate::routes::threads::db::{RtThreadFence, ThreadsDb};

const TERM_GRACE: Duration = Duration::from_secs(2);
const KILL_GRACE: Duration = Duration::from_secs(2);
const PROMPT_RECEIPT_CAPACITY: usize = 512;
const PREPARATION_QUIESCE_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Default)]
struct OpenCodeTurnState {
    active: Option<u64>,
    busy_observed: bool,
    completed: u64,
}

#[derive(Clone)]
pub struct HookRegistration {
    token: Arc<str>,
    mcp_token: Arc<str>,
    mcp_path: Arc<str>,
    pub fence: RtThreadFence,
    pub terminal_session_id: String,
    pub harness: HarnessId,
    pub cwd: PathBuf,
    pub title_environment: harness::title::TitleEnvironment,
    title_started: Arc<AtomicBool>,
    expected_provider_session_id: Option<Arc<str>>,
    opencode_turn: Arc<Mutex<OpenCodeTurnState>>,
}

pub(crate) struct HookReservation {
    pub fence: RtThreadFence,
    pub terminal_session_id: String,
    pub harness: HarnessId,
    pub cwd: PathBuf,
    pub token: String,
    pub mcp_token: String,
    pub mcp_path: String,
    pub title_environment: harness::title::TitleEnvironment,
    pub expected_provider_session_id: Option<String>,
}

impl std::fmt::Debug for HookRegistration {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("HookRegistration")
            .field("fence", &self.fence)
            .field("terminal_session_id", &self.terminal_session_id)
            .field("harness", &self.harness)
            .field("cwd", &self.cwd)
            .finish_non_exhaustive()
    }
}

impl HookRegistration {
    pub fn authorizes(&self, candidate: &str) -> bool {
        let expected = self.token.as_bytes();
        let candidate = candidate.as_bytes();
        expected.len() == candidate.len() && bool::from(expected.ct_eq(candidate))
    }

    fn authorizes_mcp(&self, path: &str, candidate: &str) -> bool {
        if path != self.mcp_path.as_ref() {
            return false;
        }
        let expected = self.mcp_token.as_bytes();
        let candidate = candidate.as_bytes();
        expected.len() == candidate.len() && bool::from(expected.ct_eq(candidate))
    }

    pub fn claim_title(&self) -> bool {
        !self.title_started.swap(true, Ordering::AcqRel)
    }

    pub fn release_title_claim(&self) {
        self.title_started.store(false, Ordering::Release);
    }

    pub fn expected_provider_session_id(&self) -> Option<&str> {
        self.expected_provider_session_id.as_deref()
    }

    fn lock_opencode_turn(&self) -> MutexGuard<'_, OpenCodeTurnState> {
        self.opencode_turn
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Admit one provider busy event per stable plugin turn id. Re-delivery
    /// after a lost HTTP response is idempotent, while a newer turn supersedes
    /// an older one whose terminal event never arrived.
    pub fn observe_opencode_busy(&self, turn_id: u64) -> bool {
        if turn_id == 0 {
            return false;
        }
        let mut state = self.lock_opencode_turn();
        if turn_id <= state.completed || state.active.is_some_and(|active| active > turn_id) {
            return false;
        }
        if state.active == Some(turn_id) && state.busy_observed {
            return false;
        }
        state.active = Some(turn_id);
        state.busy_observed = true;
        true
    }

    /// Admit a permission/question event for the active turn. This can recover
    /// state when its preceding busy delivery was lost.
    pub fn observe_opencode_active(&self, turn_id: u64) -> bool {
        if turn_id == 0 {
            return false;
        }
        let mut state = self.lock_opencode_turn();
        if turn_id <= state.completed || state.active.is_some_and(|active| active > turn_id) {
            return false;
        }
        if state.active != Some(turn_id) {
            state.active = Some(turn_id);
            state.busy_observed = false;
        }
        true
    }

    /// Re-open a busy admission when its durable transition failed so the
    /// plugin's identical delivery retry is not mistaken for a duplicate.
    pub fn restore_opencode_busy(&self, turn_id: u64) {
        let mut state = self.lock_opencode_turn();
        if state.active == Some(turn_id) {
            state.busy_observed = false;
        }
    }

    /// Complete exactly one stable plugin turn. A terminal delivery can recover
    /// a lost busy request, and retrying after an applied-but-lost response is a
    /// no-op. A stale terminal cannot finish a newer active turn.
    pub fn finish_opencode_turn(&self, turn_id: u64) -> bool {
        if turn_id == 0 {
            return false;
        }
        let mut state = self.lock_opencode_turn();
        if turn_id <= state.completed || state.active.is_some_and(|active| active > turn_id) {
            return false;
        }
        state.completed = turn_id;
        state.active = None;
        state.busy_observed = false;
        true
    }

    /// Re-open a just-consumed terminal admission when its durable state
    /// transition failed, so the plugin's identical retry can apply it.
    pub fn restore_opencode_turn(&self, turn_id: u64) {
        let mut state = self.lock_opencode_turn();
        if turn_id > 0 && state.completed == turn_id {
            state.completed = turn_id - 1;
            state.active = Some(turn_id);
            state.busy_observed = true;
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PromptRequestStatus {
    New,
    Duplicate,
    Conflict,
}

#[derive(Debug)]
struct PromptReceipt {
    request_id: String,
    prompt_digest: [u8; 32],
}

#[derive(Debug, Default)]
pub(crate) struct PromptLedger {
    accepted: VecDeque<PromptReceipt>,
}

impl PromptLedger {
    pub fn status(&self, request_id: &str, prompt: &str) -> PromptRequestStatus {
        let Some(receipt) = self
            .accepted
            .iter()
            .find(|receipt| receipt.request_id == request_id)
        else {
            return PromptRequestStatus::New;
        };
        if receipt.prompt_digest == prompt_digest(prompt) {
            PromptRequestStatus::Duplicate
        } else {
            PromptRequestStatus::Conflict
        }
    }

    pub fn remember(&mut self, request_id: &str, prompt: &str) {
        debug_assert_eq!(self.status(request_id, prompt), PromptRequestStatus::New);
        if self.accepted.len() == PROMPT_RECEIPT_CAPACITY {
            self.accepted.pop_front();
        }
        self.accepted.push_back(PromptReceipt {
            request_id: request_id.to_string(),
            prompt_digest: prompt_digest(prompt),
        });
    }
}

fn prompt_digest(prompt: &str) -> [u8; 32] {
    Sha256::digest(prompt.as_bytes()).into()
}

#[derive(Clone)]
pub struct ManagedTerminal {
    pub session: TerminalSession,
    pub hook: Arc<HookRegistration>,
    prompt_ledger: Arc<AsyncMutex<PromptLedger>>,
    writer_lease: Arc<WriterLease>,
}

impl ManagedTerminal {
    pub(crate) async fn lock_prompt_ledger(&self) -> OwnedMutexGuard<PromptLedger> {
        self.prompt_ledger.clone().lock_owned().await
    }

    pub(crate) async fn claim_writer_lease(&self) -> Result<WriterLeaseGuard, &'static str> {
        self.writer_lease.clone().claim().await
    }
}

#[derive(Debug, Default)]
struct WriterLease {
    next_generation: AtomicU64,
    current_generation: AtomicU64,
    mutation_gate: Arc<AsyncMutex<()>>,
}

impl WriterLease {
    async fn claim(self: Arc<Self>) -> Result<WriterLeaseGuard, &'static str> {
        // A replacement cannot become authoritative in the middle of an old
        // writer's frame. Once this lock is acquired, every earlier mutation
        // is complete and all later stale frames fail their generation check.
        let _gate = self.mutation_gate.clone().lock_owned().await;
        let generation = self
            .next_generation
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |current| {
                current.checked_add(1)
            })
            .map_err(|_| "terminal writer lease generation is exhausted")?
            + 1;
        self.current_generation.store(generation, Ordering::Release);
        Ok(WriterLeaseGuard {
            lease: self,
            generation,
        })
    }
}

pub(crate) struct WriterLeaseGuard {
    lease: Arc<WriterLease>,
    generation: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct PreparationKey {
    fence: RtThreadFence,
    terminal_session_id: String,
}

#[derive(Debug, Default)]
struct PreparationPhaseState {
    cancelled: bool,
    active_phases: usize,
}

#[derive(Debug)]
struct PreparationState {
    phase: Mutex<PreparationPhaseState>,
    cancellation: watch::Sender<bool>,
    phase_changed: Notify,
}

impl PreparationState {
    fn new() -> Arc<Self> {
        let (cancellation, _) = watch::channel(false);
        Arc::new(Self {
            phase: Mutex::new(PreparationPhaseState::default()),
            cancellation,
            phase_changed: Notify::new(),
        })
    }

    fn lock_phase(&self) -> MutexGuard<'_, PreparationPhaseState> {
        self.phase
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn cancel(&self) {
        let changed = {
            let mut phase = self.lock_phase();
            if phase.cancelled {
                false
            } else {
                phase.cancelled = true;
                true
            }
        };
        if changed {
            self.cancellation.send_replace(true);
            self.phase_changed.notify_waiters();
        }
    }

    fn is_cancelled(&self) -> bool {
        self.lock_phase().cancelled
    }

    fn begin_phase(self: &Arc<Self>) -> Option<PreparationPhase> {
        let mut phase = self.lock_phase();
        if phase.cancelled {
            return None;
        }
        phase.active_phases += 1;
        drop(phase);
        Some(PreparationPhase {
            state: self.clone(),
        })
    }

    async fn wait_for_phase_completion(&self) {
        self.wait_for_phase_completion_with(|| {}).await;
    }

    async fn wait_for_phase_completion_with<F>(&self, mut after_check: F)
    where
        F: FnMut(),
    {
        let changed = self.phase_changed.notified();
        tokio::pin!(changed);
        loop {
            // `notify_waiters` does not retain a permit for a future waiter.
            // Register this waiter before inspecting the phase count so a
            // phase that completes between the check and `.await` cannot be
            // missed.
            changed.as_mut().enable();
            let complete = self.lock_phase().active_phases == 0;
            after_check();
            if complete {
                return;
            }
            changed.as_mut().await;
            changed.set(self.phase_changed.notified());
        }
    }
}

#[derive(Clone)]
pub(crate) struct PreparationCancellation {
    state: Arc<PreparationState>,
}

impl PreparationCancellation {
    pub(crate) fn is_cancelled(&self) -> bool {
        self.state.is_cancelled()
    }

    pub(crate) async fn cancelled(&self) {
        let mut cancellation = self.state.cancellation.subscribe();
        if *cancellation.borrow() {
            return;
        }
        while cancellation.changed().await.is_ok() {
            if *cancellation.borrow() {
                return;
            }
        }
    }

    pub(crate) fn subscribe(&self) -> watch::Receiver<bool> {
        self.state.cancellation.subscribe()
    }

    #[cfg(test)]
    pub(crate) fn test_uncancelled() -> Self {
        Self {
            state: PreparationState::new(),
        }
    }
}

pub(crate) struct PreparationPhase {
    state: Arc<PreparationState>,
}

impl PreparationPhase {
    pub(crate) fn cancellation(&self) -> PreparationCancellation {
        PreparationCancellation {
            state: self.state.clone(),
        }
    }
}

impl Drop for PreparationPhase {
    fn drop(&mut self) {
        let mut phase = self.state.lock_phase();
        debug_assert!(phase.active_phases > 0);
        phase.active_phases = phase.active_phases.saturating_sub(1);
        let complete = phase.active_phases == 0;
        drop(phase);
        if complete {
            self.state.phase_changed.notify_waiters();
        }
    }
}

pub(crate) struct PreparationBarrier {
    preparations: Vec<(PreparationKey, Arc<PreparationState>)>,
}

impl PreparationBarrier {
    pub(crate) fn had_preparations(&self) -> bool {
        !self.preparations.is_empty()
    }

    pub(crate) fn fences(&self) -> Vec<RtThreadFence> {
        let mut fences = Vec::new();
        for (key, _) in &self.preparations {
            if !fences.contains(&key.fence) {
                fences.push(key.fence.clone());
            }
        }
        fences
    }

    pub(crate) async fn wait(&self) -> Result<(), String> {
        self.wait_for(PREPARATION_QUIESCE_TIMEOUT).await
    }

    async fn wait_for(&self, timeout: Duration) -> Result<(), String> {
        let wait = futures::future::join_all(
            self.preparations
                .iter()
                .map(|(_, state)| state.wait_for_phase_completion()),
        );
        tokio::time::timeout(timeout, wait)
            .await
            .map(|_| ())
            .map_err(|_| {
                "coding agent preparation did not stop within 15 seconds after cancellation"
                    .to_string()
            })
    }
}

/// Process-local proof that an exact durable `starting` row is still being
/// prepared by this app instance. Durable rows without this proof are stale
/// restart debris and may be self-healed by the next start request.
pub(crate) struct PreparationReservation {
    registry: Arc<AgentSessionRegistry>,
    key: PreparationKey,
    state: Arc<PreparationState>,
}

impl PreparationReservation {
    pub(crate) fn is_active(&self) -> bool {
        if self.state.is_cancelled() {
            return false;
        }
        self.registry
            .lock_preparations()
            .get(&self.key)
            .is_some_and(|state| Arc::ptr_eq(state, &self.state))
    }

    pub(crate) fn begin_phase(&self) -> Option<PreparationPhase> {
        self.state.begin_phase()
    }
}

impl Drop for PreparationReservation {
    fn drop(&mut self) {
        // Aborting or panicking the spawn owner must wake any manager-owned
        // preparation it was awaiting. Publish the explicit cancellation
        // before the last sender can disappear instead of making every
        // receiver infer owner loss from channel closure.
        self.state.cancel();
        let mut preparations = self.registry.lock_preparations();
        if preparations
            .get(&self.key)
            .is_some_and(|state| Arc::ptr_eq(state, &self.state))
        {
            preparations.remove(&self.key);
        }
    }
}

impl WriterLeaseGuard {
    /// Lock the mutation boundary and prove this attachment still owns input.
    /// Holding the returned guard across the PTY/DB operation prevents a new
    /// attachment from claiming ownership halfway through the frame.
    pub(crate) async fn mutation_permit(&self) -> Option<OwnedMutexGuard<()>> {
        let permit = self.lease.mutation_gate.clone().lock_owned().await;
        (self.lease.current_generation.load(Ordering::Acquire) == self.generation).then_some(permit)
    }

    #[cfg(test)]
    fn is_current(&self) -> bool {
        self.lease.current_generation.load(Ordering::Acquire) == self.generation
    }
}

impl Drop for WriterLeaseGuard {
    fn drop(&mut self) {
        // A stale socket must never clear the newer socket's ownership.
        let _ = self.lease.current_generation.compare_exchange(
            self.generation,
            0,
            Ordering::AcqRel,
            Ordering::Acquire,
        );
    }
}

pub struct AgentSessionRegistry {
    manager: TerminalSessionManager,
    sessions: Mutex<HashMap<RtThreadFence, ManagedTerminal>>,
    hooks: Mutex<HashMap<String, Arc<HookRegistration>>>,
    preparations: Mutex<HashMap<PreparationKey, Arc<PreparationState>>>,
    start_locks: Mutex<HashMap<RtThreadFence, Arc<AsyncMutex<()>>>>,
    codex_home_locks: Mutex<HashMap<String, Arc<AsyncMutex<()>>>>,
    claude_state_locks: Mutex<HashMap<PathBuf, Arc<AsyncMutex<()>>>>,
    lifecycle: tokio::sync::broadcast::Sender<RtThreadFence>,
}

impl std::fmt::Debug for AgentSessionRegistry {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("AgentSessionRegistry")
            .field("manager", &self.manager)
            .field("sessions", &self.lock_sessions().len())
            .finish()
    }
}

impl AgentSessionRegistry {
    pub fn new() -> Arc<Self> {
        let (lifecycle, _) = tokio::sync::broadcast::channel(256);
        Arc::new(Self {
            manager: TerminalSessionManager::new(ManagerConfig::default()),
            sessions: Mutex::new(HashMap::new()),
            hooks: Mutex::new(HashMap::new()),
            preparations: Mutex::new(HashMap::new()),
            start_locks: Mutex::new(HashMap::new()),
            codex_home_locks: Mutex::new(HashMap::new()),
            claude_state_locks: Mutex::new(HashMap::new()),
            lifecycle,
        })
    }

    fn lock_sessions(&self) -> MutexGuard<'_, HashMap<RtThreadFence, ManagedTerminal>> {
        self.sessions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn lock_hooks(&self) -> MutexGuard<'_, HashMap<String, Arc<HookRegistration>>> {
        self.hooks
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn lock_preparations(&self) -> MutexGuard<'_, HashMap<PreparationKey, Arc<PreparationState>>> {
        self.preparations
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    pub fn manager(&self) -> &TerminalSessionManager {
        &self.manager
    }

    pub fn start_lock(&self, fence: &RtThreadFence) -> Arc<AsyncMutex<()>> {
        self.start_locks
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .entry(fence.clone())
            .or_insert_with(|| Arc::new(AsyncMutex::new(())))
            .clone()
    }

    /// Serializes initialization and managed-profile writes in the one Codex
    /// home shared by every chat for an authenticated Studio account.
    pub fn codex_home_lock(&self, account_scope: &str) -> Arc<AsyncMutex<()>> {
        self.codex_home_locks
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .entry(account_scope.to_string())
            .or_insert_with(|| Arc::new(AsyncMutex::new(())))
            .clone()
    }

    /// Serializes read-merge-replace updates to the Claude state file shared
    /// by otherwise independent chats and Studio accounts.
    pub fn claude_state_lock(&self, state_path: &std::path::Path) -> Arc<AsyncMutex<()>> {
        self.claude_state_locks
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .entry(state_path.to_path_buf())
            .or_insert_with(|| Arc::new(AsyncMutex::new(())))
            .clone()
    }

    pub fn session_key(
        fence: &RtThreadFence,
    ) -> Result<SessionKey, terminal_session::TerminalError> {
        SessionKey::new(
            fence.account_scope.clone(),
            fence.organization_id.clone(),
            fence.thread_id.clone(),
            fence.generation.clone(),
        )
    }

    pub fn get(&self, fence: &RtThreadFence) -> Option<ManagedTerminal> {
        self.lock_sessions().get(fence).cloned()
    }

    pub(crate) fn reserve_preparation(
        self: &Arc<Self>,
        fence: RtThreadFence,
        terminal_session_id: String,
    ) -> Option<PreparationReservation> {
        let key = PreparationKey {
            fence,
            terminal_session_id,
        };
        let state = PreparationState::new();
        let mut preparations = self.lock_preparations();
        if preparations.contains_key(&key) {
            return None;
        }
        preparations.insert(key.clone(), state.clone());
        drop(preparations);
        Some(PreparationReservation {
            registry: self.clone(),
            key,
            state,
        })
    }

    pub(crate) fn is_preparing(&self, fence: &RtThreadFence, terminal_session_id: &str) -> bool {
        self.lock_preparations()
            .get(&PreparationKey {
                fence: fence.clone(),
                terminal_session_id: terminal_session_id.to_string(),
            })
            .is_some_and(|state| !state.is_cancelled())
    }

    pub(crate) fn cancel_preparation(&self, fence: &RtThreadFence) -> PreparationBarrier {
        let preparations = self
            .lock_preparations()
            .iter()
            .filter(|(key, _)| key.fence == *fence)
            .map(|(key, state)| (key.clone(), state.clone()))
            .collect::<Vec<_>>();
        for (_, state) in &preparations {
            state.cancel();
        }
        PreparationBarrier { preparations }
    }

    pub(crate) fn cancel_all_preparations(&self) -> PreparationBarrier {
        let preparations = self
            .lock_preparations()
            .iter()
            .map(|(key, state)| (key.clone(), state.clone()))
            .collect::<Vec<_>>();
        for (_, state) in &preparations {
            state.cancel();
        }
        PreparationBarrier { preparations }
    }

    pub fn hook(&self, terminal_session_id: &str) -> Option<Arc<HookRegistration>> {
        self.lock_hooks().get(terminal_session_id).cloned()
    }

    /// Whether one live terminal capability authorizes exactly this MCP path.
    /// Every registered token is compared so the matching entry's position
    /// does not become a token oracle. Paths are public and may short-circuit
    /// inside the registration.
    pub fn authorizes_mcp(&self, path: &str, candidate: &str) -> bool {
        self.lock_hooks().values().fold(false, |authorized, hook| {
            hook.authorizes_mcp(path, candidate) | authorized
        })
    }

    pub fn subscribe_lifecycle(&self) -> tokio::sync::broadcast::Receiver<RtThreadFence> {
        self.lifecycle.subscribe()
    }

    pub fn notify_lifecycle(&self, fence: &RtThreadFence) {
        let _ = self.lifecycle.send(fence.clone());
    }

    pub(crate) fn reserve_hook(&self, reservation: HookReservation) -> Arc<HookRegistration> {
        let HookReservation {
            fence,
            terminal_session_id,
            harness,
            cwd,
            token,
            mcp_token,
            mcp_path,
            title_environment,
            expected_provider_session_id,
        } = reservation;
        let hook = Arc::new(HookRegistration {
            token: token.into(),
            mcp_token: mcp_token.into(),
            mcp_path: mcp_path.into(),
            fence,
            terminal_session_id: terminal_session_id.clone(),
            harness,
            cwd,
            title_environment,
            title_started: Arc::new(AtomicBool::new(false)),
            expected_provider_session_id: expected_provider_session_id.map(Arc::from),
            opencode_turn: Arc::new(Mutex::new(OpenCodeTurnState::default())),
        });
        self.lock_hooks().insert(terminal_session_id, hook.clone());
        hook
    }

    pub fn unregister_hook(&self, terminal_session_id: &str) {
        self.lock_hooks().remove(terminal_session_id);
    }

    pub fn register_terminal(
        self: &Arc<Self>,
        db: &'static ThreadsDb,
        fence: RtThreadFence,
        session: TerminalSession,
        hook: Arc<HookRegistration>,
    ) -> ManagedTerminal {
        let session_id = session.id().to_string();
        let managed = ManagedTerminal {
            session: session.clone(),
            hook,
            prompt_ledger: Arc::new(AsyncMutex::new(PromptLedger::default())),
            writer_lease: Arc::new(WriterLease::default()),
        };
        self.lock_sessions().insert(fence.clone(), managed.clone());
        self.notify_lifecycle(&fence);

        let registry = Arc::downgrade(self);
        tokio::spawn(async move {
            let exit = session.wait().await;
            if let Err(error) = super::lifecycle::mark_exited(
                db,
                &fence,
                &session_id,
                i32::try_from(exit.code).ok(),
                exit.requested,
                exit.error.as_deref(),
            ) {
                tracing::warn!(%error, terminal_session_id = %session_id, "could not persist terminal exit");
            }
            if let Some(registry) = registry.upgrade() {
                registry.notify_lifecycle(&fence);
                registry.remove_if_current(&fence, &session_id);
            }
        });
        managed
    }

    fn remove_if_current(&self, fence: &RtThreadFence, terminal_session_id: &str) {
        let mut sessions = self.lock_sessions();
        if sessions
            .get(fence)
            .is_some_and(|managed| managed.session.id() == terminal_session_id)
        {
            sessions.remove(fence);
        }
        drop(sessions);
        self.unregister_hook(terminal_session_id);
    }

    pub async fn terminate_fence(
        &self,
        fence: &RtThreadFence,
    ) -> Result<Option<SessionExit>, terminal_session::TerminalError> {
        let key = Self::session_key(fence)?;
        self.manager.terminate(&key, termination_policy()).await
    }

    /// Forget process-local bookkeeping after the fenced parent thread has
    /// been durably deleted. Any waiter already holding the start lock keeps
    /// its `Arc` and will fail its subsequent fenced database read.
    pub fn forget_fence(&self, fence: &RtThreadFence) {
        if let Some(managed) = self.lock_sessions().remove(fence) {
            self.unregister_hook(managed.session.id());
        }
        self.lock_hooks().retain(|_, hook| hook.fence != *fence);
        let barrier = self.cancel_preparation(fence);
        self.lock_preparations()
            .retain(|preparation, _| preparation.fence != *fence);
        drop(barrier);
        self.start_locks
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(fence);
    }

    pub async fn shutdown(&self) -> terminal_session::ShutdownReport {
        let barrier = self.cancel_all_preparations();
        if let Err(error) = barrier.wait().await {
            tracing::error!(%error, "coding agent preparation did not quiesce before shutdown");
        }
        self.manager.shutdown(termination_policy()).await
    }

    /// Reap all current terminals without closing future admission. Logout
    /// and account switching use this; app shutdown uses [`Self::shutdown`].
    pub async fn terminate_all(&self) -> Vec<String> {
        let barrier = self.cancel_all_preparations();
        let preparation_failure = barrier.wait().await.err();
        let mut failures = self.terminate_active_sessions().await;
        if let Some(error) = preparation_failure {
            failures.push(error);
        }
        failures
    }

    /// Reap registered PTYs after the caller has already canceled and awaited
    /// its preparation barrier. Account transitions use this to keep the
    /// cancellation wait single and bounded while still stopping older live
    /// terminals when a preparation itself fails to quiesce.
    pub(crate) async fn terminate_active_sessions(&self) -> Vec<String> {
        let sessions = self
            .lock_sessions()
            .values()
            .map(|managed| managed.session.clone())
            .collect::<Vec<_>>();
        futures::future::join_all(sessions.into_iter().map(|session| async move {
            let id = session.id().to_string();
            session
                .terminate(termination_policy())
                .await
                .err()
                .map(|error| format!("{id}: {error}"))
        }))
        .await
        .into_iter()
        .flatten()
        .collect()
    }

    pub fn active_count(&self) -> usize {
        self.manager.active_count()
    }
}

pub fn generate_hook_token() -> String {
    generate_terminal_token()
}

pub fn generate_mcp_token() -> String {
    generate_terminal_token()
}

fn generate_terminal_token() -> String {
    let mut bytes = [0_u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    bytes
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>()
}

pub fn termination_policy() -> TerminationPolicy {
    TerminationPolicy {
        term_grace: TERM_GRACE,
        kill_grace: KILL_GRACE,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hook_tokens_are_random_fixed_length_hex() {
        let first = generate_hook_token();
        let second = generate_mcp_token();
        assert_eq!(first.len(), 64);
        assert!(first.chars().all(|character| character.is_ascii_hexdigit()));
        assert_ne!(first, second);
    }

    #[test]
    fn hook_authorization_requires_the_complete_token() {
        let hook = HookRegistration {
            token: Arc::from("0123456789abcdef"),
            mcp_token: Arc::from("fedcba9876543210"),
            mcp_path: Arc::from("/api/org/mcp/selected"),
            fence: RtThreadFence {
                account_scope: "account".to_string(),
                organization_id: "org".to_string(),
                thread_id: "thread".to_string(),
                generation: "generation".to_string(),
            },
            terminal_session_id: "session".to_string(),
            harness: HarnessId::Codex,
            cwd: PathBuf::from("/tmp"),
            title_environment: harness::title::TitleEnvironment::default(),
            title_started: Arc::new(AtomicBool::new(false)),
            expected_provider_session_id: None,
            opencode_turn: Arc::new(Mutex::new(OpenCodeTurnState::default())),
        };
        assert!(hook.authorizes("0123456789abcdef"));
        assert!(!hook.authorizes("0123456789abcdee"));
        assert!(!hook.authorizes("0123456789abcdef-extra"));
        assert!(hook.authorizes_mcp("/api/org/mcp/selected", "fedcba9876543210"));
        assert!(!hook.authorizes_mcp("/api/org/mcp/other", "fedcba9876543210"));
        assert!(!hook.authorizes_mcp("/api/org/mcp/selected", "0123456789abcdef"));
        assert!(!hook.authorizes("fedcba9876543210"));
    }

    #[test]
    fn opencode_turn_ids_recover_lost_delivery_and_dedupe_retries() {
        let hook = HookRegistration {
            token: Arc::from("hook"),
            mcp_token: Arc::from("mcp"),
            mcp_path: Arc::from("/mcp"),
            fence: RtThreadFence {
                account_scope: "account".to_string(),
                organization_id: "org".to_string(),
                thread_id: "thread".to_string(),
                generation: "generation".to_string(),
            },
            terminal_session_id: "session".to_string(),
            harness: HarnessId::OpenCode,
            cwd: PathBuf::from("/tmp"),
            title_environment: harness::title::TitleEnvironment::default(),
            title_started: Arc::new(AtomicBool::new(false)),
            expected_provider_session_id: Some(Arc::from("ses_resume")),
            opencode_turn: Arc::new(Mutex::new(OpenCodeTurnState::default())),
        };

        assert_eq!(hook.expected_provider_session_id(), Some("ses_resume"));
        assert!(hook.observe_opencode_busy(1));
        assert!(!hook.observe_opencode_busy(1));
        hook.restore_opencode_busy(1);
        assert!(hook.observe_opencode_busy(1));
        assert!(hook.finish_opencode_turn(1));
        assert!(!hook.finish_opencode_turn(1));
        assert!(!hook.observe_opencode_busy(1));

        // A terminal envelope can recover when both busy HTTP attempts were
        // lost. If the terminal response itself is lost, restoring its claim
        // lets the identical plugin retry apply exactly once.
        assert!(hook.finish_opencode_turn(2));
        hook.restore_opencode_turn(2);
        assert!(hook.finish_opencode_turn(2));
        assert!(!hook.finish_opencode_turn(2));

        assert!(hook.observe_opencode_busy(4));
        assert!(!hook.finish_opencode_turn(3));
        assert!(hook.finish_opencode_turn(4));
    }

    #[test]
    fn prompt_receipts_dedupe_reconnects_and_reject_id_reuse() {
        let mut ledger = PromptLedger::default();
        assert_eq!(
            ledger.status("request-1", "first"),
            PromptRequestStatus::New
        );
        ledger.remember("request-1", "first");
        assert_eq!(
            ledger.status("request-1", "first"),
            PromptRequestStatus::Duplicate
        );
        assert_eq!(
            ledger.status("request-1", "different"),
            PromptRequestStatus::Conflict
        );
        assert_eq!(
            ledger.status("request-2", "first"),
            PromptRequestStatus::New
        );
    }

    #[tokio::test]
    async fn newest_writer_wins_without_stale_drop_clearing_it() {
        let lease = Arc::new(WriterLease::default());
        let first = lease.clone().claim().await.unwrap();
        assert!(first.is_current());

        let in_flight = first.mutation_permit().await.unwrap();
        let replacement = tokio::spawn({
            let lease = lease.clone();
            async move { lease.claim().await.unwrap() }
        });
        tokio::task::yield_now().await;
        assert!(!replacement.is_finished());

        drop(in_flight);
        let second = replacement.await.unwrap();
        assert!(!first.is_current());
        assert!(second.is_current());
        assert!(first.mutation_permit().await.is_none());

        drop(first);
        assert!(second.is_current());
        assert!(second.mutation_permit().await.is_some());
        drop(second);
        assert_eq!(lease.current_generation.load(Ordering::Acquire), 0);
    }

    #[tokio::test]
    async fn preparation_barrier_cannot_miss_phase_completion_after_its_check() {
        let state = PreparationState::new();
        let phase = state.begin_phase().expect("phase should begin");
        state.cancel();
        let mut phase = Some(phase);

        // Complete the phase in the exact interval that used to lose a
        // `notify_waiters` wakeup: after the waiter observed a non-zero phase
        // count but before it first awaited the notification.
        tokio::time::timeout(
            Duration::from_secs(1),
            state.wait_for_phase_completion_with(|| drop(phase.take())),
        )
        .await
        .expect("registered waiter must observe phase completion");
        assert!(phase.is_none());
    }

    #[tokio::test]
    async fn timed_out_preparation_barrier_can_be_rechecked_before_artifact_cleanup() {
        let registry = AgentSessionRegistry::new();
        let fence = RtThreadFence {
            account_scope: "account".to_string(),
            organization_id: "org".to_string(),
            thread_id: "thread".to_string(),
            generation: "generation".to_string(),
        };
        let reservation = registry
            .reserve_preparation(fence.clone(), "terminal".to_string())
            .unwrap();
        let phase = reservation.begin_phase().unwrap();
        let barrier = registry.cancel_preparation(&fence);

        assert!(barrier.wait_for(Duration::ZERO).await.is_err());
        drop(phase);
        barrier.wait_for(Duration::from_secs(1)).await.unwrap();
        drop(reservation);
    }

    #[tokio::test]
    async fn dropping_preparation_reservation_publishes_cancellation() {
        let registry = AgentSessionRegistry::new();
        let fence = RtThreadFence {
            account_scope: "account".to_string(),
            organization_id: "org".to_string(),
            thread_id: "thread".to_string(),
            generation: "generation".to_string(),
        };
        let reservation = registry
            .reserve_preparation(fence.clone(), "terminal".to_string())
            .unwrap();
        let mut cancellation = reservation.state.cancellation.subscribe();

        drop(reservation);

        tokio::time::timeout(Duration::from_secs(1), cancellation.changed())
            .await
            .expect("reservation drop must wake the preparation owner")
            .expect("the cancellation sender remains observable");
        assert!(*cancellation.borrow());
        assert!(!registry.is_preparing(&fence, "terminal"));
    }
}
