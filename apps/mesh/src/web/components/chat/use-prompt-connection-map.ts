import {
  createMCPClient,
  listPrompts,
  useConnections,
  useVirtualMCP,
} from "@decocms/mesh-sdk";
import type { ConnectionEntity } from "@decocms/mesh-sdk";
import { useQuery } from "@tanstack/react-query";
import { KEYS } from "@/web/lib/query-keys";

/**
 * Builds a prompt-name → ConnectionEntity map by fetching prompts per-connection.
 * Non-blocking: returns an empty map while loading so callers degrade gracefully.
 */
export function usePromptConnectionMap(
  virtualMcpId: string | null,
  orgId: string,
  orgSlug: string,
): Map<string, ConnectionEntity> {
  const virtualMcp = useVirtualMCP(virtualMcpId);
  const allConnections = useConnections();

  const connectionMap = new Map(allConnections.map((c) => [c.id, c]));
  const connectionIds = (virtualMcp?.connections ?? []).map(
    (c) => c.connection_id,
  );

  const { data } = useQuery({
    queryKey: KEYS.promptConnectionMap(orgId, connectionIds),
    queryFn: async () => {
      const map: Record<string, string> = {};
      await Promise.all(
        connectionIds.map(async (connId) => {
          try {
            const client = await createMCPClient({
              connectionId: connId,
              orgId,
              orgSlug,
            });
            const result = await listPrompts(client);
            for (const p of result.prompts) {
              if (!(p.name in map)) {
                map[p.name] = connId;
              }
            }
          } catch {
            // Connection might be down — skip it
          }
        }),
      );
      return map;
    },
    staleTime: 60_000,
    enabled: connectionIds.length > 0,
  });

  const result = new Map<string, ConnectionEntity>();
  for (const [promptName, connId] of Object.entries(data ?? {})) {
    const conn = connectionMap.get(connId);
    if (conn) result.set(promptName, conn);
  }
  return result;
}
