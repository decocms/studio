import fs, { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { computeBranchDivergence } from "../git/branch-divergence";
import { parsePorcelainFiles } from "../git/porcelain";
import { rebaseOntoBase } from "../git/rebase-onto-base";
import {
  assertValidRemoteBranchName,
  InvalidRemoteBranchNameError,
} from "../git/ref-name";
import { safePath } from "../paths";
import { git } from "../setup/git";
import { jsonResponse, parseJsonBody } from "./body-parser";

export interface GitDeps {
  appRoot: string;
  repoDir: string;
}

function gitEnv(repoDir: string): Record<string, string> {
  return { ...process.env, GIT_CEILING_DIRECTORIES: repoDir };
}

function runGit(
  repoDir: string,
  args: string[],
  opts?: { env?: Record<string, string> },
): string {
  return git(args, {
    cwd: repoDir,
    env: { ...gitEnv(repoDir), ...opts?.env },
  });
}

function tryGit(repoDir: string, args: string[]): string | null {
  try {
    return runGit(repoDir, args);
  } catch {
    return null;
  }
}

export interface GitStatusFile {
  path: string;
  index: string;
  working_dir: string;
}

export interface GitStatusResult {
  not_added: string[];
  conflicted: string[];
  created: string[];
  deleted: string[];
  modified: string[];
  renamed: unknown[];
  files: GitStatusFile[];
  staged: string[];
  ahead: number;
  behind: number;
  current: string | null;
  tracking: string | null;
  detached: boolean;
  /** Default branch (e.g. main) from origin/HEAD. */
  base: string;
  /** Commits on branch not in origin/<base>. */
  aheadOfBase: number;
  /** Commits in origin/<base> not in branch. */
  behindBase: number;
  /** Resolved ref for divergence (origin/<branch> or HEAD). */
  headSha: string;
  /** Commits on HEAD not in origin/<current branch>. */
  unpushed: number;
}

export interface GitDiffEntry {
  from: string | null;
  to: string | null;
}

export interface GitDiffResult {
  diffs: Record<string, GitDiffEntry>;
  /** Present when diffing against a base branch (merge-base of base and head). */
  mergeBaseSha?: string;
}

/** Porcelain + upstream tracking only — no base-branch divergence (expensive). */
function computeWorkingTreeStatus(
  repoDir: string,
): Omit<
  GitStatusResult,
  "base" | "aheadOfBase" | "behindBase" | "headSha" | "unpushed"
> {
  const porcelain = runGit(repoDir, ["status", "--porcelain=v1", "-z"]);
  const files: GitStatusFile[] = parsePorcelainFiles(porcelain);

  const not_added: string[] = [];
  const conflicted: string[] = [];
  const created: string[] = [];
  const deleted: string[] = [];
  const modified: string[] = [];
  const renamed: unknown[] = [];
  const staged: string[] = [];

  for (const f of files) {
    const xy = `${f.index}${f.working_dir}`;
    if (xy.includes("U")) conflicted.push(f.path);
    if (f.index === "?" && f.working_dir === "?") not_added.push(f.path);
    else if (f.index === "A" || f.working_dir === "A") created.push(f.path);
    else if (f.index === "D" || f.working_dir === "D") deleted.push(f.path);
    else if (f.index === "R" || f.working_dir === "R") renamed.push(f.path);
    else modified.push(f.path);
    if (f.index !== " " && f.index !== "?") staged.push(f.path);
  }

  const branch = tryGit(repoDir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const detached = branch === "HEAD";
  const tracking = tryGit(repoDir, [
    "rev-parse",
    "--abbrev-ref",
    "--symbolic-full-name",
    "@{u}",
  ]);

  let ahead = 0;
  let behind = 0;
  if (tracking && !detached) {
    const counts = tryGit(repoDir, [
      "rev-list",
      "--left-right",
      "--count",
      "@{upstream}...HEAD",
    ]);
    const m = counts?.match(/^(\d+)\s+(\d+)$/);
    if (m) {
      behind = Number(m[1]);
      ahead = Number(m[2]);
    }
  }

  return {
    not_added,
    conflicted,
    created,
    deleted,
    modified,
    renamed,
    files,
    staged,
    ahead,
    behind,
    current: branch,
    tracking,
    detached,
  };
}

function computeStatus(repoDir: string): GitStatusResult {
  const working = computeWorkingTreeStatus(repoDir);
  const divergence = computeBranchDivergence(repoDir);
  return { ...working, ...divergence };
}

function readWorkingFile(repoDir: string, filePath: string): string | null {
  const abs = path.join(repoDir, filePath);
  try {
    return fs.readFileSync(abs, "utf8");
  } catch {
    return null;
  }
}

function readRefFile(
  repoDir: string,
  ref: string,
  filePath: string,
): string | null {
  return tryGit(repoDir, ["show", `${ref}:${filePath}`]);
}

function computeDiff(repoDir: string): GitDiffResult {
  const status = computeWorkingTreeStatus(repoDir);
  const paths = [
    ...new Set(status.files.map((f) => f.path).filter((p) => p.length > 0)),
  ];

  const diffs: Record<string, GitDiffEntry> = {};
  for (const filePath of paths) {
    const file = status.files.find((f) => f.path === filePath);
    const index = file?.index ?? " ";
    const working = file?.working_dir ?? " ";
    const isDeleted = index === "D" || working === "D";
    const isNew =
      (index === "?" && working === "?") ||
      index === "A" ||
      working === "A" ||
      (!readRefFile(repoDir, "HEAD", filePath) && !isDeleted);

    diffs[filePath] = {
      from: isNew ? null : readRefFile(repoDir, "HEAD", filePath),
      to: isDeleted ? null : readWorkingFile(repoDir, filePath),
    };
  }

  return { diffs };
}

/** Committed changes on HEAD since branching from `origin/{base}` (PR scope). */
export function computeDiffAgainstBase(
  repoDir: string,
  base: string,
  headSha?: string,
): GitDiffResult {
  assertValidRemoteBranchName(base);

  const branch = tryGit(repoDir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!branch || branch === "HEAD") {
    throw new Error("Cannot compute PR diff from detached HEAD");
  }
  assertValidRemoteBranchName(branch);

  // Shallow clones often miss one side of the fork — fetch both tips with depth.
  try {
    runGit(repoDir, ["fetch", "--depth", "100", "origin", base, branch]);
  } catch {
    // Local-only fixtures / offline sandboxes may already have the refs we need.
  }
  if (headSha && /^[0-9a-f]{40}$/i.test(headSha)) {
    tryGit(repoDir, ["fetch", "--depth", "100", "origin", headSha]);
  }

  const upstream = `origin/${base}`;
  if (!tryGit(repoDir, ["rev-parse", "--verify", upstream])) {
    throw new Error(`Base branch '${base}' not found on origin`);
  }

  const remoteHead = `origin/${branch}`;
  let headRef = "HEAD";
  if (
    headSha &&
    tryGit(repoDir, ["rev-parse", "--verify", `${headSha}^{commit}`]) !== null
  ) {
    headRef = headSha;
  } else if (tryGit(repoDir, ["rev-parse", "--verify", remoteHead])) {
    headRef = remoteHead;
  }

  let paths = listThreeDotDiffPaths(repoDir, upstream, headRef);

  if (paths.length === 0) {
    try {
      runGit(repoDir, ["fetch", "--deepen", "500", "origin", base, branch]);
    } catch {
      /* see fetch note above */
    }
    paths = listThreeDotDiffPaths(repoDir, upstream, headRef);
  }

  const mergeBase =
    tryGit(repoDir, ["merge-base", upstream, headRef]) ?? upstream;

  const diffs: Record<string, GitDiffEntry> = {};
  for (const filePath of paths) {
    diffs[filePath] = {
      from: readRefFile(repoDir, mergeBase, filePath),
      to: readRefFile(repoDir, headRef, filePath),
    };
  }

  return { diffs, mergeBaseSha: mergeBase.trim() };
}

function listThreeDotDiffPaths(
  repoDir: string,
  leftRef: string,
  rightRef: string,
): string[] {
  const namesOutput = tryGit(repoDir, [
    "diff",
    "--name-only",
    "-z",
    `${leftRef}...${rightRef}`,
  ]);
  return namesOutput ? namesOutput.split("\0").filter(Boolean) : [];
}

function stripAnsi(text: string): string {
  const esc = String.fromCharCode(0x1b);
  return text.replace(new RegExp(`${esc}\\[[0-9;]*m`, "g"), "");
}

function formatGitError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return stripAnsi(message);
}

/** Empty dir passed as core.hooksPath so publish commits never run lefthook/husky. */
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

function changedPathsFromStatus(status: { files: GitStatusFile[] }): string[] {
  return [
    ...new Set(status.files.map((f) => f.path).filter((p) => p.length > 0)),
  ];
}

function resolveRepoRelativePath(deps: GitDeps, userPath: string): string {
  const abs = safePath(deps.appRoot, deps.repoDir, userPath);
  if (!abs) {
    throw new Error(`Invalid path: ${userPath}`);
  }
  const rel = path.relative(deps.repoDir, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Invalid path: ${userPath}`);
  }
  return rel;
}

function publish(deps: GitDeps, message: string): { pushed: boolean } {
  const repoDir = deps.repoDir;
  const branch = runGit(repoDir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!branch || branch === "HEAD") {
    throw new Error("Cannot publish from a detached HEAD");
  }

  const status = computeWorkingTreeStatus(repoDir);
  const paths = changedPathsFromStatus(status);
  if (paths.length > 0) {
    runGit(repoDir, ["add", "--", ...paths]);
  }
  const hasStagedChanges =
    tryGit(repoDir, ["diff", "--cached", "--quiet"]) === null;
  if (hasStagedChanges) {
    const commitMsg =
      message.trim().length > 0 ? message.trim() : "Update from sandbox";
    // Sandbox repos often ship lefthook/husky hooks (deno fmt, lint, check)
    // that need a full dev toolchain + network. Push still runs normal hooks
    // (e.g. pre-push branch protection); only this commit skips them.
    // --no-verify: we may want to run hooks here eventually, but removing it
    // requires surfacing hook failures clearly in the publish UI (which step
    // failed, logs, retry) instead of a generic daemon 500.
    runGit(
      repoDir,
      [
        "-c",
        `core.hooksPath=${getEmptyHooksDir()}`,
        "commit",
        "--no-verify",
        "-m",
        commitMsg,
      ],
      { env: SKIP_HOOKS_ENV },
    );
  }

  runGit(repoDir, ["push", "origin", branch]);
  return { pushed: true };
}

function discard(deps: GitDeps, filepaths: string[]): void {
  const repoDir = deps.repoDir;
  const validated = filepaths.map((fp) => resolveRepoRelativePath(deps, fp));
  const status = computeWorkingTreeStatus(repoDir);
  const toRestore: string[] = [];
  const toDelete: string[] = [];

  for (const fp of validated) {
    const isNew =
      status.not_added.includes(fp) ||
      status.created.includes(fp) ||
      readRefFile(repoDir, "HEAD", fp) === null;
    if (isNew) toDelete.push(fp);
    else toRestore.push(fp);
  }

  if (toRestore.length > 0) {
    runGit(repoDir, ["checkout", "--", ...toRestore]);
  }
  for (const fp of toDelete) {
    const abs = path.join(repoDir, fp);
    try {
      fs.unlinkSync(abs);
    } catch {
      // ignore missing files
    }
  }
}

export function makeGitStatusHandler(deps: GitDeps) {
  return async (_req: Request): Promise<Response> => {
    try {
      return jsonResponse(computeStatus(deps.repoDir));
    } catch (err) {
      return jsonResponse(
        { error: err instanceof Error ? err.message : String(err) },
        500,
      );
    }
  };
}

export function makeGitDiffHandler(deps: GitDeps) {
  return async (req: Request): Promise<Response> => {
    try {
      let base: string | undefined;
      let headSha: string | undefined;
      if (req.method === "POST") {
        try {
          const body = (await parseJsonBody(req)) as {
            base?: string;
            headSha?: string;
          };
          const rawBase = typeof body.base === "string" ? body.base.trim() : "";
          const rawHead =
            typeof body.headSha === "string" ? body.headSha.trim() : "";
          if (rawBase) base = rawBase;
          if (rawHead) headSha = rawHead;
        } catch {
          // Empty body → working-tree diff.
        }
      }

      const result = base
        ? computeDiffAgainstBase(deps.repoDir, base, headSha)
        : computeDiff(deps.repoDir);
      return jsonResponse(result);
    } catch (err) {
      if (err instanceof InvalidRemoteBranchNameError) {
        return jsonResponse({ error: err.message }, 400);
      }
      return jsonResponse(
        { error: err instanceof Error ? err.message : String(err) },
        500,
      );
    }
  };
}

export function makeGitPublishHandler(deps: GitDeps) {
  return async (req: Request): Promise<Response> => {
    let body: { message?: string };
    try {
      body = (await parseJsonBody(req)) as { message?: string };
    } catch (e) {
      return jsonResponse({ error: (e as Error).message }, 400);
    }
    try {
      return jsonResponse(
        publish(deps, typeof body.message === "string" ? body.message : ""),
      );
    } catch (err) {
      return jsonResponse({ error: formatGitError(err) }, 500);
    }
  };
}

export function makeGitDiscardHandler(deps: GitDeps) {
  return async (req: Request): Promise<Response> => {
    let body: { filepaths?: string[] };
    try {
      body = (await parseJsonBody(req)) as { filepaths?: string[] };
    } catch (e) {
      return jsonResponse({ error: (e as Error).message }, 400);
    }
    const filepaths = body.filepaths;
    if (!Array.isArray(filepaths) || filepaths.length === 0) {
      return jsonResponse({ error: "filepaths is required" }, 400);
    }
    try {
      discard(deps, filepaths);
      return jsonResponse({ success: true });
    } catch (err) {
      return jsonResponse(
        { error: err instanceof Error ? err.message : String(err) },
        500,
      );
    }
  };
}

export function makeGitRebaseHandler(deps: GitDeps) {
  return async (req: Request): Promise<Response> => {
    let body: { base?: string };
    try {
      body = (await parseJsonBody(req)) as { base?: string };
    } catch (e) {
      return jsonResponse({ error: (e as Error).message }, 400);
    }
    const base = typeof body.base === "string" ? body.base.trim() : "";
    if (!base) {
      return jsonResponse({ error: "base is required" }, 400);
    }
    try {
      return jsonResponse(rebaseOntoBase(deps.repoDir, base));
    } catch (err) {
      if (err instanceof InvalidRemoteBranchNameError) {
        return jsonResponse({ error: err.message }, 400);
      }
      return jsonResponse({ error: formatGitError(err) }, 500);
    }
  };
}
