package dispatch

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/decocms/studio/sandbox-daemon/internal/auth"
)

const tombstoneTTL = 60 * time.Second

type Deps struct {
	DaemonToken      func() string
	AppRoot          string
	AllowedHosts     []string
	AllowSameHostDev bool
	// HarnessRunnerCmd is the argv for the harness-runner subprocess
	// (HARNESS_RUNNER_CMD env). Empty → every dispatch fails with
	// unknown_harness over SSE.
	HarnessRunnerCmd []string
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

// sseWriter serializes SSE writes and guards against write-after-close —
// the Go analogue of the TS closed-controller guard (the harness_crashed
// re-dispatch-storm invariant).
type sseWriter struct {
	mu      sync.Mutex
	w       http.ResponseWriter
	flusher http.Flusher
	closed  bool
}

func newSseWriter(w http.ResponseWriter) *sseWriter {
	flusher, _ := w.(http.Flusher)
	return &sseWriter{w: w, flusher: flusher}
}

func (s *sseWriter) writeRaw(data string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return false
	}
	if _, err := io.WriteString(s.w, data); err != nil {
		s.closed = true
		return false
	}
	if s.flusher != nil {
		s.flusher.Flush()
	}
	return true
}

func (s *sseWriter) WriteEvent(event map[string]any) bool {
	data, err := json.Marshal(event)
	if err != nil {
		return false
	}
	return s.writeRaw("data: " + string(data) + "\n\n")
}

func (s *sseWriter) Close() {
	s.mu.Lock()
	s.closed = true
	s.mu.Unlock()
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

	writeSseHeaders(w)
	sse := newSseWriter(w)
	sse.writeRaw(": dispatch accepted\n\n")

	rebased := rebaseInput(input, deps.AppRoot)
	reg.streamHarnessRun(ctx, sse, deps, harnessId, runId, rebased)
}

func (reg *Registry) handleOffloadDispatch(
	w http.ResponseWriter,
	r *http.Request,
	deps Deps,
	frame map[string]json.RawMessage,
	ref *MessagesRef,
	harnessId, runId string,
) {
	ctx, cancel := context.WithCancel(r.Context())
	reg.register(runId, cancel)

	writeSseHeaders(w)
	sse := newSseWriter(w)
	sse.writeRaw(": dispatch accepted\n\n")

	fail := func(code, message string) {
		sse.WriteEvent(map[string]any{"type": "error", "code": code, "message": message})
		sse.WriteEvent(map[string]any{"type": "done"})
		reg.unregister(runId)
	}

	messages, err := FetchOffloadedMessages(ref.URL, deps.AllowedHosts, deps.AllowSameHostDev, ref.Sha256)
	if err != nil {
		slog.Error("dispatch offload fetch failed", "harness", harnessId, "url", ref.URL, "err", err)
		fail("offload_fetch_failed", err.Error())
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
		fail("bad_input", reason)
		return
	}

	if reg.tombstoned(runId) {
		fail("tombstoned", fmt.Sprintf("runId %s was cancelled", runId))
		return
	}

	slog.Info("dispatch received (offload)", "harness", harnessId, "run_id", runId, "bytes", ref.Bytes)
	rebased := rebaseInput(merged, deps.AppRoot)
	reg.streamHarnessRun(ctx, sse, deps, harnessId, runId, rebased)
}

func writeSseHeaders(w http.ResponseWriter) {
	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-store")
	h.Set("Connection", "keep-alive")
	h.Set("Access-Control-Allow-Origin", "*")
	w.WriteHeader(200)
}

// streamHarnessRun spawns the harness-runner subprocess (HARNESS_RUNNER_CMD
// seam), forwards the frame on stdin, and pipes NDJSON events back as SSE
// data frames. Always emits done; clears the run registry in defer.
func (reg *Registry) streamHarnessRun(
	ctx context.Context,
	sse *sseWriter,
	deps Deps,
	harnessId, runId string,
	input json.RawMessage,
) {
	defer func() {
		sse.WriteEvent(map[string]any{"type": "done"})
		reg.unregister(runId)
	}()

	if len(deps.HarnessRunnerCmd) == 0 {
		sse.WriteEvent(map[string]any{
			"type": "error", "code": "unknown_harness",
			"message": "no harness runner configured (HARNESS_RUNNER_CMD unset)",
		})
		return
	}

	cmd := exec.Command(deps.HarnessRunnerCmd[0], deps.HarnessRunnerCmd[1:]...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Stderr = os.Stdout
	stdin, err := cmd.StdinPipe()
	if err != nil {
		sse.WriteEvent(map[string]any{"type": "error", "code": "harness_crashed", "message": err.Error()})
		return
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		sse.WriteEvent(map[string]any{"type": "error", "code": "harness_crashed", "message": err.Error()})
		return
	}
	if err := cmd.Start(); err != nil {
		sse.WriteEvent(map[string]any{"type": "error", "code": "harness_crashed", "message": err.Error()})
		return
	}

	killed := make(chan struct{})
	go func() {
		select {
		case <-ctx.Done():
			syscall.Kill(-cmd.Process.Pid, syscall.SIGTERM)
			time.AfterFunc(3*time.Second, func() {
				syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
			})
		case <-killed:
		}
	}()

	frame, _ := json.Marshal(map[string]any{
		"runId":     runId,
		"harnessId": harnessId,
		"input":     json.RawMessage(input),
	})
	go func() {
		stdin.Write(append(frame, '\n'))
		stdin.Close()
	}()

	sawDone := false
	chunkCount := 0
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 0, 64*1024), 16*1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var event map[string]any
		if err := json.Unmarshal([]byte(line), &event); err != nil {
			continue
		}
		if ctx.Err() != nil {
			break
		}
		typ, _ := event["type"].(string)
		if typ == "done" {
			sawDone = true
			break
		}
		if typ == "ui-message-chunk" {
			chunkCount++
		}
		sse.WriteEvent(event)
	}
	err = cmd.Wait()
	close(killed)
	if !sawDone && err != nil && ctx.Err() == nil {
		slog.Error("harness crashed", "harness", harnessId, "run_id", runId, "chunks", chunkCount, "err", err)
		sse.WriteEvent(map[string]any{"type": "error", "code": "harness_crashed", "message": err.Error()})
		return
	}
	slog.Info("dispatch done", "harness", harnessId, "run_id", runId, "chunks", chunkCount, "aborted", ctx.Err() != nil)
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
