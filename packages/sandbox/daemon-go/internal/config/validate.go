package config

import (
	"fmt"
	"regexp"
	"strings"
)

var validRuntimes = map[string]bool{"node": true, "bun": true, "deno": true}
var validPms = map[string]bool{"npm": true, "pnpm": true, "yarn": true, "bun": true, "deno": true}

var branchRe = regexp.MustCompile(`^[A-Za-z0-9._/-]+$`)
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
	if git.Identity != nil {
		if git.Identity.UserName == nil || *git.Identity.UserName == "" {
			return "git.identity.userName is required"
		}
		if git.Identity.UserEmail == nil || *git.Identity.UserEmail == "" {
			return "git.identity.userEmail is required"
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
		if app.PackageManager.Path != nil && *app.PackageManager.Path == "" {
			return "packageManager.path must be non-empty"
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
