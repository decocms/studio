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

import {
  GitHubApiError,
  type GitDataClient,
  type TreeWriteEntry,
} from "./github-git-data";
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

/** What to do when merging base into the branch hits a git-level conflict. */
export type RebaseConflictStrategy = "fail" | "branch-wins";

/**
 * "Rebase" equivalent: bring the branch up to date with `base` by merging
 * base INTO the branch server-side (GitHub /merges). A true rebase needs a
 * working tree; a merge commit achieves the same "branch contains latest
 * base" postcondition the dialog's flow wants before publishing.
 *
 * `onConflict: "branch-wins"` is the non-technical-user path: on a git-level
 * conflict, build the merge commit ourselves — base's tree with every path
 * the branch touched since the merge base replayed on top, so the branch's
 * content wins for its own edits while everything else catches up to base.
 * Deliberately branch-favoured: the person syncing is the person editing,
 * and silently losing THEIR block edit is the one outcome a CMS must never
 * pick. Both parents are recorded, so nothing from base is lost from
 * history.
 */
export async function githubGitRebase(
  client: GitDataClient,
  branch: string,
  base: string,
  onConflict: RebaseConflictStrategy = "fail",
): Promise<void> {
  try {
    await client.mergeBranch(
      branch,
      base,
      `chore(decofile): merge ${base} into ${branch}`,
    );
    return;
  } catch (err) {
    if (!(err instanceof GitHubApiError && err.status === 409)) throw err;
    if (onConflict !== "branch-wins") {
      throw new GitHubApiError(
        409,
        "POST",
        "merges",
        `Merge conflict updating ${branch} from ${base} — resolve on GitHub`,
      );
    }
  }
  await mergeBranchWins(client, branch, base);
}

/**
 * GitHub's compare endpoint returns at most 300 files; beyond that the
 * change-set is silently truncated, and replaying a truncated set would
 * DROP the branch's remaining edits from the merge. Fail loudly instead.
 */
const MERGE_REPLAY_FILE_CAP = 300;

const MERGE_CAS_ATTEMPTS = 3;

/**
 * Tree write entries for the branch-wins replay, deduped by path. A path can
 * be BOTH a rename destination for one file and a rename source for another
 * in the same diff (e.g. `Hero.json`→`Header.json` while `Banner.json`→
 * `Hero.json`) — GitHub's tree write applies the LAST entry for a duplicate
 * path, so pushing both a create and a stale-source delete for the same path
 * let iteration order decide whether the renamed-in content survived. A
 * destination entry always describes the path's real final content, so it
 * always wins; a source delete only applies when nothing else claims that
 * path as its destination.
 */
export function buildMergeTreeEntries(
  files: Array<{
    filename: string;
    status: string;
    sha: string;
    previousFilename?: string;
  }>,
  branchBlobByPath: Map<string, { sha: string }>,
): TreeWriteEntry[] {
  const byPath = new Map<string, TreeWriteEntry>();
  for (const f of files) {
    const blob = branchBlobByPath.get(f.filename);
    byPath.set(f.filename, {
      path: f.filename,
      mode: "100644",
      type: "blob",
      sha: f.status === "removed" || !blob ? null : blob.sha,
    });
  }
  for (const f of files) {
    if (
      f.previousFilename &&
      f.previousFilename !== f.filename &&
      !byPath.has(f.previousFilename)
    ) {
      byPath.set(f.previousFilename, {
        path: f.previousFilename,
        mode: "100644",
        type: "blob",
        sha: null,
      });
    }
  }
  return [...byPath.values()];
}

async function mergeBranchWins(
  client: GitDataClient,
  branch: string,
  base: string,
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    const branchHead = await client.getHeadSha(branch);
    const baseHead = await client.getHeadSha(base);
    // Three-dot compare: every path the branch changed since the merge base —
    // exactly the set where the branch's version must win.
    const { files } = await client.compareDetailed(base, branch);
    if (files.length >= MERGE_REPLAY_FILE_CAP) {
      throw new GitHubApiError(
        409,
        "POST",
        "merges",
        `Too many changed files on ${branch} to auto-merge (${files.length}); resolve on GitHub`,
      );
    }

    // Real blob shas + modes come from the branch tree, not the compare
    // entries — compare doesn't carry file modes.
    const branchTree = await client.getTreeRecursive(
      await client.getCommitTreeSha(branchHead),
    );
    const branchBlobByPath = new Map(
      branchTree.filter((e) => e.type === "blob").map((e) => [e.path, e]),
    );

    const entries = buildMergeTreeEntries(files, branchBlobByPath);

    const treeSha = await client.createTree(
      await client.getCommitTreeSha(baseHead),
      entries,
    );
    const commitSha = await client.createCommit({
      message: `chore(decofile): merge ${base} into ${branch} (branch content wins)`,
      treeSha,
      parentShas: [branchHead, baseHead],
    });
    try {
      await client.updateRef(branch, commitSha);
      return;
    } catch (err) {
      // Non-fast-forward: an autosave landed mid-merge. Rebuild from the new
      // head so the fresh edit is part of the replay instead of clobbered.
      if (
        err instanceof GitHubApiError &&
        err.status === 422 &&
        attempt < MERGE_CAS_ATTEMPTS
      ) {
        continue;
      }
      throw err;
    }
  }
}
