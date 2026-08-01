//! `local-api` as a library — the in-process embedding entrypoint the
//! Tauri shell (`apps/native/src-tauri/`) links against directly (no
//! subprocess — see the desktop migration contract's "in-process
//! axum, no sidecar" decision and the native implementation contract §5). This
//! file is a MECHANICAL EXTRACTION of the boot sequence that used to live
//! entirely in `main.rs`'s `fn main()`: every side effect (dir creation,
//! `AppState` construction, router build, listener bind) is byte-for-byte
//! unchanged, just reachable
//! from a function signature instead of only from a binary's entrypoint.
//! `main.rs` now calls into [`boot_from_env`] for exactly what its old
//! `main()` body did — the daemon-parity and local-api contract e2e
//! suites (which only ever observe the compiled `local-api` binary's
//! externally-visible behavior: env vars in, stdout/HTTP/SIGTERM out)
//! should see zero behavior change from this refactor.
//!
//! Added per the Phase 3 (Tauri shell) brief's explicit license: "you MAY
//! add a small pub entrypoint to crates/local-api ... keep it a
//! mechanical extraction." Two entrypoints:
//!
//! - [`boot_from_env`] — used by the `local-api` BINARY's `main()`. Reads
//!   the full env contract (`LOCAL_API_TOKEN`/`_PORT`/`_WORKDIR`/
//!   `_BOOT_ID` + legacy `DAEMON_*`/`APP_ROOT`/`PROXY_PORT` aliases),
//!   prints the `LOCAL_API_PORT=`/`LOCAL_API_PREVIEW_PORT=`/`LOCAL_API_TOKEN=`
//!   stdout lines a test harness may discover, and serves until SIGTERM
//!   (unix) / Ctrl+C (non-unix). Behaviorally identical to the old `main()`
//!   body, plus the new preview-port line.
//! - [`start`] — used by the Tauri shell. Takes an explicit
//!   [`StartOptions`] (no env vars, no stdout side effects — the shell
//!   already knows its own per-launch token/port/workdir), binds BOTH the
//!   main and preview listeners (the "port router" — see [`ServerHandle`]'s
//!   doc comment), builds each router, spawns both serve loops in the
//!   background, and returns a [`ServerHandle`] the caller drives: read
//!   `.port()`/`.preview_port()`/`.state()`, and call `.shutdown()` on
//!   window-close/app-exit. Does NOT install its own SIGTERM handler — the
//!   embedding app owns its own process lifecycle (see
//!   `src-tauri/src/local_api_embed.rs`).
//!
//! Shutdown is an explicit ordered pipeline: stop listener admission; close
//! request/setup admission; reap chat harnesses; concurrently TERM→KILL and
//! join every global/per-sandbox process owner; perform one final awaited
//! registry sweep; then join (or abort+join) both axum tasks. The app-root
//! instance lock remains held until those joins complete. There is NO git
//! publish on shutdown — local worktrees are durable and are reused as-is on
//! the next launch (see `routes/git.rs`'s "No publish on shutdown" section).

mod auth;
mod auth_fence;
mod client_auth;
mod config;
mod cors;
mod error;
mod events;
mod fs_util;
mod http_util;
mod log_store;
mod mutation;
mod process_group;
mod process_util;
mod router;
mod routes;
mod sandbox;
mod setup;
mod shutdown;
mod state;
mod tasks;
mod terminal;
mod time_util;
mod ui;

// Re-exported so `AppState`'s public fields name types reachable from
// outside this crate (Rust's `private_interfaces` lint would otherwise
// fire on a `pub` struct field whose type lives in a `mod` that isn't
// itself `pub` — these modules stay private; only the specific types an
// embedder needs are named here).
pub use auth_fence::{install_upstream_session, logout_upstream_session, AccountInstallError};
pub use config::ConfigStore;
pub use events::Broadcaster;
pub use sandbox::SandboxManager;
pub use setup::SetupOrchestrator;
pub use shutdown::ShutdownCoordinator;
pub use state::{ApiMode, AppState, UpdateHooks};
pub use tasks::{KillSignal, TaskRegistry};
pub use terminal::AgentSessionRegistry;
pub use ui::{UiAsset, UiAssetProvider};

use std::fs::File;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use tokio::net::TcpListener;
use tokio::sync::Notify;

/// Explicit boot parameters for [`start`] — the Tauri-shell embedding
/// path. Unlike [`boot_from_env`], nothing here is read from process env;
/// the caller (the shell) already resolved its own per-launch
/// token/port/root before calling in.
pub struct StartOptions {
    pub token: String,
    pub boot_id: String,
    /// `LOCAL_API_WORKDIR` equivalent — the fs/bash/git clamp root and the
    /// parent of the `.decocms/` local thread-store directory.
    pub app_root: PathBuf,
    /// TCP port to bind; `0` picks an OS-assigned ephemeral port (read
    /// back via [`ServerHandle::port`]).
    pub port: u16,
    pub mode: ApiMode,
    /// PEM certificate + key for local HTTPS, or `None` to serve plain HTTP.
    ///
    /// The desktop app needs its origin to be a real domain (per-sandbox
    /// cookie jars) AND a secure context (Web Crypto); only TLS gives both.
    /// Standalone/bearer callers and the tests keep plain HTTP.
    pub tls: Option<TlsFiles>,
    /// Desktop-app self-update integration — see [`UpdateHooks`]. `None`
    /// outside the packaged Tauri shell (standalone binary, tests).
    pub update: Option<UpdateHooks>,
}

/// Paths to the material [`start`] serves HTTPS with.
#[derive(Clone, Debug)]
pub struct TlsFiles {
    pub cert: PathBuf,
    pub key: PathBuf,
    /// The root `cert` chains to. Not served — handed to spawned CLI children
    /// (`NODE_EXTRA_CA_CERTS`) whose runtimes read neither the macOS keychain
    /// nor Mozilla's roots, so they can verify this process's own listener.
    pub ca: PathBuf,
}

/// Browser-facing authentication and optional bundled-UI configuration for an
/// in-process Tauri server. `expected_host` and `control_origin` are explicit
/// because development traffic can arrive through Vite (`:4420`) while Rust
/// itself listens on another port (`:43121`).
pub struct EmbeddedOptions {
    pub expected_host: String,
    pub control_origin: String,
    /// The authority the Rust listener itself answers on, when the browser
    /// reaches this server through a proxy on a DIFFERENT port (dev: Vite on
    /// `:4420` in front of `:43121`). Accepted as an additional `Host`, and
    /// preferred for the local subprocesses — `rclone` and the agent harness'
    /// MCP — which have no reason to route their loopback traffic through the
    /// browser's dev server. `None` when the two are the same, as in release.
    pub listener_host: Option<String>,
    /// Extra one-time capabilities for additional windows. `StartOptions.token`
    /// is always included as the first bootstrap secret.
    pub additional_bootstrap_secrets: Vec<String>,
    pub ui_assets: Option<Arc<dyn UiAssetProvider>>,
    /// Mounts the credentialed preview-cookie round-trip probe used by the
    /// real WKWebView boot smoke. Disabled by default and never controlled by
    /// an HTTP query parameter or other runtime request input.
    pub preview_cookie_selftest: bool,
}

impl EmbeddedOptions {
    pub fn new(expected_host: impl Into<String>, control_origin: impl Into<String>) -> Self {
        Self {
            expected_host: expected_host.into(),
            control_origin: control_origin.into(),
            listener_host: None,
            additional_bootstrap_secrets: Vec::new(),
            ui_assets: None,
            preview_cookie_selftest: false,
        }
    }
}

/// Selects the caller-auth contract without weakening the existing standalone
/// binary. The `local-api` executable and [`start`] remain bearer-only.
pub enum ClientAuthMode {
    Bearer,
    Embedded(EmbeddedOptions),
}

/// Boot-time failure from [`start`]. Deliberately NOT a process-exit call
/// (unlike the binary's [`boot_from_env`]) — an embedder like the Tauri
/// shell must be able to surface this as a UI error rather than have the
/// whole app process die.
#[derive(Debug, thiserror::Error)]
pub enum StartError {
    #[error("failed to load local TLS material {path:?}: {source}")]
    Tls {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("failed to create repo dir {path:?}: {source}")]
    RepoDir {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("failed to create {path:?}: {source}")]
    DecocmsDir {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("another local-api instance already owns {path:?}: {source}")]
    InstanceLock {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("prior local-api children did not release {path:?}: {source}")]
    ChildLifetimeFence {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("failed to recover filesystem mutations under {path:?}: {source}")]
    MutationRecovery {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("failed to bind 127.0.0.1:{port}: {source}")]
    Bind {
        port: u16,
        #[source]
        source: std::io::Error,
    },
    #[error("failed to recover the local chat store: {message}")]
    LocalStore { message: String },
    #[error("invalid embedded client-auth configuration: {message}")]
    EmbeddedAuth { message: String },
}

/// A running server the caller owns the lifecycle of. TWO listeners run
/// under one `ServerHandle` — see the module doc's port-router summary and
/// `router.rs`'s module doc for the exact route split:
///
/// - the MAIN listener ([`ServerHandle::port`]) — `/health`, `/_sandbox/*`,
///   `/threads*`, `/models`, and the app-API intercept-or-proxy fallback
///   (bearer + Origin gated).
/// - the PREVIEW listener ([`ServerHandle::preview_port`]) — ONLY the
///   reverse-proxy-to-dev-server fallback (`routes::proxy::fallback`), no
///   auth at all. Moved to its own loopback port (rather than sharing the
///   main port behind a `/upstream`-style prefix) so the previewed app runs
///   on a genuinely separate origin from the app's own API — verified via a
///   spike that SSE + WebSocket both stream cleanly through a port-isolated
///   cross-origin iframe in the real WKWebView, unlike the `*.localhost`
///   subdomain approach.
///
/// Each listener's serve loop runs on its own `tokio::spawn`'d task; dropping
/// a `ServerHandle` WITHOUT calling [`ServerHandle::shutdown`] leaves both
/// tasks running detached (nothing calls `abort()` on drop by design). An
/// unclean process exit, e.g. `SIGKILL`, bypasses every local cleanup step;
/// harnesses have their own parent-death watchdog, but callers must use
/// `shutdown()` for the complete ordered reap/drain contract.
pub struct ServerHandle {
    port: u16,
    preview_port: u16,
    state: AppState,
    shutdown_notify: Arc<Notify>,
    preview_shutdown_notify: Arc<Notify>,
    serve_task: tokio::task::JoinHandle<()>,
    preview_serve_task: tokio::task::JoinHandle<()>,
    /// Non-coalescing upstream identity events reap account-scoped PTYs even
    /// when the signed-out transition originated in background revalidation.
    auth_reaper_task: tokio::task::JoinHandle<()>,
    /// Kernel-held advisory lock for this app root. The file handle—not a
    /// stale PID marker—is the lifetime fence: a second process cannot run
    /// queue recovery against live harness work, and the OS releases it even
    /// after SIGKILL. Graceful shutdown releases it only after every mutation
    /// and process owner proves quiescence; on a failed proof the handle is
    /// intentionally retained until OS process exit instead of permitting an
    /// unsafe same-root restart.
    _instance_lock: Arc<File>,
}

/// How long `shutdown()` waits for in-flight connections to drain before
/// abandoning the wait and letting the process exit. The frontend's
/// long-lived `/_sandbox/events` SSE stream never completes on its own — it
/// ends only when the webview is torn down, which is AFTER we return — so an
/// unbounded wait deadlocks app quit.
/// The ONE local SQLite file, at the top of the app root.
///
/// Threads/chat history and the sandbox registry share it: two databases were
/// two files, two WALs and two version stories for one process's local state.
/// `PRAGMA user_version` belongs to the threads migration ladder; the sandbox
/// registry versions itself through its own `sandbox_metadata` table, so the
/// two subsystems never fight over the header field.
/// The control-cookie value, stable across launches for one app-data dir.
///
/// Deliberately NOT per-launch. The desktop dev loop restarts the backend on
/// every rebuild, and a fresh token invalidated the HttpOnly cookie the live
/// webview still held — so every request 401'd (including `/_auth/status`,
/// which is why the shell showed no sandboxes and the preview iframe never
/// opened) and nothing recovered, because the frontend bootstraps once at
/// module init. A stable token makes a backend restart invisible to a page
/// that is already open, which is how any ordinary web session behaves.
///
/// Stored 0600 beside the other local-api state. This is no weaker than what
/// already lives there: the same directory holds the OAuth refresh token and
/// the TLS CA key, and both are readable by any process running as this user.
/// A rotation is one `rm` away.
/// The per-launch credential for the org-filesystem WebDAV surface — see
/// [`client_auth::ClientAuth::mount_token`].
///
/// NOT persisted, unlike the session token: nothing holds it across a restart
/// (mounts are respawned every launch), so the shortest possible lifetime is
/// free. Two v4 UUIDs — the same source `boot_id` uses, and well past the
/// entropy a loopback credential needs.
fn generate_mount_token() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

fn stable_session_token(app_root: &Path) -> String {
    let path = app_root.join(".decocms").join("session-token");
    if let Ok(existing) = std::fs::read_to_string(&path) {
        let existing = existing.trim();
        if !existing.is_empty() {
            return existing.to_string();
        }
    }
    let minted = generate_token();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    // Created 0600 rather than written-then-chmod'ed: the window between the
    // two is exactly when another local process could read it.
    let write = || -> std::io::Result<()> {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        use std::io::Write;
        options.open(&path)?.write_all(minted.as_bytes())
    };
    if let Err(error) = write() {
        tracing::warn!(%error, "could not persist the local session token; it will not survive a restart");
    }
    minted
}

pub(crate) const STUDIO_DB_FILE_NAME: &str = "studio.db";

/// Busy timeout for every connection to the ONE shared `studio.db` file.
///
/// Two independent connections open it — the threads store
/// (`routes/threads/db.rs`) and the sandbox registry (`sandbox/registry.rs`).
/// They contend for the same write lock, so a timeout typed once per opener
/// is a drift channel: whichever side ends up with the shorter value surfaces
/// spurious "database is locked" errors under exactly the load the longer
/// side was tuned to ride out.
pub(crate) const SQLITE_BUSY_TIMEOUT: Duration = Duration::from_secs(5);

/// The app-wide child-lifetime fence every spawned child anchors to — the
/// shared lock the boot-time recovery fence waits on and the watchdogs that
/// reap children of a dead parent hold. One path, derived one way, so a
/// spawn family can never anchor to a fence nobody is watching.
pub(crate) fn shared_child_lifetime_lock_path(app_root: &std::path::Path) -> std::path::PathBuf {
    app_root.join(".decocms").join("child-lifetime.lock")
}

const SHUTDOWN_DRAIN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);
const HARNESS_REAP_TIMEOUT: Duration = Duration::from_secs(5);
const FS_MUTATION_REAP_TIMEOUT: Duration = Duration::from_secs(3);
const CHILD_TERM_GRACE: Duration = Duration::from_secs(2);
const CHILD_KILL_GRACE: Duration = Duration::from_secs(2);
/// Parent-death watchdogs normally finish in roughly one second. Keep startup
/// bounded while allowing generous scheduler/CI slack; expiration fails boot
/// closed instead of recovering durable work beside an indeterminate old
/// child.
const CHILD_CRASH_REAP_TIMEOUT: Duration = Duration::from_secs(15);

impl ServerHandle {
    pub fn port(&self) -> u16 {
        self.port
    }

    /// The dedicated loopback port serving ONLY the dev-server reverse
    /// proxy — see this struct's doc comment. A caller (the Tauri shell, an
    /// e2e harness) points a preview iframe/request at
    /// `http://localhost:<preview_port>/`, never at [`Self::port`].
    pub fn preview_port(&self) -> u16 {
        self.preview_port
    }

    pub fn state(&self) -> &AppState {
        &self.state
    }

    /// Graceful shutdown. Consumes `self` because each listener task and the
    /// app-root lock have one lifecycle owner.
    pub async fn shutdown(self) {
        let ServerHandle {
            state,
            shutdown_notify,
            preview_shutdown_notify,
            mut serve_task,
            mut preview_serve_task,
            auth_reaper_task,
            _instance_lock,
            ..
        } = self;

        // Listener shutdown is phase zero: stop accepting HTTP immediately.
        // Long-lived responses (notably events SSE) are allowed a bounded
        // drain at the end and forcibly closed if they outlive it.
        shutdown_notify.notify_one();
        preview_shutdown_notify.notify_one();
        auth_reaper_task.abort();
        let _ = auth_reaper_task.await;

        // Close every source of new side-effecting work before taking any
        // process snapshot. The coordinator waits for already-admitted
        // spawn+registry critical sections; setup closes are synchronous.
        let admission_fence = state.shutdown.begin_shutdown();
        let mutations = state.shutdown.mutations();
        let mutation_fence = mutations.begin_shutdown(FS_MUTATION_REAP_TIMEOUT);
        state.setup.close();
        state.sandbox_manager.begin_shutdown();
        let ((), mutation_quiescence) = tokio::join!(admission_fence, mutation_fence);
        if !mutation_quiescence.is_quiescent() {
            tracing::error!(
                owners_remaining = mutation_quiescence.owners_remaining,
                commit_quiescent = mutation_quiescence.commit_quiescent,
                "shutdown: filesystem mutation owners did not quiesce"
            );
        }

        // Chat harnesses own process state outside TaskRegistry. Reap both
        // families concurrently before setup/git can observe their worktrees.
        let (terminal_report, dispatch_stopped) = tokio::join!(
            state.agent_sessions.shutdown(),
            routes::dispatch::shutdown_all(HARNESS_REAP_TIMEOUT),
        );
        if !terminal_report.all_stopped() {
            tracing::error!(
                failures = terminal_report.failures.len(),
                "shutdown: one or more interactive coding agents did not stop cleanly"
            );
        }
        if !dispatch_stopped {
            tracing::error!("shutdown: one or more legacy dispatches did not stop in time");
        }

        // Each setup shutdown internally snapshots once, signals every child
        // concurrently, waits one shared TERM grace, then escalates the
        // remaining subset under one shared KILL grace. Global and all
        // per-sandbox registries run concurrently too.
        let (global_setup, sandbox_setups) = tokio::join!(
            state.setup.shutdown(CHILD_TERM_GRACE, CHILD_KILL_GRACE),
            state
                .sandbox_manager
                .shutdown_all(CHILD_TERM_GRACE, CHILD_KILL_GRACE),
        );
        let global_setup_stopped =
            global_setup.worker_stopped && global_setup.tasks.remaining.is_empty();
        if !global_setup_stopped {
            tracing::error!(
                remaining = ?global_setup.tasks.remaining,
                worker_stopped = global_setup.worker_stopped,
                "shutdown: global setup did not fully stop"
            );
        }
        let mut sandbox_setups_stopped = true;
        for sandbox in &sandbox_setups {
            if !sandbox.result.tasks.remaining.is_empty() || !sandbox.result.worker_stopped {
                sandbox_setups_stopped = false;
                tracing::error!(
                    handle = %sandbox.handle,
                    remaining = ?sandbox.result.tasks.remaining,
                    worker_stopped = sandbox.result.worker_stopped,
                    "shutdown: sandbox setup did not fully stop"
                );
            }
        }

        // Defense-in-depth for global, non-setup request tasks: admission is
        // already closed, so this final snapshot is complete and awaited.
        // There is deliberately NO git publish here: local worktrees are
        // durable and are reused as-is on the next launch (see
        // `routes/git.rs`'s "No publish on shutdown" module-doc section), so
        // close never blocks on a network push.
        let final_tasks = state
            .tasks
            .kill_all_and_wait(CHILD_TERM_GRACE, CHILD_KILL_GRACE)
            .await;
        let final_tasks_stopped = final_tasks.remaining.is_empty();
        if !final_tasks_stopped {
            tracing::error!(
                remaining = ?final_tasks.remaining,
                "shutdown: global task registry did not fully stop"
            );
        }

        let process_tree_quiescent = terminal_report.all_stopped()
            && dispatch_stopped
            && global_setup_stopped
            && sandbox_setups_stopped
            && final_tasks_stopped
            && mutation_quiescence.is_quiescent();

        // `with_graceful_shutdown` waits for every in-flight response. The
        // events SSE stream can intentionally live forever, so poll each
        // JoinHandle until one shared deadline and remember which handles
        // completed. A JoinHandle that already returned Ready MUST NOT be
        // polled again (Tokio panics); this explicit loop avoids the former
        // `timeout(join!(...))` bug where one listener completed, the other
        // timed out, and cleanup awaited the completed handle a second time.
        let drain_deadline = tokio::time::Instant::now() + SHUTDOWN_DRAIN_TIMEOUT;
        let mut serve_done = false;
        let mut preview_done = false;
        while !serve_done || !preview_done {
            tokio::select! {
                _ = &mut serve_task, if !serve_done => serve_done = true,
                _ = &mut preview_serve_task, if !preview_done => preview_done = true,
                _ = tokio::time::sleep_until(drain_deadline) => break,
            }
        }
        if !serve_done || !preview_done {
            tracing::warn!(
                "shutdown: graceful drain exceeded {SHUTDOWN_DRAIN_TIMEOUT:?} \
                 (long-lived stream still open) — aborting serve tasks"
            );
            if !serve_done {
                serve_task.abort();
                let _ = serve_task.await;
            }
            if !preview_done {
                preview_serve_task.abort();
                let _ = preview_serve_task.await;
            }
        }

        // Explicitly last: serve tasks also held clones and have now been
        // joined. Release the app-root fence only when every side-effecting
        // owner proved quiescence. If a cancellation-resistant owner remains,
        // retain this final Arc until OS process exit: graceful shutdown stays
        // bounded, but another server in this process cannot acquire the same
        // root and race the old owner. The OS still closes the descriptor on
        // normal exit, SIGTERM escalation, or SIGKILL.
        if process_tree_quiescent {
            drop(_instance_lock);
        } else {
            tracing::error!(
                "shutdown: retaining app-root lock until process exit because owner quiescence was not proven"
            );
            std::mem::forget(_instance_lock);
        }
    }
}

/// Builds `AppState`, the router, binds the listener, and spawns the
/// server in the background.
pub async fn start(opts: StartOptions) -> Result<ServerHandle, StartError> {
    start_with_client_auth(opts, ClientAuthMode::Bearer).await
}

/// Embedded counterpart to [`start`]. The standalone/binary path never calls
/// this and therefore keeps its byte-compatible bearer contract.
pub async fn start_embedded(
    opts: StartOptions,
    embedded: EmbeddedOptions,
) -> Result<ServerHandle, StartError> {
    start_with_client_auth(opts, ClientAuthMode::Embedded(embedded)).await
}

pub async fn start_with_client_auth(
    opts: StartOptions,
    client_auth_mode: ClientAuthMode,
) -> Result<ServerHandle, StartError> {
    let (client_auth, ui_assets, preview_cookie_selftest_origin) = match client_auth_mode {
        ClientAuthMode::Bearer => (
            client_auth::ClientAuth::bearer(Arc::<str>::from(opts.token.clone())),
            None,
            None,
        ),
        ClientAuthMode::Embedded(embedded) => {
            let preview_cookie_selftest_origin = embedded
                .preview_cookie_selftest
                .then(|| Arc::<str>::from(embedded.control_origin.clone()));
            let mut bootstrap_secrets =
                Vec::with_capacity(embedded.additional_bootstrap_secrets.len() + 1);
            bootstrap_secrets.push(opts.token.clone());
            bootstrap_secrets.extend(embedded.additional_bootstrap_secrets);
            let expected_host = embedded.expected_host.clone();
            // rclone talks to local-api as a plain HTTP client, so it needs the
            // same scheme the listeners actually serve.
            let control_scheme = if embedded.control_origin.starts_with("https://") {
                "https"
            } else {
                "http"
            };
            let control_origin = embedded.control_origin.clone();
            // Loopback subprocesses address the Rust listener DIRECTLY. Routing
            // them through the browser's dev proxy made an unrelated middleman
            // part of the agent's request path, where its buffering and restarts
            // truncate long-lived streams; it also has nothing to add, since
            // nothing on that path is a browser. Falls back to the browser
            // authority when the two are the same (release).
            let local_host = embedded
                .listener_host
                .clone()
                .unwrap_or_else(|| expected_host.clone());
            let mut expected_hosts = vec![embedded.expected_host];
            if let Some(listener_host) = embedded.listener_host {
                if listener_host != expected_hosts[0] {
                    expected_hosts.push(listener_host);
                }
            }
            let mount_token = generate_mount_token();
            let auth = client_auth::ClientAuth::embedded(
                expected_hosts,
                embedded.control_origin,
                bootstrap_secrets,
                stable_session_token(&opts.app_root),
                mount_token.clone(),
            )
            .map_err(|message| StartError::EmbeddedAuth { message })?;
            // Publish loopback endpoint metadata and the rclone-only mount
            // capability. Agent terminals mint a separate exact-MCP-path
            // capability per launch; they never receive the control cookie.
            sandbox::org_mount::set_credentials(sandbox::org_mount::MountCredentials {
                base_url: format!("{control_scheme}://{local_host}"),
                origin: control_origin,
                mount_token,
                ca_cert: opts.tls.as_ref().map(|tls| tls.ca.clone()),
            });
            // Previews are served per-sandbox at `<handle>.<control host>`:
            // the same registrable domain, so the iframe stays first-party and
            // can hold cookies, but a distinct host, so each sandbox gets its
            // own cookie jar. See `src-tauri/src/control_origin.rs`.
            if let Some(host) = expected_host.split(':').next() {
                routes::intercept::set_preview_host(host.to_string());
            }
            (auth, embedded.ui_assets, preview_cookie_selftest_origin)
        }
    };

    let repo_dir = opts.app_root.join("repo");
    // Byte-parity with the daemon's boot-time `mkdirSync(repoDir, {
    // recursive: true })` — bash commands with the default cwd shouldn't
    // ENOENT before anything has been written into the workspace yet.
    std::fs::create_dir_all(&repo_dir).map_err(|source| StartError::RepoDir {
        path: repo_dir.clone(),
        source,
    })?;
    // `.decocms/` is local-api's OWN directory (distinct from a project's
    // `.deco/tools/` catalog dir): lockfiles, run-stream spools and staged
    // mutations. The SQLite store itself is `<app_root>/studio.db`.
    let decocms_dir = opts.app_root.join(".decocms");
    std::fs::create_dir_all(&decocms_dir).map_err(|source| StartError::DecocmsDir {
        path: decocms_dir.clone(),
        source,
    })?;
    let instance_lock_path = decocms_dir.join("local-api.lock");
    let instance_lock = Arc::new(
        acquire_instance_lock(&instance_lock_path).map_err(|source| StartError::InstanceLock {
            path: instance_lock_path,
            source,
        })?,
    );
    // The main instance lock above is deliberately first: a genuinely LIVE
    // second process still fails immediately. After SIGKILL the OS releases
    // that main lock, while independent watchdogs survive long enough to reap
    // old harnesses/tasks. Every watchdog inherited a SHARED lock on this
    // separate file; the successor waits for EXCLUSIVE ownership before any
    // mutation/queue recovery can observe or promote durable work.
    let child_lifetime_lock_path = shared_child_lifetime_lock_path(&opts.app_root);
    let child_recovery_fence =
        acquire_child_recovery_fence(&child_lifetime_lock_path, CHILD_CRASH_REAP_TIMEOUT)
            .await
            .map_err(|source| StartError::ChildLifetimeFence {
                path: child_lifetime_lock_path.clone(),
                source,
            })?;
    // Staged downloads/catalog swaps and rename-to-trash deletions live
    // outside the repository. A crash can leave them behind, so the process
    // that owns the app-root lock recovers journaled catalog swaps and clears
    // only abort-safe stages before accepting requests. In particular, a
    // `previous-catalog` directory may be the only known-good copy and must
    // never be blindly deleted. Never recover before acquiring the lock: a
    // losing second instance must not touch the live owner's stages.
    let mutation_stage_root = decocms_dir.join("mutations");
    routes::fs::recover_mutation_stages(&mutation_stage_root, &repo_dir)
        .await
        .map_err(|source| StartError::MutationRecovery {
            path: mutation_stage_root,
            source,
        })?;

    let config = Arc::new(ConfigStore::new());
    // `<app_root>/logs` — the durable, file-backed home for retained log
    // output (see the `log_store` module doc: files are the source of truth,
    // RAM holds only transient live fan-out). Sibling of `repo_dir` above,
    // same as a per-handle `Sandbox`'s own `logs` dir is a sibling of its
    // `repo` (see `sandbox/manager.rs::get_or_create`).
    let logs = Arc::new(log_store::LogStore::new(opts.app_root.join("logs")));
    let tasks = Arc::new(TaskRegistry::new_with_child_lifetime_lock(
        logs,
        child_lifetime_lock_path.clone(),
    ));
    let broadcaster = Arc::new(Broadcaster::new());
    let setup_orchestrator = SetupOrchestrator::new(
        repo_dir.clone(),
        opts.app_root.clone(),
        config.clone(),
        tasks.clone(),
        broadcaster.clone(),
    );
    let shutdown = Arc::new(ShutdownCoordinator::new());
    // `<app_root>/sandboxes/<handle>/repo` — created lazily per handle by
    // `SandboxManager::ensure`, not eagerly here (unlike `repo_dir` above,
    // which every plain-path request needs immediately).
    let sandbox_manager = SandboxManager::new(opts.app_root.clone());
    let agent_sessions = terminal::AgentSessionRegistry::new();

    let state = AppState {
        token: opts.token.into(),
        boot_id: opts.boot_id.into(),
        app_root: opts.app_root,
        repo_dir,
        mode: opts.mode,
        config,
        tasks: tasks.clone(),
        broadcaster,
        shutdown: shutdown.clone(),
        setup: setup_orchestrator,
        sandbox_manager,
        update: opts.update,
        agent_sessions,
    };

    // Clear worktree registrations orphaned by a sandbox directory that
    // vanished while the app was down; git would otherwise refuse to re-add a
    // worktree at that path. Detached and best-effort — it only walks the repo
    // store, so it must never delay serving.
    let prune_root = state.app_root.clone();
    tokio::spawn(async move {
        sandbox::repo_store::prune_all(&prune_root).await;
        // Org mounts outlive the process that served them: a SIGKILLed app
        // leaves the kernel holding NFS mounts backed by nothing, and the
        // sandbox that owns each path can never be re-provisioned there until
        // it is reclaimed. See `sandbox::org_mount`.
        sandbox::org_mount::prune_stale_mounts(&prune_root).await;
    });

    let listener = TcpListener::bind(("127.0.0.1", opts.port))
        .await
        .map_err(|source| StartError::Bind {
            port: opts.port,
            source,
        })?;
    let bound_port = listener.local_addr().map(|a| a.port()).unwrap_or(opts.port);

    // The preview listener always binds an EPHEMERAL port — there is no
    // "requested preview port" the way `opts.port` can pin the main one;
    // callers only ever learn it back via `ServerHandle::preview_port`.
    let preview_listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|source| StartError::Bind { port: 0, source })?;
    let preview_port = preview_listener.local_addr().map(|a| a.port()).unwrap_or(0);
    // Publish it for the SANDBOX_START intercept, which reports this listener
    // as the sandbox's `previewUrl` (see that module's `preview_url`).
    routes::intercept::set_preview_port(preview_port);

    // Both listeners are known-good before durable queued work is resumed, so
    // a bind failure can never launch an agent in a process that won't serve.
    // Recovery still runs before either router starts accepting requests.
    // Release EXCLUSIVE immediately before recovery. Any harness or task that
    // recovery spawns takes SHARED ownership through the same path before its
    // command starts. With the main instance lock still held, no other process
    // can enter this handoff.
    drop(child_recovery_fence);
    let thread_db = routes::threads::shared_db(&state).map_err(|error| StartError::LocalStore {
        message: error
            .body
            .get("error")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("failed to open local thread database")
            .to_string(),
    })?;
    let interrupted = thread_db
        .rt_interrupt_live_terminal_sessions_on_boot()
        .map_err(|error| StartError::LocalStore {
            message: format!("failed to interrupt stale terminal sessions: {error}"),
        })?;
    if !interrupted.is_empty() {
        tracing::info!(
            count = interrupted.len(),
            "marked terminal sessions from the previous app instance interrupted"
        );
    }

    // One rustls config shared by both listeners: they serve the same leaf,
    // which covers the control host and the `*.<host>` preview wildcard.
    // Loaded BEFORE either task spawns so a bad certificate fails the whole
    // start rather than leaving one listener silently on plain HTTP.
    let tls_config = match opts.tls.as_ref() {
        Some(files) => {
            // rustls 0.23 has no default crypto provider and PANICS on first
            // use without one. Installing is idempotent-by-ignoring: a second
            // call returns Err because another provider is already set, which
            // is exactly the state we want.
            let _ = rustls::crypto::ring::default_provider().install_default();
            Some(
                axum_server::tls_rustls::RustlsConfig::from_pem_file(&files.cert, &files.key)
                    .await
                    .map_err(|source| StartError::Tls {
                        path: files.cert.clone(),
                        source,
                    })?,
            )
        }
        None => None,
    };

    // Mirrors `preview_url`'s gate. Under a real domain each sandbox has its
    // own host, so the CSP needs a WILDCARD — which matches at least one
    // label, exactly a handle, and deliberately NOT the bare host. Under a
    // single-label host every sandbox shares one origin, and a wildcard would
    // match none of it.
    let preview_base = routes::intercept::preview_host_base();
    let preview_scheme = if tls_config.is_some() {
        "https"
    } else {
        "http"
    };
    let preview_csp_origin = if preview_base.contains('.') {
        format!("{preview_scheme}://*.{preview_base}:{preview_port}")
    } else {
        format!("{preview_scheme}://{preview_base}:{preview_port}")
    };
    let app = router::build(state.clone(), client_auth, ui_assets, preview_csp_origin);
    let preview_app = router::build_preview(
        state.clone(),
        preview_port,
        preview_base,
        preview_cookie_selftest_origin,
    );

    // Previews follow the listeners' scheme; the webview refuses a plain-http
    // iframe inside an https shell (mixed content) and the URL must match.
    routes::intercept::set_preview_scheme(if tls_config.is_some() {
        "https"
    } else {
        "http"
    });

    // Subscribe before listener admission starts so even an immediate
    // background hard sign-out has a process-owner waiting to reap terminals.
    let auth_reaper_task =
        auth_fence::spawn_identity_reaper(upstream::global(), state.agent_sessions.clone());

    let shutdown_notify = Arc::new(Notify::new());
    let notify_for_task = shutdown_notify.clone();
    let main_instance_lock = instance_lock.clone();
    let main_tls = tls_config.clone();
    let serve_task = tokio::spawn(async move {
        let _instance_lock = main_instance_lock;
        serve_maybe_tls(listener, app, main_tls, notify_for_task, "local-api server").await;
    });

    // A SEPARATE `Notify` (not the main listener's) — each is a one-shot,
    // single-consumer signal (`notify_one` stores a permit for the first
    // future `notified().await` even if called before that call starts
    // waiting), so two listeners sharing ONE `Notify` would risk
    // `notify_one()` waking only whichever task happened to be waiting
    // first, leaving the other's serve loop running past shutdown.
    let preview_shutdown_notify = Arc::new(Notify::new());
    let preview_notify_for_task = preview_shutdown_notify.clone();
    let preview_instance_lock = instance_lock.clone();
    let preview_tls = tls_config.clone();
    let preview_serve_task = tokio::spawn(async move {
        let _instance_lock = preview_instance_lock;
        serve_maybe_tls(
            preview_listener,
            preview_app,
            preview_tls,
            preview_notify_for_task,
            "local-api preview server",
        )
        .await;
    });
    Ok(ServerHandle {
        port: bound_port,
        preview_port,
        state,
        shutdown_notify,
        preview_shutdown_notify,
        serve_task,
        preview_serve_task,
        auth_reaper_task,
        _instance_lock: instance_lock,
    })
}

fn acquire_instance_lock(path: &Path) -> std::io::Result<File> {
    // Owner-only from creation (and clamped when pre-existing) so the
    // ownership fence never leaks app metadata — see `fs_util`.
    let file = fs_util::open_owner_only(path)?;
    file.try_lock()?;
    Ok(file)
}

async fn acquire_child_recovery_fence(path: &Path, budget: Duration) -> std::io::Result<File> {
    let file = fs_util::open_owner_only(path)?;
    acquire_exclusive_with_budget(file, path, budget).await
}

async fn acquire_exclusive_with_budget(
    file: File,
    path: &Path,
    budget: Duration,
) -> std::io::Result<File> {
    let deadline = tokio::time::Instant::now() + budget;
    loop {
        match file.try_lock() {
            Ok(()) => return Ok(file),
            Err(std::fs::TryLockError::WouldBlock) => {
                if tokio::time::Instant::now() >= deadline {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::TimedOut,
                        format!(
                            "timed out after {}ms waiting for old child watchdogs on {path:?}",
                            budget.as_millis()
                        ),
                    ));
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            Err(std::fs::TryLockError::Error(error)) => return Err(error),
        }
    }
}

/// The `local-api` binary's entire boot sequence — see the module doc
/// comment. Reads the env contract, prints the discovery stdout lines,
/// serves until SIGTERM/Ctrl+C, then runs shutdown hooks. Exits the
/// process (`std::process::exit(1)`) on any boot failure, matching the old
/// `main()` body's behavior exactly.
pub async fn boot_from_env() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    // Signal ownership must exist before `start()` opens and recovers the
    // durable queue. A dev-loop SIGTERM delivered during that await used to
    // take the platform default path and bypass every shutdown fence. The
    // listener records the first signal without cancelling startup; once
    // startup returns, the already-queued request flows through the normal
    // ordered `ServerHandle::shutdown`. A second signal remains an operator
    // escape hatch if recovery or shutdown itself is wedged.
    let termination = InstalledTerminationSignal::install();

    let token = resolve_token();
    let boot_id = resolve_boot_id();
    let app_root = resolve_app_root();
    let mode = ApiMode::from_env();
    // Bind ONLY 127.0.0.1, never 0.0.0.0 — deliberate divergence from the
    // daemon (which binds 0.0.0.0, acceptable for a sandboxed cluster
    // pod/VM, unacceptable for a process running on a user's laptop). See
    // the native local-API contract.
    let port = resolve_port();

    let handle = match start(StartOptions {
        token,
        boot_id,
        app_root,
        port,
        mode,
        // The standalone binary serves plain HTTP: local HTTPS exists for the
        // desktop webview's origin, and nothing here has a webview.
        tls: None,
        // Self-update belongs to the packaged Tauri shell only.
        update: None,
    })
    .await
    {
        Ok(h) => h,
        Err(err) => {
            eprintln!("[local-api] {err}");
            std::process::exit(1);
        }
    };

    // A test harness that requested port 0 (ephemeral) discovers the real
    // port from this line — see the contract doc's `LOCAL_API_PORT` row.
    // Printed unconditionally (not only when 0 was requested) since it's
    // harmless and keeps the contract simple.
    println!("LOCAL_API_PORT={}", handle.port());
    // The preview listener's port is ALWAYS ephemeral (see `start`'s doc
    // comment) — this is the only way a caller (an e2e harness, in
    // particular) ever learns it.
    println!("LOCAL_API_PREVIEW_PORT={}", handle.preview_port());
    tracing::info!(port = handle.port(), preview_port = handle.preview_port(), boot_id = %handle.state().boot_id, "local-api listening");

    termination.wait().await;
    tracing::info!("shutdown signal received, running shutdown hooks");
    handle.shutdown().await;
}

/// Resolves `LOCAL_API_TOKEN` (canonical) or `DAEMON_TOKEN` (legacy alias
/// — required so the daemon-parity oracle's `daemon.e2e.helpers.ts` can
/// spawn this binary unmodified). New name wins when both are set. If
/// neither is set, generates a fresh 32-byte token, hex-encoded, and
/// prints it as `LOCAL_API_TOKEN=<token>` on its own line before the
/// process starts listening — mirrors how the token reaches a caller today
/// when nothing pre-seeds it.
fn resolve_token() -> String {
    if let Ok(v) = std::env::var("LOCAL_API_TOKEN") {
        if !v.is_empty() {
            return v;
        }
    }
    if let Ok(v) = std::env::var("DAEMON_TOKEN") {
        if !v.is_empty() {
            return v;
        }
    }
    let token = generate_token();
    println!("LOCAL_API_TOKEN={token}");
    token
}

fn generate_token() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// `LOCAL_API_BOOT_ID` / `DAEMON_BOOT_ID`, else a generated UUID — mirrors
/// `entry.ts` generating `DAEMON_BOOT_ID` when unset.
fn resolve_boot_id() -> String {
    std::env::var("LOCAL_API_BOOT_ID")
        .or_else(|_| std::env::var("DAEMON_BOOT_ID"))
        .unwrap_or_else(|_| uuid::Uuid::new_v4().to_string())
}

/// `LOCAL_API_WORKDIR` / `APP_ROOT` — required. Unlike the daemon (which
/// falls back to `"/"`), local-api refuses to boot without an explicit
/// workdir: a silent `/` clamp on a user's laptop is a much scarier
/// default than it is inside a disposable sandbox container.
fn resolve_app_root() -> PathBuf {
    let raw = std::env::var("LOCAL_API_WORKDIR")
        .or_else(|_| std::env::var("APP_ROOT"))
        .unwrap_or_else(|_| {
            eprintln!(
                "[local-api] missing required env: set LOCAL_API_WORKDIR (or the legacy APP_ROOT alias)"
            );
            std::process::exit(1);
        });
    PathBuf::from(raw)
}

/// `LOCAL_API_PORT` / `PROXY_PORT` — required. `0` picks an ephemeral port
/// (see `resolve_token`'s sibling stdout contract for how a caller
/// discovers it).
fn resolve_port() -> u16 {
    let raw = std::env::var("LOCAL_API_PORT")
        .or_else(|_| std::env::var("PROXY_PORT"))
        .unwrap_or_else(|_| {
            eprintln!(
                "[local-api] missing required env: set LOCAL_API_PORT (or the legacy PROXY_PORT alias)"
            );
            std::process::exit(1);
        });
    raw.parse().unwrap_or_else(|_| {
        eprintln!("[local-api] invalid port value: {raw:?}");
        std::process::exit(1);
    })
}

/// Pre-armed standalone-binary signal receiver. The Tauri shell has its own
/// equivalent in `src-tauri/src/setup.rs`, routing signals through
/// `AppHandle::exit` and the retained embedded [`ServerHandle`].
struct InstalledTerminationSignal {
    first: tokio::sync::oneshot::Receiver<()>,
}

impl InstalledTerminationSignal {
    fn install() -> Self {
        let (first_tx, first) = tokio::sync::oneshot::channel();

        #[cfg(unix)]
        {
            use tokio::signal::unix::{signal, SignalKind};

            // `signal(...)` installs Tokio's process-wide handlers
            // synchronously here—before the startup/recovery future is first
            // polled. The spawned task only waits on already-installed streams.
            let mut terminate =
                signal(SignalKind::terminate()).expect("failed to install SIGTERM handler");
            let mut interrupt =
                signal(SignalKind::interrupt()).expect("failed to install SIGINT handler");
            tokio::spawn(async move {
                let first_name = tokio::select! {
                    _ = terminate.recv() => "SIGTERM",
                    _ = interrupt.recv() => "SIGINT",
                };
                tracing::info!(signal = first_name, "standalone shutdown signal queued");
                let _ = first_tx.send(());

                let second_name = tokio::select! {
                    _ = terminate.recv() => "SIGTERM",
                    _ = interrupt.recv() => "SIGINT",
                };
                tracing::error!(
                    signal = second_name,
                    "second standalone shutdown signal received; forcing exit"
                );
                std::process::exit(1);
            });
        }

        #[cfg(not(unix))]
        tokio::spawn(async move {
            let _ = tokio::signal::ctrl_c().await;
            let _ = first_tx.send(());
            let _ = tokio::signal::ctrl_c().await;
            std::process::exit(1);
        });

        Self { first }
    }

    async fn wait(self) {
        let _ = self.first.await;
    }
}

/// Serve `app` on `listener`, over TLS when configured, until `shutdown` fires.
///
/// `axum::serve` and `axum_server` have different shutdown shapes, so this
/// keeps the choice in one place instead of forking every call site.
async fn serve_maybe_tls(
    listener: TcpListener,
    app: axum::Router,
    tls: Option<axum_server::tls_rustls::RustlsConfig>,
    shutdown: Arc<Notify>,
    label: &'static str,
) {
    let Some(tls) = tls else {
        let result = axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                shutdown.notified().await;
            })
            .await;
        if let Err(err) = result {
            tracing::error!(error = %err, "{label} error");
        }
        return;
    };

    let std_listener = match listener.into_std() {
        Ok(listener) => listener,
        Err(err) => {
            tracing::error!(error = %err, "{label} could not take the listener for TLS");
            return;
        }
    };
    let handle = axum_server::Handle::new();
    let shutdown_handle = handle.clone();
    tokio::spawn(async move {
        shutdown.notified().await;
        // `None` — connections are dropped at once rather than lingering; the
        // only clients are this app's own webview and its children.
        shutdown_handle.graceful_shutdown(None);
    });
    let result = axum_server::from_tcp_rustls(std_listener, tls)
        .handle(handle)
        .serve(app.into_make_service())
        .await;
    if let Err(err) = result {
        tracing::error!(error = %err, "{label} error");
    }
}

#[cfg(test)]
mod tests {
    use std::fs::OpenOptions;

    use super::*;

    #[test]
    fn instance_lock_is_exclusive_and_kernel_released() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("local-api.lock");
        let first = acquire_instance_lock(&path).unwrap();
        let error = acquire_instance_lock(&path).unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::WouldBlock);

        drop(first);
        // Parallel process-spawning tests can briefly retain a fork-inherited
        // descriptor before exec closes it. The kernel release is still
        // bounded; avoid asserting on that transient pre-exec window.
        let deadline = std::time::Instant::now() + Duration::from_secs(1);
        let _restarted = loop {
            match acquire_instance_lock(&path) {
                Ok(lock) => break lock,
                Err(error)
                    if error.kind() == std::io::ErrorKind::WouldBlock
                        && std::time::Instant::now() < deadline =>
                {
                    std::thread::sleep(Duration::from_millis(10));
                }
                Err(error) => panic!("instance lock was not released: {error}"),
            }
        };

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }

    #[tokio::test]
    async fn child_recovery_fence_waits_for_shared_watchdog_and_is_bounded() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("child-lifetime.lock");
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true);
        let shared = options.open(&path).unwrap();
        shared.try_lock_shared().unwrap();

        let error = acquire_child_recovery_fence(&path, Duration::from_millis(40))
            .await
            .unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::TimedOut);

        drop(shared);
        let exclusive = acquire_child_recovery_fence(&path, Duration::from_secs(1))
            .await
            .expect("exclusive recovery ownership after shared watchdog exits");
        let contender = options.open(&path).unwrap();
        assert!(matches!(
            contender.try_lock_shared(),
            Err(std::fs::TryLockError::WouldBlock)
        ));
        drop(exclusive);
    }

    #[tokio::test]
    async fn server_start_rejects_same_root_until_owner_shuts_down() {
        let dir = tempfile::tempdir().unwrap();
        let options = |boot_id: &str| StartOptions {
            tls: None,
            update: None,
            token: "t".repeat(32),
            boot_id: boot_id.to_string(),
            app_root: dir.path().to_path_buf(),
            port: 0,
            mode: ApiMode::Strict,
        };
        let first = start(options("first")).await.unwrap();
        match start(options("second")).await {
            Err(StartError::InstanceLock { source, .. }) => {
                assert_eq!(source.kind(), std::io::ErrorKind::WouldBlock)
            }
            Ok(second) => {
                second.shutdown().await;
                panic!("a second server acquired the live app root")
            }
            Err(error) => panic!("unexpected second-start error: {error}"),
        }

        first.shutdown().await;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(1);
        let restarted = loop {
            match start(options("restarted")).await {
                Ok(server) => break server,
                Err(StartError::InstanceLock { source, .. })
                    if source.kind() == std::io::ErrorKind::WouldBlock
                        && tokio::time::Instant::now() < deadline =>
                {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
                Err(error) => panic!("server could not restart after shutdown: {error}"),
            }
        };
        restarted.shutdown().await;
    }
}
