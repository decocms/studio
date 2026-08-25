package gitx

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/decocms/studio/sandbox-daemon/internal/events"
)

type branchBroadcaster interface {
	Emit(name string, payload any)
}

// BranchStatusMonitor surfaces BranchMeta with a content-hash dirty-baseline.
// Change detection: fsnotify (watch.go) + a 3s poll for atomic saves and watch
// gaps; the fs routes also Refresh on their own writes.
type BranchStatusMonitor struct {
	mu          sync.Mutex
	repoDir     string
	broadcaster branchBroadcaster
	last        events.BranchMeta
	baseline    map[string]string
	hasBaseline bool
	// userTouched is the set of repo-relative paths written through the daemon's
	// own fs routes — the user's work. Boot dirt is written by the dev server
	// process directly and never lands here, so it is exactly the separator the
	// time-based baseline can't provide: a path the user edited is never folded
	// into the baseline. Copy-on-write so `compute` can read a snapshot lock-free.
	userTouched map[string]struct{}
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

// ArmBaseline snapshots what is dirty right now as "not the user's work": a
// checkout is littered with generated artifacts (lockfiles, `*.gen.*`, build
// output the repo doesn't gitignore) before anyone edits anything, and counting
// those as changes made a pristine branch look publishable.
//
// First arm wins — a later call is a no-op. The arm points are boot outcomes
// (see the callers), and a dev server that dies and comes back re-enters them;
// re-baselining there would swallow every edit made in between, which is
// exactly the data loss the hash comparison exists to prevent.
func (m *BranchStatusMonitor) ArmBaseline() {
	m.mu.Lock()
	if m.hasBaseline {
		m.mu.Unlock()
		return
	}
	// Claimed before the scan so a concurrent arm can't double-scan. Until the
	// map lands, `compute` sees an empty baseline and reports dirty — the same
	// answer it gave a moment earlier, un-armed.
	m.hasBaseline = true
	m.mu.Unlock()
	paths := m.readDirtyPaths()
	baseline := make(map[string]string, len(paths))
	for p := range paths {
		baseline[p] = m.hashWorktreeFile(p)
	}
	m.mu.Lock()
	m.baseline = baseline
	m.mu.Unlock()
	m.Refresh()
}

// MarkUserTouched records a path the user wrote through the fs routes so the
// baseline never counts it as boot dirt. An edit made while the sandbox is still
// `starting` — before the baseline arms — would otherwise be snapshotted into the
// baseline and silently swallowed; this keeps it publishable. Refreshing is the
// caller's (the fs route already does).
func (m *BranchStatusMonitor) MarkUserTouched(path string) {
	rel := m.toRepoRel(path)
	if rel == "" {
		return
	}
	m.mu.Lock()
	next := make(map[string]struct{}, len(m.userTouched)+1)
	for p := range m.userTouched {
		next[p] = struct{}{}
	}
	next[rel] = struct{}{}
	m.userTouched = next
	m.mu.Unlock()
}

// toRepoRel normalizes a fs-route path to the slash-separated, repo-relative form
// `git status` emits (relative paths resolve against repoDir, matching SafePath).
// Anything outside the repo returns "" and is ignored.
func (m *BranchStatusMonitor) toRepoRel(path string) string {
	abs := path
	if !filepath.IsAbs(abs) {
		abs = filepath.Join(m.repoDir, path)
	}
	rel, err := filepath.Rel(m.repoDir, filepath.Clean(abs))
	if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return ""
	}
	return filepath.ToSlash(rel)
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
	userTouched := m.userTouched
	m.mu.Unlock()
	// A path the user wrote through the fs routes is their work regardless of the
	// baseline OR whether the dev server has settled — boot dirt is written by the
	// dev server directly and never comes through those routes. Reporting it dirty
	// before the baseline arms is what frees the header from the dev-server
	// lifecycle: an edit made while the sandbox is still `starting` is publishable
	// immediately, instead of waiting on a probe that may never fire.
	//
	// For every other dirty path we still need the baseline: un-armed means boot
	// has not settled (ArmBaseline runs at every boot outcome), so a non-user
	// path here is boot dirt — reporting it as the user's work armed
	// "Review & Publish" on an untouched, empty thread.
	if len(dirtyPaths) > 0 {
		for p := range dirtyPaths {
			if _, touched := userTouched[p]; touched {
				dirty = true
				break
			}
			if !hasBaseline {
				continue
			}
			baseHash, ok := baseline[p]
			if !ok || m.hashWorktreeFile(p) != baseHash {
				dirty = true
				break
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
