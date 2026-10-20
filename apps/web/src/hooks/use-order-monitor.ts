/**
 * Order monitor reads (`/api/:org/order-monitor/...`), kept fresh by the
 * `order-monitor.store.evaluated` SSE event the sweep emits after each tick.
 * The slow refetch is only the fallback for a dropped stream.
 */

import {
  keepPreviousData,
  type QueryClient,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import type {
  OrderMonitorDay,
  OrderMonitorPushes,
  OrderMonitorStore,
} from "@decocms/shared/order-monitor";
import { KEYS } from "@/lib/query-keys";
import { orderMonitorWatchView } from "./watch-sse-pool";

const FALLBACK_REFETCH_MS = 5 * 60_000;

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error =
      body && typeof body === "object" && "error" in body
        ? String(body.error)
        : `request failed (${res.status})`;
    throw new Error(error);
  }
  return body as T;
}

const base = (orgSlug: string) =>
  `/api/${encodeURIComponent(orgSlug)}/order-monitor/stores`;

/** One stable subscribe per org, so the shared stream isn't re-opened per render. */
const subscribers = new Map<string, (onChange: () => void) => () => void>();
const noSubscribe = () => () => {};
const zero = () => 0;

function subscribeFor(orgSlug: string, queryClient: QueryClient) {
  let subscribe = subscribers.get(orgSlug);
  if (!subscribe) {
    subscribe = (onChange) => {
      const refresh = () => {
        queryClient.invalidateQueries({
          queryKey: KEYS.orderMonitor(orgSlug),
        });
        onChange();
      };
      return orderMonitorWatchView.subscribe(orgSlug, refresh, refresh);
    };
    subscribers.set(orgSlug, subscribe);
  }
  return subscribe;
}

/** Refetch every order-monitor query of the org when the sweep reports a change. */
function useOrderMonitorLive(orgSlug: string, enabled: boolean): void {
  const queryClient = useQueryClient();
  useSyncExternalStore(
    enabled && orgSlug ? subscribeFor(orgSlug, queryClient) : noSubscribe,
    zero,
    zero,
  );
}

export function useOrderMonitorStores(orgSlug: string, enabled: boolean) {
  useOrderMonitorLive(orgSlug, enabled);
  return useQuery({
    queryKey: KEYS.orderMonitorStores(orgSlug),
    queryFn: () =>
      fetchJson<{ stores: OrderMonitorStore[] }>(base(orgSlug)).then(
        (body) => body.stores,
      ),
    enabled: enabled && !!orgSlug,
    refetchInterval: FALLBACK_REFETCH_MS,
    retry: false,
  });
}

/** `at` undefined = now. */
export function useOrderMonitorDay(
  orgSlug: string,
  connectionId: string,
  at: string | undefined,
) {
  useOrderMonitorLive(orgSlug, true);
  const query = at ? `?at=${encodeURIComponent(at)}` : "";
  return useQuery({
    queryKey: KEYS.orderMonitorDay(orgSlug, connectionId, at ?? "now"),
    queryFn: () =>
      fetchJson<OrderMonitorDay>(
        `${base(orgSlug)}/${encodeURIComponent(connectionId)}/day${query}`,
      ),
    // A past instant doesn't change; "now" moves with the sweep.
    refetchInterval: at ? false : FALLBACK_REFETCH_MS,
    placeholderData: keepPreviousData,
    retry: false,
  });
}

export function useOrderMonitorPushes(
  orgSlug: string,
  connectionId: string,
  at: string | undefined,
  virtualMcpId: string | undefined,
) {
  const params = new URLSearchParams();
  if (at) params.set("at", at);
  if (virtualMcpId) params.set("virtualMcpId", virtualMcpId);
  const search = params.size > 0 ? `?${params}` : "";
  return useQuery({
    queryKey: KEYS.orderMonitorPushes(
      orgSlug,
      connectionId,
      at ?? "now",
      virtualMcpId ?? "",
    ),
    queryFn: () =>
      fetchJson<OrderMonitorPushes>(
        `${base(orgSlug)}/${encodeURIComponent(connectionId)}/pushes${search}`,
      ),
    refetchInterval: at ? false : FALLBACK_REFETCH_MS,
    retry: false,
  });
}
