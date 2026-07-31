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

/// `git ls-remote --exit-code --heads` return codes git itself defines: `2`
/// means "remote reachable, no matching ref" (a real failure is anything
/// else non-zero) — byte-parity with `clone.ts::LS_REMOTE_NO_MATCH`.
const LS_REMOTE_NO_MATCH: i32 = 2;

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

/// The actual clone/fork sequence, factored out of [`clone_fresh`] so every
/// failure path funnels through ONE `Result::Err` — the caller finalizes the
/// task and transitions `lifecycle` exactly once, at the end, instead of
/// each branch duplicating that bookkeeping.
async fn clone_fresh_body(
    orch: &Arc<SetupOrchestrator>,
    task_id: &str,
    clone_url: &str,
    branch: Option<&str>,
    controller: &ProcessController,
) -> Result<(), String> {
    // Decide whether the requested branch exists on the remote before
    // cloning — byte-parity with `spawnClone`'s deterministic
    // `ls-remote --exit-code` probe (replacing a "try then silently
    // fall through" approach): 0 -> clone it directly with `--branch`; 2 ->
    // clone the default branch and fork the requested one locally; anything
    // else is a real failure (auth/DNS/TLS) surfaced to the caller.
    let (branch_on_remote, branch_to_fork): (Option<&str>, Option<&str>) = match branch {
        None => (None, None),
        Some(b) => {
            if !is_valid_remote_branch_name(b) {
                return Err(format!("invalid branch name: {b}"));
            }
            let (code, out) = run_git(
                orch,
                Some(task_id),
                &["ls-remote", "--exit-code", "--heads", clone_url, b],
                None,
                Some(controller),
            )
            .await?;
            match code {
                0 => (Some(b), None),
                LS_REMOTE_NO_MATCH => {
                    emit_chunk(
                        orch,
                        Some(task_id),
                        OutputStream::Stdout,
                        &format!(
                            "[worktree] branch '{b}' not on origin; creating it from origin's default branch in a new worktree\r\n"
                        ),
                    )
                    .await;
                    (None, Some(b))
                }
                other => {
                    return Err(format!("ls-remote failed (exit {other}): {}", out.trim()));
                }
            }
        }
    };

    clear_clone_destination(&orch.repo_dir).await?;

    // ONE bare clone per upstream repository, shared by every sandbox that
    // names it; this worktree only adds a working copy on top. Falls back to a
    // direct clone when the URL isn't one we can key (see `canonical_repo_dir`).
    let canonical = crate::sandbox::repo_store::canonical_repo_dir(&orch.app_root, clone_url);
    let Some(canonical) = canonical else {
        let repo_dir_str = orch.repo_dir.to_string_lossy().into_owned();
        let mut clone_args: Vec<&str> = vec!["clone", "--depth", "1"];
        if let Some(b) = branch_on_remote {
            clone_args.push("--branch");
            clone_args.push(b);
        }
        clone_args.push(clone_url);
        clone_args.push(&repo_dir_str);
        let (code, out) = run_git(orch, Some(task_id), &clone_args, None, Some(controller)).await?;
        if code != 0 {
            return Err(format!("git clone exited {code}: {}", out.trim()));
        }
        return finish_fresh_checkout(orch, task_id, branch_to_fork, controller).await;
    };

    ensure_canonical_repo(
        orch,
        task_id,
        clone_url,
        &canonical,
        branch_on_remote,
        controller,
    )
    .await?;

    // Start point for the new worktree: always a REMOTE-TRACKING ref.
    //
    // These bare clones do have remote-tracking refs — the fetch refspec is
    // `+refs/heads/*:refs/remotes/origin/*`, which by design writes only to
    // `refs/remotes/origin/*` and never to `refs/heads/*`. So the repo's own
    // `refs/heads/main` (and therefore `HEAD`) stays frozen at whatever it was
    // when the repo was first cloned, while `refs/remotes/origin/main` tracks
    // reality. Branching from `HEAD` cut every new worktree from that frozen
    // commit — a fetch ran, reported success, and the worktree still landed on
    // month-old code with nothing in the transcript to say so.
    //
    // Fully qualified rather than the `origin/<branch>` shorthand: a stale
    // `refs/heads/<branch>` of the same name exists in these repos and would
    // be a candidate for the shorthand to resolve to.
    let start_point = match branch_on_remote {
        Some(branch) => format!("refs/remotes/origin/{branch}"),
        None => "refs/remotes/origin/HEAD".to_string(),
    };
    // The worktree's local branch is simply the branch that was asked for.
    //
    // Handle and branch are one identity — `compute_handle` builds the handle
    // as `<repo scope>/<slugified branch>` — so the local name, the upstream
    // name and the worktree directory all derive from the same value and there
    // is nothing to reconcile. The per-repo bare mirror is what keeps two
    // agents from colliding: same repo + same branch IS the same sandbox, and
    // different repos never share a branch namespace.
    //
    // Naming it after the sandbox DIRECTORY instead (an earlier revision, from
    // when a handle was independent of the branch) also broke daemon mode,
    // where `repo_dir` is `<app_root>/repo` and the parent is a caller-chosen
    // temp dir — every clone came out on a branch named after the mkdtemp.
    let target_branch = branch_on_remote.or(branch_to_fork);

    let canonical_str = canonical.to_string_lossy().into_owned();
    let repo_dir_str = orch.repo_dir.to_string_lossy().into_owned();
    let add = |branch: Option<&str>| {
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
        args.push(start_point.clone());
        args
    };

    let args = add(target_branch);
    let argv: Vec<&str> = args.iter().map(String::as_str).collect();
    let (code, out) = run_git(orch, Some(task_id), &argv, None, Some(controller)).await?;
    if code != 0 {
        // Git refuses to check a branch out in two worktrees at once. Two
        // sandboxes CAN legitimately want one repo+branch (different agents on
        // the same work), so fall back to a detached worktree at the same
        // commit rather than failing the sandbox outright — it has the right
        // files; only the branch pointer is missing.
        let already_checked_out = out.contains("already used by worktree")
            || out.contains("already checked out")
            || out.contains("is already used")
            // `-B` on a branch another worktree holds reports this instead of
            // any of the above, which is how a same-branch collision slipped
            // past the fallback and failed the sandbox outright.
            || out.contains("cannot force update the branch");
        if !already_checked_out || target_branch.is_none() {
            return Err(format!("git worktree add exited {code}: {}", out.trim()));
        }
        emit_chunk(
            orch,
            Some(task_id),
            OutputStream::Stdout,
            &format!(
                "[worktree] branch '{}' already checked out elsewhere; detaching HEAD\r\n",
                target_branch.unwrap_or("")
            ),
        )
        .await;
        let args = add(None);
        let argv: Vec<&str> = args.iter().map(String::as_str).collect();
        let (code, out) = run_git(orch, Some(task_id), &argv, None, Some(controller)).await?;
        if code != 0 {
            return Err(format!("git worktree add exited {code}: {}", out.trim()));
        }
    }

    // Name the upstream explicitly, even though local and remote now agree.
    //
    // The NEW-branch case is why: `worktree add` cut from `origin/HEAD` leaves
    // git's own autoSetupMerge tracking `origin/main`, which would make
    // `checkout_is_current` believe the sandbox is on main. The branch the
    // user asked for is the one the upstream must name, whether or not it
    // exists on the remote yet.
    //
    // Best effort: a sandbox with no upstream still works for everything
    // except a bare `git push`, and failing here would strand a worktree that
    // is otherwise complete.
    if let Some(branch) = target_branch {
        // Written as raw config rather than `branch --set-upstream-to`: that
        // command validates the remote ref EXISTS, so it fails for a branch
        // this sandbox is about to create and has never pushed. It failed
        // silently, leaving git's autoSetupMerge default of `origin/main` —
        // which then made the upstream check believe the sandbox was on main
        // and fail the whole checkout.
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

    finish_fresh_checkout(orch, task_id, None, controller).await
}

/// The shared bare clone every worktree is cut from: created on first use,
/// refreshed on later ones so a new sandbox sees current refs.
///
/// `--bare` deliberately: nobody edits this directory, and a bare repo cannot
/// hold a checked-out branch that would then be unavailable to worktrees.
async fn ensure_canonical_repo(
    orch: &Arc<SetupOrchestrator>,
    task_id: &str,
    clone_url: &str,
    canonical: &Path,
    branch_on_remote: Option<&str>,
    controller: &ProcessController,
) -> Result<(), String> {
    let canonical_str = canonical.to_string_lossy().into_owned();

    if canonical.join("HEAD").is_file() {
        // Already present — refresh refs so a newly requested branch resolves.
        // A failed fetch is not fatal: the objects already on disk may well
        // satisfy this checkout, and failing here would strand a sandbox that
        // could otherwise start offline.
        let (code, out) = run_git(
            orch,
            Some(task_id),
            &["-C", &canonical_str, "fetch", "--prune", "origin"],
            None,
            Some(controller),
        )
        .await?;
        let (code, out) = refetch_after_case_collision(
            orch,
            task_id,
            &canonical_str,
            controller,
            branch_on_remote,
            code,
            out,
        )
        .await?;
        if code != 0 {
            emit_chunk(
                orch,
                Some(task_id),
                OutputStream::Stdout,
                &format!(
                    "[worktree] fetch failed (exit {code}); reusing cached objects: {}\r\n",
                    out.trim()
                ),
            )
            .await;
        }
        // Repos cloned before the start point moved to remote-tracking refs
        // still carry their frozen `refs/heads/*`; clean them here so an
        // existing mirror converges on the same shape as a fresh one.
        prune_stale_local_heads(orch, task_id, &canonical_str, controller).await;
        // Drop registrations whose worktree directory is gone. Without this, a
        // re-bootstrap onto an emptied workdir finds git still holding the OLD
        // registration's branch ("cannot force update the branch ... used by
        // worktree at ..."), falls into the detached-HEAD fallback, and the
        // sandbox silently comes up off-branch. `worktree prune` only removes
        // registrations whose directories no longer exist — live checkouts are
        // untouched.
        let _ = run_git(
            orch,
            Some(task_id),
            &["-C", &canonical_str, "worktree", "prune"],
            None,
            Some(controller),
        )
        .await;
        return Ok(());
    }

    if let Some(parent) = canonical.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|error| format!("failed to create repo store {parent:?}: {error}"))?;
    }
    // Frame git's own `Cloning into bare repository '...'` before it appears.
    // Without this the once-per-repository mirror reads as a per-sandbox
    // clone, which is precisely how this transcript has been misread.
    emit_chunk(
        orch,
        Some(task_id),
        OutputStream::Stdout,
        "[worktree] no local mirror yet; creating the shared bare clone (once per repository)\r\n",
    )
    .await;
    // `--ref-format=reftable` deliberately: the files backend stores each ref
    // as a filesystem path, so two remote branches whose names differ only by
    // case are unstorable on the case-insensitive filesystems macOS ships —
    // git 2.46+ fails the fetch outright and recommends exactly this backend
    // (refs live in a table, not paths). Try-with-fallback rather than a
    // version probe: a git without reftable (< 2.45, or compiled out) rejects
    // the flag, and `git clone` removes the destination it created on
    // failure, so the plain retry starts clean.
    let (code, out) = run_git(
        orch,
        Some(task_id),
        &[
            "clone",
            "--bare",
            "--ref-format=reftable",
            clone_url,
            &canonical_str,
        ],
        None,
        Some(controller),
    )
    .await?;
    let (code, out) = if code != 0 && ref_format_unsupported(&out) {
        emit_chunk(
            orch,
            Some(task_id),
            OutputStream::Stdout,
            "[worktree] this git predates the reftable ref backend; using the files backend\r\n",
        )
        .await;
        run_git(
            orch,
            Some(task_id),
            &["clone", "--bare", clone_url, &canonical_str],
            None,
            Some(controller),
        )
        .await?
    } else {
        (code, out)
    };
    if code != 0 {
        return Err(format!("git clone --bare exited {code}: {}", out.trim()));
    }
    // `git clone --bare` populates `refs/heads/*` and sets NO fetch refspec,
    // so there are no remote-tracking refs at all — and the worktree start
    // point is now one. Establish them here so both paths (fresh clone and
    // existing mirror) present the same shape, and so `refs/heads/*` can be
    // pruned without losing the ability to resolve a branch.
    let _ = run_git(
        orch,
        Some(task_id),
        &[
            "-C",
            &canonical_str,
            "config",
            "remote.origin.fetch",
            "+refs/heads/*:refs/remotes/origin/*",
        ],
        None,
        Some(controller),
    )
    .await?;
    let (code, out) = run_git(
        orch,
        Some(task_id),
        &["-C", &canonical_str, "fetch", "--prune", "origin"],
        None,
        Some(controller),
    )
    .await?;
    let (code, out) = refetch_after_case_collision(
        orch,
        task_id,
        &canonical_str,
        controller,
        branch_on_remote,
        code,
        out,
    )
    .await?;
    if code != 0 {
        return Err(format!(
            "git fetch after bare clone exited {code}: {}",
            out.trim()
        ));
    }
    // `refs/remotes/origin/HEAD` is the fallback start point for a branch that
    // does not exist upstream, and a bare clone does not create it.
    let _ = run_git(
        orch,
        Some(task_id),
        &["-C", &canonical_str, "remote", "set-head", "origin", "-a"],
        None,
        Some(controller),
    )
    .await;
    prune_stale_local_heads(orch, task_id, &canonical_str, controller).await;
    Ok(())
}

/// A git that does not know `--ref-format` (< 2.45) or the reftable value
/// (compiled out) rejects the clone before touching the network — both
/// spellings of that rejection, so the fallback never masks a real failure.
fn ref_format_unsupported(out: &str) -> bool {
    out.contains("unknown option") || out.contains("unknown ref storage format")
}

/// Serializes ref-storage surgery per canonical mirror. Two sandboxes CAN
/// legitimately provision the same repository at once (same repo, different
/// branches), and their per-handle locks don't compose into a per-mirror
/// one — a `refs migrate` racing another sandbox's fetch would rewrite ref
/// storage underneath it. Keyed by the canonical path; entries are tiny and
/// never removed (one per distinct repository this process touched).
fn mirror_surgery_lock(canonical_str: &str) -> Arc<tokio::sync::Mutex<()>> {
    static LOCKS: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    > = std::sync::OnceLock::new();
    LOCKS
        .get_or_init(Default::default)
        .lock()
        .expect("mirror lock map is never poisoned")
        .entry(canonical_str.to_string())
        .or_default()
        .clone()
}

/// Recovery for a files-backend mirror that just hit git's case-collision
/// refusal: the remote has branches whose names differ only by case, which
/// filesystem-path ref storage cannot hold on the case-insensitive volumes
/// macOS ships. In order of preference:
///
/// 1. `git worktree prune` + `git refs migrate --ref-format=reftable` +
///    full refetch — the complete fix git's own error text recommends, but
///    it is only possible while NO worktree is registered: git refuses to
///    migrate a repository with worktrees on every released version ("not
///    supported yet", a documented limitation), and every live sandbox IS a
///    linked worktree of this mirror. The prune first clears STALE
///    registrations (emptied workdirs), which alone also block it.
/// 2. Narrow fetch of just the branch this acquisition needs. A single-ref
///    write cannot collide with itself, so the requested branch lands at its
///    true commit on ANY git version — even when the sibling's wrong-cased
///    loose file is what physically absorbs the write. The colliding
///    sibling's mirror ref may go stale until ITS next acquisition fetches
///    it back; that harm is bounded (worktrees pin their commit at add time,
///    and branch-currency checks compare names, not shas). Each ensure
///    retries the migration first, so once the last worktree of a mirror is
///    deleted the permanent fix lands by itself.
/// 3. No branch to narrow to — pass the ORIGINAL failure through unchanged
///    so each call site's existing handling still owns the outcome.
///
/// Known residue: a fetch that INTRODUCES one casing while the other already
/// exists as a loose ref exits 0 (git silently writes through the wrong-
/// cased file), so this handler fires one acquisition later, when the stale
/// sibling makes the next fetch fail. The acquisition that triggered the
/// clobber still checked out its own branch's correct commit.
async fn refetch_after_case_collision(
    orch: &Arc<SetupOrchestrator>,
    task_id: &str,
    canonical_str: &str,
    controller: &ProcessController,
    branch: Option<&str>,
    code: i32,
    out: String,
) -> Result<(i32, String), String> {
    if code == 0 || !out.contains("case-insensitive filesystem") {
        return Ok((code, out));
    }

    let lock = mirror_surgery_lock(canonical_str);
    let _surgery = lock.lock().await;

    emit_chunk(
        orch,
        Some(task_id),
        OutputStream::Stdout,
        "[worktree] remote branches differ only by letter case, which this case-insensitive filesystem cannot store as files; migrating the mirror to the reftable backend\r\n",
    )
    .await;
    // Stale worktree registrations (deleted workdirs) are enough to make the
    // migration below refuse — clear them first, live ones are untouched.
    let _ = run_git(
        orch,
        Some(task_id),
        &["-C", canonical_str, "worktree", "prune"],
        None,
        Some(controller),
    )
    .await;
    let (migrate_code, _) = run_git(
        orch,
        Some(task_id),
        &[
            "-C",
            canonical_str,
            "refs",
            "migrate",
            "--ref-format=reftable",
        ],
        None,
        Some(controller),
    )
    .await?;
    if migrate_code == 0 {
        return run_git(
            orch,
            Some(task_id),
            &["-C", canonical_str, "fetch", "--prune", "origin"],
            None,
            Some(controller),
        )
        .await;
    }

    let Some(branch) = branch else {
        return Ok((code, out));
    };
    emit_chunk(
        orch,
        Some(task_id),
        OutputStream::Stdout,
        &format!(
            "[worktree] the mirror cannot migrate while sandboxes hold worktrees; fetching only branch '{branch}'\r\n"
        ),
    )
    .await;
    let refspec = format!("+refs/heads/{branch}:refs/remotes/origin/{branch}");
    run_git(
        orch,
        Some(task_id),
        &["-C", canonical_str, "fetch", "origin", &refspec],
        None,
        Some(controller),
    )
    .await
}

/// Delete `refs/heads/*` that no worktree is using.
///
/// `git clone --bare` copies the remote's heads into `refs/heads/*`, but the
/// fetch refspec (`+refs/heads/*:refs/remotes/origin/*`) only ever updates
/// `refs/remotes/origin/*`. So those copies are frozen at clone time and can
/// never be right again — they are pure misdirection, and branching from one
/// is exactly the bug this file just fixed.
///
/// The only `refs/heads/*` worth keeping are the ones `worktree add -B`
/// creates for live sandboxes, so anything a worktree holds is skipped. Best
/// effort: failing to prune costs nothing now that the start point is a
/// remote-tracking ref, so a failure here must never block provisioning.
async fn prune_stale_local_heads(
    orch: &Arc<SetupOrchestrator>,
    task_id: &str,
    canonical_str: &str,
    controller: &ProcessController,
) {
    let Ok((_, held_out)) = run_git(
        orch,
        Some(task_id),
        &["-C", canonical_str, "worktree", "list", "--porcelain"],
        None,
        Some(controller),
    )
    .await
    else {
        return;
    };
    let held: std::collections::HashSet<&str> = held_out
        .lines()
        .filter_map(|line| line.strip_prefix("branch "))
        .map(str::trim)
        .collect();

    let Ok((_, refs_out)) = run_git(
        orch,
        Some(task_id),
        &[
            "-C",
            canonical_str,
            "for-each-ref",
            "--format=%(refname)",
            "refs/heads",
        ],
        None,
        Some(controller),
    )
    .await
    else {
        return;
    };
    let stale: Vec<String> = refs_out
        .lines()
        .map(str::trim)
        .filter(|refname| refname.starts_with("refs/heads/") && !held.contains(refname))
        .map(str::to_string)
        .collect();
    if stale.is_empty() {
        return;
    }

    // One `git branch -D` with every name rather than N processes: these repos
    // routinely carry hundreds of stale heads. git additionally refuses to
    // delete a branch a worktree holds, so that is a second guard under the
    // filter above.
    let mut args: Vec<String> = vec![
        "-C".into(),
        canonical_str.to_string(),
        "branch".into(),
        "-D".into(),
    ];
    args.extend(
        stale
            .iter()
            .filter_map(|refname| refname.strip_prefix("refs/heads/"))
            .map(str::to_string),
    );
    let borrowed: Vec<&str> = args.iter().map(String::as_str).collect();
    let _ = run_git(orch, Some(task_id), &borrowed, None, Some(controller)).await;
}

/// The post-acquisition local fork step, shared by the worktree and
/// direct-clone paths.
async fn finish_fresh_checkout(
    orch: &Arc<SetupOrchestrator>,
    task_id: &str,
    branch_to_fork: Option<&str>,
    controller: &ProcessController,
) -> Result<(), String> {
    if let Some(b) = branch_to_fork {
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
    }
    Ok(())
}

/// A cancelled `git clone` may leave an invalid, non-empty `.git` tree. This
/// function is reached only after `run` has established that `repo_dir` is not
/// a usable repository and the remote probe above has succeeded, so the
/// managed destination must be empty before retrying the clone.
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

    fn git_stdout(dir: &Path, args: &[&str]) -> String {
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
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    /// `--ref-format` landed in git 2.45; probe by using it rather than
    /// parsing version strings (Apple git's suffix, reftable compiled out).
    fn git_supports_reftable() -> bool {
        let tmp = tempfile::tempdir().unwrap();
        Command::new("git")
            .args(["init", "-q", "--ref-format=reftable"])
            .arg(tmp.path())
            .output()
            .is_ok_and(|out| out.status.success())
    }

    /// `git refs` (and its `migrate` subcommand) landed in 2.46. `LC_ALL=C`
    /// because the `usage:` line this greps is localized, and a translated
    /// probe would silently skip the migration tests.
    fn git_supports_refs_migrate() -> bool {
        Command::new("git")
            .args(["refs", "-h"])
            .env("LC_ALL", "C")
            .output()
            .is_ok_and(|out| {
                let text = format!(
                    "{}{}",
                    String::from_utf8_lossy(&out.stdout),
                    String::from_utf8_lossy(&out.stderr)
                );
                text.contains("usage: git refs")
            })
    }

    /// A reftable-backend origin hosting two branches whose names differ only
    /// by letter case — unbuildable on the files backend on the
    /// case-insensitive filesystems macOS ships, which is precisely the
    /// scenario the migration exists for. The colliding branches point at
    /// DIFFERENT commits, deliberately: on an unmigrated files-backend
    /// mirror the missing spelling resolves case-insensitively to its
    /// sibling's loose file, so a same-sha fixture would pass its assertions
    /// with the fix deleted. Returns `(origin, clone_url, main_sha,
    /// fork_sha)` — `Feature/qa` at `main_sha`, `feature/qa` at `fork_sha` —
    /// or `None` when this git predates reftable.
    fn origin_with_case_colliding_branches() -> Option<(tempfile::TempDir, String, String, String)>
    {
        if !git_supports_reftable() {
            return None;
        }
        let root = tempfile::tempdir().unwrap();
        let bare_dir = root.path().join("origin.git");
        let work_dir = root.path().join("author");
        std::fs::create_dir_all(&bare_dir).unwrap();
        std::fs::create_dir_all(&work_dir).unwrap();
        git(
            &bare_dir,
            &["init", "--bare", "-q", "--ref-format=reftable"],
        );
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
        let main_sha = git_stdout(&bare_dir, &["rev-parse", "refs/heads/main"]);
        std::fs::write(work_dir.join("g.txt"), "y").unwrap();
        git(&work_dir, &["add", "."]);
        git(&work_dir, &["commit", "-q", "-m", "fork"]);
        let fork_sha = git_stdout(&work_dir, &["rev-parse", "HEAD"]);
        git(
            &work_dir,
            &["push", "-q", "origin", "HEAD:refs/heads/fork-src"],
        );
        git(
            &bare_dir,
            &["update-ref", "refs/heads/Feature/qa", &main_sha],
        );
        git(
            &bare_dir,
            &["update-ref", "refs/heads/feature/qa", &fork_sha],
        );
        git(&bare_dir, &["update-ref", "-d", "refs/heads/fork-src"]);
        Some((root, bare_str, main_sha, fork_sha))
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
    /// The other tests in this file hand `clone_fresh` a bare filesystem path,
    /// which `canonical_repo_dir` declines to key, so they all exercise the
    /// direct-clone fallback and never touch a worktree. A `file://` URL is
    /// keyable, so this one goes through `ensure_canonical_repo` +
    /// `git worktree add` for real.
    ///
    /// The specific regression: the worktree start point must be a
    /// remote-tracking ref. `refs/heads/*` in the mirror is frozen at clone
    /// time — the fetch refspec only writes `refs/remotes/origin/*` — so
    /// branching from `HEAD` silently produced month-old worktrees.
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
            canonical.join("HEAD").is_file(),
            "bare canonical repo exists"
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

    #[tokio::test]
    async fn fresh_clone_of_a_missing_remote_branch_forks_locally_and_logs_it() {
        let (_origin, clone_url) = bare_repo_with_one_commit();
        let (_workdir, repo_dir) = empty_repo_dir();
        let orch = fresh_orch(repo_dir.clone());

        let config = json!({
            "git": { "repository": { "cloneUrl": clone_url, "branch": "does-not-exist-on-remote" } }
        });
        assert!(
            run(&orch, &config).await,
            "clone must still succeed (local fork)"
        );

        let transcript = orch
            .tasks
            .logs()
            .tail_read(&app_key("setup"), DEFAULT_TAIL_BYTES)
            .await;
        assert!(
            transcript.contains("not on origin; creating it from origin's default branch"),
            "transcript: {transcript:?}"
        );

        let out = Command::new("git")
            .args(["rev-parse", "--abbrev-ref", "HEAD"])
            .current_dir(&repo_dir)
            .output()
            .unwrap();
        assert_eq!(
            String::from_utf8_lossy(&out.stdout).trim(),
            "does-not-exist-on-remote"
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

    /// A fresh shared mirror comes up on the reftable backend (case-collision
    /// immunity from day one) — and on a git without reftable, the fallback
    /// clone still succeeds on the files backend, which every other test in
    /// this module implicitly covers.
    #[tokio::test]
    async fn fresh_mirror_uses_the_reftable_backend_when_git_supports_it() {
        let (origin_root, bare_str) = bare_repo_with_one_commit();
        let (workdir, repo_dir) = empty_repo_dir();
        let orch = fresh_orch(repo_dir.clone());
        let clone_url = format!("file://{bare_str}");

        assert!(
            clone_fresh(&orch, &clone_url, Some("main")).await,
            "{:?}",
            orch.tasks
                .logs()
                .tail_read(&app_key("setup"), DEFAULT_TAIL_BYTES)
                .await
        );

        if git_supports_reftable() {
            let canonical =
                crate::sandbox::repo_store::canonical_repo_dir(&orch.app_root, &clone_url).unwrap();
            assert_eq!(
                git_stdout(&canonical, &["rev-parse", "--show-ref-format"]),
                "reftable"
            );
        }
        drop((origin_root, workdir));
    }

    /// The upgrade path for mirrors that predate the reftable default: a
    /// files-backend mirror whose remote grows two branches differing only by
    /// case. On a case-insensitive filesystem the fetch fails with git's
    /// collision refusal, the mirror is migrated to reftable, and the retried
    /// fetch lands BOTH refs; on a case-sensitive filesystem the fetch simply
    /// succeeds. Either way the sandbox acquires the checkout and both remote
    /// branches resolve.
    #[tokio::test]
    async fn case_colliding_remote_branches_survive_on_a_files_backend_mirror() {
        if !git_supports_refs_migrate() {
            return;
        }
        let Some((origin_root, bare_str, main_sha, fork_sha)) =
            origin_with_case_colliding_branches()
        else {
            return;
        };
        let (workdir, repo_dir) = empty_repo_dir();
        let orch = fresh_orch(repo_dir.clone());
        let clone_url = format!("file://{bare_str}");

        // Pre-create the mirror on the FILES backend — the state every
        // install that predates the reftable default is in. The clone itself
        // survives colliding refs (they land in packed-refs, one file); the
        // collision only bites when a FETCH writes them as loose files.
        let canonical = files_backend_mirror(&orch, &clone_url, &bare_str);

        assert!(
            clone_fresh(&orch, &clone_url, Some("main")).await,
            "{:?}",
            orch.tasks
                .logs()
                .tail_read(&app_key("setup"), DEFAULT_TAIL_BYTES)
                .await
        );

        // The user-visible guarantee, independent of filesystem case
        // sensitivity: after acquisition BOTH case-colliding branches exist
        // in the mirror, EACH at its own commit. Per-spelling shas rather
        // than mutual equality — on an unmigrated files-backend mirror the
        // missing spelling resolves case-insensitively to its sibling's
        // loose file, so an equality assert would pass with the fix deleted.
        assert_eq!(
            git_stdout(
                &canonical,
                &["rev-parse", "--verify", "refs/remotes/origin/Feature/qa"]
            ),
            main_sha
        );
        assert_eq!(
            git_stdout(
                &canonical,
                &["rev-parse", "--verify", "refs/remotes/origin/feature/qa"]
            ),
            fork_sha
        );
        drop((origin_root, workdir));
    }

    /// Pre-creates the canonical mirror on the files backend with the
    /// production fetch refspec — the on-disk state of every install that
    /// predates the reftable default.
    fn files_backend_mirror(
        orch: &Arc<SetupOrchestrator>,
        clone_url: &str,
        bare_str: &str,
    ) -> std::path::PathBuf {
        let canonical =
            crate::sandbox::repo_store::canonical_repo_dir(&orch.app_root, clone_url).unwrap();
        std::fs::create_dir_all(canonical.parent().unwrap()).unwrap();
        let out = Command::new("git")
            .args(["clone", "--bare", "-q", "--ref-format=files", bare_str])
            .arg(&canonical)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        git(
            &canonical,
            &[
                "config",
                "remote.origin.fetch",
                "+refs/heads/*:refs/remotes/origin/*",
            ],
        );
        canonical
    }

    /// The path production actually sits on: the files-backend mirror has a
    /// LIVE worktree (every sandbox is one), which makes `git refs migrate`
    /// refuse on every released git. Acquisition must still land the
    /// requested colliding branch at its true commit via the narrow
    /// single-branch fetch — and on a case-sensitive filesystem the full
    /// fetch simply succeeds, so the same assertions hold everywhere.
    #[tokio::test]
    async fn a_live_worktree_blocks_migration_but_the_requested_branch_still_lands() {
        let Some((origin_root, bare_str, main_sha, fork_sha)) =
            origin_with_case_colliding_branches()
        else {
            return;
        };
        let (workdir, repo_dir) = empty_repo_dir();
        let orch = fresh_orch(repo_dir.clone());
        let clone_url = format!("file://{bare_str}");
        let canonical = files_backend_mirror(&orch, &clone_url, &bare_str);

        // A blocking LIVE worktree, registered the way a sibling sandbox's
        // acquisition would have.
        let blocker = workdir.path().join("blocker");
        git(
            &canonical,
            &[
                "worktree",
                "add",
                "--detach",
                blocker.to_str().unwrap(),
                &main_sha,
            ],
        );

        assert!(
            clone_fresh(&orch, &clone_url, Some("feature/qa")).await,
            "{:?}",
            orch.tasks
                .logs()
                .tail_read(&app_key("setup"), DEFAULT_TAIL_BYTES)
                .await
        );

        // The requested spelling holds ITS commit — not the wrong-cased
        // sibling's — and the checkout is cut from it.
        assert_eq!(
            git_stdout(
                &canonical,
                &["rev-parse", "--verify", "refs/remotes/origin/feature/qa"]
            ),
            fork_sha
        );
        assert_eq!(git_stdout(&repo_dir, &["rev-parse", "HEAD"]), fork_sha);
        drop((origin_root, workdir));
    }
}
