pub mod registry;

// Re-exported for family handlers to `use crate::tasks::{TaskEntry, ..}`.
// `routes/bash.rs`/`routes/tasks.rs` (bash+tasks family) use all of these;
// `routes/scripts.rs` (a different family, not yet implemented) is expected
// to reuse `TaskEntry`/`KillHandle`/`TaskRegistry` too, per
// the native module-ownership contract.
pub use registry::{
    KillAllResult, KillHandle, KillSignal, OutputStream, ProcessController, StreamEvent, TaskEntry,
    TaskRegistry, TaskStatus, TaskSummary,
};
// `RingBuffer`/`now_ms` are crate-internal helpers (not part of the
// documented cross-family contract above) that `routes/bash.rs` reuses for
// its own await-mode output capture, to avoid re-implementing the same
// cap/truncate logic twice.
pub(crate) use registry::{now_ms, GenerationAdmission, RingBuffer};
