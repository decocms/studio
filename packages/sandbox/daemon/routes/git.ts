import fs, { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parsePorcelainFiles } from "../git/porcelain";
import { rebaseOntoBase } from "../git/rebase-onto-base";
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
}

export interface GitDiffEntry {
  from: string | null;
  to: string | null;
}

export interface GitDiffResult {
  diffs: Record<string, GitDiffEntry>;
}

function computeStatus(repoDir: string): GitStatusResult {
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

function readWorkingFile(repoDir: string, filePath: string): string | null {
  const abs = path.join(repoDir, filePath);
  try {
    return fs.readFileSync(abs, "utf8");
  } catch {
    return null;
  }
}

function readHeadFile(repoDir: string, filePath: string): string | null {
  return tryGit(repoDir, ["show", `HEAD:${filePath}`]);
}

function computeDiff(repoDir: string): GitDiffResult {
  const status = computeStatus(repoDir);
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
      (!readHeadFile(repoDir, filePath) && !isDeleted);

    diffs[filePath] = {
      from: isNew ? null : readHeadFile(repoDir, filePath),
      to: isDeleted ? null : readWorkingFile(repoDir, filePath),
    };
  }

  return { diffs };
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

function changedPathsFromStatus(status: GitStatusResult): string[] {
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

  const status = computeStatus(repoDir);
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
    // that need a full dev toolchain + network. Skip hooks here — CI validates
    // on the PR after push.
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
  const status = computeStatus(repoDir);
  const toRestore: string[] = [];
  const toDelete: string[] = [];

  for (const fp of validated) {
    const isNew =
      status.not_added.includes(fp) ||
      status.created.includes(fp) ||
      readHeadFile(repoDir, fp) === null;
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
  return async (_req: Request): Promise<Response> => {
    try {
      return jsonResponse(computeDiff(deps.repoDir));
    } catch (err) {
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
      return jsonResponse({ error: formatGitError(err) }, 500);
    }
  };
}
