//! Background periodic re-validation task — the "bounded propagation for
//! org-membership removal" the brief asks for. A user removed from their
//! org (or with a revoked/expired refresh token) on the server side must
//! eventually see the desktop app reflect that, even if they never
//! trigger an app-API request or open the account menu in the
//! meantime.
//!
//! Ties directly into [`crate::session::UpstreamSession::force_revalidate`]
//! — same logic `status()` uses on a cold cache, just run on a timer
//! instead of on-demand, and always bypassing the 5-minute status cache
//! (that cache exists to bound REQUEST-triggered network chatter; this
//! task IS the thing that keeps the cache from ever going stale for
//! longer than one tick when nothing else calls `status()`).

use std::time::Duration;

use crate::session::UpstreamSession;

/// Matches [`crate::session::STATUS_CACHE_TTL`] — keeps the cache
/// perpetually warm for any caller hitting `status()` between ticks,
/// without re-validating more often than the throttle it backs already
/// allows.
pub const DEFAULT_INTERVAL: Duration = Duration::from_secs(5 * 60);

/// Spawns the periodic loop and returns its handle. Aborting the handle stops
/// re-validation; dropping it detaches the task, which is how the Tauri shell
/// deliberately gives the loop process lifetime. Process exit provides the
/// common cleanup, matching every other long-lived task this crate/local-api
/// spawns.
pub fn spawn(session: UpstreamSession, interval: Duration) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(interval);
        // Skip catch-up bursts after a long pause (e.g. the process was
        // suspended) rather than firing several revalidations back-to-back.
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        // First tick fires immediately (tokio::time::interval's default) —
        // deliberately consumed once up front WITHOUT revalidating, so a
        // freshly-booted app doesn't immediately spend a network round
        // trip that `status()`'s own cold-cache path will pay for anyway
        // the first time anything asks.
        ticker.tick().await;
        loop {
            ticker.tick().await;
            session.force_revalidate().await;
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tokens::test_support::MemoryTokenStore;
    use std::sync::Arc;

    #[tokio::test(start_paused = true)]
    async fn spawn_keeps_ticking_without_panicking() {
        let session = UpstreamSession::new(
            "http://example.invalid".to_string(),
            Arc::new(MemoryTokenStore::new()),
        );
        let handle = spawn(session, Duration::from_millis(10));

        // Advance well past several tick intervals — a signed-out session
        // with no stored credentials is the cheapest possible
        // `force_revalidate()` path (no network call at all), so this
        // mainly asserts the loop survives repeated ticks without
        // panicking or exiting early.
        tokio::time::advance(Duration::from_secs(1)).await;
        assert!(!handle.is_finished());
        handle.abort();
    }
}
