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
  base?: string;
  aheadOfBase?: number;
  behindBase?: number;
  headSha?: string;
  /** Commits on HEAD not on origin/<branch> (from /git/status). */
  unpushed?: number;
}

export interface GitDiffEntry {
  from: string | null;
  to: string | null;
}

export interface GitDiffResult {
  diffs: Record<string, GitDiffEntry>;
  mergeBaseSha?: string;
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

/** Error carrying the HTTP status so callers can back off on unreachable
 *  sandboxes (503 no runner, 410 handle gone) instead of polling forever. */
class SandboxGitError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "SandboxGitError";
  }
}

/** The sandbox is gone / has no runner — polling it again won't help until
 *  it's re-provisioned, so back off the interval rather than flood errors.
 *  404 is the daemon's "sandbox not found" (handle idle-evicted); without it
 *  the status poll keeps hammering `/git/status` every 3s against a sandbox
 *  that no longer exists. 503 = no runner, 410 = handle gone. */
export function isSandboxUnreachable(error: unknown): boolean {
  return (
    error instanceof SandboxGitError &&
    (error.status === 503 || error.status === 410 || error.status === 404)
  );
}

async function parseJson<T>(res: Response): Promise<T> {
  const body = (await res.json()) as T & { error?: string };
  if (!res.ok) {
    throw new SandboxGitError(
      typeof body.error === "string"
        ? body.error
        : `Request failed (${res.status})`,
      res.status,
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

/**
 * Drop auto-generated files (Tailwind CSS output, `blocks.gen.json`) from a
 * diff before sending it to `suggest-commit`. Their full-content `from`/`to`
 * bodies can be megabytes on their own and blew past the endpoint's 512KB body
 * limit (413). They carry no signal for an LLM commit message either — the
 * server backfills the diff from the daemon when the client omits it, so a
 * fully-stripped diff still yields a suggestion.
 */
export function stripGeneratedFilesFromDiff(
  diff: GitDiffResult,
): GitDiffResult {
  const diffs: Record<string, GitDiffEntry> = {};
  for (const [path, entry] of Object.entries(diff.diffs)) {
    if (isBlocksGenJsonPath(path) || isTailwindCssPath(path)) continue;
    diffs[path] = entry;
  }
  return { ...diff, diffs };
}

export async function fetchSuggestCommitMessage(
  orgSlug: string,
  virtualMcpId: string,
  branch: string,
  payload?: { status: GitStatus; diff: GitDiffResult },
): Promise<CommitSuggestion> {
  const body = payload
    ? {
        status: payload.status,
        diff: stripGeneratedFilesFromDiff(payload.diff),
      }
    : {};
  const res = await sandboxFetch(
    buildSandboxGitUrl(orgSlug, virtualMcpId, branch, "suggest-commit"),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
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

/** Auto-generated by @decocms/start when `.deco/blocks/` changes. */
function isBlocksGenJsonPath(path: string): boolean {
  return path === "blocks.gen.json" || path.endsWith("/blocks.gen.json");
}

/** Auto-generated Tailwind CSS output. */
function isTailwindCssPath(path: string): boolean {
  return (
    path === "static/tailwind.css" || path.endsWith("/static/tailwind.css")
  );
}

/**
 * CMS artifacts live under a `.deco/` directory. The `/.deco/` (and `/.deco`)
 * forms also match projects whose package path isn't the repo root
 * (`<pkg>/.deco/...`), matching how block writes are addressed elsewhere.
 */
function isDecoPath(path: string): boolean {
  return (
    path === ".deco" ||
    path.endsWith("/.deco") ||
    path.startsWith(".deco/") ||
    path.includes("/.deco/")
  );
}

/** Publish (squash-merge) is only allowed for CMS JSON under `.deco/` (plus generated assets). */
export function isDecoOnlyDiff(
  diff: GitDiffResult | null | undefined,
): boolean {
  if (!diff) return false;
  const paths = Object.keys(diff.diffs);
  if (paths.length === 0) return false;
  return paths.every(
    (p) => isDecoPath(p) || isBlocksGenJsonPath(p) || isTailwindCssPath(p),
  );
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
export function hasGitLocalWork(status: GitStatus | null | undefined): boolean {
  if (!status) return false;
  return (
    countGitChanges(status) > 0 ||
    status.staged.length > 0 ||
    status.conflicted.length > 0
  );
}

/** True when the branch still needs commit and/or push (ignores base…head PR diff). */
export function hasLocalWorkToPush(
  status: GitStatus | null | undefined,
): boolean {
  if (!status) return false;
  if (
    hasGitLocalWork(status) ||
    status.ahead > 0 ||
    (status.unpushed ?? 0) > 0
  ) {
    return true;
  }
  // Legacy sandboxes omitted unpushed until origin/<branch> existed remotely.
  return (
    status.unpushed === undefined &&
    (status.aheadOfBase ?? 0) > 0 &&
    status.tracking == null
  );
}

/** True when there is local work to commit, unpushed commits, or working-tree diff paths. */
export function hasUnpublishedWork(
  status: GitStatus | null | undefined,
  diff: GitDiffResult | null | undefined,
): boolean {
  if (!status) return false;
  return (
    hasLocalWorkToPush(status) ||
    (diff != null && Object.keys(diff.diffs).length > 0)
  );
}

/**
 * Which diff the publish dialog should show/gate. Uncommitted working-tree
 * edits aren't in a commit yet, so a base…head diff would come back empty —
 * show the working-tree diff whenever there's local uncommitted work, and fall
 * back to base…head only for a clean tree whose commits are already ahead of
 * base (open-pr-from-commits or direct publish of committed work).
 */
export function shouldUseBaseDiff(
  status: GitStatus | null | undefined,
  opts: { openPrFromCommits: boolean; commitToOpenPr: boolean },
): boolean {
  if (hasGitLocalWork(status)) return false;
  return (
    opts.openPrFromCommits ||
    (!opts.commitToOpenPr && (status?.aheadOfBase ?? 0) > 0)
  );
}

export interface PublishGate {
  allowed: boolean;
  reason: string | null;
}

/**
 * Union of the committed base…head diff and the uncommitted working-tree diff —
 * the full set of changes a direct publish squash-merges into base. Publish
 * commits the working tree, then squash-merges base…HEAD, so the payload is
 * both; the daemon can only return one diff at a time, so callers fetch both
 * and combine here. Working-tree entries win for paths present in both (they
 * hold the latest, about-to-be-committed content).
 */
export function combinePublishDiffs(
  baseDiff: GitDiffResult | null | undefined,
  workingDiff: GitDiffResult | null | undefined,
): GitDiffResult {
  return {
    diffs: { ...(baseDiff?.diffs ?? {}), ...(workingDiff?.diffs ?? {}) },
    ...(baseDiff?.mergeBaseSha ? { mergeBaseSha: baseDiff.mergeBaseSha } : {}),
  };
}

/**
 * Whether the changes may be squash-merged straight to base, bypassing review.
 * `diff` must be the full publish payload (see `combinePublishDiffs`) so the
 * gate sees every file — committed and uncommitted. Only deco-only payloads
 * publish directly; anything with code must go through Submit for review.
 */
export function canPublishDirectly(
  diff: GitDiffResult | null | undefined,
): PublishGate {
  return isDecoOnlyDiff(diff)
    ? { allowed: true, reason: null }
    : { allowed: false, reason: PUBLISH_REQUIRES_SUBMIT_TOOLTIP };
}
