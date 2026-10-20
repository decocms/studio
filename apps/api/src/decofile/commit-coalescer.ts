import {
  commitAttribution,
  type CommitOperator,
} from "@decocms/sandbox/shared";
import {
  blockKeyToFileStem,
  decoBlockFingerprint,
} from "@decocms/shared/decofile";
import { exponentialBackoffWithJitter, sleep } from "@decocms/shared/std";
import {
  type FileChange,
  type RepoContentClient,
  RepoWriteConflict,
} from "@/git-providers";
import {
  aliasPathsForKey,
  blockEntriesInTree,
  blocksDirPath,
  primeBlobCache,
  resolveBlockContents,
  resolveOrCreateHead,
} from "./read-decofile";
import { decofileCommitMessage, regenerateGenArtifact } from "./gen-artifact";

/**
 * Per-(virtualMcpId, branch) commit coalescer. Autosaves arrive every ~700ms
 * per block while a user types; committing each individually would spam the
 * branch history and GitHub's rate budget. Instead, writes that arrive while a
 * commit is in flight merge into ONE pending batch, and the next flush lands
 * them all in a single commit.
 *
 * Multi-replica safety comes from the provider itself: `commitFiles` guards on
 * the head the batch was built against, so a concurrent writer (another
 * replica, a dev pushing code) makes it fail with `RepoWriteConflict` and the
 * flush rebuilds on the fresh head and retries.
 *
 * Every write replaces a whole block, so a patch built from an outdated copy
 * would silently revert whatever changed since. A patch can therefore name the
 * version each block had when its edit was made (`expect`); one whose blocks
 * moved on is rejected with {@link BlockConflictError} instead of committed.
 */

const MAX_CAS_ATTEMPTS = 3;

export interface DecofilePatch {
  set?: Record<string, unknown>;
  delete?: string[];
  /**
   * Per block key: the {@link decoBlockFingerprint} of the content the edit
   * was made against, or `null` when the writer saw no such block. Keys left
   * out are written unconditionally.
   */
  expect?: Record<string, string | null>;
}

/** The patch was made against a version of `blocks` the branch no longer has. */
export class BlockConflictError extends Error {
  constructor(readonly blocks: string[]) {
    super(`Blocks changed since they were loaded: ${blocks.join(", ")}`);
    this.name = "BlockConflictError";
  }
}

export interface CommitDeps {
  client: RepoContentClient;
  branch: string;
  packagePath: string | null;
  /**
   * Acting user of the request being enqueued. Becomes the commit's git author
   * when they have a usable name + email and the flag allows it, and a
   * `Co-authored-by:` trailer when they do not — or when the batch they land
   * in collapses more than one editor's saves.
   */
  coAuthor?: CommitOperator | null;
}

interface QueuedPatch {
  patch: DecofilePatch;
  /** Who saved THIS patch. A batch can mix editors; `deps` cannot say which. */
  coAuthor?: CommitOperator | null;
  resolve: (sha: string) => void;
  reject: (err: unknown) => void;
}

interface Batch {
  /** In arrival order: a later patch's expectations see earlier patches' writes. */
  patches: QueuedPatch[];
  deps: CommitDeps;
}

interface BatchOutcome {
  sha: string;
  accepted: QueuedPatch[];
  conflicts: Array<{ queued: QueuedPatch; blocks: string[] }>;
}

interface QueueState {
  pending: Batch | null;
  running: boolean;
}

const queues = new Map<string, QueueState>();

/**
 * Enqueue a patch; resolves with the sha of the commit that carried it (the
 * branch head when the patch turned out to be a no-op, e.g. deleting an
 * already-absent block). Rejects with {@link BlockConflictError}, writing
 * nothing of this patch, when one of its `expect`ed blocks has moved on.
 */
export function enqueueDecofilePatch(
  queueKey: string,
  deps: CommitDeps,
  patch: DecofilePatch,
): Promise<string> {
  let state = queues.get(queueKey);
  if (!state) {
    state = { pending: null, running: false };
    queues.set(queueKey, state);
  }
  if (!state.pending) {
    state.pending = { patches: [], deps };
  }
  const batch = state.pending;
  batch.deps = deps; // freshest client (and so token) wins for the whole batch
  const done = new Promise<string>((resolve, reject) => {
    // The author is per patch, never from `deps`: those are overwritten above,
    // so a batch would otherwise land as whoever saved last.
    batch.patches.push({ patch, coAuthor: deps.coAuthor, resolve, reject });
  });
  if (!state.running) void runQueue(queueKey, state);
  return done;
}

async function runQueue(queueKey: string, state: QueueState): Promise<void> {
  state.running = true;
  try {
    while (state.pending) {
      const batch = state.pending;
      state.pending = null;
      try {
        const { sha, accepted, conflicts } = await commitBatch(batch);
        for (const queued of accepted) queued.resolve(sha);
        for (const { queued, blocks } of conflicts) {
          queued.reject(new BlockConflictError(blocks));
        }
      } catch (err) {
        for (const queued of batch.patches) queued.reject(err);
      }
    }
  } finally {
    state.running = false;
    if (!state.pending) queues.delete(queueKey);
  }
}

/** The head's block could not be read as JSON, so no expectation can hold against it. */
const UNREADABLE = Symbol("unreadable");

type HeadFingerprint = string | null | typeof UNREADABLE;

/**
 * Fingerprint, at the head being built on, of every block some patch in the
 * batch has an expectation for. Reads only those blocks.
 */
async function headFingerprints(
  client: RepoContentClient,
  entries: Array<{ stem: string; sha: string; path: string }>,
  keys: Set<string>,
  blobMemo: Map<string, string>,
): Promise<Map<string, HeadFingerprint>> {
  const out = new Map<string, HeadFingerprint>();
  const sources: Array<{ key: string; stem: string; sha: string }> = [];
  for (const key of keys) {
    // The first alias is the one the merged read serves and the write lands on.
    const path = aliasPathsForKey(entries, key)[0];
    const entry = path ? entries.find((e) => e.path === path) : undefined;
    if (!entry) out.set(key, null);
    else sources.push({ key, stem: entry.stem, sha: entry.sha });
  }
  const contents = await resolveBlockContents(client, sources, blobMemo);
  for (const [i, { content }] of contents.entries()) {
    const key = (sources[i] as { key: string }).key;
    try {
      out.set(key, await decoBlockFingerprint(JSON.parse(content)));
    } catch {
      out.set(key, UNREADABLE);
    }
  }
  return out;
}

/**
 * Split the batch into patches whose expectations hold and patches that would
 * overwrite a newer version, replaying accepted writes in order so a later
 * patch is checked against what the earlier ones in this commit leave behind.
 */
async function screenPatches(
  patches: QueuedPatch[],
  head: Map<string, HeadFingerprint>,
): Promise<Pick<BatchOutcome, "accepted" | "conflicts">> {
  const current = new Map(head);
  const accepted: QueuedPatch[] = [];
  const conflicts: BatchOutcome["conflicts"] = [];
  for (const queued of patches) {
    const { patch } = queued;
    const stale = Object.entries(patch.expect ?? {})
      .filter(([key, expected]) => {
        const actual = current.get(key);
        return actual !== UNREADABLE && actual !== expected;
      })
      .map(([key]) => key);
    if (stale.length > 0) {
      conflicts.push({ queued, blocks: stale });
      continue;
    }
    accepted.push(queued);
    for (const [key, value] of Object.entries(patch.set ?? {})) {
      if (current.has(key)) current.set(key, await decoBlockFingerprint(value));
    }
    for (const key of patch.delete ?? []) {
      if (current.has(key)) current.set(key, null);
    }
  }
  return { accepted, conflicts };
}

async function commitBatch(batch: Batch): Promise<BatchOutcome> {
  const { client, branch, packagePath } = batch.deps;
  /** blob sha -> text, shared across CAS attempts. A blob sha is immutable, so
   *  a retry that rebuilds on a fresh head re-reads only blocks it has not
   *  already resolved instead of the whole tree again. */
  const blobMemo = new Map<string, string>();
  for (let attempt = 0; ; attempt++) {
    // Writes are session-only, so first-touch of a thread-minted branch may
    // materialize it here (a save can race ahead of the editor's first read).
    const headSha = await resolveOrCreateHead(client, branch);
    const tree = await client.listDecofileEntries(headSha, packagePath);
    const entries = blockEntriesInTree(tree, packagePath);

    const expectedKeys = new Set(
      batch.patches.flatMap(({ patch }) => Object.keys(patch.expect ?? {})),
    );
    const { accepted, conflicts } = await screenPatches(
      batch.patches,
      expectedKeys.size > 0
        ? await headFingerprints(client, entries, expectedKeys, blobMemo)
        : new Map(),
    );
    // Accepted patches collapse in order: the last write to a key wins.
    const set = new Map<string, unknown>();
    const del = new Set<string>();
    for (const { patch } of accepted) {
      for (const [key, value] of Object.entries(patch.set ?? {})) {
        set.set(key, value);
        del.delete(key);
      }
      for (const key of patch.delete ?? []) {
        del.add(key);
        set.delete(key);
      }
    }

    const writes: FileChange[] = [];
    // Post-patch view of the blocks dir, for blocks.gen.json regeneration.
    const nextBlocks = new Map<
      string,
      { stem: string; sha: string } | { stem: string; content: string }
    >(entries.map((e) => [e.path, { stem: e.stem, sha: e.sha }]));

    for (const [key, value] of set) {
      const aliases = aliasPathsForKey(entries, key);
      const content = `${JSON.stringify(value, null, 2)}\n`;
      // Write-through to the disk store (fail-open) so the read after this
      // save never re-fetches content the replica already has in hand.
      await primeBlobCache(client.repo, content);
      // Land on the existing on-disk spelling (a differently-encoded stem would
      // otherwise become a duplicate sibling); collapse extra aliases.
      const target =
        aliases[0] ??
        `${blocksDirPath(packagePath)}/${blockKeyToFileStem(key)}.json`;
      writes.push({ path: target, content });
      const targetStem = target.slice(
        target.lastIndexOf("/") + 1,
        -".json".length,
      );
      nextBlocks.set(target, { stem: targetStem, content });
      for (const extra of aliases.slice(1)) {
        writes.push({ path: extra, deleted: true });
        nextBlocks.delete(extra);
      }
    }
    for (const key of del) {
      for (const alias of aliasPathsForKey(entries, key)) {
        writes.push({ path: alias, deleted: true });
        nextBlocks.delete(alias);
      }
    }

    if (writes.length === 0) return { sha: headSha, accepted, conflicts };

    const gen = await regenerateGenArtifact({
      client,
      tree,
      packagePath,
      branch,
      nextBlocks: nextBlocks.values(),
      memo: blobMemo,
    });
    if (gen) writes.push(gen);

    // The editor authors the commit; the account behind the token commits it.
    // Built from `accepted` INSIDE the CAS loop: a retry re-screens, and a
    // patch that drops out must take its author with it.
    const attribution = commitAttribution(
      decofileCommitMessage([...set.keys()], [...del]),
      accepted.map((queued) => queued.coAuthor),
    );
    try {
      const { sha } = await client.commitFiles({
        branch,
        message: attribution.message,
        author: attribution.author,
        expectedHead: headSha,
        changes: writes,
      });
      return { sha, accepted, conflicts };
    } catch (err) {
      // Someone else advanced the branch between our head read and the write.
      if (
        !(err instanceof RepoWriteConflict) ||
        attempt >= MAX_CAS_ATTEMPTS - 1
      ) {
        throw err;
      }
      await sleep(exponentialBackoffWithJitter(2_000, 200, attempt, 2, 0.5));
    }
  }
}
