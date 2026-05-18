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
import { KEYS } from "../../../lib/query-keys";
import { callUpdateTaskTool } from "./helpers";
import { applyPatch, type RowPatch } from "./thread-events";
import type { ChatMessage, Task, TasksQueryData } from "./types";
import { updateMessagesCache } from "./cache-operations";

// A patcher returns the replacement row, or `null` to remove the row from
// the cached list (used by archive/hide where the row leaves the "open" view).
type RowPatcher = (row: Task) => Task | null;
type Snapshot = [readonly unknown[], TasksQueryData | undefined];

function snapshotAndPatch(
  queryClient: ReturnType<typeof useQueryClient>,
  locator: string,
  threadId: string,
  patch: RowPatcher,
): Snapshot[] {
  // Take an exact snapshot of every matching cache entry BEFORE mutating,
  // so we can roll back per-key on error.
  const snapshots = queryClient.getQueriesData<TasksQueryData>({
    queryKey: KEYS.threadsPrefix(locator),
  });

  queryClient.setQueriesData<TasksQueryData>(
    { queryKey: KEYS.threadsPrefix(locator) },
    (data) => {
      if (!data) return data;
      const idx = data.items.findIndex((t) => t.id === threadId);
      if (idx === -1) return data;
      const current = data.items[idx];
      if (!current) return data;
      const patched = patch(current);
      const items = [...data.items];
      if (patched === null) {
        items.splice(idx, 1);
      } else {
        items[idx] = patched;
      }
      return { ...data, items };
    },
  );

  return snapshots;
}

function rollback(
  queryClient: ReturnType<typeof useQueryClient>,
  snapshots: Snapshot[],
) {
  for (const [key, data] of snapshots) {
    queryClient.setQueryData(key, data);
  }
}

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
        queryClient.setQueriesData<TasksQueryData>(
          { queryKey: KEYS.threadsPrefix(locator) },
          (cached) => {
            if (!cached) return cached;
            if (cached.items.some((t) => t.id === row.id)) return cached;
            return { ...cached, items: [row, ...cached.items] };
          },
        );
      }
      return row;
    },
  };

  const withOptimistic = async (
    id: string,
    patch: RowPatcher,
    fn: () => Promise<Task | null>,
    onErrorMsg: string,
    onSuccessMsg: string,
  ): Promise<void> => {
    const snapshots = snapshotAndPatch(queryClient, locator, id, patch);
    try {
      await fn();
      toast.success(onSuccessMsg);
    } catch (error) {
      rollback(queryClient, snapshots);
      const err = error as Error;
      toast.error(`${onErrorMsg}: ${err.message}`);
      console.error(`[threads] ${onErrorMsg}:`, error);
    }
  };

  return {
    // Low-level surface (preserved from legacy useTaskActions):
    ...collectionActions,
    create: wrappedCreate,

    // High-level helpers with optimistic patches:
    renameThread: (id: string, title: string) =>
      withOptimistic(
        id,
        (row) => ({
          ...row,
          title,
          updated_at: new Date().toISOString(),
        }),
        () => callUpdateTaskTool(client, id, { title }),
        "Failed to rename task",
        "Task renamed",
      ),
    hideThread: (id: string) =>
      withOptimistic(
        id,
        // Open-list caches do not carry hidden=true rows; remove the row
        // entirely rather than flipping a flag that filterThreads ignores.
        () => null,
        () => callUpdateTaskTool(client, id, { hidden: true }),
        "Failed to archive task",
        "Task archived",
      ),
    setStatus: (id: string, status: Task["status"]) =>
      withOptimistic(
        id,
        (row) => ({
          ...row,
          status,
          updated_at: new Date().toISOString(),
        }),
        () =>
          callUpdateTaskTool(client, id, {
            status: status as
              | "requires_action"
              | "failed"
              | "in_progress"
              | "completed",
          }),
        "Failed to update task status",
        "Task status updated",
      ),
    setBranch: (id: string, branch: string | null) =>
      withOptimistic(
        id,
        (row) => ({ ...row, branch }),
        () => callUpdateTaskTool(client, id, { branch }),
        "Failed to update branch",
        "Task branch updated",
      ),
    updateMessages: (id: string, messages: ChatMessage[]): void =>
      updateMessagesCache(queryClient, client, org.id, id, messages),

    // Cache-only patch (no server call). Use when the server has already
    // persisted the change and is informing the client via SSE — mirrors
    // the path ThreadEventsBridge uses for decopilot.thread.status events.
    patchThread: (patch: RowPatch): void => {
      queryClient.setQueriesData<TasksQueryData>(
        { queryKey: KEYS.threadsPrefix(locator) },
        (data) => applyPatch(data, patch),
      );
    },
  };
}
