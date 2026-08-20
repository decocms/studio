package gitx

import (
	"os"
	"path/filepath"
	"testing"
)

type nopBroadcaster struct{}

func (nopBroadcaster) Emit(string, any) {}

func write(t *testing.T, repo, name, content string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(repo, name), []byte(content), 0o644); err != nil {
		t.Fatal(err)
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
	if !dirty(t, m) {
		t.Fatal("un-armed: any dirt reads as dirty")
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
