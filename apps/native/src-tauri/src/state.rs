//! Managed Tauri state: the running local-api server handle, and the
//! dynamic preview-origin allowlist. Registered via `app.manage(..)` in
//! `setup.rs` and read by `commands.rs`.
//!
//! There is no `AuthState` here — `auth_status`/`auth_login`/
//! `auth_logout` call `upstream::global()` directly (see `auth.rs`'s
//! module doc); that crate's own process-wide singleton IS its Tauri
//! integration seam, so no local wrapper is needed.

use std::collections::HashSet;
use std::sync::{Arc, Mutex, PoisonError};

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

    /// Clone the local API state for lifecycle-coordinating IPC commands such
    /// as logout. The server handle remains owned here.
    pub fn app_state(&self) -> Option<local_api::AppState> {
        self.0
            .lock()
            .ok()?
            .as_ref()
            .map(|handle| handle.state().clone())
    }

    /// Removes and returns the handle, exactly once. Subsequent calls
    /// return `None`.
    pub fn take(&self) -> Option<local_api::ServerHandle> {
        self.0.lock().ok().and_then(|mut guard| guard.take())
    }
}

/// Origins the FRONTEND has told us it's about to legitimately embed as a
/// preview iframe (e.g. a customer's live storefront domain), checked by
/// `setup::is_allowed_webview_navigation` alongside its fixed allowlist.
///
/// Exists because Tauri's `on_navigation` hook fires for iframe navigations
/// exactly the same as top-level ones (no way to tell them apart from the
/// URL alone — see `setup.rs`'s doc comment on that closure), and the set of
/// legitimate external preview domains is unbounded (any org's own site),
/// so a static allowlist can't cover it. The frontend already knows exactly
/// which origin it's about to preview — see
/// `apps/web/src/lib/desktop/tauri-bridge.ts`'s `registerPreviewOrigin`.
///
/// Session-scoped only: never persisted, cleared on app restart. No
/// eviction — cardinality is bounded by the distinct preview domains a user
/// visits in one session, which stays small.
#[derive(Default, Clone)]
pub struct PreviewOriginState(Arc<Mutex<HashSet<String>>>);

impl PreviewOriginState {
    pub fn register(&self, origin: String) {
        self.0
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(origin);
    }

    pub fn contains(&self, origin: &str) -> bool {
        self.0
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .contains(origin)
    }
}
