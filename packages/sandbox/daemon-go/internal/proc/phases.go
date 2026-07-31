package proc

import (
	"fmt"
	"sync"
	"time"
)

type Phase struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Status    string `json:"status"`
	StartedAt int64  `json:"startedAt"`
	DoneAt    *int64 `json:"doneAt"`
	Error     string `json:"error,omitempty"`
}

type PhaseManager struct {
	mu      sync.Mutex
	all     []*Phase
	counter int

	// OnFinish, when set, is called once per phase that reaches a terminal
	// state, with its wall-clock duration. Optional and nil by default so this
	// package keeps no dependency on the telemetry stack — main wires it up.
	// Called while the manager lock is NOT held: an exporter that blocked here
	// would stall every subsequent phase transition, i.e. the boot itself.
	OnFinish func(name, status string, durationMs int64)
}

func NewPhaseManager() *PhaseManager {
	return &PhaseManager{}
}

func (p *PhaseManager) Begin(name string) string {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.counter++
	id := fmt.Sprintf("phase%d", p.counter)
	p.all = append(p.all, &Phase{
		ID:        id,
		Name:      name,
		Status:    "running",
		StartedAt: time.Now().UnixMilli(),
	})
	return id
}

func (p *PhaseManager) Done(id string) {
	p.finish(id, "done", "")
}

func (p *PhaseManager) Fail(id, errMsg string) {
	p.finish(id, "failed", errMsg)
}

func (p *PhaseManager) finish(id, status, errMsg string) {
	var name string
	var durationMs int64
	found := false

	p.mu.Lock()
	for _, t := range p.all {
		if t.ID == id && t.Status == "running" {
			t.Status = status
			now := time.Now().UnixMilli()
			t.DoneAt = &now
			if errMsg != "" {
				t.Error = errMsg
			}
			name, durationMs, found = t.Name, now-t.StartedAt, true
			break
		}
	}
	p.mu.Unlock()

	// Outside the lock, and only for a transition that actually happened —
	// finish() is idempotent by design (a double Done must not double-count).
	if found && p.OnFinish != nil {
		p.OnFinish(name, status, durationMs)
	}
}

// Recent returns running phases plus the last maxFinished completed ones.
func (p *PhaseManager) Recent(maxFinished int) []Phase {
	p.mu.Lock()
	defer p.mu.Unlock()
	out := []Phase{}
	var finished []Phase
	for _, t := range p.all {
		if t.Status == "running" {
			out = append(out, *t)
		} else {
			finished = append(finished, *t)
		}
	}
	if len(finished) > maxFinished {
		finished = finished[len(finished)-maxFinished:]
	}
	return append(out, finished...)
}
