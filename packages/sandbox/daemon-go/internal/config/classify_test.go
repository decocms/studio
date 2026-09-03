package config

import (
	"encoding/json"
	"reflect"
	"testing"
)

func repo(cloneUrl, branch string) *TenantConfig {
	r := &GitRepository{CloneUrl: Str(cloneUrl)}
	if branch != "" {
		r.Branch = Str(branch)
	}
	return &TenantConfig{Git: &GitConfig{Repository: r}}
}

func withPm(c *TenantConfig, name, path string) *TenantConfig {
	pm := &PackageManagerConfig{Name: Str(name)}
	if path != "" {
		pm.Path = Str(path)
	}
	out := *c
	if out.Application == nil {
		out.Application = &Application{}
	} else {
		app := *out.Application
		out.Application = &app
	}
	out.Application.PackageManager = pm
	return &out
}

func withPort(c *TenantConfig, port float64) *TenantConfig {
	out := *c
	if out.Application == nil {
		out.Application = &Application{}
	} else {
		app := *out.Application
		out.Application = &app
	}
	out.Application.Port = &port
	return &out
}

func withEnv(c *TenantConfig, env map[string]string) *TenantConfig {
	out := *c
	out.Env = env
	return &out
}

func TestClassify(t *testing.T) {
	tests := []struct {
		name   string
		before *TenantConfig
		after  *TenantConfig
		want   string
	}{
		{
			name: "null → empty = no-op", before: nil, after: &TenantConfig{},
			want: KindNoOp,
		},
		{
			name:  "null → meaningful (cloneUrl) = bootstrap",
			after: repo("https://example.com/a.git", ""),
			want:  KindBootstrap,
		},
		{
			name:  "null → meaningful (application only) = bootstrap",
			after: &TenantConfig{Application: &Application{Runtime: Str("node")}},
			want:  KindBootstrap,
		},
		{
			name:   "cloneUrl mismatch = identity-conflict",
			before: repo("https://example.com/a.git", ""),
			after:  repo("https://example.com/b.git", ""),
			want:   KindIdentityConflict,
		},
		{
			name:   "credential-only cloneUrl change = git-credential-refresh",
			before: repo("https://x-access-token:tok1@github.com/org/repo.git", ""),
			after:  repo("https://x-access-token:tok2@github.com/org/repo.git", ""),
			want:   KindGitCredentialRefresh,
		},
		{
			name:   "branch change = branch-change",
			before: repo("https://example.com/a.git", "main"),
			after:  repo("https://example.com/a.git", "feature"),
			want:   KindBranchChange,
		},
		{
			name:   "runtime change = runtime-change",
			before: &TenantConfig{Application: &Application{Runtime: Str("node")}},
			after:  &TenantConfig{Application: &Application{Runtime: Str("bun")}},
			want:   KindRuntimeChange,
		},
		{
			name:   "pm name change = pm-change",
			before: withPm(&TenantConfig{}, "npm", ""),
			after:  withPm(&TenantConfig{}, "pnpm", ""),
			want:   KindPmChange,
		},
		{
			name:   "pm path change = pm-change",
			before: withPm(&TenantConfig{}, "npm", ""),
			after:  withPm(&TenantConfig{}, "npm", "mcp"),
			want:   KindPmChange,
		},
		{
			name:   "port change = port-change",
			before: withPort(&TenantConfig{}, 3000),
			after:  withPort(&TenantConfig{}, 4000),
			want:   KindPortChange,
		},
		{
			name:   "identical configs = no-op",
			before: withPm(repo("https://example.com/a.git", "main"), "npm", ""),
			after:  withPm(repo("https://example.com/a.git", "main"), "npm", ""),
			want:   KindNoOp,
		},
		{
			name:   "branch + pm change emits branch-change (higher impact)",
			before: withPm(repo("https://example.com/a.git", "main"), "npm", ""),
			after:  withPm(repo("https://example.com/a.git", "feature"), "pnpm", ""),
			want:   KindBranchChange,
		},
		{
			name:   "env added = env-change",
			before: &TenantConfig{Application: &Application{Runtime: Str("node")}},
			after:  withEnv(&TenantConfig{Application: &Application{Runtime: Str("node")}}, map[string]string{"FOO": "bar"}),
			want:   KindEnvChange,
		},
		{
			name:   "port change beats env change",
			before: withPort(&TenantConfig{}, 3000),
			after:  withEnv(withPort(&TenantConfig{}, 4000), map[string]string{"FOO": "bar"}),
			want:   KindPortChange,
		},
		{
			name:   "runtime change beats pm change",
			before: withPm(&TenantConfig{Application: &Application{Runtime: Str("node")}}, "npm", ""),
			after:  withPm(&TenantConfig{Application: &Application{Runtime: Str("bun")}}, "pnpm", ""),
			want:   KindRuntimeChange,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := Classify(tt.before, tt.after)
			if got.Kind != tt.want {
				t.Fatalf("Classify() = %q, want %q", got.Kind, tt.want)
			}
		})
	}
}

func TestClassifyEnvDiffKeys(t *testing.T) {
	before := withEnv(&TenantConfig{}, map[string]string{"A": "1", "B": "2"})
	after := withEnv(&TenantConfig{}, map[string]string{"A": "changed", "C": "3"})
	got := Classify(before, after)
	if got.Kind != KindEnvChange {
		t.Fatalf("kind = %q", got.Kind)
	}
	if !reflect.DeepEqual(got.EnvChanged.Set, []string{"A", "C"}) {
		t.Fatalf("set = %v", got.EnvChanged.Set)
	}
	if !reflect.DeepEqual(got.EnvChanged.Deleted, []string{"B"}) {
		t.Fatalf("deleted = %v", got.EnvChanged.Deleted)
	}
}

func TestDeepMergeEnvNullDeletes(t *testing.T) {
	current := withEnv(&TenantConfig{}, map[string]string{"KEEP": "1", "DROP": "2"})
	patch := &Patch{HasEnv: true, Env: map[string]*string{"DROP": nil, "NEW": Str("3")}}
	merged := DeepMerge(current, patch)
	want := map[string]string{"KEEP": "1", "NEW": "3"}
	if !reflect.DeepEqual(merged.Env, want) {
		t.Fatalf("env = %v, want %v", merged.Env, want)
	}
}

func TestDeepMergeNestedKeepsSiblings(t *testing.T) {
	current := repo("https://example.com/a.git", "main")
	patch := &Patch{Git: &GitConfig{Identity: &GitIdentity{UserName: Str("u"), UserEmail: Str("u@example.com")}}}
	merged := DeepMerge(current, patch)
	if merged.CloneUrl() != "https://example.com/a.git" || merged.Branch() != "main" {
		t.Fatalf("repository fields lost: %+v", merged.Git.Repository)
	}
	if merged.Git.Identity == nil || *merged.Git.Identity.UserName != "u" {
		t.Fatalf("identity not merged")
	}
}

// The harness's GH_TOKEN is read back out of the clone URL, so this is the only
// thing standing between an agent and "gh: not authenticated".
func TestTokenFromCloneUrl(t *testing.T) {
	cases := []struct{ name, url, want string }{
		{"studio's credentialed https url",
			"https://x-access-token:ghs_abc123@github.com/acme/site.git", "ghs_abc123"},
		{"anonymous https url carries none",
			"https://github.com/acme/site.git", ""},
		{"ssh url carries none",
			"git@github.com:acme/site.git", ""},
		{"user with no password carries none",
			"https://someone@github.com/acme/site.git", ""},
		{"unparseable url", "://nope", ""},
		{"absent", "", ""},
	}
	for _, c := range cases {
		if got := TokenFromCloneUrl(c.url); got != c.want {
			t.Errorf("%s: got %q, want %q", c.name, got, c.want)
		}
	}
}

// cloneOnly has to be an explicit wire field, and it has to be able to go back
// to false: a warm-pool pod reused for a normal (dev-server) claim inherits the
// previous claim's config, so a set-only flag would strip its dev server.
func TestCloneOnlyPatchRoundTrip(t *testing.T) {
	parse := func(body string) *Patch {
		t.Helper()
		var raw map[string]json.RawMessage
		if err := json.Unmarshal([]byte(body), &raw); err != nil {
			t.Fatal(err)
		}
		p, err := ParsePatch(raw)
		if err != nil {
			t.Fatal(err)
		}
		return p
	}

	on := DeepMerge(nil, parse(`{"cloneOnly":true}`))
	if !on.IsCloneOnly() {
		t.Fatal("cloneOnly:true did not survive the patch")
	}

	// An unrelated patch must not clear it.
	kept := DeepMerge(on, parse(`{"env":{"A":"1"}}`))
	if !kept.IsCloneOnly() {
		t.Error("an unrelated patch cleared cloneOnly")
	}

	off := DeepMerge(kept, parse(`{"cloneOnly":false}`))
	if off.IsCloneOnly() {
		t.Error("cloneOnly:false did not turn the flag back off")
	}

	// Absent is off, not an error — every pre-existing sandbox config.
	if DeepMerge(nil, parse(`{"env":{"A":"1"}}`)).IsCloneOnly() {
		t.Error("a config without cloneOnly reported clone-only")
	}
}

// A secondary checkout entering or leaving must be DELIVERED to subscribers.
// Classified as no-op it is persisted silently (store.Apply skips the
// subscriber wake-up on no-op), and the sweep that clones it never runs — which
// is how a secondary added mid-run only appeared minutes later, when some
// unrelated step happened to run the pipeline.
func TestClassifySecondaryRepos(t *testing.T) {
	withRepos := func(base *TenantConfig, repos ...GitRepository) *TenantConfig {
		out := *base
		git := *out.Git
		git.Repositories = repos
		out.Git = &git
		return &out
	}
	secondary := func(name, cloneUrl string) GitRepository {
		return GitRepository{CloneUrl: Str(cloneUrl), RepoName: Str(name)}
	}

	base := repo("https://github.com/o/primary.git", "main")
	one := withRepos(base, secondary("checkout", "https://github.com/o/checkout.git"))
	two := withRepos(base,
		secondary("checkout", "https://github.com/o/checkout.git"),
		secondary("design", "https://github.com/o/design.git"),
	)

	if got := Classify(base, one).Kind; got != KindReposChange {
		t.Errorf("adding the first secondary: got %q, want %q", got, KindReposChange)
	}
	if got := Classify(one, two).Kind; got != KindReposChange {
		t.Errorf("adding a second secondary: got %q, want %q", got, KindReposChange)
	}
	if got := Classify(two, one).Kind; got != KindReposChange {
		t.Errorf("removing a secondary: got %q, want %q", got, KindReposChange)
	}
	if got := Classify(one, one).Kind; got != KindNoOp {
		t.Errorf("unchanged set: got %q, want %q", got, KindNoOp)
	}

	// Order is not identity: the tool sends the whole accumulated list every
	// time and has no reason to keep it stable.
	reordered := withRepos(base,
		secondary("design", "https://github.com/o/design.git"),
		secondary("checkout", "https://github.com/o/checkout.git"),
	)
	if got := Classify(two, reordered).Kind; got != KindNoOp {
		t.Errorf("reordered set: got %q, want %q", got, KindNoOp)
	}

	// A refreshed clone token is not a repository change — re-cloning on every
	// credential refresh would be a needless clone per token TTL.
	retokened := withRepos(base,
		secondary("checkout", "https://x-access-token:ghs_new@github.com/o/checkout.git"),
	)
	tokened := withRepos(base,
		secondary("checkout", "https://x-access-token:ghs_old@github.com/o/checkout.git"),
	)
	if got := Classify(tokened, retokened).Kind; got == KindReposChange {
		t.Errorf("token refresh classified as a repos change")
	}

	// A branch change still outranks it, since its clone step sweeps secondaries.
	movedBranch := withRepos(repo("https://github.com/o/primary.git", "other"),
		secondary("checkout", "https://github.com/o/checkout.git"),
	)
	if got := Classify(base, movedBranch).Kind; got != KindBranchChange {
		t.Errorf("branch + repos change: got %q, want %q", got, KindBranchChange)
	}
}

func TestCliEnvFromCloneUrl(t *testing.T) {
	cases := []struct {
		name string
		url  string
		want map[string]string
	}{
		{"github", "https://x-access-token:tok-gh@github.com/acme/site.git", map[string]string{"GH_TOKEN": "tok-gh"}},
		{"github enterprise", "https://x-access-token:tok@ghe.acme.com/acme/site.git", map[string]string{"GH_TOKEN": "tok", "GH_HOST": "ghe.acme.com"}},
		{"gitlab", "https://oauth2:tok-gl@gitlab.com/group/sub/project.git", map[string]string{"GITLAB_TOKEN": "tok-gl", "GITLAB_HOST": "https://gitlab.com"}},
		{"self-hosted gitlab with port", "https://oauth2:t@gitlab.acme.com:8443/g/p.git", map[string]string{"GITLAB_TOKEN": "t", "GITLAB_HOST": "https://gitlab.acme.com:8443"}},
		{"anonymous", "https://github.com/acme/site.git", nil},
		{"ssh", "git@github.com:acme/site.git", nil},
		{"unknown username", "https://user:pw@example.com/a/b.git", nil},
		{"empty", "", nil},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := CliEnvFromCloneUrl(c.url)
			if len(got) != len(c.want) {
				t.Fatalf("CliEnvFromCloneUrl(%q) = %v, want %v", c.url, got, c.want)
			}
			for k, v := range c.want {
				if got[k] != v {
					t.Errorf("CliEnvFromCloneUrl(%q)[%s] = %q, want %q", c.url, k, got[k], v)
				}
			}
		})
	}
}

func TestGlabConfigFromCloneUrl(t *testing.T) {
	got := GlabConfigFromCloneUrl("https://oauth2:tok-gl@gitlab.acme.com:8443/g/sub/p.git")
	want := "hosts:\n  gitlab.acme.com:8443:\n    token: tok-gl\n" +
		"    api_host: gitlab.acme.com:8443\n    api_protocol: https\n    is_oauth2: true\n"
	if got != want {
		t.Errorf("GlabConfigFromCloneUrl() =\n%q\nwant\n%q", got, want)
	}

	// Anything that is not a credentialed GitLab remote yields no config, so the
	// writer removes the file instead of leaving another provider's token behind.
	for _, url := range []string{
		"https://x-access-token:tok-gh@github.com/acme/site.git",
		"https://gitlab.com/acme/site.git",
		"git@gitlab.com:acme/site.git",
		"https://oauth2:@gitlab.com/acme/site.git",
		"",
	} {
		if got := GlabConfigFromCloneUrl(url); got != "" {
			t.Errorf("GlabConfigFromCloneUrl(%q) = %q, want empty", url, got)
		}
	}
}

func TestGlabConfigPath(t *testing.T) {
	if got, want := GlabConfigPath("/home/sandbox"), "/home/sandbox/.config/glab-cli/config.yml"; got != want {
		t.Errorf("GlabConfigPath() = %q, want %q", got, want)
	}
}
