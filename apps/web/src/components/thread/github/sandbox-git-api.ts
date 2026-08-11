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
  opts?: {
    /**
     * "branch-wins": on a git-level conflict the server auto-merges with the
     * branch's content winning for every path it touched — the sandbox-less
     * Sync path for non-technical users, where a conflict dialog is worse
     * than a branch-favoured merge.
     */
    onConflict?: "branch-wins";
  },
): Promise<void> {
  const res = await sandboxFetch(
    buildSandboxGitUrl(orgSlug, virtualMcpId, branch, "rebase"),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ base, ...opts }),
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

/**
 * Per-code-agent policy controlling when a direct publish is allowed:
 * - `smart` (default): a cheap AI judges whether the code needs review.
 * - `code-review`: any code change requires review (only deco/design publishes).
 * - `open`: everything publishes directly.
 * Mirrors `PublishPolicy` in `@decocms/mesh-sdk` (kept local to avoid pulling
 * the SDK into this browser module).
 */
export type PublishPolicy = "smart" | "code-review" | "open";

export const DEFAULT_PUBLISH_POLICY: PublishPolicy = "smart";

/** Coerce an untrusted `metadata.publishPolicy` value into a valid policy. */
export function normalizePublishPolicy(value: unknown): PublishPolicy {
  return value === "code-review" || value === "open" || value === "smart"
    ? value
    : DEFAULT_PUBLISH_POLICY;
}

/** Verdict from the cheap AI judge on whether a code diff needs human review. */
export interface ReviewVerdict {
  requiresReview: boolean;
  reason: string;
}

/**
 * Stable content fingerprint of a diff, used to cache the AI review verdict per
 * distinct set of changes. Hashes every path plus its FULL from/to content, so
 * any change to the diff yields a different signature. This matters for safety:
 * the verdict is cached with `staleTime: Infinity`, so a fingerprint that
 * collided on two different diffs could reuse a stale "publish allowed" verdict
 * for code that actually needs review — failing open. A full-content djb2 hash
 * avoids that (unlike a length+prefix fingerprint, which a length-preserving
 * edit deep in a file can collide). Cheap: O(diff size), memoized by the React
 * compiler on the stable diff reference.
 */
export function reviewDiffSignature(diff: GitDiffResult): string {
  let hash = 5381;
  const mix = (s: string) => {
    for (let i = 0; i < s.length; i++) {
      hash = ((hash << 5) + hash + s.charCodeAt(i)) | 0;
    }
  };
  for (const path of Object.keys(diff.diffs).sort()) {
    const entry = diff.diffs[path];
    mix(path);
    mix(" from:");
    mix(entry?.from ?? "");
    mix(" to:");
    mix(entry?.to ?? "");
    mix("  ");
  }
  return (hash >>> 0).toString(36);
}

/**
 * Ask the server-side cheap-model judge whether this publish payload needs
 * review. Only meaningful for `smart` policy on a diff that contains code
 * (see `needsSmartReviewJudgment`). Generated files are stripped to keep the
 * payload under the endpoint's body limit.
 */
export async function fetchReviewVerdict(
  orgSlug: string,
  virtualMcpId: string,
  branch: string,
  payload: { status: GitStatus; diff: GitDiffResult; language?: string },
): Promise<ReviewVerdict> {
  const res = await sandboxFetch(
    buildSandboxGitUrl(orgSlug, virtualMcpId, branch, "judge-review"),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        status: payload.status,
        diff: stripGeneratedFilesFromDiff(payload.diff),
        // The `reason` is shown to the user, so ask the model to write it in
        // the UI language. This is a deliberate exception to "don't thread
        // locale to the server" — it applies only to this displayed AI text.
        ...(payload.language ? { language: payload.language } : {}),
      }),
    },
  );
  return parseJson<ReviewVerdict>(res);
}

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
  /**
   * `smart` policy only: the AI judge is still running, so the decision isn't
   * known yet. The button should be disabled (not optimistically enabled) with
   * a "reviewing" tooltip until the verdict arrives. `reason` is null here
   * because the tooltip copy is i18n'd at the component level.
   */
  pending?: boolean;
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
 * Whether the changes may be squash-merged straight to base, bypassing review,
 * for the given publish policy. `diff` must be the full publish payload (see
 * `combinePublishDiffs`) so the gate sees every file — committed and
 * uncommitted.
 *
 * This is the SYNCHRONOUS decision and covers every case except `smart` with
 * code in the diff — that one needs the async AI verdict, so callers must first
 * check `needsSmartReviewJudgment` and use `smartReviewGate` when it's true.
 * (Calling this for that case falls back to the safe `code-review` behavior.)
 */
export function canPublishDirectly(
  diff: GitDiffResult | null | undefined,
  policy: PublishPolicy = "code-review",
): PublishGate {
  if (policy === "open") return { allowed: true, reason: null };
  // `smart` deco-only diffs (and all `code-review`) fall through to the
  // deco-only rule: content/design publishes, code is blocked. Reason is left
  // null — the component renders a localized generic tooltip for this case.
  return isDecoOnlyDiff(diff)
    ? { allowed: true, reason: null }
    : { allowed: false, reason: null };
}

/**
 * True when deciding the gate requires the async AI judge: `smart` policy on a
 * non-empty diff that contains code. Deco-only diffs never need the judge
 * (they always publish), and `code-review`/`open` are fully synchronous.
 */
export function needsSmartReviewJudgment(
  diff: GitDiffResult | null | undefined,
  policy: PublishPolicy,
): boolean {
  if (policy !== "smart") return false;
  if (!diff || Object.keys(diff.diffs).length === 0) return false;
  return !isDecoOnlyDiff(diff);
}

/**
 * Resolve the gate for `smart` policy from the AI verdict.
 * - While the judge is still running: block (`pending`) so the button can't be
 *   clicked before the decision is known — the component shows a "reviewing"
 *   tooltip.
 * - When the judge is unavailable (no model provider, error → no verdict):
 *   permissive, allow the direct publish rather than blocking on the AI.
 * - Otherwise honour the verdict.
 */
export function smartReviewGate(
  verdict: ReviewVerdict | null | undefined,
  loading: boolean,
): PublishGate {
  if (loading) return { allowed: false, reason: null, pending: true };
  if (!verdict) return { allowed: true, reason: null };
  if (!verdict.requiresReview) return { allowed: true, reason: null };
  // The AI reason is localized (the judge is asked to write in the UI
  // language); show it. Fall back to null so the component renders its own
  // localized generic message when the model returned no reason.
  const reason = verdict.reason?.trim();
  return { allowed: false, reason: reason ? reason : null };
}
