//! Reverse-HTTP-proxy catch-all — ANY request to the PREVIEW listener lands
//! here (`router.rs`'s `build_preview`); this is the ONLY route that
//! listener serves. Byte-parity target: `daemon/proxy.ts`, oracle
//! `daemon.proxy.e2e.test.ts`.
//!
//! Moved off the MAIN listener (which used to serve this as its top-level
//! fallback for any path outside `/health`, `/_local/*`, `/_sandbox/*`, and
//! the app-API surface) onto its own dedicated loopback port — see
//! `lib.rs`/`router.rs`'s module docs for why: the app's own API and the
//! previewed dev server now need to be genuinely different origins.
//!
//! NO AUTH is applied to this family (byte-parity — the daemon doesn't gate
//! these either; this is the app-under-test being previewed, not the
//! control API). `router.rs`'s `build_preview` wires this as that router's
//! ONLY route, its top-level `.fallback()`, with no middleware stack at
//! all — do not add auth inside this handler; if that invariant ever needs
//! to change it's a `router.rs` change, not a change here. For the same
//! reason, the
//! placeholder pages below (no-upstream/starting/no-web-page/proxy-error)
//! carry the daemon's own `Access-Control-Allow-Origin: *` — byte-parity
//! with `daemon/proxy.ts`, and NOT a violation of
//! the native local-API contract's "no wildcard CORS" rule,
//! which scopes to the bearer-gated zone-2 surface (`cors.rs`) that this
//! family is explicitly excluded from.
//!
//! ## Dev-port resolution — sniffed port, per-handle routing
//!
//! The daemon's `getDevPort()` is `portSniffer.current() ?? application.port
//! ?? null` (`entry.ts`) — the sniffed port (from a spawned dev script's
//! stdout, `process/port-sniffer.ts`) wins over the statically configured
//! one. This crate's [`crate::setup::SetupOrchestrator`] already captures
//! that same sniffed port (`setup/dev.rs`'s `confirm_running` transitions
//! `lifecycle` to `{"phase":"running","port":<sniffed>,...}`) — the gap this
//! file used to have was never "no sniffed port exists," it was "this file
//! never reads `state.setup.lifecycle_snapshot()`," fixed by [`dev_port`]
//! below reading it first and falling back to the static `application.port`
//! only when the orchestrator hasn't reached `running` yet.
//!
//! Per the native Git-sandbox contract's preview section, a
//! git-backed thread's dev server runs under its OWN per-handle
//! `SandboxManager`-owned orchestrator, not the process-global one — so
//! there is no longer a SINGLE dev port for the whole process once more
//! than one sandbox handle is active. [`dev_port`] resolves which
//! orchestrator to read from a request header,
//! [`crate::sandbox::SANDBOX_HANDLE_HEADER`]
//! (`x-decocms-sandbox-handle`): present + a known handle -> that handle's
//! own `Sandbox.setup`/`Sandbox.config`; absent (or an unrecognized handle)
//! -> the plain global path, UNCHANGED from before this file's git-sandbox
//! work (byte-parity with "non-git threads keep today's behavior"). A path
//! prefix (`…/preview/<handle>/…`) was the other option the design doc
//! floated; a header was chosen because it doesn't require rewriting the
//! proxied request's path before forwarding it upstream. **Known gap**: the
//! webview/frontend side of actually SETTING this header on a preview
//! iframe's requests is not wired by this change (the existing preview URL
//! is computed server-side, via a different pipeline, for the single
//! process-global sandbox) — this file/[`crate::sandbox`] only implement
//! the backend capability; see the native Git-sandbox contract
//! for the follow-up this leaves.
//!
//! ## Testability
//!
//! The actual proxying logic is split out as `proxy_to_port`/`bridge_ws`,
//! which take an already-resolved `u16` port rather than reading
//! `AppState` — so this file's own unit tests can exercise HTML injection,
//! header stripping, and the placeholder-page branches end-to-end against a
//! real loopback `TcpListener` without needing the `config` family's
//! `POST /_sandbox/config` (still a 501 stub as of this writing) to be
//! implemented first.

use std::sync::Arc;
use std::time::Duration;

use axum::{
    body::Body,
    extract::{ws::WebSocketUpgrade, Extension, FromRequestParts, State},
    http::{header, HeaderMap, HeaderValue, Method, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde_json::{json, Value};

use super::ws_proxy;
use crate::http_util::strip_hop_by_hop_headers;
use crate::state::AppState;

type Request = axum::extract::Request;

/// Guards the *headers* phase of the upstream fetch only — mirrors
/// `proxy.ts`'s comment: "a hung dev server shouldn't pin a request slot
/// forever... once headers arrive we cancel the timer: SSE / NDJSON /
/// long-poll bodies must be allowed to stream indefinitely." Achieved here
/// by wrapping only the `.send()` future (which resolves once the response
/// status/headers are in) in `tokio::time::timeout`, never the subsequent
/// body stream.
const HEADERS_TIMEOUT: Duration = Duration::from_secs(60);

/// Generous but bounded — matches the daemon's unbounded `req.arrayBuffer()`
/// in spirit while keeping a single misbehaving client from parking an
/// unbounded allocation in this process (a desktop app's dev-preview proxy,
/// unlike the daemon's, has no surrounding cluster-level body-size guard).
const MAX_PROXY_BODY_BYTES: usize = 100 * 1024 * 1024;

const PREVIEW_COOKIE_SELFTEST_NAME: &str = "decocms-preview-selftest";

const NO_UPSTREAM_HTML: &str = r#"<!DOCTYPE html><html><head><meta charset="utf-8"><title>No dev server</title><style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#fafafa;color:#555}div{text-align:center;max-width:420px;padding:24px}h3{margin:0 0 8px}p{margin:0;font-size:14px;color:#999;line-height:1.5}code{background:#eee;padding:2px 6px;border-radius:4px;font-size:13px;color:#333}</style></head><body><div><h3>No dev server running</h3><p>Start one in this sandbox (e.g. <code>bun run dev</code>) and the preview will appear here automatically.</p></div><script>setTimeout(function(){window.location.reload()},2000)</script></body></html>"#;

const STARTING_HTML: &str = r#"<!DOCTYPE html><html><head><meta charset="utf-8"><title>Starting...</title><style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#fafafa;color:#555}div{text-align:center}p{margin-top:8px;font-size:14px;color:#999}</style></head><body><div><h3>Server is starting…</h3><p>This page will refresh automatically.</p></div><script>setTimeout(function(){window.location.reload()},1000)</script></body></html>"#;

const NO_WEB_PAGE_HTML: &str = r#"<!DOCTYPE html><html><head><meta charset="utf-8"><title>No web page</title><style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#fafafa;color:#555}div{text-align:center;max-width:420px;padding:24px}h3{margin:0 0 8px}p{margin:0;font-size:14px;color:#999;line-height:1.5}code{background:#eee;padding:2px 6px;border-radius:4px;font-size:13px;color:#333}</style></head><body><div><h3>No web page at this URL</h3><p>The dev server is running but doesn't serve HTML at <code>/</code>. The preview only renders web pages — open the logs to see what's running.</p></div></body></html>"#;

/// HTML injected before `</body>` so the preview iframe can talk to the
/// parent — byte-parity with `packages/sandbox/shared.ts`'s
/// `IFRAME_BOOTSTRAP_SCRIPT` (aliased as `BOOTSTRAP_SCRIPT` in
/// `daemon/constants.ts`).
const BOOTSTRAP_SCRIPT: &str = r#"<script>(function(){try{var W=window.WebSocket;if(W){var m=location.pathname.match(/^(\/api\/sandbox\/[^\/]+(?:\/thread\/[^\/]+)?\/preview(?:\/\d+)?)/);var p=m?m[1]:"";function r(u){try{var x=new URL(String(u),location.href);var lb=x.hostname==="localhost"||x.hostname==="127.0.0.1"||x.hostname==="0.0.0.0";var pm=x.hostname===location.hostname&&x.port!==location.port&&x.port!=="";if(!lb&&!pm)return String(u);x.protocol=location.protocol==="https:"?"wss:":"ws:";x.host=location.host;if(p&&!x.pathname.startsWith(p))x.pathname=p+x.pathname;return x.toString();}catch(_){return String(u);}}class P extends W{constructor(u,pr){super(r(u),pr);}}window.WebSocket=P;}}catch(_){}window.addEventListener("message",function(e){if(e.data&&e.data.type==="visual-editor::activate"&&e.data.script){try{new Function(e.data.script)();}catch(err){console.error("[visual-editor] injection failed",err);}}});})();</script>"#;

#[derive(Clone)]
pub(crate) struct PreviewCookieSelftest {
    pub control_origin: Arc<str>,
    pub expected_host: Arc<str>,
    pub cookie_value: Arc<str>,
}

pub async fn fallback(State(state): State<AppState>, req: Request) -> Response {
    if is_websocket_upgrade(req.headers()) {
        return handle_ws_upgrade(state, req).await;
    }

    match resolve_preview(&state, req.headers()) {
        PreviewResolution::Port(port) => proxy_to_port(port, req).await,
        PreviewResolution::Starting => starting_response(),
        PreviewResolution::NoServer => no_upstream_response(),
    }
}

/// Selftest-only credentialed cross-origin cookie probe. This route is mounted
/// only when the embedding shell explicitly enables it; normal builds proxy
/// this path to the sandbox like every other preview request.
pub(crate) async fn preview_cookie_selftest(
    Extension(config): Extension<PreviewCookieSelftest>,
    method: Method,
    headers: HeaderMap,
) -> Response {
    if !has_exact_single_header(&headers, header::HOST, &config.expected_host)
        || !has_exact_single_header(&headers, header::ORIGIN, &config.control_origin)
    {
        return StatusCode::FORBIDDEN.into_response();
    }

    if method == Method::OPTIONS {
        if headers
            .get(header::ACCESS_CONTROL_REQUEST_METHOD)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| !value.eq_ignore_ascii_case("GET"))
        {
            return StatusCode::FORBIDDEN.into_response();
        }
        let mut response = StatusCode::NO_CONTENT.into_response();
        apply_preview_selftest_cors(response.headers_mut(), &config.control_origin);
        response.headers_mut().insert(
            header::ACCESS_CONTROL_ALLOW_METHODS,
            HeaderValue::from_static("GET, OPTIONS"),
        );
        response.headers_mut().insert(
            header::VARY,
            HeaderValue::from_static(
                "Origin, Access-Control-Request-Method, Access-Control-Request-Headers",
            ),
        );
        if let Some(requested_headers) = headers.get(header::ACCESS_CONTROL_REQUEST_HEADERS) {
            response.headers_mut().insert(
                header::ACCESS_CONTROL_ALLOW_HEADERS,
                requested_headers.clone(),
            );
        }
        return response;
    }

    let received = cookie_has_value(&headers, PREVIEW_COOKIE_SELFTEST_NAME, &config.cookie_value);
    let mut response = Json(json!({ "received": received })).into_response();
    apply_preview_selftest_cors(response.headers_mut(), &config.control_origin);
    if !received {
        let set_cookie = format!(
            "{PREVIEW_COOKIE_SELFTEST_NAME}={}; Path=/; HttpOnly; SameSite=Strict",
            config.cookie_value
        );
        let Ok(set_cookie) = HeaderValue::from_str(&set_cookie) else {
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        };
        response
            .headers_mut()
            .append(header::SET_COOKIE, set_cookie);
    }
    response
}

/// Selftest-only iframe target. Navigations do not reliably carry `Origin`,
/// so this endpoint validates the exact preview Host instead and returns a
/// deterministic 200 document without mutating the cookie jar.
pub(crate) async fn preview_frame_selftest(
    Extension(config): Extension<PreviewCookieSelftest>,
    headers: HeaderMap,
) -> Response {
    if !has_exact_single_header(&headers, header::HOST, &config.expected_host) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let Ok(target_origin) = serde_json::to_string(config.control_origin.as_ref()) else {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    };
    let target_origin = target_origin
        .replace('<', "\\u003c")
        .replace('>', "\\u003e");
    let html = format!(
        "<!doctype html><html><body><script>window.parent.postMessage({{type:\"decocms-preview-selftest-ready\"}},{target_origin})</script></body></html>"
    );
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .body(Body::from(html))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

fn has_exact_single_header(
    headers: &HeaderMap,
    name: axum::http::header::HeaderName,
    expected: &str,
) -> bool {
    let mut values = headers.get_all(name).iter();
    values.next().and_then(|value| value.to_str().ok()) == Some(expected) && values.next().is_none()
}

fn apply_preview_selftest_cors(headers: &mut HeaderMap, control_origin: &str) {
    if let Ok(origin) = HeaderValue::from_str(control_origin) {
        headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin);
    }
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_CREDENTIALS,
        HeaderValue::from_static("true"),
    );
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(header::VARY, HeaderValue::from_static("Origin"));
}

fn cookie_has_value(headers: &HeaderMap, name: &str, expected: &str) -> bool {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(';'))
        .filter_map(|part| part.trim().split_once('='))
        .any(|(candidate, value)| candidate == name && value == expected)
}

/// `POST /_sandbox/preview-handle {"handle": "..."}` — points the headerless
/// preview (the iframe, which can't set
/// [`crate::sandbox::SANDBOX_HANDLE_HEADER`]) at a
/// specific sandbox. The webview calls this when a git-backed thread becomes
/// focused, so switching threads updates the preview without another sandbox
/// ensure. The handle
/// must have a durable registry row: accepting a frontend-computed phantom
/// would persist an active pointer that cannot ever resolve to repo config.
pub async fn set_preview_handle(
    State(state): State<AppState>,
    axum::Json(body): axum::Json<serde_json::Value>,
) -> Response {
    match body.get("handle").and_then(Value::as_str) {
        Some(handle) if !handle.is_empty() => match state.sandbox_manager.set_active(handle) {
            Ok(()) => (StatusCode::OK, axum::Json(json!({ "ok": true }))).into_response(),
            Err(error) if error.starts_with("unknown sandbox handle:") => {
                (StatusCode::NOT_FOUND, axum::Json(json!({ "error": error }))).into_response()
            }
            Err(error) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                axum::Json(json!({ "error": error })),
            )
                .into_response(),
        },
        _ => (
            StatusCode::BAD_REQUEST,
            axum::Json(json!({ "error": "handle is required" })),
        )
            .into_response(),
    }
}

/// `getDevPort()`: the sniffed port from a `running` orchestrator, else the
/// statically configured `application.port` — resolved against a SPECIFIC
/// sandbox handle's own orchestrator/config when
/// [`crate::sandbox::SANDBOX_HANDLE_HEADER`] names one this process knows
/// about, else the process-global `state.setup`/`state.config` pair (unchanged
/// plain-path behavior). See this file's module doc.
///
/// KEPT (not replaced by [`resolve_preview`]): the WS-upgrade path and this
/// file's `dev_port_*` tests still drive `dev_port` directly, and its
/// unknown-handle -> `None` rule (never preview the wrong branch) is
/// deliberately NOT the observability fallback [`resolve_preview`] uses.
/// The sandbox handle named by the request's `Host`.
///
/// Each sandbox is now previewed at `<handle>.<preview-host>` so that cookies —
/// which ignore the port — stop being shared between sandboxes. A preview
/// iframe cannot set [`crate::sandbox::SANDBOX_HANDLE_HEADER`], but its Host
/// carries the handle, so this is what routes a headerless preview request to
/// the right dev server instead of the process-global "active" sandbox.
///
/// Returns the first label only when it is at least two labels deep, and the
/// caller checks it against the sandbox manager, so a bare `localhost` (or any
/// other name pointed at this listener) falls through to the previous
/// behaviour rather than resolving to a wrong sandbox.
/// The sandbox a preview request's `Host` names, if any.
///
/// The leading label is NOT the handle — a handle is
/// `<host>/<owner>/<repo>/<branch>` and cannot be a hostname. It is
/// `sandbox::preview_label(handle)`, which is one-way, so the handle is
/// recovered by finding the registered sandbox whose label matches. The set
/// is tiny (one entry per worktree on this machine) and the alternative — a
/// second persisted label->handle index — is a thing that can disagree with
/// `preview_label`.
fn handle_from_host(state: &AppState, headers: &HeaderMap) -> Option<String> {
    let host = headers.get(header::HOST)?.to_str().ok()?;
    let host = host.split(':').next()?;
    let (label, rest) = host.split_once('.')?;
    if label.is_empty() || rest.is_empty() {
        return None;
    }
    // A cached in-memory lookup: this runs on EVERY preview asset request,
    // and the walk-the-worktrees version it replaces enumerated directories
    // and hashed every handle each time.
    state.sandbox_manager.handle_for_preview_label(label)
}

fn dev_port(state: &AppState, headers: &HeaderMap) -> Option<u16> {
    if let Some(handle) = crate::sandbox::handle_from_headers(headers) {
        let sandbox = state.sandbox_manager.get(handle)?;
        return dev_port_for(&sandbox.setup, &sandbox.config);
    }
    // A preview iframe cannot set the handle header, but its Host names the
    // sandbox — this is the per-handle preview origin resolving itself.
    if let Some(sandbox) =
        handle_from_host(state, headers).and_then(|handle| state.sandbox_manager.get(&handle))
    {
        return dev_port_for(&sandbox.setup, &sandbox.config);
    }
    // Neither: serve the ACTIVE sandbox's dev server if a git-backed thread has
    // selected one, else the global (non-git) orchestrator — unchanged
    // behavior for the plain path.
    match state.sandbox_manager.active() {
        Some(sandbox) => dev_port_for(&sandbox.setup, &sandbox.config),
        None => dev_port_for(&state.setup, &state.config),
    }
}

/// `portSniffer.current() ?? application.port ?? null` for one
/// The dev port of an [`AppState`] whose target is already the sandbox in
/// question — i.e. one built by `state_for_sandbox`, where the "global"
/// orchestrator/config pair IS that sandbox's.
pub(crate) fn target_dev_port(state: &AppState) -> Option<u16> {
    dev_port_for(&state.setup, &state.config)
}

/// The dev port of one already-resolved sandbox — for callers that hold a
/// [`crate::sandbox::Sandbox`] rather than a request's headers (the
/// `preview-invoke` intercept, which addresses a sandbox by id+branch).
pub(crate) fn sandbox_dev_port(sandbox: &crate::sandbox::manager::Sandbox) -> Option<u16> {
    dev_port_for(&sandbox.setup, &sandbox.config)
}

/// orchestrator/config pair — shared by the process-global path and every
/// per-handle [`crate::sandbox::Sandbox`].
fn dev_port_for(
    setup: &crate::setup::SetupOrchestrator,
    config: &crate::config::ConfigStore,
) -> Option<u16> {
    let lifecycle = setup.lifecycle_snapshot();
    if lifecycle.get("phase").and_then(Value::as_str) == Some("running") {
        if let Some(port) = lifecycle
            .get("port")
            .and_then(Value::as_u64)
            .and_then(|p| u16::try_from(p).ok())
        {
            return Some(port);
        }
    }
    // The sandbox's held allocation — the port EVERY spawn path binds (the
    // orchestrator and the UI's exec relaunch share `dev_port::resolve`).
    // Consulted before the config's static value: outside a lifecycle-owned
    // run (a server relaunched from the run button never transitions the
    // lifecycle) the allocation is where the server actually is, and the
    // config port is merely what seeded it.
    let sandbox_root = crate::sandbox::dev_port::sandbox_root_for(&setup.repo_dir);
    if let Some(port) = crate::sandbox::dev_port::assigned(&sandbox_root) {
        return Some(port);
    }
    let snapshot = config.snapshot();
    let cfg = snapshot.config?;
    crate::sandbox::dev_port::configured_port(&cfg)
}

/// Phase-aware outcome for the preview `fallback` — distinguishes "a dev
/// server is bound, proxy to it" from "a sandbox exists and is provisioning,
/// show the spinner" from "nothing to preview." Compare with [`dev_port`],
/// which collapses the middle case into `None`: the WS path has no HTML
/// placeholder, so it keeps using `dev_port`; only `fallback` (which CAN serve
/// [`STARTING_HTML`]) needs this distinction. See plan D4.
enum PreviewResolution {
    Port(u16),
    Starting,
    NoServer,
}

/// Resolves the preview outcome using the SAME handle -> `get(handle)` ->
/// `active()` -> global shape as [`dev_port`] (an unknown explicit handle
/// stays `NoServer`, never previewing the wrong branch), then maps a
/// no-dev-port result to `Starting` vs `NoServer` by the resolved
/// orchestrator's lifecycle phase. NOT shared with `dev_port` on purpose — see
/// [`dev_port`]'s doc and plan D1/D4.
fn resolve_preview(state: &AppState, headers: &HeaderMap) -> PreviewResolution {
    if let Some(handle) = crate::sandbox::handle_from_headers(headers) {
        return match state.sandbox_manager.get(handle) {
            Some(sandbox) => preview_from(&sandbox.setup, &sandbox.config),
            // Unknown explicit handle: never fall back to the wrong branch.
            None => PreviewResolution::NoServer,
        };
    }
    // Per-handle preview origin (`<handle>.<preview-host>`): the iframe's Host
    // names the sandbox even though it cannot set the handle header.
    if let Some(sandbox) =
        handle_from_host(state, headers).and_then(|handle| state.sandbox_manager.get(&handle))
    {
        return preview_from(&sandbox.setup, &sandbox.config);
    }
    match state.sandbox_manager.active() {
        Some(sandbox) => preview_from(&sandbox.setup, &sandbox.config),
        None => preview_from(&state.setup, &state.config),
    }
}

/// Maps one orchestrator/config pair to a [`PreviewResolution`]: a resolvable
/// dev port -> `Port`; else the lifecycle phase decides `Starting` (the
/// sandbox exists and is provisioning) vs `NoServer` (idle / no config /
/// terminal-failed).
fn preview_from(
    setup: &crate::setup::SetupOrchestrator,
    config: &crate::config::ConfigStore,
) -> PreviewResolution {
    match dev_port_for(setup, config) {
        Some(port) => PreviewResolution::Port(port),
        None => match setup
            .lifecycle_snapshot()
            .get("phase")
            .and_then(Value::as_str)
        {
            Some("cloning" | "checking-out" | "installing" | "starting" | "running") => {
                PreviewResolution::Starting
            }
            _ => PreviewResolution::NoServer,
        },
    }
}

fn is_websocket_upgrade(headers: &HeaderMap) -> bool {
    headers
        .get(header::UPGRADE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.eq_ignore_ascii_case("websocket"))
}

async fn handle_ws_upgrade(state: AppState, req: Request) -> Response {
    let port = dev_port(&state, req.headers());
    let (mut parts, _body) = req.into_parts();
    let path_and_query = parts
        .uri
        .path_and_query()
        .map(|pq| pq.as_str().to_string())
        .unwrap_or_else(|| parts.uri.path().to_string());
    let requested_protocols: Vec<String> = parts
        .headers
        .get(header::SEC_WEBSOCKET_PROTOCOL)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.split(',').map(|p| p.trim().to_string()).collect())
        .unwrap_or_default();
    let request_headers = parts.headers.clone();

    match WebSocketUpgrade::from_request_parts(&mut parts, &state).await {
        Ok(upgrade) => {
            ws_proxy::upgrade(
                upgrade,
                port,
                path_and_query,
                requested_protocols,
                request_headers,
            )
            .await
        }
        Err(rejection) => rejection.into_response(),
    }
}

/// Given an already-resolved dev-server port, reverse-proxies `req` to it.
/// Split out from `fallback` so unit tests can drive it directly against a
/// real loopback listener without needing `AppState`/`ConfigStore` — see
/// this file's module doc.
async fn proxy_to_port(port: u16, req: Request) -> Response {
    let (parts, body) = req.into_parts();
    let is_root = parts.uri.path() == "/";
    let path_and_query = parts
        .uri
        .path_and_query()
        .map(|pq| pq.as_str().to_string())
        .unwrap_or_else(|| "/".to_string());

    let mut out_headers = parts.headers.clone();
    // Byte-parity with `proxy.ts`: don't ask the dev server to compress (we
    // may need to read+rewrite an HTML body). Cookie and Authorization are
    // end-to-end application headers on this dedicated preview listener:
    // local-api authentication never runs here, so stripping either would
    // silently break the sandboxed application's own sessions.
    out_headers.remove(header::ACCEPT_ENCODING);
    strip_hop_by_hop_headers(&mut out_headers);
    out_headers.remove(header::CONTENT_LENGTH);

    let body_bytes = match axum::body::to_bytes(body, MAX_PROXY_BODY_BYTES).await {
        Ok(b) => b,
        Err(err) => return proxy_error_response(&format!("failed to read request body: {err}")),
    };

    match send_to_loopback(
        port,
        &parts.method,
        &path_and_query,
        out_headers,
        body_bytes,
    )
    .await
    {
        Ok(upstream) => build_success_response(upstream, is_root).await,
        Err(msg) => {
            tracing::warn!(port, path = %path_and_query, error = %msg, "proxy error");
            if is_root {
                starting_response()
            } else {
                proxy_error_response(&msg)
            }
        }
    }
}

fn proxy_client() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            // Byte-parity with `proxy.ts`'s `redirect: "manual"` — a 3xx
            // from the dev server passes straight through to the browser
            // instead of being silently followed here.
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    })
}

/// Tries `[::1]` then `127.0.0.1`, matching `proxy/loopback.ts`'s
/// dual-stack preference (some dev servers bind IPv6-only, some IPv4-only).
/// Only retries the second host on a genuine connect-phase failure — a
/// mid-flight failure after a connection was established is never retried,
/// since re-sending a non-idempotent request risks a double write upstream
/// (same reasoning as `fetchLoopback`).
async fn send_to_loopback(
    port: u16,
    method: &axum::http::Method,
    path_and_query: &str,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Result<reqwest::Response, String> {
    let client = proxy_client();
    let hosts = ["[::1]", "127.0.0.1"];
    let mut last_err: Option<String> = None;
    for (idx, host) in hosts.iter().enumerate() {
        let url = format!("http://{host}:{port}{path_and_query}");
        let builder = client
            .request(method.clone(), &url)
            .headers(headers.clone())
            .body(body.clone());
        match tokio::time::timeout(HEADERS_TIMEOUT, builder.send()).await {
            Ok(Ok(resp)) => return Ok(resp),
            Ok(Err(e)) => {
                let is_last = idx == hosts.len() - 1;
                if !is_last && e.is_connect() {
                    last_err = Some(e.to_string());
                    continue;
                }
                return Err(e.to_string());
            }
            Err(_elapsed) => return Err("upstream headers timeout".to_string()),
        }
    }
    Err(last_err.unwrap_or_else(|| "upstream unreachable".to_string()))
}

async fn build_success_response(upstream: reqwest::Response, is_root: bool) -> Response {
    let status = upstream.status();
    if status.as_u16() >= 500 {
        tracing::warn!(status = status.as_u16(), "proxy upstream error");
    }

    let mut resp_headers = upstream.headers().clone();
    strip_hop_by_hop_headers(&mut resp_headers);
    resp_headers.remove("x-frame-options");
    resp_headers.remove("content-security-policy");
    resp_headers.remove("content-security-policy-report-only");
    relax_cookies_for_loopback(&mut resp_headers);

    let content_type = upstream
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();

    if content_type.contains("text/html") {
        resp_headers.remove(header::CONTENT_LENGTH);
        resp_headers.remove(header::CONTENT_ENCODING);
        let text = match upstream.text().await {
            Ok(t) => t,
            Err(err) => {
                return proxy_error_response(&format!("failed reading upstream body: {err}"))
            }
        };
        let injected = inject_bootstrap_script(&text);
        return build_response(status, resp_headers, Body::from(injected));
    }

    // Root document that isn't HTML (or has no Content-Type at all): render
    // the dedicated notice instead of dumping raw JSON/text into the
    // iframe. Sub-paths pass through untouched.
    if is_root {
        // Drain the body so the connection can be reused/closed cleanly —
        // mirrors `upstream.body?.cancel()`.
        let _ = upstream.bytes().await;
        return no_web_page_response(resp_headers);
    }

    let body = Body::from_stream(upstream.bytes_stream());
    build_response(status, resp_headers, body)
}

/// Makes the sandbox's cookies storable by the preview origin.
///
/// A sandbox's own server sets cookies scoped to the site it proxies — VTEX
/// sends `domain=<store>.vtexcommercestable.com.br` — and a browser rejects a
/// cookie whose `Domain` does not cover the host that sent it. The preview is
/// served from `<handle>.<control host>`, so every such cookie would be
/// dropped and the flow it belongs to (a checkout session, say) could never
/// complete. Removing the attribute makes the cookie host-only for the preview
/// origin: storable, and narrower than what was asked for.
///
/// `Secure` and `SameSite=None` used to be rewritten here too, because the
/// preview was served over plain http where WebKit refuses `Secure` cookies.
/// The app now terminates TLS locally (`src-tauri/src/local_tls.rs`), so both
/// are honoured as sent and the rewriting is gone.
fn relax_cookies_for_loopback(headers: &mut HeaderMap) {
    let mut rewritten: Vec<HeaderValue> = Vec::new();
    let mut changed = false;

    for value in headers.get_all(header::SET_COOKIE) {
        // A cookie this function cannot read is forwarded untouched rather
        // than dropped — losing it would be a worse bug than not relaxing it.
        let Ok(text) = value.to_str() else {
            rewritten.push(value.clone());
            continue;
        };
        let relaxed = relax_set_cookie(text);
        if relaxed != text {
            changed = true;
        }
        match HeaderValue::from_str(&relaxed) {
            Ok(header_value) => rewritten.push(header_value),
            Err(_) => rewritten.push(value.clone()),
        }
    }

    if !changed {
        return;
    }
    headers.remove(header::SET_COOKIE);
    for value in rewritten {
        headers.append(header::SET_COOKIE, value);
    }
}

/// One `Set-Cookie` value with any `Domain` attribute removed.
///
/// Only ATTRIBUTES are inspected. The first `;`-separated segment is the
/// cookie's own `name=value` and is copied verbatim, so a cookie whose value
/// happens to contain `secure` is never touched.
fn relax_set_cookie(value: &str) -> String {
    let mut parts: Vec<String> = Vec::new();

    for (index, part) in value.split(';').enumerate() {
        let trimmed = part.trim();
        if index == 0 {
            parts.push(trimmed.to_string());
            continue;
        }
        let name = match trimmed.split_once('=') {
            Some((name, _)) => name.trim(),
            None => trimmed,
        };
        // `Domain` names the ORIGIN site, not this loopback origin — VTEX
        // sends `domain=<store>.vtexcommercestable.com.br` through the store's
        // own server. A browser rejects a cookie whose Domain does not match
        // the host that sent it, so keeping the attribute loses the cookie as
        // surely as `Secure` did. Dropping it makes the cookie host-only for
        // the preview origin, which is both storable and the narrower scope.
        if name.eq_ignore_ascii_case("domain") {
            continue;
        }
        parts.push(trimmed.to_string());
    }

    parts.join("; ")
}

fn inject_bootstrap_script(html: &str) -> String {
    match html.rfind("</body>") {
        Some(idx) => {
            let mut out = String::with_capacity(html.len() + BOOTSTRAP_SCRIPT.len());
            out.push_str(&html[..idx]);
            out.push_str(BOOTSTRAP_SCRIPT);
            out.push_str(&html[idx..]);
            out
        }
        None => format!("{html}{BOOTSTRAP_SCRIPT}"),
    }
}

fn build_response(status: StatusCode, headers: HeaderMap, body: Body) -> Response {
    let mut res = Response::new(body);
    *res.status_mut() = status;
    *res.headers_mut() = headers;
    res
}

fn no_upstream_response() -> Response {
    placeholder_html(StatusCode::SERVICE_UNAVAILABLE, NO_UPSTREAM_HTML, &[])
}

fn starting_response() -> Response {
    placeholder_html(
        StatusCode::SERVICE_UNAVAILABLE,
        STARTING_HTML,
        &[(header::RETRY_AFTER, HeaderValue::from_static("1"))],
    )
}

fn no_web_page_response(mut headers: HeaderMap) -> Response {
    // This response replaces only the upstream body so the preview iframe
    // shows a useful notice. Preserve application metadata such as Set-Cookie
    // and custom headers; only representation/framing headers may describe
    // the replacement document instead.
    headers.remove(header::CONTENT_LENGTH);
    headers.remove(header::CONTENT_ENCODING);
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/html; charset=utf-8"),
    );
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_ORIGIN,
        HeaderValue::from_static("*"),
    );
    build_response(StatusCode::OK, headers, Body::from(NO_WEB_PAGE_HTML))
}

/// Every placeholder page byte-parities the daemon's own wildcard CORS on
/// this specific response family — see this file's module doc.
fn placeholder_html(
    status: StatusCode,
    body: &'static str,
    extra_headers: &[(axum::http::HeaderName, HeaderValue)],
) -> Response {
    let mut builder = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*");
    for (name, value) in extra_headers {
        builder = builder.header(name, value);
    }
    builder
        .body(Body::from(body))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

fn proxy_error_response(msg: &str) -> Response {
    (
        StatusCode::BAD_GATEWAY,
        [(
            header::ACCESS_CONTROL_ALLOW_ORIGIN,
            HeaderValue::from_static("*"),
        )],
        Json(json!({ "error": format!("proxy error: {msg}") })),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;
    use axum::routing::{get, post};
    use tokio::net::TcpListener;

    /// Minimal loopback HTTP server for exercising `proxy_to_port`
    /// end-to-end without any daemon/e2e harness — see the module doc's
    /// "Testability" section. Built on `axum::serve` (already a dependency)
    /// rather than a hand-rolled hyper service, since it's only ever the
    /// test-side stand-in for "some dev server".
    async fn spawn_upstream(app: axum::Router) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        port
    }

    fn empty_request(method: &str, uri: &str) -> Request {
        axum::extract::Request::builder()
            .method(method)
            .uri(uri)
            .body(Body::empty())
            .unwrap()
    }

    #[tokio::test]
    async fn no_dev_port_returns_503_placeholder() {
        let res = no_upstream_response();
        assert_eq!(res.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(
            res.headers()
                .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
                .unwrap(),
            "*"
        );
        let body = to_bytes(res.into_body(), usize::MAX).await.unwrap();
        assert!(String::from_utf8_lossy(&body).contains("No dev server running"));
    }

    #[tokio::test]
    async fn dead_port_at_root_is_starting_page() {
        let free_port = {
            // Reserve then immediately drop a port so nothing listens there.
            let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
            l.local_addr().unwrap().port()
        };
        let res = proxy_to_port(free_port, empty_request("GET", "/")).await;
        assert_eq!(res.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(res.headers().get(header::RETRY_AFTER).unwrap(), "1");
        let body = to_bytes(res.into_body(), usize::MAX).await.unwrap();
        assert!(String::from_utf8_lossy(&body).contains("Server is starting"));
    }

    #[tokio::test]
    async fn dead_port_at_non_root_is_502_json() {
        let free_port = {
            let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
            l.local_addr().unwrap().port()
        };
        let res = proxy_to_port(free_port, empty_request("GET", "/api/thing")).await;
        assert_eq!(res.status(), StatusCode::BAD_GATEWAY);
        let body = to_bytes(res.into_body(), usize::MAX).await.unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert!(json["error"].as_str().unwrap().contains("proxy error"));
    }

    #[tokio::test]
    async fn html_upstream_injects_bootstrap_and_strips_xfo_csp() {
        let app = axum::Router::new().route(
            "/",
            get(|| async {
                Response::builder()
                    .header(header::CONTENT_TYPE, "text/html")
                    .header("x-frame-options", "DENY")
                    .header("content-security-policy", "default-src 'none'")
                    .body(Body::from("<html><body><h1>hi</h1></body></html>"))
                    .unwrap()
            }),
        );
        let port = spawn_upstream(app).await;

        let res = proxy_to_port(port, empty_request("GET", "/")).await;
        assert_eq!(res.status(), StatusCode::OK);
        assert!(res.headers().get("x-frame-options").is_none());
        assert!(res.headers().get("content-security-policy").is_none());
        let body = to_bytes(res.into_body(), usize::MAX).await.unwrap();
        let text = String::from_utf8_lossy(&body);
        let script_idx = text.find("<script").unwrap();
        let body_close_idx = text.rfind("</body>").unwrap();
        assert!(script_idx < body_close_idx);
    }

    #[tokio::test]
    async fn http1_preview_reframes_chunked_html_without_an_empty_reply() {
        let upstream = axum::Router::new().route(
            "/",
            get(|| async {
                let chunks = futures_util::stream::iter([
                    Ok::<_, std::convert::Infallible>(axum::body::Bytes::from_static(
                        b"<html><body>",
                    )),
                    Ok(axum::body::Bytes::from_static(
                        b"chunked page</body></html>",
                    )),
                ]);
                Response::builder()
                    .header(header::CONTENT_TYPE, "text/html")
                    .header(header::CONNECTION, "keep-alive, x-upstream-hop")
                    .header("keep-alive", "timeout=5")
                    .header("x-upstream-hop", "remove-me")
                    .header("x-end-to-end", "keep-me")
                    .body(Body::from_stream(chunks))
                    .unwrap()
            }),
        );
        let upstream_port = spawn_upstream(upstream).await;
        let preview = axum::Router::new()
            .fallback(move |req: Request| async move { proxy_to_port(upstream_port, req).await });
        let preview_port = spawn_upstream(preview).await;

        let client = reqwest::Client::builder().http1_only().build().unwrap();
        let res = client
            .get(format!("http://127.0.0.1:{preview_port}/"))
            .send()
            .await
            .expect("the HTTP/1.1 preview must return a framed response");

        assert_eq!(res.status(), StatusCode::OK);
        assert!(res.headers().get(header::CONNECTION).is_none());
        assert!(res.headers().get("keep-alive").is_none());
        assert!(res.headers().get("x-upstream-hop").is_none());
        assert_eq!(res.headers().get("x-end-to-end").unwrap(), "keep-me");
        let body = res.text().await.unwrap();
        assert!(body.contains("chunked page"));
        assert!(body.contains(BOOTSTRAP_SCRIPT));
    }

    /// A cookie the upstream scoped to ITS OWN domain cannot be stored by a
    /// browser talking to this loopback origin; dropping the attribute makes
    /// it host-only, which is storable and narrower.
    #[test]
    fn drops_a_domain_the_preview_origin_could_never_satisfy() {
        assert_eq!(
            relax_set_cookie(
                "checkout.vtex.com=__ofid=4973; domain=fila.vtexcommercestable.com.br; path=/; secure; samesite=none; httponly"
            ),
            // `Secure`/`SameSite` now pass through untouched: the preview
            // origin is HTTPS, so the browser honours them as sent.
            "checkout.vtex.com=__ofid=4973; path=/; secure; samesite=none; httponly"
        );
        assert_eq!(relax_set_cookie("a=1; Domain=example.com"), "a=1");
        // Everything else survives verbatim.
        assert_eq!(
            relax_set_cookie("a=1; Path=/; Secure; SameSite=None; HttpOnly"),
            "a=1; Path=/; Secure; SameSite=None; HttpOnly"
        );
    }

    /// Only attributes are interpreted; the cookie's own value is copied
    /// verbatim, so a value containing `secure` must survive intact.
    #[test]
    fn never_rewrites_the_cookie_value_itself() {
        assert_eq!(
            relax_set_cookie("token=secure-samesite=none; Path=/"),
            "token=secure-samesite=none; Path=/"
        );
        assert_eq!(relax_set_cookie("mode=secure"), "mode=secure");
    }

    /// A cookie that needs no relaxing must come through byte-identical.
    #[test]
    fn leaves_an_already_storable_cookie_untouched() {
        let mut headers = HeaderMap::new();
        headers.append(
            header::SET_COOKIE,
            HeaderValue::from_static("a=1; Path=/; HttpOnly; SameSite=Lax"),
        );
        relax_cookies_for_loopback(&mut headers);
        assert_eq!(
            headers[header::SET_COOKIE],
            "a=1; Path=/; HttpOnly; SameSite=Lax"
        );
    }

    #[test]
    fn relaxes_every_cookie_on_the_response() {
        let mut headers = HeaderMap::new();
        headers.append(
            header::SET_COOKIE,
            HeaderValue::from_static("a=1; Domain=a.example.com; Secure"),
        );
        headers.append(
            header::SET_COOKIE,
            HeaderValue::from_static("b=2; Path=/; domain=b.example.com"),
        );
        relax_cookies_for_loopback(&mut headers);

        let cookies: Vec<&str> = headers
            .get_all(header::SET_COOKIE)
            .iter()
            .map(|value| value.to_str().unwrap())
            .collect();
        assert_eq!(cookies, ["a=1; Secure", "b=2; Path=/"]);
    }

    #[tokio::test]
    async fn non_html_at_root_is_no_web_page_notice() {
        let app = axum::Router::new().route(
            "/",
            get(|| async {
                Response::builder()
                    .header(header::CONTENT_TYPE, "application/json")
                    .header(
                        header::SET_COOKIE,
                        "sandbox-session=abc; Path=/; HttpOnly; SameSite=Lax",
                    )
                    .header(
                        header::SET_COOKIE,
                        "sandbox-theme=dark; Path=/; SameSite=Strict",
                    )
                    .header(header::AUTHORIZATION, "Bearer sandbox-response")
                    .header("x-sandbox-app", "preserved")
                    .body(Body::from(r#"{"ok":true}"#))
                    .unwrap()
            }),
        );
        let port = spawn_upstream(app).await;

        let res = proxy_to_port(port, empty_request("GET", "/")).await;
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(
            res.headers()[header::CONTENT_TYPE],
            "text/html; charset=utf-8"
        );
        assert_eq!(
            res.headers()[header::AUTHORIZATION],
            "Bearer sandbox-response"
        );
        assert_eq!(res.headers()["x-sandbox-app"], "preserved");
        let cookies = res
            .headers()
            .get_all(header::SET_COOKIE)
            .iter()
            .map(|value| value.to_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            cookies,
            [
                "sandbox-session=abc; Path=/; HttpOnly; SameSite=Lax",
                "sandbox-theme=dark; Path=/; SameSite=Strict",
            ]
        );
        let body = to_bytes(res.into_body(), usize::MAX).await.unwrap();
        assert!(String::from_utf8_lossy(&body).contains("No web page at this URL"));
    }

    #[tokio::test]
    async fn non_root_pass_through_strips_xfo_and_forwards_body() {
        let app = axum::Router::new().route(
            "/api/echo",
            post(|body: axum::body::Bytes| async move {
                assert_eq!(body.as_ref(), br#"{"hello":"world"}"#);
                Response::builder()
                    .header("x-frame-options", "DENY")
                    .header(header::CONTENT_TYPE, "application/json")
                    .header(header::CONTENT_ENCODING, "sandbox-test-codec")
                    .header("x-sandbox-app", "preserved")
                    .body(Body::from(r#"{"ok":true}"#))
                    .unwrap()
            }),
        );
        let port = spawn_upstream(app).await;

        let req = axum::extract::Request::builder()
            .method("POST")
            .uri("/api/echo")
            .header("content-type", "application/json")
            .body(Body::from(r#"{"hello":"world"}"#))
            .unwrap();
        let res = proxy_to_port(port, req).await;
        assert_eq!(res.status(), StatusCode::OK);
        assert!(res.headers().get("x-frame-options").is_none());
        assert_eq!(
            res.headers()[header::CONTENT_ENCODING],
            "sandbox-test-codec"
        );
        assert_eq!(res.headers()["x-sandbox-app"], "preserved");
    }

    #[tokio::test]
    async fn forwards_application_cookie_and_authorization() {
        let app = axum::Router::new().route(
            "/api/sniff",
            get(|headers: HeaderMap| async move {
                let seen_auth = headers
                    .get("authorization")
                    .map(|v| v.to_str().unwrap().to_string());
                let seen_cookie = headers
                    .get("cookie")
                    .map(|v| v.to_str().unwrap().to_string());
                Response::builder()
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        json!({ "seenAuth": seen_auth, "seenCookie": seen_cookie }).to_string(),
                    ))
                    .unwrap()
            }),
        );
        let port = spawn_upstream(app).await;

        let req = axum::extract::Request::builder()
            .method("GET")
            .uri("/api/sniff")
            .header("authorization", "Bearer application-token")
            .header(
                "cookie",
                "decocms-local-session=control-secret; sandbox-session=abc",
            )
            .body(Body::empty())
            .unwrap();
        let res = proxy_to_port(port, req).await;
        assert_eq!(res.status(), StatusCode::OK);
        let body = to_bytes(res.into_body(), usize::MAX).await.unwrap();
        assert_eq!(
            String::from_utf8_lossy(&body),
            r#"{"seenAuth":"Bearer application-token","seenCookie":"decocms-local-session=control-secret; sandbox-session=abc"}"#
        );
    }

    #[tokio::test]
    async fn forwards_every_application_set_cookie_header() {
        let app = axum::Router::new().route(
            "/api/session",
            get(|| async {
                Response::builder()
                    .header(header::CONTENT_TYPE, "application/json")
                    .header(
                        header::SET_COOKIE,
                        "sandbox-session=abc; Path=/; HttpOnly; SameSite=Lax",
                    )
                    .header(
                        header::SET_COOKIE,
                        "sandbox-theme=dark; Path=/; SameSite=Strict",
                    )
                    .body(Body::from(r#"{"ok":true}"#))
                    .unwrap()
            }),
        );
        let port = spawn_upstream(app).await;

        let res = proxy_to_port(port, empty_request("GET", "/api/session")).await;
        assert_eq!(res.status(), StatusCode::OK);
        let cookies = res
            .headers()
            .get_all(header::SET_COOKIE)
            .iter()
            .map(|value| value.to_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            cookies,
            [
                "sandbox-session=abc; Path=/; HttpOnly; SameSite=Lax",
                "sandbox-theme=dark; Path=/; SameSite=Strict",
            ]
        );
    }

    #[test]
    fn detects_websocket_upgrade_header() {
        let mut headers = HeaderMap::new();
        headers.insert(header::UPGRADE, HeaderValue::from_static("websocket"));
        assert!(is_websocket_upgrade(&headers));

        let mut mixed_case = HeaderMap::new();
        mixed_case.insert(header::UPGRADE, HeaderValue::from_static("WebSocket"));
        assert!(is_websocket_upgrade(&mixed_case));

        assert!(!is_websocket_upgrade(&HeaderMap::new()));
    }

    #[test]
    fn injects_before_last_body_close_tag() {
        let html = "<html><body><h1>hi</h1></body><!-- trailing --></body></html>";
        let out = inject_bootstrap_script(html);
        let script_idx = out.find("<script").unwrap();
        let last_close = out.rfind("</body>").unwrap();
        assert!(
            script_idx < last_close,
            "script must land before the LAST </body>"
        );
    }

    #[test]
    fn appends_when_no_body_close_tag_present() {
        let html = "<html><h1>no body tag</h1></html>";
        let out = inject_bootstrap_script(html);
        assert_eq!(out, format!("{html}{BOOTSTRAP_SCRIPT}"));
    }

    fn state_at(app_root: std::path::PathBuf) -> AppState {
        let config = std::sync::Arc::new(crate::config::ConfigStore::new());
        let repo_dir = app_root.join("global-repo");
        // No test in this file exercises real process spawning/log I/O
        // through this default helper, so its shared temp root remains inert.
        // The one git-backed test below supplies a unique tempdir instead.
        let logs = std::sync::Arc::new(crate::log_store::LogStore::new(app_root.join("logs")));
        let tasks = std::sync::Arc::new(crate::tasks::TaskRegistry::new(logs));
        let broadcaster = std::sync::Arc::new(crate::events::Broadcaster::new());
        let setup = crate::setup::SetupOrchestrator::new(
            repo_dir.clone(),
            repo_dir.clone(),
            config.clone(),
            tasks.clone(),
            broadcaster.clone(),
        );
        AppState {
            update: None,
            token: "test-token".into(),
            boot_id: "test-boot".into(),
            sandbox_manager: crate::sandbox::SandboxManager::new(app_root.clone()),
            agent_sessions: crate::terminal::AgentSessionRegistry::new(),
            app_root,
            repo_dir,
            mode: crate::state::ApiMode::Strict,
            config,
            tasks,
            broadcaster,
            shutdown: std::sync::Arc::new(crate::shutdown::ShutdownCoordinator::new()),
            setup,
        }
    }

    fn fresh_state() -> AppState {
        state_at(std::env::temp_dir())
    }

    fn preview_headers(host: &str, handle: Option<&str>) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(header::HOST, HeaderValue::from_str(host).unwrap());
        if let Some(handle) = handle {
            headers.insert(
                crate::sandbox::SANDBOX_HANDLE_HEADER,
                HeaderValue::from_str(handle).unwrap(),
            );
        }
        headers
    }

    #[tokio::test]
    async fn preview_cookie_selftest_is_origin_bound_and_round_trips_strict_cookie() {
        let config = PreviewCookieSelftest {
            control_origin: Arc::from("http://localhost:43120"),
            expected_host: Arc::from("localhost:61234"),
            cookie_value: Arc::from("fresh-boot-secret"),
        };
        let frame = preview_frame_selftest(
            Extension(config.clone()),
            preview_headers("localhost:61234", None),
        )
        .await;
        assert_eq!(frame.status(), StatusCode::OK);
        assert_eq!(frame.headers()[header::CACHE_CONTROL], "no-store");
        let frame_body = axum::body::to_bytes(frame.into_body(), usize::MAX)
            .await
            .unwrap();
        let frame_body = String::from_utf8_lossy(&frame_body);
        assert!(frame_body.contains("decocms-preview-selftest-ready"));
        assert!(frame_body.contains("\"http://localhost:43120\""));
        assert_eq!(
            preview_frame_selftest(
                Extension(config.clone()),
                preview_headers("127.0.0.1:61234", None),
            )
            .await
            .status(),
            StatusCode::FORBIDDEN
        );

        let mut headers = preview_headers("localhost:61234", None);
        headers.insert(
            header::ORIGIN,
            HeaderValue::from_static("http://localhost:43120"),
        );
        let first =
            preview_cookie_selftest(Extension(config.clone()), Method::GET, headers.clone()).await;
        assert_eq!(first.status(), StatusCode::OK);
        assert_eq!(
            first.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN],
            "http://localhost:43120"
        );
        assert_eq!(
            first.headers()[header::ACCESS_CONTROL_ALLOW_CREDENTIALS],
            "true"
        );
        let set_cookie = first.headers()[header::SET_COOKIE].to_str().unwrap();
        assert_eq!(
            set_cookie,
            "decocms-preview-selftest=fresh-boot-secret; Path=/; HttpOnly; SameSite=Strict"
        );

        let mut preflight_headers = headers.clone();
        preflight_headers.insert(
            header::ACCESS_CONTROL_REQUEST_METHOD,
            HeaderValue::from_static("GET"),
        );
        preflight_headers.insert(
            header::ACCESS_CONTROL_REQUEST_HEADERS,
            HeaderValue::from_static("cache-control, pragma"),
        );
        let preflight = preview_cookie_selftest(
            Extension(config.clone()),
            Method::OPTIONS,
            preflight_headers,
        )
        .await;
        assert_eq!(preflight.status(), StatusCode::NO_CONTENT);
        assert_eq!(
            preflight.headers()[header::ACCESS_CONTROL_ALLOW_METHODS],
            "GET, OPTIONS"
        );
        assert_eq!(
            preflight.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN],
            "http://localhost:43120"
        );
        assert_eq!(
            preflight.headers()[header::ACCESS_CONTROL_ALLOW_CREDENTIALS],
            "true"
        );
        assert_eq!(
            preflight.headers()[header::ACCESS_CONTROL_ALLOW_HEADERS],
            "cache-control, pragma"
        );

        let mut duplicate_origin = headers.clone();
        duplicate_origin.append(
            header::ORIGIN,
            HeaderValue::from_static("http://localhost:43120"),
        );
        assert_eq!(
            preview_cookie_selftest(Extension(config.clone()), Method::GET, duplicate_origin,)
                .await
                .status(),
            StatusCode::FORBIDDEN
        );

        headers.insert(
            header::COOKIE,
            HeaderValue::from_static("sandbox=keep; decocms-preview-selftest=fresh-boot-secret"),
        );
        let second = preview_cookie_selftest(Extension(config.clone()), Method::GET, headers).await;
        let body = axum::body::to_bytes(second.into_body(), usize::MAX)
            .await
            .unwrap();
        assert_eq!(body.as_ref(), br#"{"received":true}"#);

        let mut wrong_origin = preview_headers("localhost:61234", None);
        wrong_origin.insert(
            header::ORIGIN,
            HeaderValue::from_static("http://evil.localhost:43120"),
        );
        assert_eq!(
            preview_cookie_selftest(Extension(config.clone()), Method::GET, wrong_origin,)
                .await
                .status(),
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            preview_cookie_selftest(
                Extension(config),
                Method::GET,
                preview_headers("127.0.0.1:61234", None),
            )
            .await
            .status(),
            StatusCode::FORBIDDEN
        );
    }

    #[test]
    fn dev_port_none_when_config_unset() {
        // Exercises `dev_port()` against a real (freshly booted) `AppState`.
        let state = fresh_state();
        assert!(dev_port(&state, &HeaderMap::new()).is_none());
    }

    #[test]
    fn dev_port_prefers_the_sniffed_running_port_over_static_config() {
        let state = fresh_state();
        state
            .config
            .patch(json!({"application": {"port": 4321}}))
            .expect("patch ok");
        // Static config alone: falls back to `application.port`.
        assert_eq!(dev_port(&state, &HeaderMap::new()), Some(4321));

        // Orchestrator reaches `running` with a DIFFERENT (sniffed) port —
        // that must win, matching `getDevPort()`'s `portSniffer.current() ??
        // application.port` precedence.
        state
            .setup
            .transition_lifecycle(json!({"phase": "running", "port": 9999, "htmlSupport": false}));
        assert_eq!(dev_port(&state, &HeaderMap::new()), Some(9999));
    }

    #[test]
    fn dev_port_returns_none_for_an_unrecognized_handle_header() {
        // An unrecognized handle in the header must NOT silently fall back
        // to the process-global dev server (that would preview the WRONG
        // sandbox) — it resolves to no upstream at all.
        let state = fresh_state();
        state
            .config
            .patch(json!({"application": {"port": 1111}}))
            .expect("patch ok");
        let mut headers = HeaderMap::new();
        headers.insert(
            crate::sandbox::SANDBOX_HANDLE_HEADER,
            HeaderValue::from_static("unknown-handle"),
        );
        assert_eq!(dev_port(&state, &headers), None);
    }

    #[test]
    fn resolve_preview_is_no_server_when_idle_and_unconfigured() {
        let state = fresh_state();
        assert!(matches!(
            resolve_preview(&state, &HeaderMap::new()),
            PreviewResolution::NoServer
        ));
    }

    #[test]
    fn resolve_preview_is_starting_while_provisioning() {
        let state = fresh_state();
        for phase in ["cloning", "checking-out", "installing", "starting"] {
            state.setup.transition_lifecycle(json!({ "phase": phase }));
            assert!(
                matches!(
                    resolve_preview(&state, &HeaderMap::new()),
                    PreviewResolution::Starting
                ),
                "phase {phase} should map to Starting"
            );
        }
    }

    #[test]
    fn resolve_preview_is_port_once_running_with_a_sniffed_port() {
        let state = fresh_state();
        state
            .setup
            .transition_lifecycle(json!({"phase": "running", "port": 8321, "htmlSupport": false}));
        assert!(matches!(
            resolve_preview(&state, &HeaderMap::new()),
            PreviewResolution::Port(8321)
        ));
    }

    #[test]
    fn resolve_preview_is_starting_for_running_without_a_port() {
        // `running` but no port field and no static config port: the phase
        // still means "provisioning", so serve the spinner, not "no server".
        let state = fresh_state();
        state
            .setup
            .transition_lifecycle(json!({"phase": "running", "htmlSupport": false}));
        assert!(matches!(
            resolve_preview(&state, &HeaderMap::new()),
            PreviewResolution::Starting
        ));
    }

    #[test]
    fn resolve_preview_unknown_handle_is_no_server() {
        // An unrecognized explicit handle must NOT preview the wrong branch —
        // same strict rule as `dev_port`, surfaced here as `NoServer`.
        let state = fresh_state();
        state
            .setup
            .transition_lifecycle(json!({ "phase": "installing" }));
        let mut headers = HeaderMap::new();
        headers.insert(
            crate::sandbox::SANDBOX_HANDLE_HEADER,
            HeaderValue::from_static("unknown-handle"),
        );
        assert!(matches!(
            resolve_preview(&state, &headers),
            PreviewResolution::NoServer
        ));
    }

    #[tokio::test]
    async fn dev_port_routes_by_sandbox_handle_header_to_that_handles_own_port() {
        // Process-global path configured at one port...
        let state_root = tempfile::tempdir().unwrap();
        let state = state_at(state_root.path().to_path_buf());
        state
            .config
            .patch(json!({"application": {"port": 1111}}))
            .expect("patch ok");

        // ...while a REAL per-handle sandbox (created the same way a
        // git-backed dispatch would via `SandboxManager::ensure`) reaches
        // `running` at a DIFFERENT, sniffed port.
        fn git(dir: &std::path::Path, args: &[&str]) {
            let out = std::process::Command::new("git")
                .args(args)
                .current_dir(dir)
                .output()
                .expect("git failed to spawn");
            assert!(out.status.success(), "git {args:?} failed: {:?}", out);
        }
        let dir = tempfile::tempdir().unwrap();
        let bare_dir = dir.path().join("origin.git");
        let work_dir = dir.path().join("author");
        std::fs::create_dir_all(&bare_dir).unwrap();
        std::fs::create_dir_all(&work_dir).unwrap();
        git(&bare_dir, &["init", "--bare", "-q"]);
        git(&work_dir, &["init", "-q", "-b", "main"]);
        git(&work_dir, &["config", "user.name", "Test User"]);
        git(&work_dir, &["config", "user.email", "test@example.com"]);
        std::fs::write(work_dir.join("f.txt"), "x").unwrap();
        git(&work_dir, &["add", "."]);
        git(&work_dir, &["commit", "-q", "-m", "initial"]);
        let bare_str = bare_dir.to_str().unwrap();
        git(&work_dir, &["remote", "add", "origin", bare_str]);
        git(&work_dir, &["push", "-q", "-u", "origin", "main"]);
        git(&bare_dir, &["symbolic-ref", "HEAD", "refs/heads/main"]);

        let sandbox = state
            .sandbox_manager
            .ensure(&crate::sandbox::GitSandboxConfig {
                virtual_mcp_id: "vmcp-proxy-test".to_string(),
                clone_url: bare_str.to_string(),
                branch: Some("main".to_string()),
                ..Default::default()
            })
            .await
            .expect("ensure succeeds against a real one-commit bare repo");
        sandbox
            .setup
            .transition_lifecycle(json!({"phase": "running", "port": 8123, "htmlSupport": false}));

        let mut headers = HeaderMap::new();
        headers.insert(
            crate::sandbox::SANDBOX_HANDLE_HEADER,
            HeaderValue::from_str(&sandbox.handle).unwrap(),
        );
        assert_eq!(dev_port(&state, &headers), Some(8123));
        // Headerless (the preview iframe) now follows the ACTIVE handle, which
        // `ensure()` set to this sandbox — so it serves the branch just run
        // (8123), NOT the process-global config port. An explicit re-focus
        // still works and is honored the same way.
        assert_eq!(dev_port(&state, &HeaderMap::new()), Some(8123));
        // A frontend-computed phantom cannot replace the durable active
        // sandbox. The known target remains selected after the rejection.
        assert_eq!(
            state
                .sandbox_manager
                .set_active("never-ensured-handle")
                .unwrap_err(),
            "unknown sandbox handle: never-ensured-handle"
        );
        assert_eq!(dev_port(&state, &HeaderMap::new()), Some(8123));
    }
}
