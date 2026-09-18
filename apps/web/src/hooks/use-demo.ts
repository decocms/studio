import { useState, useSyncExternalStore } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useProjectContext } from "@/sdk";
import { useStudioTools } from "@/lib/studio-tools";
import { KEYS } from "@/lib/query-keys";
import { demoWatchView } from "./watch-sse-pool";

const snapshot = () => 0;
export function useDemo() {
  const { org, locator } = useProjectContext();
  const studio = useStudioTools();
  const client = useQueryClient();
  const result = useQuery({
    queryKey: KEYS.demo(locator),
    queryFn: () => studio.call("DEMO_STATUS", {}),
    staleTime: 30_000,
  });
  const createSubscription = () => ({
    slug: org.slug,
    locator,
    subscribe: () => {
      const invalidate = () => {
        void client.invalidateQueries({
          predicate: (query) =>
            query.queryKey[0] === locator ||
            (query.queryKey[0] === "threads" && query.queryKey[2] === locator),
        });
      };
      return demoWatchView.subscribe(org.slug, invalidate, invalidate);
    },
  });
  const [subscription, setSubscription] = useState(createSubscription);
  if (subscription.slug !== org.slug || subscription.locator !== locator)
    setSubscription(createSubscription());
  useSyncExternalStore(subscription.subscribe, snapshot, snapshot);
  return result.data?.demo ?? null;
}
