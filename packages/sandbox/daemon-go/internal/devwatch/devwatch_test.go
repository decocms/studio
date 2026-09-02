package devwatch

import (
	"testing"
	"time"
)

var epoch = time.Unix(1_700_000_000, 0)

// restartGrace is the post-restart window these tests run with — deliberately
// far larger than Grace, mirroring production, so a test that advances only by
// Grace between restarts fails instead of quietly passing.
const restartGrace = 5 * time.Minute

func cfg() Config {
	return Config{
		Grace:        20 * time.Second,
		RestartGrace: restartGrace,
		StableWindow: 60 * time.Second,
		MaxRestarts:  3,
	}
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
	// Arm, then the first Grace window charges restart 1. Every window after
	// that is a RestartGrace, because from then on we are waiting on a boot.
	tr.Observe(dead())
	now = now.Add(20 * time.Second)
	if a := tr.Observe(dead()); a != ActionRestart {
		t.Fatalf("attempt 1 want Restart, got %v", a)
	}
	for i := 2; i <= 3; i++ {
		now = now.Add(restartGrace)
		if a := tr.Observe(dead()); a != ActionRestart {
			t.Fatalf("attempt %d want Restart, got %v", i, a)
		}
	}
	now = now.Add(restartGrace)
	if a := tr.Observe(dead()); a != ActionGiveUp {
		t.Fatalf("want GiveUp after budget, got %v", a)
	}
	// Latched: no repeated give-ups / restarts.
	now = now.Add(restartGrace)
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
		// Dead window → restart. A cycle's brief serve never reaches
		// StableWindow, so attempts never resets: only cycle 1 waits Grace, the
		// rest are waiting on a respawn and wait RestartGrace.
		window := 20 * time.Second
		if i > 1 {
			window = restartGrace
		}
		tr.Observe(Snapshot{Now: now, Restartable: true, PortKnown: true})
		now = now.Add(window)
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
	now = now.Add(restartGrace)
	if a := tr.Observe(Snapshot{Now: now, Restartable: true, PortKnown: true}); a != ActionGiveUp {
		t.Fatalf("flapping want GiveUp (budget not reset), got %v (attempts=%d)", a, tr.Attempts())
	}
}

// A server that serves continuously past StableWindow resets the budget and
// clears a prior give-up, so a *later* death gets a fresh set of restarts.
func TestTracker_SustainedServingResetsBudget(t *testing.T) {
	tr := NewTracker(cfg())
	now := epoch
	// Burn the whole budget → give up. Only the first window is Grace; the
	// three after it are waiting on a respawn.
	tr.Observe(Snapshot{Now: now, Restartable: true, PortKnown: true})
	now = now.Add(20 * time.Second)
	tr.Observe(Snapshot{Now: now, Restartable: true, PortKnown: true})
	for i := 0; i < 3; i++ {
		now = now.Add(restartGrace)
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
	if tr.cfg.Grace != DefaultGracePeriod || tr.cfg.StableWindow != DefaultStableWindow ||
		tr.cfg.MaxRestarts != DefaultMaxRestarts || tr.cfg.RestartGrace != DefaultRestartGrace {
		t.Fatalf("zero config should use defaults, got %+v", tr.cfg)
	}
}

// A RestartGrace below Grace is meaningless — it re-creates the very bug
// RestartGrace exists to fix — so it is floored, not honoured.
func TestConfig_RestartGraceFloorsAtGrace(t *testing.T) {
	tr := NewTracker(Config{Grace: time.Minute, RestartGrace: time.Second})
	if tr.RestartGrace() != time.Minute {
		t.Fatalf("want RestartGrace floored to Grace, got %v", tr.RestartGrace())
	}
}

// The production regression, as a test. A dev server needing 5m18s to serve was
// respawned at +20s, +41s and +62s — each restart killing the previous boot —
// and declared start-failed 63s into an episode that one restart and five
// minutes of patience would have fixed. A respawn now gets RestartGrace.
func TestTracker_RespawnGetsRestartGraceNotGrace(t *testing.T) {
	tr := NewTracker(cfg())
	now := epoch
	dead := func() Snapshot {
		return Snapshot{Now: now, Restartable: true, PortKnown: true}
	}
	tr.Observe(dead())
	now = now.Add(20 * time.Second)
	if a := tr.Observe(dead()); a != ActionRestart {
		t.Fatalf("want the first restart after Grace, got %v", a)
	}
	// The respawn is booting. Three more Grace windows must not touch it —
	// under the old rule these were restarts 2, 3 and the give-up.
	for i := 1; i <= 3; i++ {
		now = now.Add(20 * time.Second)
		if a := tr.Observe(dead()); a != ActionNone {
			t.Fatalf("%ds into the respawn want None, got %v", i*20, a)
		}
	}
	now = now.Add(restartGrace - 61*time.Second)
	if a := tr.Observe(dead()); a != ActionNone {
		t.Fatalf("just under RestartGrace want None, got %v", a)
	}
	// A boot that genuinely never arrives still earns the next restart.
	now = now.Add(time.Second)
	if a := tr.Observe(dead()); a != ActionRestart {
		t.Fatalf("past RestartGrace want Restart, got %v", a)
	}
}

// A boot slower than the configured floor widens the window; a faster one
// leaves it alone, so one warm boot cannot shrink it under a usually-slow repo.
func TestTracker_RaiseRestartGraceOnlyWidens(t *testing.T) {
	tr := NewTracker(cfg())
	tr.RaiseRestartGrace(20 * time.Minute)
	if tr.RestartGrace() != 20*time.Minute {
		t.Fatalf("want widened to 20m, got %v", tr.RestartGrace())
	}
	tr.RaiseRestartGrace(time.Second)
	if tr.RestartGrace() != 20*time.Minute {
		t.Fatalf("want 20m kept, got %v", tr.RestartGrace())
	}
}
