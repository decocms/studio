import {
  appendCoAuthorTrailer,
  type CoAuthorIdentity,
} from "@decocms/sandbox/shared";
import { mergeBlocks } from "@decocms/shared/decofile";
import { repoIdentityKey } from "@decocms/shared/git-providers";
import type { FileChange, RepoContentClient, TreeEntry } from "@/git-providers";
import { type BlockSource, resolveBlockContents } from "./read-decofile";

/** Repo-relative path of the merged `blocks.gen.json` artifact. */
function genArtifactPath(packagePath: string | null): string {
  return packagePath
    ? `${packagePath}/.deco/blocks.gen.json`
    : ".deco/blocks.gen.json";
}

/**
 * The regenerated `blocks.gen.json`, for a commit that changes `.deco/blocks`.
 *
 * Repos that track the merged artifact get it rewritten in the same commit, so
 * it never disagrees with the block files; gitignored repos (the common case)
 * have no tree entry and get `null`. `nextBlocks` is the post-commit view of
 * the blocks dir; `memo` is the blob memo a compare-and-swap retry loop
 * threads through, so a retry never re-reads a blob it already resolved.
 */
export async function regenerateGenArtifact(params: {
  client: RepoContentClient;
  tree: TreeEntry[];
  packagePath: string | null;
  branch: string;
  nextBlocks: Iterable<BlockSource>;
  memo: Map<string, string>;
}): Promise<FileChange | null> {
  const { client, tree, packagePath, branch } = params;
  const genPath = genArtifactPath(packagePath);
  if (!tree.some((e) => e.type === "blob" && e.path === genPath)) return null;
  const files = await resolveBlockContents(
    client,
    params.nextBlocks,
    params.memo,
  );
  const { decofile, skipped } = mergeBlocks(files);
  if (skipped.length > 0) {
    console.warn("decofile gen: dropped blocks that were not valid JSON", {
      repo: repoIdentityKey(client.repo),
      branch,
      packagePath,
      blocks: skipped.map((s) => s.key),
    });
  }
  return { path: genPath, content: decofile };
}

/** The commit message of a decofile write: what changed, plus the co-author. */
export function decofileCommitMessage(
  setKeys: string[],
  deleteKeys: string[],
  coAuthor: CoAuthorIdentity | null | undefined,
): string {
  const summarize = (keys: string[]): string => {
    const shown = keys.slice(0, 3).join(", ");
    return keys.length > 3 ? `${shown} (+${keys.length - 3} more)` : shown;
  };
  const parts: string[] = [];
  if (setKeys.length > 0) parts.push(`update ${summarize(setKeys)}`);
  if (deleteKeys.length > 0) parts.push(`delete ${summarize(deleteKeys)}`);
  return appendCoAuthorTrailer(
    `chore(decofile): ${parts.join("; ")}`,
    coAuthor,
  );
}
