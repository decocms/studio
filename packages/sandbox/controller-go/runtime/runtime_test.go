package runtime

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/decocms/studio/sandbox-controller/protocol"
)

// stub is a Provider that only answers the capacity probe; placement never
// touches the rest.
type stub struct {
	schedulable bool
	err         error
}

func (s stub) Ensure(context.Context, protocol.SandboxID, string, *protocol.EnsureOptions) (*Sandbox, error) {
	return nil, nil
}
func (s stub) Delete(context.Context, string) error                     { return nil }
func (s stub) Alive(context.Context, string) (bool, error)              { return false, nil }
func (s stub) Daemon(context.Context, string) (*protocol.Daemon, error) { return nil, nil }
func (s stub) PreviewURL(context.Context, string) (*string, error)      { return nil, nil }
func (s stub) LastTermination(context.Context, string) (*protocol.PodTermination, error) {
	return nil, nil
}
func (s stub) RenewTTL(context.Context, string) error                          { return nil }
func (s stub) ReleaseAfter(context.Context, string, time.Duration) error       { return nil }
func (s stub) Adopt(context.Context, protocol.SandboxID, string) (bool, error) { return false, nil }
func (s stub) Watch(context.Context, string) (<-chan Phase, error)             { return nil, nil }
func (s stub) Schedulable(context.Context) (bool, error)                       { return s.schedulable, s.err }
func (s stub) Close()                                                          {}

type opt func(*Runtime, *stub)

func unavailable(reason string) opt {
	return func(r *Runtime, _ *stub) {
		r.Probe = func(context.Context) (bool, string) { return false, reason }
	}
}
func full() opt { return func(_ *Runtime, s *stub) { s.schedulable = false } }
func noPreview() opt {
	return func(r *Runtime, _ *stub) { r.Capabilities = []protocol.Capability{protocol.CapCapacity} }
}
func probeErrors() opt {
	return func(_ *Runtime, s *stub) { s.err = errors.New("apiserver down") }
}

func rt(name string, priority int, opts ...opt) *Runtime {
	s := &stub{schedulable: true}
	r := &Runtime{
		Name:         name,
		Priority:     priority,
		Capabilities: []protocol.Capability{protocol.CapPreview, protocol.CapCapacity},
		Probe:        func(context.Context) (bool, string) { return true, "" },
	}
	for _, o := range opts {
		o(r, s)
	}
	r.Provider = s
	return r
}

func TestPlaceTakesPriorityOrder(t *testing.T) {
	reg := NewRegistry([]*Runtime{rt("slow", 20), rt("fast", 10)})
	got := Place(context.Background(), reg, protocol.EnsureRequest{})
	if got.Runtime == nil || got.Runtime.Name != "fast" {
		t.Fatalf("want fast, got %+v", got)
	}
}

func TestPlaceSkipsUnusable(t *testing.T) {
	reg := NewRegistry([]*Runtime{
		rt("down", 10, unavailable("no kubeconfig")),
		rt("full", 20, full()),
		rt("plain", 30, noPreview()),
		rt("good", 40),
	})
	got := Place(context.Background(), reg, protocol.EnsureRequest{
		Requires: []protocol.Capability{protocol.CapPreview},
	})
	if got.Runtime == nil || got.Runtime.Name != "good" {
		t.Fatalf("want good, got %+v", got)
	}
}

func TestPlaceReportsWhyNothingQualifies(t *testing.T) {
	reg := NewRegistry([]*Runtime{
		rt("down", 10, unavailable("no kubeconfig")),
		rt("full", 20, full()),
	})
	got := Place(context.Background(), reg, protocol.EnsureRequest{})
	if got.Runtime != nil {
		t.Fatalf("want no placement, got %s", got.Runtime.Name)
	}
	if got.Reasons["down"] != "no kubeconfig" || got.Reasons["full"] != "no capacity" {
		t.Fatalf("unexpected reasons: %v", got.Reasons)
	}
}

// A named runtime is a hard constraint: an org pinned to one is pinned for a
// reason, and quietly honouring the opposite is worse than not serving.
func TestNamedRuntimeDoesNotSilentlyFallBack(t *testing.T) {
	reg := NewRegistry([]*Runtime{
		rt("pinned", 10, unavailable("not configured")),
		rt("other", 20),
	})
	denied := Place(context.Background(), reg, protocol.EnsureRequest{Runtime: "pinned"})
	if denied.Runtime != nil {
		t.Fatalf("pinned request must not fall back, got %s", denied.Runtime.Name)
	}
	allowed := Place(context.Background(), reg, protocol.EnsureRequest{Runtime: "pinned", AllowFallback: true})
	if allowed.Runtime == nil || allowed.Runtime.Name != "other" {
		t.Fatalf("want other with fallback, got %+v", allowed)
	}
}

func TestUnknownRuntimeIsRejected(t *testing.T) {
	reg := NewRegistry([]*Runtime{rt("only", 10)})
	got := Place(context.Background(), reg, protocol.EnsureRequest{Runtime: "lambda-microvm"})
	if got.Runtime != nil || got.Reasons["lambda-microvm"] != "unknown runtime" {
		t.Fatalf("unexpected: %+v", got)
	}
}

// A capacity probe that cannot answer must not become an admission stop —
// that is what a runtime with no probe at all already does.
func TestCapacityErrorAdmits(t *testing.T) {
	broken := rt("flaky", 10, probeErrors())
	reg := NewRegistry([]*Runtime{broken})
	if !reg.Schedulable(context.Background(), broken) {
		t.Fatal("a failed capacity probe must not block admission")
	}
}

func TestRuntimeWithoutCapacityCapabilityIsAlwaysSchedulable(t *testing.T) {
	plain := rt("plain", 10, noPreview())
	plain.Capabilities = nil
	reg := NewRegistry([]*Runtime{plain})
	if !reg.Schedulable(context.Background(), plain) {
		t.Fatal("a runtime that declares no capacity probe is always admissible")
	}
}
