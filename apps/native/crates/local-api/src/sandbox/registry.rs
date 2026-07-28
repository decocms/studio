//! Durable control-plane index for native git sandboxes.
//!
//! Repository contents and retained terminal output live on the filesystem;
//! this SQLite database stores the small amount of meaning that cannot be
//! recovered from an opaque sandbox directory name: its config, paths,
//! desired/observed state, and which sandbox was last focused. The in-memory
//! `SandboxManager` map is deliberately only a cache of live Rust objects.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, ErrorCode, OptionalExtension, TransactionBehavior};

use super::manager::{GitSandboxConfig, SandboxManager};

const DATABASE_FILE_NAME: &str = "sandboxes.sqlite";
const CURRENT_SCHEMA_VERSION: i64 = 2;

#[derive(Debug)]
enum RegistryOpenError {
    Sqlite {
        context: &'static str,
        source: rusqlite::Error,
    },
    Corrupt(String),
    FutureVersion(i64),
    UnsupportedVersion(i64),
}

impl RegistryOpenError {
    fn sqlite(context: &'static str, source: rusqlite::Error) -> Self {
        Self::Sqlite { context, source }
    }

    fn is_corruption(&self) -> bool {
        match self {
            Self::Corrupt(_) => true,
            Self::Sqlite { source, .. } => matches!(
                source.sqlite_error_code(),
                Some(ErrorCode::DatabaseCorrupt | ErrorCode::NotADatabase)
            ),
            Self::FutureVersion(_) => false,
            Self::UnsupportedVersion(_) => false,
        }
    }
}

impl std::fmt::Display for RegistryOpenError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Sqlite { context, source } => write!(formatter, "{context}: {source}"),
            Self::Corrupt(reason) => write!(formatter, "sandbox registry is corrupt: {reason}"),
            Self::FutureVersion(version) => write!(
                formatter,
                "sandbox registry schema version {version} is newer than supported version {CURRENT_SCHEMA_VERSION}"
            ),
            Self::UnsupportedVersion(version) => {
                write!(formatter, "unsupported sandbox registry schema version {version}")
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SandboxRecord {
    pub handle: String,
    pub config: GitSandboxConfig,
    pub sandbox_path: PathBuf,
    pub workdir_path: PathBuf,
    pub desired_status: String,
    pub observed_status: String,
    /// Earliest safe setup step for the next process generation.
    pub resume_step: String,
    pub error: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub last_seen_at: i64,
}

pub(crate) struct SandboxRegistry {
    app_root: PathBuf,
    database_path: Option<PathBuf>,
    connection: Mutex<Connection>,
}

impl SandboxRegistry {
    pub(crate) fn open(app_root: PathBuf) -> Result<Self, String> {
        std::fs::create_dir_all(&app_root)
            .map_err(|error| format!("failed to create native app root {app_root:?}: {error}"))?;

        // A handful of old unit helpers intentionally use the process-wide
        // temp directory as an app root. Giving those managers isolated
        // in-memory registries prevents otherwise unrelated parallel tests
        // from sharing `/tmp/sandboxes.sqlite`; real app roots and unique
        // tempdirs always exercise the durable file-backed database.
        let database_path = app_root.join(DATABASE_FILE_NAME);
        #[cfg(test)]
        let use_memory_database = app_root == std::env::temp_dir();
        #[cfg(not(test))]
        let use_memory_database = false;

        let (connection, persistent_path) = if use_memory_database {
            let connection = open_configured_connection(None)
                .map_err(|error| format!("failed to open native sandbox registry: {error}"))?;
            (connection, None)
        } else {
            let connection = open_persistent_registry(&database_path)?;
            (connection, Some(database_path))
        };

        let registry = Self {
            app_root,
            database_path: persistent_path,
            connection: Mutex::new(connection),
        };
        registry.secure_database_files()?;
        // The in-memory branch exists only for old unit fixtures that share
        // the process temp root; importing arbitrary real `/tmp/sandboxes`
        // sidecars would couple those otherwise isolated tests together.
        if registry.database_path.is_some() {
            registry.import_legacy_sidecars()?;
        }
        registry.reconcile_after_process_start()?;
        Ok(registry)
    }

    pub(crate) fn upsert_config(
        &self,
        handle: &str,
        config: &GitSandboxConfig,
        sandbox_path: &Path,
        workdir_path: &Path,
    ) -> Result<(), String> {
        validate_identity(handle, config)?;
        let now = now_unix_seconds();
        let config_json = serde_json::to_string(config)
            .map_err(|error| format!("failed to serialize sandbox config: {error}"))?;
        self.connection()
            .execute(
                r#"
                INSERT INTO sandboxes (
                    handle, virtual_mcp_id, clone_url, branch, config_json,
                    sandbox_path, workdir_path, desired_status,
                    observed_status, resume_step, error,
                    created_at, updated_at, last_seen_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'running',
                          'provisioning', 'clone', NULL, ?8, ?8, ?8)
                ON CONFLICT(handle) DO UPDATE SET
                    virtual_mcp_id = excluded.virtual_mcp_id,
                    clone_url = excluded.clone_url,
                    branch = excluded.branch,
                    config_json = excluded.config_json,
                    sandbox_path = excluded.sandbox_path,
                    workdir_path = excluded.workdir_path,
                    desired_status = 'running',
                    observed_status = 'provisioning',
                    error = NULL,
                    updated_at = excluded.updated_at,
                    last_seen_at = excluded.last_seen_at
                "#,
                params![
                    handle,
                    config.virtual_mcp_id,
                    config.clone_url,
                    normalized_branch(config),
                    config_json,
                    sandbox_path.to_string_lossy(),
                    workdir_path.to_string_lossy(),
                    now,
                ],
            )
            .map_err(|error| format!("failed to persist sandbox {handle}: {error}"))?;
        self.secure_database_files()?;
        Ok(())
    }

    pub(crate) fn record(&self, handle: &str) -> Result<Option<SandboxRecord>, String> {
        let raw = self
            .connection()
            .query_row(
                r#"
                SELECT handle, config_json, sandbox_path, workdir_path,
                       desired_status, observed_status, resume_step,
                       error, created_at, updated_at, last_seen_at
                FROM sandboxes WHERE handle = ?1
                "#,
                [handle],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, String>(6)?,
                        row.get::<_, Option<String>>(7)?,
                        row.get::<_, i64>(8)?,
                        row.get::<_, i64>(9)?,
                        row.get::<_, i64>(10)?,
                    ))
                },
            )
            .optional()
            .map_err(|error| format!("failed to read sandbox {handle}: {error}"))?;
        let Some((
            handle,
            config_json,
            sandbox_path,
            workdir_path,
            desired_status,
            observed_status,
            resume_step,
            error,
            created_at,
            updated_at,
            last_seen_at,
        )) = raw
        else {
            return Ok(None);
        };
        let config = serde_json::from_str(&config_json)
            .map_err(|error| format!("sandbox {handle} has an invalid stored config: {error}"))?;
        Ok(Some(SandboxRecord {
            handle,
            config,
            sandbox_path: PathBuf::from(sandbox_path),
            workdir_path: PathBuf::from(workdir_path),
            desired_status,
            observed_status,
            resume_step,
            error,
            created_at,
            updated_at,
            last_seen_at,
        }))
    }

    pub(crate) fn contains(&self, handle: &str) -> Result<bool, String> {
        self.connection()
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sandboxes WHERE handle = ?1)",
                [handle],
                |row| row.get(0),
            )
            .map_err(|error| format!("failed to look up sandbox {handle}: {error}"))
    }

    pub(crate) fn set_active(&self, handle: &str) -> Result<(), String> {
        if !self.contains(handle)? {
            return Err(format!("unknown sandbox handle: {handle}"));
        }
        let now = now_unix_seconds();
        let mut connection = self.connection();
        // IMMEDIATE, not the DEFERRED default: this transaction reads and then
        // writes, and a deferred transaction that upgrades to a write lock is
        // returned SQLITE_BUSY *without* the connection's busy_timeout being
        // applied — so a concurrent writer surfaces as a hard "database is
        // locked" instead of waiting. Taking the write lock up front is what
        // makes the timeout do its job.
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("failed to begin active-sandbox update: {error}"))?;
        transaction
            .execute(
                "INSERT INTO sandbox_metadata (key, value) VALUES ('active_handle', ?1) \
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                [handle],
            )
            .map_err(|error| format!("failed to persist active sandbox: {error}"))?;
        transaction
            .execute(
                "UPDATE sandboxes SET last_seen_at = ?2, updated_at = ?2 WHERE handle = ?1",
                params![handle, now],
            )
            .map_err(|error| format!("failed to touch active sandbox: {error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("failed to commit active sandbox: {error}"))?;
        self.secure_database_files()
    }

    pub(crate) fn active_handle(&self) -> Result<Option<String>, String> {
        self.connection()
            .query_row(
                "SELECT value FROM sandbox_metadata WHERE key = 'active_handle'",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| format!("failed to read active sandbox: {error}"))
    }

    pub(crate) fn mark_state(
        &self,
        handle: &str,
        desired_status: &str,
        observed_status: &str,
        error: Option<&str>,
    ) -> Result<(), String> {
        let changed = self
            .connection()
            .execute(
                "UPDATE sandboxes SET desired_status = ?2, observed_status = ?3, \
                 error = ?4, updated_at = ?5, last_seen_at = ?5 WHERE handle = ?1",
                params![
                    handle,
                    desired_status,
                    observed_status,
                    error,
                    now_unix_seconds()
                ],
            )
            .map_err(|db_error| format!("failed to update sandbox {handle} state: {db_error}"))?;
        if changed == 0 {
            return Err(format!("unknown sandbox handle: {handle}"));
        }
        self.secure_database_files()
    }

    pub(crate) fn mark_observed(
        &self,
        handle: &str,
        observed_status: &str,
        error: Option<&str>,
        resume_step: Option<&str>,
    ) -> Result<(), String> {
        let changed = self
            .connection()
            .execute(
                "UPDATE sandboxes SET observed_status = ?2, error = ?3, \
                 resume_step = COALESCE(?4, resume_step), updated_at = ?5, \
                 last_seen_at = ?5 WHERE handle = ?1",
                params![
                    handle,
                    observed_status,
                    error,
                    resume_step,
                    now_unix_seconds()
                ],
            )
            .map_err(|db_error| {
                format!("failed to update sandbox {handle} observation: {db_error}")
            })?;
        if changed == 0 {
            return Err(format!("unknown sandbox handle: {handle}"));
        }
        self.secure_database_files()
    }

    fn import_legacy_sidecars(&self) -> Result<(), String> {
        let sandboxes_root = self.app_root.join(crate::sandbox::WORKTREES_DIR);
        let Ok(entries) = std::fs::read_dir(&sandboxes_root) else {
            return Ok(());
        };
        for entry in entries.flatten() {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if !file_type.is_dir() {
                continue;
            }
            let Some(handle) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            if self.contains(&handle)? {
                continue;
            }
            let Some(config) = super::persist::read_sidecar(&self.app_root, &handle) else {
                continue;
            };
            let sandbox_path = entry.path();
            let workdir_path = sandbox_path.join("repo");
            self.upsert_config(&handle, &config, &sandbox_path, &workdir_path)?;
            if is_valid_git_worktree(&workdir_path) {
                self.mark_observed(&handle, "stopped", None, Some("install"))?;
            }
            self.mark_state(&handle, "running", "stopped", None)?;
        }

        if self.active_handle()?.is_none() {
            if let Some(handle) = super::persist::read_active_handle(&self.app_root) {
                if self.contains(&handle)? {
                    self.set_active(&handle)?;
                }
            }
        }
        Ok(())
    }

    /// A new backend process owns none of the prior process handles. Retained
    /// worktrees are still valid, but any formerly transitional/running state
    /// is observed as stopped until `ensure` re-adopts and starts it.
    fn reconcile_after_process_start(&self) -> Result<(), String> {
        let root = self.app_root.join(crate::sandbox::WORKTREES_DIR);
        let mut connection = self.connection();
        // IMMEDIATE for the same reason as `set_active` above — this one
        // reads every row and then writes, and runs at EVERY registry open,
        // so it is the one most likely to meet a concurrent writer.
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("failed to begin sandbox reconciliation: {error}"))?;
        {
            let mut statement = transaction
                .prepare("SELECT handle, sandbox_path, workdir_path FROM sandboxes")
                .map_err(|error| format!("failed to prepare sandbox reconciliation: {error}"))?;
            let rows = statement
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        PathBuf::from(row.get::<_, String>(1)?),
                        PathBuf::from(row.get::<_, String>(2)?),
                    ))
                })
                .map_err(|error| format!("failed to enumerate sandboxes: {error}"))?;
            for row in rows {
                let (handle, sandbox_path, workdir_path) =
                    row.map_err(|error| format!("failed to read sandbox row: {error}"))?;
                let expected = root.join(&handle);
                let valid = sandbox_path == expected
                    && workdir_path == expected.join("repo")
                    && sandbox_path.is_dir()
                    && is_valid_git_worktree(&workdir_path);
                let (observed, error): (&str, Option<&str>) = if valid {
                    ("stopped", None)
                } else {
                    (
                        "absent",
                        Some(
                            "sandbox workdir is missing, not a valid git worktree, or outside the managed root",
                        ),
                    )
                };
                transaction
                    .execute(
                        "UPDATE sandboxes SET observed_status = ?2, error = ?3, updated_at = ?4 \
                         WHERE handle = ?1",
                        params![handle, observed, error, now_unix_seconds()],
                    )
                    .map_err(|db_error| {
                        format!("failed to reconcile sandbox {handle}: {db_error}")
                    })?;
            }
        }
        transaction
            .execute(
                "DELETE FROM sandbox_metadata WHERE key = 'active_handle' AND NOT EXISTS (\
                 SELECT 1 FROM sandboxes WHERE handle = sandbox_metadata.value \
                 AND observed_status != 'absent')",
                [],
            )
            .map_err(|error| format!("failed to reconcile active sandbox: {error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("failed to commit sandbox reconciliation: {error}"))?;
        self.secure_database_files()
    }

    fn connection(&self) -> MutexGuard<'_, Connection> {
        self.connection
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn secure_database_files(&self) -> Result<(), String> {
        let Some(path) = &self.database_path else {
            return Ok(());
        };
        set_private_permissions(path)?;
        set_private_permissions(&PathBuf::from(format!("{}-wal", path.display())))?;
        set_private_permissions(&PathBuf::from(format!("{}-shm", path.display())))
    }
}

fn open_persistent_registry(path: &Path) -> Result<Connection, String> {
    // Permission and filesystem failures happen before SQLite sees the file.
    // They are operational errors, not evidence that user data is corrupt.
    prepare_private_database_file(path)?;

    match open_configured_connection(Some(path)) {
        Ok(connection) => Ok(connection),
        Err(error) if error.is_corruption() => {
            let reason = error.to_string();
            let quarantined = quarantine_database_files(path)?;
            tracing::warn!(
                database = ?path,
                ?quarantined,
                %reason,
                "sandbox: quarantined corrupt registry and rebuilding from sidecars"
            );
            prepare_private_database_file(path)?;
            open_configured_connection(Some(path)).map_err(|rebuild_error| {
                format!(
                    "failed to rebuild native sandbox registry after quarantining corruption ({reason}): {rebuild_error}"
                )
            })
        }
        Err(error) => Err(format!("failed to open native sandbox registry: {error}")),
    }
}

fn open_configured_connection(path: Option<&Path>) -> Result<Connection, RegistryOpenError> {
    let mut connection = match path {
        Some(path) => Connection::open(path),
        None => Connection::open_in_memory(),
    }
    .map_err(|error| RegistryOpenError::sqlite("failed to open database", error))?;

    connection
        .busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|error| RegistryOpenError::sqlite("failed to configure busy timeout", error))?;

    // Read the version before enabling WAL or running any DDL. In particular,
    // opening a DB from a newer app build must be a read-only rejection rather
    // than silently rewriting its header or creating journal companions.
    let schema_version: i64 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|error| RegistryOpenError::sqlite("failed to read schema version", error))?;
    if schema_version > CURRENT_SCHEMA_VERSION {
        return Err(RegistryOpenError::FutureVersion(schema_version));
    }
    if schema_version < 0 {
        return Err(RegistryOpenError::UnsupportedVersion(schema_version));
    }

    if path.is_some() {
        connection
            .pragma_update(None, "journal_mode", "WAL")
            .map_err(|error| RegistryOpenError::sqlite("failed to enable WAL", error))?;
    }
    connection
        .pragma_update(None, "foreign_keys", "ON")
        .map_err(|error| RegistryOpenError::sqlite("failed to enable foreign keys", error))?;

    migrate_schema(&mut connection, schema_version)?;

    let quick_check: String = connection
        .query_row("PRAGMA quick_check(1)", [], |row| row.get(0))
        .map_err(|error| RegistryOpenError::sqlite("failed to check database integrity", error))?;
    if !quick_check.eq_ignore_ascii_case("ok") {
        return Err(RegistryOpenError::Corrupt(quick_check));
    }

    Ok(connection)
}

fn migrate_schema(
    connection: &mut Connection,
    schema_version: i64,
) -> Result<(), RegistryOpenError> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| RegistryOpenError::sqlite("failed to begin schema migration", error))?;

    match schema_version {
        0 => {
            transaction
                .execute_batch(
                    r#"
                    CREATE TABLE IF NOT EXISTS sandboxes (
                        handle TEXT PRIMARY KEY NOT NULL,
                        virtual_mcp_id TEXT NOT NULL,
                        clone_url TEXT NOT NULL,
                        branch TEXT NOT NULL,
                        config_json TEXT NOT NULL,
                        sandbox_path TEXT NOT NULL,
                        workdir_path TEXT NOT NULL,
                        desired_status TEXT NOT NULL,
                        observed_status TEXT NOT NULL,
                        resume_step TEXT NOT NULL DEFAULT 'clone',
                        error TEXT,
                        created_at INTEGER NOT NULL,
                        updated_at INTEGER NOT NULL,
                        last_seen_at INTEGER NOT NULL
                    );
                    CREATE TABLE IF NOT EXISTS sandbox_metadata (
                        key TEXT PRIMARY KEY NOT NULL,
                        value TEXT NOT NULL
                    );
                    "#,
                )
                .map_err(|error| RegistryOpenError::sqlite("failed to create schema", error))?;

            // A version-zero file can predate version tracking while already
            // containing the v1 table. CREATE IF NOT EXISTS cannot add the v2
            // column, so make that upgrade explicit inside the same transaction.
            add_resume_step_if_missing(&transaction)?;
        }
        1 => add_resume_step_if_missing(&transaction)?,
        CURRENT_SCHEMA_VERSION => {}
        version => return Err(RegistryOpenError::UnsupportedVersion(version)),
    }

    validate_schema(&transaction)?;
    transaction
        .pragma_update(None, "user_version", CURRENT_SCHEMA_VERSION)
        .map_err(|error| RegistryOpenError::sqlite("failed to record schema version", error))?;
    transaction
        .commit()
        .map_err(|error| RegistryOpenError::sqlite("failed to commit schema migration", error))
}

fn add_resume_step_if_missing(connection: &Connection) -> Result<(), RegistryOpenError> {
    let has_resume_step: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info('sandboxes') WHERE name = 'resume_step')",
            [],
            |row| row.get(0),
        )
        .map_err(|error| RegistryOpenError::sqlite("failed to inspect v1 schema", error))?;
    if !has_resume_step {
        connection
            .execute(
                "ALTER TABLE sandboxes ADD COLUMN resume_step TEXT NOT NULL DEFAULT 'clone'",
                [],
            )
            .map_err(|error| RegistryOpenError::sqlite("failed to migrate schema to v2", error))?;
    }
    Ok(())
}

fn validate_schema(connection: &Connection) -> Result<(), RegistryOpenError> {
    connection
        .prepare(
            r#"
            SELECT handle, virtual_mcp_id, clone_url, branch, config_json,
                   sandbox_path, workdir_path, desired_status, observed_status,
                   resume_step, error, created_at, updated_at, last_seen_at
            FROM sandboxes LIMIT 0
            "#,
        )
        .map_err(|error| RegistryOpenError::sqlite("sandbox table does not match v2", error))?;
    connection
        .prepare("SELECT key, value FROM sandbox_metadata LIMIT 0")
        .map_err(|error| RegistryOpenError::sqlite("metadata table does not match v2", error))?;
    Ok(())
}

fn sqlite_companion_path(path: &Path, suffix: &str) -> PathBuf {
    let mut value = path.as_os_str().to_os_string();
    value.push(suffix);
    PathBuf::from(value)
}

/// Moves a corrupt SQLite database and its live journal companions aside
/// without deleting anything. Each rename is atomic; if a later companion
/// fails to move, earlier moves are rolled back before startup returns an
/// error, so callers never intentionally proceed with a split set.
fn quarantine_database_files(path: &Path) -> Result<Vec<PathBuf>, String> {
    let sources = [
        path.to_path_buf(),
        sqlite_companion_path(path, "-wal"),
        sqlite_companion_path(path, "-shm"),
    ];
    let tag = format!(
        "corrupt-{}-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
        std::process::id()
    );
    let mut moves = Vec::new();
    for source in sources {
        match std::fs::symlink_metadata(&source) {
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                return Err(format!(
                    "failed to inspect corrupt sandbox registry file {source:?}: {error}"
                ));
            }
        }
        set_private_permissions(&source)?;
        let mut destination = source.as_os_str().to_os_string();
        destination.push(format!(".{tag}"));
        let destination = PathBuf::from(destination);
        if destination.exists() {
            return Err(format!(
                "refusing to overwrite existing sandbox registry quarantine {destination:?}"
            ));
        }
        moves.push((source, destination));
    }

    let mut moved = Vec::new();
    for (source, destination) in &moves {
        if let Err(error) = std::fs::rename(source, destination) {
            let mut rollback_errors = Vec::new();
            for (prior_source, prior_destination) in moved.iter().rev() {
                if let Err(rollback_error) = std::fs::rename(prior_destination, prior_source) {
                    rollback_errors.push(format!(
                        "{prior_destination:?} -> {prior_source:?}: {rollback_error}"
                    ));
                }
            }
            let rollback = if rollback_errors.is_empty() {
                String::new()
            } else {
                format!("; rollback also failed: {}", rollback_errors.join(", "))
            };
            return Err(format!(
                "failed to quarantine corrupt sandbox registry {source:?}: {error}{rollback}"
            ));
        }
        moved.push((source.clone(), destination.clone()));
    }

    sync_database_directory(path)?;
    Ok(moved
        .into_iter()
        .map(|(_, destination)| destination)
        .collect())
}

#[cfg(unix)]
fn sync_database_directory(path: &Path) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("sandbox registry path has no parent: {path:?}"))?;
    std::fs::File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| format!("failed to sync sandbox registry directory {parent:?}: {error}"))
}

#[cfg(not(unix))]
fn sync_database_directory(_path: &Path) -> Result<(), String> {
    Ok(())
}

fn prepare_private_database_file(path: &Path) -> Result<(), String> {
    let mut options = std::fs::OpenOptions::new();
    options.create(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
        .open(path)
        .map_err(|error| format!("failed to create private sandbox registry {path:?}: {error}"))?;
    set_private_permissions(path)
}

fn set_private_permissions(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).map_err(
            |error| format!("failed to make sandbox registry file private {path:?}: {error}"),
        )?;
    }
    Ok(())
}

fn normalized_branch(config: &GitSandboxConfig) -> &str {
    config
        .branch
        .as_deref()
        .filter(|branch| !branch.is_empty())
        .unwrap_or("main")
}

/// Validates the on-disk shape Git itself uses for a checkout without running
/// a blocking subprocess during async application startup. A normal clone has
/// a `.git` directory; a linked worktree has a small `.git` file pointing at
/// the canonical repository's `.git/worktrees/<name>` administrative dir.
fn is_valid_git_worktree(workdir: &Path) -> bool {
    if !workdir.is_dir() {
        return false;
    }
    let dot_git = workdir.join(".git");
    let Ok(metadata) = std::fs::metadata(&dot_git) else {
        return false;
    };
    if metadata.is_dir() {
        return dot_git.join("HEAD").is_file();
    }
    if !metadata.is_file() || metadata.len() > 16 * 1024 {
        return false;
    }

    let Ok(contents) = std::fs::read_to_string(&dot_git) else {
        return false;
    };
    let Some(gitdir) = contents.trim().strip_prefix("gitdir:") else {
        return false;
    };
    let gitdir = gitdir.trim();
    if gitdir.is_empty() || gitdir.lines().count() != 1 {
        return false;
    }
    let gitdir = PathBuf::from(gitdir);
    let gitdir = if gitdir.is_absolute() {
        gitdir
    } else {
        workdir.join(gitdir)
    };
    gitdir.is_dir() && gitdir.join("HEAD").is_file()
}

fn validate_identity(handle: &str, config: &GitSandboxConfig) -> Result<(), String> {
    if config.virtual_mcp_id.trim().is_empty() {
        return Err("virtualMcpId is required".to_string());
    }
    if config.clone_url.trim().is_empty() {
        return Err("repo.cloneUrl is required".to_string());
    }
    let expected =
        SandboxManager::compute_handle(&config.virtual_mcp_id, normalized_branch(config));
    if handle != expected {
        return Err(format!(
            "sandbox handle/config mismatch: expected {expected}, got {handle}"
        ));
    }
    Ok(())
}

fn now_unix_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> GitSandboxConfig {
        GitSandboxConfig {
            org_slug: Some("acme".to_string()),
            virtual_mcp_id: "vmcp-registry".to_string(),
            clone_url: "https://example.com/acme/repo.git".to_string(),
            branch: Some("feature/registry".to_string()),
            runtime: Some("bun".to_string()),
            package_manager: Some("bun".to_string()),
            package_manager_path: Some("packages/app".to_string()),
            git_user_name: Some("Test User".to_string()),
            git_user_email: Some("test@example.com".to_string()),
        }
    }

    fn create_git_checkout(workdir: &Path) {
        std::fs::create_dir_all(workdir.join(".git")).unwrap();
        std::fs::write(workdir.join(".git/HEAD"), b"ref: refs/heads/main\n").unwrap();
    }

    fn create_v1_schema(connection: &Connection) {
        connection
            .execute_batch(
                r#"
                CREATE TABLE sandboxes (
                    handle TEXT PRIMARY KEY NOT NULL,
                    virtual_mcp_id TEXT NOT NULL,
                    clone_url TEXT NOT NULL,
                    branch TEXT NOT NULL,
                    config_json TEXT NOT NULL,
                    sandbox_path TEXT NOT NULL,
                    workdir_path TEXT NOT NULL,
                    desired_status TEXT NOT NULL,
                    observed_status TEXT NOT NULL,
                    error TEXT,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    last_seen_at INTEGER NOT NULL
                );
                CREATE TABLE sandbox_metadata (
                    key TEXT PRIMARY KEY NOT NULL,
                    value TEXT NOT NULL
                );
                PRAGMA user_version = 1;
                "#,
            )
            .unwrap();
    }

    #[test]
    fn registry_is_wal_and_survives_reopen() {
        let root = tempfile::tempdir().unwrap();
        let cfg = config();
        let handle =
            SandboxManager::compute_handle(&cfg.virtual_mcp_id, cfg.branch.as_deref().unwrap());
        let sandbox_path = root
            .path()
            .join(crate::sandbox::WORKTREES_DIR)
            .join(&handle);
        let workdir_path = sandbox_path.join("repo");
        create_git_checkout(&workdir_path);

        let registry = SandboxRegistry::open(root.path().to_path_buf()).unwrap();
        registry
            .upsert_config(&handle, &cfg, &sandbox_path, &workdir_path)
            .unwrap();
        registry.set_active(&handle).unwrap();
        registry
            .mark_state(&handle, "running", "running", None)
            .unwrap();
        drop(registry);

        let reopened = SandboxRegistry::open(root.path().to_path_buf()).unwrap();
        let record = reopened.record(&handle).unwrap().unwrap();
        assert_eq!(record.config, cfg);
        assert_eq!(record.desired_status, "running");
        assert_eq!(record.observed_status, "stopped");
        assert_eq!(
            reopened.active_handle().unwrap().as_deref(),
            Some(handle.as_str())
        );

        let connection = Connection::open(root.path().join(DATABASE_FILE_NAME)).unwrap();
        let journal_mode: String = connection
            .pragma_query_value(None, "journal_mode", |row| row.get(0))
            .unwrap();
        assert_eq!(journal_mode.to_ascii_lowercase(), "wal");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(root.path().join(DATABASE_FILE_NAME))
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o600);
        }
    }

    #[test]
    fn imports_sidecar_and_active_pointer_once() {
        let root = tempfile::tempdir().unwrap();
        let cfg = config();
        let handle =
            SandboxManager::compute_handle(&cfg.virtual_mcp_id, cfg.branch.as_deref().unwrap());
        create_git_checkout(
            &root
                .path()
                .join(crate::sandbox::WORKTREES_DIR)
                .join(&handle)
                .join("repo"),
        );
        super::super::persist::write_sidecar(root.path(), &handle, &cfg);
        super::super::persist::write_active_handle(root.path(), &handle);

        let registry = SandboxRegistry::open(root.path().to_path_buf()).unwrap();
        assert_eq!(registry.record(&handle).unwrap().unwrap().config, cfg);
        assert_eq!(
            registry.active_handle().unwrap().as_deref(),
            Some(handle.as_str())
        );
    }

    #[test]
    fn refuses_to_activate_an_unknown_handle() {
        let root = tempfile::tempdir().unwrap();
        let registry = SandboxRegistry::open(root.path().to_path_buf()).unwrap();
        assert_eq!(
            registry.set_active("phantom").unwrap_err(),
            "unknown sandbox handle: phantom"
        );
    }

    #[test]
    fn reconciliation_clears_active_when_its_workdir_is_missing() {
        let root = tempfile::tempdir().unwrap();
        let cfg = config();
        let handle =
            SandboxManager::compute_handle(&cfg.virtual_mcp_id, cfg.branch.as_deref().unwrap());
        let sandbox_path = root
            .path()
            .join(crate::sandbox::WORKTREES_DIR)
            .join(&handle);
        let workdir_path = sandbox_path.join("repo");
        create_git_checkout(&workdir_path);
        let registry = SandboxRegistry::open(root.path().to_path_buf()).unwrap();
        registry
            .upsert_config(&handle, &cfg, &sandbox_path, &workdir_path)
            .unwrap();
        registry.set_active(&handle).unwrap();
        drop(registry);
        std::fs::remove_dir_all(&sandbox_path).unwrap();

        let reopened = SandboxRegistry::open(root.path().to_path_buf()).unwrap();
        assert!(reopened.active_handle().unwrap().is_none());
        assert_eq!(
            reopened.record(&handle).unwrap().unwrap().observed_status,
            "absent"
        );
    }

    #[test]
    fn migrates_v1_to_v2_transactionally_without_losing_records() {
        let root = tempfile::tempdir().unwrap();
        let cfg = config();
        let handle =
            SandboxManager::compute_handle(&cfg.virtual_mcp_id, cfg.branch.as_deref().unwrap());
        let sandbox_path = root
            .path()
            .join(crate::sandbox::WORKTREES_DIR)
            .join(&handle);
        let workdir_path = sandbox_path.join("repo");
        create_git_checkout(&workdir_path);

        let database_path = root.path().join(DATABASE_FILE_NAME);
        let connection = Connection::open(&database_path).unwrap();
        create_v1_schema(&connection);
        connection
            .execute(
                r#"
                INSERT INTO sandboxes (
                    handle, virtual_mcp_id, clone_url, branch, config_json,
                    sandbox_path, workdir_path, desired_status, observed_status,
                    error, created_at, updated_at, last_seen_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'running', 'running',
                          NULL, 1, 2, 3)
                "#,
                params![
                    handle,
                    cfg.virtual_mcp_id,
                    cfg.clone_url,
                    normalized_branch(&cfg),
                    serde_json::to_string(&cfg).unwrap(),
                    sandbox_path.to_string_lossy(),
                    workdir_path.to_string_lossy(),
                ],
            )
            .unwrap();
        drop(connection);

        let registry = SandboxRegistry::open(root.path().to_path_buf()).unwrap();
        let record = registry.record(&handle).unwrap().unwrap();
        assert_eq!(record.config, cfg);
        assert_eq!(record.resume_step, "clone");
        assert_eq!(record.observed_status, "stopped");

        let connection = registry.connection();
        let version: i64 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, CURRENT_SCHEMA_VERSION);
        let has_resume_step: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM pragma_table_info('sandboxes') WHERE name = 'resume_step')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(has_resume_step);
    }

    #[test]
    fn rejects_future_schema_without_quarantining_or_mutating_it() {
        let root = tempfile::tempdir().unwrap();
        let database_path = root.path().join(DATABASE_FILE_NAME);
        let connection = Connection::open(&database_path).unwrap();
        connection.pragma_update(None, "user_version", 3).unwrap();
        drop(connection);

        let error = SandboxRegistry::open(root.path().to_path_buf())
            .err()
            .expect("future schema must fail closed");
        assert!(error.contains("newer than supported"), "{error}");

        let connection = Connection::open(&database_path).unwrap();
        let version: i64 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, 3);
        let has_quarantine = std::fs::read_dir(root.path()).unwrap().any(|entry| {
            entry
                .ok()
                .and_then(|entry| entry.file_name().into_string().ok())
                .is_some_and(|name| name.contains(".corrupt-"))
        });
        assert!(!has_quarantine);
    }

    #[test]
    fn quarantines_corruption_and_rebuilds_from_valid_sidecars() {
        let root = tempfile::tempdir().unwrap();
        let cfg = config();
        let handle =
            SandboxManager::compute_handle(&cfg.virtual_mcp_id, cfg.branch.as_deref().unwrap());
        let workdir_path = root
            .path()
            .join(crate::sandbox::WORKTREES_DIR)
            .join(&handle)
            .join("repo");
        create_git_checkout(&workdir_path);
        super::super::persist::write_sidecar(root.path(), &handle, &cfg);
        super::super::persist::write_active_handle(root.path(), &handle);

        let database_path = root.path().join(DATABASE_FILE_NAME);
        let corrupt_bytes = b"this is not a sqlite database";
        std::fs::write(&database_path, corrupt_bytes).unwrap();

        let registry = SandboxRegistry::open(root.path().to_path_buf()).unwrap();
        assert_eq!(registry.record(&handle).unwrap().unwrap().config, cfg);
        assert_eq!(
            registry.active_handle().unwrap().as_deref(),
            Some(handle.as_str())
        );

        let quarantine = std::fs::read_dir(root.path())
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .find(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with("sandboxes.sqlite.corrupt-"))
            })
            .expect("corrupt database must be retained beside its replacement");
        assert_eq!(std::fs::read(quarantine).unwrap(), corrupt_bytes);

        let connection = registry.connection();
        let version: i64 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, CURRENT_SCHEMA_VERSION);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&database_path)
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o600);
        }
    }

    #[test]
    fn recognizes_normal_checkouts_and_linked_worktrees() {
        let root = tempfile::tempdir().unwrap();
        let checkout = root.path().join("checkout");
        create_git_checkout(&checkout);
        assert!(is_valid_git_worktree(&checkout));

        let linked = root.path().join("linked");
        std::fs::create_dir_all(&linked).unwrap();
        let admin = root.path().join("canonical.git/worktrees/linked");
        std::fs::create_dir_all(&admin).unwrap();
        std::fs::write(admin.join("HEAD"), b"ref: refs/heads/thread\n").unwrap();
        std::fs::write(
            linked.join(".git"),
            format!("gitdir: {}\n", admin.display()),
        )
        .unwrap();
        assert!(is_valid_git_worktree(&linked));

        std::fs::remove_file(admin.join("HEAD")).unwrap();
        assert!(!is_valid_git_worktree(&linked));
    }
}
