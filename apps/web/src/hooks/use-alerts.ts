/**
 * The org's alerts and their rules. Kept fresh by the `alerts.updated` SSE
 * event the sweep and every ack emit; the poll is only the fallback. Acking
 * drops the row from the open list at once; the server confirms.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
/** The acked alerts the Alerts tab lists, newest first. */
const HISTORY = 200;

/** Open alerts only, unless `includeAcked`. */
export function useAlerts(
  orgSlug: string,
  { includeAcked = false }: { includeAcked?: boolean } = {},
) {
  const studio = useStudioTools();
  const queryClient = useQueryClient();
  const queryKey = KEYS.alerts(orgSlug, includeAcked);

  const query = useQuery({
    queryKey,
    queryFn: async () =>
      (
        await studio.call(
          "ALERTS_LIST",
          includeAcked ? { includeAcked, limit: HISTORY } : {},
        )
      ).alerts,
    refetchInterval: POLL_MS,
  });

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

  const ack = useMutation({
    mutationFn: (id: string) => studio.call("ALERT_ACK", { id }),
    onMutate: async (id) => {
      const open = KEYS.alerts(orgSlug, false);
      // Cancel a stale in-flight refetch, or it can bring the row back.
      await queryClient.cancelQueries({ queryKey: open });
      queryClient.setQueryData<Alert[]>(open, (alerts) =>
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
