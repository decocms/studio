//! SQLite storage for the production-compatible intercepted thread catalog
//! and interactive terminal lifecycle.
//!
//! The migration ladder also preserves tables and rows written by retired
//! native chat transports. Those historical tables stay readable to migration
//! tests, but no runtime API in this module writes them after the terminal
//! cutover.
//!
//! One `Mutex<rusqlite::Connection>` per process (see `ensure_db` in the
//! parent module). This remains one local app process even though the durable
//! rows isolate multiple signed-in account scopes, so a serialized connection
//! is simpler than a pool and avoids SQLITE_BUSY entirely (all writers already
//! funnel through one `Mutex`). WAL mode is still enabled so a future reader
//! (e.g. a CLI inspecting the db file while local-api is running) doesn't block
//! on it.

use std::fs;
use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::Serialize;
use serde_json::Value;
use uuid::Uuid;

/// Native owns this schema independently from Studio's Postgres migrations.
/// The two stores intentionally share wire entities, not physical tables.
const CURRENT_SCHEMA_VERSION: u32 = 12;

const NATIVE_TERMINAL_SESSION_ID_PREFIX: &str = "native-terminal:";

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

-- `threads`/`messages`/`runs` above are the retired native mini-chat store.
-- Keep them in the historical schema so opening an existing database remains
-- nondestructive; no current runtime route reads or writes them.
-- `rt_threads`/`rt_messages` back `routes/intercept/*`'s emulation of the REAL
-- production shell's wire contract instead: `ThreadEntity`
-- (`packages/shared/src/thread/schema.ts::ThreadEntitySchema`) and
-- `ThreadMessageEntity`, per the native interception contract
-- §3.1. Same db file, same connection/lock, independent tables — keeps the
-- historical schema completely unmodified while the newer
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
    Migration {
        version: 11,
        // The interactive terminal owns a long-lived CLI process rather than
        // replayable AI-SDK turns. Preserve every pre-terminal queue row for
        // audit/recovery, but move it out of the active table so boot can
        // never execute a prompt accepted by the removed chat transport. The
        // renamed table keeps its foreign key to the thread, so an explicit
        // thread deletion still erases the archived user content.
        //
        // A terminal session is a process attempt, not the provider's durable
        // conversation. Multiple exited attempts may belong to one thread
        // generation, while the partial unique index permits only one
        // starting/running process. `revision` is the storage CAS fence for
        // lifecycle writers; `thread_generation` is the outer ABA fence.
        sql: r#"
ALTER TABLE native_scoped_turn_queue RENAME TO native_legacy_turn_queue_v10;

DROP INDEX IF EXISTS idx_native_scoped_turn_queue_fifo;
DROP INDEX IF EXISTS idx_native_scoped_turn_queue_recovery;
DROP INDEX IF EXISTS idx_native_scoped_turn_queue_account_recovery;
DROP INDEX IF EXISTS idx_native_scoped_turn_queue_v1_assistant_message_id;
DROP TRIGGER IF EXISTS native_scoped_turn_queue_account_scope_required_insert;
DROP TRIGGER IF EXISTS native_scoped_turn_queue_checkpoint_pair_insert;
DROP TRIGGER IF EXISTS native_scoped_turn_queue_checkpoint_pair_update;

CREATE UNIQUE INDEX idx_native_scoped_threads_terminal_parent
ON native_scoped_threads(account_scope, organization_id, id, generation);

CREATE TABLE native_terminal_sessions (
    id TEXT PRIMARY KEY CHECK (trim(id) <> ''),
    account_scope TEXT NOT NULL CHECK (account_scope <> ''),
    organization_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    thread_generation TEXT NOT NULL CHECK (thread_generation <> ''),
    harness_id TEXT NOT NULL CHECK (trim(harness_id) <> ''),
    physical_state TEXT NOT NULL
        CHECK (physical_state IN ('starting', 'running', 'exited')),
    logical_state TEXT NOT NULL
        CHECK (logical_state IN (
            'idle', 'working', 'waiting_input', 'completed', 'failed', 'interrupted'
        )),
    provider_session_id TEXT
        CHECK (provider_session_id IS NULL OR trim(provider_session_id) <> ''),
    revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
    exit_code INTEGER,
    last_error TEXT,
    started_at TEXT,
    ended_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    blocks_prior_provider_resume INTEGER NOT NULL DEFAULT 0
        CHECK (blocks_prior_provider_resume IN (0, 1)),
    CHECK (
        physical_state <> 'exited' OR
        logical_state IN ('completed', 'failed', 'interrupted')
    ),
    CHECK (physical_state = 'exited' OR exit_code IS NULL),
    CHECK (physical_state <> 'running' OR started_at IS NOT NULL),
    CHECK (physical_state <> 'exited' OR ended_at IS NOT NULL),
    FOREIGN KEY (account_scope, organization_id, thread_id, thread_generation)
        REFERENCES native_scoped_threads(account_scope, organization_id, id, generation)
        ON DELETE CASCADE
);
CREATE UNIQUE INDEX idx_native_terminal_sessions_one_live
ON native_terminal_sessions(account_scope, organization_id, thread_id, thread_generation)
WHERE physical_state IN ('starting', 'running');
CREATE INDEX idx_native_terminal_sessions_thread_latest
ON native_terminal_sessions(
    account_scope, organization_id, thread_id, thread_generation, created_at DESC, id DESC
);
CREATE INDEX idx_native_terminal_sessions_boot_live
ON native_terminal_sessions(physical_state)
WHERE physical_state IN ('starting', 'running');

-- A v10 active turn may contain the only durable provider conversation id.
-- Preserve the newest valid checkpoint as exited history so the terminal
-- launcher can explicitly resume it without replaying the archived prompt.
-- A checkpoint is valid only when its complete account/thread fence and
-- harness agree with the pinned parent thread. The namespaced deterministic
-- id makes the recovery idempotent even if this statement is replayed while
-- debugging a copied database.
INSERT OR IGNORE INTO native_terminal_sessions (
    id, account_scope, organization_id, thread_id, thread_generation, harness_id,
    physical_state, logical_state, provider_session_id, revision, exit_code,
    last_error, started_at, ended_at, created_at, updated_at
)
SELECT
    'native-terminal:v11-legacy:' || hex(q.account_scope) || ':' ||
        hex(q.organization_id) || ':' || hex(q.thread_id) || ':' ||
        hex(q.thread_generation),
    q.account_scope,
    q.organization_id,
    q.thread_id,
    q.thread_generation,
    q.checkpoint_harness_id,
    'exited',
    'interrupted',
    q.checkpoint_session_id,
    0,
    NULL,
    'Migrated from the interrupted native chat transport; its prompt was not replayed',
    NULL,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM native_legacy_turn_queue_v10 q
JOIN native_scoped_threads t
  ON t.account_scope = q.account_scope
 AND t.organization_id = q.organization_id
 AND t.id = q.thread_id
 AND t.generation = q.thread_generation
 AND t.harness_id = q.checkpoint_harness_id
WHERE q.account_scope <> ''
  AND q.checkpoint_harness_id IS NOT NULL
  AND q.checkpoint_session_id IS NOT NULL
  AND q.rowid = (
      SELECT candidate.rowid
      FROM native_legacy_turn_queue_v10 candidate
      WHERE candidate.account_scope = q.account_scope
        AND candidate.organization_id = q.organization_id
        AND candidate.thread_id = q.thread_id
        AND candidate.thread_generation = q.thread_generation
        AND candidate.checkpoint_harness_id = t.harness_id
        AND candidate.checkpoint_session_id IS NOT NULL
      ORDER BY candidate.enqueued_at DESC, candidate.fifo_ordinal DESC, candidate.rowid DESC
      LIMIT 1
  );

-- None of the archived prompts will run. Surface that discontinuity on every
-- affected thread, including queued-only threads without a resumable provider
-- checkpoint, so the sidebar asks the user to inspect/resume explicitly.
UPDATE native_scoped_threads
SET status = 'requires_action',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE EXISTS (
    SELECT 1
    FROM native_legacy_turn_queue_v10 q
    WHERE q.account_scope = native_scoped_threads.account_scope
      AND q.organization_id = native_scoped_threads.organization_id
      AND q.thread_id = native_scoped_threads.id
      AND q.thread_generation = native_scoped_threads.generation
);
"#,
    },
    Migration {
        version: 12,
        // v11 used blocks_prior_provider_resume as a provisional "spawned a
        // resume" marker. An app restart could therefore strand a perfectly
        // valid older checkpoint behind a row that never received provider
        // evidence. From v12 onward a barrier is durable only after an exact
        // provider rejection and records the rejected checkpoint identity so
        // a late hook for that same id cannot undo the proof. Every legacy
        // null-checkpoint barrier is ambiguous; retrying its older checkpoint
        // is safer than silently abandoning provider-owned history. Rows that
        // already carry a checkpoint remain untouched.
        sql: r#"
ALTER TABLE native_terminal_sessions
ADD COLUMN rejected_provider_session_id TEXT
CHECK (
    rejected_provider_session_id IS NULL OR
    (
        trim(rejected_provider_session_id) <> '' AND
        provider_session_id IS NULL AND
        blocks_prior_provider_resume = 1
    )
);

UPDATE native_terminal_sessions
SET blocks_prior_provider_resume = 0,
    revision = revision + 1,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE provider_session_id IS NULL
  AND blocks_prior_provider_resume = 1;
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
    InvalidTerminalSessionData(String),
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
            DbError::InvalidTerminalSessionData(message) => {
                write!(f, "invalid terminal session data: {message}")
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

// --- native_scoped_threads / native_scoped_messages — the REAL production shell's wire shape ----
//
// Field names/shapes mirror
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

/// Filters for a scoped native thread listing. Keeping these in one typed value
/// prevents the storage API from growing another positional argument every time
/// the production collection adds a filter.
///
/// No `limit`/`offset`: the local list is answered in full (see `list()` in
/// `intercept::thread_tools` for why), so every caller gets every matching row.
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

/// Whether this process currently owns an operating-system child for a
/// terminal session. Only `starting` and `running` are live; `exited` is
/// durable history and can never transition back to a live state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RtTerminalPhysicalState {
    Starting,
    Running,
    Exited,
}

impl RtTerminalPhysicalState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Starting => "starting",
            Self::Running => "running",
            Self::Exited => "exited",
        }
    }

    pub fn is_live(self) -> bool {
        matches!(self, Self::Starting | Self::Running)
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "starting" => Some(Self::Starting),
            "running" => Some(Self::Running),
            "exited" => Some(Self::Exited),
            _ => None,
        }
    }
}

/// Provider-neutral turn state. It deliberately does not duplicate process
/// liveness: an interactive CLI can remain physically running while its last
/// turn is completed or waiting for another prompt.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RtTerminalLogicalState {
    Idle,
    Working,
    WaitingInput,
    Completed,
    Failed,
    Interrupted,
}

impl RtTerminalLogicalState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Working => "working",
            Self::WaitingInput => "waiting_input",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Interrupted => "interrupted",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "idle" => Some(Self::Idle),
            "working" => Some(Self::Working),
            "waiting_input" => Some(Self::WaitingInput),
            "completed" => Some(Self::Completed),
            "failed" => Some(Self::Failed),
            "interrupted" => Some(Self::Interrupted),
            _ => None,
        }
    }
}

/// One process attempt for a thread generation. `provider_session_id` is the
/// CLI-owned conversation checkpoint used to resume after this process exits;
/// it is not the row's identity and is write-once per attempt.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RtTerminalSession {
    pub id: String,
    pub fence: RtThreadFence,
    pub harness_id: String,
    pub physical_state: RtTerminalPhysicalState,
    pub logical_state: RtTerminalLogicalState,
    pub provider_session_id: Option<String>,
    /// Exact provider evidence proved that the older checkpoint named by
    /// `rejected_provider_session_id` cannot be resumed. Generic exits and
    /// app-controlled interruptions never create this barrier.
    pub blocks_prior_provider_resume: bool,
    pub rejected_provider_session_id: Option<String>,
    pub revision: i64,
    pub exit_code: Option<i32>,
    pub last_error: Option<String>,
    pub started_at: Option<String>,
    pub ended_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// A terminal write and the thread row updated in the same SQLite
/// transaction. Callers can publish `thread` on `/watch` without a racy
/// follow-up read.
#[derive(Debug, Clone, Serialize)]
pub struct RtTerminalSessionCommit {
    pub session: RtTerminalSession,
    pub thread: RtThread,
}

#[derive(Debug, Clone)]
pub enum RtTerminalSessionCreateOutcome {
    Created(RtTerminalSessionCommit),
    ExistingLive(RtTerminalSessionCommit),
}

#[derive(Debug, Clone)]
pub enum RtTerminalSessionCasOutcome {
    Updated(Box<RtTerminalSessionCommit>),
    Stale(Box<RtTerminalSession>),
    Missing,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RtTerminalProviderCheckpointOutcome {
    Stored(RtTerminalSession),
    Unchanged(RtTerminalSession),
    Conflict(RtTerminalSession),
    NotLive(RtTerminalSession),
    Missing,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RtTerminalResumeDecision {
    Fresh,
    Resume(String),
}

/// The title every thread starts with, and the one an auto-title is allowed
/// to replace. Byte-parity with `packages/harness/src/thread-title.ts`.
pub const DEFAULT_THREAD_TITLE: &str = "New chat";

/// The status a thread holds while its terminal agent is working.
pub const RT_THREAD_STATUS_IN_PROGRESS: &str = "in_progress";

/// Terminal-agent thread statuses.
pub const RT_THREAD_STATUS_COMPLETED: &str = "completed";
pub const RT_THREAD_STATUS_REQUIRES_ACTION: &str = "requires_action";
pub const RT_THREAD_STATUS_FAILED: &str = "failed";

/// The COMPLETE thread-status wire vocabulary, homed here because this module
/// owns the schema rows and wire entities that carry it. Every other encoding
/// (`watch.rs`'s SSE enum, `thread_tools.rs`'s update allowlist) derives from
/// these constants: an independent copy is a silent-drift channel — a future
/// valid status added here but not there would be 400'd by the untyped
/// allowlist, or never emitted on the watch stream.
pub const RT_THREAD_STATUSES: [&str; 4] = [
    RT_THREAD_STATUS_IN_PROGRESS,
    RT_THREAD_STATUS_COMPLETED,
    RT_THREAD_STATUS_REQUIRES_ACTION,
    RT_THREAD_STATUS_FAILED,
];

/// Whether `value` is a member of the thread-status wire vocabulary.
pub fn is_thread_status(value: &str) -> bool {
    RT_THREAD_STATUSES.contains(&value)
}

/// Milliseconds-precision RFC3339 UTC timestamp (`2024-01-02T03:04:05.006Z`).
/// Hand-rolled (no `chrono`/`time` crate in the workspace's dependency
/// table — see `apps/native/Cargo.toml`, which is a shared file family
/// implementers don't edit) via the standard civil-from-days algorithm
/// (Howard Hinnant's `civil_from_days`, the same one libc++'s `<chrono>`
/// uses). Millisecond precision (rather than seconds) keeps same-tick
/// creates orderable in the scoped thread list's `ORDER BY updated_at DESC`
/// without a secondary sort key doing all the work.
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
    let (y, m, day) = crate::time_util::civil_from_days(days);
    let hh = secs_of_day / 3600;
    let mm = (secs_of_day % 3600) / 60;
    let ss = secs_of_day % 60;
    format!("{y:04}-{m:02}-{day:02}T{hh:02}:{mm:02}:{ss:02}.{millis:03}Z")
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

/// Tightens a pre-existing database and any WAL files SQLite has materialized.
/// SQLite creates future `-wal`/`-shm` files with the database's mode; setting
/// the main file before enabling WAL therefore also protects later sidecars.
fn secure_sqlite_files(db_path: &Path) -> std::io::Result<()> {
    for path in crate::fs_util::sqlite_file_family(db_path) {
        match fs::metadata(&path) {
            Ok(_) => crate::fs_util::set_owner_only(&path)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

pub struct ThreadsDb {
    conn: Mutex<Connection>,
    /// `(account_scope, organization_id)` pairs whose legacy-row adoption has
    /// already run in this process — the guard that keeps
    /// `adopt_legacy_account_rows` from opening a write transaction on every
    /// scoped READ. See that method's comment.
    adopted_scopes: Mutex<std::collections::HashSet<(String, String)>>,
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
        crate::fs_util::create_owner_only(&db_path)?;
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
        conn.busy_timeout(crate::SQLITE_BUSY_TIMEOUT)?;
        conn.pragma_update(None, "foreign_keys", 1)?;
        migrate(&mut conn)?;
        // SQLite silently keeps `:memory:` databases on "memory" mode even
        // when WAL is requested (it can't be persisted anyway) — this call
        // still succeeds (not an error) in that case, so `?` is safe for
        // both the file-backed and in-memory (test) constructors.
        conn.pragma_update(None, "journal_mode", "WAL")?;
        // NORMAL is the documented pairing for WAL: transactions still cannot
        // corrupt the database, and a power loss can only cost the tail of
        // very recent commits. The default FULL fsyncs the WAL on EVERY
        // commit, which made each write-bearing request pay a disk flush.
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        Ok(Self {
            conn: Mutex::new(conn),
            adopted_scopes: Mutex::new(std::collections::HashSet::new()),
        })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Connection> {
        match self.conn.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        }
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

        // One-shot per (account, org) per process. This runs on EVERY scoped
        // read and write — thread lists and message pages — and the
        // IMMEDIATE transaction below takes SQLite's writer lock and commits
        // (an fsync) even when there is nothing to adopt, which on a hot
        // request path serialized every reader behind a per-request write. Adoption
        // is a migration: once this process has claimed a pair, re-running it
        // can find nothing new (legacy rows are only ever CONSUMED), so the
        // guard makes every later call free. A second process instance would
        // re-check once and find zero rows — correct, just not free.
        {
            let mut adopted = self
                .adopted_scopes
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if !adopted.insert((account_scope.clone(), organization_id.to_string())) {
                return Ok(());
            }
        }

        let mut conn = self.lock();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute(
            "UPDATE native_scoped_threads SET account_scope = ?1 \
             WHERE account_scope = '' AND organization_id = ?2 \
               AND created_by = ?3 AND created_by <> 'local-desktop-user'",
            params![account_scope, organization_id, scope.user_id],
        )?;
        tx.execute(
            "UPDATE native_legacy_turn_queue_v10 SET account_scope = ?1 \
             WHERE account_scope = '' AND EXISTS (\
                 SELECT 1 FROM native_scoped_threads t \
                 WHERE t.id = native_legacy_turn_queue_v10.thread_id \
                   AND t.organization_id = native_legacy_turn_queue_v10.organization_id \
                   AND t.generation = native_legacy_turn_queue_v10.thread_generation \
                   AND t.account_scope = ?1\
             )",
            params![account_scope],
        )?;
        tx.commit()?;
        Ok(())
    }

    // --- native_scoped_threads / native_scoped_messages ---
    // See migration 1's schema comment.

    /// Idempotent-by-id scoped creation: `INSERT OR IGNORE`, then read back
    /// whichever row is current — the one this call inserted, or a prior call
    /// with the same `id` (for example,
    /// a retried `COLLECTION_THREADS_CREATE`). `id` defaults to a
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
    ///
    /// Returns EVERY matching row — there is no pagination here — plus the
    /// count, which is consequently always `items.len()`. The count is still
    /// returned so callers report `totalCount` from one place.
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

        // No LIMIT/OFFSET: every matching row, every time. `total` above and
        // `out.len()` below are therefore always equal — the count query is kept
        // only so the response's `totalCount` stays a single source of truth.
        let list_sql = format!(
            "SELECT {RT_THREAD_COLUMNS} FROM native_scoped_threads WHERE {where_sql} \
             ORDER BY updated_at DESC, rowid DESC"
        );
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
            return Err(DbError::SchemaIntegrity(format!(
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
    /// thread deletion, and child-row cascades commit atomically: after a
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

    /// Durably closes one live generation to new terminal launches before
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

    /// First-terminal thread-lock pin:
    /// sets `harness_id`/`sandbox_provider_kind`/`branch` ONLY when each is
    /// currently `NULL` — a later launch on the same thread leaves them
    /// untouched even if it names a different harness.
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
               AND account_scope = ?7 AND delete_pending = 0 AND hidden = 0",
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

    /// Creates one `starting` process attempt for a live thread generation.
    /// The IMMEDIATE transaction serializes the existing-live check with the
    /// insert, while the partial unique index remains the database-level
    /// backstop for writers using another connection. Repeated starts attach
    /// to the current live row instead of spawning a competing process.
    pub fn rt_create_terminal_session_fenced(
        &self,
        fence: &RtThreadFence,
        session_id: &str,
        harness_id: &str,
    ) -> DbResult<RtTerminalSessionCreateOutcome> {
        let session_id = session_id.trim();
        let harness_id = harness_id.trim();
        if session_id.is_empty() || harness_id.is_empty() {
            return Err(DbError::InvalidTerminalSessionData(
                "session id and harness id must be non-empty".to_string(),
            ));
        }
        if session_id.starts_with(NATIVE_TERMINAL_SESSION_ID_PREFIX) {
            return Err(DbError::InvalidTerminalSessionData(format!(
                "session ids beginning with {NATIVE_TERMINAL_SESSION_ID_PREFIX:?} are reserved"
            )));
        }

        let ts = now_rfc3339();
        let mut conn = self.lock();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let thread_gate: Option<(bool, Option<String>)> = tx
            .query_row(
                "SELECT delete_pending, harness_id FROM native_scoped_threads \
                 WHERE account_scope = ?1 AND organization_id = ?2 AND id = ?3 \
                   AND generation = ?4",
                params![
                    fence.account_scope,
                    fence.organization_id,
                    fence.thread_id,
                    fence.generation,
                ],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let Some((delete_pending, pinned_harness)) = thread_gate else {
            return Err(DbError::StaleThreadGeneration {
                organization_id: fence.organization_id.clone(),
                thread_id: fence.thread_id.clone(),
                generation: fence.generation.clone(),
            });
        };
        if delete_pending {
            return Err(DbError::ThreadDeletePending {
                organization_id: fence.organization_id.clone(),
                thread_id: fence.thread_id.clone(),
            });
        }
        if pinned_harness
            .as_deref()
            .is_some_and(|pinned| pinned != harness_id)
        {
            return Err(DbError::InvalidTerminalSessionData(format!(
                "thread harness {:?} does not match terminal harness {harness_id:?}",
                pinned_harness.as_deref().unwrap_or_default()
            )));
        }

        if let Some(existing) = rt_live_terminal_session_fenced(&tx, fence)? {
            if existing.harness_id != harness_id {
                return Err(DbError::InvalidTerminalSessionData(format!(
                    "live terminal harness {:?} does not match requested harness {harness_id:?}",
                    existing.harness_id
                )));
            }
            let thread = rt_thread_by_id_in_scope(
                &tx,
                &fence.account_scope,
                &fence.organization_id,
                &fence.thread_id,
            )?
            .ok_or_else(|| DbError::StaleThreadGeneration {
                organization_id: fence.organization_id.clone(),
                thread_id: fence.thread_id.clone(),
                generation: fence.generation.clone(),
            })?;
            tx.commit()?;
            return Ok(RtTerminalSessionCreateOutcome::ExistingLive(
                RtTerminalSessionCommit {
                    session: existing,
                    thread,
                },
            ));
        }

        let inserted = tx.execute(
            "INSERT OR IGNORE INTO native_terminal_sessions (\
                 id, account_scope, organization_id, thread_id, thread_generation, harness_id, \
                 physical_state, logical_state, provider_session_id, revision, exit_code, \
                 last_error, started_at, ended_at, created_at, updated_at\
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'starting', 'idle', NULL, 0, NULL, \
                       NULL, NULL, NULL, ?7, ?7)",
            params![
                session_id,
                fence.account_scope,
                fence.organization_id,
                fence.thread_id,
                fence.generation,
                harness_id,
                ts,
            ],
        )?;
        if inserted != 1 {
            return Err(DbError::IdempotencyConflict {
                entity: "terminal_session",
                id: session_id.to_string(),
            });
        }
        let thread_changed = tx.execute(
            "UPDATE native_scoped_threads SET \
                 status = ?1, updated_at = ?2 \
             WHERE account_scope = ?3 AND organization_id = ?4 AND id = ?5 \
               AND generation = ?6 AND delete_pending = 0",
            params![
                terminal_thread_status(
                    RtTerminalPhysicalState::Starting,
                    RtTerminalLogicalState::Idle,
                ),
                ts,
                fence.account_scope,
                fence.organization_id,
                fence.thread_id,
                fence.generation,
            ],
        )?;
        if thread_changed != 1 {
            return Err(DbError::StaleThreadGeneration {
                organization_id: fence.organization_id.clone(),
                thread_id: fence.thread_id.clone(),
                generation: fence.generation.clone(),
            });
        }
        let session = rt_terminal_session_by_id_fenced(&tx, fence, session_id)?
            .ok_or_else(|| DbError::Sqlite(rusqlite::Error::QueryReturnedNoRows))?;
        let thread = rt_thread_by_id_in_scope(
            &tx,
            &fence.account_scope,
            &fence.organization_id,
            &fence.thread_id,
        )?
        .ok_or_else(|| DbError::Sqlite(rusqlite::Error::QueryReturnedNoRows))?;
        tx.commit()?;
        Ok(RtTerminalSessionCreateOutcome::Created(
            RtTerminalSessionCommit { session, thread },
        ))
    }

    pub fn rt_get_terminal_session_fenced(
        &self,
        fence: &RtThreadFence,
        session_id: &str,
    ) -> DbResult<Option<RtTerminalSession>> {
        let conn = self.lock();
        rt_terminal_session_by_id_fenced(&conn, fence, session_id)
    }

    #[cfg(test)]
    pub fn rt_get_terminal_session_in_scope(
        &self,
        scope: &RtAccountScope,
        organization_id: &str,
        thread_id: &str,
        session_id: &str,
    ) -> DbResult<Option<RtTerminalSession>> {
        let Some(fence) = self.rt_thread_fence_in_scope(scope, organization_id, thread_id)? else {
            return Ok(None);
        };
        self.rt_get_terminal_session_fenced(&fence, session_id)
    }

    pub fn rt_get_live_terminal_session_fenced(
        &self,
        fence: &RtThreadFence,
    ) -> DbResult<Option<RtTerminalSession>> {
        let conn = self.lock();
        rt_live_terminal_session_fenced(&conn, fence)
    }

    /// Newest process attempt, including exited rows. Launchers use this to
    /// render process history. Resume uses the checkpoint-specific lookup
    /// below so a newer failed launch cannot hide older resumable history.
    pub fn rt_get_latest_terminal_session_fenced(
        &self,
        fence: &RtThreadFence,
    ) -> DbResult<Option<RtTerminalSession>> {
        let conn = self.lock();
        rt_latest_terminal_session_fenced(&conn, fence)
    }

    /// Newest meaningful resume record for this harness. Ordinary launch
    /// failures and interrupted resume attempts do not hide older checkpoints.
    /// Only an identity-bearing, provider-confirmed rejection is a barrier.
    pub fn rt_terminal_resume_decision_fenced(
        &self,
        fence: &RtThreadFence,
        harness_id: &str,
    ) -> DbResult<RtTerminalResumeDecision> {
        let conn = self.lock();
        let candidate: Option<(Option<String>, bool, Option<String>)> = conn
            .query_row(
                "SELECT provider_session_id, blocks_prior_provider_resume, \
                        rejected_provider_session_id \
             FROM native_terminal_sessions \
             WHERE account_scope = ?1 AND organization_id = ?2 AND thread_id = ?3 \
               AND thread_generation = ?4 AND harness_id = ?5 \
               AND (provider_session_id IS NOT NULL OR (\
                    blocks_prior_provider_resume = 1 AND \
                    rejected_provider_session_id IS NOT NULL\
               )) \
             ORDER BY created_at DESC, rowid DESC LIMIT 1",
                params![
                    fence.account_scope,
                    fence.organization_id,
                    fence.thread_id,
                    fence.generation,
                    harness_id,
                ],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(DbError::from)?;
        Ok(match candidate {
            Some((Some(provider_session_id), _, _)) => {
                RtTerminalResumeDecision::Resume(provider_session_id)
            }
            Some((None, true, Some(_))) | None => RtTerminalResumeDecision::Fresh,
            Some((None, _, _)) => {
                debug_assert!(
                    false,
                    "resume candidate must contain an id or exact barrier"
                );
                RtTerminalResumeDecision::Fresh
            }
        })
    }

    /// Persist exact provider evidence that one older checkpoint cannot be
    /// resumed. The rejected identity closes the late-hook race: that same id
    /// cannot clear the barrier, while a new checkpoint from the fresh
    /// fallback may replace it. Repeating the same proof is idempotent.
    pub fn rt_confirm_terminal_resume_rejected_fenced(
        &self,
        fence: &RtThreadFence,
        session_id: &str,
        rejected_provider_session_id: &str,
    ) -> DbResult<bool> {
        let rejected_provider_session_id = rejected_provider_session_id.trim();
        if rejected_provider_session_id.is_empty() {
            return Err(DbError::InvalidTerminalSessionData(
                "rejected provider session id must be non-empty".to_string(),
            ));
        }
        let ts = now_rfc3339();
        let mut conn = self.lock();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let Some(current) = rt_terminal_session_by_id_fenced(&tx, fence, session_id)? else {
            tx.commit()?;
            return Ok(false);
        };
        if !current.physical_state.is_live() || current.provider_session_id.is_some() {
            tx.commit()?;
            return Ok(false);
        }
        if current.blocks_prior_provider_resume {
            let same_rejection = current.rejected_provider_session_id.as_deref()
                == Some(rejected_provider_session_id);
            tx.commit()?;
            return Ok(same_rejection);
        }
        if current.rejected_provider_session_id.is_some() {
            tx.commit()?;
            return Ok(false);
        }
        let changed = tx.execute(
            "UPDATE native_terminal_sessions SET \
                 blocks_prior_provider_resume = 1, rejected_provider_session_id = ?1, \
                 revision = revision + 1, updated_at = ?2 \
             WHERE id = ?3 AND account_scope = ?4 AND organization_id = ?5 \
               AND thread_id = ?6 AND thread_generation = ?7 AND revision = ?8 \
               AND provider_session_id IS NULL AND blocks_prior_provider_resume = 0 \
               AND rejected_provider_session_id IS NULL \
               AND physical_state IN ('starting', 'running')",
            params![
                rejected_provider_session_id,
                ts,
                session_id,
                fence.account_scope,
                fence.organization_id,
                fence.thread_id,
                fence.generation,
                current.revision,
            ],
        )?;
        tx.commit()?;
        Ok(changed == 1)
    }

    /// Revision-CAS for provider-neutral terminal lifecycle. Session state
    /// and the sidebar's thread status commit atomically; a caller receiving
    /// `Updated` may publish the included thread row without another read.
    #[allow(clippy::too_many_arguments)]
    pub fn rt_compare_and_set_terminal_session_state(
        &self,
        fence: &RtThreadFence,
        session_id: &str,
        expected_revision: i64,
        physical_state: RtTerminalPhysicalState,
        logical_state: RtTerminalLogicalState,
        exit_code: Option<i32>,
        last_error: Option<&str>,
    ) -> DbResult<RtTerminalSessionCasOutcome> {
        if expected_revision < 0 {
            return Err(DbError::InvalidTerminalSessionData(
                "expected revision must be non-negative".to_string(),
            ));
        }
        validate_terminal_state_pair(physical_state, logical_state, exit_code)?;
        let ts = now_rfc3339();
        let mut conn = self.lock();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let delete_pending: Option<bool> = tx
            .query_row(
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
            .optional()?;
        let Some(delete_pending) = delete_pending else {
            tx.commit()?;
            return Ok(RtTerminalSessionCasOutcome::Missing);
        };
        // Delete-pending closes the generation to new work, but the child
        // process still needs one final write after it has been signalled and
        // reaped. Refusing that exit would leave a dead process persisted as
        // live whenever the parent DELETE later fails and must be retried.
        if delete_pending && physical_state != RtTerminalPhysicalState::Exited {
            return Err(DbError::ThreadDeletePending {
                organization_id: fence.organization_id.clone(),
                thread_id: fence.thread_id.clone(),
            });
        }
        let Some(current) = rt_terminal_session_by_id_fenced(&tx, fence, session_id)? else {
            tx.commit()?;
            return Ok(RtTerminalSessionCasOutcome::Missing);
        };
        if current.revision != expected_revision
            || !terminal_physical_transition_is_valid(current.physical_state, physical_state)
        {
            tx.commit()?;
            return Ok(RtTerminalSessionCasOutcome::Stale(Box::new(current)));
        }

        let changed = tx.execute(
            "UPDATE native_terminal_sessions SET \
                 physical_state = ?1, logical_state = ?2, revision = revision + 1, \
                 exit_code = ?3, last_error = ?4, \
                 started_at = CASE \
                     WHEN ?1 = 'running' THEN COALESCE(started_at, ?5) \
                     ELSE started_at \
                 END, \
                 ended_at = CASE \
                     WHEN ?1 = 'exited' THEN COALESCE(ended_at, ?5) \
                     ELSE NULL \
                 END, \
                 updated_at = ?5 \
             WHERE id = ?6 AND account_scope = ?7 AND organization_id = ?8 \
               AND thread_id = ?9 AND thread_generation = ?10 AND revision = ?11",
            params![
                physical_state.as_str(),
                logical_state.as_str(),
                exit_code,
                last_error,
                ts,
                session_id,
                fence.account_scope,
                fence.organization_id,
                fence.thread_id,
                fence.generation,
                expected_revision,
            ],
        )?;
        if changed != 1 {
            let current = rt_terminal_session_by_id_fenced(&tx, fence, session_id)?;
            tx.commit()?;
            return Ok(match current {
                Some(current) => RtTerminalSessionCasOutcome::Stale(Box::new(current)),
                None => RtTerminalSessionCasOutcome::Missing,
            });
        }

        let thread_changed = tx.execute(
            "UPDATE native_scoped_threads SET status = ?1, updated_at = ?2 \
             WHERE account_scope = ?3 AND organization_id = ?4 AND id = ?5 \
               AND generation = ?6",
            params![
                terminal_thread_status(physical_state, logical_state),
                ts,
                fence.account_scope,
                fence.organization_id,
                fence.thread_id,
                fence.generation,
            ],
        )?;
        if thread_changed != 1 {
            return Err(DbError::StaleThreadGeneration {
                organization_id: fence.organization_id.clone(),
                thread_id: fence.thread_id.clone(),
                generation: fence.generation.clone(),
            });
        }
        let session = rt_terminal_session_by_id_fenced(&tx, fence, session_id)?
            .ok_or_else(|| DbError::Sqlite(rusqlite::Error::QueryReturnedNoRows))?;
        let thread = rt_thread_by_id_in_scope(
            &tx,
            &fence.account_scope,
            &fence.organization_id,
            &fence.thread_id,
        )?
        .ok_or_else(|| DbError::Sqlite(rusqlite::Error::QueryReturnedNoRows))?;
        tx.commit()?;
        Ok(RtTerminalSessionCasOutcome::Updated(Box::new(
            RtTerminalSessionCommit { session, thread },
        )))
    }

    /// Stores the provider-owned conversation id exactly once while the
    /// process attempt is live. A duplicate value is idempotent; a different
    /// value is a typed conflict and never overwrites the resumable identity.
    pub fn rt_checkpoint_terminal_provider_session(
        &self,
        fence: &RtThreadFence,
        session_id: &str,
        provider_session_id: &str,
    ) -> DbResult<RtTerminalProviderCheckpointOutcome> {
        let provider_session_id = provider_session_id.trim();
        if provider_session_id.is_empty() {
            return Err(DbError::InvalidTerminalSessionData(
                "provider session id must be non-empty".to_string(),
            ));
        }
        let ts = now_rfc3339();
        let mut conn = self.lock();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let Some(current) = rt_terminal_session_by_id_fenced(&tx, fence, session_id)? else {
            tx.commit()?;
            return Ok(RtTerminalProviderCheckpointOutcome::Missing);
        };
        if let Some(existing) = current.provider_session_id.as_deref() {
            if existing != provider_session_id {
                tx.commit()?;
                return Ok(RtTerminalProviderCheckpointOutcome::Conflict(current));
            }
            if (!current.blocks_prior_provider_resume
                && current.rejected_provider_session_id.is_none())
                || !current.physical_state.is_live()
            {
                tx.commit()?;
                return Ok(RtTerminalProviderCheckpointOutcome::Unchanged(current));
            }
            let changed = tx.execute(
                "UPDATE native_terminal_sessions SET \
                     blocks_prior_provider_resume = 0, rejected_provider_session_id = NULL, \
                     revision = revision + 1, updated_at = ?1 \
                 WHERE id = ?2 AND account_scope = ?3 AND organization_id = ?4 \
                   AND thread_id = ?5 AND thread_generation = ?6 \
                   AND provider_session_id = ?7 \
                   AND (blocks_prior_provider_resume = 1 OR \
                        rejected_provider_session_id IS NOT NULL) \
                   AND physical_state IN ('starting', 'running')",
                params![
                    ts,
                    session_id,
                    fence.account_scope,
                    fence.organization_id,
                    fence.thread_id,
                    fence.generation,
                    provider_session_id,
                ],
            )?;
            let stored = rt_terminal_session_by_id_fenced(&tx, fence, session_id)?;
            tx.commit()?;
            return Ok(match stored {
                Some(stored) if changed == 1 => RtTerminalProviderCheckpointOutcome::Stored(stored),
                Some(stored)
                    if stored.provider_session_id.as_deref() == Some(provider_session_id) =>
                {
                    RtTerminalProviderCheckpointOutcome::Unchanged(stored)
                }
                Some(stored) => RtTerminalProviderCheckpointOutcome::Conflict(stored),
                None => RtTerminalProviderCheckpointOutcome::Missing,
            });
        }
        if current.blocks_prior_provider_resume
            && current.rejected_provider_session_id.as_deref() == Some(provider_session_id)
        {
            tx.commit()?;
            return Ok(RtTerminalProviderCheckpointOutcome::Conflict(current));
        }
        if !current.physical_state.is_live() {
            tx.commit()?;
            return Ok(RtTerminalProviderCheckpointOutcome::NotLive(current));
        }
        let changed = tx.execute(
            "UPDATE native_terminal_sessions SET provider_session_id = ?1, \
                 blocks_prior_provider_resume = 0, rejected_provider_session_id = NULL, \
                 revision = revision + 1, updated_at = ?2 \
             WHERE id = ?3 AND account_scope = ?4 AND organization_id = ?5 \
               AND thread_id = ?6 AND thread_generation = ?7 \
               AND provider_session_id IS NULL \
               AND physical_state IN ('starting', 'running')",
            params![
                provider_session_id,
                ts,
                session_id,
                fence.account_scope,
                fence.organization_id,
                fence.thread_id,
                fence.generation,
            ],
        )?;
        if changed != 1 {
            let current = rt_terminal_session_by_id_fenced(&tx, fence, session_id)?;
            tx.commit()?;
            return Ok(match current {
                Some(current)
                    if current.provider_session_id.as_deref() == Some(provider_session_id) =>
                {
                    RtTerminalProviderCheckpointOutcome::Unchanged(current)
                }
                Some(current) if current.provider_session_id.is_some() => {
                    RtTerminalProviderCheckpointOutcome::Conflict(current)
                }
                Some(current) => RtTerminalProviderCheckpointOutcome::NotLive(current),
                None => RtTerminalProviderCheckpointOutcome::Missing,
            });
        }
        let stored = rt_terminal_session_by_id_fenced(&tx, fence, session_id)?
            .ok_or_else(|| DbError::Sqlite(rusqlite::Error::QueryReturnedNoRows))?;
        tx.commit()?;
        Ok(RtTerminalProviderCheckpointOutcome::Stored(stored))
    }

    /// A process cannot survive application boot as an owned terminal. Close
    /// every persisted live attempt in one transaction, retain any provider
    /// checkpoint for explicit resume, and atomically mark each owning thread
    /// failed. The archived v10 queue table is intentionally not read or
    /// modified here, so no pre-terminal prompt can become executable work.
    pub fn rt_interrupt_live_terminal_sessions_on_boot(
        &self,
    ) -> DbResult<Vec<RtTerminalSessionCommit>> {
        const INTERRUPTION: &str = "Studio restarted while the terminal process was active";
        let ts = now_rfc3339();
        let mut conn = self.lock();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let live = {
            let mut stmt = tx.prepare(&format!(
                "SELECT {RT_TERMINAL_SESSION_COLUMNS} FROM native_terminal_sessions \
                 WHERE physical_state IN ('starting', 'running') \
                 ORDER BY created_at ASC, rowid ASC"
            ))?;
            let rows = stmt.query_map([], row_to_rt_terminal_session)?;
            let mut sessions = Vec::new();
            for row in rows {
                sessions.push(row?);
            }
            sessions
        };
        let mut commits = Vec::with_capacity(live.len());
        for previous in live {
            let changed = tx.execute(
                "UPDATE native_terminal_sessions SET \
                     physical_state = 'exited', logical_state = 'interrupted', \
                     revision = revision + 1, exit_code = NULL, \
                     last_error = COALESCE(last_error, ?1), ended_at = ?2, updated_at = ?2 \
                 WHERE id = ?3 AND account_scope = ?4 AND organization_id = ?5 \
                   AND thread_id = ?6 AND thread_generation = ?7 AND revision = ?8 \
                   AND physical_state IN ('starting', 'running')",
                params![
                    INTERRUPTION,
                    ts,
                    previous.id,
                    previous.fence.account_scope,
                    previous.fence.organization_id,
                    previous.fence.thread_id,
                    previous.fence.generation,
                    previous.revision,
                ],
            )?;
            if changed != 1 {
                return Err(DbError::InvalidTerminalSessionData(format!(
                    "live terminal {} changed during exclusive boot interruption",
                    previous.id
                )));
            }
            let thread_changed = tx.execute(
                "UPDATE native_scoped_threads SET status = ?1, updated_at = ?2 \
                 WHERE account_scope = ?3 AND organization_id = ?4 AND id = ?5 \
                   AND generation = ?6",
                params![
                    RT_THREAD_STATUS_FAILED,
                    ts,
                    previous.fence.account_scope,
                    previous.fence.organization_id,
                    previous.fence.thread_id,
                    previous.fence.generation,
                ],
            )?;
            if thread_changed != 1 {
                return Err(DbError::StaleThreadGeneration {
                    organization_id: previous.fence.organization_id,
                    thread_id: previous.fence.thread_id,
                    generation: previous.fence.generation,
                });
            }
            let session = rt_terminal_session_by_id_fenced(&tx, &previous.fence, &previous.id)?
                .ok_or_else(|| DbError::Sqlite(rusqlite::Error::QueryReturnedNoRows))?;
            let thread = rt_thread_by_id_in_scope(
                &tx,
                &previous.fence.account_scope,
                &previous.fence.organization_id,
                &previous.fence.thread_id,
            )?
            .ok_or_else(|| DbError::Sqlite(rusqlite::Error::QueryReturnedNoRows))?;
            commits.push(RtTerminalSessionCommit { session, thread });
        }
        tx.commit()?;
        Ok(commits)
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

    /// Test helper for asserting the exact identity of a persisted message.
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

    #[cfg(test)]
    pub fn rt_get_message_in_org(
        &self,
        organization_id: &str,
        id: &str,
    ) -> DbResult<Option<RtMessage>> {
        self.rt_get_message_in_scope(&RtAccountScope::test_default(), organization_id, id)
    }

    /// Test helper that appends a message and bumps the parent thread's
    /// `updated_at` atomically. Repeating an id is idempotent only when
    /// thread/role/parts/metadata are semantically equal: the original row is
    /// returned, its `seq` is not consumed again, and the parent thread is not
    /// bumped a second time. Reusing an id for different content is an explicit
    /// [`DbError::IdempotencyConflict`].
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

    /// Retitle a thread, but only while it still carries `expected`.
    ///
    /// Guarded IN THE STATEMENT rather than read-then-write, so a user who
    /// renames the thread mid-turn always wins — the same intent as the
    /// cluster's `shouldGenerateTitle` gate plus its interceptor's second
    /// check, expressed once and atomically.
    ///
    /// Auto-titling calls this twice: [`DEFAULT_THREAD_TITLE`] -> the
    /// deterministic name, then that name -> the model's. Passing the prior
    /// name as `expected` is what lets the second write replace only a title
    /// this process wrote, never the user's.
    ///
    /// Returns whether a row was actually retitled.
    pub fn rt_retitle_thread_if_unchanged(
        &self,
        fence: &RtThreadFence,
        expected: &str,
        title: &str,
    ) -> DbResult<bool> {
        let ts = now_rfc3339();
        let conn = self.lock();
        let updated = conn.execute(
            "UPDATE native_scoped_threads SET title = ?1, updated_at = ?2 \
                 WHERE account_scope = ?3 AND organization_id = ?4 AND id = ?5 \
                   AND title = ?6",
            params![
                title,
                ts,
                fence.account_scope,
                fence.organization_id,
                fence.thread_id,
                expected,
            ],
        )?;
        Ok(updated > 0)
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

const RT_TERMINAL_SESSION_COLUMNS: &str = "id, account_scope, organization_id, thread_id, \
     thread_generation, harness_id, physical_state, logical_state, provider_session_id, \
     revision, exit_code, last_error, started_at, ended_at, created_at, updated_at, \
     blocks_prior_provider_resume, rejected_provider_session_id";

fn invalid_terminal_state_column(column: usize, value: &str) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(
        column,
        rusqlite::types::Type::Text,
        Box::new(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("invalid terminal state {value:?}"),
        )),
    )
}

fn row_to_rt_terminal_session(row: &rusqlite::Row) -> rusqlite::Result<RtTerminalSession> {
    let physical_raw: String = row.get(6)?;
    let logical_raw: String = row.get(7)?;
    let physical_state = RtTerminalPhysicalState::parse(&physical_raw)
        .ok_or_else(|| invalid_terminal_state_column(6, &physical_raw))?;
    let logical_state = RtTerminalLogicalState::parse(&logical_raw)
        .ok_or_else(|| invalid_terminal_state_column(7, &logical_raw))?;
    Ok(RtTerminalSession {
        id: row.get(0)?,
        fence: RtThreadFence {
            account_scope: row.get(1)?,
            organization_id: row.get(2)?,
            thread_id: row.get(3)?,
            generation: row.get(4)?,
        },
        harness_id: row.get(5)?,
        physical_state,
        logical_state,
        provider_session_id: row.get(8)?,
        blocks_prior_provider_resume: row.get::<_, i64>(16)? != 0,
        rejected_provider_session_id: row.get(17)?,
        revision: row.get(9)?,
        exit_code: row.get(10)?,
        last_error: row.get(11)?,
        started_at: row.get(12)?,
        ended_at: row.get(13)?,
        created_at: row.get(14)?,
        updated_at: row.get(15)?,
    })
}

fn rt_terminal_session_by_id_fenced(
    conn: &Connection,
    fence: &RtThreadFence,
    session_id: &str,
) -> DbResult<Option<RtTerminalSession>> {
    conn.query_row(
        &format!(
            "SELECT {RT_TERMINAL_SESSION_COLUMNS} FROM native_terminal_sessions \
             WHERE id = ?1 AND account_scope = ?2 AND organization_id = ?3 \
               AND thread_id = ?4 AND thread_generation = ?5"
        ),
        params![
            session_id,
            fence.account_scope,
            fence.organization_id,
            fence.thread_id,
            fence.generation,
        ],
        row_to_rt_terminal_session,
    )
    .optional()
    .map_err(DbError::from)
}

fn rt_live_terminal_session_fenced(
    conn: &Connection,
    fence: &RtThreadFence,
) -> DbResult<Option<RtTerminalSession>> {
    conn.query_row(
        &format!(
            "SELECT {RT_TERMINAL_SESSION_COLUMNS} FROM native_terminal_sessions \
             WHERE account_scope = ?1 AND organization_id = ?2 AND thread_id = ?3 \
               AND thread_generation = ?4 AND physical_state IN ('starting', 'running') \
             LIMIT 1"
        ),
        params![
            fence.account_scope,
            fence.organization_id,
            fence.thread_id,
            fence.generation,
        ],
        row_to_rt_terminal_session,
    )
    .optional()
    .map_err(DbError::from)
}

fn rt_latest_terminal_session_fenced(
    conn: &Connection,
    fence: &RtThreadFence,
) -> DbResult<Option<RtTerminalSession>> {
    conn.query_row(
        &format!(
            "SELECT {RT_TERMINAL_SESSION_COLUMNS} FROM native_terminal_sessions \
             WHERE account_scope = ?1 AND organization_id = ?2 AND thread_id = ?3 \
               AND thread_generation = ?4 \
             ORDER BY created_at DESC, rowid DESC LIMIT 1"
        ),
        params![
            fence.account_scope,
            fence.organization_id,
            fence.thread_id,
            fence.generation,
        ],
        row_to_rt_terminal_session,
    )
    .optional()
    .map_err(DbError::from)
}

fn validate_terminal_state_pair(
    physical: RtTerminalPhysicalState,
    logical: RtTerminalLogicalState,
    exit_code: Option<i32>,
) -> DbResult<()> {
    if physical == RtTerminalPhysicalState::Exited
        && !matches!(
            logical,
            RtTerminalLogicalState::Completed
                | RtTerminalLogicalState::Failed
                | RtTerminalLogicalState::Interrupted
        )
    {
        return Err(DbError::InvalidTerminalSessionData(format!(
            "exited process cannot have logical state {:?}",
            logical
        )));
    }
    if physical.is_live() && exit_code.is_some() {
        return Err(DbError::InvalidTerminalSessionData(
            "a live process cannot have an exit code".to_string(),
        ));
    }
    Ok(())
}

fn terminal_physical_transition_is_valid(
    current: RtTerminalPhysicalState,
    next: RtTerminalPhysicalState,
) -> bool {
    matches!(
        (current, next),
        (RtTerminalPhysicalState::Starting, _)
            | (
                RtTerminalPhysicalState::Running,
                RtTerminalPhysicalState::Running
            )
            | (
                RtTerminalPhysicalState::Running,
                RtTerminalPhysicalState::Exited
            )
    )
}

fn terminal_thread_status(
    physical: RtTerminalPhysicalState,
    logical: RtTerminalLogicalState,
) -> &'static str {
    if physical == RtTerminalPhysicalState::Starting {
        return RT_THREAD_STATUS_COMPLETED;
    }
    match logical {
        RtTerminalLogicalState::Working => RT_THREAD_STATUS_IN_PROGRESS,
        RtTerminalLogicalState::WaitingInput => RT_THREAD_STATUS_REQUIRES_ACTION,
        RtTerminalLogicalState::Failed | RtTerminalLogicalState::Interrupted => {
            RT_THREAD_STATUS_FAILED
        }
        RtTerminalLogicalState::Idle | RtTerminalLogicalState::Completed => {
            RT_THREAD_STATUS_COMPLETED
        }
    }
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

#[cfg(test)]
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

fn like_escape(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    type TableShapeRow = (i64, String, String, i64, Option<String>, i64);
    type ForeignKeyShapeRow = (i64, i64, String, String, String, String, String, String);

    fn local_db_path(app_root: &Path) -> PathBuf {
        app_root.join(crate::STUDIO_DB_FILE_NAME)
    }

    /// Pins the thread-status wire vocabulary byte-for-byte. These strings
    /// live in persisted SQLite rows, the watch SSE stream, and the
    /// COLLECTION_THREADS_* wire contract — a change here is a migration and
    /// a cross-language contract change, never a rename.
    #[test]
    fn thread_status_vocabulary_is_pinned() {
        assert_eq!(
            RT_THREAD_STATUSES,
            ["in_progress", "completed", "requires_action", "failed"]
        );
        for status in RT_THREAD_STATUSES {
            assert!(is_thread_status(status));
        }
        assert!(!is_thread_status(""));
        assert!(!is_thread_status("cancelled"));
        assert!(!is_thread_status("In_Progress"));
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

    fn terminal_fence(db: &ThreadsDb, organization_id: &str, thread_id: &str) -> RtThreadFence {
        db.rt_thread_fence_in_org(organization_id, thread_id)
            .unwrap()
            .unwrap()
    }

    fn created_terminal(outcome: RtTerminalSessionCreateOutcome) -> RtTerminalSessionCommit {
        match outcome {
            RtTerminalSessionCreateOutcome::Created(commit) => commit,
            RtTerminalSessionCreateOutcome::ExistingLive(_) => {
                panic!("expected a newly created terminal session")
            }
        }
    }

    fn updated_terminal(outcome: RtTerminalSessionCasOutcome) -> RtTerminalSessionCommit {
        match outcome {
            RtTerminalSessionCasOutcome::Updated(commit) => *commit,
            RtTerminalSessionCasOutcome::Stale(_) => panic!("expected terminal session update"),
            RtTerminalSessionCasOutcome::Missing => panic!("expected terminal session"),
        }
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
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM sqlite_schema \
                 WHERE type = 'table' AND name = 'native_scoped_turn_queue'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
            0,
            "the retired queue must not remain in the production schema"
        );
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM pragma_table_info('native_terminal_sessions') \
                 WHERE name IN (\
                     'id', 'account_scope', 'organization_id', 'thread_id', \
                     'thread_generation', 'harness_id', 'physical_state', 'logical_state', \
                     'provider_session_id', 'revision', 'exit_code', 'last_error', \
                     'started_at', 'ended_at', 'created_at', 'updated_at', \
                     'blocks_prior_provider_resume', 'rejected_provider_session_id'\
                 )",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
            18
        );
        assert!(index_shape(&conn, "native_terminal_sessions").iter().any(
            |(name, unique, _, partial)| {
                name == "idx_native_terminal_sessions_one_live" && *unique == 1 && *partial == 1
            }
        ));
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM native_legacy_turn_queue_v10",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
            0
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
            db.lock()
                .query_row(
                    "SELECT title FROM threads WHERE id = 'legacy-mini-thread'",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
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
    fn version_two_database_gets_thread_generations_before_queue_archive() {
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
        assert_eq!(
            db.lock()
                .query_row(
                    "SELECT COUNT(*) FROM native_legacy_turn_queue_v10",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            0
        );
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
            ("native_legacy_turn_queue_v10", 1),
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
                "SELECT assistant_message_id FROM native_legacy_turn_queue_v10 \
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
                "SELECT `table` FROM pragma_foreign_key_list('native_legacy_turn_queue_v10') LIMIT 1",
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
        let archived_queue = conn
            .prepare(
                "SELECT workflow_id, claim_token FROM native_legacy_turn_queue_v10 \
                 ORDER BY fifo_ordinal",
            )
            .unwrap()
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(
            archived_queue,
            [
                ("v5-running".to_string(), Some("v5-claim".to_string())),
                ("v5-queued".to_string(), None),
            ]
        );
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
            "idx_native_scoped_threads_account_org_updated",
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
                "SELECT `table` FROM pragma_foreign_key_list('native_legacy_turn_queue_v10') LIMIT 1",
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
    fn version_seven_upgrade_backfills_archived_queue_ids_without_changing_message_pk() {
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
                "SELECT message_id, assistant_message_id FROM native_legacy_turn_queue_v10 \
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
                "SELECT COUNT(*) FROM pragma_table_info('native_legacy_turn_queue_v10') \
                 WHERE name IN ('quarantine_reason', 'quarantine_preserve_user')",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
            2
        );
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM native_legacy_turn_queue_v10 \
                 WHERE checkpoint_harness_id IS NOT NULL OR checkpoint_session_id IS NOT NULL",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
            0,
            "v11 archives every older queue row with no invented provider session"
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
        create_rt_thread(&db, "permission-check-org", "permission-check-thread");
        // The db sits at the app root now, and the app root is the USER'S
        // directory — open() secures the database files themselves and must
        // not chmod the directory around them.
        assert_eq!(
            fs::metadata(&app_root).unwrap().permissions().mode() & 0o777,
            0o755
        );
        for path in crate::fs_util::sqlite_file_family(&local_db_path(&app_root)) {
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
        let message_parts = serde_json::json!([{"type": "text", "text": "kept"}]);
        db.rt_append_message_in_org(
            "org-a",
            "assistant-a",
            "thread-a",
            "assistant",
            &message_parts,
            None,
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
    fn thread_generation_fences_stale_writes_and_delete_retires_id() {
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
        assert!(db
            .rt_delete_thread_in_org_if_generation(&old_fence)
            .unwrap());
        assert!(!db
            .rt_pin_harness_if_unset_fenced(&old_fence, "claude-code", Some("user-desktop"), None,)
            .unwrap());
        assert!(!db
            .rt_delete_thread_in_org_if_generation(&old_fence)
            .unwrap());
        assert!(db.rt_get_thread("thread").unwrap().is_none());

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
                },
            )
            .unwrap();
        // Unpaginated: the count and the returned rows are now always the same
        // set. The old expectation of 1 item out of 2 was a `limit: 1` slice,
        // not a filter result.
        assert_eq!(trigger_total, 2);
        assert_eq!(trigger_items.len(), 2);
        let mut ids = trigger_items
            .iter()
            .map(|item| item.id.clone())
            .collect::<Vec<_>>();
        ids.sort();
        assert_eq!(
            ids,
            vec!["normal-match".to_string(), "normal-other".to_string()]
        );
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
            db.lock()
                .query_row(
                    "SELECT account_scope FROM native_legacy_turn_queue_v10 \
                     WHERE workflow_id = 'legacy-workflow'",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            prod_user.storage_key(),
            "account adoption must scope preserved legacy user content too"
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

    #[test]
    fn terminal_session_lifecycle_is_generation_cas_fenced_and_updates_thread_status() {
        let db = ThreadsDb::open_in_memory().unwrap();
        create_rt_thread(&db, "org", "terminal-thread");
        let fence = terminal_fence(&db, "org", "terminal-thread");

        assert!(matches!(
            db.rt_create_terminal_session_fenced(
                &fence,
                "native-terminal:spoofed-migration-row",
                "claude-code",
            ),
            Err(DbError::InvalidTerminalSessionData(_))
        ));

        let created = created_terminal(
            db.rt_create_terminal_session_fenced(&fence, "terminal-1", "claude-code")
                .unwrap(),
        );
        assert_eq!(created.session.id, "terminal-1");
        assert_eq!(
            created.session.physical_state,
            RtTerminalPhysicalState::Starting
        );
        assert_eq!(created.session.logical_state, RtTerminalLogicalState::Idle);
        assert_eq!(created.session.revision, 0);
        assert_eq!(created.thread.status, RT_THREAD_STATUS_COMPLETED);
        assert_eq!(created.thread.harness_id, None);
        assert!(db
            .rt_pin_harness_if_unset_fenced(&fence, "claude-code", None, None)
            .unwrap());
        assert_eq!(
            db.rt_harness_id_fenced(&fence)
                .unwrap()
                .flatten()
                .as_deref(),
            Some("claude-code")
        );

        let attached = db
            .rt_create_terminal_session_fenced(&fence, "terminal-2", "claude-code")
            .unwrap();
        assert!(matches!(
            attached,
            RtTerminalSessionCreateOutcome::ExistingLive(ref commit)
                if commit.session.id == "terminal-1"
        ));
        assert!(matches!(
            db.rt_create_terminal_session_fenced(&fence, "terminal-2", "codex"),
            Err(DbError::InvalidTerminalSessionData(_))
        ));

        let running = updated_terminal(
            db.rt_compare_and_set_terminal_session_state(
                &fence,
                "terminal-1",
                0,
                RtTerminalPhysicalState::Running,
                RtTerminalLogicalState::Working,
                None,
                None,
            )
            .unwrap(),
        );
        assert_eq!(running.session.revision, 1);
        assert!(running.session.started_at.is_some());
        assert_eq!(running.thread.status, RT_THREAD_STATUS_IN_PROGRESS);

        let stale = db
            .rt_compare_and_set_terminal_session_state(
                &fence,
                "terminal-1",
                0,
                RtTerminalPhysicalState::Running,
                RtTerminalLogicalState::WaitingInput,
                None,
                None,
            )
            .unwrap();
        assert!(matches!(
            stale,
            RtTerminalSessionCasOutcome::Stale(ref current) if current.revision == 1
        ));

        let waiting = updated_terminal(
            db.rt_compare_and_set_terminal_session_state(
                &fence,
                "terminal-1",
                1,
                RtTerminalPhysicalState::Running,
                RtTerminalLogicalState::WaitingInput,
                None,
                None,
            )
            .unwrap(),
        );
        assert_eq!(waiting.thread.status, RT_THREAD_STATUS_REQUIRES_ACTION);

        let idle = updated_terminal(
            db.rt_compare_and_set_terminal_session_state(
                &fence,
                "terminal-1",
                2,
                RtTerminalPhysicalState::Running,
                RtTerminalLogicalState::Idle,
                None,
                None,
            )
            .unwrap(),
        );
        assert_eq!(idle.thread.status, RT_THREAD_STATUS_COMPLETED);

        let exited = updated_terminal(
            db.rt_compare_and_set_terminal_session_state(
                &fence,
                "terminal-1",
                3,
                RtTerminalPhysicalState::Exited,
                RtTerminalLogicalState::Completed,
                Some(0),
                None,
            )
            .unwrap(),
        );
        assert_eq!(exited.session.revision, 4);
        assert_eq!(exited.session.exit_code, Some(0));
        assert!(exited.session.ended_at.is_some());
        assert_eq!(exited.thread.status, RT_THREAD_STATUS_COMPLETED);
        assert!(db
            .rt_get_live_terminal_session_fenced(&fence)
            .unwrap()
            .is_none());
        assert!(matches!(
            db.rt_compare_and_set_terminal_session_state(
                &fence,
                "terminal-1",
                4,
                RtTerminalPhysicalState::Running,
                RtTerminalLogicalState::Working,
                None,
                None,
            )
            .unwrap(),
            RtTerminalSessionCasOutcome::Stale(ref current)
                if current.physical_state == RtTerminalPhysicalState::Exited
        ));

        let second = created_terminal(
            db.rt_create_terminal_session_fenced(&fence, "terminal-2", "claude-code")
                .unwrap(),
        );
        assert_eq!(second.session.id, "terminal-2");
        assert_eq!(
            db.rt_get_latest_terminal_session_fenced(&fence)
                .unwrap()
                .unwrap()
                .id,
            "terminal-2"
        );

        let stale_fence = RtThreadFence {
            generation: "retired-generation".to_string(),
            ..fence.clone()
        };
        assert!(matches!(
            db.rt_create_terminal_session_fenced(&stale_fence, "terminal-stale", "claude-code"),
            Err(DbError::StaleThreadGeneration { .. })
        ));
        assert!(matches!(
            db.rt_compare_and_set_terminal_session_state(
                &fence,
                "terminal-2",
                0,
                RtTerminalPhysicalState::Exited,
                RtTerminalLogicalState::Idle,
                None,
                None,
            ),
            Err(DbError::InvalidTerminalSessionData(_))
        ));
    }

    #[test]
    fn provider_checkpoint_is_write_once_and_boot_interrupts_live_processes() {
        let db = ThreadsDb::open_in_memory().unwrap();
        for thread_id in ["checkpoint-thread", "other-live-thread"] {
            create_rt_thread(&db, "org", thread_id);
        }
        let first_fence = terminal_fence(&db, "org", "checkpoint-thread");
        let second_fence = terminal_fence(&db, "org", "other-live-thread");
        created_terminal(
            db.rt_create_terminal_session_fenced(&first_fence, "checkpoint-terminal", "codex")
                .unwrap(),
        );
        created_terminal(
            db.rt_create_terminal_session_fenced(&second_fence, "other-terminal", "claude-code")
                .unwrap(),
        );

        let stored = db
            .rt_checkpoint_terminal_provider_session(
                &first_fence,
                "checkpoint-terminal",
                "  provider-session  ",
            )
            .unwrap();
        assert!(matches!(
            stored,
            RtTerminalProviderCheckpointOutcome::Stored(ref session)
                if session.provider_session_id.as_deref() == Some("provider-session")
                    && session.revision == 1
        ));
        assert!(matches!(
            db.rt_checkpoint_terminal_provider_session(
                &first_fence,
                "checkpoint-terminal",
                "provider-session",
            )
            .unwrap(),
            RtTerminalProviderCheckpointOutcome::Unchanged(ref session)
                if session.revision == 1
        ));
        assert!(matches!(
            db.rt_checkpoint_terminal_provider_session(
                &first_fence,
                "checkpoint-terminal",
                "different-session",
            )
            .unwrap(),
            RtTerminalProviderCheckpointOutcome::Conflict(ref session)
                if session.provider_session_id.as_deref() == Some("provider-session")
        ));

        updated_terminal(
            db.rt_compare_and_set_terminal_session_state(
                &first_fence,
                "checkpoint-terminal",
                1,
                RtTerminalPhysicalState::Running,
                RtTerminalLogicalState::Working,
                None,
                None,
            )
            .unwrap(),
        );
        let interrupted = db.rt_interrupt_live_terminal_sessions_on_boot().unwrap();
        assert_eq!(interrupted.len(), 2);
        let first = interrupted
            .iter()
            .find(|commit| commit.session.id == "checkpoint-terminal")
            .unwrap();
        assert_eq!(
            first.session.physical_state,
            RtTerminalPhysicalState::Exited
        );
        assert_eq!(
            first.session.logical_state,
            RtTerminalLogicalState::Interrupted
        );
        assert_eq!(
            first.session.provider_session_id.as_deref(),
            Some("provider-session")
        );
        assert_eq!(first.session.revision, 3);
        assert!(first.session.last_error.is_some());
        assert_eq!(first.thread.status, RT_THREAD_STATUS_FAILED);
        assert!(interrupted
            .iter()
            .all(|commit| commit.thread.status == RT_THREAD_STATUS_FAILED));
        assert!(db
            .rt_interrupt_live_terminal_sessions_on_boot()
            .unwrap()
            .is_empty());

        created_terminal(
            db.rt_create_terminal_session_fenced(&first_fence, "checkpoint-less-retry", "codex")
                .unwrap(),
        );
        updated_terminal(
            db.rt_compare_and_set_terminal_session_state(
                &first_fence,
                "checkpoint-less-retry",
                0,
                RtTerminalPhysicalState::Exited,
                RtTerminalLogicalState::Failed,
                Some(1),
                Some("failed before provider checkpoint"),
            )
            .unwrap(),
        );
        assert_eq!(
            db.rt_get_latest_terminal_session_fenced(&first_fence)
                .unwrap()
                .unwrap()
                .id,
            "checkpoint-less-retry"
        );
        assert_eq!(
            db.rt_terminal_resume_decision_fenced(&first_fence, "codex")
                .unwrap(),
            RtTerminalResumeDecision::Resume("provider-session".to_string()),
            "a failed attempt without a checkpoint must not hide resumable history"
        );

        created_terminal(
            db.rt_create_terminal_session_fenced(&first_fence, "app-interrupted-resume", "codex")
                .unwrap(),
        );
        let interrupted_resume = db.rt_interrupt_live_terminal_sessions_on_boot().unwrap();
        assert_eq!(interrupted_resume.len(), 1);
        assert!(!interrupted_resume[0].session.blocks_prior_provider_resume);
        assert!(interrupted_resume[0]
            .session
            .rejected_provider_session_id
            .is_none());
        assert_eq!(
            db.rt_terminal_resume_decision_fenced(&first_fence, "codex")
                .unwrap(),
            RtTerminalResumeDecision::Resume("provider-session".to_string()),
            "an app-interrupted resume without provider evidence must retry its older checkpoint"
        );

        created_terminal(
            db.rt_create_terminal_session_fenced(&first_fence, "invalid-resume", "codex")
                .unwrap(),
        );
        assert!(db
            .rt_confirm_terminal_resume_rejected_fenced(
                &first_fence,
                "invalid-resume",
                "provider-session",
            )
            .unwrap());
        let rejected = db
            .rt_get_terminal_session_fenced(&first_fence, "invalid-resume")
            .unwrap()
            .unwrap();
        assert!(rejected.blocks_prior_provider_resume);
        assert_eq!(
            rejected.rejected_provider_session_id.as_deref(),
            Some("provider-session")
        );
        let interrupted_recovery = db.rt_interrupt_live_terminal_sessions_on_boot().unwrap();
        assert_eq!(interrupted_recovery.len(), 1);
        assert!(interrupted_recovery[0].session.blocks_prior_provider_resume);
        assert_eq!(
            interrupted_recovery[0]
                .session
                .rejected_provider_session_id
                .as_deref(),
            Some("provider-session")
        );
        assert_eq!(
            db.rt_terminal_resume_decision_fenced(&first_fence, "codex")
                .unwrap(),
            RtTerminalResumeDecision::Fresh,
            "an exact provider rejection must survive interruption of fresh recovery"
        );

        created_terminal(
            db.rt_create_terminal_session_fenced(&first_fence, "fresh-recovery-failed", "codex")
                .unwrap(),
        );
        updated_terminal(
            db.rt_compare_and_set_terminal_session_state(
                &first_fence,
                "fresh-recovery-failed",
                0,
                RtTerminalPhysicalState::Exited,
                RtTerminalLogicalState::Failed,
                Some(1),
                Some("fresh recovery failed before checkpoint"),
            )
            .unwrap(),
        );
        assert_eq!(
            db.rt_terminal_resume_decision_fenced(&first_fence, "codex")
                .unwrap(),
            RtTerminalResumeDecision::Fresh,
            "failed fresh recovery must not uncover the known-bad checkpoint"
        );
        created_terminal(
            db.rt_create_terminal_session_fenced(&first_fence, "fresh-recovery", "codex")
                .unwrap(),
        );
        assert!(matches!(
            db.rt_checkpoint_terminal_provider_session(
                &first_fence,
                "fresh-recovery",
                "provider-session-fresh",
            )
            .unwrap(),
            RtTerminalProviderCheckpointOutcome::Stored(_)
        ));
        assert_eq!(
            db.rt_terminal_resume_decision_fenced(&first_fence, "codex")
                .unwrap(),
            RtTerminalResumeDecision::Resume("provider-session-fresh".to_string())
        );

        assert!(matches!(
            db.rt_checkpoint_terminal_provider_session(
                &second_fence,
                "other-terminal",
                "too-late",
            )
            .unwrap(),
            RtTerminalProviderCheckpointOutcome::NotLive(ref session)
                if session.physical_state == RtTerminalPhysicalState::Exited
        ));
    }

    #[test]
    fn exact_resume_rejection_and_checkpoint_races_converge() {
        let db = ThreadsDb::open_in_memory().unwrap();
        create_rt_thread(&db, "org", "resume-race-thread");
        let fence = terminal_fence(&db, "org", "resume-race-thread");
        let exit = |session_id: &str| {
            let current = db
                .rt_get_terminal_session_fenced(&fence, session_id)
                .unwrap()
                .unwrap();
            updated_terminal(
                db.rt_compare_and_set_terminal_session_state(
                    &fence,
                    session_id,
                    current.revision,
                    RtTerminalPhysicalState::Exited,
                    RtTerminalLogicalState::Completed,
                    Some(0),
                    None,
                )
                .unwrap(),
            );
        };

        created_terminal(
            db.rt_create_terminal_session_fenced(&fence, "checkpoint-first", "claude-code")
                .unwrap(),
        );
        assert!(matches!(
            db.rt_checkpoint_terminal_provider_session(
                &fence,
                "checkpoint-first",
                "provider-checkpoint-first",
            )
            .unwrap(),
            RtTerminalProviderCheckpointOutcome::Stored(_)
        ));
        assert!(!db
            .rt_confirm_terminal_resume_rejected_fenced(
                &fence,
                "checkpoint-first",
                "provider-checkpoint-first",
            )
            .unwrap());
        let checkpoint_first = db
            .rt_get_terminal_session_fenced(&fence, "checkpoint-first")
            .unwrap()
            .unwrap();
        assert!(!checkpoint_first.blocks_prior_provider_resume);
        assert!(checkpoint_first.rejected_provider_session_id.is_none());
        exit("checkpoint-first");
        assert_eq!(
            db.rt_terminal_resume_decision_fenced(&fence, "claude-code")
                .unwrap(),
            RtTerminalResumeDecision::Resume("provider-checkpoint-first".to_string())
        );

        created_terminal(
            db.rt_create_terminal_session_fenced(&fence, "rejection-first", "claude-code")
                .unwrap(),
        );
        assert!(db
            .rt_confirm_terminal_resume_rejected_fenced(
                &fence,
                "rejection-first",
                "provider-rejected",
            )
            .unwrap());
        let rejection = db
            .rt_get_terminal_session_fenced(&fence, "rejection-first")
            .unwrap()
            .unwrap();
        assert!(rejection.blocks_prior_provider_resume);
        assert_eq!(rejection.revision, 1);
        assert_eq!(
            rejection.rejected_provider_session_id.as_deref(),
            Some("provider-rejected")
        );
        assert!(db
            .rt_confirm_terminal_resume_rejected_fenced(
                &fence,
                "rejection-first",
                "provider-rejected",
            )
            .unwrap());
        assert_eq!(
            db.rt_get_terminal_session_fenced(&fence, "rejection-first")
                .unwrap()
                .unwrap()
                .revision,
            1,
            "repeating the same exact rejection must be idempotent"
        );
        assert!(!db
            .rt_confirm_terminal_resume_rejected_fenced(
                &fence,
                "rejection-first",
                "different-rejection",
            )
            .unwrap());
        assert!(matches!(
            db.rt_checkpoint_terminal_provider_session(
                &fence,
                "rejection-first",
                "provider-rejected",
            )
            .unwrap(),
            RtTerminalProviderCheckpointOutcome::Conflict(ref session)
                if session.blocks_prior_provider_resume
                    && session.rejected_provider_session_id.as_deref()
                        == Some("provider-rejected")
        ));
        assert!(matches!(
            db.rt_checkpoint_terminal_provider_session(
                &fence,
                "rejection-first",
                "provider-fresh-after-rejection",
            )
            .unwrap(),
            RtTerminalProviderCheckpointOutcome::Stored(ref session)
                if !session.blocks_prior_provider_resume
                    && session.rejected_provider_session_id.is_none()
        ));
        exit("rejection-first");
        assert_eq!(
            db.rt_terminal_resume_decision_fenced(&fence, "claude-code")
                .unwrap(),
            RtTerminalResumeDecision::Resume("provider-fresh-after-rejection".to_string())
        );

        created_terminal(
            db.rt_create_terminal_session_fenced(&fence, "legacy-ambiguous", "claude-code")
                .unwrap(),
        );
        assert!(matches!(
            db.rt_checkpoint_terminal_provider_session(
                &fence,
                "legacy-ambiguous",
                "missing-provider-session",
            )
            .unwrap(),
            RtTerminalProviderCheckpointOutcome::Stored(_)
        ));
        assert_eq!(
            db.lock()
                .execute(
                    "UPDATE native_terminal_sessions SET \
                         blocks_prior_provider_resume = 1, revision = revision + 1 \
                     WHERE id = 'legacy-ambiguous'",
                    [],
                )
                .unwrap(),
            1
        );
        exit("legacy-ambiguous");
        assert_eq!(
            db.rt_terminal_resume_decision_fenced(&fence, "claude-code")
                .unwrap(),
            RtTerminalResumeDecision::Resume("missing-provider-session".to_string()),
            "legacy id-plus-barrier rows are ambiguous and must remain retryable"
        );
    }

    #[test]
    fn terminal_session_scope_delete_pending_and_parent_cascade_are_enforced() {
        let db = ThreadsDb::open_in_memory().unwrap();
        create_rt_thread(&db, "org", "delete-terminal-thread");
        let fence = terminal_fence(&db, "org", "delete-terminal-thread");
        created_terminal(
            db.rt_create_terminal_session_fenced(&fence, "delete-terminal", "codex")
                .unwrap(),
        );
        let foreign_scope = RtAccountScope::new("other.example", "user").unwrap();
        assert!(db
            .rt_get_terminal_session_in_scope(
                &foreign_scope,
                "org",
                "delete-terminal-thread",
                "delete-terminal",
            )
            .unwrap()
            .is_none());
        assert!(db.rt_mark_thread_delete_pending(&fence).unwrap());
        assert!(matches!(
            db.rt_create_terminal_session_fenced(&fence, "blocked-terminal", "codex"),
            Err(DbError::ThreadDeletePending { .. })
        ));
        assert!(matches!(
            db.rt_compare_and_set_terminal_session_state(
                &fence,
                "delete-terminal",
                0,
                RtTerminalPhysicalState::Running,
                RtTerminalLogicalState::Working,
                None,
                None,
            ),
            Err(DbError::ThreadDeletePending { .. })
        ));
        let reaped = updated_terminal(
            db.rt_compare_and_set_terminal_session_state(
                &fence,
                "delete-terminal",
                0,
                RtTerminalPhysicalState::Exited,
                RtTerminalLogicalState::Interrupted,
                None,
                Some("deleted"),
            )
            .unwrap(),
        );
        assert_eq!(reaped.thread.status, RT_THREAD_STATUS_FAILED);

        assert!(db.rt_delete_thread_in_org_if_generation(&fence).unwrap());
        assert!(db
            .rt_get_terminal_session_fenced(&fence, "delete-terminal")
            .unwrap()
            .is_none());
        assert_eq!(
            db.lock()
                .query_row("SELECT COUNT(*) FROM native_terminal_sessions", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            0
        );
    }

    #[test]
    fn version_twelve_clears_ambiguous_null_barriers_and_preserves_checkpoint_rows() {
        let dir = tempfile::tempdir().unwrap();
        let scope = RtAccountScope::new("studio.decocms.com", "v12-user").unwrap();
        create_v7_fixture(dir.path(), &scope, "v12-org", "v12-thread");
        {
            let conn = Connection::open(local_db_path(dir.path())).unwrap();
            conn.pragma_update(None, "foreign_keys", 1).unwrap();
            for migration in MIGRATIONS
                .iter()
                .filter(|migration| (8..=11).contains(&migration.version))
            {
                conn.execute_batch(migration.sql).unwrap();
                conn.pragma_update(None, "user_version", migration.version)
                    .unwrap();
            }
            conn.execute(
                "UPDATE native_scoped_threads SET harness_id = 'claude-code' \
                 WHERE account_scope = ?1 AND organization_id = 'v12-org' \
                   AND id = 'v12-thread'",
                [scope.storage_key()],
            )
            .unwrap();
            let generation: String = conn
                .query_row(
                    "SELECT generation FROM native_scoped_threads \
                     WHERE account_scope = ?1 AND organization_id = 'v12-org' \
                       AND id = 'v12-thread'",
                    [scope.storage_key()],
                    |row| row.get(0),
                )
                .unwrap();
            for (id, physical, logical, provider, blocks, created) in [
                (
                    "legacy-checkpoint",
                    "exited",
                    "completed",
                    Some("provider-a"),
                    0,
                    "2026-01-01T00:00:01Z",
                ),
                (
                    "legacy-id-barrier",
                    "exited",
                    "failed",
                    Some("provider-b"),
                    1,
                    "2026-01-01T00:00:02Z",
                ),
                (
                    "legacy-null-failed",
                    "exited",
                    "failed",
                    None,
                    1,
                    "2026-01-01T00:00:03Z",
                ),
                (
                    "legacy-null-interrupted",
                    "exited",
                    "interrupted",
                    None,
                    1,
                    "2026-01-01T00:00:04Z",
                ),
                (
                    "legacy-null-live",
                    "starting",
                    "idle",
                    None,
                    1,
                    "2026-01-01T00:00:05Z",
                ),
            ] {
                conn.execute(
                    "INSERT INTO native_terminal_sessions (\
                         id, account_scope, organization_id, thread_id, thread_generation, \
                         harness_id, physical_state, logical_state, provider_session_id, \
                         revision, exit_code, last_error, started_at, ended_at, created_at, \
                         updated_at, blocks_prior_provider_resume\
                     ) VALUES (?1, ?2, 'v12-org', 'v12-thread', ?3, 'claude-code', \
                         ?4, ?5, ?6, 0, NULL, NULL, NULL, \
                         CASE WHEN ?4 = 'exited' THEN ?8 ELSE NULL END, ?8, ?8, ?7)",
                    params![
                        id,
                        scope.storage_key(),
                        generation,
                        physical,
                        logical,
                        provider,
                        blocks,
                        created,
                    ],
                )
                .unwrap();
            }
            conn.pragma_update(None, "user_version", 11).unwrap();
            validate_foreign_keys(&conn).unwrap();
        }

        let db = ThreadsDb::open(dir.path()).unwrap();
        assert_eq!(schema_version(&local_db_path(dir.path())), 12);
        let fence = db
            .rt_thread_fence_in_scope(&scope, "v12-org", "v12-thread")
            .unwrap()
            .unwrap();
        for id in [
            "legacy-null-failed",
            "legacy-null-interrupted",
            "legacy-null-live",
        ] {
            let migrated = db
                .rt_get_terminal_session_fenced(&fence, id)
                .unwrap()
                .unwrap();
            assert!(!migrated.blocks_prior_provider_resume, "row {id}");
            assert!(migrated.rejected_provider_session_id.is_none(), "row {id}");
        }
        let legacy_id_barrier = db
            .rt_get_terminal_session_fenced(&fence, "legacy-id-barrier")
            .unwrap()
            .unwrap();
        assert!(legacy_id_barrier.blocks_prior_provider_resume);
        assert!(legacy_id_barrier.rejected_provider_session_id.is_none());
        assert_eq!(
            db.lock()
                .execute(
                    "UPDATE native_terminal_sessions \
                     SET blocks_prior_provider_resume = 1, revision = revision + 1 \
                     WHERE id = 'legacy-null-failed'",
                    [],
                )
                .unwrap(),
            1
        );
        assert_eq!(
            db.rt_terminal_resume_decision_fenced(&fence, "claude-code")
                .unwrap(),
            RtTerminalResumeDecision::Resume("provider-b".to_string()),
            "a null-provider flag without a rejected identity is not a barrier"
        );
        let interrupted = db.rt_interrupt_live_terminal_sessions_on_boot().unwrap();
        assert_eq!(interrupted.len(), 1);
        assert_eq!(interrupted[0].session.id, "legacy-null-live");
        assert_eq!(
            db.rt_terminal_resume_decision_fenced(&fence, "claude-code")
                .unwrap(),
            RtTerminalResumeDecision::Resume("provider-b".to_string())
        );
    }

    #[test]
    fn version_ten_queue_rows_are_archived_never_recovered_and_cascade_on_delete() {
        let dir = tempfile::tempdir().unwrap();
        let scope = RtAccountScope::new("studio.decocms.com", "v10-user").unwrap();
        create_v7_fixture(dir.path(), &scope, "v10-org", "v10-thread");
        {
            let conn = Connection::open(local_db_path(dir.path())).unwrap();
            conn.pragma_update(None, "foreign_keys", 1).unwrap();
            for migration in MIGRATIONS
                .iter()
                .filter(|migration| (8..=10).contains(&migration.version))
            {
                conn.execute_batch(migration.sql).unwrap();
                conn.pragma_update(None, "user_version", migration.version)
                    .unwrap();
            }
            conn.execute(
                "UPDATE native_scoped_turn_queue SET \
                     checkpoint_harness_id = 'codex', \
                     checkpoint_session_id = CASE workflow_id \
                         WHEN 'v5-running' THEN 'provider-v10-older' \
                         ELSE 'provider-v10-newest-valid' \
                     END",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO native_scoped_turn_queue (\
                     account_scope, organization_id, thread_id, thread_generation, message_id, \
                     assistant_message_id, workflow_id, task_id, normalized_input_json, \
                     user_message_json, enqueued_at, fifo_ordinal, state, claim_token, \
                     checkpoint_harness_id, checkpoint_session_id\
                 ) VALUES (?1, 'v10-org', 'v10-thread', 'v4-generation', \
                     'v10-invalid-message', 'native-assistant:v1:v10-invalid', \
                     'v10-invalid-workflow', 'v10-task', '{}', \
                     '{\"id\":\"v10-invalid-message\",\"role\":\"user\",\"parts\":[]}', \
                     10, 10, 'queued', NULL, 'claude-code', 'provider-v10-invalid-latest')",
                [scope.storage_key()],
            )
            .unwrap();
            conn.execute(
                "UPDATE native_scoped_threads SET harness_id = 'codex' \
                 WHERE id = 'v10-thread'",
                [],
            )
            .unwrap();
            validate_foreign_keys(&conn).unwrap();
        }

        let db = ThreadsDb::open(dir.path()).unwrap();
        assert_eq!(schema_version(&local_db_path(dir.path())), 12);
        let fence = db
            .rt_thread_fence_in_scope(&scope, "v10-org", "v10-thread")
            .unwrap()
            .unwrap();
        assert_eq!(
            db.rt_thread_fenced(&fence).unwrap().unwrap().status,
            RT_THREAD_STATUS_REQUIRES_ACTION
        );
        let recovered = db
            .rt_get_latest_terminal_session_fenced(&fence)
            .unwrap()
            .unwrap();
        assert!(recovered.id.starts_with(NATIVE_TERMINAL_SESSION_ID_PREFIX));
        assert_eq!(recovered.harness_id, "codex");
        assert_eq!(
            recovered.provider_session_id.as_deref(),
            Some("provider-v10-newest-valid")
        );
        assert_eq!(recovered.physical_state, RtTerminalPhysicalState::Exited);
        assert_eq!(recovered.logical_state, RtTerminalLogicalState::Interrupted);
        assert!(db
            .rt_interrupt_live_terminal_sessions_on_boot()
            .unwrap()
            .is_empty());
        {
            let conn = db.lock();
            assert_eq!(
                conn.query_row(
                    "SELECT COUNT(*) FROM sqlite_schema \
                     WHERE type = 'table' AND name = 'native_scoped_turn_queue'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
                0,
                "the executable queue table must be absent after cutover"
            );
            assert_eq!(
                conn.query_row(
                    "SELECT COUNT(*) FROM native_legacy_turn_queue_v10",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
                3
            );
            assert_eq!(
                conn.query_row(
                    "SELECT checkpoint_session_id FROM native_legacy_turn_queue_v10 \
                     WHERE workflow_id = 'v5-running'",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
                "provider-v10-older"
            );
            assert_eq!(
                conn.query_row("SELECT COUNT(*) FROM native_terminal_sessions", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
                1,
                "only the newest valid checkpoint becomes resumable history"
            );
            validate_foreign_keys(&conn).unwrap();
        }

        assert!(db.rt_delete_thread_in_org_if_generation(&fence).unwrap());
        assert_eq!(
            db.lock()
                .query_row(
                    "SELECT (SELECT COUNT(*) FROM native_legacy_turn_queue_v10) + \
                            (SELECT COUNT(*) FROM native_terminal_sessions)",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            0
        );
    }
}
