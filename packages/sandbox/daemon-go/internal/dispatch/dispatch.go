package dispatch

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/decocms/studio/sandbox-daemon/internal/activity"
	"github.com/decocms/studio/sandbox-daemon/internal/auth"
)

const tombstoneTTL = 60 * time.Second

// The dispatch endpoint always runs the sandbox's installed Claude Code runner.
const sandboxHarnessID = "claude-code"

// maxDispatchBodyBytes stops an unbounded request body from parking the pod's
// memory. Current dispatch always sends the complete input inline.
const maxDispatchBodyBytes = 32 * 1024 * 1024

// Terminal code for a run this pod could not finish (shutdown / dropped
// connection) as opposed to one that was cancelled on purpose. Studio maps it
// to `SandboxUnreachableError` and continues the turn elsewhere — the literal
// is the contract, and its TypeScript half is
// `SANDBOX_GONE_TERMINAL_CODE` in packages/sandbox/dispatch/error-codes.ts.
const sandboxGoneCode = "sandbox_gone"

// How long a takeover waits for the run it displaced to actually exit before
// starting the new one. The displaced harness holds `claude` processes writing
// into the checkout the new run is about to read, so overlapping them is how
// two agents end up editing one worktree. Variable only so the test can
// shorten it.
var takeoverTimeout = 10 * time.Second

// How long a run whose client vanished keeps running, waiting to be reattached.
//
// A Studio replica is disposable — a rollout, a KEDA scale-in or a node
// consolidation replaces it routinely — and each of those aborts the HTTP
// request this run streams into. Killing the harness there threw away whole
// turns that were minutes deep, on a sandbox pod that was never unhealthy: the
// client moved, the work did not. So a lost client detaches instead, and the
// re-dispatch that DBOS recovery sends reattaches to the SAME harness.
//
// The window only has to cover a replica coming back (pod termination grace
// plus reschedule). Past it the run is genuinely abandoned and is cancelled, so
// nothing outlives its consumer indefinitely. Variable only so the test can
// shorten it.
var detachGrace = 3 * time.Minute

// How long a run that FINISHED while detached is kept so the reattaching
// dispatch can still collect its frames and terminal. Without it a run that
// completed in the gap looks to the successor like a run that never existed,
// and the turn is re-executed from the top. Variable only so the test can
// shorten it.
var finishedRetention = 2 * time.Minute

// Ceiling on frames buffered for a detached run. Tool results can be large and
// this memory sits in the pod, so overflow gives up and cancels rather than
// growing without bound — the run is then lost exactly as it would have been
// before reattach existed, which is the honest fallback.
const maxPendingBytes = 32 * 1024 * 1024

// How often a quiet dispatch writes a keepalive byte. A run's whole output only
// exists at its end, so a long tool call or a slow model puts zero bytes on the
// wire for minutes; Studio's fetch then dies on the transport's idle timeout and
// the run surfaces as a bare "operation timed out" with nothing in the log to
// attribute it. Variable only so the test can shorten it.
var dispatchHeartbeat = 15 * time.Second

type Deps struct {
	DaemonToken func() string
	AppRoot     string
	// HarnessRunnerCmd is the argv the harness runs as, one process per run
	// (HARNESS_RUNNER_CMD env). Empty → every dispatch fails with
	// unknown_harness.
	HarnessRunnerCmd []string
	// RunEnv is the tenant environment handed to the harness for one run — the
	// model credential lives here. Read per dispatch, so a rotated credential
	// takes effect on the next run instead of the next pod. Optional; nil means
	// the harness sees only the daemon's own environment.
	//
	// ⚠️ SECURITY: the result holds a credential. Never log it.
	RunEnv func() map[string]string
	// BeforeRun prepares the workspace before the harness streams: org-fs links
	// repointed at this run's thread, the thread's saved agent session restored,
	// `.deco/tools/` refreshed.
	//
	// MAY BLOCK, and the caller does — a run that starts before the org's content
	// is in place produces a confident wrong answer rather than an error, so
	// waiting is the safer failure. It must bound its own wait (Studio's dispatch
	// has no separate readiness deadline to fall back on) and it must never fail
	// the run: at its ceiling it proceeds without. Optional.
	BeforeRun func(RunInfo)
	// AfterRun settles the workspace once the harness has exited, however it
	// exited (success, crash, cancel): whatever must outlive the pod — stray
	// skills, the agent's session transcript — gets moved to where it does. Same
	// contract as BeforeRun, and likewise bounded: it must not fail the run.
	// Optional.
	AfterRun func(RunInfo)
}

// RunInfo is what the daemon needs from a dispatched run's input to prepare the
// workspace. Extracted once so every harness receives the same preparation.
type RunInfo struct {
	ThreadId string
	// Mcp is the run's Virtual MCP endpoint; zero URL when the run carries none.
	McpURL       string
	McpHeaders   map[string]string
	McpExpiresAt int64
}

// activeRun is one in-flight run. It owns the harness, not the HTTP handler
// that started it: `done` closes when the harness goroutine exits, which is
// what makes a takeover safe (a replacement must not exec until the displaced
// process group is gone) and what a reattaching dispatch waits on.
//
// `sink` is the response body currently carrying the run's frames, or nil when
// no client is attached. While detached the frames queue in `pending` and are
// replayed to whoever attaches next.
type activeRun struct {
	ctx    context.Context
	cancel context.CancelFunc
	done   chan struct{}

	mu       sync.Mutex
	sink     *bodyWriter
	detached bool
	pending  [][]byte
	pendingN int
	finished bool
	reaper   *time.Timer
}

// emit delivers one frame to the attached client, or queues it when none is.
// Returns false only when the run must stop: the buffer is full and there is
// nobody to drain it.
func (a *activeRun) emit(frame []byte) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.sink != nil {
		if a.sink.write(frame) {
			return true
		}
		// The write failed, so this client is gone. Detaching rather than
		// ending the run is the whole point: its replacement is on the way.
		a.detachLocked()
	}
	if a.pendingN+len(frame) > maxPendingBytes {
		slog.Error("dispatch buffer full for detached run; cancelling",
			"harness", sandboxHarnessID, "pending_bytes", a.pendingN)
		return false
	}
	a.pending = append(a.pending, frame)
	a.pendingN += len(frame)
	return true
}

// keepaliveTo writes the idle byte only when a client is attached. A keepalive
// exists to hold a connection open, so buffering one for a client that is not
// there would spend the pending budget on padding.
func (a *activeRun) keepaliveTo() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.sink == nil {
		return true
	}
	if !a.sink.write([]byte("\n")) {
		a.detachLocked()
	}
	return true
}

// attach makes `body` this run's client: everything buffered is replayed first,
// in order, then live frames follow. Returns false when the run is already over
// and the replay was all there is — the caller then just returns.
func (a *activeRun) attach(body *bodyWriter) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	for _, frame := range a.pending {
		if !body.write(frame) {
			return false
		}
	}
	a.pending, a.pendingN = nil, 0
	if a.finished {
		return false
	}
	a.sink = body
	a.detached = false
	if a.reaper != nil {
		a.reaper.Stop()
		a.reaper = nil
	}
	return true
}

// detach releases `body` if it is still the attached sink. Called by the
// handler before it returns, because net/http forbids writing to a
// ResponseWriter once that happens — after this the harness buffers instead.
func (a *activeRun) detach(body *bodyWriter) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.sink == body {
		a.detachLocked()
	}
}

func (a *activeRun) detachLocked() {
	a.sink = nil
	a.detached = true
	if a.reaper == nil {
		// Nobody came back for it: this is where an abandoned run is finally
		// stopped, so a detached harness cannot outlive its consumer forever.
		a.reaper = time.AfterFunc(detachGrace, func() {
			slog.Info("dispatch detach grace expired; cancelling run",
				"harness", sandboxHarnessID, "grace_s", int(detachGrace.Seconds()))
			a.cancel()
		})
	}
}

// isDetached reports whether this run HAD a client and lost it — the only
// state a new dispatch may reattach to. A run that has not been attached yet is
// not detached: a second dispatch arriving then is a genuine double-dispatch and
// must take it over, not adopt it.
func (a *activeRun) isDetached() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.detached
}

// markFinished freezes the run: no more frames, and any client attaching later
// gets the replay and nothing else.
func (a *activeRun) markFinished() {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.finished = true
	a.sink = nil
	a.detached = false
	if a.reaper != nil {
		a.reaper.Stop()
		a.reaper = nil
	}
}

func (a *activeRun) hasPending() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return len(a.pending) > 0
}

type Registry struct {
	mu         sync.Mutex
	activeRuns map[string]*activeRun
	// finishedRuns holds runs that completed with nobody attached, so the
	// dispatch that arrives just after can still collect the result instead of
	// re-running the turn. Cleared by a timer, never by size.
	finishedRuns map[string]*activeRun
	tombstones   map[string]time.Time
}

func NewRegistry() *Registry {
	return &Registry{
		activeRuns:   map[string]*activeRun{},
		finishedRuns: map[string]*activeRun{},
		tombstones:   map[string]time.Time{},
	}
}

func (reg *Registry) tombstoned(runId string) bool {
	reg.mu.Lock()
	defer reg.mu.Unlock()
	expiry, ok := reg.tombstones[runId]
	if !ok {
		return false
	}
	if time.Now().Before(expiry) {
		return true
	}
	delete(reg.tombstones, runId)
	return false
}

// claimOrAttach resolves what a dispatch for `runId` should do.
//
//   - no run under way          → a fresh run (`fresh` true); caller starts the harness
//   - a run whose client is gone → REATTACH to it; the harness keeps running and
//     the buffered frames replay to the new connection
//   - a run finished while detached → reattach to the corpse, which replays its
//     frames and terminal and ends
//   - a run with a live client   → takeover, as before
//
// The takeover case is the one that must stay: two live dispatches for one
// runId means a real double-dispatch, and letting both harnesses write the same
// checkout is how two agents end up editing one worktree. Studio re-dispatching
// after its own replica died is NOT that case — there is no second writer, only
// a second reader — which is exactly what reattach distinguishes.
//
// The returned wait function MUST be called before starting a harness: it blocks
// until a displaced run's handler has returned (bounded by `takeoverTimeout`).
func (reg *Registry) claimOrAttach(
	runId string,
	newCancel func() (*activeRun, context.CancelFunc),
) (entry *activeRun, fresh bool, awaitTakeover func()) {
	reg.mu.Lock()
	if done, ok := reg.finishedRuns[runId]; ok {
		reg.mu.Unlock()
		return done, false, func() {}
	}
	prev := reg.activeRuns[runId]
	if prev != nil && prev.isDetached() {
		reg.mu.Unlock()
		slog.Info("dispatch reattach", "harness", sandboxHarnessID, "run_id", runId)
		return prev, false, func() {}
	}
	created, cancel := newCancel()
	created.cancel = cancel
	reg.activeRuns[runId] = created
	reg.mu.Unlock()

	if prev == nil {
		return created, true, func() {}
	}
	prev.cancel()
	return created, true, func() {
		select {
		case <-prev.done:
			slog.Info("dispatch takeover", "run_id", runId)
		case <-time.After(takeoverTimeout):
			// Starting anyway is the lesser evil: the alternative is refusing a
			// run whose thread is otherwise stuck forever. Loud, because it
			// means two harnesses may briefly share the checkout.
			slog.Error("dispatch takeover timed out; previous run may still be writing",
				"run_id", runId, "waited_s", int(takeoverTimeout.Seconds()))
		}
	}
}

// HasActiveRuns reports whether any harness run is in flight. Read by the
// daemon's autosave loop: checkpoints exist to bound a run's loss window, and an
// idle sandbox already syncs its tree on shutdown.
func (reg *Registry) HasActiveRuns() bool {
	reg.mu.Lock()
	defer reg.mu.Unlock()
	return len(reg.activeRuns) > 0
}

// CancelAll kills every in-flight run. Used on daemon shutdown: a running
// harness holds CLIs writing into the tree the shutdown publish is about to
// commit.
func (reg *Registry) CancelAll() {
	reg.mu.Lock()
	entries := make([]*activeRun, 0, len(reg.activeRuns))
	for _, entry := range reg.activeRuns {
		entries = append(entries, entry)
	}
	reg.mu.Unlock()
	for _, entry := range entries {
		entry.cancel()
	}
}

// displaced reports whether `entry` has lost the claim on `runId` to a newer
// dispatch. The same ownership test `release` makes, exposed because a cancelled
// run has to know WHICH cancel it got: its own client leaving, or a successor
// taking the run over. Only the former is the run's outcome.
func (reg *Registry) displaced(runId string, entry *activeRun) bool {
	reg.mu.Lock()
	defer reg.mu.Unlock()
	return reg.activeRuns[runId] != entry
}

// release retires this run's claim. Only clears the map when the entry is still
// the current one — a run that was taken over must not delete its successor's
// claim on the way out.
//
// A run that finished with nobody attached keeps its frames for
// `finishedRetention`: the dispatch racing in behind a replica restart then
// collects the real result, instead of finding nothing and re-running a turn
// that had already completed.
func (reg *Registry) release(runId string, entry *activeRun) {
	entry.markFinished()
	retain := entry.hasPending()
	reg.mu.Lock()
	if reg.activeRuns[runId] == entry {
		delete(reg.activeRuns, runId)
		if retain {
			reg.finishedRuns[runId] = entry
			time.AfterFunc(finishedRetention, func() {
				reg.mu.Lock()
				if reg.finishedRuns[runId] == entry {
					delete(reg.finishedRuns, runId)
				}
				reg.mu.Unlock()
			})
		}
	}
	reg.mu.Unlock()
	close(entry.done)
}

func jsonError(w http.ResponseWriter, status int, body map[string]string) {
	data, _ := json.Marshal(body)
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.WriteHeader(status)
	w.Write(data)
}

// bodyWriter serializes writes to one response body and swallows them once it
// has failed. Concurrent because the keepalive ticks while the harness runs.
type bodyWriter struct {
	mu      sync.Mutex
	w       http.ResponseWriter
	flusher http.Flusher
	failed  bool
}

func newBodyWriter(w http.ResponseWriter) *bodyWriter {
	flusher, _ := w.(http.Flusher)
	return &bodyWriter{w: w, flusher: flusher}
}

func (b *bodyWriter) write(data []byte) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.failed {
		return false
	}
	if _, err := b.w.Write(data); err != nil {
		b.failed = true
		return false
	}
	if b.flusher != nil {
		b.flusher.Flush()
	}
	return true
}

func RebaseWorkspaceCwd(cwd, appRoot string) *string {
	if cwd != "/repo" {
		return nil
	}
	root, err := filepath.Abs(appRoot)
	if err != nil {
		return nil
	}
	rebased := filepath.Join(root, "repo")
	if rebased != root && !strings.HasPrefix(rebased, root+string(filepath.Separator)) {
		return nil
	}
	return &rebased
}

func rebaseInput(input json.RawMessage, appRoot string) json.RawMessage {
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(input, &obj); err != nil {
		return input
	}
	wsRaw, ok := obj["workspace"]
	if !ok {
		return input
	}
	var ws map[string]json.RawMessage
	if err := json.Unmarshal(wsRaw, &ws); err != nil {
		return input
	}
	var cwd *string
	if raw, ok := ws["cwd"]; ok {
		json.Unmarshal(raw, &cwd)
	}
	if cwd == nil {
		return input
	}
	rebased := RebaseWorkspaceCwd(*cwd, appRoot)
	if rebased == nil {
		ws["cwd"] = json.RawMessage("null")
	} else {
		enc, _ := json.Marshal(*rebased)
		ws["cwd"] = enc
	}
	newWs, _ := json.Marshal(ws)
	obj["workspace"] = newWs
	out, _ := json.Marshal(obj)
	return out
}

func (reg *Registry) HandleDispatch(w http.ResponseWriter, r *http.Request, deps Deps) {
	if !auth.TokenOK(r, deps.DaemonToken()) {
		jsonError(w, 401, map[string]string{"error": "unauthorized"})
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxDispatchBodyBytes))
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			jsonError(w, 413, map[string]string{"error": "body_too_large"})
			return
		}
		jsonError(w, 400, map[string]string{"error": "bad_json"})
		return
	}
	var frame map[string]json.RawMessage
	if err := json.Unmarshal(body, &frame); err != nil || frame == nil {
		jsonError(w, 400, map[string]string{"error": "bad_json"})
		return
	}
	var runId string
	if raw, ok := frame["runId"]; !ok || json.Unmarshal(raw, &runId) != nil {
		jsonError(w, 400, map[string]string{"error": "missing_run_id"})
		return
	}

	input := frame["input"]
	if input == nil {
		input = json.RawMessage("null")
	}

	if reason := ValidateHarnessInput(input); reason != "" {
		jsonError(w, 400, map[string]string{"error": "bad_input", "detail": reason})
		return
	}

	if reg.tombstoned(runId) {
		jsonError(w, 410, map[string]string{"error": "tombstoned"})
		return
	}

	entry, fresh, awaitTakeover := reg.claimOrAttach(runId, func() (*activeRun, context.CancelFunc) {
		// context.Background(), NOT r.Context(): binding the harness to the
		// request meant a Studio replica going away — a rollout, a scale-in —
		// SIGKILLed the `claude` process group on a healthy sandbox pod, and
		// the turn was re-run from the top. The run is cancelled by a real
		// decision now: a takeover, a DELETE, daemon shutdown, or nobody
		// reattaching within `detachGrace`.
		ctx, cancel := context.WithCancel(context.Background())
		return &activeRun{ctx: ctx, done: make(chan struct{})}, cancel
	})
	slog.Info("dispatch received", "harness", sandboxHarnessID, "run_id", runId,
		"fresh", fresh)

	writeResultHeaders(w)
	sink := newBodyWriter(w)
	// Replay first: a reattaching client needs the frames produced while it was
	// away before it can follow the live ones. False means the replay was the
	// whole run — it had already finished — so there is nothing to wait for.
	if !entry.attach(sink) {
		return
	}
	if fresh {
		awaitTakeover()
		go reg.runHarness(entry.ctx, deps, runId, entry, rebaseInput(input, deps.AppRoot))
	}

	select {
	case <-entry.done:
	case <-r.Context().Done():
		// This client left; the run has NOT. Detach before returning — net/http
		// forbids touching the ResponseWriter afterwards — and the harness
		// buffers from here until someone reattaches.
		entry.detach(sink)
		slog.Info("dispatch client gone; run continues detached",
			"harness", sandboxHarnessID, "run_id", runId)
	}
}

// runHarness runs the harness for one run and streams its frames as this
// request's response body — newline-delimited HarnessRunResult JSON, flushed per
// frame so Studio persists the turn as it happens. Always answers 200: a crash
// is a final frame with `error`, because the partial work still has to reach the
// projector. Clears the run registry in defer.
//
// Every run ends with a `done:true` frame, whatever ended it. Studio needs that
// to tell "the run finished" from "the connection broke": the second case means
// the pod is gone mid-turn and the turn has to be continued somewhere else,
// while the first is a terminal it must report as-is.
func (reg *Registry) runHarness(
	ctx context.Context,
	deps Deps,
	runId string,
	entry *activeRun,
	input json.RawMessage,
) {
	defer reg.release(runId, entry)

	// The keepalive starts FIRST — before `BeforeRun`, not after it.
	//
	// Studio calls the pod gone after `DAEMON_SILENCE_TIMEOUT_MS` (90s) without
	// a byte, and `BeforeRun` legitimately waits on org-fs for up to its own
	// ~90s budget plus a session copy. Preparing the workspace before writing
	// anything spent that budget as silence on the wire, so a sandbox whose home
	// volume was late lost its first turn to a "the pod died" verdict and had
	// the turn continued elsewhere — on a pod that was fine. The keepalive is
	// what makes waiting for the org's content safe to do at all.
	//
	// The response headers are already written by the handler that started (or
	// reattached to) this run: the body outlives any one of them.
	startedAt := time.Now()
	stopKeepalive := startKeepalive(ctx, entry, runId)
	defer stopKeepalive()

	// Per-run workspace state, before the harness can touch the workspace.
	if deps.BeforeRun != nil {
		deps.BeforeRun(runInfoOf(input))
	}
	// Deferred, not placed after RunHarness: every terminal path below returns
	// early (crash, cancel, unavailable runner), and the run that crashed
	// halfway is exactly the one whose stray output must still be rescued.
	//
	// Registered AFTER the keepalive's defer, so it runs BEFORE it: `AfterRun`
	// copies a skill tree and a session transcript over org-fs, and Studio is
	// still reading this body until EOF with the same silence timeout that
	// governs the run itself. Settling the workspace in a keepalive-less window
	// is how a turn that already sent its terminal frame gets declared dead and
	// continued on a replacement pod.
	if deps.AfterRun != nil {
		defer deps.AfterRun(runInfoOf(input))
	}

	if len(deps.HarnessRunnerCmd) == 0 {
		entry.emit(terminalFrame("unknown_harness",
			"no harness runner configured (HARNESS_RUNNER_CMD unset)"))
		return
	}

	var runEnv map[string]string
	if deps.RunEnv != nil {
		runEnv = deps.RunEnv()
	}

	// One line per frame: without it a streaming run and a buffering one look
	// identical in the pod log (both are silence until "dispatch done"), which is
	// exactly the question you ask this log to answer.
	seq := 0
	frames, err := RunHarness(ctx, deps.HarnessRunnerCmd, input, runEnv,
		func(frame []byte) bool {
			seq++
			// A streaming run is working, so it counts as activity: the idle
			// reaper polls `/idle`, and without this a run that streams for
			// longer than the idle TTL reports as untouched since the dispatch
			// request arrived and gets its pod evicted mid-turn.
			activity.Bump()
			slog.Info("dispatch frame", "harness", sandboxHarnessID, "run_id", runId,
				"seq", seq, "bytes", len(frame),
				"elapsed_s", int(time.Since(startedAt).Seconds()))
			return entry.emit(append(frame, '\n'))
		})
	elapsed := int(time.Since(startedAt).Seconds())

	if ctx.Err() != nil {
		// A displaced run reports `superseded`, not `cancelled`: it no longer
		// owns this runId, so its cancellation is not the RUN's outcome — the
		// successor's will be. Studio reads `cancelled` as the verdict for the
		// whole turn, which is how the prod failure of 2026-08-07 happened:
		// KEDA scaled in the worker holding a run, DBOS recovered the workflow
		// onto another pod, its re-dispatch took over here, and the displaced
		// handler's `cancelled` frame settled the thread as
		// `Error: cancelled: run cancelled` while the new attempt was still
		// streaming.
		//
		// It must still be a TERMINAL (not a truncated body): an unterminated
		// body is Studio's signal to continue the turn on a replacement, and a
		// displaced attempt continuing would re-dispatch this same runId and
		// take over the successor — the two attempts would trade the run back
		// and forth. `superseded` says "stop, someone else has this."
		if reg.displaced(runId, entry) {
			slog.Info("dispatch superseded by takeover",
				"harness", sandboxHarnessID, "run_id", runId, "elapsed_s", elapsed)
			entry.emit(terminalFrame("superseded",
				"a newer dispatch took over this run"))
			return
		}
		// A DELETE stopped this run and nothing replaced it — the tombstone is
		// that request's own marker, so it is the only proof the cancel was
		// ASKED FOR. Studio spends no retry on it, which is right: a human said
		// stop.
		if reg.tombstoned(runId) {
			slog.Info("dispatch cancelled", "harness", sandboxHarnessID, "run_id", runId, "elapsed_s", elapsed)
			entry.emit(terminalFrame("cancelled", "run cancelled"))
			return
		}
		// Nobody asked. The ctx died because this daemon is going away
		// (SIGTERM → `CancelAll`, i.e. the pod was evicted or scaled in) or
		// because no client reattached within `detachGrace`. A dropped
		// connection no longer reaches here at all — that is the reattach path.
		// Reporting `cancelled` here is how a pod eviction settled a live thread
		// as `Error: cancelled: run cancelled` — a verdict Studio never retries,
		// on a turn that was mid-edit. `sandbox_gone` says the pod could not
		// finish, not that the run should not: the checkout is intact, the
		// shutdown publish pushes it to the branch, and a replacement pod can
		// pick the turn up.
		slog.Info("dispatch sandbox gone", "harness", sandboxHarnessID, "run_id", runId, "elapsed_s", elapsed)
		entry.emit(terminalFrame(sandboxGoneCode,
			"the sandbox stopped mid-run (pod shutting down or connection dropped)"))
		return
	}
	if err != nil {
		slog.Error("harness crashed", "harness", sandboxHarnessID, "run_id", runId,
			"elapsed_s", elapsed, "err", err)
		entry.emit(terminalFrame("harness_crashed", err.Error()))
		return
	}
	slog.Info("dispatch done", "harness", sandboxHarnessID, "run_id", runId,
		"elapsed_s", elapsed, "frames", frames)
	entry.emit(terminalFrame("", ""))
}

// startKeepalive writes an insignificant byte into the JSON body while the
// harness is quiet, plus a log line naming how long it has produced nothing.
// A newline before the object is whitespace to every JSON parser, so the client
// needs no framing to skip it.
//
// The returned stop JOINS the goroutine. It has to: net/http forbids writing to
// a ResponseWriter after the handler returns, and an async stop leaves a tick
// racing the handler's last write.
func startKeepalive(
	ctx context.Context,
	entry *activeRun,
	runId string,
) func() {
	ctx, cancel := context.WithCancel(ctx)
	stopped := make(chan struct{})
	go func() {
		defer close(stopped)
		ticker := time.NewTicker(dispatchHeartbeat)
		defer ticker.Stop()
		startedAt := time.Now()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if !entry.keepaliveTo() {
					return
				}
				// A quiet run is still a live run — see the frame callback's
				// note on the idle reaper.
				activity.Bump()
				slog.Info("dispatch waiting", "harness", sandboxHarnessID, "run_id", runId,
					"elapsed_s", int(time.Since(startedAt).Seconds()))
			}
		}
	}()
	return func() {
		cancel()
		<-stopped
	}
}

func writeResultHeaders(w http.ResponseWriter) {
	h := w.Header()
	h.Set("Content-Type", "application/json")
	h.Set("Cache-Control", "no-store")
	h.Set("Access-Control-Allow-Origin", "*")
	w.WriteHeader(200)
	if flusher, ok := w.(http.Flusher); ok {
		flusher.Flush()
	}
}

// terminalFrame closes a run: a HarnessRunResult carrying no chunks of its own,
// flagged `done` so the reader knows the run is over rather than the connection.
// An empty `code` is a clean finish; otherwise the frame also carries the reason
// the run ended (it may have forwarded frames before dying — those already
// reached the consumer, and the error accompanies them rather than replacing
// them).
func terminalFrame(code, message string) []byte {
	frame := map[string]any{"chunks": []any{}, "done": true}
	if code != "" {
		frame["error"] = map[string]string{"code": code, "message": message}
	}
	body, _ := json.Marshal(frame)
	return append(body, '\n')
}

var runsPathRe = regexp.MustCompile(`/runs/([^/]+)$`)

func (reg *Registry) HandleCancel(w http.ResponseWriter, r *http.Request, tokenFn func() string) {
	m := runsPathRe.FindStringSubmatch(r.URL.Path)
	if m == nil {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.WriteHeader(404)
		return
	}
	runId := m[1]
	if !auth.TokenOK(r, tokenFn()) {
		jsonError(w, 401, map[string]string{"error": "unauthorized"})
		return
	}
	reg.mu.Lock()
	if entry, ok := reg.activeRuns[runId]; ok {
		entry.cancel()
	}
	reg.tombstones[runId] = time.Now().Add(tombstoneTTL)
	reg.mu.Unlock()
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.WriteHeader(204)
}

// ParseRunnerCmd resolves HARNESS_RUNNER_CMD: a JSON array or a
// whitespace-split string.
func ParseRunnerCmd(raw string) []string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	var parsed []string
	if err := json.Unmarshal([]byte(raw), &parsed); err == nil && len(parsed) > 0 {
		return parsed
	}
	return strings.Fields(raw)
}
