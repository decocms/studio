package gitx

import (
	"errors"
	"sync"
	"testing"
	"time"
)

// fakeLock records whether the checkpoint took the tree lock, and whether it
// gave it back. A checkpoint that leaks the lock deadlocks every fs write and
// the shutdown sync behind it.
type fakeLock struct {
	acquired int
	released int
}

func (l *fakeLock) Acquire() func() {
	l.acquired++
	return func() { l.released++ }
}

type recorder struct {
	mu       sync.Mutex
	messages []string
	err      error
}

func (r *recorder) publish(_ PublishDeps, msg string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.messages = append(r.messages, msg)
	return r.err
}

func (r *recorder) count() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.messages)
}

// harness builds an Autosaver whose every gate is on and whose publish is
// recorded. Each test flips the one gate it is about.
func harness(t *testing.T, rec *recorder) (*Autosaver, *fakeLock) {
	t.Helper()
	lock := &fakeLock{}
	a := NewAutosaver(AutosaveDeps{
		Lock:       lock,
		Configured: func() bool { return true },
		RunActive:  func() bool { return true },
		Dirty:      func() bool { return true },
		publishFn:  rec.publish,
	})
	return a, lock
}

func TestTickPublishesWhenRunningAndDirty(t *testing.T) {
	rec := &recorder{}
	a, lock := harness(t, rec)
	a.Tick()
	if rec.count() != 1 {
		t.Fatalf("want 1 publish, got %d", rec.count())
	}
	if rec.messages[0] != AutosaveMessage {
		t.Fatalf("want fixed checkpoint message, got %q", rec.messages[0])
	}
	if lock.acquired != 1 || lock.released != 1 {
		t.Fatalf("tree lock acquired %d released %d, want 1/1", lock.acquired, lock.released)
	}
}

func TestTickSkipsWhenTreeIsClean(t *testing.T) {
	rec := &recorder{}
	lock := &fakeLock{}
	a := NewAutosaver(AutosaveDeps{
		Lock:       lock,
		Configured: func() bool { return true },
		RunActive:  func() bool { return true },
		Dirty:      func() bool { return false },
		publishFn:  rec.publish,
	})
	a.Tick()
	if rec.count() != 0 {
		t.Fatalf("clean tree must not publish, got %d", rec.count())
	}
	// The whole point of checking dirty first: a clean tree must not stall
	// writers behind the tree lock every interval.
	if lock.acquired != 0 {
		t.Fatalf("clean tree must not take the tree lock, took it %d times", lock.acquired)
	}
}

func TestTickSkipsWhenNoRunIsActive(t *testing.T) {
	rec := &recorder{}
	a := NewAutosaver(AutosaveDeps{
		Configured: func() bool { return true },
		RunActive:  func() bool { return false },
		Dirty:      func() bool { return true },
		publishFn:  rec.publish,
	})
	a.Tick()
	if rec.count() != 0 {
		t.Fatalf("idle sandbox must not checkpoint, got %d", rec.count())
	}
}

func TestTickSkipsBeforeABranchIsConfigured(t *testing.T) {
	rec := &recorder{}
	a := NewAutosaver(AutosaveDeps{
		Configured: func() bool { return false },
		RunActive:  func() bool { return true },
		Dirty:      func() bool { return true },
		publishFn:  rec.publish,
	})
	a.Tick()
	if rec.count() != 0 {
		t.Fatalf("no branch means nothing to push to, got %d", rec.count())
	}
}

func TestTickSurvivesAPublishFailure(t *testing.T) {
	rec := &recorder{err: errors.New("detached HEAD mid-rebase")}
	a, lock := harness(t, rec)
	// A failed checkpoint must not panic, must not abort the loop, and must give
	// the tree lock back — the next tick has to be able to run.
	a.Tick()
	a.Tick()
	if rec.count() != 2 {
		t.Fatalf("want a retry on the next tick, got %d publishes", rec.count())
	}
	if lock.released != 2 {
		t.Fatalf("failed checkpoint leaked the tree lock: released %d of 2", lock.released)
	}
}

func TestTickIsIdempotentOnAnUnchangedTree(t *testing.T) {
	// Publish itself commits only when the index is non-empty, so a second tick
	// over the same content is a no-op commit and a no-op push. What this pins is
	// that the loop does not invent extra work of its own: same tree, same fixed
	// message, no accumulating state between ticks.
	rec := &recorder{}
	a, _ := harness(t, rec)
	a.Tick()
	a.Tick()
	if rec.count() != 2 {
		t.Fatalf("want 2 publish calls, got %d", rec.count())
	}
	if rec.messages[0] != rec.messages[1] {
		t.Fatalf("checkpoint message drifted: %q then %q", rec.messages[0], rec.messages[1])
	}
}

func TestStopWaitsForTheLoopToExit(t *testing.T) {
	rec := &recorder{}
	a := NewAutosaver(AutosaveDeps{
		Interval:   time.Millisecond,
		Configured: func() bool { return true },
		RunActive:  func() bool { return true },
		Dirty:      func() bool { return true },
		publishFn:  rec.publish,
	})
	a.Start()
	// Shutdown calls Stop before its own publish; if Stop returned early the two
	// would race for the tree lock.
	done := make(chan struct{})
	go func() {
		a.Stop()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Stop did not return")
	}
	// Idempotent: shutdown can be reached twice.
	a.Stop()
}

func TestStopBeforeStartIsANoOp(t *testing.T) {
	a := NewAutosaver(AutosaveDeps{})
	// A daemon that dies during boot reaches shutdown without ever starting the
	// loop; Stop must not block on a `done` no goroutine will close.
	done := make(chan struct{})
	go func() {
		a.Stop()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Stop blocked on an unstarted autosaver")
	}
}

func TestDefaultIntervalIsApplied(t *testing.T) {
	a := NewAutosaver(AutosaveDeps{})
	if a.deps.Interval != AutosaveInterval {
		t.Fatalf("want default %v, got %v", AutosaveInterval, a.deps.Interval)
	}
}
