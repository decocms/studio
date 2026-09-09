/**
 * Provider-backed implementations of the sandbox `/git/*` route contracts for
 * sandbox-less Fast Preview projects. The web's publish dialog and header
 * cluster speak the daemon's JSON shapes (`GitStatus`, `GitDiffResult` — see
 * apps/web .../sandbox-git-api.ts); serving the same shapes from a
 * `RepoContentClient` lets those components work UNCHANGED with no working
 * tree behind them.
 *
 * Invariants of sandbox-less mode that shape these payloads:
 * - There is no working tree: every save is already a commit on the branch,
 *   so local-work fields (modified/staged/unpushed/...) are always empty/0.
 * - "Publish" (sync-local-work) is therefore a no-op — the route answers OK
 *   without calling here.
 */

import {
  GitProviderError,
  RepoWriteConflict,
  repoErrorStatus,
  requireBranchHead,
  type FileChange,
  type RepoContentClient,
  type TreeEntry,
} from "@/git-providers";
import { mapBounded, resolveOrCreateHead } from "./read-decofile";

const DIFF_MAX_FILES = 200;
const DIFF_FETCH_CONCURRENCY = 12;

/** How a path changed between base and head, in the publish manifest. */
export type CompatChangeStatus = "added" | "modified" | "removed" | "renamed";

/** One changed path, without its content. See {@link CompatGitStatus.changedFiles}. */
export interface CompatChangedFile {
  path: string;
  status: CompatChangeStatus;
  /** Rename source; absent otherwise. */
  previousPath?: string;
}

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
  /**
   * The base…head changed-path manifest — every path {@link repoGitDiff}
   * would return a body for, without paying for the bodies. Free: the
   * provider's compare response already carries `files`, and asking for it
   * costs the SAME request the drift check already makes (identical URL, one
   * ETag entry). Sliced to {@link DIFF_MAX_FILES} so manifest and diff agree
   * key-for-key.
   */
  changedFiles: CompatChangedFile[];
  /** Changed-path count BEFORE the cap — what "N changes" must actually say. */
  changedFilesTotal: number;
  /** True when the cap dropped paths, so no caller offers an all-files action. */
  changedFilesTruncated: boolean;
}

/**
 * A provider's compare `status` vocabulary is wider than the three states the
 * CMS renders. `copied`/`changed`/`unchanged` fold into the nearest state the
 * publish surface can draw, rather than leaking an unhandled string into it.
 */
export function normalizeCompareStatus(raw: string): CompatChangeStatus {
  if (raw === "added" || raw === "copied") return "added";
  if (raw === "removed") return "removed";
  if (raw === "renamed") return "renamed";
  return "modified";
}

interface CompareDetail {
  aheadBy: number;
  behindBy: number;
  files: Array<{ filename: string; status: string; previousFilename?: string }>;
}

/** Pure fold from a compare response to the status payload. */
export function buildPublishStatus(args: {
  base: string;
  branch: string;
  headSha: string;
  compared: CompareDetail;
}): CompatGitStatus {
  const { base, branch, headSha, compared } = args;
  const changedFiles = compared.files.slice(0, DIFF_MAX_FILES).map((f) => ({
    path: f.filename,
    status: normalizeCompareStatus(f.status),
    ...(f.previousFilename ? { previousPath: f.previousFilename } : {}),
  }));
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
    aheadOfBase: compared.aheadBy,
    behindBase: compared.behindBy,
    headSha,
    unpushed: 0,
    changedFiles,
    changedFilesTotal: compared.files.length,
    changedFilesTruncated: compared.files.length > changedFiles.length,
  };
}

const NO_DRIFT: CompareDetail = { aheadBy: 0, behindBy: 0, files: [] };

/**
 * Compare `base…branch`, tolerating a branch that does not exist yet: on first
 * CMS touch the compare 404s, so the retry waits on `materialized` — the
 * concurrent {@link resolveOrCreateHead} that mints it — before asking again.
 */
async function compareAfterMaterializing(
  client: RepoContentClient,
  base: string,
  branch: string,
  materialized: Promise<unknown>,
): Promise<CompareDetail> {
  try {
    return await client.compareDetailed(base, branch);
  } catch (err) {
    if (repoErrorStatus(err) !== 404) throw err;
    await materialized;
    return client.compareDetailed(base, branch);
  }
}

/** The manifest rides free on the drift check: same URL, same ETag entry. */
export async function repoGitStatus(
  client: RepoContentClient,
  branch: string,
): Promise<CompatGitStatus> {
  const base = await client.getDefaultBranch();
  // Materialize thread-minted branches exactly like the decofile read does.
  if (base === branch) {
    const headSha = await resolveOrCreateHead(client, branch);
    return buildPublishStatus({ base, branch, headSha, compared: NO_DRIFT });
  }
  const materialized = resolveOrCreateHead(client, branch);
  const [headSha, compared] = await Promise.all([
    materialized,
    compareAfterMaterializing(client, base, branch, materialized),
  ]);
  return buildPublishStatus({ base, branch, headSha, compared });
}

/** Mirror of the daemon's diff JSON: full old/new contents per path. */
export interface CompatGitDiff {
  diffs: Record<string, { from: string | null; to: string | null }>;
  mergeBaseSha: string;
}

/**
 * Base…head diff with full file contents: head-side blobs come off the compare
 * entries, base-side contents are read by path at the merge base (see
 * {@link RepoContentClient.readFileAtRef}). Capped at {@link DIFF_MAX_FILES}.
 */
export async function repoGitDiff(
  client: RepoContentClient,
  branch: string,
  base?: string,
): Promise<CompatGitDiff> {
  const againstBase = base ?? (await client.getDefaultBranch());
  const detailed = await client.compareDetailed(againstBase, branch);
  const files = detailed.files.slice(0, DIFF_MAX_FILES);

  if (files.length === 0) {
    return { diffs: {}, mergeBaseSha: detailed.mergeBaseSha };
  }

  const entries = await mapBounded(files, DIFF_FETCH_CONCURRENCY, async (f) => {
    // A renamed file's base content lives at its previous path, not its new one.
    const basePath = f.previousFilename ?? f.filename;
    const [from, to] = await Promise.all([
      f.status === "added"
        ? null
        : client.readFileAtRef(detailed.mergeBaseSha, basePath),
      f.status === "removed" ? null : client.readBlob(f.sha),
    ]);
    return [f.filename, { from, to }] as const;
  });

  return {
    diffs: Object.fromEntries(entries),
    mergeBaseSha: detailed.mergeBaseSha,
  };
}

/** One entry of a provider compare's changed-file list. */
type ComparedFile = Awaited<
  ReturnType<RepoContentClient["compareDetailed"]>
>["files"][number];

/**
 * Bring the branch up to date with `base`, leaving it as ONE commit whose only
 * parent is the base head — a squash-rebase, not a merge, because a merge's
 * resolution lives only in its tree and `git rebase` drops merge commits.
 * Clean merges replay the merged content; a conflict replays the branch's own
 * blobs (whole file wins) for every path it touched.
 *
 * The squash is a single `commitFiles({ rewriteFrom: baseHead })`, so the
 * commit exists before the branch is moved onto it and a crash mid-sync cannot
 * leave the branch reset with its own head unreferenced. What is left to undo
 * is the merge commit `mergeBranches` put on the branch on its way here
 * ({@link restoreAbandonedSync}).
 */
export async function repoGitRebase(
  client: RepoContentClient,
  branch: string,
  base: string,
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    // Read first: the write's own guard re-reads it, catching a later autosave.
    const [branchHead, compared] = await Promise.all([
      requireBranchHead(client, branch),
      client.compareDetailed(base, branch),
    ]);

    // Already one commit on base: nothing to bring in, nothing to flatten.
    if (compared.behindBy === 0 && compared.aheadBy <= 1) return;

    // Not hoisted into the pair above: pure waste on that early return.
    const baseHead = await requireBranchHead(client, base);

    // No commits of its own: a fast-forward, so nothing of the branch is lost.
    if (compared.aheadBy === 0) {
      if ((await requireBranchHead(client, branch)) !== branchHead) {
        if (attempt < MERGE_CAS_ATTEMPTS) continue;
        throw keptChanging(client, branch, base);
      }
      await client.forceBranchHead(branch, baseHead);
      return;
    }

    let replayed: ComparedFile[];
    let branchWon = false;
    // `mergeBranches` moves the ref onto the merge commit it creates.
    let mergedSha: string | null = null;
    try {
      mergedSha = await client.mergeBranches(
        branch,
        base,
        `chore(decofile): merge ${base} into ${branch}`,
      );
      /** A null merge means the branch already contains base and only needs
       *  flattening, so its own three-dot diff already names the content to
       *  replay; otherwise the merge commit's does. */
      replayed =
        mergedSha === null
          ? compared.files
          : (await client.compareDetailed(base, branch)).files;
    } catch (err) {
      if (repoErrorStatus(err) !== 409) throw err;
      replayed = compared.files;
      branchWon = true;
    }
    // Raised here, not inside the try: a 409 there means the merge conflicted.
    assertReplayable(client, replayed);
    const changes = buildMergeReplayPlan(replayed, mergedSha ?? branchHead);

    const expectedHead = mergedSha ?? branchHead;
    try {
      /** Nothing differs from base: the branch's tree already IS base's, so
       *  the reset alone is the sync and a commit would only carry a message. */
      if (changes.length === 0) {
        if ((await requireBranchHead(client, branch)) !== expectedHead) {
          if (attempt < MERGE_CAS_ATTEMPTS) continue;
          throw keptChanging(client, branch, base);
        }
        await client.forceBranchHead(branch, baseHead);
        return;
      }
      await client.commitFiles({
        branch,
        message: squashMessage(
          branch,
          base,
          branchWon,
          compared.commitMessages,
        ),
        expectedHead,
        rewriteFrom: baseHead,
        changes,
      });
      return;
    } catch (err) {
      // An autosave landed mid-sync: rebuild on the new head, never over it.
      if (err instanceof RepoWriteConflict && attempt < MERGE_CAS_ATTEMPTS) {
        continue;
      }
      await restoreAbandonedSync(client, branch, mergedSha, branchHead);
      throw err instanceof RepoWriteConflict
        ? keptChanging(client, branch, base)
        : err;
    }
  }
}

/**
 * The replay names one path per changed file, and the compare it is built from
 * enumerates at most this many (GitHub truncates there, and every provider
 * caps a diff somewhere) — so at the cap the list may be partial, and a partial
 * replay would silently revert the paths it never saw. Hence `>=`, and hence a
 * refusal rather than a best effort: a branch that far from base is a merge to
 * resolve on the provider.
 */
const MERGE_REPLAY_FILE_CAP = 300;

const MERGE_CAS_ATTEMPTS = 3;

function assertReplayable(
  client: RepoContentClient,
  files: ComparedFile[],
): void {
  if (files.length < MERGE_REPLAY_FILE_CAP) return;
  throw new GitProviderError({
    provider: client.repo.provider,
    status: 409,
    message: `Too many changed files on the branch to auto-merge (${files.length}); resolve it on ${client.repo.host}`,
  });
}

function keptChanging(
  client: RepoContentClient,
  branch: string,
  base: string,
): GitProviderError {
  return new GitProviderError({
    provider: client.repo.provider,
    status: 409,
    message: `${branch} kept changing while syncing with ${base}; try again`,
  });
}

/**
 * The replay plan for a sync, deduped by path: every surviving path takes the
 * version `sourceRef` has, which is the resolution the merge (or the branch)
 * already computed — addressed by ref rather than read, so the write reuses
 * blobs the repository holds and each path keeps its own file mode.
 *
 * A path can be BOTH a rename destination for one file and a rename source for
 * another in the same diff (e.g. `Hero.json`→`Header.json` while
 * `Banner.json`→`Hero.json`) — the write applies the LAST entry for a duplicate
 * path, so pushing both a create and a stale-source delete for the same path
 * let iteration order decide whether the renamed-in content survived. A
 * destination entry always describes the path's real final content, so it
 * always wins; a source delete only applies when nothing else claims that path
 * as its destination.
 */
export function buildMergeReplayPlan(
  files: Array<{
    filename: string;
    status: string;
    previousFilename?: string;
  }>,
  sourceRef: string,
): FileChange[] {
  const byPath = new Map<string, FileChange>();
  for (const f of files) {
    byPath.set(
      f.filename,
      f.status === "removed"
        ? { path: f.filename, deleted: true }
        : { path: f.filename, copyFromRef: sourceRef },
    );
  }
  for (const f of files) {
    if (
      f.previousFilename &&
      f.previousFilename !== f.filename &&
      !byPath.has(f.previousFilename)
    ) {
      byPath.set(f.previousFilename, {
        path: f.previousFilename,
        deleted: true,
      });
    }
  }
  return [...byPath.values()];
}

/**
 * The replay plan for a discard: take each path back from `baseRef`, or delete
 * it when the base doesn't have it either. Addressed by ref, so a discarded
 * executable comes back executable rather than as a plain file. Pure, so it's
 * unit-tested without a `RepoContentClient`.
 */
export function buildDiscardPlan(
  filepaths: string[],
  baseBlobByPath: Map<string, TreeEntry>,
  headBlobByPath: Map<string, TreeEntry>,
  baseRef: string,
): FileChange[] {
  const entries: FileChange[] = [];
  for (const path of filepaths) {
    const baseBlob = baseBlobByPath.get(path);
    const headBlob = headBlobByPath.get(path);
    // Already at the base content (or absent on both sides): nothing to do.
    if (baseBlob?.sha === headBlob?.sha) continue;
    // Neither side has it: there is nothing to reset and nothing to delete.
    if (!baseBlob && !headBlob) continue;
    entries.push(
      baseBlob ? { path, copyFromRef: baseRef } : { path, deleted: true },
    );
  }
  return entries;
}

/**
 * Discard the branch's changes to `filepaths`: a new commit on the branch that
 * resets each path to its content at the merge base with the default branch
 * (or deletes it when it did not exist there). The sandbox-less equivalent of
 * the daemon's working-tree discard — in Fast Preview every edit is already a
 * commit, so undoing one is a commit too. Guarded on the head it was built
 * against, so an autosave landing mid-discard is never clobbered.
 */
export async function repoGitDiscard(
  client: RepoContentClient,
  branch: string,
  filepaths: string[],
): Promise<void> {
  if (filepaths.length === 0) return;
  const base = await client.getDefaultBranch();
  for (let attempt = 1; ; attempt++) {
    const branchHead = await requireBranchHead(client, branch);
    const { mergeBaseSha } = await client.compareDetailed(base, branch);
    // Scoped to `filepaths`, not a whole-repo recursive read.
    const [baseBlobByPath, headBlobByPath] = await Promise.all([
      client.getEntriesAtPaths(mergeBaseSha, filepaths),
      client.getEntriesAtPaths(branchHead, filepaths),
    ]);

    const plan = buildDiscardPlan(
      filepaths,
      baseBlobByPath,
      headBlobByPath,
      mergeBaseSha,
    );
    if (plan.length === 0) return;

    try {
      await client.commitFiles({
        branch,
        message: `chore(decofile): discard changes to ${plan.length} file(s)`,
        expectedHead: branchHead,
        changes: plan,
      });
      return;
    } catch (err) {
      if (err instanceof RepoWriteConflict && attempt < MERGE_CAS_ATTEMPTS) {
        continue;
      }
      throw err;
    }
  }
}

/**
 * `mergeBranches` advances the branch ref before the squash can replace it.
 * When the squash then fails, roll the ref back so a sync that reported failure
 * leaves no merge commit behind — but only while nothing else has landed on it,
 * since a rollback is itself a force.
 */
async function restoreAbandonedSync(
  client: RepoContentClient,
  branch: string,
  mergedSha: string | null,
  branchHead: string,
): Promise<void> {
  if (mergedSha === null) return;
  try {
    if ((await requireBranchHead(client, branch)) !== mergedSha) return;
    await client.forceBranchHead(branch, branchHead);
  } catch {
    // Best effort: the caller needs to see the original failure, not this one.
  }
}

/**
 * Collapsing N commits into one would drop the `Co-authored-by:` trailers the
 * coalescer stamps per editor, and those trailers are how the provider
 * attributes the work. Re-emit the distinct ones on the squash.
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
