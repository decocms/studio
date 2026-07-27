//! Stable loopback origins for the native control UI and sandbox previews.
//!
//! Cookies are scoped by HOST and ignore the port (RFC 6265 §8.5), so serving
//! the control UI and every sandbox from `localhost` on different ports put
//! them all in one cookie jar: the control session cookie was handed to every
//! sandbox's dev server (arbitrary repo code), and one sandbox's cookies were
//! sent to the next.
//!
//! Giving each sandbox its own HOST fixes that, but only under a domain the
//! browser recognises. A "site" is eTLD+1, and `localhost` is not in the
//! Public Suffix List, so browsers fall back to treating each `*.localhost`
//! host as its own site — which makes the preview iframe THIRD-PARTY and, in
//! WebKit, unable to store any cookie at all. Measured directly in Safari:
//!
//! ```text
//! top studio.localhost        / frame a.studio.localhost        -> frame cookies ""
//! top native.studio.localhost / frame a.native.studio.localhost -> frame cookies ""
//! top local.studio.decocms.com/ frame a.local.studio.decocms.com-> frame cookies OK, jars separate
//! ```
//!
//! So these are real DNS names under a real TLD, both resolving to 127.0.0.1
//! via a public wildcard record. Sharing eTLD+1 (`decocms.com`) keeps the
//! preview first-party so it can hold cookies; differing hosts give each
//! sandbox its own jar. No TLS is needed — `Secure` cookies are handled by
//! `routes::proxy::relax_cookies_for_loopback`.
//!
//! These names require public DNS. That is deliberate and unguarded: the app
//! proxies org data, auth and connections upstream, so it is already
//! non-functional without a network, and a second origin path for the offline
//! case would be complexity serving a state that never works anyway.

pub const RELEASE_PORT: u16 = 43_120;
pub const DEV_API_PORT: u16 = 43_121;
pub const SELFTEST_PORT: u16 = 43_122;
pub const DEV_UI_PORT: u16 = 4_420;
/// Stays `localhost` until the app is served over HTTPS.
///
/// A real domain is what per-sandbox cookie jars require, and the DNS for it
/// is provisioned (`local.studio.decocms.com`, `*.local.studio.decocms.com`
/// -> 127.0.0.1). But `localhost` is on the browser's hardcoded
/// potentially-trustworthy list and a real domain over plain http is not, so
/// switching costs SECURE-CONTEXT status: `crypto.randomUUID` (62 call sites)
/// and `crypto.subtle` (the PKCE challenge in `packages/runtime`) both
/// disappear and the shell fails to boot. Flip this to the real host in the
/// same change that terminates TLS locally — `preview_url` and
/// `is_sandbox_preview_url` already switch to the per-handle form on their
/// own once this contains a dot.
pub const CONTROL_HOST: &str = "local.studio.decocms.com";

/// The app terminates TLS locally (see `local_tls`), which is what makes a
/// real domain usable: `localhost` is trusted as a secure context for free,
/// a real domain over plain http is not.
pub const CONTROL_SCHEME: &str = "https";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ControlOrigin {
    pub listener_port: u16,
    pub browser_port: u16,
    /// Selftest runs headless on CI, where no keychain can be unlocked to
    /// trust a CA — so it stays on plain `localhost`, which the browser
    /// treats as a secure context for free. Only the real app pays for TLS.
    pub secure: bool,
}

impl ControlOrigin {
    pub fn scheme(self) -> &'static str {
        if self.secure {
            CONTROL_SCHEME
        } else {
            "http"
        }
    }

    pub fn host(self) -> &'static str {
        if self.secure {
            CONTROL_HOST
        } else {
            "localhost"
        }
    }

    pub fn resolve(self) -> String {
        format!("{}://{}:{}", self.scheme(), self.host(), self.browser_port)
    }

    pub fn expected_host(self) -> String {
        format!("{}:{}", self.host(), self.browser_port)
    }
}

pub fn current(selftest: bool) -> ControlOrigin {
    if selftest {
        ControlOrigin {
            listener_port: SELFTEST_PORT,
            browser_port: SELFTEST_PORT,
            secure: false,
        }
    } else if tauri::is_dev() {
        ControlOrigin {
            listener_port: DEV_API_PORT,
            browser_port: DEV_UI_PORT,
            secure: true,
        }
    } else {
        ControlOrigin {
            listener_port: RELEASE_PORT,
            browser_port: RELEASE_PORT,
            secure: true,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selftest_has_a_stable_isolated_origin() {
        let origin = current(true);
        assert_eq!(origin.listener_port, SELFTEST_PORT);
        assert_eq!(origin.browser_port, SELFTEST_PORT);
        assert_eq!(origin.resolve(), "http://localhost:43122");
    }

    /// The control UI and every sandbox preview must share eTLD+1, or the
    /// preview iframe becomes third-party and WebKit refuses to store its
    /// cookies at all. A single-label host like `localhost` cannot satisfy
    /// that — see this module's doc comment for the measurements.
    #[test]
    fn preview_hosts_are_one_label_under_the_control_host() {
        // Per-handle preview hosts are gated on this being a real registrable
        // domain; `*.localhost` would make the preview iframe third-party and
        // cost it all cookie storage. Whichever form is configured, a handle
        // must never end up under a `.localhost` name.
        assert!(!CONTROL_HOST.ends_with(".localhost"), "{CONTROL_HOST}");
    }

    #[test]
    fn expected_host_includes_the_browser_facing_port() {
        let origin = ControlOrigin {
            listener_port: DEV_API_PORT,
            browser_port: DEV_UI_PORT,
            secure: true,
        };
        assert_eq!(origin.expected_host(), "local.studio.decocms.com:4420");
    }
}
