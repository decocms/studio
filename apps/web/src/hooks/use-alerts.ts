/**
 * The org's open alerts, kept fresh by the `alerts.updated` SSE event the
 * sweep and every ack emit. Acking drops the row at once; the server confirms.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import type { StudioToolIO } from "@decocms/shared/tools/tool-io";
import { KEYS } from "@/lib/query-keys";
import { useStudioTools } from "@/lib/studio-tools";
import { alertsWatchView } from "./watch-sse-pool";

export type Alert = StudioToolIO["ALERTS_LIST"]["output"]["alerts"][number];

/** Fallback only: the SSE stream is the real signal, this covers a dead one. */
const POLL_MS = 5 * 60_000;

export function useAlerts(orgSlug: string, enabled: boolean) {
  const studio = useStudioTools();
  const queryClient = useQueryClient();
  const queryKey = KEYS.alerts(orgSlug);

  const query = useQuery({
    queryKey,
    queryFn: async () => (await studio.call("ALERTS_LIST", {})).alerts,
    enabled,
    refetchInterval: POLL_MS,
  });

  useSyncExternalStore(
    (onStoreChange) => {
      if (!enabled || !orgSlug) return () => {};
      const refresh = () => {
        void queryClient.invalidateQueries({ queryKey });
        onStoreChange();
      };
      // A reconnect may have missed events: resync.
      return alertsWatchView.subscribe(orgSlug, refresh, refresh);
    },
    () => 0,
    () => 0,
  );

  const ack = useMutation({
    mutationFn: (id: string) => studio.call("ALERT_ACK", { id }),
    onMutate: async (id) => {
      // Cancel a stale in-flight refetch, or it can bring the row back.
      await queryClient.cancelQueries({ queryKey });
      queryClient.setQueryData<Alert[]>(queryKey, (alerts) =>
        alerts?.filter((a) => a.id !== id),
      );
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey }),
  });

  return {
    alerts: query.data ?? [],
    ack: (id: string) => ack.mutate(id),
  };
}
