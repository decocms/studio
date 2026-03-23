import { toast } from "sonner";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  SELF_MCP_ALIAS_ID,
  useMCPClient,
  useProjectContext,
} from "@decocms/mesh-sdk";
import { KEYS } from "@/web/lib/query-keys";

type VirtualMCPCreateOutput = {
  item: {
    id: string;
    title: string;
  };
};

export function useCreateProject() {
  const { org } = useProjectContext();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
  });

  const mutation = useMutation({
    mutationFn: async () => {
      const result = (await client.callTool({
        name: "COLLECTION_VIRTUAL_MCP_CREATE",
        arguments: {
          data: {
            title: "My Project",
            description: null,
            subtype: "project",
            metadata: {
              instructions: null,
              enabled_plugins: [],
              ui: {
                banner: null,
                bannerColor: null,
                icon: null,
                themeColor: null,
              },
            },
            connections: [],
          },
        },
      })) as { structuredContent?: unknown };
      const payload = (result.structuredContent ??
        result) as VirtualMCPCreateOutput;
      return payload.item;
    },
    onSuccess: (item) => {
      queryClient.invalidateQueries({ queryKey: KEYS.projects(org.id) });
      navigate({
        to: "/$org/projects/$virtualMcpId/settings",
        params: { org: org.slug, virtualMcpId: item.id },
      });
    },
    onError: (error) => {
      toast.error(
        "Failed to create project: " +
          (error instanceof Error ? error.message : "Unknown error"),
      );
    },
  });

  return {
    createProject: () => mutation.mutate(),
    isCreating: mutation.isPending,
  };
}
