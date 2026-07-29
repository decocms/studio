use axum::body::Body;
use axum::http::{header, HeaderValue, Method, StatusCode};
use axum::response::Response;

/// One exact UI asset supplied by the embedding shell. The local API does
/// not know whether bytes came from Tauri resources, an archive, or memory.
#[derive(Clone)]
pub struct UiAsset {
    pub bytes: bytes::Bytes,
    pub content_type: String,
    pub cache_control: String,
}

impl UiAsset {
    pub fn new(
        bytes: impl Into<bytes::Bytes>,
        content_type: impl Into<String>,
        cache_control: impl Into<String>,
    ) -> Self {
        Self {
            bytes: bytes.into(),
            content_type: content_type.into(),
            cache_control: cache_control.into(),
        }
    }
}

/// Tauri-independent source for the bundled SPA. Implementations must perform
/// exact path lookup; the router owns traversal rejection and SPA fallback.
pub trait UiAssetProvider: Send + Sync {
    fn asset(&self, path: &str) -> Option<UiAsset>;
    fn index(&self) -> Option<UiAsset>;
    fn content_security_policy(&self) -> String;
}

pub(crate) fn asset_response(asset: UiAsset, method: &Method) -> Response {
    let content_length = asset.bytes.len();
    let body = if method == Method::HEAD {
        Body::empty()
    } else {
        Body::from(asset.bytes)
    };
    let mut response = Response::new(body);
    *response.status_mut() = StatusCode::OK;
    let headers = response.headers_mut();
    if let Ok(value) = HeaderValue::from_str(&asset.content_type) {
        headers.insert(header::CONTENT_TYPE, value);
    } else {
        headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/octet-stream"),
        );
    }
    if let Ok(value) = HeaderValue::from_str(&asset.cache_control) {
        headers.insert(header::CACHE_CONTROL, value);
    }
    if let Ok(value) = HeaderValue::from_str(&content_length.to_string()) {
        headers.insert(header::CONTENT_LENGTH, value);
    }
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    response
}

pub(crate) fn index_response(
    asset: UiAsset,
    method: &Method,
    base_csp: &str,
    preview_origin: &str,
) -> Response {
    if base_csp.trim().is_empty() {
        return csp_error_response();
    }
    let mut response = asset_response(asset, method);
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response.headers_mut().insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    let csp = patch_preview_origin(base_csp, preview_origin);
    let Ok(value) = HeaderValue::from_str(&csp) else {
        return csp_error_response();
    };
    response
        .headers_mut()
        .insert(header::CONTENT_SECURITY_POLICY, value);
    response
}

fn csp_error_response() -> Response {
    Response::builder()
        .status(StatusCode::INTERNAL_SERVER_ERROR)
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(Body::from("UI security policy unavailable"))
        .unwrap_or_else(|_| Response::new(Body::empty()))
}

fn patch_preview_origin(base: &str, preview_origin: &str) -> String {
    let mut directives = base
        .split(';')
        .map(str::trim)
        .filter(|directive| !directive.is_empty())
        .map(str::to_string)
        .collect::<Vec<_>>();
    let preview_ws_origin = preview_origin
        .strip_prefix("http://")
        .map(|authority| format!("ws://{authority}"));
    add_csp_sources(
        &mut directives,
        "connect-src",
        preview_ws_origin
            .as_deref()
            .map_or_else(|| vec![preview_origin], |ws| vec![preview_origin, ws]),
    );
    add_csp_sources(&mut directives, "frame-src", vec![preview_origin]);
    format!("{};", directives.join("; "))
}

fn add_csp_sources(directives: &mut Vec<String>, name: &str, sources: Vec<&str>) {
    if let Some(directive) = directives
        .iter_mut()
        .find(|directive| directive.split_whitespace().next() == Some(name))
    {
        let mut values = directive
            .split_whitespace()
            .skip(1)
            .filter(|value| *value != "'none'")
            .collect::<Vec<_>>();
        for source in sources {
            if !values.contains(&source) {
                values.push(source);
            }
        }
        *directive = format!("{name} {}", values.join(" "));
    } else {
        directives.push(format!("{name} 'self' {}", sources.join(" ")));
    }
}

pub(crate) fn is_safe_asset_path(path: &str) -> bool {
    if !path.starts_with('/') || path.contains('\\') {
        return false;
    }
    let lower = path.to_ascii_lowercase();
    if lower.contains("%2e") || lower.contains("%2f") || lower.contains("%5c") {
        return false;
    }
    !path.split('/').any(|segment| matches!(segment, "." | ".."))
}

#[cfg(test)]
mod tests {
    use axum::body::to_bytes;

    use super::*;

    #[test]
    fn csp_adds_preview_to_existing_directives_and_replaces_none() {
        let patched = patch_preview_origin(
            "default-src 'self'; connect-src 'self'; frame-src 'none'",
            "http://localhost:61234",
        );
        assert!(patched.contains("connect-src 'self' http://localhost:61234 ws://localhost:61234"));
        assert!(patched.contains("frame-src http://localhost:61234"));
        assert!(!patched.contains("frame-src 'none'"));
    }

    #[test]
    fn csp_creates_missing_preview_directives() {
        let patched = patch_preview_origin("default-src 'self'", "http://localhost:61234");
        assert!(patched.contains("connect-src 'self' http://localhost:61234 ws://localhost:61234"));
        assert!(patched.contains("frame-src 'self' http://localhost:61234"));
    }

    #[test]
    fn traversal_and_encoded_separators_are_rejected() {
        for path in [
            "../index.html",
            "/../index.html",
            "/assets/./x.js",
            "/assets\\x.js",
            "/assets/%2e%2e/x.js",
            "/assets/%2Fx.js",
        ] {
            assert!(!is_safe_asset_path(path), "{path} should be rejected");
        }
        assert!(is_safe_asset_path("/assets/app.123.js"));
    }

    #[tokio::test]
    async fn head_preserves_asset_headers_but_has_no_body() {
        let response = asset_response(
            UiAsset::new(
                bytes::Bytes::from_static(b"body"),
                "text/plain",
                "public, max-age=31536000, immutable",
            ),
            &Method::HEAD,
        );
        assert_eq!(response.headers()[header::CONTENT_LENGTH], "4");
        assert_eq!(
            response.headers()[header::CACHE_CONTROL],
            "public, max-age=31536000, immutable"
        );
        assert!(to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap()
            .is_empty());
    }

    #[test]
    fn index_fails_closed_when_provider_csp_is_missing_or_invalid() {
        let asset = || {
            UiAsset::new(
                bytes::Bytes::from_static(b"<html></html>"),
                "text/html",
                "no-store",
            )
        };
        assert_eq!(
            index_response(asset(), &Method::GET, "", "http://localhost:1").status(),
            StatusCode::INTERNAL_SERVER_ERROR
        );
        assert_eq!(
            index_response(
                asset(),
                &Method::GET,
                "default-src 'self'\nX-Injected: yes",
                "http://localhost:1",
            )
            .status(),
            StatusCode::INTERNAL_SERVER_ERROR
        );
    }
}
