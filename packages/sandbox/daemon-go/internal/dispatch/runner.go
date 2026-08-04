package dispatch

// Harness transport: the TS harnesses can only be embedded by a TS process, so
// `/dispatch` execs one per run. Wire per `packages/harness-runner/main.ts` —
// keep the two in step:
//
//	spawn   argv from HARNESS_RUNNER_CMD, in its own process group
//	input   {harnessId, input} as JSON on stdin
//	output  one HarnessRunResult as JSON on stdout; stderr is the pod's log
//	cancel  cancel ctx — the process group is killed, the CLI with it
//
// Exec-per-run is what bounds the model credential's lifetime: it is the child's
// spawn environment, so it cannot outlive the run it came with.
//
// ⚠️ SECURITY: env holds a model credential. Never log it, and never put the
// child's own output into an error that travels back to Studio.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"syscall"
)

// RunHarness runs one turn and returns the harness's result JSON verbatim. An
// error means no result was produced at all — the caller reports that as a
// crash.
func RunHarness(
	ctx context.Context,
	argv []string,
	harnessId string,
	input json.RawMessage,
	env map[string]string,
) ([]byte, error) {
	payload, err := json.Marshal(map[string]any{"harnessId": harnessId, "input": input})
	if err != nil {
		return nil, err
	}
	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	// Own process group, killed as a group: the harness spawns the `claude` CLI,
	// and signalling only the parent would leave that behind holding the pod.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	}
	cmd.Env = os.Environ()
	for key, value := range env {
		cmd.Env = append(cmd.Env, key+"="+value)
	}
	cmd.Stdin = bytes.NewReader(payload)
	cmd.Stderr = os.Stdout // the daemon's logs are stdout-only (see logging_test.go)
	var stdout bytes.Buffer
	cmd.Stdout = &stdout

	runErr := cmd.Run()
	// A harness that printed a result owns the outcome even if it then exited
	// non-zero: the result carries the partial work and the real reason.
	if result := resultLine(stdout.Bytes()); result != nil {
		return result, nil
	}
	if runErr != nil {
		return nil, fmt.Errorf("harness runner failed: %w", runErr)
	}
	return nil, fmt.Errorf("harness runner produced no result")
}

// resultLine picks the result out of stdout: the last line that is a JSON object
// with a `chunks` array. Scanned rather than assumed to be all of stdout —
// anything else printed there (a runtime warning, a stray log) would otherwise
// read as a crashed harness.
func resultLine(out []byte) []byte {
	lines := bytes.Split(out, []byte("\n"))
	for i := len(lines) - 1; i >= 0; i-- {
		line := bytes.TrimSpace(lines[i])
		if len(line) == 0 || line[0] != '{' {
			continue
		}
		var probe struct {
			Chunks []json.RawMessage `json:"chunks"`
		}
		if json.Unmarshal(line, &probe) == nil && probe.Chunks != nil {
			return line
		}
	}
	return nil
}
