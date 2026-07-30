//! Workdir-based package-manager detection for sandboxes whose config names
//! no `application.packageManager`.
//!
//! "Import from GitHub" deliberately writes no `metadata.runtime` — it relies
//! on the control plane's `SANDBOX_START` lockfile probe
//! (`apps/api/src/shared/github-runtime-detect.ts`). The desktop app never
//! calls that tool: `routes/intercept/sandbox_lifecycle.rs` answers
//! `SANDBOX_START` locally from `metadata.runtime.selected` alone, so every
//! fresh import used to come up clone-only and die in `setup/dev.rs` with
//! "no package manager configured". The desktop has something the remote
//! probe never had — the cloned repository on disk — so when the config is
//! silent, sniff the checkout instead of failing.
//!
//! [`DETECTION_ORDER`] mirrors the server probe's `LOCKFILES` list
//! (first match wins, bare `package.json` defaults to bun) so both providers
//! agree on the runtime for the same repository. Detection only ever FILLS AN
//! ABSENCE: a `packageManager` already present in the config — user-pinned in
//! the VM's runtime card, or persisted from an earlier run — is never
//! overridden.

use std::path::Path;
use std::sync::Arc;

use serde_json::{json, Value};

use super::SetupOrchestrator;
use crate::log_store::app_key;

/// Byte-parity with `github-runtime-detect.ts::LOCKFILES` — ordered,
/// first match wins.
const DETECTION_ORDER: [(&str, &str); 8] = [
    ("deno.json", "deno"),
    ("deno.jsonc", "deno"),
    ("bun.lock", "bun"),
    ("bunfig.toml", "bun"),
    ("pnpm-lock.yaml", "pnpm"),
    ("yarn.lock", "yarn"),
    ("package-lock.json", "npm"),
    ("package.json", "bun"),
];

/// `metadata.runtime.selected` names a package manager; `application.runtime`
/// wants the JS runtime that drives it. Byte-parity with
/// `packages/shared/src/runtime-defaults.ts::PACKAGE_MANAGER_CONFIG[pm].runtime`.
pub(crate) fn runtime_for_package_manager(package_manager: &str) -> Option<&'static str> {
    match package_manager {
        "npm" | "pnpm" | "yarn" => Some("node"),
        "bun" => Some("bun"),
        "deno" => Some("deno"),
        _ => None,
    }
}

/// First [`DETECTION_ORDER`] marker present at the repository root, or `None`
/// for a repo no supported package manager claims (clone-only stays
/// clone-only).
fn detect_from_workdir(repo_dir: &Path) -> Option<(&'static str, &'static str)> {
    DETECTION_ORDER
        .iter()
        .find(|(marker, _)| repo_dir.join(marker).is_file())
        .map(|&(marker, pm)| (pm, marker))
}

/// Returns `config` with `application.packageManager.name` guaranteed-if-
/// detectable: when the config already names one, or the workdir names none,
/// the input is returned unchanged; otherwise the orchestrator's
/// [`crate::config::ConfigStore`] is patched with the detected package
/// manager (+ runtime, unless one is already pinned) and the refreshed
/// config is returned.
///
/// The pipeline's own steps are serial per sandbox, but the workdir's WRITER
/// is not always on that worker — `SandboxManager::ensure` runs the clone
/// inline — so detection refuses to sniff while an acquisition task is still
/// running (see [`acquisition_in_flight`]). The patch is deliberately NOT
/// written back to the sandbox registry row or sidecar: detection is a pure
/// function of the checkout, so a restarted process simply re-detects after
/// clone. (Note the registry's own semantics cut the other way: once a USER
/// pin has been persisted there, `merge_durable_config` resurrects it on
/// every later sparse dispatch, so clearing a pin never returns a sandbox to
/// auto-detection — a pre-existing gap this module inherits rather than
/// fixes.)
pub(super) async fn ensure_package_manager(orch: &Arc<SetupOrchestrator>, config: &Value) -> Value {
    // Freshest snapshot, not the caller's argument: the caller's value was
    // read when the step was scheduled, and a user pin applied since then
    // must win. (The store has no compare-and-swap, so a pin landing between
    // this read and the patch below can still lose — but the window is a few
    // file stats wide instead of a whole pipeline step.)
    let config = orch.current_config().unwrap_or_else(|| config.clone());
    let configured = crate::config::get_str(&config, &["application", "packageManager", "name"])
        .filter(|name| !name.is_empty());
    if configured.is_some() {
        return config;
    }

    // Only a git-backed sandbox has a checkout worth sniffing. A blank
    // sandbox's repo_dir can still contain leftover files from an earlier
    // tenancy of a shared directory — never promote those into a workload.
    if crate::config::get_str(&config, &["git", "repository", "cloneUrl"])
        .filter(|url| !url.is_empty())
        .is_none()
    {
        return config;
    }

    // A clone/checkout in flight means repo_dir is mid-population: marker
    // files appear one by one (git writes the index in sorted order, so
    // `package.json` lands well before `pnpm-lock.yaml`), and a sniff now
    // could latch the wrong manager until restart — detection only ever
    // fills an absence. The acquiring task is finalized before Install/Start
    // resume, so the pipeline's own steps never find this gate closed.
    if acquisition_in_flight(orch) {
        return config;
    }

    // Detect where install/dev will actually run: a configured
    // `packageManager.path` scopes both to a subdirectory. An invalid path
    // means those steps are about to fail with their own diagnostic — don't
    // guess a workload from the wrong directory in the meantime.
    let root = match super::install::pm_root(&config, &orch.repo_dir).await {
        Ok(root) => root,
        Err(_) => return config,
    };
    let Some((pm, marker)) = detect_from_workdir(&root) else {
        return config;
    };

    let mut application = json!({ "packageManager": { "name": pm } });
    let runtime_pinned = crate::config::get_str(&config, &["application", "runtime"])
        .filter(|runtime| !runtime.is_empty())
        .is_some();
    if !runtime_pinned {
        if let Some(runtime) = runtime_for_package_manager(pm) {
            application["runtime"] = json!(runtime);
        }
    }
    if let Err(error) = orch.config.patch(json!({ "application": application })) {
        // A failed patch (e.g. racing identity conflict) must not fail the
        // step — the caller just proceeds with the config it had, and
        // `dev::run` still diagnoses the missing package manager.
        emit(
            orch,
            &format!(
                "[runtime] detected '{pm}' but could not apply it: {}\r\n",
                error.body
            ),
        )
        .await;
        return config;
    }

    emit(
        orch,
        &format!("[runtime] no package manager configured; detected '{pm}' from {marker}\r\n"),
    )
    .await;

    orch.current_config().unwrap_or(config)
}

/// A running clone/checkout task means the workdir is being populated right
/// now. Command strings are the ones `setup/clone.rs` registers
/// (`"git clone <url>"` / `"git checkout <branch>"`) — matched on the prefix
/// so a URL or branch never confuses the check.
fn acquisition_in_flight(orch: &Arc<SetupOrchestrator>) -> bool {
    orch.tasks
        .list(Some(&[crate::tasks::TaskStatus::Running]))
        .iter()
        .any(|task| {
            task.command.starts_with("git clone ") || task.command.starts_with("git checkout ")
        })
}

/// Appends to the combined `"setup"` transcript + live `"log"` frame — the
/// same untracked-probe path `clone.rs::emit_chunk` uses for `task_id: None`
/// (detection has no registered task of its own to attribute output to).
async fn emit(orch: &Arc<SetupOrchestrator>, text: &str) {
    orch.tasks.logs().append(&app_key("setup"), text).await;
    orch.broadcaster
        .emit("log", json!({ "source": "setup", "data": text }));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::ConfigStore;
    use crate::events::Broadcaster;
    use crate::log_store::LogStore;
    use crate::tasks::TaskRegistry;
    use std::path::PathBuf;

    fn orchestrator(repo_dir: PathBuf, root: &Path) -> Arc<SetupOrchestrator> {
        let logs = Arc::new(LogStore::new(root.join("logs")));
        SetupOrchestrator::new(
            repo_dir,
            root.to_path_buf(),
            Arc::new(ConfigStore::new()),
            Arc::new(TaskRegistry::new(logs)),
            Arc::new(Broadcaster::new()),
        )
    }

    fn repo_with(files: &[&str]) -> (tempfile::TempDir, PathBuf) {
        let root = tempfile::tempdir().unwrap();
        let repo = root.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        for file in files {
            std::fs::write(repo.join(file), "{}").unwrap();
        }
        (root, repo)
    }

    #[test]
    fn detection_order_is_first_match_wins() {
        let (_root, repo) = repo_with(&["package.json", "deno.json"]);
        assert_eq!(detect_from_workdir(&repo), Some(("deno", "deno.json")));

        let (_root, repo) = repo_with(&["yarn.lock", "bun.lock"]);
        assert_eq!(detect_from_workdir(&repo), Some(("bun", "bun.lock")));

        let (_root, repo) = repo_with(&["package-lock.json", "package.json"]);
        assert_eq!(
            detect_from_workdir(&repo),
            Some(("npm", "package-lock.json"))
        );
    }

    #[test]
    fn bare_package_json_defaults_to_bun() {
        let (_root, repo) = repo_with(&["package.json"]);
        assert_eq!(detect_from_workdir(&repo), Some(("bun", "package.json")));
    }

    #[test]
    fn empty_repo_detects_nothing() {
        let (_root, repo) = repo_with(&[]);
        assert_eq!(detect_from_workdir(&repo), None);
    }

    #[test]
    fn directories_named_like_markers_do_not_count() {
        let (_root, repo) = repo_with(&[]);
        std::fs::create_dir_all(repo.join("deno.json")).unwrap();
        assert_eq!(detect_from_workdir(&repo), None);
    }

    #[tokio::test]
    async fn fills_missing_package_manager_and_runtime_from_the_workdir() {
        let (root, repo) = repo_with(&["pnpm-lock.yaml"]);
        let orch = orchestrator(repo, root.path());
        orch.config
            .patch(json!({ "git": { "repository": { "cloneUrl": "https://example.com/r.git" } } }))
            .unwrap();
        let config = orch.current_config().unwrap();

        let enriched = ensure_package_manager(&orch, &config).await;

        assert_eq!(
            crate::config::get_str(&enriched, &["application", "packageManager", "name"]),
            Some("pnpm")
        );
        assert_eq!(
            crate::config::get_str(&enriched, &["application", "runtime"]),
            Some("node")
        );
        // The orchestrator's own store carries the patch, so install/dev
        // re-reading current_config() see the same thing.
        assert_eq!(
            crate::config::get_str(
                &orch.current_config().unwrap(),
                &["application", "packageManager", "name"]
            ),
            Some("pnpm")
        );
    }

    #[tokio::test]
    async fn a_configured_package_manager_is_never_overridden() {
        let (root, repo) = repo_with(&["deno.json"]);
        let orch = orchestrator(repo, root.path());
        orch.config
            .patch(json!({
                "git": { "repository": { "cloneUrl": "https://example.com/r.git" } },
                "application": { "packageManager": { "name": "yarn" }, "runtime": "node" },
            }))
            .unwrap();
        let config = orch.current_config().unwrap();

        let enriched = ensure_package_manager(&orch, &config).await;

        assert_eq!(
            crate::config::get_str(&enriched, &["application", "packageManager", "name"]),
            Some("yarn")
        );
    }

    #[tokio::test]
    async fn detection_waits_out_a_running_acquisition() {
        use crate::tasks::{now_ms, TaskEntry, TaskStatus, TaskSummary};

        let (root, repo) = repo_with(&["bun.lock"]);
        let orch = orchestrator(repo, root.path());
        orch.config
            .patch(json!({ "git": { "repository": { "cloneUrl": "https://example.com/r.git" } } }))
            .unwrap();
        orch.tasks.insert(TaskEntry::new(
            TaskSummary {
                id: "clone-task".to_string(),
                command: "git clone https://example.com/r.git".to_string(),
                status: TaskStatus::Running,
                exit_code: None,
                started_at: now_ms(),
                finished_at: None,
                timed_out: false,
                truncated: false,
                log_name: Some("setup".to_string()),
                intentional: None,
            },
            None,
        ));
        let config = orch.current_config().unwrap();

        let enriched = ensure_package_manager(&orch, &config).await;

        // A half-populated checkout must never be sniffed: the clone task is
        // still running, so the config stays workload-less until it isn't.
        assert!(
            crate::config::get_str(&enriched, &["application", "packageManager", "name"]).is_none()
        );
    }

    #[tokio::test]
    async fn detection_respects_a_scoped_package_manager_path() {
        let (root, repo) = repo_with(&["package.json"]);
        std::fs::create_dir_all(repo.join("web")).unwrap();
        std::fs::write(repo.join("web/deno.json"), "{}").unwrap();
        let orch = orchestrator(repo, root.path());
        orch.config
            .patch(json!({
                "git": { "repository": { "cloneUrl": "https://example.com/r.git" } },
                "application": { "packageManager": { "path": "web" } },
            }))
            .unwrap();
        let config = orch.current_config().unwrap();

        let enriched = ensure_package_manager(&orch, &config).await;

        // Install/dev run in `web/`, so detection must read `web/deno.json`,
        // not the repo root's bare package.json (which would say bun).
        assert_eq!(
            crate::config::get_str(&enriched, &["application", "packageManager", "name"]),
            Some("deno")
        );
        assert_eq!(
            crate::config::get_str(&enriched, &["application", "runtime"]),
            Some("deno")
        );
    }

    #[tokio::test]
    async fn a_blank_sandbox_never_promotes_leftover_files() {
        let (root, repo) = repo_with(&["package.json"]);
        let orch = orchestrator(repo, root.path());
        let config = json!({ "operator": { "userName": "Op", "userEmail": "op@example.com" } });

        let enriched = ensure_package_manager(&orch, &config).await;

        // No git.repository -> nothing was cloned here; whatever files sit in
        // the directory belong to no workload this sandbox declared.
        assert!(
            crate::config::get_str(&enriched, &["application", "packageManager", "name"]).is_none()
        );
    }

    #[tokio::test]
    async fn a_pinned_runtime_survives_detection() {
        let (root, repo) = repo_with(&["bun.lock"]);
        let orch = orchestrator(repo, root.path());
        orch.config
            .patch(json!({
                "git": { "repository": { "cloneUrl": "https://example.com/r.git" } },
                "application": { "runtime": "node" },
            }))
            .unwrap();
        let config = orch.current_config().unwrap();

        let enriched = ensure_package_manager(&orch, &config).await;

        assert_eq!(
            crate::config::get_str(&enriched, &["application", "packageManager", "name"]),
            Some("bun")
        );
        // Only the ABSENT field is filled: the explicitly configured runtime
        // is not rewritten to bun.lock's implied runtime.
        assert_eq!(
            crate::config::get_str(&enriched, &["application", "runtime"]),
            Some("node")
        );
    }

    #[tokio::test]
    async fn an_undetectable_repo_leaves_the_config_untouched() {
        let (root, repo) = repo_with(&[]);
        let orch = orchestrator(repo, root.path());
        orch.config
            .patch(json!({ "git": { "repository": { "cloneUrl": "https://example.com/r.git" } } }))
            .unwrap();
        let config = orch.current_config().unwrap();

        let enriched = ensure_package_manager(&orch, &config).await;

        assert!(
            crate::config::get_str(&enriched, &["application", "packageManager", "name"]).is_none()
        );
    }
}
