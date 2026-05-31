import { useSuspenseQueries } from "@tanstack/react-query";
import {
  useMCPClient,
  useProjectContext,
  WellKnownOrgMCPId,
} from "@decocms/mesh-sdk";
import type { RegistryItem } from "@/web/components/store/types";
import { KEYS } from "@/web/lib/query-keys";
import { type SlotAppDisplay, slotAppDisplay } from "./slot-app-display";

export interface SlotLike {
  slot_app_id: string;
}

export interface ResolvedSlotAppDisplay extends SlotAppDisplay {
  registryItem: RegistryItem | null;
}

/**
 * Resolves each unresolved slot's `app_id` to its registry display metadata
 * (icon + friendly name). Suspends (like `useUnresolvedSlots`) so the gate
 * appears fully-formed with no icon/name flash. Each app_id is fetched and
 * cached under its OWN key (via `useSuspenseQueries`), so resolving one slot of
 * a multi-slot agent — which shrinks the slot set the gate renders — does NOT
 * re-suspend the gate for the remaining, already-cached slots. An app the
 * registry doesn't know (synthetic id, or a failed lookup) maps to a `fallback`
 * display. Returns a map keyed by `slot_app_id`.
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

  const results = useSuspenseQueries({
    queries: appIds.map((appId) => ({
      queryKey: KEYS.slotAppDisplay(org.id, appId),
      staleTime: 5 * 60 * 1000,
      queryFn: async (): Promise<ResolvedSlotAppDisplay> => {
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
        return { ...slotAppDisplay(appId, item), registryItem: item };
      },
    })),
  });

  return Object.fromEntries(
    appIds.map(
      (appId, i) =>
        [appId, results[i]?.data] as [string, ResolvedSlotAppDisplay],
    ),
  );
}
