package agentsandbox

// The ledger for tenant-pools.test.ts: each subtest names the TS case it
// ports, under a test named for the TS describe block.

import (
	"context"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/decocms/studio/packages/sandbox/controller-go/protocol"
)

func mustPools(t *testing.T, raw string) []TenantPool {
	t.Helper()
	pools, err := ParseTenantPools(raw)
	if err != nil {
		t.Fatal(err)
	}
	return pools
}

func acmePools(t *testing.T) []TenantPool {
	return mustPools(t, `[{"name":"tenant-acme-site","orgId":"org-acme","repo":"Acme/Site","connectionId":"conn-1"}]`)
}

func TestParseTenantPools(t *testing.T) {
	t.Run("defaults branch and workload", func(t *testing.T) {
		p := acmePools(t)[0]
		if p.Branch != "main" || p.Workload == nil || p.Workload.Runtime != "node" {
			t.Fatalf("defaults not applied: %+v", p)
		}
	})
	t.Run("unset/empty → no pools", func(t *testing.T) {
		for _, raw := range []string{"", "  "} {
			if pools, err := ParseTenantPools(raw); err != nil || pools != nil {
				t.Fatalf("%q: got %v %v", raw, pools, err)
			}
		}
	})
	for _, tc := range []struct{ name, raw, wantErr string }{
		{"rejects a pool name that is not a DNS label", `[{"name":"Tenant_Acme","orgId":"o","repo":"a/b","connectionId":"c"}]`, "DNS label"},
		{"rejects a repo that is not owner/name", `[{"name":"p","orgId":"o","repo":"just-a-name","connectionId":"c"}]`, "owner/name"},
		{"rejects duplicate pool names", `[{"name":"p","orgId":"o","repo":"a/b","connectionId":"c"},{"name":"p","orgId":"o","repo":"a/b","connectionId":"c"}]`, "duplicate pool name"},
		// Go only: zod's min(1) and JSON.parse.
		{"rejects an empty orgId", `[{"name":"p","orgId":"","repo":"a/b"}]`, "orgId"},
		{"rejects malformed JSON", `{not json`, "tenant pools"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := ParseTenantPools(tc.raw); err == nil || !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("err = %v, want it to mention %q", err, tc.wantErr)
			}
		})
	}
}

func TestRepoKeyFromCloneURL(t *testing.T) {
	for _, tc := range []struct{ name, url, want string }{
		{"strips credentials, .git, and case", "https://x-access-token:tok@github.com/Acme/Site.git", "acme/site"},
		{"returns null for a non-URL", "git@github.com:acme/site.git", ""},
		{"is null for any host other than github.com (gitlab.com)", "https://oauth2:tok@gitlab.com/acme/site.git", ""},
		{"is null for any host other than github.com (self-hosted)", "https://gitlab.acme.com/acme/site.git", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := repoKeyFromCloneURL(tc.url); got != tc.want {
				t.Fatalf("repoKeyFromCloneURL(%q) = %q, want %q", tc.url, got, tc.want)
			}
		})
	}
}

func TestResolveTenantPool(t *testing.T) {
	pools := acmePools(t)
	const url = "https://x-access-token:tok@github.com/acme/site.git"
	opts := func(org, cloneURL string) protocol.EnsureOptions {
		o := protocol.EnsureOptions{}
		if org != "" {
			o.Tenant = &protocol.Tenant{OrgID: org, UserID: "u"}
		}
		if cloneURL != "" {
			o.Repo = &protocol.EnsureRepo{CloneURL: cloneURL}
		}
		return o
	}
	for _, tc := range []struct {
		name  string
		pools []TenantPool
		opts  protocol.EnsureOptions
		want  string
	}{
		{"matches on org + repo", pools, opts("org-acme", url), "tenant-acme-site"},
		{"still refuses another org's pool", pools, opts("org-other", url), ""},
		{"still refuses another repo's pool", pools, opts("org-acme", "https://github.com/acme/other-repo.git"), ""},
		{"a user of another org never resolves this pool", pools, opts("org-other", url), ""},
		{"the same org on another repo does not resolve it", pools, opts("org-acme", "https://github.com/acme/other.git"), ""},
		{"no org → no pool", pools, opts("", url), ""},
		{"no repo → no pool", pools, opts("org-acme", ""), ""},
		{"no pools configured → no pool", nil, opts("org-acme", url), ""},
		// Go only: pools are built from the default image's template.
		{"a non-default image starts cold", pools, func() protocol.EnsureOptions { o := opts("org-acme", url); o.SandboxImage = "android"; return o }(), ""},
		{"the default image is the default", pools, func() protocol.EnsureOptions { o := opts("org-acme", url); o.SandboxImage = "default"; return o }(), "tenant-acme-site"},
		{"another host with the same path does not", pools, opts("org-acme", "https://gitlab.com/acme/site.git"), ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := ""
			if p := resolveTenantPool(tc.pools, tc.opts); p != nil {
				got = p.Name
			}
			if got != tc.want {
				t.Fatalf("got %q, want %q", got, tc.want)
			}
		})
	}
}

func TestClaimWarmPool(t *testing.T) {
	pool := &acmePools(t)[0]
	for _, tc := range []struct {
		name     string
		pool     *TenantPool
		warm     bool
		template string
		want     string
	}{
		{"a resolved pool binds that pool", pool, true, "studio-sandbox", "tenant-acme-site"},
		// Never "default": the operator would then take any pool built from the
		// template, another org's tenant pool included (409 immutable: cloneUrl).
		{"no pool in warm-pool mode names the generic pool explicitly", nil, true, "studio-sandbox", "studio-sandbox"},
		{"no sentinel → `none`, so the operator still accepts per-claim env", nil, false, "studio-sandbox", "none"},
		{"the warm pool follows the template it picked", nil, true, claimTemplateName(protocol.PurposeHarnessRun, "studio-sandbox", nil, ""), "studio-sandbox-medium"},
		{"an interactive claim names the default pool, not the medium one", nil, true, claimTemplateName(protocol.PurposeInteractive, "studio-sandbox", nil, ""), "studio-sandbox"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := claimWarmPool(tc.pool, tc.warm, tc.template); got != tc.want {
				t.Fatalf("got %q, want %q", got, tc.want)
			}
		})
	}
}

func TestClaimTemplateName(t *testing.T) {
	pool := &acmePools(t)[0]
	for _, tc := range []struct {
		name    string
		purpose protocol.Purpose
		base    string
		pool    *TenantPool
		image   string
		want    string
	}{
		{"a harness run takes the -medium template", protocol.PurposeHarnessRun, "studio-sandbox", nil, "", "studio-sandbox-medium"},
		{"interactive claims stay on the default template", protocol.PurposeInteractive, "studio-sandbox", nil, "", "studio-sandbox"},
		{"interactive claims stay on the default template (no purpose)", "", "studio-sandbox", nil, "", "studio-sandbox"},
		{"with an image variant: suffixes the image before the size (interactive)", protocol.PurposeInteractive, "sbx", nil, "android", "sbx-android"},
		{"with an image variant: suffixes the image before the size (harness)", protocol.PurposeHarnessRun, "sbx", nil, "android", "sbx-android-medium"},
		{"with an image variant: the default image is no suffix at all (interactive)", protocol.PurposeInteractive, "sbx", nil, "default", "sbx"},
		{"with an image variant: the default image is no suffix at all (harness)", protocol.PurposeHarnessRun, "sbx", nil, "default", "sbx-medium"},
		// The chart builds tenant pools from -medium and the operator binds warm
		// pods by template: any other name gets a cold pod and no error.
		{"with a tenant pool: names -medium whatever the purpose (interactive)", protocol.PurposeInteractive, "sbx", pool, "", "sbx-medium"},
		{"with a tenant pool: names -medium whatever the purpose (harness)", protocol.PurposeHarnessRun, "sbx", pool, "", "sbx-medium"},
		{"with a tenant pool: leaves a non-pool interactive claim on the default template", protocol.PurposeInteractive, "sbx", nil, "", "sbx"},
		{"with a tenant pool: leaves a non-pool claim with no purpose on the default template", "", "sbx", nil, "", "sbx"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := claimTemplateName(tc.purpose, tc.base, tc.pool, tc.image); got != tc.want {
				t.Fatalf("got %q, want %q", got, tc.want)
			}
		})
	}
}

type fakeTemplates struct {
	present map[string]bool
	calls   []string
	err     error
}

func (f *fakeTemplates) exists(_ context.Context, name string) (bool, error) {
	f.calls = append(f.calls, name)
	return f.present[name], f.err
}

func newResolver(base string, f *fakeTemplates, now *time.Time, warned *[]string) *templateResolver {
	r := &templateResolver{base: base, exists: f.exists, now: func() time.Time { return *now }, probes: map[string]templateProbe{}}
	if warned != nil {
		r.onAbsent = func(name string) { *warned = append(*warned, name) }
	}
	return r
}

// resolveClaimTemplateName's TTL is templateProbeTTL here; the TS cases pass
// 60s explicitly.
func TestResolveClaimTemplateName(t *testing.T) {
	ctx := context.Background()
	start := time.Unix(1_000_000, 0)

	t.Run("never probes for an interactive claim", func(t *testing.T) {
		now, f := start, &fakeTemplates{}
		got, err := newResolver("studio-sandbox", f, &now, nil).resolve(ctx, protocol.PurposeInteractive, nil, "")
		if err != nil || got.name != "studio-sandbox" || len(f.calls) != 0 {
			t.Fatalf("got %+v err=%v probes=%v", got, err, f.calls)
		}
	})

	t.Run("uses -medium when the cluster has it", func(t *testing.T) {
		now, f := start, &fakeTemplates{present: map[string]bool{"studio-sandbox-medium": true}}
		r := newResolver("studio-sandbox", f, &now, nil)
		got, _ := r.resolve(ctx, protocol.PurposeHarnessRun, nil, "")
		if got.name != "studio-sandbox-medium" || r.probes["studio-sandbox-medium"] != (templateProbe{checkedAt: start, present: true}) {
			t.Fatalf("got %+v probes=%+v", got, r.probes)
		}
	})

	t.Run("falls back to the default template when -medium is absent", func(t *testing.T) {
		var warned []string
		now, f := start, &fakeTemplates{}
		r := newResolver("studio-sandbox", f, &now, &warned)
		got, _ := r.resolve(ctx, protocol.PurposeHarnessRun, nil, "")
		if got.name != "studio-sandbox" || r.probes["studio-sandbox-medium"] != (templateProbe{checkedAt: start, present: false}) {
			t.Fatalf("got %+v probes=%+v", got, r.probes)
		}
		if !reflect.DeepEqual(warned, []string{"studio-sandbox-medium"}) {
			t.Fatalf("warned = %v", warned)
		}
	})

	t.Run("reuses a fresh probe instead of hitting the API per claim", func(t *testing.T) {
		now, f := start, &fakeTemplates{present: map[string]bool{"studio-sandbox-medium": true}}
		r := newResolver("studio-sandbox", f, &now, nil)
		r.probes["studio-sandbox-medium"] = templateProbe{checkedAt: start.Add(-templateProbeTTL + time.Millisecond), present: true}
		got, _ := r.resolve(ctx, protocol.PurposeHarnessRun, nil, "")
		if got.name != "studio-sandbox-medium" || len(f.calls) != 0 {
			t.Fatalf("got %+v probes=%v", got, f.calls)
		}
	})

	t.Run("re-probes once the TTL is up, so an upgrade heals on its own", func(t *testing.T) {
		now, f := start, &fakeTemplates{present: map[string]bool{"studio-sandbox-medium": true}}
		r := newResolver("studio-sandbox", f, &now, nil)
		r.probes["studio-sandbox-medium"] = templateProbe{checkedAt: start.Add(-templateProbeTTL), present: false}
		got, _ := r.resolve(ctx, protocol.PurposeHarnessRun, nil, "")
		if got.name != "studio-sandbox-medium" || r.probes["studio-sandbox-medium"] != (templateProbe{checkedAt: start, present: true}) {
			t.Fatalf("got %+v probes=%+v", got, r.probes)
		}
	})

	t.Run("warns once per absence, not once per claim", func(t *testing.T) {
		var warned []string
		now, f := start, &fakeTemplates{}
		r := newResolver("studio-sandbox", f, &now, &warned)
		_, _ = r.resolve(ctx, protocol.PurposeHarnessRun, nil, "")
		// Past the TTL too: a re-probe that finds it still absent is the same absence.
		now = now.Add(templateProbeTTL)
		_, _ = r.resolve(ctx, protocol.PurposeHarnessRun, nil, "")
		if !reflect.DeepEqual(warned, []string{"studio-sandbox-medium"}) {
			t.Fatalf("warned = %v", warned)
		}
	})
}

func TestResolveClaimTemplateNameWithAnImageVariant(t *testing.T) {
	ctx := context.Background()
	start := time.Unix(1_000_000, 0)

	t.Run("probes and uses the variant template", func(t *testing.T) {
		now, f := start, &fakeTemplates{present: map[string]bool{"sbx-android": true}}
		got, _ := newResolver("sbx", f, &now, nil).resolve(ctx, protocol.PurposeInteractive, nil, "android")
		if got.name != "sbx-android" || got.image != "android" {
			t.Fatalf("got %+v", got)
		}
	})

	t.Run("falls back to the base template when the variant is absent", func(t *testing.T) {
		now, f := start, &fakeTemplates{}
		got, _ := newResolver("sbx", f, &now, nil).resolve(ctx, protocol.PurposeInteractive, nil, "android")
		if got.name != "sbx" || got.image != "default" {
			t.Fatalf("got %+v", got)
		}
	})

	t.Run("keeps the -medium ceiling when only the variant is absent", func(t *testing.T) {
		now, f := start, &fakeTemplates{present: map[string]bool{"sbx-medium": true}}
		got, _ := newResolver("sbx", f, &now, nil).resolve(ctx, protocol.PurposeHarnessRun, nil, "android")
		if got.name != "sbx-medium" || got.image != "default" {
			t.Fatalf("got %+v", got)
		}
		if want := []string{"sbx-android-medium", "sbx-medium"}; !reflect.DeepEqual(f.calls, want) {
			t.Fatalf("probes = %v, want %v", f.calls, want)
		}
	})

	t.Run("caches each derived name separately", func(t *testing.T) {
		now, f := start, &fakeTemplates{present: map[string]bool{"sbx-android": true, "sbx-android-medium": true}}
		r := newResolver("sbx", f, &now, nil)
		first, _ := r.resolve(ctx, protocol.PurposeInteractive, nil, "android")
		second, _ := r.resolve(ctx, protocol.PurposeHarnessRun, nil, "android")
		third, _ := r.resolve(ctx, protocol.PurposeInteractive, nil, "android")
		if first.name != "sbx-android" || second.name != "sbx-android-medium" || third.name != "sbx-android" {
			t.Fatalf("names = %s %s %s", first.name, second.name, third.name)
		}
		if want := []string{"sbx-android", "sbx-android-medium"}; !reflect.DeepEqual(f.calls, want) {
			t.Fatalf("probes = %v, want %v", f.calls, want)
		}
	})
}

func TestPoolsMatchingPush(t *testing.T) {
	pools := acmePools(t)
	for _, tc := range []struct {
		name, repo, ref string
		want            []string
	}{
		{"matches the pool's branch, case-insensitively on the repo", "acme/SITE", "refs/heads/main", []string{"tenant-acme-site"}},
		{"ignores a push to another branch", "Acme/Site", "refs/heads/dev", nil},
		{"ignores a tag push (refs/tags is not refs/heads)", "Acme/Site", "refs/tags/main", nil},
		{"ignores another repo", "acme/other", "refs/heads/main", nil},
		// Go only: git refs are case-sensitive.
		{"the branch match is case-sensitive", "Acme/Site", "refs/heads/Main", nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var got []string
			for _, p := range poolsMatchingPush(pools, tc.repo, tc.ref) {
				got = append(got, p.Name)
			}
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("got %v, want %v", got, tc.want)
			}
		})
	}
}
