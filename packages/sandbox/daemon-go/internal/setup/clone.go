package setup

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/decocms/studio/sandbox-daemon/internal/config"
	"github.com/decocms/studio/sandbox-daemon/internal/gitx"
)

// gitBaseArgv is the argv prefix for every daemon-owned git step. argv, not a
// shell string: the clone URL and branch name are config-supplied and would be
// injectable through `sh -c`.
func gitBaseArgv() []string {
	return []string{
		"git",
		"-c", "safe.directory=*",
		"-c", "credential.helper=",
		"-c", "http.connectTimeout=10",
		"-c", "http.lowSpeedLimit=1",
		"-c", "http.lowSpeedTime=10",
	}
}

var gitStepEnv = map[string]string{"GIT_TERMINAL_PROMPT": "0", "GIT_ASKPASS": "true"}

func gitArgv(extra ...string) []string {
	return append(gitBaseArgv(), extra...)
}

// formatArgv renders argv for the `$ …` log line. Display only — quoting here
// is cosmetic, nothing re-parses it.
func formatArgv(argv []string) string {
	parts := make([]string, len(argv))
	for i, a := range argv {
		if strings.ContainsAny(a, " \t") {
			parts[i] = `"` + a + `"`
		} else {
			parts[i] = a
		}
	}
	return strings.Join(parts, " ")
}

var transientErrors = []string{
	"Could not resolve host",
	"early EOF",
	"unexpected disconnect",
	"Connection reset by peer",
	"Connection timed out",
	"Operation too slow",
	"transfer closed with",
	"RPC failed",
	"the remote end hung up",
}

const (
	cloneMaxRetries   = 3
	cloneRetryDelayMs = 3000
	lsRemoteNoMatch   = 2
)

type CloneDeps struct {
	RepoDir  string
	CloneUrl string
	Branch   string
	OnChunk  func(data string)
}

// crNormalizeRe: bare \r (git progress) → \r\n so log lines stay readable.
var crNormalizeRe = regexp.MustCompile(`\r([^\n]|$)`)

func normalizeCarriageReturns(data string) string {
	return crNormalizeRe.ReplaceAllString(data, "\r\n$1")
}

func runStep(argv []string, deps CloneDeps) int {
	deps.OnChunk("$ " + formatArgv(argv) + "\r\n")
	return SpawnStepArgv(argv, func(data string) {
		deps.OnChunk(normalizeCarriageReturns(data))
	}, gitStepEnv)
}

func isTransient(output string) bool {
	for _, e := range transientErrors {
		if strings.Contains(output, e) {
			return true
		}
	}
	return false
}

func runNetworkStep(argv []string, deps CloneDeps) int {
	return runNetworkStepCapture(argv, deps).code
}

type stepResult struct {
	code   int
	output string
}

func runNetworkStepCapture(argv []string, deps CloneDeps) stepResult {
	var output string
	for attempt := 0; attempt <= cloneMaxRetries; attempt++ {
		if attempt > 0 {
			deps.OnChunk(fmt.Sprintf("\r\n[clone] transient network error, retrying in %ds (attempt %d/%d)...\r\n",
				cloneRetryDelayMs/1000, attempt+1, cloneMaxRetries+1))
			time.Sleep(cloneRetryDelayMs * time.Millisecond)
		}
		output = ""
		tee := deps
		tee.OnChunk = func(data string) {
			output += data
			deps.OnChunk(data)
		}
		code := runStep(argv, tee)
		if code == 0 {
			return stepResult{code: 0, output: output}
		}
		if !isTransient(output) || attempt >= cloneMaxRetries {
			return stepResult{code: code, output: output}
		}
	}
	return stepResult{code: 1, output: output}
}

var lsRemoteHeadRe = regexp.MustCompile(`ref:\s+refs/heads/(\S+)\s+HEAD`)

func fetchBaseBranch(dir, cloneUrl, branchOnRemote string, deps CloneDeps) {
	res := runNetworkStepCapture(gitArgv("ls-remote", "--symref", cloneUrl, "HEAD"), deps)
	if res.code != 0 {
		deps.OnChunk("\r\n[clone] warning: could not resolve remote default branch; divergence vs base unavailable until next fetch\r\n")
		return
	}
	m := lsRemoteHeadRe.FindStringSubmatch(res.output)
	if m == nil {
		return
	}
	base := m[1]
	if base == "" || base == branchOnRemote {
		return
	}
	if !gitx.IsSafeRefName(base) {
		deps.OnChunk(fmt.Sprintf("\r\n[clone] warning: refusing unsafe base branch name %q; divergence vs base unavailable until next fetch\r\n", base))
		return
	}
	refspec := fmt.Sprintf("+refs/heads/%s:refs/remotes/origin/%s", base, base)
	if code := runNetworkStep(gitArgv("-C", dir, "fetch", "--depth", "1", "origin", refspec), deps); code != 0 {
		deps.OnChunk(fmt.Sprintf("\r\n[clone] warning: failed to fetch base branch '%s'; divergence vs base unavailable until next fetch\r\n", base))
		return
	}
	runStep(gitArgv("-C", dir, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/"+base), deps)
}

type CloneResult struct {
	Code int
	// FetchBase, when non-nil, does the off-critical-path base-branch fetch.
	FetchBase func(onChunk func(data string))
}

func isNonEmptyWithoutGit(dir string) bool {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return false
	}
	if len(entries) == 0 {
		return false
	}
	for _, e := range entries {
		if e.Name() == ".git" {
			return false
		}
	}
	return true
}

func SpawnClone(deps CloneDeps) CloneResult {
	cloneUrl := deps.CloneUrl
	if cloneUrl == "" {
		return CloneResult{Code: 1}
	}
	if deps.RepoDir == "" || !filepath.IsAbs(deps.RepoDir) {
		deps.OnChunk(fmt.Sprintf("\r\n[clone] repoDir is not an absolute path (got: %s) — aborting clone to prevent relative-path mishap\r\n", deps.RepoDir))
		return CloneResult{Code: 1}
	}

	dir := deps.RepoDir

	branch := ""
	if deps.Branch != "" && !config.IsSyntheticBranch(deps.Branch) {
		branch = deps.Branch
	}

	branchOnRemote := ""
	branchToForkLocally := ""
	if branch != "" {
		// The branch is config-supplied and flows into git argv below.
		if err := gitx.AssertValidRemoteBranchName(branch); err != nil {
			deps.OnChunk(fmt.Sprintf("\r\n[clone] refusing invalid branch name %q\r\n", branch))
			return CloneResult{Code: 1}
		}
		probe := runNetworkStep(gitArgv("ls-remote", "--exit-code", "--heads", cloneUrl, branch), deps)
		switch {
		case probe == 0:
			branchOnRemote = branch
		case probe == lsRemoteNoMatch:
			deps.OnChunk(fmt.Sprintf("[clone] branch '%s' not on remote; cloning default and forking locally\r\n", branch))
			branchToForkLocally = branch
		default:
			deps.OnChunk(fmt.Sprintf("\r\n[clone] ls-remote failed (exit %d); aborting clone\r\n", probe))
			return CloneResult{Code: probe}
		}
	}

	deferBaseFetch := func(remote string) func(onChunk func(data string)) {
		return func(onChunk func(data string)) {
			d := deps
			d.OnChunk = onChunk
			fetchBaseBranch(dir, cloneUrl, remote, d)
		}
	}

	if isNonEmptyWithoutGit(dir) {
		for _, step := range [][]string{
			gitArgv("-C", dir, "init"),
			gitArgv("-C", dir, "remote", "add", "origin", cloneUrl),
		} {
			if code := runStep(step, deps); code != 0 {
				return CloneResult{Code: code}
			}
		}
		fetchRef := "HEAD"
		if branchOnRemote != "" {
			fetchRef = fmt.Sprintf("+refs/heads/%s:refs/remotes/origin/%s", branchOnRemote, branchOnRemote)
		}
		if code := runNetworkStep(gitArgv("-C", dir, "fetch", "--depth", "1", "origin", fetchRef), deps); code != 0 {
			return CloneResult{Code: code}
		}
		checkoutCmd := gitArgv("-C", dir, "checkout", "-f", "FETCH_HEAD")
		if branchOnRemote != "" {
			checkoutCmd = gitArgv("-C", dir, "checkout", "-f", "-B", branchOnRemote, "refs/remotes/origin/"+branchOnRemote)
		}
		if code := runStep(checkoutCmd, deps); code != 0 {
			return CloneResult{Code: code}
		}
		if branchToForkLocally != "" {
			return CloneResult{Code: runStep(gitArgv("-C", dir, "checkout", "-B", branchToForkLocally), deps)}
		}
		res := CloneResult{Code: 0}
		if branchOnRemote != "" {
			res.FetchBase = deferBaseFetch(branchOnRemote)
		}
		return res
	}

	cloneCmd := gitArgv("clone", "--depth", "1", cloneUrl, dir)
	if branchOnRemote != "" {
		cloneCmd = gitArgv("clone", "--depth", "1", "--branch", branchOnRemote, cloneUrl, dir)
	}
	if code := runNetworkStep(cloneCmd, deps); code != 0 {
		return CloneResult{Code: code}
	}
	if branchToForkLocally != "" {
		return CloneResult{Code: runStep(gitArgv("-C", dir, "checkout", "-B", branchToForkLocally), deps)}
	}
	res := CloneResult{Code: 0}
	if branchOnRemote != "" {
		res.FetchBase = deferBaseFetch(branchOnRemote)
	}
	return res
}
