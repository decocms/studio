package docker

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"sort"
	"strings"
)

// Command is one docker CLI invocation. Env is set on the CLI's own process,
// never on its argv: `docker run -e NAME` reads the value from there, which
// keeps DAEMON_TOKEN out of the host's process list.
type Command struct {
	Args []string
	Env  map[string]string
}

// Result is a finished invocation. A non-zero Code is an answer, not an error.
type Result struct {
	Stdout, Stderr string
	Code           int
}

// Exec runs the docker CLI. The error is for an invocation that did not
// finish: no CLI on PATH, or ctx ended.
type Exec func(ctx context.Context, cmd Command) (Result, error)

// CLI shells out to `docker` on PATH; DOCKER_HOST and the CLI's contexts
// select the engine.
func CLI(ctx context.Context, cmd Command) (Result, error) {
	c := exec.CommandContext(ctx, "docker", cmd.Args...)
	if len(cmd.Env) > 0 {
		c.Env = os.Environ()
		for k, v := range cmd.Env {
			c.Env = append(c.Env, k+"="+v)
		}
	}
	var stdout, stderr bytes.Buffer
	c.Stdout, c.Stderr = &stdout, &stderr
	err := c.Run()
	res := Result{Stdout: stdout.String(), Stderr: stderr.String()}
	if ctx.Err() != nil {
		return res, ctx.Err()
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		res.Code = exitErr.ExitCode()
		return res, nil
	}
	if errors.Is(err, exec.ErrNotFound) {
		return res, errors.New("docker CLI not found on PATH: install Docker Desktop, OrbStack, colima or Podman's docker CLI")
	}
	return res, err
}

// container is the slice of `docker inspect` the runtime reads.
type container struct {
	Name  string
	State struct {
		Status    string
		Running   bool
		OOMKilled bool
		ExitCode  int32
		Error     string
	}
	Config struct {
		Env    []string
		Labels map[string]string
	}
	HostConfig struct {
		Memory int64
	}
	NetworkSettings struct {
		Ports map[string][]struct {
			HostIp   string
			HostPort string
		}
	}
}

func (c *container) env(name string) string {
	for _, kv := range c.Config.Env {
		if v, ok := strings.CutPrefix(kv, name+"="); ok {
			return v
		}
	}
	return ""
}

// hostPort is the loopback port publishing the container's port, "" when not
// (yet) published.
func (c *container) hostPort(port int) string {
	for _, b := range c.NetworkSettings.Ports[fmt.Sprintf("%d/tcp", port)] {
		if b.HostPort != "" && (b.HostIp == "127.0.0.1" || b.HostIp == "") {
			return b.HostPort
		}
	}
	return ""
}

func notFound(res Result) bool {
	return strings.Contains(strings.ToLower(res.Stderr), "no such")
}

// failure words a non-zero answer.
func failure(res Result, what string) error {
	msg := strings.TrimSpace(res.Stderr)
	if msg == "" {
		msg = strings.TrimSpace(res.Stdout)
	}
	if msg == "" {
		msg = "no output"
	}
	return fmt.Errorf("docker %s failed (exit %d): %s", what, res.Code, msg)
}

func sortedKeys(m map[string]string) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

func (r *Runner) run(ctx context.Context, env map[string]string, args ...string) (Result, error) {
	return r.exec(ctx, Command{Args: args, Env: env})
}

// inspect is nil for no such container.
func (r *Runner) inspect(ctx context.Context, name string) (*container, error) {
	res, err := r.run(ctx, nil, "container", "inspect", name)
	if err != nil {
		return nil, err
	}
	if res.Code != 0 {
		if notFound(res) {
			return nil, nil
		}
		return nil, failure(res, "container inspect")
	}
	var out []container
	if err := json.Unmarshal([]byte(res.Stdout), &out); err != nil || len(out) != 1 {
		return nil, fmt.Errorf("docker container inspect %s: unreadable answer: %v", name, err)
	}
	return &out[0], nil
}

// remove stops the container within the stop grace, so the daemon's SIGTERM
// handler can publish the working tree, then removes it and its anonymous
// volumes. A container already gone is success.
func (r *Runner) remove(ctx context.Context, name string) error {
	res, err := r.run(ctx, nil, "container", "stop", "--time", fmt.Sprint(int(r.cfg.StopGrace.Seconds())), name)
	if err != nil {
		return err
	}
	if res.Code != 0 && !notFound(res) {
		return failure(res, "container stop")
	}
	res, err = r.run(ctx, nil, "container", "rm", "--force", "--volumes", name)
	if err != nil {
		return err
	}
	if res.Code != 0 && !notFound(res) {
		return failure(res, "container rm")
	}
	return nil
}

// logsTail is the end of a dead container's output, for the error that says
// it died.
func (r *Runner) logsTail(ctx context.Context, name string) string {
	res, err := r.run(ctx, nil, "container", "logs", "--tail", "20", name)
	if err != nil || res.Code != 0 {
		return ""
	}
	return strings.TrimSpace(res.Stdout + "\n" + res.Stderr)
}
