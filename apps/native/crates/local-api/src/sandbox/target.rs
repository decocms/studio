//! [`SandboxTarget`] + [`AppState::resolve_sandbox_target`] — the single
//! helper the observability/control routes (`routes/events.rs`,
//! `routes/tasks.rs`, `routes/scripts.rs`, `routes/setup.rs`) use to pick
//! WHICH orchestrator quadruple a request operates on: a specific per-handle
//! [`crate::sandbox::manager::Sandbox`] or the process-global
//! `AppState.{setup,tasks,broadcaster,config,repo_dir}`.
//!
//! Lives here (a `sandbox`-family file) rather than in `state.rs` so the
//! SHARED `AppState` struct is never edited — the module-ownership rule (see
//! the native module-ownership contract). `impl AppState` in a downstream
//! module is allowed; adding a FIELD to the struct is not.
//!
//! Mirrors `routes/proxy.rs::dev_port`'s handle -> `get(handle)` ->
//! `active()` -> global resolution shape, with ONE deliberate divergence:
//! for observability an *unknown explicit handle* falls back to the GLOBAL
//! target (so an SSE stream / task list is never dead), whereas `dev_port`
//! returns `None` for an unknown handle on purpose (never preview the wrong
//! branch — pinned by `proxy.rs`'s
//! `dev_port_returns_none_for_an_unrecognized_handle_header` test). Because of
//! that difference the two stay parallel encodings rather than one calling the
//! other. See the native sandbox-bridge contract D1/O3.

use std::path::PathBuf;
use std::sync::Arc;

use crate::config::ConfigStore;
use crate::events::Broadcaster;
use crate::setup::SetupOrchestrator;
use crate::state::AppState;
use crate::tasks::TaskRegistry;

/// One resolved orchestrator quadruple (plus its workdir) — either a specific
/// per-handle [`crate::sandbox::manager::Sandbox`]'s Arcs, or the
/// process-global ones from [`AppState`]. Every field is a cheap `Arc` clone
/// (or an owned `PathBuf`), so producing a `SandboxTarget` per request is
/// negligible.
pub struct SandboxTarget {
    pub setup: Arc<SetupOrchestrator>,
    pub tasks: Arc<TaskRegistry>,
    pub broadcaster: Arc<Broadcaster>,
    pub config: Arc<ConfigStore>,
    /// The sandbox workdir, or `state.repo_dir` for the global path.
    pub repo_dir: PathBuf,
}

impl SandboxTarget {
    /// Builds a [`SandboxTarget`] from one already-resolved per-handle
    /// [`crate::sandbox::manager::Sandbox`] — the four-Arcs-plus-workdir
    /// mapping shared by [`AppState::resolve_sandbox_target`] below and
    /// `routes/setup.rs`/`routes/repo_dir.rs`'s own STRICTER per-handle
    /// resolvers (which, unlike this file's three-tier fallback, error
    /// instead of silently falling through to the global path on an unknown
    /// handle — see those files' doc comments for why).
    pub fn from_sandbox(sandbox: &crate::sandbox::manager::Sandbox) -> SandboxTarget {
        SandboxTarget {
            setup: sandbox.setup.clone(),
            tasks: sandbox.tasks.clone(),
            broadcaster: sandbox.broadcaster.clone(),
            config: sandbox.config.clone(),
            repo_dir: sandbox.workdir.clone(),
        }
    }
}

impl AppState {
    /// Resolve the per-handle target for `handle`, mirroring
    /// `proxy.rs::dev_port`'s handle -> `get(handle)` -> `active()` -> global
    /// shape — but NEVER yields "nothing": an unknown handle falls back to the
    /// global target so an SSE stream is never dead (see this module's doc,
    /// plan D1/O3). An empty handle string is treated as absent.
    pub fn resolve_sandbox_target(&self, handle: Option<&str>) -> SandboxTarget {
        let handle = handle.filter(|s| !s.is_empty());
        let sandbox = match handle {
            Some(h) => self.sandbox_manager.get(h), // known handle -> that sandbox
            None => self.sandbox_manager.active(),  // headerless -> active sandbox
        };
        match sandbox {
            Some(sb) => SandboxTarget::from_sandbox(&sb),
            // Unknown handle OR no active sandbox -> the process-global path
            // (unchanged plain-path behavior).
            None => SandboxTarget {
                setup: self.setup.clone(),
                tasks: self.tasks.clone(),
                broadcaster: self.broadcaster.clone(),
                config: self.config.clone(),
                repo_dir: self.repo_dir.clone(),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sandbox::GitSandboxConfig;
    use serde_json::json;
    use std::path::Path;
    use std::process::Command;

    fn git(dir: &Path, args: &[&str]) {
        let out = Command::new("git")
            .args(args)
            .current_dir(dir)
            .output()
            .expect("git failed to spawn");
        assert!(out.status.success(), "git {args:?} failed: {out:?}");
    }

    /// A bare "origin" with a single `main` commit, plus a fresh `AppState`,
    /// reusing the same real-bare-repo `ensure()` fixture shape used in
    /// `proxy.rs`/`manager.rs` tests.
    fn fresh_state() -> AppState {
        let config = Arc::new(ConfigStore::new());
        let app_root = std::env::temp_dir();
        let repo_dir = std::env::temp_dir();
        // The GLOBAL (non-sandbox) registry/logs below are never exercised
        // by these tests (only `state.sandbox_manager.ensure(..)`, whose own
        // per-handle `Sandbox` gets its OWN isolated logs dir under
        // `app_root/sandboxes/<handle>/logs` — see `manager.rs`), so sharing
        // `std::env::temp_dir()` here is harmless.
        let logs = Arc::new(crate::log_store::LogStore::new(app_root.join("logs")));
        let tasks = Arc::new(TaskRegistry::new(logs));
        let broadcaster = Arc::new(Broadcaster::new());
        let setup = SetupOrchestrator::new(
            repo_dir.clone(),
            repo_dir.clone(),
            config.clone(),
            tasks.clone(),
            broadcaster.clone(),
        );
        AppState {
            update: None,
            token: "test-token".into(),
            boot_id: "test-boot".into(),
            sandbox_manager: crate::sandbox::SandboxManager::new(app_root.clone()),
            agent_sessions: crate::terminal::AgentSessionRegistry::new(),
            app_root,
            repo_dir,
            mode: crate::state::ApiMode::Strict,
            config,
            tasks,
            broadcaster,
            shutdown: Arc::new(crate::shutdown::ShutdownCoordinator::new()),
            setup,
        }
    }

    async fn ensure_one_sandbox(
        state: &AppState,
        vmcp: &str,
    ) -> Arc<crate::sandbox::manager::Sandbox> {
        let dir = tempfile::tempdir().unwrap();
        let bare_dir = dir.path().join("origin.git");
        let work_dir = dir.path().join("author");
        std::fs::create_dir_all(&bare_dir).unwrap();
        std::fs::create_dir_all(&work_dir).unwrap();
        git(&bare_dir, &["init", "--bare", "-q"]);
        git(&work_dir, &["init", "-q", "-b", "main"]);
        git(&work_dir, &["config", "user.name", "Test User"]);
        git(&work_dir, &["config", "user.email", "test@example.com"]);
        std::fs::write(work_dir.join("f.txt"), "x").unwrap();
        git(&work_dir, &["add", "."]);
        git(&work_dir, &["commit", "-q", "-m", "initial"]);
        let bare_str = bare_dir.to_str().unwrap();
        git(&work_dir, &["remote", "add", "origin", bare_str]);
        git(&work_dir, &["push", "-q", "-u", "origin", "main"]);
        git(&bare_dir, &["symbolic-ref", "HEAD", "refs/heads/main"]);

        // `ensure()` awaits the clone synchronously before returning, so the
        // bare origin only needs to outlive this call — `dir` dropping at the
        // end of the test is fine (the async install/start pipeline operates
        // on the already-cloned workdir, never the origin again).
        state
            .sandbox_manager
            .ensure(&GitSandboxConfig {
                virtual_mcp_id: vmcp.to_string(),
                clone_url: bare_str.to_string(),
                branch: Some("main".to_string()),
                ..Default::default()
            })
            .await
            .expect("ensure succeeds against a real one-commit bare repo")
    }

    #[tokio::test]
    async fn known_handle_resolves_to_that_sandboxs_arcs() {
        let state = fresh_state();
        let sandbox = ensure_one_sandbox(&state, "vmcp-target-known").await;

        let target = state.resolve_sandbox_target(Some(&sandbox.handle));
        assert!(Arc::ptr_eq(&target.setup, &sandbox.setup));
        assert!(Arc::ptr_eq(&target.tasks, &sandbox.tasks));
        assert!(Arc::ptr_eq(&target.broadcaster, &sandbox.broadcaster));
        assert!(Arc::ptr_eq(&target.config, &sandbox.config));
        assert_eq!(target.repo_dir, sandbox.workdir);
    }

    #[tokio::test]
    async fn no_handle_with_active_resolves_to_the_active_sandbox() {
        let state = fresh_state();
        // `ensure()` marks its handle active, so a headerless resolve follows
        // the active sandbox — NOT the global orchestrator.
        let sandbox = ensure_one_sandbox(&state, "vmcp-target-active").await;

        let target = state.resolve_sandbox_target(None);
        assert!(Arc::ptr_eq(&target.setup, &sandbox.setup));
        assert!(Arc::ptr_eq(&target.tasks, &sandbox.tasks));
        assert!(Arc::ptr_eq(&target.broadcaster, &sandbox.broadcaster));
    }

    #[test]
    fn no_handle_without_active_resolves_to_the_global_target() {
        let state = fresh_state();
        let target = state.resolve_sandbox_target(None);
        assert!(Arc::ptr_eq(&target.setup, &state.setup));
        assert!(Arc::ptr_eq(&target.tasks, &state.tasks));
        assert!(Arc::ptr_eq(&target.broadcaster, &state.broadcaster));
        assert!(Arc::ptr_eq(&target.config, &state.config));
        assert_eq!(target.repo_dir, state.repo_dir);
    }

    #[tokio::test]
    async fn unknown_handle_falls_back_to_the_global_target() {
        let state = fresh_state();
        // Even with an active sandbox present, an EXPLICIT unknown handle
        // resolves to global (the observability divergence from `dev_port`,
        // which would return `None` here) — see this module's doc.
        let _sandbox = ensure_one_sandbox(&state, "vmcp-target-unknown").await;

        let target = state.resolve_sandbox_target(Some("never-ensured-handle"));
        assert!(Arc::ptr_eq(&target.setup, &state.setup));
        assert!(Arc::ptr_eq(&target.tasks, &state.tasks));
        assert!(Arc::ptr_eq(&target.broadcaster, &state.broadcaster));
    }

    #[test]
    fn empty_handle_is_treated_as_absent() {
        let state = fresh_state();
        // Empty string -> global (no active sandbox in this fixture).
        let target = state.resolve_sandbox_target(Some(""));
        assert!(Arc::ptr_eq(&target.setup, &state.setup));
        // sanity: the global setup is idle
        assert_eq!(target.setup.lifecycle_snapshot(), json!({"phase": "idle"}));
    }
}
