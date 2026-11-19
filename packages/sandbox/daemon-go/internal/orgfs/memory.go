package orgfs

import (
	"errors"
	"io"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// What the harness reads from its memory folder while it starts.
const memoryIndexName = "MEMORY.md"

// How long the folder may take to answer before the run goes without memory.
// Variable for the test.
var memoryProbeBudget = 5 * time.Second

// MemoryDir resolves a run's memory folder, given relative to the org home
// volume, to its absolute path on the mount. "" means the run gets no memory:
// home is not mounted, the path would leave it, or the folder did not answer
// within the budget.
//
// Checked here, with a deadline, because Claude Code reads the folder's index
// on its startup path and a wedged org-fs read blocks without end (see
// `readableWithin`). Never the pod's own disk: a folder there dies with the pod
// and is shared by every run in it.
func (l *Links) MemoryDir(directory string) string {
	dir := l.memoryPath(directory)
	if dir == "" {
		return ""
	}
	done := make(chan error, 1)
	go func() { done <- probeMemoryDir(dir) }()
	select {
	case err := <-done:
		if err != nil {
			slog.Warn("memory folder unusable; run gets no memory", "err", err)
			return ""
		}
		return dir
	case <-time.After(memoryProbeBudget):
		slog.Warn("memory folder did not answer; run gets no memory", "budget", memoryProbeBudget)
		return ""
	}
}

// memoryPath joins directory onto the mounted home volume, or "" when home is
// not mounted or the result would not sit inside it.
func (l *Links) memoryPath(directory string) string {
	if l == nil || directory == "" || filepath.IsAbs(directory) {
		return ""
	}
	home := filepath.Join(l.AppRoot, "org", "home")
	mounted := false
	for _, m := range l.ActiveMounts() {
		if m.MountPath == home {
			mounted = true
		}
	}
	if !mounted {
		return ""
	}
	dir := filepath.Join(home, directory)
	if !strings.HasPrefix(dir, home+string(filepath.Separator)) {
		return ""
	}
	return dir
}

// probeMemoryDir creates the folder and reads the first byte of its index. A
// missing index is a new member's empty memory, not a failure.
func probeMemoryDir(dir string) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	f, err := os.Open(filepath.Join(dir, memoryIndexName))
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	defer f.Close()
	if _, err := f.Read(make([]byte, 1)); err != nil && err != io.EOF {
		return err
	}
	return nil
}
