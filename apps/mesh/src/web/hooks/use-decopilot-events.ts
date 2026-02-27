/**
 * useDecopilotEvents — Subscribe to typed decopilot SSE events
 *
 * Connects to the /org/:orgId/watch SSE endpoint, parses incoming events
 * into the discriminated DecopilotSSEEvent union, filters by threadId when
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
  buildUrl: (orgId) => {
    const typesParam = ALL_DECOPILOT_EVENT_TYPES.join(",");
    return `/org/${orgId}/watch?types=${typesParam}`;
  },
  eventTypes: [...ALL_DECOPILOT_EVENT_TYPES],
});

const getSnapshot = () => 0;

// ============================================================================
// Hook
// ============================================================================

export interface UseDecopilotEventsOptions {
  /** Organization ID for the SSE endpoint */
  orgId: string;
  /** Only fire handlers for events matching this thread (omit for all threads) */
  threadId?: string;
  /** Disable the SSE connection (default: true) */
  enabled?: boolean;
  /** Called on each "decopilot.step" event (new content available) */
  onStep?: (event: DecopilotStepEvent) => void;
  /** Called on each "decopilot.finish" event (stream ended) */
  onFinish?: (event: DecopilotFinishEvent) => void;
  /** Called on each "decopilot.thread.status" event (thread status changed) */
  onThreadStatus?: (event: DecopilotThreadStatusEvent) => void;
}

interface CallbacksRef {
  threadId?: string;
  onStep?: (event: DecopilotStepEvent) => void;
  onFinish?: (event: DecopilotFinishEvent) => void;
  onThreadStatus?: (event: DecopilotThreadStatusEvent) => void;
}

/**
 * Subscribe to decopilot SSE events with full type safety.
 *
 * The underlying EventSource is ref-counted per orgId, so multiple
 * components can subscribe without opening duplicate connections.
 *
 * Callbacks and threadId are read from a ref so the `subscribe` function
 * identity only changes when `enabled` or `orgId` change — keeping the
 * EventSource connection stable across re-renders.
 */
export function useDecopilotEvents(options: UseDecopilotEventsOptions): void {
  const {
    orgId,
    threadId,
    enabled = true,
    onStep,
    onFinish,
    onThreadStatus,
  } = options;

  const callbacksRef = useRef<CallbacksRef>({
    threadId,
    onStep,
    onFinish,
    onThreadStatus,
  });
  callbacksRef.current = { threadId, onStep, onFinish, onThreadStatus };

  // `subscribe` only depends on `enabled` and `orgId` so the EventSource
  // connection is not torn down when callbacks or threadId change.
  const subscribeRef = useRef<
    ((onStoreChange: () => void) => () => void) | null
  >(null);

  const prevEnabled = useRef(enabled);
  const prevOrgId = useRef(orgId);

  if (
    !subscribeRef.current ||
    prevEnabled.current !== enabled ||
    prevOrgId.current !== orgId
  ) {
    prevEnabled.current = enabled;
    prevOrgId.current = orgId;

    subscribeRef.current = (onStoreChange: () => void) => {
      if (!enabled || !orgId) {
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
        if (cb.threadId && event.subject !== cb.threadId) return;

        switch (event.type) {
          case DECOPILOT_EVENTS.STEP:
            cb.onStep?.(event);
            break;
          case DECOPILOT_EVENTS.FINISH:
            cb.onFinish?.(event);
            break;
          case DECOPILOT_EVENTS.THREAD_STATUS:
            cb.onThreadStatus?.(event);
            break;
        }

        onStoreChange();
      };

      return decopilotSSE.subscribe(orgId, handler);
    };
  }

  useSyncExternalStore(subscribeRef.current, getSnapshot, getSnapshot);
}
