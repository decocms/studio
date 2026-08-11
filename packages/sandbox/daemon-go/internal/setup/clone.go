package setup

import (
	"fmt"
	"net/url"
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
	// SubmoduleCredentials are per-host PATs for private submodules. Opt-in:
	// empty means submodules are left alone. ⚠️ SECURITY: credentials — see
	// runSubmoduleUpdate for the channel they travel on.
	SubmoduleCredentials []config.SubmoduleCredential
	OnChunk              func(data string)
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

// submoduleHostRe mirrors SUBMODULE_HOST_RE in
// packages/shared/src/sdk/types/virtual-mcp.ts (the source of truth, also
// enforced by the tool schema). A submodule host flows into a
// `git -c url.<…>.insteadOf` argv and into a git-credentials file line
// (`https://x-access-token:<token>@<host>`). Argv/file form makes shell
// injection impossible, but a host with a slash, `@`, whitespace, or control
// chars would corrupt the insteadOf prefix or the credential URL — so allow only
// a bare hostname with an optional port.
var submoduleHostRe = regexp.MustCompile(`^[a-zA-Z0-9.-]+(?::[0-9]+)?$`)

// prepareSubmoduleCredentials validates and dedupes credentials by host (last
// write wins), returning the git-credential-store file lines for the valid hosts
// plus the rejected hosts. Deterministic: no fs/network.
//
// ⚠️ SECURITY: `lines` contain tokens. Never log them.
func prepareSubmoduleCredentials(credentials []config.SubmoduleCredential) (lines, hosts, invalidHosts []string) {
	tokenByHost := map[string]string{}
	for _, c := range credentials {
		if !submoduleHostRe.MatchString(c.Host) {
			invalidHosts = append(invalidHosts, c.Host)
			continue
		}
		// First sighting fixes the order; a repeat overwrites the token in place,
		// so "last token wins" without disturbing host ordering.
		if _, seen := tokenByHost[c.Host]; !seen {
			hosts = append(hosts, c.Host)
		}
		tokenByHost[c.Host] = c.Token
	}
	for _, host := range hosts {
		// Built through url.URL so the token is percent-encoded as userinfo:
		// git-credential-store parses each line as a URL, and a PAT containing
		// `@`, `:`, or `/` would otherwise split the line at the wrong byte.
		// (Not QueryEscape — that renders a space as `+`, which git would read
		// literally.)
		u := url.URL{
			Scheme: "https",
			User:   url.UserPassword("x-access-token", tokenByHost[host]),
			Host:   host,
		}
		lines = append(lines, u.String())
	}
	return lines, hosts, invalidHosts
}

// submoduleUpdateArgs is the exact `git` extra-args for a submodule update:
// per-host SSH→HTTPS `insteadOf` rewrites (no token) followed by the store-helper
// pointer and the shallow recursive `submodule update`. Combined with
// gitBaseArgv()'s leading `-c credential.helper=` (which resets the helper list),
// the store helper is the only one in effect for this command and its submodule
// subprocesses (they inherit `-c` via GIT_CONFIG_PARAMETERS).
func submoduleUpdateArgs(hosts []string, credFile string) []string {
	args := []string{}
	for _, host := range hosts {
		args = append(args,
			"-c", "url.https://"+host+"/.insteadOf=git@"+host+":",
			"-c", "url.https://"+host+"/.insteadOf=ssh://git@"+host+"/",
		)
	}
	return append(args,
		"-c", "credential.helper=store --file="+credFile,
		"submodule", "update", "--init", "--recursive", "--depth", "1",
	)
}

// runSubmoduleUpdate fetches git submodules after the working tree is
// materialized, authenticating private submodules with user-supplied per-host
// PATs. Best-effort: a failure warns and leaves the (bare) working tree intact
// rather than failing the whole clone, mirroring fetchBaseBranch.
//
// Credentials are delivered on a git-only channel — never the env bag the dev
// server sees. The token lives only in a short-lived credentials file (mode 0600,
// outside the repo) read by `git-credential-store` for the submodule fetch, then
// deleted. `insteadOf` rewrites (which carry NO token) turn `git@<host>:` /
// `ssh://git@<host>/` submodule URLs into HTTPS so the store credential applies;
// the token is never placed in argv and never persisted into the repo's
// `.git/config`.
//
// No-op when no credentials are configured (the feature is opt-in) or the repo
// declares no submodules.
//
// `run` is injected so the argv/best-effort contract is testable without git.
func runSubmoduleUpdate(dir string, credentials []config.SubmoduleCredential, onChunk func(string), run func(argv []string) int) {
	if len(credentials) == 0 {
		return
	}
	if _, err := os.Stat(filepath.Join(dir, ".gitmodules")); err != nil {
		return
	}

	lines, hosts, invalidHosts := prepareSubmoduleCredentials(credentials)
	for _, host := range invalidHosts {
		onChunk(fmt.Sprintf("\r\n[clone] warning: skipping submodule credential with invalid host %q\r\n", host))
	}
	if len(hosts) == 0 {
		return
	}

	// Best-effort, end to end: the credentials-file write (EACCES/ENOSPC) can
	// fail, and this runs on the clone's critical path — a hard failure here
	// would fail the whole clone for an opt-in, non-essential step. Degrade to a
	// warning; the working tree (sans submodules) stays intact. The remove always
	// runs so the token file never lingers, even if the write half-completed.
	f, err := os.CreateTemp("", "submodule-git-credentials")
	if err != nil {
		onChunk(fmt.Sprintf("\r\n[clone] warning: submodule credentials file errored (%s); continuing without submodules\r\n", err.Error()))
		return
	}
	credFile := f.Name()
	defer os.Remove(credFile)
	// CreateTemp already opens 0600; Chmod defends against a umask surprise on a
	// co-tenant node — the file holds a long-lived PAT.
	writeErr := f.Chmod(0o600)
	if writeErr == nil {
		_, writeErr = f.WriteString(strings.Join(lines, "\n") + "\n")
	}
	if closeErr := f.Close(); writeErr == nil {
		writeErr = closeErr
	}
	if writeErr != nil {
		onChunk(fmt.Sprintf("\r\n[clone] warning: submodule credentials file errored (%s); continuing without submodules\r\n", writeErr.Error()))
		return
	}

	argv := append(gitArgv("-C", dir), submoduleUpdateArgs(hosts, credFile)...)
	if code := run(argv); code != 0 {
		onChunk(fmt.Sprintf("\r\n[clone] warning: submodule update failed (exit %d); continuing without submodules\r\n", code))
	}
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

	// Funnels every success return through the (best-effort, opt-in) submodule
	// fetch so both acquisition paths and both branch cases get submodules.
	finalize := func(res CloneResult) CloneResult {
		if res.Code == 0 {
			runSubmoduleUpdate(dir, deps.SubmoduleCredentials, deps.OnChunk, func(argv []string) int {
				return runNetworkStep(argv, deps)
			})
		}
		return res
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
			return finalize(CloneResult{Code: runStep(gitArgv("-C", dir, "checkout", "-B", branchToForkLocally), deps)})
		}
		res := CloneResult{Code: 0}
		if branchOnRemote != "" {
			res.FetchBase = deferBaseFetch(branchOnRemote)
		}
		return finalize(res)
	}

	cloneCmd := gitArgv("clone", "--depth", "1", cloneUrl, dir)
	if branchOnRemote != "" {
		cloneCmd = gitArgv("clone", "--depth", "1", "--branch", branchOnRemote, cloneUrl, dir)
	}
	if code := runNetworkStep(cloneCmd, deps); code != 0 {
		return CloneResult{Code: code}
	}
	if branchToForkLocally != "" {
		return finalize(CloneResult{Code: runStep(gitArgv("-C", dir, "checkout", "-B", branchToForkLocally), deps)})
	}
	res := CloneResult{Code: 0}
	if branchOnRemote != "" {
		res.FetchBase = deferBaseFetch(branchOnRemote)
	}
	return finalize(res)
}
