import type { ChangeDetail } from "@decocms/blocks/protocol";
import {
  useContentChanges,
  useContentChangeSides,
} from "@/cms/content-changes";
import { useContentBackend } from "@/cms/use-content-backend";
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

/**
 * One block as it is live, for a view that shows it as such (Monitor's
 * Experiments, the app's "Live now"): never the draft's copy in its place.
 * `unknown`: the draft changed the block and its published side couldn't be
 * read (no side for it, or no `before` though the base has a version).
 * `failed`: the changes, or their sides, couldn't be read at all.
 */
export type PublishedRead =
  | { state: "loading" }
  | { state: "failed"; retry: () => void }
  | { state: "unknown" }
  | { state: "ready"; content: Record<string, unknown> };

/**
 * The draft with `blockKey` as published, or `"unknown"` when that can't be
 * told. Only `blockKey` is rebuilt: every other block is the draft's.
 */
export function livePublishedDecofile(
  draft: Record<string, unknown>,
  changes: Record<string, unknown>,
  sides: Record<string, ChangeDetail> | undefined,
  blockKey: string,
): Record<string, unknown> | "unknown" {
  if (!Object.hasOwn(changes, blockKey)) return draft;
  const side = sides && Object.hasOwn(sides, blockKey) ? sides[blockKey] : null;
  if (!side) return "unknown";
  // The entry doesn't differ from the base after all: the draft's is live.
  if (side.kind === null) return draft;
  if (side.before !== null) return { ...draft, [blockKey]: side.before };
  if (side.baseVersion !== null) return "unknown";
  const out = { ...draft };
  delete out[blockKey];
  return out;
}

/**
 * `blockKey` as the published site has it: the base of the draft's changes,
 * which on Studio's hosted backend is the live release (latest.json, read
 * per request), not where the draft started. Reads the sides only when the
 * draft changed that block, through the queries {@link usePublishedContent}
 * reads, so nothing is read twice.
 */
export function usePublishedRead(input: {
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
  decofile: Record<string, unknown> | undefined;
  blockKey: string;
}): PublishedRead {
  const params = {
    orgSlug: input.orgSlug,
    virtualMcpId: input.virtualMcpId,
    branch: input.branch,
  };
  const backend = useContentBackend(input.virtualMcpId, input.branch);
  const cacheKey = useDecofileCacheKey(params);
  const changes = useContentChanges(backend, cacheKey || null);
  const sides = useContentChangeSides(backend, cacheKey || null, changes.data);
  if (!changes.data) {
    return changes.isError
      ? { state: "failed", retry: () => void changes.refetch() }
      : { state: "loading" };
  }
  if (!input.decofile) return { state: "loading" };
  const changed = Object.hasOwn(changes.data.changes, input.blockKey);
  if (changed && !sides.data) {
    return sides.isError
      ? { state: "failed", retry: () => void sides.refetch() }
      : { state: "loading" };
  }
  const live = livePublishedDecofile(
    input.decofile,
    changes.data.changes,
    sides.data?.entries,
    input.blockKey,
  );
  return live === "unknown"
    ? { state: "unknown" }
    : { state: "ready", content: live };
}
