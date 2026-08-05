//! Clone / branch-checkout step of the setup pipeline. Byte-parity target:
//! `daemon/setup/clone.ts` + `daemon/git/checkout-branch.ts` +
//! `daemon/setup/identity.ts`, exercised via `daemon.git.e2e.test.ts`'s
//! `describe("git (cloned repo)")` and `daemon.sse-shapes.e2e.test.ts`'s
//! lifecycle/branch/scripts + reload specs (both bootstrap via
//! `bootstrapRepo()` -> `POST /_sandbox/config`).
//!
//! Deliberately narrower than the TS source: no retry-on-transient-network-
//! error loop (`clone.ts`'s `CLONE_MAX_RETRIES`/`isTransient` — retries a
//! handful of specific curl/libgit2 network error strings), no deferred
//! base-branch fetch (`fetchBaseBranch` — purely a divergence-header nicety),
//! no `askpass` script materialization (uses the `true` utility directly,
//! the same convention `routes/git.rs::push_branch` already established for
//! this crate). `file://` clones (the only kind either e2e suite exercises)
//! don't hit any of those paths in the TS source either — they're
//! network-only concerns.
//!
//! ## Streaming (fixes the clone-output regression)
//!
//! Every `git` subprocess this file spawns is now piped and STREAMED —
//! chunks flow into [`crate::log_store::LogStore`] (the `"setup"` source, same
//! combined transcript `setup/install.rs` writes into) and a live
//! `"log"` broadcaster frame, exactly like `install.rs`'s own streaming
//! helper (`run_install_cmd`) — via `TaskRegistry::append_log`, so both
//! files share ONE code path rather than two. Previously `run_git` used
//! `Command::output()`, which buffers the WHOLE process's stdout/stderr in
//! memory and hands it back only after exit — no `"log"` frame was ever
//! emitted and no task was ever registered, so a clone in progress was
//! invisible to `/_sandbox/events` and `/_sandbox/tasks` alike (the
//! confirmed regression this file's rewrite fixes).
//!
//! `clone_fresh`/`checkout_existing` each register ONE `TaskRegistry` entry
//! (`log_name: "setup"`) spanning every `git` subcommand they run — mirrors
//! `install.rs`'s "one task per logical step" convention rather than one
//! per subprocess, so `/_sandbox/tasks` shows one legible "clone"/"checkout"
//! entry instead of a handful of sub-second ones. Marker lines (`"$ git
//! ..."`, `"[worktree] ..."`) are
//! interleaved into the SAME `"setup"` transcript alongside real subprocess
//! output — byte-parity in spirit with the old daemon's
//! `setup/orchestrator.ts`, which funnels clone + install + its own control
//! messages into one `"setup"` replay-buffer key (see that file's `chunk`/
//! `rawChunk` helpers). A genuinely FRESH clone (`clone_fresh`, not a
//! re-checkout on an already-cloned repo) truncates the `"setup"` transcript
//! first — byte-parity in spirit with `unlinkSync(cloneLogPath)` before
//! opening a new clone tee in the old source; see [`crate::log_store::LogStore::truncate`].

use std::path::Path;
use std::sync::Arc;

use serde_json::{json, Value};
use tokio::io::AsyncReadExt;

use super::SetupOrchestrator;
use crate::log_store::app_key;
use crate::process_group::ProcessGroupChild;
use crate::process_util::{classify_status, exit_status_to_code};
use crate::routes::git::{
    current_branch, emit_branch_event, is_git_repo, is_valid_remote_branch_name, upstream_branch,
};
use crate::tasks::{
    now_ms, KillSignal, OutputStream, ProcessController, TaskEntry, TaskStatus, TaskSummary,
};

/// `-c safe.directory=* -c http.connectTimeout=10 -c http.lowSpeedLimit=1 -c
/// http.lowSpeedTime=10` — byte-parity with `setup/git-command.ts::gitBaseArgv`
/// EXCEPT for one deliberate omission: the TS source also sets `-c
/// credential.helper=` (disables the user's credential helper), because prod
/// authenticates via a cluster-minted token already embedded in `cloneUrl`
/// (`x-access-token:TOKEN@github.com/...`) and never wants a stale cached
/// credential to shadow it. Desktop has no cluster-minted token — per
/// the native Git-sandbox contract's "Desktop adaptation" section,
/// the user is on their OWN machine with their OWN git auth, so cloning
/// should use exactly what `git clone` would do run by hand: the user's
/// configured credential helper (for example macOS Keychain, or `gh` after
/// `gh auth setup-git`). An SSH agent only participates when the configured
/// `cloneUrl` itself uses SSH; Git does not switch an HTTPS URL to SSH based on
/// the protocol selected in `gh auth login`.
/// Clearing `credential.helper` here would silently break every private
/// repo a desktop user can otherwise already clone from a terminal with the
/// same URL.
/// `GIT_TERMINAL_PROMPT=0` (below, in [`run_git`]) still applies regardless,
/// so a repo the user's credentials genuinely can't reach fails fast rather
/// than hanging on an interactive prompt.
fn base_argv() -> Vec<&'static str> {
    vec![
        "-c",
        "safe.directory=*",
        "-c",
        "http.connectTimeout=10",
        "-c",
        "http.lowSpeedLimit=1",
        "-c",
        "http.lowSpeedTime=10",
    ]
}

/// Appends `text` to the `"setup"` transcript — this task's own per-task
/// file (`TaskRegistry::append_log`) when `task_id` is `Some` (the git
/// subcommand belongs to a registered, observable step), OR just the
/// combined `"app/setup"` file + a live broadcast when `task_id` is `None`
/// (a quick, untracked probe — `configure_git_identity`'s `git config`
/// calls have no natural "step" to attribute to). Either way the SAME
/// `"setup"` source/transcript is fed, so replay always reads one coherent
/// interleaved history regardless of which git calls were task-tracked.
async fn emit_chunk(
    orch: &Arc<SetupOrchestrator>,
    task_id: Option<&str>,
    stream: OutputStream,
    text: &str,
) {
    if text.is_empty() {
        return;
    }
    match task_id {
        Some(id) => {
            orch.tasks
                .append_log(id, "setup", stream, text, &orch.broadcaster)
                .await;
        }
        None => {
            orch.tasks.logs().append(&app_key("setup"), text).await;
            orch.broadcaster
                .emit("log", json!({ "source": "setup", "data": text }));
        }
    }
}

/// `GIT_TERMINAL_PROMPT=0` + a real no-op askpass — byte-parity in spirit
/// with `setup/git-command.ts::gitStepEnv` (which materializes a script;
/// this crate reuses the `true` utility already on every POSIX `$PATH`, same
/// as `routes/git.rs::push_branch`'s `GIT_ASKPASS=true`).
///
/// Streams stdout/stderr as they arrive (piped spawn, not
/// `Command::output()`) — chunks flow through [`emit_chunk`] as each read
/// resolves, so a caller subscribed to `/_sandbox/events` sees clone/checkout
/// progress live instead of only after the whole command exits. Still
/// returns the combined text (for a caller's failure-message construction) —
/// `Ok((exit_code, combined_stdout_and_stderr))`; `Err` only for a spawn
/// failure, never a nonzero exit.
async fn run_git(
    orch: &Arc<SetupOrchestrator>,
    task_id: Option<&str>,
    args: &[&str],
    cwd: Option<&Path>,
    controller: Option<&ProcessController>,
) -> Result<(i32, String), String> {
    let mut full = base_argv();
    full.extend_from_slice(args);

    if let Some(signal) = controller.and_then(ProcessController::requested) {
        return Ok((signal.exit_code(), "cancelled before spawn".to_string()));
    }

    emit_chunk(
        orch,
        task_id,
        OutputStream::Stdout,
        &format!("$ git {}\r\n", full.join(" ")),
    )
    .await;

    let mut cmd = tokio::process::Command::new("git");
    cmd.args(&full)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_ASKPASS", "true")
        // Every matcher in this file — `ref_format_unsupported`,
        // `refetch_after_case_collision`, clone_fresh_body's
        // "already used by worktree" family — reads git's ENGLISH message
        // text, and git localizes all of them. Pin the child's locale so a
        // translated system can't blind the detectors into skipping a
        // fallback (fresh clones hard-failing on a pre-reftable localized
        // git) or a migration.
        .env("LC_ALL", "C")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    if let Some(cwd) = cwd {
        cmd.current_dir(cwd);
    }
    let mut child = ProcessGroupChild::spawn(&mut cmd, orch.tasks.child_lifetime_lock_path())
        .await
        .map_err(|e| format!("git {}: {e}", full.join(" ")))?;

    let (Some(mut stdout_pipe), Some(mut stderr_pipe)) = (child.take_stdout(), child.take_stderr())
    else {
        // Pipes requested above, so this shouldn't happen. Reap the whole
        // process group rather than dropping a possibly still-running child.
        child.signal(KillSignal::Kill).await;
        let status = child
            .wait()
            .await
            .map_err(|e| format!("git {}: {e}", full.join(" ")))?;
        return Ok((exit_status_to_code(status), String::new()));
    };

    let mut combined = String::new();
    let mut stdout_open = true;
    let mut stderr_open = true;
    let mut exited = false;
    let mut exit_status: Option<std::process::ExitStatus> = None;
    let mut observed_signal = None;
    let mut so_chunk = [0u8; 8192];
    let mut se_chunk = [0u8; 8192];

    loop {
        if exited && !stdout_open && !stderr_open {
            break;
        }
        tokio::select! {
            res = stdout_pipe.read(&mut so_chunk), if stdout_open => {
                match res {
                    Ok(0) | Err(_) => stdout_open = false,
                    Ok(n) => {
                        let text = String::from_utf8_lossy(&so_chunk[..n]).into_owned();
                        combined.push_str(&text);
                        emit_chunk(orch, task_id, OutputStream::Stdout, &text).await;
                    }
                }
            }
            res = stderr_pipe.read(&mut se_chunk), if stderr_open => {
                match res {
                    Ok(0) | Err(_) => stderr_open = false,
                    Ok(n) => {
                        let text = String::from_utf8_lossy(&se_chunk[..n]).into_owned();
                        combined.push_str(&text);
                        emit_chunk(orch, task_id, OutputStream::Stderr, &text).await;
                    }
                }
            }
            status = child.wait(), if !exited && !stdout_open && !stderr_open => {
                exited = true;
                exit_status = status.ok();
            }
            signal = wait_for_signal(controller, observed_signal), if !exited => {
                observed_signal = Some(signal);
                child.signal(signal).await;
            }
        }
    }

    let code = exit_status.map(exit_status_to_code).unwrap_or(-1);
    Ok((code, combined))
}

async fn wait_for_signal(
    controller: Option<&ProcessController>,
    observed: Option<KillSignal>,
) -> KillSignal {
    match controller {
        Some(controller) => controller.wait_for_change(observed).await,
        None => std::future::pending().await,
    }
}

use crate::config::get_str;
use crate::sandbox::is_synthetic_branch;

/// Git error-message substrings meaning "this branch is already checked out
/// somewhere else" — either a sibling sandbox holds it, or it's the branch
/// canonical's own primary checkout currently has (e.g. the requested branch
/// IS the repo's default). Two sandboxes CAN legitimately want the same
/// branch (different agents, same work), so the caller's fallback is a
/// detached worktree at the same commit rather than failing outright.
fn worktree_branch_collision(stderr: &str) -> bool {
    stderr.contains("already used by worktree")
        || stderr.contains("already checked out")
        || stderr.contains("is already used")
        // `-B` on a branch another worktree holds reports this instead of
        // any of the above.
        || stderr.contains("cannot force update the branch")
}

/// Serializes canonical-repo filesystem surgery (delete-then-reclone) per
/// mirror. Two sandboxes CAN legitimately provision the same repository at
/// once (different branches), and their per-handle locks don't compose into
/// a per-mirror one — a reclone racing another sandbox's `pull`/`worktree
/// add` would pull the rug out from under it mid-operation. Keyed by the
/// canonical path; entries are tiny and never removed (one per distinct
/// repository this process touched).
fn canonical_sync_lock(canonical_str: &str) -> Arc<tokio::sync::Mutex<()>> {
    static LOCKS: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    > = std::sync::OnceLock::new();
    LOCKS
        .get_or_init(Default::default)
        .lock()
        .expect("sync lock map is never poisoned")
        .entry(canonical_str.to_string())
        .or_default()
        .clone()
}

/// Acquires source (clone if `.git` is absent, otherwise best-effort
/// checkout onto the configured branch) then runs the idempotent
/// post-acquisition steps (git identity, branch snapshot refresh). Returns
/// `true` on success OR "nothing to clone" (no `cloneUrl` configured —
/// forward progress, matches `stepClone`'s no-cloneUrl branch, not a
/// failure); `false` only on an actual clone/checkout failure, which also
/// transitions `lifecycle` to `clone-failed` before returning.
///
/// `pub(crate)` (widened from `pub(super)`): `crate::sandbox::manager`
/// drives this directly (awaited, outside the normal
/// enqueue-onto-the-worker path) so `SandboxManager::ensure` can guarantee
/// its caller sees the right branch's files the instant it returns — see
/// that module's doc comment.
pub(crate) async fn run(orch: &Arc<SetupOrchestrator>, config: &Value) -> bool {
    if orch.is_closed() {
        return false;
    }
    let Some(clone_url) =
        get_str(config, &["git", "repository", "cloneUrl"]).filter(|s| !s.is_empty())
    else {
        return true;
    };

    let branch = get_str(config, &["git", "repository", "branch"])
        .filter(|b| !b.is_empty() && !is_synthetic_branch(b));

    if !is_git_repo(&orch.repo_dir).await {
        if orch.is_closed() {
            return false;
        }
        if !clone_fresh(orch, clone_url, branch).await {
            return false;
        }
    } else if let Some(branch) = branch {
        if let Err(message) = checkout_existing(orch, branch).await {
            orch.transition_lifecycle(super::clone_failed(message));
            return false;
        }
    }

    if !configure_git_identity(orch, config).await || orch.is_closed() {
        return false;
    }
    emit_branch_event(&orch.repo_dir, &orch.broadcaster).await;
    !orch.is_closed()
}

/// Cheap validity probe for an unchanged in-process sandbox. A configured
/// real branch needs one `rev-parse`; synthetic isolation branches only need
/// to prove the managed workdir is still a repository.
pub(crate) async fn checkout_is_current(orch: &Arc<SetupOrchestrator>, config: &Value) -> bool {
    if orch.is_closed() {
        return false;
    }
    let Some(_clone_url) =
        get_str(config, &["git", "repository", "cloneUrl"]).filter(|url| !url.is_empty())
    else {
        return true;
    };

    match get_str(config, &["git", "repository", "branch"])
        .filter(|branch| !branch.is_empty() && !is_synthetic_branch(branch))
    {
        // Compare the UPSTREAM, not the local branch name: the worktree's
        // local branch is named after the sandbox handle so two agents can
        // hold the same git branch without colliding, so the local name never
        // equals the configured branch. Falls back to the local name for
        // worktrees created before that change, which have neither an
        // upstream nor a renamed branch.
        Some(expected) => match upstream_branch(&orch.repo_dir).await {
            Some(upstream) => upstream == expected,
            None => current_branch(&orch.repo_dir)
                .await
                .is_some_and(|current| current == expected),
        },
        None => is_git_repo(&orch.repo_dir).await,
    }
}

/// `.git` absent at `orch.repo_dir` (created empty at boot) — clone into it.
/// Registers ONE `"setup"` task spanning every git subcommand this
/// (potentially multi-step: ls-remote probe, clone, optional local fork)
/// acquisition runs — see this module's doc comment.
async fn clone_fresh(orch: &Arc<SetupOrchestrator>, clone_url: &str, branch: Option<&str>) -> bool {
    orch.transition_lifecycle(json!({ "phase": "cloning" }));

    // A FRESH clone starts a new "setup" lifecycle — reset the transcript so
    // a retry's replay isn't polluted by a stale prior attempt. Byte-parity
    // IN SPIRIT with `unlinkSync(cloneLogPath)` right before the old source
    // opened a new clone tee (`setup/orchestrator.ts`); `checkout_existing`
    // below deliberately does NOT reset it (neither did the old source's
    // "repo already cloned" / re-checkout path).
    orch.tasks.logs().truncate(&app_key("setup")).await;

    let task_id = orch.tasks.next_id();
    let controller = ProcessController::new();
    if !orch.register_task(TaskEntry::new(
        TaskSummary {
            id: task_id.clone(),
            command: format!("git clone {clone_url}"),
            status: TaskStatus::Running,
            exit_code: None,
            started_at: now_ms(),
            finished_at: None,
            timed_out: false,
            truncated: false,
            log_name: Some("setup".to_string()),
            intentional: None,
        },
        Some(controller.kill_handle()),
    )) {
        return false;
    }

    match clone_fresh_body(orch, &task_id, clone_url, branch, &controller).await {
        _ if controller.requested().is_some() => {
            let signal = controller.requested().expect("checked above");
            orch.tasks
                .finalize(&task_id, TaskStatus::Killed, signal.exit_code(), false);
            false
        }
        Ok(()) => {
            orch.tasks.finalize(&task_id, TaskStatus::Exited, 0, false);
            true
        }
        Err(message) => {
            // Surface the failure in the transcript BEFORE finalizing the
            // task, not after — a chunk sent once a task is terminal could
            // race a brand-new `/stream` subscriber that joins between the
            // two (see `tasks/registry.rs`'s "never see a chunk after End"
            // invariant).
            emit_chunk(
                orch,
                Some(&task_id),
                OutputStream::Stderr,
                &format!("\r\n[worktree] could not create the worktree: {message}\r\n"),
            )
            .await;
            orch.tasks.finalize(&task_id, TaskStatus::Failed, -1, false);
            orch.transition_lifecycle(super::clone_failed(message));
            false
        }
    }
}

/// The actual clone/sync/worktree sequence, factored out of [`clone_fresh`]
/// so every failure path funnels through ONE `Result::Err` — the caller
/// finalizes the task and transitions `lifecycle` exactly once, at the end.
///
/// Three plain git porcelain commands only — `clone`, `pull`, `worktree
/// add` — see this module's doc comment. No ref/HEAD inspection anywhere:
/// an empty remote (zero commits, no branches) needs no special case, since
/// `git worktree add` itself infers `--orphan` when its source has no
/// commits yet.
async fn clone_fresh_body(
    orch: &Arc<SetupOrchestrator>,
    task_id: &str,
    clone_url: &str,
    branch: Option<&str>,
    controller: &ProcessController,
) -> Result<(), String> {
    if let Some(b) = branch {
        if !is_valid_remote_branch_name(b) {
            return Err(format!("invalid branch name: {b}"));
        }
    }

    clear_clone_destination(&orch.repo_dir).await?;

    // ONE clone per upstream repository, shared by every sandbox that names
    // it; this worktree only adds a working copy on top. Falls back to a
    // direct clone when the URL isn't one we can key (see `canonical_repo_dir`).
    let canonical = crate::sandbox::repo_store::canonical_repo_dir(&orch.app_root, clone_url);
    let Some(canonical) = canonical else {
        return direct_clone(orch, task_id, clone_url, branch, controller).await;
    };

    // Two sandboxes CAN legitimately provision the same repository at once
    // (different branches) — serialize only the canonical repo's own
    // delete-then-reclone surgery, not the whole acquisition.
    let lock = canonical_sync_lock(&canonical.to_string_lossy());
    {
        let _sync = lock.lock().await;
        sync_canonical(orch, task_id, &canonical, clone_url, controller).await?;
    }

    add_worktree(
        orch,
        task_id,
        &canonical,
        &orch.repo_dir,
        branch,
        controller,
    )
    .await
}

/// Clone straight into `repo_dir` when `clone_url` isn't one the shared store
/// can key (malformed, or a spelling `canonical_repo_dir` declines) — no
/// mirror, no worktree, just a normal clone with the requested branch
/// created locally on top if it isn't already what got checked out.
async fn direct_clone(
    orch: &Arc<SetupOrchestrator>,
    task_id: &str,
    clone_url: &str,
    branch: Option<&str>,
    controller: &ProcessController,
) -> Result<(), String> {
    let repo_dir_str = orch.repo_dir.to_string_lossy().into_owned();
    let (code, out) = run_git(
        orch,
        Some(task_id),
        &["clone", clone_url, &repo_dir_str],
        None,
        Some(controller),
    )
    .await?;
    if code != 0 {
        return Err(format!("git clone exited {code}: {}", out.trim()));
    }
    let Some(b) = branch else {
        return Ok(());
    };
    // No commit-ish: defaults to whatever HEAD the clone above landed on,
    // same auto-orphan inference as `add_worktree` below when that HEAD is
    // unborn (an empty remote).
    let (code, out) = run_git(
        orch,
        Some(task_id),
        &["checkout", "-B", b],
        Some(&orch.repo_dir),
        Some(controller),
    )
    .await?;
    if code != 0 {
        return Err(format!("git checkout -B {b} exited {code}: {}", out.trim()));
    }
    set_upstream(orch, task_id, &orch.repo_dir, b, controller).await;
    Ok(())
}

/// Keeps the shared canonical mirror at `canonical` in sync with `clone_url`:
/// clones it if missing, else a plain `git fetch --prune origin`.
///
/// Canonical's own checkout is kept PERMANENTLY DETACHED (best-effort) —
/// never on a named branch. Otherwise canonical would permanently occupy
/// whatever branch it happens to be cloned onto (very often the repo's
/// actual default, e.g. `main`), and the very FIRST sandbox to request that
/// same branch would collide with canonical's own checkout and fall back to
/// a nameless detached worktree instead of a real one. Worktrees are always
/// cut from an explicit `refs/remotes/origin/*` ref (see [`add_worktree`]),
/// so canonical's own detached position never needs to be "current" for
/// anything — only its object database and remote-tracking refs do, and
/// `fetch` alone keeps those current.
///
/// `--prune`: drops remote-tracking refs for branches deleted upstream, so a
/// stale ref never gets offered as a worktree source.
///
/// Best-effort `remote set-head origin -a` after every fetch: keeps
/// `refs/remotes/origin/HEAD` — the fallback start point [`add_worktree`]
/// uses for a brand-new branch — pointed at the repo's actual current
/// default. Its failure (a still-empty remote has nothing to point at) is
/// expected and harmless: `add_worktree` falls further back to no start
/// point at all, which git resolves as an orphan branch for exactly that
/// case.
async fn sync_canonical(
    orch: &Arc<SetupOrchestrator>,
    task_id: &str,
    canonical: &Path,
    clone_url: &str,
    controller: &ProcessController,
) -> Result<(), String> {
    let canonical_str = canonical.to_string_lossy().into_owned();

    if !canonical.join(".git").is_dir() {
        if let Some(parent) = canonical.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|error| format!("failed to create repo store {parent:?}: {error}"))?;
        }
        emit_chunk(
            orch,
            Some(task_id),
            OutputStream::Stdout,
            "[worktree] no local mirror yet; creating the shared clone (once per repository)\r\n",
        )
        .await;
        let (code, out) = run_git(
            orch,
            Some(task_id),
            &["clone", clone_url, &canonical_str],
            None,
            Some(controller),
        )
        .await?;
        if code != 0 {
            return Err(format!("git clone exited {code}: {}", out.trim()));
        }
    } else {
        let (code, out) = run_git(
            orch,
            Some(task_id),
            &["-C", &canonical_str, "fetch", "--prune", "origin"],
            None,
            Some(controller),
        )
        .await?;
        if code != 0 {
            return Err(format!("git fetch exited {code}: {}", out.trim()));
        }
    }

    let _ = run_git(
        orch,
        Some(task_id),
        &["-C", &canonical_str, "checkout", "--detach"],
        None,
        Some(controller),
    )
    .await;
    let _ = run_git(
        orch,
        Some(task_id),
        &["-C", &canonical_str, "remote", "set-head", "origin", "-a"],
        None,
        Some(controller),
    )
    .await;
    Ok(())
}

/// Whether `ref_name` currently resolves inside `canonical` — used only to
/// pick a worktree start point (see [`add_worktree`]), never to decide
/// whether to clone/fetch in the first place.
async fn ref_exists(
    orch: &Arc<SetupOrchestrator>,
    task_id: &str,
    canonical_str: &str,
    ref_name: &str,
    controller: &ProcessController,
) -> bool {
    matches!(
        run_git(
            orch,
            Some(task_id),
            &[
                "-C",
                canonical_str,
                "rev-parse",
                "--verify",
                "--quiet",
                ref_name,
            ],
            None,
            Some(controller),
        )
        .await,
        Ok((0, _))
    )
}

/// Adds `repo_dir` as a `git worktree` of `canonical`, on `branch` (or
/// detached when `branch` is `None` — a synthetic/routing-key config value
/// with no real git ref to check out).
///
/// Start point, in order: the requested branch's own content if the remote
/// has it (kept current by [`sync_canonical`]'s fetch); else the repo's
/// actual default branch (a brand-new branch forks from there); else no
/// start point at all — a genuinely empty remote, where git itself infers
/// `--orphan` from canonical's unborn HEAD.
async fn add_worktree(
    orch: &Arc<SetupOrchestrator>,
    task_id: &str,
    canonical: &Path,
    repo_dir: &Path,
    branch: Option<&str>,
    controller: &ProcessController,
) -> Result<(), String> {
    let canonical_str = canonical.to_string_lossy().into_owned();
    let repo_dir_str = repo_dir.to_string_lossy().into_owned();

    // Drop registrations whose worktree directory is gone. Without this, a
    // re-bootstrap onto an emptied workdir finds git still holding the OLD
    // registration for this exact path ("cannot force update the branch ...
    // used by worktree at ..."), and falls into the detached-HEAD fallback
    // below for no real reason — the path is free, git just hasn't noticed
    // yet. `worktree prune` only removes registrations whose directories no
    // longer exist; live checkouts are untouched.
    let _ = run_git(
        orch,
        Some(task_id),
        &["-C", &canonical_str, "worktree", "prune"],
        None,
        Some(controller),
    )
    .await;

    let start_point = match branch {
        Some(b) => {
            let named = format!("refs/remotes/origin/{b}");
            if ref_exists(orch, task_id, &canonical_str, &named, controller).await {
                Some(named)
            } else if ref_exists(
                orch,
                task_id,
                &canonical_str,
                "refs/remotes/origin/HEAD",
                controller,
            )
            .await
            {
                Some("refs/remotes/origin/HEAD".to_string())
            } else {
                None
            }
        }
        None => None,
    };

    let add = |branch: Option<&str>, start_point: Option<&str>| {
        let mut args: Vec<String> = vec![
            "-C".into(),
            canonical_str.clone(),
            "worktree".into(),
            "add".into(),
            "--force".into(),
        ];
        match branch {
            // `-B` so re-provisioning a handle resets the branch instead of
            // failing on "already exists".
            Some(b) => {
                args.push("-B".into());
                args.push(b.to_string());
            }
            None => args.push("--detach".into()),
        }
        args.push(repo_dir_str.clone());
        if let Some(sp) = start_point {
            args.push(sp.to_string());
        }
        args
    };

    let args = add(branch, start_point.as_deref());
    let argv: Vec<&str> = args.iter().map(String::as_str).collect();
    let (code, out) = run_git(orch, Some(task_id), &argv, None, Some(controller)).await?;
    if code != 0 {
        if !worktree_branch_collision(&out) || branch.is_none() {
            return Err(format!("git worktree add exited {code}: {}", out.trim()));
        }
        emit_chunk(
            orch,
            Some(task_id),
            OutputStream::Stdout,
            &format!(
                "[worktree] branch '{}' already checked out elsewhere; detaching HEAD\r\n",
                branch.unwrap_or("")
            ),
        )
        .await;
        let args = add(None, start_point.as_deref());
        let argv: Vec<&str> = args.iter().map(String::as_str).collect();
        let (code, out) = run_git(orch, Some(task_id), &argv, None, Some(controller)).await?;
        if code != 0 {
            return Err(format!("git worktree add exited {code}: {}", out.trim()));
        }
        return Ok(());
    }

    if let Some(b) = branch {
        set_upstream(orch, task_id, repo_dir, b, controller).await;
    }
    Ok(())
}

/// Declares that `branch` in `repo_dir` tracks `origin/<branch>`.
///
/// Written as raw config rather than `branch --set-upstream-to`: that
/// command validates the remote ref EXISTS, so it fails for a branch this
/// sandbox just created and has never pushed — the normal case for a
/// brand-new branch.
///
/// Best effort: a sandbox with no upstream still works for everything except
/// a bare `git push`, and failing here would strand a worktree that is
/// otherwise complete.
async fn set_upstream(
    orch: &Arc<SetupOrchestrator>,
    task_id: &str,
    repo_dir: &Path,
    branch: &str,
    controller: &ProcessController,
) {
    let repo_dir_str = repo_dir.to_string_lossy().into_owned();
    for (key, value) in [
        (format!("branch.{branch}.remote"), "origin".to_string()),
        (
            format!("branch.{branch}.merge"),
            format!("refs/heads/{branch}"),
        ),
    ] {
        let _ = run_git(
            orch,
            Some(task_id),
            &["-C", &repo_dir_str, "config", &key, &value],
            None,
            Some(controller),
        )
        .await;
    }
}

/// A cancelled `git clone`/`worktree add` may leave an invalid, non-empty
/// `.git` tree. This function is reached only after `run` has established
/// that `repo_dir` is not a usable repository, so the managed destination
/// must be empty before the worktree add / direct clone below.
async fn clear_clone_destination(repo_dir: &Path) -> Result<(), String> {
    let metadata = match tokio::fs::symlink_metadata(repo_dir).await {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(format!(
                "failed to inspect clone destination {repo_dir:?}: {error}"
            ))
        }
    };
    let result = if metadata.is_dir() {
        tokio::fs::remove_dir_all(repo_dir).await
    } else {
        tokio::fs::remove_file(repo_dir).await
    };
    result.map_err(|error| format!("failed to clear clone destination {repo_dir:?}: {error}"))
}

/// Already cloned and a (possibly different) branch is configured. Narrower
/// than `spawnCheckoutBranch`: neither e2e oracle exercises a re-checkout on
/// an already-cloned repo (both always start from a fresh temp workdir), so
/// only the "already on the right branch" fast path and a plain
/// `git checkout <branch>` are implemented here — a remote-vs-local-fork
/// decision on an EXISTING clone is a known, flagged gap, not a silently
/// masked one. The task is registered before even the fast-path `rev-parse`
/// probe so shutdown owns every child spawned by this logical checkout step.
async fn checkout_existing(orch: &Arc<SetupOrchestrator>, branch: &str) -> Result<(), String> {
    let task_id = orch.tasks.next_id();
    let controller = ProcessController::new();
    if !orch.register_task(TaskEntry::new(
        TaskSummary {
            id: task_id.clone(),
            command: format!("git checkout {branch}"),
            status: TaskStatus::Running,
            exit_code: None,
            started_at: now_ms(),
            finished_at: None,
            timed_out: false,
            truncated: false,
            log_name: Some("setup".to_string()),
            intentional: None,
        },
        Some(controller.kill_handle()),
    )) {
        return Err("checkout task registration rejected".to_string());
    }

    let current = match run_git(
        orch,
        Some(&task_id),
        &["rev-parse", "--abbrev-ref", "HEAD"],
        Some(&orch.repo_dir),
        Some(&controller),
    )
    .await
    {
        Ok((0, current)) => current,
        Ok((code, output)) => {
            let (status, code) = match controller.requested() {
                Some(signal) => (TaskStatus::Killed, signal.exit_code()),
                None => (classify_status(false, code), code),
            };
            orch.tasks.finalize(&task_id, status, code, false);
            return Err(format!(
                "git rev-parse before checkout exited {code}: {}",
                output.trim()
            ));
        }
        Err(error) => {
            let (status, code) = match controller.requested() {
                Some(signal) => (TaskStatus::Killed, signal.exit_code()),
                None => (TaskStatus::Failed, -1),
            };
            orch.tasks.finalize(&task_id, status, code, false);
            return Err(error);
        }
    };
    if let Some(signal) = controller.requested() {
        orch.tasks
            .finalize(&task_id, TaskStatus::Killed, signal.exit_code(), false);
        return Err(format!("git checkout {branch} cancelled"));
    }
    if current.trim() == branch {
        orch.tasks.finalize(&task_id, TaskStatus::Exited, 0, false);
        return Ok(());
    }
    orch.transition_lifecycle(json!({ "phase": "checking-out", "to": branch }));

    let checkout = run_git(
        orch,
        Some(&task_id),
        &["checkout", branch],
        Some(&orch.repo_dir),
        Some(&controller),
    )
    .await;
    if let Some(signal) = controller.requested() {
        orch.tasks
            .finalize(&task_id, TaskStatus::Killed, signal.exit_code(), false);
        return Err(format!("git checkout {branch} cancelled"));
    }

    match checkout {
        Ok((0, _)) => {
            orch.tasks.finalize(&task_id, TaskStatus::Exited, 0, false);
            Ok(())
        }
        Ok((code, output)) => {
            orch.tasks
                .finalize(&task_id, classify_status(false, code), code, false);
            Err(format!(
                "git checkout {branch} exited {code}: {}",
                output.trim()
            ))
        }
        Err(error) => {
            orch.tasks.finalize(&task_id, TaskStatus::Failed, -1, false);
            Err(error)
        }
    }
}

/// Byte-parity with `setup/identity.ts::configureGitIdentity` — sets local
/// (repo-scoped, not global) `user.name`/`user.email` so `git commit` never
/// depends on the machine having a global identity configured. Required for
/// `routes/git.rs::publish`'s commits to succeed in a hermetic test HOME.
/// The two quick commands share one registered task so shutdown cannot race a
/// new `git config` child into existence after setup admission closes.
async fn configure_git_identity(orch: &Arc<SetupOrchestrator>, config: &Value) -> bool {
    let name = get_str(config, &["git", "identity", "userName"]).filter(|s| !s.is_empty());
    let email = get_str(config, &["git", "identity", "userEmail"]).filter(|s| !s.is_empty());
    let (Some(name), Some(email)) = (name, email) else {
        return true;
    };

    let task_id = orch.tasks.next_id();
    let controller = ProcessController::new();
    if !orch.register_task(TaskEntry::new(
        TaskSummary {
            id: task_id.clone(),
            command: "git config local identity".to_string(),
            status: TaskStatus::Running,
            exit_code: None,
            started_at: now_ms(),
            finished_at: None,
            timed_out: false,
            truncated: false,
            log_name: Some("setup".to_string()),
            intentional: None,
        },
        Some(controller.kill_handle()),
    )) {
        return false;
    }

    let name_result = run_git(
        orch,
        Some(&task_id),
        &["config", "user.name", name],
        Some(&orch.repo_dir),
        Some(&controller),
    )
    .await;
    let email_result = run_git(
        orch,
        Some(&task_id),
        &["config", "user.email", email],
        Some(&orch.repo_dir),
        Some(&controller),
    )
    .await;

    if let Some(signal) = controller.requested() {
        orch.tasks
            .finalize(&task_id, TaskStatus::Killed, signal.exit_code(), false);
        return false;
    }
    let succeeded = matches!(name_result, Ok((0, _))) && matches!(email_result, Ok((0, _)));
    orch.tasks.finalize(
        &task_id,
        if succeeded {
            TaskStatus::Exited
        } else {
            TaskStatus::Failed
        },
        if succeeded { 0 } else { -1 },
        false,
    );
    // Identity configuration was historically best-effort: a machine-level
    // git policy may reject the local write without making the acquired
    // worktree unusable. Preserve that behavior; only admission close or an
    // actual shutdown cancellation stops the cascade.
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    use crate::config::ConfigStore;
    use crate::events::Broadcaster;
    use crate::log_store::{LogStore, DEFAULT_TAIL_BYTES};
    use crate::tasks::TaskRegistry;

    fn git(dir: &Path, args: &[&str]) {
        let out = Command::new("git")
            .args(args)
            .current_dir(dir)
            .output()
            .expect("git failed to spawn");
        assert!(
            out.status.success(),
            "git {args:?} failed in {dir:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    /// A bare "origin" with a single `main` commit — returns the owning
    /// tempdir (keep it alive for the fixture's lifetime) and the bare
    /// repo's path (used directly as a `file://`-style `cloneUrl`).
    fn bare_repo_with_one_commit() -> (tempfile::TempDir, String) {
        let root = tempfile::tempdir().unwrap();
        let bare_dir = root.path().join("origin.git");
        let work_dir = root.path().join("author");
        std::fs::create_dir_all(&bare_dir).unwrap();
        std::fs::create_dir_all(&work_dir).unwrap();
        git(&bare_dir, &["init", "--bare", "-q"]);
        git(&work_dir, &["init", "-q", "-b", "main"]);
        git(&work_dir, &["config", "user.name", "Test User"]);
        git(&work_dir, &["config", "user.email", "test@example.com"]);
        std::fs::write(work_dir.join("f.txt"), "x").unwrap();
        git(&work_dir, &["add", "."]);
        git(&work_dir, &["commit", "-q", "-m", "initial"]);
        let bare_str = bare_dir.to_str().unwrap().to_string();
        git(&work_dir, &["remote", "add", "origin", &bare_str]);
        git(&work_dir, &["push", "-q", "-u", "origin", "main"]);
        git(&bare_dir, &["symbolic-ref", "HEAD", "refs/heads/main"]);
        (root, bare_str)
    }

    /// A fresh `SetupOrchestrator` rooted at `repo_dir`, with its OWN
    /// isolated `LogStore` (sibling `logs` dir) — mirrors
    /// `sandbox/manager.rs`'s per-sandbox wiring at a smaller scale.
    fn fresh_orch(repo_dir: std::path::PathBuf) -> Arc<SetupOrchestrator> {
        // `app_root` must be the PARENT of the workdir, never the workdir
        // itself: the shared repo store lives at `<app_root>/repos/…`, and
        // nesting that inside the destination would leave `git worktree add`
        // a non-empty directory to fail on. Mirrors the real per-sandbox
        // shape, `<app_root>/sandboxes/<handle>/repo`.
        let app_root = repo_dir.parent().unwrap().to_path_buf();
        let logs = Arc::new(LogStore::new(app_root.join("logs")));
        SetupOrchestrator::new(
            repo_dir,
            app_root,
            Arc::new(ConfigStore::new()),
            Arc::new(TaskRegistry::new(logs)),
            Arc::new(Broadcaster::new()),
        )
    }

    fn empty_repo_dir() -> (tempfile::TempDir, std::path::PathBuf) {
        let workdir = tempfile::tempdir().unwrap();
        let repo_dir = workdir.path().join("repo");
        std::fs::create_dir_all(&repo_dir).unwrap();
        (workdir, repo_dir)
    }

    /// Acquiring a branch that EXISTS on the remote, through the shared-store
    /// path — the combination that reached the running app broken.
    ///
    /// A `file://` URL is keyable by `canonical_repo_dir`, so this goes
    /// through `sync_canonical` + `git worktree add` for real, against a
    /// plain (non-bare) canonical clone.
    #[tokio::test]
    async fn worktree_path_checks_out_a_branch_that_exists_on_the_remote() {
        let (origin_root, bare_str) = bare_repo_with_one_commit();
        let (workdir, repo_dir) = empty_repo_dir();
        let orch = fresh_orch(repo_dir.clone());
        let clone_url = format!("file://{bare_str}");

        assert!(
            clone_fresh(&orch, &clone_url, Some("main")).await,
            "acquiring an existing remote branch must succeed: {:?}",
            orch.tasks
                .logs()
                .tail_read(&app_key("setup"), DEFAULT_TAIL_BYTES)
                .await
        );

        // A worktree, not a clone: `.git` is a FILE pointing into the shared
        // canonical repo, and that canonical repo exists under `repos/`.
        assert!(
            repo_dir.join(".git").is_file(),
            "expected a worktree marker file, found a directory (plain clone)"
        );
        let canonical =
            crate::sandbox::repo_store::canonical_repo_dir(&orch.app_root, &clone_url).unwrap();
        assert!(
            canonical.join(".git").is_dir(),
            "canonical repo exists as a plain (non-bare) clone"
        );

        // And it is genuinely on the requested branch with the remote's commit.
        assert_eq!(current_branch(&repo_dir).await.as_deref(), Some("main"));
        assert!(
            repo_dir.join("f.txt").is_file(),
            "remote content checked out"
        );

        let transcript = orch
            .tasks
            .logs()
            .tail_read(&app_key("setup"), DEFAULT_TAIL_BYTES)
            .await;
        assert!(
            transcript.contains("worktree add"),
            "the shared-store path should be what ran: {transcript:?}"
        );
        drop((origin_root, workdir));
    }

    #[tokio::test]
    async fn fresh_clone_streams_output_to_the_setup_log_and_registers_a_task() {
        let (_origin, clone_url) = bare_repo_with_one_commit();
        let (_workdir, repo_dir) = empty_repo_dir();
        let orch = fresh_orch(repo_dir.clone());

        let config = json!({
            "git": { "repository": { "cloneUrl": clone_url, "branch": "main" } }
        });
        assert!(run(&orch, &config).await, "clone must succeed");
        assert!(repo_dir.join(".git").exists());

        // The regression this file fixes: BEFORE, `run_git` used
        // `Command::output()` — no task, no live/replayed log frame.
        let tasks = orch.tasks.list(None);
        let setup_task = tasks
            .iter()
            .find(|t| t.log_name.as_deref() == Some("setup"))
            .expect("clone must register a \"setup\" task");
        assert_eq!(setup_task.status, TaskStatus::Exited);
        assert_eq!(setup_task.exit_code, Some(0));

        let transcript = orch
            .tasks
            .logs()
            .tail_read(&app_key("setup"), DEFAULT_TAIL_BYTES)
            .await;
        assert!(
            transcript.contains("$ git") && transcript.contains("clone"),
            "transcript missing the streamed clone command: {transcript:?}"
        );
    }

    #[tokio::test]
    async fn fresh_clone_replaces_an_interrupted_nonempty_destination() {
        let (_origin, clone_url) = bare_repo_with_one_commit();
        let (_workdir, repo_dir) = empty_repo_dir();
        std::fs::create_dir_all(repo_dir.join(".git/objects")).unwrap();
        std::fs::write(repo_dir.join(".git/objects/partial"), "incomplete clone").unwrap();
        std::fs::write(repo_dir.join("partial-worktree-file"), "incomplete clone").unwrap();
        let orch = fresh_orch(repo_dir.clone());

        let config = json!({
            "git": { "repository": { "cloneUrl": clone_url, "branch": "main" } }
        });
        assert!(
            run(&orch, &config).await,
            "a retry must replace the interrupted clone"
        );
        assert!(is_git_repo(&repo_dir).await);
        assert!(!repo_dir.join("partial-worktree-file").exists());
        assert_eq!(current_branch(&repo_dir).await.as_deref(), Some("main"));
    }

    #[tokio::test]
    async fn closed_orchestrator_rejects_clone_before_any_task_or_process() {
        let (_origin, clone_url) = bare_repo_with_one_commit();
        let (_workdir, repo_dir) = empty_repo_dir();
        let orch = fresh_orch(repo_dir.clone());
        orch.close();

        let config = json!({
            "git": { "repository": { "cloneUrl": clone_url, "branch": "main" } }
        });
        assert!(!run(&orch, &config).await);
        assert!(orch.tasks.list(None).is_empty());
        assert!(!repo_dir.join(".git").exists());
    }

    /// Any requested branch that isn't already what canonical has checked
    /// out is always created locally via `-B` — there's no remote-existence
    /// probe left to distinguish "forked" from "already there".
    #[tokio::test]
    async fn fresh_clone_of_a_new_branch_creates_it_locally_from_canonical() {
        let (_origin, clone_url) = bare_repo_with_one_commit();
        let (_workdir, repo_dir) = empty_repo_dir();
        let orch = fresh_orch(repo_dir.clone());

        let config = json!({
            "git": { "repository": { "cloneUrl": clone_url, "branch": "does-not-exist-on-remote" } }
        });
        assert!(
            run(&orch, &config).await,
            "clone must still succeed (local branch)"
        );

        assert_eq!(
            current_branch(&repo_dir).await.as_deref(),
            Some("does-not-exist-on-remote")
        );
        assert!(
            repo_dir.join("f.txt").is_file(),
            "new branch must still be cut from canonical's synced content"
        );
    }

    #[tokio::test]
    async fn clone_failure_finalizes_the_task_as_failed_and_transitions_lifecycle() {
        let (_workdir, repo_dir) = empty_repo_dir();
        let orch = fresh_orch(repo_dir.clone());

        // A path that doesn't exist — `git clone` fails fast, no network.
        let bogus = repo_dir.parent().unwrap().join("nope.git");
        let config = json!({
            "git": { "repository": { "cloneUrl": bogus.to_str().unwrap() } }
        });
        assert!(!run(&orch, &config).await, "clone must fail");

        assert_eq!(orch.lifecycle_snapshot()["phase"], "clone-failed");

        let tasks = orch.tasks.list(None);
        let setup_task = tasks
            .iter()
            .find(|t| t.log_name.as_deref() == Some("setup"))
            .expect("clone must register a \"setup\" task even on failure");
        assert_eq!(setup_task.status, TaskStatus::Failed);

        let transcript = orch
            .tasks
            .logs()
            .tail_read(&app_key("setup"), DEFAULT_TAIL_BYTES)
            .await;
        assert!(
            transcript.contains("[worktree] could not create the worktree"),
            "transcript: {transcript:?}"
        );
    }

    #[tokio::test]
    async fn a_second_fresh_clone_truncates_the_prior_setup_transcript() {
        let (_origin, clone_url) = bare_repo_with_one_commit();
        let (_workdir, repo_dir) = empty_repo_dir();
        let orch = fresh_orch(repo_dir.clone());

        assert!(clone_fresh(&orch, &clone_url, Some("main")).await);
        let first = orch
            .tasks
            .logs()
            .tail_read(&app_key("setup"), DEFAULT_TAIL_BYTES)
            .await;
        // A filesystem remote is keyed like any other, so a fresh clone goes
        // through the shared mirror: exactly one `worktree add` per run.
        assert_eq!(first.matches("worktree add").count(), 1, "{first:?}");

        // A second "fresh" clone run against the SAME orchestrator (mirrors
        // a real re-bootstrap onto an emptied workdir).
        std::fs::remove_dir_all(&repo_dir).unwrap();
        std::fs::create_dir_all(&repo_dir).unwrap();
        assert!(clone_fresh(&orch, &clone_url, Some("main")).await);
        let second = orch
            .tasks
            .logs()
            .tail_read(&app_key("setup"), DEFAULT_TAIL_BYTES)
            .await;

        // Truncated, not appended: the second transcript describes ONLY the
        // second clone, not both concatenated.
        assert_eq!(
            second.matches("worktree add").count(),
            1,
            "second transcript should describe exactly one checkout, not two concatenated: {second:?}"
        );
    }

    /// A bare origin with ZERO commits — the case that used to hard-fail
    /// clone/setup: `worktree add` from an unborn HEAD, and a canonical
    /// mirror sync that can never resolve a "default branch" because the
    /// remote has none to advertise. Neither `sync_canonical` nor
    /// `add_worktree` needs to know any of that; git's own porcelain infers
    /// `--orphan` when the source has no commits, so this just works.
    fn empty_bare_repo() -> (tempfile::TempDir, String) {
        let root = tempfile::tempdir().unwrap();
        let bare_dir = root.path().join("origin.git");
        std::fs::create_dir_all(&bare_dir).unwrap();
        git(&bare_dir, &["init", "--bare", "-q"]);
        let bare_str = bare_dir.to_str().unwrap().to_string();
        (root, bare_str)
    }

    #[tokio::test]
    async fn cloning_a_genuinely_empty_remote_creates_an_orphan_worktree() {
        let (origin_root, bare_str) = empty_bare_repo();
        let (workdir, repo_dir) = empty_repo_dir();
        let orch = fresh_orch(repo_dir.clone());
        let clone_url = format!("file://{bare_str}");

        assert!(
            clone_fresh(&orch, &clone_url, Some("feature-x")).await,
            "acquiring an empty remote must still succeed: {:?}",
            orch.tasks
                .logs()
                .tail_read(&app_key("setup"), DEFAULT_TAIL_BYTES)
                .await
        );

        // Unborn HEAD, on the requested branch — not the direct-clone
        // fallback's `master`/`main` guess, and not `None` (which the old
        // `rev-parse --abbrev-ref HEAD`-only `current_branch` would have
        // returned for this exact state).
        assert_eq!(
            current_branch(&repo_dir).await.as_deref(),
            Some("feature-x")
        );
        assert!(
            Command::new("git")
                .args(["rev-parse", "HEAD"])
                .current_dir(&repo_dir)
                .output()
                .unwrap()
                .status
                .success()
                .then_some(())
                .is_none(),
            "worktree must have zero commits"
        );

        // The worktree is genuinely usable: a first commit succeeds.
        git(&repo_dir, &["config", "user.name", "Test User"]);
        git(&repo_dir, &["config", "user.email", "test@example.com"]);
        std::fs::write(repo_dir.join("f.txt"), "hi").unwrap();
        git(&repo_dir, &["add", "."]);
        git(&repo_dir, &["commit", "-q", "-m", "first commit"]);
        assert_eq!(
            current_branch(&repo_dir).await.as_deref(),
            Some("feature-x")
        );
        drop((origin_root, workdir));
    }

    #[tokio::test]
    async fn sync_canonical_picks_up_a_branch_pushed_after_an_empty_first_clone() {
        let (origin_root, bare_str) = empty_bare_repo();
        let (workdir, repo_dir) = empty_repo_dir();
        let orch = fresh_orch(repo_dir.clone());
        let clone_url = format!("file://{bare_str}");
        let canonical =
            crate::sandbox::repo_store::canonical_repo_dir(&orch.app_root, &clone_url).unwrap();

        let controller = ProcessController::new();
        sync_canonical(&orch, "t1", &canonical, &clone_url, &controller)
            .await
            .expect("first sync (clone of an empty remote) must succeed");
        assert!(canonical.join(".git").is_dir());

        // The remote goes from empty to having real content on a branch that
        // has nothing to do with whatever this machine's `init.defaultBranch`
        // happened to guess for the canonical's own empty checkout.
        let work_dir = workdir.path().join("author");
        std::fs::create_dir_all(&work_dir).unwrap();
        git(&work_dir, &["init", "-q", "-b", "sandbox/thread-1"]);
        git(&work_dir, &["config", "user.name", "Test User"]);
        git(&work_dir, &["config", "user.email", "test@example.com"]);
        std::fs::write(work_dir.join("f.txt"), "hi").unwrap();
        git(&work_dir, &["add", "."]);
        git(&work_dir, &["commit", "-q", "-m", "first"]);
        git(&work_dir, &["remote", "add", "origin", &bare_str]);
        git(&work_dir, &["push", "-q", "origin", "sandbox/thread-1"]);
        // What GitHub does automatically the moment a first branch lands on
        // an empty repo: point the remote's own HEAD symref at it. A plain
        // `git init --bare` + `git push` fixture does not do this on its
        // own, so the test simulates it explicitly.
        git(
            Path::new(&bare_str),
            &["symbolic-ref", "HEAD", "refs/heads/sandbox/thread-1"],
        );

        sync_canonical(&orch, "t2", &canonical, &clone_url, &controller)
            .await
            .expect("second sync must succeed");

        // Canonical stays permanently detached (see `sync_canonical`'s doc
        // comment) — its own working tree is never the source of truth. What
        // matters is that a plain fetch picked up the branch that actually
        // exists on the remote now, reachable via its own remote-tracking
        // ref, regardless of whatever this machine's `init.defaultBranch`
        // guessed for the first, empty clone.
        assert!(
            ref_exists(
                &orch,
                "t3",
                &canonical.to_string_lossy(),
                "refs/remotes/origin/sandbox/thread-1",
                &controller,
            )
            .await,
            "fetch must have picked up the branch that actually exists on the remote"
        );
        drop((origin_root, workdir));
    }
}
