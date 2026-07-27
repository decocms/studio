//! The app-API intercept-or-proxy catchall — new, no daemon precedent. Full
//! behavior: the native local-API contract.
//!
//! Owned by the Phase 3 upstream-auth family (`crates/upstream`). This
//! handler forwards `method`/relative-path/query/body to
//! `<upstream target>/<path>` with the Keychain-backed access token
//! attached SERVER-SIDE (via `upstream::global()` —
//! `crates/upstream/src/session.rs`'s process-wide singleton, shared with
//! the shell's `auth_status`/`auth_login`/`auth_logout`/
//! `auth_complete_session` IPC commands so both surfaces always agree on
//! sign-in state). The upstream bearer token is never constructed from, or
//! exposed to, anything this handler receives from the caller — it never
//! appears in a response, a log line, or an error body.
//!
//! Wired at `router.rs`'s top level, as the MAIN listener's fallback (merged
//! in from a small `app_api` sub-router that carries its own `guard`
//! middleware — Origin allowlist + LOCAL bearer, see `router.rs`), so by the
//! time this handler runs the CALLER is already authenticated against the
//! LOCAL token. This handler's own job is the SEPARATE, orthogonal question
//! of whether there's a valid UPSTREAM (mesh) session to forward with.
//!
//! Formerly nested under a `/upstream` path prefix (which `nest()` stripped
//! before this handler ever saw `req.uri()`); now mounted with NO prefix at
//! all — the caller's own path (e.g. `/api/acme/threads?x=1`) is exactly
//! what this handler receives, unchanged. The prefix was dropped once the
//! reverse-proxy family this fallback used to share an origin with (the
//! dev-server preview) moved to its own dedicated loopback listener (see
//! `lib.rs`/`router.rs`'s `build_preview`) — with the two families on
//! genuinely separate origins, there is no longer any ambiguity to
//! disambiguate with a path prefix.
//!
//! ## Thin reverse-proxy catchall — no path allowlist
//!
//! This handler is a THIN tokio/reqwest reverse proxy to the upstream mesh:
//! only chat (decopilot dispatch) and the sandbox/thread/model interception
//! table (`routes/intercept/`) are handled locally, checked FIRST — anything
//! that isn't intercepted is forwarded upstream, for ANY path, not just a
//! curated `/api/*` allowlist. The web client's own transport
//! (`apps/web/src/lib/desktop/transport-rules.ts`) rewrites every
//! same-origin app request (`/api`, `/mcp`, `/oauth-proxy`, `/.well-known`,
//! `/org`, ...) straight to this same main-listener origin, bearer-attached,
//! with no path-prefix rewrite at all — all of them stream through the SAME
//! bearer-forwarding branch below (see [`send_with_retry`]/[`build_response`]),
//! not just `/api/*`. A prior revision 404'd anything outside `/api/*` here
//! (`ALLOWED_PREFIX`) — removed as a needless restriction that contradicted
//! this catchall model and broke every one of those other prefixes; a later
//! revision still gated the rewrite on a `PROXIED_PATH_PREFIXES` allowlist
//! client-side — removed too, once the preview moved off this origin,
//! since this handler (not the client) is the one place that needs to know
//! which paths it recognizes.
//!
//! ## Two forwarding branches: bearer (org data) vs. cookie (auth)
//!
//! Post-v1 owner feedback locked a HYBRID sign-in design: the desktop
//! shell's in-app login screen is the SAME shared component as the web
//! `/login` route, and email/password + email-OTP submit through THIS
//! proxy to Better Auth's cookie-based session endpoints
//! (`/api/auth/sign-in/email`, `/api/auth/email-otp/verify-otp`, ...) —
//! see `apps/web/src/routes/login.tsx`. Those calls have no
//! Keychain-stored OAuth bearer to attach (there may not even BE one yet —
//! this is how a session gets established in the first place), and a
//! successful call needs its `Set-Cookie` captured somewhere so
//! `auth_complete_session` (`crates/upstream/src/bridge.rs`) can present
//! it to the MCP OAuth authorize endpoint moments later.
//!
//! So every request whose path starts with [`AUTH_PATH_PREFIX`] takes
//! [`proxy_auth_path`] instead of the bearer-token branch below:
//! - attaches `upstream::UpstreamSession::cookie_jar()`'s captured cookie
//!   (if any) as a plain `Cookie:` header — never the OAuth bearer;
//! - captures any `Set-Cookie` the upstream response carries back into
//!   that SAME jar;
//! - STRIPS `Set-Cookie` from the response before it reaches the webview
//!   — the cookie is a full Better Auth session credential (password
//!   change, org management, ...), far broader than the OAuth-scoped
//!   access this app needs, and must never land in a WKWebView/JS context.
//! - treats a successful `POST /api/auth/sign-out` as the native logout
//!   signal too: Better Auth revokes its upstream cookie session first,
//!   then [`upstream::UpstreamSession::logout`] revokes the OAuth token and
//!   clears the Keychain/cache/jar. The shared production UI therefore
//!   keeps its existing `authClient.signOut()` path with no desktop fork.
//!
//! Every other `/api/*` path keeps using the existing bearer-token branch
//! unchanged — org-data calls never see or need the cookie jar.
//!
//! ## Public, no-auth passthrough: `GET /api/config`
//!
//! The desktop sign-in screen (`apps/web/src/desktop/sign-in-screen.tsx`)
//! needs to know which auth methods are enabled BEFORE any upstream session
//! exists — the exact moment the bearer-token branch above always 401s
//! (`session.access_token()` returns `NoSession`). `apps/api/src/api/
//! routes/public-config.ts`'s `GET /api/config` is explicitly public/no-auth
//! on mesh (fetched by the web SPA before login too), so [`PUBLIC_NO_AUTH_PATH`]
//! gives it the same bearer-free treatment `AUTH_PATH_PREFIX` gives
//! `/api/auth/*` — checked first, before the bearer branch ever runs.
//! [`proxy_public_config`] does NOT touch the cookie jar (this route never
//! sets or needs a session cookie); it strips any inbound `Cookie` and any
//! outbound `Set-Cookie` purely as defense-in-depth, keeping the "a cookie
//! never reaches the webview" invariant uniform across every branch of this
//! proxy even though this particular route would never trigger it.

use std::time::Duration;

use axum::{
    body::Body,
    extract::{Request, State},
    http::{header, HeaderMap, HeaderName, HeaderValue, Method, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;

use crate::error::ApiError;
use crate::routes::intercept;
use crate::state::AppState;

/// The cookie-relay branch's scope — see this module's doc comment ("Two
/// forwarding branches"). Checked first, before the general catchall
/// bearer-forwarding branch every other path takes.
const AUTH_PATH_PREFIX: &str = "/api/auth/";

/// The production shell's existing Better Auth sign-out endpoint. A
/// successful response from this path is also the native app's logout
/// signal: after Better Auth has revoked the cookie session upstream, the
/// proxy revokes the native OAuth credential and clears its local store/jar.
/// Keeping this coordination here means the shared web UI does not need a
/// second, desktop-only sign-out action.
const AUTH_SIGN_OUT_PATH: &str = "/api/auth/sign-out";

/// Exact-match public, no-auth mesh route — see this module's doc comment
/// ("Public, no-auth passthrough"). Checked before the bearer-token branch,
/// same as [`AUTH_PATH_PREFIX`]. Exact match (not a prefix) because
/// `public-config.ts` mounts exactly one route (`GET /`) at this path.
const PUBLIC_NO_AUTH_PATH: &str = "/api/config";

/// Guards just the headers phase of the upstream fetch (mirrors
/// `routes/proxy.rs`'s `HEADERS_TIMEOUT` reasoning) — org-data API calls
/// should answer fast; once headers arrive the body streams with no
/// further deadline, so a long-lived SSE response is never cut off.
const UPSTREAM_HEADERS_TIMEOUT: Duration = Duration::from_secs(30);

/// Bounded request-body buffering — org-data JSON payloads are small; this
/// just stops one misbehaving caller from parking an unbounded allocation
/// in this process (same reasoning as `routes/proxy.rs`'s
/// `MAX_PROXY_BODY_BYTES`, scaled down since this namespace never proxies
/// dev-server-sized responses).
const MAX_UPSTREAM_BODY_BYTES: usize = 25 * 1024 * 1024;

pub async fn proxy(State(state): State<AppState>, req: Request) -> Response {
    let (parts, body) = req.into_parts();
    let path = parts.uri.path().to_string();
    let path_and_query = parts
        .uri
        .path_and_query()
        .map(|pq| pq.as_str().to_string())
        .unwrap_or_else(|| path.clone());

    tracing::debug!(method = %parts.method, path = %path, "app-api proxy: incoming request");

    let body_bytes = match axum::body::to_bytes(body, MAX_UPSTREAM_BODY_BYTES).await {
        Ok(b) => b,
        Err(err) => {
            return ApiError::payload_too_large(format!("failed to read request body: {err}"))
                .into_response()
        }
    };

    // The interception table (`routes/intercept/`) is checked FIRST, before
    // either the cookie-relay or bearer-forwarding branches below — an
    // intercepted route never talks to upstream at all (not even to decide
    // whether there's a valid session), so it must never wait on, or be
    // gated by, this proxy's auth machinery. See that module's doc comment
    // for the full route table and the map citations behind each entry.
    if let Some(response) =
        intercept::try_intercept(&state, &parts.method, &path, parts.uri.query(), &body_bytes).await
    {
        return response;
    }

    let session = upstream::global();

    if path.starts_with(AUTH_PATH_PREFIX) {
        return proxy_auth_path(
            &session,
            &parts.method,
            &path_and_query,
            &parts.headers,
            &body_bytes,
        )
        .await;
    }

    if path == PUBLIC_NO_AUTH_PATH {
        return proxy_public_config(
            &session,
            &parts.method,
            &path_and_query,
            &parts.headers,
            &body_bytes,
        )
        .await;
    }

    let access_token = match session.access_token().await {
        Ok(token) => token,
        Err(err) if err.kind == upstream::refresh::RefreshErrorKind::Transient => {
            return ApiError::bad_gateway(format!("upstream unreachable: {}", err.message))
                .into_response();
        }
        // `NoSession` (never logged in / already signed out) and
        // `InvalidGrant` (refresh token itself rejected) both mean the
        // SAME thing to this handler's caller: there is no usable upstream
        // session right now. `InvalidGrant` additionally tears down the
        // stale local credentials so the NEXT call doesn't repeat a
        // doomed refresh attempt.
        Err(err) => {
            if err.kind == upstream::refresh::RefreshErrorKind::InvalidGrant {
                session
                    .hard_sign_out("refresh token rejected while resolving an app-API request")
                    .await;
            }
            return unauthorized_upstream();
        }
    };

    let mut out_headers = build_forward_headers(&parts.headers);
    attach_persisted_cookie(&mut out_headers, &session).await;
    // A payload we intend to rewrite must arrive uncompressed — reqwest is
    // built without `gzip`, so a compressed body would fail to parse and the
    // rewrite would silently fail open.
    if is_protected_resource_metadata(&path) {
        out_headers.insert(
            header::ACCEPT_ENCODING,
            HeaderValue::from_static("identity"),
        );
    }

    match send_with_retry(
        &session,
        &parts.method,
        &path_and_query,
        &out_headers,
        &body_bytes,
        access_token,
    )
    .await
    {
        Ok(upstream_resp) if is_protected_resource_metadata(&path) => {
            localized_resource_metadata(upstream_resp, session.target(), &parts.headers).await
        }
        Ok(upstream_resp) => build_response(upstream_resp).await,
        Err(ProxyError::Network(msg)) => {
            ApiError::bad_gateway(format!("upstream unreachable: {msg}")).into_response()
        }
        Err(ProxyError::HardUnauthorized) => unauthorized_upstream(),
    }
}

/// RFC 9728 protected-resource metadata, in either of the two anchorings the
/// MCP SDK probes.
fn is_protected_resource_metadata(path: &str) -> bool {
    path.starts_with("/.well-known/oauth-protected-resource")
        || path.contains("/.well-known/oauth-protected-resource")
}

/// Rewrite the metadata's `resource` to the origin the CALLER reached us at.
///
/// Upstream builds it from its own origin, so a desktop client is told the
/// protected resource is `https://studio.decocms.com/api/<org>/mcp/<conn>`
/// while it is talking to `http://localhost:<port>/…`. The MCP SDK validates
/// that the two agree and refuses the mismatch:
///
/// ```text
/// Protected resource https://studio.decocms.com/api/o/mcp/c
///   does not match expected http://localhost:4420/api/o/mcp/c (or origin)
/// ```
///
/// `authorization_servers` is deliberately left pointing upstream: that IS
/// where the authorization endpoints live, and this proxy has no OAuth
/// endpoints of its own to offer instead.
async fn localized_resource_metadata(
    upstream: reqwest::Response,
    target: &str,
    request_headers: &HeaderMap,
) -> Response {
    if !upstream.status().is_success() {
        return build_response(upstream).await;
    }
    let Some(local_origin) = caller_origin(request_headers) else {
        return build_response(upstream).await;
    };

    let status = upstream.status();
    let mut headers = upstream.headers().clone();
    strip_hop_by_hop_headers(&mut headers);
    headers.remove(header::CONTENT_ENCODING);

    let Ok(bytes) = upstream.bytes().await else {
        return ApiError::bad_gateway("upstream metadata body was unreadable").into_response();
    };
    // Fail OPEN: an unparseable or unchanged body is forwarded verbatim, so a
    // shape this does not recognize can never break OAuth outright.
    let body = rewrite_resource_field(&bytes, target.trim_end_matches('/'), &local_origin)
        .map(axum::body::Bytes::from)
        .unwrap_or(bytes);
    headers.remove(header::CONTENT_LENGTH);
    let mut res = Response::new(Body::from(body));
    *res.status_mut() = status;
    *res.headers_mut() = headers;
    res
}

/// The origin the webview used to reach us — `Origin` when it sent one, else
/// derived from the exact `Host` it addressed (which the embedded guard has
/// already validated).
fn caller_origin(headers: &HeaderMap) -> Option<String> {
    if let Some(origin) = headers
        .get(header::ORIGIN)
        .and_then(|v| v.to_str().ok())
        .filter(|o| o.starts_with("http://") || o.starts_with("https://"))
    {
        return Some(origin.trim_end_matches('/').to_string());
    }
    let host = headers.get(header::HOST)?.to_str().ok()?;
    (!host.is_empty()).then(|| format!("http://{host}"))
}

/// Swap the upstream origin for the local one in `resource`. `None` when the
/// body is not JSON, has no `resource` string, or it does not name upstream.
fn rewrite_resource_field(
    bytes: &[u8],
    upstream_origin: &str,
    local_origin: &str,
) -> Option<Vec<u8>> {
    let mut value: serde_json::Value = serde_json::from_slice(bytes).ok()?;
    let resource = value.get("resource")?.as_str()?;
    let path = resource.strip_prefix(upstream_origin)?;
    // The remainder MUST begin the path, or this is a lookalike host that
    // merely starts with the origin string — `studio.decocms.com.evil.example`
    // prefix-matches `studio.decocms.com` and would otherwise be rewritten as
    // if it were ours.
    if !path.is_empty() && !path.starts_with('/') {
        return None;
    }
    let localized = format!("{local_origin}{path}");
    *value.get_mut("resource")? = serde_json::Value::String(localized);
    serde_json::to_vec(&value).ok()
}

/// The cookie-relay branch — see this module's doc comment ("Two
/// forwarding branches"). Never attaches the Keychain OAuth bearer (this
/// is how a session is established in the first place; there may be none
/// yet). Attaches `session.cookie_jar()`'s captured cookie for
/// `session.host()` if present, captures the upstream response's
/// `Set-Cookie` back into that same jar, and strips `Set-Cookie` from what
/// goes back to the caller.
async fn proxy_auth_path(
    session: &upstream::UpstreamSession,
    method: &Method,
    path_and_query: &str,
    headers: &HeaderMap,
    body: &axum::body::Bytes,
) -> Response {
    let mut out_headers = build_forward_headers(headers);
    // A payload we intend to REWRITE must arrive uncompressed. reqwest is
    // built without its `gzip` feature here, so forwarding the webview's
    // `Accept-Encoding: gzip` would hand us compressed bytes, the JSON parse
    // would fail, and the rewrite would silently fail open — the exact way
    // the `/api/config` version rewrite failed before it asked for identity
    // too.
    if carries_org_assets(path_and_query) {
        out_headers.insert(
            header::ACCEPT_ENCODING,
            HeaderValue::from_static("identity"),
        );
    }
    // `build_forward_headers` already strips any inbound `Cookie` the
    // caller sent (the webview holds no cookies of ours to begin with, but
    // a stray/forged one must never ride through) — this proxy decides the
    // Cookie header for this branch exclusively, from the ephemeral jar OR
    // the durable persisted cookie below.
    //
    // Prefer the ephemeral jar's value (the one currently in-flight through
    // an active login handshake — e.g. the sign-in POST that's ABOUT to
    // establish a session, before anything is persisted yet), falling back
    // to the durable Keychain-persisted cookie ([`upstream::UpstreamSession::cookie_header`])
    // for every `/api/auth/*` call AFTER sign-in completes — this is what
    // makes `GET /api/auth/get-session` / `GET /api/auth/organization/list`
    // (both under this same `AUTH_PATH_PREFIX`) keep working on every
    // subsequent request for the rest of the session's life, not just the
    // one bridge round trip. See this module's + `crates/upstream/src/
    // bridge.rs`'s doc comments for why.
    // MERGE the durable persisted session cookie with whatever the ephemeral
    // jar currently holds — do NOT pick one. The upstream sits behind
    // Cloudflare, which sets `__cf_bm` on responses; this proxy captures every
    // `Set-Cookie` into the jar (below), so after the first upstream response
    // the jar holds `__cf_bm`. A plain jar-or-persisted CHOICE then let that
    // infra cookie SHADOW the persisted `__Secure-better-auth.session_token`,
    // so every org-scoped `/api/auth/*` call forwarded `__cf_bm` alone and got
    // 401 (get-session only slipped through because it fired before the jar was
    // polluted). A real browser sends BOTH cookies; so do we. The jar wins on a
    // name clash — it carries the freshest rotated session token (see the
    // capture/`remember_cookie` below), while the persisted cookie guarantees
    // the session token is present even when the jar holds only `__cf_bm`.
    let persisted_cookie = session.cookie_header().await;
    let jar_cookie = session.cookie_jar().header_value(session.host());
    let cookie = merge_cookie_headers(persisted_cookie.as_deref(), jar_cookie.as_deref());
    // Names only, never the values — lets a debug trace confirm WHICH cookies
    // we forward (e.g. that `__Secure-better-auth.session_token` an https
    // upstream's `get-session` actually reads rides alongside `__cf_bm`)
    // without logging any secret.
    let forwarded_cookie_names: Vec<String> = cookie
        .as_deref()
        .map(|c| {
            c.split(';')
                .filter_map(|kv| kv.trim().split('=').next())
                .filter(|n| !n.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    if let Some(cookie) = cookie {
        match HeaderValue::from_str(&cookie) {
            Ok(value) => {
                out_headers.insert(header::COOKIE, value);
            }
            Err(err) => {
                // Should not happen — captured values come from an
                // upstream `Set-Cookie` that was itself a valid header
                // value when received. Defensive only: proceed without a
                // cookie rather than fail the whole request.
                tracing::warn!(error = %err, "captured cookie jar value was not a valid header value; forwarding without it");
            }
        }
    }

    // Present as a first-party caller: Better Auth's CSRF check rejects
    // unknown Origins on auth POSTs (and the webview's own Origin is
    // `tauri://localhost`, stripped in `build_forward_headers`). The
    // upstream's own origin is by definition on its trusted list.
    if let Ok(value) = HeaderValue::from_str(session.target().trim_end_matches('/')) {
        out_headers.insert(header::ORIGIN, value);
    }

    let url = format!("{}{path_and_query}", session.target());
    let upstream_resp = match send_once_no_bearer(method, &url, &out_headers, body.clone()).await {
        Ok(resp) => resp,
        Err(ProxyError::Network(msg)) => {
            return ApiError::bad_gateway(format!("upstream unreachable: {msg}")).into_response()
        }
        // `send_once_no_bearer` never produces `HardUnauthorized` — that
        // variant only exists for the bearer-retry branch above.
        Err(ProxyError::HardUnauthorized) => {
            unreachable!("send_once_no_bearer never returns ProxyError::HardUnauthorized")
        }
    };

    tracing::debug!(
        method = %method,
        path = %path_and_query,
        status = upstream_resp.status().as_u16(),
        forwarded_cookie_names = ?forwarded_cookie_names,
        "auth-path proxy: upstream responded"
    );

    // The real Studio shell already signs out through Better Auth. Once that
    // upstream operation succeeds, complete the native half of the same
    // transition: `logout()` attempts OAuth revocation and only then clears
    // the Keychain-backed session and ephemeral cookie jar. Do this before
    // capturing response cookies: Better Auth commonly sends an expired
    // session `Set-Cookie` on sign-out, and retaining that tombstone in our
    // deliberately attribute-free jar would leave the app locally half-signed
    // out. A failed upstream sign-out deliberately leaves the native session
    // intact so the UI can report/retry the failure without lying about the
    // server-side state.
    let auth_path = path_and_query.split('?').next().unwrap_or(path_and_query);
    if *method == Method::POST
        && auth_path == AUTH_SIGN_OUT_PATH
        && upstream_resp.status().is_success()
    {
        session.logout().await;
        return build_auth_response(upstream_resp).await;
    }

    let set_cookie_values: Vec<String> = upstream_resp
        .headers()
        .get_all(header::SET_COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        // Only ever track OUR OWN Better Auth cookies in the jar / persisted
        // store — NEVER infrastructure cookies the upstream's CDN sets
        // (Cloudflare's `__cf_bm`, `cf_clearance`, `_cfuvid`, …). Without this
        // filter, capturing `__cf_bm` and then `remember_cookie`-ing the jar's
        // full contents OVERWRITES the real session cookie (the jar's
        // `header_value` returns everything it holds, and the Google/bridge
        // path never Set-Cookie's the session token into the jar to begin
        // with), which silently 401'd every org-scoped call after the first
        // upstream response. Everything here is keyed by `session.host()`, so
        // staging (`studio-stg.decocms.com`) and prod (`studio.decocms.com`)
        // cookies live in separate jars and never mix.
        .filter(|sc| is_better_auth_set_cookie(sc))
        .map(str::to_string)
        .collect();
    if !set_cookie_values.is_empty() {
        session
            .cookie_jar()
            .capture(session.host(), set_cookie_values.iter().map(String::as_str));
        // Keep the DURABLE persisted cookie fresh too: a call after the
        // initial sign-in (e.g. Better Auth rotating the session token on
        // some later `/api/auth/*` round trip) must not silently go stale
        // just because `complete_session()`'s one-time bridge already ran.
        // A no-op if there's no OAuth session yet (mid-handshake, before
        // `complete_session()` — the ephemeral jar carries it forward to
        // that call instead, same as before this change).
        if let Some(full_header) = session.cookie_jar().header_value(session.host()) {
            session.remember_cookie(&full_header).await;
        }
    }

    // Better Auth's org payloads carry `logo` as an ABSOLUTE upstream URL
    // under `/api/<org>/files/…`. The webview renders it straight into an
    // `<img>`, which goes cross-origin with no credentials — desktop auth is a
    // Keychain token held here, not a browser cookie for that host — so every
    // org icon fails to load. Rewriting the payload to a same-origin path
    // sends the request back through this proxy, which attaches the token.
    if carries_org_assets(path_and_query) {
        return localized_auth_response(upstream_resp, session.target()).await;
    }
    build_auth_response(upstream_resp).await
}

/// Auth endpoints whose payloads can carry an organization `logo`.
fn carries_org_assets(path_and_query: &str) -> bool {
    let path = path_and_query
        .split(['?', '#'])
        .next()
        .unwrap_or(path_and_query);
    path.starts_with("/api/auth/organization") || path == "/api/auth/get-session"
}

/// [`build_auth_response`], but buffering the body so protected-asset URLs can
/// be localized. Only used for the small JSON payloads above — everything else
/// keeps streaming.
async fn localized_auth_response(upstream: reqwest::Response, target: &str) -> Response {
    if !upstream.status().is_success() {
        return build_auth_response(upstream).await;
    }
    let status = upstream.status();
    let mut headers = upstream.headers().clone();
    strip_hop_by_hop_headers(&mut headers);
    headers.remove(header::SET_COOKIE);

    let Ok(bytes) = upstream.bytes().await else {
        return ApiError::bad_gateway("upstream auth body was unreadable").into_response();
    };
    // Asked for `identity`, but never trust it: a body we hand back verbatim
    // must not claim an encoding it no longer has.
    headers.remove(header::CONTENT_ENCODING);
    // Fail OPEN: an unparseable or unchanged body is forwarded verbatim, so a
    // payload shape this does not recognize can never break sign-in.
    let body = localize_first_party_asset_urls(&bytes, target.trim_end_matches('/'))
        .map(axum::body::Bytes::from)
        .unwrap_or(bytes);
    headers.remove(header::CONTENT_LENGTH);
    let mut res = Response::new(Body::from(body));
    *res.status_mut() = status;
    *res.headers_mut() = headers;
    res
}

/// Rewrite every absolute upstream protected-file URL in a JSON payload into
/// the same-origin path form. `None` when nothing changed.
///
/// Deliberately narrow, because widening it would turn this proxy into a
/// general authenticated asset relay: the origin must match EXACTLY (a
/// lookalike host, or one carrying credentials, will not prefix-match the
/// bare origin string), and the path must be `/api/<org>/files/…`. Ports the
/// same rule the web app applies at render time
/// (`lib/desktop/transport-rules.ts`).
fn localize_first_party_asset_urls(bytes: &[u8], upstream_origin: &str) -> Option<Vec<u8>> {
    if upstream_origin.is_empty() {
        return None;
    }
    let mut value: serde_json::Value = serde_json::from_slice(bytes).ok()?;
    if !localize_in_place(&mut value, upstream_origin) {
        return None;
    }
    serde_json::to_vec(&value).ok()
}

fn localize_in_place(value: &mut serde_json::Value, origin: &str) -> bool {
    match value {
        serde_json::Value::String(text) => match localized_asset_path(text, origin) {
            Some(path) => {
                *text = path;
                true
            }
            None => false,
        },
        // Explicit loops, NOT `any()`: that short-circuits on the first
        // rewrite and would leave every later logo in the payload untouched.
        serde_json::Value::Array(items) => {
            let mut changed = false;
            for item in items.iter_mut() {
                changed |= localize_in_place(item, origin);
            }
            changed
        }
        serde_json::Value::Object(map) => {
            let mut changed = false;
            for item in map.values_mut() {
                changed |= localize_in_place(item, origin);
            }
            changed
        }
        _ => false,
    }
}

/// The same-origin path for an upstream protected-file URL, or `None`.
fn localized_asset_path(url: &str, origin: &str) -> Option<String> {
    let rest = url.strip_prefix(origin)?;
    if !rest.starts_with('/') {
        return None;
    }
    let path = rest.split(['?', '#']).next().unwrap_or(rest);
    let mut segments = path.trim_start_matches('/').split('/');
    let is_protected = segments.next() == Some("api")
        && segments.next().is_some_and(|org| !org.is_empty())
        && segments.next() == Some("files");
    is_protected.then(|| rest.to_string())
}

/// Merge two `Cookie:` header values into one, deduping by cookie name; the
/// SECOND argument (`overlay`) wins on a name clash. Returns `None` when both
/// are absent/empty. This is what lets the durable session cookie (`base`)
/// always ride ALONGSIDE whatever the ephemeral jar (`overlay`) captured from
/// upstream — e.g. Cloudflare's `__cf_bm` — so a captured infra cookie can
/// never SHADOW the session cookie (the silent cause of a 401 on every
/// org-scoped `/api/auth/*` call). Mirrors what a browser sends: all of its
/// cookies for the host, in one header. First-seen name order is preserved.
fn merge_cookie_headers(base: Option<&str>, overlay: Option<&str>) -> Option<String> {
    let mut order: Vec<String> = Vec::new();
    let mut values: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    for src in [base, overlay] {
        let Some(header) = src else { continue };
        for part in header.split(';') {
            let part = part.trim();
            if part.is_empty() {
                continue;
            }
            let (name, value) = match part.split_once('=') {
                Some((n, v)) => (n.trim().to_string(), v.trim().to_string()),
                None => (part.to_string(), String::new()),
            };
            if name.is_empty() {
                continue;
            }
            // Overlay overwrites the value on a clash but keeps the original
            // first-seen position (so `insert`ing a duplicate name must not
            // re-append to `order`).
            if values.insert(name.clone(), value).is_none() {
                order.push(name);
            }
        }
    }
    if order.is_empty() {
        return None;
    }
    Some(
        order
            .iter()
            .map(|name| {
                let value = &values[name];
                if value.is_empty() {
                    name.clone()
                } else {
                    format!("{name}={value}")
                }
            })
            .collect::<Vec<_>>()
            .join("; "),
    )
}

/// True if a `Set-Cookie` header value names one of OUR OWN Better Auth cookies
/// (the name contains `better-auth`, regardless of any `__Secure-`/`__Host-`
/// prefix) — as opposed to infrastructure cookies the upstream's CDN sets
/// (Cloudflare's `__cf_bm`, `cf_clearance`, `_cfuvid`). Only the former belong
/// in this proxy's cookie jar / persisted session store; capturing the latter
/// clobbers the real session cookie (see the capture site in `proxy_auth_path`).
fn is_better_auth_set_cookie(set_cookie: &str) -> bool {
    set_cookie
        .split('=')
        .next()
        .map(|name| name.trim().contains("better-auth"))
        .unwrap_or(false)
}

/// Attaches the durable, Keychain-persisted Better Auth session cookie (see
/// `upstream::UpstreamSession::cookie_header`'s doc comment) to an
/// org-data/bearer-branch request, in ADDITION to the `Authorization:
/// Bearer` token already attached by [`send_once`]/[`send_with_retry`] — a
/// no-op when this session has no persisted cookie (the system-browser
/// login path, or before any embedded sign-in has ever completed). This is
/// what makes the real production web shell's own sign-in gate and org
/// switcher (both native Better Auth `/api/auth/*` endpoints, reached via
/// [`proxy_auth_path`] above) AND every ordinary org-scoped data call
/// (reached via THIS branch) agree on the same signed-in identity, for
/// every request this proxy forwards — not just `/api/auth/*`.
async fn attach_persisted_cookie(headers: &mut HeaderMap, session: &upstream::UpstreamSession) {
    let Some(cookie) = session.cookie_header().await else {
        return;
    };
    match HeaderValue::from_str(&cookie) {
        Ok(value) => {
            headers.insert(header::COOKIE, value);
        }
        Err(err) => {
            tracing::warn!(error = %err, "persisted cookie was not a valid header value; forwarding without it");
        }
    }
}

/// The public, no-auth passthrough — see this module's doc comment ("Public,
/// no-auth passthrough"). No Keychain bearer, no cookie-jar read/write:
/// `GET /api/config` needs neither to answer. Still strips any inbound
/// `Cookie` / outbound `Set-Cookie` defensively (this route never sets one,
/// but every branch of this proxy keeps the same invariant uniformly).
async fn proxy_public_config(
    session: &upstream::UpstreamSession,
    method: &Method,
    path_and_query: &str,
    headers: &HeaderMap,
    body: &axum::body::Bytes,
) -> Response {
    let mut out_headers = build_forward_headers(headers);
    out_headers.remove(header::COOKIE);
    // Ask upstream for an UNCOMPRESSED body. `reqwest` is built without its
    // `gzip` feature (see the workspace manifest), so it hands back whatever
    // encoding the origin chose — and a CDN in front of upstream answers the
    // browser's `Accept-Encoding: gzip` with a gzipped body. Those bytes are
    // not JSON, so `rewrite_config_version` below would silently fail to parse
    // them and fall through to passthrough, leaving the version un-rewritten.
    // Overriding the header here (rather than enabling `gzip` crate-wide)
    // keeps every other proxied route — including the streaming ones — byte
    // -identical; `/api/config` is a few hundred bytes, so the lost
    // compression costs nothing.
    out_headers.insert(
        header::ACCEPT_ENCODING,
        HeaderValue::from_static("identity"),
    );

    let url = format!("{}{path_and_query}", session.target());
    match send_once_no_bearer(method, &url, &out_headers, body.clone()).await {
        Ok(resp) => rewrite_config_version(resp).await,
        Err(ProxyError::Network(msg)) => {
            ApiError::bad_gateway(format!("upstream unreachable: {msg}")).into_response()
        }
        Err(ProxyError::HardUnauthorized) => {
            unreachable!("send_once_no_bearer never returns ProxyError::HardUnauthorized")
        }
    }
}

/// The web bundle this app ships, baked in by `build.rs` from the same
/// `apps/api/package.json` Vite reads for `__STUDIO_VERSION__`. Empty when
/// that file could not be read at build time (see `build.rs`).
const STUDIO_WEB_VERSION: &str = env!("STUDIO_WEB_VERSION");

/// Answers `GET /api/config` with the version of the bundle actually running
/// inside this app, not the upstream deployment's.
///
/// `version-check-dialog.tsx` polls this route every 5 minutes and nags "A new
/// version is ready" once the reported version differs from the bundle's own
/// build-time `__STUDIO_VERSION__` on two consecutive polls. Upstream redeploys
/// many times a day, so proxied unchanged that banner is guaranteed to fire in
/// the desktop app — and its "Refresh" action cannot possibly help, because the
/// webview loads a bundle packaged into the app, not whatever upstream now
/// serves. Rewriting the field keeps the two in agreement, so the banner only
/// ever appears in the browser, where reloading genuinely fetches new assets.
///
/// Every other field is passed through untouched: this rewrites one string, it
/// does not reimplement the payload. Non-2xx, non-JSON, unparseable, or
/// unexpectedly-shaped bodies stream through unchanged, as does an empty
/// `STUDIO_WEB_VERSION`.
async fn rewrite_config_version(upstream: reqwest::Response) -> Response {
    if STUDIO_WEB_VERSION.is_empty() || !upstream.status().is_success() {
        return build_auth_response(upstream).await;
    }

    let status = upstream.status();
    let mut headers = upstream.headers().clone();
    strip_hop_by_hop_headers(&mut headers);
    headers.remove(header::SET_COOKIE);

    let Ok(bytes) = upstream.bytes().await else {
        return ApiError::bad_gateway("upstream config body was unreadable").into_response();
    };

    let patched = patch_config_version(&bytes, STUDIO_WEB_VERSION);

    let body = match patched {
        Some(json) => {
            // Content-Length no longer matches the re-serialized body; drop it
            // and let axum frame the response itself. Content-Encoding goes too:
            // reaching here means the body parsed as JSON, so what we emit is
            // plain — advertising an encoding would make the browser try to
            // decompress it.
            headers.remove(header::CONTENT_LENGTH);
            headers.remove(header::CONTENT_ENCODING);
            json
        }
        None => bytes.to_vec(),
    };

    let mut res = Response::new(Body::from(body));
    *res.status_mut() = status;
    *res.headers_mut() = headers;
    res
}

/// Replaces `config.version` in a `GET /api/config` body, or `None` when the
/// payload isn't the shape we expect — the caller then passes the original
/// bytes through untouched rather than inventing a response.
///
/// Pure (no I/O) so the contract is unit-testable without standing up a proxy,
/// per TESTING.md.
fn patch_config_version(bytes: &[u8], version: &str) -> Option<Vec<u8>> {
    let mut value = serde_json::from_slice::<serde_json::Value>(bytes).ok()?;
    // `{ "config": { "version": "…", … } }` — see
    // `apps/api/src/api/routes/public-config.ts`.
    let slot = value.get_mut("config")?.get_mut("version")?;
    if !slot.is_string() {
        return None;
    }
    *slot = serde_json::Value::String(version.to_string());
    serde_json::to_vec(&value).ok()
}

/// Strips hop-by-hop headers (RFC 7230 §6.1) plus `Host` (reqwest derives
/// it from the target URL) and the caller's OWN `Authorization` — that's
/// the LOCAL bearer `router.rs`'s `guard` middleware already validated;
/// forwarding it upstream would leak an unrelated credential. The preview
/// listener is intentionally different: it carries the sandboxed
/// application's own Authorization end-to-end and never uses local-api auth.
fn build_forward_headers(incoming: &HeaderMap) -> HeaderMap {
    let mut out = incoming.clone();
    strip_hop_by_hop_headers(&mut out);
    out.remove(header::HOST);
    out.remove(header::AUTHORIZATION);
    out.remove(header::CONTENT_LENGTH);
    // Never forward whatever `Cookie` the caller sent. In embedded mode this
    // is local-api's HttpOnly session credential (already removed by the
    // router guard); in standalone mode it may be stray/forged. Every branch
    // of this proxy decides the outbound `Cookie` header itself, exclusively
    // (the persisted
    // session cookie here in the bearer branch, the jar/persisted cookie in
    // `proxy_auth_path`, none at all in `proxy_public_config`) — uniform
    // defense-in-depth across all three, even though today only the first
    // two ever attach one.
    out.remove(header::COOKIE);
    // Browser-context headers must not leak upstream: this proxy is a
    // server-side client, not the webview. Concretely, the webview's
    // `Origin: tauri://localhost` trips Better Auth's CSRF origin check on
    // every `/api/auth/*` POST ("Invalid origin"), which the Node-driven
    // e2e suites never caught because bare `fetch` sends no Origin at all.
    // `proxy_auth_path` re-inserts an upstream-origin `Origin` below so
    // Better Auth sees a first-party request.
    out.remove(header::ORIGIN);
    out.remove(header::REFERER);
    for name in ["sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest"] {
        out.remove(name);
    }
    out
}

/// Removes headers that describe one HTTP connection rather than the proxied
/// message. RFC 7230 §6.1 also allows `Connection` to name arbitrary additional
/// hop-by-hop fields, so collect those tokens before removing `Connection`.
fn strip_hop_by_hop_headers(headers: &mut HeaderMap) {
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
        headers.remove(name);
    }
}

#[derive(Debug)]
enum ProxyError {
    Network(String),
    /// The independent OAuth probe rejected the credential even after its
    /// normal refresh path. A resource-specific `401` never produces this.
    HardUnauthorized,
}

fn proxy_client() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            // This is a reverse proxy, so redirects belong to the webview.
            // Following them here would hide the upstream status/Location and
            // break browser-driven OAuth flows.
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("static upstream proxy client configuration must build")
    })
}

/// Sends the request with `token`. A resource `401` is not proof that the
/// OAuth session is invalid: MCP connections can return their own `401`
/// while the Studio credential remains healthy. Revalidate against the
/// dedicated auth probe and retry only when that probe actually rotated the
/// access token. Resource-specific `401`s pass through without signing out.
/// Call an org-scoped builtin tool upstream and return its parsed JSON body.
///
/// The interception table is otherwise a strictly-local surface (see
/// `routes/intercept`'s doc comment: an intercepted route "never talks to
/// upstream at all"). This is the one deliberate exception, for the single
/// fact local-api cannot know on its own: a virtual MCP's git repo and runtime
/// live in the cluster-side registry, and `SANDBOX_START` must resolve them
/// before it can provision a local sandbox. It fails closed — a signed-out or
/// unreachable upstream surfaces an error rather than provisioning a sandbox
/// against a guessed repo.
pub(crate) async fn call_org_tool(
    org: &str,
    tool_name: &str,
    input: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let session = upstream::global();
    let token = session
        .access_token()
        .await
        .map_err(|_| "not signed in to the upstream deployment".to_string())?;

    let path = format!(
        "/api/{}/tools/{}",
        urlencoding::encode(org),
        urlencoding::encode(tool_name)
    );
    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    headers.insert(header::ACCEPT, HeaderValue::from_static("application/json"));

    let body = axum::body::Bytes::from(serde_json::to_vec(input).map_err(|e| e.to_string())?);
    let response = send_with_retry(&session, &Method::POST, &path, &headers, &body, token)
        .await
        .map_err(|error| match error {
            ProxyError::Network(msg) => format!("upstream unreachable: {msg}"),
            ProxyError::HardUnauthorized => "not signed in to the upstream deployment".to_string(),
        })?;

    let status = response.status();
    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("could not read {tool_name} response: {e}"))?;
    if !status.is_success() {
        return Err(format!(
            "{tool_name} failed upstream ({status}): {}",
            String::from_utf8_lossy(&bytes)
                .chars()
                .take(300)
                .collect::<String>()
        ));
    }
    serde_json::from_slice(&bytes).map_err(|e| format!("{tool_name} returned invalid JSON: {e}"))
}

/// Why an authenticated upstream call never produced a response at all. A
/// non-2xx response is NOT one of these — it comes back as `Ok`, so the
/// caller decides what its status means.
#[derive(Debug)]
pub(crate) enum UpstreamCallError {
    /// No usable session, or the OAuth probe rejected the credential.
    NotSignedIn,
    /// Network/timeout reaching the deployment.
    Unreachable(String),
}

/// Send one authenticated request to an arbitrary upstream path and hand the
/// raw response back — status, headers and an unconsumed body, so a caller
/// serving a large object can stream it rather than buffering.
///
/// [`call_org_tool`] above is the JSON-tool-shaped convenience over the same
/// machinery; this is the general form, used by `routes/webdav.rs` for the
/// org filesystem's REST contract (`/api/:org/fs/:volume/*`), which is not a
/// tool call. Both share [`send_with_retry`], so both get the same
/// "resource 401 is not a session 401" revalidate-and-retry semantics and the
/// same server-side token attachment — a caller never sees or supplies the
/// upstream bearer.
pub(crate) async fn send_org_request(
    method: Method,
    path_and_query: &str,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Result<reqwest::Response, UpstreamCallError> {
    let session = upstream::global();
    let token = session
        .access_token()
        .await
        .map_err(|_| UpstreamCallError::NotSignedIn)?;
    send_with_retry(&session, &method, path_and_query, &headers, &body, token)
        .await
        .map_err(|error| match error {
            ProxyError::Network(msg) => UpstreamCallError::Unreachable(msg),
            ProxyError::HardUnauthorized => UpstreamCallError::NotSignedIn,
        })
}

async fn send_with_retry(
    session: &upstream::UpstreamSession,
    method: &Method,
    path_and_query: &str,
    headers: &HeaderMap,
    body: &axum::body::Bytes,
    token: String,
) -> Result<reqwest::Response, ProxyError> {
    let url = format!("{}{path_and_query}", session.target());
    let first = send_once(method, &url, headers, body.clone(), &token).await?;
    if first.status() != StatusCode::UNAUTHORIZED {
        return Ok(first);
    }

    let status = session.force_revalidate().await;
    if !status.signed_in {
        return Err(ProxyError::HardUnauthorized);
    }

    let current = match session.access_token().await {
        Ok(current) => current,
        Err(_) => return Err(ProxyError::HardUnauthorized),
    };
    if current == token {
        return Ok(first);
    }

    send_once(method, &url, headers, body.clone(), &current).await
}

async fn send_once(
    method: &Method,
    url: &str,
    headers: &HeaderMap,
    body: axum::body::Bytes,
    token: &str,
) -> Result<reqwest::Response, ProxyError> {
    let builder = proxy_client()
        .request(method.clone(), url)
        .headers(headers.clone())
        .bearer_auth(token)
        .body(body);
    match tokio::time::timeout(UPSTREAM_HEADERS_TIMEOUT, builder.send()).await {
        Ok(Ok(resp)) => Ok(resp),
        Ok(Err(err)) => Err(ProxyError::Network(err.to_string())),
        Err(_elapsed) => Err(ProxyError::Network("upstream headers timeout".to_string())),
    }
}

/// [`send_once`]'s sibling for [`proxy_auth_path`] — same headers-timeout
/// handling, but no `Authorization: Bearer` attached at all (the auth-path
/// branch authenticates via the `Cookie` header already present in
/// `headers`, not a bearer token).
async fn send_once_no_bearer(
    method: &Method,
    url: &str,
    headers: &HeaderMap,
    body: axum::body::Bytes,
) -> Result<reqwest::Response, ProxyError> {
    let builder = proxy_client()
        .request(method.clone(), url)
        .headers(headers.clone())
        .body(body);
    match tokio::time::timeout(UPSTREAM_HEADERS_TIMEOUT, builder.send()).await {
        Ok(Ok(resp)) => Ok(resp),
        Ok(Err(err)) => Err(ProxyError::Network(err.to_string())),
        Err(_elapsed) => Err(ProxyError::Network("upstream headers timeout".to_string())),
    }
}

/// Streams the upstream response back verbatim — status, headers (minus
/// hop-by-hop, PLUS `Set-Cookie` — see below), and body via `bytes_stream()`
/// rather than buffering, so SSE/chunked responses pass through
/// incrementally instead of waiting for the whole thing.
async fn build_response(upstream: reqwest::Response) -> Response {
    let status = upstream.status();
    let mut headers = upstream.headers().clone();
    strip_hop_by_hop_headers(&mut headers);
    // Defense-in-depth, uniform with `build_auth_response`: this branch now
    // also attaches the durable session cookie (`attach_persisted_cookie`), so
    // an org-scoped route that unexpectedly echoed a `Set-Cookie` must never
    // let it reach the webview.
    headers.remove(header::SET_COOKIE);
    let body = Body::from_stream(upstream.bytes_stream());
    let mut res = Response::new(body);
    *res.status_mut() = status;
    *res.headers_mut() = headers;
    res
}

/// [`build_response`]'s sibling for [`proxy_auth_path`]: same hop-by-hop
/// stripping and streaming behavior, PLUS `Set-Cookie` is ALWAYS stripped
/// (already captured into the jar by the caller before this runs — see
/// `proxy_auth_path`) — the webview must never see the real upstream
/// session cookie. `HeaderMap::remove` removes every entry for a given
/// name, so a response carrying multiple `Set-Cookie` headers (Better Auth
/// sometimes sets more than one, e.g. a session token plus a companion
/// flag cookie) is fully stripped, not just the first.
async fn build_auth_response(upstream: reqwest::Response) -> Response {
    let status = upstream.status();
    let mut headers = upstream.headers().clone();
    strip_hop_by_hop_headers(&mut headers);
    headers.remove(header::SET_COOKIE);
    let body = Body::from_stream(upstream.bytes_stream());
    let mut res = Response::new(body);
    *res.status_mut() = status;
    *res.headers_mut() = headers;
    res
}

/// `401 {"error":"unauthorized","upstream":true}` — same envelope as the
/// LOCAL bearer's own 401 (the `error` field), plus an `upstream: true`
/// hint so a caller can disambiguate the two (the contract doc flagged
/// this exact shape as "TBD" pending a Phase 3 implementer; this is that
/// implementation). Used both when there's no upstream session to even
/// attempt a request with, and when the dedicated OAuth probe rejects the
/// credential after its refresh path. A resource-specific `401` is passed
/// through unchanged and never reaches this helper.
fn unauthorized_upstream() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        Json(json!({ "error": "unauthorized", "upstream": true })),
    )
        .into_response()
}

/// `POST /_auth/complete-session` — an HTTP mirror of the
/// `auth_complete_session` Tauri command (`src-tauri/src/commands.rs`),
/// wired directly on the `upstream` sub-router in `router.rs` ALONGSIDE
/// (not through) [`proxy`]'s `/api/*` scope allowlist, so the black-box
/// contract suite (`apps/native/e2e/`, which has no Tauri context to
/// invoke IPC commands through) can drive the SAME bridge
/// (`upstream::UpstreamSession::complete_session`) the shell calls into.
/// Both call sites converge on the one `upstream::global()` singleton, so
/// they can never disagree about the outcome — this route exists purely
/// because the e2e harness only speaks HTTP, not as a second
/// implementation. Not part of the `/api/*` proxy scope allowlist (this is
/// a LOCAL action, never forwarded anywhere) and not documented as a
/// stable public surface in the contract doc beyond this note.
pub async fn complete_session() -> Response {
    match upstream::global().complete_session().await {
        Ok(status) => Json(json!({
            "signedIn": status.signed_in,
            "userLabel": status.user_label,
        }))
        .into_response(),
        Err(err) => {
            let is_no_cookie = matches!(
                err,
                upstream::session::SessionError::Bridge(
                    upstream::bridge::BridgeError::NoSessionCookie
                )
            );
            let status = if is_no_cookie {
                StatusCode::UNAUTHORIZED
            } else {
                StatusCode::BAD_GATEWAY
            };
            (status, Json(json!({ "error": err.to_string() }))).into_response()
        }
    }
}

/// `GET /_auth/status` — e2e-reachable HTTP mirror of the shell's
/// `auth_status` Tauri command. Like [`complete_session`] and [`logout`], this
/// calls the same process-wide session singleton; it exists so black-box HTTP
/// coverage can prove that a proxied Better Auth sign-out changed the native
/// auth state rather than merely making subsequent proxy calls fail.
pub async fn status() -> Response {
    let status = upstream::global().status().await;
    Json(json!({
        "signedIn": status.signed_in,
        "userLabel": status.user_label,
        "upstreamUrl": status.upstream_url,
    }))
    .into_response()
}

/// `POST /_auth/logout` — the same kind of e2e-reachable HTTP mirror as
/// [`complete_session`], for the `auth_logout` Tauri command
/// (`src-tauri/src/commands.rs::auth_logout`). Both call sites converge on
/// the SAME `upstream::global().logout()` — this route exists purely
/// because `apps/native/e2e/` has no Tauri context to invoke IPC commands
/// through, not as a second implementation. Always `200` (logout has no
/// failure mode from the caller's point of view — see
/// `UpstreamSession::logout`'s own doc comment on why the upstream revoke
/// half is unconditionally best-effort).
pub async fn logout() -> Response {
    let status = upstream::global().logout().await;
    Json(json!({
        "signedIn": status.signed_in,
        "userLabel": status.user_label,
    }))
    .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;
    use axum::routing::{get, post};
    use axum::Router;
    use futures::StreamExt;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use tokio::net::TcpListener;
    use upstream::tokens::{
        host_key, test_support::MemoryTokenStore, StoredSession, TokenStore, UserInfo,
    };
    use upstream::UpstreamSession;

    /// The whole point of the rewrite: the version the webview polls for must
    /// be the bundle's own, so `version-check-dialog.tsx` never nags inside an
    /// app whose "Refresh" cannot fetch new assets. An empty constant silently
    /// disables that, so pin it here — a renamed/moved `apps/api/package.json`
    /// must fail this test, not degrade quietly at runtime.
    #[test]
    fn studio_web_version_is_baked_in_at_build_time() {
        assert!(
            !STUDIO_WEB_VERSION.is_empty(),
            "build.rs failed to read apps/api/package.json's version"
        );
        assert!(
            STUDIO_WEB_VERSION.starts_with(|c: char| c.is_ascii_digit()),
            "expected a semver-ish version, got {STUDIO_WEB_VERSION:?}"
        );
    }

    #[test]
    fn protected_resource_metadata_points_at_the_caller_origin() {
        // The real RFC 9728 shape, built by upstream from ITS own origin.
        let body = br#"{"resource":"https://studio.decocms.com/api/acme/mcp/conn_1","authorization_servers":["https://studio.decocms.com/oauth-proxy/conn_1"],"bearer_methods_supported":["header"]}"#;
        let out =
            rewrite_resource_field(body, "https://studio.decocms.com", "http://localhost:4420")
                .expect("rewritten");
        let v: serde_json::Value = serde_json::from_slice(&out).unwrap();

        assert_eq!(v["resource"], "http://localhost:4420/api/acme/mcp/conn_1");
        // The authorization server is upstream's and stays upstream's — this
        // proxy has no OAuth endpoints of its own to offer instead.
        assert_eq!(
            v["authorization_servers"][0],
            "https://studio.decocms.com/oauth-proxy/conn_1"
        );
        assert_eq!(v["bearer_methods_supported"][0], "header");
    }

    #[test]
    fn metadata_that_does_not_name_upstream_is_left_alone() {
        for untouched in [
            // Already local.
            br#"{"resource":"http://localhost:4420/api/a/mcp/c"}"#.as_slice(),
            // A different host that merely starts the same way.
            br#"{"resource":"https://studio.decocms.com.evil.example/api/a/mcp/c"}"#.as_slice(),
            // No `resource` field at all.
            br#"{"authorization_servers":["https://studio.decocms.com/x"]}"#.as_slice(),
            // Not JSON.
            b"<html>nope</html>".as_slice(),
        ] {
            assert!(rewrite_resource_field(
                untouched,
                "https://studio.decocms.com",
                "http://localhost:4420"
            )
            .is_none());
        }
    }

    #[test]
    fn caller_origin_prefers_origin_then_falls_back_to_host() {
        let mut h = HeaderMap::new();
        h.insert(header::HOST, HeaderValue::from_static("localhost:4420"));
        assert_eq!(caller_origin(&h).as_deref(), Some("http://localhost:4420"));

        h.insert(
            header::ORIGIN,
            HeaderValue::from_static("http://localhost:9999"),
        );
        assert_eq!(caller_origin(&h).as_deref(), Some("http://localhost:9999"));
    }

    #[test]
    fn both_rfc9728_anchorings_are_recognized() {
        assert!(is_protected_resource_metadata(
            "/.well-known/oauth-protected-resource/api/acme/mcp/conn_1"
        ));
        assert!(is_protected_resource_metadata(
            "/mcp/conn_1/.well-known/oauth-protected-resource"
        ));
        assert!(!is_protected_resource_metadata("/api/acme/mcp/conn_1"));
    }

    #[test]
    fn org_logos_are_rewritten_to_a_same_origin_path() {
        // The real shape: Better Auth's organization list with an absolute
        // upstream logo URL, which an <img> cannot fetch cross-origin.
        let body = br#"[{"id":"o1","slug":"fila","logo":"https://studio.decocms.com/api/fila/files/org-logos/abc123"}]"#;
        let out =
            localize_first_party_asset_urls(body, "https://studio.decocms.com").expect("rewritten");
        let text = String::from_utf8(out).unwrap();
        assert!(
            text.contains(r#""logo":"/api/fila/files/org-logos/abc123""#),
            "{text}"
        );
    }

    /// Widening this would turn the proxy into a general authenticated asset
    /// relay, so what it must NOT touch is the part worth pinning.
    #[test]
    fn only_exact_origin_first_party_file_urls_are_rewritten() {
        let origin = "https://studio.decocms.com";
        for untouched in [
            // A different host that merely starts the same way.
            r#"{"logo":"https://studio.decocms.com.evil.example/api/o/files/x"}"#,
            // Public CDN asset — must keep loading directly.
            r#"{"logo":"https://assets.decocache.com/decocms/abc/def"}"#,
            // Right origin, but not a protected-file path.
            r#"{"url":"https://studio.decocms.com/api/o/threads/t1"}"#,
            // Credentials in the URL never prefix-match the bare origin.
            r#"{"logo":"https://user:pw@studio.decocms.com/api/o/files/x"}"#,
        ] {
            assert!(
                localize_first_party_asset_urls(untouched.as_bytes(), origin).is_none(),
                "rewrote {untouched}"
            );
        }
    }

    #[test]
    fn only_org_bearing_auth_paths_are_buffered() {
        assert!(carries_org_assets("/api/auth/organization/list"));
        assert!(carries_org_assets("/api/auth/get-session?x=1"));
        // Everything else keeps streaming.
        assert!(!carries_org_assets("/api/auth/sign-in/email"));
        assert!(!carries_org_assets("/api/auth/callback/google"));
    }

    #[test]
    fn patch_config_version_replaces_only_the_version_field() {
        let body = br#"{"config":{"version":"9.9.9","posthog":{"key":"k"},"runtime":{"a":1}}}"#;
        let patched = patch_config_version(body, "4.125.3").expect("well-formed config is patched");
        let value: serde_json::Value = serde_json::from_slice(&patched).unwrap();

        assert_eq!(value["config"]["version"], "4.125.3");
        // Everything else passes through untouched.
        assert_eq!(value["config"]["posthog"]["key"], "k");
        assert_eq!(value["config"]["runtime"]["a"], 1);
    }

    #[test]
    fn patch_config_version_passes_through_unexpected_shapes() {
        // Not JSON at all (an HTML error page from a proxy in front of us).
        assert!(patch_config_version(b"<html>nope</html>", "4.125.3").is_none());
        // JSON, but no `config` envelope.
        assert!(patch_config_version(br#"{"version":"1.0.0"}"#, "4.125.3").is_none());
        // `config` present but no `version` key.
        assert!(patch_config_version(br#"{"config":{}}"#, "4.125.3").is_none());
        // `version` present but not a string — never coerce a foreign shape.
        assert!(patch_config_version(br#"{"config":{"version":42}}"#, "4.125.3").is_none());
    }

    #[test]
    fn merge_cookie_headers_keeps_session_cookie_alongside_captured_cf_bm() {
        // The exact regression: persisted holds the session cookie, the jar
        // holds only Cloudflare's `__cf_bm` — the merge must forward BOTH, so
        // `__cf_bm` can't shadow the session cookie (which 401'd org calls).
        let merged = merge_cookie_headers(
            Some("__Secure-better-auth.session_token=SESSION"),
            Some("__cf_bm=CFVALUE"),
        )
        .expect("merge of two non-empty headers is Some");
        assert!(merged.contains("__Secure-better-auth.session_token=SESSION"));
        assert!(merged.contains("__cf_bm=CFVALUE"));
    }

    #[test]
    fn merge_cookie_headers_overlay_wins_and_handles_absent_sides() {
        // Jar (overlay) carries the freshest rotated session token → it wins,
        // but keeps the original first-seen position.
        assert_eq!(
            merge_cookie_headers(Some("a=old; b=keep"), Some("a=new")).as_deref(),
            Some("a=new; b=keep"),
        );
        assert_eq!(
            merge_cookie_headers(Some("a=1"), None).as_deref(),
            Some("a=1")
        );
        assert_eq!(
            merge_cookie_headers(None, Some("b=2")).as_deref(),
            Some("b=2")
        );
        assert_eq!(merge_cookie_headers(None, None), None);
        assert_eq!(merge_cookie_headers(Some("   "), None), None);
    }

    #[test]
    fn is_better_auth_set_cookie_accepts_our_cookies_and_rejects_cdn_ones() {
        // Ours — every prefix variant.
        assert!(is_better_auth_set_cookie(
            "__Secure-better-auth.session_token=abc; Path=/; HttpOnly"
        ));
        assert!(is_better_auth_set_cookie("better-auth.session_token=abc"));
        assert!(is_better_auth_set_cookie(
            "__Host-better-auth.session_data=xyz; Secure"
        ));
        // Cloudflare / CDN infra cookies — must be rejected so they can't
        // clobber the persisted session cookie.
        assert!(!is_better_auth_set_cookie("__cf_bm=abc; Path=/; Secure"));
        assert!(!is_better_auth_set_cookie("cf_clearance=abc"));
        assert!(!is_better_auth_set_cookie("_cfuvid=abc"));
    }

    fn now_unix() -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64
    }

    async fn signed_in_session_with_store(
        target: &str,
        access_token: &str,
    ) -> (UpstreamSession, Arc<MemoryTokenStore>) {
        let store = Arc::new(MemoryTokenStore::new());
        let session = StoredSession {
            target: target.to_string(),
            client_id: "client_1".to_string(),
            user: UserInfo {
                sub: "user_1".to_string(),
                email: Some("a@b.com".to_string()),
                name: None,
            },
            access_token: access_token.to_string(),
            refresh_token: Some("refresh_1".to_string()),
            expires_at: Some(now_unix() + 3600),
            created_at: "2026-01-01T00:00:00Z".to_string(),
            cookie: None,
        };
        store.save(&host_key(target), session).await.unwrap();
        (
            UpstreamSession::new(target.to_string(), store.clone()),
            store,
        )
    }

    async fn signed_in_session(target: &str, access_token: &str) -> UpstreamSession {
        signed_in_session_with_store(target, access_token).await.0
    }

    #[tokio::test]
    async fn native_watch_is_intercepted_without_contacting_upstream() {
        let dir = tempfile::tempdir().unwrap();
        let state = crate::routes::intercept::test_state(dir.path());
        let request = Request::builder()
            .method(Method::GET)
            .uri("/api/acme/watch?types=decopilot.thread.status")
            .body(Body::empty())
            .unwrap();

        // The process-global upstream session is deliberately not configured
        // in this test. A fallthrough would return 401 (or block on credential
        // resolution); the local watch must answer immediately instead.
        let response = tokio::time::timeout(Duration::from_secs(1), proxy(State(state), request))
            .await
            .expect("local watch attempted an upstream operation");
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers().get(header::CONTENT_TYPE).unwrap(),
            "text/event-stream"
        );

        let mut body = response.into_body().into_data_stream();
        let connected = tokio::time::timeout(Duration::from_secs(1), body.next())
            .await
            .expect("local connected frame timed out")
            .expect("local watch stream ended")
            .expect("local watch frame failed");
        let connected = String::from_utf8(connected.to_vec()).unwrap();
        assert!(connected.contains("event: connected"));
        assert!(connected.contains("\"organizationId\":\"acme\""));
    }

    // --- proxy_auth_path: the /api/auth/* cookie-relay branch ---------------

    #[tokio::test]
    async fn proxy_auth_path_captures_set_cookie_strips_it_and_attaches_it_next_time() {
        let seen_cookie_headers = Arc::new(std::sync::Mutex::new(Vec::<Option<String>>::new()));
        let seen_for_route = seen_cookie_headers.clone();
        let app = Router::new().route(
            "/api/auth/sign-in/email",
            post(move |headers: HeaderMap| {
                let seen = seen_for_route.clone();
                async move {
                    seen.lock().unwrap().push(
                        headers
                            .get(header::COOKIE)
                            .and_then(|v| v.to_str().ok())
                            .map(|s| s.to_string()),
                    );
                    (
                        [(
                            header::SET_COOKIE,
                            "better-auth.session_token=abc123; Path=/; HttpOnly",
                        )],
                        Json(json!({"ok": true})),
                    )
                }
            }),
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        let target = format!("http://{addr}");

        let store = Arc::new(MemoryTokenStore::new());
        let session = UpstreamSession::new(target, store);
        let headers = HeaderMap::new();
        let body = axum::body::Bytes::from_static(br#"{"email":"a@b.com"}"#);

        // First call: jar is empty, nothing forwarded yet.
        let res1 = proxy_auth_path(
            &session,
            &Method::POST,
            "/api/auth/sign-in/email",
            &headers,
            &body,
        )
        .await;
        assert_eq!(res1.status(), StatusCode::OK);
        assert!(
            res1.headers().get(header::SET_COOKIE).is_none(),
            "Set-Cookie must never reach the caller"
        );
        assert!(
            !session.cookie_jar().is_empty(session.host()),
            "the response's Set-Cookie must be captured into the jar"
        );

        // Second call: the jar's captured cookie must now ride along.
        let res2 = proxy_auth_path(
            &session,
            &Method::POST,
            "/api/auth/sign-in/email",
            &headers,
            &body,
        )
        .await;
        assert_eq!(res2.status(), StatusCode::OK);

        let seen = seen_cookie_headers.lock().unwrap();
        assert_eq!(seen[0], None, "first request had nothing captured yet");
        assert_eq!(
            seen[1].as_deref(),
            Some("better-auth.session_token=abc123"),
            "second request must attach the jar's captured cookie"
        );
    }

    #[tokio::test]
    async fn proxy_auth_path_never_attaches_the_oauth_bearer_token() {
        let seen_auth = Arc::new(std::sync::Mutex::new(None::<String>));
        let seen_for_route = seen_auth.clone();
        let app = Router::new().route(
            "/api/auth/get-session",
            get(move |headers: HeaderMap| {
                let seen = seen_for_route.clone();
                async move {
                    *seen.lock().unwrap() = headers
                        .get(header::AUTHORIZATION)
                        .and_then(|v| v.to_str().ok())
                        .map(|s| s.to_string());
                    StatusCode::OK
                }
            }),
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        let target = format!("http://{addr}");

        // A session WITH a stored OAuth token — the auth-path branch must
        // still never attach it (org-data bearer forwarding and
        // /api/auth/* cookie forwarding are mutually exclusive branches).
        let session = signed_in_session(&target, "some-oauth-access-token").await;
        let headers = HeaderMap::new();
        let body = axum::body::Bytes::new();

        let res = proxy_auth_path(
            &session,
            &Method::GET,
            "/api/auth/get-session",
            &headers,
            &body,
        )
        .await;
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(
            seen_auth.lock().unwrap().as_deref(),
            None,
            "the auth-path branch must never attach the Keychain OAuth bearer"
        );
    }

    #[tokio::test]
    async fn proxy_auth_path_ignores_the_callers_own_cookie_header() {
        // A caller-forged/stray `Cookie` header must never ride through —
        // only the jar's own captured value (or nothing) is ever forwarded.
        let seen_cookie = Arc::new(std::sync::Mutex::new(Some("unset".to_string())));
        let seen_for_route = seen_cookie.clone();
        let app = Router::new().route(
            "/api/auth/get-session",
            get(move |headers: HeaderMap| {
                let seen = seen_for_route.clone();
                async move {
                    *seen.lock().unwrap() = headers
                        .get(header::COOKIE)
                        .and_then(|v| v.to_str().ok())
                        .map(|s| s.to_string());
                    StatusCode::OK
                }
            }),
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        let target = format!("http://{addr}");
        let store = Arc::new(MemoryTokenStore::new());
        let session = UpstreamSession::new(target, store);

        let mut headers = HeaderMap::new();
        headers.insert(
            header::COOKIE,
            HeaderValue::from_static("forged=should-never-be-forwarded"),
        );
        let body = axum::body::Bytes::new();

        proxy_auth_path(
            &session,
            &Method::GET,
            "/api/auth/get-session",
            &headers,
            &body,
        )
        .await;

        assert_eq!(
            seen_cookie.lock().unwrap().as_ref(),
            None,
            "the jar is empty and the caller's own Cookie header must never be forwarded"
        );
    }

    // --- proxy_public_config: the GET /api/config no-auth branch -----------

    #[tokio::test]
    async fn proxy_public_config_works_with_no_session_at_all() {
        // The whole point: this must succeed even for a session with NO
        // stored token and an EMPTY cookie jar — the exact pre-sign-in state
        // the desktop sign-in screen is in when it needs this route most.
        let app = Router::new().route(
            "/api/config",
            get(|| async { Json(json!({"auth": {"emailAndPassword": {"enabled": true}}})) }),
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        let target = format!("http://{addr}");
        let store = Arc::new(MemoryTokenStore::new());
        let session = UpstreamSession::new(target, store);
        let headers = HeaderMap::new();
        let body = axum::body::Bytes::new();

        let res = proxy_public_config(&session, &Method::GET, "/api/config", &headers, &body).await;
        assert_eq!(res.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn proxy_public_config_never_attaches_a_bearer_or_cookie_from_the_jar() {
        let seen_auth = Arc::new(std::sync::Mutex::new(Some("unset".to_string())));
        let seen_cookie = Arc::new(std::sync::Mutex::new(Some("unset".to_string())));
        let seen_auth_for_route = seen_auth.clone();
        let seen_cookie_for_route = seen_cookie.clone();
        let app = Router::new().route(
            "/api/config",
            get(move |headers: HeaderMap| {
                let seen_auth = seen_auth_for_route.clone();
                let seen_cookie = seen_cookie_for_route.clone();
                async move {
                    *seen_auth.lock().unwrap() = headers
                        .get(header::AUTHORIZATION)
                        .and_then(|v| v.to_str().ok())
                        .map(|s| s.to_string());
                    *seen_cookie.lock().unwrap() = headers
                        .get(header::COOKIE)
                        .and_then(|v| v.to_str().ok())
                        .map(|s| s.to_string());
                    (
                        [(header::SET_COOKIE, "should-be-stripped=yes; Path=/")],
                        Json(json!({"ok": true})),
                    )
                }
            }),
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        let target = format!("http://{addr}");

        // A session WITH both a stored OAuth token AND a captured cookie —
        // this branch must ignore both.
        let session = signed_in_session(&target, "some-oauth-access-token").await;
        session.cookie_jar().capture(
            session.host(),
            std::iter::once("session=should-not-be-sent"),
        );
        let mut headers = HeaderMap::new();
        headers.insert(
            header::COOKIE,
            HeaderValue::from_static("forged=should-never-be-forwarded"),
        );
        let body = axum::body::Bytes::new();

        let res = proxy_public_config(&session, &Method::GET, "/api/config", &headers, &body).await;
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(
            seen_auth.lock().unwrap().as_deref(),
            None,
            "GET /api/config must never carry the Keychain OAuth bearer"
        );
        assert_eq!(
            seen_cookie.lock().unwrap().as_deref(),
            None,
            "GET /api/config must never carry the jar's cookie or the caller's own"
        );
        assert!(
            res.headers().get(header::SET_COOKIE).is_none(),
            "Set-Cookie must be stripped even on this public branch"
        );
    }

    #[tokio::test]
    async fn build_forward_headers_strips_hop_by_hop_host_and_local_authorization() {
        let mut incoming = HeaderMap::new();
        incoming.insert(
            header::AUTHORIZATION,
            HeaderValue::from_static("Bearer local-token"),
        );
        incoming.insert(header::HOST, HeaderValue::from_static("127.0.0.1:9999"));
        incoming.insert(
            header::CONNECTION,
            HeaderValue::from_static("keep-alive, x-private"),
        );
        incoming.insert("x-private", HeaderValue::from_static("connection-only"));
        incoming.insert("keep-alive", HeaderValue::from_static("timeout=5"));
        incoming.insert("proxy-connection", HeaderValue::from_static("keep-alive"));
        incoming.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/json"),
        );

        let out = build_forward_headers(&incoming);
        assert!(out.get(header::AUTHORIZATION).is_none());
        assert!(out.get(header::HOST).is_none());
        assert!(out.get(header::CONNECTION).is_none());
        assert!(out.get("x-private").is_none());
        assert!(out.get("keep-alive").is_none());
        assert!(out.get("proxy-connection").is_none());
        assert_eq!(
            out.get(header::CONTENT_TYPE),
            Some(&HeaderValue::from_static("application/json"))
        );
    }

    #[tokio::test]
    async fn forwards_method_path_query_body_and_attaches_upstream_bearer() {
        let seen_auth = Arc::new(std::sync::Mutex::new(None));
        let seen_for_route = seen_auth.clone();
        let app = Router::new().route(
            "/api/acme/threads",
            post(move |headers: HeaderMap, body: axum::body::Bytes| {
                let seen = seen_for_route.clone();
                async move {
                    *seen.lock().unwrap() = headers
                        .get(header::AUTHORIZATION)
                        .and_then(|v| v.to_str().ok())
                        .map(|s| s.to_string());
                    // Echo the raw body back verbatim (not re-wrapped in a
                    // JSON field, which would escape its quotes and make
                    // the assertion below a substring-match footgun).
                    (StatusCode::OK, body)
                }
            }),
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        let target = format!("http://{addr}");
        let session = signed_in_session(&target, "good-token").await;

        let headers = HeaderMap::new();
        let body = axum::body::Bytes::from_static(br#"{"hello":"world"}"#);
        let res = send_with_retry(
            &session,
            &Method::POST,
            "/api/acme/threads?x=1",
            &headers,
            &body,
            "good-token".to_string(),
        )
        .await
        .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(
            seen_auth.lock().unwrap().as_deref(),
            Some("Bearer good-token")
        );

        let text = res.text().await.unwrap();
        assert_eq!(text, r#"{"hello":"world"}"#);
    }

    #[tokio::test]
    async fn forwards_redirect_status_and_location_without_following() {
        let followed = Arc::new(AtomicUsize::new(0));
        let followed_for_route = followed.clone();
        let app = Router::new()
            .route(
                "/oauth-proxy/start",
                get(|| async {
                    (
                        StatusCode::FOUND,
                        [(header::LOCATION, "/oauth-proxy/complete?code=redirect-code")],
                    )
                }),
            )
            .route(
                "/oauth-proxy/complete",
                get(move || {
                    let followed = followed_for_route.clone();
                    async move {
                        followed.fetch_add(1, Ordering::SeqCst);
                        StatusCode::OK
                    }
                }),
            );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        let target = format!("http://{addr}");
        let session = signed_in_session(&target, "good-token").await;
        let upstream = send_with_retry(
            &session,
            &Method::GET,
            "/oauth-proxy/start",
            &HeaderMap::new(),
            &axum::body::Bytes::new(),
            "good-token".to_string(),
        )
        .await
        .unwrap();
        let response = build_response(upstream).await;

        assert_eq!(response.status(), StatusCode::FOUND);
        assert_eq!(
            response.headers().get(header::LOCATION),
            Some(&HeaderValue::from_static(
                "/oauth-proxy/complete?code=redirect-code"
            ))
        );
        assert_eq!(
            followed.load(Ordering::SeqCst),
            0,
            "the Rust proxy must not consume browser-owned redirects"
        );
    }

    #[tokio::test]
    async fn a_resource_specific_401_preserves_the_authenticated_session() {
        let calls = Arc::new(AtomicUsize::new(0));
        let calls_route = calls.clone();
        let app = Router::new()
            .route(
                "/api/acme/threads",
                get(move || {
                    let calls = calls_route.clone();
                    async move {
                        calls.fetch_add(1, Ordering::SeqCst);
                        (
                            StatusCode::UNAUTHORIZED,
                            [(header::WWW_AUTHENTICATE, "Bearer resource-oauth")],
                            "connection authorization required",
                        )
                    }
                }),
            )
            .route("/api/links/me", get(|| async { StatusCode::OK }));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        let target = format!("http://{addr}");
        let session = signed_in_session(&target, "old-token").await;

        let headers = HeaderMap::new();
        let body = axum::body::Bytes::new();
        let res = send_with_retry(
            &session,
            &Method::GET,
            "/api/acme/threads",
            &headers,
            &body,
            "old-token".to_string(),
        )
        .await
        .unwrap();
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(
            res.headers().get(header::WWW_AUTHENTICATE),
            Some(&HeaderValue::from_static("Bearer resource-oauth")),
        );
        assert_eq!(
            res.text().await.unwrap(),
            "connection authorization required",
        );
        assert_eq!(
            calls.load(Ordering::SeqCst),
            1,
            "must not retry when the dedicated auth probe accepts the same token"
        );
        assert!(session.status().await.signed_in);
    }

    #[tokio::test]
    async fn a_401_force_refreshes_and_retries_once_with_the_new_token() {
        let calls = Arc::new(AtomicUsize::new(0));
        let calls_route = calls.clone();
        let app = Router::new()
            .route(
                "/api/acme/threads",
                get(move |headers: HeaderMap| {
                    let calls = calls_route.clone();
                    async move {
                        calls.fetch_add(1, Ordering::SeqCst);
                        match headers
                            .get(header::AUTHORIZATION)
                            .and_then(|value| value.to_str().ok())
                        {
                            Some("Bearer refreshed-token") => StatusCode::OK,
                            _ => StatusCode::UNAUTHORIZED,
                        }
                    }
                }),
            )
            .route(
                "/api/auth/mcp/token",
                post(|| async {
                    Json(json!({
                        "access_token": "refreshed-token",
                        "refresh_token": "rotated-refresh-token",
                        "expires_in": 3600,
                    }))
                }),
            )
            .route(
                "/api/links/me",
                get(|headers: HeaderMap| async move {
                    match headers
                        .get(header::AUTHORIZATION)
                        .and_then(|value| value.to_str().ok())
                    {
                        Some("Bearer refreshed-token") => StatusCode::OK,
                        _ => StatusCode::UNAUTHORIZED,
                    }
                }),
            );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        let target = format!("http://{addr}");
        let (session, store) = signed_in_session_with_store(&target, "old-token").await;
        let res = send_with_retry(
            &session,
            &Method::GET,
            "/api/acme/threads",
            &HeaderMap::new(),
            &axum::body::Bytes::new(),
            "old-token".to_string(),
        )
        .await
        .unwrap();

        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        let persisted = store
            .load(&host_key(&target))
            .await
            .unwrap()
            .expect("refreshed session remains persisted");
        assert_eq!(persisted.access_token, "refreshed-token");
        assert_eq!(
            persisted.refresh_token.as_deref(),
            Some("rotated-refresh-token")
        );
    }

    #[tokio::test]
    async fn a_transient_forced_refresh_failure_preserves_the_persisted_session() {
        let resource_calls = Arc::new(AtomicUsize::new(0));
        let resource_calls_route = resource_calls.clone();
        let refresh_calls = Arc::new(AtomicUsize::new(0));
        let refresh_calls_route = refresh_calls.clone();
        let app = Router::new()
            .route(
                "/api/acme/threads",
                get(move || {
                    let calls = resource_calls_route.clone();
                    async move {
                        calls.fetch_add(1, Ordering::SeqCst);
                        StatusCode::UNAUTHORIZED
                    }
                }),
            )
            .route(
                "/api/auth/mcp/token",
                post(move || {
                    let calls = refresh_calls_route.clone();
                    async move {
                        calls.fetch_add(1, Ordering::SeqCst);
                        (
                            StatusCode::SERVICE_UNAVAILABLE,
                            Json(json!({ "error": "temporary outage" })),
                        )
                    }
                }),
            )
            .route("/api/links/me", get(|| async { StatusCode::UNAUTHORIZED }));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        let target = format!("http://{addr}");
        let (session, store) = signed_in_session_with_store(&target, "old-token").await;
        let res = send_with_retry(
            &session,
            &Method::GET,
            "/api/acme/threads",
            &HeaderMap::new(),
            &axum::body::Bytes::new(),
            "old-token".to_string(),
        )
        .await
        .unwrap();

        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(resource_calls.load(Ordering::SeqCst), 1);
        assert_eq!(refresh_calls.load(Ordering::SeqCst), 1);
        let persisted = store
            .load(&host_key(&target))
            .await
            .unwrap()
            .expect("transient refresh failure must preserve the session");
        assert_eq!(persisted.access_token, "old-token");
        assert_eq!(persisted.refresh_token.as_deref(), Some("refresh_1"));
    }

    #[tokio::test]
    async fn an_invalid_grant_during_forced_refresh_clears_the_persisted_session() {
        let resource_calls = Arc::new(AtomicUsize::new(0));
        let resource_calls_route = resource_calls.clone();
        let app = Router::new()
            .route(
                "/api/acme/threads",
                get(move || {
                    let calls = resource_calls_route.clone();
                    async move {
                        calls.fetch_add(1, Ordering::SeqCst);
                        StatusCode::UNAUTHORIZED
                    }
                }),
            )
            .route(
                "/api/auth/mcp/token",
                post(|| async {
                    (
                        StatusCode::BAD_REQUEST,
                        Json(json!({ "error": "invalid_grant" })),
                    )
                }),
            )
            .route("/api/links/me", get(|| async { StatusCode::UNAUTHORIZED }));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        let target = format!("http://{addr}");
        let (session, store) = signed_in_session_with_store(&target, "old-token").await;
        let err = send_with_retry(
            &session,
            &Method::GET,
            "/api/acme/threads",
            &HeaderMap::new(),
            &axum::body::Bytes::new(),
            "old-token".to_string(),
        )
        .await
        .unwrap_err();

        assert!(matches!(err, ProxyError::HardUnauthorized));
        assert_eq!(resource_calls.load(Ordering::SeqCst), 1);
        assert!(
            store.load(&host_key(&target)).await.unwrap().is_none(),
            "a terminal refresh rejection must clear the stale session"
        );
    }

    #[tokio::test]
    async fn a_403_passes_through_untouched_without_triggering_sign_out() {
        let app = Router::new().route(
            "/api/acme/threads",
            get(|| async {
                (
                    StatusCode::FORBIDDEN,
                    Json(json!({"error": "not a member of this org"})),
                )
            }),
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        let target = format!("http://{addr}");
        let session = signed_in_session(&target, "good-token").await;

        let headers = HeaderMap::new();
        let body = axum::body::Bytes::new();
        let res = send_with_retry(
            &session,
            &Method::GET,
            "/api/acme/threads",
            &headers,
            &body,
            "good-token".to_string(),
        )
        .await
        .unwrap();
        assert_eq!(res.status(), StatusCode::FORBIDDEN);
        assert!(
            session.status().await.signed_in,
            "a 403 (authorization, not authentication) must never trigger a sign-out"
        );
    }

    #[tokio::test]
    async fn build_response_streams_body_and_strips_hop_by_hop_response_headers() {
        let app = Router::new().route(
            "/x",
            get(|| async {
                (
                    [
                        (header::CONNECTION, "x-private"),
                        (header::CONTENT_TYPE, "text/event-stream"),
                        (HeaderName::from_static("x-private"), "connection-only"),
                        (HeaderName::from_static("keep-alive"), "timeout=5"),
                        (HeaderName::from_static("proxy-connection"), "keep-alive"),
                    ],
                    "data: hello\n\n",
                )
            }),
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        let client = reqwest::Client::new();
        let upstream_resp = client.get(format!("http://{addr}/x")).send().await.unwrap();
        let res = build_response(upstream_resp).await;
        assert_eq!(res.status(), StatusCode::OK);
        assert!(res.headers().get(header::CONNECTION).is_none());
        assert!(res.headers().get("x-private").is_none());
        assert!(res.headers().get("keep-alive").is_none());
        assert!(res.headers().get("proxy-connection").is_none());
        assert_eq!(
            res.headers().get(header::CONTENT_TYPE),
            Some(&HeaderValue::from_static("text/event-stream"))
        );
        let body = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap();
        assert_eq!(&body[..], b"data: hello\n\n");
    }

    #[tokio::test]
    async fn build_response_strips_set_cookie_too() {
        // Defense-in-depth: even the ordinary org-data branch must never let
        // a stray `Set-Cookie` reach the webview, now that it attaches the
        // durable session cookie on its OWN requests.
        let app = Router::new().route(
            "/x",
            get(|| async {
                (
                    [(header::SET_COOKIE, "should-never-reach-the-webview=1")],
                    "ok",
                )
            }),
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        let client = reqwest::Client::new();
        let upstream_resp = client.get(format!("http://{addr}/x")).send().await.unwrap();
        let res = build_response(upstream_resp).await;
        assert!(res.headers().get(header::SET_COOKIE).is_none());
    }

    #[tokio::test]
    async fn build_auth_response_strips_dynamic_hop_by_hop_headers_and_set_cookie() {
        let app = Router::new().route(
            "/x",
            get(|| async {
                (
                    [
                        (header::CONNECTION, "x-private"),
                        (HeaderName::from_static("x-private"), "connection-only"),
                        (HeaderName::from_static("keep-alive"), "timeout=5"),
                        (HeaderName::from_static("proxy-connection"), "keep-alive"),
                        (
                            header::SET_COOKIE,
                            "better-auth.session_token=secret; HttpOnly",
                        ),
                    ],
                    "ok",
                )
            }),
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        let upstream = reqwest::Client::new()
            .get(format!("http://{addr}/x"))
            .send()
            .await
            .unwrap();
        let res = build_auth_response(upstream).await;

        assert!(res.headers().get(header::CONNECTION).is_none());
        assert!(res.headers().get("x-private").is_none());
        assert!(res.headers().get("keep-alive").is_none());
        assert!(res.headers().get("proxy-connection").is_none());
        assert!(res.headers().get(header::SET_COOKIE).is_none());
    }

    // --- The real-UI course-correction: durable cookie on every proxied call ---

    #[tokio::test]
    async fn attach_persisted_cookie_sets_the_header_when_a_cookie_is_stored() {
        let target = "http://example.invalid".to_string();
        let store = Arc::new(MemoryTokenStore::new());
        let host = host_key(&target);
        store
            .save(
                &host,
                StoredSession {
                    target: target.clone(),
                    client_id: "client_1".to_string(),
                    user: UserInfo {
                        sub: "user_1".to_string(),
                        email: Some("a@b.com".to_string()),
                        name: None,
                    },
                    access_token: "tok".to_string(),
                    refresh_token: Some("refresh_1".to_string()),
                    expires_at: Some(now_unix() + 3600),
                    created_at: "2026-01-01T00:00:00Z".to_string(),
                    cookie: Some("better-auth.session_token=abc".to_string()),
                },
            )
            .await
            .unwrap();
        let session = UpstreamSession::new(target, store);

        let mut headers = HeaderMap::new();
        attach_persisted_cookie(&mut headers, &session).await;
        assert_eq!(
            headers.get(header::COOKIE),
            Some(&HeaderValue::from_static("better-auth.session_token=abc"))
        );
    }

    #[tokio::test]
    async fn attach_persisted_cookie_is_a_no_op_with_no_stored_cookie() {
        let target = "http://example.invalid".to_string();
        let session = signed_in_session(&target, "tok").await; // no cookie seeded
        let mut headers = HeaderMap::new();
        attach_persisted_cookie(&mut headers, &session).await;
        assert!(headers.get(header::COOKIE).is_none());
    }

    #[tokio::test]
    async fn proxy_auth_path_falls_back_to_the_persisted_cookie_when_the_jar_is_empty() {
        // The exact scenario the real UI's sign-in gate depends on: a NEW
        // request (e.g. a page reload) to `/api/auth/get-session` AFTER
        // sign-in already completed and the ephemeral jar was purged —
        // must still carry the durable, Keychain-persisted cookie.
        let seen_cookie = Arc::new(std::sync::Mutex::new(None::<String>));
        let seen_for_route = seen_cookie.clone();
        let app = Router::new().route(
            "/api/auth/get-session",
            get(move |headers: HeaderMap| {
                let seen = seen_for_route.clone();
                async move {
                    *seen.lock().unwrap() = headers
                        .get(header::COOKIE)
                        .and_then(|v| v.to_str().ok())
                        .map(|s| s.to_string());
                    StatusCode::OK
                }
            }),
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        let target = format!("http://{addr}");

        let store = Arc::new(MemoryTokenStore::new());
        let host = host_key(&target);
        store
            .save(
                &host,
                StoredSession {
                    target: target.clone(),
                    client_id: "client_1".to_string(),
                    user: UserInfo {
                        sub: "user_1".to_string(),
                        email: Some("a@b.com".to_string()),
                        name: None,
                    },
                    access_token: "tok".to_string(),
                    refresh_token: Some("refresh_1".to_string()),
                    expires_at: Some(now_unix() + 3600),
                    created_at: "2026-01-01T00:00:00Z".to_string(),
                    cookie: Some("better-auth.session_token=durable".to_string()),
                },
            )
            .await
            .unwrap();
        let session = UpstreamSession::new(target, store);
        // The ephemeral jar is deliberately EMPTY — this is the whole point
        // of the test.
        assert!(session.cookie_jar().is_empty(session.host()));

        let headers = HeaderMap::new();
        let body = axum::body::Bytes::new();
        let res = proxy_auth_path(
            &session,
            &Method::GET,
            "/api/auth/get-session",
            &headers,
            &body,
        )
        .await;
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(
            seen_cookie.lock().unwrap().as_deref(),
            Some("better-auth.session_token=durable"),
            "proxy_auth_path must fall back to the durable persisted cookie when the ephemeral \
             jar has nothing captured"
        );
    }

    #[tokio::test]
    async fn org_data_calls_attach_the_durable_cookie_alongside_the_bearer() {
        // The other half of the fix: ordinary `/api/:org/...` calls (the
        // bearer branch, NOT `/api/auth/*`) must ALSO carry the durable
        // cookie now — some org-scoped surfaces the real shell calls may
        // themselves be dual-auth.
        let seen_cookie = Arc::new(std::sync::Mutex::new(None::<String>));
        let seen_for_route = seen_cookie.clone();
        let app = Router::new().route(
            "/api/acme/threads",
            get(move |headers: HeaderMap| {
                let seen = seen_for_route.clone();
                async move {
                    *seen.lock().unwrap() = headers
                        .get(header::COOKIE)
                        .and_then(|v| v.to_str().ok())
                        .map(|s| s.to_string());
                    StatusCode::OK
                }
            }),
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        let target = format!("http://{addr}");

        let store = Arc::new(MemoryTokenStore::new());
        let host = host_key(&target);
        store
            .save(
                &host,
                StoredSession {
                    target: target.clone(),
                    client_id: "client_1".to_string(),
                    user: UserInfo {
                        sub: "user_1".to_string(),
                        email: Some("a@b.com".to_string()),
                        name: None,
                    },
                    access_token: "good-token".to_string(),
                    refresh_token: Some("refresh_1".to_string()),
                    expires_at: Some(now_unix() + 3600),
                    created_at: "2026-01-01T00:00:00Z".to_string(),
                    cookie: Some("better-auth.session_token=durable".to_string()),
                },
            )
            .await
            .unwrap();
        let session = UpstreamSession::new(target, store);

        let mut out_headers = HeaderMap::new();
        attach_persisted_cookie(&mut out_headers, &session).await;
        let res = send_with_retry(
            &session,
            &Method::GET,
            "/api/acme/threads",
            &out_headers,
            &axum::body::Bytes::new(),
            "good-token".to_string(),
        )
        .await
        .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(
            seen_cookie.lock().unwrap().as_deref(),
            Some("better-auth.session_token=durable")
        );
    }
}
