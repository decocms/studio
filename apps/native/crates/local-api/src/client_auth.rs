use std::sync::{Arc, Mutex};

use axum::http::{header, HeaderMap, Method};

use crate::auth::{constant_time_eq, require_bearer};
use crate::error::ApiError;

pub(crate) const LOCAL_SESSION_COOKIE_NAME: &str = "decocms-local-session";

/// The header carrying the MOUNT-scoped credential — see
/// [`ClientAuth::mount_token_matches`]. A header, not a cookie: the only
/// presenter is `rclone`, which has no jar, and keeping it out of the jar means
/// no browser can ever be tricked into attaching it.
pub(crate) const MOUNT_TOKEN_HEADER: &str = "x-decocms-mount-token";

#[derive(Clone)]
pub(crate) enum ClientAuth {
    Bearer { token: Arc<str> },
    Embedded { session: Arc<EmbeddedSession> },
}

/// Removes only local-api's control credential, preserving every unrelated
/// application cookie. Call this at the Studio upstream-proxy boundary, never
/// in the shared guard: sandbox routes and the preview proxy carry application
/// Cookie/Authorization end-to-end.
pub(crate) fn remove_local_session_cookie(headers: &mut HeaderMap) {
    let retained = headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|header| header.to_str().ok())
        .flat_map(|header| header.split(';'))
        .map(str::trim)
        .filter(|pair| {
            pair.split_once('=')
                .is_none_or(|(name, _)| name != LOCAL_SESSION_COOKIE_NAME)
        })
        .filter(|pair| !pair.is_empty())
        .map(str::to_string)
        .collect::<Vec<_>>();
    headers.remove(header::COOKIE);
    if !retained.is_empty() {
        if let Ok(value) = retained.join("; ").parse() {
            headers.insert(header::COOKIE, value);
        }
    }
}

pub(crate) struct EmbeddedSession {
    /// Every `Host` authority this process answers on. The FIRST is canonical —
    /// the browser-facing origin, the one `control_origin` must agree with.
    /// The rest are additional authorities for the SAME server, which exist
    /// because the browser may reach it through a dev proxy on another port
    /// while non-browser clients in this machine talk to the listener directly.
    expected_hosts: Vec<Arc<str>>,
    control_origin: Arc<str>,
    session_token: Arc<str>,
    mount_token: Arc<str>,
    bootstrap_secrets: Mutex<Vec<Vec<u8>>>,
}

impl ClientAuth {
    pub(crate) fn bearer(token: impl Into<Arc<str>>) -> Self {
        Self::Bearer {
            token: token.into(),
        }
    }

    /// `session_token`: the value the control cookie carries. Supplied by the
    /// caller (rather than minted here) so it can be PERSISTED across
    /// launches — see `stable_session_token` in `lib.rs`. Minting it per
    /// launch invalidated every cookie the webview already held, so after any
    /// backend restart a live page 401'd on every request, forever, with no
    /// path back: the frontend's bootstrap runs once at module init, so
    /// nothing re-established the session until the user manually reloaded.
    ///
    /// `expected_hosts`: the browser-facing authority FIRST (it is the one
    /// checked against `control_origin`), then any additional authority the
    /// same server answers on — see [`EmbeddedSession::expected_hosts`].
    ///
    /// `mount_token`: the narrow credential for the org-filesystem WebDAV
    /// surface — see [`Self::mount_token_matches`].
    pub(crate) fn embedded(
        expected_hosts: Vec<String>,
        control_origin: String,
        bootstrap_secrets: Vec<String>,
        session_token: String,
        mount_token: String,
    ) -> Result<Self, String> {
        let Some(expected_host) = expected_hosts.first() else {
            return Err("embedded auth requires at least one expected host".into());
        };
        validate_control_identity(expected_host, &control_origin)?;
        if expected_hosts.iter().any(String::is_empty) {
            return Err("embedded auth expected_host cannot be empty".into());
        }
        if mount_token.is_empty() {
            return Err("embedded auth requires a non-empty mount token".into());
        }
        let mut unique_secrets = Vec::<String>::new();
        for secret in bootstrap_secrets
            .into_iter()
            .filter(|secret| !secret.is_empty())
        {
            if !unique_secrets.iter().any(|existing| existing == &secret) {
                unique_secrets.push(secret);
            }
        }
        let bootstrap_secrets = unique_secrets
            .into_iter()
            .map(String::into_bytes)
            .collect::<Vec<_>>();
        if bootstrap_secrets.is_empty() {
            return Err("embedded auth requires at least one non-empty bootstrap secret".into());
        }

        Ok(Self::Embedded {
            session: Arc::new(EmbeddedSession {
                expected_hosts: expected_hosts.into_iter().map(Arc::from).collect(),
                control_origin: control_origin.into(),
                session_token: session_token.into(),
                mount_token: mount_token.into(),
                bootstrap_secrets: Mutex::new(bootstrap_secrets),
            }),
        })
    }

    pub(crate) fn is_embedded(&self) -> bool {
        matches!(self, Self::Embedded { .. })
    }

    /// Whether the request presents the mount-scoped credential — the one for
    /// the caller that is neither a browser nor entitled to the whole API: the
    /// `rclone` child serving the org filesystem.
    ///
    /// Never a substitute for [`Self::require_private`] on its own. The caller
    /// pairs it with a path check so this is honoured on `/_sandbox/orgfs/*`
    /// and NOWHERE else (see `router::authorize_private`) — a process that
    /// reads it out of rclone's config gains the WebDAV view the user could
    /// already browse, not `/_sandbox/bash`, and not the cluster session.
    pub(crate) fn mount_token_matches(&self, headers: &HeaderMap) -> bool {
        let Self::Embedded { session } = self else {
            return false;
        };
        headers
            .get(MOUNT_TOKEN_HEADER)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| constant_time_eq(value.as_bytes(), session.mount_token.as_bytes()))
    }

    /// Host is a DNS-rebinding boundary in embedded mode. It deliberately
    /// includes the port: debug requests can arrive through Vite while the
    /// Rust listener itself is bound to a different loopback port — which is
    /// exactly why this matches a SET rather than one value (see
    /// [`EmbeddedSession::expected_hosts`]).
    pub(crate) fn require_expected_host(&self, headers: &HeaderMap) -> Result<(), ApiError> {
        let Self::Embedded { session } = self else {
            return Ok(());
        };
        let host = headers
            .get(header::HOST)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("");
        // Every candidate is compared, with no early exit, so the number of
        // comparisons never depends on which one matched.
        let matched = session
            .expected_hosts
            .iter()
            .fold(false, |matched, expected| {
                constant_time_eq(host.as_bytes(), expected.as_bytes()) | matched
            });
        if matched {
            Ok(())
        } else {
            Err(ApiError::forbidden_origin())
        }
    }

    /// SameSite is site-based, not origin-based. Unsafe embedded requests
    /// therefore require the exact browser origin in addition to the session
    /// cookie. Safe requests may omit Origin, but a present Origin is never
    /// allowed to disagree (notably, WebSocket upgrades are GET requests and
    /// are not protected by browser CORS).
    pub(crate) fn require_unsafe_origin(
        &self,
        method: &Method,
        headers: &HeaderMap,
    ) -> Result<(), ApiError> {
        let Self::Embedded { session } = self else {
            return Ok(());
        };
        let safe = matches!(
            *method,
            Method::GET | Method::HEAD | Method::OPTIONS | Method::TRACE
        );
        let origin = headers
            .get(header::ORIGIN)
            .and_then(|value| value.to_str().ok());
        if (safe && origin.is_none())
            || origin.is_some_and(|origin| {
                constant_time_eq(origin.as_bytes(), session.control_origin.as_bytes())
            })
        {
            Ok(())
        } else {
            Err(ApiError::forbidden_origin())
        }
    }

    pub(crate) fn require_exact_origin(&self, headers: &HeaderMap) -> Result<(), ApiError> {
        let Self::Embedded { session } = self else {
            return Ok(());
        };
        let origin = headers
            .get(header::ORIGIN)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("");
        if constant_time_eq(origin.as_bytes(), session.control_origin.as_bytes()) {
            Ok(())
        } else {
            Err(ApiError::forbidden_origin())
        }
    }

    pub(crate) fn require_private(&self, headers: &HeaderMap) -> Result<(), ApiError> {
        match self {
            Self::Bearer { token } => require_bearer(headers, token),
            Self::Embedded { session } => {
                let matches = cookie_values(headers, LOCAL_SESSION_COOKIE_NAME).any(|value| {
                    constant_time_eq(value.as_bytes(), session.session_token.as_bytes())
                });
                if matches {
                    Ok(())
                } else {
                    Err(ApiError::unauthorized())
                }
            }
        }
    }

    /// Atomically consumes one matching bootstrap bearer. A failed attempt
    /// never burns another window's capability.
    pub(crate) fn consume_bootstrap(&self, headers: &HeaderMap) -> Result<String, ApiError> {
        let Self::Embedded { session } = self else {
            return Err(ApiError::not_found("Not found"));
        };
        let provided = bearer_value(headers).ok_or_else(ApiError::unauthorized)?;
        let mut secrets = session
            .bootstrap_secrets
            .lock()
            .map_err(|_| ApiError::unauthorized())?;
        let matching_index = secrets
            .iter()
            .position(|expected| constant_time_eq(provided.as_bytes(), expected));
        let Some(index) = matching_index else {
            return Err(ApiError::unauthorized());
        };
        secrets.swap_remove(index);

        Ok(format!(
            "{LOCAL_SESSION_COOKIE_NAME}={}; Path=/; HttpOnly; SameSite=Strict",
            session.session_token
        ))
    }
}

fn validate_control_identity(expected_host: &str, control_origin: &str) -> Result<(), String> {
    if expected_host.is_empty() {
        return Err("embedded auth expected_host cannot be empty".into());
    }
    let uri = control_origin
        .parse::<axum::http::Uri>()
        .map_err(|error| format!("invalid embedded control_origin: {error}"))?;
    if !matches!(uri.scheme_str(), Some("http" | "https"))
        || uri.authority().is_none()
        || uri
            .path_and_query()
            .is_some_and(|path| path.as_str() != "/")
    {
        return Err("embedded control_origin must be an http(s) origin without a path".into());
    }
    if uri.authority().map(|authority| authority.as_str()) != Some(expected_host) {
        return Err("embedded control_origin authority must equal expected_host".into());
    }
    Ok(())
}

fn bearer_value(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .filter(|value| !value.is_empty())
}

fn cookie_values<'a>(
    headers: &'a HeaderMap,
    expected_name: &'a str,
) -> impl Iterator<Item = &'a str> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|header| header.to_str().ok())
        .flat_map(|header| header.split(';'))
        .filter_map(move |pair| {
            let (name, value) = pair.trim().split_once('=')?;
            (name == expected_name).then_some(value)
        })
}

#[cfg(test)]
mod tests {
    use axum::http::HeaderValue;

    use super::*;

    fn embedded() -> ClientAuth {
        ClientAuth::embedded(
            vec!["studio.localhost:43120".into()],
            "http://studio.localhost:43120".into(),
            vec!["bootstrap-a".into(), "bootstrap-b".into()],
            "test-session-token".into(),
            "test-mount-token".into(),
        )
        .unwrap()
    }

    fn bootstrap_headers(secret: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {secret}")).unwrap(),
        );
        headers
    }

    fn cookie_from_set_cookie(set_cookie: &str) -> String {
        set_cookie.split(';').next().unwrap().to_string()
    }

    #[test]
    fn embedded_identity_requires_matching_host_and_origin_authority() {
        assert!(ClientAuth::embedded(
            vec!["studio.localhost:43120".into()],
            "http://studio.localhost:43120".into(),
            vec!["secret".into()],
            "test-session-token".into(),
            "test-mount-token".into(),
        )
        .is_ok());
        assert!(ClientAuth::embedded(
            vec!["studio.localhost:43121".into()],
            "http://studio.localhost:4420".into(),
            vec!["secret".into()],
            "test-session-token".into(),
            "test-mount-token".into(),
        )
        .is_err());
        assert!(ClientAuth::embedded(
            vec!["studio.localhost:43120".into()],
            "http://studio.localhost:43120/path".into(),
            vec!["secret".into()],
            "test-session-token".into(),
            "test-mount-token".into(),
        )
        .is_err());
    }

    #[test]
    fn bootstrap_secret_is_one_time_and_other_secrets_survive_failed_attempts() {
        let auth = embedded();
        assert!(auth.consume_bootstrap(&bootstrap_headers("wrong")).is_err());
        let first = auth
            .consume_bootstrap(&bootstrap_headers("bootstrap-a"))
            .unwrap();
        assert!(first.contains("HttpOnly"));
        assert!(first.contains("SameSite=Strict"));
        assert!(!first.contains("Domain="));
        assert!(auth
            .consume_bootstrap(&bootstrap_headers("bootstrap-a"))
            .is_err());
        assert!(auth
            .consume_bootstrap(&bootstrap_headers("bootstrap-b"))
            .is_ok());
    }

    #[test]
    fn session_cookie_auth_accepts_only_the_server_generated_value() {
        let auth = embedded();
        let set_cookie = auth
            .consume_bootstrap(&bootstrap_headers("bootstrap-a"))
            .unwrap();
        let cookie = cookie_from_set_cookie(&set_cookie);

        let mut good = HeaderMap::new();
        good.insert(header::COOKIE, HeaderValue::from_str(&cookie).unwrap());
        assert!(auth.require_private(&good).is_ok());

        let mut wrong = HeaderMap::new();
        wrong.insert(
            header::COOKIE,
            HeaderValue::from_static("decocms-local-session=attacker-selected"),
        );
        assert!(auth.require_private(&wrong).is_err());
    }

    #[test]
    fn embedded_host_and_unsafe_origin_are_exact() {
        let auth = embedded();
        let mut headers = HeaderMap::new();
        headers.insert(
            header::HOST,
            HeaderValue::from_static("studio.localhost:43120"),
        );
        headers.insert(
            header::ORIGIN,
            HeaderValue::from_static("http://studio.localhost:43120"),
        );
        assert!(auth.require_expected_host(&headers).is_ok());
        assert!(auth.require_unsafe_origin(&Method::POST, &headers).is_ok());

        headers.insert(
            header::HOST,
            HeaderValue::from_static("studio.localhost:43121"),
        );
        assert!(auth.require_expected_host(&headers).is_err());

        headers.insert(
            header::ORIGIN,
            HeaderValue::from_static("http://attacker.localhost:43120"),
        );
        assert!(auth.require_unsafe_origin(&Method::GET, &headers).is_err());
        assert!(auth.require_unsafe_origin(&Method::POST, &headers).is_err());

        headers.remove(header::ORIGIN);
        assert!(auth.require_unsafe_origin(&Method::GET, &headers).is_ok());
        assert!(auth.require_unsafe_origin(&Method::POST, &headers).is_err());
    }

    /// One server, two authorities: the browser reaches it through the dev
    /// proxy, loopback subprocesses reach the listener directly. Both are the
    /// same server, so both are accepted — and nothing else is. Only the FIRST
    /// has to agree with `control_origin`, which is why the listener authority
    /// can carry a different port.
    #[test]
    fn every_configured_authority_is_accepted_and_no_other() {
        let auth = ClientAuth::embedded(
            vec![
                "studio.localhost:4420".into(),
                "studio.localhost:43120".into(),
            ],
            "http://studio.localhost:4420".into(),
            vec!["secret".into()],
            "test-session-token".into(),
            "test-mount-token".into(),
        )
        .unwrap();
        let host = |value: &'static str| {
            let mut headers = HeaderMap::new();
            headers.insert(header::HOST, HeaderValue::from_static(value));
            headers
        };
        assert!(auth
            .require_expected_host(&host("studio.localhost:4420"))
            .is_ok());
        assert!(auth
            .require_expected_host(&host("studio.localhost:43120"))
            .is_ok());
        assert!(auth
            .require_expected_host(&host("studio.localhost:43121"))
            .is_err());
        assert!(auth
            .require_expected_host(&host("studio.localhost"))
            .is_err());
        assert!(auth.require_expected_host(&HeaderMap::new()).is_err());
    }

    #[test]
    fn the_mount_token_is_matched_exactly_and_only_from_its_own_header() {
        let auth = embedded();
        let mut headers = HeaderMap::new();
        assert!(!auth.mount_token_matches(&headers));
        headers.insert(
            MOUNT_TOKEN_HEADER,
            HeaderValue::from_static("test-mount-token"),
        );
        assert!(auth.mount_token_matches(&headers));
        headers.insert(MOUNT_TOKEN_HEADER, HeaderValue::from_static("nope"));
        assert!(!auth.mount_token_matches(&headers));
        // The session cookie is NOT a mount credential, and vice versa.
        let mut cookie_only = HeaderMap::new();
        cookie_only.insert(
            header::COOKIE,
            HeaderValue::from_static("decocms-local-session=test-session-token"),
        );
        assert!(!auth.mount_token_matches(&cookie_only));
        let mut mount_only = HeaderMap::new();
        mount_only.insert(
            MOUNT_TOKEN_HEADER,
            HeaderValue::from_static("test-mount-token"),
        );
        assert!(auth.require_private(&mount_only).is_err());
    }

    #[test]
    fn removing_control_cookie_preserves_unrelated_application_cookies() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::COOKIE,
            HeaderValue::from_static(
                "sandbox-session=abc; decocms-local-session=secret; theme=dark",
            ),
        );
        remove_local_session_cookie(&mut headers);
        assert_eq!(
            headers.get(header::COOKIE).unwrap(),
            "sandbox-session=abc; theme=dark"
        );
    }
}
