//! `auth_complete_session` — the hybrid-login bridge (owner brief, post-v1
//! feedback: "the desktop sign-in must reuse the usual web login screen").
//! After the desktop-embedded login screen (the SAME shared component as
//! the web `/login` route) has driven a cookie-authenticated Better Auth
//! session into this process's in-memory [`crate::cookie_jar::CookieJar`]
//! via `crates/local-api/src/routes/upstream.rs`'s bare `/api/auth/*` proxy
//! branch, this module performs the MCP OAuth 2.1 + PKCE authorize/token
//! dance ON THE JAR'S BEHALF — no browser hop, no ACTUALLY-listening
//! loopback server — and lands the result in the SAME Keychain path
//! [`crate::login::perform_interactive_login`]'s interactive flow uses.
//!
//! ## Real-UI course-correction: the cookie now OUTLIVES this call
//!
//! Earlier (Phase 3) revisions treated the jar's cookie as purely a
//! transient credential for THIS authorize call, discarded the instant the
//! bridge concluded. That undersold what the cookie is for: the real
//! production web shell's own sign-in gate (`RequiredAuthLayout` /
//! `authClient.useSession()` -> `GET /api/auth/get-session`) and org
//! switcher (`authClient.organization.list()`) hit Better Auth's NATIVE
//! `/api/auth/*` endpoints, which only ever recognize a session COOKIE —
//! the MCP OAuth bearer this crate mints satisfies org-scoped
//! `/api/:org/tools/*`/`/api/:org/decopilot/*` calls but is rejected there
//! (`403 INVALID_API_KEY`, empirically confirmed —
//! the native authentication contract). So [`complete_via_cookie_jar`]
//! now returns the cookie it used AS PART OF the [`StoredSession`] it
//! builds; `session.rs::complete_session` persists it to the Keychain
//! alongside the OAuth tokens, and `crates/local-api/src/routes/upstream.rs`
//! attaches it on every app-API call for the rest of this session's
//! life (see that file's module doc and `tokens.rs`'s `StoredSession::cookie`
//! doc comment) — not just the one authorize round trip this function makes.
//!
//! ## Empirical verification against the live mesh dev server
//!
//! Two behaviors this module depends on were verified with real HTTP
//! requests against a running `apps/api` dev server
//! (`DECOCMS_UPSTREAM_URL=http://localhost:4000`), not just by reading
//! source:
//!
//! 1. **No consent step for an authenticated session.** Studio's `mcp()`
//!    plugin config (`apps/api/src/auth/index.ts`) sets no `consentPage`,
//!    and this module never sends `prompt=consent`. Reading
//!    `better-auth`'s installed `dist/plugins/mcp/authorize.mjs`
//!    (`authorizeMCPOAuth`) confirms `query.prompt !== "consent"` skips
//!    straight to `throw ctx.redirect(redirectURIWithCode)` — no consent
//!    page is ever rendered. Confirmed live: `GET /api/auth/mcp/authorize`
//!    with a valid session cookie returned a single `302` straight to
//!    `redirect_uri?code=...&state=...` — the "walk the redirect chain"
//!    loop below is defensive headroom for a future consent-page rollout,
//!    not evidence multiple hops are needed today.
//! 2. **`redirect_uri` is matched by EXACT string equality, not
//!    host+scheme.** `authorize.mjs`:
//!    `client.redirectUrls.find(url => url === ctx.query.redirect_uri)`.
//!    Confirmed live: registering a client with
//!    `redirect_uris:["http://127.0.0.1:11111/"]` then calling authorize
//!    with `redirect_uri=http://127.0.0.1:22222/` (same client_id, only the
//!    port differs) returned `400 {"code":"INVALID_REDIRECT_URI"}`. This is
//!    exactly why neither `crate::login`'s interactive flow nor this bridge
//!    reuses a client_id across calls — each registers a FRESH client bound
//!    to the exact ephemeral redirect_uri it is about to authorize with
//!    (see `crate::register`'s module doc). This
//!    function therefore always registers a FRESH client scoped to its
//!    OWN freshly-reserved redirect_uri (see [`complete_via_cookie_jar`]),
//!    at the cost of one extra registration round trip per bridge attempt
//!    — cheap next to the network round trips this flow already makes, and
//!    provably correct regardless of which port was reserved. (This same
//!    exact-match behavior likely also affects a SECOND interactive
//!    `crate::login` attempt reusing a first attempt's cached client_id
//!    under a different ephemeral port; that's `crate::login`/
//!    `crate::register`'s own pre-existing behavior, out of this module's
//!    scope to change — flagged here since this module's empirical dig
//!    surfaced it.)

use reqwest::header::{COOKIE, LOCATION};
use reqwest::Url;

use crate::clock::{now_rfc3339, now_unix};
use crate::cookie_jar::CookieJar;
use crate::login::{self, LoginError};
use crate::pkce;
use crate::register::{self, RegisterError};
use crate::tokens::{StoredSession, UserInfo};

/// Hard cap on redirects this function will follow between the authorize
/// GET and landing on `redirect_uri` — see this module's doc comment for
/// why the happy path needs exactly one hop and this bound exists as
/// defensive headroom, not an expected steady-state multi-hop dance.
const MAX_REDIRECT_HOPS: usize = 5;

#[derive(Debug, thiserror::Error)]
pub enum BridgeError {
    #[error("no upstream session cookie captured yet — sign in via the /api/auth/* proxy first")]
    NoSessionCookie,
    #[error(transparent)]
    Register(#[from] RegisterError),
    #[error("failed to reserve a loopback redirect port: {0}")]
    Listener(String),
    #[error("network error during the auth bridge: {0}")]
    Network(String),
    #[error("authorize endpoint returned HTTP {0} instead of a redirect: {1}")]
    UnexpectedAuthorizeStatus(u16, String),
    #[error("authorize redirect had no Location header")]
    MissingLocation,
    #[error("could not parse the authorize redirect Location: {0}")]
    MalformedLocation(String),
    #[error("too many redirects while resolving the authorize response")]
    TooManyRedirects,
    #[error("authorization server denied the request: {0}")]
    Denied(String),
    #[error("authorize redirect state did not match the request this bridge sent")]
    StateMismatch,
    #[error("authorize redirect was missing an authorization code")]
    MissingCode,
    #[error(transparent)]
    TokenExchange(#[from] LoginError),
}

/// Builds a `reqwest::Client` suitable for this bridge: redirects
/// DISABLED (the whole point of [`complete_via_cookie_jar`] is to
/// intercept the redirect itself rather than let an HTTP client silently
/// follow it into a request against a loopback address nothing is
/// listening on) and the same per-request timeout every other HTTP call
/// in this crate uses.
pub fn bridge_http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

/// Runs the non-interactive MCP OAuth authorize/token dance against
/// `target`, using `jar`'s captured Better Auth session cookie for `host`
/// in place of a real browser + real loopback listener. Returns a
/// [`StoredSession`] ready for [`crate::tokens::TokenStore::save`] — does
/// NOT persist it or touch the jar itself; see
/// [`crate::session::UpstreamSession::complete_session`] for the caller
/// that does both (that method purges the jar unconditionally on every
/// outcome of THIS function, success or failure — see its own doc
/// comment for why).
pub async fn complete_via_cookie_jar(
    http: &reqwest::Client,
    target: &str,
    host: &str,
    jar: &CookieJar,
) -> Result<StoredSession, BridgeError> {
    let cookie_header = jar.header_value(host).ok_or(BridgeError::NoSessionCookie)?;

    let redirect_uri = reserve_loopback_redirect_uri().await?;
    let state = uuid::Uuid::new_v4().to_string();
    let pkce_pair = pkce::generate();

    // See this module's doc comment §2: always register fresh (the upstream
    // does exact redirect_uri matching), since this call's redirect_uri port
    // is never one a previous registration could have matched.
    let client_id = register::register_client(http, target, &redirect_uri).await?;

    let authorize_url = build_authorize_url(
        target,
        &client_id,
        &redirect_uri,
        &state,
        &pkce_pair.challenge,
    );

    let landed = follow_to_loopback(http, &authorize_url, &cookie_header, &redirect_uri).await?;
    let (code, returned_state, error) = parse_callback_params(&landed);

    if let Some(desc) = error {
        return Err(BridgeError::Denied(desc));
    }
    if returned_state.as_deref() != Some(state.as_str()) {
        return Err(BridgeError::StateMismatch);
    }
    let code = code.ok_or(BridgeError::MissingCode)?;

    let token = login::exchange_code(
        http,
        target,
        &client_id,
        &code,
        &redirect_uri,
        &pkce_pair.verifier,
    )
    .await?;

    let Some(id_token) = token.id_token else {
        return Err(BridgeError::TokenExchange(LoginError::NoIdToken));
    };
    let claims = login::decode_id_token(&id_token).map_err(BridgeError::TokenExchange)?;

    Ok(StoredSession {
        target: target.to_string(),
        client_id,
        user: UserInfo {
            sub: claims.sub,
            email: claims.email,
            name: claims.name,
        },
        access_token: token.access_token,
        refresh_token: token.refresh_token,
        expires_at: token.expires_in.map(|s| now_unix().saturating_add(s)),
        created_at: now_rfc3339(),
        // Owner course-correction (post-Phase-3): the cookie that
        // authenticated THIS authorize call is no longer a one-shot,
        // immediately-discarded credential — it's persisted into the
        // returned session (`session.rs::complete_session` saves it to the
        // Keychain verbatim) and attached on every future app-API
        // call for this session's lifetime, because the real production
        // web shell's own sign-in gate and org switcher hit Better Auth's
        // NATIVE `/api/auth/*` endpoints, which reject the MCP OAuth bearer
        // this crate otherwise uses (empirically confirmed —
        // the native authentication contract). See `tokens.rs`'s
        // `StoredSession::cookie` doc comment.
        cookie: Some(cookie_header.clone()),
    })
}

/// Binds an ephemeral loopback port just long enough to learn a free port
/// number, then immediately releases it — "a real bound listener is
/// unnecessary" per the brief: this function never actually receives a
/// request on the returned URI, since the authorize redirect's `Location`
/// header is intercepted directly (see [`follow_to_loopback`]) rather than
/// actually being requested. Binding-then-dropping still buys the same
/// OS-assigned collision avoidance `login.rs`'s real `LoopbackServer::start`
/// gets from asking for port `0`, without the cost of running an axum
/// server that would never accept a connection.
async fn reserve_loopback_redirect_uri() -> Result<String, BridgeError> {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|e| BridgeError::Listener(e.to_string()))?;
    let addr = listener
        .local_addr()
        .map_err(|e| BridgeError::Listener(e.to_string()))?;
    drop(listener);
    Ok(format!("http://{addr}/"))
}

/// `GET {target}/api/auth/mcp/authorize?...` — unlike `login.rs`'s
/// `build_authorize_url` (which points at the studio `/login` PAGE, for an
/// unauthenticated browser to complete interactively), this hits the
/// backend OAuth endpoint DIRECTLY: this bridge already has an
/// authenticated session (the jar's cookie), so there is no login page to
/// visit — see this module's doc comment for the empirical verification
/// that an authenticated, non-consent request auto-redirects from here in
/// exactly one hop.
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
        ("scope", login::SCOPES),
        ("code_challenge", code_challenge),
        ("code_challenge_method", "S256"),
    ];
    let query: String = params
        .iter()
        .map(|(k, v)| format!("{k}={}", urlencoding::encode(v)))
        .collect::<Vec<_>>()
        .join("&");
    format!("{target}/api/auth/mcp/authorize?{query}")
}

/// Issues the authorize GET (carrying the jar's cookie) and walks any
/// redirect chain — following each `Location` in turn, re-attaching the
/// SAME cookie header on every hop — until a `Location` matches
/// `redirect_uri`'s scheme+host+port+path. Returns that final URL (query
/// string intact, containing `code`/`state`/`error`) WITHOUT ever actually
/// requesting it — the loopback address has nothing listening on it by
/// design (see [`reserve_loopback_redirect_uri`]).
async fn follow_to_loopback(
    http: &reqwest::Client,
    start_url: &str,
    cookie_header: &str,
    redirect_uri: &str,
) -> Result<Url, BridgeError> {
    let target_uri =
        Url::parse(redirect_uri).map_err(|e| BridgeError::MalformedLocation(e.to_string()))?;
    let mut current =
        Url::parse(start_url).map_err(|e| BridgeError::MalformedLocation(e.to_string()))?;

    for _ in 0..MAX_REDIRECT_HOPS {
        if same_endpoint(&current, &target_uri) {
            return Ok(current);
        }
        let resp = http
            .get(current.clone())
            .header(COOKIE, cookie_header)
            .send()
            .await
            .map_err(|e| BridgeError::Network(e.to_string()))?;
        let status = resp.status();
        if !status.is_redirection() {
            let body = resp.text().await.unwrap_or_default();
            return Err(BridgeError::UnexpectedAuthorizeStatus(
                status.as_u16(),
                body,
            ));
        }
        let location = resp
            .headers()
            .get(LOCATION)
            .and_then(|v| v.to_str().ok())
            .ok_or(BridgeError::MissingLocation)?
            .to_string();
        current = current
            .join(&location)
            .map_err(|e| BridgeError::MalformedLocation(e.to_string()))?;
    }
    Err(BridgeError::TooManyRedirects)
}

/// Scheme+host+port+path equality — deliberately ignores the query string
/// (which carries `code`/`state`, the whole reason we're comparing) and
/// fragment.
fn same_endpoint(a: &Url, b: &Url) -> bool {
    a.scheme() == b.scheme()
        && a.host_str() == b.host_str()
        && a.port_or_known_default() == b.port_or_known_default()
        && a.path() == b.path()
}

fn parse_callback_params(url: &Url) -> (Option<String>, Option<String>, Option<String>) {
    let mut code = None;
    let mut state = None;
    let mut error = None;
    for (k, v) in url.query_pairs() {
        match k.as_ref() {
            "code" => code = Some(v.into_owned()),
            "state" => state = Some(v.into_owned()),
            "error" => error = Some(v.into_owned()),
            _ => {}
        }
    }
    (code, state, error)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::extract::Query;
    use axum::http::StatusCode;
    use axum::response::{IntoResponse, Redirect};
    use axum::routing::{get, post};
    use axum::{Json, Router};
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
    use tokio::net::TcpListener;

    async fn spawn(app: Router) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        format!("http://{addr}")
    }

    // --- reserve_loopback_redirect_uri / same_endpoint / parse_callback_params ---

    #[tokio::test]
    async fn reserve_loopback_redirect_uri_returns_a_usable_http_url() {
        let uri = reserve_loopback_redirect_uri().await.unwrap();
        assert!(uri.starts_with("http://127.0.0.1:"));
        assert!(uri.ends_with('/'));
        let parsed = Url::parse(&uri).unwrap();
        assert_eq!(parsed.host_str(), Some("127.0.0.1"));
        assert!(parsed.port().is_some());
    }

    #[tokio::test]
    async fn two_reservations_never_collide() {
        let a = reserve_loopback_redirect_uri().await.unwrap();
        let b = reserve_loopback_redirect_uri().await.unwrap();
        assert_ne!(a, b);
    }

    #[test]
    fn same_endpoint_ignores_query_and_fragment() {
        let a = Url::parse("http://127.0.0.1:5000/?code=abc&state=xyz").unwrap();
        let b = Url::parse("http://127.0.0.1:5000/").unwrap();
        assert!(same_endpoint(&a, &b));
    }

    #[test]
    fn same_endpoint_rejects_a_different_port() {
        let a = Url::parse("http://127.0.0.1:5000/").unwrap();
        let b = Url::parse("http://127.0.0.1:5001/").unwrap();
        assert!(!same_endpoint(&a, &b));
    }

    #[test]
    fn parse_callback_params_extracts_code_and_state() {
        let url = Url::parse("http://127.0.0.1:5000/?code=abc123&state=my-state").unwrap();
        let (code, state, error) = parse_callback_params(&url);
        assert_eq!(code.as_deref(), Some("abc123"));
        assert_eq!(state.as_deref(), Some("my-state"));
        assert_eq!(error, None);
    }

    #[test]
    fn parse_callback_params_extracts_error() {
        let url = Url::parse("http://127.0.0.1:5000/?error=access_denied&state=my-state").unwrap();
        let (code, state, error) = parse_callback_params(&url);
        assert_eq!(code, None);
        assert_eq!(state.as_deref(), Some("my-state"));
        assert_eq!(error.as_deref(), Some("access_denied"));
    }

    // --- follow_to_loopback: the redirect-chain walker ---------------------

    #[tokio::test]
    async fn follow_to_loopback_resolves_a_single_hop_carrying_the_cookie() {
        let seen_cookie = Arc::new(Mutex::new(None::<String>));
        let seen_for_route = seen_cookie.clone();
        let app = Router::new().route(
            "/api/auth/mcp/authorize",
            get(move |headers: axum::http::HeaderMap| {
                let seen = seen_for_route.clone();
                async move {
                    *seen.lock().unwrap() = headers
                        .get(axum::http::header::COOKIE)
                        .and_then(|v| v.to_str().ok())
                        .map(|s| s.to_string());
                    Redirect::to("http://127.0.0.1:9999/?code=the-code&state=the-state")
                }
            }),
        );
        let base = spawn(app).await;
        let http = bridge_http_client();

        let landed = follow_to_loopback(
            &http,
            &format!("{base}/api/auth/mcp/authorize"),
            "better-auth.session_token=abc",
            "http://127.0.0.1:9999/",
        )
        .await
        .unwrap();

        assert_eq!(
            landed.as_str(),
            "http://127.0.0.1:9999/?code=the-code&state=the-state"
        );
        assert_eq!(
            seen_cookie.lock().unwrap().as_deref(),
            Some("better-auth.session_token=abc")
        );
    }

    #[tokio::test]
    async fn follow_to_loopback_walks_multiple_hops() {
        let app = Router::new()
            .route("/hop1", get(|| async { Redirect::to("/hop2") }))
            .route(
                "/hop2",
                get(|| async { Redirect::to("http://127.0.0.1:9999/?code=multi-hop&state=s") }),
            );
        let base = spawn(app).await;
        let http = bridge_http_client();

        let landed = follow_to_loopback(
            &http,
            &format!("{base}/hop1"),
            "cookie=1",
            "http://127.0.0.1:9999/",
        )
        .await
        .unwrap();
        assert_eq!(landed.query(), Some("code=multi-hop&state=s"));
    }

    #[tokio::test]
    async fn follow_to_loopback_gives_up_after_too_many_hops() {
        let hop_count = Arc::new(AtomicUsize::new(0));
        let count_for_route = hop_count.clone();
        let app = Router::new().route(
            "/loop",
            get(move || {
                let count = count_for_route.clone();
                async move {
                    let n = count.fetch_add(1, Ordering::SeqCst);
                    Redirect::to(&format!("/loop?n={n}"))
                }
            }),
        );
        let base = spawn(app).await;
        let http = bridge_http_client();

        let err = follow_to_loopback(
            &http,
            &format!("{base}/loop"),
            "cookie=1",
            "http://127.0.0.1:9999/",
        )
        .await
        .unwrap_err();
        assert!(matches!(err, BridgeError::TooManyRedirects));
    }

    #[tokio::test]
    async fn follow_to_loopback_surfaces_a_non_redirect_status() {
        let app = Router::new().route(
            "/api/auth/mcp/authorize",
            get(|| async {
                (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({"code":"INVALID_REDIRECT_URI"})),
                )
            }),
        );
        let base = spawn(app).await;
        let http = bridge_http_client();

        let err = follow_to_loopback(
            &http,
            &format!("{base}/api/auth/mcp/authorize"),
            "cookie=1",
            "http://127.0.0.1:9999/",
        )
        .await
        .unwrap_err();
        match err {
            BridgeError::UnexpectedAuthorizeStatus(status, body) => {
                assert_eq!(status, 400);
                assert!(body.contains("INVALID_REDIRECT_URI"));
            }
            other => panic!("expected UnexpectedAuthorizeStatus, got {other:?}"),
        }
    }

    // --- complete_via_cookie_jar: end-to-end against a mock upstream --------

    /// Spawns a mock Better Auth-shaped upstream: `/api/auth/mcp/register`,
    /// `/api/auth/mcp/authorize` (redirects with `code`/`state` when the
    /// expected cookie is present, otherwise 401), and `/api/auth/mcp/token`.
    async fn spawn_mock_mesh(expected_cookie: &'static str) -> String {
        let app = Router::new()
            .route(
                "/api/auth/mcp/register",
                post(|| async {
                    Json(serde_json::json!({"client_id": "mock-client-id"}))
                }),
            )
            .route(
                "/api/auth/mcp/authorize",
                get(
                    move |Query(params): Query<HashMap<String, String>>,
                          headers: axum::http::HeaderMap| {
                        async move {
                            let cookie = headers
                                .get(axum::http::header::COOKIE)
                                .and_then(|v| v.to_str().ok())
                                .unwrap_or("");
                            if cookie != expected_cookie {
                                return (StatusCode::UNAUTHORIZED, "no session").into_response();
                            }
                            let redirect_uri = params.get("redirect_uri").cloned().unwrap();
                            let state = params.get("state").cloned().unwrap_or_default();
                            let mut url = Url::parse(&redirect_uri).unwrap();
                            url.query_pairs_mut()
                                .append_pair("code", "mock-auth-code")
                                .append_pair("state", &state);
                            Redirect::to(url.as_str()).into_response()
                        }
                    },
                ),
            )
            .route(
                "/api/auth/mcp/token",
                post(|| async {
                    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
                    let payload = serde_json::json!({"sub":"user_1","email":"bridge@example.test","name":"Bridge User"});
                    let payload_b64 = URL_SAFE_NO_PAD.encode(payload.to_string());
                    let id_token = format!("h.{payload_b64}.s");
                    Json(serde_json::json!({
                        "access_token": "mock-access-token",
                        "refresh_token": "mock-refresh-token",
                        "expires_in": 3600,
                        "id_token": id_token,
                    }))
                }),
            );
        spawn(app).await
    }

    #[tokio::test]
    async fn complete_via_cookie_jar_succeeds_end_to_end() {
        let target = spawn_mock_mesh("better-auth.session_token=abc").await;
        let jar = CookieJar::new();
        jar.capture(
            "mesh.host",
            std::iter::once("better-auth.session_token=abc; Path=/; HttpOnly"),
        );

        let http = bridge_http_client();
        let session = complete_via_cookie_jar(&http, &target, "mesh.host", &jar)
            .await
            .expect("bridge should succeed against a well-behaved mock upstream");

        assert_eq!(session.access_token, "mock-access-token");
        assert_eq!(session.refresh_token.as_deref(), Some("mock-refresh-token"));
        assert_eq!(session.user.email.as_deref(), Some("bridge@example.test"));
        assert_eq!(session.client_id, "mock-client-id");
        assert_eq!(
            session.cookie.as_deref(),
            Some("better-auth.session_token=abc"),
            "the cookie that authenticated this bridge must ride along on the returned session \
             so it can be persisted for the app's lifetime, not discarded"
        );
        // The jar itself is untouched by this function — purging is the
        // caller's (`UpstreamSession::complete_session`) responsibility.
        assert!(!jar.is_empty("mesh.host"));
    }

    #[tokio::test]
    async fn complete_via_cookie_jar_fails_fast_with_no_captured_cookie() {
        let target = "http://unused.invalid".to_string();
        let jar = CookieJar::new();
        let http = bridge_http_client();

        let err = complete_via_cookie_jar(&http, &target, "mesh.host", &jar)
            .await
            .unwrap_err();
        assert!(matches!(err, BridgeError::NoSessionCookie));
    }

    #[tokio::test]
    async fn complete_via_cookie_jar_propagates_an_unauthenticated_authorize_rejection() {
        // The mock only accepts a SPECIFIC cookie value; seed the jar with a
        // different one to exercise the "session cookie the mock doesn't
        // recognize" path (analogous to an expired/invalidated cookie).
        let target = spawn_mock_mesh("better-auth.session_token=expected").await;
        let jar = CookieJar::new();
        jar.capture(
            "mesh.host",
            std::iter::once("better-auth.session_token=stale"),
        );

        let http = bridge_http_client();
        let err = complete_via_cookie_jar(&http, &target, "mesh.host", &jar)
            .await
            .unwrap_err();
        assert!(matches!(
            err,
            BridgeError::UnexpectedAuthorizeStatus(401, _)
        ));
    }
}
