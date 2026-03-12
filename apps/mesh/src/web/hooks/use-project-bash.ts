import {
  useConnections,
  useMCPClient,
  useMCPClientOptional,
  useProjectContext,
  SELF_MCP_ALIAS_ID,
} from "@decocms/mesh-sdk";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { useQuery } from "@tanstack/react-query";
import { useProject } from "@/web/hooks/use-project";
import { KEYS } from "@/web/lib/query-keys";

/** Plugin IDs that use a local-dev bash connection, in priority order */
const BASH_PLUGIN_IDS = ["object-storage", "preview"];

interface PluginConfigOutput {
  config: { connectionId: string | null } | null;
}

/**
 * Find the bash-capable connection configured for the current project.
 *
 * Looks up the project's plugin configs (object-storage, preview) to find
 * the correct connection, avoiding cross-project collisions.
 */
export function useProjectBash(): {
  client: Client | null;
  connectionId: string | undefined;
  connectionUrl: string | undefined;
} {
  const { org, project } = useProjectContext();
  const allConnections = useConnections();

  // Fetch project data to get the ID (likely cached by ProjectLayout)
  const { data: projectData } = useProject(org.id, project.slug);
  const projectId = projectData?.id;

  const selfClient = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
  });

  // Fetch plugin configs to find the project-specific connection
  const { data: projectConnectionId } = useQuery({
    queryKey: KEYS.projectPluginConfigs(projectId ?? ""),
    queryFn: async () => {
      if (!projectId) return null;

      // Check each plugin for a configured connection
      for (const pluginId of BASH_PLUGIN_IDS) {
        try {
          const result = await selfClient.callTool({
            name: "PROJECT_PLUGIN_CONFIG_GET",
            arguments: { projectId, pluginId },
          });
          const data = (result.structuredContent ??
            result) as PluginConfigOutput;
          if (data?.config?.connectionId) {
            return data.config.connectionId;
          }
        } catch {
          // Plugin not configured, try next
        }
      }
      return null;
    },
    enabled: !!projectId,
    staleTime: 30_000,
  });

  // Find the connection matching the project config
  const bashConnection = projectConnectionId
    ? allConnections.find(
        (c) =>
          c.id === projectConnectionId &&
          c.tools?.some((t) => t.name === "bash"),
      )
    : null;

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
