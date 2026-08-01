//! Server-owned launch context for the interactive native coding agents.
//!
//! The webview chooses a harness and terminal dimensions. Everything with
//! authority or tenancy implications -- cwd, provider resume id, system
//! instructions, MCP endpoint and credentials, and hook configuration -- is
//! rebuilt here from the fenced local thread and the authenticated upstream
//! session.

use std::path::{Path, PathBuf};

use harness::HarnessId;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::routes::threads::db::{RtThread, RtThreadFence, ThreadsDb};
use crate::state::AppState;

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
const MAX_CODEX_AUTH_BYTES: u64 = 4 * 1024 * 1024;
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
            .finish()
    }
}

#[derive(Debug, thiserror::Error)]
pub enum LaunchContextError {
    #[error("thread is no longer available")]
    StaleThread,
    #[error("the selected agent is unavailable: {0}")]
    Harness(#[from] harness::ResolveError),
    #[error("could not load the selected Studio agent: {0}")]
    VirtualMcp(String),
    #[error("the local Studio MCP endpoint is not ready")]
    LocalEndpointUnavailable,
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
}

pub async fn prepare(
    state: &AppState,
    db: &'static ThreadsDb,
    request: LaunchRequest<'_>,
) -> Result<PreparedLaunch, LaunchContextError> {
    let thread = db
        .rt_get_thread_for_fence(request.fence)
        .map_err(|error| LaunchContextError::Workspace(error.to_string()))?
        .ok_or(LaunchContextError::StaleThread)?;
    let mut argv = harness::resolve_checked(request.harness)?;
    // The picker consumes the same compatibility probe, but repeat it at the
    // process boundary so a stale renderer or direct WebSocket request cannot
    // launch an installed-yet-unsupported provider.
    harness::detect::require_launch_ready(request.harness, &argv).await?;
    let virtual_mcp = load_virtual_mcp(request.fence, &thread).await?;
    let cwd = resolve_cwd(state, request.fence, &thread, &virtual_mcp).await?;
    let system_prompt =
        build_system_prompt(state, request.fence, &thread, &virtual_mcp, &cwd).await;
    let credentials = crate::sandbox::org_mount::local_credentials()
        .cloned()
        .ok_or(LaunchContextError::LocalEndpointUnavailable)?;
    let provider_session_id = request.provider_session_id.map(str::to_string);

    let state_dir = managed_state_dir(&state.app_root, request.fence);
    create_private_dir(&state_dir).await?;
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
            // Claude settings are thread-owned, so deletion removes the
            // complete overlay without affecting another chat.
            let hook_script = ensure_hook_forwarder(&state_dir).await?;
            prepare_claude(
                &state_dir,
                &hook_script,
                &system_prompt,
                request,
                provider_session_id.as_deref(),
                &mut argv,
            )
            .await?;
        }
        HarnessId::Codex => {
            // Codex refreshes auth.json by replacing it. All chats for one
            // Studio account therefore share a regular, account-owned home;
            // a per-thread symlink/copy would strand refreshed credentials in
            // only the process that happened to refresh first.
            let home_lock = state
                .agent_sessions
                .codex_home_lock(&request.fence.account_scope);
            let _home_guard = home_lock.lock().await;
            let codex_home = prepare_codex(
                &state.app_root,
                &system_prompt,
                request,
                &mut argv,
                provider_session_id.as_deref(),
                &mcp_url,
            )
            .await?;
            title_environment =
                harness::title::TitleEnvironment::for_codex_home(codex_home.clone());
            env.push(("CODEX_HOME".to_string(), codex_home.display().to_string()));
        }
        HarnessId::OpenCode => {
            let config = prepare_opencode(
                &state_dir,
                &system_prompt,
                request,
                &mut argv,
                provider_session_id.as_deref(),
            )
            .await?;
            env.push((OPENCODE_CONFIG_CONTENT_ENV.to_string(), config));
            // Override ambient shell/dev-runner state on fresh launches too.
            // Otherwise an inherited stale resume id would make the plugin
            // reject every session event from the newly-created root.
            env.push(opencode_resume_environment(provider_session_id.as_deref()));
        }
    }

    Ok(PreparedLaunch {
        harness: request.harness,
        program,
        args: argv,
        cwd,
        env,
        title_environment,
        provider_session_id,
        mcp_path,
    })
}

async fn load_virtual_mcp(
    fence: &RtThreadFence,
    thread: &RtThread,
) -> Result<Value, LaunchContextError> {
    let response = crate::routes::upstream::call_org_tool(
        &fence.organization_id,
        "COLLECTION_VIRTUAL_MCP_GET",
        &json!({ "id": thread.virtual_mcp_id }),
    )
    .await
    .map_err(LaunchContextError::VirtualMcp)?;
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
) -> Result<PathBuf, LaunchContextError> {
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
            .ensure(&config)
            .await
            .map(|sandbox| sandbox.workdir.clone())
            .map_err(LaunchContextError::Workspace);
    }

    let org_dir = crate::sandbox::org_view::org_mount_root(&state.app_root, &fence.organization_id)
        .ok_or_else(|| LaunchContextError::Workspace("invalid organization path".to_string()))?;
    crate::sandbox::org_mount::warm(&state.app_root, &fence.organization_id);
    tokio::fs::create_dir_all(&org_dir).await?;
    Ok(org_dir)
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
    let prompt_path = state_dir.join("claude-system-prompt.txt");
    write_private_file(&prompt_path, system_prompt.as_bytes(), false).await?;
    let settings_path = state_dir.join("claude-hooks.json");
    let settings = claude_hook_settings(hook_script);
    write_private_file(&settings_path, &serde_json::to_vec(&settings)?, false).await?;

    argv.extend([
        "--append-system-prompt-file".to_string(),
        prompt_path.display().to_string(),
        "--mcp-config".to_string(),
        claude_mcp_config(),
        "--strict-mcp-config".to_string(),
        "--settings".to_string(),
        settings_path.display().to_string(),
    ]);
    if request.plan_mode || request.approval_mode == "readonly" {
        argv.extend(["--permission-mode".to_string(), "plan".to_string()]);
    } else if request.approval_mode == "auto" {
        argv.extend(["--permission-mode".to_string(), "acceptEdits".to_string()]);
    }
    if let Some(provider_session_id) = provider_session_id {
        argv.extend(["--resume".to_string(), provider_session_id.to_string()]);
    }
    Ok(())
}

async fn prepare_codex(
    app_root: &Path,
    system_prompt: &str,
    request: LaunchRequest<'_>,
    argv: &mut Vec<String>,
    provider_session_id: Option<&str>,
    mcp_url: &str,
) -> Result<PathBuf, LaunchContextError> {
    let config = codex_config(system_prompt, mcp_url);
    let (codex_home, profile_name) = prepare_codex_managed_files(
        app_root,
        request.fence,
        codex_auth_source_path().as_deref(),
        &config,
    )
    .await?;

    argv.extend([
        "--no-alt-screen".to_string(),
        "--dangerously-bypass-hook-trust".to_string(),
        "--profile".to_string(),
        profile_name,
        "--disable".to_string(),
        "apps".to_string(),
        "--disable".to_string(),
        "plugins".to_string(),
        "--sandbox".to_string(),
        if request.plan_mode || request.approval_mode == "readonly" {
            "read-only".to_string()
        } else {
            "workspace-write".to_string()
        },
    ]);
    if request.approval_mode == "auto" {
        argv.extend(["--ask-for-approval".to_string(), "on-request".to_string()]);
    }
    if let Some(provider_session_id) = provider_session_id {
        argv.extend(["resume".to_string(), provider_session_id.to_string()]);
    }
    Ok(codex_home)
}

async fn prepare_opencode(
    state_dir: &Path,
    system_prompt: &str,
    request: LaunchRequest<'_>,
    argv: &mut Vec<String>,
    provider_session_id: Option<&str>,
) -> Result<String, LaunchContextError> {
    let plugin_path = state_dir.join("opencode-lifecycle.js");
    write_private_file(&plugin_path, OPENCODE_LIFECYCLE_PLUGIN.as_bytes(), false).await?;
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
    if request.approval_mode == "auto" && !readonly {
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
    for event in [
        "SessionStart",
        "UserPromptSubmit",
        "PreToolUse",
        "PermissionRequest",
        "PostToolUse",
        "SubagentStart",
        "SubagentStop",
        "Stop",
    ] {
        hooks.insert(
            event.to_string(),
            json!([{
                "hooks": [{
                    "type": "command",
                    "command": command.clone(),
                    "timeout": 3,
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
         [mcp_servers.{MCP_SERVER_NAME}]\n\
         url = {mcp_url}\n\
         [mcp_servers.{MCP_SERVER_NAME}.env_http_headers]\n\
         Authorization = \"{MCP_AUTHORIZATION_ENV}\"\n"
    )
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

async fn ensure_hook_forwarder(state_dir: &Path) -> Result<PathBuf, std::io::Error> {
    create_private_dir(state_dir).await?;
    let path = state_dir.join("forward-hook.sh");
    write_private_file(&path, HOOK_FORWARDER_SCRIPT.as_bytes(), true).await?;
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
) -> Result<(PathBuf, String), LaunchContextError> {
    let codex_home = managed_codex_home(app_root, &fence.account_scope);
    initialize_codex_home(&codex_home, auth_source).await?;

    let runtime_dir = codex_home.join("studio-runtime");
    let hook_script = ensure_hook_forwarder(&runtime_dir).await?;
    write_private_file(
        &codex_home.join("hooks.json"),
        &serde_json::to_vec(&codex_hook_settings(&hook_script))?,
        false,
    )
    .await?;

    let profile_name = codex_profile_name(fence);
    write_private_file(
        &codex_profile_path(&codex_home, &profile_name),
        profile_config.as_bytes(),
        false,
    )
    .await?;
    Ok((codex_home, profile_name))
}

async fn initialize_codex_home(
    codex_home: &Path,
    auth_source: Option<&Path>,
) -> Result<(), std::io::Error> {
    create_private_dir(codex_home).await?;
    let marker = codex_home.join(CODEX_HOME_INITIALIZED_MARKER);
    let destination = codex_home.join("auth.json");
    let initialized = regular_file_if_present(&marker, "Codex home marker").await?;
    let destination_exists = regular_file_if_present(&destination, "managed Codex auth").await?;

    if initialized {
        if destination_exists {
            set_private_file_permissions(&destination, false).await?;
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
                    ));
                }
                let contents = tokio::fs::read(source).await?;
                write_private_file(&destination, &contents, false).await?;
            }
        }
    } else {
        set_private_file_permissions(&destination, false).await?;
    }

    // The marker lands last. A crash before it is safe: a complete regular
    // destination is preserved on retry, and a missing destination may be
    // seeded again before any provider process has been admitted.
    write_private_file(&marker, b"initialized\n", false).await
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
        assert!(!config.contains("Cookie"));
        assert!(!config.contains("Origin"));
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

    #[tokio::test]
    async fn codex_threads_share_regular_account_auth_but_keep_distinct_profiles() {
        let root = tempfile::tempdir().unwrap();
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
        )
        .await
        .unwrap();
        let (second_home, second_profile) = prepare_codex_managed_files(
            root.path(),
            &second_fence,
            Some(&source_auth),
            "developer_instructions = \"second\"\n",
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
    async fn opencode_launch_uses_exact_session_resume_and_managed_plugin() {
        let root = tempfile::tempdir().unwrap();
        let fence = test_fence("account", "thread-one");
        let request = LaunchRequest {
            fence: &fence,
            terminal_session_id: "terminal-one",
            harness: HarnessId::OpenCode,
            approval_mode: "auto",
            plan_mode: false,
            hook_token: "hook-token",
            mcp_token: "mcp-token",
            provider_session_id: Some("ses_exact"),
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

    #[tokio::test]
    async fn opencode_readonly_and_plan_launches_never_enable_auto() {
        for (approval_mode, plan_mode) in [("readonly", false), ("auto", true)] {
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
        )
        .await
        .unwrap_err();
        assert!(destination_error.to_string().contains("not a regular file"));
    }
}
