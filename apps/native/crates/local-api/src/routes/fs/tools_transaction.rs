//! Crash-recoverable installation for the generated MCP tools catalog.
//!
//! `.endpoint.json` is part of the catalog, not an independently committed
//! credential. A complete replacement directory is prepared and synced before
//! the old directory moves. The short visible transition is therefore:
//!
//! ```text
//! target(old) -> previous-catalog
//! catalog(new) -> target(new)
//! ```
//!
//! The target may be briefly absent between those two same-filesystem renames,
//! but it can never contain a new endpoint beside old tool files. Durable phase
//! markers make every crash window recoverable. Ambiguous/corrupt state fails
//! closed and preserves the only known-good backup for a later retry or manual
//! repair.

use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;

const TRANSACTION_FILE: &str = "tools-catalog-transaction.json";
const PREPARED_MARKER: &str = "tools-catalog.prepared";
const SWAPPING_MARKER: &str = "tools-catalog.swapping";
const INSTALLED_MARKER: &str = "tools-catalog.installed";
const STAGED_CATALOG: &str = "catalog";
const PREVIOUS_CATALOG: &str = "previous-catalog";
const ENDPOINT_FILE: &str = ".endpoint.json";

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct TransactionHeader {
    kind: String,
    version: u8,
}

impl TransactionHeader {
    fn current() -> Self {
        Self {
            kind: "tools-catalog".to_string(),
            version: 1,
        }
    }

    fn validate(self) -> io::Result<()> {
        if self.kind == "tools-catalog" && self.version == 1 {
            Ok(())
        } else {
            Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!(
                    "unsupported tools catalog transaction kind={:?} version={}",
                    self.kind, self.version
                ),
            ))
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TransactionPhase {
    Created,
    Prepared,
    Swapping,
    Installed,
}

/// Installs one fully prepared catalog. The caller must serialize calls and
/// hold the mutation commit permit for the duration of this function.
pub(super) async fn install(
    stage_dir: &Path,
    staged_catalog: &Path,
    target: &Path,
) -> io::Result<()> {
    let swap_result = install_inner(stage_dir, staged_catalog, target).await;
    if let Err(install_error) = swap_result {
        let transaction_exists = path_exists(&stage_dir.join(TRANSACTION_FILE)).await?;
        let backup_exists = path_exists(&stage_dir.join(PREVIOUS_CATALOG)).await?;
        if !transaction_exists && !backup_exists {
            remove_path(stage_dir).await?;
            return Err(install_error);
        }
        return match recover_transaction(stage_dir, target).await {
            Ok(()) => Err(install_error),
            Err(recovery_error) => Err(io::Error::other(format!(
                "tools catalog install failed ({install_error}); automatic recovery also failed \
                 ({recovery_error}); recovery artifacts preserved at {}",
                stage_dir.display()
            ))),
        };
    }

    // Structural validation is not cleanup: if the installed target became
    // incoherent, report failure and preserve the prior catalog for recovery.
    validate_catalog_structure(target, "installed").await?;

    // Installation is already coherent and durable. Cleanup failure must not
    // turn a successful update into a false retry (or encourage a second
    // request); the installed journal is sufficient for startup/pre-commit
    // recovery to finish garbage collection later.
    if let Err(error) = finish_installed(stage_dir, target).await {
        tracing::warn!(
            path = %stage_dir.display(),
            %error,
            "tools catalog installed but transaction cleanup was deferred"
        );
    }
    Ok(())
}

async fn install_inner(stage_dir: &Path, staged_catalog: &Path, target: &Path) -> io::Result<()> {
    validate_catalog_structure(staged_catalog, "staged").await?;
    write_transaction_header(stage_dir).await?;
    write_phase_marker(stage_dir, PREPARED_MARKER).await?;
    if let Some(parent) = stage_dir.parent() {
        // The transaction directory itself must survive a power loss before
        // the only prior catalog is renamed into it.
        sync_directory(parent).await?;
    }
    write_phase_marker(stage_dir, SWAPPING_MARKER).await?;

    let backup = stage_dir.join(PREVIOUS_CATALOG);
    if path_exists(&backup).await? {
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            format!(
                "tools catalog backup already exists at {}",
                backup.display()
            ),
        ));
    }

    if path_exists(target).await? {
        tokio::fs::rename(target, &backup).await?;
        sync_rename_parents(target, &backup).await?;
    }

    tokio::fs::rename(staged_catalog, target).await?;
    sync_rename_parents(staged_catalog, target).await?;
    write_phase_marker(stage_dir, INSTALLED_MARKER).await?;
    Ok(())
}

/// Recovers catalog transactions and removes unrelated stale mutation stages
/// after the app-root instance lock has been acquired.
pub(super) async fn recover_mutation_stages(mutation_root: &Path, target: &Path) -> io::Result<()> {
    recover_stages(mutation_root, target, None, true).await
}

/// Finishes older catalog transactions immediately before a new catalog swap.
/// Long-running unrelated mutation stages are left alone; `current_stage` is
/// the fully prepared transaction owned by the caller and must not be touched.
pub(super) async fn recover_catalog_transactions(
    mutation_root: &Path,
    target: &Path,
    current_stage: &Path,
) -> io::Result<()> {
    recover_stages(mutation_root, target, Some(current_stage), false).await
}

async fn recover_stages(
    mutation_root: &Path,
    target: &Path,
    skip: Option<&Path>,
    clean_unrelated: bool,
) -> io::Result<()> {
    let mut entries = match tokio::fs::read_dir(mutation_root).await {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    let mut stages = Vec::<PathBuf>::new();
    while let Some(entry) = entries.next_entry().await? {
        stages.push(entry.path());
    }
    stages.sort();

    for stage in stages {
        if skip.is_some_and(|skip| skip == stage.as_path()) {
            continue;
        }
        let metadata = match tokio::fs::symlink_metadata(&stage).await {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error),
        };
        if !metadata.is_dir() {
            if clean_unrelated {
                remove_path(&stage).await?;
            }
            continue;
        }

        let transaction_file = stage.join(TRANSACTION_FILE);
        let backup = stage.join(PREVIOUS_CATALOG);
        if path_exists(&transaction_file).await? {
            recover_transaction(&stage, target).await.map_err(|error| {
                io::Error::new(
                    error.kind(),
                    format!(
                        "failed to recover tools catalog transaction {}: {error}",
                        stage.display()
                    ),
                )
            })?;
        } else if path_exists(&backup).await? {
            // Compatibility with the pre-journal implementation: its only
            // recoverable evidence was `previous-catalog`. Never discard that
            // sole prior catalog merely because the process restarted.
            recover_legacy_backup(&stage, target).await?;
        } else if clean_unrelated {
            remove_path(&stage).await?;
        }
    }
    Ok(())
}

async fn recover_transaction(stage_dir: &Path, target: &Path) -> io::Result<()> {
    read_and_validate_header(stage_dir).await?;
    let phase = read_phase(stage_dir).await?;
    let staged = stage_dir.join(STAGED_CATALOG);
    let backup = stage_dir.join(PREVIOUS_CATALOG);
    let target_exists = path_exists(target).await?;
    let staged_exists = path_exists(&staged).await?;
    let backup_exists = path_exists(&backup).await?;

    match phase {
        TransactionPhase::Installed => {
            if target_exists {
                finish_installed(stage_dir, target).await
            } else if backup_exists {
                // The installed target disappeared unexpectedly. The backup
                // is the only known-good catalog; restore it rather than
                // deleting the last copy during cleanup.
                restore_backup(stage_dir, target).await
            } else {
                Err(invalid_layout(
                    stage_dir,
                    "installed marker exists but neither target nor backup exists",
                ))
            }
        }
        TransactionPhase::Swapping => match (target_exists, staged_exists, backup_exists) {
            (true, false, _) => finish_installed(stage_dir, target).await,
            (false, _, true) => restore_backup(stage_dir, target).await,
            (false, true, false) => {
                // There was no previous catalog. Complete the one atomic
                // visibility step rather than leaving the catalog absent.
                ensure_target_parent(target).await?;
                tokio::fs::rename(&staged, target).await?;
                sync_rename_parents(&staged, target).await?;
                write_phase_marker(stage_dir, INSTALLED_MARKER).await?;
                finish_installed(stage_dir, target).await
            }
            (true, true, false) => {
                // The old target was never moved. Abort the prepared update.
                remove_path(stage_dir).await
            }
            (true, true, true) => Err(invalid_layout(
                stage_dir,
                "target, staged catalog, and backup all exist",
            )),
            (false, false, false) => Err(invalid_layout(
                stage_dir,
                "all catalog copies disappeared during swap",
            )),
        },
        TransactionPhase::Created | TransactionPhase::Prepared => {
            match (target_exists, backup_exists) {
                (true, false) => remove_path(stage_dir).await,
                (false, true) => restore_backup(stage_dir, target).await,
                (true, true) => Err(invalid_layout(
                    stage_dir,
                    "backup exists before the swapping phase",
                )),
                (false, false) if staged_exists => {
                    // A first-ever catalog was fully prepared before the
                    // crash. Installing it produces a coherent catalog and
                    // avoids booting with no catalog at all.
                    ensure_target_parent(target).await?;
                    tokio::fs::rename(&staged, target).await?;
                    sync_rename_parents(&staged, target).await?;
                    write_phase_marker(stage_dir, INSTALLED_MARKER).await?;
                    finish_installed(stage_dir, target).await
                }
                (false, false) => remove_path(stage_dir).await,
            }
        }
    }
}

async fn recover_legacy_backup(stage_dir: &Path, target: &Path) -> io::Result<()> {
    let backup = stage_dir.join(PREVIOUS_CATALOG);
    let staged = stage_dir.join(STAGED_CATALOG);
    if path_exists(target).await? {
        if path_exists(&staged).await? {
            return Err(invalid_layout(
                stage_dir,
                "legacy target, staged catalog, and backup all exist",
            ));
        }
        // The second rename completed: target is a whole directory and is
        // expected to be coherent. Verify that invariant before deleting the
        // legacy transaction's only known-good catalog.
        validate_catalog_structure(target, "installed").await?;
        let target_parent = target.parent().ok_or_else(|| {
            invalid_layout(
                stage_dir,
                "installed legacy target has no parent directory to sync",
            )
        })?;
        sync_directory(target_parent).await?;
        remove_path(&backup).await?;
        remove_path(stage_dir).await
    } else {
        restore_backup(stage_dir, target).await
    }
}

async fn restore_backup(stage_dir: &Path, target: &Path) -> io::Result<()> {
    let backup = stage_dir.join(PREVIOUS_CATALOG);
    if path_exists(target).await? {
        return Err(invalid_layout(
            stage_dir,
            "refusing to overwrite an existing target while restoring backup",
        ));
    }
    ensure_target_parent(target).await?;
    tokio::fs::rename(&backup, target).await?;
    sync_rename_parents(&backup, target).await?;
    remove_path(stage_dir).await
}

async fn ensure_target_parent(target: &Path) -> io::Result<()> {
    if let Some(parent) = target.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    Ok(())
}

async fn finish_installed(stage_dir: &Path, target: &Path) -> io::Result<()> {
    finish_installed_with_parent_sync_hook(stage_dir, target, |_| Ok(())).await
}

/// Completes garbage collection only after the installed directory entry is
/// durable in its parent. `before_parent_sync` is a deterministic fault seam
/// for the power-loss window between target rename and parent-directory fsync.
async fn finish_installed_with_parent_sync_hook<F>(
    stage_dir: &Path,
    target: &Path,
    before_parent_sync: F,
) -> io::Result<()>
where
    F: FnOnce(&Path) -> io::Result<()>,
{
    if !path_exists(target).await? {
        return Err(invalid_layout(
            stage_dir,
            "cannot finish transaction without an installed target",
        ));
    }
    // A whole-directory rename is the coherence boundary, but recovery may
    // encounter a target changed outside this transaction. Never delete the
    // only known-good prior catalog until the installed directory still has
    // the minimum valid catalog shape.
    validate_catalog_structure(target, "installed").await?;
    let backup = stage_dir.join(PREVIOUS_CATALOG);
    if path_exists(&backup).await? {
        let target_parent = target.parent().ok_or_else(|| {
            invalid_layout(
                stage_dir,
                "installed target has no parent directory to sync",
            )
        })?;
        // The target rename is not crash-durable merely because the target
        // directory itself was synced. Persist its directory entry before
        // unlinking the only known-good prior catalog. If this fails, return
        // with both the target and backup intact so startup recovery retries
        // this exact fence.
        before_parent_sync(target_parent)?;
        sync_directory(target_parent).await?;
        remove_path(&backup).await?;
        sync_directory(stage_dir).await?;
    }
    remove_path(stage_dir).await
}

async fn validate_catalog_structure(catalog: &Path, label: &str) -> io::Result<()> {
    let metadata = tokio::fs::symlink_metadata(catalog).await?;
    if !metadata.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("{label} tools catalog is not a directory"),
        ));
    }
    let endpoint = catalog.join(ENDPOINT_FILE);
    let endpoint_metadata = tokio::fs::symlink_metadata(&endpoint).await?;
    if !endpoint_metadata.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("{label} tools catalog endpoint is not a regular file"),
        ));
    }
    sync_directory(catalog).await
}

async fn write_transaction_header(stage_dir: &Path) -> io::Result<()> {
    let content = serde_json::to_vec(&TransactionHeader::current())
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    write_new_durable_file(&stage_dir.join(TRANSACTION_FILE), &content).await
}

async fn read_and_validate_header(stage_dir: &Path) -> io::Result<()> {
    let content = tokio::fs::read(stage_dir.join(TRANSACTION_FILE)).await?;
    let header: TransactionHeader = serde_json::from_slice(&content)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    header.validate()
}

async fn read_phase(stage_dir: &Path) -> io::Result<TransactionPhase> {
    if path_exists(&stage_dir.join(INSTALLED_MARKER)).await? {
        Ok(TransactionPhase::Installed)
    } else if path_exists(&stage_dir.join(SWAPPING_MARKER)).await? {
        Ok(TransactionPhase::Swapping)
    } else if path_exists(&stage_dir.join(PREPARED_MARKER)).await? {
        Ok(TransactionPhase::Prepared)
    } else {
        Ok(TransactionPhase::Created)
    }
}

async fn write_phase_marker(stage_dir: &Path, name: &str) -> io::Result<()> {
    let path = stage_dir.join(name);
    if path_exists(&path).await? {
        return Ok(());
    }
    write_new_durable_file(&path, b"1\n").await
}

async fn write_new_durable_file(path: &Path, content: &[u8]) -> io::Result<()> {
    let mut options = tokio::fs::OpenOptions::new();
    options.write(true).create_new(true);
    let mut file = options.open(path).await?;
    file.write_all(content).await?;
    file.sync_all().await?;
    drop(file);
    if let Some(parent) = path.parent() {
        sync_directory(parent).await?;
    }
    Ok(())
}

async fn sync_rename_parents(from: &Path, to: &Path) -> io::Result<()> {
    // Persist the new name before persisting removal of the old one. On a
    // cross-directory rename, syncing the source first creates a power-loss
    // window where neither directory entry is durable.
    if let Some(parent) = to.parent() {
        sync_directory(parent).await?;
    }
    if let Some(parent) = from.parent() {
        if Some(parent) != to.parent() {
            sync_directory(parent).await?;
        }
    }
    Ok(())
}

#[cfg(unix)]
async fn sync_directory(path: &Path) -> io::Result<()> {
    tokio::fs::File::open(path).await?.sync_all().await
}

#[cfg(not(unix))]
async fn sync_directory(_path: &Path) -> io::Result<()> {
    // Windows directory handles require platform-specific flags. Atomic rename
    // still preserves catalog coherence; the journal remains the recovery
    // oracle, while directory-entry durability follows the filesystem policy.
    Ok(())
}

async fn path_exists(path: &Path) -> io::Result<bool> {
    match tokio::fs::symlink_metadata(path).await {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

async fn remove_path(path: &Path) -> io::Result<()> {
    let metadata = match tokio::fs::symlink_metadata(path).await {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    if metadata.is_dir() {
        tokio::fs::remove_dir_all(path).await
    } else {
        tokio::fs::remove_file(path).await
    }
}

fn invalid_layout(stage_dir: &Path, detail: &str) -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        format!(
            "ambiguous tools catalog transaction at {}: {detail}; preserving recovery artifacts",
            stage_dir.display()
        ),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn write_catalog(path: &Path, endpoint: &str, tool: &str) {
        tokio::fs::create_dir_all(path).await.unwrap();
        tokio::fs::write(path.join(ENDPOINT_FILE), endpoint)
            .await
            .unwrap();
        tokio::fs::write(path.join("tool.json"), tool)
            .await
            .unwrap();
    }

    async fn begin_swap(root: &Path, target: &Path) -> PathBuf {
        let stage = root.join("txn");
        let staged = stage.join(STAGED_CATALOG);
        tokio::fs::create_dir_all(root).await.unwrap();
        write_catalog(target, "old-endpoint", "old-tool").await;
        write_catalog(&staged, "new-endpoint", "new-tool").await;
        write_transaction_header(&stage).await.unwrap();
        write_phase_marker(&stage, PREPARED_MARKER).await.unwrap();
        write_phase_marker(&stage, SWAPPING_MARKER).await.unwrap();
        tokio::fs::rename(target, stage.join(PREVIOUS_CATALOG))
            .await
            .unwrap();
        stage
    }

    #[tokio::test]
    async fn recovery_restores_only_prior_catalog_when_swap_was_interrupted() {
        let root = tempfile::tempdir().unwrap();
        let mutations = root.path().join("mutations");
        let target = root.path().join("repo/.deco/tools");
        let stage = begin_swap(&mutations, &target).await;

        recover_mutation_stages(&mutations, &target).await.unwrap();

        assert_eq!(
            tokio::fs::read_to_string(target.join(ENDPOINT_FILE))
                .await
                .unwrap(),
            "old-endpoint"
        );
        assert_eq!(
            tokio::fs::read_to_string(target.join("tool.json"))
                .await
                .unwrap(),
            "old-tool"
        );
        assert!(!stage.exists());
    }

    #[tokio::test]
    async fn recovery_finishes_new_catalog_after_atomic_directory_install() {
        let root = tempfile::tempdir().unwrap();
        let mutations = root.path().join("mutations");
        let target = root.path().join("repo/.deco/tools");
        let stage = begin_swap(&mutations, &target).await;
        tokio::fs::rename(stage.join(STAGED_CATALOG), &target)
            .await
            .unwrap();

        recover_mutation_stages(&mutations, &target).await.unwrap();

        assert_eq!(
            tokio::fs::read_to_string(target.join(ENDPOINT_FILE))
                .await
                .unwrap(),
            "new-endpoint"
        );
        assert_eq!(
            tokio::fs::read_to_string(target.join("tool.json"))
                .await
                .unwrap(),
            "new-tool"
        );
        assert!(!stage.exists());
    }

    #[tokio::test]
    async fn target_parent_sync_failure_retains_backup_until_recovery_retries_it() {
        let root = tempfile::tempdir().unwrap();
        let mutations = root.path().join("mutations");
        let target = root.path().join("repo/.deco/tools");
        let stage = begin_swap(&mutations, &target).await;
        let backup = stage.join(PREVIOUS_CATALOG);
        tokio::fs::rename(stage.join(STAGED_CATALOG), &target)
            .await
            .unwrap();

        let expected_parent = target.parent().unwrap().to_path_buf();
        let error = finish_installed_with_parent_sync_hook(&stage, &target, |parent| {
            assert_eq!(parent, expected_parent);
            assert!(
                backup.exists(),
                "backup was deleted before target-parent sync began"
            );
            Err(io::Error::other("injected target-parent fsync failure"))
        })
        .await
        .unwrap_err();

        assert_eq!(error.kind(), io::ErrorKind::Other);
        assert!(
            target.exists(),
            "installed catalog disappeared after fsync failure"
        );
        assert!(
            backup.exists(),
            "known-good backup must survive target-parent fsync failure"
        );
        assert!(
            stage.exists(),
            "recovery journal must survive fsync failure"
        );

        // This is the exact startup path after the failed durability fence.
        // It must retry target.parent() fsync before deleting the backup.
        recover_mutation_stages(&mutations, &target).await.unwrap();

        assert_eq!(
            tokio::fs::read_to_string(target.join(ENDPOINT_FILE))
                .await
                .unwrap(),
            "new-endpoint"
        );
        assert!(
            !stage.exists(),
            "successful recovery did not finish cleanup"
        );
    }

    #[tokio::test]
    async fn recovery_preserves_backup_when_installed_target_is_incoherent() {
        let root = tempfile::tempdir().unwrap();
        let mutations = root.path().join("mutations");
        let target = root.path().join("repo/.deco/tools");
        let stage = begin_swap(&mutations, &target).await;
        tokio::fs::rename(stage.join(STAGED_CATALOG), &target)
            .await
            .unwrap();
        tokio::fs::remove_file(target.join(ENDPOINT_FILE))
            .await
            .unwrap();

        let error = recover_mutation_stages(&mutations, &target)
            .await
            .unwrap_err();

        assert_eq!(error.kind(), io::ErrorKind::NotFound);
        assert!(
            stage.join(PREVIOUS_CATALOG).exists(),
            "known-good backup was deleted before target validation"
        );
        assert!(stage.exists(), "recovery evidence must remain intact");
    }

    #[tokio::test]
    async fn corrupt_journal_never_deletes_the_only_prior_catalog() {
        let root = tempfile::tempdir().unwrap();
        let mutations = root.path().join("mutations");
        let stage = mutations.join("txn");
        let backup = stage.join(PREVIOUS_CATALOG);
        let target = root.path().join("repo/.deco/tools");
        write_catalog(&backup, "only-endpoint", "only-tool").await;
        tokio::fs::write(stage.join(TRANSACTION_FILE), b"not-json")
            .await
            .unwrap();

        let error = recover_mutation_stages(&mutations, &target)
            .await
            .unwrap_err();

        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        assert!(backup.exists(), "the only prior catalog must be preserved");
        assert!(!target.exists());
    }

    #[tokio::test]
    async fn legacy_backup_is_restored_instead_of_blindly_deleted() {
        let root = tempfile::tempdir().unwrap();
        let mutations = root.path().join("mutations");
        let stage = mutations.join("legacy");
        let target = root.path().join("repo/.deco/tools");
        write_catalog(
            &stage.join(PREVIOUS_CATALOG),
            "legacy-endpoint",
            "legacy-tool",
        )
        .await;

        recover_mutation_stages(&mutations, &target).await.unwrap();

        assert_eq!(
            tokio::fs::read_to_string(target.join(ENDPOINT_FILE))
                .await
                .unwrap(),
            "legacy-endpoint"
        );
        assert!(!stage.exists());
    }

    #[tokio::test]
    async fn legacy_recovery_preserves_backup_when_target_is_incoherent() {
        let root = tempfile::tempdir().unwrap();
        let mutations = root.path().join("mutations");
        let stage = mutations.join("legacy");
        let backup = stage.join(PREVIOUS_CATALOG);
        let target = root.path().join("repo/.deco/tools");
        write_catalog(&backup, "legacy-endpoint", "legacy-tool").await;
        tokio::fs::create_dir_all(&target).await.unwrap();
        tokio::fs::write(target.join("tool.json"), "incomplete-tool")
            .await
            .unwrap();

        let error = recover_mutation_stages(&mutations, &target)
            .await
            .unwrap_err();

        assert_eq!(error.kind(), io::ErrorKind::NotFound);
        assert!(backup.exists(), "known-good legacy backup was discarded");
        assert!(stage.exists(), "legacy recovery evidence must be retained");
    }

    #[tokio::test]
    async fn install_replaces_endpoint_and_tool_files_as_one_directory() {
        let root = tempfile::tempdir().unwrap();
        let stage = root.path().join("mutations/txn");
        let staged = stage.join(STAGED_CATALOG);
        let target = root.path().join("repo/.deco/tools");
        write_catalog(&target, "old-endpoint", "old-tool").await;
        write_catalog(&staged, "new-endpoint", "new-tool").await;

        install(&stage, &staged, &target).await.unwrap();

        assert_eq!(
            tokio::fs::read_to_string(target.join(ENDPOINT_FILE))
                .await
                .unwrap(),
            "new-endpoint"
        );
        assert_eq!(
            tokio::fs::read_to_string(target.join("tool.json"))
                .await
                .unwrap(),
            "new-tool"
        );
        assert!(!stage.exists());
    }
}
