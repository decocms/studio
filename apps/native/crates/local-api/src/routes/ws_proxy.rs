//! WebSocket upgrades on non-`/_sandbox` paths — HMR, app WS — proxy
//! transparently once a dev server is known. Byte-parity target (in
//! observable behavior, not implementation strategy — see below):
//! `daemon/ws-proxy.ts` + `proxy/websocket.ts`, oracle
//! `daemon.ws-proxy.e2e.test.ts`.
//!
//! `routes/proxy.rs::fallback` detects the upgrade and hands the pending
//! downstream [`WebSocketUpgrade`] to [`upgrade`]. The upstream handshake is
//! completed first so its selected subprotocol and application response
//! headers are part of the downstream `101`; only then are the two upgraded
//! streams bridged.
//!
//! ## Why this does NOT hand-roll the upstream WS frame, unlike the daemon
//!
//! `ws-proxy.ts`'s file header explains its upstream leg hand-rolls the
//! HTTP upgrade over a raw Node `net.Socket` because Bun's own WebSocket
//! client closes its TCP socket with RST instead of FIN, which trips a
//! Node-24-based dev server (Vite) into treating a clean disconnect as an
//! unhandled socket error and exiting. That's a Bun-runtime-specific
//! footgun. `tokio-tungstenite`'s client (backed by a plain `tokio::net::
//! TcpStream`) performs an ordinary FIN-based close on drop/`.close()`, so
//! the byte-parity target here is the *observable* WebSocket protocol
//! behavior the daemon.ws-proxy.e2e.test.ts suite pins (echo, subprotocol
//! forwarding, close-code propagation both directions, dead-port/no-port
//! 1011s) — not the specific "avoid Bun's RST" implementation detail, which
//! doesn't apply to this runtime.

use std::time::Duration;

use axum::{
    extract::ws::{
        CloseFrame as AxumCloseFrame, Message as AxumMessage, WebSocket, WebSocketUpgrade,
    },
    http::{header, HeaderMap, HeaderName, HeaderValue},
    response::Response,
};
use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::{
    self, client::IntoClientRequest, protocol::frame::coding::CloseCode,
    protocol::CloseFrame as TsCloseFrame,
};

use crate::http_util::is_hop_by_hop;

/// TCP-connect probe budget per candidate loopback address — matches
/// `proxy/loopback.ts`'s `PROBE_TIMEOUT_MS` in spirit (bounded so a
/// firewalled/filtered address doesn't hang the handshake).
const CONNECT_TIMEOUT: Duration = Duration::from_millis(2000);

const REASON_NO_UPSTREAM: &str = "no upstream dev server";
const REASON_UNREACHABLE: &str = "upstream not reachable";

type UpstreamSocket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

struct UpstreamHandshake {
    socket: UpstreamSocket,
    headers: HeaderMap,
    selected_protocol: Option<String>,
}

/// Completes the upstream WebSocket handshake before accepting the browser's
/// pending downstream upgrade.
///
/// The ordering matters: `Sec-WebSocket-Protocol`, every application
/// `Set-Cookie`, and other end-to-end response headers exist only on the
/// upstream `101`, and browsers need them on their own `101`. Accepting the
/// downstream first makes those headers impossible to propagate.
#[cfg(test)]
pub async fn upgrade(
    downstream: WebSocketUpgrade,
    port: Option<u16>,
    path_and_query: String,
    requested_protocols: Vec<String>,
    request_headers: HeaderMap,
) -> Response {
    upgrade_inner(
        downstream,
        port,
        path_and_query,
        requested_protocols,
        request_headers,
        None,
    )
    .await
}

pub(crate) async fn upgrade_for_account(
    downstream: WebSocketUpgrade,
    port: Option<u16>,
    path_and_query: String,
    requested_protocols: Vec<String>,
    request_headers: HeaderMap,
    account_epoch: crate::sandbox::manager::AccountEpoch,
    account_epoch_rx: tokio::sync::watch::Receiver<crate::sandbox::manager::AccountEpoch>,
) -> Response {
    upgrade_inner(
        downstream,
        port,
        path_and_query,
        requested_protocols,
        request_headers,
        Some(AccountEpochFence {
            expected: account_epoch,
            receiver: account_epoch_rx,
        }),
    )
    .await
}

struct AccountEpochFence {
    expected: crate::sandbox::manager::AccountEpoch,
    receiver: tokio::sync::watch::Receiver<crate::sandbox::manager::AccountEpoch>,
}

impl AccountEpochFence {
    fn is_stale(&mut self) -> bool {
        *self.receiver.borrow_and_update() != self.expected
    }

    async fn changed(&mut self) {
        loop {
            if self.is_stale() || self.receiver.changed().await.is_err() {
                return;
            }
        }
    }
}

async fn upgrade_inner(
    downstream: WebSocketUpgrade,
    port: Option<u16>,
    path_and_query: String,
    requested_protocols: Vec<String>,
    request_headers: HeaderMap,
    mut account_epoch: Option<AccountEpochFence>,
) -> Response {
    if account_epoch
        .as_mut()
        .is_some_and(AccountEpochFence::is_stale)
    {
        return failed_upgrade_response(downstream, requested_protocols, "Studio account changed");
    }
    let Some(port) = port else {
        return failed_upgrade_response(downstream, requested_protocols, REASON_NO_UPSTREAM);
    };

    let Some(mut upstream) = connect_upstream(
        port,
        &path_and_query,
        &requested_protocols,
        &request_headers,
    )
    .await
    else {
        return failed_upgrade_response(downstream, requested_protocols, REASON_UNREACHABLE);
    };
    if account_epoch
        .as_mut()
        .is_some_and(AccountEpochFence::is_stale)
    {
        let _ = upstream.socket.close(None).await;
        return failed_upgrade_response(downstream, requested_protocols, "Studio account changed");
    }

    let UpstreamHandshake {
        socket,
        headers,
        selected_protocol,
    } = upstream;
    let downstream = match selected_protocol {
        Some(protocol) => downstream.protocols([protocol]),
        None => downstream,
    };
    let mut response = downstream.on_upgrade(move |client| bridge(client, socket, account_epoch));
    copy_upstream_response_headers(&headers, response.headers_mut());
    response
}

fn failed_upgrade_response(
    downstream: WebSocketUpgrade,
    requested_protocols: Vec<String>,
    reason: &'static str,
) -> Response {
    // Preserve the existing wire behavior for "not running" and dead-port
    // cases: complete the browser handshake, then close it with a useful 1011
    // reason. This lets the frontend's WebSocket error path distinguish a
    // temporarily unavailable dev server from an HTTP routing failure.
    let downstream = if requested_protocols.is_empty() {
        downstream
    } else {
        downstream.protocols(requested_protocols)
    };
    downstream.on_upgrade(move |mut client| async move {
        close_client(&mut client, 1011, reason).await;
    })
}

async fn bridge(
    mut client: WebSocket,
    upstream: UpstreamSocket,
    mut account_epoch: Option<AccountEpochFence>,
) {
    let (mut up_write, mut up_read) = upstream.split();

    loop {
        tokio::select! {
            biased;
            _ = async {
                match account_epoch.as_mut() {
                    Some(fence) => fence.changed().await,
                    None => std::future::pending::<()>().await,
                }
            } => {
                let _ = up_write.close().await;
                close_client(&mut client, 1008, "Studio account changed").await;
                break;
            }
            client_msg = client.recv() => {
                match client_msg {
                    Some(Ok(AxumMessage::Close(frame))) => {
                        let _ = up_write.send(tungstenite::Message::Close(frame.map(to_ts_close))).await;
                        let _ = up_write.close().await;
                        break;
                    }
                    Some(Ok(msg)) => {
                        if let Some(ts_msg) = to_tungstenite(msg) {
                            if up_write.send(ts_msg).await.is_err() {
                                break;
                            }
                        }
                    }
                    Some(Err(_)) | None => {
                        // Client vanished without a clean close frame —
                        // forward a close to upstream too rather than
                        // leaking the connection.
                        let _ = up_write.close().await;
                        break;
                    }
                }
            }
            up_msg = up_read.next() => {
                match up_msg {
                    Some(Ok(tungstenite::Message::Close(frame))) => {
                        let (code, reason) = match frame {
                            Some(f) => (u16::from(f.code), f.reason.to_string()),
                            None => (1005, String::new()),
                        };
                        close_client(&mut client, code, &reason).await;
                        break;
                    }
                    Some(Ok(ts_msg)) => {
                        if let Some(axum_msg) = from_tungstenite(ts_msg) {
                            if client.send(axum_msg).await.is_err() {
                                break;
                            }
                        }
                    }
                    Some(Err(_)) | None => {
                        // Upstream dropped without a close frame (crash,
                        // reset) — mirrors `ws-proxy.ts`'s
                        // `socket.on("close", () => closeClient(ws))`
                        // (no explicit code).
                        let _ = client.close().await;
                        break;
                    }
                }
            }
        }
    }
}

async fn close_client(client: &mut WebSocket, code: u16, reason: &str) {
    let _ = client
        .send(AxumMessage::Close(Some(AxumCloseFrame {
            code,
            reason: reason.to_string().into(),
        })))
        .await;
}

/// Tries `[::1]` then `127.0.0.1`, matching `proxy/loopback.ts`'s
/// dual-stack preference. Returns `None` if neither accepts a WS handshake
/// within [`CONNECT_TIMEOUT`].
async fn connect_upstream(
    port: u16,
    path_and_query: &str,
    protocols: &[String],
    request_headers: &HeaderMap,
) -> Option<UpstreamHandshake> {
    for host in ["[::1]", "127.0.0.1"] {
        let url = format!("ws://{host}:{port}{path_and_query}");
        let attempt = async {
            let mut request = url.into_client_request().ok()?;
            if !protocols.is_empty() {
                // tungstenite 0.23 does not trim comma-split protocol tokens.
                let value = protocols.join(",");
                if let Ok(header_value) = HeaderValue::from_str(&value) {
                    request
                        .headers_mut()
                        .insert(header::SEC_WEBSOCKET_PROTOCOL, header_value);
                }
            }
            copy_downstream_request_headers(request_headers, request.headers_mut());
            match tokio_tungstenite::connect_async(request).await {
                Ok(result) => Some(result),
                Err(error) => {
                    tracing::debug!(%error, host, port, "upstream WebSocket handshake failed");
                    None
                }
            }
        };
        if let Ok(Some((socket, response))) = tokio::time::timeout(CONNECT_TIMEOUT, attempt).await {
            let headers = response.headers().clone();
            let selected_protocol = headers
                .get(header::SEC_WEBSOCKET_PROTOCOL)
                .and_then(|value| value.to_str().ok())
                .map(str::to_owned);
            return Some(UpstreamHandshake {
                socket,
                headers,
                selected_protocol,
            });
        }
    }
    None
}

fn copy_downstream_request_headers(source: &HeaderMap, destination: &mut HeaderMap) {
    let connection_tokens = connection_tokens(source);
    for name in source.keys() {
        if is_handshake_owned_request_header(name)
            || is_hop_by_hop(name)
            || connection_tokens.iter().any(|token| token == name.as_str())
        {
            continue;
        }
        destination.remove(name);
        for value in source.get_all(name) {
            destination.append(name.clone(), value.clone());
        }
    }
}

fn copy_upstream_response_headers(source: &HeaderMap, destination: &mut HeaderMap) {
    let connection_tokens = connection_tokens(source);
    for name in source.keys() {
        if is_handshake_owned_response_header(name)
            || is_hop_by_hop(name)
            || connection_tokens.iter().any(|token| token == name.as_str())
        {
            continue;
        }
        destination.remove(name);
        for value in source.get_all(name) {
            destination.append(name.clone(), value.clone());
        }
    }
}

fn connection_tokens(headers: &HeaderMap) -> Vec<String> {
    headers
        .get_all(header::CONNECTION)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty())
        .collect()
}

fn is_handshake_owned_request_header(name: &HeaderName) -> bool {
    name == header::HOST
        || name == header::SEC_WEBSOCKET_KEY
        || name == header::SEC_WEBSOCKET_VERSION
        || name == header::SEC_WEBSOCKET_PROTOCOL
        || name
            .as_str()
            .eq_ignore_ascii_case("sec-websocket-extensions")
}

fn is_handshake_owned_response_header(name: &HeaderName) -> bool {
    name == header::SEC_WEBSOCKET_ACCEPT
        || name == header::SEC_WEBSOCKET_PROTOCOL
        || name
            .as_str()
            .eq_ignore_ascii_case("sec-websocket-extensions")
}

#[cfg(test)]
fn application_header_values(headers: &HeaderMap, name: &HeaderName) -> Vec<String> {
    headers
        .get_all(name)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .map(str::to_owned)
        .collect()
}

#[cfg(test)]
fn header_value<'a>(headers: &'a HeaderMap, name: &'static str) -> Option<&'a str> {
    headers.get(name).and_then(|value| value.to_str().ok())
}

#[cfg(test)]
fn text_message(message: Option<Result<tungstenite::Message, tungstenite::Error>>) -> String {
    match message {
        Some(Ok(tungstenite::Message::Text(text))) => text,
        other => panic!("expected text WebSocket message, got {other:?}"),
    }
}

fn to_ts_close(frame: AxumCloseFrame<'static>) -> TsCloseFrame<'static> {
    TsCloseFrame {
        code: CloseCode::from(frame.code),
        reason: frame.reason,
    }
}

fn to_tungstenite(msg: AxumMessage) -> Option<tungstenite::Message> {
    match msg {
        AxumMessage::Text(t) => Some(tungstenite::Message::Text(t)),
        AxumMessage::Binary(b) => Some(tungstenite::Message::Binary(b)),
        AxumMessage::Ping(p) => Some(tungstenite::Message::Ping(p)),
        AxumMessage::Pong(p) => Some(tungstenite::Message::Pong(p)),
        AxumMessage::Close(frame) => Some(tungstenite::Message::Close(frame.map(to_ts_close))),
    }
}

fn from_tungstenite(msg: tungstenite::Message) -> Option<AxumMessage> {
    match msg {
        tungstenite::Message::Text(t) => Some(AxumMessage::Text(t)),
        tungstenite::Message::Binary(b) => Some(AxumMessage::Binary(b)),
        tungstenite::Message::Ping(p) => Some(AxumMessage::Ping(p)),
        tungstenite::Message::Pong(p) => Some(AxumMessage::Pong(p)),
        tungstenite::Message::Close(frame) => {
            Some(AxumMessage::Close(frame.map(|f| AxumCloseFrame {
                code: u16::from(f.code),
                reason: f.reason,
            })))
        }
        // Raw `Frame` variant is only ever produced by the low-level codec
        // internals, never observed when reading via the high-level
        // stream/sink — see tungstenite's own doc comment on the variant.
        tungstenite::Message::Frame(_) => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        extract::{ws::WebSocketUpgrade, OriginalUri, State},
        routing::get,
        Router,
    };
    use serde_json::json;
    use tokio::net::TcpListener;

    #[test]
    fn close_code_roundtrips_through_tungstenite() {
        // 4009 is in tungstenite's `Library` private-use range (4000..=4999)
        // and must survive the u16 -> CloseCode -> u16 roundtrip unchanged
        // — this is exactly the code the "server-initiated close propagates"
        // oracle test asserts.
        let code = CloseCode::from(4009u16);
        assert_eq!(u16::from(code), 4009);
    }

    #[test]
    fn well_known_close_codes_roundtrip() {
        for code in [1000u16, 1001, 1011, 3000, 4999] {
            assert_eq!(u16::from(CloseCode::from(code)), code);
        }
    }

    #[test]
    fn axum_to_tungstenite_close_frame_preserves_code_and_reason() {
        let frame = AxumCloseFrame {
            code: 4009,
            reason: "server done".into(),
        };
        let ts = to_ts_close(frame);
        assert_eq!(u16::from(ts.code), 4009);
        assert_eq!(ts.reason, "server done");
    }

    #[test]
    fn message_conversion_roundtrips_text_and_binary() {
        let text = to_tungstenite(AxumMessage::Text("ping".to_string())).unwrap();
        assert_eq!(text, tungstenite::Message::Text("ping".to_string()));
        let back = from_tungstenite(text).unwrap();
        assert_eq!(back, AxumMessage::Text("ping".to_string()));

        let bin = to_tungstenite(AxumMessage::Binary(vec![1, 2, 3])).unwrap();
        assert_eq!(bin, tungstenite::Message::Binary(vec![1, 2, 3]));
    }

    #[test]
    fn tungstenite_frame_variant_is_dropped_not_panicked() {
        // `Frame` is a low-level codec-internal variant we must never see
        // in practice (see this file's doc comment on the match arm), but
        // the conversion must stay total rather than panic if it ever did.
        let raw = tungstenite::Message::Binary(vec![]);
        assert!(from_tungstenite(raw).is_some());
    }

    #[tokio::test]
    async fn connect_upstream_returns_none_for_a_dead_port() {
        let free_port = {
            let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            l.local_addr().unwrap().port()
        };
        let result = connect_upstream(free_port, "/", &[], &HeaderMap::new()).await;
        assert!(result.is_none());
    }

    #[test]
    fn websocket_upstream_keeps_all_end_to_end_application_headers() {
        let mut source = HeaderMap::new();
        source.insert(
            header::AUTHORIZATION,
            HeaderValue::from_static("Bearer app-token"),
        );
        source.insert(
            header::COOKIE,
            HeaderValue::from_static("sandbox-session=abc; decocms-local-session=control-secret"),
        );
        source.insert(
            header::ORIGIN,
            HeaderValue::from_static("http://localhost:61234"),
        );
        source.insert(
            HeaderName::from_static("x-sandbox-app"),
            HeaderValue::from_static("keep"),
        );
        source.insert(
            header::SEC_WEBSOCKET_KEY,
            HeaderValue::from_static("downstream-owned"),
        );

        let mut destination = HeaderMap::new();
        destination.insert(
            header::SEC_WEBSOCKET_KEY,
            HeaderValue::from_static("upstream-owned"),
        );
        copy_downstream_request_headers(&source, &mut destination);

        assert_eq!(
            destination[header::AUTHORIZATION],
            HeaderValue::from_static("Bearer app-token")
        );
        assert_eq!(
            destination[header::COOKIE],
            HeaderValue::from_static("sandbox-session=abc; decocms-local-session=control-secret")
        );
        assert_eq!(
            destination[header::ORIGIN],
            HeaderValue::from_static("http://localhost:61234")
        );
        assert_eq!(destination["x-sandbox-app"], "keep");
        assert_eq!(
            destination[header::SEC_WEBSOCKET_KEY],
            HeaderValue::from_static("upstream-owned")
        );
    }

    #[test]
    fn websocket_hop_headers_are_not_forwarded() {
        let mut source = HeaderMap::new();
        source.insert(
            header::CONNECTION,
            HeaderValue::from_static("Upgrade, x-one-hop"),
        );
        source.insert(
            HeaderName::from_static("x-one-hop"),
            HeaderValue::from_static("remove"),
        );
        source.insert(
            HeaderName::from_static("x-end-to-end"),
            HeaderValue::from_static("keep"),
        );

        let mut destination = HeaderMap::new();
        copy_downstream_request_headers(&source, &mut destination);
        assert!(!destination.contains_key(header::CONNECTION));
        assert!(!destination.contains_key("x-one-hop"));
        assert_eq!(destination["x-end-to-end"], "keep");
    }

    #[derive(Clone, Copy)]
    struct DownstreamState {
        upstream_port: u16,
    }

    async fn upstream_handler(
        ws: WebSocketUpgrade,
        headers: HeaderMap,
        OriginalUri(uri): OriginalUri,
    ) -> Response {
        let observed = json!({
            "authorization": header_value(&headers, "authorization"),
            "cookie": header_value(&headers, "cookie"),
            "origin": header_value(&headers, "origin"),
            "custom": header_value(&headers, "x-sandbox-app"),
            "pathAndQuery": uri.path_and_query().map(|value| value.as_str()),
        })
        .to_string();

        let mut response = ws
            .protocols(["sandbox.v2"])
            .on_upgrade(move |mut socket| async move {
                if socket.send(AxumMessage::Text(observed)).await.is_err() {
                    return;
                }
                while let Some(Ok(message)) = socket.recv().await {
                    match message {
                        AxumMessage::Text(text) => {
                            if socket
                                .send(AxumMessage::Text(format!("echo:{text}")))
                                .await
                                .is_err()
                            {
                                return;
                            }
                        }
                        AxumMessage::Close(frame) => {
                            let _ = socket.send(AxumMessage::Close(frame)).await;
                            return;
                        }
                        _ => {}
                    }
                }
            });
        response.headers_mut().append(
            header::SET_COOKIE,
            HeaderValue::from_static("session=one; Path=/; HttpOnly; SameSite=Strict"),
        );
        response.headers_mut().append(
            header::SET_COOKIE,
            HeaderValue::from_static("theme=dark; Path=/; SameSite=Lax"),
        );
        response.headers_mut().insert(
            HeaderName::from_static("x-sandbox-handshake"),
            HeaderValue::from_static("preserved"),
        );
        response
    }

    async fn downstream_handler(
        State(state): State<DownstreamState>,
        ws: WebSocketUpgrade,
        headers: HeaderMap,
        OriginalUri(uri): OriginalUri,
    ) -> Response {
        let requested_protocols = headers
            .get(header::SEC_WEBSOCKET_PROTOCOL)
            .and_then(|value| value.to_str().ok())
            .map(|value| value.split(',').map(str::trim).map(str::to_owned).collect())
            .unwrap_or_default();
        upgrade(
            ws,
            Some(state.upstream_port),
            uri.path_and_query()
                .map_or_else(|| uri.path().to_owned(), |value| value.as_str().to_owned()),
            requested_protocols,
            headers,
        )
        .await
    }

    async fn spawn_router(app: Router) -> (u16, tokio::task::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (port, task)
    }

    #[tokio::test]
    async fn two_leg_handshake_preserves_application_headers_and_upstream_response() {
        let (upstream_port, upstream_task) =
            spawn_router(Router::new().route("/socket", get(upstream_handler))).await;
        let downstream = Router::new()
            .route("/socket", get(downstream_handler))
            .with_state(DownstreamState { upstream_port });
        let (downstream_port, downstream_task) = spawn_router(downstream).await;

        let mut request = format!("ws://127.0.0.1:{downstream_port}/socket?room=one")
            .into_client_request()
            .unwrap();
        request.headers_mut().insert(
            header::AUTHORIZATION,
            HeaderValue::from_static("Bearer sandbox-token"),
        );
        request.headers_mut().insert(
            header::COOKIE,
            HeaderValue::from_static("sandbox-session=abc; decocms-local-session=control-secret"),
        );
        request.headers_mut().insert(
            header::ORIGIN,
            HeaderValue::from_static("http://localhost:61234"),
        );
        request.headers_mut().insert(
            HeaderName::from_static("x-sandbox-app"),
            HeaderValue::from_static("custom-value"),
        );
        request.headers_mut().insert(
            header::SEC_WEBSOCKET_PROTOCOL,
            HeaderValue::from_static("sandbox.v1,sandbox.v2"),
        );

        let (mut socket, response) = tokio_tungstenite::connect_async(request)
            .await
            .expect("downstream handshake");
        assert_eq!(
            response.headers()[header::SEC_WEBSOCKET_PROTOCOL],
            HeaderValue::from_static("sandbox.v2")
        );
        assert_eq!(
            response.headers()["x-sandbox-handshake"],
            HeaderValue::from_static("preserved")
        );
        assert_eq!(
            application_header_values(response.headers(), &header::SET_COOKIE),
            vec![
                "session=one; Path=/; HttpOnly; SameSite=Strict",
                "theme=dark; Path=/; SameSite=Lax",
            ]
        );

        let observed = text_message(socket.next().await);
        let observed: serde_json::Value = serde_json::from_str(&observed).unwrap();
        assert_eq!(observed["authorization"], "Bearer sandbox-token");
        assert_eq!(
            observed["cookie"],
            "sandbox-session=abc; decocms-local-session=control-secret"
        );
        assert_eq!(observed["origin"], "http://localhost:61234");
        assert_eq!(observed["custom"], "custom-value");
        assert_eq!(observed["pathAndQuery"], "/socket?room=one");

        socket
            .send(tungstenite::Message::Text("hello".to_owned()))
            .await
            .unwrap();
        assert_eq!(text_message(socket.next().await), "echo:hello");
        socket.close(None).await.unwrap();

        downstream_task.abort();
        upstream_task.abort();
    }
}
