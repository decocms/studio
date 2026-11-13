import { mapBounded } from "@decocms/shared/std";
import { createHash } from "node:crypto";
import { type FileHandle, mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createBlockMerger,
  decoBlockKeyFromFileStem,
} from "@decocms/shared/decofile";
import { repoIdentityKey, type RepoRef } from "@decocms/shared/git-providers";
import type { Counter } from "@opentelemetry/api";
import {
  type RepoContentClient,
  requireBranchHead,
  RepoWriteConflict,
  type TreeEntry,
} from "@/git-providers";
import type { DecofilePendingBlock } from "@/storage/types";
import { meter } from "../observability";
import { createPreviewProjection } from "./blog-draft-projection";
import {
  adoptMerged,
  getBlob,
  getMerged,
  hasBlob,
  makeScratchDir,
  openMerged,
  putBlob,
  putMerged,
  removeScratchDir,
} from "./disk-cache";
import { createSingleFlight } from "./single-flight";
import { extractBlocksFromTarball } from "./tar-extract";

/** Disk-cache and single-flight namespace for a repo, host-qualified so two
 * providers' identically-named repos can never share an entry. */
function cacheScope(repo: RepoRef): [owner: string, name: string] {
  return [repo.host, repo.path];
}

/**
 * Branch head sha, creating the branch from the default branch's head when it
 * doesn't exist yet. Thread-scoped branches are minted client-side and only
 * materialize on the provider at first CMS touch — the sandbox flow forks
 * locally at clone time, and this is the sandbox-less equivalent. A conflict on
 * create means a concurrent first-touch won the race; re-read the ref it made.
 */
export async function resolveOrCreateHead(
  client: RepoContentClient,
  branch: string,
): Promise<string> {
  const existing = await client.getBranch(branch);
  if (existing) return existing.sha;
  const baseSha = await requireBranchHead(
    client,
    await client.getDefaultBranch(),
  );
  try {
    await client.createBranch(branch, baseSha);
    return baseSha;
  } catch (err) {
    if (err instanceof RepoWriteConflict) {
      return requireBranchHead(client, branch);
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

/** Spec §Limits: the read streams, so this bounds the disk entry and what the
 * editor's browser tab must parse, not API memory. Read per call so tests can
 * tune it via env without a reset hook. */
const DECOFILE_MAX_BYTES_DEFAULT = 256 * 1024 * 1024;

function decofileMaxBytes(): number {
  const raw = Bun.env.FAST_PREVIEW_DECOFILE_MAX_BYTES;
  if (raw === undefined || raw === "") return DECOFILE_MAX_BYTES_DEFAULT;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : DECOFILE_MAX_BYTES_DEFAULT;
}

export class DecofileTooLargeError extends Error {
  constructor(bytes: number, maxBytes: number) {
    const mb = (n: number) => Math.ceil(n / (1024 * 1024));
    super(
      `This site's blocks total ${mb(bytes)} MB, over the ${mb(maxBytes)} MB the editor can load`,
    );
    this.name = "DecofileTooLargeError";
  }
}

function assertReadableSize(bytes: number): void {
  const maxBytes = decofileMaxBytes();
  if (bytes > maxBytes) throw new DecofileTooLargeError(bytes, maxBytes);
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

let skippedBlocksCounter: Counter | null = null;

function countSkippedBlocks(n: number): void {
  skippedBlocksCounter ??= meter.createCounter("decofile_skipped_blocks", {
    description:
      "Decofile blocks dropped from a merge for not being valid JSON",
    unit: "{blocks}",
  });
  skippedBlocksCounter.add(n);
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
 * All tree paths whose stem single-decodes to `blockKey` — the alias set. A
 * key maps to `blockKeyToFileStem(key)` on disk, but a repo can hold more than
 * one spelling that decodes to the same key (e.g. differing `%2f`/`%2F` case);
 * a write must land on the existing spelling (not create a sibling) and a
 * delete must remove every alias or the survivor keeps rendering. Single-decode
 * (not decode-until-stable) so it matches the key the merge and runtime use.
 */
export function aliasPathsForKey(
  entries: Array<{ stem: string; path: string }>,
  blockKey: string,
): string[] {
  return entries
    .filter((e) => decoBlockKeyFromFileStem(e.stem) === blockKey)
    .map((e) => e.path)
    .sort();
}

/**
 * A blob's git object id: sha1 over `blob <byte length>\0<content>`. Computed
 * locally rather than read off a write response, because the intent-level write
 * (`commitFiles`) never reports the object ids it created — and it needn't,
 * since git's hashing is the same everywhere the cache is keyed by it.
 */
export function gitBlobSha(content: string): string {
  const bytes = Buffer.from(content, "utf-8");
  return createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
}

/** Let writers prime blobs they just wrote, so the read after a save never
 * re-fetches content this replica already has in hand. Write-through to the
 * disk store; fail-open (a store problem is a no-op, never an error). */
export async function primeBlobCache(
  repo: RepoRef,
  content: string,
): Promise<void> {
  await putBlob(...cacheScope(repo), gitBlobSha(content), content);
}

/** A block source that is either already in hand or still addressed by sha. */
export type BlockSource = { stem: string } & (
  | { sha: string }
  | { content: string }
);

/**
 * Resolve every block's text, reading only what the disk cache is missing and
 * bounding the fetches — the same two protections {@link resolveSnapshot} has.
 *
 * The write path needs this as badly as the read path: regenerating the merged
 * artifact touches EVERY block, so an uncached unbounded fan-out there is a
 * whole-repo blob read per save. That burst spent an entire installation's
 * hourly REST budget in production (~850 blocks x an unbounded `Promise.all`),
 * which is exactly the failure `BLOB_FETCH_CONCURRENCY` documents.
 *
 * `memo` is keyed by blob sha, which is immutable, so a caller may thread one
 * map through a compare-and-swap retry loop and never re-read a blob it has
 * already resolved on an earlier attempt.
 */
export async function resolveBlockContents(
  client: RepoContentClient,
  blocks: Iterable<BlockSource>,
  memo: Map<string, string> = new Map(),
): Promise<Array<{ stem: string; content: string }>> {
  const [owner, repo] = cacheScope(client.repo);
  const all = [...blocks];
  const missing = [
    ...new Set(
      all.flatMap((b) => ("content" in b || memo.has(b.sha) ? [] : [b.sha])),
    ),
  ];
  await mapBounded(missing, BLOB_FETCH_CONCURRENCY, async (sha) => {
    const hit = await getBlob(owner, repo, sha);
    if (hit !== null) {
      memo.set(sha, hit);
      return;
    }
    const content = await client.readBlob(sha);
    await putBlob(owner, repo, sha, content);
    memo.set(sha, content);
  });
  return all.map((b) => {
    if ("content" in b) return { stem: b.stem, content: b.content };
    const content = memo.get(b.sha);
    // Unreachable: every sha not already memoized was just fetched, and a
    // fetch failure throws. Explicit so a regression is not a silent empty
    // block in the merged document.
    if (content === undefined) {
      throw new Error(`decofile: unresolved block blob ${b.sha}`);
    }
    return { stem: b.stem, content };
  });
}

/** A merged document opened for one response. */
export interface DecofileDocument {
  /** Byte length of the merged document. */
  size: number;
  /** Members the anonymous preview pull appends (see blog-draft-projection);
   * "" when none. */
  previewMembers: string;
  /** The document's bytes. Read once; ending the read early releases it. */
  chunks(): AsyncGenerator<Uint8Array>;
}

export interface DecofileSnapshot {
  /** Branch head commit sha — the version everywhere (ETag, __draft, response). */
  sha: string;
  /** Opens the merged document with the held saves laid over it (see
   * pending-blocks), as of `version` — `pendingVersion` of the head and those
   * rows. Once per response, right before streaming it. */
  open(overlay: {
    version: string;
    pending: DecofilePendingBlock[];
  }): Promise<DecofileDocument>;
}

/** Bump when the merge output changes so entries written by an older
 * `mergeBlocks` miss instead of being served as-is — notably the pre-drop
 * splice that could cache an INVALID document under a still-current sha. */
const MERGED_DOC_FORMAT = "3";

/**
 * Disk key for the merged document — a sha1 of (format, version,
 * packagePath), so it's deterministic/content-addressed (restart-warm) yet
 * distinct per set of held saves, per nested project (two can share one repo)
 * and per merge-output format. `part` keys the document's preview members as
 * a sibling entry.
 */
function mergedDocSha(
  version: string,
  packagePath: string | null,
  part: "doc" | "preview",
): string {
  const tag = part === "doc" ? "" : `${part}:`;
  return createHash("sha1")
    .update(`${MERGED_DOC_FORMAT}:${tag}${version}:${packagePath ?? ""}`)
    .digest("hex");
}

/** A merge that could not land in the disk cache, served from memory. */
interface InMemoryDoc {
  chunks: Uint8Array[];
  size: number;
  previewMembers: string;
}

/** Concurrent reads of the same content share ONE merge — this exists for the
 * thundering herd on cold reads (spec §Cold read). Keyed by content, not
 * branch: the branch → sha resolution happens BEFORE the flight.
 * `packagePath` is part of the key (the merged doc depends on it). Resolves
 * null when the merge landed in the cache, for each reader to open. */
const mergeFlight = createSingleFlight<InMemoryDoc | null>();

export async function readDecofileSnapshot(
  client: RepoContentClient,
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
    : await requireBranchHead(client, branch);
  return {
    sha,
    open: (overlay) => openDocument(client, sha, packagePath, overlay),
  };
}

async function openDocument(
  client: RepoContentClient,
  sha: string,
  packagePath: string | null,
  overlay: { version: string; pending: DecofilePendingBlock[] },
): Promise<DecofileDocument> {
  const [owner, repo] = cacheScope(client.repo);
  const docSha = mergedDocSha(overlay.version, packagePath, "doc");
  const previewSha = mergedDocSha(overlay.version, packagePath, "preview");
  const cached = () => openCachedDocument(owner, repo, docSha, previewSha);
  const hit = await cached();
  if (hit) return hit;
  // Twice: the entry a merge just wrote can be evicted before this reader
  // opens it; the second merge is then served without another race.
  for (let attempt = 0; attempt < 2; attempt++) {
    const inMemory = await mergeFlight.run(
      `${repoIdentityKey(client.repo)}@${overlay.version}:${packagePath ?? ""}`,
      () =>
        mergeToCache(client, sha, packagePath, overlay.pending, {
          docSha,
          previewSha,
        }),
    );
    if (inMemory) {
      return {
        size: inMemory.size,
        previewMembers: inMemory.previewMembers,
        chunks: async function* () {
          yield* inMemory.chunks;
        },
      };
    }
    const opened = await cached();
    if (opened) return opened;
  }
  throw new Error("decofile: merged document evicted before it could be read");
}

async function openCachedDocument(
  owner: string,
  repo: string,
  docSha: string,
  previewSha: string,
): Promise<DecofileDocument | null> {
  const previewMembers = await getMerged(owner, repo, previewSha);
  if (previewMembers === null) return null;
  const opened = await openMerged(owner, repo, docSha);
  if (!opened) return null;
  return {
    size: opened.size,
    previewMembers,
    chunks: () => readAll(opened.handle),
  };
}

const READ_CHUNK_BYTES = 256 * 1024;

async function* readAll(handle: FileHandle): AsyncGenerator<Uint8Array> {
  try {
    for (;;) {
      const buffer = new Uint8Array(READ_CHUNK_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) return;
      yield buffer.subarray(0, bytesRead);
    }
  } finally {
    await handle.close();
  }
}

/**
 * A response body: `prefix`, the document, then `suffix`. With
 * `appendMembers`, the members are spliced in before the document's closing
 * brace. The document is read as the client consumes it, so the API never
 * holds more than a chunk of it.
 */
export function streamDocument(
  doc: DecofileDocument,
  parts: { prefix?: string; suffix?: string; appendMembers?: string },
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const append = parts.appendMembers ?? "";
  async function* body(): AsyncGenerator<Uint8Array> {
    if (parts.prefix) yield encoder.encode(parts.prefix);
    // A merged document always ends in "}"; drop it to splice members in.
    let remaining = append ? doc.size - 1 : doc.size;
    for await (const chunk of doc.chunks()) {
      if (remaining <= 0) break;
      const part =
        chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      remaining -= part.length;
      yield part;
    }
    if (remaining > 0) throw new Error("decofile: merged document truncated");
    // "{}" (2 bytes) has no members to separate from.
    if (append) yield encoder.encode(`${doc.size > 2 ? "," : ""}${append}}`);
    if (parts.suffix) yield encoder.encode(parts.suffix);
  }
  const it = body();
  return new ReadableStream({
    async pull(controller) {
      const { value, done } = await it.next();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    async cancel() {
      await it.return(undefined);
    },
  });
}

/** Where a merge writes: a file under the scratch dir, or memory when the
 * disk cache is off. */
function mergeSink(path: string | null) {
  const chunks: Uint8Array[] = [];
  const encoder = new TextEncoder();
  let handle: FileHandle | null = null;
  let size = 0;
  return {
    chunks,
    size: () => size,
    async write(text: string): Promise<void> {
      if (path === null) {
        const bytes = encoder.encode(text);
        chunks.push(bytes);
        size += bytes.length;
        return;
      }
      handle ??= await open(path, "w");
      const { bytesWritten } = await handle.write(text);
      size += bytesWritten;
    },
    close: async () => handle?.close(),
  };
}

/**
 * Merge every block into the disk cache, one block at a time, with the held
 * saves laid over them: memory holds a fetch window of blocks, never the
 * document. Returns null when the document and its preview members landed in
 * the cache, or the document in memory when they couldn't (cache off, disk
 * floor, write error).
 */
async function mergeToCache(
  client: RepoContentClient,
  sha: string,
  packagePath: string | null,
  pending: DecofilePendingBlock[],
  keys: { docSha: string; previewSha: string },
): Promise<InMemoryDoc | null> {
  const [owner, repo] = cacheScope(client.repo);
  const tree = await client.listDecofileEntries(sha, packagePath);
  // Every entry shares the blocks dir prefix, so path order is mergeBlocks'
  // filename order.
  const entries = blockEntriesInTree(tree, packagePath).sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  // Refuse before fetching anything; trees without sizes are checked as the
  // blocks arrive.
  assertReadableSize(entries.reduce((sum, e) => sum + (e.size ?? 0), 0));

  const scratchDir = await makeScratchDir();
  try {
    // Truly cold (most blobs unknown): ONE tarball request instead of one blob
    // request per block — a ~700-block site would otherwise burn hundreds of
    // API calls and can trip GitHub's abuse limiter. NOT worth it warm: after
    // a save only the changed blob is missing, and the tarball is the whole
    // repo archive versus one small blob fetch. Any failure (no tarball
    // endpoint — the e2e stub —, cache disabled, tar error) falls back to the
    // bounded blob fetches below.
    const cachedBlobs = await Promise.all(
      entries.map((e) => hasBlob(owner, repo, e.sha)),
    );
    const missing = cachedBlobs.filter((hit) => !hit).length;
    let extracted: Map<string, string> | null = null;
    if (missing > COLD_READ_TARBALL_THRESHOLD) {
      extracted = await tryTarballIngest(
        client,
        sha,
        packagePath,
        entries,
        scratchDir,
      );
      countColdRead(extracted !== null ? "tarball" : "blobs");
    }

    const path = scratchDir === null ? null : join(scratchDir, "merged.json");
    const sink = mergeSink(path);
    const merger = createBlockMerger();
    const preview = createPreviewProjection();
    // A held save replaces its block in place or deletes it; one the head
    // doesn't have goes last — where assigning it into the parsed document
    // would have put it.
    const held = new Map(pending.map((p) => [p.blockKey, p.content]));
    let members = 0;
    const write = async (key: string, value: unknown, member: string) => {
      preview.add(key, value);
      await sink.write(`${members++ === 0 ? "{" : ","}${member}`);
    };
    const writeHeld = (key: string, content: Record<string, unknown>) =>
      write(key, content, `${JSON.stringify(key)}:${JSON.stringify(content)}`);
    let blockBytes = 0;
    try {
      for (let i = 0; i < entries.length; i += BLOB_FETCH_CONCURRENCY) {
        const window = entries.slice(i, i + BLOB_FETCH_CONCURRENCY);
        const contents = await Promise.all(
          window.map((e) => readBlock(client, e, extracted)),
        );
        for (const [j, content] of contents.entries()) {
          blockBytes += Buffer.byteLength(content);
          assertReadableSize(blockBytes);
          const block = merger.add({ stem: window[j]!.stem, content });
          if (!block) continue;
          if (!held.has(block.key)) {
            await write(block.key, block.value, block.member);
            continue;
          }
          const save = held.get(block.key);
          held.delete(block.key);
          if (save) await writeHeld(block.key, save);
        }
      }
      for (const [key, content] of held) {
        if (content) await writeHeld(key, content);
      }
      await sink.write(members === 0 ? "{}" : "}");
    } finally {
      await sink.close();
    }
    if (merger.skipped.length > 0) {
      countSkippedBlocks(merger.skipped.length);
      console.warn("decofile read: dropped blocks that were not valid JSON", {
        repo: `${owner}/${repo}`,
        sha,
        packagePath,
        blocks: merger.skipped.map((s) => s.key),
      });
    }

    const previewMembers = preview.members();
    if (path === null) {
      return { chunks: sink.chunks, size: sink.size(), previewMembers };
    }
    const landed =
      (await putMerged(owner, repo, keys.previewSha, previewMembers)) &&
      (await adoptMerged(owner, repo, keys.docSha, path, sink.size()));
    if (landed) return null;
    const bytes = await readFile(path);
    return { chunks: [bytes], size: bytes.length, previewMembers };
  } finally {
    if (scratchDir !== null) await removeScratchDir(scratchDir);
  }
}

/** A block's text: disk cache, then the extracted tarball, then the provider;
 * the latter two are written through to the cache. */
async function readBlock(
  client: RepoContentClient,
  entry: { sha: string; path: string },
  extracted: Map<string, string> | null,
): Promise<string> {
  const [owner, repo] = cacheScope(client.repo);
  const hit = await getBlob(owner, repo, entry.sha);
  if (hit !== null) return hit;
  const diskPath = extracted?.get(entry.path);
  const content =
    diskPath === undefined
      ? await client.readBlob(entry.sha)
      : await readFile(diskPath, "utf8");
  await putBlob(owner, repo, entry.sha, content);
  return content;
}

/**
 * The tarball cold path (spec §Cold read): require every tree entry to carry
 * a size, then stream the tarball into a `tar` subprocess (the archive never
 * touches the JS heap) extracting into `scratchDir`, which the caller owns.
 * Returns each extracted block's disk path by tree path, or `null` on ANY
 * failure/refusal — the caller then falls back to bounded per-blob fetches. A
 * block missing from the extraction (e.g. an uppercase `.JSON` member the tar
 * glob misses) degrades to a blob fetch instead of a wrong document.
 */
async function tryTarballIngest(
  client: RepoContentClient,
  sha: string,
  packagePath: string | null,
  entries: Array<{ stem: string; sha: string; path: string; size?: number }>,
  scratchDir: string | null,
): Promise<Map<string, string> | null> {
  const repoKey = repoIdentityKey(client.repo);

  // Pre-validate BEFORE downloading (golden rule 3 beats golden rule 2): the
  // caller already refused trees over FAST_PREVIEW_DECOFILE_MAX_BYTES, but a
  // tree entry without a size escaped that check, so it refuses this path.
  const unsized = entries.find((e) => e.size === undefined);
  if (unsized) {
    console.warn(
      "decofile cold read: tarball skipped (tree entry missing size; cannot pre-validate)",
      { repo: repoKey, sha, path: unsized.path },
    );
    return null;
  }

  // No scratch dir means the cache is disabled or unavailable — no place to
  // extract to, so take the blob path.
  if (scratchDir === null) return null;
  try {
    const body = await client.getArchive(sha);
    if (body === null) return null; // provider serves no archive (the e2e stub)
    // Its own dir, apart from the merge file written next to it.
    const tarDir = join(scratchDir, "tar");
    await mkdir(tarDir);
    const files = await extractBlocksFromTarball(
      body,
      tarDir,
      blocksDirPath(packagePath),
    );
    const inTree = new Set(entries.map((e) => e.path));
    // A member not in this head's tree view (shouldn't happen — same ref) is
    // skipped rather than cached under a wrong sha.
    return new Map(
      files.filter((f) => inTree.has(f.path)).map((f) => [f.path, f.diskPath]),
    );
  } catch (err) {
    // TarExtractError (spawn/exit/empty) or a fetch failure — golden rule 4:
    // fall back to bounded blob fetches, never fail the read.
    console.warn(
      "decofile cold read: tarball path failed; falling back to blob fetches",
      {
        repo: repoKey,
        sha,
        error: err instanceof Error ? err.message : String(err),
      },
    );
    return null;
  }
}
