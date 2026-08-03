//! Graceful shutdown: window close / app exit stops the in-process
//! local-api server, which runs its own ordered pipeline (terminal and child
//! TERM→KILL sweeps, final task-registry sweep — see
//! `crates/local-api/src/lib.rs`) before letting axum drain and stop.
//! No git publish happens here: local worktrees are durable and are
//! reused as-is on the next launch, so close never blocks on the network.
//!
//! Wired from the top-level `.run(|app, event| ..)` callback in `lib.rs`
//! on [`tauri::RunEvent::ExitRequested`] — this fires for BOTH a normal
//! window close (Tauri's default "last window closed -> exit" behavior)
//! AND `AppHandle::exit()` (used by `selftest.rs`'s `report_and_exit`), so
//! there is exactly ONE shutdown code path for both.

use tauri::{AppHandle, Manager};

use crate::state::LocalApiState;

/// Idempotent: [`LocalApiState::take`] only yields the handle once, so a
/// duplicate `ExitRequested` delivery (Tauri can fire it more than once in
/// some teardown sequences) is a safe no-op on the second call rather than
/// a double `.shutdown()` on an already-consumed `ServerHandle`.
pub fn run_blocking(app: &AppHandle) {
    let Some(state) = app.try_state::<LocalApiState>() else {
        return;
    };
    let Some(handle) = state.take() else {
        return;
    };
    tracing::info!("app exit requested: shutting down local-api");
    tauri::async_runtime::block_on(handle.shutdown());
    // Apply a staged self-update ONLY here, after local-api has drained:
    // swapping the bundle under a live process breaks macOS Keychain access
    // (code identity is validated against the binary on disk), so the swap
    // must happen when no Keychain writer is left. Covers both the restart
    // button and a plain quit — this is what makes install-on-quit true.
    // Inside the take-once guard above, so a duplicate ExitRequested cannot
    // double-apply.
    crate::updater::apply_pending_update();
}
