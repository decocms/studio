package config

import (
	"net/url"
	"sort"
)

const (
	KindBootstrap            = "bootstrap"
	KindBranchChange         = "branch-change"
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
// Precedence: identity-conflict > bootstrap > branch-change > runtime-change >
// pm-change > port-change > env-change > git-credential-refresh > no-op.
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
