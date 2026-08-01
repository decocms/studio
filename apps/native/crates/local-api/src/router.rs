//! The route table — TWO separate routers, one per loopback listener (see
//! `lib.rs`'s `start`/`ServerHandle` doc comments for why: the app's own API
//! and the dev-server preview now live on distinct origins, verified by a
//! spike as necessary for SSE/WebSocket to stream cleanly through a
//! port-isolated cross-origin iframe in the real WKWebView). SHARED FILE
//! (see the native module-ownership contract) — adding, removing, or
//! re-pathing a route is a change here; family implementers edit their
//! `routes/*.rs` handler bodies, never this file's wiring. If a family
//! genuinely needs a new path this file doesn't have, that's an interface
//! request, not a local edit.
//!
//! ## [`build`] — the MAIN listener
//!
//! 1. Public zone — `GET /health`; in embedded mode also exact UI assets,
//!    HTML-navigation SPA fallback, and one-time `/_local/session/bootstrap`.
//! 2. `/_sandbox/*`, `/threads*`, `/models` — nested sub-routers, each
//!    wrapped in [`guard`] (standalone Origin + bearer, or embedded exact
//!    Host/unsafe-Origin + HttpOnly session cookie)
//!    and each with its own JSON-404 fallback so an unmatched path WITHIN
//!    one of these prefixes returns `{"error":"Not found: <path>"}` rather
//!    than falling through to the app-API fallback.
//! 3. Everything else (no matching prefix and not a public UI response) —
//!    [`app_or_ui_fallback`] authenticates, removes only the local control
//!    cookie, then invokes `routes::upstream::proxy`, the app-API
//!    intercept-or-proxy catchall. Formerly reached only via a
//!    `/upstream` prefix; a bare path now gets the exact same treatment,
//!    since the reverse-proxy family that used to share this fallback
//!    moved to its own listener (below). WRAPPED in [`guard]` — merged in
//!    from a small sub-router (`app_api`) that carries its own
//!    `.layer(guard)`, exactly like the zone-2 nests above (see [`build`]'s
//!    body for why `.merge()`, not `.nest()`, is what mounts it at the
//!    root with no path prefix).
//!
//! ## [`build_preview`] — the PREVIEW listener
//!
//! `routes::proxy::fallback` (the reverse-HTTP-proxy-to-dev-server catchall —
//! handle-header/active routing, the sniffed port, and the WS upgrade). No
//! local-api AUTHENTICATION is applied here: sandbox cookies and authorization
//! belong to the application under preview and are proxied unchanged. What IS
//! applied is [`preview_fence`], which removes local-api's own control cookie
//! and requires the `Host` to name a known sandbox — see its doc comment. An
//! explicitly enabled selftest route is the sole exception to the
//! otherwise-all-proxy route table, and is mounted outside the fence (it
//! answers on the bare host and proxies nowhere).
//!
//! ## OPTIONS preflight
//!
//! Intercepted by [`intercept_options`] as the OUTERMOST layer — before
//! ANY routing, including the zone-2 guards — so a preflight never risks a
//! 401/405. This is a deliberate reading of a genuinely ambiguous sentence
//! in the native local-API contract, which lists
//! "OPTIONS preflight" among examples of daemon-unauthenticated routes now
//! "tightened" to require the bearer. Taken completely literally that
//! would mean every real browser CORS preflight 401s (browsers never
//! attach `Authorization` to a preflight — that's the whole point of
//! preflight: ask permission BEFORE sending credentials), which would make
//! cross-origin `fetch()` from the embedded webview permanently broken.
//! No test in either suite pins OPTIONS-requires-bearer specifically (see
//! the bootstrap report). Implemented here: OPTIONS still enforces the
//! Origin allowlist (403 `forbidden_origin` on an unrecognized Origin,
//! matching the "checked before auth, fail fast" security posture) but
//! never the bearer. Flagged for the Phase 3 (Tauri shell) owner to
//! confirm against a real WKWebView preflight.

use std::sync::Arc;

use axum::extract::{Extension, OriginalUri, State};
use axum::http::{header, Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::Router;

use crate::client_auth::ClientAuth;
use crate::cors;
use crate::error::ApiError;
use crate::routes;
use crate::state::AppState;
use crate::ui::{self, UiAssetProvider};

type Request = axum::extract::Request;

#[derive(Clone)]
struct GuardState {
    auth: ClientAuth,
    mode: crate::state::ApiMode,
    agent_sessions: Arc<crate::terminal::AgentSessionRegistry>,
}

#[derive(Clone)]
struct MainRuntime {
    auth: ClientAuth,
    ui_assets: Option<Arc<dyn UiAssetProvider>>,
    preview_origin: Arc<str>,
}

pub fn build(
    state: AppState,
    auth: ClientAuth,
    ui_assets: Option<Arc<dyn UiAssetProvider>>,
    preview_origin: String,
) -> Router {
    let guard_state = GuardState {
        auth: auth.clone(),
        mode: state.mode,
        agent_sessions: state.agent_sessions.clone(),
    };
    let runtime = MainRuntime {
        auth: auth.clone(),
        ui_assets,
        preview_origin: preview_origin.into(),
    };
    let sandbox = Router::new()
        .route("/read", post(routes::fs::read))
        .route("/write", post(routes::fs::write))
        .route("/unlink", post(routes::fs::unlink))
        .route("/mkdir", post(routes::fs::mkdir))
        .route("/rename", post(routes::fs::rename))
        .route("/edit", post(routes::fs::edit))
        .route("/grep", post(routes::fs::grep))
        .route("/glob", post(routes::fs::glob))
        .route("/write_from_url", post(routes::fs::write_from_url))
        .route("/upload_to_url", post(routes::fs::upload_to_url))
        .route("/tools/sync", post(routes::fs::tools_sync))
        .route("/bash", post(routes::bash::bash))
        .route("/tasks", get(routes::tasks::list))
        .route("/tasks/kill-all", post(routes::tasks::kill_all))
        .route(
            "/tasks/:id",
            get(routes::tasks::get).delete(routes::tasks::delete),
        )
        .route("/tasks/:id/kill", post(routes::tasks::kill))
        .route("/tasks/:id/stream", get(routes::tasks::stream))
        .route("/git/status", get(routes::git::status))
        .route("/git/diff", get(routes::git::diff).post(routes::git::diff))
        .route("/git/publish", post(routes::git::publish))
        .route("/git/discard", post(routes::git::discard))
        .route("/git/rebase", post(routes::git::rebase))
        .route(
            "/config",
            get(routes::config::read)
                .post(routes::config::update)
                .put(routes::config::update),
        )
        .route("/setup/clone", post(routes::setup::clone))
        .route("/setup/install", post(routes::setup::install))
        .route("/setup/ensure", post(routes::setup::ensure))
        .route("/setup/start", post(routes::setup::start))
        // NEW — no daemon precedent (see routes::setup::stop's own doc
        // comment): kills the resolved target's running dev/start task
        // WITHOUT respawning, giving the sandbox drawer's Stop button a
        // real desktop-local action to call.
        .route("/setup/stop", post(routes::setup::stop))
        .route("/orgfs-config", post(routes::orgfs::orgfs_config))
        // `/_sandbox/orgfs/:org/:volume/**` — the loopback WebDAV surface
        // rclone mounts as the org filesystem (P1 of
        // `apps/native/docs/org-fs-plan.md`). Nested as a catchall rather
        // than routed per path/method: everything after `<org>/<volume>` is
        // the in-volume path, and PROPFIND/MKCOL/MOVE are extension methods
        // `axum::routing` has no filter for. Nested BEFORE `.layer(guard)`
        // below so it inherits the same Origin + bearer/cookie
        // authentication every other `/_sandbox` route gets.
        .nest("/orgfs", routes::webdav::router())
        .route("/scripts", get(routes::scripts::list))
        .route("/exec/:name", post(routes::scripts::exec))
        .route("/exec/:name/kill", post(routes::scripts::exec_kill))
        .route("/events", get(routes::events::events))
        .route("/dispatch", post(routes::dispatch::dispatch))
        .route("/runs/:id", delete(routes::dispatch::cancel_run))
        .route("/preview-handle", post(routes::proxy::set_preview_handle))
        // GET /_sandbox/repo-dir — see routes::repo_dir's module doc (a
        // git-backed sandbox's absolute workdir, for the webview's
        // "Open in VS Code/Cursor" deep link).
        .route("/repo-dir", get(routes::repo_dir::get))
        .fallback(sandbox_not_found)
        .layer(middleware::from_fn_with_state(guard_state.clone(), guard));

    let threads = Router::new()
        .route(
            "/",
            get(routes::threads::list).post(routes::threads::create),
        )
        .route(
            "/:id",
            get(routes::threads::get)
                .patch(routes::threads::update)
                .delete(routes::threads::delete),
        )
        .route(
            "/:id/messages",
            get(routes::threads::messages_list).post(routes::threads::messages_create),
        )
        .route("/:id/runs", get(routes::threads::runs_list))
        .fallback(sandbox_not_found)
        .layer(middleware::from_fn_with_state(guard_state.clone(), guard));

    let models = Router::new()
        .route("/", get(routes::models::list))
        .layer(middleware::from_fn_with_state(guard_state.clone(), guard));

    // Literal internal app-API routes. The general app-API catchall is owned
    // by `app_or_ui_fallback`, where public UI navigation can be distinguished
    // from a private upstream request before authentication is selected.
    let app_api = Router::new()
        // Literal route, matched BEFORE the app-API `proxy` fallback below
        // — see `routes/upstream.rs::complete_session`'s doc comment for
        // why this HTTP mirror of the `auth_complete_session` Tauri command
        // exists (the e2e contract suite has no Tauri context to invoke IPC
        // commands through). Renamed from the old `/upstream/_complete_session`
        // now that the `/upstream` prefix is gone — a stable, collision-free
        // bare path under its own `/_auth` namespace (distinct from any
        // `/api/*` path a real mesh org might route).
        .route(
            "/_auth/complete-session",
            post(routes::upstream::complete_session),
        )
        // Black-box mirror of the Tauri `auth_status` command. Kept beside
        // the existing complete-session/logout mirrors so all three observe
        // the same process-wide upstream session.
        .route("/_auth/status", get(routes::upstream::status))
        // Same rationale as `/_auth/complete-session` right above — see
        // `routes/upstream.rs::logout`'s doc comment. Renamed from
        // `/upstream/_logout`.
        .route("/_auth/logout", post(routes::upstream::logout))
        .route(
            "/api/:org/threads/:thread_id/terminal",
            get(routes::terminal::get)
                .post(routes::terminal::start)
                .delete(routes::terminal::delete),
        )
        .route(
            "/api/:org/threads/:thread_id/terminal/ws",
            get(routes::terminal::websocket),
        )
        // The WEBVIEW half of the browser-completed MCP OAuth flow. Guarded
        // like everything else here: a parked authorization code must only be
        // readable by a caller that proved it is this app. Its unauthenticated
        // sibling — the redirect target the system browser actually lands on —
        // is registered outside this layer; see `routes::mcp_callback`.
        .route(
            "/_auth/mcp-callback/result",
            get(routes::mcp_callback::result).delete(routes::mcp_callback::discard),
        )
        // Apply a staged self-update by restarting through the graceful
        // shutdown pipeline — see routes::update's module doc. Lives in this
        // guard-carrying sub-router deliberately: a top-level `.route()`
        // would get only `require_expected_host` (no Origin check on POST,
        // no session cookie), i.e. an unauthenticated restart trigger.
        // Mounted in BOTH auth modes so the standalone binary answers its
        // documented 409 and the e2e auth matrix can cover the route.
        .route("/_local/update/restart", post(routes::update::restart))
        .layer(middleware::from_fn_with_state(guard_state.clone(), guard));

    let mut app = Router::new()
        .route("/health", get(routes::health::health))
        // Provider children cannot use the webview cookie. This endpoint has
        // its own random per-terminal bearer and remains behind the outer
        // exact-Host fence.
        .route(
            "/_local/agent-hooks/:session_id",
            post(routes::agent_hooks::receive),
        )
        // CORS-only — `.route_layer()` wraps ONLY the routes registered so
        // far (`/health` and the token-authenticated hook receiver), never the
        // `.nest()`ed zone-2 routers below (each
        // already wrapped in the full `guard`, applied independently) or
        // `app_api`'s own fallback merged in next (same reasoning — it
        // carries its own `guard`). See [`cors_only`]'s doc comment for why
        // these public-auth-zone routes need this at all.
        .route_layer(middleware::from_fn_with_state(
            guard_state.clone(),
            cors_only,
        ))
        .nest("/_sandbox", sandbox)
        .nest("/threads", threads)
        .nest("/models", models)
        // `.merge()`, not `.nest()`: these literal routes live at the root.
        .merge(app_api)
        // Registered OUTSIDE `guard`, deliberately. This is where an MCP
        // OAuth provider redirects the user's SYSTEM BROWSER, which has no
        // per-launch session cookie and no way to be given one, so requiring
        // it would 401 every consent that just succeeded. It is not the
        // security boundary — the webview keeps `state` in memory and rejects
        // any callback that does not match it — and it only ever parks bytes;
        // reading them back still requires the guard. See
        // `routes::mcp_callback`'s doc comment.
        .route("/_auth/mcp-callback", get(routes::mcp_callback::receive));

    if auth.is_embedded() {
        let private_session = Router::new()
            .route("/_local/session", get(session_status))
            .layer(middleware::from_fn_with_state(guard_state.clone(), guard));
        app = app.merge(private_session).route(
            "/_local/session/bootstrap",
            post(bootstrap_embedded_session),
        );
    }

    app.fallback(app_or_ui_fallback)
        .layer(middleware::from_fn_with_state(
            guard_state,
            intercept_options,
        ))
        .layer(Extension(runtime))
        // Exact Host validation is intentionally outermost so public UI,
        // health, bootstrap, OPTIONS, and private routes share the same
        // DNS-rebinding boundary.
        .layer(middleware::from_fn_with_state(auth, require_expected_host))
        // …and authority normalization sits outside even that, because it is
        // what makes `Host` present at all. See [`normalize_authority`].
        .layer(middleware::from_fn(normalize_authority))
        .with_state(state)
}

/// Restore `Host` from the HTTP/2 `:authority` pseudo-header.
///
/// HTTP/2 REPLACED `Host` with `:authority` (RFC 9113 §8.3.1), which hyper
/// surfaces on the request URI rather than in the header map. Every host check
/// in this process reads the `Host` header, so an h2 request arrives looking
/// like it has no host at all and each of them fails closed: the preview fence
/// 404s a perfectly valid sandbox, and `require_expected_host` would 403 the
/// entire API.
///
/// That is not hypothetical — both listeners terminate TLS, ALPN offers h2,
/// and every modern client takes it (WKWebView, which IS the shipped app's
/// browser, and `curl` without `--http1.1`). It went unnoticed because the
/// dev webview reaches the API through Vite on its own port, and because the
/// preview proxy silently fell back to the ACTIVE sandbox whenever it could
/// not read a host — a fallback the fence has now removed.
///
/// Normalizing ONCE, outermost, rather than teaching each check about both
/// shapes: there is exactly one place to get right, and a check added later
/// inherits the fix instead of re-introducing the bug. `:authority` wins over
/// any `Host` an h2 client also sent, as the RFC requires. An HTTP/1.1
/// origin-form request has no authority on the URI, so its `Host` is left
/// exactly as received.
async fn normalize_authority(mut req: Request, next: Next) -> Response {
    if let Some(authority) = req.uri().authority().map(|value| value.as_str().to_owned()) {
        match axum::http::HeaderValue::from_str(&authority) {
            Ok(value) => {
                req.headers_mut().insert(header::HOST, value);
            }
            Err(_) => return ApiError::forbidden_origin().into_response(),
        }
    }
    next.run(req).await
}

/// The PREVIEW listener's router — see the module doc's "[`build_preview`]
/// — the PREVIEW listener" section. Application cookies and authorization
/// headers reach the selected sandbox unchanged; local-api's OWN control
/// cookie never does — see [`preview_fence`].
///
/// `preview_host_base`: the registrable host previews are served under
/// (`preview_url`'s base). Passed in rather than read from the process-global
/// so the fence is a function of its arguments and can be tested.
pub fn build_preview(
    state: AppState,
    preview_port: u16,
    preview_host_base: &str,
    cookie_selftest_control_origin: Option<Arc<str>>,
) -> Router {
    let fence = PreviewFence {
        state: state.clone(),
        // Only a registrable base has per-handle preview hosts to fence on;
        // under a single-label host (`localhost`) every sandbox shares one
        // origin, so there is no label to check. Mirrors `preview_url`'s gate.
        base: preview_host_base
            .contains('.')
            .then(|| Arc::<str>::from(preview_host_base.to_ascii_lowercase())),
    };
    let mut app = Router::new()
        .fallback(routes::proxy::fallback)
        .layer(middleware::from_fn_with_state(fence, preview_fence));
    if let Some(control_origin) = cookie_selftest_control_origin {
        app = app
            .route(
                "/_local/selftest/preview-cookie",
                get(routes::proxy::preview_cookie_selftest)
                    .options(routes::proxy::preview_cookie_selftest),
            )
            .route(
                "/_local/selftest/preview-frame",
                get(routes::proxy::preview_frame_selftest),
            )
            .layer(Extension(routes::proxy::PreviewCookieSelftest {
                control_origin,
                expected_host: Arc::from(format!("localhost:{preview_port}")),
                cookie_value: Arc::from(uuid::Uuid::new_v4().simple().to_string()),
            }));
    }
    // Outermost, so the fence AND the selftest's own Host check both see a
    // `Host` on an h2 request — see [`normalize_authority`].
    app.layer(middleware::from_fn(normalize_authority))
        .with_state(state)
}

#[derive(Clone)]
struct PreviewFence {
    state: AppState,
    /// `Some` only when previews get per-handle hosts — see [`build_preview`].
    base: Option<Arc<str>>,
}

/// The preview listener's ONLY pre-routing step, and the reason the listener
/// can serve untrusted sandbox output at all.
///
/// Cookies ignore the port (RFC 6265 §8.5), so the control cookie set on the
/// browser origin is attached to any same-site request — including one a
/// PREVIEWED page makes back at this listener. Two independent things stop
/// that from becoming a privilege escalation:
///
/// 1. The control cookie is removed from every request, unconditionally. This
///    listener has no route that consumes it, and everything it does serve is
///    forwarded verbatim into a sandbox's own dev server, which must never see
///    it. Application cookies are untouched.
/// 2. The `Host` must name a sandbox this process knows. Without this, a
///    request arriving on the BARE control host resolved through
///    `resolve_preview`'s `active()` fallback and was proxied into whichever
///    sandbox happened to be focused.
///
/// Either alone would close the reported path; both are here because they fail
/// independently — 1 survives a routing change, 2 survives a header-handling
/// change.
async fn preview_fence(
    State(fence): State<PreviewFence>,
    mut req: Request,
    next: Next,
) -> Response {
    crate::client_auth::remove_local_session_cookie(req.headers_mut());
    if let Some(base) = fence.base.as_deref() {
        if !names_a_known_sandbox(&fence.state, req.headers(), base) {
            return ApiError::not_found("Not found").into_response();
        }
    }
    next.run(req).await
}

/// Whether `Host` is `<label>.<base>` for a `label` the sandbox manager
/// currently maps to a handle. Deliberately strict: exactly one label, and the
/// bare `base` itself is NOT accepted.
fn names_a_known_sandbox(state: &AppState, headers: &axum::http::HeaderMap, base: &str) -> bool {
    let Some(host) = headers.get(header::HOST).and_then(|v| v.to_str().ok()) else {
        return false;
    };
    let host = host
        .split(':')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    let Some(label) = host
        .strip_suffix(base)
        .and_then(|rest| rest.strip_suffix('.'))
    else {
        return false;
    };
    !label.is_empty()
        && !label.contains('.')
        && state
            .sandbox_manager
            .handle_for_preview_label(label)
            .is_some()
}

/// `{"error":"Not found: <full request path>"}` — byte-parity in spirit
/// with the daemon's `vmRouteH` default branch
/// (`jsonResponse({ error: \`Not found: ${prefix}${vmPath}\` }, 404)`).
/// Uses `OriginalUri` (not the post-`nest()` rewritten `Uri`) so the
/// message carries the full path a caller actually requested, e.g.
/// `/_sandbox/does-not-exist`, not the nest-relative `/does-not-exist`.
async fn sandbox_not_found(OriginalUri(uri): OriginalUri) -> ApiError {
    ApiError::not_found(format!("Not found: {}", uri.path()))
}

/// Standalone: Origin allowlist then bearer auth. Embedded: exact Host,
/// exact Origin on unsafe methods, then the per-launch session cookie.
/// Applied to every zone-2 sub-router (`/_sandbox`, `/threads`, `/models`)
/// AND to `app_api` (the merged-in, no-prefix app-API fallback + its
/// `/_auth/*` literal routes), including their own 404 fallbacks, via
/// `.layer()` (not `.route_layer()`, which would skip the fallback and let
/// an unauthenticated caller enumerate unmatched routes without ever
/// proving caller authority).
async fn guard(State(state): State<GuardState>, mut req: Request, next: Next) -> Response {
    let decision = match authorize_private(&state, &mut req) {
        Ok(decision) => decision,
        Err(error) => return error.into_response(),
    };
    let mut response = next.run(req).await;
    if let Some(decision) = decision {
        cors::apply_headers(response.headers_mut(), &decision);
    }
    response
}

/// CORS-only half of [`guard`] — validates `Origin` and applies the
/// `Access-Control-Allow-Origin`/`Vary` headers, but never checks the
/// bearer. Applied via `.route_layer()` to `GET /health` and the provider
/// hook receiver; the latter enforces its own random per-terminal bearer.
///
/// `/health` is intentionally unauthenticated in both states
/// (the native local-API contract, byte-parity with the daemon), but the
/// contract's `#origin-validation--cors` section is explicit that "**every
/// request** (including simple GETs)" gets Origin-checked and CORS-headed —
/// the original bootstrap wired `/health` directly on the top-level router
/// with no CORS treatment at all, so a real cross-origin `fetch()` from the
/// webview (`tauri://localhost` -> `http://127.0.0.1:<port>`) got a `200`
/// with no `Access-Control-Allow-Origin` header, which the browser's own
/// CORS enforcement then turns into an opaque network-error at the
/// `fetch()` call site. Discovered by Phase 3's self-test
/// (`src-tauri/selftest/bundle.js`'s `health200NoAuth` check — see
/// the native Tauri integration's "Discovered gap" section, now fixed here).
async fn cors_only(State(state): State<GuardState>, req: Request, next: Next) -> Response {
    if state.auth.is_embedded() {
        return next.run(req).await;
    }
    let decision = cors::validate(req.headers(), state.mode);
    if !decision.allowed {
        return ApiError::forbidden_origin().into_response();
    }
    let mut res = next.run(req).await;
    cors::apply_headers(res.headers_mut(), &decision);
    res
}

/// See the module doc comment's "OPTIONS preflight" section for why this
/// is the outermost layer and never requires the bearer.
async fn intercept_options(State(state): State<GuardState>, req: Request, next: Next) -> Response {
    if req.method() != Method::OPTIONS {
        return next.run(req).await;
    }
    if let Err(error) = state.auth.require_expected_host(req.headers()) {
        return error.into_response();
    }
    if state.auth.is_embedded() {
        if let Err(error) = state.auth.require_exact_origin(req.headers()) {
            return error.into_response();
        }
        return StatusCode::NO_CONTENT.into_response();
    }
    let decision = cors::validate(req.headers(), state.mode);
    if !decision.allowed {
        return ApiError::forbidden_origin().into_response();
    }
    let mut res = StatusCode::NO_CONTENT.into_response();
    cors::apply_headers(res.headers_mut(), &decision);
    let headers = res.headers_mut();
    headers.insert(
        axum::http::header::ACCESS_CONTROL_ALLOW_METHODS,
        axum::http::HeaderValue::from_static("GET, POST, PUT, PATCH, DELETE"),
    );
    // Echo the requested headers back for an allowed origin instead of
    // maintaining a hardcoded list: the origin allowlist is the actual
    // security boundary here, and a fixed list silently breaks any client
    // that adds a header (found live: the MCP client's
    // `mcp-protocol-version` — which mesh's own CORS allowlists — was
    // rejected by this preflight, killing every /api/:org/mcp/* call in
    // the webview). Fall back to the static set when no header was asked.
    let allow_headers = req
        .headers()
        .get(axum::http::header::ACCESS_CONTROL_REQUEST_HEADERS)
        .cloned()
        .unwrap_or_else(|| {
            axum::http::HeaderValue::from_static("Content-Type, Accept, Authorization")
        });
    headers.insert(
        axum::http::header::ACCESS_CONTROL_ALLOW_HEADERS,
        allow_headers,
    );
    res
}

async fn require_expected_host(
    State(auth): State<ClientAuth>,
    req: Request,
    next: Next,
) -> Response {
    if let Err(error) = auth.require_expected_host(req.headers()) {
        return error.into_response();
    }
    next.run(req).await
}

fn authorize_private(
    state: &GuardState,
    req: &mut Request,
) -> Result<Option<cors::OriginDecision>, ApiError> {
    state.auth.require_expected_host(req.headers())?;
    if state.auth.is_embedded() {
        // Provider children receive a distinct per-terminal capability, never
        // the browser's whole-API cookie. It bypasses browser Origin checks
        // only for the one exact encoded MCP path registered at launch.
        if scoped_agent_bearer(req.headers()).is_some_and(|candidate| {
            state
                .agent_sessions
                .authorizes_mcp(full_request_path(req), candidate)
        }) {
            return Ok(None);
        }
        state
            .auth
            .require_unsafe_origin(req.method(), req.headers())?;
        // The org-filesystem WebDAV surface additionally accepts the narrow
        // mount credential, so `rclone` no longer needs the control cookie
        // that unlocks the whole API. Scoped by PATH here rather than by a
        // separate router so there is exactly one place the two credentials
        // are compared, and so every other route keeps rejecting it.
        if !(is_org_filesystem_path(req) && state.auth.mount_token_matches(req.headers())) {
            state.auth.require_private(req.headers())?;
        }
        Ok(None)
    } else {
        let decision = cors::validate(req.headers(), state.mode);
        if !decision.allowed {
            return Err(ApiError::forbidden_origin());
        }
        state.auth.require_private(req.headers())?;
        Ok(Some(decision))
    }
}

fn scoped_agent_bearer(headers: &axum::http::HeaderMap) -> Option<&str> {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .filter(|value| !value.is_empty())
}

fn full_request_path(req: &Request) -> &str {
    req.extensions()
        .get::<OriginalUri>()
        .map_or_else(|| req.uri().path(), |uri| uri.0.path())
}

/// The org-filesystem WebDAV prefix, judged on the FULL request path.
///
/// `guard` runs inside each `nest()`, where `req.uri()` has already had the
/// prefix stripped — so a `/threads` route could otherwise be reached at the
/// nest-relative `/orgfs/…`. `OriginalUri` (which `nest` always inserts) is
/// the pre-strip path; the fallback covers the un-nested `app_api` merge,
/// where no stripping happened and the two are the same.
fn is_org_filesystem_path(req: &Request) -> bool {
    full_request_path(req).starts_with("/_sandbox/orgfs/")
}

async fn bootstrap_embedded_session(
    Extension(runtime): Extension<MainRuntime>,
    req: Request,
) -> Response {
    let (parts, body) = req.into_parts();
    if let Err(error) = runtime.auth.require_expected_host(&parts.headers) {
        return error.into_response();
    }
    if let Err(error) = runtime.auth.require_exact_origin(&parts.headers) {
        return error.into_response();
    }
    match axum::body::to_bytes(body, 1).await {
        Ok(bytes) if bytes.is_empty() => {}
        Ok(_) | Err(_) => {
            return ApiError::bad_request("bootstrap body must be empty").into_response()
        }
    }
    let set_cookie = match runtime.auth.consume_bootstrap(&parts.headers) {
        Ok(cookie) => cookie,
        Err(error) => return error.into_response(),
    };
    let mut response = StatusCode::NO_CONTENT.into_response();
    match axum::http::HeaderValue::from_str(&set_cookie) {
        Ok(value) => {
            response.headers_mut().insert(header::SET_COOKIE, value);
            response
        }
        Err(_) => ApiError::unauthorized().into_response(),
    }
}

async fn session_status() -> StatusCode {
    StatusCode::NO_CONTENT
}

async fn app_or_ui_fallback(
    State(state): State<AppState>,
    Extension(runtime): Extension<MainRuntime>,
    mut req: Request,
) -> Response {
    if let Some(response) = try_serve_ui(&runtime, &req) {
        return response;
    }

    let guard_state = GuardState {
        auth: runtime.auth,
        mode: state.mode,
        agent_sessions: state.agent_sessions.clone(),
    };
    let decision = match authorize_private(&guard_state, &mut req) {
        Ok(decision) => decision,
        Err(error) => return error.into_response(),
    };
    // The control credential is only for webview -> local-api. Remove that
    // named cookie (and no application cookies) at the Studio proxy boundary;
    // sandbox handlers and the preview proxy never pass through here.
    crate::client_auth::remove_local_session_cookie(req.headers_mut());
    let mut response = routes::upstream::proxy(State(state), req).await;
    if let Some(decision) = decision {
        cors::apply_headers(response.headers_mut(), &decision);
    }
    response
}

fn try_serve_ui(runtime: &MainRuntime, req: &Request) -> Option<Response> {
    let provider = runtime.ui_assets.as_ref()?;
    if !matches!(*req.method(), Method::GET | Method::HEAD) {
        return None;
    }
    let path = req.uri().path();
    if is_reserved_api_path(path) {
        return None;
    }
    if !ui::is_safe_asset_path(path) {
        return Some(ApiError::not_found("Not found").into_response());
    }
    // Browsers request bundle files percent-encoded (`/logos/deco%20logo.svg`
    // for the on-disk `logos/deco logo.svg`) while providers do exact
    // raw-path lookup. Decoding is only safe AFTER `is_safe_asset_path`: it
    // rejects every encoded traversal byte (%2e/%2f/%5c) on the raw path, so
    // a decode can change a file name, never the directory structure. An
    // undecodable path (invalid UTF-8 escape) stays raw and can only miss.
    let decoded = urlencoding::decode(path).unwrap_or(std::borrow::Cow::Borrowed(path));
    let path = decoded.as_ref();

    if matches!(path, "/" | "/index.html") {
        return Some(index_response(provider, runtime, req.method()));
    }
    if let Some(asset) = provider.asset(path) {
        return Some(ui::asset_response(asset, req.method()));
    }
    if is_spa_navigation(req) {
        return Some(index_response(provider, runtime, req.method()));
    }
    if last_segment_has_extension(path) {
        return Some(ApiError::not_found("Not found").into_response());
    }
    None
}

fn index_response(
    provider: &Arc<dyn UiAssetProvider>,
    runtime: &MainRuntime,
    method: &Method,
) -> Response {
    let Some(index) = provider.index() else {
        return ApiError::not_found("UI index not found").into_response();
    };
    ui::index_response(
        index,
        method,
        &provider.content_security_policy(),
        &runtime.preview_origin,
    )
}

fn is_spa_navigation(req: &Request) -> bool {
    req.headers()
        .get(header::ACCEPT)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|accept| {
            accept
                .split(',')
                .any(|value| value.trim().starts_with("text/html"))
        })
}

fn last_segment_has_extension(path: &str) -> bool {
    path.rsplit('/')
        .next()
        .is_some_and(|segment| segment.contains('.'))
}

fn is_reserved_api_path(path: &str) -> bool {
    const PREFIXES: &[&str] = &[
        "/api",
        "/mcp",
        "/oauth-proxy",
        "/.well-known",
        "/org",
        "/_auth",
        "/_local",
        "/_sandbox",
        "/threads",
        "/models",
        "/health",
        "/metrics",
    ];
    PREFIXES
        .iter()
        .any(|prefix| path == *prefix || path.starts_with(&format!("{prefix}/")))
}

#[cfg(test)]
mod tests {
    use axum::body::{to_bytes, Body};
    use axum::http::{Request as HttpRequest, Uri};
    use bytes::Bytes;
    use tower::ServiceExt;

    use super::*;
    use crate::ui::UiAsset;

    struct TestAssets;

    impl UiAssetProvider for TestAssets {
        fn asset(&self, path: &str) -> Option<UiAsset> {
            match path {
                "/assets/app.abc.js" => Some(UiAsset::new(
                    Bytes::from_static(b"console.log('ok')"),
                    "text/javascript",
                    "public, max-age=31536000, immutable",
                )),
                // Space in the file name on purpose: the real bundle ships
                // `logos/deco logo.svg`, which browsers request as
                // `/logos/deco%20logo.svg`.
                "/logos/deco logo.svg" => Some(UiAsset::new(
                    Bytes::from_static(b"<svg/>"),
                    "image/svg+xml",
                    "no-cache",
                )),
                _ => None,
            }
        }

        fn index(&self) -> Option<UiAsset> {
            Some(UiAsset::new(
                Bytes::from_static(b"<!doctype html><div id=\"root\"></div>"),
                "text/html; charset=utf-8",
                "public, max-age=60",
            ))
        }

        fn content_security_policy(&self) -> String {
            "default-src 'self'; connect-src 'self'; frame-src 'none'".into()
        }
    }

    fn embedded_router() -> (Router, tempfile::TempDir) {
        let root = tempfile::tempdir().unwrap();
        let state = crate::routes::intercept::test_state(root.path());
        let auth = ClientAuth::embedded(
            vec!["127.0.0.1:43120".into()],
            "http://127.0.0.1:43120".into(),
            vec!["one-time-bootstrap".into()],
            "test-session-token".into(),
            "test-mount-token".into(),
        )
        .unwrap();
        (
            build(
                state,
                auth,
                Some(Arc::new(TestAssets)),
                "http://localhost:61234".into(),
            ),
            root,
        )
    }

    fn request(method: Method, uri: &str) -> axum::extract::Request {
        HttpRequest::builder()
            .method(method)
            .uri(uri)
            .header(header::HOST, "127.0.0.1:43120")
            .body(Body::empty())
            .unwrap()
    }

    async fn bootstrap(app: &Router) -> (StatusCode, String) {
        let mut req = request(Method::POST, "/_local/session/bootstrap");
        req.headers_mut().insert(
            header::ORIGIN,
            axum::http::HeaderValue::from_static("http://127.0.0.1:43120"),
        );
        req.headers_mut().insert(
            header::AUTHORIZATION,
            axum::http::HeaderValue::from_static("Bearer one-time-bootstrap"),
        );
        let response = app.clone().oneshot(req).await.unwrap();
        let cookie = response
            .headers()
            .get(header::SET_COOKIE)
            .unwrap()
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap()
            .to_string();
        (response.status(), cookie)
    }

    #[tokio::test]
    async fn public_index_and_exact_assets_need_no_cookie_and_get_http_security_headers() {
        let (app, _root) = embedded_router();
        let index = app
            .clone()
            .oneshot(request(Method::GET, "/"))
            .await
            .unwrap();
        assert_eq!(index.status(), StatusCode::OK);
        assert_eq!(index.headers()[header::CACHE_CONTROL], "no-store");
        let csp = index.headers()[header::CONTENT_SECURITY_POLICY]
            .to_str()
            .unwrap();
        assert!(csp.contains("connect-src 'self' http://localhost:61234 ws://localhost:61234"));
        assert!(csp.contains("frame-src http://localhost:61234"));

        let asset = app
            .oneshot(request(Method::GET, "/assets/app.abc.js"))
            .await
            .unwrap();
        assert_eq!(asset.status(), StatusCode::OK);
        assert_eq!(
            asset.headers()[header::CACHE_CONTROL],
            "public, max-age=31536000, immutable"
        );
        assert_eq!(asset.headers()[header::CONTENT_TYPE], "text/javascript");
    }

    #[tokio::test]
    async fn percent_encoded_asset_paths_decode_before_lookup_but_traversal_stays_rejected() {
        let (app, _root) = embedded_router();

        let logo = app
            .clone()
            .oneshot(request(Method::GET, "/logos/deco%20logo.svg"))
            .await
            .unwrap();
        assert_eq!(logo.status(), StatusCode::OK);
        assert_eq!(logo.headers()[header::CONTENT_TYPE], "image/svg+xml");

        // Decoding must never open up traversal: encoded dot/slash/backslash
        // bytes are rejected on the RAW path, before any decode happens.
        for path in [
            "/logos/%2e%2e/secret.svg",
            "/logos/..%2Fsecret.svg",
            "/logos/%5c..%5csecret.svg",
        ] {
            assert_eq!(
                app.clone()
                    .oneshot(request(Method::GET, path))
                    .await
                    .unwrap()
                    .status(),
                StatusCode::NOT_FOUND,
                "{path} should stay rejected"
            );
        }
    }

    #[tokio::test]
    async fn preview_cookie_probe_is_explicitly_enabled_and_plain_localhost_bound() {
        let enabled_root = tempfile::tempdir().unwrap();
        let enabled = build_preview(
            crate::routes::intercept::test_state(enabled_root.path()),
            61234,
            "localhost",
            Some(Arc::from("http://localhost:43120")),
        );
        let probe = || {
            HttpRequest::builder()
                .method(Method::GET)
                .uri("/_local/selftest/preview-cookie")
                .header(header::HOST, "localhost:61234")
                .header(header::ORIGIN, "http://localhost:43120")
                .body(Body::empty())
                .unwrap()
        };
        let frame = enabled
            .clone()
            .oneshot(
                HttpRequest::builder()
                    .method(Method::GET)
                    .uri("/_local/selftest/preview-frame")
                    .header(header::HOST, "localhost:61234")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(frame.status(), StatusCode::OK);
        let frame_body = to_bytes(frame.into_body(), usize::MAX).await.unwrap();
        assert!(String::from_utf8_lossy(&frame_body).contains("decocms-preview-selftest-ready"));

        let mut first_request = probe();
        first_request.headers_mut().insert(
            header::COOKIE,
            axum::http::HeaderValue::from_static("decocms-preview-selftest=stale-persistent-value"),
        );
        let first = enabled.clone().oneshot(first_request).await.unwrap();
        assert_eq!(first.status(), StatusCode::OK);
        assert_eq!(
            first.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN],
            "http://localhost:43120"
        );
        assert_eq!(
            first.headers()[header::ACCESS_CONTROL_ALLOW_CREDENTIALS],
            "true"
        );
        let cookie = first.headers()[header::SET_COOKIE]
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap()
            .to_string();
        assert_ne!(cookie, "decocms-preview-selftest=stale-persistent-value");
        let first_body = to_bytes(first.into_body(), usize::MAX).await.unwrap();
        assert_eq!(first_body.as_ref(), br#"{"received":false}"#);
        let mut second_request = probe();
        second_request.headers_mut().insert(
            header::COOKIE,
            axum::http::HeaderValue::from_str(&cookie).unwrap(),
        );
        let second = enabled.oneshot(second_request).await.unwrap();
        let body = to_bytes(second.into_body(), usize::MAX).await.unwrap();
        assert_eq!(body.as_ref(), br#"{"received":true}"#);

        let disabled_root = tempfile::tempdir().unwrap();
        let disabled = build_preview(
            crate::routes::intercept::test_state(disabled_root.path()),
            61234,
            "localhost",
            None,
        );
        let response = disabled.oneshot(probe()).await.unwrap();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert!(response.headers().get(header::SET_COOKIE).is_none());
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        assert!(String::from_utf8_lossy(&body).contains("No dev server running"));
    }

    /// An h2 request carries its authority on the URI, not in a `Host` header
    /// — and both listeners terminate TLS, so h2 is what the shipped app's
    /// WKWebView actually speaks. Every host check in this process reads
    /// `Host`, so without normalization the preview fence 404s a valid sandbox
    /// and the whole API 403s.
    #[tokio::test]
    async fn an_http2_authority_is_honoured_wherever_a_host_header_would_be() {
        let root = tempfile::tempdir().unwrap();
        let state = crate::routes::intercept::test_state(root.path());
        let handle = state
            .sandbox_manager
            .register_for_test("https://github.com/acme/site.git", "work");
        let label = crate::sandbox::preview_label(&handle);
        let preview = build_preview(state, 61234, "local.studio.decocms.com", None);

        // No `Host` header anywhere — exactly how hyper presents h2.
        let h2 = |uri: String| {
            HttpRequest::builder()
                .method(Method::GET)
                .uri(uri)
                .body(Body::empty())
                .unwrap()
        };
        assert_eq!(
            preview
                .clone()
                .oneshot(h2(format!(
                    "https://{label}.local.studio.decocms.com:61234/"
                )))
                .await
                .unwrap()
                .status(),
            StatusCode::SERVICE_UNAVAILABLE,
            "the fence resolves the sandbox from :authority"
        );
        assert_eq!(
            preview
                .oneshot(h2("https://local.studio.decocms.com:61234/".into()))
                .await
                .unwrap()
                .status(),
            StatusCode::NOT_FOUND,
            "and still refuses the bare control host over h2"
        );

        let (app, _root) = embedded_router();
        assert_eq!(
            app.clone()
                .oneshot(h2("http://127.0.0.1:43120/".into()))
                .await
                .unwrap()
                .status(),
            StatusCode::OK,
            "the main listener authenticates the h2 authority as its host"
        );
        assert_eq!(
            app.oneshot(h2("http://attacker.example.com:43120/".into()))
                .await
                .unwrap()
                .status(),
            StatusCode::FORBIDDEN,
            "and a foreign h2 authority is still a rebinding attempt"
        );
    }

    /// `rclone` mounts the org filesystem as a plain HTTP client and used to
    /// carry the control cookie to do it — a whole-API credential handed to a
    /// child process. It now gets a credential the guard honours on the WebDAV
    /// surface ONLY, so reading it out of that child buys nothing else.
    #[tokio::test]
    async fn the_mount_credential_unlocks_the_org_filesystem_and_nothing_else() {
        let (app, _root) = embedded_router();
        let mounted = |uri: &str, method: Method| {
            let mut req = request(method, uri);
            req.headers_mut().insert(
                crate::client_auth::MOUNT_TOKEN_HEADER,
                axum::http::HeaderValue::from_static("test-mount-token"),
            );
            req.headers_mut().insert(
                header::ORIGIN,
                axum::http::HeaderValue::from_static("http://127.0.0.1:43120"),
            );
            app.clone().oneshot(req)
        };

        assert_ne!(
            mounted("/_sandbox/orgfs/acme/public/", Method::GET)
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED,
            "the WebDAV surface accepts it"
        );
        for denied in [
            "/_sandbox/bash",
            "/_sandbox/read",
            "/_sandbox/git/publish",
            "/threads",
            "/api/acme/tools/ANYTHING",
            // Not under `orgfs` despite naming it — a prefix, not a substring.
            "/_sandbox/orgfs-config",
        ] {
            assert_eq!(
                mounted(denied, Method::POST).await.unwrap().status(),
                StatusCode::UNAUTHORIZED,
                "{denied} must not accept the mount credential"
            );
        }

        let mut wrong = request(Method::GET, "/_sandbox/orgfs/acme/public/");
        wrong.headers_mut().insert(
            crate::client_auth::MOUNT_TOKEN_HEADER,
            axum::http::HeaderValue::from_static("not-the-mount-token"),
        );
        assert_eq!(
            app.oneshot(wrong).await.unwrap().status(),
            StatusCode::UNAUTHORIZED
        );
    }

    #[test]
    fn terminal_mcp_bearer_bypasses_browser_auth_for_one_exact_path_only() {
        let root = tempfile::tempdir().unwrap();
        let app_state = crate::routes::intercept::test_state(root.path());
        let terminal_id = "terminal-session";
        let selected_path = "/api/org%20one/mcp/agent%2Fselected";
        app_state
            .agent_sessions
            .reserve_hook(crate::terminal::registry::HookReservation {
                fence: crate::routes::threads::db::RtThreadFence {
                    account_scope: "account".to_string(),
                    organization_id: "org one".to_string(),
                    thread_id: "thread".to_string(),
                    generation: "generation".to_string(),
                },
                terminal_session_id: terminal_id.to_string(),
                harness: harness::HarnessId::Codex,
                cwd: std::path::PathBuf::from("/tmp"),
                token: "hook-only-secret".to_string(),
                mcp_token: "mcp-only-secret".to_string(),
                mcp_path: selected_path.to_string(),
                title_environment: harness::title::TitleEnvironment::default(),
            });
        let guard = GuardState {
            auth: ClientAuth::embedded(
                vec!["127.0.0.1:43120".into()],
                "http://127.0.0.1:43120".into(),
                vec!["bootstrap".into()],
                "control-session".into(),
                "mount-token".into(),
            )
            .unwrap(),
            mode: crate::state::ApiMode::Strict,
            agent_sessions: app_state.agent_sessions.clone(),
        };
        let request_with = |path: &str, token: &str| {
            HttpRequest::builder()
                .method(Method::POST)
                .uri(path)
                .header(header::HOST, "127.0.0.1:43120")
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap()
        };

        let mut selected = request_with(selected_path, "mcp-only-secret");
        assert!(authorize_private(&guard, &mut selected).is_ok());

        for (path, token) in [
            ("/api/org%20one/mcp/another", "mcp-only-secret"),
            ("/_auth/status", "mcp-only-secret"),
            (selected_path, "hook-only-secret"),
        ] {
            let mut denied = request_with(path, token);
            assert!(
                authorize_private(&guard, &mut denied).is_err(),
                "{token} must not authorize {path}"
            );
        }

        app_state.agent_sessions.unregister_hook(terminal_id);
        let mut expired = request_with(selected_path, "mcp-only-secret");
        assert!(authorize_private(&guard, &mut expired).is_err());
    }

    /// The preview listener carries untrusted sandbox output, and cookies
    /// ignore the port — so a previewed page can make the webview attach the
    /// control cookie to a request aimed back here. It must never survive the
    /// hop into a sandbox's dev server, on ANY host, known or not.
    #[tokio::test]
    async fn the_preview_fence_strips_the_control_cookie_before_anything_downstream() {
        let root = tempfile::tempdir().unwrap();
        let state = crate::routes::intercept::test_state(root.path());
        let seen = Arc::new(std::sync::Mutex::new(Option::<String>::None));
        let recorder = seen.clone();
        let fenced = Router::new()
            .fallback(move |req: Request| {
                let recorder = recorder.clone();
                async move {
                    *recorder.lock().unwrap() = req
                        .headers()
                        .get(header::COOKIE)
                        .map(|value| value.to_str().unwrap().to_string());
                    StatusCode::OK
                }
            })
            .layer(middleware::from_fn_with_state(
                PreviewFence {
                    state,
                    // `None`: the single-label (`localhost`) deployment, where
                    // there is no per-handle host to fence on — so this proves
                    // the cookie strip stands on its own, without the Host
                    // check backing it up.
                    base: None,
                },
                preview_fence,
            ));

        let mut req = HttpRequest::builder()
            .method(Method::GET)
            .uri("/index.html")
            .header(header::HOST, "localhost:61234")
            .body(Body::empty())
            .unwrap();
        req.headers_mut().insert(
            header::COOKIE,
            axum::http::HeaderValue::from_static(
                "app-session=keep-me; decocms-local-session=steal-me; theme=dark",
            ),
        );
        assert_eq!(fenced.oneshot(req).await.unwrap().status(), StatusCode::OK);
        assert_eq!(
            seen.lock().unwrap().as_deref(),
            Some("app-session=keep-me; theme=dark"),
            "the control cookie is dropped and every application cookie survives"
        );
    }

    /// `resolve_preview` falls back to the ACTIVE sandbox when the Host names
    /// no label — so without this fence a request on the BARE control host
    /// (which is what the control cookie is scoped to) was proxied into
    /// whichever sandbox happened to be focused.
    #[tokio::test]
    async fn the_preview_fence_serves_known_labels_only_never_the_bare_control_host() {
        let root = tempfile::tempdir().unwrap();
        let state = crate::routes::intercept::test_state(root.path());
        let handle = state
            .sandbox_manager
            .register_for_test("https://github.com/acme/site.git", "work");
        let label = crate::sandbox::preview_label(&handle);
        let app = build_preview(state, 61234, "local.studio.decocms.com", None);

        let get = |host: &str| {
            app.clone().oneshot(
                HttpRequest::builder()
                    .method(Method::GET)
                    .uri("/")
                    .header(header::HOST, host)
                    .body(Body::empty())
                    .unwrap(),
            )
        };

        // A registered label is served: no dev server is running in this
        // sandbox, so the proxy answers its own placeholder rather than 404.
        assert_eq!(
            get(&format!("{label}.local.studio.decocms.com:61234"))
                .await
                .unwrap()
                .status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
        // A Host is case-insensitive, and `preview_label` only ever emits
        // lowercase — so folding the whole authority can never hide a label.
        assert_eq!(
            get(&format!(
                "{}.LOCAL.Studio.DecoCMS.com:61234",
                label.to_uppercase()
            ))
            .await
            .unwrap()
            .status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
        for rejected in [
            // The control host itself — the one the cookie is scoped to.
            "local.studio.decocms.com:61234",
            // A label no sandbox on this machine owns.
            "not-a-sandbox.local.studio.decocms.com:61234",
            // Deeper than one label: `preview_label` never produces a dot.
            "a.b.local.studio.decocms.com:61234",
            // A different site that resolves here.
            "attacker.example.com:61234",
            // The loopback address, which no preview URL ever uses.
            "127.0.0.1:61234",
        ] {
            assert_eq!(
                get(rejected).await.unwrap().status(),
                StatusCode::NOT_FOUND,
                "{rejected} must not reach a dev server"
            );
        }
    }

    #[tokio::test]
    async fn html_spa_fallback_never_swallows_reserved_api_paths_or_missing_assets() {
        let (app, _root) = embedded_router();
        let mut navigation = request(Method::GET, "/settings/profile");
        navigation.headers_mut().insert(
            header::ACCEPT,
            axum::http::HeaderValue::from_static("text/html"),
        );
        assert_eq!(
            app.clone().oneshot(navigation).await.unwrap().status(),
            StatusCode::OK
        );

        let mut api = request(Method::GET, "/api/acme/things");
        api.headers_mut().insert(
            header::ACCEPT,
            axum::http::HeaderValue::from_static("text/html"),
        );
        assert_eq!(
            app.clone().oneshot(api).await.unwrap().status(),
            StatusCode::UNAUTHORIZED
        );

        assert_eq!(
            app.oneshot(request(Method::GET, "/assets/missing.js"))
                .await
                .unwrap()
                .status(),
            StatusCode::NOT_FOUND
        );
    }

    #[tokio::test]
    async fn bootstrap_is_origin_bound_one_time_and_session_probe_uses_cookie() {
        let (app, _root) = embedded_router();
        let nonempty = HttpRequest::builder()
            .method(Method::POST)
            .uri("/_local/session/bootstrap")
            .header(header::HOST, "127.0.0.1:43120")
            .header(header::ORIGIN, "http://127.0.0.1:43120")
            .header(header::AUTHORIZATION, "Bearer one-time-bootstrap")
            .body(Body::from("not-empty"))
            .unwrap();
        assert_eq!(
            app.clone().oneshot(nonempty).await.unwrap().status(),
            StatusCode::BAD_REQUEST
        );

        let (status, cookie) = bootstrap(&app).await;
        assert_eq!(status, StatusCode::NO_CONTENT);

        let replay = {
            let mut req = request(Method::POST, "/_local/session/bootstrap");
            req.headers_mut().insert(
                header::ORIGIN,
                axum::http::HeaderValue::from_static("http://127.0.0.1:43120"),
            );
            req.headers_mut().insert(
                header::AUTHORIZATION,
                axum::http::HeaderValue::from_static("Bearer one-time-bootstrap"),
            );
            app.clone().oneshot(req).await.unwrap()
        };
        assert_eq!(replay.status(), StatusCode::UNAUTHORIZED);

        assert_eq!(
            app.clone()
                .oneshot(request(Method::GET, "/_local/session"))
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );
        let mut probe = request(Method::GET, "/_local/session");
        probe.headers_mut().insert(
            header::COOKIE,
            axum::http::HeaderValue::from_str(&cookie).unwrap(),
        );
        assert_eq!(
            app.oneshot(probe).await.unwrap().status(),
            StatusCode::NO_CONTENT
        );
    }

    #[tokio::test]
    async fn bootstrap_and_mutations_reject_missing_or_wrong_origin_and_host() {
        let (app, _root) = embedded_router();
        let mut no_origin = request(Method::POST, "/_local/session/bootstrap");
        no_origin.headers_mut().insert(
            header::AUTHORIZATION,
            axum::http::HeaderValue::from_static("Bearer one-time-bootstrap"),
        );
        assert_eq!(
            app.clone().oneshot(no_origin).await.unwrap().status(),
            StatusCode::FORBIDDEN
        );

        let mut wrong_host = request(Method::GET, "/");
        wrong_host.headers_mut().insert(
            header::HOST,
            axum::http::HeaderValue::from_static("127.0.0.1:43121"),
        );
        assert_eq!(
            app.clone().oneshot(wrong_host).await.unwrap().status(),
            StatusCode::FORBIDDEN
        );

        let (_, cookie) = bootstrap(&app).await;
        let mut mutation = request(Method::POST, "/_sandbox/setup/start");
        mutation.headers_mut().insert(
            header::COOKIE,
            axum::http::HeaderValue::from_str(&cookie).unwrap(),
        );
        assert_eq!(
            app.oneshot(mutation).await.unwrap().status(),
            StatusCode::FORBIDDEN
        );
    }

    #[tokio::test]
    async fn head_index_has_no_body_and_api_like_extensions_stay_private() {
        let (app, _root) = embedded_router();
        let head = app
            .clone()
            .oneshot(request(Method::HEAD, "/index.html"))
            .await
            .unwrap();
        assert_eq!(head.status(), StatusCode::OK);
        assert!(to_bytes(head.into_body(), usize::MAX)
            .await
            .unwrap()
            .is_empty());
        assert!(is_reserved_api_path("/api/x"));
        assert!(!is_reserved_api_path("/apiary"));
        assert!(is_reserved_api_path("/metrics"));
        assert!(!is_reserved_api_path("/metrics-dashboard"));
        assert_eq!(
            "/settings/profile".parse::<Uri>().unwrap().path(),
            "/settings/profile"
        );
    }

    #[test]
    fn studio_proxy_boundary_removes_only_control_cookie() {
        let auth = ClientAuth::embedded(
            vec!["127.0.0.1:43120".into()],
            "http://127.0.0.1:43120".into(),
            vec!["bootstrap".into()],
            "test-session-token".into(),
            "test-mount-token".into(),
        )
        .unwrap();
        let set_cookie = auth
            .consume_bootstrap(&{
                let mut headers = axum::http::HeaderMap::new();
                headers.insert(
                    header::AUTHORIZATION,
                    axum::http::HeaderValue::from_static("Bearer bootstrap"),
                );
                headers
            })
            .unwrap();
        let local_cookie = set_cookie.split(';').next().unwrap();
        let mut headers = axum::http::HeaderMap::new();
        headers.insert(
            header::COOKIE,
            axum::http::HeaderValue::from_str(&format!("sandbox=keep; {local_cookie}; theme=dark"))
                .unwrap(),
        );
        crate::client_auth::remove_local_session_cookie(&mut headers);
        assert_eq!(headers[header::COOKIE], "sandbox=keep; theme=dark");
    }
}
