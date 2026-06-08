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
import type { Task } from "../components/chat/task/types";
import { useOptionalThreadManager } from "../components/chat/store/hooks";
import { KEYS } from "../lib/query-keys";

export type { ThreadExpandedTool };

type ThreadGetItem = {
  metadata?: ThreadMetadata;
} | null;

type ThreadGetOutput = { item: ThreadGetItem };

export function useTaskExpandedTools(taskId: string | null) {
  const { org } = useProjectContext();
  const queryClient = useQueryClient();
  const manager = useOptionalThreadManager();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });

  const mutation = useMutation({
    mutationFn: async (tool: Omit<ThreadExpandedTool, "expandedAt">) => {
      if (!taskId) throw new Error("useTaskExpandedTools: no task in context");
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
      // renders before the server round-trip completes. The cache stores
      // the full Task row (shared with useEnsureTask + useTaskMetadata);
      // patch task.metadata.expanded_tools in place so reads via `select`
      // see the new entry.
      const key = KEYS.ensureTask(org.id, taskId ?? "");
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<Task | null>(key);
      const currentTools: ThreadExpandedTool[] =
        previous?.metadata?.expanded_tools ?? [];
      const nextTools = currentTools.filter(
        (t) => t.toolName !== tool.toolName,
      );
      nextTools.push({ ...tool, expandedAt: new Date().toISOString() });
      queryClient.setQueryData<Task | null>(key, (prev) =>
        prev
          ? {
              ...prev,
              metadata: {
                ...(prev.metadata ?? {}),
                expanded_tools: nextTools,
              },
            }
          : prev,
      );
      return { previous };
    },
    onSuccess: () => {
      // Thread update materializes from the next SSE event via ThreadManagerStore
      queryClient.invalidateQueries({
        queryKey: KEYS.ensureTask(org.id, taskId ?? ""),
      });
    },
    onError: (error, _tool, context) => {
      const key = KEYS.ensureTask(org.id, taskId ?? "");
      if (context?.previous === undefined) {
        queryClient.removeQueries({ queryKey: key, exact: true });
      } else {
        queryClient.setQueryData(key, context.previous);
      }
      toast.error(
        error instanceof Error ? error.message : "Failed to expand tool",
      );
    },
  });

  /**
   * Synchronously patches both the React Query cache AND the thread manager
   * store, then fires the server mutation. This is necessary because
   * `useTaskMetadata` prioritizes the thread manager store over the query
   * cache — patching only the query cache leaves the panel with stale
   * metadata (missing args) when the navigate() triggers a re-render.
   */
  const addOrReplaceEager = (tool: Omit<ThreadExpandedTool, "expandedAt">) => {
    // No task/manager in context (e.g. read-only Monitor thread view) — the
    // "open in panel" affordance is hidden there, so there is nothing to do.
    if (!taskId || !manager) return;
    const key = KEYS.ensureTask(org.id, taskId);
    const previous = queryClient.getQueryData<Task | null>(key);
    const currentTools: ThreadExpandedTool[] =
      previous?.metadata?.expanded_tools ?? [];
    const nextTools = currentTools.filter((t) => t.toolName !== tool.toolName);
    nextTools.push({ ...tool, expandedAt: new Date().toISOString() });
    const nextMetadata: ThreadMetadata = {
      ...(previous?.metadata ?? {}),
      expanded_tools: nextTools,
    };
    queryClient.setQueryData<Task | null>(key, (prev) =>
      prev
        ? {
            ...prev,
            metadata: nextMetadata,
          }
        : prev,
    );
    // Also patch the thread manager store so `useTaskMetadata` (which
    // prioritizes localHit from the store) sees the updated expanded_tools.
    manager.patchThread({ id: taskId, metadata: nextMetadata });
    mutation.mutate(tool);
  };

  return {
    addOrReplace: mutation.mutate,
    addOrReplaceEager,
    isPending: mutation.isPending,
  };
}
