//! In-memory, per-upstream-host cookie jar for the hybrid-login bridge
//! (owner brief: "the in-app login screen = the SAME components as the web
//! `/login` route ... upstream Set-Cookie from `/api/auth/*` responses is
//! captured into an IN-MEMORY Rust cookie jar (never forwarded to the
//! webview, never persisted)").
//!
//! ## Why this exists
//!
//! The desktop app's embedded login screen submits email/password and
//! email-OTP straight to Better Auth's cookie-based session endpoints
//! (`/api/auth/sign-in/email`, `/api/auth/email-otp/verify-otp`, ...) via
//! `crates/local-api/src/routes/upstream.rs`'s app-API proxy. A
//! browser tab would just let its own cookie jar hold the resulting
//! `better-auth.session_token` and send it back automatically on the next
//! request to the same origin. This process has no browser cookie jar —
//! the embedded webview only ever holds `LOCAL_API_TOKEN` (this crate's own
//! bearer, per the local-api contract's auth model) and must NEVER be
//! handed the upstream session cookie, since that cookie alone is enough
//! to drive Better Auth's full account surface (password change, org
//! management, ...), not just the narrow MCP-OAuth scope this app needs.
//!
//! So this jar plays the browser's role, entirely inside this process:
//! `routes/upstream.rs` captures `Set-Cookie` from upstream `/api/auth/*`
//! responses here (and strips them before they ever reach the webview),
//! then attaches the captured cookie on the NEXT `/api/auth/*` request —
//! most importantly, the one [`crate::bridge::complete_via_cookie_jar`]
//! issues to `GET /api/auth/mcp/authorize`, which needs to see an
//! authenticated Better Auth session to auto-redirect with an OAuth
//! `code`. The jar is purged the moment that bridge attempt concludes
//! (success OR failure — see that module's doc comment) and on
//! `UpstreamSession::logout()`/`hard_sign_out()`. It is never written to
//! disk, never serialized, and does not survive a process restart — by
//! design, matching the Keychain-only persistence the OAuth tokens
//! themselves get (see `tokens.rs`'s module doc).
//!
//! ## Cookie-attribute handling
//!
//! [`CookieJar::capture`] intentionally keeps ONLY `name=value` from each
//! `Set-Cookie` header and discards every attribute (`Path`, `Domain`,
//! `Max-Age`, `Expires`, `Secure`, `HttpOnly`, `SameSite`, ...). This jar
//! never crosses a real network boundary or a same-site/cross-site
//! decision point — the only place a captured cookie is ever replayed is a
//! same-process, same-target-host `/api/auth/*` request this crate itself
//! issues moments later — so there is no attribute-enforcement semantics to
//! reproduce. A `Domain`/`Path`-scoping browser jar would be over-
//! engineering for a jar whose entire lifetime is "this process, this
//! host, until the next bridge attempt or sign-out."

use std::collections::BTreeMap;
use std::sync::RwLock;

/// Keyed by upstream host (the same `host_key()` used everywhere else in
/// this crate — `tokens::host_key`) so a dev/staging/prod target never
/// shares cookies, mirroring the Keychain's own per-host scoping.
#[derive(Default)]
pub struct CookieJar {
    entries: RwLock<BTreeMap<String, BTreeMap<String, String>>>,
}

impl CookieJar {
    pub fn new() -> Self {
        Self::default()
    }

    /// Parses every `Set-Cookie` response header value and stores/
    /// overwrites the `name=value` pair for `host`. A cookie of the same
    /// name captured again (e.g. a refreshed session cookie on a later
    /// `/api/auth/*` call) replaces the previous value — last-write-wins,
    /// matching how a real browser jar treats a repeated `Set-Cookie` for
    /// the same name/path/domain.
    pub fn capture<'a>(&self, host: &str, set_cookie_values: impl Iterator<Item = &'a str>) {
        let mut map = self.entries.write().unwrap();
        let entry = map.entry(host.to_string()).or_default();
        for raw in set_cookie_values {
            if let Some((name, value)) = parse_set_cookie(raw) {
                entry.insert(name, value);
            }
        }
    }

    /// A `Cookie:` header value (`name1=value1; name2=value2`, sorted by
    /// name for determinism) to attach on the next request to `host`, or
    /// `None` if nothing has been captured for that host yet — callers
    /// must never send an empty `Cookie:` header.
    pub fn header_value(&self, host: &str) -> Option<String> {
        let map = self.entries.read().unwrap();
        let entry = map.get(host)?;
        if entry.is_empty() {
            return None;
        }
        Some(
            entry
                .iter()
                .map(|(k, v)| format!("{k}={v}"))
                .collect::<Vec<_>>()
                .join("; "),
        )
    }

    /// Idempotent — clearing an already-empty host is a no-op, matching
    /// this crate's other idempotent-clear conventions (`TokenStore::clear`).
    pub fn clear(&self, host: &str) {
        self.entries.write().unwrap().remove(host);
    }

    /// `true` when nothing is captured for `host` (including "never
    /// captured anything at all"). Used by tests and by
    /// [`crate::bridge::complete_via_cookie_jar`]'s precondition check.
    pub fn is_empty(&self, host: &str) -> bool {
        self.entries
            .read()
            .unwrap()
            .get(host)
            .is_none_or(|m| m.is_empty())
    }
}

/// Extracts `name` and `value` from one `Set-Cookie` header's FIRST
/// `name=value` segment (everything before the first `;`), discarding
/// every attribute that follows — see this module's doc comment for why
/// attributes are deliberately not modeled. Returns `None` for a
/// malformed header (no `=` in the first segment, or an empty name) rather
/// than panicking; a malformed `Set-Cookie` from upstream should never
/// crash the proxy, just be silently skipped.
fn parse_set_cookie(raw: &str) -> Option<(String, String)> {
    let first_segment = raw.split(';').next()?.trim();
    let (name, value) = first_segment.split_once('=')?;
    let name = name.trim();
    if name.is_empty() {
        return None;
    }
    Some((name.to_string(), value.trim().to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capture_then_header_value_round_trips_name_and_value() {
        let jar = CookieJar::new();
        assert_eq!(jar.header_value("mesh.test"), None);

        jar.capture(
            "mesh.test",
            std::iter::once(
                "better-auth.session_token=abc123; Max-Age=604800; Path=/; HttpOnly; SameSite=Lax",
            ),
        );
        assert_eq!(
            jar.header_value("mesh.test").as_deref(),
            Some("better-auth.session_token=abc123")
        );
        assert!(!jar.is_empty("mesh.test"));
    }

    #[test]
    fn capture_strips_every_cookie_attribute() {
        let jar = CookieJar::new();
        jar.capture(
            "mesh.test",
            std::iter::once(
                "session=xyz; Domain=mesh.test; Secure; Expires=Wed, 09 Jun 2027 10:18:14 GMT",
            ),
        );
        let header = jar.header_value("mesh.test").unwrap();
        assert_eq!(header, "session=xyz");
        assert!(!header.contains("Domain"));
        assert!(!header.contains("Secure"));
        assert!(!header.contains("Expires"));
    }

    #[test]
    fn capture_handles_multiple_set_cookie_headers_and_sorts_deterministically() {
        let jar = CookieJar::new();
        jar.capture(
            "mesh.test",
            vec!["zzz_cookie=1; Path=/", "aaa_cookie=2; Path=/"].into_iter(),
        );
        // Sorted by name (BTreeMap) so the resulting header is deterministic
        // — a test/assertion convenience, not a wire requirement (cookie
        // order is not semantically meaningful to Better Auth's parser).
        assert_eq!(
            jar.header_value("mesh.test").as_deref(),
            Some("aaa_cookie=2; zzz_cookie=1")
        );
    }

    #[test]
    fn a_second_capture_for_the_same_name_overwrites_the_value() {
        let jar = CookieJar::new();
        jar.capture("mesh.test", std::iter::once("session=old"));
        jar.capture("mesh.test", std::iter::once("session=new"));
        assert_eq!(
            jar.header_value("mesh.test").as_deref(),
            Some("session=new")
        );
    }

    #[test]
    fn hosts_are_isolated_from_one_another() {
        let jar = CookieJar::new();
        jar.capture("dev.test", std::iter::once("session=dev-value"));
        jar.capture("prod.test", std::iter::once("session=prod-value"));
        assert_eq!(
            jar.header_value("dev.test").as_deref(),
            Some("session=dev-value")
        );
        assert_eq!(
            jar.header_value("prod.test").as_deref(),
            Some("session=prod-value")
        );
    }

    #[test]
    fn clear_purges_only_the_named_host_and_is_idempotent() {
        let jar = CookieJar::new();
        jar.capture("dev.test", std::iter::once("session=dev-value"));
        jar.capture("prod.test", std::iter::once("session=prod-value"));

        jar.clear("dev.test");
        assert!(jar.is_empty("dev.test"));
        assert_eq!(jar.header_value("dev.test"), None);
        assert_eq!(
            jar.header_value("prod.test").as_deref(),
            Some("session=prod-value"),
            "clearing one host must never affect another"
        );

        // Idempotent: clearing an already-empty host is not an error and
        // doesn't panic.
        jar.clear("dev.test");
        assert!(jar.is_empty("dev.test"));
    }

    #[test]
    fn malformed_set_cookie_values_are_skipped_not_panicking() {
        let jar = CookieJar::new();
        jar.capture(
            "mesh.test",
            vec!["not-a-cookie-no-equals-sign", "=no-name", "good=value"].into_iter(),
        );
        assert_eq!(jar.header_value("mesh.test").as_deref(), Some("good=value"));
    }

    #[test]
    fn is_empty_is_true_for_a_host_never_captured() {
        let jar = CookieJar::new();
        assert!(jar.is_empty("never-seen.test"));
    }
}
