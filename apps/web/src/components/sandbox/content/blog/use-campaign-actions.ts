import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { StudioToolInput } from "@decocms/shared/tools/tool-io";
import { KEYS } from "@/lib/query-keys";
import { useStudioTools } from "@/lib/studio-tools";
import { useProjectContext } from "@/sdk";

/** A person's two writes on a campaign, its goal and its status, and starting its agent. Each waits for the campaigns to reload. */
export function useCampaignActions() {
  const studio = useStudioTools();
  const queryClient = useQueryClient();
  const { org } = useProjectContext();
  const reload = () =>
    queryClient.invalidateQueries({ queryKey: KEYS.blogState(org.slug) });

  const update = useMutation({
    mutationFn: (input: StudioToolInput<"BLOG_CAMPAIGN_UPDATE">) =>
      studio.call("BLOG_CAMPAIGN_UPDATE", input),
    onSettled: reload,
  });

  const run = useMutation({
    mutationFn: async (input: StudioToolInput<"BLOG_CAMPAIGN_RUN">) => {
      const result = await studio.call("BLOG_CAMPAIGN_RUN", input);
      await reload();
      return result;
    },
  });

  return { update, run };
}
