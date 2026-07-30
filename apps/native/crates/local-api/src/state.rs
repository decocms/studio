//! `AppState` — the single struct injected into every axum handler via
//! `State<AppState>`. This is a SHARED FILE (see
//! the native module-ownership contract): family implementers read its
//! fields freely but must not add/rename/remove fields here — file an
//! interface request instead so the bootstrap owner keeps this struct
//! coherent across all 8 families.

use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use crate::config::ConfigStore;
use crate::events::Broadcaster;
use crate::sandbox::SandboxManager;
use crate::setup::SetupOrchestrator;
use crate::shutdown::ShutdownCoordinator;
use crate::tasks::TaskRegistry;

/// Desktop-app self-update integration, injected by the Tauri shell via
/// `StartOptions::update`. `None` outside the packaged shell (the standalone
/// binary, tests) — a separate axis from embedded-vs-bearer auth, because
/// embedded DEBUG builds have no updater either.
///
/// Interface note (module-ownership contract): this struct and the
/// `AppState`/`StartOptions` fields carrying it were added as ONE interface
/// change together with the `/_local/update/restart` route in `router.rs`.
#[derive(Clone)]
pub struct UpdateHooks {
    /// Version the update task has installed on disk, `None` until an
    /// install completes. Read by the `/api/config` proxy rewrite so the
    /// webview's version-drift card fires iff an update is actually staged.
    pub staged_version: tokio::sync::watch::Receiver<Option<String>>,
    /// True while a download/install cycle is running. The restart route
    /// refuses (409) while set — restarting mid-swap could re-exec a
    /// half-replaced bundle.
    pub installing: Arc<AtomicBool>,
    /// Graceful app restart (Tauri `request_restart` — delivers
    /// `ExitRequested`, so the single shutdown pipeline runs first).
    pub request_restart: Arc<dyn Fn() + Send + Sync>,
}

/// `LOCAL_API_MODE` — see `cors.rs`'s module doc for exactly what this
/// changes (origin-allowlist breadth only, never auth, never a wildcard
/// CORS header). Defaults to `Strict`, the only mode the shipped app runs
/// in; `DaemonCompat` is an opt-in convenience for the parity-oracle CI
/// job. Not part of the pinned contract doc's env table — a bootstrap
/// addition, kept intentionally narrow in effect so it can't become a
/// security opt-out by accident.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApiMode {
    Strict,
    DaemonCompat,
}

impl ApiMode {
    pub fn from_env() -> Self {
        match std::env::var("LOCAL_API_MODE").ok().as_deref() {
            Some("daemon-compat") => ApiMode::DaemonCompat,
            _ => ApiMode::Strict,
        }
    }
}

// `app_root`/`repo_dir`/`tasks`/`broadcaster` are written at boot
// (`main.rs`) but not read by anything yet — every route handler that
// would read them (fs/bash/git clamp roots, task registration, event
// emission) is still a 501 stub. Reserved fields, not dead ones; remove
// this allow once the first family reads through `State<AppState>`.
#[allow(dead_code)]
#[derive(Clone)]
pub struct AppState {
    /// The per-launch bearer token (`LOCAL_API_TOKEN` / `DAEMON_TOKEN`
    /// alias). `Arc<str>`-ish so cloning `AppState` per-request never
    /// re-allocates the token string.
    pub token: Arc<str>,
    /// `LOCAL_API_BOOT_ID` / `DAEMON_BOOT_ID` — echoed on `/health`.
    pub boot_id: Arc<str>,
    /// `LOCAL_API_WORKDIR` / `APP_ROOT` — the fs/bash/git clamp root.
    pub app_root: PathBuf,
    /// `<app_root>/repo` — default cwd for bash/git/scripts, matching the
    /// daemon's `repoDir` convention so relative paths in prompts resolve
    /// the same way.
    pub repo_dir: PathBuf,
    pub mode: ApiMode,
    pub config: Arc<ConfigStore>,
    pub tasks: Arc<TaskRegistry>,
    pub broadcaster: Arc<Broadcaster>,
    pub shutdown: Arc<ShutdownCoordinator>,
    /// The clone -> install -> start pipeline (KEPT, not dropped — see
    /// `crate::setup`'s module doc for the Phase-1-doc correction this
    /// field is part of).
    pub setup: Arc<SetupOrchestrator>,
    /// Per-handle (one full workdir per `(virtualMcpId, branch)`) git
    /// sandboxes — see `crate::sandbox`'s module doc and
    /// the native Git-sandbox contract. Orthogonal to
    /// `repo_dir`/`setup` above: a git-backed thread's harness runs in
    /// `SandboxManager::ensure(..).workdir` instead, and `routes/proxy.rs`
    /// routes a preview request by handle to the matching `Sandbox`'s own
    /// sniffed dev port. A non-git thread never touches this field — the
    /// plain `repo_dir`/`setup` path above is unchanged.
    pub sandbox_manager: Arc<SandboxManager>,
    /// See [`UpdateHooks`]. `None` outside the packaged desktop shell.
    pub update: Option<UpdateHooks>,
}
