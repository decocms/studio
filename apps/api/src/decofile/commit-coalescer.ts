import {
  appendCoAuthorTrailer,
  type CoAuthorIdentity,
} from "@decocms/sandbox/shared";
import { blockKeyToFileStem, mergeBlocks } from "@decocms/shared/decofile";
import { repoIdentityKey } from "@decocms/shared/git-providers";
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
 */

const MAX_CAS_ATTEMPTS = 3;

/**
 * Repository files to write alongside the blocks. Pass a function when the
 * content is a read-modify-write of what is already in the tree (a
 * `package.json` gaining a dependency): it is called with the head each commit
 * attempt is built against, so a CAS retry recomputes against the branch as it
 * now is instead of replaying bytes derived from the head it lost to.
 */
export type DecofileFileSource =
  | FileChange[]
  | ((headSha: string) => Promise<FileChange[]>);

export interface DecofilePatch {
  set?: Record<string, unknown>;
  delete?: string[];
  /**
   * Repo-root-relative files written in the SAME commit as the blocks — the
   * caller prefixes the package path itself.
   *
   * Installing an app is the case this exists for: the block is useless
   * without the module that resolves it (and, on TanStack, the dependency and
   * the registry entry), so landing them separately leaves the branch broken
   * in between. Not reachable from the HTTP PATCH surface — a browser must
   * never name a repository path.
   */
  files?: DecofileFileSource;
}

export interface CommitDeps {
  client: RepoContentClient;
  branch: string;
  packagePath: string | null;
  /** Acting user, appended as a `Co-authored-by:` trailer when present. */
  coAuthor?: CoAuthorIdentity | null;
}

interface Batch {
  set: Map<string, unknown>;
  del: Set<string>;
  /** Resolved per commit attempt; later sources win a shared path. */
  files: DecofileFileSource[];
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
      files: [],
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
  if (patch.files) batch.files.push(patch.files);
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

    // First, so a block write of the same path would win.
    const extraFiles = await resolveFiles(batch, headSha);
    const writes: FileChange[] = [...extraFiles];
    // Post-patch view of the blocks dir, for blocks.gen.json regeneration.
    const nextBlocks = new Map<
      string,
      { stem: string; sha: string } | { stem: string; content: string }
    >(entries.map((e) => [e.path, { stem: e.stem, sha: e.sha }]));

    for (const [key, value] of batch.set) {
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
    for (const key of batch.del) {
      for (const alias of aliasPathsForKey(entries, key)) {
        writes.push({ path: alias, deleted: true });
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
      const files = await resolveBlockContents(
        client,
        nextBlocks.values(),
        blobMemo,
      );
      const { decofile: genContent, skipped } = mergeBlocks(files);
      if (skipped.length > 0) {
        console.warn("decofile gen: dropped blocks that were not valid JSON", {
          repo: repoIdentityKey(client.repo),
          branch,
          packagePath,
          blocks: skipped.map((s) => s.key),
        });
      }
      writes.push({ path: genPath, content: genContent });
    }

    try {
      const { sha } = await client.commitFiles({
        branch,
        message: commitMessage(
          batch,
          extraFiles.map((file) => file.path),
        ),
        expectedHead: headSha,
        changes: writes,
      });
      return sha;
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

/** The batch's extra files at `headSha`, deduped by path with the last winning. */
async function resolveFiles(
  batch: Batch,
  headSha: string,
): Promise<FileChange[]> {
  const byPath = new Map<string, FileChange>();
  for (const source of batch.files) {
    const files = typeof source === "function" ? await source(headSha) : source;
    for (const file of files) byPath.set(file.path, file);
  }
  return [...byPath.values()];
}

function commitMessage(batch: Batch, filePaths: string[]): string {
  const summarize = (keys: string[]): string => {
    const shown = keys.slice(0, 3).join(", ");
    return keys.length > 3 ? `${shown} (+${keys.length - 3} more)` : shown;
  };
  const parts: string[] = [];
  if (batch.set.size > 0)
    parts.push(`update ${summarize([...batch.set.keys()])}`);
  if (batch.del.size > 0) parts.push(`delete ${summarize([...batch.del])}`);
  if (filePaths.length > 0) parts.push(`write ${summarize(filePaths)}`);
  const subject = `chore(decofile): ${parts.join("; ")}`;
  return appendCoAuthorTrailer(subject, batch.deps.coAuthor);
}
