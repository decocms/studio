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
use crate::state::{LocalApiState, PreviewOriginState};

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
pub async fn auth_login(state: State<'_, LocalApiState>) -> Result<AuthResultWire, String> {
    tracing::info!("IPC: auth_login invoked");
    let app_state = state
        .app_state()
        .ok_or_else(|| "local-api is not running (already shut down)".to_string())?;
    let session = upstream::global();
    let result = match session.prepare_login().await {
        Ok(prepared) => local_api::install_upstream_session(&app_state, prepared)
            .await
            .map_err(|error| error.to_string()),
        Err(error) => Err(error.to_string()),
    };
    match &result {
        Ok(_) => tracing::info!("IPC: auth_login succeeded"),
        Err(e) => tracing::error!(error = %e, "IPC: auth_login failed"),
    }
    result.map(AuthResultWire::from).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn auth_logout(state: State<'_, LocalApiState>) -> Result<AuthResultWire, String> {
    let status = match state.app_state() {
        Some(app_state) => local_api::logout_upstream_session(&app_state).await,
        None => upstream::global().logout().await,
    };
    Ok(status.into())
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
pub async fn auth_complete_session(
    state: State<'_, LocalApiState>,
) -> Result<AuthResultWire, String> {
    tracing::info!("IPC: auth_complete_session invoked");
    let app_state = state
        .app_state()
        .ok_or_else(|| "local-api is not running (already shut down)".to_string())?;
    let session = upstream::global();
    let result = match session.prepare_complete_session().await {
        Ok(prepared) => local_api::install_upstream_session(&app_state, prepared)
            .await
            .map_err(|error| error.to_string()),
        Err(error) => Err(error.to_string()),
    };
    match &result {
        Ok(_) => tracing::info!("IPC: auth_complete_session succeeded"),
        Err(e) => tracing::error!(error = %e, "IPC: auth_complete_session failed"),
    }
    result.map(AuthResultWire::from).map_err(|e| e.to_string())
}

/// Registers `origin` as a currently-legitimate preview iframe target — see
/// `state::PreviewOriginState`'s doc comment for why this exists. Called by
/// the frontend (`apps/web/src/lib/desktop/tauri-bridge.ts`'s
/// `registerPreviewOrigin`) immediately before setting a preview iframe's
/// `src` to an external (non-sandbox-proxy) origin, and MUST be awaited
/// first: `setup::is_allowed_webview_navigation` denies anything not already
/// registered, and a denied iframe navigation fires neither `load` nor
/// `error` (WKWebView cancels it outright), so a caller that raced ahead of
/// registration would see a permanently blank frame with no recovery signal.
///
/// Parses and re-serializes rather than trusting the raw string: normalizes
/// to exactly what `url.origin().ascii_serialization()` produces at the
/// `on_navigation` check site, and rejects non-http(s) input.
#[tauri::command]
pub fn register_preview_origin(
    origin: String,
    state: State<'_, PreviewOriginState>,
) -> Result<(), String> {
    state.register(normalize_preview_origin(&origin)?);
    Ok(())
}

/// Parses and re-serializes rather than trusting the raw string: normalizes
/// to exactly what `url.origin().ascii_serialization()` produces at the
/// `setup::is_allowed_webview_navigation` check site, and rejects non-http(s)
/// input. Pure logic, split out from the command itself so it's unit-testable
/// — `tauri::State` has no public constructor for a plain unit test to use.
fn normalize_preview_origin(origin: &str) -> Result<String, String> {
    let parsed: tauri::Url = origin
        .parse()
        .map_err(|error| format!("invalid origin {origin:?}: {error}"))?;
    if parsed.scheme() != "https" && parsed.scheme() != "http" {
        return Err(format!(
            "only http(s) origins may be registered, got scheme {:?}",
            parsed.scheme()
        ));
    }
    Ok(parsed.origin().ascii_serialization())
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

    #[test]
    fn normalize_preview_origin_strips_path_and_query() {
        assert_eq!(
            normalize_preview_origin("https://fila.vtex.app/?__draft=abc&deviceHint=desktop")
                .unwrap(),
            "https://fila.vtex.app"
        );
    }

    #[test]
    fn normalize_preview_origin_rejects_non_http_schemes() {
        for bad in ["file:///etc/passwd", "javascript:alert(1)", "not a url"] {
            assert!(
                normalize_preview_origin(bad).is_err(),
                "{bad} must be rejected"
            );
        }
    }
}
