package gitx

import (
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/fsnotify/fsnotify"
)

// Change detection for branch/dirty metadata and the `file-changed` SSE event.
// The 3s poll alone is not enough: a CLI harness edits through `bash`, not the fs
// routes, so only a watcher can emit `file-changed` for those edits.
const (
	// An editor save or a `git checkout` is a burst, and each refresh shells out.
	watchDebounce = 250 * time.Millisecond
	// inotify watches are a per-user kernel resource and a monorepo holds tens of
	// thousands of dirs; past the cap the poll is the safety net.
	maxWatchedDirs = 4096
)

// Build/package-manager churn: noise for `file-changed` and what would exhaust
// the inotify budget. Anything tracked in them still surfaces via the poll.
var watcherNoisyDirs = map[string]bool{
	"node_modules": true,
	".next":        true,
	"dist":         true,
	"build":        true,
	".turbo":       true,
	".cache":       true,
}

func isWatcherPathNoisy(rel string) bool {
	first, _, _ := strings.Cut(rel, string(filepath.Separator))
	return watcherNoisyDirs[first]
}

// watchLoop mirrors changes in the repo into Refresh + OnFileChanged until
// Stop(). Best-effort: if the watcher cannot start, the 3s poll still covers
// change detection (just later, and without per-path events).
func (m *BranchStatusMonitor) watchLoop() {
	w, err := fsnotify.NewWatcher()
	if err != nil {
		return
	}
	defer w.Close()
	watched := m.addTree(w, m.repoDir, 0)

	// A steady 250ms tick instead of a reset-on-every-event timer: same coalescing
	// window, no timer bookkeeping, and an idle tick costs nothing next to the git
	// call it is throttling.
	tick := time.NewTicker(watchDebounce)
	defer tick.Stop()
	pending := false

	for {
		select {
		case ev, ok := <-w.Events:
			if !ok {
				return
			}
			rel, err := filepath.Rel(m.repoDir, ev.Name)
			if err != nil || rel == "." || strings.HasPrefix(rel, "..") {
				continue
			}
			pending = true
			// A new directory needs its own watch (fsnotify is not recursive), or
			// everything created inside it afterwards is invisible.
			if ev.Op&fsnotify.Create != 0 && watched < maxWatchedDirs {
				if st, err := os.Lstat(ev.Name); err == nil && st.IsDir() {
					watched += m.addTree(w, ev.Name, watched)
				}
			}
			// `.git/` churn moves branch/dirty metadata but is not a user file edit.
			if rel == ".git" || strings.HasPrefix(rel, ".git"+string(filepath.Separator)) {
				continue
			}
			if m.onFileChanged != nil && !isWatcherPathNoisy(rel) {
				m.onFileChanged(filepath.ToSlash(rel))
			}
		case <-w.Errors:
			// Watch errors are recoverable-by-poll; nothing useful to do here.
		case <-tick.C:
			if !pending {
				continue
			}
			pending = false
			// The orchestrator owns every pre-ready transition; a watcher-driven
			// refresh before then would race it.
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

// addTree watches root and its subdirectories, skipping the noisy dirs and all
// of `.git` but its top level and `refs/`. Returns how many watches it added.
func (m *BranchStatusMonitor) addTree(w *fsnotify.Watcher, root string, already int) int {
	added := 0
	filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil || !d.IsDir() {
			return nil
		}
		if already+added >= maxWatchedDirs {
			return filepath.SkipAll
		}
		rel, relErr := filepath.Rel(m.repoDir, path)
		if relErr != nil {
			return nil
		}
		if rel != "." {
			name := d.Name()
			if watcherNoisyDirs[name] {
				return filepath.SkipDir
			}
			// Inside .git, keep only the top level and refs/.
			if strings.HasPrefix(rel, ".git"+string(filepath.Separator)) &&
				!strings.HasPrefix(rel, filepath.Join(".git", "refs")) {
				return filepath.SkipDir
			}
		}
		if w.Add(path) == nil {
			added++
		}
		return nil
	})
	return added
}
