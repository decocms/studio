/**
 * useDecopilotEvents — Subscribe to typed decopilot SSE events
 *
 * Connects to the /api/:org/watch SSE endpoint, parses incoming events
 * into the discriminated DecopilotSSEEvent union, filters by taskId when
 * provided, and dispatches to typed handlers.
 *
 * Uses useSyncExternalStore for proper React 19 subscription lifecycle.
 * EventSource connections are ref-counted so multiple call-sites share one
 * connection per organization.
 */

import {
  DECOPILOT_EVENTS,
  ALL_DECOPILOT_EVENT_TYPES,
  type DecopilotSSEEvent,
  type DecopilotStepEvent,
  type DecopilotFinishEvent,
  type DecopilotThreadStatusEvent,
} from "@decocms/mesh-sdk";
import { useRef, useSyncExternalStore } from "react";
import { createSSESubscription } from "./create-sse-subscription";

// ============================================================================
// Shared connection pool
// ============================================================================

const decopilotSSE = createSSESubscription({
  buildUrl: (orgSlug) => {
    const typesParam = ALL_DECOPILOT_EVENT_TYPES.join(",");
    return `/api/${encodeURIComponent(orgSlug)}/watch?types=${typesParam}`;
  },
  eventTypes: [...ALL_DECOPILOT_EVENT_TYPES],
});

const getSnapshot = () => 0;

// ============================================================================
// Hook
// ============================================================================

export interface UseDecopilotEventsOptions {
  /** Organization slug for the SSE endpoint */
  orgSlug: string;
  /** Only fire handlers for events matching this task (omit for all tasks) */
  taskId?: string;
  /** Disable the SSE connection (default: true) */
  enabled?: boolean;
  /** Called on each "decopilot.step" event (new content available) */
  onStep?: (event: DecopilotStepEvent) => void;
  /** Called on each "decopilot.finish" event (stream ended) */
  onFinish?: (event: DecopilotFinishEvent) => void;
  /** Called on each "decopilot.thread.status" event (task status changed) */
  onTaskStatus?: (event: DecopilotThreadStatusEvent) => void;
}

interface CallbacksRef {
  taskId?: string;
  onStep?: (event: DecopilotStepEvent) => void;
  onFinish?: (event: DecopilotFinishEvent) => void;
  onTaskStatus?: (event: DecopilotThreadStatusEvent) => void;
}

/**
 * Subscribe to decopilot SSE events with full type safety.
 *
 * The underlying EventSource is ref-counted per orgId, so multiple
 * components can subscribe without opening duplicate connections.
 *
 * Callbacks and taskId are read from a ref so the `subscribe` function
 * identity only changes when `enabled` or `orgId` change — keeping the
 * EventSource connection stable across re-renders.
 */
export function useDecopilotEvents(options: UseDecopilotEventsOptions): void {
  const {
    orgSlug,
    taskId,
    enabled = true,
    onStep,
    onFinish,
    onTaskStatus,
  } = options;

  const callbacksRef = useRef<CallbacksRef>({
    taskId,
    onStep,
    onFinish,
    onTaskStatus,
  });
  callbacksRef.current = { taskId, onStep, onFinish, onTaskStatus };

  // `subscribe` only depends on `enabled` and `orgSlug` so the EventSource
  // connection is not torn down when callbacks or taskId change.
  const subscribeRef = useRef<
    ((onStoreChange: () => void) => () => void) | null
  >(null);

  const prevEnabled = useRef(enabled);
  const prevOrgSlug = useRef(orgSlug);

  if (
    !subscribeRef.current ||
    prevEnabled.current !== enabled ||
    prevOrgSlug.current !== orgSlug
  ) {
    prevEnabled.current = enabled;
    prevOrgSlug.current = orgSlug;

    subscribeRef.current = (onStoreChange: () => void) => {
      if (!enabled || !orgSlug) {
        return () => {};
      }

      const handler = (e: MessageEvent) => {
        let event: DecopilotSSEEvent;
        try {
          event = JSON.parse(e.data) as DecopilotSSEEvent;
        } catch {
          return;
        }

        const cb = callbacksRef.current;
        if (cb.taskId && event.subject !== cb.taskId) return;

        switch (event.type) {
          case DECOPILOT_EVENTS.STEP:
            cb.onStep?.(event);
            break;
          case DECOPILOT_EVENTS.FINISH:
            cb.onFinish?.(event);
            break;
          case DECOPILOT_EVENTS.THREAD_STATUS:
            cb.onTaskStatus?.(event);
            break;
        }

        onStoreChange();
      };

      return decopilotSSE.subscribe(orgSlug, handler);
    };
  }

  useSyncExternalStore(subscribeRef.current, getSnapshot, getSnapshot);
}
