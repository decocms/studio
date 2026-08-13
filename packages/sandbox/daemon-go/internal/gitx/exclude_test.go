package gitx

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func gitIn(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
	return string(out)
}

// The repo-less pod's order: daemon-managed paths are written (and excluded)
// BEFORE any checkout, then `TASK_ADD_REPO` git-inits the non-empty dir. Without
// the reapply, that fresh `.git` has no excludes and the shutdown `git add -A`
// commits the catalog — which is how a run's MCP bearer token reached a PR.
func TestReapplyExcludesSurvivesAGitInitAfterTheWrite(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, ".deco", "tools"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, ".deco", "tools", ".endpoint.json"), []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	EnsureExclude(dir, "/.deco/tools/")

	gitIn(t, dir, "init", "-q")
	if status := gitIn(t, dir, "status", "--porcelain"); !strings.Contains(status, ".deco") {
		t.Fatalf("expected the pre-init exclude to be lost, got %q", status)
	}

	ReapplyExcludes(dir)

	if status := gitIn(t, dir, "status", "--porcelain"); strings.Contains(status, ".deco") {
		t.Fatalf("catalog still visible to `git add -A`: %q", status)
	}
}

// Belt for the above: whatever the exclude state, publish must not commit the
// endpoint file — it holds the run's bearer token, and a push is irreversible.
func TestPublishNeverCommitsTheEndpointCredential(t *testing.T) {
	repo := initRepoOnBranch(t, "feature/x")
	if err := os.MkdirAll(filepath.Join(repo, ".deco", "tools"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repo, ".deco", "tools", ".endpoint.json"), []byte(`{"headers":{"Authorization":"Bearer synthetic-not-a-real-token"}}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repo, "app.ts"), []byte("export const x = 1;\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	// Fails at the push (no remote); the commit it builds first is the artifact.
	_ = Publish(PublishDeps{RepoDir: repo}, "sync")

	committed := gitIn(t, repo, "show", "--pretty=format:", "--name-only", "HEAD")
	if strings.Contains(committed, ".endpoint.json") {
		t.Fatalf("publish committed the credential file: %q", committed)
	}
	if !strings.Contains(committed, "app.ts") {
		t.Fatalf("publish dropped the user's work too: %q", committed)
	}
}
