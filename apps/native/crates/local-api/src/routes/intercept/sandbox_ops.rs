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
    Some(route(&target, method, tail, query, body.clone()).await)
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
) -> Response {
    let state = State(target.clone());
    // These handlers take the sandbox from headers; `state_for_sandbox` has
    // already pointed this state's own target at it, so an empty map resolves
    // to the right sandbox.
    let headers = HeaderMap::new();

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
        (&Method::POST, ["git", "publish"]) => crate::routes::git::publish(state, body)
            .await
            .into_response(),
        (&Method::POST, ["git", "discard"]) => crate::routes::git::discard(state, body)
            .await
            .into_response(),
        (&Method::POST, ["git", "rebase"]) => crate::routes::git::rebase(state, body)
            .await
            .into_response(),

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
    let Some(path) = query.and_then(query_path) else {
        return ApiError::bad_request("missing `path` query parameter").into_response();
    };
    let Some(port) = crate::routes::proxy::target_dev_port(target) else {
        return ApiError::new(StatusCode::BAD_GATEWAY, "Preview not available").into_response();
    };

    let url = format!("http://127.0.0.1:{port}/{}", path.trim_start_matches('/'));
    let Ok(response) = reqwest::Client::new().get(&url).send().await else {
        return ApiError::new(StatusCode::BAD_GATEWAY, "Preview unreachable").into_response();
    };
    let status =
        StatusCode::from_u16(response.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let headers = response.headers().clone();
    let Ok(bytes) = response.bytes().await else {
        return ApiError::new(StatusCode::BAD_GATEWAY, "Preview unreachable").into_response();
    };

    let mut res = Response::new(axum::body::Body::from(bytes));
    *res.status_mut() = status;
    if let Some(content_type) = headers.get(axum::http::header::CONTENT_TYPE) {
        res.headers_mut()
            .insert(axum::http::header::CONTENT_TYPE, content_type.clone());
    }
    res
}

/// The `path` value from a raw query string, percent-decoded.
fn query_path(query: &str) -> Option<String> {
    query.split('&').find_map(|pair| {
        let (key, value) = pair.split_once('=')?;
        (key == "path").then(|| percent_decode(value))
    })
}

fn percent_decode(value: &str) -> String {
    urlencoding::decode(value)
        .map(|decoded| decoded.into_owned())
        .unwrap_or_else(|_| value.to_string())
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

    #[test]
    fn reads_the_path_parameter_out_of_a_raw_query() {
        assert_eq!(
            query_path("path=/index.html").as_deref(),
            Some("/index.html")
        );
        // Percent-encoded, and not the first parameter.
        assert_eq!(
            query_path("x=1&path=%2Fa%2Fb.json&y=2").as_deref(),
            Some("/a/b.json")
        );
        assert_eq!(query_path("nope=1"), None);
        assert_eq!(query_path(""), None);
    }
}
