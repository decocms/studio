//! `/_auth/mcp-callback` — the landing point for an MCP OAuth redirect that
//! completed in the user's real browser.
//!
//! ## Why this exists
//!
//! `apps/web`'s MCP OAuth flow opens the provider's authorize URL with
//! `window.open`. In a Tauri webview that call returns `null` unconditionally
//! — WKWebView has no popup or tab concept and Tauri spawns no webview for it
//! — so the flow died with "Popup was blocked" before the user ever saw a
//! consent screen. The desktop therefore hands the authorize URL to the system
//! browser instead, which means the provider's redirect lands in Safari, in a
//! different process, with a different `localStorage`. Neither of the web
//! flow's two return channels (`postMessage` to `window.opener`, and a
//! `storage` event) can cross that boundary.
//!
//! This module is that missing channel: the browser's redirect hits THIS
//! server, which parks the authorization code and lets the webview collect it.
//! Sending users to a real browser is also the only variant that keeps working
//! as more providers are connected — Google rejects embedded webviews outright
//! (`disallowed_useragent`), so an in-app webview would have fixed GitHub and
//! then broken on the next connector.
//!
//! ## Why the two halves have different authority
//!
//! [`receive`] is reached by the SYSTEM BROWSER, which has no per-launch
//! session cookie and cannot be given one, so it is registered outside the
//! private guard. [`result`] is reached by the WEBVIEW and stays behind the
//! guard, so the authorization code is only ever readable by a caller that
//! proved it is this app. Getting that asymmetry backwards would let any local
//! process read a live authorization code off `localhost`.
//!
//! Leaving `receive` unauthenticated is safe because it is not the security
//! boundary: `state` is a `crypto.randomUUID()` the webview generated and
//! keeps in memory, and the webview refuses any callback whose state does not
//! match (`OAuth state mismatch - possible CSRF attack`). A local process that
//! wanted to inject a code would have to guess that UUID.
//!
//! ## Why this stays a dumb relay
//!
//! The stored `state` is handed back verbatim. Some providers wrap it (deco.cx
//! base64-encodes a `{clientState}` envelope), and `handleOAuthCallback`
//! already implements that unwrapping plus the CSRF comparison. Duplicating it
//! here would fork the rule across two languages and gain nothing, so Rust
//! parks bytes and the webview keeps owning the decision.

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

use axum::extract::Query;
use axum::response::{Html, IntoResponse, Response};
use axum::Json;
use serde_json::{json, Value};

/// How long a parked callback stays collectable.
///
/// The webview gives up on an OAuth flow after 120s, so anything older than
/// this is from a flow nobody is waiting for anymore.
const TTL: Duration = Duration::from_secs(300);

struct Parked {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
    at: Instant,
}

/// A single slot, not a map keyed by state.
///
/// Keying by state would force this module to unwrap the provider-specific
/// state envelope to find its own entry — the exact duplication the module
/// doc rules out. One slot is sufficient because a desktop user drives one
/// consent screen at a time, and it is safe because the webview clears it when
/// a flow starts ([`discard`]), reads it destructively, and still verifies the
/// state itself.
///
/// Deliberately holds no lock of its own: the handlers own the global, and
/// keeping the transitions here as plain synchronous methods is what lets them
/// be tested directly rather than through process-global state.
#[derive(Default)]
struct Slot(Option<Parked>);

impl Slot {
    /// Park one redirect. Returns whether it carried an authorization code.
    fn park(&mut self, params: &HashMap<String, String>) -> bool {
        let error = params
            .get("error_description")
            .or_else(|| params.get("error"))
            .cloned();
        let ok = error.is_none() && params.contains_key("code");
        self.0 = Some(Parked {
            code: params.get("code").cloned(),
            state: params.get("state").cloned(),
            error,
            at: Instant::now(),
        });
        ok
    }

    /// Take the parked callback, if one is present and still fresh.
    ///
    /// Destructive: a callback is handed out once, so a second poll for a flow
    /// that already resolved cannot replay a live authorization code.
    fn take(&mut self) -> Option<Parked> {
        self.0.take().filter(|parked| parked.at.elapsed() < TTL)
    }

    fn clear(&mut self) {
        self.0 = None;
    }
}

fn slot() -> MutexGuard<'static, Slot> {
    static SLOT: OnceLock<Mutex<Slot>> = OnceLock::new();
    SLOT.get_or_init(|| Mutex::new(Slot::default()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// `GET /_auth/mcp-callback` — where the provider redirects the SYSTEM BROWSER.
///
/// Answers with a self-contained page rather than a redirect: the browser tab
/// is a dead end by design, and the user's attention has to go back to the app
/// window.
pub async fn receive(Query(params): Query<HashMap<String, String>>) -> Response {
    // Scoped so the guard is released before building the response — the lock
    // is never held across an await.
    let ok = { slot().park(&params) };
    Html(page(ok)).into_response()
}

/// `GET /_auth/mcp-callback/result` — the WEBVIEW collecting the callback.
pub async fn result() -> Response {
    let taken = { slot().take() };
    match taken {
        Some(parked) => Json(payload(&parked)).into_response(),
        None => Json(json!({ "status": "pending" })).into_response(),
    }
}

/// `DELETE /_auth/mcp-callback/result` — the WEBVIEW starting a fresh flow.
///
/// Without this, a callback the user abandoned (consent granted, app quit
/// before collection) would still be sitting in the slot when the next flow
/// began, and the next poll would pick it up. The state check would reject it,
/// but the user would see "state mismatch — possible CSRF attack" instead of a
/// working login, so the stale entry is dropped up front.
pub async fn discard() -> Response {
    {
        slot().clear();
    }
    Json(json!({ "ok": true })).into_response()
}

fn payload(parked: &Parked) -> Value {
    json!({
        "status": "ready",
        "success": parked.error.is_none() && parked.code.is_some(),
        "code": parked.code,
        "state": parked.state,
        "error": parked.error,
    })
}

/// The dead-end page shown in the browser tab.
///
/// Uses the chrome shared with desktop sign-in (`upstream::browser_page`)
/// rather than a bespoke layout: these pages are the only Studio surface a
/// user ever sees that React does not render, so a one-off would drift away
/// from the product's look on its own.
///
/// Takes only a flag, never the query parameters: `error_description` is
/// provider-controlled text, and reflecting it would tell the user whatever
/// the provider felt like saying on a page served by the app's own origin.
/// Enforced by this signature, not by escaping, so it cannot regress.
fn page(ok: bool) -> String {
    let (heading, body) = if ok {
        (
            "Connection authorized",
            "You can close this tab and return to Studio.",
        )
    } else {
        (
            "Authorization failed",
            "Studio could not complete this connection.",
        )
    };
    upstream::browser_page::render(upstream::browser_page::Page {
        title: &format!("{heading} — deco Studio"),
        heading,
        body,
        hint: Some("Close this tab and try again from Studio."),
        destructive: !ok,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
            .collect()
    }

    #[test]
    fn parks_a_code_for_the_webview_to_collect() {
        let mut slot = Slot::default();
        assert!(slot.park(&params(&[("code", "abc"), ("state", "st-1")])));

        let value = payload(&slot.take().expect("parked"));
        assert_eq!(value["status"], "ready");
        assert_eq!(value["success"], true);
        assert_eq!(value["code"], "abc");
        // Handed back verbatim — the webview owns unwrapping and comparing it.
        assert_eq!(value["state"], "st-1");
    }

    /// A code must be collectable exactly once; a replay would hand a live
    /// authorization code to whatever polled next.
    #[test]
    fn a_parked_callback_is_handed_out_only_once() {
        let mut slot = Slot::default();
        slot.park(&params(&[("code", "abc"), ("state", "st-1")]));

        assert!(slot.take().is_some());
        assert!(slot.take().is_none());
    }

    #[test]
    fn reports_a_denial_as_a_failure_not_a_code() {
        let mut slot = Slot::default();
        assert!(!slot.park(&params(&[
            ("error", "access_denied"),
            ("error_description", "The user denied the request"),
            ("state", "st-1"),
        ])));

        let value = payload(&slot.take().expect("parked"));
        assert_eq!(value["success"], false);
        assert_eq!(value["error"], "The user denied the request");
        assert!(value["code"].is_null());
    }

    /// A redirect carrying neither a code nor an error is not a success.
    #[test]
    fn a_callback_without_a_code_is_not_successful() {
        let mut slot = Slot::default();
        assert!(!slot.park(&params(&[("state", "st-1")])));
        assert_eq!(payload(&slot.take().expect("parked"))["success"], false);
    }

    #[test]
    fn discard_drops_a_callback_the_next_flow_would_otherwise_pick_up() {
        let mut slot = Slot::default();
        slot.park(&params(&[("code", "stale"), ("state", "old")]));
        slot.clear();

        assert!(slot.take().is_none());
    }

    #[test]
    fn nothing_parked_reads_as_pending() {
        assert!(Slot::default().take().is_none());
    }

    /// Bare `error` is used when the provider sends no description.
    #[test]
    fn falls_back_to_the_bare_error_code() {
        let mut slot = Slot::default();
        slot.park(&params(&[("error", "access_denied")]));
        assert_eq!(
            payload(&slot.take().expect("parked"))["error"],
            "access_denied"
        );
    }

    /// A callback older than the TTL belongs to a flow nobody is waiting for.
    #[test]
    fn an_expired_callback_is_not_handed_out() {
        let mut slot = Slot::default();
        slot.park(&params(&[("code", "abc")]));
        slot.0.as_mut().expect("parked").at = Instant::now()
            .checked_sub(TTL + Duration::from_secs(1))
            .expect("process has been up longer than the TTL");

        assert!(slot.take().is_none());
    }

    #[test]
    fn the_success_and_failure_pages_say_different_things() {
        assert!(page(true).contains("Connection authorized"));
        assert!(page(false).contains("Authorization failed"));
        // Only the failure page is coloured as an error.
        assert!(page(false).contains("var(--destructive)"));
        assert!(!page(true).contains("var(--destructive)"));
    }

    /// The browser tab is the one Studio surface React never renders, so it
    /// has to carry the product's own chrome rather than a bespoke layout.
    #[test]
    fn both_pages_wear_the_shared_studio_chrome() {
        for html in [page(true), page(false)] {
            assert!(html.contains("--background: oklch(0.99 0.003 73)"));
            assert!(html.contains("brand-mark"));
            assert!(html.contains("prefers-color-scheme: dark"));
        }
    }
}
