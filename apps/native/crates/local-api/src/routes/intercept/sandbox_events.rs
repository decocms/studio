//! Native interception for the production shell's sandbox event stream.
//!
//! `GET /api/:org/sandbox/:virtualMcpId/:branch/events` is the single SSE
//! connection the real web shell opens per sandbox
//! (`sandbox-events-context.tsx`). In the browser studio serves it: it emits
//! `event: phase` for the pre-Ready claim lifecycle, then passes the in-pod
//! daemon's own `log|lifecycle|status|tasks|scripts|branch|reload` frames
//! straight through, plus a synthetic `event: gone` when the sandbox handle has
//! disappeared.
//!
//! Inside the desktop app there is no pod and no claim: this process owns the
//! sandbox, and [`crate::routes::events::events`] already emits exactly that
//! daemon frame vocabulary for a given handle (`?handle=`, which metadata-
//! adopts the sandbox and watches its process generation). So this intercept is
//! composition, not a reimplementation — resolve `(virtualMcpId, branch)` to a
//! handle and hand the request to that same stream.
//!
//! No `phase` frames are emitted. They describe cloud claim states (capacity
//! wait, image pull) that have no local analogue; the shell treats a null phase
//! as "no claim information", which is the truth here. Local provisioning
//! progress already reaches the UI through the `lifecycle` frames the setup
//! pipeline emits.
//!
//! ## Why an unknown handle is a `gone` FRAME, not a 404
//!
//! `preview.tsx` self-heals an evicted sandbox by turning `event: gone` into a
//! fresh `SANDBOX_START`. That recovery only triggers from a frame on an open
//! stream — an HTTP 404 just makes `EventSource` retry the connection forever,
//! so the sandbox would never come back. `events()`'s own unknown-handle branch
//! answers 404 (correct for its daemon-parity callers), so this path checks the
//! registry first and answers with the frame the shell is waiting for.

use axum::body::Body;
use axum::extract::{Query, State};
use axum::http::{Method, StatusCode};
use axum::response::{IntoResponse, Response};

use crate::error::ApiError;
use crate::routes::events::{events, EventsQuery};
use crate::state::AppState;

use super::sandbox_fs::decode_identity_segment;

/// One `event: gone` frame on a well-formed SSE response.
fn gone_stream() -> Response {
    crate::http_util::event_stream_response(
        Body::from("event: gone\ndata: {}\n\n"),
        "sandbox event stream",
    )
}

pub(super) async fn try_dispatch(
    state: &AppState,
    method: &Method,
    rest: &[&str],
    query: Option<&str>,
) -> Option<Response> {
    let ["sandbox", encoded_virtual_mcp_id, encoded_branch, "events"] = rest else {
        return None;
    };
    if *method != Method::GET {
        return Some(
            ApiError::new(
                StatusCode::METHOD_NOT_ALLOWED,
                format!("method not allowed for sandbox events: {method}"),
            )
            .into_response(),
        );
    }

    let virtual_mcp_id = match decode_identity_segment("virtualMcpId", encoded_virtual_mcp_id) {
        Ok(value) => value,
        Err(error) => return Some(error.into_response()),
    };
    let branch = match decode_identity_segment("branch", encoded_branch) {
        Ok(value) => value,
        Err(error) => return Some(error.into_response()),
    };

    // Keyed by (virtualMcpId, branch); the handle comes from the repository,
    // A CMS session has no worktree, whatever this machine happens to hold.
    if super::runtime::thread_is_cms(state, query) {
        return None;
    }
    // so the registry bridges them. No row means never provisioned — the same
    // thing `is_registered(false)` means below.
    let Ok(Some(handle)) = state
        .sandbox_manager
        .handle_for_agent(&virtual_mcp_id, &branch)
    else {
        return Some(gone_stream());
    };
    match state.sandbox_manager.is_registered(&handle) {
        Ok(true) => {}
        // Never provisioned, or reaped: tell the shell so it can re-start it.
        Ok(false) => return Some(gone_stream()),
        Err(error) => return Some(ApiError::internal(error).into_response()),
    }

    Some(
        events(
            State(state.clone()),
            Query(EventsQuery {
                handle: Some(handle),
            }),
        )
        .await,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::header;

    fn get() -> Method {
        Method::GET
    }

    #[tokio::test]
    async fn ignores_paths_that_are_not_the_events_stream() {
        let root = tempfile::tempdir().expect("tempdir");
        let state = super::super::test_state(root.path());

        // Filesystem operations belong to `sandbox_fs`, not here.
        assert!(
            try_dispatch(&state, &get(), &["sandbox", "vm", "main", "read"], None)
                .await
                .is_none()
        );
        // A different family entirely.
        assert!(
            try_dispatch(&state, &get(), &["tools", "SANDBOX_START"], None)
                .await
                .is_none()
        );
    }

    #[tokio::test]
    async fn unknown_handle_answers_a_gone_frame_not_a_404() {
        let root = tempfile::tempdir().expect("tempdir");
        let state = super::super::test_state(root.path());

        let response = try_dispatch(&state, &get(), &["sandbox", "vm", "main", "events"], None)
            .await
            .expect("the events path is intercepted");

        // A 404 would leave EventSource retrying forever; the shell needs the
        // frame to run its self-heal SANDBOX_START.
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response
                .headers()
                .get(header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok()),
            Some("text/event-stream")
        );
        let body = axum::body::to_bytes(response.into_body(), 1024)
            .await
            .expect("body");
        assert_eq!(String::from_utf8_lossy(&body), "event: gone\ndata: {}\n\n");
    }

    #[tokio::test]
    async fn rejects_non_get_methods() {
        let root = tempfile::tempdir().expect("tempdir");
        let state = super::super::test_state(root.path());

        let response = try_dispatch(
            &state,
            &Method::POST,
            &["sandbox", "vm", "main", "events"],
            None,
        )
        .await
        .expect("still intercepted, so it cannot silently proxy upstream");
        assert_eq!(response.status(), StatusCode::METHOD_NOT_ALLOWED);
    }
}
