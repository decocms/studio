//! `POST /_sandbox/dispatch` + `DELETE /_sandbox/runs/:id` — byte-parity
//! target: `daemon/routes/dispatch.ts`, oracle `daemon.dispatch.e2e.test.ts`.
//! Full gate/event detail:
//! the native local-API contract.
//!
//! Phase 2 scope (this file): the Phase 1 pre-stream gates (byte-parity in
//! ORDER and BODY with the daemon) are UNCHANGED; this phase adds the real
//! streaming run — resolve via `crates/harness`, spawn, translate its
//! ndjson to SSE `ui-message-chunk`/`error`/`done` frames, persist to the
//! local thread store, and wire cancel to actually kill the process. The
//! bearer check itself is NOT done in this file — both routes live under
//! the `/_sandbox` sub-router, which `router.rs`'s shared `guard`
//! middleware already gates (401 before this handler ever runs), unlike
//! the daemon's `dispatch.ts` which checks the bearer in-handler. Same
//! observable behavior, different layer.
//!
//! Gate order (`dispatch`), each short-circuiting before the next:
//!   1. (401 — enforced by the shared router guard, not here)
//!   2. bad_json — body isn't valid JSON
//!   3. missing_harness_id — `harnessId` isn't a string
//!   4. missing_run_id — `runId` isn't a string
//!   5. bad_input — `input` fails the harness-stream-input shape (see
//!      `validate_harness_input` below)
//!   6. tombstoned (410) — `runId` is within its 60s post-cancel window
//!   7. unknown_harness (400) — `harnessId` isn't `"claude-code"`/`"codex"`,
//!      OR it IS one of those but `harness::run::build_argv` can't resolve
//!      a runnable binary for it (missing CLI, bad `LOCAL_API_CLAUDE_BIN`/
//!      `LOCAL_API_CODEX_BIN` override — see `crates/harness/src/run.rs`'s
//!      module doc for why "CLI unavailable" is folded into this SAME gate
//!      rather than a separate status: both mean "this run cannot start,"
//!      decided BEFORE any process is spawned or SSE header is written).
//!
//! `validate_harness_input` is a Phase 1 APPROXIMATION of
//! `packages/sandbox/dispatch/schemas.ts::harnessStreamInputSchema` (a Zod
//! schema): it checks presence/type of every REQUIRED top-level and
//! first-level-nested field, which is enough to byte-match the one
//! contract-pinned assertion (`error:"bad_input"` on a malformed/empty
//! envelope — the exact Zod `detail` message text is NOT pinned by either
//! e2e suite, only the `error` field is). It does NOT enforce `.strict()`
//! (rejecting unknown extra keys), the `workspace` discriminated union's
//! full nuance, or the optional `models.fast/smart/image/deepResearch`
//! sub-shapes — unchanged from Phase 1, still flagged as a follow-up.
//!
//! The offload path (`messagesRef`) is dropped (§C) — `input.messages` is
//! always sent inline, so this file never looks for `messagesRef`.
//!
//! ## Thread-store persistence (Phase 2 addition — corrects a Phase 1 doc note)
//!
//! the native module-ownership contract's Dispatch section (written in
//! Phase 1) says dispatch "does NOT write to the threads store itself...
//! exactly like the daemon's does today." That's true for the TS DAEMON,
//! which has a separate cluster-side consumer of its SSE stream that owns
//! the write. Desktop `local-api` has no such consumer — the bundled
//! frontend (Phase 3) IS the SSE consumer, over the SAME localhost
//! connection dispatch answers directly. So THIS file persists on its own
//! behalf: the user message is written before streaming begins (via
//! `crate::routes::threads::ThreadsDb::create_thread_with_id` +
//! `create_run` + `create_message_with_id`, ALL idempotent-by-id so a
//! retried/re-polled dispatch for the same `runId` never duplicates
//! anything — see those methods' own doc comments), the assistant message
//! is assembled via `harness::parts::PartsAccumulator` as chunks land and
//! written once the stream ends, and the run's terminal status
//! (`completed`/`failed`/`cancelled`) is written last. `Run.id` equals
//! this route's own `runId`, matching the contract's Threads-store
//! section.
//!
//! Exercised end-to-end (dispatch-then-read-thread, against the stub
//! harness) by `apps/native/e2e/dispatch-stream.e2e.test.ts`'s "thread
//! persistence" case, plus a real-CLI run recorded in
//! the native harness smoke procedure; `crates/harness`'s own unit
//! tests (`parts.rs`, `run.rs`) and `routes/threads/db.rs`'s idempotency
//! unit tests cover the pieces in isolation.
//!
//! ## Client disconnect == cancel (round-1 verifier fix)
//!
//! Byte-parity gap found and closed: the daemon's byte-parity target
//! (`packages/sandbox/daemon/routes/dispatch.ts`) wires its
//! `ReadableStream`'s `cancel()` callback — fired when the SSE consumer
//! disconnects, e.g. a browser tab closes or the app navigates away mid
//! run — straight to `ctrl.abort()`, which reaches the real harness's
//! `AbortSignal` and kills its spawned process. The dispatch task below
//! does the SAME thing (`client_gone`, tracked from every `tx.send`
//! attempt, starting with the leading SSE comment): the instant the SSE
//! response channel's receiver is gone, `handle.cancel()` is called and no
//! further `ui-message-chunk`/`error` frames are attempted (draining
//! continues only to accumulate whatever streamed before the disconnect
//! and to learn the session id). Without this, a disconnected client would
//! leave its harness process running — or, once its stdout pipe's OS
//! buffer fills with nobody draining it, permanently blocked on a write —
//! with `active_runs` already cleared for that `run_id`, so not even a
//! later `DELETE` could reach it, and the `Run` row would sit at
//! `status:"running"` forever. `resolve_terminal_status` (below) gives
//! this implicit cancel the SAME terminal-status priority as an explicit
//! `DELETE`-driven tombstone: "cancelled" beats a crash that races in
//! right as the disconnect-triggered kill lands.
//!
//! Send-failure detection alone only fires the NEXT time this task
//! attempts a `tx.send` — fine for a harness that's actively streaming,
//! but a harness that goes quiet (a long silent tool call, or the
//! pathological `SCENARIO:hang` fixture) would never give it that
//! opportunity, so `DISPATCH_HEARTBEAT` (below) forces one periodically.
//! Empirically verified (real spawn + `kill -9` on the client mid-
//! `SCENARIO:hang`, no `DELETE` ever sent): without the heartbeat, the
//! spawned process and `status:"running"` row both survived indefinitely;
//! with it, both resolve to gone/`"cancelled"` within one heartbeat tick.

use std::collections::HashMap;
use std::convert::Infallible;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use axum::body::{Body, Bytes};
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use bytes::Bytes as BodyBytes;
use futures::{future::join_all, stream};
use serde_json::{json, Map, Value};
use tokio::sync::{mpsc, Notify};
use tokio::time::interval;

use crate::error::ApiError;
use crate::routes::threads;
use crate::state::AppState;

/// Byte-parity with `TOMBSTONE_MS` in `daemon/routes/dispatch.ts`.
const TOMBSTONE: Duration = Duration::from_secs(60);

/// How often the dispatch SSE task probes for a vanished client during a
/// harness that's gone quiet (no chunks to relay). Same cadence as
/// `routes/events.rs`'s `HEARTBEAT_INTERVAL`, reused here for consistency
/// rather than inventing a second magic number. WHY THIS EXISTS: the
/// `client_gone` detection on the main event loop (see the task's own doc
/// comment above) only fires the NEXT time this task attempts a `tx.send`
/// — for a harness that's actively streaming, that's essentially
/// immediate, but for one that goes silent for a while (a long tool call
/// with no interim output, or the pathological `SCENARIO:hang` fixture),
/// nothing would ever attempt another send, so a vanished client would
/// never be discovered and its harness process would run — or sit
/// blocked on a full stdout pipe — forever. Verified empirically: WITHOUT
/// this heartbeat, killing the SSE client mid-`SCENARIO:hang` left the
/// spawned stub process alive and the `Run` row stuck at
/// `status:"running"` indefinitely, even with the send-failure-triggered
/// cancel in place. This tick forces a write attempt on a cadence, which
/// is how a otherwise write-only HTTP/1.1 response stream discovers a
/// vanished reader without one — the daemon's TS equivalent gets this
/// for free from `ReadableStream`'s `cancel()` callback firing on its own
/// the instant the consumer disconnects; axum/hyper has no analogous
/// push notification reachable from a handler, so this is the standard
/// SSE stand-in (matches this crate's OWN `/_sandbox/events` precedent).
const DISPATCH_HEARTBEAT: Duration = Duration::from_secs(15);

static TOMBSTONES: OnceLock<Mutex<HashMap<String, Instant>>> = OnceLock::new();

fn tombstones() -> &'static Mutex<HashMap<String, Instant>> {
    TOMBSTONES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn tombstones_lock() -> std::sync::MutexGuard<'static, HashMap<String, Instant>> {
    match tombstones().lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    }
}

/// `true` (and consumes the entry, mirroring the daemon's opportunistic
/// cleanup of an expired tombstone) if `run_id` was cancelled within the
/// last `TOMBSTONE` window.
fn is_tombstoned(run_id: &str) -> bool {
    let mut guard = tombstones_lock();
    match guard.get(run_id) {
        Some(expiry) if *expiry > Instant::now() => true,
        Some(_) => {
            guard.remove(run_id);
            false
        }
        None => false,
    }
}

/// The one place a finished run's terminal `Run.status` is decided.
/// Extracted to a pure function so the priority order (cancelled beats
/// failed beats completed) is independently unit-testable without a real
/// harness process. `tombstoned` is an explicit `DELETE
/// /_sandbox/runs/:id`; `client_gone` is an SSE consumer that vanished
/// (mid-stream or before the first byte) — see the dispatch task's own
/// comment for why the two are treated identically here.
fn resolve_terminal_status(
    tombstoned: bool,
    client_gone: bool,
    error_message: Option<&str>,
) -> (&'static str, Option<&str>) {
    if tombstoned || client_gone {
        ("cancelled", None)
    } else if let Some(message) = error_message {
        ("failed", Some(message))
    } else {
        ("completed", None)
    }
}

/// Cancellation and completion fence for one legacy dispatch. The entry is
/// installed while shutdown admission is held, before the process begins to
/// spawn. That closes both sides of the race: shutdown either rejects the
/// request, or snapshots an entry whose cancellation request is remembered and
/// applied as soon as the harness handle exists.
struct ActiveDispatch {
    cancel_requested: AtomicBool,
    cancel_handle: Mutex<Option<harness::run::CancelHandle>>,
    stopped: AtomicBool,
    durably_finalized: AtomicBool,
    stopped_notify: Notify,
}

impl ActiveDispatch {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            cancel_requested: AtomicBool::new(false),
            cancel_handle: Mutex::new(None),
            stopped: AtomicBool::new(false),
            durably_finalized: AtomicBool::new(false),
            stopped_notify: Notify::new(),
        })
    }

    fn install(&self, handle: harness::run::CancelHandle) -> bool {
        match self.cancel_handle.lock() {
            Ok(mut slot) => *slot = Some(handle),
            Err(poisoned) => *poisoned.into_inner() = Some(handle),
        }
        self.cancel_requested.load(Ordering::SeqCst)
    }

    async fn cancel(&self) {
        self.cancel_requested.store(true, Ordering::SeqCst);
        let handle = match self.cancel_handle.lock() {
            Ok(slot) => slot.clone(),
            Err(poisoned) => poisoned.into_inner().clone(),
        };
        if let Some(handle) = handle {
            handle.cancel().await;
        }
    }

    fn mark_stopped(&self) {
        if !self.stopped.swap(true, Ordering::SeqCst) {
            self.stopped_notify.notify_waiters();
        }
    }

    async fn wait_stopped(&self) {
        loop {
            let notified = self.stopped_notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.stopped.load(Ordering::SeqCst) {
                return;
            }
            notified.await;
        }
    }
}

/// In-flight runs, keyed by `runId` — mirrors the TS daemon's module-scoped
/// `activeRuns: Map<string, AbortController>`, with an additional completion
/// fence so graceful shutdown can prove each side-effecting CLI was reaped
/// before git publish starts.
static ACTIVE_RUNS: OnceLock<Mutex<HashMap<String, Arc<ActiveDispatch>>>> = OnceLock::new();

fn active_runs() -> &'static Mutex<HashMap<String, Arc<ActiveDispatch>>> {
    ACTIVE_RUNS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn active_runs_lock() -> std::sync::MutexGuard<'static, HashMap<String, Arc<ActiveDispatch>>> {
    match active_runs().lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    }
}

fn finish_active_run(run_id: &str, active: &Arc<ActiveDispatch>, durably_finalized: bool) {
    if durably_finalized {
        active.durably_finalized.store(true, Ordering::SeqCst);
    }
    let mut runs = active_runs_lock();
    if durably_finalized
        && runs
            .get(run_id)
            .is_some_and(|current| Arc::ptr_eq(current, active))
    {
        runs.remove(run_id);
    }
    drop(runs);
    active.mark_stopped();
}

/// Makes the ordering contract executable: graceful shutdown may observe an
/// [`ActiveDispatch`] as stopped only after the caller's synchronous durable
/// finalization has returned. Keeping the fence in one helper prevents a
/// future response-writing refactor from accidentally moving `mark_stopped`
/// back in front of SQLite.
fn finish_active_run_after(
    run_id: &str,
    active: &Arc<ActiveDispatch>,
    durable_finalize: impl FnOnce() -> bool,
) {
    let durably_finalized = durable_finalize();
    // Retain a failed terminal fence in ACTIVE_RUNS. The process is stopped,
    // so waiters may wake, but shutdown must still observe the failed durable
    // boundary and skip publish. A restart can then recover the SQLite row;
    // silently forgetting this entry would let publish race an indeterminate
    // transcript/run state.
    finish_active_run(run_id, active, durably_finalized);
}

fn try_send_terminal_frames(tx: &mpsc::Sender<BodyBytes>, error_message: Option<String>) {
    if let Some(message) = error_message {
        let _ = tx.try_send(sse_data(&json!({
            "type": "error",
            "code": "harness_crashed",
            "message": message,
        })));
    }
    let _ = tx.try_send(sse_data(&json!({"type": "done"})));
}

/// Direct legacy-dispatch reap phase used by `ServerHandle::shutdown` after
/// listener/admission closure and before repository publish. Kept separate
/// from the generic hook wrapper so the top-level shutdown pipeline can impose
/// one exact phase order without spending an earlier hook's deadline budget.
pub(crate) async fn shutdown_all(budget: Duration) -> bool {
    let runs: Vec<Arc<ActiveDispatch>> = active_runs_lock().values().cloned().collect();
    stop_active_dispatches(runs, budget).await
}

async fn stop_active_dispatches(runs: Vec<Arc<ActiveDispatch>>, budget: Duration) -> bool {
    let processes_stopped = tokio::time::timeout(budget, async {
        join_all(runs.iter().map(|run| run.cancel())).await;
        join_all(runs.iter().map(|run| run.wait_stopped())).await;
    })
    .await
    .is_ok();
    if !processes_stopped {
        tracing::error!(
            run_count = runs.len(),
            "timed out waiting for legacy dispatch harnesses during shutdown"
        );
    }
    let durably_finalized = runs
        .iter()
        .all(|run| run.durably_finalized.load(Ordering::SeqCst));
    if processes_stopped && !durably_finalized {
        tracing::error!(
            run_count = runs.len(),
            "legacy dispatch stopped without a durable terminal state"
        );
    }
    processes_stopped && durably_finalized
}

/// `data: <json>\n\n` — dispatch's framing is DATA-ONLY (no `event:`
/// line), unlike `routes/events.rs`'s named-event frames. See the
/// contract's SSE framing section.
fn sse_data(value: &Value) -> BodyBytes {
    BodyBytes::from(format!(
        "data: {}\n\n",
        serde_json::to_string(value).unwrap_or_else(|_| "null".to_string())
    ))
}

pub async fn dispatch(State(state): State<AppState>, body: Bytes) -> Response {
    let parsed: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(_) => return ApiError::bad_request("bad_json").into_response(),
    };

    let harness_id_raw = match parsed.get("harnessId").and_then(Value::as_str) {
        Some(s) => s.to_string(),
        None => return ApiError::bad_request("missing_harness_id").into_response(),
    };
    let run_id = match parsed.get("runId").and_then(Value::as_str) {
        Some(s) => s.to_string(),
        None => return ApiError::bad_request("missing_run_id").into_response(),
    };

    let input = parsed.get("input").cloned().unwrap_or(Value::Null);
    if let Err(detail) = validate_harness_input(&input) {
        return ApiError::bad_input(detail).into_response();
    }

    if is_tombstoned(&run_id) {
        return ApiError::gone("tombstoned").into_response();
    }

    // Gate 7a: is `harnessId` one of the two ids desktop v1 supports?
    let Some(harness_id) = harness::HarnessId::from_wire_id(&harness_id_raw) else {
        return ApiError::bad_request_with_detail(
            "unknown_harness",
            format!("unknown harnessId: {harness_id_raw:?}"),
        )
        .into_response();
    };

    let spec = build_run_spec(harness_id, &state, &input).await;

    // Gate 7b: can we actually resolve+build a runnable argv for it? See
    // this file's module doc for why binary-unavailability shares the
    // `unknown_harness` gate rather than getting its own status.
    let argv = match harness::run::build_argv(&spec) {
        Ok(argv) => argv,
        Err(err) => {
            return ApiError::bad_request_with_detail("unknown_harness", err.to_string())
                .into_response();
        }
    };

    // Sandbox resolution above may legitimately clone/install for seconds; do
    // not make shutdown wait on it. Once that asynchronous preparation is
    // complete, admission covers the short synchronous persistence + active
    // reservation below. Shutdown can therefore make a linear decision: this
    // run is rejected, or its cancellation fence is visible to the snapshot.
    let Some(shutdown_admission) = state.shutdown.admit_work().await else {
        return ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "application is shutting down",
        )
        .into_response();
    };

    // Every gate passed — persist the thread/run/user-message BEFORE
    // opening the SSE response (still side-effect-free from the CALLER's
    // point of view: a storage failure here is a genuine local-api bug,
    // `ApiError::internal`, not a different dispatch outcome). See this
    // file's module doc's "Thread-store persistence" section.
    let thread_id = input
        .get("threadId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let db = match threads::shared_db(&state) {
        Ok(db) => db,
        Err(err) => return err.into_response(),
    };
    if let Err(err) = db.create_thread_with_id(&thread_id, "") {
        return threads::db_err(err).into_response();
    }
    if let Err(err) = db.create_run(&run_id, &thread_id, harness_id.wire_id()) {
        return threads::db_err(err).into_response();
    }
    let user_parts = input
        .get("userMessage")
        .and_then(|m| m.get("parts"))
        .cloned()
        .unwrap_or_else(|| json!([{"type": "text", "text": spec.prompt}]));
    if let Err(err) = db.create_message_with_id(
        &format!("run-{run_id}-user"),
        &thread_id,
        "user",
        &user_parts,
    ) {
        return threads::db_err(err).into_response();
    }

    let active = ActiveDispatch::new();
    {
        let mut runs = active_runs_lock();
        if runs.contains_key(&run_id) {
            return ApiError::conflict("run is already active").into_response();
        }
        runs.insert(run_id.clone(), active.clone());
    }
    drop(shutdown_admission);

    let mut handle = harness::run::start_with_child_lifetime_lock(
        argv,
        &spec,
        state.tasks.child_lifetime_lock_path().to_path_buf(),
    )
    .await;
    if active.install(handle.cancel_handle()) {
        // Shutdown/cancel won while the harness drive task was being created.
        // The remembered request is applied before a single event is consumed.
        handle.cancel().await;
    }

    let (tx, out_rx) = mpsc::channel::<BodyBytes>(64);
    tokio::spawn(async move {
        // Leading SSE comment so a slow-to-connect consumer can
        // distinguish "accepted, streaming" from "never got a response" —
        // byte-parity with the daemon's `DISPATCH_ACCEPTED_SSE_COMMENT`.
        //
        // `client_gone` tracks byte-parity with the daemon's
        // `ReadableStream` `cancel()` callback (`ctrl.abort()` in
        // `packages/sandbox/daemon/routes/dispatch.ts`, which reaches the
        // real harness's `AbortSignal` and kills its spawned process): an
        // SSE consumer that vanishes — mid-stream, OR before even the
        // first byte, e.g. a browser tab closed the instant a fetch was
        // issued — must abort the harness run the SAME way an explicit
        // `DELETE /_sandbox/runs/:id` does. Without this, a disconnected
        // client leaves its harness process running (or, once its stdout
        // pipe's OS buffer fills with nobody draining it, BLOCKED
        // indefinitely on a write no one will ever read) with no way left
        // to reach it — `active_runs` is cleared for this `run_id` below,
        // so a later cancel request couldn't find it either, and the run
        // row would otherwise sit at `status:"running"` forever.
        let mut client_gone = tx
            .send(BodyBytes::from_static(b": dispatch accepted\n\n"))
            .await
            .is_err();
        if client_gone {
            handle.cancel().await;
        }

        let mut accumulator = harness::parts::PartsAccumulator::new();
        let mut error_message: Option<String> = None;
        // See `DISPATCH_HEARTBEAT`'s doc comment: a harness that goes
        // quiet (no chunks to relay) would otherwise give this task no
        // opportunity to attempt a `tx.send` and so no way to ever notice
        // a vanished client — this tick forces that opportunity on a
        // cadence, same pattern as `routes/events.rs`.
        let mut heartbeat = interval(DISPATCH_HEARTBEAT);
        heartbeat.tick().await; // first tick fires immediately — consume it
        loop {
            tokio::select! {
                event = handle.recv() => {
                    match event {
                        Some(harness::run::RunEvent::SessionId { .. }) => {
                            // The daemon-parity dispatch surface has no durable
                            // thread queue. Its accumulator reads the same id
                            // from `RunHandle` at terminal completion.
                        }
                        Some(harness::run::RunEvent::Chunk(chunk)) => {
                            accumulator.feed(&chunk);
                            if !client_gone {
                                let frame =
                                    sse_data(&json!({"type": "ui-message-chunk", "chunk": chunk}));
                                if tx.send(frame).await.is_err() {
                                    client_gone = true;
                                    handle.cancel().await;
                                }
                            }
                        }
                        Some(harness::run::RunEvent::FatalError { message }) => {
                            error_message = Some(message.clone());
                            // Treat the fatal frame as terminal even if a buggy
                            // CLI writes it and then hangs. The run must be
                            // cancelled and fully reaped before its active slot
                            // disappears; otherwise a retry can overlap the old
                            // side-effecting process group for the TERM grace
                            // period.
                            handle.cancel().await;
                            while handle.recv().await.is_some() {}
                            break;
                        }
                        None => break,
                    }
                }
                _ = heartbeat.tick(), if !client_gone => {
                    // Nothing to relay right now — proactively probe
                    // whether the client is still there instead of
                    // waiting for the next real event, which for a quiet
                    // harness might be a long time (or, `SCENARIO:hang`,
                    // never).
                    if tx
                        .send(BodyBytes::from_static(b": keep-alive\n\n"))
                        .await
                        .is_err()
                    {
                        client_gone = true;
                        handle.cancel().await;
                    }
                }
            }
        }
        // Terminal status: an explicit cancel (DELETE /_sandbox/runs/:id)
        // always writes a tombstone (see `cancel_run` below); an implicit
        // client-disconnect cancel (`client_gone`, above) doesn't write
        // one but means the exact same thing for status purposes — both
        // resolve to "cancelled", taking priority over a crash that might
        // race in right as/after the disconnect is detected (the crash
        // reflects our own teardown, not a genuine failure the — already
        // gone — caller needs to know about).
        let session_id = handle.session_id().await;
        let assistant_parts =
            accumulator.finish(session_id.as_deref().map(|sid| (harness_id.wire_id(), sid)));
        let (status, error) = resolve_terminal_status(
            is_tombstoned(&run_id),
            client_gone,
            error_message.as_deref(),
        );
        finish_active_run_after(&run_id, &active, || {
            let mut durably_finalized = true;
            if !assistant_parts.is_empty() {
                if let Err(err) = db.create_message_with_id(
                    &format!("run-{run_id}-assistant"),
                    &thread_id,
                    "assistant",
                    &Value::Array(assistant_parts),
                ) {
                    tracing::error!(
                        run_id,
                        error = %err,
                        "failed to durably persist legacy dispatch assistant message"
                    );
                    durably_finalized = false;
                }
            }
            if let Err(err) = db.set_run_terminal_status(&run_id, status, error) {
                tracing::error!(
                    run_id,
                    error = %err,
                    "failed to durably finalize legacy dispatch run status"
                );
                durably_finalized = false;
            }
            durably_finalized
        });

        // `recv() == None` above is the process-reap fence, but shutdown does
        // not observe this dispatch as stopped until `finish_active_run_after`
        // has attempted both durable writes. In particular, never put the
        // bounded SSE channel send in front of SQLite finalization: a slow or
        // vanished response consumer is allowed to lose the final `done`
        // frame, but it must never leave a successfully-reaped run stuck at
        // `status:"running"` or hide its assistant message from the next boot.
        if !client_gone {
            // Terminal response delivery is deliberately non-blocking. A
            // half-open consumer can saturate this bounded channel forever;
            // process reap and durable finalization above must never depend on
            // it. Healthy consumers continuously drain and still receive the
            // pinned `error` -> `done` order.
            try_send_terminal_frames(&tx, error_message);
        }
    });

    let body_stream = stream::unfold(out_rx, |mut rx| async move {
        rx.recv()
            .await
            .map(|frame| (Ok::<_, Infallible>(frame), rx))
    });

    let mut response = Response::new(Body::from_stream(body_stream));
    *response.status_mut() = StatusCode::OK;
    for (name, value) in crate::http_util::dispatch_sse_headers() {
        response.headers_mut().insert(name, value);
    }
    response
}

/// Builds the [`harness::run::RunSpec`] from a validated `input` envelope.
///
/// `cwd` used to ALWAYS be `state.repo_dir` — desktop's `workspace.cwd`
/// symbolic contract (`null` vs `"/repo"`) collapsed to one physical
/// directory because nothing drove a per-branch workdir yet. Per
/// the native Git-sandbox contract, a `workspace.cwd: "/repo"` run
/// now resolves to its OWN per-`(virtualMcpId, branch)` sandbox workdir via
/// [`crate::sandbox::SandboxManager::ensure`] — see [`resolve_dispatch_cwd`].
/// `workspace.cwd: null` (the non-git-backed, "just an already-checked-out
/// folder" case) is UNCHANGED: still `state.repo_dir`.
async fn build_run_spec(
    harness_id: harness::HarnessId,
    state: &AppState,
    input: &Value,
) -> harness::run::RunSpec {
    let user_message = input.get("userMessage").cloned().unwrap_or(Value::Null);
    let prompt = harness::run::extract_user_text(&user_message);
    let resume_session_id = input
        .pointer("/harness/sessionId")
        .and_then(Value::as_str)
        .map(str::to_string);
    let model_id = input
        .pointer("/models/thinking/id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let tool_approval = harness::run::ToolApproval::from_wire(
        input
            .get("toolApprovalLevel")
            .and_then(Value::as_str)
            .unwrap_or("auto"),
    );
    let plan_mode = input.get("mode").and_then(Value::as_str) == Some("plan");
    let cwd = resolve_dispatch_cwd(state, input).await;

    harness::run::RunSpec {
        // Daemon-parity route: no org-filesystem block and no agent MCP (the
        // desktop chat path in `intercept/decopilot.rs` injects both).
        append_system_prompt: None,
        mcp: None,
        harness: harness_id,
        cwd: Some(cwd),
        prompt,
        resume_session_id,
        model_id,
        tool_approval,
        plan_mode,
    }
}

/// `state.repo_dir` for a non-git-backed run, else a per-handle
/// [`crate::sandbox::Sandbox::workdir`] — ensured (cloned/checked-out) FIRST
/// via [`crate::sandbox::SandboxManager::ensure`]. A git-backed run whose
/// sandbox can't be ensured (bad repo/branch, offline, ...) still resolves to
/// its OWN `<app_root>/sandboxes/<handle>/repo`, never the shared
/// `state.repo_dir` — see [`crate::sandbox::SandboxManager::workdir_for`] for
/// why sharing that directory across threads is unsafe. The dispatch is not
/// failed outright: this route's gate order/error envelope is contract-pinned
/// (see this file's module doc) and a clone failure is already independently
/// observable via the sandbox's own `SetupOrchestrator` lifecycle
/// (`clone-failed`), so widening the gate list here would cost byte-parity for
/// no real gain.
async fn resolve_dispatch_cwd(state: &AppState, input: &Value) -> PathBuf {
    let Some(git_cfg) = git_sandbox_config_from_workspace(input) else {
        return state.repo_dir.clone();
    };
    match state.sandbox_manager.ensure(&git_cfg).await {
        Ok(sandbox) => sandbox.workdir.clone(),
        Err(err) => {
            let workdir = state.sandbox_manager.workdir_for(&git_cfg);
            tracing::warn!(
                error = %err,
                workdir = %workdir.display(),
                "git sandbox ensure failed for /_sandbox/dispatch; staying in the sandbox workdir"
            );
            let _ = tokio::fs::create_dir_all(&workdir).await;
            workdir
        }
    }
}

/// `None` for `workspace.cwd: null` (not git-backed) or a `workspace` shape
/// [`validate_harness_input`] already rejected upstream of this call.
/// `virtualMcpId` is `input.agent.id` (validated present/string by
/// [`validate_harness_input`]'s `agent.id` check). `cloneUrl`: prefers
/// `workspace.repo.cloneUrl` when present — a local-api-only field over the
/// real `harnessStreamInputSchema` shape (tolerated: this file's own module
/// doc notes `.strict()` isn't enforced), used by this crate's e2e suite to
/// point at a `file://` fixture repo — else derived from `owner`/`name` as
/// a plain `https://github.com/<owner>/<name>.git` (cloned via the user's
/// own ambient git auth, never a minted token — see `setup/clone.rs`'s
/// `base_argv` doc comment for why).
fn git_sandbox_config_from_workspace(input: &Value) -> Option<crate::sandbox::GitSandboxConfig> {
    let workspace = input.get("workspace")?;
    if workspace.get("cwd").and_then(Value::as_str) != Some("/repo") {
        return None;
    }
    let repo = workspace.get("repo")?;
    let clone_url = repo
        .get("cloneUrl")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| {
            let owner = repo.get("owner").and_then(Value::as_str)?;
            let name = repo.get("name").and_then(Value::as_str)?;
            Some(format!("https://github.com/{owner}/{name}.git"))
        })?;
    let virtual_mcp_id = input
        .pointer("/agent/id")
        .and_then(Value::as_str)?
        .to_string();
    let branch = workspace
        .get("branch")
        .and_then(Value::as_str)
        .map(str::to_string);
    Some(crate::sandbox::GitSandboxConfig {
        virtual_mcp_id,
        clone_url,
        branch,
        ..Default::default()
    })
}

#[expect(
    clippy::arithmetic_side_effects,
    reason = "deadline math: `Instant`/`OffsetDateTime` plus a bounded \
              constant. `checked_add` has no honest fallback here — there \
              is no `Instant::MAX` to saturate to, so the call site would \
              have to invent a deadline. Overflow is ~584 years out."
)]
pub async fn cancel_run(State(_state): State<AppState>, Path(run_id): Path<String>) -> StatusCode {
    // Idempotent by construction: unconditionally (re-)writes the
    // tombstone and returns 204 whether or not `run_id` was ever an active
    // dispatch — byte-parity with `handleCancelRequest` in
    // `daemon/routes/dispatch.ts`.
    // Scoped so the `MutexGuard` (a `!Send` type) is UNAMBIGUOUSLY
    // dropped before the `.await` below — an explicit `drop(guard)` call
    // at the end of this block is not always enough for the compiler's
    // future-`Send` analysis to prove the guard doesn't span the await;
    // a real block scope is.
    {
        let mut guard = tombstones_lock();
        let now = Instant::now();
        guard.insert(run_id.clone(), now + TOMBSTONE);
        // Opportunistic sweep so this map can't grow unbounded over a
        // long process lifetime (a desktop app can run for days).
        guard.retain(|_, expiry| *expiry > now);
    }

    // Phase 2: actually reach the live harness process (if any) and kill
    // its process group — the tombstone above only prevents a FUTURE
    // dispatch of this runId; this is what stops the CURRENTLY running
    // one. Best-effort: `run_id` not being in the map just means the run
    // already finished (or never started), exactly like the TS daemon's
    // `activeRuns.get(runId)` returning `undefined`.
    let active = active_runs_lock().get(&run_id).cloned();
    if let Some(active) = active {
        active.cancel().await;
    }

    StatusCode::NO_CONTENT
}

/// See this file's module doc for exactly what this does and doesn't
/// check. Returns `Err(detail)` (a human-readable summary of every
/// missing/mistyped field, NOT a byte-parity Zod message) on failure.
fn validate_harness_input(input: &Value) -> Result<(), String> {
    let obj = match input.as_object() {
        Some(o) => o,
        None => return Err("input must be an object".to_string()),
    };

    let mut missing: Vec<&'static str> = Vec::new();
    let is_str = |o: &Map<String, Value>, k: &str| matches!(o.get(k), Some(Value::String(_)));
    let is_obj = |o: &Map<String, Value>, k: &str| matches!(o.get(k), Some(Value::Object(_)));

    if !is_str(obj, "threadId") {
        missing.push("threadId");
    }
    if !is_obj(obj, "userMessage") {
        missing.push("userMessage");
    }
    match obj.get("harness") {
        Some(Value::Object(h)) => {
            if let Some(sid) = h.get("sessionId") {
                if !sid.is_string() {
                    missing.push("harness.sessionId");
                }
            }
        }
        _ => missing.push("harness"),
    }
    validate_workspace(obj, &mut missing);
    validate_models(obj, &mut missing);
    validate_mcp(obj, &mut missing);

    let mode_ok = matches!(
        obj.get("mode").and_then(Value::as_str),
        Some("default" | "plan" | "web-search" | "gen-image")
    );
    if !mode_ok {
        missing.push("mode");
    }
    if !matches!(obj.get("temperature"), Some(Value::Number(_))) {
        missing.push("temperature");
    }
    let tal_ok = matches!(
        obj.get("toolApprovalLevel").and_then(Value::as_str),
        Some("auto" | "readonly")
    );
    if !tal_ok {
        missing.push("toolApprovalLevel");
    }
    match obj.get("user") {
        Some(Value::Object(u)) => {
            if !is_str(u, "id") {
                missing.push("user.id");
            }
            if !is_str(u, "email") {
                missing.push("user.email");
            }
        }
        _ => missing.push("user"),
    }
    if !is_str(obj, "organizationId") {
        missing.push("organizationId");
    }
    match obj.get("agent") {
        Some(Value::Object(a)) => {
            if !is_str(a, "id") {
                missing.push("agent.id");
            }
        }
        _ => missing.push("agent"),
    }

    if missing.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "invalid harness input: missing/invalid field(s): {}",
            missing.join(", ")
        ))
    }
}

fn validate_workspace(obj: &Map<String, Value>, missing: &mut Vec<&'static str>) {
    let Some(Value::Object(w)) = obj.get("workspace") else {
        missing.push("workspace");
        return;
    };
    match w.get("cwd") {
        Some(Value::Null) => {}
        Some(Value::String(s)) if s == "/repo" => {
            match w.get("repo") {
                Some(Value::Object(r)) => {
                    if !matches!(r.get("owner"), Some(Value::String(_))) {
                        missing.push("workspace.repo.owner");
                    }
                    if !matches!(r.get("name"), Some(Value::String(_))) {
                        missing.push("workspace.repo.name");
                    }
                    if !matches!(r.get("connectedGithub"), Some(Value::Bool(_))) {
                        missing.push("workspace.repo.connectedGithub");
                    }
                }
                _ => missing.push("workspace.repo"),
            }
            if !matches!(w.get("branch"), Some(Value::String(_)) | Some(Value::Null)) {
                missing.push("workspace.branch");
            }
        }
        _ => missing.push("workspace.cwd"),
    }
}

fn validate_models(obj: &Map<String, Value>, missing: &mut Vec<&'static str>) {
    let Some(Value::Object(m)) = obj.get("models") else {
        missing.push("models");
        return;
    };
    match m.get("thinking") {
        Some(Value::Object(t)) => {
            if !matches!(t.get("id"), Some(Value::String(_))) {
                missing.push("models.thinking.id");
            }
            if !matches!(t.get("title"), Some(Value::String(_))) {
                missing.push("models.thinking.title");
            }
            if !matches!(t.get("credentialId"), Some(Value::String(_))) {
                missing.push("models.thinking.credentialId");
            }
        }
        _ => missing.push("models.thinking"),
    }
}

fn validate_mcp(obj: &Map<String, Value>, missing: &mut Vec<&'static str>) {
    let Some(Value::Object(m)) = obj.get("mcp") else {
        missing.push("mcp");
        return;
    };
    if !matches!(m.get("url"), Some(Value::String(_))) {
        missing.push("mcp.url");
    }
    if !matches!(m.get("headers"), Some(Value::Object(_))) {
        missing.push("mcp.headers");
    }
    if !matches!(m.get("expiresAt"), Some(Value::Number(_))) {
        missing.push("mcp.expiresAt");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn valid_input() -> Value {
        json!({
            "threadId": "t1",
            "userMessage": {"text": "hi"},
            "harness": {},
            "workspace": {"cwd": null},
            "models": {
                "thinking": {"id": "m1", "title": "Model", "credentialId": "c1"},
            },
            "mcp": {"url": "https://example.com", "headers": {}, "expiresAt": 1},
            "mode": "default",
            "temperature": 0.5,
            "toolApprovalLevel": "auto",
            "user": {"id": "u1", "email": "u@example.com"},
            "organizationId": "org1",
            "agent": {"id": "a1"},
        })
    }

    #[test]
    fn empty_object_is_rejected() {
        assert!(validate_harness_input(&json!({})).is_err());
    }

    #[test]
    fn non_object_is_rejected() {
        assert!(validate_harness_input(&Value::Null).is_err());
        assert!(validate_harness_input(&json!("nope")).is_err());
    }

    #[test]
    fn a_fully_populated_minimal_input_is_accepted() {
        assert!(validate_harness_input(&valid_input()).is_ok());
    }

    #[test]
    fn workspace_repo_cwd_requires_repo_fields() {
        let mut v = valid_input();
        v["workspace"] = json!({"cwd": "/repo", "branch": null});
        let err = validate_harness_input(&v).unwrap_err();
        assert!(err.contains("workspace.repo"));
    }

    #[test]
    fn workspace_repo_cwd_with_full_repo_is_accepted() {
        let mut v = valid_input();
        v["workspace"] = json!({
            "cwd": "/repo",
            "repo": {"owner": "o", "name": "n", "connectedGithub": true},
            "branch": "main",
        });
        assert!(validate_harness_input(&v).is_ok());
    }

    // -- git_sandbox_config_from_workspace -----------------------------------

    #[test]
    fn null_cwd_is_not_git_backed() {
        let v = valid_input();
        assert!(git_sandbox_config_from_workspace(&v).is_none());
    }

    #[test]
    fn repo_cwd_derives_a_github_clone_url_from_owner_and_name() {
        let mut v = valid_input();
        v["workspace"] = json!({
            "cwd": "/repo",
            "repo": {"owner": "acme", "name": "widgets", "connectedGithub": true},
            "branch": "feature-x",
        });
        let cfg = git_sandbox_config_from_workspace(&v).expect("git-backed");
        assert_eq!(cfg.virtual_mcp_id, "a1");
        assert_eq!(cfg.clone_url, "https://github.com/acme/widgets.git");
        assert_eq!(cfg.branch.as_deref(), Some("feature-x"));
    }

    #[test]
    fn repo_cwd_prefers_an_explicit_clone_url_over_owner_name() {
        // Local-api-only escape hatch (see this function's doc comment) —
        // used by this crate's own e2e suite to point at a `file://` fixture
        // repo, since a real GitHub owner/name pair can't reach one.
        let mut v = valid_input();
        v["workspace"] = json!({
            "cwd": "/repo",
            "repo": {
                "owner": "acme",
                "name": "widgets",
                "connectedGithub": false,
                "cloneUrl": "/tmp/fixture-repo.git",
            },
            "branch": "main",
        });
        let cfg = git_sandbox_config_from_workspace(&v).expect("git-backed");
        assert_eq!(cfg.clone_url, "/tmp/fixture-repo.git");
    }

    #[test]
    fn repo_cwd_with_null_branch_omits_branch() {
        let mut v = valid_input();
        v["workspace"] = json!({
            "cwd": "/repo",
            "repo": {"owner": "acme", "name": "widgets", "connectedGithub": true},
            "branch": null,
        });
        let cfg = git_sandbox_config_from_workspace(&v).expect("git-backed");
        assert!(cfg.branch.is_none());
    }

    #[test]
    fn bad_mode_is_rejected() {
        let mut v = valid_input();
        v["mode"] = json!("not-a-mode");
        assert!(validate_harness_input(&v).is_err());
    }

    #[test]
    fn tombstone_marks_run_as_gone_then_expires() {
        let run_id = "test-run-tombstone-marks";
        assert!(!is_tombstoned(run_id));
        tombstones_lock().insert(
            run_id.to_string(),
            Instant::now() + Duration::from_millis(50),
        );
        assert!(is_tombstoned(run_id));
        std::thread::sleep(Duration::from_millis(80));
        assert!(!is_tombstoned(run_id));
    }

    // -- resolve_terminal_status: priority order -----------------------

    #[test]
    fn clean_finish_with_no_tombstone_or_disconnect_is_completed() {
        assert_eq!(
            resolve_terminal_status(false, false, None),
            ("completed", None)
        );
    }

    #[test]
    fn a_fatal_error_with_no_tombstone_or_disconnect_is_failed() {
        assert_eq!(
            resolve_terminal_status(false, false, Some("boom")),
            ("failed", Some("boom"))
        );
    }

    #[test]
    fn explicit_tombstone_is_cancelled_even_with_an_error_message() {
        // A DELETE /_sandbox/runs/:id landing right as the harness also
        // crashed (e.g. from the SIGTERM cancel() sent) must still read as
        // an intentional cancel, not a failure.
        assert_eq!(
            resolve_terminal_status(true, false, Some("killed")),
            ("cancelled", None)
        );
    }

    #[test]
    fn client_disconnect_is_cancelled_even_with_an_error_message() {
        // Same priority for the OTHER cancel path (SSE consumer vanished
        // without ever calling DELETE) — see the dispatch task's
        // `client_gone` doc comment: byte-parity with the daemon's
        // ReadableStream `cancel()` -> `ctrl.abort()`.
        assert_eq!(
            resolve_terminal_status(false, true, Some("exited with code 143")),
            ("cancelled", None)
        );
    }

    #[test]
    fn both_tombstoned_and_client_gone_is_still_just_cancelled() {
        assert_eq!(
            resolve_terminal_status(true, true, Some("whatever")),
            ("cancelled", None)
        );
    }

    #[test]
    fn active_dispatch_is_stopped_only_after_durable_finalization_returns() {
        let run_id = "dispatch-finalization-order";
        let active = ActiveDispatch::new();
        active_runs_lock().insert(run_id.to_string(), active.clone());
        let persisted = Arc::new(AtomicBool::new(false));
        let inside = persisted.clone();

        finish_active_run_after(run_id, &active, || {
            assert!(
                !active.stopped.load(Ordering::SeqCst),
                "shutdown fence released before durable writes"
            );
            inside.store(true, Ordering::SeqCst);
            true
        });

        assert!(persisted.load(Ordering::SeqCst));
        assert!(active.stopped.load(Ordering::SeqCst));
        assert!(active.durably_finalized.load(Ordering::SeqCst));
        assert!(!active_runs_lock().contains_key(run_id));
    }

    #[tokio::test]
    async fn terminal_persistence_failure_remains_visible_to_the_publish_gate() {
        let run_id = "dispatch-finalization-failed";
        let active = ActiveDispatch::new();
        active_runs_lock().insert(run_id.to_string(), active.clone());

        finish_active_run_after(run_id, &active, || false);

        assert!(active.stopped.load(Ordering::SeqCst));
        assert!(!active.durably_finalized.load(Ordering::SeqCst));
        assert!(active_runs_lock().contains_key(run_id));
        assert!(
            !stop_active_dispatches(vec![active.clone()], Duration::from_millis(5)).await,
            "a reaped harness with an indeterminate SQLite terminal state must block publish"
        );
        active_runs_lock().remove(run_id);
    }

    #[test]
    fn saturated_response_channel_cannot_block_terminal_cleanup() {
        let (tx, mut rx) = mpsc::channel(1);
        tx.try_send(BodyBytes::from_static(b"occupied"))
            .expect("prefill response channel");

        // This is intentionally synchronous. A former `.send(...).await` in
        // the fatal path could suspend forever here and prevent process reap +
        // SQLite finalization from ever reaching their fence.
        try_send_terminal_frames(&tx, Some("boom".to_string()));
        assert_eq!(rx.try_recv().unwrap(), BodyBytes::from_static(b"occupied"));
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn healthy_terminal_channel_preserves_error_then_done_order() {
        let (tx, mut rx) = mpsc::channel(2);
        try_send_terminal_frames(&tx, Some("boom".to_string()));
        let error = String::from_utf8(rx.try_recv().unwrap().to_vec()).unwrap();
        let done = String::from_utf8(rx.try_recv().unwrap().to_vec()).unwrap();
        assert!(error.contains("\"type\":\"error\""));
        assert!(done.contains("\"type\":\"done\""));
    }

    #[tokio::test]
    async fn direct_shutdown_reports_whether_all_dispatches_stopped() {
        assert!(stop_active_dispatches(Vec::new(), Duration::from_millis(1)).await);

        let never_stopped = ActiveDispatch::new();
        assert!(
            !stop_active_dispatches(vec![never_stopped.clone()], Duration::from_millis(5)).await,
            "publish gate must see a timed-out active dispatch as unsafe"
        );
        never_stopped.mark_stopped();
    }
}
