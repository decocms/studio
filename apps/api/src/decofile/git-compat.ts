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

/**
 * Bring the branch up to date with `base`, leaving it as ONE commit whose only
 * parent is the base head — a squash-rebase, not a merge, because a merge's
 * resolution lives only in its tree and `git rebase` drops merge commits. Clean
 * merges take GitHub's 3-way tree; conflicts always take
 * {@link buildBranchWinsTree} and the cost documented there.
 *
 * The forced ref update has no compare-and-swap (GitHub takes no `If-Match` on
 * refs); re-reading the head right before it is the closest available lease.
 */
export async function githubGitRebase(
  client: GitDataClient,
  branch: string,
  base: string,
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    // Read first: the pre-force check re-reads it, catching any later autosave.
    const branchHead = await client.getHeadSha(branch);
    const compared = await client.compareDetailed(base, branch);

    // Already one commit on base: nothing to bring in, nothing to flatten.
    if (compared.behindBy === 0 && compared.aheadBy <= 1) return;

    const baseHead = await client.getHeadSha(base);

    // No commits of its own: a fast-forward, which needs no force.
    if (compared.aheadBy === 0) {
      try {
        await client.updateRef(branch, baseHead);
        return;
      } catch (err) {
        // 422 = an autosave landed since the compare; rebuild on the new head.
        if (!(err instanceof GitHubApiError && err.status === 422)) throw err;
        if (attempt >= MERGE_CAS_ATTEMPTS) throw err;
        continue;
      }
    }

    let treeSha: string;
    let branchWon = false;
    // `mergeBranch` moves the ref onto the merge commit it creates.
    let mergedSha: string | null = null;
    try {
      const mergeSha = await client.mergeBranch(
        branch,
        base,
        `chore(decofile): merge ${base} into ${branch}`,
      );
      if (mergeSha === null) {
        // Branch already contains base but is >1 commit ahead: flatten as-is.
        treeSha = await client.getCommitTreeSha(branchHead);
      } else {
        treeSha = await client.getCommitTreeSha(mergeSha);
        mergedSha = mergeSha;
      }
    } catch (err) {
      if (!(err instanceof GitHubApiError && err.status === 409)) throw err;
      treeSha = await buildBranchWinsTree(
        client,
        compared.files,
        branchHead,
        baseHead,
      );
      branchWon = true;
    }

    const expectedHead = mergedSha ?? branchHead;
    try {
      const commitSha = await client.createCommit({
        message: squashMessage(
          branch,
          base,
          branchWon,
          compared.commitMessages,
        ),
        treeSha,
        parentShas: [baseHead],
      });

      if ((await client.getHeadSha(branch)) !== expectedHead) {
        // An autosave landed mid-sync: rebuild on the new head, never force over it.
        if (attempt < MERGE_CAS_ATTEMPTS) continue;
        throw new GitHubApiError(
          409,
          "PATCH",
          `git/refs/heads/${branch}`,
          `${branch} kept changing while syncing with ${base}; try again`,
        );
      }
      await client.updateRef(branch, commitSha, { force: true });
      return;
    } catch (err) {
      await undoAbandonedMerge(client, branch, mergedSha, branchHead);
      throw err;
    }
  }
}

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
  branchBlobByPath: Map<string, { sha: string; mode?: string }>,
): TreeWriteEntry[] {
  const byPath = new Map<string, TreeWriteEntry>();
  for (const f of files) {
    const blob = branchBlobByPath.get(f.filename);
    byPath.set(f.filename, {
      path: f.filename,
      mode: blob?.mode ?? "100644",
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

/**
 * Discard the branch's changes to `filepaths`: a new commit on the branch that
 * resets each path to its content at the merge base with the default branch
 * (or deletes it when it did not exist there). The sandbox-less equivalent of
 * the daemon's working-tree discard — in Fast Preview every edit is already a
 * commit, so undoing one is a commit too. CAS-retried like the merge above so
 * an autosave landing mid-discard is never clobbered.
 */
export async function githubGitDiscard(
  client: GitDataClient,
  branch: string,
  filepaths: string[],
): Promise<void> {
  if (filepaths.length === 0) return;
  const base = await client.getDefaultBranch();
  for (let attempt = 1; ; attempt++) {
    const branchHead = await client.getHeadSha(branch);
    const { mergeBaseSha } = await client.compareDetailed(base, branch);
    const [baseTree, headTree] = await Promise.all([
      client.getTreeRecursive(await client.getCommitTreeSha(mergeBaseSha)),
      client.getTreeRecursive(await client.getCommitTreeSha(branchHead)),
    ]);
    const baseBlobByPath = new Map(
      baseTree.filter((e) => e.type === "blob").map((e) => [e.path, e]),
    );
    const headBlobByPath = new Map(
      headTree.filter((e) => e.type === "blob").map((e) => [e.path, e]),
    );

    const entries: TreeWriteEntry[] = [];
    for (const path of filepaths) {
      const baseBlob = baseBlobByPath.get(path);
      const headBlob = headBlobByPath.get(path);
      // Already at the base content (or absent on both sides): nothing to do.
      if (baseBlob?.sha === headBlob?.sha) continue;
      // Deleting a path the head tree doesn't have is a 422, not a no-op.
      if (!baseBlob && !headBlob) continue;
      entries.push({
        path,
        mode: "100644",
        type: "blob",
        sha: baseBlob?.sha ?? null,
      });
    }
    if (entries.length === 0) return;

    const treeSha = await client.createTree(
      await client.getCommitTreeSha(branchHead),
      entries,
    );
    const commitSha = await client.createCommit({
      message: `chore(decofile): discard changes to ${entries.length} file(s)`,
      treeSha,
      parentShas: [branchHead],
    });
    try {
      await client.updateRef(branch, commitSha);
      return;
    } catch (err) {
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

type ComparedFile = Awaited<
  ReturnType<GitDataClient["compareDetailed"]>
>["files"][number];

/**
 * The branch-wins tree: base's tree with every path the branch changed since
 * the merge base (the three-dot compare set) replaced by the branch's version,
 * whole file. The same resolution the merge commit used to carry — only where
 * it lands has changed.
 */
async function buildBranchWinsTree(
  client: GitDataClient,
  files: ComparedFile[],
  branchHead: string,
  baseHead: string,
): Promise<string> {
  if (files.length >= MERGE_REPLAY_FILE_CAP) {
    throw new GitHubApiError(
      409,
      "POST",
      "merges",
      `Too many changed files on the branch to auto-merge (${files.length}); resolve on GitHub`,
    );
  }

  // Blob shas AND modes come from the branch tree — compare carries no modes.
  const branchTree = await client.getTreeRecursive(
    await client.getCommitTreeSha(branchHead),
  );
  const branchBlobByPath = new Map(
    branchTree.filter((e) => e.type === "blob").map((e) => [e.path, e]),
  );

  return client.createTree(
    await client.getCommitTreeSha(baseHead),
    buildMergeTreeEntries(files, branchBlobByPath),
  );
}

/**
 * `mergeBranch` advances the branch ref before the squash can replace it. When
 * the squash then fails, roll the ref back so a sync that reported failure
 * leaves no merge commit behind — but only while nothing else has landed on it,
 * since a rollback is itself a force.
 */
async function undoAbandonedMerge(
  client: GitDataClient,
  branch: string,
  mergedSha: string | null,
  branchHead: string,
): Promise<void> {
  if (mergedSha === null) return;
  try {
    if ((await client.getHeadSha(branch)) !== mergedSha) return;
    await client.updateRef(branch, branchHead, { force: true });
  } catch {
    // Best effort: the caller needs to see the original failure, not this one.
  }
}

/**
 * Collapsing N commits into one would drop the `Co-authored-by:` trailers the
 * coalescer stamps per editor, and those trailers are how GitHub attributes the
 * work. Re-emit the distinct ones on the squash.
 */
function squashMessage(
  branch: string,
  base: string,
  branchWon: boolean,
  collapsed: string[],
): string {
  const subject = branchWon
    ? `chore(decofile): sync ${branch} with ${base} (branch content wins)`
    : `chore(decofile): sync ${branch} with ${base}`;
  const trailers = collectCoAuthorTrailers(collapsed);
  return trailers.length > 0 ? `${subject}\n\n${trailers.join("\n")}` : subject;
}

function collectCoAuthorTrailers(messages: string[]): string[] {
  const seen = new Set<string>();
  for (const message of messages) {
    for (const line of message.split("\n")) {
      const trimmed = line.trim();
      if (/^Co-authored-by:\s/i.test(trimmed)) seen.add(trimmed);
    }
  }
  return [...seen];
}
