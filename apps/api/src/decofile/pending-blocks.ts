/**
 * Fast Preview saves held in Studio instead of committed, for organizations
 * with `cms_auto_commit` off. The branch head stays the base; the pending rows
 * (one per block, `decofile_pending_blocks`) are laid over it on every read,
 * so the editor and the preview see them, and the `/git/*` compat routes count
 * them as uncommitted work, so the publish surface lists them. Publishing
 * commits them in one commit before it merges.
 */

import { createHash } from "node:crypto";
import {
  blockKeyToFileStem,
  decoBlockFingerprint,
} from "@decocms/shared/decofile";
import type { RepoContentClient } from "@/git-providers";
import type {
  DecofilePendingBlockStorage,
  PendingBranchScope,
} from "@/storage/decofile-pending-blocks";
import type { DecofilePendingBlock } from "@/storage/types";
import {
  BlockConflictError,
  type CommitDeps,
  type DecofilePatch,
  enqueueDecofilePatch,
  readHeadFingerprints,
} from "./commit-coalescer";
import {
  aliasPathsForKey,
  blockEntriesInTree,
  blocksDirPath,
} from "./read-decofile";

/** The commit queue of one branch; every writer to it shares this key. */
export function decofileQueueKey(scope: PendingBranchScope): string {
  return `${scope.organizationId}/${scope.virtualMcpId}/${scope.branch}`;
}

/**
 * The draft's version: the head sha alone when nothing is pending, otherwise
 * the sha plus a digest of which rows are pending at which revision, so each
 * save gives the preview pointer a new version. Fits the runtime's version
 * charset (`[A-Za-z0-9._-]{1,64}`).
 */
export function pendingVersion(
  headSha: string,
  pending: DecofilePendingBlock[],
): string {
  if (pending.length === 0) return headSha;
  const digest = createHash("sha256");
  for (const block of [...pending].sort((a, b) =>
    a.blockKey < b.blockKey ? -1 : a.blockKey > b.blockKey ? 1 : 0,
  )) {
    digest.update(`${block.blockKey}\0${block.revision}\0`);
  }
  return `${headSha}.${digest.digest("hex").slice(0, 16)}`;
}

/** The merged decofile (JSON text) with the pending blocks laid over it. */
export function overlayDecofile(
  decofile: string,
  pending: DecofilePendingBlock[],
): string {
  if (pending.length === 0) return decofile;
  const doc = JSON.parse(decofile) as Record<string, unknown>;
  for (const block of pending) {
    if (block.content === null) delete doc[block.blockKey];
    else doc[block.blockKey] = block.content;
  }
  return JSON.stringify(doc);
}

/** A pending block's file content, as the commit will write it. */
export function pendingFileContent(block: DecofilePendingBlock): string | null {
  return block.content === null
    ? null
    : `${JSON.stringify(block.content, null, 2)}\n`;
}

export interface PendingFile {
  block: DecofilePendingBlock;
  path: string;
  /** Whether the head has a file for this block. */
  existsAtHead: boolean;
}

/**
 * Where each pending block's file is (or will be): its existing spelling at
 * the head, or the path a commit would create. A delete of a block the head
 * does not have changes nothing and is left out.
 */
export async function pendingFiles(
  client: RepoContentClient,
  headSha: string,
  packagePath: string | null,
  pending: DecofilePendingBlock[],
): Promise<PendingFile[]> {
  if (pending.length === 0) return [];
  const tree = await client.listDecofileEntries(headSha, packagePath);
  const entries = blockEntriesInTree(tree, packagePath);
  const out: PendingFile[] = [];
  for (const block of pending) {
    const existing = aliasPathsForKey(entries, block.blockKey)[0];
    if (!existing && block.content === null) continue;
    out.push({
      block,
      path:
        existing ??
        `${blocksDirPath(packagePath)}/${blockKeyToFileStem(block.blockKey)}.json`,
      existsAtHead: !!existing,
    });
  }
  return out;
}

/**
 * Hold a patch instead of committing it. Each `expect`ed block is checked
 * against what the editor was shown: its pending content when it has a
 * pending row, otherwise its content at the head.
 */
export async function holdDecofilePatch(args: {
  storage: DecofilePendingBlockStorage;
  scope: PendingBranchScope;
  client: RepoContentClient;
  headSha: string;
  packagePath: string | null;
  patch: DecofilePatch;
  userId: string | null;
}): Promise<void> {
  const { storage, scope, client, headSha, packagePath, patch } = args;
  const expect = Object.entries(patch.expect ?? {});
  const head = await readHeadFingerprints(
    client,
    headSha,
    packagePath,
    new Set(expect.map(([key]) => key)),
  );
  await storage.write(
    scope,
    { set: patch.set ?? {}, delete: patch.delete ?? [] },
    args.userId,
    async (current) => {
      const stale: string[] = [];
      for (const [key, expected] of expect) {
        const row = current.get(key);
        const actual = row
          ? row.content === null
            ? null
            : await decoBlockFingerprint(row.content)
          : head.get(key);
        // `undefined`: the head's copy is not valid JSON, nothing to hold against.
        if (actual !== undefined && actual !== expected) stale.push(key);
      }
      if (stale.length > 0) throw new BlockConflictError(stale);
    },
  );
}

/**
 * Commit every pending block of the branch in one commit and drop the rows it
 * carried. Unconditional: the pending content is what the editor and the
 * preview have shown over the head all along. A block saved again while the
 * commit runs keeps its row. Resolves with the commit sha, or null when
 * nothing was pending.
 */
export async function commitPendingBlocks(
  storage: DecofilePendingBlockStorage,
  scope: PendingBranchScope,
  deps: CommitDeps,
): Promise<string | null> {
  const pending = await storage.list(scope);
  if (pending.length === 0) return null;
  const patch: Required<Pick<DecofilePatch, "set" | "delete">> = {
    set: {},
    delete: [],
  };
  for (const block of pending) {
    if (block.content === null) patch.delete.push(block.blockKey);
    else patch.set[block.blockKey] = block.content;
  }
  const sha = await enqueueDecofilePatch(decofileQueueKey(scope), deps, patch);
  await storage.deleteRevisions(scope, pending);
  return sha;
}
