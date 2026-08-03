//! `upstream` — OAuth 2.1 + PKCE loopback login against the decocms mesh
//! server, OS Keychain token storage, silent refresh, and the process-wide
//! session handle `crates/local-api/src/routes/upstream.rs`'s app-API
//! proxy (and, eventually, the Tauri shell's `auth_status`/`auth_login`/
//! `auth_logout` IPC commands — see the desktop migration contract
//! Phase 3) both call into.
//!
//! ## Module map
//!
//! - [`pkce`] — RFC 7636 S256 code-verifier/code-challenge generation.
//! - [`register`] — dynamic OAuth client registration
//!   (`POST /api/auth/mcp/register`) + a non-secret on-disk `client_id`
//!   cache.
//! - [`login`] — the interactive flow: loopback callback listener, system
//!   browser launch, authorization-code exchange
//!   (`POST /api/auth/mcp/token`), id_token decode.
//! - [`tokens`] — [`tokens::StoredSession`] + the [`tokens::TokenStore`]
//!   abstraction, with [`tokens::KeychainTokenStore`] (production, macOS
//!   Keychain via the `keyring` crate) as the only non-test implementation.
//! - [`refresh`] — silent access-token refresh with single-flight
//!   coordination ([`refresh::RefreshCoordinator`]), so N concurrent
//!   app-API requests hitting an expired/revoked token collapse into
//!   ONE network refresh.
//! - [`cookie_jar`] — [`cookie_jar::CookieJar`], the in-memory, per-host
//!   `Set-Cookie` capture used by the hybrid-login bridge (see [`bridge`]).
//! - [`bridge`] — the non-interactive `auth_complete_session` flow: reuses
//!   [`cookie_jar::CookieJar`]'s captured Better Auth session cookie to
//!   drive the MCP OAuth authorize/token dance without a browser hop.
//! - [`session`] — [`session::UpstreamSession`], the public API: `status`
//!   / `login` / `logout` / `complete_session` / `access_token`, plus
//!   [`session::global`], the process-wide singleton every caller shares.
//! - [`revalidate`] — the background periodic-revalidation task.
//! - [`clock`] — tiny dependency-free UNIX-time helpers shared by
//!   [`login`] and [`bridge`] (both mint a [`tokens::StoredSession`]).
//! - [`paths`] — shared app-data-directory resolution for this crate's
//!   non-secret on-disk caches ([`register`], [`org_cache`]).
//! - [`poison`] — `lock_ok`/`read_ok`/`write_ok`: the workspace-wide policy
//!   for a poisoned lock (recover the guard, never cascade the panic).
//!   Lives here because `crates/local-api` already depends on this crate and
//!   is its heaviest consumer — same reason [`clock`] does.
//!
//! ## Why a process-wide singleton instead of an `AppState` field
//!
//! `crates/local-api`'s `AppState` (`state.rs`) and its route table
//! (`router.rs`) are SHARED FILES per
//! the native module-ownership contract — editing them is how one
//! family's change silently breaks seven others' builds. This crate's
//! owner (upstream auth + proxy) is scoped to `crates/upstream` and
//! `crates/local-api/src/routes/upstream.rs` only. Rather than filing an
//! interface request to widen `AppState` for a value that is, by its very
//! nature, a process-wide singleton anyway (there is exactly one signed-in
//! upstream identity per running `local-api`/Tauri process — never one per
//! request, never one per `AppState` clone), [`session::global`] IS the
//! shared handle: `routes/upstream.rs` calls it directly, and the Tauri
//! shell's future IPC commands (a DIFFERENT crate this one has zero
//! compile-time dependency on) call the exact same function and therefore
//! observe the exact same state — no double bookkeeping, no risk of the
//! shell and the proxy disagreeing about whether the user is signed in.
#![forbid(unsafe_code)]

pub mod bridge;
pub mod browser_page;
mod clock;
pub mod cookie_jar;
pub mod keychain_helper;
pub mod login;
pub mod pkce;
pub mod poison;
pub mod refresh;
pub mod register;
pub mod revalidate;
pub mod session;
pub mod tokens;

pub use cookie_jar::CookieJar;
pub use session::{global, AuthStorageState, StatusResult, UpstreamSession};
