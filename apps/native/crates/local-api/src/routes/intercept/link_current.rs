//! `POST /api/:org/tools/LINK_CURRENT_GET` — CLI/tier availability, via the
//! pre-existing "linked desktop" tool rather than a bespoke endpoint. Wire
//! contract: the native interception contract §3.4.
//!
//! Answered ENTIRELY locally (never forwarded, and never even consulted for
//! whether a real link session exists upstream — a desktop app running
//! this process IS the local machine, so `online` is unconditionally
//! `true`): `capabilities` reflects `harness::detect`'s SAME grow-only CLI
//! probe `routes/models.rs`'s (now-superseded, see that file's own doc
//! comment update) `/models` endpoint used, so this can never disagree with
//! what the local dispatch actually runs.

use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;

pub async fn get() -> Response {
    let cache = harness::detect::ensure_detected().await;
    let mut capabilities = Vec::new();
    if cache.get(harness::HarnessId::ClaudeCode) {
        capabilities.push("claude-code");
    }
    if cache.get(harness::HarnessId::Codex) {
        capabilities.push("codex");
    }

    Json(json!({
        "online": true,
        "capabilities": capabilities,
    }))
    .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;

    #[tokio::test]
    async fn always_reports_online_with_a_capabilities_array() {
        let res = get().await;
        assert_eq!(res.status(), axum::http::StatusCode::OK);
        let bytes = to_bytes(res.into_body(), usize::MAX).await.unwrap();
        let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["online"], true);
        assert!(body["capabilities"].is_array());
    }
}
