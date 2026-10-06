/**
 * A content-protocol draft's preview, for the GitHub backend (blocks docs:
 * /next/content-delivery#draft-previews). The site's `?__draft=` pointer
 * names `GET …/:branch/changes`, which answers only what the branch changed
 * since it left production, never a whole decofile:
 * `{format: 1, set: {name: block JSON}, delete: [name]}`. The site layers it
 * over the production content it already has.
 *
 * "Changed" is file-level draft wins: a file whose blob differs from the
 * merge base with the production branch replaces production's entry whole;
 * a file the draft deleted is a tombstone; every other file inherits
 * production. Only changed bodies are read, through the blob cache. Nothing
 * is prepared or stored: each request computes it from Git.
 */

import {
  entryHasPath,
  fullyDecodeFileName,
  isBlockFileName,
  resolveSpellings,
} from "@decocms/blocks/protocol";
import type { RepoContentClient } from "@/git-providers";
import {
  blockEntriesInTree,
  blocksDirPath,
  resolveBlockContents,
} from "./read-decofile";

/** Cumulative changed-block bytes one response may carry. */
export const MAX_DRAFT_CHANGE_BYTES = 8 * 1024 * 1024;

/** What a draft branch changed against production. */
export interface DraftChanges {
  format: 1;
  set: Record<string, unknown>;
  delete: string[];
}

/** Thrown when a draft's changes exceed {@link MAX_DRAFT_CHANGE_BYTES}. */
export class DraftChangesTooLarge extends Error {}

interface BlockFile {
  file: string;
  sha: string;
  /** Blob bytes, when the provider's tree reports them. */
  size?: number;
}

interface Winner extends BlockFile {
  name: string;
}

/** Saved-block files at `treeish`, grouped by spelling (every alias of one name). */
async function blockFiles(
  client: RepoContentClient,
  treeish: string,
  packagePath: string | null,
): Promise<Map<string, BlockFile[]>> {
  const tree = await client.listDecofileEntries(treeish, packagePath);
  const groups = new Map<string, BlockFile[]>();
  const prefix = `${blocksDirPath(packagePath)}/`;
  for (const entry of blockEntriesInTree(tree, packagePath)) {
    const file = entry.path.slice(prefix.length);
    if (!isBlockFileName(file)) continue;
    const key = fullyDecodeFileName(file).name;
    const group = groups.get(key) ?? [];
    group.push({ file, sha: entry.sha, size: entry.size });
    groups.set(key, group);
  }
  return groups;
}

function sameGroup(a: BlockFile[] = [], b: BlockFile[] = []): boolean {
  if (a.length !== b.length) return false;
  const shas = new Map(a.map((f) => [f.file, f.sha]));
  return b.every((f) => shas.get(f.file) === f.sha);
}

/** The entry a spelling group resolves to, by the shared key rule. */
async function winnerOf(
  client: RepoContentClient,
  group: BlockFile[] | undefined,
  memo: Map<string, string>,
): Promise<Winner | null> {
  if (!group?.length) return null;
  // Only an aliased name needs bodies: the winner prefers a page-like entry.
  const bodies =
    group.length === 1
      ? [null]
      : await resolveBlockContents(
          client,
          group.map((f) => ({ stem: f.file, sha: f.sha })),
          memo,
        );
  const candidates = group.map((f, i) => ({
    ...f,
    hasPath: bodies[i] ? entryHasPath(JSON.parse(bodies[i].content)) : false,
  }));
  const [resolved] = resolveSpellings(candidates).values();
  if (!resolved) return null;
  return {
    name: resolved.name,
    file: resolved.winner.file,
    sha: resolved.winner.sha,
    size: resolved.winner.size,
  };
}

/**
 * What `branch` changed against the production branch, from their merge
 * base. A branch that doesn't exist yet changed nothing.
 */
export async function buildDraftChanges(
  client: RepoContentClient,
  packagePath: string | null,
  branch: string,
): Promise<DraftChanges> {
  const empty: DraftChanges = { format: 1, set: {}, delete: [] };
  const head = await client.getBranch(branch);
  if (!head) return empty;
  const production = await client.getDefaultBranch();
  const { mergeBaseSha } = await client.compareDetailed(production, head.sha);
  if (mergeBaseSha === head.sha) return empty;
  const [draft, base] = await Promise.all([
    blockFiles(client, head.sha, packagePath),
    blockFiles(client, mergeBaseSha, packagePath),
  ]);

  const memo = new Map<string, string>();
  const replaced: Winner[] = [];
  const deleted = new Set<string>();
  for (const key of new Set([...draft.keys(), ...base.keys()])) {
    if (sameGroup(draft.get(key), base.get(key))) continue;
    const [now, before] = await Promise.all([
      winnerOf(client, draft.get(key), memo),
      winnerOf(client, base.get(key), memo),
    ]);
    if (now && before && now.file === before.file && now.sha === before.sha) {
      continue;
    }
    if (before && before.name !== now?.name) deleted.add(before.name);
    if (now) replaced.push(now);
  }

  const tooLarge = () =>
    new DraftChangesTooLarge(
      `draft changes exceed ${MAX_DRAFT_CHANGE_BYTES} bytes; publish or discard some of them to preview`,
    );
  // Refuse from tree metadata before reading; the read below re-checks real bytes.
  if (
    replaced.reduce((sum, w) => sum + (w.size ?? 0), 0) > MAX_DRAFT_CHANGE_BYTES
  ) {
    throw tooLarge();
  }
  const bodies = await resolveBlockContents(
    client,
    replaced.map((w) => ({ stem: w.file, sha: w.sha })),
    memo,
  );
  let bytes = 0;
  const set: Array<[string, unknown]> = [];
  for (const [i, winner] of replaced.entries()) {
    const text = bodies[i]!.content;
    bytes += Buffer.byteLength(text);
    if (bytes > MAX_DRAFT_CHANGE_BYTES) throw tooLarge();
    set.push([winner.name, JSON.parse(text)]);
    deleted.delete(winner.name);
  }
  return {
    format: 1,
    // fromEntries: an entry named "__proto__" stays an entry.
    set: Object.fromEntries(set),
    delete: [...deleted].sort(),
  };
}
