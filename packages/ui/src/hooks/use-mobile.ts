import { useSyncExternalStore } from "react";

const MOBILE_BREAKPOINT = 768;
const MOBILE_QUERY = `(max-width: ${MOBILE_BREAKPOINT - 1}px)`;

/**
 * The viewport is external mutable state, so it belongs in
 * `useSyncExternalStore` rather than an effect that copies it into React
 * state. The effect version had to `setIsMobile` on mount to close the gap
 * between the initial render and the subscription (`react/set-state-in-effect`);
 * subscribing directly removes the gap instead of patching it, and drops a
 * banned `useEffect` on the way.
 */
function subscribe(onStoreChange: () => void): () => void {
  const mql = globalThis.matchMedia(MOBILE_QUERY);
  mql.addEventListener("change", onStoreChange);
  return () => mql.removeEventListener("change", onStoreChange);
}

/** A boolean, so the snapshot is referentially stable between changes. */
const getSnapshot = () => globalThis.innerWidth < MOBILE_BREAKPOINT;

/** No viewport off the browser; desktop is the safe default for layout. */
const getServerSnapshot = () => false;

export function useIsMobile(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
