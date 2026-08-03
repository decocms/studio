//! The filesystem surface the WebDAV layer serves, plus its one production
//! implementation: an HTTP client for the studio's org-fs contract
//! (`/api/:org/fs/:volume/*`, `apps/api/src/api/routes/org-fs.ts`).
//!
//! Port of `packages/sandbox/orgfs/api.ts` + `client.ts`, minus the
//! entire token-provisioning path. The daemon needed a short-lived fs-scoped
//! API key relayed through `ORGFS_CONFIG` because a cluster pod has no
//! identity of its own; local-api already holds the signed-in user's session,
//! so every call goes out through [`crate::routes::upstream::send_org_request`]
//! with the Keychain-backed access token attached server-side. There is no key
//! to mint, store, rotate, or leak.
//!
//! The trait exists so `webdav.rs` can be exercised against an in-memory
//! volume — the protocol translation is what needs testing, not reqwest.

use axum::body::{Body, Bytes};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use serde_json::Value;

use super::dav::{iso_to_epoch_secs, now_secs, OrgFsNode};
use crate::routes::upstream::{send_org_request, UpstreamCallError};

/// Carries an HTTP status so the WebDAV layer can map it to a response —
/// `org-fs/api.ts::OrgFsApiError`.
#[derive(Debug, Clone)]
pub struct OrgFsError {
    pub status: StatusCode,
    pub message: String,
}

impl OrgFsError {
    fn new(status: StatusCode, message: impl Into<String>) -> Self {
        OrgFsError {
            status,
            message: message.into(),
        }
    }
}

impl From<UpstreamCallError> for OrgFsError {
    fn from(err: UpstreamCallError) -> Self {
        match err {
            UpstreamCallError::NotSignedIn => OrgFsError::new(
                StatusCode::UNAUTHORIZED,
                "not signed in to the upstream deployment",
            ),
            UpstreamCallError::Unreachable(msg) => OrgFsError::new(StatusCode::BAD_GATEWAY, msg),
        }
    }
}

/// A byte range served straight from the object store — see
/// [`OrgFs::read_stream`].
pub struct StreamedRead {
    pub status: StatusCode,
    pub content_length: Option<HeaderValue>,
    pub content_range: Option<HeaderValue>,
    pub body: Body,
}

#[async_trait::async_trait]
pub trait OrgFs: Send + Sync {
    /// Immediate children of a directory (`""` = volume root).
    async fn list_dir(&self, path: &str) -> Result<Vec<OrgFsNode>, OrgFsError>;
    /// Metadata for one entry, or `None` if absent.
    async fn stat(&self, path: &str) -> Result<Option<OrgFsNode>, OrgFsError>;
    /// Full bytes of a file.
    async fn read(&self, path: &str) -> Result<Vec<u8>, OrgFsError>;
    /// Stream a read straight from the byte store (presigned URL), pushing an
    /// optional `Range` down so only the requested bytes move — where
    /// [`OrgFs::read`] buffers every byte through the studio AND this process.
    /// `None` means no streamable URL was available and the caller should fall
    /// back to [`OrgFs::read`].
    async fn read_stream(
        &self,
        path: &str,
        range: Option<&str>,
    ) -> Result<Option<StreamedRead>, OrgFsError>;
    /// Create or overwrite a file.
    async fn write(
        &self,
        path: &str,
        body: Bytes,
        content_type: Option<&str>,
    ) -> Result<(), OrgFsError>;
    /// Create a directory and its ancestors. Idempotent.
    async fn mkdir(&self, path: &str) -> Result<(), OrgFsError>;
    /// Delete a file, or a directory and everything under it.
    async fn remove(&self, path: &str) -> Result<(), OrgFsError>;
    /// Move or rename.
    async fn rename(&self, from: &str, to: &str) -> Result<(), OrgFsError>;
}

/// The studio-backed implementation. One instance per (org, volume) — built
/// per request, since it holds nothing but two strings.
pub struct UpstreamOrgFs {
    base: String,
}

impl UpstreamOrgFs {
    pub fn new(org: &str, volume: &str) -> Self {
        UpstreamOrgFs {
            base: format!(
                "/api/{}/fs/{}",
                urlencoding::encode(org),
                urlencoding::encode(volume)
            ),
        }
    }

    fn url(&self, op: &str, params: &[(&str, &str)]) -> String {
        let query = params
            .iter()
            .map(|(k, v)| format!("{}={}", k, urlencoding::encode(v)))
            .collect::<Vec<_>>()
            .join("&");
        if query.is_empty() {
            format!("{}/{op}", self.base)
        } else {
            format!("{}/{op}?{query}", self.base)
        }
    }

    async fn send(
        &self,
        method: Method,
        url: &str,
        headers: HeaderMap,
        body: Bytes,
    ) -> Result<reqwest::Response, OrgFsError> {
        Ok(send_org_request(method, url, headers, body).await?)
    }

    /// Turn a non-2xx upstream response into an [`OrgFsError`], preferring the
    /// contract's `{"error": "..."}` body over a bare status line.
    async fn fail(response: reqwest::Response) -> OrgFsError {
        let status = StatusCode::from_u16(response.status().as_u16())
            .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
        let detail = response
            .json::<Value>()
            .await
            .ok()
            .and_then(|body| {
                body.get("error")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| format!("HTTP {}", status.as_u16()));
        OrgFsError::new(status, detail)
    }

    /// The plain HTTP client for presigned object-store URLs. Deliberately
    /// separate from the upstream proxy client: a presigned URL is external to
    /// the studio and must never carry the session bearer.
    fn presign_client() -> &'static reqwest::Client {
        static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
        CLIENT.get_or_init(reqwest::Client::new)
    }
}

fn json_accept_headers() -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(header::ACCEPT, HeaderValue::from_static("application/json"));
    headers
}

/// One entry as returned by `/api/:org/fs/:volume/*`.
fn node_from_json(value: &Value) -> Option<OrgFsNode> {
    let path = value.get("path")?.as_str()?.to_string();
    let is_dir = value.get("kind").and_then(Value::as_str) == Some("dir");
    Some(OrgFsNode {
        path,
        is_dir,
        size: value.get("size").and_then(Value::as_u64).unwrap_or(0),
        updated_at_secs: value
            .get("updatedAt")
            .and_then(Value::as_str)
            .and_then(iso_to_epoch_secs)
            .unwrap_or_else(now_secs),
    })
}

#[async_trait::async_trait]
impl OrgFs for UpstreamOrgFs {
    async fn list_dir(&self, path: &str) -> Result<Vec<OrgFsNode>, OrgFsError> {
        let url = self.url("list", &[("path", path)]);
        let response = self
            .send(Method::GET, &url, json_accept_headers(), Bytes::new())
            .await?;
        if !response.status().is_success() {
            return Err(Self::fail(response).await);
        }
        let body: Value = response
            .json()
            .await
            .map_err(|e| OrgFsError::new(StatusCode::BAD_GATEWAY, e.to_string()))?;
        Ok(body
            .get("entries")
            .and_then(Value::as_array)
            .map(|entries| entries.iter().filter_map(node_from_json).collect())
            .unwrap_or_default())
    }

    async fn stat(&self, path: &str) -> Result<Option<OrgFsNode>, OrgFsError> {
        let url = self.url("stat", &[("path", path)]);
        let response = self
            .send(Method::GET, &url, json_accept_headers(), Bytes::new())
            .await?;
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !response.status().is_success() {
            return Err(Self::fail(response).await);
        }
        let body: Value = response
            .json()
            .await
            .map_err(|e| OrgFsError::new(StatusCode::BAD_GATEWAY, e.to_string()))?;
        Ok(body.get("entry").and_then(node_from_json))
    }

    async fn read(&self, path: &str) -> Result<Vec<u8>, OrgFsError> {
        let url = self.url("read", &[("path", path)]);
        let response = self
            .send(Method::GET, &url, HeaderMap::new(), Bytes::new())
            .await?;
        if !response.status().is_success() {
            return Err(Self::fail(response).await);
        }
        response
            .bytes()
            .await
            .map(|bytes| bytes.to_vec())
            .map_err(|e| OrgFsError::new(StatusCode::BAD_GATEWAY, e.to_string()))
    }

    async fn read_stream(
        &self,
        path: &str,
        range: Option<&str>,
    ) -> Result<Option<StreamedRead>, OrgFsError> {
        let url = self.url("read", &[("path", path), ("presign", "1")]);
        let presign = self
            .send(Method::GET, &url, json_accept_headers(), Bytes::new())
            .await?;
        if presign.status() == reqwest::StatusCode::NOT_FOUND {
            return Err(Self::fail(presign).await);
        }
        if !presign.status().is_success() {
            return Ok(None); // presign unavailable — buffered fallback
        }
        let Ok(body) = presign.json::<Value>().await else {
            return Ok(None);
        };
        let Some(signed) = body.get("url").and_then(Value::as_str) else {
            return Ok(None);
        };
        // Dev storage presigns to inline `data:` URLs (the whole base64
        // payload) — no push-down win there; the buffered path is cheaper.
        let lower = signed.to_ascii_lowercase();
        if !(lower.starts_with("http://") || lower.starts_with("https://")) {
            return Ok(None);
        }

        let mut request = Self::presign_client().get(signed);
        if let Some(range) = range {
            request = request.header(header::RANGE, range);
        }
        // A presigned host unreachable from THIS machine (a localhost MinIO
        // endpoint the studio can reach and the desktop cannot) falls back to
        // the buffered read rather than failing the transfer.
        let Ok(upstream) = request.send().await else {
            return Ok(None);
        };
        let status = StatusCode::from_u16(upstream.status().as_u16())
            .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
        if !matches!(
            status,
            StatusCode::OK | StatusCode::PARTIAL_CONTENT | StatusCode::RANGE_NOT_SATISFIABLE
        ) {
            return Ok(None); // expired/stale URL — the buffered path is authoritative
        }
        let content_length = upstream.headers().get(header::CONTENT_LENGTH).cloned();
        let content_range = upstream.headers().get(header::CONTENT_RANGE).cloned();
        Ok(Some(StreamedRead {
            status,
            content_length,
            content_range,
            body: Body::from_stream(upstream.bytes_stream()),
        }))
    }

    async fn write(
        &self,
        path: &str,
        body: Bytes,
        content_type: Option<&str>,
    ) -> Result<(), OrgFsError> {
        let url = self.url("file", &[("path", path)]);
        let mut headers = json_accept_headers();
        let content_type = content_type
            .and_then(|value| HeaderValue::from_str(value).ok())
            .unwrap_or_else(|| HeaderValue::from_static("application/octet-stream"));
        headers.insert(header::CONTENT_TYPE, content_type);
        let response = self.send(Method::PUT, &url, headers, body).await?;
        if !response.status().is_success() {
            return Err(Self::fail(response).await);
        }
        Ok(())
    }

    async fn mkdir(&self, path: &str) -> Result<(), OrgFsError> {
        let url = self.url("dir", &[("path", path)]);
        let response = self
            .send(Method::POST, &url, json_accept_headers(), Bytes::new())
            .await?;
        if !response.status().is_success() {
            return Err(Self::fail(response).await);
        }
        Ok(())
    }

    async fn remove(&self, path: &str) -> Result<(), OrgFsError> {
        let url = self.url("file", &[("path", path)]);
        let response = self
            .send(Method::DELETE, &url, json_accept_headers(), Bytes::new())
            .await?;
        if !response.status().is_success() {
            return Err(Self::fail(response).await);
        }
        Ok(())
    }

    async fn rename(&self, from: &str, to: &str) -> Result<(), OrgFsError> {
        let url = self.url("move", &[]);
        let mut headers = json_accept_headers();
        headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/json"),
        );
        let body = Bytes::from(
            serde_json::to_vec(&serde_json::json!({ "from": from, "to": to }))
                .map_err(|e| OrgFsError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?,
        );
        let response = self.send(Method::POST, &url, headers, body).await?;
        if !response.status().is_success() {
            return Err(Self::fail(response).await);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn urls_encode_the_org_volume_and_path() {
        let fs = UpstreamOrgFs::new("acme corp", "public-skills");
        assert_eq!(
            fs.url("list", &[("path", "my docs/a+b.md")]),
            "/api/acme%20corp/fs/public-skills/list?path=my%20docs%2Fa%2Bb.md"
        );
        assert_eq!(
            fs.url("move", &[]),
            "/api/acme%20corp/fs/public-skills/move"
        );
        assert_eq!(
            fs.url("read", &[("path", ""), ("presign", "1")]),
            "/api/acme%20corp/fs/public-skills/read?path=&presign=1"
        );
    }

    #[test]
    fn node_from_json_maps_the_contract_entry_shape() {
        let node = node_from_json(&json!({
            "path": "docs/a.md",
            "kind": "file",
            "size": 42,
            "updatedAt": "2023-11-14T22:13:20.000Z",
        }))
        .expect("valid entry");
        assert_eq!(
            node,
            OrgFsNode {
                path: "docs/a.md".to_string(),
                is_dir: false,
                size: 42,
                updated_at_secs: 1_700_000_000,
            }
        );

        let dir = node_from_json(&json!({ "path": "docs", "kind": "dir", "size": 0 }))
            .expect("valid dir entry");
        assert!(dir.is_dir);
        // A missing/unparseable `updatedAt` falls back to now, never to 1970 —
        // rclone treats a 1970 mtime as "older than everything" and re-syncs.
        assert!(dir.updated_at_secs > 1_700_000_000);
    }

    #[test]
    fn node_from_json_rejects_an_entry_without_a_path() {
        assert!(node_from_json(&json!({ "kind": "file" })).is_none());
    }

    #[test]
    fn upstream_call_errors_map_to_401_and_502() {
        let unauthorized: OrgFsError = UpstreamCallError::NotSignedIn.into();
        assert_eq!(unauthorized.status, StatusCode::UNAUTHORIZED);
        let unreachable: OrgFsError = UpstreamCallError::Unreachable("boom".to_string()).into();
        assert_eq!(unreachable.status, StatusCode::BAD_GATEWAY);
        assert_eq!(unreachable.message, "boom");
    }
}
