package proc

import (
	"sync"
	"syscall"
	"testing"
)

// TestConcurrentKillDuringSpawnDoesNotRace exercises the window between a
// task becoming visible in the manager's map and its pid being recorded:
// Spawn adds the task before cmd.Start() returns, so a concurrent Kill can
// read task.pid while startPipe is still writing it. Run with -race.
func TestConcurrentKillDuringSpawnDoesNotRace(t *testing.T) {
	m := NewTaskManager(TaskManagerDeps{LogsDir: t.TempDir()})
	defer m.Shutdown()

	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		m.Spawn(TaskSpec{Command: "sleep 1", Mode: "pipe"})
	}()
	go func() {
		defer wg.Done()
		for i := 0; i < 200; i++ {
			for _, s := range m.List(nil) {
				m.Kill(s.ID, syscall.SIGTERM)
			}
		}
	}()
	wg.Wait()
}

// TestSpawnUnlessLogNameRunningIsAtomic exercises N concurrent requests for
// the same LogName: a naive "check RunningByLogName, then Spawn" sequence
// races and lets more than one through, which is exactly the double
// dev-server-process bug this method exists to close.
func TestSpawnUnlessLogNameRunningIsAtomic(t *testing.T) {
	m := NewTaskManager(TaskManagerDeps{LogsDir: t.TempDir()})
	defer m.Shutdown()

	const n = 20
	var wg sync.WaitGroup
	var mu sync.Mutex
	started := 0
	wg.Add(n)
	for i := 0; i < n; i++ {
		go func() {
			defer wg.Done()
			_, alreadyRunning := m.SpawnUnlessLogNameRunning(TaskSpec{
				Command: "sleep 1", Mode: "pipe", LogName: "dev",
			})
			if !alreadyRunning {
				mu.Lock()
				started++
				mu.Unlock()
			}
		}()
	}
	wg.Wait()

	if started != 1 {
		t.Fatalf("expected exactly 1 spawn to win the race, got %d", started)
	}
}
