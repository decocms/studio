//! `GET /_sandbox/repo-dir` — NEW, no daemon precedent. Resolves the
//! ABSOLUTE workdir of a specific git-backed desktop sandbox so the webview's
//! "Open in VS Code / Cursor" deep link has a local route to call instead of
//! the cloud-only `/api/:org/sandbox/:id/:branch/config` REST route
//! local-api's intercept table doesn't carry — see
//! the native desktop-runtime audit finding #4
//! ("Additional wrinkle"), which is what this route exists to close.
//!
//! ## Resolution: per-handle, NOT the three-tier observability fallback
//!
//! Deliberately mirrors `routes/proxy.rs::resolve_preview`'s per-handle shape
//! (`handle -> get(handle)` else `active()`, unknown-handle-never-guesses),
//! NOT `sandbox::target::AppState::resolve_sandbox_target`'s three-tier
//! `handle -> active() -> global` one that `routes/setup.rs`/`routes/tasks.rs`/
//! `routes/events.rs`/`routes/scripts.rs` use: "open THIS thread's cloned repo
//! in an editor" has no sensible meaning for the process-global (plain,
//! non-git) path the way "restart the dev server" or "list tasks" still do —
//! a caller that reaches neither the explicit-handle nor the active-sandbox
//! branch gets a `404`, never the unrelated global `state.repo_dir` folder.
//!
//! - `x-decocms-sandbox-handle` present + known -> that sandbox's `workdir`.
//! - Header present + UNKNOWN -> `404` (never guesses at a different repo).
//! - Header absent -> [`crate::sandbox::SandboxManager::active`]; `None` (no
//!   git sandbox ever `ensure()`-d this process) -> `404`.
//! - Resolved but the workdir no longer exists on disk (e.g. removed out from
//!   under the process) -> `404` — this route's whole point is "here is a
//!   real, openable directory", so a stale path is exactly as useless to the
//!   caller as an unknown handle.

use axum::extract::State;
use axum::http::HeaderMap;
use axum::Json;
use serde_json::{json, Value};

use crate::error::{ApiError, ApiResult};
use crate::sandbox::manager::Sandbox;
use crate::state::AppState;
use std::sync::Arc;

pub async fn get(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    let authorization = super::sandbox_account::authorize(&state).await?;
    let account_epoch = authorization.epoch();
    let sandbox = resolve(&state, account_epoch, &headers)?;
    if tokio::fs::metadata(&sandbox.workdir).await.is_err() {
        return Err(ApiError::not_found(format!(
            "repo dir does not exist: {}",
            sandbox.workdir.display()
        )));
    }
    state
        .sandbox_manager
        .validate_account_epoch(account_epoch)
        .map_err(ApiError::conflict)?;
    Ok(Json(
        json!({ "repoDir": sandbox.workdir.to_string_lossy() }),
    ))
}

/// `handle -> get(handle)` else `active()` — see this file's module doc for
/// why this does NOT fall further to the process-global path.
fn resolve(
    state: &AppState,
    account_epoch: crate::sandbox::manager::AccountEpoch,
    headers: &HeaderMap,
) -> Result<Arc<Sandbox>, ApiError> {
    match crate::sandbox::handle_from_headers(headers) {
        Some(handle) => state
            .sandbox_manager
            .get_for_account(account_epoch, handle)
            .map_err(ApiError::conflict)?
            .ok_or_else(|| ApiError::not_found(format!("unknown sandbox handle: {handle}"))),
        None => state
            .sandbox_manager
            .active_for_account(account_epoch)
            .map_err(ApiError::conflict)?
            .ok_or_else(|| ApiError::not_found("no active sandbox")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::ConfigStore;
    use crate::events::Broadcaster;
    use crate::setup::SetupOrchestrator;
    use crate::tasks::TaskRegistry;
    use axum::http::HeaderValue;

    /// Minimal `AppState` fixture — mirrors `sandbox::target::tests::fresh_state`
    /// / `routes::setup::tests::fresh_state`; duplicated locally (rather than
    /// exported cross-module) since it's pure test plumbing with no
    /// non-test caller.
    fn fresh_state(sandbox_manager: Arc<crate::sandbox::SandboxManager>) -> AppState {
        let config = Arc::new(ConfigStore::new());
        let app_root = std::env::temp_dir();
        let repo_dir = std::env::temp_dir();
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
            sandbox_manager,
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

    fn git(dir: &std::path::Path, args: &[&str]) {
        let out = std::process::Command::new("git")
            .args(args)
            .current_dir(dir)
            .output()
            .expect("git failed to spawn");
        assert!(out.status.success(), "git {args:?} failed: {out:?}");
    }

    async fn ensure_one_sandbox(
        manager: &Arc<crate::sandbox::SandboxManager>,
        vmcp: &str,
    ) -> Arc<Sandbox> {
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

        manager
            .ensure_for_account(
                manager.account_epoch(),
                &crate::sandbox::GitSandboxConfig {
                    virtual_mcp_id: vmcp.to_string(),
                    clone_url: bare_str.to_string(),
                    branch: Some("main".to_string()),
                    ..Default::default()
                },
            )
            .await
            .expect("ensure succeeds against a real one-commit bare repo")
    }

    #[test]
    fn headerless_with_no_active_sandbox_is_a_404() {
        let root = tempfile::tempdir().unwrap();
        let manager = crate::sandbox::SandboxManager::new(root.path().to_path_buf());
        let state = fresh_state(manager);
        // `Arc<Sandbox>` (the `Ok` side) isn't `Debug`, so `expect_err` isn't
        // available here — match explicitly instead.
        match resolve(
            &state,
            state.sandbox_manager.account_epoch(),
            &HeaderMap::new(),
        ) {
            Err(e) => assert_eq!(e.status, axum::http::StatusCode::NOT_FOUND),
            Ok(_) => panic!("no active sandbox -> 404"),
        }
    }

    #[test]
    fn an_unknown_explicit_handle_is_a_404() {
        let root = tempfile::tempdir().unwrap();
        let manager = crate::sandbox::SandboxManager::new(root.path().to_path_buf());
        let state = fresh_state(manager);
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-decocms-sandbox-handle",
            HeaderValue::from_static("never-ensured"),
        );
        match resolve(&state, state.sandbox_manager.account_epoch(), &headers) {
            Err(e) => assert_eq!(e.status, axum::http::StatusCode::NOT_FOUND),
            Ok(_) => panic!("unknown handle -> 404"),
        }
    }

    #[tokio::test]
    async fn an_explicit_known_handle_resolves_to_that_sandbox() {
        let root = tempfile::tempdir().unwrap();
        let manager = crate::sandbox::SandboxManager::new(root.path().to_path_buf());
        let sandbox = ensure_one_sandbox(&manager, "repo-dir-known").await;

        let mut headers = HeaderMap::new();
        headers.insert(
            "x-decocms-sandbox-handle",
            HeaderValue::from_str(&sandbox.handle).unwrap(),
        );
        let state = fresh_state(manager);
        let resolved = resolve(&state, state.sandbox_manager.account_epoch(), &headers)
            .expect("known handle resolves");
        assert_eq!(resolved.workdir, sandbox.workdir);
    }

    #[tokio::test]
    async fn headerless_falls_back_to_the_active_sandbox() {
        let root = tempfile::tempdir().unwrap();
        let manager = crate::sandbox::SandboxManager::new(root.path().to_path_buf());
        let sandbox = ensure_one_sandbox(&manager, "repo-dir-active").await;

        let state = fresh_state(manager);
        let resolved = resolve(
            &state,
            state.sandbox_manager.account_epoch(),
            &HeaderMap::new(),
        )
        .expect("active sandbox resolves");
        assert_eq!(resolved.workdir, sandbox.workdir);
    }

    #[tokio::test]
    async fn get_returns_404_when_the_resolved_workdir_no_longer_exists_on_disk() {
        let root = tempfile::tempdir().unwrap();
        let manager = crate::sandbox::SandboxManager::new(root.path().to_path_buf());
        let sandbox = ensure_one_sandbox(&manager, "repo-dir-vanished").await;
        std::fs::remove_dir_all(&sandbox.workdir).unwrap();

        let state = fresh_state(manager);
        let res = get(State(state), HeaderMap::new()).await;
        let err = res.expect_err("a vanished workdir must 404, not 200 a stale path");
        assert_eq!(err.status, axum::http::StatusCode::NOT_FOUND);
    }
}
