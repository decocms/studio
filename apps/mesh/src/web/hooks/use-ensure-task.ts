/**
 * useEnsureTask — read a task; if absent locally, fetch it from the server
 * and, if not found, create it idempotently.
 *
 * Returns a discriminated union so the consumer can render the right UI:
 *   - { status: "loading" }   — waiting on initial snapshot or fetch
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
 * Fetch path: when the store doesn't know the id AND the watcher has moved
 * past `loading`, call `manager.fetchThread(id)` first. This handles
 * direct links to threads beyond page 0 or archived threads without firing
 * a spurious CREATE. `fetchThread` merges the found row into the loaded list
 * so subsequent lookups hit the fast path and `chat-context` also sees the row.
 *
 * Slow path (create): only fires when `fetchThread` returns null (the row
 * genuinely doesn't exist server-side). `COLLECTION_THREADS_CREATE` is
 * idempotent (`INSERT … ON CONFLICT`), so it is also safe as a recovery
 * trigger during a `/watch` outage.
 */

import { useEffect, useState, useSyncExternalStore } from "react";
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

  // fetchedTask tracks the result of manager.fetchThread:
  //   undefined = not yet attempted
  //   null      = server confirmed the row doesn't exist
  //   Task      = row found via GET (already merged into the local list)
  const [fetchedTask, setFetchedTask] = useState<Task | null | undefined>(
    undefined,
  );

  // Reset fetchedTask whenever the target id changes so we don't carry
  // stale state across navigation.
  // oxlint-disable-next-line ban-use-effect/ban-use-effect
  useEffect(() => {
    setFetchedTask(undefined);
  }, [id]);

  // When the local list doesn't contain the thread AND the watcher has
  // finished its initial load, try to fetch the row from the server before
  // falling back to CREATE. This covers direct links to threads beyond
  // page 0 or to archived threads.
  // oxlint-disable-next-line ban-use-effect/ban-use-effect
  useEffect(() => {
    if (!id) return;
    if (localHit) return;
    if (threadsStatus.kind === "loading") return;
    if (fetchedTask !== undefined) return; // already tried or in progress
    // Mark as in-progress immediately (use a sentinel Task to avoid a second
    // undefined→fetching state — null means "tried and not found").
    // We use the setter with a function to avoid a stale-closure race.
    setFetchedTask(null); // optimistically mark as "fetching started"
    manager.fetchThread(id).then((row) => {
      setFetchedTask(row); // null if not found, Task if found
    });
  }, [id, localHit, threadsStatus.kind, fetchedTask, manager]);

  const ensureCreate = useMutation<Task, Error, string>({
    mutationFn: async (taskId) =>
      manager.create({ id: taskId, virtual_mcp_id: virtualMcpId }),
  });

  // Fire create only after fetchThread has confirmed the row doesn't exist
  // (fetchedTask === null) and the watcher has moved past loading. CREATE is
  // idempotent so it is also safe during a /watch outage recovery.
  // React 19 Strict Mode dev double-mount is silent because the server's
  // INSERT … ON CONFLICT handles duplicates.
  // oxlint-disable-next-line ban-use-effect/ban-use-effect
  useEffect(() => {
    if (!id) return;
    if (localHit) return;
    if (fetchedTask === undefined || fetchedTask !== null) return; // not yet fetched or found
    if (threadsStatus.kind === "loading") return;
    if (ensureCreate.isPending) return;
    if (ensureCreate.variables === id) return;
    ensureCreate.mutate(id);
  }, [id, localHit, fetchedTask, threadsStatus.kind, ensureCreate]);

  if (!id) return { status: "ready", task: null };
  if (localHit) return { status: "ready", task: localHit };
  // fetchedTask is a Task when fetchThread returned a row (already in local list
  // via merge, but localHit above may not have updated yet in the same render).
  if (fetchedTask) return { status: "ready", task: fetchedTask };
  if (ensureCreate.data) return { status: "ready", task: ensureCreate.data };
  if (ensureCreate.isError) {
    return { status: "error", error: ensureCreate.error };
  }
  if (ensureCreate.isPending || threadsStatus.kind !== "loading") {
    return { status: "creating" };
  }
  return { status: "loading" };
}
