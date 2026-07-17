import fs, { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { appendCoAuthorTrailer } from "../../git-co-author";
import { gitSync as rawGitSync } from "./git-sync";
import { parsePorcelainEntry } from "./porcelain";
import { assertValidRemoteBranchName } from "./ref-name";
import type { OperatorIdentity } from "../types";

const MAX_CONFLICT_RESOLUTION_ATTEMPTS = 50;

const gitSync = (args: string[], opts: Parameters<typeof rawGitSync>[1]) =>
  rawGitSync(["-c", "safe.directory=*", ...args], opts);

/** Production daemon drops to deco user; unit tests run git as the current user. */
let rebaseGitAsUser = true;

export interface RebaseOntoBaseOptions {
  asUser?: boolean;
  operator?: OperatorIdentity;
}

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
    asUser: rebaseGitAsUser,
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

function commitBeforeRebase(
  repoDir: string,
  operator?: OperatorIdentity,
): void {
  const porcelain = tryGit(repoDir, ["status", "--porcelain"]);
  if (!porcelain?.trim()) return;

  runGit(repoDir, ["add", "."]);
  runGit(
    repoDir,
    [
      "-c",
      `core.hooksPath=${getEmptyHooksDir()}`,
      "commit",
      // --no-verify: see publish() in routes/git.ts — removing it means surfacing
      // hook failures clearly in the publish UI instead of opaque daemon errors.
      "--no-verify",
      "-m",
      appendCoAuthorTrailer("Before rebase", operator),
    ],
    { env: SKIP_HOOKS_ENV },
  );
}

function resolveConflictFile(repoDir: string, summary: StatusFile): void {
  const filePath = summary.path;
  const xy = `${summary.index}${summary.working_dir}`;
  const abs = path.join(repoDir, filePath);

  // modify/delete during rebase: keep the replayed commit version when present.
  if (
    xy.includes("U") &&
    (summary.index === "D" || summary.working_dir === "D")
  ) {
    if (fs.existsSync(abs)) {
      runGit(repoDir, ["add", "--", filePath]);
      return;
    }
    runGit(repoDir, ["rm", "-f", "--", filePath]);
    return;
  }

  if (summary.working_dir === "D" && !xy.includes("U")) {
    runGit(repoDir, ["rm", "-f", filePath]);
    return;
  }

  // During rebase, `--theirs` is the commit being replayed (branch changes).
  runGit(repoDir, ["checkout", "--theirs", "--", filePath]);
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
        // --no-verify: see publish() in routes/git.ts — removing it means surfacing
        // hook failures clearly in the publish UI instead of opaque daemon errors.
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
    const remaining = getConflictedFiles(repoDir);
    if (
      !message.includes("CONFLICT") &&
      remaining.length === 0 &&
      !isRebaseInProgress(repoDir)
    ) {
      abortRebase(repoDir);
      throw err;
    }
    if (remaining.length === 0) {
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

      runGit(repoDir, [
        "fetch",
        "origin",
        `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
      ]);
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
  options?: RebaseOntoBaseOptions,
): { rebased: boolean } {
  const previousAsUser = rebaseGitAsUser;
  rebaseGitAsUser = options?.asUser ?? true;
  try {
    return rebaseOntoBaseInner(repoDir, base, options?.operator);
  } finally {
    rebaseGitAsUser = previousAsUser;
  }
}

function rebaseOntoBaseInner(
  repoDir: string,
  base: string,
  operator?: OperatorIdentity,
): { rebased: boolean } {
  assertValidRemoteBranchName(base);

  const branch = runGit(repoDir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!branch || branch === "HEAD") {
    throw new Error("Cannot rebase from a detached HEAD");
  }

  // Explicit refspecs for the same reason as integrateRemoteBranch below:
  // shallow single-branch clones don't map plain command-line refnames onto
  // refs/remotes/origin/*, which would leave the force-push lease stale.
  runGit(repoDir, [
    "fetch",
    "-p",
    "origin",
    `+refs/heads/${base}:refs/remotes/origin/${base}`,
    `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
  ]);
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

  commitBeforeRebase(repoDir, operator);
  performRebase(repoDir, upstream);

  forcePushRebasedBranch(repoDir, branch, leaseSha);
  return { rebased: true };
}

function performRebase(repoDir: string, upstreamRef: string): void {
  try {
    // --autostash: the sandbox dev server keeps regenerating tracked files
    // (e.g. src/server/cms/blocks.gen.json, .deco/blocks/*.json). It can dirty
    // the working tree in the window between the pre-rebase commit and the
    // rebase's internal checkout, which otherwise aborts with "Your local
    // changes would be overwritten by checkout / could not detach HEAD".
    // Autostash stashes that churn, runs the rebase, and restores it afterwards.
    runGit(repoDir, ["rebase", "--autostash", "-X", "theirs", upstreamRef]);
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
}

/**
 * Integrate commits already on `origin/{branch}` into the local branch by
 * replaying local commits on top — same conflict strategy as rebaseOntoBase
 * (`-X theirs` + auto-resolution, so the latest local save wins). Used by
 * publish() before pushing: when another session pushed to the same branch,
 * a blind push is rejected as non-fast-forward and the save fails.
 *
 * No-op when the remote branch is missing (first publish) or already an
 * ancestor of HEAD. A failed fetch is also a no-op — the subsequent push
 * surfaces the real error.
 */
export function integrateRemoteBranch(
  repoDir: string,
  branch: string,
  options?: RebaseOntoBaseOptions,
): { rebased: boolean } {
  const previousAsUser = rebaseGitAsUser;
  rebaseGitAsUser = options?.asUser ?? true;
  try {
    return integrateRemoteBranchInner(repoDir, branch, options?.operator);
  } finally {
    rebaseGitAsUser = previousAsUser;
  }
}

function integrateRemoteBranchInner(
  repoDir: string,
  branch: string,
  operator?: OperatorIdentity,
): { rebased: boolean } {
  assertValidRemoteBranchName(branch);

  // Explicit refspec, not `fetch origin <branch>`: sandbox clones are shallow
  // single-branch (setup/clone.ts), so their fetch refspec only covers the
  // branch they were cloned on. For a workspace branch forked locally that's
  // the *default* branch — a plain fetch would only write FETCH_HEAD, leave
  // refs/remotes/origin/<branch> missing/stale, and the divergence check below
  // would report a false "up to date" (the exact non-fast-forward publish
  // failure this function exists to prevent). Fails when the branch isn't on
  // origin yet (first publish) — that's the no-op path.
  const fetched = tryGit(repoDir, [
    "fetch",
    "origin",
    `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
  ]);
  if (fetched === null) {
    return { rebased: false };
  }
  const remoteSha = remoteBranchSha(repoDir, branch);
  if (!remoteSha) {
    return { rebased: false };
  }
  const upToDate =
    tryGit(repoDir, ["merge-base", "--is-ancestor", remoteSha, "HEAD"]) !==
    null;
  if (upToDate) {
    return { rebased: false };
  }

  commitBeforeRebase(repoDir, operator);
  performRebase(repoDir, `origin/${branch}`);
  return { rebased: true };
}
