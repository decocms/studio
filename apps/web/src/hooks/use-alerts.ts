/**
 * The org's alerts and their rules. Kept fresh by the `alerts.updated` SSE
 * event the sweep and every ack emit; the poll is only the fallback. Acking
 * drops the row from the open list at once; the server confirms.
 */

import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import type { StudioToolIO } from "@decocms/shared/tools/tool-io";
import { KEYS } from "@/lib/query-keys";
import { useStudioTools } from "@/lib/studio-tools";
import { alertsWatchView } from "./watch-sse-pool";

export type Alert = StudioToolIO["ALERTS_LIST"]["output"]["alerts"][number];
export type AlertRule =
  StudioToolIO["ALERT_RULES_LIST"]["output"]["rules"][number];

/** Fallback only: the SSE stream is the real signal, this covers a dead one. */
const POLL_MS = 5 * 60_000;
/** Open alerts are one per store and rule, so a single read holds them. */
const OPEN_LIMIT = 200;
/** Acked alerts pile up; the history loads this many at a time. */
const PAGE = 25;

/** Refresh every alerts read of the org when one opens or is acked. */
function useLiveAlerts(orgSlug: string) {
  const queryClient = useQueryClient();
  useSyncExternalStore(
    (onStoreChange) => {
      if (!orgSlug) return () => {};
      const refresh = () => {
        void queryClient.invalidateQueries({
          queryKey: KEYS.alertsAll(orgSlug),
        });
        onStoreChange();
      };
      // A reconnect may have missed events: resync.
      return alertsWatchView.subscribe(orgSlug, refresh, refresh);
    },
    () => 0,
    () => 0,
  );
}

/** The open alerts, and acking one. */
export function useAlerts(orgSlug: string) {
  const studio = useStudioTools();
  const queryClient = useQueryClient();
  const queryKey = KEYS.alerts(orgSlug, "open");
  const query = useQuery({
    queryKey,
    queryFn: async () =>
      (await studio.call("ALERTS_LIST", { status: "open", limit: OPEN_LIMIT }))
        .alerts,
    refetchInterval: POLL_MS,
  });
  useLiveAlerts(orgSlug);

  const ack = useMutation({
    mutationFn: (id: string) => studio.call("ALERT_ACK", { id }),
    onMutate: async (id) => {
      // Cancel a stale in-flight refetch, or it can bring the row back.
      await queryClient.cancelQueries({ queryKey });
      queryClient.setQueryData<Alert[]>(queryKey, (alerts) =>
        alerts?.filter((a) => a.id !== id),
      );
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: KEYS.alertsAll(orgSlug) }),
  });

  return {
    alerts: query.data ?? [],
    loading: query.isLoading,
    ack: (id: string) => ack.mutate(id),
  };
}

/** The acked alerts, newest first, a page at a time. */
export function useAckedAlerts(orgSlug: string) {
  const studio = useStudioTools();
  const query = useInfiniteQuery({
    queryKey: KEYS.alerts(orgSlug, "acked"),
    queryFn: ({ pageParam }) =>
      studio.call("ALERTS_LIST", {
        status: "acked",
        limit: PAGE,
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  useLiveAlerts(orgSlug);
  return {
    alerts: query.data?.pages.flatMap((p) => p.alerts) ?? [],
    loading: query.isLoading,
    hasMore: query.hasNextPage,
    loadingMore: query.isFetchingNextPage,
    loadMore: () => {
      if (query.hasNextPage && !query.isFetchingNextPage) {
        void query.fetchNextPage();
      }
    },
  };
}

/** The rules' thresholds, the org's own or the defaults. */
export function useAlertRules(orgSlug: string) {
  const studio = useStudioTools();
  const queryClient = useQueryClient();
  const queryKey = KEYS.alertRules(orgSlug);
  const query = useQuery({
    queryKey,
    queryFn: async () => (await studio.call("ALERT_RULES_LIST", {})).rules,
  });
  const update = useMutation({
    mutationFn: (input: StudioToolIO["ALERT_RULE_UPDATE"]["input"]) =>
      studio.call("ALERT_RULE_UPDATE", input),
    onSettled: () => queryClient.invalidateQueries({ queryKey }),
  });
  return {
    rules: query.data ?? [],
    loading: query.isLoading,
    save: update.mutateAsync,
    saving: update.isPending,
  };
}
