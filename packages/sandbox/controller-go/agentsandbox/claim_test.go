package agentsandbox

import (
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/decocms/studio/packages/sandbox/controller-go/protocol"
)

func TestBuildClaim(t *testing.T) {
	shutdown := time.Date(2026, 9, 24, 12, 0, 0, 0, time.UTC)
	opts := protocol.EnsureOptions{
		Branch: "thread:t1/c2",
		Repo:   &protocol.EnsureRepo{CloneURL: "https://x-access-token:SECRET@github.com/acme/site.git", DisplayName: "acme/site", Branch: "sandbox/thread-t1-c2"},
		Env:    map[string]string{"B": "2", "A": "1", "DAEMON_TOKEN": "hijack"},
		Tenant: &protocol.Tenant{OrgID: "org_1", UserID: "user_1", OrgName: "Acme\nInc", UserEmail: "ana@acme.dev"},
	}
	boot := bootSecrets{token: "tok", daemonBootID: "boot", workdir: "/app"}

	t.Run("cold claims carry the per-claim token in sorted env, callers cannot shadow it", func(t *testing.T) {
		c, dropped := buildClaim(claimInput{handle: "site-abc", namespace: "ns", envName: "prod", opts: opts, boot: boot, template: "studio-sandbox", warmPool: warmPoolNone, shutdown: shutdown})
		var names []string
		for _, e := range c.Spec.Env {
			names = append(names, e.Name)
			if e.Name == "DAEMON_TOKEN" && e.Value != "tok" {
				t.Errorf("DAEMON_TOKEN = %q", e.Value)
			}
		}
		if want := []string{"A", "APP_ROOT", "B", "DAEMON_BOOT_ID", "DAEMON_TOKEN", "PROXY_PORT"}; !reflect.DeepEqual(names, want) {
			t.Errorf("env names = %v, want %v", names, want)
		}
		if !reflect.DeepEqual(dropped, []string{"DAEMON_TOKEN"}) {
			t.Errorf("dropped = %v", dropped)
		}
		if c.Spec.WarmPool != "none" || c.Spec.TemplateRef.Name != "studio-sandbox" {
			t.Errorf("warmpool=%q template=%q", c.Spec.WarmPool, c.Spec.TemplateRef.Name)
		}
		if c.Spec.Lifecycle.ShutdownPolicy != "Delete" || !c.Spec.Lifecycle.ShutdownTime.Time.Equal(shutdown) {
			t.Errorf("lifecycle = %+v", c.Spec.Lifecycle)
		}
		wantLabels := map[string]string{
			"app.kubernetes.io/name": "studio-sandbox", "app.kubernetes.io/managed-by": "studio",
			labelEnv: "prod", labelOrgID: "org_1", labelUserID: "user_1",
		}
		if !reflect.DeepEqual(c.Labels, wantLabels) {
			t.Errorf("claim labels = %v", c.Labels)
		}
		pod := c.Spec.AdditionalPodMetadata.Labels
		if pod[labelRole] != "claimed" || pod[labelSandboxHandle] != "site-abc" || pod[labelEnv] != "prod" || pod[labelOrgID] != "org_1" {
			t.Errorf("pod labels = %v", pod)
		}
	})

	t.Run("warm-pool claims carry no env: the operator rejects it outside warmpool none", func(t *testing.T) {
		c, _ := buildClaim(claimInput{handle: "h", namespace: "ns", opts: opts, boot: boot, template: "studio-sandbox", warmPool: "studio-sandbox", warm: true, shutdown: shutdown})
		if len(c.Spec.Env) != 0 || c.Spec.WarmPool != "studio-sandbox" {
			t.Fatalf("env=%v warmpool=%q", c.Spec.Env, c.Spec.WarmPool)
		}
	})

	t.Run("annotations are readable and never carry the clone credential", func(t *testing.T) {
		c, _ := buildClaim(claimInput{handle: "h", namespace: "ns", opts: opts, boot: boot, template: "t", shutdown: shutdown})
		a := c.Annotations
		if a[annGitRepoURL] != "https://github.com/acme/site.git" {
			t.Errorf("git-repo-url = %q", a[annGitRepoURL])
		}
		for k, v := range a {
			if strings.Contains(v, "SECRET") {
				t.Errorf("%s leaks the credential: %q", k, v)
			}
		}
		if a[annGitBranch] != "thread:t1/c2" || a[annOrgName] != "Acme Inc" || a[annUserEmail] != "ana@acme.dev" {
			t.Errorf("annotations = %v", a)
		}
		if !reflect.DeepEqual(c.Spec.AdditionalPodMetadata.Annotations, a) {
			t.Error("pod annotations differ from the claim's")
		}
	})

	t.Run("a label value Kubernetes would reject is dropped, not sent", func(t *testing.T) {
		bad := opts
		bad.Tenant = &protocol.Tenant{OrgID: "org with spaces", UserID: strings.Repeat("u", 70)}
		c, _ := buildClaim(claimInput{handle: "h", namespace: "ns", opts: bad, boot: boot, template: "t", shutdown: shutdown})
		if _, ok := c.Labels[labelOrgID]; ok {
			t.Error("an invalid org id reached a label")
		}
		if v := c.Labels[labelUserID]; len(v) != 63 {
			t.Errorf("user id label = %q, want truncated to 63", v)
		}
	})
}

func TestReadClaimTenant(t *testing.T) {
	c, _ := buildClaim(claimInput{handle: "h", opts: protocol.EnsureOptions{Tenant: &protocol.Tenant{OrgID: "o", UserID: "u", OrgSlug: "acme"}}, template: "t", shutdown: time.Now()})
	got := readClaimTenant(c)
	if got == nil || got.OrgID != "o" || got.UserID != "u" || got.OrgSlug != "acme" {
		t.Fatalf("got %+v", got)
	}
	if readClaimTenant(&Claim{}) != nil {
		t.Fatal("a claim without tenant labels has no tenant")
	}
}

func TestPreviewPattern(t *testing.T) {
	for _, tc := range []struct{ pattern, url, host string }{
		{"https://{handle}.preview.example.com", "https://site-1.preview.example.com/", "site-1.preview.example.com"},
		{"https://{handle}.preview.example.com/", "https://site-1.preview.example.com/", "site-1.preview.example.com"},
		// The in-process runner renders this one with a double slash; one is right.
		{"https://preview.example.com", "https://site-1.preview.example.com/", "site-1.preview.example.com"},
		{"http://localhost:8080/preview", "http://site-1.localhost:8080/preview/", "site-1.localhost"},
		{"not a url", "not a url/site-1/", ""},
	} {
		if got := applyPreviewPattern(tc.pattern, "site-1"); got != tc.url {
			t.Errorf("applyPreviewPattern(%q) = %q, want %q", tc.pattern, got, tc.url)
		}
		if got := previewHostname(tc.pattern, "site-1"); got != tc.host {
			t.Errorf("previewHostname(%q) = %q, want %q", tc.pattern, got, tc.host)
		}
	}
}

func TestStripEnsureOpts(t *testing.T) {
	if stripEnsureOpts(protocol.EnsureOptions{}) != nil {
		t.Fatal("nothing to persist should persist nothing")
	}
	extra := []protocol.EnsureRepo{{CloneURL: "https://github.com/acme/b.git", DirectoryName: "b"}}
	got := stripEnsureOpts(protocol.EnsureOptions{
		Purpose: protocol.PurposeHarnessRun, SandboxImage: "android", CloneOnly: true,
		ExtraRepos: extra, OrgFsConfigJSON: `{"mounts":[]}`, Env: map[string]string{},
	})
	// extraRepos is kept, unlike the in-process runner: a resurrected sandbox
	// would otherwise lose its secondary checkouts.
	if got == nil || !reflect.DeepEqual(got.ExtraRepos, extra) || got.Purpose != protocol.PurposeHarnessRun ||
		got.SandboxImage != "android" || !got.CloneOnly || got.OrgFsConfigJSON == "" || got.Env != nil {
		t.Fatalf("got %+v", got)
	}
}
