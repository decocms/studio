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
/// manager + runtime and the refreshed config is returned.
///
/// Runs inside the setup pipeline (install/dev), which is serial per
/// sandbox, so the patch lands before either step reads the config — no
/// coordination with `SandboxManager` is needed. The patch is deliberately
/// NOT written back to the sandbox registry row or sidecar: detection is a
/// pure function of the checkout, so a restarted process simply re-detects
/// after clone, and a sparse durable record keeps meaning "nothing pinned".
pub(super) async fn ensure_package_manager(orch: &Arc<SetupOrchestrator>, config: &Value) -> Value {
    let configured = crate::config::get_str(config, &["application", "packageManager", "name"])
        .filter(|name| !name.is_empty());
    if configured.is_some() {
        return config.clone();
    }

    let Some((pm, marker)) = detect_from_workdir(&orch.repo_dir) else {
        return config.clone();
    };

    let mut application = json!({ "packageManager": { "name": pm } });
    if let Some(runtime) = runtime_for_package_manager(pm) {
        application["runtime"] = json!(runtime);
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
        return config.clone();
    }

    emit(
        orch,
        &format!("[runtime] no package manager configured; detected '{pm}' from {marker}\r\n"),
    )
    .await;

    orch.current_config().unwrap_or_else(|| config.clone())
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
