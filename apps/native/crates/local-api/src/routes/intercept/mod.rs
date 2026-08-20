//! ONE canonical interception table for `routes/upstream.rs`'s app-API
//! proxy — the owner course-correction's central ask: the desktop app boots
//! the REAL production web shell (`apps/web/src`), and this module is
//! where local-api answers, LOCALLY, the specific narrow set of routes that
//! shell's thread, native-terminal, and sandbox surfaces need served from local
//! SQLite + the native runtime instead of the (unmodified,
//! possibly-production) upstream mesh. Every route below cites
//! the native interception contract (the wire-contract recon)
//! for the exact shape it emulates — this module is that recon turned into
//! code, not a reinterpretation of it.
//!
//! [`try_intercept`] is [`crate::routes::upstream::proxy`]'s FIRST decision,
//! before the `/api/auth/*` cookie-relay branch or the ordinary
//! bearer-forwarding branch ever run: intercepted routes need neither — they
//! never talk to upstream at all. Anything this module doesn't recognize
//! returns `None`, and the caller falls through to the unmodified proxy
//! behavior (bearer + persisted-cookie forwarding). See each submodule's own
//! doc comment for its slice of the table:
//!
//! | Route(s) | Map section | Submodule |
//! | --- | --- | --- |
//! | `POST /api/:org/tools/COLLECTION_THREADS_LIST` | §3.1 | [`thread_tools`] |
//! | `POST /api/:org/tools/COLLECTION_THREADS_GET` | §3.1 | [`thread_tools`] |
//! | `POST /api/:org/tools/COLLECTION_THREADS_CREATE` | §3.1 | [`thread_tools`] |
//! | `POST /api/:org/tools/COLLECTION_THREADS_UPDATE` | §3.1 | [`thread_tools`] |
//! | `POST /api/:org/tools/COLLECTION_THREADS_DELETE` | §3.1 | [`thread_tools`] |
//! | `POST /api/:org/tools/COLLECTION_THREAD_MESSAGES_LIST` | §3.1 | [`thread_tools`] |
//! | `GET /api/:org/watch` | local thread lifecycle SSE | [`watch`] |
//! | `POST /api/:org/sandbox/:virtualMcpId/:branch/{read,write,unlink,mkdir,rename,glob,grep}` | native sandbox filesystem bridge | [`sandbox_fs`] |
//! | any `/api/:org/decopilot/*` | retired native chat transport | local `410`, never forwarded |
//! | any other `/api/:org/tools/:toolName` | — | not intercepted (`None`) |
//!
//! Native `GET /api/:org/watch` is intentionally local-only. It never opens,
//! forwards, or merges the upstream watch stream: local SQLite is the source
//! of truth for native thread changes, and upstream has no copy of those rows.
//!
//! ## Why `/api/:org/decopilot/*` is a 100%-intercepted family, not a
//! per-route table
//!
//! Every OTHER row above is matched by exact tool name / exact path shape —
//! an unrecognized tool name or an unrecognized top-level `/api/:org/*`
//! route family falls through to the ordinary upstream proxy, which is
//! correct (org CRUD, connections, members, roles, settings, task board,
//! etc. are genuinely meant to proxy unchanged — map §2.3). `/decopilot/*`
//! is different: native chats now own a persistent terminal session through
//! the literal `/api/:org/threads/:threadId/terminal{,/ws}` routes. Every old
//! Decopilot request/stream/queue path is therefore tombstoned locally with
//! `410 native_chat_removed`. This prevents a stale bundle from splitting one
//! chat between the local PTY and the hosted workflow service.
//!
//! ## `:org` is opaque
//!
//! Neither this module nor its submodules validate the `:org` path segment
//! against a real organization — it is stamped verbatim as
//! `organization_id` on locally-created rows. Map §3.1 makes the same
//! point about `virtual_mcp_id`: these are opaque strings scoping purely
//! local data, never round-tripped against upstream.

mod agent_sessions;
mod dev_server;
mod git_assist;
mod preview_invoke;
mod runtime;
mod sandbox_events;
mod sandbox_fs;
mod sandbox_lifecycle;
mod sandbox_ops;
pub mod thread_tools;

pub(crate) use sandbox_lifecycle::{
    config_from_virtual_mcp, preview_host_base, preview_scheme, set_preview_host,
    set_preview_host_observer, set_preview_port, set_preview_scheme,
};
pub(crate) mod watch;

use axum::body::Bytes;
use axum::http::Method;
use axum::response::{IntoResponse, Response};

use crate::error::ApiError;
use crate::state::AppState;

/// The single entry point `routes/upstream.rs::proxy` calls before its
/// ordinary `/api/auth/*` / bearer-forwarding branches. `path` is the bare
/// request path (e.g. `/api/acme/tools/COLLECTION_THREADS_LIST` or
/// `/api/acme/decopilot/threads/t1/messages` — no `/upstream` prefix to
/// strip anymore) with its query string supplied separately for `/watch`'s
/// optional `types` filter. Other intercepted routes do not read query
/// parameters — `COLLECTION_THREADS_LIST`'s pagination/filter fields all ride
/// in the POST body, per `tools-rest.ts`'s "body = tool arguments verbatim"
/// contract, map §3.1.
/// Whether `<segment>` in `/api/<segment>/<rest…>` is really an organization.
///
/// NOT every second path segment is one: `/api/config`, `/api/auth/*` and the
/// instance-level `/api/_admin/*` namespace all sit at the same position. An
/// earlier version treated them as orgs and mounted a full set of volumes for
/// each — four bogus organizations, sixteen rclone processes.
///
/// The org-scoped tool surface is the reliable signal: it is where the
/// webview's org-scoped traffic actually goes, and nothing instance-level
/// lives under it. The underscore check is the second layer, matching the
/// repo's documented convention for instance-level namespaces.
fn is_org_scoped(segment: &str, rest: &[&str]) -> bool {
    !segment.starts_with('_') && rest.first() == Some(&"tools")
}

pub async fn try_intercept(
    state: &AppState,
    method: &Method,
    path: &str,
    query: Option<&str>,
    body: &Bytes,
) -> Option<Response> {
    let mut segs = path.trim_start_matches('/').split('/');
    if segs.next()? != "api" {
        return None;
    }
    let org = segs.next().filter(|s| !s.is_empty())?;
    let rest: Vec<&str> = segs.collect();

    // Start warming this organization's filesystem. A genuinely org-scoped
    // request here is exactly "the app booted into this org" or "the user
    // switched to it", so the mounts come up while the user is still
    // navigating to an agent instead of on the sandbox-provisioning path.
    // Idempotent and O(1) — an org that is ready, in flight, or cooling off
    // returns immediately, which matters because this runs on every request.
    if is_org_scoped(org, &rest) {
        crate::sandbox::org_mount::warm(&state.app_root, org);
    }

    if let Some(response) = sandbox_fs::try_dispatch(state, method, &rest, query, body).await {
        return Some(response);
    }

    if let Some(response) = sandbox_events::try_dispatch(state, method, &rest, query).await {
        return Some(response);
    }

    if let Some(response) = preview_invoke::try_dispatch(state, method, &rest, query, body).await {
        return Some(response);
    }

    if let Some(response) = sandbox_ops::try_dispatch(state, method, &rest, query, body).await {
        return Some(response);
    }

    if let Some(response) = agent_sessions::try_dispatch(state, method, &rest, query).await {
        return Some(response);
    }

    if let Some(response) = sandbox_lifecycle::try_dispatch(state, method, org, &rest, body).await {
        return Some(response);
    }

    match rest.first().copied() {
        Some("watch") if rest.len() == 1 && *method == Method::GET => {
            // None of the refusals below may be a status code — see
            // [`watch::retryable_refusal`]. A restarted listener answering an
            // `EventSource` reconnect with 401/500/503 closes that stream for
            // the life of the page, and a native rebuild restarts the listener
            // under a webview that keeps running.
            let scope = match thread_tools::current_account_scope_result().await {
                Ok(Some(scope)) => scope,
                Ok(None) => return Some(watch::retryable_refusal("no signed-in account yet")),
                Err(error) => {
                    tracing::warn!(%error, "native watch account scope storage unavailable");
                    return Some(watch::retryable_refusal(
                        "session storage temporarily unavailable",
                    ));
                }
            };
            Some(watch::get(&scope, org, query))
        }
        Some("tools") if rest.len() == 2 && *method == Method::POST => match rest[1] {
            tool_name @ ("COLLECTION_THREADS_LIST"
            | "COLLECTION_THREADS_GET"
            | "COLLECTION_THREADS_CREATE"
            | "COLLECTION_THREADS_UPDATE"
            | "COLLECTION_THREADS_DELETE"
            | "COLLECTION_THREAD_MESSAGES_LIST") => {
                let Some(scope) = thread_tools::current_account_scope().await else {
                    return Some(ApiError::unauthorized().into_response());
                };
                thread_tools::dispatch_scoped(state, &scope, org, tool_name, body).await
            }
            _ => None,
        },
        Some("decopilot") => {
            // A stale native bundle must fail locally. Falling through would
            // enqueue work on hosted Decopilot and split one chat across two
            // execution models.
            Some(ApiError::gone("native_chat_removed").into_response())
        }
        _ => None,
    }
}

/// Test-only `AppState` fixture, shared by this module's own tests AND
/// every sibling submodule's tests —
/// one place to keep in sync with `AppState`'s fields
/// rather than duplicating this boilerplate per file.
#[cfg(test)]
pub(crate) fn test_state(root: &std::path::Path) -> AppState {
    use crate::state::ApiMode;
    use std::sync::Arc;

    let config = Arc::new(crate::config::ConfigStore::new());
    let logs = Arc::new(crate::log_store::LogStore::new(root.join("logs")));
    let tasks = Arc::new(crate::tasks::TaskRegistry::new(logs));
    let broadcaster = Arc::new(crate::events::Broadcaster::new());
    let repo_dir = root.join("repo");
    let setup = crate::setup::SetupOrchestrator::new(
        repo_dir.clone(),
        repo_dir.clone(),
        config.clone(),
        tasks.clone(),
        broadcaster.clone(),
    );
    AppState {
        token: Arc::from("test-token"),
        boot_id: Arc::from("boot-1"),
        sandbox_manager: crate::sandbox::SandboxManager::new(root.to_path_buf()),
        agent_sessions: crate::terminal::AgentSessionRegistry::new(),
        app_root: root.to_path_buf(),
        repo_dir,
        mode: ApiMode::Strict,
        config,
        tasks,
        broadcaster,
        shutdown: Arc::new(crate::shutdown::ShutdownCoordinator::new()),
        setup,
        update: None,
    }
}

#[cfg(test)]
mod tests {
    use super::is_org_scoped;

    /// The regression: `/api/config`, `/api/auth/*` and `/api/_admin/*` sit at
    /// the same path position as an org slug. Treating them as organizations
    /// mounted a full set of volumes for each — 16 rclone processes for one
    /// real org.
    #[test]
    fn instance_level_paths_are_not_organizations() {
        assert!(!is_org_scoped("config", &[]));
        assert!(!is_org_scoped("auth", &["callback"]));
        assert!(!is_org_scoped("_admin", &["tools", "ANYTHING"]));
        assert!(!is_org_scoped("deco", &["decopilot", "threads"]));
    }

    #[test]
    fn the_org_scoped_tool_surface_is_an_organization() {
        assert!(is_org_scoped("deco", &["tools", "SANDBOX_START"]));
        assert!(is_org_scoped("gimenes-guarana-works", &["tools", "X"]));
    }

    use super::*;

    #[tokio::test]
    async fn unrecognized_tool_names_are_not_intercepted() {
        let dir = tempfile::tempdir().unwrap();
        let state = test_state(dir.path());
        let res = try_intercept(
            &state,
            &Method::POST,
            "/api/acme/tools/SOME_OTHER_TOOL",
            None,
            &Bytes::from_static(b"{}"),
        )
        .await;
        assert!(res.is_none());
    }

    #[tokio::test]
    async fn non_org_scoped_paths_are_not_intercepted() {
        let dir = tempfile::tempdir().unwrap();
        let state = test_state(dir.path());
        assert!(
            try_intercept(&state, &Method::GET, "/api/config", None, &Bytes::new(),)
                .await
                .is_none()
        );
        assert!(try_intercept(
            &state,
            &Method::GET,
            "/api/auth/get-session",
            None,
            &Bytes::new(),
        )
        .await
        .is_none());
    }

    #[tokio::test]
    async fn every_decopilot_subpath_is_intercepted_even_when_unrecognized() {
        let dir = tempfile::tempdir().unwrap();
        let state = test_state(dir.path());
        let res = try_intercept(
            &state,
            &Method::GET,
            "/api/acme/decopilot/some-future-route",
            None,
            &Bytes::new(),
        )
        .await;
        let res = res
            .expect("the entire /decopilot/* family must be intercepted, never forwarded upstream");
        assert_eq!(res.status(), axum::http::StatusCode::GONE);
        let body = axum::body::to_bytes(res.into_body(), 1024).await.unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&body).unwrap(),
            serde_json::json!({ "error": "native_chat_removed" })
        );
    }
}
