/**
 * Order monitor reads (`/api/:org/order-monitor/...`), kept fresh by the
 * `order-monitor.store.evaluated` SSE event the sweep emits after each tick.
 * The slow refetch is only the fallback for a dropped stream.
 */

import {
  type QueryClient,
  useQueries,
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

async function fetchJson<T>(url: string, signal: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal });
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
const subscribers = new Map<string, () => () => void>();
/** One stream listener per org however many hooks mount, so an event invalidates once. */
const listeners = new Map<string, { count: number; unsubscribe: () => void }>();
const noSubscribe = () => () => {};
const zero = () => 0;

function subscribeFor(orgSlug: string, queryClient: QueryClient) {
  let subscribe = subscribers.get(orgSlug);
  if (!subscribe) {
    subscribe = () => {
      let listener = listeners.get(orgSlug);
      if (!listener) {
        const refresh = () =>
          queryClient.invalidateQueries({
            queryKey: KEYS.orderMonitor(orgSlug),
          });
        listener = {
          count: 0,
          unsubscribe: orderMonitorWatchView.subscribe(
            orgSlug,
            refresh,
            refresh,
          ),
        };
        listeners.set(orgSlug, listener);
      }
      const current = listener;
      current.count++;
      return () => {
        if (--current.count > 0) return;
        current.unsubscribe();
        listeners.delete(orgSlug);
      };
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
    queryFn: ({ signal }) =>
      fetchJson<{ stores: OrderMonitorStore[] }>(base(orgSlug), signal).then(
        (body) => body.stores,
      ),
    enabled: enabled && !!orgSlug,
    refetchInterval: FALLBACK_REFETCH_MS,
    retry: false,
  });
}

/** One store's day; `at` undefined = now. Shared so a page can read many at once. */
export function orderMonitorDayQuery(
  orgSlug: string,
  connectionId: string,
  at: string | undefined,
) {
  const query = at ? `?at=${encodeURIComponent(at)}` : "";
  return {
    queryKey: KEYS.orderMonitorDay(orgSlug, connectionId, at ?? "now"),
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      fetchJson<OrderMonitorDay>(
        `${base(orgSlug)}/${encodeURIComponent(connectionId)}/day${query}`,
        signal,
      ),
    // A past instant doesn't change; "now" moves with the sweep.
    refetchInterval: at ? (false as const) : FALLBACK_REFETCH_MS,
    retry: false,
  };
}

/** `at` undefined = now. */
export function useOrderMonitorDay(
  orgSlug: string,
  connectionId: string,
  at: string | undefined,
) {
  useOrderMonitorLive(orgSlug, true);
  return useQuery({
    ...orderMonitorDayQuery(orgSlug, connectionId, at),
    // Another day of the same store, not another store's chart.
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[3] === connectionId ? previous : undefined,
  });
}

/** One day of every store at once, for totals across them; `at` undefined = now. */
export function useOrderMonitorDays(
  orgSlug: string,
  connectionIds: string[],
  at?: string,
) {
  useOrderMonitorLive(orgSlug, connectionIds.length > 0);
  return useQueries({
    queries: connectionIds.map((id) => orderMonitorDayQuery(orgSlug, id, at)),
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
    queryFn: ({ signal }) =>
      fetchJson<OrderMonitorPushes>(
        `${base(orgSlug)}/${encodeURIComponent(connectionId)}/pushes${search}`,
        signal,
      ),
    refetchInterval: at ? false : FALLBACK_REFETCH_MS,
    retry: false,
  });
}
