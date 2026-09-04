/**
 * `RepoContentClient` over GitLab's REST v4 API.
 *
 * GitLab exposes no Git Data plumbing (no create-blob / create-tree /
 * create-commit / move-ref), which is exactly why the interface is stated as
 * intentions: what GitHub does in four calls, GitLab does in one
 * `POST /repository/commits` carrying an action per file. The read side maps
 * almost one-to-one — GitLab's tree entries already carry full repo-relative
 * paths and their object sha (`id`), and a commit sha is accepted wherever a
 * ref is.
 *
 * Where GitLab cannot express the interface's wording, the gap is documented
 * on the method: branch-level compare-and-swap (`commitFiles`), moving a
 * branch to an arbitrary sha (`forceBranchHead`), rewriting a branch's history
 * (`rewriteBranch`), pointing a commit at a blob that already exists
 * (`resolveCopies`), merging without a merge request (`mergeBranches`), and
 * blob sizes in a tree listing (`listDecofileEntries`).
 *
 * The request plumbing (bearer auth, 15s timeout, 404 → null, every other
 * non-2xx → `GitProviderError` with a rate-limit hint) is `gitlab/http.ts`,
 * shared with the provider and change-request clients.
 */

import type { RepoRef } from "@decocms/shared/git-providers";
import { retry, RetryError } from "@decocms/shared/std";
import {
  encodeFilePath,
  encodeProjectPath,
  GitlabProviderClient,
} from "./client";
import { gitlabApiBaseUrl, gitlabFailure } from "./http";
import { GitProviderError, type TokenSource } from "../types";
import {
  type BranchPage,
  type ChangeRequestInfo,
  type FileChange,
  type FileMode,
  type RepoContentClient,
  RepoWriteConflict,
  type TreeEntry,
} from "../content";

/** Matches `gitlab/client.ts`: one REST call, not a download. */
const REQUEST_TIMEOUT_MS = 15_000;
const TREE_PAGE_SIZE = 100;
/** 100 pages × 100 entries — a directory past that is a bug, not a repo. */
const MAX_TREE_PAGES = 100;
/**
 * Per-file metadata reads (`last_commit_id`) and per-directory tree listings
 * fan out; this bounds the burst so a 300-block commit does not trip GitLab's
 * rate limiter.
 */
const FANOUT_CONCURRENCY = 8;

/**
 * A forced rewrite refused because the branch is protected — the one failure
 * that has a slower answer (replace the branch) rather than being fatal.
 */
export function isProtectedBranch(message: string): boolean {
  return /not allowed to force push|protected branch/i.test(message);
}

/** GitLab's tree listing row. `id` IS the object sha; `path` is repo-relative. */
interface GitlabTreeRow {
  id: string;
  name: string;
  type: "blob" | "tree";
  path: string;
}

interface GitlabMergeRequestRow {
  iid: number;
  web_url?: string | null;
  title?: string | null;
  state?: string | null;
  sha?: string | null;
  merge_commit_sha?: string | null;
}

/** One entry of `POST /repository/commits`'s `actions` array. */
export interface GitlabCommitAction {
  action: "create" | "update" | "delete";
  file_path: string;
  content?: string;
  /**
   * The exec bit, sent only when the caller stated a mode — omitted, GitLab
   * keeps whatever the path already had, which is what every write that does
   * not care about the mode wants.
   */
  execute_filemode?: boolean;
  /**
   * The last commit that touched this file, as read just before the write.
   * GitLab rejects the whole commit when the file moved since — see
   * `commitFiles` for why both this and the branch-head check are needed.
   */
  last_commit_id?: string;
}

/**
 * A change with its bytes in hand. GitLab cannot point a commit at a blob
 * that already exists, so a `copyFromRef` change is read into `content`
 * (carrying the source's mode) before the action array is built.
 */
export type ResolvedChange =
  | { path: string; content: string; mode?: FileMode }
  | { path: string; deleted: true };

/**
 * The `actions` array for a set of changes, given what each path looked like
 * at the base commit: a `string` is the file's `last_commit_id` (it exists), a
 * `null`/absent entry means it does not exist there.
 *
 * - existing + content → `update`, guarded by `last_commit_id`
 * - absent + content → `create`, unguarded (there is nothing to guard against;
 *   GitLab rejects a `create` on a path that appeared meanwhile, which the
 *   conflict classifier turns back into a `RepoWriteConflict`)
 * - existing + deleted → `delete`, guarded
 * - absent + deleted → omitted; deleting what is not there is a no-op, and
 *   GitLab would fail the entire atomic commit over it
 *
 * Two changes to one path collapse to the last one, keeping the first
 * occurrence's position so the action array is deterministic.
 */
export function buildCommitActions(
  changes: readonly ResolvedChange[],
  lastCommitIdByPath: ReadonlyMap<string, string | null>,
): GitlabCommitAction[] {
  const collapsed = new Map<string, ResolvedChange>();
  for (const change of changes) collapsed.set(change.path, change);

  const actions: GitlabCommitAction[] = [];
  for (const [path, change] of collapsed) {
    const lastCommitId = lastCommitIdByPath.get(path) ?? null;
    if ("deleted" in change) {
      if (lastCommitId === null) continue;
      actions.push({
        action: "delete",
        file_path: path,
        last_commit_id: lastCommitId,
      });
      continue;
    }
    const mode =
      change.mode === undefined
        ? {}
        : { execute_filemode: change.mode === "100755" };
    actions.push(
      lastCommitId === null
        ? {
            action: "create",
            file_path: path,
            content: change.content,
            ...mode,
          }
        : {
            action: "update",
            file_path: path,
            content: change.content,
            ...mode,
            last_commit_id: lastCommitId,
          },
    );
  }
  return actions;
}

/**
 * Whether a refused commit means "someone else wrote first" rather than "this
 * request was wrong". GitLab answers 400 for all three shapes of a lost race:
 * the per-file guard fired, a `create` found the path already taken, or an
 * `update`/`delete` found it gone.
 */
export function isCommitConflict(status: number, message: string): boolean {
  if (status !== 400 && status !== 409) return false;
  return (
    /has changed since you started editing it/i.test(message) ||
    /file with this name already exists/i.test(message) ||
    /file with this name doesn'?t exist/i.test(message)
  );
}

/** `POST /repository/branches` on a name that is taken answers 400. */
export function isBranchExistsConflict(
  status: number,
  message: string,
): boolean {
  return status === 400 && /already exists/i.test(message);
}

/**
 * GitLab's merge-request states, in the interface's vocabulary. `locked` is a
 * merge in progress that GitLab has already taken out of the open set, and an
 * unrecognised state is reported as closed rather than as actionable.
 */
export function mapMergeRequestState(
  state: string | null | undefined,
): ChangeRequestInfo["state"] {
  if (state === "opened") return "open";
  if (state === "merged") return "merged";
  return "closed";
}

export function mapMergeRequest(mr: GitlabMergeRequestRow): ChangeRequestInfo {
  return {
    number: mr.iid,
    url: mr.web_url ?? "",
    title: mr.title ?? "",
    state: mapMergeRequestState(mr.state),
  };
}

/** Repo-relative directory of `path`; `""` for a file at the repo root. */
export function directoryOf(path: string): string {
  const normalized = path.replace(/^\/+/, "");
  const slash = normalized.lastIndexOf("/");
  return slash === -1 ? "" : normalized.slice(0, slash);
}

/**
 * Paths bucketed by the directory they live in, deduplicated, insertion
 * ordered. One bucket is one tree listing, which is what keeps
 * `getEntriesAtPaths` scaling with the path set instead of with repo size.
 */
export function groupPathsByDirectory(
  paths: readonly string[],
): Map<string, string[]> {
  const byDir = new Map<string, string[]>();
  const seen = new Set<string>();
  for (const raw of paths) {
    const path = raw.replace(/^\/+/, "");
    if (path === "" || seen.has(path)) continue;
    seen.add(path);
    const dir = directoryOf(path);
    const bucket = byDir.get(dir);
    if (bucket) bucket.push(path);
    else byDir.set(dir, [path]);
  }
  return byDir;
}

/** `<packagePath>/.deco`, or `.deco` for a single-project repo. */
export function decoDirFor(packagePath: string | null): string {
  return packagePath ? `${packagePath}/.deco` : ".deco";
}

interface GitlabCompareDiff {
  new_path: string;
  old_path?: string | null;
  new_file?: boolean;
  deleted_file?: boolean;
  renamed_file?: boolean;
}

/**
 * One compare diff in the interface's file shape. GitLab reports the change
 * as three booleans instead of a status word, and reports no per-file blob
 * sha at all — `shaByPath` carries the shas resolved from the tree at `head`,
 * and a deleted path (absent there by definition) keeps `sha: ""`.
 */
export function mapCompareDiff(
  diff: GitlabCompareDiff,
  shaByPath: ReadonlyMap<string, string>,
): {
  filename: string;
  status: string;
  sha: string;
  previousFilename?: string;
} {
  const status = diff.new_file
    ? "added"
    : diff.deleted_file
      ? "removed"
      : diff.renamed_file
        ? "renamed"
        : "modified";
  return {
    filename: diff.new_path,
    status,
    sha: shaByPath.get(diff.new_path) ?? "",
    ...(diff.renamed_file && diff.old_path
      ? { previousFilename: diff.old_path }
      : {}),
  };
}

/**
 * `fn` over `items`, at most `concurrency` in flight, results in input order.
 * Pure scheduling — the caller supplies the I/O.
 */
export async function pooledMap<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      out[index] = await fn(items[index] as T);
    }
  };
  const workers = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: workers }, worker));
  return out;
}

interface CallInit {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  accept?: string;
}

export class GitlabContentClient implements RepoContentClient {
  readonly repo: RepoRef;
  private readonly apiBase: string;
  private readonly projectBase: string;
  /** Owns token minting and the archive download; both are already solved there. */
  private readonly provider: GitlabProviderClient;
  private defaultBranch: string | null = null;

  constructor(params: { repo: RepoRef; tokenSource: TokenSource }) {
    this.repo = params.repo;
    this.apiBase = gitlabApiBaseUrl(params.repo.host);
    this.projectBase = `/projects/${encodeProjectPath(params.repo.path)}`;
    this.provider = new GitlabProviderClient({
      host: params.repo.host,
      tokenSource: params.tokenSource,
    });
  }

  async getDefaultBranch(): Promise<string> {
    if (this.defaultBranch) return this.defaultBranch;
    const project = await this.json<{ default_branch?: string | null }>(
      this.projectBase,
    );
    if (project === null) {
      throw new GitProviderError({
        provider: "gitlab",
        status: 404,
        message: `GitLab project ${this.repo.path} not found`,
      });
    }
    if (!project.default_branch) {
      throw new GitProviderError({
        provider: "gitlab",
        status: 409,
        message: `GitLab project ${this.repo.path} has no default branch (empty repository)`,
      });
    }
    this.defaultBranch = project.default_branch;
    return this.defaultBranch;
  }

  async getBranch(
    branch: string,
  ): Promise<{ sha: string; committedAt: string } | null> {
    const json = await this.json<{
      commit?: { id?: string; committed_date?: string };
    }>(`${this.projectBase}/repository/branches/${encodeRef(branch)}`);
    const commit = json?.commit;
    if (!commit?.id) return null;
    if (!commit.committed_date) {
      throw new GitProviderError({
        provider: "gitlab",
        status: 502,
        message: `GitLab branch ${branch} came back without a commit date`,
      });
    }
    return { sha: commit.id, committedAt: commit.committed_date };
  }

  /**
   * GitLab filters branch names server-side with `search`, so this is one
   * request. `x-total` carries the true match count for offset pagination;
   * when GitLab omits it (a very large project, where it stops counting) the
   * returned page's length is the honest lower bound.
   *
   * `author` is the head commit's author NAME, not an account login — GitLab's
   * branch listing carries no user object. The neutral field is nullable and
   * only ever displayed, so a name is the right answer rather than null.
   */
  async searchBranches(params: {
    query: string;
    limit: number;
    cursor?: string | null;
  }): Promise<BranchPage> {
    // GitLab pages by number, so the opaque cursor IS the next page number.
    const page = Number(params.cursor) || 1;
    const res = await this.call(
      `${this.projectBase}/repository/branches` +
        `?search=${encodeURIComponent(params.query)}` +
        `&per_page=${Math.min(params.limit, TREE_PAGE_SIZE)}&page=${page}`,
    );
    if (res === null) {
      return { branches: [], totalCount: 0, nextCursor: null };
    }
    const rows = (await res.json()) as Array<{
      name?: string;
      commit?: { author_name?: string | null };
    }>;
    const branches = rows.flatMap((row) =>
      typeof row.name === "string"
        ? [{ name: row.name, author: row.commit?.author_name ?? null }]
        : [],
    );
    const total = Number(res.headers.get("x-total"));
    const nextPage = res.headers.get("x-next-page");
    return {
      branches,
      totalCount: Number.isFinite(total) ? total : branches.length,
      nextCursor: nextPage ? nextPage : null,
    };
  }

  getArchive(ref: string): Promise<ReadableStream<Uint8Array> | null> {
    return this.provider.archiveTarball(this.repo, ref);
  }

  /**
   * GitLab addresses subtrees by path, so this is at most two listings: the
   * `.deco/` directory (which reveals whether the merged artifact is
   * committed) and `.deco/blocks/`. Direct blob children are returned
   * unfiltered, exactly as the GitHub implementation does — `blockEntriesInTree`
   * downstream applies the `*.json` rule, and diverging here would make the two
   * providers disagree about what a decofile tree contains.
   */
  async listDecofileEntries(
    treeish: string,
    packagePath: string | null,
  ): Promise<TreeEntry[]> {
    const decoDir = decoDirFor(packagePath);
    const children = await this.listTree(treeish, decoDir);
    const out: TreeEntry[] = [];
    const gen = children.find(
      (entry) =>
        entry.type === "blob" && entry.path === `${decoDir}/blocks.gen.json`,
    );
    if (gen) out.push(gen);
    const hasBlocksDir = children.some(
      (entry) => entry.type === "tree" && entry.path === `${decoDir}/blocks`,
    );
    if (!hasBlocksDir) return out;
    for (const child of await this.listTree(treeish, `${decoDir}/blocks`)) {
      if (child.type === "blob") out.push(child);
    }
    return out;
  }

  async getEntriesAtPaths(
    treeish: string,
    paths: string[],
  ): Promise<Map<string, TreeEntry>> {
    const byDir = groupPathsByDirectory(paths);
    const listings = await pooledMap(
      [...byDir.keys()],
      FANOUT_CONCURRENCY,
      (dir) => this.listTree(treeish, dir),
    );
    const result = new Map<string, TreeEntry>();
    let index = 0;
    for (const wanted of byDir.values()) {
      const byPath = new Map(
        (listings[index++] ?? []).map((entry) => [entry.path, entry]),
      );
      for (const path of wanted) {
        const entry = byPath.get(path);
        if (entry?.type === "blob") result.set(path, entry);
      }
    }
    return result;
  }

  async readBlob(sha: string): Promise<string> {
    const res = await this.call(
      `${this.projectBase}/repository/blobs/${encodeURIComponent(sha)}/raw`,
      { accept: "text/plain, */*" },
    );
    if (res === null) {
      throw new GitProviderError({
        provider: "gitlab",
        status: 404,
        message: `GitLab blob ${sha} not found in ${this.repo.path}`,
      });
    }
    return res.text();
  }

  async readFileAtRef(ref: string, path: string): Promise<string | null> {
    const res = await this.call(
      `${this.projectBase}/repository/files/${encodeFilePath(path)}/raw?ref=${encodeURIComponent(ref)}`,
      { accept: "text/plain, */*" },
    );
    return res === null ? null : res.text();
  }

  /**
   * One atomic `POST /repository/commits`, guarded twice. `branch` must
   * already exist — creating one as a side effect of a write (GitLab's
   * `start_branch`) is `createBranch`'s job, not this one's.
   *
   * `expectedHead` is a branch-level compare-and-swap and GitLab has none: its
   * only optimistic lock is per file, `actions[].last_commit_id`. So both
   * layers run. The head read catches the common case for the price of one
   * request, before any content is uploaded, and covers changes to files this
   * commit does not touch (a rebase, someone else's block). The per-file guards
   * close the window the head read leaves open — between reading the head and
   * GitLab applying the commit — for exactly the files being written, and are
   * enforced inside GitLab's own transaction, which no check of ours can be.
   * Neither is sufficient alone; a 400 naming the changed file is translated
   * back into `RepoWriteConflict` so the coalescer rebuilds and retries rather
   * than clobbering the other writer.
   *
   * `rewriteFrom` cannot be a ref move here at all — see {@link rewriteBranch}.
   * Either way a commit costs one metadata read per path, plus one content read
   * per `copyFromRef` path: GitLab has no tree write, so every byte of every
   * changed file travels, however little of it changed.
   */
  async commitFiles(params: {
    branch: string;
    message: string;
    expectedHead: string | null;
    rewriteFrom?: string;
    changes: FileChange[];
  }): Promise<{ sha: string }> {
    const { branch, message, expectedHead, rewriteFrom } = params;
    const head = await this.getBranch(branch);
    if (expectedHead !== null && head?.sha !== expectedHead) {
      throw new RepoWriteConflict(
        `GitLab branch ${branch} is at ${head?.sha ?? "(absent)"}, expected ${expectedHead}`,
      );
    }
    const changes = await this.resolveCopies(params.changes);
    if (rewriteFrom !== undefined) {
      return this.rewriteBranch({
        branch,
        message,
        expectedHead,
        rewriteFrom,
        changes,
      });
    }
    /** Pin the metadata reads to the sha the guard just approved, not to the
     * branch name, so a push landing mid-fanout cannot feed us its ids. */
    const base = head?.sha ?? branch;
    const sha = await this.commitOnto({ branch, base, message, changes });
    if (sha === null) {
      if (head === null) {
        throw new GitProviderError({
          provider: "gitlab",
          status: 404,
          message: `GitLab branch ${branch} does not exist in ${this.repo.path}`,
        });
      }
      return { sha: head.sha };
    }
    return { sha };
  }

  /**
   * A history rewrite.
   *
   * `POST /repository/commits` does it in ONE atomic call given `start_sha` +
   * `force: true` — measured against gitlab.com: 201, one commit parented on
   * `start_sha`, the branch's former content gone. That is the path taken, and
   * it has no window at all.
   *
   * A PROTECTED branch refuses it ("You are not allowed to force push code to
   * a protected branch"), and `main` is protected by default. Only then does
   * this fall back to replacing the branch: build the commit on a throwaway
   * first so the content exists before the target is touched, then delete and
   * recreate the target at it. That fallback is what costs a window — the
   * branch briefly does not exist, and a crash there leaves it missing — and
   * it fails too if the protection also blocks deletion.
   *
   * Without `force`, committing onto an existing branch from an earlier
   * `start_sha` is refused outright: 400 "A branch called 'x' already exists."
   */
  private async rewriteBranch(params: {
    branch: string;
    message: string;
    expectedHead: string | null;
    rewriteFrom: string;
    changes: readonly ResolvedChange[];
  }): Promise<{ sha: string }> {
    const { branch, message, expectedHead, rewriteFrom, changes } = params;

    await this.assertHeadIs(branch, expectedHead);
    const forced = await this.commitOnto({
      branch,
      base: rewriteFrom,
      message,
      changes,
      startSha: rewriteFrom,
      force: true,
    }).catch((cause: unknown) => {
      if (
        cause instanceof GitProviderError &&
        isProtectedBranch(cause.message)
      ) {
        return undefined;
      }
      throw cause;
    });
    if (forced !== undefined) return { sha: forced ?? rewriteFrom };

    const staging = `studio-rewrite-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
    await this.createBranch(staging, rewriteFrom);
    let sha: string;
    try {
      sha =
        (await this.commitOnto({
          branch: staging,
          base: rewriteFrom,
          message,
          changes,
        })) ?? rewriteFrom;
      /** Re-read as late as possible: the guard has to hold when the target is
       * replaced, not when this call started. */
      const current = await this.getBranch(branch);
      if (expectedHead !== null && current?.sha !== expectedHead) {
        throw new RepoWriteConflict(
          `GitLab branch ${branch} moved to ${current?.sha ?? "(absent)"} while rewriting it`,
        );
      }
    } catch (cause) {
      await this.deleteBranch(staging).catch(() => {});
      throw cause;
    }
    await this.deleteBranch(branch);
    await this.createBranchAt(branch, sha);
    await this.deleteBranch(staging).catch(() => {});
    return { sha };
  }

  /**
   * The branch-level half of the guard, read as late as the caller allows.
   * Cheap, and it covers the files a commit does not touch — the per-file
   * `last_commit_id` closes the rest.
   */
  private async assertHeadIs(
    branch: string,
    expectedHead: string | null,
  ): Promise<void> {
    if (expectedHead === null) return;
    const current = await this.getBranch(branch);
    if (current?.sha !== expectedHead) {
      throw new RepoWriteConflict(
        `GitLab branch ${branch} is at ${current?.sha ?? "(absent)"}, not ${expectedHead}`,
      );
    }
  }

  /**
   * One atomic `POST /repository/commits` on `branch`, with the per-file
   * guards read at `base`. Null when the changes reduce to nothing (deletes
   * for paths that are already gone) — there is no commit to make, and GitLab
   * refuses an empty action array.
   */
  private async commitOnto(params: {
    branch: string;
    base: string;
    message: string;
    changes: readonly ResolvedChange[];
    /** Rewrites `branch` onto this sha instead of appending to its head. */
    startSha?: string;
    force?: boolean;
  }): Promise<string | null> {
    const { branch, base, message, changes, startSha, force } = params;
    const paths = [...new Set(changes.map((change) => change.path))];
    const lastCommitIds = new Map(
      await pooledMap(
        paths,
        FANOUT_CONCURRENCY,
        async (path) =>
          [path, await this.lastCommitIdFor(base, path)] as [
            string,
            string | null,
          ],
      ),
    );
    const actions = buildCommitActions(changes, lastCommitIds);
    if (actions.length === 0) return null;

    let json: { id?: string } | null;
    try {
      json = await this.json<{ id?: string }>(
        `${this.projectBase}/repository/commits`,
        {
          method: "POST",
          body: {
            branch,
            commit_message: message,
            actions,
            ...(startSha ? { start_sha: startSha } : {}),
            ...(force ? { force: true } : {}),
          },
        },
      );
    } catch (cause) {
      if (
        cause instanceof GitProviderError &&
        isCommitConflict(cause.status, cause.message)
      ) {
        throw new RepoWriteConflict(
          `GitLab refused the commit on ${branch}: ${cause.message}`,
          { cause },
        );
      }
      throw cause;
    }
    if (!json?.id) {
      throw new GitProviderError({
        provider: "gitlab",
        status: 502,
        message: `GitLab accepted the commit on ${branch} without returning a sha`,
      });
    }
    return json.id;
  }

  /**
   * `copyFromRef` changes, read into content. One call per path serves both
   * halves of the copy: GitLab's file endpoint carries the base64 body AND the
   * exec bit, so the source's mode rides along instead of costing a tree read.
   */
  private resolveCopies(
    changes: readonly FileChange[],
  ): Promise<ResolvedChange[]> {
    return pooledMap(
      changes,
      FANOUT_CONCURRENCY,
      async (change): Promise<ResolvedChange> => {
        if (!("copyFromRef" in change)) return change;
        const source = await this.fileAtRef(change.copyFromRef, change.path);
        if (source === null) {
          throw new GitProviderError({
            provider: "gitlab",
            status: 404,
            message: `${change.path} does not exist at ${change.copyFromRef} in ${this.repo.path}`,
          });
        }
        return {
          path: change.path,
          content: source.content,
          mode: change.mode ?? source.mode,
        };
      },
    );
  }

  async createBranch(branch: string, sha: string): Promise<void> {
    try {
      await this.createBranchAt(branch, sha);
    } catch (cause) {
      if (
        cause instanceof GitProviderError &&
        isBranchExistsConflict(cause.status, cause.message)
      ) {
        throw new RepoWriteConflict(
          `GitLab branch ${branch} already exists in ${this.repo.path}`,
          { cause },
        );
      }
      throw cause;
    }
  }

  /**
   * GitLab has no ref-update endpoint at all: a branch can only be created or
   * deleted, never repointed. So this deletes and recreates, which is NOT
   * atomic — between the two calls the branch does not exist, and a concurrent
   * reader sees a 404 rather than the old sha. Two consequences worth knowing:
   * a protected branch refuses the delete (403, with GitLab's own message
   * surfaced), and a failure after the delete leaves the branch missing rather
   * than stale. The interface already declares this method unguarded, so the
   * caller re-reads the head before calling either way.
   */
  async forceBranchHead(branch: string, sha: string): Promise<void> {
    await this.deleteBranch(branch);
    await this.createBranchAt(branch, sha);
  }

  /**
   * GitLab has no merge endpoint on the repository — merging means opening a
   * merge request and merging it, so this leaves an MR behind where GitHub
   * leaves nothing. An open MR for the same source/target is reused instead of
   * creating a duplicate (GitLab rejects the second one anyway).
   */
  async mergeBranches(
    base: string,
    head: string,
    message: string,
  ): Promise<string | null> {
    const ahead = await this.compareRaw(base, head);
    if (ahead.commits.length === 0) return null;
    const title = message.split("\n")[0] || message;
    const mr =
      (await this.findOpenChangeRequest(base, head)) ??
      (await this.createChangeRequest({ base, head, title }));
    return this.mergeChangeRequest(mr.number, base, message);
  }

  async createChangeRequest(params: {
    base: string;
    head: string;
    title: string;
  }): Promise<ChangeRequestInfo> {
    const json = await this.json<GitlabMergeRequestRow>(
      `${this.projectBase}/merge_requests`,
      {
        method: "POST",
        body: {
          source_branch: params.head,
          target_branch: params.base,
          title: params.title,
        },
      },
    );
    if (!json) {
      throw new GitProviderError({
        provider: "gitlab",
        status: 404,
        message: `GitLab project ${this.repo.path} not found`,
      });
    }
    return mapMergeRequest(json);
  }

  async findOpenChangeRequest(
    base: string,
    head: string,
  ): Promise<ChangeRequestInfo | null> {
    const query = new URLSearchParams({
      state: "opened",
      source_branch: head,
      target_branch: base,
      per_page: "1",
    });
    const json = await this.json<GitlabMergeRequestRow[]>(
      `${this.projectBase}/merge_requests?${query}`,
    );
    const first = Array.isArray(json) ? json[0] : undefined;
    return first ? mapMergeRequest(first) : null;
  }

  /**
   * GitLab's compare is one-directional, so "how far apart" costs two calls —
   * `base..head` for ahead, `head..base` for behind.
   */
  async compare(
    base: string,
    head: string,
  ): Promise<{ aheadBy: number; behindBy: number }> {
    const [ahead, behind] = await Promise.all([
      this.compareRaw(base, head),
      this.compareRaw(head, base),
    ]);
    return {
      aheadBy: ahead.commits.length,
      behindBy: behind.commits.length,
    };
  }

  async compareDetailed(
    base: string,
    head: string,
  ): Promise<{
    aheadBy: number;
    behindBy: number;
    mergeBaseSha: string;
    files: Array<{
      filename: string;
      status: string;
      sha: string;
      previousFilename?: string;
    }>;
    commitMessages: string[];
  }> {
    const [ahead, behind, mergeBaseSha] = await Promise.all([
      this.compareRaw(base, head),
      this.compareRaw(head, base),
      this.mergeBaseSha(base, head),
    ]);
    /** GitLab's diffs carry no blob sha, so resolve the surviving paths from
     * the tree at `head` — one listing per distinct directory. */
    const survivors = ahead.diffs
      .filter((diff) => !diff.deleted_file)
      .map((diff) => diff.new_path);
    const entries = await this.getEntriesAtPaths(head, survivors);
    const shaByPath = new Map(
      [...entries].map(([path, entry]) => [path, entry.sha]),
    );
    return {
      aheadBy: ahead.commits.length,
      behindBy: behind.commits.length,
      mergeBaseSha,
      files: ahead.diffs.map((diff) => mapCompareDiff(diff, shaByPath)),
      commitMessages: ahead.commits
        .map((commit) => commit.title ?? "")
        .filter((title) => title.length > 0),
    };
  }

  private async createBranchAt(branch: string, sha: string): Promise<void> {
    const query = new URLSearchParams({ branch, ref: sha });
    const res = await this.call(
      `${this.projectBase}/repository/branches?${query}`,
      { method: "POST" },
    );
    if (res === null) {
      throw new GitProviderError({
        provider: "gitlab",
        status: 404,
        message: `GitLab could not branch ${branch} from ${sha}: project or ref not found`,
      });
    }
  }

  /**
   * GitLab computes mergeability asynchronously and answers 405 while it is
   * still deciding, so a merge issued right after the MR was created loses a
   * race it would win a second later. Bounded retry on 405 only; a genuine
   * conflict exhausts the attempts and surfaces GitLab's own message.
   */
  private async mergeChangeRequest(
    iid: number,
    base: string,
    message: string,
  ): Promise<string> {
    const attempt = async (): Promise<string> => {
      const json = await this.json<GitlabMergeRequestRow>(
        `${this.projectBase}/merge_requests/${iid}/merge`,
        { method: "PUT", body: { merge_commit_message: message } },
      );
      if (!json) {
        throw new GitProviderError({
          provider: "gitlab",
          status: 404,
          message: `GitLab merge request !${iid} not found in ${this.repo.path}`,
        });
      }
      if (json.state !== "merged") {
        throw new GitProviderError({
          provider: "gitlab",
          status: 409,
          message: `GitLab left merge request !${iid} in state ${json.state ?? "unknown"}`,
        });
      }
      /** A fast-forward or squash merge produces no merge commit; the target
       * branch's new head is then the result the caller wants. */
      if (json.merge_commit_sha) return json.merge_commit_sha;
      const merged = await this.getBranch(base);
      const sha = merged?.sha ?? json.sha;
      if (!sha) {
        throw new GitProviderError({
          provider: "gitlab",
          status: 502,
          message: `GitLab merged !${iid} without reporting a commit sha`,
        });
      }
      return sha;
    };
    try {
      return await retry(attempt, {
        maxAttempts: 4,
        minTimeout: 500,
        maxTimeout: 4_000,
        jitter: 0.5,
        isRetriable: (err) =>
          err instanceof GitProviderError && err.status === 405,
      });
    } catch (err) {
      if (err instanceof RetryError && err.cause instanceof GitProviderError) {
        throw err.cause;
      }
      throw err;
    }
  }

  private async deleteBranch(branch: string): Promise<void> {
    await this.call(
      `${this.projectBase}/repository/branches/${encodeRef(branch)}`,
      { method: "DELETE" },
    );
  }

  private async lastCommitIdFor(
    ref: string,
    path: string,
  ): Promise<string | null> {
    const json = await this.json<{ last_commit_id?: string }>(
      `${this.projectBase}/repository/files/${encodeFilePath(path)}?ref=${encodeURIComponent(ref)}`,
    );
    return json?.last_commit_id ?? null;
  }

  /**
   * One file's content and mode at a ref, or null when it is absent there.
   * GitLab reports the exec bit only on this metadata endpoint (never in a
   * tree listing or on `/raw`), and it is absent on GitLab versions that
   * predate the field, which reads as a regular file.
   */
  private async fileAtRef(
    ref: string,
    path: string,
  ): Promise<{ content: string; mode: FileMode } | null> {
    const json = await this.json<{
      content?: string;
      encoding?: string;
      execute_filemode?: boolean;
    }>(
      `${this.projectBase}/repository/files/${encodeFilePath(path)}?ref=${encodeURIComponent(ref)}`,
    );
    if (!json || json.content === undefined) return null;
    if (json.encoding !== "base64") {
      throw new GitProviderError({
        provider: "gitlab",
        status: 502,
        message: `GitLab served ${path} at ${ref} with unexpected encoding ${json.encoding}`,
      });
    }
    return {
      content: Buffer.from(json.content, "base64").toString("utf-8"),
      mode: json.execute_filemode === true ? "100755" : "100644",
    };
  }

  /**
   * Direct children of `path` at `treeish`, following GitLab's pagination.
   * A missing directory (or a missing ref) answers 404, which is the empty
   * listing — callers treat "no `.deco/` yet" as normal.
   */
  private async listTree(treeish: string, path: string): Promise<TreeEntry[]> {
    const out: TreeEntry[] = [];
    let page = 1;
    for (let visited = 0; visited < MAX_TREE_PAGES; visited++) {
      const query = new URLSearchParams({
        ref: treeish,
        per_page: String(TREE_PAGE_SIZE),
        page: String(page),
      });
      if (path) query.set("path", path);
      const res = await this.call(
        `${this.projectBase}/repository/tree?${query}`,
      );
      if (res === null) return out;
      const rows: unknown = await res.json();
      if (!Array.isArray(rows)) {
        throw new GitProviderError({
          provider: "gitlab",
          status: 502,
          message: "GitLab /repository/tree returned a non-array payload",
        });
      }
      for (const row of rows as GitlabTreeRow[]) {
        out.push({
          path: row.path,
          sha: row.id,
          type: row.type === "tree" ? "tree" : "blob",
        });
      }
      const next = Number(res.headers.get("x-next-page") ?? "");
      if (
        rows.length < TREE_PAGE_SIZE ||
        !Number.isFinite(next) ||
        next <= page
      )
        break;
      page = next;
    }
    return out;
  }

  private async compareRaw(
    from: string,
    to: string,
  ): Promise<{
    commits: Array<{ title?: string }>;
    diffs: GitlabCompareDiff[];
  }> {
    const query = new URLSearchParams({ from, to, straight: "false" });
    const json = await this.json<{
      commits?: Array<{ title?: string }>;
      diffs?: GitlabCompareDiff[];
    }>(`${this.projectBase}/repository/compare?${query}`);
    if (!json) {
      throw new GitProviderError({
        provider: "gitlab",
        status: 404,
        message: `GitLab cannot compare ${from}...${to} in ${this.repo.path}`,
      });
    }
    return { commits: json.commits ?? [], diffs: json.diffs ?? [] };
  }

  /** Empty string when the refs share no history — GitLab answers 404 there. */
  private async mergeBaseSha(base: string, head: string): Promise<string> {
    const query = new URLSearchParams();
    query.append("refs[]", base);
    query.append("refs[]", head);
    const json = await this.json<{ id?: string }>(
      `${this.projectBase}/repository/merge_base?${query}`,
    );
    return json?.id ?? "";
  }

  private async json<T>(
    pathAndQuery: string,
    init?: CallInit,
  ): Promise<T | null> {
    const res = await this.call(pathAndQuery, init);
    if (res === null) return null;
    return (await res.json()) as T;
  }

  /**
   * One authenticated REST call. 404 resolves to null so "absent" needs no
   * try/catch; every other non-2xx becomes a `GitProviderError`, carrying a
   * wait hint when GitLab rate-limited us.
   */
  private async call(
    pathAndQuery: string,
    init: CallInit = {},
  ): Promise<Response | null> {
    const { token } = await this.provider.tokenForRepo(this.repo);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: init.accept ?? "application/json",
    };
    if (init.body !== undefined) headers["Content-Type"] = "application/json";
    let res: Response;
    try {
      res = await fetch(`${this.apiBase}${pathAndQuery}`, {
        method: init.method ?? "GET",
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (cause) {
      throw new GitProviderError({
        provider: "gitlab",
        status: 0,
        message: `GitLab request failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        cause,
      });
    }
    if (res.status === 404) return null;
    if (!res.ok) throw await gitlabFailure(res);
    return res;
  }
}

/** Branch and tag names are one path segment for GitLab: slashes encode too. */
function encodeRef(ref: string): string {
  return encodeURIComponent(ref);
}
