import fs, { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gitSync as rawGitSync } from "./git-sync";
import { parsePorcelainEntry } from "./porcelain";

const MAX_CONFLICT_RESOLUTION_ATTEMPTS = 50;

const gitSync = (args: string[], opts: Parameters<typeof rawGitSync>[1]) =>
  rawGitSync(["-c", "safe.directory=*", ...args], opts);

function gitEnv(repoDir: string): Record<string, string> {
  return { ...process.env, GIT_CEILING_DIRECTORIES: repoDir };
}

function runGit(
  repoDir: string,
  args: string[],
  opts?: { env?: Record<string, string> },
): string {
  return gitSync(args, {
    cwd: repoDir,
    env: { ...gitEnv(repoDir), ...opts?.env },
  });
}

function tryGit(
  repoDir: string,
  args: string[],
  opts?: { env?: Record<string, string> },
): string | null {
  try {
    return runGit(repoDir, args, opts);
  } catch {
    return null;
  }
}

function stripAnsi(text: string): string {
  const esc = String.fromCharCode(0x1b);
  return text.replace(new RegExp(`${esc}\\[[0-9;]*m`, "g"), "");
}

function formatGitError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return stripAnsi(message);
}

function isRebaseInProgress(repoDir: string): boolean {
  return (
    fs.existsSync(path.join(repoDir, ".git", "rebase-merge")) ||
    fs.existsSync(path.join(repoDir, ".git", "rebase-apply"))
  );
}

interface StatusFile {
  path: string;
  index: string;
  working_dir: string;
}

function readStatusFiles(repoDir: string): StatusFile[] {
  const porcelain = runGit(repoDir, ["status", "--porcelain=v1", "-z"]);
  const files: StatusFile[] = [];
  const parts = porcelain.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (!entry) continue;
    const parsed = parsePorcelainEntry(entry);
    if (!parsed) continue;
    files.push({
      path: parsed.path,
      index: parsed.index,
      working_dir: parsed.working,
    });
    if (parsed.index === "R" || parsed.index === "C") {
      i++;
    }
  }
  return files;
}

function getConflictedFiles(repoDir: string): string[] {
  return readStatusFiles(repoDir)
    .filter((f) => `${f.index}${f.working_dir}`.includes("U"))
    .map((f) => f.path);
}

function abortRebase(repoDir: string): void {
  if (isRebaseInProgress(repoDir)) {
    tryGit(repoDir, ["rebase", "--abort"]);
  }
}

let emptyHooksDir: string | null = null;
function getEmptyHooksDir(): string {
  if (!emptyHooksDir) {
    emptyHooksDir = mkdtempSync(path.join(tmpdir(), "mesh-sandbox-no-hooks-"));
  }
  return emptyHooksDir;
}

const SKIP_HOOKS_ENV: Record<string, string> = {
  LEFTHOOK: "0",
  HUSKY: "0",
};

const NON_INTERACTIVE_ENV: Record<string, string> = {
  GIT_EDITOR: "true",
  EDITOR: "true",
};

function commitBeforeRebase(repoDir: string): void {
  const porcelain = tryGit(repoDir, ["status", "--porcelain"]);
  if (!porcelain?.trim()) return;

  runGit(repoDir, ["add", "."]);
  runGit(
    repoDir,
    [
      "-c",
      `core.hooksPath=${getEmptyHooksDir()}`,
      "commit",
      "--no-verify",
      "-m",
      "Before rebase",
    ],
    { env: SKIP_HOOKS_ENV },
  );
}

function resolveConflictFile(repoDir: string, summary: StatusFile): void {
  const filePath = summary.path;
  if (
    summary.working_dir === "D" &&
    !`${summary.index}${summary.working_dir}`.includes("U")
  ) {
    runGit(repoDir, ["rm", "-f", filePath]);
    return;
  }

  // During rebase, `--theirs` is the commit being replayed (branch changes).
  tryGit(repoDir, ["checkout", "--theirs", "--", filePath]);
  runGit(repoDir, ["add", "--", filePath]);
}

function continueRebase(repoDir: string): void {
  const env = NON_INTERACTIVE_ENV;
  try {
    runGit(repoDir, ["rebase", "--continue"], { env });
  } catch (err) {
    const message = formatGitError(err);
    if (!message.includes("staged changes in your working tree")) {
      throw err;
    }

    runGit(
      repoDir,
      [
        "-c",
        `core.hooksPath=${getEmptyHooksDir()}`,
        "commit",
        "--no-edit",
        "--no-verify",
      ],
      { env: { ...env, ...SKIP_HOOKS_ENV } },
    );

    if (isRebaseInProgress(repoDir)) {
      runGit(repoDir, ["rebase", "--continue"], { env });
    }
  }
}

function resolveConflictsRecursively(
  repoDir: string,
  wip = MAX_CONFLICT_RESOLUTION_ATTEMPTS,
): void {
  if (wip <= 0) {
    abortRebase(repoDir);
    throw new Error("Rebase conflict resolution exceeded maximum attempts");
  }

  const files = readStatusFiles(repoDir);
  const conflicted = files.filter((f) =>
    `${f.index}${f.working_dir}`.includes("U"),
  );

  for (const summary of conflicted) {
    resolveConflictFile(repoDir, summary);
  }

  if (getConflictedFiles(repoDir).length !== 0) {
    abortRebase(repoDir);
    throw new Error("Unresolved rebase conflicts remain");
  }

  try {
    continueRebase(repoDir);
  } catch (err) {
    const message = formatGitError(err);
    if (
      !message.includes("CONFLICT") &&
      getConflictedFiles(repoDir).length === 0 &&
      !isRebaseInProgress(repoDir)
    ) {
      abortRebase(repoDir);
      throw err;
    }
    resolveConflictsRecursively(repoDir, wip - 1);
  }
}

function remoteBranchSha(repoDir: string, branch: string): string | null {
  return tryGit(repoDir, [
    "rev-parse",
    "--verify",
    `refs/remotes/origin/${branch}`,
  ]);
}

function forcePushRebasedBranch(
  repoDir: string,
  branch: string,
  leaseSha: string | null,
): void {
  if (leaseSha) {
    const leaseRef = `refs/heads/${branch}:${leaseSha}`;
    try {
      runGit(repoDir, [
        "push",
        `--force-with-lease=${leaseRef}`,
        "origin",
        branch,
      ]);
      return;
    } catch (err) {
      const message = formatGitError(err);
      const retriable =
        message.includes("stale info") ||
        message.includes("failed to push some refs");
      if (!retriable) {
        throw err;
      }

      runGit(repoDir, ["fetch", "origin", branch]);
      const refreshed = remoteBranchSha(repoDir, branch);
      if (refreshed) {
        runGit(repoDir, [
          "push",
          `--force-with-lease=refs/heads/${branch}:${refreshed}`,
          "origin",
          branch,
        ]);
        return;
      }
    }
  }

  runGit(repoDir, ["push", "--force", "origin", branch]);
}

/**
 * Rebase the current branch onto `origin/{base}` using the legacy deco CMS
 * strategy: prefer branch changes on conflict (`-X theirs`), auto-resolve
 * remaining conflicts, then force-push.
 */
export function rebaseOntoBase(
  repoDir: string,
  base: string,
): { rebased: boolean } {
  const branch = runGit(repoDir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!branch || branch === "HEAD") {
    throw new Error("Cannot rebase from a detached HEAD");
  }

  runGit(repoDir, ["fetch", "-p", "origin", base, branch]);
  const leaseSha = remoteBranchSha(repoDir, branch);

  tryGit(repoDir, [
    "submodule",
    "update",
    "--init",
    "--recursive",
    "--depth",
    "1",
  ]);

  const upstream = `origin/${base}`;
  if (tryGit(repoDir, ["rev-parse", "--verify", upstream]) === null) {
    throw new Error(`Base branch '${base}' not found on origin`);
  }

  commitBeforeRebase(repoDir);

  try {
    runGit(repoDir, ["rebase", "-X", "theirs", upstream]);
  } catch (err) {
    if (!isRebaseInProgress(repoDir)) {
      throw err;
    }
    resolveConflictsRecursively(repoDir);
  }

  if (isRebaseInProgress(repoDir)) {
    abortRebase(repoDir);
    throw new Error("Rebase did not complete");
  }

  forcePushRebasedBranch(repoDir, branch, leaseSha);
  return { rebased: true };
}
