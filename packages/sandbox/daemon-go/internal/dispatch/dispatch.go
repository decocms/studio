package dispatch

import (
	"context"
	"encoding/json"
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

// How long a takeover waits for the run it displaced to actually exit before
// starting the new one. The displaced harness holds `claude` processes writing
// into the checkout the new run is about to read, so overlapping them is how
// two agents end up editing one worktree. Variable only so the test can
// shorten it.
var takeoverTimeout = 10 * time.Second

// How often a quiet dispatch writes a keepalive byte. A run's whole output only
// exists at its end, so a long tool call or a slow model puts zero bytes on the
// wire for minutes; Studio's fetch then dies on the transport's idle timeout and
// the run surfaces as a bare "operation timed out" with nothing in the log to
// attribute it. Variable only so the test can shorten it.
var dispatchHeartbeat = 15 * time.Second

type Deps struct {
	DaemonToken      func() string
	AppRoot          string
	AllowedHosts     []string
	AllowSameHostDev bool
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
	// repointed at this run's thread, `.deco/tools/` refreshed. Must not block for
	// long and must not fail the run. Optional.
	BeforeRun func(RunInfo)
	// AfterRun settles the workspace once the harness has exited, however it
	// exited (success, crash, cancel): whatever the model wrote to the wrong
	// place gets moved to where it survives the pod. Same contract as BeforeRun —
	// quick, and it must not fail the run. Optional.
	AfterRun func(RunInfo)
}

// RunInfo is what the daemon needs from a dispatched run's input to prepare the
// workspace. Extracted in one place so both dispatch paths (inline input and
// offloaded messages) feed the same hook.
type RunInfo struct {
	ThreadId string
	// Mcp is the run's Virtual MCP endpoint; zero URL when the run carries none.
	McpURL       string
	McpHeaders   map[string]string
	McpExpiresAt int64
}

// activeRun is one in-flight run: the handle to stop it, plus a channel closed
// when its handler has actually returned. The channel is what makes a takeover
// safe — a replacement run must not exec its harness until the displaced one's
// process group is gone.
type activeRun struct {
	cancel context.CancelFunc
	done   chan struct{}
}

type Registry struct {
	mu         sync.Mutex
	activeRuns map[string]*activeRun
	tombstones map[string]time.Time
}

func NewRegistry() *Registry {
	return &Registry{
		activeRuns: map[string]*activeRun{},
		tombstones: map[string]time.Time{},
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

// claim makes this run the single writer for `runId`, displacing whatever run
// held it. Returns the new entry and a wait function the caller MUST call
// before starting its harness: it blocks until the displaced run's handler has
// returned (bounded by `takeoverTimeout`).
//
// Studio re-dispatches the same runId whenever the pod that owned the run died
// and another picked the work up (DBOS recovery). Registering over the old
// entry — what this used to do — dropped the old run's cancel on the floor and
// left its `claude` running in the same checkout as the new one: two agents,
// one worktree, and no way to stop the first.
func (reg *Registry) claim(runId string, cancel context.CancelFunc) (*activeRun, func()) {
	entry := &activeRun{cancel: cancel, done: make(chan struct{})}
	reg.mu.Lock()
	prev := reg.activeRuns[runId]
	reg.activeRuns[runId] = entry
	reg.mu.Unlock()
	if prev == nil {
		return entry, func() {}
	}
	prev.cancel()
	return entry, func() {
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

// release retires this run's claim. Only clears the map when the entry is still
// the current one — a run that was taken over must not delete its successor's
// claim on the way out.
func (reg *Registry) release(runId string, entry *activeRun) {
	reg.mu.Lock()
	if reg.activeRuns[runId] == entry {
		delete(reg.activeRuns, runId)
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
	body, err := io.ReadAll(r.Body)
	if err != nil {
		jsonError(w, 400, map[string]string{"error": "bad_json"})
		return
	}
	var frame map[string]json.RawMessage
	if err := json.Unmarshal(body, &frame); err != nil || frame == nil {
		jsonError(w, 400, map[string]string{"error": "bad_json"})
		return
	}
	var harnessId, runId string
	if raw, ok := frame["harnessId"]; !ok || json.Unmarshal(raw, &harnessId) != nil {
		jsonError(w, 400, map[string]string{"error": "missing_harness_id"})
		return
	}
	if raw, ok := frame["runId"]; !ok || json.Unmarshal(raw, &runId) != nil {
		jsonError(w, 400, map[string]string{"error": "missing_run_id"})
		return
	}

	input := frame["input"]
	if input == nil {
		input = json.RawMessage("null")
	}

	if ref := ParseMessagesRef(frame); ref != nil {
		reg.handleOffloadDispatch(w, r, deps, frame, ref, harnessId, runId)
		return
	}

	if reason := ValidateHarnessInput(input); reason != "" {
		jsonError(w, 400, map[string]string{"error": "bad_input", "detail": reason})
		return
	}

	if reg.tombstoned(runId) {
		jsonError(w, 410, map[string]string{"error": "tombstoned"})
		return
	}

	ctx, cancel := context.WithCancel(r.Context())
	entry, awaitTakeover := reg.claim(runId, cancel)
	slog.Info("dispatch received", "harness", harnessId, "run_id", runId)
	awaitTakeover()

	reg.runHarness(ctx, w, deps, harnessId, runId, entry, rebaseInput(input, deps.AppRoot))
}

func (reg *Registry) handleOffloadDispatch(
	w http.ResponseWriter,
	r *http.Request,
	deps Deps,
	frame map[string]json.RawMessage,
	ref *MessagesRef,
	harnessId, runId string,
) {
	messages, err := FetchOffloadedMessages(ref.URL, deps.AllowedHosts, deps.AllowSameHostDev, ref.Sha256)
	if err != nil {
		slog.Error("dispatch offload fetch failed", "harness", harnessId, "url", ref.URL, "err", err)
		jsonError(w, 400, map[string]string{"error": "offload_fetch_failed", "detail": err.Error()})
		return
	}

	var baseInput map[string]json.RawMessage
	if raw, ok := frame["input"]; ok {
		json.Unmarshal(raw, &baseInput)
	}
	if baseInput == nil {
		baseInput = map[string]json.RawMessage{}
	}
	baseInput["messages"] = messages
	merged, _ := json.Marshal(baseInput)

	if reason := ValidateHarnessInput(merged); reason != "" {
		jsonError(w, 400, map[string]string{"error": "bad_input", "detail": reason})
		return
	}

	if reg.tombstoned(runId) {
		jsonError(w, 410, map[string]string{"error": "tombstoned"})
		return
	}

	ctx, cancel := context.WithCancel(r.Context())
	entry, awaitTakeover := reg.claim(runId, cancel)
	slog.Info("dispatch received (offload)", "harness", harnessId, "run_id", runId, "bytes", ref.Bytes)
	awaitTakeover()
	reg.runHarness(ctx, w, deps, harnessId, runId, entry, rebaseInput(merged, deps.AppRoot))
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
	w http.ResponseWriter,
	deps Deps,
	harnessId, runId string,
	entry *activeRun,
	input json.RawMessage,
) {
	defer reg.release(runId, entry)

	// Per-run workspace state, before the harness can touch the workspace. Here
	// rather than in each caller so the offloaded-messages path gets it too.
	if deps.BeforeRun != nil {
		deps.BeforeRun(runInfoOf(input))
	}
	// Deferred, not placed after RunHarness: every terminal path below returns
	// early (crash, cancel, unknown harness), and the run that crashed halfway is
	// exactly the one whose stray output must still be rescued.
	if deps.AfterRun != nil {
		defer deps.AfterRun(runInfoOf(input))
	}

	if len(deps.HarnessRunnerCmd) == 0 {
		writeResult(w, terminalFrame("unknown_harness",
			"no harness runner configured (HARNESS_RUNNER_CMD unset)"))
		return
	}

	var runEnv map[string]string
	if deps.RunEnv != nil {
		runEnv = deps.RunEnv()
	}

	// Headers first, then frames as the harness produces them, with a keepalive
	// byte while it is quiet — the transport between here and Studio hangs up on
	// an idle body long before a real task finishes.
	writeResultHeaders(w)
	body := newBodyWriter(w)
	startedAt := time.Now()
	stopKeepalive := startKeepalive(ctx, body, harnessId, runId)

	// One line per frame: without it a streaming run and a buffering one look
	// identical in the pod log (both are silence until "dispatch done"), which is
	// exactly the question you ask this log to answer.
	seq := 0
	frames, err := RunHarness(ctx, deps.HarnessRunnerCmd, harnessId, input, runEnv,
		func(frame []byte) bool {
			seq++
			// A streaming run is working, so it counts as activity: the idle
			// reaper polls `/idle`, and without this a run that streams for
			// longer than the idle TTL reports as untouched since the dispatch
			// request arrived and gets its pod evicted mid-turn.
			activity.Bump()
			slog.Info("dispatch frame", "harness", harnessId, "run_id", runId,
				"seq", seq, "bytes", len(frame),
				"elapsed_s", int(time.Since(startedAt).Seconds()))
			return body.write(append(frame, '\n'))
		})
	stopKeepalive()
	elapsed := int(time.Since(startedAt).Seconds())

	if ctx.Err() != nil {
		// Cancelled: either the client hung up (its half of the terminal is
		// moot) or a DELETE/takeover stopped the run while it was still being
		// read. Terminal either way, so the reader is never left guessing.
		slog.Info("dispatch cancelled", "harness", harnessId, "run_id", runId, "elapsed_s", elapsed)
		body.write(terminalFrame("cancelled", "run cancelled"))
		return
	}
	if err != nil {
		slog.Error("harness crashed", "harness", harnessId, "run_id", runId,
			"elapsed_s", elapsed, "err", err)
		body.write(terminalFrame("harness_crashed", err.Error()))
		return
	}
	slog.Info("dispatch done", "harness", harnessId, "run_id", runId,
		"elapsed_s", elapsed, "frames", frames)
	body.write(terminalFrame("", ""))
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
	body *bodyWriter,
	harnessId, runId string,
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
				if !body.write([]byte("\n")) {
					return
				}
				// A quiet run is still a live run — see the frame callback's
				// note on the idle reaper.
				activity.Bump()
				slog.Info("dispatch waiting", "harness", harnessId, "run_id", runId,
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

// writeResult answers a dispatch that never started the harness.
func writeResult(w http.ResponseWriter, body []byte) {
	writeResultHeaders(w)
	w.Write(body)
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
