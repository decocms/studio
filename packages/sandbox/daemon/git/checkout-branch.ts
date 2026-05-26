import { gitSync } from "./git-sync";

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
  /** Prefixed git command, e.g. `git -C /repo`. */
  gc: string;
  runStep: (cmd: string) => Promise<number>;
  log: (message: string) => void;
}

/**
 * Check out `branch` in an existing clone:
 * - remote branch → fetch + reset to origin
 * - local-only branch → checkout existing ref
 * - absent everywhere → fork from the repo default branch (not current HEAD)
 */
export async function spawnCheckoutBranch(
  params: CheckoutBranchParams,
): Promise<void> {
  const { repoDir, branch, gc, runStep, log } = params;

  try {
    const head = gitSync(["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: repoDir,
    }).trim();
    if (head === branch) return;
  } catch {
    // No HEAD yet / not a repo — fall through and let checkout fail loudly.
  }

  const probe = await runStep(
    `${gc} ls-remote --exit-code --heads origin ${branch}`,
  );

  if (probe === 0) {
    const fetchCode = await runStep(
      `${gc} fetch --depth 1 origin +refs/heads/${branch}:refs/remotes/origin/${branch}`,
    );
    if (fetchCode !== 0) {
      throw new Error(`git fetch origin ${branch} exited ${fetchCode}`);
    }
    const checkoutCode = await runStep(
      `${gc} checkout -B ${branch} refs/remotes/origin/${branch}`,
    );
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
      const code = await runStep(`${gc} checkout ${branch}`);
      if (code !== 0) throw new Error(`git checkout ${branch} exited ${code}`);
      return;
    }

    const defaultBranch = resolveRemoteDefaultBranch(repoDir);
    log(
      `[orchestrator] branch '${branch}' not on remote; creating from default branch '${defaultBranch}'\r\n`,
    );
    const fetchCode = await runStep(
      `${gc} fetch --depth 1 origin +refs/heads/${defaultBranch}:refs/remotes/origin/${defaultBranch}`,
    );
    if (fetchCode !== 0) {
      throw new Error(`git fetch origin ${defaultBranch} exited ${fetchCode}`);
    }
    const checkoutCode = await runStep(
      `${gc} checkout -B ${branch} refs/remotes/origin/${defaultBranch}`,
    );
    if (checkoutCode !== 0) {
      throw new Error(`git checkout -B ${branch} exited ${checkoutCode}`);
    }
    return;
  }

  throw new Error(`git ls-remote --heads origin ${branch} exited ${probe}`);
}
