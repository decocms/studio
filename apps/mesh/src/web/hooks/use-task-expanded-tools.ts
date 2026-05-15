/**
 * useTaskExpandedTools — per-task right-panel tab persistence.
 *
 * Backed by `threads.metadata.expanded_tools`. Adds/replaces an entry so
 * the most recent expansion for a given tool name wins.
 */

import {
  SELF_MCP_ALIAS_ID,
  useMCPClient,
  useProjectContext,
} from "@decocms/mesh-sdk";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { ThreadExpandedTool, ThreadMetadata } from "../../storage/types";
import { KEYS } from "../lib/query-keys";

export type { ThreadExpandedTool };

type ThreadGetItem = {
  metadata?: ThreadMetadata;
} | null;

type ThreadGetOutput = { item: ThreadGetItem };

export function useTaskExpandedTools(taskId: string) {
  const { org, locator } = useProjectContext();
  const queryClient = useQueryClient();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });

  const mutation = useMutation({
    mutationFn: async (tool: Omit<ThreadExpandedTool, "expandedAt">) => {
      const getResult = (await client.callTool({
        name: "COLLECTION_THREADS_GET",
        arguments: { id: taskId },
      })) as { structuredContent?: unknown };
      const getPayload = (getResult.structuredContent ??
        getResult) as ThreadGetOutput;
      const currentMetadata: ThreadMetadata = getPayload.item?.metadata ?? {};
      const currentTools: ThreadExpandedTool[] =
        currentMetadata.expanded_tools ?? [];

      const next = currentTools.filter((t) => t.toolName !== tool.toolName);
      next.push({ ...tool, expandedAt: new Date().toISOString() });

      const nextMetadata: ThreadMetadata = {
        ...currentMetadata,
        expanded_tools: next,
      };

      await client.callTool({
        name: "COLLECTION_THREADS_UPDATE",
        arguments: {
          id: taskId,
          data: { metadata: nextMetadata },
        },
      });

      return next;
    },
    onMutate: async (tool) => {
      // Optimistic: put the new tool into the cache so the header tab
      // renders before the server round-trip completes.
      const key = KEYS.threadMetadata(taskId);
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<ThreadMetadata | null>(key);
      const currentTools: ThreadExpandedTool[] = previous?.expanded_tools ?? [];
      const nextTools = currentTools.filter(
        (t) => t.toolName !== tool.toolName,
      );
      nextTools.push({ ...tool, expandedAt: new Date().toISOString() });
      queryClient.setQueryData<ThreadMetadata | null>(key, {
        ...(previous ?? {}),
        expanded_tools: nextTools,
      });
      return { previous };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: KEYS.tasksPrefix(locator) });
      queryClient.invalidateQueries({
        queryKey: KEYS.threadMetadata(taskId),
      });
    },
    onError: (error, _tool, context) => {
      if (context?.previous === undefined) {
        queryClient.removeQueries({
          queryKey: KEYS.threadMetadata(taskId),
          exact: true,
        });
      } else {
        queryClient.setQueryData(KEYS.threadMetadata(taskId), context.previous);
      }
      toast.error(
        error instanceof Error ? error.message : "Failed to expand tool",
      );
    },
  });

  return {
    addOrReplace: mutation.mutate,
    isPending: mutation.isPending,
  };
}
