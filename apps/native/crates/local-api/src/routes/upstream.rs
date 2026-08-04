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
//! retired native Decopilot routes plus the sandbox/thread interception table
//! (`routes/intercept/`) are handled locally, checked FIRST — anything
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

use std::sync::Arc;
use std::time::Duration;

use axum::{
    body::Body,
    extract::{Request, State},
    http::{header, HeaderMap, HeaderValue, Method, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use futures::StreamExt;
use serde_json::json;

use crate::error::ApiError;
use crate::http_util::strip_hop_by_hop_headers;
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

const STALE_UPSTREAM_IDENTITY: &str =
    "Your Studio account changed while this request was running. Try again.";

/// One generic upstream request's authenticated-account ticket.
///
/// Admission captures both independently-moving native boundaries while the
/// upstream subject-transition gate is held: the upstream identity generation
/// and the sandbox/materialization account epoch. Two subscriptions for each
/// boundary avoid a validate/subscribe gap: one pair rejects stale credential
/// selection and retries, while the untouched pair terminates the eventual
/// response body even when bytes are already queued in reqwest.
struct UpstreamRequestTicket {
    identity_generation: u64,
    account_epoch: crate::sandbox::manager::AccountEpoch,
    sandbox_account: Option<crate::sandbox::manager::SandboxAccount>,
    sandbox_manager: Arc<crate::sandbox::SandboxManager>,
    validation_identity_rx: tokio::sync::broadcast::Receiver<upstream::SessionIdentityEvent>,
    body_identity_rx: tokio::sync::broadcast::Receiver<upstream::SessionIdentityEvent>,
    validation_account_rx: tokio::sync::watch::Receiver<crate::sandbox::manager::AccountEpoch>,
    body_account_rx: tokio::sync::watch::Receiver<crate::sandbox::manager::AccountEpoch>,
}

impl UpstreamRequestTicket {
    async fn capture(
        state: &AppState,
        session: &upstream::UpstreamSession,
    ) -> Result<Self, ApiError> {
        let authorization = super::sandbox_account::authorize(state).await?;
        let account_epoch = authorization.epoch();
        let identity_generation = authorization.identity_generation();
        let sandbox_account = authorization.account().clone();

        // Subscribe before releasing `authorization`'s subject-transition
        // guard. Account replacement therefore either happened before this
        // ticket was admitted or is observable by every receiver below.
        let validation_identity_rx = session.subscribe_identity();
        let body_identity_rx = session.subscribe_identity();
        let validation_account_rx = state
            .sandbox_manager
            .watch_account_epoch(account_epoch)
            .map_err(ApiError::conflict)?;
        let body_account_rx = validation_account_rx.clone();

        Ok(Self {
            identity_generation,
            account_epoch,
            sandbox_account: Some(sandbox_account),
            sandbox_manager: state.sandbox_manager.clone(),
            validation_identity_rx,
            body_identity_rx,
            validation_account_rx,
            body_account_rx,
        })
    }

    /// Fence a generic app-API request even when no upstream account exists.
    /// Local interceptors perform their own account admission; an ordinary
    /// proxy request must still reach the canonical upstream-style 401 while
    /// signed out instead of being mistaken for a sandbox operation.
    async fn capture_identity(
        state: &AppState,
        session: &upstream::UpstreamSession,
    ) -> Result<Self, ApiError> {
        let transition = session.begin_transition().await;
        let identity_generation = transition.generation();
        super::sandbox_account::validate_expected_generation(identity_generation)?;
        let account_epoch = state.sandbox_manager.account_epoch();
        super::sandbox_account::validate_expected_epoch(account_epoch)?;

        let validation_identity_rx = session.subscribe_identity();
        let body_identity_rx = session.subscribe_identity();
        let validation_account_rx = state
            .sandbox_manager
            .watch_account_epoch(account_epoch)
            .map_err(ApiError::conflict)?;
        let body_account_rx = validation_account_rx.clone();
        drop(transition);

        Ok(Self {
            identity_generation,
            account_epoch,
            sandbox_account: None,
            sandbox_manager: state.sandbox_manager.clone(),
            validation_identity_rx,
            body_identity_rx,
            validation_account_rx,
            body_account_rx,
        })
    }

    /// Revalidate an exact-path terminal MCP capability without reacquiring
    /// the transition gate held by the spawn owner that minted it. Subscribe
    /// first, then compare both monotonic boundaries; [`Self::validate`]
    /// closes the saturation case by rejecting queued notifications too.
    async fn capture_scoped_mcp(
        state: &AppState,
        session: &upstream::UpstreamSession,
        identity: crate::terminal::registry::ScopedMcpIdentity,
    ) -> Result<Self, ApiError> {
        let validation_identity_rx = session.subscribe_identity();
        let body_identity_rx = session.subscribe_identity();
        let validation_account_rx = state
            .sandbox_manager
            .watch_account_epoch(identity.account_epoch)
            .map_err(|_| ApiError::conflict(STALE_UPSTREAM_IDENTITY))?;
        let body_account_rx = validation_account_rx.clone();

        let mut ticket = Self {
            identity_generation: identity.identity_generation,
            account_epoch: identity.account_epoch,
            sandbox_account: None,
            sandbox_manager: state.sandbox_manager.clone(),
            validation_identity_rx,
            body_identity_rx,
            validation_account_rx,
            body_account_rx,
        };
        if session.identity_generation() != identity.identity_generation
            || ticket.validate().is_err()
        {
            return Err(ApiError::conflict(STALE_UPSTREAM_IDENTITY));
        }
        Ok(ticket)
    }

    /// Recreate subscriptions for a previously captured admission ticket.
    /// Internal launch/sandbox flows carry the original generation+epoch
    /// through long preparation phases; this rejects them before selecting a
    /// credential if the account moved in the meantime.
    async fn capture_expected(
        state: &AppState,
        session: &upstream::UpstreamSession,
        account_epoch: crate::sandbox::manager::AccountEpoch,
        identity_generation: u64,
    ) -> Result<Self, ProxyError> {
        let transition = session.begin_transition().await;
        if transition.generation() != identity_generation
            || state
                .sandbox_manager
                .validate_account_epoch(account_epoch)
                .is_err()
        {
            return Err(ProxyError::StaleIdentity);
        }

        let validation_identity_rx = session.subscribe_identity();
        let body_identity_rx = session.subscribe_identity();
        let validation_account_rx = state
            .sandbox_manager
            .watch_account_epoch(account_epoch)
            .map_err(|_| ProxyError::StaleIdentity)?;
        let body_account_rx = validation_account_rx.clone();
        drop(transition);

        Ok(Self {
            identity_generation,
            account_epoch,
            sandbox_account: None,
            sandbox_manager: state.sandbox_manager.clone(),
            validation_identity_rx,
            body_identity_rx,
            validation_account_rx,
            body_account_rx,
        })
    }

    fn expected_identity(&self) -> super::sandbox_account::ExpectedIdentity {
        super::sandbox_account::ExpectedIdentity::new(self.account_epoch, self.identity_generation)
    }

    /// Reject token/cookie selection and every retry once either account
    /// boundary has moved. `has_changed()` is deliberately checked without
    /// comparing values: epoch saturation publishes the same maximum value
    /// while leaving materialization closed, and must still fail closed.
    fn validate(&mut self) -> Result<(), ProxyError> {
        if self
            .sandbox_manager
            .validate_account_epoch(self.account_epoch)
            .is_err()
            || !matches!(self.validation_account_rx.has_changed(), Ok(false))
        {
            return Err(ProxyError::StaleIdentity);
        }

        match self.validation_identity_rx.try_recv() {
            Err(tokio::sync::broadcast::error::TryRecvError::Empty) => Ok(()),
            Ok(event) => {
                tracing::debug!(
                    expected_generation = self.identity_generation,
                    observed_generation = event.generation,
                    "discarding an upstream request after account replacement"
                );
                Err(ProxyError::StaleIdentity)
            }
            Err(
                tokio::sync::broadcast::error::TryRecvError::Lagged(_)
                | tokio::sync::broadcast::error::TryRecvError::Closed,
            ) => Err(ProxyError::StaleIdentity),
        }
    }

    /// Async counterpart used while buffering a small response that must be
    /// rewritten before it reaches the caller. A transition cancels the read;
    /// if the read wins, the caller synchronously validates once more before
    /// constructing its separately fenced response body.
    async fn validation_changed(&mut self) {
        if self.validate().is_err() {
            return;
        }
        tokio::select! {
            biased;
            _ = self.validation_account_rx.changed() => {}
            _ = self.validation_identity_rx.recv() => {}
        }
    }

    /// Resolves on the first account notification or identity event. Channel
    /// closure is terminal too. The caller uses this as a `take_until` fence,
    /// whose stop future is polled before another upstream body item can be
    /// yielded to the webview.
    async fn changed(mut self) {
        if self
            .sandbox_manager
            .validate_account_epoch(self.account_epoch)
            .is_err()
            || !matches!(self.body_account_rx.has_changed(), Ok(false))
        {
            return;
        }
        match self.body_identity_rx.try_recv() {
            Err(tokio::sync::broadcast::error::TryRecvError::Empty) => {}
            Ok(_)
            | Err(
                tokio::sync::broadcast::error::TryRecvError::Lagged(_)
                | tokio::sync::broadcast::error::TryRecvError::Closed,
            ) => return,
        }

        tokio::select! {
            biased;
            // Any account notification is terminal, including a successful
            // same-value notification at epoch saturation.
            _ = self.body_account_rx.changed() => {}
            _ = self.body_identity_rx.recv() => {}
        }
    }
}

/// Clear an invalid credential only if the request that observed the failure
/// still owns the current subject. Reacquiring the transition guard and
/// comparing the captured generation closes the otherwise-dangerous gap where
/// account B could be installed between account A's refresh error and cleanup.
async fn hard_sign_out_if_ticket_current(
    state: &AppState,
    session: &upstream::UpstreamSession,
    ticket: &mut UpstreamRequestTicket,
    reason: &str,
) -> bool {
    if ticket.validate().is_err() {
        return false;
    }
    // The helper reacquires the subject-transition guard and compares both
    // captured boundaries before clearing anything.
    crate::auth_fence::hard_sign_out_upstream_session_if_current(
        state,
        session,
        ticket.identity_generation,
        ticket.account_epoch,
        reason,
    )
    .await
}

/// Apply the ingress fence to locally intercepted responses as well. Most
/// interceptors return small JSON bodies, but wrapping the body stream matters
/// for watch/SSE and closes the final gap where an account transition lands
/// after a handler's last authorization check but before axum polls its body.
fn fence_response_for_identity(response: Response, mut ticket: UpstreamRequestTicket) -> Response {
    if ticket.validate().is_err() {
        return ApiError::conflict(STALE_UPSTREAM_IDENTITY).into_response();
    }
    let (mut parts, body) = response.into_parts();
    parts.headers.remove(header::CONTENT_LENGTH);
    let body = Body::from_stream(body.into_data_stream().take_until(ticket.changed()));
    Response::from_parts(parts, body)
}

pub async fn proxy(State(state): State<AppState>, req: Request) -> Response {
    let (parts, body) = req.into_parts();
    let path = parts.uri.path().to_string();
    let path_and_query = parts
        .uri
        .path_and_query()
        .map(|pq| pq.as_str().to_string())
        .unwrap_or_else(|| path.clone());

    tracing::debug!(method = %parts.method, path = %path, "app-api proxy: incoming request");

    let session = upstream::global();
    let scoped_mcp_identity = parts
        .extensions
        .get::<crate::terminal::registry::ScopedMcpIdentity>()
        .copied();
    let auth_path = path_and_query.split('?').next().unwrap_or(&path_and_query);
    let is_auth_path = path.starts_with(AUTH_PATH_PREFIX);
    let is_sign_out = parts.method == Method::POST && auth_path == AUTH_SIGN_OUT_PATH;
    // Login/auth bootstrap and public config are deliberately sessionless.
    // Sign-out is different: it mutates the current identity, so it must be
    // admitted for the account that sent it before body buffering too.
    let needs_identity_ticket = is_sign_out || (!is_auth_path && path != PUBLIC_NO_AUTH_PATH);
    let mut identity_ticket = if needs_identity_ticket {
        let capture = if let Some(identity) = scoped_mcp_identity {
            UpstreamRequestTicket::capture_scoped_mcp(&state, &session, identity).await
        } else if is_sign_out {
            UpstreamRequestTicket::capture(&state, &session).await
        } else {
            UpstreamRequestTicket::capture_identity(&state, &session).await
        };
        match capture {
            Ok(ticket) => Some(ticket),
            Err(error) => return error.into_response(),
        }
    } else {
        None
    };

    let body_result = if let Some(ticket) = identity_ticket.as_mut() {
        tokio::select! {
            biased;
            _ = ticket.validation_changed() => {
                return ApiError::conflict(STALE_UPSTREAM_IDENTITY).into_response();
            }
            result = axum::body::to_bytes(body, MAX_UPSTREAM_BODY_BYTES) => result,
        }
    } else {
        axum::body::to_bytes(body, MAX_UPSTREAM_BODY_BYTES).await
    };
    let body_bytes = match body_result {
        Ok(b) => b,
        Err(err) => {
            return ApiError::payload_too_large(format!("failed to read request body: {err}"))
                .into_response()
        }
    };
    if identity_ticket
        .as_mut()
        .is_some_and(|ticket| ticket.validate().is_err())
    {
        return ApiError::conflict(STALE_UPSTREAM_IDENTITY).into_response();
    }

    // The interception table (`routes/intercept/`) is checked FIRST, before
    // either proxy-auth branch below. Interceptors apply their own local
    // account/thread authority and may make an explicit upstream data lookup;
    // they never fall through into the generic cookie-relay or bearer-forward
    // machinery after claiming a route. See that module's doc comment for the
    // full route table and the map citations behind each entry.
    if let Some(ticket) = identity_ticket.as_ref() {
        let expected = ticket.expected_identity();
        let intercepted = super::sandbox_account::with_expected_identity(
            expected,
            intercept::try_intercept(&state, &parts.method, &path, parts.uri.query(), &body_bytes),
        )
        .await;
        if let Some(response) = intercepted {
            let ticket = identity_ticket
                .take()
                .expect("intercepted identity-bound request has an ingress ticket");
            return fence_response_for_identity(response, ticket);
        }
    }

    if is_auth_path {
        if is_sign_out {
            let mut ticket = identity_ticket
                .take()
                .expect("sign-out is admitted with an identity ticket");
            if ticket.validate().is_err() {
                return ApiError::conflict(STALE_UPSTREAM_IDENTITY).into_response();
            }
            let transition = session.begin_transition().await;
            if transition.generation() != ticket.identity_generation
                || ticket
                    .sandbox_manager
                    .validate_account_epoch(ticket.account_epoch)
                    .is_err()
            {
                return ApiError::conflict(STALE_UPSTREAM_IDENTITY).into_response();
            }
            let response = proxy_auth_path(
                &session,
                &parts.method,
                &path_and_query,
                &parts.headers,
                &body_bytes,
            )
            .await;
            if response.status().is_success() {
                transition.logout().await;
                if let Err(error) = crate::auth_fence::reap_all(&state).await {
                    tracing::error!(%error, "proxied logout did not reap every coding agent");
                }
                return response;
            }
            drop(transition);
            return fence_response_for_identity(response, ticket);
        }

        let response = proxy_auth_path(
            &session,
            &parts.method,
            &path_and_query,
            &parts.headers,
            &body_bytes,
        )
        .await;
        return response;
    }

    if path == PUBLIC_NO_AUTH_PATH {
        // Staged self-update version, if the Tauri shell has installed one on
        // disk (see `UpdateHooks`). The borrow is dropped within the
        // statement — never held across an await.
        let staged = state
            .update
            .as_ref()
            .and_then(|hooks| hooks.staged_version.borrow().clone());
        return proxy_public_config(
            &session,
            staged,
            &parts.method,
            &path_and_query,
            &parts.headers,
            &body_bytes,
        )
        .await;
    }

    let mut identity_ticket = identity_ticket
        .take()
        .expect("generic upstream request has an ingress identity ticket");

    let access_token_result = session.access_token().await;
    if identity_ticket.validate().is_err() {
        return ApiError::conflict(STALE_UPSTREAM_IDENTITY).into_response();
    }
    let access_token = match access_token_result {
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
            if err.kind == upstream::refresh::RefreshErrorKind::InvalidGrant
                && !hard_sign_out_if_ticket_current(
                    &state,
                    &session,
                    &mut identity_ticket,
                    "refresh token rejected while resolving an app-API request",
                )
                .await
            {
                return ApiError::conflict(STALE_UPSTREAM_IDENTITY).into_response();
            }
            return unauthorized_upstream();
        }
    };

    let mut out_headers = build_forward_headers(&parts.headers);
    let selected_cookie = session.cookie_header().await;
    if identity_ticket.validate().is_err() {
        return ApiError::conflict(STALE_UPSTREAM_IDENTITY).into_response();
    }
    let cookie_attached = attach_cookie_header(&mut out_headers, selected_cookie);
    // A payload we intend to rewrite must arrive uncompressed — reqwest is
    // built without `gzip`, so a compressed body would fail to parse and the
    // rewrite would silently fail open.
    if is_protected_resource_metadata(&path) {
        out_headers.insert(
            header::ACCEPT_ENCODING,
            HeaderValue::from_static("identity"),
        );
    }

    match send_with_retry_for_identity(
        &session,
        RetriableUpstreamRequest {
            method: parts.method.clone(),
            path_and_query: &path_and_query,
            headers: &out_headers,
            body: &body_bytes,
            token: access_token,
            cookie_leads: cookie_attached,
        },
        &mut identity_ticket,
    )
    .await
    {
        Ok(upstream_resp) if is_protected_resource_metadata(&path) => {
            localized_resource_metadata_for_identity(
                upstream_resp,
                session.target(),
                &parts.headers,
                identity_ticket,
            )
            .await
        }
        Ok(upstream_resp) => build_response_for_identity(upstream_resp, identity_ticket).await,
        Err(ProxyError::Network(msg)) => {
            ApiError::bad_gateway(format!("upstream unreachable: {msg}")).into_response()
        }
        Err(ProxyError::HardUnauthorized) => unauthorized_upstream(),
        Err(ProxyError::StaleIdentity) => {
            ApiError::conflict(STALE_UPSTREAM_IDENTITY).into_response()
        }
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
/// Identity-fenced metadata localization for the generic catchall. Metadata
/// has to be buffered for rewriting, so account
/// replacement races both the read itself and the final one-item response
/// body; both phases are fenced.
async fn localized_resource_metadata_for_identity(
    upstream: reqwest::Response,
    target: &str,
    request_headers: &HeaderMap,
    mut ticket: UpstreamRequestTicket,
) -> Response {
    if !upstream.status().is_success() {
        return build_response_for_identity(upstream, ticket).await;
    }
    let Some(local_origin) = caller_origin(request_headers) else {
        return build_response_for_identity(upstream, ticket).await;
    };

    let status = upstream.status();
    let mut headers = upstream.headers().clone();
    strip_hop_by_hop_headers(&mut headers);
    headers.remove(header::CONTENT_ENCODING);

    let bytes_result = tokio::select! {
        biased;
        _ = ticket.validation_changed() => {
            return ApiError::conflict(STALE_UPSTREAM_IDENTITY).into_response();
        }
        result = upstream.bytes() => result,
    };
    if ticket.validate().is_err() {
        return ApiError::conflict(STALE_UPSTREAM_IDENTITY).into_response();
    }
    let Ok(bytes) = bytes_result else {
        return ApiError::bad_gateway("upstream metadata body was unreadable").into_response();
    };

    let body = rewrite_resource_field(&bytes, target.trim_end_matches('/'), &local_origin)
        .map(axum::body::Bytes::from)
        .unwrap_or(bytes);
    headers.remove(header::CONTENT_LENGTH);
    let mut response = Response::new(Body::from(body));
    *response.status_mut() = status;
    *response.headers_mut() = headers;
    fence_response_for_identity(response, ticket)
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
        Err(ProxyError::StaleIdentity) => {
            unreachable!("send_once_no_bearer is not identity-fenced")
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
        return build_response(upstream_resp).await;
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
    build_response(upstream_resp).await
}

/// Auth endpoints whose payloads can carry an organization `logo`.
fn carries_org_assets(path_and_query: &str) -> bool {
    let path = path_and_query
        .split(['?', '#'])
        .next()
        .unwrap_or(path_and_query);
    path.starts_with("/api/auth/organization") || path == "/api/auth/get-session"
}

/// [`build_response`], but buffering the body so protected-asset URLs can
/// be localized. Only used for the small JSON payloads above — everything else
/// keeps streaming.
async fn localized_auth_response(upstream: reqwest::Response, target: &str) -> Response {
    if !upstream.status().is_success() {
        return build_response(upstream).await;
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
/// `upstream::UpstreamSession::cookie_header`'s doc comment) to an org-data
/// request — a no-op when this session has no persisted cookie (the
/// system-browser login path, or before any embedded sign-in has ever
/// completed). This is what makes the real production web shell's own
/// sign-in gate and org switcher (both native Better Auth `/api/auth/*`
/// endpoints, reached via [`proxy_auth_path`] above) AND every ordinary
/// org-scoped data call (reached via the bearer branch) agree on the same
/// signed-in identity, for every request this proxy forwards.
///
/// When the cookie IS attached, [`send_with_retry`] leads with it and holds
/// the bearer back. Sending both broke upstream tools that make NESTED
/// Better Auth calls with the forwarded headers (`boundAuth.organization.*`):
/// Better Auth's api-key plugin probes any `Authorization: Bearer` as an API
/// key and throws `Invalid API key.` before the valid cookie beside it is
/// ever consulted. A browser sends only the cookie and works; so must we.
/// Returns whether a cookie was actually attached, so the caller can decide
/// which credential leads the request (see [`send_with_retry`]).
async fn attach_persisted_cookie(
    headers: &mut HeaderMap,
    session: &upstream::UpstreamSession,
) -> bool {
    attach_cookie_header(headers, session.cookie_header().await)
}

/// Synchronous half of [`attach_persisted_cookie`], used by the generic
/// proxy after it has selected a cookie and revalidated its account ticket.
/// Keeping selection separate from attachment makes it impossible to send a
/// cookie loaded from account B on a request admitted for account A.
fn attach_cookie_header(headers: &mut HeaderMap, cookie: Option<String>) -> bool {
    let Some(cookie) = cookie else {
        return false;
    };
    match HeaderValue::from_str(&cookie) {
        Ok(value) => {
            headers.insert(header::COOKIE, value);
            true
        }
        Err(err) => {
            tracing::warn!(error = %err, "persisted cookie was not a valid header value; forwarding without it");
            false
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
    staged_version: Option<String>,
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
        Ok(resp) => rewrite_config_version(resp, staged_version.as_deref()).await,
        Err(ProxyError::Network(msg)) => {
            ApiError::bad_gateway(format!("upstream unreachable: {msg}")).into_response()
        }
        Err(ProxyError::HardUnauthorized) => {
            unreachable!("send_once_no_bearer never returns ProxyError::HardUnauthorized")
        }
        Err(ProxyError::StaleIdentity) => {
            unreachable!("send_once_no_bearer is not identity-fenced")
        }
    }
}

/// The web bundle this app ships, baked in by `build.rs` from the same
/// `apps/api/package.json` Vite reads for `__STUDIO_VERSION__`. Empty when
/// that file could not be read at build time (see `build.rs`).
const STUDIO_WEB_VERSION: &str = env!("STUDIO_WEB_VERSION");

/// Answers `GET /api/config` with the version of the bundle actually running
/// inside this app — or, when a self-update has been INSTALLED on disk, the
/// staged version — never the upstream deployment's.
///
/// `version-check-dialog.tsx` polls this route every 5 minutes and nags "A new
/// version is ready" once the reported version differs from the bundle's own
/// build-time `__STUDIO_VERSION__` on two consecutive polls. Upstream redeploys
/// many times a day, so proxied unchanged that banner is guaranteed to fire in
/// the desktop app — and its "Refresh" action cannot possibly help, because the
/// webview loads a bundle packaged into the app, not whatever upstream now
/// serves. Rewriting the field keeps the two in agreement, so the banner
/// appears only in the browser, where reloading genuinely fetches new assets —
/// or in the shell when, and only when, a staged update makes its action real
/// (there the desktop-gated button restarts into the new bundle via
/// `/_local/update/restart` instead of reloading).
///
/// Every other field is passed through untouched: this rewrites one string, it
/// does not reimplement the payload. Non-2xx, non-JSON, unparseable, or
/// unexpectedly-shaped bodies stream through unchanged, as does an empty
/// `STUDIO_WEB_VERSION` with nothing staged.
async fn rewrite_config_version(
    upstream: reqwest::Response,
    staged_version: Option<&str>,
) -> Response {
    let Some(report) = reported_config_version(staged_version, STUDIO_WEB_VERSION) else {
        return build_response(upstream).await;
    };
    if !upstream.status().is_success() {
        return build_response(upstream).await;
    }

    let status = upstream.status();
    let mut headers = upstream.headers().clone();
    strip_hop_by_hop_headers(&mut headers);
    headers.remove(header::SET_COOKIE);

    let Ok(bytes) = upstream.bytes().await else {
        return ApiError::bad_gateway("upstream config body was unreadable").into_response();
    };

    let patched = patch_config_version(&bytes, &report);

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

/// Which version `/api/config` should report to the webview: a staged
/// self-update wins (its restart action is real); otherwise pin to the
/// embedded bundle's version; `None` (pass upstream through untouched) only
/// when there is nothing meaningful to report at all. A staged version must
/// win even when the baked constant is empty (unreadable manifest at build
/// time) — the old `STUDIO_WEB_VERSION.is_empty()` early-return would have
/// silently suppressed a ready update.
///
/// Pure (no I/O) so the contract is unit-testable without standing up a
/// proxy, per TESTING.md.
fn reported_config_version(staged: Option<&str>, baked: &str) -> Option<String> {
    match staged {
        Some(version) => Some(version.to_string()),
        None if baked.is_empty() => None,
        None => Some(baked.to_string()),
    }
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

#[derive(Debug)]
enum ProxyError {
    Network(String),
    /// The independent OAuth probe rejected the credential even after its
    /// normal refresh path. A resource-specific `401` never produces this.
    HardUnauthorized,
    /// The request was admitted for an account that was replaced before its
    /// credentials, retry, or response body could be safely consumed.
    StaleIdentity,
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
#[derive(Debug, thiserror::Error)]
pub(crate) enum OrgToolCallError {
    #[error("{STALE_UPSTREAM_IDENTITY}")]
    StaleIdentity,
    #[error("{0}")]
    Failed(String),
}

pub(crate) async fn call_org_tool_for_identity(
    state: &AppState,
    account_epoch: crate::sandbox::manager::AccountEpoch,
    identity_generation: u64,
    org: &str,
    tool_name: &str,
    input: &serde_json::Value,
) -> Result<serde_json::Value, OrgToolCallError> {
    let session = upstream::global();
    let mut ticket = UpstreamRequestTicket::capture_expected(
        state,
        &session,
        account_epoch,
        identity_generation,
    )
    .await
    .map_err(|_| OrgToolCallError::StaleIdentity)?;

    let token_result = session.access_token().await;
    ticket
        .validate()
        .map_err(|_| OrgToolCallError::StaleIdentity)?;
    let token = token_result.map_err(|_| {
        OrgToolCallError::Failed("not signed in to the upstream deployment".to_string())
    })?;

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

    let body = axum::body::Bytes::from(
        serde_json::to_vec(input).map_err(|error| OrgToolCallError::Failed(error.to_string()))?,
    );
    // Same browser-shaped credential rule as the proxy branch: cookie leads,
    // bearer in reserve — tool handlers upstream can make nested Better Auth
    // calls with these headers, and a bearer poisons those (api-key probe).
    let selected_cookie = session.cookie_header().await;
    ticket
        .validate()
        .map_err(|_| OrgToolCallError::StaleIdentity)?;
    let cookie_attached = attach_cookie_header(&mut headers, selected_cookie);
    let response = send_with_retry_for_identity(
        &session,
        RetriableUpstreamRequest {
            method: Method::POST,
            path_and_query: &path,
            headers: &headers,
            body: &body,
            token,
            cookie_leads: cookie_attached,
        },
        &mut ticket,
    )
    .await
    .map_err(|error| match error {
        ProxyError::Network(msg) => {
            OrgToolCallError::Failed(format!("upstream unreachable: {msg}"))
        }
        ProxyError::HardUnauthorized => {
            OrgToolCallError::Failed("not signed in to the upstream deployment".to_string())
        }
        ProxyError::StaleIdentity => OrgToolCallError::StaleIdentity,
    })?;

    let status = response.status();
    let bytes_result = tokio::select! {
        biased;
        _ = ticket.validation_changed() => {
            return Err(OrgToolCallError::StaleIdentity);
        }
        result = response.bytes() => result,
    };
    ticket
        .validate()
        .map_err(|_| OrgToolCallError::StaleIdentity)?;
    let bytes = bytes_result.map_err(|error| {
        OrgToolCallError::Failed(format!("could not read {tool_name} response: {error}"))
    })?;
    if !status.is_success() {
        return Err(OrgToolCallError::Failed(format!(
            "{tool_name} failed upstream ({status}): {}",
            String::from_utf8_lossy(&bytes)
                .chars()
                .take(300)
                .collect::<String>()
        )));
    }
    serde_json::from_slice(&bytes).map_err(|error| {
        OrgToolCallError::Failed(format!("{tool_name} returned invalid JSON: {error}"))
    })
}

/// Identity-pinned admission for one WebDAV request.
///
/// The request captures this once, before its body is read, and carries it
/// through every upstream operation and the eventual response stream. The
/// inner ticket is the same generation/epoch fence used by the generic app
/// proxy; the retained [`crate::sandbox::manager::SandboxAccount`]
/// additionally binds local junk and mount state to the verified account
/// storage root.
pub(crate) struct OrgRequestTicket {
    inner: UpstreamRequestTicket,
    account: crate::sandbox::manager::SandboxAccount,
}

impl OrgRequestTicket {
    pub(crate) async fn capture(state: &AppState) -> Result<Self, ApiError> {
        let inner = UpstreamRequestTicket::capture(state, &upstream::global()).await?;
        let account = inner
            .sandbox_account
            .as_ref()
            .expect("ordinary ingress tickets always carry a sandbox account")
            .clone();
        Ok(Self { inner, account })
    }

    pub(crate) fn account_id(&self) -> &str {
        self.account.storage().id()
    }

    pub(crate) fn validate(&mut self) -> Result<(), UpstreamCallError> {
        self.account
            .validate()
            .map_err(|_| UpstreamCallError::StaleIdentity)?;
        self.validate_identity()
    }

    pub(crate) fn validate_identity(&mut self) -> Result<(), UpstreamCallError> {
        self.inner
            .validate()
            .map_err(|_| UpstreamCallError::StaleIdentity)
    }

    pub(crate) async fn validation_changed(&mut self) {
        self.inner.validation_changed().await;
    }

    /// Linearize one device-local commit with account replacement. The
    /// closure must remain synchronous and small; network and filesystem I/O
    /// use validate-before/after instead.
    pub(crate) fn with_account_commit<T>(
        &mut self,
        commit: impl FnOnce() -> T,
    ) -> Result<T, UpstreamCallError> {
        self.validate_identity()?;
        self.inner
            .sandbox_manager
            .with_sandbox_account(&self.account, commit)
            .map_err(|_| UpstreamCallError::StaleIdentity)
    }

    /// Fence even locally-produced WebDAV bodies. This is what terminates a
    /// presigned object stream when the signed-in account changes after its
    /// headers have already been returned.
    pub(crate) fn fence_response(self, response: Response) -> Response {
        let Self { mut inner, account } = self;
        if account.validate().is_err() || inner.validate().is_err() {
            return ApiError::conflict(STALE_UPSTREAM_IDENTITY).into_response();
        }
        let (parts, body) = response.into_parts();
        let body = Body::from_stream(body.into_data_stream().take_until(inner.changed()));
        // Preserve Content-Length for WebDAV HEAD and fixed-size reads. If a
        // transition truncates a streaming GET, the resulting short body is
        // deliberately observable to rclone as an incomplete transfer.
        Response::from_parts(parts, body)
    }
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
    /// The authenticated subject or its sandbox account epoch changed after
    /// admission. WebDAV maps this to 409 and never retries with replacement
    /// credentials.
    StaleIdentity,
}

/// Send one authenticated request to an arbitrary upstream path and hand the
/// raw response back — status, headers and an unconsumed body, so a caller
/// serving a large object can stream it rather than buffering.
///
/// [`call_org_tool_for_identity`] above is the JSON-tool-shaped convenience over the same
/// machinery; this is the general form, used by `routes/webdav.rs` for the
/// org filesystem's REST contract (`/api/:org/fs/:volume/*`), which is not a
/// tool call. Both share [`send_with_retry`], so both get the same
/// "resource 401 is not a session 401" revalidate-and-retry semantics and the
/// same server-side token attachment — a caller never sees or supplies the
/// upstream bearer.
pub(crate) async fn send_org_request(
    ticket: &mut OrgRequestTicket,
    method: Method,
    path_and_query: &str,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Result<reqwest::Response, UpstreamCallError> {
    let session = upstream::global();
    ticket.validate()?;
    let token_result = session.access_token().await;
    ticket.validate_identity()?;
    let token = token_result.map_err(|_| UpstreamCallError::NotSignedIn)?;
    let mut headers = headers;
    // Cookie leads for the same reason as the proxy branch — see
    // [`attach_persisted_cookie`].
    let cookie_attached = attach_persisted_cookie(&mut headers, &session).await;
    ticket.validate_identity()?;
    let result = send_with_retry_for_identity(
        &session,
        RetriableUpstreamRequest {
            method,
            path_and_query,
            headers: &headers,
            body: &body,
            token,
            cookie_leads: cookie_attached,
        },
        &mut ticket.inner,
    )
    .await;
    ticket.validate_identity()?;
    result.map_err(|error| match error {
        ProxyError::Network(msg) => UpstreamCallError::Unreachable(msg),
        ProxyError::HardUnauthorized => UpstreamCallError::NotSignedIn,
        ProxyError::StaleIdentity => UpstreamCallError::StaleIdentity,
    })
}

/// `cookie_leads`: the headers carry the persisted Better Auth session
/// cookie, so the request goes out BROWSER-SHAPED — cookie only, no bearer.
/// The bearer stays in reserve for the 401 path (an expired or revoked
/// cookie session), where the existing revalidate-and-retry flow takes over
/// unchanged. Sending both at once is not an option: upstream tools that
/// re-authenticate from the forwarded headers (`boundAuth.organization.*`)
/// die on Better Auth's api-key plugin probing the bearer — the exact
/// failure the browser never sees because it only ever sends the cookie.
#[cfg(test)]
async fn send_with_retry(
    session: &upstream::UpstreamSession,
    method: &Method,
    path_and_query: &str,
    headers: &HeaderMap,
    body: &axum::body::Bytes,
    token: String,
    cookie_leads: bool,
) -> Result<reqwest::Response, ProxyError> {
    let url = format!("{}{path_and_query}", session.target());

    let mut headers = headers.clone();
    if cookie_leads {
        let first = send_once_no_bearer(method, &url, &headers, body.clone()).await?;
        if first.status() != StatusCode::UNAUTHORIZED {
            return Ok(first);
        }
        // Cookie session rejected — fall through to the bearer flow below,
        // which also revalidates the whole session state. DROP the cookie
        // first: sending both is the exact combination the cookie-lead rule
        // exists to avoid (Better Auth's api-key plugin probes the bearer and
        // throws before the cookie beside it is read), so keeping a dead
        // cookie here would make the recovery fail on precisely the nested
        // `boundAuth` handlers it is meant to rescue.
        headers.remove(header::COOKIE);
    }

    let headers = &headers;
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

/// Identity-pinned form of [`send_with_retry`] for the generic app-API
/// catchall. The ordinary helper remains for narrowly-scoped internal reads;
/// this variant validates after every async credential operation and network
/// attempt, so a response obtained while account replacement was in flight is
/// discarded before its headers or body reach the webview.
struct RetriableUpstreamRequest<'a> {
    method: Method,
    path_and_query: &'a str,
    headers: &'a HeaderMap,
    body: &'a axum::body::Bytes,
    token: String,
    cookie_leads: bool,
}

async fn send_with_retry_for_identity(
    session: &upstream::UpstreamSession,
    request: RetriableUpstreamRequest<'_>,
    ticket: &mut UpstreamRequestTicket,
) -> Result<reqwest::Response, ProxyError> {
    let RetriableUpstreamRequest {
        method,
        path_and_query,
        headers,
        body,
        token,
        cookie_leads,
    } = request;
    let url = format!("{}{path_and_query}", session.target());
    let mut headers = headers.clone();

    if cookie_leads {
        ticket.validate()?;
        let first_result = send_once_no_bearer(&method, &url, &headers, body.clone()).await;
        ticket.validate()?;
        let first = first_result?;
        if first.status() != StatusCode::UNAUTHORIZED {
            return Ok(first);
        }
        headers.remove(header::COOKIE);
    }

    ticket.validate()?;
    let first_result = send_once(&method, &url, &headers, body.clone(), &token).await;
    ticket.validate()?;
    let first = first_result?;
    if first.status() != StatusCode::UNAUTHORIZED {
        return Ok(first);
    }

    // Revalidation may itself refresh or hard-sign-out. The ticket check
    // immediately afterward prevents a concurrent replacement's status or
    // token from being reused for this request.
    ticket.validate()?;
    let status = session.force_revalidate().await;
    ticket.validate()?;
    if !status.signed_in {
        return Err(ProxyError::HardUnauthorized);
    }

    let current_result = session.access_token().await;
    ticket.validate()?;
    let current = match current_result {
        Ok(current) => current,
        Err(_) => return Err(ProxyError::HardUnauthorized),
    };
    if current == token {
        return Ok(first);
    }

    ticket.validate()?;
    let retry_result = send_once(&method, &url, &headers, body.clone(), &current).await;
    ticket.validate()?;
    let retry = retry_result?;
    Ok(retry)
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
/// hop-by-hop and `Set-Cookie` — see below), and body via `bytes_stream()`
/// rather than buffering, so SSE/chunked responses pass through
/// incrementally instead of waiting for the whole thing.
///
/// Used by every branch of this proxy — the bearer branch and
/// [`proxy_auth_path`] alike (they used to have separate copies whose only
/// difference, whether `Set-Cookie` was stripped, disappeared once the
/// bearer branch started attaching the durable session cookie itself).
/// `Set-Cookie` is ALWAYS stripped: on the auth path it has already been
/// captured into the jar by the caller before this runs, and the webview
/// must never see the real upstream session cookie; on the org-data path
/// it is defense-in-depth for a route that unexpectedly echoed one.
/// `HeaderMap::remove` removes every entry for a given name, so a response
/// carrying multiple `Set-Cookie` headers (Better Auth sometimes sets more
/// than one, e.g. a session token plus a companion flag cookie) is fully
/// stripped, not just the first.
async fn build_response(upstream: reqwest::Response) -> Response {
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

/// Generic bearer-branch response builder. In addition to the ordinary
/// header hygiene, the body stops at the first identity/epoch notification.
/// `take_until` fences bytes already queued by reqwest as well as future
/// chunks, which is essential for SSE and other long-lived responses.
async fn build_response_for_identity(
    upstream: reqwest::Response,
    mut ticket: UpstreamRequestTicket,
) -> Response {
    if ticket.validate().is_err() {
        return ApiError::conflict(STALE_UPSTREAM_IDENTITY).into_response();
    }
    let status = upstream.status();
    let mut headers = upstream.headers().clone();
    strip_hop_by_hop_headers(&mut headers);
    headers.remove(header::SET_COOKIE);
    let body = Body::from_stream(upstream.bytes_stream().take_until(ticket.changed()));
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
pub async fn complete_session(State(state): State<AppState>) -> Response {
    let prepared = match upstream::global().prepare_complete_session().await {
        Ok(prepared) => prepared,
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
            return (status, Json(json!({ "error": err.to_string() }))).into_response();
        }
    };
    match crate::install_upstream_session(&state, prepared).await {
        Ok(status) => Json(json!({
            "signedIn": status.signed_in,
            "userLabel": status.user_label,
        }))
        .into_response(),
        Err(err) => {
            let status = match &err {
                crate::AccountInstallError::AgentReap(_) => StatusCode::SERVICE_UNAVAILABLE,
                _ => StatusCode::BAD_GATEWAY,
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
pub async fn logout(State(state): State<AppState>) -> Response {
    let status = crate::logout_upstream_session(&state).await;
    Json(json!({
        "signedIn": status.signed_in,
        "userLabel": status.user_label,
    }))
    .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::{HeaderName, HeaderValue};
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
    fn reported_config_version_prefers_staged_and_survives_empty_baked() {
        // Staged wins over the embedded bundle's version…
        assert_eq!(
            reported_config_version(Some("5.0.0"), "4.150.13").as_deref(),
            Some("5.0.0")
        );
        // …including when the baked constant is empty (unreadable manifest at
        // build time) — the old is_empty() early-return suppressed this.
        assert_eq!(
            reported_config_version(Some("5.0.0"), "").as_deref(),
            Some("5.0.0")
        );
        // No staged update: pin to the embedded version as always.
        assert_eq!(
            reported_config_version(None, "4.150.13").as_deref(),
            Some("4.150.13")
        );
        // Nothing meaningful to report: pass upstream through untouched.
        assert_eq!(reported_config_version(None, ""), None);
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

    fn identity_ticket_for_test(
        manager: Arc<crate::sandbox::SandboxManager>,
        identity_generation: u64,
    ) -> (
        UpstreamRequestTicket,
        tokio::sync::broadcast::Sender<upstream::SessionIdentityEvent>,
    ) {
        let account_epoch = manager.account_epoch();
        let validation_account_rx = manager.watch_account_epoch(account_epoch).unwrap();
        let body_account_rx = validation_account_rx.clone();
        let (identity_tx, _) = tokio::sync::broadcast::channel(8);
        let validation_identity_rx = identity_tx.subscribe();
        let body_identity_rx = identity_tx.subscribe();
        (
            UpstreamRequestTicket {
                identity_generation,
                account_epoch,
                sandbox_account: None,
                sandbox_manager: manager,
                validation_identity_rx,
                body_identity_rx,
                validation_account_rx,
                body_account_rx,
            },
            identity_tx,
        )
    }

    #[tokio::test]
    async fn scoped_terminal_mcp_identity_is_lock_free_but_rejects_stale_boundaries() {
        let dir = tempfile::tempdir().unwrap();
        let state = crate::routes::intercept::test_state(dir.path());
        let session = UpstreamSession::new(
            "https://studio.example".to_string(),
            Arc::new(MemoryTokenStore::new()),
        );
        let identity = crate::terminal::registry::ScopedMcpIdentity {
            account_epoch: state.sandbox_manager.account_epoch(),
            identity_generation: session.identity_generation(),
        };

        let mut admitted = UpstreamRequestTicket::capture_scoped_mcp(&state, &session, identity)
            .await
            .expect("the identity that minted the terminal capability is current");
        admitted.validate().unwrap();

        let wrong_generation = crate::terminal::registry::ScopedMcpIdentity {
            identity_generation: identity.identity_generation + 1,
            ..identity
        };
        assert!(
            UpstreamRequestTicket::capture_scoped_mcp(&state, &session, wrong_generation)
                .await
                .is_err()
        );

        state
            .sandbox_manager
            .begin_account_transition()
            .await
            .unwrap()
            .complete()
            .unwrap();
        assert!(
            UpstreamRequestTicket::capture_scoped_mcp(&state, &session, identity)
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn account_change_while_request_body_is_stalled_never_reaches_interception() {
        let dir = tempfile::tempdir().unwrap();
        let state = crate::routes::intercept::test_state(dir.path());
        let manager = state.sandbox_manager.clone();
        let body_started = Arc::new(tokio::sync::Notify::new());
        let release_body = Arc::new(tokio::sync::Notify::new());
        let started_for_body = body_started.clone();
        let release_for_body = release_body.clone();
        let body = Body::from_stream(futures::stream::once(async move {
            started_for_body.notify_one();
            release_for_body.notified().await;
            Ok::<_, std::convert::Infallible>(axum::body::Bytes::from_static(b"{}"))
        }));
        let request = Request::builder()
            .method(Method::GET)
            .uri("/api/acme/decopilot/retired")
            .body(body)
            .unwrap();

        let request_task = tokio::spawn(proxy(State(state), request));
        tokio::time::timeout(Duration::from_secs(1), body_started.notified())
            .await
            .expect("proxy never began reading the stalled body");
        let transition = manager.begin_account_transition().await.unwrap();
        release_body.notify_waiters();

        let response = tokio::time::timeout(Duration::from_secs(1), request_task)
            .await
            .expect("stale request did not terminate")
            .unwrap();
        assert_eq!(response.status(), StatusCode::CONFLICT);
        assert_ne!(
            response.status(),
            StatusCode::GONE,
            "the retired-route interceptor must never run under the replacement account"
        );
        drop(transition);
    }

    #[tokio::test]
    async fn queued_upstream_body_is_discarded_after_identity_change() {
        let app = Router::new().route("/stream", get(|| async { "account-a-secret" }));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        let upstream = reqwest::Client::new()
            .get(format!("http://{addr}/stream"))
            .send()
            .await
            .unwrap();
        let root = tempfile::tempdir().unwrap();
        let manager = crate::sandbox::SandboxManager::new(root.path().to_path_buf());
        let (ticket, identity_tx) = identity_ticket_for_test(manager, 7);
        let response = build_response_for_identity(upstream, ticket).await;

        identity_tx
            .send(upstream::SessionIdentityEvent {
                generation: 8,
                user_sub: Some("account-b".to_string()),
            })
            .unwrap();
        let mut body = response.into_body().into_data_stream();
        assert!(tokio::time::timeout(Duration::from_secs(1), body.next())
            .await
            .expect("identity-fenced body did not terminate")
            .is_none());
    }

    #[tokio::test]
    async fn webdav_body_fence_preserves_length_and_terminates_on_identity_change() {
        let root = tempfile::tempdir().unwrap();
        let manager = crate::sandbox::SandboxManager::new(root.path().to_path_buf());
        let scope =
            crate::routes::threads::db::RtAccountScope::new("test.invalid", "local-desktop-user")
                .unwrap();
        let epoch = manager.account_epoch();
        let account = manager.sandbox_account(epoch, &scope).unwrap();
        let (mut inner, identity_tx) = identity_ticket_for_test(manager, 11);
        inner.sandbox_account = Some(account.clone());
        let ticket = OrgRequestTicket { inner, account };
        let response = Response::builder()
            .header(header::CONTENT_LENGTH, "16")
            .body(Body::from("account-a-secret"))
            .unwrap();
        let response = ticket.fence_response(response);
        assert_eq!(
            response.headers().get(header::CONTENT_LENGTH).unwrap(),
            "16"
        );

        identity_tx
            .send(upstream::SessionIdentityEvent {
                generation: 12,
                user_sub: Some("account-b".to_string()),
            })
            .unwrap();
        let mut body = response.into_body().into_data_stream();
        assert!(tokio::time::timeout(Duration::from_secs(1), body.next())
            .await
            .expect("WebDAV identity-fenced body did not terminate")
            .is_none());
    }

    #[tokio::test]
    async fn identity_change_during_first_401_prevents_retry_with_replacement_token() {
        let calls = Arc::new(AtomicUsize::new(0));
        let seen_auth = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let first_arrived = Arc::new(tokio::sync::Notify::new());
        let release_first = Arc::new(tokio::sync::Notify::new());
        let app = Router::new()
            .route(
                "/resource",
                get({
                    let calls = calls.clone();
                    let seen_auth = seen_auth.clone();
                    let first_arrived = first_arrived.clone();
                    let release_first = release_first.clone();
                    move |headers: HeaderMap| {
                        let calls = calls.clone();
                        let seen_auth = seen_auth.clone();
                        let first_arrived = first_arrived.clone();
                        let release_first = release_first.clone();
                        async move {
                            seen_auth.lock().unwrap().push(
                                headers
                                    .get(header::AUTHORIZATION)
                                    .and_then(|value| value.to_str().ok())
                                    .unwrap_or_default()
                                    .to_string(),
                            );
                            let attempt = calls.fetch_add(1, Ordering::SeqCst);
                            if attempt == 0 {
                                first_arrived.notify_one();
                                release_first.notified().await;
                                StatusCode::UNAUTHORIZED
                            } else {
                                StatusCode::OK
                            }
                        }
                    }
                }),
            )
            .route("/api/auth/desktop/me", get(|| async { StatusCode::OK }))
            .route(
                "/api/auth/get-session",
                get(|| async { Json(json!({ "user": { "id": "account-b" } })) }),
            );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        let target = format!("http://{addr}");
        let (session, store) = signed_in_session_with_store(&target, "token-a").await;
        let root = tempfile::tempdir().unwrap();
        let manager = crate::sandbox::SandboxManager::new(root.path().to_path_buf());
        let (mut ticket, identity_tx) = identity_ticket_for_test(manager, 11);

        let send_task = tokio::spawn(async move {
            send_with_retry_for_identity(
                &session,
                RetriableUpstreamRequest {
                    method: Method::GET,
                    path_and_query: "/resource",
                    headers: &HeaderMap::new(),
                    body: &axum::body::Bytes::new(),
                    token: "token-a".to_string(),
                    cookie_leads: false,
                },
                &mut ticket,
            )
            .await
        });

        tokio::time::timeout(Duration::from_secs(1), first_arrived.notified())
            .await
            .expect("first request never reached upstream");
        store
            .save(
                &host_key(&target),
                StoredSession {
                    target: target.clone(),
                    client_id: "client-b".to_string(),
                    user: UserInfo {
                        sub: "account-b".to_string(),
                        email: None,
                        name: None,
                    },
                    access_token: "token-b".to_string(),
                    refresh_token: Some("refresh-b".to_string()),
                    expires_at: Some(now_unix() + 3600),
                    created_at: "2026-01-01T00:00:00Z".to_string(),
                    cookie: Some("better-auth.session_token=b".to_string()),
                },
            )
            .await
            .unwrap();
        identity_tx
            .send(upstream::SessionIdentityEvent {
                generation: 12,
                user_sub: Some("account-b".to_string()),
            })
            .unwrap();
        release_first.notify_waiters();

        let result = tokio::time::timeout(Duration::from_secs(1), send_task)
            .await
            .expect("identity-fenced retry did not terminate")
            .unwrap();
        assert!(matches!(result, Err(ProxyError::StaleIdentity)));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(seen_auth.lock().unwrap().as_slice(), ["Bearer token-a"]);
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
        // Keep the router state alive while polling the returned streaming
        // body, just as the real Axum router does. Dropping the last manager
        // here must close the epoch channel and terminate the watch; retaining
        // a clone in the response would weaken that production fail-closed
        // behavior.
        let response =
            tokio::time::timeout(Duration::from_secs(1), proxy(State(state.clone()), request))
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

        let res =
            proxy_public_config(&session, None, &Method::GET, "/api/config", &headers, &body).await;
        assert_eq!(res.status(), StatusCode::OK);
    }

    /// The staged-self-update branch of the version rewrite, end to end
    /// through the proxy against a real in-process upstream: with nothing
    /// staged the upstream's version (a sentinel here — in production the
    /// cloud deployment's, ~12x/day ahead) must be replaced by the embedded
    /// bundle's; with a staged version, the staged one wins. This is what
    /// makes the webview's drift card fire iff a restart can actually help.
    #[tokio::test]
    async fn proxy_public_config_reports_staged_version_over_upstream_sentinel() {
        let app = Router::new().route(
            "/api/config",
            get(|| async { Json(json!({"config": {"version": "9.9.9", "other": true}})) }),
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

        let reported_version = |res: Response| async move {
            let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
                .await
                .unwrap();
            let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            value["config"]["version"].as_str().unwrap().to_string()
        };

        // Nothing staged: never the upstream sentinel — the embedded
        // version (or passthrough only if STUDIO_WEB_VERSION were empty,
        // which the build asserts against elsewhere).
        let res =
            proxy_public_config(&session, None, &Method::GET, "/api/config", &headers, &body).await;
        assert_eq!(res.status(), StatusCode::OK);
        let version = reported_version(res).await;
        assert_ne!(version, "9.9.9");
        assert_eq!(version, STUDIO_WEB_VERSION);

        // Staged: the staged version wins over both.
        let res = proxy_public_config(
            &session,
            Some("5.0.0-staged".to_string()),
            &Method::GET,
            "/api/config",
            &headers,
            &body,
        )
        .await;
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(reported_version(res).await, "5.0.0-staged");
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

        let res =
            proxy_public_config(&session, None, &Method::GET, "/api/config", &headers, &body).await;
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
            false,
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
            false,
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
            .route("/api/auth/desktop/me", get(|| async { StatusCode::OK }));
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
            false,
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
                "/api/auth/desktop/me",
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
            false,
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
            .route(
                "/api/auth/desktop/me",
                get(|| async { StatusCode::UNAUTHORIZED }),
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
            false,
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
            .route(
                "/api/auth/desktop/me",
                get(|| async { StatusCode::UNAUTHORIZED }),
            );
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
            false,
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
            false,
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

    /// The auth branch's response contract, now served by the SAME
    /// `build_response` as the bearer branch: dynamic Connection-nominated
    /// tokens and every `Set-Cookie` are stripped together — a session
    /// cookie leaking to the webview through the merged builder would be a
    /// real regression, so this stays pinned as one combined response.
    #[tokio::test]
    async fn auth_branch_response_strips_dynamic_hop_by_hop_headers_and_set_cookie() {
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
        let res = build_response(upstream).await;

        assert!(res.headers().get(header::CONNECTION).is_none());
        assert!(res.headers().get("x-private").is_none());
        assert!(res.headers().get("keep-alive").is_none());
        assert!(res.headers().get("proxy-connection").is_none());
        assert!(res.headers().get(header::SET_COOKIE).is_none());
    }

    // --- The real-UI course-correction: durable cookie on every proxied call ---

    /// The regression that broke `TASK_BOARD_ITEM_UPDATE` with an assignee on
    /// desktop: sending `Authorization: Bearer` ALONGSIDE the session cookie
    /// makes upstream tools that re-authenticate from the forwarded headers
    /// (`boundAuth.organization.listMembers`) die on Better Auth's api-key
    /// plugin probing the bearer — `Invalid API key.` — while the browser,
    /// which sends only the cookie, works. When the cookie leads, the bearer
    /// must be ABSENT from the wire.
    #[tokio::test]
    async fn a_cookie_led_request_carries_no_bearer_on_the_wire() {
        let seen = Arc::new(std::sync::Mutex::new(
            None::<(Option<String>, Option<String>)>,
        ));
        let seen_for_route = seen.clone();
        let app = Router::new().route(
            "/api/org/tools/X",
            axum::routing::post(move |headers: HeaderMap| {
                let seen = seen_for_route.clone();
                async move {
                    *seen.lock().unwrap() = Some((
                        headers
                            .get(header::AUTHORIZATION)
                            .and_then(|v| v.to_str().ok())
                            .map(str::to_string),
                        headers
                            .get(header::COOKIE)
                            .and_then(|v| v.to_str().ok())
                            .map(str::to_string),
                    ));
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

        let session = signed_in_session(&target, "tok").await;
        let mut headers = HeaderMap::new();
        headers.insert(
            header::COOKIE,
            HeaderValue::from_static("better-auth.session_token=abc"),
        );
        let response = send_with_retry(
            &session,
            &Method::POST,
            "/api/org/tools/X",
            &headers,
            &axum::body::Bytes::new(),
            "tok".to_string(),
            true, // cookie leads
        )
        .await
        .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let (auth, cookie) = seen.lock().unwrap().clone().expect("request must arrive");
        assert_eq!(auth, None, "cookie-led request must not carry a bearer");
        assert_eq!(cookie.as_deref(), Some("better-auth.session_token=abc"));
    }

    /// A dead cookie session must not strand the request: the bearer flow is
    /// the 401 fallback, exactly as it was before the cookie led.
    #[tokio::test]
    async fn a_rejected_cookie_falls_back_to_the_bearer() {
        let attempts = Arc::new(std::sync::Mutex::new(Vec::<Option<String>>::new()));
        let attempts_for_route = attempts.clone();
        let app = Router::new().route(
            "/api/org/tools/X",
            axum::routing::post(move |headers: HeaderMap| {
                let attempts = attempts_for_route.clone();
                async move {
                    let auth = headers
                        .get(header::AUTHORIZATION)
                        .and_then(|v| v.to_str().ok())
                        .map(str::to_string);
                    let had_bearer = auth.is_some();
                    attempts.lock().unwrap().push(auth);
                    if had_bearer {
                        StatusCode::OK
                    } else {
                        // The cookie session is dead upstream.
                        StatusCode::UNAUTHORIZED
                    }
                }
            }),
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        let target = format!("http://{addr}");

        let session = signed_in_session(&target, "tok").await;
        let response = send_with_retry(
            &session,
            &Method::POST,
            "/api/org/tools/X",
            &HeaderMap::new(),
            &axum::body::Bytes::new(),
            "tok".to_string(),
            true,
        )
        .await
        .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let attempts = attempts.lock().unwrap().clone();
        assert_eq!(attempts.len(), 2, "cookie attempt, then bearer attempt");
        assert_eq!(attempts[0], None);
        assert_eq!(attempts[1].as_deref(), Some("Bearer tok"));
    }

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
            false,
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
