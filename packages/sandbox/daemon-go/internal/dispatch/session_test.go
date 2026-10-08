package dispatch

import (
	"context"
	"encoding/json"
	"testing"
	"time"
)

// Answers every turn with one frame carrying its own pid, then ends the turn.
var fakePersistentRunner = []string{"sh", "-c",
	`while read line; do echo "{\"chunks\":[{\"pid\":$$}]}"; echo '{"chunks":[],"turnEnd":true}'; done`}

func turnPid(t *testing.T, p *sessionPool, key string) int {
	t.Helper()
	info := RunInfo{ThreadId: "thrd_1", McpExpiresAt: time.Now().Add(time.Hour).UnixMilli()}
	var pid int
	n, err := p.runSession(context.Background(), fakePersistentRunner, "claude-code",
		json.RawMessage(`{}`), map[string]string{"K": "v"}, info, key,
		func(frame []byte) bool {
			var f struct {
				Chunks []struct{ Pid int } `json:"chunks"`
			}
			if err := json.Unmarshal(frame, &f); err != nil || len(f.Chunks) != 1 {
				t.Fatalf("unexpected frame %s", frame)
			}
			pid = f.Chunks[0].Pid
			return true
		})
	if err != nil || n != 1 {
		t.Fatalf("turn: frames=%d err=%v", n, err)
	}
	return pid
}

func TestSessionReusesTheRunnerUntilTheKeyChanges(t *testing.T) {
	p := &sessionPool{}
	first := turnPid(t, p, "a")
	if again := turnPid(t, p, "a"); again != first {
		t.Fatalf("same key spawned a new runner: %d then %d", first, again)
	}
	if other := turnPid(t, p, "b"); other == first {
		t.Fatalf("a changed key reused runner %d", first)
	}
}

func TestSessionKillsAnIdleRunner(t *testing.T) {
	prev := sessionIdleTTL
	sessionIdleTTL = 50 * time.Millisecond
	defer func() { sessionIdleTTL = prev }()

	p := &sessionPool{}
	turnPid(t, p, "a")
	p.mu.Lock()
	lr := p.idle["thrd_1"]
	p.mu.Unlock()
	select {
	case <-lr.exited:
	case <-time.After(2 * time.Second):
		t.Fatal("idle runner still alive")
	}
}
