/**
 * useThreadActions — write operations for threads.
 *
 * Absorbs the legacy `useTaskActions` from hooks/use-tasks.ts:
 *   - Low-level CRUD (create/update/remove) via useCollectionActions<Task>
 *   - High-level helpers (renameThread/hideThread/setStatus/setBranch/
 *     updateMessages) with optimistic patches + rollback
 *
 * All high-level helpers patch the cache optimistically via setQueriesData,
 * call the server, and (on error) roll back. There are no `invalidateQueries`
 * calls — combined with ThreadEventsBridge this means a write produces
 * exactly one network request (the mutation tool call) and zero refetches.
 */
import {
  SELF_MCP_ALIAS_ID,
  useCollectionActions,
  useMCPClient,
  useProjectContext,
} from "@decocms/mesh-sdk";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { ThreadUpdateData } from "@/tools/thread/schema.ts";
import { KEYS } from "@/web/lib/query-keys";
import { callUpdateTaskTool } from "./helpers";
import {
  patchThreadCaches,
  prependRowToThreadCaches,
  removeRowFromThreadCaches,
  rollbackThreadCaches,
  snapshotThreadCaches,
  type RowPatch,
} from "./thread-events";
import type { ChatMessage, Task } from "./types";
import { updateMessagesCache } from "./cache-operations";

/**
 * Return shape: the spread of `useCollectionActions<Task>(…, "THREADS", …)`
 * (gives callers `.create`, `.update`, `.remove` mutations) PLUS the
 * high-level convenience helpers below. Existing callers of the legacy
 * `useTaskActions` continue to work because the low-level surface is
 * preserved.
 */
export function useThreadActions() {
  const { org, locator } = useProjectContext();
  const queryClient = useQueryClient();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });
  const collectionActions = useCollectionActions<Task>(
    org.id,
    "THREADS",
    client,
  );

  // Replace the legacy `create` wrapper that invalidated `tasksPrefix`
  // with one that prepends the newly-created row to every matching cache
  // entry. The bridge will subsequently overwrite synthetic fields on
  // the first SSE event. Net round-trips: exactly one (the create call).
  // `useCollectionActions.create.mutateAsync` resolves to the entity row
  // itself (see use-collections.ts: `return payload.item`), not `{ item }`.
  const originalCreate = collectionActions.create;
  const wrappedCreate: typeof originalCreate = {
    ...originalCreate,
    mutateAsync: async (data, options) => {
      const row = await originalCreate.mutateAsync(data, options);
      if (row) {
        prependRowToThreadCaches(queryClient, locator, row);
        // Prime the ensure-task cache so useEnsureTask resolves from cache
        // on mount and skips the redundant COLLECTION_THREADS_GET probe.
        queryClient.setQueryData(KEYS.ensureTask(org.id, row.id), row);
      }
      return row;
    },
  };

  const withOptimistic = async (
    applyOptimistic: () => void,
    call: () => Promise<unknown>,
    okMsg: string,
    errMsg: string,
  ): Promise<void> => {
    const snapshots = snapshotThreadCaches(queryClient, locator);
    applyOptimistic();
    try {
      await call();
      toast.success(okMsg);
    } catch (error) {
      rollbackThreadCaches(queryClient, snapshots);
      const err = error as Error;
      toast.error(`${errMsg}: ${err.message}`);
      console.error(`[threads] ${errMsg}:`, error);
    }
  };

  const updateThread = (
    id: string,
    patch: ThreadUpdateData,
    okMsg: string,
    errMsg: string,
  ): Promise<void> =>
    withOptimistic(
      () =>
        patchThreadCaches(queryClient, locator, {
          ...(patch as RowPatch),
          id,
          updated_at: new Date().toISOString(),
        }),
      () => callUpdateTaskTool(client, id, patch),
      okMsg,
      errMsg,
    );

  return {
    // Low-level surface (preserved from legacy useTaskActions):
    ...collectionActions,
    create: wrappedCreate,

    // High-level helpers with optimistic patches:
    renameThread: (id: string, title: string) =>
      updateThread(id, { title }, "Task renamed", "Failed to rename task"),
    hideThread: (id: string) =>
      withOptimistic(
        () => removeRowFromThreadCaches(queryClient, locator, id),
        () => callUpdateTaskTool(client, id, { hidden: true }),
        "Task archived",
        "Failed to archive task",
      ),
    setStatus: (id: string, status: Task["status"]) =>
      updateThread(
        id,
        { status: status as ThreadUpdateData["status"] },
        "Task status updated",
        "Failed to update task status",
      ),
    setBranch: (id: string, branch: string | null) =>
      updateThread(
        id,
        { branch },
        "Task branch updated",
        "Failed to update branch",
      ),
    updateMessages: (id: string, messages: ChatMessage[]): void =>
      updateMessagesCache(queryClient, client, org.id, id, messages),

    // Cache-only patch (no server call). Use when the server has already
    // persisted the change and is informing the client via SSE — mirrors
    // the path ThreadEventsBridge uses for decopilot.thread.status events.
    patchThread: (patch: RowPatch): void => {
      patchThreadCaches(queryClient, locator, patch);
    },
  };
}
