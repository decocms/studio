//! Wire shapes for the SHARED IPC/BOOT CONTRACT's `auth_status`/
//! `auth_login`/`auth_logout` commands. The actual OAuth PKCE loopback +
//! Keychain session logic lives in `crates/upstream` (built in parallel by
//! a different agent — see the desktop migration contract); its
//! `upstream::session::global()` singleton IS the seam (see that crate's
//! `lib.rs`/`session.rs` module docs for why a process-wide singleton
//! rather than an `AppState` field), so `commands.rs` calls it directly —
//! this file only converts `upstream::StatusResult` into the two wire
//! shapes the contract pins.

use serde::Serialize;
use upstream::{AuthStorageState, StatusResult};

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AuthStorageStateWire {
    Available,
    Unavailable,
}

impl From<AuthStorageState> for AuthStorageStateWire {
    fn from(state: AuthStorageState) -> Self {
        match state {
            AuthStorageState::Available => Self::Available,
            AuthStorageState::Unavailable => Self::Unavailable,
        }
    }
}

/// Wire shape for `auth_status()` —
/// `{signedIn, userLabel, upstreamUrl, storageState}`
/// per the SHARED IPC/BOOT CONTRACT.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatusWire {
    pub signed_in: bool,
    pub user_label: Option<String>,
    pub upstream_url: String,
    pub storage_state: AuthStorageStateWire,
}

impl From<StatusResult> for AuthStatusWire {
    fn from(s: StatusResult) -> Self {
        Self {
            signed_in: s.signed_in,
            user_label: s.user_label,
            upstream_url: s.upstream_url,
            storage_state: s.storage_state.into(),
        }
    }
}

/// Wire shape for `auth_login()`/`auth_logout()` —
/// `{signedIn, userLabel, storageState}`
/// per the SHARED IPC/BOOT CONTRACT (no `upstreamUrl`; only `auth_status`
/// carries that — `upstream::StatusResult` always has one, so this
/// conversion just drops it to match the pinned shape).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthResultWire {
    pub signed_in: bool,
    pub user_label: Option<String>,
    pub storage_state: AuthStorageStateWire,
}

impl From<StatusResult> for AuthResultWire {
    fn from(s: StatusResult) -> Self {
        Self {
            signed_in: s.signed_in,
            user_label: s.user_label,
            storage_state: s.storage_state.into(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_wire_keeps_upstream_url_login_result_wire_drops_it() {
        let status = StatusResult {
            signed_in: true,
            user_label: Some("a@b.com".to_string()),
            upstream_url: "https://example.test".to_string(),
            storage_state: AuthStorageState::Available,
        };
        let status_wire = AuthStatusWire::from(status.clone());
        assert_eq!(status_wire.upstream_url, "https://example.test");
        assert_eq!(status_wire.storage_state, AuthStorageStateWire::Available);

        let result_wire = AuthResultWire::from(status);
        assert!(result_wire.signed_in);
        assert_eq!(result_wire.user_label.as_deref(), Some("a@b.com"));
        assert_eq!(result_wire.storage_state, AuthStorageStateWire::Available);
    }
}
