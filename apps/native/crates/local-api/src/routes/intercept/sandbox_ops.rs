//! The rest of `/api/:org/sandbox/:virtualMcpId/:branch/*` — config, git,
//! scripts, setup and preview-fetch — served from THIS machine.
//!
//! ## Why these are intercepted
//!
//! The webview calls the cloud's sandbox-proxy shape for everything. For a
//! desktop-run agent the sandbox is a set of child processes here, so any of
//! these that reaches upstream asks about a sandbox that does not exist and
//! comes back `502 Preview not available` — which is exactly how the missing
//! `preview-invoke` surfaced. Every route below already has a working local
//! implementation; it was simply never wired to the path shape the UI calls.
//!
//! ## One table, not one interceptor per route
//!
//! `sandbox_fs` established the mechanism (decode the identity segments,
//! `compute_handle`, `adopt`, then [`state_for_sandbox`] so the existing
//! handler resolves to THAT sandbox without a header). This module reuses it
//! for the remaining routes, so adding one is a match arm rather than a file —
//! and nothing can be silently forgotten the way `preview-invoke` was.
//!
//! The handlers themselves are called, never modified: `/_sandbox/setup/*` is
//! byte-parity-pinned by the daemon-parity suite, and these are simply a
//! second caller of the same code.

use axum::body::Bytes;
use axum::extract::{Path as AxumPath, State};
use axum::http::{HeaderMap, Method, StatusCode};
use axum::response::{IntoResponse, Response};

use super::sandbox_fs::{decode_identity_segment, state_for_sandbox};
use crate::error::ApiError;
use crate::state::AppState;

pub(super) async fn try_dispatch(
    state: &AppState,
    method: &Method,
    rest: &[&str],
    query: Option<&str>,
    body: &Bytes,
) -> Option<Response> {
    let (["sandbox", encoded_virtual_mcp_id, encoded_branch], tail) = rest.split_at_checked(3)?
    else {
        return None;
    };
    if tail.is_empty() || !is_handled(tail) {
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

    // Keyed by (virtualMcpId, branch) in the URL, but the worktree handle is
    // derived from the REPOSITORY — the registry is what bridges them.
    let handle = match state
        .sandbox_manager
        .handle_for_agent(&virtual_mcp_id, &branch)
    {
        Ok(Some(handle)) => handle,
        Ok(None) => {
            return Some(
                ApiError::not_found(format!("sandbox not found: {virtual_mcp_id}@{branch}"))
                    .into_response(),
            )
        }
        Err(error) => return Some(ApiError::internal(error).into_response()),
    };
    let sandbox = match state.sandbox_manager.adopt(&handle).await {
        Ok(Some(sandbox)) => sandbox,
        Ok(None) => {
            return Some(
                ApiError::not_found(format!("sandbox not found: {handle}")).into_response(),
            )
        }
        Err(error) => {
            return Some(
                ApiError::internal(format!("failed to adopt sandbox {handle}: {error}"))
                    .into_response(),
            )
        }
    };
    let target = state_for_sandbox(state, &sandbox);
    Some(route(&target, method, tail, query, body.clone(), &handle).await)
}

/// Whether this module owns `tail`. Checked BEFORE the sandbox is adopted, so
/// an unrelated route still falls through to the upstream proxy untouched
/// rather than 404ing on a sandbox it never needed.
fn is_handled(tail: &[&str]) -> bool {
    matches!(
        tail,
        ["config"]
            | ["preview-fetch"]
            | ["git", _]
            | ["setup", _]
            | ["exec", _]
            | ["exec", _, "kill"]
    )
}

async fn route(
    target: &AppState,
    method: &Method,
    tail: &[&str],
    query: Option<&str>,
    body: Bytes,
    handle: &str,
) -> Response {
    let state = State(target.clone());
    // The handle MUST be carried in the header, not left to `state_for_sandbox`.
    //
    // That helper retargets `repo_dir`/`config`/`setup`/`tasks`, which is
    // enough for the handlers that read those fields (`config`, `git/*`,
    // `preview-fetch`) — but `setup/*` and `exec/*` resolve their sandbox
    // through `sandbox_manager`, which it deliberately does NOT rewrite. With
    // an empty map those fell back to `sandbox_manager.active()`, so Stop /
    // Restart / exec issued against a URL naming sandbox A operated on
    // whichever sandbox happened to be active — and answered 200. In a
    // multi-sandbox launcher that is the worst possible failure: destructive,
    // silent, and addressed at the wrong tenant.
    let mut headers = HeaderMap::new();
    if let Ok(value) = axum::http::HeaderValue::from_str(handle) {
        headers.insert(crate::sandbox::SANDBOX_HANDLE_HEADER, value);
    }

    match (method, tail) {
        (&Method::GET, ["config"]) => crate::routes::config::read(state).await.into_response(),
        (&Method::PUT, ["config"]) => crate::routes::config::update(state, body).await,

        (&Method::GET, ["preview-fetch"]) => preview_fetch(target, query).await,

        (&Method::GET, ["git", "status"]) => {
            crate::routes::git::status(state).await.into_response()
        }
        (&Method::POST, ["git", "status"]) => {
            crate::routes::git::status(state).await.into_response()
        }
        (&Method::POST, ["git", "diff"]) => {
            crate::routes::git::diff(state, body).await.into_response()
        }
        // Held for the duration of the git command: these three mutate the
        // worktree on disk, and `SandboxManager::remove_registered` (reclaim on
        // last-thread archive) deletes that same directory under this handle's
        // lock. Without holding it here too, a reclaim can `rm -rf` the
        // worktree out from under an in-flight publish/discard/rebase.
        (&Method::POST, ["git", "publish"]) => {
            let handle_lock = target.sandbox_manager.handle_lock(handle);
            let _guard = handle_lock.lock().await;
            crate::routes::git::publish(state, body)
                .await
                .into_response()
        }
        (&Method::POST, ["git", "discard"]) => {
            let handle_lock = target.sandbox_manager.handle_lock(handle);
            let _guard = handle_lock.lock().await;
            crate::routes::git::discard(state, body)
                .await
                .into_response()
        }
        (&Method::POST, ["git", "rebase"]) => {
            let handle_lock = target.sandbox_manager.handle_lock(handle);
            let _guard = handle_lock.lock().await;
            crate::routes::git::rebase(state, body)
                .await
                .into_response()
        }

        // The two AI-assisted endpoints. Mesh's handlers guard on a VM claim
        // this machine's sandboxes never have (`requireRunner` → 503), so
        // forwarding cannot work; each answers with mesh's OWN no-LLM
        // degradation instead — see `git_assist`'s module doc.
        (&Method::POST, ["git", "suggest-commit"]) => super::git_assist::suggest_commit(&body),
        (&Method::POST, ["git", "judge-review"]) => super::git_assist::judge_review(),

        (&Method::POST, ["setup", "clone"]) => crate::routes::setup::clone(state, headers)
            .await
            .into_response(),
        (&Method::POST, ["setup", "install"]) => crate::routes::setup::install(state, headers)
            .await
            .into_response(),
        (&Method::POST, ["setup", "start"]) => crate::routes::setup::start(state, headers)
            .await
            .into_response(),
        (&Method::POST, ["setup", "stop"]) => crate::routes::setup::stop(state, headers)
            .await
            .into_response(),

        (&Method::POST, ["exec", name]) => {
            match crate::routes::scripts::exec(state, headers, AxumPath((*name).to_string()), body)
                .await
            {
                Ok(response) => response,
                Err(error) => error.into_response(),
            }
        }
        (&Method::POST, ["exec", name, "kill"]) => {
            crate::routes::scripts::exec_kill(state, headers, AxumPath((*name).to_string()))
                .await
                .into_response()
        }

        // `is_handled` admitted the path but not this method.
        _ => ApiError::new(
            StatusCode::METHOD_NOT_ALLOWED,
            format!("method not allowed for this sandbox route: {method}"),
        )
        .into_response(),
    }
}

/// `GET …/preview-fetch?path=…` — read one path off the sandbox's dev server.
///
/// Straight to the dev port: this is a server-side read with no browser
/// involved, so it needs none of the cookie/origin handling the preview
/// listener exists for.
async fn preview_fetch(target: &AppState, query: Option<&str>) -> Response {
    let Some(path) = query.and_then(|query| crate::http_util::query_param(query, "path")) else {
        return ApiError::bad_request("missing `path` query parameter").into_response();
    };
    let Some(port) = crate::routes::proxy::target_dev_port(target) else {
        return ApiError::new(StatusCode::BAD_GATEWAY, "Preview not available").into_response();
    };

    let url = format!("http://127.0.0.1:{port}/{}", path.trim_start_matches('/'));
    super::dev_server::send_and_mirror(reqwest::Client::new().get(&url), None).await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A path this module does not own MUST fall through, so the upstream
    /// proxy still serves it — claiming it would 404 every cloud sandbox
    /// route the desktop has no local answer for.
    #[test]
    fn only_claims_the_routes_it_implements() {
        for owned in [
            vec!["config"],
            vec!["preview-fetch"],
            vec!["git", "status"],
            vec!["setup", "clone"],
            vec!["exec", "dev"],
            vec!["exec", "dev", "kill"],
        ] {
            assert!(is_handled(&owned), "should own {owned:?}");
        }
        for foreign in [
            vec!["events"],         // sandbox_events owns it
            vec!["read"],           // sandbox_fs owns it
            vec!["preview-invoke"], // preview_invoke owns it
            vec!["claim"],          // cloud-only
            vec!["git"],            // incomplete
            vec!["exec", "a", "b"], // not `kill`
            vec![],
        ] {
            assert!(!is_handled(&foreign), "should NOT own {foreign:?}");
        }
    }
}
