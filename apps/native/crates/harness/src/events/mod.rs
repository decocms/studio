//! ndjson → `UIMessageChunk`-shaped-JSON mapping, one submodule per CLI's
//! wire format. See `crate` module doc's "Unknown-event policy" for what
//! happens to a line neither mapper recognizes.
//!
//! Both mappers are STATEFUL (`content_block_start`/`_delta`/`_stop` for
//! claude, `item.started`/`item.completed` for codex all need to remember
//! what's "open" across lines) but PURE otherwise — `feed_line` takes a
//! `&str`, returns `Vec<MappedEvent>`, does no I/O. That's what makes them
//! unit-testable by feeding captured fixture lines (`events/fixtures/*`)
//! without spawning any process; `run.rs` is the only place that wires a
//! mapper to a real child process's stdout.

pub mod claude;
pub mod codex;

use serde_json::Value;

/// One decoded outcome from a single ndjson line of harness output.
#[derive(Debug, Clone, PartialEq)]
pub enum MappedEvent {
    /// → dispatch's `{"type":"ui-message-chunk","chunk":<Value>}`.
    Chunk(Value),
    /// The harness itself reported a terminal fatal error (Claude's
    /// `result.is_error`, Codex's `turn.failed`/top-level `error`) — NOT a
    /// JSON-parse failure on our side. Maps to dispatch's
    /// `{"type":"error",...}` immediately followed by `done`; the run
    /// stops reading further lines once this is returned.
    FatalError { message: String },
    /// A session/thread id became known — the resume token for the NEXT
    /// turn (`input.harness.sessionId` on a future dispatch). Not itself a
    /// chunk; `run.rs` threads it into the terminal `finish` chunk's
    /// metadata and (in local-api) the persisted `Run` row.
    SessionId(String),
    /// Nothing worth surfacing — see the crate doc's unknown-event policy.
    Ignored,
}

/// Builds a `MappedEvent::Chunk` from an already-shaped `UIMessageChunk`
/// JSON value. Trivial, but centralizes the "one chunk in, one event out"
/// idiom both mappers use dozens of times.
pub(crate) fn chunk(value: Value) -> MappedEvent {
    MappedEvent::Chunk(value)
}

/// Why the subprocess-backed event stream is being closed.
///
/// Mappers use this only to close protocol parts that were opened by an
/// incremental event but never received their normal terminator. The reason is
/// deliberately coarse: callers must not infer process policy from a mapper;
/// it exists so a malformed/truncated tool input can be surfaced as an error
/// instead of being promoted to an available tool call.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FlushReason {
    EndOfStream,
    Cancelled,
    Failed,
}

/// Feeds one line at a time (as a real spawned process's stdout would
/// arrive, split on `\n`) into a mapper. Implemented by both
/// [`claude::ClaudeEventMapper`] and [`codex::CodexEventMapper`].
pub trait EventMapper {
    /// `line` has its trailing newline already stripped. A line that
    /// isn't valid JSON (has been observed in the wild — see
    /// `codex_error.jsonl`'s sibling fixture's real capture printing a
    /// human `"Reading additional input from stdin..."` banner before its
    /// first JSON line when stdin isn't closed) is treated as
    /// `MappedEvent::Ignored`, never a fatal error — a stray banner line
    /// must not abort an otherwise-healthy run.
    fn feed_line(&mut self, line: &str) -> Vec<MappedEvent>;

    /// The session/thread id captured so far, if any — convenience
    /// accessor so `run.rs` can read it without re-deriving it from every
    /// `MappedEvent::SessionId` it already forwarded.
    fn session_id(&self) -> Option<&str>;

    /// Closes any incremental UI-message parts still open when the
    /// subprocess stream ends. Called for clean EOF, cancellation, and every
    /// fatal/nonzero path. Most mappers have nothing to flush; Claude's
    /// partial-message protocol needs this to pair every `*-start` with an
    /// `*-end`, and to turn a truncated tool input into
    /// `tool-input-error`.
    fn flush(&mut self, _reason: FlushReason) -> Vec<MappedEvent> {
        Vec::new()
    }
}
