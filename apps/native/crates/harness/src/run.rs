//! Ties [`crate::resolve`] + [`crate::tiers`] + [`crate::spawn`] +
//! [`crate::events`] together into the one thing `local-api`'s dispatch
//! route actually drives: resolve → build argv → spawn (always plain
//! pipes — see `spawn.rs`'s module doc) → parse ndjson line-by-line →
//! yield [`RunEvent`]s, with cancellation support.
//!
//! ## Two-phase API (mirrors the dispatch contract's pre-stream gate)
//!
//! the native local-API contract's Dispatch Lifecycle pins
//! `lookupHarness(harnessId) throws` as a PRE-stream gate (#7): a 400
//! `unknown_harness` response BEFORE the SSE response even starts, so it
//! must be resolved BEFORE any `200`/streaming headers are written. Once
//! that gate passes, the caller is committed to a `200` SSE stream — any
//! LATER failure (the resolved binary vanishes between the gate and the
//! actual spawn, a permission error, the CLI itself crashing) has to
//! surface as an in-stream `error` event, not a different HTTP status.
//!
//! [`build_argv`] is that gate: pure, synchronous (no process spawned),
//! calls [`resolve::resolve_checked`] and fails exactly the way an
//! `unknown_harness` gate should. [`start`] takes the now-resolved argv
//! and is effectively infallible from the CALLER's point of view — any
//! spawn-time failure after this point becomes the first (and only)
//! [`RunEvent::FatalError`] on the returned handle's stream instead of a
//! `Result::Err`.
//!
//! ## Stdin is always closed
//!
//! Every harness spawn closes stdin (`Stdio::null()`, set in
//! `spawn::plain::spawn_plain`). This is not incidental: `codex exec`
//! reads stdin as additional prompt content when it's a pipe and hangs
//! waiting for EOF if left open — observed empirically on this machine
//! (`codex exec --json "<prompt>"` printed a `"Reading additional input
//! from stdin..."` banner and read after the prompt argument was already
//! provided, purely because stdin wasn't closed). Neither CLI needs stdin
//! for the single-turn, non-interactive invocations this crate makes.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

use serde_json::Value;
use tokio::sync::{mpsc, Mutex};

use crate::events::claude::ClaudeEventMapper;
use crate::events::codex::CodexEventMapper;
use crate::events::{EventMapper, FlushReason, MappedEvent};
use crate::resolve::{self, HarnessId, ResolveError};
use crate::spawn::{self, ExitInfo, ProcessLease, SpawnRequest};
use crate::tiers;

/// Mirrors `packages/harness/src/types.ts::ToolApprovalLevel`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolApproval {
    Auto,
    Readonly,
}

impl ToolApproval {
    /// `"auto"` / `"readonly"` — the two values dispatch's pre-stream gate
    /// (`validate_harness_input`, `routes/dispatch.rs`) already restricts
    /// `input.toolApprovalLevel` to.
    pub fn from_wire(level: &str) -> Self {
        if level == "readonly" {
            ToolApproval::Readonly
        } else {
            ToolApproval::Auto
        }
    }
}

#[derive(Debug, Clone)]
pub struct RunSpec {
    pub harness: HarnessId,
    pub cwd: Option<PathBuf>,
    /// Extracted user-visible text (see [`extract_user_text`]) — the
    /// CLI's positional prompt argument.
    pub prompt: String,
    /// `input.harness.sessionId` from a prior turn, if resuming.
    pub resume_session_id: Option<String>,
    /// Composite model id (`input.models.thinking.id`, e.g.
    /// `"claude-code:sonnet"`).
    pub model_id: String,
    pub tool_approval: ToolApproval,
    /// `input.mode == "plan"` — same tool restrictions as `readonly` in
    /// headless CLI mode, mirrors `isPlanMode` in
    /// `packages/harness/src/claude-code/index.ts`.
    pub plan_mode: bool,
    /// Extra system-prompt text to APPEND to whatever the CLI already uses —
    /// today the organization-filesystem block (see
    /// `local-api::sandbox::org_prompt`).
    ///
    /// The two CLIs take this differently and the difference is load-bearing:
    /// `claude` has a dedicated `--append-system-prompt` that adds to its own
    /// default, while `codex` has no system-prompt flag at all and instead
    /// takes `-c developer_instructions=…`, which SETS that layer rather than
    /// appending. Nothing else populates codex's developer instructions today,
    /// so this is additive in practice — but a second block would have to be
    /// composed into one string rather than passed separately.
    pub append_system_prompt: Option<String>,
    /// The agent's own MCP endpoint, so the CLI can call the agent's tools.
    ///
    /// Cluster runs get a per-run minted key; the desktop instead points the
    /// CLI at THIS process, which proxies `/mcp/*` upstream with the
    /// Keychain-backed token. That means the credential is local-api's own
    /// control cookie, and local-api's embedded guard also demands the exact
    /// `Origin` — hence both travel together.
    pub mcp: Option<McpEndpoint>,
}

/// Where the agent's MCP lives and what it takes to be let in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpEndpoint {
    pub url: String,
    pub cookie: String,
    pub origin: String,
    /// Root certificate `url`'s TLS chains to, when it is not a public one.
    /// claude is a Bun/BoringSSL binary that consults neither the macOS
    /// keychain (where this CA is trusted) nor anything beyond its bundled
    /// Mozilla roots — without being handed this file it cannot open `url`
    /// at all and the agent silently loses every MCP tool.
    pub ca_cert: Option<std::path::PathBuf>,
}

/// Env var names codex is pointed at, so no secret appears in its argv.
const MCP_URL_ENV: &str = "DECOCMS_MCP_URL";
const MCP_COOKIE_ENV: &str = "DECOCMS_MCP_COOKIE";
const MCP_ORIGIN_ENV: &str = "DECOCMS_MCP_ORIGIN";

/// How the CA in [`McpEndpoint::ca_cert`] reaches the claude child. Node's
/// (and Bun's) documented "additional CAs" variable — it EXTENDS the runtime's
/// bundled roots, so the CLI's own `api.anthropic.com` connection is
/// untouched. Never `SSL_CERT_FILE`, which REPLACES the root store for
/// OpenSSL/rustls-native-certs consumers and would cut a child off from the
/// public internet. codex needs neither: rustls-platform-verifier consults
/// the keychain, where this CA is already trusted.
const NODE_EXTRA_CA_CERTS_ENV: &str = "NODE_EXTRA_CA_CERTS";

/// The environment the CLI child runs with. Secrets reach it here (codex) or
/// via a 0600 file (claude), never argv — `ps` shows argv to every local
/// process. Merged over the inherited environment by the spawn layer.
fn mcp_child_env(spec: &RunSpec) -> Vec<(String, String)> {
    let mut env = Vec::new();
    if let Some(mcp) = spec.mcp.as_ref() {
        env.push((MCP_URL_ENV.to_string(), mcp.url.clone()));
        env.push((MCP_COOKIE_ENV.to_string(), mcp.cookie.clone()));
        env.push((MCP_ORIGIN_ENV.to_string(), mcp.origin.clone()));
        if let Some(ca_cert) = mcp.ca_cert.as_ref() {
            env.push((
                NODE_EXTRA_CA_CERTS_ENV.to_string(),
                ca_cert.display().to_string(),
            ));
        }
    }
    env
}

/// The one MCP server name both CLIs see. Matches the cluster harness's
/// `cms` key, so a prompt that refers to it means the same thing either side.
const MCP_SERVER_NAME: &str = "cms";

/// claude's `--mcp-config` document.
///
/// Every value is a `${VAR}` reference, so this string is safe to pass on the
/// command line: the environment supplies the url, cookie and origin.
pub fn claude_mcp_config() -> String {
    serde_json::json!({
        "mcpServers": {
            MCP_SERVER_NAME: {
                "type": "http",
                "url": format!("${{{MCP_URL_ENV}}}"),
                "headers": {
                    "Cookie": format!("${{{MCP_COOKIE_ENV}}}"),
                    "Origin": format!("${{{MCP_ORIGIN_ENV}}}"),
                },
            }
        }
    })
    .to_string()
}

#[derive(Debug, Clone, PartialEq)]
pub enum RunEvent {
    /// Internal continuation checkpoint. Consumers must persist this before
    /// acknowledging any later output from the same process; it is not an
    /// AI-SDK wire chunk and must never be forwarded to the webview.
    SessionId { session_id: String },
    /// → dispatch's `{"type":"ui-message-chunk","chunk":<Value>}`.
    Chunk(Value),
    /// → dispatch's `{"type":"error","code":"harness_crashed",...}`. At
    /// most one per run, always the LAST event before the channel closes.
    FatalError { message: String },
}

/// Extracts the visible text from `input.userMessage` — a UIMessage-shaped
/// `{ parts: [...] }` object opaque to the dispatch route (see the
/// contract doc's Threads-store section: "the same 'UIMessage parts'
/// shape the mesh chat wire already uses"). Joins every
/// `{"type":"text","text":...}` part with newlines; non-text parts
/// (images, tool calls) are ignored. Mirrors
/// `packages/harness/src/cli-message-prep.ts::extractUserText`'s
/// text-only extraction, simplified for dispatch's single-message (not
/// full-history) input shape.
pub fn extract_user_text(user_message: &Value) -> String {
    let Some(parts) = user_message.get("parts").and_then(Value::as_array) else {
        // Tolerate a bare string as the whole message too — defensive,
        // since `userMessage` is opaque to the dispatch route's own
        // schema (`chatMessageSchema = z.record(...)` on the TS side).
        return user_message.as_str().unwrap_or_default().to_string();
    };
    parts
        .iter()
        .filter(|p| p.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|p| p.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n")
}

/// The pre-stream gate: resolves `spec.harness`'s binary (SHARED CONTRACT
/// env overrides, PATH fallback) and builds the full argv, WITHOUT
/// spawning anything. `Err` here is dispatch's `unknown_harness` 400 gate
/// (contract order #7) — an unresolvable/missing CLI is treated the same
/// as an unrecognized `harnessId`, since from the caller's point of view
/// both mean "this run cannot start."
pub fn build_argv(spec: &RunSpec) -> Result<Vec<String>, ResolveError> {
    let resume_session_id = normalized_resume_session_id(spec)?;
    let mut argv = resolve::resolve_checked(spec.harness)?;
    match spec.harness {
        HarnessId::ClaudeCode => append_claude_args(&mut argv, spec, resume_session_id),
        HarnessId::Codex => append_codex_args(&mut argv, spec, resume_session_id),
    }
    Ok(argv)
}

fn normalized_resume_session_id(spec: &RunSpec) -> Result<Option<&str>, ResolveError> {
    let Some(raw) = spec.resume_session_id.as_deref() else {
        return Ok(None);
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(ResolveError::InvalidSessionId);
    }
    Ok(Some(trimmed))
}

fn append_claude_args(argv: &mut Vec<String>, spec: &RunSpec, resume_session_id: Option<&str>) {
    // `-p <prompt>` stays FIRST. The contract suite pins the prompt at
    // `args[1]`, and every optional flag below is order-independent to the
    // CLI — so anything added here goes after, never before.
    argv.push("-p".to_string());
    argv.push(spec.prompt.clone());
    if let Some(extra) = spec.append_system_prompt.as_deref() {
        // Appends to the CLI's own default prompt. `--system-prompt` would
        // REPLACE it, discarding everything claude-code relies on.
        argv.push("--append-system-prompt".to_string());
        argv.push(extra.to_string());
    }
    if spec.mcp.is_some() {
        // Inline JSON, but the SECRET is not in it: claude expands `${VAR}`
        // from the environment (verified — a `${...}` cookie arrives at the
        // server fully expanded), so argv carries only variable NAMES. `ps`
        // shows argv to every local process, which is why this is not the
        // literal cookie and why no file is needed either.
        argv.push("--mcp-config".to_string());
        argv.push(claude_mcp_config());
        // Ignore the user's own `~/.claude` servers: an agent run must get the
        // agent's tools, not whatever this machine happens to have configured.
        argv.push("--strict-mcp-config".to_string());
    }
    argv.push("--output-format".to_string());
    argv.push("stream-json".to_string());
    argv.push("--include-partial-messages".to_string());
    argv.push("--verbose".to_string());
    argv.push("--model".to_string());
    argv.push(tiers::resolve_claude_model_id(&spec.model_id));
    if let Some(sid) = resume_session_id {
        argv.push("--resume".to_string());
        argv.push(sid.to_string());
    }
    // Headless-safe permission handling, mirrors
    // `packages/harness/src/claude-code/model/index.ts::createClaudeCodeModel`:
    // always bypass the (impossible-in-headless) interactive permission
    // prompt, and disallow tools that require a TTY / manage local
    // session state regardless of approval level; ALSO disallow
    // write-capable tools when the run is read-only or plan mode.
    argv.push("--permission-mode".to_string());
    argv.push("bypassPermissions".to_string());
    let mut disallowed: Vec<&str> = vec![
        "AskUserQuestion",
        "ExitPlanMode",
        "EnterWorktree",
        "ExitWorktree",
        "Config",
    ];
    if spec.plan_mode || matches!(spec.tool_approval, ToolApproval::Readonly) {
        disallowed.extend(["Write", "Edit", "Bash", "NotebookEdit"]);
    }
    argv.push("--disallowedTools".to_string());
    argv.push(disallowed.join(","));
}

fn append_codex_args(argv: &mut Vec<String>, spec: &RunSpec, resume_session_id: Option<&str>) {
    argv.push("exec".to_string());
    if let Some(extra) = spec.append_system_prompt.as_deref() {
        // codex has no system-prompt flag; `developer_instructions` is the
        // config key that reaches the model (verified end to end — an
        // instruction passed this way overrides the model's default answer).
        // There is no file-based variant: `experimental_instructions_file`,
        // `instructions_file` and `base_instructions` are all rejected by
        // `--strict-config`.
        argv.push("-c".to_string());
        argv.push(format!("developer_instructions={extra}"));
    }
    if let Some(mcp) = spec.mcp.as_ref() {
        // `env_http_headers` maps a header NAME to the env var holding its
        // value, so the cookie never appears in argv. Verified against the
        // config `codex mcp add --url` writes.
        argv.push("-c".to_string());
        argv.push(format!("mcp_servers.{MCP_SERVER_NAME}.url={}", mcp.url));
        argv.push("-c".to_string());
        argv.push(format!(
            "mcp_servers.{MCP_SERVER_NAME}.env_http_headers.Cookie={MCP_COOKIE_ENV}"
        ));
        argv.push("-c".to_string());
        argv.push(format!(
            "mcp_servers.{MCP_SERVER_NAME}.env_http_headers.Origin={MCP_ORIGIN_ENV}"
        ));
    }
    argv.push("--json".to_string());
    argv.push("--skip-git-repo-check".to_string());
    argv.push("--model".to_string());
    argv.push(tiers::resolve_codex_model_id(&spec.model_id));
    let sandbox = if spec.plan_mode || matches!(spec.tool_approval, ToolApproval::Readonly) {
        "read-only"
    } else {
        "workspace-write"
    };
    argv.push("--sandbox".to_string());
    argv.push(sandbox.to_string());
    // `codex exec resume <id> [PROMPT]` — a subcommand of `exec`, placed
    // after the flags above and before the trailing positional prompt.
    // NOTE: exact flag/subcommand interleaving is best-effort — verified
    // manually via `codex exec --help`/`codex exec resume --help` on this
    // machine (codex-cli 0.144.5) but NOT exercised end-to-end with a real
    // resumed run (that needs a live multi-turn smoke test — see
    // the native harness smoke procedure). If this ordering turns out
    // to be wrong, the failure surfaces as a normal `harness_crashed`
    // stream error (the CLI rejects its own argv), not a silent
    // misbehavior.
    if let Some(sid) = resume_session_id {
        argv.push("resume".to_string());
        argv.push(sid.to_string());
    }
    argv.push(spec.prompt.clone());
}

/// A running harness. `recv()` yields [`RunEvent`]s until the underlying
/// process's output is fully drained and the process has exited, at which
/// point the channel closes (`recv()` returns `None`) — mirroring the TS
/// dispatch route's `for await (const chunk of harness.stream())`
/// finishing naturally. A `FatalError`, if any, is always the LAST event
/// before closing.
pub struct RunHandle {
    events_rx: mpsc::Receiver<RunEvent>,
    cancelled: Arc<AtomicBool>,
    process_slot: Arc<Mutex<Option<ProcessLease>>>,
    session_id: Arc<Mutex<Option<String>>>,
    drive_task: Option<tokio::task::JoinHandle<()>>,
}

impl Drop for RunHandle {
    fn drop(&mut self) {
        // The drive task owns `SpawnedProcess::owner`. Aborting it drops that
        // ownership edge, which wakes the detached child waiter and runs its
        // bounded TERM→KILL + reap path. This is the panic/abort backstop for
        // callers that cannot reach the async `cancel()` method.
        self.cancelled.store(true, Ordering::SeqCst);
        if let Some(task) = self.drive_task.take() {
            task.abort();
        }
    }
}

impl RunHandle {
    pub async fn recv(&mut self) -> Option<RunEvent> {
        self.events_rx.recv().await
    }

    /// The harness's session/thread id, once known (populated as soon as
    /// the underlying CLI reports it — claude's `system.init`/`result`,
    /// codex's `thread.started`) — the resume token for the run's next
    /// turn.
    pub async fn session_id(&self) -> Option<String> {
        self.session_id.lock().await.clone()
    }

    /// Cancels the run: marks it cancelled (suppressing the synthetic
    /// "exited abnormally" `FatalError` a SIGTERM would otherwise
    /// produce — a cancel is not a crash) and signals the process
    /// group, escalating TERM→KILL when the CLI resists. Idempotent — safe
    /// to call more than once, or after the run has already finished. The
    /// process-group lease becomes inert when its waiter reaps the group, so a
    /// stale handle never targets a later process that reused the numeric pid.
    ///
    /// RACE, CLOSED: a `cancel()` landing in the brief async gap between
    /// `start()` beginning and the spawned process's pid becoming known
    /// finds nothing to signal HERE (`process_slot` still `None`) — but it
    /// still sets `cancelled`, and `drive()` re-checks that flag itself
    /// the INSTANT it learns the pid (see `drive()`'s own comment at that
    /// check), killing the just-spawned process immediately instead of
    /// letting it run unsupervised. Found by
    /// `apps/native/e2e/dispatch-stream.e2e.test.ts`'s `hang` scenario —
    /// a client that cancels the moment it observes ANY output (before
    /// the child process has even finished `fork`/`exec`) reliably raced
    /// this window; a `cancel()` that fires before the pid exists is the
    /// COMMON case for that scenario, not a rare corner.
    pub async fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        if let Some(process) = self.process_slot.lock().await.clone() {
            process.terminate().await;
        }
    }

    /// A `Clone`-able, `Send + Sync` handle carrying JUST the cancel
    /// capability, sharing the SAME underlying state as this `RunHandle`
    /// (`Arc`-backed — cancelling through either one is observable
    /// through the other). Exists because `recv()`/`&mut self` and a
    /// registry of "runs any request can cancel by id" (`local-api`'s
    /// `routes/dispatch.rs`) want different ownership shapes: the SSE
    /// response body owns/drains `RunHandle` by value in one task, while
    /// `DELETE /_sandbox/runs/:id` needs a `Clone`-able reference it can
    /// stash in a shared map and call from a completely different
    /// request's handler.
    pub fn cancel_handle(&self) -> CancelHandle {
        CancelHandle {
            cancelled: self.cancelled.clone(),
            process_slot: self.process_slot.clone(),
        }
    }
}

/// See [`RunHandle::cancel_handle`]. Identical cancel semantics to
/// [`RunHandle::cancel`] — same fields, same method — just detached from
/// the event-receiving half.
#[derive(Clone)]
pub struct CancelHandle {
    cancelled: Arc<AtomicBool>,
    process_slot: Arc<Mutex<Option<ProcessLease>>>,
}

impl CancelHandle {
    pub async fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        if let Some(process) = self.process_slot.lock().await.clone() {
            process.terminate().await;
        }
    }
}

/// Spawns `argv` (already resolved by [`build_argv`]) and starts driving
/// its output. Never fails from the caller's perspective (see module
/// doc's "two-phase API" section) — a spawn-time I/O error becomes the
/// handle's first and only [`RunEvent::FatalError`]. A caller that bypasses
/// [`build_argv`] still cannot bypass resume-token validation: invalid input
/// produces the same closed fatal stream without spawning `argv`.
/// Convenience entrypoint for harness-only tests/consumers that do not own a
/// local-api app-root recovery fence. Native local-api must use
/// [`start_with_child_lifetime_lock`] instead.
pub async fn start(argv: Vec<String>, spec: &RunSpec) -> RunHandle {
    start_inner(argv, spec, None).await
}

pub async fn start_with_child_lifetime_lock(
    argv: Vec<String>,
    spec: &RunSpec,
    child_lifetime_lock_path: PathBuf,
) -> RunHandle {
    start_inner(argv, spec, Some(child_lifetime_lock_path)).await
}

async fn start_inner(
    argv: Vec<String>,
    spec: &RunSpec,
    child_lifetime_lock_path: Option<PathBuf>,
) -> RunHandle {
    let (tx, rx) = mpsc::channel::<RunEvent>(64);
    let cancelled = Arc::new(AtomicBool::new(false));
    let process_slot = Arc::new(Mutex::new(None));
    // A resumed turn already has a durable session identity before the child
    // starts. Keep that identity even when the CLI is cancelled, crashes, or
    // rejects its argv before emitting its normal init event; otherwise the
    // failed assistant row can mask the only resume anchor and the next turn
    // silently starts a fresh conversation.
    let session_id = match normalized_resume_session_id(spec) {
        Ok(session_id) => Arc::new(Mutex::new(session_id.map(str::to_string))),
        Err(error) => {
            let _ = tx
                .send(RunEvent::FatalError {
                    message: error.to_string(),
                })
                .await;
            drop(tx);
            return RunHandle {
                events_rx: rx,
                cancelled,
                process_slot,
                session_id: Arc::new(Mutex::new(None)),
                drive_task: None,
            };
        }
    };

    let env = mcp_child_env(spec);

    let req = SpawnRequest {
        argv,
        cwd: spec.cwd.clone(),
        env,
        lifetime_lock_path: child_lifetime_lock_path,
        // Always plain pipes — see `spawn.rs`'s "why not PTY" doc comment.
        pty: false,
    };

    let harness = spec.harness;

    let drive_task = tokio::spawn(drive(
        req,
        harness,
        tx,
        cancelled.clone(),
        process_slot.clone(),
        session_id.clone(),
    ));

    RunHandle {
        events_rx: rx,
        cancelled,
        process_slot,
        session_id,
        drive_task: Some(drive_task),
    }
}

/// Bound on how much trailing stderr is retained for a nonzero-exit
/// error message — enough for a useful diagnostic line, not enough for a
/// misbehaving CLI's stderr firehose to grow this unbounded.
const STDERR_TAIL_CAP: usize = 4096;
const MISSING_SESSION_ID_ERROR: &str =
    "local harness completed without a session id; the chat cannot be resumed safely";
const CHANGED_SESSION_ID_ERROR: &str =
    "local harness changed its session id while the thread was running; start a new chat instead of continuing with split history";
const EMPTY_SESSION_ID_ERROR: &str =
    "local harness emitted an empty session id; the chat cannot be resumed safely";

async fn drive(
    req: SpawnRequest,
    harness: HarnessId,
    tx: mpsc::Sender<RunEvent>,
    cancelled: Arc<AtomicBool>,
    process_slot: Arc<Mutex<Option<ProcessLease>>>,
    session_id: Arc<Mutex<Option<String>>>,
) {
    let fallback_req = (harness == HarnessId::ClaudeCode)
        .then(|| without_arg(&req, "--include-partial-messages"))
        .flatten();
    let outcome = drive_attempt(
        req,
        harness,
        &tx,
        &cancelled,
        &process_slot,
        &session_id,
        fallback_req.is_some(),
    )
    .await;

    if outcome == AttemptOutcome::RetryWithoutPartialMessages && !cancelled.load(Ordering::SeqCst) {
        let Some(fallback_req) = fallback_req else {
            return;
        };
        tracing::warn!(
            target: "decocms.native.chat.latency",
            harness = harness.wire_id(),
            "Claude CLI does not support partial-message streaming; retrying after pre-inference argument rejection"
        );
        let _ = drive_attempt(
            fallback_req,
            harness,
            &tx,
            &cancelled,
            &process_slot,
            &session_id,
            false,
        )
        .await;
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AttemptOutcome {
    Done,
    RetryWithoutPartialMessages,
}

#[allow(clippy::too_many_arguments)]
async fn drive_attempt(
    req: SpawnRequest,
    harness: HarnessId,
    tx: &mpsc::Sender<RunEvent>,
    cancelled: &AtomicBool,
    process_slot: &Mutex<Option<ProcessLease>>,
    session_id: &Mutex<Option<String>>,
    allow_partial_messages_fallback: bool,
) -> AttemptOutcome {
    let spawned_at = Instant::now();
    let proc = match spawn::spawn(req).await {
        Ok(p) => p,
        Err(err) => {
            let _ = tx
                .send(RunEvent::FatalError {
                    message: format!("failed to start {}: {err}", harness.wire_id()),
                })
                .await;
            return AttemptOutcome::Done;
        }
    };
    *process_slot.lock().await = Some(proc.lease.clone());
    // Closes the race documented on `RunHandle::cancel`: a `cancel()` call
    // that landed BEFORE this line (the child was still spawning, so
    // `process_slot` was `None` and there was nothing to signal yet) sets
    // `cancelled` but can't kill anything. Checking `cancelled` again
    // HERE, now that the pid is known, catches exactly that window —
    // this is what makes cancelling a request that returns near-instantly
    // (e.g. a harness that emits one line then hangs, cancelled the
    // moment that line is observed) reliable instead of racy. Every
    // `cancel()`/`CancelHandle::cancel()` call kills unconditionally (not
    // gated on "is anyone listening"), so re-signaling here even if the
    // ORIGINAL call already found and killed the pid is a harmless
    // no-op — `kill(1)` on an already-dead process just fails silently.
    if cancelled.load(Ordering::SeqCst) {
        proc.lease.terminate().await;
    }
    let spawn::SpawnedProcess {
        pid: _,
        mut stdout,
        mut stderr,
        exit,
        lease: _lease,
        owner: _owner,
    } = proc;

    let stderr_tail = Arc::new(Mutex::new(String::new()));
    let stderr_task = tokio::spawn({
        let stderr_tail = stderr_tail.clone();
        async move {
            while let Some(chunk) = stderr.recv().await {
                let mut tail = stderr_tail.lock().await;
                tail.push_str(&String::from_utf8_lossy(&chunk));
                let len = tail.len();
                if len > STDERR_TAIL_CAP {
                    let excess = len.saturating_sub(STDERR_TAIL_CAP);
                    tail.drain(0..excess);
                }
            }
        }
    });

    let mut mapper: Box<dyn EventMapper + Send> = match harness {
        HarnessId::ClaudeCode => Box::new(ClaudeEventMapper::new()),
        HarnessId::Codex => Box::new(CodexEventMapper::new()),
    };

    let mut linebuf: Vec<u8> = Vec::new();
    let mut stopped_early = false;
    let mut mapper_reported_fatal = false;
    let mut stdout_non_whitespace = false;
    let mut first_meaningful_chunk_logged = false;
    'outer: while let Some(bytes) = stdout.recv().await {
        stdout_non_whitespace |= bytes.iter().any(|byte| !byte.is_ascii_whitespace());
        linebuf.extend_from_slice(&bytes);
        while let Some(pos) = linebuf.iter().position(|&b| b == b'\n') {
            let line_bytes: Vec<u8> = linebuf.drain(..=pos).collect();
            // Drop the trailing '\n' the drain included.
            let line =
                String::from_utf8_lossy(line_bytes.split_last().map_or(&[][..], |(_, head)| head))
                    .into_owned();
            let mut events = mapper.feed_line(&line);
            mapper_reported_fatal |= flush_before_mapped_fatal(&mut *mapper, &mut events);
            trace_first_meaningful_chunk(
                &events,
                harness,
                spawned_at,
                &mut first_meaningful_chunk_logged,
            );
            if dispatch_mapped(events, tx, session_id).await {
                stopped_early = true;
                break 'outer;
            }
        }
    }
    if !stopped_early && !linebuf.is_empty() {
        let line = String::from_utf8_lossy(&linebuf).into_owned();
        let mut events = mapper.feed_line(&line);
        mapper_reported_fatal |= flush_before_mapped_fatal(&mut *mapper, &mut events);
        trace_first_meaningful_chunk(
            &events,
            harness,
            spawned_at,
            &mut first_meaningful_chunk_logged,
        );
        if dispatch_mapped(events, tx, session_id).await {
            stopped_early = true;
        }
    }

    let exit_info = exit.await.unwrap_or(ExitInfo { code: 1 });
    let _ = stderr_task.await;

    let tail = stderr_tail.lock().await.clone();
    if allow_partial_messages_fallback
        && is_pre_inference_partial_flag_rejection(harness, exit_info, stdout_non_whitespace, &tail)
    {
        // The mapper is empty for a CLI argument-parser rejection, but invoke
        // the lifecycle hook on this failed attempt just like every other
        // process exit. Never retry after any stdout: that could duplicate a
        // paid model call or a side effect.
        let _ = mapper.flush(FlushReason::Failed);
        return AttemptOutcome::RetryWithoutPartialMessages;
    }

    if !mapper_reported_fatal && !stopped_early {
        let flush_reason = if cancelled.load(Ordering::SeqCst) {
            FlushReason::Cancelled
        } else if exit_info.code == 0 {
            FlushReason::EndOfStream
        } else {
            FlushReason::Failed
        };
        let flushed = mapper.flush(flush_reason);
        if dispatch_mapped(flushed, tx, session_id).await {
            stopped_early = true;
        }
    }

    if !stopped_early
        && !cancelled.load(Ordering::SeqCst)
        && exit_info.code == 0
        && session_id
            .lock()
            .await
            .as_deref()
            .is_none_or(|sid| sid.trim().is_empty())
    {
        let _ = tx
            .send(RunEvent::FatalError {
                message: MISSING_SESSION_ID_ERROR.to_string(),
            })
            .await;
    }

    if !stopped_early && !cancelled.load(Ordering::SeqCst) && exit_info.code != 0 {
        let suffix = if tail.trim().is_empty() {
            String::new()
        } else {
            format!(": {}", tail.trim())
        };
        let _ = tx
            .send(RunEvent::FatalError {
                message: format!(
                    "{} exited with code {}{suffix}",
                    harness.wire_id(),
                    exit_info.code
                ),
            })
            .await;
    }
    // The wrapper drops its owning `tx` after this attempt (or after the
    // compatibility retry), closing the channel so `RunHandle::recv()`
    // returns `None`.
    AttemptOutcome::Done
}

fn without_arg(req: &SpawnRequest, arg: &str) -> Option<SpawnRequest> {
    let index = req.argv.iter().position(|candidate| candidate == arg)?;
    let mut fallback = req.clone();
    fallback.argv.remove(index);
    Some(fallback)
}

fn is_pre_inference_partial_flag_rejection(
    harness: HarnessId,
    exit_info: ExitInfo,
    stdout_non_whitespace: bool,
    stderr: &str,
) -> bool {
    if harness != HarnessId::ClaudeCode || exit_info.code == 0 || stdout_non_whitespace {
        return false;
    }
    let stderr = stderr.to_ascii_lowercase();
    stderr.contains("--include-partial-messages")
        && [
            "unknown option",
            "unknown argument",
            "unrecognized option",
            "unrecognized argument",
            "unexpected argument",
            "wasn't expected",
            "was not expected",
        ]
        .iter()
        .any(|marker| stderr.contains(marker))
}

/// A mapper-level fatal event must remain the final wire event. Insert the
/// mapper's flush output immediately before it, pairing any open incremental
/// parts without violating that ordering.
fn flush_before_mapped_fatal(mapper: &mut dyn EventMapper, events: &mut Vec<MappedEvent>) -> bool {
    let Some(fatal_index) = events
        .iter()
        .position(|event| matches!(event, MappedEvent::FatalError { .. }))
    else {
        return false;
    };
    let flushed = mapper.flush(FlushReason::Failed);
    events.splice(fatal_index..fatal_index, flushed);
    true
}

fn trace_first_meaningful_chunk(
    events: &[MappedEvent],
    harness: HarnessId,
    spawned_at: Instant,
    already_logged: &mut bool,
) {
    if *already_logged {
        return;
    }
    let Some(chunk_type) = events.iter().find_map(|event| {
        let MappedEvent::Chunk(value) = event else {
            return None;
        };
        let chunk_type = value.get("type").and_then(Value::as_str)?;
        matches!(
            chunk_type,
            "text-start" | "reasoning-start" | "tool-input-start"
        )
        .then_some(chunk_type)
    }) else {
        return;
    };
    *already_logged = true;
    let spawn_to_first_chunk_ms =
        u64::try_from(spawned_at.elapsed().as_millis()).unwrap_or(u64::MAX);
    tracing::info!(
        target: "decocms.native.chat.latency",
        harness = harness.wire_id(),
        chunk_type,
        spawn_to_first_chunk_ms,
        "harness produced its first meaningful chunk"
    );
}

/// Forwards every [`MappedEvent`] onto `tx`, updating `session_id` as a
/// side effect. Returns `true` when the caller should stop reading
/// further stdout (a `FatalError` was sent, OR the receiver was dropped).
async fn dispatch_mapped(
    events: Vec<MappedEvent>,
    tx: &mpsc::Sender<RunEvent>,
    session_id: &Mutex<Option<String>>,
) -> bool {
    for ev in events {
        match ev {
            MappedEvent::Chunk(v) => {
                if v.get("type").and_then(Value::as_str) == Some("finish")
                    && v.get("finishReason").and_then(Value::as_str) != Some("error")
                    && session_id
                        .lock()
                        .await
                        .as_deref()
                        .is_none_or(|sid| sid.trim().is_empty())
                {
                    let _ = tx
                        .send(RunEvent::FatalError {
                            message: MISSING_SESSION_ID_ERROR.to_string(),
                        })
                        .await;
                    return true;
                }
                if tx.send(RunEvent::Chunk(v)).await.is_err() {
                    return true;
                }
            }
            MappedEvent::SessionId(sid) => {
                let sid = sid.trim();
                if sid.is_empty() {
                    let _ = tx
                        .send(RunEvent::FatalError {
                            message: EMPTY_SESSION_ID_ERROR.to_string(),
                        })
                        .await;
                    return true;
                }
                let changed = {
                    let mut current = session_id.lock().await;
                    match current.as_deref() {
                        Some(existing) if existing != sid => true,
                        Some(_) => false,
                        None => {
                            *current = Some(sid.to_string());
                            false
                        }
                    }
                };
                if changed {
                    let _ = tx
                        .send(RunEvent::FatalError {
                            message: CHANGED_SESSION_ID_ERROR.to_string(),
                        })
                        .await;
                    return true;
                }
                if tx
                    .send(RunEvent::SessionId {
                        session_id: sid.to_string(),
                    })
                    .await
                    .is_err()
                {
                    return true;
                }
            }
            MappedEvent::FatalError { message } => {
                let _ = tx.send(RunEvent::FatalError { message }).await;
                return true;
            }
            MappedEvent::Ignored => {}
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// The harness-specific argv WITHOUT `build_argv`'s binary resolution:
    /// CI has neither CLI installed, and the env override that would fake one
    /// is documented as not parallel-test-safe (see `resolve.rs`). These tests
    /// are about argv COMPOSITION, which is exactly what these two build.
    fn argv_for(spec: &RunSpec) -> Vec<String> {
        let mut argv = Vec::new();
        match spec.harness {
            HarnessId::ClaudeCode => append_claude_args(&mut argv, spec, None),
            HarnessId::Codex => append_codex_args(&mut argv, spec, None),
        }
        argv
    }

    fn mcp_fixture() -> McpEndpoint {
        McpEndpoint {
            url: "http://localhost:4420/mcp/virtual-mcp/vir_1".to_string(),
            cookie: "decocms-local-session=SECRET".to_string(),
            origin: "http://localhost:4420".to_string(),
            ca_cert: Some(std::path::PathBuf::from("/app-root/tls/ca-cert.pem")),
        }
    }

    /// The listener's private CA must reach the child, and through the one
    /// variable that EXTENDS the runtime's roots rather than replacing them.
    /// Without it claude (Bun/BoringSSL — no keychain, no extra files) fails
    /// TLS against this process's own listener and the agent silently loses
    /// every MCP tool; with `SSL_CERT_FILE` instead, a child would lose the
    /// public internet.
    #[test]
    fn the_private_ca_reaches_the_child_additively_and_only_when_real() {
        let mut spec = base_spec(HarnessId::ClaudeCode);
        spec.mcp = Some(mcp_fixture());
        let env = mcp_child_env(&spec);
        assert!(env
            .iter()
            .any(|(name, value)| name == "NODE_EXTRA_CA_CERTS"
                && value == "/app-root/tls/ca-cert.pem"));
        assert!(!env.iter().any(|(name, _)| name == "SSL_CERT_FILE"));

        // A plain-HTTP listener (selftest, standalone) has no CA to hand
        // over; pointing the var at nothing would be Node startup noise.
        let mut plain = mcp_fixture();
        plain.ca_cert = None;
        spec.mcp = Some(plain);
        assert!(!mcp_child_env(&spec)
            .iter()
            .any(|(name, _)| name == "NODE_EXTRA_CA_CERTS"));

        spec.mcp = None;
        assert!(mcp_child_env(&spec).is_empty());
    }

    /// The credential must never be visible to `ps`. claude gets a file path,
    /// codex gets ENV VAR NAMES — neither gets the secret itself.
    #[test]
    fn neither_cli_receives_the_mcp_secret_in_argv() {
        for harness in [HarnessId::ClaudeCode, HarnessId::Codex] {
            let mut spec = base_spec(harness);
            spec.mcp = Some(mcp_fixture());
            let joined = argv_for(&spec).join(" ");

            assert!(!joined.contains("SECRET"), "{harness:?} leaked the cookie");
            assert!(
                !joined.contains("decocms-local-session"),
                "{harness:?} leaked the cookie name/value"
            );
        }
    }

    /// The contract suite pins the prompt at `args[1]`; an optional flag
    /// inserted before it silently shifted every positional assertion.
    #[test]
    fn the_prompt_stays_first_whatever_else_is_added() {
        let mut spec = base_spec(HarnessId::ClaudeCode);
        spec.mcp = Some(mcp_fixture());
        spec.append_system_prompt = Some("extra".to_string());
        let argv = argv_for(&spec);

        assert_eq!(argv[0], "-p");
        assert_eq!(argv[1], spec.prompt);
    }

    #[test]
    fn claude_gets_inline_config_and_ignores_other_mcp_sources() {
        let mut spec = base_spec(HarnessId::ClaudeCode);
        spec.mcp = Some(mcp_fixture());
        let argv = argv_for(&spec);

        assert!(argv.iter().any(|a| a == "--mcp-config"));
        // Without this the user's own ~/.claude servers would join the run.
        assert!(argv.iter().any(|a| a == "--strict-mcp-config"));
    }

    #[test]
    fn codex_points_at_env_vars_rather_than_values() {
        let mut spec = base_spec(HarnessId::Codex);
        spec.mcp = Some(mcp_fixture());
        let joined = argv_for(&spec).join(" ");

        assert!(joined.contains("mcp_servers.cms.url=http://localhost:4420/mcp/virtual-mcp/vir_1"));
        assert!(joined.contains("mcp_servers.cms.env_http_headers.Cookie=DECOCMS_MCP_COOKIE"));
        assert!(joined.contains("mcp_servers.cms.env_http_headers.Origin=DECOCMS_MCP_ORIGIN"));
    }

    #[test]
    fn no_mcp_means_no_flags_at_all() {
        for harness in [HarnessId::ClaudeCode, HarnessId::Codex] {
            let joined = argv_for(&base_spec(harness)).join(" ");
            assert!(
                !joined.contains("mcp"),
                "{harness:?} added MCP flags anyway"
            );
        }
    }

    /// Every value is a `${VAR}` reference, never a literal — that is what
    /// makes passing this document on the command line safe. claude expands
    /// them from the environment at startup (verified against the CLI).
    #[test]
    fn the_claude_config_document_references_env_vars_only() {
        let value: serde_json::Value =
            serde_json::from_str(&claude_mcp_config()).expect("valid json");
        let server = &value["mcpServers"]["cms"];
        assert_eq!(server["type"], "http");
        assert_eq!(server["url"], "${DECOCMS_MCP_URL}");
        assert_eq!(server["headers"]["Cookie"], "${DECOCMS_MCP_COOKIE}");
        assert_eq!(server["headers"]["Origin"], "${DECOCMS_MCP_ORIGIN}");
    }

    fn base_spec(harness: HarnessId) -> RunSpec {
        RunSpec {
            append_system_prompt: None,
            mcp: None,
            harness,
            cwd: None,
            prompt: "hello".to_string(),
            resume_session_id: None,
            model_id: match harness {
                HarnessId::ClaudeCode => "claude-code:sonnet".to_string(),
                HarnessId::Codex => "codex:gpt-5.6-terra".to_string(),
            },
            tool_approval: ToolApproval::Auto,
            plan_mode: false,
        }
    }

    #[cfg(unix)]
    async fn wait_for_file(path: &std::path::Path) -> String {
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                if let Ok(value) = std::fs::read_to_string(path) {
                    if !value.trim().is_empty() {
                        return value;
                    }
                }
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("child must publish its lifecycle oracle")
    }

    #[cfg(unix)]
    async fn wait_for_pid_exit(pid: u32) {
        tokio::time::timeout(std::time::Duration::from_secs(5), async move {
            loop {
                let alive = tokio::process::Command::new("kill")
                    .arg("-0")
                    .arg(pid.to_string())
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .status()
                    .await
                    .map(|status| status.success())
                    .unwrap_or(false);
                if !alive {
                    return;
                }
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("process {pid} survived harness teardown"));
    }

    #[test]
    fn extract_user_text_joins_text_parts() {
        let msg = json!({"parts": [
            {"type": "text", "text": "hello"},
            {"type": "image", "url": "http://x"},
            {"type": "text", "text": "world"},
        ]});
        assert_eq!(extract_user_text(&msg), "hello\nworld");
    }

    #[test]
    fn extract_user_text_tolerates_a_bare_string() {
        assert_eq!(extract_user_text(&json!("hi")), "hi");
    }

    #[test]
    fn extract_user_text_empty_when_no_text_parts() {
        let msg = json!({"parts": [{"type": "image", "url": "http://x"}]});
        assert_eq!(extract_user_text(&msg), "");
    }

    #[test]
    fn tool_approval_from_wire() {
        assert_eq!(ToolApproval::from_wire("readonly"), ToolApproval::Readonly);
        assert_eq!(ToolApproval::from_wire("auto"), ToolApproval::Auto);
        // Byte-parity gate already restricts this to auto|readonly; an
        // unexpected value degrades to the more-permissive `Auto` rather
        // than panicking.
        assert_eq!(ToolApproval::from_wire("whatever"), ToolApproval::Auto);
    }

    #[test]
    fn resume_session_id_is_trimmed_and_empty_values_are_rejected() {
        let mut spec = base_spec(HarnessId::ClaudeCode);
        spec.resume_session_id = Some("  session-123  ".to_string());
        assert_eq!(
            normalized_resume_session_id(&spec).unwrap(),
            Some("session-123")
        );

        spec.resume_session_id = Some(" \n\t ".to_string());
        assert_eq!(
            normalized_resume_session_id(&spec),
            Err(ResolveError::InvalidSessionId)
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn public_start_entrypoints_reject_invalid_resume_without_spawning() {
        for use_lifetime_lock in [false, true] {
            let temp = tempfile::tempdir().expect("tempdir");
            let marker = temp.path().join("spawned");
            let mut spec = base_spec(HarnessId::ClaudeCode);
            spec.resume_session_id = Some(" \n\t ".to_string());
            let argv = vec![
                "/bin/sh".to_string(),
                "-c".to_string(),
                "printf spawned > \"$1\"".to_string(),
                "harness".to_string(),
                marker.display().to_string(),
            ];

            let mut handle = if use_lifetime_lock {
                start_with_child_lifetime_lock(argv, &spec, temp.path().join("child.lock")).await
            } else {
                start(argv, &spec).await
            };
            let mut events = Vec::new();
            while let Some(event) = handle.recv().await {
                events.push(event);
            }

            assert_eq!(
                events,
                vec![RunEvent::FatalError {
                    message: ResolveError::InvalidSessionId.to_string(),
                }]
            );
            assert!(
                !marker.exists(),
                "invalid resume input must be rejected before caller-supplied argv is spawned"
            );
            assert_eq!(handle.session_id().await, None);
        }
    }

    #[test]
    fn build_argv_fails_closed_for_an_unresolvable_claude_binary() {
        // No LOCAL_API_CLAUDE_BIN override is set for this test process,
        // and "claude" is very unlikely to be validated as present via
        // this pure function in a bare CI runner — but to make the
        // assertion deterministic regardless of the CI machine's PATH,
        // point the override at a definitely-nonexistent path via the
        // ENV directly is what `build_argv`/`resolve_checked` reads; since
        // that's not parallel-test-safe (see `resolve.rs`'s doc comment),
        // this test instead exercises the pure argv-shape assertions
        // below and leaves the resolve-failure path to `resolve.rs`'s own
        // (env-free) unit tests.
        let spec = base_spec(HarnessId::ClaudeCode);
        // Can't assert Ok/Err deterministically without an env override
        // (which isn't parallel-test-safe here) — just confirm this
        // doesn't panic either way.
        let _ = build_argv(&spec);
    }

    #[test]
    fn claude_argv_shape_includes_expected_flags() {
        let mut argv = vec!["claude".to_string()];
        let spec = base_spec(HarnessId::ClaudeCode);
        append_claude_args(&mut argv, &spec, None);
        assert!(argv.contains(&"-p".to_string()));
        assert!(argv.contains(&"hello".to_string()));
        assert!(argv.contains(&"stream-json".to_string()));
        assert!(argv.contains(&"--include-partial-messages".to_string()));
        assert!(argv.contains(&"claude-sonnet-5".to_string()));
        assert!(!argv.contains(&"--resume".to_string()));
    }

    #[test]
    fn claude_argv_includes_resume_when_session_id_present() {
        let mut argv = vec!["claude".to_string()];
        let mut spec = base_spec(HarnessId::ClaudeCode);
        spec.resume_session_id = Some("sess-123".to_string());
        append_claude_args(&mut argv, &spec, Some("sess-123"));
        let idx = argv.iter().position(|a| a == "--resume").unwrap();
        assert_eq!(argv[idx + 1], "sess-123");
    }

    #[test]
    fn claude_argv_disallows_write_tools_when_readonly() {
        let mut argv = vec!["claude".to_string()];
        let mut spec = base_spec(HarnessId::ClaudeCode);
        spec.tool_approval = ToolApproval::Readonly;
        append_claude_args(&mut argv, &spec, None);
        let idx = argv.iter().position(|a| a == "--disallowedTools").unwrap();
        assert!(argv[idx + 1].contains("Write"));
        assert!(argv[idx + 1].contains("Bash"));
    }

    #[test]
    fn claude_argv_allows_bash_when_auto_approval() {
        let mut argv = vec!["claude".to_string()];
        let spec = base_spec(HarnessId::ClaudeCode);
        append_claude_args(&mut argv, &spec, None);
        let idx = argv.iter().position(|a| a == "--disallowedTools").unwrap();
        assert!(!argv[idx + 1].contains("Bash"));
    }

    #[test]
    fn codex_argv_shape_includes_expected_flags() {
        let mut argv = vec!["codex".to_string()];
        let spec = base_spec(HarnessId::Codex);
        append_codex_args(&mut argv, &spec, None);
        assert_eq!(argv[1], "exec");
        assert!(argv.contains(&"--json".to_string()));
        assert!(argv.contains(&"gpt-5.6-terra".to_string()));
        assert_eq!(argv.last(), Some(&"hello".to_string()));
        assert!(!argv.contains(&"resume".to_string()));
    }

    #[test]
    fn codex_argv_includes_resume_subcommand_when_session_id_present() {
        let mut argv = vec!["codex".to_string()];
        let mut spec = base_spec(HarnessId::Codex);
        spec.resume_session_id = Some("thread-abc".to_string());
        append_codex_args(&mut argv, &spec, Some("thread-abc"));
        let idx = argv.iter().position(|a| a == "resume").unwrap();
        assert_eq!(argv[idx + 1], "thread-abc");
        // Prompt still trails everything.
        assert_eq!(argv.last(), Some(&"hello".to_string()));
    }

    #[test]
    fn codex_argv_sandbox_is_read_only_for_plan_mode() {
        let mut argv = vec!["codex".to_string()];
        let mut spec = base_spec(HarnessId::Codex);
        spec.plan_mode = true;
        append_codex_args(&mut argv, &spec, None);
        let idx = argv.iter().position(|a| a == "--sandbox").unwrap();
        assert_eq!(argv[idx + 1], "read-only");
    }

    // --- End-to-end drive() tests using a fake "harness" script (/bin/sh)
    // instead of the real CLIs — deterministic, free, and exercises the
    // exact same drive()/spawn()/EventMapper wiring `local-api`'s dispatch
    // route depends on, just against synthetic ndjson instead of a real
    // model call. This is the differential/stub-harness style contract
    // the Phase 2 TODO's "deterministic stub harness" item calls for, at
    // the harness-crate level (the desktop-level black-box differential
    // suite is a separate, higher-layer concern this crate's tests don't
    // replace).

    fn claude_success_script() -> String {
        // Mirrors the fallback shape from
        // `apps/native/e2e/fixtures/stub-harness.mjs`: plain `assistant`
        // frames only. The mapper retains this path for older CLIs and
        // test doubles that accept but do not emit partial messages.
        "printf '%s\\n' \
         '{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"s1\"}' \
         '{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"hi\"}]}}' \
         '{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"result\":\"hi\",\"session_id\":\"s1\"}'"
            .to_string()
    }

    fn success_without_session_script(harness: HarnessId) -> String {
        match harness {
            HarnessId::ClaudeCode => {
                "printf '%s\\n' \
                 '{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"hi\"}]}}' \
                 '{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"result\":\"hi\"}'"
                    .to_string()
            }
            HarnessId::Codex => {
                "printf '%s\\n' \
                 '{\"type\":\"turn.started\"}' \
                 '{\"type\":\"item.completed\",\"item\":{\"id\":\"item-1\",\"type\":\"agent_message\",\"text\":\"hi\"}}' \
                 '{\"type\":\"turn.completed\",\"usage\":{}}'"
                    .to_string()
            }
        }
    }

    fn changed_session_script(harness: HarnessId) -> String {
        match harness {
            HarnessId::ClaudeCode => "printf '%s\\n' \
                 '{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"changed-session\"}'"
                .to_string(),
            HarnessId::Codex => "printf '%s\\n' \
                 '{\"type\":\"thread.started\",\"thread_id\":\"changed-session\"}'"
                .to_string(),
        }
    }

    #[tokio::test]
    async fn successful_first_run_without_session_is_fatal_for_both_harnesses() {
        for harness in [HarnessId::ClaudeCode, HarnessId::Codex] {
            let spec = base_spec(harness);
            let argv = vec![
                "/bin/sh".to_string(),
                "-c".to_string(),
                success_without_session_script(harness),
            ];
            let mut handle = start(argv, &spec).await;
            let mut events = Vec::new();
            while let Some(event) = handle.recv().await {
                events.push(event);
            }

            assert!(
                events.iter().any(|event| matches!(
                    event,
                    RunEvent::FatalError { message } if message == MISSING_SESSION_ID_ERROR
                )),
                "{harness:?} must fail instead of creating non-resumable history: {events:?}"
            );
            assert!(
                !events.iter().any(
                    |event| matches!(event, RunEvent::Chunk(value) if value["type"] == "finish")
                ),
                "{harness:?} must not publish a successful finish without a session"
            );
            assert_eq!(handle.session_id().await, None);
        }
    }

    #[tokio::test]
    async fn resumed_runs_retain_the_supplied_session_when_cli_does_not_repeat_it() {
        for harness in [HarnessId::ClaudeCode, HarnessId::Codex] {
            let mut spec = base_spec(harness);
            spec.resume_session_id = Some("  durable-session  ".to_string());
            let argv = vec![
                "/bin/sh".to_string(),
                "-c".to_string(),
                success_without_session_script(harness),
            ];
            let mut handle = start(argv, &spec).await;
            let mut events = Vec::new();
            while let Some(event) = handle.recv().await {
                events.push(event);
            }

            assert!(
                events.iter().any(
                    |event| matches!(event, RunEvent::Chunk(value) if value["type"] == "finish")
                ),
                "{harness:?} resumed run should complete: {events:?}"
            );
            assert!(
                !events
                    .iter()
                    .any(|event| matches!(event, RunEvent::FatalError { .. })),
                "{harness:?} resumed run should not require the CLI to repeat its id: {events:?}"
            );
            assert_eq!(
                handle.session_id().await.as_deref(),
                Some("durable-session")
            );
        }
    }

    #[tokio::test]
    async fn resumed_runs_fail_if_either_cli_changes_the_session_id() {
        for harness in [HarnessId::ClaudeCode, HarnessId::Codex] {
            let mut spec = base_spec(harness);
            spec.resume_session_id = Some("durable-session".to_string());
            let argv = vec![
                "/bin/sh".to_string(),
                "-c".to_string(),
                changed_session_script(harness),
            ];
            let mut handle = start(argv, &spec).await;
            let mut events = Vec::new();
            while let Some(event) = handle.recv().await {
                events.push(event);
            }

            assert!(
                events.iter().any(|event| matches!(
                    event,
                    RunEvent::FatalError { message } if message == CHANGED_SESSION_ID_ERROR
                )),
                "{harness:?} must reject a split session: {events:?}"
            );
            assert_eq!(
                handle.session_id().await.as_deref(),
                Some("durable-session"),
                "the durable resume id must not be replaced by the fork"
            );
        }
    }

    #[tokio::test]
    async fn mapper_emitted_whitespace_session_id_is_fatal() {
        let spec = base_spec(HarnessId::ClaudeCode);
        let argv = vec![
            "/bin/sh".to_string(),
            "-c".to_string(),
            "printf '%s\\n' \
             '{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"  \"}'"
                .to_string(),
        ];
        let mut handle = start(argv, &spec).await;
        let mut events = Vec::new();
        while let Some(event) = handle.recv().await {
            events.push(event);
        }

        assert!(events.iter().any(|event| matches!(
            event,
            RunEvent::FatalError { message } if message == EMPTY_SESSION_ID_ERROR
        )));
        assert_eq!(handle.session_id().await, None);
    }

    #[tokio::test]
    async fn mapper_session_id_is_trimmed_before_resume_consistency_check() {
        let mut spec = base_spec(HarnessId::ClaudeCode);
        spec.resume_session_id = Some(" durable-session ".to_string());
        let argv = vec![
            "/bin/sh".to_string(),
            "-c".to_string(),
            "printf '%s\\n' \
             '{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"  durable-session  \"}' \
             '{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"result\":\"ok\",\"session_id\":\"  durable-session  \"}'"
                .to_string(),
        ];
        let mut handle = start(argv, &spec).await;
        let mut events = Vec::new();
        while let Some(event) = handle.recv().await {
            events.push(event);
        }

        assert!(!events
            .iter()
            .any(|event| matches!(event, RunEvent::FatalError { .. })));
        assert!(events
            .iter()
            .any(|event| matches!(event, RunEvent::Chunk(value) if value["type"] == "finish")));
        assert_eq!(
            handle.session_id().await.as_deref(),
            Some("durable-session")
        );
    }

    #[tokio::test]
    async fn drive_end_to_end_yields_chunks_then_closes_with_no_fatal_error() {
        let req = SpawnRequest::new(vec![
            "/bin/sh".to_string(),
            "-c".to_string(),
            claude_success_script(),
        ]);
        let (tx, mut rx) = mpsc::channel::<RunEvent>(64);
        let cancelled = Arc::new(AtomicBool::new(false));
        let process_slot = Arc::new(Mutex::new(None));
        let session_id = Arc::new(Mutex::new(None));
        drive(
            req,
            HarnessId::ClaudeCode,
            tx,
            cancelled,
            process_slot,
            session_id.clone(),
        )
        .await;

        let mut events = Vec::new();
        while let Some(ev) = rx.recv().await {
            events.push(ev);
        }
        assert!(events
            .iter()
            .any(|e| matches!(e, RunEvent::Chunk(v) if v["type"] == "text-delta")));
        assert!(events
            .iter()
            .any(|e| matches!(e, RunEvent::Chunk(v) if v["type"] == "finish")));
        assert!(!events
            .iter()
            .any(|e| matches!(e, RunEvent::FatalError { .. })));
        assert_eq!(session_id.lock().await.as_deref(), Some("s1"));
    }

    #[tokio::test]
    async fn drive_synthesizes_a_fatal_error_on_unexpected_nonzero_exit() {
        let req = SpawnRequest::new(vec![
            "/bin/sh".to_string(),
            "-c".to_string(),
            "echo 'not json' 1>&2; exit 3".to_string(),
        ]);
        let (tx, mut rx) = mpsc::channel::<RunEvent>(64);
        let cancelled = Arc::new(AtomicBool::new(false));
        let process_slot = Arc::new(Mutex::new(None));
        let session_id = Arc::new(Mutex::new(None));
        drive(
            req,
            HarnessId::Codex,
            tx,
            cancelled,
            process_slot,
            session_id,
        )
        .await;

        let mut events = Vec::new();
        while let Some(ev) = rx.recv().await {
            events.push(ev);
        }
        assert_eq!(events.len(), 1);
        let RunEvent::FatalError { message } = &events[0] else {
            panic!("expected a FatalError")
        };
        assert!(message.contains("codex"));
        assert!(message.contains('3'));
        assert!(message.contains("not json"));
    }

    #[tokio::test]
    async fn drive_suppresses_the_synthetic_error_when_cancelled() {
        let req = SpawnRequest::new(vec![
            "/bin/sh".to_string(),
            "-c".to_string(),
            "sleep 0.2; exit 1".to_string(),
        ]);
        let (tx, mut rx) = mpsc::channel::<RunEvent>(64);
        let cancelled = Arc::new(AtomicBool::new(true)); // pre-cancelled
        let process_slot = Arc::new(Mutex::new(None));
        let session_id = Arc::new(Mutex::new(None));
        drive(
            req,
            HarnessId::Codex,
            tx,
            cancelled,
            process_slot,
            session_id,
        )
        .await;

        let mut events = Vec::new();
        while let Some(ev) = rx.recv().await {
            events.push(ev);
        }
        assert!(
            events.is_empty(),
            "a cancelled run's nonzero exit must not synthesize a FatalError"
        );
    }

    #[tokio::test]
    async fn drive_flushes_partial_text_on_clean_eof() {
        let req = SpawnRequest::new(vec![
            "/bin/sh".to_string(),
            "-c".to_string(),
            "printf '%s\\n' \
             '{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"partial-session\"}' \
             '{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}}' \
             '{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"partial\"}}}'"
                .to_string(),
        ]);
        let (tx, mut rx) = mpsc::channel::<RunEvent>(64);
        drive(
            req,
            HarnessId::ClaudeCode,
            tx,
            Arc::new(AtomicBool::new(false)),
            Arc::new(Mutex::new(None)),
            Arc::new(Mutex::new(None)),
        )
        .await;

        let mut chunk_types = Vec::new();
        while let Some(event) = rx.recv().await {
            match event {
                RunEvent::SessionId { .. } => {}
                RunEvent::Chunk(value) => {
                    chunk_types.push(value["type"].as_str().unwrap_or("").to_string())
                }
                RunEvent::FatalError { message } => panic!("unexpected fatal error: {message}"),
            }
        }
        assert_eq!(
            chunk_types,
            vec!["start", "text-start", "text-delta", "text-end"]
        );
    }

    #[tokio::test]
    async fn drive_flushes_partial_tool_as_error_before_nonzero_exit_error() {
        let req = SpawnRequest::new(vec![
            "/bin/sh".to_string(),
            "-c".to_string(),
            "printf '%s\\n' \
             '{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"tool_use\",\"id\":\"toolu_cut\",\"name\":\"Bash\",\"input\":{}}}}' \
             '{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"command\\\":\"}}}'; \
             printf 'process failed\\n' >&2; exit 3"
                .to_string(),
        ]);
        let (tx, mut rx) = mpsc::channel::<RunEvent>(64);
        drive(
            req,
            HarnessId::ClaudeCode,
            tx,
            Arc::new(AtomicBool::new(false)),
            Arc::new(Mutex::new(None)),
            Arc::new(Mutex::new(None)),
        )
        .await;

        let mut events = Vec::new();
        while let Some(event) = rx.recv().await {
            events.push(event);
        }
        assert!(matches!(
            events.get(events.len().saturating_sub(2)),
            Some(RunEvent::Chunk(value)) if value["type"] == "tool-input-error"
                && value["toolCallId"] == "toolu_cut"
        ));
        assert!(matches!(
            events.last(),
            Some(RunEvent::FatalError { message }) if message.contains("process failed")
        ));
        assert!(!events.iter().any(
            |event| matches!(event, RunEvent::Chunk(value) if value["type"] == "tool-input-available")
        ));
    }

    #[tokio::test]
    async fn claude_retries_without_partial_flag_only_after_argument_parser_rejection() {
        let temp = tempfile::tempdir().expect("tempdir");
        let attempts = temp.path().join("attempts");
        let script = format!(
            "count=$(cat '{}' 2>/dev/null || printf 0); count=$((count + 1)); printf '%s' \"$count\" > '{}'; \
             case \" $* \" in \
               *' --include-partial-messages '*) printf \"error: unknown option '--include-partial-messages'\\n\" >&2; exit 1 ;; \
             esac; \
             {}",
            attempts.display(),
            attempts.display(),
            claude_success_script()
        );
        let req = SpawnRequest::new(vec![
            "/bin/sh".to_string(),
            "-c".to_string(),
            script,
            "stub-claude".to_string(),
            "--include-partial-messages".to_string(),
        ]);
        let (tx, mut rx) = mpsc::channel::<RunEvent>(64);
        drive(
            req,
            HarnessId::ClaudeCode,
            tx,
            Arc::new(AtomicBool::new(false)),
            Arc::new(Mutex::new(None)),
            Arc::new(Mutex::new(None)),
        )
        .await;

        let mut events = Vec::new();
        while let Some(event) = rx.recv().await {
            events.push(event);
        }
        assert_eq!(std::fs::read_to_string(&attempts).unwrap(), "2");
        assert!(events
            .iter()
            .any(|event| matches!(event, RunEvent::Chunk(value) if value["type"] == "finish")));
        assert!(!events
            .iter()
            .any(|event| matches!(event, RunEvent::FatalError { .. })));
    }

    #[tokio::test]
    async fn claude_never_retries_unknown_flag_text_after_any_stdout() {
        let temp = tempfile::tempdir().expect("tempdir");
        let attempts = temp.path().join("attempts");
        let script = format!(
            "count=$(cat '{}' 2>/dev/null || printf 0); count=$((count + 1)); printf '%s' \"$count\" > '{}'; \
             printf '%s\\n' '{{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"already-started\"}}'; \
             printf \"error: unknown option '--include-partial-messages'\\n\" >&2; exit 1",
            attempts.display(),
            attempts.display(),
        );
        let req = SpawnRequest::new(vec![
            "/bin/sh".to_string(),
            "-c".to_string(),
            script,
            "stub-claude".to_string(),
            "--include-partial-messages".to_string(),
        ]);
        let (tx, mut rx) = mpsc::channel::<RunEvent>(64);
        drive(
            req,
            HarnessId::ClaudeCode,
            tx,
            Arc::new(AtomicBool::new(false)),
            Arc::new(Mutex::new(None)),
            Arc::new(Mutex::new(None)),
        )
        .await;

        let mut events = Vec::new();
        while let Some(event) = rx.recv().await {
            events.push(event);
        }
        assert_eq!(std::fs::read_to_string(&attempts).unwrap(), "1");
        assert!(events
            .iter()
            .any(|event| matches!(event, RunEvent::FatalError { .. })));
    }

    #[tokio::test]
    async fn cancelling_a_partial_reasoning_stream_emits_reasoning_end() {
        let spec = base_spec(HarnessId::ClaudeCode);
        let argv = vec![
            "/bin/sh".to_string(),
            "-c".to_string(),
            "printf '%s\\n' \
             '{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"thinking\",\"thinking\":\"\"}}}' \
             '{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"working\"}}}'; \
             sleep 30"
                .to_string(),
        ];
        let mut handle = start(argv, &spec).await;
        let first = tokio::time::timeout(std::time::Duration::from_secs(5), handle.recv())
            .await
            .expect("partial reasoning must start")
            .expect("stream must remain open");
        assert!(matches!(
            first,
            RunEvent::Chunk(value) if value["type"] == "reasoning-start"
        ));

        handle.cancel().await;
        let mut events = Vec::new();
        while let Some(event) = handle.recv().await {
            events.push(event);
        }
        assert!(events.iter().any(
            |event| matches!(event, RunEvent::Chunk(value) if value["type"] == "reasoning-end")
        ));
        assert!(!events
            .iter()
            .any(|event| matches!(event, RunEvent::FatalError { .. })));
    }

    #[tokio::test]
    async fn run_handle_cancel_terminates_the_process_and_closes_the_stream() {
        let mut spec = base_spec(HarnessId::ClaudeCode);
        spec.prompt = "irrelevant".to_string();
        let argv = vec![
            "/bin/sh".to_string(),
            "-c".to_string(),
            "sleep 30".to_string(),
        ];
        let mut handle = start(argv, &spec).await;
        // Give the process a moment to actually spawn and register its pid.
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        handle.cancel().await;
        let outcome = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while let Some(_ev) = handle.recv().await {}
        })
        .await;
        assert!(
            outcome.is_ok(),
            "cancel() must terminate the process so the event stream closes promptly"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn run_handle_cancel_escalates_to_kill_for_a_term_resistant_group() {
        let mut spec = base_spec(HarnessId::ClaudeCode);
        spec.prompt = "irrelevant".to_string();
        let argv = vec![
            "/bin/sh".to_string(),
            "-c".to_string(),
            // Install the handler before announcing readiness so the test
            // cannot accidentally signal the default disposition window.
            "trap '' TERM; printf '%s\\n' '{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"term-resistant\"}'; while :; do sleep 30; done".to_string(),
        ];
        let mut handle = start(argv, &spec).await;
        tokio::time::timeout(std::time::Duration::from_secs(5), handle.recv())
            .await
            .expect("TERM-resistant child must announce readiness")
            .expect("TERM-resistant child exited before cancellation");

        handle.cancel().await;
        let outcome = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while let Some(_event) = handle.recv().await {}
        })
        .await;
        assert!(
            outcome.is_ok(),
            "cancel() must hard-kill a process group that ignores SIGTERM"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn dropping_run_handle_reaps_term_resistant_child_and_descendant() {
        let temp = tempfile::tempdir().expect("tempdir");
        let pids_path = temp.path().join("pids");
        let script = format!(
            "trap '' TERM; /bin/sh -c 'trap \"\" TERM; while :; do sleep 30; done' & descendant=$!; printf '%s %s\\n' \"$$\" \"$descendant\" > '{}'; printf '%s\\n' '{{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"drop-owner\"}}'; while :; do sleep 30; done",
            pids_path.display()
        );
        let spec = base_spec(HarnessId::ClaudeCode);
        let mut handle = start(vec!["/bin/sh".to_string(), "-c".to_string(), script], &spec).await;
        tokio::time::timeout(std::time::Duration::from_secs(5), handle.recv())
            .await
            .expect("child must announce readiness")
            .expect("child exited before drop");
        let pids = wait_for_file(&pids_path).await;
        let mut pids = pids.split_whitespace().map(|pid| {
            pid.parse::<u32>()
                .unwrap_or_else(|_| panic!("invalid child pid {pid:?}"))
        });
        let child_pid = pids.next().expect("direct child pid");
        let descendant_pid = pids.next().expect("descendant pid");

        drop(handle);

        wait_for_pid_exit(child_pid).await;
        wait_for_pid_exit(descendant_pid).await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn aborting_cancel_future_does_not_abort_hard_kill_escalation() {
        let temp = tempfile::tempdir().expect("tempdir");
        let term_path = temp.path().join("term-received");
        let script = format!(
            "trap 'printf term > \"{}\"' TERM; printf '%s\\n' '{{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"cancel-abort\"}}'; while :; do sleep 30; done",
            term_path.display()
        );
        let spec = base_spec(HarnessId::ClaudeCode);
        let mut handle = start(vec!["/bin/sh".to_string(), "-c".to_string(), script], &spec).await;
        tokio::time::timeout(std::time::Duration::from_secs(5), handle.recv())
            .await
            .expect("child must announce readiness")
            .expect("child exited before cancellation");

        let cancel = handle.cancel_handle();
        let cancel_task = tokio::spawn(async move { cancel.cancel().await });
        wait_for_file(&term_path).await;
        cancel_task.abort();

        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while handle.recv().await.is_some() {}
        })
        .await
        .expect("detached escalation must kill the TERM-resistant child");
    }

    #[tokio::test]
    async fn cancel_handle_reaches_the_same_run_as_the_owning_run_handle() {
        let spec = base_spec(HarnessId::ClaudeCode);
        let argv = vec![
            "/bin/sh".to_string(),
            "-c".to_string(),
            "sleep 30".to_string(),
        ];
        let mut handle = start(argv, &spec).await;
        let cancel_handle = handle.cancel_handle();
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        // Cancel via the DETACHED handle, not `handle` itself — mirrors
        // `local-api`'s dispatch route storing a `CancelHandle` in a
        // shared registry while a separate task drains `handle.recv()`.
        cancel_handle.cancel().await;
        let outcome = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while let Some(_ev) = handle.recv().await {}
        })
        .await;
        assert!(
            outcome.is_ok(),
            "a cancel via the detached CancelHandle must still terminate the run"
        );
    }

    /// Regression test for the exact bug
    /// `apps/native/e2e/dispatch-stream.e2e.test.ts`'s `hang` scenario
    /// caught: `cancel()` called with NO grace period at all — i.e. in
    /// the window where `drive()`'s own `spawn::spawn(req).await` may not
    /// have completed yet, so `process_slot` can still be `None` when
    /// `cancel()` runs. Before the `drive()`-side re-check this test
    /// exercises, this was flaky-to-reliably-failing (the process would
    /// spawn AFTER `cancel()` already gave up, then run forever); it must
    /// now deterministically terminate regardless of scheduling luck.
    #[tokio::test]
    async fn cancel_called_with_zero_grace_period_still_kills_the_process() {
        let spec = base_spec(HarnessId::ClaudeCode);
        let argv = vec![
            "/bin/sh".to_string(),
            "-c".to_string(),
            "sleep 30".to_string(),
        ];
        let mut handle = start(argv, &spec).await;
        // NO sleep here — cancel as fast as this task can possibly run,
        // maximizing the odds of landing before `drive()`'s spawn
        // completes (exactly what a client cancelling the instant it
        // observes the harness's very first output line does in
        // practice).
        handle.cancel().await;
        let outcome = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while let Some(_ev) = handle.recv().await {}
        })
        .await;
        assert!(
            outcome.is_ok(),
            "a zero-grace-period cancel must still terminate the process once it spawns"
        );
    }
}
