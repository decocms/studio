package dispatch

// Harness-runner transport: the TS harnesses can only be embedded by a TS
// process, so `/dispatch` drives them through a subprocess serving loopback
// HTTP. Wire per `daemon/harness-runner/protocol.ts` — keep the two in step:
//
//	spawn   argv from HARNESS_RUNNER_CMD, env HARNESS_RUNNER_MODE=1 and a
//	        per-spawn HARNESS_RUNNER_TOKEN
//	ready   the runner prints `HARNESS_RUNNER_READY {"port":N}` on stdout
//	run     POST http://127.0.0.1:N/run with that bearer, body
//	        {harnessId, input, env}; answered 200 application/x-ndjson, one
//	        DispatchSSEEvent per line, always terminated by {"type":"done"}
//	cancel  abort the request — the runner tears its CLI down with it
//
// One shared runner, never auto-respawned: a respawn loop would turn one bad run
// into a storm. Its stdin is held open as a parent-death signal so a SIGKILLed
// daemon does not leave it holding a port.

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	runnerModeEnv     = "HARNESS_RUNNER_MODE"
	runnerTokenEnv    = "HARNESS_RUNNER_TOKEN"
	runnerReadyPrefix = "HARNESS_RUNNER_READY "
)

// readyTimeout bounds the wait for the ready line — a dispatch must fail rather
// than hang. Variable, not const, so tests do not pay 30s.
var readyTimeout = 30 * time.Second

// Runner supervises the single harness-runner subprocess.
type Runner struct {
	mu     sync.Mutex
	live   *runnerHandle
	client *http.Client
}

type runnerHandle struct {
	cmd   *exec.Cmd
	port  int
	token string
	// stdin is held open for the runner's whole life — see the package comment.
	stdin io.WriteCloser
}

func NewRunner() *Runner {
	return &Runner{
		client: &http.Client{
			// No client-level timeout: a run legitimately streams for minutes.
			// Headers, though, arrive immediately or the runner is wedged.
			Transport: &http.Transport{
				DialContext:           (&net.Dialer{Timeout: 2 * time.Second}).DialContext,
				ResponseHeaderTimeout: 30 * time.Second,
			},
		},
	}
}

// Stream starts a run and returns its NDJSON body. Cancelling ctx aborts the
// request, which is how the runner learns to tear the harness down.
// env is this run's tenant environment (the model credential, above all). It
// travels per run rather than at spawn because the runner process is shared
// across runs: a credential baked into the spawn env would outlive the run it
// belongs to and a later run with a rotated one would silently reuse it.
//
// ⚠️ SECURITY: env holds a model credential. Never log it.
func (r *Runner) Stream(
	ctx context.Context,
	argv []string,
	harnessId string,
	input json.RawMessage,
	env map[string]string,
) (io.ReadCloser, error) {
	handle, err := r.ensure(argv)
	if err != nil {
		return nil, err
	}
	// Matches main.ts: the runner reads harnessId + input + env and nothing else.
	// `signal` is not serializable and is reconstructed there from the request.
	payload := map[string]any{"harnessId": harnessId, "input": input}
	if len(env) > 0 {
		payload["env"] = env
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	url := fmt.Sprintf("http://127.0.0.1:%d/run", handle.port)
	req, err := http.NewRequestWithContext(ctx, "POST", url, strings.NewReader(string(body)))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+handle.token)
	res, err := r.client.Do(req)
	if err != nil {
		// A dead runner is the likely cause; drop it so the next dispatch respawns
		// rather than dialing a closed port forever.
		r.forget(handle)
		return nil, err
	}
	if res.StatusCode != 200 {
		detail, _ := io.ReadAll(io.LimitReader(res.Body, 4096))
		res.Body.Close()
		return nil, fmt.Errorf("harness-runner /run responded %d: %s",
			res.StatusCode, strings.TrimSpace(string(detail)))
	}
	return res.Body, nil
}

// Shutdown asks the runner to exit. Best-effort: the closed stdin below is the
// backstop for a runner that ignores the signal, and an abrupt SIGKILL of this
// daemon leaves the same closed pipe behind.
func (r *Runner) Shutdown() {
	r.mu.Lock()
	handle := r.live
	r.live = nil
	r.mu.Unlock()
	if handle == nil {
		return
	}
	handle.stdin.Close()
	if handle.cmd.Process != nil {
		syscall.Kill(-handle.cmd.Process.Pid, syscall.SIGTERM)
	}
}

func (r *Runner) ensure(argv []string) (*runnerHandle, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.live != nil {
		return r.live, nil
	}
	handle, err := spawnRunner(argv)
	if err != nil {
		return nil, err
	}
	r.live = handle
	// No auto-respawn on exit — just forget it, so the next dispatch spawns fresh.
	go func() {
		err := handle.cmd.Wait()
		slog.Info("harness runner exited", "pid", handle.cmd.Process.Pid, "err", err)
		r.forget(handle)
	}()
	return handle, nil
}

// forget drops handle if it is still the live one (a later spawn must survive
// an earlier runner's late exit).
func (r *Runner) forget(handle *runnerHandle) {
	r.mu.Lock()
	if r.live == handle {
		r.live = nil
	}
	r.mu.Unlock()
}

func spawnRunner(argv []string) (*runnerHandle, error) {
	token, err := randomToken()
	if err != nil {
		return nil, err
	}
	cmd := exec.Command(argv[0], argv[1:]...)
	// Own process group so a teardown signal reaches the harness CLIs the runner
	// spawned, not just the runner.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Env = append(os.Environ(), runnerModeEnv+"=1", runnerTokenEnv+"="+token)
	cmd.Stderr = os.Stdout // the daemon's logs are stdout-only (see logging_test.go)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		stdin.Close()
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		stdin.Close()
		return nil, err
	}

	port, err := awaitReady(stdout)
	if err != nil {
		stdin.Close()
		if cmd.Process != nil {
			syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		}
		cmd.Wait()
		return nil, err
	}
	// Everything the runner prints after the ready line is its own logging.
	go io.Copy(os.Stdout, stdout)
	slog.Info("harness runner ready", "pid", cmd.Process.Pid, "port", port)
	return &runnerHandle{cmd: cmd, port: port, token: token, stdin: stdin}, nil
}

// awaitReady scans stdout for the ready line, passing anything else through to
// the pod's logs.
func awaitReady(stdout io.Reader) (int, error) {
	type result struct {
		port int
		err  error
	}
	done := make(chan result, 1)
	go func() {
		scanner := bufio.NewScanner(stdout)
		for scanner.Scan() {
			line := scanner.Text()
			if !strings.HasPrefix(line, runnerReadyPrefix) {
				fmt.Fprintln(os.Stdout, line)
				continue
			}
			var ready struct {
				Port int `json:"port"`
			}
			if err := json.Unmarshal([]byte(line[len(runnerReadyPrefix):]), &ready); err != nil {
				done <- result{err: fmt.Errorf("harness-runner: malformed ready line: %w", err)}
				return
			}
			if ready.Port <= 0 {
				done <- result{err: fmt.Errorf("harness-runner: ready line reported port %d", ready.Port)}
				return
			}
			done <- result{port: ready.Port}
			return
		}
		// stdout closed without a ready line: the runner died starting up.
		done <- result{err: fmt.Errorf("harness-runner exited before reporting ready")}
	}()
	select {
	case res := <-done:
		return res.port, res.err
	case <-time.After(readyTimeout):
		return 0, fmt.Errorf("harness-runner did not report ready within %s", readyTimeout)
	}
}

func randomToken() (string, error) {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}

// defaultRunner backs a Deps with no Runner of its own. One per process, which
// is also the invariant the real daemon wants — a second runner would mean a
// second set of harness CLIs in one sandbox.
var defaultRunner = NewRunner()
