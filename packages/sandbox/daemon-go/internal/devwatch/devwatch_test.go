package devwatch

import (
	"testing"
	"time"
)

var epoch = time.Unix(1_700_000_000, 0)

func cfg() Config {
	return Config{Grace: 20 * time.Second, StableWindow: 60 * time.Second, MaxRestarts: 3}
}

// A dead-but-known-port server, past grace, in a restartable phase → restart.
func TestTracker_RestartsDeadServer(t *testing.T) {
	tr := NewTracker(cfg())
	// t=0: port just became known, not serving → arms the clock, no restart yet.
	if a := tr.Observe(Snapshot{Now: epoch, Restartable: true, PortKnown: true}); a != ActionNone {
		t.Fatalf("t=0 want None, got %v", a)
	}
	// t=19s: still within grace.
	if a := tr.Observe(Snapshot{Now: epoch.Add(19 * time.Second), Restartable: true, PortKnown: true}); a != ActionNone {
		t.Fatalf("t=19 want None, got %v", a)
	}
	// t=20s: grace elapsed → restart.
	if a := tr.Observe(Snapshot{Now: epoch.Add(20 * time.Second), Restartable: true, PortKnown: true}); a != ActionRestart {
		t.Fatalf("t=20 want Restart, got %v", a)
	}
	if tr.Attempts() != 1 {
		t.Fatalf("want 1 attempt, got %d", tr.Attempts())
	}
}

// The blocker regression: time spent unreachable *before* a port is known (a
// slow install) must NOT count toward grace. When the port finally becomes
// known, the newly-started server gets the full grace window, not zero.
func TestTracker_GraceFromPortKnownNotBoot(t *testing.T) {
	tr := NewTracker(cfg())
	// 40s of install: not restartable, no port. Clock must stay disarmed.
	for i := 0; i <= 40; i += 5 {
		if a := tr.Observe(Snapshot{Now: epoch.Add(time.Duration(i) * time.Second), Restartable: false, PortKnown: false}); a != ActionNone {
			t.Fatalf("install t=%ds want None, got %v", i, a)
		}
	}
	// t=41s: phase→starting, port sniffed. Despite 41s since boot, this is the
	// first eligible tick → the server gets a fresh grace window, no restart.
	if a := tr.Observe(Snapshot{Now: epoch.Add(41 * time.Second), Restartable: true, PortKnown: true}); a != ActionNone {
		t.Fatalf("first-eligible tick want None (fresh grace), got %v", a)
	}
	// t=60s (19s after eligible) still within grace.
	if a := tr.Observe(Snapshot{Now: epoch.Add(60 * time.Second), Restartable: true, PortKnown: true}); a != ActionNone {
		t.Fatalf("t=60 (19s in) want None, got %v", a)
	}
	// t=61s (20s after eligible) → restart.
	if a := tr.Observe(Snapshot{Now: epoch.Add(61 * time.Second), Restartable: true, PortKnown: true}); a != ActionRestart {
		t.Fatalf("t=61 (20s in) want Restart, got %v", a)
	}
}

// No port yet (still building) never triggers a restart, however long.
func TestTracker_NoPortNeverRestarts(t *testing.T) {
	tr := NewTracker(cfg())
	if a := tr.Observe(Snapshot{Now: epoch.Add(5 * time.Minute), Restartable: true, PortKnown: false}); a != ActionNone {
		t.Fatalf("want None with no port known, got %v", a)
	}
}

// A serving server is left alone and its grace clock stays disarmed.
func TestTracker_ServingLeftAlone(t *testing.T) {
	tr := NewTracker(cfg())
	if a := tr.Observe(Snapshot{Now: epoch.Add(time.Hour), Serving: true, Restartable: true, PortKnown: true}); a != ActionNone {
		t.Fatalf("want None while serving, got %v", a)
	}
}

// After MaxRestarts consecutive dead windows → give up (once).
func TestTracker_GivesUpAfterMaxRestarts(t *testing.T) {
	tr := NewTracker(cfg())
	now := epoch
	dead := func() Snapshot {
		return Snapshot{Now: now, Restartable: true, PortKnown: true}
	}
	// Arm, then each 20s window past grace charges one restart.
	tr.Observe(dead())
	for i := 1; i <= 3; i++ {
		now = now.Add(20 * time.Second)
		if a := tr.Observe(dead()); a != ActionRestart {
			t.Fatalf("attempt %d want Restart, got %v", i, a)
		}
	}
	now = now.Add(20 * time.Second)
	if a := tr.Observe(dead()); a != ActionGiveUp {
		t.Fatalf("want GiveUp after budget, got %v", a)
	}
	// Latched: no repeated give-ups / restarts.
	now = now.Add(20 * time.Second)
	if a := tr.Observe(dead()); a != ActionNone {
		t.Fatalf("want None after give-up latched, got %v", a)
	}
}

// A flapping server that serves briefly (< StableWindow) between deaths must not
// reset its budget — otherwise the bound never triggers.
func TestTracker_FlappingDoesNotResetBudget(t *testing.T) {
	tr := NewTracker(cfg())
	now := epoch
	for i := 1; i <= 3; i++ {
		// Dead window → restart.
		tr.Observe(Snapshot{Now: now, Restartable: true, PortKnown: true})
		now = now.Add(20 * time.Second)
		if a := tr.Observe(Snapshot{Now: now, Restartable: true, PortKnown: true}); a != ActionRestart {
			t.Fatalf("cycle %d want Restart, got %v", i, a)
		}
		// Serves for 2s (< 60s StableWindow) then dies — budget must survive.
		now = now.Add(1 * time.Second)
		tr.Observe(Snapshot{Now: now, Serving: true, Restartable: true, PortKnown: true})
		now = now.Add(1 * time.Second)
		tr.Observe(Snapshot{Now: now, Serving: true, Restartable: true, PortKnown: true})
	}
	// Budget exhausted (attempts==3) despite the brief serves. Arm a fresh dead
	// window and let grace elapse → give up (the budget was never reset).
	tr.Observe(Snapshot{Now: now, Restartable: true, PortKnown: true})
	now = now.Add(20 * time.Second)
	if a := tr.Observe(Snapshot{Now: now, Restartable: true, PortKnown: true}); a != ActionGiveUp {
		t.Fatalf("flapping want GiveUp (budget not reset), got %v (attempts=%d)", a, tr.Attempts())
	}
}

// A server that serves continuously past StableWindow resets the budget and
// clears a prior give-up, so a *later* death gets a fresh set of restarts.
func TestTracker_SustainedServingResetsBudget(t *testing.T) {
	tr := NewTracker(cfg())
	now := epoch
	// Burn the whole budget → give up.
	tr.Observe(Snapshot{Now: now, Restartable: true, PortKnown: true})
	for i := 0; i < 4; i++ {
		now = now.Add(20 * time.Second)
		tr.Observe(Snapshot{Now: now, Restartable: true, PortKnown: true})
	}
	if !tr.gaveUp {
		t.Fatal("precondition: expected gaveUp")
	}
	// Serve continuously for > StableWindow.
	now = now.Add(1 * time.Second)
	tr.Observe(Snapshot{Now: now, Serving: true, Restartable: true, PortKnown: true})
	now = now.Add(61 * time.Second)
	tr.Observe(Snapshot{Now: now, Serving: true, Restartable: true, PortKnown: true})
	if tr.gaveUp || tr.Attempts() != 0 {
		t.Fatalf("sustained serving should reset budget: gaveUp=%v attempts=%d", tr.gaveUp, tr.Attempts())
	}
	// A fresh death now earns a restart again.
	tr.Observe(Snapshot{Now: now, Restartable: true, PortKnown: true})
	now = now.Add(20 * time.Second)
	if a := tr.Observe(Snapshot{Now: now, Restartable: true, PortKnown: true}); a != ActionRestart {
		t.Fatalf("post-recovery want Restart, got %v", a)
	}
}

// Leaving a restartable phase (e.g. a checkout → installing) disarms the clock,
// so grace restarts when it re-enters.
func TestTracker_LeavingRestartablePhaseDisarms(t *testing.T) {
	tr := NewTracker(cfg())
	tr.Observe(Snapshot{Now: epoch, Restartable: true, PortKnown: true})
	// 15s in, phase leaves restartable (install kicked off).
	tr.Observe(Snapshot{Now: epoch.Add(15 * time.Second), Restartable: false, PortKnown: true})
	// Back to restartable — clock re-arms from here, not from the original t=0.
	if a := tr.Observe(Snapshot{Now: epoch.Add(16 * time.Second), Restartable: true, PortKnown: true}); a != ActionNone {
		t.Fatalf("re-armed clock want None, got %v", a)
	}
	if a := tr.Observe(Snapshot{Now: epoch.Add(35 * time.Second), Restartable: true, PortKnown: true}); a != ActionNone {
		t.Fatalf("t=35 (19s after re-arm) want None, got %v", a)
	}
	if a := tr.Observe(Snapshot{Now: epoch.Add(36 * time.Second), Restartable: true, PortKnown: true}); a != ActionRestart {
		t.Fatalf("t=36 (20s after re-arm) want Restart, got %v", a)
	}
}

func TestConfig_Defaults(t *testing.T) {
	tr := NewTracker(Config{})
	if tr.cfg.Grace != DefaultGracePeriod || tr.cfg.StableWindow != DefaultStableWindow || tr.cfg.MaxRestarts != DefaultMaxRestarts {
		t.Fatalf("zero config should use defaults, got %+v", tr.cfg)
	}
}
