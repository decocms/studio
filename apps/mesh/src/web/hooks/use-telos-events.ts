// Deliver each telos SSE notification (parsed) to `onEvent` for the org.
// useSyncExternalStore (not useEffect) for the subscription lifecycle; the
// EventSource is pooled.

import { useRef, useSyncExternalStore } from "react";
import { telosSSE } from "./telos-sse-pool";

// The CloudEvent envelope carries the TelosEvent in `data`; `type` is the SSE
// event name (e.g. "telos.goal.thought").
export interface TelosClientEvent {
  type: string;
  // The TelosEvent payload — shape varies by type; consumers narrow on `type`.
  data: Record<string, unknown>;
}

const getSnapshot = () => 0;

function parse(e: MessageEvent): TelosClientEvent | null {
  try {
    const envelope = JSON.parse(e.data) as { data?: Record<string, unknown> };
    return { type: e.type, data: envelope.data ?? {} };
  } catch {
    return null;
  }
}

export function useTelosEvents(
  orgSlug: string,
  onEvent: (evt: TelosClientEvent) => void,
): void {
  const onEventRef = useRef(onEvent);
  // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- callback kept in a ref so `subscribe` identity is stable
  onEventRef.current = onEvent;

  const subscribeRef = useRef<
    ((onStoreChange: () => void) => () => void) | null
  >(null);
  const prevOrgSlug = useRef(orgSlug);

  if (
    // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- init / org change only
    !subscribeRef.current ||
    // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- init / org change only
    prevOrgSlug.current !== orgSlug
  ) {
    // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- init / org change only
    prevOrgSlug.current = orgSlug;
    // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- rebuild subscribe only when org changes
    subscribeRef.current = (onStoreChange: () => void) => {
      if (!orgSlug) return () => {};
      const handler = (e: MessageEvent) => {
        const evt = parse(e);
        if (evt) onEventRef.current(evt);
        onStoreChange();
      };
      return telosSSE.subscribe(orgSlug, handler);
    };
  }

  // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- read stable subscribe
  useSyncExternalStore(subscribeRef.current, getSnapshot, getSnapshot);
}
