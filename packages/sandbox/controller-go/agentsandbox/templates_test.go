package agentsandbox

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/decocms/studio/packages/sandbox/controller-go/protocol"
)

func TestClaimTemplateName(t *testing.T) {
	pool := &TenantPool{Name: "tenant-acme"}
	for _, tc := range []struct {
		purpose protocol.Purpose
		pool    *TenantPool
		image   string
		want    string
	}{
		{"", nil, "", "studio-sandbox"},
		{protocol.PurposeInteractive, nil, "default", "studio-sandbox"},
		{protocol.PurposeHarnessRun, nil, "", "studio-sandbox-medium"},
		// Tenant pools are built from -medium, whatever the purpose.
		{protocol.PurposeInteractive, pool, "", "studio-sandbox-medium"},
		// Image before size.
		{protocol.PurposeHarnessRun, nil, "android", "studio-sandbox-android-medium"},
		{"", nil, "android", "studio-sandbox-android"},
	} {
		if got := claimTemplateName(tc.purpose, "studio-sandbox", tc.pool, tc.image); got != tc.want {
			t.Errorf("claimTemplateName(%q, pool=%v, %q) = %q, want %q", tc.purpose, tc.pool != nil, tc.image, got, tc.want)
		}
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

func newResolver(f *fakeTemplates, now *time.Time) *templateResolver {
	return &templateResolver{base: "studio-sandbox", exists: f.exists, now: func() time.Time { return *now }, probes: map[string]templateProbe{}}
}

func TestTemplateResolver(t *testing.T) {
	ctx := context.Background()
	now := time.Unix(1_000_000, 0)

	t.Run("never probes for the base template", func(t *testing.T) {
		f := &fakeTemplates{}
		got, err := newResolver(f, &now).resolve(ctx, protocol.PurposeInteractive, nil, "")
		if err != nil || got.name != "studio-sandbox" || got.image != "default" || len(f.calls) != 0 {
			t.Fatalf("got %+v err=%v calls=%v", got, err, f.calls)
		}
	})

	t.Run("uses -medium when the cluster has it, and caches the probe", func(t *testing.T) {
		f := &fakeTemplates{present: map[string]bool{"studio-sandbox-medium": true}}
		r := newResolver(f, &now)
		for i := 0; i < 3; i++ {
			got, _ := r.resolve(ctx, protocol.PurposeHarnessRun, nil, "")
			if got.name != "studio-sandbox-medium" {
				t.Fatalf("got %q", got.name)
			}
		}
		if len(f.calls) != 1 {
			t.Fatalf("probed %d times within the TTL", len(f.calls))
		}
	})

	t.Run("re-probes after the TTL, so a chart upgrade heals on its own", func(t *testing.T) {
		clock := now
		f := &fakeTemplates{present: map[string]bool{}}
		r := newResolver(f, &clock)
		if got, _ := r.resolve(ctx, protocol.PurposeHarnessRun, nil, ""); got.name != "studio-sandbox" {
			t.Fatalf("absent -medium should fall back, got %q", got.name)
		}
		f.present["studio-sandbox-medium"] = true
		clock = clock.Add(templateProbeTTL - time.Second)
		if got, _ := r.resolve(ctx, protocol.PurposeHarnessRun, nil, ""); got.name != "studio-sandbox" {
			t.Fatalf("cached absence should hold inside the TTL, got %q", got.name)
		}
		clock = clock.Add(2 * time.Second)
		if got, _ := r.resolve(ctx, protocol.PurposeHarnessRun, nil, ""); got.name != "studio-sandbox-medium" {
			t.Fatalf("expired probe should re-check, got %q", got.name)
		}
	})

	t.Run("a missing variant drops the image and keeps -medium, and reports the default served", func(t *testing.T) {
		f := &fakeTemplates{present: map[string]bool{"studio-sandbox-medium": true}}
		got, err := newResolver(f, &now).resolve(ctx, protocol.PurposeHarnessRun, nil, "android")
		if err != nil || got.name != "studio-sandbox-medium" || got.image != "default" {
			t.Fatalf("got %+v err=%v", got, err)
		}
		if want := []string{"studio-sandbox-android-medium", "studio-sandbox-medium"}; !reflect.DeepEqual(f.calls, want) {
			t.Fatalf("probes = %v, want %v", f.calls, want)
		}
	})

	t.Run("a present variant is served", func(t *testing.T) {
		f := &fakeTemplates{present: map[string]bool{"studio-sandbox-android": true}}
		got, _ := newResolver(f, &now).resolve(ctx, protocol.PurposeInteractive, nil, "android")
		if got.name != "studio-sandbox-android" || got.image != "android" {
			t.Fatalf("got %+v", got)
		}
	})

	t.Run("an API error is not a missing template", func(t *testing.T) {
		f := &fakeTemplates{err: errors.New("apiserver down")}
		if _, err := newResolver(f, &now).resolve(ctx, protocol.PurposeHarnessRun, nil, ""); err == nil {
			t.Fatal("want the error")
		}
	})
}

func TestParseTenantPools(t *testing.T) {
	pools, err := ParseTenantPools(`[{"name":"tenant-acme","orgId":"org_1","repo":"Acme/Site"}]`)
	if err != nil {
		t.Fatal(err)
	}
	if pools[0].Branch != "main" || pools[0].Workload.Runtime != "node" {
		t.Fatalf("defaults not applied: %+v", pools[0])
	}
	if pools, err := ParseTenantPools("  "); err != nil || pools != nil {
		t.Fatalf("unset should be no pools, got %v %v", pools, err)
	}
	for _, bad := range []string{
		`[{"name":"Tenant_Acme","orgId":"o","repo":"a/b"}]`,
		`[{"name":"t","orgId":"o","repo":"just-a-name"}]`,
		`[{"name":"t","orgId":"","repo":"a/b"}]`,
		`[{"name":"t","orgId":"o","repo":"a/b"},{"name":"t","orgId":"p","repo":"c/d"}]`,
		`{not json`,
	} {
		if _, err := ParseTenantPools(bad); err == nil {
			t.Errorf("accepted %s", bad)
		}
	}
}

func TestResolveTenantPool(t *testing.T) {
	pools := []TenantPool{{Name: "tenant-acme", OrgID: "org_acme", Repo: "Acme/Site"}}
	opts := func(org, cloneURL, image string) protocol.EnsureOptions {
		return protocol.EnsureOptions{Tenant: &protocol.Tenant{OrgID: org, UserID: "u"}, Repo: &protocol.EnsureRepo{CloneURL: cloneURL}, SandboxImage: image}
	}
	for _, tc := range []struct {
		name string
		opts protocol.EnsureOptions
		want bool
	}{
		{"org + repo match, credentials and case and .git ignored", opts("org_acme", "https://x-access-token:t@github.com/acme/site.git", ""), true},
		{"another org never resolves it", opts("org_other", "https://github.com/acme/site.git", ""), false},
		{"another repo of the same org does not", opts("org_acme", "https://github.com/acme/other.git", ""), false},
		{"another host with the same path does not", opts("org_acme", "https://gitlab.com/acme/site.git", ""), false},
		{"a non-default image starts cold: pools carry the default toolchain", opts("org_acme", "https://github.com/acme/site.git", "android"), false},
		{"default image is the default", opts("org_acme", "https://github.com/acme/site.git", "default"), true},
		{"no repo, no pool", protocol.EnsureOptions{Tenant: &protocol.Tenant{OrgID: "org_acme"}}, false},
		{"no tenant, no pool", protocol.EnsureOptions{Repo: &protocol.EnsureRepo{CloneURL: "https://github.com/acme/site.git"}}, false},
	} {
		if got := resolveTenantPool(pools, tc.opts) != nil; got != tc.want {
			t.Errorf("%s: got %v, want %v", tc.name, got, tc.want)
		}
	}
}

func TestClaimWarmPool(t *testing.T) {
	pool := &TenantPool{Name: "tenant-acme"}
	for _, tc := range []struct {
		pool *TenantPool
		warm bool
		want string
	}{
		{pool, true, "tenant-acme"},
		// Named, never "default": the operator would then take any pool built
		// from this template, another org's tenant pool included.
		{nil, true, "studio-sandbox-medium"},
		{nil, false, "none"},
	} {
		if got := claimWarmPool(tc.pool, tc.warm, "studio-sandbox-medium"); got != tc.want {
			t.Errorf("claimWarmPool(pool=%v, warm=%v) = %q, want %q", tc.pool != nil, tc.warm, got, tc.want)
		}
	}
}
