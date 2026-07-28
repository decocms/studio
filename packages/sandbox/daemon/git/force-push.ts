/**
 * Shared force-push-with-lease used by both the publish reconcile path
 * (routes/git.ts) and rebase-onto-base.ts. Both run the same non-trivial
 * try-lease → refresh-on-stale → fall-back-to-force sequence; the only real
 * difference is the git executor (production runs as the deco user; the rebase
 * unit tests toggle that off) and the extra credential/hardening args the
 * publish path prepends — both expressed as parameters here.
 */

/**
 * The subset of a git executor this module needs: `run` throws on non-zero exit
 * (stderr in the Error message); `tryRun` swallows the failure and returns null.
 */
export interface GitRunner {
  run(
    repoDir: string,
    args: string[],
    opts?: { env?: Record<string, string> },
  ): string;
  tryRun(
    repoDir: string,
    args: string[],
    opts?: { env?: Record<string, string> },
  ): string | null;
}

function stripAnsi(text: string): string {
  const esc = String.fromCharCode(0x1b);
  return text.replace(new RegExp(`${esc}\\[[0-9;]*m`, "g"), "");
}

/** Current sha of origin/<branch> in the local clone, or null if absent. */
export function remoteBranchSha(
  git: GitRunner,
  repoDir: string,
  branch: string,
): string | null {
  return git.tryRun(repoDir, [
    "rev-parse",
    "--verify",
    `refs/remotes/origin/${branch}`,
  ]);
}

export interface ForcePushOptions {
  /** `-c key=value` pairs prefixed to every git invocation (credentials, safe.directory). */
  configArgs?: string[];
  /** Extra push flags, e.g. `--no-verify`. */
  pushArgs?: string[];
  /** Env applied to fetch and push (terminal-prompt / askpass hardening). */
  env?: Record<string, string>;
}

/**
 * Force-push <branch> to origin, preferring `--force-with-lease` over a plain
 * `--force`. The lease is NOT a concurrent-writer safeguard: it only guards the
 * window between `leaseSha` being observed and the push landing. On a stale-lease
 * rejection we re-fetch, re-lease against the NEW remote tip, and clobber it — so
 * this is safe only under the single-writer-per-branch invariant both callers
 * rely on. The lease just avoids a blind `--force` in the common case.
 *
 * `leaseSha` is the caller-observed origin/<branch> sha (captured before a slow
 * rebase, or right after a fetch); null falls straight through to `--force`.
 */
export function forcePushWithLease(
  git: GitRunner,
  repoDir: string,
  branch: string,
  leaseSha: string | null,
  opts: ForcePushOptions = {},
): void {
  const config = opts.configArgs ?? [];
  const extra = opts.pushArgs ?? [];
  const runOpts = opts.env ? { env: opts.env } : undefined;
  const pushWithLease = (sha: string) =>
    git.run(
      repoDir,
      [
        ...config,
        "push",
        ...extra,
        `--force-with-lease=refs/heads/${branch}:${sha}`,
        "origin",
        branch,
      ],
      runOpts,
    );

  if (leaseSha) {
    try {
      pushWithLease(leaseSha);
      return;
    } catch (err) {
      // A racing writer moved origin/<branch> between the lease capture and the
      // push, so the lease is stale. Re-fetch, refresh the lease, and retry once.
      const message = stripAnsi(
        err instanceof Error ? err.message : String(err),
      );
      const retriable =
        message.includes("stale info") ||
        message.includes("failed to push some refs");
      if (!retriable) {
        throw err;
      }
      git.run(repoDir, [...config, "fetch", "origin", branch], runOpts);
      const refreshed = remoteBranchSha(git, repoDir, branch);
      if (refreshed) {
        pushWithLease(refreshed);
        return;
      }
    }
  }
  // No remote-tracking ref to lease against (branch deleted, or the fetch found
  // nothing): fall back to a plain force.
  git.run(
    repoDir,
    [...config, "push", ...extra, "--force", "origin", branch],
    runOpts,
  );
}
