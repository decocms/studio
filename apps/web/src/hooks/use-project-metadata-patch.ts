import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { StudioToolInput } from "@decocms/shared/tools/tool-io";
import { invalidateVirtualMcpQueries } from "@/lib/query-keys";
import { useStudioTools } from "@/lib/studio-tools";
import { useProjectContext } from "@/sdk";

type MetadataPatch = NonNullable<
  StudioToolInput<"COLLECTION_VIRTUAL_MCP_UPDATE">["data"]["metadata"]
>;

/** Set some of a project's metadata fields; the server merges the rest. */
export function useProjectMetadataPatch(projectId: string | undefined) {
  const { org } = useProjectContext();
  const studio = useStudioTools();
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: (fields: MetadataPatch) =>
      studio.call("COLLECTION_VIRTUAL_MCP_UPDATE", {
        id: projectId ?? "",
        data: { metadata: fields },
      }),
    onSettled: () => invalidateVirtualMcpQueries(queryClient, org.id),
  });
  return { isPending: mutation.isPending, patch: mutation.mutateAsync };
}
