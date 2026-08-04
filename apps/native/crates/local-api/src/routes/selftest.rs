//! Opt-in probes for the packaged Tauri boot smoke. These routes exist only
//! when the shell explicitly enables `EmbeddedOptions::runtime_selftest` and
//! still inherit the embedded Host/Origin/session-cookie guard. They never
//! resolve or mutate account-owned sandbox state.

use std::convert::Infallible;

use axum::body::{Body, Bytes};
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use futures::{stream, StreamExt};
use serde_json::Value;

use crate::error::ApiError;
use crate::events::snapshot;
use crate::state::AppState;

const MAX_PROGRESS_BYTES: usize = 1024 * 1024;

/// Account-independent SSE probe proving that native EventSource carries the
/// HttpOnly control cookie without touching the real sandbox event stream.
pub(crate) async fn events() -> Response {
    let initial = snapshot::frame("status", &serde_json::json!({ "state": "selftest" }));
    let body = stream::once(async move { Ok::<Bytes, Infallible>(initial) })
        .chain(stream::pending::<Result<Bytes, Infallible>>());
    crate::http_util::event_stream_response(Body::from_stream(body), "selftest SSE response")
}

/// Persist bounded boot-smoke progress to one fixed diagnostic file. The
/// browser supplies no path, so this cannot become a filesystem capability.
pub(crate) async fn record_progress(State(state): State<AppState>, body: Bytes) -> Response {
    if body.len() > MAX_PROGRESS_BYTES {
        return ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, "Payload too large").into_response();
    }
    if !serde_json::from_slice::<Value>(&body).is_ok_and(|value| value.is_object()) {
        return ApiError::bad_request("selftest progress must be a JSON object").into_response();
    }
    match tokio::fs::write(state.repo_dir.join("selftest-progress.json"), body).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => ApiError::internal(format!("could not persist selftest progress: {error}"))
            .into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn progress_accepts_only_bounded_json_objects() {
        let root = tempfile::tempdir().unwrap();
        let state = crate::routes::intercept::test_state(root.path());

        for body in [Bytes::from_static(b"not-json"), Bytes::from_static(b"[]")] {
            assert_eq!(
                record_progress(State(state.clone()), body).await.status(),
                StatusCode::BAD_REQUEST
            );
        }
        assert_eq!(
            record_progress(
                State(state),
                Bytes::from(vec![b'x'; MAX_PROGRESS_BYTES + 1]),
            )
            .await
            .status(),
            StatusCode::PAYLOAD_TOO_LARGE
        );
        assert!(!root.path().join("repo/selftest-progress.json").exists());
    }
}
