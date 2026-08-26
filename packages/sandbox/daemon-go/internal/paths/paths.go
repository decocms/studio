package paths

import (
	"os"
	"path/filepath"
	"strings"
)

func SafePath(workspaceRoot, baseDir, userPath string) (string, bool) {
	var resolved string
	if filepath.IsAbs(userPath) {
		resolved = filepath.Clean(userPath)
	} else {
		resolved = filepath.Join(baseDir, userPath)
	}
	if resolved != workspaceRoot && !strings.HasPrefix(resolved, workspaceRoot+string(filepath.Separator)) {
		return "", false
	}
	return resolved, true
}

func ResolvePmRoot(repoDir, pmPath string) string {
	if pmPath == "" {
		return repoDir
	}
	if filepath.IsAbs(pmPath) {
		return pmPath
	}
	return filepath.Join(repoDir, pmPath)
}

func AppLogPath(logsDir, name string) string {
	return filepath.Join(logsDir, "app", name)
}

func HasGitRepo(repoDir string) bool {
	_, err := os.Stat(filepath.Join(repoDir, ".git"))
	return err == nil
}

// SecondaryRepoRoot is where extra checkouts live: a sibling of the primary
// repo dir, never inside it, so the primary's `git status` stays clean without
// anyone maintaining an exclude file.
func SecondaryRepoRoot(repoDir string) string {
	return filepath.Join(filepath.Dir(repoDir), "repos")
}

// SecondaryRepoDir is one secondary checkout's directory. `name` reaches the
// daemon over HTTP, and config validation is not the only thing standing
// between it and a path join, so this refuses rather than reinterprets: a name
// carrying a separator is rejected outright, not silently rebased onto the root
// the way `filepath.Join` would. The containment check behind it is the belt to
// that brace.
func SecondaryRepoDir(repoDir, name string) (string, bool) {
	if name == "" || name == "." || name == ".." ||
		strings.ContainsRune(name, '/') || strings.ContainsRune(name, filepath.Separator) {
		return "", false
	}
	root := SecondaryRepoRoot(repoDir)
	dir := filepath.Join(root, name)
	if dir != root && strings.HasPrefix(dir, root+string(filepath.Separator)) {
		return dir, true
	}
	return "", false
}
