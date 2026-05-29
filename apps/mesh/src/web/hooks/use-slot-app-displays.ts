import { useSuspenseQuery } from "@tanstack/react-query";
import {
  useMCPClient,
  useProjectContext,
  WellKnownOrgMCPId,
} from "@decocms/mesh-sdk";
import type { RegistryItem } from "@/web/components/store/types";
import { KEYS } from "@/web/lib/query-keys";
import { type SlotAppDisplay, slotAppDisplay } from "./slot-app-display";
import type { SlotLike } from "./unresolved-slots";

export interface ResolvedSlotAppDisplay extends SlotAppDisplay {
  registryItem: RegistryItem | null;
}

/**
 * Resolves each unresolved slot's `app_id` to its registry display metadata
 * (icon + friendly name) in a single suspending query — one
 * COLLECTION_REGISTRY_APP_GET per app_id via Promise.all. Suspends (like
 * `useUnresolvedSlots`) so the gate appears fully-formed with no icon/name
 * flash. An app the registry doesn't know (synthetic id, or a failed lookup)
 * maps to a `fallback` display. Returns a map keyed by `slot_app_id`.
 */
export function useSlotAppDisplays<T extends SlotLike>(
  slots: T[],
): Record<string, ResolvedSlotAppDisplay> {
  const { org } = useProjectContext();
  const registryClient = useMCPClient({
    connectionId: WellKnownOrgMCPId.REGISTRY(org.id),
    orgId: org.id,
    orgSlug: org.slug,
  });
  const appIds = slots.map((s) => s.slot_app_id);
  const sortedAppIds = [...appIds].sort();

  const query = useSuspenseQuery({
    queryKey: KEYS.slotAppDisplays(org.id, sortedAppIds),
    staleTime: 5 * 60 * 1000,
    queryFn: async (): Promise<Record<string, ResolvedSlotAppDisplay>> => {
      const entries = await Promise.all(
        appIds.map(async (appId) => {
          let item: RegistryItem | null = null;
          try {
            const result = await registryClient.callTool({
              name: "COLLECTION_REGISTRY_APP_GET",
              arguments: { name: appId },
            });
            const structured = (
              result as { structuredContent?: { item?: RegistryItem } }
            ).structuredContent;
            item = structured?.item ?? null;
          } catch (err) {
            // Unknown app / registry error → fallback row (deep-link), never
            // fail the whole gate.
            console.warn(
              "[useSlotAppDisplays] registry lookup failed for",
              appId,
              err,
            );
            item = null;
          }
          return [
            appId,
            { ...slotAppDisplay(appId, item), registryItem: item },
          ] as const;
        }),
      );
      return Object.fromEntries(entries);
    },
  });

  return query.data;
}
