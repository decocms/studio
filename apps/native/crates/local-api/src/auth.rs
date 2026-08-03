//! Bearer-token auth — byte-parity with
//! `packages/sandbox/daemon-go/internal/auth/auth.go::requireToken` /
//! `constantTimeEqual` (see `auth.test.ts` for the exact matrix pinned
//! here: matching token accepts, wrong token / no header / non-`Bearer`
//! scheme / empty configured token all reject).
//!
//! Route exemption: unlike the daemon (which leaves `/_sandbox/idle`,
//! `/_sandbox/scripts`, `/_sandbox/events` GETs, and OPTIONS preflight
//! unauthenticated), local-api's contract
//! (the native local-API contract) tightens this to
//! "every route requires the bearer except `GET /health`". `router.rs`
//! enforces that exemption structurally (by never applying this module's
//! middleware to the `/health` route) rather than this module special-
//! casing paths — keeps the auth primitive itself path-agnostic and
//! testable in isolation.

use axum::http::HeaderMap;
use subtle::ConstantTimeEq;

use crate::error::ApiError;

const BEARER_PREFIX: &str = "Bearer ";

/// Validate `Authorization: Bearer <token>` against `expected` in constant
/// time. `Ok(())` on match; `Err(ApiError::unauthorized())` otherwise. An
/// empty `expected` NEVER matches — fail closed, never treat an unset
/// server-side token as "auth disabled".
pub fn require_bearer(headers: &HeaderMap, expected: &str) -> Result<(), ApiError> {
    let header = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let Some(provided) = header.strip_prefix(BEARER_PREFIX) else {
        return Err(ApiError::unauthorized());
    };
    if expected.is_empty() || !constant_time_eq(provided.as_bytes(), expected.as_bytes()) {
        return Err(ApiError::unauthorized());
    }
    Ok(())
}

pub(crate) fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    // `subtle::ConstantTimeEq` already short-circuits safely on length
    // mismatch (it compares up to the shorter length and folds the length
    // check itself into the constant-time result), but being explicit here
    // documents the invariant without depending on that implementation
    // detail staying true across a `subtle` upgrade.
    if a.len() != b.len() {
        return false;
    }
    a.ct_eq(b).into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::{HeaderMap, HeaderValue};

    const TOKEN: &str = "test-token-32-chars-min-aaaaaaaa";

    fn headers_with_auth(value: &str) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert(
            axum::http::header::AUTHORIZATION,
            HeaderValue::from_str(value).unwrap(),
        );
        h
    }

    #[test]
    fn accepts_matching_bearer() {
        let headers = headers_with_auth(&format!("Bearer {TOKEN}"));
        assert!(require_bearer(&headers, TOKEN).is_ok());
    }

    #[test]
    fn rejects_wrong_token() {
        let headers = headers_with_auth("Bearer wrong-token");
        let err = require_bearer(&headers, TOKEN).unwrap_err();
        assert_eq!(err.status, axum::http::StatusCode::UNAUTHORIZED);
        assert_eq!(err.body["error"], "unauthorized");
    }

    #[test]
    fn rejects_missing_header() {
        let headers = HeaderMap::new();
        assert!(require_bearer(&headers, TOKEN).is_err());
    }

    #[test]
    fn rejects_non_bearer_scheme() {
        let headers = headers_with_auth(TOKEN);
        assert!(require_bearer(&headers, TOKEN).is_err());
    }

    #[test]
    fn empty_expected_token_rejects_everything() {
        let headers = headers_with_auth("Bearer ");
        assert!(require_bearer(&headers, "").is_err());
    }
}
