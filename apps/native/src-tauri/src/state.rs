//! Managed Tauri state: the running local-api server handle. Registered
//! via `app.manage(..)` in `setup.rs` and read by `commands.rs`.
//!
//! There is no `AuthState` here — `auth_status`/`auth_login`/
//! `auth_logout` call `upstream::global()` directly (see `auth.rs`'s
//! module doc); that crate's own process-wide singleton IS its Tauri
//! integration seam, so no local wrapper is needed.

use std::sync::{Arc, Mutex};

/// Wraps the local-api [`local_api::ServerHandle`] so it can be `app.manage()`d.
/// `Option` because [`LocalApiState::take`] removes it exactly once, on
/// shutdown (see `shutdown.rs`) — a second shutdown attempt (e.g. a
/// double `ExitRequested` delivery) becomes a no-op instead of a double
/// `.shutdown()` call on an already-consumed `ServerHandle`.
pub struct LocalApiState(pub Mutex<Option<local_api::ServerHandle>>);

impl LocalApiState {
    pub fn new(handle: local_api::ServerHandle) -> Self {
        Self(Mutex::new(Some(handle)))
    }

    /// Read-only access for `commands::local_api_info` — returns `None` if
    /// the server has already been taken for shutdown (a command racing an
    /// in-flight app exit; harmless, the webview is going away too).
    /// `(main port, preview port, bootstrap secret)` — see
    /// `local_api::ServerHandle` for what each listener serves.
    pub fn port_and_token(&self) -> Option<(u16, u16, Arc<str>)> {
        let guard = self.0.lock().ok()?;
        let handle = guard.as_ref()?;
        Some((
            handle.port(),
            handle.preview_port(),
            handle.state().token.clone(),
        ))
    }

    /// Removes and returns the handle, exactly once. Subsequent calls
    /// return `None`.
    pub fn take(&self) -> Option<local_api::ServerHandle> {
        self.0.lock().ok().and_then(|mut guard| guard.take())
    }
}
