//! `Broadcaster` — the SSE fan-out hub, byte-parity in spirit with
//! `packages/sandbox/daemon-go/internal/events/broadcast.go`.
//!
//! Ownership split (see the native module-ownership contract): EVERY
//! family may call `emit()` to publish a named event (bash background ->
//! `"tasks"`, git branch changes -> `"branch"`, config transitions ->
//! `"lifecycle"`, file writes -> `"file-changed"`/`"reload"`, scripts
//! discovery -> `"scripts"`). Only the `events` family
//! (`routes/events.rs`) calls `subscribe()` — it owns turning the broadcast
//! stream into the actual `/_sandbox/events` SSE response (framing via
//! `event: <name>\ndata: <json>\n\n`, replay-on-connect, the 15s heartbeat).
//! No other module should hold a `Receiver`.
//!
//! Nothing calls `emit()`/`subscribe()` yet (no route handler is
//! implemented past a 501 stub) — hence the crate-unusual `dead_code`
//! allow below. Remove it naturally the moment the first family wires a
//! call site; don't carry it forward once that happens.
#![allow(dead_code)]

use serde_json::Value;
use tokio::sync::broadcast;

/// Generous enough that a burst of task/log events between two SSE
/// `poll()`s on a slow consumer doesn't lag-drop before the events route
/// has a chance to read them. The `events` family should treat a
/// `RecvError::Lagged` from its receiver as "resync via a fresh replay",
/// not a fatal stream error — see `tokio::sync::broadcast`'s docs.
const DEFAULT_CAPACITY: usize = 1024;

#[derive(Debug, Clone)]
pub struct Event {
    pub name: String,
    pub data: Value,
}

pub struct Broadcaster {
    tx: broadcast::Sender<Event>,
}

impl Broadcaster {
    pub fn new() -> Self {
        let (tx, _rx) = broadcast::channel(DEFAULT_CAPACITY);
        Self { tx }
    }

    /// Subscribe to the live event stream from this point forward. Reserved
    /// for the `events` family's SSE handler — see the module doc comment.
    pub fn subscribe(&self) -> broadcast::Receiver<Event> {
        self.tx.subscribe()
    }

    /// Fan `data` out to every currently-connected `/_sandbox/events`
    /// client under event name `name`. A no-op when nobody is subscribed
    /// (mirrors the daemon's `Broadcaster.emit`, which silently drops
    /// events with no listeners rather than buffering them) — callers
    /// never need to check "is anyone listening" first.
    pub fn emit(&self, name: &str, data: Value) {
        let _ = self.tx.send(Event {
            name: name.to_string(),
            data,
        });
    }

    /// Current subscriber count — useful for tests/health introspection.
    pub fn subscriber_count(&self) -> usize {
        self.tx.receiver_count()
    }
}

impl Default for Broadcaster {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn emit_reaches_a_live_subscriber() {
        let b = Broadcaster::new();
        let mut rx = b.subscribe();
        b.emit("status", serde_json::json!({"state": "running"}));
        let evt = rx.recv().await.expect("event delivered");
        assert_eq!(evt.name, "status");
        assert_eq!(evt.data["state"], "running");
    }

    #[test]
    fn emit_with_no_subscribers_does_not_panic() {
        let b = Broadcaster::new();
        b.emit("status", serde_json::json!({}));
    }
}
