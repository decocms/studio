package gitx

import (
	"strconv"
	"strings"
)

// FastForwardSkipReason is why a fast-forward did not happen. Every value is an
// expected, benign condition — never an error the caller must surface.
type FastForwardSkipReason string

const (
	SkipDetachedHead    FastForwardSkipReason = "detached-head"
	SkipProtectedBranch FastForwardSkipReason = "protected-branch"
	SkipBaseUnavailable FastForwardSkipReason = "base-unavailable"
	SkipDiverged        FastForwardSkipReason = "diverged"
	SkipUpToDate        FastForwardSkipReason = "up-to-date"
	SkipBlocked         FastForwardSkipReason = "blocked"
)

type FastForwardResult struct {
	FastForwarded bool
	Base          string
	Branch        string
	AheadOfBase   int
	BehindBase    int
	// Pushed reports whether the fast-forwarded HEAD reached origin/<branch>.
	Pushed  bool
	Skipped FastForwardSkipReason
}

// FastForwardToBase advances the current branch to origin/<base> by pure
// fast-forward, then pushes, when the branch has no local commits and merely
// fell behind while the sandbox sat idle. Anything with local commits is left
// for the manual, conflict-resolving RebaseOntoBase path.
//
// Best-effort and non-throwing for every expected condition, so a caller on the
// boot path never has to guard it.
func FastForwardToBase(repoDir string) FastForwardResult {
	run := func(args ...string) (string, bool) {
		return rebaseTry(repoDir, args)
	}

	base, _ := run("symbolic-ref", "--short", "refs/remotes/origin/HEAD")
	base = strings.TrimPrefix(base, "origin/")
	if base == "" {
		base = "main"
	}
	branch, _ := run("rev-parse", "--abbrev-ref", "HEAD")

	skip := func(reason FastForwardSkipReason, ahead, behind int) FastForwardResult {
		return FastForwardResult{
			Base: base, Branch: branch, AheadOfBase: ahead, BehindBase: behind, Skipped: reason,
		}
	}

	if branch == "" || branch == "HEAD" {
		return skip(SkipDetachedHead, 0, 0)
	}
	// A sandbox is never meant to advance a protected branch unattended, even
	// by a non-forcing fast-forward.
	for _, protected := range ProtectedBranches(repoDir) {
		if branch == protected {
			return skip(SkipProtectedBranch, 0, 0)
		}
	}

	// Fetch base ourselves: the boot's base fetch is fired detached and may not
	// have landed. Prune so a base deleted on origin surfaces as
	// base-unavailable rather than silently fast-forwarding to a dead commit.
	run("fetch", "-p", "origin", base)

	upstream := "origin/" + base
	if _, ok := run("rev-parse", "--verify", "--quiet", upstream); !ok {
		return skip(SkipBaseUnavailable, 0, 0)
	}

	behind, ahead := 0, 0
	if lr, ok := run("rev-list", "--left-right", "--count", upstream+"...HEAD"); ok {
		if m := leftRightRe.FindStringSubmatch(lr); m != nil {
			behind, _ = strconv.Atoi(m[1])
			ahead, _ = strconv.Atoi(m[2])
		}
	}

	if ahead > 0 {
		return skip(SkipDiverged, ahead, behind)
	}
	if behind == 0 {
		return skip(SkipUpToDate, ahead, behind)
	}

	// --ff-only refuses (leaving the tree untouched) if uncommitted local edits
	// would be overwritten — a benign skip, not a failure.
	if _, ok := run("merge", "--ff-only", upstream); !ok {
		return skip(SkipBlocked, ahead, behind)
	}

	// Non-force push so origin/<branch> and any open PR advance. AheadOfBase was
	// 0, so the new HEAD descends from the old origin/<branch> — this is itself a
	// fast-forward push and can never clobber. A rejection is expected and fine.
	_, pushed := run("push", "origin", "HEAD:refs/heads/"+branch)

	return FastForwardResult{
		FastForwarded: true,
		Base:          base,
		Branch:        branch,
		AheadOfBase:   ahead,
		BehindBase:    behind,
		Pushed:        pushed,
	}
}
