import { useRef, useState } from "react";

const AUTOSAVE_DELAY = 700;

/**
 * Local draft state that persists via `save` after a debounce. Each edit
 * resets the timer, so the final value wins (stale timers are cleared before
 * they fire). Remount (via a `key` on the editor) re-seeds the draft.
 *
 * External re-seeding: when `initial` changes by reference (e.g. a batch
 * mutation patched this block's payload in the shared cache while it's open),
 * the draft re-seeds from it — but only when there's no pending local edit, so
 * we never clobber what the user is currently typing. This is the "adjust
 * state during render" pattern, same as the collection-switch reset upstream.
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
): readonly [T, (next: T) => void] {
  const [draft, setDraft] = useState<T>(initial);
  const [seeded, setSeeded] = useState<T>(initial);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Re-seed from an external change to `initial` when no local edit is pending.
  if (initial !== seeded) {
    setSeeded(initial);
    if (timer.current === null) setDraft(initial);
  }

  const update = (next: T) => {
    setDraft(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      save(next);
    }, delay);
  };

  return [draft, update] as const;
}
