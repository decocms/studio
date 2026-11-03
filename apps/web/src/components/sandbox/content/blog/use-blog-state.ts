/**
 * The blog's editorial state: brand, writing rules, campaigns, seeds.
 *
 * The organization's: brand and writing rules are read off its brand guide,
 * and campaigns and seeds are files beside it. The guide is edited on
 * the brand page and a campaign changes through `BLOG_CAMPAIGN_UPDATE`, so this
 * hook only removes. Sites that once kept this state as decofile blocks still
 * have them on disk; {@link withoutBlogState} keeps them from leaking back in.
 *
 * `blocks` keeps the decofile's own shape, so every reader — `readBlogContext`,
 * `scanCampaigns`, `scanCampaignSeeds` — is untouched, and `remove` takes the
 * same `{ blockKey }` the decofile mutation took.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  StudioToolInput,
  StudioToolOutput,
} from "@decocms/shared/tools/tool-io";
import { KEYS } from "@/lib/query-keys";
import { useStudioTools } from "@/lib/studio-tools";
import {
  BRAND_BLOCK_KEY,
  CAMPAIGN_KEY_PREFIX,
  CAMPAIGN_SEED_KEY_PREFIX,
  CONTEXT_BLOCK_KEY,
  FORMATS_BLOCK_KEY,
} from "./blog-data";

type RemoteState = StudioToolOutput<"BLOG_STATE_GET">;
type SetInput = StudioToolInput<"BLOG_STATE_SET">;

/** The singleton keys this state used to be stored under. */
const STATE_SINGLETONS = [
  BRAND_BLOCK_KEY,
  CONTEXT_BLOCK_KEY,
  FORMATS_BLOCK_KEY,
];

/** The library's state, as the decofile slice it stands in for. */
function blocksOf(state: RemoteState | undefined): Record<string, unknown> {
  if (!state) return {};
  const blocks: Record<string, unknown> = {};
  if (state.brand) blocks[BRAND_BLOCK_KEY] = state.brand;
  if (state.context) blocks[CONTEXT_BLOCK_KEY] = state.context;
  for (const { id, data } of state.campaigns) {
    blocks[`${CAMPAIGN_KEY_PREFIX}${id}`] = data;
  }
  for (const { id, data } of state.campaignSeeds) {
    blocks[`${CAMPAIGN_SEED_KEY_PREFIX}${id}`] = data;
  }
  return blocks;
}

/** Whether a key is one of the five families this hook owns. */
function isBlogStateKey(key: string): boolean {
  return (
    STATE_SINGLETONS.includes(key) ||
    key.startsWith(CAMPAIGN_KEY_PREFIX) ||
    key.startsWith(CAMPAIGN_SEED_KEY_PREFIX)
  );
}

/**
 * A decofile with the five families removed.
 *
 * A site that used to keep them there still has the blocks, and a screen that
 * merges the decofile with the library would read a brand nothing writes to
 * any more — the form fills itself from a store that is no longer the truth.
 * Post drafts stay: `blog-manager/posts/` was never part of this move.
 */
export function withoutBlogState(
  decofile: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(decofile).filter(([key]) => !isBlogStateKey(key)),
  );
}

/** The record id a campaign or seed key carries. */
function idOf(blockKey: string): string {
  const prefix = blockKey.startsWith(CAMPAIGN_KEY_PREFIX)
    ? CAMPAIGN_KEY_PREFIX
    : CAMPAIGN_SEED_KEY_PREFIX;
  return blockKey.slice(prefix.length);
}

/** The `remove` arguments for a key, or null when the key is not a record. */
function removeFor(blockKey: string): Partial<SetInput> | null {
  if (blockKey.startsWith(CAMPAIGN_KEY_PREFIX)) {
    return { removeCampaigns: [idOf(blockKey)] };
  }
  if (blockKey.startsWith(CAMPAIGN_SEED_KEY_PREFIX)) {
    return { removeCampaignSeeds: [idOf(blockKey)] };
  }
  return null;
}

export interface BlogState {
  /** The five families, shaped exactly like the decofile slice they replace. */
  blocks: Record<string, unknown>;
  /** False while the library is still being read. */
  ready: boolean;
  remove: {
    mutate: (
      args: { blockKey: string },
      options?: { onSuccess?: () => void },
    ) => void;
    mutateAsync: (args: { blockKey: string }) => Promise<unknown>;
    isPending: boolean;
    isError: boolean;
  };
}

export function useBlogState({
  orgSlug,
  enabled = true,
}: {
  orgSlug: string;
  /** False for an organization with the feature off — the tool refuses it. */
  enabled?: boolean;
}): BlogState {
  const studio = useStudioTools();
  const queryClient = useQueryClient();

  const queryKey = KEYS.blogState(orgSlug);
  const remote = useQuery({
    queryKey,
    enabled,
    queryFn: () => studio.call("BLOG_STATE_GET", {}),
  });

  const remove = useMutation({
    scope: { id: `blog-state:${orgSlug}` },
    mutationFn: async ({ blockKey }: { blockKey: string }) => {
      const fields = removeFor(blockKey);
      if (!fields) throw new Error(`Not a blog record: ${blockKey}`);
      return await studio.call("BLOG_STATE_SET", fields);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
  });

  return {
    blocks: blocksOf(remote.data),
    ready: remote.isSuccess,
    remove,
  };
}
