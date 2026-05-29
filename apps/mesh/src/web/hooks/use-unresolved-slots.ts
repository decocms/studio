import { useQuery } from "@tanstack/react-query";
import { SELF_MCP_ALIAS_ID, useMCPClient } from "@decocms/mesh-sdk";
import { KEYS } from "@/web/lib/query-keys";
import type { ResolvedConnectionForUser } from "./use-resolve-connection-for-user";
import { type SlotLike, unresolvedSlots } from "./unresolved-slots";

/**
 * Resolves every one of an agent's typed slots to the caller's own connection
 * in a single query (one CONNECTION_RESOLVE_FOR_USER call per app_id via
 * Promise.all), and returns the slots that don't resolve.
 *
 * Batched into one query on purpose: calling `useResolveConnectionForUser` once
 * per slot in a loop would change the hook count between renders and break the
 * rules of hooks.
 */
export function useUnresolvedSlots<T extends SlotLike>(
  orgId: string,
  orgSlug: string,
  slots: T[],
): { unresolved: T[]; isLoading: boolean } {
  const selfClient = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId,
    orgSlug,
  });
  const appIds = slots.map((s) => s.slot_app_id);
  const sortedAppIds = [...appIds].sort();

  const query = useQuery({
    queryKey: KEYS.unresolvedSlots(orgId, sortedAppIds),
    enabled: appIds.length > 0,
    // Clear the gate promptly once the user connects: connecting goes through
    // a deep-link / OAuth popup, so re-resolve on every window focus (not just
    // when stale) when the user returns.
    staleTime: 0,
    refetchOnWindowFocus: "always",
    queryFn: async (): Promise<Record<string, string | null>> => {
      const entries = await Promise.all(
        appIds.map(async (appId) => {
          const result = await selfClient.callTool({
            name: "CONNECTION_RESOLVE_FOR_USER",
            arguments: { app_id: appId },
          });
          const structured = (result as { structuredContent?: unknown })
            .structuredContent;
          const text = (result as { content?: Array<{ text?: string }> })
            .content?.[0]?.text;
          const payload = (structured ??
            (text
              ? JSON.parse(text)
              : null)) as ResolvedConnectionForUser | null;
          return [appId, payload?.connectionId ?? null] as const;
        }),
      );
      return Object.fromEntries(entries);
    },
  });

  // Fail open: if resolution errors (query.data undefined), report no
  // unresolved slots so a transient resolve blip doesn't block chat. The
  // run would then surface the server-side SlotUnresolvedError, which is the
  // pre-existing fallback rather than a regression.
  return {
    unresolved: query.data ? unresolvedSlots(slots, query.data) : [],
    isLoading: appIds.length > 0 && query.isLoading,
  };
}
