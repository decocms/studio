//! `/_sandbox/git/*` — byte-parity target: `daemon/routes/git.ts` +
//! `daemon/git/rebase-onto-base.ts`, oracle `daemon.git.e2e.test.ts`
//! (minus the setup/clone-dependent specs — no clone pipeline, see
//! the native local-API contract).
//!
//! ## Scope vs. the daemon
//!
//! Local-api never clones — `state.repo_dir` is the user's *existing*
//! project folder (contract doc, env table). Two daemon behaviors that only
//! make sense for a cloned/managed repo are deliberately dropped here (both
//! documented at their call sites below):
//!
//! - No `getCloneUrl`/`syncOriginRemote` step in `publish()`: the daemon
//!   rewrites `origin` to an OAuth-token-embedded clone URL from its config
//!   store before pushing. Local-api has no such credentialed-URL config
//!   (Upstream Proxy/Keychain OAuth is Phase 3) — the user's own git
//!   credential setup (SSH key, `gh` CLI, macOS Git Credential Manager)
//!   already makes `git push` work in this repo today, same as if they ran
//!   it from a terminal.
//! - No "GitHub push requires an authenticated clone URL" guard: that guard
//!   exists purely to catch the daemon's own clone-URL-rewrite silently
//!   no-op'ing; with no rewrite step, it has nothing to guard.
//! - No `OperatorIdentity`/co-author trailer on generated commits
//!   (`Before rebase`, `Update from sandbox`): the daemon appends a
//!   `Co-authored-by:` trailer for the Studio user driving the sandbox.
//!   Local-api has no such concept (single local user, their own git
//!   identity) — commits use the plain message.
//!
//! Every other piece of argv/env parity (the `--no-verify` + empty
//! `core.hooksPath` hook bypass, `--force-with-lease` → `--force` fallback,
//! `GIT_CEILING_DIRECTORIES`/`GIT_OPTIONAL_LOCKS` pinning, the protected-
//! branch push guard) is ported faithfully — see the two env profiles
//! ([`route_env`]/[`ceiling_env`]) and the per-function doc comments below.
//!
//! ## No publish on shutdown
//!
//! Unlike the cluster daemon (`entry.ts::shutdown()` publishes because its
//! sandbox filesystem dies with the pod), this crate runs on the user's own
//! machine: worktrees are durable and `SandboxManager::ensure` reuses a
//! valid checkout as-is on the next launch. Publishing here is therefore
//! only ever user-triggered (the [`publish`] route) — app close leaves
//! local work local, committed or not, instead of blocking exit on a
//! network push.
//!
//! ## `"branch"` broadcaster event
//!
//! [`emit_branch_event`] fires after a successful publish/discard/rebase
//! (the native module-ownership contract's "Emits" table), shaped exactly like the daemon's
//! `BranchStatusMonitor` reconnect-snapshot payload (`{ meta: { kind:
//! "ready", branch, base, workingTreeDirty, unpushed, aheadOfBase,
//! behindBase, headSha } }`, see `daemon/git/branch-status.ts` and
//! `daemon.sse-shapes.e2e.test.ts`'s "branch" assertions).
//!
//! Reconnect snapshots are recomputed from the resolved sandbox target's
//! repository by `routes/events.rs`; there is deliberately no process-global
//! "last branch" cache. A process-global cache leaks one sandbox's branch into
//! another and starts empty after an app restart even though the worktree
//! survived. Per-sandbox live streams additionally run a bounded poller while
//! they have subscribers, matching the old daemon monitor's three-second
//! fallback without retaining another in-memory transcript.

use std::collections::HashSet;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

use axum::{body::Bytes, extract::State, http::StatusCode, Json};
use futures_util::FutureExt;
use serde_json::{json, Value};
use tokio::sync::oneshot;

use crate::error::{ApiError, ApiResult};
use crate::process_group::ProcessGroupChild;
use crate::process_util::CancelOnDrop;
use crate::state::AppState;
use crate::tasks::{
    registry::now_ms, KillHandle, KillSignal, ProcessController, TaskEntry, TaskStatus, TaskSummary,
};

const GIT_TIMEOUT: Duration = Duration::from_secs(30);
const GIT_TERM_GRACE: Duration = Duration::from_millis(500);
const GIT_KILL_GRACE: Duration = Duration::from_secs(2);

tokio::task_local! {
    /// One controller per high-level route/shutdown-publish operation. Keeping
    /// this task-local lets the deep git helper graph remain shared with setup
    /// probes while every command polled inside an owned route observes the
    /// same durable TERM -> KILL request.
    static GIT_PROCESS_CONTROLLER: ProcessController;
    /// App-root-wide crash/relaunch fence shared by every process family.
    /// Keeping it beside the controller lets the deep git helper graph stay
    /// parameter-free without falling back to a process-global singleton.
    static GIT_CHILD_LIFETIME_LOCK_PATH: std::path::PathBuf;
}

// ---------------------------------------------------------------------------
// HTTP handlers
// ---------------------------------------------------------------------------

pub async fn status(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    run_owned_git_route(state.clone(), "git status", status_inner(state)).await
}

async fn status_inner(state: AppState) -> ApiResult<Json<Value>> {
    require_git_repo(&state.repo_dir).await?;
    let result = compute_status(&state.repo_dir)
        .await
        .map_err(|e| ApiError::internal(e.message))?;
    Ok(Json(result))
}

pub async fn diff(State(state): State<AppState>, body: Bytes) -> ApiResult<Json<Value>> {
    run_owned_git_route(state.clone(), "git diff", diff_inner(state, body)).await
}

async fn diff_inner(state: AppState, body: Bytes) -> ApiResult<Json<Value>> {
    require_git_repo(&state.repo_dir).await?;

    // Byte-parity with `makeGitDiffHandler`: a malformed/empty/absent body is
    // NOT an error here (unlike publish/discard/rebase below) — it just
    // means "working-tree diff", matching the route's GET-or-POST shape.
    let mut base: Option<String> = None;
    let mut head_sha: Option<String> = None;
    if !body.is_empty() {
        if let Ok(v) = serde_json::from_slice::<Value>(&body) {
            if let Some(b) = v.get("base").and_then(Value::as_str) {
                let b = b.trim();
                if !b.is_empty() {
                    base = Some(b.to_string());
                }
            }
            if let Some(h) = v.get("headSha").and_then(Value::as_str) {
                let h = h.trim();
                if !h.is_empty() {
                    head_sha = Some(h.to_string());
                }
            }
        }
    }

    let result = if let Some(base) = base {
        compute_diff_against_base(&state.repo_dir, &base, head_sha.as_deref())
            .await
            .map_err(|e| route_error_response(e, false))?
    } else {
        compute_diff(&state.repo_dir)
            .await
            .map_err(|e| ApiError::internal(e.message))?
    };
    Ok(Json(result))
}

pub async fn publish(State(state): State<AppState>, body: Bytes) -> ApiResult<Json<Value>> {
    run_owned_git_route(state.clone(), "git publish", publish_inner(state, body)).await
}

async fn publish_inner(state: AppState, body: Bytes) -> ApiResult<Json<Value>> {
    require_git_repo(&state.repo_dir).await?;
    let parsed = parse_json_body(&body).map_err(ApiError::bad_request)?;
    let message = parsed
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();

    match publish_internal(&state.repo_dir, &message).await {
        Ok(pushed) => {
            if pushed {
                emit_branch_event(&state.repo_dir, &state.broadcaster).await;
            }
            Ok(Json(json!({ "pushed": pushed })))
        }
        Err(e) => Err(route_error_response(e, true)),
    }
}

pub async fn discard(State(state): State<AppState>, body: Bytes) -> ApiResult<Json<Value>> {
    run_owned_git_route(state.clone(), "git discard", discard_inner(state, body)).await
}

async fn discard_inner(state: AppState, body: Bytes) -> ApiResult<Json<Value>> {
    require_git_repo(&state.repo_dir).await?;
    let parsed = parse_json_body(&body).map_err(ApiError::bad_request)?;
    let filepaths = match parsed.get("filepaths").and_then(Value::as_array) {
        Some(arr) if !arr.is_empty() => arr
            .iter()
            .filter_map(|v| v.as_str().map(str::to_string))
            .collect::<Vec<_>>(),
        _ => return Err(ApiError::bad_request("filepaths is required")),
    };

    match discard_files(&state.app_root, &state.repo_dir, &filepaths).await {
        Ok(()) => {
            emit_branch_event(&state.repo_dir, &state.broadcaster).await;
            Ok(Json(json!({ "success": true })))
        }
        // Byte-parity with `makeGitDiscardHandler`'s catch-all 500 (including
        // for a caller mistake like an escaping path) — see the module doc's
        // note that `error.rs`'s "500 reserved for local-api's own bugs"
        // guidance and this route's byte-parity target are in tension here;
        // byte-parity wins since it's the stated evaluation target and no
        // test in the oracle distinguishes the two.
        Err(msg) => Err(ApiError::internal(msg)),
    }
}

pub async fn rebase(State(state): State<AppState>, body: Bytes) -> ApiResult<Json<Value>> {
    run_owned_git_route(state.clone(), "git rebase", rebase_inner(state, body)).await
}

async fn rebase_inner(state: AppState, body: Bytes) -> ApiResult<Json<Value>> {
    require_git_repo(&state.repo_dir).await?;
    let parsed = parse_json_body(&body).map_err(ApiError::bad_request)?;
    let base = parsed
        .get("base")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    if base.is_empty() {
        return Err(ApiError::bad_request("base is required"));
    }

    match rebase_onto_base(&state.repo_dir, base).await {
        Ok(()) => {
            emit_branch_event(&state.repo_dir, &state.broadcaster).await;
            Ok(Json(json!({ "rebased": true })))
        }
        Err(e) => Err(route_error_response(e, true)),
    }
}

/// Registers and spawns one hidden owner for a complete high-level Git
/// operation. Registration is synchronous and happens before `tokio::spawn`,
/// so callers can hold shutdown admission through this function and release it
/// immediately afterward: every accepted operation is then enumerable through
/// `TaskRegistry`, without holding a read-admission guard for its full runtime.
fn spawn_git_operation_owner<T, F>(
    state: AppState,
    command: &str,
    operation: F,
) -> (KillHandle, oneshot::Receiver<Result<T, &'static str>>)
where
    T: Send + 'static,
    F: Future<Output = T> + Send + 'static,
{
    let id = format!("internal-git-{}", uuid::Uuid::new_v4());
    let controller = ProcessController::new();
    let kill_handle = controller.kill_handle();
    state.tasks.insert(TaskEntry::new_internal(
        TaskSummary {
            id: id.clone(),
            command: command.to_string(),
            status: TaskStatus::Running,
            exit_code: None,
            started_at: now_ms(),
            finished_at: None,
            timed_out: false,
            truncated: false,
            log_name: None,
            intentional: None,
        },
        Some(kill_handle.clone()),
    ));

    let tasks = state.tasks.clone();
    let child_lifetime_lock_path = state.tasks.child_lifetime_lock_path().to_path_buf();
    let owner_id = id.clone();
    let (result_tx, result_rx) = oneshot::channel();
    tokio::spawn(async move {
        let operation = GIT_CHILD_LIFETIME_LOCK_PATH.scope(child_lifetime_lock_path, operation);
        let driven = std::panic::AssertUnwindSafe(
            GIT_PROCESS_CONTROLLER.scope(controller.clone(), operation),
        )
        .catch_unwind()
        .await;

        let requested = controller.requested();
        let (status, exit_code) = match (requested, &driven) {
            (Some(signal), _) => (TaskStatus::Killed, signal.exit_code()),
            (None, Ok(_)) => (TaskStatus::Exited, 0),
            (None, Err(_)) => (TaskStatus::Failed, -1),
        };

        // Every `run_git_raw` inside the scoped future returns only after its
        // child and inherited stdout/stderr holders are gone. Therefore this
        // terminal transition is also the process-tree join outcome—not merely
        // a signal-request acknowledgement.
        tasks.finalize(&owner_id, status, exit_code, false);
        let _ = tasks.remove(&owner_id).await;
        let result = driven.map_err(|_| "git operation owner panicked");
        let _ = result_tx.send(result);
    });

    (kill_handle, result_rx)
}

/// Admits only the spawn + hidden-owner registration critical section. The
/// detached owner remains visible to coordinated shutdown until all of its Git
/// process groups have been joined and the operation has finalized.
async fn run_owned_git_route<T, F>(state: AppState, command: &str, operation: F) -> ApiResult<T>
where
    T: Send + 'static,
    F: Future<Output = ApiResult<T>> + Send + 'static,
{
    let shutdown = state.shutdown.clone();
    let Some(admission) = shutdown.admit_work().await else {
        return Err(ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "application is shutting down",
        ));
    };
    let (kill_handle, result_rx) = spawn_git_operation_owner(state, command, operation);
    drop(admission);

    let mut cancel_on_drop = CancelOnDrop::new(kill_handle, KillSignal::Term);
    let result = result_rx
        .await
        .map_err(|_| ApiError::internal("git operation owner stopped unexpectedly"))?
        .map_err(ApiError::internal)?;
    cancel_on_drop.disarm();
    result
}

async fn require_git_repo(repo_dir: &Path) -> ApiResult<()> {
    if is_git_repo(repo_dir).await {
        Ok(())
    } else {
        Err(ApiError::not_ready("repository not initialized"))
    }
}

/// Byte-parity with `parseJsonBody` — ANY parse failure (including an empty
/// body) is a 400 for publish/discard/rebase, unlike `diff` above which
/// swallows it.
fn parse_json_body(body: &Bytes) -> Result<Value, String> {
    serde_json::from_slice::<Value>(body).map_err(|e| format!("Failed to parse body: {e}"))
}

// ---------------------------------------------------------------------------
// Git process plumbing
// ---------------------------------------------------------------------------

#[derive(Debug)]
struct GitError {
    message: String,
}

impl std::fmt::Display for GitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

/// `GIT_CEILING_DIRECTORIES` + `GIT_OPTIONAL_LOCKS=0` — the profile
/// `routes/git.ts`'s own `runGit`/`runGitAsync` use for every status/diff/
/// publish/discard invocation. `GIT_OPTIONAL_LOCKS=0` skips the optional
/// index-refresh lock on read probes (status/diff/rev-parse) so they never
/// race `publish()`'s add/commit for `index.lock` — see the source comment
/// this ports (`daemon/routes/git.ts::gitEnv`).
fn route_env(repo_dir: &Path) -> Vec<(String, String)> {
    vec![
        (
            "GIT_CEILING_DIRECTORIES".to_string(),
            repo_dir.to_string_lossy().into_owned(),
        ),
        ("GIT_OPTIONAL_LOCKS".to_string(), "0".to_string()),
    ]
}

/// `GIT_CEILING_DIRECTORIES` only — the profile `branch-divergence.ts` and
/// `rebase-onto-base.ts` each define locally (no `GIT_OPTIONAL_LOCKS`,
/// since both do real writes and don't want lock-skipping in the mix).
fn ceiling_env(repo_dir: &Path) -> Vec<(String, String)> {
    vec![(
        "GIT_CEILING_DIRECTORIES".to_string(),
        repo_dir.to_string_lossy().into_owned(),
    )]
}

async fn run_git_raw<S: AsRef<str>>(
    repo_dir: &Path,
    args: &[S],
    env: &[(String, String)],
) -> Result<String, GitError> {
    run_git_raw_with_timeout(repo_dir, args, env, GIT_TIMEOUT).await
}

async fn run_git_raw_with_timeout<S: AsRef<str>>(
    repo_dir: &Path,
    args: &[S],
    env: &[(String, String)],
    timeout: Duration,
) -> Result<String, GitError> {
    let full: Vec<String> = args.iter().map(|s| s.as_ref().to_string()).collect();
    let joined = full.join(" ");

    let controller = GIT_PROCESS_CONTROLLER.try_with(Clone::clone).ok();
    if let Some(signal) = controller.as_ref().and_then(ProcessController::requested) {
        return Err(GitError {
            message: format!("git {joined} cancelled by {}", signal.flag()),
        });
    }

    let mut cmd = tokio::process::Command::new("git");
    cmd.args(&full)
        .current_dir(repo_dir)
        .kill_on_drop(true)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        // `continue_rebase`'s "staged changes in your working tree",
        // `resolve_conflicts`'s "CONFLICT", and
        // `force_push_rebased_branch`'s "stale info"/"failed to push some
        // refs" all read git's ENGLISH message text, and git localizes every
        // one of them under a translated system locale. Pin the child's
        // locale so those detectors can't silently miss a known, recoverable
        // condition — same fix as `setup/clone.rs`'s `run_git`.
        .env("LC_ALL", "C");
    for (k, v) in env {
        cmd.env(k, v);
    }

    // The independent watchdog pins the process-group identity even if `git`
    // exits while a credential helper or hook descendant survives with closed
    // stdio. A terminal Git owner therefore proves the complete group is gone,
    // rather than merely proving that the immediate `git` child was reaped.
    let child_lifetime_lock_path = GIT_CHILD_LIFETIME_LOCK_PATH
        .try_with(Clone::clone)
        .unwrap_or_else(|_| {
            repo_dir
                .parent()
                .unwrap_or(repo_dir)
                .join(".decocms")
                .join("child-lifetime.lock")
        });
    let mut child = ProcessGroupChild::spawn(&mut cmd, &child_lifetime_lock_path)
        .await
        .map_err(|e| GitError {
            message: format!("git {joined}: {e}"),
        })?;
    let pid = child.id();
    let process_group = child.control();
    let driven = std::panic::AssertUnwindSafe(async {
        let mut output = Box::pin(child.wait_with_output());

        #[derive(Clone, Copy)]
        enum StopReason {
            Timeout,
            Cancelled(KillSignal),
        }

        let timeout_sleep = tokio::time::sleep(timeout);
        tokio::pin!(timeout_sleep);
        let escalation_sleep = tokio::time::sleep(GIT_TERM_GRACE);
        tokio::pin!(escalation_sleep);
        let reap_warning_sleep = tokio::time::sleep(GIT_KILL_GRACE);
        tokio::pin!(reap_warning_sleep);
        let mut timeout_active = true;
        let mut escalation_active = false;
        let mut reap_warning_active = false;
        let mut observed_signal = None;
        let mut stop_reason = None;

        // Poll the SAME wait future through every signal. Completion means
        // the leader has been wait(2)'d and every inherited output writer is
        // closed. KILL never becomes an early return that could finalize the
        // hidden operation while an SSH/credential helper is still alive.
        let completed = loop {
            tokio::select! {
                completed = output.as_mut() => break completed,
                _ = &mut timeout_sleep, if timeout_active => {
                    timeout_active = false;
                    stop_reason.get_or_insert(StopReason::Timeout);
                    if process_group.signal(KillSignal::Term).await {
                        escalation_sleep.as_mut().reset(
                            tokio::time::Instant::now() + GIT_TERM_GRACE,
                        );
                        escalation_active = true;
                    }
                }
                signal = async {
                    controller
                        .as_ref()
                        .expect("controller branch is guarded")
                        .wait_for_change(observed_signal)
                        .await
                }, if controller.is_some() => {
                    observed_signal = Some(signal);
                    timeout_active = false;
                    stop_reason.get_or_insert(StopReason::Cancelled(signal));
                    if process_group.signal(signal).await {
                        match signal {
                            KillSignal::Term => {
                                escalation_sleep.as_mut().reset(
                                    tokio::time::Instant::now() + GIT_TERM_GRACE,
                                );
                                escalation_active = true;
                            }
                            KillSignal::Kill => {
                                escalation_active = false;
                                reap_warning_sleep.as_mut().reset(
                                    tokio::time::Instant::now() + GIT_KILL_GRACE,
                                );
                                reap_warning_active = true;
                            }
                        }
                    }
                }
                _ = &mut escalation_sleep, if escalation_active => {
                    escalation_active = false;
                    if process_group.signal(KillSignal::Kill).await {
                        reap_warning_sleep.as_mut().reset(
                            tokio::time::Instant::now() + GIT_KILL_GRACE,
                        );
                        reap_warning_active = true;
                    }
                }
                _ = &mut reap_warning_sleep, if reap_warning_active => {
                    reap_warning_active = false;
                    tracing::error!(
                        pid,
                        command = %joined,
                        "git process group has not joined after KILL; continuing to own it"
                    );
                }
            }
        };

        if let Some(reason) = stop_reason {
            return Err(GitError {
                message: match reason {
                    StopReason::Timeout => {
                        format!("git {joined} timed out after {}ms", timeout.as_millis())
                    }
                    StopReason::Cancelled(signal) => {
                        format!("git {joined} cancelled by {}", signal.flag())
                    }
                },
            });
        }

        completed.map_err(|error| GitError {
            message: format!("git {joined}: {error}"),
        })
    })
    .catch_unwind()
    .await;

    let completed = match driven {
        Ok(Ok(completed)) => completed,
        Ok(Err(error)) => {
            // A pipe/read/wait error can end the driver before whole-group
            // quiescence was established. Keep the hidden owner nonterminal
            // until an explicit KILL + anchored reap proves cleanup.
            child
                .kill_and_reap(GIT_KILL_GRACE, "git process-owner error cleanup")
                .await;
            return Err(error);
        }
        Err(_) => {
            // A panic must not turn the hidden task terminal until the anchored
            // process group is completely gone. The deadline is diagnostic;
            // ownership and retries continue beyond it.
            child
                .kill_and_reap(GIT_KILL_GRACE, "git process-owner panic cleanup")
                .await;
            return Err(GitError {
                message: format!("git {joined} process owner panicked after group reap"),
            });
        }
    };

    match completed {
        out if out.status.success() => Ok(String::from_utf8_lossy(&out.stdout).trim().to_string()),
        out => {
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            let code = out
                .status
                .code()
                .map(|c| c.to_string())
                .unwrap_or_else(|| "signal".to_string());
            let suffix = if stderr.is_empty() {
                String::new()
            } else {
                format!(": {stderr}")
            };
            Err(GitError {
                message: format!("git {joined} exited {code}{suffix}"),
            })
        }
    }
}

async fn run_git<S: AsRef<str>>(
    repo_dir: &Path,
    args: &[S],
    env: &[(String, String)],
) -> Result<String, GitError> {
    run_git_raw(repo_dir, args, env).await
}

async fn try_git<S: AsRef<str>>(
    repo_dir: &Path,
    args: &[S],
    env: &[(String, String)],
) -> Option<String> {
    run_git_raw(repo_dir, args, env).await.ok()
}

/// `repo_dir` is created empty at boot (`main.rs`'s `mkdirSync`-equivalent).
/// A probe racing "not a repo yet" would otherwise leak a raw 128 exit as a
/// 500 — every handler above gates on this first via [`require_git_repo`].
/// `pub(crate)`: also used by `setup/clone.rs` to decide clone vs. no-op.
pub(crate) async fn is_git_repo(repo_dir: &Path) -> bool {
    try_git(repo_dir, &["rev-parse", "--git-dir"], &route_env(repo_dir))
        .await
        .is_some()
}

/// Current local branch, or `None` for a non-repository/detached checkout.
/// Setup uses this single probe to fast-path an unchanged sandbox without
/// rerunning checkout and the much heavier branch-divergence snapshot.
/// The remote branch this worktree tracks, without the `origin/` prefix.
///
/// The worktree's LOCAL branch is named after the sandbox handle so two agents
/// can hold the same git branch without colliding (see `setup/clone.rs`), so
/// the local name says nothing about which branch the sandbox is on. The
/// upstream does, and it is the same ref a push targets.
pub(crate) async fn upstream_branch(repo_dir: &Path) -> Option<String> {
    // Read the CONFIG, not `rev-parse --abbrev-ref @{u}`. That resolves the
    // upstream ref and fails outright when it does not exist yet — which is
    // exactly the case for a branch this sandbox just created and has never
    // pushed. The config records the intent regardless.
    let local = current_branch(repo_dir).await?;
    try_git(
        repo_dir,
        &["config", "--get", &format!("branch.{local}.merge")],
        &ceiling_env(repo_dir),
    )
    .await
    .filter(|value| !value.is_empty())
    .map(|value| {
        value
            .strip_prefix("refs/heads/")
            .unwrap_or(&value)
            .to_string()
    })
}

pub(crate) async fn current_branch(repo_dir: &Path) -> Option<String> {
    if let Some(branch) = try_git(
        repo_dir,
        &["rev-parse", "--abbrev-ref", "HEAD"],
        &ceiling_env(repo_dir),
    )
    .await
    .filter(|branch| !branch.is_empty() && branch != "HEAD")
    {
        return Some(branch);
    }
    // `rev-parse --abbrev-ref HEAD` fails identically for a real detached
    // HEAD and an UNBORN one (a checkout with no commits yet — e.g. right
    // after `git worktree add` on a brand-new empty repo). `symbolic-ref`
    // only succeeds for the latter, so it's what disambiguates them.
    try_git(
        repo_dir,
        &["symbolic-ref", "--short", "HEAD"],
        &ceiling_env(repo_dir),
    )
    .await
}

/// Strip ANSI SGR sequences (`ESC[...m`) from git's colorized stderr —
/// byte-parity with `formatGitError`/`stripAnsi` in `routes/git.ts` and
/// `rebase-onto-base.ts`.
fn strip_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' && chars.peek() == Some(&'[') {
            chars.next();
            while matches!(chars.peek(), Some(d) if d.is_ascii_digit() || *d == ';') {
                chars.next();
            }
            if chars.peek() == Some(&'m') {
                chars.next();
            }
            continue;
        }
        out.push(c);
    }
    out
}

// ---------------------------------------------------------------------------
// Route-level errors
// ---------------------------------------------------------------------------

#[derive(Debug)]
enum RouteError {
    InvalidBranchName(String),
    Generic(String),
}

impl std::fmt::Display for RouteError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RouteError::InvalidBranchName(m) | RouteError::Generic(m) => write!(f, "{m}"),
        }
    }
}

impl From<GitError> for RouteError {
    fn from(e: GitError) -> Self {
        RouteError::Generic(e.message)
    }
}

/// `strip`: publish/rebase strip ANSI on the generic 500 path
/// (`formatGitError`); status/diff do not.
fn route_error_response(err: RouteError, strip: bool) -> ApiError {
    match err {
        RouteError::InvalidBranchName(m) => ApiError::bad_request(m),
        RouteError::Generic(m) => ApiError::internal(if strip { strip_ansi(&m) } else { m }),
    }
}

/// Git branch/ref segment safe for `git fetch origin <name>` (no flag
/// injection) — byte-parity with `git/ref-name.ts`. `pub(crate)`: also used
/// by `setup/clone.rs` before a remote-controlled branch name reaches argv.
pub(crate) fn is_valid_remote_branch_name(name: &str) -> bool {
    if name.is_empty() || name.len() > 255 {
        return false;
    }
    if name.contains("..") || name.contains("//") {
        return false;
    }
    if name.starts_with('/') || name.ends_with('/') || name.ends_with(".lock") {
        return false;
    }
    let mut chars = name.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphanumeric() => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || "/._-".contains(c))
}

fn assert_valid_remote_branch_name(name: &str) -> Result<(), RouteError> {
    if is_valid_remote_branch_name(name) {
        Ok(())
    } else {
        Err(RouteError::InvalidBranchName(format!(
            "Invalid base branch name: {name}"
        )))
    }
}

// ---------------------------------------------------------------------------
// Porcelain parsing — byte-parity with `git/porcelain.ts`
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
struct GitStatusFile {
    path: String,
    index: String,
    working_dir: String,
    /// Pre-rename path, present only for R/C entries (`-z` emits it as the
    /// next null-separated field) — byte-parity with
    /// `porcelain.ts::PorcelainFileStatus.origPath`.
    orig_path: Option<String>,
}

fn parse_porcelain_entry(entry: &str) -> Option<(char, char, String)> {
    if entry.len() < 3 {
        return None;
    }
    let bytes = entry.as_bytes();
    let index = bytes[0] as char;
    let working = bytes[1] as char;
    let path = if entry.len() >= 4 && bytes[2] == b' ' {
        &entry[3..]
    } else {
        &entry[2..]
    };
    if path.is_empty() {
        return None;
    }
    Some((index, working, path.to_string()))
}

/// Parses full `git status --porcelain=v1 -z` output. Rename/copy entries
/// (`index` is `R`/`C`) are followed by the original path as a second `-z`
/// segment, captured as `orig_path` — matching `porcelain.ts::parsePorcelainFiles`.
fn parse_porcelain_files(out: &str) -> Vec<GitStatusFile> {
    let parts: Vec<&str> = out.split('\0').collect();
    let mut files = Vec::new();
    let mut i = 0;
    while i < parts.len() {
        let entry = parts[i];
        if !entry.is_empty() {
            if let Some((index, working, path)) = parse_porcelain_entry(entry) {
                let is_rename_or_copy = index == 'R' || index == 'C';
                let mut orig_path = None;
                if is_rename_or_copy {
                    i += 1;
                    orig_path = parts
                        .get(i)
                        .filter(|s| !s.is_empty())
                        .map(|s| s.to_string());
                }
                files.push(GitStatusFile {
                    path,
                    index: index.to_string(),
                    working_dir: working.to_string(),
                    orig_path,
                });
            }
        }
        i += 1;
    }
    files
}

// ---------------------------------------------------------------------------
// Working-tree status + branch divergence
// ---------------------------------------------------------------------------

struct WorkingTreeStatus {
    not_added: Vec<String>,
    conflicted: Vec<String>,
    created: Vec<String>,
    deleted: Vec<String>,
    modified: Vec<String>,
    renamed: Vec<String>,
    files: Vec<GitStatusFile>,
    staged: Vec<String>,
    ahead: i64,
    behind: i64,
    current: Option<String>,
    tracking: Option<String>,
    detached: bool,
}

async fn compute_working_tree_status(repo_dir: &Path) -> Result<WorkingTreeStatus, GitError> {
    let env = route_env(repo_dir);
    let porcelain = run_git(repo_dir, &["status", "--porcelain=v1", "-z"], &env).await?;
    let files = parse_porcelain_files(&porcelain);

    let mut not_added = Vec::new();
    let mut conflicted = Vec::new();
    let mut created = Vec::new();
    let mut deleted = Vec::new();
    let mut modified = Vec::new();
    let mut renamed = Vec::new();
    let mut staged = Vec::new();

    for f in &files {
        let xy = format!("{}{}", f.index, f.working_dir);
        if xy.contains('U') {
            conflicted.push(f.path.clone());
        }
        if f.index == "?" && f.working_dir == "?" {
            not_added.push(f.path.clone());
        } else if f.index == "A" || f.working_dir == "A" {
            created.push(f.path.clone());
        } else if f.index == "D" || f.working_dir == "D" {
            deleted.push(f.path.clone());
        } else if f.index == "R" || f.working_dir == "R" {
            renamed.push(f.path.clone());
        } else {
            modified.push(f.path.clone());
        }
        if f.index != " " && f.index != "?" {
            staged.push(f.path.clone());
        }
    }

    let branch = try_git(repo_dir, &["rev-parse", "--abbrev-ref", "HEAD"], &env).await;
    let detached = branch.as_deref() == Some("HEAD");
    let tracking = try_git(
        repo_dir,
        &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
        &env,
    )
    .await;

    let mut ahead = 0i64;
    let mut behind = 0i64;
    if tracking.is_some() && !detached {
        if let Some(counts) = try_git(
            repo_dir,
            &["rev-list", "--left-right", "--count", "@{upstream}...HEAD"],
            &env,
        )
        .await
        {
            let nums: Vec<i64> = counts
                .split_whitespace()
                .filter_map(|s| s.parse().ok())
                .collect();
            if nums.len() == 2 {
                behind = nums[0];
                ahead = nums[1];
            }
        }
    }

    Ok(WorkingTreeStatus {
        not_added,
        conflicted,
        created,
        deleted,
        modified,
        renamed,
        files,
        staged,
        ahead,
        behind,
        current: branch,
        tracking,
        detached,
    })
}

struct Divergence {
    base: String,
    ahead_of_base: i64,
    behind_base: i64,
    head_sha: String,
    unpushed: i64,
}

/// Divergence vs. the default base branch — byte-parity with
/// `git/branch-divergence.ts::computeBranchDivergence`.
async fn compute_branch_divergence(repo_dir: &Path) -> Divergence {
    let env = ceiling_env(repo_dir);

    let mut base = try_git(
        repo_dir,
        &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
        &env,
    )
    .await
    .unwrap_or_default();
    if let Some(stripped) = base.strip_prefix("origin/") {
        base = stripped.to_string();
    }
    if base.is_empty() {
        base = "main".to_string();
    }

    let branch = try_git(repo_dir, &["rev-parse", "--abbrev-ref", "HEAD"], &env)
        .await
        .unwrap_or_default();
    if branch.is_empty() || branch == "HEAD" {
        let head_sha = try_git(repo_dir, &["rev-parse", "HEAD"], &env)
            .await
            .unwrap_or_default();
        return Divergence {
            base,
            ahead_of_base: 0,
            behind_base: 0,
            head_sha,
            unpushed: 0,
        };
    }

    let remote_branch_ref = format!("origin/{branch}");
    let has_remote_branch = try_git(
        repo_dir,
        &["rev-parse", "--verify", "--quiet", &remote_branch_ref],
        &env,
    )
    .await
    .is_some();
    let branch_ref = if has_remote_branch {
        remote_branch_ref.clone()
    } else {
        "HEAD".to_string()
    };

    let mut ahead_of_base = 0i64;
    let mut behind_base = 0i64;
    let base_remote_ref = format!("origin/{base}");
    if try_git(
        repo_dir,
        &["rev-parse", "--verify", "--quiet", &base_remote_ref],
        &env,
    )
    .await
    .is_some()
    {
        if let Some(lr) = try_git(
            repo_dir,
            &[
                "rev-list",
                "--left-right",
                "--count",
                &format!("{base_remote_ref}...{branch_ref}"),
            ],
            &env,
        )
        .await
        {
            let nums: Vec<i64> = lr
                .split_whitespace()
                .filter_map(|s| s.parse().ok())
                .collect();
            if nums.len() == 2 {
                behind_base = nums[0];
                ahead_of_base = nums[1];
            }
        }
    }

    let unpushed = if has_remote_branch {
        try_git(
            repo_dir,
            &["rev-list", "--count", &format!("{remote_branch_ref}..HEAD")],
            &env,
        )
        .await
        .and_then(|s| s.parse().ok())
        .unwrap_or(0)
    } else {
        ahead_of_base
    };

    let head_sha = try_git(repo_dir, &["rev-parse", &branch_ref], &env)
        .await
        .unwrap_or_default();

    Divergence {
        base,
        ahead_of_base,
        behind_base,
        head_sha,
        unpushed,
    }
}

async fn compute_status(repo_dir: &Path) -> Result<Value, GitError> {
    let working = compute_working_tree_status(repo_dir).await?;
    let divergence = compute_branch_divergence(repo_dir).await;
    Ok(json!({
        "not_added": working.not_added,
        "conflicted": working.conflicted,
        "created": working.created,
        "deleted": working.deleted,
        "modified": working.modified,
        "renamed": working.renamed,
        "files": working.files.iter().map(|f| json!({
            "path": f.path, "index": f.index, "working_dir": f.working_dir,
        })).collect::<Vec<_>>(),
        "staged": working.staged,
        "ahead": working.ahead,
        "behind": working.behind,
        "current": working.current,
        "tracking": working.tracking,
        "detached": working.detached,
        "base": divergence.base,
        "aheadOfBase": divergence.ahead_of_base,
        "behindBase": divergence.behind_base,
        "headSha": divergence.head_sha,
        "unpushed": divergence.unpushed,
    }))
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

async fn read_ref_file(
    repo_dir: &Path,
    ref_: &str,
    path: &str,
    env: &[(String, String)],
) -> Option<String> {
    try_git(repo_dir, &["show", &format!("{ref_}:{path}")], env).await
}

async fn read_working_file(repo_dir: &Path, path: &str) -> Option<String> {
    tokio::fs::read_to_string(repo_dir.join(path)).await.ok()
}

async fn diff_one_file(
    repo_dir: &Path,
    files: &[GitStatusFile],
    path: &str,
    env: &[(String, String)],
) -> Value {
    let file = files.iter().find(|f| f.path == path);
    let index = file.map(|f| f.index.as_str()).unwrap_or(" ");
    let working = file.map(|f| f.working_dir.as_str()).unwrap_or(" ");
    let is_deleted = index == "D" || working == "D";
    let head = read_ref_file(repo_dir, "HEAD", path, env).await;
    let is_new = (index == "?" && working == "?")
        || index == "A"
        || working == "A"
        || (head.is_none() && !is_deleted);

    let from = if is_new { None } else { head };
    let to = if is_deleted {
        None
    } else {
        read_working_file(repo_dir, path).await
    };
    json!({ "from": from, "to": to })
}

/// Uncommitted working-tree diff — byte-parity with `routes/git.ts::computeDiff`.
async fn compute_diff(repo_dir: &Path) -> Result<Value, GitError> {
    let status = compute_working_tree_status(repo_dir).await?;
    let env = route_env(repo_dir);

    let mut seen = HashSet::new();
    let mut paths = Vec::new();
    for f in &status.files {
        if !f.path.is_empty() && seen.insert(f.path.clone()) {
            paths.push(f.path.clone());
        }
    }

    let futs = paths
        .iter()
        .map(|p| diff_one_file(repo_dir, &status.files, p, &env));
    let results = futures::future::join_all(futs).await;

    let mut diffs = serde_json::Map::new();
    for (p, v) in paths.into_iter().zip(results) {
        diffs.insert(p, v);
    }
    Ok(json!({ "diffs": diffs }))
}

fn is_full_sha(s: &str) -> bool {
    s.len() == 40 && s.chars().all(|c| c.is_ascii_hexdigit())
}

async fn list_three_dot_diff_paths(
    repo_dir: &Path,
    env: &[(String, String)],
    left: &str,
    right: &str,
) -> Vec<String> {
    match try_git(
        repo_dir,
        &["diff", "--name-only", "-z", &format!("{left}...{right}")],
        env,
    )
    .await
    {
        Some(out) if !out.is_empty() => out
            .split('\0')
            .filter(|s| !s.is_empty())
            .map(String::from)
            .collect(),
        _ => Vec::new(),
    }
}

/// Committed changes on HEAD since branching from `origin/{base}` (PR
/// scope) — byte-parity with `routes/git.ts::computeDiffAgainstBase`.
async fn compute_diff_against_base(
    repo_dir: &Path,
    base: &str,
    head_sha: Option<&str>,
) -> Result<Value, RouteError> {
    assert_valid_remote_branch_name(base)?;
    let env = route_env(repo_dir);

    let Some(branch) = current_branch(repo_dir).await else {
        return Err(RouteError::Generic(
            "Cannot compute PR diff from detached HEAD".to_string(),
        ));
    };
    assert_valid_remote_branch_name(&branch)?;

    let upstream = format!("origin/{base}");
    let remote_head = format!("origin/{branch}");
    let has_valid_head_sha = head_sha.map(is_full_sha).unwrap_or(false);

    async fn resolve_locally(repo_dir: &Path, env: &[(String, String)], r: &str) -> bool {
        try_git(repo_dir, &["rev-parse", "--verify", r], env)
            .await
            .is_some()
    }

    let can_skip_fetch = has_valid_head_sha
        && resolve_locally(repo_dir, &env, &upstream).await
        && resolve_locally(repo_dir, &env, &format!("{}^{{commit}}", head_sha.unwrap())).await
        && try_git(
            repo_dir,
            &["merge-base", &upstream, head_sha.unwrap()],
            &env,
        )
        .await
        .is_some();

    let head_ref = if can_skip_fetch {
        head_sha.unwrap().to_string()
    } else {
        let _ = run_git(
            repo_dir,
            &["fetch", "--depth", "100", "origin", base, &branch],
            &env,
        )
        .await;
        if has_valid_head_sha {
            let _ = run_git(
                repo_dir,
                &["fetch", "--depth", "100", "origin", head_sha.unwrap()],
                &env,
            )
            .await;
        }
        if !resolve_locally(repo_dir, &env, &upstream).await {
            return Err(RouteError::Generic(format!(
                "Base branch '{base}' not found on origin"
            )));
        }
        if has_valid_head_sha
            && resolve_locally(repo_dir, &env, &format!("{}^{{commit}}", head_sha.unwrap())).await
        {
            head_sha.unwrap().to_string()
        } else if resolve_locally(repo_dir, &env, &remote_head).await {
            remote_head.clone()
        } else {
            "HEAD".to_string()
        }
    };

    let mut paths = list_three_dot_diff_paths(repo_dir, &env, &upstream, &head_ref).await;
    if paths.is_empty() && !can_skip_fetch {
        let _ = run_git(
            repo_dir,
            &["fetch", "--deepen", "500", "origin", base, &branch],
            &env,
        )
        .await;
        paths = list_three_dot_diff_paths(repo_dir, &env, &upstream, &head_ref).await;
    }

    let merge_base = try_git(repo_dir, &["merge-base", &upstream, &head_ref], &env)
        .await
        .unwrap_or_else(|| upstream.clone());

    let futs = paths.iter().map(|p| {
        let merge_base = merge_base.clone();
        let head_ref = head_ref.clone();
        let env = env.clone();
        async move {
            let from = read_ref_file(repo_dir, &merge_base, p, &env).await;
            let to = read_ref_file(repo_dir, &head_ref, p, &env).await;
            (p.clone(), json!({ "from": from, "to": to }))
        }
    });
    let mut diffs = serde_json::Map::new();
    for (p, v) in futures::future::join_all(futs).await {
        diffs.insert(p, v);
    }

    Ok(json!({ "diffs": diffs, "mergeBaseSha": merge_base.trim() }))
}

// ---------------------------------------------------------------------------
// Discard
// ---------------------------------------------------------------------------

/// Pure-lexical `path.resolve`-equivalent (no filesystem access — a new file
/// that doesn't exist yet must still resolve, e.g. for the diff/discard
/// "new file" cases) — byte-parity with `daemon/paths.ts::safePath`'s
/// resolution step.
fn lexical_resolve(base: &Path, user_path: &str) -> PathBuf {
    let user = Path::new(user_path);
    let joined = if user.is_absolute() {
        user.to_path_buf()
    } else {
        base.join(user)
    };
    let mut out: Vec<std::path::Component> = Vec::new();
    for comp in joined.components() {
        match comp {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => match out.last() {
                Some(std::path::Component::Normal(_)) => {
                    out.pop();
                }
                Some(std::path::Component::RootDir) | Some(std::path::Component::Prefix(_)) => {}
                _ => out.push(comp),
            },
            other => out.push(other),
        }
    }
    out.into_iter().collect()
}

/// Resolves `user_path` against `base_dir`, then clamps to `workspace_root`
/// — byte-parity with `daemon/paths.ts::safePath`. Returns `None` on escape.
fn safe_path(workspace_root: &Path, base_dir: &Path, user_path: &str) -> Option<PathBuf> {
    let resolved = lexical_resolve(base_dir, user_path);
    if resolved.strip_prefix(workspace_root).is_ok() {
        Some(resolved)
    } else {
        None
    }
}

/// Byte-parity with `routes/git.ts::resolveRepoRelativePath`: clamps to
/// `app_root` (broad) then requires the result stay inside `repo_dir`
/// (narrow — discard's `filepaths` are relative to the repo, not the
/// workspace root).
fn resolve_repo_relative_path(app_root: &Path, repo_dir: &Path, user_path: &str) -> Option<String> {
    let abs = safe_path(app_root, repo_dir, user_path)?;
    let rel = abs.strip_prefix(repo_dir).ok()?;
    Some(rel.to_string_lossy().replace('\\', "/"))
}

async fn discard_files(
    app_root: &Path,
    repo_dir: &Path,
    filepaths: &[String],
) -> Result<(), String> {
    let mut validated = Vec::with_capacity(filepaths.len());
    for fp in filepaths {
        let rel = resolve_repo_relative_path(app_root, repo_dir, fp)
            .ok_or_else(|| format!("Invalid path: {fp}"))?;
        validated.push(rel);
    }

    let status = compute_working_tree_status(repo_dir)
        .await
        .map_err(|e| e.message)?;
    let env = route_env(repo_dir);

    let mut to_restore = Vec::new();
    let mut to_delete = Vec::new();
    // A renamed file's new path never existed at HEAD, so the `is_new` check
    // below would treat it as untracked and unlink it outright — losing the
    // content entirely, since the original path is already gone from the
    // working tree too. Discarding a rename must instead restore the
    // original file from HEAD and unstage + drop the new path.
    let mut to_restore_from_head = Vec::new();
    let mut renamed_new_paths = Vec::new();
    for fp in &validated {
        if let Some(orig_path) = status
            .files
            .iter()
            .find(|f| &f.path == fp)
            .and_then(|f| f.orig_path.clone())
        {
            to_restore_from_head.push(orig_path);
            renamed_new_paths.push(fp.clone());
            to_delete.push(fp.clone());
            continue;
        }
        let is_new = status.not_added.contains(fp)
            || status.created.contains(fp)
            || read_ref_file(repo_dir, "HEAD", fp, &env).await.is_none();
        if is_new {
            to_delete.push(fp.clone());
        } else {
            to_restore.push(fp.clone());
        }
    }

    if !to_restore_from_head.is_empty() {
        // Unstage the rename's "new path added" side before restoring the
        // original — otherwise it survives in the index even after the
        // working tree file below is deleted.
        let mut reset_args: Vec<String> = vec!["reset".to_string(), "--".to_string()];
        reset_args.extend(renamed_new_paths);
        run_git(repo_dir, &reset_args, &env)
            .await
            .map_err(|e| e.message)?;
        let mut checkout_args: Vec<String> =
            vec!["checkout".to_string(), "HEAD".to_string(), "--".to_string()];
        checkout_args.extend(to_restore_from_head);
        run_git(repo_dir, &checkout_args, &env)
            .await
            .map_err(|e| e.message)?;
    }
    if !to_restore.is_empty() {
        let mut args: Vec<String> = vec!["checkout".to_string(), "--".to_string()];
        args.extend(to_restore);
        run_git(repo_dir, &args, &env)
            .await
            .map_err(|e| e.message)?;
    }
    for fp in &to_delete {
        let _ = tokio::fs::remove_file(repo_dir.join(fp)).await; // best-effort, ignore missing files
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Publish
// ---------------------------------------------------------------------------

/// `core.hooksPath` pointed at an empty dir so publish/rebase commits never
/// run the repo's own lefthook/husky hooks — byte-parity with
/// `getEmptyHooksDir()` in both `routes/git.ts` and `rebase-onto-base.ts`.
fn empty_hooks_dir() -> &'static Path {
    static DIR: OnceLock<PathBuf> = OnceLock::new();
    DIR.get_or_init(|| {
        let dir = std::env::temp_dir().join(format!("local-api-no-hooks-{}", uuid::Uuid::new_v4()));
        let _ = std::fs::create_dir_all(&dir);
        dir
    })
}

async fn resolve_remote_default_branch(repo_dir: &Path) -> String {
    match try_git(
        repo_dir,
        &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
        &ceiling_env(repo_dir),
    )
    .await
    {
        Some(mut base) => {
            if let Some(stripped) = base.strip_prefix("origin/") {
                base = stripped.to_string();
            }
            if base.is_empty() {
                "main".to_string()
            } else {
                base
            }
        }
        None => "main".to_string(),
    }
}

/// Branches a sandbox must never push to directly — byte-parity with
/// `git/protect-branch.ts::protectedBranches`. The daemon also installs a
/// pre-push hook mirroring this list; local-api's `publish()` runs
/// `--no-verify` (see [`push_branch`]) so the hook would be skipped anyway
/// — this in-code guard is the only enforcement, same as the daemon's own
/// comment notes.
async fn protected_branches(repo_dir: &Path) -> HashSet<String> {
    // Lowercased, and compared case-insensitively by `is_protected_branch`:
    // `MAIN` is the same ref as `main` on the case-insensitive volumes macOS
    // ships by default, so a case-sensitive guard is not a guard.
    let mut set: HashSet<String> = crate::sandbox::PROTECTED_BRANCHES
        .iter()
        .map(|branch| branch.to_ascii_lowercase())
        .collect();
    set.insert(
        resolve_remote_default_branch(repo_dir)
            .await
            .to_ascii_lowercase(),
    );
    set
}

/// Whether `branch` may not be pushed to from a sandbox.
async fn is_protected_branch(repo_dir: &Path, branch: &str) -> bool {
    protected_branches(repo_dir)
        .await
        .contains(&branch.to_ascii_lowercase())
}

/// Push `branch` to origin.
///
/// Deliberately does NOT clear `credential.helper`, unlike the cluster daemon
/// it is otherwise byte-parity with. Prod embeds a cluster-minted token in the
/// clone URL and clears the helper so a stale cached credential cannot shadow
/// it; the desktop has no such token — its clone URLs come straight from the
/// agent's `metadata.githubRepo.url` — so clearing the helper left the push
/// with NO credential source at all and every private-repo publish failed,
/// including the shutdown publish that exists to save unsynced work.
///
/// `GIT_TERMINAL_PROMPT=0` + `GIT_ASKPASS=true` still stand: the helper is
/// consulted first, and a repo the user genuinely cannot reach fails fast
/// instead of hanging on a prompt no one can answer.
async fn push_branch(repo_dir: &Path, branch: &str) -> Result<(), GitError> {
    let mut env = route_env(repo_dir);
    env.push(("GIT_TERMINAL_PROMPT".to_string(), "0".to_string()));
    env.push(("GIT_ASKPASS".to_string(), "true".to_string()));
    env.push(("LEFTHOOK".to_string(), "0".to_string()));
    env.push(("HUSKY".to_string(), "0".to_string()));
    // --no-verify: skip native pre-push hooks. A repo's own hook can fail or
    // hang the push, and the shutdown-publish path (which shares this
    // function) has no room to wait it out before SIGKILL drops the unsynced
    // work — byte-parity with `routes/git.ts::pushBranch`.
    run_git(
        repo_dir,
        &["push", "--no-verify", "-u", "origin", branch],
        &env,
    )
    .await?;
    Ok(())
}

/// Byte-parity with `routes/git.ts::publish`. `""` message falls back to
/// "Update from sandbox". Returns `Ok(false)` (not an error) when
/// `repo_dir` isn't a git repo yet — the HTTP route already gates on this,
/// but the shutdown hook calls this directly with no such gate.
async fn publish_internal(repo_dir: &Path, message: &str) -> Result<bool, RouteError> {
    if !is_git_repo(repo_dir).await {
        return Ok(false);
    }

    let Some(branch) = current_branch(repo_dir).await else {
        return Err(RouteError::Generic(
            "Cannot publish from a detached HEAD".to_string(),
        ));
    };

    // The pre-push hook the daemon installs also guards this, but publish
    // runs --no-verify and skips it — the in-code check MUST stand alone.
    if is_protected_branch(repo_dir, &branch).await {
        return Err(RouteError::Generic(format!(
            "Refusing to push to protected branch \"{branch}\" from a sandbox. Work on a feature branch; changes reach the default branch via PR."
        )));
    }

    let env = route_env(repo_dir);
    let status = compute_working_tree_status(repo_dir).await?;
    let paths: Vec<String> = {
        let mut seen = HashSet::new();
        status
            .files
            .iter()
            .map(|f| f.path.clone())
            .filter(|p| !p.is_empty() && seen.insert(p.clone()))
            .collect()
    };
    if !paths.is_empty() {
        let mut args: Vec<String> = vec!["add".to_string(), "--".to_string()];
        args.extend(paths);
        run_git(repo_dir, &args, &env).await?;
    }

    let has_staged_changes = try_git(repo_dir, &["diff", "--cached", "--quiet"], &env)
        .await
        .is_none();
    if has_staged_changes {
        let trimmed = message.trim();
        let commit_msg = if trimmed.is_empty() {
            "Update from sandbox"
        } else {
            trimmed
        };
        let hooks_flag = format!("core.hooksPath={}", empty_hooks_dir().display());
        let mut commit_env = env.clone();
        commit_env.push(("LEFTHOOK".to_string(), "0".to_string()));
        commit_env.push(("HUSKY".to_string(), "0".to_string()));
        run_git(
            repo_dir,
            &["-c", &hooks_flag, "commit", "--no-verify", "-m", commit_msg],
            &commit_env,
        )
        .await?;
    }

    push_branch(repo_dir, &branch).await?;
    Ok(true)
}

// ---------------------------------------------------------------------------
// Rebase
// ---------------------------------------------------------------------------

/// Resolve a path INSIDE this checkout's git directory.
///
/// Every sandbox workdir is created by `git worktree add`, so `.git` is a
/// FILE containing a gitdir pointer, not a directory — the real state lives
/// under `<canonical>/.git/worktrees/<name>/`. Probing `<repo>/.git/<x>`
/// therefore answered "no" for every worktree, which made
/// `is_rebase_in_progress` permanently false (so a conflicted rebase returned
/// an error without aborting, leaving the tree wedged) and
/// `ensure_git_exclude` a permanent no-op (so the tool catalog and its
/// endpoint credential file were staged onto the user's branch).
///
/// `rev-parse --git-path` is the only correct answer: git resolves it against
/// whichever layout this checkout actually has.
pub(crate) async fn git_path(repo_dir: &Path, relative: &str) -> Option<PathBuf> {
    let env = route_env(repo_dir);
    let resolved = try_git(repo_dir, &["rev-parse", "--git-path", relative], &env).await?;
    let resolved = resolved.trim();
    if resolved.is_empty() {
        return None;
    }
    let path = PathBuf::from(resolved);
    Some(if path.is_absolute() {
        path
    } else {
        repo_dir.join(path)
    })
}

async fn is_rebase_in_progress(repo_dir: &Path) -> bool {
    for state_dir in ["rebase-merge", "rebase-apply"] {
        if let Some(path) = git_path(repo_dir, state_dir).await {
            if path.exists() {
                return true;
            }
        }
    }
    false
}

async fn abort_rebase(repo_dir: &Path, env: &[(String, String)]) {
    if is_rebase_in_progress(repo_dir).await {
        let _ = try_git(repo_dir, &["rebase", "--abort"], env).await;
    }
}

async fn commit_before_rebase(repo_dir: &Path, env: &[(String, String)]) -> Result<(), GitError> {
    let porcelain = try_git(repo_dir, &["status", "--porcelain"], env).await;
    let dirty = porcelain
        .as_deref()
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false);
    if !dirty {
        return Ok(());
    }
    run_git(repo_dir, &["add", "."], env).await?;
    let hooks_flag = format!("core.hooksPath={}", empty_hooks_dir().display());
    let mut commit_env = env.to_vec();
    commit_env.push(("LEFTHOOK".to_string(), "0".to_string()));
    commit_env.push(("HUSKY".to_string(), "0".to_string()));
    run_git(
        repo_dir,
        &[
            "-c",
            &hooks_flag,
            "commit",
            "--no-verify",
            "-m",
            "Before rebase",
        ],
        &commit_env,
    )
    .await?;
    Ok(())
}

async fn read_status_files(repo_dir: &Path, env: &[(String, String)]) -> Vec<GitStatusFile> {
    match run_git(repo_dir, &["status", "--porcelain=v1", "-z"], env).await {
        Ok(out) => parse_porcelain_files(&out),
        Err(_) => Vec::new(),
    }
}

async fn get_conflicted_files(repo_dir: &Path, env: &[(String, String)]) -> Vec<String> {
    read_status_files(repo_dir, env)
        .await
        .into_iter()
        .filter(|f| format!("{}{}", f.index, f.working_dir).contains('U'))
        .map(|f| f.path)
        .collect()
}

/// Legacy deco CMS conflict-resolution strategy: prefer the replayed
/// (branch) side — byte-parity with `rebase-onto-base.ts::resolveConflictFile`.
async fn resolve_conflict_file(repo_dir: &Path, env: &[(String, String)], f: &GitStatusFile) {
    let xy = format!("{}{}", f.index, f.working_dir);
    let abs = repo_dir.join(&f.path);

    if xy.contains('U') && (f.index == "D" || f.working_dir == "D") {
        if abs.exists() {
            let _ = run_git(repo_dir, &["add", "--", &f.path], env).await;
        } else {
            let _ = run_git(repo_dir, &["rm", "-f", "--", &f.path], env).await;
        }
        return;
    }
    if f.working_dir == "D" && !xy.contains('U') {
        let _ = run_git(repo_dir, &["rm", "-f", &f.path], env).await;
        return;
    }
    let _ = run_git(repo_dir, &["checkout", "--theirs", "--", &f.path], env).await;
    let _ = run_git(repo_dir, &["add", "--", &f.path], env).await;
}

async fn continue_rebase(repo_dir: &Path, env: &[(String, String)]) -> Result<(), GitError> {
    let mut cenv = env.to_vec();
    cenv.push(("GIT_EDITOR".to_string(), "true".to_string()));
    cenv.push(("EDITOR".to_string(), "true".to_string()));

    match run_git(repo_dir, &["rebase", "--continue"], &cenv).await {
        Ok(_) => Ok(()),
        Err(e) => {
            let message = strip_ansi(&e.message);
            if !message.contains("staged changes in your working tree") {
                return Err(e);
            }
            let hooks_flag = format!("core.hooksPath={}", empty_hooks_dir().display());
            let mut commit_env = cenv.clone();
            commit_env.push(("LEFTHOOK".to_string(), "0".to_string()));
            commit_env.push(("HUSKY".to_string(), "0".to_string()));
            run_git(
                repo_dir,
                &["-c", &hooks_flag, "commit", "--no-edit", "--no-verify"],
                &commit_env,
            )
            .await?;
            if is_rebase_in_progress(repo_dir).await {
                run_git(repo_dir, &["rebase", "--continue"], &cenv).await?;
            }
            Ok(())
        }
    }
}

const MAX_CONFLICT_RESOLUTION_ATTEMPTS: u32 = 50;

/// Iterative port of `rebase-onto-base.ts::resolveConflictsRecursively`
/// (recursion flattened to a loop — Rust async fns can't recurse without
/// boxing every frame, and a loop is equivalent here).
async fn resolve_conflicts(repo_dir: &Path, env: &[(String, String)]) -> Result<(), GitError> {
    let mut attempts_left = MAX_CONFLICT_RESOLUTION_ATTEMPTS;
    loop {
        if attempts_left == 0 {
            abort_rebase(repo_dir, env).await;
            return Err(GitError {
                message: "Rebase conflict resolution exceeded maximum attempts".to_string(),
            });
        }

        let files = read_status_files(repo_dir, env).await;
        for f in files
            .iter()
            .filter(|f| format!("{}{}", f.index, f.working_dir).contains('U'))
        {
            resolve_conflict_file(repo_dir, env, f).await;
        }

        if !get_conflicted_files(repo_dir, env).await.is_empty() {
            abort_rebase(repo_dir, env).await;
            return Err(GitError {
                message: "Unresolved rebase conflicts remain".to_string(),
            });
        }

        match continue_rebase(repo_dir, env).await {
            Ok(()) => return Ok(()),
            Err(e) => {
                let message = strip_ansi(&e.message);
                let remaining = get_conflicted_files(repo_dir, env).await;
                if (!message.contains("CONFLICT")
                    && remaining.is_empty()
                    && !is_rebase_in_progress(repo_dir).await)
                    || remaining.is_empty()
                {
                    abort_rebase(repo_dir, env).await;
                    return Err(e);
                }
                attempts_left -= 1;
            }
        }
    }
}

async fn force_push_rebased_branch(
    repo_dir: &Path,
    branch: &str,
    lease_sha: Option<&str>,
) -> Result<(), GitError> {
    let env = ceiling_env(repo_dir);
    if let Some(lease) = lease_sha {
        let lease_ref = format!("refs/heads/{branch}:{lease}");
        match run_git(
            repo_dir,
            &[
                "push",
                &format!("--force-with-lease={lease_ref}"),
                "origin",
                branch,
            ],
            &env,
        )
        .await
        {
            Ok(_) => return Ok(()),
            Err(e) => {
                let message = strip_ansi(&e.message);
                let retriable =
                    message.contains("stale info") || message.contains("failed to push some refs");
                if !retriable {
                    return Err(e);
                }
                let _ = run_git(repo_dir, &["fetch", "origin", branch], &env).await;
                if let Some(refreshed) = try_git(
                    repo_dir,
                    &[
                        "rev-parse",
                        "--verify",
                        &format!("refs/remotes/origin/{branch}"),
                    ],
                    &env,
                )
                .await
                {
                    let lease_ref2 = format!("refs/heads/{branch}:{refreshed}");
                    run_git(
                        repo_dir,
                        &[
                            "push",
                            &format!("--force-with-lease={lease_ref2}"),
                            "origin",
                            branch,
                        ],
                        &env,
                    )
                    .await?;
                    return Ok(());
                }
            }
        }
    }
    // Fall back to a plain --force when there's no lease SHA to pin against
    // (branch never had a remote-tracking ref) or the lease attempt's
    // refresh-and-retry also raced someone else's push.
    run_git(repo_dir, &["push", "--force", "origin", branch], &env).await?;
    Ok(())
}

/// Byte-parity with `rebase-onto-base.ts::rebaseOntoBase`.
async fn rebase_onto_base(repo_dir: &Path, base: &str) -> Result<(), RouteError> {
    assert_valid_remote_branch_name(base)?;
    let env = ceiling_env(repo_dir);

    let Some(branch) = current_branch(repo_dir).await else {
        return Err(RouteError::Generic(
            "Cannot rebase from a detached HEAD".to_string(),
        ));
    };

    run_git(repo_dir, &["fetch", "-p", "origin", base, &branch], &env)
        .await
        .map_err(RouteError::from)?;
    let lease_sha = try_git(
        repo_dir,
        &[
            "rev-parse",
            "--verify",
            &format!("refs/remotes/origin/{branch}"),
        ],
        &env,
    )
    .await;

    let _ = try_git(
        repo_dir,
        &[
            "submodule",
            "update",
            "--init",
            "--recursive",
            "--depth",
            "1",
        ],
        &env,
    )
    .await;

    let upstream = format!("origin/{base}");
    if try_git(repo_dir, &["rev-parse", "--verify", &upstream], &env)
        .await
        .is_none()
    {
        return Err(RouteError::Generic(format!(
            "Base branch '{base}' not found on origin"
        )));
    }

    commit_before_rebase(repo_dir, &env)
        .await
        .map_err(RouteError::from)?;

    // --autostash: a dev server churning tracked generated files can dirty
    // the tree between commit_before_rebase and the rebase's internal
    // checkout, which would otherwise abort. Autostash stashes that churn,
    // runs the rebase, and restores it after.
    if let Err(e) = run_git(
        repo_dir,
        &["rebase", "--autostash", "-X", "theirs", &upstream],
        &env,
    )
    .await
    {
        if !is_rebase_in_progress(repo_dir).await {
            return Err(RouteError::from(e));
        }
        resolve_conflicts(repo_dir, &env)
            .await
            .map_err(RouteError::from)?;
    }

    if is_rebase_in_progress(repo_dir).await {
        abort_rebase(repo_dir, &env).await;
        return Err(RouteError::Generic("Rebase did not complete".to_string()));
    }

    force_push_rebased_branch(repo_dir, &branch, lease_sha.as_deref())
        .await
        .map_err(RouteError::from)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// "branch" broadcaster event
// ---------------------------------------------------------------------------

/// Fires after a successful publish/discard/rebase (the native module-ownership contract's
/// "Emits" table) — shaped like the daemon's `BranchStatusMonitor`
/// reconnect-snapshot payload. See the module doc for why this is
/// mutation-triggered only, not the daemon's continuous file-watch version.
///
/// Also called from `setup/clone.rs` once a clone/checkout lands (the setup
/// pipeline's equivalent of `orchestrator.stepClone()`'s
/// `branchStatus.refresh()` call) — hence taking `repo_dir`/`broadcaster`
/// directly rather than a full `&AppState` (the setup module constructs its
/// own view of these, not a route-extracted `AppState`).
pub(crate) async fn emit_branch_event(repo_dir: &Path, broadcaster: &crate::events::Broadcaster) {
    let Some(meta) = branch_snapshot(repo_dir).await else {
        return;
    };
    broadcaster.emit("branch", json!({ "meta": meta }));
}

/// Compute the current reconnect/live branch payload for exactly `repo_dir`.
///
/// This is intentionally stateless. Callers must never reuse a snapshot
/// computed for another target: native can have many independently checked-out
/// sandbox branches in one process, and their worktrees survive process
/// restarts even though Rust's in-memory state does not.
pub(crate) async fn branch_snapshot(repo_dir: &Path) -> Option<Value> {
    if !is_git_repo(repo_dir).await {
        return None;
    }

    let dirty = match run_git(
        repo_dir,
        &["status", "--porcelain=v1", "-z"],
        &route_env(repo_dir),
    )
    .await
    {
        Ok(out) => !parse_porcelain_files(&out).is_empty(),
        Err(_) => false,
    };
    let branch = current_branch(repo_dir).await?;
    let divergence = compute_branch_divergence(repo_dir).await;

    Some(json!({
        "kind": "ready",
        "branch": branch,
        "base": divergence.base,
        "workingTreeDirty": dirty,
        "unpushed": divergence.unpushed,
        "aheadOfBase": divergence.ahead_of_base,
        "behindBase": divergence.behind_base,
        "headSha": divergence.head_sha,
    }))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;
    use std::sync::Arc;
    use tempfile::TempDir;

    // -- pure logic, no git process ------------------------------------------

    #[test]
    fn parses_simple_porcelain_entries() {
        let raw = "?? untracked.txt\0 M modified.txt\0";
        let files = parse_porcelain_files(raw);
        assert_eq!(files.len(), 2);
        assert_eq!(
            files[0],
            GitStatusFile {
                path: "untracked.txt".into(),
                index: "?".into(),
                working_dir: "?".into(),
                orig_path: None
            }
        );
        assert_eq!(
            files[1],
            GitStatusFile {
                path: "modified.txt".into(),
                index: " ".into(),
                working_dir: "M".into(),
                orig_path: None
            }
        );
    }

    #[test]
    fn parses_rename_entry_consuming_orig_path() {
        let raw = "R  new.txt\0old.txt\0M  other.txt\0";
        let files = parse_porcelain_files(raw);
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].path, "new.txt");
        assert_eq!(files[0].index, "R");
        assert_eq!(files[0].orig_path.as_deref(), Some("old.txt"));
        assert_eq!(files[1].path, "other.txt");
        assert_eq!(files[1].orig_path, None);
    }

    #[test]
    fn strip_ansi_removes_sgr_sequences() {
        let colored = "\u{1b}[31merror\u{1b}[0m: bad";
        assert_eq!(strip_ansi(colored), "error: bad");
    }

    #[test]
    fn valid_branch_names_accepted() {
        assert!(is_valid_remote_branch_name("main"));
        assert!(is_valid_remote_branch_name("feature/x-1.2"));
    }

    #[test]
    fn invalid_branch_names_rejected() {
        assert!(!is_valid_remote_branch_name(""));
        assert!(!is_valid_remote_branch_name("../etc"));
        assert!(!is_valid_remote_branch_name("/leading"));
        assert!(!is_valid_remote_branch_name("trailing/"));
        assert!(!is_valid_remote_branch_name("name.lock"));
        assert!(!is_valid_remote_branch_name("has space"));
        assert!(!is_valid_remote_branch_name("-flag-looking"));
    }

    #[test]
    fn safe_path_allows_paths_inside_root() {
        let root = Path::new("/workspace");
        let base = Path::new("/workspace/repo");
        let resolved = safe_path(root, base, "foo/bar.txt").unwrap();
        assert_eq!(resolved, Path::new("/workspace/repo/foo/bar.txt"));
    }

    #[test]
    fn safe_path_rejects_escape() {
        let root = Path::new("/workspace/repo");
        let base = Path::new("/workspace/repo");
        assert!(safe_path(root, base, "../../etc/passwd").is_none());
    }

    #[test]
    fn resolve_repo_relative_path_rejects_escape() {
        let app_root = Path::new("/workspace");
        let repo_dir = Path::new("/workspace/repo");
        assert!(resolve_repo_relative_path(app_root, repo_dir, "../outside.txt").is_none());
        assert_eq!(
            resolve_repo_relative_path(app_root, repo_dir, "nested/file.txt").unwrap(),
            "nested/file.txt"
        );
    }

    #[tokio::test]
    async fn detached_git_owner_releases_admission_but_stays_registry_owned() {
        let root = TempDir::new().unwrap();
        let state = test_app_state(root.path());
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let release = Arc::new(tokio::sync::Notify::new());
        let operation_release = release.clone();
        let caller_state = state.clone();
        let caller = tokio::spawn(async move {
            run_owned_git_route(caller_state, "git ownership test", async move {
                let _ = started_tx.send(());
                operation_release.notified().await;
                Ok::<(), ApiError>(())
            })
            .await
        });

        started_rx.await.expect("git owner acquired admission");
        caller.abort();
        let _ = caller.await;

        tokio::time::timeout(Duration::from_secs(1), state.shutdown.begin_shutdown())
            .await
            .expect("admission covers only registration, not the full operation");

        let sweep = state
            .tasks
            .kill_all_and_wait(Duration::ZERO, Duration::ZERO)
            .await;
        assert_eq!(sweep.initially_running, 1);
        assert_eq!(sweep.remaining.len(), 1);
        assert!(sweep.remaining[0].starts_with("internal-git-"));

        release.notify_waiters();
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if state
                    .tasks
                    .kill_all_and_wait(Duration::ZERO, Duration::ZERO)
                    .await
                    .initially_running
                    == 0
                {
                    return;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("detached owner finalized after its operation completed");
    }

    #[tokio::test]
    async fn git_route_rejects_work_after_shutdown_admission_closes() {
        let root = TempDir::new().unwrap();
        let state = test_app_state(root.path());
        state.shutdown.begin_shutdown().await;
        let ran = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let operation_ran = ran.clone();
        let error = run_owned_git_route(state, "git rejected test", async move {
            operation_ran.store(true, std::sync::atomic::Ordering::SeqCst);
            Ok::<(), ApiError>(())
        })
        .await
        .expect_err("closed admission rejects git work");

        assert_eq!(error.status, StatusCode::SERVICE_UNAVAILABLE);
        assert!(!ran.load(std::sync::atomic::Ordering::SeqCst));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn slow_git_group_is_term_kill_reaped_before_owner_finalizes() {
        use std::os::unix::fs::PermissionsExt;

        let root = TempDir::new().unwrap();
        let state = test_app_state(root.path());
        let bin_dir = root.path().join("bin");
        std::fs::create_dir_all(&bin_dir).unwrap();
        let script = bin_dir.join("git");
        std::fs::write(
            &script,
            "#!/bin/sh\n\
             trap '' TERM\n\
             printf '%s\\n' \"$$\" > \"$GIT_TEST_PID_FILE\"\n\
             /bin/sleep 30 &\n\
             printf '%s\\n' \"$!\" > \"$GIT_TEST_CHILD_PID_FILE\"\n\
             wait\n",
        )
        .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let pid_file = root.path().join("git.pid");
        let child_pid_file = root.path().join("git-child.pid");
        let env = vec![
            ("PATH".to_string(), bin_dir.to_string_lossy().into_owned()),
            (
                "GIT_TEST_PID_FILE".to_string(),
                pid_file.to_string_lossy().into_owned(),
            ),
            (
                "GIT_TEST_CHILD_PID_FILE".to_string(),
                child_pid_file.to_string_lossy().into_owned(),
            ),
        ];
        let workdir = root.path().to_path_buf();
        let caller_state = state.clone();
        let caller = tokio::spawn(async move {
            run_owned_git_route(caller_state, "slow git test", async move {
                run_git_raw_with_timeout(&workdir, &["status"], &env, Duration::from_secs(30))
                    .await
                    .map(|_| ())
                    .map_err(|error| ApiError::internal(error.message))
            })
            .await
        });

        let pid = wait_for_pid_file(&pid_file).await;
        let child_pid = wait_for_pid_file(&child_pid_file).await;
        let sweep = state
            .tasks
            .kill_all_and_wait(Duration::from_millis(40), Duration::from_secs(2))
            .await;
        assert_eq!(sweep.initially_running, 1);
        assert_eq!(sweep.term_signaled, 1);
        assert_eq!(sweep.kill_signaled, 1);
        assert!(sweep.remaining.is_empty());

        let error = tokio::time::timeout(Duration::from_secs(1), caller)
            .await
            .expect("route owner joined after KILL")
            .expect("route waiter task joined")
            .expect_err("cancellation is returned to a still-connected caller");
        assert!(error.body["error"]
            .as_str()
            .is_some_and(|message| message.contains("cancelled")));
        assert_process_group_gone(pid).await;
        assert_process_gone(child_pid).await;
    }

    #[cfg(unix)]
    async fn wait_for_pid_file(path: &Path) -> u32 {
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if let Ok(contents) = tokio::fs::read_to_string(path).await {
                    if let Ok(pid) = contents.trim().parse() {
                        return pid;
                    }
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("fake git wrote its pid file")
    }

    /// Any process still in the group led by `pgid`. `pgrep` exits 1 for "no
    /// match", which is the empty-group answer on both platforms.
    #[cfg(unix)]
    fn process_group_exists(pgid: u32) -> bool {
        Command::new("pgrep")
            .args(["-g", &pgid.to_string(), "."])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
    }

    #[cfg(unix)]
    fn process_exists(pid_arg: String) -> bool {
        Command::new("kill")
            .args(["-0", &pid_arg])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
    }

    /// The budget has to clear the anchor's own escalation, not just "a
    /// moment": it runs up to 20 TERM rounds at 50ms — a full second — before
    /// it starts KILL rounds at all. A 1s deadline was therefore exactly the
    /// escalation time, which macOS won and Linux lost.
    /// Group liveness goes through `pgrep -g`, NOT `kill -0 -<pgid>`.
    /// procps-ng `kill(1)` issues the right syscall for a negative pid and
    /// then reports the opposite answer: verified under strace, a live group
    /// gives `kill(-N, 0) = 0` then `exit(1)`, and a dead one gives `ESRCH`
    /// then `exit(0)`. Reading its status therefore inverts the test on Linux
    /// — it waits forever on a group that is already gone. BSD `kill` reports
    /// it correctly, which is why only Linux ever saw this.
    #[cfg(unix)]
    async fn assert_process_group_gone(pid: u32) {
        tokio::time::timeout(Duration::from_secs(15), async {
            while process_group_exists(pid) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("Git process group was still alive after owner finalization");
    }

    #[cfg(unix)]
    async fn assert_process_gone(pid: u32) {
        tokio::time::timeout(Duration::from_secs(15), async {
            while process_exists(pid.to_string()) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("Git descendant was still alive after owner finalization");
    }

    // -- real git repo integration tests -------------------------------------

    fn git(dir: &Path, args: &[&str]) {
        let output = Command::new("git")
            .args(args)
            .current_dir(dir)
            .output()
            .expect("git failed to spawn");
        assert!(
            output.status.success(),
            "git {args:?} failed in {dir:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    /// Bare "origin" + a working clone on a feature branch — local-api has no
    /// clone pipeline, so tests lay the repo out directly on disk the way a
    /// real user's existing project would already be, mirroring the daemon
    /// e2e harness's `setupBareRepo()` + clone-onto-branch flow.
    struct TestRepo {
        root: TempDir,
        bare_dir: PathBuf,
        work_dir: PathBuf,
    }

    fn setup_repo() -> TestRepo {
        let root = TempDir::new().unwrap();
        let bare_dir = root.path().join("origin.git");
        let work_dir = root.path().join("repo");
        std::fs::create_dir_all(&bare_dir).unwrap();
        std::fs::create_dir_all(&work_dir).unwrap();
        git(&bare_dir, &["init", "--bare", "-q"]);
        git(&work_dir, &["init", "-q", "-b", "main"]);
        git(&work_dir, &["config", "user.name", "Test User"]);
        git(&work_dir, &["config", "user.email", "test@example.com"]);
        std::fs::write(work_dir.join("README.md"), "hello\n").unwrap();
        git(&work_dir, &["add", "."]);
        git(&work_dir, &["commit", "-q", "-m", "initial"]);
        let bare_str = bare_dir.to_str().unwrap();
        git(&work_dir, &["remote", "add", "origin", bare_str]);
        git(&work_dir, &["push", "-q", "-u", "origin", "main"]);
        // Point the bare repo's HEAD symref at `main` — `git init --bare`
        // leaves it on whatever `init.defaultBranch` the host git is
        // configured with (often still `master`), which would otherwise
        // leave a fresh `git clone` of this bare repo with no local branch
        // checked out (`HEAD` referring to a ref that was never pushed).
        git(&bare_dir, &["symbolic-ref", "HEAD", "refs/heads/main"]);
        git(&work_dir, &["fetch", "-q", "origin"]);
        git(&work_dir, &["checkout", "-q", "-b", "sandbox-work"]);
        TestRepo {
            root,
            bare_dir,
            work_dir,
        }
    }

    /// Builds a full `AppState` rooted at `dir` (both `app_root`/`repo_dir`
    /// point at the same directory) for tests that do not materialize a
    /// per-handle sandbox.
    fn test_app_state(dir: &Path) -> AppState {
        let (app_root, repo_dir) = (dir, dir);
        let config = std::sync::Arc::new(crate::config::ConfigStore::new());
        let logs = std::sync::Arc::new(crate::log_store::LogStore::new(app_root.join("logs")));
        let tasks = std::sync::Arc::new(crate::tasks::TaskRegistry::new(logs));
        let broadcaster = std::sync::Arc::new(crate::events::Broadcaster::new());
        let setup = crate::setup::SetupOrchestrator::new(
            repo_dir.to_path_buf(),
            repo_dir.to_path_buf(),
            config.clone(),
            tasks.clone(),
            broadcaster.clone(),
        );
        AppState {
            update: None,
            token: "test-token".into(),
            boot_id: "test-boot".into(),
            sandbox_manager: crate::sandbox::SandboxManager::new(app_root.to_path_buf()),
            agent_sessions: crate::terminal::AgentSessionRegistry::new(),
            app_root: app_root.to_path_buf(),
            repo_dir: repo_dir.to_path_buf(),
            mode: crate::state::ApiMode::Strict,
            config,
            tasks,
            broadcaster,
            shutdown: std::sync::Arc::new(crate::shutdown::ShutdownCoordinator::new()),
            setup,
        }
    }

    fn remote_has_branch(bare_dir: &Path, branch: &str) -> bool {
        let out = Command::new("git")
            .args([
                "ls-remote",
                bare_dir.to_str().unwrap(),
                &format!("refs/heads/{branch}"),
            ])
            .output()
            .unwrap();
        !String::from_utf8_lossy(&out.stdout).trim().is_empty()
    }

    #[tokio::test]
    async fn status_reports_current_branch() {
        let repo = setup_repo();
        let status = compute_status(&repo.work_dir).await.unwrap();
        assert_eq!(status["current"], "sandbox-work");
        assert_eq!(status["detached"], false);
        assert!(status["files"].as_array().unwrap().is_empty());
    }

    #[tokio::test]
    async fn is_git_repo_false_before_init() {
        let root = TempDir::new().unwrap();
        let repo_dir = root.path().join("not-a-repo");
        std::fs::create_dir_all(&repo_dir).unwrap();
        assert!(!is_git_repo(&repo_dir).await);
    }

    /// `rev-parse --abbrev-ref HEAD` fails identically for a real detached
    /// HEAD and an unborn one (no commits yet — e.g. right after `git
    /// worktree add` on a brand-new empty repo). `current_branch` must not
    /// conflate the two: a fresh `git init -b main` with zero commits is on
    /// branch `main`, not detached.
    #[tokio::test]
    async fn current_branch_resolves_an_unborn_head_instead_of_reporting_detached() {
        let root = TempDir::new().unwrap();
        let repo_dir = root.path().join("repo");
        std::fs::create_dir_all(&repo_dir).unwrap();
        git(&repo_dir, &["init", "-q", "-b", "main"]);

        assert_eq!(current_branch(&repo_dir).await.as_deref(), Some("main"));
    }

    #[tokio::test]
    async fn diff_surfaces_uncommitted_new_file() {
        let repo = setup_repo();
        std::fs::write(repo.work_dir.join("new-file.txt"), "fresh\n").unwrap();
        let result = compute_diff(&repo.work_dir).await.unwrap();
        let diffs = result["diffs"].as_object().unwrap();
        assert!(diffs.contains_key("new-file.txt"));
        assert!(diffs["new-file.txt"]["from"].is_null());
        assert_eq!(diffs["new-file.txt"]["to"], "fresh\n");
    }

    #[tokio::test]
    async fn discard_removes_untracked_file() {
        let repo = setup_repo();
        std::fs::write(repo.work_dir.join("scratch.txt"), "discard me\n").unwrap();
        discard_files(&repo.work_dir, &repo.work_dir, &["scratch.txt".to_string()])
            .await
            .unwrap();
        assert!(!repo.work_dir.join("scratch.txt").exists());
    }

    #[tokio::test]
    async fn discard_restores_modified_tracked_file() {
        let repo = setup_repo();
        std::fs::write(repo.work_dir.join("README.md"), "changed\n").unwrap();
        discard_files(&repo.work_dir, &repo.work_dir, &["README.md".to_string()])
            .await
            .unwrap();
        assert_eq!(
            std::fs::read_to_string(repo.work_dir.join("README.md")).unwrap(),
            "hello\n"
        );
    }

    #[tokio::test]
    async fn discard_restores_renamed_file_instead_of_deleting_it() {
        let repo = setup_repo();
        std::fs::rename(
            repo.work_dir.join("README.md"),
            repo.work_dir.join("RENAMED.md"),
        )
        .unwrap();
        git(&repo.work_dir, &["add", "-A"]);
        discard_files(&repo.work_dir, &repo.work_dir, &["RENAMED.md".to_string()])
            .await
            .unwrap();
        assert!(
            !repo.work_dir.join("RENAMED.md").exists(),
            "renamed path must not survive discard"
        );
        assert_eq!(
            std::fs::read_to_string(repo.work_dir.join("README.md")).unwrap(),
            "hello\n",
            "original content must be restored from HEAD, not lost"
        );
        let status = compute_working_tree_status(&repo.work_dir).await.unwrap();
        assert!(status.files.is_empty(), "discard must leave a clean tree");
    }

    #[tokio::test]
    async fn discard_rejects_escaping_path() {
        let repo = setup_repo();
        let err = discard_files(
            &repo.work_dir,
            &repo.work_dir,
            &["../outside.txt".to_string()],
        )
        .await
        .unwrap_err();
        assert!(err.contains("Invalid path"));
    }

    #[tokio::test]
    async fn publish_commits_and_pushes() {
        let repo = setup_repo();
        std::fs::write(repo.work_dir.join("published.txt"), "ship it\n").unwrap();
        let pushed = publish_internal(&repo.work_dir, "test publish")
            .await
            .unwrap();
        assert!(pushed);
        assert!(remote_has_branch(&repo.bare_dir, "sandbox-work"));
    }

    #[tokio::test]
    async fn publish_pushes_past_failing_pre_push_hook() {
        let repo = setup_repo();
        let hooks_dir = repo.work_dir.join(".git").join("hooks");
        std::fs::create_dir_all(&hooks_dir).unwrap();
        let hook_path = hooks_dir.join("pre-push");
        std::fs::write(&hook_path, "#!/bin/sh\nexit 1\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&hook_path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }

        std::fs::write(repo.work_dir.join("past-hook.txt"), "survived the hook\n").unwrap();
        let pushed = publish_internal(&repo.work_dir, "publish past a failing hook")
            .await
            .unwrap();
        assert!(pushed);
        assert!(remote_has_branch(&repo.bare_dir, "sandbox-work"));
    }

    #[tokio::test]
    async fn publish_refuses_protected_branch() {
        let repo = setup_repo();
        git(&repo.work_dir, &["checkout", "-q", "main"]);
        std::fs::write(repo.work_dir.join("oops.txt"), "nope\n").unwrap();
        let err = publish_internal(&repo.work_dir, "should be refused")
            .await
            .unwrap_err();
        assert!(err.to_string().contains("protected branch"));
    }

    #[tokio::test]
    async fn rebase_onto_base_rebases_and_force_pushes() {
        let repo = setup_repo();

        // `rebaseOntoBase`'s leading `git fetch -p origin <base> <branch>`
        // requires `<branch>` (the CURRENT branch) to already exist on
        // origin — byte-parity with `rebase-onto-base.ts`, which has the
        // exact same requirement. A branch that was never published yet
        // (this repo's `sandbox-work` right after `setup_repo()`) makes that
        // fetch fail with "couldn't find remote ref sandbox-work" before
        // rebase logic proper even starts, so publish once first to seed it.
        git(
            &repo.work_dir,
            &["push", "-q", "-u", "origin", "sandbox-work"],
        );

        // Advance origin/main from a second clone.
        let other = repo.root.path().join("other-clone");
        git(
            repo.root.path(),
            &[
                "clone",
                "-q",
                repo.bare_dir.to_str().unwrap(),
                other.to_str().unwrap(),
            ],
        );
        git(&other, &["config", "user.name", "Other"]);
        git(&other, &["config", "user.email", "other@example.com"]);
        std::fs::write(other.join("base-change.txt"), "base\n").unwrap();
        git(&other, &["add", "."]);
        git(&other, &["commit", "-q", "-m", "advance base"]);
        git(&other, &["push", "-q", "origin", "main"]);

        // sandbox-work gets its own commit before rebasing.
        std::fs::write(repo.work_dir.join("feature.txt"), "feature\n").unwrap();
        git(&repo.work_dir, &["add", "."]);
        git(&repo.work_dir, &["commit", "-q", "-m", "feature work"]);

        let result = rebase_onto_base(&repo.work_dir, "main").await;
        assert!(result.is_ok(), "{:?}", result.err().map(|e| e.to_string()));

        assert!(repo.work_dir.join("feature.txt").exists());
        assert!(repo.work_dir.join("base-change.txt").exists());
        assert!(remote_has_branch(&repo.bare_dir, "sandbox-work"));
    }

    /// A `base` that's a syntactically valid ref but doesn't exist on origin
    /// fails at the leading `git fetch -p origin <base> <branch>` step
    /// (`fatal: couldn't find remote ref <base>`, exit 128) before
    /// `rebaseOntoBase`'s own friendlier "Base branch '<base>' not found on
    /// origin" check is ever reached — that check only guards a narrower
    /// case (base resolves locally as `origin/HEAD`-adjacent but the
    /// specific `origin/<base>` ref is still missing after the fetch
    /// succeeds). Byte-parity: `rebase-onto-base.ts` has the exact same
    /// ordering, so the daemon surfaces the same raw git error here too —
    /// this isn't a Rust-port bug, it's the upstream behavior.
    #[tokio::test]
    async fn rebase_missing_base_on_origin_is_an_error() {
        let repo = setup_repo();
        let err = rebase_onto_base(&repo.work_dir, "does-not-exist")
            .await
            .unwrap_err();
        assert!(err.to_string().contains("does-not-exist"));
    }

    #[tokio::test]
    async fn rebase_rejects_invalid_branch_name() {
        let repo = setup_repo();
        let err = rebase_onto_base(&repo.work_dir, "../escape")
            .await
            .unwrap_err();
        assert!(matches!(err, RouteError::InvalidBranchName(_)));
    }

    #[tokio::test]
    async fn branch_event_emitted_after_publish() {
        let repo = setup_repo();
        std::fs::write(repo.work_dir.join("evented.txt"), "x\n").unwrap();

        let state = test_app_state(&repo.work_dir);
        let mut rx = state.broadcaster.subscribe();

        let pushed = publish_internal(&state.repo_dir, "evented publish")
            .await
            .unwrap();
        assert!(pushed);
        emit_branch_event(&state.repo_dir, &state.broadcaster).await;

        let evt = rx.recv().await.expect("branch event delivered");
        assert_eq!(evt.name, "branch");
        assert_eq!(evt.data["meta"]["kind"], "ready");
        assert_eq!(evt.data["meta"]["branch"], "sandbox-work");
        assert_eq!(evt.data["meta"]["workingTreeDirty"], false);
    }
}
