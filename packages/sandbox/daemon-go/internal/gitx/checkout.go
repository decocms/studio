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
	// RunStep spawns git argv directly. No shell: `branch` is config-supplied
	// and git permits `;`, `$` and backticks in ref names.
	RunStep func(argv []string) int
	Log     func(message string)
}

const lsRemoteNoMatch = 2

// CheckoutBranch checks out `branch` in an existing clone: remote branch →
// fetch+reset, local-only → checkout, absent → fork from default branch.
func CheckoutBranch(p CheckoutBranchParams) error {
	if err := AssertValidRemoteBranchName(p.Branch); err != nil {
		return err
	}
	if head, ok := Try([]string{"rev-parse", "--abbrev-ref", "HEAD"}, RunOpts{Cwd: p.RepoDir}); ok {
		if strings.TrimSpace(head) == p.Branch {
			return nil
		}
	}
	git := func(extra ...string) []string {
		return append(CheckoutBaseArgv(p.RepoDir), extra...)
	}
	refspec := func(b string) string {
		return fmt.Sprintf("+refs/heads/%s:refs/remotes/origin/%s", b, b)
	}

	probe := p.RunStep(git("ls-remote", "--exit-code", "--heads", "origin", p.Branch))

	if probe == 0 {
		if code := p.RunStep(git("fetch", "--depth", "1", "origin", refspec(p.Branch))); code != 0 {
			return fmt.Errorf("git fetch origin %s exited %d", p.Branch, code)
		}
		if code := p.RunStep(git("checkout", "-B", p.Branch, "refs/remotes/origin/"+p.Branch)); code != 0 {
			return fmt.Errorf("git checkout -B %s exited %d", p.Branch, code)
		}
		return nil
	}

	if probe == lsRemoteNoMatch {
		if localBranchExists(p.RepoDir, p.Branch) {
			p.Log(fmt.Sprintf("[orchestrator] branch '%s' not on remote; checking out local branch\r\n", p.Branch))
			if code := p.RunStep(git("checkout", p.Branch)); code != 0 {
				return fmt.Errorf("git checkout %s exited %d", p.Branch, code)
			}
			return nil
		}
		defaultBranch := ResolveRemoteDefaultBranch(p.RepoDir)
		if !IsSafeRefName(defaultBranch) {
			return fmt.Errorf("refusing unsafe default branch name %q", defaultBranch)
		}
		p.Log(fmt.Sprintf("[orchestrator] branch '%s' not on remote; creating from default branch '%s'\r\n", p.Branch, defaultBranch))
		if code := p.RunStep(git("fetch", "--depth", "1", "origin", refspec(defaultBranch))); code != 0 {
			return fmt.Errorf("git fetch origin %s exited %d", defaultBranch, code)
		}
		if code := p.RunStep(git("checkout", "-B", p.Branch, "refs/remotes/origin/"+defaultBranch)); code != 0 {
			return fmt.Errorf("git checkout -B %s exited %d", p.Branch, code)
		}
		return nil
	}

	return fmt.Errorf("git ls-remote --heads origin %s exited %d", p.Branch, probe)
}

// CheckoutBaseArgv is the argv prefix for checkout's git steps.
func CheckoutBaseArgv(repoDir string) []string {
	return []string{
		"git",
		"-c", "safe.directory=*",
		"-c", "credential.helper=",
		"-c", "http.connectTimeout=10",
		"-c", "http.lowSpeedLimit=1",
		"-c", "http.lowSpeedTime=10",
		"-C", repoDir,
	}
}

// The protected branch list is a plain data file, not interpolated into the
// script, so an unusual (but valid) ref name can't inject shell syntax here.
const protectedBranchHook = `#!/bin/sh
protected="$(dirname "$0")/protected-branches"
while IFS=' ' read -r _local_ref _local_sha remote_ref _remote_sha; do
  branch="${remote_ref#refs/heads/}"
  if grep -qxF "$branch" "$protected" 2>/dev/null; then
    echo "error: pushing to '$branch' is not allowed from a sandbox" >&2
    exit 1
  fi
done
exit 0
`

// ProtectedBranches lists branches a sandbox must never push to directly,
// including the repo's actual default (not every repo uses main/master). Shared
// by the pre-push hook and Publish's in-code guard — the hook alone is not
// enough, since publish pushes with --no-verify.
func ProtectedBranches(repoDir string) []string {
	out := []string{"main", "master"}
	if def := ResolveRemoteDefaultBranch(repoDir); def != "" && def != "main" && def != "master" {
		out = append(out, def)
	}
	return out
}

// Same shape as the pre-push hook above: the path list is a data file, never
// interpolated into the script.
//
// This exists because the agent commits through Bash (`git add -A && git
// commit`), which no daemon-side publish filter can see. One deco site's
// `deno task dev` rewrote its tracked, compiled `static/tailwind.css` in
// minified form; an agent's `git add -A` swallowed it; and because every
// thread's synthetic branch descends from the last one, EVERY later pull
// request on that repo carried the same 30k-line reformat — and later runs
// spent turns proving it wasn't theirs before reverting it.
//
// Unstaging (rather than failing the commit) is deliberate: the artifact is
// never what the agent meant to commit, so there is nothing for it to fix, and
// a hard failure would just cost a turn. If the artifact was the ONLY staged
// change, git then reports "no changes added to commit", which is the correct
// answer to that commit.
//
// This wrapper runs a repo's OWN pre-commit hook first (saved as
// `pre-commit.local` below), if the install step that ran just before us wrote
// one — lefthook/husky format-and-lint-on-commit is exactly the kind of check
// an agent's commit inside the sandbox should still be held to, and the naive
// unconditional overwrite silently dropped it project-wide.
const buildArtifactHookMarker = "# decocms-sandbox-build-artifact-hook"

const buildArtifactHook = "#!/bin/sh\n" + buildArtifactHookMarker + `
here="$(dirname "$0")"
if [ -x "$here/pre-commit.local" ]; then
  "$here/pre-commit.local" "$@" || exit $?
fi
artifacts="$here/build-artifacts"
[ -f "$artifacts" ] || exit 0
while IFS= read -r p; do
  [ -n "$p" ] || continue
  git restore --staged -- "$p" 2>/dev/null || true
done < "$artifacts"
exit 0
`

// InstallSandboxHooks writes the local-only git hooks a sandbox checkout needs:
// pre-push branch protection and pre-commit build-artifact unstaging. Called
// again after any install step, whose scripts (lefthook, husky postinstall)
// overwrite `.git/hooks`.
func InstallSandboxHooks(repoDir string) error {
	hooksDir := filepath.Join(repoDir, ".git", "hooks")
	if err := os.MkdirAll(hooksDir, 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(hooksDir, "pre-push"), []byte(protectedBranchHook), 0o755); err != nil {
		return err
	}
	list := strings.Join(ProtectedBranches(repoDir), "\n") + "\n"
	if err := os.WriteFile(filepath.Join(hooksDir, "protected-branches"), []byte(list), 0o644); err != nil {
		return err
	}
	// An install step (lefthook, husky) may have just written its OWN
	// pre-commit hook; preserve it under a fixed name so our wrapper can still
	// run it, instead of silently replacing it every time we reinstall.
	preCommitPath := filepath.Join(hooksDir, "pre-commit")
	if existing, err := os.ReadFile(preCommitPath); err == nil &&
		!strings.Contains(string(existing), buildArtifactHookMarker) {
		if err := os.WriteFile(filepath.Join(hooksDir, "pre-commit.local"), existing, 0o755); err != nil {
			return err
		}
	}
	if err := os.WriteFile(preCommitPath, []byte(buildArtifactHook), 0o755); err != nil {
		return err
	}
	artifacts := strings.Join(BuildArtifacts, "\n") + "\n"
	return os.WriteFile(filepath.Join(hooksDir, "build-artifacts"), []byte(artifacts), 0o644)
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
