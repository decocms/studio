//! Server-owned launch context for the interactive native coding agents.
//!
//! The webview chooses a harness and terminal dimensions. Everything with
//! authority or tenancy implications -- cwd, provider resume id, system
//! instructions, MCP endpoint and credentials, and hook configuration -- is
//! rebuilt here from the fenced local thread and the authenticated upstream
//! session.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime};

use harness::HarnessId;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::routes::threads::db::{RtThread, RtThreadFence, ThreadsDb};
use crate::state::AppState;
use crate::terminal::registry::PreparationCancellation;

const MCP_SERVER_NAME: &str = "cms";
const MCP_URL_ENV: &str = "DECOCMS_MCP_URL";
const MCP_AUTHORIZATION_ENV: &str = "DECOCMS_MCP_AUTHORIZATION";
const HOOK_URL_ENV: &str = "STUDIO_AGENT_HOOK_URL";
const HOOK_TOKEN_ENV: &str = "STUDIO_AGENT_HOOK_TOKEN";
const OPENCODE_CONFIG_CONTENT_ENV: &str = "OPENCODE_CONFIG_CONTENT";
const OPENCODE_RESUME_SESSION_ENV: &str = "STUDIO_OPENCODE_SESSION_ID";
const OPENCODE_AGENT_NAME_PREFIX: &str = "studio-native";
const NODE_EXTRA_CA_CERTS_ENV: &str = "NODE_EXTRA_CA_CERTS";
const CODEX_HOME_INITIALIZED_MARKER: &str = ".studio-initialized-v1";
const CODEX_PROFILE_PREFIX: &str = "studio-thread-";
const HOOK_FORWARDER_FILENAME: &str = "forward-hook.sh";
const MAX_CODEX_AUTH_BYTES: u64 = 4 * 1024 * 1024;
const MAX_CLAUDE_STATE_BYTES: u64 = 4 * 1024 * 1024;
const MAX_GIT_METADATA_BYTES: u64 = 64 * 1024;
const MAX_CLAUDE_STATE_SYMLINKS: usize = 16;
const CLAUDE_STATE_LOCK_RETRY_INTERVAL: Duration = Duration::from_millis(20);
const CLAUDE_STATE_LOCK_TIMEOUT: Duration = Duration::from_secs(2);
const CLAUDE_STATE_LOCK_STALE_AFTER: Duration = Duration::from_secs(10);
const CLAUDE_STATE_LOCK_UPDATE_INTERVAL: Duration = Duration::from_secs(2);
const CLAUDE_STATE_WRITE_ATTEMPTS: usize = 8;
const HOOK_FORWARDER_SCRIPT: &str = r#"#!/bin/sh
set +e
umask 077
payload=$(/usr/bin/mktemp "${TMPDIR:-/tmp}/studio-agent-hook.XXXXXX") || exit 0
trap '/bin/rm -f "$payload"' EXIT HUP INT TERM
/bin/cat >"$payload" || exit 0
if [ -z "${STUDIO_AGENT_HOOK_URL:-}" ] || [ -z "${STUDIO_AGENT_HOOK_TOKEN:-}" ]; then
  exit 0
fi
{
  /usr/bin/printf 'header = "Authorization: Bearer %s"\n' "$STUDIO_AGENT_HOOK_TOKEN"
  /usr/bin/printf 'header = "Content-Type: application/json"\n'
} | /usr/bin/curl -q --noproxy '*' --proto '=http,https' --silent --show-error --fail --connect-timeout 1 --max-time 2 \
  --config - --data-binary "@$payload" "$STUDIO_AGENT_HOOK_URL" >/dev/null 2>&1 || true
exit 0
"#;

// OpenCode loads this launch-scoped plugin from OPENCODE_CONFIG_CONTENT. It
// forwards only lifecycle events for the root session selected by this PTY;
// subagent sessions must never complete or fail the parent Studio chat. The
// hook is deliberately fail-open and bounded so a local control-plane restart
// cannot stall the coding agent.
const OPENCODE_LIFECYCLE_PLUGIN: &str = r#"const forwardedEvents = new Set([
  "session.created",
  "session.updated",
  "session.error",
  "session.status",
  "session.idle",
  "permission.asked",
  "permission.replied",
  "question.asked",
  "question.replied",
  "question.rejected",
]);

let rootSessionID = process.env.STUDIO_OPENCODE_SESSION_ID || null;
let activeTurnID = null;
let nextTurnID = 0;
let busyDelivered = false;
let delivery = Promise.resolve();

function eventSession(event) {
  const properties = event && event.properties;
  const info = properties && properties.info;
  const sessionID =
    (properties && properties.sessionID) || (info && info.id) || null;
  const parentID = info && info.parentID;
  return { sessionID, parentID };
}

function belongsToRoot(event) {
  const { sessionID, parentID } = eventSession(event);
  if (!sessionID || parentID) return false;
  if (!rootSessionID) {
    if (event.type !== "session.created") return false;
    rootSessionID = sessionID;
  }
  return sessionID === rootSessionID;
}

async function post(body) {
  const url = process.env.STUDIO_AGENT_HOOK_URL;
  const token = process.env.STUDIO_AGENT_HOOK_TOKEN;
  if (!url || !token) return false;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body,
      signal: AbortSignal.timeout(1000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function forward(event, turn = null) {
  const body = JSON.stringify({
    provider: "opencode",
    rootSessionID,
    ...(turn ? { turn } : {}),
    event,
  });
  if (await post(body)) return true;
  // One immediate retry keeps delivery bounded by the original two-second
  // hook budget. Stable root/turn identities make a lost response idempotent.
  return post(body);
}

async function handle(event) {
  if (!forwardedEvents.has(event && event.type) || !belongsToRoot(event)) return;
  const status = event.properties && event.properties.status;
  const isBusy =
    event.type === "session.status" &&
    (status && (status.type === "busy" || status.type === "retry"));
  const isTerminal =
    event.type === "session.idle" ||
    event.type === "session.error" ||
    (event.type === "session.status" && status && status.type === "idle");
  const requiresBusy =
    event.type === "permission.asked" ||
    event.type === "permission.replied" ||
    event.type === "question.asked" ||
    event.type === "question.replied" ||
    event.type === "question.rejected";

  if (isBusy) {
    if (activeTurnID === null) {
      activeTurnID = ++nextTurnID;
      busyDelivered = false;
    }
    if (busyDelivered) return;
    busyDelivered = await forward(event, {
      id: activeTurnID,
      phase: "busy",
    });
    return;
  } else if (isTerminal) {
    if (activeTurnID === null) return;
    const terminalTurnID = activeTurnID;
    await forward(event, {
      id: terminalTurnID,
      phase: "terminal",
    });
    // The provider turn is over even if both bounded HTTP responses were lost.
    // Retaining it would suppress the next turn's busy event and reuse a
    // server-completed id. Delivery remains best-effort; a stable id is used
    // for both attempts inside forward().
    if (activeTurnID === terminalTurnID) {
      activeTurnID = null;
      busyDelivered = false;
    }
    return;
  } else if (requiresBusy) {
    if (activeTurnID === null) return;
    await forward(event, { id: activeTurnID, phase: "active" });
    return;
  }
  await forward(event);
}

export const StudioNativeLifecycle = async () => ({
  event: ({ event } = {}) => {
    delivery = delivery.then(() => handle(event), () => handle(event));
    return delivery;
  },
});
"#;

const NATIVE_AGENT_INSTRUCTIONS: &str = r#"You are operating inside Studio Native as an interactive coding agent.

Use the selected Studio `cms` MCP server for organization-scoped tools and data. Treat the current working directory as the user's selected coding workspace. Do not claim that a file, deployment, or organization resource changed until the corresponding tool or filesystem operation succeeded. Keep credentials and local control-plane details private: never print environment variables, cookies, hook tokens, or MCP authentication headers."#;

const HOOK_EVENTS: &[&str] = &[
    "SessionStart",
    "SessionEnd",
    "UserPromptSubmit",
    "PreToolUse",
    "PermissionRequest",
    "Notification",
    "PostToolUse",
    "PostToolUseFailure",
    "Stop",
    "StopFailure",
];

/// Provider-neutral process description. Secrets are held only in `env`; the
/// debug representation deliberately prints only environment variable names.
#[derive(Clone)]
pub struct PreparedLaunch {
    pub harness: HarnessId,
    pub program: String,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub env: Vec<(String, String)>,
    pub title_environment: harness::title::TitleEnvironment,
    pub provider_session_id: Option<String>,
    /// Exact encoded local path the per-terminal MCP bearer is allowed to
    /// reach. Keeping it beside the prepared URL prevents the provider
    /// configuration and registry guard from drifting.
    pub mcp_path: String,
    claude_workspace_trust: Option<ClaudeWorkspaceTrust>,
    codex_hook_trust: Option<CodexHookTrust>,
}

#[derive(Clone, Debug)]
struct ClaudeWorkspaceTrust {
    state_path: PathBuf,
    project_key: String,
}

#[derive(Clone, Debug)]
struct CodexHookTrust {
    prefix_argv: Vec<String>,
    codex_home: PathBuf,
    managed_command: String,
}

#[derive(Debug, PartialEq, Eq)]
struct WorkspaceTrustRoots {
    claude: PathBuf,
    codex: PathBuf,
}

impl std::fmt::Debug for PreparedLaunch {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("PreparedLaunch")
            .field("harness", &self.harness)
            .field("program", &self.program)
            .field("args", &self.args)
            .field("cwd", &self.cwd)
            .field(
                "env_keys",
                &self.env.iter().map(|(key, _)| key).collect::<Vec<_>>(),
            )
            .field("has_provider_session", &self.provider_session_id.is_some())
            .field(
                "has_managed_workspace_trust",
                &self.claude_workspace_trust.is_some(),
            )
            .field("has_managed_hook_trust", &self.codex_hook_trust.is_some())
            .finish()
    }
}

impl PreparedLaunch {
    pub(crate) fn claude_state_path(&self) -> Option<&Path> {
        self.claude_workspace_trust
            .as_ref()
            .map(|trust| trust.state_path.as_path())
    }

    pub(crate) fn ensure_workspace_trusted_blocking(&self) -> Result<(), LaunchContextError> {
        let Some(trust) = &self.claude_workspace_trust else {
            return Ok(());
        };
        ensure_claude_workspace_trusted(&trust.state_path, &trust.project_key)?;
        Ok(())
    }

    pub(crate) async fn establish_managed_codex_hook_trust(
        &self,
        state: &AppState,
        account_scope: &str,
        account_guard: upstream::SessionTransitionGuard,
    ) -> Result<upstream::SessionTransitionGuard, LaunchContextError> {
        let Some(trust) = &self.codex_hook_trust else {
            return Ok(account_guard);
        };
        let home_guard = state
            .agent_sessions
            .codex_home_lock(account_scope)
            .lock_owned()
            .await;
        super::codex_hook_trust::establish_managed_hook_trust(
            super::codex_hook_trust::ManagedHookTrustRequest {
                program: &self.program,
                prefix_argv: &trust.prefix_argv,
                codex_home: &trust.codex_home,
                cwd: &self.cwd,
                managed_command: &trust.managed_command,
                child_lifetime_lock_path: state.tasks.child_lifetime_lock_path(),
                home_guard,
                account_guard,
            },
        )
        .await
        .map_err(|error| LaunchContextError::Workspace(error.to_string()))
    }
}

#[derive(Debug, thiserror::Error)]
pub enum LaunchContextError {
    #[error("coding agent preparation was canceled")]
    Canceled,
    #[error("thread is no longer available")]
    StaleThread,
    #[error("the selected agent is unavailable: {0}")]
    Harness(#[from] harness::ResolveError),
    #[error("could not load the selected Studio agent: {0}")]
    VirtualMcp(String),
    #[error("the local Studio MCP endpoint is not ready")]
    LocalEndpointUnavailable,
    #[error("could not load coding agent storage: {0}")]
    Storage(String),
    #[error("could not prepare the coding agent sandbox: {0}")]
    Sandbox(String),
    #[error("could not prepare the agent workspace: {0}")]
    Workspace(String),
    #[error("could not prepare managed agent configuration: {0}")]
    Artifacts(#[from] std::io::Error),
    #[error("could not encode managed agent configuration: {0}")]
    Json(#[from] serde_json::Error),
}

#[derive(Clone, Copy)]
pub struct LaunchRequest<'a> {
    pub fence: &'a RtThreadFence,
    pub terminal_session_id: &'a str,
    pub harness: HarnessId,
    pub approval_mode: &'a str,
    pub plan_mode: bool,
    pub hook_token: &'a str,
    pub mcp_token: &'a str,
    /// Newest checkpoint read before the new `starting` row is reserved.
    pub provider_session_id: Option<&'a str>,
    pub cancellation: &'a PreparationCancellation,
    pub account_epoch: crate::sandbox::manager::AccountEpoch,
    pub identity_generation: u64,
}

pub async fn prepare(
    state: &AppState,
    db: &'static ThreadsDb,
    request: LaunchRequest<'_>,
) -> Result<PreparedLaunch, LaunchContextError> {
    require_account_epoch(state, request.account_epoch)?;
    require_active_preparation(request.cancellation)?;
    let thread = db
        .rt_get_thread_for_fence(request.fence)
        .map_err(|error| LaunchContextError::Storage(error.to_string()))?
        .ok_or(LaunchContextError::StaleThread)?;
    let mut argv = harness::resolve_checked(request.harness)?;
    // The picker consumes the same compatibility probe, but repeat it at the
    // process boundary so a stale renderer or direct WebSocket request cannot
    // launch an installed-yet-unsupported provider.
    tokio::select! {
        biased;
        () = request.cancellation.cancelled() => return Err(LaunchContextError::Canceled),
        result = harness::detect::require_launch_ready(request.harness, &argv) => {
            result?;
        },
    }
    require_account_epoch(state, request.account_epoch)?;
    let virtual_mcp = load_virtual_mcp(
        state,
        request.fence,
        &thread,
        request.cancellation,
        request.account_epoch,
        request.identity_generation,
    )
    .await?;
    require_active_preparation(request.cancellation)?;
    let cwd = resolve_cwd(
        state,
        request.fence,
        &thread,
        &virtual_mcp,
        request.cancellation,
        request.account_epoch,
    )
    .await?;
    require_active_preparation(request.cancellation)?;
    let system_prompt = tokio::select! {
        biased;
        () = request.cancellation.cancelled() => return Err(LaunchContextError::Canceled),
        prompt = build_system_prompt(state, request.fence, &thread, &virtual_mcp, &cwd) => prompt,
    };
    require_active_preparation(request.cancellation)?;
    let credentials = crate::sandbox::org_mount::local_credentials()
        .cloned()
        .ok_or(LaunchContextError::LocalEndpointUnavailable)?;
    let provider_session_id = request.provider_session_id.map(str::to_string);
    let mut claude_workspace_trust = None;
    let mut codex_hook_trust = None;

    let state_dir = managed_state_dir(&state.app_root, request.fence);
    // Managed filesystem operations run to completion inside the preparation
    // phase. Dropping a Tokio filesystem future on cancellation can leave its
    // blocking worker writing after lifecycle cleanup has already returned.
    require_account_epoch(state, request.account_epoch)?;
    create_private_dir(&state_dir).await?;
    require_account_epoch(state, request.account_epoch)?;
    require_active_preparation(request.cancellation)?;
    let hook_url = format!(
        "{}/_local/agent-hooks/{}",
        credentials.base_url, request.terminal_session_id
    );
    let mcp_path = local_mcp_path(&request.fence.organization_id, &thread.virtual_mcp_id);
    let mcp_url = local_mcp_url(
        &credentials.base_url,
        &request.fence.organization_id,
        &thread.virtual_mcp_id,
    );
    let mut env = vec![
        (MCP_URL_ENV.to_string(), mcp_url.clone()),
        (
            MCP_AUTHORIZATION_ENV.to_string(),
            format!("Bearer {}", request.mcp_token),
        ),
        (HOOK_URL_ENV.to_string(), hook_url),
        (HOOK_TOKEN_ENV.to_string(), request.hook_token.to_string()),
    ];
    if let Some(ca_cert) = credentials.ca_cert {
        env.push((
            NODE_EXTRA_CA_CERTS_ENV.to_string(),
            ca_cert.display().to_string(),
        ));
    }

    let program = argv.remove(0);
    let mut title_environment = harness::title::TitleEnvironment::default();
    match request.harness {
        HarnessId::ClaudeCode => {
            let trust_roots = tokio::select! {
                biased;
                () = request.cancellation.cancelled() => return Err(LaunchContextError::Canceled),
                roots = workspace_trust_roots(&cwd) => roots?,
            };
            let project_key = trust_roots
                .claude
                .to_str()
                .ok_or_else(|| {
                    LaunchContextError::Workspace(
                        "Claude workspace trust path is not valid UTF-8".to_string(),
                    )
                })?
                .to_string();
            let state_path = tokio::select! {
                biased;
                () = request.cancellation.cancelled() => return Err(LaunchContextError::Canceled),
                path = claude_state_path(&cwd) => path?,
            };
            claude_workspace_trust = Some(ClaudeWorkspaceTrust {
                state_path,
                project_key,
            });
            // Claude settings are thread-owned, so deletion removes the
            // complete overlay without affecting another chat.
            require_active_preparation(request.cancellation)?;
            let hook_script = ensure_hook_forwarder(&state_dir, request.cancellation).await?;
            require_active_preparation(request.cancellation)?;
            prepare_claude(
                &state_dir,
                &hook_script,
                &system_prompt,
                request,
                provider_session_id.as_deref(),
                &mut argv,
            )
            .await?;
            require_active_preparation(request.cancellation)?;
        }
        HarnessId::Codex => {
            let trust_roots = tokio::select! {
                biased;
                () = request.cancellation.cancelled() => return Err(LaunchContextError::Canceled),
                roots = workspace_trust_roots(&cwd) => roots?,
            };
            let codex_prefix_argv = argv.clone();
            // Codex refreshes auth.json by replacing it. All chats for one
            // Studio account therefore share a regular, account-owned home;
            // a per-thread symlink/copy would strand refreshed credentials in
            // only the process that happened to refresh first.
            let home_lock = state
                .agent_sessions
                .codex_home_lock(&request.fence.account_scope);
            let home_guard = tokio::select! {
                biased;
                () = request.cancellation.cancelled() => return Err(LaunchContextError::Canceled),
                guard = home_lock.lock_owned() => guard,
            };
            require_active_preparation(request.cancellation)?;
            let codex_home = prepare_codex(
                &state.app_root,
                &system_prompt,
                request,
                &mut argv,
                provider_session_id.as_deref(),
                &mcp_url,
                &trust_roots.codex,
            )
            .await?;
            require_active_preparation(request.cancellation)?;
            let managed_hook_command = shell_quote_path(
                &codex_home
                    .join("studio-runtime")
                    .join(HOOK_FORWARDER_FILENAME),
            );
            codex_hook_trust = Some(CodexHookTrust {
                prefix_argv: codex_prefix_argv,
                codex_home: codex_home.clone(),
                managed_command: managed_hook_command,
            });
            drop(home_guard);
            title_environment =
                harness::title::TitleEnvironment::for_codex_home(codex_home.clone());
            env.push(("CODEX_HOME".to_string(), codex_home.display().to_string()));
        }
        HarnessId::OpenCode => {
            require_active_preparation(request.cancellation)?;
            let config = prepare_opencode(
                &state_dir,
                &system_prompt,
                request,
                &mut argv,
                provider_session_id.as_deref(),
            )
            .await?;
            require_active_preparation(request.cancellation)?;
            env.push((OPENCODE_CONFIG_CONTENT_ENV.to_string(), config));
            // Override ambient shell/dev-runner state on fresh launches too.
            // Otherwise an inherited stale resume id would make the plugin
            // reject every session event from the newly-created root.
            env.push(opencode_resume_environment(provider_session_id.as_deref()));
        }
    }

    require_account_epoch(state, request.account_epoch)?;
    require_active_preparation(request.cancellation)?;

    Ok(PreparedLaunch {
        harness: request.harness,
        program,
        args: argv,
        cwd,
        env,
        title_environment,
        provider_session_id,
        mcp_path,
        claude_workspace_trust,
        codex_hook_trust,
    })
}

async fn load_virtual_mcp(
    state: &AppState,
    fence: &RtThreadFence,
    thread: &RtThread,
    cancellation: &PreparationCancellation,
    account_epoch: crate::sandbox::manager::AccountEpoch,
    identity_generation: u64,
) -> Result<Value, LaunchContextError> {
    let input = json!({ "id": thread.virtual_mcp_id });
    let response = tokio::select! {
        biased;
        () = cancellation.cancelled() => return Err(LaunchContextError::Canceled),
        response = crate::routes::upstream::call_org_tool_for_identity(
            state,
            account_epoch,
            identity_generation,
            &fence.organization_id,
            "COLLECTION_VIRTUAL_MCP_GET",
            &input,
        ) => match response {
            Ok(response) => response,
            Err(crate::routes::upstream::OrgToolCallError::StaleIdentity) => {
                return Err(LaunchContextError::Canceled);
            }
            Err(error) => return Err(LaunchContextError::VirtualMcp(error.to_string())),
        },
    };
    require_active_preparation(cancellation)?;
    virtual_mcp_entity(response).map_err(|error| LaunchContextError::VirtualMcp(error.to_string()))
}

fn virtual_mcp_entity(response: Value) -> Result<Value, &'static str> {
    match response {
        Value::Object(mut object) => {
            if let Some(item) = object.remove("item") {
                return item
                    .is_object()
                    .then_some(item)
                    .ok_or("selected Studio agent response item must be an object");
            }
            // Older/local fixtures may return the entity directly. An empty
            // object is not an entity and would otherwise launch with a broken
            // selected MCP while looking superficially successful.
            (!object.is_empty())
                .then_some(Value::Object(object))
                .ok_or("selected Studio agent response is missing an object item")
        }
        _ => Err("selected Studio agent response must be an object"),
    }
}

async fn resolve_cwd(
    state: &AppState,
    fence: &RtThreadFence,
    thread: &RtThread,
    virtual_mcp: &Value,
    cancellation: &PreparationCancellation,
    account_epoch: crate::sandbox::manager::AccountEpoch,
) -> Result<PathBuf, LaunchContextError> {
    let sandbox_branch = crate::sandbox::normalize_branch(thread.branch.as_deref());
    let teardown_on_cancel = match crate::sandbox::synthetic_thread_id(sandbox_branch) {
        Ok(Some(thread_id)) if thread_id == fence.thread_id => true,
        Ok(Some(_)) => {
            return Err(LaunchContextError::Workspace(
                "thread-backed sandbox branch belongs to a different chat".to_string(),
            ))
        }
        Ok(None) => false,
        Err(error) => return Err(LaunchContextError::Workspace(error.to_string())),
    };
    if let Some(mut config) = crate::routes::intercept::config_from_virtual_mcp(
        &thread.virtual_mcp_id,
        thread.branch.as_deref(),
        virtual_mcp.get("metadata").unwrap_or(&Value::Null),
        Some(&fence.organization_id),
    ) {
        config
            .org_slug
            .get_or_insert_with(|| fence.organization_id.clone());
        return state
            .sandbox_manager
            .ensure_for_terminal(
                account_epoch,
                &config,
                cancellation.subscribe(),
                teardown_on_cancel,
            )
            .await
            .map(|sandbox| sandbox.workdir.clone())
            .map_err(|error| match error {
                crate::sandbox::manager::TerminalEnsureError::Canceled => {
                    LaunchContextError::Canceled
                }
                crate::sandbox::manager::TerminalEnsureError::Failed(error) => {
                    LaunchContextError::Sandbox(error)
                }
            });
    }

    require_active_preparation(cancellation)?;
    require_account_epoch(state, account_epoch)?;
    let org_dir = crate::sandbox::org_view::org_mount_root(&state.app_root, &fence.organization_id)
        .ok_or_else(|| LaunchContextError::Workspace("invalid organization path".to_string()))?;
    crate::sandbox::org_mount::warm(&state.app_root, &fence.organization_id);
    tokio::fs::create_dir_all(&org_dir).await?;
    require_active_preparation(cancellation)?;
    Ok(org_dir)
}

fn require_account_epoch(
    state: &AppState,
    account_epoch: crate::sandbox::manager::AccountEpoch,
) -> Result<(), LaunchContextError> {
    state
        .sandbox_manager
        .validate_account_epoch(account_epoch)
        .map_err(|_| LaunchContextError::Canceled)
}

fn require_active_preparation(
    cancellation: &PreparationCancellation,
) -> Result<(), LaunchContextError> {
    if cancellation.is_cancelled() {
        Err(LaunchContextError::Canceled)
    } else {
        Ok(())
    }
}

async fn build_system_prompt(
    state: &AppState,
    fence: &RtThreadFence,
    thread: &RtThread,
    virtual_mcp: &Value,
    cwd: &Path,
) -> String {
    let mut sections = vec![NATIVE_AGENT_INSTRUCTIONS.to_string()];
    if let Some(instructions) = virtual_mcp
        .pointer("/metadata/instructions")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|instructions| !instructions.is_empty())
    {
        sections.push(format!(
            "<studio-agent-instructions>\n{instructions}\n</studio-agent-instructions>"
        ));
    }

    let org_dir = crate::sandbox::org_view::org_mount_root(&state.app_root, &fence.organization_id)
        .filter(|path| path == cwd)
        .or_else(|| cwd.parent().map(|parent| parent.join("org")));
    if let Some(org_dir) = org_dir.filter(|path| path.exists()) {
        sections.push(crate::sandbox::org_prompt::build(
            &org_dir,
            &fence.thread_id,
            Some(&thread.created_by),
        ));
    }
    sections.join("\n\n")
}

async fn prepare_claude(
    state_dir: &Path,
    hook_script: &Path,
    system_prompt: &str,
    request: LaunchRequest<'_>,
    provider_session_id: Option<&str>,
    argv: &mut Vec<String>,
) -> Result<(), LaunchContextError> {
    require_active_preparation(request.cancellation)?;
    let prompt_path = state_dir.join("claude-system-prompt.txt");
    write_private_file(&prompt_path, system_prompt.as_bytes(), false).await?;
    require_active_preparation(request.cancellation)?;
    let settings_path = state_dir.join("claude-hooks.json");
    let settings = claude_hook_settings(hook_script);
    write_private_file(&settings_path, &serde_json::to_vec(&settings)?, false).await?;
    require_active_preparation(request.cancellation)?;

    argv.extend([
        "--append-system-prompt-file".to_string(),
        prompt_path.display().to_string(),
        "--mcp-config".to_string(),
        claude_mcp_config(),
        "--strict-mcp-config".to_string(),
        "--settings".to_string(),
        settings_path.display().to_string(),
    ]);
    append_claude_launch_args(request, provider_session_id, argv);
    Ok(())
}

fn append_claude_launch_args(
    request: LaunchRequest<'_>,
    provider_session_id: Option<&str>,
    argv: &mut Vec<String>,
) {
    if request.plan_mode || request.approval_mode == "readonly" {
        argv.extend(["--permission-mode".to_string(), "plan".to_string()]);
    } else {
        argv.extend([
            "--permission-mode".to_string(),
            "bypassPermissions".to_string(),
        ]);
    }
    if let Some(provider_session_id) = provider_session_id {
        argv.extend(["--resume".to_string(), provider_session_id.to_string()]);
    }
}

async fn prepare_codex(
    app_root: &Path,
    system_prompt: &str,
    request: LaunchRequest<'_>,
    argv: &mut Vec<String>,
    provider_session_id: Option<&str>,
    mcp_url: &str,
    trust_root: &Path,
) -> Result<PathBuf, LaunchContextError> {
    let config = codex_config(system_prompt, mcp_url);
    let (codex_home, profile_name) = prepare_codex_managed_files(
        app_root,
        request.fence,
        codex_auth_source_path().as_deref(),
        &config,
        request.cancellation,
    )
    .await?;

    append_codex_launch_args(request, argv, provider_session_id, trust_root, profile_name)?;
    Ok(codex_home)
}

fn append_codex_launch_args(
    request: LaunchRequest<'_>,
    argv: &mut Vec<String>,
    provider_session_id: Option<&str>,
    trust_root: &Path,
    profile_name: String,
) -> Result<(), LaunchContextError> {
    argv.extend([
        "-c".to_string(),
        codex_workspace_trust_override(trust_root)?,
        "--no-alt-screen".to_string(),
        "--profile".to_string(),
        profile_name,
        "--disable".to_string(),
        "apps".to_string(),
        "--disable".to_string(),
        "plugins".to_string(),
    ]);
    if request.plan_mode || request.approval_mode == "readonly" {
        argv.extend(["--sandbox".to_string(), "read-only".to_string()]);
    } else {
        argv.push("--dangerously-bypass-approvals-and-sandbox".to_string());
    }
    if let Some(provider_session_id) = provider_session_id {
        argv.extend(["resume".to_string(), provider_session_id.to_string()]);
    }
    Ok(())
}

async fn prepare_opencode(
    state_dir: &Path,
    system_prompt: &str,
    request: LaunchRequest<'_>,
    argv: &mut Vec<String>,
    provider_session_id: Option<&str>,
) -> Result<String, LaunchContextError> {
    require_active_preparation(request.cancellation)?;
    let plugin_path = state_dir.join("opencode-lifecycle.js");
    write_private_file(&plugin_path, OPENCODE_LIFECYCLE_PLUGIN.as_bytes(), false).await?;
    require_active_preparation(request.cancellation)?;
    let plugin_url = reqwest::Url::from_file_path(&plugin_path).map_err(|()| {
        LaunchContextError::Workspace(format!(
            "could not encode OpenCode lifecycle plugin path: {}",
            plugin_path.display()
        ))
    })?;
    let readonly = request.plan_mode || request.approval_mode == "readonly";
    // OpenCode deep-merges inline config with global/project config. A
    // launch-unique name prevents a user-defined `studio-native` agent (and
    // its disable/permission fields) from weakening this managed overlay.
    let agent_name = opencode_agent_name(request.terminal_session_id);
    let config = opencode_config(system_prompt, plugin_url.as_str(), &agent_name, readonly);

    argv.extend(["--agent".to_string(), agent_name]);
    if !readonly {
        argv.push("--auto".to_string());
    }
    if let Some(provider_session_id) = provider_session_id {
        argv.extend(["--session".to_string(), provider_session_id.to_string()]);
    }
    Ok(config)
}

fn opencode_agent_name(terminal_session_id: &str) -> String {
    format!("{OPENCODE_AGENT_NAME_PREFIX}-{terminal_session_id}")
}

fn opencode_resume_environment(provider_session_id: Option<&str>) -> (String, String) {
    (
        OPENCODE_RESUME_SESSION_ENV.to_string(),
        provider_session_id.unwrap_or_default().to_string(),
    )
}

fn local_mcp_url(base_url: &str, organization_id: &str, virtual_mcp_id: &str) -> String {
    format!(
        "{base_url}{}",
        local_mcp_path(organization_id, virtual_mcp_id)
    )
}

fn local_mcp_path(organization_id: &str, virtual_mcp_id: &str) -> String {
    format!(
        "/api/{}/mcp/{}",
        urlencoding::encode(organization_id),
        urlencoding::encode(virtual_mcp_id),
    )
}

fn claude_mcp_config() -> String {
    json!({
        "mcpServers": {
            MCP_SERVER_NAME: {
                "type": "http",
                "url": format!("${{{MCP_URL_ENV}}}"),
                "headers": {
                    "Authorization": format!("${{{MCP_AUTHORIZATION_ENV}}}"),
                },
            }
        }
    })
    .to_string()
}

fn claude_hook_settings(hook_script: &Path) -> Value {
    let command = shell_quote_path(hook_script);
    let hook = || {
        json!([{
            "hooks": [{
                "type": "command",
                "command": command.clone(),
                "timeout": 3,
            }]
        }])
    };
    let mut hooks = serde_json::Map::new();
    for event in HOOK_EVENTS {
        hooks.insert((*event).to_string(), hook());
    }
    json!({ "hooks": hooks })
}

fn codex_hook_settings(hook_script: &Path) -> Value {
    let command = shell_quote_path(hook_script);
    let mut hooks = serde_json::Map::new();
    for event in super::codex_hook_trust::CODEX_HOOK_EVENTS {
        hooks.insert(
            event.config_name.to_string(),
            json!([{
                "hooks": [{
                    "type": "command",
                    "command": command.clone(),
                    "timeout": super::codex_hook_trust::MANAGED_HOOK_TIMEOUT_SECS,
                }]
            }]),
        );
    }
    json!({ "hooks": hooks })
}

fn codex_config(system_prompt: &str, mcp_url: &str) -> String {
    let instructions = serde_json::to_string(system_prompt)
        .expect("serializing an in-memory string to JSON cannot fail");
    let mcp_url = serde_json::to_string(mcp_url).expect("serializing an in-memory URL cannot fail");
    format!(
        "developer_instructions = {instructions}\n\
         [features]\n\
         hooks = true\n\
         [tui]\n\
         show_tooltips = false\n\
         [mcp_servers.{MCP_SERVER_NAME}]\n\
         url = {mcp_url}\n\
         [mcp_servers.{MCP_SERVER_NAME}.env_http_headers]\n\
         Authorization = \"{MCP_AUTHORIZATION_ENV}\"\n"
    )
}

fn codex_workspace_trust_override(trust_root: &Path) -> Result<String, LaunchContextError> {
    let trust_root = trust_root.to_str().ok_or_else(|| {
        LaunchContextError::Workspace("Codex workspace trust path is not valid UTF-8".to_string())
    })?;
    let quoted = serde_json::to_string(trust_root)
        .expect("serializing an in-memory path string to JSON cannot fail");
    // Codex's CLI override parser splits dotted keys literally rather than as
    // TOML. Put the path in an inline-table value so quoting is parsed by TOML
    // and the exact project key reaches the trust lookup.
    Ok(format!(
        "projects={{ {quoted} = {{ trust_level = \"trusted\" }} }}"
    ))
}

async fn claude_state_path(cwd: &Path) -> Result<PathBuf, std::io::Error> {
    let explicit_config_dir = std::env::var_os("CLAUDE_CONFIG_DIR");
    let home = std::env::var_os("HOME").map(PathBuf::from).ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "HOME is unavailable while resolving Claude state",
        )
    })?;
    let config_dir = claude_config_dir(cwd, explicit_config_dir.as_deref(), &home);
    let legacy_state = config_dir.join(".config.json");
    let legacy_exists = match tokio::fs::symlink_metadata(&legacy_state).await {
        Ok(_) => true,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => return Err(error),
    };
    let custom_oauth = std::env::var_os("CLAUDE_CODE_CUSTOM_OAUTH_URL")
        .filter(|value| !value.is_empty())
        .is_some();
    let path = claude_state_path_from(
        cwd,
        explicit_config_dir.as_deref(),
        &home,
        legacy_exists,
        custom_oauth,
    );
    Ok(canonicalize_parent(&path).await)
}

fn claude_config_dir(
    cwd: &Path,
    explicit_config_dir: Option<&std::ffi::OsStr>,
    home: &Path,
) -> PathBuf {
    explicit_config_dir
        .map(|path| absolute_from(cwd, Path::new(path)))
        .unwrap_or_else(|| home.join(".claude"))
}

fn claude_state_path_from(
    cwd: &Path,
    explicit_config_dir: Option<&std::ffi::OsStr>,
    home: &Path,
    legacy_exists: bool,
    custom_oauth: bool,
) -> PathBuf {
    if legacy_exists {
        return claude_config_dir(cwd, explicit_config_dir, home).join(".config.json");
    }
    let state_parent = explicit_config_dir
        .filter(|path| !path.is_empty())
        .map(|path| absolute_from(cwd, Path::new(path)))
        .unwrap_or_else(|| home.to_path_buf());
    let suffix = if custom_oauth { "-custom-oauth" } else { "" };
    state_parent.join(format!(".claude{suffix}.json"))
}

fn absolute_from(base: &Path, path: &Path) -> PathBuf {
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        base.join(path)
    }
}

async fn canonicalize_parent(path: &Path) -> PathBuf {
    let Some(parent) = path.parent() else {
        return path.to_path_buf();
    };
    match tokio::fs::canonicalize(parent).await {
        Ok(parent) => parent.join(path.file_name().unwrap_or_default()),
        Err(_) => path.to_path_buf(),
    }
}

async fn workspace_trust_roots(cwd: &Path) -> Result<WorkspaceTrustRoots, std::io::Error> {
    let cwd = tokio::fs::canonicalize(cwd).await?;
    let mut ancestor = cwd.as_path();
    let (repository_root, dot_git) = loop {
        let dot_git = ancestor.join(".git");
        match tokio::fs::symlink_metadata(&dot_git).await {
            Ok(metadata) if metadata.is_dir() => {
                let repository_root = tokio::fs::canonicalize(ancestor).await?;
                return Ok(WorkspaceTrustRoots {
                    claude: repository_root.clone(),
                    codex: repository_root,
                });
            }
            Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => {
                break (tokio::fs::canonicalize(ancestor).await?, dot_git);
            }
            Ok(_) => {
                return Ok(WorkspaceTrustRoots {
                    claude: cwd.clone(),
                    codex: cwd,
                });
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => {
                return Ok(WorkspaceTrustRoots {
                    claude: cwd.clone(),
                    codex: cwd,
                });
            }
        }
        let Some(parent) = ancestor.parent() else {
            return Ok(WorkspaceTrustRoots {
                claude: cwd.clone(),
                codex: cwd,
            });
        };
        ancestor = parent;
    };

    let fallback = || WorkspaceTrustRoots {
        claude: repository_root.clone(),
        codex: cwd.clone(),
    };
    let Some(dot_git_contents) = read_small_regular_utf8(&dot_git).await else {
        return Ok(fallback());
    };
    let Some(git_dir_reference) = dot_git_contents.trim().strip_prefix("gitdir:") else {
        return Ok(fallback());
    };
    let git_dir_reference = git_dir_reference.trim();
    if git_dir_reference.is_empty() {
        return Ok(fallback());
    }
    let Ok(git_dir) = tokio::fs::canonicalize(absolute_from(
        &repository_root,
        Path::new(git_dir_reference),
    ))
    .await
    else {
        return Ok(fallback());
    };
    let Some(worktrees_dir) = git_dir.parent() else {
        return Ok(fallback());
    };
    if worktrees_dir.file_name() != Some(std::ffi::OsStr::new("worktrees")) {
        return Ok(fallback());
    }

    let Some(backlink_contents) = read_small_regular_utf8(&git_dir.join("gitdir")).await else {
        return Ok(fallback());
    };
    let backlink_reference = backlink_contents.trim();
    if backlink_reference.is_empty() {
        return Ok(fallback());
    }
    let Ok(backlink) =
        tokio::fs::canonicalize(absolute_from(&git_dir, Path::new(backlink_reference))).await
    else {
        return Ok(fallback());
    };
    let Ok(dot_git_canonical) = tokio::fs::canonicalize(&dot_git).await else {
        return Ok(fallback());
    };
    if backlink != dot_git_canonical {
        return Ok(fallback());
    }

    let Some(common_dir_contents) = read_small_regular_utf8(&git_dir.join("commondir")).await
    else {
        return Ok(fallback());
    };
    let common_dir_reference = common_dir_contents.trim();
    if common_dir_reference.is_empty() {
        return Ok(fallback());
    }
    let Ok(common_dir) =
        tokio::fs::canonicalize(absolute_from(&git_dir, Path::new(common_dir_reference))).await
    else {
        return Ok(fallback());
    };
    if worktrees_dir.parent() != Some(common_dir.as_path()) {
        return Ok(fallback());
    }

    let Some(codex_root) = common_dir.parent() else {
        return Ok(fallback());
    };
    let codex_root = tokio::fs::canonicalize(codex_root).await?;
    let claude_root = if common_dir.file_name() == Some(std::ffi::OsStr::new(".git")) {
        let Some(repository) = common_dir.parent() else {
            return Ok(fallback());
        };
        tokio::fs::canonicalize(repository).await?
    } else {
        common_dir
    };
    Ok(WorkspaceTrustRoots {
        claude: claude_root,
        codex: codex_root,
    })
}

async fn read_small_regular_utf8(path: &Path) -> Option<String> {
    let metadata = tokio::fs::symlink_metadata(path).await.ok()?;
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.len() > MAX_GIT_METADATA_BYTES
    {
        return None;
    }
    let contents = tokio::fs::read(path).await.ok()?;
    if contents.len() as u64 > MAX_GIT_METADATA_BYTES {
        return None;
    }
    String::from_utf8(contents).ok()
}

fn ensure_claude_workspace_trusted(
    state_path: &Path,
    project_key: &str,
) -> Result<(), std::io::Error> {
    ensure_claude_workspace_trusted_with_options(
        state_path,
        project_key,
        CLAUDE_STATE_LOCK_TIMEOUT,
        CLAUDE_STATE_LOCK_STALE_AFTER,
        CLAUDE_STATE_LOCK_UPDATE_INTERVAL,
        |_, _| Ok(()),
    )
}

#[cfg(test)]
fn ensure_claude_workspace_trusted_with_timeout(
    state_path: &Path,
    project_key: &str,
    lock_timeout: Duration,
) -> Result<(), std::io::Error> {
    ensure_claude_workspace_trusted_with_options(
        state_path,
        project_key,
        lock_timeout,
        CLAUDE_STATE_LOCK_STALE_AFTER,
        CLAUDE_STATE_LOCK_UPDATE_INTERVAL,
        |_, _| Ok(()),
    )
}

fn ensure_claude_workspace_trusted_with_options<F>(
    state_path: &Path,
    project_key: &str,
    lock_timeout: Duration,
    stale_after: Duration,
    update_interval: Duration,
    mut before_rename: F,
) -> Result<(), std::io::Error>
where
    F: FnMut(usize, &Path) -> Result<(), std::io::Error>,
{
    // Claude serializes this same read/merge/replace operation with
    // `<state>.lock`. Claude can fall back to an unlocked write when the lock
    // is busy, so the lock is paired with compare-before-replace and bounded
    // post-write verification rather than treated as strict mutual exclusion.
    let state_lock =
        ClaudeStateLock::acquire(state_path, lock_timeout, stale_after, update_interval)?;
    let destination = resolve_claude_state_destination(state_path)?;
    let update_result = (|| {
        for attempt in 0..CLAUDE_STATE_WRITE_ATTEMPTS {
            state_lock.ensure_owned()?;
            let original = read_claude_state_snapshot(&destination)?;
            let replacement = claude_state_with_workspace_trust(&original, project_key)?;

            let Some(replacement) = replacement else {
                before_rename(attempt, &destination)?;
                state_lock.ensure_owned()?;
                if read_claude_state_snapshot(&destination)? != original {
                    continue;
                }
                return Ok(());
            };
            let mut snapshot_changed = false;
            let replace_result =
                crate::fs_util::atomic_replace_with_hook(&destination, &replacement, |_| {
                    before_rename(attempt, &destination)?;
                    state_lock.ensure_owned()?;
                    if read_claude_state_snapshot(&destination)? != original {
                        snapshot_changed = true;
                        return Err(std::io::Error::new(
                            std::io::ErrorKind::WouldBlock,
                            "Claude state changed before the trust merge could be committed",
                        ));
                    }
                    Ok(())
                });
            if snapshot_changed {
                continue;
            }
            replace_result?;
            state_lock.ensure_owned()?;
            if read_claude_state_snapshot(&destination)?.as_deref() == Some(replacement.as_slice())
            {
                return Ok(());
            }
        }
        Err(std::io::Error::new(
            std::io::ErrorKind::WouldBlock,
            format!(
                "Claude state kept changing while adding workspace trust: {}",
                state_path.display()
            ),
        ))
    })();
    let release_result = state_lock.release();
    match update_result {
        Err(error) => Err(error),
        Ok(()) => release_result,
    }
}

fn claude_state_with_workspace_trust(
    original: &Option<Vec<u8>>,
    project_key: &str,
) -> Result<Option<Vec<u8>>, std::io::Error> {
    let mut state = match original {
        Some(contents) => serde_json::from_slice::<Value>(contents).map_err(|error| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("Claude state is not valid JSON: {error}"),
            )
        })?,
        None => json!({}),
    };
    let root = state.as_object_mut().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "Claude state root must be a JSON object",
        )
    })?;
    let projects = root.entry("projects").or_insert_with(|| json!({}));
    let projects = projects.as_object_mut().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "Claude state projects must be a JSON object",
        )
    })?;
    let project = projects
        .entry(project_key.to_string())
        .or_insert_with(|| json!({}));
    let project = project.as_object_mut().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "Claude project state must be a JSON object",
        )
    })?;
    if project
        .get("hasTrustDialogAccepted")
        .and_then(Value::as_bool)
        == Some(true)
    {
        return Ok(None);
    }
    project.insert("hasTrustDialogAccepted".to_string(), Value::Bool(true));
    let mut replacement = serde_json::to_vec(&state).map_err(|error| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("could not encode Claude state: {error}"),
        )
    })?;
    replacement.push(b'\n');
    if replacement.len() as u64 > MAX_CLAUDE_STATE_BYTES {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!(
                "Claude state would exceed {MAX_CLAUDE_STATE_BYTES} bytes after adding workspace trust"
            ),
        ));
    }
    Ok(Some(replacement))
}

#[derive(Debug)]
struct ClaudeStateLock {
    path: PathBuf,
    identity: Arc<same_file::Handle>,
    compromised: Arc<AtomicBool>,
    heartbeat_stop: Option<mpsc::Sender<()>>,
    heartbeat: Option<JoinHandle<()>>,
    released: bool,
}

impl ClaudeStateLock {
    fn acquire(
        state_path: &Path,
        timeout: Duration,
        stale_after: Duration,
        update_interval: Duration,
    ) -> Result<Self, std::io::Error> {
        if stale_after.is_zero() || update_interval.is_zero() || update_interval >= stale_after {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "Claude state lock heartbeat must be positive and shorter than its stale interval",
            ));
        }
        let mut lock_name = state_path.as_os_str().to_os_string();
        lock_name.push(".lock");
        let lock_path = PathBuf::from(lock_name);
        if let Some(parent) = lock_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let deadline = Instant::now() + timeout;
        loop {
            match std::fs::create_dir(&lock_path) {
                Ok(()) => {
                    let identity = Arc::new(claude_state_lock_handle(&lock_path)?);
                    let compromised = Arc::new(AtomicBool::new(false));
                    let (heartbeat_stop, stop_receiver) = mpsc::channel();
                    let heartbeat_path = lock_path.clone();
                    let heartbeat_identity = Arc::clone(&identity);
                    let heartbeat_compromised = Arc::clone(&compromised);
                    let heartbeat = match std::thread::Builder::new()
                        .name("claude-state-lock-heartbeat".to_string())
                        .spawn(move || loop {
                            match stop_receiver.recv_timeout(update_interval) {
                                Ok(()) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
                                Err(mpsc::RecvTimeoutError::Timeout) => {
                                    if refresh_claude_state_lock(
                                        &heartbeat_path,
                                        heartbeat_identity.as_ref(),
                                    )
                                    .is_err()
                                    {
                                        heartbeat_compromised.store(true, Ordering::Release);
                                        break;
                                    }
                                }
                            }
                        }) {
                        Ok(heartbeat) => heartbeat,
                        Err(error) => {
                            if claude_state_lock_is_owned(&lock_path, identity.as_ref())
                                .unwrap_or(false)
                            {
                                let _ = std::fs::remove_dir(&lock_path);
                            }
                            return Err(error);
                        }
                    };
                    return Ok(Self {
                        path: lock_path,
                        identity,
                        compromised,
                        heartbeat_stop: Some(heartbeat_stop),
                        heartbeat: Some(heartbeat),
                        released: false,
                    });
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    let metadata = match claude_state_lock_metadata(&lock_path) {
                        Ok(metadata) => metadata,
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                        Err(error) => return Err(error),
                    };
                    let identity = match claude_state_lock_handle(&lock_path) {
                        Ok(identity) => identity,
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                        Err(error) => return Err(error),
                    };
                    let modified = metadata.modified().ok();
                    let stale = metadata
                        .modified()
                        .ok()
                        .and_then(|modified| SystemTime::now().duration_since(modified).ok())
                        .is_some_and(|age| age >= stale_after);
                    if stale {
                        let current = match claude_state_lock_metadata(&lock_path) {
                            Ok(current) => current,
                            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                            Err(error) => return Err(error),
                        };
                        let still_owned = match claude_state_lock_is_owned(&lock_path, &identity) {
                            Ok(still_owned) => still_owned,
                            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                            Err(error) => return Err(error),
                        };
                        if !still_owned || current.modified().ok() != modified {
                            continue;
                        }
                        match std::fs::remove_dir(&lock_path) {
                            Ok(()) => continue,
                            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                            Err(error) => return Err(error),
                        }
                    }
                    if Instant::now() >= deadline {
                        return Err(std::io::Error::new(
                            std::io::ErrorKind::WouldBlock,
                            format!(
                                "Claude state is busy in another process: {}",
                                state_path.display()
                            ),
                        ));
                    }
                    std::thread::sleep(CLAUDE_STATE_LOCK_RETRY_INTERVAL);
                }
                Err(error) => return Err(error),
            }
        }
    }

    fn ensure_owned(&self) -> Result<(), std::io::Error> {
        if self.compromised.load(Ordering::Acquire) {
            return Err(claude_state_lock_compromised(&self.path));
        }
        claude_state_lock_metadata(&self.path)
            .map_err(|_| claude_state_lock_compromised(&self.path))?;
        if !claude_state_lock_is_owned(&self.path, self.identity.as_ref())
            .map_err(|_| claude_state_lock_compromised(&self.path))?
        {
            self.compromised.store(true, Ordering::Release);
            return Err(claude_state_lock_compromised(&self.path));
        }
        Ok(())
    }

    fn stop_heartbeat(&mut self) {
        if let Some(stop) = self.heartbeat_stop.take() {
            let _ = stop.send(());
        }
        if self
            .heartbeat
            .take()
            .is_some_and(|heartbeat| heartbeat.join().is_err())
        {
            self.compromised.store(true, Ordering::Release);
        }
    }

    fn release(mut self) -> Result<(), std::io::Error> {
        self.stop_heartbeat();
        let ownership = self.ensure_owned();
        self.released = true;
        ownership?;
        std::fs::remove_dir(&self.path)
    }
}

impl Drop for ClaudeStateLock {
    fn drop(&mut self) {
        if !self.released {
            self.stop_heartbeat();
            if self.ensure_owned().is_ok() {
                let _ = std::fs::remove_dir(&self.path);
            }
            self.released = true;
        }
    }
}

fn claude_state_lock_metadata(path: &Path) -> Result<std::fs::Metadata, std::io::Error> {
    let metadata = std::fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("Claude state lock is not a directory: {}", path.display()),
        ));
    }
    Ok(metadata)
}

fn claude_state_lock_handle(path: &Path) -> Result<same_file::Handle, std::io::Error> {
    claude_state_lock_metadata(path)?;
    let handle = same_file::Handle::from_path(path)?;
    claude_state_lock_metadata(path)?;
    let current = same_file::Handle::from_path(path)?;
    if current != handle {
        return Err(claude_state_lock_compromised(path));
    }
    Ok(handle)
}

fn claude_state_lock_is_owned(
    path: &Path,
    identity: &same_file::Handle,
) -> Result<bool, std::io::Error> {
    Ok(claude_state_lock_handle(path)? == *identity)
}

fn refresh_claude_state_lock(
    path: &Path,
    identity: &same_file::Handle,
) -> Result<(), std::io::Error> {
    let metadata = claude_state_lock_metadata(path)?;
    if !claude_state_lock_is_owned(path, identity)? {
        return Err(claude_state_lock_compromised(path));
    }
    filetime::set_symlink_file_times(
        path,
        filetime::FileTime::from_last_access_time(&metadata),
        filetime::FileTime::now(),
    )?;
    if !claude_state_lock_is_owned(path, identity)? {
        return Err(claude_state_lock_compromised(path));
    }
    Ok(())
}

fn claude_state_lock_compromised(path: &Path) -> std::io::Error {
    std::io::Error::other(format!(
        "Claude state lock ownership changed while held: {}",
        path.display()
    ))
}

fn resolve_claude_state_destination(path: &Path) -> Result<PathBuf, std::io::Error> {
    let mut destination = path.to_path_buf();
    for _ in 0..MAX_CLAUDE_STATE_SYMLINKS {
        let metadata = match std::fs::symlink_metadata(&destination) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return canonicalize_parent_blocking(&destination);
            }
            Err(error) => return Err(error),
        };
        if metadata.file_type().is_symlink() {
            let target = std::fs::read_link(&destination)?;
            let parent = destination.parent().ok_or_else(|| {
                std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    "Claude state symlink has no parent",
                )
            })?;
            destination = absolute_from(parent, &target);
            continue;
        }
        if !metadata.is_file() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!(
                    "Claude state is not a regular file: {}",
                    destination.display()
                ),
            ));
        }
        return std::fs::canonicalize(destination);
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::InvalidData,
        format!(
            "Claude state symlink chain exceeds {MAX_CLAUDE_STATE_SYMLINKS} entries: {}",
            path.display()
        ),
    ))
}

fn canonicalize_parent_blocking(path: &Path) -> Result<PathBuf, std::io::Error> {
    let parent = path.parent().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "Claude state path has no parent",
        )
    })?;
    Ok(
        std::fs::canonicalize(parent)?.join(path.file_name().ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "Claude state path has no file name",
            )
        })?),
    )
}

fn read_claude_state_snapshot(path: &Path) -> Result<Option<Vec<u8>>, std::io::Error> {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    if !metadata.is_file() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("Claude state is not a regular file: {}", path.display()),
        ));
    }
    if metadata.len() > MAX_CLAUDE_STATE_BYTES {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!(
                "Claude state exceeds {MAX_CLAUDE_STATE_BYTES} bytes: {}",
                path.display()
            ),
        ));
    }
    let contents = std::fs::read(path)?;
    if contents.len() as u64 > MAX_CLAUDE_STATE_BYTES {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!(
                "Claude state exceeds {MAX_CLAUDE_STATE_BYTES} bytes: {}",
                path.display()
            ),
        ));
    }
    Ok(Some(contents))
}

fn opencode_config(
    system_prompt: &str,
    plugin_url: &str,
    agent_name: &str,
    readonly: bool,
) -> String {
    let mut agent = json!({
        "disable": false,
        "mode": "primary",
        "prompt": system_prompt,
    });
    if readonly {
        // Deny OpenCode's direct, shell, and delegated write paths.
        agent["permission"] = json!({
            "edit": "deny",
            "bash": "deny",
            "task": "deny",
        });
    }
    json!({
        "$schema": "https://opencode.ai/config.json",
        "plugin": [plugin_url],
        "agent": {
            (agent_name): agent,
        },
        "mcp": {
            MCP_SERVER_NAME: {
                "type": "remote",
                "url": format!("{{env:{MCP_URL_ENV}}}"),
                "headers": {
                    "Authorization": format!("{{env:{MCP_AUTHORIZATION_ENV}}}"),
                },
                "oauth": false,
                "enabled": true,
                "timeout": 5000,
            },
        },
    })
    .to_string()
}

async fn ensure_hook_forwarder(
    state_dir: &Path,
    cancellation: &PreparationCancellation,
) -> Result<PathBuf, LaunchContextError> {
    require_active_preparation(cancellation)?;
    create_private_dir(state_dir).await?;
    require_active_preparation(cancellation)?;
    let path = state_dir.join(HOOK_FORWARDER_FILENAME);
    write_private_file(&path, HOOK_FORWARDER_SCRIPT.as_bytes(), true).await?;
    require_active_preparation(cancellation)?;
    Ok(path)
}

async fn create_private_dir(path: &Path) -> Result<(), std::io::Error> {
    match tokio::fs::symlink_metadata(path).await {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!(
                    "managed directory is not a regular directory: {}",
                    path.display()
                ),
            ));
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let mut builder = tokio::fs::DirBuilder::new();
            builder.recursive(true);
            #[cfg(unix)]
            builder.mode(0o700);
            builder.create(path).await?;
        }
        Err(error) => return Err(error),
    }
    let metadata = tokio::fs::symlink_metadata(path).await?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!(
                "managed directory is not a regular directory: {}",
                path.display()
            ),
        ));
    }
    #[cfg(unix)]
    tokio::fs::set_permissions(path, std::os::unix::fs::PermissionsExt::from_mode(0o700)).await?;
    Ok(())
}

async fn write_private_file(
    path: &Path,
    bytes: &[u8],
    executable: bool,
) -> Result<(), std::io::Error> {
    match tokio::fs::symlink_metadata(path).await {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("managed file is not a regular file: {}", path.display()),
            ));
        }
        Ok(_) => {
            if tokio::fs::read(path).await? == bytes {
                set_private_file_permissions(path, executable).await?;
                return Ok(());
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    let path_for_write = path.to_path_buf();
    let contents = bytes.to_vec();
    tokio::task::spawn_blocking(move || crate::fs_util::atomic_replace(&path_for_write, &contents))
        .await
        .map_err(|error| std::io::Error::other(format!("managed file writer failed: {error}")))??;
    set_private_file_permissions(path, executable).await
}

async fn set_private_file_permissions(path: &Path, executable: bool) -> Result<(), std::io::Error> {
    #[cfg(unix)]
    {
        tokio::fs::set_permissions(
            path,
            std::os::unix::fs::PermissionsExt::from_mode(if executable { 0o700 } else { 0o600 }),
        )
        .await?;
    }
    #[cfg(not(unix))]
    let _ = executable;
    Ok(())
}

fn codex_auth_source_path() -> Option<PathBuf> {
    let home = std::env::var_os("CODEX_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME")
                .filter(|value| !value.is_empty())
                .map(|home| PathBuf::from(home).join(".codex"))
        })?;
    Some(home.join("auth.json"))
}

async fn prepare_codex_managed_files(
    app_root: &Path,
    fence: &RtThreadFence,
    auth_source: Option<&Path>,
    profile_config: &str,
    cancellation: &PreparationCancellation,
) -> Result<(PathBuf, String), LaunchContextError> {
    require_active_preparation(cancellation)?;
    let codex_home = managed_codex_home(app_root, &fence.account_scope);
    initialize_codex_home(&codex_home, auth_source, cancellation).await?;
    require_active_preparation(cancellation)?;

    let runtime_dir = codex_home.join("studio-runtime");
    let hook_script = ensure_hook_forwarder(&runtime_dir, cancellation).await?;
    require_active_preparation(cancellation)?;
    write_private_file(
        &codex_home.join("hooks.json"),
        &serde_json::to_vec(&codex_hook_settings(&hook_script))?,
        false,
    )
    .await?;
    require_active_preparation(cancellation)?;

    let profile_name = codex_profile_name(fence);
    write_private_file(
        &codex_profile_path(&codex_home, &profile_name),
        profile_config.as_bytes(),
        false,
    )
    .await?;
    require_active_preparation(cancellation)?;
    Ok((codex_home, profile_name))
}

async fn initialize_codex_home(
    codex_home: &Path,
    auth_source: Option<&Path>,
    cancellation: &PreparationCancellation,
) -> Result<(), LaunchContextError> {
    require_active_preparation(cancellation)?;
    create_private_dir(codex_home).await?;
    require_active_preparation(cancellation)?;
    let marker = codex_home.join(CODEX_HOME_INITIALIZED_MARKER);
    let destination = codex_home.join("auth.json");
    let initialized = regular_file_if_present(&marker, "Codex home marker").await?;
    let destination_exists = regular_file_if_present(&destination, "managed Codex auth").await?;
    require_active_preparation(cancellation)?;

    if initialized {
        if destination_exists {
            set_private_file_permissions(&destination, false).await?;
            require_active_preparation(cancellation)?;
        }
        // Absence after initialization is authoritative (for example, Codex
        // logged out). Never silently restore an older system credential.
        return Ok(());
    }

    if !destination_exists {
        if let Some(source) = auth_source {
            if let Some(metadata) = regular_file_metadata(source, "Codex auth source").await? {
                if metadata.len() > MAX_CODEX_AUTH_BYTES {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        format!(
                            "Codex auth source exceeds {MAX_CODEX_AUTH_BYTES} bytes: {}",
                            source.display()
                        ),
                    )
                    .into());
                }
                let contents = tokio::fs::read(source).await?;
                require_active_preparation(cancellation)?;
                write_private_file(&destination, &contents, false).await?;
                require_active_preparation(cancellation)?;
            }
        }
    } else {
        set_private_file_permissions(&destination, false).await?;
        require_active_preparation(cancellation)?;
    }

    // The marker lands last. A crash before it is safe: a complete regular
    // destination is preserved on retry, and a missing destination may be
    // seeded again before any provider process has been admitted.
    write_private_file(&marker, b"initialized\n", false).await?;
    require_active_preparation(cancellation)
}

async fn regular_file_if_present(path: &Path, description: &str) -> Result<bool, std::io::Error> {
    Ok(regular_file_metadata(path, description).await?.is_some())
}

async fn regular_file_metadata(
    path: &Path,
    description: &str,
) -> Result<Option<std::fs::Metadata>, std::io::Error> {
    match tokio::fs::symlink_metadata(path).await {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("{description} is not a regular file: {}", path.display()),
            ))
        }
        Ok(metadata) => Ok(Some(metadata)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

fn managed_state_dir(app_root: &Path, fence: &RtThreadFence) -> PathBuf {
    let key = managed_key(
        "thread-state-v1",
        &[
            &fence.account_scope,
            &fence.organization_id,
            &fence.thread_id,
            &fence.generation,
        ],
    );
    app_root.join(".decocms").join("agent-state").join(key)
}

/// Account-owned Codex state. Provider history and refreshed auth deliberately
/// outlive any one thread; only the thread's profile is removed with its row.
fn managed_codex_home(app_root: &Path, account_scope: &str) -> PathBuf {
    let key = managed_key("codex-account-home-v1", &[account_scope]);
    app_root
        .join(".decocms")
        .join("agent-state")
        .join("codex-accounts")
        .join(key)
        .join("home")
}

fn codex_profile_name(fence: &RtThreadFence) -> String {
    format!(
        "{CODEX_PROFILE_PREFIX}{}",
        managed_key(
            "codex-thread-profile-v1",
            &[
                &fence.account_scope,
                &fence.organization_id,
                &fence.thread_id,
                &fence.generation,
            ],
        )
    )
}

fn codex_profile_path(codex_home: &Path, profile_name: &str) -> PathBuf {
    codex_home.join(format!("{profile_name}.config.toml"))
}

fn managed_key(domain: &str, fields: &[&str]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"decocms-managed-agent-state\0");
    hasher.update((domain.len() as u64).to_be_bytes());
    hasher.update(domain.as_bytes());
    for field in fields {
        hasher.update((field.len() as u64).to_be_bytes());
        hasher.update(field.as_bytes());
    }
    let digest = hasher.finalize();
    digest[..16]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>()
}

/// Remove per-thread provider configuration after the fenced parent has been
/// deleted. Codex auth and session history are account-owned and intentionally
/// remain in the shared home; this removes only the deleted thread's profile.
pub(crate) async fn cleanup_managed_state(
    app_root: &Path,
    fence: &RtThreadFence,
) -> Result<(), std::io::Error> {
    let state_result = match tokio::fs::remove_dir_all(managed_state_dir(app_root, fence)).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    };
    let codex_home = managed_codex_home(app_root, &fence.account_scope);
    let profile_result =
        match tokio::fs::remove_file(codex_profile_path(&codex_home, &codex_profile_name(fence)))
            .await
        {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error),
        };
    match (state_result, profile_result) {
        (Err(error), _) | (Ok(()), Err(error)) => Err(error),
        (Ok(()), Ok(())) => Ok(()),
    }
}

fn shell_quote_path(path: &Path) -> String {
    format!("'{}'", path.to_string_lossy().replace('\'', "'\\''"))
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn linked_worktree_metadata(common_dir: &Path, worktree: &Path) -> PathBuf {
        let git_dir = common_dir.join("worktrees/thread");
        tokio::fs::create_dir_all(&git_dir).await.unwrap();
        tokio::fs::create_dir_all(worktree).await.unwrap();
        let dot_git = worktree.join(".git");
        tokio::fs::write(&dot_git, format!("gitdir: {}\n", git_dir.display()))
            .await
            .unwrap();
        tokio::fs::write(git_dir.join("gitdir"), format!("{}\n", dot_git.display()))
            .await
            .unwrap();
        tokio::fs::write(git_dir.join("commondir"), "../..\n")
            .await
            .unwrap();
        git_dir
    }

    #[test]
    fn launch_debug_redacts_environment_values() {
        let launch = PreparedLaunch {
            harness: HarnessId::Codex,
            program: "codex".to_string(),
            args: vec!["--no-alt-screen".to_string()],
            cwd: PathBuf::from("/tmp/work"),
            env: vec![("SECRET".to_string(), "never-print-this".to_string())],
            title_environment: harness::title::TitleEnvironment::default(),
            provider_session_id: None,
            mcp_path: "/api/org/mcp/agent".to_string(),
            claude_workspace_trust: None,
            codex_hook_trust: None,
        };
        let debug = format!("{launch:?}");
        assert!(debug.contains("SECRET"));
        assert!(!debug.contains("never-print-this"));
    }

    #[test]
    fn codex_config_uses_environment_references_and_escaped_instructions() {
        let config = codex_config("line one\n\"line two\"", "https://studio.local/api/o/mcp/a");
        assert!(config.contains("developer_instructions = \"line one\\n\\\"line two\\\"\""));
        assert!(config.contains("Authorization = \"DECOCMS_MCP_AUTHORIZATION\""));
        assert!(config.contains("[tui]\nshow_tooltips = false"));
        assert!(!config.contains("Cookie"));
        assert!(!config.contains("Origin"));
    }

    #[test]
    fn claude_state_path_matches_default_explicit_legacy_and_oauth_layouts() {
        let cwd = Path::new("/workspace/repo");
        let home = Path::new("/users/alice");
        assert_eq!(
            claude_state_path_from(cwd, None, home, false, false),
            home.join(".claude.json")
        );
        assert_eq!(
            claude_state_path_from(
                cwd,
                Some(std::ffi::OsStr::new("/managed/claude")),
                home,
                false,
                false,
            ),
            Path::new("/managed/claude/.claude.json")
        );
        assert_eq!(
            claude_state_path_from(
                cwd,
                Some(std::ffi::OsStr::new("relative-claude")),
                home,
                false,
                true,
            ),
            cwd.join("relative-claude/.claude-custom-oauth.json")
        );
        assert_eq!(
            claude_state_path_from(cwd, Some(std::ffi::OsStr::new("")), home, true, false,),
            cwd.join(".config.json")
        );
    }

    #[tokio::test]
    async fn workspace_trust_roots_match_provider_git_worktree_semantics() {
        let root = tempfile::tempdir().unwrap();

        let checkout = root.path().join("checkout");
        tokio::fs::create_dir_all(checkout.join(".git"))
            .await
            .unwrap();
        let nested_checkout = checkout.join("packages/app");
        tokio::fs::create_dir_all(&nested_checkout).await.unwrap();
        let checkout_roots = workspace_trust_roots(&nested_checkout).await.unwrap();
        let canonical_checkout = tokio::fs::canonicalize(&checkout).await.unwrap();
        assert_eq!(
            checkout_roots,
            WorkspaceTrustRoots {
                claude: canonical_checkout.clone(),
                codex: canonical_checkout,
            }
        );

        let main_checkout = root.path().join("main-checkout");
        let main_git = main_checkout.join(".git");
        let linked = root.path().join("linked-checkout");
        linked_worktree_metadata(&main_git, &linked).await;
        let linked_roots = workspace_trust_roots(&linked).await.unwrap();
        let canonical_main = tokio::fs::canonicalize(&main_checkout).await.unwrap();
        assert_eq!(
            linked_roots,
            WorkspaceTrustRoots {
                claude: canonical_main.clone(),
                codex: canonical_main,
            }
        );

        let bare_repo = root.path().join("repos/acme/site");
        let studio_worktree = root.path().join("worktrees/acme/site/thread/repo");
        linked_worktree_metadata(&bare_repo, &studio_worktree).await;
        let studio_roots = workspace_trust_roots(&studio_worktree).await.unwrap();
        assert_eq!(
            studio_roots,
            WorkspaceTrustRoots {
                claude: tokio::fs::canonicalize(&bare_repo).await.unwrap(),
                codex: tokio::fs::canonicalize(bare_repo.parent().unwrap())
                    .await
                    .unwrap(),
            }
        );
    }

    #[tokio::test]
    async fn forged_worktree_backlink_never_broadens_workspace_trust() {
        let root = tempfile::tempdir().unwrap();
        let bare_repo = root.path().join("repos/acme/site");
        let worktree = root.path().join("worktrees/acme/site/thread/repo");
        let git_dir = linked_worktree_metadata(&bare_repo, &worktree).await;
        let unrelated = root.path().join("unrelated/.git");
        tokio::fs::create_dir_all(unrelated.parent().unwrap())
            .await
            .unwrap();
        tokio::fs::write(&unrelated, "not a git pointer\n")
            .await
            .unwrap();
        tokio::fs::write(git_dir.join("gitdir"), unrelated.display().to_string())
            .await
            .unwrap();
        let nested = worktree.join("nested");
        tokio::fs::create_dir_all(&nested).await.unwrap();

        let roots = workspace_trust_roots(&nested).await.unwrap();
        assert_eq!(
            roots,
            WorkspaceTrustRoots {
                claude: tokio::fs::canonicalize(&worktree).await.unwrap(),
                codex: tokio::fs::canonicalize(&nested).await.unwrap(),
            }
        );
    }

    #[test]
    fn claude_workspace_trust_merge_preserves_unrelated_state_and_is_idempotent() {
        let root = tempfile::tempdir().unwrap();
        let state_path = root.path().join(".claude.json");
        std::fs::write(
            &state_path,
            br#"{
              "sentinel": {"keep": true},
              "projects": {
                "/unrelated": {"allowedTools": ["Read"], "custom": "keep"},
                "/workspace": {"hasTrustDialogAccepted": false, "history": [1, 2]}
              }
            }"#,
        )
        .unwrap();

        ensure_claude_workspace_trusted(&state_path, "/workspace").unwrap();
        let first = std::fs::read(&state_path).unwrap();
        let state: Value = serde_json::from_slice(&first).unwrap();
        assert_eq!(state["sentinel"], json!({ "keep": true }));
        assert_eq!(
            state["projects"]["/unrelated"],
            json!({ "allowedTools": ["Read"], "custom": "keep" })
        );
        assert_eq!(state["projects"]["/workspace"]["history"], json!([1, 2]));
        assert_eq!(
            state["projects"]["/workspace"]["hasTrustDialogAccepted"],
            true
        );
        ensure_claude_workspace_trusted(&state_path, "/workspace").unwrap();
        assert_eq!(std::fs::read(&state_path).unwrap(), first);

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&state_path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }

    #[test]
    fn claude_workspace_trust_creates_only_the_exact_project_entry() {
        let root = tempfile::tempdir().unwrap();
        let state_path = root.path().join("nested/.claude.json");
        ensure_claude_workspace_trusted(&state_path, "/workspace/repo").unwrap();
        let state: Value = serde_json::from_slice(&std::fs::read(&state_path).unwrap()).unwrap();
        assert_eq!(
            state,
            json!({
                "projects": {
                    "/workspace/repo": { "hasTrustDialogAccepted": true }
                }
            })
        );
        assert!(state["projects"].get("/workspace").is_none());
    }

    #[test]
    fn claude_workspace_trust_refuses_invalid_or_oversized_state() {
        let root = tempfile::tempdir().unwrap();
        let malformed = root.path().join("malformed.json");
        std::fs::write(&malformed, b"{not-json").unwrap();
        let malformed_before = std::fs::read(&malformed).unwrap();
        assert_eq!(
            ensure_claude_workspace_trusted(&malformed, "/workspace")
                .unwrap_err()
                .kind(),
            std::io::ErrorKind::InvalidData
        );
        assert_eq!(std::fs::read(&malformed).unwrap(), malformed_before);

        let wrong_shape = root.path().join("wrong-shape.json");
        std::fs::write(&wrong_shape, br#"{"projects":[]}"#).unwrap();
        assert_eq!(
            ensure_claude_workspace_trusted(&wrong_shape, "/workspace")
                .unwrap_err()
                .kind(),
            std::io::ErrorKind::InvalidData
        );

        let oversized = root.path().join("oversized.json");
        std::fs::write(&oversized, vec![b' '; MAX_CLAUDE_STATE_BYTES as usize + 1]).unwrap();
        assert_eq!(
            ensure_claude_workspace_trusted(&oversized, "/workspace")
                .unwrap_err()
                .kind(),
            std::io::ErrorKind::InvalidData
        );

        let expansion = root.path().join("expansion.json");
        let empty = serde_json::to_vec(&json!({ "padding": "" })).unwrap();
        let padding = "x".repeat(MAX_CLAUDE_STATE_BYTES as usize - empty.len());
        let expansion_before = serde_json::to_vec(&json!({ "padding": padding })).unwrap();
        assert_eq!(expansion_before.len() as u64, MAX_CLAUDE_STATE_BYTES);
        std::fs::write(&expansion, &expansion_before).unwrap();
        assert_eq!(
            ensure_claude_workspace_trusted(&expansion, "/workspace")
                .unwrap_err()
                .kind(),
            std::io::ErrorKind::InvalidData
        );
        assert_eq!(std::fs::read(&expansion).unwrap(), expansion_before);
    }

    #[test]
    fn claude_workspace_trust_retries_around_an_unlocked_provider_write() {
        let root = tempfile::tempdir().unwrap();
        let state_path = root.path().join("state.json");
        std::fs::write(&state_path, br#"{"initial":true}"#).unwrap();
        let mut injected = false;

        ensure_claude_workspace_trusted_with_options(
            &state_path,
            "/workspace",
            CLAUDE_STATE_LOCK_TIMEOUT,
            CLAUDE_STATE_LOCK_STALE_AFTER,
            CLAUDE_STATE_LOCK_UPDATE_INTERVAL,
            |_, destination| {
                if !injected {
                    injected = true;
                    crate::fs_util::atomic_replace(
                        destination,
                        br#"{"provider":{"preserve":true}}"#,
                    )?;
                }
                Ok(())
            },
        )
        .unwrap();

        let state: Value = serde_json::from_slice(&std::fs::read(state_path).unwrap()).unwrap();
        assert_eq!(state["provider"], json!({ "preserve": true }));
        assert_eq!(
            state["projects"]["/workspace"]["hasTrustDialogAccepted"],
            true
        );
    }

    #[test]
    fn claude_state_lock_heartbeat_prevents_reaping_and_detects_takeover() {
        let root = tempfile::tempdir().unwrap();
        let state_path = root.path().join("state.json");
        let stale_after = Duration::from_millis(250);
        let update_interval = Duration::from_millis(25);
        let lock =
            ClaudeStateLock::acquire(&state_path, Duration::ZERO, stale_after, update_interval)
                .unwrap();
        let lock_path = lock.path.clone();

        std::thread::sleep(Duration::from_millis(600));
        assert_eq!(
            ClaudeStateLock::acquire(&state_path, Duration::ZERO, stale_after, update_interval,)
                .unwrap_err()
                .kind(),
            std::io::ErrorKind::WouldBlock
        );

        std::fs::remove_dir(&lock_path).unwrap();
        std::fs::create_dir(root.path().join("inode-decoy")).unwrap();
        std::fs::create_dir(&lock_path).unwrap();
        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(
            lock.release().unwrap_err().kind(),
            std::io::ErrorKind::Other
        );
        assert!(lock_path.is_dir());
    }

    #[cfg(unix)]
    #[test]
    fn claude_workspace_trust_updates_symlink_target_without_replacing_link() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().unwrap();
        let target = root.path().join("target.json");
        std::fs::write(&target, br#"{"sentinel":true}"#).unwrap();
        let state_path = root.path().join("state.json");
        symlink("target.json", &state_path).unwrap();

        ensure_claude_workspace_trusted(&state_path, "/workspace").unwrap();

        assert!(std::fs::symlink_metadata(&state_path)
            .unwrap()
            .file_type()
            .is_symlink());
        let state: Value = serde_json::from_slice(&std::fs::read(&target).unwrap()).unwrap();
        assert_eq!(state["sentinel"], true);
        assert_eq!(
            state["projects"]["/workspace"]["hasTrustDialogAccepted"],
            true
        );
        assert!(!root.path().join("state.json.lock").exists());
    }

    #[test]
    fn claude_workspace_trust_waits_for_provider_lock_and_cleans_its_lock() {
        let root = tempfile::tempdir().unwrap();
        let state_path = root.path().join("state.json");
        std::fs::write(&state_path, b"{}").unwrap();
        let lock_path = root.path().join("state.json.lock");
        std::fs::create_dir(&lock_path).unwrap();
        let release = lock_path.clone();
        let releaser = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(50));
            std::fs::remove_dir(release).unwrap();
        });

        ensure_claude_workspace_trusted(&state_path, "/workspace").unwrap();

        releaser.join().unwrap();
        assert!(!lock_path.exists());
        let state: Value = serde_json::from_slice(&std::fs::read(state_path).unwrap()).unwrap();
        assert_eq!(
            state["projects"]["/workspace"]["hasTrustDialogAccepted"],
            true
        );
    }

    #[test]
    fn claude_workspace_trust_refuses_non_directory_or_busy_lock() {
        let root = tempfile::tempdir().unwrap();
        let state_path = root.path().join("state.json");
        std::fs::write(&state_path, b"{}").unwrap();
        let lock_path = root.path().join("state.json.lock");
        std::fs::write(&lock_path, b"not-a-lock-directory").unwrap();
        assert_eq!(
            ensure_claude_workspace_trusted_with_timeout(
                &state_path,
                "/workspace",
                Duration::ZERO,
            )
            .unwrap_err()
            .kind(),
            std::io::ErrorKind::InvalidData
        );
        std::fs::remove_file(&lock_path).unwrap();
        std::fs::create_dir(&lock_path).unwrap();
        assert_eq!(
            ensure_claude_workspace_trusted_with_timeout(
                &state_path,
                "/workspace",
                Duration::ZERO,
            )
            .unwrap_err()
            .kind(),
            std::io::ErrorKind::WouldBlock
        );
        assert_eq!(std::fs::read(&state_path).unwrap(), b"{}");
    }

    #[test]
    fn claude_normal_launches_bypass_permissions_before_resume() {
        let fence = test_fence("account", "thread");
        let cancellation = PreparationCancellation::test_uncancelled();
        for approval_mode in ["default", "auto"] {
            let request = LaunchRequest {
                fence: &fence,
                terminal_session_id: "terminal",
                harness: HarnessId::ClaudeCode,
                approval_mode,
                plan_mode: false,
                hook_token: "hook",
                mcp_token: "mcp",
                provider_session_id: Some("session"),
                cancellation: &cancellation,
                account_epoch: crate::sandbox::manager::AccountEpoch::for_test(),
                identity_generation: 0,
            };
            let mut argv = Vec::new();
            append_claude_launch_args(request, Some("session"), &mut argv);

            assert_eq!(
                argv,
                [
                    "--permission-mode",
                    "bypassPermissions",
                    "--resume",
                    "session",
                ]
            );
            assert!(!argv.iter().any(|arg| arg == "acceptEdits"));
            assert!(!argv
                .iter()
                .any(|arg| arg == "--dangerously-skip-permissions"));
        }
    }

    #[test]
    fn claude_plan_and_readonly_launches_never_bypass_permissions() {
        let fence = test_fence("account", "thread");
        let cancellation = PreparationCancellation::test_uncancelled();
        for (approval_mode, plan_mode) in [("readonly", false), ("default", true), ("auto", true)] {
            let request = LaunchRequest {
                fence: &fence,
                terminal_session_id: "terminal",
                harness: HarnessId::ClaudeCode,
                approval_mode,
                plan_mode,
                hook_token: "hook",
                mcp_token: "mcp",
                provider_session_id: None,
                cancellation: &cancellation,
                account_epoch: crate::sandbox::manager::AccountEpoch::for_test(),
                identity_generation: 0,
            };
            let mut argv = Vec::new();
            append_claude_launch_args(request, None, &mut argv);

            assert_eq!(argv, ["--permission-mode", "plan"]);
            assert!(!argv.iter().any(|arg| arg == "bypassPermissions"));
            assert!(!argv
                .iter()
                .any(|arg| arg == "--dangerously-skip-permissions"));
        }
    }

    #[test]
    fn codex_workspace_trust_override_is_launch_scoped_and_precedes_resume() {
        let fence = test_fence("account", "thread");
        let cancellation = PreparationCancellation::test_uncancelled();
        let request = LaunchRequest {
            fence: &fence,
            terminal_session_id: "terminal",
            harness: HarnessId::Codex,
            approval_mode: "default",
            plan_mode: false,
            hook_token: "hook",
            mcp_token: "mcp",
            provider_session_id: Some("session"),
            cancellation: &cancellation,
            account_epoch: crate::sandbox::manager::AccountEpoch::for_test(),
            identity_generation: 0,
        };
        let trust_root = Path::new("/tmp/quote-\"-backslash-\\-café");
        let mut argv = Vec::new();
        append_codex_launch_args(
            request,
            &mut argv,
            Some("session"),
            trust_root,
            "studio-profile".to_string(),
        )
        .unwrap();
        assert_eq!(argv[0], "-c");
        assert_eq!(
            argv[1],
            format!(
                "projects={{ {} = {{ trust_level = \"trusted\" }} }}",
                serde_json::to_string(trust_root.to_str().unwrap()).unwrap()
            )
        );
        assert!(
            argv.iter().position(|arg| arg == "-c").unwrap()
                < argv.iter().position(|arg| arg == "resume").unwrap()
        );
        assert!(argv
            .iter()
            .any(|arg| arg == "--dangerously-bypass-approvals-and-sandbox"));
        assert!(!argv.iter().any(|arg| arg == "--sandbox"));
        assert!(!argv.iter().any(|arg| arg == "--ask-for-approval"));
        assert!(!argv
            .iter()
            .any(|arg| arg == "--dangerously-bypass-hook-trust"));
    }

    #[test]
    fn codex_plan_and_readonly_launches_remain_sandboxed_read_only() {
        let fence = test_fence("account", "thread");
        let cancellation = PreparationCancellation::test_uncancelled();
        for (approval_mode, plan_mode) in [("readonly", false), ("default", true), ("auto", true)] {
            let request = LaunchRequest {
                fence: &fence,
                terminal_session_id: "terminal",
                harness: HarnessId::Codex,
                approval_mode,
                plan_mode,
                hook_token: "hook",
                mcp_token: "mcp",
                provider_session_id: None,
                cancellation: &cancellation,
                account_epoch: crate::sandbox::manager::AccountEpoch::for_test(),
                identity_generation: 0,
            };
            let mut argv = Vec::new();
            append_codex_launch_args(
                request,
                &mut argv,
                None,
                Path::new("/tmp/workspace"),
                "studio-profile".to_string(),
            )
            .unwrap();

            let sandbox = argv.iter().position(|arg| arg == "--sandbox").unwrap();
            assert_eq!(argv.get(sandbox + 1).map(String::as_str), Some("read-only"));
            assert!(!argv
                .iter()
                .any(|arg| arg == "--dangerously-bypass-approvals-and-sandbox"));
            assert!(!argv.iter().any(|arg| arg == "--ask-for-approval"));
        }
    }

    #[test]
    fn codex_auto_launch_is_yolo_without_separate_approval_or_sandbox_flags() {
        let fence = test_fence("account", "thread");
        let cancellation = PreparationCancellation::test_uncancelled();
        let request = LaunchRequest {
            fence: &fence,
            terminal_session_id: "terminal",
            harness: HarnessId::Codex,
            approval_mode: "auto",
            plan_mode: false,
            hook_token: "hook",
            mcp_token: "mcp",
            provider_session_id: None,
            cancellation: &cancellation,
            account_epoch: crate::sandbox::manager::AccountEpoch::for_test(),
            identity_generation: 0,
        };
        let mut argv = Vec::new();
        append_codex_launch_args(
            request,
            &mut argv,
            None,
            Path::new("/tmp/workspace"),
            "studio-profile".to_string(),
        )
        .unwrap();

        assert!(argv
            .iter()
            .any(|arg| arg == "--dangerously-bypass-approvals-and-sandbox"));
        assert!(!argv.iter().any(|arg| arg == "--sandbox"));
        assert!(!argv.iter().any(|arg| arg == "--ask-for-approval"));
    }

    #[test]
    fn opencode_config_is_additive_and_keeps_secrets_in_environment() {
        let agent_name = opencode_agent_name("terminal-one");
        let config: Value = serde_json::from_str(&opencode_config(
            "line one\n\"line two\"",
            "file:///private/opencode-lifecycle.js",
            &agent_name,
            false,
        ))
        .unwrap();
        assert_eq!(
            config["agent"][&agent_name]["prompt"],
            "line one\n\"line two\""
        );
        assert_eq!(config["agent"][&agent_name]["disable"], false);
        assert_eq!(
            config["agent"]
                .as_object()
                .unwrap()
                .keys()
                .collect::<Vec<_>>(),
            [&agent_name]
        );
        assert_eq!(
            config["plugin"],
            json!(["file:///private/opencode-lifecycle.js"])
        );
        assert_eq!(config["mcp"]["cms"]["type"], "remote");
        assert_eq!(config["mcp"]["cms"]["url"], "{env:DECOCMS_MCP_URL}");
        assert_eq!(
            config["mcp"]["cms"]["headers"]["Authorization"],
            "{env:DECOCMS_MCP_AUTHORIZATION}"
        );
        assert_eq!(config["mcp"]["cms"]["oauth"], false);
        assert!(!config.to_string().contains("Bearer "));
    }

    #[test]
    fn opencode_readonly_agent_denies_all_current_write_paths() {
        let agent_name = opencode_agent_name("terminal-two");
        let config: Value = serde_json::from_str(&opencode_config(
            "instructions",
            "file:///private/opencode-lifecycle.js",
            &agent_name,
            true,
        ))
        .unwrap();
        assert_eq!(
            config["agent"][&agent_name]["permission"],
            json!({
                "edit": "deny",
                "bash": "deny",
                "task": "deny",
            })
        );
    }

    #[test]
    fn opencode_resume_environment_overrides_ambient_state_even_when_fresh() {
        assert_eq!(
            opencode_resume_environment(None),
            (OPENCODE_RESUME_SESSION_ENV.to_string(), String::new())
        );
        assert_eq!(
            opencode_resume_environment(Some("ses_exact")),
            (
                OPENCODE_RESUME_SESSION_ENV.to_string(),
                "ses_exact".to_string()
            )
        );
    }

    #[test]
    fn opencode_plugin_fences_root_and_turn_lifecycle_with_bounded_http() {
        for event in [
            "session.created",
            "session.updated",
            "session.error",
            "session.status",
            "session.idle",
            "permission.asked",
            "question.asked",
        ] {
            assert!(OPENCODE_LIFECYCLE_PLUGIN.contains(&format!("\"{event}\"")));
        }
        assert!(OPENCODE_LIFECYCLE_PLUGIN.contains("if (!sessionID || parentID) return false"));
        assert!(OPENCODE_LIFECYCLE_PLUGIN
            .contains("if (event.type !== \"session.created\") return false"));
        assert!(OPENCODE_LIFECYCLE_PLUGIN.contains("rootSessionID,"));
        assert!(OPENCODE_LIFECYCLE_PLUGIN.contains("phase: \"busy\""));
        assert!(OPENCODE_LIFECYCLE_PLUGIN.contains("phase: \"terminal\""));
        assert!(OPENCODE_LIFECYCLE_PLUGIN.contains("delivery = delivery.then"));
        assert!(OPENCODE_LIFECYCLE_PLUGIN.contains("AbortSignal.timeout(1000)"));
        assert!(OPENCODE_LIFECYCLE_PLUGIN.contains("return response.ok"));
        assert!(OPENCODE_LIFECYCLE_PLUGIN.contains("if (await post(body)) return true"));
        assert!(OPENCODE_LIFECYCLE_PLUGIN.contains("if (activeTurnID === terminalTurnID)"));
        assert!(!OPENCODE_LIFECYCLE_PLUGIN.contains("if (delivered && activeTurnID"));
        assert!(!OPENCODE_LIFECYCLE_PLUGIN.contains("console."));
    }

    #[test]
    fn claude_mcp_config_uses_only_the_scoped_bearer_environment() {
        let config: Value = serde_json::from_str(&claude_mcp_config()).unwrap();
        assert_eq!(
            config,
            json!({
                "mcpServers": {
                    "cms": {
                        "type": "http",
                        "url": "${DECOCMS_MCP_URL}",
                        "headers": {
                            "Authorization": "${DECOCMS_MCP_AUTHORIZATION}",
                        },
                    },
                },
            })
        );
    }

    #[test]
    fn codex_hooks_json_has_only_supported_events_and_no_plugin_metadata() {
        let config = codex_hook_settings(Path::new("/private/managed-hook"));
        let object = config.as_object().unwrap();
        assert_eq!(object.keys().collect::<Vec<_>>(), ["hooks"]);

        let hooks = object["hooks"].as_object().unwrap();
        let mut events = hooks.keys().map(String::as_str).collect::<Vec<_>>();
        events.sort_unstable();
        assert_eq!(
            events,
            [
                "PermissionRequest",
                "PostToolUse",
                "PreToolUse",
                "SessionStart",
                "Stop",
                "SubagentStart",
                "SubagentStop",
                "UserPromptSubmit",
            ]
        );
        assert!(!hooks.contains_key("SessionEnd"));
        for definitions in hooks.values() {
            let command = &definitions[0]["hooks"][0];
            assert_eq!(command["type"], "command");
            assert_eq!(command["timeout"], 3);
            assert_eq!(command["command"], "'/private/managed-hook'");
        }
    }

    #[test]
    fn local_mcp_url_encodes_each_opaque_path_segment() {
        assert_eq!(
            local_mcp_url("https://studio.local", "org / one", "agent/with?query"),
            "https://studio.local/api/org%20%2F%20one/mcp/agent%2Fwith%3Fquery"
        );
    }

    #[test]
    fn virtual_mcp_response_requires_an_entity_object() {
        assert_eq!(
            virtual_mcp_entity(json!({ "item": { "id": "agent" } })).unwrap(),
            json!({ "id": "agent" })
        );
        assert_eq!(
            virtual_mcp_entity(json!({ "id": "direct-agent" })).unwrap(),
            json!({ "id": "direct-agent" })
        );
        assert!(virtual_mcp_entity(json!({ "item": null })).is_err());
        assert!(virtual_mcp_entity(json!({ "item": [] })).is_err());
        assert!(virtual_mcp_entity(json!({})).is_err());
        assert!(virtual_mcp_entity(Value::Null).is_err());
    }

    #[test]
    fn hook_forwarder_ignores_user_curl_config_and_proxy_environment() {
        assert!(HOOK_FORWARDER_SCRIPT.contains("/usr/bin/curl -q "));
        assert!(HOOK_FORWARDER_SCRIPT.contains("--noproxy '*'"));
        assert!(HOOK_FORWARDER_SCRIPT.contains("--proto '=http,https'"));
    }

    #[test]
    fn managed_paths_are_stable_and_do_not_embed_tenant_text() {
        let fence = RtThreadFence {
            account_scope: "studio.example/user@example.com".to_string(),
            organization_id: "../org".to_string(),
            thread_id: "thread/one".to_string(),
            generation: "generation".to_string(),
        };
        let first = managed_state_dir(Path::new("/app"), &fence);
        let second = managed_state_dir(Path::new("/app"), &fence);
        assert_eq!(first, second);
        assert!(!first.to_string_lossy().contains("example.com"));
        assert!(!first.to_string_lossy().contains("../org"));
        let codex_home = managed_codex_home(Path::new("/app"), &fence.account_scope);
        assert!(!codex_home.to_string_lossy().contains("example.com"));
        assert_ne!(
            codex_home,
            managed_codex_home(Path::new("/app"), "another-account")
        );
    }

    fn test_fence(account_scope: &str, thread_id: &str) -> RtThreadFence {
        RtThreadFence {
            account_scope: account_scope.to_string(),
            organization_id: "org".to_string(),
            thread_id: thread_id.to_string(),
            generation: "generation".to_string(),
        }
    }

    fn test_thread(fence: &RtThreadFence, virtual_mcp_id: &str, branch: &str) -> RtThread {
        RtThread {
            id: fence.thread_id.clone(),
            organization_id: fence.organization_id.clone(),
            title: "Chat".to_string(),
            description: None,
            hidden: false,
            status: "active".to_string(),
            created_by: "user".to_string(),
            updated_by: None,
            virtual_mcp_id: virtual_mcp_id.to_string(),
            trigger_id: None,
            branch: Some(branch.to_string()),
            sandbox_provider_kind: None,
            harness_id: None,
            metadata: None,
            run_config: None,
            created_at: "2026-01-01T00:00:00Z".to_string(),
            updated_at: "2026-01-01T00:00:00Z".to_string(),
        }
    }

    #[tokio::test]
    async fn mismatched_reserved_branch_is_rejected_before_sandbox_materialization() {
        let root = tempfile::tempdir().unwrap();
        let state = crate::routes::intercept::test_state(root.path());
        let fence = test_fence("account", "expected-thread");
        let clone_url = "https://github.com/acme/reserved-branch.git";
        let mismatched_branch = "thread:another-thread/connection-1";
        let thread = test_thread(&fence, "vmcp-reserved", mismatched_branch);
        let virtual_mcp = json!({
            "metadata": {
                "githubRepo": { "url": clone_url }
            }
        });
        let cancellation = PreparationCancellation::test_uncancelled();
        let account_epoch = state.sandbox_manager.account_epoch();

        let error = resolve_cwd(
            &state,
            &fence,
            &thread,
            &virtual_mcp,
            &cancellation,
            account_epoch,
        )
        .await
        .unwrap_err();

        assert!(matches!(error, LaunchContextError::Workspace(_)));
        let handle = crate::sandbox::SandboxManager::compute_handle(clone_url, mismatched_branch)
            .expect("test clone URL is scopeable");
        assert!(!state
            .sandbox_manager
            .is_registered_for_account(account_epoch, &handle)
            .unwrap());
        assert!(state
            .sandbox_manager
            .get_for_account(account_epoch, &handle)
            .unwrap()
            .is_none());
        assert!(!crate::sandbox::worktree_root(root.path(), &handle).exists());
    }

    #[tokio::test]
    async fn codex_threads_share_regular_account_auth_but_keep_distinct_profiles() {
        let root = tempfile::tempdir().unwrap();
        let cancellation = PreparationCancellation::test_uncancelled();
        let system_home = root.path().join("system-codex");
        tokio::fs::create_dir_all(&system_home).await.unwrap();
        let source_auth = system_home.join("auth.json");
        tokio::fs::write(&source_auth, br#"{"token":"account-token"}"#)
            .await
            .unwrap();
        let first_fence = test_fence("account", "thread-one");
        let second_fence = test_fence("account", "thread-two");

        let (first_home, first_profile) = prepare_codex_managed_files(
            root.path(),
            &first_fence,
            Some(&source_auth),
            "developer_instructions = \"first\"\n",
            &cancellation,
        )
        .await
        .unwrap();
        let (second_home, second_profile) = prepare_codex_managed_files(
            root.path(),
            &second_fence,
            Some(&source_auth),
            "developer_instructions = \"second\"\n",
            &cancellation,
        )
        .await
        .unwrap();

        assert_eq!(first_home, second_home);
        assert_ne!(first_profile, second_profile);
        let managed_auth = first_home.join("auth.json");
        let metadata = tokio::fs::symlink_metadata(&managed_auth).await.unwrap();
        assert!(metadata.is_file());
        assert!(!metadata.file_type().is_symlink());
        assert_eq!(
            tokio::fs::read_to_string(&managed_auth).await.unwrap(),
            r#"{"token":"account-token"}"#
        );
        assert_eq!(
            tokio::fs::read_to_string(codex_profile_path(&first_home, &first_profile))
                .await
                .unwrap(),
            "developer_instructions = \"first\"\n"
        );
        assert_eq!(
            tokio::fs::read_to_string(codex_profile_path(&second_home, &second_profile))
                .await
                .unwrap(),
            "developer_instructions = \"second\"\n"
        );

        let history = first_home.join("sessions/2026/history.jsonl");
        create_private_dir(history.parent().unwrap()).await.unwrap();
        tokio::fs::write(&history, b"provider-owned history")
            .await
            .unwrap();
        let first_state = managed_state_dir(root.path(), &first_fence);
        create_private_dir(&first_state).await.unwrap();
        cleanup_managed_state(root.path(), &first_fence)
            .await
            .unwrap();
        assert!(!first_state.exists());
        assert!(!codex_profile_path(&first_home, &first_profile).exists());
        assert!(codex_profile_path(&second_home, &second_profile).is_file());
        assert!(managed_auth.is_file());
        assert!(history.is_file());
    }

    #[tokio::test]
    async fn opencode_normal_launches_enable_auto_before_exact_session_resume() {
        let fence = test_fence("account", "thread-one");
        let cancellation = PreparationCancellation::test_uncancelled();
        for approval_mode in ["default", "auto"] {
            let root = tempfile::tempdir().unwrap();
            let request = LaunchRequest {
                fence: &fence,
                terminal_session_id: "terminal-one",
                harness: HarnessId::OpenCode,
                approval_mode,
                plan_mode: false,
                hook_token: "hook-token",
                mcp_token: "mcp-token",
                provider_session_id: Some("ses_exact"),
                cancellation: &cancellation,
                account_epoch: crate::sandbox::manager::AccountEpoch::for_test(),
                identity_generation: 0,
            };
            let mut argv = Vec::new();
            let config = prepare_opencode(
                root.path(),
                "instructions",
                request,
                &mut argv,
                Some("ses_exact"),
            )
            .await
            .unwrap();

            assert_eq!(
                argv,
                [
                    "--agent",
                    "studio-native-terminal-one",
                    "--auto",
                    "--session",
                    "ses_exact",
                ]
            );
            let config: Value = serde_json::from_str(&config).unwrap();
            let plugin = config["plugin"][0].as_str().unwrap();
            assert!(plugin.starts_with("file://"));
            assert!(root.path().join("opencode-lifecycle.js").is_file());
        }
    }

    #[tokio::test]
    async fn opencode_readonly_and_plan_launches_never_enable_auto() {
        let cancellation = PreparationCancellation::test_uncancelled();
        for (approval_mode, plan_mode) in [("readonly", false), ("default", true), ("auto", true)] {
            let root = tempfile::tempdir().unwrap();
            let fence = test_fence("account", "thread-one");
            let request = LaunchRequest {
                fence: &fence,
                terminal_session_id: "terminal-one",
                harness: HarnessId::OpenCode,
                approval_mode,
                plan_mode,
                hook_token: "hook-token",
                mcp_token: "mcp-token",
                provider_session_id: None,
                cancellation: &cancellation,
                account_epoch: crate::sandbox::manager::AccountEpoch::for_test(),
                identity_generation: 0,
            };
            let mut argv = Vec::new();
            let config = prepare_opencode(root.path(), "instructions", request, &mut argv, None)
                .await
                .unwrap();

            assert_eq!(argv, ["--agent", "studio-native-terminal-one"]);
            let config: Value = serde_json::from_str(&config).unwrap();
            assert_eq!(
                config["agent"]["studio-native-terminal-one"]["permission"],
                json!({
                    "edit": "deny",
                    "bash": "deny",
                    "task": "deny",
                })
            );
        }
    }

    #[tokio::test]
    async fn initialized_codex_home_does_not_reseed_deleted_auth() {
        let root = tempfile::tempdir().unwrap();
        let cancellation = PreparationCancellation::test_uncancelled();
        let source_auth = root.path().join("system-auth.json");
        tokio::fs::write(&source_auth, br#"{"token":"first"}"#)
            .await
            .unwrap();
        let fence = test_fence("account", "thread-one");
        let (codex_home, _) = prepare_codex_managed_files(
            root.path(),
            &fence,
            Some(&source_auth),
            "developer_instructions = \"first\"\n",
            &cancellation,
        )
        .await
        .unwrap();
        tokio::fs::remove_file(codex_home.join("auth.json"))
            .await
            .unwrap();
        tokio::fs::write(&source_auth, br#"{"token":"new-system-token"}"#)
            .await
            .unwrap();

        prepare_codex_managed_files(
            root.path(),
            &fence,
            Some(&source_auth),
            "developer_instructions = \"second\"\n",
            &cancellation,
        )
        .await
        .unwrap();
        assert!(!codex_home.join("auth.json").exists());
        assert!(codex_home.join(CODEX_HOME_INITIALIZED_MARKER).is_file());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn codex_home_refuses_symlinked_auth_source_and_destination() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().unwrap();
        let cancellation = PreparationCancellation::test_uncancelled();
        let actual_auth = root.path().join("actual-auth.json");
        tokio::fs::write(&actual_auth, b"{}").await.unwrap();
        let source_link = root.path().join("source-auth.json");
        symlink(&actual_auth, &source_link).unwrap();
        let source_fence = test_fence("source-account", "thread");
        let source_error = prepare_codex_managed_files(
            root.path(),
            &source_fence,
            Some(&source_link),
            "developer_instructions = \"source\"\n",
            &cancellation,
        )
        .await
        .unwrap_err();
        assert!(source_error.to_string().contains("not a regular file"));

        let destination_fence = test_fence("destination-account", "thread");
        let destination_home = managed_codex_home(root.path(), &destination_fence.account_scope);
        create_private_dir(&destination_home).await.unwrap();
        symlink(&actual_auth, destination_home.join("auth.json")).unwrap();
        let destination_error = prepare_codex_managed_files(
            root.path(),
            &destination_fence,
            Some(&actual_auth),
            "developer_instructions = \"destination\"\n",
            &cancellation,
        )
        .await
        .unwrap_err();
        assert!(destination_error.to_string().contains("not a regular file"));
    }
}
