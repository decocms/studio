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

	aheadOfBase, behindBase := 0, 0
	if refExists("origin/" + base) {
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
