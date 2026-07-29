//! Pure SSE snapshot/frame-format logic for the `events` family, kept
//! separate from `routes/events.rs`'s async plumbing so it's covered by
//! plain `#[cfg(test)]` unit tests — no server, no tokio runtime needed.
//!
//! Byte-parity targets: `daemon/events/sse-format.ts` (frame encoding),
//! `daemon/events/types.ts` (`DaemonEventMap` member shapes),
//! `daemon/entry.ts::getActiveTasks` (the active-task projection).

use bytes::Bytes;
use serde::Serialize;
use serde_json::{json, Value};

use crate::tasks::TaskSummary;

/// `event: <name>\ndata: <json>\n\n` — byte-parity with `sseFormat()`
/// (`daemon/events/sse-format.ts`). `data` is any pre-built JSON value; a
/// serialization failure can't happen for the `Value`s this module builds
/// (no floats/maps with non-string keys), but falls back to `null` rather
/// than panicking on the request path if it ever did.
pub fn frame(name: &str, data: &Value) -> Bytes {
    let payload = serde_json::to_string(data).unwrap_or_else(|_| "null".to_string());
    Bytes::from(format!("event: {name}\ndata: {payload}\n\n"))
}

/// Wraps a `crate::setup::SetupOrchestrator::lifecycle_snapshot()` phase
/// object in the `{"state": ...}` envelope `DaemonEventMap["lifecycle"]`
/// pins — byte-parity with `daemon/events/types.ts::LifecycleState`. The
/// orchestrator is local-api's real clone -> install -> start pipeline
/// (KEPT, not dropped — see `crate::setup`'s module doc), so `phase` is
/// exactly one of `idle`/`cloning`/`checking-out`/`clone-failed`/
/// `installing`/`install-failed`/`starting`/`running`/`start-failed`/
/// `crashed`, not a synthetic idle/running collapse.
pub fn lifecycle(phase: Value) -> Value {
    json!({ "state": phase })
}

/// `local-api` has no pause/crash trigger wired yet (Phase 1) — always
/// `{state:"running"}`, no `reason`. Byte-parity shape with `DaemonStatus`
/// (`daemon/events/types.ts`); `daemon.sse-shapes.e2e.test.ts`'s "status"
/// oracle only pins this shape (plus "no unexpected keys"), not a
/// mechanism to ever leave `"running"`.
pub fn status() -> Value {
    json!({ "state": "running" })
}

/// Byte-parity projection with `entry.ts::getActiveTasks`, which maps the
/// full `TaskSummary` down to just `{id, command, logName?}` for the SSE
/// wire. Callers pass an already-`Running`-filtered list (see
/// `TaskRegistry::list`) — this function does no filtering itself.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ActiveTask<'a> {
    id: &'a str,
    command: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    log_name: Option<&'a str>,
}

pub fn active_tasks(running: &[TaskSummary]) -> Value {
    let active: Vec<ActiveTask<'_>> = running
        .iter()
        .map(|t| ActiveTask {
            id: &t.id,
            command: &t.command,
            log_name: t.log_name.as_deref(),
        })
        .collect();
    json!({ "active": active })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tasks::TaskStatus;

    fn task(id: &str, command: &str, log_name: Option<&str>) -> TaskSummary {
        TaskSummary {
            id: id.to_string(),
            command: command.to_string(),
            status: TaskStatus::Running,
            exit_code: None,
            started_at: 0,
            finished_at: None,
            timed_out: false,
            truncated: false,
            log_name: log_name.map(str::to_string),
            intentional: None,
        }
    }

    #[test]
    fn frame_matches_daemon_wire_format() {
        let f = frame("status", &json!({"state":"running"}));
        assert_eq!(
            std::str::from_utf8(&f).unwrap(),
            "event: status\ndata: {\"state\":\"running\"}\n\n"
        );
    }

    #[test]
    fn frame_ends_with_blank_line_separator() {
        let f = frame("lifecycle", &json!({"state":{"phase":"idle"}}));
        let text = std::str::from_utf8(&f).unwrap();
        assert!(text.starts_with("event: lifecycle\ndata: "));
        assert!(text.ends_with("\n\n"));
        assert_eq!(text.matches('\n').count(), 3);
    }

    #[test]
    fn lifecycle_wraps_the_given_phase_in_a_state_envelope() {
        assert_eq!(
            lifecycle(json!({"phase": "idle"})),
            json!({"state": {"phase": "idle"}})
        );
        assert_eq!(
            lifecycle(json!({"phase": "running", "port": 3000, "htmlSupport": false})),
            json!({"state": {"phase": "running", "port": 3000, "htmlSupport": false}})
        );
    }

    #[test]
    fn status_is_always_running_with_no_extra_keys() {
        let s = status();
        assert_eq!(s, json!({"state": "running"}));
        assert_eq!(s.as_object().unwrap().len(), 1);
    }

    #[test]
    fn active_tasks_empty_list_is_empty_array() {
        assert_eq!(active_tasks(&[]), json!({"active": []}));
    }

    #[test]
    fn active_tasks_projects_id_command_lognamed() {
        let tasks = vec![task("task1", "sleep 10", Some("dev"))];
        assert_eq!(
            active_tasks(&tasks),
            json!({"active": [{"id":"task1","command":"sleep 10","logName":"dev"}]})
        );
    }

    #[test]
    fn active_tasks_omits_lognamed_key_when_absent() {
        let tasks = vec![task("task1", "sleep 10", None)];
        let value = active_tasks(&tasks);
        let entry = &value["active"][0];
        assert!(entry.get("logName").is_none());
        assert_eq!(entry["id"], "task1");
        assert_eq!(entry["command"], "sleep 10");
    }
}
