use std::ffi::{OsStr, OsString};
use std::fmt;
use std::path::{Path, PathBuf};
use std::time::Duration;

use bytes::Bytes;
use serde::Serialize;
use thiserror::Error;

pub type SessionId = String;

/// The durable identity whose live process slot a terminal occupies.
///
/// Local API supplies the account and thread-generation fences. Keeping all
/// four values in the registry key prevents an id collision in one account or
/// organization from attaching to another user's PTY.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize)]
pub struct SessionKey {
    pub account_scope: String,
    pub organization_id: String,
    pub thread_id: String,
    pub thread_generation: String,
}

impl SessionKey {
    pub fn new(
        account_scope: impl Into<String>,
        organization_id: impl Into<String>,
        thread_id: impl Into<String>,
        thread_generation: impl Into<String>,
    ) -> Result<Self, TerminalError> {
        let key = Self {
            account_scope: account_scope.into(),
            organization_id: organization_id.into(),
            thread_id: thread_id.into(),
            thread_generation: thread_generation.into(),
        };
        key.validate()?;
        Ok(key)
    }

    pub(crate) fn validate(&self) -> Result<(), TerminalError> {
        for (name, value) in [
            ("account_scope", self.account_scope.as_str()),
            ("organization_id", self.organization_id.as_str()),
            ("thread_id", self.thread_id.as_str()),
            ("thread_generation", self.thread_generation.as_str()),
        ] {
            if value.trim().is_empty() {
                return Err(TerminalError::InvalidSessionKey(format!(
                    "{name} must not be empty"
                )));
            }
            if value.len() > 4_096 {
                return Err(TerminalError::InvalidSessionKey(format!(
                    "{name} exceeds 4096 bytes"
                )));
            }
        }
        Ok(())
    }
}

/// A command to spawn in a new controlling terminal.
///
/// Environment values are intentionally absent from `Debug`: MCP cookies and
/// provider credentials are expected to travel in this collection and must
/// never leak through diagnostics.
#[derive(Clone)]
pub struct CommandSpec {
    pub(crate) program: OsString,
    pub(crate) args: Vec<OsString>,
    pub(crate) cwd: Option<PathBuf>,
    pub(crate) env: Vec<(OsString, OsString)>,
    pub(crate) lifetime_lock_path: Option<PathBuf>,
}

impl CommandSpec {
    pub fn new(program: impl AsRef<OsStr>) -> Self {
        Self {
            program: program.as_ref().to_owned(),
            args: Vec::new(),
            cwd: None,
            env: Vec::new(),
            lifetime_lock_path: None,
        }
    }

    pub fn arg(mut self, arg: impl AsRef<OsStr>) -> Self {
        self.args.push(arg.as_ref().to_owned());
        self
    }

    pub fn args<I, S>(mut self, args: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        self.args
            .extend(args.into_iter().map(|arg| arg.as_ref().to_owned()));
        self
    }

    pub fn cwd(mut self, cwd: impl AsRef<Path>) -> Self {
        self.cwd = Some(cwd.as_ref().to_owned());
        self
    }

    pub fn env(mut self, key: impl AsRef<OsStr>, value: impl AsRef<OsStr>) -> Self {
        self.env
            .push((key.as_ref().to_owned(), value.as_ref().to_owned()));
        self
    }

    /// Shared crash-recovery fence inherited by the independent PTY
    /// watchdog. A replacement Studio process takes this file exclusively
    /// before recovering durable state, so it cannot overlap descendants of
    /// an owner that was force-quit or SIGKILLed.
    pub fn lifetime_lock_path(mut self, path: impl AsRef<Path>) -> Self {
        self.lifetime_lock_path = Some(path.as_ref().to_owned());
        self
    }

    pub fn program(&self) -> &OsStr {
        &self.program
    }

    pub fn arguments(&self) -> &[OsString] {
        &self.args
    }

    pub fn working_directory(&self) -> Option<&Path> {
        self.cwd.as_deref()
    }

    pub fn environment_keys(&self) -> impl Iterator<Item = &OsStr> {
        self.env.iter().map(|(key, _)| key.as_os_str())
    }

    pub fn child_lifetime_lock_path(&self) -> Option<&Path> {
        self.lifetime_lock_path.as_deref()
    }

    pub(crate) fn validate(&self) -> Result<(), TerminalError> {
        if self.program.is_empty() {
            return Err(TerminalError::InvalidCommand(
                "program must not be empty".to_string(),
            ));
        }
        for (key, _) in &self.env {
            if key.is_empty() {
                return Err(TerminalError::InvalidCommand(
                    "environment variable name must not be empty".to_string(),
                ));
            }
        }
        Ok(())
    }
}

impl fmt::Debug for CommandSpec {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CommandSpec")
            .field("program", &self.program)
            .field("args", &self.args)
            .field("cwd", &self.cwd)
            .field("lifetime_lock_path", &self.lifetime_lock_path)
            .field(
                "env",
                &self
                    .env
                    .iter()
                    .map(|(key, _)| (key, "<redacted>"))
                    .collect::<Vec<_>>(),
            )
            .finish()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct TerminalSize {
    pub rows: u16,
    pub cols: u16,
    pub pixel_width: u16,
    pub pixel_height: u16,
}

impl TerminalSize {
    pub const fn new(rows: u16, cols: u16) -> Self {
        Self {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        }
    }

    pub(crate) fn validate(self) -> Result<(), TerminalError> {
        if self.rows == 0 || self.cols == 0 {
            return Err(TerminalError::InvalidTerminalSize {
                rows: self.rows,
                cols: self.cols,
            });
        }
        Ok(())
    }
}

impl Default for TerminalSize {
    fn default() -> Self {
        Self::new(24, 80)
    }
}

impl From<TerminalSize> for portable_pty::PtySize {
    fn from(value: TerminalSize) -> Self {
        Self {
            rows: value.rows,
            cols: value.cols,
            pixel_width: value.pixel_width,
            pixel_height: value.pixel_height,
        }
    }
}

#[derive(Debug, Clone)]
pub struct ManagerConfig {
    /// Maximum output bytes retained for a late/reconnecting subscriber.
    pub replay_capacity_bytes: usize,
    /// Number of live events retained by Tokio's broadcast ring.
    pub broadcast_capacity: usize,
    /// Number of outstanding resize/signal commands.
    pub control_queue_capacity: usize,
    /// Number of outstanding input frames. Each is independently bounded by
    /// `max_input_bytes`.
    pub input_queue_capacity: usize,
    pub max_input_bytes: usize,
    /// How often the actor polls `Child::try_wait` while otherwise idle.
    pub process_poll_interval: Duration,
    /// Maximum time to wait for the PTY reader to drain after child exit.
    pub output_drain_timeout: Duration,
}

impl Default for ManagerConfig {
    fn default() -> Self {
        Self {
            replay_capacity_bytes: 4 * 1024 * 1024,
            broadcast_capacity: 512,
            control_queue_capacity: 64,
            input_queue_capacity: 64,
            max_input_bytes: 64 * 1024,
            process_poll_interval: Duration::from_millis(20),
            output_drain_timeout: Duration::from_secs(2),
        }
    }
}

impl ManagerConfig {
    pub(crate) fn normalized(mut self) -> Self {
        self.replay_capacity_bytes = self.replay_capacity_bytes.max(1);
        self.broadcast_capacity = self.broadcast_capacity.max(1);
        self.control_queue_capacity = self.control_queue_capacity.max(1);
        self.input_queue_capacity = self.input_queue_capacity.max(1);
        self.max_input_bytes = self.max_input_bytes.max(1);
        if self.process_poll_interval.is_zero() {
            self.process_poll_interval = Duration::from_millis(1);
        }
        if self.output_drain_timeout.is_zero() {
            self.output_drain_timeout = Duration::from_millis(1);
        }
        self
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TerminationPolicy {
    pub term_grace: Duration,
    pub kill_grace: Duration,
}

impl Default for TerminationPolicy {
    fn default() -> Self {
        Self {
            term_grace: Duration::from_secs(2),
            kill_grace: Duration::from_secs(2),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutputChunk {
    /// Inclusive absolute byte offset in the session transcript.
    pub start: u64,
    /// Exclusive absolute byte offset in the session transcript.
    pub end: u64,
    pub data: Bytes,
}

impl OutputChunk {
    pub fn is_empty(&self) -> bool {
        self.data.is_empty()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReplaySnapshot {
    pub requested_from: u64,
    pub available_from: u64,
    pub next_offset: u64,
    /// True when `requested_from` predates the retained byte window.
    pub truncated: bool,
    pub chunks: Vec<OutputChunk>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SessionExit {
    pub code: u32,
    pub signal: Option<String>,
    /// True when explicit terminate/shutdown initiated process exit.
    pub requested: bool,
    /// False only when the reader failed or exceeded the bounded drain wait.
    pub output_complete: bool,
    pub error: Option<String>,
}

impl SessionExit {
    pub fn success(&self) -> bool {
        self.signal.is_none() && self.code == 0 && self.error.is_none()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", content = "detail", rename_all = "snake_case")]
pub enum SessionState {
    Running,
    Terminating,
    Draining,
    Exited(SessionExit),
}

impl SessionState {
    pub fn exit(&self) -> Option<&SessionExit> {
        match self {
            Self::Exited(exit) => Some(exit),
            _ => None,
        }
    }

    pub fn is_terminal(&self) -> bool {
        matches!(self, Self::Exited(_))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SessionSnapshot {
    pub id: SessionId,
    pub key: SessionKey,
    pub pid: u32,
    pub process_group_id: u32,
    pub size: TerminalSize,
    pub state: SessionState,
    pub available_from: u64,
    pub next_offset: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionEvent {
    Output(OutputChunk),
    ReplayGap {
        requested: u64,
        available: u64,
        next_offset: u64,
    },
    Resized(TerminalSize),
    StateChanged(SessionState),
    Exited(SessionExit),
}

#[derive(Debug, Clone, Error, PartialEq, Eq)]
pub enum TerminalError {
    #[error("invalid session key: {0}")]
    InvalidSessionKey(String),
    #[error("invalid terminal size {rows}x{cols}; rows and columns must be non-zero")]
    InvalidTerminalSize { rows: u16, cols: u16 },
    #[error("invalid terminal command: {0}")]
    InvalidCommand(String),
    #[error("terminal manager is shutting down")]
    ManagerShuttingDown,
    #[error("live terminal owns session id {existing}, not requested id {requested}")]
    SessionIdConflict {
        existing: SessionId,
        requested: SessionId,
    },
    #[error("could not spawn terminal: {0}")]
    Spawn(String),
    #[error("could not start terminal worker: {0}")]
    WorkerStart(String),
    #[error("terminal session has exited")]
    SessionClosed,
    #[error("terminal {channel} queue is full")]
    Backpressure { channel: &'static str },
    #[error("terminal input frame is {actual} bytes; maximum is {maximum}")]
    InputTooLarge { actual: usize, maximum: usize },
    #[error("terminal operation failed: {0}")]
    Operation(String),
    #[error("terminal did not exit within {phase} grace period")]
    TerminationTimeout { phase: &'static str },
}

#[derive(Debug, Clone, Error, PartialEq, Eq)]
pub enum SubscriptionError {
    #[error("terminal subscription closed before a terminal exit event")]
    Closed,
}
