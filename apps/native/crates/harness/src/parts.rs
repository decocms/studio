//! Reconstructs a UIMessage-shaped `parts` array — the same storage shape
//! the native local-API contract's Threads-store section pins
//! for `Message.parts` (`unknown[]`, "opaque to local-api, ... the same
//! 'UIMessage parts' shape the mesh chat wire already uses") — from the
//! sequence of `UIMessageChunk`-shaped JSON values a [`crate::run::RunHandle`]
//! yields as [`crate::run::RunEvent::Chunk`]. Pure/stateful, no I/O:
//! `local-api`'s dispatch route feeds it every chunk it relays over SSE
//! and persists the final [`PartsAccumulator::finish`] array as the
//! assistant `Message` row once the run ends.
//!
//! Not itself part of the pinned contract (that doc only pins the STORAGE
//! shape and explicitly treats `parts`' contents as opaque) — the exact
//! part shapes below (`text`, `reasoning`, `tool-<name>`) are this crate's
//! own reasonable-effort UIMessage-part reconstruction, introduced in
//! Phase 2 as the bridge between dispatch's ephemeral SSE stream and the
//! durable thread store. No test in either e2e suite pins this exact
//! shape (dispatch's real-harness streaming persistence has no e2e
//! coverage yet — see the Phase 2 report); this module's own unit tests
//! are the correctness gate for now.
//!
//! ## Resume token convention
//!
//! The contract's `Run` entity has no field for the harness CLI's own
//! session/thread id (needed to `--resume`/`resume <id>` on the NEXT
//! turn) — a Phase 0/1 schema gap; widening the pinned `Run`/`Message`
//! shape is a contract-doc change, out of this Phase 2 module's scope.
//! Instead, when a session id is known, [`PartsAccumulator::finish`]
//! appends ONE final pseudo-part:
//! `{"type":"data-harness-session","harnessId":...,"sessionId":...}` —
//! fits the EXISTING `parts: unknown[]` column with no schema change; a
//! future turn recovers it by scanning assistant messages newest-first for
//! the latest valid token matching the thread's pinned harness. Native chat
//! also checkpoints a newly observed token on its active SQLite queue claim,
//! so crash recovery can append this same part before retiring an interrupted
//! turn.

use std::collections::HashMap;

use serde_json::{json, Value};

#[derive(Debug, Clone)]
enum OpenPart {
    Text(String),
    Reasoning(String),
    Tool {
        tool_name: String,
        input: Option<Value>,
        raw_input: Option<Value>,
        output: Option<Value>,
        error_text: Option<String>,
        state: &'static str,
    },
}

#[derive(Debug, Default)]
pub struct PartsAccumulator {
    /// First-seen order of part/tool-call ids — preserves the sequence
    /// the harness actually produced them in, independent of `HashMap`'s
    /// unordered iteration.
    order: Vec<String>,
    parts: HashMap<String, OpenPart>,
}

impl PartsAccumulator {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed one `UIMessageChunk`-shaped chunk (a [`crate::run::RunEvent::Chunk`]
    /// payload). Unrecognized `type`s (`start`, `finish`, `finish-step`,
    /// any future chunk type this accumulator hasn't been taught about)
    /// are ignored — they don't contribute a `parts` entry, matching how
    /// AI SDK's own `UIMessage.parts` never includes lifecycle-only
    /// chunks either.
    pub fn feed(&mut self, chunk: &Value) {
        match chunk.get("type").and_then(Value::as_str) {
            Some("text-start") => self.open_text_like(chunk, false),
            Some("text-delta") => self.append_text(chunk, false),
            Some("reasoning-start") => self.open_text_like(chunk, true),
            Some("reasoning-delta") => self.append_text(chunk, true),
            Some("tool-input-available") => self.set_tool_input(chunk),
            Some("tool-input-error") => self.set_tool_input_error(chunk),
            Some("tool-output-available") => self.set_tool_output(chunk, false),
            Some("tool-output-error") => self.set_tool_output(chunk, true),
            _ => {}
        }
    }

    fn open_text_like(&mut self, chunk: &Value, reasoning: bool) {
        let Some(id) = chunk.get("id").and_then(Value::as_str) else {
            return;
        };
        if !self.parts.contains_key(id) {
            self.order.push(id.to_string());
            self.parts.insert(
                id.to_string(),
                if reasoning {
                    OpenPart::Reasoning(String::new())
                } else {
                    OpenPart::Text(String::new())
                },
            );
        }
    }

    fn append_text(&mut self, chunk: &Value, reasoning: bool) {
        let Some(id) = chunk.get("id").and_then(Value::as_str) else {
            return;
        };
        let delta = chunk.get("delta").and_then(Value::as_str).unwrap_or("");
        if !self.parts.contains_key(id) {
            // A delta with no prior `-start` (shouldn't happen from
            // either mapper, but never lose data) — synthesize the slot.
            self.order.push(id.to_string());
            self.parts.insert(
                id.to_string(),
                if reasoning {
                    OpenPart::Reasoning(String::new())
                } else {
                    OpenPart::Text(String::new())
                },
            );
        }
        match self.parts.get_mut(id) {
            Some(OpenPart::Text(s)) if !reasoning => s.push_str(delta),
            Some(OpenPart::Reasoning(s)) if reasoning => s.push_str(delta),
            // A delta arrived for an id that's open as the OTHER kind
            // (text vs reasoning) — shouldn't happen (ids are namespaced
            // by content-block index per mapper), dropped defensively.
            _ => {}
        }
    }

    fn set_tool_input(&mut self, chunk: &Value) {
        let Some(id) = chunk.get("toolCallId").and_then(Value::as_str) else {
            return;
        };
        let tool_name = chunk
            .get("toolName")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let input = chunk.get("input").cloned().unwrap_or(Value::Null);
        if !self.parts.contains_key(id) {
            self.order.push(id.to_string());
        }
        self.parts.insert(
            id.to_string(),
            OpenPart::Tool {
                tool_name,
                input: Some(input),
                raw_input: None,
                output: None,
                error_text: None,
                state: "input-available",
            },
        );
    }

    fn set_tool_input_error(&mut self, chunk: &Value) {
        let Some(id) = chunk.get("toolCallId").and_then(Value::as_str) else {
            return;
        };
        let tool_name = chunk
            .get("toolName")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let raw_input = chunk.get("input").cloned().unwrap_or(Value::Null);
        let error_text = chunk
            .get("errorText")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if !self.parts.contains_key(id) {
            self.order.push(id.to_string());
        }
        self.parts.insert(
            id.to_string(),
            OpenPart::Tool {
                tool_name,
                // AI SDK v6 represents a static tool-input parse failure
                // with no typed `input` and preserves the rejected value in
                // `rawInput`. Keeping the same shape makes a reloaded message
                // indistinguishable from its live streamed state.
                input: None,
                raw_input: Some(raw_input),
                output: None,
                error_text: Some(error_text),
                state: "output-error",
            },
        );
    }

    fn set_tool_output(&mut self, chunk: &Value, is_error: bool) {
        let Some(id) = chunk.get("toolCallId").and_then(Value::as_str) else {
            return;
        };
        let Some(OpenPart::Tool {
            output,
            error_text,
            state,
            ..
        }) = self.parts.get_mut(id)
        else {
            // An output for a tool call we never saw the input for —
            // shouldn't happen (both mappers always emit input-available
            // before any output), dropped defensively rather than
            // panicking or fabricating a tool part with no `toolName`.
            return;
        };
        if is_error {
            *error_text = chunk
                .get("errorText")
                .and_then(Value::as_str)
                .map(str::to_string);
            *state = "output-error";
        } else {
            *output = chunk.get("output").cloned();
            *state = "output-available";
        }
    }

    /// The final reconstructed parts array, in first-seen order.
    /// `session`, when `Some((harness_id, session_id))`, appends the
    /// resume-token pseudo-part described in the module doc.
    pub fn finish(self, session: Option<(&str, &str)>) -> Vec<Value> {
        let PartsAccumulator { order, parts } = self;
        let mut out: Vec<Value> = order
            .into_iter()
            .filter_map(|id| parts.get(&id).map(|p| part_to_json(&id, p)))
            .collect();
        if let Some((harness_id, session_id)) = session {
            out.push(json!({
                "type": "data-harness-session",
                "harnessId": harness_id,
                "sessionId": session_id,
            }));
        }
        out
    }
}

fn part_to_json(id: &str, part: &OpenPart) -> Value {
    match part {
        OpenPart::Text(s) => json!({"type": "text", "text": s}),
        OpenPart::Reasoning(s) => json!({"type": "reasoning", "text": s}),
        OpenPart::Tool {
            tool_name,
            input,
            raw_input,
            output,
            error_text,
            state,
        } => {
            let mut v = json!({
                "type": format!("tool-{tool_name}"),
                "toolCallId": id,
                "state": state,
            });
            if let Some(input) = input {
                v["input"] = input.clone();
            }
            if let Some(raw_input) = raw_input {
                v["rawInput"] = raw_input.clone();
            }
            if let Some(o) = output {
                v["output"] = o.clone();
            }
            if let Some(e) = error_text {
                v["errorText"] = json!(e);
            }
            v
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accumulates_a_text_part_across_deltas() {
        let mut acc = PartsAccumulator::new();
        acc.feed(&json!({"type": "text-start", "id": "0"}));
        acc.feed(&json!({"type": "text-delta", "id": "0", "delta": "hel"}));
        acc.feed(&json!({"type": "text-delta", "id": "0", "delta": "lo"}));
        acc.feed(&json!({"type": "text-end", "id": "0"}));
        let parts = acc.finish(None);
        assert_eq!(parts, vec![json!({"type": "text", "text": "hello"})]);
    }

    #[test]
    fn accumulates_a_reasoning_part_separately_from_text() {
        let mut acc = PartsAccumulator::new();
        acc.feed(&json!({"type": "reasoning-start", "id": "0"}));
        acc.feed(&json!({"type": "reasoning-delta", "id": "0", "delta": "thinking..."}));
        acc.feed(&json!({"type": "text-start", "id": "1"}));
        acc.feed(&json!({"type": "text-delta", "id": "1", "delta": "answer"}));
        let parts = acc.finish(None);
        assert_eq!(
            parts,
            vec![
                json!({"type": "reasoning", "text": "thinking..."}),
                json!({"type": "text", "text": "answer"}),
            ]
        );
    }

    #[test]
    fn tool_call_transitions_from_input_available_to_output_available() {
        let mut acc = PartsAccumulator::new();
        acc.feed(&json!({
            "type": "tool-input-available",
            "toolCallId": "t1",
            "toolName": "Bash",
            "input": {"command": "echo hi"},
        }));
        acc.feed(&json!({
            "type": "tool-output-available",
            "toolCallId": "t1",
            "output": "hi\n",
        }));
        let parts = acc.finish(None);
        assert_eq!(
            parts,
            vec![json!({
                "type": "tool-Bash",
                "toolCallId": "t1",
                "state": "output-available",
                "input": {"command": "echo hi"},
                "output": "hi\n",
            })]
        );
    }

    #[test]
    fn tool_call_output_error_sets_error_state_and_text() {
        let mut acc = PartsAccumulator::new();
        acc.feed(&json!({
            "type": "tool-input-available",
            "toolCallId": "t1",
            "toolName": "Bash",
            "input": {},
        }));
        acc.feed(&json!({
            "type": "tool-output-error",
            "toolCallId": "t1",
            "errorText": "boom",
        }));
        let parts = acc.finish(None);
        assert_eq!(parts[0]["state"], "output-error");
        assert_eq!(parts[0]["errorText"], "boom");
    }

    #[test]
    fn tool_input_error_updates_an_existing_tool_to_a_terminal_error() {
        let mut acc = PartsAccumulator::new();
        acc.feed(&json!({
            "type": "tool-input-available",
            "toolCallId": "t1",
            "toolName": "Bash",
            "input": {"command": "echo hi"},
        }));
        acc.feed(&json!({
            "type": "tool-input-error",
            "toolCallId": "t1",
            "toolName": "Bash",
            "input": "{\"command\":",
            "errorText": "input was truncated",
        }));

        assert_eq!(
            acc.finish(None),
            vec![json!({
                "type": "tool-Bash",
                "toolCallId": "t1",
                "state": "output-error",
                "rawInput": "{\"command\":",
                "errorText": "input was truncated",
            })]
        );
    }

    #[test]
    fn direct_tool_input_error_creates_a_persistable_tool_part() {
        let mut acc = PartsAccumulator::new();
        acc.feed(&json!({
            "type": "tool-input-error",
            "toolCallId": "t-direct",
            "toolName": "Read",
            "input": {"file_path": "/partial"},
            "errorText": "stream ended",
        }));

        assert_eq!(
            acc.finish(None),
            vec![json!({
                "type": "tool-Read",
                "toolCallId": "t-direct",
                "state": "output-error",
                "rawInput": {"file_path": "/partial"},
                "errorText": "stream ended",
            })]
        );
    }

    #[test]
    fn output_for_an_unseen_tool_call_is_dropped_not_fabricated() {
        let mut acc = PartsAccumulator::new();
        acc.feed(&json!({"type": "tool-output-available", "toolCallId": "ghost", "output": 1}));
        assert_eq!(acc.finish(None), Vec::<Value>::new());
    }

    #[test]
    fn unknown_chunk_types_do_not_produce_a_part() {
        let mut acc = PartsAccumulator::new();
        acc.feed(&json!({"type": "start"}));
        acc.feed(&json!({"type": "finish", "finishReason": "stop"}));
        assert_eq!(acc.finish(None), Vec::<Value>::new());
    }

    #[test]
    fn finish_appends_the_session_pseudo_part_when_present() {
        let mut acc = PartsAccumulator::new();
        acc.feed(&json!({"type": "text-start", "id": "0"}));
        acc.feed(&json!({"type": "text-delta", "id": "0", "delta": "hi"}));
        let parts = acc.finish(Some(("claude-code", "sess-1")));
        assert_eq!(parts.len(), 2);
        assert_eq!(
            parts[1],
            json!({"type": "data-harness-session", "harnessId": "claude-code", "sessionId": "sess-1"})
        );
    }

    #[test]
    fn finish_omits_the_session_part_when_none() {
        let acc = PartsAccumulator::new();
        assert_eq!(acc.finish(None), Vec::<Value>::new());
    }

    #[test]
    fn order_is_first_seen_not_hashmap_order() {
        let mut acc = PartsAccumulator::new();
        acc.feed(&json!({"type": "text-start", "id": "z"}));
        acc.feed(&json!({"type": "text-delta", "id": "z", "delta": "Z"}));
        acc.feed(&json!({"type": "text-start", "id": "a"}));
        acc.feed(&json!({"type": "text-delta", "id": "a", "delta": "A"}));
        let parts = acc.finish(None);
        assert_eq!(parts[0]["text"], "Z");
        assert_eq!(parts[1]["text"], "A");
    }
}
