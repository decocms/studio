//! Stable loopback origins for the native control UI.
//!
//! Browser storage is scoped by the full origin, while cookies are scoped by
//! host rather than port. Both the control UI and sandbox previews use plain
//! `localhost` on different ports. That is the only small iframe-based design
//! that keeps sandbox cookies first-party on the app's macOS 11 minimum:
//! arbitrary `*.localhost` names are unreliable in a bundled WKWebView.

pub const RELEASE_PORT: u16 = 43_120;
pub const DEV_API_PORT: u16 = 43_121;
pub const SELFTEST_PORT: u16 = 43_122;
pub const DEV_UI_PORT: u16 = 4_420;
pub const CONTROL_HOST: &str = "localhost";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ControlOrigin {
    pub listener_port: u16,
    pub browser_port: u16,
}

impl ControlOrigin {
    pub fn resolve(self) -> String {
        format!("http://{CONTROL_HOST}:{}", self.browser_port)
    }

    pub fn expected_host(self) -> String {
        format!("{CONTROL_HOST}:{}", self.browser_port)
    }
}

pub fn current(selftest: bool) -> ControlOrigin {
    if selftest {
        ControlOrigin {
            listener_port: SELFTEST_PORT,
            browser_port: SELFTEST_PORT,
        }
    } else if tauri::is_dev() {
        ControlOrigin {
            listener_port: DEV_API_PORT,
            browser_port: DEV_UI_PORT,
        }
    } else {
        ControlOrigin {
            listener_port: RELEASE_PORT,
            browser_port: RELEASE_PORT,
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

    #[test]
    fn expected_host_includes_the_browser_facing_port() {
        let origin = ControlOrigin {
            listener_port: DEV_API_PORT,
            browser_port: DEV_UI_PORT,
        };
        assert_eq!(origin.expected_host(), "localhost:4420");
    }
}
