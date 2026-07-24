import { gitSync } from "./git-sync";
import { assertValidRemoteBranchName } from "./ref-name";

/** Base branch all sandbox work is created from and published back to. */
export const SANDBOX_BASE_BRANCH = "main";

/** Default branch pointed to by `origin/HEAD`, falling back to `main`. */
export function resolveRemoteDefaultBranch(repoDir: string): string {
  try {
    let base = gitSync(
      ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
      {
        cwd: repoDir,
      },
    ).trim();
    if (base.startsWith("origin/")) base = base.slice("origin/".length);
    if (base) return base;
  } catch {
    /* fall through */
  }
  return "main";
}

function localBranchExists(repoDir: string, branch: string): boolean {
  try {
    gitSync(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
      cwd: repoDir,
    });
    return true;
  } catch {
    return false;
  }
}

export interface CheckoutBranchParams {
  repoDir: string;
  branch: string;
  runGit: (args: readonly string[]) => Promise<number>;
  log: (message: string) => void;
}

/**
 * Check out `branch` in an existing clone:
 * - remote branch → fetch + reset to origin
 * - local-only branch → checkout existing ref
 * - absent everywhere → fork from `origin/main` (not current HEAD)
 */
export async function spawnCheckoutBranch(
  params: CheckoutBranchParams,
): Promise<void> {
  const { repoDir, branch, runGit, log } = params;

  // `branch` flows into git argv below (ls-remote, fetch, checkout) — argv
  // form means no shell interprets it, but a value starting with `-` could
  // still be misread as a flag, so it still needs validation before ever
  // reaching a git invocation.
  assertValidRemoteBranchName(branch);

  try {
    const head = gitSync(["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: repoDir,
    }).trim();
    if (head === branch) return;
  } catch {
    // No HEAD yet / not a repo — fall through and let checkout fail loudly.
  }

  const probe = await runGit([
    "ls-remote",
    "--exit-code",
    "--heads",
    "origin",
    branch,
  ]);

  if (probe === 0) {
    const fetchCode = await runGit([
      "fetch",
      "--depth",
      "1",
      "origin",
      `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
    ]);
    if (fetchCode !== 0) {
      throw new Error(`git fetch origin ${branch} exited ${fetchCode}`);
    }
    const checkoutCode = await runGit([
      "checkout",
      "-B",
      branch,
      `refs/remotes/origin/${branch}`,
    ]);
    if (checkoutCode !== 0) {
      throw new Error(`git checkout -B ${branch} exited ${checkoutCode}`);
    }
    return;
  }

  if (probe === 2) {
    if (localBranchExists(repoDir, branch)) {
      log(
        `[orchestrator] branch '${branch}' not on remote; checking out local branch\r\n`,
      );
      const code = await runGit(["checkout", branch]);
      if (code !== 0) throw new Error(`git checkout ${branch} exited ${code}`);
      return;
    }

    log(
      `[orchestrator] branch '${branch}' not on remote; creating from base branch '${SANDBOX_BASE_BRANCH}'\r\n`,
    );
    const fetchCode = await runGit([
      "fetch",
      "--depth",
      "1",
      "origin",
      `+refs/heads/${SANDBOX_BASE_BRANCH}:refs/remotes/origin/${SANDBOX_BASE_BRANCH}`,
    ]);
    if (fetchCode !== 0) {
      throw new Error(
        `git fetch origin ${SANDBOX_BASE_BRANCH} exited ${fetchCode}`,
      );
    }
    const checkoutCode = await runGit([
      "checkout",
      "-B",
      branch,
      `refs/remotes/origin/${SANDBOX_BASE_BRANCH}`,
    ]);
    if (checkoutCode !== 0) {
      throw new Error(`git checkout -B ${branch} exited ${checkoutCode}`);
    }
    return;
  }

  throw new Error(`git ls-remote --heads origin ${branch} exited ${probe}`);
}
