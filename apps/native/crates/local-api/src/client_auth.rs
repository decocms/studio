use std::sync::{Arc, Mutex};

use axum::http::{header, HeaderMap, Method};
use rand::RngCore;

use crate::auth::{constant_time_eq, require_bearer};
use crate::error::ApiError;

pub(crate) const LOCAL_SESSION_COOKIE_NAME: &str = "decocms-local-session";

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
    expected_host: Arc<str>,
    control_origin: Arc<str>,
    session_token: Arc<str>,
    bootstrap_secrets: Mutex<Vec<Vec<u8>>>,
}

impl ClientAuth {
    pub(crate) fn bearer(token: impl Into<Arc<str>>) -> Self {
        Self::Bearer {
            token: token.into(),
        }
    }

    pub(crate) fn embedded(
        expected_host: String,
        control_origin: String,
        bootstrap_secrets: Vec<String>,
    ) -> Result<Self, String> {
        validate_control_identity(&expected_host, &control_origin)?;
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
                expected_host: expected_host.into(),
                control_origin: control_origin.into(),
                session_token: generate_secret().into(),
                bootstrap_secrets: Mutex::new(bootstrap_secrets),
            }),
        })
    }

    pub(crate) fn is_embedded(&self) -> bool {
        matches!(self, Self::Embedded { .. })
    }

    /// The per-launch control credential, for the ONE caller that is not a
    /// browser: the `rclone` child that mounts the org filesystem must satisfy
    /// the same guard as the webview (see [`crate::sandbox::org_mount`]), and
    /// it has no cookie jar to be handed one through.
    ///
    /// `None` in bearer mode, where callers authenticate with the bearer
    /// instead.
    pub(crate) fn session_token(&self) -> Option<&str> {
        match self {
            Self::Embedded { session } => Some(&session.session_token),
            _ => None,
        }
    }

    /// Host is a DNS-rebinding boundary in embedded mode. It deliberately
    /// includes the port: debug requests can arrive through Vite while the
    /// Rust listener itself is bound to a different loopback port.
    pub(crate) fn require_expected_host(&self, headers: &HeaderMap) -> Result<(), ApiError> {
        let Self::Embedded { session } = self else {
            return Ok(());
        };
        let host = headers
            .get(header::HOST)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("");
        if constant_time_eq(host.as_bytes(), session.expected_host.as_bytes()) {
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

fn generate_secret() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use axum::http::HeaderValue;

    use super::*;

    fn embedded() -> ClientAuth {
        ClientAuth::embedded(
            "studio.localhost:43120".into(),
            "http://studio.localhost:43120".into(),
            vec!["bootstrap-a".into(), "bootstrap-b".into()],
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
            "studio.localhost:43120".into(),
            "http://studio.localhost:43120".into(),
            vec!["secret".into()],
        )
        .is_ok());
        assert!(ClientAuth::embedded(
            "studio.localhost:43121".into(),
            "http://studio.localhost:4420".into(),
            vec!["secret".into()],
        )
        .is_err());
        assert!(ClientAuth::embedded(
            "studio.localhost:43120".into(),
            "http://studio.localhost:43120/path".into(),
            vec!["secret".into()],
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
