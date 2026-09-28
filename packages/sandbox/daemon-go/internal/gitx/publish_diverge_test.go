package gitx

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func gitOut(t *testing.T, dir string, args ...string) string {
	t.Helper()
	return strings.TrimSpace(gitIn(t, dir, args...))
}

func writeFile(t *testing.T, dir, name, content string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

// divergedSandbox returns an origin whose feature branch a teammate advanced
// after the sandbox cloned it, plus the sandbox clone with its own edit.
func divergedSandbox(t *testing.T, teammateFile, sandboxFile string) (origin, sandbox string) {
	t.Helper()
	origin = t.TempDir()
	gitIn(t, origin, "init", "-q", "--bare", "-b", "main")

	clone := func(branch ...string) string {
		dir := t.TempDir()
		gitIn(t, dir, append([]string{"clone", "-q"}, append(branch, origin, ".")...)...)
		gitIn(t, dir, "config", "user.email", "t@example.com")
		gitIn(t, dir, "config", "user.name", "t")
		return dir
	}
	seed := clone()
	writeFile(t, seed, "shared.txt", "base\n")
	gitIn(t, seed, "add", ".")
	gitIn(t, seed, "commit", "-q", "-m", "base")
	gitIn(t, seed, "push", "-q", "origin", "HEAD:main", "HEAD:feature/x")

	sandbox = clone("-b", "feature/x")
	teammate := clone("-b", "feature/x")
	writeFile(t, teammate, teammateFile, "teammate\n")
	gitIn(t, teammate, "add", ".")
	gitIn(t, teammate, "commit", "-q", "-m", "teammate")
	gitIn(t, teammate, "push", "-q", "origin", "feature/x")

	writeFile(t, sandbox, sandboxFile, "sandbox\n")
	return origin, sandbox
}

func TestShutdownPublishRebasesOntoAMovedBranch(t *testing.T) {
	origin, sandbox := divergedSandbox(t, "other.txt", "mine.txt")

	if err := Publish(PublishDeps{RepoDir: sandbox, RebaseOnDiverge: true}, "sync"); err != nil {
		t.Fatalf("publish: %v", err)
	}

	files := gitOut(t, origin, "ls-tree", "--name-only", "feature/x")
	if !strings.Contains(files, "other.txt") || !strings.Contains(files, "mine.txt") {
		t.Fatalf("feature/x should hold both the teammate's and the sandbox's work, has:\n%s", files)
	}
	if branches := gitOut(t, origin, "branch", "--list", "*rescue*"); branches != "" {
		t.Fatalf("a clean rebase must not create a rescue branch, got %q", branches)
	}
}

func TestShutdownPublishRescuesWorkThatConflicts(t *testing.T) {
	origin, sandbox := divergedSandbox(t, "shared.txt", "shared.txt")
	teammateTip := gitOut(t, origin, "rev-parse", "feature/x")

	if err := Publish(PublishDeps{RepoDir: sandbox, RebaseOnDiverge: true}, "sync"); err != nil {
		t.Fatalf("publish: %v", err)
	}

	if got := gitOut(t, origin, "rev-parse", "feature/x"); got != teammateTip {
		t.Fatalf("feature/x moved to %s; the teammate's tip %s must stay untouched", got, teammateTip)
	}
	rescue := gitOut(t, origin, "for-each-ref", "--format=%(refname:short)", "refs/heads/feature/x-rescue-*")
	if rescue == "" {
		t.Fatal("conflicting work was not pushed to a rescue branch")
	}
	if got := gitOut(t, origin, "show", rescue+":shared.txt"); got != "sandbox" {
		t.Fatalf("rescue branch holds %q, want the sandbox's version", got)
	}
	if isRebaseInProgress(sandbox) {
		t.Fatal("the failed rebase was left in progress")
	}
}
