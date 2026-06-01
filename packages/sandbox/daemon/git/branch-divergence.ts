import { git } from "../setup/git";

export interface BranchDivergenceFields {
  base: string;
  aheadOfBase: number;
  behindBase: number;
  headSha: string;
  /** Commits on HEAD not on `origin/<current branch>`. */
  unpushed: number;
}

function gitEnv(repoDir: string): Record<string, string> {
  return { ...process.env, GIT_CEILING_DIRECTORIES: repoDir };
}

function runGit(repoDir: string, args: string[]): string {
  return git(args, { cwd: repoDir, env: gitEnv(repoDir) });
}

function tryGit(repoDir: string, args: string[]): string | null {
  try {
    return runGit(repoDir, args);
  } catch {
    return null;
  }
}

/** Divergence vs default base branch — same rules as BranchStatusMonitor. */
export function computeBranchDivergence(
  repoDir: string,
): BranchDivergenceFields {
  let base =
    tryGit(repoDir, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]) ??
    "";
  if (base.startsWith("origin/")) base = base.slice("origin/".length);
  if (!base) base = "main";

  const branch = tryGit(repoDir, ["rev-parse", "--abbrev-ref", "HEAD"]) ?? "";
  const refExists = (ref: string) =>
    tryGit(repoDir, ["rev-parse", "--verify", "--quiet", ref]) !== null;

  const branchRef =
    branch && refExists(`origin/${branch}`) ? `origin/${branch}` : "HEAD";

  let unpushed = 0;
  if (branch && branchRef === `origin/${branch}`) {
    unpushed = Number(
      tryGit(repoDir, ["rev-list", "--count", `${branchRef}..HEAD`]) ?? "0",
    );
  }

  let aheadOfBase = 0;
  let behindBase = 0;
  if (refExists(`origin/${base}`)) {
    const lr = tryGit(repoDir, [
      "rev-list",
      "--left-right",
      "--count",
      `origin/${base}...${branchRef}`,
    ]);
    const m = lr?.match(/^(\d+)\s+(\d+)$/);
    if (m) {
      behindBase = Number(m[1]);
      aheadOfBase = Number(m[2]);
    }
  }

  const headSha = tryGit(repoDir, ["rev-parse", branchRef]) ?? "";

  return { base, aheadOfBase, behindBase, headSha, unpushed };
}
