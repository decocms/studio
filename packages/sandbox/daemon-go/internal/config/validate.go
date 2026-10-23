package config

import (
	"fmt"
	"path/filepath"
	"regexp"
	"strings"
)

var validRuntimes = map[string]bool{"node": true, "bun": true, "deno": true}
var validPms = map[string]bool{"npm": true, "pnpm": true, "yarn": true, "bun": true, "deno": true}

var branchRe = regexp.MustCompile(`^[A-Za-z0-9._/-]+$`)

// repoNameRe bounds a secondary checkout's directory name: no slash, and it
// must open on an alphanumeric. That rules out `.`, `..` and `.git`, so the
// name can neither climb out of the secondary root nor land on a git dir.
var repoNameRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]*$`)

// orgIdRe bounds OrgId the same way repoNameRe bounds a secondary checkout
// name: it becomes a directory component of the shared golden-cache path
// (setup.RemoteGoldenArchivePath), so a value containing `/` or `..` would
// walk that path outside the `golden/` prefix the store is scoped to.
var orgIdRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]*$`)

var envKeyRe = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

const envValueMax = 32 * 1024

var invalidCoAuthorChars = regexp.MustCompile(`[\r\n<>]`)
var emailRe = regexp.MustCompile(`^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$`)

func IsSyntheticBranch(branch string) bool {
	return branch == "ephemeral" || strings.HasPrefix(branch, "thread:")
}

// Validate checks a fully-merged TenantConfig. Returns "" when valid, a
// reason otherwise.
func Validate(c *TenantConfig) string {
	if c.Git != nil {
		if reason := validateGit(c.Git); reason != "" {
			return reason
		}
	}
	if c.Application != nil {
		if reason := validateApplication(c.Application); reason != "" {
			return reason
		}
	}
	if c.Env != nil {
		if reason := validateEnv(c.Env); reason != "" {
			return reason
		}
	}
	if c.Operator != nil {
		if reason := validateOperator(c.Operator); reason != "" {
			return reason
		}
	}
	if c.OrgId != "" && !orgIdRe.MatchString(c.OrgId) {
		return fmt.Sprintf("orgId invalid: %s", c.OrgId)
	}
	return ""
}

func validateEnv(env map[string]string) string {
	for k, v := range env {
		if !envKeyRe.MatchString(k) {
			return fmt.Sprintf("env key invalid: %s", k)
		}
		if strings.ContainsRune(v, 0) {
			return fmt.Sprintf("env value for %s contains NUL", k)
		}
		if len(v) > envValueMax {
			return fmt.Sprintf("env value for %s exceeds %d bytes", k, envValueMax)
		}
	}
	return ""
}

func validateGit(git *GitConfig) string {
	if git.Repository == nil || git.Repository.CloneUrl == nil {
		return "git.repository.cloneUrl is required"
	}
	if *git.Repository.CloneUrl == "" {
		return "git.repository.cloneUrl is empty"
	}
	if git.Repository.Branch != nil {
		b := *git.Repository.Branch
		if !IsSyntheticBranch(b) && (!branchRe.MatchString(b) || strings.HasPrefix(b, "-")) {
			return fmt.Sprintf("git.repository.branch invalid: %s", b)
		}
	}
	seenRepoNames := make(map[string]bool, len(git.Repositories))
	for i, repo := range git.Repositories {
		if repo.CloneUrl == nil || *repo.CloneUrl == "" {
			return fmt.Sprintf("git.repositories[%d].cloneUrl is required", i)
		}
		// The name becomes a directory, so it is a path input from off-pod.
		if repo.RepoName == nil || !repoNameRe.MatchString(*repo.RepoName) {
			return fmt.Sprintf("git.repositories[%d].repoName invalid", i)
		}
		// Two entries sharing a name resolve to the same checkout directory
		// (paths.SecondaryRepoDir), so cloneSecondaryRepos would race two `git
		// clone`s into it concurrently.
		if seenRepoNames[*repo.RepoName] {
			return fmt.Sprintf("git.repositories[%d].repoName duplicates another entry: %s", i, *repo.RepoName)
		}
		seenRepoNames[*repo.RepoName] = true
		if repo.Branch != nil {
			b := *repo.Branch
			if !IsSyntheticBranch(b) && (!branchRe.MatchString(b) || strings.HasPrefix(b, "-")) {
				return fmt.Sprintf("git.repositories[%d].branch invalid: %s", i, b)
			}
		}
	}
	if git.Identity != nil {
		if git.Identity.UserName == nil || *git.Identity.UserName == "" {
			return "git.identity.userName is required"
		}
		// Written verbatim into `git config user.name` (ConfigureGitIdentity)
		// and from there into every commit's author metadata, so a value
		// carrying a newline or angle bracket can smuggle a second config
		// line or spoof the author field downstream commit parsers rely on.
		if invalidCoAuthorChars.MatchString(*git.Identity.UserName) {
			return "git.identity.userName is invalid"
		}
		if git.Identity.UserEmail == nil || *git.Identity.UserEmail == "" {
			return "git.identity.userEmail is required"
		}
		if invalidCoAuthorChars.MatchString(*git.Identity.UserEmail) || !emailRe.MatchString(*git.Identity.UserEmail) {
			return "git.identity.userEmail is invalid"
		}
	}
	return ""
}

func validateApplication(app *Application) string {
	if app.Runtime != nil && !validRuntimes[*app.Runtime] {
		return fmt.Sprintf("runtime invalid: %s", *app.Runtime)
	}
	if app.PackageManager != nil {
		if app.PackageManager.Name != nil && !validPms[*app.PackageManager.Name] {
			return fmt.Sprintf("packageManager invalid: %s", *app.PackageManager.Name)
		}
		if app.PackageManager.Path != nil {
			if reason := validatePmPath(*app.PackageManager.Path); reason != "" {
				return reason
			}
		}
	}
	if app.Port != nil {
		p := *app.Port
		if p != float64(int(p)) || p <= 0 || p > 65535 {
			return fmt.Sprintf("port invalid: %v", p)
		}
	}
	return ""
}

// validatePmPath rejects a packageManager.path that would let
// paths.ResolvePmRoot (internal/paths/paths.go) run install/dev commands
// outside the repo checkout: an absolute path is used verbatim, and a
// relative path is joined onto the repo dir without a containment check, so
// "../.." segments walk out of it.
func validatePmPath(p string) string {
	if p == "" {
		return "packageManager.path must be non-empty"
	}
	clean := filepath.Clean(p)
	if filepath.IsAbs(clean) || clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return fmt.Sprintf("packageManager.path must be a relative path within the repo: %s", p)
	}
	return ""
}

func validateOperator(op *Operator) string {
	if op.UserName == nil {
		return "operator.userName is required"
	}
	name := strings.TrimSpace(*op.UserName)
	if name == "" || invalidCoAuthorChars.MatchString(name) {
		return "operator.userName is required"
	}
	if op.UserEmail != nil {
		email := strings.TrimSpace(*op.UserEmail)
		if email != "" {
			normalizedHasEmail := !invalidCoAuthorChars.MatchString(email) && emailRe.MatchString(email)
			if !normalizedHasEmail {
				return "operator.userEmail is invalid"
			}
		}
	}
	return ""
}
