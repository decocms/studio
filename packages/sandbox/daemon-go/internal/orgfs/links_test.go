package orgfs

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// The end-to-end behavior lives in daemon.orgfs.e2e.test.ts. Here: the one
// invariant that suite cannot see — the memo must never cache a failed repoint.
func TestRepointDoesNotCacheAFailedLink(t *testing.T) {
	appRoot := t.TempDir()
	statusPath := filepath.Join(t.TempDir(), "status.json")
	writeStatus := func(dirs ...string) {
		var mounts []Mount
		for _, d := range dirs {
			p := filepath.Join(appRoot, "org", d)
			if err := os.MkdirAll(p, 0o755); err != nil {
				t.Fatal(err)
			}
			mounts = append(mounts, Mount{Volume: d, MountPath: p})
		}
		raw, _ := json.Marshal(sidecarStatus{Mounts: mounts})
		if err := os.WriteFile(statusPath, raw, 0o644); err != nil {
			t.Fatal(err)
		}
	}

	l := &Links{AppRoot: appRoot, StatusPath: statusPath, ConfigPath: "unused"}

	// The outputs volume is not mounted yet — a sandbox provisioned before it
	// existed, or a sidecar still attaching.
	writeStatus(".uploads")
	if l.RepointForRun("t1") {
		t.Fatal("reported a repoint with no outputs mount")
	}
	if _, err := os.Lstat(filepath.Join(appRoot, "org", "output")); err == nil {
		t.Fatal("linked output into an unmounted volume")
	}

	// It appears. Had the failure been memoized, this would return true without
	// creating the link, and every write for this thread would go nowhere.
	writeStatus(".uploads", ".outputs")
	if !l.RepointForRun("t1") {
		t.Fatal("did not repoint once the outputs volume was mounted")
	}
	target, err := os.Readlink(filepath.Join(appRoot, "org", "output"))
	if err != nil {
		t.Fatalf("no output link after a reported repoint: %v", err)
	}
	if want := filepath.Join(".outputs", "t1"); target != want {
		t.Errorf("output → %q, want %q", target, want)
	}
}

func TestExpectedRequiresSidecarEnv(t *testing.T) {
	if (&Links{}).Expected() {
		t.Error("org-fs expected with no sidecar env — every call would pay the mount wait")
	}
	if !(&Links{ConfigPath: "/run/orgfs/config.json"}).Expected() {
		t.Error("a relay config path alone must mark org-fs expected")
	}
	var nilLinks *Links
	if nilLinks.Expected() {
		t.Error("nil Links reported org-fs expected")
	}
}
