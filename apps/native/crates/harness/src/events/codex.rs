//! `codex exec --json --skip-git-repo-check <prompt>` ndjson →
//! `UIMessageChunk` mapping.
//!
//! Wire shapes for `thread.started`/`turn.started`/`item.completed`
//! (`agent_message` item)/`turn.completed` were captured live on this
//! machine (codex-cli 0.144.5, 2026-07-18) — see
//! `events/fixtures/codex_exec.jsonl` (real capture, verbatim). Codex's
//! `--json` protocol also documents `item.started`/`item.updated` (for
//! items that stream incrementally) and richer item types
//! (`reasoning`, `command_execution`, `file_change`, `mcp_tool_call`,
//! `web_search`, `todo_list`) plus `turn.failed`/top-level `error` — none
//! of those were exercised by the trivial "reply with one word" smoke
//! prompt (a real capture would need to spend real API credits driving an
//! actual tool call, which this crate doesn't need to do twice to build a
//! reasonable mapping). `events/fixtures/codex_tool_use.jsonl` and
//! `events/fixtures/codex_error.jsonl` are HAND-CONSTRUCTED to the
//! documented item/turn shapes; unrecognized item types fall through a
//! generic best-effort mapping (see `handle_item` below) rather than being
//! silently dropped, so a future item type this mapper hasn't been taught
//! about yet still surfaces SOMETHING instead of vanishing.
//!
//! Unlike claude's Anthropic-Messages-API deltas, codex's `--json` items
//! arrive essentially as a WHOLE (`item.completed`) rather than as
//! incremental token deltas — so each `agent_message`/`reasoning` item
//! synthesizes a start+delta(full text)+end triplet in one line rather
//! than genuinely streaming word-by-word. `item.started`/`item.updated`
//! ARE handled (for forward-compat with a codex version that does stream
//! them): the mapper tracks each item's last-seen text and emits only the
//! GROWN suffix as the delta, so a future incrementally-updated item
//! degrades gracefully into real deltas instead of repeating the whole
//! text on every update.
//!
//! Event mapping:
//! - `thread.started` → [`crate::events::MappedEvent::SessionId`]
//!   (`thread_id` is codex's resume token — `codex exec resume
//!   <thread_id>`).
//! - `turn.started` → one `{"type":"start"}` chunk.
//! - `item.started` / `item.updated` / `item.completed` → see
//!   [`handle_item`].
//! - `turn.completed` → one `finish` chunk carrying usage metadata.
//! - `turn.failed` / top-level `error` → `MappedEvent::FatalError`.
//! - anything else / an unparseable line → `Ignored`.

use std::collections::HashMap;

use serde_json::{json, Value};

use super::{chunk, EventMapper, MappedEvent};

#[derive(Debug, Default)]
pub struct CodexEventMapper {
    /// Per-item last-seen text, keyed by item id — lets `item.updated`
    /// (if a future codex version streams it) emit only the grown suffix.
    item_text: HashMap<String, String>,
    /// Item ids whose start chunk has already been emitted (so a repeated
    /// `item.updated` for the same id doesn't re-open it).
    item_started: std::collections::HashSet<String>,
    session_id: Option<String>,
    turn_started: bool,
}

impl CodexEventMapper {
    pub fn new() -> Self {
        Self::default()
    }

    fn handle_top_level(&mut self, value: &Value) -> Vec<MappedEvent> {
        match value.get("type").and_then(Value::as_str) {
            Some("thread.started") => self.handle_thread_started(value),
            Some("turn.started") => {
                if self.turn_started {
                    return vec![];
                }
                self.turn_started = true;
                vec![chunk(json!({"type": "start"}))]
            }
            Some("item.started") | Some("item.updated") => value
                .get("item")
                .map(|item| self.handle_item(item, false))
                .unwrap_or_default(),
            Some("item.completed") => value
                .get("item")
                .map(|item| self.handle_item(item, true))
                .unwrap_or_default(),
            Some("turn.completed") => Self::handle_turn_completed(value),
            Some("turn.failed") => Self::handle_turn_failed(value),
            Some("error") => Some(MappedEvent::FatalError {
                message: value
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("codex CLI reported an error")
                    .to_string(),
            })
            .into_iter()
            .collect(),
            _ => vec![],
        }
    }

    fn handle_thread_started(&mut self, value: &Value) -> Vec<MappedEvent> {
        let Some(id) = value.get("thread_id").and_then(Value::as_str) else {
            return vec![];
        };
        self.session_id = Some(id.to_string());
        vec![MappedEvent::SessionId(id.to_string())]
    }

    /// Maps ONE item (from `item.started`/`item.updated`/`item.completed`)
    /// to zero or more chunks. `agent_message`/`reasoning` map to
    /// text/reasoning start+delta(+end on completion); every other item
    /// type (`command_execution`, `file_change`, `mcp_tool_call`,
    /// `web_search`, `todo_list`, and anything not yet known) maps to a
    /// generic tool-call shape: `toolName` is the item's own `type`,
    /// `input` is the item object minus `id`/`type`/`status` (the
    /// "control" fields), `output` populated from the item's own status
    /// once it's `completed`.
    fn handle_item(&mut self, item: &Value, is_completed_event: bool) -> Vec<MappedEvent> {
        let Some(id) = item.get("id").and_then(Value::as_str) else {
            return vec![];
        };
        let item_type = item.get("type").and_then(Value::as_str).unwrap_or("");
        // "Completed" if either the wrapping event says so (the
        // `item.completed` variant) OR the item carries its own terminal
        // `status` field — defensive coverage for whichever convention a
        // given codex version actually uses; the real capture this
        // mapper was built against carries no `status` field at all on
        // its `item.completed` item, so `is_completed_event` alone must
        // be sufficient.
        let completed =
            is_completed_event || item.get("status").and_then(Value::as_str) == Some("completed");

        match item_type {
            "agent_message" => self.handle_text_like_item(id, item, "text", completed),
            "reasoning" => self.handle_text_like_item(id, item, "reasoning", completed),
            // Generic (tool-shaped) items only surface once complete — an
            // `item.started`/`item.updated` for e.g. a `command_execution`
            // rarely carries a full `input`/`output` yet, and emitting the
            // same object twice (once on started, again on completed)
            // would duplicate the chunk.
            other if completed => self.handle_generic_tool_item(id, other, item),
            _ => vec![],
        }
    }

    /// `agent_message`/`reasoning` items: emit a `-start` the first time
    /// this item id is seen, a `-delta` for whatever text GREW since the
    /// last update (the whole text on first sight), and a `-end` only once
    /// the item reaches a terminal status (or unconditionally for
    /// `item.completed`, since that event has no further updates coming).
    fn handle_text_like_item(
        &mut self,
        id: &str,
        item: &Value,
        kind: &str,
        completed: bool,
    ) -> Vec<MappedEvent> {
        let text = item
            .get("text")
            .or_else(|| item.get("summary"))
            .and_then(Value::as_str)
            .unwrap_or_default();
        let mut out = Vec::new();

        let first_sight = self.item_started.insert(id.to_string());
        if first_sight {
            out.push(chunk(json!({"type": format!("{kind}-start"), "id": id})));
        }

        let previous = self.item_text.get(id).cloned().unwrap_or_default();
        if let Some(grown) = text.strip_prefix(&previous) {
            if !grown.is_empty() {
                out.push(chunk(
                    json!({"type": format!("{kind}-delta"), "id": id, "delta": grown}),
                ));
            }
        } else if text != previous {
            // Text didn't grow as a simple suffix (a rewrite, not an
            // append) — emit the new text wholesale rather than a
            // misleading diff.
            out.push(chunk(
                json!({"type": format!("{kind}-delta"), "id": id, "delta": text}),
            ));
        }
        self.item_text.insert(id.to_string(), text.to_string());

        if completed {
            out.push(chunk(json!({"type": format!("{kind}-end"), "id": id})));
        }
        out
    }

    /// Any item type that isn't `agent_message`/`reasoning` — a generic,
    /// best-effort tool-call mapping so a not-yet-specifically-handled
    /// item (or a genuinely new item type a future codex version adds)
    /// still surfaces as SOMETHING instead of silently vanishing (see
    /// module doc).
    fn handle_generic_tool_item(
        &self,
        id: &str,
        tool_name: &str,
        item: &Value,
    ) -> Vec<MappedEvent> {
        let mut input = item.clone();
        if let Value::Object(map) = &mut input {
            map.remove("id");
            map.remove("type");
        }
        vec![chunk(json!({
            "type": "tool-input-available",
            "toolCallId": id,
            "toolName": tool_name,
            "input": input,
        }))]
    }

    fn handle_turn_completed(value: &Value) -> Vec<MappedEvent> {
        let usage = value.get("usage").cloned().unwrap_or(Value::Null);
        vec![chunk(json!({
            "type": "finish",
            "finishReason": "stop",
            "messageMetadata": {
                "usage": usage,
                "codingAgentProvider": "codex",
            },
        }))]
    }

    fn handle_turn_failed(value: &Value) -> Vec<MappedEvent> {
        let message = value
            .pointer("/error/message")
            .and_then(Value::as_str)
            .unwrap_or("codex CLI reported a turn failure")
            .to_string();
        vec![MappedEvent::FatalError { message }]
    }
}

impl EventMapper for CodexEventMapper {
    fn feed_line(&mut self, line: &str) -> Vec<MappedEvent> {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            return vec![];
        }
        let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
            // Real captured behavior: codex prints a human
            // "Reading additional input from stdin..." banner to stdout
            // BEFORE its JSON stream when stdin isn't closed — see
            // `run.rs`'s module doc for why every harness spawn closes
            // stdin, and this fallback for defense in depth regardless.
            return vec![];
        };
        self.handle_top_level(&value)
    }

    fn session_id(&self) -> Option<&str> {
        self.session_id.as_deref()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const EXEC_FIXTURE: &str = include_str!("fixtures/codex_exec.jsonl");
    const TOOL_USE_FIXTURE: &str = include_str!("fixtures/codex_tool_use.jsonl");
    const ERROR_FIXTURE: &str = include_str!("fixtures/codex_error.jsonl");

    fn feed_all(mapper: &mut CodexEventMapper, fixture: &str) -> Vec<MappedEvent> {
        fixture
            .lines()
            .flat_map(|line| mapper.feed_line(line))
            .collect()
    }

    #[test]
    fn exec_fixture_yields_session_start_text_and_finish() {
        let mut mapper = CodexEventMapper::new();
        let events = feed_all(&mut mapper, EXEC_FIXTURE);

        assert_eq!(
            events.first(),
            Some(&MappedEvent::SessionId(
                "019f7325-3e34-7b30-863a-861396b02def".to_string()
            ))
        );
        assert_eq!(
            mapper.session_id(),
            Some("019f7325-3e34-7b30-863a-861396b02def")
        );

        assert!(events.contains(&chunk(json!({"type": "start"}))));
        assert!(events.contains(&chunk(json!({"type": "text-start", "id": "item_0"}))));
        assert!(events.contains(&chunk(
            json!({"type": "text-delta", "id": "item_0", "delta": "pong"})
        )));
        assert!(events.contains(&chunk(json!({"type": "text-end", "id": "item_0"}))));

        let finish = events
            .iter()
            .find_map(|e| match e {
                MappedEvent::Chunk(v) if v["type"] == "finish" => Some(v),
                _ => None,
            })
            .expect("a finish chunk");
        assert_eq!(finish["messageMetadata"]["codingAgentProvider"], "codex");
        assert_eq!(finish["messageMetadata"]["usage"]["output_tokens"], 106);

        assert!(!events
            .iter()
            .any(|e| matches!(e, MappedEvent::FatalError { .. })));
    }

    #[test]
    fn agent_message_start_is_emitted_only_once() {
        let mut mapper = CodexEventMapper::new();
        let events = feed_all(&mut mapper, EXEC_FIXTURE);
        let starts = events
            .iter()
            .filter(|e| matches!(e, MappedEvent::Chunk(v) if v["type"] == "text-start"))
            .count();
        assert_eq!(starts, 1);
    }

    #[test]
    fn tool_use_fixture_maps_reasoning_and_generic_command_execution() {
        let mut mapper = CodexEventMapper::new();
        let events = feed_all(&mut mapper, TOOL_USE_FIXTURE);

        assert!(events.contains(&chunk(json!({"type": "reasoning-start", "id": "item_0"}))));
        assert!(events.contains(&chunk(
            json!({"type": "reasoning-delta", "id": "item_0", "delta": "Figuring out what to run."})
        )));
        assert!(events.contains(&chunk(json!({"type": "reasoning-end", "id": "item_0"}))));

        let tool_call = events
            .iter()
            .find_map(|e| match e {
                MappedEvent::Chunk(v) if v["toolCallId"] == "item_1" => Some(v),
                _ => None,
            })
            .expect("a generic tool-input-available chunk for command_execution");
        assert_eq!(tool_call["type"], "tool-input-available");
        assert_eq!(tool_call["toolName"], "command_execution");
        assert_eq!(tool_call["input"]["command"], "echo hi");
        assert_eq!(tool_call["input"]["exit_code"], 0);
        // Control fields id/type are stripped from `input`.
        assert!(tool_call["input"].get("id").is_none());
        assert!(tool_call["input"].get("type").is_none());
    }

    #[test]
    fn turn_failed_yields_a_fatal_error_with_the_reported_message() {
        let mut mapper = CodexEventMapper::new();
        let events = feed_all(&mut mapper, ERROR_FIXTURE);
        assert_eq!(
            events.last(),
            Some(&MappedEvent::FatalError {
                message: "stream disconnected before completion".to_string()
            })
        );
    }

    #[test]
    fn top_level_error_type_is_also_fatal() {
        let mut mapper = CodexEventMapper::new();
        let events = mapper.feed_line(r#"{"type":"error","message":"boom"}"#);
        assert_eq!(
            events,
            vec![MappedEvent::FatalError {
                message: "boom".to_string()
            }]
        );
    }

    #[test]
    fn malformed_json_line_is_ignored_not_fatal() {
        let mut mapper = CodexEventMapper::new();
        let events = mapper.feed_line("Reading additional input from stdin...");
        assert_eq!(events, vec![]);
    }

    #[test]
    fn incremental_item_updated_emits_only_the_grown_suffix() {
        let mut mapper = CodexEventMapper::new();
        mapper.feed_line(r#"{"type":"thread.started","thread_id":"t1"}"#);
        mapper.feed_line(r#"{"type":"turn.started"}"#);
        let first = mapper.feed_line(
            r#"{"type":"item.updated","item":{"id":"item_0","type":"agent_message","text":"pon","status":"in_progress"}}"#,
        );
        assert!(first.contains(&chunk(json!({"type":"text-start","id":"item_0"}))));
        assert!(first.contains(&chunk(
            json!({"type":"text-delta","id":"item_0","delta":"pon"})
        )));

        let second = mapper.feed_line(
            r#"{"type":"item.updated","item":{"id":"item_0","type":"agent_message","text":"pong","status":"in_progress"}}"#,
        );
        // Only the grown suffix "g", no repeated start.
        assert_eq!(
            second,
            vec![chunk(
                json!({"type":"text-delta","id":"item_0","delta":"g"})
            )]
        );

        let third = mapper.feed_line(
            r#"{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"pong"}}"#,
        );
        assert_eq!(third, vec![chunk(json!({"type":"text-end","id":"item_0"}))]);
    }

    #[test]
    fn unknown_item_type_still_surfaces_generically() {
        let mut mapper = CodexEventMapper::new();
        let events = mapper.feed_line(
            r#"{"type":"item.completed","item":{"id":"item_9","type":"some_future_item","payload":42}}"#,
        );
        let MappedEvent::Chunk(c) = &events[0] else {
            panic!("expected a chunk")
        };
        assert_eq!(c["type"], "tool-input-available");
        assert_eq!(c["toolName"], "some_future_item");
        assert_eq!(c["input"]["payload"], 42);
    }
}
