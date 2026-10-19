/**
 * The publish dialog's read side on a v8 site, from the content protocol's
 * changes (content-changes.ts): the card list from `changes.list` (it
 * suspends: there is nothing to show without it), each card's insides and
 * the Code tab from `changes.get` (never suspends, never blocks a button).
 * The same for every v8 source: Studio's GitHub backend (the draft against
 * main), a sandbox (its working tree against its last commit) and Localhost.
 */

import { skipToken, useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";
import { KEYS } from "@/lib/query-keys.ts";
import type { ProtocolBackend } from "@/components/sections-editor/content-backend.ts";
import {
  type ContentChanges,
  readContentChanges,
  useContentChangeSides,
} from "@/components/sections-editor/content-changes.ts";
import {
  summarizeContentChanges,
  type PublishChangeSummary,
} from "./publish-change-summary.ts";

export interface ContentPublishState {
  changes: ContentChanges;
  /** Cards to render: complete with the list, enriched once the sides load. */
  summary: PublishChangeSummary;
  /** Every listed entry with the version its discard is guarded by. */
  entries: Array<{ name: string; version: string | null }>;
  /** The sides are still loading: sub-lines and the Code tab aren't ready. */
  sidesPending: boolean;
  /** The sides failed: the cards stay, without their insides. */
  sidesFailed: boolean;
  /** The editor's current blocks, when it has read them (no request of its own). */
  blocks: Record<string, unknown> | null;
  /** Re-reads the list (after a discard that found the content moved). */
  refresh: () => Promise<unknown>;
}

/**
 * The editor's current blocks, read from the cache the editor fills (no
 * request of its own): names and kinds for the cards before any side loads.
 */
function useCurrentBlocks(
  cacheKey: string,
): Record<string, unknown> | undefined {
  const { data } = useQuery({
    queryKey: KEYS.decofile(cacheKey),
    queryFn: skipToken,
  });
  return data as Record<string, unknown> | undefined;
}

export function useContentPublishState(args: {
  backend: ProtocolBackend;
  /** The editor's decofile cache key (`useDecofileCacheKey`). */
  cacheKey: string;
}): ContentPublishState {
  const { backend, cacheKey } = args;
  const queryClient = useQueryClient();
  const list = useSuspenseQuery({
    queryKey: KEYS.contentChanges(cacheKey),
    queryFn: () => readContentChanges(queryClient, backend.client, cacheKey),
    staleTime: 0,
  });
  const changes = list.data;
  const sides = useContentChangeSides(backend, cacheKey, changes);
  const lookup = useCurrentBlocks(cacheKey);
  const summary = summarizeContentChanges({
    changes: changes.changes,
    sides: sides.data ?? null,
    lookup,
  });
  return {
    changes,
    summary,
    entries: Object.entries(changes.changes).map(([name, change]) => ({
      name,
      version: change.version,
    })),
    sidesPending: summary.count > 0 && sides.isPending,
    sidesFailed: sides.isError,
    blocks: lookup ?? null,
    refresh: () => list.refetch(),
  };
}
