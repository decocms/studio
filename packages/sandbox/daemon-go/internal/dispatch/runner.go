package dispatch

// Harness transport: the TS harnesses can only be embedded by a TS process, so
// `/dispatch` execs one per run. Wire per `packages/harness-runner/main.ts` —
// keep the two in step:
//
//	spawn   argv from HARNESS_RUNNER_CMD, in its own process group
//	input   {harnessId, input} as JSON on stdin
//	output  a stream of HarnessRunResult frames on stdout, one JSON line each;
//	        stderr is the pod's log
//	cancel  cancel ctx — the process group is killed, the CLI with it
//
// Frames are forwarded to Studio as they are read, not collected: a turn that
// runs for minutes persists its work as it goes instead of all at the end.
//
// Exec-per-run is what bounds the model credential's lifetime: it is the child's
// spawn environment, so it cannot outlive the run it came with.
//
// ⚠️ SECURITY: env holds a model credential. Never log it, and never put the
// child's own output into an error that travels back to Studio.

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"syscall"
)

// RunHarness runs one turn, handing each result frame the harness prints to
// `emit` verbatim as it is read. Returns how many frames were emitted; an error
// means the harness died, and the caller reports that as a crash — alongside the
// frames that did make it, which the consumer has already received.
//
// `emit` returning false means the client is gone; reading stops there.
func RunHarness(
	ctx context.Context,
	argv []string,
	harnessId string,
	input json.RawMessage,
	env map[string]string,
	emit func([]byte) bool,
) (int, error) {
	payload, err := json.Marshal(map[string]any{"harnessId": harnessId, "input": input})
	if err != nil {
		return 0, err
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
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return 0, err
	}
	if err := cmd.Start(); err != nil {
		return 0, fmt.Errorf("harness runner failed to start: %w", err)
	}

	emitted := 0
	// bufio.Reader, not Scanner: a frame carrying a large tool result exceeds
	// Scanner's line cap, and a dropped frame is lost work.
	reader := bufio.NewReader(stdout)
	for {
		line, readErr := reader.ReadBytes('\n')
		if frame := resultFrame(line); frame != nil {
			emitted++
			if !emit(frame) {
				break
			}
		}
		if readErr != nil {
			break
		}
	}
	io.Copy(io.Discard, stdout) // don't SIGPIPE a harness we stopped reading

	runErr := cmd.Wait()
	// A harness that printed frames owns the outcome even if it then exited
	// non-zero: the last frame carries the real reason.
	if emitted > 0 {
		return emitted, nil
	}
	if runErr != nil {
		return 0, fmt.Errorf("harness runner failed: %w", runErr)
	}
	return 0, fmt.Errorf("harness runner produced no result")
}

// resultFrame recognizes one output line as a harness frame: a JSON object with
// a `chunks` array. Probed rather than assumed — anything else the harness
// prints on stdout (a runtime warning, a stray log) is skipped instead of
// travelling to Studio as a malformed frame.
func resultFrame(line []byte) []byte {
	line = bytes.TrimSpace(line)
	if len(line) == 0 || line[0] != '{' {
		return nil
	}
	var probe struct {
		Chunks []json.RawMessage `json:"chunks"`
	}
	if json.Unmarshal(line, &probe) != nil || probe.Chunks == nil {
		return nil
	}
	return line
}
