/**
 * GitHub-backed implementations of the sandbox `/git/*` route contracts for
 * sandbox-less Fast Preview projects. The web's publish dialog and header
 * cluster speak the daemon's JSON shapes (`GitStatus`, `GitDiffResult` — see
 * apps/web .../sandbox-git-api.ts); serving the same shapes from the GitHub
 * API lets those components work UNCHANGED with no working tree behind them.
 *
 * Invariants of sandbox-less mode that shape these payloads:
 * - There is no working tree: every save is already a commit on the branch,
 *   so local-work fields (modified/staged/unpushed/...) are always empty/0.
 * - "Publish" (sync-local-work) is therefore a no-op — the route answers OK
 *   without calling here.
 */

import { GitHubApiError, type GitDataClient } from "./github-git-data";
import { mapBounded, resolveOrCreateHead } from "./read-decofile";

const DIFF_MAX_FILES = 200;
const DIFF_FETCH_CONCURRENCY = 12;

/** Mirror of the daemon's `git status` JSON (see web GitStatus). */
export interface CompatGitStatus {
  not_added: string[];
  conflicted: string[];
  created: string[];
  deleted: string[];
  modified: string[];
  renamed: unknown[];
  files: unknown[];
  staged: string[];
  ahead: number;
  behind: number;
  current: string;
  tracking: string;
  detached: false;
  base: string;
  aheadOfBase: number;
  behindBase: number;
  headSha: string;
  unpushed: 0;
}

export async function githubGitStatus(
  client: GitDataClient,
  branch: string,
): Promise<CompatGitStatus> {
  const base = await client.getDefaultBranch();
  // Materialize thread-minted branches exactly like the decofile read does —
  // the header polls status before the CMS ever reads content.
  const headSha = await resolveOrCreateHead(client, branch);
  const drift =
    base === branch
      ? { aheadBy: 0, behindBy: 0 }
      : await client.compare(base, branch);
  return {
    not_added: [],
    conflicted: [],
    created: [],
    deleted: [],
    modified: [],
    renamed: [],
    files: [],
    staged: [],
    ahead: 0,
    behind: 0,
    current: branch,
    tracking: `origin/${branch}`,
    detached: false,
    base,
    aheadOfBase: drift.aheadBy,
    behindBase: drift.behindBy,
    headSha,
    unpushed: 0,
  };
}

/** Mirror of the daemon's diff JSON: full old/new contents per path. */
export interface CompatGitDiff {
  diffs: Record<string, { from: string | null; to: string | null }>;
  mergeBaseSha: string;
}

/**
 * Base…head diff with full file contents, assembled from a detailed compare:
 * head-side blobs come straight off the compare entries; base-side blobs are
 * resolved through the merge-base tree. Bounded and capped — a runaway diff
 * returns the first {@link DIFF_MAX_FILES} paths rather than ballooning.
 */
export async function githubGitDiff(
  client: GitDataClient,
  branch: string,
  base?: string,
): Promise<CompatGitDiff> {
  const againstBase = base ?? (await client.getDefaultBranch());
  const detailed = await client.compareDetailed(againstBase, branch);
  const files = detailed.files.slice(0, DIFF_MAX_FILES);

  const baseTreeSha = await client.getCommitTreeSha(detailed.mergeBaseSha);
  const baseTree = await client.getTreeRecursive(baseTreeSha);
  const baseBlobByPath = new Map(
    baseTree.filter((e) => e.type === "blob").map((e) => [e.path, e.sha]),
  );

  const entries = await mapBounded(files, DIFF_FETCH_CONCURRENCY, async (f) => {
    const basePath = f.previousFilename ?? f.filename;
    const baseSha =
      f.status === "added" ? undefined : baseBlobByPath.get(basePath);
    const from = baseSha ? await client.getBlobText(baseSha) : null;
    const to = f.status === "removed" ? null : await client.getBlobText(f.sha);
    return [f.filename, { from, to }] as const;
  });

  return {
    diffs: Object.fromEntries(entries),
    mergeBaseSha: detailed.mergeBaseSha,
  };
}

/**
 * "Rebase" equivalent: bring the branch up to date with `base` by merging
 * base INTO the branch server-side (GitHub /merges). A true rebase needs a
 * working tree; a merge commit achieves the same "branch contains latest
 * base" postcondition the dialog's flow wants before publishing.
 */
export async function githubGitRebase(
  client: GitDataClient,
  branch: string,
  base: string,
): Promise<void> {
  try {
    await client.mergeBranch(
      branch,
      base,
      `chore(decofile): merge ${base} into ${branch}`,
    );
  } catch (err) {
    if (err instanceof GitHubApiError && err.status === 409) {
      throw new GitHubApiError(
        409,
        "POST",
        "merges",
        `Merge conflict updating ${branch} from ${base} — resolve on GitHub`,
      );
    }
    throw err;
  }
}
