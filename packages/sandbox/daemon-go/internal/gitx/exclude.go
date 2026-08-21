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
	appendExcludeLine(filepath.Join(gitDir, "info", "exclude"), line)
	// An exclude covers UNTRACKED paths only, so it cannot hide a daemon-managed
	// path that some build already committed — hence the index bit as well.
	ignoreTracked(repoDir, strings.TrimPrefix(line, "/"))
}

func appendExcludeLine(excludePath, line string) {
	existing, err := os.ReadFile(excludePath)
	if err != nil {
		// Template-less clones (libgit2/JGit, bare templates) lack info/exclude.
		if mkErr := os.MkdirAll(filepath.Dir(excludePath), 0o755); mkErr != nil {
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

// ignoreTracked stops git reporting TRACKED paths matching `pathspec` by setting
// their skip-worktree bit. Nothing to do in a healthy repo — but a build that
// predated {@link ReapplyExcludes} committed the org-fs skill symlinks onto real
// site repos, and a committed path is one an exclude can never mask: every clone
// of that repo tracks it, and the org-fs sync replacing each symlink with a real
// directory surfaced 33 phantom deletions in the publish dialog of every new
// chat, indefinitely.
//
// The index bit is the only fix the daemon owns. The residue itself lives on the
// user's default branch, where only they can delete it, and until they do these
// paths must read as "not a change" — they are the daemon's, not the user's.
//
// ponytail: no history rewrite, no `git rm`. Staging a deletion would put the
// daemon's cleanup into the user's next commit; skip-worktree just makes git
// stop looking. The known ceiling: a later branch switch that wants to change
// one of these paths refuses with "Entry not uptodate" — acceptable for paths
// nothing but this daemon writes.
func ignoreTracked(repoDir, pathspec string) {
	if pathspec == "" {
		return
	}
	listed, ok := Try([]string{"ls-files", "-z", "--", pathspec}, RunOpts{
		Cwd: repoDir, Env: ReadEnv(repoDir),
	})
	if !ok || listed == "" {
		return
	}
	var paths []string
	for _, p := range strings.Split(listed, "\x00") {
		if p != "" {
			paths = append(paths, p)
		}
	}
	if len(paths) == 0 {
		return
	}
	args := append([]string{"update-index", "--skip-worktree", "--"}, paths...)
	Try(args, RunOpts{Cwd: repoDir})
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
