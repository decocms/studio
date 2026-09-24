// Package docker is the single-machine runtime: one container per handle on
// the local engine, driven through the docker CLI. It is the dev runtime and
// the self-hoster's runtime without a cluster.
package docker

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/decocms/studio/packages/sandbox/controller-go/daemonclient"
	"github.com/decocms/studio/packages/sandbox/controller-go/protocol"
	"github.com/decocms/studio/packages/sandbox/controller-go/runtime"
	"github.com/decocms/studio/packages/sandbox/controller-go/store"
)

// Name is the runtime recorded in sandbox_provider_kind.
const Name = "docker"

// Capabilities: no warm pool, no pre-ready phases (a started container is
// one health probe from ready), no capacity probe (one machine, and the
// engine does not say "full").
var Capabilities = []protocol.Capability{
	protocol.CapPreview,
	protocol.CapTerminationReason,
	protocol.CapTTLExtend,
}

// Labels on every container this runtime creates.
const (
	labelRuntime = "sandbox.deco.cx/runtime"
	labelHandle  = "sandbox.deco.cx/handle"
	labelImage   = "sandbox.deco.cx/image"
)

const (
	defaultWorkdir   = "/app"
	defaultIdleTTL   = 15 * time.Minute
	defaultStopGrace = 90 * time.Second
	defaultReadyWait = 60 * time.Second
	probeTimeout     = 5 * time.Second
	// expiryRetry re-arms an idle expiry whose removal failed.
	expiryRetry = time.Minute
)

type Config struct {
	// Images maps a sandbox image name to a docker image; "default" is required
	// and serves every request whose image is not listed.
	Images map[string]string
	// IdleTTL is the window each ensure and renewal pushes shutdown out to.
	IdleTTL time.Duration
	// StopGrace is `docker stop --time`: the daemon publishes the working tree
	// on SIGTERM and needs the same margin the pod's grace period gives it.
	StopGrace time.Duration
	// ReadyWait bounds a started container's wait for its daemon's /health.
	ReadyWait time.Duration
	// Memory and CPUs are docker's --memory and --cpus; empty is unlimited.
	Memory, CPUs string
	// Labels are stamped on every container and scope the ones this
	// controller re-arms at boot, so two controllers can share an engine.
	Labels map[string]string
	Studio daemonclient.Studio
}

type Deps struct {
	Store store.Store
	// Exec defaults to CLI.
	Exec Exec
	// DaemonTransport overrides the transport daemon calls use (tests).
	DaemonTransport http.RoundTripper
}

// Runner is the docker runtime.
type Runner struct {
	cfg      Config
	store    store.Store
	exec     Exec
	daemon   *daemonclient.Client
	now      func() time.Time
	newToken func() string
	poll     time.Duration

	mu     sync.Mutex
	idle   map[string]*idleTimer
	gen    uint64
	closed bool
}

type idleTimer struct {
	timer    *time.Timer
	deadline time.Time
	gen      uint64
}

var _ runtime.Provider = (*Runner)(nil)

func New(deps Deps, cfg Config) (*Runner, error) {
	if cfg.Images["default"] == "" {
		return nil, errors.New("the docker runtime needs a default image")
	}
	for name, image := range cfg.Images {
		if strings.TrimSpace(image) == "" {
			return nil, fmt.Errorf("docker image for %q is empty", name)
		}
	}
	if cfg.IdleTTL == 0 {
		cfg.IdleTTL = defaultIdleTTL
	}
	if cfg.StopGrace == 0 {
		cfg.StopGrace = defaultStopGrace
	}
	if cfg.ReadyWait == 0 {
		cfg.ReadyWait = defaultReadyWait
	}
	if deps.Exec == nil {
		deps.Exec = CLI
	}
	return &Runner{
		cfg:      cfg,
		store:    deps.Store,
		exec:     deps.Exec,
		daemon:   daemonclient.New(deps.DaemonTransport),
		now:      time.Now,
		newToken: daemonclient.NewToken,
		poll:     200 * time.Millisecond,
		idle:     map[string]*idleTimer{},
	}, nil
}

// Probe: the engine answers `docker version`, which needs both the CLI and
// the socket.
func (r *Runner) Probe(ctx context.Context) (bool, string) {
	ctx, cancel := context.WithTimeout(ctx, probeTimeout)
	defer cancel()
	res, err := r.run(ctx, nil, "version", "--format", "{{.Server.Version}}")
	if err != nil {
		return false, err.Error()
	}
	if res.Code != 0 {
		line, _, _ := strings.Cut(strings.TrimSpace(res.Stderr), "\n")
		if line == "" {
			line = "docker engine unreachable"
		}
		return false, line
	}
	return true, ""
}

// persisted is the state blob.
type persisted struct {
	Token        string         `json:"token"`
	Workdir      string         `json:"workdir"`
	DaemonBootID string         `json:"daemonBootId,omitempty"`
	Image        protocol.Image `json:"image"`
	// Replayed by Resurrect. Keeps the clone URL, which makes the row as
	// sensitive as the vault, as the agent-sandbox row is.
	EnsureOpts *protocol.EnsureOptions `json:"ensureOpts,omitempty"`
}

type record struct {
	id        protocol.SandboxID
	handle    string
	daemonURL string
	state     persisted
	// The row no longer matches what the container reports.
	dirty bool
}

func (r *Runner) Ensure(ctx context.Context, id protocol.SandboxID, handle string, opts protocol.EnsureOptions) (*runtime.Sandbox, error) {
	var out *runtime.Sandbox
	err := r.store.WithLock(ctx, id, Name, func(ctx context.Context) error {
		sb, err := r.ensureLocked(ctx, id, handle, opts)
		out = sb
		return err
	})
	return out, err
}

func (r *Runner) ensureLocked(ctx context.Context, id protocol.SandboxID, handle string, opts protocol.EnsureOptions) (*runtime.Sandbox, error) {
	// 1. Resume from the row.
	row, err := r.store.Get(ctx, id, Name)
	if err != nil {
		return nil, err
	}
	if row != nil {
		if row.Handle == handle {
			if rec := r.resume(ctx, id, row); rec != nil {
				r.refreshGitCredential(ctx, rec, opts)
				r.relayOrgFs(ctx, rec, opts.OrgFsConfigJSON)
				return r.finish(ctx, rec, rec.dirty)
			}
		}
		// Unusable, or recorded under another handle: that container is this
		// sandbox's previous incarnation.
		if err := r.remove(ctx, row.Handle); err != nil {
			return nil, err
		}
		r.disarm(row.Handle)
		if err := r.store.Delete(ctx, id, Name); err != nil {
			return nil, err
		}
	}

	// 2. A container under our name with no usable row.
	c, err := r.inspect(ctx, handle)
	if err != nil {
		return nil, err
	}
	if c != nil {
		if !r.owns(c) {
			return nil, &runtime.Error{Code: protocol.ErrHandleConflict, Message: fmt.Sprintf("a container named %s exists that this runtime did not create; it is left alone", handle)}
		}
		if rec := r.adopt(ctx, id, handle, opts, c); rec != nil {
			r.refreshGitCredential(ctx, rec, opts)
			r.relayOrgFs(ctx, rec, opts.OrgFsConfigJSON)
			return r.finish(ctx, rec, true)
		}
		if err := r.remove(ctx, handle); err != nil {
			return nil, err
		}
	}

	// 3. Fresh provision.
	rec, err := r.provision(ctx, id, handle, opts)
	if err != nil {
		return nil, err
	}
	return r.finish(ctx, rec, true)
}
