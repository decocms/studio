package lifecycle

import (
	"encoding/json"
	"sync"

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

func (m *Manager) Transition(next events.LifecycleState) {
	m.mu.Lock()
	prev := m.state
	if equal(prev, next) {
		m.mu.Unlock()
		return
	}
	m.state = next
	hook := m.OnTransition
	m.mu.Unlock()
	m.broadcaster.Emit("lifecycle", map[string]any{"state": next})
	if hook != nil {
		hook(prev, next)
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
