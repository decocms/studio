//! Small on-disk persistence helpers for [`super::manager::SandboxManager`] —
//! survives a backend process restart so a per-handle git sandbox
//! (workdir + git history, already durable — see this crate's `log_store`
//! module doc for the analogous "files are the source of truth" argument
//! for retained logs) can be RESURRECTED instead of orphaned. The in-memory
//! `SandboxManager::sandboxes` map (and `active_handle`) are process-lifetime
//! only (see that module's doc comment) — a real sandbox's clone lives on
//! disk under `<app_root>/worktrees/<handle>/repo` for as long as the user's
//! laptop keeps the directory. Two small sidecar files close the gap between
//! "the workdir survives" and "the process remembers what it's for":
//!
//! - `<app_root>/worktrees/<handle>/sandbox-config.json` — the exact
//!   [`super::manager::GitSandboxConfig`] `ensure()` was last called with for
//!   this handle. `SandboxManager::compute_handle` is a ONE-WAY hash (no
//!   reverse mapping) — without this file a restarted process has no way to
//!   learn "what repo/branch does this handle even belong to", so an
//!   explicit-handle request can only ever 404 after a restart, even though
//!   the workdir it refers to is sitting right there on disk. See
//!   the native desktop-runtime audit's investigation
//!   into the sandbox-drawer restart bug for the empirical trace that led
//!   here.
//! - `<app_root>/worktrees/.active-handle` — the last handle
//!   `SandboxManager::set_active` pointed at, so a HEADERLESS resolve (the
//!   preview iframe, and the drawer's Restart/Stop buttons before a handle
//!   header is known/attached) can ALSO self-heal after a restart, not just
//!   an explicit-handle request.
//!
//! Every write here is BEST-EFFORT at the request boundary: a failure (disk
//! full, permissions) is logged and swallowed rather than turning a successful
//! setup into an HTTP error. The files themselves are committed atomically via
//! [`crate::fs_util::atomic_replace`] (private, same-directory temp files); a
//! failed update preserves the previous valid record. If the FIRST write
//! fails, a future restart falls back to the pre-existing "unknown handle" /
//! "no active sandbox" behavior.

use std::io::{self, Read};
use std::path::{Path, PathBuf};

#[cfg(test)]
use crate::fs_util::atomic_replace_with_hook;
use crate::fs_util::{atomic_replace, sync_parent_dir};

use super::account_storage::AccountStorage;
use super::manager::{GitSandboxConfig, SandboxManager};

const SIDECAR_FILE_NAME: &str = "sandbox-config.json";
const SIDECAR_VERSION: u8 = 2;
const MAX_SIDECAR_BYTES: u64 = 256 * 1024;

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AccountSidecar {
    version: u8,
    account_scope: String,
    config: GitSandboxConfig,
}

/// Whether `handle` is safe to use as a RELATIVE path under the worktree root.
///
/// The handle is `<host>/<owner>/<repo>/<branch>`, so it is multi-segment by
/// construction. Each segment is validated separately — the guard this
/// replaces rejected `/` outright, which was correct when a handle was one
/// component and would now reject every real handle. What matters is
/// unchanged: no empty, `.` or `..` segment, and nothing outside the
/// alphanumeric/`-_.` set, so the result can never escape the root.
fn is_safe_handle_component(handle: &str) -> bool {
    // The shared traversal core plus this layer's OWN extras: a length cap
    // and an ASCII charset allowlist, because sidecar paths round-trip
    // through the filesystem and the persisted registry. Deliberately
    // stricter than `handle_is_path_safe` alone — and deliberately not
    // imposed there, where tightening would orphan a legitimately-minted
    // unicode handle.
    handle.len() <= 255
        && crate::sandbox::handle_is_path_safe(handle)
        && handle.split('/').all(|segment| {
            segment
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
        })
}

/// Whether `dir` is a sandbox directory — i.e. carries a sidecar.
#[cfg(test)]
pub(crate) fn sidecar_exists(dir: &Path) -> bool {
    std::fs::symlink_metadata(dir.join(SIDECAR_FILE_NAME))
        .is_ok_and(|metadata| metadata.file_type().is_file() && !metadata.file_type().is_symlink())
}

/// Current-account resurrection catalog. Legacy top-level sidecars are never
/// walked, and a marker replacement after the account ticket was minted fails
/// before any config is returned.
#[cfg(test)]
pub(crate) fn handles_with_sidecars_for_account(
    storage: &AccountStorage,
) -> Result<Vec<String>, String> {
    storage.verify()?;
    let root = storage.worktrees_root()?;
    let mut pending = vec![root.clone()];
    let mut handles = Vec::new();
    while let Some(dir) = pending.pop() {
        let entries = match std::fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => {
                return Err(format!(
                    "failed to read sandbox sidecar directory {dir:?}: {error}"
                ));
            }
        };
        for entry in entries.flatten() {
            if !entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
                continue;
            }
            let path = entry.path();
            if !sidecar_exists(&path) {
                pending.push(path);
                continue;
            }
            let Some(handle) = path
                .strip_prefix(&root)
                .ok()
                .and_then(|relative| relative.to_str())
                .map(|relative| relative.replace('\\', "/"))
            else {
                continue;
            };
            if super::account_storage::validate_managed_handle(&handle).is_ok() {
                handles.push(handle);
            }
        }
    }
    handles.sort();
    Ok(handles)
}

fn account_sidecar_path(storage: &AccountStorage, handle: &str) -> Result<PathBuf, String> {
    Ok(storage.worktree_root(handle)?.join(SIDECAR_FILE_NAME))
}

fn config_handle(cfg: &GitSandboxConfig) -> Option<String> {
    let branch = crate::sandbox::normalize_branch(cfg.branch.as_deref());
    SandboxManager::compute_handle(&cfg.clone_url, branch)
}

fn config_matches_handle(cfg: &GitSandboxConfig, handle: &str) -> bool {
    let branch = crate::sandbox::normalize_branch(cfg.branch.as_deref());
    config_handle(cfg).as_deref() == Some(handle)
        || SandboxManager::legacy_compute_handle(&cfg.clone_url, branch).as_deref() == Some(handle)
        || SandboxManager::hashed_compute_handle(&cfg.clone_url, branch).as_deref() == Some(handle)
}

pub(crate) fn write_sidecar_for_account(
    storage: &AccountStorage,
    handle: &str,
    cfg: &GitSandboxConfig,
) -> Result<(), String> {
    storage.verify()?;
    if !is_safe_handle_component(handle) || !config_matches_handle(cfg, handle) {
        return Err("sandbox sidecar identity does not match its handle".to_string());
    }
    let sidecar = AccountSidecar {
        version: SIDECAR_VERSION,
        account_scope: storage.storage_key().to_string(),
        config: cfg.clone(),
    };
    let bytes = serde_json::to_vec_pretty(&sidecar)
        .map_err(|error| format!("failed to serialize sandbox sidecar: {error}"))?;
    if bytes.len() as u64 > MAX_SIDECAR_BYTES {
        return Err(format!(
            "sandbox sidecar exceeds the {MAX_SIDECAR_BYTES}-byte limit"
        ));
    }
    let path = account_sidecar_path(storage, handle)?;
    atomic_replace(&path, &bytes)
        .map_err(|error| format!("failed to persist sandbox sidecar {path:?}: {error}"))?;
    storage.worktree_root(handle)?;
    let metadata = std::fs::symlink_metadata(&path)
        .map_err(|error| format!("failed to inspect sandbox sidecar {path:?}: {error}"))?;
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
        return Err(format!(
            "persisted sandbox sidecar is not a regular file: {path:?}"
        ));
    }
    storage.verify()
}

pub(crate) fn read_sidecar_for_account(
    storage: &AccountStorage,
    handle: &str,
) -> Result<Option<GitSandboxConfig>, String> {
    storage.verify()?;
    if !is_safe_handle_component(handle) {
        return Ok(None);
    }
    let path = account_sidecar_path(storage, handle)?;
    let bytes = match read_bounded_regular_file(&path, MAX_SIDECAR_BYTES) {
        Ok(Some(bytes)) => bytes,
        Ok(None) => return Ok(None),
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("failed to read sandbox sidecar {path:?}: {error}")),
    };
    let sidecar: AccountSidecar = match serde_json::from_slice(&bytes) {
        Ok(sidecar) => sidecar,
        Err(_) => return Ok(None),
    };
    if sidecar.version != SIDECAR_VERSION
        || sidecar.account_scope != storage.storage_key()
        || !config_matches_handle(&sidecar.config, handle)
    {
        return Ok(None);
    }
    storage.worktree_root(handle)?;
    storage.verify()?;
    Ok(Some(sidecar.config))
}

fn read_bounded_regular_file(path: &Path, limit: u64) -> io::Result<Option<Vec<u8>>> {
    let metadata = std::fs::symlink_metadata(path)?;
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
        return Ok(None);
    }
    if metadata.len() > limit {
        return Ok(None);
    }
    let file = std::fs::File::open(path)?;
    let opened = file.metadata()?;
    if !opened.is_file() || opened.len() > limit {
        return Ok(None);
    }
    let mut bytes = Vec::with_capacity(opened.len() as usize);
    file.take(limit + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        return Ok(None);
    }
    Ok(Some(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_cfg() -> GitSandboxConfig {
        GitSandboxConfig {
            org_slug: Some("acme".to_string()),
            virtual_mcp_id: "vmcp-1".to_string(),
            clone_url: "https://example.com/acme/repo.git".to_string(),
            branch: Some("main".to_string()),
            runtime: Some("node".to_string()),
            package_manager: Some("npm".to_string()),
            package_manager_path: None,
            git_user_name: None,
            git_user_email: None,
        }
    }

    fn sample_handle() -> String {
        config_handle(&sample_cfg()).expect("scopeable clone url")
    }

    fn account_storage(root: &Path) -> AccountStorage {
        AccountStorage::open(root, "v1:test-account").unwrap()
    }

    fn encoded_sidecar(storage: &AccountStorage, config: GitSandboxConfig) -> Vec<u8> {
        serde_json::to_vec_pretty(&AccountSidecar {
            version: SIDECAR_VERSION,
            account_scope: storage.storage_key().to_string(),
            config,
        })
        .unwrap()
    }

    /// Handles are multi-segment paths, so the account catalog must recurse
    /// to the directory that actually contains a sidecar.
    #[test]
    fn finds_account_sidecars_nested_under_a_multi_segment_handle() {
        let root = tempfile::tempdir().expect("tempdir");
        let storage = account_storage(root.path());
        let mut config = sample_cfg();
        config.clone_url = "https://github.com/acme/repo.git".to_string();
        config.branch = Some("feature-x".to_string());
        let handle = config_handle(&config).unwrap();
        assert!(handle.contains('/'));

        write_sidecar_for_account(&storage, &handle, &config).unwrap();
        std::fs::create_dir_all(storage.worktrees_root().unwrap().join("acme/other")).unwrap();

        assert_eq!(
            handles_with_sidecars_for_account(&storage).unwrap(),
            std::slice::from_ref(&handle)
        );
        assert_eq!(
            read_sidecar_for_account(&storage, &handle).unwrap(),
            Some(config)
        );
    }

    #[test]
    fn account_sidecars_are_v2_scoped_and_disjoint_for_the_same_handle() {
        let root = tempfile::tempdir().unwrap();
        let account_a = AccountStorage::open(root.path(), "v1:account-a").unwrap();
        let account_b = AccountStorage::open(root.path(), "v1:account-b").unwrap();
        let handle = sample_handle();
        write_sidecar_for_account(&account_a, &handle, &sample_cfg()).unwrap();

        assert_eq!(
            read_sidecar_for_account(&account_a, &handle)
                .unwrap()
                .unwrap()
                .virtual_mcp_id,
            "vmcp-1"
        );
        assert!(read_sidecar_for_account(&account_b, &handle)
            .unwrap()
            .is_none());
        assert_eq!(
            handles_with_sidecars_for_account(&account_a).unwrap(),
            [handle]
        );
        assert!(handles_with_sidecars_for_account(&account_b)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn copied_or_legacy_raw_sidecar_is_not_adopted_by_an_account() {
        let root = tempfile::tempdir().unwrap();
        let account_a = AccountStorage::open(root.path(), "v1:account-a").unwrap();
        let account_b = AccountStorage::open(root.path(), "v1:account-b").unwrap();
        let handle = sample_handle();
        write_sidecar_for_account(&account_a, &handle, &sample_cfg()).unwrap();
        let from = account_sidecar_path(&account_a, &handle).unwrap();
        let to = account_sidecar_path(&account_b, &handle).unwrap();
        std::fs::create_dir_all(to.parent().unwrap()).unwrap();
        std::fs::copy(from, &to).unwrap();
        assert!(read_sidecar_for_account(&account_b, &handle)
            .unwrap()
            .is_none());

        std::fs::write(&to, serde_json::to_vec(&sample_cfg()).unwrap()).unwrap();
        assert!(read_sidecar_for_account(&account_b, &handle)
            .unwrap()
            .is_none());
    }

    #[cfg(unix)]
    #[test]
    fn account_sidecar_rejects_symlinks_and_oversized_files_and_replaces_without_following() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().unwrap();
        let external = tempfile::tempdir().unwrap();
        let account = AccountStorage::open(root.path(), "v1:account-a").unwrap();
        let handle = sample_handle();
        let path = account_sidecar_path(&account, &handle).unwrap();
        let sentinel = external.path().join("sentinel.json");
        std::fs::write(&sentinel, b"do-not-touch").unwrap();
        symlink(&sentinel, &path).unwrap();

        assert!(read_sidecar_for_account(&account, &handle)
            .unwrap()
            .is_none());
        write_sidecar_for_account(&account, &handle, &sample_cfg()).unwrap();
        assert_eq!(std::fs::read(&sentinel).unwrap(), b"do-not-touch");
        let metadata = std::fs::symlink_metadata(&path).unwrap();
        assert!(metadata.file_type().is_file());
        assert!(!metadata.file_type().is_symlink());

        std::fs::write(&path, vec![b'x'; MAX_SIDECAR_BYTES as usize + 1]).unwrap();
        assert!(read_sidecar_for_account(&account, &handle)
            .unwrap()
            .is_none());
    }

    pub(super) fn temp_files(dir: &Path) -> Vec<PathBuf> {
        std::fs::read_dir(dir)
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.ends_with(".tmp"))
            })
            .collect()
    }

    #[test]
    fn account_sidecar_round_trips() {
        let root = tempfile::tempdir().unwrap();
        let storage = account_storage(root.path());
        let handle = sample_handle();
        assert!(read_sidecar_for_account(&storage, &handle)
            .unwrap()
            .is_none());
        write_sidecar_for_account(&storage, &handle, &sample_cfg()).unwrap();
        let read_back = read_sidecar_for_account(&storage, &handle)
            .unwrap()
            .expect("sidecar readable");
        assert_eq!(read_back.virtual_mcp_id, "vmcp-1");
        assert_eq!(read_back.clone_url, "https://example.com/acme/repo.git");
        assert_eq!(read_back.branch.as_deref(), Some("main"));
        assert_eq!(read_back.runtime.as_deref(), Some("node"));
        assert_eq!(read_back.package_manager.as_deref(), Some("npm"));
    }

    #[test]
    fn account_sidecar_accepts_a_legacy_lossy_handle_after_hash_upgrade() {
        let root = tempfile::tempdir().unwrap();
        let storage = account_storage(root.path());
        let mut config = sample_cfg();
        config.branch = Some("feature/foo".to_string());
        let branch = crate::sandbox::normalize_branch(config.branch.as_deref());
        let legacy = SandboxManager::legacy_compute_handle(&config.clone_url, branch).unwrap();
        assert_ne!(
            Some(legacy.clone()),
            SandboxManager::compute_handle(&config.clone_url, branch)
        );

        write_sidecar_for_account(&storage, &legacy, &config).unwrap();
        assert_eq!(
            read_sidecar_for_account(&storage, &legacy).unwrap(),
            Some(config)
        );
    }

    #[test]
    fn missing_account_sidecar_is_none_not_an_error() {
        let root = tempfile::tempdir().unwrap();
        let storage = account_storage(root.path());
        assert!(read_sidecar_for_account(&storage, "never-written")
            .unwrap()
            .is_none());
    }

    #[test]
    fn corrupt_account_sidecar_is_none_not_a_panic() {
        let root = tempfile::tempdir().unwrap();
        let storage = account_storage(root.path());
        let handle = sample_handle();
        let path = account_sidecar_path(&storage, &handle).unwrap();
        std::fs::write(&path, b"not json").unwrap();
        assert!(read_sidecar_for_account(&storage, &handle)
            .unwrap()
            .is_none());
    }

    #[test]
    fn two_handles_get_independent_account_sidecars() {
        let root = tempfile::tempdir().unwrap();
        let storage = account_storage(root.path());
        let mut cfg_b = sample_cfg();
        cfg_b.branch = Some("feature".to_string());
        let handle_a = sample_handle();
        let handle_b = config_handle(&cfg_b).expect("scopeable clone url");
        write_sidecar_for_account(&storage, &handle_a, &sample_cfg()).unwrap();
        write_sidecar_for_account(&storage, &handle_b, &cfg_b).unwrap();
        assert_eq!(
            read_sidecar_for_account(&storage, &handle_a)
                .unwrap()
                .unwrap()
                .branch
                .as_deref(),
            Some("main")
        );
        assert_eq!(
            read_sidecar_for_account(&storage, &handle_b)
                .unwrap()
                .unwrap()
                .branch
                .as_deref(),
            Some("feature")
        );
    }

    #[test]
    fn valid_account_sidecar_under_the_wrong_handle_fails_closed() {
        let root = tempfile::tempdir().unwrap();
        let storage = account_storage(root.path());
        let wrong_handle =
            SandboxManager::compute_handle("https://github.com/acme/repo-other", "main")
                .expect("scopeable clone url");
        let path = account_sidecar_path(&storage, &wrong_handle).unwrap();
        std::fs::write(path, encoded_sidecar(&storage, sample_cfg())).unwrap();
        assert!(read_sidecar_for_account(&storage, &wrong_handle)
            .unwrap()
            .is_none());
    }

    #[test]
    fn unsafe_account_sidecar_handle_fails_closed_without_path_traversal() {
        let root = tempfile::tempdir().unwrap();
        let storage = account_storage(root.path());
        assert!(read_sidecar_for_account(&storage, "../../outside")
            .unwrap()
            .is_none());
        assert!(write_sidecar_for_account(&storage, "../../outside", &sample_cfg()).is_err());
        assert!(!storage.root().join("outside").exists());
    }

    #[test]
    fn pre_rename_failure_preserves_previous_valid_sidecar_and_cleans_temp() {
        let root = tempfile::tempdir().unwrap();
        let storage = account_storage(root.path());
        let handle = sample_handle();
        let path = account_sidecar_path(&storage, &handle).unwrap();
        write_sidecar_for_account(&storage, &handle, &sample_cfg()).unwrap();

        let mut replacement = sample_cfg();
        replacement.package_manager = Some("bun".to_string());
        let replacement = encoded_sidecar(&storage, replacement);
        let error = atomic_replace_with_hook(&path, &replacement, |_| {
            Err(io::Error::other("injected failure before rename"))
        })
        .unwrap_err();

        assert_eq!(error.kind(), io::ErrorKind::Other);
        assert_eq!(
            read_sidecar_for_account(&storage, &handle)
                .unwrap()
                .unwrap()
                .package_manager
                .as_deref(),
            Some("npm")
        );
        assert!(temp_files(path.parent().unwrap()).is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn account_sidecar_is_private_from_creation() {
        use std::os::unix::fs::PermissionsExt;

        let root = tempfile::tempdir().unwrap();
        let storage = account_storage(root.path());
        let handle = sample_handle();
        write_sidecar_for_account(&storage, &handle, &sample_cfg()).unwrap();
        let path = account_sidecar_path(&storage, &handle).unwrap();
        let mode = std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }
}

/// The dev-server child a sandbox last spawned — `pid == pgid` because every
/// task spawns via `build_command`'s `process_group(0)`. Persisted so a
/// later boot (or a reboot of the dev script) can REAP a still-running
/// child the previous process leaked: observed live 2026-07-22, a SIGKILLed
/// local-api left its Next.js dev server running, and Next 16's
/// single-instance lock then made every subsequent dev spawn for that repo
/// exit 1 ("Run `kill <pid>` to stop it") — the sandbox could never boot
/// again until the orphan died.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
pub(crate) struct DevProcessIdentity {
    pub pid: u32,
    /// Kernel-observed process birth identity. On Unix this is the complete
    /// `ps lstart` value paired with the executable name, not a wall-clock
    /// timestamp sampled by local-api.
    pub birth: String,
    /// Executable name (`ps comm`), deliberately excluding argv so secrets
    /// passed to a child process are never copied into the sidecar.
    pub executable: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
pub(crate) struct DevProcessRecord {
    pub pid: u32,
    pub pgid: u32,
    pub command: String,
    pub started_at: u64,
    /// The port this dev server was TOLD to bind, via `PORT` — see
    /// `setup::dev::allocate_dev_port`. Persisted so the same sandbox keeps
    /// the same port across restarts, which keeps its preview URL and any
    /// absolute URL the application generated stable. Older records
    /// deserialize as `None` and simply get a fresh allocation.
    #[serde(default)]
    pub port: Option<u16>,
    /// Exact members observed in this process group while local-api owned it.
    /// Older records deserialize empty and therefore cannot authorize a
    /// signal; callers fail closed instead of trusting a naked recycled PGID.
    #[serde(default)]
    pub identities: Vec<DevProcessIdentity>,
}

fn dev_process_path(sandbox_root: &Path) -> std::path::PathBuf {
    sandbox_root.join("dev-process.json")
}

fn is_valid_dev_process_record(record: &DevProcessRecord) -> bool {
    record.pid > 1
        && record.pgid == record.pid
        && record.started_at > 0
        && !record.command.trim().is_empty()
        && record.identities.iter().all(|identity| {
            identity.pid > 1
                && !identity.birth.trim().is_empty()
                && !identity.executable.trim().is_empty()
        })
}

pub(crate) fn write_dev_process(sandbox_root: &Path, record: &DevProcessRecord) {
    if !is_valid_dev_process_record(record) {
        tracing::warn!(
            pid = record.pid,
            pgid = record.pgid,
            "refusing to persist invalid dev-process record"
        );
        return;
    }
    let path = dev_process_path(sandbox_root);
    match serde_json::to_vec_pretty(record) {
        Ok(bytes) => {
            if let Err(err) = atomic_replace(&path, &bytes) {
                tracing::warn!(path = %path.display(), error = %err, "failed to atomically persist dev-process record");
            }
        }
        Err(err) => tracing::warn!(error = %err, "failed to serialize dev-process record"),
    }
}

pub(crate) fn read_dev_process(sandbox_root: &Path) -> Option<DevProcessRecord> {
    let bytes = std::fs::read(dev_process_path(sandbox_root)).ok()?;
    match serde_json::from_slice(&bytes) {
        Ok(rec) if is_valid_dev_process_record(&rec) => Some(rec),
        Ok(rec) => {
            tracing::warn!(
                pid = rec.pid,
                pgid = rec.pgid,
                "invalid dev-process record; ignoring"
            );
            None
        }
        Err(err) => {
            tracing::warn!(error = %err, "unreadable dev-process record; ignoring");
            None
        }
    }
}

pub(crate) fn clear_dev_process(sandbox_root: &Path) {
    let path = dev_process_path(sandbox_root);
    match std::fs::remove_file(&path) {
        Ok(()) => {
            if let Err(error) = sync_parent_dir(&path) {
                tracing::warn!(path = %path.display(), %error, "failed to sync cleared dev-process record");
            }
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => {
            tracing::warn!(path = %path.display(), %error, "failed to clear dev-process record");
        }
    }
}

#[cfg(test)]
mod dev_process_tests {
    use super::*;

    #[test]
    fn legacy_record_has_no_signal_authority() {
        let record: DevProcessRecord =
            serde_json::from_str(r#"{"pid":42,"pgid":42,"command":"bun dev","started_at":1}"#)
                .unwrap();
        assert!(record.identities.is_empty());
    }

    #[test]
    fn identities_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let record = DevProcessRecord {
            pid: 42,
            pgid: 42,
            command: "bun dev".to_string(),
            started_at: 1,
            port: None,
            identities: vec![DevProcessIdentity {
                pid: 43,
                birth: "Wed Jul 22 11:00:00 2026".to_string(),
                executable: "next-server".to_string(),
            }],
        };
        write_dev_process(dir.path(), &record);
        assert_eq!(read_dev_process(dir.path()), Some(record));
    }

    #[test]
    fn invalid_dev_process_record_fails_closed() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dev_process_path(dir.path()),
            br#"{"pid":0,"pgid":0,"command":"bun dev","started_at":1}"#,
        )
        .unwrap();
        assert!(read_dev_process(dir.path()).is_none());
    }

    #[test]
    fn pre_rename_failure_preserves_previous_valid_dev_process_record() {
        let dir = tempfile::tempdir().unwrap();
        let path = dev_process_path(dir.path());
        let original = DevProcessRecord {
            pid: 42,
            pgid: 42,
            command: "bun dev".to_string(),
            started_at: 1,
            port: None,
            identities: vec![DevProcessIdentity {
                pid: 42,
                birth: "Wed Jul 22 11:00:00 2026".to_string(),
                executable: "bun".to_string(),
            }],
        };
        write_dev_process(dir.path(), &original);

        let mut replacement = original.clone();
        replacement.identities[0].executable = "next-server".to_string();
        let replacement = serde_json::to_vec_pretty(&replacement).unwrap();
        atomic_replace_with_hook(&path, &replacement, |_| {
            Err(io::Error::other("injected failure before rename"))
        })
        .unwrap_err();

        assert_eq!(read_dev_process(dir.path()), Some(original));
        assert!(super::tests::temp_files(dir.path()).is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn dev_process_record_is_private() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let record = DevProcessRecord {
            pid: 42,
            pgid: 42,
            command: "bun dev".to_string(),
            started_at: 1,
            port: None,
            identities: Vec::new(),
        };
        write_dev_process(dir.path(), &record);
        let mode = std::fs::metadata(dev_process_path(dir.path()))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600);
    }
}
