//! Native interception for the production shell's sandbox lifecycle tools.
//!
//! `POST /api/:org/tools/SANDBOX_START` is what the real web shell calls to
//! provision the sandbox behind a thread. In the browser that reaches mesh,
//! which provisions either a cloud `agent-sandbox` or — for a `bunx decocms
//! link` user — the `user-desktop` runtime on their machine. Inside the desktop
//! app THIS process is that machine, so the same call has to resolve against
//! the local [`SandboxManager`] instead of a cluster.
//!
//! The frontend does not tell us which to use, and deliberately so: the desktop
//! build defaults its agent option to a local CLI, which pins
//! `sandbox_provider_kind = "user-desktop"` through `AGENT_OPTION_PINS`, and
//! `local-api` answers every request from the webview anyway. So this module
//! answers unconditionally and reports `user-desktop` back — the value is
//! honest ("runs on the user's machine"); only the transport differs from the
//! link daemon, and the shell cannot tell the difference.
//!
//! ## Where the git config comes from
//!
//! [`SandboxManager::ensure`] needs a [`GitSandboxConfig`] — clone URL, branch,
//! runtime. That used to ride along on the chat dispatch payload (the web
//! bundle's `build-sandbox-block.ts`), which meant the frontend carried desktop
//! -specific plumbing. It no longer does, so we resolve it here from the
//! cluster-side virtual-MCP registry via [`upstream::call_org_tool`] — the one
//! deliberate upstream read in an otherwise strictly-local table (see that
//! function's doc comment). Field mapping mirrors what the dispatch block used
//! to send, so the resulting sandbox is byte-identical to the one the old path
//! produced.

use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::OnceLock;

use axum::body::Bytes;
use axum::http::{Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::{json, Value};

use crate::error::ApiError;
use crate::routes::upstream;
use crate::sandbox::GitSandboxConfig;
use crate::state::AppState;

/// The preview listener's port, published by [`crate::start`] once it binds.
///
/// A process global rather than an `AppState` field because the preview
/// listener binds AFTER the state is constructed, and because one process
/// serves exactly one preview listener — the same reasoning behind
/// `upstream::global()`. `0` means "not bound yet", which reports no preview
/// URL instead of a wrong one.
static PREVIEW_PORT: AtomicU16 = AtomicU16::new(0);

pub(crate) fn set_preview_port(port: u16) {
    PREVIEW_PORT.store(port, Ordering::Relaxed);
}

/// The host the preview listener answers on, WITHOUT a port — every sandbox is
/// served from `<handle>.<this>`.
///
/// Published the same way as [`PREVIEW_PORT`] rather than threaded through
/// `AppState`. Defaults to `localhost` so the standalone/bearer build and the
/// unit tests keep the old single-host behaviour; the embedded app sets the
/// real one at startup. See `src-tauri/src/control_origin.rs` for why it has
/// to be a real registrable domain and not `*.localhost`.
static PREVIEW_HOST: OnceLock<String> = OnceLock::new();

pub(crate) fn set_preview_host(host: String) {
    let _ = PREVIEW_HOST.set(host);
}

/// `https` once the listeners terminate TLS. Published alongside the host for
/// the same reason: the scheme is decided at startup, not per request.
static PREVIEW_SCHEME: OnceLock<&'static str> = OnceLock::new();

pub(crate) fn set_preview_scheme(scheme: &'static str) {
    let _ = PREVIEW_SCHEME.set(scheme);
}

fn preview_scheme() -> &'static str {
    PREVIEW_SCHEME.get().copied().unwrap_or("http")
}

pub(crate) fn preview_host_base() -> &'static str {
    PREVIEW_HOST
        .get()
        .map(String::as_str)
        .unwrap_or("localhost")
}

/// `SANDBOX_START`'s `previewUrl` for ONE sandbox.
///
/// Per-handle rather than one shared origin: cookies ignore the port, so a
/// single host put every sandbox in one jar. `None` before the listener binds.
fn preview_url(handle: &str) -> Option<String> {
    let port = match PREVIEW_PORT.load(Ordering::Relaxed) {
        0 => return None,
        port => port,
    };
    let base = preview_host_base();
    // Per-handle hosts ONLY under a real registrable domain. Under a
    // single-label host (`localhost`) every `<handle>.localhost` is its own
    // SITE, which makes the preview iframe third-party and — measured in
    // WebKit — unable to store ANY cookie. That is strictly worse than one
    // shared jar, so this stays single-origin until the app is served from a
    // real domain. See `src-tauri/src/control_origin.rs`.
    if base.contains('.') {
        // ONE label, derived from the handle — a handle itself contains `/`
        // and would turn the host into `github.com` with the rest as a path.
        let label = crate::sandbox::preview_label(handle);
        Some(format!("{}://{label}.{base}:{port}/", preview_scheme()))
    } else {
        Some(format!("{}://{base}:{port}/", preview_scheme()))
    }
}

/// The shared never-on-main normalization — see `sandbox::normalize_branch`.
/// (This deliberately DIVERGES from the retired `resolveDesktopSandboxBranch`,
/// which defaulted to `main`: a `main` worktree cannot publish, so landing on
/// it was a trap, and the one the branch chip kept exposing.)
const DEFAULT_BRANCH: &str = crate::sandbox::DEFAULT_BRANCH;

/// The branch reported for a thread with no git-backed sandbox of its own.
///
/// A sentinel rather than `main`: an agent with no repository has no branch,
/// and saying `main` is a claim that is both false and indistinguishable from
/// a real branch — which is exactly how a defaulted value came to overwrite a
/// live one and strand the UI on `main` after a restart.
pub(crate) const EPHEMERAL_BRANCH: &str = "ephemeral";

/// The branch a thread's sandbox is actually on, according to the sandbox
/// manager — the single source of truth.
///
/// The branch is encoded in the handle the manager registered, so it cannot
/// silently disagree with the sandbox that is really running. Anything that
/// reports a thread's branch derives it here rather than echoing back whatever
/// the caller happened to send: a request that omits the branch used to fall
/// through to [`DEFAULT_BRANCH`], and that default was then persisted over the
/// thread's real branch.
///
/// Returns [`EPHEMERAL_BRANCH`] when this agent has no sandbox — not-yet
/// provisioned, or not git-backed at all.
pub(crate) fn branch_for_virtual_mcp(state: &AppState, virtual_mcp_id: &str) -> String {
    if virtual_mcp_id.is_empty() {
        return EPHEMERAL_BRANCH.to_string();
    }
    // Prefer whichever sandbox this agent has LIVE in this process; any
    // durable row is the fallback. Read from the registry — walking
    // `worktrees/` and parsing sidecars per request was the old, slow way,
    // and the registry is the authority anyway.
    let mut fallback = None;
    for record in state
        .sandbox_manager
        .records_for_agent(virtual_mcp_id)
        .unwrap_or_default()
    {
        let Some(branch) = record.config.branch.clone().filter(|b| !b.is_empty()) else {
            continue;
        };
        if matches!(
            state.sandbox_manager.is_registered(&record.handle),
            Ok(true)
        ) {
            return branch;
        }
        fallback.get_or_insert(branch);
    }
    fallback.unwrap_or_else(|| EPHEMERAL_BRANCH.to_string())
}

/// `metadata.runtime.selected` names a package manager; `application.runtime`
/// wants the JS runtime that drives it. Byte-parity with
/// `packages/shared/src/runtime-defaults.ts::PACKAGE_MANAGER_CONFIG[pm].runtime`.
fn runtime_for_package_manager(package_manager: &str) -> Option<&'static str> {
    match package_manager {
        "npm" | "pnpm" | "yarn" => Some("node"),
        "bun" => Some("bun"),
        "deno" => Some("deno"),
        _ => None,
    }
}

/// Build the sandbox config from a virtual MCP's `metadata`, or `None` when it
/// has no clonable git repo attached (the plain-directory case — there is
/// nothing to provision a git sandbox from).
///
/// Pure so the mapping is unit-testable without an upstream or a filesystem,
/// per TESTING.md.
pub(crate) fn config_from_virtual_mcp(
    virtual_mcp_id: &str,
    branch: Option<&str>,
    metadata: &Value,
    org_slug: Option<&str>,
) -> Option<GitSandboxConfig> {
    let clone_url = metadata
        .get("githubRepo")?
        .get("url")?
        .as_str()
        .filter(|url| !url.is_empty())?;

    let runtime_meta = metadata.get("runtime");
    let package_manager = runtime_meta
        .and_then(|r| r.get("selected"))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty());
    let package_manager_path = runtime_meta
        .and_then(|r| r.get("path"))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty());

    Some(GitSandboxConfig {
        org_slug: org_slug.map(str::to_string),
        virtual_mcp_id: virtual_mcp_id.to_string(),
        clone_url: clone_url.to_string(),
        branch: Some(crate::sandbox::normalize_branch(branch).to_string()),
        runtime: package_manager
            .and_then(runtime_for_package_manager)
            .map(str::to_string),
        package_manager: package_manager.map(str::to_string),
        package_manager_path: package_manager_path.map(str::to_string),
        git_user_name: None,
        git_user_email: None,
    })
}

/// `SANDBOX_START` / `SANDBOX_DELETE`, or `None` for any other tool so the
/// caller falls through to the ordinary upstream proxy.
pub(crate) async fn try_dispatch(
    state: &AppState,
    method: &Method,
    org: &str,
    rest: &[&str],
    body: &Bytes,
) -> Option<Response> {
    let ["tools", tool_name] = rest else {
        return None;
    };
    if *method != Method::POST {
        return None;
    }
    match *tool_name {
        "SANDBOX_START" => Some(start(state, org, body).await),
        "SANDBOX_DELETE" => Some(delete(state, body).await),
        "COLLECTION_VIRTUAL_MCP_GET" | "COLLECTION_VIRTUAL_MCP_LIST" => {
            Some(virtual_mcp_read(state, org, tool_name, body).await)
        }
        _ => None,
    }
}

/// `COLLECTION_VIRTUAL_MCP_GET`, with this machine's sandboxes published into
/// the agent's `metadata.sandboxMap`.
///
/// The shell decides whether a sandbox exists — and what URL to preview — by
/// reading `sandboxMap[userId][branch][kind]`, which the CLOUD writes when it
/// provisions a VM (`agent-shell-layout`'s `shouldConnect` and `previewUrl`
/// both come from it). A desktop sandbox lives only on this machine, so that
/// map stays empty and the shell concludes there is nothing to show: the event
/// stream is never opened (leaving the terminal blank) and the preview has no
/// URL to load, however healthy the local sandbox actually is.
///
/// Rather than teach the frontend a second source of truth, answer the question
/// it already asks: proxy the tool upstream unchanged, then merge in an entry
/// per locally-registered sandbox for this agent. Entries are keyed
/// `user-desktop`, so they sit alongside any hosted ones rather than replacing
/// them.
/// Both the single-item read and the collection list. LIST matters as much as
/// GET: the collection hooks seed the per-item cache from it, so an un-enriched
/// list entry is what the shell would read for the active agent.
async fn virtual_mcp_read(state: &AppState, org: &str, tool_name: &str, body: &Bytes) -> Response {
    let input: Value = match crate::http_util::json_body(body) {
        Ok(value) => value,
        Err(error) => return error.into_response(),
    };

    let mut answer = match upstream::call_org_tool(org, tool_name, &input).await {
        Ok(value) => value,
        Err(error) => {
            return ApiError::new(StatusCode::BAD_GATEWAY, error).into_response();
        }
    };

    let Some(user_id) = super::thread_tools::current_account_scope()
        .await
        .map(|scope| scope.user_id)
    else {
        // Not signed in: nothing to attribute sandboxes to, and the shell has
        // nothing to render anyway. Pass upstream's answer through untouched.
        return Json(answer).into_response();
    };

    // `{ items: [ … ] }`, `{ item: … }`, or a bare entity. Resolve which
    // BEFORE borrowing mutably, so there is only ever one live borrow.
    let envelope = if answer.get("items").and_then(Value::as_array).is_some() {
        "items"
    } else if answer.get("item").is_some() {
        "item"
    } else {
        ""
    };

    match envelope {
        "items" => {
            if let Some(items) = answer.get_mut("items").and_then(Value::as_array_mut) {
                for entity in items.iter_mut() {
                    enrich_entity(state, entity, &user_id);
                }
            }
        }
        "item" => {
            if let Some(item) = answer.get_mut("item") {
                enrich_entity(state, item, &user_id);
            }
        }
        _ => enrich_entity(state, &mut answer, &user_id),
    }
    Json(answer).into_response()
}

/// Publish this machine's sandboxes for one virtual-MCP entity, in place.
fn enrich_entity(state: &AppState, entity: &mut Value, user_id: &str) {
    let Some(id) = entity.get("id").and_then(Value::as_str).map(str::to_string) else {
        return;
    };
    // Cloud sandboxes are INVISIBLE on desktop, by design: every sandbox
    // route here resolves against local worktrees only, so a cloud entry in
    // the map would offer a branch whose file explorer, git panel and preview
    // are all dead. Strip the hosted kinds upstream reported before adding
    // this machine's own. `user-desktop` entries from OTHER users survive —
    // they are what tells the shell a teammate's desktop owns a branch.
    strip_hosted_sandbox_entries(entity);
    let local = local_sandbox_entries(state, &id);
    if !local.is_empty() {
        merge_sandbox_map(entity, user_id, local);
    }
}

/// Remove every non-`user-desktop` kind from `metadata.sandboxMap`, dropping
/// branch and user levels that empty out.
fn strip_hosted_sandbox_entries(entity: &mut Value) {
    let Some(by_user) = entity
        .get_mut("metadata")
        .and_then(|metadata| metadata.get_mut("sandboxMap"))
        .and_then(Value::as_object_mut)
    else {
        return;
    };
    by_user.retain(|_, by_branch| {
        let Some(by_branch) = by_branch.as_object_mut() else {
            return false;
        };
        by_branch.retain(|_, by_kind| {
            let Some(by_kind) = by_kind.as_object_mut() else {
                return false;
            };
            by_kind.retain(|kind, _| kind == "user-desktop");
            !by_kind.is_empty()
        });
        !by_branch.is_empty()
    });
}

/// `(branch, record)` for every sandbox on this machine that belongs to
/// `virtual_mcp_id`.
///
/// Reads the per-handle sidecars rather than the registry, because those carry
/// the `(virtual_mcp_id, branch)` the handle hashes away — there is no reverse
/// lookup from an agent to its handles.
/// This machine's sandboxes for `virtual_mcp_id`, in the
/// `agent-sandbox-sessions` wire shape.
///
/// Unlike [`local_sandbox_entries`], which publishes only sandboxes live in
/// THIS process (an entry there means "a VM is serving this branch"), a
/// session is a durable record: a stopped or failed sandbox is exactly what
/// the shell needs to show, so this reads the registry rather than the live
/// map.
pub(super) fn local_sandbox_sessions(state: &AppState, virtual_mcp_id: &str) -> Vec<Value> {
    if virtual_mcp_id.is_empty() {
        return Vec::new();
    }
    let mut sessions = Vec::new();
    for record in state
        .sandbox_manager
        .records_for_agent(virtual_mcp_id)
        .unwrap_or_default()
    {
        let handle = record.handle.clone();
        let stored = record.config.branch.as_deref();
        let branch = crate::sandbox::normalize_branch(stored);
        // A pre-rule row on `main`/`master` normalizes AWAY from its stored
        // branch: no lookup can reach it anymore, so listing it would offer a
        // dead entry. Hide it rather than render an unreachable sandbox.
        if stored.is_some_and(|stored| stored != branch) {
            continue;
        }
        // A preview origin is only meaningful while something is serving it,
        // and it is per-handle: each sandbox has its own host.
        let preview = preview_url(&handle);
        let preview_url = (record.observed_status == "running")
            .then_some(preview.as_deref())
            .flatten();
        sessions.push(super::agent_sessions::session_json(
            super::agent_sessions::LocalSession {
                virtual_mcp_id,
                branch,
                handle: &handle,
                preview_url,
                desired_status: &record.desired_status,
                observed_status: &record.observed_status,
                failure_reason: record.error.as_deref(),
                updated_at_rfc3339: crate::routes::threads::db::format_rfc3339(
                    std::time::Duration::from_secs(record.updated_at.max(0) as u64),
                ),
            },
        ));
    }
    sessions
}

fn local_sandbox_entries(state: &AppState, virtual_mcp_id: &str) -> Vec<(String, Value)> {
    if virtual_mcp_id.is_empty() {
        return Vec::new();
    }
    let mut entries = Vec::new();
    for record in state
        .sandbox_manager
        .records_for_agent(virtual_mcp_id)
        .unwrap_or_default()
    {
        let handle = record.handle;
        let config = record.config;
        {
            let stored = config.branch.as_deref();
            // Same unreachable-legacy-row rule as `local_sandbox_sessions`.
            if stored.is_some_and(|stored| stored != crate::sandbox::normalize_branch(Some(stored)))
            {
                continue;
            }
        }
        // Publish ONLY a sandbox that is live in this process — not merely one
        // the registry still has a row for.
        //
        // An entry in `sandboxMap` means "a VM is serving this branch": the
        // shell reads it as the preview origin, and its auto-start gate fires
        // only when the branch has NO entry. Publishing a registered-but-
        // stopped sandbox (every sandbox looks like that right after an app
        // restart) therefore told the shell someone was already serving, which
        // suppressed the very auto-start that would have revived it — the
        // sandbox stayed dead and the UI sat on its provisioning label until a
        // chat message happened to reach `ensure` through the dispatch path.
        //
        // Omitting a dead sandbox is self-correcting: the shell auto-starts,
        // `SANDBOX_START` ensures/adopts it here, and the next read publishes
        // it with a preview origin that is actually listening.
        if state.sandbox_manager.get(&handle).is_none() {
            continue;
        }
        let branch = config
            .branch
            .as_deref()
            .filter(|branch| !branch.is_empty())
            .unwrap_or(DEFAULT_BRANCH)
            .to_string();
        entries.push((
            branch,
            json!({
                "sandboxHandle": handle,
                "previewUrl": preview_url(&handle),
                // For user-desktop the daemon IS the preview origin.
                "sandboxApiUrl": preview_url(&handle),
                "sandboxProviderKind": "user-desktop",
            }),
        ));
    }
    entries
}

/// Merge `entries` into `entity.metadata.sandboxMap[user_id][branch]` under the
/// `user-desktop` key, creating the intermediate objects as needed and leaving
/// every other key untouched.
fn merge_sandbox_map(entity: &mut Value, user_id: &str, entries: Vec<(String, Value)>) {
    let Some(object) = entity.as_object_mut() else {
        return;
    };
    let metadata = object
        .entry("metadata")
        .or_insert_with(|| json!({}))
        .as_object_mut();
    let Some(metadata) = metadata else {
        return;
    };
    let by_user = metadata
        .entry("sandboxMap")
        .or_insert_with(|| json!({}))
        .as_object_mut();
    let Some(by_user) = by_user else {
        return;
    };
    let by_branch = by_user
        .entry(user_id.to_string())
        .or_insert_with(|| json!({}))
        .as_object_mut();
    let Some(by_branch) = by_branch else {
        return;
    };
    for (branch, record) in entries {
        let by_kind = by_branch
            .entry(branch)
            .or_insert_with(|| json!({}))
            .as_object_mut();
        if let Some(by_kind) = by_kind {
            by_kind.insert("user-desktop".to_string(), record);
        }
    }
}

/// `SANDBOX_DELETE` — stop the local sandbox behind `(virtualMcpId, branch)`.
///
/// Needs no upstream read: the handle is derived from the input alone. Deleting
/// an unknown handle is a success, matching the tool's idempotent `{ success }`
/// contract — the caller asked for it to be gone, and it is.
async fn delete(state: &AppState, body: &Bytes) -> Response {
    let input: Value = match crate::http_util::json_body(body) {
        Ok(value) => value,
        Err(error) => return error.into_response(),
    };
    let Some(virtual_mcp_id) = input.get("virtualMcpId").and_then(Value::as_str) else {
        return ApiError::bad_request("virtualMcpId is required").into_response();
    };
    let Some(branch) = input
        .get("branch")
        .and_then(Value::as_str)
        .filter(|b| !b.is_empty())
    else {
        return ApiError::bad_request("branch is required").into_response();
    };

    let Ok(Some(handle)) = state
        .sandbox_manager
        .handle_for_agent(virtual_mcp_id, branch)
    else {
        // Nothing registered for this agent+branch: deleting it is a no-op,
        // not an error, so a repeated delete stays idempotent.
        return Json(json!({ "success": true })).into_response();
    };
    match state.sandbox_manager.stop_registered(&handle).await {
        Ok(_) => Json(json!({ "success": true })).into_response(),
        Err(error) => {
            ApiError::internal(format!("could not stop the local sandbox: {error}")).into_response()
        }
    }
}

async fn start(state: &AppState, org: &str, body: &Bytes) -> Response {
    let input: Value = match crate::http_util::json_body(body) {
        Ok(value) => value,
        Err(error) => return error.into_response(),
    };
    let Some(virtual_mcp_id) = input.get("virtualMcpId").and_then(Value::as_str) else {
        return ApiError::bad_request("virtualMcpId is required").into_response();
    };
    let branch = input.get("branch").and_then(Value::as_str);

    let virtual_mcp = match upstream::call_org_tool(
        org,
        "COLLECTION_VIRTUAL_MCP_GET",
        &json!({ "id": virtual_mcp_id }),
    )
    .await
    {
        Ok(value) => value,
        Err(error) => {
            return ApiError::new(
                StatusCode::BAD_GATEWAY,
                format!("could not resolve the agent's repository: {error}"),
            )
            .into_response()
        }
    };

    // `COLLECTION_VIRTUAL_MCP_GET` answers `{ item: … }`; tolerate a bare
    // entity too rather than depending on the envelope shape alone.
    let entity = virtual_mcp.get("item").unwrap_or(&virtual_mcp);
    let metadata = entity.get("metadata").cloned().unwrap_or(Value::Null);

    let Some(config) = config_from_virtual_mcp(virtual_mcp_id, branch, &metadata, Some(org)) else {
        return ApiError::bad_request(
            "this agent has no git repository attached, so there is no sandbox to start",
        )
        .into_response();
    };
    let resolved_branch = crate::sandbox::normalize_branch(config.branch.as_deref()).to_string();
    let Some(handle) =
        crate::sandbox::SandboxManager::compute_handle(&config.clone_url, &resolved_branch)
    else {
        return ApiError::bad_request(format!(
            "this agent's repository URL cannot be scoped: {}",
            config.clone_url
        ))
        .into_response();
    };
    let existed = state
        .sandbox_manager
        .is_registered(&handle)
        .unwrap_or(false);

    if let Err(error) = state.sandbox_manager.ensure(&config).await {
        return ApiError::internal(format!("could not start the local sandbox: {error}"))
            .into_response();
    }

    // Derived from the manager AFTER `ensure`, so the value reported is the
    // one actually registered rather than the one this request happened to
    // ask for.
    let reported_branch = branch_for_virtual_mcp(state, virtual_mcp_id);

    Json(json!({
        "previewUrl": preview_url(&handle),
        "sandboxHandle": handle,
        "branch": reported_branch,
        "isNewVm": !existed,
        "sandboxProviderKind": "user-desktop",
    }))
    .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_repo_and_runtime_the_way_the_dispatch_block_did() {
        let metadata = json!({
            "githubRepo": { "url": "https://github.com/acme/site.git" },
            "runtime": { "selected": "pnpm", "path": "/usr/local/bin/pnpm" },
        });
        let cfg = config_from_virtual_mcp("vm-1", Some("feature"), &metadata, Some("acme"))
            .expect("a repo-backed virtual MCP yields a config");

        assert_eq!(cfg.virtual_mcp_id, "vm-1");
        assert_eq!(cfg.clone_url, "https://github.com/acme/site.git");
        assert_eq!(cfg.branch.as_deref(), Some("feature"));
        // pnpm is a package manager; the runtime driving it is node.
        assert_eq!(cfg.runtime.as_deref(), Some("node"));
        assert_eq!(cfg.package_manager.as_deref(), Some("pnpm"));
        assert_eq!(
            cfg.package_manager_path.as_deref(),
            Some("/usr/local/bin/pnpm")
        );
    }

    #[test]
    fn defaults_missing_empty_and_protected_branches_to_staging() {
        let metadata = json!({ "githubRepo": { "url": "https://github.com/acme/site.git" } });
        // The never-on-main rule: a protected branch is normalized away at
        // resolution, so a sandbox on `main` is impossible by construction —
        // including for a thread that PERSISTED `main` before the rule.
        for branch in [None, Some(""), Some("main"), Some("master")] {
            let cfg = config_from_virtual_mcp("vm-1", branch, &metadata, Some("acme")).unwrap();
            assert_eq!(cfg.branch.as_deref(), Some("staging"), "{branch:?}");
        }
        // An ordinary branch passes through untouched.
        let cfg =
            config_from_virtual_mcp("vm-1", Some("feature-x"), &metadata, Some("acme")).unwrap();
        assert_eq!(cfg.branch.as_deref(), Some("feature-x"));
    }

    #[test]
    fn no_config_without_a_clonable_repo() {
        // The plain-directory case: nothing to clone, so nothing to provision.
        for metadata in [
            json!({}),
            json!({ "githubRepo": {} }),
            json!({ "githubRepo": { "url": "" } }),
            Value::Null,
        ] {
            assert!(
                config_from_virtual_mcp("vm-1", Some("main"), &metadata, Some("acme")).is_none()
            );
        }
    }

    #[test]
    fn merge_sandbox_map_publishes_desktop_entries_without_disturbing_hosted_ones() {
        // merge_sandbox_map is a pure merge and never clobbers sibling kinds.
        // (In the enrich pipeline, hosted kinds are stripped BEFORE this merge
        // runs — see strip_hosted_sandbox_entries — so what this preserves in
        // practice is other users' user-desktop entries, not cloud rows.)
        let mut entity = json!({
            "id": "vm-1",
            "metadata": {
                "githubRepo": { "url": "https://github.com/acme/site" },
                "sandboxMap": {
                    "user-1": { "main": { "agent-sandbox": { "sandboxHandle": "cloud-1" } } }
                }
            }
        });
        merge_sandbox_map(
            &mut entity,
            "user-1",
            vec![(
                "main".to_string(),
                json!({ "sandboxHandle": "local-1", "previewUrl": "http://localhost:1/" }),
            )],
        );

        let branch = &entity["metadata"]["sandboxMap"]["user-1"]["main"];
        assert_eq!(branch["user-desktop"]["sandboxHandle"], "local-1");
        assert_eq!(branch["agent-sandbox"]["sandboxHandle"], "cloud-1");
        // Unrelated metadata survives — this is a merge, not a replacement.
        assert_eq!(
            entity["metadata"]["githubRepo"]["url"],
            "https://github.com/acme/site"
        );
    }

    /// Cloud sandboxes are invisible on desktop: hosted kinds are stripped
    /// from the upstream entity, while a TEAMMATE's desktop entry survives —
    /// it is what marks a branch as foreign-owned.
    #[test]
    fn hosted_sandbox_entries_are_stripped_and_desktop_ones_survive() {
        let mut entity = json!({
            "id": "vm-1",
            "metadata": {
                "sandboxMap": {
                    "user-1": {
                        "main": {
                            "agent-sandbox": { "sandboxHandle": "cloud-1" },
                            "sprite": { "sandboxHandle": "cloud-2" }
                        }
                    },
                    "user-2": {
                        "feature": { "user-desktop": { "sandboxHandle": "their-local" } },
                        "hosted-only": { "agent-sandbox": { "sandboxHandle": "cloud-3" } }
                    }
                }
            }
        });
        strip_hosted_sandbox_entries(&mut entity);

        let map = &entity["metadata"]["sandboxMap"];
        // user-1 had only hosted kinds — the whole user level empties out.
        assert!(map.get("user-1").is_none(), "{map}");
        assert_eq!(
            map["user-2"]["feature"]["user-desktop"]["sandboxHandle"],
            "their-local"
        );
        assert!(map["user-2"].get("hosted-only").is_none(), "{map}");
    }

    #[test]
    fn merge_sandbox_map_creates_the_whole_path_when_absent() {
        // The common desktop case: upstream has never provisioned anything, so
        // there is no metadata.sandboxMap at all to merge into.
        let mut entity = json!({ "id": "vm-1" });
        merge_sandbox_map(
            &mut entity,
            "user-1",
            vec![("feature".to_string(), json!({ "sandboxHandle": "h" }))],
        );
        assert_eq!(
            entity["metadata"]["sandboxMap"]["user-1"]["feature"]["user-desktop"]["sandboxHandle"],
            "h"
        );
    }

    #[test]
    fn preview_url_reports_the_listener_only_once_it_is_bound() {
        // Ordering matters: an unbound listener must report no preview URL
        // rather than a bogus `localhost:0`, which the shell would try to load.
        set_preview_port(0);
        assert_eq!(preview_url("h1"), None);

        set_preview_port(51_234);
        assert_eq!(
            preview_url("h1").as_deref(),
            Some("http://localhost:51234/")
        );
        set_preview_port(0);
    }

    /// Under a single-label host every handle would be its own SITE, which
    /// costs the preview iframe ALL cookie storage in WebKit — worse than one
    /// shared jar. So the per-handle form is gated on a real domain.
    /// An agent with no sandbox has no branch, and must not be reported as
    /// being on `main` — that claim is false AND indistinguishable from a real
    /// branch, which is how a default came to overwrite a live value and
    /// strand the UI on `main` after a restart.
    #[test]
    fn an_agent_without_a_sandbox_reports_the_ephemeral_branch() {
        // The sentinel must be distinguishable from any branch a repository
        // could actually have — `main` is not, which is the whole bug.
        assert_ne!(EPHEMERAL_BRANCH, DEFAULT_BRANCH);
        assert_ne!(EPHEMERAL_BRANCH, "main");
        assert!(!EPHEMERAL_BRANCH.is_empty());
    }

    #[test]
    fn handles_share_one_origin_until_a_real_domain_is_configured() {
        set_preview_port(51_234);
        assert_eq!(
            preview_url("alpha").as_deref(),
            Some("http://localhost:51234/")
        );
        assert_eq!(preview_url("alpha"), preview_url("beta"));
        set_preview_port(0);
    }

    #[test]
    fn unknown_package_manager_leaves_the_runtime_unset() {
        let metadata = json!({
            "githubRepo": { "url": "https://github.com/acme/site.git" },
            "runtime": { "selected": "cargo" },
        });
        let cfg = config_from_virtual_mcp("vm-1", None, &metadata, Some("acme")).unwrap();
        assert_eq!(cfg.package_manager.as_deref(), Some("cargo"));
        assert_eq!(cfg.runtime, None, "never guess a runtime we don't know");
    }
}
