import type { BranchMeta } from "@decocms/sandbox/shared";

export interface GitStatusFile {
  path: string;
  index: string;
  working_dir: string;
}

export interface GitStatus {
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

export interface CommitSuggestion {
  title: string;
  body: string;
  message: string;
}

function buildSandboxGitUrl(
  orgSlug: string,
  virtualMcpId: string,
  branch: string,
  endpoint: string,
) {
  return `/api/${orgSlug}/sandbox/${encodeURIComponent(virtualMcpId)}/${encodeURIComponent(branch)}/git/${endpoint}`;
}

async function parseJson<T>(res: Response): Promise<T> {
  const body = (await res.json()) as T & { error?: string };
  if (!res.ok) {
    throw new Error(
      typeof body.error === "string"
        ? body.error
        : `Request failed (${res.status})`,
    );
  }
  return body;
}

/** Never cache sandbox git/fs calls — 410 Gone must not stick in disk cache. */
function sandboxFetch(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, { cache: "no-store", ...init });
}

export async function fetchGitStatus(
  orgSlug: string,
  virtualMcpId: string,
  branch: string,
): Promise<GitStatus> {
  const res = await sandboxFetch(
    buildSandboxGitUrl(orgSlug, virtualMcpId, branch, "status"),
  );
  return parseJson<GitStatus>(res);
}

export async function fetchGitDiff(
  orgSlug: string,
  virtualMcpId: string,
  branch: string,
  options?: { base?: string; headSha?: string },
): Promise<GitDiffResult> {
  const payload =
    options?.base || options?.headSha
      ? {
          ...(options.base ? { base: options.base } : {}),
          ...(options.headSha ? { headSha: options.headSha } : {}),
        }
      : undefined;
  const res = await sandboxFetch(
    buildSandboxGitUrl(orgSlug, virtualMcpId, branch, "diff"),
    {
      method: "POST",
      headers: payload ? { "content-type": "application/json" } : undefined,
      body: payload ? JSON.stringify(payload) : undefined,
    },
  );
  return parseJson<GitDiffResult>(res);
}

export async function fetchSuggestCommitMessage(
  orgSlug: string,
  virtualMcpId: string,
  branch: string,
  payload?: { status: GitStatus; diff: GitDiffResult },
): Promise<CommitSuggestion> {
  const res = await sandboxFetch(
    buildSandboxGitUrl(orgSlug, virtualMcpId, branch, "suggest-commit"),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload ?? {}),
    },
  );
  return parseJson<CommitSuggestion>(res);
}

export async function publishGitChanges(
  orgSlug: string,
  virtualMcpId: string,
  branch: string,
  message: string,
): Promise<void> {
  const res = await sandboxFetch(
    buildSandboxGitUrl(orgSlug, virtualMcpId, branch, "publish"),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message }),
    },
  );
  await parseJson(res);
}

export async function rebaseGitBranch(
  orgSlug: string,
  virtualMcpId: string,
  branch: string,
  base: string,
): Promise<void> {
  const res = await sandboxFetch(
    buildSandboxGitUrl(orgSlug, virtualMcpId, branch, "rebase"),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ base }),
    },
  );
  await parseJson(res);
}

/** Publish (squash-merge) is only allowed for CMS JSON under `.deco/`. */
export function isDecoOnlyDiff(
  diff: GitDiffResult | null | undefined,
): boolean {
  if (!diff) return false;
  const paths = Object.keys(diff.diffs);
  if (paths.length === 0) return false;
  return paths.every((p) => p === ".deco" || p.startsWith(".deco/"));
}

export const PUBLISH_REQUIRES_SUBMIT_TOOLTIP =
  "Code changes can't be published directly — use Submit for review";

export async function discardGitFiles(
  orgSlug: string,
  virtualMcpId: string,
  branch: string,
  filepaths: string[],
): Promise<void> {
  const res = await sandboxFetch(
    buildSandboxGitUrl(orgSlug, virtualMcpId, branch, "discard"),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filepaths }),
    },
  );
  await parseJson(res);
}

const GIT_HEAD_BRANCH_KEY = "current" satisfies keyof GitStatus;

export function readGitHeadBranch(
  status: GitStatus | null | undefined,
): string | null {
  return status?.[GIT_HEAD_BRANCH_KEY] ?? null;
}

export function sandboxGitStatusQueryKey(
  orgSlug: string,
  virtualMcpId: string,
  branch: string,
) {
  return ["sandbox-git-status", orgSlug, virtualMcpId, branch] as const;
}

export function countGitChanges(status: GitStatus | null): number {
  if (!status) return 0;
  return (
    status.modified.length +
    status.created.length +
    status.deleted.length +
    status.not_added.length +
    status.renamed.length
  );
}

/** True when the working tree or index has uncommitted work. */
function hasGitLocalWork(status: GitStatus | null | undefined): boolean {
  if (!status) return false;
  return (
    countGitChanges(status) > 0 ||
    status.staged.length > 0 ||
    status.conflicted.length > 0
  );
}

/** True when there is local work to commit or unpushed commits on the branch. */
export function hasUnpublishedWork(
  status: GitStatus | null | undefined,
  diff: GitDiffResult | null | undefined,
): boolean {
  if (!status) return false;
  return (
    hasGitLocalWork(status) ||
    status.ahead > 0 ||
    (diff != null && Object.keys(diff.diffs).length > 0)
  );
}

/**
 * Merge live `/git/status` into SSE `BranchMeta`. The status endpoint is
 * always fresh; branch SSE can lag when the daemon watcher misses a save.
 */
export function mergeBranchMetaWithGitStatus(
  branchMeta: BranchMeta,
  gitStatus: GitStatus | undefined,
): BranchMeta {
  if (!gitStatus) return branchMeta;

  const gitDirty = hasGitLocalWork(gitStatus);
  const branchName = readGitHeadBranch(gitStatus);

  if (branchMeta.kind === "ready") {
    return {
      ...branchMeta,
      branch: branchName ?? branchMeta.branch,
      workingTreeDirty: gitDirty,
      unpushed: Math.max(branchMeta.unpushed, gitStatus.ahead),
    };
  }

  if (!branchName && !gitDirty) return branchMeta;

  return {
    kind: "ready",
    branch: branchName ?? "",
    base: "main",
    workingTreeDirty: gitDirty,
    unpushed: gitStatus.ahead,
    aheadOfBase: 0,
    behindBase: gitStatus.behind,
    headSha: "",
  };
}
