package dispatch

// Persistent harness sessions: one runner process per thread kept between
// turns, so a follow-up skips the runner's boot, the `claude` CLI's start and
// its MCP connections. Opt-in per dispatch: Studio sends `sessionKey`, a hash of
// the input that shapes the session; without it a run execs as in runner.go.
//
// Wire, on top of runner.go's: the process is spawned with
// HARNESS_RUNNER_PERSISTENT=1, reads one {harnessId, input, beforeRunMs} JSON
// line per turn, and ends each clean turn with a `{"chunks":[],"turnEnd":true}`
// line, which is not forwarded. A turn that ends any other way ends the process.
//
// ⚠️ SECURITY: a kept process holds the model credential it was spawned with.
// Its life is bounded by sessionIdleTTL, by the run env changing (the key
// includes a hash of it) and by the MCP credential it was given expiring.

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"sort"
	"sync"
	"syscall"
	"time"
)

// A kept runner idle this long is killed. Variable for the test.
var sessionIdleTTL = 10 * time.Minute

// A runner is reused only while its MCP credential outlives a long turn.
const sessionMinCredentialLife = 30 * time.Minute

type liveRunner struct {
	studioKey  string
	envDigest  map[string]string // name → value hash, to name what changed
	key        string
	mcpExpires time.Time
	cmd        *exec.Cmd
	stdin      io.WriteCloser
	lines      chan []byte // closed when stdout ends
	exited     chan struct{}
	waitErr    error
	idle       *time.Timer
}

func (lr *liveRunner) kill() {
	_ = syscall.Kill(-lr.cmd.Process.Pid, syscall.SIGKILL)
	<-lr.exited
}

func (lr *liveRunner) alive() bool {
	select {
	case <-lr.exited:
		return false
	default:
		return true
	}
}

// sessionPool holds at most one idle runner per thread. A runner is taken out
// for the length of a turn, so two turns never share one.
type sessionPool struct {
	mu   sync.Mutex
	idle map[string]*liveRunner
}

func (p *sessionPool) take(threadId string) *liveRunner {
	p.mu.Lock()
	defer p.mu.Unlock()
	lr := p.idle[threadId]
	delete(p.idle, threadId)
	if lr != nil {
		lr.idle.Stop()
	}
	return lr
}

func (p *sessionPool) put(threadId string, lr *liveRunner) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.idle == nil {
		p.idle = map[string]*liveRunner{}
	}
	if old := p.idle[threadId]; old != nil {
		go old.kill()
	}
	p.idle[threadId] = lr
	lr.idle = time.AfterFunc(sessionIdleTTL, func() {
		p.mu.Lock()
		if p.idle[threadId] == lr {
			delete(p.idle, threadId)
		}
		p.mu.Unlock()
		lr.kill()
	})
}

// sessionKey binds Studio's key to the spawn environment: a rotated credential
// must never reach a turn through a process spawned with the old one.
func sessionKey(studioKey, harnessId string, env map[string]string) string {
	keys := make([]string, 0, len(env))
	for k := range env {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	h := sha256.New()
	fmt.Fprintf(h, "%s\x00%s\x00", studioKey, harnessId)
	for _, k := range keys {
		fmt.Fprintf(h, "%s=%s\x00", k, env[k])
	}
	return hex.EncodeToString(h.Sum(nil))
}

func envDigest(env map[string]string) map[string]string {
	out := make(map[string]string, len(env))
	for k, v := range env {
		sum := sha256.Sum256([]byte(v))
		out[k] = hex.EncodeToString(sum[:8])
	}
	return out
}

// changedEnv names the variables that differ, never their values.
func changedEnv(was, now map[string]string) []string {
	var names []string
	for k, v := range now {
		if was[k] != v {
			names = append(names, k)
		}
	}
	for k := range was {
		if _, ok := now[k]; !ok {
			names = append(names, k)
		}
	}
	sort.Strings(names)
	return names
}

// why a kept runner cannot take this turn; "" when it can.
func (lr *liveRunner) mismatch(studioKey, key string, env map[string]string) string {
	switch {
	case !lr.alive():
		return "dead"
	case lr.studioKey != studioKey:
		return "studio-key"
	case lr.key != key:
		return fmt.Sprintf("env %v", changedEnv(lr.envDigest, envDigest(env)))
	case time.Until(lr.mcpExpires) <= sessionMinCredentialLife:
		return "credential"
	}
	return ""
}

func spawnLive(argv []string, env map[string]string, key string, mcpExpires time.Time) (*liveRunner, error) {
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Env = os.Environ()
	for k, v := range env {
		cmd.Env = append(cmd.Env, k+"="+v)
	}
	cmd.Env = append(cmd.Env, "HARNESS_RUNNER_PERSISTENT=1")
	cmd.Stderr = os.Stdout
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("harness runner failed to start: %w", err)
	}
	lr := &liveRunner{
		key: key, envDigest: envDigest(env), mcpExpires: mcpExpires, cmd: cmd, stdin: stdin,
		lines: make(chan []byte, 64), exited: make(chan struct{}),
	}
	go func() {
		reader := bufio.NewReader(stdout)
		for {
			line, err := reader.ReadBytes('\n')
			if len(bytes.TrimSpace(line)) > 0 {
				lr.lines <- line
			}
			if err != nil {
				break
			}
		}
		close(lr.lines)
		lr.waitErr = cmd.Wait()
		close(lr.exited)
	}()
	return lr, nil
}

func isTurnEnd(line []byte) bool {
	var probe struct {
		TurnEnd bool `json:"turnEnd"`
	}
	return json.Unmarshal(bytes.TrimSpace(line), &probe) == nil && probe.TurnEnd
}

// runSession runs one turn on the thread's kept runner, spawning one when
// there is none or it no longer matches. Same contract as RunHarness.
func (p *sessionPool) runSession(
	ctx context.Context,
	argv []string,
	harnessId string,
	input json.RawMessage,
	env map[string]string,
	beforeRunMs string,
	info RunInfo,
	studioKey string,
	emit func([]byte) bool,
) (int, error) {
	payload, err := json.Marshal(map[string]any{
		"harnessId": harnessId, "input": input, "beforeRunMs": beforeRunMs,
	})
	if err != nil {
		return 0, err
	}
	key := sessionKey(studioKey, harnessId, env)
	mcpExpires := time.UnixMilli(info.McpExpiresAt)

	lr := p.take(info.ThreadId)
	why := "none kept"
	if lr != nil {
		why = lr.mismatch(studioKey, key, env)
	}
	reused := why == ""
	if lr != nil && !reused {
		lr.kill()
	}
	if !reused {
		if lr, err = spawnLive(argv, env, key, mcpExpires); err != nil {
			return 0, err
		}
		lr.studioKey = studioKey
	}
	slog.Info("dispatch session", "thread", info.ThreadId, "reused", reused, "why_not", why)

	if _, err := lr.stdin.Write(append(payload, '\n')); err != nil {
		lr.kill()
		return 0, fmt.Errorf("harness runner stopped reading: %w", err)
	}

	emitted := 0
	forwarding := true
	for {
		select {
		case <-ctx.Done():
			lr.kill()
			return emitted, nil
		case line, ok := <-lr.lines:
			if !ok {
				<-lr.exited
				if emitted > 0 {
					return emitted, nil
				}
				if lr.waitErr != nil {
					return 0, fmt.Errorf("harness runner failed: %w", lr.waitErr)
				}
				return 0, fmt.Errorf("harness runner produced no result")
			}
			if isTurnEnd(line) {
				p.put(info.ThreadId, lr)
				return emitted, nil
			}
			if frame := resultFrame(line); frame != nil && forwarding {
				emitted++
				forwarding = emit(frame)
			}
		}
	}
}
