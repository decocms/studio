package gitx

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func initRepoOnBranch(t *testing.T, branch string) string {
	t.Helper()
	dir := t.TempDir()
	for _, args := range [][]string{
		{"init", "-q", "-b", branch},
		{"config", "user.email", "t@example.com"},
		{"config", "user.name", "t"},
		{"commit", "-q", "--allow-empty", "-m", "init"},
	} {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	return dir
}

// The pre-push hook can't carry this on its own: publish pushes --no-verify.
func TestPublishRefusesProtectedBranch(t *testing.T) {
	for _, branch := range []string{"main", "master"} {
		repo := initRepoOnBranch(t, branch)
		if err := os.WriteFile(filepath.Join(repo, "f.txt"), []byte("x\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		err := Publish(PublishDeps{RepoDir: repo}, "should be refused")
		var blocked *PublishBlockedError
		if !errors.As(err, &blocked) {
			t.Fatalf("branch %q: expected PublishBlockedError, got %v", branch, err)
		}

		// Refused *before* committing — a stray commit on a protected branch is
		// itself the bug, even if the push never lands.
		cmd := exec.Command("git", "rev-list", "--count", "HEAD")
		cmd.Dir = repo
		out, err := cmd.Output()
		if err != nil {
			t.Fatal(err)
		}
		if got := string(out); got != "1\n" {
			t.Fatalf("branch %q: publish committed anyway (rev count %q)", branch, got)
		}
	}
}

func TestInstallProtectedBranchHookWritesTheBranchList(t *testing.T) {
	repo := initRepoOnBranch(t, "feature/x")
	if err := InstallProtectedBranchHook(repo); err != nil {
		t.Fatal(err)
	}
	hook := filepath.Join(repo, ".git", "hooks", "pre-push")
	st, err := os.Stat(hook)
	if err != nil {
		t.Fatal(err)
	}
	if st.Mode().Perm()&0o111 == 0 {
		t.Fatal("pre-push hook is not executable")
	}
	list, err := os.ReadFile(filepath.Join(repo, ".git", "hooks", "protected-branches"))
	if err != nil {
		t.Fatal("hook has no branch list to grep — it would allow every push")
	}
	if string(list) != "main\nmaster\n" {
		t.Fatalf("branch list: got %q", list)
	}
	// A feature branch is publishable: the guard must not be a blanket refusal.
	if err := Publish(PublishDeps{RepoDir: repo}, "no origin here"); err != nil {
		var blocked *PublishBlockedError
		if errors.As(err, &blocked) {
			t.Fatal("feature branch was refused as protected")
		}
		// Any other error is expected — this repo has no `origin` to push to.
	}
}
