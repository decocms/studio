/** Everyone following a task, plus the toggle that follows/unfollows it for
 *  the current user. The list is the source of truth for both — `subscribed`
 *  is derived from whether you are in it. */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useProjectContext } from "@/sdk";
import { KEYS } from "@/lib/query-keys";
import { useStudioTools } from "@/lib/studio-tools";

export function useTaskSubscription(itemId: string | undefined) {
  const { locator } = useProjectContext();
  const studio = useStudioTools();
  const queryClient = useQueryClient();
  const queryKey = KEYS.notificationSubscribers(locator, itemId ?? "");

  const query = useQuery({
    queryKey,
    enabled: !!itemId,
    queryFn: async () =>
      (
        await studio.call("NOTIFICATION_SUBSCRIPTION_LIST", {
          taskBoardItemId: itemId!,
        })
      ).userIds,
  });

  const setSubscribed = useMutation({
    mutationFn: (subscribed: boolean) =>
      studio.call("NOTIFICATION_SUBSCRIPTION_SET", {
        taskBoardItemId: itemId!,
        subscribed,
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
  });

  return { subscriberIds: query.data ?? [], setSubscribed };
}
