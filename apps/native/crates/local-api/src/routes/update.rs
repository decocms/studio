//! `POST /_local/update/restart` — apply a staged self-update by restarting
//! the app through the shell's graceful-shutdown pipeline.
//!
//! The webview's version card calls this (desktop builds only) instead of
//! `window.location.reload()`: a reload re-serves the bundle embedded in the
//! RUNNING binary, so it can never pick up the new `.app` the updater staged
//! on disk — only a process restart can. The restart callback is Tauri's
//! `request_restart`, which delivers `RunEvent::ExitRequested`, so the single
//! shutdown path (child sweeps, drain, instance-lock release) always runs
//! before the respawn.
//!
//! 409s are the contract, not errors: the card only renders when
//! `/api/config` reports a staged version, but the state can move between
//! that poll and this click (update superseded and re-downloading, or no
//! hooks at all in the standalone binary). The webview treats any non-2xx by
//! re-enabling the button and letting the next poll re-converge.
//!
//! Mounted under `/_local` (the reserved local-only namespace, like
//! `/_auth`): a bare path would be SPA-fallback/upstream-proxy surface, and
//! the Vite native dev proxy already forwards `/_local`.

use std::sync::atomic::Ordering;
use std::time::Duration;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;

use crate::error::ApiError;
use crate::state::AppState;

/// Delay between flushing the `202 Accepted` and triggering the restart —
/// best-effort only (shutdown drops connections immediately); losing the
/// race costs a cosmetic network error on a page that is going away.
const RESTART_RESPONSE_FLUSH: Duration = Duration::from_millis(100);

pub async fn restart(State(state): State<AppState>) -> Response {
    let Some(hooks) = state.update.as_ref() else {
        return ApiError::conflict("self-update is not available in this process").into_response();
    };
    if hooks.installing.load(Ordering::SeqCst) {
        return ApiError::conflict("an update install is in progress; retry shortly")
            .into_response();
    }
    let Some(version) = hooks.staged_version.borrow().clone() else {
        return ApiError::conflict("no update is staged").into_response();
    };

    tracing::info!(%version, "restarting to apply staged update");
    let request_restart = hooks.request_restart.clone();
    tokio::spawn(async move {
        tokio::time::sleep(RESTART_RESPONSE_FLUSH).await;
        request_restart();
    });
    (StatusCode::ACCEPTED, Json(json!({ "restarting": version }))).into_response()
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    use axum::extract::State;
    use axum::http::StatusCode;

    use super::restart;
    use crate::state::{AppState, UpdateHooks};

    /// The three 409 branches are distinct states, not one: no hooks at all
    /// (standalone binary), hooks but nothing staged, and hooks mid-install.
    fn state_with(update: Option<UpdateHooks>) -> (AppState, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let mut state = crate::routes::intercept::test_state(dir.path());
        state.update = update;
        (state, dir)
    }

    fn hooks(
        staged: Option<&str>,
        installing: bool,
    ) -> (
        UpdateHooks,
        tokio::sync::watch::Sender<Option<String>>,
        Arc<AtomicBool>,
    ) {
        let (tx, rx) = tokio::sync::watch::channel(staged.map(str::to_string));
        let restarted = Arc::new(AtomicBool::new(false));
        let restarted_flag = restarted.clone();
        let hooks = UpdateHooks {
            staged_version: rx,
            installing: Arc::new(AtomicBool::new(installing)),
            request_restart: Arc::new(move || {
                restarted_flag.store(true, Ordering::SeqCst);
            }),
        };
        (hooks, tx, restarted)
    }

    #[tokio::test]
    async fn conflicts_when_no_update_integration_exists() {
        let (state, _dir) = state_with(None);
        let res = restart(State(state)).await;
        assert_eq!(res.status(), StatusCode::CONFLICT);
    }

    #[tokio::test]
    async fn conflicts_when_nothing_is_staged() {
        let (h, _tx, restarted) = hooks(None, false);
        let (state, _dir) = state_with(Some(h));
        let res = restart(State(state)).await;
        assert_eq!(res.status(), StatusCode::CONFLICT);
        assert!(!restarted.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn conflicts_while_an_install_is_in_flight() {
        // Restarting mid-swap could re-exec a half-replaced bundle — the
        // updater task sets `installing` before download and clears it after
        // install; a staged version from the PREVIOUS cycle must not bypass
        // that fence.
        let (h, _tx, restarted) = hooks(Some("5.0.0"), true);
        let (state, _dir) = state_with(Some(h));
        let res = restart(State(state)).await;
        assert_eq!(res.status(), StatusCode::CONFLICT);
        assert!(!restarted.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn accepted_then_invokes_the_restart_callback() {
        let (h, _tx, restarted) = hooks(Some("5.0.0"), false);
        let (state, _dir) = state_with(Some(h));
        let res = restart(State(state)).await;
        assert_eq!(res.status(), StatusCode::ACCEPTED);
        // The callback fires after the response-flush delay, on a spawned
        // task — poll rather than sleep a fixed wall-clock amount.
        for _ in 0..100 {
            if restarted.load(Ordering::SeqCst) {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        panic!("request_restart was never invoked after the 202");
    }
}
