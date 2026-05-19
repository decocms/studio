/**
 * useWorkflowSSE — Subscribe to workflow SSE events and invalidate queries
 *
 * Connects to the /api/:org/watch?types=workflow.* SSE endpoint and
 * invalidates the relevant React Query caches when workflow events arrive.
 * This replaces polling for real-time workflow execution updates.
 *
 * Invalidation is debounced: rapid-fire events (e.g. parallel step executions)
 * are coalesced into a single invalidation pass every 500ms.
 *
 * Uses useSyncExternalStore for proper React 19 subscription lifecycle.
 * The EventSource is ref-counted so multiple components share one connection.
 */

import { useSyncExternalStore } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useProjectContext } from "@decocms/mesh-sdk";
import { createSSESubscription } from "../../../../hooks/create-sse-subscription";

// ============================================================================
// Shared connection pool
// ============================================================================

const WORKFLOW_EVENT_TYPES = [
  "workflow.execution.created",
  "workflow.execution.resumed",
  "workflow.step.execute",
  "workflow.step.completed",
];

const workflowSSE = createSSESubscription({
  buildUrl: (orgSlug) =>
    `/api/${encodeURIComponent(orgSlug)}/watch?types=workflow.*`,
  eventTypes: WORKFLOW_EVENT_TYPES,
});

/** Tool names whose query caches should be invalidated on workflow events */
const INVALIDATION_TARGETS = [
  "COLLECTION_WORKFLOW_EXECUTION_LIST",
  "COLLECTION_WORKFLOW_EXECUTION_GET",
  "COLLECTION_WORKFLOW_EXECUTION_GET_STEP_RESULT",
];

/** Debounce window — coalesce rapid SSE events into one invalidation */
const DEBOUNCE_MS = 500;

const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
const queryClients = new Map<string, Set<QueryClient>>();

function invalidateAllClients(orgId: string): void {
  const clients = queryClients.get(orgId);
  if (!clients) return;
  for (const client of clients) {
    client.invalidateQueries({
      predicate: (query) =>
        query.queryKey.some(
          (k) => typeof k === "string" && INVALIDATION_TARGETS.includes(k),
        ),
    });
  }
}

function scheduleInvalidation(orgId: string): void {
  if (debounceTimers.has(orgId)) return;

  debounceTimers.set(
    orgId,
    setTimeout(() => {
      debounceTimers.delete(orgId);
      invalidateAllClients(orgId);
    }, DEBOUNCE_MS),
  );
}

const getSnapshot = () => 0;

// ============================================================================
// React Hook
// ============================================================================

/**
 * Subscribe to workflow SSE events for the current organization.
 *
 * When any workflow.* event arrives, the relevant React Query caches
 * are invalidated so components automatically refetch fresh data.
 * Rapid events are debounced (500ms) to avoid excessive refetches.
 *
 * Call this once near the top of the workflow UI tree.
 */
export function useWorkflowSSE(): void {
  const { org } = useProjectContext();
  const queryClient = useQueryClient();
  const orgId = org.id;
  const orgSlug = org.slug;

  const subscribe = (onStoreChange: () => void) => {
    let clients = queryClients.get(orgId);
    if (!clients) {
      clients = new Set();
      queryClients.set(orgId, clients);
    }
    clients.add(queryClient);

    const handler = () => {
      scheduleInvalidation(orgId);
      onStoreChange();
    };

    const unsubscribe = workflowSSE.subscribe(orgSlug, handler);

    return () => {
      unsubscribe();
      clients!.delete(queryClient);
      if (clients!.size === 0) {
        queryClients.delete(orgId);
      }
      const timer = debounceTimers.get(orgId);
      if (timer && !queryClients.has(orgId)) {
        clearTimeout(timer);
        debounceTimers.delete(orgId);
      }
    };
  };

  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
