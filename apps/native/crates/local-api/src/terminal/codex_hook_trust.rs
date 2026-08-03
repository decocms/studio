//! Short-lived Codex app-server client used to pre-trust Studio-owned hooks.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde_json::{json, Map, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::{ChildStdin, ChildStdout};
use tokio::sync::OwnedMutexGuard;

use crate::process_group::ProcessGroupChild;

const PREFLIGHT_PATH_TIMEOUT: Duration = Duration::from_secs(2);
const PREFLIGHT_EXCHANGE_TIMEOUT: Duration = Duration::from_secs(8);
const PREFLIGHT_CLEANUP_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_JSONL_LINE_BYTES: usize = 1024 * 1024;
const MAX_JSONL_TOTAL_BYTES: usize = 4 * 1024 * 1024;
const MAX_JSONL_MESSAGES: usize = 128;
const MAX_LISTED_HOOKS: usize = 256;

pub(super) const MANAGED_HOOK_TIMEOUT_SECS: u64 = 3;

pub(super) struct CodexHookEvent {
    pub config_name: &'static str,
    pub rpc_name: &'static str,
}

pub(super) const CODEX_HOOK_EVENTS: &[CodexHookEvent] = &[
    CodexHookEvent {
        config_name: "SessionStart",
        rpc_name: "sessionStart",
    },
    CodexHookEvent {
        config_name: "UserPromptSubmit",
        rpc_name: "userPromptSubmit",
    },
    CodexHookEvent {
        config_name: "PreToolUse",
        rpc_name: "preToolUse",
    },
    CodexHookEvent {
        config_name: "PermissionRequest",
        rpc_name: "permissionRequest",
    },
    CodexHookEvent {
        config_name: "PostToolUse",
        rpc_name: "postToolUse",
    },
    CodexHookEvent {
        config_name: "SubagentStart",
        rpc_name: "subagentStart",
    },
    CodexHookEvent {
        config_name: "SubagentStop",
        rpc_name: "subagentStop",
    },
    CodexHookEvent {
        config_name: "Stop",
        rpc_name: "stop",
    },
];

#[derive(Debug, thiserror::Error)]
pub(super) enum CodexHookTrustError {
    #[error("could not access managed Codex hook paths: {0}")]
    Path(std::io::Error),
    #[error("managed Codex hook path resolution timed out")]
    PathTimeout,
    #[error("could not start the Codex hook trust helper: {0}")]
    Spawn(std::io::Error),
    #[error("Codex hook trust protocol failed: {0}")]
    Protocol(String),
    #[error("Codex hook trust exchange timed out")]
    ExchangeTimeout,
    #[error("Codex hook trust helper cleanup exceeded its deadline")]
    CleanupTimeout,
    #[error("Codex hook trust owner failed: {0}")]
    Owner(String),
}

struct OwnedPreflight {
    program: String,
    prefix_argv: Vec<String>,
    codex_home: PathBuf,
    cwd: PathBuf,
    managed_command: String,
    child_lifetime_lock_path: PathBuf,
    home_guard: OwnedMutexGuard<()>,
    account_guard: upstream::SessionTransitionGuard,
}

pub(super) struct ManagedHookTrustRequest<'a> {
    pub program: &'a str,
    pub prefix_argv: &'a [String],
    pub codex_home: &'a Path,
    pub cwd: &'a Path,
    pub managed_command: &'a str,
    pub child_lifetime_lock_path: &'a Path,
    pub home_guard: OwnedMutexGuard<()>,
    pub account_guard: upstream::SessionTransitionGuard,
}

pub(super) async fn establish_managed_hook_trust(
    request: ManagedHookTrustRequest<'_>,
) -> Result<upstream::SessionTransitionGuard, CodexHookTrustError> {
    let ManagedHookTrustRequest {
        program,
        prefix_argv,
        codex_home,
        cwd,
        managed_command,
        child_lifetime_lock_path,
        home_guard,
        account_guard,
    } = request;
    let owned = OwnedPreflight {
        program: program.to_string(),
        prefix_argv: prefix_argv.to_vec(),
        codex_home: codex_home.to_path_buf(),
        cwd: cwd.to_path_buf(),
        managed_command: managed_command.to_string(),
        child_lifetime_lock_path: child_lifetime_lock_path.to_path_buf(),
        home_guard,
        account_guard,
    };
    tokio::spawn(run_owned_preflight(owned))
        .await
        .map_err(|error| CodexHookTrustError::Owner(error.to_string()))?
}

async fn run_owned_preflight(
    preflight: OwnedPreflight,
) -> Result<upstream::SessionTransitionGuard, CodexHookTrustError> {
    let OwnedPreflight {
        program,
        prefix_argv,
        codex_home,
        cwd,
        managed_command,
        child_lifetime_lock_path,
        home_guard: _home_guard,
        account_guard,
    } = preflight;

    let hooks_path = codex_home.join("hooks.json");
    let config_path = codex_home.join("config.toml");
    let canonical_paths = tokio::time::timeout(PREFLIGHT_PATH_TIMEOUT, async {
        tokio::try_join!(
            tokio::fs::canonicalize(&cwd),
            tokio::fs::canonicalize(&hooks_path),
            tokio::fs::canonicalize(&codex_home),
            validate_config_target(&config_path)
        )
    })
    .await
    .map_err(|_| CodexHookTrustError::PathTimeout)?
    .map_err(CodexHookTrustError::Path)?;
    let (canonical_cwd, canonical_hooks_path, canonical_codex_home, ()) = canonical_paths;
    // A fresh managed home has no config.toml until config/batchWrite creates
    // it. Resolve the already-canonical parent now, then canonicalize the
    // reported write target after that mutation.
    let canonical_config_path = canonical_codex_home.join("config.toml");
    let cwd_wire = canonical_cwd
        .to_str()
        .ok_or_else(|| CodexHookTrustError::Protocol("canonical cwd is not valid UTF-8".into()))?
        .to_string();

    let mut args = prefix_argv;
    args.extend([
        "-c".to_string(),
        "features.hooks=true".to_string(),
        "app-server".to_string(),
        "--stdio".to_string(),
    ]);
    let mut command = tokio::process::Command::new(program);
    command
        .args(args)
        .current_dir(&canonical_cwd)
        .env("CODEX_HOME", &codex_home)
        .env_remove("DECOCMS_MCP_URL")
        .env_remove("DECOCMS_MCP_AUTHORIZATION")
        .env_remove("STUDIO_AGENT_HOOK_URL")
        .env_remove("STUDIO_AGENT_HOOK_TOKEN")
        .env_remove("OPENCODE_CONFIG_CONTENT")
        .env_remove("STUDIO_OPENCODE_SESSION_ID")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let mut child = ProcessGroupChild::spawn(&mut command, &child_lifetime_lock_path)
        .await
        .map_err(CodexHookTrustError::Spawn)?;
    let exchange = match child.take_stdin() {
        Some(stdin) => match child.take_stdout() {
            Some(stdout) => match tokio::time::timeout(
                PREFLIGHT_EXCHANGE_TIMEOUT,
                run_exchange(
                    stdin,
                    stdout,
                    &cwd_wire,
                    &canonical_hooks_path,
                    &canonical_codex_home,
                    &canonical_config_path,
                    &managed_command,
                ),
            )
            .await
            {
                Ok(result) => result,
                Err(_) => Err(CodexHookTrustError::ExchangeTimeout),
            },
            None => Err(CodexHookTrustError::Protocol(
                "Codex hook trust helper did not expose stdout".into(),
            )),
        },
        None => Err(CodexHookTrustError::Protocol(
            "Codex hook trust helper did not expose stdin".into(),
        )),
    };
    let account_guard =
        cleanup_child(child, "Codex hook trust helper cleanup", account_guard).await?;
    exchange?;
    Ok(account_guard)
}

async fn validate_config_target(path: &Path) -> std::io::Result<()> {
    match tokio::fs::symlink_metadata(path).await {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!(
                    "managed Codex config is not a regular file: {}",
                    path.display()
                ),
            ))
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

async fn cleanup_child(
    child: ProcessGroupChild,
    context: &'static str,
    account_guard: upstream::SessionTransitionGuard,
) -> Result<upstream::SessionTransitionGuard, CodexHookTrustError> {
    let mut cleanup = tokio::spawn(async move {
        let mut child = child;
        child
            .kill_and_reap(PREFLIGHT_CLEANUP_TIMEOUT, context)
            .await;
        account_guard
    });
    match tokio::time::timeout(PREFLIGHT_CLEANUP_TIMEOUT, &mut cleanup).await {
        Ok(Ok(account_guard)) => Ok(account_guard),
        Ok(Err(error)) => {
            tracing::error!(%error, context, "Codex hook trust cleanup task failed");
            Err(CodexHookTrustError::Owner(error.to_string()))
        }
        Err(_) => {
            tracing::error!(context, "Codex hook trust cleanup detached after deadline");
            // The detached task retains both process ownership and the
            // account-transition guard until whole-group quiescence is
            // proven. This launch fails closed instead of spawning a PTY
            // beside a helper whose lifetime is still ambiguous.
            Err(CodexHookTrustError::CleanupTimeout)
        }
    }
}

async fn run_exchange(
    stdin: ChildStdin,
    stdout: ChildStdout,
    cwd_wire: &str,
    canonical_hooks_path: &Path,
    canonical_codex_home: &Path,
    canonical_config_path: &Path,
    managed_command: &str,
) -> Result<(), CodexHookTrustError> {
    let mut rpc = JsonlRpc::new(stdin, stdout);
    let initialize_result = rpc
        .request(
            "initialize",
            json!({
                "clientInfo": {
                    "name": "studio_native",
                    "title": "Studio Native",
                    "version": env!("CARGO_PKG_VERSION"),
                }
            }),
        )
        .await?;
    require_canonical_result_path(
        &initialize_result,
        "codexHome",
        canonical_codex_home,
        "initialize",
    )
    .await?;
    rpc.notify("initialized", None).await?;

    let list_params = json!({ "cwds": [cwd_wire] });
    let initial_result = rpc.request("hooks/list", list_params.clone()).await?;
    let mut initial = parse_hook_list_response(&initial_result, cwd_wire)?;
    canonicalize_user_hook_sources(&mut initial).await;
    let selected = select_managed_hooks(&initial, canonical_hooks_path, managed_command)?;

    if let Some(params) = build_trust_batch_params(&selected) {
        let batch_result = rpc.request("config/batchWrite", params).await?;
        require_canonical_result_path(
            &batch_result,
            "filePath",
            canonical_config_path,
            "config/batchWrite",
        )
        .await?;
        let verify_result = rpc.request("hooks/list", list_params).await?;
        let mut verify = parse_hook_list_response(&verify_result, cwd_wire)?;
        canonicalize_user_hook_sources(&mut verify).await;
        let verified = select_managed_hooks(&verify, canonical_hooks_path, managed_command)?;
        verify_same_hooks_are_trusted(&selected, &verified)?;
    }
    Ok(())
}

async fn require_canonical_result_path(
    result: &Value,
    field: &str,
    expected: &Path,
    method: &str,
) -> Result<(), CodexHookTrustError> {
    let reported = result
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(Path::new)
        .ok_or_else(|| protocol(format!("{method} result omitted {field}")))?;
    if !reported.is_absolute() {
        return Err(protocol(format!(
            "{method} result.{field} was not an absolute path"
        )));
    }
    let canonical = tokio::time::timeout(PREFLIGHT_PATH_TIMEOUT, tokio::fs::canonicalize(reported))
        .await
        .map_err(|_| protocol(format!("{method} result.{field} path resolution timed out")))?
        .map_err(|_| protocol(format!("{method} result.{field} could not be resolved")))?;
    if canonical != expected {
        return Err(protocol(format!(
            "{method} result.{field} did not identify the managed Codex path"
        )));
    }
    Ok(())
}

async fn canonicalize_user_hook_sources(listings: &mut [RawHookListing]) {
    for listing in listings {
        if listing.source.as_deref() != Some("user") {
            continue;
        }
        let Some(source_path) = listing
            .source_path
            .as_deref()
            .filter(|path| !path.is_empty())
        else {
            continue;
        };
        if let Ok(path) = tokio::fs::canonicalize(source_path).await {
            listing.canonical_source_path = Some(path);
        }
    }
}

#[derive(Clone, Debug)]
struct RawHookListing {
    key: Option<String>,
    event_name: Option<String>,
    handler_type: Option<String>,
    matcher: Option<Value>,
    command: Option<String>,
    timeout_sec: Option<u64>,
    source: Option<String>,
    source_path: Option<String>,
    canonical_source_path: Option<PathBuf>,
    plugin_id: Option<Value>,
    enabled: Option<bool>,
    is_managed: Option<bool>,
    current_hash: Option<String>,
    trust_status: Option<String>,
}

fn parse_hook_list_response(
    result: &Value,
    expected_cwd: &str,
) -> Result<Vec<RawHookListing>, CodexHookTrustError> {
    let data = result
        .get("data")
        .and_then(Value::as_array)
        .ok_or_else(|| protocol("hooks/list result.data must be an array"))?;
    let mut listings = Vec::new();
    let mut matched_cwd = false;
    for entry in data {
        if entry.get("cwd").and_then(Value::as_str) != Some(expected_cwd) {
            continue;
        }
        matched_cwd = true;
        let hooks = entry
            .get("hooks")
            .and_then(Value::as_array)
            .ok_or_else(|| protocol("hooks/list entry.hooks must be an array"))?;
        if listings.len().saturating_add(hooks.len()) > MAX_LISTED_HOOKS {
            return Err(protocol("hooks/list returned too many hooks"));
        }
        for hook in hooks {
            let object = hook
                .as_object()
                .ok_or_else(|| protocol("hooks/list hook must be an object"))?;
            listings.push(RawHookListing {
                key: string_field(object, "key"),
                event_name: string_field(object, "eventName"),
                handler_type: string_field(object, "handlerType"),
                matcher: object.get("matcher").cloned(),
                command: string_field(object, "command"),
                timeout_sec: object.get("timeoutSec").and_then(Value::as_u64),
                source: string_field(object, "source"),
                source_path: string_field(object, "sourcePath"),
                canonical_source_path: None,
                plugin_id: object.get("pluginId").cloned(),
                enabled: object.get("enabled").and_then(Value::as_bool),
                is_managed: object.get("isManaged").and_then(Value::as_bool),
                current_hash: string_field(object, "currentHash"),
                trust_status: string_field(object, "trustStatus"),
            });
        }
    }
    if !matched_cwd {
        return Err(protocol("hooks/list omitted the requested cwd"));
    }
    Ok(listings)
}

fn string_field(object: &Map<String, Value>, key: &str) -> Option<String> {
    object.get(key).and_then(Value::as_str).map(str::to_string)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TrustStatus {
    Trusted,
    Untrusted,
    Modified,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct ManagedHookListing {
    event_name: String,
    key: String,
    current_hash: String,
    trust_status: TrustStatus,
}

fn select_managed_hooks(
    listings: &[RawHookListing],
    canonical_hooks_path: &Path,
    managed_command: &str,
) -> Result<Vec<ManagedHookListing>, CodexHookTrustError> {
    let matching = listings
        .iter()
        .filter(|listing| {
            listing.source.as_deref() == Some("user")
                && listing.canonical_source_path.as_deref() == Some(canonical_hooks_path)
        })
        .collect::<Vec<_>>();
    if matching.len() != CODEX_HOOK_EVENTS.len() {
        return Err(protocol(format!(
            "hooks/list reported {} of {} managed hooks",
            matching.len(),
            CODEX_HOOK_EVENTS.len()
        )));
    }

    let expected_events = CODEX_HOOK_EVENTS
        .iter()
        .map(|event| event.rpc_name)
        .collect::<HashSet<_>>();
    let mut by_event = HashMap::new();
    let mut keys = HashSet::new();
    for listing in matching {
        let event_name = required_nonempty(&listing.event_name, "eventName")?;
        if !expected_events.contains(event_name) {
            return Err(protocol(format!(
                "managed hooks/list entry used unexpected event {event_name}"
            )));
        }
        if listing.handler_type.as_deref() != Some("command")
            || listing.matcher.as_ref() != Some(&Value::Null)
            || listing.command.as_deref() != Some(managed_command)
            || listing.timeout_sec != Some(MANAGED_HOOK_TIMEOUT_SECS)
            || listing.plugin_id.as_ref() != Some(&Value::Null)
            || listing.enabled != Some(true)
            || listing.is_managed != Some(false)
        {
            return Err(protocol(format!(
                "managed hooks/list metadata did not match event {event_name}"
            )));
        }
        let key = required_nonempty(&listing.key, "key")?.to_string();
        let current_hash = required_nonempty(&listing.current_hash, "currentHash")?.to_string();
        let trust_status = match required_nonempty(&listing.trust_status, "trustStatus")? {
            "trusted" => TrustStatus::Trusted,
            "untrusted" => TrustStatus::Untrusted,
            "modified" => TrustStatus::Modified,
            other => {
                return Err(protocol(format!(
                    "managed hook {event_name} had unknown trust status {other}"
                )))
            }
        };
        if !keys.insert(key.clone()) {
            return Err(protocol("hooks/list repeated a managed hook key"));
        }
        let selected = ManagedHookListing {
            event_name: event_name.to_string(),
            key,
            current_hash,
            trust_status,
        };
        if by_event.insert(event_name.to_string(), selected).is_some() {
            return Err(protocol(format!(
                "hooks/list repeated managed event {event_name}"
            )));
        }
    }

    CODEX_HOOK_EVENTS
        .iter()
        .map(|event| {
            by_event
                .remove(event.rpc_name)
                .ok_or_else(|| protocol(format!("hooks/list omitted {}", event.rpc_name)))
        })
        .collect()
}

fn required_nonempty<'a>(
    value: &'a Option<String>,
    field: &str,
) -> Result<&'a str, CodexHookTrustError> {
    value
        .as_deref()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| protocol(format!("managed hooks/list entry omitted {field}")))
}

fn build_trust_batch_params(listings: &[ManagedHookListing]) -> Option<Value> {
    let mut value = Map::new();
    for listing in listings {
        if listing.trust_status == TrustStatus::Trusted {
            continue;
        }
        value.insert(
            listing.key.clone(),
            json!({ "trusted_hash": listing.current_hash }),
        );
    }
    if value.is_empty() {
        return None;
    }
    Some(json!({
        "edits": [{
            "keyPath": "hooks.state",
            "value": value,
            "mergeStrategy": "upsert",
        }],
        "filePath": null,
        "expectedVersion": null,
        "reloadUserConfig": true,
    }))
}

fn verify_same_hooks_are_trusted(
    initial: &[ManagedHookListing],
    verified: &[ManagedHookListing],
) -> Result<(), CodexHookTrustError> {
    if initial.len() != verified.len() {
        return Err(protocol(
            "post-write hooks/list changed the managed hook count",
        ));
    }
    for (before, after) in initial.iter().zip(verified) {
        if before.event_name != after.event_name
            || before.key != after.key
            || before.current_hash != after.current_hash
            || after.trust_status != TrustStatus::Trusted
        {
            return Err(protocol(format!(
                "post-write hooks/list did not verify {}",
                before.event_name
            )));
        }
    }
    Ok(())
}

fn protocol(message: impl Into<String>) -> CodexHookTrustError {
    CodexHookTrustError::Protocol(message.into())
}

struct JsonlRpc {
    stdin: ChildStdin,
    stdout: ChildStdout,
    buffer: Vec<u8>,
    total_bytes: usize,
    messages: usize,
    next_id: u64,
}

impl JsonlRpc {
    fn new(stdin: ChildStdin, stdout: ChildStdout) -> Self {
        Self {
            stdin,
            stdout,
            buffer: Vec::new(),
            total_bytes: 0,
            messages: 0,
            next_id: 1,
        }
    }

    async fn notify(
        &mut self,
        method: &str,
        params: Option<Value>,
    ) -> Result<(), CodexHookTrustError> {
        let mut message = Map::new();
        message.insert("method".to_string(), Value::String(method.to_string()));
        if let Some(params) = params {
            message.insert("params".to_string(), params);
        }
        self.write_message(&Value::Object(message)).await
    }

    async fn request(&mut self, method: &str, params: Value) -> Result<Value, CodexHookTrustError> {
        let id = self.next_id;
        self.next_id = self.next_id.saturating_add(1);
        self.write_message(&json!({
            "id": id,
            "method": method,
            "params": params,
        }))
        .await?;

        loop {
            let message = self.read_message().await?;
            if message.get("id").and_then(Value::as_u64) != Some(id) {
                continue;
            }
            if let Some(error) = message.get("error") {
                let detail = error
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown error");
                let detail = detail.chars().take(400).collect::<String>();
                return Err(protocol(format!("{method} failed: {detail}")));
            }
            return message
                .get("result")
                .cloned()
                .ok_or_else(|| protocol(format!("{method} response omitted result")));
        }
    }

    async fn write_message(&mut self, message: &Value) -> Result<(), CodexHookTrustError> {
        let mut encoded = serde_json::to_vec(message)
            .map_err(|error| protocol(format!("could not encode request: {error}")))?;
        if encoded.len() > MAX_JSONL_LINE_BYTES {
            return Err(protocol("Codex hook trust request exceeded the line limit"));
        }
        encoded.push(b'\n');
        self.stdin
            .write_all(&encoded)
            .await
            .map_err(|error| protocol(format!("could not write request: {error}")))?;
        self.stdin
            .flush()
            .await
            .map_err(|error| protocol(format!("could not flush request: {error}")))
    }

    async fn read_message(&mut self) -> Result<Value, CodexHookTrustError> {
        loop {
            if let Some(newline) = self.buffer.iter().position(|byte| *byte == b'\n') {
                if newline > MAX_JSONL_LINE_BYTES {
                    return Err(protocol(
                        "Codex hook trust response exceeded the line limit",
                    ));
                }
                let line = self.buffer.drain(..=newline).collect::<Vec<_>>();
                let line = std::str::from_utf8(&line[..line.len().saturating_sub(1)])
                    .map_err(|_| protocol("Codex hook trust response was not UTF-8"))?
                    .trim();
                if line.is_empty() {
                    continue;
                }
                self.messages = self.messages.saturating_add(1);
                if self.messages > MAX_JSONL_MESSAGES {
                    return Err(protocol("Codex hook trust emitted too many messages"));
                }
                return serde_json::from_str(line)
                    .map_err(|error| protocol(format!("invalid JSONL response: {error}")));
            }
            if self.buffer.len() > MAX_JSONL_LINE_BYTES {
                return Err(protocol(
                    "Codex hook trust response exceeded the line limit",
                ));
            }
            let mut chunk = [0u8; 8192];
            let read = self
                .stdout
                .read(&mut chunk)
                .await
                .map_err(|error| protocol(format!("could not read response: {error}")))?;
            if read == 0 {
                return Err(protocol("Codex hook trust helper closed stdout early"));
            }
            self.total_bytes = self.total_bytes.saturating_add(read);
            if self.total_bytes > MAX_JSONL_TOTAL_BYTES {
                return Err(protocol(
                    "Codex hook trust response exceeded the total byte limit",
                ));
            }
            self.buffer.extend_from_slice(&chunk[..read]);
            if self.buffer.len() > MAX_JSONL_LINE_BYTES
                && !self.buffer[..=MAX_JSONL_LINE_BYTES].contains(&b'\n')
            {
                return Err(protocol(
                    "Codex hook trust response exceeded the line limit",
                ));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CWD: &str = "/workspace/repo";
    const HOOKS_PATH: &str = "/managed/codex/hooks.json";
    const COMMAND: &str = "'/managed/codex/studio-runtime/forward-hook.sh'";

    fn hook(event: &str, index: usize, trust_status: &str) -> Value {
        json!({
            "key": format!("{HOOKS_PATH}:{}:0:0", event.to_ascii_lowercase()),
            "eventName": event,
            "handlerType": "command",
            "matcher": null,
            "command": COMMAND,
            "timeoutSec": MANAGED_HOOK_TIMEOUT_SECS,
            "source": "user",
            "sourcePath": HOOKS_PATH,
            "pluginId": null,
            "displayOrder": index,
            "enabled": true,
            "isManaged": false,
            "currentHash": format!("sha256:{index}"),
            "trustStatus": trust_status,
            "additionalFutureField": { "ignored": true },
        })
    }

    fn result_with_managed_hooks() -> Value {
        let mut hooks = CODEX_HOOK_EVENTS
            .iter()
            .enumerate()
            .map(|(index, event)| {
                hook(
                    event.rpc_name,
                    index,
                    match index {
                        0 => "trusted",
                        1 => "modified",
                        _ => "untrusted",
                    },
                )
            })
            .collect::<Vec<_>>();
        hooks.extend([
            json!({
                "source": "project",
                "sourcePath": HOOKS_PATH,
                "key": "must-not-trust-project",
            }),
            json!({
                "source": "plugin",
                "sourcePath": HOOKS_PATH,
                "key": "must-not-trust-plugin",
            }),
            json!({
                "source": "user",
                "sourcePath": "/other/hooks.json",
                "key": "must-not-trust-other-user-hooks",
            }),
        ]);
        json!({ "data": [{ "cwd": CWD, "hooks": hooks, "warnings": [], "errors": [] }] })
    }

    fn parse_and_resolve(result: &Value) -> Vec<RawHookListing> {
        let mut listings = parse_hook_list_response(result, CWD).unwrap();
        for listing in &mut listings {
            if listing.source_path.as_deref() == Some(HOOKS_PATH) {
                listing.canonical_source_path = Some(PathBuf::from(HOOKS_PATH));
            } else if let Some(path) = listing.source_path.as_deref() {
                listing.canonical_source_path = Some(PathBuf::from(path));
            }
        }
        listings
    }

    #[test]
    fn parser_and_selection_trust_only_exact_managed_user_hooks() {
        let listings = parse_and_resolve(&result_with_managed_hooks());
        let selected = select_managed_hooks(&listings, Path::new(HOOKS_PATH), COMMAND).unwrap();
        assert_eq!(selected.len(), CODEX_HOOK_EVENTS.len());

        let params = build_trust_batch_params(&selected).unwrap();
        assert_eq!(params["filePath"], Value::Null);
        assert_eq!(params["expectedVersion"], Value::Null);
        assert_eq!(params["reloadUserConfig"], true);
        assert_eq!(params["edits"][0]["keyPath"], "hooks.state");
        assert_eq!(params["edits"][0]["mergeStrategy"], "upsert");
        let values = params["edits"][0]["value"].as_object().unwrap();
        assert_eq!(values.len(), CODEX_HOOK_EVENTS.len() - 1);
        assert!(!values.contains_key("must-not-trust-project"));
        assert!(!values.contains_key("must-not-trust-plugin"));
        assert!(!values.contains_key("must-not-trust-other-user-hooks"));
        assert!(!values.contains_key(&selected[0].key));
        for listing in &selected[1..] {
            assert_eq!(
                values[&listing.key],
                json!({ "trusted_hash": listing.current_hash })
            );
        }
    }

    #[test]
    fn selection_requires_every_exact_managed_hook_definition() {
        let mut missing = result_with_managed_hooks();
        missing["data"][0]["hooks"]
            .as_array_mut()
            .unwrap()
            .remove(0);
        let missing = parse_and_resolve(&missing);
        assert!(select_managed_hooks(&missing, Path::new(HOOKS_PATH), COMMAND).is_err());

        for (field, replacement) in [
            ("handlerType", json!("prompt")),
            ("matcher", json!("tool")),
            ("command", json!("other")),
            ("timeoutSec", json!(99)),
            ("pluginId", json!("external-plugin")),
            ("enabled", json!(false)),
            ("isManaged", json!(true)),
        ] {
            let mut changed = result_with_managed_hooks();
            changed["data"][0]["hooks"][0][field] = replacement;
            let changed = parse_and_resolve(&changed);
            assert!(
                select_managed_hooks(&changed, Path::new(HOOKS_PATH), COMMAND).is_err(),
                "field {field} must be exact"
            );
        }

        let mut missing_plugin = result_with_managed_hooks();
        missing_plugin["data"][0]["hooks"][0]
            .as_object_mut()
            .unwrap()
            .remove("pluginId");
        let missing_plugin = parse_and_resolve(&missing_plugin);
        assert!(select_managed_hooks(&missing_plugin, Path::new(HOOKS_PATH), COMMAND).is_err());
    }

    #[test]
    fn post_write_verification_requires_the_same_keys_hashes_and_trusted_status() {
        let initial = select_managed_hooks(
            &parse_and_resolve(&result_with_managed_hooks()),
            Path::new(HOOKS_PATH),
            COMMAND,
        )
        .unwrap();
        let mut verified = initial.clone();
        for listing in &mut verified {
            listing.trust_status = TrustStatus::Trusted;
        }
        assert!(build_trust_batch_params(&verified).is_none());
        verify_same_hooks_are_trusted(&initial, &verified).unwrap();

        let mut wrong_hash = verified.clone();
        wrong_hash[0].current_hash = "sha256:changed".to_string();
        assert!(verify_same_hooks_are_trusted(&initial, &wrong_hash).is_err());
        let mut wrong_key = verified.clone();
        wrong_key[0].key = "changed-key".to_string();
        assert!(verify_same_hooks_are_trusted(&initial, &wrong_key).is_err());
        let mut still_modified = verified;
        still_modified[1].trust_status = TrustStatus::Modified;
        assert!(verify_same_hooks_are_trusted(&initial, &still_modified).is_err());
    }

    #[tokio::test]
    async fn config_target_accepts_only_a_missing_or_regular_file() {
        let root = tempfile::tempdir().unwrap();
        let config = root.path().join("config.toml");
        validate_config_target(&config).await.unwrap();

        tokio::fs::write(&config, b"[hooks]\n").await.unwrap();
        validate_config_target(&config).await.unwrap();

        tokio::fs::remove_file(&config).await.unwrap();
        tokio::fs::create_dir(&config).await.unwrap();
        assert!(validate_config_target(&config).await.is_err());

        #[cfg(unix)]
        {
            tokio::fs::remove_dir(&config).await.unwrap();
            let target = root.path().join("outside.toml");
            tokio::fs::write(&target, b"[hooks]\n").await.unwrap();
            std::os::unix::fs::symlink(&target, &config).unwrap();
            assert!(validate_config_target(&config).await.is_err());
        }
    }

    #[tokio::test]
    async fn result_path_must_canonically_identify_the_expected_target() {
        let root = tempfile::tempdir().unwrap();
        let expected = root.path().join("config.toml");
        let other = root.path().join("other.toml");
        tokio::fs::write(&expected, b"").await.unwrap();
        tokio::fs::write(&other, b"").await.unwrap();
        let canonical_expected = tokio::fs::canonicalize(&expected).await.unwrap();
        let reported = json!({ "filePath": expected.to_str().unwrap() });

        require_canonical_result_path(
            &reported,
            "filePath",
            &canonical_expected,
            "config/batchWrite",
        )
        .await
        .unwrap();
        assert!(require_canonical_result_path(
            &json!({ "filePath": other.to_str().unwrap() }),
            "filePath",
            &canonical_expected,
            "config/batchWrite",
        )
        .await
        .is_err());
        assert!(require_canonical_result_path(
            &json!({}),
            "filePath",
            &canonical_expected,
            "config/batchWrite",
        )
        .await
        .is_err());
    }
}
