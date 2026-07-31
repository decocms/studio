package gitx

import "strings"

// ForcePushOpts carries the per-caller differences: the publish path prepends
// credential/safe.directory config and pushes --no-verify; the rebase path
// pushes plain.
type ForcePushOpts struct {
	ConfigArgs []string
	PushArgs   []string
	Env        map[string]string
}

// RemoteBranchSha is the current sha of origin/<branch> in the local clone.
func RemoteBranchSha(repoDir, branch string) (string, bool) {
	return rebaseTry(repoDir, []string{"rev-parse", "--verify", "refs/remotes/origin/" + branch})
}

// ForcePushWithLease force-pushes branch, preferring --force-with-lease. The
// lease is not a concurrent-writer safeguard — a stale-lease rejection re-leases
// against the new tip and clobbers it; it only avoids a blind --force in the
// common case. Empty leaseSha falls through to --force.
func ForcePushWithLease(repoDir, branch, leaseSha string, opts ForcePushOpts) error {
	run := func(args []string) (string, error) {
		return Run(args, RunOpts{Cwd: repoDir, Env: rebaseEnv(repoDir, opts.Env)})
	}
	push := func(extra ...string) error {
		args := append([]string{}, opts.ConfigArgs...)
		args = append(args, "push")
		args = append(args, opts.PushArgs...)
		args = append(args, extra...)
		args = append(args, "origin", branch)
		_, err := run(args)
		return err
	}

	if leaseSha != "" {
		err := push("--force-with-lease=refs/heads/" + branch + ":" + leaseSha)
		if err == nil {
			return nil
		}
		message := FormatGitError(err)
		retriable := strings.Contains(message, "stale info") ||
			strings.Contains(message, "failed to push some refs")
		if !retriable {
			return err
		}
		fetchArgs := append(append([]string{}, opts.ConfigArgs...), "fetch", "origin", branch)
		run(fetchArgs)
		if refreshed, ok := RemoteBranchSha(repoDir, branch); ok {
			if err := push("--force-with-lease=refs/heads/" + branch + ":" + refreshed); err == nil {
				return nil
			}
		}
	}
	return push("--force")
}

// IsNonFastForwardError reports a divergence rejection. Excludes the generic
// "failed to push some refs" summary, which git also prints for server-side hook
// and branch-protection rejections.
func IsNonFastForwardError(err error) bool {
	message := FormatGitError(err)
	return strings.Contains(message, "fetch first") ||
		strings.Contains(message, "non-fast-forward") ||
		strings.Contains(message, "[rejected]")
}
