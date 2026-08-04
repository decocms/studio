use std::collections::VecDeque;
use std::io::{Read, Write};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender, TryRecvError};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Instant;

use bytes::Bytes;
use portable_pty::{native_pty_system, Child, MasterPty};
use tokio::sync::{broadcast, oneshot, watch};

#[cfg(unix)]
use uuid::Uuid;

#[cfg(unix)]
use harness::watchdog::Signal as WatchdogSignal;

use crate::replay::ReplayBuffer;
use crate::{
    CommandSpec, ManagerConfig, ReplaySnapshot, SessionEvent, SessionExit, SessionId, SessionKey,
    SessionSnapshot, SessionState, SubscriptionError, TerminalError, TerminalSize,
    TerminationPolicy,
};

type ExitCallback = Box<dyn FnOnce(&SessionId, &SessionExit) + Send + 'static>;
type OperationResult = Result<(), TerminalError>;
type OperationAck = oneshot::Sender<OperationResult>;

#[cfg(unix)]
const WATCHDOG_START_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

fn configure_interactive_terminal_environment(builder: &mut portable_pty::CommandBuilder) {
    builder.env("NO_COLOR", "1");
    builder.env("NODE_DISABLE_COLORS", "1");
    builder.env("FORCE_COLOR", "0");
    builder.env("CLICOLOR", "0");

    // A stable terminal declaration keeps color and full-screen TUI behavior
    // consistent across the user's login-shell environment.
    builder.env("TERM", "xterm-256color");
    builder.env_remove("COLORTERM");
}

enum ControlMessage {
    Resize(TerminalSize, OperationAck),
    Interrupt(OperationAck),
    BeginTerminate(OperationAck),
    ForceKill(OperationAck),
}

enum InputMessage {
    Write(Bytes, OperationAck),
    Shutdown,
}

enum InternalMessage {
    ReaderClosed,
    ReaderFailed(String),
    WriterFailed(String),
    ForceKill,
}

struct SessionCore {
    id: SessionId,
    key: SessionKey,
    pid: u32,
    process_group_id: u32,
    max_input_bytes: usize,
    control_tx: SyncSender<ControlMessage>,
    input_tx: SyncSender<InputMessage>,
    internal_tx: mpsc::Sender<InternalMessage>,
    replay: Mutex<ReplayBuffer>,
    size: Mutex<TerminalSize>,
    events: broadcast::Sender<SessionEvent>,
    state: watch::Sender<SessionState>,
}

struct ActorResources {
    child: Box<dyn Child + Send + Sync>,
    master: Box<dyn MasterPty + Send>,
    #[cfg(unix)]
    watchdog: SessionWatchdog,
    control: Receiver<ControlMessage>,
    internal: Receiver<InternalMessage>,
    input: SyncSender<InputMessage>,
    core: Arc<SessionCore>,
    config: ManagerConfig,
    on_exit: ExitCallback,
}

#[cfg(unix)]
struct SessionWatchdog {
    inner: harness::watchdog::SpawnedSessionWatchdog,
}

#[cfg(unix)]
impl SessionWatchdog {
    fn new(spawned: harness::watchdog::SpawnedSessionWatchdog) -> Self {
        Self { inner: spawned }
    }

    fn try_wait(&mut self) -> Result<Option<std::process::ExitStatus>, TerminalError> {
        self.inner
            .try_wait()
            .map_err(|error| TerminalError::Operation(error.to_string()))
    }

    fn trigger_cleanup(&mut self) {
        self.inner.trigger_cleanup();
    }

    fn abort(&mut self) -> Result<(), TerminalError> {
        let status = self
            .inner
            .abort()
            .map_err(|error| TerminalError::Operation(error.to_string()))?;
        if status.success() {
            Ok(())
        } else {
            Err(TerminalError::Operation(format!(
                "terminal crash watchdog aborted with {status}"
            )))
        }
    }

    fn finish(&mut self) -> Result<(), TerminalError> {
        let status = self
            .inner
            .wait()
            .map_err(|error| TerminalError::Operation(error.to_string()))?;
        if status.success() {
            Ok(())
        } else {
            Err(TerminalError::Operation(format!(
                "terminal crash watchdog exited with {status}"
            )))
        }
    }
}

impl SessionCore {
    fn lock_replay(&self) -> MutexGuard<'_, ReplayBuffer> {
        self.replay
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn lock_size(&self) -> MutexGuard<'_, TerminalSize> {
        self.size
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn append_output(&self, data: Bytes) {
        let chunk = self.lock_replay().append(data);
        if let Some(chunk) = chunk {
            let _ = self.events.send(SessionEvent::Output(chunk));
        }
    }

    fn replay_from(&self, offset: u64) -> ReplaySnapshot {
        self.lock_replay().snapshot_from(offset)
    }

    fn stop_output(&self) {
        self.lock_replay().stop_accepting();
    }

    fn state(&self) -> SessionState {
        self.state.borrow().clone()
    }

    fn transition(&self, state: SessionState) {
        self.state.send_replace(state.clone());
        let _ = self.events.send(SessionEvent::StateChanged(state));
    }

    fn finish(&self, exit: SessionExit) {
        self.stop_output();
        self.state.send_replace(SessionState::Exited(exit.clone()));
        let _ = self
            .events
            .send(SessionEvent::StateChanged(SessionState::Exited(
                exit.clone(),
            )));
        let _ = self.events.send(SessionEvent::Exited(exit));
    }

    fn update_size(&self, size: TerminalSize) {
        *self.lock_size() = size;
        let _ = self.events.send(SessionEvent::Resized(size));
    }

    fn snapshot(&self) -> SessionSnapshot {
        let size = *self.lock_size();
        let (available_from, next_offset) = self.lock_replay().bounds();
        SessionSnapshot {
            id: self.id.clone(),
            key: self.key.clone(),
            pid: self.pid,
            process_group_id: self.process_group_id,
            size,
            state: self.state(),
            available_from,
            next_offset,
        }
    }
}

/// Cloneable handle to one live or completed terminal session.
#[derive(Clone)]
pub struct TerminalSession {
    core: Arc<SessionCore>,
}

impl std::fmt::Debug for TerminalSession {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("TerminalSession")
            .field("id", &self.core.id)
            .field("key", &self.core.key)
            .field("pid", &self.core.pid)
            .field("state", &self.core.state())
            .finish()
    }
}

impl TerminalSession {
    pub(crate) fn spawn(
        id: SessionId,
        key: SessionKey,
        command: CommandSpec,
        initial_size: TerminalSize,
        config: ManagerConfig,
        on_exit: ExitCallback,
    ) -> Result<Self, TerminalError> {
        key.validate()?;
        validate_session_id(&id)?;
        command.validate()?;
        initial_size.validate()?;

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(initial_size.into())
            .map_err(|error| TerminalError::Spawn(safe_error(&error)))?;
        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|error| TerminalError::Spawn(safe_error(&error)))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|error| TerminalError::Spawn(safe_error(&error)))?;

        #[cfg(unix)]
        let mut startup_control = {
            let control_root = command
                .child_lifetime_lock_path()
                .and_then(std::path::Path::parent)
                .filter(|path| !path.as_os_str().is_empty())
                .map(std::path::Path::to_owned)
                .unwrap_or_else(std::env::temp_dir);
            harness::watchdog::PtySessionControl::create(startup_control_path(&control_root))
                .map_err(|error| TerminalError::Spawn(safe_error(&error)))?
        };
        #[cfg(unix)]
        let lifetime_lock = command
            .child_lifetime_lock_path()
            .map(harness::watchdog::open_shared_lifetime_lock)
            .transpose()
            .map_err(|error| TerminalError::Spawn(safe_error(&error)))?;
        #[cfg(unix)]
        let mut watchdog = SessionWatchdog::new(
            harness::watchdog::spawn_session_watchdog(
                "decocms-terminal-session-watchdog",
                &mut startup_control,
                lifetime_lock,
            )
            .map_err(|error| TerminalError::Spawn(safe_error(&error)))?,
        );
        #[cfg(unix)]
        let mut builder = startup_control.command(
            std::process::id(),
            command.program.as_os_str(),
            &command.args,
        );
        #[cfg(not(unix))]
        let mut builder = {
            let mut builder = portable_pty::CommandBuilder::new(&command.program);
            builder.args(&command.args);
            builder
        };
        if let Some(cwd) = command.cwd.as_ref() {
            builder.cwd(cwd);
        }
        for (name, value) in &command.env {
            builder.env(name, value);
        }
        configure_interactive_terminal_environment(&mut builder);

        let mut child = match pair.slave.spawn_command(builder) {
            Ok(child) => child,
            Err(error) => {
                #[cfg(unix)]
                let _ = watchdog.abort();
                return Err(TerminalError::Spawn(safe_error(&error)));
            }
        };
        drop(pair.slave);

        let Some(pid) = child.process_id() else {
            #[cfg(unix)]
            emergency_reap(&mut child, &mut watchdog);
            #[cfg(not(unix))]
            emergency_reap(&mut child);
            return Err(TerminalError::Spawn(
                "spawned terminal child did not report a process id".to_string(),
            ));
        };
        #[cfg(unix)]
        if let Err(error) =
            admit_terminal_workload(&startup_control, &mut watchdog, child.as_mut(), pid)
        {
            emergency_reap(&mut child, &mut watchdog);
            return Err(error);
        }
        let process_group_id = pid;

        let (control_tx, control_rx) = mpsc::sync_channel(config.control_queue_capacity.max(1));
        let (input_tx, input_rx) = mpsc::sync_channel(config.input_queue_capacity.max(1));
        let (internal_tx, internal_rx) = mpsc::channel();
        let (events, _) = broadcast::channel(config.broadcast_capacity.max(1));
        let (state, _) = watch::channel(SessionState::Running);
        let core = Arc::new(SessionCore {
            id,
            key,
            pid,
            process_group_id,
            max_input_bytes: config.max_input_bytes,
            control_tx,
            input_tx: input_tx.clone(),
            internal_tx: internal_tx.clone(),
            replay: Mutex::new(ReplayBuffer::new(config.replay_capacity_bytes)),
            size: Mutex::new(initial_size),
            events,
            state,
        });

        let reader_core = core.clone();
        let reader_internal = internal_tx.clone();
        if let Err(error) = std::thread::Builder::new()
            .name("studio-terminal-reader".to_string())
            .spawn(move || reader_loop(reader, &reader_core, reader_internal))
        {
            #[cfg(unix)]
            emergency_reap(&mut child, &mut watchdog);
            #[cfg(not(unix))]
            emergency_reap(&mut child);
            return Err(TerminalError::WorkerStart(error.to_string()));
        }

        let writer_core = core.clone();
        let writer_internal = internal_tx;
        if let Err(error) = std::thread::Builder::new()
            .name("studio-terminal-writer".to_string())
            .spawn(move || writer_loop(writer, input_rx, writer_internal, &writer_core))
        {
            let _ = input_tx.try_send(InputMessage::Shutdown);
            #[cfg(unix)]
            emergency_reap(&mut child, &mut watchdog);
            #[cfg(not(unix))]
            emergency_reap(&mut child);
            return Err(TerminalError::WorkerStart(error.to_string()));
        }

        // Put actor ownership behind a recoverable handoff. If the OS refuses
        // to create the actor thread, the spawning thread can take the child
        // back and synchronously reap it; moving the child directly into the
        // closure would drop (detach) it on `Builder::spawn` failure.
        let actor_resources = Arc::new(Mutex::new(Some(ActorResources {
            child,
            master: pair.master,
            #[cfg(unix)]
            watchdog,
            control: control_rx,
            internal: internal_rx,
            input: input_tx,
            core: core.clone(),
            config,
            on_exit,
        })));
        let thread_resources = actor_resources.clone();
        if let Err(error) = std::thread::Builder::new()
            .name("studio-terminal-actor".to_string())
            .spawn(move || {
                let resources = thread_resources
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .take();
                if let Some(resources) = resources {
                    actor_loop(resources);
                }
            })
        {
            // The actor owns the only race-safe signal/reap loop. If its OS
            // thread cannot start, synchronously reap before returning an
            // error so a failed start can never detach a child.
            let resources = actor_resources
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .take();
            if let Some(mut resources) = resources {
                let _ = resources.input.try_send(InputMessage::Shutdown);
                drop(resources.master);
                #[cfg(unix)]
                emergency_reap(&mut resources.child, &mut resources.watchdog);
                #[cfg(not(unix))]
                emergency_reap(&mut resources.child);
            }
            return Err(TerminalError::WorkerStart(error.to_string()));
        }

        Ok(Self { core })
    }

    pub fn id(&self) -> &str {
        &self.core.id
    }

    pub fn key(&self) -> &SessionKey {
        &self.core.key
    }

    pub fn pid(&self) -> u32 {
        self.core.pid
    }

    pub fn process_group_id(&self) -> u32 {
        self.core.process_group_id
    }

    pub fn snapshot(&self) -> SessionSnapshot {
        self.core.snapshot()
    }

    pub fn replay_from(&self, offset: u64) -> ReplaySnapshot {
        self.core.replay_from(offset)
    }

    /// Subscribe after the last exclusive byte offset the caller consumed.
    /// The subscription de-duplicates the replay/live-registration race.
    pub fn subscribe(&self, after_offset: u64) -> TerminalSubscription {
        TerminalSubscription::new(self.core.clone(), after_offset)
    }

    pub async fn write(&self, data: impl Into<Bytes>) -> Result<(), TerminalError> {
        let data = data.into();
        if data.is_empty() {
            return Ok(());
        }
        if data.len() > self.core.max_input_bytes {
            return Err(TerminalError::InputTooLarge {
                actual: data.len(),
                maximum: self.core.max_input_bytes,
            });
        }
        if !matches!(self.core.state(), SessionState::Running) {
            return Err(TerminalError::SessionClosed);
        }
        let (ack_tx, ack_rx) = oneshot::channel();
        self.core
            .input_tx
            .try_send(InputMessage::Write(data, ack_tx))
            .map_err(|error| match error {
                mpsc::TrySendError::Full(_) => TerminalError::Backpressure { channel: "input" },
                mpsc::TrySendError::Disconnected(_) => TerminalError::SessionClosed,
            })?;
        ack_rx.await.unwrap_or(Err(TerminalError::SessionClosed))
    }

    pub async fn resize(&self, size: TerminalSize) -> Result<(), TerminalError> {
        size.validate()?;
        self.control(|ack| ControlMessage::Resize(size, ack)).await
    }

    pub async fn interrupt(&self) -> Result<(), TerminalError> {
        self.control(ControlMessage::Interrupt).await
    }

    pub async fn terminate(&self, policy: TerminationPolicy) -> Result<SessionExit, TerminalError> {
        if let Some(exit) = self.core.state().exit().cloned() {
            return Ok(exit);
        }

        match self.control(ControlMessage::BeginTerminate).await {
            Ok(()) | Err(TerminalError::SessionClosed) => {}
            // Teardown must not depend on space in the user-facing control
            // queue. The internal channel is unbounded and actor-private, so
            // it remains a fail-safe when resize/interrupt traffic saturates
            // the bounded queue or graceful signaling itself fails.
            Err(_) => {
                self.force_kill_detached();
                return self.wait_for_forced_exit(policy.kill_grace).await;
            }
        }
        if let Ok(exit) = tokio::time::timeout(policy.term_grace, self.wait()).await {
            return Ok(exit);
        }

        match self.control(ControlMessage::ForceKill).await {
            Ok(()) | Err(TerminalError::SessionClosed) => {}
            Err(_) => self.force_kill_detached(),
        }
        self.wait_for_forced_exit(policy.kill_grace).await
    }

    async fn wait_for_forced_exit(
        &self,
        kill_grace: std::time::Duration,
    ) -> Result<SessionExit, TerminalError> {
        tokio::time::timeout(kill_grace, self.wait())
            .await
            .map_err(|_| TerminalError::TerminationTimeout { phase: "SIGKILL" })
    }

    pub async fn wait(&self) -> SessionExit {
        let mut state = self.core.state.subscribe();
        loop {
            if let Some(exit) = state.borrow().exit().cloned() {
                return exit;
            }
            if state.changed().await.is_err() {
                // `SessionCore` owns the sender for its entire lifetime, so a
                // closed channel without a terminal state is unreachable. Use
                // a deterministic failure rather than panic if that invariant
                // is ever broken by a refactor.
                return SessionExit {
                    code: 1,
                    signal: None,
                    requested: false,
                    output_complete: false,
                    error: Some("terminal state channel closed unexpectedly".to_string()),
                };
            }
        }
    }

    pub(crate) fn force_kill_detached(&self) {
        let _ = self.core.internal_tx.send(InternalMessage::ForceKill);
    }

    async fn control(
        &self,
        build: impl FnOnce(OperationAck) -> ControlMessage,
    ) -> Result<(), TerminalError> {
        if self.core.state().is_terminal() {
            return Err(TerminalError::SessionClosed);
        }
        let (ack_tx, ack_rx) = oneshot::channel();
        self.core
            .control_tx
            .try_send(build(ack_tx))
            .map_err(|error| match error {
                mpsc::TrySendError::Full(_) => TerminalError::Backpressure { channel: "control" },
                mpsc::TrySendError::Disconnected(_) => TerminalError::SessionClosed,
            })?;
        ack_rx.await.unwrap_or(Err(TerminalError::SessionClosed))
    }
}

#[cfg(unix)]
fn startup_control_path(root: &std::path::Path) -> std::path::PathBuf {
    root.join(format!(".decocms-terminal-watchdog-{}", Uuid::new_v4()))
}

#[cfg(unix)]
fn admit_terminal_workload(
    control: &harness::watchdog::PtySessionControl,
    watchdog: &mut SessionWatchdog,
    child: &mut dyn Child,
    expected_session_id: u32,
) -> Result<(), TerminalError> {
    let deadline = Instant::now() + WATCHDOG_START_TIMEOUT;
    loop {
        if let Some(status) = watchdog.try_wait()? {
            return Err(TerminalError::Spawn(format!(
                "terminal crash watchdog exited before PTY registration with {status}"
            )));
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                return Err(TerminalError::Spawn(format!(
                    "terminal wrapper exited before startup gate with {status:?}"
                )));
            }
            Ok(None) => {}
            Err(error) => return Err(TerminalError::Spawn(safe_error(&error))),
        }
        match control.registered_terminal_owner_pid() {
            Ok(Some(owner_pid)) if owner_pid == expected_session_id => break,
            Ok(Some(owner_pid)) => {
                return Err(TerminalError::Spawn(format!(
                    "terminal wrapper registered pid {owner_pid}, expected {expected_session_id}"
                )));
            }
            Ok(None) => {}
            Err(error) => return Err(TerminalError::Spawn(safe_error(&error))),
        }
        if Instant::now() >= deadline {
            return Err(TerminalError::Spawn(
                "terminal wrapper did not register before startup timeout".to_string(),
            ));
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }

    if let Some(status) = watchdog.try_wait()? {
        return Err(TerminalError::Spawn(format!(
            "terminal crash watchdog exited before workload release with {status}"
        )));
    }
    control
        .release()
        .map_err(|error| TerminalError::Spawn(safe_error(&error)))
}

pub(crate) fn validate_session_id(id: &str) -> Result<(), TerminalError> {
    if id.trim().is_empty() {
        return Err(TerminalError::InvalidSessionKey(
            "session id must not be empty".to_string(),
        ));
    }
    if id.len() > 4_096 {
        return Err(TerminalError::InvalidSessionKey(
            "session id exceeds 4096 bytes".to_string(),
        ));
    }
    Ok(())
}

/// Replay-aware live subscription. A slow reader first recovers from the byte
/// ring; only a reader slower than both live broadcast and retained replay sees
/// a typed [`SessionEvent::ReplayGap`].
pub struct TerminalSubscription {
    core: Arc<SessionCore>,
    receiver: broadcast::Receiver<SessionEvent>,
    pending: VecDeque<SessionEvent>,
    cursor: u64,
    exit_delivered: bool,
}

impl TerminalSubscription {
    fn new(core: Arc<SessionCore>, requested_from: u64) -> Self {
        // Subscribe first. Output racing the replay snapshot may appear in
        // both places, but absolute offsets let `normalize` discard it. Doing
        // this in the opposite order could lose output between snapshot and
        // receiver registration.
        let receiver = core.events.subscribe();
        let replay = core.replay_from(requested_from);
        let cursor = if replay.truncated {
            replay.available_from
        } else {
            requested_from.min(replay.next_offset)
        };
        let mut subscription = Self {
            core,
            receiver,
            pending: VecDeque::new(),
            cursor,
            exit_delivered: false,
        };
        subscription.enqueue_replay(replay);
        subscription
    }

    pub fn next_offset(&self) -> u64 {
        self.cursor
    }

    pub async fn recv(&mut self) -> Result<SessionEvent, SubscriptionError> {
        loop {
            if let Some(event) = self.pending.pop_front() {
                if let Some(event) = self.normalize(event) {
                    return Ok(event);
                }
                continue;
            }

            match self.receiver.try_recv() {
                Ok(event) => {
                    if let Some(event) = self.normalize_or_recover(event) {
                        return Ok(event);
                    }
                    continue;
                }
                Err(broadcast::error::TryRecvError::Lagged(_)) => {
                    self.recover();
                    continue;
                }
                Err(broadcast::error::TryRecvError::Closed) => {
                    return self.final_or_closed();
                }
                Err(broadcast::error::TryRecvError::Empty) => {}
            }

            if self.core.state().is_terminal() {
                self.recover();
                if !self.pending.is_empty() {
                    continue;
                }
                return self.final_or_closed();
            }

            match self.receiver.recv().await {
                Ok(event) => {
                    if let Some(event) = self.normalize_or_recover(event) {
                        return Ok(event);
                    }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => self.recover(),
                Err(broadcast::error::RecvError::Closed) => {
                    return self.final_or_closed();
                }
            }
        }
    }

    fn normalize_or_recover(&mut self, event: SessionEvent) -> Option<SessionEvent> {
        if let SessionEvent::Output(chunk) = &event {
            if chunk.start > self.cursor {
                self.recover();
                return None;
            }
        }
        self.normalize(event)
    }

    fn normalize(&mut self, event: SessionEvent) -> Option<SessionEvent> {
        match event {
            SessionEvent::Output(mut chunk) => {
                if chunk.end <= self.cursor {
                    return None;
                }
                if chunk.start < self.cursor {
                    let skip = usize::try_from(self.cursor - chunk.start)
                        .unwrap_or(chunk.data.len())
                        .min(chunk.data.len());
                    chunk.start = self.cursor;
                    chunk.data = chunk.data.slice(skip..);
                }
                self.cursor = chunk.end;
                Some(SessionEvent::Output(chunk))
            }
            SessionEvent::Exited(exit) => {
                if self.exit_delivered {
                    None
                } else {
                    self.exit_delivered = true;
                    Some(SessionEvent::Exited(exit))
                }
            }
            other => Some(other),
        }
    }

    fn recover(&mut self) {
        let replay = self.core.replay_from(self.cursor);
        self.enqueue_replay(replay);
    }

    fn enqueue_replay(&mut self, replay: ReplaySnapshot) {
        if replay.truncated {
            self.cursor = replay.available_from;
            self.pending.push_back(SessionEvent::ReplayGap {
                requested: replay.requested_from,
                available: replay.available_from,
                next_offset: replay.next_offset,
            });
        }
        self.pending
            .extend(replay.chunks.into_iter().map(SessionEvent::Output));
    }

    fn final_or_closed(&mut self) -> Result<SessionEvent, SubscriptionError> {
        if !self.exit_delivered {
            if let Some(exit) = self.core.state().exit().cloned() {
                self.exit_delivered = true;
                return Ok(SessionEvent::Exited(exit));
            }
        }
        Err(SubscriptionError::Closed)
    }
}

fn reader_loop(
    mut reader: Box<dyn Read + Send>,
    core: &Arc<SessionCore>,
    internal: mpsc::Sender<InternalMessage>,
) {
    let mut buffer = vec![0_u8; 16 * 1024];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) => {
                let _ = internal.send(InternalMessage::ReaderClosed);
                return;
            }
            Ok(count) => core.append_output(Bytes::copy_from_slice(&buffer[..count])),
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
            Err(error) => {
                let _ = internal.send(InternalMessage::ReaderFailed(error.to_string()));
                return;
            }
        }
    }
}

fn writer_loop(
    mut writer: Box<dyn Write + Send>,
    input: Receiver<InputMessage>,
    internal: mpsc::Sender<InternalMessage>,
    core: &SessionCore,
) {
    while let Ok(message) = input.recv() {
        match message {
            InputMessage::Write(data, ack) => match writer.write_all(&data) {
                Ok(()) => {
                    let _ = ack.send(Ok(()));
                    // A full bounded queue can reject the actor's shutdown
                    // marker. Once teardown has begun, finish at most the
                    // frame already being written and then drop the PTY fd;
                    // queued acknowledgements close with the receiver.
                    if !matches!(core.state(), SessionState::Running) {
                        return;
                    }
                }
                Err(error) => {
                    let message = error.to_string();
                    let _ = ack.send(Err(TerminalError::Operation(message.clone())));
                    let _ = internal.send(InternalMessage::WriterFailed(message));
                    return;
                }
            },
            InputMessage::Shutdown => return,
        }
    }
}

fn actor_loop(resources: ActorResources) {
    let ActorResources {
        mut child,
        master,
        #[cfg(unix)]
        mut watchdog,
        control,
        internal,
        input,
        core,
        config,
        on_exit,
    } = resources;
    let mut master = Some(master);
    let mut reader_closed = false;
    let mut reader_error: Option<String> = None;
    let mut process_error: Option<String> = None;
    let mut child_exit: Option<portable_pty::ExitStatus> = None;
    let mut drain_deadline: Option<Instant> = None;
    let mut termination_requested = false;
    let mut control_disconnected = false;

    loop {
        loop {
            match internal.try_recv() {
                Ok(InternalMessage::ReaderClosed) => reader_closed = true,
                Ok(InternalMessage::ReaderFailed(error)) => {
                    reader_closed = true;
                    reader_error.get_or_insert(error);
                    if child_exit.is_none() {
                        core.transition(SessionState::Terminating);
                        let _ = signal_child(
                            child.as_mut(),
                            master.as_deref(),
                            core.process_group_id,
                            ProcessSignal::Kill,
                        );
                    }
                }
                Ok(InternalMessage::WriterFailed(error)) => {
                    process_error.get_or_insert(format!("terminal input failed: {error}"));
                    if child_exit.is_none() {
                        core.transition(SessionState::Terminating);
                        let _ = signal_child(
                            child.as_mut(),
                            master.as_deref(),
                            core.process_group_id,
                            ProcessSignal::Kill,
                        );
                    }
                }
                Ok(InternalMessage::ForceKill) => {
                    if child_exit.is_none() {
                        termination_requested = true;
                        core.transition(SessionState::Terminating);
                        let _ = signal_child(
                            child.as_mut(),
                            master.as_deref(),
                            core.process_group_id,
                            ProcessSignal::Kill,
                        );
                    }
                }
                Err(TryRecvError::Empty | TryRecvError::Disconnected) => break,
            }
        }

        match control.recv_timeout(config.process_poll_interval) {
            Ok(message) => handle_control(
                message,
                child.as_mut(),
                master.as_deref(),
                &core,
                &mut termination_requested,
                child_exit.is_some(),
            ),
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => {
                // Manager/session handles should normally outlive the actor.
                // If every owner disappears, fail safe by terminating rather
                // than silently detaching a coding agent.
                if child_exit.is_none() && !control_disconnected {
                    control_disconnected = true;
                    termination_requested = true;
                    core.transition(SessionState::Terminating);
                    let _ = signal_child(
                        child.as_mut(),
                        master.as_deref(),
                        core.process_group_id,
                        ProcessSignal::Terminate,
                    );
                }
            }
        }

        if child_exit.is_none() {
            match child.try_wait() {
                Ok(Some(status)) => {
                    child_exit = Some(status);
                    core.transition(SessionState::Draining);
                    #[cfg(unix)]
                    if let Err(error) = watchdog.finish() {
                        process_error.get_or_insert(error.to_string());
                    }
                    let _ = input.try_send(InputMessage::Shutdown);
                    drop(master.take());
                    drain_deadline = Some(Instant::now() + config.output_drain_timeout);
                }
                Ok(None) => {}
                Err(error) => {
                    process_error.get_or_insert(format!("could not poll terminal child: {error}"));
                    #[cfg(unix)]
                    watchdog.trigger_cleanup();
                    let _ = signal_child(
                        child.as_mut(),
                        master.as_deref(),
                        core.process_group_id,
                        ProcessSignal::Kill,
                    );
                    child_exit = match child.wait() {
                        Ok(status) => Some(status),
                        Err(wait_error) => {
                            process_error.get_or_insert(format!(
                                "could not reap terminal child: {wait_error}"
                            ));
                            Some(portable_pty::ExitStatus::with_exit_code(1))
                        }
                    };
                    #[cfg(unix)]
                    if let Err(error) = watchdog.finish() {
                        process_error.get_or_insert(error.to_string());
                    }
                    core.transition(SessionState::Draining);
                    let _ = input.try_send(InputMessage::Shutdown);
                    drop(master.take());
                    drain_deadline = Some(Instant::now() + config.output_drain_timeout);
                }
            }
        }

        let drain_expired =
            !reader_closed && drain_deadline.is_some_and(|deadline| Instant::now() >= deadline);
        if child_exit.is_some() && (reader_closed || drain_expired) {
            let status = child_exit
                .take()
                .unwrap_or_else(|| portable_pty::ExitStatus::with_exit_code(1));
            let output_complete = reader_closed && reader_error.is_none() && !drain_expired;
            if drain_expired && !reader_closed {
                process_error
                    .get_or_insert("terminal output did not drain before timeout".to_string());
            }
            if let Some(reader_error) = reader_error {
                process_error.get_or_insert(format!("terminal output failed: {reader_error}"));
            }
            let exit = SessionExit {
                code: status.exit_code(),
                signal: status.signal().map(ToOwned::to_owned),
                requested: termination_requested,
                output_complete,
                error: process_error,
            };
            // Release the manager's keyed admission slot before publishing
            // the terminal state. A caller awakened by `wait()` can therefore
            // immediately start the next generation without briefly
            // re-attaching to this completed process.
            core.stop_output();
            on_exit(&core.id, &exit);
            core.finish(exit);
            return;
        }
    }
}

fn handle_control(
    message: ControlMessage,
    child: &mut dyn Child,
    master: Option<&(dyn MasterPty + Send)>,
    core: &SessionCore,
    termination_requested: &mut bool,
    child_exited: bool,
) {
    if child_exited {
        acknowledge(message, Err(TerminalError::SessionClosed));
        return;
    }
    match message {
        ControlMessage::Resize(size, ack) => {
            let result = master
                .ok_or(TerminalError::SessionClosed)
                .and_then(|master| {
                    master
                        .resize(size.into())
                        .map_err(|error| TerminalError::Operation(safe_error(&error)))
                });
            if result.is_ok() {
                core.update_size(size);
            }
            let _ = ack.send(result);
        }
        ControlMessage::Interrupt(ack) => {
            let result = signal_child(
                child,
                master,
                core.process_group_id,
                ProcessSignal::Interrupt,
            );
            let _ = ack.send(result);
        }
        ControlMessage::BeginTerminate(ack) => {
            *termination_requested = true;
            core.transition(SessionState::Terminating);
            let result = signal_child(
                child,
                master,
                core.process_group_id,
                ProcessSignal::Terminate,
            );
            let _ = ack.send(result);
        }
        ControlMessage::ForceKill(ack) => {
            *termination_requested = true;
            core.transition(SessionState::Terminating);
            let result = signal_child(child, master, core.process_group_id, ProcessSignal::Kill);
            let _ = ack.send(result);
        }
    }
}

fn acknowledge(message: ControlMessage, result: OperationResult) {
    let ack = match message {
        ControlMessage::Resize(_, ack)
        | ControlMessage::Interrupt(ack)
        | ControlMessage::BeginTerminate(ack)
        | ControlMessage::ForceKill(ack) => ack,
    };
    let _ = ack.send(result);
}

#[derive(Clone, Copy)]
enum ProcessSignal {
    Interrupt,
    Terminate,
    Kill,
}

#[cfg(unix)]
fn signal_child(
    child: &mut dyn Child,
    master: Option<&(dyn MasterPty + Send)>,
    session_id: u32,
    signal: ProcessSignal,
) -> OperationResult {
    let anchor_id = child.process_id().unwrap_or(session_id);
    let delivered = match signal {
        ProcessSignal::Interrupt => {
            // Model the terminal driver's Ctrl-C behavior: only the current
            // foreground job gets INT. When job control keeps that job in the
            // anchor group, the wrapper ignores INT while the real CLI resets
            // it to the default disposition before exec.
            //
            // Enumerate the group and signal each member by POSITIVE pid
            // rather than spelling `kill -INT -<pgid>`. A leading-`-` target is
            // not portable kill(1) argv: procps-ng reads it as a signal spec,
            // is left with an empty pid list, and signals the CALLER's own
            // process group — measured identically on procps-ng 3.3.17 (Ubuntu
            // 22.04) and 4.0.4 (Ubuntu 24.04). Spelling it that way meant
            // Ctrl-C in a Studio terminal left the foreground job running and
            // aimed SIGINT at Studio itself. BSD kill(1) accepts the negative
            // form, which is why macOS never showed it.
            //
            // `signal_non_anchor_members` is `pgrep -g` plus one kill per
            // POSITIVE pid — portable on every implementation tested, and
            // already what the Terminate and Kill arms below use.
            if let Some(group) = master.and_then(foreground_process_group) {
                harness::watchdog::signal_non_anchor_members(group, 0, WatchdogSignal::Interrupt)
            } else {
                harness::watchdog::signal_terminal_members(anchor_id, 0, WatchdogSignal::Interrupt)
            }
        }
        ProcessSignal::Terminate => {
            harness::watchdog::signal_terminal_members(anchor_id, 0, WatchdogSignal::Term)
        }
        ProcessSignal::Kill => {
            harness::watchdog::signal_terminal_members(anchor_id, 0, WatchdogSignal::Kill)
        }
    };
    if delivered {
        Ok(())
    } else {
        Err(TerminalError::Operation(
            "could not signal terminal session members".to_string(),
        ))
    }
}

#[cfg(not(unix))]
fn signal_child(
    child: &mut dyn Child,
    _master: Option<&(dyn MasterPty + Send)>,
    _base_group_id: u32,
    signal: ProcessSignal,
) -> OperationResult {
    match signal {
        ProcessSignal::Kill | ProcessSignal::Terminate => child
            .kill()
            .map_err(|error| TerminalError::Operation(error.to_string())),
        ProcessSignal::Interrupt => Err(TerminalError::Operation(
            "terminal interrupt is not implemented on this platform".to_string(),
        )),
    }
}

#[cfg(unix)]
fn foreground_process_group(master: &(dyn MasterPty + Send)) -> Option<u32> {
    master
        .process_group_leader()
        .and_then(|group| u32::try_from(group).ok())
        // kill(1) interprets group zero as the caller's own process group.
        // Never allow a failed/invalid tcgetpgrp result to target Studio.
        .filter(|group| *group > 1)
}

#[cfg(unix)]
fn emergency_reap(child: &mut Box<dyn Child + Send + Sync>, watchdog: &mut SessionWatchdog) {
    watchdog.trigger_cleanup();
    // The watcher may itself have died before admission. Never block on an
    // inert wrapper that still sees this process as its live parent; kill the
    // direct child while any surviving watcher owns descendant cleanup and
    // the shared restart fence.
    let _ = child.kill();
    let _ = child.wait();
    let _ = watchdog.finish();
}

#[cfg(not(unix))]
fn emergency_reap(child: &mut Box<dyn Child + Send + Sync>) {
    let _ = child.kill();
    let _ = child.wait();
}

fn safe_error(error: &dyn std::fmt::Display) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, Ordering};

    use super::*;

    struct SuccessfulWriter;

    #[derive(Clone, Debug)]
    struct KillRequiredChild {
        killed: Arc<AtomicBool>,
        waited_before_kill: Arc<AtomicBool>,
    }

    impl portable_pty::ChildKiller for KillRequiredChild {
        fn kill(&mut self) -> std::io::Result<()> {
            self.killed.store(true, Ordering::Release);
            Ok(())
        }

        fn clone_killer(&self) -> Box<dyn portable_pty::ChildKiller + Send + Sync> {
            Box::new(self.clone())
        }
    }

    impl Child for KillRequiredChild {
        fn try_wait(&mut self) -> std::io::Result<Option<portable_pty::ExitStatus>> {
            Ok(None)
        }

        fn wait(&mut self) -> std::io::Result<portable_pty::ExitStatus> {
            if !self.killed.load(Ordering::Acquire) {
                self.waited_before_kill.store(true, Ordering::Release);
                return Err(std::io::Error::other("wait called before kill"));
            }
            Ok(portable_pty::ExitStatus::with_signal("KILL"))
        }

        fn process_id(&self) -> Option<u32> {
            None
        }
    }

    impl Write for SuccessfulWriter {
        fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
            Ok(data.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    fn test_exit(requested: bool) -> SessionExit {
        SessionExit {
            code: 0,
            signal: None,
            requested,
            output_complete: true,
            error: None,
        }
    }

    #[test]
    fn command_debug_redacts_environment_values() {
        let command = CommandSpec::new("claude")
            .arg("--model")
            .arg("sonnet")
            .env("SECRET_COOKIE", "must-not-leak");
        let debug = format!("{command:?}");
        assert!(debug.contains("SECRET_COOKIE"));
        assert!(debug.contains("<redacted>"));
        assert!(!debug.contains("must-not-leak"));
    }

    #[test]
    fn interactive_terminal_environment_disables_color_without_losing_tui_capabilities() {
        let mut builder = portable_pty::CommandBuilder::new("agent");
        builder.env("NO_COLOR", "0");
        builder.env("NODE_DISABLE_COLORS", "0");
        builder.env("FORCE_COLOR", "1");
        builder.env("CLICOLOR", "1");
        builder.env("TERM", "dumb");
        builder.env("COLORTERM", "truecolor");

        configure_interactive_terminal_environment(&mut builder);

        assert_eq!(builder.get_env("NO_COLOR"), Some(std::ffi::OsStr::new("1")));
        assert_eq!(
            builder.get_env("NODE_DISABLE_COLORS"),
            Some(std::ffi::OsStr::new("1"))
        );
        assert_eq!(
            builder.get_env("FORCE_COLOR"),
            Some(std::ffi::OsStr::new("0"))
        );
        assert_eq!(builder.get_env("CLICOLOR"), Some(std::ffi::OsStr::new("0")));
        assert_eq!(
            builder.get_env("TERM"),
            Some(std::ffi::OsStr::new("xterm-256color"))
        );
        assert_eq!(builder.get_env("COLORTERM"), None);
    }

    #[cfg(unix)]
    #[test]
    fn failed_admission_reaps_the_wrapper_after_an_early_watchdog_exit() {
        let directory = tempfile::tempdir().expect("temporary watchdog root");
        let mut control =
            harness::watchdog::PtySessionControl::create(directory.path().join("terminal-control"))
                .expect("create terminal control");
        let spawned = harness::watchdog::spawn_session_watchdog(
            "decocms-terminal-session-early-exit-test",
            &mut control,
            None,
        )
        .expect("spawn watchdog");
        let mut watchdog = SessionWatchdog::new(spawned);
        watchdog.abort().expect("watchdog exits before admission");

        let killed = Arc::new(AtomicBool::new(false));
        let waited_before_kill = Arc::new(AtomicBool::new(false));
        let mut child: Box<dyn Child + Send + Sync> = Box::new(KillRequiredChild {
            killed: killed.clone(),
            waited_before_kill: waited_before_kill.clone(),
        });
        let started_at = Instant::now();
        emergency_reap(&mut child, &mut watchdog);

        assert!(killed.load(Ordering::Acquire), "failed wrapper was killed");
        assert!(
            !waited_before_kill.load(Ordering::Acquire),
            "admission cleanup must kill an inert wrapper before waiting"
        );
        assert!(
            started_at.elapsed() < std::time::Duration::from_secs(1),
            "an already-dead watcher must not make admission cleanup unbounded"
        );
    }

    #[tokio::test]
    async fn termination_falls_back_when_the_control_queue_is_full() {
        let (control_tx, control_rx) = mpsc::sync_channel(1);
        let (occupied_ack, _occupied_rx) = oneshot::channel();
        control_tx
            .try_send(ControlMessage::Resize(
                TerminalSize::default(),
                occupied_ack,
            ))
            .expect("test control queue must accept its first item");
        let (input_tx, _input_rx) = mpsc::sync_channel(1);
        let (internal_tx, internal_rx) = mpsc::channel();
        let (events, _) = broadcast::channel(1);
        let exit = test_exit(true);
        let (state, _) = watch::channel(SessionState::Running);
        let state_for_actor = state.clone();
        let expected_exit = exit.clone();
        let actor = std::thread::spawn(move || {
            let _control_rx = control_rx;
            assert!(matches!(internal_rx.recv(), Ok(InternalMessage::ForceKill)));
            state_for_actor.send_replace(SessionState::Exited(expected_exit));
        });
        let session = TerminalSession {
            core: Arc::new(SessionCore {
                id: "session".to_string(),
                key: SessionKey::new("account", "organization", "thread", "generation")
                    .expect("valid key"),
                pid: 1,
                process_group_id: 1,
                max_input_bytes: 1,
                control_tx,
                input_tx,
                internal_tx,
                replay: Mutex::new(ReplayBuffer::new(1)),
                size: Mutex::new(TerminalSize::default()),
                events,
                state,
            }),
        };

        let observed = session
            .terminate(TerminationPolicy {
                term_grace: std::time::Duration::from_millis(1),
                kill_grace: std::time::Duration::from_secs(1),
            })
            .await
            .expect("internal force-kill fallback must complete teardown");
        assert_eq!(observed, exit);
        actor.join().expect("test actor must not panic");
    }

    #[tokio::test]
    async fn termination_falls_back_when_graceful_signaling_fails() {
        let (control_tx, control_rx) = mpsc::sync_channel(1);
        let (input_tx, _input_rx) = mpsc::sync_channel(1);
        let (internal_tx, internal_rx) = mpsc::channel();
        let (events, _) = broadcast::channel(1);
        let exit = test_exit(true);
        let (state, _) = watch::channel(SessionState::Running);
        let state_for_actor = state.clone();
        let expected_exit = exit.clone();
        let actor = std::thread::spawn(move || {
            let message = control_rx.recv().expect("terminate control message");
            match message {
                ControlMessage::BeginTerminate(ack) => {
                    let _ = ack.send(Err(TerminalError::Operation(
                        "synthetic signal failure".to_string(),
                    )));
                }
                _ => panic!("expected graceful termination request"),
            }
            assert!(matches!(internal_rx.recv(), Ok(InternalMessage::ForceKill)));
            state_for_actor.send_replace(SessionState::Exited(expected_exit));
        });
        let session = TerminalSession {
            core: Arc::new(SessionCore {
                id: "session".to_string(),
                key: SessionKey::new("account", "organization", "thread", "generation")
                    .expect("valid key"),
                pid: 1,
                process_group_id: 1,
                max_input_bytes: 1,
                control_tx,
                input_tx,
                internal_tx,
                replay: Mutex::new(ReplayBuffer::new(1)),
                size: Mutex::new(TerminalSize::default()),
                events,
                state,
            }),
        };

        let observed = session
            .terminate(TerminationPolicy {
                term_grace: std::time::Duration::from_millis(1),
                kill_grace: std::time::Duration::from_secs(1),
            })
            .await
            .expect("signal failure must still trigger internal force-kill");
        assert_eq!(observed, exit);
        actor.join().expect("test actor must not panic");
    }

    #[test]
    fn writer_closes_after_its_current_frame_when_shutdown_marker_cannot_queue() {
        let (control_tx, _control_rx) = mpsc::sync_channel(1);
        let (input_tx, input_rx) = mpsc::sync_channel(1);
        let (internal_tx, _internal_rx) = mpsc::channel();
        let (events, _) = broadcast::channel(1);
        let (state, _) = watch::channel(SessionState::Draining);
        let core = Arc::new(SessionCore {
            id: "session".to_string(),
            key: SessionKey::new("account", "organization", "thread", "generation")
                .expect("valid key"),
            pid: 1,
            process_group_id: 1,
            max_input_bytes: 1,
            control_tx,
            input_tx: input_tx.clone(),
            internal_tx: internal_tx.clone(),
            replay: Mutex::new(ReplayBuffer::new(1)),
            size: Mutex::new(TerminalSize::default()),
            events,
            state,
        });
        let (ack_tx, ack_rx) = oneshot::channel();
        input_tx
            .try_send(InputMessage::Write(Bytes::from_static(b"x"), ack_tx))
            .expect("input queue must be full with one frame");
        assert!(matches!(
            input_tx.try_send(InputMessage::Shutdown),
            Err(mpsc::TrySendError::Full(_))
        ));
        let (done_tx, done_rx) = mpsc::channel();
        let writer_core = core.clone();
        let writer = std::thread::spawn(move || {
            writer_loop(
                Box::new(SuccessfulWriter),
                input_rx,
                internal_tx,
                &writer_core,
            );
            let _ = done_tx.send(());
        });

        assert_eq!(ack_rx.blocking_recv(), Ok(Ok(())));
        assert!(
            done_rx
                .recv_timeout(std::time::Duration::from_secs(1))
                .is_ok(),
            "writer remained blocked after session teardown"
        );
        writer.join().expect("test writer must not panic");
    }
}
