import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { decodeUntilStable, mergeBlocks } from "@decocms/shared/decofile";
import type { Counter } from "@opentelemetry/api";
import { meter } from "../observability";
import {
  getBlob,
  getMerged,
  makeScratchDir,
  putBlob,
  putMerged,
  removeScratchDir,
} from "./disk-cache";
import type { GitDataClient, TreeEntry } from "./github-git-data";
import { GitHubApiError } from "./github-git-data";
import { createSingleFlight } from "./single-flight";
import { extractBlocksFromTarball } from "./tar-extract";

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
 * it — on disk (see disk-cache.ts), content-addressed, so a hit is always
 * correct and survives restarts. The OS page cache keeps hot entries at
 * memory speed without an in-heap copy.
 */

/** Real-GitHub politeness: an unbounded Promise.all over ~700 blob fetches
 * stampedes the connection pool, flakes into timeouts, and can trip GitHub's
 * secondary (abuse) rate limit. Cold reads are rare — the blob cache makes
 * every subsequent read fetch only what changed. */
const BLOB_FETCH_CONCURRENCY = 12;

/** Above this many cache-missing blobs, a single tarball download beats
 * per-blob API calls (rate-limit- and latency-wise). */
const COLD_READ_TARBALL_THRESHOLD = 50;

/** Spec §Limits: refuse the tarball path when the tree-derived blocks
 * aggregate size exceeds this (golden rule 3 beats golden rule 2). Read here
 * rather than exposed from disk-cache config because it guards the fetch
 * path, not the store; read per cold read (rare) so tests can tune it via
 * env without a reset hook. */
const COLD_TARBALL_MAX_BYTES_DEFAULT = 128 * 1024 * 1024;

function coldTarballMaxBytes(): number {
  const raw = Bun.env.FAST_PREVIEW_COLD_TARBALL_MAX_BYTES;
  if (raw === undefined || raw === "") return COLD_TARBALL_MAX_BYTES_DEFAULT;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : COLD_TARBALL_MAX_BYTES_DEFAULT;
}

/** Lazily created so it binds the post-SDK-start meter (same pattern as
 * disk-cache.ts — `meter` is a live binding reassigned when the SDK starts). */
let coldReadsCounter: Counter | null = null;

function countColdRead(path: "tarball" | "blobs"): void {
  coldReadsCounter ??= meter.createCounter("decofile_cold_reads", {
    description: "Decofile cold snapshot reads by resolution path",
    unit: "{reads}",
  });
  coldReadsCounter.add(1, { path });
}

export async function mapBounded<T, R>(
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
 * `{stem, sha}` pairs (plus the blob `size` when the tree carried it); stems
 * are NOT decoded here.
 */
export function blockEntriesInTree(
  tree: TreeEntry[],
  packagePath: string | null,
): Array<{ stem: string; sha: string; path: string; size?: number }> {
  const prefix = `${blocksDirPath(packagePath)}/`;
  const out: Array<{ stem: string; sha: string; path: string; size?: number }> =
    [];
  for (const entry of tree) {
    if (entry.type !== "blob" || !entry.path.startsWith(prefix)) continue;
    const name = entry.path.slice(prefix.length);
    if (name.includes("/")) continue;
    if (!name.toLowerCase().endsWith(".json")) continue;
    out.push({
      stem: name.slice(0, -".json".length),
      sha: entry.sha,
      path: entry.path,
      size: entry.size,
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
 * re-fetches content this replica already has in hand. Write-through to the
 * disk store; fail-open (a store problem is a no-op, never an error). */
export function primeBlobCache(
  owner: string,
  repo: string,
  blobSha: string,
  content: string,
): Promise<void> {
  return putBlob(owner, repo, blobSha, content);
}

export interface DecofileSnapshot {
  /** Branch head commit sha — the version everywhere (ETag, __draft, response). */
  sha: string;
  /** Merged decofile document (JSON text). */
  decofile: string;
}

/**
 * Disk key for the merged document. The store keys merged entries by a single
 * 40-hex sha; a root project uses the head sha itself, but the merged doc
 * also depends on `packagePath` (two nested projects can share one repo), so
 * nested projects key by a sha1 of (head sha, packagePath) — still
 * deterministic and content-addressed, so restart-warmness is preserved.
 * (Deviation from the spec's `merged/<owner>/<repo>/<headSha>.json` sketch,
 * which ignored packagePath.)
 */
function mergedDocSha(sha: string, packagePath: string | null): string {
  if (!packagePath) return sha;
  return createHash("sha1").update(`${sha}:${packagePath}`).digest("hex");
}

/** Concurrent snapshot reads of the same content share ONE resolution — this
 * exists for the thundering herd on cold reads (spec §Cold read) but wraps
 * warm reads too (cheap). Keyed by content, not branch: the branch → sha
 * resolution happens BEFORE the flight. `packagePath` is part of the key
 * (the merged doc depends on it). */
const snapshotFlight = createSingleFlight<DecofileSnapshot>();

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
  return snapshotFlight.run(
    `${client.owner}/${client.repo}@${sha}:${packagePath ?? ""}`,
    () => resolveSnapshot(client, sha, packagePath),
  );
}

async function resolveSnapshot(
  client: GitDataClient,
  sha: string,
  packagePath: string | null,
): Promise<DecofileSnapshot> {
  const { owner, repo } = client;
  const docSha = mergedDocSha(sha, packagePath);

  // Merged disk hit: serve the stored string as-is — no JSON parse, no
  // re-serialization (byte-identical responses across reads).
  const cachedMerged = await getMerged(owner, repo, docSha);
  if (cachedMerged !== null) return { sha, decofile: cachedMerged };

  const treeSha = await client.getCommitTreeSha(sha);
  const tree = await client.getTreeRecursive(treeSha);
  const entries = blockEntriesInTree(tree, packagePath);

  // Per-blob disk hits first; only what's left goes to GitHub.
  const known = new Map<string, string>(); // tree path -> block content
  await mapBounded(entries, BLOB_FETCH_CONCURRENCY, async (e) => {
    const hit = await getBlob(owner, repo, e.sha);
    if (hit !== null) known.set(e.path, hit);
  });
  const missing = entries.length - known.size;

  // Truly cold (most blobs unknown): ONE tarball request instead of one blob
  // request per block — a ~700-block site would otherwise burn hundreds of
  // API calls and can trip GitHub's abuse limiter. NOT worth it warm: after a
  // save only the changed blob is missing, and the tarball is the whole repo
  // archive versus one small blob fetch. Any failure (no tarball endpoint —
  // the e2e stub —, oversized blocks, cache disabled, tar error) falls back
  // to the bounded blob fetches below.
  if (missing > COLD_READ_TARBALL_THRESHOLD) {
    const extracted = await tryTarballIngest(client, sha, packagePath, entries);
    countColdRead(extracted !== null ? "tarball" : "blobs");
    if (extracted !== null) {
      for (const [path, content] of extracted) known.set(path, content);
    }
  }

  const contents = await mapBounded(
    entries,
    BLOB_FETCH_CONCURRENCY,
    async (e) => {
      const hit = known.get(e.path);
      if (hit !== undefined) return { stem: e.stem, content: hit };
      const content = await client.getBlobText(e.sha);
      await putBlob(owner, repo, e.sha, content);
      return { stem: e.stem, content };
    },
  );
  const { decofile, skipped } = mergeBlocks(contents);
  if (skipped.length > 0) {
    console.warn("decofile read: dropped blocks that were not valid JSON", {
      repo: `${owner}/${repo}`,
      sha,
      packagePath,
      blocks: skipped.map((s) => ({ key: s.key, error: s.error })),
    });
  }
  await putMerged(owner, repo, docSha, decofile);
  return { sha, decofile };
}

/**
 * The tarball cold path (spec §Cold read): pre-validate aggregate size from
 * the tree, stream the tarball into a `tar` subprocess (the archive never
 * touches the JS heap), read each extracted block, and write blobs through
 * the disk store keyed by the tree's sha for that path. Returns the extracted
 * contents by tree path, or `null` on ANY failure/refusal — the caller then
 * falls back to bounded per-blob fetches. The extracted map feeds the shared
 * merge/putMerged tail in `resolveSnapshot`, so an incomplete extraction
 * (e.g. an uppercase `.JSON` member the tar glob misses) degrades to a few
 * blob fetches instead of a wrong document.
 */
async function tryTarballIngest(
  client: GitDataClient,
  sha: string,
  packagePath: string | null,
  entries: Array<{ stem: string; sha: string; path: string; size?: number }>,
): Promise<Map<string, string> | null> {
  const repoKey = `${client.owner}/${client.repo}`;

  // Pre-validate BEFORE downloading (golden rule 3 beats golden rule 2): the
  // extracted files are only "small" in aggregate if the tree says so. A tree
  // entry without a size cannot be validated, so it refuses the path too.
  const maxBytes = coldTarballMaxBytes();
  let aggregateBytes = 0;
  for (const e of entries) {
    if (e.size === undefined) {
      console.warn(
        "decofile cold read: tarball skipped (tree entry missing size; cannot pre-validate)",
        { repo: repoKey, sha, path: e.path },
      );
      return null;
    }
    aggregateBytes += e.size;
  }
  if (aggregateBytes > maxBytes) {
    console.warn(
      "decofile cold read: tarball skipped (blocks over FAST_PREVIEW_COLD_TARBALL_MAX_BYTES)",
      { repo: repoKey, sha, aggregateBytes, maxBytes },
    );
    return null;
  }

  // Scratch dir lives under the cache root; null means the cache is disabled
  // or unavailable — no place to extract to, so take the blob path.
  const scratchDir = await makeScratchDir();
  if (scratchDir === null) return null;
  try {
    const body = await client.getTarballStream(sha);
    const files = await extractBlocksFromTarball(
      body,
      scratchDir,
      blocksDirPath(packagePath),
    );
    const shaByPath = new Map(entries.map((e) => [e.path, e.sha]));
    const out = new Map<string, string>();
    for (const f of files) {
      const blobSha = shaByPath.get(f.path);
      // Extracted member not in this head's tree view (shouldn't happen —
      // same ref): skip rather than cache under a wrong sha.
      if (blobSha === undefined) continue;
      const content = await readFile(f.diskPath, "utf8");
      await putBlob(client.owner, client.repo, blobSha, content);
      out.set(f.path, content);
    }
    return out;
  } catch (err) {
    // TarExtractError (spawn/exit/empty), a fetch failure, or a read race —
    // golden rule 4: fall back to bounded blob fetches, never fail the read.
    console.warn(
      "decofile cold read: tarball path failed; falling back to blob fetches",
      {
        repo: repoKey,
        sha,
        error: err instanceof Error ? err.message : String(err),
      },
    );
    return null;
  } finally {
    await removeScratchDir(scratchDir);
  }
}
