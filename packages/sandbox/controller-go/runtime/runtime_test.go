package runtime

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/decocms/studio/packages/sandbox/controller-go/protocol"
)

// stub is a Provider whose answers the test sets; only the registry-facing
// methods matter here.
type stub struct {
	Provider
	ok          bool
	reason      string
	schedulable bool
	// full images are unschedulable whatever schedulable says.
	full     map[string]bool
	schedErr error
	asked    []string
	images   []protocol.ImageInfo
	probes   int
	capCalls int
}

func (s *stub) Probe(context.Context) (bool, string) { s.probes++; return s.ok, s.reason }
func (s *stub) Schedulable(_ context.Context, image string) (bool, error) {
	s.capCalls++
	s.asked = append(s.asked, image)
	return s.schedulable && !s.full[image], s.schedErr
}
func (s *stub) Images(context.Context) ([]protocol.ImageInfo, error) { return s.images, nil }

func rt(name string, priority int, p *stub, caps ...protocol.Capability) *Runtime {
	return &Runtime{Name: name, Priority: priority, Provider: p, Capabilities: append([]protocol.Capability{protocol.CapCapacity}, caps...)}
}

func TestPlace(t *testing.T) {
	ctx := context.Background()
	up := func() *stub { return &stub{ok: true, schedulable: true} }
	android := []protocol.ImageInfo{{Name: "android"}}
	for _, tc := range []struct {
		name     string
		runtimes func() []*Runtime
		req      protocol.EnsureRequest
		want     string
		reasons  map[string]string
	}{
		{
			name:     "priority order, lower first",
			runtimes: func() []*Runtime { return []*Runtime{rt("b", 20, up()), rt("a", 10, up())} },
			want:     "a",
		},
		{
			name: "unavailable and full runtimes are skipped",
			runtimes: func() []*Runtime {
				return []*Runtime{rt("down", 1, &stub{reason: "no docker socket"}), rt("full", 2, &stub{ok: true}), rt("ok", 3, up())}
			},
			want: "ok",
		},
		{
			name: "a named runtime is a hard constraint",
			runtimes: func() []*Runtime {
				return []*Runtime{rt("docker", 1, up()), rt("agent-sandbox", 2, &stub{reason: "forbidden"})}
			},
			req:     protocol.EnsureRequest{Runtime: "agent-sandbox"},
			reasons: map[string]string{"agent-sandbox": "forbidden"},
		},
		{
			name: "allowFallback lets a named runtime's failure go elsewhere",
			runtimes: func() []*Runtime {
				return []*Runtime{rt("docker", 1, up()), rt("agent-sandbox", 2, &stub{reason: "forbidden"})}
			},
			req:  protocol.EnsureRequest{Runtime: "agent-sandbox", AllowFallback: true},
			want: "docker",
		},
		{
			name:     "an unknown named runtime is refused",
			runtimes: func() []*Runtime { return []*Runtime{rt("a", 1, up())} },
			req:      protocol.EnsureRequest{Runtime: "nope"},
			reasons:  map[string]string{"nope": "unknown runtime"},
		},
		{
			name:     "a missing required capability disqualifies",
			runtimes: func() []*Runtime { return []*Runtime{rt("a", 1, up()), rt("b", 2, up(), protocol.CapPreview)} },
			req:      protocol.EnsureRequest{Requires: []protocol.Capability{protocol.CapPreview}},
			want:     "b",
		},
		{
			name: "a runtime serving the image wins before priority",
			runtimes: func() []*Runtime {
				s := up()
				s.images = android
				return []*Runtime{rt("a", 1, up()), rt("b", 2, s)}
			},
			req:  protocol.EnsureRequest{Opts: &protocol.EnsureOptions{SandboxImage: "android"}},
			want: "b",
		},
		{
			name:     "nobody serves the image: the first qualifying one degrades",
			runtimes: func() []*Runtime { return []*Runtime{rt("a", 1, up()), rt("b", 2, up())} },
			req:      protocol.EnsureRequest{Opts: &protocol.EnsureOptions{SandboxImage: "android"}},
			want:     "a",
		},
		{
			name: "a named runtime still wins over the image",
			runtimes: func() []*Runtime {
				s := up()
				s.images = android
				return []*Runtime{rt("a", 1, up()), rt("b", 2, s)}
			},
			req:  protocol.EnsureRequest{Runtime: "a", Opts: &protocol.EnsureOptions{SandboxImage: "android"}},
			want: "a",
		},
		{
			// KVM nodes full, general nodes idle: the android request must not
			// be admitted on the fleet aggregate.
			name: "capacity is judged for the requested image's nodes",
			runtimes: func() []*Runtime {
				a := up()
				a.images, a.full = android, map[string]bool{"android": true}
				return []*Runtime{rt("a", 1, a), rt("b", 2, up())}
			},
			req:  protocol.EnsureRequest{Opts: &protocol.EnsureOptions{SandboxImage: "android"}},
			want: "b",
		},
		{
			name: "a full variant does not stop the default image",
			runtimes: func() []*Runtime {
				a := up()
				a.images, a.full = android, map[string]bool{"android": true}
				return []*Runtime{rt("a", 1, a), rt("b", 2, up())}
			},
			want: "a",
		},
		{
			name:     "nothing qualifies: one reason per runtime",
			runtimes: func() []*Runtime { return []*Runtime{rt("a", 1, &stub{reason: "down"}), rt("b", 2, &stub{ok: true})} },
			reasons:  map[string]string{"a": "down", "b": "no capacity"},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p := Place(ctx, NewRegistry(tc.runtimes()...), tc.req)
			got := ""
			if p.Runtime != nil {
				got = p.Runtime.Name
			}
			if got != tc.want {
				t.Fatalf("placed on %q, want %q (reasons %v)", got, tc.want, p.Reasons)
			}
			if tc.reasons != nil {
				for k, v := range tc.reasons {
					if p.Reasons[k] != v {
						t.Fatalf("reasons = %v, want %v", p.Reasons, tc.reasons)
					}
				}
			}
		})
	}
}

func TestRegistryCaches(t *testing.T) {
	ctx := context.Background()
	s := &stub{ok: true, schedErr: errors.New("list pods: forbidden")}
	reg := NewRegistry(rt("a", 1, s))
	now := time.Unix(0, 0)
	reg.now = func() time.Time { return now }
	for i := 0; i < 5; i++ {
		reg.Available(ctx, reg.Get("a"))
		// A probe that cannot answer admits: it must not become a global stop.
		if !reg.Schedulable(ctx, reg.Get("a"), "") {
			t.Fatal("capacity probe failed closed")
		}
	}
	if s.probes != 1 || s.capCalls != 1 {
		t.Fatalf("probes=%d capacity=%d within the TTLs", s.probes, s.capCalls)
	}
	// Per image: a variant's nodes fill independently. "default" is "".
	reg.Schedulable(ctx, reg.Get("a"), "default")
	reg.Schedulable(ctx, reg.Get("a"), "android")
	reg.Schedulable(ctx, reg.Get("a"), "android")
	if s.capCalls != 2 || s.asked[1] != "android" {
		t.Fatalf("capacity calls = %v, want one per image", s.asked)
	}
	now = now.Add(capacityTTL + time.Millisecond)
	reg.Schedulable(ctx, reg.Get("a"), "")
	now = now.Add(probeTTL)
	reg.Available(ctx, reg.Get("a"))
	if s.probes != 2 || s.capCalls != 3 {
		t.Fatalf("expired entries not re-probed: probes=%d capacity=%d", s.probes, s.capCalls)
	}
	// Without the capacity capability the runtime always admits and is never asked.
	noCap := &stub{ok: true}
	reg = NewRegistry(&Runtime{Name: "n", Provider: noCap})
	if !reg.Schedulable(ctx, reg.Get("n"), "") || noCap.capCalls != 0 {
		t.Fatal("a runtime without the capacity capability must not be probed")
	}
}
