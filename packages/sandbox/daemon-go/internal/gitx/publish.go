package gitx

import (
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
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

type PublishDeps struct {
	RepoDir     string
	GetCloneUrl func() string
	GetOperator func() *CoAuthorIdentity
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

func pushBranch(repoDir, branch string) error {
	args := []string{"-c", "credential.helper=", "-c", "safe.directory=*", "push", "-u", "origin", branch}
	env := map[string]string{
		"GIT_CEILING_DIRECTORIES": repoDir,
		"GIT_OPTIONAL_LOCKS":      "0",
		"GIT_TERMINAL_PROMPT":     "0",
		"GIT_ASKPASS":             "true",
		"LEFTHOOK":                "0",
		"HUSKY":                   "0",
	}
	_, err := Run(args, RunOpts{Cwd: repoDir, Env: env})
	return err
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

	status, err := ComputeWorkingTreeStatus(repoDir)
	if err != nil {
		return err
	}
	paths := changedPaths(status)
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

	return pushBranch(repoDir, branch)
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
	var toRestore, toDelete []string
	for _, fp := range relPaths {
		isNew := inList(status.NotAdded, fp) || inList(status.Created, fp) ||
			readRefFile(repoDir, "HEAD", fp) == nil
		if isNew {
			toDelete = append(toDelete, fp)
		} else {
			toRestore = append(toRestore, fp)
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
