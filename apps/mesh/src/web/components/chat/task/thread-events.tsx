/**
 * ThreadEventsBridge — single SSE → cache patcher for thread-list queries.
 *
 * Mount once near the app root (inside ProjectContext + QueryClientProvider).
 * Replaces useTasksAutoRefresh and the thread-list invalidation logic that
 * used to live in useStreamManager and useTaskManager.
 *
 * Contract: SSE events surgically patch KEYS.threads(...) caches via
 * setQueriesData. No invalidations — refetch storms are eliminated by
 * design.
 */
import { useProjectContext } from "@decocms/mesh-sdk";
import { useQueryClient } from "@tanstack/react-query";
import { useDecopilotEvents } from "../../../hooks/use-decopilot-events";
import { KEYS } from "../../../lib/query-keys";
import type { Task, TasksQueryData } from "./types";

interface RowPatch {
  id: string;
  status?: Task["status"];
  updated_at?: string;
  title?: string;
  branch?: string | null;
}

function applyPatch(
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
      });
    },
  });

  return null;
}
