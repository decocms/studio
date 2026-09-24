package docker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/decocms/studio/packages/sandbox/controller-go/protocol"
	"github.com/decocms/studio/packages/sandbox/controller-go/store/storetest"
)

// fakeEngine answers the docker CLI subcommands the runtime uses, over an
// in-memory set of containers whose daemon port all lead to one fake daemon.
type fakeEngine struct {
	mu         sync.Mutex
	containers map[string]*container
	calls      []Command
	daemonPort string
	down       bool
	// exitOnStart makes the next run's container die at once.
	exitOnStart *int32
}

func (e *fakeEngine) exec(_ context.Context, cmd Command) (Result, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.calls = append(e.calls, cmd)
	args := cmd.Args
	noSuch := func(name string) Result {
		return Result{Code: 1, Stderr: "Error response from daemon: No such container: " + name}
	}
	switch {
	case args[0] == "version":
		if e.down {
			return Result{Code: 1, Stderr: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n"}, nil
		}
		return Result{Stdout: "27.3.1\n"}, nil
	case args[0] == "run":
		c := &container{}
		c.Config.Labels = map[string]string{}
		for i := 1; i < len(args)-1; i++ {
			switch args[i] {
			case "--name":
				i++
				c.Name = "/" + args[i]
			case "--label":
				i++
				k, v, _ := strings.Cut(args[i], "=")
				c.Config.Labels[k] = v
			case "--env":
				i++
				c.Config.Env = append(c.Config.Env, args[i]+"="+cmd.Env[args[i]])
			case "--memory":
				i++
				c.HostConfig.Memory = 2 << 30
			}
		}
		name := strings.TrimPrefix(c.Name, "/")
		if _, ok := e.containers[name]; ok {
			return Result{Code: 125, Stderr: fmt.Sprintf("docker: Error response from daemon: Conflict. The container name \"/%s\" is already in use.", name)}, nil
		}
		if e.exitOnStart != nil {
			c.State.Status, c.State.ExitCode = "exited", *e.exitOnStart
			e.exitOnStart = nil
		} else {
			c.State.Status, c.State.Running = "running", true
			c.NetworkSettings.Ports = map[string][]struct {
				HostIp   string
				HostPort string
			}{"9000/tcp": {{HostIp: "127.0.0.1", HostPort: e.daemonPort}}}
		}
		e.containers[name] = c
		return Result{Stdout: "0123abcd\n"}, nil
	case args[0] == "container" && args[1] == "inspect":
		c, ok := e.containers[args[2]]
		if !ok {
			return noSuch(args[2]), nil
		}
		b, _ := json.Marshal([]container{*c})
		return Result{Stdout: string(b)}, nil
	case args[0] == "container" && args[1] == "stop":
		name := args[len(args)-1]
		c, ok := e.containers[name]
		if !ok {
			return noSuch(name), nil
		}
		if c.State.Running {
			c.State.Running, c.State.Status, c.State.ExitCode = false, "exited", 143
		}
		return Result{Stdout: name}, nil
	case args[0] == "container" && args[1] == "rm":
		name := args[len(args)-1]
		if _, ok := e.containers[name]; !ok {
			return noSuch(name), nil
		}
		delete(e.containers, name)
		return Result{Stdout: name}, nil
	case args[0] == "container" && args[1] == "logs":
		return Result{Stderr: "daemon: APP_ROOT not writable\n"}, nil
	case args[0] == "container" && args[1] == "ls":
		var filters []string
		for i, a := range args {
			if a == "--filter" {
				filters = append(filters, strings.TrimPrefix(args[i+1], "label="))
			}
		}
		var names []string
	next:
		for name, c := range e.containers {
			for _, f := range filters {
				k, v, _ := strings.Cut(f, "=")
				if c.Config.Labels[k] != v {
					continue next
				}
			}
			names = append(names, name)
		}
		slices.Sort(names)
		return Result{Stdout: strings.Join(names, "\n") + "\n"}, nil
	}
	return Result{}, fmt.Errorf("fake engine: unhandled %v", args)
}

func (e *fakeEngine) put(name string, c *container) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.containers[name] = c
}

func (e *fakeEngine) get(name string) *container {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.containers[name]
}

func (e *fakeEngine) runs() []Command {
	e.mu.Lock()
	defer e.mu.Unlock()
	var out []Command
	for _, c := range e.calls {
		if c.Args[0] == "run" {
			out = append(out, c)
		}
	}
	return out
}

func (e *fakeEngine) ran(sub ...string) int {
	e.mu.Lock()
	defer e.mu.Unlock()
	n := 0
	for _, c := range e.calls {
		if len(c.Args) >= len(sub) && slices.Equal(c.Args[:len(sub)], sub) {
			n++
		}
	}
	return n
}

// fakeDaemon answers /health and records /config calls.
type fakeDaemon struct {
	mu      sync.Mutex
	bootID  string
	reject  bool
	configs []configCall
	orgFs   []string
}

type configCall struct {
	bearer string
	body   string
}

func (d *fakeDaemon) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	d.mu.Lock()
	defer d.mu.Unlock()
	switch r.URL.Path {
	case "/health":
		_, _ = io.WriteString(w, `{"ready":true,"bootId":"`+d.bootID+`","configured":false,"setup":{"running":false,"done":true}}`)
	case "/_sandbox/config":
		b, _ := io.ReadAll(r.Body)
		d.configs = append(d.configs, configCall{bearer: strings.TrimPrefix(r.Header.Get("authorization"), "Bearer "), body: string(b)})
		if d.reject {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = io.WriteString(w, `{"error":"unauthorized"}`)
			return
		}
		_, _ = io.WriteString(w, `{"bootId":"`+d.bootID+`","transition":"bootstrap","config":{}}`)
	case "/_sandbox/orgfs-config":
		b, _ := io.ReadAll(r.Body)
		d.orgFs = append(d.orgFs, string(b))
		_, _ = io.WriteString(w, `{"written":true}`)
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}

func (d *fakeDaemon) lastConfig(t *testing.T) configCall {
	t.Helper()
	d.mu.Lock()
	defer d.mu.Unlock()
	if len(d.configs) == 0 {
		t.Fatal("no /config call")
	}
	return d.configs[len(d.configs)-1]
}

type fakeStudio struct{ cloneURL string }

func (s *fakeStudio) MintCloneURL(context.Context, protocol.EnsureRepo, int64) (string, error) {
	return s.cloneURL, nil
}

func (s *fakeStudio) MintOrgFsConfig(context.Context, protocol.Tenant) (string, error) {
	return "", errors.New("not minted")
}

type harness struct {
	t      *testing.T
	engine *fakeEngine
	daemon *fakeDaemon
	store  *storetest.Memory
	studio *fakeStudio
	runner *Runner
}

var testID = protocol.SandboxID{UserID: "u_1", ProjectRef: "agent:org:vmcp:main"}

func newHarness(t *testing.T, cfg Config) *harness {
	h := &harness{t: t, daemon: &fakeDaemon{bootID: "boot-1"}, store: storetest.NewMemory(), studio: &fakeStudio{}}
	srv := httptest.NewServer(h.daemon)
	t.Cleanup(srv.Close)
	u, _ := url.Parse(srv.URL)
	h.engine = &fakeEngine{containers: map[string]*container{}, daemonPort: u.Port()}
	if cfg.Images == nil {
		cfg.Images = map[string]string{"default": "studio-sandbox:1", "android": "studio-sandbox-android:1"}
	}
	if cfg.Studio == nil {
		cfg.Studio = h.studio
	}
	if cfg.ReadyWait == 0 {
		cfg.ReadyWait = time.Second
	}
	r, err := New(Deps{Store: h.store, Exec: h.engine.exec}, cfg)
	if err != nil {
		t.Fatal(err)
	}
	r.poll = time.Millisecond
	r.newToken = func() string { return strings.Repeat("a", 64) }
	t.Cleanup(r.Close)
	h.runner = r
	return h
}

func (h *harness) persisted() persisted {
	h.t.Helper()
	rec, err := h.store.Get(context.Background(), testID, Name)
	if err != nil || rec == nil {
		h.t.Fatalf("no row: %v", err)
	}
	var st persisted
	if err := json.Unmarshal(rec.State, &st); err != nil {
		h.t.Fatal(err)
	}
	return st
}

// ours is a running container as this runtime would have created it.
func (h *harness) ours(name, token string) *container {
	c := &container{Name: "/" + name}
	c.State.Status, c.State.Running = "running", true
	c.Config.Labels = map[string]string{labelRuntime: Name, labelHandle: name, labelImage: "default"}
	c.Config.Env = []string{"DAEMON_TOKEN=" + token, "APP_ROOT=/app"}
	c.NetworkSettings.Ports = map[string][]struct {
		HostIp   string
		HostPort string
	}{"9000/tcp": {{HostIp: "127.0.0.1", HostPort: h.engine.daemonPort}}}
	return c
}
