package config

import "testing"

func TestValidatePmPathRejectsEscapeFromRepoRoot(t *testing.T) {
	cases := []struct {
		name    string
		path    string
		wantErr bool
	}{
		{"relative within repo", "apps/web", false},
		{"dot-relative within repo", "./apps/web", false},
		{"absolute path", "/etc", true},
		{"parent traversal", "../etc", true},
		{"nested parent traversal", "apps/../../etc", true},
		{"bare parent", "..", true},
		{"empty", "", true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := validatePmPath(c.path)
			if c.wantErr && got == "" {
				t.Fatalf("validatePmPath(%q) = %q, want a rejection reason", c.path, got)
			}
			if !c.wantErr && got != "" {
				t.Fatalf("validatePmPath(%q) = %q, want no error", c.path, got)
			}
		})
	}
}

func TestValidateApplicationRejectsEscapingPmPath(t *testing.T) {
	app := &Application{
		PackageManager: &PackageManagerConfig{Path: Str("../../etc")},
	}
	if reason := validateApplication(app); reason == "" {
		t.Fatal("validateApplication accepted a packageManager.path that escapes the repo root")
	}
}

func TestValidateGitRejectsDuplicateRepoNames(t *testing.T) {
	git := &GitConfig{
		Repository: &GitRepository{CloneUrl: Str("https://example.test/primary.git")},
		Repositories: []GitRepository{
			{CloneUrl: Str("https://example.test/a.git"), RepoName: Str("checkout")},
			{CloneUrl: Str("https://example.test/b.git"), RepoName: Str("checkout")},
		},
	}
	if reason := validateGit(git); reason == "" {
		t.Fatal("validateGit accepted two secondary repos that clone into the same directory")
	}
}
