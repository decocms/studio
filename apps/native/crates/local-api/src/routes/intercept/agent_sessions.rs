//! `GET /api/:org/agent-sandbox-sessions/:virtualMcpId` — the agent's sandbox
//! sessions, with this machine's included.
//!
//! Answered ENTIRELY from this machine. Upstream's session table describes
//! cloud sandboxes, and the desktop deliberately shows none of those: every
//! proxy route in the sandbox family resolves against local worktrees only
//! (a cloud branch would render a dead file explorer, git panel and preview),
//! so offering cloud rows in the branch picker would be offering branches the
//! app cannot open. Local sandboxes are the ONLY sandboxes here — an earlier
//! revision merged upstream's list in, and the mixed list was the bug.

use axum::http::Method;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::{json, Map, Value};

use super::sandbox_lifecycle::local_sandbox_sessions;
use crate::state::AppState;

pub(super) async fn try_dispatch(
    state: &AppState,
    method: &Method,
    rest: &[&str],
    query: Option<&str>,
) -> Option<Response> {
    let ["agent-sandbox-sessions", encoded_virtual_mcp_id] = rest else {
        return None;
    };
    if *method != Method::GET {
        return None;
    }
    let virtual_mcp_id = urlencoding::decode(encoded_virtual_mcp_id)
        .map(|decoded| decoded.into_owned())
        .unwrap_or_else(|_| (*encoded_virtual_mcp_id).to_string());

    let branch_filter = query.and_then(|query| crate::http_util::query_param(query, "branch"));
    Some(local_sessions(
        state,
        &virtual_mcp_id,
        branch_filter.as_deref(),
    ))
}

fn local_sessions(state: &AppState, virtual_mcp_id: &str, branch_filter: Option<&str>) -> Response {
    let items: Vec<Value> = local_sandbox_sessions(state, virtual_mcp_id)
        .into_iter()
        .filter(|local| {
            let branch = local.get("branch").and_then(Value::as_str).unwrap_or("");
            branch_filter.is_none_or(|wanted| wanted == branch)
        })
        .collect();
    Json(json!({ "items": items })).into_response()
}

/// One local sandbox, as the session wire shape needs it.
pub(super) struct LocalSession<'a> {
    pub virtual_mcp_id: &'a str,
    pub branch: &'a str,
    pub handle: &'a str,
    pub preview_url: Option<&'a str>,
    pub desired_status: &'a str,
    pub observed_status: &'a str,
    pub failure_reason: Option<&'a str>,
    pub updated_at_rfc3339: String,
}

/// Shared by this module and its tests: the wire shape one session takes.
pub(super) fn session_json(session: LocalSession<'_>) -> Value {
    let mut map = Map::new();
    map.insert("virtualMcpId".into(), json!(session.virtual_mcp_id));
    map.insert("branch".into(), json!(session.branch));
    map.insert("sandboxHandle".into(), json!(session.handle));
    map.insert("previewUrl".into(), json!(session.preview_url));
    // For user-desktop the preview origin IS the sandbox API origin.
    map.insert("sandboxApiUrl".into(), json!(session.preview_url));
    map.insert(
        "desiredState".into(),
        json!(desired_state(session.desired_status)),
    );
    map.insert("status".into(), json!(ui_status(session.observed_status)));
    map.insert("startedWith".into(), Value::Null);
    map.insert("failureReason".into(), json!(session.failure_reason));
    map.insert("updatedAt".into(), json!(session.updated_at_rfc3339));
    Value::Object(map)
}

/// The registry's desired status, narrowed to the two the wire allows.
fn desired_state(desired: &str) -> &'static str {
    if desired == "running" {
        "running"
    } else {
        "stopped"
    }
}

/// Registry observed status -> the UI's session status.
///
/// `stopping`/`reaping`/`deleting` have no local equivalent: this runtime
/// stops a sandbox synchronously, so it is never observed mid-transition.
fn ui_status(observed: &str) -> &'static str {
    match observed {
        "running" => "ready",
        "provisioning" => "provisioning",
        "failed" => "failed",
        "absent" => "missing",
        _ => "stopped",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_registry_state_onto_the_wire_status() {
        assert_eq!(ui_status("running"), "ready");
        assert_eq!(ui_status("provisioning"), "provisioning");
        assert_eq!(ui_status("failed"), "failed");
        assert_eq!(ui_status("absent"), "missing");
        assert_eq!(ui_status("stopped"), "stopped");
        // Anything unrecognized reads as stopped rather than inventing a state.
        assert_eq!(ui_status("something-new"), "stopped");

        assert_eq!(desired_state("running"), "running");
        assert_eq!(desired_state("stopped"), "stopped");
        assert_eq!(desired_state(""), "stopped");
    }

    #[test]
    fn a_session_carries_every_field_the_ui_reads() {
        let value = session_json(LocalSession {
            virtual_mcp_id: "vm-1",
            branch: "main",
            handle: "main-abc123",
            preview_url: Some("http://localhost:5000/"),
            desired_status: "running",
            observed_status: "running",
            failure_reason: None,
            updated_at_rfc3339: "2026-07-27T12:00:00.000Z".to_string(),
        });
        for key in [
            "virtualMcpId",
            "branch",
            "sandboxHandle",
            "previewUrl",
            "sandboxApiUrl",
            "desiredState",
            "status",
            "startedWith",
            "failureReason",
            "updatedAt",
        ] {
            assert!(value.get(key).is_some(), "missing {key}");
        }
        assert_eq!(value["status"], "ready");
        // The preview origin doubles as the sandbox API origin on desktop.
        assert_eq!(value["sandboxApiUrl"], value["previewUrl"]);
    }
}
