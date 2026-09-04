package config

import (
	"fmt"
	"net/url"
	"path/filepath"
	"sort"
	"strings"
)

const (
	KindBootstrap            = "bootstrap"
	KindBranchChange         = "branch-change"
	KindReposChange          = "repos-change"
	KindPmChange             = "pm-change"
	KindRuntimeChange        = "runtime-change"
	KindPortChange           = "port-change"
	KindEnvChange            = "env-change"
	KindGitCredentialRefresh = "git-credential-refresh"
	KindIdentityConflict     = "identity-conflict"
	KindNoOp                 = "no-op"
)

type EnvDiff struct {
	Set     []string `json:"set"`
	Deleted []string `json:"deleted"`
}

type Transition struct {
	Kind string
	// Config carries the bootstrap payload.
	Config *TenantConfig
	// BranchFrom/BranchTo for branch-change.
	BranchFrom string
	BranchTo   string
	// EnvChanged for env-change.
	EnvChanged *EnvDiff
	// CloneUrl for git-credential-refresh.
	CloneUrl string
	// Field for identity-conflict.
	Field string
}

// Classify derives the single highest-impact transition between two configs.
// Precedence: identity-conflict > bootstrap > branch-change > repos-change >
// runtime-change > pm-change > port-change > env-change >
// git-credential-refresh > no-op.
func Classify(before, after *TenantConfig) Transition {
	beforeHasUrl := before.HasCloneUrl()
	afterHasUrl := after.HasCloneUrl()
	beforeUrl := before.CloneUrl()
	afterUrl := after.CloneUrl()
	if beforeHasUrl && afterHasUrl && StripCredentials(beforeUrl) != StripCredentials(afterUrl) {
		return Transition{Kind: KindIdentityConflict, Field: "cloneUrl"}
	}

	isMeaningful := afterHasUrl || (after != nil && after.Application != nil)
	if before == nil && isMeaningful {
		return Transition{Kind: KindBootstrap, Config: after}
	}
	if before == nil {
		if diff := diffEnv(nil, after.Env); diff != nil {
			return Transition{Kind: KindEnvChange, EnvChanged: diff}
		}
		return Transition{Kind: KindNoOp}
	}

	if after.HasBranch() {
		beforeBranch := before.Branch()
		afterBranch := after.Branch()
		if !before.HasBranch() || beforeBranch != afterBranch {
			return Transition{Kind: KindBranchChange, BranchFrom: beforeBranch, BranchTo: afterBranch}
		}
	}

	if secondaryRepoKeys(before) != secondaryRepoKeys(after) {
		return Transition{Kind: KindReposChange}
	}

	if after != nil && after.Application != nil && after.Application.Runtime != nil {
		if before.Runtime() != after.Runtime() {
			return Transition{Kind: KindRuntimeChange}
		}
	}

	if after != nil && after.Application != nil && after.Application.PackageManager != nil {
		if before.PmName() != after.PmName() || before.PmPath() != after.PmPath() {
			return Transition{Kind: KindPmChange}
		}
	}

	beforePort, beforeHasPort := before.Port()
	afterPort, afterHasPort := after.Port()
	if beforeHasPort != afterHasPort || beforePort != afterPort {
		return Transition{Kind: KindPortChange}
	}

	if diff := diffEnv(before.Env, after.Env); diff != nil {
		return Transition{Kind: KindEnvChange, EnvChanged: diff}
	}

	if beforeHasUrl && afterHasUrl && beforeUrl != afterUrl &&
		StripCredentials(beforeUrl) == StripCredentials(afterUrl) {
		return Transition{Kind: KindGitCredentialRefresh, CloneUrl: afterUrl}
	}

	return Transition{Kind: KindNoOp}
}

// secondaryRepoKeys is the set of secondary checkouts a config asks for, as one
// comparable string.
//
// Credentials are stripped and the names sorted, so a token refresh or a
// reordered list is not a change — only a repository entering or leaving is. A
// change here needs no step (nothing about a sibling checkout touches the
// primary's install or dev server), but it MUST reach subscribers: a no-op
// classification is not delivered at all, and the sweep that clones the new
// checkout hangs off that delivery.
func secondaryRepoKeys(c *TenantConfig) string {
	if c == nil {
		return ""
	}
	repos := c.AdditionalRepositories()
	keys := make([]string, 0, len(repos))
	for _, repo := range repos {
		name := ""
		if repo.RepoName != nil {
			name = *repo.RepoName
		}
		cloneUrl := ""
		if repo.CloneUrl != nil {
			cloneUrl = StripCredentials(*repo.CloneUrl)
		}
		keys = append(keys, name+"\x00"+cloneUrl)
	}
	sort.Strings(keys)
	return strings.Join(keys, "\x01")
}

func diffEnv(before, after map[string]string) *EnvDiff {
	set := []string{}
	for k, v := range after {
		if bv, ok := before[k]; !ok || bv != v {
			set = append(set, k)
		}
	}
	deleted := []string{}
	for k := range before {
		if _, ok := after[k]; !ok {
			deleted = append(deleted, k)
		}
	}
	if len(set) == 0 && len(deleted) == 0 {
		return nil
	}
	sort.Strings(set)
	sort.Strings(deleted)
	return &EnvDiff{Set: set, Deleted: deleted}
}

// GlabConfigFromCloneUrl builds the `glab` config file for the credential baked
// into a GitLab clone URL, or "" for any other URL.
//
// `is_oauth2: true` makes glab authenticate with `Authorization: Bearer`, which
// is the only form gitlab.com accepts for an OAuth access token and is also
// accepted for a personal/project access token — so one shape serves both and
// the daemon does not need to know which kind of token Studio minted.
//
// ⚠️ SECURITY: the result embeds a credential. Never log it, and write it 0600.
func GlabConfigFromCloneUrl(rawUrl string) string {
	u, err := url.Parse(rawUrl)
	if err != nil || u.User == nil || u.User.Username() != "oauth2" {
		return ""
	}
	token, ok := u.User.Password()
	if !ok || token == "" || u.Host == "" {
		return ""
	}
	host := strings.ToLower(u.Host)
	// Indented with two spaces per level, as glab writes it. The token is a
	// plain scalar: git URLs cannot carry a character that needs quoting here
	// (userinfo is percent-encoded), and the host is a bare hostname[:port].
	return fmt.Sprintf(
		"hosts:\n  %s:\n    token: %s\n    api_host: %s\n    api_protocol: https\n    is_oauth2: true\n",
		host, token, host,
	)
}

// GlabConfigPath is where glab looks for the config above, under a given HOME.
func GlabConfigPath(home string) string {
	return filepath.Join(home, ".config", "glab-cli", "config.yml")
}

func StripCredentials(rawUrl string) string {
	u, err := url.Parse(rawUrl)
	if err != nil {
		return rawUrl
	}
	u.User = nil
	return u.String()
}

// TokenFromCloneUrl returns the git token baked into a clone URL, empty when it
// carries none. Studio embeds it as the password of a
// `https://x-access-token:<token>@host/...` URL, and `git clone` stores that on
// `origin` — so this is the same credential the working tree already pushes
// with, read back rather than passed a second time. Empty for an SSH or
// anonymous URL.
//
// ⚠️ SECURITY: the result is a credential. Never log it.
func TokenFromCloneUrl(rawUrl string) string {
	u, err := url.Parse(rawUrl)
	if err != nil || u.User == nil {
		return ""
	}
	token, _ := u.User.Password()
	return token
}

// CliEnvFromCloneUrl returns the environment a provider CLI needs to act with
// the credential baked into a clone URL, keyed off the userinfo username Studio
// chose for the provider: `x-access-token` is GitHub (`gh` reads GH_TOKEN, plus
// GH_HOST off github.com), `oauth2` is GitLab (`glab` reads GITLAB_TOKEN and
// GITLAB_HOST). Empty for an SSH, anonymous or unrecognised URL.
//
// The GitLab entries are NOT sufficient on their own: glab sends an env token
// as `PRIVATE-TOKEN`, which GitLab rejects for an OAuth access token (verified
// against gitlab.com — every env form, including OAUTH_TOKEN and
// GITLAB_ACCESS_TOKEN, answers 401). `GlabConfigFromCloneUrl` is what actually
// authenticates it; these stay because they are what a personal or project
// access token needs, and because `GITLAB_HOST` is read for the default host.
//
// ⚠️ SECURITY: the values are credentials. Never log them.
func CliEnvFromCloneUrl(rawUrl string) map[string]string {
	u, err := url.Parse(rawUrl)
	if err != nil || u.User == nil {
		return nil
	}
	token, ok := u.User.Password()
	if !ok || token == "" {
		return nil
	}
	host := strings.ToLower(u.Host)
	switch u.User.Username() {
	case "x-access-token":
		env := map[string]string{"GH_TOKEN": token}
		if host != "" && host != "github.com" {
			env["GH_HOST"] = host
		}
		return env
	case "oauth2":
		env := map[string]string{"GITLAB_TOKEN": token}
		if host != "" {
			env["GITLAB_HOST"] = "https://" + host
		}
		return env
	}
	return nil
}
