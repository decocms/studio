//! `POST /api/:org/sandbox/:virtualMcpId/:branch/preview-invoke` — resolve one
//! Deco loader/action against THIS machine's dev server.
//!
//! Byte-parity target: `apps/api/src/api/routes/sandbox-proxy.ts`'s
//! `preview-invoke` handler, which resolves the sandbox's preview URL and
//! POSTs `{...props}` to `<preview>/deco/invoke/<resolveType>`.
//!
//! ## Why this has to be intercepted
//!
//! Without it the request falls through to the upstream proxy, which looks for
//! a CLOUD sandbox that does not exist for a desktop-run agent and answers
//! `502 Preview not available`. The dev server it needs is a child process on
//! this machine; upstream cannot reach it, and never could.
//!
//! The invoke is sent straight to the sandbox's dev port rather than through
//! the preview proxy: this is a server-side call with no browser involved, so
//! there is no reason to route it back out through a listener whose whole job
//! is attaching preview cookies and rewriting a browser's view of the origin.

use axum::body::Bytes;
use axum::http::{header, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use serde_json::{Map, Value};

use super::sandbox_fs::decode_identity_segment;
use crate::error::ApiError;
use crate::state::AppState;

/// Cap on the invoke body, mirroring `PREVIEW_INVOKE_MAX_BODY_BYTES`.
const MAX_BODY_BYTES: usize = 1024 * 1024;

pub(super) async fn try_dispatch(
    state: &AppState,
    method: &Method,
    rest: &[&str],
    body: &Bytes,
) -> Option<Response> {
    let ["sandbox", encoded_virtual_mcp_id, encoded_branch, "preview-invoke"] = rest else {
        return None;
    };
    if *method != Method::POST {
        return Some(
            ApiError::new(
                StatusCode::METHOD_NOT_ALLOWED,
                format!("method not allowed for preview-invoke: {method}"),
            )
            .into_response(),
        );
    }
    if body.len() > MAX_BODY_BYTES {
        return Some(
            ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, "Payload too large").into_response(),
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
    Some(invoke(state, &virtual_mcp_id, &branch, body).await)
}

async fn invoke(state: &AppState, virtual_mcp_id: &str, branch: &str, body: &Bytes) -> Response {
    let Some(parsed) = serde_json::from_slice::<Value>(body)
        .ok()
        .and_then(|value| parse_invoke(&value))
    else {
        // Two distinct upstream errors collapse here only when the body is not
        // a JSON object at all; the resolveType case is reported separately
        // below by `parse_invoke` returning None for a present-but-invalid one.
        return ApiError::bad_request("Invalid or missing __resolveType").into_response();
    };

    // Keyed by (virtualMcpId, branch); the worktree handle is derived from the
    // repository, so the registry is what bridges them.
    let Ok(Some(handle)) = state
        .sandbox_manager
        .handle_for_agent(virtual_mcp_id, branch)
    else {
        return ApiError::new(StatusCode::BAD_GATEWAY, "Preview not available").into_response();
    };
    let Some(port) = state
        .sandbox_manager
        .get(&handle)
        .and_then(|sandbox| crate::routes::proxy::sandbox_dev_port(&sandbox))
    else {
        return ApiError::new(StatusCode::BAD_GATEWAY, "Preview not available").into_response();
    };

    let url = format!(
        "http://127.0.0.1:{port}/deco/invoke/{}",
        // RAW in the path, slashes intact: the deco runtime routes
        // `/deco/invoke/*` on the UN-decoded path, so a percent-encoded key
        // never matches a loader. `parse_invoke` has already rejected
        // anything that could escape the path.
        parsed.resolve_type
    );
    let payload = match serde_json::to_vec(&parsed.payload) {
        Ok(bytes) => bytes,
        Err(_) => {
            return ApiError::internal("could not re-encode the invoke payload").into_response()
        }
    };

    let request = reqwest::Client::new()
        .post(&url)
        .header(header::CONTENT_TYPE, "application/json")
        .body(payload);
    super::dev_server::send_and_mirror(request, Some(HeaderValue::from_static("application/json")))
        .await
}

struct Invoke {
    resolve_type: String,
    payload: Map<String, Value>,
}

/// `{ __resolveType, ...props }` split into the single-invoke target Deco
/// expects. `None` for a missing or unsafe `__resolveType`.
fn parse_invoke(body: &Value) -> Option<Invoke> {
    let object = body.as_object()?;
    let resolve_type = object.get("__resolveType")?.as_str()?;
    if !is_valid_resolve_type(resolve_type) {
        return None;
    }
    let mut payload = object.clone();
    payload.remove("__resolveType");
    Some(Invoke {
        resolve_type: resolve_type.to_string(),
        payload,
    })
}

/// `^[\w./@-]+$` plus no `..` — the port of `isValidLoaderResolveType`.
///
/// This value goes RAW into a URL path, so the pattern is what stops it from
/// climbing out of `/deco/invoke/` or smuggling a query string.
fn is_valid_resolve_type(resolve_type: &str) -> bool {
    !resolve_type.is_empty()
        && !resolve_type.contains("..")
        && resolve_type
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '/' | '@' | '-'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_the_resolve_type_from_its_props() {
        let body = serde_json::json!({
            "__resolveType": "vtex/loaders/intelligentSearch/productList.ts",
            "query": "shoes",
            "count": 10,
        });
        let parsed = parse_invoke(&body).expect("parsed");
        assert_eq!(
            parsed.resolve_type,
            "vtex/loaders/intelligentSearch/productList.ts"
        );
        // `__resolveType` is the routing key, never a prop.
        assert!(!parsed.payload.contains_key("__resolveType"));
        assert_eq!(parsed.payload.get("query").unwrap(), "shoes");
        assert_eq!(parsed.payload.len(), 2);
    }

    /// The resolveType is interpolated RAW into a URL path, so this is the
    /// only thing standing between a caller and `/deco/invoke/../../…`.
    #[test]
    fn refuses_a_resolve_type_that_could_escape_the_invoke_path() {
        for bad in [
            "../../etc/passwd",
            "a/../../b",
            "loader.ts?x=1",
            "loader.ts#frag",
            "with space.ts",
            "back\\slash.ts",
            "",
        ] {
            assert!(
                parse_invoke(&serde_json::json!({ "__resolveType": bad })).is_none(),
                "accepted {bad:?}"
            );
        }
    }

    #[test]
    fn accepts_the_characters_real_resolve_types_use() {
        for good in [
            "vtex/loaders/intelligentSearch/productList.ts",
            "site/sections/Hero.tsx",
            "@deco/std/loaders/x.ts",
            "a-b_c.ts",
        ] {
            assert!(
                parse_invoke(&serde_json::json!({ "__resolveType": good })).is_some(),
                "rejected {good:?}"
            );
        }
    }

    #[test]
    fn a_body_without_a_resolve_type_is_refused() {
        assert!(parse_invoke(&serde_json::json!({ "query": "x" })).is_none());
        assert!(parse_invoke(&serde_json::json!([1, 2, 3])).is_none());
        assert!(parse_invoke(&serde_json::json!("nope")).is_none());
        assert!(parse_invoke(&serde_json::json!({ "__resolveType": 42 })).is_none());
    }
}
