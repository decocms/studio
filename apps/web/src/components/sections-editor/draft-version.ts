import { DRAFT_TOMBSTONE_VERSION } from "@decocms/shared/blocks-major";
import { cmsBlockVersion } from "./cms-api";
import { isIndexStub } from "./hosted-content";

/**
 * A block's version in Studio's hosted draft, computed from the block
 * itself, as the server computes it: the first 16 bytes of
 * `sha256(canonicalJson(block))` in base64url (`cmsBlockVersion`).
 *
 * An editor that keeps its own copy guards each save by the version of the
 * copy it shows, so the guard can never be paired with a newer version read
 * separately (the draft's changes and the blocks are cached apart): a copy
 * the draft no longer holds is refused and reconciled, never written over
 * what it doesn't show.
 */
export function draftVersionOf(block: unknown): Promise<string> {
  return cmsBlockVersion(block);
}

/**
 * The `ifMatch` of a hosted save built on `copy`, a copy of a block whose
 * version the draft lists as `listed` (the index, or the draft's changes):
 * unknown and "not in the draft" (`null`, main's copy) as listed, the
 * tombstone for a block the draft deletes or one there is no copy of,
 * otherwise the copy's own content hash.
 *
 * Never the listed version for a copy: a poll puts someone else's version
 * in the index before their copy of the block is loaded (and never reloads a
 * block being saved), so a save built on the copy the editor still holds,
 * guarded by the listed version, would be written over a change it never
 * showed. Guarded by its copy, it is refused and reconciled.
 */
export async function copyDraftVersion(
  listed: string | null | undefined,
  copy: unknown,
): Promise<string | null | undefined> {
  if (listed === undefined || listed === null) return listed;
  if (listed === DRAFT_TOMBSTONE_VERSION) return listed;
  if (copy === undefined || isIndexStub(copy)) return listed;
  return draftVersionOf(copy);
}
