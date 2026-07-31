package gitx

import (
	"os"
	"path/filepath"
	"strings"
)

const maxConflictResolutionAttempts = 50

var nonInteractiveEnv = map[string]string{"GIT_EDITOR": "true", "EDITOR": "true"}

func rebaseEnv(repoDir string, extra ...map[string]string) map[string]string {
	env := map[string]string{"GIT_CEILING_DIRECTORIES": repoDir}
	for _, m := range extra {
		for k, v := range m {
			env[k] = v
		}
	}
	return env
}

func rebaseRun(repoDir string, args []string, extraEnv ...map[string]string) (string, error) {
	return Run(args, RunOpts{Cwd: repoDir, Env: rebaseEnv(repoDir, extraEnv...)})
}

func rebaseTry(repoDir string, args []string, extraEnv ...map[string]string) (string, bool) {
	out, err := rebaseRun(repoDir, args, extraEnv...)
	if err != nil {
		return "", false
	}
	return out, true
}

func isRebaseInProgress(repoDir string) bool {
	for _, d := range []string{"rebase-merge", "rebase-apply"} {
		if _, err := os.Stat(filepath.Join(repoDir, ".git", d)); err == nil {
			return true
		}
	}
	return false
}

func readStatusFiles(repoDir string) ([]PorcelainFile, error) {
	porcelain, err := rebaseRun(repoDir, []string{"status", "--porcelain=v1", "-z"})
	if err != nil {
		return nil, err
	}
	return ParsePorcelainFiles(porcelain), nil
}

func getConflictedFiles(repoDir string) []string {
	files, err := readStatusFiles(repoDir)
	if err != nil {
		return nil
	}
	var out []string
	for _, f := range files {
		if strings.Contains(f.Index+f.WorkingDir, "U") {
			out = append(out, f.Path)
		}
	}
	return out
}

func abortRebase(repoDir string) {
	if isRebaseInProgress(repoDir) {
		rebaseTry(repoDir, []string{"rebase", "--abort"})
	}
}

func commitBeforeRebase(repoDir string, operator *CoAuthorIdentity) error {
	porcelain, ok := rebaseTry(repoDir, []string{"status", "--porcelain"})
	if !ok || strings.TrimSpace(porcelain) == "" {
		return nil
	}
	if _, err := rebaseRun(repoDir, []string{"add", "."}); err != nil {
		return err
	}
	args := []string{
		"-c", "core.hooksPath=" + getEmptyHooksDir(),
		"commit", "--no-verify", "-m", AppendCoAuthorTrailer("Before rebase", operator),
	}
	_, err := rebaseRun(repoDir, args, skipHooksEnv)
	return err
}

func resolveConflictFile(repoDir string, f PorcelainFile) error {
	xy := f.Index + f.WorkingDir
	abs := filepath.Join(repoDir, f.Path)

	if strings.Contains(xy, "U") && (f.Index == "D" || f.WorkingDir == "D") {
		if _, err := os.Stat(abs); err == nil {
			_, err := rebaseRun(repoDir, []string{"add", "--", f.Path})
			return err
		}
		_, err := rebaseRun(repoDir, []string{"rm", "-f", "--", f.Path})
		return err
	}

	if f.WorkingDir == "D" && !strings.Contains(xy, "U") {
		_, err := rebaseRun(repoDir, []string{"rm", "-f", f.Path})
		return err
	}

	if _, err := rebaseRun(repoDir, []string{"checkout", "--theirs", "--", f.Path}); err != nil {
		return err
	}
	_, err := rebaseRun(repoDir, []string{"add", "--", f.Path})
	return err
}

func continueRebase(repoDir string) error {
	_, err := rebaseRun(repoDir, []string{"rebase", "--continue"}, nonInteractiveEnv)
	if err == nil {
		return nil
	}
	if !strings.Contains(FormatGitError(err), "staged changes in your working tree") {
		return err
	}
	args := []string{"-c", "core.hooksPath=" + getEmptyHooksDir(), "commit", "--no-edit", "--no-verify"}
	if _, cerr := rebaseRun(repoDir, args, nonInteractiveEnv, skipHooksEnv); cerr != nil {
		return cerr
	}
	if isRebaseInProgress(repoDir) {
		_, err := rebaseRun(repoDir, []string{"rebase", "--continue"}, nonInteractiveEnv)
		return err
	}
	return nil
}

func resolveConflictsRecursively(repoDir string, wip int) error {
	if wip <= 0 {
		abortRebase(repoDir)
		return &GitError{Msg: "Rebase conflict resolution exceeded maximum attempts", Status: -1}
	}
	files, err := readStatusFiles(repoDir)
	if err != nil {
		return err
	}
	for _, f := range files {
		if strings.Contains(f.Index+f.WorkingDir, "U") {
			if err := resolveConflictFile(repoDir, f); err != nil {
				return err
			}
		}
	}
	if len(getConflictedFiles(repoDir)) != 0 {
		abortRebase(repoDir)
		return &GitError{Msg: "Unresolved rebase conflicts remain", Status: -1}
	}
	if err := continueRebase(repoDir); err != nil {
		message := FormatGitError(err)
		remaining := getConflictedFiles(repoDir)
		if !strings.Contains(message, "CONFLICT") && len(remaining) == 0 && !isRebaseInProgress(repoDir) {
			abortRebase(repoDir)
			return err
		}
		if len(remaining) == 0 {
			abortRebase(repoDir)
			return err
		}
		return resolveConflictsRecursively(repoDir, wip-1)
	}
	return nil
}

// RebaseOntoBase rebases the current branch onto origin/<base>, preferring
// branch changes on conflict, then force-pushes.
func RebaseOntoBase(repoDir, base string, operator *CoAuthorIdentity) error {
	if err := AssertValidRemoteBranchName(base); err != nil {
		return err
	}
	branch, err := rebaseRun(repoDir, []string{"rev-parse", "--abbrev-ref", "HEAD"})
	if err != nil {
		return err
	}
	if branch == "" || branch == "HEAD" {
		return &GitError{Msg: "Cannot rebase from a detached HEAD", Status: -1}
	}

	if _, err := rebaseRun(repoDir, []string{"fetch", "-p", "origin", base, branch}); err != nil {
		return err
	}
	leaseSha, _ := RemoteBranchSha(repoDir, branch)

	rebaseTry(repoDir, []string{"submodule", "update", "--init", "--recursive", "--depth", "1"})

	upstream := "origin/" + base
	if _, ok := rebaseTry(repoDir, []string{"rev-parse", "--verify", upstream}); !ok {
		return &GitError{Msg: "Base branch '" + base + "' not found on origin", Status: -1}
	}

	if err := commitBeforeRebase(repoDir, operator); err != nil {
		return err
	}

	if _, err := rebaseRun(repoDir, []string{"rebase", "--autostash", "-X", "theirs", upstream}); err != nil {
		if !isRebaseInProgress(repoDir) {
			return err
		}
		if rerr := resolveConflictsRecursively(repoDir, maxConflictResolutionAttempts); rerr != nil {
			return rerr
		}
	}

	if isRebaseInProgress(repoDir) {
		abortRebase(repoDir)
		return &GitError{Msg: "Rebase did not complete", Status: -1}
	}

	return ForcePushWithLease(repoDir, branch, leaseSha, ForcePushOpts{})
}
