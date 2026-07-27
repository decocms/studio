//! `UpstreamSession` — the public API this crate exposes to everything
//! else: the shell's future Tauri IPC commands (`local_api_info`-adjacent
//! `auth_status`/`auth_login`/`auth_logout`, per the shared boot contract
//! in this task's brief) AND `routes/upstream.rs`'s proxy handler, both
//! calling into the SAME process-wide instance via [`global`] so they can
//! never observe a different sign-in state than one another.
//!
//! `status()`/`login()`/`logout()` map directly onto the three IPC
//! commands the brief specifies:
//!   - `auth_status()` -> [`UpstreamSession::status`]
//!   - `auth_login()` -> [`UpstreamSession::login`]
//!   - `auth_logout()` -> [`UpstreamSession::logout`]
//!
//! This module intentionally has ZERO Tauri dependency — it's plain async
//! Rust, callable from the standalone `local-api` binary (no Tauri context
//! at all, e.g. under `apps/native/e2e`) exactly the same way the shell
//! would call it.
//!
//! ## One credential, forwarded everywhere — no bespoke org logic
//!
//! This crate holds exactly ONE upstream session credential per signed-in
//! user: a Better Auth session COOKIE, durable for the app's lifetime (see
//! [`Self::cookie_header`]'s doc comment) — obtained via ONE of two
//! mechanisms depending on login path: captured directly during the
//! embedded email/password/OTP login (`crates/upstream/src/bridge.rs`), or,
//! for the system-browser Google/GitHub/SAML path (`login.rs`), minted
//! server-side by exchanging the OAuth bearer that flow always ends up with
//! via the mesh-side session bridge
//! (`login.rs::mint_session_from_access_token`,
//! `POST /api/auth/desktop/session-from-oauth`). Either way, this crate does
//! no org discovery, no org-slug caching, and mints no secondary credential:
//! the real production shell (`apps/web/src`) is what the desktop app
//! renders after sign-in, and its OWN `organization.list`/last-visited-org
//! logic and org-creation flow handle everything about which org is active.
//! See the native authentication contract for the empirical
//! auth-surface investigation this design is built on, including the
//! now-RESOLVED history of why a bearer-only system-browser session could
//! not satisfy the real shell's native sign-in gate (enabling Better Auth's
//! `bearer()` plugin mesh-side did NOT fix it — a different credential-type
//! problem, not a missing plugin — and why a genuine mesh-side
//! bearer-to-session bridge was the actual fix).

use std::sync::{Arc, OnceLock, RwLock};
use std::time::{Duration, Instant};

use tokio::sync::watch;

use crate::bridge::{self, BridgeError};
use crate::cookie_jar::CookieJar;
use crate::login::{self, LoginError};
use crate::refresh::{RefreshCoordinator, RefreshError, RefreshErrorKind};
use crate::tokens::{
    host_key, InMemoryTokenStore, KeychainTokenStore, StoredSession, TokenStore, TokenStoreError,
};

/// `GET /api/links/me` (see `apps/api/src/api/app.ts`) is the cheapest
/// authenticated endpoint this crate found in the mesh API: dual-auth
/// (Bearer OR cookie), always returns `200` (even `null`) for a VALID
/// bearer regardless of link/presence state, and `401
/// {"error":"unauthorized"}` specifically when bearer resolution fails —
/// i.e. it's a pure auth probe, no org/permission semantics riding along
/// (unlike an org-scoped `/api/:org/...` route, which can legitimately
/// `403` an authenticated-but-non-member caller — see `probe_upstream`'s
/// doc comment for why that distinction matters).
const PROBE_PATH: &str = "/api/links/me";

/// "at most once per 5 min" — the contract doc's exact throttle window for
/// `status()`'s network revalidation.
pub const STATUS_CACHE_TTL: Duration = Duration::from_secs(5 * 60);

/// Default per-request timeout for every HTTP call this session's
/// `reqwest::Client` makes (register, token exchange, refresh, the
/// `/api/links/me` probe) — `reqwest::Client::new()` has NO default
/// timeout at all, so a DNS stall or a connection that never completes
/// would otherwise hang the calling future forever. Generous enough for a
/// slow-but-working network, bounded enough that `status()`/`login()`/
/// `access_token()` can never wedge a caller indefinitely. `logout()`'s
/// best-effort revoke additionally wraps its own call in a tighter
/// `REVOKE_TIMEOUT` (see that constant) since it's a fire-and-forget
/// courtesy call, not a request anything is blocked waiting on.
const DEFAULT_HTTP_TIMEOUT: Duration = Duration::from_secs(15);

fn default_http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(DEFAULT_HTTP_TIMEOUT)
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthStorageState {
    Available,
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StatusResult {
    pub signed_in: bool,
    pub user_label: Option<String>,
    pub upstream_url: String,
    /// Distinguishes a genuine empty Keychain entry from a read failure. A
    /// storage outage is not evidence that the user signed out.
    pub storage_state: AuthStorageState,
}

#[derive(Debug, thiserror::Error)]
pub enum SessionError {
    #[error(transparent)]
    Login(#[from] LoginError),
    #[error(transparent)]
    Store(#[from] TokenStoreError),
    #[error(transparent)]
    Bridge(#[from] BridgeError),
    #[error(transparent)]
    Refresh(#[from] RefreshError),
}

struct StatusCache {
    checked_at: Instant,
    signed_in: bool,
}

struct Inner {
    target: String,
    host: String,
    http: reqwest::Client,
    /// Redirect-following DISABLED — see `bridge.rs`'s
    /// `bridge_http_client()` doc comment. Built once and reused (not
    /// per-call) so `complete_session()` doesn't pay client-construction
    /// cost on every bridge attempt.
    http_no_redirect: reqwest::Client,
    store: Arc<dyn TokenStore>,
    coordinator: RefreshCoordinator,
    /// In-memory, per-host `Set-Cookie` capture for the hybrid-login
    /// bridge — see `cookie_jar.rs`'s module doc. Populated by
    /// `crates/local-api/src/routes/upstream.rs`'s `/api/auth/*` proxy
    /// branch (which calls `cookie_jar()` on this SAME process-wide
    /// singleton), consumed and unconditionally purged by
    /// `complete_session()` below, and purged again (idempotent) on
    /// `logout()`/`hard_sign_out()`.
    cookie_jar: CookieJar,
    status_cache: RwLock<Option<StatusCache>>,
    /// In-process copy of the stored session. The OS Keychain read behind
    /// `TokenStore::load` can block on an interactive ACL prompt for up to
    /// KEYCHAIN_LOAD_TIMEOUT — and load() used to hit the Keychain on EVERY
    /// auth-path proxy request, so a burst of shell calls (get-session,
    /// organization.list, ...) queued a prompt STORM that saturated the
    /// webview's connection pool (observed live 2026-07-22). The Keychain is
    /// the durable copy only: first successful load fills this cache
    /// (single-flighted via `session_load_lock`), save/clear refresh it,
    /// and every other read is memory-only.
    session_cache: RwLock<Option<Option<StoredSession>>>,
    session_load_lock: tokio::sync::Mutex<()>,
    watch_tx: watch::Sender<StatusResult>,
}

/// Cheap to clone (one `Arc` bump) — every call site (IPC commands, the
/// proxy handler, the background revalidation task) holds its own handle
/// to the same underlying state.
#[derive(Clone)]
pub struct UpstreamSession(Arc<Inner>);

impl UpstreamSession {
    pub fn new(target: String, store: Arc<dyn TokenStore>) -> Self {
        let target = target.trim_end_matches('/').to_string();
        let host = host_key(&target);
        let (watch_tx, _rx) = watch::channel(StatusResult {
            signed_in: false,
            user_label: None,
            upstream_url: target.clone(),
            storage_state: AuthStorageState::Available,
        });
        Self(Arc::new(Inner {
            target,
            host,
            http: default_http_client(),
            http_no_redirect: bridge::bridge_http_client(),
            store,
            coordinator: RefreshCoordinator::new(),
            cookie_jar: CookieJar::new(),
            status_cache: RwLock::new(None),
            session_cache: RwLock::new(None),
            session_load_lock: tokio::sync::Mutex::new(()),
            watch_tx,
        }))
    }

    pub fn target(&self) -> &str {
        &self.0.target
    }

    /// The Keychain/jar scoping key for this session's target — the SAME
    /// value `crates/local-api/src/routes/upstream.rs`'s auth-path branch
    /// must key its `cookie_jar()` calls with (derived via
    /// `tokens::host_key`, never an arbitrary caller-chosen label).
    pub fn host(&self) -> &str {
        &self.0.host
    }

    /// The in-memory `Set-Cookie` jar — see `cookie_jar.rs`'s module doc.
    /// Shared (via this SAME process-wide `UpstreamSession` singleton,
    /// `global()`) between `routes/upstream.rs`'s proxy handler (which
    /// captures/attaches cookies on `/api/auth/*` requests) and
    /// [`Self::complete_session`] (which consumes and purges it).
    pub fn cookie_jar(&self) -> &CookieJar {
        &self.0.cookie_jar
    }

    /// The DURABLE, Keychain-persisted Better Auth session cookie for this
    /// session's host, if one was ever captured — `None` for a
    /// system-browser (`login()`) session, which never has one (see
    /// `tokens.rs`'s `StoredSession::cookie` doc comment), or for a host
    /// with no stored session at all.
    ///
    /// This is what `routes/upstream.rs` attaches (as a plain `Cookie:`
    /// header) on EVERY app-API request for the rest of this
    /// session's life — not just the ephemeral in-memory
    /// [`Self::cookie_jar`], which exists only to ferry a freshly-captured
    /// cookie through the ONE `complete_session()` bridge call before being
    /// purged. Real-UI course-correction: the production web shell's own
    /// sign-in gate and org switcher hit Better Auth's native `/api/auth/*`
    /// endpoints, which only recognize a session cookie — see
    /// `crates/upstream/src/bridge.rs`'s module doc for the empirical
    /// finding that drove this.
    pub async fn cookie_header(&self) -> Option<String> {
        self.load().await.and_then(|s| s.cookie)
    }

    /// The signed-in user's OAuth `sub` claim (`StoredSession.user.sub`),
    /// if a session is stored for this host — `None` when signed out.
    /// Real-UI course-correction: `routes/intercept/thread_tools.rs` uses
    /// this to attribute locally-created threads (`created_by`) to the
    /// ACTUAL signed-in user rather than an opaque placeholder, since the
    /// production shell's own chat input gates on
    /// `task.created_by === userId` (`components/chat/input.tsx`) — a
    /// mismatch there permanently renders every locally-created thread
    /// read-only ("viewing someone else's chat"), which is what a
    /// placeholder value did before this method existed.
    pub async fn current_user_sub(&self) -> Option<String> {
        self.load().await.map(|s| s.user.sub)
    }

    /// The signed-in user's OAuth `sub`, preserving token-store failures.
    ///
    /// Local-api uses this form when selecting the account-scoped native
    /// SQLite namespace. Collapsing a transient Keychain/helper failure into
    /// `None` would misreport an authenticated local request as signed out.
    pub async fn current_user_sub_result(
        &self,
    ) -> Result<Option<String>, crate::tokens::TokenStoreError> {
        Ok(self.load_result().await?.map(|session| session.user.sub))
    }

    /// Best-effort: if this host already has a persisted OAuth session,
    /// refreshes its stored cookie to `header_value` (e.g. a rotated
    /// `Set-Cookie` Better Auth issued on a LATER `/api/auth/*` call, after
    /// the initial `complete_session()` bridge already ran) and re-saves it
    /// — keeping the durable, attached-on-every-call cookie
    /// ([`Self::cookie_header`]) from silently going stale across the
    /// session's lifetime. A no-op (never creates a session, never errors
    /// the caller) when there is no OAuth session yet for this host — that
    /// case is `complete_session()`'s job, not this one's; called from
    /// `routes/upstream.rs::proxy_auth_path` immediately after it captures
    /// a fresh `Set-Cookie` into the ephemeral jar.
    pub async fn remember_cookie(&self, header_value: &str) {
        let Some(mut stored) = self.load().await else {
            return;
        };
        if stored.cookie.as_deref() == Some(header_value) {
            return; // unchanged — avoid a pointless Keychain write
        }
        stored.cookie = Some(header_value.to_string());
        match self.0.store.save(&self.0.host, stored.clone()).await {
            Ok(()) => self.cache_session(Some(stored)),
            Err(err) => {
                tracing::warn!(error = %err, "failed to persist a refreshed upstream session cookie");
            }
        }
    }

    /// Subscribe to status changes. The Tauri shell bridges this receiver
    /// into its JS-visible auth event, and [`crate::revalidate`] publishes
    /// hard sign-outs through the same channel.
    pub fn subscribe(&self) -> watch::Receiver<StatusResult> {
        self.0.watch_tx.subscribe()
    }

    /// `auth_status()`. Re-validates against upstream at most once per
    /// [`STATUS_CACHE_TTL`]; every call inside that window returns the
    /// cached verdict without a network round trip.
    pub async fn status(&self) -> StatusResult {
        let session = match self.load_result().await {
            Ok(Some(session)) => session,
            Ok(None) => {
                self.mark_validated(false);
                return self.signed_out();
            }
            Err(error) => {
                tracing::warn!(error = %error, "session storage unavailable during auth status");
                return self.publish_storage_unavailable();
            }
        };
        if self.recently_validated() {
            return StatusResult {
                signed_in: true,
                user_label: label(&session),
                upstream_url: self.0.target.clone(),
                storage_state: AuthStorageState::Available,
            };
        }
        self.force_revalidate().await
    }

    /// Bypasses the [`STATUS_CACHE_TTL`] throttle — used by `status()` on a
    /// cold/expired cache and by [`crate::revalidate`]'s periodic
    /// background task.
    pub async fn force_revalidate(&self) -> StatusResult {
        let session = match self.load_result().await {
            Ok(Some(session)) => session,
            Ok(None) => {
                self.mark_validated(false);
                return self.signed_out();
            }
            Err(error) => {
                tracing::warn!(error = %error, "session storage unavailable during auth revalidation");
                return self.publish_storage_unavailable();
            }
        };

        match self.ensure_fresh_session(session.clone()).await {
            Ok(fresh) => match self.probe_upstream(&fresh.access_token).await {
                ProbeOutcome::Authenticated => self.publish_signed_in(&fresh),
                ProbeOutcome::Unauthenticated => {
                    match self.force_refresh_session(fresh.clone()).await {
                        Ok(refreshed) => match self.probe_upstream(&refreshed.access_token).await {
                            ProbeOutcome::Authenticated => self.publish_signed_in(&refreshed),
                            ProbeOutcome::Unauthenticated => {
                                self.hard_sign_out(
                                    "upstream rejected an access token after a forced refresh",
                                )
                                .await
                            }
                            ProbeOutcome::Inconclusive(reason) => {
                                tracing::debug!(
                                reason,
                                "upstream status probe after refresh inconclusive; keeping signed-in state"
                            );
                                self.mark_validated(true);
                                StatusResult {
                                    signed_in: true,
                                    user_label: label(&refreshed),
                                    upstream_url: self.0.target.clone(),
                                    storage_state: AuthStorageState::Available,
                                }
                            }
                        },
                        Err(RefreshError {
                            kind: RefreshErrorKind::InvalidGrant,
                            ..
                        }) => {
                            self.hard_sign_out("refresh token was rejected after a 401")
                                .await
                        }
                        Err(RefreshError {
                            kind: RefreshErrorKind::NoSession,
                            ..
                        }) => {
                            self.mark_validated(false);
                            self.signed_out()
                        }
                        Err(RefreshError {
                            kind: RefreshErrorKind::Transient,
                            message,
                        }) => {
                            tracing::debug!(error = %message, "forced token refresh failed transiently after a 401; preserving the stored session");
                            self.mark_validated(true);
                            StatusResult {
                                signed_in: true,
                                user_label: label(&fresh),
                                upstream_url: self.0.target.clone(),
                                storage_state: AuthStorageState::Available,
                            }
                        }
                    }
                }
                ProbeOutcome::Inconclusive(reason) => {
                    // Fail OPEN on a transient probe failure — mirrors
                    // `/api/links/me`'s own "presence is best-effort" fail-
                    // open posture (`apps/api/src/api/app.ts`) and this
                    // repo's general rule that a network hiccup must never
                    // read as "sign the user out."
                    tracing::debug!(
                        reason,
                        "upstream status probe inconclusive; keeping prior signed-in state"
                    );
                    self.mark_validated(true);
                    StatusResult {
                        signed_in: true,
                        user_label: label(&fresh),
                        upstream_url: self.0.target.clone(),
                        storage_state: AuthStorageState::Available,
                    }
                }
            },
            Err(RefreshError {
                kind: RefreshErrorKind::InvalidGrant,
                ..
            }) => self.hard_sign_out("refresh token was rejected").await,
            Err(RefreshError {
                kind: RefreshErrorKind::NoSession,
                ..
            }) => {
                self.mark_validated(false);
                self.signed_out()
            }
            Err(RefreshError {
                kind: RefreshErrorKind::Transient,
                message,
            }) => {
                tracing::debug!(error = %message, "token refresh transient failure during revalidation; keeping prior signed-in state");
                self.mark_validated(true);
                StatusResult {
                    signed_in: true,
                    user_label: label(&session),
                    upstream_url: self.0.target.clone(),
                    storage_state: AuthStorageState::Available,
                }
            }
        }
    }

    /// `auth_login()`. Runs the interactive PKCE loopback flow, persists
    /// the resulting session, and reports it signed in. This login path now
    /// also carries a real Better Auth session cookie (see `tokens.rs`'s
    /// `StoredSession::cookie` doc comment) — minted server-side via the
    /// mesh session bridge inside `login::perform_interactive_login` itself,
    /// so by the time it returns here the cookie is already part of the
    /// `StoredSession` this method persists. The app hands off to the real
    /// production shell exactly the same as the cookie-relay path either
    /// way; the shell's own `organization.list`/last-visited-org logic and
    /// org-creation flow take it from there, with no client-side org logic
    /// in this crate.
    pub async fn login(&self) -> Result<StatusResult, SessionError> {
        let stored = login::perform_interactive_login(
            &self.0.http,
            &self.0.target,
            login::open_system_browser,
        )
        .await?;
        self.0.store.save(&self.0.host, stored.clone()).await?;
        self.cache_session(Some(stored.clone()));
        Ok(self.publish_signed_in(&stored))
    }

    /// `auth_logout()`. Best-effort upstream revoke THEN Keychain clear, in
    /// that order (per the brief) — a revoke failure never blocks the
    /// local clear, since the whole point of sign-out is that this app
    /// stops holding usable credentials regardless of whether the server
    /// acknowledges the revoke. A failed Keychain clear keeps the current
    /// session visible so the UI cannot claim a logout that would be undone
    /// by the next process restart. `store.clear()` removes the WHOLE
    /// [`crate::tokens::StoredSession`] record — OAuth tokens AND the
    /// durable session cookie ([`Self::cookie_header`]) together, one
    /// Keychain delete, no separate "also forget the cookie" step needed.
    /// Also purges the in-memory cookie jar (see `cookie_jar.rs`'s module
    /// doc) — a signed-out app has no business holding onto an
    /// in-flight-captured Better Auth session cookie either.
    pub async fn logout(&self) -> StatusResult {
        let current = self.load().await;
        if let Some(session) = current.as_ref() {
            revoke_upstream_best_effort(&self.0.http, session).await;
        }
        if let Err(err) = self.0.store.clear(&self.0.host).await {
            tracing::warn!(error = %err, "failed to clear upstream Keychain entry on logout");
            self.0.cookie_jar.clear(&self.0.host);
            if let Some(session) = current {
                return self.publish_signed_in(&session);
            }
        } else {
            self.cache_session(None);
        }
        self.0.cookie_jar.clear(&self.0.host);
        self.mark_validated(false);
        let result = self.signed_out();
        self.publish(result.clone());
        result
    }

    /// Called on a hard, refresh-surviving auth failure — clears local
    /// credentials so subsequent calls fail fast (`NoSession`) instead of
    /// repeating a doomed refresh, and publishes the transition so a
    /// subscribed shell can react. Distinct from `logout()`: no upstream
    /// revoke attempt (the token is already known-bad server-side; nothing
    /// to revoke). Also purges the cookie jar, for the same reason
    /// `logout()` does.
    pub async fn hard_sign_out(&self, reason: &str) -> StatusResult {
        tracing::warn!(reason, target = %self.0.target, "upstream session invalidated — clearing local credentials");
        if let Err(err) = self.0.store.clear(&self.0.host).await {
            tracing::warn!(error = %err, "failed to clear upstream Keychain entry during hard sign-out");
        } else {
            self.cache_session(None);
        }
        self.0.cookie_jar.clear(&self.0.host);
        self.mark_validated(false);
        let result = self.signed_out();
        self.publish(result.clone());
        result
    }

    /// `auth_complete_session()` — the hybrid-login bridge (see
    /// `bridge.rs`'s module doc). Requires the desktop-embedded login
    /// screen to have ALREADY driven a cookie-authenticated Better Auth
    /// session into [`Self::cookie_jar`] via
    /// `crates/local-api/src/routes/upstream.rs`'s `/api/auth/*` proxy
    /// branch — [`BridgeError::NoSessionCookie`] (surfaced here as
    /// [`SessionError::Bridge`]) otherwise.
    ///
    /// The [`crate::tokens::StoredSession`] `bridge::complete_via_cookie_jar`
    /// returns on success already carries that SAME cookie in its `cookie`
    /// field (see `bridge.rs`'s module doc for why it's no longer a
    /// one-shot credential) — `store.save` below persists it to the
    /// Keychain right alongside the OAuth tokens, durable for the rest of
    /// this session's life; no separate persistence step needed here.
    ///
    /// Purges the EPHEMERAL in-memory jar UNCONDITIONALLY once the bridge
    /// attempt concludes — success OR failure. On success the jar's job is
    /// done (its value has already been copied into the persisted,
    /// long-lived `StoredSession.cookie` — see [`Self::cookie_header`]). On
    /// failure, the captured cookie could be stale in a way
    /// that caused the failure in the first place (e.g. the session
    /// expired between capture and this call), or the bridge's own OAuth
    /// dance failed for a reason unrelated to the cookie's validity —
    /// either way, silently retrying with the SAME possibly-bad cookie
    /// forever is worse than requiring the login screen to re-establish a
    /// fresh session (a cheap, fast local operation) before the next
    /// attempt. This mirrors `logout()`/`hard_sign_out()`'s own
    /// unconditional-clear posture: this crate treats "purge on any
    /// terminal outcome" as the safer default throughout, never "keep
    /// retrying with stale credentials."
    pub async fn complete_session(&self) -> Result<StatusResult, SessionError> {
        let outcome = bridge::complete_via_cookie_jar(
            &self.0.http_no_redirect,
            &self.0.target,
            &self.0.host,
            &self.0.cookie_jar,
        )
        .await;
        self.0.cookie_jar.clear(&self.0.host);

        let stored = outcome?;
        self.0.store.save(&self.0.host, stored.clone()).await?;
        self.cache_session(Some(stored.clone()));
        Ok(self.publish_signed_in(&stored))
    }

    /// The access token `routes/upstream.rs` attaches to a forwarded
    /// request — transparently refreshes if the locally-cached token has
    /// expired.
    pub async fn access_token(&self) -> Result<String, RefreshError> {
        let Some(observed) = self.load().await else {
            return Err(RefreshError::no_session());
        };
        self.ensure_fresh_session(observed)
            .await
            .map(|session| session.access_token)
    }

    /// Shared `mark_validated(true)` + publish for every "report
    /// signed_in: true" call site (`login`, `complete_session`,
    /// `force_revalidate`'s authenticated branch).
    fn publish_signed_in(&self, stored: &StoredSession) -> StatusResult {
        self.mark_validated(true);
        let result = StatusResult {
            signed_in: true,
            user_label: label(stored),
            upstream_url: self.0.target.clone(),
            storage_state: AuthStorageState::Available,
        };
        self.publish(result.clone());
        result
    }

    /// Unconditional refresh for the proxy's "upstream itself just 401'd
    /// this token" retry-once path — see `routes/upstream.rs`.
    pub async fn force_refresh_access_token(&self) -> Result<String, RefreshError> {
        let Some(observed) = self.load().await else {
            return Err(RefreshError::no_session());
        };
        self.force_refresh_session(observed)
            .await
            .map(|session| session.access_token)
    }

    async fn ensure_fresh_session(
        &self,
        observed: StoredSession,
    ) -> Result<StoredSession, RefreshError> {
        let fresh = self
            .0
            .coordinator
            .ensure_fresh_observed(&self.0.http, self.0.store.as_ref(), &self.0.host, observed)
            .await?;
        self.cache_session(Some(fresh.clone()));
        Ok(fresh)
    }

    async fn force_refresh_session(
        &self,
        observed: StoredSession,
    ) -> Result<StoredSession, RefreshError> {
        let refreshed = self
            .0
            .coordinator
            .force_refresh_observed(&self.0.http, self.0.store.as_ref(), &self.0.host, observed)
            .await?;
        self.cache_session(Some(refreshed.clone()));
        Ok(refreshed)
    }

    async fn load_result(&self) -> Result<Option<StoredSession>, TokenStoreError> {
        if let Some(cached) = self.0.session_cache.read().unwrap().clone() {
            return Ok(cached);
        }
        // Single-flight the cache miss: concurrent callers wait for ONE
        // Keychain read instead of each spawning their own (and their own
        // potential ACL prompt).
        let _guard = self.0.session_load_lock.lock().await;
        if let Some(cached) = self.0.session_cache.read().unwrap().clone() {
            return Ok(cached);
        }
        let loaded = self.0.store.load(&self.0.host).await?;
        *self.0.session_cache.write().unwrap() = Some(loaded.clone());
        Ok(loaded)
    }

    async fn load(&self) -> Option<StoredSession> {
        match self.load_result().await {
            Ok(loaded) => loaded,
            Err(err) => {
                // Non-status callers retain their existing Option-shaped API,
                // but a failure remains uncached so the next call retries.
                // `status()`/`force_revalidate()` use `load_result()` directly
                // and never collapse this into a signed-out verdict.
                tracing::warn!(error = %err, "session load failed; not caching");
                None
            }
        }
    }

    fn cache_session(&self, value: Option<StoredSession>) {
        *self.0.session_cache.write().unwrap() = Some(value);
    }

    fn signed_out(&self) -> StatusResult {
        StatusResult {
            signed_in: false,
            user_label: None,
            upstream_url: self.0.target.clone(),
            storage_state: AuthStorageState::Available,
        }
    }

    fn publish_storage_unavailable(&self) -> StatusResult {
        let result = StatusResult {
            signed_in: false,
            user_label: None,
            upstream_url: self.0.target.clone(),
            storage_state: AuthStorageState::Unavailable,
        };
        self.publish(result.clone());
        result
    }

    fn recently_validated(&self) -> bool {
        self.0
            .status_cache
            .read()
            .unwrap()
            .as_ref()
            .is_some_and(|c| c.signed_in && c.checked_at.elapsed() < STATUS_CACHE_TTL)
    }

    fn mark_validated(&self, signed_in: bool) {
        *self.0.status_cache.write().unwrap() = Some(StatusCache {
            checked_at: Instant::now(),
            signed_in,
        });
    }

    fn publish(&self, result: StatusResult) {
        self.0.watch_tx.send_if_modified(|current| {
            if *current == result {
                false
            } else {
                *current = result;
                true
            }
        });
    }

    /// Probes `PROBE_PATH` with `access_token` — see `PROBE_PATH`'s doc
    /// comment for why this endpoint specifically. Only a genuine `401`
    /// (bearer resolution failure) is treated as "unauthenticated"; every
    /// other non-2xx status or network failure is `Inconclusive` and must
    /// NOT trigger a sign-out (a `5xx`, a timeout, or — on an org-scoped
    /// endpoint, though this one isn't — a `403` for an unrelated
    /// authorization reason are all NOT proof the token itself is bad).
    async fn probe_upstream(&self, access_token: &str) -> ProbeOutcome {
        let res = self
            .0
            .http
            .get(format!("{}{PROBE_PATH}", self.0.target))
            .bearer_auth(access_token)
            .send()
            .await;
        match res {
            Ok(r) if r.status().is_success() => ProbeOutcome::Authenticated,
            Ok(r) if r.status() == reqwest::StatusCode::UNAUTHORIZED => {
                ProbeOutcome::Unauthenticated
            }
            Ok(r) => ProbeOutcome::Inconclusive(format!("HTTP {}", r.status())),
            Err(e) => ProbeOutcome::Inconclusive(e.to_string()),
        }
    }
}

enum ProbeOutcome {
    Authenticated,
    Unauthenticated,
    Inconclusive(String),
}

fn label(session: &StoredSession) -> Option<String> {
    session
        .user
        .email
        .clone()
        .or_else(|| session.user.name.clone())
        .or_else(|| Some(session.user.sub.clone()))
}

/// Bounds how long `logout()` will wait on the best-effort revoke attempt
/// before giving up and moving on to the (unconditional) Keychain clear.
/// "Best-effort" has to mean bounded, not "however long the network takes"
/// — a DNS/connect stall on a route that may 404 anyway must never turn
/// sign-out into a hang. Chosen short: this is a fire-and-forget courtesy
/// call, not a request the user is waiting on a spinner for.
const REVOKE_TIMEOUT: Duration = Duration::from_secs(5);

/// Best-effort: POSTs an RFC 7009-shaped revocation request and swallows
/// every possible failure, INCLUDING "the endpoint doesn't exist" (`404`)
/// and "it never responded in time" (`REVOKE_TIMEOUT`). As of this writing
/// the API server's Better Auth `mcp` plugin (`apps/api/src/auth/index.ts`,
/// `better-auth/plugins/mcp`) only wires `/mcp/register` and `/mcp/token`
/// — no revoke endpoint yet (verified against the installed `better-auth`
/// package's plugin source, which exposes exactly those two
/// `createAuthEndpoint` calls). This function still attempts the
/// conventional `/api/auth/mcp/revoke` path so sign-out starts working the
/// moment the server adds it, with zero client-side changes — that's what
/// "best-effort" buys here, not a currently-working round trip. Tracked as
/// a cross-cutting follow-up for whoever owns the mesh auth server;
/// logout's local effect (Keychain clear) is unconditional and does not
/// depend on this succeeding.
async fn revoke_upstream_best_effort(http: &reqwest::Client, session: &StoredSession) {
    let (token, hint) = match &session.refresh_token {
        Some(rt) => (rt.as_str(), "refresh_token"),
        None => (session.access_token.as_str(), "access_token"),
    };
    let request = http
        .post(format!("{}/api/auth/mcp/revoke", session.target))
        .form(&[
            ("token", token),
            ("token_type_hint", hint),
            ("client_id", session.client_id.as_str()),
        ])
        .send();
    match tokio::time::timeout(REVOKE_TIMEOUT, request).await {
        Ok(Ok(r)) if r.status().is_success() => {
            tracing::debug!("upstream token revoked");
        }
        Ok(Ok(r)) => {
            tracing::debug!(
                status = r.status().as_u16(),
                "upstream revoke declined or not implemented (best-effort, ignoring)"
            );
        }
        Ok(Err(err)) => {
            tracing::debug!(error = %err, "upstream revoke request failed (best-effort, ignoring)");
        }
        Err(_elapsed) => {
            tracing::debug!(timeout = ?REVOKE_TIMEOUT, "upstream revoke request timed out (best-effort, ignoring)");
        }
    }
}

/// `DECOCMS_UPSTREAM_URL`, trimmed of a trailing slash, defaulting to
/// `https://studio.decocms.com` — read once, at first access, per the
/// shared boot contract ("Upstream base URL: env DECOCMS_UPSTREAM_URL at
/// app launch").
/// Production upstream — the shipped default.
pub const PRODUCTION_UPSTREAM: &str = "https://studio.decocms.com";
/// Staging upstream — carries in-flight branch changes ahead of the prod
/// deploy (e.g. the OAuth session bridge, so Google/system-browser login
/// works here before `POST /api/auth/desktop/session-from-oauth` ships to
/// production).
pub const STAGING_UPSTREAM: &str = "https://studio-stg.decocms.com";

/// The upstream the desktop app points at. FLIP THIS single constant
/// between [`PRODUCTION_UPSTREAM`] and [`STAGING_UPSTREAM`] to switch which
/// environment the app talks to (Keychain sessions are keyed per-host, so
/// each environment keeps its own independent login across a switch).
/// `DECOCMS_UPSTREAM_URL` still overrides this at runtime for dev/CI.
const DEFAULT_UPSTREAM: &str = PRODUCTION_UPSTREAM;

fn resolve_target() -> String {
    std::env::var("DECOCMS_UPSTREAM_URL")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_UPSTREAM.to_string())
        .trim_end_matches('/')
        .to_string()
}

/// The process-wide singleton `routes/upstream.rs` and every future Tauri
/// IPC command call into — see this module's doc comment for why a
/// singleton (rather than plumbing a handle through `AppState`, a shared
/// file this crate's owner does not touch) is the deliberate design here.
pub fn global() -> UpstreamSession {
    static SESSION: OnceLock<UpstreamSession> = OnceLock::new();
    SESSION
        .get_or_init(|| {
            // `LOCAL_API_TOKEN_STORE=memory` swaps the Keychain for a
            // process-lifetime in-memory store — for headless drives / CI
            // where an interactive macOS ACL prompt would otherwise wedge
            // sign-in and no persistence-across-restart is wanted. Never set
            // in the shipped app; the default is always the real Keychain.
            let store: Arc<dyn TokenStore> =
                if std::env::var("LOCAL_API_TOKEN_STORE").as_deref() == Ok("memory") {
                    tracing::warn!(
                    "LOCAL_API_TOKEN_STORE=memory: tokens are NOT persisted (test/headless mode)"
                );
                    Arc::new(InMemoryTokenStore::default())
                } else {
                    Arc::new(KeychainTokenStore::new())
                };
            UpstreamSession::new(resolve_target(), store)
        })
        .clone()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tokens::{test_support::MemoryTokenStore, UserInfo};
    use axum::{
        routing::{get, post},
        Json, Router,
    };
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::net::TcpListener;

    /// Represents an ALREADY fully-credentialed session (a durable
    /// `cookie`, matching the common real-world `complete_session()`-
    /// derived case) — these generic status/cache/logout tests are about
    /// the probe/cache/sign-out machinery.
    fn valid_session(target: &str) -> StoredSession {
        StoredSession {
            target: target.to_string(),
            client_id: "client_1".to_string(),
            user: UserInfo {
                sub: "user_1".to_string(),
                email: Some("a@b.com".to_string()),
                name: None,
            },
            access_token: "access-good".to_string(),
            refresh_token: Some("refresh-good".to_string()),
            expires_at: Some(now_unix() + 3600),
            created_at: "2026-01-01T00:00:00Z".to_string(),
            cookie: Some("better-auth.session_token=test".to_string()),
        }
    }

    fn now_unix() -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64
    }

    async fn spawn_probe_server(behavior: ProbeBehavior) -> (String, Arc<AtomicUsize>) {
        let calls = Arc::new(AtomicUsize::new(0));
        let calls_for_route = calls.clone();
        let app = Router::new().route(
            "/api/links/me",
            get(move || {
                let calls = calls_for_route.clone();
                async move {
                    calls.fetch_add(1, Ordering::SeqCst);
                    match behavior {
                        ProbeBehavior::Ok => (StatusCode::OK, Json(serde_json::json!(null))),
                        ProbeBehavior::AlwaysUnauthorized => (
                            StatusCode::UNAUTHORIZED,
                            Json(serde_json::json!({"error":"unauthorized"})),
                        ),
                        ProbeBehavior::AlwaysServerError => (
                            StatusCode::INTERNAL_SERVER_ERROR,
                            Json(serde_json::json!({"error":"boom"})),
                        ),
                    }
                }
            }),
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        (format!("http://{addr}"), calls)
    }

    #[derive(Clone, Copy)]
    enum ProbeBehavior {
        Ok,
        AlwaysUnauthorized,
        AlwaysServerError,
    }

    use axum::http::StatusCode;

    /// Seeds `store` under the SAME key `UpstreamSession::new(target, ..)`
    /// will look it up under (`host_key(target)`) — a raw `"host"` literal
    /// would silently miss, since the session always derives its Keychain
    /// "account"/store key from the target URL, never an arbitrary label.
    fn seeded_store(target: &str, session: StoredSession) -> Arc<MemoryTokenStore> {
        Arc::new(MemoryTokenStore::seeded(&host_key(target), session))
    }

    struct RejectingSaveStore;

    #[async_trait::async_trait]
    impl TokenStore for RejectingSaveStore {
        async fn load(&self, _host: &str) -> Result<Option<StoredSession>, TokenStoreError> {
            Ok(None)
        }

        async fn save(&self, _host: &str, _session: StoredSession) -> Result<(), TokenStoreError> {
            Err(TokenStoreError::Backend(
                "injected save failure".to_string(),
            ))
        }

        async fn clear(&self, _host: &str) -> Result<(), TokenStoreError> {
            Ok(())
        }
    }

    struct RejectingLoadStore;

    #[async_trait::async_trait]
    impl TokenStore for RejectingLoadStore {
        async fn load(&self, _host: &str) -> Result<Option<StoredSession>, TokenStoreError> {
            Err(TokenStoreError::Backend(
                "injected load failure".to_string(),
            ))
        }

        async fn save(&self, _host: &str, _session: StoredSession) -> Result<(), TokenStoreError> {
            Ok(())
        }

        async fn clear(&self, _host: &str) -> Result<(), TokenStoreError> {
            Ok(())
        }
    }

    struct RejectingClearStore {
        stored: StoredSession,
    }

    #[async_trait::async_trait]
    impl TokenStore for RejectingClearStore {
        async fn load(&self, _host: &str) -> Result<Option<StoredSession>, TokenStoreError> {
            Ok(Some(self.stored.clone()))
        }

        async fn save(&self, _host: &str, _session: StoredSession) -> Result<(), TokenStoreError> {
            Ok(())
        }

        async fn clear(&self, _host: &str) -> Result<(), TokenStoreError> {
            Err(TokenStoreError::Backend(
                "injected clear failure".to_string(),
            ))
        }
    }

    /// Minimal `application/x-www-form-urlencoded` field lookup — only
    /// needs to handle the plain ASCII tokens this crate's own `.form(&[..])`
    /// calls send (no percent-decoding needed for the test values used
    /// here), so a dependency on a full `url`/`form_urlencoded` crate isn't
    /// warranted just for this one assertion helper.
    fn form_field(body: &[u8], key: &str) -> Option<String> {
        std::str::from_utf8(body).ok()?.split('&').find_map(|pair| {
            let (k, v) = pair.split_once('=')?;
            (k == key).then(|| v.to_string())
        })
    }

    #[tokio::test]
    async fn status_is_signed_out_with_no_stored_session() {
        let session = UpstreamSession::new(
            "http://example.invalid".to_string(),
            Arc::new(MemoryTokenStore::new()),
        );
        let status = session.status().await;
        assert!(!status.signed_in);
        assert!(status.user_label.is_none());
        assert_eq!(status.storage_state, AuthStorageState::Available);
    }

    #[tokio::test]
    async fn status_reports_storage_unavailable_instead_of_signed_out_on_load_failure() {
        let session = UpstreamSession::new(
            "http://example.invalid".to_string(),
            Arc::new(RejectingLoadStore),
        );
        let mut status_rx = session.subscribe();

        let status = session.status().await;

        assert!(!status.signed_in);
        assert_eq!(status.storage_state, AuthStorageState::Unavailable);
        status_rx.changed().await.unwrap();
        assert_eq!(
            status_rx.borrow().storage_state,
            AuthStorageState::Unavailable
        );
    }

    #[tokio::test]
    async fn status_reports_signed_in_and_probes_upstream_on_a_cold_cache() {
        let (target, calls) = spawn_probe_server(ProbeBehavior::Ok).await;
        let store = seeded_store(&target, valid_session(&target));
        let session = UpstreamSession::new(target, store);

        let status = session.status().await;
        assert!(status.signed_in);
        assert_eq!(status.user_label.as_deref(), Some("a@b.com"));
        assert_eq!(status.storage_state, AuthStorageState::Available);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn status_within_the_cache_window_does_not_hit_the_network_again() {
        let (target, calls) = spawn_probe_server(ProbeBehavior::Ok).await;
        let store = seeded_store(&target, valid_session(&target));
        let session = UpstreamSession::new(target, store);

        session.status().await;
        session.status().await;
        session.status().await;
        assert_eq!(
            calls.load(Ordering::SeqCst),
            1,
            "repeated status() calls within STATUS_CACHE_TTL must reuse the cached verdict"
        );
    }

    #[tokio::test]
    async fn force_revalidate_signs_out_on_a_hard_401_after_refresh() {
        let (target, _calls) = spawn_probe_server(ProbeBehavior::AlwaysUnauthorized).await;
        let store = seeded_store(&target, valid_session(&target));
        let host = host_key(&target);
        let session = UpstreamSession::new(target, store.clone());

        let status = session.force_revalidate().await;
        assert!(!status.signed_in);
        assert!(
            store.load(&host).await.unwrap().is_none(),
            "hard sign-out must clear the stored session"
        );
    }

    #[tokio::test]
    async fn force_revalidate_refreshes_once_after_a_probe_401() {
        let probe_calls = Arc::new(AtomicUsize::new(0));
        let refresh_calls = Arc::new(AtomicUsize::new(0));
        let probes = probe_calls.clone();
        let refreshes = refresh_calls.clone();
        let app = Router::new()
            .route(
                PROBE_PATH,
                get(move |headers: axum::http::HeaderMap| {
                    let probes = probes.clone();
                    async move {
                        probes.fetch_add(1, Ordering::SeqCst);
                        match headers
                            .get(axum::http::header::AUTHORIZATION)
                            .and_then(|value| value.to_str().ok())
                        {
                            Some("Bearer access-refreshed") => StatusCode::OK,
                            _ => StatusCode::UNAUTHORIZED,
                        }
                    }
                }),
            )
            .route(
                "/api/auth/mcp/token",
                post(move || {
                    let refreshes = refreshes.clone();
                    async move {
                        refreshes.fetch_add(1, Ordering::SeqCst);
                        Json(serde_json::json!({
                            "access_token": "access-refreshed",
                            "refresh_token": "refresh-rotated",
                            "expires_in": 3600,
                        }))
                    }
                }),
            );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        let target = format!("http://{addr}");
        let host = host_key(&target);
        let store = seeded_store(&target, valid_session(&target));
        let session = UpstreamSession::new(target, store.clone());

        let status = session.force_revalidate().await;

        assert!(status.signed_in);
        assert_eq!(probe_calls.load(Ordering::SeqCst), 2);
        assert_eq!(refresh_calls.load(Ordering::SeqCst), 1);
        let persisted = store.load(&host).await.unwrap().unwrap();
        assert_eq!(persisted.access_token, "access-refreshed");
        assert_eq!(persisted.refresh_token.as_deref(), Some("refresh-rotated"));
        assert_eq!(session.access_token().await.unwrap(), "access-refreshed");
    }

    #[tokio::test]
    async fn force_revalidate_fails_open_on_a_transient_probe_error() {
        let (target, _calls) = spawn_probe_server(ProbeBehavior::AlwaysServerError).await;
        let store = seeded_store(&target, valid_session(&target));
        let host = host_key(&target);
        let session = UpstreamSession::new(target, store.clone());

        let status = session.force_revalidate().await;
        assert!(
            status.signed_in,
            "a 5xx from the probe endpoint must not be treated as proof the token is invalid"
        );
        assert!(
            store.load(&host).await.unwrap().is_some(),
            "a transient probe failure must not clear the stored session"
        );
    }

    #[tokio::test]
    async fn force_revalidate_authenticated_reports_signed_in_with_no_org_logic() {
        // The whole point of this simplification: an authenticated,
        // upstream-verified session ALWAYS resolves straight to
        // `signed_in: true` — there is no org-choice/bootstrap detour here
        // at all, regardless of which login path produced the session
        // (cookie or bearer-only).
        let (target, _calls) = spawn_probe_server(ProbeBehavior::Ok).await;
        let mut bearer_only = valid_session(&target);
        bearer_only.cookie = None;
        let store = seeded_store(&target, bearer_only);
        let session = UpstreamSession::new(target, store);

        let status = session.force_revalidate().await;
        assert!(status.signed_in);
    }

    #[tokio::test]
    async fn logout_clears_the_store_and_publishes_signed_out() {
        let (target, _calls) = spawn_probe_server(ProbeBehavior::Ok).await;
        let store = seeded_store(&target, valid_session(&target));
        let host = host_key(&target);
        let session = UpstreamSession::new(target, store.clone());

        // Establish a genuinely PUBLISHED signed-in state first — a fresh
        // `UpstreamSession`'s watch channel already starts at
        // `signed_in:false` (its own constructor's initial value), so
        // `logout()` on a session nothing has ever published a "signed in"
        // state for would be a no-op transition on the channel (equal to
        // equal), and `rx.changed()` below would never resolve. Calling
        // `status()` first against a working probe server exercises the
        // real path that publishes `signed_in:true`.
        session.status().await;
        let mut rx = session.subscribe();
        assert!(
            rx.borrow().signed_in,
            "precondition: must start genuinely signed in"
        );
        session.cookie_jar().capture(
            session.host(),
            std::iter::once("better-auth.session_token=abc"),
        );
        assert!(!session.cookie_jar().is_empty(session.host()));

        let status = session.logout().await;
        assert!(!status.signed_in);
        assert!(store.load(&host).await.unwrap().is_none());
        assert!(
            session.cookie_jar().is_empty(session.host()),
            "logout must purge the in-memory cookie jar"
        );

        rx.changed().await.unwrap();
        assert!(!rx.borrow().signed_in);
    }

    #[tokio::test]
    async fn logout_does_not_publish_signed_out_when_keychain_clear_fails() {
        let (target, _calls) = spawn_probe_server(ProbeBehavior::Ok).await;
        let stored = valid_session(&target);
        let session = UpstreamSession::new(
            target,
            Arc::new(RejectingClearStore {
                stored: stored.clone(),
            }),
        );

        let status = session.logout().await;

        assert!(status.signed_in);
        assert_eq!(status.user_label, label(&stored));
        assert_eq!(session.cookie_header().await, stored.cookie);
    }

    #[tokio::test]
    async fn hard_sign_out_purges_the_cookie_jar() {
        let session = UpstreamSession::new(
            "http://example.invalid".to_string(),
            Arc::new(MemoryTokenStore::new()),
        );
        session
            .cookie_jar()
            .capture(session.host(), std::iter::once("session=abc"));
        assert!(!session.cookie_jar().is_empty(session.host()));

        session.hard_sign_out("test").await;
        assert!(session.cookie_jar().is_empty(session.host()));
    }

    /// Logout ordering: the best-effort upstream revoke MUST fire (with the
    /// still-present session's refresh token) BEFORE the Keychain entry is
    /// cleared — reversing that order would make the revoke request
    /// unbuildable in the first place (no token left to send), silently
    /// downgrading "best-effort revoke" into "no revoke ever happens."
    /// Verified by observing that the mock revoke endpoint actually
    /// received the seeded session's token, THEN asserting the store is
    /// empty afterward.
    #[tokio::test]
    async fn logout_revokes_before_clearing_and_tolerates_any_revoke_outcome() {
        let revoke_token_seen = Arc::new(std::sync::Mutex::new(None));
        let seen_for_route = revoke_token_seen.clone();
        let app = Router::new().route(
            "/api/auth/mcp/revoke",
            post(move |body: axum::body::Bytes| {
                let seen = seen_for_route.clone();
                async move {
                    *seen.lock().unwrap() = form_field(&body, "token");
                    // A non-2xx (or even a missing endpoint) must still be
                    // tolerated by logout() — see `revoke_upstream_best_effort`'s
                    // doc comment on why the mesh server not implementing
                    // this yet must never block sign-out.
                    StatusCode::NOT_FOUND
                }
            }),
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        let target = format!("http://{addr}");
        let mut session_record = valid_session(&target);
        session_record.refresh_token = Some("the-refresh-token".to_string());
        let store = seeded_store(&target, session_record);
        let host = host_key(&target);
        let session = UpstreamSession::new(target, store.clone());

        let status = session.logout().await;

        assert_eq!(
            revoke_token_seen.lock().unwrap().as_deref(),
            Some("the-refresh-token"),
            "revoke must be attempted with the session's OWN token — only \
             possible if it ran before the store was cleared"
        );
        assert!(!status.signed_in);
        assert!(
            store.load(&host).await.unwrap().is_none(),
            "credentials must be cleared even though the revoke endpoint 404'd"
        );
    }

    #[tokio::test]
    async fn access_token_attempts_a_refresh_for_an_expired_session() {
        // Reserve then immediately drop a port so the refresh POST hits a
        // fast "connection refused" — proves `access_token()` actually
        // attempts a network refresh for an expired session rather than
        // blindly returning the stale cached token.
        let dead_port = {
            let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
            l.local_addr().unwrap().port()
        };
        let target = format!("http://127.0.0.1:{dead_port}");
        let mut expired = valid_session(&target);
        expired.expires_at = Some(0);
        let store = seeded_store(&target, expired);
        let session = UpstreamSession::new(target, store);

        let err = session.access_token().await.unwrap_err();
        assert_eq!(err.kind, RefreshErrorKind::Transient);
    }

    // --- complete_session (the hybrid-login bridge) -------------------------

    /// Mock Better Auth-shaped upstream for `complete_session()`'s own
    /// integration tests: `/api/auth/mcp/register`, `/api/auth/mcp/authorize`
    /// (redirects with `code`/`state` when `expected_cookie` is present in
    /// the request's `Cookie` header, otherwise `401`), and
    /// `/api/auth/mcp/token`. Deliberately re-implemented here (not imported
    /// from `bridge`'s own `#[cfg(test)]` module, which is private) — small
    /// enough that owning the fixture at this call site beats reaching into
    /// another module's private test internals.
    async fn spawn_mock_mesh_for_bridge(expected_cookie: &'static str) -> String {
        use axum::extract::Query;
        use axum::response::{IntoResponse, Redirect};
        use std::collections::HashMap;

        let app = Router::new()
            .route(
                "/api/auth/mcp/register",
                post(|| async { Json(serde_json::json!({"client_id": "mock-client-id"})) }),
            )
            .route(
                "/api/auth/mcp/authorize",
                axum::routing::get(
                    move |Query(params): Query<HashMap<String, String>>,
                          headers: axum::http::HeaderMap| async move {
                        let cookie = headers
                            .get(axum::http::header::COOKIE)
                            .and_then(|v| v.to_str().ok())
                            .unwrap_or("");
                        if cookie != expected_cookie {
                            return (StatusCode::UNAUTHORIZED, "no session").into_response();
                        }
                        let redirect_uri = params.get("redirect_uri").cloned().unwrap();
                        let state = params.get("state").cloned().unwrap_or_default();
                        let mut url = reqwest::Url::parse(&redirect_uri).unwrap();
                        url.query_pairs_mut()
                            .append_pair("code", "mock-auth-code")
                            .append_pair("state", &state);
                        Redirect::to(url.as_str()).into_response()
                    },
                ),
            )
            .route(
                "/api/auth/mcp/token",
                post(|| async {
                    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
                    let payload = serde_json::json!({
                        "sub": "user_1",
                        "email": "bridge-session@example.test",
                        "name": "Bridge Session",
                    });
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
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        format!("http://{addr}")
    }

    #[tokio::test]
    async fn complete_session_persists_to_the_store_and_purges_the_jar_on_success() {
        let target = spawn_mock_mesh_for_bridge("better-auth.session_token=abc").await;
        let store = Arc::new(MemoryTokenStore::new());
        let session = UpstreamSession::new(target.clone(), store.clone());
        session.cookie_jar().capture(
            session.host(),
            std::iter::once("better-auth.session_token=abc"),
        );

        let mut rx = session.subscribe();
        let result = session
            .complete_session()
            .await
            .expect("bridge should succeed against a well-behaved mock upstream");

        assert!(result.signed_in);
        assert_eq!(
            result.user_label.as_deref(),
            Some("bridge-session@example.test")
        );
        assert!(
            session.cookie_jar().is_empty(session.host()),
            "complete_session must purge the jar on success"
        );
        let stored = store.load(session.host()).await.unwrap().unwrap();
        assert_eq!(stored.access_token, "mock-access-token");

        rx.changed().await.unwrap();
        assert!(rx.borrow().signed_in);
    }

    #[tokio::test]
    async fn complete_session_purges_the_jar_even_when_the_bridge_fails() {
        // Mock only accepts a specific cookie value; seed a different one so
        // the authorize call is rejected (analogous to a stale/expired
        // captured session cookie).
        let target = spawn_mock_mesh_for_bridge("better-auth.session_token=expected").await;
        let store = Arc::new(MemoryTokenStore::new());
        let session = UpstreamSession::new(target, store.clone());
        session.cookie_jar().capture(
            session.host(),
            std::iter::once("better-auth.session_token=stale"),
        );

        let err = session.complete_session().await.unwrap_err();
        assert!(matches!(err, SessionError::Bridge(_)));
        assert!(
            session.cookie_jar().is_empty(session.host()),
            "complete_session must purge the jar even on failure"
        );
        assert!(store.load(session.host()).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn complete_session_fails_fast_with_no_captured_cookie() {
        let store = Arc::new(MemoryTokenStore::new());
        let session = UpstreamSession::new("http://unused.invalid".to_string(), store);
        let err = session.complete_session().await.unwrap_err();
        assert!(matches!(
            err,
            SessionError::Bridge(BridgeError::NoSessionCookie)
        ));
    }

    // --- login() (system-browser path) bridges into a real session cookie ----
    //
    // The contract this section pins down: given a mesh that implements the
    // real MCP OAuth wire shape PLUS the new
    // `POST /api/auth/desktop/session-from-oauth` bridge, the interactive
    // system-browser login path (`login::perform_interactive_login`, called
    // from `login()` below) ends up with a `StoredSession.cookie` carrying
    // EXACTLY the value that endpoint returned for the bearer it minted —
    // and that once persisted, the EXISTING, unchanged forwarding mechanism
    // (`cookie_header()`, which `routes/upstream.rs`'s
    // `attach_persisted_cookie`/`proxy_auth_path` read from on every
    // app-API call — see this module's doc comment) hands that same
    // value back out. No real browser involved: `open_browser` is faked to
    // hit the mock mesh's `/api/auth/mcp/authorize` directly (mirrors how
    // Better Auth's real hosted `/login` page would, after a human
    // authenticates) instead of rendering a UI, exactly like this file's own
    // `spawn_mock_mesh_for_bridge` already stands in for the non-interactive
    // bridge's authorize call.

    /// Mock mesh for the interactive login path: `/api/auth/mcp/register`,
    /// `/api/auth/mcp/authorize` (always succeeds — the interactive flow's
    /// authorize call presents no cookie of its own; a real mesh would only
    /// reach this point after the human authenticated via the hosted
    /// `/login` UI this mock skips rendering), `/api/auth/mcp/token`, and the
    /// new `/api/auth/desktop/session-from-oauth` bridge (accepts ONLY the
    /// exact bearer the token endpoint minted, mirroring the real
    /// endpoint's `resolveLinkBearer`-backed guard).
    async fn spawn_mock_mesh_for_login() -> (String, Arc<std::sync::Mutex<usize>>) {
        use axum::extract::Query;
        use axum::response::{IntoResponse, Redirect};
        use std::collections::HashMap;

        let bridge_calls = Arc::new(std::sync::Mutex::new(0usize));
        let calls_for_route = bridge_calls.clone();

        let app = Router::new()
            .route(
                "/api/auth/mcp/register",
                post(|| async { Json(serde_json::json!({"client_id": "mock-client-id"})) }),
            )
            .route(
                "/api/auth/mcp/authorize",
                axum::routing::get(|Query(params): Query<HashMap<String, String>>| async move {
                    let redirect_uri = params.get("redirect_uri").cloned().unwrap();
                    let state = params.get("state").cloned().unwrap_or_default();
                    let mut url = reqwest::Url::parse(&redirect_uri).unwrap();
                    url.query_pairs_mut()
                        .append_pair("code", "mock-auth-code")
                        .append_pair("state", &state);
                    Redirect::to(url.as_str()).into_response()
                }),
            )
            .route(
                "/api/auth/mcp/token",
                post(|| async {
                    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
                    let payload = serde_json::json!({
                        "sub": "user_1",
                        "email": "system-browser-user@example.test",
                        "name": "System Browser User",
                    });
                    let payload_b64 = URL_SAFE_NO_PAD.encode(payload.to_string());
                    let id_token = format!("h.{payload_b64}.s");
                    Json(serde_json::json!({
                        "access_token": "minted-access-token",
                        "refresh_token": "minted-refresh-token",
                        "expires_in": 3600,
                        "id_token": id_token,
                    }))
                }),
            )
            .route(
                "/api/auth/desktop/session-from-oauth",
                post(move |headers: axum::http::HeaderMap| {
                    let calls = calls_for_route.clone();
                    async move {
                        *calls.lock().unwrap() += 1;
                        let bearer = headers
                            .get(axum::http::header::AUTHORIZATION)
                            .and_then(|v| v.to_str().ok())
                            .unwrap_or("");
                        if bearer != "Bearer minted-access-token" {
                            return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
                        }
                        Json(serde_json::json!({"sessionToken": "minted-session-token"}))
                            .into_response()
                    }
                }),
            );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        (format!("http://{addr}"), bridge_calls)
    }

    #[tokio::test]
    async fn login_via_system_browser_bridges_the_oauth_bearer_into_a_real_session_cookie() {
        let (target, bridge_calls) = spawn_mock_mesh_for_login().await;
        let http = reqwest::Client::new();

        // Stands in for a human completing Better Auth's hosted `/login`
        // page in the system browser: hits the mock's authorize endpoint
        // directly (skipping the UI this mock doesn't render), following
        // redirects — reqwest's default policy — all the way to the REAL
        // loopback listener `login::perform_interactive_login` started,
        // delivering the code exactly like a real browser redirect would.
        // Fires from a separately-spawned task so it runs CONCURRENTLY with
        // the main call below, which is blocked awaiting that same
        // callback — a single-threaded `#[tokio::test]` runtime interleaves
        // both cooperatively, no real network hop or thread needed.
        let (url_tx, url_rx) = tokio::sync::oneshot::channel::<String>();
        let follow_http = http.clone();
        tokio::spawn(async move {
            let Ok(authorize_page_url) = url_rx.await else {
                return;
            };
            let mut authorize_endpoint = reqwest::Url::parse(&authorize_page_url).unwrap();
            authorize_endpoint.set_path("/api/auth/mcp/authorize");
            let _ = follow_http.get(authorize_endpoint).send().await;
        });
        let url_tx = std::sync::Mutex::new(Some(url_tx));
        let fake_open_browser = move |url: &str| {
            if let Some(tx) = url_tx.lock().unwrap().take() {
                let _ = tx.send(url.to_string());
            }
            Ok(())
        };

        let stored = login::perform_interactive_login(&http, &target, fake_open_browser)
            .await
            .expect("interactive login should succeed against a well-behaved mock mesh");

        assert_eq!(stored.access_token, "minted-access-token");
        assert_eq!(
            stored.cookie.as_deref(),
            Some("better-auth.session_token=minted-session-token"),
            "the system-browser login path must carry the session token the mesh bridge minted \
             for its OAuth bearer, not `None`"
        );
        assert_eq!(
            *bridge_calls.lock().unwrap(),
            1,
            "the session bridge must be called exactly once during login"
        );

        // The forwarding contract itself: once persisted, the EXISTING,
        // unchanged `cookie_header()`/proxy-attachment mechanism hands back
        // exactly this value — proving it's not just this function's return
        // value but what actually rides on a subsequent app-API call
        // (see `routes/upstream.rs::attach_persisted_cookie`/
        // `proxy_auth_path`, which read from precisely this method).
        let store = Arc::new(MemoryTokenStore::new());
        let host = host_key(&target);
        store.save(&host, stored.clone()).await.unwrap();
        let session = UpstreamSession::new(target, store);
        assert_eq!(
            session.cookie_header().await.as_deref(),
            Some("better-auth.session_token=minted-session-token")
        );
    }

    #[tokio::test]
    async fn login_fails_when_the_mesh_session_bridge_rejects_the_bearer() {
        // A mesh that never recognizes ANY bearer for the bridge endpoint
        // (simulates a misconfigured/unreachable bridge) — `login()` must
        // surface a clear error, never a bearer-only "half-signed-in"
        // session (see `login::mint_session_from_access_token`'s doc
        // comment for why this is non-negotiable).
        use axum::extract::Query;
        use axum::response::{IntoResponse, Redirect};
        use std::collections::HashMap;

        let app = Router::new()
            .route(
                "/api/auth/mcp/register",
                post(|| async { Json(serde_json::json!({"client_id": "mock-client-id"})) }),
            )
            .route(
                "/api/auth/mcp/authorize",
                axum::routing::get(|Query(params): Query<HashMap<String, String>>| async move {
                    let redirect_uri = params.get("redirect_uri").cloned().unwrap();
                    let state = params.get("state").cloned().unwrap_or_default();
                    let mut url = reqwest::Url::parse(&redirect_uri).unwrap();
                    url.query_pairs_mut()
                        .append_pair("code", "mock-auth-code")
                        .append_pair("state", &state);
                    Redirect::to(url.as_str()).into_response()
                }),
            )
            .route(
                "/api/auth/mcp/token",
                post(|| async {
                    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
                    let payload = serde_json::json!({"sub": "user_1"});
                    let payload_b64 = URL_SAFE_NO_PAD.encode(payload.to_string());
                    let id_token = format!("h.{payload_b64}.s");
                    Json(serde_json::json!({
                        "access_token": "minted-access-token",
                        "expires_in": 3600,
                        "id_token": id_token,
                    }))
                }),
            )
            .route(
                "/api/auth/desktop/session-from-oauth",
                post(|| async { (StatusCode::UNAUTHORIZED, "unauthorized").into_response() }),
            );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        let target = format!("http://{addr}");

        let http = reqwest::Client::new();

        let (url_tx, url_rx) = tokio::sync::oneshot::channel::<String>();
        let follow_http = http.clone();
        tokio::spawn(async move {
            let Ok(authorize_page_url) = url_rx.await else {
                return;
            };
            let mut authorize_endpoint = reqwest::Url::parse(&authorize_page_url).unwrap();
            authorize_endpoint.set_path("/api/auth/mcp/authorize");
            let _ = follow_http.get(authorize_endpoint).send().await;
        });
        let url_tx = std::sync::Mutex::new(Some(url_tx));
        let fake_open_browser = move |url: &str| {
            if let Some(tx) = url_tx.lock().unwrap().take() {
                let _ = tx.send(url.to_string());
            }
            Ok(())
        };

        let err = login::perform_interactive_login(&http, &target, fake_open_browser)
            .await
            .unwrap_err();
        assert!(matches!(err, LoginError::SessionBridgeRejected(401, _)));
    }

    // --- cookie_header / remember_cookie — the real-UI course-correction ---

    #[tokio::test]
    async fn complete_session_persists_the_cookie_durably_for_the_apps_lifetime() {
        // See `spawn_mock_mesh_for_bridge` above — the bridge's own
        // returned `StoredSession.cookie` already carries the cookie that
        // authenticated the authorize call. This test asserts the OUTER
        // contract: after `complete_session()`, `cookie_header()` returns
        // that same value from durable storage — not just from the
        // (already-purged) ephemeral jar.
        let target = spawn_mock_mesh_for_bridge("better-auth.session_token=abc").await;
        let store = Arc::new(MemoryTokenStore::new());
        let session = UpstreamSession::new(target, store);
        session.cookie_jar().capture(
            session.host(),
            std::iter::once("better-auth.session_token=abc"),
        );

        session.complete_session().await.unwrap();

        assert_eq!(
            session.cookie_header().await.as_deref(),
            Some("better-auth.session_token=abc"),
            "the cookie must be durably persisted (Keychain-backed store), not just held in the \
             ephemeral jar the bridge already purged"
        );
    }

    #[tokio::test]
    async fn complete_session_does_not_publish_or_cache_when_persistence_fails() {
        let target = spawn_mock_mesh_for_bridge("better-auth.session_token=abc").await;
        let session = UpstreamSession::new(target, Arc::new(RejectingSaveStore));
        let status_rx = session.subscribe();
        session.cookie_jar().capture(
            session.host(),
            std::iter::once("better-auth.session_token=abc"),
        );

        let error = session.complete_session().await.unwrap_err();

        assert!(matches!(error, SessionError::Store(_)));
        assert!(!status_rx.borrow().signed_in);
        assert_eq!(session.cookie_header().await, None);
    }

    #[tokio::test]
    async fn cookie_header_is_none_with_no_stored_session() {
        let session = UpstreamSession::new(
            "http://example.invalid".to_string(),
            Arc::new(MemoryTokenStore::new()),
        );
        assert_eq!(session.cookie_header().await, None);
    }

    #[tokio::test]
    async fn current_user_sub_is_none_with_no_stored_session() {
        let session = UpstreamSession::new(
            "http://example.invalid".to_string(),
            Arc::new(MemoryTokenStore::new()),
        );
        assert_eq!(session.current_user_sub().await, None);
    }

    #[tokio::test]
    async fn current_user_sub_returns_the_signed_in_users_sub() {
        let target = "http://example.invalid".to_string();
        let store = seeded_store(&target, valid_session(&target));
        let session = UpstreamSession::new(target, store);
        assert_eq!(session.current_user_sub().await.as_deref(), Some("user_1"));
    }

    #[tokio::test]
    async fn current_user_sub_result_preserves_storage_failure() {
        let session = UpstreamSession::new(
            "http://example.invalid".to_string(),
            Arc::new(RejectingLoadStore),
        );

        assert!(matches!(
            session.current_user_sub_result().await,
            Err(TokenStoreError::Backend(message)) if message == "injected load failure"
        ));
    }

    #[tokio::test]
    async fn logout_purges_the_persisted_cookie_along_with_the_rest_of_the_session() {
        let (target, _calls) = spawn_probe_server(ProbeBehavior::Ok).await;
        let mut seeded = valid_session(&target);
        seeded.cookie = Some("better-auth.session_token=xyz".to_string());
        let store = seeded_store(&target, seeded);
        let session = UpstreamSession::new(target, store);

        assert_eq!(
            session.cookie_header().await.as_deref(),
            Some("better-auth.session_token=xyz")
        );
        session.logout().await;
        assert_eq!(
            session.cookie_header().await,
            None,
            "logout must clear the durable cookie together with the rest of the session \
             (store.clear() removes the whole record, not just the tokens)"
        );
    }

    #[tokio::test]
    async fn remember_cookie_updates_an_existing_sessions_persisted_cookie() {
        let (target, _calls) = spawn_probe_server(ProbeBehavior::Ok).await;
        let mut seeded = valid_session(&target);
        seeded.cookie = Some("better-auth.session_token=old".to_string());
        let store = seeded_store(&target, seeded);
        let session = UpstreamSession::new(target, store);

        session
            .remember_cookie("better-auth.session_token=rotated")
            .await;

        assert_eq!(
            session.cookie_header().await.as_deref(),
            Some("better-auth.session_token=rotated")
        );
    }

    #[tokio::test]
    async fn remember_cookie_is_a_no_op_with_no_oauth_session_yet() {
        // No StoredSession exists for this host at all (e.g. mid-embedded-
        // login, before `complete_session()` has ever run) — must not
        // fabricate one.
        let session = UpstreamSession::new(
            "http://example.invalid".to_string(),
            Arc::new(MemoryTokenStore::new()),
        );
        session.remember_cookie("session=whatever").await;
        assert_eq!(session.cookie_header().await, None);
    }
}
