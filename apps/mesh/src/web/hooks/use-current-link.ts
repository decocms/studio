import { useQuery } from "@tanstack/react-query";
import type { Capability } from "@/links/protocol";
import {
  SELF_MCP_ALIAS_ID,
  useMCPClient,
  useProjectContext,
} from "@decocms/mesh-sdk";
import { KEYS } from "@/web/lib/query-keys";
import { unwrapToolResult } from "@/web/lib/unwrap-tool-result";

export interface CurrentLink {
  online: boolean;
  machineId?: string;
  hostname?: string;
  cliVersion?: string;
  capabilities: Capability[];
}

const OFFLINE: CurrentLink = { online: false, capabilities: [] };

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
      const result = await client.callTool({
        name: "LINK_CURRENT_GET",
        arguments: {},
      });
      return unwrapToolResult<CurrentLink>(result) ?? OFFLINE;
    },
    staleTime: 10_000,
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
  });

  return data ?? OFFLINE;
}
