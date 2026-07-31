package gitx

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/decocms/studio/sandbox-daemon/internal/events"
)

type branchBroadcaster interface {
	Emit(name string, payload any)
}

// BranchStatusMonitor surfaces BranchMeta (branch, dirty, divergence) with a
// content-hash dirty-baseline. Change detection is an fsnotify watch over the
// repo (see watch.go) plus a 3s poll as the safety net for atomic editor saves
// and watch gaps; the fs routes also call Refresh directly on their own writes.
type BranchStatusMonitor struct {
	mu          sync.Mutex
	repoDir     string
	broadcaster branchBroadcaster
	last        events.BranchMeta
	baseline    map[string]string
	hasBaseline bool
	pollStop    chan struct{}
	pollStarted bool
	stopped     bool
	// onFileChanged reports a changed repo-relative path (slash-separated) for the
	// `file-changed` SSE event. Debouncing is the caller's.
	onFileChanged func(path string)
}

func NewBranchStatusMonitor(repoDir string, b branchBroadcaster, onFileChanged func(path string)) *BranchStatusMonitor {
	return &BranchStatusMonitor{
		repoDir:       repoDir,
		broadcaster:   b,
		last:          events.BranchMeta{Kind: "unknown"},
		pollStop:      make(chan struct{}),
		onFileChanged: onFileChanged,
	}
}

func (m *BranchStatusMonitor) GetLast() events.BranchMeta {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.last
}

func (m *BranchStatusMonitor) ArmBaseline() {
	paths := m.readDirtyPaths()
	m.mu.Lock()
	m.baseline = map[string]string{}
	m.hasBaseline = true
	for p := range paths {
		m.baseline[p] = m.hashWorktreeFile(p)
	}
	m.mu.Unlock()
	m.Refresh()
}

func (m *BranchStatusMonitor) ClearBaseline() {
	m.mu.Lock()
	if !m.hasBaseline {
		m.mu.Unlock()
		return
	}
	m.baseline = nil
	m.hasBaseline = false
	m.mu.Unlock()
	m.Refresh()
}

func (m *BranchStatusMonitor) Refresh() {
	next := m.compute()
	if next == nil {
		return
	}
	m.mu.Lock()
	if m.stopped {
		m.mu.Unlock()
		return
	}
	if equalMeta(m.last, *next) {
		m.mu.Unlock()
		return
	}
	m.last = *next
	startPoll := !m.pollStarted
	m.pollStarted = true
	m.mu.Unlock()
	m.broadcaster.Emit("branch", map[string]any{"meta": *next})
	if startPoll {
		// Started on the first real refresh, never at boot: the repo does not exist
		// until the clone lands.
		go m.pollLoop()
		go m.watchLoop()
	}
}

func (m *BranchStatusMonitor) pollLoop() {
	t := time.NewTicker(3 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-t.C:
			m.mu.Lock()
			ready := m.last.Kind == "ready"
			m.mu.Unlock()
			if ready {
				m.Refresh()
			}
		case <-m.pollStop:
			return
		}
	}
}

func (m *BranchStatusMonitor) Stop() {
	m.mu.Lock()
	if m.stopped {
		m.mu.Unlock()
		return
	}
	m.stopped = true
	started := m.pollStarted
	m.mu.Unlock()
	if started {
		close(m.pollStop)
	}
}

func (m *BranchStatusMonitor) runGit(args []string) string {
	out, ok := Try(args, RunOpts{Cwd: m.repoDir, Env: ReadEnv(m.repoDir)})
	if !ok {
		return ""
	}
	return out
}

func (m *BranchStatusMonitor) readDirtyPaths() map[string]struct{} {
	out := m.runGit([]string{"status", "--porcelain=v1", "-z"})
	if out == "" {
		return map[string]struct{}{}
	}
	return ParsePorcelainZ(out)
}

func (m *BranchStatusMonitor) hashWorktreeFile(path string) string {
	raw, err := os.ReadFile(filepath.Join(m.repoDir, path))
	if err != nil {
		return ""
	}
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}

func (m *BranchStatusMonitor) compute() *events.BranchMeta {
	branch := m.runGit([]string{"rev-parse", "--abbrev-ref", "HEAD"})
	if branch == "" || branch == "HEAD" {
		return nil
	}
	div := ComputeBranchDivergence(m.repoDir, func(args []string) (string, bool) {
		out := m.runGit(args)
		return out, out != ""
	})

	dirtyPaths := m.readDirtyPaths()
	dirty := false
	m.mu.Lock()
	hasBaseline := m.hasBaseline
	baseline := m.baseline
	m.mu.Unlock()
	if len(dirtyPaths) > 0 {
		if !hasBaseline {
			dirty = true
		} else {
			for p := range dirtyPaths {
				baseHash, ok := baseline[p]
				if !ok || m.hashWorktreeFile(p) != baseHash {
					dirty = true
					break
				}
			}
		}
	}

	return &events.BranchMeta{
		Kind: "ready",
		Ready: &events.BranchMetaReady{
			Branch:           branch,
			Base:             div.Base,
			WorkingTreeDirty: dirty,
			Unpushed:         div.Unpushed,
			AheadOfBase:      div.AheadOfBase,
			BehindBase:       div.BehindBase,
			HeadSha:          div.HeadSha,
		},
	}
}

func equalMeta(a, b events.BranchMeta) bool {
	aj, _ := json.Marshal(a)
	bj, _ := json.Marshal(b)
	return string(aj) == string(bj)
}
