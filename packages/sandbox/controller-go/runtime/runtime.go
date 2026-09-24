// Package runtime is the registry of sandbox runtimes. Every configured runtime
// is live at once; one is picked per new handle and persisted with it, and
// every later call routes on the persisted one.
package runtime

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"sync"
	"time"

	"github.com/decocms/studio/packages/sandbox/controller-go/protocol"
)

// Sandbox is what ensure resolves to.
type Sandbox struct {
	Handle          string
	Workdir         string
	PreviewURL      *string
	Daemon          protocol.Daemon
	Image           protocol.Image
	WarmPoolAdopted bool
}

// Described is what a runtime knows about a recorded handle; nil fields are
// unknown.
type Described struct {
	Daemon     *protocol.Daemon
	PreviewURL *string
	Image      *protocol.Image
}

// Provider is one runtime's implementation, mirroring Studio's SandboxProvider.
type Provider interface {
	// Probe answers whether the runtime's credentials work right now.
	Probe(ctx context.Context) (ok bool, reason string)
	// Ensure is idempotent by handle and returns once the daemon is healthy and
	// configured.
	Ensure(ctx context.Context, id protocol.SandboxID, handle string, opts protocol.EnsureOptions) (*Sandbox, error)
	// Delete returns once the sandbox is gone, or with ctx's error when the
	// deadline passes first.
	Delete(ctx context.Context, handle string) error
	Alive(ctx context.Context, handle string) (bool, error)
	Describe(ctx context.Context, handle string) (*Described, error)
	// Resurrect re-provisions a reaped sandbox from its persisted options.
	// False when there is nothing to replay.
	Resurrect(ctx context.Context, handle string) (bool, error)
	LastTermination(ctx context.Context, handle string) (*protocol.PodTermination, error)
	// RenewTTL never brings shutdown earlier; ReleaseAfter never later.
	RenewTTL(ctx context.Context, handle string) error
	ReleaseAfter(ctx context.Context, handle string, grace time.Duration) error
	// RotateCredential pushes a new clone URL for the same repository.
	RotateCredential(ctx context.Context, handle, cloneURL string) error
	// Watch streams phases until a terminal one or ctx ends.
	Watch(ctx context.Context, handle string) (<-chan protocol.Phase, error)
	// Schedulable judges the nodes a sandbox on image would land on.
	Schedulable(ctx context.Context, image string) (bool, error)
	// Images are the non-default images the runtime can serve.
	Images(ctx context.Context) ([]protocol.ImageInfo, error)
	Close()
}

// TenantPools is a Provider that warms per-tenant pools off a repository.
type TenantPools interface {
	// MarkTenantPoolsDirty names the pools a push to repo's ref made stale.
	MarkTenantPoolsDirty(repo, ref string) []string
}

// Runtime is a Provider plus how the registry picks it.
type Runtime struct {
	Name         string
	Priority     int // lower wins
	Capabilities []protocol.Capability
	Provider     Provider
}

func (r *Runtime) Has(c protocol.Capability) bool {
	for _, have := range r.Capabilities {
		if have == c {
			return true
		}
	}
	return false
}

// Error is a failure with a code Studio can act on.
type Error struct {
	Code    protocol.ErrorCode
	Message string
	// Status is the daemon's HTTP status, when a daemon answered.
	Status int
	Err    error
}

func (e *Error) Error() string {
	if e.Err != nil {
		return fmt.Sprintf("%s: %v", e.Message, e.Err)
	}
	return e.Message
}

func (e *Error) Unwrap() error { return e.Err }

// CodeOf is the code of the first *Error in err's chain, or internal.
func CodeOf(err error) (protocol.ErrorCode, *Error) {
	var re *Error
	if errors.As(err, &re) {
		return re.Code, re
	}
	return protocol.ErrInternal, nil
}

const (
	probeTTL = 30 * time.Second
	// capacityTTL is short: a pod becoming schedulable is exactly what a
	// parked run is waiting for.
	capacityTTL = 3 * time.Second
	imagesTTL   = 30 * time.Second
)

type cached[T any] struct {
	at    time.Time
	value T
}

type probeResult struct {
	ok     bool
	reason string
}

// Registry holds every configured runtime and caches what it asks them.
type Registry struct {
	now     func() time.Time
	mu      sync.Mutex
	byName  map[string]*Runtime
	ordered []*Runtime
	probes  map[string]cached[probeResult]
	// Keyed by runtime, then image: a variant's nodes fill independently.
	capacities map[string]map[string]cached[bool]
	images     map[string]cached[[]protocol.ImageInfo]
}

func NewRegistry(runtimes ...*Runtime) *Registry {
	ordered := append([]*Runtime(nil), runtimes...)
	sort.SliceStable(ordered, func(i, j int) bool { return ordered[i].Priority < ordered[j].Priority })
	byName := make(map[string]*Runtime, len(ordered))
	for _, rt := range ordered {
		byName[rt.Name] = rt
	}
	return &Registry{
		now:        time.Now,
		byName:     byName,
		ordered:    ordered,
		probes:     map[string]cached[probeResult]{},
		capacities: map[string]map[string]cached[bool]{},
		images:     map[string]cached[[]protocol.ImageInfo]{},
	}
}

func (r *Registry) Get(name string) *Runtime { return r.byName[name] }

func (r *Registry) All() []*Runtime { return r.ordered }

func (r *Registry) Close() {
	for _, rt := range r.ordered {
		rt.Provider.Close()
	}
}

// Available is the runtime's cached probe; the TTL is the re-probe timer.
func (r *Registry) Available(ctx context.Context, rt *Runtime) (bool, string) {
	r.mu.Lock()
	hit, ok := r.probes[rt.Name]
	r.mu.Unlock()
	if ok && r.now().Sub(hit.at) < probeTTL {
		return hit.value.ok, hit.value.reason
	}
	res := probeResult{}
	res.ok, res.reason = rt.Provider.Probe(ctx)
	if !res.ok && res.reason == "" {
		res.reason = "unavailable"
	}
	r.mu.Lock()
	r.probes[rt.Name] = cached[probeResult]{at: r.now(), value: res}
	r.mu.Unlock()
	return res.ok, res.reason
}

// Schedulable fails open: a probe that cannot answer must not become a global
// stop on admission.
func (r *Registry) Schedulable(ctx context.Context, rt *Runtime, image string) bool {
	if !rt.Has(protocol.CapCapacity) {
		return true
	}
	if IsDefaultImage(image) {
		image = ""
	}
	r.mu.Lock()
	hit, ok := r.capacities[rt.Name][image]
	r.mu.Unlock()
	if ok && r.now().Sub(hit.at) < capacityTTL {
		return hit.value
	}
	value, err := rt.Provider.Schedulable(ctx, image)
	if err != nil {
		value = true
	}
	r.mu.Lock()
	if r.capacities[rt.Name] == nil {
		r.capacities[rt.Name] = map[string]cached[bool]{}
	}
	r.capacities[rt.Name][image] = cached[bool]{at: r.now(), value: value}
	r.mu.Unlock()
	return value
}

// Images is the runtime's image list, cached; an error reads as none.
func (r *Registry) Images(ctx context.Context, rt *Runtime) []protocol.ImageInfo {
	r.mu.Lock()
	hit, ok := r.images[rt.Name]
	r.mu.Unlock()
	if ok && r.now().Sub(hit.at) < imagesTTL {
		return hit.value
	}
	value, err := rt.Provider.Images(ctx)
	if err != nil {
		value = nil
	}
	r.mu.Lock()
	r.images[rt.Name] = cached[[]protocol.ImageInfo]{at: r.now(), value: value}
	r.mu.Unlock()
	return value
}

// Serves reports whether rt can run image. The default image is served by
// every runtime.
func (r *Registry) Serves(ctx context.Context, rt *Runtime, image string) bool {
	if IsDefaultImage(image) {
		return true
	}
	for _, have := range r.Images(ctx, rt) {
		if have.Name == image {
			return true
		}
	}
	return false
}

func IsDefaultImage(image string) bool { return image == "" || image == "default" }

func (r *Registry) Describe(ctx context.Context) []protocol.RuntimeInfo {
	out := make([]protocol.RuntimeInfo, 0, len(r.ordered))
	for _, rt := range r.ordered {
		ok, reason := r.Available(ctx, rt)
		info := protocol.RuntimeInfo{
			Name:         rt.Name,
			Available:    ok,
			Reason:       reason,
			Capabilities: rt.Capabilities,
			Priority:     rt.Priority,
		}
		if ok {
			info.Capacity = &protocol.Capacity{
				Schedulable: r.Schedulable(ctx, rt, ""),
				ObservedAt:  r.now().UTC().Format(time.RFC3339),
			}
		}
		out = append(out, info)
	}
	return out
}

// Placement is one placement decision: a runtime, or the reason each was
// skipped.
type Placement struct {
	Runtime *Runtime
	Reasons map[string]string
}

// Place picks a runtime for a new handle.
//
// A named runtime is a hard constraint: an org pinned to one is pinned for a
// reason. Otherwise (or with allowFallback) it walks runtimes in priority
// order, skips unavailable, incapable and full ones, and prefers one that
// serves the requested image before priority. No scoring.
func Place(ctx context.Context, r *Registry, req protocol.EnsureRequest) Placement {
	reasons := map[string]string{}
	image := ""
	if req.Opts != nil {
		image = req.Opts.SandboxImage
	}
	consider := func(rt *Runtime) bool {
		if ok, reason := r.Available(ctx, rt); !ok {
			reasons[rt.Name] = reason
			return false
		}
		for _, need := range req.Requires {
			if !rt.Has(need) {
				reasons[rt.Name] = "missing capability: " + string(need)
				return false
			}
		}
		if !r.Schedulable(ctx, rt, image) {
			reasons[rt.Name] = "no capacity"
			return false
		}
		return true
	}

	if req.Runtime != "" {
		named := r.Get(req.Runtime)
		if named == nil {
			reasons[req.Runtime] = "unknown runtime"
		} else if consider(named) {
			return Placement{Runtime: named}
		}
		if !req.AllowFallback {
			return Placement{Reasons: reasons}
		}
	}

	var first *Runtime
	for _, rt := range r.ordered {
		if rt.Name == req.Runtime || !consider(rt) {
			continue
		}
		if r.Serves(ctx, rt, image) {
			return Placement{Runtime: rt}
		}
		if first == nil {
			first = rt
		}
	}
	if first != nil {
		return Placement{Runtime: first}
	}
	return Placement{Reasons: reasons}
}
