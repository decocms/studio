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
 * Read path: the `ThreadManagerStore.threads` slot is consulted first via
 * `useSyncExternalStore`. If the thread is already in the org-scoped list
 * (initial snapshot already arrived, or a sibling component just created
 * it), the hook returns ready synchronously with no MCP round-trip.
 *
 * Slow path: when the store doesn't yet know about the id, fall through to
 * a single MCP GET. A 404 (resolved to `null`) triggers
 * `manager.create({ id, virtual_mcp_id })`; the manager owns list
 * insertion, so no React Query cache priming is needed here.
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
import { useEffect, useSyncExternalStore } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { KEYS } from "../lib/query-keys";
import type { Task } from "../components/chat/task/types";
import { useThreadManager } from "../components/chat/store/hooks";

type State =
  | { status: "loading" }
  | { status: "creating" }
  | { status: "ready"; task: Task | null }
  | { status: "error"; error: Error };

export function useEnsureTask(id: string, virtualMcpId: string): State {
  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });
  const manager = useThreadManager();
  const threads = useSyncExternalStore(
    manager.threads.subscribe,
    manager.threads.get,
  );
  const localHit = id ? (threads.find((t) => t.id === id) ?? null) : null;

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
    enabled: id.length > 0 && !localHit,
    retry: false,
    refetchOnWindowFocus: false,
  });

  // Private mutation owned by this hook so we can suppress the toast that
  // `useTaskActions().create` would surface. The store handles list
  // insertion internally — no cache invalidation or priming needed.
  const ensureCreate = useMutation<Task, Error, string>({
    mutationFn: async (taskId) =>
      manager.create({ id: taskId, virtual_mcp_id: virtualMcpId }),
  });

  // Fires the create mutation when GET resolves to a missing thread.
  // Dependency array re-fires after `id` changes; the variables/isPending
  // checks dedupe within a single id. React 19 Strict Mode dev double-mount
  // is silent because the server's INSERT … ON CONFLICT DO NOTHING handles
  // the duplicate request and the private mutation has no toast.
  // oxlint-disable-next-line ban-use-effect/ban-use-effect
  useEffect(() => {
    if (!id) return;
    if (localHit) return;
    if (!query.isSuccess || query.data) return;
    if (ensureCreate.isPending) return;
    if (ensureCreate.variables === id) return;
    ensureCreate.mutate(id);
  }, [id, localHit, query.isSuccess, query.data, ensureCreate]);

  if (!id) return { status: "ready", task: null };
  if (localHit) return { status: "ready", task: localHit };
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
