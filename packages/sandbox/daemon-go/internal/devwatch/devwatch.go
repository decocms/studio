// Package devwatch holds the pure decision for the dev-server liveness
// watchdog: given how long the dev server has been unreachable (while a port
// was known) and how many restarts already fired this episode, decide whether
// to respawn it, give up, or do nothing.
//
// The rule exists because a dev server can die out from under a live daemon —
// the idle reaper freezes the pod, the process crashes, or it binds a stale
// port after a reclaim — and nothing respawns it. The daemon's proxy then
// serves "Server is starting…" forever (a connection error to a known-but-dead
// port) and the user's preview never comes back. This watchdog turns that dead
// end into an automatic restart, bounded so a genuinely broken app surfaces a
// terminal error instead of an endless loop.
//
// Kept dependency-free (no events/lifecycle import) so it stays trivially
// unit-testable; the caller maps its lifecycle phase to Restartable and its
// probe/timer state to the rest.
package devwatch

import "time"

// DefaultGracePeriod is how long the dev server may be unreachable — while a
// port was known — before it is treated as dead and respawned. Long enough not
// to interrupt a server that has opened its port but is still doing
// first-request compilation (the probe's own HEAD timeout is 5s), short enough
// that recovery feels automatic. The caller passes the effective grace to
// Decide so it stays overridable (env tuning, fast tests).
const DefaultGracePeriod = 20 * time.Second

// MaxRestarts is how many respawns are attempted per dead episode before giving
// up. On give-up the caller surfaces a terminal start-failed, so a genuinely
// broken dev server shows a real error rather than "Server is starting…"
// forever. Reset once the server is serving again.
const MaxRestarts = 3

// Action is the watchdog's verdict for one tick.
type Action int

const (
	// ActionNone: leave it alone (serving, still within grace, mid-build, or a
	// restart is already in flight).
	ActionNone Action = iota
	// ActionRestart: respawn the dev server now.
	ActionRestart
	// ActionGiveUp: restarts are exhausted — surface a terminal failure.
	ActionGiveUp
)

// Input is the state Decide reasons over. All fields are caller-computed so the
// decision keeps no dependency on the daemon's internals.
type Input struct {
	// Serving is true when the probe reports the dev server reachable.
	Serving bool
	// Restartable is true only in phases where a dev server is meant to be up
	// (running/starting/crashed) — never during install/clone (a legit slow
	// build must not be interrupted) or a terminal *-failed phase.
	Restartable bool
	// PortKnown is true once a dev port has been learned — sniffed now, or one
	// that served earlier this episode. Gates out the legitimate "still
	// building, no port yet" case, whose port-0 state must not trigger a
	// restart.
	PortKnown bool
	// UnreachableFor is how long the server has been not-serving while a port
	// was known. Zero while serving.
	UnreachableFor time.Duration
	// Attempts already fired this dead episode.
	Attempts int
	// RestartInFlight guards against overlapping restarts.
	RestartInFlight bool
}

// Decide returns the action for the current tick. grace is the effective
// unreachable-window before a restart (see DefaultGracePeriod).
func Decide(in Input, grace time.Duration) Action {
	if in.Serving || !in.Restartable || !in.PortKnown || in.RestartInFlight {
		return ActionNone
	}
	if in.UnreachableFor < grace {
		return ActionNone
	}
	if in.Attempts >= MaxRestarts {
		return ActionGiveUp
	}
	return ActionRestart
}
