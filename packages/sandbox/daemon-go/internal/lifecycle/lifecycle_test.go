package lifecycle

import (
	"sync"
	"testing"

	"github.com/decocms/studio/sandbox-daemon/internal/events"
)

type nopBroadcaster struct{}

func (nopBroadcaster) Emit(string, any) {}

type recorder struct {
	mu   sync.Mutex
	seen []string
	ms   []int64
}

func (r *recorder) record(status string, durationMs int64) {
	r.mu.Lock()
	r.seen = append(r.seen, status)
	r.ms = append(r.ms, durationMs)
	r.mu.Unlock()
}

func newManager() (*Manager, *recorder) {
	rec := &recorder{}
	m := New(nopBroadcaster{})
	m.OnStartPhase = rec.record
	return m, rec
}

func running() events.LifecycleState {
	return events.LifecycleState{Phase: events.PhaseRunning, Port: 3000}
}

// Spawning proves nothing about whether the dev server serves, so nothing may
// be reported until a terminal state arrives.
func TestStartPhaseReportedOnRunning(t *testing.T) {
	m, rec := newManager()
	m.NoteStartAttempt()
	m.Transition(events.LifecycleState{Phase: events.PhaseStarting})
	if len(rec.seen) != 0 {
		t.Fatalf("reported before the server was reachable: %v", rec.seen)
	}
	m.Transition(running())
	if len(rec.seen) != 1 || rec.seen[0] != "done" {
		t.Fatalf("want one done, got %v", rec.seen)
	}
}

func TestStartPhaseReportedAsFailed(t *testing.T) {
	m, rec := newManager()
	m.NoteStartAttempt()
	m.Transition(events.LifecycleState{Phase: events.PhaseStartFailed, Error: "exit 1"})
	if len(rec.seen) != 1 || rec.seen[0] != "failed" {
		t.Fatalf("want one failed, got %v", rec.seen)
	}
}

func TestSkippedStartOpensNoPhase(t *testing.T) {
	m, rec := newManager()
	m.NoteStartAttempt()
	m.CancelStartAttempt()
	m.Transition(running())
	if len(rec.seen) != 0 {
		t.Fatalf("a skipped start reported a phase: %v", rec.seen)
	}
}

// A crash and recovery is a restart, not a second start phase.
func TestOneAttemptReportsOnce(t *testing.T) {
	m, rec := newManager()
	m.NoteStartAttempt()
	m.Transition(running())
	m.Transition(events.LifecycleState{Phase: events.PhaseCrashed})
	m.Transition(running())
	if len(rec.seen) != 1 {
		t.Fatalf("want one report, got %v", rec.seen)
	}
}

func TestNoAttemptReportsNothing(t *testing.T) {
	m, rec := newManager()
	m.Transition(running())
	m.Transition(events.LifecycleState{Phase: events.PhaseStartFailed, Error: "unrelated"})
	if len(rec.seen) != 0 {
		t.Fatalf("reported without an attempt: %v", rec.seen)
	}
}

// The watchdog's give-up is a verdict its last respawn can still refute by
// serving minutes later. That late boot is the only measurement of how long
// this sandbox actually needs, and it used to be discarded: start-failed
// closed the attempt, so the recovering `running` reported nothing and the
// watchdog kept the short restart grace on the very sandboxes too slow for it.
func TestLateRecoveryStillReportsTheBoot(t *testing.T) {
	m, rec := newManager()
	m.NoteStartAttempt()
	m.Transition(events.LifecycleState{Phase: events.PhaseStartFailed, Error: "gave up"})
	m.Transition(running())
	if len(rec.seen) != 2 || rec.seen[0] != "failed" || rec.seen[1] != "done" {
		t.Fatalf("want failed then done, got %v", rec.seen)
	}
	if rec.ms[1] < rec.ms[0] {
		t.Fatalf("the recovered boot must span the whole attempt: %v", rec.ms)
	}
	// The attempt is closed by the recovery, so a later crash/recovery cycle is
	// not a third report.
	m.Transition(events.LifecycleState{Phase: events.PhaseCrashed})
	m.Transition(running())
	if len(rec.seen) != 2 {
		t.Fatalf("recovery must close the attempt, got %v", rec.seen)
	}
}

// One attempt reports "failed" once, however many times it re-enters the phase.
func TestRepeatedStartFailedReportsOnce(t *testing.T) {
	m, rec := newManager()
	m.NoteStartAttempt()
	m.Transition(events.LifecycleState{Phase: events.PhaseStartFailed, Error: "first"})
	m.Transition(events.LifecycleState{Phase: events.PhaseCrashed})
	m.Transition(events.LifecycleState{Phase: events.PhaseStartFailed, Error: "second"})
	if len(rec.seen) != 1 || rec.seen[0] != "failed" {
		t.Fatalf("want one failed, got %v", rec.seen)
	}
}
