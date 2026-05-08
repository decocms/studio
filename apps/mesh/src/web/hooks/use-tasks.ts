/**
 * Task (thread) hooks — mirror the useConnection/useConnections/useConnectionActions
 * pattern. Backed by COLLECTION_THREADS_* tools.
 */

import {
  SELF_MCP_ALIAS_ID,
  useCollectionActions,
  useMCPClient,
  useProjectContext,
} from "@decocms/mesh-sdk";
import { useQueryClient } from "@tanstack/react-query";
import { KEYS } from "@/web/lib/query-keys";
import type { ThreadEntity } from "@/tools/thread/schema";

export type Task = ThreadEntity;

/**
 * Mutation hooks. `create.mutateAsync({ id?, virtual_mcp_id, branch?, title?, description? })`.
 * `update.mutateAsync({ id, data })`.
 *
 * The `create.onSuccess` from useCollectionActions only invalidates the
 * canonical collection cache. Tasks have a parallel legacy task list at
 * KEYS.tasksPrefix(locator) that chat-context reads from for the branch
 * picker; we wrap the create mutation here so every caller refreshes both
 * caches consistently.
 */
export function useTaskActions() {
  const { org, locator } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });
  const queryClient = useQueryClient();
  const actions = useCollectionActions<Task>(org.id, "THREADS", client);

  const originalCreate = actions.create;
  const wrappedMutateAsync: typeof originalCreate.mutateAsync = async (
    data,
    options,
  ) => {
    const result = await originalCreate.mutateAsync(data, options);
    queryClient.invalidateQueries({ queryKey: KEYS.tasksPrefix(locator) });
    return result;
  };

  return {
    ...actions,
    create: {
      ...originalCreate,
      mutateAsync: wrappedMutateAsync,
    },
  };
}

export { useEnsureTask } from "./use-ensure-task";
