//! Shared support for the native app's interactive coding-agent terminals.
//! Claude Code, Codex, and OpenCode run only as real PTY-backed TUIs; hosted
//! chat uses Decopilot and never enters this crate.
//!
//! ## Module map
//!
//! - [`resolve`] — binary resolution. Implements the SHARED CONTRACT env
//!   overrides (`LOCAL_API_CLAUDE_BIN` / `LOCAL_API_CODEX_BIN` /
//!   `LOCAL_API_OPENCODE_BIN`, absolute path or argv JSON array) with a PATH
//!   fallback to `claude`/`codex`/`opencode`.
//! - [`detect`] — CLI availability probing with GROW-ONLY caching, mirroring
//!   the terminal picker's semantics: a transient probe failure never
//!   un-lists a CLI that was previously detected.
//! - [`title`] — bounded provider-backed chat title generation.
//! - [`watchdog`] — the parent-liveness watchdog script and anchored
//!   process-group helpers used by PTY sessions and local background tasks.
#![forbid(unsafe_code)]

pub mod detect;
pub mod resolve;
pub mod title;
pub mod watchdog;

pub use resolve::{resolve_argv, resolve_checked, HarnessId, ResolveError};
