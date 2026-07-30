//! Install step — byte-parity target: `daemon/setup/install.ts` (argv +
//! manifest-gating only; the deps-cache/golden-cache machinery is dropped,
//! see the `setup` module's doc comment). Runs the package manager's install
//! command when a manifest is present; broadcasts the discovered script set
//! exactly when the TS source does — ONLY when a package manager is
//! configured (byte-parity with `stepInstall`'s `if (!pm) { return true; }`
//! early-return-WITHOUT-broadcasting branch; the manifest-absent case still
//! broadcasts an empty `[]`, matching `spawnInstall` returning `null` ->
//! `markInstallSucceeded` still runs).

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::Value;
use tokio::io::AsyncReadExt;

use super::SetupOrchestrator;
use crate::process_group::ProcessGroupChild;
use crate::process_util::{classify_status, exit_status_to_code};
use crate::routes::scripts::discover_scripts;
use crate::tasks::{now_ms, OutputStream, ProcessController, TaskEntry, TaskStatus, TaskSummary};

/// Resolves the package-manager cwd inside `repo_dir`. Config validation
/// rejects lexical escapes; canonicalization here also rejects symlinks that
/// point outside the repository before install/dev hands the path to a child.
/// `pub(super)`: shared with `setup/dev.rs` so both operations enforce the
/// same boundary.
pub(super) async fn pm_root(config: &Value, repo_dir: &Path) -> Result<PathBuf, String> {
    let Some(path) = crate::config::get_str(config, &["application", "packageManager", "path"])
        .filter(|s| !s.is_empty())
    else {
        return Ok(repo_dir.to_path_buf());
    };

    crate::config::validate::validate_package_manager_path(path)?;
    let canonical_repo = tokio::fs::canonicalize(repo_dir).await.map_err(|error| {
        format!(
            "cannot resolve repository root {}: {error}",
            repo_dir.display()
        )
    })?;
    let candidate = repo_dir.join(path);
    let canonical_candidate = tokio::fs::canonicalize(&candidate).await.map_err(|error| {
        format!(
            "packageManager.path does not resolve inside the repository ({}): {error}",
            candidate.display()
        )
    })?;
    if !canonical_candidate.starts_with(&canonical_repo) {
        return Err("packageManager.path resolves outside the repository".to_string());
    }
    let metadata = tokio::fs::metadata(&canonical_candidate)
        .await
        .map_err(|error| format!("cannot inspect packageManager.path: {error}"))?;
    if !metadata.is_dir() {
        return Err("packageManager.path must resolve to a directory".to_string());
    }
    Ok(canonical_candidate)
}

/// Byte-parity with `PACKAGE_MANAGER_DAEMON_CONFIG[pm].manifests` gating in
/// `spawnInstall`. `pub(super)`: reused by `setup/dev.rs`'s
/// `diagnose_no_start_command`.
pub(super) fn manifest_present(pm: &str, root: &Path) -> bool {
    match pm {
        "deno" => ["deno.json", "deno.jsonc", "package.json"]
            .iter()
            .any(|f| root.join(f).exists()),
        _ => root.join("package.json").exists(),
    }
}

/// Byte-parity with `PACKAGE_MANAGER_DAEMON_CONFIG[pm].installArgv`. `deno`
/// has none — it auto-fetches on first `deno task` (no separate install
/// step, matching the TS source's comment on why `deno` has no
/// `installArgv`).
fn install_argv(pm: &str) -> Option<&'static [&'static str]> {
    match pm {
        "npm" => Some(&["npm", "install"]),
        "pnpm" => Some(&["pnpm", "install"]),
        "yarn" => Some(&["yarn", "install"]),
        "bun" => Some(&["bun", "install"]),
        _ => None,
    }
}

/// Returns `true` on success (including "nothing configured"/"nothing to
/// install" — both forward progress); `false` only when the install command
/// itself exits non-zero, after transitioning `lifecycle` to
/// `install-failed`.
pub(super) async fn run(orch: &Arc<SetupOrchestrator>, config: &Value) -> bool {
    // A config that names no package manager may still be a detectable
    // repository — the clone step just put its files on disk. Fill the
    // absence before deciding to skip; see `setup/detect_runtime.rs`.
    let config = &super::detect_runtime::ensure_package_manager(orch, config).await;
    let Some(pm) = crate::config::get_str(config, &["application", "packageManager", "name"])
        .filter(|s| !s.is_empty())
    else {
        // No package manager configured — proceed to start, which will
        // diagnose. Byte-parity: `stepInstall` returns `true` here WITHOUT
        // calling `broadcastDiscoveredScripts`, so `discovered_scripts`
        // stays `None` (the SSE handshake then omits the `"scripts"` frame
        // entirely, matching the daemon's `if (scripts) ...` guard on a
        // still-`null` `latestScripts`).
        return true;
    };

    orch.transition_lifecycle(serde_json::json!({ "phase": "installing" }));

    let root = match pm_root(config, &orch.repo_dir).await {
        Ok(root) => root,
        Err(error) => {
            orch.transition_lifecycle(super::install_failed(error));
            return false;
        }
    };
    if manifest_present(pm, &root) {
        if let Some(argv) = install_argv(pm) {
            match run_install_cmd(orch, argv, &root).await {
                Ok(Some(true)) => {}
                Ok(Some(false)) => {
                    orch.transition_lifecycle(super::install_failed("install command failed"));
                    return false;
                }
                Ok(None) => return false,
                Err(e) => {
                    orch.transition_lifecycle(super::install_failed(format!(
                        "install command failed: {e}"
                    )));
                    return false;
                }
            }
        }
        // `deno`: no install argv — auto-fetches lazily at `deno task` time.
    }
    // No manifest at all: skip the install command entirely (byte-parity —
    // `spawnInstall` returns `null`, the caller treats that as success).

    let scripts = discover_scripts(&root, Some(pm));
    orch.mark_discovered_scripts(scripts);
    true
}

/// Spawns the install command, piping its stdout/stderr into `"log"` SSE
/// frames (`{source: "setup", data: <raw text>}` — the drawer's default tab)
/// so the install phase is observable in the preview terminal, then waits for
/// exit. Registers a "setup" task (like `setup/dev.rs`) so the output is stored
/// for replay on a late SSE connect and shutdown can terminate its whole
/// process group. Emits RAW text; the frontend normalizes `\r\n`.
async fn run_install_cmd(
    orch: &Arc<SetupOrchestrator>,
    argv: &[&str],
    cwd: &Path,
) -> Result<Option<bool>, String> {
    let (cmd, args) = argv
        .split_first()
        .ok_or_else(|| "empty install argv".to_string())?;
    // Register a "setup" task so the install output is STORED (file-backed —
    // see `crate::log_store::LogStore` and `tasks/registry.rs`'s module doc) and
    // can therefore be REPLAYED by `/_sandbox/events` on connect — a terminal
    // opened after install ran would otherwise show a blank Setup tab.
    // `log_name` = "setup" matches the drawer default tab and the
    // `emit("log", {source:"setup"})` frames below. Register BEFORE spawn:
    // shutdown can reject this task or durably signal it before a pid exists.
    let task_id = orch.tasks.next_id();
    let controller = ProcessController::new();
    if !orch.register_task(TaskEntry::new(
        TaskSummary {
            id: task_id.clone(),
            command: argv.join(" "),
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
        return Ok(None);
    }
    if let Some(signal) = controller.requested() {
        orch.tasks
            .finalize(&task_id, TaskStatus::Killed, signal.exit_code(), false);
        return Ok(None);
    }

    let mut command = tokio::process::Command::new(cmd);
    command
        .args(args)
        .current_dir(cwd)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    let mut child =
        match ProcessGroupChild::spawn(&mut command, orch.tasks.child_lifetime_lock_path()).await {
            Ok(child) => child,
            Err(error) => {
                orch.tasks.finalize(&task_id, TaskStatus::Failed, -1, false);
                return Err(format!("{cmd}: {error}"));
            }
        };
    let (Some(mut stdout_pipe), Some(mut stderr_pipe)) = (child.take_stdout(), child.take_stderr())
    else {
        child.signal(crate::tasks::KillSignal::Kill).await;
        let _ = child.wait().await;
        orch.tasks.finalize(&task_id, TaskStatus::Failed, -1, false);
        return Err(format!("{cmd}: missing stdio pipe"));
    };

    let mut stdout_open = true;
    let mut stderr_open = true;
    let mut exited = false;
    let mut exit_status: Option<std::process::ExitStatus> = None;
    let mut so_chunk = [0u8; 8192];
    let mut se_chunk = [0u8; 8192];
    let mut observed_signal = None;

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
                        orch.tasks
                            .append_log(&task_id, "setup", OutputStream::Stdout, &text, &orch.broadcaster)
                            .await;
                    }
                }
            }
            res = stderr_pipe.read(&mut se_chunk), if stderr_open => {
                match res {
                    Ok(0) | Err(_) => stderr_open = false,
                    Ok(n) => {
                        let text = String::from_utf8_lossy(&se_chunk[..n]).into_owned();
                        orch.tasks
                            .append_log(&task_id, "setup", OutputStream::Stderr, &text, &orch.broadcaster)
                            .await;
                    }
                }
            }
            status = child.wait(), if !exited && !stdout_open && !stderr_open => {
                exited = true;
                exit_status = status.ok();
            }
            signal = controller.wait_for_change(observed_signal), if !exited => {
                observed_signal = Some(signal);
                child.signal(signal).await;
            }
        }
    }

    // Finalize the "setup" task so its stored output stops reading as a live
    // Running process (the file-backed output is preserved for replay either
    // way). A coordinated shutdown can classify it as killed; setup itself
    // never applies a timeout, so `timed_out` is always false.
    let raw_exit_code = exit_status.map(exit_status_to_code).unwrap_or(-1);
    let status = classify_status(false, raw_exit_code);
    orch.tasks.finalize(&task_id, status, raw_exit_code, false);

    if controller.requested().is_some() {
        Ok(None)
    } else {
        Ok(Some(exit_status.map(|s| s.success()).unwrap_or(false)))
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use serde_json::json;
    use std::time::Duration;

    use crate::config::ConfigStore;
    use crate::events::Broadcaster;
    use crate::log_store::LogStore;
    use crate::tasks::TaskRegistry;

    fn test_orchestrator(repo_dir: PathBuf, root: &Path) -> Arc<SetupOrchestrator> {
        let logs = Arc::new(LogStore::new(root.join("logs")));
        SetupOrchestrator::new(
            repo_dir.clone(),
            repo_dir,
            Arc::new(ConfigStore::new()),
            Arc::new(TaskRegistry::new(logs)),
            Arc::new(Broadcaster::new()),
        )
    }

    #[tokio::test]
    async fn a_detectable_repo_installs_without_a_configured_package_manager() {
        let root = tempfile::tempdir().unwrap();
        let repo = root.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        // npm deliberately: it is the one detected manager whose binary the
        // CI image (and any Node toolchain) reliably ships. An empty
        // manifest keeps the real `npm install` offline and instant.
        std::fs::write(repo.join("package.json"), "{}").unwrap();
        std::fs::write(repo.join("package-lock.json"), "{}").unwrap();
        let orch = test_orchestrator(repo.clone(), root.path());
        orch.config
            .patch(json!({ "git": { "repository": { "cloneUrl": "https://example.com/r.git" } } }))
            .unwrap();
        let config = orch.current_config().unwrap();

        // The regression this whole module exists for: a fresh import ships
        // no packageManager, and Install used to skip silently on it.
        assert!(run(&orch, &config).await);

        assert_eq!(
            crate::config::get_str(
                &orch.current_config().unwrap(),
                &["application", "packageManager", "name"]
            ),
            Some("npm"),
            "detection must land in the store the next step re-reads"
        );
    }

    #[tokio::test]
    async fn package_manager_root_resolves_repo_relative_directory() {
        let root = tempfile::tempdir().unwrap();
        let repo = root.path().join("repo");
        let app = repo.join("apps/web");
        std::fs::create_dir_all(&app).unwrap();
        let config = json!({
            "application": {"packageManager": {"name": "bun", "path": "apps/web"}}
        });

        assert_eq!(
            pm_root(&config, &repo).await.unwrap(),
            app.canonicalize().unwrap()
        );
    }

    #[tokio::test]
    async fn package_manager_root_rejects_symlink_escape() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().unwrap();
        let repo = root.path().join("repo");
        let outside = root.path().join("outside");
        std::fs::create_dir_all(&repo).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        symlink(&outside, repo.join("escaped")).unwrap();
        let config = json!({
            "application": {"packageManager": {"name": "bun", "path": "escaped"}}
        });

        let error = pm_root(&config, &repo).await.unwrap_err();
        assert!(error.contains("resolves outside the repository"));
    }

    #[tokio::test]
    async fn install_fails_before_spawn_when_package_manager_path_escapes_by_symlink() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().unwrap();
        let repo = root.path().join("repo");
        let outside = root.path().join("outside");
        std::fs::create_dir_all(&repo).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("package.json"), r#"{"scripts":{}}"#).unwrap();
        symlink(&outside, repo.join("escaped")).unwrap();
        let orch = test_orchestrator(repo, root.path());
        let config = json!({
            "application": {"packageManager": {"name": "bun", "path": "escaped"}}
        });

        assert!(!run(&orch, &config).await);
        assert_eq!(orch.tasks.list(None).len(), 0);
        assert_eq!(orch.lifecycle_snapshot()["phase"], json!("install-failed"));
    }

    #[tokio::test]
    async fn shutdown_escalates_and_reaps_a_term_resistant_install_group() {
        let root = tempfile::tempdir().unwrap();
        let repo_dir = root.path().join("repo");
        std::fs::create_dir_all(&repo_dir).unwrap();
        let logs = Arc::new(LogStore::new(root.path().join("logs")));
        let orch = SetupOrchestrator::new(
            repo_dir.clone(),
            repo_dir.clone(),
            Arc::new(ConfigStore::new()),
            Arc::new(TaskRegistry::new(logs)),
            Arc::new(Broadcaster::new()),
        );
        let ready = root.path().join("install-child-ready");
        let ready_arg = ready.to_string_lossy().into_owned();

        let owner = {
            let orch = orch.clone();
            tokio::spawn(async move {
                run_install_cmd(
                    &orch,
                    &[
                        "sh",
                        "-c",
                        "trap '' TERM; : > \"$0\"; while :; do sleep 1; done",
                        &ready_arg,
                    ],
                    &repo_dir,
                )
                .await
            })
        };
        tokio::time::timeout(Duration::from_secs(1), async {
            while !ready.exists() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("TERM-resistant install process reached its ready marker");

        let result = orch
            .shutdown(Duration::from_millis(50), Duration::from_secs(2))
            .await;
        assert_eq!(result.tasks.initially_running, 1);
        assert_eq!(result.tasks.term_signaled, 1);
        assert_eq!(result.tasks.kill_signaled, 1);
        assert!(result.tasks.remaining.is_empty());
        assert_eq!(
            owner.await.unwrap().unwrap(),
            None,
            "shutdown cancellation is not reported as install failure"
        );
    }
}
