//! [`LogStore`] — async, file-backed append-only log retention. See the
//! `log_store` module doc for the design rationale (files are the source of
//! truth for retained output; RAM holds only transient live fan-out).

use std::collections::HashMap;
use std::path::PathBuf;

use tokio::fs::{self, File, OpenOptions};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt, BufWriter};
use tokio::sync::Mutex;

/// Byte-parity with `LOG_MAX_BYTES` (`process/task-manager.ts`) /
/// `INSTALL_LOG_MAX_BYTES` (`setup/orchestrator.ts`) — both 10MB in the old
/// daemon. Once a file's accumulated size would exceed this, [`LogStore::append`]
/// rotates: flush + drop the old handle, delete the file, reopen fresh, and
/// write a `[log rotated at N bytes]` marker line before the chunk that
/// triggered rotation — byte-parity in behavior (not text: the old marker
/// used a bare `maxBytes` number too) with `process/log-tee.ts::LogTee`'s
/// `rotate()`.
pub const WRITE_CAP_BYTES: u64 = 10 * 1024 * 1024;

/// Byte-parity with `REPLAY_BYTES` (`packages/sandbox/daemon-go/internal/gitx/refname.go`)
/// — the default/expected read size for an SSE replay-on-connect frame:
/// only the LAST 256KB of a (possibly up-to-10MB) file is ever handed back
/// by [`LogStore::tail_read`] for that purpose. Callers may pass any
/// `max_bytes`; this is just the value `routes/events.rs` and
/// `tasks::registry` both use, so they agree without hardcoding it twice.
pub const DEFAULT_TAIL_BYTES: usize = 256 * 1024;

/// Builds the `"app/<source>"` [`LogStore`] key for a named, STABLE log
/// source (`"setup"`, `"dev"`, `"start"`) — byte-parity in spirit with the
/// old daemon's `appLogPath(logsDir, name)` on-disk layout. Shared by every
/// writer (`setup/{clone,install,dev}.rs`) and the one reader
/// (`routes/events.rs`) so both sides always agree on the exact key for a
/// given source name.
pub fn app_key(source: &str) -> String {
    format!("app/{}", encode_app_source(source))
}

/// Unsafe source names must remain reversible when the file-backed catalog is
/// rebuilt after a process restart. A lossy filename sanitizer made
/// `dev:web` and `dev_web` share one file and replayed both as `dev_web`.
/// Keep the familiar `app/setup` and `app/dev` paths for ordinary names; use a
/// reserved, hex-encoded form for everything else (including names beginning
/// with the reserved prefix, so the mapping stays one-to-one).
const APP_SOURCE_ESCAPE_PREFIX: &str = "__decocms_source_v1__";

fn encode_app_source(source: &str) -> String {
    let can_use_verbatim = !source.is_empty()
        && !source.starts_with(APP_SOURCE_ESCAPE_PREFIX)
        && !source.contains('/')
        && sanitize_segment(source) == source;
    if can_use_verbatim {
        return source.to_string();
    }

    let mut encoded = String::with_capacity(APP_SOURCE_ESCAPE_PREFIX.len() + source.len() * 2);
    encoded.push_str(APP_SOURCE_ESCAPE_PREFIX);
    for byte in source.as_bytes() {
        use std::fmt::Write as _;
        let _ = write!(encoded, "{byte:02x}");
    }
    encoded
}

fn decode_app_source(filename: &str) -> Option<String> {
    let Some(hex) = filename.strip_prefix(APP_SOURCE_ESCAPE_PREFIX) else {
        return Some(filename.to_string());
    };
    if hex.len() % 2 != 0 {
        return None;
    }
    let mut bytes = Vec::with_capacity(hex.len() / 2);
    for pair in hex.as_bytes().chunks_exact(2) {
        let pair = std::str::from_utf8(pair).ok()?;
        bytes.push(u8::from_str_radix(pair, 16).ok()?);
    }
    String::from_utf8(bytes).ok()
}

struct Writer {
    file: BufWriter<File>,
    /// Bytes written since this file was last (re)opened fresh — reset to
    /// the marker's length on rotation, seeded from the on-disk file size
    /// the FIRST time a key is opened (so a file `LogStore` didn't itself
    /// write this process's lifetime, e.g. left over from truncate/rotate
    /// bookkeeping, still counts correctly toward the cap).
    written: u64,
    /// Latches `true` the first time this key rotates and never resets —
    /// byte-parity with `LogTee.isTruncated()`'s `rotatedOnce` flag.
    rotated: bool,
}

/// See the `log_store` module doc for the full design. One instance per app
/// workdir, rooted at `<workdir>/logs`.
pub struct LogStore {
    root: PathBuf,
    cap_bytes: u64,
    writers: Mutex<HashMap<String, Writer>>,
    #[cfg(test)]
    append_gate: std::sync::Mutex<Option<AppendTestGate>>,
}

#[cfg(test)]
struct AppendTestGate {
    entered: std::sync::Arc<tokio::sync::Semaphore>,
    release: std::sync::Arc<tokio::sync::Semaphore>,
}

impl LogStore {
    pub fn new(root: PathBuf) -> Self {
        Self::with_cap(root, WRITE_CAP_BYTES)
    }

    pub(crate) fn root(&self) -> &std::path::Path {
        &self.root
    }

    /// Same as [`Self::new`] but with a caller-chosen rotation cap — used by
    /// this module's own tests to exercise rotation without writing 10MB of
    /// fixture data. Not `#[cfg(test)]`-gated so other modules' tests in
    /// this crate can use it too (still `pub(crate)`: no reason for an
    /// embedder to override the byte-parity cap).
    pub(crate) fn with_cap(root: PathBuf, cap_bytes: u64) -> Self {
        Self {
            root,
            cap_bytes,
            writers: Mutex::new(HashMap::new()),
            #[cfg(test)]
            append_gate: std::sync::Mutex::new(None),
        }
    }

    /// Maps a `/`-separated key (e.g. `"app/setup"`, `"tasks/task5.out"`)
    /// onto a real path under `root`, sanitizing EACH segment
    /// independently — a source/task-id name is never trusted verbatim as
    /// a path component (no traversal, no hidden-file/absolute-path
    /// confusion).
    fn path_for(&self, key: &str) -> PathBuf {
        let mut path = self.root.clone();
        for segment in key.split('/') {
            path.push(sanitize_segment(segment));
        }
        path
    }

    /// Appends `data` to `key`'s file, rotating first if this write would
    /// push the file past the configured cap. A no-op for empty `data` or
    /// on any I/O error (log writes must never crash the pipeline that
    /// produced them — byte-parity in spirit with `LogTee.write()`'s own
    /// swallowed-error catch blocks).
    ///
    /// Returns once the write is flushed to the OS — callers MUST complete
    /// this await before emitting the corresponding LIVE broadcast frame,
    /// so a client that connects between the two never sees "neither
    /// replay nor live" for that chunk (see the `log_store` module doc).
    pub async fn append(&self, key: &str, data: &str) {
        if data.is_empty() {
            return;
        }
        #[cfg(test)]
        self.wait_on_append_gate().await;
        let bytes = data.as_bytes();
        let mut guard = self.writers.lock().await;
        if !self.ensure_writer(&mut guard, key).await {
            return;
        }
        let would_exceed = guard
            .get(key)
            .map(|w| w.written + bytes.len() as u64 > self.cap_bytes)
            .unwrap_or(false);
        if would_exceed {
            self.rotate(&mut guard, key).await;
        }
        if let Some(writer) = guard.get_mut(key) {
            Self::write_bytes(writer, bytes).await;
        }
    }

    /// Resets `key` to an empty, fresh file — byte-parity in spirit with
    /// `setup/orchestrator.ts`'s `unlinkSync(cloneLogPath)` /
    /// `unlinkSync(installLogPath)` right before opening a new tee for a
    /// FRESH clone/install run. Used by `setup/clone.rs` exactly once per
    /// genuinely fresh clone (not on a checkout-existing-repo re-run) — see
    /// that file's own doc comment for why only that branch resets it.
    pub async fn truncate(&self, key: &str) {
        let mut guard = self.writers.lock().await;
        self.close_and_delete(&mut guard, key).await;
    }

    /// Removes `key` entirely — closes any open handle and deletes the
    /// file. Used by `tasks::registry::TaskRegistry::remove` to clean up a
    /// deleted task's per-task files (lifecycle completeness: no orphaned
    /// files survive a task the caller explicitly removed).
    pub async fn remove(&self, key: &str) {
        let mut guard = self.writers.lock().await;
        self.close_and_delete(&mut guard, key).await;
    }

    /// `true` once `key` has rotated at least once (this process's
    /// lifetime) — surfaced as `TaskSummary::truncated`.
    pub async fn is_truncated(&self, key: &str) -> bool {
        let guard = self.writers.lock().await;
        guard.get(key).map(|w| w.rotated).unwrap_or(false)
    }

    /// Returns the last (up to) `max_bytes` bytes of `key`'s file, decoded
    /// lossily (a byte offset chosen purely by size can land mid-codepoint;
    /// `from_utf8_lossy` turns any truncated sequence into replacement
    /// characters rather than panicking or corrupting the rest of the
    /// text). Missing file / any I/O error -> `""` (never a hard failure —
    /// a replay frame with nothing to show is just skipped by the caller).
    pub async fn tail_read(&self, key: &str, max_bytes: usize) -> String {
        let path = self.path_for(key);
        // Also the missing-file gate: clamping a file that does not exist
        // fails, which is exactly the "" case documented above.
        if crate::fs_util::set_owner_only_async(&path).await.is_err() {
            return String::new();
        }
        let Ok(mut file) = File::open(&path).await else {
            return String::new();
        };
        let Ok(metadata) = file.metadata().await else {
            return String::new();
        };
        let len = metadata.len();
        let start = len.saturating_sub(max_bytes as u64);
        if start > 0 && file.seek(std::io::SeekFrom::Start(start)).await.is_err() {
            return String::new();
        }
        let mut buf = Vec::new();
        if file.read_to_end(&mut buf).await.is_err() {
            return String::new();
        }
        String::from_utf8_lossy(&buf).into_owned()
    }

    /// Lists every stable application-log source currently retained on disk.
    ///
    /// The filesystem is the source of truth for replay, so this deliberately
    /// does not consult [`crate::tasks::TaskRegistry`]. A restarted process has
    /// an empty task registry while `<workdir>/logs/app/*` still contains the
    /// setup/dev transcripts the terminal must replay. Results are sorted for
    /// deterministic SSE snapshot ordering and only regular, safely-named
    /// files are returned (directories and symlinks are ignored).
    pub async fn app_sources(&self) -> Vec<String> {
        let app_dir = self.root.join("app");
        let Ok(mut entries) = fs::read_dir(app_dir).await else {
            return Vec::new();
        };
        let mut sources = Vec::new();
        loop {
            let entry = match entries.next_entry().await {
                Ok(Some(entry)) => entry,
                Ok(None) | Err(_) => break,
            };
            let Ok(file_type) = entry.file_type().await else {
                continue;
            };
            if !file_type.is_file() {
                continue;
            }
            let Ok(filename) = entry.file_name().into_string() else {
                continue;
            };
            if filename.is_empty() || sanitize_segment(&filename) != filename {
                continue;
            }
            let Some(source) = decode_app_source(&filename) else {
                continue;
            };
            sources.push(source);
        }
        sources.sort_unstable();
        sources.dedup();
        sources
    }

    /// Drops an already-flushed writer handle without deleting its retained
    /// file. Task finalization uses this to keep file descriptors and writer
    /// metadata bounded by the actively-writing task set rather than every
    /// task seen since boot. A concurrent write owns the mutex and makes this
    /// a harmless no-op; its next finalization/removal gets another chance.
    pub(crate) fn close_writer_if_idle(&self, key: &str) {
        if let Ok(mut guard) = self.writers.try_lock() {
            guard.remove(key);
        }
    }

    #[cfg(test)]
    pub(crate) fn block_next_append(
        &self,
    ) -> (
        std::sync::Arc<tokio::sync::Semaphore>,
        std::sync::Arc<tokio::sync::Semaphore>,
    ) {
        let entered = std::sync::Arc::new(tokio::sync::Semaphore::new(0));
        let release = std::sync::Arc::new(tokio::sync::Semaphore::new(0));
        let mut guard = self
            .append_gate
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *guard = Some(AppendTestGate {
            entered: entered.clone(),
            release: release.clone(),
        });
        (entered, release)
    }

    #[cfg(test)]
    async fn wait_on_append_gate(&self) {
        let gate = self
            .append_gate
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
        let Some(gate) = gate else {
            return;
        };
        gate.entered.add_permits(1);
        if let Ok(permit) = gate.release.acquire().await {
            permit.forget();
        };
    }

    #[cfg(test)]
    pub(crate) async fn open_writer_count(&self) -> usize {
        self.writers.lock().await.len()
    }

    async fn ensure_writer(&self, guard: &mut HashMap<String, Writer>, key: &str) -> bool {
        if guard.contains_key(key) {
            return true;
        }
        let path = self.path_for(key);
        if let Some(parent) = path.parent() {
            if fs::create_dir_all(parent).await.is_err() {
                return false;
            }
        }
        let mut options = OpenOptions::new();
        options.create(true).append(true);
        #[cfg(unix)]
        options.mode(0o600);
        let Ok(file) = options.open(&path).await else {
            return false;
        };
        if crate::fs_util::set_owner_only_async(&path).await.is_err() {
            return false;
        }
        let written = fs::metadata(&path).await.map(|m| m.len()).unwrap_or(0);
        guard.insert(
            key.to_string(),
            Writer {
                file: BufWriter::new(file),
                written,
                rotated: false,
            },
        );
        true
    }

    async fn rotate(&self, guard: &mut HashMap<String, Writer>, key: &str) {
        self.close_and_delete(guard, key).await;
        if !self.ensure_writer(guard, key).await {
            return;
        }
        let marker = format!("[log rotated at {} bytes]\n", self.cap_bytes);
        if let Some(writer) = guard.get_mut(key) {
            Self::write_bytes(writer, marker.as_bytes()).await;
            writer.rotated = true;
        }
    }

    async fn close_and_delete(&self, guard: &mut HashMap<String, Writer>, key: &str) {
        if let Some(mut writer) = guard.remove(key) {
            let _ = writer.file.flush().await;
        }
        let path = self.path_for(key);
        let _ = fs::remove_file(&path).await;
    }

    async fn write_bytes(writer: &mut Writer, bytes: &[u8]) {
        if writer.file.write_all(bytes).await.is_err() {
            return;
        }
        if writer.file.flush().await.is_err() {
            return;
        }
        writer.written += bytes.len() as u64;
    }
}

/// Lowercases nothing (source/task-id names are already the display form) —
/// just maps every char outside `[A-Za-z0-9._-]` to `_` and strips leading
/// dots, so a key segment can never escape `root` (no `..`, no absolute
/// path, no hidden file) regardless of what a future caller passes as a
/// source/task-id name.
fn sanitize_segment(raw: &str) -> String {
    let mapped: String = raw
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') {
                c
            } else {
                '_'
            }
        })
        .collect();
    let trimmed = mapped.trim_start_matches('.');
    if trimmed.is_empty() {
        "_".to_string()
    } else {
        trimmed.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store(cap: u64) -> (tempfile::TempDir, LogStore) {
        let dir = tempfile::tempdir().unwrap();
        let store = LogStore::with_cap(dir.path().to_path_buf(), cap);
        (dir, store)
    }

    #[tokio::test]
    async fn append_then_tail_read_roundtrips() {
        let (_dir, store) = store(WRITE_CAP_BYTES);
        store.append("app/setup", "hello ").await;
        store.append("app/setup", "world\n").await;
        assert_eq!(
            store.tail_read("app/setup", DEFAULT_TAIL_BYTES).await,
            "hello world\n"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn log_files_are_owner_only_on_create_and_reopen() {
        use std::os::unix::fs::PermissionsExt;

        let (dir, store) = store(WRITE_CAP_BYTES);
        store.append("app/setup", "first\n").await;
        let path = dir.path().join("app/setup");
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );

        store.close_writer_if_idle("app/setup");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(store.tail_read("app/setup", 4096).await, "first\n");
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );

        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        store.append("app/setup", "second\n").await;
        assert_eq!(
            std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    #[tokio::test]
    async fn tail_read_of_missing_key_is_empty() {
        let (_dir, store) = store(WRITE_CAP_BYTES);
        assert_eq!(store.tail_read("app/never-written", 1024).await, "");
    }

    #[tokio::test]
    async fn tail_read_only_returns_the_last_max_bytes() {
        let (_dir, store) = store(WRITE_CAP_BYTES);
        store.append("app/setup", "0123456789").await;
        assert_eq!(store.tail_read("app/setup", 4).await, "6789");
    }

    #[tokio::test]
    async fn tail_read_cuts_lossily_at_a_multibyte_boundary() {
        let (_dir, store) = store(WRITE_CAP_BYTES);
        // "é" is 2 bytes (0xC3 0xA9); "a é" = ['a',' ',0xC3,0xA9] — asking
        // for the last 1 byte lands mid-codepoint (just the trailing 0xA9),
        // which must decode lossily rather than panicking.
        store.append("app/setup", "a é").await;
        let tail = store.tail_read("app/setup", 1).await;
        assert_eq!(tail.chars().count(), 1);
        assert_eq!(tail, "\u{FFFD}");
    }

    #[tokio::test]
    async fn append_rotates_at_cap_with_a_marker_line() {
        let (_dir, store) = store(10);
        store.append("app/setup", "0123456789").await; // exactly at cap, no rotation yet
        assert!(!store.is_truncated("app/setup").await);
        store.append("app/setup", "x").await; // would exceed -> rotates
        assert!(store.is_truncated("app/setup").await);
        let content = store.tail_read("app/setup", 4096).await;
        assert!(
            content.starts_with("[log rotated at 10 bytes]\n"),
            "got: {content:?}"
        );
        assert!(content.ends_with('x'), "got: {content:?}");
        // The pre-rotation content must be GONE (rotation deletes, not
        // trims) — byte-parity with LogTee's rotate-by-unlink, not a
        // sliding window.
        assert!(!content.contains("0123456789"));
    }

    #[tokio::test]
    async fn truncate_resets_to_an_empty_fresh_file() {
        let (_dir, store) = store(WRITE_CAP_BYTES);
        store.append("app/setup", "old transcript\n").await;
        store.truncate("app/setup").await;
        assert_eq!(store.tail_read("app/setup", 4096).await, "");
        assert!(!store.is_truncated("app/setup").await);
        store.append("app/setup", "fresh\n").await;
        assert_eq!(store.tail_read("app/setup", 4096).await, "fresh\n");
    }

    #[tokio::test]
    async fn remove_deletes_the_file() {
        let (_dir, store) = store(WRITE_CAP_BYTES);
        store.append("tasks/task1.out", "hi\n").await;
        store.remove("tasks/task1.out").await;
        assert_eq!(store.tail_read("tasks/task1.out", 4096).await, "");
    }

    #[tokio::test]
    async fn sanitizes_unsafe_key_segments() {
        let (_dir, store) = store(WRITE_CAP_BYTES);
        store.append("app/../../etc/passwd", "nope\n").await;
        // Whatever path this resolved to, it must stay under `root` — the
        // sanitizer strips leading dots per-segment, so this lands at
        // `root/app/etc/passwd` (or similar), never escaping upward.
        let path = store.path_for("app/../../etc/passwd");
        assert!(path.starts_with(&store.root));
    }

    #[tokio::test]
    async fn concurrent_appends_to_the_same_key_never_corrupt_or_drop_data() {
        let (_dir, store) = store(WRITE_CAP_BYTES);
        let store = std::sync::Arc::new(store);
        let mut handles = Vec::new();
        for i in 0..20 {
            let store = store.clone();
            handles.push(tokio::spawn(async move {
                store.append("app/setup", &format!("line-{i}\n")).await;
            }));
        }
        for h in handles {
            h.await.unwrap();
        }
        let content = store.tail_read("app/setup", 4096).await;
        for i in 0..20 {
            assert!(
                content.contains(&format!("line-{i}\n")),
                "missing line-{i} in: {content:?}"
            );
        }
    }

    #[tokio::test]
    async fn app_sources_are_discovered_from_preexisting_files_in_stable_order() {
        let (dir, store) = store(WRITE_CAP_BYTES);
        let app_dir = dir.path().join("app");
        tokio::fs::create_dir_all(app_dir.join("not-a-source"))
            .await
            .unwrap();
        tokio::fs::write(app_dir.join("setup"), "old setup\n")
            .await
            .unwrap();
        tokio::fs::write(app_dir.join("dev"), "old dev\n")
            .await
            .unwrap();
        tokio::fs::write(app_dir.join(".hidden"), "ignore me\n")
            .await
            .unwrap();

        assert_eq!(store.app_sources().await, vec!["dev", "setup"]);
    }

    #[tokio::test]
    async fn app_source_filenames_are_reversible_and_collision_free_after_restart() {
        let dir = tempfile::tempdir().unwrap();
        let store = LogStore::new(dir.path().to_path_buf());

        assert_eq!(app_key("setup"), "app/setup");
        assert_eq!(app_key("dev"), "app/dev");
        assert_ne!(app_key("dev:web"), app_key("dev_web"));
        store.append(&app_key("setup"), "setup output\n").await;
        store.append(&app_key("dev:web"), "colon output\n").await;
        store
            .append(&app_key("dev_web"), "underscore output\n")
            .await;

        let restarted = LogStore::new(dir.path().to_path_buf());
        assert_eq!(
            restarted.app_sources().await,
            vec!["dev:web", "dev_web", "setup"]
        );
        assert_eq!(
            restarted.tail_read(&app_key("dev:web"), 4096).await,
            "colon output\n"
        );
        assert_eq!(
            restarted.tail_read(&app_key("dev_web"), 4096).await,
            "underscore output\n"
        );
        assert!(dir.path().join("app/setup").is_file());
    }

    #[tokio::test]
    async fn rotated_app_log_remains_discoverable() {
        let (_dir, store) = store(10);
        store.append("app/setup", "0123456789").await;
        store.append("app/setup", "x").await;

        assert_eq!(store.app_sources().await, vec!["setup"]);
        assert!(store
            .tail_read("app/setup", 4096)
            .await
            .starts_with("[log rotated at 10 bytes]\n"));
    }
}
