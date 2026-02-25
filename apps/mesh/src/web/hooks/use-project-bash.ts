import {
  useConnections,
  useMCPClientOptional,
  useProjectContext,
} from "@decocms/mesh-sdk";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

/**
 * Find the first connection in the current project that exposes a `bash` tool.
 * Returns the MCP client for that connection, or null if none available.
 */
export function useProjectBash(): {
  client: Client | null;
  connectionId: string | undefined;
  connectionUrl: string | undefined;
} {
  const { org } = useProjectContext();
  const allConnections = useConnections();

  const bashConnection = allConnections.find((c) =>
    c.tools?.some((t) => t.name === "bash"),
  );

  const client = useMCPClientOptional({
    connectionId: bashConnection?.id,
    orgId: org.id,
  });

  return {
    client,
    connectionId: bashConnection?.id,
    connectionUrl: bashConnection?.connection_url ?? undefined,
  };
}
