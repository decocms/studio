import type { QueryClient } from "@tanstack/react-query";
import type { ContentIndex } from "@/cms/hosted-content";
import { KEYS } from "@/lib/query-keys";
import { cmsBlockVersion } from "@/cms/cms-api";
import { isBlockBody } from "@/cms/block-body";

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
 * the copy's own content hash when the draft holds the block and there is a
 * loaded copy, including when the draft now deletes it. A copy absent from
 * the draft can use `null` only when it still matches production (or the
 * backend supplied no production index). A discarded draft copy or a copy
 * of older production must be reconciled instead of guarded by current absence.
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
  productionVersion?: string | null,
): Promise<string | null | undefined> {
  if (listed === undefined || !isBlockBody(copy)) return listed;
  if (listed === null && productionVersion === undefined) return null;
  const version = await draftVersionOf(copy);
  return listed === null && version === productionVersion ? null : version;
}

/** Production is the overlaid index only for names the draft does not hold.
 * null means known absent; undefined means this read has no production version.
 */
export function cachedProductionVersion(
  queryClient: QueryClient,
  cacheKey: string,
  blockKey: string,
): string | null | undefined {
  const index = queryClient.getQueryData<ContentIndex>(
    KEYS.contentIndex(cacheKey),
  );
  if (!index || Object.hasOwn(index.draft, blockKey)) return undefined;
  return index.entries[blockKey]?.version ?? null;
}
