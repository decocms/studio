/**
 * The blog's editorial state: the brand, its writing rules and its campaigns.
 *
 * The organization's: the brand and its writing rules are read off its brand
 * guide, and campaigns are files beside it. The guide is edited on the brand
 * page and a campaign changes through `BLOG_CAMPAIGN_UPDATE`, so this hook only
 * removes a campaign.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KEYS } from "@/lib/query-keys";
import { useStudioTools } from "@/lib/studio-tools";
import {
  CAMPAIGN_KEY_PREFIX,
  type CampaignEntry,
  scanCampaigns,
} from "./blog-data";

export interface BlogState {
  /** The brand and its writing rules in one record, as a post is written from them. */
  brand: Record<string, unknown>;
  campaigns: CampaignEntry[];
  /** False while the library is still being read. */
  ready: boolean;
  /** Deletes a campaign, by id. */
  remove: {
    mutate: (id: string, options?: { onSuccess?: () => void }) => void;
    mutateAsync: (id: string) => Promise<unknown>;
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
    mutationFn: (id: string) =>
      studio.call("BLOG_STATE_SET", { removeCampaigns: [id] }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
  });

  const state = remote.data;
  return {
    brand: { ...state?.brand, ...state?.context },
    campaigns: scanCampaigns(
      Object.fromEntries(
        (state?.campaigns ?? []).map(({ id, data }) => [
          `${CAMPAIGN_KEY_PREFIX}${id}`,
          data,
        ]),
      ),
    ),
    ready: remote.isSuccess,
    remove,
  };
}
