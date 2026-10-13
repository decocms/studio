/**
 * A hosted v8 discard as a content write: each changed block goes back to
 * main's body (the `from` side of the publish dialog's diff), and a block
 * only the draft has is deleted. The server drops a draft entry that equals
 * main, so the draft ends up as if the change was never made.
 */

import type { DecofilePatchBody } from "@/components/sections-editor/decofile-api";
import { blockKeyFromDiffPath } from "./publish-change-summary";
import type { GitDiffResult } from "./sandbox-git-api";

/** Null when some path can't be expressed this way (no body, not a block). */
export function discardPatch(
  filepaths: readonly string[],
  diff: GitDiffResult | null,
): DecofilePatchBody | null {
  if (!diff || filepaths.length === 0) return null;
  const set: Record<string, unknown> = {};
  const deleted: string[] = [];
  for (const path of filepaths) {
    const blockKey = blockKeyFromDiffPath(path);
    const entry = diff.diffs[path];
    if (!blockKey || !entry) return null;
    if (entry.from === null) {
      deleted.push(blockKey);
      continue;
    }
    let body: unknown;
    try {
      body = JSON.parse(entry.from);
    } catch {
      return null;
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    set[blockKey] = body;
  }
  return {
    ...(Object.keys(set).length > 0 ? { set } : {}),
    ...(deleted.length > 0 ? { delete: deleted } : {}),
  };
}
