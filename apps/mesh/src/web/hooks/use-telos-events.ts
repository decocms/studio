// Fire `onChange` on any telos SSE notification for the org. useSyncExternalStore
// (not useEffect) for the subscription lifecycle; the EventSource is pooled.

import { useRef, useSyncExternalStore } from "react";
import { telosSSE } from "./telos-sse-pool";

const getSnapshot = () => 0;

export function useTelosEvents(orgSlug: string, onChange: () => void): void {
  const onChangeRef = useRef(onChange);
  // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- callback kept in a ref so `subscribe` identity is stable
  onChangeRef.current = onChange;

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
      const handler = () => {
        onChangeRef.current();
        onStoreChange();
      };
      return telosSSE.subscribe(orgSlug, handler);
    };
  }

  // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- read stable subscribe
  useSyncExternalStore(subscribeRef.current, getSnapshot, getSnapshot);
}
