package dispatch

// Tests for the harness exec bridge (runner.go). The fake harness is this test
// binary re-executed with FAKE_RUNNER set: it speaks the real wire (JSON on
// stdin, a HarnessRunResult on stdout) without Bun, the harnesses or a model
// provider.

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"
)

const (
	fakeRunnerEnv = "FAKE_RUNNER"
	// The plain, well-behaved harness. Must be non-empty: an empty value is how
	// the entrypoint knows it is NOT running as a harness.
	fakeRunnerOK = "ok"
	// A run the test cancels: sleeps well past the test's patience.
	fakeRunnerSlow = "slow"
	// A harness that dies without printing a result.
	fakeRunnerCrash = "crash"
	// A harness that prints an unrelated line on stdout before its result.
	fakeRunnerNoisy = "noisy"
)

// TestFakeHarnessEntrypoint is the fake harness, not a test: when FAKE_RUNNER is
// set the binary was spawned as one and speaks the wire instead.
func TestFakeHarnessEntrypoint(t *testing.T) {
	mode := os.Getenv(fakeRunnerEnv)
	if mode == "" {
		t.Skip("not running as the fake harness")
	}
	runFakeHarness(mode)
}

func runFakeHarness(mode string) {
	if mode == fakeRunnerSlow {
		time.Sleep(60 * time.Second)
		return
	}
	if mode == fakeRunnerCrash {
		fmt.Fprintln(os.Stderr, "fake harness dying")
		os.Exit(1)
	}
	raw, _ := io.ReadAll(os.Stdin)
	var body struct {
		HarnessId string         `json:"harnessId"`
		Input     map[string]any `json:"input"`
	}
	json.Unmarshal(raw, &body)
	if mode == fakeRunnerNoisy {
		fmt.Println("some runtime warning nobody asked for")
	}
	result, _ := json.Marshal(map[string]any{
		"chunks": []any{map[string]any{
			"harnessId": body.HarnessId,
			"threadId":  body.Input["threadId"],
			// Echoed so a test can prove the run env crossed the wire. A real
			// harness never emits it — this one carries no real credential.
			"apiKey": os.Getenv("ANTHROPIC_API_KEY"),
		}},
	})
	fmt.Println(string(result))
}

func fakeHarnessArgv() []string {
	// -test.run pins the entrypoint; the env var is what actually switches it, so
	// a stray invocation without it exits immediately instead of running.
	return []string{os.Args[0], "-test.run=TestFakeHarnessEntrypoint", "-test.v=false"}
}

func runFake(t *testing.T, mode string, ctx context.Context, env map[string]string) ([]byte, error) {
	t.Helper()
	t.Setenv(fakeRunnerEnv, mode)
	return RunHarness(ctx, fakeHarnessArgv(), "claude-code",
		json.RawMessage(`{"threadId":"t-1"}`), env)
}

func chunksOf(t *testing.T, out []byte) []map[string]any {
	t.Helper()
	var result struct {
		Chunks []map[string]any `json:"chunks"`
	}
	if err := json.Unmarshal(out, &result); err != nil {
		t.Fatalf("result is not JSON: %v (%s)", err, out)
	}
	if len(result.Chunks) == 0 {
		t.Fatalf("result carried no chunks: %s", out)
	}
	return result.Chunks
}

func TestRunHarnessReturnsTheResult(t *testing.T) {
	out, err := runFake(t, fakeRunnerOK, context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if got := chunksOf(t, out)[0]["threadId"]; got != "t-1" {
		t.Errorf("the input never reached the harness: %v", got)
	}
}

// The credential travels as the child's spawn environment, so it cannot outlive
// the run — and a rotated one takes effect on the very next run.
func TestRunHarnessPassesTheRunEnvPerRun(t *testing.T) {
	keyOf := func(key string) any {
		t.Helper()
		out, err := runFake(t, fakeRunnerOK, context.Background(),
			map[string]string{"ANTHROPIC_API_KEY": key})
		if err != nil {
			t.Fatal(err)
		}
		return chunksOf(t, out)[0]["apiKey"]
	}
	if got := keyOf("first-key"); got != "first-key" {
		t.Errorf("run env not forwarded: got %v", got)
	}
	if got := keyOf("rotated-key"); got != "rotated-key" {
		t.Errorf("a stale credential served: got %v", got)
	}
}

// Anything else on stdout must not read as a crashed harness.
func TestRunHarnessIgnoresNoiseOnStdout(t *testing.T) {
	out, err := runFake(t, fakeRunnerNoisy, context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(string(out), `{"chunks"`) {
		t.Fatalf("expected the result line, got %s", out)
	}
}

func TestRunHarnessReportsAHarnessThatPrintedNothing(t *testing.T) {
	if _, err := runFake(t, fakeRunnerCrash, context.Background(), nil); err == nil {
		t.Fatal("a harness that died without a result reported success")
	}
}

// Cancellation has to kill the child, not wait it out.
func TestRunHarnessCancellationKillsTheChild(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(200 * time.Millisecond)
		cancel()
	}()
	started := time.Now()
	if _, err := runFake(t, fakeRunnerSlow, ctx, nil); err == nil {
		t.Fatal("a cancelled run reported success")
	}
	if elapsed := time.Since(started); elapsed > 10*time.Second {
		t.Fatalf("cancellation waited for the child: %s", elapsed)
	}
}

func TestRunHarnessRejectsAMissingBinary(t *testing.T) {
	_, err := RunHarness(context.Background(),
		[]string{"/nonexistent/harness-runner-" + strconv.Itoa(os.Getpid())},
		"claude-code", json.RawMessage(`{"threadId":"t-1"}`), nil)
	if err == nil {
		t.Fatal("spawning a missing harness binary reported success")
	}
}
