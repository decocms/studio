//! `claude -p --output-format stream-json --include-partial-messages --verbose` ndjson →
//! `UIMessageChunk` mapping.
//!
//! Claude emits each partial content block twice: incremental
//! `stream_event.event.content_block_*` frames, then a complete
//! `assistant.message.content[]` snapshot immediately before that block's
//! `content_block_stop`. The mapper streams the partial frames and uses
//! the snapshot only to append a missing suffix or finalize tool input.
//! It retains the complete-frame path as a fallback for older CLIs and
//! the deterministic stub, which emit no partial frames.
//! This ordering was re-verified live with Claude Code 2.1.218 on
//! 2026-07-23; `fixtures/claude_partial.jsonl` is a trimmed deterministic
//! representation of that capture.
//!
//! Event mapping:
//! - `system.init` → [`crate::events::MappedEvent::SessionId`] (captured,
//!   no chunk) + one `{"type":"start"}` chunk.
//! - `stream_event.content_block_*` → incremental text, reasoning, and
//!   tool-input chunks with stable per-block ids.
//! - `assistant.message.content[]` → suffix/finalization for a matching
//!   partial block, or a complete one-shot block when no partial exists.
//! - `user.message.content[]` (`tool_result` items) →
//!   `tool-output-available` / `tool-output-error`.
//! - `result`, `is_error:true` → `MappedEvent::FatalError` (message from
//!   `result.result` if present, else the first `result.errors[]` entry).
//! - `result`, `is_error:false` → one `finish` chunk carrying
//!   usage/cost/session metadata.
//! - unknown events and unparseable lines → ignored.

use std::collections::BTreeMap;

use serde_json::{json, Value};

use super::{chunk, EventMapper, FlushReason, MappedEvent};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PartialBlockKind {
    Text,
    Reasoning,
    Tool,
}

#[derive(Debug, Default)]
struct BlockStatus {
    stopped: bool,
    snapshot_seen: bool,
    finalized: bool,
}

#[derive(Debug)]
enum PartialBlock {
    Text {
        id: String,
        emitted: String,
        status: BlockStatus,
    },
    Reasoning {
        id: String,
        emitted: String,
        status: BlockStatus,
    },
    Tool {
        tool_call_id: String,
        tool_name: String,
        input_text: String,
        final_input: Option<Value>,
        status: BlockStatus,
    },
}

impl PartialBlock {
    fn kind(&self) -> PartialBlockKind {
        match self {
            Self::Text { .. } => PartialBlockKind::Text,
            Self::Reasoning { .. } => PartialBlockKind::Reasoning,
            Self::Tool { .. } => PartialBlockKind::Tool,
        }
    }

    fn status(&self) -> &BlockStatus {
        match self {
            Self::Text { status, .. }
            | Self::Reasoning { status, .. }
            | Self::Tool { status, .. } => status,
        }
    }

    fn status_mut(&mut self) -> &mut BlockStatus {
        match self {
            Self::Text { status, .. }
            | Self::Reasoning { status, .. }
            | Self::Tool { status, .. } => status,
        }
    }

    fn matches_snapshot(&self, block: &Value) -> bool {
        match self {
            Self::Text { emitted, .. } => {
                let Some(text) = block.get("text").and_then(Value::as_str) else {
                    return false;
                };
                block.get("type").and_then(Value::as_str) == Some("text")
                    && (text.starts_with(emitted) || emitted.starts_with(text))
            }
            Self::Reasoning { emitted, .. } => {
                let Some(thinking) = block.get("thinking").and_then(Value::as_str) else {
                    return false;
                };
                block.get("type").and_then(Value::as_str) == Some("thinking")
                    && (thinking.starts_with(emitted) || emitted.starts_with(thinking))
            }
            Self::Tool {
                tool_call_id,
                tool_name,
                ..
            } => {
                if block.get("type").and_then(Value::as_str) != Some("tool_use") {
                    return false;
                }
                let snapshot_id = block.get("id").and_then(Value::as_str).unwrap_or("");
                let snapshot_name = block.get("name").and_then(Value::as_str).unwrap_or("");
                (!snapshot_id.is_empty() && snapshot_id == tool_call_id)
                    || (snapshot_id.is_empty()
                        && !snapshot_name.is_empty()
                        && snapshot_name == tool_name)
            }
        }
    }

    fn apply_delta(&mut self, delta: &Value) -> Vec<MappedEvent> {
        match self {
            Self::Text { id, emitted, .. }
                if delta.get("type").and_then(Value::as_str) == Some("text_delta") =>
            {
                let text = delta.get("text").and_then(Value::as_str).unwrap_or("");
                emitted.push_str(text);
                if text.is_empty() {
                    vec![]
                } else {
                    vec![chunk(
                        json!({"type": "text-delta", "id": id, "delta": text}),
                    )]
                }
            }
            Self::Reasoning { id, emitted, .. }
                if delta.get("type").and_then(Value::as_str) == Some("thinking_delta") =>
            {
                let thinking = delta.get("thinking").and_then(Value::as_str).unwrap_or("");
                emitted.push_str(thinking);
                if thinking.is_empty() {
                    vec![]
                } else {
                    vec![chunk(
                        json!({"type": "reasoning-delta", "id": id, "delta": thinking}),
                    )]
                }
            }
            Self::Tool {
                tool_call_id,
                input_text,
                ..
            } if delta.get("type").and_then(Value::as_str) == Some("input_json_delta") => {
                let partial = delta
                    .get("partial_json")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                input_text.push_str(partial);
                if partial.is_empty() {
                    vec![]
                } else {
                    vec![chunk(json!({
                        "type": "tool-input-delta",
                        "toolCallId": tool_call_id,
                        "inputTextDelta": partial,
                    }))]
                }
            }
            _ => vec![],
        }
    }

    fn apply_snapshot(&mut self, block: &Value) -> Vec<MappedEvent> {
        let mut out = Vec::new();
        match self {
            Self::Text {
                id,
                emitted,
                status,
            } => {
                let snapshot = block.get("text").and_then(Value::as_str).unwrap_or("");
                append_missing_suffix(&mut out, "text-delta", id, emitted, snapshot);
                status.snapshot_seen = true;
            }
            Self::Reasoning {
                id,
                emitted,
                status,
            } => {
                let snapshot = block.get("thinking").and_then(Value::as_str).unwrap_or("");
                append_missing_suffix(&mut out, "reasoning-delta", id, emitted, snapshot);
                status.snapshot_seen = true;
            }
            Self::Tool {
                tool_call_id,
                input_text,
                final_input,
                status,
                ..
            } => {
                let input = block.get("input").cloned().unwrap_or_else(|| json!({}));
                let snapshot_text = serde_json::to_string(&input).unwrap_or_default();
                if let Some(suffix) = snapshot_text.strip_prefix(input_text.as_str()) {
                    if !suffix.is_empty() {
                        input_text.push_str(suffix);
                        out.push(chunk(json!({
                            "type": "tool-input-delta",
                            "toolCallId": tool_call_id,
                            "inputTextDelta": suffix,
                        })));
                    }
                }
                *final_input = Some(input);
                status.snapshot_seen = true;
            }
        }
        out
    }

    fn mark_stopped(&mut self) {
        self.status_mut().stopped = true;
    }

    fn should_finalize(&self) -> bool {
        let status = self.status();
        status.stopped && status.snapshot_seen
    }

    fn finalize(&mut self) -> Vec<MappedEvent> {
        if self.status().finalized {
            return vec![];
        }
        self.status_mut().finalized = true;
        match self {
            Self::Text { id, .. } => vec![chunk(json!({"type": "text-end", "id": id}))],
            Self::Reasoning { id, .. } => {
                vec![chunk(json!({"type": "reasoning-end", "id": id}))]
            }
            Self::Tool {
                tool_call_id,
                tool_name,
                input_text,
                final_input,
                ..
            } => {
                if let Some(input) = final_input.clone() {
                    vec![chunk(json!({
                        "type": "tool-input-available",
                        "toolCallId": tool_call_id,
                        "toolName": tool_name,
                        "input": input,
                    }))]
                } else {
                    let input = serde_json::from_str(input_text)
                        .unwrap_or_else(|_| Value::String(input_text.clone()));
                    vec![chunk(json!({
                        "type": "tool-input-error",
                        "toolCallId": tool_call_id,
                        "toolName": tool_name,
                        "input": input,
                        "errorText": "Claude's stream ended before the tool input was complete",
                    }))]
                }
            }
        }
    }
}

fn append_missing_suffix(
    out: &mut Vec<MappedEvent>,
    chunk_type: &str,
    id: &str,
    emitted: &mut String,
    snapshot: &str,
) {
    let Some(suffix) = snapshot.strip_prefix(emitted.as_str()) else {
        return;
    };
    if suffix.is_empty() {
        return;
    }
    emitted.push_str(suffix);
    out.push(chunk(json!({
        "type": chunk_type,
        "id": id,
        "delta": suffix,
    })));
}

#[derive(Debug, Default)]
pub struct ClaudeEventMapper {
    session_id: Option<String>,
    started: bool,
    next_id: u64,
    partial_blocks: BTreeMap<u64, PartialBlock>,
    current_block_index: Option<u64>,
}

impl ClaudeEventMapper {
    pub fn new() -> Self {
        Self::default()
    }

    fn next_part_id(&mut self) -> String {
        let id = self.next_id;
        self.next_id += 1;
        id.to_string()
    }

    fn handle_top_level(&mut self, value: &Value) -> Vec<MappedEvent> {
        match value.get("type").and_then(Value::as_str) {
            Some("system") => self.handle_system(value),
            Some("assistant") => self.handle_assistant(value),
            Some("user") => self.handle_user(value),
            Some("result") => self.handle_result(value),
            Some("stream_event") => self.handle_stream_event(value),
            _ => vec![],
        }
    }

    fn handle_system(&mut self, value: &Value) -> Vec<MappedEvent> {
        if value.get("subtype").and_then(Value::as_str) != Some("init") {
            return vec![];
        }
        let mut out = Vec::new();
        if !self.started {
            self.started = true;
            out.push(chunk(json!({"type": "start"})));
        }
        if let Some(sid) = value.get("session_id").and_then(Value::as_str) {
            self.session_id = Some(sid.to_string());
            out.push(MappedEvent::SessionId(sid.to_string()));
        }
        out
    }

    fn handle_assistant(&mut self, value: &Value) -> Vec<MappedEvent> {
        let Some(content) = value.pointer("/message/content").and_then(Value::as_array) else {
            return vec![];
        };
        let mut out = Vec::new();
        for block in content {
            let Some(index) = self.matching_partial_index(block) else {
                out.extend(self.emit_complete_block(block));
                continue;
            };
            let Some(partial) = self.partial_blocks.get_mut(&index) else {
                continue;
            };
            out.extend(partial.apply_snapshot(block));
            if partial.should_finalize() {
                out.extend(partial.finalize());
            }
        }
        out
    }

    fn emit_complete_block(&mut self, block: &Value) -> Vec<MappedEvent> {
        match block.get("type").and_then(Value::as_str) {
            Some("text") => {
                let text = block.get("text").and_then(Value::as_str).unwrap_or("");
                let id = self.next_part_id();
                vec![
                    chunk(json!({"type": "text-start", "id": id})),
                    chunk(json!({"type": "text-delta", "id": id, "delta": text})),
                    chunk(json!({"type": "text-end", "id": id})),
                ]
            }
            Some("thinking") => {
                let text = block.get("thinking").and_then(Value::as_str).unwrap_or("");
                let id = self.next_part_id();
                vec![
                    chunk(json!({"type": "reasoning-start", "id": id})),
                    chunk(json!({"type": "reasoning-delta", "id": id, "delta": text})),
                    chunk(json!({"type": "reasoning-end", "id": id})),
                ]
            }
            Some("tool_use") => {
                let tool_call_id = block
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let tool_name = block
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let input = block.get("input").cloned().unwrap_or_else(|| json!({}));
                let input_text = serde_json::to_string(&input).unwrap_or_default();
                vec![
                    chunk(json!({
                        "type": "tool-input-start",
                        "toolCallId": tool_call_id,
                        "toolName": tool_name,
                    })),
                    chunk(json!({
                        "type": "tool-input-delta",
                        "toolCallId": tool_call_id,
                        "inputTextDelta": input_text,
                    })),
                    chunk(json!({
                        "type": "tool-input-available",
                        "toolCallId": tool_call_id,
                        "toolName": tool_name,
                        "input": input,
                    })),
                ]
            }
            // `redacted_thinking`/any future block type: dropped rather
            // than guessed at.
            _ => vec![],
        }
    }

    fn matching_partial_index(&self, block: &Value) -> Option<u64> {
        let kind = match block.get("type").and_then(Value::as_str) {
            Some("text") => PartialBlockKind::Text,
            Some("thinking") => PartialBlockKind::Reasoning,
            Some("tool_use") => PartialBlockKind::Tool,
            _ => return None,
        };

        if let Some(index) = self.current_block_index {
            if self
                .partial_blocks
                .get(&index)
                .is_some_and(|partial| partial.kind() == kind && partial.matches_snapshot(block))
            {
                return Some(index);
            }
        }

        if let Some((index, _)) = self
            .partial_blocks
            .iter()
            .rev()
            .find(|(_, partial)| partial.kind() == kind && partial.matches_snapshot(block))
        {
            return Some(*index);
        }

        let mut unmatched = self
            .partial_blocks
            .iter()
            .filter(|(_, partial)| partial.kind() == kind && !partial.status().snapshot_seen);
        let (index, _) = unmatched.next()?;
        if unmatched.next().is_none() {
            Some(*index)
        } else {
            None
        }
    }

    fn handle_stream_event(&mut self, value: &Value) -> Vec<MappedEvent> {
        let Some(event) = value.get("event") else {
            return vec![];
        };
        match event.get("type").and_then(Value::as_str) {
            Some("message_start") => self.finish_partial_message(),
            Some("content_block_start") => self.handle_content_block_start(event),
            Some("content_block_delta") => self.handle_content_block_delta(event),
            Some("content_block_stop") => self.handle_content_block_stop(event),
            Some("message_stop") => self.finish_partial_message(),
            _ => vec![],
        }
    }

    fn handle_content_block_start(&mut self, event: &Value) -> Vec<MappedEvent> {
        let Some(index) = event.get("index").and_then(Value::as_u64) else {
            return vec![];
        };
        let Some(block) = event.get("content_block") else {
            return vec![];
        };

        let mut out = Vec::new();
        if let Some(mut prior) = self.partial_blocks.remove(&index) {
            out.extend(prior.finalize());
        }

        let partial = match block.get("type").and_then(Value::as_str) {
            Some("text") => {
                let id = self.next_part_id();
                let initial = block
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                out.push(chunk(json!({"type": "text-start", "id": id})));
                if !initial.is_empty() {
                    out.push(chunk(
                        json!({"type": "text-delta", "id": id, "delta": initial}),
                    ));
                }
                PartialBlock::Text {
                    id,
                    emitted: initial,
                    status: BlockStatus::default(),
                }
            }
            Some("thinking") => {
                let id = self.next_part_id();
                let initial = block
                    .get("thinking")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                out.push(chunk(json!({"type": "reasoning-start", "id": id})));
                if !initial.is_empty() {
                    out.push(chunk(
                        json!({"type": "reasoning-delta", "id": id, "delta": initial}),
                    ));
                }
                PartialBlock::Reasoning {
                    id,
                    emitted: initial,
                    status: BlockStatus::default(),
                }
            }
            Some("tool_use") => {
                let tool_call_id = block
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let tool_name = block
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                out.push(chunk(json!({
                    "type": "tool-input-start",
                    "toolCallId": tool_call_id,
                    "toolName": tool_name,
                })));
                PartialBlock::Tool {
                    tool_call_id,
                    tool_name,
                    input_text: String::new(),
                    final_input: None,
                    status: BlockStatus::default(),
                }
            }
            _ => return out,
        };

        self.partial_blocks.insert(index, partial);
        self.current_block_index = Some(index);
        out
    }

    fn handle_content_block_delta(&mut self, event: &Value) -> Vec<MappedEvent> {
        let Some(index) = event.get("index").and_then(Value::as_u64) else {
            return vec![];
        };
        let Some(delta) = event.get("delta") else {
            return vec![];
        };
        self.partial_blocks
            .get_mut(&index)
            .map_or_else(Vec::new, |partial| partial.apply_delta(delta))
    }

    fn handle_content_block_stop(&mut self, event: &Value) -> Vec<MappedEvent> {
        let Some(index) = event.get("index").and_then(Value::as_u64) else {
            return vec![];
        };
        if self.current_block_index == Some(index) {
            self.current_block_index = None;
        }
        let Some(partial) = self.partial_blocks.get_mut(&index) else {
            return vec![];
        };
        partial.mark_stopped();
        if partial.should_finalize() {
            partial.finalize()
        } else {
            vec![]
        }
    }

    fn finish_partial_message(&mut self) -> Vec<MappedEvent> {
        let mut out = Vec::new();
        for partial in self.partial_blocks.values_mut() {
            out.extend(partial.finalize());
        }
        self.partial_blocks.clear();
        self.current_block_index = None;
        out
    }

    fn handle_user(&mut self, value: &Value) -> Vec<MappedEvent> {
        let mut out = self.finish_partial_message();
        let Some(content) = value.pointer("/message/content").and_then(Value::as_array) else {
            return out;
        };
        out.extend(
            content
                .iter()
                .filter_map(|item| {
                    if item.get("type").and_then(Value::as_str) != Some("tool_result") {
                        return None;
                    }
                    let tool_call_id = item.get("tool_use_id").and_then(Value::as_str)?.to_string();
                    let is_error = item
                        .get("is_error")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    let content_val = item.get("content").cloned().unwrap_or(Value::Null);
                    Some(if is_error {
                        chunk(json!({
                            "type": "tool-output-error",
                            "toolCallId": tool_call_id,
                            "errorText": stringify_tool_content(&content_val),
                        }))
                    } else {
                        chunk(json!({
                            "type": "tool-output-available",
                            "toolCallId": tool_call_id,
                            "output": content_val,
                        }))
                    })
                })
                .collect::<Vec<_>>(),
        );
        out
    }

    fn handle_result(&mut self, value: &Value) -> Vec<MappedEvent> {
        let mut out = self.finish_partial_message();
        // Error results can be the only frame carrying the session id (for
        // example, an early resume failure with no preceding init). Capture it
        // before branching on `is_error` so the durable assistant result keeps
        // the resume anchor even though this turn itself failed.
        if let Some(sid) = value
            .get("session_id")
            .and_then(Value::as_str)
            .filter(|sid| !sid.trim().is_empty())
        {
            self.session_id = Some(sid.to_string());
            out.push(MappedEvent::SessionId(sid.to_string()));
        }
        let is_error = value
            .get("is_error")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if is_error {
            let message = value
                .get("result")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .or_else(|| {
                    // The stub's `fail` scenario (and, per the module doc,
                    // possibly the real CLI) carries `errors: [string]`
                    // instead of a `result` string on an error frame.
                    value
                        .get("errors")
                        .and_then(Value::as_array)
                        .and_then(|arr| arr.first())
                        .and_then(Value::as_str)
                        .map(str::to_string)
                })
                .or_else(|| {
                    value
                        .get("subtype")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                })
                .unwrap_or_else(|| "claude CLI reported an error".to_string());
            out.push(MappedEvent::FatalError { message });
            return out;
        }

        let usage = value.get("usage").cloned().unwrap_or(Value::Null);
        let total_cost_usd = value.get("total_cost_usd").cloned().unwrap_or(Value::Null);
        out.push(chunk(json!({
            "type": "finish",
            "finishReason": "stop",
            "messageMetadata": {
                "usage": usage,
                "totalCostUsd": total_cost_usd,
                "codingAgentProvider": "claude-code",
                "codingAgentSessionId": self.session_id,
            },
        })));
        out
    }
}

/// Best-effort text extraction from a `tool_result` content value for the
/// `tool-output-error` chunk's `errorText` (a plain string per the AI
/// SDK's `UIMessageChunk` shape) — the CLI's `content` field itself may be
/// a string OR an array of content blocks.
fn stringify_tool_content(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Array(items) => items
            .iter()
            .filter_map(|item| item.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        other => other.to_string(),
    }
}

impl EventMapper for ClaudeEventMapper {
    fn feed_line(&mut self, line: &str) -> Vec<MappedEvent> {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            return vec![];
        }
        let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
            // A stray non-JSON line (banners, warnings) must not abort an
            // otherwise-healthy run.
            return vec![];
        };
        self.handle_top_level(&value)
    }

    fn session_id(&self) -> Option<&str> {
        self.session_id.as_deref()
    }

    fn flush(&mut self, _reason: FlushReason) -> Vec<MappedEvent> {
        self.finish_partial_message()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SIMPLE_FIXTURE: &str = include_str!("fixtures/claude_simple.jsonl");
    const ERROR_FIXTURE: &str = include_str!("fixtures/claude_error.jsonl");
    const PARTIAL_FIXTURE: &str = include_str!("fixtures/claude_partial.jsonl");
    const TOOL_USE_FIXTURE: &str = include_str!("fixtures/claude_tool_use.jsonl");

    fn feed_all(mapper: &mut ClaudeEventMapper, fixture: &str) -> Vec<MappedEvent> {
        fixture
            .lines()
            .flat_map(|line| mapper.feed_line(line))
            .collect()
    }

    #[test]
    fn simple_fixture_yields_start_session_text_and_finish() {
        let mut mapper = ClaudeEventMapper::new();
        let events = feed_all(&mut mapper, SIMPLE_FIXTURE);

        assert_eq!(events.first(), Some(&chunk(json!({"type": "start"}))));
        assert!(events
            .iter()
            .any(|e| matches!(e, MappedEvent::SessionId(_))));
        assert!(mapper.session_id().is_some());

        let text_deltas: Vec<&str> = events
            .iter()
            .filter_map(|e| match e {
                MappedEvent::Chunk(v) if v["type"] == "text-delta" => v["delta"].as_str(),
                _ => None,
            })
            .collect();
        assert_eq!(text_deltas.join(""), "pong");

        let finish = events
            .iter()
            .find(|e| matches!(e, MappedEvent::Chunk(v) if v["type"] == "finish"))
            .expect("a finish chunk");
        let MappedEvent::Chunk(finish) = finish else {
            unreachable!()
        };
        assert_eq!(finish["finishReason"], "stop");
        assert_eq!(
            finish["messageMetadata"]["codingAgentProvider"],
            "claude-code"
        );

        assert!(!events
            .iter()
            .any(|e| matches!(e, MappedEvent::FatalError { .. })));
    }

    #[test]
    fn start_chunk_is_emitted_exactly_once() {
        let mut mapper = ClaudeEventMapper::new();
        let events = feed_all(&mut mapper, SIMPLE_FIXTURE);
        let starts = events
            .iter()
            .filter(|e| matches!(e, MappedEvent::Chunk(v) if v["type"] == "start"))
            .count();
        assert_eq!(starts, 1);
    }

    #[test]
    fn tool_use_fixture_yields_tool_input_and_output_chunks() {
        let mut mapper = ClaudeEventMapper::new();
        let events = feed_all(&mut mapper, TOOL_USE_FIXTURE);

        let available = events
            .iter()
            .find(|e| matches!(e, MappedEvent::Chunk(v) if v["type"] == "tool-input-available"))
            .expect("a tool-input-available chunk");
        let MappedEvent::Chunk(available) = available else {
            unreachable!()
        };
        assert_eq!(available["toolCallId"], "toolu_01ABC");
        assert_eq!(available["toolName"], "Bash");
        assert_eq!(available["input"]["command"], "echo hi");

        let output = events
            .iter()
            .find(|e| matches!(e, MappedEvent::Chunk(v) if v["type"] == "tool-output-available"))
            .expect("a tool-output-available chunk");
        let MappedEvent::Chunk(output) = output else {
            unreachable!()
        };
        assert_eq!(output["toolCallId"], "toolu_01ABC");
    }

    #[test]
    fn result_is_error_true_with_result_field_yields_a_fatal_error() {
        let mut mapper = ClaudeEventMapper::new();
        let events = feed_all(&mut mapper, ERROR_FIXTURE);
        assert_eq!(
            events.last(),
            Some(&MappedEvent::FatalError {
                message: "API Error: 529 overloaded".to_string()
            })
        );
    }

    #[test]
    fn result_is_error_true_with_errors_array_falls_back_to_the_first_entry() {
        let mut mapper = ClaudeEventMapper::new();
        let events = mapper.feed_line(
            r#"{"type":"result","subtype":"error_during_execution","is_error":true,"errors":["stub-harness: induced failure"]}"#,
        );
        assert_eq!(
            events,
            vec![MappedEvent::FatalError {
                message: "stub-harness: induced failure".to_string()
            }]
        );
    }

    #[test]
    fn error_result_captures_session_before_reporting_the_failure() {
        let mut mapper = ClaudeEventMapper::new();
        let events = mapper.feed_line(
            r#"{"type":"result","subtype":"error_during_execution","is_error":true,"result":"failed","session_id":"error-session"}"#,
        );
        assert_eq!(
            events,
            vec![
                MappedEvent::SessionId("error-session".to_string()),
                MappedEvent::FatalError {
                    message: "failed".to_string()
                }
            ]
        );
        assert_eq!(mapper.session_id(), Some("error-session"));
    }

    #[test]
    fn malformed_json_line_is_ignored_not_fatal() {
        let mut mapper = ClaudeEventMapper::new();
        let events = mapper.feed_line("Reading additional input from stdin...");
        assert_eq!(events, vec![]);
    }

    #[test]
    fn blank_line_is_ignored() {
        let mut mapper = ClaudeEventMapper::new();
        assert_eq!(mapper.feed_line(""), vec![]);
        assert_eq!(mapper.feed_line("   "), vec![]);
    }

    #[test]
    fn unknown_top_level_type_is_ignored() {
        let mut mapper = ClaudeEventMapper::new();
        let events = mapper.feed_line(r#"{"type":"rate_limit_event","rate_limit_info":{}}"#);
        assert_eq!(events, vec![]);
    }

    #[test]
    fn partial_text_is_streamed_and_the_identical_snapshot_is_deduplicated() {
        let mut mapper = ClaudeEventMapper::new();
        let fixture = [
            r#"{"type":"stream_event","event":{"type":"message_start","message":{"content":[]}}}"#,
            r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}}"#,
            r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"pong"}}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"pong"}]}}"#,
            r#"{"type":"stream_event","event":{"type":"content_block_stop","index":0}}"#,
            r#"{"type":"stream_event","event":{"type":"message_stop"}}"#,
        ]
        .join("\n");
        let events = feed_all(&mut mapper, &fixture);

        let text_deltas: Vec<&str> = events
            .iter()
            .filter_map(|event| match event {
                MappedEvent::Chunk(value) if value["type"] == "text-delta" => {
                    value["delta"].as_str()
                }
                _ => None,
            })
            .collect();
        assert_eq!(text_deltas, vec!["pong"]);
        assert_eq!(
            events
                .iter()
                .filter(|event| matches!(
                    event,
                    MappedEvent::Chunk(value) if value["type"] == "text-start"
                ))
                .count(),
            1
        );
        assert_eq!(
            events
                .iter()
                .filter(|event| matches!(
                    event,
                    MappedEvent::Chunk(value) if value["type"] == "text-end"
                ))
                .count(),
            1
        );
    }

    #[test]
    fn eof_closes_a_partial_text_block_exactly_once() {
        let mut mapper = ClaudeEventMapper::new();
        let events = mapper.feed_line(
            r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":"hel"}}}"#,
        );
        assert!(events.iter().any(
            |event| matches!(event, MappedEvent::Chunk(value) if value["type"] == "text-start")
        ));

        let flushed = mapper.flush(FlushReason::EndOfStream);
        assert_eq!(flushed, vec![chunk(json!({"type": "text-end", "id": "0"}))]);
        assert!(mapper.flush(FlushReason::EndOfStream).is_empty());
    }

    #[test]
    fn cancellation_closes_a_partial_reasoning_block() {
        let mut mapper = ClaudeEventMapper::new();
        mapper.feed_line(
            r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}}"#,
        );
        mapper.feed_line(
            r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"still thinking"}}}"#,
        );

        assert_eq!(
            mapper.flush(FlushReason::Cancelled),
            vec![chunk(json!({"type": "reasoning-end", "id": "0"}))]
        );
    }

    #[test]
    fn failed_stream_turns_partial_tool_input_into_tool_input_error() {
        let mut mapper = ClaudeEventMapper::new();
        mapper.feed_line(
            r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_cut","name":"Bash","input":{}}}}"#,
        );
        mapper.feed_line(
            r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"command\":"}}}"#,
        );

        let flushed = mapper.flush(FlushReason::Failed);
        assert_eq!(
            flushed,
            vec![chunk(json!({
                "type": "tool-input-error",
                "toolCallId": "toolu_cut",
                "toolName": "Bash",
                "input": "{\"command\":",
                "errorText": "Claude's stream ended before the tool input was complete",
            }))]
        );
        assert!(!flushed.iter().any(
            |event| matches!(event, MappedEvent::Chunk(value) if value["type"] == "tool-input-available")
        ));
    }

    #[test]
    fn partial_fixture_appends_snapshot_suffixes_and_finalizes_reasoning_and_tools() {
        let mut mapper = ClaudeEventMapper::new();
        let events = feed_all(&mut mapper, PARTIAL_FIXTURE);

        let text = events
            .iter()
            .filter_map(|event| match event {
                MappedEvent::Chunk(value) if value["type"] == "text-delta" => {
                    value["delta"].as_str()
                }
                _ => None,
            })
            .collect::<String>();
        assert_eq!(text, "hello");

        let reasoning = events
            .iter()
            .filter_map(|event| match event {
                MappedEvent::Chunk(value) if value["type"] == "reasoning-delta" => {
                    value["delta"].as_str()
                }
                _ => None,
            })
            .collect::<String>();
        assert_eq!(reasoning, "Checking the task");

        let tool_input_text = events
            .iter()
            .filter_map(|event| match event {
                MappedEvent::Chunk(value) if value["type"] == "tool-input-delta" => {
                    value["inputTextDelta"].as_str()
                }
                _ => None,
            })
            .collect::<String>();
        assert_eq!(tool_input_text, r#"{"command":"echo hi"}"#);

        let tool_available: Vec<&Value> = events
            .iter()
            .filter_map(|event| match event {
                MappedEvent::Chunk(value) if value["type"] == "tool-input-available" => Some(value),
                _ => None,
            })
            .collect();
        assert_eq!(tool_available.len(), 1);
        assert_eq!(tool_available[0]["toolCallId"], "toolu_partial");
        assert_eq!(tool_available[0]["input"]["command"], "echo hi");
        assert!(events
            .iter()
            .filter_map(|event| match event {
                MappedEvent::Chunk(value) if value["type"] == "tool-input-start" => {
                    value["toolCallId"].as_str()
                }
                _ => None,
            })
            .all(|id| id == "toolu_partial"));

        for (start, end) in [
            ("text-start", "text-end"),
            ("reasoning-start", "reasoning-end"),
        ] {
            assert_eq!(
                events
                    .iter()
                    .filter(|event| matches!(
                        event,
                        MappedEvent::Chunk(value) if value["type"] == start
                    ))
                    .count(),
                1
            );
            assert_eq!(
                events
                    .iter()
                    .filter(|event| matches!(
                        event,
                        MappedEvent::Chunk(value) if value["type"] == end
                    ))
                    .count(),
                1
            );
            let start_id = events.iter().find_map(|event| match event {
                MappedEvent::Chunk(value) if value["type"] == start => value["id"].as_str(),
                _ => None,
            });
            let end_id = events.iter().find_map(|event| match event {
                MappedEvent::Chunk(value) if value["type"] == end => value["id"].as_str(),
                _ => None,
            });
            assert_eq!(start_id, end_id);
        }
    }

    #[test]
    fn multiple_assistant_frames_each_contribute_their_own_text_block() {
        // Mirrors stub-harness.mjs's SCENARIO:simple: 3 separate
        // `assistant` frames, each with ONE new text block — not an
        // accumulating snapshot.
        let mut mapper = ClaudeEventMapper::new();
        mapper.feed_line(r#"{"type":"system","subtype":"init","session_id":"s1"}"#);
        let e1 = mapper.feed_line(
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Hello"}]}}"#,
        );
        let e2 = mapper.feed_line(
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":" from"}]}}"#,
        );
        let e3 = mapper.feed_line(
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":" stub"}]}}"#,
        );
        let all: Vec<MappedEvent> = [e1, e2, e3].concat();
        let deltas: Vec<&str> = all
            .iter()
            .filter_map(|e| match e {
                MappedEvent::Chunk(v) if v["type"] == "text-delta" => v["delta"].as_str(),
                _ => None,
            })
            .collect();
        assert_eq!(deltas, vec!["Hello", " from", " stub"]);
        // Each block gets its OWN part id (start/end pair), not shared.
        let starts = all
            .iter()
            .filter(|e| matches!(e, MappedEvent::Chunk(v) if v["type"] == "text-start"))
            .count();
        assert_eq!(starts, 3);
    }
}
