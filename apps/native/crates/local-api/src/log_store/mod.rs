//! File-backed log retention — the durable, on-disk half of this crate's
//! log pipeline. Owner decision (see the module-owner report this shipped
//! with): **files are the source of truth for RETAINED output; RAM holds
//! only the TRANSIENT live fan-out**. Concretely:
//!
//! - [`store::LogStore`] owns every byte anyone might want to read back
//!   later — SSE replay-on-connect frames (`routes/events.rs`), a task's
//!   buffered output (`GET /_sandbox/tasks/:id`), and a task's own
//!   replay-then-live stream (`GET /_sandbox/tasks/:id/stream`). One
//!   instance per app workdir (the process-global one wired in `lib.rs`,
//!   one more per `sandbox::manager::Sandbox`), rooted at `<workdir>/logs`.
//! - The broadcaster (`events::Broadcaster`) and a task's own
//!   `chunks_tx` (`tasks::registry::TaskEntry`) still exist, but ONLY as
//!   in-memory fan-out for whoever is live-subscribed RIGHT NOW — neither
//!   buffers a backlog anymore. A subscriber that connects late gets
//!   caught up by reading [`store::LogStore`] instead.
//!
//! Byte-parity target: `packages/sandbox/daemon-go/internal/proc/logtee.go`
//! (`LogTee`, the at-cap rotation behavior — see [`store::WRITE_CAP_BYTES`])
//! and `packages/sandbox/daemon-go/internal/events/replay.go` (`ReplayBuffer`, the
//! tail-read size — see [`store::DEFAULT_TAIL_BYTES`]). The old daemon kept
//! these as TWO separate mechanisms (an in-RAM 256KB replay buffer feeding
//! SSE, a 10MB on-disk tee purely for audit) that happened to duplicate the
//! same bytes; this crate collapses them into ONE file-backed mechanism
//! that serves both jobs — write once at up to 10MB (with LogTee-style
//! rotation), read back only the last [`store::DEFAULT_TAIL_BYTES`] for a
//! replay frame.
//!
//! Two independent key namespaces share the same [`store::LogStore`] root
//! (see [`store::app_key`] and `tasks::registry`'s task-scoped keys):
//! - `"app/<encoded-source>"` — a STABLE, reused path per named source
//!   (`"setup"`, `"dev"`, `"start"` stay verbatim; unsafe names use a
//!   reversible encoding), mirroring the old daemon's
//!   `appLogPath(logsDir, name)` layout. Fed by the setup pipeline
//!   (`setup/{clone,install,dev}.rs`); read by `routes/events.rs`'s
//!   connect-time `"log"` frame replay.
//! - `"tasks/<boot-namespace>/<id>.{out,err}"` — a FRESH private path per
//!   task even though daemon-compatible public ids restart at `task1` each
//!   boot, split by stream like the old in-RAM per-task ring buffers. Fed and
//!   read by `tasks::registry::TaskRegistry`; cleaned up when a task is deleted
//!   (`DELETE /_sandbox/tasks/:id`).
//!
//! One deliberate behavior change from the old (fully in-RAM) daemon: since
//! files persist across a `local-api` relaunch, a fresh SSE connect can
//! replay a transcript that a PREVIOUS process instance wrote (e.g. the
//! last clone's output, if the app was quit and reopened before a new one
//! ran). The old daemon lost all replay history on every restart (nothing
//! was ever persisted). This is intentional, not a bug: it follows directly
//! from "files are the source of truth" and the wire contract (frame
//! shape/timing) is unchanged either way.

pub mod store;

pub use store::{app_key, LogStore, DEFAULT_TAIL_BYTES};
