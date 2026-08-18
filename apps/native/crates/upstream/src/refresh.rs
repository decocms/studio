//! Access-token refresh + single-flight coordination.
//!
//! Port of `apps/api/src/cli/lib/refresh-session.ts` /
//! `get-valid-session.ts`'s expiry-skew + refresh-on-demand logic, plus a
//! single-flight guard neither TS file needs (the CLI is a one-shot
//! process; `local-api` is a long-lived server that can receive several
//! concurrent app-API requests whose access token has simultaneously
//! expired — without single-flighting, each would independently spend the
//! session's refresh token, and every `refresh_token` rotation in the
//! response body except the LAST writer's would silently strand the
//! others' in-flight requests on a token the server already superseded).

use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use tokio::sync::Mutex;

use crate::tokens::{StoredSession, TokenStore, TokenStoreError};

/// Treat an access token as expired this many seconds before its declared
/// expiry, to avoid a request racing the exact expiry instant — byte-value
/// port of `get-valid-session.ts`'s `EXPIRY_SKEW_SECONDS`.
pub const EXPIRY_SKEW: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RefreshErrorKind {
    /// No stored session for this host at all — never logged in, or
    /// already signed out.
    NoSession,
    /// The refresh token is missing, or the server rejected it (4xx) —
    /// this session is dead; the caller should treat it as signed-out.
    InvalidGrant,
    /// Network failure or a 5xx from the token endpoint, or a local
    /// storage failure — transient; the caller should NOT sign the user
    /// out over this, just surface/report and let a later attempt retry.
    Transient,
}

#[derive(Debug, Clone)]
pub struct RefreshError {
    pub kind: RefreshErrorKind,
    pub message: String,
}

impl RefreshError {
    pub(crate) fn no_session() -> Self {
        Self {
            kind: RefreshErrorKind::NoSession,
            message: "no upstream session for this host".to_string(),
        }
    }

    fn invalid_grant(message: impl Into<String>) -> Self {
        Self {
            kind: RefreshErrorKind::InvalidGrant,
            message: message.into(),
        }
    }

    fn transient(message: impl Into<String>) -> Self {
        Self {
            kind: RefreshErrorKind::Transient,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for RefreshError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}: {}", self.kind, self.message)
    }
}

impl std::error::Error for RefreshError {}

impl From<TokenStoreError> for RefreshError {
    fn from(err: TokenStoreError) -> Self {
        RefreshError::transient(err.to_string())
    }
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: Option<i64>,
}

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn is_expired(session: &StoredSession, skew: Duration) -> bool {
    match session.expires_at {
        None => false,
        Some(exp) => exp - skew.as_secs() as i64 <= now_unix(),
    }
}

/// `POST {target}/api/auth/mcp/token` with `grant_type=refresh_token` —
/// byte-parity request shape with `refresh-session.ts::refreshSession`.
async fn refresh_access_token(
    http: &reqwest::Client,
    session: &StoredSession,
) -> Result<TokenResponse, RefreshError> {
    let Some(refresh_token) = session.refresh_token.as_deref() else {
        return Err(RefreshError::invalid_grant("session has no refresh token"));
    };

    let res = http
        .post(format!("{}/api/auth/mcp/token", session.target))
        .form(&[
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token),
            ("client_id", session.client_id.as_str()),
        ])
        .send()
        .await
        .map_err(|e| RefreshError::transient(e.to_string()))?;

    let status = res.status();
    if !status.is_success() {
        let text = res.text().await.unwrap_or_default();
        // 429 is throttling, not a rejected token — never mark it
        // invalid_grant. Byte-parity with `refresh-session.ts`.
        if status.is_client_error() && status.as_u16() != 429 {
            return Err(RefreshError::invalid_grant(format!("HTTP {status} {text}")));
        }
        return Err(RefreshError::transient(format!("HTTP {status} {text}")));
    }

    res.json::<TokenResponse>()
        .await
        .map_err(|e| RefreshError::transient(format!("malformed token response: {e}")))
}

/// Single-flight refresh coordinator, one per [`crate::session::UpstreamSession`].
/// Concurrent callers for the same host collapse into ONE network refresh
/// via a mutex + "did someone already win this race" double-check keyed on
/// the observed `access_token` value (not on expiry — see `do_refresh`'s
/// doc comment for why expiry is the wrong signal to double-check against).
pub struct RefreshCoordinator {
    lock: Arc<Mutex<()>>,
}

impl RefreshCoordinator {
    pub fn new() -> Self {
        Self {
            lock: Arc::new(Mutex::new(())),
        }
    }

    /// Returns a session with a non-expired access token, refreshing only
    /// if needed (cheap `is_expired` check, no lock acquired when the
    /// cached token is still good — the overwhelmingly common case on a
    /// per-request hot path).
    pub async fn ensure_fresh(
        &self,
        http: &reqwest::Client,
        store: &dyn TokenStore,
        host: &str,
    ) -> Result<StoredSession, RefreshError> {
        let Some(current) = store.load(host).await? else {
            return Err(RefreshError::no_session());
        };
        self.ensure_fresh_observed(http, store, host, current).await
    }

    /// Like [`Self::ensure_fresh`], but starts from the caller's already-loaded
    /// session. `UpstreamSession` keeps a process-local cache specifically so a
    /// normal proxied request does not ask macOS Keychain for the same value
    /// again; only the actual refresh critical section re-reads durable storage
    /// to preserve refresh-token single-flight semantics.
    pub(crate) async fn ensure_fresh_observed(
        &self,
        http: &reqwest::Client,
        store: &dyn TokenStore,
        host: &str,
        current: StoredSession,
    ) -> Result<StoredSession, RefreshError> {
        if !is_expired(&current, EXPIRY_SKEW) {
            return Ok(current);
        }
        self.do_refresh(http, store, host, current).await
    }

    /// Unconditionally refreshes (still single-flighted), for the "upstream
    /// itself just rejected this access token with a 401" case where the
    /// locally-cached expiry can't be trusted (a server-side revocation
    /// invalidates a token before its declared `expires_at`).
    pub async fn force_refresh(
        &self,
        http: &reqwest::Client,
        store: &dyn TokenStore,
        host: &str,
    ) -> Result<StoredSession, RefreshError> {
        let Some(current) = store.load(host).await? else {
            return Err(RefreshError::no_session());
        };
        self.force_refresh_observed(http, store, host, current)
            .await
    }

    /// Like [`Self::force_refresh`], but reuses a session already loaded by the
    /// caller. See [`Self::ensure_fresh_observed`] for why the distinction
    /// matters on the proxy hot path.
    pub(crate) async fn force_refresh_observed(
        &self,
        http: &reqwest::Client,
        store: &dyn TokenStore,
        host: &str,
        current: StoredSession,
    ) -> Result<StoredSession, RefreshError> {
        self.do_refresh(http, store, host, current).await
    }

    /// The single-flight critical section. `observed` is whatever the
    /// caller read from `store` BEFORE acquiring the lock. After
    /// acquiring, we re-read `store` and compare `access_token` identity:
    /// if it changed, a concurrent caller already won this race and
    /// refreshed on our behalf — reuse their result instead of spending
    /// the (now possibly already-rotated) refresh token a second time.
    /// This is deliberately an identity check, not an `is_expired` check —
    /// `force_refresh` calls this with a session `is_expired` would call
    /// "still valid" (that's the whole point of forcing), so re-checking
    /// expiry here would defeat single-flighting for exactly the
    /// 401-triggered path that most needs it.
    async fn do_refresh(
        &self,
        http: &reqwest::Client,
        store: &dyn TokenStore,
        host: &str,
        observed: StoredSession,
    ) -> Result<StoredSession, RefreshError> {
        let _guard = self.lock.lock().await;
        if let Ok(Some(latest)) = store.load(host).await {
            if latest.access_token != observed.access_token {
                return Ok(latest);
            }
        }

        let token = refresh_access_token(http, &observed).await?;
        let updated = StoredSession {
            access_token: token.access_token,
            refresh_token: token.refresh_token.or(observed.refresh_token),
            expires_at: token
                .expires_in
                .map(|s| now_unix() + s)
                .or(observed.expires_at),
            ..observed
        };
        store.save(host, updated.clone()).await?;
        Ok(updated)
    }
}

impl Default for RefreshCoordinator {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tokens::{test_support::MemoryTokenStore, UserInfo};
    use axum::{extract::State, routing::post, Json, Router};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::net::TcpListener;

    fn expired_session(target: &str, access_token: &str) -> StoredSession {
        StoredSession {
            target: target.to_string(),
            client_id: "client_1".to_string(),
            user: UserInfo {
                sub: "user_1".to_string(),
                email: None,
                name: None,
            },
            access_token: access_token.to_string(),
            refresh_token: Some("refresh-1".to_string()),
            expires_at: Some(0), // already expired
            created_at: "2026-01-01T00:00:00Z".to_string(),
            cookie: None,
        }
    }

    /// Spawns a fake `/api/auth/mcp/token` refresh endpoint that counts
    /// calls and returns a fresh, unique access token each time it's hit —
    /// the "mock upstream via a local axum test server" the brief asks
    /// for.
    async fn spawn_mock_token_server() -> (String, Arc<AtomicUsize>) {
        let calls = Arc::new(AtomicUsize::new(0));
        let app = Router::new()
            .route(
                "/api/auth/mcp/token",
                post(
                    move |State(calls): State<Arc<AtomicUsize>>, _body: axum::body::Bytes| {
                        let n = calls.fetch_add(1, Ordering::SeqCst) + 1;
                        async move {
                            Json(serde_json::json!({
                                "access_token": format!("refreshed-{n}"),
                                "refresh_token": format!("refresh-{n}"),
                                "expires_in": 3600,
                            }))
                        }
                    },
                ),
            )
            .with_state(calls.clone());
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        (format!("http://{addr}"), calls)
    }

    #[tokio::test]
    async fn ensure_fresh_returns_cached_session_when_not_expired() {
        let store = MemoryTokenStore::new();
        let mut session = expired_session("http://example.invalid", "still-good");
        session.expires_at = Some(now_unix() + 3600);
        store.save("host", session.clone()).await.unwrap();

        let coordinator = RefreshCoordinator::new();
        let http = reqwest::Client::new();
        let out = coordinator
            .ensure_fresh(&http, &store, "host")
            .await
            .unwrap();
        assert_eq!(out.access_token, "still-good");
    }

    #[tokio::test]
    async fn ensure_fresh_refreshes_an_expired_session() {
        let (target, calls) = spawn_mock_token_server().await;
        let store = MemoryTokenStore::new();
        store
            .save("host", expired_session(&target, "old"))
            .await
            .unwrap();

        let coordinator = RefreshCoordinator::new();
        let http = reqwest::Client::new();
        let out = coordinator
            .ensure_fresh(&http, &store, "host")
            .await
            .unwrap();

        assert_eq!(out.access_token, "refreshed-1");
        assert_eq!(out.refresh_token.as_deref(), Some("refresh-1"));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        // Persisted back to the store.
        let reloaded = store.load("host").await.unwrap().unwrap();
        assert_eq!(reloaded.access_token, "refreshed-1");
    }

    #[tokio::test]
    async fn concurrent_ensure_fresh_calls_single_flight_into_one_refresh() {
        let (target, calls) = spawn_mock_token_server().await;
        let store = Arc::new(MemoryTokenStore::new());
        store
            .save("host", expired_session(&target, "old"))
            .await
            .unwrap();

        let coordinator = Arc::new(RefreshCoordinator::new());
        let http = Arc::new(reqwest::Client::new());

        let mut handles = Vec::new();
        for _ in 0..8 {
            let coordinator = coordinator.clone();
            let http = http.clone();
            let store = store.clone();
            handles.push(tokio::spawn(async move {
                coordinator
                    .ensure_fresh(&http, store.as_ref(), "host")
                    .await
            }));
        }

        let mut tokens = Vec::new();
        for h in handles {
            tokens.push(h.await.unwrap().unwrap().access_token);
        }

        assert_eq!(
            calls.load(Ordering::SeqCst),
            1,
            "8 concurrent expired-token callers must collapse into exactly 1 network refresh"
        );
        assert!(
            tokens.iter().all(|t| t == "refreshed-1"),
            "every caller must observe the SAME refreshed token, not a partial/racy one: {tokens:?}"
        );
    }

    #[tokio::test]
    async fn concurrent_force_refresh_calls_single_flight_too() {
        // `force_refresh` bypasses the expiry check entirely (the 401-retry
        // path) — the single-flight guard must still collapse concurrent
        // callers, since this is exactly the shape multiple simultaneous
        // app-API requests hitting a server-side-revoked token
        // produce.
        let (target, calls) = spawn_mock_token_server().await;
        let store = Arc::new(MemoryTokenStore::new());
        let mut session = expired_session(&target, "old");
        session.expires_at = Some(now_unix() + 3600); // NOT locally expired
        store.save("host", session).await.unwrap();

        let coordinator = Arc::new(RefreshCoordinator::new());
        let http = Arc::new(reqwest::Client::new());

        let mut handles = Vec::new();
        for _ in 0..5 {
            let coordinator = coordinator.clone();
            let http = http.clone();
            let store = store.clone();
            handles.push(tokio::spawn(async move {
                coordinator
                    .force_refresh(&http, store.as_ref(), "host")
                    .await
            }));
        }
        for h in handles {
            assert_eq!(h.await.unwrap().unwrap().access_token, "refreshed-1");
        }
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn no_refresh_token_is_invalid_grant() {
        let store = MemoryTokenStore::new();
        let mut session = expired_session("http://example.invalid", "old");
        session.refresh_token = None;
        store.save("host", session).await.unwrap();

        let coordinator = RefreshCoordinator::new();
        let http = reqwest::Client::new();
        let err = coordinator
            .ensure_fresh(&http, &store, "host")
            .await
            .unwrap_err();
        assert_eq!(err.kind, RefreshErrorKind::InvalidGrant);
    }

    #[tokio::test]
    async fn missing_session_is_no_session_error() {
        let store = MemoryTokenStore::new();
        let coordinator = RefreshCoordinator::new();
        let http = reqwest::Client::new();
        let err = coordinator
            .ensure_fresh(&http, &store, "host")
            .await
            .unwrap_err();
        assert_eq!(err.kind, RefreshErrorKind::NoSession);
    }

    #[tokio::test]
    async fn rejected_refresh_token_is_invalid_grant() {
        let app = Router::new().route(
            "/api/auth/mcp/token",
            post(|| async {
                (
                    axum::http::StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({"error": "invalid_grant"})),
                )
            }),
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        let store = MemoryTokenStore::new();
        store
            .save("host", expired_session(&format!("http://{addr}"), "old"))
            .await
            .unwrap();

        let coordinator = RefreshCoordinator::new();
        let http = reqwest::Client::new();
        let err = coordinator
            .ensure_fresh(&http, &store, "host")
            .await
            .unwrap_err();
        assert_eq!(err.kind, RefreshErrorKind::InvalidGrant);
    }

    #[tokio::test]
    async fn rate_limited_refresh_is_transient_not_invalid_grant() {
        // A 429 means the token endpoint is throttling us, not that the
        // refresh token itself was rejected — treating it as invalid_grant
        // would hard-sign-out a user for asking too fast.
        let app = Router::new().route(
            "/api/auth/mcp/token",
            post(|| async {
                (
                    axum::http::StatusCode::TOO_MANY_REQUESTS,
                    Json(serde_json::json!({"error": "rate_limited"})),
                )
            }),
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        let store = MemoryTokenStore::new();
        store
            .save("host", expired_session(&format!("http://{addr}"), "old"))
            .await
            .unwrap();

        let coordinator = RefreshCoordinator::new();
        let http = reqwest::Client::new();
        let err = coordinator
            .ensure_fresh(&http, &store, "host")
            .await
            .unwrap_err();
        assert_eq!(err.kind, RefreshErrorKind::Transient);
    }

    #[tokio::test]
    async fn network_failure_is_transient_not_invalid_grant() {
        let store = MemoryTokenStore::new();
        // Reserve then immediately drop a port so nothing listens there —
        // guarantees a fast "connection refused" rather than a firewall
        // black-hole timeout.
        let dead_port = {
            let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
            l.local_addr().unwrap().port()
        };
        store
            .save(
                "host",
                expired_session(&format!("http://127.0.0.1:{dead_port}"), "old"),
            )
            .await
            .unwrap();

        let coordinator = RefreshCoordinator::new();
        let http = reqwest::Client::new();
        let err = coordinator
            .ensure_fresh(&http, &store, "host")
            .await
            .unwrap_err();
        assert_eq!(err.kind, RefreshErrorKind::Transient);
    }
}
