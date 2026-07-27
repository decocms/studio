//! The four Tauri IPC commands the SHARED IPC/BOOT CONTRACT specifies,
//! plus `auth_complete_session` (the hybrid-login bridge, post-v1 owner
//! feedback — see `crates/upstream/src/bridge.rs`'s module doc) and
//! `selftest_report` (self-test-mode-only, see `selftest.rs`).
//!
//! Wire shapes are pinned by the contract:
//! - `local_api_info() -> {port, previewPort, upstreamUrl, token}` —
//!   `token` is a one-time bootstrap capability exchanged for the HttpOnly
//!   local session cookie before React mounts. Application requests are
//!   same-origin and never attach it.
//! - `auth_status() -> {signedIn, userLabel, upstreamUrl}`
//! - `auth_login() -> {signedIn, userLabel}`
//! - `auth_logout() -> {signedIn: false}`
//! - `auth_complete_session() -> {signedIn: true, userLabel}` on success,
//!   `Err(String)` if the login screen hasn't captured a session cookie
//!   yet (call the `/api/auth/*` sign-in endpoints first) or the
//!   MCP OAuth bridge itself failed.
//!
//! The frontend obtains the bootstrap capability only through
//! `local_api_info`, never through a URL or injected page global.
//!
//! `auth_status`/`auth_login`/`auth_logout`/`auth_complete_session`
//! delegate to `upstream::session::global()` (`crates/upstream`, built in
//! parallel — see `auth.rs`'s module doc for why that singleton, not
//! Tauri-managed state, is the seam here). After a successful sign-in
//! (either path), the app hands off to the real production shell
//! (`apps/web/src`) — its own `organization.list`/last-visited-org
//! logic and org-creation flow handle everything about org selection; this
//! crate holds no org-choice state of its own (see `crates/upstream/src/
//! session.rs`'s module doc).

use serde::Serialize;
use tauri::State;

use crate::auth::{AuthResultWire, AuthStatusWire};
use crate::state::LocalApiState;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalApiInfo {
    pub port: u16,
    /// The dedicated loopback port serving ONLY the dev-server reverse
    /// proxy (`local_api::ServerHandle::preview_port`) — the frontend
    /// points the sandbox preview iframe at
    /// `http://localhost:<previewPort>/`, never at `port` (see
    /// `apps/web/src/components/sandbox/hooks/sandbox-lifecycle-context.tsx`'s
    /// `resolvePreviewUrl`).
    pub preview_port: u16,
    pub upstream_url: String,
    pub token: String,
}

#[tauri::command]
pub fn local_api_info(state: State<'_, LocalApiState>) -> Result<LocalApiInfo, String> {
    let (port, preview_port, token) = state
        .port_and_token()
        .ok_or_else(|| "local-api is not running (already shut down)".to_string())?;
    Ok(LocalApiInfo {
        port,
        preview_port,
        upstream_url: upstream::global().target().to_string(),
        token: token.to_string(),
    })
}

#[tauri::command]
pub async fn auth_status() -> AuthStatusWire {
    let status = upstream::global().status().await;
    tracing::debug!(
        signed_in = status.signed_in,
        upstream = %status.upstream_url,
        "IPC: auth_status"
    );
    status.into()
}

#[tauri::command]
pub async fn auth_login() -> Result<AuthResultWire, String> {
    tracing::info!("IPC: auth_login invoked");
    let result = upstream::global().login().await;
    match &result {
        Ok(_) => tracing::info!("IPC: auth_login succeeded"),
        Err(e) => tracing::error!(error = %e, "IPC: auth_login failed"),
    }
    result.map(AuthResultWire::from).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn auth_logout() -> AuthResultWire {
    upstream::global().logout().await.into()
}

/// The hybrid-login bridge (post-v1 owner feedback — see
/// `crates/upstream/src/bridge.rs`'s module doc). Called by the frontend
/// AFTER the shared login-screen component has driven a successful
/// email/password or email-OTP sign-in through the bare `/api/auth/*`
/// proxy (`crates/local-api/src/routes/upstream.rs::proxy_auth_path`),
/// which captures the resulting Better Auth session cookie into this same
/// `upstream::global()` singleton's in-memory jar. This command then
/// completes the MCP OAuth 2.1 + PKCE dance on that cookie's behalf — no
/// browser hop, unlike `auth_login` — and lands the result in the same
/// Keychain path. Returns `Err` (never partially-signed-in) if no session
/// cookie was captured yet, or if the bridge itself failed; either way the
/// jar is purged as a side effect (see
/// `UpstreamSession::complete_session`'s doc comment), so the frontend
/// must re-drive the sign-in proxy call before retrying.
#[tauri::command]
pub async fn auth_complete_session() -> Result<AuthResultWire, String> {
    tracing::info!("IPC: auth_complete_session invoked");
    let result = upstream::global().complete_session().await;
    match &result {
        Ok(_) => tracing::info!("IPC: auth_complete_session succeeded"),
        Err(e) => tracing::error!(error = %e, "IPC: auth_complete_session failed"),
    }
    result.map(AuthResultWire::from).map_err(|e| e.to_string())
}

/// Self-test-mode-only (see `selftest.rs`). A real frontend build never
/// calls this — the self-test JS bundle is the only caller, and it's only
/// ever `eval()`'d when `DESKTOP_SELFTEST=1`. Harmless if invoked outside
/// that mode: `selftest::report_and_exit` fails closed on a missing
/// `DESKTOP_SELFTEST_OUT`.
#[tauri::command]
pub fn selftest_report(app: tauri::AppHandle, report: serde_json::Value) -> Result<(), String> {
    crate::selftest::report_and_exit(&app, report)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_api_info_uses_the_frontend_wire_names() {
        let value = serde_json::to_value(LocalApiInfo {
            port: 43_120,
            preview_port: 61_234,
            upstream_url: "https://studio.decocms.com".into(),
            token: "bootstrap".into(),
        })
        .unwrap();
        assert_eq!(value["port"], 43_120);
        assert_eq!(value["previewPort"], 61_234);
        assert_eq!(value["upstreamUrl"], "https://studio.decocms.com");
        assert_eq!(value["token"], "bootstrap");
    }
}
