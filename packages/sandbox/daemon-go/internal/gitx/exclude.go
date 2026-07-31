package gitx

import (
	"os"
	"path/filepath"
	"strings"
)

// EnsureExclude registers `line` in `<repoDir>/.git/info/exclude` so the
// daemon's shutdown `git add -A` never commits daemon-managed paths onto user
// branches. info/exclude is local-only (unlike .gitignore), so it never leaks
// into the repo. No-op without a `.git` dir. Best-effort: an unwritable .git
// never blocks the caller.
func EnsureExclude(repoDir, line string) {
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
