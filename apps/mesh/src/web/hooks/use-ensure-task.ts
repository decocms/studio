/**
 * useEnsureTask — read a task; if absent locally, create it idempotently.
 *
 * Returns a discriminated union so the consumer can render the right UI:
 *   - { status: "loading" }   — waiting on initial snapshot or create
 *   - { status: "creating" }  — create mutation in flight
 *   - { status: "ready", task: Task | null } — resolved (null when id is empty)
 *   - { status: "error", error: Error } — non-recoverable failure
 *
 * Empty id is a no-op: returns ready with `task: null` so routes that don't
 * carry a taskId (e.g. /$org/) can call the hook unconditionally.
 *
 * Read path: the `ThreadManagerStore.threads` slot is the only source of
 * truth. The `/events` snapshot populates it on app boot and `manager.create`
 * writes a new row on thread creation, so the common case is zero MCP
 * round-trips — `localHit` resolves synchronously.
 *
 * Slow path: when the store doesn't know the id AND its snapshot has arrived
 * (`threadsStatus.kind === "ready"`), call `manager.create` directly. The
 * server's `COLLECTION_THREADS_CREATE` is idempotent (`INSERT … ON CONFLICT`
 * SELECT-returns the existing row), so this single call yields the row
 * regardless of whether it pre-existed. Replaces the prior GET-then-create
 * dance with one network call.
 */

import { useEffect, useSyncExternalStore } from "react";
import { useMutation } from "@tanstack/react-query";
import type { Task } from "../components/chat/task/types";
import { useThreadManager } from "../components/chat/store/hooks";

type State =
  | { status: "loading" }
  | { status: "creating" }
  | { status: "ready"; task: Task | null }
  | { status: "error"; error: Error };

export function useEnsureTask(id: string, virtualMcpId: string): State {
  const manager = useThreadManager();
  const threads = useSyncExternalStore(
    manager.threads.subscribe,
    manager.threads.get,
  );
  const threadsStatus = useSyncExternalStore(
    manager.threadsStatus.subscribe,
    manager.threadsStatus.get,
  );
  const localHit = id ? (threads.find((t) => t.id === id) ?? null) : null;

  const ensureCreate = useMutation<Task, Error, string>({
    mutationFn: async (taskId) =>
      manager.create({ id: taskId, virtual_mcp_id: virtualMcpId }),
  });

  // Fire create only after the org snapshot has arrived AND localHit is still
  // missing — at that point the thread either doesn't exist or is archived,
  // and CREATE's idempotent behavior covers both. The variables/isPending
  // checks dedupe within a single id; React 19 Strict Mode dev double-mount
  // is silent because the server's INSERT … ON CONFLICT handles the duplicate.
  // oxlint-disable-next-line ban-use-effect/ban-use-effect
  useEffect(() => {
    if (!id) return;
    if (localHit) return;
    if (threadsStatus.kind !== "ready") return;
    if (ensureCreate.isPending) return;
    if (ensureCreate.variables === id) return;
    ensureCreate.mutate(id);
  }, [id, localHit, threadsStatus.kind, ensureCreate]);

  if (!id) return { status: "ready", task: null };
  if (localHit) return { status: "ready", task: localHit };
  if (ensureCreate.data) return { status: "ready", task: ensureCreate.data };
  if (ensureCreate.isError) {
    return { status: "error", error: ensureCreate.error };
  }
  if (ensureCreate.isPending || threadsStatus.kind === "ready") {
    return { status: "creating" };
  }
  return { status: "loading" };
}
