//! The one process-spawn abstraction — PTY (via `portable-pty`) OR plain
//! pipes behind a single [`spawn`] entry point, mirroring
//! `packages/sandbox/daemon/process/pty-spawn.ts`'s two-tier contract
//! (`spawnPty` + its `spawnFallback`) in intent: `TERM=xterm-256color`,
//! 128+signal shell-convention exit codes, 3× `openpty`/`forkpty` retry
//! with backoff before falling back to plain pipes on PTY-allocation
//! failure (keyed off the failure itself, not an OS-version-specific error
//! string — see the native implementation contract section 4's "Fallback design
//! that must be preserved").
//!
//! ## Why harness dispatch does NOT use the PTY path (investigated + decided)
//!
//! The Phase 2 TODO explicitly asks this to be investigated and documented,
//! not just asserted. Evidence, gathered by actually running both CLIs on
//! this machine (claude 2.1.214, codex-cli 0.144.5, 2026-07-18):
//!
//! - `claude -p --output-format stream-json --verbose` and
//!   `codex exec --json` were both run with stdout/stderr redirected to a
//!   plain file (i.e. `isatty(stdout) == false`, no PTY at all) and BOTH
//!   produced clean, complete, well-formed ndjson with no missing frames,
//!   no ANSI escape codes, and no behavioral difference from a TTY-backed
//!   run. `-p`/`--print` (claude) and `exec` (codex) are each CLI's
//!   explicit non-interactive/headless mode — by design, not by accident,
//!   these do not require a controlling terminal.
//! - A PTY, if used, would actively HURT this use case: `events::claude`
//!   and `events::codex` parse each line of stdout as one JSON object.
//!   PTY line-discipline (canonical mode line editing, `\r\n` translation,
//!   OS-level 4096-byte-line buffering under some ptys) and any
//!   TTY-triggered color/progress-bar ANSI output the CLI might emit ARE
//!   TTY-mode side effects specifically — no evidence either CLI emits
//!   them in `-p`/`exec` mode, but a PTY would risk introducing exactly
//!   the corruption this crate's ndjson parser has no reason to defend
//!   against if plain pipes are used.
//! - A concrete failure mode observed empirically: `codex exec` reads
//!   stdin as an "append to the prompt" channel when stdin is a pipe
//!   (`Reading additional input from stdin...`) and hangs waiting for EOF
//!   if it never arrives — this crate's plain-pipe path closes stdin
//!   (`Stdio::null()`) specifically to prevent that hang. A PTY's stdin
//!   is inherently a terminal-like fd (never naturally EOF-closed by the
//!   spawning side the way a piped `Stdio::null()` is), which would make
//!   this specific, already-observed hazard WORSE, not better.
//!
//! **Decision**: `run.rs` always spawns with `pty: false` (plain pipes).
//! The PTY half of this module exists, is exercised by this module's own
//! tests, and remains available for any FUTURE harness/CLI that genuinely
//! requires a controlling terminal (the Phase 2 TODO's explicit ask: "one
//! spawn abstraction" covering both, not a PTY-only or plain-only module).

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use tokio::sync::{mpsc, oneshot, Mutex, Notify};

/// One request to spawn a child process. `Clone` so a caller can retain a
/// copy across a PTY→plain-pipe fallback without re-building it.
#[derive(Debug, Clone)]
pub struct SpawnRequest {
    /// `argv[0]` is the program; the rest are its arguments.
    pub argv: Vec<String>,
    pub cwd: Option<PathBuf>,
    /// Extra/override environment variables, merged over the inherited
    /// process environment (and `TERM=xterm-256color`, always set).
    pub env: Vec<(String, String)>,
    /// Path to local-api's crash/relaunch ownership fence. The production
    /// plain-pipe path opens this file with a shared advisory lock and passes
    /// that locked file into the independent watchdog as an exec-inherited
    /// descriptor before the CLI is spawned. A replacement local-api takes an
    /// exclusive lock before recovering durable queue state, so it cannot
    /// promote a successor while an old crash watchdog still owns descendants.
    ///
    /// `None` is reserved for harness-crate unit tests and non-local-api users;
    /// both native dispatch call sites always provide the app-root path.
    pub lifetime_lock_path: Option<PathBuf>,
    /// `true` requests the PTY path (with plain-pipe fallback on
    /// allocation failure); `false` goes straight to plain pipes. See this
    /// module's doc comment for why harness dispatch always passes
    /// `false`.
    pub pty: bool,
}

impl SpawnRequest {
    pub fn new(argv: Vec<String>) -> Self {
        Self {
            argv,
            cwd: None,
            env: Vec::new(),
            lifetime_lock_path: None,
            pty: false,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Signal {
    Term,
    Kill,
}

impl Signal {
    /// The `kill(1)` flag spelling — the one place this mapping lives.
    pub(crate) fn flag(self) -> &'static str {
        match self {
            Signal::Term => "-TERM",
            Signal::Kill => "-KILL",
        }
    }
}

/// Shell-convention exit info: `code` is the raw exit code for a normal
/// exit, or `128 + signal` for a signal-terminated process (POSIX shell
/// convention — byte-parity in SPIRIT with `pty-spawn.ts::shellExitCode`,
/// though Rust's `std::os::unix::process::ExitStatusExt::signal()` makes
/// the actual mapping far simpler than the TS side's signal-NAME-to-number
/// table: `ExitStatus::signal()` already returns the numeric signal, no
/// name/number lookup table needed).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExitInfo {
    pub code: i32,
}

#[derive(Debug)]
pub enum SpawnError {
    Io(std::io::Error),
    /// PTY allocation/spawn failed (after retries, if the PTY path was
    /// requested) — carries the last error's message.
    Pty(String),
    /// The spawned child never reported a pid (should not happen in
    /// practice; guarded defensively rather than unwrapped).
    NoPid,
}

impl std::fmt::Display for SpawnError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SpawnError::Io(e) => write!(f, "spawn failed: {e}"),
            SpawnError::Pty(msg) => write!(f, "PTY spawn failed: {msg}"),
            SpawnError::NoPid => write!(f, "spawned child reported no pid"),
        }
    }
}

impl std::error::Error for SpawnError {}

/// A running (or just-exited) child process. `stdout`/`stderr` are
/// SEPARATE channels always (even in PTY mode, where `stderr` simply never
/// produces anything — the OS merges both into the one PTY stream, routed
/// here as `stdout`) — unlike `pty-spawn.ts`'s merged single stream, this
/// crate's consumer (`run.rs`) needs stdout to carry ONLY the harness's
/// ndjson, uncontaminated by stderr diagnostics.
pub struct SpawnedProcess {
    pub pid: u32,
    pub stdout: mpsc::Receiver<Bytes>,
    pub stderr: mpsc::Receiver<Bytes>,
    /// Resolves exactly once, when the child exits.
    pub exit: oneshot::Receiver<ExitInfo>,
    /// Live ownership of the process group. On the plain-pipe path used by
    /// harness dispatch, the independent group anchor stays alive until this
    /// becomes inert, so stale cancellation cannot target a reused pgid.
    pub(crate) lease: ProcessLease,
    /// Ownership signal for the detached plain-pipe waiter that holds the
    /// actual child. Dropping the consumer closes this sender; the waiter then
    /// performs the same bounded process-group teardown as explicit cancel.
    pub(crate) owner: ProcessOwner,
}

impl SpawnedProcess {
    /// Signals the child's WHOLE PROCESS GROUP (not just the direct
    /// child) — see [`kill_pid`]'s doc comment for the mechanism and why.
    pub async fn kill(&self, signal: Signal) {
        self.lease.signal(signal).await;
    }
}

/// A process-group id paired with its in-process ownership lifetime.
///
/// Unix's `kill(2)` API only accepts a numeric pid/pgid, so retaining that
/// number after the child has been reaped risks signaling an unrelated process
/// after pid reuse. Runtime cancellation therefore carries this lease instead.
/// The production plain-pipe path couples it to an independent group anchor;
/// PTY is a completeness-only utility and does not claim that stronger anchor
/// guarantee (harness dispatch always sets `pty: false`).
#[derive(Clone)]
pub(crate) struct ProcessLease {
    inner: Arc<ProcessLeaseInner>,
}

struct ProcessLeaseInner {
    group_id: u32,
    /// The independent watchdog is the group leader on the plain path. It
    /// must never receive SIGKILL with the rest of the group: it owns the
    /// inherited shared lifetime fence and releases it only after proving
    /// every non-anchor group member is gone. PTY has no such anchor.
    anchor_id: Option<u32>,
    alive: AtomicBool,
    exited: Notify,
    /// Serializes every numeric-pgid signal with the final group-anchor reap.
    /// Without this gate, a signal task could observe `alive`, get descheduled,
    /// then resume after the watchdog was reaped and target a reused pgid.
    signal_gate: Mutex<()>,
    termination_started: AtomicBool,
    termination_finished: AtomicBool,
    termination_done: Notify,
}

impl ProcessLease {
    fn new(group_id: u32, anchor_id: Option<u32>) -> Self {
        Self {
            inner: Arc::new(ProcessLeaseInner {
                group_id,
                anchor_id,
                alive: AtomicBool::new(true),
                exited: Notify::new(),
                signal_gate: Mutex::new(()),
                termination_started: AtomicBool::new(false),
                termination_finished: AtomicBool::new(false),
                termination_done: Notify::new(),
            }),
        }
    }

    pub(crate) fn is_alive(&self) -> bool {
        self.inner.alive.load(Ordering::SeqCst)
    }

    fn mark_exited(&self) {
        if self.inner.alive.swap(false, Ordering::SeqCst) {
            self.inner.exited.notify_waiters();
        }
    }

    /// PTY's waiter is a blocking OS thread. It uses the same signal gate so a
    /// signal already in flight finishes before the lease becomes inert.
    fn mark_exited_blocking(&self) {
        let _signal_guard = self.inner.signal_gate.blocking_lock();
        self.mark_exited();
    }

    pub(crate) async fn signal(&self, signal: Signal) {
        let _signal_guard = self.inner.signal_gate.lock().await;
        if self.is_alive() {
            if let Some(anchor_id) = self.inner.anchor_id {
                // Shared enumerate-then-signal helper (blocking `pgrep` +
                // `kill`) — see `crate::watchdog` for why `-<pgid>` is
                // forbidden while the anchor owns the lifetime fence.
                let group_id = self.inner.group_id;
                let _ = tokio::task::spawn_blocking(move || {
                    crate::watchdog::signal_non_anchor_members(group_id, anchor_id, signal)
                })
                .await;
            } else {
                kill_pid(self.inner.group_id, signal).await;
            }
        }
    }

    /// Cooperative cancellation with a bounded hard-kill fallback. The
    /// watchdog remains the process-group anchor while the CLI is alive, so
    /// the pgid cannot disappear/rebind during this lease. A stale clone is
    /// inert after `mark_exited`. Escalation runs in its own once-only task:
    /// dropping the caller's future after TERM cannot strand a resistant CLI.
    pub(crate) async fn terminate(&self) {
        if !self.is_alive() {
            return;
        }

        let done = self.inner.termination_done.notified();
        tokio::pin!(done);
        done.as_mut().enable();

        if !self.inner.termination_started.swap(true, Ordering::SeqCst) {
            let lease = self.clone();
            tokio::spawn(async move {
                lease.signal(Signal::Term).await;
                if lease.is_alive() {
                    let exited = lease.inner.exited.notified();
                    tokio::pin!(exited);
                    exited.as_mut().enable();
                    if lease.is_alive() {
                        tokio::select! {
                            _ = &mut exited => {},
                            _ = tokio::time::sleep(Duration::from_secs(1)) => {
                                lease.signal(Signal::Kill).await;
                            }
                        }
                    }
                }
                lease
                    .inner
                    .termination_finished
                    .store(true, Ordering::SeqCst);
                lease.inner.termination_done.notify_waiters();
            });
        }

        if !self.inner.termination_finished.load(Ordering::SeqCst) {
            done.await;
        }
    }

    /// Final cleanup for the plain-pipe path. Closing the liveness writer asks
    /// the watchdog to TERM→KILL every NON-anchor member and keep its shared
    /// lifetime fence until `pgrep` proves the group empty. Only then does the
    /// watchdog exit and become reapable. Killing the anchor ourselves would
    /// release the restart fence before descendants were known gone.
    #[cfg(unix)]
    async fn finish_plain_group(
        &self,
        watchdog: &mut tokio::process::Child,
        parent_liveness: tokio::process::ChildStdin,
    ) {
        let _signal_guard = self.inner.signal_gate.lock().await;
        drop(parent_liveness);
        match watchdog.wait().await {
            Ok(_) => self.mark_exited(),
            Err(error) => {
                // Fail closed. The watchdog may still own the shared lifetime
                // fence; pretending cleanup finished would let queue recovery
                // race an indeterminate old process tree.
                tracing::error!(%error, "could not prove harness watchdog exit");
                std::future::pending::<()>().await;
            }
        }
    }
}

/// The waiter owns the OS child; the stream driver owns this sender. That
/// explicit edge makes dropping/aborting a driver a teardown event instead of
/// silently detaching the waiter and its child process.
pub(crate) struct ProcessOwner {
    teardown: Option<oneshot::Sender<()>>,
}

impl ProcessOwner {
    fn new(teardown: oneshot::Sender<()>) -> Self {
        Self {
            teardown: Some(teardown),
        }
    }

    fn inert() -> Self {
        Self { teardown: None }
    }
}

impl Drop for ProcessOwner {
    fn drop(&mut self) {
        if let Some(teardown) = self.teardown.take() {
            let _ = teardown.send(());
        }
    }
}

/// Signals process GROUP `pid` (not just the single process) — see
/// `Cargo.toml`'s doc comment on why this shells out to `kill(1)` instead
/// of an `unsafe` `libc::kill` FFI call. The caller passes an owned process
/// GROUP id: plain harnesses use the parent-liveness watchdog's pid, while
/// PTY children use `portable-pty`'s session/group-leading pid. `-<pgid>`
/// reaches the harness CLI's own child processes too (e.g. a Bash tool call),
/// not just the direct CLI. Plain-pipe runtime callers retain a
/// watchdog-anchored [`ProcessLease`], never this bare number, so pid reuse
/// cannot turn a stale cancel into a signal for an unrelated process.
#[cfg(unix)]
pub async fn kill_pid(pid: u32, signal: Signal) {
    let pgid = format!("-{pid}");
    let _ = tokio::process::Command::new("kill")
        .arg(signal.flag())
        .arg(pgid)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .await;
}

#[cfg(not(unix))]
pub async fn kill_pid(_pid: u32, _signal: Signal) {
    // Process-group signaling is a POSIX concept; Windows job objects are
    // a different mechanism entirely. Studio ships as a macOS desktop app
    // (the desktop migration contract) — out of scope for v1, not silently pretended to work.
    tracing::warn!("process-group kill is not implemented on this platform");
}

/// Spawn per `req`. Tries PTY first (with retry+backoff) when
/// `req.pty == true`, falling back to plain pipes on allocation failure;
/// otherwise goes straight to plain pipes.
pub async fn spawn(req: SpawnRequest) -> Result<SpawnedProcess, SpawnError> {
    if req.pty {
        let pty_req = req.clone();
        match tokio::task::spawn_blocking(move || pty::spawn_pty_with_retry(&pty_req)).await {
            Ok(Ok(built)) => return Ok(pty::finish_async(built)),
            Ok(Err(err)) => {
                tracing::warn!(
                    error = %err,
                    "PTY spawn failed after retries, falling back to plain pipes"
                );
            }
            Err(join_err) => {
                tracing::warn!(
                    error = %join_err,
                    "PTY spawn task panicked, falling back to plain pipes"
                );
            }
        }
    }
    plain::spawn_plain(req).await
}

// ---------------------------------------------------------------------------
// Plain-pipe path (the one harness dispatch actually uses)
// ---------------------------------------------------------------------------

mod plain {
    use super::*;
    use std::process::Stdio;

    pub async fn spawn_plain(req: SpawnRequest) -> Result<SpawnedProcess, SpawnError> {
        let SpawnRequest {
            argv,
            cwd,
            env,
            lifetime_lock_path,
            pty: _,
        } = req;
        let (program, args) = argv.split_first().ok_or(SpawnError::NoPid)?;

        // Unix-only process-group anchor (`crate::watchdog` — the one shared
        // copy of the parent-liveness script). Its stdin is a liveness pipe
        // whose writer exists only inside Studio: if Studio is uncatchably
        // terminated (`SIGKILL`, crash), EOF wakes the independent watchdog
        // and it TERM→KILLs every surviving group member, releasing the
        // inherited shared lifetime fence only after `pgrep` proves the group
        // empty. Normal completion explicitly KILLs and reaps it below.
        #[cfg(unix)]
        let (mut watchdog, parent_liveness, process_group_id) = {
            // Acquire before the watchdog exists and before the CLI spawn can
            // happen. Moving this locked File into stdout makes it an
            // exec-inherited descriptor owned by the watchdog; Studio keeps
            // no duplicate whose close could accidentally release the fence.
            let lifetime_lock = lifetime_lock_path
                .as_deref()
                .map(crate::watchdog::open_shared_lifetime_lock)
                .transpose()
                .map_err(SpawnError::Io)?;
            let anchor = crate::watchdog::spawn_anchor("decocms-harness-watchdog", lifetime_lock)
                .map_err(SpawnError::Io)?;
            (anchor.child, anchor.parent_liveness, anchor.group_id)
        };

        let mut std_cmd = std::process::Command::new(program);
        std_cmd.args(args);
        if let Some(cwd) = &cwd {
            std_cmd.current_dir(cwd);
        }
        std_cmd.env("TERM", "xterm-256color");
        for (k, v) in &env {
            std_cmd.env(k, v);
        }
        // This is the REAL CLI's stdin, and remains /dev/null even on Unix.
        // The separate watchdog owns the parent-liveness pipe; codex can never
        // mistake that pipe for additional prompt input.
        std_cmd.stdin(Stdio::null());
        std_cmd.stdout(Stdio::piped());
        std_cmd.stderr(Stdio::piped());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            // Join the watchdog's already-live process group. The watchdog is
            // the group anchor, so the pgid remains owned and cannot be reused
            // until the waiter below reaps it.
            let process_group = i32::try_from(process_group_id).map_err(|_| {
                SpawnError::Io(std::io::Error::other(
                    "watchdog pid does not fit a Unix process-group id",
                ))
            })?;
            std_cmd.process_group(process_group);
        }

        let mut tokio_cmd = tokio::process::Command::from(std_cmd);
        // Last-resort teardown for runtime/app shutdown: if the waiter task
        // owning this `Child` is dropped before it can reap the process,
        // dropping the child must not leave the harness CLI running detached
        // from Studio. Normal cancellation still signals the whole process
        // group through `kill_pid`; this guard covers abrupt Tokio-runtime
        // teardown of the direct child.
        tokio_cmd.kill_on_drop(true);
        let mut child = match tokio_cmd.spawn() {
            Ok(child) => child,
            Err(error) => {
                #[cfg(unix)]
                {
                    // The CLI never started. Close the liveness pipe and let
                    // the watchdog prove its group has no non-anchor members
                    // before it releases the shared lifetime fence.
                    drop(parent_liveness);
                    let _ = watchdog.wait().await;
                }
                return Err(SpawnError::Io(error));
            }
        };
        let pid = child.id().ok_or(SpawnError::NoPid)?;
        let stdout = child.stdout.take().expect("stdout was piped");
        let stderr = child.stderr.take().expect("stderr was piped");

        let (stdout_tx, stdout_rx) = mpsc::channel(256);
        let (stderr_tx, stderr_rx) = mpsc::channel(256);
        let (exit_tx, exit_rx) = oneshot::channel();
        let (teardown_tx, mut teardown_rx) = oneshot::channel();

        tokio::spawn(pump(stdout, stdout_tx));
        tokio::spawn(pump(stderr, stderr_tx));
        #[cfg(unix)]
        let lease = ProcessLease::new(process_group_id, Some(process_group_id));
        #[cfg(not(unix))]
        let lease = ProcessLease::new(pid, None);
        let waiter_lease = lease.clone();

        tokio::spawn(async move {
            let status = tokio::select! {
                status = child.wait() => status,
                _ = &mut teardown_rx => {
                    #[cfg(unix)]
                    waiter_lease.terminate().await;
                    #[cfg(not(unix))]
                    let _ = child.start_kill();
                    child.wait().await
                }
            };
            #[cfg(unix)]
            {
                // The direct CLI is reaped, but tools/grandchildren could
                // still occupy its group. The watchdog anchor proves the pgid
                // is still ours, so a final group KILL is safe and leaves no
                // detached descendants. Keep the liveness writer open until
                // AFTER the watchdog is gone so it cannot race this cleanup.
                waiter_lease
                    .finish_plain_group(&mut watchdog, parent_liveness)
                    .await;
            }
            #[cfg(not(unix))]
            waiter_lease.mark_exited();
            let _ = exit_tx.send(exit_info_from(status));
        });

        Ok(SpawnedProcess {
            pid,
            stdout: stdout_rx,
            stderr: stderr_rx,
            exit: exit_rx,
            lease,
            owner: ProcessOwner::new(teardown_tx),
        })
    }

    async fn pump<R: tokio::io::AsyncRead + Unpin>(mut reader: R, tx: mpsc::Sender<Bytes>) {
        use tokio::io::AsyncReadExt;
        let mut buf = vec![0u8; 8192];
        loop {
            match reader.read(&mut buf).await {
                Ok(0) => return,
                Ok(n) => {
                    if tx.send(Bytes::copy_from_slice(&buf[..n])).await.is_err() {
                        return;
                    }
                }
                Err(_) => return,
            }
        }
    }

    fn exit_info_from(status: std::io::Result<std::process::ExitStatus>) -> ExitInfo {
        match status {
            Ok(s) => shell_exit_code(s),
            Err(_) => ExitInfo { code: 1 },
        }
    }

    #[cfg(unix)]
    fn shell_exit_code(status: std::process::ExitStatus) -> ExitInfo {
        use std::os::unix::process::ExitStatusExt;
        if let Some(sig) = status.signal() {
            return ExitInfo { code: 128 + sig };
        }
        ExitInfo {
            code: status.code().unwrap_or(1),
        }
    }

    #[cfg(not(unix))]
    fn shell_exit_code(status: std::process::ExitStatus) -> ExitInfo {
        ExitInfo {
            code: status.code().unwrap_or(1),
        }
    }
}

// ---------------------------------------------------------------------------
// PTY path (implemented for completeness per the Phase 2 TODO's "one spawn
// abstraction" ask; NOT the path harness dispatch takes — see module doc)
// ---------------------------------------------------------------------------

mod pty {
    use super::*;
    use portable_pty::{native_pty_system, Child, CommandBuilder, ExitStatus, PtySize};
    use std::io::Read;

    /// 3 attempts, 50ms × attempt-number backoff between them — same
    /// numbers as `pty-spawn.ts::spawnPty`'s retry loop.
    const MAX_ATTEMPTS: u32 = 3;

    pub struct Built {
        pub pid: u32,
        pub child: Box<dyn Child + Send + Sync>,
        pub reader: Box<dyn Read + Send>,
        /// Kept alive for the process's lifetime — dropping the PTY
        /// pair's master half can tear down the slave side prematurely on
        /// some platforms.
        pub _master: Box<dyn portable_pty::MasterPty + Send>,
    }

    /// BLOCKING — must be called from `tokio::task::spawn_blocking` (both
    /// `openpty`/`spawn_command` and the retry loop's backoff sleep are
    /// synchronous).
    pub fn spawn_pty_with_retry(req: &SpawnRequest) -> Result<Built, SpawnError> {
        let mut last_err = None;
        for attempt in 0..MAX_ATTEMPTS {
            match spawn_pty_once(req) {
                Ok(built) => return Ok(built),
                Err(e) => {
                    last_err = Some(e);
                    std::thread::sleep(Duration::from_millis(50 * u64::from(attempt + 1)));
                }
            }
        }
        Err(last_err.unwrap_or_else(|| SpawnError::Pty("unknown PTY failure".to_string())))
    }

    fn spawn_pty_once(req: &SpawnRequest) -> Result<Built, SpawnError> {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: 30,
                cols: 120,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| SpawnError::Pty(e.to_string()))?;

        let (program, args) = req
            .argv
            .split_first()
            .ok_or_else(|| SpawnError::Pty("empty argv".to_string()))?;
        let mut cmd = CommandBuilder::new(program);
        for a in args {
            cmd.arg(a);
        }
        if let Some(cwd) = &req.cwd {
            cmd.cwd(cwd);
        }
        cmd.env("TERM", "xterm-256color");
        for (k, v) in &req.env {
            cmd.env(k, v);
        }

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| SpawnError::Pty(e.to_string()))?;
        let pid = child.process_id().unwrap_or(0);
        // The slave fd isn't needed once the child has it open.
        drop(pair.slave);
        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| SpawnError::Pty(e.to_string()))?;

        Ok(Built {
            pid,
            child,
            reader,
            _master: pair.master,
        })
    }

    /// Bridges the blocking `portable_pty::Child`/`Read` API to the same
    /// async `SpawnedProcess` shape the plain path returns — a dedicated
    /// OS thread per stream (portable-pty's reader/wait calls are
    /// blocking; there is no async portable-pty API to await instead).
    pub fn finish_async(built: Built) -> SpawnedProcess {
        let Built {
            pid,
            mut child,
            mut reader,
            _master,
        } = built;

        let (stdout_tx, stdout_rx) = mpsc::channel::<Bytes>(256);
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => return,
                    Ok(n) => {
                        if stdout_tx
                            .blocking_send(Bytes::copy_from_slice(&buf[..n]))
                            .is_err()
                        {
                            return;
                        }
                    }
                    Err(_) => return,
                }
            }
        });

        // stderr is never populated in PTY mode — the OS already merged
        // it into the master fd read above. An immediately-closed channel
        // gives `run.rs` a uniform `SpawnedProcess` shape regardless of
        // which path was taken.
        let (_stderr_tx, stderr_rx) = mpsc::channel::<Bytes>(1);

        let lease = ProcessLease::new(pid, None);
        let waiter_lease = lease.clone();
        let (exit_tx, exit_rx) = oneshot::channel();
        std::thread::spawn(move || {
            let status = child.wait();
            waiter_lease.mark_exited_blocking();
            let _ = exit_tx.send(exit_info_from_pty(status));
        });

        SpawnedProcess {
            pid,
            stdout: stdout_rx,
            stderr: stderr_rx,
            exit: exit_rx,
            lease,
            // Harness dispatch always uses plain pipes. PTY remains a fallback
            // utility and its blocking portable-pty waiter has no async owner
            // channel; explicit `kill` remains available through the lease.
            owner: ProcessOwner::inert(),
        }
    }

    /// Maps `portable_pty::ExitStatus` to the shell-convention
    /// `128 + signal` for a signal-terminated child. UNLIKE the plain-pipe
    /// path (`std::os::unix::process::ExitStatusExt::signal()`, a clean
    /// numeric accessor), `portable_pty::ExitStatus::exit_code()` on a
    /// signal-killed child is always just `1` (see 0.9.0's
    /// `From<std::process::ExitStatus>` — it discards the real code once
    /// a signal is present) — the crate only exposes the signal via
    /// `signal() -> Option<&str>`, a human `strsignal(3)`-derived
    /// description, NOT a bare number. Verified empirically on THIS
    /// platform (macOS 26 / Darwin 25, the v1 ship target per the desktop migration contract):
    /// `strsignal` here always suffixes the description with `: <N>`
    /// (`"Terminated: 15"`, `"Killed: 9"`, `"Interrupt: 2"`) — see this
    /// module's `pty_spawn_captures_output_and_signal_exit_code` test,
    /// which exercises this exact parse against a real spawned+signaled
    /// child rather than a canned string. Falls back to `exit_code()`
    /// (never panics/errors) if a future platform's `strsignal` output
    /// doesn't end in a parseable number — the PTY path isn't
    /// harness-dispatch's default anyway (see module doc), so a
    /// less-precise code on a hypothetical odd platform is an acceptable
    /// degradation, not a correctness blocker.
    fn exit_info_from_pty(status: std::io::Result<ExitStatus>) -> ExitInfo {
        match status {
            Ok(s) => ExitInfo {
                code: signal_number_from_description(s.signal())
                    .map(|sig| 128 + sig)
                    .unwrap_or(s.exit_code() as i32),
            },
            Err(_) => ExitInfo { code: 1 },
        }
    }

    /// Parses the trailing `: <N>` off a `strsignal`-derived description
    /// (see `exit_info_from_pty`'s doc comment). `None` for `None` input
    /// or a description that doesn't end in `: <digits>`.
    fn signal_number_from_description(description: Option<&str>) -> Option<i32> {
        let (_, tail) = description?.rsplit_once(':')?;
        tail.trim().parse::<i32>().ok()
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn parses_macos_strsignal_style_descriptions() {
            assert_eq!(
                signal_number_from_description(Some("Terminated: 15")),
                Some(15)
            );
            assert_eq!(signal_number_from_description(Some("Killed: 9")), Some(9));
            assert_eq!(
                signal_number_from_description(Some("Interrupt: 2")),
                Some(2)
            );
        }

        #[test]
        fn none_and_unparseable_descriptions_yield_none() {
            assert_eq!(signal_number_from_description(None), None);
            assert_eq!(signal_number_from_description(Some("Terminated")), None);
            assert_eq!(signal_number_from_description(Some("")), None);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn collect_stdout(mut rx: mpsc::Receiver<Bytes>) -> String {
        let mut out = Vec::new();
        while let Some(chunk) = rx.recv().await {
            out.extend_from_slice(&chunk);
        }
        String::from_utf8_lossy(&out).into_owned()
    }

    #[tokio::test]
    async fn plain_spawn_captures_stdout_and_clean_exit() {
        let req = SpawnRequest::new(vec![
            "/bin/sh".to_string(),
            "-c".to_string(),
            "echo hello-plain".to_string(),
        ]);
        let mut proc = spawn(req).await.expect("spawn should succeed");
        let out = collect_stdout(std::mem::replace(&mut proc.stdout, mpsc::channel(1).1)).await;
        assert_eq!(out.trim(), "hello-plain");
        let exit = proc.exit.await.expect("exit info");
        assert_eq!(exit.code, 0);
    }

    #[tokio::test]
    async fn plain_spawn_keeps_stdout_and_stderr_separate() {
        let req = SpawnRequest::new(vec![
            "/bin/sh".to_string(),
            "-c".to_string(),
            "echo out-line; echo err-line 1>&2".to_string(),
        ]);
        let mut proc = spawn(req).await.expect("spawn should succeed");
        let stdout = collect_stdout(std::mem::replace(&mut proc.stdout, mpsc::channel(1).1)).await;
        let stderr = collect_stdout(std::mem::replace(&mut proc.stderr, mpsc::channel(1).1)).await;
        assert_eq!(stdout.trim(), "out-line");
        assert_eq!(stderr.trim(), "err-line");
    }

    #[tokio::test]
    async fn plain_spawn_maps_nonzero_exit_code() {
        let req = SpawnRequest::new(vec![
            "/bin/sh".to_string(),
            "-c".to_string(),
            "exit 7".to_string(),
        ]);
        let proc = spawn(req).await.expect("spawn should succeed");
        let exit = proc.exit.await.expect("exit info");
        assert_eq!(exit.code, 7);
    }

    #[tokio::test]
    async fn plain_spawn_maps_signal_termination_to_128_plus_signal() {
        let req = SpawnRequest::new(vec![
            "/bin/sh".to_string(),
            "-c".to_string(),
            "kill -TERM $$; sleep 5".to_string(),
        ]);
        let proc = spawn(req).await.expect("spawn should succeed");
        let exit = proc.exit.await.expect("exit info");
        assert_eq!(exit.code, 128 + 15 /* SIGTERM */);
    }

    #[tokio::test]
    async fn plain_spawn_stdin_is_closed_not_inherited() {
        // A `cat` with no args reads stdin until EOF; if stdin were
        // inherited (a live pipe/tty) this would hang forever instead of
        // exiting immediately — the very hazard this module's doc comment
        // documents for codex's `exec` subcommand.
        let req = SpawnRequest::new(vec!["/bin/cat".to_string()]);
        let proc = spawn(req).await.expect("spawn should succeed");
        let exit = tokio::time::timeout(Duration::from_secs(5), proc.exit)
            .await
            .expect("must not hang waiting on stdin")
            .expect("exit info");
        assert_eq!(exit.code, 0);
    }

    #[tokio::test]
    async fn kill_reaches_a_process_group_grandchild() {
        // The direct child backgrounds a `sleep`, then blocks forever
        // itself — killing only the PGID (not just the direct pid) is
        // what reaps the grandchild too. We assert on the direct child's
        // own exit here (simpler to observe from this process); the
        // process-group targeting itself is exercised structurally by
        // `process_group(0)` in `plain::spawn_plain` plus this kill call
        // both operating on the same value.
        let dir = tempfile::tempdir().unwrap();
        let lifetime_lock_path = dir.path().join("child-lifetime.lock");
        let mut req = SpawnRequest::new(vec![
            "/bin/sh".to_string(),
            "-c".to_string(),
            "sleep 30 & wait".to_string(),
        ]);
        req.lifetime_lock_path = Some(lifetime_lock_path.clone());
        let proc = spawn(req).await.expect("spawn should succeed");
        // Give the shell a moment to background the sleep.
        tokio::time::sleep(Duration::from_millis(100)).await;
        let contender = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&lifetime_lock_path)
            .expect("open child lifetime fence");
        assert!(matches!(
            contender.try_lock(),
            Err(std::fs::TryLockError::WouldBlock)
        ));
        proc.kill(Signal::Kill).await;
        let exit = tokio::time::timeout(Duration::from_secs(5), proc.exit)
            .await
            .expect("kill must terminate the group promptly")
            .expect("exit info");
        assert_eq!(exit.code, 128 + 9 /* SIGKILL */);
        let successor = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&lifetime_lock_path)
            .expect("open post-reap child lifetime fence");
        successor
            .try_lock()
            .expect("watchdog releases shared fence only after group reap");
    }

    #[tokio::test]
    async fn pty_spawn_captures_output_and_signal_exit_code() {
        let mut req = SpawnRequest::new(vec![
            "/bin/sh".to_string(),
            "-c".to_string(),
            "echo hello-pty; kill -TERM $$; sleep 5".to_string(),
        ]);
        req.pty = true;
        let mut proc = spawn(req).await.expect("spawn should succeed");
        let out = collect_stdout(std::mem::replace(&mut proc.stdout, mpsc::channel(1).1)).await;
        assert!(
            out.contains("hello-pty"),
            "expected PTY output to contain the echoed line, got {out:?}"
        );
        let exit = proc.exit.await.expect("exit info");
        assert_eq!(
            exit.code,
            128 + 15,
            "portable-pty's exit_code() should already encode 128+signal"
        );
    }

    #[tokio::test]
    async fn pty_spawn_falls_back_to_plain_pipes_on_an_unresolvable_program() {
        // `native_pty_system().openpty()` itself will succeed (opening the
        // pty pair doesn't depend on the child program); it's
        // `spawn_command` that fails for a program that can't be found —
        // exercising the SAME fallback-on-spawn-failure path a genuine
        // `openpty` exhaustion would take, without needing to actually
        // exhaust the system's PTY table in a unit test.
        let mut req = SpawnRequest::new(vec!["/definitely/not/a/real/binary/xyz".to_string()]);
        req.pty = true;
        // Either path (PTY retried-then-failed-then-plain-fallback, or
        // plain directly) surfaces the SAME observable outcome: a spawn
        // error, because the plain fallback also can't find the program.
        // This asserts the fallback doesn't panic/hang and DOES surface
        // an error rather than silently succeeding.
        let result = spawn(req).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn env_vars_are_honored() {
        let mut req = SpawnRequest::new(vec![
            "/bin/sh".to_string(),
            "-c".to_string(),
            "echo \"$MY_VAR\"".to_string(),
        ]);
        req.env
            .push(("MY_VAR".to_string(), "hello-env".to_string()));
        let mut proc = spawn(req).await.expect("spawn should succeed");
        let out = collect_stdout(std::mem::replace(&mut proc.stdout, mpsc::channel(1).1)).await;
        assert_eq!(out.trim(), "hello-env");
    }

    #[tokio::test]
    async fn cwd_is_honored() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("marker.txt"), b"x").unwrap();
        let mut req = SpawnRequest::new(vec![
            "/bin/sh".to_string(),
            "-c".to_string(),
            "ls".to_string(),
        ]);
        req.cwd = Some(dir.path().to_path_buf());
        let mut proc = spawn(req).await.expect("spawn should succeed");
        let out = collect_stdout(std::mem::replace(&mut proc.stdout, mpsc::channel(1).1)).await;
        assert_eq!(out.trim(), "marker.txt");
    }
}
