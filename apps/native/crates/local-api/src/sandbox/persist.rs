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
//! private, same-directory temp files; a failed update preserves the previous
//! valid record. If the FIRST write fails, a future restart falls back to the
//! pre-existing "unknown handle" / "no active sandbox" behavior.

use std::fs::{File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard, OnceLock};

use super::manager::{GitSandboxConfig, SandboxManager};

const ACTIVE_HANDLE_RELATIVE_PATH: &str = "worktrees/.active-handle";
const SIDECAR_FILE_NAME: &str = "sandbox-config.json";
const MAX_TEMP_CREATE_ATTEMPTS: usize = 128;

static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(1);

fn active_handle_write_lock() -> MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn create_private_parent_dir(path: &Path) -> io::Result<()> {
    let Some(parent) = path.parent() else {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "persistent file has no parent directory",
        ));
    };

    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(parent)
}

fn create_private_temp(path: &Path) -> io::Result<(PathBuf, File)> {
    let parent = path.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "persistent file has no parent directory",
        )
    })?;
    let target_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "invalid file name"))?;

    for _ in 0..MAX_TEMP_CREATE_ATTEMPTS {
        let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let temp_path = parent.join(format!(
            ".{target_name}.{}.{}.tmp",
            std::process::id(),
            sequence
        ));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            // The sidecar can contain a credential-bearing clone URL and the
            // dev record authorizes signals. It must never exist briefly with
            // umask-dependent group/world permissions.
            options.mode(0o600);
        }
        match options.open(&temp_path) {
            Ok(file) => return Ok((temp_path, file)),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }

    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "could not reserve a unique atomic-write temp file",
    ))
}

#[cfg(unix)]
fn sync_parent_dir(path: &Path) -> io::Result<()> {
    let parent = path.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "persistent file has no parent directory",
        )
    })?;
    File::open(parent)?.sync_all()
}

#[cfg(not(unix))]
fn sync_parent_dir(_path: &Path) -> io::Result<()> {
    Ok(())
}

fn atomic_replace(path: &Path, contents: &[u8]) -> io::Result<()> {
    atomic_replace_with_hook(path, contents, |_| Ok(()))
}

/// Writes and fsyncs a private same-directory temp file, then atomically
/// replaces `path` and fsyncs its parent directory. The hook is a test seam
/// for the only meaningful crash boundary: after durable temp contents but
/// before rename. Any pre-rename failure removes the temp and leaves the old
/// valid destination byte-for-byte intact.
fn atomic_replace_with_hook<F>(path: &Path, contents: &[u8], before_rename: F) -> io::Result<()>
where
    F: FnOnce(&Path) -> io::Result<()>,
{
    create_private_parent_dir(path)?;
    let (temp_path, mut temp_file) = create_private_temp(path)?;

    let result = (|| {
        temp_file.write_all(contents)?;
        temp_file.flush()?;
        temp_file.sync_all()?;
        drop(temp_file);

        before_rename(&temp_path)?;
        std::fs::rename(&temp_path, path)?;
        sync_parent_dir(path)
    })();

    if result.is_err() {
        // Best effort: if rename already succeeded the temp path no longer
        // exists. If anything failed before rename this prevents stale private
        // temp files from accumulating beside the source of truth.
        let _ = std::fs::remove_file(&temp_path);
    }
    result
}

fn is_safe_handle_component(handle: &str) -> bool {
    !handle.is_empty()
        && handle.len() <= 255
        && handle != "."
        && handle != ".."
        && handle
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

fn sidecar_path(app_root: &Path, handle: &str) -> PathBuf {
    app_root
        .join(crate::sandbox::WORKTREES_DIR)
        .join(handle)
        .join(SIDECAR_FILE_NAME)
}

fn config_handle(cfg: &GitSandboxConfig) -> String {
    let branch = cfg
        .branch
        .as_deref()
        .filter(|branch| !branch.is_empty())
        .unwrap_or("main");
    SandboxManager::compute_handle(&cfg.virtual_mcp_id, branch)
}

/// Best-effort write of `cfg` as `handle`'s resurrection sidecar. Called by
/// `SandboxManager::ensure` after a successful config apply.
pub(crate) fn write_sidecar(app_root: &Path, handle: &str, cfg: &GitSandboxConfig) {
    if !is_safe_handle_component(handle) || config_handle(cfg) != handle {
        tracing::warn!(
            handle,
            "sandbox: refusing to persist mismatched sidecar identity"
        );
        return;
    }
    let path = sidecar_path(app_root, handle);
    match serde_json::to_vec_pretty(cfg) {
        Ok(bytes) => {
            if let Err(err) = atomic_replace(&path, &bytes) {
                tracing::warn!(handle, ?path, %err, "sandbox: failed to atomically write resurrection sidecar");
            }
        }
        Err(err) => {
            tracing::warn!(handle, %err, "sandbox: failed to serialize resurrection sidecar");
        }
    }
}

/// Reads back `handle`'s sidecar, if any. `None` covers both "never written"
/// and "unreadable/corrupt" — either way there's nothing safe to resurrect
/// from, so the caller treats both the same as "genuinely unknown handle".
pub(crate) fn read_sidecar(app_root: &Path, handle: &str) -> Option<GitSandboxConfig> {
    if !is_safe_handle_component(handle) {
        tracing::warn!(
            handle,
            "sandbox: refusing unsafe resurrection sidecar handle"
        );
        return None;
    }
    let bytes = std::fs::read(sidecar_path(app_root, handle)).ok()?;
    let cfg: GitSandboxConfig = serde_json::from_slice(&bytes).ok()?;
    if config_handle(&cfg) != handle {
        tracing::warn!(
            handle,
            "sandbox: resurrection sidecar identity does not match its path"
        );
        return None;
    }
    Some(cfg)
}

fn active_handle_path(app_root: &Path) -> PathBuf {
    app_root.join(ACTIVE_HANDLE_RELATIVE_PATH)
}

/// Best-effort write of the last-`set_active`-d handle.
pub(crate) fn write_active_handle(app_root: &Path, handle: &str) {
    if !is_safe_handle_component(handle) {
        tracing::warn!(handle, "sandbox: refusing to persist unsafe active handle");
        return;
    }
    if let Err(err) = write_active_handle_with_hook(app_root, handle, |_| Ok(())) {
        let path = active_handle_path(app_root);
        tracing::warn!(handle, ?path, %err, "sandbox: failed to atomically persist active handle");
    }
}

fn write_active_handle_with_hook<F>(
    app_root: &Path,
    handle: &str,
    before_rename: F,
) -> io::Result<()>
where
    F: FnOnce(&Path) -> io::Result<()>,
{
    if !is_safe_handle_component(handle) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "active handle is not a safe path component",
        ));
    }
    // `set_active` is reachable from dispatch and preview focus concurrently.
    // Serialize the complete temp-write + rename so disk always reflects one
    // whole writer and hook/failure tests have deterministic critical-section
    // semantics rather than merely relying on unique temp names.
    let _guard = active_handle_write_lock();
    let path = active_handle_path(app_root);
    atomic_replace_with_hook(&path, handle.as_bytes(), before_rename)
}

/// Reads back the persisted active handle. `None` for a fresh `app_root` (or
/// an empty/unreadable file) — a genuinely fresh process, or one that only
/// ever used the plain non-git path.
pub(crate) fn read_active_handle(app_root: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(active_handle_path(app_root)).ok()?;
    if !is_safe_handle_component(&raw) {
        return None;
    }
    Some(raw)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Barrier};

    fn sample_cfg() -> GitSandboxConfig {
        GitSandboxConfig {
            org_slug: Some("acme".to_string()),
            virtual_mcp_id: "vmcp-1".to_string(),
            clone_url: "https://example.com/repo.git".to_string(),
            branch: Some("main".to_string()),
            runtime: Some("node".to_string()),
            package_manager: Some("npm".to_string()),
            package_manager_path: None,
            git_user_name: None,
            git_user_email: None,
        }
    }

    fn sample_handle() -> String {
        config_handle(&sample_cfg())
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
    fn sidecar_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let handle = sample_handle();
        assert!(read_sidecar(dir.path(), &handle).is_none());
        write_sidecar(dir.path(), &handle, &sample_cfg());
        let read_back = read_sidecar(dir.path(), &handle).expect("sidecar readable");
        assert_eq!(read_back.virtual_mcp_id, "vmcp-1");
        assert_eq!(read_back.clone_url, "https://example.com/repo.git");
        assert_eq!(read_back.branch.as_deref(), Some("main"));
        assert_eq!(read_back.runtime.as_deref(), Some("node"));
        assert_eq!(read_back.package_manager.as_deref(), Some("npm"));
    }

    #[test]
    fn missing_sidecar_is_none_not_an_error() {
        let dir = tempfile::tempdir().unwrap();
        assert!(read_sidecar(dir.path(), "never-written").is_none());
    }

    #[test]
    fn corrupt_sidecar_is_none_not_a_panic() {
        let dir = tempfile::tempdir().unwrap();
        let handle = sample_handle();
        let path = sidecar_path(dir.path(), &handle);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"not json").unwrap();
        assert!(read_sidecar(dir.path(), &handle).is_none());
    }

    #[test]
    fn two_handles_get_independent_sidecars() {
        let dir = tempfile::tempdir().unwrap();
        let mut cfg_b = sample_cfg();
        cfg_b.branch = Some("feature".to_string());
        let handle_a = sample_handle();
        let handle_b = config_handle(&cfg_b);
        write_sidecar(dir.path(), &handle_a, &sample_cfg());
        write_sidecar(dir.path(), &handle_b, &cfg_b);
        assert_eq!(
            read_sidecar(dir.path(), &handle_a)
                .unwrap()
                .branch
                .as_deref(),
            Some("main")
        );
        assert_eq!(
            read_sidecar(dir.path(), &handle_b)
                .unwrap()
                .branch
                .as_deref(),
            Some("feature")
        );
    }

    #[test]
    fn valid_json_under_the_wrong_handle_fails_closed() {
        let dir = tempfile::tempdir().unwrap();
        let wrong_handle = SandboxManager::compute_handle("vmcp-other", "main");
        let path = sidecar_path(dir.path(), &wrong_handle);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, serde_json::to_vec(&sample_cfg()).unwrap()).unwrap();
        assert!(read_sidecar(dir.path(), &wrong_handle).is_none());
    }

    #[test]
    fn unsafe_sidecar_handle_fails_closed_without_path_traversal() {
        let dir = tempfile::tempdir().unwrap();
        assert!(read_sidecar(dir.path(), "../../outside").is_none());
        write_sidecar(dir.path(), "../../outside", &sample_cfg());
        assert!(!dir.path().join("outside").exists());
    }

    #[test]
    fn pre_rename_failure_preserves_previous_valid_sidecar_and_cleans_temp() {
        let dir = tempfile::tempdir().unwrap();
        let handle = sample_handle();
        let path = sidecar_path(dir.path(), &handle);
        write_sidecar(dir.path(), &handle, &sample_cfg());

        let mut replacement = sample_cfg();
        replacement.package_manager = Some("bun".to_string());
        let replacement = serde_json::to_vec_pretty(&replacement).unwrap();
        let error = atomic_replace_with_hook(&path, &replacement, |_| {
            Err(io::Error::other("injected failure before rename"))
        })
        .unwrap_err();

        assert_eq!(error.kind(), io::ErrorKind::Other);
        assert_eq!(
            read_sidecar(dir.path(), &handle)
                .unwrap()
                .package_manager
                .as_deref(),
            Some("npm")
        );
        assert!(temp_files(path.parent().unwrap()).is_empty());
    }

    #[test]
    fn active_handle_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        assert!(read_active_handle(dir.path()).is_none());
        write_active_handle(dir.path(), "main-abc123");
        assert_eq!(
            read_active_handle(dir.path()).as_deref(),
            Some("main-abc123")
        );
    }

    #[test]
    fn active_handle_overwrites_the_previous_value() {
        let dir = tempfile::tempdir().unwrap();
        write_active_handle(dir.path(), "first-handle");
        write_active_handle(dir.path(), "second-handle");
        assert_eq!(
            read_active_handle(dir.path()).as_deref(),
            Some("second-handle")
        );
    }

    #[test]
    fn pre_rename_failure_preserves_previous_active_handle() {
        let dir = tempfile::tempdir().unwrap();
        write_active_handle(dir.path(), "stable-handle");

        write_active_handle_with_hook(dir.path(), "replacement-handle", |_| {
            Err(io::Error::other("injected failure before rename"))
        })
        .unwrap_err();

        assert_eq!(
            read_active_handle(dir.path()).as_deref(),
            Some("stable-handle")
        );
        assert!(temp_files(active_handle_path(dir.path()).parent().unwrap()).is_empty());
    }

    #[test]
    fn concurrent_active_handle_updates_are_serialized_and_never_torn() {
        const WRITERS: usize = 16;
        let dir = tempfile::tempdir().unwrap();
        let app_root = dir.path().to_path_buf();
        let barrier = Arc::new(Barrier::new(WRITERS));
        let in_hook = Arc::new(AtomicUsize::new(0));
        let max_in_hook = Arc::new(AtomicUsize::new(0));
        let handles: Vec<String> = (0..WRITERS)
            .map(|index| format!("branch-{index:02}-0123456789abcdef"))
            .collect();

        let threads: Vec<_> = handles
            .iter()
            .cloned()
            .map(|handle| {
                let app_root = app_root.clone();
                let barrier = Arc::clone(&barrier);
                let in_hook = Arc::clone(&in_hook);
                let max_in_hook = Arc::clone(&max_in_hook);
                std::thread::spawn(move || {
                    barrier.wait();
                    write_active_handle_with_hook(&app_root, &handle, |_| {
                        let now = in_hook.fetch_add(1, Ordering::SeqCst) + 1;
                        max_in_hook.fetch_max(now, Ordering::SeqCst);
                        std::thread::sleep(std::time::Duration::from_millis(2));
                        in_hook.fetch_sub(1, Ordering::SeqCst);
                        Ok(())
                    })
                    .unwrap();
                })
            })
            .collect();
        for thread in threads {
            thread.join().unwrap();
        }

        assert_eq!(max_in_hook.load(Ordering::SeqCst), 1);
        let persisted = read_active_handle(&app_root).expect("one complete active handle");
        assert!(handles.contains(&persisted));
        assert!(temp_files(active_handle_path(&app_root).parent().unwrap()).is_empty());
    }

    #[test]
    fn empty_active_handle_write_reads_back_as_none() {
        let dir = tempfile::tempdir().unwrap();
        write_active_handle(dir.path(), "");
        assert!(read_active_handle(dir.path()).is_none());
    }

    #[cfg(unix)]
    #[test]
    fn persistent_files_are_private_from_creation() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let handle = sample_handle();
        write_sidecar(dir.path(), &handle, &sample_cfg());
        write_active_handle(dir.path(), &handle);

        for path in [
            sidecar_path(dir.path(), &handle),
            active_handle_path(dir.path()),
        ] {
            let mode = std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
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
