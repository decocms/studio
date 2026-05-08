import { useEffect, useRef } from "react";

interface UseDebouncedAutosaveOptions<R> {
  /** Save function. The latest closure is always invoked, so it can read
   * current state without callers needing their own ref. */
  save: () => Promise<R>;
  /** Debounce window. Defaults to 1000ms. */
  delayMs?: number;
}

interface UseDebouncedAutosaveReturn<R> {
  /** Schedule a save after the debounce window. Resets the window on each
   * call. */
  schedule: () => void;
  /** Cancel any pending save and run the save now. Returns whatever `save`
   * returns. */
  flush: () => Promise<R>;
}

/**
 * Debounced save with flush-on-unmount.
 *
 * Encapsulates the timer, the always-fresh-closure dance, and the unmount
 * cleanup that drops trailing edits if the user navigates within the debounce
 * window.
 */
export function useDebouncedAutosave<R>({
  save,
  delayMs = 1000,
}: UseDebouncedAutosaveOptions<R>): UseDebouncedAutosaveReturn<R> {
  // Always-fresh ref so the deferred timer invokes the latest closure rather
  // than whichever one was in scope when the timer was scheduled.
  const saveRef = useRef(save);
  saveRef.current = save;

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const schedule = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      saveRef.current();
    }, delayMs);
  };

  const flush = (): Promise<R> => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    return saveRef.current();
  };

  // Flush any pending save on unmount so navigating away within the debounce
  // window doesn't drop the last edit.
  // oxlint-disable-next-line ban-use-effect/ban-use-effect
  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
        saveRef.current();
      }
    };
  }, []);

  return { schedule, flush };
}
