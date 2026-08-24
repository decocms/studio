/** Who follows a task, and the toggle that adds or removes you. The toggle is
 *  optimistic — following is a cheap, reversible act, so the avatar should
 *  appear on the click rather than on the round-trip. */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useProjectContext } from "@/sdk";
import { KEYS } from "@/lib/query-keys";
import { useStudioTools } from "@/lib/studio-tools";
import { authClient } from "@/lib/auth-client";
import type { StudioToolOutput as ToolOutput } from "@decocms/shared/tools/tool-io";

type SubscriptionState = ToolOutput<"TASK_BOARD_SUBSCRIPTION_GET">;

export function useTaskBoardSubscription(itemId: string | undefined) {
  const { locator } = useProjectContext();
  const studio = useStudioTools();
  const queryClient = useQueryClient();
  const { data: session } = authClient.useSession();
  const myUserId = session?.user?.id;
  const queryKey = KEYS.taskBoardSubscription(locator, itemId ?? "");

  const query = useQuery({
    queryKey,
    enabled: !!itemId,
    queryFn: () =>
      studio.call("TASK_BOARD_SUBSCRIPTION_GET", {
        taskBoardItemId: itemId!,
      }),
  });

  const toggle = useMutation({
    mutationFn: (subscribed: boolean) =>
      studio.call("TASK_BOARD_SUBSCRIPTION_SET", {
        taskBoardItemId: itemId!,
        subscribed,
      }),
    onMutate: (subscribed) => {
      const previous = queryClient.getQueryData<SubscriptionState>(queryKey);
      if (previous && myUserId) {
        queryClient.setQueryData<SubscriptionState>(queryKey, {
          subscribed,
          subscriberIds: subscribed
            ? [...new Set([...previous.subscriberIds, myUserId])]
            : previous.subscriberIds.filter((id) => id !== myUserId),
        });
      }
      return { previous };
    },
    // The response is the authority: someone else may have joined since the read.
    onSuccess: (next) =>
      queryClient.setQueryData<SubscriptionState>(queryKey, next),
    onError: (_err, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData<SubscriptionState>(queryKey, context.previous);
      }
    },
  });

  return {
    subscriberIds: query.data?.subscriberIds ?? [],
    isSubscribed: query.data?.subscribed ?? false,
    isLoading: query.isLoading,
    isPending: toggle.isPending,
    toggle: () => toggle.mutate(!(query.data?.subscribed ?? false)),
  };
}
