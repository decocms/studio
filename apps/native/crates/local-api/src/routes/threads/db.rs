//! SQLite storage layer for `/threads*` — no daemon precedent, full shape
//! pinned in the native local-API contract.
//! Kept separate from `routes/threads.rs` (the HTTP layer) so the CRUD/
//! query logic is unit-testable against an in-memory SQLite connection
//! without spinning up axum.
//!
//! One `Mutex<rusqlite::Connection>` per process (see `ensure_db` in the
//! parent module). This remains one local app process even though the durable
//! rows isolate multiple signed-in account scopes, so a serialized connection
//! is simpler than a pool and avoids SQLITE_BUSY entirely (all writers already
//! funnel through one `Mutex`). WAL mode is still enabled so a future reader
//! (e.g. a CLI inspecting the db file while local-api is running) doesn't block
//! on it.

use std::fs::{self, OpenOptions};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use uuid::Uuid;

/// Native owns this schema independently from Studio's Postgres migrations.
/// The two stores intentionally share wire entities, not physical tables.
const CURRENT_SCHEMA_VERSION: u32 = 10;
const SQLITE_BUSY_TIMEOUT: Duration = Duration::from_secs(5);

/// IDs in this namespace are owned exclusively by the native durable-turn
/// protocol. User-supplied message IDs are rejected before acceptance so an
/// unrelated message can never occupy a future assistant completion fence.
pub const NATIVE_ASSISTANT_MESSAGE_ID_PREFIX: &str = "native-assistant:";
const NATIVE_ASSISTANT_MESSAGE_ID_V1_PREFIX: &str = "native-assistant:v1:";

struct Migration {
    version: u32,
    sql: &'static str,
}

const MIGRATIONS: &[Migration] = &[
    Migration {
        version: 1,
        // This is the complete schema that shipped before migrations existed.
        // `IF NOT EXISTS` lets a `user_version=0` installation adopt it without
        // replacing or deleting any existing rows.
        sql: r#"
CREATE TABLE IF NOT EXISTS threads (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    parts TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    harness_id TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    ended_at TEXT,
    error TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_thread_created ON messages(thread_id, created_at);
CREATE INDEX IF NOT EXISTS idx_runs_thread_created ON runs(thread_id, created_at);

-- `rt_*` ("real-UI threads") — a SEPARATE table pair from `threads`/
-- `messages`/`runs` above. Those tables back the mini-app's now-dead
-- `/threads*` HTTP surface AND the daemon-parity `/_sandbox/dispatch`
-- family (`routes/dispatch.rs`) — byte-parity-gated, never touched by this
-- change. `rt_threads`/`rt_messages` back `routes/intercept/*`'s emulation
-- of the REAL production shell's wire contract instead: `ThreadEntity`
-- (`packages/shared/src/thread/schema.ts::ThreadEntitySchema`) and
-- `ThreadMessageEntity`, per the native interception contract
-- §3.1. Same db file, same connection/lock, independent tables — keeps the
-- daemon-parity-critical old schema completely unmodified while the new
-- interception layer gets the richer shape the real UI's tools expect.
CREATE TABLE IF NOT EXISTS rt_threads (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    hidden INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    created_by TEXT NOT NULL,
    updated_by TEXT NOT NULL,
    virtual_mcp_id TEXT NOT NULL,
    trigger_id TEXT,
    branch TEXT,
    sandbox_provider_kind TEXT,
    harness_id TEXT,
    metadata TEXT,
    run_config TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS rt_messages (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES rt_threads(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    parts TEXT NOT NULL,
    metadata TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rt_threads_org_updated ON rt_threads(organization_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_rt_messages_thread_created ON rt_messages(thread_id, created_at);
"#,
    },
    Migration {
        version: 2,
        // SQLite cannot add a genuinely NOT NULL column to a populated table
        // without a synthetic default. Rebuilding inside the migration
        // transaction gives every legacy row its real per-thread insertion
        // ordinal while preserving ids and payloads byte-for-byte.
        sql: r#"
DROP INDEX IF EXISTS idx_rt_messages_thread_created;
ALTER TABLE rt_messages RENAME TO rt_messages_v1;
CREATE TABLE rt_messages (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES rt_threads(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    parts TEXT NOT NULL,
    metadata TEXT,
    seq INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
INSERT INTO rt_messages (
    id, thread_id, role, parts, metadata, seq, created_at, updated_at
)
SELECT
    id,
    thread_id,
    role,
    parts,
    metadata,
    ROW_NUMBER() OVER (PARTITION BY thread_id ORDER BY rowid),
    created_at,
    updated_at
FROM rt_messages_v1;
DROP TABLE rt_messages_v1;
CREATE INDEX idx_rt_messages_thread_created ON rt_messages(thread_id, created_at);
CREATE UNIQUE INDEX idx_rt_messages_thread_seq ON rt_messages(thread_id, seq);
"#,
    },
    Migration {
        version: 3,
        // A queue row carries the generation of the thread incarnation that
        // accepted it. Deleting a thread cascades its pending work, and every
        // old worker write is fenced from the moment deletion starts. Schema
        // v5 additionally retires the deleted public id permanently.
        //
        // `ALTER TABLE ... ADD COLUMN` requires a constant default for an
        // existing table. Every legacy row is assigned a random generation in
        // this transaction, and all application inserts explicitly supply a
        // fresh UUID; the empty default is only an SQLite migration bridge.
        sql: r#"
ALTER TABLE rt_threads ADD COLUMN generation TEXT NOT NULL DEFAULT '';
UPDATE rt_threads
SET generation = lower(hex(randomblob(16)))
WHERE generation = '';
CREATE UNIQUE INDEX idx_rt_threads_org_id_generation
ON rt_threads(organization_id, id, generation);
CREATE TRIGGER rt_threads_generation_required_insert
BEFORE INSERT ON rt_threads
WHEN NEW.generation = ''
BEGIN
    SELECT RAISE(ABORT, 'rt_threads.generation is required');
END;
CREATE TRIGGER rt_threads_generation_immutable
BEFORE UPDATE OF generation ON rt_threads
WHEN NEW.generation <> OLD.generation
BEGIN
    SELECT RAISE(ABORT, 'rt_threads.generation is immutable');
END;

CREATE TABLE rt_turn_queue (
    organization_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    thread_generation TEXT NOT NULL,
    message_id TEXT NOT NULL CHECK (message_id <> ''),
    workflow_id TEXT NOT NULL CHECK (workflow_id <> ''),
    task_id TEXT NOT NULL CHECK (task_id <> ''),
    normalized_input_json TEXT NOT NULL,
    user_message_json TEXT NOT NULL,
    enqueued_at INTEGER NOT NULL CHECK (enqueued_at >= 0),
    fifo_ordinal INTEGER NOT NULL CHECK (fifo_ordinal > 0),
    state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'cancel_requested')),
    claim_token TEXT,
    CHECK (
        (state = 'queued' AND claim_token IS NULL) OR
        (state IN ('running', 'cancel_requested') AND claim_token IS NOT NULL)
    ),
    PRIMARY KEY (organization_id, thread_id, thread_generation, workflow_id),
    UNIQUE (organization_id, thread_id, thread_generation, message_id),
    UNIQUE (organization_id, thread_id, thread_generation, fifo_ordinal),
    FOREIGN KEY (organization_id, thread_id, thread_generation)
        REFERENCES rt_threads(organization_id, id, generation)
        ON DELETE CASCADE
);
CREATE INDEX idx_rt_turn_queue_fifo
ON rt_turn_queue(organization_id, thread_id, thread_generation, fifo_ordinal);
CREATE INDEX idx_rt_turn_queue_recovery
ON rt_turn_queue(state, organization_id, thread_id, thread_generation, fifo_ordinal);
"#,
    },
    Migration {
        version: 4,
        // Local threads used to be scoped only by the organization slug. The
        // same slug can exist on dev/staging/prod and a different user can sign
        // into the same macOS account, so that boundary was insufficient.
        // Empty is retained only for pre-v4 rows until a matching authenticated
        // user claims them through `adopt_legacy_account_rows`.
        sql: r#"
ALTER TABLE rt_threads ADD COLUMN account_scope TEXT NOT NULL DEFAULT '';
ALTER TABLE rt_turn_queue ADD COLUMN account_scope TEXT NOT NULL DEFAULT '';
CREATE INDEX idx_rt_threads_account_org_updated
ON rt_threads(account_scope, organization_id, updated_at);
CREATE INDEX idx_rt_turn_queue_account_recovery
ON rt_turn_queue(account_scope, state, organization_id, thread_id, thread_generation, fifo_ordinal);
CREATE TRIGGER rt_threads_account_scope_required_insert
BEFORE INSERT ON rt_threads
WHEN NEW.account_scope = ''
BEGIN
    SELECT RAISE(ABORT, 'rt_threads.account_scope is required');
END;
CREATE TRIGGER rt_turn_queue_account_scope_required_insert
BEFORE INSERT ON rt_turn_queue
WHEN NEW.account_scope = ''
BEGIN
    SELECT RAISE(ABORT, 'rt_turn_queue.account_scope is required');
END;
"#,
    },
    Migration {
        version: 5,
        // A deleted public thread id is retired permanently inside the account
        // + organization that owned it. Without this durable ABA guard, a
        // request created before DELETE but delivered afterwards is
        // indistinguishable from a legitimate request for a newly-created
        // thread with the same public id. The tombstone intentionally carries
        // no transcript or user content and has no foreign key: it must outlive
        // the thread row it protects.
        sql: r#"
CREATE TABLE rt_thread_tombstones (
    account_scope TEXT NOT NULL CHECK (account_scope <> ''),
    organization_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    deleted_generation TEXT NOT NULL CHECK (deleted_generation <> ''),
    deleted_at TEXT NOT NULL,
    PRIMARY KEY (account_scope, organization_id, thread_id)
);
"#,
    },
    Migration {
        version: 6,
        // The first native thread store shipped without a migration runner or
        // an account boundary. Such a binary cannot understand `user_version`
        // and would otherwise reopen this database with organization-only
        // queries after a downgrade, exposing another upstream/user's rows.
        // Move every current real-UI table behind names that binary has never
        // seen, then leave empty old-shaped barrier tables under the legacy
        // names. The old binary reads zero rows and its first attempted insert
        // fails loudly instead of creating data that the current app ignores.
        //
        // SQLite 3.26+ rewrites child foreign-key targets on a parent-table
        // rename. This workspace bundles SQLite 3.45 through rusqlite; the
        // migration tests additionally pin the rewritten FK targets and run
        // `foreign_key_check` before the version transaction commits.
        sql: r#"
ALTER TABLE rt_threads RENAME TO native_scoped_threads;
ALTER TABLE rt_messages RENAME TO native_scoped_messages;
ALTER TABLE rt_turn_queue RENAME TO native_scoped_turn_queue;
ALTER TABLE rt_thread_tombstones RENAME TO native_scoped_thread_tombstones;

CREATE INDEX idx_native_scoped_threads_org_updated
ON native_scoped_threads(organization_id, updated_at);
CREATE INDEX idx_native_scoped_messages_thread_created
ON native_scoped_messages(thread_id, created_at);
CREATE UNIQUE INDEX idx_native_scoped_messages_thread_seq
ON native_scoped_messages(thread_id, seq);
CREATE UNIQUE INDEX idx_native_scoped_threads_org_id_generation
ON native_scoped_threads(organization_id, id, generation);
CREATE INDEX idx_native_scoped_turn_queue_fifo
ON native_scoped_turn_queue(organization_id, thread_id, thread_generation, fifo_ordinal);
CREATE INDEX idx_native_scoped_turn_queue_recovery
ON native_scoped_turn_queue(state, organization_id, thread_id, thread_generation, fifo_ordinal);
CREATE INDEX idx_native_scoped_threads_account_org_updated
ON native_scoped_threads(account_scope, organization_id, updated_at);
CREATE INDEX idx_native_scoped_turn_queue_account_recovery
ON native_scoped_turn_queue(
    account_scope, state, organization_id, thread_id, thread_generation, fifo_ordinal
);

CREATE TRIGGER native_scoped_threads_generation_required_insert
BEFORE INSERT ON native_scoped_threads
WHEN NEW.generation = ''
BEGIN
    SELECT RAISE(ABORT, 'native_scoped_threads.generation is required');
END;
CREATE TRIGGER native_scoped_threads_generation_immutable
BEFORE UPDATE OF generation ON native_scoped_threads
WHEN NEW.generation <> OLD.generation
BEGIN
    SELECT RAISE(ABORT, 'native_scoped_threads.generation is immutable');
END;
CREATE TRIGGER native_scoped_threads_account_scope_required_insert
BEFORE INSERT ON native_scoped_threads
WHEN NEW.account_scope = ''
BEGIN
    SELECT RAISE(ABORT, 'native_scoped_threads.account_scope is required');
END;
CREATE TRIGGER native_scoped_turn_queue_account_scope_required_insert
BEFORE INSERT ON native_scoped_turn_queue
WHEN NEW.account_scope = ''
BEGIN
    SELECT RAISE(ABORT, 'native_scoped_turn_queue.account_scope is required');
END;

-- Historical v3 builds shipped the tables and indexes but not the generation
-- triggers present in today's reconstructed migration SQL. Teardown must
-- tolerate every object that was optional across shipped versions; the new
-- native-scoped indexes/triggers above are the post-migration source of truth.
DROP TRIGGER IF EXISTS rt_threads_generation_required_insert;
DROP TRIGGER IF EXISTS rt_threads_generation_immutable;
DROP TRIGGER IF EXISTS rt_threads_account_scope_required_insert;
DROP TRIGGER IF EXISTS rt_turn_queue_account_scope_required_insert;
DROP INDEX IF EXISTS idx_rt_threads_org_updated;
DROP INDEX IF EXISTS idx_rt_messages_thread_created;
DROP INDEX IF EXISTS idx_rt_messages_thread_seq;
DROP INDEX IF EXISTS idx_rt_threads_org_id_generation;
DROP INDEX IF EXISTS idx_rt_turn_queue_fifo;
DROP INDEX IF EXISTS idx_rt_turn_queue_recovery;
DROP INDEX IF EXISTS idx_rt_threads_account_org_updated;
DROP INDEX IF EXISTS idx_rt_turn_queue_account_recovery;

-- Exact pre-runner shapes. Keeping these as tables (rather than views) lets
-- the old `CREATE TABLE/INDEX IF NOT EXISTS` batch finish normally, while the
-- triggers below make every possible row mutation fail closed.
CREATE TABLE rt_threads (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    hidden INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    created_by TEXT NOT NULL,
    updated_by TEXT NOT NULL,
    virtual_mcp_id TEXT NOT NULL,
    trigger_id TEXT,
    branch TEXT,
    sandbox_provider_kind TEXT,
    harness_id TEXT,
    metadata TEXT,
    run_config TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE rt_messages (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES rt_threads(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    parts TEXT NOT NULL,
    metadata TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX idx_rt_threads_org_updated ON rt_threads(organization_id, updated_at);
CREATE INDEX idx_rt_messages_thread_created ON rt_messages(thread_id, created_at);

CREATE TRIGGER rt_threads_downgrade_block_insert
BEFORE INSERT ON rt_threads
BEGIN
    SELECT RAISE(ABORT, 'native thread database requires a newer app version');
END;
CREATE TRIGGER rt_threads_downgrade_block_update
BEFORE UPDATE ON rt_threads
BEGIN
    SELECT RAISE(ABORT, 'native thread database requires a newer app version');
END;
CREATE TRIGGER rt_threads_downgrade_block_delete
BEFORE DELETE ON rt_threads
BEGIN
    SELECT RAISE(ABORT, 'native thread database requires a newer app version');
END;
CREATE TRIGGER rt_messages_downgrade_block_insert
BEFORE INSERT ON rt_messages
BEGIN
    SELECT RAISE(ABORT, 'native thread database requires a newer app version');
END;
CREATE TRIGGER rt_messages_downgrade_block_update
BEFORE UPDATE ON rt_messages
BEGIN
    SELECT RAISE(ABORT, 'native thread database requires a newer app version');
END;
CREATE TRIGGER rt_messages_downgrade_block_delete
BEFORE DELETE ON rt_messages
BEGIN
    SELECT RAISE(ABORT, 'native thread database requires a newer app version');
END;
"#,
    },
    Migration {
        version: 7,
        // `updated_by` has always been physically NOT NULL because the first
        // native schema copied `created_by` into it on INSERT. Production's
        // public entity, however, omits `updated_by` until an explicit
        // COLLECTION_THREADS_UPDATE occurs. Keep the historical value in
        // place (other native code may still use it internally) and track only
        // whether it is public with an additive flag. This avoids rebuilding
        // the v6 physical tables and leaves every downgrade barrier untouched.
        sql: r#"
ALTER TABLE native_scoped_threads
ADD COLUMN updated_by_explicit INTEGER NOT NULL DEFAULT 0
CHECK (updated_by_explicit IN (0, 1));

-- A differing historical actor proves an explicit update occurred. Equal
-- actors are inherently ambiguous (the creator may also have updated it), so
-- legacy rows conservatively retain the create-only wire shape.
UPDATE native_scoped_threads
SET updated_by_explicit = 1
WHERE updated_by <> created_by;
"#,
    },
    Migration {
        version: 8,
        // Deletion is a durable lifecycle, not merely a process-local latch:
        // after a timeout or final-DELETE failure, queued work remains intact
        // but may not be claimed until the caller retries the delete. Queue
        // rows also reserve the deterministic assistant id before HTTP 202.
        // Pre-v8 rows are backfilled with their exact legacy assistant id;
        // nullable storage remains only as a defensive corruption/recovery
        // boundary for databases produced by transitional builds.
        sql: r#"
ALTER TABLE native_scoped_threads
ADD COLUMN delete_pending INTEGER NOT NULL DEFAULT 0
CHECK (delete_pending IN (0, 1));

ALTER TABLE native_scoped_turn_queue
ADD COLUMN assistant_message_id TEXT;

-- Preserve the exact completion identity of every accepted pre-v8 row. A
-- global unique index is deliberately not added: older schemas permitted the
-- same client message id in different scopes, and refusing to open such a
-- database would strand both queues. Claim-time arbitration lets the oldest
-- reservation finish and quarantines every loser before harness execution.
UPDATE native_scoped_turn_queue
SET assistant_message_id = 'msg-' || message_id || '-assistant';

-- Legacy ids may collide and are arbitrated at claim. The namespace did not
-- exist before v8, so new reservations can additionally be protected against
-- future alternate writers at the SQLite layer without bricking old queues.
CREATE UNIQUE INDEX idx_native_scoped_turn_queue_v1_assistant_message_id
ON native_scoped_turn_queue(assistant_message_id)
WHERE assistant_message_id LIKE 'native-assistant:v1:%';
"#,
    },
    Migration {
        version: 9,
        // Claim-time validation must survive a process crash. In particular,
        // an accepted pre-v8 row can lose global message-id arbitration even
        // when its JSON is otherwise valid. Persisting the quarantine reason
        // makes recovery close that row without ever returning it to a harness
        // or manufacturing an assistant-only transcript.
        sql: r#"
ALTER TABLE native_scoped_turn_queue
ADD COLUMN quarantine_reason TEXT;

ALTER TABLE native_scoped_turn_queue
ADD COLUMN quarantine_preserve_user INTEGER NOT NULL DEFAULT 0
CHECK (quarantine_preserve_user IN (0, 1));
"#,
    },
    Migration {
        version: 10,
        // A CLI can reveal its durable conversation id long before its turn
        // completes. Keep that identity on the already-claimed queue row so a
        // process crash can retire the interrupted turn without discarding the
        // only pointer to the CLI-owned history. The row's existing account,
        // organization, thread-generation, workflow, and claim-token identity
        // is the write fence; terminal finalization deletes the checkpoint
        // together with the queue row after copying it into the assistant.
        sql: r#"
ALTER TABLE native_scoped_turn_queue
ADD COLUMN checkpoint_harness_id TEXT
CHECK (checkpoint_harness_id IS NULL OR trim(checkpoint_harness_id) <> '');

ALTER TABLE native_scoped_turn_queue
ADD COLUMN checkpoint_session_id TEXT
CHECK (checkpoint_session_id IS NULL OR trim(checkpoint_session_id) <> '');

CREATE TRIGGER native_scoped_turn_queue_checkpoint_pair_insert
BEFORE INSERT ON native_scoped_turn_queue
WHEN (NEW.checkpoint_harness_id IS NULL) <> (NEW.checkpoint_session_id IS NULL)
BEGIN
    SELECT RAISE(ABORT, 'native_scoped_turn_queue checkpoint must be a complete pair');
END;

CREATE TRIGGER native_scoped_turn_queue_checkpoint_pair_update
BEFORE UPDATE OF checkpoint_harness_id, checkpoint_session_id
ON native_scoped_turn_queue
WHEN (NEW.checkpoint_harness_id IS NULL) <> (NEW.checkpoint_session_id IS NULL)
BEGIN
    SELECT RAISE(ABORT, 'native_scoped_turn_queue checkpoint must be a complete pair');
END;
"#,
    },
];

#[derive(Debug)]
pub enum DbError {
    Sqlite(rusqlite::Error),
    Json(serde_json::Error),
    Io(std::io::Error),
    NewerSchemaVersion {
        found: u32,
        supported: u32,
    },
    SchemaIntegrity(String),
    IdempotencyConflict {
        entity: &'static str,
        id: String,
    },
    RetiredThreadId {
        account_scope: String,
        organization_id: String,
        thread_id: String,
    },
    StaleThreadGeneration {
        organization_id: String,
        thread_id: String,
        generation: String,
    },
    ThreadDeletePending {
        organization_id: String,
        thread_id: String,
    },
    InvalidQueueData(String),
}

impl std::fmt::Display for DbError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DbError::Sqlite(e) => write!(f, "sqlite error: {e}"),
            DbError::Json(e) => write!(f, "json error: {e}"),
            DbError::Io(e) => write!(f, "io error: {e}"),
            DbError::NewerSchemaVersion { found, supported } => write!(
                f,
                "local thread database schema version {found} is newer than this app supports ({supported}); update the app before opening it"
            ),
            DbError::SchemaIntegrity(message) => {
                write!(f, "local thread database schema integrity error: {message}")
            }
            DbError::IdempotencyConflict { entity, id } => write!(
                f,
                "idempotency conflict: {entity} id {id} already exists with different content"
            ),
            DbError::RetiredThreadId {
                account_scope,
                organization_id,
                thread_id,
            } => write!(
                f,
                "thread id is retired in account scope {account_scope}: {organization_id}/{thread_id}"
            ),
            DbError::StaleThreadGeneration {
                organization_id,
                thread_id,
                generation,
            } => write!(
                f,
                "thread generation fence no longer matches: {organization_id}/{thread_id}@{generation}"
            ),
            DbError::ThreadDeletePending {
                organization_id,
                thread_id,
            } => write!(
                f,
                "thread deletion is pending: {organization_id}/{thread_id}"
            ),
            DbError::InvalidQueueData(message) => {
                write!(f, "invalid durable turn queue data: {message}")
            }
        }
    }
}

impl std::error::Error for DbError {}

impl From<rusqlite::Error> for DbError {
    fn from(e: rusqlite::Error) -> Self {
        DbError::Sqlite(e)
    }
}

impl From<serde_json::Error> for DbError {
    fn from(e: serde_json::Error) -> Self {
        DbError::Json(e)
    }
}

impl From<std::io::Error> for DbError {
    fn from(e: std::io::Error) -> Self {
        DbError::Io(e)
    }
}

pub type DbResult<T> = Result<T, DbError>;

#[derive(Debug, Clone, Serialize)]
pub struct Thread {
    pub id: String,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Message {
    pub id: String,
    pub thread_id: String,
    pub role: String,
    pub parts: Value,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Run {
    pub id: String,
    pub thread_id: String,
    pub harness_id: String,
    pub status: String,
    pub created_at: String,
    pub ended_at: Option<String>,
    pub error: Option<String>,
}

// --- native_scoped_threads / native_scoped_messages — the REAL production shell's wire shape ----
//
// See migration 1's schema comment for why these are a separate table
// pair from `Thread`/`Message`/`Run` above. Field names/shapes mirror
// `packages/shared/src/thread/schema.ts::ThreadEntitySchema` /
// `ThreadMessageEntitySchema` closely enough that `routes/intercept/
// thread_tools.rs` can serialize a `RtThread`/`RtMessage` directly as the
// tool's raw (un-enveloped) JSON output — see
// the native interception contract §3.1.

fn thread_metadata_is_absent(metadata: &Option<Value>) -> bool {
    match metadata {
        None => true,
        Some(Value::Object(object)) => object.is_empty(),
        Some(_) => false,
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct RtThread {
    pub id: String,
    pub organization_id: String,
    pub title: String,
    pub description: Option<String>,
    pub hidden: bool,
    pub status: String,
    pub created_by: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_by: Option<String>,
    pub virtual_mcp_id: String,
    pub trigger_id: Option<String>,
    pub branch: Option<String>,
    pub sandbox_provider_kind: Option<String>,
    pub harness_id: Option<String>,
    #[serde(skip_serializing_if = "thread_metadata_is_absent")]
    pub metadata: Option<Value>,
    pub run_config: Option<Value>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RtMessage {
    pub id: String,
    pub thread_id: String,
    pub role: String,
    pub parts: Value,
    pub metadata: Option<Value>,
    /// Durable, per-thread insert ordinal. A user turn's row is always
    /// assigned a lower `seq` than the assistant reply inserted after it.
    /// Surfaced on `COLLECTION_THREAD_MESSAGES_LIST` items so the chat
    /// frontend can order by this stable SERVER ordinal instead of the
    /// wall-clock `created_at` — which mixes the CLIENT clock (optimistic /
    /// streamed rows) with the SERVER clock. Unlike SQLite's implicit
    /// `rowid`, this survives table rebuilds and future storage migrations.
    /// See `mergeAndSort` in
    /// `apps/web/src/components/chat/store/thread-connection.ts`.
    pub seq: i64,
    pub created_at: String,
    pub updated_at: String,
}

/// Fields a caller may patch via `COLLECTION_THREADS_CREATE`'s `data` /
/// `COLLECTION_THREADS_UPDATE`'s `data` — every field optional so ONE
/// struct serves both "set on create" and "patch on update" (an absent
/// field on update leaves the column untouched; `Option<Option<T>>` fields
/// distinguish "not present in the patch" from "explicitly set to null").
#[derive(Debug, Clone, Default)]
pub struct RtThreadPatch {
    pub title: Option<String>,
    pub description: Option<Option<String>>,
    pub hidden: Option<bool>,
    pub status: Option<String>,
    pub metadata: Option<Option<Value>>,
    pub branch: Option<Option<String>>,
    pub virtual_mcp_id: Option<String>,
}

/// Durable native account boundary. An organization slug is meaningful only
/// inside one upstream issuer and one authenticated subject; neither component
/// is exposed on the production-compatible thread wire entity.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct RtAccountScope {
    pub upstream_host: String,
    pub user_id: String,
}

impl RtAccountScope {
    pub fn new(upstream_host: impl Into<String>, user_id: impl Into<String>) -> Option<Self> {
        let upstream_host = upstream_host.into().trim().to_ascii_lowercase();
        let user_id = user_id.into();
        if upstream_host.is_empty() || user_id.is_empty() {
            return None;
        }
        Some(Self {
            upstream_host,
            user_id,
        })
    }

    /// Length-prefixing keeps the persisted key unambiguous even when a host or
    /// subject contains punctuation. This is an internal SQLite key, not wire
    /// data and not a credential.
    pub fn storage_key(&self) -> String {
        format!(
            "v1:{}:{}{}",
            self.upstream_host.len(),
            self.upstream_host,
            self.user_id
        )
    }

    #[cfg(test)]
    fn test_default() -> Self {
        Self::new("test.invalid", "local-desktop-user").unwrap()
    }
}

/// Filters and pagination for a scoped native thread listing. Keeping these in
/// one typed value prevents the storage API from growing another positional
/// argument every time the production collection adds a filter.
#[derive(Debug, Clone, Copy)]
pub struct RtThreadListOptions<'a> {
    pub created_by: Option<&'a str>,
    pub hidden: Option<bool>,
    pub search: Option<&'a str>,
    pub trigger_ids: Option<&'a [String]>,
    pub virtual_mcp_id: Option<&'a str>,
    pub has_trigger: Option<bool>,
    pub start_date: Option<&'a str>,
    pub end_date: Option<&'a str>,
    pub status: Option<&'a str>,
    pub agent_id: Option<&'a str>,
    pub limit: i64,
    pub offset: i64,
}

/// Durable identity for one live incarnation of a local thread. `generation`
/// makes every worker write prove it still targets the incarnation that
/// originally accepted the turn. Once deleted, the public id is permanently
/// retired in its account + organization scope by schema-v5 tombstones.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize)]
pub struct RtThreadFence {
    pub account_scope: String,
    pub organization_id: String,
    pub thread_id: String,
    pub generation: String,
}

pub fn is_native_assistant_message_id(id: &str) -> bool {
    id.starts_with(NATIVE_ASSISTANT_MESSAGE_ID_PREFIX)
}

/// Deterministic completion fence for one accepted native turn. Every scope
/// component is length-prefixed, so punctuation or embedded delimiters cannot
/// make two tuples collide. Including the thread generation prevents a stale
/// worker from sharing an assistant id with a later incarnation even if a
/// future storage policy ever permits public thread-id reuse.
pub fn native_assistant_message_id(fence: &RtThreadFence, user_message_id: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(b"decocms-native-assistant-message-id\0v1\0");
    for component in [
        fence.account_scope.as_str(),
        fence.organization_id.as_str(),
        fence.thread_id.as_str(),
        fence.generation.as_str(),
        user_message_id,
    ] {
        digest.update((component.len() as u64).to_be_bytes());
        digest.update(component.as_bytes());
    }
    let digest = digest.finalize();
    let mut id = String::with_capacity(NATIVE_ASSISTANT_MESSAGE_ID_V1_PREFIX.len() + 64);
    id.push_str(NATIVE_ASSISTANT_MESSAGE_ID_V1_PREFIX);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(id, "{byte:02x}");
    }
    id
}

pub fn legacy_native_assistant_message_id(user_message_id: &str) -> String {
    format!("msg-{user_message_id}-assistant")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RtTurnQueueState {
    Queued,
    Running,
    CancelRequested,
}

impl RtTurnQueueState {
    fn parse(value: &str) -> DbResult<Self> {
        match value {
            "queued" => Ok(Self::Queued),
            "running" => Ok(Self::Running),
            "cancel_requested" => Ok(Self::CancelRequested),
            other => Err(DbError::InvalidQueueData(format!(
                "unknown state {other:?}"
            ))),
        }
    }
}

/// Full durable form of one native decopilot turn. The input and user message
/// are retained as JSON so process restart recovery does not reconstruct a
/// lossy approximation of the original dispatch.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RtTurnQueueItem {
    pub fence: RtThreadFence,
    pub message_id: String,
    /// Reserved before acceptance for v8+ rows. `None` identifies a legacy
    /// row whose completion must retain the historical derived assistant id.
    pub assistant_message_id: Option<String>,
    pub workflow_id: String,
    pub task_id: String,
    /// Sanitized execution fields only (harness/tier/mode/approval, branch,
    /// sandbox provider/config); never request headers or auth data. The full
    /// current user message is retained separately below.
    pub normalized_input: Value,
    pub user_message: Value,
    pub enqueued_at: u64,
    pub fifo_ordinal: i64,
    pub state: RtTurnQueueState,
    /// Unique ownership token minted on each claim. A worker from an earlier
    /// recovery pass cannot complete a row claimed again by another worker.
    pub claim_token: Option<String>,
    /// Crash-durable pointer to the CLI-owned conversation observed by this
    /// exact claim. It is intentionally never exposed by the queue HTTP
    /// diagnostics: a session id is an internal continuation capability.
    #[serde(skip_serializing)]
    pub checkpoint_session: Option<(String, String)>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RtTurnEnqueueInput {
    pub message_id: String,
    pub workflow_id: String,
    pub task_id: String,
    pub normalized_input: Value,
    pub user_message: Value,
    pub enqueued_at: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub enum RtTurnEnqueueOutcome {
    Inserted(RtTurnQueueItem),
    Existing(RtTurnQueueItem),
    /// The canonical user and its deterministic assistant already form a
    /// complete persisted turn. HTTP retries return the original `202`
    /// contract without creating another queue row or launching a harness.
    Completed,
}

#[derive(Debug, Clone, PartialEq)]
pub enum RtTurnCancelOutcome {
    QueuedDeleted(RtTurnQueueItem),
    ActiveCancelRequested(RtTurnQueueItem),
    NotFound,
}

/// The only thread states a claimed turn may commit when it relinquishes its
/// queue slot. `RequiresAction` is a durable pause; the other two end the
/// interaction. Keeping this typed prevents an accepted queue row from being
/// deleted while the parent thread is accidentally left `in_progress`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RtTurnTerminalStatus {
    Completed,
    RequiresAction,
    Failed,
}

impl RtTurnTerminalStatus {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Completed => "completed",
            Self::RequiresAction => "requires_action",
            Self::Failed => "failed",
        }
    }
}

/// Result of the atomic terminal commit. `Stale` means the queue row is no
/// longer an active claim owned by the supplied generation + claim token; no
/// assistant/status/queue mutation was committed in that case.
#[derive(Debug, Clone, PartialEq)]
pub enum RtTurnTerminalOutcome {
    Completed(RtMessage),
    /// A corrupt/legacy-colliding accepted row was closed without inserting a
    /// misleading assistant message under an identity owned by another turn.
    Quarantined,
    Stale,
}

type RtMalformedTerminalRow = (
    String,
    String,
    Option<String>,
    bool,
    Option<String>,
    Option<String>,
);
type RtClaimedTerminalRow = (
    String,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
);

/// Result of atomically persisting a claimed turn's queued user message and
/// transitioning its thread to `in_progress`.
#[derive(Debug, Clone, PartialEq)]
pub enum RtTurnBeginOutcome {
    Begun(RtMessage),
    CancelRequested,
    Stale,
}

/// Recovery view that preserves the claim identity of a row whose JSON body
/// cannot be decoded. Returning it beside healthy rows lets startup finalize
/// this one turn explicitly instead of failing the entire queue scan.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RtMalformedOrphanedTurn {
    pub fence: RtThreadFence,
    pub message_id: String,
    pub assistant_message_id: Option<String>,
    pub workflow_id: String,
    pub claim_token: Option<String>,
    /// A validated canonical accepted user that is safe to terminalize. This
    /// is present only when the malformed field is unrelated to the user
    /// payload and global user/assistant reservations remain unambiguous.
    pub canonical_user: Option<Value>,
    pub error: String,
}

#[derive(Debug, Clone, PartialEq)]
pub enum RtOrphanedTurn {
    Ready(RtTurnQueueItem),
    Malformed(RtMalformedOrphanedTurn),
}

/// Claim parses only after the row has been durably moved out of `queued`.
/// Malformed input is therefore a terminalizable head, never a poison pill
/// that rolls back into FIFO position and blocks every healthy tail.
#[derive(Debug, Clone, PartialEq)]
pub enum RtTurnClaimOutcome {
    Ready(RtTurnQueueItem),
    Malformed(RtMalformedOrphanedTurn),
    /// A crash left both canonical messages durable but not the queued-row
    /// cleanup. Claim atomically adopts that completed boundary and removes
    /// the row without ever returning executable work to the harness layer.
    Completed {
        workflow_id: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RtCancelAllTurnsOutcome {
    pub queued_retained_workflow_ids: Vec<String>,
    pub active_workflow_ids: Vec<String>,
}

/// Milliseconds-precision RFC3339 UTC timestamp (`2024-01-02T03:04:05.006Z`).
/// Hand-rolled (no `chrono`/`time` crate in the workspace's dependency
/// table — see `apps/native/Cargo.toml`, which is a shared file family
/// implementers don't edit) via the standard civil-from-days algorithm
/// (Howard Hinnant's `civil_from_days`, the same one libc++'s `<chrono>`
/// uses). Millisecond precision (rather than seconds) keeps same-tick
/// creates orderable in `list_threads`'s `ORDER BY updated_at DESC` without
/// a secondary sort key doing all the work.
pub(crate) fn now_rfc3339() -> String {
    format_rfc3339(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or(Duration::ZERO),
    )
}

pub(crate) fn format_rfc3339(d: Duration) -> String {
    let secs = d.as_secs() as i64;
    let millis = d.subsec_millis();
    let days = secs.div_euclid(86_400);
    let secs_of_day = secs.rem_euclid(86_400);
    let (y, m, day) = civil_from_days(days);
    let hh = secs_of_day / 3600;
    let mm = (secs_of_day % 3600) / 60;
    let ss = secs_of_day % 60;
    format!("{y:04}-{m:02}-{day:02}T{hh:02}:{mm:02}:{ss:02}.{millis:03}Z")
}

/// Howard Hinnant's `civil_from_days`: days-since-epoch (1970-01-01) ->
/// (year, month, day). Proleptic Gregorian, valid for the entire range a
/// `SystemTime` can represent.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}

fn migrate(conn: &mut Connection) -> DbResult<()> {
    // Acquire the writer lock before reading the version. Two racing first
    // requests may both open a connection; the loser must observe the winner's
    // committed version rather than replaying the same migration from a stale
    // pre-lock read.
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let found: u32 = tx.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if found > CURRENT_SCHEMA_VERSION {
        return Err(DbError::NewerSchemaVersion {
            found,
            supported: CURRENT_SCHEMA_VERSION,
        });
    }
    if found == CURRENT_SCHEMA_VERSION {
        validate_foreign_keys(&tx)?;
        tx.commit()?;
        return Ok(());
    }

    // All pending versions share the same IMMEDIATE transaction: either the
    // full forward upgrade and its final `user_version` land, or the database
    // is byte-for-byte on the old schema.
    let mut expected = found + 1;
    for migration in MIGRATIONS.iter().filter(|m| m.version > found) {
        assert_eq!(
            migration.version, expected,
            "native SQLite migrations must be contiguous and ordered"
        );
        tx.execute_batch(migration.sql)?;
        tx.pragma_update(None, "user_version", migration.version)?;
        expected += 1;
    }
    assert_eq!(
        expected,
        CURRENT_SCHEMA_VERSION + 1,
        "CURRENT_SCHEMA_VERSION must match the last native SQLite migration"
    );
    validate_foreign_keys(&tx)?;
    tx.commit()?;
    Ok(())
}

fn validate_foreign_keys(conn: &Connection) -> DbResult<()> {
    let violation: Option<(String, Option<i64>, String, i64)> = conn
        .query_row(
            "SELECT `table`, rowid, parent, fkid FROM pragma_foreign_key_check LIMIT 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()?;
    if let Some((table, rowid, parent, foreign_key_id)) = violation {
        return Err(DbError::SchemaIntegrity(format!(
            "foreign key {foreign_key_id} from {table} row {rowid:?} to {parent} is violated"
        )));
    }
    Ok(())
}

fn create_private_file(path: &Path) -> std::io::Result<()> {
    let mut options = OpenOptions::new();
    options.create(true).read(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;

        options.mode(0o600);
    }
    drop(options.open(path)?);
    set_owner_only_file(path)
}

#[cfg(unix)]
fn set_owner_only_file(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;

    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
}

#[cfg(not(unix))]
fn set_owner_only_file(_path: &Path) -> std::io::Result<()> {
    Ok(())
}

fn sqlite_sidecar_path(db_path: &Path, suffix: &str) -> PathBuf {
    let mut path = db_path.as_os_str().to_os_string();
    path.push(suffix);
    PathBuf::from(path)
}

/// Tightens a pre-existing database and any WAL files SQLite has materialized.
/// SQLite creates future `-wal`/`-shm` files with the database's mode; setting
/// the main file before enabling WAL therefore also protects later sidecars.
fn secure_sqlite_files(db_path: &Path) -> std::io::Result<()> {
    for path in [
        db_path.to_path_buf(),
        sqlite_sidecar_path(db_path, "-wal"),
        sqlite_sidecar_path(db_path, "-shm"),
    ] {
        match fs::metadata(&path) {
            Ok(_) => set_owner_only_file(&path)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

pub struct ThreadsDb {
    conn: Mutex<Connection>,
}

impl ThreadsDb {
    /// Opens (creating if absent) `<app_root>/studio.db` — the ONE local
    /// SQLite file, shared with the sandbox registry (which versions itself
    /// through its own metadata table, never `user_version`; that pragma
    /// belongs to this ladder).
    ///
    /// The file sits at the app root, so unlike the old `.decocms/local.db`
    /// there is no private parent directory to arrange — only the database
    /// files themselves are chmodded. Do not chmod `app_root` itself: the
    /// standalone local-api may be pointed at an existing project directory
    /// owned by the user.
    pub fn open(app_root: &Path) -> DbResult<Self> {
        let db_path = app_root.join(crate::STUDIO_DB_FILE_NAME);
        create_private_file(&db_path)?;
        secure_sqlite_files(&db_path)?;
        let conn = Connection::open(&db_path)?;
        let db = Self::init(conn)?;
        secure_sqlite_files(&db_path)?;
        Ok(db)
    }

    #[cfg(test)]
    pub fn open_in_memory() -> DbResult<Self> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(mut conn: Connection) -> DbResult<Self> {
        // Two app processes cannot normally share this database because the
        // native instance lock fences them, but two first-open callers can
        // still race during tests or startup tooling. Let SQLite wait for the
        // winning IMMEDIATE migration transaction instead of surfacing a
        // transient SQLITE_BUSY before it can observe the committed version.
        conn.busy_timeout(SQLITE_BUSY_TIMEOUT)?;
        conn.pragma_update(None, "foreign_keys", 1)?;
        migrate(&mut conn)?;
        // SQLite silently keeps `:memory:` databases on "memory" mode even
        // when WAL is requested (it can't be persisted anyway) — this call
        // still succeeds (not an error) in that case, so `?` is safe for
        // both the file-backed and in-memory (test) constructors.
        conn.pragma_update(None, "journal_mode", "WAL")?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Connection> {
        match self.conn.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    #[cfg(test)]
    pub(crate) fn execute_batch_for_test(&self, sql: &str) -> DbResult<()> {
        self.lock().execute_batch(sql)?;
        Ok(())
    }

    /// Claims only attributable pre-v4 rows for this exact signed-in user. The
    /// IMMEDIATE transaction makes "first matching upstream host wins" atomic:
    /// legacy storage has no issuer column, so it cannot safely be shown on two
    /// hosts even when both happen to use the same subject string. Rows written
    /// with the old placeholder creator are deliberately left unclaimed.
    fn adopt_legacy_account_rows(
        &self,
        scope: &RtAccountScope,
        organization_id: &str,
    ) -> DbResult<()> {
        if scope.user_id == "local-desktop-user" {
            return Ok(());
        }
        let account_scope = scope.storage_key();
        let mut conn = self.lock();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute(
            "UPDATE native_scoped_threads SET account_scope = ?1 \
             WHERE account_scope = '' AND organization_id = ?2 \
               AND created_by = ?3 AND created_by <> 'local-desktop-user'",
            params![account_scope, organization_id, scope.user_id],
        )?;
        tx.execute(
            "UPDATE native_scoped_turn_queue SET account_scope = ?1 \
             WHERE account_scope = '' AND EXISTS (\
                 SELECT 1 FROM native_scoped_threads t \
                 WHERE t.id = native_scoped_turn_queue.thread_id \
                   AND t.organization_id = native_scoped_turn_queue.organization_id \
                   AND t.generation = native_scoped_turn_queue.thread_generation \
                   AND t.account_scope = ?1\
             )",
            params![account_scope],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Startup variant of legacy adoption. It runs only after the Keychain has
    /// yielded an authenticated subject and claims every attributable org for
    /// that account before queue recovery scans. Signed-out startup performs no
    /// adoption or recovery.
    pub fn prepare_account_scope(&self, scope: &RtAccountScope) -> DbResult<()> {
        if scope.user_id == "local-desktop-user" {
            return Ok(());
        }
        let account_scope = scope.storage_key();
        let mut conn = self.lock();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute(
            "UPDATE native_scoped_threads SET account_scope = ?1 \
             WHERE account_scope = '' AND created_by = ?2 \
               AND created_by <> 'local-desktop-user'",
            params![account_scope, scope.user_id],
        )?;
        tx.execute(
            "UPDATE native_scoped_turn_queue SET account_scope = ?1 \
             WHERE account_scope = '' AND EXISTS (\
                 SELECT 1 FROM native_scoped_threads t \
                 WHERE t.id = native_scoped_turn_queue.thread_id \
                   AND t.organization_id = native_scoped_turn_queue.organization_id \
                   AND t.generation = native_scoped_turn_queue.thread_generation \
                   AND t.account_scope = ?1\
             )",
            params![account_scope],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn list_threads(&self) -> DbResult<Vec<Thread>> {
        let conn = self.lock();
        let mut stmt = conn.prepare(
            "SELECT id, title, created_at, updated_at FROM threads \
             ORDER BY updated_at DESC, rowid DESC",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(Thread {
                id: row.get(0)?,
                title: row.get(1)?,
                created_at: row.get(2)?,
                updated_at: row.get(3)?,
            })
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    pub fn create_thread(&self, title: String) -> DbResult<Thread> {
        let id = Uuid::new_v4().to_string();
        let ts = now_rfc3339();
        let conn = self.lock();
        conn.execute(
            "INSERT INTO threads (id, title, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)",
            params![id, title, ts],
        )?;
        Ok(Thread {
            id,
            title,
            created_at: ts.clone(),
            updated_at: ts,
        })
    }

    /// Idempotent variant of [`Self::create_thread`] for a CALLER-CHOSEN
    /// `id` — `INSERT OR IGNORE`, then read back whichever row is current.
    /// Phase 2's dispatch route (`routes/dispatch.rs`) is the one caller:
    /// `input.threadId` is caller-supplied (the desktop frontend mints
    /// it, not this store), and dispatch has no separate "create the
    /// thread first" step to depend on — the FIRST dispatch for a given
    /// `threadId` implicitly creates it (empty title), and every
    /// subsequent dispatch for the same id is a harmless no-op here.
    pub fn create_thread_with_id(&self, id: &str, title: &str) -> DbResult<Thread> {
        let ts = now_rfc3339();
        let conn = self.lock();
        conn.execute(
            "INSERT OR IGNORE INTO threads (id, title, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)",
            params![id, title, ts],
        )?;
        conn.query_row(
            "SELECT id, title, created_at, updated_at FROM threads WHERE id = ?1",
            params![id],
            |row| {
                Ok(Thread {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    created_at: row.get(2)?,
                    updated_at: row.get(3)?,
                })
            },
        )
        .map_err(DbError::from)
    }

    pub fn get_thread(&self, id: &str) -> DbResult<Option<Thread>> {
        let conn = self.lock();
        conn.query_row(
            "SELECT id, title, created_at, updated_at FROM threads WHERE id = ?1",
            params![id],
            |row| {
                Ok(Thread {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    created_at: row.get(2)?,
                    updated_at: row.get(3)?,
                })
            },
        )
        .optional()
        .map_err(DbError::from)
    }

    pub fn thread_exists(&self, id: &str) -> DbResult<bool> {
        let conn = self.lock();
        let hit: Option<i64> = conn
            .query_row("SELECT 1 FROM threads WHERE id = ?1", params![id], |r| {
                r.get(0)
            })
            .optional()?;
        Ok(hit.is_some())
    }

    /// `None` if `id` doesn't exist. Reads the row back under the SAME lock
    /// acquisition as the write (never re-enters `self.lock()` — the
    /// underlying `std::sync::Mutex` isn't reentrant) so a concurrent
    /// delete can't race between the `UPDATE` and the follow-up `SELECT`.
    pub fn update_thread_title(&self, id: &str, title: &str) -> DbResult<Option<Thread>> {
        let ts = now_rfc3339();
        let conn = self.lock();
        let changed = conn.execute(
            "UPDATE threads SET title = ?1, updated_at = ?2 WHERE id = ?3",
            params![title, ts, id],
        )?;
        if changed == 0 {
            return Ok(None);
        }
        conn.query_row(
            "SELECT id, title, created_at, updated_at FROM threads WHERE id = ?1",
            params![id],
            |row| {
                Ok(Thread {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    created_at: row.get(2)?,
                    updated_at: row.get(3)?,
                })
            },
        )
        .optional()
        .map_err(DbError::from)
    }

    /// Idempotent by design of a bare `DELETE ... WHERE id = ?1` — zero rows
    /// affected on an already-gone id is not an error. Cascades to
    /// `messages`/`runs` via the schema's `ON DELETE CASCADE` (requires the
    /// `foreign_keys` pragma, set in `init`).
    pub fn delete_thread(&self, id: &str) -> DbResult<()> {
        let conn = self.lock();
        conn.execute("DELETE FROM threads WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn list_messages(&self, thread_id: &str) -> DbResult<Vec<Message>> {
        let conn = self.lock();
        let mut stmt = conn.prepare(
            "SELECT id, thread_id, role, parts, created_at FROM messages \
             WHERE thread_id = ?1 ORDER BY created_at ASC, rowid ASC",
        )?;
        let rows = stmt.query_map(params![thread_id], |row| {
            let parts_raw: String = row.get(3)?;
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                parts_raw,
                row.get::<_, String>(4)?,
            ))
        })?;
        let mut out = Vec::new();
        for r in rows {
            let (id, thread_id, role, parts_raw, created_at) = r?;
            out.push(Message {
                id,
                thread_id,
                role,
                parts: serde_json::from_str(&parts_raw)?,
                created_at,
            });
        }
        Ok(out)
    }

    /// Inserts the message AND bumps the parent thread's `updated_at` to the
    /// SAME timestamp, atomically (a single SQL transaction) — so a reader
    /// can never observe the new message without the thread's `updated_at`
    /// reflecting it.
    pub fn create_message(&self, thread_id: &str, role: &str, parts: &Value) -> DbResult<Message> {
        let id = Uuid::new_v4().to_string();
        let ts = now_rfc3339();
        let parts_str = serde_json::to_string(parts)?;
        let mut conn = self.lock();
        let tx = conn.transaction()?;
        tx.execute(
            "INSERT INTO messages (id, thread_id, role, parts, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, thread_id, role, parts_str, ts],
        )?;
        tx.execute(
            "UPDATE threads SET updated_at = ?1 WHERE id = ?2",
            params![ts, thread_id],
        )?;
        tx.commit()?;
        Ok(Message {
            id,
            thread_id: thread_id.to_string(),
            role: role.to_string(),
            parts: parts.clone(),
            created_at: ts,
        })
    }

    /// Idempotent variant of [`Self::create_message`] for a CALLER-CHOSEN
    /// `id` (rather than a freshly generated UUID): `INSERT OR IGNORE`,
    /// then read back whichever row is now current — the one THIS call
    /// inserted, or an identical one a PRIOR call (with the same `id`)
    /// already inserted. Only bumps the parent thread's `updated_at` when
    /// this call is the one that actually performed the insert (a no-op
    /// re-poll must not keep bumping a thread to the top of the
    /// most-recently-updated list).
    ///
    /// Phase 2's dispatch route (`routes/dispatch.rs`) is the one caller:
    /// it derives a deterministic id per run (`run-<runId>-user` /
    /// `run-<runId>-assistant`) so a dispatch that's retried/re-polled
    /// with the SAME `runId` can call this again without duplicating the
    /// thread's message history — see that file's module doc.
    pub fn create_message_with_id(
        &self,
        id: &str,
        thread_id: &str,
        role: &str,
        parts: &Value,
    ) -> DbResult<Message> {
        let ts = now_rfc3339();
        let parts_str = serde_json::to_string(parts)?;
        let mut conn = self.lock();
        let tx = conn.transaction()?;
        let inserted = tx.execute(
            "INSERT OR IGNORE INTO messages (id, thread_id, role, parts, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, thread_id, role, parts_str, ts],
        )?;
        if inserted > 0 {
            tx.execute(
                "UPDATE threads SET updated_at = ?1 WHERE id = ?2",
                params![ts, thread_id],
            )?;
        }
        let row = tx.query_row(
            "SELECT id, thread_id, role, parts, created_at FROM messages WHERE id = ?1",
            params![id],
            |row| {
                let parts_raw: String = row.get(3)?;
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    parts_raw,
                    row.get::<_, String>(4)?,
                ))
            },
        )?;
        tx.commit()?;
        let (id, thread_id, role, parts_raw, created_at) = row;
        Ok(Message {
            id,
            thread_id,
            role,
            parts: serde_json::from_str(&parts_raw)?,
            created_at,
        })
    }

    /// Idempotent run creation: `INSERT OR IGNORE` keyed by `id` (dispatch's
    /// `runId` — the contract's "`Run.id` MUST equal the dispatch route's
    /// `runId`" coupling), then read back the current row regardless of
    /// which call (this one, or an earlier re-poll of the same `runId`)
    /// performed the insert. New rows always start `status:"running"` —
    /// local-api's dispatch flow is synchronous (spawn → stream
    /// immediately, no queue), so there's no observable `"pending"`
    /// window worth persisting.
    pub fn create_run(&self, id: &str, thread_id: &str, harness_id: &str) -> DbResult<Run> {
        let ts = now_rfc3339();
        let conn = self.lock();
        conn.execute(
            "INSERT OR IGNORE INTO runs (id, thread_id, harness_id, status, created_at) \
             VALUES (?1, ?2, ?3, 'running', ?4)",
            params![id, thread_id, harness_id, ts],
        )?;
        conn.query_row(
            "SELECT id, thread_id, harness_id, status, created_at, ended_at, error FROM runs WHERE id = ?1",
            params![id],
            |row| {
                Ok(Run {
                    id: row.get(0)?,
                    thread_id: row.get(1)?,
                    harness_id: row.get(2)?,
                    status: row.get(3)?,
                    created_at: row.get(4)?,
                    ended_at: row.get(5)?,
                    error: row.get(6)?,
                })
            },
        )
        .map_err(DbError::from)
    }

    /// Writes a TERMINAL status (`"completed"|"failed"|"cancelled"`) for
    /// run `id` — idempotent AND one-way: the `WHERE status NOT IN
    /// (...)` guard means a run already in a terminal status is left
    /// completely untouched by a later call (byte-parity with the
    /// contract's "once set, a run row is never mutated again"), so a
    /// re-poll/retry that calls this twice for the same run is always
    /// safe. `None` (no row matched — either `id` doesn't exist, or it
    /// was already terminal) vs `Some` (this call performed the
    /// transition) is NOT distinguished in the return value — callers
    /// that need to know don't exist yet in this crate, and the
    /// idempotency guarantee is symmetric either way.
    pub fn set_run_terminal_status(
        &self,
        id: &str,
        status: &str,
        error: Option<&str>,
    ) -> DbResult<()> {
        let ts = now_rfc3339();
        let conn = self.lock();
        conn.execute(
            "UPDATE runs SET status = ?1, ended_at = ?2, error = ?3 \
             WHERE id = ?4 AND status NOT IN ('completed', 'failed', 'cancelled')",
            params![status, ts, error, id],
        )?;
        Ok(())
    }

    pub fn list_runs(&self, thread_id: &str) -> DbResult<Vec<Run>> {
        let conn = self.lock();
        let mut stmt = conn.prepare(
            "SELECT id, thread_id, harness_id, status, created_at, ended_at, error FROM runs \
             WHERE thread_id = ?1 ORDER BY created_at DESC, rowid DESC",
        )?;
        let rows = stmt.query_map(params![thread_id], |row| {
            Ok(Run {
                id: row.get(0)?,
                thread_id: row.get(1)?,
                harness_id: row.get(2)?,
                status: row.get(3)?,
                created_at: row.get(4)?,
                ended_at: row.get(5)?,
                error: row.get(6)?,
            })
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    // --- native_scoped_threads / native_scoped_messages ---
    // See migration 1's schema comment.

    /// Idempotent-by-id creation (mirrors [`Self::create_thread_with_id`]):
    /// `INSERT OR IGNORE`, then read back whichever row is current — the one
    /// THIS call inserted, or a prior call with the SAME `id` (e.g.
    /// `COLLECTION_THREADS_CREATE` retried, or the decopilot dispatch
    /// route's own first-message-implicitly-creates-the-thread path finding
    /// a row `COLLECTION_THREADS_CREATE` already made). `id` defaults to a
    /// fresh UUID when the caller doesn't supply one (mirrors
    /// `ThreadCreateData.id?`'s "auto-generated if not provided" contract —
    /// `apps/api/src/tools/thread/create.ts`'s own doc comment).
    #[allow(clippy::too_many_arguments)]
    pub fn rt_create_thread_scoped(
        &self,
        scope: &RtAccountScope,
        id: Option<&str>,
        organization_id: &str,
        title: &str,
        description: Option<&str>,
        virtual_mcp_id: &str,
        branch: Option<&str>,
        created_by: &str,
    ) -> DbResult<RtThread> {
        self.adopt_legacy_account_rows(scope, organization_id)?;
        let account_scope = scope.storage_key();
        let id = id
            .map(str::to_string)
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        // Generated before the transaction: a true retry reads the original
        // live row, while an id retired by DELETE is rejected rather than
        // creating a second incarnation that could accept a delayed old POST.
        let generation = Uuid::new_v4().to_string();
        let ts = now_rfc3339();
        let mut conn = self.lock();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;

        // Preserve the production tool's idempotent-create contract while the
        // row is live. This check and the tombstone check below share the same
        // writer transaction with INSERT, closing every delete/create ABA gap.
        if let Some(thread) = rt_thread_by_id_in_scope(&tx, &account_scope, organization_id, &id)? {
            let delete_pending: bool = tx.query_row(
                "SELECT delete_pending FROM native_scoped_threads \
                 WHERE account_scope = ?1 AND organization_id = ?2 AND id = ?3",
                params![account_scope, organization_id, id],
                |row| row.get(0),
            )?;
            if delete_pending {
                return Err(DbError::ThreadDeletePending {
                    organization_id: organization_id.to_string(),
                    thread_id: id,
                });
            }
            tx.commit()?;
            return Ok(thread);
        }
        if rt_thread_is_tombstoned(&tx, &account_scope, organization_id, &id)? {
            return Err(DbError::RetiredThreadId {
                account_scope,
                organization_id: organization_id.to_string(),
                thread_id: id,
            });
        }

        let inserted = tx.execute(
            "INSERT OR IGNORE INTO native_scoped_threads \
             (id, organization_id, title, description, hidden, status, created_by, updated_by, \
              updated_by_explicit, virtual_mcp_id, trigger_id, branch, sandbox_provider_kind, \
              harness_id, metadata, run_config, created_at, updated_at, generation, account_scope) \
             VALUES (?1, ?2, ?3, ?4, 0, 'completed', ?5, ?5, 0, ?6, NULL, ?7, NULL, NULL, NULL, NULL, ?8, ?8, ?9, ?10)",
            params![
                id,
                organization_id,
                title,
                description,
                created_by,
                virtual_mcp_id,
                branch,
                ts,
                generation,
                account_scope,
            ],
        )?;
        if inserted == 0 {
            // `native_scoped_threads.id` is globally unique in the current physical
            // schema. A row in another account/org is intentionally reported
            // only as an unavailable id, never disclosed to this caller.
            return Err(DbError::IdempotencyConflict {
                entity: "rt_thread",
                id,
            });
        }
        let thread = rt_thread_by_id_in_scope(&tx, &account_scope, organization_id, &id)?
            .ok_or_else(|| DbError::Sqlite(rusqlite::Error::QueryReturnedNoRows))?;
        tx.commit()?;
        Ok(thread)
    }

    #[cfg(test)]
    #[allow(clippy::too_many_arguments)]
    pub fn rt_create_thread(
        &self,
        id: Option<&str>,
        organization_id: &str,
        title: &str,
        description: Option<&str>,
        virtual_mcp_id: &str,
        branch: Option<&str>,
        created_by: &str,
    ) -> DbResult<RtThread> {
        self.rt_create_thread_scoped(
            &RtAccountScope::test_default(),
            id,
            organization_id,
            title,
            description,
            virtual_mcp_id,
            branch,
            created_by,
        )
    }

    #[cfg(test)]
    pub fn rt_get_thread(&self, id: &str) -> DbResult<Option<RtThread>> {
        let conn = self.lock();
        rt_thread_by_id(&conn, id)
    }

    /// Thread lookup for a caller that already holds an accepted turn's
    /// fence. The fence carries the derived storage key rather than the
    /// [`RtAccountScope`] it came from, so it cannot use
    /// [`Self::rt_get_thread_in_scope`] — but it is the same scoped query, so
    /// a fence for one account still cannot read another's thread.
    pub fn rt_get_thread_for_fence(&self, fence: &RtThreadFence) -> DbResult<Option<RtThread>> {
        let conn = self.lock();
        rt_thread_by_id_in_scope(
            &conn,
            &fence.account_scope,
            &fence.organization_id,
            &fence.thread_id,
        )
    }

    pub fn rt_get_thread_in_scope(
        &self,
        scope: &RtAccountScope,
        organization_id: &str,
        id: &str,
    ) -> DbResult<Option<RtThread>> {
        self.adopt_legacy_account_rows(scope, organization_id)?;
        let conn = self.lock();
        rt_thread_by_id_in_scope(&conn, &scope.storage_key(), organization_id, id)
    }

    #[cfg(test)]
    pub fn rt_get_thread_in_org(
        &self,
        organization_id: &str,
        id: &str,
    ) -> DbResult<Option<RtThread>> {
        self.rt_get_thread_in_scope(&RtAccountScope::test_default(), organization_id, id)
    }

    pub fn rt_thread_fence_in_scope(
        &self,
        scope: &RtAccountScope,
        organization_id: &str,
        id: &str,
    ) -> DbResult<Option<RtThreadFence>> {
        self.adopt_legacy_account_rows(scope, organization_id)?;
        let conn = self.lock();
        rt_thread_fence_by_id_in_scope(&conn, &scope.storage_key(), organization_id, id)
    }

    /// Reads the complete production-compatible thread row only while the
    /// durable generation fence still owns that public id. Status events use
    /// this after commit so a live-cache upsert receives the same owner, agent,
    /// branch, title, and timestamp fields as the hosted event factory.
    pub fn rt_thread_fenced(&self, fence: &RtThreadFence) -> DbResult<Option<RtThread>> {
        let conn = self.lock();
        conn.query_row(
            &format!(
                "SELECT {RT_THREAD_COLUMNS} FROM native_scoped_threads \
                 WHERE account_scope = ?1 AND organization_id = ?2 AND id = ?3 \
                   AND generation = ?4"
            ),
            params![
                fence.account_scope,
                fence.organization_id,
                fence.thread_id,
                fence.generation,
            ],
            row_to_rt_thread,
        )
        .optional()
        .map_err(DbError::from)
    }

    /// Reads the harness pin only when the complete durable thread incarnation
    /// still matches. The outer `Option` is the generation fence (missing means
    /// stale/deleted); the inner `Option` is the first-turn lock (missing means
    /// this incarnation has not selected a harness yet).
    pub fn rt_harness_id_fenced(&self, fence: &RtThreadFence) -> DbResult<Option<Option<String>>> {
        let conn = self.lock();
        conn.query_row(
            "SELECT harness_id FROM native_scoped_threads \
             WHERE account_scope = ?1 AND organization_id = ?2 AND id = ?3 \
               AND generation = ?4",
            params![
                fence.account_scope,
                fence.organization_id,
                fence.thread_id,
                fence.generation,
            ],
            |row| row.get(0),
        )
        .optional()
        .map_err(DbError::from)
    }

    #[cfg(test)]
    pub fn rt_thread_fence_in_org(
        &self,
        organization_id: &str,
        id: &str,
    ) -> DbResult<Option<RtThreadFence>> {
        self.rt_thread_fence_in_scope(&RtAccountScope::test_default(), organization_id, id)
    }

    /// Applies the production `COLLECTION_THREADS_LIST` filters. A non-empty
    /// `trigger_ids` takes the storage method's intentionally-special branch:
    /// only account/org, `hidden = false`, and `trigger_id IN (...)` apply;
    /// every other supplied filter is ignored. Otherwise `virtual_mcp_id`
    /// wins over the legacy `agent_id` fallback and the remaining predicates
    /// compose normally. `search` is a case-insensitive literal substring
    /// match on `title`.
    /// Returns `(items, total_count)` so the caller can compute `hasMore`
    /// (`offset + limit < total_count`) without a second round trip.
    pub fn rt_list_threads_scoped(
        &self,
        scope: &RtAccountScope,
        organization_id: &str,
        options: RtThreadListOptions<'_>,
    ) -> DbResult<(Vec<RtThread>, i64)> {
        self.adopt_legacy_account_rows(scope, organization_id)?;
        let conn = self.lock();
        let mut clauses = vec![
            "account_scope = ?1".to_string(),
            "organization_id = ?2".to_string(),
        ];
        let mut sql_params: Vec<Box<dyn rusqlite::ToSql>> = vec![
            Box::new(scope.storage_key()),
            Box::new(organization_id.to_string()),
        ];
        let trigger_ids = options.trigger_ids.filter(|ids| !ids.is_empty());
        if let Some(trigger_ids) = trigger_ids {
            clauses.push("hidden = 0".to_string());
            let mut placeholders = Vec::with_capacity(trigger_ids.len());
            for trigger_id in trigger_ids {
                placeholders.push(format!("?{}", sql_params.len() + 1));
                sql_params.push(Box::new(trigger_id.clone()));
            }
            clauses.push(format!("trigger_id IN ({})", placeholders.join(", ")));
        } else {
            if let Some(user_id) = options.created_by {
                clauses.push(format!("created_by = ?{}", sql_params.len() + 1));
                sql_params.push(Box::new(user_id.to_string()));
            }
            if let Some(hidden) = options.hidden {
                clauses.push(format!("hidden = ?{}", sql_params.len() + 1));
                sql_params.push(Box::new(hidden as i64));
            }
            let virtual_mcp_id = options.virtual_mcp_id.or(options.agent_id);
            if let Some(virtual_mcp_id) = virtual_mcp_id {
                clauses.push(format!("virtual_mcp_id = ?{}", sql_params.len() + 1));
                sql_params.push(Box::new(virtual_mcp_id.to_string()));
            }
            if let Some(has_trigger) = options.has_trigger {
                clauses.push(if has_trigger {
                    "trigger_id IS NOT NULL".to_string()
                } else {
                    "trigger_id IS NULL".to_string()
                });
            }
            if let Some(start_date) = options.start_date {
                clauses.push(format!(
                    "julianday(updated_at) >= julianday(?{})",
                    sql_params.len() + 1
                ));
                sql_params.push(Box::new(start_date.to_string()));
            }
            if let Some(end_date) = options.end_date {
                clauses.push(format!(
                    "julianday(updated_at) <= julianday(?{})",
                    sql_params.len() + 1
                ));
                sql_params.push(Box::new(end_date.to_string()));
            }
            if let Some(s) = options.search.filter(|s| !s.is_empty()) {
                clauses.push(format!("title LIKE ?{} ESCAPE '\\'", sql_params.len() + 1));
                sql_params.push(Box::new(format!("%{}%", like_escape(s))));
            }
            if let Some(status) = options.status {
                clauses.push(format!("status = ?{}", sql_params.len() + 1));
                sql_params.push(Box::new(status.to_string()));
            }
        }
        let where_sql = clauses.join(" AND ");

        let count_sql = format!("SELECT COUNT(*) FROM native_scoped_threads WHERE {where_sql}");
        let total: i64 = conn.query_row(
            &count_sql,
            rusqlite::params_from_iter(sql_params.iter().map(|b| b.as_ref())),
            |row| row.get(0),
        )?;

        let list_sql = format!(
            "SELECT {RT_THREAD_COLUMNS} FROM native_scoped_threads WHERE {where_sql} \
             ORDER BY updated_at DESC, rowid DESC LIMIT ?{} OFFSET ?{}",
            sql_params.len() + 1,
            sql_params.len() + 2,
        );
        sql_params.push(Box::new(options.limit));
        sql_params.push(Box::new(options.offset));
        let mut stmt = conn.prepare(&list_sql)?;
        let rows = stmt.query_map(
            rusqlite::params_from_iter(sql_params.iter().map(|b| b.as_ref())),
            row_to_rt_thread,
        )?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok((out, total))
    }

    /// Applies `patch`'s present fields, bumps `updated_at`, and returns the
    /// resulting row — `None` if `id` doesn't exist. A patch with every
    /// field `None` still bumps `updated_at` (matches
    /// `COLLECTION_THREADS_UPDATE`'s "any call is a real update" semantics;
    /// callers that want a true no-op simply don't call this).
    pub fn rt_update_thread_in_scope(
        &self,
        scope: &RtAccountScope,
        organization_id: &str,
        id: &str,
        updated_by: &str,
        patch: &RtThreadPatch,
    ) -> DbResult<Option<RtThread>> {
        self.adopt_legacy_account_rows(scope, organization_id)?;
        let ts = now_rfc3339();
        let mut sets = vec![
            "updated_at = ?1".to_string(),
            "updated_by = ?2".to_string(),
            "updated_by_explicit = 1".to_string(),
        ];
        let mut sql_params: Vec<Box<dyn rusqlite::ToSql>> =
            vec![Box::new(ts), Box::new(updated_by.to_string())];
        if let Some(v) = &patch.title {
            sets.push(format!("title = ?{}", sql_params.len() + 1));
            sql_params.push(Box::new(v.clone()));
        }
        if let Some(v) = &patch.description {
            sets.push(format!("description = ?{}", sql_params.len() + 1));
            sql_params.push(Box::new(v.clone()));
        }
        if let Some(v) = patch.hidden {
            sets.push(format!("hidden = ?{}", sql_params.len() + 1));
            sql_params.push(Box::new(v as i64));
        }
        if let Some(v) = &patch.status {
            sets.push(format!("status = ?{}", sql_params.len() + 1));
            sql_params.push(Box::new(v.clone()));
        }
        if let Some(v) = &patch.metadata {
            sets.push(format!("metadata = ?{}", sql_params.len() + 1));
            sql_params.push(Box::new(v.as_ref().map(|v| v.to_string())));
        }
        if let Some(v) = &patch.branch {
            sets.push(format!("branch = ?{}", sql_params.len() + 1));
            sql_params.push(Box::new(v.clone()));
        }
        if let Some(v) = &patch.virtual_mcp_id {
            sets.push(format!("virtual_mcp_id = ?{}", sql_params.len() + 1));
            sql_params.push(Box::new(v.clone()));
        }
        let id_placeholder = sql_params.len() + 1;
        sql_params.push(Box::new(id.to_string()));
        let org_placeholder = sql_params.len() + 1;
        sql_params.push(Box::new(organization_id.to_string()));
        let scope_placeholder = sql_params.len() + 1;
        let account_scope = scope.storage_key();
        sql_params.push(Box::new(account_scope.clone()));
        let sql = format!(
            "UPDATE native_scoped_threads SET {} \
             WHERE id = ?{id_placeholder} AND organization_id = ?{org_placeholder} \
               AND account_scope = ?{scope_placeholder}",
            sets.join(", "),
        );
        let mut conn = self.lock();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let delete_pending: Option<bool> = tx
            .query_row(
                "SELECT delete_pending FROM native_scoped_threads \
                 WHERE id = ?1 AND organization_id = ?2 AND account_scope = ?3",
                params![id, organization_id, account_scope],
                |row| row.get(0),
            )
            .optional()?;
        let Some(delete_pending) = delete_pending else {
            tx.commit()?;
            return Ok(None);
        };
        if delete_pending {
            return Err(DbError::ThreadDeletePending {
                organization_id: organization_id.to_string(),
                thread_id: id.to_string(),
            });
        }
        let changed = tx.execute(
            &sql,
            rusqlite::params_from_iter(sql_params.iter().map(|b| b.as_ref())),
        )?;
        if changed == 0 {
            return Err(DbError::InvalidQueueData(format!(
                "thread {organization_id}/{id} disappeared during an exclusive update"
            )));
        }
        let thread = rt_thread_by_id_in_scope(&tx, &account_scope, organization_id, id)?;
        tx.commit()?;
        Ok(thread)
    }

    #[cfg(test)]
    pub fn rt_update_thread_in_org(
        &self,
        organization_id: &str,
        id: &str,
        updated_by: &str,
        patch: &RtThreadPatch,
    ) -> DbResult<Option<RtThread>> {
        self.rt_update_thread_in_scope(
            &RtAccountScope::test_default(),
            organization_id,
            id,
            updated_by,
            patch,
        )
    }

    /// Deletes only when the id belongs to `organization_id`. Returns whether
    /// a row was removed; another tenant's known id is indistinguishable from
    /// an unknown id.
    #[cfg(test)]
    pub fn rt_delete_thread_in_org(&self, organization_id: &str, id: &str) -> DbResult<bool> {
        let Some(fence) =
            self.rt_thread_fence_in_scope(&RtAccountScope::test_default(), organization_id, id)?
        else {
            return Ok(false);
        };
        self.rt_delete_thread_in_org_if_generation(&fence)
    }

    /// Generation-fenced delete for lifecycle shutdown. The durable tombstone,
    /// thread deletion, and queue/message cascades commit atomically: after a
    /// successful return, neither a delayed request nor a process restart can
    /// recreate this public id inside the same account + organization scope.
    pub fn rt_delete_thread_in_org_if_generation(&self, fence: &RtThreadFence) -> DbResult<bool> {
        let mut conn = self.lock();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let owns_generation: bool = tx.query_row(
            "SELECT EXISTS(\
                 SELECT 1 FROM native_scoped_threads \
                 WHERE id = ?1 AND organization_id = ?2 AND generation = ?3 \
                   AND account_scope = ?4\
             )",
            params![
                fence.thread_id,
                fence.organization_id,
                fence.generation,
                fence.account_scope,
            ],
            |row| row.get(0),
        )?;
        if !owns_generation {
            tx.commit()?;
            return Ok(false);
        }

        tx.execute(
            "INSERT INTO native_scoped_thread_tombstones \
             (account_scope, organization_id, thread_id, deleted_generation, deleted_at) \
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                fence.account_scope,
                fence.organization_id,
                fence.thread_id,
                fence.generation,
                now_rfc3339(),
            ],
        )?;
        let deleted = tx.execute(
            "DELETE FROM native_scoped_threads \
             WHERE id = ?1 AND organization_id = ?2 AND generation = ?3 \
               AND account_scope = ?4",
            params![
                fence.thread_id,
                fence.organization_id,
                fence.generation,
                fence.account_scope,
            ],
        )?;
        debug_assert_eq!(
            deleted, 1,
            "IMMEDIATE transaction lost its owned thread row"
        );
        tx.commit()?;
        Ok(deleted == 1)
    }

    /// Durably closes one live generation to new queue admission/claims before
    /// process-local cancellation begins. The marker is intentionally never
    /// cleared on failure: retrying DELETE is the only operation that may
    /// resume this lifecycle, and the final thread cascade removes it.
    pub fn rt_mark_thread_delete_pending(&self, fence: &RtThreadFence) -> DbResult<bool> {
        let conn = self.lock();
        Ok(conn.execute(
            "UPDATE native_scoped_threads SET delete_pending = 1 \
             WHERE account_scope = ?1 AND organization_id = ?2 AND id = ?3 \
               AND generation = ?4",
            params![
                fence.account_scope,
                fence.organization_id,
                fence.thread_id,
                fence.generation,
            ],
        )? == 1)
    }

    #[cfg(test)]
    pub fn rt_thread_delete_pending(&self, fence: &RtThreadFence) -> DbResult<bool> {
        let conn = self.lock();
        conn.query_row(
            "SELECT delete_pending FROM native_scoped_threads \
             WHERE account_scope = ?1 AND organization_id = ?2 AND id = ?3 \
               AND generation = ?4",
            params![
                fence.account_scope,
                fence.organization_id,
                fence.thread_id,
                fence.generation,
            ],
            |row| row.get(0),
        )
        .optional()
        .map(|value| value.unwrap_or(true))
        .map_err(DbError::from)
    }

    /// First-message thread-lock pin (map §3.2 "Locked-thread pin values"):
    /// sets `harness_id`/`sandbox_provider_kind`/`branch` ONLY when each is
    /// currently `NULL` — a later dispatch on the same (now-locked) thread
    /// leaves them untouched even if it names a different harness, mirroring
    /// `decopilot/routes.ts::applyThreadLock`'s "pinned on first message,
    /// immutable after" contract.
    #[cfg(test)]
    pub fn rt_pin_harness_if_unset_in_org(
        &self,
        organization_id: &str,
        id: &str,
        harness_id: &str,
        sandbox_provider_kind: Option<&str>,
        branch: Option<&str>,
    ) -> DbResult<()> {
        let conn = self.lock();
        conn.execute(
            "UPDATE native_scoped_threads SET \
             harness_id = COALESCE(harness_id, ?1), \
             sandbox_provider_kind = COALESCE(sandbox_provider_kind, ?2), \
             branch = COALESCE(branch, ?3) \
             WHERE id = ?4 AND organization_id = ?5",
            params![
                harness_id,
                sandbox_provider_kind,
                branch,
                id,
                organization_id
            ],
        )?;
        Ok(())
    }

    pub fn rt_pin_harness_if_unset_fenced(
        &self,
        fence: &RtThreadFence,
        harness_id: &str,
        sandbox_provider_kind: Option<&str>,
        branch: Option<&str>,
    ) -> DbResult<bool> {
        let conn = self.lock();
        Ok(conn.execute(
            "UPDATE native_scoped_threads SET \
             harness_id = COALESCE(harness_id, ?1), \
             sandbox_provider_kind = COALESCE(sandbox_provider_kind, ?2), \
             branch = COALESCE(branch, ?3) \
             WHERE id = ?4 AND organization_id = ?5 AND generation = ?6 \
               AND account_scope = ?7",
            params![
                harness_id,
                sandbox_provider_kind,
                branch,
                fence.thread_id,
                fence.organization_id,
                fence.generation,
                fence.account_scope,
            ],
        )? > 0)
    }

    #[cfg(test)]
    pub fn rt_list_messages(
        &self,
        thread_id: &str,
        limit: i64,
        offset: i64,
        desc: bool,
    ) -> DbResult<(Vec<RtMessage>, i64)> {
        self.rt_list_messages_inner(None, thread_id, limit, offset, desc)
    }

    pub fn rt_list_messages_in_scope(
        &self,
        scope: &RtAccountScope,
        organization_id: &str,
        thread_id: &str,
        limit: i64,
        offset: i64,
        desc: bool,
    ) -> DbResult<(Vec<RtMessage>, i64)> {
        self.adopt_legacy_account_rows(scope, organization_id)?;
        self.rt_list_messages_inner(
            Some((&scope.storage_key(), organization_id)),
            thread_id,
            limit,
            offset,
            desc,
        )
    }

    #[cfg(test)]
    pub fn rt_list_messages_in_org(
        &self,
        organization_id: &str,
        thread_id: &str,
        limit: i64,
        offset: i64,
        desc: bool,
    ) -> DbResult<(Vec<RtMessage>, i64)> {
        self.rt_list_messages_in_scope(
            &RtAccountScope::test_default(),
            organization_id,
            thread_id,
            limit,
            offset,
            desc,
        )
    }

    fn rt_list_messages_inner(
        &self,
        account_org: Option<(&str, &str)>,
        thread_id: &str,
        limit: i64,
        offset: i64,
        desc: bool,
    ) -> DbResult<(Vec<RtMessage>, i64)> {
        let conn = self.lock();
        let total: i64 = match account_org {
            Some((account_scope, organization_id)) => conn.query_row(
                "SELECT COUNT(*) FROM native_scoped_messages \
                 WHERE thread_id = ?1 AND EXISTS (\
                     SELECT 1 FROM native_scoped_threads \
                     WHERE id = native_scoped_messages.thread_id AND organization_id = ?2 \
                       AND account_scope = ?3\
                 )",
                params![thread_id, organization_id, account_scope],
                |row| row.get(0),
            )?,
            None => conn.query_row(
                "SELECT COUNT(*) FROM native_scoped_messages WHERE thread_id = ?1",
                params![thread_id],
                |row| row.get(0),
            )?,
        };
        // Honor the caller's requested direction so the chat's "latest page"
        // request (orderBy created_at desc on the wire) returns the NEWEST
        // `limit` rows, not the oldest. Local order is the durable per-thread
        // insertion sequence; wall-clock timestamps are payload, not an
        // ordering primitive. `order` is a fixed literal (never user text), so
        // string-interpolating it is safe.
        // Why this matters: a desc page that dropped the newest assistant turn
        // out of the window let the deduped user row (server clock) sort after a
        // same-turn assistant left on the client clock, so the assistant
        // rendered above its own user message (and reloading a >limit thread
        // showed the oldest page instead of the recent conversation).
        let order = if desc { "DESC" } else { "ASC" };
        // `seq` is appended last so existing column indices in
        // `row_to_rt_message` are unchanged.
        let (sql, sql_params): (String, Vec<Box<dyn rusqlite::ToSql>>) = match account_org {
            Some((account_scope, organization_id)) => (
                format!(
                    "SELECT id, thread_id, role, parts, metadata, created_at, updated_at, seq \
                         FROM native_scoped_messages \
                         WHERE thread_id = ?1 AND EXISTS (\
                             SELECT 1 FROM native_scoped_threads \
                             WHERE id = native_scoped_messages.thread_id AND organization_id = ?2 \
                               AND account_scope = ?3\
                         ) \
                         ORDER BY seq {order} LIMIT ?4 OFFSET ?5"
                ),
                vec![
                    Box::new(thread_id.to_string()),
                    Box::new(organization_id.to_string()),
                    Box::new(account_scope.to_string()),
                    Box::new(limit),
                    Box::new(offset),
                ],
            ),
            None => (
                format!(
                    "SELECT id, thread_id, role, parts, metadata, created_at, updated_at, seq \
                         FROM native_scoped_messages \
                         WHERE thread_id = ?1 ORDER BY seq {order} LIMIT ?2 OFFSET ?3"
                ),
                vec![
                    Box::new(thread_id.to_string()),
                    Box::new(limit),
                    Box::new(offset),
                ],
            ),
        };
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(
            rusqlite::params_from_iter(sql_params.iter().map(|value| value.as_ref())),
            row_to_rt_message,
        )?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok((out, total))
    }

    /// Reads a deterministic message id before dispatch starts side effects.
    /// Callers must compare the returned thread/role/parts/metadata with their
    /// intended append (the same exact-identity rule enforced by
    /// [`Self::rt_append_message`]) rather than treating any id hit as a match.
    #[cfg(test)]
    pub fn rt_get_message(&self, id: &str) -> DbResult<Option<RtMessage>> {
        let conn = self.lock();
        rt_message_by_id(&conn, id)
    }

    #[cfg(test)]
    pub fn rt_get_message_in_scope(
        &self,
        scope: &RtAccountScope,
        organization_id: &str,
        id: &str,
    ) -> DbResult<Option<RtMessage>> {
        self.adopt_legacy_account_rows(scope, organization_id)?;
        let conn = self.lock();
        conn.query_row(
            "SELECT id, thread_id, role, parts, metadata, created_at, updated_at, seq \
             FROM native_scoped_messages \
             WHERE id = ?1 AND EXISTS (\
                 SELECT 1 FROM native_scoped_threads \
                 WHERE id = native_scoped_messages.thread_id AND organization_id = ?2 \
                   AND account_scope = ?3\
             )",
            params![id, organization_id, scope.storage_key()],
            row_to_rt_message,
        )
        .optional()
        .map_err(DbError::from)
    }

    pub fn rt_get_message_fenced(
        &self,
        fence: &RtThreadFence,
        id: &str,
    ) -> DbResult<Option<RtMessage>> {
        let conn = self.lock();
        conn.query_row(
            "SELECT id, thread_id, role, parts, metadata, created_at, updated_at, seq \
             FROM native_scoped_messages \
             WHERE id = ?1 AND EXISTS (\
                 SELECT 1 FROM native_scoped_threads \
                 WHERE id = native_scoped_messages.thread_id AND account_scope = ?2 \
                   AND organization_id = ?3 AND generation = ?4\
             )",
            params![
                id,
                fence.account_scope,
                fence.organization_id,
                fence.generation,
            ],
            row_to_rt_message,
        )
        .optional()
        .map_err(DbError::from)
    }

    #[cfg(test)]
    pub fn rt_get_message_in_org(
        &self,
        organization_id: &str,
        id: &str,
    ) -> DbResult<Option<RtMessage>> {
        self.rt_get_message_in_scope(&RtAccountScope::test_default(), organization_id, id)
    }

    /// Appends a message and bumps the parent thread's `updated_at`
    /// atomically, same pattern as [`Self::create_message`]. `id` is
    /// caller-chosen (not auto-generated) so dispatch can mint deterministic
    /// ids (`msg-<taskId>-user` / `msg-<taskId>-assistant`). Repeating an id is
    /// idempotent only when thread/role/parts/metadata are semantically equal:
    /// the original row is returned, its `seq` is not consumed again, and the
    /// parent thread is not bumped a second time. Reusing an id for different
    /// content is an explicit [`DbError::IdempotencyConflict`].
    /// Test-only compatibility entry point without an organization or
    /// generation fence. Production workers persist claimed turns through
    /// [`Self::rt_begin_claimed_turn`] and [`Self::rt_finalize_claimed_turn`].
    #[cfg(test)]
    pub fn rt_append_message(
        &self,
        id: &str,
        thread_id: &str,
        role: &str,
        parts: &Value,
        metadata: Option<&Value>,
    ) -> DbResult<RtMessage> {
        self.rt_append_message_inner(None, None, id, thread_id, role, parts, metadata)
    }

    #[allow(clippy::too_many_arguments)]
    #[cfg(test)]
    pub fn rt_append_message_in_org(
        &self,
        organization_id: &str,
        id: &str,
        thread_id: &str,
        role: &str,
        parts: &Value,
        metadata: Option<&Value>,
    ) -> DbResult<RtMessage> {
        self.rt_append_message_inner(
            Some(organization_id),
            None,
            id,
            thread_id,
            role,
            parts,
            metadata,
        )
    }

    #[cfg(test)]
    #[allow(clippy::too_many_arguments)]
    fn rt_append_message_inner(
        &self,
        organization_id: Option<&str>,
        generation: Option<&str>,
        id: &str,
        thread_id: &str,
        role: &str,
        parts: &Value,
        metadata: Option<&Value>,
    ) -> DbResult<RtMessage> {
        let ts = now_rfc3339();
        let parts_str = serde_json::to_string(parts)?;
        let metadata_str = metadata.map(|m| m.to_string());
        let mut conn = self.lock();
        // Reserve the writer slot before reading MAX(seq), so even a future
        // second process/connection cannot allocate the same per-thread value.
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(organization_id) = organization_id {
            let owns_thread: bool = match generation {
                Some(generation) => tx.query_row(
                    "SELECT EXISTS(\
                        SELECT 1 FROM native_scoped_threads \
                        WHERE id = ?1 AND organization_id = ?2 AND generation = ?3\
                     )",
                    params![thread_id, organization_id, generation],
                    |row| row.get(0),
                )?,
                None => tx.query_row(
                    "SELECT EXISTS(\
                        SELECT 1 FROM native_scoped_threads WHERE id = ?1 AND organization_id = ?2\
                     )",
                    params![thread_id, organization_id],
                    |row| row.get(0),
                )?,
            };
            if !owns_thread {
                if let Some(generation) = generation {
                    return Err(DbError::StaleThreadGeneration {
                        organization_id: organization_id.to_string(),
                        thread_id: thread_id.to_string(),
                        generation: generation.to_string(),
                    });
                }
                return Err(DbError::Sqlite(rusqlite::Error::QueryReturnedNoRows));
            }
        }
        let inserted = tx.execute(
            "INSERT OR IGNORE INTO native_scoped_messages \
             (id, thread_id, role, parts, metadata, seq, created_at, updated_at) \
             VALUES (\
                 ?1, ?2, ?3, ?4, ?5, \
                 (SELECT COALESCE(MAX(seq), 0) + 1 FROM native_scoped_messages WHERE thread_id = ?2), \
                 ?6, ?6\
             )",
            params![id, thread_id, role, parts_str, metadata_str, ts],
        )?;
        if inserted > 0 {
            match (organization_id, generation) {
                (Some(organization_id), Some(generation)) => tx.execute(
                    "UPDATE native_scoped_threads SET updated_at = ?1 \
                     WHERE id = ?2 AND organization_id = ?3 AND generation = ?4",
                    params![ts, thread_id, organization_id, generation],
                )?,
                (Some(organization_id), None) => tx.execute(
                    "UPDATE native_scoped_threads SET updated_at = ?1 \
                     WHERE id = ?2 AND organization_id = ?3",
                    params![ts, thread_id, organization_id],
                )?,
                (None, _) => tx.execute(
                    "UPDATE native_scoped_threads SET updated_at = ?1 WHERE id = ?2",
                    params![ts, thread_id],
                )?,
            };
        }
        let message = match (organization_id, generation) {
            (Some(organization_id), Some(generation)) => tx.query_row(
                "SELECT id, thread_id, role, parts, metadata, created_at, updated_at, seq \
                 FROM native_scoped_messages \
                 WHERE id = ?1 AND EXISTS (\
                     SELECT 1 FROM native_scoped_threads \
                     WHERE id = native_scoped_messages.thread_id AND organization_id = ?2 \
                       AND generation = ?3\
                 )",
                params![id, organization_id, generation],
                row_to_rt_message,
            )?,
            (Some(organization_id), None) => tx.query_row(
                "SELECT id, thread_id, role, parts, metadata, created_at, updated_at, seq \
                 FROM native_scoped_messages \
                 WHERE id = ?1 AND EXISTS (\
                     SELECT 1 FROM native_scoped_threads \
                     WHERE id = native_scoped_messages.thread_id AND organization_id = ?2\
                 )",
                params![id, organization_id],
                row_to_rt_message,
            )?,
            (None, _) => tx.query_row(
                "SELECT id, thread_id, role, parts, metadata, created_at, updated_at, seq \
                 FROM native_scoped_messages WHERE id = ?1",
                params![id],
                row_to_rt_message,
            )?,
        };
        if inserted == 0
            && (message.thread_id != thread_id
                || message.role != role
                || message.parts != *parts
                || message.metadata.as_ref() != metadata)
        {
            return Err(DbError::IdempotencyConflict {
                entity: "rt_message",
                id: id.to_string(),
            });
        }
        tx.commit()?;
        Ok(message)
    }

    #[cfg(test)]
    pub fn rt_set_thread_status_in_org(
        &self,
        organization_id: &str,
        id: &str,
        status: &str,
    ) -> DbResult<()> {
        let ts = now_rfc3339();
        let conn = self.lock();
        conn.execute(
            "UPDATE native_scoped_threads SET status = ?1, updated_at = ?2 \
                 WHERE id = ?3 AND organization_id = ?4",
            params![status, ts, id, organization_id],
        )?;
        Ok(())
    }

    /// Scans assistant messages newest-first for the most recent valid
    /// `data-harness-session` resume-token pseudo-part `harness::parts`
    /// appends (see that crate's module doc's "Resume token convention").
    ///
    /// A failed/cancelled turn may persist an assistant row before the CLI
    /// reports a session id. That row must not hide the previous valid resume
    /// token: the CLI still owns the earlier on-disk conversation and the next
    /// turn must continue it rather than silently starting a new session.
    #[cfg(test)]
    pub fn rt_last_assistant_session_in_org(
        &self,
        organization_id: &str,
        thread_id: &str,
    ) -> DbResult<Option<(String, String)>> {
        self.rt_last_assistant_session_inner(organization_id, thread_id, None, None, None)
    }

    #[cfg(test)]
    pub fn rt_last_assistant_session_for_harness_in_org(
        &self,
        organization_id: &str,
        thread_id: &str,
        harness_id: &str,
    ) -> DbResult<Option<(String, String)>> {
        self.rt_last_assistant_session_inner(
            organization_id,
            thread_id,
            None,
            None,
            Some(harness_id),
        )
    }

    pub fn rt_last_assistant_session_fenced(
        &self,
        fence: &RtThreadFence,
        harness_id: &str,
    ) -> DbResult<Option<(String, String)>> {
        self.rt_last_assistant_session_inner(
            &fence.organization_id,
            &fence.thread_id,
            Some(&fence.generation),
            Some(&fence.account_scope),
            Some(harness_id),
        )
    }

    fn rt_last_assistant_session_inner(
        &self,
        organization_id: &str,
        thread_id: &str,
        generation: Option<&str>,
        account_scope: Option<&str>,
        expected_harness_id: Option<&str>,
    ) -> DbResult<Option<(String, String)>> {
        let conn = self.lock();
        let mut statement = match generation {
            Some(_) => conn.prepare(
                "SELECT parts FROM native_scoped_messages \
                     WHERE thread_id = ?1 AND role = 'assistant' AND EXISTS (\
                         SELECT 1 FROM native_scoped_threads \
                         WHERE id = native_scoped_messages.thread_id AND organization_id = ?2 \
                           AND generation = ?3 AND account_scope = ?4\
                     ) \
                     ORDER BY seq DESC",
            )?,
            None => conn.prepare(
                "SELECT parts FROM native_scoped_messages \
                     WHERE thread_id = ?1 AND role = 'assistant' AND EXISTS (\
                         SELECT 1 FROM native_scoped_threads \
                         WHERE id = native_scoped_messages.thread_id AND organization_id = ?2\
                     ) \
                     ORDER BY seq DESC",
            )?,
        };
        let mut rows = match generation {
            Some(generation) => statement.query(params![
                thread_id,
                organization_id,
                generation,
                account_scope
            ])?,
            None => statement.query(params![thread_id, organization_id])?,
        };

        while let Some(row) = rows.next()? {
            let parts_json: String = row.get(0)?;
            let parts: Value = serde_json::from_str(&parts_json)?;
            let Some(parts) = parts.as_array() else {
                continue;
            };
            for part in parts.iter().rev() {
                if part.get("type").and_then(Value::as_str) != Some("data-harness-session") {
                    continue;
                }
                let Some(harness_id) = part
                    .get("harnessId")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                else {
                    continue;
                };
                if expected_harness_id.is_some_and(|expected| expected != harness_id) {
                    continue;
                }
                let Some(session_id) = part
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                else {
                    continue;
                };
                return Ok(Some((harness_id.to_string(), session_id.to_string())));
            }
        }
        Ok(None)
    }

    /// Durably accepts a turn before its HTTP handler returns `202`.
    /// Repeating either identity (`message_id` or `workflow_id`) is a no-op
    /// only when every caller-controlled field is semantically identical.
    pub fn rt_enqueue_turn_scoped(
        &self,
        scope: &RtAccountScope,
        organization_id: &str,
        thread_id: &str,
        input: &RtTurnEnqueueInput,
    ) -> DbResult<RtTurnEnqueueOutcome> {
        self.adopt_legacy_account_rows(scope, organization_id)?;
        let account_scope = scope.storage_key();
        for (name, value) in [
            ("organization_id", organization_id),
            ("thread_id", thread_id),
            ("message_id", input.message_id.as_str()),
            ("workflow_id", input.workflow_id.as_str()),
            ("task_id", input.task_id.as_str()),
        ] {
            if value.is_empty() {
                return Err(DbError::InvalidQueueData(format!(
                    "{name} must not be empty"
                )));
            }
        }
        if input.user_message.get("id").and_then(Value::as_str) != Some(input.message_id.as_str())
            || input.user_message.get("role").and_then(Value::as_str) != Some("user")
        {
            return Err(DbError::InvalidQueueData(
                "user_message must be a user role with id equal to message_id".to_string(),
            ));
        }
        if is_native_assistant_message_id(&input.message_id) {
            return Err(DbError::InvalidQueueData(format!(
                "message_id uses reserved namespace {NATIVE_ASSISTANT_MESSAGE_ID_PREFIX}"
            )));
        }
        let enqueued_at = i64::try_from(input.enqueued_at).map_err(|_| {
            DbError::InvalidQueueData("enqueued_at does not fit SQLite INTEGER".to_string())
        })?;
        let normalized_input_json = serde_json::to_string(&input.normalized_input)?;
        let user_message_json = serde_json::to_string(&input.user_message)?;
        let mut conn = self.lock();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let Some(fence) =
            rt_thread_fence_by_id_in_scope(&tx, &account_scope, organization_id, thread_id)?
        else {
            return Err(DbError::Sqlite(rusqlite::Error::QueryReturnedNoRows));
        };
        let delete_pending: bool = tx.query_row(
            "SELECT delete_pending FROM native_scoped_threads \
             WHERE account_scope = ?1 AND organization_id = ?2 AND id = ?3 \
               AND generation = ?4",
            params![account_scope, organization_id, thread_id, fence.generation],
            |row| row.get(0),
        )?;
        if delete_pending {
            return Err(DbError::ThreadDeletePending {
                organization_id: organization_id.to_string(),
                thread_id: thread_id.to_string(),
            });
        }
        let assistant_message_id = native_assistant_message_id(&fence, &input.message_id);

        let existing = rt_turn_queue_query(
            &tx,
            "account_scope = ?1 AND organization_id = ?2 AND thread_id = ?3 \
             AND thread_generation = ?4 AND (message_id = ?5 OR workflow_id = ?6)",
            params![
                account_scope,
                organization_id,
                thread_id,
                fence.generation,
                input.message_id,
                input.workflow_id,
            ],
        )?;
        if !existing.is_empty() {
            if existing.len() == 1 {
                let item = existing.into_iter().next().expect("one existing row");
                if item.message_id == input.message_id
                    && item.workflow_id == input.workflow_id
                    && item.task_id == input.task_id
                    && item.normalized_input == input.normalized_input
                    && item.user_message == input.user_message
                {
                    tx.commit()?;
                    return Ok(RtTurnEnqueueOutcome::Existing(item));
                }
            }
            return Err(DbError::IdempotencyConflict {
                entity: "rt_turn_queue",
                id: input.message_id.clone(),
            });
        }

        // The message table's primary key is intentionally global, while a
        // queue row is tenant/thread scoped. Reserve both eventual global ids
        // in this same IMMEDIATE transaction so no request can receive `202`
        // and discover a collision only after its harness performs side
        // effects. A current-protocol crash window always retains its durable
        // queue row and was handled by the exact-identity lookup above. A
        // persisted user with no queue ownership is therefore legacy or
        // corrupt state, never permission to rerun side-effecting work.
        let user_parts = input
            .user_message
            .get("parts")
            .cloned()
            .unwrap_or_else(|| Value::Array(Vec::new()));
        let user_metadata = input.user_message.get("metadata");
        let persisted_user = rt_message_by_id(&tx, &input.message_id)?;
        if let Some(user) = &persisted_user {
            if user.thread_id != thread_id
                || user.role != "user"
                || user.parts != user_parts
                || user.metadata.as_ref() != user_metadata
            {
                return Err(DbError::IdempotencyConflict {
                    entity: "rt_message",
                    id: input.message_id.clone(),
                });
            }
        }

        let persisted_assistant = rt_message_by_id(&tx, &assistant_message_id)?;
        if let Some(assistant) = &persisted_assistant {
            if !is_exact_completed_turn_pair(persisted_user.as_ref(), assistant, thread_id) {
                return Err(DbError::IdempotencyConflict {
                    entity: "rt_message",
                    id: assistant_message_id,
                });
            }
            tx.commit()?;
            return Ok(RtTurnEnqueueOutcome::Completed);
        }

        // Transitional queue builds used a user-seeded assistant id. Recognize
        // that exact same-thread pair for retry only; new queue rows always
        // reserve the namespaced v1 id above. The shipped pre-migration app
        // instead seeded assistant ids from a fresh server task id, which is
        // not recoverably linked to its user row.
        if persisted_user.is_some() {
            let legacy_assistant_id = legacy_native_assistant_message_id(&input.message_id);
            if let Some(assistant) = rt_message_by_id(&tx, &legacy_assistant_id)? {
                if !is_exact_completed_turn_pair(persisted_user.as_ref(), &assistant, thread_id) {
                    return Err(DbError::IdempotencyConflict {
                        entity: "rt_message",
                        id: legacy_assistant_id,
                    });
                }
                tx.commit()?;
                return Ok(RtTurnEnqueueOutcome::Completed);
            }

            // Fail closed for an unowned persisted user. In the shipped
            // pre-migration implementation, `msg-{task_id}-assistant` cannot be
            // derived from the client message id, so absence of either
            // provable completion id does NOT prove the old harness failed to
            // run. Enqueuing here could repeat arbitrary CLI side effects.
            // Preserve every historical row and require a new user-message id
            // for new work instead.
            return Err(DbError::IdempotencyConflict {
                entity: "rt_message",
                id: input.message_id.clone(),
            });
        }

        let reserved_by_another_queue: Option<String> = tx
            .query_row(
                "SELECT workflow_id FROM native_scoped_turn_queue \
                 WHERE message_id IN (?1, ?2) \
                    OR assistant_message_id IN (?1, ?2) \
                 LIMIT 1",
                params![input.message_id, assistant_message_id],
                |row| row.get(0),
            )
            .optional()?;
        if reserved_by_another_queue.is_some() {
            return Err(DbError::IdempotencyConflict {
                entity: "rt_turn_queue",
                id: input.message_id.clone(),
            });
        }

        let fifo_ordinal: i64 = tx.query_row(
            "SELECT COALESCE(MAX(fifo_ordinal), 0) + 1 FROM native_scoped_turn_queue \
             WHERE account_scope = ?1 AND organization_id = ?2 AND thread_id = ?3 \
               AND thread_generation = ?4",
            params![account_scope, organization_id, thread_id, fence.generation],
            |row| row.get(0),
        )?;
        tx.execute(
            "INSERT INTO native_scoped_turn_queue (\
                account_scope, organization_id, thread_id, thread_generation, message_id, \
                assistant_message_id, workflow_id, task_id, normalized_input_json, \
                user_message_json, enqueued_at, fifo_ordinal, state, claim_token\
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 'queued', NULL)",
            params![
                account_scope,
                organization_id,
                thread_id,
                fence.generation,
                input.message_id,
                assistant_message_id,
                input.workflow_id,
                input.task_id,
                normalized_input_json,
                user_message_json,
                enqueued_at,
                fifo_ordinal,
            ],
        )?;
        let item = rt_turn_queue_by_workflow(&tx, &fence, &input.workflow_id)?
            .ok_or_else(|| DbError::Sqlite(rusqlite::Error::QueryReturnedNoRows))?;
        tx.commit()?;
        Ok(RtTurnEnqueueOutcome::Inserted(item))
    }

    #[cfg(test)]
    pub fn rt_enqueue_turn_in_org(
        &self,
        organization_id: &str,
        thread_id: &str,
        input: &RtTurnEnqueueInput,
    ) -> DbResult<RtTurnEnqueueOutcome> {
        self.rt_enqueue_turn_scoped(
            &RtAccountScope::test_default(),
            organization_id,
            thread_id,
            input,
        )
    }

    pub fn rt_list_turn_queue_scoped(
        &self,
        scope: &RtAccountScope,
        organization_id: &str,
        thread_id: &str,
    ) -> DbResult<Vec<RtTurnQueueItem>> {
        self.adopt_legacy_account_rows(scope, organization_id)?;
        let account_scope = scope.storage_key();
        let conn = self.lock();
        let Some(fence) =
            rt_thread_fence_by_id_in_scope(&conn, &account_scope, organization_id, thread_id)?
        else {
            return Ok(Vec::new());
        };
        rt_turn_queue_query(
            &conn,
            "account_scope = ?1 AND organization_id = ?2 AND thread_id = ?3 \
             AND thread_generation = ?4",
            params![account_scope, organization_id, thread_id, fence.generation],
        )
    }

    #[cfg(test)]
    pub fn rt_list_turn_queue_in_org(
        &self,
        organization_id: &str,
        thread_id: &str,
    ) -> DbResult<Vec<RtTurnQueueItem>> {
        self.rt_list_turn_queue_scoped(&RtAccountScope::test_default(), organization_id, thread_id)
    }

    /// Claims the FIFO head only when no active row exists. A persisted
    /// `running` row after process restart is deliberately NOT reset/retried:
    /// its CLI may already have performed side effects. Recovery must finalize
    /// it via [`Self::rt_list_orphaned_active_turns`] before claiming the safe
    /// queued tail.
    #[cfg(test)]
    pub fn rt_claim_turn_queue_head_in_org(
        &self,
        organization_id: &str,
        thread_id: &str,
    ) -> DbResult<Option<RtTurnQueueItem>> {
        match self.rt_claim_turn_queue_head_inner(
            &RtAccountScope::test_default().storage_key(),
            organization_id,
            thread_id,
            None,
        )? {
            Some(RtTurnClaimOutcome::Ready(item)) => Ok(Some(item)),
            Some(RtTurnClaimOutcome::Malformed(item)) => Err(DbError::InvalidQueueData(format!(
                "malformed claimed workflow {}: {}",
                item.workflow_id, item.error
            ))),
            Some(RtTurnClaimOutcome::Completed { .. }) => Ok(None),
            None => Ok(None),
        }
    }

    /// Same claim operation, but refuses to cross a stale-generation/delete
    /// boundary.
    /// Drain workers should use this after their first claim establishes which
    /// thread incarnation they own.
    pub fn rt_claim_turn_queue_head_fenced(
        &self,
        fence: &RtThreadFence,
    ) -> DbResult<Option<RtTurnClaimOutcome>> {
        self.rt_claim_turn_queue_head_inner(
            &fence.account_scope,
            &fence.organization_id,
            &fence.thread_id,
            Some(&fence.generation),
        )
    }

    fn rt_claim_turn_queue_head_inner(
        &self,
        account_scope: &str,
        organization_id: &str,
        thread_id: &str,
        expected_generation: Option<&str>,
    ) -> DbResult<Option<RtTurnClaimOutcome>> {
        let mut conn = self.lock();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let Some(fence) =
            rt_thread_fence_by_id_in_scope(&tx, account_scope, organization_id, thread_id)?
        else {
            tx.commit()?;
            return Ok(None);
        };
        if let Some(expected) = expected_generation {
            if expected != fence.generation.as_str() {
                return Err(DbError::StaleThreadGeneration {
                    organization_id: organization_id.to_string(),
                    thread_id: thread_id.to_string(),
                    generation: expected.to_string(),
                });
            }
        }
        let delete_pending: bool = tx.query_row(
            "SELECT delete_pending FROM native_scoped_threads \
             WHERE account_scope = ?1 AND organization_id = ?2 AND id = ?3 \
               AND generation = ?4",
            params![account_scope, organization_id, thread_id, fence.generation],
            |row| row.get(0),
        )?;
        if delete_pending {
            tx.commit()?;
            return Ok(None);
        }
        let active: bool = tx.query_row(
            "SELECT EXISTS(\
                SELECT 1 FROM native_scoped_turn_queue \
                WHERE account_scope = ?1 AND organization_id = ?2 AND thread_id = ?3 \
                  AND thread_generation = ?4 \
                  AND state IN ('running', 'cancel_requested')\
             )",
            params![account_scope, organization_id, thread_id, fence.generation],
            |row| row.get(0),
        )?;
        if active {
            tx.commit()?;
            return Ok(None);
        }
        let raw: Option<RawRtTurnQueueItem> = tx
            .query_row(
                &format!(
                    "SELECT {RT_TURN_QUEUE_COLUMNS} FROM native_scoped_turn_queue \
                     WHERE account_scope = ?1 AND organization_id = ?2 AND thread_id = ?3 \
                       AND thread_generation = ?4 AND state = 'queued' \
                     ORDER BY fifo_ordinal ASC LIMIT 1"
                ),
                params![account_scope, organization_id, thread_id, fence.generation],
                row_to_raw_rt_turn_queue,
            )
            .optional()?;
        let Some(mut raw) = raw else {
            tx.commit()?;
            return Ok(None);
        };
        let candidate_assistant_id = raw
            .assistant_message_id
            .clone()
            .unwrap_or_else(|| legacy_native_assistant_message_id(&raw.message_id));
        let claim_token = Uuid::new_v4().to_string();
        let changed = tx.execute(
            "UPDATE native_scoped_turn_queue SET state = 'running', claim_token = ?1 \
             WHERE account_scope = ?2 AND organization_id = ?3 AND thread_id = ?4 \
               AND thread_generation = ?5 AND workflow_id = ?6 AND state = 'queued'",
            params![
                claim_token,
                account_scope,
                organization_id,
                thread_id,
                fence.generation,
                raw.workflow_id,
            ],
        )?;
        if changed != 1 {
            return Err(DbError::InvalidQueueData(format!(
                "could not exclusively claim workflow {}",
                raw.workflow_id
            )));
        }
        raw.state = "running".to_string();
        raw.claim_token = Some(claim_token);
        let parsed = parse_raw_rt_turn_queue(raw.clone());
        let canonical_user = parse_canonical_queued_user(&raw.message_id, &raw.user_message_json);
        let reservation_state = validate_raw_turn_reservations(
            &tx,
            &raw,
            &candidate_assistant_id,
            canonical_user.as_ref().ok(),
        )?;
        let (claim_error, completed_persisted_pair) = match reservation_state {
            RawTurnReservationState::Safe => (None, false),
            RawTurnReservationState::Completed => (None, true),
            RawTurnReservationState::Quarantine(error) => (Some(error), false),
        };
        if completed_persisted_pair {
            adopt_completed_raw_turn(&tx, &raw)?;
            let workflow_id = raw.workflow_id;
            tx.commit()?;
            return Ok(Some(RtTurnClaimOutcome::Completed { workflow_id }));
        }
        let preserve_canonical_user = claim_error.is_none()
            && parsed.is_err()
            && canonical_user.is_ok()
            && !completed_persisted_pair;
        if let Some(reason) = claim_error
            .as_ref()
            .or_else(|| parsed.as_ref().err())
            .map(ToString::to_string)
        {
            // Persist the quarantine decision before returning it. A process
            // crash between claim and finalization must not turn a valid-JSON
            // pre-v8 collision back into executable harness work on recovery.
            // Keep the original assistant reservation untouched: changing it
            // can itself violate the v1 partial unique index when another
            // queued turn already owns the isolation id.
            let changed = tx.execute(
                "UPDATE native_scoped_turn_queue SET quarantine_reason = ?1, \
                     quarantine_preserve_user = ?2 \
                 WHERE account_scope = ?3 AND organization_id = ?4 AND thread_id = ?5 \
                   AND thread_generation = ?6 AND workflow_id = ?7 \
                   AND state = 'running' AND claim_token = ?8",
                params![
                    reason,
                    preserve_canonical_user,
                    raw.account_scope,
                    raw.organization_id,
                    raw.thread_id,
                    raw.thread_generation,
                    raw.workflow_id,
                    raw.claim_token,
                ],
            )?;
            if changed != 1 {
                return Err(DbError::InvalidQueueData(format!(
                    "could not persist quarantine for workflow {}",
                    raw.workflow_id
                )));
            }
            raw.quarantine_reason = Some(reason);
            raw.quarantine_preserve_user = preserve_canonical_user;
        }
        let claimed = match (claim_error, parsed) {
            (Some(error), _) | (None, Err(error)) => {
                RtTurnClaimOutcome::Malformed(raw.malformed_orphan(error))
            }
            (None, Ok(item)) => RtTurnClaimOutcome::Ready(item),
        };
        tx.commit()?;
        Ok(Some(claimed))
    }

    /// Starts an owned durable turn in one write transaction. The canonical
    /// user message comes from the queue row itself (never a reconstructed RAM
    /// copy), is inserted with the same exact-idempotency rule as terminal
    /// assistants, and the thread becomes `in_progress` only if both persist.
    ///
    /// A cancellation that wins before this boundary is reported separately
    /// and writes nothing. The caller can then use
    /// [`Self::rt_finalize_claimed_turn`] to publish its failed/cancelled
    /// terminal result without ever starting the side-effecting harness.
    pub fn rt_begin_claimed_turn(&self, claimed: &RtTurnQueueItem) -> DbResult<RtTurnBeginOutcome> {
        let claim_token = claimed.claim_token.as_deref().ok_or_else(|| {
            DbError::InvalidQueueData(format!(
                "workflow {} has no claim token",
                claimed.workflow_id
            ))
        })?;
        let ts = now_rfc3339();
        let mut conn = self.lock();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let persisted: Option<(String, String, String)> = tx
            .query_row(
                "SELECT message_id, user_message_json, state \
                 FROM native_scoped_turn_queue \
                 WHERE account_scope = ?1 AND organization_id = ?2 AND thread_id = ?3 \
                   AND thread_generation = ?4 AND workflow_id = ?5 \
                   AND state IN ('running', 'cancel_requested') AND claim_token = ?6 \
                   AND EXISTS (\
                       SELECT 1 FROM native_scoped_threads \
                       WHERE account_scope = ?1 AND organization_id = ?2 \
                         AND id = ?3 AND generation = ?4\
                   )",
                params![
                    claimed.fence.account_scope,
                    claimed.fence.organization_id,
                    claimed.fence.thread_id,
                    claimed.fence.generation,
                    claimed.workflow_id,
                    claim_token,
                ],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        let Some((message_id, user_message_json, state)) = persisted else {
            tx.commit()?;
            return Ok(RtTurnBeginOutcome::Stale);
        };
        if state == "cancel_requested" {
            tx.commit()?;
            return Ok(RtTurnBeginOutcome::CancelRequested);
        }

        let user = rt_insert_canonical_queued_user(
            &tx,
            &claimed.fence.thread_id,
            &message_id,
            &user_message_json,
            &ts,
        )?;
        let status_changed = tx.execute(
            "UPDATE native_scoped_threads SET status = 'in_progress', updated_at = ?1 \
             WHERE id = ?2 AND organization_id = ?3 AND generation = ?4 \
               AND account_scope = ?5",
            params![
                ts,
                claimed.fence.thread_id,
                claimed.fence.organization_id,
                claimed.fence.generation,
                claimed.fence.account_scope,
            ],
        )?;
        if status_changed != 1 {
            return Ok(RtTurnBeginOutcome::Stale);
        }
        tx.commit()?;
        Ok(RtTurnBeginOutcome::Begun(user))
    }

    /// Durably checkpoints the CLI-owned conversation identity as soon as the
    /// harness reports it. The write is owned by the complete active-claim
    /// fence; a worker from a deleted generation or previous process cannot
    /// mutate the replacement row. Repeating the same pair is idempotent,
    /// while a different pair is corruption and fails closed.
    ///
    /// `false` means the active claim no longer exists. Callers must stop the
    /// harness rather than continue a generation whose continuation token
    /// cannot be made durable.
    pub fn rt_checkpoint_claimed_turn_session(
        &self,
        claimed: &RtTurnQueueItem,
        harness_id: &str,
        session_id: &str,
    ) -> DbResult<bool> {
        let claim_token = claimed.claim_token.as_deref().ok_or_else(|| {
            DbError::InvalidQueueData(format!(
                "workflow {} has no claim token",
                claimed.workflow_id
            ))
        })?;
        let harness_id = harness_id.trim();
        let session_id = session_id.trim();
        if harness_id.is_empty() || session_id.is_empty() {
            return Err(DbError::InvalidQueueData(
                "harness session checkpoint contains an empty value".to_string(),
            ));
        }

        let mut conn = self.lock();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let persisted: Option<(Option<String>, Option<String>, Option<String>)> = tx
            .query_row(
                "SELECT q.checkpoint_harness_id, q.checkpoint_session_id, t.harness_id \
                 FROM native_scoped_turn_queue q \
                 JOIN native_scoped_threads t \
                   ON t.account_scope = q.account_scope \
                  AND t.organization_id = q.organization_id \
                  AND t.id = q.thread_id \
                  AND t.generation = q.thread_generation \
                 WHERE q.account_scope = ?1 AND q.organization_id = ?2 \
                   AND q.thread_id = ?3 AND q.thread_generation = ?4 \
                   AND q.workflow_id = ?5 \
                   AND q.state IN ('running', 'cancel_requested') \
                   AND q.claim_token = ?6",
                params![
                    claimed.fence.account_scope,
                    claimed.fence.organization_id,
                    claimed.fence.thread_id,
                    claimed.fence.generation,
                    claimed.workflow_id,
                    claim_token,
                ],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        let Some((existing_harness_id, existing_session_id, pinned_harness_id)) = persisted else {
            tx.commit()?;
            return Ok(false);
        };
        if pinned_harness_id.as_deref().map(str::trim) != Some(harness_id) {
            return Err(DbError::InvalidQueueData(format!(
                "workflow {} cannot checkpoint harness {harness_id:?} against thread pin {:?}",
                claimed.workflow_id, pinned_harness_id
            )));
        }

        match validated_checkpoint_pair(
            existing_harness_id.as_deref(),
            existing_session_id.as_deref(),
        )? {
            Some((existing_harness_id, existing_session_id))
                if existing_harness_id == harness_id && existing_session_id == session_id =>
            {
                tx.commit()?;
                Ok(true)
            }
            Some((existing_harness_id, existing_session_id)) => {
                Err(DbError::InvalidQueueData(format!(
                    "workflow {} changed its harness session checkpoint from {existing_harness_id:?}/{existing_session_id:?} to {harness_id:?}/{session_id:?}",
                    claimed.workflow_id
                )))
            }
            None => {
                let changed = tx.execute(
                    "UPDATE native_scoped_turn_queue \
                     SET checkpoint_harness_id = ?1, checkpoint_session_id = ?2 \
                     WHERE account_scope = ?3 AND organization_id = ?4 AND thread_id = ?5 \
                       AND thread_generation = ?6 AND workflow_id = ?7 \
                       AND state IN ('running', 'cancel_requested') \
                       AND claim_token = ?8 \
                       AND checkpoint_harness_id IS NULL AND checkpoint_session_id IS NULL",
                    params![
                        harness_id,
                        session_id,
                        claimed.fence.account_scope,
                        claimed.fence.organization_id,
                        claimed.fence.thread_id,
                        claimed.fence.generation,
                        claimed.workflow_id,
                        claim_token,
                    ],
                )?;
                if changed != 1 {
                    return Err(DbError::InvalidQueueData(format!(
                        "could not checkpoint harness session for workflow {}",
                        claimed.workflow_id
                    )));
                }
                tx.commit()?;
                Ok(true)
            }
        }
    }

    /// Commits a claimed turn's entire terminal storage boundary atomically:
    /// exact-idempotent canonical queued-user insert, assistant insert,
    /// terminal thread status, and claimed queue-row deletion. Persisting the
    /// user here as well as at begin is required for cancellation that wins
    /// before begin: an accepted user turn must never disappear merely because
    /// its harness was never started. The queue row is the ownership fence, so
    /// neither a deleted/recreated thread generation nor an old worker claim
    /// can publish a terminal result.
    ///
    /// An identical pre-existing assistant is accepted. That is the recovery
    /// path for databases written by older app versions that committed the
    /// assistant before crashing prior to queue cleanup. A different message
    /// under the same id is an idempotency conflict, and the status + queue row
    /// remain untouched. Both `running` and `cancel_requested` are terminally
    /// owned by the same claim token; cancellation must not make the worker
    /// lose its ability to persist the terminal response.
    #[allow(clippy::too_many_arguments)]
    pub fn rt_finalize_claimed_turn(
        &self,
        claimed: &RtTurnQueueItem,
        assistant_parts: &Value,
        assistant_metadata: Option<&Value>,
        terminal_status: RtTurnTerminalStatus,
    ) -> DbResult<RtTurnTerminalOutcome> {
        let claim_token = claimed.claim_token.as_deref().ok_or_else(|| {
            DbError::InvalidQueueData(format!(
                "workflow {} has no claim token",
                claimed.workflow_id
            ))
        })?;
        self.rt_finalize_claimed_turn_inner(
            &claimed.fence,
            &claimed.workflow_id,
            claim_token,
            assistant_parts,
            assistant_metadata,
            terminal_status,
        )
    }

    /// Finalizes one malformed active recovery row without decoding the field
    /// that failed claim validation. The exact claim identity fences one
    /// atomic transition. If claim proved that the canonical user JSON and both
    /// global message reservations are safe, the accepted user and interrupted
    /// assistant are persisted in sequence before the row is removed. Invalid
    /// user payloads and reservation collisions instead close with no messages,
    /// preventing assistant-only or cross-thread transcripts.
    pub fn rt_finalize_malformed_orphan(
        &self,
        orphan: &RtMalformedOrphanedTurn,
        assistant_parts: &Value,
        assistant_metadata: Option<&Value>,
    ) -> DbResult<RtTurnTerminalOutcome> {
        let claim_token = orphan.claim_token.as_deref().ok_or_else(|| {
            DbError::InvalidQueueData(format!(
                "malformed workflow {} has no claim token",
                orphan.workflow_id
            ))
        })?;
        let ts = now_rfc3339();
        let mut conn = self.lock();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let claimed: Option<RtMalformedTerminalRow> = tx
            .query_row(
                "SELECT q.message_id, q.user_message_json, q.assistant_message_id, \
                        q.quarantine_preserve_user, q.checkpoint_harness_id, \
                        q.checkpoint_session_id \
                 FROM native_scoped_turn_queue q \
                 JOIN native_scoped_threads t \
                   ON t.account_scope = q.account_scope \
                  AND t.organization_id = q.organization_id \
                  AND t.id = q.thread_id \
                  AND t.generation = q.thread_generation \
                 WHERE q.account_scope = ?1 AND q.organization_id = ?2 \
                   AND q.thread_id = ?3 AND q.thread_generation = ?4 \
                   AND q.workflow_id = ?5 \
                   AND q.state IN ('running', 'cancel_requested') \
                   AND q.claim_token = ?6",
                params![
                    orphan.fence.account_scope,
                    orphan.fence.organization_id,
                    orphan.fence.thread_id,
                    orphan.fence.generation,
                    orphan.workflow_id,
                    claim_token,
                ],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get::<_, i64>(3)? != 0,
                        row.get(4)?,
                        row.get(5)?,
                    ))
                },
            )
            .optional()?;
        let Some((
            message_id,
            user_message_json,
            reserved_assistant_id,
            preserve_user,
            checkpoint_harness_id,
            checkpoint_session_id,
        )) = claimed
        else {
            tx.commit()?;
            return Ok(RtTurnTerminalOutcome::Stale);
        };
        let checkpoint_session = validated_checkpoint_pair(
            checkpoint_harness_id.as_deref(),
            checkpoint_session_id.as_deref(),
        )?;

        let assistant = if preserve_user {
            if orphan.canonical_user.is_none() {
                return Err(DbError::InvalidQueueData(format!(
                    "malformed workflow {} lost its validated canonical user",
                    orphan.workflow_id
                )));
            }
            let canonical_user = rt_insert_canonical_queued_user(
                &tx,
                &orphan.fence.thread_id,
                &message_id,
                &user_message_json,
                &ts,
            )?;
            let assistant_id = reserved_assistant_id
                .unwrap_or_else(|| legacy_native_assistant_message_id(&message_id));
            let assistant_parts =
                assistant_parts_with_checkpoint(assistant_parts, checkpoint_session.as_ref())?;
            let assistant = rt_insert_exact_message(
                &tx,
                &orphan.fence.thread_id,
                &assistant_id,
                "assistant",
                &assistant_parts,
                assistant_metadata,
                &ts,
            )?;
            if canonical_user.seq >= assistant.seq {
                return Err(DbError::InvalidQueueData(format!(
                    "workflow {} has assistant sequence {} before canonical user sequence {}",
                    orphan.workflow_id, assistant.seq, canonical_user.seq
                )));
            }
            Some(assistant)
        } else {
            None
        };

        let status_changed = tx.execute(
            "UPDATE native_scoped_threads SET status = 'failed', updated_at = ?1 \
             WHERE id = ?2 AND organization_id = ?3 AND generation = ?4 \
               AND account_scope = ?5",
            params![
                ts,
                orphan.fence.thread_id,
                orphan.fence.organization_id,
                orphan.fence.generation,
                orphan.fence.account_scope,
            ],
        )?;
        let deleted = tx.execute(
            "DELETE FROM native_scoped_turn_queue \
             WHERE account_scope = ?1 AND organization_id = ?2 AND thread_id = ?3 \
               AND thread_generation = ?4 AND workflow_id = ?5 \
               AND state IN ('running', 'cancel_requested') AND claim_token = ?6",
            params![
                orphan.fence.account_scope,
                orphan.fence.organization_id,
                orphan.fence.thread_id,
                orphan.fence.generation,
                orphan.workflow_id,
                claim_token,
            ],
        )?;
        if status_changed != 1 || deleted != 1 {
            return Err(DbError::InvalidQueueData(format!(
                "could not quarantine malformed workflow {}",
                orphan.workflow_id
            )));
        }
        tx.commit()?;
        Ok(match assistant {
            Some(assistant) => RtTurnTerminalOutcome::Completed(assistant),
            None => RtTurnTerminalOutcome::Quarantined,
        })
    }

    #[allow(clippy::too_many_arguments)]
    fn rt_finalize_claimed_turn_inner(
        &self,
        fence: &RtThreadFence,
        workflow_id: &str,
        claim_token: &str,
        assistant_parts: &Value,
        assistant_metadata: Option<&Value>,
        terminal_status: RtTurnTerminalStatus,
    ) -> DbResult<RtTurnTerminalOutcome> {
        let ts = now_rfc3339();
        let mut conn = self.lock();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;

        let claimed_user: Option<RtClaimedTerminalRow> = tx
            .query_row(
                "SELECT q.message_id, q.user_message_json, q.assistant_message_id, \
                        q.checkpoint_harness_id, q.checkpoint_session_id \
                 FROM native_scoped_turn_queue q \
                JOIN native_scoped_threads t \
                  ON t.account_scope = q.account_scope \
                 AND t.organization_id = q.organization_id \
                 AND t.id = q.thread_id \
                 AND t.generation = q.thread_generation \
                WHERE q.account_scope = ?1 AND q.organization_id = ?2 \
                  AND q.thread_id = ?3 AND q.thread_generation = ?4 \
                  AND q.workflow_id = ?5 \
                  AND q.state IN ('running', 'cancel_requested') \
                  AND q.claim_token = ?6",
                params![
                    fence.account_scope,
                    fence.organization_id,
                    fence.thread_id,
                    fence.generation,
                    workflow_id,
                    claim_token,
                ],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .optional()?;
        let Some((
            message_id,
            user_message_json,
            reserved_assistant_id,
            checkpoint_harness_id,
            checkpoint_session_id,
        )) = claimed_user
        else {
            tx.commit()?;
            return Ok(RtTurnTerminalOutcome::Stale);
        };
        let checkpoint_session = validated_checkpoint_pair(
            checkpoint_harness_id.as_deref(),
            checkpoint_session_id.as_deref(),
        )?;
        let assistant_id = reserved_assistant_id
            .unwrap_or_else(|| legacy_native_assistant_message_id(&message_id));

        let canonical_user = rt_insert_canonical_queued_user(
            &tx,
            &fence.thread_id,
            &message_id,
            &user_message_json,
            &ts,
        )?;

        let assistant_parts =
            assistant_parts_with_checkpoint(assistant_parts, checkpoint_session.as_ref())?;
        let assistant = rt_insert_exact_message(
            &tx,
            &fence.thread_id,
            &assistant_id,
            "assistant",
            &assistant_parts,
            assistant_metadata,
            &ts,
        )?;
        if canonical_user.seq >= assistant.seq {
            return Err(DbError::InvalidQueueData(format!(
                "workflow {workflow_id} has assistant sequence {} before canonical user sequence {}",
                assistant.seq, canonical_user.seq
            )));
        }

        let status_changed = tx.execute(
            "UPDATE native_scoped_threads SET status = ?1, updated_at = ?2 \
             WHERE id = ?3 AND organization_id = ?4 AND generation = ?5 \
               AND account_scope = ?6",
            params![
                terminal_status.as_str(),
                ts,
                fence.thread_id,
                fence.organization_id,
                fence.generation,
                fence.account_scope,
            ],
        )?;
        if status_changed != 1 {
            return Ok(RtTurnTerminalOutcome::Stale);
        }

        let deleted = tx.execute(
            "DELETE FROM native_scoped_turn_queue \
             WHERE account_scope = ?1 AND organization_id = ?2 AND thread_id = ?3 \
               AND thread_generation = ?4 AND workflow_id = ?5 \
               AND state IN ('running', 'cancel_requested') AND claim_token = ?6",
            params![
                fence.account_scope,
                fence.organization_id,
                fence.thread_id,
                fence.generation,
                workflow_id,
                claim_token,
            ],
        )?;
        if deleted != 1 {
            return Ok(RtTurnTerminalOutcome::Stale);
        }

        tx.commit()?;
        Ok(RtTurnTerminalOutcome::Completed(assistant))
    }

    pub fn rt_cancel_turn_scoped(
        &self,
        scope: &RtAccountScope,
        organization_id: &str,
        thread_id: &str,
        workflow_id: &str,
    ) -> DbResult<RtTurnCancelOutcome> {
        self.adopt_legacy_account_rows(scope, organization_id)?;
        let account_scope = scope.storage_key();
        let mut conn = self.lock();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let Some(fence) =
            rt_thread_fence_by_id_in_scope(&tx, &account_scope, organization_id, thread_id)?
        else {
            tx.commit()?;
            return Ok(RtTurnCancelOutcome::NotFound);
        };
        let Some(mut item) = rt_turn_queue_by_workflow(&tx, &fence, workflow_id)? else {
            tx.commit()?;
            return Ok(RtTurnCancelOutcome::NotFound);
        };
        match item.state {
            RtTurnQueueState::Queued => {
                tx.execute(
                    "DELETE FROM native_scoped_turn_queue \
                     WHERE account_scope = ?1 AND organization_id = ?2 AND thread_id = ?3 \
                       AND thread_generation = ?4 AND workflow_id = ?5 AND state = 'queued'",
                    params![
                        fence.account_scope,
                        fence.organization_id,
                        fence.thread_id,
                        fence.generation,
                        workflow_id,
                    ],
                )?;
                tx.commit()?;
                Ok(RtTurnCancelOutcome::QueuedDeleted(item))
            }
            RtTurnQueueState::Running | RtTurnQueueState::CancelRequested => {
                tx.execute(
                    "UPDATE native_scoped_turn_queue SET state = 'cancel_requested' \
                     WHERE account_scope = ?1 AND organization_id = ?2 AND thread_id = ?3 \
                       AND thread_generation = ?4 AND workflow_id = ?5 \
                       AND state IN ('running', 'cancel_requested')",
                    params![
                        fence.account_scope,
                        fence.organization_id,
                        fence.thread_id,
                        fence.generation,
                        workflow_id,
                    ],
                )?;
                item.state = RtTurnQueueState::CancelRequested;
                tx.commit()?;
                Ok(RtTurnCancelOutcome::ActiveCancelRequested(item))
            }
        }
    }

    #[cfg(test)]
    pub fn rt_cancel_turn_in_org(
        &self,
        organization_id: &str,
        thread_id: &str,
        workflow_id: &str,
    ) -> DbResult<RtTurnCancelOutcome> {
        self.rt_cancel_turn_scoped(
            &RtAccountScope::test_default(),
            organization_id,
            thread_id,
            workflow_id,
        )
    }

    /// Prevents any queued tail from being promoted while lifecycle deletion
    /// or shutdown requests cancellation of the active harness.
    pub fn rt_cancel_all_turns_in_org(
        &self,
        fence: &RtThreadFence,
    ) -> DbResult<RtCancelAllTurnsOutcome> {
        let mut conn = self.lock();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        // Lifecycle deletion needs only durable identities. Do not parse the
        // queued JSON here: one malformed accepted tail must not prevent a
        // safe close, and every queued row remains until the final FK cascade.
        let mut stmt = tx.prepare(
            "SELECT workflow_id, state FROM native_scoped_turn_queue \
             WHERE account_scope = ?1 AND organization_id = ?2 AND thread_id = ?3 \
               AND thread_generation = ?4 \
             ORDER BY fifo_ordinal ASC",
        )?;
        let rows = stmt.query_map(
            params![
                fence.account_scope,
                fence.organization_id,
                fence.thread_id,
                fence.generation,
            ],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )?;
        let mut queued_retained_workflow_ids = Vec::new();
        let mut active_workflow_ids = Vec::new();
        for row in rows {
            let (workflow_id, state) = row?;
            match state.as_str() {
                "queued" => queued_retained_workflow_ids.push(workflow_id),
                "running" | "cancel_requested" => active_workflow_ids.push(workflow_id),
                _ => {}
            }
        }
        drop(stmt);
        tx.execute(
            "UPDATE native_scoped_turn_queue SET state = 'cancel_requested' \
             WHERE account_scope = ?1 AND organization_id = ?2 AND thread_id = ?3 \
               AND thread_generation = ?4 AND state = 'running'",
            params![
                fence.account_scope,
                fence.organization_id,
                fence.thread_id,
                fence.generation,
            ],
        )?;
        tx.commit()?;
        Ok(RtCancelAllTurnsOutcome {
            queued_retained_workflow_ids,
            active_workflow_ids,
        })
    }

    /// Recovery scan that isolates malformed active rows instead of failing on
    /// the first corrupt JSON payload. Use
    /// [`Self::rt_finalize_malformed_orphan`] for each `Malformed` item; healthy
    /// `Ready` items retain the ordinary exact recovery path.
    pub fn rt_list_orphaned_active_turns_scoped(
        &self,
        scope: &RtAccountScope,
    ) -> DbResult<Vec<RtOrphanedTurn>> {
        self.prepare_account_scope(scope)?;
        let account_scope = scope.storage_key();
        let mut conn = self.lock();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut stmt = tx.prepare(&format!(
            "SELECT {RT_TURN_QUEUE_COLUMNS} FROM native_scoped_turn_queue \
             WHERE account_scope = ?1 AND state IN ('running', 'cancel_requested') \
             ORDER BY enqueued_at ASC, organization_id ASC, thread_id ASC, fifo_ordinal ASC"
        ))?;
        let rows = stmt
            .query_map(params![account_scope], row_to_raw_rt_turn_queue)?
            .collect::<Result<Vec<_>, _>>()?;
        drop(stmt);
        let mut items = Vec::new();
        for mut raw in rows {
            if raw.quarantine_reason.is_some() {
                let error = match parse_raw_rt_turn_queue(raw.clone()) {
                    Err(error) => error,
                    Ok(_) => DbError::InvalidQueueData(format!(
                        "workflow {} has an ineffective persisted quarantine",
                        raw.workflow_id
                    )),
                };
                items.push(RtOrphanedTurn::Malformed(raw.malformed_orphan(error)));
                continue;
            }

            let parsed = parse_raw_rt_turn_queue(raw.clone());
            let canonical_user =
                parse_canonical_queued_user(&raw.message_id, &raw.user_message_json);
            let assistant_id = raw
                .assistant_message_id
                .clone()
                .unwrap_or_else(|| legacy_native_assistant_message_id(&raw.message_id));
            let reservation_state = validate_raw_turn_reservations(
                &tx,
                &raw,
                &assistant_id,
                canonical_user.as_ref().ok(),
            )?;
            let (error, preserve_canonical_user) = match reservation_state {
                RawTurnReservationState::Quarantine(error) => (Some(error), false),
                RawTurnReservationState::Completed => {
                    adopt_completed_raw_turn(&tx, &raw)?;
                    continue;
                }
                RawTurnReservationState::Safe => match parsed.as_ref() {
                    Ok(_) => (None, false),
                    Err(error) => (
                        Some(DbError::InvalidQueueData(error.to_string())),
                        canonical_user.is_ok(),
                    ),
                },
            };
            if let Some(error) = error {
                let reason = error.to_string();
                let changed = tx.execute(
                    "UPDATE native_scoped_turn_queue SET quarantine_reason = ?1, \
                         quarantine_preserve_user = ?2 \
                     WHERE account_scope = ?3 AND organization_id = ?4 AND thread_id = ?5 \
                       AND thread_generation = ?6 AND workflow_id = ?7 \
                       AND state IN ('running', 'cancel_requested') AND claim_token IS ?8",
                    params![
                        reason,
                        preserve_canonical_user,
                        raw.account_scope,
                        raw.organization_id,
                        raw.thread_id,
                        raw.thread_generation,
                        raw.workflow_id,
                        raw.claim_token,
                    ],
                )?;
                if changed != 1 {
                    return Err(DbError::InvalidQueueData(format!(
                        "could not persist recovery quarantine for workflow {}",
                        raw.workflow_id
                    )));
                }
                raw.quarantine_reason = Some(reason);
                raw.quarantine_preserve_user = preserve_canonical_user;
                items.push(RtOrphanedTurn::Malformed(raw.malformed_orphan(error)));
            } else if let Ok(item) = parsed {
                items.push(RtOrphanedTurn::Ready(item));
            }
        }
        tx.commit()?;
        Ok(items)
    }

    #[cfg(test)]
    pub fn rt_list_orphaned_active_turns_isolated(&self) -> DbResult<Vec<RtOrphanedTurn>> {
        self.rt_list_orphaned_active_turns_scoped(&RtAccountScope::test_default())
    }

    /// Enumerates thread incarnations with untouched queued work. The first
    /// item of each may be claimed after any orphan active row for that thread
    /// has been finalized.
    pub fn rt_list_recoverable_turn_queues_scoped(
        &self,
        scope: &RtAccountScope,
    ) -> DbResult<Vec<RtThreadFence>> {
        self.prepare_account_scope(scope)?;
        let account_scope = scope.storage_key();
        let conn = self.lock();
        let mut stmt = conn.prepare(
            "SELECT q.account_scope, q.organization_id, q.thread_id, q.thread_generation \
             FROM native_scoped_turn_queue q \
             JOIN native_scoped_threads t \
               ON t.account_scope = q.account_scope \
              AND t.organization_id = q.organization_id \
              AND t.id = q.thread_id \
              AND t.generation = q.thread_generation \
             WHERE q.account_scope = ?1 AND q.state = 'queued' AND t.delete_pending = 0 \
             GROUP BY q.account_scope, q.organization_id, q.thread_id, q.thread_generation \
             ORDER BY MIN(q.enqueued_at) ASC, q.organization_id ASC, q.thread_id ASC, \
                      q.thread_generation ASC",
        )?;
        let rows = stmt.query_map(params![account_scope], |row| {
            Ok(RtThreadFence {
                account_scope: row.get(0)?,
                organization_id: row.get(1)?,
                thread_id: row.get(2)?,
                generation: row.get(3)?,
            })
        })?;
        let mut fences = Vec::new();
        for row in rows {
            fences.push(row?);
        }
        Ok(fences)
    }

    #[cfg(test)]
    pub fn rt_list_recoverable_turn_queues(&self) -> DbResult<Vec<RtThreadFence>> {
        self.rt_list_recoverable_turn_queues_scoped(&RtAccountScope::test_default())
    }
}

const RT_THREAD_COLUMNS: &str = "id, organization_id, title, description, hidden, status, \
     created_by, updated_by, virtual_mcp_id, trigger_id, branch, sandbox_provider_kind, \
     harness_id, metadata, run_config, created_at, updated_at, updated_by_explicit";

fn parse_stored_json(raw: String, column: usize) -> rusqlite::Result<Value> {
    serde_json::from_str(&raw).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            column,
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    })
}

fn parse_optional_stored_json(
    raw: Option<String>,
    column: usize,
) -> rusqlite::Result<Option<Value>> {
    raw.map(|raw| parse_stored_json(raw, column)).transpose()
}

fn row_to_rt_thread(row: &rusqlite::Row) -> rusqlite::Result<RtThread> {
    let metadata_raw: Option<String> = row.get(13)?;
    let run_config_raw: Option<String> = row.get(14)?;
    let updated_by_raw: String = row.get(7)?;
    let updated_by_explicit = row.get::<_, i64>(17)? != 0;
    Ok(RtThread {
        id: row.get(0)?,
        organization_id: row.get(1)?,
        title: row.get(2)?,
        description: row.get(3)?,
        hidden: row.get::<_, i64>(4)? != 0,
        status: row.get(5)?,
        created_by: row.get(6)?,
        updated_by: updated_by_explicit.then_some(updated_by_raw),
        virtual_mcp_id: row.get(8)?,
        trigger_id: row.get(9)?,
        branch: row.get(10)?,
        sandbox_provider_kind: row.get(11)?,
        harness_id: row.get(12)?,
        metadata: parse_optional_stored_json(metadata_raw, 13)?,
        run_config: parse_optional_stored_json(run_config_raw, 14)?,
        created_at: row.get(15)?,
        updated_at: row.get(16)?,
    })
}

fn row_to_rt_message(row: &rusqlite::Row) -> rusqlite::Result<RtMessage> {
    let parts_raw: String = row.get(3)?;
    let metadata_raw: Option<String> = row.get(4)?;
    Ok(RtMessage {
        id: row.get(0)?,
        thread_id: row.get(1)?,
        role: row.get(2)?,
        parts: parse_stored_json(parts_raw, 3)?,
        metadata: parse_optional_stored_json(metadata_raw, 4)?,
        // Column 7: durable `seq` (appended last by message SELECTs).
        seq: row.get(7)?,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
    })
}

/// Decodes and exact-inserts the canonical user message stored in a durable
/// queue row. Both begin and terminal completion use this helper so the
/// cancellation-before-begin path cannot silently omit the accepted user.
fn rt_insert_canonical_queued_user(
    tx: &rusqlite::Transaction<'_>,
    thread_id: &str,
    message_id: &str,
    user_message_json: &str,
    timestamp: &str,
) -> DbResult<RtMessage> {
    let user_message = parse_canonical_queued_user(message_id, user_message_json)?;
    let user_parts = user_message
        .get("parts")
        .cloned()
        .unwrap_or_else(|| Value::Array(Vec::new()));
    rt_insert_exact_message(
        tx,
        thread_id,
        message_id,
        "user",
        &user_parts,
        user_message.get("metadata"),
        timestamp,
    )
}

fn assistant_parts_with_checkpoint(
    assistant_parts: &Value,
    checkpoint: Option<&(String, String)>,
) -> DbResult<Value> {
    let Some((checkpoint_harness_id, checkpoint_session_id)) = checkpoint else {
        return Ok(assistant_parts.clone());
    };
    let mut parts = assistant_parts.as_array().cloned().ok_or_else(|| {
        DbError::InvalidQueueData(
            "assistant parts must be an array when a harness session is checkpointed".to_string(),
        )
    })?;
    let mut matching_checkpoint_found = false;
    for part in &parts {
        if part.get("type").and_then(Value::as_str) != Some("data-harness-session") {
            continue;
        }
        let persisted = validated_checkpoint_pair(
            part.get("harnessId").and_then(Value::as_str),
            part.get("sessionId").and_then(Value::as_str),
        )?
        .ok_or_else(|| {
            DbError::InvalidQueueData(
                "assistant harness session part does not contain a session pair".to_string(),
            )
        })?;
        if persisted.0 != *checkpoint_harness_id || persisted.1 != *checkpoint_session_id {
            return Err(DbError::InvalidQueueData(
                "assistant harness session conflicts with the durable queue checkpoint".to_string(),
            ));
        }
        matching_checkpoint_found = true;
    }
    if !matching_checkpoint_found {
        parts.push(serde_json::json!({
            "type": "data-harness-session",
            "harnessId": checkpoint_harness_id,
            "sessionId": checkpoint_session_id,
        }));
    }
    Ok(Value::Array(parts))
}

/// Inserts a message inside a caller-owned transaction, or validates that an
/// existing row under the deterministic id is semantically identical. Unlike
/// the general read mapper above, this parses persisted JSON strictly: corrupt
/// storage must abort a begin/terminal transaction, never masquerade as
/// `null`/missing metadata and get accepted as an idempotent match.
#[allow(clippy::too_many_arguments)]
fn rt_insert_exact_message(
    tx: &rusqlite::Transaction<'_>,
    thread_id: &str,
    id: &str,
    role: &str,
    parts: &Value,
    metadata: Option<&Value>,
    timestamp: &str,
) -> DbResult<RtMessage> {
    let parts_json = serde_json::to_string(parts)?;
    let metadata_json = metadata.map(serde_json::to_string).transpose()?;
    let inserted = tx.execute(
        "INSERT OR IGNORE INTO native_scoped_messages \
         (id, thread_id, role, parts, metadata, seq, created_at, updated_at) \
         VALUES (\
             ?1, ?2, ?3, ?4, ?5, \
             (SELECT COALESCE(MAX(seq), 0) + 1 FROM native_scoped_messages WHERE thread_id = ?2), \
             ?6, ?6\
         )",
        params![id, thread_id, role, parts_json, metadata_json, timestamp],
    )?;
    let (
        persisted_id,
        persisted_thread_id,
        persisted_role,
        persisted_parts_json,
        persisted_metadata_json,
        persisted_created_at,
        persisted_updated_at,
        persisted_seq,
    ): (
        String,
        String,
        String,
        String,
        Option<String>,
        String,
        String,
        i64,
    ) = tx.query_row(
        "SELECT id, thread_id, role, parts, metadata, created_at, updated_at, seq \
         FROM native_scoped_messages WHERE id = ?1",
        params![id],
        |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
                row.get(6)?,
                row.get(7)?,
            ))
        },
    )?;
    let message = RtMessage {
        id: persisted_id,
        thread_id: persisted_thread_id,
        role: persisted_role,
        parts: serde_json::from_str(&persisted_parts_json)?,
        metadata: persisted_metadata_json
            .as_deref()
            .map(serde_json::from_str)
            .transpose()?,
        seq: persisted_seq,
        created_at: persisted_created_at,
        updated_at: persisted_updated_at,
    };
    if inserted == 0
        && (message.thread_id != thread_id
            || message.role != role
            || message.parts != *parts
            || message.metadata.as_ref() != metadata)
    {
        return Err(DbError::IdempotencyConflict {
            entity: "rt_message",
            id: id.to_string(),
        });
    }
    Ok(message)
}

fn rt_message_by_id(conn: &Connection, id: &str) -> DbResult<Option<RtMessage>> {
    conn.query_row(
        "SELECT id, thread_id, role, parts, metadata, created_at, updated_at, seq \
         FROM native_scoped_messages WHERE id = ?1",
        params![id],
        row_to_rt_message,
    )
    .optional()
    .map_err(DbError::from)
}

#[cfg(test)]
fn rt_thread_by_id(conn: &Connection, id: &str) -> DbResult<Option<RtThread>> {
    conn.query_row(
        &format!("SELECT {RT_THREAD_COLUMNS} FROM native_scoped_threads WHERE id = ?1"),
        params![id],
        row_to_rt_thread,
    )
    .optional()
    .map_err(DbError::from)
}

fn rt_thread_is_tombstoned(
    conn: &Connection,
    account_scope: &str,
    organization_id: &str,
    id: &str,
) -> DbResult<bool> {
    conn.query_row(
        "SELECT EXISTS(\
             SELECT 1 FROM native_scoped_thread_tombstones \
             WHERE account_scope = ?1 AND organization_id = ?2 AND thread_id = ?3\
         )",
        params![account_scope, organization_id, id],
        |row| row.get(0),
    )
    .map_err(DbError::from)
}

fn rt_thread_by_id_in_scope(
    conn: &Connection,
    account_scope: &str,
    organization_id: &str,
    id: &str,
) -> DbResult<Option<RtThread>> {
    conn.query_row(
        &format!(
            "SELECT {RT_THREAD_COLUMNS} FROM native_scoped_threads \
             WHERE id = ?1 AND organization_id = ?2 AND account_scope = ?3"
        ),
        params![id, organization_id, account_scope],
        row_to_rt_thread,
    )
    .optional()
    .map_err(DbError::from)
}

fn rt_thread_fence_by_id_in_scope(
    conn: &Connection,
    account_scope: &str,
    organization_id: &str,
    id: &str,
) -> DbResult<Option<RtThreadFence>> {
    conn.query_row(
        "SELECT account_scope, organization_id, id, generation FROM native_scoped_threads \
         WHERE id = ?1 AND organization_id = ?2 AND account_scope = ?3",
        params![id, organization_id, account_scope],
        |row| {
            Ok(RtThreadFence {
                account_scope: row.get(0)?,
                organization_id: row.get(1)?,
                thread_id: row.get(2)?,
                generation: row.get(3)?,
            })
        },
    )
    .optional()
    .map_err(DbError::from)
}

const RT_TURN_QUEUE_COLUMNS: &str =
    "account_scope, organization_id, thread_id, thread_generation, \
     message_id, assistant_message_id, workflow_id, task_id, normalized_input_json, \
     user_message_json, enqueued_at, fifo_ordinal, state, claim_token, quarantine_reason, \
     quarantine_preserve_user, checkpoint_harness_id, checkpoint_session_id";

#[derive(Clone)]
struct RawRtTurnQueueItem {
    account_scope: String,
    organization_id: String,
    thread_id: String,
    thread_generation: String,
    message_id: String,
    assistant_message_id: Option<String>,
    workflow_id: String,
    task_id: String,
    normalized_input_json: String,
    user_message_json: String,
    enqueued_at: i64,
    fifo_ordinal: i64,
    state: String,
    claim_token: Option<String>,
    quarantine_reason: Option<String>,
    quarantine_preserve_user: bool,
    checkpoint_harness_id: Option<String>,
    checkpoint_session_id: Option<String>,
}

impl RawRtTurnQueueItem {
    fn malformed_orphan(self, error: DbError) -> RtMalformedOrphanedTurn {
        let canonical_user = self
            .quarantine_preserve_user
            .then(|| parse_canonical_queued_user(&self.message_id, &self.user_message_json))
            .and_then(Result::ok);
        RtMalformedOrphanedTurn {
            fence: RtThreadFence {
                account_scope: self.account_scope,
                organization_id: self.organization_id,
                thread_id: self.thread_id,
                generation: self.thread_generation,
            },
            message_id: self.message_id,
            assistant_message_id: self.assistant_message_id,
            workflow_id: self.workflow_id,
            claim_token: self.claim_token,
            canonical_user,
            error: error.to_string(),
        }
    }
}

fn row_to_raw_rt_turn_queue(row: &rusqlite::Row) -> rusqlite::Result<RawRtTurnQueueItem> {
    Ok(RawRtTurnQueueItem {
        account_scope: row.get(0)?,
        organization_id: row.get(1)?,
        thread_id: row.get(2)?,
        thread_generation: row.get(3)?,
        message_id: row.get(4)?,
        assistant_message_id: row.get(5)?,
        workflow_id: row.get(6)?,
        task_id: row.get(7)?,
        normalized_input_json: row.get(8)?,
        user_message_json: row.get(9)?,
        enqueued_at: row.get(10)?,
        fifo_ordinal: row.get(11)?,
        state: row.get(12)?,
        claim_token: row.get(13)?,
        quarantine_reason: row.get(14)?,
        quarantine_preserve_user: row.get::<_, i64>(15)? != 0,
        checkpoint_harness_id: row.get(16)?,
        checkpoint_session_id: row.get(17)?,
    })
}

fn validated_checkpoint_pair(
    harness_id: Option<&str>,
    session_id: Option<&str>,
) -> DbResult<Option<(String, String)>> {
    match (harness_id, session_id) {
        (None, None) => Ok(None),
        (Some(harness_id), Some(session_id)) => {
            let harness_id = harness_id.trim();
            let session_id = session_id.trim();
            if harness_id.is_empty() || session_id.is_empty() {
                return Err(DbError::InvalidQueueData(
                    "harness session checkpoint contains an empty value".to_string(),
                ));
            }
            Ok(Some((harness_id.to_string(), session_id.to_string())))
        }
        _ => Err(DbError::InvalidQueueData(
            "harness session checkpoint is not a complete pair".to_string(),
        )),
    }
}

fn parse_canonical_queued_user(message_id: &str, user_message_json: &str) -> DbResult<Value> {
    let user_message: Value = serde_json::from_str(user_message_json)?;
    if user_message.get("id").and_then(Value::as_str) != Some(message_id)
        || user_message.get("role").and_then(Value::as_str) != Some("user")
    {
        return Err(DbError::InvalidQueueData(format!(
            "queue message {message_id} has an invalid durable user message"
        )));
    }
    Ok(user_message)
}

enum RawTurnReservationState {
    Safe,
    Completed,
    Quarantine(DbError),
}

/// A durable pair is complete only when both identities belong to this thread,
/// carry their canonical roles, and the user was allocated before its reply.
/// Enqueue retry, claim, and recovery must share this predicate: weakening any
/// one path could adopt a reversed transcript and suppress the harness without
/// ever repairing message order.
fn is_exact_completed_turn_pair(
    user: Option<&RtMessage>,
    assistant: &RtMessage,
    thread_id: &str,
) -> bool {
    user.is_some_and(|user| {
        user.thread_id == thread_id
            && user.role == "user"
            && assistant.thread_id == thread_id
            && assistant.role == "assistant"
            && user.seq < assistant.seq
    })
}

fn validate_raw_turn_reservations(
    conn: &Connection,
    raw: &RawRtTurnQueueItem,
    candidate_assistant_id: &str,
    canonical_user: Option<&Value>,
) -> DbResult<RawTurnReservationState> {
    let fence = RtThreadFence {
        account_scope: raw.account_scope.clone(),
        organization_id: raw.organization_id.clone(),
        thread_id: raw.thread_id.clone(),
        generation: raw.thread_generation.clone(),
    };
    let expected_v1 = native_assistant_message_id(&fence, &raw.message_id);
    let expected_legacy = legacy_native_assistant_message_id(&raw.message_id);
    if candidate_assistant_id != expected_v1 && candidate_assistant_id != expected_legacy {
        return Ok(RawTurnReservationState::Quarantine(
            DbError::InvalidQueueData(format!(
                "workflow {} has an invalid assistant reservation",
                raw.workflow_id
            )),
        ));
    }
    let reservation_winner: (String, String, String, String, String) = conn.query_row(
        "SELECT account_scope, organization_id, thread_id, thread_generation, workflow_id \
         FROM native_scoped_turn_queue \
         WHERE message_id IN (?1, ?2) \
            OR COALESCE(assistant_message_id, 'msg-' || message_id || '-assistant') \
               IN (?1, ?2) \
         ORDER BY enqueued_at ASC, account_scope ASC, organization_id ASC, thread_id ASC, \
                  thread_generation ASC, fifo_ordinal ASC, workflow_id ASC \
         LIMIT 1",
        params![raw.message_id, candidate_assistant_id],
        |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
            ))
        },
    )?;
    if reservation_winner
        != (
            raw.account_scope.clone(),
            raw.organization_id.clone(),
            raw.thread_id.clone(),
            raw.thread_generation.clone(),
            raw.workflow_id.clone(),
        )
    {
        return Ok(RawTurnReservationState::Quarantine(
            DbError::InvalidQueueData(format!(
                "workflow {} loses a pre-v8 global message-id reservation collision",
                raw.workflow_id
            )),
        ));
    }

    let Some(user_message) = canonical_user else {
        return Ok(RawTurnReservationState::Safe);
    };
    let user_parts = user_message
        .get("parts")
        .cloned()
        .unwrap_or_else(|| Value::Array(Vec::new()));
    let user_metadata = user_message.get("metadata");
    let exact_persisted_user = match rt_message_by_id(conn, &raw.message_id)? {
        Some(user)
            if user.thread_id == raw.thread_id
                && user.role == "user"
                && user.parts == user_parts
                && user.metadata.as_ref() == user_metadata =>
        {
            Some(user)
        }
        Some(_) => {
            return Ok(RawTurnReservationState::Quarantine(
                DbError::InvalidQueueData(format!(
                    "workflow {} collides with a persisted global user message id",
                    raw.workflow_id
                )),
            ));
        }
        None => None,
    };
    match rt_message_by_id(conn, candidate_assistant_id)? {
        Some(assistant)
            if is_exact_completed_turn_pair(
                exact_persisted_user.as_ref(),
                &assistant,
                &raw.thread_id,
            ) =>
        {
            Ok(RawTurnReservationState::Completed)
        }
        Some(assistant)
            if assistant.thread_id == raw.thread_id
                && assistant.role == "assistant"
                && exact_persisted_user.is_some() =>
        {
            Ok(RawTurnReservationState::Quarantine(
                DbError::InvalidQueueData(format!(
                    "workflow {} has a persisted assistant before its exact user",
                    raw.workflow_id
                )),
            ))
        }
        Some(_) if exact_persisted_user.is_none() => Ok(RawTurnReservationState::Quarantine(
            DbError::InvalidQueueData(format!(
                "workflow {} has a persisted assistant without its exact user",
                raw.workflow_id
            )),
        )),
        Some(_) => Ok(RawTurnReservationState::Quarantine(
            DbError::InvalidQueueData(format!(
                "workflow {} collides with a persisted global assistant message id",
                raw.workflow_id
            )),
        )),
        None => Ok(RawTurnReservationState::Safe),
    }
}

fn adopt_completed_raw_turn(
    tx: &rusqlite::Transaction<'_>,
    raw: &RawRtTurnQueueItem,
) -> DbResult<()> {
    let ts = now_rfc3339();
    let status_changed = tx.execute(
        "UPDATE native_scoped_threads SET \
             status = CASE \
                 WHEN status IN ('completed', 'requires_action', 'failed') THEN status \
                 ELSE 'failed' \
             END, \
             updated_at = ?1 \
         WHERE account_scope = ?2 AND organization_id = ?3 AND id = ?4 \
           AND generation = ?5",
        params![
            ts,
            raw.account_scope,
            raw.organization_id,
            raw.thread_id,
            raw.thread_generation,
        ],
    )?;
    let deleted = tx.execute(
        "DELETE FROM native_scoped_turn_queue \
         WHERE account_scope = ?1 AND organization_id = ?2 AND thread_id = ?3 \
           AND thread_generation = ?4 AND workflow_id = ?5 \
           AND state IN ('running', 'cancel_requested') AND claim_token IS ?6",
        params![
            raw.account_scope,
            raw.organization_id,
            raw.thread_id,
            raw.thread_generation,
            raw.workflow_id,
            raw.claim_token,
        ],
    )?;
    if status_changed != 1 || deleted != 1 {
        return Err(DbError::InvalidQueueData(format!(
            "could not adopt completed workflow {}",
            raw.workflow_id
        )));
    }
    Ok(())
}

fn parse_raw_rt_turn_queue(raw: RawRtTurnQueueItem) -> DbResult<RtTurnQueueItem> {
    if let Some(reason) = &raw.quarantine_reason {
        return Err(DbError::InvalidQueueData(format!(
            "workflow {} was quarantined at claim: {reason}",
            raw.workflow_id
        )));
    }
    let enqueued_at = u64::try_from(raw.enqueued_at).map_err(|_| {
        DbError::InvalidQueueData(format!(
            "negative enqueued_at {} for workflow {}",
            raw.enqueued_at, raw.workflow_id
        ))
    })?;
    let state = RtTurnQueueState::parse(&raw.state)?;
    let normalized_input = serde_json::from_str(&raw.normalized_input_json)?;
    let user_message = parse_canonical_queued_user(&raw.message_id, &raw.user_message_json)?;
    let checkpoint_session = validated_checkpoint_pair(
        raw.checkpoint_harness_id.as_deref(),
        raw.checkpoint_session_id.as_deref(),
    )?;
    Ok(RtTurnQueueItem {
        fence: RtThreadFence {
            account_scope: raw.account_scope,
            organization_id: raw.organization_id,
            thread_id: raw.thread_id,
            generation: raw.thread_generation,
        },
        message_id: raw.message_id,
        assistant_message_id: raw.assistant_message_id,
        workflow_id: raw.workflow_id,
        task_id: raw.task_id,
        normalized_input,
        user_message,
        enqueued_at,
        fifo_ordinal: raw.fifo_ordinal,
        state,
        claim_token: raw.claim_token,
        checkpoint_session,
    })
}

fn rt_turn_queue_query<P: rusqlite::Params>(
    conn: &Connection,
    where_clause: &str,
    params: P,
) -> DbResult<Vec<RtTurnQueueItem>> {
    let sql = format!(
        "SELECT {RT_TURN_QUEUE_COLUMNS} FROM native_scoped_turn_queue \
         WHERE {where_clause} ORDER BY fifo_ordinal ASC"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params, row_to_raw_rt_turn_queue)?;
    let mut items = Vec::new();
    for row in rows {
        items.push(parse_raw_rt_turn_queue(row?)?);
    }
    Ok(items)
}

fn rt_turn_queue_by_workflow(
    conn: &Connection,
    fence: &RtThreadFence,
    workflow_id: &str,
) -> DbResult<Option<RtTurnQueueItem>> {
    let mut items = rt_turn_queue_query(
        conn,
        "account_scope = ?1 AND organization_id = ?2 AND thread_id = ?3 \
         AND thread_generation = ?4 AND workflow_id = ?5",
        params![
            fence.account_scope,
            fence.organization_id,
            fence.thread_id,
            fence.generation,
            workflow_id,
        ],
    )?;
    Ok(items.pop())
}

/// Escapes `%`/`_`/`\` for a `LIKE ... ESCAPE '\'` pattern — `search` is
/// caller/user-supplied free text, and without this a search containing a
/// literal `%` or `_` would silently behave as a wildcard instead of a
/// literal character match.
fn like_escape(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

#[cfg(test)]
mod tests {
    use super::*;

    type TableShapeRow = (i64, String, String, i64, Option<String>, i64);
    type ForeignKeyShapeRow = (i64, i64, String, String, String, String, String, String);

    fn local_db_path(app_root: &Path) -> PathBuf {
        app_root.join(crate::STUDIO_DB_FILE_NAME)
    }

    fn schema_version(path: &Path) -> u32 {
        let conn = Connection::open(path).unwrap();
        conn.pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap()
    }

    fn table_shape(conn: &Connection, table: &str) -> Vec<TableShapeRow> {
        let mut statement = conn
            .prepare(
                "SELECT cid, name, type, `notnull`, dflt_value, pk \
                 FROM pragma_table_info(?1) ORDER BY cid",
            )
            .unwrap();
        statement
            .query_map([table], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                ))
            })
            .unwrap()
            .map(Result::unwrap)
            .collect()
    }

    fn foreign_key_shape(conn: &Connection, table: &str) -> Vec<ForeignKeyShapeRow> {
        let mut statement = conn
            .prepare(
                "SELECT id, seq, `table`, `from`, `to`, on_update, on_delete, `match` \
                 FROM pragma_foreign_key_list(?1) ORDER BY id, seq",
            )
            .unwrap();
        statement
            .query_map([table], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                    row.get(7)?,
                ))
            })
            .unwrap()
            .map(Result::unwrap)
            .collect()
    }

    fn index_shape(conn: &Connection, table: &str) -> Vec<(String, i64, String, i64)> {
        let mut statement = conn
            .prepare(
                "SELECT name, `unique`, origin, partial \
                 FROM pragma_index_list(?1) ORDER BY name",
            )
            .unwrap();
        statement
            .query_map([table], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })
            .unwrap()
            .map(Result::unwrap)
            .collect()
    }

    fn create_rt_thread(db: &ThreadsDb, organization_id: &str, thread_id: &str) {
        db.rt_create_thread(
            Some(thread_id),
            organization_id,
            "",
            None,
            "vmcp",
            None,
            "user",
        )
        .unwrap();
    }

    fn turn_input(message_id: &str, text: &str, enqueued_at: u64) -> RtTurnEnqueueInput {
        RtTurnEnqueueInput {
            message_id: message_id.to_string(),
            workflow_id: format!("workflow-{message_id}"),
            task_id: "thread-task".to_string(),
            normalized_input: serde_json::json!({
                "harnessId": "claude-code",
                "messages": [{
                    "id": message_id,
                    "role": "user",
                    "parts": [{"type": "text", "text": text}],
                }],
            }),
            user_message: serde_json::json!({
                "id": message_id,
                "role": "user",
                "parts": [{"type": "text", "text": text}],
            }),
            enqueued_at,
        }
    }

    fn ready_claim(outcome: RtTurnClaimOutcome) -> RtTurnQueueItem {
        match outcome {
            RtTurnClaimOutcome::Ready(item) => item,
            RtTurnClaimOutcome::Malformed(item) => {
                panic!("expected healthy claim, got malformed: {item:?}")
            }
            RtTurnClaimOutcome::Completed { workflow_id } => {
                panic!("expected executable claim, got completed {workflow_id}")
            }
        }
    }

    fn claimed_assistant_id(item: &RtTurnQueueItem) -> String {
        item.assistant_message_id
            .clone()
            .unwrap_or_else(|| legacy_native_assistant_message_id(&item.message_id))
    }

    /// Creates the exact unversioned schema deployed before this migration
    /// runner, with timestamps deliberately opposed to insertion order.
    fn create_legacy_v0_fixture(app_root: &Path) {
        let dir = app_root.join(".decocms");
        fs::create_dir_all(&dir).unwrap();
        let conn = Connection::open(local_db_path(app_root)).unwrap();
        conn.pragma_update(None, "foreign_keys", 1).unwrap();
        conn.execute_batch(MIGRATIONS[0].sql).unwrap();
        conn.execute(
            "INSERT INTO threads (id, title, created_at, updated_at) \
             VALUES ('legacy-mini-thread', 'also kept', ?1, ?1)",
            ["2025-01-01T00:00:00.000Z"],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO rt_threads (\
                id, organization_id, title, hidden, status, created_by, updated_by, \
                virtual_mcp_id, created_at, updated_at\
             ) VALUES ('legacy-thread', 'org', 'kept', 0, 'idle', 'user', 'user', \
                       'vmcp', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO rt_messages (\
                id, thread_id, role, parts, metadata, created_at, updated_at\
             ) VALUES (?1, 'legacy-thread', ?2, ?3, ?4, ?5, ?5)",
            params![
                "legacy-user",
                "user",
                r#"[{"type":"text","text":"preserved"}]"#,
                r#"{"source":"fixture"}"#,
                "2025-01-02T00:00:00.000Z"
            ],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO rt_messages (\
                id, thread_id, role, parts, metadata, created_at, updated_at\
             ) VALUES (?1, 'legacy-thread', ?2, ?3, NULL, ?4, ?4)",
            params![
                "legacy-assistant",
                "assistant",
                r#"[{"type":"text","text":"also preserved"}]"#,
                // Older wall clock than the row inserted above: migration
                // and query order must follow legacy rowid, not this clock.
                "2025-01-01T00:00:00.000Z"
            ],
        )
        .unwrap();
        assert_eq!(
            conn.pragma_query_value::<u32, _>(None, "user_version", |row| row.get(0))
                .unwrap(),
            0
        );
    }

    /// Exact schema shape observed in a shipped native schema-v3 database.
    /// It intentionally does not replay today's `MIGRATIONS[0..=2]`: the
    /// historical v3 release had the generation/queue indexes and FKs but no
    /// generation triggers, and its queue table predates the later CHECK
    /// constraints now present in the reconstructed migration text.
    fn create_shipped_v3_fixture(app_root: &Path) {
        let dir = app_root.join(".decocms");
        fs::create_dir_all(&dir).unwrap();
        let conn = Connection::open(local_db_path(app_root)).unwrap();
        conn.pragma_update(None, "foreign_keys", 1).unwrap();
        conn.execute_batch(
            r#"
CREATE TABLE threads (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    parts TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX idx_messages_thread_created ON messages(thread_id, created_at);
CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    harness_id TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    ended_at TEXT,
    error TEXT
);
CREATE INDEX idx_runs_thread_created ON runs(thread_id, created_at);

CREATE TABLE rt_threads (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    hidden INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    created_by TEXT NOT NULL,
    updated_by TEXT NOT NULL,
    virtual_mcp_id TEXT NOT NULL,
    trigger_id TEXT,
    branch TEXT,
    sandbox_provider_kind TEXT,
    harness_id TEXT,
    metadata TEXT,
    run_config TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    generation TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_rt_threads_org_updated ON rt_threads(organization_id, updated_at);
CREATE UNIQUE INDEX idx_rt_threads_org_id_generation
ON rt_threads(organization_id, id, generation);
CREATE TABLE rt_messages (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES rt_threads(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    parts TEXT NOT NULL,
    metadata TEXT,
    seq INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX idx_rt_messages_thread_created ON rt_messages(thread_id, created_at);
CREATE UNIQUE INDEX idx_rt_messages_thread_seq ON rt_messages(thread_id, seq);
CREATE TABLE rt_turn_queue (
    organization_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    thread_generation TEXT NOT NULL,
    message_id TEXT NOT NULL,
    workflow_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    normalized_input_json TEXT NOT NULL,
    user_message_json TEXT NOT NULL,
    enqueued_at INTEGER NOT NULL,
    fifo_ordinal INTEGER NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'cancel_requested')),
    claim_token TEXT,
    PRIMARY KEY (organization_id, thread_id, thread_generation, workflow_id),
    UNIQUE (organization_id, thread_id, thread_generation, message_id),
    UNIQUE (organization_id, thread_id, thread_generation, fifo_ordinal),
    FOREIGN KEY (organization_id, thread_id, thread_generation)
        REFERENCES rt_threads(organization_id, id, generation)
        ON DELETE CASCADE
);
CREATE INDEX idx_rt_turn_queue_fifo
ON rt_turn_queue(organization_id, thread_id, thread_generation, fifo_ordinal);
CREATE INDEX idx_rt_turn_queue_recovery
ON rt_turn_queue(state, organization_id, thread_id, thread_generation, fifo_ordinal);
"#,
        )
        .unwrap();
        conn.execute(
            "INSERT INTO threads (id, title, created_at, updated_at) \
             VALUES ('mini-v3', 'mini preserved', ?1, ?1)",
            ["2025-01-01T00:00:00.000Z"],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO messages (id, thread_id, role, parts, created_at) \
             VALUES ('mini-v3-message', 'mini-v3', 'user', '[]', ?1)",
            ["2025-01-01T00:00:00.000Z"],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO runs (id, thread_id, harness_id, status, created_at) \
             VALUES ('mini-v3-run', 'mini-v3', 'claude-code', 'completed', ?1)",
            ["2025-01-01T00:00:00.000Z"],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO rt_threads (\
                id, organization_id, title, hidden, status, created_by, updated_by, \
                virtual_mcp_id, created_at, updated_at, generation\
             ) VALUES ('shipped-v3-thread', 'shipped-v3-org', 'preserved', 0, 'completed', \
                       'shipped-v3-user', 'shipped-v3-user', 'vmcp', ?1, ?1, \
                       'shipped-v3-generation')",
            ["2025-01-02T00:00:00.000Z"],
        )
        .unwrap();
        // Preserve an already-ambiguous historical transcript too. Shipped v3
        // could execute two accepted turns concurrently and therefore persist
        // user,user,assistant,assistant. There is no durable reply-to edge in
        // that schema, so migration must retain the exact order rather than
        // guess which assistant belongs to which user.
        for (id, role, seq) in [
            ("shipped-v3-user-message-1", "user", 1_i64),
            ("shipped-v3-user-message-2", "user", 2_i64),
            ("shipped-v3-assistant-message-1", "assistant", 3_i64),
            ("shipped-v3-assistant-message-2", "assistant", 4_i64),
        ] {
            conn.execute(
                "INSERT INTO rt_messages (\
                    id, thread_id, role, parts, metadata, seq, created_at, updated_at\
                 ) VALUES (?1, 'shipped-v3-thread', ?2, '[]', NULL, ?3, ?4, ?4)",
                params![id, role, seq, "2025-01-02T00:00:00.000Z"],
            )
            .unwrap();
        }
        conn.execute(
            "INSERT INTO rt_turn_queue (\
                organization_id, thread_id, thread_generation, message_id, workflow_id, \
                task_id, normalized_input_json, user_message_json, enqueued_at, fifo_ordinal, \
                state, claim_token\
             ) VALUES ('shipped-v3-org', 'shipped-v3-thread', 'shipped-v3-generation', \
                       'shipped-v3-queued', 'shipped-v3-workflow', 'shipped-v3-task', '{}', \
                       '{\"id\":\"shipped-v3-queued\",\"role\":\"user\",\"parts\":[]}', \
                       3, 1, 'queued', NULL)",
            [],
        )
        .unwrap();
        conn.pragma_update(None, "user_version", 3).unwrap();
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM sqlite_schema WHERE type = 'trigger'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
            0,
            "the shipped v3 fixture must not accidentally inherit today's triggers"
        );
        validate_foreign_keys(&conn).unwrap();
    }

    fn create_pre_account_scope_fixture(app_root: &Path) {
        let dir = app_root.join(".decocms");
        fs::create_dir_all(&dir).unwrap();
        let conn = Connection::open(local_db_path(app_root)).unwrap();
        conn.pragma_update(None, "foreign_keys", 1).unwrap();
        for migration in MIGRATIONS.iter().filter(|migration| migration.version <= 3) {
            conn.execute_batch(migration.sql).unwrap();
            conn.pragma_update(None, "user_version", migration.version)
                .unwrap();
        }
        for (id, creator, generation) in [
            ("owned-legacy", "user-a", "generation-owned"),
            (
                "placeholder-legacy",
                "local-desktop-user",
                "generation-placeholder",
            ),
        ] {
            conn.execute(
                "INSERT INTO rt_threads (\
                    id, organization_id, title, hidden, status, created_by, updated_by, \
                    virtual_mcp_id, created_at, updated_at, generation\
                 ) VALUES (?1, 'shared-org', ?1, 0, 'completed', ?2, ?2, \
                           'vmcp', '2025-01-01T00:00:00.000Z', \
                           '2025-01-01T00:00:00.000Z', ?3)",
                params![id, creator, generation],
            )
            .unwrap();
        }
        conn.execute(
            "INSERT INTO rt_turn_queue (\
                organization_id, thread_id, thread_generation, message_id, workflow_id, \
                task_id, normalized_input_json, user_message_json, enqueued_at, fifo_ordinal, \
                state, claim_token\
             ) VALUES ('shared-org', 'owned-legacy', 'generation-owned', 'legacy-message', \
                       'legacy-workflow', 'owned-legacy', '{}', \
                       '{\"id\":\"legacy-message\",\"role\":\"user\",\"parts\":[]}', \
                       1, 1, 'queued', NULL)",
            [],
        )
        .unwrap();
    }

    fn create_v4_fixture(
        app_root: &Path,
        scope: &RtAccountScope,
        organization_id: &str,
        thread_id: &str,
    ) {
        let dir = app_root.join(".decocms");
        fs::create_dir_all(&dir).unwrap();
        let conn = Connection::open(local_db_path(app_root)).unwrap();
        conn.pragma_update(None, "foreign_keys", 1).unwrap();
        for migration in MIGRATIONS.iter().filter(|migration| migration.version <= 4) {
            conn.execute_batch(migration.sql).unwrap();
            conn.pragma_update(None, "user_version", migration.version)
                .unwrap();
        }
        conn.execute(
            "INSERT INTO rt_threads (\
                id, organization_id, title, hidden, status, created_by, updated_by, \
                virtual_mcp_id, created_at, updated_at, generation, account_scope\
             ) VALUES (?1, ?2, 'v4 thread', 0, 'completed', ?3, ?3, 'vmcp', \
                       '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z', \
                       'v4-generation', ?4)",
            params![
                thread_id,
                organization_id,
                scope.user_id,
                scope.storage_key()
            ],
        )
        .unwrap();
        assert_eq!(
            conn.pragma_query_value::<u32, _>(None, "user_version", |row| row.get(0))
                .unwrap(),
            4
        );
    }

    fn create_v5_fixture(
        app_root: &Path,
        scope: &RtAccountScope,
        organization_id: &str,
        thread_id: &str,
    ) {
        create_v4_fixture(app_root, scope, organization_id, thread_id);
        let conn = Connection::open(local_db_path(app_root)).unwrap();
        conn.pragma_update(None, "foreign_keys", 1).unwrap();
        conn.execute_batch(MIGRATIONS[4].sql).unwrap();
        conn.pragma_update(None, "user_version", 5).unwrap();
        conn.execute(
            "INSERT INTO rt_messages (\
                id, thread_id, role, parts, metadata, seq, created_at, updated_at\
             ) VALUES ('v5-user-message', ?1, 'user', ?2, ?3, 7, ?4, ?4)",
            params![
                thread_id,
                r#"[{"type":"text","text":"preserved by v6"}]"#,
                r#"{"source":"v5-fixture"}"#,
                "2025-01-02T00:00:00.000Z",
            ],
        )
        .unwrap();
        for (message_id, workflow_id, fifo_ordinal, state, claim_token) in [
            (
                "v5-running-message",
                "v5-running",
                8,
                "running",
                Some("v5-claim"),
            ),
            ("v5-queued-message", "v5-queued", 9, "queued", None),
        ] {
            let user_message = serde_json::json!({
                "id": message_id,
                "role": "user",
                "parts": [{"type": "text", "text": message_id}],
            });
            conn.execute(
                "INSERT INTO rt_turn_queue (\
                    organization_id, thread_id, thread_generation, message_id, workflow_id, \
                    task_id, normalized_input_json, user_message_json, enqueued_at, fifo_ordinal, \
                    state, claim_token, account_scope\
                 ) VALUES (?1, ?2, 'v4-generation', ?3, ?4, 'v5-task', '{}', ?5, \
                           ?6, ?7, ?8, ?9, ?10)",
                params![
                    organization_id,
                    thread_id,
                    message_id,
                    workflow_id,
                    user_message.to_string(),
                    fifo_ordinal,
                    fifo_ordinal,
                    state,
                    claim_token,
                    scope.storage_key(),
                ],
            )
            .unwrap();
        }
        conn.execute(
            "INSERT INTO rt_thread_tombstones (\
                account_scope, organization_id, thread_id, deleted_generation, deleted_at\
             ) VALUES (?1, ?2, 'already-retired', 'retired-generation', ?3)",
            params![
                scope.storage_key(),
                organization_id,
                "2025-01-03T00:00:00.000Z"
            ],
        )
        .unwrap();
        validate_foreign_keys(&conn).unwrap();
        assert_eq!(schema_version(&local_db_path(app_root)), 5);
    }

    fn create_v6_fixture(
        app_root: &Path,
        scope: &RtAccountScope,
        organization_id: &str,
        thread_id: &str,
    ) {
        create_v5_fixture(app_root, scope, organization_id, thread_id);
        let conn = Connection::open(local_db_path(app_root)).unwrap();
        conn.pragma_update(None, "foreign_keys", 1).unwrap();
        conn.execute_batch(MIGRATIONS[5].sql).unwrap();
        conn.pragma_update(None, "user_version", 6).unwrap();
        validate_foreign_keys(&conn).unwrap();
        assert_eq!(schema_version(&local_db_path(app_root)), 6);
    }

    fn create_v7_fixture(
        app_root: &Path,
        scope: &RtAccountScope,
        organization_id: &str,
        thread_id: &str,
    ) {
        create_v6_fixture(app_root, scope, organization_id, thread_id);
        let conn = Connection::open(local_db_path(app_root)).unwrap();
        conn.pragma_update(None, "foreign_keys", 1).unwrap();
        conn.execute_batch(MIGRATIONS[6].sql).unwrap();
        conn.pragma_update(None, "user_version", 7).unwrap();
        validate_foreign_keys(&conn).unwrap();
        assert_eq!(schema_version(&local_db_path(app_root)), 7);
    }

    #[test]
    fn fresh_database_runs_all_migrations() {
        let dir = tempfile::tempdir().unwrap();
        let db = ThreadsDb::open(dir.path()).unwrap();
        assert_eq!(
            schema_version(&local_db_path(dir.path())),
            CURRENT_SCHEMA_VERSION
        );
        let conn = db.lock();
        let seq_not_null: i64 = conn
            .query_row(
                "SELECT `notnull` FROM pragma_table_info('native_scoped_messages') WHERE name = 'seq'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(seq_not_null, 1);
        assert!(index_shape(&conn, "native_scoped_turn_queue").iter().any(
            |(name, unique, _, partial)| {
                name == "idx_native_scoped_turn_queue_v1_assistant_message_id"
                    && *unique == 1
                    && *partial == 1
            }
        ));
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM pragma_table_info('native_scoped_turn_queue') \
                 WHERE name IN ('checkpoint_harness_id', 'checkpoint_session_id')",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
            2
        );
    }

    #[test]
    fn legacy_v0_adoption_preserves_rows_and_backfills_sequence_by_rowid() {
        let dir = tempfile::tempdir().unwrap();
        create_legacy_v0_fixture(dir.path());

        let db = ThreadsDb::open(dir.path()).unwrap();
        assert_eq!(
            schema_version(&local_db_path(dir.path())),
            CURRENT_SCHEMA_VERSION
        );
        assert_eq!(
            db.rt_get_thread("legacy-thread").unwrap().unwrap().title,
            "kept"
        );
        assert_eq!(
            db.get_thread("legacy-mini-thread").unwrap().unwrap().title,
            "also kept"
        );
        let (messages, total) = db.rt_list_messages("legacy-thread", 100, 0, false).unwrap();
        assert_eq!(total, 2);
        assert_eq!(
            messages
                .iter()
                .map(|message| message.id.as_str())
                .collect::<Vec<_>>(),
            ["legacy-user", "legacy-assistant"]
        );
        assert_eq!(messages[0].seq, 1);
        assert_eq!(messages[1].seq, 2);
        assert_eq!(messages[0].parts[0]["text"], "preserved");
        assert_eq!(messages[0].metadata.as_ref().unwrap()["source"], "fixture");
    }

    #[test]
    fn migrated_task_seeded_legacy_turn_retries_fail_closed_without_rerun() {
        let dir = tempfile::tempdir().unwrap();
        create_legacy_v0_fixture(dir.path());

        // The shipped pre-migration app generated a fresh server task id for
        // every POST and used THAT value for the assistant id. It was unrelated
        // to the frontend-owned user-message id, so migration cannot prove this
        // pair merely by deriving a name from `legacy-user`.
        let legacy_assistant_id = "msg-legacy-server-task-id-assistant";
        let conn = Connection::open(local_db_path(dir.path())).unwrap();
        conn.execute(
            "UPDATE rt_messages SET id = ?1 WHERE id = 'legacy-assistant'",
            [legacy_assistant_id],
        )
        .unwrap();
        drop(conn);

        let db = ThreadsDb::open(dir.path()).unwrap();
        let scope = RtAccountScope::new("test.invalid", "user").unwrap();
        let input = RtTurnEnqueueInput {
            message_id: "legacy-user".to_string(),
            workflow_id: "retry-workflow".to_string(),
            task_id: "retry-task".to_string(),
            normalized_input: serde_json::json!({
                "harnessId": "claude-code",
                "messages": [{
                    "id": "legacy-user",
                    "role": "user",
                    "parts": [{"type": "text", "text": "preserved"}],
                    "metadata": {"source": "fixture"},
                }],
            }),
            user_message: serde_json::json!({
                "id": "legacy-user",
                "role": "user",
                "parts": [{"type": "text", "text": "preserved"}],
                "metadata": {"source": "fixture"},
            }),
            enqueued_at: 1,
        };

        for _ in 0..2 {
            assert!(matches!(
                db.rt_enqueue_turn_scoped(&scope, "org", "legacy-thread", &input),
                Err(DbError::IdempotencyConflict {
                    entity: "rt_message",
                    ref id,
                }) if id == "legacy-user"
            ));
        }

        assert!(db
            .rt_list_turn_queue_scoped(&scope, "org", "legacy-thread")
            .unwrap()
            .is_empty());
        let (messages, total) = db
            .rt_list_messages_in_scope(&scope, "org", "legacy-thread", 100, 0, false)
            .unwrap();
        assert_eq!(total, 2);
        assert_eq!(
            messages
                .iter()
                .map(|message| (message.id.as_str(), message.seq))
                .collect::<Vec<_>>(),
            [("legacy-user", 1), (legacy_assistant_id, 2)]
        );
    }

    #[test]
    fn version_one_database_migrates_through_sequence_and_queue_versions() {
        let dir = tempfile::tempdir().unwrap();
        create_legacy_v0_fixture(dir.path());
        let conn = Connection::open(local_db_path(dir.path())).unwrap();
        conn.pragma_update(None, "user_version", 1).unwrap();
        drop(conn);

        let db = ThreadsDb::open(dir.path()).unwrap();
        assert_eq!(
            schema_version(&local_db_path(dir.path())),
            CURRENT_SCHEMA_VERSION
        );
        let (messages, _) = db.rt_list_messages("legacy-thread", 100, 0, false).unwrap();
        assert_eq!(
            messages
                .iter()
                .map(|message| message.seq)
                .collect::<Vec<_>>(),
            [1, 2]
        );
        let legacy_scope = RtAccountScope::new("test.invalid", "user").unwrap();
        assert!(!db
            .rt_thread_fence_in_scope(&legacy_scope, "org", "legacy-thread")
            .unwrap()
            .unwrap()
            .generation
            .is_empty());
    }

    #[test]
    fn version_two_database_gets_thread_generations_and_durable_queue() {
        let dir = tempfile::tempdir().unwrap();
        let db_dir = dir.path().join(".decocms");
        fs::create_dir_all(&db_dir).unwrap();
        let path = local_db_path(dir.path());
        let conn = Connection::open(&path).unwrap();
        conn.pragma_update(None, "foreign_keys", 1).unwrap();
        conn.execute_batch(MIGRATIONS[0].sql).unwrap();
        conn.pragma_update(None, "user_version", 1).unwrap();
        conn.execute_batch(MIGRATIONS[1].sql).unwrap();
        conn.pragma_update(None, "user_version", 2).unwrap();
        conn.execute(
            "INSERT INTO rt_threads (\
                id, organization_id, title, hidden, status, created_by, updated_by, \
                virtual_mcp_id, created_at, updated_at\
             ) VALUES ('v2-thread', 'org', '', 0, 'completed', 'user', 'user', \
                       'vmcp', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')",
            [],
        )
        .unwrap();
        drop(conn);

        let db = ThreadsDb::open(dir.path()).unwrap();
        let legacy_scope = RtAccountScope::new("test.invalid", "user").unwrap();
        let fence = db
            .rt_thread_fence_in_scope(&legacy_scope, "org", "v2-thread")
            .unwrap()
            .unwrap();
        assert!(!fence.generation.is_empty());
        assert_eq!(schema_version(&path), CURRENT_SCHEMA_VERSION);
        let outcome = db
            .rt_enqueue_turn_scoped(
                &legacy_scope,
                "org",
                "v2-thread",
                &turn_input("m1", "hello", 1),
            )
            .unwrap();
        assert!(matches!(outcome, RtTurnEnqueueOutcome::Inserted(_)));
    }

    #[test]
    fn shipped_version_three_without_triggers_migrates_to_current_intact() {
        let dir = tempfile::tempdir().unwrap();
        let path = local_db_path(dir.path());
        create_shipped_v3_fixture(dir.path());
        assert_eq!(schema_version(&path), 3);

        let db = ThreadsDb::open(dir.path()).unwrap();
        assert_eq!(schema_version(&path), CURRENT_SCHEMA_VERSION);
        let conn = db.lock();

        for (table, expected) in [
            ("threads", 1_i64),
            ("messages", 1),
            ("runs", 1),
            ("native_scoped_threads", 1),
            ("native_scoped_messages", 4),
            ("native_scoped_turn_queue", 1),
            ("native_scoped_thread_tombstones", 0),
            ("rt_threads", 0),
            ("rt_messages", 0),
        ] {
            assert_eq!(
                conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
                expected,
                "schema-v3 migration changed row count for {table}"
            );
        }
        assert_eq!(
            conn.query_row(
                "SELECT title FROM native_scoped_threads WHERE id = 'shipped-v3-thread'",
                [],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
            "preserved"
        );
        let preserved_roles = conn
            .prepare(
                "SELECT role FROM native_scoped_messages \
                 WHERE thread_id = 'shipped-v3-thread' ORDER BY seq",
            )
            .unwrap()
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(
            preserved_roles,
            ["user", "user", "assistant", "assistant"],
            "migration preserves ambiguous v3 history instead of inventing reply provenance"
        );
        assert_eq!(
            conn.query_row(
                "SELECT assistant_message_id FROM native_scoped_turn_queue \
                 WHERE workflow_id = 'shipped-v3-workflow'",
                [],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
            "msg-shipped-v3-queued-assistant"
        );
        assert_eq!(
            conn.query_row(
                "SELECT `table` FROM pragma_foreign_key_list('native_scoped_messages') LIMIT 1",
                [],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
            "native_scoped_threads"
        );
        assert_eq!(
            conn.query_row(
                "SELECT `table` FROM pragma_foreign_key_list('native_scoped_turn_queue') LIMIT 1",
                [],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
            "native_scoped_threads"
        );
        validate_foreign_keys(&conn).unwrap();
        assert_eq!(
            conn.pragma_query_value::<String, _>(None, "integrity_check", |row| row.get(0))
                .unwrap(),
            "ok"
        );
        for trigger in [
            "native_scoped_threads_generation_required_insert",
            "native_scoped_threads_generation_immutable",
            "native_scoped_threads_account_scope_required_insert",
            "native_scoped_turn_queue_account_scope_required_insert",
        ] {
            assert_eq!(
                conn.query_row(
                    "SELECT COUNT(*) FROM sqlite_schema WHERE type = 'trigger' AND name = ?1",
                    [trigger],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
                1,
                "current migration must create missing historical trigger {trigger}"
            );
        }
    }

    #[test]
    fn version_four_database_gets_durable_tombstones_that_survive_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let scope = RtAccountScope::new("studio.decocms.com", "v4-user").unwrap();
        create_v4_fixture(dir.path(), &scope, "v4-org", "retired-v4-thread");

        {
            let db = ThreadsDb::open(dir.path()).unwrap();
            assert_eq!(
                schema_version(&local_db_path(dir.path())),
                CURRENT_SCHEMA_VERSION
            );
            let fence = db
                .rt_thread_fence_in_scope(&scope, "v4-org", "retired-v4-thread")
                .unwrap()
                .unwrap();
            assert!(db.rt_delete_thread_in_org_if_generation(&fence).unwrap());
        }

        let reopened = ThreadsDb::open(dir.path()).unwrap();
        let recreate = reopened.rt_create_thread_scoped(
            &scope,
            Some("retired-v4-thread"),
            "v4-org",
            "must not return",
            None,
            "vmcp",
            None,
            "v4-user",
        );
        assert!(matches!(
            recreate,
            Err(DbError::RetiredThreadId {
                ref organization_id,
                ref thread_id,
                ..
            }) if organization_id == "v4-org" && thread_id == "retired-v4-thread"
        ));
        assert_eq!(
            reopened
                .lock()
                .query_row(
                    "SELECT COUNT(*) FROM native_scoped_thread_tombstones",
                    [],
                    |row| { row.get::<_, i64>(0) }
                )
                .unwrap(),
            1
        );
    }

    #[test]
    fn version_five_migration_preserves_all_scoped_data_and_blocks_old_binary_writes() {
        let dir = tempfile::tempdir().unwrap();
        let scope = RtAccountScope::new("studio.decocms.com", "v5-user").unwrap();
        create_v5_fixture(dir.path(), &scope, "v5-org", "v5-live-thread");

        let db = ThreadsDb::open(dir.path()).unwrap();
        assert_eq!(
            schema_version(&local_db_path(dir.path())),
            CURRENT_SCHEMA_VERSION
        );
        assert_eq!(
            db.rt_get_thread_in_scope(&scope, "v5-org", "v5-live-thread")
                .unwrap()
                .unwrap()
                .title,
            "v4 thread"
        );
        let (messages, total) = db
            .rt_list_messages_in_scope(&scope, "v5-org", "v5-live-thread", 100, 0, false)
            .unwrap();
        assert_eq!(total, 1);
        assert_eq!(messages[0].id, "v5-user-message");
        assert_eq!(messages[0].seq, 7);
        assert_eq!(messages[0].parts[0]["text"], "preserved by v6");
        assert_eq!(
            messages[0].metadata.as_ref().unwrap()["source"],
            "v5-fixture"
        );
        let queue = db
            .rt_list_turn_queue_scoped(&scope, "v5-org", "v5-live-thread")
            .unwrap();
        assert_eq!(queue.len(), 2);
        assert_eq!(queue[0].workflow_id, "v5-running");
        assert_eq!(queue[0].claim_token.as_deref(), Some("v5-claim"));
        assert_eq!(queue[1].workflow_id, "v5-queued");
        assert!(matches!(
            db.rt_create_thread_scoped(
                &scope,
                Some("already-retired"),
                "v5-org",
                "must stay retired",
                None,
                "vmcp",
                None,
                "v5-user",
            ),
            Err(DbError::RetiredThreadId { .. })
        ));

        let conn = db.lock();
        validate_foreign_keys(&conn).unwrap();
        for barrier in ["rt_threads", "rt_messages"] {
            assert_eq!(
                conn.query_row(&format!("SELECT COUNT(*) FROM {barrier}"), [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
                0,
                "downgrade barrier {barrier} must stay empty"
            );
        }
        for trigger in [
            "rt_threads_downgrade_block_insert",
            "rt_threads_downgrade_block_update",
            "rt_threads_downgrade_block_delete",
            "rt_messages_downgrade_block_insert",
            "rt_messages_downgrade_block_update",
            "rt_messages_downgrade_block_delete",
            "native_scoped_threads_generation_required_insert",
            "native_scoped_threads_generation_immutable",
            "native_scoped_threads_account_scope_required_insert",
            "native_scoped_turn_queue_account_scope_required_insert",
        ] {
            assert_eq!(
                conn.query_row(
                    "SELECT COUNT(*) FROM sqlite_schema WHERE type = 'trigger' AND name = ?1",
                    [trigger],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
                1,
                "schema v6 must recreate trigger {trigger} on its intended table"
            );
        }
        for index in [
            "idx_native_scoped_threads_org_updated",
            "idx_native_scoped_messages_thread_created",
            "idx_native_scoped_messages_thread_seq",
            "idx_native_scoped_threads_org_id_generation",
            "idx_native_scoped_turn_queue_fifo",
            "idx_native_scoped_turn_queue_recovery",
            "idx_native_scoped_threads_account_org_updated",
            "idx_native_scoped_turn_queue_account_recovery",
            "idx_rt_threads_org_updated",
            "idx_rt_messages_thread_created",
        ] {
            assert_eq!(
                conn.query_row(
                    "SELECT COUNT(*) FROM sqlite_schema WHERE type = 'index' AND name = ?1",
                    [index],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
                1,
                "schema v6 must preserve or recreate index {index}"
            );
        }
        let message_parent: String = conn
            .query_row(
                "SELECT `table` FROM pragma_foreign_key_list('native_scoped_messages') LIMIT 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(message_parent, "native_scoped_threads");
        let queue_parent: String = conn
            .query_row(
                "SELECT `table` FROM pragma_foreign_key_list('native_scoped_turn_queue') LIMIT 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(queue_parent, "native_scoped_threads");

        // This is the exact schema batch the shipped pre-runner binary runs on
        // every open. Compare the table, FK, and index structures against a
        // pristine copy before proving that its open batch succeeds: SQLite's
        // `IF NOT EXISTS` alone would not detect a subtly incompatible barrier.
        let oracle = Connection::open_in_memory().unwrap();
        oracle.execute_batch(MIGRATIONS[0].sql).unwrap();
        for table in ["rt_threads", "rt_messages"] {
            assert_eq!(table_shape(&conn, table), table_shape(&oracle, table));
            assert_eq!(
                foreign_key_shape(&conn, table),
                foreign_key_shape(&oracle, table)
            );
            assert_eq!(index_shape(&conn, table), index_shape(&oracle, table));
        }

        // The old open must succeed without ever exposing the renamed data.
        conn.execute_batch(MIGRATIONS[0].sql).unwrap();
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM rt_threads", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap(),
            0
        );
        let downgrade_write = conn.execute(
            "INSERT OR IGNORE INTO rt_threads (\
                id, organization_id, title, hidden, status, created_by, updated_by, \
                virtual_mcp_id, created_at, updated_at\
             ) VALUES ('old-write', 'v5-org', 'blocked', 0, 'completed', 'v5-user', \
                       'v5-user', 'vmcp', '2025-01-01T00:00:00.000Z', \
                       '2025-01-01T00:00:00.000Z')",
            [],
        );
        assert!(downgrade_write
            .unwrap_err()
            .to_string()
            .contains("requires a newer app version"));
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM native_scoped_threads", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap(),
            1
        );
    }

    #[test]
    fn version_six_migration_preserves_internal_updater_and_tracks_explicit_updates() {
        let dir = tempfile::tempdir().unwrap();
        let scope = RtAccountScope::new("studio.decocms.com", "v6-user").unwrap();
        create_v6_fixture(dir.path(), &scope, "v6-org", "v6-live-thread");

        let db = ThreadsDb::open(dir.path()).unwrap();
        assert_eq!(
            schema_version(&local_db_path(dir.path())),
            CURRENT_SCHEMA_VERSION
        );
        let migrated = db
            .rt_get_thread_in_scope(&scope, "v6-org", "v6-live-thread")
            .unwrap()
            .unwrap();
        assert_eq!(migrated.updated_by, None);
        assert!(!serde_json::to_value(&migrated)
            .unwrap()
            .as_object()
            .unwrap()
            .contains_key("updated_by"));

        {
            let conn = db.lock();
            let (internal_updater, explicit): (String, i64) = conn
                .query_row(
                    "SELECT updated_by, updated_by_explicit \
                     FROM native_scoped_threads WHERE id = 'v6-live-thread'",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .unwrap();
            assert_eq!(internal_updater, "v6-user");
            assert_eq!(explicit, 0);
            assert_eq!(
                conn.query_row("SELECT COUNT(*) FROM rt_threads", [], |row| row
                    .get::<_, i64>(0))
                    .unwrap(),
                0,
                "v7 must not disturb the v6 downgrade barrier"
            );
        }

        let updated = db
            .rt_update_thread_in_scope(
                &scope,
                "v6-org",
                "v6-live-thread",
                "v6-user",
                &RtThreadPatch::default(),
            )
            .unwrap()
            .unwrap();
        assert_eq!(updated.updated_by.as_deref(), Some("v6-user"));
        assert_eq!(
            serde_json::to_value(&updated).unwrap()["updated_by"],
            "v6-user"
        );
        assert_eq!(
            db.lock()
                .query_row(
                    "SELECT updated_by_explicit FROM native_scoped_threads \
                     WHERE id = 'v6-live-thread'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            1
        );
    }

    #[test]
    fn version_seven_upgrade_backfills_queue_ids_and_adds_durable_quarantine_without_changing_message_pk(
    ) {
        let dir = tempfile::tempdir().unwrap();
        let scope = RtAccountScope::new("studio.decocms.com", "v7-user").unwrap();
        create_v7_fixture(dir.path(), &scope, "v7-org", "v7-thread");

        drop(ThreadsDb::open(dir.path()).unwrap());
        assert_eq!(
            schema_version(&local_db_path(dir.path())),
            CURRENT_SCHEMA_VERSION
        );
        let conn = Connection::open(local_db_path(dir.path())).unwrap();
        let mut statement = conn
            .prepare(
                "SELECT message_id, assistant_message_id FROM native_scoped_turn_queue \
                 ORDER BY fifo_ordinal",
            )
            .unwrap();
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .unwrap()
            .map(Result::unwrap)
            .collect::<Vec<_>>();
        assert_eq!(
            rows,
            [
                (
                    "v5-running-message".to_string(),
                    "msg-v5-running-message-assistant".to_string(),
                ),
                (
                    "v5-queued-message".to_string(),
                    "msg-v5-queued-message-assistant".to_string(),
                ),
            ]
        );
        assert_eq!(
            conn.query_row(
                "SELECT pk FROM pragma_table_info('native_scoped_messages') WHERE name = 'id'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
            1,
            "message ids remain one global primary key"
        );
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM rt_threads", [], |row| row
                .get::<_, i64>(0),)
                .unwrap(),
            0,
            "v8/v9 must preserve the v6 downgrade barrier"
        );
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM pragma_table_info('native_scoped_turn_queue') \
                 WHERE name IN ('quarantine_reason', 'quarantine_preserve_user')",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
            2
        );
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM native_scoped_turn_queue \
                 WHERE checkpoint_harness_id IS NOT NULL OR checkpoint_session_id IS NOT NULL",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
            0,
            "v10 preserves every older queue row with no invented session"
        );
        drop(statement);
        drop(conn);
        drop(ThreadsDb::open(dir.path()).unwrap());
        assert_eq!(
            schema_version(&local_db_path(dir.path())),
            CURRENT_SCHEMA_VERSION
        );
    }

    #[test]
    fn version_seven_backfill_marks_only_provably_explicit_historical_updaters() {
        let dir = tempfile::tempdir().unwrap();
        let scope = RtAccountScope::new("studio.decocms.com", "creator").unwrap();
        create_v6_fixture(dir.path(), &scope, "org", "thread");
        let conn = Connection::open(local_db_path(dir.path())).unwrap();
        conn.execute(
            "UPDATE native_scoped_threads SET updated_by = 'different-updater' \
             WHERE id = 'thread'",
            [],
        )
        .unwrap();
        drop(conn);

        let db = ThreadsDb::open(dir.path()).unwrap();
        assert_eq!(
            db.rt_get_thread_in_scope(&scope, "org", "thread")
                .unwrap()
                .unwrap()
                .updated_by
                .as_deref(),
            Some("different-updater")
        );
        // Same-actor historical updates are indistinguishable from the
        // create-time copied value and intentionally remain implicit/omitted.
        assert_eq!(
            db.lock()
                .query_row(
                    "SELECT updated_by_explicit FROM native_scoped_threads WHERE id = 'thread'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            1
        );
    }

    #[test]
    fn current_rt_apis_never_read_or_write_downgrade_barrier_rows() {
        let db = ThreadsDb::open_in_memory().unwrap();
        let scope = RtAccountScope::new("studio.decocms.com", "scoped-user").unwrap();
        {
            let conn = db.lock();
            conn.execute_batch(
                "DROP TRIGGER rt_threads_downgrade_block_insert; \
                 DROP TRIGGER rt_messages_downgrade_block_insert; \
                 INSERT INTO rt_threads (\
                    id, organization_id, title, hidden, status, created_by, updated_by, \
                    virtual_mcp_id, created_at, updated_at\
                 ) VALUES ('same-public-id', 'same-org', 'barrier decoy', 0, 'completed', \
                           'old-user', 'old-user', 'old-vmcp', '2025-01-01T00:00:00.000Z', \
                           '2025-01-01T00:00:00.000Z'); \
                 INSERT INTO rt_messages (\
                    id, thread_id, role, parts, created_at, updated_at\
                 ) VALUES ('same-message-id', 'same-public-id', 'user', '[]', \
                           '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z');",
            )
            .unwrap();
        }

        assert!(db
            .rt_get_thread_in_scope(&scope, "same-org", "same-public-id")
            .unwrap()
            .is_none());
        let current = db
            .rt_create_thread_scoped(
                &scope,
                Some("same-public-id"),
                "same-org",
                "current scoped row",
                None,
                "current-vmcp",
                None,
                "scoped-user",
            )
            .unwrap();
        assert_eq!(current.title, "current scoped row");
        assert_eq!(
            db.rt_list_messages_in_scope(&scope, "same-org", &current.id, 100, 0, false)
                .unwrap()
                .1,
            0,
            "a barrier message with the same public id must remain invisible"
        );
        let appended = db
            .rt_append_message(
                "same-message-id",
                &current.id,
                "user",
                &serde_json::json!([]),
                None,
            )
            .unwrap();
        assert_eq!(appended.thread_id, current.id);
        let conn = db.lock();
        assert_eq!(
            conn.query_row(
                "SELECT title FROM rt_threads WHERE id = 'same-public-id'",
                [],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
            "barrier decoy"
        );
        assert_eq!(
            conn.query_row(
                "SELECT title FROM native_scoped_threads WHERE id = 'same-public-id'",
                [],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
            "current scoped row"
        );
    }

    #[test]
    fn failed_version_six_rename_rolls_back_every_table_and_version() {
        let dir = tempfile::tempdir().unwrap();
        let scope = RtAccountScope::new("studio.decocms.com", "v5-user").unwrap();
        create_v5_fixture(dir.path(), &scope, "v5-org", "v5-live-thread");
        let path = local_db_path(dir.path());
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(
            "CREATE TABLE native_scoped_messages (sentinel TEXT NOT NULL); \
             INSERT INTO native_scoped_messages VALUES ('kept');",
        )
        .unwrap();
        drop(conn);

        assert!(ThreadsDb::open(dir.path()).is_err());
        let conn = Connection::open(&path).unwrap();
        assert_eq!(schema_version(&path), 5);
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM rt_threads", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap(),
            1
        );
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM sqlite_schema \
                 WHERE type = 'table' AND name = 'native_scoped_threads'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
            0,
            "the first rename must roll back when the second rename fails"
        );
        assert_eq!(
            conn.query_row("SELECT sentinel FROM native_scoped_messages", [], |row| {
                row.get::<_, String>(0)
            })
            .unwrap(),
            "kept"
        );
        let message_parent: String = conn
            .query_row(
                "SELECT `table` FROM pragma_foreign_key_list('rt_messages') LIMIT 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(message_parent, "rt_threads");
    }

    #[test]
    fn current_schema_reopen_refuses_foreign_key_corruption_without_mutation() {
        let dir = tempfile::tempdir().unwrap();
        let path = local_db_path(dir.path());
        drop(ThreadsDb::open(dir.path()).unwrap());
        let conn = Connection::open(&path).unwrap();
        conn.pragma_update(None, "foreign_keys", 0).unwrap();
        conn.execute(
            "INSERT INTO native_scoped_messages (\
                id, thread_id, role, parts, seq, created_at, updated_at\
             ) VALUES ('orphan', 'missing-thread', 'user', '[]', 1, ?1, ?1)",
            ["2025-01-01T00:00:00.000Z"],
        )
        .unwrap();
        drop(conn);

        let error = match ThreadsDb::open(dir.path()) {
            Ok(_) => panic!("foreign-key corruption must fail closed"),
            Err(error) => error,
        };
        assert!(matches!(error, DbError::SchemaIntegrity(_)));
        let conn = Connection::open(&path).unwrap();
        assert_eq!(schema_version(&path), CURRENT_SCHEMA_VERSION);
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM native_scoped_messages WHERE id = 'orphan'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
            1,
            "validation must report corruption, not rewrite user data"
        );
    }

    #[test]
    fn reopening_current_database_is_an_idempotent_no_op() {
        let dir = tempfile::tempdir().unwrap();
        create_legacy_v0_fixture(dir.path());
        {
            let db = ThreadsDb::open(dir.path()).unwrap();
            let appended = db
                .rt_append_message(
                    "after-migration",
                    "legacy-thread",
                    "user",
                    &serde_json::json!([{"type": "text", "text": "new"}]),
                    None,
                )
                .unwrap();
            assert_eq!(appended.seq, 3);
        }

        let reopened = ThreadsDb::open(dir.path()).unwrap();
        let (messages, total) = reopened
            .rt_list_messages("legacy-thread", 100, 0, false)
            .unwrap();
        assert_eq!(
            schema_version(&local_db_path(dir.path())),
            CURRENT_SCHEMA_VERSION
        );
        assert_eq!(total, 3);
        assert_eq!(
            messages
                .iter()
                .map(|message| message.seq)
                .collect::<Vec<_>>(),
            [1, 2, 3]
        );
    }

    #[test]
    fn racing_first_opens_serialize_migration_version_checks() {
        let dir = tempfile::tempdir().unwrap();
        let root = std::sync::Arc::new(dir.path().to_path_buf());
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(3));
        let mut workers = Vec::new();
        for _ in 0..2 {
            let root = root.clone();
            let barrier = barrier.clone();
            workers.push(std::thread::spawn(move || {
                barrier.wait();
                ThreadsDb::open(&root).map(drop)
            }));
        }
        barrier.wait();
        for worker in workers {
            worker.join().unwrap().unwrap();
        }
        assert_eq!(
            schema_version(&local_db_path(&root)),
            CURRENT_SCHEMA_VERSION
        );
    }

    #[test]
    fn database_from_a_newer_app_is_refused_without_mutation() {
        let dir = tempfile::tempdir().unwrap();
        let db_dir = dir.path().join(".decocms");
        fs::create_dir_all(&db_dir).unwrap();
        let path = local_db_path(dir.path());
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(
            "CREATE TABLE sentinel (value TEXT NOT NULL); INSERT INTO sentinel VALUES ('kept');",
        )
        .unwrap();
        conn.pragma_update(None, "user_version", CURRENT_SCHEMA_VERSION + 1)
            .unwrap();
        drop(conn);

        let error = match ThreadsDb::open(dir.path()) {
            Ok(_) => panic!("a newer database must not be opened"),
            Err(error) => error,
        };
        assert!(matches!(
            error,
            DbError::NewerSchemaVersion {
                found,
                supported
            } if found == CURRENT_SCHEMA_VERSION + 1 && supported == CURRENT_SCHEMA_VERSION
        ));
        let conn = Connection::open(&path).unwrap();
        assert_eq!(
            conn.pragma_query_value::<u32, _>(None, "user_version", |row| row.get(0))
                .unwrap(),
            CURRENT_SCHEMA_VERSION + 1
        );
        assert_eq!(
            conn.query_row("SELECT value FROM sentinel", [], |row| row
                .get::<_, String>(0))
                .unwrap(),
            "kept"
        );
    }

    #[test]
    fn failed_migration_rolls_back_schema_rows_and_version() {
        let dir = tempfile::tempdir().unwrap();
        let db_dir = dir.path().join(".decocms");
        fs::create_dir_all(&db_dir).unwrap();
        let path = local_db_path(dir.path());
        let conn = Connection::open(&path).unwrap();
        // A malformed legacy table makes migration 2 fail after migration 1
        // has already created its other tables. The outer transaction must
        // undo every one of those changes.
        conn.execute_batch(
            "CREATE TABLE rt_messages (id TEXT PRIMARY KEY); \
             INSERT INTO rt_messages VALUES ('sentinel');",
        )
        .unwrap();
        drop(conn);

        assert!(ThreadsDb::open(dir.path()).is_err());
        let conn = Connection::open(&path).unwrap();
        assert_eq!(
            conn.pragma_query_value::<u32, _>(None, "user_version", |row| row.get(0))
                .unwrap(),
            0
        );
        assert_eq!(
            conn.query_row("SELECT id FROM rt_messages", [], |row| row
                .get::<_, String>(0))
                .unwrap(),
            "sentinel"
        );
        let created_by_failed_upgrade: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_schema WHERE type = 'table' AND name = 'threads'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(created_by_failed_upgrade, 0);
    }

    #[cfg(unix)]
    #[test]
    fn file_store_is_owner_only_including_wal_sidecars() {
        use std::os::unix::fs::PermissionsExt;

        let parent = tempfile::tempdir().unwrap();
        let app_root = parent.path().join("existing-project");
        fs::create_dir_all(&app_root).unwrap();
        fs::set_permissions(&app_root, fs::Permissions::from_mode(0o755)).unwrap();
        let path = local_db_path(&app_root);
        drop(Connection::open(&path).unwrap());
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();

        let db = ThreadsDb::open(&app_root).unwrap();
        db.create_thread("permission check".to_string()).unwrap();
        // The db sits at the app root now, and the app root is the USER'S
        // directory — open() secures the database files themselves and must
        // not chmod the directory around them.
        assert_eq!(
            fs::metadata(&app_root).unwrap().permissions().mode() & 0o777,
            0o755
        );
        for path in [
            path,
            sqlite_sidecar_path(&local_db_path(&app_root), "-wal"),
            sqlite_sidecar_path(&local_db_path(&app_root), "-shm"),
        ] {
            assert!(
                path.exists(),
                "SQLite should have materialized {}",
                path.display()
            );
            assert_eq!(
                fs::metadata(path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }

    #[test]
    fn rt_org_scoped_apis_cannot_observe_or_mutate_another_org() {
        let db = ThreadsDb::open_in_memory().unwrap();
        db.rt_create_thread(
            Some("thread-a"),
            "org-a",
            "original",
            None,
            "vmcp",
            None,
            "user-a",
        )
        .unwrap();
        let session_part = serde_json::json!([{
            "type": "data-harness-session",
            "harnessId": "claude-code",
            "sessionId": "session-a"
        }]);
        db.rt_append_message_in_org(
            "org-a",
            "assistant-a",
            "thread-a",
            "assistant",
            &session_part,
            None,
        )
        .unwrap();
        db.rt_enqueue_turn_in_org(
            "org-a",
            "thread-a",
            &turn_input("queued-a", "tenant scoped", 1),
        )
        .unwrap();

        assert!(db
            .rt_get_thread_in_org("org-b", "thread-a")
            .unwrap()
            .is_none());
        assert!(db
            .rt_get_message_in_org("org-b", "assistant-a")
            .unwrap()
            .is_none());
        assert_eq!(
            db.rt_list_messages_in_org("org-b", "thread-a", 100, 0, false)
                .unwrap()
                .1,
            0
        );
        assert_eq!(
            db.rt_last_assistant_session_in_org("org-b", "thread-a")
                .unwrap(),
            None
        );
        assert!(db
            .rt_list_turn_queue_in_org("org-b", "thread-a")
            .unwrap()
            .is_empty());
        assert!(matches!(
            db.rt_cancel_turn_in_org("org-b", "thread-a", "workflow-queued-a")
                .unwrap(),
            RtTurnCancelOutcome::NotFound
        ));
        assert!(db
            .rt_enqueue_turn_in_org(
                "org-b",
                "thread-a",
                &turn_input("queued-b", "cross tenant", 2),
            )
            .is_err());

        let patch = RtThreadPatch {
            title: Some("cross-tenant overwrite".to_string()),
            ..RtThreadPatch::default()
        };
        assert!(db
            .rt_update_thread_in_org("org-b", "thread-a", "user-b", &patch)
            .unwrap()
            .is_none());
        db.rt_pin_harness_if_unset_in_org(
            "org-b",
            "thread-a",
            "codex",
            Some("user-desktop"),
            Some("other-branch"),
        )
        .unwrap();
        db.rt_set_thread_status_in_org("org-b", "thread-a", "failed")
            .unwrap();
        assert!(db
            .rt_append_message_in_org(
                "org-b",
                "cross-org-message",
                "thread-a",
                "user",
                &serde_json::json!([]),
                None,
            )
            .is_err());
        assert!(!db.rt_delete_thread_in_org("org-b", "thread-a").unwrap());

        let unchanged = db
            .rt_get_thread_in_org("org-a", "thread-a")
            .unwrap()
            .unwrap();
        assert_eq!(unchanged.title, "original");
        assert_eq!(unchanged.status, "completed");
        assert_eq!(unchanged.harness_id, None);
        assert_eq!(unchanged.branch, None);
        assert!(db.rt_get_message("cross-org-message").unwrap().is_none());
        assert_eq!(
            db.rt_last_assistant_session_in_org("org-a", "thread-a")
                .unwrap(),
            Some(("claude-code".to_string(), "session-a".to_string()))
        );
    }

    #[test]
    fn rt_session_lookup_skips_failed_rows_invalid_tokens_and_other_harnesses() {
        let db = ThreadsDb::open_in_memory().unwrap();
        create_rt_thread(&db, "org", "thread");

        db.rt_append_message_in_org(
            "org",
            "assistant-claude-1",
            "thread",
            "assistant",
            &serde_json::json!([{
                "type": "data-harness-session",
                "harnessId": "claude-code",
                "sessionId": "claude-session-1",
            }]),
            None,
        )
        .unwrap();
        // A pre-spawn failure persists an assistant row with no token. It must
        // not erase the last known-good on-disk CLI conversation.
        db.rt_append_message_in_org(
            "org",
            "assistant-failed",
            "thread",
            "assistant",
            &serde_json::json!([]),
            Some(&serde_json::json!({"finishReason": "error"})),
        )
        .unwrap();
        // Wrong-provider and whitespace-only tokens are not valid anchors for
        // the thread's pinned harness.
        db.rt_append_message_in_org(
            "org",
            "assistant-codex",
            "thread",
            "assistant",
            &serde_json::json!([{
                "type": "data-harness-session",
                "harnessId": "codex",
                "sessionId": "codex-session-1",
            }]),
            None,
        )
        .unwrap();
        db.rt_append_message_in_org(
            "org",
            "assistant-invalid",
            "thread",
            "assistant",
            &serde_json::json!([
                {
                    "type": "data-harness-session",
                    "harnessId": "claude-code",
                    "sessionId": " \t ",
                },
                {
                    "type": "data-harness-session",
                    "harnessId": " ",
                    "sessionId": "not-valid",
                },
            ]),
            None,
        )
        .unwrap();

        assert_eq!(
            db.rt_last_assistant_session_for_harness_in_org("org", "thread", "claude-code")
                .unwrap(),
            Some(("claude-code".to_string(), "claude-session-1".to_string()))
        );
        assert_eq!(
            db.rt_last_assistant_session_for_harness_in_org("org", "thread", "codex")
                .unwrap(),
            Some(("codex".to_string(), "codex-session-1".to_string()))
        );

        db.rt_append_message_in_org(
            "org",
            "assistant-claude-2",
            "thread",
            "assistant",
            &serde_json::json!([{
                "type": "data-harness-session",
                "harnessId": "claude-code",
                "sessionId": " claude-session-2 ",
            }]),
            None,
        )
        .unwrap();
        assert_eq!(
            db.rt_last_assistant_session_for_harness_in_org("org", "thread", "claude-code")
                .unwrap(),
            Some(("claude-code".to_string(), "claude-session-2".to_string()))
        );

        db.lock()
            .execute(
                "UPDATE native_scoped_messages SET parts = '{broken-json' \
                 WHERE id = 'assistant-claude-2'",
                [],
            )
            .unwrap();
        assert!(
            db.rt_last_assistant_session_for_harness_in_org("org", "thread", "claude-code")
                .is_err(),
            "corrupt durable session history must fail closed instead of starting a fresh CLI session"
        );
    }

    #[test]
    fn rt_create_thread_rejects_explicit_id_collision_across_orgs() {
        let db = ThreadsDb::open_in_memory().unwrap();
        db.rt_create_thread(
            Some("shared-id"),
            "org-a",
            "a",
            None,
            "vmcp-a",
            None,
            "user-a",
        )
        .unwrap();
        let conflict = db.rt_create_thread(
            Some("shared-id"),
            "org-b",
            "b",
            None,
            "vmcp-b",
            None,
            "user-b",
        );
        assert!(matches!(
            conflict,
            Err(DbError::IdempotencyConflict {
                entity: "rt_thread",
                ref id
            }) if id == "shared-id"
        ));
        assert_eq!(
            db.rt_get_thread("shared-id")
                .unwrap()
                .unwrap()
                .organization_id,
            "org-a"
        );
    }

    #[test]
    fn durable_turn_enqueue_is_exact_idempotent_and_fifo() {
        let db = ThreadsDb::open_in_memory().unwrap();
        create_rt_thread(&db, "org", "thread");
        let first_input = turn_input("m1", "first", 100);
        let first = match db
            .rt_enqueue_turn_in_org("org", "thread", &first_input)
            .unwrap()
        {
            RtTurnEnqueueOutcome::Inserted(item) => item,
            other => panic!("expected insertion, got {other:?}"),
        };
        assert_eq!(first.fifo_ordinal, 1);
        assert_eq!(first.state, RtTurnQueueState::Queued);
        assert_eq!(first.claim_token, None);

        let mut retry = first_input.clone();
        retry.enqueued_at = 999;
        let repeated = match db.rt_enqueue_turn_in_org("org", "thread", &retry).unwrap() {
            RtTurnEnqueueOutcome::Existing(item) => item,
            other => panic!("expected existing row, got {other:?}"),
        };
        assert_eq!(
            repeated, first,
            "server enqueue time stays first-write-wins"
        );

        let second = match db
            .rt_enqueue_turn_in_org("org", "thread", &turn_input("m2", "second", 101))
            .unwrap()
        {
            RtTurnEnqueueOutcome::Inserted(item) => item,
            other => panic!("expected insertion, got {other:?}"),
        };
        assert_eq!(second.fifo_ordinal, 2);
        assert_eq!(
            db.rt_list_turn_queue_in_org("org", "thread")
                .unwrap()
                .iter()
                .map(|item| item.message_id.as_str())
                .collect::<Vec<_>>(),
            ["m1", "m2"]
        );

        let mut conflicting_payload = first_input.clone();
        conflicting_payload.user_message["parts"][0]["text"] = serde_json::json!("changed");
        assert!(matches!(
            db.rt_enqueue_turn_in_org("org", "thread", &conflicting_payload),
            Err(DbError::IdempotencyConflict {
                entity: "rt_turn_queue",
                ref id,
            }) if id == "m1"
        ));
        let mut conflicting_workflow = turn_input("m3", "third", 102);
        conflicting_workflow.workflow_id = first_input.workflow_id.clone();
        assert!(matches!(
            db.rt_enqueue_turn_in_org("org", "thread", &conflicting_workflow),
            Err(DbError::IdempotencyConflict {
                entity: "rt_turn_queue",
                ref id,
            }) if id == "m3"
        ));
        assert_eq!(
            db.rt_list_turn_queue_in_org("org", "thread").unwrap().len(),
            2
        );

        let mut malformed = turn_input("m4", "bad identity", 103);
        malformed.user_message["id"] = serde_json::json!("different");
        assert!(matches!(
            db.rt_enqueue_turn_in_org("org", "thread", &malformed),
            Err(DbError::InvalidQueueData(_))
        ));
    }

    #[test]
    fn native_assistant_ids_are_reserved_deterministic_and_scope_generation_aware() {
        let db = ThreadsDb::open_in_memory().unwrap();
        create_rt_thread(&db, "org", "thread-a");
        create_rt_thread(&db, "org", "thread-b");
        let first = db
            .rt_thread_fence_in_org("org", "thread-a")
            .unwrap()
            .unwrap();
        let second = db
            .rt_thread_fence_in_org("org", "thread-b")
            .unwrap()
            .unwrap();
        let id = native_assistant_message_id(&first, "user-id");
        assert_eq!(id, native_assistant_message_id(&first, "user-id"));
        assert_ne!(id, native_assistant_message_id(&first, "other-user"));
        assert_ne!(id, native_assistant_message_id(&second, "user-id"));
        let hash = id
            .strip_prefix(NATIVE_ASSISTANT_MESSAGE_ID_V1_PREFIX)
            .expect("v1 namespace");
        assert_eq!(hash.len(), 64);
        assert!(hash
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()));

        let reserved = turn_input("native-assistant:v2:caller", "blocked", 1);
        assert!(matches!(
            db.rt_enqueue_turn_in_org("org", "thread-a", &reserved),
            Err(DbError::InvalidQueueData(message)) if message.contains("reserved namespace")
        ));
    }

    #[test]
    fn enqueue_reserves_global_user_and_assistant_ids_before_acceptance() {
        let db = ThreadsDb::open_in_memory().unwrap();
        create_rt_thread(&db, "org", "thread-a");
        create_rt_thread(&db, "org", "thread-b");
        db.rt_enqueue_turn_in_org("org", "thread-a", &turn_input("shared", "first", 1))
            .unwrap();
        assert!(matches!(
            db.rt_enqueue_turn_in_org("org", "thread-b", &turn_input("shared", "second", 2)),
            Err(DbError::IdempotencyConflict {
                entity: "rt_turn_queue",
                ref id,
            }) if id == "shared"
        ));

        let fence_b = db
            .rt_thread_fence_in_org("org", "thread-b")
            .unwrap()
            .unwrap();
        let predicted = native_assistant_message_id(&fence_b, "unique-user");
        db.rt_append_message_in_org(
            "org",
            &predicted,
            "thread-a",
            "assistant",
            &serde_json::json!([]),
            None,
        )
        .unwrap();
        assert!(matches!(
            db.rt_enqueue_turn_in_org(
                "org",
                "thread-b",
                &turn_input("unique-user", "second", 3),
            ),
            Err(DbError::IdempotencyConflict {
                entity: "rt_message",
                ref id,
            }) if id == &predicted
        ));
        assert!(db
            .rt_list_turn_queue_in_org("org", "thread-b")
            .unwrap()
            .is_empty());
    }

    #[test]
    fn enqueue_retry_rejects_reversed_v1_completed_pair() {
        let db = ThreadsDb::open_in_memory().unwrap();
        create_rt_thread(&db, "org", "thread");
        let input = turn_input("m1", "reversed", 1);
        let fence = db.rt_thread_fence_in_org("org", "thread").unwrap().unwrap();
        let assistant_id = native_assistant_message_id(&fence, &input.message_id);

        db.rt_append_message_in_org(
            "org",
            &assistant_id,
            "thread",
            "assistant",
            &serde_json::json!([{"type": "text", "text": "too early"}]),
            None,
        )
        .unwrap();
        db.rt_append_message_in_org(
            "org",
            &input.message_id,
            "thread",
            "user",
            input.user_message.get("parts").unwrap(),
            input.user_message.get("metadata"),
        )
        .unwrap();

        assert!(matches!(
            db.rt_enqueue_turn_in_org("org", "thread", &input),
            Err(DbError::IdempotencyConflict {
                entity: "rt_message",
                ref id,
            }) if id == &assistant_id
        ));
        assert!(db
            .rt_list_turn_queue_in_org("org", "thread")
            .unwrap()
            .is_empty());
    }

    #[test]
    fn enqueue_retry_rejects_reversed_legacy_completed_pair() {
        let db = ThreadsDb::open_in_memory().unwrap();
        create_rt_thread(&db, "org", "thread");
        let input = turn_input("m1", "legacy reversed", 1);
        let assistant_id = legacy_native_assistant_message_id(&input.message_id);

        db.rt_append_message_in_org(
            "org",
            &assistant_id,
            "thread",
            "assistant",
            &serde_json::json!([{"type": "text", "text": "too early"}]),
            None,
        )
        .unwrap();
        db.rt_append_message_in_org(
            "org",
            &input.message_id,
            "thread",
            "user",
            input.user_message.get("parts").unwrap(),
            input.user_message.get("metadata"),
        )
        .unwrap();

        assert!(matches!(
            db.rt_enqueue_turn_in_org("org", "thread", &input),
            Err(DbError::IdempotencyConflict {
                entity: "rt_message",
                ref id,
            }) if id == &assistant_id
        ));
        assert!(db
            .rt_list_turn_queue_in_org("org", "thread")
            .unwrap()
            .is_empty());
    }

    #[test]
    fn claim_adopts_exact_persisted_pair_without_rerun_and_preserves_failed_status() {
        let db = ThreadsDb::open_in_memory().unwrap();
        create_rt_thread(&db, "org", "thread");
        let input = turn_input("m1", "already complete", 1);
        let queued = match db.rt_enqueue_turn_in_org("org", "thread", &input).unwrap() {
            RtTurnEnqueueOutcome::Inserted(item) => item,
            other => panic!("expected insertion, got {other:?}"),
        };
        let assistant_id = claimed_assistant_id(&queued);
        db.rt_append_message_in_org(
            "org",
            "m1",
            "thread",
            "user",
            input.user_message.get("parts").unwrap(),
            input.user_message.get("metadata"),
        )
        .unwrap();
        let assistant_parts = serde_json::json!([{"type": "text", "text": "kept"}]);
        db.rt_append_message_in_org(
            "org",
            &assistant_id,
            "thread",
            "assistant",
            &assistant_parts,
            None,
        )
        .unwrap();
        db.rt_set_thread_status_in_org("org", "thread", "failed")
            .unwrap();

        assert_eq!(
            db.rt_claim_turn_queue_head_fenced(&queued.fence)
                .unwrap()
                .unwrap(),
            RtTurnClaimOutcome::Completed {
                workflow_id: queued.workflow_id.clone(),
            }
        );
        assert!(db
            .rt_list_turn_queue_in_org("org", "thread")
            .unwrap()
            .is_empty());
        assert_eq!(
            db.rt_get_thread("thread").unwrap().unwrap().status,
            "failed"
        );
        assert_eq!(
            db.rt_get_message_in_org("org", &assistant_id)
                .unwrap()
                .unwrap()
                .parts,
            assistant_parts
        );
    }

    #[test]
    fn active_recovery_adopts_exact_pair_without_downgrading_completed_status() {
        let db = ThreadsDb::open_in_memory().unwrap();
        create_rt_thread(&db, "org", "thread");
        let input = turn_input("m1", "already durable", 1);
        db.rt_enqueue_turn_in_org("org", "thread", &input).unwrap();
        let claimed = db
            .rt_claim_turn_queue_head_in_org("org", "thread")
            .unwrap()
            .unwrap();
        db.rt_begin_claimed_turn(&claimed).unwrap();
        let assistant_id = claimed_assistant_id(&claimed);
        db.rt_append_message_in_org(
            "org",
            &assistant_id,
            "thread",
            "assistant",
            &serde_json::json!([{"type": "text", "text": "done"}]),
            Some(&serde_json::json!({"finishReason": "stop"})),
        )
        .unwrap();
        db.rt_set_thread_status_in_org("org", "thread", "completed")
            .unwrap();

        assert!(
            db.rt_list_orphaned_active_turns_isolated()
                .unwrap()
                .is_empty(),
            "exact durable pair is adopted during scan without executable recovery work"
        );
        assert!(db
            .rt_list_turn_queue_in_org("org", "thread")
            .unwrap()
            .is_empty());
        assert_eq!(
            db.rt_get_thread("thread").unwrap().unwrap().status,
            "completed"
        );
    }

    #[test]
    fn active_recovery_adopts_exact_pair_without_downgrading_requires_action_status() {
        let db = ThreadsDb::open_in_memory().unwrap();
        create_rt_thread(&db, "org", "thread");
        let input = turn_input("m1", "already durable", 1);
        db.rt_enqueue_turn_in_org("org", "thread", &input).unwrap();
        let claimed = db
            .rt_claim_turn_queue_head_in_org("org", "thread")
            .unwrap()
            .unwrap();
        db.rt_begin_claimed_turn(&claimed).unwrap();
        let assistant_id = claimed_assistant_id(&claimed);
        db.rt_append_message_in_org(
            "org",
            &assistant_id,
            "thread",
            "assistant",
            &serde_json::json!([{"type": "text", "text": "Should I continue?"}]),
            Some(&serde_json::json!({"finishReason": "stop"})),
        )
        .unwrap();
        db.rt_set_thread_status_in_org("org", "thread", "requires_action")
            .unwrap();

        assert!(
            db.rt_list_orphaned_active_turns_isolated()
                .unwrap()
                .is_empty(),
            "exact durable pair is adopted during scan without executable recovery work"
        );
        assert!(db
            .rt_list_turn_queue_in_org("org", "thread")
            .unwrap()
            .is_empty());
        assert_eq!(
            db.rt_get_thread("thread").unwrap().unwrap().status,
            "requires_action"
        );
    }

    #[test]
    fn claimed_session_checkpoint_survives_reopen_and_orphan_finalization() {
        let dir = tempfile::tempdir().unwrap();
        let db = ThreadsDb::open(dir.path()).unwrap();
        create_rt_thread(&db, "org", "thread");
        let fence = db.rt_thread_fence_in_org("org", "thread").unwrap().unwrap();
        assert!(db
            .rt_pin_harness_if_unset_fenced(&fence, "claude-code", None, None)
            .unwrap());
        db.rt_enqueue_turn_in_org("org", "thread", &turn_input("m1", "first prompt", 1))
            .unwrap();
        let claimed = db
            .rt_claim_turn_queue_head_in_org("org", "thread")
            .unwrap()
            .unwrap();
        assert!(matches!(
            db.rt_begin_claimed_turn(&claimed).unwrap(),
            RtTurnBeginOutcome::Begun(_)
        ));
        assert!(db
            .rt_checkpoint_claimed_turn_session(&claimed, "claude-code", "session-1")
            .unwrap());
        assert!(db
            .rt_checkpoint_claimed_turn_session(&claimed, " claude-code ", " session-1 ")
            .unwrap());
        assert!(db
            .rt_checkpoint_claimed_turn_session(&claimed, "claude-code", "session-2")
            .is_err());
        assert!(db
            .rt_checkpoint_claimed_turn_session(&claimed, "codex", "session-1")
            .is_err());
        assert_eq!(
            db.rt_list_turn_queue_in_org("org", "thread").unwrap()[0].checkpoint_session,
            Some(("claude-code".to_string(), "session-1".to_string())),
            "wrong-harness checkpoint must not mutate the authoritative pair"
        );

        let mut stale_claim = claimed.clone();
        stale_claim.claim_token = Some("not-the-active-claim".to_string());
        assert!(!db
            .rt_checkpoint_claimed_turn_session(&stale_claim, "claude-code", "session-1")
            .unwrap());
        let mut stale_generation = claimed.clone();
        stale_generation.fence.generation = "not-the-live-generation".to_string();
        assert!(!db
            .rt_checkpoint_claimed_turn_session(&stale_generation, "claude-code", "session-1")
            .unwrap());
        drop(db);

        let db = ThreadsDb::open(dir.path()).unwrap();
        let orphan = match db
            .rt_list_orphaned_active_turns_isolated()
            .unwrap()
            .as_slice()
        {
            [RtOrphanedTurn::Ready(turn)] => turn.clone(),
            other => panic!("expected one recoverable checkpointed turn, got {other:?}"),
        };
        assert_eq!(
            orphan.checkpoint_session,
            Some(("claude-code".to_string(), "session-1".to_string()))
        );
        assert!(matches!(
            db.rt_begin_claimed_turn(&orphan).unwrap(),
            RtTurnBeginOutcome::Begun(_)
        ));
        let interrupted = serde_json::json!([{
            "type": "text",
            "text": "interrupted"
        }]);
        assert!(matches!(
            db.rt_finalize_claimed_turn(
                &orphan,
                &interrupted,
                Some(&serde_json::json!({"interrupted": true})),
                RtTurnTerminalStatus::Failed,
            )
            .unwrap(),
            RtTurnTerminalOutcome::Completed(_)
        ));
        assert!(db
            .rt_list_turn_queue_in_org("org", "thread")
            .unwrap()
            .is_empty());
        assert_eq!(
            db.rt_last_assistant_session_for_harness_in_org("org", "thread", "claude-code")
                .unwrap(),
            Some(("claude-code".to_string(), "session-1".to_string()))
        );
        let messages = db
            .rt_list_messages_in_org("org", "thread", 10, 0, false)
            .unwrap()
            .0;
        assert_eq!(messages.len(), 2);
        assert!(messages[1].parts.as_array().unwrap().iter().any(|part| {
            part == &serde_json::json!({
                "type": "data-harness-session",
                "harnessId": "claude-code",
                "sessionId": "session-1",
            })
        }));
    }

    #[test]
    fn assistant_checkpoint_merge_is_idempotent_and_rejects_malformed_parts() {
        let checkpoint = ("claude-code".to_string(), "session-1".to_string());
        let existing = serde_json::json!([
            {"type": "text", "text": "done"},
            {
                "type": "data-harness-session",
                "harnessId": "claude-code",
                "sessionId": "session-1",
            }
        ]);
        assert_eq!(
            assistant_parts_with_checkpoint(&existing, Some(&checkpoint)).unwrap(),
            existing,
            "terminal finalization must not duplicate the accumulator's token"
        );
        for malformed in [
            serde_json::json!([{"type": "data-harness-session"}]),
            serde_json::json!([{
                "type": "data-harness-session",
                "harnessId": "codex",
                "sessionId": "session-1",
            }]),
            serde_json::json!([{
                "type": "data-harness-session",
                "harnessId": "claude-code",
                "sessionId": " ",
            }]),
        ] {
            assert!(
                assistant_parts_with_checkpoint(&malformed, Some(&checkpoint)).is_err(),
                "malformed/conflicting session parts must fail closed: {malformed}"
            );
        }
    }

    #[test]
    fn claim_quarantines_wrong_or_reversed_assistant_reservations() {
        for corruption in ["wrong-id", "reversed-sequence"] {
            let db = ThreadsDb::open_in_memory().unwrap();
            create_rt_thread(&db, "org", "thread");
            let input = turn_input("m1", corruption, 1);
            let queued = match db.rt_enqueue_turn_in_org("org", "thread", &input).unwrap() {
                RtTurnEnqueueOutcome::Inserted(item) => item,
                other => panic!("expected insertion, got {other:?}"),
            };
            let reserved_id = claimed_assistant_id(&queued);
            let (assistant_id, assistant_first) = match corruption {
                "wrong-id" => ("foreign-assistant".to_string(), false),
                "reversed-sequence" => (reserved_id, true),
                _ => unreachable!(),
            };
            if assistant_first {
                db.rt_append_message_in_org(
                    "org",
                    &assistant_id,
                    "thread",
                    "assistant",
                    &serde_json::json!([{"type": "text", "text": "foreign"}]),
                    None,
                )
                .unwrap();
            }
            db.rt_append_message_in_org(
                "org",
                "m1",
                "thread",
                "user",
                input.user_message.get("parts").unwrap(),
                input.user_message.get("metadata"),
            )
            .unwrap();
            if !assistant_first {
                db.rt_append_message_in_org(
                    "org",
                    &assistant_id,
                    "thread",
                    "assistant",
                    &serde_json::json!([{"type": "text", "text": "foreign"}]),
                    None,
                )
                .unwrap();
                db.lock()
                    .execute(
                        "UPDATE native_scoped_turn_queue SET assistant_message_id = ?1 \
                         WHERE workflow_id = ?2",
                        params![assistant_id, queued.workflow_id],
                    )
                    .unwrap();
            }

            let malformed = match db
                .rt_claim_turn_queue_head_fenced(&queued.fence)
                .unwrap()
                .unwrap()
            {
                RtTurnClaimOutcome::Malformed(item) => item,
                other => panic!("{corruption} must not be adopted or executed: {other:?}"),
            };
            assert!(malformed.canonical_user.is_none());
            assert_eq!(
                db.rt_finalize_malformed_orphan(
                    &malformed,
                    &serde_json::json!([{"type": "text", "text": "must not persist"}]),
                    None,
                )
                .unwrap(),
                RtTurnTerminalOutcome::Quarantined
            );
            assert_eq!(
                db.rt_get_message_in_org("org", &assistant_id)
                    .unwrap()
                    .unwrap()
                    .parts,
                serde_json::json!([{"type": "text", "text": "foreign"}])
            );
        }
    }

    #[test]
    fn malformed_queued_head_is_quarantined_and_healthy_tail_remains_claimable() {
        let db = ThreadsDb::open_in_memory().unwrap();
        create_rt_thread(&db, "org", "thread");
        for (id, at) in [("broken", 1), ("healthy", 2)] {
            db.rt_enqueue_turn_in_org("org", "thread", &turn_input(id, id, at))
                .unwrap();
        }
        db.lock()
            .execute(
                "UPDATE native_scoped_turn_queue SET normalized_input_json = '{' \
                 WHERE workflow_id = 'workflow-broken'",
                [],
            )
            .unwrap();
        let fence = db.rt_thread_fence_in_org("org", "thread").unwrap().unwrap();
        let malformed = match db.rt_claim_turn_queue_head_fenced(&fence).unwrap().unwrap() {
            RtTurnClaimOutcome::Malformed(item) => item,
            other => panic!("expected malformed head, got {other:?}"),
        };
        let interrupted_parts = serde_json::json!([{"type": "text", "text": "quarantined"}]);
        assert!(matches!(
            db.rt_finalize_malformed_orphan(
                &malformed,
                &interrupted_parts,
                Some(&serde_json::json!({"interrupted": true})),
            )
            .unwrap(),
            RtTurnTerminalOutcome::Completed(_)
        ));
        let messages = db
            .rt_list_messages_in_org("org", "thread", 100, 0, false)
            .unwrap()
            .0;
        assert_eq!(
            messages
                .iter()
                .map(|message| message.role.as_str())
                .collect::<Vec<_>>(),
            ["user", "assistant"],
            "valid accepted user JSON survives unrelated normalized-input corruption"
        );
        assert!(messages[0].seq < messages[1].seq);
        assert_eq!(messages[1].parts, interrupted_parts);
        let healthy = ready_claim(db.rt_claim_turn_queue_head_fenced(&fence).unwrap().unwrap());
        assert_eq!(healthy.message_id, "healthy");
    }

    #[test]
    fn pre_v8_duplicate_queue_loser_is_quarantined_before_harness_claim() {
        let db = ThreadsDb::open_in_memory().unwrap();
        create_rt_thread(&db, "org", "winner");
        create_rt_thread(&db, "org", "loser");
        let winner = match db
            .rt_enqueue_turn_in_org("org", "winner", &turn_input("shared", "winner", 1))
            .unwrap()
        {
            RtTurnEnqueueOutcome::Inserted(item) => item,
            other => panic!("expected insertion, got {other:?}"),
        };
        let loser_fence = db.rt_thread_fence_in_org("org", "loser").unwrap().unwrap();
        create_rt_thread(&db, "org", "reservation-owner");
        let reservation_owner_fence = db
            .rt_thread_fence_in_org("org", "reservation-owner")
            .unwrap()
            .unwrap();
        let loser_message = serde_json::json!({
            "id": "shared",
            "role": "user",
            "parts": [{"type": "text", "text": "legacy loser"}],
        });
        db.lock()
            .execute(
                "INSERT INTO native_scoped_turn_queue (\
                    account_scope, organization_id, thread_id, thread_generation, message_id, \
                    assistant_message_id, workflow_id, task_id, normalized_input_json, \
                    user_message_json, enqueued_at, fifo_ordinal, state, claim_token\
                 ) VALUES (?1, 'org', 'loser', ?2, 'shared', 'msg-shared-assistant', \
                           'legacy-loser', 'loser', '{}', ?3, 2, 1, 'queued', NULL)",
                params![
                    loser_fence.account_scope,
                    loser_fence.generation,
                    loser_message.to_string(),
                ],
            )
            .unwrap();
        let occupied_isolation_id = native_assistant_message_id(&loser_fence, "shared");
        let reservation_owner_message = serde_json::json!({
            "id": "reservation-owner-user",
            "role": "user",
            "parts": [{"type": "text", "text": "owns the v1 reservation"}],
        });
        db.lock()
            .execute(
                "INSERT INTO native_scoped_turn_queue (\
                    account_scope, organization_id, thread_id, thread_generation, message_id, \
                    assistant_message_id, workflow_id, task_id, normalized_input_json, \
                    user_message_json, enqueued_at, fifo_ordinal, state, claim_token\
                 ) VALUES (?1, 'org', 'reservation-owner', ?2, 'reservation-owner-user', ?3, \
                           'reservation-owner-workflow', 'reservation-owner-task', '{}', ?4, \
                           3, 1, 'queued', NULL)",
                params![
                    reservation_owner_fence.account_scope,
                    reservation_owner_fence.generation,
                    occupied_isolation_id,
                    reservation_owner_message.to_string(),
                ],
            )
            .unwrap();
        let occupied_parts = serde_json::json!([{"type": "text", "text": "foreign owner"}]);
        db.rt_append_message_in_org(
            "org",
            &occupied_isolation_id,
            "winner",
            "assistant",
            &occupied_parts,
            None,
        )
        .unwrap();

        let loser = match db
            .rt_claim_turn_queue_head_fenced(&loser_fence)
            .unwrap()
            .unwrap()
        {
            RtTurnClaimOutcome::Malformed(item) => item,
            other => panic!("legacy collision must not become executable: {other:?}"),
        };
        assert!(loser.error.contains("reservation collision"));
        assert_eq!(
            loser.assistant_message_id.as_deref(),
            Some("msg-shared-assistant"),
            "quarantine must not rewrite a legacy reservation into an occupied v1 id"
        );
        assert_ne!(loser.assistant_message_id, winner.assistant_message_id);
        let recovered = db.rt_list_orphaned_active_turns_isolated().unwrap();
        let recovered_loser = match recovered.as_slice() {
            [RtOrphanedTurn::Malformed(item)] => item,
            other => panic!("persisted quarantine must survive recovery: {other:?}"),
        };
        assert!(recovered_loser.error.contains("quarantined at claim"));
        assert_eq!(
            db.rt_finalize_malformed_orphan(
                recovered_loser,
                &serde_json::json!([{"type": "text", "text": "must not persist"}]),
                Some(&serde_json::json!({"interrupted": true})),
            )
            .unwrap(),
            RtTurnTerminalOutcome::Quarantined,
            "occupied message and queue reservations must close without stealing either"
        );
        assert_eq!(
            db.rt_get_message_in_org("org", &occupied_isolation_id)
                .unwrap()
                .unwrap()
                .parts,
            occupied_parts
        );
        assert_eq!(
            db.rt_list_turn_queue_in_org("org", "reservation-owner")
                .unwrap()
                .len(),
            1,
            "quarantine must not mutate the queue row that owns the v1 reservation"
        );
        assert!(
            db.rt_list_messages_in_org("org", "loser", 100, 0, false)
                .unwrap()
                .0
                .is_empty(),
            "a pre-v8 collision loser must not gain an assistant-only transcript"
        );
        assert!(db
            .rt_list_turn_queue_in_org("org", "loser")
            .unwrap()
            .is_empty());
        assert!(matches!(
            db.rt_claim_turn_queue_head_fenced(&winner.fence)
                .unwrap()
                .unwrap(),
            RtTurnClaimOutcome::Ready(_)
        ));
    }

    #[test]
    fn reopened_pre_v8_running_collision_recovers_only_the_oldest_owner() {
        let dir = tempfile::tempdir().unwrap();
        let db = ThreadsDb::open(dir.path()).unwrap();
        create_rt_thread(&db, "org", "winner");
        create_rt_thread(&db, "org", "loser");
        for (thread_id, workflow_id, claim_token, at) in [
            ("winner", "legacy-running-winner", "winner-claim", 1),
            ("loser", "legacy-running-loser", "loser-claim", 2),
        ] {
            let fence = db
                .rt_thread_fence_in_org("org", thread_id)
                .unwrap()
                .unwrap();
            let user = serde_json::json!({
                "id": "shared-running-user",
                "role": "user",
                "parts": [{"type": "text", "text": thread_id}],
            });
            db.lock()
                .execute(
                    "INSERT INTO native_scoped_turn_queue (\
                        account_scope, organization_id, thread_id, thread_generation, message_id, \
                        assistant_message_id, workflow_id, task_id, normalized_input_json, \
                        user_message_json, enqueued_at, fifo_ordinal, state, claim_token\
                     ) VALUES (?1, 'org', ?2, ?3, 'shared-running-user', \
                               'msg-shared-running-user-assistant', ?4, ?2, '{}', ?5, ?6, 1, \
                               'running', ?7)",
                    params![
                        fence.account_scope,
                        thread_id,
                        fence.generation,
                        workflow_id,
                        user.to_string(),
                        at,
                        claim_token,
                    ],
                )
                .unwrap();
        }
        drop(db);

        let db = ThreadsDb::open(dir.path()).unwrap();
        let recovered = db.rt_list_orphaned_active_turns_isolated().unwrap();
        assert_eq!(recovered.len(), 2);
        let winner = recovered
            .iter()
            .find_map(|turn| match turn {
                RtOrphanedTurn::Ready(turn) if turn.fence.thread_id == "winner" => {
                    Some(turn.clone())
                }
                _ => None,
            })
            .expect("oldest reservation remains recoverable");
        let loser = recovered
            .iter()
            .find_map(|turn| match turn {
                RtOrphanedTurn::Malformed(turn) if turn.fence.thread_id == "loser" => {
                    Some(turn.clone())
                }
                _ => None,
            })
            .expect("newer duplicate is quarantined before harness recovery");
        assert!(loser.error.contains("reservation collision"));
        assert!(loser.canonical_user.is_none());
        assert_eq!(
            db.rt_finalize_malformed_orphan(
                &loser,
                &serde_json::json!([{"type": "text", "text": "must not persist"}]),
                None,
            )
            .unwrap(),
            RtTurnTerminalOutcome::Quarantined
        );
        assert!(db
            .rt_list_messages_in_org("org", "loser", 100, 0, false)
            .unwrap()
            .0
            .is_empty());

        db.rt_begin_claimed_turn(&winner).unwrap();
        assert!(matches!(
            db.rt_finalize_claimed_turn(
                &winner,
                &serde_json::json!([{"type": "text", "text": "interrupted"}]),
                Some(&serde_json::json!({"finishReason": "error"})),
                RtTurnTerminalStatus::Failed,
            )
            .unwrap(),
            RtTurnTerminalOutcome::Completed(_)
        ));
        assert_eq!(
            db.rt_list_messages_in_org("org", "winner", 100, 0, false)
                .unwrap()
                .0
                .iter()
                .map(|message| message.role.as_str())
                .collect::<Vec<_>>(),
            ["user", "assistant"]
        );
    }

    #[test]
    fn durable_turn_claim_is_fifo_and_atomic_completion_is_claim_fenced() {
        let db = ThreadsDb::open_in_memory().unwrap();
        create_rt_thread(&db, "org", "thread");
        for (id, at) in [("m1", 1), ("m2", 2)] {
            db.rt_enqueue_turn_in_org("org", "thread", &turn_input(id, id, at))
                .unwrap();
        }

        let first = db
            .rt_claim_turn_queue_head_in_org("org", "thread")
            .unwrap()
            .unwrap();
        assert_eq!(first.message_id, "m1");
        assert_eq!(first.state, RtTurnQueueState::Running);
        assert!(first.claim_token.is_some());
        assert!(db
            .rt_claim_turn_queue_head_in_org("org", "thread")
            .unwrap()
            .is_none());

        let mut forged = first.clone();
        forged.claim_token = Some("stale-owner".to_string());
        assert_eq!(
            db.rt_finalize_claimed_turn(
                &forged,
                &serde_json::json!([]),
                None,
                RtTurnTerminalStatus::Completed,
            )
            .unwrap(),
            RtTurnTerminalOutcome::Stale
        );
        assert!(matches!(
            db.rt_begin_claimed_turn(&first).unwrap(),
            RtTurnBeginOutcome::Begun(_)
        ));
        assert!(matches!(
            db.rt_finalize_claimed_turn(
                &first,
                &serde_json::json!([]),
                None,
                RtTurnTerminalStatus::Completed,
            )
            .unwrap(),
            RtTurnTerminalOutcome::Completed(_)
        ));
        assert_eq!(
            db.rt_finalize_claimed_turn(
                &first,
                &serde_json::json!([]),
                None,
                RtTurnTerminalStatus::Completed,
            )
            .unwrap(),
            RtTurnTerminalOutcome::Stale
        );

        let second = ready_claim(
            db.rt_claim_turn_queue_head_fenced(&first.fence)
                .unwrap()
                .unwrap(),
        );
        assert_eq!(second.message_id, "m2");
        assert!(matches!(
            db.rt_begin_claimed_turn(&second).unwrap(),
            RtTurnBeginOutcome::Begun(_)
        ));
        assert!(matches!(
            db.rt_finalize_claimed_turn(
                &second,
                &serde_json::json!([]),
                None,
                RtTurnTerminalStatus::Completed,
            )
            .unwrap(),
            RtTurnTerminalOutcome::Completed(_)
        ));
        assert!(db
            .rt_list_turn_queue_in_org("org", "thread")
            .unwrap()
            .is_empty());
    }

    #[test]
    fn terminal_commit_atomically_persists_assistant_status_and_queue_removal() {
        let db = ThreadsDb::open_in_memory().unwrap();
        create_rt_thread(&db, "org", "thread");
        db.rt_enqueue_turn_in_org("org", "thread", &turn_input("m1", "first", 1))
            .unwrap();
        let claimed = db
            .rt_claim_turn_queue_head_in_org("org", "thread")
            .unwrap()
            .unwrap();
        assert!(matches!(
            db.rt_begin_claimed_turn(&claimed).unwrap(),
            RtTurnBeginOutcome::Begun(_)
        ));
        let parts = serde_json::json!([{"type": "text", "text": "done"}]);
        let metadata = serde_json::json!({"finishReason": "stop"});
        let assistant_id = claimed_assistant_id(&claimed);

        let assistant = match db
            .rt_finalize_claimed_turn(
                &claimed,
                &parts,
                Some(&metadata),
                RtTurnTerminalStatus::Completed,
            )
            .unwrap()
        {
            RtTurnTerminalOutcome::Completed(message) => message,
            RtTurnTerminalOutcome::Quarantined => panic!("healthy claim must not quarantine"),
            RtTurnTerminalOutcome::Stale => panic!("current claim must complete"),
        };
        assert_eq!(assistant.id, assistant_id);
        assert_eq!(assistant.role, "assistant");
        assert_eq!(assistant.parts, parts);
        assert_eq!(assistant.metadata, Some(metadata));
        assert_eq!(
            db.rt_get_thread("thread").unwrap().unwrap().status,
            "completed"
        );
        assert!(db
            .rt_list_turn_queue_in_org("org", "thread")
            .unwrap()
            .is_empty());

        assert_eq!(
            db.rt_finalize_claimed_turn(
                &claimed,
                &assistant.parts,
                assistant.metadata.as_ref(),
                RtTurnTerminalStatus::Completed,
            )
            .unwrap(),
            RtTurnTerminalOutcome::Stale,
            "once the claim row is gone an old worker cannot mutate status again"
        );
    }

    #[test]
    fn begin_claim_atomically_persists_queued_user_and_in_progress_status() {
        let db = ThreadsDb::open_in_memory().unwrap();
        create_rt_thread(&db, "org", "thread");
        let mut input = turn_input("m1", "first", 1);
        input.user_message["metadata"] = serde_json::json!({"source": "queue"});
        db.rt_enqueue_turn_in_org("org", "thread", &input).unwrap();
        let claimed = db
            .rt_claim_turn_queue_head_in_org("org", "thread")
            .unwrap()
            .unwrap();

        let first = match db.rt_begin_claimed_turn(&claimed).unwrap() {
            RtTurnBeginOutcome::Begun(message) => message,
            other => panic!("expected begun user message, got {other:?}"),
        };
        assert_eq!(first.id, "m1");
        assert_eq!(first.role, "user");
        assert_eq!(first.metadata, Some(serde_json::json!({"source": "queue"})));
        assert_eq!(
            db.rt_get_thread("thread").unwrap().unwrap().status,
            "in_progress"
        );
        assert_eq!(
            db.rt_begin_claimed_turn(&claimed).unwrap(),
            RtTurnBeginOutcome::Begun(first.clone()),
            "an identical retry validates the existing user without duplicating it"
        );
        assert_eq!(
            db.rt_list_messages_in_org("org", "thread", 100, 0, false)
                .unwrap()
                .0,
            [first]
        );
        assert_eq!(
            db.rt_list_turn_queue_in_org("org", "thread")
                .unwrap()
                .as_slice(),
            std::slice::from_ref(&claimed),
            "begin never removes the active claim"
        );
    }

    #[test]
    fn begin_claim_cancellation_or_stale_owner_writes_nothing() {
        let db = ThreadsDb::open_in_memory().unwrap();
        create_rt_thread(&db, "org", "thread");
        db.rt_enqueue_turn_in_org("org", "thread", &turn_input("m1", "first", 1))
            .unwrap();
        let claimed = db
            .rt_claim_turn_queue_head_in_org("org", "thread")
            .unwrap()
            .unwrap();
        let initial_status = db.rt_get_thread("thread").unwrap().unwrap().status;
        let mut stale = claimed.clone();
        stale.claim_token = Some("other-owner".to_string());
        assert_eq!(
            db.rt_begin_claimed_turn(&stale).unwrap(),
            RtTurnBeginOutcome::Stale
        );
        assert!(db.rt_get_message_in_org("org", "m1").unwrap().is_none());
        assert_eq!(
            db.rt_get_thread("thread").unwrap().unwrap().status,
            initial_status
        );

        db.rt_cancel_turn_in_org("org", "thread", &claimed.workflow_id)
            .unwrap();
        assert_eq!(
            db.rt_begin_claimed_turn(&claimed).unwrap(),
            RtTurnBeginOutcome::CancelRequested
        );
        assert!(db.rt_get_message_in_org("org", "m1").unwrap().is_none());
        assert_eq!(
            db.rt_get_thread("thread").unwrap().unwrap().status,
            initial_status
        );
    }

    #[test]
    fn begin_claim_rolls_back_user_when_status_update_fails() {
        let db = ThreadsDb::open_in_memory().unwrap();
        create_rt_thread(&db, "org", "thread");
        db.rt_enqueue_turn_in_org("org", "thread", &turn_input("m1", "first", 1))
            .unwrap();
        let claimed = db
            .rt_claim_turn_queue_head_in_org("org", "thread")
            .unwrap()
            .unwrap();
        let initial_status = db.rt_get_thread("thread").unwrap().unwrap().status;
        db.lock()
            .execute_batch(
                "CREATE TEMP TRIGGER begin_status_failure \
                 BEFORE UPDATE OF status ON native_scoped_threads \
                 BEGIN SELECT RAISE(ABORT, 'forced begin status failure'); END",
            )
            .unwrap();

        assert!(matches!(
            db.rt_begin_claimed_turn(&claimed),
            Err(DbError::Sqlite(_))
        ));
        db.lock()
            .execute_batch("DROP TRIGGER begin_status_failure")
            .unwrap();
        assert!(db.rt_get_message_in_org("org", "m1").unwrap().is_none());
        assert_eq!(
            db.rt_get_thread("thread").unwrap().unwrap().status,
            initial_status
        );
        assert_eq!(
            db.rt_list_turn_queue_in_org("org", "thread")
                .unwrap()
                .as_slice(),
            std::slice::from_ref(&claimed)
        );
    }

    #[test]
    fn terminal_commit_cancel_before_begin_persists_user_then_assistant() {
        let db = ThreadsDb::open_in_memory().unwrap();
        create_rt_thread(&db, "org", "thread");
        db.rt_enqueue_turn_in_org("org", "thread", &turn_input("m1", "first", 1))
            .unwrap();
        let claimed = db
            .rt_claim_turn_queue_head_in_org("org", "thread")
            .unwrap()
            .unwrap();
        let assistant_id = claimed_assistant_id(&claimed);
        assert!(matches!(
            db.rt_cancel_turn_in_org("org", "thread", &claimed.workflow_id)
                .unwrap(),
            RtTurnCancelOutcome::ActiveCancelRequested(_)
        ));

        assert!(matches!(
            db.rt_finalize_claimed_turn(
                &claimed,
                &serde_json::json!([]),
                Some(&serde_json::json!({"cancelled": true})),
                RtTurnTerminalStatus::Failed,
            )
            .unwrap(),
            RtTurnTerminalOutcome::Completed(_)
        ));
        assert_eq!(
            db.rt_get_thread("thread").unwrap().unwrap().status,
            "failed"
        );
        let messages = db
            .rt_list_messages_in_org("org", "thread", 100, 0, false)
            .unwrap()
            .0;
        assert_eq!(messages.len(), 2);
        assert_eq!(
            (messages[0].id.as_str(), messages[0].role.as_str()),
            ("m1", "user")
        );
        assert_eq!(
            (
                messages[1].id.as_str(),
                messages[1].role.as_str(),
                messages[1].metadata.as_ref(),
            ),
            (
                assistant_id.as_str(),
                "assistant",
                Some(&serde_json::json!({"cancelled": true})),
            )
        );
        assert!(
            messages[0].seq < messages[1].seq,
            "the accepted user must precede its cancellation assistant"
        );
        assert!(db
            .rt_list_turn_queue_in_org("org", "thread")
            .unwrap()
            .is_empty());
    }

    #[test]
    fn terminal_commit_recovers_an_exact_existing_assistant_without_duplication() {
        let db = ThreadsDb::open_in_memory().unwrap();
        create_rt_thread(&db, "org", "thread");
        db.rt_enqueue_turn_in_org("org", "thread", &turn_input("m1", "first", 1))
            .unwrap();
        let claimed = db
            .rt_claim_turn_queue_head_in_org("org", "thread")
            .unwrap()
            .unwrap();
        let parts = serde_json::json!([{"type": "text", "text": "Should I keep going?"}]);
        let metadata = serde_json::json!({"finishReason": "stop"});
        let assistant_id = claimed_assistant_id(&claimed);
        assert!(matches!(
            db.rt_begin_claimed_turn(&claimed).unwrap(),
            RtTurnBeginOutcome::Begun(_)
        ));
        let existing = db
            .rt_append_message(
                &assistant_id,
                &claimed.fence.thread_id,
                "assistant",
                &parts,
                Some(&metadata),
            )
            .unwrap();

        let recovered = match db
            .rt_finalize_claimed_turn(
                &claimed,
                &parts,
                Some(&metadata),
                RtTurnTerminalStatus::RequiresAction,
            )
            .unwrap()
        {
            RtTurnTerminalOutcome::Completed(message) => message,
            RtTurnTerminalOutcome::Quarantined => panic!("healthy claim must not quarantine"),
            RtTurnTerminalOutcome::Stale => panic!("orphan claim is still owned"),
        };
        assert_eq!(recovered, existing, "existing row remains byte-identical");
        assert_eq!(
            db.rt_list_messages_in_org("org", "thread", 100, 0, false)
                .unwrap()
                .0
                .iter()
                .filter(|message| message.id == assistant_id)
                .count(),
            1
        );
        assert_eq!(
            db.rt_get_thread("thread").unwrap().unwrap().status,
            "requires_action",
            "exact-pair crash adoption must preserve the resolved pause status"
        );
        assert!(db
            .rt_list_turn_queue_in_org("org", "thread")
            .unwrap()
            .is_empty());
    }

    #[test]
    fn terminal_commit_stale_claim_changes_nothing() {
        let db = ThreadsDb::open_in_memory().unwrap();
        create_rt_thread(&db, "org", "thread");
        db.rt_enqueue_turn_in_org("org", "thread", &turn_input("m1", "first", 1))
            .unwrap();
        let claimed = db
            .rt_claim_turn_queue_head_in_org("org", "thread")
            .unwrap()
            .unwrap();
        assert!(matches!(
            db.rt_begin_claimed_turn(&claimed).unwrap(),
            RtTurnBeginOutcome::Begun(_)
        ));
        let mut stale = claimed.clone();
        let assistant_id = claimed_assistant_id(&claimed);
        stale.claim_token = Some("not-the-owner".to_string());

        assert_eq!(
            db.rt_finalize_claimed_turn(
                &stale,
                &serde_json::json!([]),
                None,
                RtTurnTerminalStatus::Completed,
            )
            .unwrap(),
            RtTurnTerminalOutcome::Stale
        );
        assert!(db
            .rt_get_message_in_org("org", &assistant_id)
            .unwrap()
            .is_none());
        assert_eq!(
            db.rt_get_thread("thread").unwrap().unwrap().status,
            "in_progress"
        );
        assert_eq!(
            db.rt_list_turn_queue_in_org("org", "thread")
                .unwrap()
                .as_slice(),
            std::slice::from_ref(&claimed)
        );

        let mut malformed_claim = claimed;
        malformed_claim.claim_token = None;
        assert!(matches!(
            db.rt_finalize_claimed_turn(
                &malformed_claim,
                &serde_json::json!([]),
                None,
                RtTurnTerminalStatus::Completed,
            ),
            Err(DbError::InvalidQueueData(_))
        ));
    }

    #[test]
    fn terminal_commit_conflict_rolls_back_status_and_queue_delete() {
        let db = ThreadsDb::open_in_memory().unwrap();
        create_rt_thread(&db, "org", "thread");
        db.rt_enqueue_turn_in_org("org", "thread", &turn_input("m1", "first", 1))
            .unwrap();
        let claimed = db
            .rt_claim_turn_queue_head_in_org("org", "thread")
            .unwrap()
            .unwrap();
        let assistant_id = claimed_assistant_id(&claimed);
        assert!(matches!(
            db.rt_begin_claimed_turn(&claimed).unwrap(),
            RtTurnBeginOutcome::Begun(_)
        ));
        db.rt_append_message(
            &assistant_id,
            &claimed.fence.thread_id,
            "assistant",
            &serde_json::json!([{"type": "text", "text": "original"}]),
            None,
        )
        .unwrap();

        assert!(matches!(
            db.rt_finalize_claimed_turn(
                &claimed,
                &serde_json::json!([{"type": "text", "text": "conflict"}]),
                None,
                RtTurnTerminalStatus::Completed,
            ),
            Err(DbError::IdempotencyConflict {
                entity: "rt_message",
                ref id,
            }) if id == &assistant_id
        ));
        assert_eq!(
            db.rt_get_thread("thread").unwrap().unwrap().status,
            "in_progress"
        );
        assert_eq!(
            db.rt_list_turn_queue_in_org("org", "thread")
                .unwrap()
                .as_slice(),
            std::slice::from_ref(&claimed)
        );
        assert_eq!(
            db.rt_get_message_in_org("org", &assistant_id)
                .unwrap()
                .unwrap()
                .parts,
            serde_json::json!([{"type": "text", "text": "original"}])
        );
    }

    #[test]
    fn terminal_commit_rolls_back_assistant_when_status_or_delete_fails() {
        for failure_point in ["status", "delete"] {
            let db = ThreadsDb::open_in_memory().unwrap();
            create_rt_thread(&db, "org", "thread");
            db.rt_enqueue_turn_in_org("org", "thread", &turn_input("m1", "first", 1))
                .unwrap();
            let claimed = db
                .rt_claim_turn_queue_head_in_org("org", "thread")
                .unwrap()
                .unwrap();
            let assistant_id = claimed_assistant_id(&claimed);
            assert!(matches!(
                db.rt_begin_claimed_turn(&claimed).unwrap(),
                RtTurnBeginOutcome::Begun(_)
            ));
            let trigger = match failure_point {
                "status" => {
                    "CREATE TEMP TRIGGER terminal_failure \
                     BEFORE UPDATE OF status ON native_scoped_threads \
                     BEGIN SELECT RAISE(ABORT, 'forced status failure'); END"
                }
                "delete" => {
                    "CREATE TEMP TRIGGER terminal_failure \
                     BEFORE DELETE ON native_scoped_turn_queue \
                     BEGIN SELECT RAISE(ABORT, 'forced delete failure'); END"
                }
                _ => unreachable!(),
            };
            db.lock().execute_batch(trigger).unwrap();

            assert!(matches!(
                db.rt_finalize_claimed_turn(
                    &claimed,
                    &serde_json::json!([{"type": "text", "text": "must roll back"}]),
                    None,
                    RtTurnTerminalStatus::Completed,
                ),
                Err(DbError::Sqlite(_))
            ));
            db.lock()
                .execute_batch("DROP TRIGGER terminal_failure")
                .unwrap();
            assert!(db
                .rt_get_message_in_org("org", &assistant_id)
                .unwrap()
                .is_none());
            assert_eq!(
                db.rt_get_thread("thread").unwrap().unwrap().status,
                "in_progress",
                "{failure_point} failure must roll back the status write"
            );
            assert_eq!(
                db.rt_list_turn_queue_in_org("org", "thread")
                    .unwrap()
                    .as_slice(),
                std::slice::from_ref(&claimed),
                "{failure_point} failure must retain the owned claim"
            );
        }
    }

    #[test]
    fn durable_turn_cancel_removes_queued_and_marks_active() {
        let db = ThreadsDb::open_in_memory().unwrap();
        create_rt_thread(&db, "org", "thread");
        for (id, at) in [("m1", 1), ("m2", 2)] {
            db.rt_enqueue_turn_in_org("org", "thread", &turn_input(id, id, at))
                .unwrap();
        }
        let active = db
            .rt_claim_turn_queue_head_in_org("org", "thread")
            .unwrap()
            .unwrap();
        assert!(matches!(
            db.rt_cancel_turn_in_org("org", "thread", "workflow-m2")
                .unwrap(),
            RtTurnCancelOutcome::QueuedDeleted(item) if item.message_id == "m2"
        ));
        let interrupted = match db
            .rt_cancel_turn_in_org("org", "thread", "workflow-m1")
            .unwrap()
        {
            RtTurnCancelOutcome::ActiveCancelRequested(item) => item,
            other => panic!("expected active cancellation, got {other:?}"),
        };
        assert_eq!(interrupted.state, RtTurnQueueState::CancelRequested);
        assert_eq!(interrupted.claim_token, active.claim_token);
        assert!(matches!(
            db.rt_finalize_claimed_turn(
                &interrupted,
                &serde_json::json!([]),
                Some(&serde_json::json!({"cancelled": true})),
                RtTurnTerminalStatus::Failed,
            )
            .unwrap(),
            RtTurnTerminalOutcome::Completed(_)
        ));
        assert!(matches!(
            db.rt_cancel_turn_in_org("org", "thread", "missing")
                .unwrap(),
            RtTurnCancelOutcome::NotFound
        ));
    }

    #[test]
    fn cancel_all_prevents_tail_promotion_and_preserves_active_for_signal() {
        let db = ThreadsDb::open_in_memory().unwrap();
        create_rt_thread(&db, "org", "thread");
        for (id, at) in [("m1", 1), ("m2", 2), ("m3", 3)] {
            db.rt_enqueue_turn_in_org("org", "thread", &turn_input(id, id, at))
                .unwrap();
        }
        let active = db
            .rt_claim_turn_queue_head_in_org("org", "thread")
            .unwrap()
            .unwrap();
        let outcome = db.rt_cancel_all_turns_in_org(&active.fence).unwrap();
        assert_eq!(
            outcome.queued_retained_workflow_ids,
            ["workflow-m2", "workflow-m3"]
        );
        assert_eq!(outcome.active_workflow_ids, ["workflow-m1"]);
        let remaining = db.rt_list_turn_queue_in_org("org", "thread").unwrap();
        assert_eq!(remaining.len(), 3);
        assert_eq!(remaining[0].state, RtTurnQueueState::CancelRequested);
        assert!(remaining[1..]
            .iter()
            .all(|item| item.state == RtTurnQueueState::Queued));
        assert!(db
            .rt_claim_turn_queue_head_in_org("org", "thread")
            .unwrap()
            .is_none());
    }

    #[test]
    fn failed_thread_delete_retains_accepted_tails_and_stays_durably_closed() {
        let dir = tempfile::tempdir().unwrap();
        let db = ThreadsDb::open(dir.path()).unwrap();
        create_rt_thread(&db, "org", "thread");
        for (id, at) in [("m1", 1), ("m2", 2)] {
            db.rt_enqueue_turn_in_org("org", "thread", &turn_input(id, id, at))
                .unwrap();
        }
        let fence = db.rt_thread_fence_in_org("org", "thread").unwrap().unwrap();
        assert!(db.rt_mark_thread_delete_pending(&fence).unwrap());
        let cancelled = db.rt_cancel_all_turns_in_org(&fence).unwrap();
        assert_eq!(
            cancelled.queued_retained_workflow_ids,
            ["workflow-m1", "workflow-m2"]
        );
        assert!(db
            .rt_claim_turn_queue_head_fenced(&fence)
            .unwrap()
            .is_none());
        assert!(matches!(
            db.rt_enqueue_turn_in_org("org", "thread", &turn_input("m3", "blocked", 3)),
            Err(DbError::ThreadDeletePending { .. })
        ));

        db.lock()
            .execute_batch(
                "CREATE TEMP TRIGGER injected_thread_delete_failure \
                 BEFORE DELETE ON native_scoped_threads \
                 BEGIN SELECT RAISE(ABORT, 'injected delete failure'); END",
            )
            .unwrap();
        assert!(matches!(
            db.rt_delete_thread_in_org_if_generation(&fence),
            Err(DbError::Sqlite(_))
        ));
        assert!(db.rt_thread_delete_pending(&fence).unwrap());
        assert_eq!(
            db.rt_list_turn_queue_in_org("org", "thread").unwrap().len(),
            2,
            "a failed final cascade must retain every accepted tail"
        );

        drop(db);
        let db = ThreadsDb::open(dir.path()).unwrap();
        assert!(matches!(
            db.rt_create_thread(
                Some("thread"),
                "org",
                "must stay closed",
                None,
                "vmcp",
                None,
                "user",
            ),
            Err(DbError::ThreadDeletePending { .. })
        ));
        assert!(matches!(
            db.rt_update_thread_in_org(
                "org",
                "thread",
                "user",
                &RtThreadPatch {
                    title: Some("must not update".to_string()),
                    ..RtThreadPatch::default()
                },
            ),
            Err(DbError::ThreadDeletePending { .. })
        ));
        assert_eq!(
            db.rt_get_thread("thread").unwrap().unwrap().title,
            "",
            "GET stays available so the caller can retry DELETE"
        );
        assert_eq!(
            db.rt_list_turn_queue_in_org("org", "thread").unwrap().len(),
            2,
            "reopen must not consume accepted tails"
        );
        assert!(db.rt_delete_thread_in_org_if_generation(&fence).unwrap());
        assert_eq!(
            db.lock()
                .query_row("SELECT COUNT(*) FROM native_scoped_turn_queue", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            0
        );
    }

    #[test]
    fn recovery_never_reclaims_a_possibly_side_effecting_orphan() {
        let db = ThreadsDb::open_in_memory().unwrap();
        create_rt_thread(&db, "org", "thread-a");
        create_rt_thread(&db, "org", "thread-b");
        for (id, at) in [("a1", 1), ("a2", 2)] {
            db.rt_enqueue_turn_in_org("org", "thread-a", &turn_input(id, id, at))
                .unwrap();
        }
        db.rt_enqueue_turn_in_org("org", "thread-b", &turn_input("b1", "b1", 3))
            .unwrap();
        let orphan = db
            .rt_claim_turn_queue_head_in_org("org", "thread-a")
            .unwrap()
            .unwrap();

        assert_eq!(
            db.rt_list_orphaned_active_turns_isolated().unwrap(),
            [RtOrphanedTurn::Ready(orphan.clone())]
        );
        assert!(db
            .rt_claim_turn_queue_head_in_org("org", "thread-a")
            .unwrap()
            .is_none());
        let recoverable = db.rt_list_recoverable_turn_queues().unwrap();
        assert_eq!(
            recoverable
                .iter()
                .map(|fence| fence.thread_id.as_str())
                .collect::<Vec<_>>(),
            ["thread-a", "thread-b"]
        );

        assert!(matches!(
            db.rt_begin_claimed_turn(&orphan).unwrap(),
            RtTurnBeginOutcome::Begun(_)
        ));
        assert!(matches!(
            db.rt_finalize_claimed_turn(
                &orphan,
                &serde_json::json!([{"type": "text", "text": "interrupted"}]),
                Some(&serde_json::json!({"interrupted": true})),
                RtTurnTerminalStatus::Failed,
            )
            .unwrap(),
            RtTurnTerminalOutcome::Completed(_)
        ));
        assert_eq!(
            db.rt_claim_turn_queue_head_in_org("org", "thread-a")
                .unwrap()
                .unwrap()
                .message_id,
            "a2"
        );
    }

    #[test]
    fn malformed_orphan_is_isolated_and_can_be_finalized_without_bricking_others() {
        let db = ThreadsDb::open_in_memory().unwrap();
        create_rt_thread(&db, "org", "broken-thread");
        create_rt_thread(&db, "org", "healthy-thread");
        for (id, at) in [("broken-1", 1), ("broken-2", 2)] {
            db.rt_enqueue_turn_in_org("org", "broken-thread", &turn_input(id, id, at))
                .unwrap();
        }
        db.rt_enqueue_turn_in_org(
            "org",
            "healthy-thread",
            &turn_input("healthy-1", "healthy", 3),
        )
        .unwrap();
        let broken_claim = db
            .rt_claim_turn_queue_head_in_org("org", "broken-thread")
            .unwrap()
            .unwrap();
        let healthy_claim = db
            .rt_claim_turn_queue_head_in_org("org", "healthy-thread")
            .unwrap()
            .unwrap();
        db.lock()
            .execute(
                "UPDATE native_scoped_turn_queue SET user_message_json = '{broken-json' \
                 WHERE workflow_id = ?1",
                [&broken_claim.workflow_id],
            )
            .unwrap();

        let isolated = db.rt_list_orphaned_active_turns_isolated().unwrap();
        assert_eq!(isolated.len(), 2);
        let malformed = isolated
            .iter()
            .find_map(|item| match item {
                RtOrphanedTurn::Malformed(item) => Some(item.clone()),
                RtOrphanedTurn::Ready(_) => None,
            })
            .expect("broken row must be returned with its claim identity");
        assert_eq!(malformed.workflow_id, broken_claim.workflow_id);
        assert!(malformed.error.contains("json error"));
        assert!(isolated
            .iter()
            .any(|item| matches!(item, RtOrphanedTurn::Ready(item) if item == &healthy_claim)));

        let mut stale = malformed.clone();
        stale.claim_token = Some("other-owner".to_string());
        assert_eq!(
            db.rt_finalize_malformed_orphan(
                &stale,
                &serde_json::json!([{"type": "text", "text": "must not persist"}]),
                None,
            )
            .unwrap(),
            RtTurnTerminalOutcome::Stale
        );

        assert_eq!(
            db.rt_finalize_malformed_orphan(
                &malformed,
                &serde_json::json!([{"type": "text", "text": "must not persist"}]),
                None,
            )
            .unwrap(),
            RtTurnTerminalOutcome::Quarantined
        );
        assert!(db
            .rt_list_messages_in_org("org", "broken-thread", 100, 0, false)
            .unwrap()
            .0
            .is_empty());
        assert_eq!(
            db.rt_get_thread("broken-thread").unwrap().unwrap().status,
            "failed"
        );
        assert_eq!(
            db.rt_list_orphaned_active_turns_isolated().unwrap(),
            [RtOrphanedTurn::Ready(healthy_claim)],
            "the unrelated healthy orphan remains recoverable"
        );
        assert_eq!(
            db.rt_claim_turn_queue_head_in_org("org", "broken-thread")
                .unwrap()
                .unwrap()
                .message_id,
            "broken-2",
            "quarantining the corrupt head unblocks only its own safe tail"
        );
    }

    #[test]
    fn durable_turn_queue_survives_database_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let expected_claim = {
            let db = ThreadsDb::open(dir.path()).unwrap();
            create_rt_thread(&db, "org", "thread");
            for (id, at) in [("m1", 1), ("m2", 2)] {
                db.rt_enqueue_turn_in_org("org", "thread", &turn_input(id, id, at))
                    .unwrap();
            }
            db.rt_claim_turn_queue_head_in_org("org", "thread")
                .unwrap()
                .unwrap()
        };

        let reopened = ThreadsDb::open(dir.path()).unwrap();
        assert_eq!(
            reopened.rt_list_orphaned_active_turns_isolated().unwrap(),
            [RtOrphanedTurn::Ready(expected_claim)]
        );
        let queue = reopened.rt_list_turn_queue_in_org("org", "thread").unwrap();
        assert_eq!(
            queue
                .iter()
                .map(|item| (item.message_id.as_str(), item.state))
                .collect::<Vec<_>>(),
            [
                ("m1", RtTurnQueueState::Running),
                ("m2", RtTurnQueueState::Queued),
            ]
        );
        assert!(reopened
            .rt_claim_turn_queue_head_in_org("org", "thread")
            .unwrap()
            .is_none());
    }

    #[test]
    fn complete_thread_reads_are_generation_fenced() {
        let db = ThreadsDb::open_in_memory().unwrap();
        create_rt_thread(&db, "org", "thread");
        let fence = db.rt_thread_fence_in_org("org", "thread").unwrap().unwrap();

        let current = db.rt_thread_fenced(&fence).unwrap().unwrap();
        assert_eq!(current.id, "thread");
        assert_eq!(current.organization_id, "org");
        assert_eq!(current.virtual_mcp_id, "vmcp");
        assert_eq!(current.created_by, "user");

        let mut stale = fence;
        stale.generation = "stale-generation".to_string();
        assert!(db.rt_thread_fenced(&stale).unwrap().is_none());
    }

    #[test]
    fn harness_pin_reads_are_generation_fenced() {
        let db = ThreadsDb::open_in_memory().unwrap();
        create_rt_thread(&db, "org", "thread");
        let fence = db.rt_thread_fence_in_org("org", "thread").unwrap().unwrap();

        assert_eq!(db.rt_harness_id_fenced(&fence).unwrap(), Some(None));
        assert!(db
            .rt_pin_harness_if_unset_fenced(&fence, "codex", None, None)
            .unwrap());
        assert_eq!(
            db.rt_harness_id_fenced(&fence).unwrap(),
            Some(Some("codex".to_string()))
        );

        let mut stale = fence;
        stale.generation = "stale-generation".to_string();
        assert_eq!(db.rt_harness_id_fenced(&stale).unwrap(), None);
    }

    #[test]
    fn thread_generation_fences_old_worker_writes_and_delete_retires_id() {
        let db = ThreadsDb::open_in_memory().unwrap();
        create_rt_thread(&db, "org", "thread");
        let old_fence = db.rt_thread_fence_in_org("org", "thread").unwrap().unwrap();
        assert!(db
            .lock()
            .execute(
                "UPDATE native_scoped_threads SET generation = 'forged' WHERE id = 'thread'",
                [],
            )
            .is_err());
        db.rt_enqueue_turn_in_org("org", "thread", &turn_input("m1", "old", 1))
            .unwrap();
        let old_claim = db
            .rt_claim_turn_queue_head_in_org("org", "thread")
            .unwrap()
            .unwrap();
        let stale_assistant_id = claimed_assistant_id(&old_claim);
        assert!(db
            .rt_delete_thread_in_org_if_generation(&old_fence)
            .unwrap());
        assert!(db
            .rt_list_turn_queue_in_org("org", "thread")
            .unwrap()
            .is_empty());
        assert_eq!(
            db.lock()
                .query_row("SELECT COUNT(*) FROM native_scoped_turn_queue", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            0,
            "thread deletion must physically cascade its durable queue rows"
        );
        assert!(!db
            .rt_pin_harness_if_unset_fenced(&old_fence, "claude-code", Some("user-desktop"), None,)
            .unwrap());
        assert_eq!(
            db.rt_last_assistant_session_fenced(&old_fence, "claude-code")
                .unwrap(),
            None
        );
        assert!(!db
            .rt_delete_thread_in_org_if_generation(&old_fence)
            .unwrap());
        assert_eq!(
            db.rt_finalize_claimed_turn(
                &old_claim,
                &serde_json::json!([]),
                None,
                RtTurnTerminalStatus::Failed,
            )
            .unwrap(),
            RtTurnTerminalOutcome::Stale
        );
        assert!(db
            .rt_get_message_in_org("org", &stale_assistant_id)
            .unwrap()
            .is_none());
        assert!(db.rt_get_thread("thread").unwrap().is_none());
        assert!(db
            .rt_claim_turn_queue_head_fenced(&old_fence)
            .unwrap()
            .is_none());

        assert!(matches!(
            db.rt_create_thread(
                Some("thread"),
                "org",
                "must stay deleted",
                None,
                "vmcp",
                None,
                "user",
            ),
            Err(DbError::RetiredThreadId { ref thread_id, .. }) if thread_id == "thread"
        ));
    }

    #[test]
    fn stale_generation_delete_does_not_tombstone_and_live_create_is_idempotent() {
        let db = ThreadsDb::open_in_memory().unwrap();
        let scope = RtAccountScope::new("studio.decocms.com", "alice").unwrap();
        let first = db
            .rt_create_thread_scoped(
                &scope,
                Some("live-idempotent"),
                "org",
                "original",
                None,
                "vmcp",
                None,
                "alice",
            )
            .unwrap();
        let fence = db
            .rt_thread_fence_in_scope(&scope, "org", &first.id)
            .unwrap()
            .unwrap();

        let mut stale = fence.clone();
        stale.generation = "not-the-live-generation".to_string();
        assert!(!db.rt_delete_thread_in_org_if_generation(&stale).unwrap());
        assert!(
            !rt_thread_is_tombstoned(&db.lock(), &scope.storage_key(), "org", &first.id,).unwrap()
        );

        let duplicate = db
            .rt_create_thread_scoped(
                &scope,
                Some(&first.id),
                "org",
                "ignored retry title",
                None,
                "different-vmcp",
                Some("ignored-branch"),
                "alice",
            )
            .unwrap();
        assert_eq!(duplicate.id, first.id);
        assert_eq!(duplicate.title, "original");
        assert_eq!(
            db.rt_thread_fence_in_scope(&scope, "org", &first.id)
                .unwrap()
                .unwrap(),
            fence,
            "a live idempotent retry must retain the original generation"
        );
    }

    #[test]
    fn retired_thread_ids_are_scoped_by_account_and_organization() {
        let db = ThreadsDb::open_in_memory().unwrap();
        let alice = RtAccountScope::new("studio.decocms.com", "alice").unwrap();
        let bob = RtAccountScope::new("studio.decocms.com", "bob").unwrap();
        let id = "scope-local-retired-id";

        db.rt_create_thread_scoped(
            &alice,
            Some(id),
            "org-a",
            "alice org a",
            None,
            "vmcp",
            None,
            "alice",
        )
        .unwrap();
        let alice_org_a = db
            .rt_thread_fence_in_scope(&alice, "org-a", id)
            .unwrap()
            .unwrap();
        assert!(db
            .rt_delete_thread_in_org_if_generation(&alice_org_a)
            .unwrap());

        // The same account may use the same opaque public id in another org.
        db.rt_create_thread_scoped(
            &alice,
            Some(id),
            "org-b",
            "alice org b",
            None,
            "vmcp",
            None,
            "alice",
        )
        .unwrap();
        let alice_org_b = db
            .rt_thread_fence_in_scope(&alice, "org-b", id)
            .unwrap()
            .unwrap();
        assert!(db
            .rt_delete_thread_in_org_if_generation(&alice_org_b)
            .unwrap());

        // A different signed-in account is an independent local tenant too.
        db.rt_create_thread_scoped(
            &bob,
            Some(id),
            "org-a",
            "bob org a",
            None,
            "vmcp",
            None,
            "bob",
        )
        .unwrap();
        let bob_org_a = db
            .rt_thread_fence_in_scope(&bob, "org-a", id)
            .unwrap()
            .unwrap();
        assert!(db
            .rt_delete_thread_in_org_if_generation(&bob_org_a)
            .unwrap());

        assert!(matches!(
            db.rt_create_thread_scoped(
                &alice,
                Some(id),
                "org-a",
                "must remain retired",
                None,
                "vmcp",
                None,
                "alice",
            ),
            Err(DbError::RetiredThreadId {
                ref organization_id,
                ref thread_id,
                ..
            }) if organization_id == "org-a" && thread_id == id
        ));
    }

    #[test]
    fn rt_append_message_is_idempotent_by_id_and_does_not_consume_seq() {
        let db = ThreadsDb::open_in_memory().unwrap();
        db.rt_create_thread(Some("idem"), "org", "", None, "vmcp", None, "user")
            .unwrap();
        let original_parts = serde_json::json!([{"type": "text", "text": "original"}]);
        let original_metadata = serde_json::json!({"attempt": 1});
        assert!(db.rt_get_message("stable-id").unwrap().is_none());
        let first = db
            .rt_append_message(
                "stable-id",
                "idem",
                "user",
                &original_parts,
                Some(&original_metadata),
            )
            .unwrap();
        assert_eq!(
            db.rt_get_message("stable-id").unwrap().unwrap().seq,
            first.seq
        );
        let updated_after_first = db.rt_get_thread("idem").unwrap().unwrap().updated_at;
        std::thread::sleep(Duration::from_millis(2));
        let repeated = db
            .rt_append_message(
                "stable-id",
                "idem",
                "user",
                &original_parts,
                Some(&original_metadata),
            )
            .unwrap();
        assert_eq!(repeated.role, "user");
        assert_eq!(repeated.parts, original_parts);
        assert_eq!(repeated.metadata, Some(original_metadata));
        assert_eq!(repeated.seq, first.seq);
        assert_eq!(repeated.created_at, first.created_at);
        assert_eq!(
            db.rt_get_thread("idem").unwrap().unwrap().updated_at,
            updated_after_first,
            "an ignored retry must not bump its thread"
        );

        let next = db
            .rt_append_message("next-id", "idem", "assistant", &serde_json::json!([]), None)
            .unwrap();
        assert_eq!(next.seq, first.seq + 1);
        assert_eq!(db.rt_list_messages("idem", 100, 0, false).unwrap().1, 2);
    }

    #[test]
    fn rt_append_message_rejects_same_id_with_different_semantics() {
        let db = ThreadsDb::open_in_memory().unwrap();
        for id in ["original-thread", "different-thread"] {
            db.rt_create_thread(Some(id), "org", "", None, "vmcp", None, "user")
                .unwrap();
        }
        let parts = serde_json::json!([{"type": "text", "text": "original"}]);
        let metadata = serde_json::json!({"attempt": 1});
        db.rt_append_message(
            "stable-id",
            "original-thread",
            "user",
            &parts,
            Some(&metadata),
        )
        .unwrap();

        let conflicts = [
            db.rt_append_message(
                "stable-id",
                "different-thread",
                "user",
                &parts,
                Some(&metadata),
            ),
            db.rt_append_message(
                "stable-id",
                "original-thread",
                "assistant",
                &parts,
                Some(&metadata),
            ),
            db.rt_append_message(
                "stable-id",
                "original-thread",
                "user",
                &serde_json::json!([{"type": "text", "text": "different"}]),
                Some(&metadata),
            ),
            db.rt_append_message(
                "stable-id",
                "original-thread",
                "user",
                &parts,
                Some(&serde_json::json!({"attempt": 2})),
            ),
        ];
        for conflict in conflicts {
            assert!(matches!(
                conflict,
                Err(DbError::IdempotencyConflict {
                    entity: "rt_message",
                    ref id
                }) if id == "stable-id"
            ));
        }
        let (messages, total) = db
            .rt_list_messages("original-thread", 100, 0, false)
            .unwrap();
        assert_eq!(total, 1);
        assert_eq!(messages[0].parts, parts);
        assert_eq!(
            db.rt_list_messages("different-thread", 100, 0, false)
                .unwrap()
                .1,
            0
        );
    }

    #[test]
    fn rt_message_sequence_is_scoped_per_thread() {
        let db = ThreadsDb::open_in_memory().unwrap();
        for id in ["one", "two"] {
            db.rt_create_thread(Some(id), "org", "", None, "vmcp", None, "user")
                .unwrap();
        }
        let one_first = db
            .rt_append_message("one-1", "one", "user", &serde_json::json!([]), None)
            .unwrap();
        let two_first = db
            .rt_append_message("two-1", "two", "user", &serde_json::json!([]), None)
            .unwrap();
        let one_second = db
            .rt_append_message("one-2", "one", "assistant", &serde_json::json!([]), None)
            .unwrap();
        assert_eq!((one_first.seq, two_first.seq, one_second.seq), (1, 1, 2));
    }

    #[test]
    fn rt_list_messages_desc_returns_the_newest_page_not_the_oldest() {
        let db = ThreadsDb::open_in_memory().unwrap();
        db.rt_create_thread(Some("t1"), "org", "", None, "vmcp", None, "user")
            .unwrap();
        // 6 messages (3 turns), appended oldest -> newest.
        for i in 0..6 {
            db.rt_append_message(
                &format!("m{i}"),
                "t1",
                if i % 2 == 0 { "user" } else { "assistant" },
                &serde_json::json!([]),
                None,
            )
            .unwrap();
            std::thread::sleep(Duration::from_millis(2));
        }
        // desc, limit 2 -> the NEWEST 2 (this was the bug: it used to return
        // the oldest 2 regardless, dropping the recent turn out of the window).
        let (page, total) = db.rt_list_messages("t1", 2, 0, true).unwrap();
        assert_eq!(total, 6);
        assert_eq!(
            page.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            vec!["m5", "m4"],
        );
        // asc still returns the oldest page (prior default behavior).
        let (page_asc, _) = db.rt_list_messages("t1", 2, 0, false).unwrap();
        assert_eq!(
            page_asc.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            vec!["m0", "m1"],
        );
    }

    #[test]
    fn rt_list_messages_exposes_monotonic_ascending_seq() {
        // Durable `seq` is insert-order and clock-independent — no
        // sleeps needed (unlike the `created_at`-based ordering test above).
        let db = ThreadsDb::open_in_memory().unwrap();
        db.rt_create_thread(Some("seqt"), "org", "", None, "vmcp", None, "user")
            .unwrap();
        let user = db
            .rt_append_message("mu", "seqt", "user", &serde_json::json!([]), None)
            .unwrap();
        let assistant = db
            .rt_append_message("ma", "seqt", "assistant", &serde_json::json!([]), None)
            .unwrap();
        // `rt_append_message` returns the row's monotonic ordinal: the user
        // turn (inserted first) precedes its assistant reply.
        assert!(
            user.seq < assistant.seq,
            "user row's seq must precede the assistant's"
        );

        // The asc list page carries the same strictly-increasing seq.
        let (page, total) = db.rt_list_messages("seqt", 100, 0, false).unwrap();
        assert_eq!(total, 2);
        assert_eq!(
            page.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            ["mu", "ma"]
        );
        assert!(
            page[0].seq < page[1].seq,
            "asc page seqs must be strictly increasing"
        );

        // The desc page carries the SAME ordinals, just newest-first — so the
        // frontend's seq sort reconstructs identical order regardless of the
        // page direction it fetched.
        let (page_desc, _) = db.rt_list_messages("seqt", 100, 0, true).unwrap();
        assert_eq!(
            page_desc.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            ["ma", "mu"]
        );
        assert!(page_desc[0].seq > page_desc[1].seq);
        // Same underlying ordinals in both directions.
        assert_eq!(page[0].seq, page_desc[1].seq);
        assert_eq!(page[1].seq, page_desc[0].seq);
    }

    #[test]
    fn format_rfc3339_epoch_zero() {
        assert_eq!(format_rfc3339(Duration::ZERO), "1970-01-01T00:00:00.000Z");
    }

    #[test]
    fn format_rfc3339_known_date() {
        // 1704067200 == 2024-01-01T00:00:00Z
        assert_eq!(
            format_rfc3339(Duration::from_millis(1_704_067_200_123)),
            "2024-01-01T00:00:00.123Z"
        );
    }

    #[test]
    fn create_and_get_thread_roundtrip() {
        let db = ThreadsDb::open_in_memory().unwrap();
        let t = db.create_thread("hello".to_string()).unwrap();
        assert_eq!(t.title, "hello");
        assert_eq!(t.created_at, t.updated_at);
        let fetched = db.get_thread(&t.id).unwrap().unwrap();
        assert_eq!(fetched.id, t.id);
        assert_eq!(fetched.title, "hello");
    }

    #[test]
    fn get_unknown_thread_is_none() {
        let db = ThreadsDb::open_in_memory().unwrap();
        assert!(db.get_thread("nope").unwrap().is_none());
    }

    #[test]
    fn list_threads_orders_newest_updated_first() {
        // Millisecond-resolution timestamps: sleep between steps so this
        // assertion can't tie-break on `rowid` instead of `updated_at` on a
        // fast machine that completes two ops within the same millisecond.
        let db = ThreadsDb::open_in_memory().unwrap();
        let a = db.create_thread("a".to_string()).unwrap();
        std::thread::sleep(Duration::from_millis(5));
        let b = db.create_thread("b".to_string()).unwrap();
        std::thread::sleep(Duration::from_millis(5));
        // Bump `a`'s updated_at past `b`'s by appending a message to it.
        db.create_message(&a.id, "user", &Value::Array(vec![]))
            .unwrap();
        let listed = db.list_threads().unwrap();
        assert_eq!(listed[0].id, a.id);
        assert_eq!(listed[1].id, b.id);
    }

    #[test]
    fn update_title_bumps_updated_at() {
        let db = ThreadsDb::open_in_memory().unwrap();
        let t = db.create_thread("a".to_string()).unwrap();
        let updated = db.update_thread_title(&t.id, "renamed").unwrap().unwrap();
        assert_eq!(updated.title, "renamed");
        assert!(updated.updated_at >= t.updated_at);
    }

    #[test]
    fn update_unknown_thread_is_none() {
        let db = ThreadsDb::open_in_memory().unwrap();
        assert!(db.update_thread_title("nope", "x").unwrap().is_none());
    }

    #[test]
    fn delete_thread_is_idempotent_and_cascades() {
        let db = ThreadsDb::open_in_memory().unwrap();
        let t = db.create_thread("a".to_string()).unwrap();
        db.create_message(&t.id, "user", &Value::Array(vec![]))
            .unwrap();
        db.delete_thread(&t.id).unwrap();
        assert!(db.get_thread(&t.id).unwrap().is_none());
        assert!(db.list_messages(&t.id).unwrap().is_empty());
        // Deleting again must not error.
        db.delete_thread(&t.id).unwrap();
    }

    #[test]
    fn create_message_bumps_thread_updated_at_and_round_trips_parts() {
        let db = ThreadsDb::open_in_memory().unwrap();
        let t = db.create_thread("a".to_string()).unwrap();
        let parts = serde_json::json!([{"type": "text", "text": "hi"}]);
        let m = db.create_message(&t.id, "user", &parts).unwrap();
        assert_eq!(m.parts, parts);
        let refreshed = db.get_thread(&t.id).unwrap().unwrap();
        assert!(refreshed.updated_at >= t.updated_at);
        let messages = db.list_messages(&t.id).unwrap();
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].parts, parts);
    }

    #[test]
    fn list_runs_empty_for_fresh_thread() {
        let db = ThreadsDb::open_in_memory().unwrap();
        let t = db.create_thread("a".to_string()).unwrap();
        assert!(db.list_runs(&t.id).unwrap().is_empty());
    }

    #[test]
    fn thread_exists_true_and_false() {
        let db = ThreadsDb::open_in_memory().unwrap();
        let t = db.create_thread("a".to_string()).unwrap();
        assert!(db.thread_exists(&t.id).unwrap());
        assert!(!db.thread_exists("nope").unwrap());
    }

    #[test]
    fn create_thread_with_id_is_idempotent_and_uses_the_given_id() {
        let db = ThreadsDb::open_in_memory().unwrap();
        let first = db.create_thread_with_id("thread-abc", "").unwrap();
        assert_eq!(first.id, "thread-abc");
        let second = db
            .create_thread_with_id("thread-abc", "ignored title")
            .unwrap();
        assert_eq!(second.id, "thread-abc");
        assert_eq!(
            second.title, "",
            "a repeated create must not overwrite the original title"
        );
        assert_eq!(db.list_threads().unwrap().len(), 1);
    }

    #[test]
    fn create_message_with_id_is_idempotent_on_repeated_calls() {
        let db = ThreadsDb::open_in_memory().unwrap();
        let t = db.create_thread("a".to_string()).unwrap();
        let parts = serde_json::json!([{"type": "text", "text": "hi"}]);
        let first = db
            .create_message_with_id("run-1-user", &t.id, "user", &parts)
            .unwrap();
        let second = db
            .create_message_with_id("run-1-user", &t.id, "user", &parts)
            .unwrap();
        assert_eq!(first.id, second.id);
        assert_eq!(first.created_at, second.created_at);
        // Only ONE row — a re-poll must not duplicate the message.
        let messages = db.list_messages(&t.id).unwrap();
        assert_eq!(messages.len(), 1);
    }

    #[test]
    fn create_message_with_id_only_bumps_updated_at_on_the_actual_insert() {
        let db = ThreadsDb::open_in_memory().unwrap();
        let t = db.create_thread("a".to_string()).unwrap();
        let parts = serde_json::json!([]);
        db.create_message_with_id("run-1-user", &t.id, "user", &parts)
            .unwrap();
        let after_first = db.get_thread(&t.id).unwrap().unwrap().updated_at;
        std::thread::sleep(Duration::from_millis(5));
        db.create_message_with_id("run-1-user", &t.id, "user", &parts)
            .unwrap();
        let after_second = db.get_thread(&t.id).unwrap().unwrap().updated_at;
        assert_eq!(
            after_first, after_second,
            "a re-poll's ignored insert must not re-bump updated_at"
        );
    }

    #[test]
    fn create_run_is_idempotent_and_starts_running() {
        let db = ThreadsDb::open_in_memory().unwrap();
        let t = db.create_thread("a".to_string()).unwrap();
        let first = db.create_run("run-1", &t.id, "claude-code").unwrap();
        assert_eq!(first.status, "running");
        assert_eq!(first.harness_id, "claude-code");
        let second = db.create_run("run-1", &t.id, "claude-code").unwrap();
        assert_eq!(first.created_at, second.created_at);
        let runs = db.list_runs(&t.id).unwrap();
        assert_eq!(runs.len(), 1, "a re-poll must not duplicate the run row");
    }

    #[test]
    fn set_run_terminal_status_transitions_from_running() {
        let db = ThreadsDb::open_in_memory().unwrap();
        let t = db.create_thread("a".to_string()).unwrap();
        db.create_run("run-1", &t.id, "codex").unwrap();
        db.set_run_terminal_status("run-1", "completed", None)
            .unwrap();
        let runs = db.list_runs(&t.id).unwrap();
        assert_eq!(runs[0].status, "completed");
        assert!(runs[0].ended_at.is_some());
        assert_eq!(runs[0].error, None);
    }

    #[test]
    fn set_run_terminal_status_records_the_error_on_failure() {
        let db = ThreadsDb::open_in_memory().unwrap();
        let t = db.create_thread("a".to_string()).unwrap();
        db.create_run("run-1", &t.id, "codex").unwrap();
        db.set_run_terminal_status("run-1", "failed", Some("boom"))
            .unwrap();
        let runs = db.list_runs(&t.id).unwrap();
        assert_eq!(runs[0].status, "failed");
        assert_eq!(runs[0].error.as_deref(), Some("boom"));
    }

    #[test]
    fn set_run_terminal_status_is_one_way_once_terminal() {
        let db = ThreadsDb::open_in_memory().unwrap();
        let t = db.create_thread("a".to_string()).unwrap();
        db.create_run("run-1", &t.id, "codex").unwrap();
        db.set_run_terminal_status("run-1", "completed", None)
            .unwrap();
        let completed_ended_at = db.list_runs(&t.id).unwrap()[0].ended_at.clone();
        // A second terminal write (e.g. a racing cancel) must NOT
        // overwrite the already-terminal row.
        db.set_run_terminal_status("run-1", "cancelled", Some("late cancel"))
            .unwrap();
        let runs = db.list_runs(&t.id).unwrap();
        assert_eq!(runs[0].status, "completed");
        assert_eq!(runs[0].error, None);
        assert_eq!(runs[0].ended_at, completed_ended_at);
    }

    #[test]
    fn set_run_terminal_status_on_an_unknown_run_id_is_a_harmless_no_op() {
        let db = ThreadsDb::open_in_memory().unwrap();
        // No panic, no error — just nothing to update.
        db.set_run_terminal_status("nope", "completed", None)
            .unwrap();
    }

    #[test]
    fn native_threads_are_isolated_by_upstream_user_and_org() {
        let db = ThreadsDb::open_in_memory().unwrap();
        let prod_alice = RtAccountScope::new("studio.decocms.com", "alice").unwrap();
        let dev_alice = RtAccountScope::new("localhost:4000", "alice").unwrap();
        let prod_bob = RtAccountScope::new("studio.decocms.com", "bob").unwrap();
        let thread = db
            .rt_create_thread_scoped(
                &prod_alice,
                Some("account-scoped-thread"),
                "shared-org",
                "Alice chat",
                None,
                "vmcp",
                None,
                "alice",
            )
            .unwrap();
        assert_eq!(thread.organization_id, "shared-org");
        assert_eq!(thread.created_by, "alice");

        for foreign in [&dev_alice, &prod_bob] {
            assert!(db
                .rt_get_thread_in_scope(foreign, "shared-org", &thread.id)
                .unwrap()
                .is_none());
            assert!(db
                .rt_update_thread_in_scope(
                    foreign,
                    "shared-org",
                    &thread.id,
                    &foreign.user_id,
                    &RtThreadPatch {
                        title: Some("hijacked".to_string()),
                        ..RtThreadPatch::default()
                    },
                )
                .unwrap()
                .is_none());
            assert_eq!(
                db.rt_list_messages_in_scope(foreign, "shared-org", &thread.id, 100, 0, false,)
                    .unwrap()
                    .1,
                0
            );
            assert!(db
                .rt_list_turn_queue_scoped(foreign, "shared-org", &thread.id)
                .unwrap()
                .is_empty());
        }

        assert_eq!(
            db.rt_get_thread_in_scope(&prod_alice, "shared-org", &thread.id)
                .unwrap()
                .unwrap()
                .title,
            "Alice chat"
        );
    }

    #[test]
    fn creator_filter_resolves_me_to_the_authenticated_user() {
        let db = ThreadsDb::open_in_memory().unwrap();
        let scope = RtAccountScope::new("studio.decocms.com", "alice").unwrap();
        for (id, creator) in [("mine", "alice"), ("teammate", "bob")] {
            db.rt_create_thread_scoped(&scope, Some(id), "org", id, None, "vmcp", None, creator)
                .unwrap();
        }
        let (mine, total) = db
            .rt_list_threads_scoped(
                &scope,
                "org",
                RtThreadListOptions {
                    created_by: Some("alice"),
                    hidden: None,
                    search: None,
                    trigger_ids: None,
                    virtual_mcp_id: None,
                    has_trigger: None,
                    start_date: None,
                    end_date: None,
                    status: None,
                    agent_id: None,
                    limit: 50,
                    offset: 0,
                },
            )
            .unwrap();
        assert_eq!(total, 1);
        assert_eq!(mine[0].id, "mine");
    }

    #[test]
    fn native_thread_list_filters_items_and_count_with_production_trigger_semantics() {
        let db = ThreadsDb::open_in_memory().unwrap();
        let scope = RtAccountScope::new("studio.decocms.com", "alice").unwrap();
        for (id, title, virtual_mcp_id, creator) in [
            ("normal-match", "Needle target", "vm-primary", "alice"),
            ("normal-other", "Needle other", "vm-agent", "bob"),
            ("no-trigger", "Needle no trigger", "vm-agent", "alice"),
            ("hidden-trigger", "Needle hidden", "vm-primary", "alice"),
            ("outside-date", "Needle old", "vm-primary", "alice"),
        ] {
            db.rt_create_thread_scoped(
                &scope,
                Some(id),
                "org",
                title,
                None,
                virtual_mcp_id,
                None,
                creator,
            )
            .unwrap();
        }
        {
            let conn = db.lock();
            for (id, trigger_id, hidden, status, updated_at) in [
                (
                    "normal-match",
                    Some("trigger-a"),
                    0,
                    "completed",
                    "2026-01-15T00:00:00.000Z",
                ),
                (
                    "normal-other",
                    Some("trigger-b"),
                    0,
                    "failed",
                    "2026-01-20T00:00:00.000Z",
                ),
                (
                    "no-trigger",
                    None,
                    0,
                    "completed",
                    "2026-01-10T00:00:00.000Z",
                ),
                (
                    "hidden-trigger",
                    Some("trigger-a"),
                    1,
                    "completed",
                    "2026-01-16T00:00:00.000Z",
                ),
                (
                    "outside-date",
                    Some("trigger-c"),
                    0,
                    "completed",
                    "2025-12-31T23:59:59.999Z",
                ),
            ] {
                conn.execute(
                    "UPDATE native_scoped_threads \
                     SET trigger_id = ?1, hidden = ?2, status = ?3, updated_at = ?4 \
                     WHERE id = ?5",
                    params![trigger_id, hidden, status, updated_at, id],
                )
                .unwrap();
            }
        }

        let (items, total) = db
            .rt_list_threads_scoped(
                &scope,
                "org",
                RtThreadListOptions {
                    created_by: Some("alice"),
                    hidden: Some(false),
                    search: Some("needle"),
                    trigger_ids: None,
                    virtual_mcp_id: Some("vm-primary"),
                    has_trigger: Some(true),
                    start_date: Some("2026-01-01T00:00:00.000Z"),
                    end_date: Some("2026-01-31T23:59:59.999Z"),
                    status: Some("completed"),
                    // Production uses virtual_mcp_id first and only falls
                    // back to agentId when it is absent.
                    agent_id: Some("vm-agent"),
                    limit: 100,
                    offset: 0,
                },
            )
            .unwrap();
        assert_eq!(total, 1);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].id, "normal-match");

        let (fallback_items, fallback_total) = db
            .rt_list_threads_scoped(
                &scope,
                "org",
                RtThreadListOptions {
                    created_by: None,
                    hidden: Some(false),
                    search: None,
                    trigger_ids: None,
                    virtual_mcp_id: None,
                    has_trigger: Some(false),
                    start_date: None,
                    end_date: None,
                    status: Some("completed"),
                    agent_id: Some("vm-agent"),
                    limit: 100,
                    offset: 0,
                },
            )
            .unwrap();
        assert_eq!(fallback_total, 1);
        assert_eq!(fallback_items[0].id, "no-trigger");

        let trigger_ids = vec!["trigger-a".to_string(), "trigger-b".to_string()];
        let (trigger_items, trigger_total) = db
            .rt_list_threads_scoped(
                &scope,
                "org",
                RtThreadListOptions {
                    // Every normal filter below deliberately conflicts. The
                    // production listByTriggerIds branch ignores all of them,
                    // but always forces hidden=false.
                    created_by: Some("nobody"),
                    hidden: Some(true),
                    search: Some("does-not-match"),
                    trigger_ids: Some(&trigger_ids),
                    virtual_mcp_id: Some("missing-vm"),
                    has_trigger: Some(false),
                    start_date: Some("2999-01-01T00:00:00.000Z"),
                    end_date: Some("2999-01-02T00:00:00.000Z"),
                    status: Some("in_progress"),
                    agent_id: Some("missing-agent"),
                    limit: 1,
                    offset: 0,
                },
            )
            .unwrap();
        assert_eq!(trigger_total, 2);
        assert_eq!(trigger_items.len(), 1);
        assert_eq!(trigger_items[0].id, "normal-other");
        assert!(trigger_items.iter().all(|item| !item.hidden));
    }

    #[test]
    fn corrupt_thread_json_is_reported_instead_of_silently_becoming_null() {
        let db = ThreadsDb::open_in_memory().unwrap();
        let scope = RtAccountScope::new("studio.decocms.com", "alice").unwrap();
        db.rt_create_thread_scoped(
            &scope,
            Some("corrupt-json"),
            "org",
            "corrupt",
            None,
            "vmcp",
            None,
            "alice",
        )
        .unwrap();
        db.lock()
            .execute(
                "UPDATE native_scoped_threads SET metadata = '{' WHERE id = 'corrupt-json'",
                [],
            )
            .unwrap();

        let error = db
            .rt_get_thread_in_scope(&scope, "org", "corrupt-json")
            .unwrap_err();
        assert!(matches!(
            error,
            DbError::Sqlite(rusqlite::Error::FromSqlConversionFailure(
                13,
                rusqlite::types::Type::Text,
                _
            ))
        ));
    }

    #[test]
    fn v4_lazily_adopts_only_attributable_legacy_rows_once() {
        let dir = tempfile::tempdir().unwrap();
        create_pre_account_scope_fixture(dir.path());
        let db = ThreadsDb::open(dir.path()).unwrap();
        let prod_user = RtAccountScope::new("studio.decocms.com", "user-a").unwrap();
        let dev_same_sub = RtAccountScope::new("localhost:4000", "user-a").unwrap();
        let other_user = RtAccountScope::new("studio.decocms.com", "user-b").unwrap();

        let adopted = db
            .rt_get_thread_in_scope(&prod_user, "shared-org", "owned-legacy")
            .unwrap()
            .expect("matching creator should be adopted");
        assert_eq!(adopted.organization_id, "shared-org");
        assert_eq!(adopted.created_by, "user-a");
        assert_eq!(
            db.rt_list_turn_queue_scoped(&prod_user, "shared-org", "owned-legacy")
                .unwrap()
                .len(),
            1,
            "the durable queue must move in the same account adoption transaction"
        );

        for scope in [&dev_same_sub, &other_user] {
            assert!(db
                .rt_get_thread_in_scope(scope, "shared-org", "owned-legacy")
                .unwrap()
                .is_none());
        }
        for scope in [&prod_user, &dev_same_sub, &other_user] {
            assert!(db
                .rt_get_thread_in_scope(scope, "shared-org", "placeholder-legacy")
                .unwrap()
                .is_none());
        }
        assert_eq!(
            schema_version(&local_db_path(dir.path())),
            CURRENT_SCHEMA_VERSION
        );
    }
}
