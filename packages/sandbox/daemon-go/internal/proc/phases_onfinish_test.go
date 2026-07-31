package proc

import (
	"sync"
	"testing"
)

type finished struct {
	name, status string
	durationMs   int64
}

func collect(p *PhaseManager) *[]finished {
	var mu sync.Mutex
	got := []finished{}
	p.OnFinish = func(name, status string, durationMs int64) {
		mu.Lock()
		defer mu.Unlock()
		got = append(got, finished{name, status, durationMs})
	}
	return &got
}

func TestOnFinishReportsNameAndStatus(t *testing.T) {
	p := NewPhaseManager()
	got := collect(p)

	p.Done(p.Begin("install"))
	p.Fail(p.Begin("dev"), "boom")

	if len(*got) != 2 {
		t.Fatalf("want 2 callbacks, got %d: %+v", len(*got), *got)
	}
	if (*got)[0].name != "install" || (*got)[0].status != "done" {
		t.Errorf("first: %+v", (*got)[0])
	}
	// A failed phase produced a duration but not a sandbox. Averaging it in with
	// successes hides exactly the regression a canary is looking for, so the
	// status has to reach the metric attribute.
	if (*got)[1].name != "dev" || (*got)[1].status != "failed" {
		t.Errorf("second: %+v", (*got)[1])
	}
	for _, f := range *got {
		if f.durationMs < 0 {
			t.Errorf("negative duration: %+v", f)
		}
	}
}

func TestOnFinishFiresOncePerPhase(t *testing.T) {
	p := NewPhaseManager()
	got := collect(p)

	id := p.Begin("clone")
	p.Done(id)
	// finish() is a no-op on an already-terminal phase. Emitting anyway would
	// double-count every phase that gets a redundant Done/Fail, silently
	// inflating the boot-cost histogram.
	p.Done(id)
	p.Fail(id, "late")

	if len(*got) != 1 {
		t.Fatalf("want exactly 1 callback, got %d: %+v", len(*got), *got)
	}
}

func TestOnFinishUnsetIsSafe(t *testing.T) {
	// The default for every non-OTLP deploy (desktop, local dev, CI).
	p := NewPhaseManager()
	p.Done(p.Begin("install"))
	p.Fail(p.Begin("dev"), "boom")

	if len(p.Recent(10)) != 2 {
		t.Fatalf("phases should still be tracked without a hook")
	}
}
