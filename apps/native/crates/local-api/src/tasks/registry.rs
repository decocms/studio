//! `TaskRegistry` — background-task bookkeeping shared by the `bash` family
//! (`POST /_sandbox/bash` with `mode:"background"`), the `tasks` family
//! (`/_sandbox/tasks*`), and the `scripts`/exec family
//! (`POST /_sandbox/exec/:name`). Byte-parity target for the summary shape:
//! `TaskSummary` in `packages/sandbox/daemon-go/internal/proc/taskmanager.go`.
//!
//! Owned by the bash+tasks family (see
//! the native module-ownership contract) — extended past the Phase 1
//! bootstrap stub with per-task output retention and a broadcast channel so
//! `/_sandbox/tasks/:id/stream` (owned by `routes/tasks.rs`) can replay
//! buffered output then follow live chunks through to a single `End` event.
//!
//! **Storage split** (see the `log_store` module doc): retained output —
//! `output()`'s `{stdout, stderr}` and a `/stream` connect's replay — lives
//! in [`crate::log_store::LogStore`], file-backed at
//! `"tasks/<boot-namespace>/<id>.{out,err}"`. Public ids retain the daemon's
//! `task<N>` contract and therefore restart at `task1`; the private directory
//! namespace prevents a new process from appending to a prior boot's files.
//! ONLY the live fan-out (`chunks_tx`, for an already-connected
//! `/stream` subscriber) stays in RAM, and only for as long as the task is
//! being actively streamed — `append_output`/`output`/`remove` all await
//! file I/O; `finalize`/`kill`/`list`/`get` stay synchronous (pure
//! in-memory summary bookkeeping, unchanged). A subscriber can still never
//! observe a chunk after the terminal `End`: `finalize` sends `End` and
//! flips the summary's terminal status under the SAME synchronous lock;
//! an append re-checks that status after its asynchronous file write before
//! broadcasting and closes the writer if finalization won the race.
//!
//! [`TaskRegistry::append_log`] is the shared "chunk" primitive for every
//! family that spawns a process under a `log_name` — the setup pipeline's
//! clone/install/dev steps (`setup/{clone,install,dev}.rs`) AND the exec
//! family (`routes/scripts.rs`, a DIFFERENT family per
//! the native module-ownership contract, but the exact same "append to
//! this task's file + the source's combined transcript + broadcast" shape
//! — hoisted here rather than duplicated a 4th time, per that file's own
//! doc comment inviting this once a third caller showed up). It also feeds
//! `routes/events.rs`'s connect-time `"log"` replay; source discovery comes
//! from the stable files themselves so an empty post-restart registry does not
//! hide retained output.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::json;
use tokio::sync::{broadcast, Notify};

use crate::events::Broadcaster;
use crate::log_store::{app_key, LogStore, DEFAULT_TAIL_BYTES};

/// Generous enough that a burst of output between two `/stream` `poll()`s
/// doesn't lag-drop before a slow consumer catches up — see
/// `events/broadcaster.rs`'s identical reasoning for the same tradeoff.
const STREAM_CHANNEL_CAPACITY: usize = 1024;

pub(crate) fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskStatus {
    Running,
    Exited,
    Failed,
    Killed,
    Timeout,
}

impl TaskStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            TaskStatus::Running => "running",
            TaskStatus::Exited => "exited",
            TaskStatus::Failed => "failed",
            TaskStatus::Killed => "killed",
            TaskStatus::Timeout => "timeout",
        }
    }

    pub fn is_terminal(&self) -> bool {
        !matches!(self, TaskStatus::Running)
    }

    /// Parse a `?status=` query value; unknown tokens map to `None` so the
    /// caller can filter them out (byte-parity with `tasks.ts`'s `VALID_STATUS`
    /// set — an unrecognized status token is silently dropped, not an error).
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "running" => Some(TaskStatus::Running),
            "exited" => Some(TaskStatus::Exited),
            "failed" => Some(TaskStatus::Failed),
            "killed" => Some(TaskStatus::Killed),
            "timeout" => Some(TaskStatus::Timeout),
            _ => None,
        }
    }
}

/// Byte-parity with `TaskSummary` in `process/task-manager.ts`. `started_at`
/// / `finished_at` are epoch milliseconds (matches `Date.now()` on the TS
/// side) so the wire shape needs no unit conversion.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskSummary {
    pub id: String,
    pub command: String,
    pub status: TaskStatus,
    pub exit_code: Option<i32>,
    pub started_at: i64,
    pub finished_at: Option<i64>,
    pub timed_out: bool,
    pub truncated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub log_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub intentional: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KillSignal {
    Term,
    Kill,
}

impl KillSignal {
    fn severity(self) -> u8 {
        match self {
            Self::Term => 1,
            Self::Kill => 2,
        }
    }

    fn from_severity(value: u8) -> Option<Self> {
        match value {
            1 => Some(Self::Term),
            2 => Some(Self::Kill),
            _ => None,
        }
    }

    /// Shell-convention result for a process stopped by this signal.
    pub fn exit_code(self) -> i32 {
        match self {
            Self::Term => 143,
            Self::Kill => 137,
        }
    }

    /// Argument accepted by the shared `kill(1)` process-group helper.
    pub fn flag(self) -> &'static str {
        match self {
            Self::Term => "-TERM",
            Self::Kill => "-KILL",
        }
    }
}

/// A live task's kill switch, owned by whichever family spawned the
/// process. Returns `true` if a running process was actually signaled,
/// `false` if the task was already terminal (byte-parity with the daemon's
/// "kill a running task -> ok; killing again -> 400 not running").
pub type KillHandle = Arc<dyn Fn(KillSignal) -> bool + Send + Sync>;

/// Cancellation bridge shared by setup subprocesses. The synchronous
/// [`KillHandle`] side records the strongest requested signal and wakes the
/// async child owner; the owner observes a request that arrived before spawn
/// just as reliably as one delivered while it is inside `select!`.
///
/// Storing state in addition to a notification is deliberate: `Notify` is a
/// wake-up hint, not durable state. `wait_for_change` pins/enables its waiter
/// before reading the atomic, closing the notify-before-first-poll race.
#[derive(Clone)]
pub struct ProcessController {
    inner: Arc<ProcessControllerInner>,
}

struct ProcessControllerInner {
    requested: AtomicU8,
    changed: Notify,
}

impl ProcessController {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(ProcessControllerInner {
                requested: AtomicU8::new(0),
                changed: Notify::new(),
            }),
        }
    }

    pub fn kill_handle(&self) -> KillHandle {
        let controller = self.clone();
        Arc::new(move |signal| {
            controller.signal(signal);
            true
        })
    }

    /// Synchronously records a signal request. Safe from `Drop`; the async
    /// process owner observes it through [`Self::wait_for_change`].
    pub fn signal(&self, signal: KillSignal) {
        self.request(signal);
    }

    pub fn requested(&self) -> Option<KillSignal> {
        KillSignal::from_severity(self.inner.requested.load(Ordering::SeqCst))
    }

    pub async fn wait_for_change(&self, observed: Option<KillSignal>) -> KillSignal {
        loop {
            let changed = self.inner.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            if let Some(current) = self.requested() {
                if observed != Some(current) {
                    return current;
                }
            }
            changed.await;
        }
    }

    fn request(&self, signal: KillSignal) {
        let requested = signal.severity();
        let mut current = self.inner.requested.load(Ordering::SeqCst);
        while current < requested {
            match self.inner.requested.compare_exchange(
                current,
                requested,
                Ordering::SeqCst,
                Ordering::SeqCst,
            ) {
                Ok(_) => {
                    self.inner.changed.notify_waiters();
                    return;
                }
                Err(actual) => current = actual,
            }
        }
        // Repeated delivery still wakes an owner that has not yet observed the
        // durable atomic state (harmless for an already-observed signal).
        self.inner.changed.notify_waiters();
    }
}

impl Default for ProcessController {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KillAllResult {
    pub initially_running: usize,
    pub term_signaled: usize,
    pub kill_signaled: usize,
    pub remaining: Vec<String>,
}

/// One live chunk of a task's stdout/stderr.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutputStream {
    Stdout,
    Stderr,
}

impl OutputStream {
    pub fn as_str(&self) -> &'static str {
        match self {
            OutputStream::Stdout => "stdout",
            OutputStream::Stderr => "stderr",
        }
    }

    /// File-extension form used to build this task's `LogStore` key (see
    /// [`task_key`]) — deliberately short, distinct from [`Self::as_str`]
    /// (that one is a WIRE value, `/stream`'s SSE event name; this one is
    /// only ever a filename suffix).
    fn file_ext(&self) -> &'static str {
        match self {
            OutputStream::Stdout => "out",
            OutputStream::Stderr => "err",
        }
    }
}

/// Fan-out payload for `/_sandbox/tasks/:id/stream` subscribers — see
/// `TaskRegistry::subscribe_output`/`finalize`. `End` is sent exactly once,
/// atomically with the summary's terminal transition, so a subscriber can
/// never see a `Chunk` after an `End` nor miss the `End` entirely.
#[derive(Debug, Clone)]
pub enum StreamEvent {
    Chunk {
        stream: OutputStream,
        data: String,
    },
    End {
        status: TaskStatus,
        exit_code: Option<i32>,
        timed_out: bool,
    },
}

/// Simple capped string buffer — byte-parity target: `process/ring-buffer.ts`.
/// Appends are amortised constant-time; `read()` returns everything
/// currently held. Once `len() > capacity` the oldest bytes are dropped
/// (kept: the tail / most-recent bytes) and `truncated` latches `true`.
///
/// Purely a REQUEST-scoped helper now (`routes/bash.rs`'s `mode:"await"`
/// capture, which is never persisted or replayed — the response IS the
/// output). `TaskRegistry` itself no longer uses this: retained per-task
/// output is file-backed (see this module's doc comment).
pub(crate) struct RingBuffer {
    capacity: usize,
    buf: String,
    truncated: bool,
}

impl RingBuffer {
    pub(crate) fn new(capacity: usize) -> Self {
        Self {
            capacity,
            buf: String::new(),
            truncated: false,
        }
    }

    pub(crate) fn append(&mut self, data: &str) {
        if data.is_empty() {
            return;
        }
        self.buf.push_str(data);
        if self.buf.len() > self.capacity {
            self.truncated = true;
            let overflow = self.buf.len().saturating_sub(self.capacity);
            let mut cut = overflow.min(self.buf.len());
            // `overflow` is a byte offset that may land mid-codepoint;
            // walk forward to the next char boundary so we never split a
            // multi-byte UTF-8 sequence.
            while cut < self.buf.len() && !self.buf.is_char_boundary(cut) {
                cut = cut.saturating_add(1);
            }
            self.buf.drain(..cut);
        }
    }

    pub(crate) fn read(&self) -> (String, bool) {
        (self.buf.clone(), self.truncated)
    }
}

/// Private storage key. The boot namespace stays off the wire while keeping
/// repeated public `task1` ids isolated across local-api process lifetimes.
fn task_key(namespace: &uuid::Uuid, id: &str, stream: OutputStream) -> String {
    format!("tasks/{namespace}/{id}.{}", stream.file_ext())
}

pub struct TaskEntry {
    pub summary: TaskSummary,
    pub kill: Option<KillHandle>,
    exposed: bool,
    chunks_tx: broadcast::Sender<StreamEvent>,
}

impl TaskEntry {
    /// Construct a fresh entry with its own `/stream` broadcast channel —
    /// retained output itself lives in `TaskRegistry`'s `LogStore`, keyed
    /// by `entry.summary.id` (see [`task_key`]), not on this struct.
    pub fn new(summary: TaskSummary, kill: Option<KillHandle>) -> Self {
        let (chunks_tx, _rx) = broadcast::channel(STREAM_CHANNEL_CAPACITY);
        Self {
            summary,
            kill,
            exposed: true,
            chunks_tx,
        }
    }

    /// Register process ownership for coordinated shutdown without exposing
    /// the implementation detail through `GET /_sandbox/tasks`. Await-mode
    /// request handlers use this while the request itself remains the sole
    /// public representation of the subprocess.
    pub fn new_internal(summary: TaskSummary, kill: Option<KillHandle>) -> Self {
        let mut entry = Self::new(summary, kill);
        entry.exposed = false;
        entry
    }
}

pub struct TaskRegistry {
    inner: Mutex<HashMap<String, TaskEntry>>,
    id_counter: AtomicU64,
    storage_namespace: uuid::Uuid,
    logs: Arc<LogStore>,
    child_lifetime_lock_path: PathBuf,
    terminal_changed: Notify,
}

impl TaskRegistry {
    pub fn new(logs: Arc<LogStore>) -> Self {
        let work_root = logs.root().parent().unwrap_or_else(|| logs.root());
        // Unit/fixture default only. Production constructors pass the one
        // app-root-wide `.decocms/child-lifetime.lock` explicitly; keeping the
        // fallback beside a fixture's log root avoids requiring test-only
        // directory scaffolding before a process can spawn.
        let child_lifetime_lock_path = work_root.join("child-lifetime.lock");
        Self::new_with_child_lifetime_lock(logs, child_lifetime_lock_path)
    }

    /// Production constructor for both the process-global registry and each
    /// sandbox registry. Every child family under one app root must share one
    /// fence, even though their retained logs live in different directories.
    pub fn new_with_child_lifetime_lock(
        logs: Arc<LogStore>,
        child_lifetime_lock_path: PathBuf,
    ) -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
            id_counter: AtomicU64::new(0),
            storage_namespace: uuid::Uuid::new_v4(),
            logs,
            child_lifetime_lock_path,
            terminal_changed: Notify::new(),
        }
    }

    pub(crate) fn child_lifetime_lock_path(&self) -> &Path {
        &self.child_lifetime_lock_path
    }

    /// The `LogStore` backing this registry's retained output — also used
    /// directly by the setup pipeline (`setup/{clone,install,dev}.rs`) to
    /// append into the SEPARATE `"app/<source>"` namespace (the combined,
    /// stable-path transcript `routes/events.rs` replays), and by
    /// `routes/events.rs` itself to read it back. See the `log_store` module doc
    /// for why both namespaces share one store.
    pub fn logs(&self) -> Arc<LogStore> {
        self.logs.clone()
    }

    /// Daemon-compatible public task id generator shared by every family that
    /// spawns into this registry. IDs restart at `task1` each process boot;
    /// retained files remain collision-free through [`Self::storage_namespace`].
    pub fn next_id(&self) -> String {
        let n = self
            .id_counter
            .fetch_add(1, Ordering::Relaxed)
            .saturating_add(1);
        format!("task{n}")
    }

    /// Register a new (or replace an existing) task entry by
    /// `entry.summary.id`.
    pub fn insert(&self, entry: TaskEntry) {
        let mut guard = self.lock();
        guard.insert(entry.summary.id.clone(), entry);
    }

    /// Mutate a task's summary in place. Returns `false` if `id` is
    /// unknown. Kept as a general-purpose escape hatch per the documented
    /// contract (the native module-ownership contract) for families that
    /// need a one-off field tweak outside the `finalize`/`kill` lifecycle
    /// this file's own routes use — not yet called by bash/tasks itself,
    /// whose transitions all go through the more specific methods below.
    #[allow(dead_code)]
    pub fn update<F: FnOnce(&mut TaskSummary)>(&self, id: &str, f: F) -> bool {
        let mut guard = self.lock();
        match guard.get_mut(id) {
            Some(entry) => {
                f(&mut entry.summary);
                true
            }
            None => false,
        }
    }

    pub fn get(&self, id: &str) -> Option<TaskSummary> {
        self.lock().get(id).map(|e| e.summary.clone())
    }

    /// Public task-route view. Internal request-owned subprocesses remain
    /// available to their owner and coordinated shutdown, but cannot be
    /// discovered by guessing a monotonic task id.
    pub fn get_exposed(&self, id: &str) -> Option<TaskSummary> {
        self.lock()
            .get(id)
            .filter(|entry| entry.exposed)
            .map(|entry| entry.summary.clone())
    }

    /// List task summaries, optionally filtered to a status set (matches
    /// `GET /_sandbox/tasks?status=a,b`). `None` returns every task.
    pub fn list(&self, status_filter: Option<&[TaskStatus]>) -> Vec<TaskSummary> {
        let guard = self.lock();
        guard
            .values()
            .filter(|entry| entry.exposed)
            .filter(|e| match status_filter {
                Some(statuses) => statuses.contains(&e.summary.status),
                None => true,
            })
            .map(|e| e.summary.clone())
            .collect()
    }

    /// Buffered stdout/stderr + truncated flag — `GET /_sandbox/tasks/:id`
    /// and the stream route's replay-on-connect both read through this.
    /// Reads the last [`DEFAULT_TAIL_BYTES`] of each of this task's
    /// `LogStore` files (see this module's doc comment).
    pub async fn output(&self, id: &str) -> Option<(String, String, bool)> {
        let summary_truncated = self.get(id)?.truncated;
        let out_key = task_key(&self.storage_namespace, id, OutputStream::Stdout);
        let err_key = task_key(&self.storage_namespace, id, OutputStream::Stderr);
        let stdout = self.logs.tail_read(&out_key, DEFAULT_TAIL_BYTES).await;
        let stderr = self.logs.tail_read(&err_key, DEFAULT_TAIL_BYTES).await;
        let truncated = summary_truncated
            || self.logs.is_truncated(&out_key).await
            || self.logs.is_truncated(&err_key).await;
        Some((stdout, stderr, truncated))
    }

    pub async fn output_exposed(&self, id: &str) -> Option<(String, String, bool)> {
        self.get_exposed(id)?;
        self.output(id).await
    }

    /// Append a live chunk to a task's `LogStore` file and fan it out to
    /// any live `/_sandbox/tasks/:id/stream` subscriber. Keeps
    /// `summary.truncated` in sync so `list`/`get` reflect it without a
    /// separate recompute pass. A no-op for an unknown/already-removed
    /// `id` or empty `data`.
    ///
    /// The file write completes (and is flushed) BEFORE the live
    /// `StreamEvent::Chunk` send — matching `LogStore::append`'s own
    /// durability contract, so a subscriber that joins between the two
    /// always finds this chunk via replay (`output()`) even if it missed
    /// the live send.
    pub async fn append_output(&self, id: &str, stream: OutputStream, data: &str) -> bool {
        if data.is_empty()
            || self
                .lock()
                .get(id)
                .is_none_or(|entry| entry.summary.status.is_terminal())
        {
            return false;
        }
        let key = task_key(&self.storage_namespace, id, stream);
        self.logs.append(&key, data).await;
        let truncated_now = self.logs.is_truncated(&key).await;

        let mut guard = self.lock();
        let emitted = if let Some(entry) = guard
            .get_mut(id)
            .filter(|entry| !entry.summary.status.is_terminal())
        {
            if truncated_now {
                entry.summary.truncated = true;
            }
            let _ = entry.chunks_tx.send(StreamEvent::Chunk {
                stream,
                data: data.to_string(),
            });
            true
        } else {
            false
        };
        drop(guard);
        if !emitted {
            // `finalize` may have raced the asynchronous file write and
            // failed its non-blocking close attempt. The append has flushed
            // now, so close its idle writer and never publish a Chunk after
            // the already-sent terminal End.
            self.logs.close_writer_if_idle(&key);
        }
        emitted
    }

    /// Appends `data` to BOTH this task's own per-task file
    /// (`append_output`) AND `source`'s combined `"app/<source>"`
    /// transcript, then live-broadcasts a `"log"` SSE frame
    /// (`{source, data}`) — see this module's doc comment for who calls
    /// this and why it's centralized here. A no-op for empty `data`
    /// (`append_output` already no-ops for an unknown `id`).
    pub async fn append_log(
        &self,
        id: &str,
        source: &str,
        stream: OutputStream,
        data: &str,
        broadcaster: &Broadcaster,
    ) {
        if data.is_empty() {
            return;
        }
        if !self.append_output(id, stream, data).await {
            return;
        }
        let source_key = app_key(source);
        self.logs.append(&source_key, data).await;
        let guard = self.lock();
        let emitted = guard
            .get(id)
            .is_some_and(|entry| !entry.summary.status.is_terminal());
        if emitted {
            // Keep this emission under the same summary lock as the terminal
            // check: finalize either follows this log or wins first and makes
            // us skip it; it can never interleave an End before this frame.
            broadcaster.emit("log", json!({ "source": source, "data": data }));
        }
        drop(guard);
        if !emitted {
            self.logs.close_writer_if_idle(&source_key);
        }
    }

    /// Subscribe to this task's live output. `None` if `id` is unknown.
    /// Only `routes/tasks.rs`'s stream handler should call this (mirrors
    /// the single-subscriber-family convention documented on
    /// `events/broadcaster.rs`).
    pub fn subscribe_output(&self, id: &str) -> Option<broadcast::Receiver<StreamEvent>> {
        let guard = self.lock();
        guard.get(id).map(|e| e.chunks_tx.subscribe())
    }

    pub fn subscribe_output_exposed(&self, id: &str) -> Option<broadcast::Receiver<StreamEvent>> {
        let guard = self.lock();
        guard
            .get(id)
            .filter(|entry| entry.exposed)
            .map(|entry| entry.chunks_tx.subscribe())
    }

    /// Atomically transition a task to a terminal status and notify any
    /// live stream subscriber via a single `StreamEvent::End`, under the
    /// same lock acquisition as the summary mutation — so a subscriber that
    /// joins concurrently can never see a chunk after `End`, nor miss `End`
    /// entirely. Returns `false` if `id` is unknown.
    pub fn finalize(&self, id: &str, status: TaskStatus, exit_code: i32, timed_out: bool) -> bool {
        let mut guard = self.lock();
        match guard.get_mut(id) {
            Some(entry) if !entry.summary.status.is_terminal() => {
                entry.summary.status = status;
                entry.summary.exit_code = Some(exit_code);
                entry.summary.finished_at = Some(now_ms());
                entry.summary.timed_out = timed_out;
                let _ = entry.chunks_tx.send(StreamEvent::End {
                    status,
                    exit_code: Some(exit_code),
                    timed_out,
                });
                let log_name = entry.summary.log_name.clone();
                self.terminal_changed.notify_waiters();
                self.logs.close_writer_if_idle(&task_key(
                    &self.storage_namespace,
                    id,
                    OutputStream::Stdout,
                ));
                self.logs.close_writer_if_idle(&task_key(
                    &self.storage_namespace,
                    id,
                    OutputStream::Stderr,
                ));
                if let Some(source) = log_name {
                    self.logs.close_writer_if_idle(&app_key(&source));
                }
                true
            }
            Some(_) | None => false,
        }
    }

    /// Signal a task. `Some(true)` = signaled, `Some(false)` = found but
    /// not running (or no kill handle registered), `None` = unknown id. On
    /// an actual signal, flags `summary.intentional` — byte-parity with
    /// `TaskManager.kill()`'s "orchestrator-driven stop" flag, set
    /// synchronously at kill time rather than deferred to exit.
    pub fn kill(&self, id: &str, signal: KillSignal) -> Option<bool> {
        let mut guard = self.lock();
        let entry = guard.get_mut(id)?;
        if entry.summary.status.is_terminal() {
            return Some(false);
        }
        let signaled = match &entry.kill {
            Some(k) => k(signal),
            None => false,
        };
        if signaled {
            entry.summary.intentional = Some(true);
        }
        Some(signaled)
    }

    pub fn kill_exposed(&self, id: &str, signal: KillSignal) -> Option<bool> {
        let mut guard = self.lock();
        let entry = guard.get_mut(id)?;
        if !entry.exposed || entry.summary.status.is_terminal() {
            return Some(false);
        }
        let signaled = entry.kill.as_ref().is_some_and(|kill| kill(signal));
        if signaled {
            entry.summary.intentional = Some(true);
        }
        Some(signaled)
    }

    /// Kill every exposed currently-running task; returns the count actually
    /// signaled (`POST /_sandbox/tasks/kill-all`). Internal request-owned
    /// children are intentionally excluded here and included by
    /// [`Self::kill_all_and_wait`] during process shutdown.
    pub fn kill_all(&self, signal: KillSignal) -> usize {
        let mut guard = self.lock();
        let mut count = 0_usize;
        for entry in guard.values_mut() {
            if !entry.exposed || entry.summary.status.is_terminal() {
                continue;
            }
            let signaled = match &entry.kill {
                Some(k) => k(signal),
                None => false,
            };
            if signaled {
                entry.summary.intentional = Some(true);
                count = count.saturating_add(1);
            }
        }
        count
    }

    /// Signals every task that was running at entry, waits concurrently for
    /// their terminal transitions, then escalates the still-running subset.
    /// Both waits are wall-clock bounded for the whole set (never one timeout
    /// per child). Tasks admitted after this snapshot are intentionally outside
    /// the fence; shutdown closes their owning admission source first.
    pub async fn kill_all_and_wait(
        &self,
        term_grace: Duration,
        kill_grace: Duration,
    ) -> KillAllResult {
        let ids = self.running_ids();
        let initially_running = ids.len();
        let term_signaled = self.kill_ids(&ids, KillSignal::Term);

        if tokio::time::timeout(term_grace, self.wait_ids_terminal(&ids))
            .await
            .is_ok()
        {
            return KillAllResult {
                initially_running,
                term_signaled,
                kill_signaled: 0,
                remaining: Vec::new(),
            };
        }

        let after_term = self.running_subset(&ids);
        let kill_signaled = self.kill_ids(&after_term, KillSignal::Kill);
        let _ = tokio::time::timeout(kill_grace, self.wait_ids_terminal(&after_term)).await;
        let remaining = self.running_subset(&after_term);
        KillAllResult {
            initially_running,
            term_signaled,
            kill_signaled,
            remaining,
        }
    }

    fn running_ids(&self) -> Vec<String> {
        self.lock()
            .iter()
            .filter(|(_, entry)| !entry.summary.status.is_terminal())
            .map(|(id, _)| id.clone())
            .collect()
    }

    fn running_subset(&self, ids: &[String]) -> Vec<String> {
        let guard = self.lock();
        ids.iter()
            .filter(|id| {
                guard
                    .get(id.as_str())
                    .is_some_and(|entry| !entry.summary.status.is_terminal())
            })
            .cloned()
            .collect()
    }

    fn kill_ids(&self, ids: &[String], signal: KillSignal) -> usize {
        let mut guard = self.lock();
        let mut count = 0_usize;
        for id in ids {
            let Some(entry) = guard.get_mut(id) else {
                continue;
            };
            if entry.summary.status.is_terminal() {
                continue;
            }
            let signaled = entry.kill.as_ref().is_some_and(|kill| kill(signal));
            if signaled {
                entry.summary.intentional = Some(true);
                count = count.saturating_add(1);
            }
        }
        count
    }

    async fn wait_ids_terminal(&self, ids: &[String]) {
        loop {
            let changed = self.terminal_changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            if self.running_subset(ids).is_empty() {
                return;
            }
            changed.await;
        }
    }

    /// Remove a finished task (`DELETE /_sandbox/tasks/:id`). Returns
    /// `None` if unknown, `Some(true)` if removed, `Some(false)` if still
    /// running (caller should surface 400). Cleans up this task's
    /// `LogStore` files too — lifecycle completeness: no orphaned files
    /// survive a task the caller explicitly removed.
    pub async fn remove(&self, id: &str) -> Option<bool> {
        self.remove_if(id, false).await
    }

    pub async fn remove_exposed(&self, id: &str) -> Option<bool> {
        self.remove_if(id, true).await
    }

    async fn remove_if(&self, id: &str, require_exposed: bool) -> Option<bool> {
        enum Outcome {
            Unknown,
            StillRunning,
            Removed,
        }
        let outcome = {
            let mut guard = self.lock();
            match guard.get(id) {
                None => Outcome::Unknown,
                Some(entry) if require_exposed && !entry.exposed => Outcome::Unknown,
                Some(entry) if !entry.summary.status.is_terminal() => Outcome::StillRunning,
                Some(_) => {
                    guard.remove(id);
                    Outcome::Removed
                }
            }
        };
        match outcome {
            Outcome::Unknown => None,
            Outcome::StillRunning => Some(false),
            Outcome::Removed => {
                self.logs
                    .remove(&task_key(&self.storage_namespace, id, OutputStream::Stdout))
                    .await;
                self.logs
                    .remove(&task_key(&self.storage_namespace, id, OutputStream::Stderr))
                    .await;
                Some(true)
            }
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, TaskEntry>> {
        match self.inner.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn registry() -> (tempfile::TempDir, TaskRegistry) {
        let dir = tempfile::tempdir().unwrap();
        let logs = Arc::new(LogStore::new(dir.path().to_path_buf()));
        (dir, TaskRegistry::new(logs))
    }

    fn summary(id: &str, status: TaskStatus) -> TaskSummary {
        TaskSummary {
            id: id.to_string(),
            command: "true".to_string(),
            status,
            exit_code: None,
            started_at: 0,
            finished_at: None,
            timed_out: false,
            truncated: false,
            log_name: None,
            intentional: None,
        }
    }

    #[test]
    fn insert_get_list_roundtrip() {
        let (_dir, reg) = registry();
        reg.insert(TaskEntry::new(summary("t1", TaskStatus::Running), None));
        assert_eq!(reg.get("t1").unwrap().status, TaskStatus::Running);
        assert_eq!(reg.list(None).len(), 1);
        assert_eq!(
            reg.list(Some(&[TaskStatus::Exited])).len(),
            0,
            "status filter excludes non-matching tasks"
        );
    }

    #[tokio::test]
    async fn internal_task_is_shutdown_visible_but_hidden_from_task_routes() {
        let (_dir, reg) = registry();
        let controller = ProcessController::new();
        reg.insert(TaskEntry::new_internal(
            summary("internal", TaskStatus::Running),
            Some(controller.kill_handle()),
        ));

        assert!(reg.list(None).is_empty());
        assert_eq!(reg.get("internal").unwrap().status, TaskStatus::Running);
        assert!(reg.get_exposed("internal").is_none());
        assert!(reg.output_exposed("internal").await.is_none());
        assert!(reg.subscribe_output_exposed("internal").is_none());
        assert_eq!(reg.kill_exposed("internal", KillSignal::Term), Some(false));
        assert_eq!(reg.remove_exposed("internal").await, None);
        assert_eq!(reg.kill_all(KillSignal::Term), 0);

        let result = reg.kill_all_and_wait(Duration::ZERO, Duration::ZERO).await;
        assert_eq!(result.initially_running, 1);
        assert_eq!(result.term_signaled, 1);
        assert_eq!(result.kill_signaled, 1);
        assert_eq!(result.remaining, vec!["internal"]);
        assert_eq!(controller.requested(), Some(KillSignal::Kill));
    }

    #[test]
    fn kill_unknown_task_is_none() {
        let (_dir, reg) = registry();
        assert!(reg.kill("nope", KillSignal::Term).is_none());
    }

    #[test]
    fn kill_terminal_task_is_false_not_running() {
        let (_dir, reg) = registry();
        reg.insert(TaskEntry::new(summary("t1", TaskStatus::Exited), None));
        assert_eq!(reg.kill("t1", KillSignal::Term), Some(false));
    }

    #[test]
    fn kill_running_task_with_handle_flags_intentional() {
        let (_dir, reg) = registry();
        let handle: KillHandle = Arc::new(|_sig| true);
        reg.insert(TaskEntry::new(
            summary("t1", TaskStatus::Running),
            Some(handle),
        ));
        assert_eq!(reg.kill("t1", KillSignal::Term), Some(true));
        assert_eq!(reg.get("t1").unwrap().intentional, Some(true));
    }

    #[test]
    fn kill_running_task_without_handle_is_false() {
        let (_dir, reg) = registry();
        reg.insert(TaskEntry::new(summary("t1", TaskStatus::Running), None));
        assert_eq!(reg.kill("t1", KillSignal::Term), Some(false));
        assert_eq!(
            reg.get("t1").unwrap().intentional,
            None,
            "no actual signal was sent, so intentional stays unset"
        );
    }

    #[tokio::test]
    async fn process_controller_keeps_the_strongest_signal_without_lost_wakes() {
        let controller = ProcessController::new();
        controller.signal(KillSignal::Term);
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(1), controller.wait_for_change(None),)
                .await
                .expect("a pre-existing signal is durable"),
            KillSignal::Term
        );

        controller.signal(KillSignal::Term);
        controller.signal(KillSignal::Kill);
        controller.signal(KillSignal::Term);
        assert_eq!(
            controller.wait_for_change(Some(KillSignal::Term)).await,
            KillSignal::Kill
        );
        assert_eq!(controller.requested(), Some(KillSignal::Kill));
    }

    #[tokio::test]
    async fn kill_all_and_wait_uses_one_term_then_one_kill_budget() {
        let (dir, registry) = registry();
        let registry = Arc::new(registry);
        let term_signals = Arc::new(Mutex::new(Vec::new()));
        let term_changed = Arc::new(Notify::new());
        let stubborn_signals = Arc::new(Mutex::new(Vec::new()));
        let stubborn_changed = Arc::new(Notify::new());

        let term_handle: KillHandle = {
            let signals = term_signals.clone();
            let changed = term_changed.clone();
            Arc::new(move |signal| {
                signals.lock().unwrap().push(signal);
                changed.notify_waiters();
                true
            })
        };
        let stubborn_handle: KillHandle = {
            let signals = stubborn_signals.clone();
            let changed = stubborn_changed.clone();
            Arc::new(move |signal| {
                signals.lock().unwrap().push(signal);
                changed.notify_waiters();
                true
            })
        };
        registry.insert(TaskEntry::new(
            summary("term", TaskStatus::Running),
            Some(term_handle),
        ));
        registry.insert(TaskEntry::new(
            summary("stubborn", TaskStatus::Running),
            Some(stubborn_handle),
        ));

        let shutdown_registry = registry.clone();
        let shutdown = tokio::spawn(async move {
            shutdown_registry
                .kill_all_and_wait(Duration::from_millis(100), Duration::from_secs(1))
                .await
        });

        wait_for_recorded_signal(&term_signals, &term_changed, KillSignal::Term).await;
        wait_for_recorded_signal(&stubborn_signals, &stubborn_changed, KillSignal::Term).await;
        registry.finalize("term", TaskStatus::Killed, 143, false);
        wait_for_recorded_signal(&stubborn_signals, &stubborn_changed, KillSignal::Kill).await;
        registry.finalize("stubborn", TaskStatus::Killed, 137, false);

        let result = shutdown.await.unwrap();
        drop(dir);

        assert_eq!(result.initially_running, 2);
        assert_eq!(result.term_signaled, 2);
        assert_eq!(result.kill_signaled, 1);
        assert!(result.remaining.is_empty());
        assert_eq!(registry.get("term").unwrap().intentional, Some(true));
        assert_eq!(registry.get("stubborn").unwrap().intentional, Some(true));
    }

    async fn wait_for_recorded_signal(
        signals: &Mutex<Vec<KillSignal>>,
        changed: &Notify,
        wanted: KillSignal,
    ) {
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                let notified = changed.notified();
                tokio::pin!(notified);
                notified.as_mut().enable();
                if signals.lock().unwrap().contains(&wanted) {
                    return;
                }
                notified.await;
            }
        })
        .await
        .expect("shutdown delivered expected signal");
    }

    #[tokio::test]
    async fn remove_running_task_is_rejected() {
        let (_dir, reg) = registry();
        reg.insert(TaskEntry::new(summary("t1", TaskStatus::Running), None));
        assert_eq!(reg.remove("t1").await, Some(false));
        assert!(
            reg.get("t1").is_some(),
            "still-running task must survive a rejected remove"
        );
    }

    #[tokio::test]
    async fn remove_finished_task_succeeds() {
        let (_dir, reg) = registry();
        reg.insert(TaskEntry::new(summary("t1", TaskStatus::Exited), None));
        assert_eq!(reg.remove("t1").await, Some(true));
        assert!(reg.get("t1").is_none());
    }

    #[tokio::test]
    async fn remove_unknown_task_is_none() {
        let (_dir, reg) = registry();
        assert!(reg.remove("nope").await.is_none());
    }

    #[tokio::test]
    async fn remove_deletes_the_backing_log_files() {
        let (dir, reg) = registry();
        reg.insert(TaskEntry::new(summary("t1", TaskStatus::Running), None));
        reg.append_output("t1", OutputStream::Stdout, "hi\n").await;
        let out_path =
            dir.path()
                .join(task_key(&reg.storage_namespace, "t1", OutputStream::Stdout));
        assert!(out_path.exists(), "stdout file exists before remove");
        reg.finalize("t1", TaskStatus::Exited, 0, false);
        reg.remove("t1").await;
        assert!(!out_path.exists(), "stdout file must be deleted on remove");
    }

    #[test]
    fn next_id_matches_the_daemon_task_number_contract() {
        let (_dir, reg) = registry();
        let first = reg.next_id();
        let second = reg.next_id();
        assert_eq!(first, "task1");
        assert_eq!(second, "task2");
    }

    #[tokio::test]
    async fn repeated_public_ids_use_distinct_private_files_across_boots() {
        let dir = tempfile::tempdir().unwrap();
        let first = TaskRegistry::new(Arc::new(LogStore::new(dir.path().to_path_buf())));
        let first_id = first.next_id();
        first.insert(TaskEntry::new(
            summary(&first_id, TaskStatus::Running),
            None,
        ));
        first
            .append_output(&first_id, OutputStream::Stdout, "first boot\n")
            .await;

        let second = TaskRegistry::new(Arc::new(LogStore::new(dir.path().to_path_buf())));
        let second_id = second.next_id();
        second.insert(TaskEntry::new(
            summary(&second_id, TaskStatus::Running),
            None,
        ));
        second
            .append_output(&second_id, OutputStream::Stdout, "second boot\n")
            .await;

        assert_eq!(first_id, "task1");
        assert_eq!(second_id, "task1");
        assert_ne!(first.storage_namespace, second.storage_namespace);
        assert_eq!(first.output(&first_id).await.unwrap().0, "first boot\n");
        assert_eq!(second.output(&second_id).await.unwrap().0, "second boot\n");
    }

    #[tokio::test]
    async fn append_output_updates_buffer_and_truncated_flag() {
        let (_dir, reg) = registry();
        reg.insert(TaskEntry::new(summary("t1", TaskStatus::Running), None));
        reg.append_output("t1", OutputStream::Stdout, "hello ")
            .await;
        reg.append_output("t1", OutputStream::Stderr, "oops\n")
            .await;
        let (stdout, stderr, truncated) = reg.output("t1").await.unwrap();
        assert_eq!(stdout, "hello ");
        assert_eq!(stderr, "oops\n");
        assert!(!truncated);
        assert!(!reg.get("t1").unwrap().truncated);
    }

    #[tokio::test]
    async fn append_output_is_a_noop_for_an_unknown_task() {
        let (_dir, reg) = registry();
        // Must not panic and must not create a file for a task that was
        // never inserted (or was already removed).
        reg.append_output("never-inserted", OutputStream::Stdout, "hi")
            .await;
        assert!(reg.output("never-inserted").await.is_none());
    }

    #[tokio::test]
    async fn an_async_append_racing_finalize_never_sends_chunk_after_end() {
        let dir = tempfile::tempdir().unwrap();
        let logs = Arc::new(LogStore::new(dir.path().to_path_buf()));
        let reg = Arc::new(TaskRegistry::new(logs.clone()));
        reg.insert(TaskEntry::new(summary("t1", TaskStatus::Running), None));
        let mut rx = reg.subscribe_output("t1").unwrap();

        // Stop this append after task admission but before its file I/O. This
        // deterministically opens the old race: finalize sends End while the
        // append is suspended, then the append resumes and used to send Chunk.
        let (entered, release) = logs.block_next_append();
        let append_reg = reg.clone();
        let append = tokio::spawn(async move {
            append_reg
                .append_output("t1", OutputStream::Stdout, "late chunk\n")
                .await
        });
        let permit = entered.acquire().await.unwrap();
        permit.forget();
        assert!(reg.finalize("t1", TaskStatus::Exited, 0, false));
        release.add_permits(1);
        assert!(!append.await.unwrap(), "terminal task must suppress Chunk");

        assert!(matches!(rx.try_recv(), Ok(StreamEvent::End { .. })));
        assert!(matches!(
            rx.try_recv(),
            Err(broadcast::error::TryRecvError::Empty)
        ));
        assert_eq!(
            logs.open_writer_count().await,
            0,
            "the append that lost the finalize race must close its writer"
        );
    }

    #[test]
    fn ring_buffer_caps_and_keeps_tail() {
        let mut rb = RingBuffer::new(5);
        rb.append("abc");
        rb.append("defgh");
        let (data, truncated) = rb.read();
        assert_eq!(data, "defgh");
        assert!(truncated);
    }

    #[tokio::test]
    async fn output_survives_finalize_so_a_settled_task_still_replays() {
        // The SSE connect-time replay (`routes/events.rs`) reads a task's
        // `LogStore` files for EVERY task, not just Running ones — a dev
        // server or install phase that already finished must still hand
        // back its buffered output, else a terminal opened after the
        // process settled shows a blank pane.
        let (_dir, reg) = registry();
        reg.insert(TaskEntry::new(summary("t1", TaskStatus::Running), None));
        reg.append_output("t1", OutputStream::Stdout, "Local: http://localhost:3000\n")
            .await;
        reg.append_output("t1", OutputStream::Stderr, "warn: deprecated\n")
            .await;

        reg.finalize("t1", TaskStatus::Exited, 0, false);

        assert_eq!(reg.get("t1").unwrap().status, TaskStatus::Exited);
        let (stdout, stderr, _truncated) = reg
            .output("t1")
            .await
            .expect("output retained after finalize");
        assert_eq!(stdout, "Local: http://localhost:3000\n");
        assert_eq!(stderr, "warn: deprecated\n");
    }

    #[test]
    fn finalize_unknown_task_is_false() {
        let (_dir, reg) = registry();
        assert!(!reg.finalize("nope", TaskStatus::Exited, 0, false));
    }

    #[test]
    fn finalize_sets_terminal_fields_and_notifies_subscriber() {
        let (_dir, reg) = registry();
        reg.insert(TaskEntry::new(summary("t1", TaskStatus::Running), None));
        let mut rx = reg.subscribe_output("t1").unwrap();
        assert!(reg.finalize("t1", TaskStatus::Exited, 0, false));
        let summary = reg.get("t1").unwrap();
        assert_eq!(summary.status, TaskStatus::Exited);
        assert_eq!(summary.exit_code, Some(0));
        assert!(summary.finished_at.is_some());

        match rx.try_recv().expect("End event delivered") {
            StreamEvent::End {
                status,
                exit_code,
                timed_out,
            } => {
                assert_eq!(status, TaskStatus::Exited);
                assert_eq!(exit_code, Some(0));
                assert!(!timed_out);
            }
            other => panic!("expected End, got {other:?}"),
        }
    }
}
