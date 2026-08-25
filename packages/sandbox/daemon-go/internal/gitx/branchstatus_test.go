package gitx

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

type nopBroadcaster struct{}

func (nopBroadcaster) Emit(string, any) {}

func write(t *testing.T, repo, name, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(filepath.Join(repo, name)), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repo, name), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func commitAll(t *testing.T, repo string) {
	t.Helper()
	for _, args := range [][]string{{"add", "-A"}, {"commit", "-q", "-m", "snapshot"}} {
		cmd := exec.Command("git", args...)
		cmd.Dir = repo
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
}

func dirty(t *testing.T, m *BranchStatusMonitor) bool {
	t.Helper()
	meta := m.compute()
	if meta == nil || meta.Ready == nil {
		t.Fatal("expected a ready BranchMeta")
	}
	return meta.Ready.WorkingTreeDirty
}

// The header reads WorkingTreeDirty as "the user has work to publish", so boot
// artifacts must not count — and a baseline that is never armed (dev server
// never came up) or dropped (it crashed) is what made them count.
func TestBaselineSeparatesBootDirtFromUserWork(t *testing.T) {
	repo := initRepoOnBranch(t, "feature")
	m := NewBranchStatusMonitor(repo, nopBroadcaster{}, nil)

	write(t, repo, "boot.gen.json", "{}\n")
	if dirty(t, m) {
		t.Fatal("un-armed: boot has not settled, so nothing is the user's work yet")
	}

	m.ArmBaseline()
	if dirty(t, m) {
		t.Fatal("armed: boot dirt must not read as the user's work")
	}

	write(t, repo, "user.txt", "edit\n")
	if !dirty(t, m) {
		t.Fatal("a file written after arming is the user's work")
	}

	// Re-entering a boot outcome (crash → restart → crash) must not re-baseline
	// over that edit.
	m.ArmBaseline()
	if !dirty(t, m) {
		t.Fatal("first arm wins: a later arm must not swallow the edit")
	}
}

// The reported bug: a CMS edit made while the sandbox is still `starting` — before
// the baseline arms — was snapshotted into the baseline as boot dirt and silently
// swallowed, so the header read "Up to date" over a real change. A path written
// through the fs routes (MarkUserTouched) must survive the arm regardless of order.
func TestUserTouchedEditSurvivesLaterBaselineArm(t *testing.T) {
	repo := initRepoOnBranch(t, "feature")
	m := NewBranchStatusMonitor(repo, nopBroadcaster{}, nil)

	// The storefront ships committed blocks, so editing one shows as a modified
	// tracked path — the shape the header actually sees.
	write(t, repo, ".deco/blocks/pages-Home.json", `{"__resolveType":"x"}`)
	commitAll(t, repo)

	// Both made while `starting`, before the baseline arms: boot dirt the dev
	// server emits directly, and a CMS block edit that came through the fs route.
	write(t, repo, "boot.gen.json", "{}\n")
	write(t, repo, ".deco/blocks/pages-Home.json", `{"__resolveType":"y"}`)
	m.MarkUserTouched(".deco/blocks/pages-Home.json")

	// Arms only once the dev server settles — after both writes above.
	m.ArmBaseline()

	if !dirty(t, m) {
		t.Fatal("an edit made before arming must not be swallowed by the baseline")
	}
}

// The baseline pins content, not just paths: editing a file that was dirty at
// boot is still the user's work.
func TestBaselineDetectsEditToBaselinedPath(t *testing.T) {
	repo := initRepoOnBranch(t, "feature")
	m := NewBranchStatusMonitor(repo, nopBroadcaster{}, nil)

	write(t, repo, "boot.gen.json", "{}\n")
	m.ArmBaseline()
	if dirty(t, m) {
		t.Fatal("armed: boot dirt must not read as the user's work")
	}

	write(t, repo, "boot.gen.json", `{"edited":true}`)
	if !dirty(t, m) {
		t.Fatal("a changed baselined file is the user's work")
	}
}
