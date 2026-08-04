//! `GET/POST/PUT /_sandbox/config` — byte-parity target:
//! `daemon/routes/config.ts` + `daemon/config-store/`, oracle
//! `daemon.e2e.test.ts` (`config` describe block, minus `auth.rotateToken`'s
//! length/type validation — unreachable here, see below).
//!
//! `auth.rotateToken`: this endpoint has no token-rotation setter wired (see
//! the native local-API contract — one token per
//! process lifetime, no rotation endpoint). Byte-parity with the TS
//! `validateAuthPatch`'s branch order: ANY `auth.rotateToken` (regardless of
//! its own type/length) hits daemon's "!setter" branch first and gets
//! rejected `400 {"error":"auth.rotateToken not supported on this
//! endpoint"}` before the merge ever runs — the length/type checks the TS
//! source has below that branch are dead code on an endpoint with no
//! setter, so they're intentionally not ported.
//!
//! `POST`/`PUT` share a handler (`update`), matching the TS source treating
//! both as "deep-merge into current".

use axum::body::Bytes;
use axum::extract::State;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::{json, Value};

use crate::error::ApiError;
use crate::state::AppState;

pub async fn read(State(state): State<AppState>) -> Json<Value> {
    let snap = state.config.snapshot();
    Json(json!({
        "bootId": state.boot_id.as_ref(),
        "config": snap.config,
        "envKeys": snap.env_keys,
        "orchestrator": state.setup.orchestrator_json(),
        "ready": snap.ready,
        "repoDir": state.repo_dir.to_string_lossy(),
    }))
}

pub async fn update(State(state): State<AppState>, body: Bytes) -> Response {
    let Some(_generation_admission) = state.tasks.admit() else {
        return ApiError::conflict("sandbox generation is stopped").into_response();
    };
    let raw: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(e) => return ApiError::bad_request(format!("bad body: {e}")).into_response(),
    };
    let Some(obj) = raw.as_object() else {
        return ApiError::bad_request("payload must be an object").into_response();
    };

    if let Some(auth) = obj.get("auth") {
        if let Some(err) = reject_auth_patch(auth) {
            return err.into_response();
        }
    }

    let mut patch = raw.clone();
    if let Value::Object(m) = &mut patch {
        m.remove("auth");
    }

    match state.config.patch(patch) {
        Ok(outcome) => {
            if outcome.transition != "no-op" {
                // Hand the transition to the setup pipeline (KEPT — see
                // `crate::setup`'s module doc). This is the REAL `"lifecycle"`
                // source now: `SetupOrchestrator` emits its own
                // `{state:{phase:...}}`-shaped events as clone/install/start
                // progress, matching `daemon/events/types.ts::LifecycleState`
                // byte-for-byte (replacing this handler's earlier synthetic
                // `{phase:"configured",transition}` placeholder, which had no
                // oracle test pinning it and didn't match the real wire
                // shape). Fire-and-forget: the pipeline runs on
                // `SetupOrchestrator`'s own background worker, this request
                // returns immediately (byte-parity with the daemon's
                // `store.subscribe` -> `orchestrator.handle` handoff, which
                // likewise doesn't block the config PUT/POST response).
                state.setup.handle_transition(outcome.transition);
            }
            Json(json!({
                "bootId": state.boot_id.as_ref(),
                "transition": outcome.transition,
                "config": outcome.config,
            }))
            .into_response()
        }
        Err(e) => e.into_response(),
    }
}

/// `None` when there's nothing to reject (no `rotateToken` key, or an
/// object/array `auth` value without one — byte-parity with
/// `validateAuthPatch` returning `null`).
fn reject_auth_patch(auth: &Value) -> Option<ApiError> {
    // TS: `typeof auth !== "object" || auth === null`. `typeof x === "object"`
    // is true for both JS objects AND arrays (and, confusingly, `null` --
    // which the second clause excludes), so an array `auth` value is
    // "object-like" on the TS side and falls through to the rotateToken
    // check below (which then finds nothing and no-ops).
    let object_like = matches!(auth, Value::Object(_) | Value::Array(_));
    if !object_like {
        return Some(ApiError::bad_request("auth must be an object"));
    }
    let rotate_token = auth.get("rotateToken").filter(|v| !v.is_null());
    if rotate_token.is_some() {
        return Some(ApiError::bad_request(
            "auth.rotateToken not supported on this endpoint",
        ));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn stopped_generation_rejects_config_patch_without_mutating_state() {
        let root = tempfile::tempdir().unwrap();
        let state = crate::routes::intercept::test_state(root.path());
        state.tasks.close_admission().await;

        let response = update(
            State(state.clone()),
            Bytes::from_static(br#"{"application":{"runtime":"node"}}"#),
        )
        .await;
        assert_eq!(response.status(), axum::http::StatusCode::CONFLICT);
        assert!(state.config.snapshot().config.is_none());
        assert_eq!(state.setup.pending_count(), 0);
    }

    #[test]
    fn reject_auth_patch_allows_object_without_rotate_token() {
        assert!(reject_auth_patch(&json!({})).is_none());
    }

    #[test]
    fn reject_auth_patch_rejects_non_object() {
        let err = reject_auth_patch(&json!("nope")).expect("rejected");
        assert_eq!(err.status, axum::http::StatusCode::BAD_REQUEST);
    }

    #[test]
    fn reject_auth_patch_rejects_rotate_token_presence() {
        let err = reject_auth_patch(&json!({"rotateToken": "x"})).expect("rejected");
        assert_eq!(err.status, axum::http::StatusCode::BAD_REQUEST);
        assert_eq!(
            err.body["error"],
            "auth.rotateToken not supported on this endpoint"
        );
    }
}
