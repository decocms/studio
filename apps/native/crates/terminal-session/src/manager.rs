use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use tokio::sync::Notify;
use tokio::task::JoinSet;
use uuid::Uuid;

use crate::session::validate_session_id;
use crate::{
    CommandSpec, ManagerConfig, SessionExit, SessionId, SessionKey, TerminalError, TerminalSession,
    TerminalSize, TerminationPolicy,
};

#[derive(Debug, Clone)]
pub struct StartResult {
    pub session: TerminalSession,
    /// True only for the call that reserved this key and initiated its spawn.
    pub created: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShutdownFailure {
    pub key: SessionKey,
    pub session_id: Option<SessionId>,
    pub error: TerminalError,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ShutdownReport {
    pub requested: usize,
    pub stopped: Vec<SessionId>,
    pub failures: Vec<ShutdownFailure>,
}

impl ShutdownReport {
    pub fn all_stopped(&self) -> bool {
        self.failures.is_empty() && self.stopped.len() == self.requested
    }
}

#[derive(Clone)]
pub struct TerminalSessionManager {
    inner: Arc<ManagerInner>,
}

impl std::fmt::Debug for TerminalSessionManager {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let state = self.inner.lock_state();
        formatter
            .debug_struct("TerminalSessionManager")
            .field("shutting_down", &state.shutting_down)
            .field("session_slots", &state.slots.len())
            .field("starts_in_flight", &state.starts_in_flight)
            .finish()
    }
}

struct ManagerInner {
    config: ManagerConfig,
    state: Mutex<ManagerState>,
    starts_changed: Notify,
    drop_started: AtomicBool,
}

#[derive(Default)]
struct ManagerState {
    shutting_down: bool,
    starts_in_flight: usize,
    slots: HashMap<SessionKey, Arc<StartSlot>>,
}

struct StartSlot {
    slot_id: Uuid,
    requested_session_id: SessionId,
    result: Mutex<Option<Result<TerminalSession, TerminalError>>>,
    ready: Notify,
}

impl StartSlot {
    fn new(requested_session_id: SessionId) -> Self {
        Self {
            slot_id: Uuid::new_v4(),
            requested_session_id,
            result: Mutex::new(None),
            ready: Notify::new(),
        }
    }

    fn lock_result(&self) -> MutexGuard<'_, Option<Result<TerminalSession, TerminalError>>> {
        self.result
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn complete(&self, result: Result<TerminalSession, TerminalError>) {
        *self.lock_result() = Some(result);
        self.ready.notify_waiters();
    }

    fn get(&self) -> Option<Result<TerminalSession, TerminalError>> {
        self.lock_result().clone()
    }

    async fn wait(&self) -> Result<TerminalSession, TerminalError> {
        loop {
            let notified = self.ready.notified();
            if let Some(result) = self.get() {
                return result;
            }
            notified.await;
        }
    }
}

impl ManagerInner {
    fn lock_state(&self) -> MutexGuard<'_, ManagerState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn initialize(
        self: &Arc<Self>,
        key: SessionKey,
        slot: Arc<StartSlot>,
        command: CommandSpec,
        initial_size: TerminalSize,
    ) {
        let weak_manager = Arc::downgrade(self);
        let callback_key = key.clone();
        let callback_slot_id = slot.slot_id;
        let session_id = slot.requested_session_id.clone();
        let config = self.config.clone();
        let failed_key = key.clone();
        let failed_slot = slot.clone();
        let initializer = move || {
            let callback_manager = weak_manager.clone();
            let result = TerminalSession::spawn(
                session_id,
                key.clone(),
                command,
                initial_size,
                config,
                Box::new(move |_, _| {
                    if let Some(manager) = callback_manager.upgrade() {
                        manager.remove_slot(&callback_key, callback_slot_id);
                    }
                }),
            );
            slot.complete(result.clone());
            if let Some(manager) = weak_manager.upgrade() {
                manager.finish_start(&key, slot.slot_id, result.is_ok());
            }
        };

        if let Err(error) = std::thread::Builder::new()
            .name("studio-terminal-initializer".to_string())
            .spawn(initializer)
        {
            failed_slot.complete(Err(TerminalError::WorkerStart(error.to_string())));
            self.finish_start(&failed_key, failed_slot.slot_id, false);
        }
    }

    fn finish_start(&self, key: &SessionKey, slot_id: Uuid, succeeded: bool) {
        let mut state = self.lock_state();
        state.starts_in_flight = state.starts_in_flight.saturating_sub(1);
        if !succeeded
            && state
                .slots
                .get(key)
                .is_some_and(|slot| slot.slot_id == slot_id)
        {
            state.slots.remove(key);
        }
        drop(state);
        self.starts_changed.notify_waiters();
    }

    fn remove_slot(&self, key: &SessionKey, slot_id: Uuid) {
        let mut state = self.lock_state();
        if state
            .slots
            .get(key)
            .is_some_and(|slot| slot.slot_id == slot_id)
        {
            state.slots.remove(key);
        }
    }

    fn force_kill_on_drop(&self) {
        if self.drop_started.swap(true, Ordering::AcqRel) {
            return;
        }
        let sessions = self
            .lock_state()
            .slots
            .values()
            .filter_map(|slot| slot.get().and_then(Result::ok))
            .collect::<Vec<_>>();
        for session in sessions {
            session.force_kill_detached();
        }
    }
}

impl Drop for ManagerInner {
    fn drop(&mut self) {
        self.force_kill_on_drop();
    }
}

impl TerminalSessionManager {
    pub fn new(config: ManagerConfig) -> Self {
        Self {
            inner: Arc::new(ManagerInner {
                config: config.normalized(),
                state: Mutex::new(ManagerState::default()),
                starts_changed: Notify::new(),
                drop_started: AtomicBool::new(false),
            }),
        }
    }

    pub async fn start_or_attach(
        &self,
        key: SessionKey,
        command: CommandSpec,
        initial_size: TerminalSize,
    ) -> Result<StartResult, TerminalError> {
        self.start_internal(key, None, command, initial_size).await
    }

    /// Start with a persistence-owned id. If a live slot already exists, its
    /// id must match rather than silently creating a DB/process identity split.
    pub async fn start_or_attach_with_id(
        &self,
        key: SessionKey,
        session_id: SessionId,
        command: CommandSpec,
        initial_size: TerminalSize,
    ) -> Result<StartResult, TerminalError> {
        self.start_internal(key, Some(session_id), command, initial_size)
            .await
    }

    async fn start_internal(
        &self,
        key: SessionKey,
        requested_session_id: Option<SessionId>,
        command: CommandSpec,
        initial_size: TerminalSize,
    ) -> Result<StartResult, TerminalError> {
        key.validate()?;
        if let Some(session_id) = requested_session_id.as_deref() {
            validate_session_id(session_id)?;
        }
        command.validate()?;
        initial_size.validate()?;

        let (slot, created) = {
            let mut state = self.inner.lock_state();
            if state.shutting_down {
                return Err(TerminalError::ManagerShuttingDown);
            }
            if let Some(slot) = state.slots.get(&key) {
                if let Some(requested) = requested_session_id.as_ref() {
                    if &slot.requested_session_id != requested {
                        return Err(TerminalError::SessionIdConflict {
                            existing: slot.requested_session_id.clone(),
                            requested: requested.clone(),
                        });
                    }
                }
                (slot.clone(), false)
            } else {
                let session_id = requested_session_id.unwrap_or_else(|| Uuid::new_v4().to_string());
                let slot = Arc::new(StartSlot::new(session_id));
                state.slots.insert(key.clone(), slot.clone());
                state.starts_in_flight += 1;
                (slot, true)
            }
        };

        if created {
            self.inner
                .initialize(key, slot.clone(), command, initial_size);
        }
        let session = slot.wait().await?;
        Ok(StartResult { session, created })
    }

    pub fn get(&self, key: &SessionKey) -> Option<TerminalSession> {
        self.inner
            .lock_state()
            .slots
            .get(key)
            .and_then(|slot| slot.get())
            .and_then(Result::ok)
    }

    pub fn is_shutting_down(&self) -> bool {
        self.inner.lock_state().shutting_down
    }

    pub fn active_count(&self) -> usize {
        self.inner
            .lock_state()
            .slots
            .values()
            .filter(|slot| slot.get().is_some_and(|result| result.is_ok()))
            .count()
    }

    pub async fn terminate(
        &self,
        key: &SessionKey,
        policy: TerminationPolicy,
    ) -> Result<Option<SessionExit>, TerminalError> {
        let slot = self.inner.lock_state().slots.get(key).cloned();
        let Some(slot) = slot else {
            return Ok(None);
        };
        let session = slot.wait().await?;
        session.terminate(policy).await.map(Some)
    }

    pub async fn shutdown(&self, policy: TerminationPolicy) -> ShutdownReport {
        {
            let mut state = self.inner.lock_state();
            state.shutting_down = true;
        }
        self.wait_for_starts().await;

        let sessions = self
            .inner
            .lock_state()
            .slots
            .iter()
            .filter_map(|(key, slot)| {
                slot.get()
                    .and_then(Result::ok)
                    .map(|session| (key.clone(), session))
            })
            .collect::<Vec<_>>();
        let requested = sessions.len();
        let mut joins = JoinSet::new();
        for (key, session) in sessions {
            joins.spawn(async move {
                let id = session.id().to_string();
                let result = session.terminate(policy).await;
                (key, id, result)
            });
        }

        let mut report = ShutdownReport {
            requested,
            ..ShutdownReport::default()
        };
        while let Some(joined) = joins.join_next().await {
            match joined {
                Ok((_key, id, Ok(_))) => report.stopped.push(id),
                Ok((key, id, Err(error))) => report.failures.push(ShutdownFailure {
                    key,
                    session_id: Some(id),
                    error,
                }),
                Err(error) => report.failures.push(ShutdownFailure {
                    key: synthetic_shutdown_key(),
                    session_id: None,
                    error: TerminalError::Operation(format!(
                        "terminal shutdown task failed: {error}"
                    )),
                }),
            }
        }
        report.stopped.sort();
        report
    }

    async fn wait_for_starts(&self) {
        loop {
            let notified = self.inner.starts_changed.notified();
            if self.inner.lock_state().starts_in_flight == 0 {
                return;
            }
            notified.await;
        }
    }
}

impl Default for TerminalSessionManager {
    fn default() -> Self {
        Self::new(ManagerConfig::default())
    }
}

fn synthetic_shutdown_key() -> SessionKey {
    SessionKey {
        account_scope: "<shutdown-task>".to_string(),
        organization_id: "<unknown>".to_string(),
        thread_id: "<unknown>".to_string(),
        thread_generation: "<unknown>".to_string(),
    }
}
