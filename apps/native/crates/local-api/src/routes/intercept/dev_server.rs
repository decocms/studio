//! One reqwest→axum mirror for the intercept routes that talk STRAIGHT to a
//! sandbox's dev port (`preview-invoke`, `preview-fetch`) — server-side calls
//! with no browser involved, so none of the preview listener's cookie/origin
//! machinery applies. Exists so those mini forwarders cannot drift on the
//! parts that must stay identical: the 502 `Preview unreachable` refusals and
//! the status/`Content-Type`/body mirror.

use std::time::Duration;

use axum::body::Body;
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};

use crate::error::ApiError;

/// Both call sites build a fresh `reqwest::Client` per request with no
/// timeout of its own, so a dev server that accepted the connection and then
/// hung (starting up, wedged, deadlocked) would otherwise stall the native
/// API request indefinitely — there is no daemon-side watchdog for a
/// straight-to-dev-port call. 10s is generous for a same-machine loopback
/// hop.
const DEV_SERVER_TIMEOUT: Duration = Duration::from_secs(10);

/// Sends `request` to the dev server and mirrors its response back: status,
/// `Content-Type` (falling back to `default_content_type` when the dev server
/// sent none — `None` omits the header instead), and the full body. A send or
/// body-read failure — including a timeout — is the family's uniform 502
/// `Preview unreachable`.
pub(super) async fn send_and_mirror(
    request: reqwest::RequestBuilder,
    default_content_type: Option<HeaderValue>,
) -> Response {
    send_and_mirror_with_timeout(request, default_content_type, DEV_SERVER_TIMEOUT).await
}

async fn send_and_mirror_with_timeout(
    request: reqwest::RequestBuilder,
    default_content_type: Option<HeaderValue>,
    timeout: Duration,
) -> Response {
    let Ok(response) = request.timeout(timeout).send().await else {
        return ApiError::new(StatusCode::BAD_GATEWAY, "Preview unreachable").into_response();
    };
    let status =
        StatusCode::from_u16(response.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let content_type = response
        .headers()
        .get(header::CONTENT_TYPE)
        .cloned()
        .or(default_content_type);
    let Ok(bytes) = response.bytes().await else {
        return ApiError::new(StatusCode::BAD_GATEWAY, "Preview unreachable").into_response();
    };

    let mut res = Response::new(Body::from(bytes));
    *res.status_mut() = status;
    if let Some(content_type) = content_type {
        res.headers_mut().insert(header::CONTENT_TYPE, content_type);
    }
    res
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::routing::get;
    use tokio::net::TcpListener;

    async fn spawn_upstream(app: axum::Router) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        port
    }

    #[tokio::test]
    async fn mirrors_status_content_type_and_body() {
        let app = axum::Router::new().route(
            "/x",
            get(|| async {
                (
                    StatusCode::CREATED,
                    [
                        (header::CONTENT_TYPE, "text/plain"),
                        // Only Content-Type is mirrored; everything else the
                        // dev server sent stays on its side of the hop.
                        (header::SET_COOKIE, "a=1"),
                    ],
                    "payload",
                )
            }),
        );
        let port = spawn_upstream(app).await;

        let res = send_and_mirror(
            reqwest::Client::new().get(format!("http://127.0.0.1:{port}/x")),
            None,
        )
        .await;
        assert_eq!(res.status(), StatusCode::CREATED);
        assert_eq!(res.headers()[header::CONTENT_TYPE], "text/plain");
        assert!(res.headers().get(header::SET_COOKIE).is_none());
        let body = axum::body::to_bytes(res.into_body(), 1024).await.unwrap();
        assert_eq!(&body[..], b"payload");
    }

    #[tokio::test]
    async fn applies_the_default_content_type_only_when_upstream_sent_none() {
        let app = axum::Router::new().route(
            "/none",
            get(|| async {
                let mut response = Response::new(Body::from("{}"));
                response.headers_mut().remove(header::CONTENT_TYPE);
                response
            }),
        );
        let port = spawn_upstream(app).await;

        let default = Some(HeaderValue::from_static("application/json"));
        let res = send_and_mirror(
            reqwest::Client::new().get(format!("http://127.0.0.1:{port}/none")),
            default.clone(),
        )
        .await;
        assert_eq!(res.headers()[header::CONTENT_TYPE], "application/json");

        let res = send_and_mirror(
            reqwest::Client::new().get(format!("http://127.0.0.1:{port}/none")),
            None,
        )
        .await;
        assert!(res.headers().get(header::CONTENT_TYPE).is_none());
    }

    #[tokio::test]
    async fn a_dead_port_is_the_uniform_preview_unreachable_502() {
        let free_port = {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            listener.local_addr().unwrap().port()
        };
        let res = send_and_mirror(
            reqwest::Client::new().get(format!("http://127.0.0.1:{free_port}/x")),
            None,
        )
        .await;
        assert_eq!(res.status(), StatusCode::BAD_GATEWAY);
        let body = axum::body::to_bytes(res.into_body(), 1024).await.unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["error"], "Preview unreachable");
    }

    /// A dev server that accepts the connection and then never answers (still
    /// starting up, wedged) must not hang the native API request forever —
    /// it gets the same uniform 502 as a dead port, once the timeout fires.
    #[tokio::test]
    async fn a_hung_dev_server_times_out_as_preview_unreachable() {
        let app = axum::Router::new().route(
            "/slow",
            get(|| async {
                tokio::time::sleep(Duration::from_secs(60)).await;
                "too late"
            }),
        );
        let port = spawn_upstream(app).await;

        let res = send_and_mirror_with_timeout(
            reqwest::Client::new().get(format!("http://127.0.0.1:{port}/slow")),
            None,
            Duration::from_millis(50),
        )
        .await;
        assert_eq!(res.status(), StatusCode::BAD_GATEWAY);
        let body = axum::body::to_bytes(res.into_body(), 1024).await.unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["error"], "Preview unreachable");
    }
}
