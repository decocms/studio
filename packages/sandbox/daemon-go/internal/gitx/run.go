package gitx

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"time"
)

const defaultGitTimeout = 30 * time.Second

const (
	DecoUID = 1000
	DecoGID = 1000
)

type GitError struct {
	Msg    string
	Stderr string
	Status int
}

func (e *GitError) Error() string { return e.Msg }

type RunOpts struct {
	Cwd     string
	Env     map[string]string
	Timeout time.Duration
}

// Run executes git with `-c safe.directory=*` prepended, a 30s default
// timeout, and a uid drop to deco:1000 only when running as root.
func Run(args []string, opts RunOpts) (string, error) {
	full := append([]string{"-c", "safe.directory=*"}, args...)
	return RunRaw(full, opts)
}

func RunRaw(args []string, opts RunOpts) (string, error) {
	timeout := opts.Timeout
	if timeout == 0 {
		timeout = defaultGitTimeout
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = opts.Cwd
	cmd.Env = mergedEnv(opts.Env)
	applyUidDrop(cmd)
	var out, errBuf bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &errBuf
	err := cmd.Run()
	if err != nil {
		status := -1
		if exitErr, ok := err.(*exec.ExitError); ok {
			status = exitErr.ExitCode()
		}
		stderr := errBuf.String()
		msg := fmt.Sprintf("git %s exited %d", strings.Join(args, " "), status)
		if strings.TrimSpace(stderr) != "" {
			msg += ": " + strings.TrimSpace(stderr)
		}
		return "", &GitError{Msg: msg, Stderr: stderr, Status: status}
	}
	return strings.TrimSpace(out.String()), nil
}

func Try(args []string, opts RunOpts) (string, bool) {
	out, err := Run(args, opts)
	if err != nil {
		return "", false
	}
	return out, true
}

func mergedEnv(extra map[string]string) []string {
	if extra == nil {
		return os.Environ()
	}
	env := map[string]string{}
	for _, kv := range os.Environ() {
		if i := strings.IndexByte(kv, '='); i >= 0 {
			env[kv[:i]] = kv[i+1:]
		}
	}
	for k, v := range extra {
		env[k] = v
	}
	out := make([]string, 0, len(env))
	for k, v := range env {
		out = append(out, k+"="+v)
	}
	return out
}

func applyUidDrop(cmd *exec.Cmd) {
	if os.Geteuid() != 0 {
		return
	}
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.Credential = &syscall.Credential{Uid: DecoUID, Gid: DecoGID}
}

// ReadEnv is the standard env for read-only git probes: pin discovery to
// repoDir and skip optional index locks so reads never race publish.
func ReadEnv(repoDir string) map[string]string {
	return map[string]string{
		"GIT_CEILING_DIRECTORIES": repoDir,
		"GIT_OPTIONAL_LOCKS":      "0",
	}
}

func IsGitRepo(repoDir string) bool {
	_, ok := Try([]string{"rev-parse", "--git-dir"}, RunOpts{Cwd: repoDir, Env: ReadEnv(repoDir)})
	return ok
}
