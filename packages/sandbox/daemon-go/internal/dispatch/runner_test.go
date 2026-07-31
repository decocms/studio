package dispatch

// Tests for the harness-runner bridge (runner.go). The fake runner is this test
// binary re-executed with FAKE_RUNNER set: it speaks the real protocol (ready
// line, bearer, NDJSON, done) without Bun, the harnesses or a model provider.

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"
)

const (
	fakeRunnerEnv = "FAKE_RUNNER"
	// The plain, well-behaved runner. Must be non-empty: an empty value is how the
	// entrypoint knows it is NOT running as a runner.
	fakeRunnerOK = "ok"
	// A run the test cancels mid-stream: the fake runner streams chunks until the
	// request is aborted.
	fakeRunnerSlow = "slow"
	// A runner that never prints the ready line.
	fakeRunnerMute = "mute"
	// A runner that dies mid-stream without sending done.
	fakeRunnerCrash = "crash"
)

// TestFakeRunnerEntrypoint is the fake runner, not a test: when FAKE_RUNNER is
// set the binary was spawned as a runner and serves the protocol instead.
func TestFakeRunnerEntrypoint(t *testing.T) {
	mode := os.Getenv(fakeRunnerEnv)
	if mode == "" {
		t.Skip("not running as the fake runner")
	}
	serveFakeRunner(mode)
}

func serveFakeRunner(mode string) {
	if mode == fakeRunnerMute {
		// Never report ready; hold the process so the daemon's ready timeout is
		// what ends this.
		time.Sleep(30 * time.Second)
		return
	}
	token := os.Getenv(runnerTokenEnv)
	mux := http.NewServeMux()
	mux.HandleFunc("/run", func(w http.ResponseWriter, r *http.Request) {
		if token == "" || r.Header.Get("Authorization") != "Bearer "+token {
			http.Error(w, `{"error":"unauthorized"}`, 401)
			return
		}
		var body struct {
			HarnessId string         `json:"harnessId"`
			Input     map[string]any `json:"input"`
		}
		if json.NewDecoder(r.Body).Decode(&body) != nil {
			http.Error(w, `{"error":"bad_json"}`, 400)
			return
		}
		w.Header().Set("Content-Type", "application/x-ndjson")
		w.WriteHeader(200)
		flusher, _ := w.(http.Flusher)
		emit := func(event map[string]any) {
			data, _ := json.Marshal(event)
			fmt.Fprintf(w, "%s\n", data)
			if flusher != nil {
				flusher.Flush()
			}
		}
		// Echo the pid so a test can tell one runner process from another, and the
		// harness id so it can tell the frame arrived intact.
		emit(map[string]any{"type": "ui-message-chunk", "chunk": map[string]any{
			"pid": os.Getpid(), "harnessId": body.HarnessId,
			"threadId": body.Input["threadId"],
		}})
		switch mode {
		case fakeRunnerCrash:
			// Die mid-run: no done, connection dropped.
			os.Exit(1)
		case fakeRunnerSlow:
			for range 600 {
				select {
				case <-r.Context().Done():
					return // the daemon aborted; the real runner tears the CLI down here
				case <-time.After(10 * time.Millisecond):
					emit(map[string]any{"type": "ui-message-chunk", "chunk": map[string]any{"tick": true}})
				}
			}
		}
		emit(map[string]any{"type": "done"})
	})
	srv := httptest.NewUnstartedServer(mux)
	srv.Start()
	defer srv.Close()
	port := srv.Listener.Addr().(*net.TCPAddr).Port
	fmt.Printf("%s{\"port\":%d}\n", runnerReadyPrefix, port)
	// Parent-death detection: the daemon holds our stdin and never writes, so a
	// read returning means the daemon is gone.
	io.Copy(io.Discard, os.Stdin)
}

func fakeRunnerArgv() []string {
	// -test.run pins the entrypoint; the env var is what actually switches it, so
	// a stray invocation without it exits immediately instead of serving.
	return []string{os.Args[0], "-test.run=TestFakeRunnerEntrypoint", "-test.v=false"}
}

// runViaRunner streams one run and returns the decoded NDJSON events.
func runViaRunner(t *testing.T, r *Runner, mode string, ctx context.Context) ([]map[string]any, error) {
	t.Helper()
	t.Setenv(fakeRunnerEnv, mode)
	body, err := r.Stream(ctx, fakeRunnerArgv(), "claude-code",
		json.RawMessage(`{"threadId":"t-1"}`))
	if err != nil {
		return nil, err
	}
	defer body.Close()
	var events []map[string]any
	dec := json.NewDecoder(body)
	for {
		var event map[string]any
		if err := dec.Decode(&event); err != nil {
			return events, nil
		}
		events = append(events, event)
		if event["type"] == "done" {
			return events, nil
		}
	}
}

func TestRunnerStreamsARun(t *testing.T) {
	r := NewRunner()
	t.Cleanup(r.Shutdown)

	events, err := runViaRunner(t, r, fakeRunnerOK, context.Background())
	if err != nil {
		t.Fatalf("stream failed: %v", err)
	}
	if len(events) != 2 {
		t.Fatalf("got %d events, want chunk + done: %v", len(events), events)
	}
	chunk, _ := events[0]["chunk"].(map[string]any)
	if chunk["harnessId"] != "claude-code" || chunk["threadId"] != "t-1" {
		t.Errorf("the run frame did not arrive intact: %v", chunk)
	}
	if events[1]["type"] != "done" {
		t.Errorf("stream did not end with done: %v", events[1])
	}
}

func TestRunnerIsReusedAcrossRuns(t *testing.T) {
	r := NewRunner()
	t.Cleanup(r.Shutdown)

	first, err := runViaRunner(t, r, fakeRunnerOK, context.Background())
	if err != nil {
		t.Fatal(err)
	}
	second, err := runViaRunner(t, r, fakeRunnerOK, context.Background())
	if err != nil {
		t.Fatal(err)
	}
	pidOf := func(events []map[string]any) any {
		chunk, _ := events[0]["chunk"].(map[string]any)
		return chunk["pid"]
	}
	// The whole point of this transport over per-run stdio: one warm runner, so a
	// run does not pay a Bun start plus module load.
	if pidOf(first) != pidOf(second) {
		t.Errorf("each run spawned its own runner: %v vs %v", pidOf(first), pidOf(second))
	}
}

func TestRunnerRespawnsAfterItDies(t *testing.T) {
	r := NewRunner()
	t.Cleanup(r.Shutdown)

	// A run whose runner exits mid-stream: the events stop without done, which is
	// what dispatch reports as harness_crashed.
	crashed, err := runViaRunner(t, r, fakeRunnerCrash, context.Background())
	if err != nil {
		t.Fatalf("first run failed before streaming: %v", err)
	}
	for _, e := range crashed {
		if e["type"] == "done" {
			t.Fatal("the crashing runner somehow finished the stream")
		}
	}

	// No auto-respawn — the NEXT dispatch is what brings a runner back. Retried
	// briefly: the exit is observed asynchronously, and a stale handle would
	// otherwise be a flake instead of the bug it is.
	var events []map[string]any
	deadline := time.Now().Add(5 * time.Second)
	for {
		events, err = runViaRunner(t, r, fakeRunnerOK, context.Background())
		if err == nil && len(events) > 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("no run succeeded after the runner died: %v (%v)", events, err)
		}
		time.Sleep(50 * time.Millisecond)
	}
	if events[len(events)-1]["type"] != "done" {
		t.Errorf("the respawned runner did not complete a run: %v", events)
	}
}

func TestRunnerCancellationEndsTheRun(t *testing.T) {
	r := NewRunner()
	t.Cleanup(r.Shutdown)
	ctx, cancel := context.WithCancel(context.Background())

	t.Setenv(fakeRunnerEnv, fakeRunnerSlow)
	body, err := r.Stream(ctx, fakeRunnerArgv(), "claude-code",
		json.RawMessage(`{"threadId":"t-1"}`))
	if err != nil {
		t.Fatal(err)
	}
	defer body.Close()

	// Read one chunk so the run is definitely streaming, then cancel: the read
	// must fail promptly instead of hanging for the run's natural length.
	buf := make([]byte, 1)
	if _, err := body.Read(buf); err != nil {
		t.Fatalf("no bytes before cancel: %v", err)
	}
	cancel()
	done := make(chan error, 1)
	go func() {
		_, err := io.ReadAll(body)
		done <- err
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("the stream did not end after the run was cancelled")
	}

	// Cancelling ONE run must not take the shared runner down with it.
	events, err := runViaRunner(t, r, fakeRunnerOK, context.Background())
	if err != nil {
		t.Fatalf("cancelling a run killed the runner: %v", err)
	}
	if len(events) == 0 || events[len(events)-1]["type"] != "done" {
		t.Errorf("the next run did not complete: %v", events)
	}
}

func TestRunnerFailsWhenReadyNeverArrives(t *testing.T) {
	prev := readyTimeout
	readyTimeout = 300 * time.Millisecond
	t.Cleanup(func() { readyTimeout = prev })

	r := NewRunner()
	t.Cleanup(r.Shutdown)
	t.Setenv(fakeRunnerEnv, fakeRunnerMute)

	started := time.Now()
	_, err := r.Stream(context.Background(), fakeRunnerArgv(), "claude-code",
		json.RawMessage(`{"threadId":"t-1"}`))
	if err == nil {
		t.Fatal("a runner that never reported ready was treated as usable")
	}
	if !strings.Contains(err.Error(), "ready") {
		t.Errorf("unhelpful error for a mute runner: %v", err)
	}
	// Fails fast rather than hanging the dispatch — a stuck dispatch reads to the
	// user as a silent agent.
	if elapsed := time.Since(started); elapsed > 5*time.Second {
		t.Errorf("took %s to give up on a mute runner", elapsed)
	}
}

func TestRunnerRejectsAMissingBinary(t *testing.T) {
	r := NewRunner()
	t.Cleanup(r.Shutdown)
	_, err := r.Stream(context.Background(),
		[]string{"/nonexistent/harness-runner-" + strconv.Itoa(os.Getpid())},
		"claude-code", json.RawMessage(`{"threadId":"t-1"}`))
	if err == nil {
		t.Fatal("spawning a missing runner binary reported success")
	}
}
