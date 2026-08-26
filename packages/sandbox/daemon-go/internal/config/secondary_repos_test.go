package config

import "testing"

func strp(s string) *string { return &s }

func TestAdditionalRepositoriesSkipsEntriesWithNoCloneUrl(t *testing.T) {
	cfg := &TenantConfig{Git: &GitConfig{Repositories: []GitRepository{
		{CloneUrl: strp("https://example.test/a.git"), RepoName: strp("a")},
		{RepoName: strp("no-url")},
		{CloneUrl: strp(""), RepoName: strp("empty-url")},
		{CloneUrl: strp("https://example.test/b.git"), RepoName: strp("b")},
	}}}

	got := cfg.AdditionalRepositories()
	if len(got) != 2 {
		t.Fatalf("want 2 usable repos, got %d", len(got))
	}
	if *got[0].RepoName != "a" || *got[1].RepoName != "b" {
		t.Fatalf("want a,b in order; got %s,%s", *got[0].RepoName, *got[1].RepoName)
	}
}

func TestAdditionalRepositoriesOnAbsentConfig(t *testing.T) {
	var nilCfg *TenantConfig
	if got := nilCfg.AdditionalRepositories(); got != nil {
		t.Fatalf("want nil for a nil config, got %v", got)
	}
	if got := (&TenantConfig{}).AdditionalRepositories(); got != nil {
		t.Fatalf("want nil when git is unset, got %v", got)
	}
}

// The set is the unit a caller means, so a patch carrying the key replaces it
// whole; one that omits it leaves the current set alone.
func TestMergeGitReplacesRepositoriesWholeOrKeepsThem(t *testing.T) {
	current := &GitConfig{
		Repository:   &GitRepository{CloneUrl: strp("https://example.test/primary.git")},
		Repositories: []GitRepository{{CloneUrl: strp("https://example.test/a.git"), RepoName: strp("a")}},
	}

	kept := mergeGit(current, &GitConfig{Identity: &GitIdentity{
		UserName: strp("n"), UserEmail: strp("e@x"),
	}})
	if len(kept.Repositories) != 1 || *kept.Repositories[0].RepoName != "a" {
		t.Fatalf("a patch without the key must keep the current set, got %v", kept.Repositories)
	}

	replaced := mergeGit(current, &GitConfig{Repositories: []GitRepository{
		{CloneUrl: strp("https://example.test/b.git"), RepoName: strp("b")},
	}})
	if len(replaced.Repositories) != 1 || *replaced.Repositories[0].RepoName != "b" {
		t.Fatalf("a patch carrying the key must replace the set, got %v", replaced.Repositories)
	}

	cleared := mergeGit(current, &GitConfig{Repositories: []GitRepository{}})
	if len(cleared.Repositories) != 0 {
		t.Fatalf("an explicit empty list must drop every secondary, got %v", cleared.Repositories)
	}
}

func TestValidateGitRejectsUnusableSecondaries(t *testing.T) {
	primary := &GitRepository{CloneUrl: strp("https://example.test/primary.git")}
	cases := []struct {
		name string
		repo GitRepository
	}{
		{"no clone url", GitRepository{RepoName: strp("a")}},
		{"no name", GitRepository{CloneUrl: strp("https://example.test/a.git")}},
		{"parent traversal", GitRepository{CloneUrl: strp("u"), RepoName: strp("..")}},
		{"git dir", GitRepository{CloneUrl: strp("u"), RepoName: strp(".git")}},
		{"path separator", GitRepository{CloneUrl: strp("u"), RepoName: strp("a/b")}},
		{"bad branch", GitRepository{
			CloneUrl: strp("u"), RepoName: strp("a"), Branch: strp("-flag"),
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			msg := validateGit(&GitConfig{
				Repository:   primary,
				Repositories: []GitRepository{tc.repo},
			})
			if msg == "" {
				t.Fatalf("want a validation error for %s", tc.name)
			}
		})
	}
}

func TestValidateGitAcceptsUsableSecondaries(t *testing.T) {
	msg := validateGit(&GitConfig{
		Repository: &GitRepository{CloneUrl: strp("https://example.test/primary.git")},
		Repositories: []GitRepository{
			{CloneUrl: strp("https://example.test/a.git"), RepoName: strp("storefront-us")},
			{CloneUrl: strp("https://example.test/b.git"), RepoName: strp("checkout.v2"), Branch: strp("main")},
		},
	})
	if msg != "" {
		t.Fatalf("want no error, got %q", msg)
	}
}
