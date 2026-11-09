import type { ChangeDetail } from "@decocms/blocks/protocol";
import { useContentChanges, useContentChangeSides } from "./content-changes";
import { useContentBackend } from "./use-content-backend";
import { useDecofileCacheKey } from "./use-decofile";

/**
 * The published content, from the draft's and both sides of its changes
 * (`changes.get`): each changed block as it was before (absent when it is
 * new). A change whose sides weren't read, or whose published side couldn't
 * be read (no `before` though the base has a version), keeps the draft's
 * copy.
 */
export function publishedDecofile(
  draft: Record<string, unknown>,
  sides: Record<string, ChangeDetail>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...draft };
  for (const [blockKey, side] of Object.entries(sides)) {
    if (side.kind === null) continue;
    if (side.before !== null) out[blockKey] = side.before;
    else if (side.baseVersion === null) delete out[blockKey];
  }
  return out;
}

/**
 * The published content the draft is compared with (the Experiments tab's
 * and the Campaigns view's "Not published yet", "Changed in your draft" and
 * "Removed in your draft"): the draft itself when it has no changes, else
 * rebuilt from the draft's changes (`changes.list`, polled with the content)
 * and both sides of them (`changes.get`, read once per revision). `null`
 * while those load. Reads nothing else.
 */
export function usePublishedContent(input: {
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
  decofile: Record<string, unknown> | undefined;
}): Record<string, unknown> | null {
  const params = {
    orgSlug: input.orgSlug,
    virtualMcpId: input.virtualMcpId,
    branch: input.branch,
  };
  const backend = useContentBackend(input.virtualMcpId, input.branch);
  const cacheKey = useDecofileCacheKey(params);
  const changes = useContentChanges(backend, cacheKey || null);
  const sides = useContentChangeSides(backend, cacheKey || null, changes.data);
  if (!input.decofile || !changes.data) return null;
  if (Object.keys(changes.data.changes).length === 0) return input.decofile;
  return sides.data?.entries
    ? publishedDecofile(input.decofile, sides.data.entries)
    : null;
}
