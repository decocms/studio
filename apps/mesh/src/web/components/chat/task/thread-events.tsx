/**
 * ThreadEventsBridge — single SSE → cache patcher for thread-list queries
 * and ThreadConnection.refresh() trigger.
 *
 * Mount once near the app root (inside ProjectContext + QueryClientProvider).
 * Replaces useTasksAutoRefresh, useStreamManager, and the thread-list
 * invalidation logic that used to live in the legacy task-manager facade.
 *
 * Contract:
 *   • thread-list rows are surgically patched via setQueriesData
 *     (no invalidations — refetch storms eliminated by design).
 *   • The matching ThreadConnection (if any) is asked to refresh() on
 *     onFinish + onTaskStatus(in_progress). The conn re-fetches the
 *     server snapshot itself; no React Query intermediary. refresh()
 *     no-ops while a local submit POST is in flight, so the optimistic
 *     local patch isn't briefly overwritten by stale server state.
 */
import { useProjectContext } from "@decocms/mesh-sdk";
import { useQueryClient } from "@tanstack/react-query";
import { useDecopilotEvents } from "../../../hooks/use-decopilot-events";
import { KEYS } from "../../../lib/query-keys";
import { getActiveConn } from "../hooks/thread-connection";
import type { Task, TasksQueryData } from "./types";

export interface RowPatch {
  id: string;
  status?: Task["status"];
  updated_at?: string;
  title?: string;
  branch?: string | null;
  /** Owner of the thread — needed so ownerUserId filter matches synthetic rows. */
  created_by?: string;
  /** Automation trigger id; `null` = human-initiated; `undefined` = no opinion. */
  trigger_id?: string | null;
  /** Virtual MCP (agent) this task was initiated with — needed so the agent icon renders on SSE-inserted rows. */
  virtual_mcp_id?: string;
}

export function applyPatch(
  data: TasksQueryData | undefined,
  patch: RowPatch,
): TasksQueryData | undefined {
  if (!data) return data;
  const idx = data.items.findIndex((t) => t.id === patch.id);

  if (idx === -1) {
    // Thread not in this cache yet (created in another tab, or never
    // loaded). Insert at the top with a minimal synthetic row; the next
    // refetch fills missing optional fields.
    const synthetic: Task = {
      id: patch.id,
      title: patch.title ?? "New chat",
      created_at: patch.updated_at ?? new Date().toISOString(),
      updated_at: patch.updated_at ?? new Date().toISOString(),
      status: patch.status,
      branch: patch.branch ?? null,
      ...(patch.created_by !== undefined && { created_by: patch.created_by }),
      ...("trigger_id" in patch && { trigger_id: patch.trigger_id ?? null }),
      ...(patch.virtual_mcp_id !== undefined && {
        virtual_mcp_id: patch.virtual_mcp_id,
      }),
    };
    return { ...data, items: [synthetic, ...data.items] };
  }

  const current = data.items[idx];
  if (!current) return data;

  const next: Task = {
    ...current,
    title: patch.title ?? current.title,
    updated_at: patch.updated_at ?? current.updated_at,
    status: patch.status ?? current.status,
    branch: "branch" in patch ? (patch.branch ?? null) : current.branch,
    created_by:
      patch.created_by !== undefined ? patch.created_by : current.created_by,
    trigger_id:
      "trigger_id" in patch ? (patch.trigger_id ?? null) : current.trigger_id,
    virtual_mcp_id:
      patch.virtual_mcp_id !== undefined
        ? patch.virtual_mcp_id
        : current.virtual_mcp_id,
  };
  const items = [...data.items];
  items[idx] = next;
  return { ...data, items };
}

export function ThreadEventsBridge(): null {
  const { org, locator } = useProjectContext();
  const queryClient = useQueryClient();

  const patchAllScopes = (patch: RowPatch) => {
    queryClient.setQueriesData<TasksQueryData>(
      { queryKey: KEYS.threadsPrefix(locator) },
      (data) => applyPatch(data, patch),
    );
  };

  useDecopilotEvents({
    orgSlug: org.slug,
    enabled: true,
    onTaskStatus: (event) => {
      patchAllScopes({
        id: event.subject,
        status: event.data.status,
        updated_at: event.time,
        ...(event.data.created_by !== undefined && {
          created_by: event.data.created_by,
        }),
        ...("trigger_id" in event.data && {
          trigger_id: event.data.trigger_id,
        }),
        ...(event.data.virtual_mcp_id !== undefined && {
          virtual_mcp_id: event.data.virtual_mcp_id,
        }),
      });

      // Refresh the active thread's snapshot when its run starts.
      // getActiveConn returns null for inactive threads — they'll fetch
      // fresh on next mount.
      if (event.data.status === "in_progress") {
        void getActiveConn(org.slug, event.subject)?.refresh();
      }
    },
    onFinish: (event) => {
      void getActiveConn(org.slug, event.subject)?.refresh();
    },
  });

  return null;
}
