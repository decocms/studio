import { useQuery } from "@tanstack/react-query";
import type { Capability } from "@/links/protocol";
import {
  SELF_MCP_ALIAS_ID,
  useMCPClient,
  useProjectContext,
} from "@decocms/mesh-sdk";
import { KEYS } from "@/web/lib/query-keys";

export interface CurrentLink {
  online: boolean;
  machineId?: string;
  hostname?: string;
  cliVersion?: string;
  capabilities: Capability[];
  /**
   * False until LINK_CURRENT_GET has resolved at least once this mount.
   * Lets "the desktop is offline" surfaces (banner, teaser rows) hold back
   * instead of flashing offline-state UI during the initial fetch.
   */
  ready: boolean;
}

const OFFLINE: CurrentLink = { online: false, capabilities: [], ready: false };

export function useCurrentLink(): CurrentLink {
  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });

  const { data } = useQuery<CurrentLink>({
    queryKey: KEYS.currentLink(org.id),
    queryFn: async () => {
      const result = (await client.callTool({
        name: "LINK_CURRENT_GET",
        arguments: {},
      })) as { structuredContent?: Omit<CurrentLink, "ready"> };
      const link = result.structuredContent;
      return link ? { ...link, ready: true } : { ...OFFLINE, ready: true };
    },
    staleTime: 4_000,
    refetchInterval: 5_000,
    refetchOnWindowFocus: true,
  });

  return data ?? OFFLINE;
}
