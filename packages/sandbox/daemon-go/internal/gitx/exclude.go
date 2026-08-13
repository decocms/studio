package gitx

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
)

var (
	requestedMu sync.Mutex
	requested   = map[string][]string{}
)

// EnsureExclude registers `line` in `<repoDir>/.git/info/exclude` — local-only,
// unlike .gitignore — so the shutdown `git add -A` never commits daemon-managed
// paths. Best-effort; no-op without a `.git` dir, but the request is remembered
// for {@link ReapplyExcludes}.
func EnsureExclude(repoDir, line string) {
	remember(repoDir, line)
	gitDir := filepath.Join(repoDir, ".git")
	st, err := os.Lstat(gitDir)
	if err != nil || !st.IsDir() {
		return
	}
	excludePath := filepath.Join(gitDir, "info", "exclude")
	existing, err := os.ReadFile(excludePath)
	if err != nil {
		// Template-less clones (libgit2/JGit, bare templates) lack info/exclude.
		if mkErr := os.MkdirAll(filepath.Join(gitDir, "info"), 0o755); mkErr != nil {
			return
		}
		os.WriteFile(excludePath, []byte(line+"\n"), 0o644)
		return
	}
	for _, l := range strings.Split(string(existing), "\n") {
		if l == line {
			return
		}
	}
	f, err := os.OpenFile(excludePath, os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	f.WriteString(line + "\n")
}

// ReapplyExcludes re-registers every line EnsureExclude was asked for on this
// repoDir. Call it whenever a `.git` appears: a repo-less pod writes its
// daemon-managed paths (the org-fs links, the tools catalog) BEFORE any clone,
// where EnsureExclude has nowhere to write — and `git init` in that non-empty
// dir then hands the shutdown `git add -A` a clean slate that commits them.
func ReapplyExcludes(repoDir string) {
	requestedMu.Lock()
	lines := append([]string(nil), requested[repoDir]...)
	requestedMu.Unlock()
	for _, line := range lines {
		EnsureExclude(repoDir, line)
	}
}

func remember(repoDir, line string) {
	requestedMu.Lock()
	defer requestedMu.Unlock()
	for _, l := range requested[repoDir] {
		if l == line {
			return
		}
	}
	requested[repoDir] = append(requested[repoDir], line)
}
