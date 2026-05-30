/**
 * Hook to enable a plugin for the current project.
 *
 * Encapsulates the PROJECT_UPDATE tool call and cache invalidation
 * so any component can enable a plugin with a single function call.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  useProjectContext,
  useMCPClient,
  SELF_MCP_ALIAS_ID,
} from "@decocms/mesh-sdk";
import { KEYS } from "@/web/lib/query-keys";
import { toast } from "sonner";

type ProjectUpdateOutput = {
  project: {
    id: string;
    organizationId: string;
    slug: string;
    name: string;
    description: string | null;
    enabledPlugins: string[] | null;
  } | null;
};

export function useEnablePlugin() {
  const { org, project } = useProjectContext();
  const queryClient = useQueryClient();

  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });

  const mutation = useMutation({
    mutationFn: async (pluginId: string) => {
      const currentPlugins = project.enabledPlugins ?? [];

      // Already enabled — no-op
      if (currentPlugins.includes(pluginId)) {
        return;
      }

      const enabledPlugins = [...currentPlugins, pluginId];

      const result = await client.callTool({
        name: "COLLECTION_VIRTUAL_MCP_UPDATE",
        arguments: {
          id: project.id,
          data: {
            metadata: {
              enabled_plugins: enabledPlugins,
            },
          },
        },
      });

      const payload =
        (result as { structuredContent?: unknown }).structuredContent ?? result;
      return payload as ProjectUpdateOutput;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: KEYS.project(org.id, project.slug),
      });
      queryClient.invalidateQueries({
        queryKey: KEYS.projects(org.id),
      });
    },
    onError: (error) => {
      toast.error(
        "Failed to enable plugin: " +
          (error instanceof Error ? error.message : "Unknown error"),
      );
    },
  });

  return mutation;
}
