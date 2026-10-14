/**
 * A hosted v8 discard as a content write: each changed block goes back to
 * main's body (the `from` side of a diff read when the discard runs), and a
 * block only the draft has is deleted. The server drops a draft entry that
 * equals main, so the draft ends up as if the change was never made.
 */

import type { DecofilePatchBody } from "@/components/sections-editor/decofile-api";
import { blockKeyFromDiffPath } from "./publish-change-summary";
import type { GitDiffResult } from "./sandbox-git-api";

export interface DiscardPlan {
  /** main's version of the blocks that still differ from it; null for none. */
  patch: DecofilePatchBody | null;
  /**
   * Paths no longer in the diff: the draft already equals main there (main
   * moved to the draft's body, or another tab discarded it), so only the
   * draft's leftover entry goes (`/git/discard`), and main stays as it is.
   */
  drop: string[];
}

/** Null when some path can't be expressed this way (no diff, not a block). */
export function discardPlan(
  filepaths: readonly string[],
  diff: GitDiffResult | null,
): DiscardPlan | null {
  if (!diff || filepaths.length === 0) return null;
  const set: Record<string, unknown> = {};
  const deleted: string[] = [];
  const drop: string[] = [];
  for (const path of filepaths) {
    const blockKey = blockKeyFromDiffPath(path);
    if (!blockKey) return null;
    const entry = diff.diffs[path];
    if (!entry) {
      drop.push(path);
      continue;
    }
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
  const hasSet = Object.keys(set).length > 0;
  return {
    patch:
      hasSet || deleted.length > 0
        ? {
            ...(hasSet ? { set } : {}),
            ...(deleted.length > 0 ? { delete: deleted } : {}),
          }
        : null,
    drop,
  };
}
