//! Interactive pseudo-terminal sessions for Studio Native.
//!
//! This crate deliberately knows nothing about HTTP, SQLite, organizations,
//! Claude Code, Codex, or OpenCode. It owns the narrow process boundary needed by those
//! layers: one controlling PTY per caller-defined [`SessionKey`], bounded
//! input/control queues, byte-exact output with absolute replay offsets, and
//! bounded process-group teardown.
//!
//! Dropping a [`TerminalSubscription`] only detaches that subscriber. A child
//! remains alive until it exits, [`TerminalSession::terminate`] is called, or
//! the owning [`TerminalSessionManager`] shuts down.

mod manager;
mod replay;
mod session;
mod types;

pub use manager::{ShutdownFailure, ShutdownReport, StartResult, TerminalSessionManager};
pub use session::{TerminalSession, TerminalSubscription};
pub use types::{
    CommandSpec, ManagerConfig, OutputChunk, ReplaySnapshot, SessionEvent, SessionExit, SessionId,
    SessionKey, SessionSnapshot, SessionState, SubscriptionError, TerminalError, TerminalSize,
    TerminationPolicy,
};
