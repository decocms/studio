//! Native interception for the production shell's org-scoped sandbox
//! filesystem routes.
//!
//! The shared web UI addresses filesystem operations through
//! `/api/:org/sandbox/:virtualMcpId/:branch/:operation`. In the browser that
//! route belongs to mesh, which resolves a hosted or `deco link` sandbox. In
//! the native app the same request first reaches local-api's app-API fallback;
//! forwarding it upstream would ask the cluster for a claim that cannot see
//! this Mac's durable sandbox registry.
//!
//! This module terminates the file family locally. Identity comes only from
//! the URL's `(virtualMcpId, branch)` pair: compute the native handle, look it
//! up in SQLite, and metadata-adopt its worktree after a process restart. An
//! unknown identity never falls back to the active or process-global sandbox,
//! because a filesystem mutation against the wrong chat is worse than a loud
//! 404.

use std::path::Path;

use axum::body::Bytes;
use axum::extract::State;
use axum::http::{Method, StatusCode};
use axum::response::{IntoResponse, Response};

use crate::error::ApiError;
use crate::sandbox::manager::Sandbox;
use crate::state::AppState;

use super::sandbox_authority::{authorize, manager_error, Access};

const OPERATIONS: &[&str] = &["read", "write", "unlink", "mkdir", "rename", "glob", "grep"];

pub(super) async fn try_dispatch(
    state: &AppState,
    method: &Method,
    org: &str,
    rest: &[&str],
    body: &Bytes,
) -> Option<Response> {
    let ["sandbox", encoded_virtual_mcp_id, encoded_branch, operation] = rest else {
        return None;
    };
    if !OPERATIONS.contains(operation) {
        return None;
    }
    let virtual_mcp_id = match decode_identity_segment("virtualMcpId", encoded_virtual_mcp_id) {
        Ok(value) => value,
        Err(error) => return Some(error.into_response()),
    };
    let branch = match decode_identity_segment("branch", encoded_branch) {
        Ok(value) => value,
        Err(error) => return Some(error.into_response()),
    };
    let access = access_for(method, operation);
    let read_only = matches!(*operation, "read" | "glob" | "grep");
    let authorization = match authorize(state, org, &virtual_mcp_id, &branch, access).await {
        Ok(authorization) => authorization,
        Err(error) => return Some(error.into_response()),
    };
    let account_epoch = authorization.account_epoch();
    if *method != Method::POST {
        return Some(
            ApiError::new(
                StatusCode::METHOD_NOT_ALLOWED,
                format!("method not allowed for sandbox filesystem operation: {method}"),
            )
            .into_response(),
        );
    }
    if *operation == "read" {
        if let Some(error) = reject_absolute_read(body) {
            return Some(error.into_response());
        }
    }
    // Keyed by (virtualMcpId, branch) in the URL, but the worktree handle is
    // derived from the REPOSITORY — the registry is what bridges them.
    let handle = match state.sandbox_manager.handle_for_virtual_mcp_for_account(
        account_epoch,
        &virtual_mcp_id,
        &branch,
    ) {
        Ok(Some(handle)) => handle,
        Ok(None) => {
            return Some(
                ApiError::not_found(format!("sandbox not found: {virtual_mcp_id}@{branch}"))
                    .into_response(),
            )
        }
        Err(error) => return Some(manager_error(error).into_response()),
    };

    let record = match state
        .sandbox_manager
        .registry_record_for_account(account_epoch, &handle)
    {
        Ok(Some(record)) => record,
        Ok(None) => {
            return Some(
                ApiError::not_found(format!("sandbox not found: {handle}")).into_response(),
            )
        }
        Err(error) => return Some(manager_error(error).into_response()),
    };
    if record.observed_status == "absent" {
        return Some(
            ApiError::not_found(format!("sandbox worktree not found: {handle}")).into_response(),
        );
    }

    let sandbox = match state
        .sandbox_manager
        .adopt_for_account(account_epoch, &handle)
        .await
    {
        Ok(Some(sandbox)) => sandbox,
        Ok(None) => {
            return Some(
                ApiError::not_found(format!("sandbox not found: {handle}")).into_response(),
            )
        }
        Err(error) => return Some(manager_error(error).into_response()),
    };
    let repo_probe = if read_only && sandbox.tasks.is_admission_closed() {
        // Archive/stop closes generation task admission, but the durable
        // worktree deliberately remains available for read-only inspection.
        // Do not reopen the generation merely to spawn a Git probe; the fs
        // handlers below still clamp every path to this exact worktree.
        Ok(true)
    } else {
        crate::routes::git::owned_is_git_repo(sandbox.tasks.clone(), record.workdir_path.clone())
            .await
    };
    match repo_probe {
        Ok(true) => {}
        Ok(false) if sandbox.tasks.is_admission_closed() => {
            return Some(ApiError::conflict("sandbox generation is stopped").into_response())
        }
        Ok(false) => {
            return Some(
                ApiError::not_found(format!("sandbox worktree not found: {handle}"))
                    .into_response(),
            )
        }
        Err(_) if sandbox.tasks.is_admission_closed() => {
            return Some(ApiError::conflict("sandbox generation is stopped").into_response())
        }
        Err(error) => {
            return Some(
                ApiError::internal(format!(
                    "could not inspect sandbox worktree {handle}: {error}"
                ))
                .into_response(),
            )
        }
    }
    let target_state = state_for_sandbox(state, &sandbox);
    let body = body.clone();

    let response = match *operation {
        "read" => crate::routes::fs::read(State(target_state), body).await,
        "write" => crate::routes::fs::write(State(target_state), body).await,
        "unlink" => crate::routes::fs::unlink(State(target_state), body).await,
        "mkdir" => crate::routes::fs::mkdir(State(target_state), body).await,
        "rename" => crate::routes::fs::rename(State(target_state), body).await,
        "glob" => crate::routes::fs::glob(State(target_state), body).await,
        "grep" => crate::routes::fs::grep(State(target_state), body).await,
        _ => unreachable!("operation was checked against OPERATIONS"),
    };
    if read_only {
        if let Err(error) = state.sandbox_manager.validate_account_epoch(account_epoch) {
            return Some(manager_error(error).into_response());
        }
    }
    Some(response)
}

fn access_for(method: &Method, operation: &str) -> Access {
    if *method != Method::POST {
        return Access::Viewer;
    }
    match operation {
        "write" | "unlink" | "mkdir" | "rename" => Access::WorkspaceMutation,
        "read" | "glob" | "grep" => Access::Viewer,
        _ => Access::Viewer,
    }
}

pub(super) fn decode_identity_segment(label: &str, encoded: &str) -> Result<String, ApiError> {
    let decoded = urlencoding::decode(encoded)
        .map_err(|error| ApiError::bad_request(format!("invalid {label}: {error}")))?;
    if decoded.is_empty() {
        return Err(ApiError::bad_request(format!("{label} is required")));
    }
    Ok(decoded.into_owned())
}

fn reject_absolute_read(body: &Bytes) -> Option<ApiError> {
    let value: serde_json::Value = serde_json::from_slice(body).ok()?;
    let path = value.get("path")?.as_str()?;
    if Path::new(path).is_absolute() {
        return Some(ApiError::bad_request(
            "absolute paths are not allowed through the native sandbox bridge",
        ));
    }
    None
}

pub(super) fn state_for_sandbox(state: &AppState, sandbox: &Sandbox) -> AppState {
    let mut target = state.clone();
    // Keep daemon-compat `/_sandbox/*` semantics unchanged, but narrow the
    // production-shell bridge to this handle's own managed root. Leaving the
    // process-wide app root here would let `../../<sibling-handle>/repo/...`
    // pass the lexical clamp in `fs::safe_path`.
    target.app_root = sandbox
        .workdir
        .parent()
        .unwrap_or(&sandbox.workdir)
        .to_path_buf();
    target.repo_dir = sandbox.workdir.clone();
    target.config = sandbox.config.clone();
    target.tasks = sandbox.tasks.clone();
    target.broadcaster = sandbox.broadcaster.clone();
    target.setup = sandbox.setup.clone();
    target
}

#[cfg(test)]
mod tests {
    use axum::body::to_bytes;
    use serde_json::{json, Value};

    use super::*;
    use crate::sandbox::GitSandboxConfig;

    #[test]
    fn filesystem_access_distinguishes_reads_from_mutations() {
        for operation in ["write", "unlink", "mkdir", "rename"] {
            assert_eq!(
                access_for(&Method::POST, operation),
                Access::WorkspaceMutation,
                "{operation} mutates the workspace"
            );
        }
        for operation in ["read", "glob", "grep"] {
            assert_eq!(
                access_for(&Method::POST, operation),
                Access::Viewer,
                "{operation} is read-only"
            );
        }
        assert_eq!(access_for(&Method::GET, "write"), Access::Viewer);
    }

    fn git(dir: &Path, args: &[&str]) {
        let output = std::process::Command::new("git")
            .args(args)
            .current_dir(dir)
            .output()
            .expect("git must spawn");
        assert!(
            output.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    async fn ensure_sandbox(
        state: &AppState,
        virtual_mcp_id: &str,
        branch: &str,
    ) -> std::sync::Arc<Sandbox> {
        let source = tempfile::tempdir().expect("source tempdir");
        let bare = source.path().join("origin.git");
        let author = source.path().join("author");
        std::fs::create_dir_all(&bare).unwrap();
        std::fs::create_dir_all(&author).unwrap();
        git(&bare, &["init", "--bare", "-q"]);
        git(&author, &["init", "-q", "-b", "main"]);
        git(&author, &["config", "user.name", "Native Test"]);
        git(&author, &["config", "user.email", "native@example.com"]);
        std::fs::write(author.join("README.md"), "fixture\n").unwrap();
        git(&author, &["add", "."]);
        git(&author, &["commit", "-q", "-m", "initial"]);
        if branch != "main" {
            git(&author, &["checkout", "-q", "-b", branch]);
        }
        let bare_string = bare.to_string_lossy().into_owned();
        git(&author, &["remote", "add", "origin", &bare_string]);
        git(&author, &["push", "-q", "-u", "origin", branch]);
        if branch == "main" {
            git(&bare, &["symbolic-ref", "HEAD", "refs/heads/main"]);
        }

        let (_cancel_tx, cancel_rx) = tokio::sync::watch::channel(false);
        state
            .sandbox_manager
            .ensure_for_terminal(
                state.sandbox_manager.account_epoch(),
                &GitSandboxConfig {
                    virtual_mcp_id: virtual_mcp_id.to_string(),
                    clone_url: bare_string,
                    branch: Some(branch.to_string()),
                    ..Default::default()
                },
                cancel_rx,
                false,
            )
            .await
            .expect("sandbox ensure")
    }

    async fn response_json(response: Response) -> Value {
        let bytes = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("response body");
        serde_json::from_slice(&bytes).expect("JSON response")
    }

    #[tokio::test]
    async fn encoded_identity_writes_only_to_the_exact_sandbox_worktree() {
        let root = tempfile::tempdir().unwrap();
        let global_repo = root.path().join("repo");
        std::fs::create_dir_all(&global_repo).unwrap();
        let state = super::super::test_state(root.path());
        let sandbox = ensure_sandbox(&state, "vir_blocks", "feature/blocks").await;

        let response = try_dispatch(
            &state,
            &Method::POST,
            "acme",
            &["sandbox", "vir_blocks", "feature%2Fblocks", "write"],
            &Bytes::from(
                serde_json::to_vec(&json!({
                    "path": ".deco/blocks/home.json",
                    "content": "{\"name\":\"Home\"}"
                }))
                .unwrap(),
            ),
        )
        .await
        .expect("filesystem route is intercepted");

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            std::fs::read_to_string(sandbox.workdir.join(".deco/blocks/home.json")).unwrap(),
            "{\"name\":\"Home\"}"
        );
        assert!(!global_repo.join(".deco/blocks/home.json").exists());
    }

    #[tokio::test]
    async fn stopped_metadata_adoption_rejects_writes_until_explicit_provision() {
        let root = tempfile::tempdir().unwrap();
        let first_state = super::super::test_state(root.path());
        let sandbox = ensure_sandbox(&first_state, "vir_restart", "main").await;
        let workdir = sandbox.workdir.clone();
        let handle = sandbox.handle.clone();
        first_state
            .sandbox_manager
            .stop_registered_for_account(first_state.sandbox_manager.account_epoch(), &handle)
            .await
            .expect("stop registered sandbox");
        drop(sandbox);
        drop(first_state);

        let restarted_state = super::super::test_state(root.path());
        let restarted_epoch = restarted_state.sandbox_manager.account_epoch();
        assert!(
            restarted_state
                .sandbox_manager
                .get_for_account(restarted_epoch, &handle)
                .unwrap()
                .is_none(),
            "fresh manager starts with an empty live-object cache"
        );
        let stopped_response = try_dispatch(
            &restarted_state,
            &Method::POST,
            "acme",
            &["sandbox", "vir_restart", "main", "write"],
            &Bytes::from(
                serde_json::to_vec(&json!({
                    "path": ".deco/blocks/restarted.json",
                    "content": "{\"survived\":true}"
                }))
                .unwrap(),
            ),
        )
        .await
        .expect("filesystem route is intercepted");

        assert_eq!(stopped_response.status(), StatusCode::CONFLICT);
        assert!(
            restarted_state
                .sandbox_manager
                .get_for_account(restarted_epoch, &handle)
                .unwrap()
                .is_some(),
            "the durable sandbox was metadata-adopted"
        );
        assert!(
            !workdir.join(".deco/blocks/restarted.json").exists(),
            "metadata adoption must not silently reopen write admission"
        );

        let config = restarted_state
            .sandbox_manager
            .registry_record_for_account(restarted_epoch, &handle)
            .unwrap()
            .unwrap()
            .config;
        let resumed = restarted_state
            .sandbox_manager
            .provision_for_account(restarted_epoch, &config)
            .await
            .expect("explicit provision installs a fresh open generation");
        assert!(!resumed.tasks.is_admission_closed());
        let resumed_response = try_dispatch(
            &restarted_state,
            &Method::POST,
            "acme",
            &["sandbox", "vir_restart", "main", "write"],
            &Bytes::from(
                serde_json::to_vec(&json!({
                    "path": ".deco/blocks/restarted.json",
                    "content": "{\"survived\":true}"
                }))
                .unwrap(),
            ),
        )
        .await
        .expect("filesystem route is intercepted after resume");
        assert_eq!(resumed_response.status(), StatusCode::OK);
        assert_eq!(
            std::fs::read_to_string(workdir.join(".deco/blocks/restarted.json")).unwrap(),
            "{\"survived\":true}"
        );
    }

    #[tokio::test]
    async fn unknown_identity_is_a_404_and_never_falls_back_to_global_repo() {
        let root = tempfile::tempdir().unwrap();
        let global_repo = root.path().join("repo");
        std::fs::create_dir_all(&global_repo).unwrap();
        let state = super::super::test_state(root.path());

        let response = try_dispatch(
            &state,
            &Method::POST,
            "acme",
            &["sandbox", "never_seen", "main", "write"],
            &Bytes::from(
                serde_json::to_vec(&json!({
                    "path": "wrong-target.json",
                    "content": "must not be written"
                }))
                .unwrap(),
            ),
        )
        .await
        .expect("filesystem route is intercepted");

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert!(response_json(response).await["error"]
            .as_str()
            .is_some_and(|message| message.starts_with("sandbox not found:")));
        assert!(!global_repo.join("wrong-target.json").exists());
    }

    #[tokio::test]
    async fn traversal_cannot_cross_into_a_sibling_sandbox() {
        let root = tempfile::tempdir().unwrap();
        let state = super::super::test_state(root.path());
        let first = ensure_sandbox(&state, "vir_first", "main").await;
        let second = ensure_sandbox(&state, "vir_second", "main").await;
        let protected = second.workdir.join("protected.json");
        std::fs::write(&protected, "original").unwrap();
        let cross_sandbox_path = format!("../../{}/repo/protected.json", second.handle);

        let response = try_dispatch(
            &state,
            &Method::POST,
            "acme",
            &["sandbox", "vir_first", "main", "write"],
            &Bytes::from(
                serde_json::to_vec(&json!({
                    "path": cross_sandbox_path,
                    "content": "overwritten"
                }))
                .unwrap(),
            ),
        )
        .await
        .expect("filesystem route is intercepted");

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(std::fs::read_to_string(protected).unwrap(), "original");
        assert!(!first.workdir.join("protected.json").exists());
    }

    #[tokio::test]
    async fn bridge_rejects_absolute_reads_without_changing_daemon_compat_route() {
        let root = tempfile::tempdir().unwrap();
        let global_repo = root.path().join("repo");
        std::fs::create_dir_all(&global_repo).unwrap();
        let secret = root.path().join("host-secret.txt");
        std::fs::write(&secret, "host secret").unwrap();
        let state = super::super::test_state(root.path());
        let _sandbox = ensure_sandbox(&state, "vir_read", "main").await;
        let body = Bytes::from(
            serde_json::to_vec(&json!({
                "path": secret.to_string_lossy(),
                "full": true
            }))
            .unwrap(),
        );

        let bridged = try_dispatch(
            &state,
            &Method::POST,
            "acme",
            &["sandbox", "vir_read", "main", "read"],
            &body,
        )
        .await
        .expect("filesystem route is intercepted");
        assert_eq!(bridged.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            response_json(bridged).await["error"],
            "absolute paths are not allowed through the native sandbox bridge"
        );

        // The direct daemon-parity endpoint still uses fs::resolve_read_path's
        // absolute-path contract. Only the production-shell bridge is tighter.
        let direct = crate::routes::fs::read(State(state), body).await;
        assert_eq!(direct.status(), StatusCode::OK);
        assert!(response_json(direct).await["content"]
            .as_str()
            .is_some_and(|content| content.contains("host secret")));
    }

    #[tokio::test]
    async fn recognized_filesystem_operation_rejects_the_wrong_method_locally() {
        let root = tempfile::tempdir().unwrap();
        let state = super::super::test_state(root.path());
        let response = try_dispatch(
            &state,
            &Method::GET,
            "acme",
            &["sandbox", "vir_blocks", "main", "write"],
            &Bytes::new(),
        )
        .await
        .expect("filesystem route is intercepted");

        assert_eq!(response.status(), StatusCode::METHOD_NOT_ALLOWED);
    }
}
