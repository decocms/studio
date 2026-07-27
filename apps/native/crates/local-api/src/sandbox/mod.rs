//! Per-handle git-sandbox workdir manager — see
//! the native Git-sandbox contract for the target design this
//! module implements.
//!
//! `local-api` boots with exactly ONE `AppState.repo_dir`/`AppState.setup`
//! pair (the "plain" path: a user opens an already-checked-out project
//! folder, no clone involved — see `crate::setup`'s own module doc). That
//! path is UNCHANGED by this module.
//!
//! For a git-BACKED virtual MCP (a chat pinned to a `{cloneUrl, branch}`),
//! prod (`bunx decocms link`) gives every `(virtualMcpId, branch)` pair its
//! OWN full clone directory, keyed by a derived `handle` — see the design
//! doc's "Prod contract" section. [`SandboxManager`] is that same idea,
//! adapted to run in-process (no per-handle daemon subprocess, no
//! `<handle>.localhost` routing — both dropped for the reasons the design
//! doc's "Desktop adaptation" section explains): one [`Sandbox`] per handle,
//! each with its OWN `workdir`, `ConfigStore`, `TaskRegistry`, `Broadcaster`,
//! and `SetupOrchestrator` — the EXISTING clone -> install -> start pipeline
//! (`crate::setup`), just instantiated per-workdir instead of once globally.
//!
//! Callers (`routes/intercept/decopilot.rs::send_message`,
//! `routes/dispatch.rs::build_run_spec`) call [`SandboxManager::ensure`] with
//! a [`GitSandboxConfig`] derived from the dispatch payload's `sandbox`
//! block (decopilot) or `workspace.repo`/`workspace.branch` (the daemon-parity
//! dispatch family), then use the returned [`Sandbox::workdir`] as the
//! harness's spawn `cwd` instead of the single global `state.repo_dir`.
//! `routes/proxy.rs` reads a [`Sandbox`]'s own `setup`/`config` to resolve
//! the SNIFFED dev port for that specific handle (see that file's module
//! doc for the header-based routing convention).

pub mod manager;
pub mod org_mount;
pub mod org_prompt;
pub mod org_view;
pub(crate) mod persist;
pub(crate) mod registry;
pub mod repo_store;
pub mod target;

pub use manager::{GitSandboxConfig, SandboxManager};
pub use target::SandboxTarget;

/// Request header a caller sets to route a per-handle sandbox request (preview
/// proxy, tasks, scripts, setup) at a SPECIFIC git-sandbox handle instead of
/// the process-global path — see `routes/proxy.rs`'s module doc's "Dev-port
/// resolution" section and [`crate::sandbox::target`]. The TS side echoes this
/// exact header name; keep it the ONE source of truth.
pub const SANDBOX_HANDLE_HEADER: &str = "x-decocms-sandbox-handle";

/// Extracts the sandbox handle from [`SANDBOX_HANDLE_HEADER`] on a request, if
/// present and valid UTF-8 — the header-side counterpart to `events.rs`'s
/// `?handle=` query param. Empty values are treated as absent so a caller that
/// sends an empty header behaves like a headerless request.
pub fn handle_from_headers(headers: &axum::http::HeaderMap) -> Option<&str> {
    headers
        .get(SANDBOX_HANDLE_HEADER)
        .and_then(|v| v.to_str().ok())
        .filter(|s| !s.is_empty())
}
