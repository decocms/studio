//! Interactive OAuth 2.1 + PKCE login: loopback callback listener, system
//! browser launch, authorization-code exchange, id_token decode.
//!
//! Port of `apps/api/src/cli/commands/auth/login.ts::performInteractiveLogin`
//! and `apps/api/src/cli/lib/oauth-callback.ts::startOAuthCallbackServer` —
//! same PKCE S256 + `state` flow, same dynamic client registration, same
//! `/api/auth/mcp/token` exchange. Two deliberate differences from the TS
//! reference: on a valid `?code` the callback 302-redirects the browser to
//! the hosted `/cli/auth-success` page (same as the CLI), and on failure
//! renders a self-contained local HTML page (this crate has no dependency on
//! a specific mesh-hosted failure page existing). Like the CLI, a fresh
//! client is registered per login — see [`crate::register`]'s module doc.

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::Query;
use axum::http::StatusCode;
use axum::response::{Html, IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::Deserialize;
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use uuid::Uuid;

use crate::browser_page;
use crate::clock::{now_rfc3339, now_unix};
use crate::pkce;
use crate::register::{self, RegisterError};
use crate::tokens::{StoredSession, UserInfo};

/// Overall wall-clock budget for a login attempt — from opening the
/// browser to receiving the callback. Generous (a human has to actually
/// authenticate), but bounded so a login the user walked away from doesn't
/// leak a listening loopback socket forever.
const LOGIN_TIMEOUT: Duration = Duration::from_secs(5 * 60);

/// `pub(crate)` — [`crate::bridge`] requests the exact same scope set for
/// its non-interactive authorize call.
pub(crate) const SCOPES: &str = "openid profile email offline_access";

#[derive(Debug, thiserror::Error)]
pub enum LoginError {
    #[error("{0}")]
    Register(#[from] RegisterError),
    #[error("failed to bind the local OAuth callback listener: {0}")]
    Listener(String),
    #[error("timed out waiting for the browser to complete sign-in")]
    Timeout,
    #[error("sign-in was cancelled: {0}")]
    Denied(String),
    #[error("OAuth callback state mismatch")]
    StateMismatch,
    #[error("OAuth callback was missing an authorization code")]
    MissingCode,
    #[error("token exchange failed: HTTP {0} {1}")]
    TokenExchangeRejected(u16, String),
    #[error("token endpoint returned no access_token")]
    NoAccessToken,
    #[error("token endpoint returned no id_token")]
    NoIdToken,
    #[error("id_token is not a valid JWT: {0}")]
    MalformedIdToken(String),
    #[error("network error during login: {0}")]
    Network(String),
    #[error("the loopback callback server ended unexpectedly")]
    CallbackServerGone,
    /// The mesh-side session bridge (`POST /api/auth/desktop/session-from-oauth`,
    /// see [`mint_session_from_access_token`]'s doc comment) rejected the
    /// freshly-minted OAuth access token or otherwise failed. Deliberately
    /// fatal to the whole login attempt — see that function's doc comment
    /// for why a bearer-only fallback is never an acceptable outcome here.
    #[error("mesh session bridge rejected the request: HTTP {0} {1}")]
    SessionBridgeRejected(u16, String),
}

/// `pub(crate)`, not module-private: [`crate::bridge`]'s non-interactive
/// bridge flow shares this exact shape (it calls [`exchange_code`]
/// directly — see that function's doc comment).
#[derive(Debug, Deserialize)]
pub(crate) struct TokenResponse {
    pub(crate) access_token: String,
    pub(crate) refresh_token: Option<String>,
    pub(crate) id_token: Option<String>,
    pub(crate) expires_in: Option<i64>,
}

/// `pub(crate)` for the same reason as [`TokenResponse`] — shared with
/// [`crate::bridge`] via [`decode_id_token`].
#[derive(Debug, Deserialize)]
pub(crate) struct IdTokenClaims {
    pub(crate) sub: String,
    pub(crate) email: Option<String>,
    pub(crate) name: Option<String>,
}

/// Runs the full interactive flow and returns a [`StoredSession`] ready to
/// hand to [`crate::tokens::TokenStore::save`]. Does NOT persist it —
/// mirrors `login.ts`'s `performInteractiveLogin`, which leaves persistence
/// to its caller (`session.rs::login`, here).
pub async fn perform_interactive_login(
    http: &reqwest::Client,
    target: &str,
    open_browser: impl Fn(&str) -> std::io::Result<()>,
) -> Result<StoredSession, LoginError> {
    let target = target.trim_end_matches('/').to_string();
    let state = Uuid::new_v4().to_string();
    let pkce_pair = pkce::generate();

    let server = LoopbackServer::start(state.clone(), format!("{target}/cli/auth-success"))
        .await
        .map_err(LoginError::Listener)?;
    let redirect_uri = format!("http://{}/", server.local_addr);

    // Register a FRESH client bound to THIS login's loopback redirect_uri
    // (ephemeral port). The upstream does exact redirect_uri matching, so a
    // client_id must never be reused across logins with a different port —
    // see `register.rs`'s module doc (this is why there is no cache).
    let client_id = register::register_client(http, &target, &redirect_uri)
        .await
        .map_err(LoginError::Register)?;

    let authorize_url = build_authorize_url(
        &target,
        &client_id,
        &redirect_uri,
        &state,
        &pkce_pair.challenge,
    );
    tracing::info!(%target, %redirect_uri, %client_id, "auth_login: registered fresh client; opening system browser to authorize");
    tracing::debug!(%authorize_url, "auth_login: authorize URL");
    match open_browser(&authorize_url) {
        Ok(()) => tracing::info!("auth_login: system browser launched"),
        Err(err) => tracing::warn!(
            error = %err,
            url = %authorize_url,
            "could not open the system browser automatically; user must open the URL manually"
        ),
    }

    tracing::info!("auth_login: waiting for loopback callback (up to 5 min)…");
    let code = server
        .wait_for_callback(LOGIN_TIMEOUT)
        .await
        .inspect_err(|e| tracing::error!(error = %e, "auth_login: loopback callback failed"))?;
    tracing::info!("auth_login: received authorization code; exchanging for tokens");

    let token = exchange_code(
        http,
        &target,
        &client_id,
        &code,
        &redirect_uri,
        &pkce_pair.verifier,
    )
    .await
    .inspect_err(|e| tracing::error!(error = %e, "auth_login: token exchange failed"))?;

    let Some(id_token) = token.id_token else {
        tracing::error!("auth_login: token endpoint returned no id_token");
        return Err(LoginError::NoIdToken);
    };
    let claims = decode_id_token(&id_token)?;
    tracing::info!(sub = %claims.sub, "auth_login: tokens exchanged; minting Better Auth session via bridge");

    // Bridge the fresh OAuth bearer into a REAL Better Auth session cookie
    // — see `mint_session_from_access_token`'s doc comment for the full
    // story. Deliberately BEFORE constructing the returned `StoredSession`
    // (and this function never persists anything itself — `session.rs`'s
    // `login()` does that with whatever this function returns) so a bridge
    // failure surfaces as a login failure, not a silently bearer-only
    // session an unsuspecting caller would persist and later believe is
    // fully signed in.
    let cookie_value = mint_session_from_access_token(http, &target, &token.access_token)
        .await
        .inspect_err(|e| tracing::error!(error = %e, "auth_login: session bridge failed"))?;

    let cookie_name = session_cookie_name(&target);
    tracing::info!(
        cookie_name,
        "auth_login: session cookie minted; login complete"
    );

    Ok(StoredSession {
        target: target.clone(),
        client_id,
        user: UserInfo {
            sub: claims.sub,
            email: claims.email,
            name: claims.name,
        },
        access_token: token.access_token,
        refresh_token: token.refresh_token,
        expires_at: token.expires_in.map(|s| now_unix() + s),
        created_at: now_rfc3339(),
        // Real-UI course-correction: this used to be unconditionally `None`
        // (the system-browser PKCE flow itself never yields a capturable
        // Better Auth session cookie — Google's consent screen and Better
        // Auth's own `/login` page both run in the SYSTEM browser's cookie
        // jar, a separate OS process this app cannot read). The mesh-side
        // bridge call above closes that gap: it exchanges the OAuth bearer
        // this flow always ends up with for a REAL Better Auth session,
        // minted server-side, so this path now carries a cookie exactly
        // like the embedded email/password/OTP cookie-relay path
        // (`bridge.rs::complete_via_cookie_jar`) already does — see
        // the native authentication contract for the empirical
        // trail this closes.
        cookie: Some(format!("{cookie_name}={cookie_value}")),
    })
}

/// Exchanges a freshly-minted MCP OAuth access token for a real Better Auth
/// session, via the mesh-side bridge endpoint
/// (`apps/api/src/api/routes/desktop-session-bridge.ts`,
/// `POST /api/auth/desktop/session-from-oauth`). This is the piece that
/// makes the system-browser Google/GitHub/SAML login path land in the same
/// place as the embedded email/password/OTP path: a Better Auth session
/// CREDENTIAL this crate can forward as a plain `Cookie:` header, which is
/// the only thing the real production shell's native sign-in gate
/// (`get-session`, `organization.list`, ...) accepts — an OAuth bearer alone
/// is rejected there (the native authentication contract §0-§3).
///
/// Returns the RAW, already-signed cookie VALUE (never a `Set-Cookie`
/// header — there is no browser here to capture one, so the mesh endpoint
/// hands it back in the JSON body instead). Callers prefix it with the
/// scheme-correct cookie NAME (`__Secure-better-auth.session_token=` on an
/// https upstream, `better-auth.session_token=` otherwise — see the caller
/// above) before storing/forwarding it —
/// see [`perform_interactive_login`]'s use above and
/// [`crate::tokens::StoredSession::cookie`]'s doc comment for the exact
/// `name=value` shape every other cookie-forwarding path in this crate
/// already expects.
///
/// Failure here is FATAL to the whole login attempt (propagated via `?`,
/// never swallowed into a bearer-only fallback): a bearer-only session
/// would report `signed_in: true` from this crate's own point of view (see
/// `session.rs`'s `probe_upstream`, which only checks a bearer-friendly
/// org-scoped route) while the real shell's `RequiredAuthLayout` gate would
/// still bounce the user straight back to `/login` — i.e. a silently
/// half-signed-in state, exactly the bug this bridge exists to close. A
/// clear, surfaced login error is strictly better than reintroducing it
/// through a different door.
/// Better Auth prefixes its session cookie with `__Secure-` whenever it
/// issues secure cookies, which it does BY DEFAULT on an https baseURL
/// (mesh sets no `advanced.useSecureCookies` override, so the installed
/// better-auth's `createCookieGetter` rule — literally
/// `baseURL.startsWith("https://")` — applies). `get-session` reads the
/// cookie back by that EXACT prefixed name, so forwarding an unprefixed
/// `better-auth.session_token` to an https upstream is silently ignored:
/// the bearer probe still reports signed-in, but the real shell's session
/// gate finds no cookie and bounces the user to /login. Match Better Auth's
/// own rule so the forwarded Cookie NAME is byte-identical to a browser
/// sign-in (the hybrid cookie-relay path in `bridge.rs` gets this for free
/// by capturing the real `Set-Cookie`; the system-browser login path and
/// `session.rs`'s cookie re-mint both have to reconstruct the name).
pub(crate) fn session_cookie_name(target: &str) -> &'static str {
    if target.starts_with("https://") {
        "__Secure-better-auth.session_token"
    } else {
        "better-auth.session_token"
    }
}

pub(crate) async fn mint_session_from_access_token(
    http: &reqwest::Client,
    target: &str,
    access_token: &str,
) -> Result<String, LoginError> {
    #[derive(Deserialize)]
    struct SessionBridgeResponse {
        #[serde(rename = "sessionToken")]
        session_token: String,
    }

    let res = http
        .post(format!("{target}/api/auth/desktop/session-from-oauth"))
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|e| LoginError::Network(e.to_string()))?;

    let status = res.status();
    if !status.is_success() {
        let text = res.text().await.unwrap_or_default();
        return Err(LoginError::SessionBridgeRejected(status.as_u16(), text));
    }
    let data: SessionBridgeResponse = res
        .json()
        .await
        .map_err(|e| LoginError::Network(format!("malformed session-bridge response: {e}")))?;
    if data.session_token.is_empty() {
        return Err(LoginError::SessionBridgeRejected(
            status.as_u16(),
            "session bridge returned an empty sessionToken".to_string(),
        ));
    }
    Ok(data.session_token)
}

/// `<opener> <url>` — mirrors `login.ts::defaultOpenBrowser`: `open` on
/// macOS, `xdg-open` elsewhere. A dedicated function (rather than inlined at
/// the `perform_interactive_login` call site) so tests can inject a
/// no-op/spy in place of actually launching a browser.
///
/// A host without the opener installed (a bare Linux session with no
/// `xdg-utils`) fails at spawn, which the caller soft-fails into logging the
/// authorize URL for the user to open by hand.
pub fn open_system_browser(url: &str) -> std::io::Result<()> {
    #[cfg(target_os = "macos")]
    const OPENER: &str = "open";
    #[cfg(not(target_os = "macos"))]
    const OPENER: &str = "xdg-open";

    std::process::Command::new(OPENER)
        .arg(url)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map(|_| ())
}

fn build_authorize_url(
    target: &str,
    client_id: &str,
    redirect_uri: &str,
    state: &str,
    code_challenge: &str,
) -> String {
    let params = [
        ("client_id", client_id),
        ("redirect_uri", redirect_uri),
        ("response_type", "code"),
        ("state", state),
        ("scope", SCOPES),
        ("code_challenge", code_challenge),
        ("code_challenge_method", "S256"),
    ];
    let query: String = params
        .iter()
        .map(|(k, v)| format!("{k}={}", urlencoding::encode(v)))
        .collect::<Vec<_>>()
        .join("&");
    format!("{target}/login?{query}")
}

/// `pub(crate)`: [`crate::bridge::complete_via_cookie_jar`] calls this
/// directly for its own code->token exchange — same endpoint, same request
/// shape, the machinery this crate's non-interactive bridge flow is
/// supposed to reuse rather than re-implement (see that module's doc
/// comment).
pub(crate) async fn exchange_code(
    http: &reqwest::Client,
    target: &str,
    client_id: &str,
    code: &str,
    redirect_uri: &str,
    verifier: &str,
) -> Result<TokenResponse, LoginError> {
    let res = http
        .post(format!("{target}/api/auth/mcp/token"))
        .form(&[
            ("grant_type", "authorization_code"),
            ("code", code),
            ("redirect_uri", redirect_uri),
            ("client_id", client_id),
            ("code_verifier", verifier),
        ])
        .send()
        .await
        .map_err(|e| LoginError::Network(e.to_string()))?;

    let status = res.status();
    if !status.is_success() {
        let text = res.text().await.unwrap_or_default();
        return Err(LoginError::TokenExchangeRejected(status.as_u16(), text));
    }
    let data: TokenResponse = res
        .json()
        .await
        .map_err(|e| LoginError::Network(format!("malformed token response: {e}")))?;
    if data.access_token.is_empty() {
        return Err(LoginError::NoAccessToken);
    }
    Ok(data)
}

/// Decodes an id_token's payload segment (no signature verification — this
/// crate trusts the token endpoint it just talked to over TLS directly,
/// exactly like `login.ts::decodeIdToken`, which does the same). `pub(crate)`
/// — shared with [`crate::bridge`], see [`TokenResponse`]'s doc comment.
pub(crate) fn decode_id_token(id_token: &str) -> Result<IdTokenClaims, LoginError> {
    let parts: Vec<&str> = id_token.split('.').collect();
    let [_, payload, _] = parts.as_slice() else {
        return Err(LoginError::MalformedIdToken(
            "expected 3 dot-separated segments".to_string(),
        ));
    };
    let bytes = URL_SAFE_NO_PAD
        .decode(payload)
        .map_err(|e| LoginError::MalformedIdToken(e.to_string()))?;
    serde_json::from_slice(&bytes).map_err(|e| LoginError::MalformedIdToken(e.to_string()))
}

// --- Loopback callback server -----------------------------------------

#[derive(Debug, Deserialize, Default)]
struct CallbackQuery {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
}

enum CallbackOutcome {
    Code(String),
    Denied(String),
    StateMismatch,
    MissingCode,
}

struct CallbackState {
    expected_state: String,
    /// Absolute URL for the post-success 302 — the mesh-hosted
    /// `/cli/auth-success` page (owner decision, matching the legacy
    /// `deco auth login` behavior exactly: `apps/api/src/cli/lib/
    /// oauth-callback.ts` also 302s there instead of serving its own
    /// HTML, so the user lands on the same polished capybara page).
    success_redirect: String,
    result_tx: Mutex<Option<oneshot::Sender<CallbackOutcome>>>,
}

struct LoopbackServer {
    local_addr: SocketAddr,
    result_rx: oneshot::Receiver<CallbackOutcome>,
    shutdown_tx: Mutex<Option<oneshot::Sender<()>>>,
}

impl LoopbackServer {
    /// Binds `127.0.0.1:0` (OS-assigned ephemeral port — never a fixed
    /// port, so multiple app instances / repeated logins never collide).
    async fn start(expected_state: String, success_redirect: String) -> Result<Self, String> {
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .await
            .map_err(|e| e.to_string())?;
        let local_addr = listener.local_addr().map_err(|e| e.to_string())?;

        let (result_tx, result_rx) = oneshot::channel();
        let (shutdown_tx, shutdown_rx) = oneshot::channel();

        let state = Arc::new(CallbackState {
            expected_state,
            success_redirect,
            result_tx: Mutex::new(Some(result_tx)),
        });

        let app = Router::new().route(
            "/",
            get({
                let state = state.clone();
                move |query: Query<CallbackQuery>| {
                    let state = state.clone();
                    async move { handle_callback(state, query).await }
                }
            }),
        );

        tokio::spawn(async move {
            let _ = axum::serve(listener, app)
                .with_graceful_shutdown(async move {
                    let _ = shutdown_rx.await;
                })
                .await;
        });

        Ok(Self {
            local_addr,
            result_rx,
            shutdown_tx: Mutex::new(Some(shutdown_tx)),
        })
    }

    /// Awaits exactly one callback (bounded by `timeout`), then shuts the
    /// loopback listener down regardless of outcome — a login attempt
    /// never leaves a socket listening past its own result.
    async fn wait_for_callback(self, timeout: Duration) -> Result<String, LoginError> {
        let outcome = tokio::time::timeout(timeout, self.result_rx).await;
        // Always tear down the listener before returning, on every path.
        if let Some(tx) = self.shutdown_tx.lock().unwrap().take() {
            let _ = tx.send(());
        }
        match outcome {
            Err(_elapsed) => Err(LoginError::Timeout),
            Ok(Err(_recv_err)) => Err(LoginError::CallbackServerGone),
            Ok(Ok(CallbackOutcome::Code(code))) => Ok(code),
            Ok(Ok(CallbackOutcome::Denied(desc))) => Err(LoginError::Denied(desc)),
            Ok(Ok(CallbackOutcome::StateMismatch)) => Err(LoginError::StateMismatch),
            Ok(Ok(CallbackOutcome::MissingCode)) => Err(LoginError::MissingCode),
        }
    }
}

async fn handle_callback(
    state: Arc<CallbackState>,
    Query(query): Query<CallbackQuery>,
) -> Response {
    let Some(tx) = state.result_tx.lock().unwrap().take() else {
        // A second request after the first already resolved (e.g. a
        // stray browser prefetch/retry) — harmless no-op response.
        return (StatusCode::NO_CONTENT, "").into_response();
    };

    if let Some(desc) = query.error.clone() {
        let full = query
            .error_description
            .clone()
            .map(|d| format!("{desc}: {d}"))
            .unwrap_or(desc);
        let _ = tx.send(CallbackOutcome::Denied(full.clone()));
        return failure_page(&format!("Sign-in was cancelled ({full})."));
    }

    if query.state.as_deref() != Some(state.expected_state.as_str()) {
        let _ = tx.send(CallbackOutcome::StateMismatch);
        return failure_page(
            "This sign-in link doesn't match the request that opened it. Please try again.",
        );
    }

    let Some(code) = query.code.clone().filter(|c| !c.is_empty()) else {
        let _ = tx.send(CallbackOutcome::MissingCode);
        return failure_page("The sign-in response was missing an authorization code.");
    };

    let _ = tx.send(CallbackOutcome::Code(code));
    // 302 to the mesh-hosted success page (see CallbackState::success_redirect)
    // — the code is already through the channel, so even an unreachable
    // upstream page cannot affect the sign-in itself.
    axum::response::Redirect::temporary(&state.success_redirect).into_response()
}

fn failure_page(message: &str) -> Response {
    (StatusCode::BAD_REQUEST, Html(failure_page_html(message))).into_response()
}

fn failure_page_html(message: &str) -> String {
    // Chrome is shared with the other browser-facing dead-end pages (see
    // `crate::browser_page`) so they cannot drift apart; `render` does the
    // escaping.
    browser_page::render(browser_page::Page {
        title: "Sign-in failed — deco Studio",
        heading: "Sign-in failed",
        body: message,
        hint: Some("Close this tab and try signing in again from the app."),
        destructive: true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn authorize_url_includes_pkce_and_state_params() {
        let url = build_authorize_url(
            "https://studio.decocms.com",
            "client_1",
            "http://127.0.0.1:5000/",
            "state-abc",
            "challenge-xyz",
        );
        assert!(url.starts_with("https://studio.decocms.com/login?"));
        assert!(url.contains("client_id=client_1"));
        assert!(url.contains("state=state-abc"));
        assert!(url.contains("code_challenge=challenge-xyz"));
        assert!(url.contains("code_challenge_method=S256"));
        assert!(url.contains("response_type=code"));
        assert!(url.contains(&urlencoding::encode("http://127.0.0.1:5000/").into_owned()));
    }

    #[test]
    fn decode_id_token_extracts_claims() {
        let payload = URL_SAFE_NO_PAD
            .encode(serde_json::json!({"sub":"user_1","email":"a@b.com","name":"A B"}).to_string());
        let jwt = format!("header.{payload}.sig");
        let claims = decode_id_token(&jwt).unwrap();
        assert_eq!(claims.sub, "user_1");
        assert_eq!(claims.email.as_deref(), Some("a@b.com"));
        assert_eq!(claims.name.as_deref(), Some("A B"));
    }

    #[test]
    fn decode_id_token_rejects_malformed_jwt_shapes() {
        assert!(decode_id_token("not-a-jwt").is_err());
        assert!(decode_id_token("a.b").is_err());
        let bad_payload = URL_SAFE_NO_PAD.encode("not json");
        assert!(decode_id_token(&format!("h.{bad_payload}.s")).is_err());
    }

    // --- mint_session_from_access_token: the mesh session bridge call ------

    async fn spawn(app: axum::Router) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        format!("http://{addr}")
    }

    #[tokio::test]
    async fn mint_session_from_access_token_returns_the_session_token_on_success() {
        use axum::http::HeaderMap;
        use std::sync::{Arc, Mutex};

        let seen_bearer = Arc::new(Mutex::new(None::<String>));
        let seen_for_route = seen_bearer.clone();
        let app = axum::Router::new().route(
            "/api/auth/desktop/session-from-oauth",
            axum::routing::post(move |headers: HeaderMap| {
                let seen = seen_for_route.clone();
                async move {
                    *seen.lock().unwrap() = headers
                        .get(axum::http::header::AUTHORIZATION)
                        .and_then(|v| v.to_str().ok())
                        .map(|s| s.to_string());
                    axum::Json(serde_json::json!({"sessionToken": "raw-token.signature"}))
                }
            }),
        );
        let target = spawn(app).await;
        let http = reqwest::Client::new();

        let value = mint_session_from_access_token(&http, &target, "the-access-token")
            .await
            .expect("bridge call should succeed against a well-behaved mock mesh");

        assert_eq!(value, "raw-token.signature");
        assert_eq!(
            seen_bearer.lock().unwrap().as_deref(),
            Some("Bearer the-access-token")
        );
    }

    #[tokio::test]
    async fn mint_session_from_access_token_surfaces_a_rejected_bearer() {
        let app = axum::Router::new().route(
            "/api/auth/desktop/session-from-oauth",
            axum::routing::post(|| async {
                (
                    axum::http::StatusCode::UNAUTHORIZED,
                    axum::Json(serde_json::json!({"error": "unauthorized"})),
                )
            }),
        );
        let target = spawn(app).await;
        let http = reqwest::Client::new();

        let err = mint_session_from_access_token(&http, &target, "bad-token")
            .await
            .unwrap_err();
        match err {
            LoginError::SessionBridgeRejected(status, body) => {
                assert_eq!(status, 401);
                assert!(body.contains("unauthorized"));
            }
            other => panic!("expected SessionBridgeRejected, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn mint_session_from_access_token_rejects_an_empty_session_token() {
        let app = axum::Router::new().route(
            "/api/auth/desktop/session-from-oauth",
            axum::routing::post(|| async { axum::Json(serde_json::json!({"sessionToken": ""})) }),
        );
        let target = spawn(app).await;
        let http = reqwest::Client::new();

        let err = mint_session_from_access_token(&http, &target, "the-access-token")
            .await
            .unwrap_err();
        assert!(matches!(err, LoginError::SessionBridgeRejected(200, _)));
    }

    // `now_rfc3339`/`now_unix` shape tests moved to `clock.rs` — this
    // module now imports both from there (see this file's top-of-file
    // `use crate::clock::...`) instead of defining its own copies.

    #[test]
    fn failure_page_html_has_expected_headline_and_escapes_the_message() {
        let html = failure_page_html("<script>alert(1)</script> & \"quoted\"");
        assert!(html.contains("Sign-in failed"));
        assert!(html.contains("&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;quoted&quot;"));
        assert!(!html.contains("<script>alert(1)</script>"));
        assert!(html.contains("brand-mark--light"));
        assert!(html.contains("brand-mark--dark"));
    }

    #[tokio::test]
    async fn loopback_server_resolves_code_on_matching_state() {
        let server = LoopbackServer::start(
            "expected-state".to_string(),
            "http://upstream.test/cli/auth-success".to_string(),
        )
        .await
        .unwrap();
        let addr = server.local_addr;
        let waiter = tokio::spawn(server.wait_for_callback(Duration::from_secs(5)));

        // Give the server a moment to actually start accepting.
        tokio::time::sleep(Duration::from_millis(50)).await;
        // Redirects disabled: success now 302s to the mesh-hosted
        // /cli/auth-success page (owner decision — legacy CLI parity);
        // following it would DNS-resolve the fake upstream host.
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        let res = client
            .get(format!(
                "http://{addr}/?code=auth-code-123&state=expected-state"
            ))
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::TEMPORARY_REDIRECT);
        assert_eq!(
            res.headers().get("location").unwrap(),
            "http://upstream.test/cli/auth-success"
        );

        let code = waiter.await.unwrap().unwrap();
        assert_eq!(code, "auth-code-123");
    }

    #[tokio::test]
    async fn loopback_server_rejects_state_mismatch() {
        let server = LoopbackServer::start(
            "expected-state".to_string(),
            "http://upstream.test/cli/auth-success".to_string(),
        )
        .await
        .unwrap();
        let addr = server.local_addr;
        let waiter = tokio::spawn(server.wait_for_callback(Duration::from_secs(5)));

        tokio::time::sleep(Duration::from_millis(50)).await;
        let client = reqwest::Client::new();
        let res = client
            .get(format!("http://{addr}/?code=abc&state=WRONG"))
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::BAD_REQUEST);

        let err = waiter.await.unwrap().unwrap_err();
        assert!(matches!(err, LoginError::StateMismatch));
    }

    #[tokio::test]
    async fn loopback_server_surfaces_authorization_server_error_param() {
        let server = LoopbackServer::start(
            "expected-state".to_string(),
            "http://upstream.test/cli/auth-success".to_string(),
        )
        .await
        .unwrap();
        let addr = server.local_addr;
        let waiter = tokio::spawn(server.wait_for_callback(Duration::from_secs(5)));

        tokio::time::sleep(Duration::from_millis(50)).await;
        let client = reqwest::Client::new();
        let _ = client
            .get(format!(
                "http://{addr}/?error=access_denied&error_description=user+cancelled&state=expected-state"
            ))
            .send()
            .await
            .unwrap();

        let err = waiter.await.unwrap().unwrap_err();
        match err {
            LoginError::Denied(msg) => assert!(msg.contains("access_denied")),
            other => panic!("expected Denied, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn loopback_server_times_out_when_nothing_ever_calls_back() {
        let server = LoopbackServer::start(
            "expected-state".to_string(),
            "http://upstream.test/cli/auth-success".to_string(),
        )
        .await
        .unwrap();
        let err = server
            .wait_for_callback(Duration::from_millis(50))
            .await
            .unwrap_err();
        assert!(matches!(err, LoginError::Timeout));
    }

    /// Interactive end-to-end login against the REAL upstream target,
    /// opening a REAL system browser — deliberately `#[ignore]`d, per the
    /// brief ("do NOT attempt a real browser login in CI/agents"). Manual
    /// step for a human on a macOS dev machine with a valid decocms
    /// account:
    ///   DECOCMS_UPSTREAM_URL=https://studio.decocms.com \
    ///     cargo test -p upstream real_interactive_login -- --ignored --nocapture
    #[tokio::test]
    #[ignore]
    async fn real_interactive_login() {
        let target = std::env::var("DECOCMS_UPSTREAM_URL")
            .unwrap_or_else(|_| "https://studio.decocms.com".to_string());
        let http = reqwest::Client::new();
        let session = perform_interactive_login(&http, &target, open_system_browser)
            .await
            .expect("interactive login should succeed when a human completes it in the browser");
        println!("logged in as {:?}", session.user);
    }
}
