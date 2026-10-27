package config

import "testing"

func TestAppSlugMatchesStudioPreviewHost(t *testing.T) {
	cases := map[string]string{
		"apps/checkout":   "apps-checkout",
		"./Apps/Web_2/":   "apps-web-2",
		"packages//admin": "packages-admin",
		"///":             "",
	}
	for path, want := range cases {
		if got := AppSlug(path); got != want {
			t.Fatalf("AppSlug(%q) = %q, want %q", path, got, want)
		}
	}
}

func TestMergeApplicationReplacesAppsOnlyWhenPatched(t *testing.T) {
	apps := []ExtraApp{{Path: "apps/a"}}
	current := &Application{Apps: &apps}

	kept := mergeApplication(current, &Application{Runtime: strp("bun")})
	if len(*kept.Apps) != 1 {
		t.Fatalf("a patch without apps must keep them, got %v", kept.Apps)
	}
	empty := []ExtraApp{}
	cleared := mergeApplication(current, &Application{Apps: &empty})
	if len(*cleared.Apps) != 0 {
		t.Fatalf("an empty list must clear them, got %v", *cleared.Apps)
	}
}

func TestValidateExtraApps(t *testing.T) {
	cases := []struct {
		name    string
		apps    []ExtraApp
		wantErr bool
	}{
		{"valid", []ExtraApp{{Path: "apps/a"}, {Path: "apps/b"}}, false},
		{"escapes repo", []ExtraApp{{Path: "../x"}}, true},
		{"absolute", []ExtraApp{{Path: "/x"}}, true},
		{"empty", []ExtraApp{{Path: ""}}, true},
		{"no slug", []ExtraApp{{Path: "./"}}, true},
		{"same slug", []ExtraApp{{Path: "apps/a"}, {Path: "apps-a"}}, true},
		{"too many", make([]ExtraApp, maxExtraApps+1), true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := validateExtraApps(c.apps)
			if c.wantErr != (got != "") {
				t.Fatalf("validateExtraApps(%v) = %q, wantErr %v", c.apps, got, c.wantErr)
			}
		})
	}
}

func TestClassifyAppsOnlyChange(t *testing.T) {
	port := 3000.0
	apps := []ExtraApp{{Path: "apps/a"}}
	before := &TenantConfig{Application: &Application{Port: &port}}
	after := &TenantConfig{Application: &Application{Port: &port, Apps: &apps}}
	if got := Classify(before, after).Kind; got != KindAppsChange {
		t.Fatalf("adding an app: got %s, want %s", got, KindAppsChange)
	}
	if got := Classify(after, after).Kind; got != KindNoOp {
		t.Fatalf("same apps: got %s, want %s", got, KindNoOp)
	}
}
