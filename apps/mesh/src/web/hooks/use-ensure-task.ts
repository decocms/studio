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
 * truth. The `/watch` snapshot populates it on app boot and `manager.create`
 * writes a new row on thread creation, so the common case is zero MCP
 * round-trips — `localHit` resolves synchronously.
 *
 * Slow path: when the store doesn't know the id AND the watcher has moved
 * past `loading` (either `ready` or `error`), call `manager.create` directly.
 * `error` is treated as a recovery trigger: `COLLECTION_THREADS_CREATE` is
 * idempotent (`INSERT … ON CONFLICT` SELECT-returns the existing row), so
 * firing it during a `/watch` outage is safe and avoids stranding the user
 * in `loading` while the watcher backs off. Replaces the prior GET-then-create
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

  // Fire create once the watcher has moved past `loading` AND localHit is
  // still missing. `ready` means the snapshot arrived without the row (new
  // or archived); `error` is the recovery path so a degraded `/watch`
  // watcher doesn't strand the user in `loading`. CREATE's idempotent
  // behavior makes both safe. React 19 Strict Mode dev double-mount is
  // silent because the server's INSERT … ON CONFLICT handles duplicates.
  // oxlint-disable-next-line ban-use-effect/ban-use-effect
  useEffect(() => {
    if (!id) return;
    if (localHit) return;
    if (threadsStatus.kind === "loading") return;
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
  if (ensureCreate.isPending || threadsStatus.kind !== "loading") {
    return { status: "creating" };
  }
  return { status: "loading" };
}
