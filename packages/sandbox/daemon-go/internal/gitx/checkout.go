package gitx

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// ResolveRemoteDefaultBranch reads origin/HEAD, falling back to main.
func ResolveRemoteDefaultBranch(repoDir string) string {
	base, ok := Try([]string{"symbolic-ref", "--short", "refs/remotes/origin/HEAD"}, RunOpts{Cwd: repoDir})
	if ok {
		base = strings.TrimSpace(base)
		base = strings.TrimPrefix(base, "origin/")
		if base != "" {
			return base
		}
	}
	return "main"
}

func localBranchExists(repoDir, branch string) bool {
	_, ok := Try([]string{"show-ref", "--verify", "--quiet", "refs/heads/" + branch}, RunOpts{Cwd: repoDir})
	return ok
}

type CheckoutBranchParams struct {
	RepoDir string
	Branch  string
	// Gc is the prefixed git command (env prefix + git flags) interpolated
	// into `sh -c` steps.
	Gc      string
	RunStep func(cmd string) int
	Log     func(message string)
}

const lsRemoteNoMatch = 2

// CheckoutBranch checks out `branch` in an existing clone: remote branch →
// fetch+reset, local-only → checkout, absent → fork from default branch.
func CheckoutBranch(p CheckoutBranchParams) error {
	if head, ok := Try([]string{"rev-parse", "--abbrev-ref", "HEAD"}, RunOpts{Cwd: p.RepoDir}); ok {
		if strings.TrimSpace(head) == p.Branch {
			return nil
		}
	}

	probe := p.RunStep(fmt.Sprintf("%s ls-remote --exit-code --heads origin %s", p.Gc, p.Branch))

	if probe == 0 {
		if code := p.RunStep(fmt.Sprintf("%s fetch --depth 1 origin +refs/heads/%s:refs/remotes/origin/%s", p.Gc, p.Branch, p.Branch)); code != 0 {
			return fmt.Errorf("git fetch origin %s exited %d", p.Branch, code)
		}
		if code := p.RunStep(fmt.Sprintf("%s checkout -B %s refs/remotes/origin/%s", p.Gc, p.Branch, p.Branch)); code != 0 {
			return fmt.Errorf("git checkout -B %s exited %d", p.Branch, code)
		}
		return nil
	}

	if probe == lsRemoteNoMatch {
		if localBranchExists(p.RepoDir, p.Branch) {
			p.Log(fmt.Sprintf("[orchestrator] branch '%s' not on remote; checking out local branch\r\n", p.Branch))
			if code := p.RunStep(fmt.Sprintf("%s checkout %s", p.Gc, p.Branch)); code != 0 {
				return fmt.Errorf("git checkout %s exited %d", p.Branch, code)
			}
			return nil
		}
		defaultBranch := ResolveRemoteDefaultBranch(p.RepoDir)
		p.Log(fmt.Sprintf("[orchestrator] branch '%s' not on remote; creating from default branch '%s'\r\n", p.Branch, defaultBranch))
		if code := p.RunStep(fmt.Sprintf("%s fetch --depth 1 origin +refs/heads/%s:refs/remotes/origin/%s", p.Gc, defaultBranch, defaultBranch)); code != 0 {
			return fmt.Errorf("git fetch origin %s exited %d", defaultBranch, code)
		}
		if code := p.RunStep(fmt.Sprintf("%s checkout -B %s refs/remotes/origin/%s", p.Gc, p.Branch, defaultBranch)); code != 0 {
			return fmt.Errorf("git checkout -B %s exited %d", p.Branch, code)
		}
		return nil
	}

	return fmt.Errorf("git ls-remote --heads origin %s exited %d", p.Branch, probe)
}

const protectedBranchHook = `#!/bin/sh
while IFS=' ' read -r _local_ref _local_sha remote_ref _remote_sha; do
  branch="${remote_ref#refs/heads/}"
  case "$branch" in
    main|master)
      echo "error: pushing to '$branch' is not allowed from a sandbox" >&2
      exit 1
      ;;
  esac
done
exit 0
`

func InstallProtectedBranchHook(repoDir string) error {
	hooksDir := filepath.Join(repoDir, ".git", "hooks")
	if err := os.MkdirAll(hooksDir, 0o755); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(hooksDir, "pre-push"), []byte(protectedBranchHook), 0o755)
}

func ConfigureGitIdentity(repoDir, userName, userEmail string) error {
	if userName == "" || userEmail == "" {
		return nil
	}
	if _, err := Run([]string{"config", "user.name", userName}, RunOpts{Cwd: repoDir}); err != nil {
		return err
	}
	_, err := Run([]string{"config", "user.email", userEmail}, RunOpts{Cwd: repoDir})
	return err
}
