/**
 * Hook to fetch an MCP app's metadata from the deco registry by app ID.
 * Used at CTA time (e.g., recruit modal) to get full connection details.
 * Display metadata (title, icon) comes from WELL_KNOWN_AGENT_TEMPLATES constants.
 */

import {
  useMCPClient,
  useMCPToolCallQuery,
  useProjectContext,
  WellKnownOrgMCPId,
} from "@decocms/mesh-sdk";
import type { RegistryItem } from "@/web/components/store/types";

/**
 * Fetch an MCP app from the deco registry by its app name.
 * Results are cached via React Query with a 5-minute stale time.
 *
 * @param appId - The app name to look up (e.g., "deco/site-diagnostics")
 * @param options.enabled - Whether to fetch (default: true). Pass `false` to defer.
 */
export function useRegistryApp(appId: string, options?: { enabled?: boolean }) {
  const { org } = useProjectContext();
  const registryId = WellKnownOrgMCPId.REGISTRY(org.id);
  const client = useMCPClient({
    connectionId: registryId,
    orgId: org.id,
    orgSlug: org.slug,
  });

  return useMCPToolCallQuery<RegistryItem | null>({
    client,
    toolName: "COLLECTION_REGISTRY_APP_GET",
    toolArguments: { name: appId },
    enabled: options?.enabled ?? true,
    staleTime: 5 * 60 * 1000,
    select: (result) => {
      const structured = (
        result as { structuredContent?: { item?: RegistryItem } }
      ).structuredContent;
      return structured?.item ?? null;
    },
  });
}
