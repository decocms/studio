//! Verified, account-scoped filesystem roots for managed native sandboxes.
//!
//! An upstream account subject is never used as a path. Its complete
//! [`RtAccountScope::storage_key`](crate::routes::threads::db::RtAccountScope::storage_key)
//! is hashed with a domain separator, and the resulting directory carries an
//! exact private marker. Every account ticket re-opens and verifies that
//! marker before the directory can be used. A missing, replaced, symlinked,
//! or mismatched marker therefore fails closed instead of silently adopting
//! another account's files.
//!
//! This is an application identity and lifecycle boundary, not an operating-
//! system sandbox. Native coding-agent processes run as the desktop user and
//! therefore share that user's filesystem authority. Stable symlinks,
//! mismatched markers, stale account epochs, and accidental cross-account
//! reuse fail closed; protection from a malicious same-UID process requires a
//! separate OS isolation boundary and must not be inferred from these paths.

use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use sha2::{Digest, Sha256};

const ACCOUNT_MARKER_FILE: &str = ".account-scope-v1";
const ACCOUNT_STORAGE_DOMAIN: &[u8] = b"decocms-native-account-storage-v1\0";
const MAX_STORAGE_KEY_BYTES: usize = 8 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct AccountStorage {
    storage_key: Arc<str>,
    app_root: PathBuf,
    root: PathBuf,
}

impl AccountStorage {
    /// Creates or verifies the private directory for `storage_key`.
    pub(crate) fn open(app_root: &Path, storage_key: &str) -> Result<Self, String> {
        if storage_key.is_empty() || storage_key.len() > MAX_STORAGE_KEY_BYTES {
            return Err(format!(
                "sandbox account storage key must contain 1..={MAX_STORAGE_KEY_BYTES} bytes"
            ));
        }

        verify_real_directory(app_root)?;
        let accounts_root = app_root.join("accounts");
        ensure_private_directory(&accounts_root)?;
        let version_root = accounts_root.join("v1");
        ensure_private_directory(&version_root)?;

        let root = version_root.join(storage_directory_name(storage_key));
        match fs::symlink_metadata(&root) {
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                create_account_root(&version_root, &root, storage_key)?;
            }
            Err(error) => {
                return Err(format!(
                    "failed to inspect sandbox account root {root:?}: {error}"
                ));
            }
        }

        let storage = Self {
            storage_key: Arc::from(storage_key),
            app_root: app_root.to_path_buf(),
            root,
        };
        storage.verify()?;
        Ok(storage)
    }

    /// Discover account roots that were fully published by an earlier process.
    /// Boot-time maintenance must not blindly walk `accounts/`: every returned
    /// root is a real private directory whose bounded marker hashes back to its
    /// exact directory name and passes the same verification as a live account.
    pub(crate) fn discover_existing(app_root: &Path) -> Result<Vec<Self>, String> {
        verify_real_directory(app_root)?;
        let accounts_root = app_root.join("accounts");
        if !verify_optional_private_directory(&accounts_root)? {
            return Ok(Vec::new());
        }
        let version_root = accounts_root.join("v1");
        if !verify_optional_private_directory(&version_root)? {
            return Ok(Vec::new());
        }

        let entries = fs::read_dir(&version_root).map_err(|error| {
            format!("failed to enumerate sandbox account roots {version_root:?}: {error}")
        })?;
        let mut accounts = Vec::new();
        for entry in entries {
            let entry = entry
                .map_err(|error| format!("failed to enumerate sandbox account root: {error}"))?;
            let root = entry.path();
            let name = entry
                .file_name()
                .into_string()
                .map_err(|_| format!("sandbox account root name is not valid UTF-8: {root:?}"))?;
            // An interrupted publisher may leave its private temporary root.
            // It was never authoritative and must not be adopted or traversed.
            if name.starts_with('.') {
                continue;
            }
            verify_private_directory(&root)?;
            let marker = root.join(ACCOUNT_MARKER_FILE);
            let marker_value = read_verified_marker(&marker)?;
            let storage_key = String::from_utf8(marker_value)
                .map_err(|_| format!("sandbox account marker is not valid UTF-8: {marker:?}"))?;
            if storage_directory_name(&storage_key) != name {
                return Err(format!(
                    "sandbox account root does not match its marker: {root:?}"
                ));
            }
            let storage = Self::open(app_root, &storage_key)?;
            if storage.root != root {
                return Err(format!(
                    "sandbox account discovery resolved a different root: {root:?}"
                ));
            }
            accounts.push(storage);
        }
        accounts.sort_by(|left, right| left.id().cmp(right.id()));
        Ok(accounts)
    }

    pub(crate) fn storage_key(&self) -> &str {
        &self.storage_key
    }

    pub(crate) fn root(&self) -> &Path {
        &self.root
    }

    /// Opaque account directory identifier safe for logs and process keys.
    /// The authenticated storage key is deliberately never exposed as a path.
    pub(crate) fn id(&self) -> &str {
        self.root
            .file_name()
            .and_then(|name| name.to_str())
            .expect("account storage root always ends in its ASCII digest")
    }

    #[cfg(test)]
    pub(crate) fn worktrees_root(&self) -> Result<PathBuf, String> {
        self.verified_child_root(&[super::WORKTREES_DIR])
    }

    pub(crate) fn worktree_root(&self, handle: &str) -> Result<PathBuf, String> {
        validate_managed_handle(handle)?;
        let mut components = Vec::with_capacity(handle.split('/').count() + 1);
        components.push(super::WORKTREES_DIR);
        components.extend(handle.split('/'));
        self.verified_child_root(&components)
    }

    pub(crate) fn workdir(&self, handle: &str) -> Result<PathBuf, String> {
        let path = self.worktree_root(handle)?.join("repo");
        // Git creates the checkout root using the process umask, which is
        // commonly 0755. This exact managed leaf is the one place where an
        // existing real directory is normalized before it is admitted back
        // into private account storage. Ancestors and every other managed
        // directory remain reject-only.
        ensure_private_managed_workdir(&path)?;
        Ok(path)
    }

    pub(crate) fn logs_dir(&self, handle: &str) -> Result<PathBuf, String> {
        let path = self.worktree_root(handle)?.join("logs");
        ensure_private_directory(&path)?;
        Ok(path)
    }

    pub(crate) fn mutation_root(&self, handle: &str) -> Result<PathBuf, String> {
        let root = self.worktree_root(handle)?;
        let decocms = root.join(".decocms");
        ensure_private_directory(&decocms)?;
        let mutations = decocms.join("mutations");
        ensure_private_directory(&mutations)?;
        Ok(mutations)
    }

    #[cfg(test)]
    pub(crate) fn repos_root(&self) -> Result<PathBuf, String> {
        self.verified_child_root(&["repos"])
    }

    /// Verified canonical bare-repository directory for `clone_url`.
    /// Every existing path component is inspected without adopting a stable
    /// symlink, so corrupt account state cannot silently redirect the shared
    /// object store out of this authenticated account root.
    pub(crate) fn canonical_repo_dir(&self, clone_url: &str) -> Result<Option<PathBuf>, String> {
        let Some(scope) = super::repo_store::repo_scope(clone_url) else {
            return Ok(None);
        };
        let mut components = Vec::with_capacity(scope.len() + 1);
        components.push("repos");
        components.extend(scope.iter().map(String::as_str));
        self.verified_child_root(&components).map(Some)
    }

    pub(crate) fn orgs_root(&self) -> Result<PathBuf, String> {
        self.verified_child_root(&["orgs"])
    }

    pub(crate) fn rclone_config_root(&self) -> Result<PathBuf, String> {
        self.verified_child_root(&[".decocms", "rclone"])
    }

    /// Revalidates the root and marker immediately before account-bound state
    /// is materialized. The marker is intentionally not cached as trust.
    pub(crate) fn verify(&self) -> Result<(), String> {
        verify_real_directory(&self.app_root)?;
        verify_private_directory(&self.app_root.join("accounts"))?;
        verify_private_directory(&self.app_root.join("accounts/v1"))?;
        verify_private_directory(&self.root)?;
        let marker = self.root.join(ACCOUNT_MARKER_FILE);
        let metadata = fs::symlink_metadata(&marker).map_err(|error| {
            format!("failed to inspect sandbox account marker {marker:?}: {error}")
        })?;
        if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
            return Err(format!(
                "sandbox account marker is not a regular file: {marker:?}"
            ));
        }
        verify_private_file_mode(&marker, &metadata)?;
        let marker_value = read_verified_marker(&marker)?;
        if marker_value != self.storage_key.as_bytes() {
            return Err(format!(
                "sandbox account marker does not match the authenticated account: {marker:?}"
            ));
        }
        Ok(())
    }

    fn verified_child_root(&self, components: &[&str]) -> Result<PathBuf, String> {
        self.verify()?;
        let mut current = self.root.clone();
        for component in components {
            debug_assert!(!component.is_empty() && !component.contains('/'));
            current.push(component);
            ensure_private_directory(&current)?;
        }
        self.verify()?;
        for ancestor in current.ancestors() {
            if ancestor == self.root {
                break;
            }
            verify_private_directory(ancestor)?;
        }
        verify_private_directory(&current)?;
        Ok(current)
    }
}

fn read_verified_marker(path: &Path) -> Result<Vec<u8>, String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("failed to inspect sandbox account marker {path:?}: {error}"))?;
    if !metadata.file_type().is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() > MAX_STORAGE_KEY_BYTES as u64
    {
        return Err(format!(
            "sandbox account marker is not a bounded regular file: {path:?}"
        ));
    }
    let mut file = fs::File::open(path)
        .map_err(|error| format!("failed to open sandbox account marker {path:?}: {error}"))?;
    let opened = same_file::Handle::from_file(file.try_clone().map_err(|error| {
        format!("failed to duplicate sandbox account marker {path:?}: {error}")
    })?)
    .map_err(|error| format!("failed to identify sandbox account marker {path:?}: {error}"))?;
    let current = same_file::Handle::from_path(path).map_err(|error| {
        format!("failed to re-identify sandbox account marker {path:?}: {error}")
    })?;
    let current_metadata = fs::symlink_metadata(path).map_err(|error| {
        format!("failed to re-inspect sandbox account marker {path:?}: {error}")
    })?;
    if opened != current
        || !current_metadata.file_type().is_file()
        || current_metadata.file_type().is_symlink()
        || current_metadata.len() > MAX_STORAGE_KEY_BYTES as u64
    {
        return Err(format!(
            "sandbox account marker changed while it was opened: {path:?}"
        ));
    }

    let mut value = Vec::with_capacity(current_metadata.len() as usize);
    Read::by_ref(&mut file)
        .take(MAX_STORAGE_KEY_BYTES as u64 + 1)
        .read_to_end(&mut value)
        .map_err(|error| format!("failed to read sandbox account marker {path:?}: {error}"))?;
    if value.len() > MAX_STORAGE_KEY_BYTES {
        return Err(format!("sandbox account marker is oversized: {path:?}"));
    }
    let final_handle = same_file::Handle::from_path(path)
        .map_err(|error| format!("failed to verify sandbox account marker {path:?}: {error}"))?;
    let final_metadata = fs::symlink_metadata(path).map_err(|error| {
        format!("failed to finish inspecting sandbox account marker {path:?}: {error}")
    })?;
    if opened != final_handle
        || !final_metadata.file_type().is_file()
        || final_metadata.file_type().is_symlink()
        || final_metadata.len() > MAX_STORAGE_KEY_BYTES as u64
    {
        return Err(format!(
            "sandbox account marker changed while it was read: {path:?}"
        ));
    }
    verify_private_file_mode(path, &final_metadata)?;
    Ok(value)
}

fn storage_directory_name(storage_key: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(ACCOUNT_STORAGE_DOMAIN);
    digest.update(storage_key.as_bytes());
    digest
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub(crate) fn validate_managed_handle(handle: &str) -> Result<(), String> {
    let valid = handle.len() <= 255
        && super::handle_is_path_safe(handle)
        && handle.split('/').all(|segment| {
            segment
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
        });
    if valid {
        Ok(())
    } else {
        Err(format!("sandbox handle is not path-safe: {handle:?}"))
    }
}

fn ensure_private_directory(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(_) => verify_private_directory(path),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            create_private_directory(path)?;
            verify_private_directory(path)
        }
        Err(error) => Err(format!(
            "failed to inspect sandbox account directory {path:?}: {error}"
        )),
    }
}

fn verify_optional_private_directory(path: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Ok(_) => verify_private_directory(path).map(|()| true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!(
            "failed to inspect sandbox account directory {path:?}: {error}"
        )),
    }
}

fn ensure_private_managed_workdir(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if !metadata.file_type().is_dir() || metadata.file_type().is_symlink() {
                return Err(format!(
                    "sandbox account workdir is not a real directory: {path:?}"
                ));
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;

                let directory = fs::File::open(path).map_err(|error| {
                    format!("failed to open sandbox account workdir {path:?}: {error}")
                })?;
                let opened =
                    same_file::Handle::from_file(directory.try_clone().map_err(|error| {
                        format!(
                            "failed to duplicate sandbox account workdir handle {path:?}: {error}"
                        )
                    })?)
                    .map_err(|error| {
                        format!("failed to identify sandbox account workdir {path:?}: {error}")
                    })?;
                let current = same_file::Handle::from_path(path).map_err(|error| {
                    format!("failed to re-identify sandbox account workdir {path:?}: {error}")
                })?;
                let current_metadata = fs::symlink_metadata(path).map_err(|error| {
                    format!("failed to re-inspect sandbox account workdir {path:?}: {error}")
                })?;
                if opened != current
                    || !current_metadata.file_type().is_dir()
                    || current_metadata.file_type().is_symlink()
                {
                    return Err(format!(
                        "sandbox account workdir changed while it was opened: {path:?}"
                    ));
                }
                directory
                    .set_permissions(fs::Permissions::from_mode(0o700))
                    .map_err(|error| {
                        format!("failed to make sandbox account workdir private {path:?}: {error}")
                    })?;
                let final_handle = same_file::Handle::from_path(path).map_err(|error| {
                    format!("failed to verify sandbox account workdir {path:?}: {error}")
                })?;
                if opened != final_handle {
                    return Err(format!(
                        "sandbox account workdir changed while it was secured: {path:?}"
                    ));
                }
            }
            verify_private_directory(path)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            create_private_directory(path)?;
            verify_private_directory(path)
        }
        Err(error) => Err(format!(
            "failed to inspect sandbox account workdir {path:?}: {error}"
        )),
    }
}

fn create_private_directory(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        let mut builder = fs::DirBuilder::new();
        builder.mode(0o700);
        match builder.create(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
            Err(error) => Err(format!(
                "failed to create sandbox account directory {path:?}: {error}"
            )),
        }
    }
    #[cfg(not(unix))]
    {
        match fs::create_dir(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
            Err(error) => Err(format!(
                "failed to create sandbox account directory {path:?}: {error}"
            )),
        }
    }
}

fn verify_private_directory(path: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        format!("failed to inspect sandbox account directory {path:?}: {error}")
    })?;
    if !metadata.file_type().is_dir() || metadata.file_type().is_symlink() {
        return Err(format!(
            "sandbox account directory is not a real directory: {path:?}"
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err(format!(
                "sandbox account directory permissions are not private: {path:?}"
            ));
        }
    }
    Ok(())
}

fn verify_real_directory(path: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("failed to inspect directory {path:?}: {error}"))?;
    if !metadata.file_type().is_dir() || metadata.file_type().is_symlink() {
        return Err(format!("directory is not a real directory: {path:?}"));
    }
    Ok(())
}

fn verify_private_file_mode(path: &Path, metadata: &fs::Metadata) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err(format!(
                "sandbox account marker permissions are not private: {path:?}"
            ));
        }
    }
    Ok(())
}

fn create_account_root(parent: &Path, root: &Path, storage_key: &str) -> Result<(), String> {
    let name = root
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| format!("sandbox account root has no filename: {root:?}"))?;
    let temporary = (0..8)
        .find_map(|_| {
            let candidate = parent.join(format!(".{name}.tmp-{}", uuid::Uuid::new_v4()));
            match create_private_directory_exclusive(&candidate) {
                Ok(()) => Some(Ok(candidate)),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => None,
                Err(error) => Some(Err(format!(
                    "failed to create unpublished sandbox account root {candidate:?}: {error}"
                ))),
            }
        })
        .transpose()?
        .ok_or_else(|| "could not allocate an unpublished sandbox account root".to_string())?;

    let result = (|| {
        let marker = temporary.join(ACCOUNT_MARKER_FILE);
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&marker).map_err(|error| {
            format!("failed to create sandbox account marker {marker:?}: {error}")
        })?;
        file.write_all(storage_key.as_bytes()).map_err(|error| {
            format!("failed to write sandbox account marker {marker:?}: {error}")
        })?;
        file.sync_all().map_err(|error| {
            format!("failed to sync sandbox account marker {marker:?}: {error}")
        })?;
        sync_directory(&temporary)?;

        let published = match fs::rename(&temporary, root) {
            Ok(()) => Ok(()),
            Err(error) => match fs::symlink_metadata(root) {
                // Another creator won the race. The caller verifies the
                // complete destination marker before returning it.
                Ok(_) => Ok(()),
                Err(_) => Err(format!(
                    "failed to publish sandbox account root {root:?}: {error}"
                )),
            },
        };
        published?;
        crate::fs_util::sync_parent_dir(root).map_err(|error| {
            format!("failed to sync sandbox account root parent {parent:?}: {error}")
        })
    })();

    if temporary.exists() {
        if let Err(error) = fs::remove_dir_all(&temporary) {
            tracing::warn!(?temporary, %error, "failed to remove unpublished account root");
        }
    }
    result
}

fn sync_directory(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        fs::File::open(path)
            .and_then(|directory| directory.sync_all())
            .map_err(|error| format!("failed to sync sandbox account directory {path:?}: {error}"))
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        Ok(())
    }
}

fn create_private_directory_exclusive(path: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        let mut builder = fs::DirBuilder::new();
        builder.mode(0o700).create(path)
    }
    #[cfg(not(unix))]
    {
        fs::create_dir(path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_key_reopens_and_different_keys_have_disjoint_roots() {
        let app_root = tempfile::tempdir().unwrap();
        let first = AccountStorage::open(app_root.path(), "v1:account-a").unwrap();
        let reopened = AccountStorage::open(app_root.path(), "v1:account-a").unwrap();
        let second = AccountStorage::open(app_root.path(), "v1:account-b").unwrap();

        assert_eq!(first, reopened);
        assert_ne!(first.root(), second.root());
        assert_eq!(first.id().len(), 64);
        assert!(!first.root().to_string_lossy().contains("account-a"));
    }

    #[test]
    fn discovery_returns_only_published_verified_account_roots() {
        let app_root = tempfile::tempdir().unwrap();
        assert!(AccountStorage::discover_existing(app_root.path())
            .unwrap()
            .is_empty());

        let first = AccountStorage::open(app_root.path(), "v1:account-a").unwrap();
        let second = AccountStorage::open(app_root.path(), "v1:account-b").unwrap();
        let temporary = app_root.path().join("accounts/v1/.unpublished.tmp");
        create_private_directory(&temporary).unwrap();

        let discovered = AccountStorage::discover_existing(app_root.path()).unwrap();
        assert_eq!(discovered.len(), 2);
        assert!(discovered.iter().any(|storage| storage == &first));
        assert!(discovered.iter().any(|storage| storage == &second));
    }

    #[test]
    fn discovery_rejects_a_root_whose_marker_does_not_match_its_name() {
        let app_root = tempfile::tempdir().unwrap();
        let storage = AccountStorage::open(app_root.path(), "v1:account-a").unwrap();
        let marker = storage.root().join(ACCOUNT_MARKER_FILE);
        fs::write(&marker, b"v1:account-b").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&marker, fs::Permissions::from_mode(0o600)).unwrap();
        }

        assert!(AccountStorage::discover_existing(app_root.path()).is_err());
    }

    #[test]
    fn missing_or_mismatched_marker_is_never_adopted() {
        let app_root = tempfile::tempdir().unwrap();
        let storage = AccountStorage::open(app_root.path(), "v1:account-a").unwrap();
        let marker = storage.root().join(ACCOUNT_MARKER_FILE);

        fs::remove_file(&marker).unwrap();
        assert!(AccountStorage::open(app_root.path(), "v1:account-a").is_err());

        fs::write(&marker, b"v1:account-b").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&marker, fs::Permissions::from_mode(0o600)).unwrap();
        }
        assert!(AccountStorage::open(app_root.path(), "v1:account-a").is_err());

        fs::write(&marker, vec![b'x'; MAX_STORAGE_KEY_BYTES + 1]).unwrap();
        assert!(AccountStorage::open(app_root.path(), "v1:account-a").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_marker_and_root_are_rejected() {
        use std::os::unix::fs::symlink;

        let app_root = tempfile::tempdir().unwrap();
        let storage = AccountStorage::open(app_root.path(), "v1:account-a").unwrap();
        let marker = storage.root().join(ACCOUNT_MARKER_FILE);
        let replacement = app_root.path().join("replacement");
        fs::write(&replacement, b"v1:account-a").unwrap();
        fs::remove_file(&marker).unwrap();
        symlink(&replacement, &marker).unwrap();
        assert!(AccountStorage::open(app_root.path(), "v1:account-a").is_err());

        let other_root = app_root.path().join("other-root");
        fs::create_dir(&other_root).unwrap();
        fs::remove_dir_all(storage.root()).unwrap();
        symlink(&other_root, storage.root()).unwrap();
        assert!(AccountStorage::open(app_root.path(), "v1:account-a").is_err());
    }

    #[test]
    fn concurrent_open_publishes_one_verified_account_root() {
        let app_root = tempfile::tempdir().unwrap();
        let barrier = Arc::new(std::sync::Barrier::new(8));
        let roots = std::thread::scope(|scope| {
            let mut workers = Vec::new();
            for _ in 0..8 {
                let barrier = barrier.clone();
                let app_root = app_root.path();
                workers.push(scope.spawn(move || {
                    barrier.wait();
                    AccountStorage::open(app_root, "v1:one-account")
                        .unwrap()
                        .root()
                        .to_path_buf()
                }));
            }
            workers
                .into_iter()
                .map(|worker| worker.join().unwrap())
                .collect::<Vec<_>>()
        });
        assert!(roots.windows(2).all(|pair| pair[0] == pair[1]));
        AccountStorage::open(app_root.path(), "v1:one-account")
            .unwrap()
            .verify()
            .unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn replaced_intermediate_or_child_directory_fails_closed() {
        use std::os::unix::fs::symlink;

        let app_root = tempfile::tempdir().unwrap();
        let storage = AccountStorage::open(app_root.path(), "v1:account-a").unwrap();
        let external = tempfile::tempdir().unwrap();
        symlink(external.path(), storage.root().join("orgs")).unwrap();
        assert!(storage.orgs_root().is_err());

        std::fs::remove_file(storage.root().join("orgs")).unwrap();
        let version_root = app_root.path().join("accounts/v1");
        std::fs::remove_dir_all(&version_root).unwrap();
        symlink(external.path(), &version_root).unwrap();
        assert!(storage.verify().is_err());
        assert!(AccountStorage::open(app_root.path(), "v1:account-a").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_handle_component_cannot_escape_the_account_root() {
        use std::os::unix::fs::symlink;

        let app_root = tempfile::tempdir().unwrap();
        let external = tempfile::tempdir().unwrap();
        let storage = AccountStorage::open(app_root.path(), "v1:account-a").unwrap();
        let worktrees = storage.worktrees_root().unwrap();
        symlink(external.path(), worktrees.join("github.com")).unwrap();

        assert!(storage
            .worktree_root("github.com/acme/repo/feature")
            .is_err());
        assert!(std::fs::read_dir(external.path()).unwrap().next().is_none());
    }

    #[cfg(unix)]
    #[test]
    fn existing_git_workdir_is_made_private_but_symlinks_are_rejected() {
        use std::os::unix::fs::{symlink, PermissionsExt};

        let app_root = tempfile::tempdir().unwrap();
        let external = tempfile::tempdir().unwrap();
        let storage = AccountStorage::open(app_root.path(), "v1:account-a").unwrap();
        let handle = "github.com/acme/repo/main";
        let worktree_root = storage.worktree_root(handle).unwrap();
        let workdir = worktree_root.join("repo");
        fs::create_dir(&workdir).unwrap();
        fs::set_permissions(&workdir, fs::Permissions::from_mode(0o755)).unwrap();

        assert_eq!(storage.workdir(handle).unwrap(), workdir);
        assert_eq!(
            fs::symlink_metadata(&workdir).unwrap().permissions().mode() & 0o777,
            0o700
        );

        fs::remove_dir(&workdir).unwrap();
        symlink(external.path(), &workdir).unwrap();
        assert!(storage.workdir(handle).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_canonical_repo_component_cannot_escape_the_account_root() {
        use std::os::unix::fs::symlink;

        let app_root = tempfile::tempdir().unwrap();
        let external = tempfile::tempdir().unwrap();
        let sentinel = external.path().join("sentinel");
        fs::write(&sentinel, b"untouched").unwrap();
        let storage = AccountStorage::open(app_root.path(), "v1:account-a").unwrap();
        let repos = storage.repos_root().unwrap();
        symlink(external.path(), repos.join("acme")).unwrap();

        assert!(storage
            .canonical_repo_dir("https://github.com/acme/site.git")
            .is_err());
        assert_eq!(fs::read(&sentinel).unwrap(), b"untouched");
        assert!(!external.path().join("site").exists());
    }
}
