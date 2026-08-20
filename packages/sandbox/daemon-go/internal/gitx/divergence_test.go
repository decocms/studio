package gitx

import (
	"os/exec"
	"path/filepath"
	"testing"
)

func git(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v in %s: %v\n%s", args, dir, err, out)
	}
	return string(out)
}

// A remote whose `feature` branch points at an OLD main commit — a branch that
// is fully merged into main and 0 commits ahead of it.
func originWithMergedFeature(t *testing.T) string {
	t.Helper()
	origin := filepath.Join(t.TempDir(), "origin")
	git(t, t.TempDir(), "init", "-q", "-b", "main", origin)
	git(t, origin, "config", "user.email", "t@example.com")
	git(t, origin, "config", "user.name", "t")
	git(t, origin, "commit", "-q", "--allow-empty", "-m", "one")
	git(t, origin, "branch", "feature")
	// main moves on; feature stays behind and remains an ancestor of main.
	git(t, origin, "commit", "-q", "--allow-empty", "-m", "two")
	git(t, origin, "commit", "-q", "--allow-empty", "-m", "three")
	return origin
}

func shallowCloneOfMain(t *testing.T, origin string) string {
	t.Helper()
	repo := filepath.Join(t.TempDir(), "repo")
	git(t, t.TempDir(), "clone", "-q", "--depth", "1", "--single-branch",
		"--branch", "main", "file://"+origin, repo)
	git(t, repo, "remote", "set-head", "origin", "main")
	git(t, repo, "config", "user.email", "t@example.com")
	git(t, repo, "config", "user.name", "t")
	return repo
}

// Every sandbox checkout is `--depth 1`, which grafts each tip with no parents.
// Without a common ancestor, `origin/main...origin/feature` counts BOTH sides,
// so a fully-merged branch reported 1 ahead — and the header offered
// "Review & Publish" on a branch with nothing to publish.
func TestDivergenceDoesNotFabricateAheadInAShallowClone(t *testing.T) {
	origin := originWithMergedFeature(t)
	repo := shallowCloneOfMain(t, origin)
	// The daemon's remote-branch checkout path (see CheckoutBranch).
	git(t, repo, "fetch", "-q", "--depth", "1", "origin",
		"+refs/heads/feature:refs/remotes/origin/feature")
	git(t, repo, "checkout", "-q", "-B", "feature", "refs/remotes/origin/feature")

	div := ComputeBranchDivergence(repo, nil)
	if div.Base != "main" {
		t.Fatalf("base: got %q, want main", div.Base)
	}
	if div.AheadOfBase != 0 || div.BehindBase != 0 {
		t.Fatalf("shallow clone must not fabricate divergence: ahead=%d behind=%d",
			div.AheadOfBase, div.BehindBase)
	}
	if div.Unpushed != 0 {
		t.Fatalf("nothing local: unpushed=%d", div.Unpushed)
	}
}

// The guard must not swallow real work: commits made in the sandbox descend
// from the grafted base tip, so they still have a merge-base with it.
func TestDivergenceCountsLocalCommitsInAShallowClone(t *testing.T) {
	origin := originWithMergedFeature(t)
	repo := shallowCloneOfMain(t, origin)
	git(t, repo, "checkout", "-q", "-B", "work", "refs/remotes/origin/main")
	git(t, repo, "commit", "-q", "--allow-empty", "-m", "my work")

	div := ComputeBranchDivergence(repo, nil)
	if div.AheadOfBase != 1 {
		t.Fatalf("a local commit off the base tip is 1 ahead, got %d", div.AheadOfBase)
	}
	if div.Unpushed != 1 {
		t.Fatalf("unpushed: got %d, want 1", div.Unpushed)
	}
}

// The `/git/status` route can afford the network the SSE monitor cannot, and its
// consumers gate the publish diff on `aheadOfBase` — so real pushed-ahead
// commits must survive the shallow clone, via the deepen in ComputeStatus.
func TestComputeStatusDeepensToRecoverRealAhead(t *testing.T) {
	origin := originWithMergedFeature(t)
	// A branch with a commit that is NOT on main.
	git(t, origin, "checkout", "-q", "-b", "ahead-branch", "main")
	git(t, origin, "commit", "-q", "--allow-empty", "-m", "real work")
	git(t, origin, "checkout", "-q", "main")

	repo := shallowCloneOfMain(t, origin)
	git(t, repo, "fetch", "-q", "--depth", "1", "origin",
		"+refs/heads/ahead-branch:refs/remotes/origin/ahead-branch")
	git(t, repo, "checkout", "-q", "-B", "ahead-branch", "refs/remotes/origin/ahead-branch")

	// The network-free monitor cannot tell, and says so.
	shallow := ComputeBranchDivergence(repo, nil)
	if shallow.AheadOfBase != 0 {
		t.Fatalf("shallow read should not guess: ahead=%d", shallow.AheadOfBase)
	}

	res, err := ComputeStatus(repo)
	if err != nil {
		t.Fatal(err)
	}
	if res.AheadOfBase != 1 {
		t.Fatalf("after deepening, ahead should be the real 1, got %d", res.AheadOfBase)
	}
	if res.BehindBase != 0 {
		t.Fatalf("branched off the main tip, so behind is 0, got %d", res.BehindBase)
	}
}

// And the merged branch stays honest through the same path: 0 ahead.
func TestComputeStatusKeepsAMergedBranchAtZeroAhead(t *testing.T) {
	origin := originWithMergedFeature(t)
	repo := shallowCloneOfMain(t, origin)
	git(t, repo, "fetch", "-q", "--depth", "1", "origin",
		"+refs/heads/feature:refs/remotes/origin/feature")
	git(t, repo, "checkout", "-q", "-B", "feature", "refs/remotes/origin/feature")

	res, err := ComputeStatus(repo)
	if err != nil {
		t.Fatal(err)
	}
	if res.AheadOfBase != 0 {
		t.Fatalf("a fully-merged branch is 0 ahead, got %d", res.AheadOfBase)
	}
}
