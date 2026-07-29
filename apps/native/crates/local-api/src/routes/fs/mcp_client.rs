//! A minimal MCP Streamable HTTP client — just enough to run the
//! `initialize` -> `notifications/initialized` -> `tools/list` (paginated)
//! sequence that `packages/sandbox/daemon/tools-catalog.ts::fetchToolCatalog`
//! runs via `@modelcontextprotocol/sdk`'s `StreamableHTTPClientTransport` /
//! `Client`. There's no MCP SDK crate in this workspace's dependency table
//! (`apps/native/Cargo.toml` is a shared file — adding one is an interface
//! request, not a local edit), so this hand-rolls the wire protocol:
//! JSON-RPC 2.0 over HTTP POST, `mcp-session-id` header propagation once
//! the server hands one out, and the two response shapes the SDK's
//! `WebStandardStreamableHTTPServerTransport` can return (a direct
//! `application/json` body, or one `text/event-stream` frame carrying the
//! same JSON-RPC envelope — see that file's `handlePostRequest`/`send`).
//!
//! Deliberately NOT a general MCP client: no resumable-stream reconnection,
//! no auth-provider/OAuth flow (the endpoint's bearer already lives in
//! `headers`, forwarded verbatim), no batched requests. Those exist in the
//! SDK because the client is used for the whole shape of the protocol; we
//! only ever need one page-turning read-only call.

use std::time::Duration;

use reqwest::header::{HeaderMap, HeaderName, HeaderValue, ACCEPT, CONTENT_TYPE};
use serde_json::{json, Map, Value};

use super::tools_catalog::CatalogTool;

/// `LATEST_PROTOCOL_VERSION` in `@modelcontextprotocol/sdk`'s `types.ts`.
const PROTOCOL_VERSION: &str = "2025-11-25";
const CLIENT_NAME: &str = "local-api";
const CLIENT_VERSION: &str = env!("CARGO_PKG_VERSION");
/// Defensive cap on `tools/list` pagination — a misbehaving or malicious
/// endpoint returning an unbounded `nextCursor` chain must not hang this
/// request (which runs synchronously inside the `tools/sync` handler)
/// forever.
const MAX_PAGES: usize = 10_000;

#[derive(Debug)]
pub enum McpFetchError {
    /// Couldn't even talk to the endpoint (DNS/connect/timeout/TLS). Maps
    /// to the daemon's 502 "unreachable" response.
    Unreachable(String),
    /// Reached the endpoint but it didn't speak MCP correctly (bad
    /// JSON-RPC envelope, error response, unexpected status). Also a 502
    /// on the daemon side — `fetchToolCatalog` doesn't distinguish these
    /// either, it just throws and the route handler maps any throw to 502.
    Protocol(String),
}

impl std::fmt::Display for McpFetchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            McpFetchError::Unreachable(m) | McpFetchError::Protocol(m) => write!(f, "{m}"),
        }
    }
}

fn build_headers(extra: &Value) -> Result<HeaderMap, McpFetchError> {
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers.insert(
        ACCEPT,
        HeaderValue::from_static("application/json, text/event-stream"),
    );
    if let Value::Object(map) = extra {
        for (k, v) in map {
            let value_str = match v {
                Value::String(s) => s.clone(),
                other => other.to_string(),
            };
            let name = HeaderName::from_bytes(k.as_bytes())
                .map_err(|e| McpFetchError::Protocol(format!("invalid header name {k:?}: {e}")))?;
            let value = HeaderValue::from_str(&value_str).map_err(|e| {
                McpFetchError::Protocol(format!("invalid header value for {k:?}: {e}"))
            })?;
            headers.insert(name, value);
        }
    }
    Ok(headers)
}

/// Scans an SSE-framed body for the JSON-RPC message whose `id` matches
/// `want_id` — the `send()` implementation in
/// `WebStandardStreamableHTTPServerTransport` writes exactly one such
/// frame per request before closing the stream (`event: message\n[id:
/// ...\n]data: <json>\n\n`), so we don't need general SSE reconnection —
/// just parse every `data:` block in the (already-fully-buffered) response
/// text and return the one that matches.
fn parse_sse_json_rpc(body: &str, want_id: i64) -> Result<Value, McpFetchError> {
    let mut last: Option<Value> = None;
    for frame in body.split("\n\n") {
        let mut data_lines = Vec::new();
        for line in frame.lines() {
            if let Some(d) = line.strip_prefix("data:") {
                data_lines.push(d.strip_prefix(' ').unwrap_or(d));
            }
        }
        if data_lines.is_empty() {
            continue;
        }
        let data = data_lines.join("\n");
        if data.is_empty() {
            continue; // priming/keep-alive event — no payload
        }
        let Ok(parsed) = serde_json::from_str::<Value>(&data) else {
            continue;
        };
        if parsed.get("id").and_then(Value::as_i64) == Some(want_id) {
            return Ok(parsed);
        }
        last = Some(parsed);
    }
    last.ok_or_else(|| {
        McpFetchError::Protocol("no JSON-RPC message found in SSE response".to_string())
    })
}

struct Session {
    client: reqwest::Client,
    url: String,
    base_headers: Value,
    session_id: Option<String>,
    next_id: i64,
}

impl Session {
    fn new(url: String, headers: Value) -> Self {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(20))
            .connect_timeout(Duration::from_secs(10))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        Self {
            client,
            url,
            base_headers: headers,
            session_id: None,
            next_id: 1,
        }
    }

    async fn post(&mut self, body: &Value) -> Result<reqwest::Response, McpFetchError> {
        let mut headers = build_headers(&self.base_headers)?;
        if let Some(sid) = &self.session_id {
            let value = HeaderValue::from_str(sid)
                .map_err(|e| McpFetchError::Protocol(format!("invalid session id: {e}")))?;
            headers.insert(HeaderName::from_static("mcp-session-id"), value);
        }
        let payload = serde_json::to_vec(body)
            .map_err(|e| McpFetchError::Protocol(format!("failed to encode request: {e}")))?;
        let resp = self
            .client
            .post(&self.url)
            .headers(headers)
            .body(payload)
            .send()
            .await
            .map_err(|e| McpFetchError::Unreachable(e.to_string()))?;
        if let Some(sid) = resp
            .headers()
            .get("mcp-session-id")
            .and_then(|v| v.to_str().ok())
        {
            self.session_id = Some(sid.to_string());
        }
        Ok(resp)
    }

    /// A JSON-RPC request (carries `id`); returns the `result` value or an
    /// `McpFetchError` derived from an `error` envelope / transport
    /// failure.
    async fn request(&mut self, method: &str, params: Value) -> Result<Value, McpFetchError> {
        let id = self.next_id;
        self.next_id += 1;
        let body = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        let resp = self.post(&body).await?;
        let status = resp.status();
        let content_type = resp
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();
        let text = resp
            .text()
            .await
            .map_err(|e| McpFetchError::Unreachable(e.to_string()))?;
        if !status.is_success() {
            let snippet: String = text.chars().take(500).collect();
            return Err(McpFetchError::Protocol(format!(
                "{method} failed: HTTP {status}: {snippet}"
            )));
        }
        let message = if content_type.contains("text/event-stream") {
            parse_sse_json_rpc(&text, id)?
        } else {
            serde_json::from_str::<Value>(&text).map_err(|e| {
                McpFetchError::Protocol(format!("invalid JSON-RPC response to {method}: {e}"))
            })?
        };
        if let Some(err) = message.get("error") {
            return Err(McpFetchError::Protocol(format!(
                "{method} returned an error: {err}"
            )));
        }
        message
            .get("result")
            .cloned()
            .ok_or_else(|| McpFetchError::Protocol(format!("{method} response missing result")))
    }

    /// A JSON-RPC notification (no `id`); the server responds `202` with
    /// no body.
    async fn notify(&mut self, method: &str) -> Result<(), McpFetchError> {
        let body = json!({ "jsonrpc": "2.0", "method": method });
        let resp = self.post(&body).await?;
        let status = resp.status();
        let _ = resp.bytes().await;
        if !status.is_success() {
            return Err(McpFetchError::Protocol(format!(
                "notification {method} failed: HTTP {status}"
            )));
        }
        Ok(())
    }
}

/// Connect to a Virtual MCP endpoint and list its tools, following the
/// pagination cursor so large orgs aren't silently truncated to the first
/// page — byte-parity target: `tools-catalog.ts::fetchToolCatalog`.
pub async fn fetch_tool_catalog(
    url: &str,
    headers: &Value,
) -> Result<Vec<CatalogTool>, McpFetchError> {
    let mut session = Session::new(url.to_string(), headers.clone());
    session
        .request(
            "initialize",
            json!({
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": { "name": CLIENT_NAME, "version": CLIENT_VERSION },
            }),
        )
        .await?;
    session.notify("notifications/initialized").await?;

    let mut tools = Vec::new();
    let mut cursor: Option<String> = None;
    for _ in 0..MAX_PAGES {
        let mut params = Map::new();
        if let Some(c) = &cursor {
            params.insert("cursor".to_string(), Value::String(c.clone()));
        }
        let result = session.request("tools/list", Value::Object(params)).await?;
        let page_tools = result
            .get("tools")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        for t in page_tools {
            let Some(name) = t.get("name").and_then(Value::as_str) else {
                continue;
            };
            tools.push(CatalogTool {
                name: name.to_string(),
                description: t
                    .get("description")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                input_schema: t.get("inputSchema").cloned(),
                output_schema: t.get("outputSchema").cloned(),
            });
        }
        cursor = result
            .get("nextCursor")
            .and_then(Value::as_str)
            .map(str::to_string);
        if cursor.is_none() {
            break;
        }
    }
    Ok(tools)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_sse_json_rpc_extracts_matching_data_frame() {
        let body = "event: message\nid: 1\ndata: {\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"tools\":[]}}\n\n";
        let msg = parse_sse_json_rpc(body, 2).unwrap();
        assert_eq!(msg["result"]["tools"], json!([]));
    }

    #[test]
    fn parse_sse_json_rpc_skips_priming_events() {
        let body = "id: p1\ndata: \n\nevent: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}\n\n";
        let msg = parse_sse_json_rpc(body, 1).unwrap();
        assert_eq!(msg["id"], 1);
    }

    #[test]
    fn parse_sse_json_rpc_errors_on_no_data() {
        assert!(parse_sse_json_rpc("event: message\n\n", 1).is_err());
    }

    #[test]
    fn build_headers_rejects_non_object_extra() {
        let headers = build_headers(&json!(null)).unwrap();
        // Base headers still present; no panic on a non-object `extra`.
        assert!(headers.get(CONTENT_TYPE).is_some());
    }

    #[test]
    fn build_headers_forwards_string_values() {
        let headers = build_headers(&json!({"Authorization": "Bearer k"})).unwrap();
        assert_eq!(headers.get("authorization").unwrap(), "Bearer k");
    }
}
