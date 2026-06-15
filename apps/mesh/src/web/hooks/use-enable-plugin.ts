/**
 * Hook to enable a plugin for the current project.
 *
 * Encapsulates the PROJECT_UPDATE tool call and cache invalidation
 * so any component can enable a plugin with a single function call.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useProjectContext } from "@decocms/mesh-sdk";
import { useStudioTools } from "@/web/lib/studio-tools";
import { KEYS } from "@/web/lib/query-keys";
import { toast } from "sonner";

export function useEnablePlugin() {
  const { org, project } = useProjectContext();
  const queryClient = useQueryClient();
  const studio = useStudioTools();

  const mutation = useMutation({
    mutationFn: async (pluginId: string) => {
      const currentPlugins = project.enabledPlugins ?? [];

      // Already enabled — no-op
      if (currentPlugins.includes(pluginId)) {
        return;
      }

      const enabledPlugins = [...currentPlugins, pluginId];

      return await studio.call("COLLECTION_VIRTUAL_MCP_UPDATE", {
        id: project.id,
        data: {
          metadata: {
            enabled_plugins: enabledPlugins,
          },
        },
      });
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
