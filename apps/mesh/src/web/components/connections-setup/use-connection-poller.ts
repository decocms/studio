import { useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  createMCPClient,
  SELF_MCP_ALIAS_ID,
  useProjectContext,
  type ConnectionEntity,
} from "@decocms/mesh-sdk";
import { KEYS } from "@/web/lib/query-keys";

const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 15000;

export interface ConnectionPollerResult {
  connection: ConnectionEntity | null;
  isActive: boolean;
  isTimedOut: boolean;
  isPolling: boolean;
}

export function useConnectionPoller(
  connectionId: string | null,
): ConnectionPollerResult {
  const { org } = useProjectContext();
  const startTimeRef = useRef<number>(0);

  if (connectionId && startTimeRef.current === 0) {
    startTimeRef.current = Date.now();
  }
  if (!connectionId) {
    startTimeRef.current = 0;
  }

  const { data: connection } = useQuery({
    queryKey: KEYS.connectionPoll(connectionId ?? ""),
    queryFn: async (): Promise<ConnectionEntity | null> => {
      if (!connectionId) return null;
      const client = await createMCPClient({
        connectionId: SELF_MCP_ALIAS_ID,
        orgId: org.id,
      });
      try {
        const result = (await client.callTool({
          name: "COLLECTION_CONNECTIONS_GET",
          arguments: { id: connectionId },
        })) as { structuredContent?: { item: ConnectionEntity | null } };
        return result.structuredContent?.item ?? null;
      } finally {
        await client.close().catch(console.error);
      }
    },
    refetchInterval: (query) => {
      const conn = query.state.data;
      if (!connectionId) return false;
      if (conn?.status === "active" || conn?.status === "error") return false;
      if (Date.now() - startTimeRef.current > POLL_TIMEOUT_MS) return false;
      return POLL_INTERVAL_MS;
    },
    enabled: Boolean(connectionId && org),
    staleTime: 0,
  });

  const isTimedOut =
    Boolean(connectionId) &&
    startTimeRef.current > 0 &&
    Date.now() - startTimeRef.current > POLL_TIMEOUT_MS &&
    connection?.status !== "active";

  return {
    connection: connection ?? null,
    isActive: connection?.status === "active",
    isTimedOut,
    isPolling:
      Boolean(connectionId) &&
      connection?.status !== "active" &&
      connection?.status !== "error" &&
      !isTimedOut,
  };
}
