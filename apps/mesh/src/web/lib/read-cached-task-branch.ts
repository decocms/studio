import { getManager } from "@/web/components/chat/store/thread-manager-store";

/**
 * Read a task's branch out of the active `ThreadManagerStore` without firing
 * a fetch. Used by "+ New task" entry points outside the chat context
 * (tasks-panel, agent-shell-layout toolbar) to carry the active task's branch
 * into the COLLECTION_THREADS_CREATE call so the new thread lands on the same
 * warm sandbox.
 *
 * Returns null when no manager is open for `(orgSlug, locator)`, when the
 * task isn't in the store, or when the row has no branch.
 */
export function readCachedTaskBranch(
  orgSlug: string,
  locator: string,
  taskId: string,
): string | null {
  if (!taskId) return null;
  const manager = getManager(orgSlug, locator);
  if (!manager) return null;
  const row = manager.threads.get().find((t) => t.id === taskId);
  return row?.branch ?? null;
}
