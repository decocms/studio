//! `harness` — CLI detection, model tiers, process spawn, and ndjson→SSE
//! stream translation for the two harness CLIs desktop v1 supports
//! (`claude`, `codex` — see the desktop migration contract decision
//! 1: no Decopilot in the desktop app). Consumed by
//! `crates/local-api`'s `routes/dispatch.rs` (real streaming) and
//! `routes/models.rs` (`GET /models` detection + tiers).
//!
//! ## Module map
//!
//! - [`resolve`] — binary resolution. Implements the SHARED CONTRACT env
//!   overrides (`LOCAL_API_CLAUDE_BIN` / `LOCAL_API_CODEX_BIN`, absolute
//!   path or argv JSON array) with a PATH fallback to `claude`/`codex`.
//! - [`tiers`] — the model-tier tables ported verbatim (same ids/labels)
//!   from `packages/harness/src/{claude-code,codex}/model/agent-tiers.ts`,
//!   plus the composite-id → CLI `--model` flag resolvers ported from
//!   `packages/harness/src/{claude-code,codex}/model/index.ts`.
//! - [`detect`] — CLI availability probing with GROW-ONLY caching, mirroring
//!   `apps/api/src/link-daemon/capabilities.ts`'s semantics: a transient
//!   probe failure never un-lists a CLI that was previously detected.
//! - [`spawn`] — the one process-spawn abstraction (PTY via `portable-pty`
//!   OR plain pipes), 128+signal exit-code convention, process-group kill.
//!   See that module's doc comment for why harness dispatch defaults to
//!   plain pipes (investigated + documented, not just asserted).
//! - [`watchdog`] — the parent-liveness watchdog script and anchored
//!   process-group helpers, shared with `crates/local-api`'s
//!   `ProcessGroupChild` so crash-recovery semantics cannot drift between
//!   the two spawn families (see that module's doc comment).
//! - [`events`] — incremental ndjson→`UIMessageChunk`-shaped-JSON mapping
//!   for each CLI's wire format (`events::claude`, `events::codex`).
//! - [`run`] — ties the above together: resolve → spawn → parse → yield,
//!   with cancellation support. The type `local-api`'s dispatch route
//!   actually drives.
//! - [`parts`] — reconstructs a UIMessage-shaped `parts` array from a
//!   run's chunk stream, for persisting the assistant `Message` row (see
//!   that module's doc for the resume-token convention it introduces).
//!
//! ## Unknown-event policy
//!
//! the native local-API contract's Dispatch Lifecycle section
//! pins exactly three SSE event shapes for `POST /_sandbox/dispatch`:
//! `ui-message-chunk`, `error`, and `done` — it defines no "escape hatch"
//! wire shape for an event this crate doesn't recognize. So: every ndjson
//! line this crate can't confidently map to one of those three lands as
//! [`events::MappedEvent::Ignored`] and is silently dropped, never
//! forwarded raw. Forwarding an unrecognized shape under the
//! `ui-message-chunk` envelope would violate its "opaque `UIMessageChunk`"
//! contract (the desktop frontend, Phase 3, expects genuine AI-SDK-shaped
//! chunks) — dropping is the conservative reading of "follow the contract
//! doc exactly" when the doc simply doesn't define that hatch.
#![forbid(unsafe_code)]

pub mod detect;
pub mod events;
pub mod parts;
pub mod resolve;
pub mod run;
pub mod spawn;
pub mod tiers;
pub mod title;
pub mod watchdog;

pub use resolve::{resolve_argv, resolve_checked, HarnessId, ResolveError};
pub use tiers::{ModelTier, CLAUDE_CODE_TIERS, CODEX_TIERS};
