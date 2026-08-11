import { mergeBlocks, decodeUntilStable } from "@decocms/shared/decofile";
import type { GitDataClient, TreeEntry } from "./github-git-data";
import { GitHubApiError } from "./github-git-data";
import { extractTarGz } from "./tar";

/**
 * Branch head sha, creating the branch from the default branch's head when it
 * doesn't exist yet. Thread-scoped branches are minted client-side and only
 * materialize on GitHub at first CMS touch — the sandbox flow forks locally at
 * clone time, and this is the sandbox-less equivalent. A 422 on create means a
 * concurrent first-touch won the race; re-read the ref it created.
 */
export async function resolveOrCreateHead(
  client: GitDataClient,
  branch: string,
): Promise<string> {
  try {
    return await client.getHeadSha(branch);
  } catch (err) {
    if (!(err instanceof GitHubApiError) || err.status !== 404) throw err;
  }
  const baseSha = await client.getHeadSha(await client.getDefaultBranch());
  try {
    await client.createRef(branch, baseSha);
    return baseSha;
  } catch (err) {
    if (err instanceof GitHubApiError && err.status === 422) {
      return client.getHeadSha(branch);
    }
    throw err;
  }
}

/**
 * Read model for the sandbox-less decofile: the branch head IS the draft, so
 * the merged document is fully determined by (repo, commit sha) and cached by
 * it. Content-addressed → a hit is always correct; a small cap bounds memory
 * (each entry is a multi-MB string).
 */
const MERGED_CACHE_MAX = 20;
const mergedCache = new Map<string, string>();

/**
 * Blob contents keyed by (repo, blob sha) — content-addressed, so entries are
 * immutable and a hit is always correct. This is what makes the per-save read
 * cheap: a new commit changes ONE block's blob sha, so re-merging at the new
 * head fetches one blob instead of all ~700 of a real site. Sized for a
 * handful of multi-hundred-block repos per replica.
 */
const BLOB_CACHE_MAX = 8192;
const blobCache = new Map<string, string>();

/** Real-GitHub politeness: an unbounded Promise.all over ~700 blob fetches
 * stampedes the connection pool, flakes into timeouts, and can trip GitHub's
 * secondary (abuse) rate limit. Cold reads are rare — the blob cache makes
 * every subsequent read fetch only what changed. */
const BLOB_FETCH_CONCURRENCY = 12;

/** Above this many cache-missing blobs, a single tarball download beats
 * per-blob API calls (rate-limit- and latency-wise). */
const COLD_READ_TARBALL_THRESHOLD = 50;

function lruGet(cache: Map<string, string>, key: string): string | null {
  const hit = cache.get(key);
  if (hit === undefined) return null;
  // Refresh recency (Map preserves insertion order).
  cache.delete(key);
  cache.set(key, hit);
  return hit;
}

function lruPut(
  cache: Map<string, string>,
  key: string,
  value: string,
  max: number,
): void {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > max) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

async function mapBounded<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i] as T);
      }
    },
  );
  await Promise.all(workers);
  return out;
}

/** Repo-relative directory holding block sources for a (possibly nested) project. */
export function blocksDirPath(packagePath: string | null): string {
  return packagePath ? `${packagePath}/.deco/blocks` : ".deco/blocks";
}

/**
 * Direct children of `<packagePath>/.deco/blocks/` named `*.json`
 * (case-insensitive), mirroring the daemon's non-recursive ReadDir. Returns
 * `{stem, sha}` pairs; stems are NOT decoded here.
 */
export function blockEntriesInTree(
  tree: TreeEntry[],
  packagePath: string | null,
): Array<{ stem: string; sha: string; path: string }> {
  const prefix = `${blocksDirPath(packagePath)}/`;
  const out: Array<{ stem: string; sha: string; path: string }> = [];
  for (const entry of tree) {
    if (entry.type !== "blob" || !entry.path.startsWith(prefix)) continue;
    const name = entry.path.slice(prefix.length);
    if (name.includes("/")) continue;
    if (!name.toLowerCase().endsWith(".json")) continue;
    out.push({
      stem: name.slice(0, -".json".length),
      sha: entry.sha,
      path: entry.path,
    });
  }
  return out;
}

/**
 * All tree paths whose stem decodes (until stable) to `blockKey` — the alias
 * set. Real repos carry single- and double-encoded twins of the same key; a
 * write must land on the existing spelling (not create a sibling) and a
 * delete must remove every alias or the survivor keeps rendering.
 */
export function aliasPathsForKey(
  entries: Array<{ stem: string; path: string }>,
  blockKey: string,
): string[] {
  return entries
    .filter((e) => decodeUntilStable(e.stem) === blockKey)
    .map((e) => e.path)
    .sort();
}

/** Let writers prime blobs they just created, so the read after a save never
 * re-fetches content this replica already has in hand. */
export function primeBlobCache(
  owner: string,
  repo: string,
  blobSha: string,
  content: string,
): void {
  lruPut(blobCache, `${owner}/${repo}@${blobSha}`, content, BLOB_CACHE_MAX);
}

export interface DecofileSnapshot {
  /** Branch head commit sha — the version everywhere (ETag, __draft, response). */
  sha: string;
  /** Merged decofile document (JSON text). */
  decofile: string;
}

export async function readDecofileSnapshot(
  client: GitDataClient,
  branch: string,
  packagePath: string | null,
  options?: {
    /** Create the branch from the default head when it doesn't exist —
     *  session-authenticated (editor) reads only; an anonymous draft pull of
     *  a missing branch must keep 404ing to the published fallback. */
    createBranchIfMissing?: boolean;
  },
): Promise<DecofileSnapshot> {
  const sha = options?.createBranchIfMissing
    ? await resolveOrCreateHead(client, branch)
    : await client.getHeadSha(branch);
  const repoKey = `${client.owner}/${client.repo}`;
  const cacheKey = `${repoKey}@${sha}:${packagePath ?? ""}`;
  const cached = lruGet(mergedCache, cacheKey);
  if (cached !== null) return { sha, decofile: cached };

  const treeSha = await client.getCommitTreeSha(sha);
  const tree = await client.getTreeRecursive(treeSha);
  const entries = blockEntriesInTree(tree, packagePath);
  const missing = entries.filter(
    (e) => lruGet(blobCache, `${repoKey}@${e.sha}`) === null,
  ).length;

  // Truly cold (most blobs unknown): ONE tarball request instead of one blob
  // request per block — a ~700-block site would otherwise burn hundreds of
  // API calls and can trip GitHub's abuse limiter. NOT worth it warm: after a
  // save only the changed blob is missing, and the tarball is the whole repo
  // archive (tens of MB on a real site — observed 50s) versus one small blob
  // fetch. Falls through to blobs when the server can't serve tarballs (the
  // e2e stub) or the download fails.
  if (missing > COLD_READ_TARBALL_THRESHOLD) {
    try {
      const prefix = `${blocksDirPath(packagePath)}/`;
      const files = extractTarGz(await client.getTarball(sha));
      const contents = files
        .filter((f) => {
          if (!f.path.startsWith(prefix)) return false;
          const name = f.path.slice(prefix.length);
          return !name.includes("/") && name.toLowerCase().endsWith(".json");
        })
        .map((f) => ({
          stem: f.path.slice(prefix.length, -".json".length),
          content: new TextDecoder().decode(f.content),
        }));
      // Prime per-blob entries so the NEXT head only fetches what it changes.
      const shaByPath = new Map(entries.map((e) => [e.path, e.sha]));
      for (const c of contents) {
        const blobSha = shaByPath.get(
          `${blocksDirPath(packagePath)}/${c.stem}.json`,
        );
        if (blobSha) {
          lruPut(blobCache, `${repoKey}@${blobSha}`, c.content, BLOB_CACHE_MAX);
        }
      }
      const decofile = mergeBlocks(contents);
      lruPut(mergedCache, cacheKey, decofile, MERGED_CACHE_MAX);
      return { sha, decofile };
    } catch {
      // Tarball unavailable — blob path below.
    }
  }

  const contents = await mapBounded(
    entries,
    BLOB_FETCH_CONCURRENCY,
    async (e) => {
      const blobKey = `${repoKey}@${e.sha}`;
      const hit = lruGet(blobCache, blobKey);
      if (hit !== null) return { stem: e.stem, content: hit };
      const content = await client.getBlobText(e.sha);
      lruPut(blobCache, blobKey, content, BLOB_CACHE_MAX);
      return { stem: e.stem, content };
    },
  );
  const decofile = mergeBlocks(contents);
  lruPut(mergedCache, cacheKey, decofile, MERGED_CACHE_MAX);
  return { sha, decofile };
}
