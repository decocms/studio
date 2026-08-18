// Package runtime is the registry: every configured runtime is live at once,
// and one is picked per ensure. Which runtime serves a handle is a runtime
// decision, never a deployment decision — but it is decided ONCE and
// persisted, because a handle whose runtime can be re-decided is a leaked
// sandbox on the runtime nobody looks at any more.
package runtime

import (
	"context"
	"sort"
	"sync"
	"time"

	"github.com/decocms/studio/sandbox-controller/protocol"
)

// Sandbox is what ensure resolves to. Daemon carries the address and the token
// studio opens it with — the controller never relays daemon bytes.
type Sandbox struct {
	Handle     string
	Workdir    string
	PreviewURL *string
	Daemon     protocol.Daemon
}

// Phase is one pre-Ready lifecycle transition. Kind is the discriminant;
// runtimes with no equivalent black hole emit a single "ready".
type Phase struct {
	Kind      string `json:"kind"`
	Since     int64  `json:"since,omitempty"`
	Message   string `json:"message,omitempty"`
	NodeClaim string `json:"nodeClaim,omitempty"`
	Reason    string `json:"reason,omitempty"`
}

// Provider is one runtime's implementation. Optional behavior is declared in
// Capabilities and may be a no-op here.
type Provider interface {
	Ensure(ctx context.Context, id protocol.SandboxID, handle string, opts *protocol.EnsureOptions) (*Sandbox, error)
	// Delete tears the sandbox down and returns once the claim is collected,
	// or ctx expires — the caller answers 202 on the latter.
	Delete(ctx context.Context, handle string) error
	Alive(ctx context.Context, handle string) (bool, error)
	// Daemon is where the daemon is and what opens it, nil when unknown.
	Daemon(ctx context.Context, handle string) (*protocol.Daemon, error)
	PreviewURL(ctx context.Context, handle string) (*string, error)
	LastTermination(ctx context.Context, handle string) (*protocol.PodTermination, error)
	// RenewTTL never brings shutdown earlier; ReleaseAfter never later.
	RenewTTL(ctx context.Context, handle string) error
	ReleaseAfter(ctx context.Context, handle string, grace time.Duration) error
	Adopt(ctx context.Context, id protocol.SandboxID, handle string) (bool, error)
	Watch(ctx context.Context, handle string) (<-chan Phase, error)
	// Schedulable is "nothing is currently unplaceable", never a reservation.
	Schedulable(ctx context.Context) (bool, error)
	Close()
}

// Runtime is a Provider plus how the registry picks it.
type Runtime struct {
	Name         string
	Priority     int // lower wins
	Capabilities []protocol.Capability
	Provider     Provider
	// Probe answers "are this runtime's credentials usable right now" — not
	// configured, probed, so a runtime coming back needs no restart.
	Probe func(context.Context) (bool, string)
}

func (r *Runtime) Has(c protocol.Capability) bool {
	for _, have := range r.Capabilities {
		if have == c {
			return true
		}
	}
	return false
}

const (
	probeTTL    = 30 * time.Second
	capacityTTL = 5 * time.Second
)

type cached[T any] struct {
	at    time.Time
	value T
}

type probeResult struct {
	ok     bool
	reason string
}

// Registry holds every configured runtime and caches their probes.
type Registry struct {
	mu         sync.Mutex
	byName     map[string]*Runtime
	ordered    []*Runtime
	probes     map[string]cached[probeResult]
	capacities map[string]cached[bool]
}

func NewRegistry(runtimes []*Runtime) *Registry {
	ordered := append([]*Runtime(nil), runtimes...)
	sort.SliceStable(ordered, func(i, j int) bool { return ordered[i].Priority < ordered[j].Priority })
	byName := make(map[string]*Runtime, len(ordered))
	for _, rt := range ordered {
		byName[rt.Name] = rt
	}
	return &Registry{
		byName:     byName,
		ordered:    ordered,
		probes:     map[string]cached[probeResult]{},
		capacities: map[string]cached[bool]{},
	}
}

func (r *Registry) Get(name string) *Runtime { return r.byName[name] }

func (r *Registry) All() []*Runtime { return r.ordered }

func (r *Registry) Close() {
	for _, rt := range r.ordered {
		rt.Provider.Close()
	}
}

func (r *Registry) Available(ctx context.Context, rt *Runtime) (bool, string) {
	r.mu.Lock()
	if hit, ok := r.probes[rt.Name]; ok && time.Since(hit.at) < probeTTL {
		r.mu.Unlock()
		return hit.value.ok, hit.value.reason
	}
	r.mu.Unlock()

	ok, reason := rt.Probe(ctx)

	r.mu.Lock()
	r.probes[rt.Name] = cached[probeResult]{at: time.Now(), value: probeResult{ok, reason}}
	r.mu.Unlock()
	return ok, reason
}

// Schedulable caches for seconds so a burst of admissions is one probe. A
// probe that cannot answer must not stop admission — that is what a runtime
// with no capacity probe at all already does.
func (r *Registry) Schedulable(ctx context.Context, rt *Runtime) bool {
	if !rt.Has(protocol.CapCapacity) {
		return true
	}
	r.mu.Lock()
	if hit, ok := r.capacities[rt.Name]; ok && time.Since(hit.at) < capacityTTL {
		r.mu.Unlock()
		return hit.value
	}
	r.mu.Unlock()

	value, err := rt.Provider.Schedulable(ctx)
	if err != nil {
		value = true
	}

	r.mu.Lock()
	r.capacities[rt.Name] = cached[bool]{at: time.Now(), value: value}
	r.mu.Unlock()
	return value
}

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
				Schedulable: r.Schedulable(ctx, rt),
				ObservedAt:  time.Now().UTC().Format(time.RFC3339),
			}
		}
		out = append(out, info)
	}
	return out
}

// Placement is the outcome of one placement decision.
type Placement struct {
	Runtime *Runtime
	Reasons map[string]string
}

// Place walks the runtimes in priority order and takes the first that is
// available, has every required capability, and reports capacity.
//
// A NAMED runtime is a hard constraint, not a preference: an org pinned to one
// is usually pinned for a reason (residency, cost, isolation), and quietly
// honouring the opposite is worse than not serving. Fallback is opt-in, and is
// what an unpinned request gets by default.
func Place(ctx context.Context, r *Registry, req protocol.EnsureRequest) Placement {
	reasons := map[string]string{}

	consider := func(rt *Runtime) bool {
		if ok, reason := r.Available(ctx, rt); !ok {
			if reason == "" {
				reason = "unavailable"
			}
			reasons[rt.Name] = reason
			return false
		}
		for _, need := range req.Requires {
			if !rt.Has(need) {
				reasons[rt.Name] = "missing capability: " + string(need)
				return false
			}
		}
		if !r.Schedulable(ctx, rt) {
			reasons[rt.Name] = "no capacity"
			return false
		}
		return true
	}

	if req.Runtime != "" {
		named := r.Get(req.Runtime)
		if named == nil {
			return Placement{Reasons: map[string]string{req.Runtime: "unknown runtime"}}
		}
		if consider(named) {
			return Placement{Runtime: named}
		}
		if !req.AllowFallback {
			return Placement{Reasons: reasons}
		}
	}

	for _, rt := range r.ordered {
		if rt.Name == req.Runtime {
			continue
		}
		if consider(rt) {
			return Placement{Runtime: rt}
		}
	}
	return Placement{Reasons: reasons}
}
