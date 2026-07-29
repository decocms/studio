//! Owner-only (0600) file discipline and durable atomic replacement, in ONE
//! place.
//!
//! Several families used to hand-roll this shape independently — the sandbox
//! resurrection sidecars (`sandbox::persist`), the sandbox registry and the
//! threads database (the two tenants of `studio.db` and its `-wal`/`-shm`
//! companions), the instance/child-lifetime lock files (`crate::lib`), the
//! retained task logs and run spool, and the tools-catalog endpoint writer
//! (`routes::fs`). Each copy embodied the same easy-to-drift invariants, so
//! they live here once:
//!
//! - **0600 at creation, never create-then-chmod**: the window between the
//!   two is exactly when another same-uid process could read a
//!   credential-bearing file.
//! - **The atomic-replace fsync order**: private same-directory temp →
//!   write → fsync → rename → fsync(parent), with the temp removed on any
//!   pre-rename failure so a failed update leaves the previous valid file
//!   byte-for-byte intact and no `.tmp` litter beside it.
//! - **The SQLite file family**: one database is THREE files (`db`,
//!   `db-wal`, `db-shm`). The suffix pair was previously spelled at three
//!   call sites, one of which had already drifted to a lossy
//!   `Display`-based join.
//!
//! This is deliberately dependency-free plumbing; policy (what to write,
//! when to swallow errors, quarantine strategy) stays with callers.

use std::fs::{File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

const MAX_TEMP_CREATE_ATTEMPTS: usize = 128;

static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(1);

/// Clamps `path` to owner-only (0600). No-op off Unix.
pub(crate) fn set_owner_only(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        Ok(())
    }
}

/// Async twin of [`set_owner_only`] for tokio callers (append-log writers,
/// spool files) that must not block the executor on metadata I/O.
pub(crate) async fn set_owner_only_async(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        tokio::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).await
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        Ok(())
    }
}

/// Opens (creating if absent) `path` read+write with owner-only permissions
/// from the very first instant it exists. `mode` applies only on create, so
/// a pre-existing permissive file is clamped through the returned handle
/// before any caller can lock it or write through it.
pub(crate) fn open_owner_only(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        options.mode(0o600);
        let file = options.open(path)?;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
        Ok(file)
    }
    #[cfg(not(unix))]
    options.open(path)
}

/// Ensures `path` exists as an owner-only file, without keeping a handle.
/// The create-time-0600-plus-clamp semantics are [`open_owner_only`]'s.
pub(crate) fn create_owner_only(path: &Path) -> io::Result<()> {
    drop(open_owner_only(path)?);
    Ok(())
}

/// The three files SQLite may materialize for one database in WAL mode:
/// the database itself plus its `-wal` and `-shm` companions. Every caller
/// that secures, inspects, or quarantines "the database" must handle all
/// three, in this order, or a permission clamp / quarantine silently skips
/// live data.
pub(crate) fn sqlite_file_family(db_path: &Path) -> [PathBuf; 3] {
    fn companion(db_path: &Path, suffix: &str) -> PathBuf {
        let mut value = db_path.as_os_str().to_os_string();
        value.push(suffix);
        PathBuf::from(value)
    }
    [
        db_path.to_path_buf(),
        companion(db_path, "-wal"),
        companion(db_path, "-shm"),
    ]
}

/// Fsyncs the directory that holds `path`, making a rename/unlink of `path`
/// durable. No-op off Unix (Windows directory handles need platform-specific
/// flags; atomic rename still preserves coherence there).
#[cfg(unix)]
pub(crate) fn sync_parent_dir(path: &Path) -> io::Result<()> {
    let parent = path.parent().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "file has no parent directory")
    })?;
    File::open(parent)?.sync_all()
}

#[cfg(not(unix))]
pub(crate) fn sync_parent_dir(_path: &Path) -> io::Result<()> {
    Ok(())
}

fn create_private_parent_dir(path: &Path) -> io::Result<()> {
    let Some(parent) = path.parent() else {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "file has no parent directory",
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
        io::Error::new(io::ErrorKind::InvalidInput, "file has no parent directory")
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
            // Callers store credential-bearing content (clone URLs, MCP
            // endpoint headers). The temp must never exist briefly with
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

pub(crate) fn atomic_replace(path: &Path, contents: &[u8]) -> io::Result<()> {
    atomic_replace_with_hook(path, contents, |_| Ok(()))
}

/// Writes and fsyncs a private same-directory temp file, then atomically
/// replaces `path` and fsyncs its parent directory. The hook is a test seam
/// for the only meaningful crash boundary: after durable temp contents but
/// before rename. Any pre-rename failure removes the temp and leaves the old
/// valid destination byte-for-byte intact.
pub(crate) fn atomic_replace_with_hook<F>(
    path: &Path,
    contents: &[u8],
    before_rename: F,
) -> io::Result<()>
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

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_files(dir: &Path) -> Vec<PathBuf> {
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
    fn atomic_replace_round_trips_and_creates_missing_parents() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested/deeply/value.json");
        atomic_replace(&path, b"first").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"first");
        atomic_replace(&path, b"second").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"second");
        assert!(temp_files(path.parent().unwrap()).is_empty());
    }

    #[test]
    fn pre_rename_failure_preserves_destination_and_cleans_temp() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("value.json");
        atomic_replace(&path, b"stable").unwrap();

        let error = atomic_replace_with_hook(&path, b"replacement", |_| {
            Err(io::Error::other("injected failure before rename"))
        })
        .unwrap_err();

        assert_eq!(error.kind(), io::ErrorKind::Other);
        assert_eq!(std::fs::read(&path).unwrap(), b"stable");
        assert!(temp_files(dir.path()).is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn atomic_replace_produces_an_owner_only_file() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("value.json");
        atomic_replace(&path, b"secret").unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }

    #[cfg(unix)]
    #[test]
    fn create_owner_only_clamps_a_pre_existing_permissive_file() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("value.db");
        std::fs::write(&path, b"existing").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();

        create_owner_only(&path).unwrap();

        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        // Ensuring privacy must not truncate: the database content survives.
        assert_eq!(std::fs::read(&path).unwrap(), b"existing");
    }

    /// Pins the `-wal`/`-shm` pair so the two `studio.db` tenants (threads
    /// database and sandbox registry) can never disagree again about what
    /// "the whole database" means.
    #[test]
    fn sqlite_file_family_pins_the_wal_and_shm_companions() {
        let family = sqlite_file_family(Path::new("/app/studio.db"));
        assert_eq!(
            family,
            [
                PathBuf::from("/app/studio.db"),
                PathBuf::from("/app/studio.db-wal"),
                PathBuf::from("/app/studio.db-shm"),
            ]
        );
    }
}
