import { useRef, useState } from "react";

const AUTOSAVE_DELAY = 700;

/**
 * Local draft state that persists via `save` after a debounce. Each edit
 * resets the timer, so the final value wins (stale timers are cleared before
 * they fire). Remount (via a `key` on the editor) re-seeds the draft.
 *
 * On unmount, a pending timer may fire and call `save` one last time. This
 * is intentional: it ensures the user's final edit is persisted even on fast
 * navigation. TanStack's `mutate` is fire-and-forget so the call is safe
 * after the component unmounts.
 */
export function useAutosave<T>(
  initial: T,
  save: (value: T) => void,
  delay = AUTOSAVE_DELAY,
): readonly [T, (next: T) => void, (next: T) => void] {
  const [draft, setDraft] = useState<T>(initial);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const update = (next: T) => {
    setDraft(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => save(next), delay);
  };

  // Update the draft WITHOUT scheduling a save, cancelling any pending one.
  // For callers that already persisted the value through another path (e.g.
  // an awaited `mutateAsync`) and only need the local draft to catch up — a
  // plain `update` here would fire a redundant write, and a stale pending
  // timer could clobber the just-persisted value.
  const sync = (next: T) => {
    setDraft(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };

  return [draft, update, sync] as const;
}
