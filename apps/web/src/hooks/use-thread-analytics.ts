/** Admin thread analytics: live feed, usage, errors — and who may read them. */

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { useSyncExternalStore } from "react";
import { KEYS } from "@/lib/query-keys";
import { callStudioTool } from "@/lib/studio-tools";
import type { StudioToolIO } from "@decocms/shared/tools/tool-io";
import { allOrgsThreadStatusWatch } from "./watch-sse-pool";

export type LiveThreadsInput = StudioToolIO["THREAD_ANALYTICS_LIVE"]["input"];
export type LiveThread =
  StudioToolIO["THREAD_ANALYTICS_LIVE"]["output"]["threads"][number];

/** Asked of the org in the PATH: the admin org you stand in. */
function usePathOrg(): string {
  return useParams({ strict: false }).org ?? "";
}

export function useThreadAnalyticsOrgs() {
  const pathOrg = usePathOrg();
  return useQuery({
    queryKey: KEYS.threadAnalyticsOrgs(pathOrg),
    enabled: !!pathOrg,
    queryFn: () => callStudioTool(pathOrg, "THREAD_ANALYTICS_ORG_LIST", {}),
    staleTime: 5 * 60_000,
  });
}

// ponytail: refetch the whole list per status burst; patch rows from the event if "all" gets too busy.
const REFETCH_THROTTLE_MS = 3000;
const ticks = new Map<string, number>();
const subscribers = new Map<string, (onChange: () => void) => () => void>();

function subscribeFor(orgSlug: string) {
  let subscribe = subscribers.get(orgSlug);
  if (!subscribe) {
    subscribe = (onChange) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const bump = () => {
        if (timer) return;
        timer = setTimeout(() => {
          timer = null;
          ticks.set(orgSlug, (ticks.get(orgSlug) ?? 0) + 1);
          onChange();
        }, REFETCH_THROTTLE_MS);
      };
      const unsubscribe = allOrgsThreadStatusWatch.subscribe(
        orgSlug,
        bump,
        bump,
      );
      return () => {
        if (timer) clearTimeout(timer);
        unsubscribe();
      };
    };
    subscribers.set(orgSlug, subscribe);
  }
  return subscribe;
}

const noopSubscribe = () => () => {};

/** Bumps whenever any org's thread changes status (pushed, not polled). */
function useThreadStatusTick(orgSlug: string, enabled: boolean): number {
  return useSyncExternalStore(
    enabled ? subscribeFor(orgSlug) : noopSubscribe,
    () => ticks.get(orgSlug) ?? 0,
  );
}

export function useLiveThreads(input: LiveThreadsInput, enabled: boolean) {
  const pathOrg = usePathOrg();
  const tick = useThreadStatusTick(pathOrg, enabled);
  return useQuery({
    queryKey: KEYS.threadAnalytics(pathOrg, "live", input, tick),
    enabled: enabled && !!pathOrg,
    queryFn: () => callStudioTool(pathOrg, "THREAD_ANALYTICS_LIVE", input),
    placeholderData: keepPreviousData,
  });
}

export function useThreadAnalyticsSections(
  tool: "THREAD_ANALYTICS_USAGE" | "THREAD_ANALYTICS_ERRORS",
  params: { org: string; from: string; to: string },
) {
  const pathOrg = usePathOrg();
  return useQuery({
    queryKey: KEYS.threadAnalytics(pathOrg, tool, params, 0),
    enabled: !!pathOrg,
    queryFn: () => callStudioTool(pathOrg, tool, params),
  });
}
