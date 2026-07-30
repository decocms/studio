//! Dynamic OAuth client registration (`POST /api/auth/mcp/register`).
//!
//! Port of `apps/api/src/cli/commands/auth/login.ts::registerClient`. Like
//! the CLI, this registers a FRESH client on every login: the loopback
//! redirect_uri's ephemeral port varies run-to-run, and the upstream's
//! Better Auth MCP provider does EXACT redirect_uri matching (it does NOT
//! implement RFC 8252 §7.3 loopback-any-port flexibility — verified against
//! studio.decocms.com, which rejects an authorize whose redirect_uri port
//! differs from the one a client was registered with: `INVALID_REDIRECT_URI`).
//! A per-login registration is one cheap unauthenticated round trip and is
//! the only correct behavior against an exact-matching server — an earlier
//! cross-login `client_id` cache here was the direct cause of that error and
//! has been removed.
//!
//! The `client_id` is NOT a secret (`token_endpoint_auth_method: "none"` — a
//! public/native client per RFC 8252), so nothing here is persisted.

/// `client_name` sent on every registration — distinguishes this app's
/// registrations from the CLI's (`"decocms-cli"`, `login.ts`) in any
/// server-side client list a user or admin might inspect.
const CLIENT_NAME: &str = "deco";

#[derive(Debug, thiserror::Error)]
pub enum RegisterError {
    #[error("network error registering OAuth client: {0}")]
    Network(String),
    #[error("client registration failed: HTTP {0} {1}")]
    Rejected(u16, String),
    #[error("client registration response had no client_id")]
    NoClientId,
}

#[derive(Debug, serde::Deserialize)]
struct RegisterResponse {
    client_id: String,
}

/// `POST {target}/api/auth/mcp/register` — byte-parity request body with
/// `login.ts::registerClient` (same fields/values), except `client_name`
/// (see module doc).
pub async fn register_client(
    http: &reqwest::Client,
    target: &str,
    redirect_uri: &str,
) -> Result<String, RegisterError> {
    let res = http
        .post(format!("{target}/api/auth/mcp/register"))
        .json(&serde_json::json!({
            "client_name": CLIENT_NAME,
            "redirect_uris": [redirect_uri],
            "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"],
            "token_endpoint_auth_method": "none",
            "application_type": "native",
        }))
        .send()
        .await
        .map_err(|e| RegisterError::Network(e.to_string()))?;

    if !res.status().is_success() {
        let status = res.status().as_u16();
        let body = res.text().await.unwrap_or_default();
        return Err(RegisterError::Rejected(status, body));
    }

    let data: RegisterResponse = res.json().await.map_err(|_| RegisterError::NoClientId)?;
    if data.client_id.is_empty() {
        return Err(RegisterError::NoClientId);
    }
    Ok(data.client_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{routing::post, Json, Router};
    use tokio::net::TcpListener;

    #[tokio::test]
    async fn register_client_posts_native_public_client_shape_and_returns_id() {
        let app = Router::new().route(
            "/api/auth/mcp/register",
            post(|body: axum::body::Bytes| async move {
                let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
                assert_eq!(v["client_name"], "deco");
                assert_eq!(v["token_endpoint_auth_method"], "none");
                assert_eq!(v["application_type"], "native");
                assert_eq!(v["redirect_uris"][0], "http://127.0.0.1:9/");
                Json(serde_json::json!({"client_id": "client_xyz"}))
            }),
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        let http = reqwest::Client::new();
        let client_id = register_client(&http, &format!("http://{addr}"), "http://127.0.0.1:9/")
            .await
            .unwrap();
        assert_eq!(client_id, "client_xyz");
    }

    #[tokio::test]
    async fn register_client_surfaces_rejection_status_and_body() {
        let app = Router::new().route(
            "/api/auth/mcp/register",
            post(|| async { (axum::http::StatusCode::BAD_REQUEST, "invalid redirect_uri") }),
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        let http = reqwest::Client::new();
        let err = register_client(&http, &format!("http://{addr}"), "http://127.0.0.1:9/")
            .await
            .unwrap_err();
        match err {
            RegisterError::Rejected(status, body) => {
                assert_eq!(status, 400);
                assert!(body.contains("invalid redirect_uri"));
            }
            other => panic!("expected Rejected, got {other:?}"),
        }
    }
}
