package agentsandbox

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/decocms/studio/packages/sandbox/controller-go/protocol"
)

// Cases beyond tenant-pools.test.ts; the ported ones are in tenant_pools_test.go.
func TestTemplateResolver(t *testing.T) {
	ctx := context.Background()
	now := time.Unix(1_000_000, 0)

	t.Run("the base template reports the default image served", func(t *testing.T) {
		got, _ := newResolver("studio-sandbox", &fakeTemplates{}, &now, nil).resolve(ctx, protocol.PurposeInteractive, nil, "")
		if got.image != "default" {
			t.Fatalf("got %+v", got)
		}
	})

	t.Run("cached absence holds inside the TTL", func(t *testing.T) {
		clock := now
		f := &fakeTemplates{present: map[string]bool{}}
		r := newResolver("studio-sandbox", f, &clock, nil)
		_, _ = r.resolve(ctx, protocol.PurposeHarnessRun, nil, "")
		f.present["studio-sandbox-medium"] = true
		clock = clock.Add(templateProbeTTL - time.Second)
		if got, _ := r.resolve(ctx, protocol.PurposeHarnessRun, nil, ""); got.name != "studio-sandbox" {
			t.Fatalf("got %q", got.name)
		}
	})

	t.Run("an API error is not a missing template", func(t *testing.T) {
		f := &fakeTemplates{err: errors.New("apiserver down")}
		if _, err := newResolver("studio-sandbox", f, &now, nil).resolve(ctx, protocol.PurposeHarnessRun, nil, ""); err == nil {
			t.Fatal("want the error")
		}
	})
}
