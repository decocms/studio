import {
  appendCoAuthorTrailer,
  type CoAuthorIdentity,
} from "@decocms/sandbox/shared";
import { blockKeyToFileStem, mergeBlocks } from "@decocms/shared/decofile";
import { exponentialBackoffWithJitter, sleep } from "@decocms/shared/std";
import type { GitDataClient, TreeWriteEntry } from "./github-git-data";
import { GitHubApiError } from "./github-git-data";
import {
  aliasPathsForKey,
  blockEntriesInTree,
  blocksDirPath,
  primeBlobCache,
  resolveOrCreateHead,
} from "./read-decofile";

/**
 * Per-(virtualMcpId, branch) commit coalescer. Autosaves arrive every ~700ms
 * per block while a user types; committing each individually would spam the
 * branch history and GitHub's rate budget. Instead, writes that arrive while a
 * commit is in flight merge into ONE pending batch, and the next flush lands
 * them all in a single commit.
 *
 * Multi-replica safety comes from GitHub itself: `updateRef` is non-forced, so
 * a concurrent writer (another replica, a dev pushing code) makes it fail
 * non-fast-forward and the flush rebuilds on the fresh head and retries.
 */

const MAX_CAS_ATTEMPTS = 3;

export interface DecofilePatch {
  set?: Record<string, unknown>;
  delete?: string[];
}

export interface CommitDeps {
  client: GitDataClient;
  branch: string;
  packagePath: string | null;
  /** Acting user, appended as a `Co-authored-by:` trailer when present. */
  coAuthor?: CoAuthorIdentity | null;
}

interface Batch {
  set: Map<string, unknown>;
  del: Set<string>;
  deps: CommitDeps;
  resolvers: Array<(sha: string) => void>;
  rejecters: Array<(err: unknown) => void>;
}

interface QueueState {
  pending: Batch | null;
  running: boolean;
}

const queues = new Map<string, QueueState>();

/**
 * Enqueue a patch; resolves with the sha of the commit that carried it (the
 * branch head when the patch turned out to be a no-op, e.g. deleting an
 * already-absent block).
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
    state.pending = {
      set: new Map(),
      del: new Set(),
      deps,
      resolvers: [],
      rejecters: [],
    };
  }
  const batch = state.pending;
  batch.deps = deps; // freshest token/identity wins for the whole batch
  for (const [key, value] of Object.entries(patch.set ?? {})) {
    batch.set.set(key, value);
    batch.del.delete(key);
  }
  for (const key of patch.delete ?? []) {
    batch.del.add(key);
    batch.set.delete(key);
  }
  const done = new Promise<string>((resolve, reject) => {
    batch.resolvers.push(resolve);
    batch.rejecters.push(reject);
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
        const sha = await commitBatch(batch);
        for (const resolve of batch.resolvers) resolve(sha);
      } catch (err) {
        for (const reject of batch.rejecters) reject(err);
      }
    }
  } finally {
    state.running = false;
    if (!state.pending) queues.delete(queueKey);
  }
}

async function commitBatch(batch: Batch): Promise<string> {
  const { client, branch, packagePath } = batch.deps;
  for (let attempt = 0; ; attempt++) {
    // Writes are session-only, so first-touch of a thread-minted branch may
    // materialize it here (a save can race ahead of the editor's first read).
    const headSha = await resolveOrCreateHead(client, branch);
    const baseTreeSha = await client.getCommitTreeSha(headSha);
    const tree = await client.getTreeRecursive(baseTreeSha);
    const entries = blockEntriesInTree(tree, packagePath);

    const writes: TreeWriteEntry[] = [];
    // Post-patch view of the blocks dir, for blocks.gen.json regeneration.
    const nextBlocks = new Map<
      string,
      { stem: string; sha: string | null; content?: string }
    >(entries.map((e) => [e.path, { stem: e.stem, sha: e.sha }]));

    for (const [key, value] of batch.set) {
      const aliases = aliasPathsForKey(entries, key);
      const content = `${JSON.stringify(value, null, 2)}\n`;
      const blobSha = await client.createBlob(content);
      // Write-through to the disk store (fail-open) so the read after this
      // save never re-fetches content the replica already has in hand.
      await primeBlobCache(client.owner, client.repo, blobSha, content);
      // Land on the existing on-disk spelling (a differently-encoded stem would
      // otherwise become a duplicate sibling); collapse extra aliases.
      const target =
        aliases[0] ??
        `${blocksDirPath(packagePath)}/${blockKeyToFileStem(key)}.json`;
      writes.push({ path: target, mode: "100644", type: "blob", sha: blobSha });
      const targetStem = target.slice(
        target.lastIndexOf("/") + 1,
        -".json".length,
      );
      nextBlocks.set(target, { stem: targetStem, sha: blobSha, content });
      for (const extra of aliases.slice(1)) {
        writes.push({ path: extra, mode: "100644", type: "blob", sha: null });
        nextBlocks.delete(extra);
      }
    }
    for (const key of batch.del) {
      for (const alias of aliasPathsForKey(entries, key)) {
        writes.push({ path: alias, mode: "100644", type: "blob", sha: null });
        nextBlocks.delete(alias);
      }
    }

    if (writes.length === 0) return headSha;

    // Repos that track the merged artifact get it regenerated in-commit;
    // gitignored repos (the common case) never have the tree entry.
    const genPath = packagePath
      ? `${packagePath}/.deco/blocks.gen.json`
      : ".deco/blocks.gen.json";
    if (tree.some((e) => e.type === "blob" && e.path === genPath)) {
      const files = await Promise.all(
        [...nextBlocks.values()].map(async (b) => ({
          stem: b.stem,
          content: b.content ?? (await client.getBlobText(b.sha as string)),
        })),
      );
      const genBlobSha = await client.createBlob(mergeBlocks(files));
      writes.push({
        path: genPath,
        mode: "100644",
        type: "blob",
        sha: genBlobSha,
      });
    }

    const newTreeSha = await client.createTree(baseTreeSha, writes);
    const commitSha = await client.createCommit({
      message: commitMessage(batch),
      treeSha: newTreeSha,
      parentShas: [headSha],
    });
    try {
      await client.updateRef(branch, commitSha);
      return commitSha;
    } catch (err) {
      // Non-fast-forward: someone else advanced the branch between our head
      // read and the ref update. Rebuild on the fresh head and try again.
      const isCas = err instanceof GitHubApiError && err.status === 422;
      if (!isCas || attempt >= MAX_CAS_ATTEMPTS - 1) throw err;
      await sleep(exponentialBackoffWithJitter(2_000, 200, attempt, 2, 0.5));
    }
  }
}

function commitMessage(batch: Batch): string {
  const summarize = (keys: string[]): string => {
    const shown = keys.slice(0, 3).join(", ");
    return keys.length > 3 ? `${shown} (+${keys.length - 3} more)` : shown;
  };
  const parts: string[] = [];
  if (batch.set.size > 0)
    parts.push(`update ${summarize([...batch.set.keys()])}`);
  if (batch.del.size > 0) parts.push(`delete ${summarize([...batch.del])}`);
  const subject = `chore(decofile): ${parts.join("; ")}`;
  return appendCoAuthorTrailer(subject, batch.deps.coAuthor);
}
