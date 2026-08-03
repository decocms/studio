//! `POST /_sandbox/setup/{clone,install,start}` — KEPT (corrected from an
//! earlier "DROPPED family" classification; see `crate::setup`'s module doc
//! and the native parity contract for the full story). Byte-parity
//! target: `daemon/routes/setup.ts::makeSetupHandler` — always `200
//! {"enqueued":"<step>"}`, fire-and-forget (does not wait for the pipeline to
//! finish before responding), idempotent (re-requesting the same step while
//! one is in flight is a no-op on the orchestrator side, not an error here).
//!
//! ## Per-handle resolution is STRICTER than observability's
//!
//! [`resolve`] below deliberately does NOT reuse
//! [`AppState::resolve_sandbox_target`] verbatim (unlike `routes/tasks.rs`/
//! `routes/events.rs`/`routes/scripts.rs`, which do): an EXPLICIT
//! `x-decocms-sandbox-handle` header this process has never `ensure()`-d is a
//! caller/state-tracking bug worth surfacing loudly (`404`) here, not
//! silently clone/install/restarting the process-global (plain-path)
//! orchestrator instead — see
//! the native desktop-runtime audit finding #1: the
//! drawer's Restart button always means "restart THIS sandbox's dev server";
//! if the handle it was given no longer resolves, restarting an unrelated
//! target and reporting `200 {"enqueued":...}` back would look like success
//! while doing the wrong thing (or nothing the caller can observe).
//!
//! A HEADERLESS request's resolution is UNCHANGED for `clone`/`install` —
//! `resolve_sandbox_target`'s existing `handle -> active() -> global`
//! fallback still applies, falling all the way to the process-global
//! orchestrator when no sandbox has ever been `ensure()`-d. This is NOT a gap
//! left unfixed: `POST /_sandbox/setup/{clone,install}` is byte-parity
//! pinned (`daemon/routes/setup.ts::makeSetupHandler`, oracle
//! `daemon.git.e2e.test.ts`'s `"setup routes"` describe block, all-pass per
//! the native parity contract) to always enqueue for the PLAIN
//! (non-git) path too — a headerless call with no active sandbox MUST still
//! resolve to the process-global orchestrator and return `200`, not error,
//! or this crate silently stops being a byte-parity daemon replacement for
//! every desktop user who never attaches a persistent GitHub repo.
//!
//! ## `start` also self-heals a git sandbox forgotten by a backend restart
//!
//! [`resolve`] above is necessary but not sufficient for `start`: an
//! EXPLICIT handle this process forgot (backend restart — dev-loop rebuild,
//! app relaunch — kills the in-memory `sandboxes` map and `active_handle`
//! while the workdir + git history persist on disk, see `sandbox::manager`'s
//! module doc) used to 404 loudly (correct — never silently restart the
//! wrong target) but left the caller with NO way to make Restart actually
//! work again short of a fresh chat dispatch. [`resolve_for_start`] closes
//! that gap: before giving up, it tries
//! [`crate::sandbox::SandboxManager::resurrect`]/`resurrect_active`, which
//! re-`ensure()`s the handle from its persisted `GitSandboxConfig` sidecar
//! (`sandbox::persist`) — a REAL, non-destructive restart of the actual
//! sandbox (safe `checkout_existing` against the already-cloned workdir, see
//! `setup::clone::run`), not a no-op ack against an unrelated target. Only
//! `clone`/`install`/`stop` keep using the plain, non-resurrecting [`resolve`]
//! — see [`stop`]'s own doc comment for why resurrection is deliberately
//! wrong for a Stop click specifically.
//!
//! `resolve_for_start` still returns a LOUD error (never a silent
//! `{"enqueued":...}`) when the target genuinely cannot serve the caller's
//! intent: an explicit handle with no sidecar at all (never `ensure()`-d,
//! ever) is a `404`, matching [`resolve`]'s existing contract; a sidecar that
//! exists but fails to re-`ensure()` (e.g. the workdir's git remote is no
//! longer reachable) is a `409`, distinct from "unknown" so a caller can
//! tell the two apart. A headerless request keeps byte-parity: if nothing is
//! active AND nothing was ever persisted as active, it still falls all the
//! way to the process-global path and `200`s (the legitimate "never
//! configured, plain path" case above) — a headerless resurrection FAILURE
//! (sidecar existed but `ensure()` errored) degrades the same way rather
//! than hard-erroring a fire-and-forget request, logged instead.

use axum::extract::State;
use axum::http::HeaderMap;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::{ApiError, ApiResult};
use crate::sandbox::SandboxTarget;
use crate::setup::Step;
use crate::state::AppState;
use crate::tasks::{KillSignal, TaskStatus};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnsureSandboxRequest {
    virtual_mcp_id: String,
    repo: EnsureRepository,
    #[serde(default)]
    workload: Option<EnsureWorkload>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EnsureRepository {
    clone_url: String,
    #[serde(default)]
    branch: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EnsureWorkload {
    #[serde(default)]
    runtime: Option<String>,
    #[serde(default)]
    package_manager: Option<String>,
    #[serde(default)]
    package_manager_path: Option<String>,
}

/// Establish a durable, explicitly-addressable git sandbox from the same
/// `DesktopSandboxBlock` shape carried by local chat dispatch. Returns as
/// soon as the setup worker accepts clone/start so the UI can attach SSE and
/// render clone/install output live; lifecycle failures arrive on that stream
/// and are also persisted in the registry.
pub async fn ensure(
    State(state): State<AppState>,
    Json(body): Json<EnsureSandboxRequest>,
) -> ApiResult<Json<Value>> {
    let workload = body.workload.unwrap_or_default();
    let config = crate::sandbox::GitSandboxConfig {
        // Daemon-parity route: its body carries no org. A sandbox that has
        // already learned one keeps it via `merge_durable_config`.
        org_slug: None,
        virtual_mcp_id: body.virtual_mcp_id,
        clone_url: body.repo.clone_url,
        branch: body.repo.branch,
        runtime: workload.runtime,
        package_manager: workload.package_manager,
        package_manager_path: workload.package_manager_path,
        git_user_name: None,
        git_user_email: None,
    };
    if config.virtual_mcp_id.trim().is_empty() {
        return Err(ApiError::bad_request("virtualMcpId is required"));
    }
    if config.clone_url.trim().is_empty() {
        return Err(ApiError::bad_request("repo.cloneUrl is required"));
    }
    let sandbox = state
        .sandbox_manager
        .provision(&config)
        .await
        .map_err(ApiError::conflict)?;
    let record = state
        .sandbox_manager
        .registry_record(&sandbox.handle)
        .map_err(ApiError::internal)?
        .ok_or_else(|| ApiError::internal("ensured sandbox was not persisted"))?;
    Ok(Json(json!({
        "handle": sandbox.handle,
        "state": record.observed_status,
        "desiredStatus": record.desired_status,
    })))
}

/// Resolve the [`SandboxTarget`] a setup step should run against — see this
/// file's module doc for exactly how this differs from
/// [`AppState::resolve_sandbox_target`]: an explicit, UNKNOWN handle is a 404
/// here; a headerless request keeps the unchanged three-tier fallback. Used
/// by `clone`/`install`/[`stop`] — never resurrects (see [`stop`]'s doc
/// comment for why; `clone`/`install` simply haven't needed it, unlike
/// `start`, which uses [`resolve_for_start`] instead).
fn resolve(state: &AppState, headers: &HeaderMap) -> Result<SandboxTarget, ApiError> {
    match crate::sandbox::handle_from_headers(headers) {
        Some(handle) => state
            .sandbox_manager
            .get(handle)
            .map(|sb| SandboxTarget::from_sandbox(&sb))
            .ok_or_else(|| ApiError::not_found(format!("unknown sandbox handle: {handle}"))),
        None => Ok(state.resolve_sandbox_target(None)),
    }
}

/// [`start`]'s own resolver — see this file's module doc's "`start` also
/// self-heals..." section. Returns `(target, resurrected)`: `resurrected` is
/// `true` when this call is the one that just re-`ensure()`-d the target
/// (so `start` can skip its own kill+resume — the resurrection's own
/// `ensure()` cascade already covers it, see `start`'s body).
async fn resolve_for_start(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<(SandboxTarget, bool), ApiError> {
    match crate::sandbox::handle_from_headers(headers) {
        Some(handle) => {
            let already_known = state.sandbox_manager.get(handle).is_some();
            match state.sandbox_manager.resurrect(handle).await {
                Ok(Some(sb)) => Ok((SandboxTarget::from_sandbox(&sb), !already_known)),
                Ok(None) => Err(ApiError::not_found(format!(
                    "unknown sandbox handle: {handle}"
                ))),
                Err(err) => Err(ApiError::conflict(format!(
                    "sandbox handle {handle} could not be resurrected: {err}"
                ))),
            }
        }
        None => {
            let already_active = state.sandbox_manager.active().is_some();
            match state.sandbox_manager.resurrect_active().await {
                Ok(Some(sb)) => Ok((SandboxTarget::from_sandbox(&sb), !already_active)),
                Ok(None) => Ok((state.resolve_sandbox_target(None), false)),
                Err(err) => {
                    // Byte-parity floor: a headerless request must still 200
                    // even when self-heal itself fails — fall back to the
                    // existing (global) resolution rather than hard-erroring
                    // a fire-and-forget request. Logged so the failure isn't
                    // silent.
                    tracing::warn!(
                        error = %err,
                        "headerless sandbox resurrection failed; falling back to the process-global target"
                    );
                    Ok((state.resolve_sandbox_target(None), false))
                }
            }
        }
    }
}

pub async fn clone(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    if !resolve(&state, &headers)?.setup.resume_from(Step::Clone) {
        return Err(ApiError::new(
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            "setup worker is unavailable",
        ));
    }
    Ok(Json(json!({ "enqueued": Step::Clone.as_str() })))
}

pub async fn install(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    if !resolve(&state, &headers)?.setup.resume_from(Step::Install) {
        return Err(ApiError::new(
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            "setup worker is unavailable",
        ));
    }
    Ok(Json(json!({ "enqueued": Step::Install.as_str() })))
}

pub async fn start(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    let explicit_handle = crate::sandbox::handle_from_headers(&headers).map(str::to_owned);
    let (target, resurrected) = resolve_for_start(&state, &headers).await?;
    if resurrected {
        // `SandboxManager::ensure` (invoked by `resolve_for_start`'s
        // resurrection above) already ran its own clone/checkout -> install
        // -> start cascade against a FRESH `ConfigStore` — a restarted
        // process always classifies this as a "bootstrap" transition, never
        // "no-op" (see `ensure()`'s doc comment) — so this request already
        // got its real dev-server restart as a side effect of resurrection.
        // Nothing is running yet at this exact instant (the cascade's
        // Install step hasn't reached Start yet), so the kill-loop below
        // would find nothing to kill anyway; redundantly re-enqueuing
        // `Step::Start` on top of the cascade already in flight would race a
        // SECOND dev server onto a second port before the first is
        // confirmed running, orphaning it — the same leak class flagged for
        // a killed local-api's own children — so skip it.
        tracing::info!(
            "setup/start: target was just resurrected — its own ensure() cascade already covers this restart"
        );
    } else {
        let durable_handle = explicit_handle.or_else(|| {
            state
                .sandbox_manager
                .active()
                .map(|sandbox| sandbox.handle.clone())
        });
        if let Some(handle) = durable_handle {
            state
                .sandbox_manager
                .restart_registered(&handle)
                .await
                .map_err(ApiError::conflict)?
                .ok_or_else(|| ApiError::not_found(format!("unknown sandbox handle: {handle}")))?;
        } else {
            // Daemon-compatible process-global path: reap the old dev group
            // before admitting Start, just like the per-handle path above.
            crate::sandbox::manager::terminate_tasks_by_log_name(&target.tasks, &["dev", "start"])
                .await
                .map_err(ApiError::conflict)?;
            if !target.setup.resume_from(Step::Start) {
                return Err(ApiError::new(
                    axum::http::StatusCode::SERVICE_UNAVAILABLE,
                    "setup worker is unavailable",
                ));
            }
        }
    }
    Ok(Json(json!({ "enqueued": Step::Start.as_str() })))
}

/// `POST /_sandbox/setup/stop` — NEW, no daemon precedent and no byte-parity
/// target: kills the resolved target's running `dev`/`start` task(s) WITHOUT
/// re-spawning (unlike `start` above, which kills-then-resumes). Gives the
/// sandbox drawer's Stop button a real desktop-local action to call — see
/// the native desktop-runtime audit finding #1's
/// sibling bug: `stop()` (`sandbox-lifecycle-context.tsx`) had NO desktop
/// branch at all, only the cloud `SANDBOX_DELETE` path gated on a
/// `sandboxProviderKind` that's always `null` in Tauri.
///
/// A registered handle forgotten by this process is already stopped: its old
/// child lifetime ended with that process. We persist `desired=stopped` and
/// return an idempotent success without materializing the sandbox (which
/// would risk starting it). A truly unknown explicit handle remains a loud
/// 404. Headerless non-git daemon compatibility retains the legacy 400 when
/// there is no dev/start task to stop.
pub async fn stop(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    let explicit_handle = crate::sandbox::handle_from_headers(&headers).map(str::to_owned);
    let durable_handle = match explicit_handle {
        Some(handle) => Some(handle),
        None => state
            .sandbox_manager
            .active()
            .map(|sandbox| sandbox.handle.clone())
            .or(state
                .sandbox_manager
                .registered_active_handle()
                .map_err(ApiError::internal)?),
    };

    if let Some(handle) = durable_handle {
        let killed = state
            .sandbox_manager
            .stop_registered(&handle)
            .await
            .map_err(ApiError::internal)?
            .ok_or_else(|| ApiError::not_found(format!("unknown sandbox handle: {handle}")))?;
        return Ok(Json(json!({
            "stopped": true,
            "killed": killed,
            "alreadyStopped": killed == 0,
            "handle": handle,
        })));
    }

    // Daemon-compatible plain-path fallback for a non-git workspace.
    let target = state.resolve_sandbox_target(None);

    let mut killed = 0usize;
    for t in target.tasks.list(Some(&[TaskStatus::Running])) {
        if matches!(t.log_name.as_deref(), Some("dev") | Some("start"))
            && target.tasks.kill(&t.id, KillSignal::Term) == Some(true)
        {
            killed = killed.saturating_add(1);
        }
    }
    if killed == 0 {
        return Err(ApiError::bad_request(
            "nothing to stop: no running dev/start task for this sandbox",
        ));
    }
    // No new `LifecycleState` phase needed — `idle` is already the pre-clone
    // default (see `crate::setup`'s `LifecycleState` union), so the drawer's
    // SSE-driven status naturally reflects "stopped" without a wire-shape
    // change.
    target
        .setup
        .transition_lifecycle(json!({ "phase": "idle" }));
    Ok(Json(json!({
        "stopped": true,
        "killed": killed,
        "alreadyStopped": killed == 0,
        "handle": Value::Null,
    })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::ConfigStore;
    use crate::events::Broadcaster;
    use crate::setup::SetupOrchestrator;
    use crate::tasks::TaskRegistry;
    use axum::http::HeaderValue;
    use std::sync::Arc;

    fn fresh_state() -> AppState {
        fresh_state_at(std::env::temp_dir())
    }

    /// Parameterized twin of [`fresh_state`] — every test that exercises
    /// disk-persisted resurrection (`resolve_for_start`'s
    /// `SandboxManager::resurrect`/`resurrect_active`, backed by
    /// `sandbox::persist`) MUST use a UNIQUE `app_root` (never the shared
    /// `std::env::temp_dir()` [`fresh_state`] uses for its non-persisting
    /// callers), or concurrently-running tests would race on the SAME
    /// `<app_root>/sandboxes/.active-handle` file.
    fn fresh_state_at(app_root: std::path::PathBuf) -> AppState {
        let config = Arc::new(ConfigStore::new());
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
            sandbox_manager: crate::sandbox::SandboxManager::new(app_root.clone())
                .expect("registry opens in a fresh temp app root"),
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

    #[test]
    fn headerless_resolve_falls_back_to_the_global_target_when_nothing_is_active() {
        let state = fresh_state();
        let target = resolve(&state, &HeaderMap::new()).expect("headerless never errors");
        assert!(Arc::ptr_eq(&target.setup, &state.setup));
    }

    #[test]
    fn an_explicit_unknown_handle_is_a_404_not_a_silent_global_fallback() {
        let state = fresh_state();
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-decocms-sandbox-handle",
            HeaderValue::from_static("never-ensured-handle"),
        );
        // `SandboxTarget` (the `Ok` side) isn't `Debug`, so `expect_err`
        // isn't available here — match explicitly instead.
        match resolve(&state, &headers) {
            Err(e) => {
                assert_eq!(e.status, axum::http::StatusCode::NOT_FOUND);
                assert_eq!(
                    e.body["error"],
                    "unknown sandbox handle: never-ensured-handle"
                );
            }
            Ok(_) => panic!("unknown handle must error"),
        }
    }

    #[test]
    fn an_empty_handle_header_behaves_like_no_header_at_all() {
        let state = fresh_state();
        let mut headers = HeaderMap::new();
        headers.insert("x-decocms-sandbox-handle", HeaderValue::from_static(""));
        let target = resolve(&state, &headers).expect("empty handle is treated as absent");
        assert!(Arc::ptr_eq(&target.setup, &state.setup));
    }

    #[tokio::test]
    async fn setup_routes_return_503_when_the_worker_rejects_admission() {
        // `start` probes the durable active-sandbox pointer before falling back
        // to the process-global orchestrator. Give this test its own app root:
        // using the shared system temp directory can resurrect a sandbox left
        // by another test/process and accidentally exercise that open worker
        // instead of the deliberately closed global worker below.
        let root = tempfile::tempdir().unwrap();
        let state = fresh_state_at(root.path().to_path_buf());
        state.setup.close();

        for result in [
            clone(State(state.clone()), HeaderMap::new()).await,
            install(State(state.clone()), HeaderMap::new()).await,
            start(State(state.clone()), HeaderMap::new()).await,
        ] {
            let error = result.expect_err("closed setup worker must reject the request");
            assert_eq!(error.status, axum::http::StatusCode::SERVICE_UNAVAILABLE);
            assert_eq!(error.body["error"], "setup worker is unavailable");
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

    /// Mirrors `sandbox::target::tests::ensure_one_sandbox` — a real
    /// one-commit bare origin, `ensure()`-d into a fresh per-handle sandbox
    /// (which also marks it `active()`).
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
        git(&work_dir, &["init", "-q", "-b", "work"]);
        git(&work_dir, &["config", "user.name", "Test User"]);
        git(&work_dir, &["config", "user.email", "test@example.com"]);
        std::fs::write(work_dir.join("f.txt"), "x").unwrap();
        git(&work_dir, &["add", "."]);
        git(&work_dir, &["commit", "-q", "-m", "initial"]);
        let bare_str = bare_dir.to_str().unwrap();
        git(&work_dir, &["remote", "add", "origin", bare_str]);
        git(&work_dir, &["push", "-q", "-u", "origin", "work"]);
        git(&bare_dir, &["symbolic-ref", "HEAD", "refs/heads/work"]);

        state
            .sandbox_manager
            .ensure(&crate::sandbox::GitSandboxConfig {
                virtual_mcp_id: vmcp.to_string(),
                clone_url: bare_str.to_string(),
                branch: Some("work".to_string()),
                ..Default::default()
            })
            .await
            .expect("ensure succeeds against a real one-commit bare repo")
    }

    #[tokio::test]
    async fn ensure_route_accepts_desktop_sandbox_block_and_persists_identity() {
        let app_root = tempfile::tempdir().unwrap();
        let state = fresh_state_at(app_root.path().to_path_buf());
        let origin_root = tempfile::tempdir().unwrap();
        let bare_dir = origin_root.path().join("origin.git");
        let author_dir = origin_root.path().join("author");
        std::fs::create_dir_all(&bare_dir).unwrap();
        std::fs::create_dir_all(&author_dir).unwrap();
        git(&bare_dir, &["init", "--bare", "-q"]);
        git(&author_dir, &["init", "-q", "-b", "work"]);
        git(&author_dir, &["config", "user.name", "Test User"]);
        git(&author_dir, &["config", "user.email", "test@example.com"]);
        std::fs::write(author_dir.join("README.md"), "fixture").unwrap();
        git(&author_dir, &["add", "."]);
        git(&author_dir, &["commit", "-q", "-m", "initial"]);
        git(
            &author_dir,
            &["remote", "add", "origin", bare_dir.to_str().unwrap()],
        );
        git(&author_dir, &["push", "-q", "-u", "origin", "work"]);
        git(&bare_dir, &["symbolic-ref", "HEAD", "refs/heads/work"]);

        let response = ensure(
            State(state.clone()),
            Json(EnsureSandboxRequest {
                virtual_mcp_id: "vmcp-ensure-route".to_string(),
                repo: EnsureRepository {
                    clone_url: bare_dir.to_string_lossy().into_owned(),
                    branch: Some("work".to_string()),
                },
                workload: Some(EnsureWorkload {
                    runtime: Some("bun".to_string()),
                    package_manager: Some("bun".to_string()),
                    package_manager_path: None,
                }),
            }),
        )
        .await
        .expect("ensure durably registers and queues a real sandbox");

        let handle = response.0["handle"].as_str().unwrap();
        assert_eq!(
            handle,
            // From the clone URL the request actually used — the handle is
            // the repository scope, so any other URL names another worktree.
            crate::sandbox::SandboxManager::compute_handle(&bare_dir.to_string_lossy(), "work")
                .expect("scopeable clone url")
        );
        assert!(state.sandbox_manager.get(handle).is_some());
        assert_eq!(
            state
                .sandbox_manager
                .registered_active_handle()
                .unwrap()
                .as_deref(),
            Some(handle)
        );
        let record = state
            .sandbox_manager
            .registry_record(handle)
            .unwrap()
            .unwrap();
        assert_eq!(record.config.package_manager.as_deref(), Some("bun"));
        assert_eq!(record.desired_status, "running");
    }

    #[tokio::test]
    async fn ensure_route_returns_early_and_records_async_clone_failure() {
        let app_root = tempfile::tempdir().unwrap();
        let state = fresh_state_at(app_root.path().to_path_buf());
        let response = ensure(
            State(state.clone()),
            Json(EnsureSandboxRequest {
                virtual_mcp_id: "vmcp-broken-clone".to_string(),
                repo: EnsureRepository {
                    clone_url: app_root
                        .path()
                        .join("missing.git")
                        .to_string_lossy()
                        .into_owned(),
                    branch: Some("work".to_string()),
                },
                workload: None,
            }),
        )
        .await
        .expect("the control route returns before git so SSE can observe it");
        assert_eq!(response.0["state"], "provisioning");

        // Same clone URL the request used — the handle is the repository scope.
        let handle = crate::sandbox::SandboxManager::compute_handle(
            &app_root.path().join("missing.git").to_string_lossy(),
            "work",
        )
        .expect("scopeable clone url");
        let record = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let record = state
                    .sandbox_manager
                    .registry_record(&handle)
                    .unwrap()
                    .unwrap();
                if record.observed_status == "failed" {
                    break record;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("clone failure reaches durable lifecycle state");
        assert_eq!(record.observed_status, "failed");
        let error = record.error.unwrap();
        assert!(error.contains("git"), "unexpected clone failure: {error}");
    }

    #[tokio::test]
    async fn an_explicit_known_handle_resolves_to_that_sandboxs_own_setup() {
        let state = fresh_state();
        let sandbox = ensure_one_sandbox(&state, "setup-resolve-known").await;

        let mut headers = HeaderMap::new();
        headers.insert(
            "x-decocms-sandbox-handle",
            HeaderValue::from_str(&sandbox.handle).unwrap(),
        );
        let target = resolve(&state, &headers).expect("known handle resolves");
        assert!(Arc::ptr_eq(&target.setup, &sandbox.setup));
        assert_eq!(target.repo_dir, sandbox.workdir);
    }

    #[tokio::test]
    async fn headerless_resolve_prefers_the_active_sandbox_over_global() {
        let state = fresh_state();
        // `ensure()` marks its handle active, so a headerless resolve must
        // follow it — NOT fall all the way to the global orchestrator (see
        // `sandbox::target`'s equivalent coverage for `resolve_sandbox_target`
        // directly; this test pins the SAME behavior through this file's
        // stricter `resolve()` wrapper).
        let sandbox = ensure_one_sandbox(&state, "setup-resolve-active").await;

        let target = resolve(&state, &HeaderMap::new()).expect("headerless never errors");
        assert!(Arc::ptr_eq(&target.setup, &sandbox.setup));
        assert!(!Arc::ptr_eq(&target.setup, &state.setup));
    }

    // --- start(): resurrection after a simulated backend restart -----------

    /// `ensure()`s a real git sandbox into `app_root` via a THROWAWAY
    /// `AppState`/`SandboxManager`, then drops it — leaving only the
    /// workdir + persisted sidecar + `.active-handle` file on disk, exactly
    /// like a real backend process restart (same `LOCAL_API_WORKDIR`, brand
    /// new in-memory state). Returns the handle.
    async fn ensure_then_forget(app_root: &std::path::Path, vmcp: &str) -> String {
        let throwaway = fresh_state_at(app_root.to_path_buf());
        let sandbox = ensure_one_sandbox(&throwaway, vmcp).await;
        sandbox.handle.clone()
        // `throwaway` (and its `SandboxManager`) drops here — its in-memory
        // `sandboxes` map and `active_handle` go with it.
    }

    #[tokio::test]
    async fn start_resurrects_an_explicit_handle_forgotten_by_a_process_restart() {
        let app_root = tempfile::tempdir().unwrap();
        let handle = ensure_then_forget(app_root.path(), "start-resurrect-explicit").await;

        // A FRESH state over the SAME app_root — simulates the restarted
        // process: `state.sandbox_manager` has never heard of `handle`.
        let state = fresh_state_at(app_root.path().to_path_buf());
        assert!(state.sandbox_manager.get(&handle).is_none());

        let mut headers = HeaderMap::new();
        headers.insert(
            "x-decocms-sandbox-handle",
            HeaderValue::from_str(&handle).unwrap(),
        );
        let res = start(State(state.clone()), headers)
            .await
            .expect("start resurrects the forgotten handle instead of 404ing");
        assert_eq!(res.0["enqueued"], "start");
        assert!(
            state.sandbox_manager.get(&handle).is_some(),
            "a successful resurrection must leave the handle known in memory afterward"
        );
    }

    #[tokio::test]
    async fn start_headerless_resurrects_the_persisted_active_handle_after_a_restart() {
        let app_root = tempfile::tempdir().unwrap();
        let handle = ensure_then_forget(app_root.path(), "start-resurrect-headerless").await;

        let state = fresh_state_at(app_root.path().to_path_buf());
        assert!(state.sandbox_manager.active().is_none());

        let res = start(State(state.clone()), HeaderMap::new())
            .await
            .expect("headerless start resurrects the persisted active handle");
        assert_eq!(res.0["enqueued"], "start");
        assert!(
            state.sandbox_manager.get(&handle).is_some(),
            "the persisted active handle must be the one resurrected"
        );
    }

    #[tokio::test]
    async fn start_with_an_explicit_handle_that_has_no_sidecar_is_still_a_404() {
        // Regression guard: resurrection must not turn a GENUINELY unknown
        // handle (never `ensure()`-d in ANY process lifetime — no sidecar
        // exists at all) into a silent success.
        let app_root = tempfile::tempdir().unwrap();
        let state = fresh_state_at(app_root.path().to_path_buf());
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-decocms-sandbox-handle",
            HeaderValue::from_static("never-ensured-handle"),
        );
        match start(State(state), headers).await {
            Err(e) => {
                assert_eq!(e.status, axum::http::StatusCode::NOT_FOUND);
                assert_eq!(
                    e.body["error"],
                    "unknown sandbox handle: never-ensured-handle"
                );
            }
            Ok(_) => panic!("a handle with no sidecar must never silently succeed"),
        }
    }

    #[tokio::test]
    async fn start_headerless_on_a_fresh_instance_with_nothing_persisted_still_200s_the_global_path(
    ) {
        // Byte-parity floor (`daemon.git.e2e.test.ts`'s "setup routes"
        // describe): a headerless start on a process that has NEVER seen a
        // git sandbox (no active handle ever persisted) must still ack 200
        // against the process-global path, not error.
        let app_root = tempfile::tempdir().unwrap();
        let state = fresh_state_at(app_root.path().to_path_buf());
        let res = start(State(state), HeaderMap::new())
            .await
            .expect("headerless start on a never-configured instance still 200s");
        assert_eq!(res.0["enqueued"], "start");
    }

    #[tokio::test]
    async fn start_does_not_resurrect_when_the_handle_is_already_known_in_memory() {
        // The "already known" (not-resurrected) branch must keep the
        // PRE-EXISTING kill+resume_from(Start) behavior — this is really a
        // guard that `resolve_for_start`'s `already_known`/`already_active`
        // computation doesn't accidentally flip `resurrected` to `true` for
        // the common, non-restart case.
        let state = fresh_state();
        let sandbox = ensure_one_sandbox(&state, "start-no-resurrect-needed").await;
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-decocms-sandbox-handle",
            HeaderValue::from_str(&sandbox.handle).unwrap(),
        );
        let res = start(State(state.clone()), headers)
            .await
            .expect("start on an already-known handle succeeds");
        assert_eq!(res.0["enqueued"], "start");
        assert!(Arc::ptr_eq(
            &state.sandbox_manager.get(&sandbox.handle).unwrap(),
            &sandbox
        ));
    }

    #[tokio::test]
    async fn start_with_a_truly_unknown_explicit_handle_is_a_404() {
        let root = tempfile::tempdir().unwrap();
        let state = fresh_state_at(root.path().to_path_buf());
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-decocms-sandbox-handle",
            HeaderValue::from_static("never-registered"),
        );
        let error = start(State(state), headers)
            .await
            .expect_err("explicit start must not fall back to the global setup worker");
        assert_eq!(error.status, axum::http::StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn restart_waits_for_old_dev_task_to_be_terminal_before_admitting_start() {
        let root = tempfile::tempdir().unwrap();
        let state = fresh_state_at(root.path().to_path_buf());
        let controller = crate::tasks::ProcessController::new();
        state.tasks.insert(crate::tasks::TaskEntry::new(
            crate::tasks::TaskSummary {
                id: "old-dev".to_string(),
                command: "bun run dev".to_string(),
                status: TaskStatus::Running,
                exit_code: None,
                started_at: 0,
                finished_at: None,
                timed_out: false,
                truncated: false,
                log_name: Some("dev".to_string()),
                intentional: None,
            },
            Some(controller.kill_handle()),
        ));
        let owner = {
            let tasks = state.tasks.clone();
            let controller = controller.clone();
            tokio::spawn(async move {
                let signal = controller.wait_for_change(None).await;
                tokio::task::yield_now().await;
                tasks.finalize("old-dev", TaskStatus::Killed, signal.exit_code(), false);
            })
        };

        let response = start(State(state.clone()), HeaderMap::new())
            .await
            .expect("restart reaps the old task before queueing Start");
        assert_eq!(response.0["enqueued"], "start");
        owner.await.unwrap();
        assert_eq!(
            state.tasks.get("old-dev").unwrap().status,
            TaskStatus::Killed
        );
        assert_eq!(controller.requested(), Some(KillSignal::Term));
    }

    // --- stop() --------------------------------------------------------------

    fn insert_running_task(
        state: &AppState,
        id: &str,
        log_name: Option<&str>,
    ) -> Arc<std::sync::atomic::AtomicBool> {
        let killed = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = killed.clone();
        let kill_handle: crate::tasks::KillHandle = Arc::new(move |_sig| {
            flag.store(true, std::sync::atomic::Ordering::SeqCst);
            true
        });
        let summary = crate::tasks::TaskSummary {
            id: id.to_string(),
            command: "npm run dev".to_string(),
            status: crate::tasks::TaskStatus::Running,
            exit_code: None,
            started_at: 0,
            finished_at: None,
            timed_out: false,
            truncated: false,
            log_name: log_name.map(str::to_string),
            intentional: None,
        };
        state
            .tasks
            .insert(crate::tasks::TaskEntry::new(summary, Some(kill_handle)));
        killed
    }

    #[tokio::test]
    async fn stop_kills_the_running_dev_task_and_reports_the_killed_count() {
        let state = fresh_state();
        let killed_flag = insert_running_task(&state, "task-dev-1", Some("dev"));

        let res = stop(State(state.clone()), HeaderMap::new())
            .await
            .expect("stop succeeds when a dev task is running");
        assert_eq!(res.0["stopped"], true);
        assert_eq!(res.0["killed"], 1);
        assert!(
            killed_flag.load(std::sync::atomic::Ordering::SeqCst),
            "the task's real KillHandle must have been invoked"
        );
        assert_eq!(
            state.setup.lifecycle_snapshot()["phase"],
            "idle",
            "stop transitions lifecycle back to idle"
        );
    }

    #[tokio::test]
    async fn stop_kills_a_running_start_task_too() {
        // `log_name: "start"` (byte-parity script name for a starter script
        // literally named "start" rather than "dev") must be treated the
        // same as "dev" — mirrors `start()`'s own kill-loop filter.
        let state = fresh_state();
        let killed_flag = insert_running_task(&state, "task-start-1", Some("start"));
        let res = stop(State(state), HeaderMap::new())
            .await
            .expect("stop succeeds for a 'start'-named task too");
        assert_eq!(res.0["killed"], 1);
        assert!(killed_flag.load(std::sync::atomic::Ordering::SeqCst));
    }

    #[tokio::test]
    async fn stop_returns_a_400_when_nothing_is_running() {
        let state = fresh_state();
        match stop(State(state), HeaderMap::new()).await {
            Err(e) => {
                assert_eq!(e.status, axum::http::StatusCode::BAD_REQUEST);
                assert!(e.body["error"]
                    .as_str()
                    .unwrap()
                    .contains("nothing to stop"));
            }
            Ok(_) => panic!("stop with nothing running must error, never silently 200"),
        }
    }

    #[tokio::test]
    async fn stop_ignores_running_tasks_that_are_not_dev_or_start() {
        let state = fresh_state();
        let killed_flag = insert_running_task(&state, "task-bash-1", Some("bash"));
        match stop(State(state), HeaderMap::new()).await {
            Err(e) => assert_eq!(e.status, axum::http::StatusCode::BAD_REQUEST),
            Ok(_) => panic!("an unrelated running task must not count as something to stop"),
        }
        assert!(
            !killed_flag.load(std::sync::atomic::Ordering::SeqCst),
            "an unrelated task must never be killed by a Stop click"
        );
    }

    #[tokio::test]
    async fn stop_with_an_explicit_unknown_handle_is_a_404_never_a_silent_noop() {
        let state = fresh_state();
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-decocms-sandbox-handle",
            HeaderValue::from_static("never-ensured-handle"),
        );
        match stop(State(state), headers).await {
            Err(e) => assert_eq!(e.status, axum::http::StatusCode::NOT_FOUND),
            Ok(_) => panic!("stop must never silently succeed against an unresolvable handle"),
        }
    }

    #[tokio::test]
    async fn stop_is_idempotent_for_a_registered_handle_after_process_restart() {
        let app_root = tempfile::tempdir().unwrap();
        let handle = ensure_then_forget(app_root.path(), "stop-no-resurrect").await;
        let state = fresh_state_at(app_root.path().to_path_buf());

        let mut headers = HeaderMap::new();
        headers.insert(
            "x-decocms-sandbox-handle",
            HeaderValue::from_str(&handle).unwrap(),
        );
        let response = stop(State(state.clone()), headers)
            .await
            .expect("a registered sandbox with no live process is already stopped");
        assert_eq!(response.0["stopped"], true);
        assert_eq!(response.0["alreadyStopped"], true);
        assert_eq!(response.0["killed"], 0);
        assert!(
            state.sandbox_manager.get(&handle).is_none(),
            "stop must not materialize or start the persisted sandbox"
        );
        let record = state
            .sandbox_manager
            .registry_record(&handle)
            .unwrap()
            .unwrap();
        assert_eq!(record.desired_status, "stopped");
        assert_eq!(record.observed_status, "stopped");
    }
}
