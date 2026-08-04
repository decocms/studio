//! Durable control-plane index for native git sandboxes.
//!
//! Repository contents and retained terminal output live on the filesystem;
//! this SQLite database stores the small amount of meaning that cannot be
//! recovered from an opaque sandbox directory name: its config, paths,
//! desired/observed state, and which sandbox was last focused. The in-memory
//! `SandboxManager` map is deliberately only a cache of live Rust objects.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};

use super::account_storage::AccountStorage;
use super::manager::{GitSandboxConfig, SandboxManager};

/// Registry schema version, stored as a `sandbox_metadata` row — NOT
/// `PRAGMA user_version`, which belongs to the threads migration ladder now
/// that both subsystems share one `studio.db`. v4 is the merge itself; the
/// v0–v3 ladder lived in the retired `sandboxes.sqlite` and was dropped with
/// it, so any pre-merge file simply reads as fresh.
const CURRENT_SCHEMA_VERSION: i64 = 5;
const SCHEMA_VERSION_KEY: &str = "registry_schema_version";

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
        // from sharing `/tmp/studio.db`; real app roots and unique
        // tempdirs always exercise the durable file-backed database.
        let database_path = app_root.join(crate::STUDIO_DB_FILE_NAME);
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
            database_path: persistent_path,
            connection: Mutex::new(connection),
        };
        registry.secure_database_files()?;
        Ok(registry)
    }

    pub(crate) fn upsert_config_for_account(
        &self,
        storage: &AccountStorage,
        handle: &str,
        config: &GitSandboxConfig,
    ) -> Result<(), String> {
        validate_identity(handle, config)?;
        storage.verify()?;
        let account_scope = storage.storage_key();
        let now = now_unix_seconds();
        let config_json = serde_json::to_string(config)
            .map_err(|error| format!("failed to serialize sandbox config: {error}"))?;
        let mut connection = self.connection();
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("failed to begin sandbox upsert: {error}"))?;
        transaction
            .execute(
                r#"
                INSERT INTO sandboxes (
                    account_scope, handle, clone_url, branch, config_json, desired_status,
                    observed_status, resume_step, error,
                    created_at, updated_at, last_seen_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, 'running',
                          'provisioning', 'clone', NULL, ?6, ?6, ?6)
                ON CONFLICT(account_scope, handle) DO UPDATE SET
                    clone_url = excluded.clone_url,
                    branch = excluded.branch,
                    config_json = excluded.config_json,
                    desired_status = 'running',
                    observed_status = 'provisioning',
                    error = NULL,
                    updated_at = excluded.updated_at,
                    last_seen_at = excluded.last_seen_at
                "#,
                params![
                    account_scope,
                    handle,
                    config.clone_url,
                    normalized_branch(config),
                    config_json,
                    now,
                ],
            )
            .map_err(|error| format!("failed to persist sandbox {handle}: {error}"))?;
        // Additive: a second agent joining a repo+branch someone else already
        // opened must not displace the first, or the first's handle lookup
        // stops resolving while its sandbox is still very much alive.
        transaction
            .execute(
                "INSERT OR IGNORE INTO sandbox_agents (
                    account_scope, handle, virtual_mcp_id, created_at
                 ) VALUES (?1, ?2, ?3, ?4)",
                params![account_scope, handle, config.virtual_mcp_id, now],
            )
            .map_err(|error| format!("failed to record agent for sandbox {handle}: {error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("failed to commit sandbox {handle}: {error}"))?;
        drop(connection);
        self.secure_database_files()?;
        Ok(())
    }

    pub(crate) fn record_for_account(
        &self,
        storage: &AccountStorage,
        handle: &str,
    ) -> Result<Option<SandboxRecord>, String> {
        storage.verify()?;
        let mut rows = self.query_records(
            "SELECT handle, config_json,
                    desired_status, observed_status, resume_step,
                    error, created_at, updated_at, last_seen_at
             FROM sandboxes WHERE account_scope = ?1 AND handle = ?2",
            params![storage.storage_key(), handle],
            storage,
        )?;
        Ok(rows.pop())
    }

    /// Every durable sandbox this virtual MCP has claimed, joined through the
    /// account-scoped `sandbox_agents` association table.
    ///
    /// This is the registry-backed replacement for walking `worktrees/` and
    /// reading sidecars on request paths: one indexed query instead of a
    /// recursive directory scan per request.
    pub(crate) fn records_for_virtual_mcp_for_account(
        &self,
        storage: &AccountStorage,
        virtual_mcp_id: &str,
    ) -> Result<Vec<SandboxRecord>, String> {
        storage.verify()?;
        self.query_records(
            "SELECT s.handle, s.config_json,
                    s.desired_status, s.observed_status, s.resume_step,
                    s.error, s.created_at, s.updated_at, s.last_seen_at
             FROM sandboxes s
             JOIN sandbox_agents a
               ON a.account_scope = s.account_scope AND a.handle = s.handle
             WHERE s.account_scope = ?1 AND a.virtual_mcp_id = ?2
             ORDER BY s.handle",
            params![storage.storage_key(), virtual_mcp_id],
            storage,
        )
    }

    /// Every registered handle. The set is one row per worktree on this
    /// machine — small by construction.
    pub(crate) fn handles_for_account(
        &self,
        storage: &AccountStorage,
    ) -> Result<Vec<String>, String> {
        storage.verify()?;
        let connection = self.connection();
        let mut statement = connection
            .prepare("SELECT handle FROM sandboxes WHERE account_scope = ?1 ORDER BY handle")
            .map_err(|error| format!("failed to list sandbox handles: {error}"))?;
        let rows = statement
            .query_map([storage.storage_key()], |row| row.get::<_, String>(0))
            .map_err(|error| format!("failed to list sandbox handles: {error}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("failed to list sandbox handles: {error}"))
    }

    fn query_records<P: rusqlite::Params>(
        &self,
        sql: &str,
        params: P,
        storage: &AccountStorage,
    ) -> Result<Vec<SandboxRecord>, String> {
        let connection = self.connection();
        let mut statement = connection
            .prepare(sql)
            .map_err(|error| format!("failed to read sandboxes: {error}"))?;
        let rows = statement
            .query_map(params, |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, i64>(6)?,
                    row.get::<_, i64>(7)?,
                    row.get::<_, i64>(8)?,
                ))
            })
            .map_err(|error| format!("failed to read sandboxes: {error}"))?;

        let mut records = Vec::new();
        for raw in rows {
            let (
                handle,
                config_json,
                desired_status,
                observed_status,
                resume_step,
                error,
                created_at,
                updated_at,
                last_seen_at,
            ) = raw.map_err(|error| format!("failed to read sandboxes: {error}"))?;
            let config = serde_json::from_str(&config_json).map_err(|error| {
                format!("sandbox {handle} has an invalid stored config: {error}")
            })?;
            super::account_storage::validate_managed_handle(&handle)?;
            validate_identity(&handle, &config)?;
            let sandbox_path = storage.worktree_root(&handle)?;
            let workdir_path = sandbox_path.join("repo");
            records.push(SandboxRecord {
                handle,
                config,
                sandbox_path,
                workdir_path,
                desired_status,
                observed_status,
                resume_step,
                error,
                created_at,
                updated_at,
                last_seen_at,
            });
        }
        Ok(records)
    }

    pub(crate) fn contains_for_account(
        &self,
        storage: &AccountStorage,
        handle: &str,
    ) -> Result<bool, String> {
        storage.verify()?;
        self.connection()
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sandboxes \
                 WHERE account_scope = ?1 AND handle = ?2)",
                params![storage.storage_key(), handle],
                |row| row.get(0),
            )
            .map_err(|error| format!("failed to look up sandbox {handle}: {error}"))
    }

    /// The handle of the worktree a virtual MCP is using for `branch`.
    ///
    /// The handle is derived from the REPOSITORY and branch, but the routes
    /// the shell calls are keyed by `(virtualMcpId, branch)` — they never see
    /// a clone URL. The registry stores all three, so it is the one place that
    /// can bridge them without a filesystem scan.
    ///
    /// `None` when this virtual MCP has no worktree for that branch yet.
    pub(crate) fn handle_for_virtual_mcp_for_account(
        &self,
        storage: &AccountStorage,
        virtual_mcp_id: &str,
        branch: &str,
    ) -> Result<Option<String>, String> {
        storage.verify()?;
        // Several agents can share one repo+branch sandbox; the association
        // table preserves every claimant without conflating account scopes.
        self.connection()
            .query_row(
                "SELECT s.handle FROM sandboxes s
                 JOIN sandbox_agents a
                   ON a.account_scope = s.account_scope AND a.handle = s.handle
                 WHERE s.account_scope = ?1 AND a.virtual_mcp_id = ?2 AND s.branch = ?3
                 ORDER BY s.last_seen_at DESC LIMIT 1",
                params![storage.storage_key(), virtual_mcp_id, branch],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| {
                format!("failed to resolve a worktree for {virtual_mcp_id}@{branch}: {error}")
            })
    }

    pub(crate) fn set_active_for_account(
        &self,
        storage: &AccountStorage,
        handle: &str,
    ) -> Result<(), String> {
        storage.verify()?;
        let account_scope = storage.storage_key();
        if !self.contains_for_account(storage, handle)? {
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
                "INSERT INTO sandbox_active (account_scope, handle, updated_at) \
                 VALUES (?1, ?2, ?3) ON CONFLICT(account_scope) DO UPDATE SET \
                 handle = excluded.handle, updated_at = excluded.updated_at",
                params![account_scope, handle, now],
            )
            .map_err(|error| format!("failed to persist active sandbox: {error}"))?;
        transaction
            .execute(
                "UPDATE sandboxes SET last_seen_at = ?3, updated_at = ?3 \
                 WHERE account_scope = ?1 AND handle = ?2",
                params![account_scope, handle, now],
            )
            .map_err(|error| format!("failed to touch active sandbox: {error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("failed to commit active sandbox: {error}"))?;
        self.secure_database_files()
    }

    pub(crate) fn active_handle_for_account(
        &self,
        storage: &AccountStorage,
    ) -> Result<Option<String>, String> {
        storage.verify()?;
        self.connection()
            .query_row(
                "SELECT handle FROM sandbox_active WHERE account_scope = ?1",
                [storage.storage_key()],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| format!("failed to read active sandbox: {error}"))
    }

    pub(crate) fn mark_state_for_account(
        &self,
        storage: &AccountStorage,
        handle: &str,
        desired_status: &str,
        observed_status: &str,
        error: Option<&str>,
    ) -> Result<(), String> {
        storage.verify()?;
        let changed = self
            .connection()
            .execute(
                "UPDATE sandboxes SET desired_status = ?3, observed_status = ?4, \
                 error = ?5, updated_at = ?6, last_seen_at = ?6 \
                 WHERE account_scope = ?1 AND handle = ?2",
                params![
                    storage.storage_key(),
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

    pub(crate) fn mark_observed_for_account(
        &self,
        storage: &AccountStorage,
        handle: &str,
        observed_status: &str,
        error: Option<&str>,
        resume_step: Option<&str>,
    ) -> Result<(), String> {
        storage.verify()?;
        let changed = self
            .connection()
            .execute(
                "UPDATE sandboxes SET observed_status = ?3, error = ?4, \
                 resume_step = COALESCE(?5, resume_step), updated_at = ?6, \
                 last_seen_at = ?6 WHERE account_scope = ?1 AND handle = ?2",
                params![
                    storage.storage_key(),
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

    /// Forget one account's sandbox row. Agent claims and the account's active
    /// pointer are removed by the schema's scoped `ON DELETE CASCADE` foreign
    /// keys. Unknown handles are an idempotent success.
    pub(crate) fn remove_for_account(
        &self,
        storage: &AccountStorage,
        handle: &str,
    ) -> Result<(), String> {
        storage.verify()?;
        let mut connection = self.connection();
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("failed to begin sandbox removal: {error}"))?;
        transaction
            .execute(
                "DELETE FROM sandboxes WHERE account_scope = ?1 AND handle = ?2",
                params![storage.storage_key(), handle],
            )
            .map_err(|error| format!("failed to remove sandbox {handle}: {error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("failed to commit sandbox removal: {error}"))?;
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
        for file in crate::fs_util::sqlite_file_family(path) {
            set_private_permissions(&file)?;
        }
        Ok(())
    }
}

fn open_persistent_registry(path: &Path) -> Result<Connection, String> {
    // Permission and filesystem failures happen before SQLite sees the file.
    // They are operational errors, not evidence that user data is corrupt.
    prepare_private_database_file(path)?;

    open_configured_connection(Some(path))
        .map_err(|error| format!("failed to open native sandbox registry: {error}"))
}

fn open_configured_connection(path: Option<&Path>) -> Result<Connection, RegistryOpenError> {
    let mut connection = match path {
        Some(path) => Connection::open(path),
        None => Connection::open_in_memory(),
    }
    .map_err(|error| RegistryOpenError::sqlite("failed to open database", error))?;

    connection
        .busy_timeout(crate::SQLITE_BUSY_TIMEOUT)
        .map_err(|error| RegistryOpenError::sqlite("failed to configure busy timeout", error))?;

    // `PRAGMA user_version` is deliberately never read or written here: the
    // shared `studio.db` uses it for the THREADS migration ladder, and a
    // registry that inspected it would reject its own database the moment the
    // threads side stamped a version. The registry's own version gate lives in
    // `ensure_schema`, on a `sandbox_metadata` row.
    if path.is_some() {
        connection
            .pragma_update(None, "journal_mode", "WAL")
            .map_err(|error| RegistryOpenError::sqlite("failed to enable WAL", error))?;
    }
    connection
        .pragma_update(None, "foreign_keys", "ON")
        .map_err(|error| RegistryOpenError::sqlite("failed to enable foreign keys", error))?;

    ensure_schema(&mut connection)?;

    let quick_check: String = connection
        .query_row("PRAGMA quick_check(1)", [], |row| row.get(0))
        .map_err(|error| RegistryOpenError::sqlite("failed to check database integrity", error))?;
    if !quick_check.eq_ignore_ascii_case("ok") {
        return Err(RegistryOpenError::Corrupt(quick_check));
    }

    Ok(connection)
}

fn ensure_schema(connection: &mut Connection) -> Result<(), RegistryOpenError> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| RegistryOpenError::sqlite("failed to begin schema setup", error))?;

    // The metadata table first: it carries the version row the gate below
    // reads, so it must exist before the gate can run.
    transaction
        .execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS sandbox_metadata (
                key TEXT PRIMARY KEY NOT NULL,
                value TEXT NOT NULL
            );
            "#,
        )
        .map_err(|error| RegistryOpenError::sqlite("failed to create metadata table", error))?;

    // Absence is fresh only when no sandbox tables exist. An unversioned
    // existing registry has no trustworthy account owner and must never be
    // silently adopted into the authenticated account that happened to boot
    // first.
    let stored_raw: Option<String> = transaction
        .query_row(
            "SELECT value FROM sandbox_metadata WHERE key = ?1",
            [SCHEMA_VERSION_KEY],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| RegistryOpenError::sqlite("failed to read schema version", error))?;
    let stored = stored_raw
        .as_deref()
        .map(|value| {
            value.parse::<i64>().map_err(|_| {
                RegistryOpenError::Corrupt(format!(
                    "sandbox registry schema version is not an integer: {value:?}"
                ))
            })
        })
        .transpose()?;
    match stored {
        Some(version) if version > CURRENT_SCHEMA_VERSION => {
            return Err(RegistryOpenError::FutureVersion(version));
        }
        Some(version) if version < 4 => {
            return Err(RegistryOpenError::UnsupportedVersion(version));
        }
        _ => {}
    }

    if stored.is_none() && has_unversioned_registry_tables(&transaction)? {
        return Err(RegistryOpenError::UnsupportedVersion(0));
    }

    if stored == Some(4) {
        quarantine_v4_registry(&transaction)?;
    }

    transaction
        .execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS sandboxes (
                account_scope TEXT NOT NULL,
                handle TEXT NOT NULL,
                clone_url TEXT NOT NULL,
                branch TEXT NOT NULL,
                config_json TEXT NOT NULL,
                desired_status TEXT NOT NULL,
                observed_status TEXT NOT NULL,
                resume_step TEXT NOT NULL DEFAULT 'clone',
                error TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                last_seen_at INTEGER NOT NULL,
                PRIMARY KEY (account_scope, handle)
            ) WITHOUT ROWID;
            CREATE TABLE IF NOT EXISTS sandbox_agents (
                account_scope TEXT NOT NULL,
                handle TEXT NOT NULL,
                virtual_mcp_id TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                PRIMARY KEY (account_scope, handle, virtual_mcp_id),
                FOREIGN KEY (account_scope, handle)
                    REFERENCES sandboxes(account_scope, handle) ON DELETE CASCADE
            ) WITHOUT ROWID;
            CREATE INDEX IF NOT EXISTS sandbox_agents_by_agent
                ON sandbox_agents(account_scope, virtual_mcp_id);
            CREATE TABLE IF NOT EXISTS sandbox_active (
                account_scope TEXT PRIMARY KEY NOT NULL,
                handle TEXT NOT NULL,
                updated_at INTEGER NOT NULL,
                FOREIGN KEY (account_scope, handle)
                    REFERENCES sandboxes(account_scope, handle) ON DELETE CASCADE
            ) WITHOUT ROWID;
            "#,
        )
        .map_err(|error| RegistryOpenError::sqlite("failed to create schema", error))?;

    validate_schema(&transaction)?;
    transaction
        .execute(
            "INSERT INTO sandbox_metadata (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![SCHEMA_VERSION_KEY, CURRENT_SCHEMA_VERSION.to_string()],
        )
        .map_err(|error| RegistryOpenError::sqlite("failed to record schema version", error))?;
    transaction
        .commit()
        .map_err(|error| RegistryOpenError::sqlite("failed to commit schema setup", error))
}

fn validate_schema(connection: &Connection) -> Result<(), RegistryOpenError> {
    connection
        .prepare(
            r#"
            SELECT account_scope, handle, clone_url, branch, config_json,
                   desired_status, observed_status, resume_step, error,
                   created_at, updated_at, last_seen_at
            FROM sandboxes LIMIT 0
            "#,
        )
        .map_err(|error| RegistryOpenError::sqlite("sandbox table does not match v5", error))?;
    connection
        .prepare("SELECT key, value FROM sandbox_metadata LIMIT 0")
        .map_err(|error| RegistryOpenError::sqlite("metadata table does not match v5", error))?;
    connection
        .prepare(
            "SELECT account_scope, handle, virtual_mcp_id, created_at \
             FROM sandbox_agents LIMIT 0",
        )
        .map_err(|error| RegistryOpenError::sqlite("agent table does not match v5", error))?;
    connection
        .prepare("SELECT account_scope, handle, updated_at FROM sandbox_active LIMIT 0")
        .map_err(|error| RegistryOpenError::sqlite("active table does not match v5", error))?;
    validate_primary_key(connection, "sandboxes", &["account_scope", "handle"])?;
    validate_primary_key(
        connection,
        "sandbox_agents",
        &["account_scope", "handle", "virtual_mcp_id"],
    )?;
    validate_primary_key(connection, "sandbox_active", &["account_scope"])?;
    validate_without_rowid(connection, "sandboxes")?;
    validate_without_rowid(connection, "sandbox_agents")?;
    validate_without_rowid(connection, "sandbox_active")?;
    validate_scoped_foreign_key(connection, "sandbox_agents")?;
    validate_scoped_foreign_key(connection, "sandbox_active")?;
    validate_agent_index(connection)?;
    Ok(())
}

fn validate_primary_key(
    connection: &Connection,
    table: &str,
    expected: &[&str],
) -> Result<(), RegistryOpenError> {
    let mut statement = connection
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|error| RegistryOpenError::sqlite("failed to inspect v5 primary key", error))?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(1)?, row.get::<_, i64>(5)?))
        })
        .map_err(|error| RegistryOpenError::sqlite("failed to read v5 primary key", error))?;
    let mut actual = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| RegistryOpenError::sqlite("failed to collect v5 primary key", error))?
        .into_iter()
        .filter(|(_, position)| *position > 0)
        .collect::<Vec<_>>();
    actual.sort_by_key(|(_, position)| *position);
    let actual = actual
        .into_iter()
        .map(|(column, _)| column)
        .collect::<Vec<_>>();
    if actual != expected {
        return Err(RegistryOpenError::Corrupt(format!(
            "{table} primary key does not match v5: {actual:?}"
        )));
    }
    Ok(())
}

fn validate_without_rowid(connection: &Connection, table: &str) -> Result<(), RegistryOpenError> {
    let without_rowid: i64 = connection
        .query_row(&format!("PRAGMA table_list({table})"), [], |row| row.get(4))
        .map_err(|error| RegistryOpenError::sqlite("failed to inspect v5 table SQL", error))?;
    if without_rowid != 1 {
        return Err(RegistryOpenError::Corrupt(format!(
            "{table} is not a v5 WITHOUT ROWID table"
        )));
    }
    Ok(())
}

fn validate_scoped_foreign_key(
    connection: &Connection,
    table: &str,
) -> Result<(), RegistryOpenError> {
    let mut statement = connection
        .prepare(&format!("PRAGMA foreign_key_list({table})"))
        .map_err(|error| RegistryOpenError::sqlite("failed to inspect v5 foreign keys", error))?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(6)?,
            ))
        })
        .map_err(|error| RegistryOpenError::sqlite("failed to read v5 foreign keys", error))?;
    let actual = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| RegistryOpenError::sqlite("failed to collect v5 foreign keys", error))?;
    let valid = matches!(actual.as_slice(), [
        (first_id, 0, first_target, first_from, first_to, first_delete),
        (second_id, 1, second_target, second_from, second_to, second_delete),
    ] if first_id == second_id
        && first_target == "sandboxes"
        && second_target == "sandboxes"
        && first_from == "account_scope"
        && first_to == "account_scope"
        && second_from == "handle"
        && second_to == "handle"
        && first_delete.eq_ignore_ascii_case("CASCADE")
        && second_delete.eq_ignore_ascii_case("CASCADE"));
    if !valid {
        return Err(RegistryOpenError::Corrupt(format!(
            "{table} foreign key does not match v5: {actual:?}"
        )));
    }
    let mut check = connection
        .prepare(&format!("PRAGMA foreign_key_check({table})"))
        .map_err(|error| RegistryOpenError::sqlite("failed to check v5 foreign keys", error))?;
    if check
        .exists([])
        .map_err(|error| RegistryOpenError::sqlite("failed to read v5 foreign-key check", error))?
    {
        return Err(RegistryOpenError::Corrupt(format!(
            "{table} contains rows that violate its v5 foreign key"
        )));
    }
    Ok(())
}

fn validate_agent_index(connection: &Connection) -> Result<(), RegistryOpenError> {
    let mut index_list = connection
        .prepare("PRAGMA index_list(sandbox_agents)")
        .map_err(|error| RegistryOpenError::sqlite("failed to inspect v5 index list", error))?;
    let entries = index_list
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)?,
            ))
        })
        .map_err(|error| RegistryOpenError::sqlite("failed to read v5 index list", error))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| RegistryOpenError::sqlite("failed to collect v5 index list", error))?;
    if !entries.iter().any(|(name, unique, origin, partial)| {
        name == "sandbox_agents_by_agent" && *unique == 0 && origin == "c" && *partial == 0
    }) {
        return Err(RegistryOpenError::Corrupt(format!(
            "sandbox agent index metadata does not match v5: {entries:?}"
        )));
    }
    let mut statement = connection
        .prepare("PRAGMA index_info(sandbox_agents_by_agent)")
        .map_err(|error| RegistryOpenError::sqlite("failed to inspect v5 agent index", error))?;
    let actual = statement
        .query_map([], |row| row.get::<_, String>(2))
        .map_err(|error| RegistryOpenError::sqlite("failed to read v5 agent index", error))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| RegistryOpenError::sqlite("failed to collect v5 agent index", error))?;
    if actual != ["account_scope", "virtual_mcp_id"] {
        return Err(RegistryOpenError::Corrupt(format!(
            "sandbox agent index does not match v5: {actual:?}"
        )));
    }
    Ok(())
}

fn has_unversioned_registry_tables(connection: &Connection) -> Result<bool, RegistryOpenError> {
    connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name IN (\
                'sandboxes', 'sandbox_agents', 'sandbox_active',\
                'sandboxes_unowned_v4', 'sandbox_agents_unowned_v4',\
                'sandbox_unowned_metadata_v4'\
            ))",
            [],
            |row| row.get(0),
        )
        .map_err(|error| RegistryOpenError::sqlite("failed to inspect unversioned schema", error))
}

fn validate_v4_schema(connection: &Connection) -> Result<(), RegistryOpenError> {
    connection
        .prepare(
            "SELECT handle, virtual_mcp_id, clone_url, branch, config_json, \
             sandbox_path, workdir_path, desired_status, observed_status, \
             resume_step, error, created_at, updated_at, last_seen_at \
             FROM sandboxes LIMIT 0",
        )
        .map_err(|error| RegistryOpenError::sqlite("sandbox table does not match v4", error))?;
    connection
        .prepare("SELECT handle, virtual_mcp_id, created_at FROM sandbox_agents LIMIT 0")
        .map_err(|error| RegistryOpenError::sqlite("agent table does not match v4", error))?;
    Ok(())
}

/// v4 rows carried no account owner. Preserve them for manual recovery, but
/// create an empty v5 namespace instead of assigning them to the first user
/// who signs in after upgrading.
fn quarantine_v4_registry(connection: &Connection) -> Result<(), RegistryOpenError> {
    validate_v4_schema(connection)?;
    connection
        .execute_batch(
            r#"
            DROP INDEX IF EXISTS sandbox_agents_by_agent;
            CREATE TABLE sandbox_unowned_metadata_v4 (
                key TEXT PRIMARY KEY NOT NULL,
                value TEXT NOT NULL
            );
            INSERT INTO sandbox_unowned_metadata_v4 (key, value)
                SELECT key, value FROM sandbox_metadata WHERE key = 'active_handle';
            DELETE FROM sandbox_metadata WHERE key = 'active_handle';
            ALTER TABLE sandbox_agents RENAME TO sandbox_agents_unowned_v4;
            ALTER TABLE sandboxes RENAME TO sandboxes_unowned_v4;
            "#,
        )
        .map_err(|error| RegistryOpenError::sqlite("failed to quarantine v4 registry", error))
}

fn prepare_private_database_file(path: &Path) -> Result<(), String> {
    crate::fs_util::create_owner_only(path)
        .map_err(|error| format!("failed to create private sandbox registry {path:?}: {error}"))
}

/// Registry policy over [`crate::fs_util::set_owner_only`]: a companion file
/// that vanished between inspection and clamp is fine (quarantine only moves
/// what exists), so absence is success rather than an error.
fn set_private_permissions(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    crate::fs_util::set_owner_only(path)
        .map_err(|error| format!("failed to make sandbox registry file private {path:?}: {error}"))
}

fn normalized_branch(config: &GitSandboxConfig) -> &str {
    super::normalize_branch(config.branch.as_deref())
}

/// Validates the on-disk shape Git itself uses for a checkout without running
/// a blocking subprocess during async application startup. A normal clone has
/// a `.git` directory; a linked worktree has a small `.git` file pointing at
/// the canonical repository's `.git/worktrees/<name>` administrative dir.
#[cfg(test)]
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
    let Some(expected) =
        SandboxManager::compute_handle(&config.clone_url, normalized_branch(config))
    else {
        return Err(format!(
            "repo.cloneUrl cannot be scoped to a worktree path: {}",
            config.clone_url
        ));
    };
    let legacy =
        SandboxManager::legacy_compute_handle(&config.clone_url, normalized_branch(config));
    let hashed =
        SandboxManager::hashed_compute_handle(&config.clone_url, normalized_branch(config));
    if handle != expected && legacy.as_deref() != Some(handle) && hashed.as_deref() != Some(handle)
    {
        return Err(format!(
            "sandbox handle/config mismatch: expected {expected}, got {handle}"
        ));
    }
    Ok(())
}

fn now_unix_seconds() -> i64 {
    crate::time_util::now_unix_secs()
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

    fn account_storage(root: &Path, key: &str) -> AccountStorage {
        AccountStorage::open(root, key).unwrap()
    }

    /// A handle is `<repo scope>/<branch>` and names no agent, so two agents
    /// on one repo+branch share the sandbox. The second must not evict the
    /// first from its own handle lookup — that is what one `virtual_mcp_id`
    /// column on a handle-keyed table used to do.
    #[test]
    fn two_agents_on_one_repo_and_branch_share_a_sandbox() {
        let root = tempfile::tempdir().unwrap();
        let first = config();
        let branch = first.branch.clone().unwrap();
        let handle =
            SandboxManager::compute_handle(&first.clone_url, &branch).expect("scopeable clone url");
        let storage = account_storage(root.path(), "v1:test-account-a");
        let workdir_path = storage.workdir(&handle).unwrap();
        create_git_checkout(&workdir_path);

        let registry = SandboxRegistry::open(root.path().to_path_buf()).unwrap();
        registry
            .upsert_config_for_account(&storage, &handle, &first)
            .unwrap();

        let second = GitSandboxConfig {
            virtual_mcp_id: "vmcp-second-agent".to_string(),
            ..first.clone()
        };
        registry
            .upsert_config_for_account(&storage, &handle, &second)
            .unwrap();

        // Same repo + branch => one sandbox, reachable by BOTH agents.
        assert_eq!(
            registry
                .handle_for_virtual_mcp_for_account(&storage, &first.virtual_mcp_id, &branch,)
                .unwrap()
                .as_deref(),
            Some(handle.as_str())
        );
        assert_eq!(
            registry
                .handle_for_virtual_mcp_for_account(&storage, &second.virtual_mcp_id, &branch,)
                .unwrap()
                .as_deref(),
            Some(handle.as_str())
        );
        let sandbox_rows: i64 = registry
            .connection()
            .query_row(
                "SELECT COUNT(*) FROM sandboxes WHERE account_scope = ?1",
                [storage.storage_key()],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(sandbox_rows, 1, "two agents must not fork two sandboxes");
    }

    #[test]
    fn registry_is_wal_and_survives_reopen() {
        let root = tempfile::tempdir().unwrap();
        let cfg = config();
        let handle = SandboxManager::compute_handle(&cfg.clone_url, cfg.branch.as_deref().unwrap())
            .expect("scopeable clone url");
        let storage = account_storage(root.path(), "v1:test-account-a");
        let workdir_path = storage.workdir(&handle).unwrap();
        create_git_checkout(&workdir_path);

        let registry = SandboxRegistry::open(root.path().to_path_buf()).unwrap();
        registry
            .upsert_config_for_account(&storage, &handle, &cfg)
            .unwrap();
        registry.set_active_for_account(&storage, &handle).unwrap();
        registry
            .mark_state_for_account(&storage, &handle, "running", "running", None)
            .unwrap();
        drop(registry);

        let reopened = SandboxRegistry::open(root.path().to_path_buf()).unwrap();
        let record = reopened
            .record_for_account(&storage, &handle)
            .unwrap()
            .unwrap();
        assert_eq!(record.config, cfg);
        assert_eq!(record.desired_status, "running");
        assert_eq!(record.observed_status, "running");
        assert_eq!(
            reopened
                .active_handle_for_account(&storage)
                .unwrap()
                .as_deref(),
            Some(handle.as_str())
        );

        let connection = Connection::open(root.path().join(crate::STUDIO_DB_FILE_NAME)).unwrap();
        let journal_mode: String = connection
            .pragma_query_value(None, "journal_mode", |row| row.get(0))
            .unwrap();
        assert_eq!(journal_mode.to_ascii_lowercase(), "wal");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(root.path().join(crate::STUDIO_DB_FILE_NAME))
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o600);
        }
    }

    #[test]
    fn refuses_to_activate_an_unknown_handle() {
        let root = tempfile::tempdir().unwrap();
        let registry = SandboxRegistry::open(root.path().to_path_buf()).unwrap();
        let storage = account_storage(root.path(), "v1:test-account-a");
        assert_eq!(
            registry
                .set_active_for_account(&storage, "phantom")
                .unwrap_err(),
            "unknown sandbox handle: phantom"
        );
    }

    #[test]
    fn registry_reopen_never_inspects_unverified_global_worktree_paths() {
        let root = tempfile::tempdir().unwrap();
        let cfg = config();
        let handle = SandboxManager::compute_handle(&cfg.clone_url, cfg.branch.as_deref().unwrap())
            .expect("scopeable clone url");
        let storage = account_storage(root.path(), "v1:test-account-a");
        let sandbox_path = storage.worktree_root(&handle).unwrap();
        let workdir_path = storage.workdir(&handle).unwrap();
        create_git_checkout(&workdir_path);
        let registry = SandboxRegistry::open(root.path().to_path_buf()).unwrap();
        registry
            .upsert_config_for_account(&storage, &handle, &cfg)
            .unwrap();
        registry.set_active_for_account(&storage, &handle).unwrap();
        drop(registry);
        std::fs::remove_dir_all(&sandbox_path).unwrap();

        let reopened = SandboxRegistry::open(root.path().to_path_buf()).unwrap();
        assert_eq!(
            reopened
                .active_handle_for_account(&storage)
                .unwrap()
                .as_deref(),
            Some(handle.as_str())
        );
        assert_eq!(
            reopened
                .record_for_account(&storage, &handle)
                .unwrap()
                .unwrap()
                .observed_status,
            "provisioning"
        );
    }

    #[test]
    fn same_handle_is_isolated_by_account_for_rows_active_and_paths() {
        let root = tempfile::tempdir().unwrap();
        let storage_a = account_storage(root.path(), "v1:test-account-a");
        let storage_b = account_storage(root.path(), "v1:test-account-b");
        let first = config();
        let branch = first.branch.as_deref().unwrap();
        let handle = SandboxManager::compute_handle(&first.clone_url, branch).unwrap();
        let second = GitSandboxConfig {
            virtual_mcp_id: "vmcp-account-b".to_string(),
            ..first.clone()
        };
        let registry = SandboxRegistry::open(root.path().to_path_buf()).unwrap();

        registry
            .upsert_config_for_account(&storage_a, &handle, &first)
            .unwrap();
        registry
            .upsert_config_for_account(&storage_b, &handle, &second)
            .unwrap();
        registry
            .set_active_for_account(&storage_a, &handle)
            .unwrap();
        registry
            .set_active_for_account(&storage_b, &handle)
            .unwrap();

        let record_a = registry
            .record_for_account(&storage_a, &handle)
            .unwrap()
            .unwrap();
        let record_b = registry
            .record_for_account(&storage_b, &handle)
            .unwrap()
            .unwrap();
        assert_eq!(record_a.config.virtual_mcp_id, first.virtual_mcp_id);
        assert_eq!(record_b.config.virtual_mcp_id, second.virtual_mcp_id);
        assert_ne!(record_a.sandbox_path, record_b.sandbox_path);
        assert_eq!(
            record_a.sandbox_path,
            storage_a.worktree_root(&handle).unwrap()
        );
        assert_eq!(
            record_b.sandbox_path,
            storage_b.worktree_root(&handle).unwrap()
        );
        assert_eq!(
            registry
                .active_handle_for_account(&storage_a)
                .unwrap()
                .as_deref(),
            Some(handle.as_str())
        );
        assert_eq!(
            registry
                .active_handle_for_account(&storage_b)
                .unwrap()
                .as_deref(),
            Some(handle.as_str())
        );
    }

    #[test]
    fn failed_agent_association_rolls_back_the_sandbox_row() {
        let root = tempfile::tempdir().unwrap();
        let storage = account_storage(root.path(), "v1:test-account-a");
        let cfg = config();
        let handle =
            SandboxManager::compute_handle(&cfg.clone_url, cfg.branch.as_deref().unwrap()).unwrap();
        let registry = SandboxRegistry::open(root.path().to_path_buf()).unwrap();
        registry
            .connection()
            .execute_batch(
                "CREATE TRIGGER fail_sandbox_agent BEFORE INSERT ON sandbox_agents \
                 BEGIN SELECT RAISE(ABORT, 'agent insert failed'); END;",
            )
            .unwrap();

        let error = registry
            .upsert_config_for_account(&storage, &handle, &cfg)
            .unwrap_err();
        assert!(error.contains("agent insert failed"), "{error}");
        assert!(!registry.contains_for_account(&storage, &handle).unwrap());
    }

    #[test]
    fn scoped_foreign_keys_cascade_agent_and_active_rows() {
        let root = tempfile::tempdir().unwrap();
        let storage = account_storage(root.path(), "v1:test-account-a");
        let cfg = config();
        let handle =
            SandboxManager::compute_handle(&cfg.clone_url, cfg.branch.as_deref().unwrap()).unwrap();
        let registry = SandboxRegistry::open(root.path().to_path_buf()).unwrap();
        registry
            .upsert_config_for_account(&storage, &handle, &cfg)
            .unwrap();
        registry.set_active_for_account(&storage, &handle).unwrap();
        registry
            .connection()
            .execute(
                "DELETE FROM sandboxes WHERE account_scope = ?1 AND handle = ?2",
                params![storage.storage_key(), handle],
            )
            .unwrap();

        let connection = registry.connection();
        let agents: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sandbox_agents WHERE account_scope = ?1",
                [storage.storage_key()],
                |row| row.get(0),
            )
            .unwrap();
        let active: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sandbox_active WHERE account_scope = ?1",
                [storage.storage_key()],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!((agents, active), (0, 0));
    }

    #[test]
    fn malformed_database_handle_is_rejected_before_path_derivation() {
        let root = tempfile::tempdir().unwrap();
        let storage = account_storage(root.path(), "v1:test-account-a");
        let cfg = config();
        let registry = SandboxRegistry::open(root.path().to_path_buf()).unwrap();
        registry
            .connection()
            .execute(
                "INSERT INTO sandboxes (
                    account_scope, handle, clone_url, branch, config_json,
                    desired_status, observed_status, resume_step,
                    created_at, updated_at, last_seen_at
                 ) VALUES (?1, '../../outside', ?2, ?3, ?4,
                           'running', 'stopped', 'clone', 1, 1, 1)",
                params![
                    storage.storage_key(),
                    cfg.clone_url,
                    normalized_branch(&cfg),
                    serde_json::to_string(&cfg).unwrap(),
                ],
            )
            .unwrap();

        let error = registry
            .record_for_account(&storage, "../../outside")
            .unwrap_err();
        assert!(error.contains("not path-safe"), "{error}");
        assert!(!storage.root().join("outside").exists());
    }

    #[test]
    fn v4_rows_are_explicitly_quarantined_and_not_adopted() {
        let root = tempfile::tempdir().unwrap();
        let database_path = root.path().join(crate::STUDIO_DB_FILE_NAME);
        let cfg = config();
        let handle =
            SandboxManager::compute_handle(&cfg.clone_url, cfg.branch.as_deref().unwrap()).unwrap();
        let legacy_sandbox = root
            .path()
            .join(crate::sandbox::WORKTREES_DIR)
            .join(&handle);
        let legacy_workdir = legacy_sandbox.join("repo");
        create_git_checkout(&legacy_workdir);

        let connection = Connection::open(&database_path).unwrap();
        connection
            .execute_batch(
                r#"
                PRAGMA foreign_keys = ON;
                CREATE TABLE sandbox_metadata (
                    key TEXT PRIMARY KEY NOT NULL,
                    value TEXT NOT NULL
                );
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
                    resume_step TEXT NOT NULL DEFAULT 'clone',
                    error TEXT,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    last_seen_at INTEGER NOT NULL
                );
                CREATE TABLE sandbox_agents (
                    handle TEXT NOT NULL REFERENCES sandboxes(handle) ON DELETE CASCADE,
                    virtual_mcp_id TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    PRIMARY KEY (handle, virtual_mcp_id)
                );
                CREATE INDEX sandbox_agents_by_agent ON sandbox_agents(virtual_mcp_id);
                "#,
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO sandbox_metadata(key, value) VALUES (?1, '4')",
                [SCHEMA_VERSION_KEY],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO sandbox_metadata(key, value) VALUES ('active_handle', ?1)",
                [&handle],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO sandboxes (
                    handle, virtual_mcp_id, clone_url, branch, config_json,
                    sandbox_path, workdir_path, desired_status, observed_status,
                    resume_step, error, created_at, updated_at, last_seen_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'running', 'running',
                           'start', NULL, 1, 1, 1)",
                params![
                    handle,
                    cfg.virtual_mcp_id,
                    cfg.clone_url,
                    normalized_branch(&cfg),
                    serde_json::to_string(&cfg).unwrap(),
                    legacy_sandbox.to_string_lossy(),
                    legacy_workdir.to_string_lossy(),
                ],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO sandbox_agents(handle, virtual_mcp_id, created_at) \
                 VALUES (?1, ?2, 1)",
                params![handle, cfg.virtual_mcp_id],
            )
            .unwrap();
        drop(connection);

        let registry = SandboxRegistry::open(root.path().to_path_buf()).unwrap();
        let storage = account_storage(root.path(), "v1:test-account-a");
        assert!(registry
            .record_for_account(&storage, &handle)
            .unwrap()
            .is_none());
        let connection = registry.connection();
        let count = |table: &str| -> i64 {
            connection
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                    row.get(0)
                })
                .unwrap()
        };
        assert_eq!(count("sandboxes"), 0);
        assert_eq!(count("sandbox_agents"), 0);
        assert_eq!(count("sandbox_active"), 0);
        assert_eq!(count("sandboxes_unowned_v4"), 1);
        assert_eq!(count("sandbox_agents_unowned_v4"), 1);
        let legacy_active: String = connection
            .query_row(
                "SELECT value FROM sandbox_unowned_metadata_v4 WHERE key = 'active_handle'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(legacy_active, handle);
        assert!(legacy_sandbox.exists(), "quarantine preserves legacy files");
    }

    #[test]
    fn unversioned_existing_registry_tables_fail_closed() {
        let root = tempfile::tempdir().unwrap();
        let database_path = root.path().join(crate::STUDIO_DB_FILE_NAME);
        Connection::open(&database_path)
            .unwrap()
            .execute("CREATE TABLE sandboxes (handle TEXT PRIMARY KEY)", [])
            .unwrap();

        let error = SandboxRegistry::open(root.path().to_path_buf())
            .err()
            .expect("unversioned registry must not be adopted");
        assert!(error.contains("unsupported sandbox registry schema version 0"));
        let connection = Connection::open(database_path).unwrap();
        let columns: Vec<String> = connection
            .prepare("PRAGMA table_info(sandboxes)")
            .unwrap()
            .query_map([], |row| row.get(1))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(columns, ["handle"]);
    }

    #[test]
    fn stamped_v5_with_split_scope_and_handle_foreign_keys_fails_closed() {
        let root = tempfile::tempdir().unwrap();
        let database_path = root.path().join(crate::STUDIO_DB_FILE_NAME);
        drop(SandboxRegistry::open(root.path().to_path_buf()).unwrap());
        let connection = Connection::open(&database_path).unwrap();
        connection
            .execute_batch(
                r#"
                DROP INDEX sandbox_agents_by_agent;
                DROP TABLE sandbox_agents;
                CREATE TABLE sandbox_agents (
                    account_scope TEXT NOT NULL,
                    handle TEXT NOT NULL,
                    virtual_mcp_id TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    PRIMARY KEY (account_scope, handle, virtual_mcp_id),
                    FOREIGN KEY (account_scope)
                        REFERENCES sandboxes(account_scope) ON DELETE CASCADE,
                    FOREIGN KEY (handle)
                        REFERENCES sandboxes(handle) ON DELETE CASCADE
                ) WITHOUT ROWID;
                CREATE INDEX sandbox_agents_by_agent
                    ON sandbox_agents(account_scope, virtual_mcp_id);
                "#,
            )
            .unwrap();
        drop(connection);

        let error = SandboxRegistry::open(root.path().to_path_buf())
            .err()
            .expect("split foreign keys must not satisfy the v5 account boundary");
        assert!(error.contains("foreign key does not match v5"), "{error}");
        assert!(database_path.exists());
    }

    /// Reclaim drops only the named account's row, agent claims, and active
    /// pointer even when a second account owns the same durable handle.
    #[test]
    fn remove_drops_only_one_accounts_row_agents_and_active_pointer() {
        let root = tempfile::tempdir().unwrap();
        let storage_a = account_storage(root.path(), "v1:test-account-a");
        let storage_b = account_storage(root.path(), "v1:test-account-b");
        let cfg_a = config();
        let cfg_b = GitSandboxConfig {
            virtual_mcp_id: "vmcp-account-b".to_string(),
            ..cfg_a.clone()
        };
        let handle =
            SandboxManager::compute_handle(&cfg_a.clone_url, cfg_a.branch.as_deref().unwrap())
                .expect("scopeable clone url");
        let registry = SandboxRegistry::open(root.path().to_path_buf()).unwrap();
        for (storage, cfg) in [(&storage_a, &cfg_a), (&storage_b, &cfg_b)] {
            let workdir = storage.workdir(&handle).unwrap();
            create_git_checkout(&workdir);
            registry
                .upsert_config_for_account(storage, &handle, cfg)
                .unwrap();
            registry.set_active_for_account(storage, &handle).unwrap();
        }

        registry.remove_for_account(&storage_a, &handle).unwrap();

        assert!(!registry.contains_for_account(&storage_a, &handle).unwrap());
        assert!(registry
            .record_for_account(&storage_a, &handle)
            .unwrap()
            .is_none());
        assert!(registry
            .active_handle_for_account(&storage_a)
            .unwrap()
            .is_none());
        assert!(registry
            .handle_for_virtual_mcp_for_account(
                &storage_a,
                &cfg_a.virtual_mcp_id,
                cfg_a.branch.as_deref().unwrap(),
            )
            .unwrap()
            .is_none());

        assert!(registry.contains_for_account(&storage_b, &handle).unwrap());
        assert_eq!(
            registry
                .active_handle_for_account(&storage_b)
                .unwrap()
                .as_deref(),
            Some(handle.as_str())
        );
        assert_eq!(
            registry
                .handle_for_virtual_mcp_for_account(
                    &storage_b,
                    &cfg_b.virtual_mcp_id,
                    cfg_b.branch.as_deref().unwrap(),
                )
                .unwrap()
                .as_deref(),
            Some(handle.as_str())
        );
        let agent_rows_a: i64 = registry
            .connection()
            .query_row(
                "SELECT COUNT(*) FROM sandbox_agents WHERE account_scope = ?1",
                [storage_a.storage_key()],
                |row| row.get(0),
            )
            .unwrap();
        let agent_rows_b: i64 = registry
            .connection()
            .query_row(
                "SELECT COUNT(*) FROM sandbox_agents WHERE account_scope = ?1",
                [storage_b.storage_key()],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!((agent_rows_a, agent_rows_b), (0, 1));
    }

    /// Removing one sandbox must not disturb another's active pointer.
    #[test]
    fn remove_leaves_a_different_sandboxs_active_pointer_alone() {
        let root = tempfile::tempdir().unwrap();
        let kept = config();
        let mut removed = config();
        removed.branch = Some("feature/other".to_string());

        let storage = account_storage(root.path(), "v1:test-account-a");
        let registry = SandboxRegistry::open(root.path().to_path_buf()).unwrap();
        let mut handles = Vec::new();
        for cfg in [&kept, &removed] {
            let handle =
                SandboxManager::compute_handle(&cfg.clone_url, cfg.branch.as_deref().unwrap())
                    .expect("scopeable clone url");
            create_git_checkout(&storage.workdir(&handle).unwrap());
            registry
                .upsert_config_for_account(&storage, &handle, cfg)
                .unwrap();
            handles.push(handle);
        }
        registry
            .set_active_for_account(&storage, &handles[0])
            .unwrap();

        registry.remove_for_account(&storage, &handles[1]).unwrap();

        assert_eq!(
            registry
                .active_handle_for_account(&storage)
                .unwrap()
                .as_deref(),
            Some(handles[0].as_str())
        );
        assert!(registry
            .contains_for_account(&storage, &handles[0])
            .unwrap());
    }

    /// The idempotent contract the delete intercept promises: asking for a
    /// handle that was never registered to be gone succeeds, because it is.
    #[test]
    fn removing_an_unknown_handle_is_a_no_op_success() {
        let root = tempfile::tempdir().unwrap();
        let registry = SandboxRegistry::open(root.path().to_path_buf()).unwrap();
        let storage = account_storage(root.path(), "v1:test-account-a");
        registry.remove_for_account(&storage, "phantom").unwrap();
        assert!(!registry.contains_for_account(&storage, "phantom").unwrap());
    }

    #[test]
    fn rejects_future_schema_without_quarantining_or_mutating_it() {
        let root = tempfile::tempdir().unwrap();
        let database_path = root.path().join(crate::STUDIO_DB_FILE_NAME);
        // A first open stamps the schema; then push the version row one past
        // current, so bumping the schema never silently turns this into an
        // assertion about a version we now support.
        drop(SandboxRegistry::open(root.path().to_path_buf()).unwrap());
        let future = (CURRENT_SCHEMA_VERSION + 1).to_string();
        let connection = Connection::open(&database_path).unwrap();
        connection
            .execute(
                "UPDATE sandbox_metadata SET value = ?1 WHERE key = ?2",
                params![future, SCHEMA_VERSION_KEY],
            )
            .unwrap();
        drop(connection);

        let error = SandboxRegistry::open(root.path().to_path_buf())
            .err()
            .expect("future schema must fail closed");
        assert!(error.contains("newer than supported"), "{error}");

        // Fail closed means CLOSED: the version row is untouched and the file
        // was not quarantined out from under the newer build that owns it.
        let connection = Connection::open(&database_path).unwrap();
        let stored: String = connection
            .query_row(
                "SELECT value FROM sandbox_metadata WHERE key = ?1",
                [SCHEMA_VERSION_KEY],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(stored, future);
        let has_quarantine = std::fs::read_dir(root.path()).unwrap().any(|entry| {
            entry
                .ok()
                .and_then(|entry| entry.file_name().into_string().ok())
                .is_some_and(|name| name.contains(".corrupt-"))
        });
        assert!(!has_quarantine);
    }

    #[test]
    fn malformed_registry_fails_closed_without_moving_shared_thread_data() {
        let root = tempfile::tempdir().unwrap();
        let database_path = root.path().join(crate::STUDIO_DB_FILE_NAME);
        let connection = Connection::open(&database_path).unwrap();
        connection
            .execute_batch(
                r#"
                PRAGMA user_version = 73;
                CREATE TABLE thread_sentinel (id TEXT PRIMARY KEY, body TEXT NOT NULL);
                INSERT INTO thread_sentinel VALUES ('thread-a', 'must survive');
                CREATE TABLE sandbox_metadata (
                    key TEXT PRIMARY KEY NOT NULL,
                    value TEXT NOT NULL
                );
                CREATE TABLE sandboxes (handle TEXT PRIMARY KEY NOT NULL);
                "#,
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO sandbox_metadata(key, value) VALUES (?1, ?2)",
                params![SCHEMA_VERSION_KEY, CURRENT_SCHEMA_VERSION.to_string()],
            )
            .unwrap();
        drop(connection);

        let error = SandboxRegistry::open(root.path().to_path_buf())
            .err()
            .expect("malformed stamped schema must fail closed");
        assert!(error.contains("does not match v5"), "{error}");

        let connection = Connection::open(&database_path).unwrap();
        let sentinel: String = connection
            .query_row(
                "SELECT body FROM thread_sentinel WHERE id = 'thread-a'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(sentinel, "must survive");
        let user_version: i64 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(user_version, 73);
        assert!(database_path.exists());
        assert!(!std::fs::read_dir(root.path()).unwrap().any(|entry| {
            entry
                .ok()
                .and_then(|entry| entry.file_name().into_string().ok())
                .is_some_and(|name| name.contains(".corrupt-"))
        }));
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
