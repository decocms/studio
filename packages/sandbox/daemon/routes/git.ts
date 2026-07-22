import fs, { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { appendCoAuthorTrailer } from "../../git-co-author";
import { computeBranchDivergence } from "../git/branch-divergence";
import { parsePorcelainFiles } from "../git/porcelain";
import { protectedBranches } from "../git/protect-branch";
import { rebaseOntoBase } from "../git/rebase-onto-base";
import {
  cloneUrlHasCredentials,
  syncOriginRemote,
} from "../git/sync-origin-remote";
import {
  assertValidRemoteBranchName,
  InvalidRemoteBranchNameError,
} from "../git/ref-name";
import { safePath } from "../paths";
import {
  isDecofileBlockPath,
  invalidDecofileBlockJson,
} from "../decofile-json";
import type { OperatorIdentity } from "../types";
import { git } from "../setup/git";
import { gitAsync } from "../git/git-async";
import { jsonResponse, parseJsonBody } from "./body-parser";

export interface GitDeps {
  appRoot: string;
  repoDir: string;
  /** Authenticated clone URL from daemon config (may embed OAuth token). */
  getCloneUrl?: () => string | null | undefined;
  /** Studio user operating the sandbox — co-authored on commits. */
  getOperator?: () => OperatorIdentity | null | undefined;
}

function gitEnv(repoDir: string): Record<string, string> {
  return {
    ...process.env,
    GIT_CEILING_DIRECTORIES: repoDir,
    // Status/diff/rev-parse calls in this file are read-only probes that don't
    // need to refresh the index cache. Skipping the optional lock acquisition
    // prevents racing with publish()'s git-add/commit for index.lock, which
    // caused "Unable to create index.lock" and the agent falling back to the
    // GitHub API. git-add and git-commit ignore this env var for their own
    // non-optional index writes, so the write path is unaffected.
    GIT_OPTIONAL_LOCKS: "0",
  };
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

// Async twins of runGit/tryGit for the git/diff hot path. The expensive steps
// there — network `git fetch` and reading large blobs via `git show` — must not
// block the daemon's single event loop (see git-async.ts). Cheap metadata
// probes (rev-parse, merge-base) stay synchronous; they return in single-digit
// ms and converting them buys nothing.
async function runGitAsync(
  repoDir: string,
  args: string[],
  opts?: { env?: Record<string, string> },
): Promise<string> {
  return gitAsync(["-c", "safe.directory=*", ...args], {
    cwd: repoDir,
    env: { ...gitEnv(repoDir), ...opts?.env },
  });
}

async function tryGitAsync(
  repoDir: string,
  args: string[],
): Promise<string | null> {
  try {
    return await runGitAsync(repoDir, args);
  } catch {
    return null;
  }
}

// repoDir is pre-created empty on boot; the clone only runs after config
// arrives. Status/diff probes that race the clone would otherwise exit 128
// ("not a git repository") and surface as a 500.
function isGitRepo(repoDir: string): boolean {
  return tryGit(repoDir, ["rev-parse", "--git-dir"]) !== null;
}

/**
 * Uniform 409 for mutating/reading git endpoints invoked before (or racing) the
 * clone. Without it the raw `git ... rev-parse` 128 ("not a git repository")
 * leaks to the client as a scary 500. `notReady` lets the UI retry.
 */
function repoNotReadyResponse(): Response {
  return jsonResponse(
    { error: "repository not initialized", notReady: true },
    409,
  );
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

function readRefFile(
  repoDir: string,
  ref: string,
  filePath: string,
): string | null {
  return tryGit(repoDir, ["show", `${ref}:${filePath}`]);
}

async function readWorkingFileAsync(
  repoDir: string,
  filePath: string,
): Promise<string | null> {
  try {
    return await fs.promises.readFile(path.join(repoDir, filePath), "utf8");
  } catch {
    return null;
  }
}

async function readRefFileAsync(
  repoDir: string,
  ref: string,
  filePath: string,
): Promise<string | null> {
  return tryGitAsync(repoDir, ["show", `${ref}:${filePath}`]);
}

async function computeDiff(repoDir: string): Promise<GitDiffResult> {
  const status = computeWorkingTreeStatus(repoDir);
  const paths = [
    ...new Set(status.files.map((f) => f.path).filter((p) => p.length > 0)),
  ];

  const diffs: Record<string, GitDiffEntry> = {};
  // Read every file's before/after off the event loop and in parallel — the
  // per-file `git show` + working-tree read is what dominates a big diff.
  await Promise.all(
    paths.map(async (filePath) => {
      const file = status.files.find((f) => f.path === filePath);
      const index = file?.index ?? " ";
      const working = file?.working_dir ?? " ";
      const isDeleted = index === "D" || working === "D";
      const head = await readRefFileAsync(repoDir, "HEAD", filePath);
      const isNew =
        (index === "?" && working === "?") ||
        index === "A" ||
        working === "A" ||
        (!head && !isDeleted);

      diffs[filePath] = {
        from: isNew ? null : head,
        to: isDeleted ? null : await readWorkingFileAsync(repoDir, filePath),
      };
    }),
  );

  return { diffs };
}

/** Committed changes on HEAD since branching from `origin/{base}` (PR scope). */
export async function computeDiffAgainstBase(
  repoDir: string,
  base: string,
  headSha?: string,
): Promise<GitDiffResult> {
  assertValidRemoteBranchName(base);

  const branch = tryGit(repoDir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!branch || branch === "HEAD") {
    throw new Error("Cannot compute PR diff from detached HEAD");
  }
  assertValidRemoteBranchName(branch);

  const upstream = `origin/${base}`;
  const remoteHead = `origin/${branch}`;
  const hasValidHeadSha = !!headSha && /^[0-9a-f]{40}$/i.test(headSha);

  const resolveLocally = (ref: string): boolean =>
    tryGit(repoDir, ["rev-parse", "--verify", ref]) !== null;

  // Fast path: skip the network fetch when we can already compute the diff from
  // local refs. Shallow clones miss one side of the fork on the FIRST request,
  // so that one must fetch — but once the base tip, the exact requested head
  // commit, and their fork point (merge-base) are all present locally, every
  // later request (modal reopen, 30s refetch) can compute offline. We only take
  // this path with an explicit headSha that resolves locally: that pins the
  // exact commit the client asked for, so there's no staleness risk. Without a
  // headSha we fall through and fetch to be sure origin/<branch> is current.
  let headRef: string | null = null;
  const canSkipFetch =
    hasValidHeadSha &&
    resolveLocally(upstream) &&
    resolveLocally(`${headSha}^{commit}`) &&
    tryGit(repoDir, ["merge-base", upstream, headSha!]) !== null;
  if (canSkipFetch) {
    headRef = headSha!;
  } else {
    // Shallow clones often miss one side of the fork — fetch both tips with
    // depth. This is a NETWORK call and by far the slowest step; keep it async
    // so a slow fetch never freezes the daemon (and trips crash detection).
    try {
      await runGitAsync(repoDir, [
        "fetch",
        "--depth",
        "100",
        "origin",
        base,
        branch,
      ]);
    } catch {
      // Local-only fixtures / offline sandboxes may already have the refs.
    }
    if (hasValidHeadSha) {
      await tryGitAsync(repoDir, [
        "fetch",
        "--depth",
        "100",
        "origin",
        headSha!,
      ]);
    }

    if (!resolveLocally(upstream)) {
      throw new Error(`Base branch '${base}' not found on origin`);
    }

    if (hasValidHeadSha && resolveLocally(`${headSha}^{commit}`)) {
      headRef = headSha!;
    } else if (resolveLocally(remoteHead)) {
      headRef = remoteHead;
    } else {
      headRef = "HEAD";
    }
  }

  let paths = listThreeDotDiffPaths(repoDir, upstream, headRef);

  // An empty diff after a shallow fetch may just mean the fork point is still
  // beyond our history — deepen and retry. Skip this on the fast path: we
  // already have a valid merge-base there, so an empty result is a real empty
  // diff and a deepen fetch would only add a pointless network round-trip.
  if (paths.length === 0 && !canSkipFetch) {
    try {
      await runGitAsync(repoDir, [
        "fetch",
        "--deepen",
        "500",
        "origin",
        base,
        branch,
      ]);
    } catch {
      /* see fetch note above */
    }
    paths = listThreeDotDiffPaths(repoDir, upstream, headRef);
  }

  const mergeBase =
    tryGit(repoDir, ["merge-base", upstream, headRef]) ?? upstream;

  const diffs: Record<string, GitDiffEntry> = {};
  // Read both sides of every changed file off the event loop, in parallel.
  await Promise.all(
    paths.map(async (filePath) => {
      const [from, to] = await Promise.all([
        readRefFileAsync(repoDir, mergeBase, filePath),
        readRefFileAsync(repoDir, headRef, filePath),
      ]);
      diffs[filePath] = { from, to };
    }),
  );

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

function pushBranch(repoDir: string, branch: string): void {
  runGit(
    repoDir,
    [
      "-c",
      "credential.helper=",
      "-c",
      "safe.directory=*",
      "push",
      // Skip native pre-push hooks (parity with the --no-verify commit above).
      // A repo's pre-push script can fail or hang the push, and the shutdown
      // sync — which shares this path — has no room to wait it out before the
      // pod's grace period elapses and SIGKILL drops the unsynced work.
      "--no-verify",
      "-u",
      "origin",
      branch,
    ],
    {
      env: {
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "true",
        LEFTHOOK: "0",
        HUSKY: "0",
      },
    },
  );
}

/**
 * A publish blocked because a changed decofile block is invalid JSON. Thrown so
 * the HTTP route can map it to 4xx (a client/data condition, not a 5xx server
 * fault) and the shutdown path can tell it apart from a real git failure.
 */
class InvalidDecofileBlockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidDecofileBlockError";
  }
}

export function publish(
  deps: GitDeps,
  message: string,
  opts: { onInvalidBlock?: "throw" | "skip" } = {},
): { pushed: boolean } {
  const repoDir = deps.repoDir;
  // The HTTP route guards with isGitRepo(); the shutdown handler calls publish()
  // directly, so a never-cloned/empty dir would throw 128 ("not a git
  // repository") on the rev-parse below. Nothing to publish — skip cleanly.
  if (!isGitRepo(repoDir)) {
    return { pushed: false };
  }
  const branch = runGit(repoDir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!branch || branch === "HEAD") {
    throw new Error("Cannot publish from a detached HEAD");
  }
  // The pre-push hook (protect-branch.ts) also guards this, but the push below
  // runs with --no-verify and skips it — so the block MUST live in code too.
  // Refuse before committing so we never leave a stray commit on a protected
  // branch either. Changes reach the default branch via PR, never a direct push.
  if (protectedBranches(repoDir).has(branch)) {
    throw new Error(
      `Refusing to push to protected branch "${branch}" from a sandbox. Work on a feature branch; changes reach the default branch via PR.`,
    );
  }

  const status = computeWorkingTreeStatus(repoDir);
  let paths = changedPathsFromStatus(status);
  // Last-resort net: never let a syntactically invalid decofile block reach the
  // branch. The /write and /edit handlers already reject invalid blocks, but a
  // mutation that bypassed them (bash, a git merge, a future write path) would
  // otherwise be committed verbatim by publish() and break the whole site render.
  //
  // Two dispositions, by caller:
  // - "throw" (default, interactive publish): fail loudly so the user fixes it.
  // - "skip" (shutdown-sync): drop just the bad block and still sync everything
  //   else. Aborting the whole shutdown commit would silently lose all the
  //   user's OTHER valid work when the sandbox is torn down — a worse failure
  //   mode than not syncing one already-corrupt block (which stays uncommitted
  //   and is discarded on the next re-clone).
  const invalidBlocks: string[] = [];
  for (const rel of paths) {
    if (!isDecofileBlockPath(rel)) continue;
    let content: string;
    try {
      content = fs.readFileSync(path.join(repoDir, rel), "utf-8");
    } catch {
      continue; // deleted or unreadable — nothing to validate
    }
    const jsonError = invalidDecofileBlockJson(rel, content);
    if (!jsonError) continue;
    if (opts.onInvalidBlock === "skip") {
      console.warn(`[daemon] skipping from sync: ${jsonError}`);
      invalidBlocks.push(rel);
    } else {
      throw new InvalidDecofileBlockError(`Refusing to publish: ${jsonError}`);
    }
  }
  if (invalidBlocks.length > 0) {
    const skip = new Set(invalidBlocks);
    paths = paths.filter((p) => !skip.has(p));
  }
  if (paths.length > 0) {
    runGit(repoDir, ["add", "--", ...paths]);
  }
  const hasStagedChanges =
    tryGit(repoDir, ["diff", "--cached", "--quiet"]) === null;
  if (hasStagedChanges) {
    const commitMsg = appendCoAuthorTrailer(
      message.trim().length > 0 ? message.trim() : "Update from sandbox",
      deps.getOperator?.(),
    );
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

  const cloneUrl = deps.getCloneUrl?.();
  if (typeof cloneUrl === "string" && cloneUrl.length > 0) {
    syncOriginRemote(repoDir, cloneUrl);
  }
  // Guard the *effective* origin. syncOriginRemote no-ops on a credential-less
  // cloneUrl, so a non-empty-but-tokenless cloneUrl used to fall straight
  // through to pushBranch and fail with an opaque "Invalid username or token".
  const originUrl = tryGit(repoDir, ["remote", "get-url", "origin"]) ?? "";
  if (originUrl.includes("github.com") && !cloneUrlHasCredentials(originUrl)) {
    throw new Error(
      "GitHub push requires an authenticated clone URL. Connect GitHub for this project and restart the sandbox.",
    );
  }

  pushBranch(repoDir, branch);
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
    if (!isGitRepo(deps.repoDir)) {
      return repoNotReadyResponse();
    }
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
    if (!isGitRepo(deps.repoDir)) {
      return repoNotReadyResponse();
    }
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
        ? await computeDiffAgainstBase(deps.repoDir, base, headSha)
        : await computeDiff(deps.repoDir);
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
    if (!isGitRepo(deps.repoDir)) {
      return repoNotReadyResponse();
    }
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
      // An invalid-block refusal is a client/data condition, not a server fault.
      if (err instanceof InvalidDecofileBlockError) {
        return jsonResponse({ error: err.message }, 400);
      }
      return jsonResponse({ error: formatGitError(err) }, 500);
    }
  };
}

export function makeGitDiscardHandler(deps: GitDeps) {
  return async (req: Request): Promise<Response> => {
    if (!isGitRepo(deps.repoDir)) {
      return repoNotReadyResponse();
    }
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
    if (!isGitRepo(deps.repoDir)) {
      return repoNotReadyResponse();
    }
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
      return jsonResponse(
        rebaseOntoBase(deps.repoDir, base, {
          operator: deps.getOperator?.() ?? undefined,
        }),
      );
    } catch (err) {
      if (err instanceof InvalidRemoteBranchNameError) {
        return jsonResponse({ error: err.message }, 400);
      }
      return jsonResponse({ error: formatGitError(err) }, 500);
    }
  };
}
