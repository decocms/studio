package gitx

import (
	"fmt"
	"log/slog"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/decocms/studio/sandbox-daemon/internal/decofile"
)

var skipHooksEnv = map[string]string{"LEFTHOOK": "0", "HUSKY": "0"}

var emptyHooksOnce sync.Once
var emptyHooksDir string

func getEmptyHooksDir() string {
	emptyHooksOnce.Do(func() {
		dir, err := os.MkdirTemp("", "mesh-sandbox-no-hooks-")
		if err == nil {
			emptyHooksDir = dir
		}
	})
	return emptyHooksDir
}

func CloneUrlHasCredentials(rawUrl string) bool {
	u, err := url.Parse(rawUrl)
	if err != nil || u.User == nil {
		return false
	}
	_, hasPass := u.User.Password()
	return u.User.Username() != "" || hasPass
}

// SyncOriginRemote points `origin` at the credentialed clone URL.
func SyncOriginRemote(repoDir, cloneUrl string) error {
	if !CloneUrlHasCredentials(cloneUrl) {
		return nil
	}
	_, err := Run([]string{"remote", "set-url", "origin", cloneUrl}, RunOpts{Cwd: repoDir})
	return err
}

// PublishBlockedError is returned when publish refuses the current branch. The
// HTTP layer maps it to 409 — it is a precondition the caller can fix (switch
// branches), not a daemon failure.
type PublishBlockedError struct{ Branch string }

func (e *PublishBlockedError) Error() string {
	return fmt.Sprintf(
		"Refusing to push to protected branch %q from a sandbox. Work on a feature branch; changes reach the default branch via PR.",
		e.Branch,
	)
}

// InvalidDecofileBlockError is returned when publish refuses to commit a
// syntactically invalid decofile block. The HTTP layer maps it to 400 — it is a
// data condition the caller can fix, not a daemon failure.
type InvalidDecofileBlockError struct{ Msg string }

func (e *InvalidDecofileBlockError) Error() string { return e.Msg }

// OnInvalidBlock selects publish's disposition for an invalid decofile block.
type OnInvalidBlock string

const (
	// InvalidBlockThrow fails the publish loudly so the user fixes it.
	InvalidBlockThrow OnInvalidBlock = "throw"
	// InvalidBlockSkip drops just the bad block and syncs everything else.
	// Shutdown-sync only: aborting the whole commit would silently lose all the
	// user's OTHER valid work when the sandbox is torn down.
	InvalidBlockSkip OnInvalidBlock = "skip"
)

type PublishDeps struct {
	RepoDir     string
	GetCloneUrl func() string
	GetOperator func() *CoAuthorIdentity
	// OnInvalidBlock defaults to InvalidBlockThrow when empty.
	OnInvalidBlock OnInvalidBlock
	// ReconcileRemote force-pushes the sandbox's state when origin/<branch>
	// diverged. Interactive publish only — shutdown sync leaves it off so a
	// stale teardown never clobbers a concurrent sandbox's work.
	ReconcileRemote bool
}

func changedPaths(status WorkingTreeStatus) []string {
	seen := map[string]bool{}
	var out []string
	for _, f := range status.Files {
		if f.Path == "" || seen[f.Path] {
			continue
		}
		seen[f.Path] = true
		out = append(out, f.Path)
	}
	return out
}

// filterInvalidDecofileBlocks is publish's last-resort net: /write and /edit
// already reject invalid blocks, but a mutation that bypassed them (bash, a git
// merge) would otherwise be committed verbatim and break the whole site render.
func filterInvalidDecofileBlocks(repoDir string, paths []string, mode OnInvalidBlock) ([]string, error) {
	invalid := map[string]bool{}
	for _, rel := range paths {
		if !decofile.IsBlockPath(rel) {
			continue
		}
		content, err := os.ReadFile(filepath.Join(repoDir, rel))
		if err != nil {
			continue // deleted or unreadable — nothing to validate
		}
		jsonErr := decofile.InvalidBlockJSON(rel, string(content))
		if jsonErr == "" {
			continue
		}
		if mode != InvalidBlockSkip {
			return nil, &InvalidDecofileBlockError{Msg: "Refusing to publish: " + jsonErr}
		}
		slog.Warn("skipping from sync", "reason", jsonErr)
		invalid[rel] = true
	}
	if len(invalid) == 0 {
		return paths, nil
	}
	out := make([]string, 0, len(paths))
	for _, p := range paths {
		if !invalid[p] {
			out = append(out, p)
		}
	}
	return out, nil
}

// expandUntrackedDirs replaces directory entries with the files under them:
// `git status --porcelain` collapses an untracked dir into one `?? .deco/` entry,
// hiding a block file from the validator while `git add` still commits it. git
// does the expansion so .gitignore is honored.
func expandUntrackedDirs(repoDir string, paths []string) []string {
	out := make([]string, 0, len(paths))
	for _, p := range paths {
		info, err := os.Stat(filepath.Join(repoDir, p))
		if err != nil || !info.IsDir() {
			out = append(out, p)
			continue
		}
		listed, err := runReadGit(repoDir, []string{"ls-files", "--others", "--exclude-standard", "--", p})
		if err != nil {
			out = append(out, p)
			continue
		}
		for _, f := range strings.Split(listed, "\n") {
			if f = strings.TrimSpace(f); f != "" {
				out = append(out, f)
			}
		}
	}
	return out
}

var gitPushConfig = []string{"-c", "credential.helper=", "-c", "safe.directory=*"}

func pushEnv(repoDir string) map[string]string {
	return map[string]string{
		"GIT_CEILING_DIRECTORIES": repoDir,
		"GIT_OPTIONAL_LOCKS":      "0",
		"GIT_TERMINAL_PROMPT":     "0",
		"GIT_ASKPASS":             "true",
		"LEFTHOOK":                "0",
		"HUSKY":                   "0",
	}
}

func pushBranch(repoDir, branch string, reconcileRemote bool) error {
	// --no-verify: a repo's pre-push script can hang the push, and the shutdown
	// sync shares this path with no room to wait it out before SIGKILL.
	args := append(append([]string{}, gitPushConfig...), "push", "--no-verify", "-u", "origin", branch)
	_, err := Run(args, RunOpts{Cwd: repoDir, Env: pushEnv(repoDir)})
	if err == nil {
		return nil
	}
	// origin/<branch> diverged: a prior publish force-pushed a rebased history,
	// or the sandbox was re-provisioned from base and lost the branch's local
	// commits. Reconcile by force-pushing the state the user sees.
	if !reconcileRemote || !IsNonFastForwardError(err) {
		return err
	}
	fetchArgs := append(append([]string{}, gitPushConfig...), "fetch", "origin", branch)
	if _, ferr := Run(fetchArgs, RunOpts{Cwd: repoDir, Env: pushEnv(repoDir)}); ferr != nil {
		return err
	}
	leaseSha, _ := RemoteBranchSha(repoDir, branch)
	return ForcePushWithLease(repoDir, branch, leaseSha, ForcePushOpts{
		ConfigArgs: gitPushConfig,
		PushArgs:   []string{"--no-verify"},
		Env:        pushEnv(repoDir),
	})
}

func Publish(deps PublishDeps, message string) error {
	repoDir := deps.RepoDir
	branch, err := runReadGit(repoDir, []string{"rev-parse", "--abbrev-ref", "HEAD"})
	if err != nil {
		return err
	}
	if branch == "" || branch == "HEAD" {
		return &GitError{Msg: "Cannot publish from a detached HEAD", Status: -1}
	}
	// The pre-push hook guards this too, but the push below runs --no-verify and
	// skips it. Refuse before committing, so no stray commit is left either.
	for _, protected := range ProtectedBranches(repoDir) {
		if branch == protected {
			return &PublishBlockedError{Branch: branch}
		}
	}

	status, err := ComputeWorkingTreeStatus(repoDir)
	if err != nil {
		return err
	}
	paths, err := filterInvalidDecofileBlocks(
		repoDir,
		expandUntrackedDirs(repoDir, changedPaths(status)),
		deps.OnInvalidBlock,
	)
	if err != nil {
		return err
	}
	if len(paths) > 0 {
		args := append([]string{"add", "--"}, paths...)
		if _, err := runReadGit(repoDir, args); err != nil {
			return err
		}
	}
	_, cleanIndex := tryReadGit(repoDir, []string{"diff", "--cached", "--quiet"})
	hasStagedChanges := !cleanIndex
	if hasStagedChanges {
		msg := strings.TrimSpace(message)
		if msg == "" {
			msg = "Update from sandbox"
		}
		var operator *CoAuthorIdentity
		if deps.GetOperator != nil {
			operator = deps.GetOperator()
		}
		commitMsg := AppendCoAuthorTrailer(msg, operator)
		env := map[string]string{
			"GIT_CEILING_DIRECTORIES": repoDir,
			"GIT_OPTIONAL_LOCKS":      "0",
		}
		for k, v := range skipHooksEnv {
			env[k] = v
		}
		args := []string{"-c", "core.hooksPath=" + getEmptyHooksDir(), "commit", "--no-verify", "-m", commitMsg}
		if _, err := Run(args, RunOpts{Cwd: repoDir, Env: env}); err != nil {
			return err
		}
	}

	cloneUrl := ""
	if deps.GetCloneUrl != nil {
		cloneUrl = deps.GetCloneUrl()
	}
	if cloneUrl != "" {
		if err := SyncOriginRemote(repoDir, cloneUrl); err != nil {
			return err
		}
	} else {
		originUrl, _ := tryReadGit(repoDir, []string{"remote", "get-url", "origin"})
		if strings.Contains(originUrl, "github.com") && !CloneUrlHasCredentials(originUrl) {
			return &GitError{
				Msg:    "GitHub push requires an authenticated clone URL. Connect GitHub for this project and restart the sandbox.",
				Status: -1,
			}
		}
	}

	return pushBranch(repoDir, branch, deps.ReconcileRemote)
}

// Discard restores tracked files and deletes untracked ones.
func Discard(repoDir string, relPaths []string) error {
	status, err := ComputeWorkingTreeStatus(repoDir)
	if err != nil {
		return err
	}
	inList := func(list []string, p string) bool {
		for _, v := range list {
			if v == p {
				return true
			}
		}
		return false
	}
	filesByPath := map[string]PorcelainFile{}
	for _, f := range status.Files {
		filesByPath[f.Path] = f
	}
	// A renamed file's new path never existed at HEAD, so the isNew check
	// below would treat it as untracked and remove it outright — losing the
	// content entirely, since the original path is already gone from the
	// working tree too. Discarding a rename must instead restore the
	// original file from HEAD and unstage + drop the new path.
	var toRestore, toDelete, toRestoreFromHead, renamedNewPaths []string
	for _, fp := range relPaths {
		if origPath := filesByPath[fp].OrigPath; origPath != "" {
			toRestoreFromHead = append(toRestoreFromHead, origPath)
			renamedNewPaths = append(renamedNewPaths, fp)
			toDelete = append(toDelete, fp)
			continue
		}
		isNew := inList(status.NotAdded, fp) || inList(status.Created, fp) ||
			readRefFile(repoDir, "HEAD", fp) == nil
		if isNew {
			toDelete = append(toDelete, fp)
		} else {
			toRestore = append(toRestore, fp)
		}
	}
	if len(toRestoreFromHead) > 0 {
		// Unstage the rename's "new path added" side before restoring the
		// original — otherwise it survives in the index even after the
		// working tree file below is deleted.
		resetArgs := append([]string{"reset", "--"}, renamedNewPaths...)
		if _, err := runReadGit(repoDir, resetArgs); err != nil {
			return err
		}
		headArgs := append([]string{"checkout", "HEAD", "--"}, toRestoreFromHead...)
		if _, err := runReadGit(repoDir, headArgs); err != nil {
			return err
		}
	}
	if len(toRestore) > 0 {
		args := append([]string{"checkout", "--"}, toRestore...)
		if _, err := runReadGit(repoDir, args); err != nil {
			return err
		}
	}
	for _, fp := range toDelete {
		os.Remove(filepath.Join(repoDir, fp))
	}
	return nil
}
