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

	"github.com/decocms/studio/sandbox-daemon/internal/auth"
)

const tombstoneTTL = 60 * time.Second

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

type Registry struct {
	mu         sync.Mutex
	activeRuns map[string]context.CancelFunc
	tombstones map[string]time.Time
}

func NewRegistry() *Registry {
	return &Registry{
		activeRuns: map[string]context.CancelFunc{},
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

func (reg *Registry) register(runId string, cancel context.CancelFunc) {
	reg.mu.Lock()
	reg.activeRuns[runId] = cancel
	reg.mu.Unlock()
}

// CancelAll kills every in-flight run. Used on daemon shutdown: a running
// harness holds CLIs writing into the tree the shutdown publish is about to
// commit.
func (reg *Registry) CancelAll() {
	reg.mu.Lock()
	cancels := make([]context.CancelFunc, 0, len(reg.activeRuns))
	for _, cancel := range reg.activeRuns {
		cancels = append(cancels, cancel)
	}
	reg.mu.Unlock()
	for _, cancel := range cancels {
		cancel()
	}
}

func (reg *Registry) unregister(runId string) {
	reg.mu.Lock()
	delete(reg.activeRuns, runId)
	reg.mu.Unlock()
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
	reg.register(runId, cancel)
	slog.Info("dispatch received", "harness", harnessId, "run_id", runId)

	reg.runHarness(ctx, w, deps, harnessId, runId, rebaseInput(input, deps.AppRoot))
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
	reg.register(runId, cancel)
	slog.Info("dispatch received (offload)", "harness", harnessId, "run_id", runId, "bytes", ref.Bytes)
	reg.runHarness(ctx, w, deps, harnessId, runId, rebaseInput(merged, deps.AppRoot))
}

// runHarness runs the harness for one run and writes its result as this
// request's JSON response. Always answers 200 with a HarnessRunResult: a crash is
// reported as `error` alongside whatever chunks the turn produced, because the
// partial work still has to reach the projector. Clears the run registry in defer.
func (reg *Registry) runHarness(
	ctx context.Context,
	w http.ResponseWriter,
	deps Deps,
	harnessId, runId string,
	input json.RawMessage,
) {
	defer reg.unregister(runId)

	// Per-run workspace state, before the harness can touch the workspace. Here
	// rather than in each caller so the offloaded-messages path gets it too.
	if deps.BeforeRun != nil {
		deps.BeforeRun(runInfoOf(input))
	}

	if len(deps.HarnessRunnerCmd) == 0 {
		writeResult(w, harnessFailure("unknown_harness",
			"no harness runner configured (HARNESS_RUNNER_CMD unset)"))
		return
	}

	var runEnv map[string]string
	if deps.RunEnv != nil {
		runEnv = deps.RunEnv()
	}

	// Headers first, then a keepalive byte while the harness works. The response
	// body only materializes at the end of the turn, and the transport between
	// here and Studio hangs up on an idle one long before a real task finishes.
	writeResultHeaders(w)
	body := newBodyWriter(w)
	startedAt := time.Now()
	stopKeepalive := startKeepalive(ctx, body, harnessId, runId)

	result, err := RunHarness(ctx, deps.HarnessRunnerCmd, harnessId, input, runEnv)
	stopKeepalive()
	elapsed := int(time.Since(startedAt).Seconds())

	if ctx.Err() != nil {
		// Cancelled: the client asked for it and is already gone.
		slog.Info("dispatch cancelled", "harness", harnessId, "run_id", runId, "elapsed_s", elapsed)
		return
	}
	if err != nil {
		slog.Error("harness crashed", "harness", harnessId, "run_id", runId,
			"elapsed_s", elapsed, "err", err)
		body.write(harnessFailure("harness_crashed", err.Error()))
		return
	}
	slog.Info("dispatch done", "harness", harnessId, "run_id", runId,
		"elapsed_s", elapsed, "bytes", len(result))
	body.write(result)
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

// harnessFailure is a HarnessRunResult for a run that produced nothing at all.
func harnessFailure(code, message string) []byte {
	body, _ := json.Marshal(map[string]any{
		"chunks": []any{},
		"error":  map[string]string{"code": code, "message": message},
	})
	return body
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
	if cancel, ok := reg.activeRuns[runId]; ok {
		cancel()
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
