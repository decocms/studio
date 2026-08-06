package activity

import (
	"sync"
	"time"
)

var (
	mu             sync.Mutex
	lastActivityAt = time.Now()
	claimed        = false
	prewarmed      = false
)

func Bump() {
	mu.Lock()
	lastActivityAt = time.Now()
	mu.Unlock()
}

// MarkClaimed: a user now owns this pod. Only config carrying a user identity
// flips it — a tenant warm pool bootstraps its pods with an identity-less
// config, and marking those claimed would hand them to the housekeeper's
// idle sweep 15 minutes later.
func MarkClaimed() {
	mu.Lock()
	claimed = true
	mu.Unlock()
}

// MarkPrewarmed: this pod has a workload but no user. Observability only —
// the housekeeper keys off `claimed`.
func MarkPrewarmed() {
	mu.Lock()
	prewarmed = true
	mu.Unlock()
}

type IdleStatus struct {
	LastActivityAt string `json:"lastActivityAt"`
	IdleMs         int64  `json:"idleMs"`
	Claimed        bool   `json:"claimed"`
	Prewarmed      bool   `json:"prewarmed"`
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
		Prewarmed:      prewarmed,
	}
}
