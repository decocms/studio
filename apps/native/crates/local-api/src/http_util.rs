//! Cross-family HTTP plumbing every proxy/SSE/JSON route in this crate must
//! agree on. Each item here exists because the same contract used to be typed
//! out per route family and had already drifted (or was one edit away from
//! it):
//!
//! - [`HOP_BY_HOP_HEADER_NAMES`] / [`strip_hop_by_hop_headers`] /
//!   [`is_hop_by_hop`] — the RFC 7230 §6.1 connection-header set. Three proxy
//!   families (the app-API proxy, the preview proxy, the WebSocket bridge)
//!   each carried their own copy; the WebSocket copy had silently dropped
//!   `proxy-connection`. One list, one drift channel closed.
//! - [`event_stream_response`] — the events-family SSE header contract,
//!   centralized so event routes cannot drift from one another.
//! - [`json_body`] / [`json_body_or_default`] — request-body JSON parsing
//!   with the crate's pinned 400 messages. The per-family message wording is
//!   wire contract (the fs family's daemon-parity oracle pins "Failed to
//!   parse body"), so it stays a parameter where families differ instead of
//!   being re-typed per file.
//! - [`query_param`] — tolerant single-parameter extraction from a raw query
//!   string, previously duplicated per intercept route.

use axum::body::Body;
use axum::http::{header, HeaderMap, HeaderName, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::de::DeserializeOwned;

use crate::error::ApiError;

/// The hop-by-hop header names every proxy family in this crate strips: the
/// RFC 7230 §6.1 set plus the legacy `proxy-connection`. All-lowercase, so
/// entries compare directly against `HeaderName::as_str()` (which is always
/// lowercase).
pub(crate) const HOP_BY_HOP_HEADER_NAMES: [&str; 9] = [
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "proxy-connection",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
];

/// Whether `name` describes one HTTP connection rather than the proxied
/// message. Predicate form of [`HOP_BY_HOP_HEADER_NAMES`], for callers that
/// filter while copying between header maps (the WebSocket bridge) instead of
/// mutating one in place. Callers still handle `Connection`-nominated tokens
/// themselves — those are per-message, not a fixed list.
pub(crate) fn is_hop_by_hop(name: &HeaderName) -> bool {
    HOP_BY_HOP_HEADER_NAMES.contains(&name.as_str())
}

/// Removes headers that describe one HTTP connection rather than the proxied
/// message. RFC 7230 §6.1 also allows `Connection` to name arbitrary
/// additional hop-by-hop fields, so collect those tokens before removing
/// `Connection` itself.
pub(crate) fn strip_hop_by_hop_headers(headers: &mut HeaderMap) {
    let connection_tokens: Vec<HeaderName> = headers
        .get_all(header::CONNECTION)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .filter_map(|name| HeaderName::from_bytes(name.trim().as_bytes()).ok())
        .collect();

    for name in connection_tokens {
        headers.remove(name);
    }
    for name in HOP_BY_HOP_HEADER_NAMES {
        headers.remove(name);
    }
}

/// A `200 text/event-stream` response with the events-family header set the
/// daemon-parity oracle pins (`no-cache`, `X-Accel-Buffering: no`,
/// `Content-Encoding: identity` — byte-parity with
/// `daemon/routes/events-stream.ts`). `context` names the route family in the
/// (never expected — every part is statically valid) builder-failure log/500.
pub(crate) fn event_stream_response(body: Body, context: &'static str) -> Response {
    match Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/event-stream")
        .header(header::CACHE_CONTROL, "no-cache")
        .header(header::CONNECTION, "keep-alive")
        .header("X-Accel-Buffering", "no")
        .header(header::CONTENT_ENCODING, "identity")
        .body(body)
    {
        Ok(response) => response,
        Err(error) => {
            tracing::error!(%error, context, "failed to build SSE response");
            ApiError::internal(format!("failed to build {context}")).into_response()
        }
    }
}

/// Parses a required JSON request body; any failure (including an empty body)
/// is a 400 with the crate's standard `invalid JSON body: …` message.
pub(crate) fn json_body<T: DeserializeOwned>(bytes: &[u8]) -> Result<T, ApiError> {
    parse_json_slice(bytes, "invalid JSON body")
}

/// Parses an OPTIONAL JSON request body: empty bytes mean `T::default()`,
/// anything non-empty must parse. `error_prefix` is the owning family's
/// pinned 400 wording (`"invalid JSON body"` for the thread routes, the
/// daemon-parity `"Failed to parse body"` for the fs family) — a parameter,
/// not a constant, precisely so the per-family wire messages stay explicit at
/// the call site instead of silently converging.
pub(crate) fn json_body_or_default<T: DeserializeOwned + Default>(
    bytes: &[u8],
    error_prefix: &'static str,
) -> Result<T, ApiError> {
    if bytes.is_empty() {
        return Ok(T::default());
    }
    parse_json_slice(bytes, error_prefix)
}

fn parse_json_slice<T: DeserializeOwned>(
    bytes: &[u8],
    error_prefix: &'static str,
) -> Result<T, ApiError> {
    serde_json::from_slice(bytes).map_err(|e| ApiError::bad_request(format!("{error_prefix}: {e}")))
}

/// The value of `name` in a raw query string, percent-decoded tolerantly (an
/// undecodable value is returned raw rather than dropped). A bare key with no
/// `=` never matches. Routes that must instead REJECT an undecodable value
/// (`routes/intercept/watch.rs`'s `types` filter 400s on bad
/// percent-encoding) keep their own strict parsing on purpose.
pub(crate) fn query_param(query: &str, name: &str) -> Option<String> {
    query.split('&').find_map(|pair| {
        let (key, value) = pair.split_once('=')?;
        (key == name).then(|| {
            urlencoding::decode(value)
                .map(|decoded| decoded.into_owned())
                .unwrap_or_else(|_| value.to_string())
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    /// The one canonical list: it must carry the full RFC 7230 §6.1 set PLUS
    /// legacy `proxy-connection`, and the predicate must agree with it — this
    /// is exactly the drift that had already happened when the WebSocket
    /// bridge kept its own copy.
    #[test]
    fn hop_by_hop_list_covers_rfc7230_plus_proxy_connection() {
        for name in [
            "connection",
            "keep-alive",
            "proxy-authenticate",
            "proxy-authorization",
            "proxy-connection",
            "te",
            "trailer",
            "transfer-encoding",
            "upgrade",
        ] {
            assert!(
                HOP_BY_HOP_HEADER_NAMES.contains(&name),
                "missing hop-by-hop header {name:?}"
            );
            assert!(is_hop_by_hop(&HeaderName::from_static(name)));
        }
        assert_eq!(HOP_BY_HOP_HEADER_NAMES.len(), 9);
        assert!(!is_hop_by_hop(&header::CONTENT_TYPE));
        assert!(!is_hop_by_hop(&header::SET_COOKIE));
    }

    #[test]
    fn strips_standard_and_connection_nominated_hop_by_hop_headers() {
        let mut headers = HeaderMap::new();
        headers.append(
            header::CONNECTION,
            HeaderValue::from_static("keep-alive, x-remove-me"),
        );
        headers.append(header::CONNECTION, HeaderValue::from_static("x-remove-too"));
        headers.insert("keep-alive", HeaderValue::from_static("timeout=5"));
        headers.insert(
            header::TRANSFER_ENCODING,
            HeaderValue::from_static("chunked"),
        );
        headers.insert("proxy-connection", HeaderValue::from_static("keep-alive"));
        headers.insert("x-remove-me", HeaderValue::from_static("one"));
        headers.insert("x-remove-too", HeaderValue::from_static("two"));
        headers.insert("x-end-to-end", HeaderValue::from_static("keep"));

        strip_hop_by_hop_headers(&mut headers);

        assert!(headers.get(header::CONNECTION).is_none());
        assert!(headers.get("keep-alive").is_none());
        assert!(headers.get(header::TRANSFER_ENCODING).is_none());
        assert!(headers.get("proxy-connection").is_none());
        assert!(headers.get("x-remove-me").is_none());
        assert!(headers.get("x-remove-too").is_none());
        assert_eq!(headers.get("x-end-to-end").unwrap(), "keep");
    }

    #[test]
    fn event_stream_response_pins_the_events_family_header_set() {
        let response = event_stream_response(Body::empty(), "test stream");
        assert_eq!(response.status(), StatusCode::OK);
        let headers = response.headers();
        assert_eq!(headers[header::CONTENT_TYPE], "text/event-stream");
        assert_eq!(headers[header::CACHE_CONTROL], "no-cache");
        assert_eq!(headers[header::CONNECTION], "keep-alive");
        assert_eq!(headers["x-accel-buffering"], "no");
        assert_eq!(headers[header::CONTENT_ENCODING], "identity");
    }

    #[test]
    fn json_body_rejects_empty_and_malformed_bodies() {
        assert!(json_body::<serde_json::Value>(b"{\"a\":1}").is_ok());
        assert!(json_body::<serde_json::Value>(b"").is_err());
        assert!(json_body::<serde_json::Value>(b"not json").is_err());
    }

    #[test]
    fn json_body_or_default_treats_empty_as_default_and_keeps_the_family_prefix() {
        #[derive(serde::Deserialize, Default, PartialEq, Debug)]
        struct Probe {
            n: Option<i64>,
        }
        assert_eq!(
            json_body_or_default::<Probe>(b"", "Failed to parse body").unwrap(),
            Probe::default()
        );
        assert_eq!(
            json_body_or_default::<Probe>(br#"{"n":2}"#, "Failed to parse body")
                .unwrap()
                .n,
            Some(2)
        );
        let err = json_body_or_default::<Probe>(b"nope", "Failed to parse body").unwrap_err();
        assert_eq!(err.status, StatusCode::BAD_REQUEST);
        let message = err.body["error"].as_str().unwrap();
        assert!(message.starts_with("Failed to parse body: "), "{message}");
    }

    #[test]
    fn query_param_reads_one_decoded_value_out_of_a_raw_query() {
        // The `path` shapes `preview-fetch` depends on.
        assert_eq!(
            query_param("path=/index.html", "path").as_deref(),
            Some("/index.html")
        );
        // Percent-encoded, and not the first parameter.
        assert_eq!(
            query_param("x=1&path=%2Fa%2Fb.json&y=2", "path").as_deref(),
            Some("/a/b.json")
        );
        assert_eq!(query_param("nope=1", "path"), None);
        assert_eq!(query_param("", "path"), None);
        // The `branch` shapes agent-sandbox-sessions depends on.
        assert_eq!(
            query_param("branch=main", "branch").as_deref(),
            Some("main")
        );
        assert_eq!(
            query_param("x=1&branch=feature%2Ffoo", "branch").as_deref(),
            Some("feature/foo")
        );
        assert_eq!(query_param("other=1", "branch"), None);
        // An undecodable value falls back to the raw text, never to None.
        assert_eq!(query_param("path=%FF", "path").as_deref(), Some("%FF"));
    }
}
