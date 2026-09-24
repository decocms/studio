// Package storetest is an in-memory store.Store for tests.
package storetest

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"time"

	"github.com/decocms/studio/packages/sandbox/controller-go/protocol"
	"github.com/decocms/studio/packages/sandbox/controller-go/store"
)

type key struct{ user, ref, runtime string }

// Memory enforces the table's two constraints: one row per (id, runtime) and
// a unique handle.
type Memory struct {
	mu    sync.Mutex
	rows  map[key]store.Record
	locks sync.Map // lock key -> *sync.Mutex
}

var _ store.Store = (*Memory)(nil)

func NewMemory() *Memory { return &Memory{rows: map[key]store.Record{}} }

func k(id protocol.SandboxID, runtime string) key { return key{id.UserID, id.ProjectRef, runtime} }

func (m *Memory) Get(_ context.Context, id protocol.SandboxID, runtime string) (*store.Record, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if r, ok := m.rows[k(id, runtime)]; ok {
		return &r, nil
	}
	return nil, nil
}

func (m *Memory) GetAnyRuntime(_ context.Context, id protocol.SandboxID) (*store.Record, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var best *store.Record
	for kk, r := range m.rows {
		if kk.user == id.UserID && kk.ref == id.ProjectRef && (best == nil || r.UpdatedAt.After(best.UpdatedAt)) {
			r := r
			best = &r
		}
	}
	return best, nil
}

func (m *Memory) ByHandle(_ context.Context, handle string) (*store.Record, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, r := range m.rows {
		if r.Handle == handle {
			return &r, nil
		}
	}
	return nil, nil
}

func (m *Memory) Put(_ context.Context, id protocol.SandboxID, runtime, handle string, state any) error {
	blob, err := json.Marshal(state)
	if err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	for kk, r := range m.rows {
		if r.Handle == handle && kk != k(id, runtime) {
			return fmt.Errorf("duplicate key value violates unique constraint sandbox_runner_state_handle_idx")
		}
	}
	m.rows[k(id, runtime)] = store.Record{ID: id, Handle: handle, Runtime: runtime, State: blob, UpdatedAt: time.Now()}
	return nil
}

func (m *Memory) Delete(_ context.Context, id protocol.SandboxID, runtime string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.rows, k(id, runtime))
	return nil
}

func (m *Memory) DeleteByHandle(_ context.Context, runtime, handle string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for kk, r := range m.rows {
		if kk.runtime == runtime && r.Handle == handle {
			delete(m.rows, kk)
		}
	}
	return nil
}

func (m *Memory) ListByRuntime(_ context.Context, runtime string) ([]store.Record, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []store.Record
	for kk, r := range m.rows {
		if kk.runtime == runtime {
			out = append(out, r)
		}
	}
	return out, nil
}

func (m *Memory) WithLock(ctx context.Context, id protocol.SandboxID, runtime string, fn func(context.Context) error) error {
	l, _ := m.locks.LoadOrStore(store.LockKey(id, runtime), &sync.Mutex{})
	mu := l.(*sync.Mutex)
	mu.Lock()
	defer mu.Unlock()
	return fn(ctx)
}
