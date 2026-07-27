pub mod broadcaster;
pub mod snapshot;

// `Broadcaster` is consumed via `AppState::broadcaster` (see `state.rs`).
// `Event` itself (the `subscribe()` receiver's item type) is read structurally
// (`ev.name`/`ev.data`) by `routes/events.rs` without ever naming the type,
// so it stays unexported here rather than re-exported-but-unused.
pub use broadcaster::Broadcaster;
