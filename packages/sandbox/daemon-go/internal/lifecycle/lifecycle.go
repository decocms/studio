package lifecycle

import (
	"encoding/json"
	"sync"
	"time"

	"github.com/decocms/studio/sandbox-daemon/internal/events"
)

type Broadcaster interface {
	Emit(name string, payload any)
}

type Manager struct {
	mu           sync.Mutex
	state        events.LifecycleState
	broadcaster  Broadcaster
	OnTransition func(prev, next events.LifecycleState)

	// OnStartPhase reports a finished `start` phase. Spawning the dev script
	// says nothing about whether it serves — Spawn returns once the process
	// exists, so timing it would measure fork latency and would never observe a
	// failure. The phase ends where it becomes observable: the probe seeing the
	// server (running) or the script dying (start-failed). Optional, so this
	// package keeps no dependency on the telemetry stack — main wires it up.
	OnStartPhase func(status string, durationMs int64)

	startAttemptAt time.Time
}

func New(b Broadcaster) *Manager {
	return &Manager{
		state:       events.LifecycleState{Phase: events.PhaseIdle},
		broadcaster: b,
	}
}

func (m *Manager) Current() events.LifecycleState {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.state
}

// NoteStartAttempt records that a dev script was just spawned. The phase it
// opens is closed by the next running / start-failed transition. A second
// attempt before the first resolves (branch change mid-boot) replaces it: the
// abandoned attempt has no terminal state to measure to.
func (m *Manager) NoteStartAttempt() {
	m.mu.Lock()
	m.startAttemptAt = time.Now()
	m.mu.Unlock()
}

// CancelStartAttempt drops the open attempt — the step spawned nothing.
func (m *Manager) CancelStartAttempt() {
	m.mu.Lock()
	m.startAttemptAt = time.Time{}
	m.mu.Unlock()
}

func (m *Manager) Transition(next events.LifecycleState) {
	m.mu.Lock()
	prev := m.state
	if equal(prev, next) {
		m.mu.Unlock()
		return
	}
	m.state = next
	hook := m.OnTransition

	// Resolve an open start attempt under the same lock that owns the state, so
	// two transitions racing cannot both report the same attempt.
	var startStatus string
	var startMs int64
	if !m.startAttemptAt.IsZero() &&
		(next.Phase == events.PhaseRunning || next.Phase == events.PhaseStartFailed) {
		startStatus = "done"
		if next.Phase == events.PhaseStartFailed {
			startStatus = "failed"
		}
		startMs = time.Since(m.startAttemptAt).Milliseconds()
		m.startAttemptAt = time.Time{}
	}
	startHook := m.OnStartPhase
	m.mu.Unlock()

	m.broadcaster.Emit("lifecycle", map[string]any{"state": next})
	if hook != nil {
		hook(prev, next)
	}
	if startStatus != "" && startHook != nil {
		startHook(startStatus, startMs)
	}
}

func equal(a, b events.LifecycleState) bool {
	aj, errA := json.Marshal(a)
	bj, errB := json.Marshal(b)
	if errA != nil || errB != nil {
		return false
	}
	return string(aj) == string(bj)
}
