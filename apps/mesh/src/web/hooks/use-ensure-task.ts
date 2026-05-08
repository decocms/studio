/**
 * useEnsureTask — read a task; on 404, create it with the given id and vMCP.
 *
 * Returns a discriminated union so the consumer can render the right UI:
 *   - { status: "loading" }   — initial GET in flight
 *   - { status: "creating" }  — create mutation in flight (after a 404)
 *   - { status: "ready", task: Task | null } — resolved (null when id is empty)
 *   - { status: "error", error: Error } — non-404 failure
 *
 * Empty id is a no-op: GET and CREATE are skipped and the hook returns a
 * ready state with `task: null`. Lets routes that don't have a taskId in
 * URL params (e.g. /$org/) call the hook unconditionally so Rules of Hooks
 * stays happy across the home/task branch.
 *
 * Race safety: the create mutation is server-side idempotent (`INSERT … ON
 * CONFLICT DO NOTHING RETURNING *`). Two tabs hitting the same URL both end
 * up with the same row.
 */

import {
  SELF_MCP_ALIAS_ID,
  useMCPClient,
  useProjectContext,
} from "@decocms/mesh-sdk";
import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KEYS } from "../lib/query-keys";
import type { Task } from "./use-tasks";

type State =
  | { status: "loading" }
  | { status: "creating" }
  | { status: "ready"; task: Task | null }
  | { status: "error"; error: Error };

export function useEnsureTask(id: string, virtualMcpId: string): State {
  const { org, locator } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });
  const queryClient = useQueryClient();

  const query = useQuery<Task | null>({
    queryKey: KEYS.ensureTask(org.id, id),
    queryFn: async () => {
      const result = await client.callTool({
        name: "COLLECTION_THREADS_GET",
        arguments: { id },
      });
      const payload = (result as { structuredContent?: unknown })
        .structuredContent as { item?: Task } | undefined;
      return payload?.item ?? null;
    },
    enabled: id.length > 0,
    retry: false,
    refetchOnWindowFocus: false,
  });

  // Private mutation owned by this hook so we can suppress the toast and
  // shared-cache invalidation that `useTaskActions().create` does. Effects
  // re-run on (id, query.isSuccess, query.data) changes; React 19 Strict
  // Mode dev may double-fire on first mount, but the server's `INSERT … ON
  // CONFLICT DO NOTHING` makes this silent (no duplicate row, no toast).
  const ensureCreate = useMutation<Task, Error, string>({
    mutationFn: async (taskId) => {
      const result = await client.callTool({
        name: "COLLECTION_THREADS_CREATE",
        arguments: {
          data: { id: taskId, virtual_mcp_id: virtualMcpId },
        },
      });
      if ((result as { isError?: boolean }).isError) {
        const content = (result as { content?: unknown }).content;
        const msg =
          Array.isArray(content) && content[0] && typeof content[0] === "object"
            ? ((content[0] as { text?: string }).text ?? "Create failed")
            : "Create failed";
        throw new Error(msg);
      }
      const payload = (result as { structuredContent?: unknown })
        .structuredContent as { item: Task };
      return payload.item;
    },
    onSuccess: () => {
      // Refresh the canonical THREADS collection cache and the legacy
      // KEYS.tasksPrefix list (read by chat-context's tasks.find), then
      // refetch the ensure query so the consumer transitions from
      // "creating" to "ready" without an extra round-trip.
      queryClient.invalidateQueries({
        predicate: (q) =>
          q.queryKey[1] === org.id &&
          q.queryKey[3] === "collection" &&
          q.queryKey[4] === "THREADS",
      });
      queryClient.invalidateQueries({
        queryKey: KEYS.tasksPrefix(locator),
      });
      void query.refetch();
    },
  });

  // Fires the create mutation when GET resolves to a missing thread.
  // Dependency array re-fires after `id` changes; the variables/isPending
  // checks dedupe within a single id. React 19 Strict Mode dev double-mount
  // is silent because the server's INSERT … ON CONFLICT DO NOTHING handles
  // the duplicate request and the private mutation has no toast.
  // oxlint-disable-next-line ban-use-effect/ban-use-effect
  useEffect(() => {
    if (!id) return;
    if (!query.isSuccess || query.data) return;
    if (ensureCreate.isPending) return;
    if (ensureCreate.variables === id) return;
    ensureCreate.mutate(id);
  }, [id, query.isSuccess, query.data, ensureCreate]);

  if (!id) return { status: "ready", task: null };
  if (query.isLoading) return { status: "loading" };
  if (query.isError) return { status: "error", error: query.error as Error };
  if (query.isSuccess && query.data) {
    return { status: "ready", task: query.data };
  }
  if (ensureCreate.isPending || (query.isSuccess && !query.data)) {
    return { status: "creating" };
  }
  if (ensureCreate.isError) {
    return { status: "error", error: ensureCreate.error };
  }
  return { status: "loading" };
}
