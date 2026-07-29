//! Origin validation + CORS header shaping.
//!
//! the native local-API contract calls
//! this surface "the crown jewels" (chat + org data + process spawn) and is
//! explicit that local-api MUST NOT reproduce the daemon's unconditional
//! `Access-Control-Allow-Origin: *` (`daemon/routes/body-parser.ts`'s
//! `jsonResponse()`) or its `CORS_HEADERS` blanket preflight constant
//! (`entry.ts`). The rule implemented here is the contract's, not the
//! daemon's:
//!   - No `Origin` header at all → allowed (same-machine CLI/test harness;
//!     `apps/native/e2e` and the daemon-parity oracle both drive requests
//!     this way, via Node's `fetch`, which never sets `Origin`).
//!   - `Origin` present and on the allowlist → allowed, ECHO that exact
//!     origin back (never `*`).
//!   - `Origin` present and NOT on the allowlist → `403 forbidden_origin`,
//!     checked before auth.
//!
//! `ApiMode::DaemonCompat` (opt-in via `LOCAL_API_MODE=daemon-compat`, see
//! `state.rs`) exists ONLY to widen the origin allowlist check for the
//! parity-oracle CI job (so a wider slice of `daemon.e2e.test.ts`'s CORS
//! assertions can be pointed at this binary for measurement) — it never
//! widens auth, and it still never emits a wildcard
//! `Access-Control-Allow-Origin`. `ApiMode::Strict` (the default, and the
//! only mode the shipped Tauri app ever runs in) is what's described above.
//! See the native module-ownership contract for why the two suites, not
//! this comment, are the actual arbiters of this behavior.

use axum::http::{HeaderMap, HeaderValue};

use crate::state::ApiMode;

/// Fixed allowlist for the app's own Tauri origin(s). Sandbox previews use
/// `http://localhost:<preview-port>` on a separate unauthenticated listener;
/// that origin is intentionally never accepted by the main API listener.
pub fn allowed_origins() -> &'static [&'static str] {
    &["tauri://localhost", "https://tauri.localhost"]
}

/// In DEBUG builds only, `tauri dev` (`bun run dev:native`) serves the frontend
/// from its built-in dev server (`http://127.0.0.1:<port>`, e.g. 1430) instead
/// of the packaged app's `tauri://localhost`, so the webview's `Origin` is a
/// loopback http URL that isn't on [`allowed_origins`]. Allow those in dev so
/// the dev loop works end-to-end; the release build
/// (`cfg(not(debug_assertions))`) keeps the strict `tauri://` allowlist, so a
/// distributed app never accepts an arbitrary loopback origin.
fn is_dev_loopback_origin(origin: &str) -> bool {
    origin.starts_with("http://127.0.0.1:") || origin.starts_with("http://localhost:")
}

pub struct OriginDecision {
    pub allowed: bool,
    /// The exact origin to echo in `Access-Control-Allow-Origin`, if any.
    /// `None` when there was no `Origin` header to begin with (same-origin
    /// / non-browser caller — no CORS header is needed at all).
    pub echo_origin: Option<String>,
}

pub fn validate(headers: &HeaderMap, mode: ApiMode) -> OriginDecision {
    let origin = headers
        .get(axum::http::header::ORIGIN)
        .and_then(|v| v.to_str().ok());
    match origin {
        None => OriginDecision {
            allowed: true,
            echo_origin: None,
        },
        Some(o) => {
            let on_allowlist = allowed_origins().contains(&o);
            // `daemon-compat` widens the ALLOWLIST CHECK ONLY (for the
            // parity-oracle job's convenience) — it never affects whether a
            // wildcard is emitted; see the module doc comment.
            let allowed = on_allowlist
                || mode == ApiMode::DaemonCompat
                || (cfg!(debug_assertions) && is_dev_loopback_origin(o));
            OriginDecision {
                allowed,
                echo_origin: if allowed { Some(o.to_string()) } else { None },
            }
        }
    }
}

/// Apply the resolved decision's headers to an outgoing response. Never
/// inserts a wildcard. No-ops when `echo_origin` is `None` (nothing to
/// add). Callers should still explicitly NOT call this at all for the
/// reverse-proxy family's responses (byte-parity: the daemon doesn't gate
/// or CORS-decorate proxied responses either — that traffic is the app
/// under test being previewed, not the control API).
pub fn apply_headers(headers: &mut HeaderMap, decision: &OriginDecision) {
    if let Some(origin) = &decision.echo_origin {
        if let Ok(v) = HeaderValue::from_str(origin) {
            headers.insert(axum::http::header::ACCESS_CONTROL_ALLOW_ORIGIN, v);
            headers.insert(axum::http::header::VARY, HeaderValue::from_static("Origin"));
            // Cross-origin JS cannot READ response headers unless exposed.
            // The webview -> local-api hop is always cross-origin (unlike
            // prod web, where these calls are same-origin and never hit
            // this rule): the MCP streamable-HTTP client must read
            // `Mcp-Session-Id`, and OAuth discovery reads
            // `WWW-Authenticate` (mesh exposes the latter itself —
            // apps/api/src/api/app.ts's exposeHeaders).
            headers.insert(
                axum::http::header::ACCESS_CONTROL_EXPOSE_HEADERS,
                HeaderValue::from_static("Mcp-Session-Id, WWW-Authenticate"),
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::{HeaderMap, HeaderValue};

    #[test]
    fn no_origin_header_is_allowed_with_no_echo() {
        let decision = validate(&HeaderMap::new(), ApiMode::Strict);
        assert!(decision.allowed);
        assert!(decision.echo_origin.is_none());
    }

    #[test]
    fn allowlisted_origin_is_echoed_verbatim() {
        let mut headers = HeaderMap::new();
        headers.insert(
            axum::http::header::ORIGIN,
            HeaderValue::from_static("tauri://localhost"),
        );
        let decision = validate(&headers, ApiMode::Strict);
        assert!(decision.allowed);
        assert_eq!(decision.echo_origin.as_deref(), Some("tauri://localhost"));
    }

    #[test]
    fn unknown_origin_is_rejected_in_strict_mode() {
        let mut headers = HeaderMap::new();
        headers.insert(
            axum::http::header::ORIGIN,
            HeaderValue::from_static("https://evil.example"),
        );
        let decision = validate(&headers, ApiMode::Strict);
        assert!(!decision.allowed);
        assert!(decision.echo_origin.is_none());
    }

    #[test]
    fn dev_loopback_origin_allowed_only_in_debug_builds() {
        // `tauri dev` (`bun run dev:native`) serves the frontend from
        // `http://127.0.0.1:<port>` (e.g. 1430), unlike the packaged app's
        // `tauri://localhost` — so it must be accepted in DEBUG builds (where
        // this test runs) but rejected in a release build (strict `tauri://`).
        let mut headers = HeaderMap::new();
        headers.insert(
            axum::http::header::ORIGIN,
            HeaderValue::from_static("http://127.0.0.1:1430"),
        );
        assert_eq!(
            validate(&headers, ApiMode::Strict).allowed,
            cfg!(debug_assertions),
        );
    }

    #[test]
    fn apply_headers_never_emits_a_wildcard() {
        let mut headers = HeaderMap::new();
        let decision = OriginDecision {
            allowed: true,
            echo_origin: Some("tauri://localhost".to_string()),
        };
        apply_headers(&mut headers, &decision);
        assert_eq!(
            headers.get(axum::http::header::ACCESS_CONTROL_ALLOW_ORIGIN),
            Some(&HeaderValue::from_static("tauri://localhost"))
        );
    }
}
