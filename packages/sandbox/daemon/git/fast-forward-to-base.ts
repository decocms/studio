import { gitAsync } from "./git-async";
import { protectedBranches } from "./protect-branch";

/**
 * Why a fast-forward did NOT happen. Every value is an expected, benign
 * condition — never an error the caller must surface.
 */
export type FastForwardSkipReason =
  | "detached-head"
  | "protected-branch"
  | "base-unavailable"
  | "diverged"
  | "up-to-date"
  | "blocked";

export interface FastForwardResult {
  fastForwarded: boolean;
  base: string;
  branch: string | null;
  aheadOfBase: number;
  behindBase: number;
  /** Whether the fast-forwarded HEAD was pushed to `origin/<branch>`. */
  pushed: boolean;
  skipped?: FastForwardSkipReason;
}

export interface FastForwardOptions {
  /** Production daemon drops to the deco user; tests run git as current user. */
  asUser?: boolean;
}

/**
 * Advance the current branch to `origin/<base>` by pure fast-forward, then
 * push, when the branch is CLEAN OF LOCAL COMMITS (`aheadOfBase === 0`) and
 * merely behind base. This is the "idle sandbox, no changes" case: the user
 * opened a sandbox, never committed, and base moved on while it sat idle — so
 * a re-clone shows stale content. Fast-forward is conflict-free by
 * construction (no history rewrite, no force-push), which is why it can run
 * unattended on boot; anything with local commits (`aheadOfBase > 0`) is left
 * for the manual, conflict-resolving `rebaseOntoBase` path.
 *
 * Best-effort and non-throwing for every expected condition (detached HEAD,
 * protected branch, offline, diverged, up-to-date, or a dirty working tree
 * that would block the ff-only merge) — it returns a `skipped` reason instead,
 * so a caller on the boot path never has to guard it. Uses {@link gitAsync}
 * throughout so it never blocks the daemon's single event loop.
 */
export async function fastForwardToBase(
  repoDir: string,
  options?: FastForwardOptions,
): Promise<FastForwardResult> {
  const asUser = options?.asUser ?? true;
  const env = { ...process.env, GIT_CEILING_DIRECTORIES: repoDir };
  const run = (args: string[]) =>
    gitAsync(["-c", "safe.directory=*", ...args], {
      cwd: repoDir,
      env,
      asUser,
    });
  const tryRun = async (args: string[]): Promise<string | null> => {
    try {
      return await run(args);
    } catch {
      return null;
    }
  };

  let base =
    (await tryRun(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])) ??
    "";
  if (base.startsWith("origin/")) base = base.slice("origin/".length);
  if (!base) base = "main";

  const branch = await tryRun(["rev-parse", "--abbrev-ref", "HEAD"]);

  const skip = (
    reason: FastForwardSkipReason,
    fields?: Partial<FastForwardResult>,
  ): FastForwardResult => ({
    fastForwarded: false,
    base,
    branch: branch ?? null,
    aheadOfBase: 0,
    behindBase: 0,
    pushed: false,
    skipped: reason,
    ...fields,
  });

  if (!branch || branch === "HEAD") return skip("detached-head");
  // Same guard as rebaseOntoBase/publish: a sandbox on main/master/default must
  // never auto-push. Fast-forward wouldn't force-push, but a sandbox is never
  // meant to advance a protected branch unattended.
  if (protectedBranches(repoDir).has(branch)) return skip("protected-branch");

  // Fetch base ourselves: the boot's base fetch is fired detached (off the
  // critical path in stepClone) and may not have landed yet. Prune so a base
  // deleted on origin surfaces as base-unavailable below rather than a stale
  // ref that silently fast-forwards to a dead commit.
  await tryRun(["fetch", "-p", "origin", base]);

  const upstream = `origin/${base}`;
  if ((await tryRun(["rev-parse", "--verify", "--quiet", upstream])) === null) {
    return skip("base-unavailable");
  }

  const lr = await tryRun([
    "rev-list",
    "--left-right",
    "--count",
    `${upstream}...HEAD`,
  ]);
  const m = lr?.match(/^(\d+)\s+(\d+)$/);
  const behindBase = m ? Number(m[1]) : 0;
  const aheadOfBase = m ? Number(m[2]) : 0;

  // Local commits present → this is not "no changes". Leave it for the manual
  // rebase button, which resolves conflicts and force-pushes deliberately.
  if (aheadOfBase > 0) return skip("diverged", { aheadOfBase, behindBase });
  if (behindBase === 0) return skip("up-to-date", { aheadOfBase, behindBase });

  // Pure fast-forward: no new commit, no history rewrite. `--ff-only` refuses
  // (leaving the tree untouched) if uncommitted local edits would be
  // overwritten — treat that as a benign skip, not a failure.
  if ((await tryRun(["merge", "--ff-only", upstream])) === null) {
    return skip("blocked", { aheadOfBase, behindBase });
  }

  // Best-effort NON-force push so origin/<branch> (and any open PR) advances,
  // and the next evict→re-clone starts fresh instead of stale again. Because
  // aheadOfBase was 0, the new HEAD is a descendant of the old origin/<branch>,
  // so this is itself a fast-forward push — it can never clobber. A
  // non-fast-forward rejection (someone else pushed) is expected: skip it, the
  // local fast-forward stands.
  const pushed =
    (await tryRun(["push", "origin", `HEAD:refs/heads/${branch}`])) !== null;

  return {
    fastForwarded: true,
    base,
    branch,
    aheadOfBase,
    behindBase,
    pushed,
  };
}
