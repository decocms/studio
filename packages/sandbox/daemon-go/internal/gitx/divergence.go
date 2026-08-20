package gitx

import (
	"regexp"
	"strconv"
	"strings"
)

type BranchDivergence struct {
	Base        string `json:"base"`
	AheadOfBase int    `json:"aheadOfBase"`
	BehindBase  int    `json:"behindBase"`
	HeadSha     string `json:"headSha"`
	Unpushed    int    `json:"unpushed"`
}

var leftRightRe = regexp.MustCompile(`^(\d+)\s+(\d+)$`)

// hasCommonAncestor reports whether two refs are comparable in THIS repo — false
// in a shallow clone whose grafted tips descend from nothing shared.
func hasCommonAncestor(tryGit func(args []string) (string, bool), a, b string) bool {
	out, ok := tryGit([]string{"merge-base", a, b})
	return ok && strings.TrimSpace(out) != ""
}

func ComputeBranchDivergence(repoDir string, tryGit func(args []string) (string, bool)) BranchDivergence {
	if tryGit == nil {
		tryGit = func(args []string) (string, bool) {
			return Try(args, RunOpts{Cwd: repoDir, Env: map[string]string{"GIT_CEILING_DIRECTORIES": repoDir}})
		}
	}
	base, _ := tryGit([]string{"symbolic-ref", "--short", "refs/remotes/origin/HEAD"})
	base = strings.TrimPrefix(base, "origin/")
	if base == "" {
		base = "main"
	}

	branch, _ := tryGit([]string{"rev-parse", "--abbrev-ref", "HEAD"})
	if branch == "" || branch == "HEAD" {
		headSha, _ := tryGit([]string{"rev-parse", "HEAD"})
		return BranchDivergence{Base: base, HeadSha: headSha}
	}

	refExists := func(ref string) bool {
		_, ok := tryGit([]string{"rev-parse", "--verify", "--quiet", ref})
		return ok
	}

	remoteBranchRef := "origin/" + branch
	hasRemoteBranch := refExists(remoteBranchRef)
	branchRef := "HEAD"
	if hasRemoteBranch {
		branchRef = remoteBranchRef
	}

	// Every sandbox checkout is `--depth 1` (setup/clone.go, CheckoutBranch), so
	// each fetched tip is grafted with no parents. When the branch was not
	// fetched from the same tip as the base, the two share no ancestor in this
	// clone and `A...B` degenerates into "everything reachable on both sides":
	// git answers 1 ahead / 1 behind for a branch that is IDENTICAL to base and
	// fully merged. The header read that as work and offered "Review & Publish"
	// on an untouched branch (while the publish dialog, which deepens to 100
	// before diffing — see status.go — correctly reported 0 changes).
	//
	// No common ancestor means "not comparable in this clone": report 0 instead
	// of a fabricated count. Local work still surfaces, because `unpushed` below
	// compares origin/<branch>..HEAD — same branch, which a shallow clone
	// answers correctly — and a branch forked from the base tip inside the
	// sandbox keeps that grafted tip as its merge-base, so its commits still
	// count.
	aheadOfBase, behindBase := 0, 0
	if refExists("origin/"+base) && hasCommonAncestor(tryGit, "origin/"+base, branchRef) {
		lr, _ := tryGit([]string{"rev-list", "--left-right", "--count", "origin/" + base + "..." + branchRef})
		if m := leftRightRe.FindStringSubmatch(lr); m != nil {
			behindBase, _ = strconv.Atoi(m[1])
			aheadOfBase, _ = strconv.Atoi(m[2])
		}
	}

	unpushed := 0
	if hasRemoteBranch {
		out, _ := tryGit([]string{"rev-list", "--count", remoteBranchRef + "..HEAD"})
		unpushed, _ = strconv.Atoi(strings.TrimSpace(out))
	} else {
		unpushed = aheadOfBase
	}

	headSha, _ := tryGit([]string{"rev-parse", branchRef})
	return BranchDivergence{
		Base:        base,
		AheadOfBase: aheadOfBase,
		BehindBase:  behindBase,
		HeadSha:     headSha,
		Unpushed:    unpushed,
	}
}
