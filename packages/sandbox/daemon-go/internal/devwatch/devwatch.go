// Package devwatch holds the dev-server liveness watchdog's decision state: how
// long the dev server has been unreachable *while a restart could help*, how
// many restarts already fired this episode, and whether to respawn it, give up,
// or wait.
//
// The rule exists because a dev server can die out from under a live daemon —
// the idle reaper freezes the pod, the process exits cleanly, or it binds a
// stale port after a reclaim — and nothing respawns it. The daemon's proxy then
// serves "Server is starting…" forever (a connection error to a known-but-dead
// port) and the preview never comes back. This watchdog turns that dead end
// into an automatic restart, bounded so a genuinely broken app surfaces a
// terminal error instead of an endless loop.
//
// The stateful bookkeeping lives here (not in the daemon's main loop) with an
// injected clock, so the two subtle properties it rests on are unit-testable:
//   - grace is measured from "a port became known while in a restartable phase",
//     NOT from process boot — else a slow install would consume the whole grace
//     window before the dev server even starts, and the watchdog would kill a
//     legitimately-still-starting server (see TestTracker_GraceFromPortKnown).
//   - the restart budget only resets after the server has served *continuously*
//     for StableWindow — else a flapping crash-loop that serves for one probe
//     cycle between deaths would reset the budget every time and never give up
//     (see TestTracker_FlappingDoesNotResetBudget).
//   - "how long dead before it is dead" and "how long a respawn gets to come
//     up" are DIFFERENT durations (Grace vs RestartGrace) — see RestartGrace.
package devwatch

import "time"

// DefaultGracePeriod is the unreachable window — measured from when a port
// becomes known in a restartable phase — before the dev server is treated as
// dead and respawned. It is a heuristic threshold, not a guarantee: a dev
// server that opens its port and then blocks on a first-request compile longer
// than this will be restarted (and, after MaxRestarts, fail). Tune via
// SANDBOX_DEV_WATCH_GRACE_MS for frameworks with long first compiles.
const DefaultGracePeriod = 20 * time.Second

// DefaultRestartGrace is how long a *respawned* dev server gets to serve before
// the next restart is charged. It is deliberately far larger than
// DefaultGracePeriod: those two numbers answer different questions. Grace asks
// "has the server that was serving a moment ago died?" — 20s is plenty.
// RestartGrace asks "has the server we just launched finished booting?", and a
// respawn is a cold boot, which on a large Fresh/Vite app is minutes.
//
// Reusing Grace for both is what took a montecarlo sandbox down in production:
// a dev server needing 5m18s to first serve was respawned at +20s, +41s and
// +62s — each restart killing the previous boot — and declared start-failed
// 63s into an episode that only ever needed one restart and five minutes of
// patience. The tracker also raises this from the boot it actually observed
// (see RaiseRestartGrace), so a slow repo tunes itself. Override the floor with
// SANDBOX_DEV_WATCH_RESTART_GRACE_MS.
const DefaultRestartGrace = 5 * time.Minute

// DefaultStableWindow is how long the server must serve continuously before the
// restart budget resets. Longer than a flap so a crash-loop that briefly serves
// can't keep re-arming the budget and escape the MaxRestarts bound.
const DefaultStableWindow = 60 * time.Second

// DefaultMaxRestarts is how many respawns are attempted per dead episode before
// giving up. On give-up the caller surfaces a terminal start-failed, so a
// genuinely broken dev server shows a real error rather than "Server is
// starting…" forever.
const DefaultMaxRestarts = 3

// Action is the tracker's verdict for one tick.
type Action int

const (
	// ActionNone: leave it alone (serving, still within grace, mid-build, or
	// already given up).
	ActionNone Action = iota
	// ActionRestart: respawn the dev server now.
	ActionRestart
	// ActionGiveUp: restarts are exhausted — surface a terminal failure.
	ActionGiveUp
)

// Config parameterizes a Tracker. Zero values fall back to the Default* consts.
type Config struct {
	Grace        time.Duration
	RestartGrace time.Duration
	StableWindow time.Duration
	MaxRestarts  int
}

func (c Config) withDefaults() Config {
	if c.Grace <= 0 {
		c.Grace = DefaultGracePeriod
	}
	if c.RestartGrace <= 0 {
		c.RestartGrace = DefaultRestartGrace
	}
	// A restart that gets less time than the initial dead-detection window is
	// never what anyone means; it only re-creates the bug this field fixes.
	if c.RestartGrace < c.Grace {
		c.RestartGrace = c.Grace
	}
	if c.StableWindow <= 0 {
		c.StableWindow = DefaultStableWindow
	}
	if c.MaxRestarts <= 0 {
		c.MaxRestarts = DefaultMaxRestarts
	}
	return c
}

// Snapshot is the caller-observed state for one tick. Now is injected so the
// time-based logic is testable without real sleeps.
type Snapshot struct {
	Now time.Time
	// Serving is true when the probe reports the dev server reachable.
	Serving bool
	// Restartable is true only in phases where a dev server is meant to be up
	// (running/starting/crashed) — never during install/clone (a legit slow
	// build must not be interrupted) or a terminal *-failed phase.
	Restartable bool
	// PortKnown is true once a dev port has been announced — sniffed from the
	// dev output, or confirmed serving earlier this session. A merely
	// *configured* application.port does NOT count: it is set before the server
	// binds, so it must not make a still-starting server look dead.
	PortKnown bool
}

// Tracker accumulates liveness over ticks and decides the next Action. Not
// safe for concurrent use — the caller drives it from a single goroutine (or
// under its own lock).
type Tracker struct {
	cfg Config
	// notServingSince is when the current *eligible* dead window began (zero
	// while serving, mid-build, or no port yet). Grace is measured from here.
	notServingSince time.Time
	// servingSince is when the current continuous serving window began (zero
	// while not serving). The budget resets once it exceeds StableWindow.
	servingSince time.Time
	attempts     int
	gaveUp       bool
}

func NewTracker(cfg Config) *Tracker {
	return &Tracker{cfg: cfg.withDefaults()}
}

// Attempts is how many restarts have fired this dead episode.
func (t *Tracker) Attempts() int { return t.attempts }

// MaxRestarts is the effective budget (after defaults), for log messages.
func (t *Tracker) MaxRestarts() int { return t.cfg.MaxRestarts }

// RestartGrace is the effective post-restart window, for log messages.
func (t *Tracker) RestartGrace() time.Duration { return t.cfg.RestartGrace }

// RaiseRestartGrace widens the post-restart window to `d`, ignoring anything
// at or below the current value. Callers feed it the boot this sandbox was
// actually measured to need (with headroom), so a repo that takes eleven
// minutes to serve gets eleven minutes on a respawn without anyone having to
// guess a constant. One-way on purpose: a single fast boot on a warm cache
// must not shrink the window back under a repo that is usually slow.
func (t *Tracker) RaiseRestartGrace(d time.Duration) {
	if d > t.cfg.RestartGrace {
		t.cfg.RestartGrace = d
	}
}

// Observe advances the tracker with one tick's snapshot and returns the action
// to take. On ActionRestart it has already charged one attempt and reset the
// grace window; on ActionGiveUp it latches the given-up state until the server
// serves continuously again.
func (t *Tracker) Observe(s Snapshot) Action {
	// Budget/gave-up reset only after a *sustained* serving window, so a flap
	// that serves for one tick between deaths can't keep re-arming the budget.
	if s.Serving {
		if t.servingSince.IsZero() {
			t.servingSince = s.Now
		}
		if s.Now.Sub(t.servingSince) >= t.cfg.StableWindow {
			t.attempts = 0
			t.gaveUp = false
		}
	} else {
		t.servingSince = time.Time{}
	}

	// The unreachable clock runs ONLY while a restart could actually help: a
	// known port, a restartable phase, not serving. This measures grace from
	// "port known", not from process boot — the whole point of the field.
	eligible := !s.Serving && s.Restartable && s.PortKnown
	if !eligible {
		t.notServingSince = time.Time{}
		return ActionNone
	}
	if t.notServingSince.IsZero() {
		t.notServingSince = s.Now
	}

	// Before the first restart we are judging a server that WAS serving, so the
	// short dead-detection window applies. Afterwards we are judging a boot we
	// just started, which needs a boot's worth of time.
	window := t.cfg.Grace
	if t.attempts > 0 {
		window = t.cfg.RestartGrace
	}
	if t.gaveUp || s.Now.Sub(t.notServingSince) < window {
		return ActionNone
	}
	if t.attempts >= t.cfg.MaxRestarts {
		t.gaveUp = true
		return ActionGiveUp
	}
	t.attempts++
	// Reset the grace window so the next restart is measured from now — this is
	// also the guard against firing a second restart before the first has had a
	// chance to come up.
	t.notServingSince = s.Now
	return ActionRestart
}
