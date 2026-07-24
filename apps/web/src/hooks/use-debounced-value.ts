import { useEffect, useState } from "react";

/**
 * Returns a value that lags behind the input by `delayMs`. Each new input
 * resets the timer; the returned value updates only after the input has
 * stopped changing for the debounce window.
 *
 * Use to throttle work that lives outside of rendering (e.g. fetching) — for
 * render-priority deferral, prefer React's built-in `useDeferredValue`.
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);

  // oxlint-disable-next-line ban-use-effect/ban-use-effect
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);

  return debounced;
}
