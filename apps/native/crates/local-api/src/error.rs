//! The daemon-parity JSON error envelope.
//!
//! Every route in `packages/sandbox/daemon-go/internal/routes/*.go` responds to a
//! rejected request with `{ "error": "<message>" }`, sometimes with extra
//! fields (`detail`, `notReady`, `available`) — see
//! the native local-API contract. `ApiError` is
//! the ONE type every handler in this crate returns on the error path so
//! that shape never drifts between families. Route handlers should return
//! `Result<Json<T>, ApiError>` (or `Result<Response, ApiError>` for
//! non-JSON success bodies like SSE/204/empty) and use the constructors
//! below rather than building `(StatusCode, Json(..))` tuples by hand.

use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::{json, Value};

#[derive(Debug)]
pub struct ApiError {
    pub status: StatusCode,
    pub body: Value,
}

impl ApiError {
    /// `{ "error": "<message>" }` at an arbitrary status. The building
    /// block every other constructor is sugar over.
    pub fn new(status: StatusCode, error: impl Into<String>) -> Self {
        Self {
            status,
            body: json!({ "error": error.into() }),
        }
    }

    /// `{ "error": "<message>", ...extra }` — `extra` must be a JSON
    /// object; its keys are merged alongside `error` (contract: "Some
    /// routes add fields alongside `error`", e.g. `detail`/`notReady`/
    /// `available`).
    pub fn with_extra(status: StatusCode, error: impl Into<String>, extra: Value) -> Self {
        let mut body = json!({ "error": error.into() });
        if let (Some(base), Value::Object(more)) = (body.as_object_mut(), extra) {
            base.extend(more);
        }
        Self { status, body }
    }

    // --- Shapes pinned by name across the contract + both e2e suites -------

    /// 401 — byte-parity with `auth.ts::requireToken`. Missing header,
    /// wrong scheme, or mismatched token all resolve here (see `auth.rs`).
    pub fn unauthorized() -> Self {
        Self::new(StatusCode::UNAUTHORIZED, "unauthorized")
    }

    /// 403 — Origin header present but not on the allowlist. Checked
    /// BEFORE auth (contract: "fail fast, don't waste a timing
    /// side-channel on the bearer compare").
    pub fn forbidden_origin() -> Self {
        Self::new(StatusCode::FORBIDDEN, "forbidden_origin")
    }

    /// 404 — generic "no such route" for both the `/_sandbox/*` catch-all
    /// (`Not found: <path>`, byte-parity with the daemon's `vmRouteH`
    /// default branch) and any family's own "no such id" case.
    pub fn not_found(error: impl Into<String>) -> Self {
        Self::new(StatusCode::NOT_FOUND, error)
    }

    pub fn bad_request(error: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, error)
    }

    /// 409 `{"error":..., "notReady": true}` — git's "repository not
    /// initialized" gate and analogous "not ready yet, retry" cases.
    pub fn not_ready(error: impl Into<String>) -> Self {
        Self::with_extra(StatusCode::CONFLICT, error, json!({ "notReady": true }))
    }

    /// 409 without the `notReady` marker — e.g. config's immutable-field
    /// rejection, exec's "no package manager configured yet".
    pub fn conflict(error: impl Into<String>) -> Self {
        Self::new(StatusCode::CONFLICT, error)
    }

    /// 410 — a deliberately retired local route.
    pub fn gone(error: impl Into<String>) -> Self {
        Self::new(StatusCode::GONE, error)
    }

    pub fn payload_too_large(error: impl Into<String>) -> Self {
        Self::new(StatusCode::PAYLOAD_TOO_LARGE, error)
    }

    /// 502 — upstream/dev-server unreachable (reverse proxy, the app-API
    /// proxy, tools/sync).
    pub fn bad_gateway(error: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_GATEWAY, error)
    }

    /// 500 — reserved for local-api's own bugs (contract: never used for
    /// "the caller did something wrong").
    pub fn internal(error: impl Into<String>) -> Self {
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, error)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.status, Json(self.body)).into_response()
    }
}

/// Convenience alias family handlers use in signatures:
/// `async fn handler(..) -> ApiResult<SomeJsonType>`.
pub type ApiResult<T> = Result<T, ApiError>;
