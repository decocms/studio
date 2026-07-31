package activity

import (
	"sync"
	"time"
)

var (
	mu             sync.Mutex
	lastActivityAt = time.Now()
	claimed        = false
)

func Bump() {
	mu.Lock()
	lastActivityAt = time.Now()
	mu.Unlock()
}

func MarkClaimed() {
	mu.Lock()
	claimed = true
	mu.Unlock()
}

type IdleStatus struct {
	LastActivityAt string `json:"lastActivityAt"`
	IdleMs         int64  `json:"idleMs"`
	Claimed        bool   `json:"claimed"`
}

func Idle() IdleStatus {
	mu.Lock()
	defer mu.Unlock()
	idle := time.Since(lastActivityAt).Milliseconds()
	if idle < 0 {
		idle = 0
	}
	return IdleStatus{
		LastActivityAt: lastActivityAt.UTC().Format("2006-01-02T15:04:05.000Z"),
		IdleMs:         idle,
		Claimed:        claimed,
	}
}
