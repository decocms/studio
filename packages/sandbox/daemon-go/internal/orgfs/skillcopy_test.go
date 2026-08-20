package orgfs

import (
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
)

func writeSkillDir(t *testing.T, root, name string, files map[string]int) {
	t.Helper()
	dir := filepath.Join(root, name)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	for f, size := range files {
		path := filepath.Join(dir, f)
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, make([]byte, size), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func budgetOf(n int64) *atomic.Int64 {
	b := &atomic.Int64{}
	b.Store(n)
	return b
}

// A synced repo is arbitrary user content: an oversized file inside a skill dir
// must be refused, not written to the pod's ephemeral disk.
func TestSkillCopyRespectsBudget(t *testing.T) {
	src, dstRoot := t.TempDir(), t.TempDir()
	writeSkillDir(t, src, "fat", map[string]int{"SKILL.md": 64, "blob.bin": 4096})

	budget := budgetOf(1024)
	dst := filepath.Join(dstRoot, "fat")
	if prefetchSkill(filepath.Join(src, "fat"), dst, budget) {
		t.Fatal("copied a skill past the disk budget")
	}
	// A refused skill must leave nothing behind — a half-copied skill is worse
	// than a missing one, since the harness would read and trust it.
	if _, err := os.Stat(dst); !os.IsNotExist(err) {
		t.Errorf("partial copy left on disk: %v", err)
	}
	// The refusal must not have permanently eaten the budget: a smaller skill
	// behind the fat one still fits.
	writeSkillDir(t, src, "thin", map[string]int{"SKILL.md": 64})
	if !prefetchSkill(filepath.Join(src, "thin"), filepath.Join(dstRoot, "thin"), budget) {
		t.Error("budget not returned after a refused copy")
	}
}

// Skill helper scripts are executed. Losing the exec bit in the copy would break
// every skill that ships one, silently.
func TestSkillCopyPreservesExecBit(t *testing.T) {
	src, dstRoot := t.TempDir(), t.TempDir()
	writeSkillDir(t, src, "s", map[string]int{"SKILL.md": 16, "bin/run.sh": 16})
	script := filepath.Join(src, "s", "bin", "run.sh")
	if err := os.Chmod(script, 0o755); err != nil {
		t.Fatal(err)
	}

	dst := filepath.Join(dstRoot, "s")
	if !prefetchSkill(filepath.Join(src, "s"), dst, budgetOf(skillCopyBudget)) {
		t.Fatal("copy failed")
	}
	st, err := os.Stat(filepath.Join(dst, "bin", "run.sh"))
	if err != nil {
		t.Fatalf("nested file not copied: %v", err)
	}
	if st.Mode().Perm()&0o111 == 0 {
		t.Errorf("exec bit lost: mode %v", st.Mode().Perm())
	}
}

func TestPrefetchSkillsSharesOneBudget(t *testing.T) {
	src, dstRoot := t.TempDir(), t.TempDir()
	var jobs []skillJob
	// Each skill is a quarter of the cap, so the fifth must not fit however the
	// workers interleave.
	for _, n := range []string{"a", "b", "c", "d", "e"} {
		writeSkillDir(t, src, n, map[string]int{"SKILL.md": int(skillCopyBudget / 4)})
		jobs = append(jobs, skillJob{filepath.Join(src, n), filepath.Join(dstRoot, n)})
	}
	if got := prefetchSkills(jobs); got != 4 {
		t.Errorf("copied %d skills, want 4 (the budget fits exactly four)", got)
	}
}
